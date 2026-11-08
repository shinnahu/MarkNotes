package com.marknotes.core.store;

import com.marknotes.core.Log;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CharsetEncoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.FileTime;
import java.util.Arrays;

/**
 * Reads and writes text files the way Notepad users expect: the encoding and the line endings a file came with
 * are kept when it is saved again (port of the PC's TextFiles.cs).
 * Encodings: "utf8", "utf8bom", "utf16le", "utf16be", "ansi" (Windows-1252, what the PC's ANSI code page is for
 * English and Spanish Windows). Line endings: "crlf", "lf", "cr". Text in memory always uses "\n".
 */
public final class TextFiles {
    private TextFiles() {}

    public static final class TextContent {
        public final String text;
        public final String encoding;
        public final String eol;

        public TextContent(String text, String encoding, String eol) {
            this.text = text;
            this.encoding = encoding;
            this.eol = eol;
        }
    }

    // ------------------------------------------------------------------ Windows-1252

    /** 0x80–0x9F. The five bytes 1252 leaves undefined map to the matching C1 controls, like Windows does. */
    private static final char[] CP1252_HIGH = {
            '€', '\u0081', '‚', 'ƒ', '„', '…', '†', '‡',
            'ˆ', '‰', 'Š', '‹', 'Œ', '\u008D', 'Ž', '\u008F',
            '\u0090', '‘', '’', '“', '”', '•', '–', '—',
            '˜', '™', 'š', '›', 'œ', '\u009D', 'ž', 'Ÿ',
    };

    static String decodeAnsi(byte[] b, int off, int len) {
        char[] out = new char[len];
        for (int i = 0; i < len; i++) {
            int c = b[off + i] & 0xFF;
            out[i] = c >= 0x80 && c < 0xA0 ? CP1252_HIGH[c - 0x80] : (char) c;
        }
        return new String(out);
    }

    /** Null when some character has no Windows-1252 byte. */
    static byte[] encodeAnsi(String s) {
        byte[] out = new byte[s.length()];
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c < 0x80 || (c >= 0xA0 && c <= 0xFF)) {
                out[i] = (byte) c;
                continue;
            }
            int found = -1;
            for (int k = 0; k < CP1252_HIGH.length; k++) {
                if (CP1252_HIGH[k] == c) {
                    found = k;
                    break;
                }
            }
            if (found < 0) return null;
            out[i] = (byte) (0x80 + found);
        }
        return out;
    }

    // ------------------------------------------------------------------ UTF-8 / UTF-16

    private static final byte[] FFFD_UTF8 = {(byte) 0xEF, (byte) 0xBF, (byte) 0xBD};

    /** UTF-8 bytes; a lone surrogate becomes U+FFFD (like .NET), not '?'. */
    static byte[] utf8(String s) {
        boolean ascii = true;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c >= 0x80) {
                ascii = false;
                if (Character.isSurrogate(c)) {
                    CharsetEncoder enc = StandardCharsets.UTF_8.newEncoder()
                            .onMalformedInput(CodingErrorAction.REPLACE)
                            .onUnmappableCharacter(CodingErrorAction.REPLACE)
                            .replaceWith(FFFD_UTF8);
                    try {
                        ByteBuffer bb = enc.encode(CharBuffer.wrap(s));
                        return Arrays.copyOfRange(bb.array(), bb.arrayOffset() + bb.position(), bb.arrayOffset() + bb.limit());
                    } catch (CharacterCodingException e) {
                        break;
                    }
                }
            }
        }
        if (ascii) return s.getBytes(StandardCharsets.US_ASCII);
        return s.getBytes(StandardCharsets.UTF_8);
    }

    private static String strictUtf8(byte[] b) throws CharacterCodingException {
        return StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(b)).toString();
    }

    // ------------------------------------------------------------------ reading

    public static TextContent read(String path) throws IOException {
        return decode(Files.readAllBytes(Paths.get(path)));
    }

    public static TextContent decode(byte[] bytes) {
        String text;
        String enc;
        int n = bytes.length;
        if (n >= 3 && (bytes[0] & 0xFF) == 0xEF && (bytes[1] & 0xFF) == 0xBB && (bytes[2] & 0xFF) == 0xBF) {
            text = new String(bytes, 3, n - 3, StandardCharsets.UTF_8);
            enc = "utf8bom";
        } else if (n >= 2 && (bytes[0] & 0xFF) == 0xFF && (bytes[1] & 0xFF) == 0xFE) {
            text = new String(bytes, 2, n - 2, StandardCharsets.UTF_16LE);
            enc = "utf16le";
        } else if (n >= 2 && (bytes[0] & 0xFF) == 0xFE && (bytes[1] & 0xFF) == 0xFF) {
            text = new String(bytes, 2, n - 2, StandardCharsets.UTF_16BE);
            enc = "utf16be";
        } else {
            try {
                text = strictUtf8(bytes);
                enc = "utf8";
            } catch (CharacterCodingException e) {
                text = decodeAnsi(bytes, 0, n);
                enc = "ansi";
            }
        }

        int crlf = 0, lf = 0, cr = 0;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c == '\r') {
                if (i + 1 < text.length() && text.charAt(i + 1) == '\n') {
                    crlf++;
                    i++;
                } else cr++;
            } else if (c == '\n') lf++;
        }
        String eol = crlf == 0 && lf == 0 && cr == 0 ? "crlf" : crlf >= lf && crlf >= cr ? "crlf" : lf >= cr ? "lf" : "cr";
        if (crlf + cr > 0) text = text.replace("\r\n", "\n").replace('\r', '\n');
        return new TextContent(text, enc, eol);
    }

    /** File.ReadAllText: UTF-8 unless a byte order mark says UTF-16; bad bytes become U+FFFD. */
    public static String readAllText(byte[] b) {
        int n = b.length;
        if (n >= 3 && (b[0] & 0xFF) == 0xEF && (b[1] & 0xFF) == 0xBB && (b[2] & 0xFF) == 0xBF)
            return new String(b, 3, n - 3, StandardCharsets.UTF_8);
        if (n >= 2 && (b[0] & 0xFF) == 0xFF && (b[1] & 0xFF) == 0xFE) return new String(b, 2, n - 2, StandardCharsets.UTF_16LE);
        if (n >= 2 && (b[0] & 0xFF) == 0xFE && (b[1] & 0xFF) == 0xFF) return new String(b, 2, n - 2, StandardCharsets.UTF_16BE);
        return new String(b, StandardCharsets.UTF_8);
    }

    public static String readAllText(String path) throws IOException {
        return readAllText(Files.readAllBytes(Paths.get(path)));
    }

    // ------------------------------------------------------------------ writing

    public static byte[] encode(String text, String encoding, String eol) {
        String nl = "lf".equals(eol) ? "\n" : "cr".equals(eol) ? "\r" : "\r\n";
        if (!nl.equals("\n")) text = text.replace("\n", nl);
        if (encoding == null) encoding = "utf8";
        switch (encoding) {
            case "utf8bom":
                return concat(UTF8_BOM, utf8(text));
            case "utf16le":
                return concat(new byte[] {(byte) 0xFF, (byte) 0xFE}, text.getBytes(StandardCharsets.UTF_16LE));
            case "utf16be":
                return concat(new byte[] {(byte) 0xFE, (byte) 0xFF}, text.getBytes(StandardCharsets.UTF_16BE));
            case "ansi": {
                // Only keep ANSI if nothing would be lost; otherwise upgrade to UTF-8.
                byte[] ansi = encodeAnsi(text);
                return ansi != null ? ansi : utf8(text);
            }
            default:
                return utf8(text);
        }
    }

    private static final byte[] UTF8_BOM = {(byte) 0xEF, (byte) 0xBB, (byte) 0xBF};

    private static byte[] concat(byte[] a, byte[] b) {
        byte[] r = new byte[a.length + b.length];
        System.arraycopy(a, 0, r, 0, a.length);
        System.arraycopy(b, 0, r, a.length, b.length);
        return r;
    }

    /**
     * Writes through a temp file renamed over the note so a crash can never leave a half written note
     * (File.Replace on the PC), keeping the original file's creation date where the system has one.
     */
    public static void write(String path, String text, String encoding, String eol) throws IOException {
        writeBytes(path, encode(text, encoding, eol));
    }

    public static void writeBytes(String path, byte[] bytes) throws IOException {
        File f = new File(path);
        File dir = f.getAbsoluteFile().getParentFile();
        if (dir != null) PathUtil.mkdirs(dir.getPath());
        Path target = f.toPath();
        if (!f.isFile()) {
            Files.write(target, bytes);
            return;
        }
        Path tmp = new File(dir, "." + f.getName() + "." + Compat.hex6() + ".tmp").toPath();
        try {
            FileTime created = null;
            try {
                created = Files.readAttributes(target, BasicFileAttributes.class).creationTime();
            } catch (Exception ignored) {
            }
            Files.write(tmp, bytes);
            try {
                Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException e) {
                Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);
            }
            if (created != null && PathUtil.WINDOWS) {
                try {
                    Files.setAttribute(target, "basic:creationTime", created);
                } catch (Exception ignored) {
                }
            }
        } catch (IOException ex) {
            Log.error("TextFiles.Replace fallback " + path, ex);
            try {
                Files.deleteIfExists(tmp);
            } catch (Exception ignored) {
            }
            try (FileOutputStream fs = new FileOutputStream(f)) {
                fs.write(bytes);
            }
        }
    }

    /** First characters of a file, for previews in lists and cards. */
    public static String preview(String path, int maxChars) {
        try (FileInputStream fs = new FileInputStream(path)) {
            long flen = fs.getChannel().size();
            int len = (int) Math.min(flen, maxChars * 4L + 4);
            byte[] buf = new byte[len];
            int read = 0;
            while (read < len) {
                int n = fs.read(buf, read, len - read);
                if (n <= 0) break;
                read += n;
            }
            if (read < buf.length) buf = Arrays.copyOf(buf, read);
            // Avoid cutting a UTF-8 sequence in half.
            int cut = buf.length;
            if (flen > buf.length) {
                while (cut > 0 && (buf[cut - 1] & 0xC0) == 0x80) cut--;
                if (cut > 0 && (buf[cut - 1] & 0xFF) >= 0xC0) cut--;
                if (cut < buf.length) buf = Arrays.copyOf(buf, cut);
            }
            String text;
            try {
                text = decode(buf).text;
            } catch (RuntimeException e) {
                text = new String(buf, StandardCharsets.UTF_8);
            }
            return text.length() > maxChars ? text.substring(0, maxChars) : text;
        } catch (Exception e) {
            return "";
        }
    }
}

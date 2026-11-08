package com.marknotes.core.store;

/** Uri.EscapeDataString / Uri.UnescapeDataString as on the PC. */
public final class UriCodec {
    private UriCodec() {}

    private static final char[] HEX = "0123456789ABCDEF".toCharArray();

    private static boolean unreserved(int c) {
        return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '.' || c == '_' || c == '~';
    }

    /** RFC 3986 unreserved characters kept, everything else as UTF-8 %XX (a space is %20). */
    public static String escapeDataString(String s) {
        boolean plain = true;
        for (int i = 0; i < s.length(); i++) {
            if (!unreserved(s.charAt(i))) {
                plain = false;
                break;
            }
        }
        if (plain) return s;
        byte[] b = TextFiles.utf8(s);
        StringBuilder sb = new StringBuilder(b.length + 16);
        for (byte x : b) {
            int c = x & 0xFF;
            if (unreserved(c)) sb.append((char) c);
            else sb.append('%').append(HEX[c >> 4]).append(HEX[c & 15]);
        }
        return sb.toString();
    }

    private static int hex(char c) {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
    }

    /** The byte of a "%XX" at i, or -1. */
    private static int escapedByte(String s, int i) {
        if (i + 2 >= s.length() || s.charAt(i) != '%') return -1;
        int h = hex(s.charAt(i + 1)), l = hex(s.charAt(i + 2));
        return h < 0 || l < 0 ? -1 : (h << 4) | l;
    }

    /** %XX sequences that form valid UTF-8 are decoded; anything else is left as it is (never throws). */
    public static String unescapeDataString(String s) {
        if (s.indexOf('%') < 0) return s;
        StringBuilder sb = new StringBuilder(s.length());
        int i = 0, n = s.length();
        while (i < n) {
            int b0 = escapedByte(s, i);
            if (b0 < 0) {
                sb.append(s.charAt(i++));
                continue;
            }
            if (b0 < 0x80) {
                sb.append((char) b0);
                i += 3;
                continue;
            }
            int need, min;
            int cp;
            if (b0 >= 0xC2 && b0 <= 0xDF) {
                need = 1;
                cp = b0 & 0x1F;
                min = 0x80;
            } else if (b0 >= 0xE0 && b0 <= 0xEF) {
                need = 2;
                cp = b0 & 0x0F;
                min = 0x800;
            } else if (b0 >= 0xF0 && b0 <= 0xF4) {
                need = 3;
                cp = b0 & 0x07;
                min = 0x10000;
            } else {
                sb.append(s, i, i + 3);
                i += 3;
                continue;
            }
            boolean ok = true;
            for (int k = 1; k <= need; k++) {
                int b = escapedByte(s, i + 3 * k);
                if (b < 0 || (b & 0xC0) != 0x80) {
                    ok = false;
                    break;
                }
                cp = (cp << 6) | (b & 0x3F);
            }
            if (ok && (cp < min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF))) ok = false;
            if (!ok) {
                sb.append(s, i, i + 3);
                i += 3;
                continue;
            }
            sb.appendCodePoint(cp);
            i += 3 * (need + 1);
        }
        return sb.toString();
    }
}

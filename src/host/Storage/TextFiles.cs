using System.Globalization;
using System.Text;

namespace MarkNotes.Storage;

/// <summary>
/// Reads and writes text files the way Notepad users expect: the encoding and the
/// line endings a file came with are kept when it is saved again.
/// </summary>
public static class TextFiles
{
    static TextFiles()
    {
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
    }

    public sealed record TextContent(string Text, string Encoding, string Eol);

    private static Encoding Ansi
    {
        get
        {
            try { return Encoding.GetEncoding(CultureInfo.CurrentCulture.TextInfo.ANSICodePage); }
            catch { return Encoding.GetEncoding(1252); }
        }
    }

    public static TextContent Read(string path)
    {
        var bytes = File.ReadAllBytes(path);
        return Decode(bytes);
    }

    public static TextContent Decode(byte[] bytes)
    {
        string text;
        string enc;
        if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF)
        {
            text = new UTF8Encoding(false).GetString(bytes, 3, bytes.Length - 3);
            enc = "utf8bom";
        }
        else if (bytes.Length >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE)
        {
            text = Encoding.Unicode.GetString(bytes, 2, bytes.Length - 2);
            enc = "utf16le";
        }
        else if (bytes.Length >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF)
        {
            text = Encoding.BigEndianUnicode.GetString(bytes, 2, bytes.Length - 2);
            enc = "utf16be";
        }
        else
        {
            try
            {
                text = new UTF8Encoding(false, true).GetString(bytes);
                enc = "utf8";
            }
            catch (DecoderFallbackException)
            {
                text = Ansi.GetString(bytes);
                enc = "ansi";
            }
        }

        int crlf = 0, lf = 0, cr = 0;
        for (int i = 0; i < text.Length; i++)
        {
            var c = text[i];
            if (c == '\r')
            {
                if (i + 1 < text.Length && text[i + 1] == '\n') { crlf++; i++; }
                else cr++;
            }
            else if (c == '\n') lf++;
        }
        string eol = crlf == 0 && lf == 0 && cr == 0 ? "crlf" : crlf >= lf && crlf >= cr ? "crlf" : lf >= cr ? "lf" : "cr";
        if (crlf + cr > 0) text = text.Replace("\r\n", "\n").Replace('\r', '\n');
        return new TextContent(text, enc, eol);
    }

    public static byte[] Encode(string text, string encoding, string eol)
    {
        var nl = eol switch { "lf" => "\n", "cr" => "\r", _ => "\r\n" };
        if (nl != "\n") text = text.Replace("\n", nl);
        switch (encoding)
        {
            case "utf8bom":
                return Concat(new byte[] { 0xEF, 0xBB, 0xBF }, new UTF8Encoding(false).GetBytes(text));
            case "utf16le":
                return Concat(new byte[] { 0xFF, 0xFE }, Encoding.Unicode.GetBytes(text));
            case "utf16be":
                return Concat(new byte[] { 0xFE, 0xFF }, Encoding.BigEndianUnicode.GetBytes(text));
            case "ansi":
                {
                    // Only keep ANSI if nothing would be lost; otherwise upgrade to UTF-8.
                    var ansi = (Encoding)Ansi.Clone();
                    ansi.EncoderFallback = EncoderFallback.ExceptionFallback;
                    try { return ansi.GetBytes(text); }
                    catch (EncoderFallbackException) { return new UTF8Encoding(false).GetBytes(text); }
                }
            default:
                return new UTF8Encoding(false).GetBytes(text);
        }
    }

    private static byte[] Concat(byte[] a, byte[] b)
    {
        var r = new byte[a.Length + b.Length];
        Buffer.BlockCopy(a, 0, r, 0, a.Length);
        Buffer.BlockCopy(b, 0, r, a.Length, b.Length);
        return r;
    }

    /// <summary>
    /// Writes through a temp file and File.Replace so a crash can never leave a half
    /// written note, while keeping the original file's creation date.
    /// </summary>
    public static void Write(string path, string text, string encoding, string eol)
    {
        var bytes = Encode(text, encoding, eol);
        WriteBytes(path, bytes);
    }

    public static void WriteBytes(string path, byte[] bytes)
    {
        var dir = Path.GetDirectoryName(path)!;
        Directory.CreateDirectory(dir);
        if (!File.Exists(path))
        {
            File.WriteAllBytes(path, bytes);
            return;
        }
        var tmp = Path.Combine(dir, "." + Path.GetFileName(path) + "." + Guid.NewGuid().ToString("N")[..6] + ".tmp");
        try
        {
            File.WriteAllBytes(tmp, bytes);
            File.Replace(tmp, path, null, true);
        }
        catch (Exception ex)
        {
            Log.Error("TextFiles.Replace fallback " + path, ex);
            try { if (File.Exists(tmp)) File.Delete(tmp); } catch { }
            using var fs = new FileStream(path, FileMode.Truncate, FileAccess.Write, FileShare.Read);
            fs.Write(bytes, 0, bytes.Length);
        }
    }

    /// <summary>First characters of a file, for previews in lists and cards.</summary>
    public static string Preview(string path, int maxChars)
    {
        try
        {
            using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            var len = (int)Math.Min(fs.Length, maxChars * 4L + 4);
            var buf = new byte[len];
            int read = 0;
            while (read < len)
            {
                var n = fs.Read(buf, read, len - read);
                if (n <= 0) break;
                read += n;
            }
            if (read < buf.Length) Array.Resize(ref buf, read);
            // Avoid cutting a UTF-8 sequence in half.
            int cut = buf.Length;
            if (fs.Length > buf.Length)
            {
                while (cut > 0 && (buf[cut - 1] & 0xC0) == 0x80) cut--;
                if (cut > 0 && buf[cut - 1] >= 0xC0) cut--;
                if (cut < buf.Length) Array.Resize(ref buf, cut);
            }
            string text;
            try { text = Decode(buf).Text; }
            catch { text = Encoding.UTF8.GetString(buf); }
            return text.Length > maxChars ? text[..maxChars] : text;
        }
        catch
        {
            return "";
        }
    }
}

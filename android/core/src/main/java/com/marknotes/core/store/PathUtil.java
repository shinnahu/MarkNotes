package com.marknotes.core.store;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * Path helpers with the PC's (Windows) semantics on every device: comparisons ignore case, '/' and '\' are both
 * separators in paths that come from the interface, and "." / ".." are resolved on the string (no file system
 * access, so names Windows would reject still work). Absolute paths use the device's own separator.
 */
public final class PathUtil {
    private PathUtil() {}

    public static final char SEP = File.separatorChar;
    static final boolean WINDOWS = SEP == '\\';

    static boolean isSep(char c) {
        return c == SEP || (WINDOWS && c == '/');
    }

    private static boolean isAsciiLetter(char c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
    }

    /** A path from the interface or a link ('/' or '\' separators) with this device's separator. */
    public static String toNative(String p) {
        return WINDOWS ? p.replace('/', '\\') : p.replace('\\', '/');
    }

    /** Path.IsPathRooted for a path with native separators. */
    public static boolean isRooted(String p) {
        if (p == null || p.isEmpty()) return false;
        char c = p.charAt(0);
        if (isSep(c)) return true;
        return WINDOWS && p.length() >= 2 && p.charAt(1) == ':' && isAsciiLetter(c);
    }

    /** Length of the root part: "/", "C:\", "\\server\share\" (0 for a relative path). */
    static int rootLength(String p) {
        int n = p.length();
        if (!WINDOWS) return n > 0 && p.charAt(0) == '/' ? 1 : 0;
        if (n >= 2 && p.charAt(1) == ':' && isAsciiLetter(p.charAt(0))) return n >= 3 && isSep(p.charAt(2)) ? 3 : 2;
        if (n >= 2 && isSep(p.charAt(0)) && isSep(p.charAt(1))) {
            int seps = 0;
            for (int i = 2; i < n; i++) {
                if (isSep(p.charAt(i)) && ++seps == 2) return i + 1;
            }
            return n;
        }
        return n > 0 && isSep(p.charAt(0)) ? 1 : 0;
    }

    /** Path.GetFullPath: absolute, "." and ".." resolved, no trailing separator (except for a root). */
    public static String full(String p) {
        return normalize(new File(p).getAbsolutePath());
    }

    static String normalize(String abs) {
        int rl = rootLength(abs);
        String root = abs.substring(0, rl);
        if (WINDOWS) root = root.replace('/', '\\');
        List<String> segs = segments(abs, rl);
        boolean clean = true;
        for (String s : segs) {
            if (s.equals(".") || s.equals("..")) {
                clean = false;
                break;
            }
        }
        if (!clean) {
            List<String> out = new ArrayList<>(segs.size());
            for (String s : segs) {
                if (s.equals(".")) continue;
                if (s.equals("..")) {
                    if (!out.isEmpty()) out.remove(out.size() - 1);
                    continue;
                }
                out.add(s);
            }
            segs = out;
        }
        StringBuilder sb = new StringBuilder(abs.length());
        sb.append(root);
        if (!root.isEmpty() && !isSep(root.charAt(root.length() - 1)) && !segs.isEmpty()) sb.append(SEP);
        for (int k = 0; k < segs.size(); k++) {
            if (k > 0) sb.append(SEP);
            sb.append(segs.get(k));
        }
        return sb.toString();
    }

    static List<String> segments(String p, int from) {
        List<String> segs = new ArrayList<>();
        int n = p.length(), i = from;
        while (i < n) {
            int j = i;
            while (j < n && !isSep(p.charAt(j))) j++;
            if (j > i) segs.add(p.substring(i, j));
            i = j + 1;
        }
        return segs;
    }

    /** Trailing separators removed (TrimEnd('\\')). */
    public static String stripSep(String p) {
        int n = p.length();
        while (n > 0 && isSep(p.charAt(n - 1))) n--;
        return n == p.length() ? p : p.substring(0, n);
    }

    /** True when path is strictly inside dir (case-insensitive, like NoteStore.IsInside on the PC). */
    public static boolean isInside(String path, String dir) {
        String p = full(path);
        String d = stripSep(full(dir)) + SEP;
        return p.length() > d.length() - 1 && p.regionMatches(true, 0, d, 0, d.length());
    }

    /** Same path, ignoring case and trailing separators. */
    public static boolean pathEq(String a, String b) {
        if (a == null || b == null) return false;
        return stripSep(full(a)).equalsIgnoreCase(stripSep(full(b)));
    }

    /** Path.GetRelativePath (case-insensitive like Windows); "." when both are the same; the target itself across roots. */
    public static String relPath(String fromDir, String to) {
        String a = full(fromDir), b = full(to);
        int ra = rootLength(a), rb = rootLength(b);
        if (!stripSep(a.substring(0, ra)).equalsIgnoreCase(stripSep(b.substring(0, rb)))) return b;
        List<String> sa = segments(a, ra), sb = segments(b, rb);
        int i = 0;
        while (i < sa.size() && i < sb.size() && sa.get(i).equalsIgnoreCase(sb.get(i))) i++;
        StringBuilder r = new StringBuilder();
        for (int k = i; k < sa.size(); k++) {
            if (r.length() > 0) r.append(SEP);
            r.append("..");
        }
        for (int k = i; k < sb.size(); k++) {
            if (r.length() > 0) r.append(SEP);
            r.append(sb.get(k));
        }
        return r.length() == 0 ? "." : r.toString();
    }

    /** Relative path with '/' (NoteStore.Rel on the PC). */
    public static String rel(String baseDir, String abs) {
        String d = stripSep(full(baseDir)) + SEP;
        String p = full(abs);
        if (p.length() > d.length() && p.regionMatches(true, 0, d, 0, d.length())) {
            String r = p.substring(d.length());
            return WINDOWS ? r.replace('\\', '/') : r;
        }
        String r = relPath(baseDir, abs);
        return WINDOWS ? r.replace('\\', '/') : r;
    }

    /** Path.Combine for two parts (a rooted second part wins). */
    public static String combine(String a, String b) {
        if (b.isEmpty()) return a;
        if (a.isEmpty() || isRooted(b)) return b;
        return isSep(a.charAt(a.length() - 1)) ? a + b : a + SEP + b;
    }

    /** Path.GetDirectoryName for a full path: the parent, or null for a root. */
    public static String dirOf(String p) {
        int rl = rootLength(p);
        if (p.length() <= rl) return null;
        int i = p.length() - 1;
        while (i > rl && !isSep(p.charAt(i))) i--;
        return i <= rl ? p.substring(0, rl) : p.substring(0, i);
    }

    /** Path.GetFileName (both '/' and '\' end a folder, as on the PC). */
    public static String fileName(String p) {
        int i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
        return i < 0 ? p : p.substring(i + 1);
    }

    /** Path.GetExtension: ".md", or "" (also for a name ending with a dot). */
    public static String ext(String p) {
        String name = fileName(p);
        int i = name.lastIndexOf('.');
        return i < 0 || i == name.length() - 1 ? "" : name.substring(i);
    }

    /** Path.GetFileNameWithoutExtension. */
    public static String stem(String p) {
        String name = fileName(p);
        int i = name.lastIndexOf('.');
        return i < 0 ? name : name.substring(0, i);
    }

    /** Directory.CreateDirectory. */
    public static void mkdirs(String p) throws IOException {
        File f = new File(p);
        if (f.isDirectory()) return;
        if (!f.mkdirs() && !f.isDirectory()) throw new IOException("Could not create the folder " + p);
    }
}

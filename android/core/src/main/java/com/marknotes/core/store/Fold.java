package com.marknotes.core.store;

import java.text.Normalizer;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Text folded for comparisons that ignore case and accents, like the PC's search
 * (CompareInfo.IndexOf with IgnoreCase | IgnoreNonSpace, ICU collation): "Canción" and "cancion" fold to the same
 * text. Each character gets its compatibility decomposition (NFKD: "ﬁ" → "fi", "²" → "2", "Ⅻ" → "XII"; full- and
 * half-width forms keep their width, like on the PC), combining marks and invisible format characters are dropped and
 * the case is folded. Letters the PC treats as accented forms without a decomposition fold to their base: æ → ae,
 * œ → oe, ø → o, đ/ð → d, ħ → h, ł → l, ß → ss; dotless ı stays distinct. Checked against .NET 8 on Windows.
 */
final class Fold {
    private Fold() {}

    private static final ConcurrentHashMap<Integer, String> CACHE = new ConcurrentHashMap<>();

    /** Letters that fold to other letters although Unicode gives them no decomposition. */
    private static String special(int cp) {
        switch (cp) {
            case 0xC6: case 0xE6: return "ae";
            case 0x152: case 0x153: return "oe";
            case 0xD8: case 0xF8: return "o";
            case 0x110: case 0x111: case 0xD0: case 0xF0: return "d";
            case 0x126: case 0x127: return "h";
            case 0x141: case 0x142: return "l";
            case 0xDF: case 0x1E9E: return "ss";
            case 0x131: return String.valueOf((char) 0x131);
            default: return null;
        }
    }

    static String fold(String s) {
        int n = s.length(), i = 0;
        for (; i < n; i++) {
            char c = s.charAt(i);
            if (c >= 0x80 || (c >= 'A' && c <= 'Z')) break;
        }
        if (i == n) return s;
        StringBuilder sb = new StringBuilder(n);
        sb.append(s, 0, i);
        while (i < n) {
            char c = s.charAt(i);
            if (c < 0x80) {
                sb.append(c >= 'A' && c <= 'Z' ? (char) (c + 32) : c);
                i++;
                continue;
            }
            int cp = s.codePointAt(i);
            sb.append(foldCp(cp));
            i += Character.charCount(cp);
        }
        return sb.toString();
    }

    static String foldCp(int cp) {
        if (cp < 0x80) return String.valueOf((char) (cp >= 'A' && cp <= 'Z' ? cp + 32 : cp));
        String r = CACHE.get(cp);
        if (r != null) return r;
        r = special(cp);
        if (r == null) {
            boolean width = cp >= 0xFF00 && cp <= 0xFFEF;
            String d = Normalizer.normalize(new String(Character.toChars(cp)), width ? Normalizer.Form.NFD : Normalizer.Form.NFKD);
            StringBuilder sb = new StringBuilder(2);
            for (int k = 0; k < d.length(); ) {
                int c = d.codePointAt(k);
                k += Character.charCount(c);
                int t = Character.getType(c);
                if (t == Character.NON_SPACING_MARK || t == Character.FORMAT) continue;
                String s = special(c);
                if (s != null) sb.append(s);
                else sb.appendCodePoint(Character.toLowerCase(Character.toUpperCase(c)));
            }
            r = sb.toString();
        }
        if (CACHE.size() < 50000) CACHE.put(cp, r);
        return r;
    }

    /** Index in s of the character that gave folded position fp (s.length() past the end). */
    static int origIndex(String s, int fp) {
        int acc = 0;
        for (int i = 0; i < s.length(); ) {
            int cp = s.codePointAt(i);
            int len = cp < 0x80 ? 1 : foldCp(cp).length();
            if (acc + len > fp) return i;
            acc += len;
            i += Character.charCount(cp);
        }
        return s.length();
    }
}

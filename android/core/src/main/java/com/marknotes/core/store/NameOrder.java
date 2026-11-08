package com.marknotes.core.store;

import java.util.Comparator;

/**
 * File Explorer's name order (StrCmpLogicalW on the PC), checked against Windows: runs of digits compare as numbers
 * ("2" before "10"; equal numbers with more leading zeros first: "001", "01", "1"), letters ignore case and accents
 * ("álbum" next to "album"), spaces and punctuation come before digits, which come before letters ("_Archive"
 * first), emoji come last, and hyphens and apostrophes are skipped like in Windows' word sort ("coop", "co-op").
 * Ties are broken by accents, then case, then the skipped characters, so the order is consistent.
 */
public final class NameOrder {
    private NameOrder() {}

    public static final Comparator<String> LOGICAL = NameOrder::compare;

    /** Upper-case ordinal order with an ordinal tie-break: how NTFS lists a folder. */
    public static final Comparator<String> NTFS = (a, b) -> {
        int n = Math.min(a.length(), b.length());
        for (int i = 0; i < n; i++) {
            char x = Character.toUpperCase(a.charAt(i)), y = Character.toUpperCase(b.charAt(i));
            if (x != y) return x < y ? -1 : 1;
        }
        if (a.length() != b.length()) return a.length() < b.length() ? -1 : 1;
        return a.compareTo(b);
    };

    public static int compare(String a, String b) {
        int[] zeros = {0};
        int c = logical(Fold.fold(a), Fold.fold(b), zeros);
        if (c != 0) return c;
        if (zeros[0] != 0) return zeros[0];
        c = logical(upper(a), upper(b), null);
        if (c != 0) return c;
        int ia = skipped(a), ib = skipped(b);
        return ia == ib ? 0 : ia < ib ? -1 : 1;
    }

    private static String upper(String s) {
        char[] a = s.toCharArray();
        for (int i = 0; i < a.length; i++) a[i] = Character.toUpperCase(a[i]);
        return new String(a);
    }

    private static boolean digit(char c) {
        return c >= '0' && c <= '9';
    }

    /** Characters Windows' word sort leaves out of the comparison. */
    private static boolean skip(char c) {
        return c == '-' || c == '\'';
    }

    private static int skipped(String s) {
        int n = 0;
        for (int i = 0; i < s.length(); i++) if (skip(s.charAt(i))) n++;
        return n;
    }

    /** 0 = space, punctuation, symbols; 1 = digits; 2 = letters; 3 = emoji and other characters beyond the BMP. */
    private static int klass(char c) {
        if (digit(c)) return 1;
        if (Character.isSurrogate(c)) return 3;
        return Character.isLetterOrDigit(c) ? 2 : 0;
    }

    /** zeros[0] (when given) gets the first leading-zero difference: -1 when x has more zeros there, 1 when y has. */
    private static int logical(String x, String y, int[] zeros) {
        int i = 0, j = 0, nx = x.length(), ny = y.length();
        while (true) {
            while (i < nx && skip(x.charAt(i))) i++;
            while (j < ny && skip(y.charAt(j))) j++;
            if (i >= nx || j >= ny) break;
            char cx = x.charAt(i), cy = y.charAt(j);
            if (digit(cx) && digit(cy)) {
                int si = i, sj = j;
                while (i < nx && digit(x.charAt(i))) i++;
                while (j < ny && digit(y.charAt(j))) j++;
                int c = compareDigits(x, si, i, y, sj, j);
                if (c != 0) return c;
                if (zeros != null && zeros[0] == 0 && i - si != j - sj) zeros[0] = i - si > j - sj ? -1 : 1;
                continue;
            }
            int kx = klass(cx), ky = klass(cy);
            if (kx != ky) return kx < ky ? -1 : 1;
            if (cx != cy) return cx < cy ? -1 : 1;
            i++;
            j++;
        }
        boolean xEnd = i >= nx, yEnd = j >= ny;
        if (xEnd && yEnd) return 0;
        return xEnd ? -1 : 1;
    }

    /** Digit runs by value (leading zeros ignored). */
    private static int compareDigits(String x, int xs, int xe, String y, int ys, int ye) {
        while (xs < xe - 1 && x.charAt(xs) == '0') xs++;
        while (ys < ye - 1 && y.charAt(ys) == '0') ys++;
        int lx = xe - xs, ly = ye - ys;
        if (lx != ly) return lx < ly ? -1 : 1;
        for (int k = 0; k < lx; k++) {
            char a = x.charAt(xs + k), b = y.charAt(ys + k);
            if (a != b) return a < b ? -1 : 1;
        }
        return 0;
    }
}

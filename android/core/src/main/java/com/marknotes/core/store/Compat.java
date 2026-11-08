package com.marknotes.core.store;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Locale;
import java.util.UUID;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** The .NET string, regex and date semantics the PC's storage code relies on. */
final class Compat {
    private Compat() {}

    /**
     * .NET's {@code \s} (Unicode white space), for use inside a regex character class. Java's own {@code \s} is
     * ASCII-only on desktop JDKs and Unicode on Android, so patterns spell it out to behave the same everywhere.
     */
    static final String WS = "\\t\\n\\x0B\\f\\r\\x85\\p{Z}";

    /** char.IsWhiteSpace. */
    static boolean isWs(char c) {
        if (c == ' ' || (c >= '\t' && c <= '\r')) return true;
        if (c < 0x80) return false;
        return c == '\u0085' || c == '\u00A0' || Character.isSpaceChar(c);
    }

    /** string.Trim(). */
    static String trim(String s) {
        int a = 0, b = s.length();
        while (a < b && isWs(s.charAt(a))) a++;
        while (b > a && isWs(s.charAt(b - 1))) b--;
        return a == 0 && b == s.length() ? s : s.substring(a, b);
    }

    /** string.IsNullOrWhiteSpace. */
    static boolean isBlank(String s) {
        if (s == null) return true;
        for (int i = 0; i < s.length(); i++) if (!isWs(s.charAt(i))) return false;
        return true;
    }

    /** string.IsNullOrEmpty. */
    static boolean isEmpty(String s) {
        return s == null || s.isEmpty();
    }

    /** string.TrimStart(chars). */
    static String trimStart(String s, String chars) {
        int a = 0;
        while (a < s.length() && chars.indexOf(s.charAt(a)) >= 0) a++;
        return a == 0 ? s : s.substring(a);
    }

    /** string.TrimEnd(chars). */
    static String trimEnd(String s, String chars) {
        int b = s.length();
        while (b > 0 && chars.indexOf(s.charAt(b - 1)) >= 0) b--;
        return b == s.length() ? s : s.substring(0, b);
    }

    /** string.Trim(chars). */
    static String trimChars(String s, String chars) {
        return trimEnd(trimStart(s, chars), chars);
    }

    /** {@code s.Split(c)[0]}. */
    static String before(String s, char c) {
        int i = s.indexOf(c);
        return i < 0 ? s : s.substring(0, i);
    }

    static boolean startsWithIc(String s, String prefix) {
        return s.regionMatches(true, 0, prefix, 0, prefix.length());
    }

    static boolean endsWithIc(String s, String suffix) {
        int off = s.length() - suffix.length();
        return off >= 0 && s.regionMatches(true, off, suffix, 0, suffix.length());
    }

    /** IndexOf(sub, StringComparison.OrdinalIgnoreCase). */
    static int indexOfIc(String s, String sub) {
        if (sub.isEmpty()) return 0;
        int last = s.length() - sub.length();
        char f = sub.charAt(0);
        char fu = Character.toUpperCase(f), fl = Character.toLowerCase(f);
        for (int i = 0; i <= last; i++) {
            char c = s.charAt(i);
            if (c != f && c != fu && c != fl && Character.toUpperCase(c) != fu) continue;
            if (s.regionMatches(true, i, sub, 0, sub.length())) return i;
        }
        return -1;
    }

    static boolean containsIc(String s, String sub) {
        return indexOfIc(s, sub) >= 0;
    }

    // ------------------------------------------------------------------ regex

    /** Regex.Replace with a MatchEvaluator (Java 8 has no Matcher.replaceAll(Function)). */
    static String replace(Pattern p, String input, Function<Matcher, String> f) {
        Matcher m = p.matcher(input);
        if (!m.find()) return input;
        StringBuilder sb = new StringBuilder(input.length() + 16);
        int last = 0;
        do {
            sb.append(input, last, m.start());
            sb.append(f.apply(m));
            last = m.end();
        } while (m.find());
        sb.append(input, last, input.length());
        return sb.toString();
    }

    // ------------------------------------------------------------------ dates and ids

    private static final DateTimeFormatter ROUND_TRIP =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSSSSSS'Z'", Locale.ROOT).withZone(ZoneOffset.UTC);

    /** DateTime.UtcNow.ToString("o"): 2026-11-07T12:34:56.1234567Z. */
    static String nowO() {
        return ROUND_TRIP.format(Instant.now());
    }

    /**
     * DateTime.TryParse(s, InvariantCulture, RoundtripKind) then ToUniversalTime, as Unix milliseconds; null when
     * it is not a date. Covers what MarkNotes writes (round-trip "o") and the usual ISO forms; times without an
     * offset are local, like .NET's.
     */
    static Long parseDateMs(String s) {
        if (s == null) return null;
        String t = trim(s);
        if (t.isEmpty()) return null;
        try {
            return OffsetDateTime.parse(t).toInstant().toEpochMilli();
        } catch (RuntimeException ignored) {
        }
        try {
            return Instant.parse(t).toEpochMilli();
        } catch (RuntimeException ignored) {
        }
        String local = t.indexOf('T') < 0 && t.indexOf(' ') > 0 ? t.replaceFirst(" ", "T") : t;
        try {
            return LocalDateTime.parse(local).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli();
        } catch (RuntimeException ignored) {
        }
        try {
            return LocalDate.parse(t).atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli();
        } catch (RuntimeException ignored) {
        }
        return null;
    }

    /** Guid.NewGuid().ToString("N")[..6]. */
    static String hex6() {
        return UUID.randomUUID().toString().replace("-", "").substring(0, 6);
    }
}

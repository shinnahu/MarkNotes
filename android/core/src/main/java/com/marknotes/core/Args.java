package com.marknotes.core;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Reading command arguments the way the PC's Bridge.cs does (S, Req, B, Has, L, Strs). */
public final class Args {
    private Args() {}

    /** String argument or null (non-strings count as missing). */
    public static String s(Map<String, Object> a, String name) {
        Object v = a == null ? null : a.get(name);
        return v instanceof String ? (String) v : null;
    }

    /** Required string argument. */
    public static String req(Map<String, Object> a, String name) {
        String v = s(a, name);
        if (v == null) throw new IllegalArgumentException("Missing " + name);
        return v;
    }

    /** True only for a JSON true. */
    public static boolean b(Map<String, Object> a, String name) {
        Object v = a == null ? null : a.get(name);
        return Boolean.TRUE.equals(v);
    }

    public static boolean has(Map<String, Object> a, String name) {
        return a != null && a.containsKey(name);
    }

    /** Integral number or 0. */
    public static long l(Map<String, Object> a, String name) {
        Object v = a == null ? null : a.get(name);
        return v instanceof Number ? ((Number) v).longValue() : 0;
    }

    /** Number or {@code def}. */
    public static double d(Map<String, Object> a, String name, double def) {
        Object v = a == null ? null : a.get(name);
        return v instanceof Number ? ((Number) v).doubleValue() : def;
    }

    /** Array of strings (other items skipped); empty when missing. */
    public static List<String> strs(Map<String, Object> a, String name) {
        List<String> out = new ArrayList<>();
        Object v = a == null ? null : a.get(name);
        if (v instanceof List) for (Object x : (List<?>) v) if (x instanceof String) out.add((String) x);
        return out;
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> map(Map<String, Object> a, String name) {
        Object v = a == null ? null : a.get(name);
        return v instanceof Map ? (Map<String, Object>) v : null;
    }
}

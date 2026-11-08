package com.marknotes.core;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Small JSON reader/writer (no library to ship). Objects are {@code LinkedHashMap<String,Object>} (key order kept),
 * arrays {@code ArrayList<Object>}, numbers {@code Long} when integral, otherwise {@code Double}.
 * {@link #pretty} writes the way the PC's System.Text.Json does with WriteIndented (two spaces, "key": value), so
 * files written here and on the PC look alike.
 */
public final class Json {
    private Json() {}

    // ------------------------------------------------------------------ writing

    public static String write(Object o) {
        StringBuilder sb = new StringBuilder();
        write(sb, o, -1, 0);
        return sb.toString();
    }

    /** Indented with two spaces; null values in objects are left out (like JsonIgnoreCondition.WhenWritingNull). */
    public static String pretty(Object o) {
        StringBuilder sb = new StringBuilder();
        write(sb, o, 2, 0);
        return sb.toString();
    }

    private static void newline(StringBuilder sb, int indent, int depth) {
        sb.append('\n');
        for (int i = 0; i < indent * depth; i++) sb.append(' ');
    }

    @SuppressWarnings("unchecked")
    private static void write(StringBuilder sb, Object o, int indent, int depth) {
        if (o == null) {
            sb.append("null");
        } else if (o instanceof String) {
            quote(sb, (String) o);
        } else if (o instanceof Boolean || o instanceof Integer || o instanceof Long || o instanceof Short || o instanceof Byte) {
            sb.append(o);
        } else if (o instanceof Number) {
            double d = ((Number) o).doubleValue();
            if (Double.isNaN(d) || Double.isInfinite(d)) sb.append("null");
            else if (d == Math.rint(d) && Math.abs(d) < 9e15) sb.append((long) d);
            else sb.append(d);
        } else if (o instanceof Map) {
            Map<Object, Object> m = (Map<Object, Object>) o;
            sb.append('{');
            boolean first = true;
            for (Map.Entry<Object, Object> e : m.entrySet()) {
                if (indent > 0 && e.getValue() == null) continue;
                if (!first) sb.append(',');
                first = false;
                if (indent > 0) newline(sb, indent, depth + 1);
                quote(sb, String.valueOf(e.getKey()));
                sb.append(indent > 0 ? ": " : ":");
                write(sb, e.getValue(), indent, depth + 1);
            }
            if (indent > 0 && !first) newline(sb, indent, depth);
            sb.append('}');
        } else if (o instanceof Collection || o instanceof Object[]) {
            Collection<Object> c = o instanceof Object[] ? java.util.Arrays.asList((Object[]) o) : (Collection<Object>) o;
            sb.append('[');
            boolean first = true;
            for (Object v : c) {
                if (!first) sb.append(',');
                first = false;
                if (indent > 0) newline(sb, indent, depth + 1);
                write(sb, v, indent, depth + 1);
            }
            if (indent > 0 && !first) newline(sb, indent, depth);
            sb.append(']');
        } else if (o instanceof JsonValue) {
            write(sb, ((JsonValue) o).toJson(), indent, depth);
        } else {
            quote(sb, o.toString());
        }
    }

    /** Objects that know their own JSON form (DTOs). */
    public interface JsonValue {
        Object toJson();
    }

    private static final char[] HEX = "0123456789abcdef".toCharArray();

    private static void quote(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                default:
                    // U+2028/2029 are valid JSON but end a line in older JavaScript: escaped for evaluateJavascript.
                    if (c < 0x20 || c == ' ' || c == ' ') {
                        sb.append("\\u").append(HEX[(c >> 12) & 15]).append(HEX[(c >> 8) & 15]).append(HEX[(c >> 4) & 15]).append(HEX[c & 15]);
                    } else {
                        sb.append(c);
                    }
            }
        }
        sb.append('"');
    }

    // ------------------------------------------------------------------ reading

    public static Object parse(String s) {
        Parser p = new Parser(s);
        p.ws();
        Object v = p.value();
        p.ws();
        if (p.i != s.length()) throw new IllegalArgumentException("trailing data in JSON at " + p.i);
        return v;
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> parseObject(String s) {
        Object o = parse(s);
        if (!(o instanceof Map)) throw new IllegalArgumentException("JSON object expected");
        return (Map<String, Object>) o;
    }

    public static String getString(Map<String, Object> m, String k, String def) {
        Object v = m == null ? null : m.get(k);
        return v == null ? def : v.toString();
    }

    public static long getLong(Map<String, Object> m, String k, long def) {
        Object v = m == null ? null : m.get(k);
        if (v instanceof Number) return ((Number) v).longValue();
        if (v instanceof String) {
            try { return Long.parseLong((String) v); } catch (NumberFormatException e) { return def; }
        }
        return def;
    }

    public static boolean getBool(Map<String, Object> m, String k, boolean def) {
        Object v = m == null ? null : m.get(k);
        return v instanceof Boolean ? (Boolean) v : def;
    }

    @SuppressWarnings("unchecked")
    public static List<Object> getList(Map<String, Object> m, String k) {
        Object v = m == null ? null : m.get(k);
        return v instanceof List ? (List<Object>) v : new ArrayList<Object>();
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> getMap(Map<String, Object> m, String k) {
        Object v = m == null ? null : m.get(k);
        return v instanceof Map ? (Map<String, Object>) v : null;
    }

    /** {@code obj("a", 1, "b", "x")} → ordered map. */
    public static Map<String, Object> obj(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i + 1 < kv.length; i += 2) m.put((String) kv[i], kv[i + 1]);
        return m;
    }

    private static final class Parser {
        final String s;
        int i;

        Parser(String s) { this.s = s; }

        void ws() {
            while (i < s.length()) {
                char c = s.charAt(i);
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '﻿') i++;
                else break;
            }
        }

        IllegalArgumentException err(String m) { return new IllegalArgumentException(m + " at " + i); }

        Object value() {
            if (i >= s.length()) throw err("unexpected end");
            char c = s.charAt(i);
            if (c == '{') return object();
            if (c == '[') return array();
            if (c == '"') return string();
            if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
            if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
            if (s.startsWith("null", i)) { i += 4; return null; }
            return number();
        }

        Map<String, Object> object() {
            Map<String, Object> m = new LinkedHashMap<>();
            i++;
            ws();
            if (i < s.length() && s.charAt(i) == '}') { i++; return m; }
            while (true) {
                ws();
                if (i >= s.length() || s.charAt(i) != '"') throw err("key expected");
                String k = string();
                ws();
                if (i >= s.length() || s.charAt(i) != ':') throw err("':' expected");
                i++;
                ws();
                m.put(k, value());
                ws();
                if (i >= s.length()) throw err("unexpected end");
                char c = s.charAt(i++);
                if (c == '}') return m;
                if (c != ',') throw err("',' expected");
            }
        }

        List<Object> array() {
            List<Object> l = new ArrayList<>();
            i++;
            ws();
            if (i < s.length() && s.charAt(i) == ']') { i++; return l; }
            while (true) {
                ws();
                l.add(value());
                ws();
                if (i >= s.length()) throw err("unexpected end");
                char c = s.charAt(i++);
                if (c == ']') return l;
                if (c != ',') throw err("',' expected");
            }
        }

        String string() {
            i++;
            int start = i;
            // Fast path: no escapes.
            while (i < s.length()) {
                char c = s.charAt(i);
                if (c == '"') { String out = s.substring(start, i); i++; return out; }
                if (c == '\\') break;
                i++;
            }
            StringBuilder sb = new StringBuilder(s.substring(start, i));
            while (i < s.length()) {
                char c = s.charAt(i++);
                if (c == '"') return sb.toString();
                if (c == '\\') {
                    if (i >= s.length()) break;
                    char e = s.charAt(i++);
                    switch (e) {
                        case 'n': sb.append('\n'); break;
                        case 'r': sb.append('\r'); break;
                        case 't': sb.append('\t'); break;
                        case 'b': sb.append('\b'); break;
                        case 'f': sb.append('\f'); break;
                        case 'u':
                            if (i + 4 > s.length()) throw err("bad \\u escape");
                            sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                            i += 4;
                            break;
                        default: sb.append(e);
                    }
                } else {
                    sb.append(c);
                }
            }
            throw err("unterminated string");
        }

        Object number() {
            int st = i;
            while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
            String n = s.substring(st, i);
            if (n.isEmpty()) throw err("value expected");
            try {
                if (n.indexOf('.') < 0 && n.indexOf('e') < 0 && n.indexOf('E') < 0) return Long.parseLong(n);
                return Double.parseDouble(n);
            } catch (NumberFormatException e) {
                throw err("bad number");
            }
        }
    }
}

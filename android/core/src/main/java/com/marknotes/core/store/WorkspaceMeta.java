package com.marknotes.core.store;

import com.marknotes.core.Json;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Contents of {@code <workspace>/.workspace.json}, read and written like the PC (System.Text.Json web defaults:
 * camelCase, property names matched ignoring case, numbers also read from strings, nulls left out when written,
 * two-space indentation, CRLF line ends and UnsafeRelaxedJsonEscaping's escapes, as .NET 8 writes them on Windows:
 * the same data gives the same bytes on both). Folder and note keys are paths relative to the workspace and ignore
 * case. Properties this version does not know are kept and written back, so a newer PC's additions survive a save on
 * the phone.
 */
public final class WorkspaceMeta {
    public String format = "marknotes-workspace";
    public int version = 1;
    public String id = "";
    public String name = "";
    public String color;
    public String icon;
    /** Banner image or GIF shown at the top of the sidebar (file next to the icon). */
    public String banner;
    /** Animated banners play only while the pointer is over them. */
    public Boolean bannerHover;
    /** Workspace Guide: markdown shown on the guide page (optional, see guideOn). */
    public String guide;
    public Boolean guideOn;
    /** Browse Folders page shown in the sidebar. */
    public Boolean browseOn;
    public String created;
    public CiMap<FolderMeta> folders = new CiMap<>();
    public CiMap<NoteMeta> notes = new CiMap<>();
    Map<String, Object> extra;

    public static final class FolderMeta {
        public String color;
        public String icon;
        public Integer order;
        /** Shown in Browse Folders. */
        public String description;
        Map<String, Object> extra;

        Map<String, Object> toJson() {
            Map<String, Object> o = new LinkedHashMap<>();
            o.put("color", color);
            o.put("icon", icon);
            o.put("order", order);
            o.put("description", description);
            addExtra(o, extra);
            return o;
        }

        static FolderMeta from(Map<?, ?> m) {
            FolderMeta f = new FolderMeta();
            for (Map.Entry<?, ?> kv : m.entrySet()) {
                String k = String.valueOf(kv.getKey());
                Object v = kv.getValue();
                switch (k.toLowerCase(Locale.ROOT)) {
                    case "color" -> f.color = str(v, f.color);
                    case "icon" -> f.icon = str(v, f.icon);
                    case "order" -> f.order = integer(v, f.order);
                    case "description" -> f.description = str(v, f.description);
                    default -> f.extra = putExtra(f.extra, k, v);
                }
            }
            return f;
        }

        FolderMeta copy() {
            FolderMeta f = new FolderMeta();
            f.color = color;
            f.icon = icon;
            f.order = order;
            f.description = description;
            if (extra != null) f.extra = new LinkedHashMap<>(extra);
            return f;
        }
    }

    public static final class NoteMeta {
        public String color;
        public Boolean pinned;
        public Boolean autoTitle;
        public String created;
        Map<String, Object> extra;

        Map<String, Object> toJson() {
            Map<String, Object> o = new LinkedHashMap<>();
            o.put("color", color);
            o.put("pinned", pinned);
            o.put("autoTitle", autoTitle);
            o.put("created", created);
            addExtra(o, extra);
            return o;
        }

        static NoteMeta from(Map<?, ?> m) {
            NoteMeta n = new NoteMeta();
            for (Map.Entry<?, ?> kv : m.entrySet()) {
                String k = String.valueOf(kv.getKey());
                Object v = kv.getValue();
                switch (k.toLowerCase(Locale.ROOT)) {
                    case "color" -> n.color = str(v, n.color);
                    case "pinned" -> n.pinned = bool(v, n.pinned);
                    case "autotitle" -> n.autoTitle = bool(v, n.autoTitle);
                    case "created" -> n.created = str(v, n.created);
                    default -> n.extra = putExtra(n.extra, k, v);
                }
            }
            return n;
        }
    }

    public Map<String, Object> toJson() {
        Map<String, Object> o = new LinkedHashMap<>();
        o.put("format", format);
        o.put("version", version);
        o.put("id", id);
        o.put("name", name);
        o.put("color", color);
        o.put("icon", icon);
        o.put("banner", banner);
        o.put("bannerHover", bannerHover);
        o.put("guide", guide);
        o.put("guideOn", guideOn);
        o.put("browseOn", browseOn);
        o.put("created", created);
        Map<String, Object> f = new LinkedHashMap<>();
        for (Map.Entry<String, FolderMeta> e : folders.entrySet()) if (e.getValue() != null) f.put(e.getKey(), e.getValue().toJson());
        o.put("folders", f);
        Map<String, Object> n = new LinkedHashMap<>();
        for (Map.Entry<String, NoteMeta> e : notes.entrySet()) if (e.getValue() != null) n.put(e.getKey(), e.getValue().toJson());
        o.put("notes", n);
        addExtra(o, extra);
        return o;
    }

    /** The file's text, as the PC writes it. */
    public String toPrettyJson() {
        return pcText(Json.pretty(toJson()));
    }

    /** Json.pretty output → what System.Text.Json writes on Windows for the same data (CRLF, .NET escapes). */
    static String pcText(String json) {
        return netEscape(json).replace("\n", "\r\n");
    }

    /**
     * Characters UnsafeRelaxedJsonEscaping writes as \\uXXXX (checked against .NET 8 for the whole BMP): controls,
     * surrogates (so characters beyond the BMP, like emoji, become two escapes), private use, unassigned, line and
     * paragraph separators, spaces other than U+0020, and U+FEFF.
     */
    private static boolean netEscapes(char c) {
        switch (Character.getType(c)) {
            case Character.CONTROL:
            case Character.SURROGATE:
            case Character.PRIVATE_USE:
            case Character.UNASSIGNED:
            case Character.LINE_SEPARATOR:
            case Character.PARAGRAPH_SEPARATOR:
                return true;
            case Character.FORMAT:
                return c == 0xFEFF;
            case Character.SPACE_SEPARATOR:
                return c != ' ';
            default:
                return false;
        }
    }

    private static final char[] HEX_UPPER = "0123456789ABCDEF".toCharArray();

    /** Inside the JSON strings of Json's output: .NET's \\uXXXX escapes (upper-case hex); the short ones are the same. */
    static String netEscape(String json) {
        StringBuilder sb = null;
        boolean inString = false;
        int n = json.length();
        for (int i = 0; i < n; i++) {
            char c = json.charAt(i);
            String rep = null;
            if (!inString) {
                if (c == '"') inString = true;
            } else if (c == '\\' && i + 1 < n) {
                // An escape Json already wrote: \" \\ \n … stay, \\u00XX gets upper-case hex.
                int len = json.charAt(i + 1) == 'u' && i + 5 < n ? 6 : 2;
                String esc = json.substring(i, i + len);
                String fixed = len == 6 ? esc.substring(0, 2) + esc.substring(2).toUpperCase(Locale.ROOT) : esc;
                if (!fixed.equals(esc) && sb == null) sb = new StringBuilder(n + 16).append(json, 0, i);
                if (sb != null) sb.append(fixed);
                i += len - 1;
                continue;
            } else if (c == '"') {
                inString = false;
            } else if (netEscapes(c)) {
                rep = "\\u" + HEX_UPPER[(c >> 12) & 15] + HEX_UPPER[(c >> 8) & 15] + HEX_UPPER[(c >> 4) & 15] + HEX_UPPER[c & 15];
            }
            if (rep != null) {
                if (sb == null) sb = new StringBuilder(n + 16).append(json, 0, i);
                sb.append(rep);
            } else if (sb != null) sb.append(c);
        }
        return sb == null ? json : sb.toString();
    }

    /** Parses a .workspace.json; IllegalArgumentException when it is not a JSON object. Wrong-typed values are ignored. */
    public static WorkspaceMeta parse(String json) {
        Object o = Json.parse(json);
        if (!(o instanceof Map)) throw new IllegalArgumentException("Not a workspace file (JSON object expected)");
        return from((Map<?, ?>) o);
    }

    static WorkspaceMeta from(Map<?, ?> m) {
        WorkspaceMeta w = new WorkspaceMeta();
        for (Map.Entry<?, ?> kv : m.entrySet()) {
            String k = String.valueOf(kv.getKey());
            Object v = kv.getValue();
            switch (k.toLowerCase(Locale.ROOT)) {
                case "format" -> w.format = str(v, w.format);
                case "version" -> {
                    Integer n = integer(v, w.version);
                    if (n != null) w.version = n;
                }
                case "id" -> w.id = str(v, w.id);
                case "name" -> w.name = str(v, w.name);
                case "color" -> w.color = str(v, w.color);
                case "icon" -> w.icon = str(v, w.icon);
                case "banner" -> w.banner = str(v, w.banner);
                case "bannerhover" -> w.bannerHover = bool(v, w.bannerHover);
                case "guide" -> w.guide = str(v, w.guide);
                case "guideon" -> w.guideOn = bool(v, w.guideOn);
                case "browseon" -> w.browseOn = bool(v, w.browseOn);
                case "created" -> w.created = str(v, w.created);
                case "folders" -> {
                    w.folders = new CiMap<>();
                    if (v instanceof Map) {
                        for (Map.Entry<?, ?> f : ((Map<?, ?>) v).entrySet())
                            if (f.getValue() instanceof Map) w.folders.put(String.valueOf(f.getKey()), FolderMeta.from((Map<?, ?>) f.getValue()));
                    }
                }
                case "notes" -> {
                    w.notes = new CiMap<>();
                    if (v instanceof Map) {
                        for (Map.Entry<?, ?> f : ((Map<?, ?>) v).entrySet())
                            if (f.getValue() instanceof Map) w.notes.put(String.valueOf(f.getKey()), NoteMeta.from((Map<?, ?>) f.getValue()));
                    }
                }
                default -> w.extra = putExtra(w.extra, k, v);
            }
        }
        return w;
    }

    // ------------------------------------------------------------------ helpers

    private static String str(Object v, String cur) {
        if (v == null) return null;
        return v instanceof String ? (String) v : cur;
    }

    private static Boolean bool(Object v, Boolean cur) {
        if (v == null) return null;
        return v instanceof Boolean ? (Boolean) v : cur;
    }

    private static Integer integer(Object v, Integer cur) {
        if (v == null) return null;
        if (v instanceof Long || v instanceof Integer) {
            long l = ((Number) v).longValue();
            return l >= Integer.MIN_VALUE && l <= Integer.MAX_VALUE ? (int) l : cur;
        }
        if (v instanceof Double) {
            double d = (Double) v;
            return d == Math.rint(d) && Math.abs(d) <= Integer.MAX_VALUE ? (int) d : cur;
        }
        if (v instanceof String) {
            try {
                return Integer.parseInt(Compat.trim((String) v));
            } catch (NumberFormatException e) {
                return cur;
            }
        }
        return cur;
    }

    private static Map<String, Object> putExtra(Map<String, Object> extra, String k, Object v) {
        if (extra == null) extra = new LinkedHashMap<>();
        extra.put(k, v);
        return extra;
    }

    private static void addExtra(Map<String, Object> o, Map<String, Object> extra) {
        if (extra == null) return;
        for (Map.Entry<String, Object> e : extra.entrySet()) if (!o.containsKey(e.getKey())) o.put(e.getKey(), e.getValue());
    }
}

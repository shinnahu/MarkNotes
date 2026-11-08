package com.marknotes.core.store;

import com.marknotes.core.Json;
import com.marknotes.core.Log;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Per-workspace cache of what lists and cards need from each note (kind, preview, cover, date), keyed by path +
 * modified time + size so unchanged files are never read again. Persisted in {@code <cacheDir>/index} so even the
 * first listing after a restart is instant (port of the PC's NoteIndex.cs).
 */
public final class NoteIndex {
    public static final class Entry {
        public long m;
        public long s;
        public String kind = "note";
        public String preview;
        public String banner;
        public String firstImage;
        public String date;

        Map<String, Object> toJson() {
            Map<String, Object> o = new LinkedHashMap<>();
            o.put("M", m);
            o.put("S", s);
            o.put("Kind", kind);
            o.put("Preview", preview);
            o.put("Banner", banner);
            o.put("FirstImage", firstImage);
            o.put("Date", date);
            return o;
        }

        static Entry fromJson(Object o) {
            if (!(o instanceof Map)) return null;
            Map<?, ?> m = (Map<?, ?>) o;
            Entry e = new Entry();
            Object v = m.get("M");
            if (v instanceof Number) e.m = ((Number) v).longValue();
            v = m.get("S");
            if (v instanceof Number) e.s = ((Number) v).longValue();
            v = m.get("Kind");
            e.kind = v instanceof String ? (String) v : null;
            e.preview = str(m.get("Preview"));
            e.banner = str(m.get("Banner"));
            e.firstImage = str(m.get("FirstImage"));
            e.date = str(m.get("Date"));
            return e;
        }

        private static String str(Object v) {
            return v instanceof String ? (String) v : null;
        }
    }

    private final File dir;
    private final Map<String, CiMap<Entry>> ws = new HashMap<>();
    private final Set<String> dirty = new HashSet<>();
    private final Object gate = new Object();
    private ScheduledExecutorService timer;
    private ScheduledFuture<?> pending;

    public NoteIndex(File dir) {
        this.dir = dir;
    }

    private File fileFor(String wsId) {
        // Workspace ids come from files: keep them from naming a file outside the index folder.
        StringBuilder sb = new StringBuilder();
        for (char c : wsId.toCharArray()) sb.append(Character.isLetterOrDigit(c) || c == '-' || c == '_' || c == '.' ? c : '_');
        String name = sb.toString();
        if (name.isEmpty() || name.startsWith(".")) name = "_" + name;
        return new File(dir, name + ".json");
    }

    private CiMap<Entry> load(String wsId) {
        synchronized (gate) {
            CiMap<Entry> d = ws.get(wsId);
            if (d != null) return d;
            d = new CiMap<>();
            try {
                File f = fileFor(wsId);
                if (f.isFile()) {
                    Object o = Json.parse(TextFiles.readAllText(Files.readAllBytes(f.toPath())));
                    if (o instanceof Map) {
                        for (Map.Entry<?, ?> kv : ((Map<?, ?>) o).entrySet()) {
                            Entry e = Entry.fromJson(kv.getValue());
                            if (e != null) d.put(String.valueOf(kv.getKey()), e);
                        }
                    }
                }
            } catch (Exception ex) {
                Log.error("NoteIndex.Load", ex);
            }
            ws.put(wsId, d);
            return d;
        }
    }

    /** The cached entry when it is still valid, without reading the file. */
    Entry peek(String wsId, String rel, FileStat fi) {
        CiMap<Entry> d = load(wsId);
        synchronized (gate) {
            Entry e = d.get(rel);
            if (e != null && e.m == fi.mtime && e.s == fi.size) return e;
        }
        return null;
    }

    Entry get(String wsId, String rel, FileStat fi) {
        CiMap<Entry> d = load(wsId);
        synchronized (gate) {
            Entry e = d.get(rel);
            if (e != null && e.m == fi.mtime && e.s == fi.size) return e;
        }
        Entry entry = build(fi);
        synchronized (gate) {
            d.put(rel, entry);
            dirty.add(wsId);
        }
        return entry;
    }

    private static final String W = Compat.WS;
    private static final Pattern FRONT_RX = Pattern.compile(
            "\\A\\uFEFF?---[ \\t]*\\r?\\n(.*?)\\r?\\n(?:---|\\.\\.\\.)[ \\t]*(?:\\r?\\n|$)", Pattern.DOTALL | Pattern.UNIX_LINES);
    private static final Pattern KEY_RX = Pattern.compile("^([A-Za-z0-9_\\-]+)[ \\t]*:[ \\t]*(.*?)[" + W + "]*$", Pattern.UNIX_LINES);
    private static final Pattern IMG_RX = Pattern.compile(
            "!\\[\\[([^\\]|#\\n]+\\.(?:png|jpe?g|gif|webp|bmp|avif))[^\\]\\n]*\\]\\]"
                    + "|!\\[[^\\]\\n]*\\]\\([" + W + "]*<?([^)" + W + ">]+\\.(?:png|jpe?g|gif|webp|bmp|avif))>?",
            Pattern.CASE_INSENSITIVE | Pattern.UNIX_LINES);
    private static final Pattern CANVAS_FILE_RX = Pattern.compile(
            "\"file\"[" + W + "]*:[" + W + "]*\"([^\"]+\\.(?:png|jpe?g|gif|webp|bmp))\"", Pattern.CASE_INSENSITIVE | Pattern.UNIX_LINES);

    static Entry build(FileStat fi) {
        Entry e = new Entry();
        e.m = fi.mtime;
        e.s = fi.size;
        String abs = fi.path;
        if (PathUtil.ext(fi.name).equalsIgnoreCase(".canvas")) {
            e.kind = "canvas";
            try {
                String text = fi.size < 8_000_000 ? TextFiles.readAllText(abs) : "";
                Matcher img = CANVAS_FILE_RX.matcher(text);
                if (img.find()) e.firstImage = regexUnescape(img.group(1));
            } catch (Exception ignored) {
            }
            return e;
        }
        fromText(e, TextFiles.preview(abs, 12000));
        return e;
    }

    /** Kind, banner, date, first image and preview from the start of a note's text. */
    static void fromText(Entry e, String head) {
        String body = head;
        Matcher fm = FRONT_RX.matcher(head);
        if (fm.find()) {
            for (String line : fm.group(1).split("\n", -1)) {
                Matcher kv = KEY_RX.matcher(Compat.trimEnd(line, "\r"));
                if (!kv.find()) continue;
                String key = kv.group(1).toLowerCase(Locale.ROOT);
                String val = Compat.trimChars(Compat.trim(kv.group(2)), "\"'");
                switch (key) {
                    case "banner", "cover", "image", "cover-image", "cover_image" -> {
                        if (val.length() > 0 && e.banner == null) e.banner = val;
                    }
                    case "datetime", "date", "created" -> {
                        if (val.length() > 0 && e.date == null) e.date = val;
                    }
                    case "kanban-plugin" -> e.kind = "kanban";
                    default -> {
                    }
                }
            }
            body = head.substring(fm.end());
        }
        Matcher first = IMG_RX.matcher(body);
        if (first.find()) e.firstImage = first.group(1) != null ? first.group(1) : first.group(2);
        String pv = Compat.trimStart(body, "\r\n \t");
        e.preview = pv.length() > 400 ? pv.substring(0, 400) : pv;
    }

    /** Regex.Unescape (what the PC applies to a canvas "file" value): backslash escapes such as \\ \/ \n and u+hex. */
    static String regexUnescape(String s) {
        if (s.indexOf('\\') < 0) return s;
        StringBuilder sb = new StringBuilder(s.length());
        int n = s.length();
        for (int i = 0; i < n; i++) {
            char c = s.charAt(i);
            if (c != '\\') {
                sb.append(c);
                continue;
            }
            if (i + 1 >= n) throw new IllegalArgumentException("Illegal \\ at end of pattern");
            char d = s.charAt(++i);
            switch (d) {
                case 'n' -> sb.append('\n');
                case 't' -> sb.append('\t');
                case 'r' -> sb.append('\r');
                case 'f' -> sb.append('\f');
                case 'v' -> sb.append('\u000B');
                case 'a' -> sb.append('\u0007');
                case 'e' -> sb.append('\u001B');
                case 'b' -> sb.append('\b');
                case 'u', 'x' -> {
                    int len = d == 'u' ? 4 : 2;
                    if (i + len >= n) throw new IllegalArgumentException("Insufficient hex digits");
                    sb.append((char) Integer.parseInt(s.substring(i + 1, i + 1 + len), 16));
                    i += len;
                }
                case '0', '1', '2', '3', '4', '5', '6', '7' -> {
                    int v = 0, k = 0;
                    while (k < 3 && i < n && s.charAt(i) >= '0' && s.charAt(i) <= '7') {
                        v = v * 8 + (s.charAt(i) - '0');
                        i++;
                        k++;
                    }
                    i--;
                    sb.append((char) (v & 0xFF));
                }
                default -> sb.append(d);
            }
        }
        return sb.toString();
    }

    private static final Pattern MD_TARGET_RX = Pattern.compile("^\\[[^\\]]*\\]\\((.+)\\)$", Pattern.UNIX_LINES);
    private static final Pattern URL_RX = Pattern.compile("^[a-zA-Z][a-zA-Z0-9+.-]*://");

    /** Strips banner syntax ("![[a.jpg]]", "[[a.jpg|x]]", "[t](a.jpg)") down to the file; null for web URLs. */
    public static String cleanTarget(String raw) {
        String s = Compat.trim(Compat.trimChars(Compat.trim(raw), "\"'"));
        if (s.startsWith("!")) s = s.substring(1);
        if (s.startsWith("[[") && s.endsWith("]]")) s = s.substring(2, s.length() - 2);
        else {
            Matcher md = MD_TARGET_RX.matcher(s);
            if (md.find()) s = Compat.trimChars(md.group(1), "<>");
        }
        s = Compat.trim(Compat.before(Compat.before(s, '|'), '#'));
        if (s.isEmpty() || URL_RX.matcher(s).find()) return null;
        return s;
    }

    public void saveSoon(String wsId) {
        synchronized (gate) {
            if (!dirty.contains(wsId)) return;
            if (timer == null) {
                timer = Executors.newSingleThreadScheduledExecutor(r -> {
                    Thread t = new Thread(r, "mn-index-save");
                    t.setDaemon(true);
                    return t;
                });
            }
            if (pending != null) pending.cancel(false);
            pending = timer.schedule(this::flush, 1500, TimeUnit.MILLISECONDS);
        }
    }

    public void flush() {
        List<String[]> work = new ArrayList<>();
        synchronized (gate) {
            for (String id : dirty) {
                CiMap<Entry> d = ws.get(id);
                if (d == null) continue;
                Map<String, Object> o = new LinkedHashMap<>();
                for (Map.Entry<String, Entry> kv : d.entrySet()) o.put(kv.getKey(), kv.getValue().toJson());
                work.add(new String[] {id, Json.write(o)});
            }
            dirty.clear();
        }
        for (String[] w : work) {
            try {
                if (!dir.isDirectory()) PathUtil.mkdirs(dir.getPath());
                File f = fileFor(w[0]);
                File tmp = new File(f.getPath() + "." + Compat.hex6() + ".tmp");
                Files.write(tmp.toPath(), w[1].getBytes(StandardCharsets.UTF_8));
                Files.move(tmp.toPath(), f.toPath(), StandardCopyOption.REPLACE_EXISTING);
            } catch (Exception ex) {
                Log.error("NoteIndex.Flush", ex);
            }
        }
    }

    public void forget(String wsId) {
        synchronized (gate) {
            ws.remove(wsId);
            dirty.remove(wsId);
        }
        try {
            Files.deleteIfExists(fileFor(wsId).toPath());
        } catch (Exception ignored) {
        }
    }

    /** Every workspace's entries, in memory and on disk. */
    public void forgetAll() {
        synchronized (gate) {
            ws.clear();
            dirty.clear();
        }
        File[] files = dir.listFiles();
        if (files == null) return;
        for (File f : files) {
            if (f.isFile() && f.getName().endsWith(".json")) {
                try {
                    Files.deleteIfExists(f.toPath());
                } catch (Exception ignored) {
                }
            }
        }
    }
}

package com.marknotes.core;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ThreadLocalRandom;

/**
 * MarkNotes' trash on the phone. Every deleted note, folder, picture or workspace waits in an entry of its own,
 * {@code Trash/<entry>/<name>}, next to {@code Trash/<entry>/.trashinfo.json} (where it was, when, and whether this phone
 * or a sync with a PC deleted it), until the user restores it or deletes it for good (Settings › Trash). Nothing is
 * emptied by date unless the user turned that on.
 *
 * <p>Item ids are {@code <entry>/<name>}. Entries made by MarkNotes for Android 1.0 have no info file (and may hold more
 * than one item): they are listed with their date and put back into a workspace the user picks.
 */
public final class Trash {
    static final String INFO = ".trashinfo.json";
    private static final String STAMP = "yyyyMMdd-HHmmss-SSS";

    private final File dir;
    private final File notesRoot;
    private final Object gate = new Object();

    public Trash(File dir, File notesRoot) {
        this.dir = dir;
        this.notesRoot = notesRoot;
    }

    public File dir() { return dir; }

    // ─────────────────────────── deleting ───────────────────────────

    /**
     * Moves {@code f} into the trash. {@code by}: "phone" (deleted in this app) or "sync" (it was deleted on the PC
     * named {@code pc}, and a sync removed it here). Returns the item's id, or null when {@code f} was already gone.
     */
    public String put(File f, String by, String pc) throws IOException {
        if (!f.exists()) return null;
        synchronized (gate) {
            long now = System.currentTimeMillis();
            String stamp = new SimpleDateFormat(STAMP, Locale.ROOT).format(new Date(now));
            File entry;
            do {
                entry = new File(dir, stamp + "-" + String.format(Locale.ROOT, "%04x", ThreadLocalRandom.current().nextInt(0x10000)));
            } while (entry.exists());
            if (!entry.mkdirs()) throw new IOException("Can't create " + entry);
            String from = relative(f);
            boolean isDir = f.isDirectory();
            long size = sizeOf(f, 0);
            long notes = isDir ? countNotes(f, 0) : 0;
            String ws = from == null ? null : workspaceName(from);
            File to = new File(entry, f.getName());
            try {
                Files.move(f.toPath(), to.toPath());
            } catch (IOException e) {
                entry.delete();
                throw new IOException("Can't move to MarkNotes' trash: " + f, e);
            }
            Map<String, Object> info = Json.obj("name", f.getName(), "from", from, "ws", ws, "at", now,
                    "by", by == null ? "phone" : by, "pc", pc, "dir", isDir, "size", size, "notes", notes);
            try {
                AppCommands.writeText(new File(entry, INFO), Json.pretty(info));
            } catch (IOException e) {
                Log.error("Trash: could not write " + entry + "/" + INFO, e);
            }
            return entry.getName() + "/" + f.getName();
        }
    }

    // ─────────────────────────── listing ───────────────────────────

    /** Everything in the trash, newest first. */
    public List<Map<String, Object>> list() {
        List<Map<String, Object>> out = new ArrayList<>();
        synchronized (gate) {
            File[] entries = dir.listFiles();
            if (entries == null) return out;
            for (File e : entries) {
                if (!e.isDirectory()) continue;
                Map<String, Object> info = readInfo(e);
                File[] kids = items(e);
                for (File k : kids) {
                    boolean own = owns(info, kids, k);
                    boolean isDir = k.isDirectory();
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("id", e.getName() + "/" + k.getName());
                    m.put("name", k.getName());
                    m.put("from", own ? info.get("from") : null);
                    m.put("ws", own ? info.get("ws") : null);
                    m.put("at", own ? Json.getLong(info, "at", entryTime(e)) : entryTime(e));
                    m.put("by", own ? Json.getString(info, "by", "phone") : "phone");
                    m.put("pc", own ? info.get("pc") : null);
                    m.put("dir", isDir);
                    m.put("kind", kind(k));
                    m.put("size", own && info.get("size") instanceof Number ? (Object) Json.getLong(info, "size", 0) : (Object) sizeOf(k, 0));
                    m.put("notes", isDir ? (own && info.get("notes") instanceof Number ? Json.getLong(info, "notes", 0) : (long) countNotes(k, 0)) : 0L);
                    out.add(m);
                }
            }
        }
        Collections.sort(out, (a, b) -> Long.compare(Json.getLong(b, "at", 0), Json.getLong(a, "at", 0)));
        return out;
    }

    // ─────────────────────────── restoring ───────────────────────────

    /**
     * Puts an item back where it was (the folders around it are made again if they are gone). If something else has
     * that name now, the restored one is called "<name> (restored)". Items without a known place (MarkNotes for
     * Android 1.0) go into {@code fallbackDir}, the workspace the user has open. Returns where it went.
     */
    public Map<String, Object> restore(String id, File fallbackDir) throws IOException {
        synchronized (gate) {
            File[] ek = resolve(id);
            File entry = ek[0], item = ek[1];
            Map<String, Object> info = readInfo(entry);
            boolean own = owns(info, items(entry), item);
            boolean isDir = item.isDirectory();
            String from = own ? Json.getString(info, "from", null) : null;
            File target;
            if (from != null && !from.isEmpty()) {
                target = new File(notesRoot, from.replace('/', File.separatorChar));
            } else if (isDir && new File(item, ".workspace.json").isFile()) {
                target = new File(notesRoot, item.getName());
            } else {
                if (fallbackDir == null) {
                    throw new IOException(Lang.t("Open a workspace first: “" + item.getName() + "” is put back there.",
                            "Primero abre un espacio de trabajo: “" + item.getName() + "” se restaura ahí."));
                }
                target = new File(fallbackDir, item.getName());
            }
            if (!inside(target)) throw new IOException("Not inside the notes folder: " + target);
            File parent = target.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("Can't create " + parent);
            target = free(target, isDir);
            Files.move(item.toPath(), target.toPath());
            if (items(entry).length == 0) deleteTree(entry);
            String rel = relative(target);
            return Json.obj("id", id, "name", target.getName(), "path", rel, "ws", rel == null ? null : workspaceName(rel),
                    "renamed", !target.getName().equals(item.getName()), "dir", isDir);
        }
    }

    // ─────────────────────────── deleting for good ───────────────────────────

    public void delete(String id) throws IOException {
        synchronized (gate) {
            File[] ek = resolve(id);
            deleteTree(ek[1]);
            if (ek[1].exists()) throw new IOException("Could not delete " + ek[1].getName());
            if (items(ek[0]).length == 0) deleteTree(ek[0]);
        }
    }

    /** Deletes everything in the trash for good. Returns how many items went. */
    public int empty() {
        int n = 0;
        synchronized (gate) {
            File[] entries = dir.listFiles();
            if (entries == null) return 0;
            for (File e : entries) {
                if (!e.isDirectory()) continue;
                n += items(e).length;
                deleteTree(e);
            }
        }
        return n;
    }

    /** Deletes for good what was deleted more than {@code days} days ago (only when the user asked for it). */
    public int emptyOlderThan(int days) {
        if (days <= 0) return 0;
        long cutoff = System.currentTimeMillis() - days * 24L * 3600 * 1000;
        int n = 0;
        synchronized (gate) {
            File[] entries = dir.listFiles();
            if (entries == null) return 0;
            for (File e : entries) {
                if (!e.isDirectory()) continue;
                Map<String, Object> info = readInfo(e);
                long at = info != null ? Json.getLong(info, "at", entryTime(e)) : entryTime(e);
                if (at >= cutoff) continue;
                n += items(e).length;
                deleteTree(e);
            }
        }
        return n;
    }

    // ─────────────────────────── helpers ───────────────────────────

    private static File[] items(File entry) {
        File[] kids = entry.listFiles((d, n) -> !n.equals(INFO) && !n.endsWith(".tmp"));
        return kids == null ? new File[0] : kids;
    }

    /** The info file describes {@code item} (new entries hold one item each). */
    private static boolean owns(Map<String, Object> info, File[] kids, File item) {
        return info != null && kids.length == 1 && item.getName().equals(Json.getString(info, "name", ""));
    }

    private File[] resolve(String id) throws IOException {
        int slash = id == null ? -1 : id.indexOf('/');
        if (slash <= 0 || slash == id.length() - 1) throw new IllegalArgumentException("Bad trash id: " + id);
        String e = id.substring(0, slash), n = id.substring(slash + 1);
        if (e.contains("..") || e.contains("\\") || n.contains("/") || n.contains("\\") || n.equals("..") || n.equals(".") || e.startsWith(".")) {
            throw new IllegalArgumentException("Bad trash id: " + id);
        }
        File entry = new File(dir, e), item = new File(entry, n);
        if (!item.exists() || n.equals(INFO)) {
            throw new IOException(Lang.t("“" + n + "” is no longer in the trash.", "“" + n + "” ya no está en la papelera."));
        }
        return new File[] {entry, item};
    }

    /** Path of {@code f} inside the notes folder, with '/', or null when it is somewhere else. */
    private String relative(File f) {
        try {
            String r = notesRoot.getCanonicalPath(), p = f.getCanonicalPath();
            if (p.startsWith(r + File.separator)) return p.substring(r.length() + 1).replace(File.separatorChar, '/');
        } catch (IOException ignored) {
        }
        return null;
    }

    private boolean inside(File f) {
        try {
            return f.getCanonicalPath().startsWith(notesRoot.getCanonicalPath() + File.separator);
        } catch (IOException e) {
            return false;
        }
    }

    /** The name of the workspace a path is in (its .workspace.json), else its folder's name. */
    private String workspaceName(String rel) {
        String top = rel.contains("/") ? rel.substring(0, rel.indexOf('/')) : rel;
        File meta = new File(new File(notesRoot, top), ".workspace.json");
        if (meta.isFile()) {
            try {
                String name = Json.getString(Json.parseObject(AppCommands.readText(meta)), "name", null);
                if (name != null && !name.trim().isEmpty()) return name;
            } catch (IOException | RuntimeException ignored) {
            }
        }
        return top;
    }

    /** {@code target}, or "<name> (restored)", "<name> (restored 2)"… when something else has its name now. */
    private static File free(File target, boolean isDir) {
        if (!target.exists()) return target;
        String name = target.getName();
        int dot = isDir ? -1 : name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name, ext = dot > 0 ? name.substring(dot) : "";
        File parent = target.getParentFile();
        for (int n = 1; ; n++) {
            File f = new File(parent, stem + (n == 1 ? " (restored)" : " (restored " + n + ")") + ext);
            if (!f.exists()) return f;
        }
    }

    private static Map<String, Object> readInfo(File entry) {
        File f = new File(entry, INFO);
        if (!f.isFile()) return null;
        try {
            return Json.parseObject(AppCommands.readText(f));
        } catch (IOException | RuntimeException e) {
            return null;
        }
    }

    /** When an entry was made: from its name (yyyyMMdd-HHmmss-SSS…), else its folder's date. */
    private static long entryTime(File entry) {
        String n = entry.getName();
        if (n.length() >= STAMP.length()) {
            try {
                Date d = new SimpleDateFormat(STAMP, Locale.ROOT).parse(n.substring(0, STAMP.length()));
                if (d != null) return d.getTime();
            } catch (ParseException ignored) {
            }
        }
        return entry.lastModified();
    }

    private static String kind(File f) {
        if (f.isDirectory()) return new File(f, ".workspace.json").isFile() ? "workspace" : "folder";
        String n = f.getName().toLowerCase(Locale.ROOT);
        if (n.endsWith(".md") || n.endsWith(".markdown") || n.endsWith(".txt")) return "note";
        if (n.endsWith(".canvas")) return "canvas";
        if (n.matches(".*\\.(png|jpe?g|gif|webp|bmp|svg|avif)$")) return "image";
        if (n.matches(".*\\.(mp4|webm|mov|m4v|mkv)$")) return "video";
        return "file";
    }

    private static long sizeOf(File f, int depth) {
        if (f.isFile()) return f.length();
        File[] kids = depth > 32 ? null : f.listFiles();
        long n = 0;
        if (kids != null) for (File k : kids) n += sizeOf(k, depth + 1);
        return n;
    }

    /** Notes in a folder (.md, .markdown, .txt, .canvas outside hidden folders). */
    private static int countNotes(File dir, int depth) {
        File[] items = depth > 32 ? null : dir.listFiles();
        if (items == null) return 0;
        int n = 0;
        for (File f : items) {
            String name = f.getName();
            if (name.startsWith(".")) continue;
            if (f.isDirectory()) n += countNotes(f, depth + 1);
            else {
                String l = name.toLowerCase(Locale.ROOT);
                if (l.endsWith(".md") || l.endsWith(".markdown") || l.endsWith(".txt") || l.endsWith(".canvas")) n++;
            }
        }
        return n;
    }

    private static void deleteTree(File f) {
        File[] kids = f.isDirectory() ? f.listFiles() : null;
        if (kids != null) for (File k : kids) deleteTree(k);
        if (f.exists() && !f.delete()) Log.info("Trash: could not remove " + f);
    }
}

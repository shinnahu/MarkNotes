package com.marknotes.core.sync;

import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

import com.marknotes.core.Json;
import com.marknotes.core.Lang;
import com.marknotes.core.Log;

/**
 * Two-way sync of workspaces between this phone and one PC (PROTOCOL.md §6). The PC only lists, sends and stores; every
 * decision is made here from three states per path: the phone's now, the PC's now, and both as they were after the
 * last sync. Nothing is overwritten without a copy, and deletions are recoverable on both sides.
 */
public final class SyncEngine {
    static final String META = ".workspace.json";

    public interface Progress {
        void onProgress(String wsName, int done, int total, String path);
    }

    /** Summary of one run, for the UI. */
    public static final class Result {
        public int uploaded, downloaded, deletedHere, deletedOnPc, conflicts, skipped;
        /** Undo: put back where they were / written next to a newer version as "(before sync)". */
        public int restored, copies;
        public final List<String> notes = new ArrayList<>();
        public final Set<String> changedHere = new LinkedHashSet<>();
        /** Workspaces whose deletions wait for the user's OK: wsId → {name, here, onPc}. */
        public final Map<String, Object> confirm = new LinkedHashMap<>();
        /** Runs whose old versions the PC was told to drop. */
        public final List<String> forgotten = new ArrayList<>();

        public Map<String, Object> toJson() {
            return Json.obj("uploaded", (long) uploaded, "downloaded", (long) downloaded, "deletedHere", (long) deletedHere,
                    "deletedOnPc", (long) deletedOnPc, "conflicts", (long) conflicts, "skipped", (long) skipped,
                    "restored", (long) restored, "copies", (long) copies,
                    "notes", new ArrayList<Object>(notes), "changed", new ArrayList<Object>(changedHere), "confirm", confirm);
        }
    }

    private final SyncState state;
    private final LocalStore store;
    private final String deviceName;
    private final Progress progress;
    private final SyncHistory history;

    public SyncEngine(SyncState state, LocalStore store, String deviceName, Progress progress, SyncHistory history) {
        this.state = state;
        this.store = store;
        this.deviceName = deviceName;
        this.progress = progress;
        this.history = history;
    }

    static boolean hasFeature(Map<String, Object> info, String feature) {
        for (Object f : Json.getList(info, "features")) if (feature.equals(f)) return true;
        return false;
    }

    // ─────────────────────────── entries ───────────────────────────

    /** A file as listed now (one side). */
    static final class Entry {
        final String p;
        final long s, m;
        final String h;

        Entry(String p, long s, long m, String h) {
            this.p = p;
            this.s = s;
            this.m = m;
            this.h = h;
        }
    }

    static String key(String p) { return p.toLowerCase(Locale.ROOT); }

    private static boolean eq(String a, String b) { return a == null ? b == null : a.equals(b); }

    // ─────────────────────────── the phone's files ───────────────────────────

    private static final class Listing {
        final Map<String, Entry> files = new HashMap<>();
        final Map<String, String> dirs = new HashMap<>();
    }

    private Listing listLocal(String wsId, File root, Map<String, long[]> sizes, Map<String, String> hashes) {
        Listing out = new Listing();
        walk(root, "", 0, out, sizes, hashes);
        return out;
    }

    private void walk(File dir, String rel, int depth, Listing out, Map<String, long[]> sizes, Map<String, String> hashes) {
        File[] items = dir.listFiles();
        if (items == null) return;
        for (File f : items) {
            String name = f.getName();
            String r = rel.isEmpty() ? name : rel + "/" + name;
            try {
                if (Files.isSymbolicLink(f.toPath())) continue;
            } catch (RuntimeException e) {
                continue;
            }
            if (f.isDirectory()) {
                if (depth >= 32 || !SyncRules.isSynced(r, true) || !SyncRules.windowsSafe(r)) continue;
                out.dirs.put(key(r), r);
                walk(f, r, depth + 1, out, sizes, hashes);
            } else if (f.isFile()) {
                if (!SyncRules.isSynced(r, false)) continue;
                if (!SyncRules.windowsSafe(r)) {
                    Log.info("Sync: not sent, the PC can't store this name: " + r);
                    continue;
                }
                try {
                    out.files.put(key(r), new Entry(r, f.length(), f.lastModified(), hashOf(f, key(r), sizes, hashes)));
                } catch (IOException e) {
                    Log.info("Sync: skipped " + r + ": " + e.getMessage());
                }
            }
        }
    }

    /** SHA-256 of a file, from the cache while its size and date are the same. */
    static String hashOf(File f, String k, Map<String, long[]> sizes, Map<String, String> hashes) throws IOException {
        long s = f.length(), m = f.lastModified();
        long[] c = sizes.get(k);
        String h = hashes.get(k);
        if (c != null && h != null && c[0] == s && c[1] == m) return h;
        h = hashFile(f);
        sizes.put(k, new long[] {s, m});
        hashes.put(k, h);
        return h;
    }

    static String hashFile(File f) throws IOException {
        MessageDigest md = SyncClient.sha();
        byte[] buf = new byte[1 << 16];
        try (InputStream in = new FileInputStream(f)) {
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
        }
        return Bytes.hex(md.digest());
    }

    private static byte[] readAll(File f) throws IOException {
        try (InputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream o = new ByteArrayOutputStream((int) Math.max(16, f.length()));
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) o.write(buf, 0, n);
            return o.toByteArray();
        }
    }

    private static File fileOf(File root, String p) { return new File(root, p.replace('/', File.separatorChar)); }

    // ─────────────────────────── run ───────────────────────────

    /**
     * Syncs every workspace chosen for this PC. {@code allowDeletes}: workspace ids whose big deletions the user
     * confirmed. What changes is written into {@code journal} (versions it replaces are kept, on both sides).
     */
    public Result run(PairedPc pc, Set<String> allowDeletes, SyncJournal journal) throws IOException {
        Result res = new Result();
        try (SyncClient c = SyncClient.connect(pc, deviceName)) {
            pc.lastAddress = c.address();
            pc.addAddress(c.address());
            Map<String, Object> info = c.request(Json.obj("op", "info"));
            Map<String, Object> host = Json.getMap(info, "host");
            if (host != null) pc.name = Json.getString(host, "name", pc.name);
            for (Object a : Json.getList(info, "addresses")) if (a instanceof String && !pc.addresses.contains(a)) pc.addresses.add((String) a);
            journal.pc = pc.name;
            journal.pcKeeps = hasFeature(info, "history");
            if (journal.pcKeeps) {
                c.run = journal.run;
                // Old versions of runs this phone no longer lists (deleted from its history) go on the PC too.
                if (!pc.pendingForget.isEmpty()) {
                    List<Object> runs = new ArrayList<Object>(pc.pendingForget);
                    try {
                        c.request(Json.obj("op", "forget", "runs", runs));
                        for (Object r : runs) res.forgotten.add((String) r);
                    } catch (SyncClient.Refused e) {
                        Log.info("Sync forget: " + e.getMessage());
                    }
                }
            }

            Map<String, Map<String, Object>> remote = new LinkedHashMap<>();
            for (Object o : Json.getList(info, "workspaces")) {
                @SuppressWarnings("unchecked") Map<String, Object> w = (Map<String, Object>) o;
                remote.put(Json.getString(w, "id", ""), w);
            }
            Map<String, LocalStore.Ws> local = new LinkedHashMap<>();
            for (LocalStore.Ws w : store.workspaces()) local.put(w.id, w);

            Set<String> changedOnPc = new LinkedHashSet<>();
            for (String wsId : new ArrayList<>(pc.workspaces)) {
                Map<String, Object> rw = remote.get(wsId);
                LocalStore.Ws lw = local.get(wsId);
                boolean known = state.hasBase(pc.hostId, wsId);
                if (rw == null && lw == null) continue;
                if (rw == null) {
                    if (known) {
                        // Deleted or closed on the PC: it stays on this phone, and it isn't sent back.
                        pc.workspaces.remove(wsId);
                        state.dropBase(pc.hostId, wsId);
                        res.notes.add(Lang.t("“" + lw.name + "” is no longer on " + pc.name + "; it stays on this phone.",
                                "“" + lw.name + "” ya no está en " + pc.name + "; queda en este teléfono."));
                        continue;
                    }
                    File metaFile = new File(lw.dir, META);
                    byte[] meta = metaFile.isFile() ? readAll(metaFile) : Json.pretty(Json.obj("id", wsId, "name", lw.name)).getBytes(StandardCharsets.UTF_8);
                    c.request(Json.obj("op", "createWs", "ws", wsId, "dir", lw.dir.getName(),
                            "meta", java.util.Base64.getEncoder().encodeToString(meta)));
                    changedOnPc.add(wsId);
                } else if (lw == null) {
                    if (known) {
                        // Deleted on this phone: not brought back.
                        pc.workspaces.remove(wsId);
                        state.dropBase(pc.hostId, wsId);
                        continue;
                    }
                    ByteArrayOutputStream meta = new ByteArrayOutputStream();
                    c.get(wsId, META, meta);
                    dropEmptyTwin(pc, Json.getString(rw, "name", ""), local, res);
                    File dir = store.adoptWorkspace(Json.getString(rw, "dir", Json.getString(rw, "name", "Workspace")), meta.toByteArray());
                    lw = new LocalStore.Ws(wsId, Json.getString(rw, "name", dir.getName()), dir);
                    local.put(wsId, lw);
                    res.changedHere.add(wsId);
                }
                syncWorkspace(c, pc, lw, allowDeletes != null && allowDeletes.contains(wsId), res, changedOnPc, journal);
            }
            List<Object> changed = new ArrayList<Object>(changedOnPc);
            c.request(Json.obj("op", "done", "changed", changed));
            c.bye();
            pc.lastSync = System.currentTimeMillis();
            pc.lastError = "";
        } finally {
            for (String id : res.changedHere) store.reload(id);
        }
        return res;
    }

    // ─────────────────────────── undo ───────────────────────────

    /**
     * Undoes a run (PROTOCOL.md §7). What it deleted or replaced comes back, on this phone and on the PC; what is there
     * now is kept first, under {@code u}, so the undo can be undone too. A file changed since the run keeps its newer
     * content and gets the old version next to it as "&lt;name&gt; (before sync).ext". What the run only added stays.
     * Afterwards a normal sync, recorded in {@code u} as well, makes both sides match. Items already put back by an
     * earlier, interrupted undo are marked in {@code done} and skipped.
     */
    public Result undo(PairedPc pc, SyncJournal done, SyncJournal u) throws IOException {
        Result res = new Result();
        Map<String, LocalStore.Ws> local = new LinkedHashMap<>();
        for (LocalStore.Ws w : store.workspaces()) local.put(w.id, w);
        Set<String> changedOnPc = new LinkedHashSet<>();
        try (SyncClient c = SyncClient.connect(pc, deviceName)) {
            pc.lastAddress = c.address();
            pc.addAddress(c.address());
            Map<String, Object> info = c.request(Json.obj("op", "info"));
            u.pcKeeps = hasFeature(info, "history");
            boolean pcCan = done.pcKeeps && u.pcKeeps;
            List<Map<String, Object>> items = new ArrayList<>(done.items);
            Collections.reverse(items);
            for (Map<String, Object> it : items) {
                if (!SyncJournal.undoableKind(it) || it.containsKey("undoneBy")) continue;
                String side = Json.getString(it, "side", ""), kind = Json.getString(it, "kind", "");
                String wsId = Json.getString(it, "ws", ""), p = Json.getString(it, "p", "");
                LocalStore.Ws ws = local.get(wsId);
                String wsName = ws != null ? ws.name : Json.getString(it, "wsName", "");
                String name = p.contains("/") ? p.substring(p.lastIndexOf('/') + 1) : p;
                try {
                    if (side.equals("here") && kind.equals("deleted")) {
                        File back = store.restoreFromTrash(Json.getString(it, "trash", null));
                        if (back == null) {
                            res.skipped++;
                            res.notes.add(Lang.t("“" + name + "” is no longer in the Trash.", "“" + name + "” ya no está en la papelera."));
                            continue;
                        }
                        res.restored++;
                        res.changedHere.add(wsId);
                        u.add("here", "added", wsId, wsName, ws != null ? rel(ws.dir, back) : p, null, null, null);
                    } else if (side.equals("here")) {
                        File kept = history.kept(done.hostId, done.run, wsId, p);
                        if (ws == null || !kept.isFile()) {
                            res.skipped++;
                            res.notes.add(Lang.t("The old version of “" + name + "” is no longer kept.", "La versión anterior de “" + name + "” ya no se guarda."));
                            continue;
                        }
                        File target = fileOf(ws.dir, p);
                        String now = target.isFile() ? hashFile(target) : null;
                        if (now == null || now.equals(Json.getString(it, "new", null))) {
                            if (now != null) history.keep(u.hostId, u.run, wsId, p, target);
                            place(kept, target);
                            u.add("here", now == null ? "added" : "replaced", wsId, wsName, p, now, Json.getString(it, "old", null), null);
                            res.restored++;
                        } else {
                            File copy = beside(target);
                            place(kept, copy);
                            u.add("here", "added", wsId, wsName, rel(ws.dir, copy), null, null, null);
                            res.copies++;
                        }
                        res.changedHere.add(wsId);
                    } else if (side.equals("pc")) {
                        if (!pcCan) {
                            res.skipped++;
                            continue;
                        }
                        boolean replaced = kind.equals("replaced");
                        Map<String, Object> r = c.request(Json.obj("op", "restore", "run", done.run, "ws", wsId, "p", p,
                                "expect", replaced ? Json.getString(it, "new", null) : null, "undo", u.run));
                        String at = Json.getString(r, "p", p);
                        if (at.equals(p)) {
                            res.restored++;
                            u.add("pc", replaced ? "replaced" : "added", wsId, wsName, p, replaced ? Json.getString(it, "new", null) : null,
                                    Json.getString(r, "h", null), null);
                        } else {
                            res.copies++;
                            u.add("pc", "added", wsId, wsName, at, null, Json.getString(r, "h", null), null);
                        }
                        changedOnPc.add(wsId);
                    } else continue;
                    it.put("undoneBy", u.run);
                } catch (SyncClient.Refused e) {
                    res.skipped++;
                    Log.info("Undo " + side + " " + p + ": " + e.code + " " + e.getMessage());
                    res.notes.add(Lang.t("“" + name + "” could not be put back: " + e.getMessage(), "No se pudo restaurar “" + name + "”: " + e.getMessage()));
                }
            }
            c.request(Json.obj("op", "done", "changed", new ArrayList<Object>(changedOnPc)));
            c.bye();
        } finally {
            for (String id : res.changedHere) store.reload(id);
        }
        // Both sides match again with a normal sync, recorded in the same undo run.
        Result after = run(pc, null, u);
        res.uploaded += after.uploaded;
        res.downloaded += after.downloaded;
        res.deletedHere += after.deletedHere;
        res.deletedOnPc += after.deletedOnPc;
        res.conflicts += after.conflicts;
        res.skipped += after.skipped;
        res.notes.addAll(after.notes);
        res.changedHere.addAll(after.changedHere);
        res.confirm.putAll(after.confirm);
        res.forgotten.addAll(after.forgotten);
        return res;
    }

    /** Puts a kept version in place (through a temp file in the same folder, so it is never half written). */
    private static void place(File kept, File target) throws IOException {
        File dir = target.getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new IOException("Can't create " + dir);
        File tmp = new File(dir, "." + target.getName() + "." + Bytes.hex(Crypto.random(4)) + ".mnsync-tmp");
        try {
            Files.copy(kept.toPath(), tmp.toPath(), StandardCopyOption.REPLACE_EXISTING);
            tmp.setLastModified(kept.lastModified());
            try {
                Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException e) {
                Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            if (tmp.exists() && !tmp.delete()) tmp.deleteOnExit();
        }
    }

    /** "&lt;name&gt; (before sync).ext" next to {@code target} (" (before sync 2)"… when taken). */
    private static File beside(File target) {
        String name = target.getName();
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name, ext = dot > 0 ? name.substring(dot) : "";
        for (int n = 1; ; n++) {
            File f = new File(target.getParentFile(), stem + (n == 1 ? " (before sync)" : " (before sync " + n + ")") + ext);
            if (!f.exists()) return f;
        }
    }

    private static String rel(File root, File f) {
        String r = root.getAbsolutePath(), p = f.getAbsolutePath();
        return p.startsWith(r + File.separator) ? p.substring(r.length() + 1).replace(File.separatorChar, '/') : f.getName();
    }

    /** Notes in a workspace folder (.md, .markdown, .txt, .canvas outside hidden folders). */
    static int countNotes(File dir, int depth) {
        File[] items = dir.listFiles();
        if (items == null || depth > 32) return 0;
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

    /**
     * A PC workspace comes to the phone while the phone has an empty one of the same name that was never synced (the
     * "Personal" made on first start): the empty one goes to MarkNotes' trash, so the phone doesn't show two.
     */
    private void dropEmptyTwin(PairedPc pc, String name, Map<String, LocalStore.Ws> local, Result res) {
        if (name == null || name.trim().isEmpty()) return;
        for (LocalStore.Ws w : new ArrayList<>(local.values())) {
            if (!w.name.trim().equalsIgnoreCase(name.trim()) || pc.workspaces.contains(w.id) || state.hasBase(pc.hostId, w.id)) continue;
            if (countNotes(w.dir, 0) > 0) continue;
            try {
                store.trashFromSync(w.dir, pc.name);
                local.remove(w.id);
                res.changedHere.add(w.id);
                Log.info("Sync: replaced the empty workspace " + w.name + " with the PC's");
            } catch (IOException e) {
                Log.info("Sync: could not remove the empty " + w.name + ": " + e.getMessage());
            }
        }
    }

    // ─────────────────────────── one workspace ───────────────────────────

    private static final class Op {
        final String kind; // get, put, delHere, delPc, conflict, merge, record
        final String k;

        Op(String kind, String k) {
            this.kind = kind;
            this.k = k;
        }
    }

    private void syncWorkspace(SyncClient c, PairedPc pc, LocalStore.Ws ws, boolean allowDeletes, Result res, Set<String> changedOnPc,
                               SyncJournal j) throws IOException {
        String wsId = ws.id;
        progress.onProgress(ws.name, 0, 0, "");
        SyncState.Base base = state.loadBase(pc.hostId, wsId);
        Map<String, long[]> sizes = new HashMap<>();
        Map<String, String> hashes = new HashMap<>();
        state.loadHashes(wsId, sizes, hashes);

        // The PC's listing.
        Map<String, Entry> remote = new HashMap<>();
        Map<String, String> remoteDirs = new HashMap<>();
        Map<String, Object> man = c.request(Json.obj("op", "manifest", "ws", wsId));
        for (Object o : Json.getList(man, "entries")) {
            @SuppressWarnings("unchecked") Map<String, Object> e = (Map<String, Object>) o;
            String p = Json.getString(e, "p", "");
            if (p.isEmpty() || p.startsWith("/") || p.contains("\\") || p.contains("..")) continue;
            if (Json.getBool(e, "d", false)) remoteDirs.put(key(p), p);
            else remote.put(key(p), new Entry(p, Json.getLong(e, "s", 0), Json.getLong(e, "m", 0), Json.getString(e, "h", "")));
        }
        // The phone's.
        Listing localL = listLocal(wsId, ws.dir, sizes, hashes);
        Map<String, Entry> local = localL.files;

        // ── decide ──
        Set<String> keys = new TreeSet<>();
        keys.addAll(remote.keySet());
        keys.addAll(local.keySet());
        keys.addAll(base.files.keySet());
        List<Op> ops = new ArrayList<>();
        int delHere = 0, delPc = 0;
        for (String k : keys) {
            Entry r = remote.get(k), l = local.get(k);
            SyncState.BaseEntry b = base.files.get(k);
            String rh = r == null ? null : r.h, lh = l == null ? null : l.h;
            if (lh != null && lh.equals(rh)) { ops.add(new Op("record", k)); continue; }
            if (b == null) {
                if (lh == null && rh == null) continue;
                if (lh == null) ops.add(new Op("get", k));
                else if (rh == null) ops.add(new Op("put", k));
                else ops.add(new Op(k.equals(META) ? "merge" : "conflict", k));
                continue;
            }
            boolean localChanged = !eq(lh, b.l), remoteChanged = !eq(rh, b.r);
            if (!localChanged && !remoteChanged) continue; // same as last time (each side may store it its own way)
            if (!localChanged) {
                if (rh == null) { ops.add(new Op("delHere", k)); delHere++; }
                else ops.add(new Op("get", k));
            } else if (!remoteChanged) {
                if (lh == null) { ops.add(new Op("delPc", k)); delPc++; }
                else ops.add(new Op("put", k));
            } else {
                if (lh == null && rh == null) ops.add(new Op("forget", k));
                else if (lh == null) ops.add(new Op("get", k));        // an edit wins over a deletion
                else if (rh == null) ops.add(new Op("put", k));
                else ops.add(new Op(k.equals(META) ? "merge" : "conflict", k));
            }
        }

        // Big deletions wait for the user's OK.
        boolean holdDeletes = false;
        if (!allowDeletes && ((delPc > 20 && delPc * 3 > Math.max(1, remote.size())) || (delHere > 20 && delHere * 3 > Math.max(1, local.size())))) {
            holdDeletes = true;
            res.confirm.put(wsId, Json.obj("name", ws.name, "here", (long) delHere, "onPc", (long) delPc, "pc", pc.name));
        }

        // Workspace settings first, so the rest lands in a workspace that knows its folders.
        Collections.sort(ops, (a, b2) -> (b2.k.equals(META) ? 1 : 0) - (a.k.equals(META) ? 1 : 0));

        // ── folders the other side made ──
        for (Map.Entry<String, String> d : remoteDirs.entrySet()) {
            if (localL.dirs.containsKey(d.getKey()) || base.dirs.containsKey(d.getKey())) continue;
            File f = fileOf(ws.dir, d.getValue());
            if (f.mkdirs()) res.changedHere.add(wsId);
        }
        // Folders on the PC as they will be after this sync (made here, removed below).
        Map<String, String> pcDirs = new HashMap<>(remoteDirs);
        for (Map.Entry<String, String> d : localL.dirs.entrySet()) {
            if (remoteDirs.containsKey(d.getKey()) || base.dirs.containsKey(d.getKey())) continue;
            try {
                c.request(Json.obj("op", "mkdir", "ws", wsId, "p", d.getValue()));
                pcDirs.put(d.getKey(), d.getValue());
                changedOnPc.add(wsId);
            } catch (SyncClient.Refused e) {
                Log.info("Sync mkdir " + d.getValue() + ": " + e.getMessage());
            }
        }

        // ── files ──
        int total = 0;
        for (Op op : ops) if (!op.kind.equals("record") && !op.kind.equals("forget")) total++;
        int done = 0;
        SyncState.Base next = new SyncState.Base();
        next.meta = base.meta;
        for (Op op : ops) {
            String k = op.k;
            Entry r = remote.get(k), l = local.get(k);
            SyncState.BaseEntry b = base.files.get(k);
            try {
                switch (op.kind) {
                    case "record":
                        next.files.put(k, new SyncState.BaseEntry(l.p, l.h, r.h));
                        if (k.equals(META)) next.meta = new String(readAll(fileOf(ws.dir, l.p)), StandardCharsets.UTF_8);
                        break;
                    case "forget":
                        break;
                    case "get": {
                        progress.onProgress(ws.name, done, total, r.p);
                        String got = download(c, ws, r, l == null ? null : l.h, sizes, hashes, j);
                        if (got == null) { res.skipped++; keep(next, b, k); break; }
                        next.files.put(k, new SyncState.BaseEntry(r.p, got, r.h));
                        if (k.equals(META)) next.meta = new String(readAll(fileOf(ws.dir, r.p)), StandardCharsets.UTF_8);
                        else j.add("here", l == null ? "added" : "replaced", wsId, ws.name, r.p, l == null ? null : l.h, got, null);
                        res.downloaded++;
                        res.changedHere.add(wsId);
                        break;
                    }
                    case "put": {
                        progress.onProgress(ws.name, done, total, l.p);
                        File f = fileOf(ws.dir, l.p);
                        String shown = c.put(wsId, l.p, f, l.s, l.m, l.h, r == null ? null : r.h);
                        next.files.put(k, new SyncState.BaseEntry(l.p, l.h, shown));
                        if (k.equals(META)) next.meta = new String(readAll(f), StandardCharsets.UTF_8);
                        else j.add("pc", r == null ? "added" : "replaced", wsId, ws.name, l.p, r == null ? null : r.h, shown, null);
                        res.uploaded++;
                        changedOnPc.add(wsId);
                        break;
                    }
                    case "delHere": {
                        if (holdDeletes) { keep(next, b, k); break; }
                        File f = fileOf(ws.dir, l.p);
                        String now = hashOf(f, k, sizes, hashes);
                        if (!now.equals(l.h)) { keep(next, b, k); break; } // edited meanwhile: next sync sends it
                        if (k.equals(META)) { keep(next, b, k); break; }
                        String trashId = store.trashFromSync(f, pc.name);
                        j.add("here", "deleted", wsId, ws.name, l.p, l.h, null, trashId);
                        sizes.remove(k);
                        hashes.remove(k);
                        res.deletedHere++;
                        res.changedHere.add(wsId);
                        break;
                    }
                    case "delPc": {
                        if (holdDeletes) { keep(next, b, k); break; }
                        if (k.equals(META)) { keep(next, b, k); break; }
                        c.delete(wsId, r.p, r.h);
                        j.add("pc", "deleted", wsId, ws.name, r.p, r.h, null, null);
                        res.deletedOnPc++;
                        changedOnPc.add(wsId);
                        break;
                    }
                    case "merge": {
                        progress.onProgress(ws.name, done, total, META);
                        mergeMeta(c, ws, base, l, r, next, sizes, hashes);
                        res.changedHere.add(wsId);
                        changedOnPc.add(wsId);
                        break;
                    }
                    case "conflict": {
                        progress.onProgress(ws.name, done, total, l.p);
                        String copy = conflict(c, ws, l, r, local.keySet(), remote.keySet(), next, sizes, hashes);
                        j.add("both", "conflict", wsId, ws.name, l.p, null, null, null).put("copy", copy);
                        res.conflicts++;
                        res.downloaded++;
                        res.uploaded++;
                        res.changedHere.add(wsId);
                        changedOnPc.add(wsId);
                        break;
                    }
                    default:
                        break;
                }
            } catch (SyncClient.Refused e) {
                // The PC changed it meanwhile, or can't take it now: tried again next time.
                Log.info("Sync " + op.kind + " " + k + ": " + e.code + " " + e.getMessage());
                res.skipped++;
                keep(next, b, k);
            }
            if (!op.kind.equals("record") && !op.kind.equals("forget")) done++;
            if (done % 50 == 0) state.saveHashes(wsId, sizes, hashes);
        }

        // ── folders the other side removed (only when empty here, deepest first) ──
        List<String> gone = new ArrayList<>();
        for (Map.Entry<String, String> d : base.dirs.entrySet()) {
            boolean here = localL.dirs.containsKey(d.getKey()), there = remoteDirs.containsKey(d.getKey());
            if (here && !there && !holdDeletes) gone.add("here:" + d.getValue());
            else if (!here && there && !holdDeletes) gone.add("pc:" + d.getValue());
        }
        Collections.sort(gone, (a, b2) -> b2.length() - a.length());
        for (String g : gone) {
            boolean here = g.startsWith("here:");
            String p = g.substring(here ? 5 : 3);
            if (here) {
                File f = fileOf(ws.dir, p);
                String[] left = f.list();
                if (left != null && left.length == 0 && f.delete()) res.changedHere.add(wsId);
            } else {
                try {
                    c.request(Json.obj("op", "rmdir", "ws", wsId, "p", p));
                    pcDirs.remove(key(p));
                    changedOnPc.add(wsId);
                } catch (SyncClient.Refused e) {
                    Log.info("Sync rmdir " + p + ": " + e.getMessage());
                }
            }
        }
        // Folders that are now on both sides (one missing on a side next time = removed there).
        Listing after = listLocal(wsId, ws.dir, sizes, hashes);
        for (Map.Entry<String, String> d : after.dirs.entrySet()) {
            if (pcDirs.containsKey(d.getKey())) next.dirs.put(d.getKey(), d.getValue());
        }
        state.saveBase(pc.hostId, wsId, next);
        state.saveHashes(wsId, sizes, hashes);
        progress.onProgress(ws.name, total, total, "");
    }

    private static void keep(SyncState.Base next, SyncState.BaseEntry b, String k) {
        if (b != null) next.files.put(k, b);
    }

    /**
     * Downloads the PC's file over the phone's, if the phone's copy is still {@code expectLocal} (null = none); the
     * phone's copy is first kept in the history of {@code keepFor} (null: not kept). Returns the hash of the phone's
     * copy afterwards, or null when it was left alone.
     */
    private String download(SyncClient c, LocalStore.Ws ws, Entry r, String expectLocal, Map<String, long[]> sizes, Map<String, String> hashes,
                            SyncJournal keepFor) throws IOException {
        File target = fileOf(ws.dir, r.p);
        File parent = target.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("Can't create " + parent);
        File tmp = new File(parent, "." + target.getName() + "." + Bytes.hex(Crypto.random(4)) + ".mnsync-tmp");
        try {
            Map<String, Object> got;
            try (OutputStream out = new BufferedOutputStream(new FileOutputStream(tmp), 1 << 16)) {
                got = c.get(ws.id, r.p, out);
            }
            String k = key(r.p);
            String now = target.exists() ? hashOf(target, k, sizes, hashes) : null;
            if (!eq(now, expectLocal)) return null; // edited on the phone meanwhile
            if (keepFor != null && now != null && !k.equals(META)) history.keep(keepFor.hostId, keepFor.run, ws.id, r.p, target);
            long m = Json.getLong(got, "m", r.m);
            if (k.equals(META)) {
                store.writeWorkspaceMeta(ws.id, readAll(tmp));
            } else {
                try {
                    Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
                } catch (AtomicMoveNotSupportedException e) {
                    Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING);
                }
            }
            if (m > 0) target.setLastModified(m);
            String h = Json.getString(got, "h", r.h);
            if (k.equals(META)) return hashOf(target, k, sizes, hashes);
            sizes.put(k, new long[] {target.length(), target.lastModified()});
            hashes.put(k, h);
            return h;
        } finally {
            if (tmp.exists() && !tmp.delete()) tmp.deleteOnExit();
        }
    }

    private static final SimpleDateFormat STAMP = new SimpleDateFormat("yyyy-MM-dd HHmm", Locale.ROOT);

    private static String safeName(String s) {
        String o = s.replaceAll("[<>:\"/\\\\|?*\\x00-\\x1f]", "-").trim();
        return o.isEmpty() ? "phone" : o.length() > 40 ? o.substring(0, 40).trim() : o;
    }

    /**
     * Both sides edited the same file: the PC's keeps the name, the phone's is kept next to it on both sides.
     * Returns the copy's path.
     */
    private String conflict(SyncClient c, LocalStore.Ws ws, Entry l, Entry r, Set<String> localKeys, Set<String> remoteKeys,
                            SyncState.Base next, Map<String, long[]> sizes, Map<String, String> hashes) throws IOException {
        String dir = l.p.contains("/") ? l.p.substring(0, l.p.lastIndexOf('/') + 1) : "";
        String name = l.p.substring(dir.length());
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name, ext = dot > 0 ? name.substring(dot) : "";
        String stamp;
        synchronized (STAMP) { stamp = STAMP.format(new Date()); }
        String copy = dir + stem + " (conflict " + safeName(deviceName) + " " + stamp + ")" + ext;
        for (int n = 2; localKeys.contains(key(copy)) || remoteKeys.contains(key(copy)) || fileOf(ws.dir, copy).exists(); n++) {
            copy = dir + stem + " (conflict " + safeName(deviceName) + " " + stamp + " " + n + ")" + ext;
        }
        File from = fileOf(ws.dir, l.p), to = fileOf(ws.dir, copy);
        Files.move(from.toPath(), to.toPath());
        sizes.remove(key(l.p));
        hashes.remove(key(l.p));
        String copyHash = hashOf(to, key(copy), sizes, hashes);
        String shown = c.put(ws.id, copy, to, to.length(), to.lastModified(), copyHash, null);
        next.files.put(key(copy), new SyncState.BaseEntry(copy, copyHash, shown));
        String got = download(c, ws, r, null, sizes, hashes, null);
        if (got != null) next.files.put(key(r.p), new SyncState.BaseEntry(r.p, got, r.h));
        return copy;
    }

    // ─────────────────────────── workspace settings ───────────────────────────

    /** .workspace.json changed on both sides: merged key by key (folders and notes entry by entry); the PC wins a tie. */
    private void mergeMeta(SyncClient c, LocalStore.Ws ws, SyncState.Base base, Entry l, Entry r, SyncState.Base next,
                           Map<String, long[]> sizes, Map<String, String> hashes) throws IOException {
        ByteArrayOutputStream rb = new ByteArrayOutputStream();
        c.get(ws.id, META, rb);
        File lf = fileOf(ws.dir, l.p);
        Map<String, Object> remoteObj = Json.parseObject(new String(rb.toByteArray(), StandardCharsets.UTF_8));
        Map<String, Object> localObj = Json.parseObject(new String(readAll(lf), StandardCharsets.UTF_8));
        Map<String, Object> baseObj;
        try {
            baseObj = base.meta == null || base.meta.isEmpty() ? new LinkedHashMap<String, Object>() : Json.parseObject(base.meta);
        } catch (RuntimeException e) {
            baseObj = new LinkedHashMap<>();
        }
        Map<String, Object> merged = base.meta == null || base.meta.isEmpty() ? remoteObj : merge3(baseObj, localObj, remoteObj, true);
        merged.put("id", ws.id);
        byte[] bytes = Json.pretty(merged).getBytes(StandardCharsets.UTF_8);
        store.writeWorkspaceMeta(ws.id, bytes);
        String lh = hashOf(lf, key(META), sizes, hashes);
        String shown = c.put(ws.id, META, bytes, System.currentTimeMillis(), r.h);
        next.files.put(key(META), new SyncState.BaseEntry(META, lh, shown));
        next.meta = new String(readAll(lf), StandardCharsets.UTF_8);
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> merge3(Map<String, Object> base, Map<String, Object> local, Map<String, Object> remote, boolean top) {
        Map<String, Object> out = new LinkedHashMap<>();
        Set<String> keys = new LinkedHashSet<>();
        keys.addAll(remote.keySet());
        keys.addAll(local.keySet());
        for (String k : keys) {
            Object b = base.get(k), l = local.get(k), r = remote.get(k);
            Object v;
            if (top && (k.equals("folders") || k.equals("notes")) && (l instanceof Map || r instanceof Map)) {
                v = merge3(b instanceof Map ? (Map<String, Object>) b : new LinkedHashMap<String, Object>(),
                        l instanceof Map ? (Map<String, Object>) l : new LinkedHashMap<String, Object>(),
                        r instanceof Map ? (Map<String, Object>) r : new LinkedHashMap<String, Object>(), false);
            } else if (same(l, b)) {
                v = r;
            } else if (same(r, b)) {
                v = l;
            } else {
                v = r;
            }
            if (v != null) out.put(k, v);
        }
        return out;
    }

    @SuppressWarnings("unchecked")
    static boolean same(Object a, Object b) {
        if (a == null || b == null) return a == b;
        if (a instanceof Map && b instanceof Map) {
            Map<String, Object> x = (Map<String, Object>) a, y = (Map<String, Object>) b;
            Set<String> ks = new LinkedHashSet<>(x.keySet());
            ks.addAll(y.keySet());
            for (String k : ks) if (!same(x.get(k), y.get(k))) return false;
            return true;
        }
        if (a instanceof List && b instanceof List) {
            List<Object> x = (List<Object>) a, y = (List<Object>) b;
            if (x.size() != y.size()) return false;
            for (int i = 0; i < x.size(); i++) if (!same(x.get(i), y.get(i))) return false;
            return true;
        }
        if (a instanceof Number && b instanceof Number) return ((Number) a).doubleValue() == ((Number) b).doubleValue();
        return a.equals(b);
    }
}

package com.marknotes.core.sync;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import com.marknotes.core.Json;
import com.marknotes.core.Log;

/**
 * What the phone remembers about sync: paired PCs (config/sync/pcs.json), per PC and workspace the state after the
 * last sync (config/sync/base/&lt;pc&gt;/&lt;ws&gt;.json), and a hash cache of the phone's files (cache/sync).
 */
public final class SyncState {
    private final File dir;
    private final File cacheDir;
    private final Object gate = new Object();

    public SyncState(File configDir, File cacheDir) {
        this.dir = new File(configDir, "sync");
        this.cacheDir = new File(cacheDir, "sync");
    }

    // ─────────────────────────── files ───────────────────────────

    static String readText(File f) throws IOException {
        try (InputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream o = new ByteArrayOutputStream();
            byte[] buf = new byte[1 << 15];
            int n;
            while ((n = in.read(buf)) > 0) o.write(buf, 0, n);
            return new String(o.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    static void writeText(File f, String text) throws IOException {
        File parent = f.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("Can't create " + parent);
        File tmp = new File(parent, f.getName() + ".tmp");
        try (OutputStream o = new FileOutputStream(tmp)) {
            o.write(text.getBytes(StandardCharsets.UTF_8));
        }
        Files.move(tmp.toPath(), f.toPath(), StandardCopyOption.REPLACE_EXISTING);
    }

    private static String safe(String id) { return id.replaceAll("[^A-Za-z0-9_-]", "_"); }

    // ─────────────────────────── PCs ───────────────────────────

    public List<PairedPc> loadPcs() {
        synchronized (gate) {
            List<PairedPc> out = new ArrayList<>();
            File f = new File(dir, "pcs.json");
            if (!f.isFile()) return out;
            try {
                for (Object o : (List<?>) Json.parse(readText(f))) {
                    @SuppressWarnings("unchecked") Map<String, Object> m = (Map<String, Object>) o;
                    out.add(PairedPc.fromStored(m));
                }
            } catch (IOException | RuntimeException e) {
                Log.error("SyncState.loadPcs", e);
            }
            return out;
        }
    }

    public void savePcs(List<PairedPc> pcs) {
        synchronized (gate) {
            List<Object> list = new ArrayList<>();
            for (PairedPc p : pcs) list.add(p.toStored());
            try {
                writeText(new File(dir, "pcs.json"), Json.pretty(list));
            } catch (IOException e) {
                Log.error("SyncState.savePcs", e);
            }
        }
    }

    // ─────────────────────────── state after the last sync ───────────────────────────

    /** One path after the last sync: the phone's hash and the PC's (each side may store a file its own way). */
    static final class BaseEntry {
        final String p, l, r;

        BaseEntry(String p, String l, String r) {
            this.p = p;
            this.l = l;
            this.r = r;
        }
    }

    static final class Base {
        final Map<String, BaseEntry> files = new HashMap<>();
        final Map<String, String> dirs = new HashMap<>();
        /** .workspace.json as it was (to merge both sides' changes). */
        String meta;
    }

    private File baseFile(String hostId, String wsId) {
        return new File(new File(new File(dir, "base"), safe(hostId)), safe(wsId) + ".json");
    }

    boolean hasBase(String hostId, String wsId) { return baseFile(hostId, wsId).isFile(); }

    void dropBase(String hostId, String wsId) {
        File f = baseFile(hostId, wsId);
        if (f.isFile() && !f.delete()) f.deleteOnExit();
    }

    public void dropAll(String hostId) {
        File d = new File(new File(dir, "base"), safe(hostId));
        File[] items = d.listFiles();
        if (items != null) for (File f : items) f.delete();
        d.delete();
    }

    Base loadBase(String hostId, String wsId) {
        Base b = new Base();
        File f = baseFile(hostId, wsId);
        if (!f.isFile()) return b;
        try {
            Map<String, Object> m = Json.parseObject(readText(f));
            Map<String, Object> files = Json.getMap(m, "files");
            if (files != null) {
                for (Map.Entry<String, Object> e : files.entrySet()) {
                    @SuppressWarnings("unchecked") Map<String, Object> v = (Map<String, Object>) e.getValue();
                    b.files.put(e.getKey(), new BaseEntry(Json.getString(v, "p", e.getKey()), (String) v.get("l"), (String) v.get("r")));
                }
            }
            Map<String, Object> dirs = Json.getMap(m, "dirs");
            if (dirs != null) for (Map.Entry<String, Object> e : dirs.entrySet()) b.dirs.put(e.getKey(), String.valueOf(e.getValue()));
            Object meta = m.get("meta");
            b.meta = meta instanceof String ? (String) meta : null;
        } catch (IOException | RuntimeException e) {
            Log.error("SyncState.loadBase", e);
        }
        return b;
    }

    void saveBase(String hostId, String wsId, Base b) {
        Map<String, Object> files = new HashMap<>();
        for (Map.Entry<String, BaseEntry> e : b.files.entrySet()) {
            files.put(e.getKey(), Json.obj("p", e.getValue().p, "l", e.getValue().l, "r", e.getValue().r));
        }
        Map<String, Object> dirs = new HashMap<String, Object>(b.dirs);
        try {
            writeText(baseFile(hostId, wsId), Json.write(Json.obj("files", files, "dirs", dirs, "meta", b.meta)));
        } catch (IOException e) {
            Log.error("SyncState.saveBase", e);
        }
    }

    // ─────────────────────────── hash cache ───────────────────────────

    void loadHashes(String wsId, Map<String, long[]> sizes, Map<String, String> hashes) {
        File f = new File(cacheDir, "hash-" + safe(wsId) + ".json");
        if (!f.isFile()) return;
        try {
            Map<String, Object> m = Json.parseObject(readText(f));
            for (Map.Entry<String, Object> e : m.entrySet()) {
                List<?> v = (List<?>) e.getValue();
                if (v.size() != 3) continue;
                sizes.put(e.getKey(), new long[] {((Number) v.get(0)).longValue(), ((Number) v.get(1)).longValue()});
                hashes.put(e.getKey(), (String) v.get(2));
            }
        } catch (IOException | RuntimeException e) {
            Log.error("SyncState.loadHashes", e);
        }
    }

    void saveHashes(String wsId, Map<String, long[]> sizes, Map<String, String> hashes) {
        Map<String, Object> m = new HashMap<>();
        for (Map.Entry<String, String> e : hashes.entrySet()) {
            long[] s = sizes.get(e.getKey());
            if (s == null) continue;
            List<Object> v = new ArrayList<>();
            v.add(s[0]);
            v.add(s[1]);
            v.add(e.getValue());
            m.put(e.getKey(), v);
        }
        try {
            writeText(new File(cacheDir, "hash-" + safe(wsId) + ".json"), Json.write(m));
        } catch (IOException e) {
            Log.error("SyncState.saveHashes", e);
        }
    }
}

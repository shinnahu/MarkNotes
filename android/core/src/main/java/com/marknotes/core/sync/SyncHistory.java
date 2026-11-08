package com.marknotes.core.sync;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

import com.marknotes.core.Json;
import com.marknotes.core.Log;

/**
 * The phone's record of sync runs (Settings › Sync with PC › Recent syncs): {@code <root>/<pc>/<run>/run.json} with what
 * the run changed, and {@code <root>/<pc>/<run>/files/<workspace>/<path>} the phone's versions it replaced. Kept until
 * the user deletes them (or picks "after 30 days").
 */
public final class SyncHistory {
    private final File root;
    private final Object gate = new Object();

    public SyncHistory(File root) { this.root = root; }

    private static String safe(String id) { return id.replaceAll("[^A-Za-z0-9_-]", "_"); }

    private File pcDir(String hostId) { return new File(root, safe(hostId)); }

    File runDir(String hostId, String run) {
        if (!SyncJournal.isRunId(run)) throw new IllegalArgumentException("Bad run id: " + run);
        return new File(pcDir(hostId), run);
    }

    /** Where a run keeps the phone's old version of a path. */
    File kept(String hostId, String run, String wsId, String p) {
        if (p == null || p.isEmpty() || p.startsWith("/") || p.contains("\\") || ("/" + p + "/").contains("/../")) {
            throw new IllegalArgumentException("Bad path: " + p);
        }
        return new File(new File(new File(runDir(hostId, run), "files"), safe(wsId)), p.replace('/', File.separatorChar));
    }

    /** Copies the phone's file before a sync replaces it (the version from before the run wins). */
    void keep(String hostId, String run, String wsId, String p, File f) throws IOException {
        File dst = kept(hostId, run, wsId, p);
        if (dst.exists() || !f.isFile()) return;
        File dir = dst.getParentFile();
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Can't create " + dir);
        File part = new File(dir, dst.getName() + ".part");
        Files.copy(f.toPath(), part.toPath(), StandardCopyOption.REPLACE_EXISTING);
        part.setLastModified(f.lastModified());
        Files.move(part.toPath(), dst.toPath(), StandardCopyOption.REPLACE_EXISTING);
    }

    public void save(SyncJournal j) throws IOException {
        synchronized (gate) {
            SyncState.writeText(new File(runDir(j.hostId, j.run), "run.json"), Json.pretty(j.toJson()));
        }
    }

    public SyncJournal load(String hostId, String run) {
        File f = new File(runDir(hostId, run), "run.json");
        if (!f.isFile()) return null;
        try {
            return SyncJournal.fromJson(Json.parseObject(SyncState.readText(f)));
        } catch (IOException | RuntimeException e) {
            Log.error("SyncHistory.load " + f, e);
            return null;
        }
    }

    /** Run ids with this PC, newest first. */
    public List<String> runs(String hostId) {
        List<String> out = new ArrayList<>();
        String[] names = pcDir(hostId).list();
        if (names != null) for (String n : names) if (SyncJournal.isRunId(n)) out.add(n);
        Collections.sort(out, Collections.reverseOrder());
        return out;
    }

    /** Deletes a run's record and the versions it kept. */
    public void delete(String hostId, String run) {
        synchronized (gate) {
            deleteTree(runDir(hostId, run));
        }
    }

    /** Runs older than {@code cutoff} (ms). */
    public List<String> olderThan(String hostId, long cutoff) {
        List<String> out = new ArrayList<>();
        for (String run : runs(hostId)) {
            SyncJournal j = load(hostId, run);
            long at = j != null ? j.at : new File(pcDir(hostId), run).lastModified();
            if (at < cutoff) out.add(run);
        }
        return out;
    }

    public long bytes(String hostId) { return size(pcDir(hostId), 0); }

    /** Whether a run still has the phone's old version of an item. */
    boolean hasKept(SyncJournal j, Map<String, Object> it) {
        try {
            return kept(j.hostId, j.run, Json.getString(it, "ws", ""), Json.getString(it, "p", "")).isFile();
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    private static long size(File f, int depth) {
        if (f.isFile()) return f.length();
        File[] kids = depth > 40 ? null : f.listFiles();
        long n = 0;
        if (kids != null) for (File k : kids) n += size(k, depth + 1);
        return n;
    }

    private static void deleteTree(File f) {
        File[] kids = f.isDirectory() ? f.listFiles() : null;
        if (kids != null) for (File k : kids) deleteTree(k);
        if (f.exists() && !f.delete()) Log.info("SyncHistory: could not remove " + f);
    }
}

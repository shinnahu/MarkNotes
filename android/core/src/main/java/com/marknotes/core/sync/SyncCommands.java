package com.marknotes.core.sync;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.marknotes.core.Args;
import com.marknotes.core.Bridge;
import com.marknotes.core.Json;
import com.marknotes.core.Lang;
import com.marknotes.core.Log;
import com.marknotes.core.Platform;

/**
 * The phone's sync commands for the web UI (Settings › Sync and the sync button):
 * sync.status, sync.discover, sync.pair, sync.workspaces, sync.choose, sync.run, sync.forget,
 * sync.history, sync.undo, sync.pruneHistory, sync.clearHistory.
 * Events: sync.state, sync.pairCode, sync.progress, sync.changed, sync.history.
 */
public final class SyncCommands {
    private static final long DAY = 24L * 3600 * 1000;

    private final Bridge bridge;
    private final Platform platform;
    private final LocalStore store;
    private final SyncState state;
    private final SyncHistory history;
    private final Object runGate = new Object();
    private volatile boolean running;
    private volatile Map<String, Object> progress;
    private volatile Map<String, Object> lastResult;

    public SyncCommands(Bridge bridge, Platform platform, LocalStore store) {
        this.bridge = bridge;
        this.platform = platform;
        this.store = store;
        this.state = new SyncState(platform.configDir(), platform.cacheDir());
        this.history = new SyncHistory(platform.historyDir());
    }

    public void register() {
        bridge.on("sync.status", a -> status());
        bridge.on("sync.discover", a -> discover(Args.l(a, "port"), Args.s(a, "address")));
        bridge.on("sync.pair", a -> pair(Args.req(a, "address"), (int) Args.l(a, "port")));
        bridge.on("sync.workspaces", a -> workspaces(Args.req(a, "hostId")));
        bridge.on("sync.choose", a -> choose(Args.req(a, "hostId"), Args.strs(a, "ids"), Args.has(a, "sendNew") ? Args.b(a, "sendNew") : null));
        bridge.on("sync.run", a -> run(Args.s(a, "hostId"), new HashSet<>(Args.strs(a, "allowDeletes")), Args.s(a, "reason")));
        bridge.on("sync.forget", a -> forget(Args.req(a, "hostId")));
        bridge.on("sync.history", a -> historyList(Args.req(a, "hostId"), Args.l(a, "limit")));
        bridge.on("sync.undo", a -> undo(Args.req(a, "hostId"), Args.req(a, "run")));
        bridge.on("sync.pruneHistory", a -> prune(Args.l(a, "days")));
        bridge.on("sync.clearHistory", a -> clearHistory(Args.s(a, "hostId")));
    }

    private PairedPc find(List<PairedPc> pcs, String hostId) {
        for (PairedPc p : pcs) if (p.hostId.equalsIgnoreCase(hostId)) return p;
        throw new IllegalStateException(Lang.t("That PC isn't paired with this phone.", "Esa PC no está vinculada a este teléfono."));
    }

    public Map<String, Object> status() {
        List<Object> pcs = new ArrayList<>();
        for (PairedPc p : state.loadPcs()) pcs.add(p.toUi());
        return Json.obj("device", platform.deviceName(), "pcs", pcs, "running", running, "progress", progress, "last", lastResult);
    }

    private void emitState() {
        try {
            bridge.emit("sync.state", status());
        } catch (RuntimeException e) {
            Log.error("sync.state", e);
        }
    }

    /** PCs on the Wi-Fi; {@code address} also asks that one directly (typed by the user, or 127.0.0.1 in tests). */
    private List<Object> discover(long port, String address) {
        int p = port > 0 ? (int) port : Proto.DEFAULT_PORT;
        List<java.net.InetAddress> targets = Discovery.broadcastTargets();
        if (address != null && !address.trim().isEmpty()) {
            try { targets.add(0, java.net.InetAddress.getByName(address.trim())); } catch (IOException ignored) {}
        }
        Set<String> paired = new HashSet<>();
        for (PairedPc pc : state.loadPcs()) paired.add(pc.hostId.toLowerCase(java.util.Locale.ROOT));
        List<Object> out = new ArrayList<>();
        for (Discovery.Found f : Discovery.scan(targets, p, 1600)) {
            Map<String, Object> m = f.toJson();
            m.put("paired", paired.contains(f.id.toLowerCase(java.util.Locale.ROOT)));
            out.add(m);
        }
        return out;
    }

    private Map<String, Object> pair(String address, int port) throws IOException {
        int p = port > 0 ? port : Proto.DEFAULT_PORT;
        PairedPc pc = SyncClient.pair(address.trim(), p, platform.deviceName(), platform.deviceModel(),
                code -> bridge.emit("sync.pairCode", Json.obj("code", code, "address", address)));
        // The phone's workspaces of today are offered on the next page; later ones go to the PC by themselves.
        for (LocalStore.Ws w : store.workspaces()) pc.seenLocal.add(w.id);
        synchronized (runGate) {
            List<PairedPc> pcs = state.loadPcs();
            for (int i = pcs.size() - 1; i >= 0; i--) {
                if (pcs.get(i).hostId.equalsIgnoreCase(pc.hostId)) {
                    // Paired again (the PC forgot this phone): keep what was chosen.
                    pc.workspaces.addAll(pcs.get(i).workspaces);
                    pc.seenLocal.addAll(pcs.get(i).seenLocal);
                    pc.pendingForget.addAll(pcs.get(i).pendingForget);
                    pcs.remove(i);
                }
            }
            pcs.add(pc);
            state.savePcs(pcs);
        }
        emitState();
        return pc.toUi();
    }

    /** The PC's workspaces and the phone's, with what is synced (connects to the PC). */
    private Map<String, Object> workspaces(String hostId) throws IOException {
        List<PairedPc> pcs = state.loadPcs();
        PairedPc pc = find(pcs, hostId);
        Map<String, LocalStore.Ws> local = new LinkedHashMap<>();
        for (LocalStore.Ws w : store.workspaces()) local.put(w.id, w);
        List<Object> list = new ArrayList<>();
        Set<String> onPc = new HashSet<>();
        String error = null;
        try (SyncClient c = SyncClient.connect(pc, platform.deviceName())) {
            Map<String, Object> info = c.request(Json.obj("op", "info"));
            c.bye();
            for (Object o : Json.getList(info, "workspaces")) {
                @SuppressWarnings("unchecked") Map<String, Object> w = (Map<String, Object>) o;
                String id = Json.getString(w, "id", "");
                onPc.add(id);
                list.add(Json.obj("id", id, "name", Json.getString(w, "name", ""), "color", w.get("color"),
                        "notes", w.get("notes"), "linked", w.get("linked"), "onPc", true, "here", local.containsKey(id),
                        "synced", pc.workspaces.contains(id)));
            }
            pc.lastAddress = c.address();
            synchronized (runGate) {
                List<PairedPc> all = state.loadPcs();
                for (PairedPc x : all) if (x.hostId.equalsIgnoreCase(pc.hostId)) { x.lastAddress = pc.lastAddress; x.addAddress(pc.lastAddress); }
                state.savePcs(all);
            }
        } catch (IOException e) {
            error = e.getMessage();
        }
        for (LocalStore.Ws w : local.values()) {
            if (onPc.contains(w.id)) continue;
            list.add(Json.obj("id", w.id, "name", w.name, "onPc", false, "here", true, "synced", pc.workspaces.contains(w.id),
                    "notes", (long) SyncEngine.countNotes(w.dir, 0)));
        }
        return Json.obj("pc", pc.toUi(), "workspaces", list, "error", error);
    }

    private Map<String, Object> choose(String hostId, List<String> ids, Boolean sendNew) {
        synchronized (runGate) {
            List<PairedPc> pcs = state.loadPcs();
            PairedPc pc = find(pcs, hostId);
            pc.workspaces.clear();
            pc.workspaces.addAll(ids);
            for (LocalStore.Ws w : store.workspaces()) pc.seenLocal.add(w.id);
            if (sendNew != null) pc.sendNew = sendNew;
            state.savePcs(pcs);
        }
        emitState();
        return status();
    }

    /** Stops syncing with a PC. Its sync history stays on the phone (it comes back if the same PC is paired again). */
    private Map<String, Object> forget(String hostId) {
        synchronized (runGate) {
            List<PairedPc> pcs = state.loadPcs();
            PairedPc pc = find(pcs, hostId);
            pcs.remove(pc);
            state.savePcs(pcs);
            state.dropAll(pc.hostId);
        }
        emitState();
        return status();
    }

    private SyncEngine engine(final String pcName) {
        return new SyncEngine(state, store, platform.deviceName(), (ws, done, total, path) -> {
            progress = Json.obj("pc", pcName, "ws", ws, "done", (long) done, "total", (long) total, "path", path);
            bridge.emit("sync.progress", progress);
        }, history);
    }

    /** Keeps a run's record (only when it changed something). */
    private boolean saveJournal(SyncJournal j, SyncEngine.Result r) {
        if (j == null || j.isEmpty()) return false;
        if (r != null) {
            j.summary = Json.obj("uploaded", (long) r.uploaded, "downloaded", (long) r.downloaded, "deletedHere", (long) r.deletedHere,
                    "deletedOnPc", (long) r.deletedOnPc, "conflicts", (long) r.conflicts, "restored", (long) r.restored, "copies", (long) r.copies);
        }
        try {
            history.save(j);
            return true;
        } catch (IOException | RuntimeException e) {
            Log.error("sync history " + j.run, e);
            return false;
        }
    }

    /**
     * After runs: keeps what the user changed meanwhile (choices, forgotten PCs) and adds what the runs learned.
     * {@code before}: each run PC's workspaces before it ran; {@code forgotten}: runs the PC dropped.
     */
    private void saveBack(List<PairedPc> used, Map<String, Set<String>> before, Map<String, List<String>> forgotten) {
        synchronized (runGate) {
            List<PairedPc> now = state.loadPcs();
            for (PairedPc n : now) {
                for (PairedPc p : used) {
                    Set<String> was = before.get(p.hostId);
                    if (was == null || !p.hostId.equalsIgnoreCase(n.hostId)) continue;
                    n.lastSync = p.lastSync;
                    n.lastError = p.lastError;
                    n.lastAddress = p.lastAddress;
                    n.name = p.name;
                    n.addresses.clear();
                    n.addresses.addAll(p.addresses);
                    n.seenLocal.addAll(p.seenLocal);
                    for (String w : p.workspaces) if (!was.contains(w)) n.workspaces.add(w);   // sent for the first time
                    for (String w : was) if (!p.workspaces.contains(w)) n.workspaces.remove(w); // gone on one side
                    List<String> gone = forgotten.get(p.hostId);
                    if (gone != null) n.pendingForget.removeAll(gone);
                }
            }
            state.savePcs(now);
        }
    }

    /** Syncs with every paired PC (or one). Only one run at a time; a second call while one runs returns {busy}. */
    public Map<String, Object> run(String hostId, Set<String> allowDeletes, String reason) {
        synchronized (runGate) {
            if (running) return Json.obj("busy", true);
            running = true;
        }
        List<Object> results = new ArrayList<>();
        Set<String> changed = new HashSet<>();
        boolean historyChanged = false;
        try {
            progress = null;
            emitState();
            List<PairedPc> pcs = state.loadPcs();
            Map<String, Set<String>> before = new LinkedHashMap<>();
            Map<String, List<String>> forgotten = new HashMap<>();
            for (PairedPc pc : pcs) {
                if (hostId != null && !hostId.isEmpty() && !pc.hostId.equalsIgnoreCase(hostId)) continue;
                before.put(pc.hostId, new HashSet<>(pc.workspaces));
                // Workspaces made on the phone since the last choice go to the PC too.
                for (LocalStore.Ws w : store.workspaces()) {
                    if (pc.seenLocal.add(w.id) && pc.sendNew) pc.workspaces.add(w.id);
                }
                if (pc.workspaces.isEmpty()) {
                    results.add(Json.obj("hostId", pc.hostId, "name", pc.name, "ok", true, "nothing", true));
                    continue;
                }
                SyncJournal j = SyncJournal.start(pc.hostId, pc.name, reason);
                SyncEngine.Result r = null;
                try {
                    r = engine(pc.name).run(pc, allowDeletes, j);
                    changed.addAll(r.changedHere);
                    forgotten.put(pc.hostId, r.forgotten);
                    Map<String, Object> sum = r.toJson();
                    Map<String, Object> res = Json.obj("hostId", pc.hostId, "name", pc.name, "ok", true, "summary", sum);
                    if (!j.isEmpty()) {
                        res.put("run", j.run);
                        res.put("undoable", (long) j.undoable());
                    }
                    results.add(res);
                } catch (IOException | RuntimeException e) {
                    Log.error("sync.run " + pc.name, e);
                    pc.lastError = e.getMessage() == null ? e.toString() : e.getMessage();
                    boolean unpaired = e instanceof SyncClient.AuthFailed
                            && (((SyncClient.AuthFailed) e).status == Proto.ST_UNKNOWN_DEVICE || ((SyncClient.AuthFailed) e).status == Proto.ST_BAD_TOKEN);
                    results.add(Json.obj("hostId", pc.hostId, "name", pc.name, "ok", false, "error", pc.lastError,
                            "unpaired", unpaired, "identityChanged", e instanceof SecureChannel.IdentityChanged));
                } finally {
                    // What a run changed before it stopped is kept too, so it can be undone.
                    historyChanged |= saveJournal(j, r);
                }
            }
            saveBack(pcs, before, forgotten);
        } finally {
            running = false;
            progress = null;
        }
        Map<String, Object> out = Json.obj("results", results, "changed", new ArrayList<Object>(changed), "reason", reason);
        lastResult = Json.obj("at", System.currentTimeMillis(), "results", results);
        if (!changed.isEmpty()) bridge.emit("sync.changed", Json.obj("workspaces", new ArrayList<Object>(changed)));
        if (historyChanged) bridge.emit("sync.history", Json.obj());
        emitState();
        return out;
    }

    // ─────────────────────────── history and undo ───────────────────────────

    /** Recent syncs with a PC, newest first, for Settings › Sync with PC. */
    private Map<String, Object> historyList(String hostId, long limit) {
        PairedPc pc = find(state.loadPcs(), hostId);
        List<String> runs = history.runs(pc.hostId);
        int n = (int) Math.max(1, Math.min(limit > 0 ? limit : 20, 2000));
        List<Object> out = new ArrayList<>();
        for (String run : runs.subList(0, Math.min(n, runs.size()))) {
            SyncJournal j = history.load(pc.hostId, run);
            if (j != null) out.add(view(j));
        }
        return Json.obj("runs", out, "more", runs.size() > n, "total", (long) runs.size(), "bytes", history.bytes(pc.hostId));
    }

    private Map<String, Object> view(SyncJournal j) {
        Map<String, Object> counts = new LinkedHashMap<>();
        List<Object> items = new ArrayList<>();
        long undoable = 0;
        for (Map<String, Object> it : j.items) {
            String side = Json.getString(it, "side", ""), kind = Json.getString(it, "kind", "");
            String key = side + "/" + kind;
            counts.put(key, Json.getLong(counts, key, 0) + 1);
            boolean can = false;
            if (SyncJournal.undoableKind(it) && !it.containsKey("undoneBy")) {
                if (side.equals("here")) can = kind.equals("deleted") ? it.get("trash") != null : history.hasKept(j, it);
                else if (side.equals("pc")) can = j.pcKeeps;
            }
            if (can) undoable++;
            if (items.size() < 400) {
                items.add(Json.obj("side", side, "kind", kind, "p", it.get("p"), "wsName", it.get("wsName"), "copy", it.get("copy"),
                        "can", can, "undone", it.containsKey("undoneBy")));
            }
        }
        return Json.obj("run", j.run, "at", j.at, "pc", j.pc, "reason", j.reason, "of", j.of, "undone", j.undone, "undoneBy", j.undoneBy,
                "pcKeeps", j.pcKeeps, "counts", counts, "undoable", undoable, "count", (long) j.items.size(), "items", items);
    }

    /** Undoes one run: what it deleted or replaced comes back on both devices (needs the PC on the same Wi-Fi). */
    private Map<String, Object> undo(String hostId, String runId) throws IOException {
        synchronized (runGate) {
            if (running) throw new IllegalStateException(Lang.t("A sync is running. Try again in a moment.", "Hay una sincronización en curso. Prueba de nuevo en un momento."));
            running = true;
        }
        SyncJournal done = null, u = null;
        SyncEngine.Result r = null;
        PairedPc pc = null;
        try {
            progress = null;
            emitState();
            List<PairedPc> pcs = state.loadPcs();
            pc = find(pcs, hostId);
            done = history.load(pc.hostId, runId);
            if (done == null) throw new IllegalStateException(Lang.t("That sync is no longer in the history.", "Esa sincronización ya no está en el historial."));
            if (done.undone > 0) throw new IllegalStateException(Lang.t("That sync was already undone.", "Esa sincronización ya se deshizo."));
            u = SyncJournal.start(pc.hostId, pc.name, "undo");
            u.of = done.run;
            Map<String, Set<String>> before = new HashMap<>();
            before.put(pc.hostId, new HashSet<>(pc.workspaces));
            try {
                r = engine(pc.name).undo(pc, done, u);
            } catch (SyncClient.Refused | SyncClient.AuthFailed e) {
                throw e;
            } catch (IOException e) {
                if (u.isEmpty()) {
                    throw new IOException(Lang.t("Can't reach " + pc.name + ". To undo a sync, this phone and the PC must be on the same Wi-Fi, with MarkNotes open on the PC.",
                            "No se encuentra " + pc.name + ". Para deshacer una sincronización, el teléfono y la PC deben estar en la misma Wi-Fi, con MarkNotes abierto en la PC."), e);
                }
                throw e;
            }
            done.undone = System.currentTimeMillis();
            done.undoneBy = u.run;
            pc.lastSync = System.currentTimeMillis();
            pc.lastError = "";
            Map<String, List<String>> forgotten = new HashMap<>();
            forgotten.put(pc.hostId, r.forgotten);
            saveBack(pcs, before, forgotten);
        } finally {
            if (done != null && u != null) saveJournal(done, null); // items put back are marked even when it stopped half way
            saveJournal(u, r);
            running = false;
            progress = null;
        }
        if (!r.changedHere.isEmpty()) bridge.emit("sync.changed", Json.obj("workspaces", new ArrayList<Object>(r.changedHere)));
        bridge.emit("sync.history", Json.obj("hostId", pc.hostId));
        emitState();
        return Json.obj("run", u.run, "restored", (long) r.restored, "copies", (long) r.copies, "skipped", (long) r.skipped,
                "notes", new ArrayList<Object>(r.notes), "summary", r.toJson());
    }

    /** "Keep old versions: after N days": deletes older runs here; the PC drops its copies at the next sync. */
    private Map<String, Object> prune(long days) {
        if (days <= 0) return Json.obj("deleted", 0L);
        long cutoff = System.currentTimeMillis() - days * DAY;
        int n = 0;
        synchronized (runGate) {
            if (running) return Json.obj("deleted", 0L, "busy", true);
            List<PairedPc> pcs = state.loadPcs();
            for (PairedPc pc : pcs) {
                for (String run : history.olderThan(pc.hostId, cutoff)) {
                    history.delete(pc.hostId, run);
                    if (!pc.pendingForget.contains(run)) pc.pendingForget.add(run);
                    n++;
                }
            }
            if (n > 0) state.savePcs(pcs);
        }
        if (n > 0) bridge.emit("sync.history", Json.obj());
        return Json.obj("deleted", (long) n);
    }

    /** Settings › Sync with PC › Delete history (one PC, or all when hostId is null). */
    private Map<String, Object> clearHistory(String hostId) {
        int n = 0;
        synchronized (runGate) {
            if (running) throw new IllegalStateException(Lang.t("A sync is running. Try again in a moment.", "Hay una sincronización en curso. Prueba de nuevo en un momento."));
            List<PairedPc> pcs = state.loadPcs();
            for (PairedPc pc : pcs) {
                if (hostId != null && !hostId.isEmpty() && !pc.hostId.equalsIgnoreCase(hostId)) continue;
                for (String run : history.runs(pc.hostId)) {
                    history.delete(pc.hostId, run);
                    if (!pc.pendingForget.contains(run)) pc.pendingForget.add(run);
                    n++;
                }
            }
            state.savePcs(pcs);
        }
        bridge.emit("sync.history", Json.obj());
        return Json.obj("deleted", (long) n);
    }
}

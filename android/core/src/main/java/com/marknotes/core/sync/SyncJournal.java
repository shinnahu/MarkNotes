package com.marknotes.core.sync;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ThreadLocalRandom;

import com.marknotes.core.Json;

/**
 * What one sync run with a PC changed, item by item, so it can be shown and undone (PROTOCOL.md §7).
 *
 * <p>An item is {side, kind, ws, wsName, p, old, new, trash, copy}: side "here" (this phone), "pc" or "both"; kind
 * "replaced" (an older version was overwritten: kept in the history), "deleted" (here: in MarkNotes' Trash, {@code trash}
 * is its id; on the PC: kept in the PC's history and in its Recycle Bin), "added" (never undone) or "conflict" (both kept;
 * {@code copy} is the phone's copy). {@code old}/{@code new} are the hashes before and after.
 */
public final class SyncJournal {
    public final String run;
    public final String hostId;
    public String pc = "";
    public long at;
    public String reason = "";
    /** The run this one undid (an undo is a run too, so it can be undone in turn). */
    public String of;
    public long undone;
    public String undoneBy;
    /** The PC kept its old versions for this run (MarkNotes 2.5.1 and later). */
    public boolean pcKeeps;
    public final List<Map<String, Object>> items = new ArrayList<>();
    public Map<String, Object> summary;

    SyncJournal(String run, String hostId) {
        this.run = run;
        this.hostId = hostId;
    }

    public static SyncJournal start(String hostId, String pcName, String reason) {
        SyncJournal j = new SyncJournal(newRunId(), hostId);
        j.pc = pcName == null ? "" : pcName;
        j.at = System.currentTimeMillis();
        j.reason = reason == null ? "" : reason;
        return j;
    }

    /** r&lt;yyyyMMdd-HHmmssSSS&gt;-&lt;4 hex&gt;: sorts by time, safe as a folder name (the PC checks the same pattern). */
    static String newRunId() {
        String stamp = new SimpleDateFormat("yyyyMMdd-HHmmssSSS", Locale.ROOT).format(new Date());
        return "r" + stamp + "-" + String.format(Locale.ROOT, "%04x", ThreadLocalRandom.current().nextInt(0x10000));
    }

    static boolean isRunId(String s) { return s != null && s.matches("r[0-9]{8}-[0-9]{9}-[0-9a-f]{4}"); }

    synchronized Map<String, Object> add(String side, String kind, String ws, String wsName, String p, String old, String now, String trash) {
        Map<String, Object> it = new LinkedHashMap<>();
        it.put("side", side);
        it.put("kind", kind);
        it.put("ws", ws);
        it.put("wsName", wsName);
        it.put("p", p);
        if (old != null) it.put("old", old);
        if (now != null) it.put("new", now);
        if (trash != null) it.put("trash", trash);
        items.add(it);
        return it;
    }

    public synchronized boolean isEmpty() { return items.isEmpty(); }

    static boolean undoableKind(Map<String, Object> it) {
        String k = Json.getString(it, "kind", "");
        return k.equals("replaced") || k.equals("deleted");
    }

    /** Items an Undo would put back (the phone's own; the PC's only when it kept them). */
    public synchronized int undoable() {
        int n = 0;
        for (Map<String, Object> it : items) {
            if (!undoableKind(it)) continue;
            String side = Json.getString(it, "side", "");
            if (side.equals("here") || (side.equals("pc") && pcKeeps)) n++;
        }
        return n;
    }

    public synchronized Map<String, Object> toJson() {
        Map<String, Object> m = Json.obj("run", run, "hostId", hostId, "pc", pc, "at", at, "reason", reason, "of", of,
                "undone", undone, "undoneBy", undoneBy, "pcKeeps", pcKeeps, "items", new ArrayList<Object>(items));
        if (summary != null) m.put("summary", summary);
        return m;
    }

    @SuppressWarnings("unchecked")
    static SyncJournal fromJson(Map<String, Object> m) {
        SyncJournal j = new SyncJournal(Json.getString(m, "run", ""), Json.getString(m, "hostId", ""));
        j.pc = Json.getString(m, "pc", "");
        j.at = Json.getLong(m, "at", 0);
        j.reason = Json.getString(m, "reason", "");
        j.of = Json.getString(m, "of", null);
        j.undone = Json.getLong(m, "undone", 0);
        j.undoneBy = Json.getString(m, "undoneBy", null);
        j.pcKeeps = Json.getBool(m, "pcKeeps", false);
        for (Object o : Json.getList(m, "items")) if (o instanceof Map) j.items.add((Map<String, Object>) o);
        Map<String, Object> s = Json.getMap(m, "summary");
        if (s != null) j.summary = s;
        return j;
    }
}

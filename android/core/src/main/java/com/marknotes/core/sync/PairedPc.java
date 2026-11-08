package com.marknotes.core.sync;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.marknotes.core.Json;

/** A PC this phone paired with: how to reach it, the key it pinned, the phone's secret, and what is synced with it. */
public final class PairedPc {
    public String hostId = "";
    public String name = "";
    public String fingerprint = "";
    public byte[] deviceId = new byte[16];
    public byte[] token = new byte[32];
    public int port = Proto.DEFAULT_PORT;
    public final List<String> addresses = new ArrayList<>();
    public String lastAddress = "";
    public long pairedAt;
    public long lastSync;
    public String lastError = "";
    /** Workspace ids synced with this PC. */
    public final Set<String> workspaces = new LinkedHashSet<>();
    /** The phone's workspaces the user has already decided about (new ones are sent when {@link #sendNew}). */
    public final Set<String> seenLocal = new LinkedHashSet<>();
    /** Workspaces made on the phone later go to this PC too. */
    public boolean sendNew = true;
    /** Sync runs deleted from the phone's history: the PC drops its old versions of them at the next sync. */
    public final List<String> pendingForget = new ArrayList<>();

    void addAddress(String a) {
        if (a == null || a.isEmpty()) return;
        addresses.remove(a);
        addresses.add(0, a);
        while (addresses.size() > 8) addresses.remove(addresses.size() - 1);
    }

    Map<String, Object> toStored() {
        List<Object> ws = new ArrayList<Object>(workspaces);
        return Json.obj("hostId", hostId, "name", name, "fingerprint", fingerprint, "deviceId", Bytes.hex(deviceId),
                "token", Bytes.hex(token), "port", (long) port, "addresses", new ArrayList<Object>(addresses),
                "lastAddress", lastAddress, "pairedAt", pairedAt, "lastSync", lastSync, "lastError", lastError,
                "workspaces", ws, "seenLocal", new ArrayList<Object>(seenLocal), "sendNew", sendNew,
                "pendingForget", new ArrayList<Object>(pendingForget));
    }

    static PairedPc fromStored(Map<String, Object> m) {
        PairedPc p = new PairedPc();
        p.hostId = Json.getString(m, "hostId", "");
        p.name = Json.getString(m, "name", "PC");
        p.fingerprint = Json.getString(m, "fingerprint", "");
        p.deviceId = Bytes.unhex(Json.getString(m, "deviceId", ""));
        p.token = Bytes.unhex(Json.getString(m, "token", ""));
        p.port = (int) Json.getLong(m, "port", Proto.DEFAULT_PORT);
        for (Object a : Json.getList(m, "addresses")) if (a instanceof String) p.addresses.add((String) a);
        p.lastAddress = Json.getString(m, "lastAddress", "");
        p.pairedAt = Json.getLong(m, "pairedAt", 0);
        p.lastSync = Json.getLong(m, "lastSync", 0);
        p.lastError = Json.getString(m, "lastError", "");
        for (Object w : Json.getList(m, "workspaces")) if (w instanceof String) p.workspaces.add((String) w);
        for (Object w : Json.getList(m, "seenLocal")) if (w instanceof String) p.seenLocal.add((String) w);
        p.sendNew = Json.getBool(m, "sendNew", true);
        for (Object r : Json.getList(m, "pendingForget")) if (r instanceof String) p.pendingForget.add((String) r);
        return p;
    }

    /** What the UI may see (never the secret). */
    public Map<String, Object> toUi() {
        return Json.obj("hostId", hostId, "name", name, "fingerprint", Discovery.shortFp(fingerprint),
                "addresses", new ArrayList<Object>(addresses), "lastSync", lastSync, "lastError", lastError,
                "pairedAt", pairedAt, "workspaces", new ArrayList<Object>(workspaces), "sendNew", sendNew);
    }
}

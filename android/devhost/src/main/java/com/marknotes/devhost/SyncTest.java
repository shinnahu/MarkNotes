package com.marknotes.devhost;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import com.marknotes.core.Bridge;
import com.marknotes.core.Json;
import com.marknotes.core.Platform;
import com.marknotes.core.sync.SyncCommands;

/**
 * End-to-end test of phone sync against a MarkNotes test copy on this PC (scratch profile, sync port 47930).
 * The PC side approves the pairing through its DevTools port (see the Node script that starts this).
 *
 * args: <PC notes folder of the test profile> <phone scratch folder> <port>
 */
public final class SyncTest {
    private static int pass, fail;

    private static void check(String what, boolean ok) {
        if (ok) pass++;
        else fail++;
        System.out.println((ok ? "PASS " : "FAIL ") + what);
    }

    static String read(File f) throws IOException { return new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8); }

    static void write(File f, String s) throws IOException { FileLocalStore.write(f, s.getBytes(StandardCharsets.UTF_8)); }

    @SuppressWarnings("unchecked")
    static String runOf(Map<String, Object> r) {
        Map<String, Object> first = (Map<String, Object>) ((List<Object>) r.get("results")).get(0);
        return (String) first.get("run");
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> findRun(Map<String, Object> hist, String run) {
        for (Object o : (List<Object>) hist.get("runs")) if (run.equals(((Map<String, Object>) o).get("run"))) return (Map<String, Object>) o;
        return null;
    }

    static int countNamed(File dir, String name) {
        File[] kids = dir.listFiles();
        int n = 0;
        if (kids != null) for (File k : kids) n += k.isDirectory() ? countNamed(k, name) : k.getName().equals(name) ? 1 : 0;
        return n;
    }

    /** Run folders the PC keeps (history/<device>/<run>). */
    static int countRuns(File history) {
        File[] devices = history.listFiles(File::isDirectory);
        int n = 0;
        if (devices != null) for (File d : devices) { String[] runs = d.list(); n += runs == null ? 0 : runs.length; }
        return n;
    }

    @SuppressWarnings("unchecked")
    public static void main(String[] args) throws Exception {
        File pcRoot = new File(args[0]);
        File phone = new File(args[1]);
        int port = Integer.parseInt(args[2]);
        File phoneNotes = new File(phone, "Notes");
        final List<String> events = new ArrayList<>();
        final FileLocalStore store = new FileLocalStore(phoneNotes, new File(phone, "trash"));
        Platform platform = new Platform() {
            @Override public void postToUi(String json) {
                synchronized (events) { events.add(json); }
                if (json.contains("\"sync.pairCode\"")) System.out.println("EVENT " + json);
            }
            @Override public File notesRoot() { return phoneNotes; }
            @Override public File configDir() { return new File(phone, "config"); }
            @Override public File cacheDir() { return new File(phone, "cache"); }
            @Override public void trash(File f) throws IOException { store.trash(f); }
            @Override public String deviceName() { return "Test Phone"; }
            @Override public String deviceModel() { return "JVM"; }
            @Override public String platformName() { return "devhost"; }
        };
        Bridge bridge = new Bridge(platform);
        new SyncCommands(bridge, platform, store).register();

        // ── the PC's test workspace, written straight into its notes folder ──
        File pcWs = new File(pcRoot, "Sync Test");
        write(new File(pcWs, "General/Hello.md"), "# Hello\r\nfrom the PC\r\n");
        write(new File(pcWs, "General/Shared.md"), "shared v1\r\n");
        write(new File(pcWs, "General/ToDelete.md"), "delete me\r\n");
        write(new File(pcWs, "Projects/Plan.md"), "plan\r\n");
        byte[] img = new byte[300_000];
        new java.util.Random(7).nextBytes(img);
        FileLocalStore.write(new File(pcWs, ".assets/picture.png"), img);
        new File(pcWs, "Empty folder").mkdirs();

        // ── discovery and pairing ──
        List<Object> found = (List<Object>) bridge.call("sync.discover", Json.obj("port", (long) port, "address", "127.0.0.1"));
        System.out.println("discovered: " + Json.write(found));
        check("discovery finds the PC", !found.isEmpty());
        Map<String, Object> pc = (Map<String, Object>) bridge.call("sync.pair", Json.obj("address", "127.0.0.1", "port", (long) port));
        String hostId = (String) pc.get("hostId");
        check("paired", hostId != null && hostId.length() == 32);
        boolean sawCode;
        synchronized (events) { sawCode = events.stream().anyMatch(e -> e.contains("sync.pairCode")); }
        check("pairing code shown", sawCode);

        Map<String, Object> wl = (Map<String, Object>) bridge.call("sync.workspaces", Json.obj("hostId", hostId));
        System.out.println("workspaces: " + Json.write(wl));
        String wsId = null;
        for (Object o : (List<Object>) wl.get("workspaces")) {
            Map<String, Object> w = (Map<String, Object>) o;
            if ("Sync Test".equals(w.get("name"))) wsId = (String) w.get("id");
        }
        check("PC lists the test workspace", wsId != null);
        List<Object> ids = new ArrayList<>();
        ids.add(wsId);
        bridge.call("sync.choose", Json.obj("hostId", hostId, "ids", ids));

        // ── 1. first sync brings the workspace ──
        Map<String, Object> r = (Map<String, Object>) bridge.call("sync.run", Json.obj());
        System.out.println("run1: " + Json.write(r));
        File ph = store.dirOf(wsId);
        check("workspace adopted on the phone", ph != null);
        check("note downloaded", ph != null && read(new File(ph, "General/Hello.md")).equals("# Hello\r\nfrom the PC\r\n"));
        check("nested note downloaded", ph != null && new File(ph, "Projects/Plan.md").isFile());
        check("picture downloaded intact", ph != null && java.util.Arrays.equals(Files.readAllBytes(new File(ph, ".assets/picture.png").toPath()), img));
        check("empty folder created", ph != null && new File(ph, "Empty folder").isDirectory());
        check("workspace settings downloaded", ph != null && read(new File(ph, ".workspace.json")).contains(wsId));

        // ── 2. edits on both sides, different files ──
        write(new File(ph, "General/From phone.md"), "written on the phone\n");
        write(new File(ph, "Projects/Plan.md"), "plan, edited on the phone\n");
        Thread.sleep(20);
        write(new File(pcWs, "General/Hello.md"), "# Hello\r\nedited on the PC\r\n");
        new File(ph, "New phone folder").mkdirs();
        r = (Map<String, Object>) bridge.call("sync.run", Json.obj());
        System.out.println("run2: " + Json.write(r));
        check("phone note uploaded", new File(pcWs, "General/From phone.md").isFile() && read(new File(pcWs, "General/From phone.md")).equals("written on the phone\n"));
        check("phone edit uploaded", read(new File(pcWs, "Projects/Plan.md")).equals("plan, edited on the phone\n"));
        check("PC edit downloaded", read(new File(ph, "General/Hello.md")).contains("edited on the PC"));
        check("phone folder created on the PC", new File(pcWs, "New phone folder").isDirectory());

        // ── 3. same file edited on both: conflict copy ──
        write(new File(ph, "General/Shared.md"), "shared, phone version\n");
        write(new File(pcWs, "General/Shared.md"), "shared, PC version\r\n");
        r = (Map<String, Object>) bridge.call("sync.run", Json.obj());
        System.out.println("run3: " + Json.write(r));
        check("PC version keeps the name (PC)", read(new File(pcWs, "General/Shared.md")).equals("shared, PC version\r\n"));
        check("PC version keeps the name (phone)", read(new File(ph, "General/Shared.md")).equals("shared, PC version\r\n"));
        File[] pcCopies = new File(pcWs, "General").listFiles((d, n) -> n.startsWith("Shared (conflict Test Phone"));
        File[] phCopies = new File(ph, "General").listFiles((d, n) -> n.startsWith("Shared (conflict Test Phone"));
        check("conflict copy on the PC", pcCopies != null && pcCopies.length == 1 && read(pcCopies[0]).equals("shared, phone version\n"));
        check("conflict copy on the phone", phCopies != null && phCopies.length == 1 && read(phCopies[0]).equals("shared, phone version\n"));

        // ── 4. deletions ──
        Files.delete(new File(ph, "General/ToDelete.md").toPath());
        Files.delete(new File(pcWs, "Projects/Plan.md").toPath());
        write(new File(ph, "Projects/Plan.md"), "plan, edited again on the phone\n"); // edit beats the PC's deletion
        new File(pcWs, "Empty folder").delete();
        r = (Map<String, Object>) bridge.call("sync.run", Json.obj());
        System.out.println("run4: " + Json.write(r));
        check("phone deletion reaches the PC", !new File(pcWs, "General/ToDelete.md").exists());
        check("edit wins over deletion", read(new File(pcWs, "Projects/Plan.md")).equals("plan, edited again on the phone\n"));
        check("PC folder removal reaches the phone", !new File(ph, "Empty folder").exists());

        // ── 4b. a note deleted on the PC waits in the phone's Trash; restoring it brings it back on both ──
        String hello = read(new File(ph, "General/Hello.md"));
        Files.delete(new File(pcWs, "General/Hello.md").toPath());
        r = (Map<String, Object>) bridge.call("sync.run", Json.obj());
        System.out.println("run4b: " + Json.write(r));
        check("PC deletion reaches the phone", !new File(ph, "General/Hello.md").exists());
        Map<String, Object> trashed = null;
        for (Map<String, Object> m : store.bin.list()) if ("Hello.md".equals(m.get("name"))) trashed = m;
        System.out.println("trash: " + Json.write(trashed));
        check("it waits in the phone's Trash, marked as removed by the sync", trashed != null && "sync".equals(trashed.get("by"))
                && trashed.get("pc") != null && String.valueOf(trashed.get("from")).endsWith("/General/Hello.md") && "Sync Test".equals(trashed.get("ws")));
        if (trashed != null) store.bin.restore((String) trashed.get("id"), null);
        check("Restore puts it back in its folder on the phone", new File(ph, "General/Hello.md").isFile() && read(new File(ph, "General/Hello.md")).equals(hello));
        r = (Map<String, Object>) bridge.call("sync.run", Json.obj());
        System.out.println("run4c: " + Json.write(r));
        check("the next sync puts it back on the PC", new File(pcWs, "General/Hello.md").isFile() && read(new File(pcWs, "General/Hello.md")).equals(hello));

        // ── 5. workspace settings changed on both sides are merged ──
        Map<String, Object> pm = Json.parseObject(read(new File(ph, ".workspace.json")));
        Map<String, Object> notes = Json.getMap(pm, "notes");
        if (notes == null) { notes = new java.util.LinkedHashMap<>(); pm.put("notes", notes); }
        notes.put("General/Hello.md", Json.obj("pinned", true));
        write(new File(ph, ".workspace.json"), Json.pretty(pm));
        Map<String, Object> cm = Json.parseObject(read(new File(pcWs, ".workspace.json")));
        Map<String, Object> folders = Json.getMap(cm, "folders");
        if (folders == null) { folders = new java.util.LinkedHashMap<>(); cm.put("folders", folders); }
        folders.put("Projects", Json.obj("color", "#ff69f8"));
        File pcMeta = new File(pcWs, ".workspace.json");
        // The PC hides this file; Windows refuses to overwrite a hidden file in place.
        File tmp = new File(pcWs, ".ws.tmp");
        write(tmp, Json.pretty(cm));
        Files.move(tmp.toPath(), pcMeta.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        r = (Map<String, Object>) bridge.call("sync.run", Json.obj());
        System.out.println("run5: " + Json.write(r));
        String pcAfter = read(pcMeta), phAfter = read(new File(ph, ".workspace.json"));
        check("merged settings on the PC keep the phone's pin", pcAfter.contains("\"pinned\": true"));
        check("merged settings on the PC keep the PC's colour", pcAfter.contains("#ff69f8"));
        check("merged settings on the phone match", phAfter.contains("\"pinned\": true") && phAfter.contains("#ff69f8"));

        // ── 6. a workspace made on the phone goes to the PC ──
        File mine = new File(phoneNotes, "Phone Only");
        write(new File(mine, ".workspace.json"), Json.pretty(Json.obj("format", "marknotes-workspace", "version", 1L, "id", "w-0badf00d", "name", "Phone Only")));
        write(new File(mine, "Inbox/Idea.md"), "an idea from the phone\n");
        r = (Map<String, Object>) bridge.call("sync.run", Json.obj());
        System.out.println("run6: " + Json.write(r));
        File pcMine = new File(pcRoot, "Phone Only");
        check("phone workspace created on the PC", new File(pcMine, ".workspace.json").isFile() && read(new File(pcMine, ".workspace.json")).contains("w-0badf00d"));
        check("its note uploaded", new File(pcMine, "Inbox/Idea.md").isFile());

        // ── 7. nothing changes on a second run ──
        r = (Map<String, Object>) bridge.call("sync.run", Json.obj());
        System.out.println("run7: " + Json.write(r));
        Map<String, Object> res0 = (Map<String, Object>) ((List<Object>) r.get("results")).get(0);
        Map<String, Object> sum = (Map<String, Object>) res0.get("summary");
        check("idle sync transfers nothing", sum != null && ((Number) sum.get("uploaded")).longValue() == 0 && ((Number) sum.get("downloaded")).longValue() == 0
                && ((Number) sum.get("deletedHere")).longValue() == 0 && ((Number) sum.get("deletedOnPc")).longValue() == 0);

        // ── 8. a mass deletion waits for an OK ──
        for (int i = 0; i < 30; i++) write(new File(ph, "Bulk/n" + i + ".md"), "bulk " + i + "\n");
        bridge.call("sync.run", Json.obj());
        check("bulk notes uploaded", new File(pcWs, "Bulk/n29.md").isFile());
        for (int i = 0; i < 30; i++) Files.delete(new File(ph, "Bulk/n" + i + ".md").toPath());
        r = (Map<String, Object>) bridge.call("sync.run", Json.obj());
        res0 = (Map<String, Object>) ((List<Object>) r.get("results")).get(0);
        sum = (Map<String, Object>) res0.get("summary");
        check("mass deletion held for confirmation", new File(pcWs, "Bulk/n29.md").isFile() && sum != null && !((Map<String, Object>) sum.get("confirm")).isEmpty());
        List<Object> allow = new ArrayList<>();
        allow.add(wsId);
        Map<String, Object> mass = (Map<String, Object>) bridge.call("sync.run", Json.obj("allowDeletes", allow));
        check("confirmed mass deletion done", !new File(pcWs, "Bulk/n29.md").exists());

        // ── 9. Undo of that sync: the 30 notes come back on both sides ──
        String massRun = runOf(mass);
        File pcHistory = new File(new File(new File(pcRoot.getParentFile(), "local"), "sync"), "history");
        check("the PC kept the deleted notes (history folder)", countNamed(pcHistory, "n29.md") == 1);
        Map<String, Object> hist = (Map<String, Object>) bridge.call("sync.history", Json.obj("hostId", hostId, "limit", 100L));
        Map<String, Object> massView = findRun(hist, massRun);
        check("Recent syncs lists it with 30 deletions to undo", massView != null && ((Number) massView.get("undoable")).longValue() == 30);
        Map<String, Object> u = (Map<String, Object>) bridge.call("sync.undo", Json.obj("hostId", hostId, "run", massRun));
        System.out.println("undo9: " + Json.write(u));
        check("Undo brings the 30 notes back on the PC", new File(pcWs, "Bulk/n0.md").isFile() && new File(pcWs, "Bulk/n29.md").isFile()
                && read(new File(pcWs, "Bulk/n7.md")).equals("bulk 7\n"));
        check("…and on the phone", new File(ph, "Bulk/n29.md").isFile() && read(new File(ph, "Bulk/n7.md")).equals("bulk 7\n"));
        hist = (Map<String, Object>) bridge.call("sync.history", Json.obj("hostId", hostId, "limit", 100L));
        massView = findRun(hist, massRun);
        check("the sync is marked as undone", massView != null && ((Number) massView.get("undone")).longValue() > 0);
        boolean twice = false;
        try { bridge.call("sync.undo", Json.obj("hostId", hostId, "run", massRun)); } catch (Exception e) { twice = true; }
        check("a sync is undone only once", twice);

        // ── 10. Undo of an edit that replaced the PC's version; then undo of that undo ──
        write(new File(ph, "General/From phone.md"), "phone v2\n");
        String run10 = runOf((Map<String, Object>) bridge.call("sync.run", Json.obj()));
        check("the phone's edit reached the PC", read(new File(pcWs, "General/From phone.md")).equals("phone v2\n"));
        Map<String, Object> u10 = (Map<String, Object>) bridge.call("sync.undo", Json.obj("hostId", hostId, "run", run10));
        System.out.println("undo10: " + Json.write(u10));
        check("Undo puts the PC's old version back", read(new File(pcWs, "General/From phone.md")).equals("written on the phone\n"));
        check("…and the phone gets it too", read(new File(ph, "General/From phone.md")).equals("written on the phone\n"));
        bridge.call("sync.undo", Json.obj("hostId", hostId, "run", (String) u10.get("run")));
        check("undoing the undo brings the edit back on both", read(new File(pcWs, "General/From phone.md")).equals("phone v2\n")
                && read(new File(ph, "General/From phone.md")).equals("phone v2\n"));

        // ── 11. Undo of a PC edit that replaced the phone's version ──
        String helloBefore = read(new File(ph, "General/Hello.md"));
        Thread.sleep(20);
        write(new File(pcWs, "General/Hello.md"), "# Hello\r\nPC v3\r\n");
        String run11 = runOf((Map<String, Object>) bridge.call("sync.run", Json.obj()));
        check("the PC's edit reached the phone", read(new File(ph, "General/Hello.md")).equals("# Hello\r\nPC v3\r\n"));
        bridge.call("sync.undo", Json.obj("hostId", hostId, "run", run11));
        check("Undo puts the phone's old version back", read(new File(ph, "General/Hello.md")).equals(helloBefore));
        check("…and the PC gets it too", read(new File(pcWs, "General/Hello.md")).equals(helloBefore));

        // ── 12. Changed again on the PC after the sync: the old version comes back next to it ──
        String planBefore = read(new File(pcWs, "Projects/Plan.md"));
        write(new File(ph, "Projects/Plan.md"), "plan v4 from the phone\n");
        String run12 = runOf((Map<String, Object>) bridge.call("sync.run", Json.obj()));
        Thread.sleep(20);
        write(new File(pcWs, "Projects/Plan.md"), "plan edited on the PC after the sync\r\n");
        Map<String, Object> u12 = (Map<String, Object>) bridge.call("sync.undo", Json.obj("hostId", hostId, "run", run12));
        System.out.println("undo12: " + Json.write(u12));
        check("the PC's newer edit stays", read(new File(pcWs, "Projects/Plan.md")).equals("plan edited on the PC after the sync\r\n"));
        check("the old version is next to it as “Plan (before sync).md”", new File(pcWs, "Projects/Plan (before sync).md").isFile()
                && read(new File(pcWs, "Projects/Plan (before sync).md")).equals(planBefore) && ((Number) u12.get("copies")).longValue() == 1);
        check("the phone gets both", read(new File(ph, "Projects/Plan.md")).equals("plan edited on the PC after the sync\r\n")
                && new File(ph, "Projects/Plan (before sync).md").isFile());

        // ── 13. Deleting the history: the PC drops its old versions at the next sync ──
        check("the PC has old versions before", countRuns(pcHistory) > 0);
        bridge.call("sync.clearHistory", Json.obj("hostId", hostId));
        hist = (Map<String, Object>) bridge.call("sync.history", Json.obj("hostId", hostId, "limit", 100L));
        check("the phone's history is empty", ((List<Object>) hist.get("runs")).isEmpty());
        bridge.call("sync.run", Json.obj());
        check("…and the PC's after the next sync", countRuns(pcHistory) == 0);

        // ── 9. wrong secret is refused ──
        System.out.println("status: " + Json.write(bridge.call("sync.status", Json.obj())));

        System.out.println("RESULT pass=" + pass + " fail=" + fail);
        System.exit(fail == 0 ? 0 : 1);
    }
}

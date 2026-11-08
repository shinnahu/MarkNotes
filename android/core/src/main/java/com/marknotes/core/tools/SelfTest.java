package com.marknotes.core.tools;

import com.marknotes.core.Bridge;
import com.marknotes.core.Json;
import com.marknotes.core.Lang;
import com.marknotes.core.Log;
import com.marknotes.core.Trash;
import com.marknotes.core.TrashCommands;
import com.marknotes.core.store.CiMap;
import com.marknotes.core.store.NameOrder;
import com.marknotes.core.store.NoteIndex;
import com.marknotes.core.store.NoteStore;
import com.marknotes.core.store.PathUtil;
import com.marknotes.core.store.StoreCommands;
import com.marknotes.core.store.TextFiles;
import com.marknotes.core.store.UriCodec;
import com.marknotes.core.store.WorkspaceMeta;
import com.marknotes.core.store.WorkspaceRef;

import java.io.File;
import java.io.IOException;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.attribute.FileTime;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.TimeUnit;

/**
 * Plain test runner for the storage port (no test framework): runs every storage command through
 * {@code Bridge.call} on a temp folder and prints PASS/FAIL per check. Exit code 1 on any failure.
 * Run: {@code gradlew --offline -q :core:selfTest}
 */
public final class SelfTest {
    private SelfTest() {}

    private interface Body {
        void run() throws Exception;
    }

    private static final java.nio.charset.Charset UTF_8 = StandardCharsets.UTF_8;
    private static int passed, failed;
    private static final List<String> failures = new ArrayList<>();
    private static final List<String> logged = Collections.synchronizedList(new ArrayList<>());
    private static final Set<String> called = Collections.synchronizedSet(new HashSet<>());
    private static TestPlatform platform;
    private static NoteStore store;
    private static Bridge bridge;
    private static String root;
    private static File outDir;

    /** Workspace ids. */
    private static String P, T, D;
    private static final String TDIR = "Trabajo - Ideas- 2026-";

    private static final byte[] PNG = Base64.getDecoder().decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==");
    private static final byte[] GIF = Base64.getDecoder().decode("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==");
    private static final byte[] JPG = {(byte) 0xFF, (byte) 0xD8, (byte) 0xFF, (byte) 0xE0, 0, 16, 'J', 'F', 'I', 'F', 0, (byte) 0xFF, (byte) 0xD9};

    private static final String[] COMMANDS = {
            "ws.list", "ws.get", "ws.create", "ws.update", "ws.banner", "ws.guide", "ws.setGuide", "ws.features", "ws.delete", "ws.notes", "ws.files",
            "folder.create", "folder.rename", "folder.delete", "folder.setMeta", "folder.reorder", "folder.move", "folder.copy",
            "note.read", "note.write", "note.create", "note.rename", "note.move", "note.copy", "note.delete", "note.deleteIfEmpty",
            "note.setMeta", "note.stat", "note.resolveFiles", "note.info", "note.import", "note.append",
            "spine.info", "canvas.paths", "asset.save", "asset.import", "asset.rename", "asset.delete", "asset.url", "search.query",
    };

    public static void main(String[] args) {
        Log.setSink(new Log.Sink() {
            @Override
            public void info(String msg) {
                logged.add("info  " + msg);
            }

            @Override
            public void error(String msg, Throwable t) {
                logged.add("error " + msg + (t == null ? "" : ": " + t));
            }
        });
        Lang.set("en");
        try {
            platform = TestPlatform.temp();
            store = new NoteStore(platform);
            bridge = new Bridge(platform);
            StoreCommands.register(bridge, store);
            root = store.rootPath();
            outDir = new File(platform.base(), "outside");
            if (!outDir.mkdirs()) throw new IOException("Could not create " + outDir);
            System.out.println("MarkNotes storage self-test in " + platform.base());
            section("helpers", SelfTest::units);
            section("workspaces", SelfTest::workspaces);
            section("text files", SelfTest::textFiles);
            section("folders", SelfTest::folders);
            section("notes", SelfTest::notes);
            section("moving and copying with links", SelfTest::links);
            section("assets", SelfTest::assets);
            section("covers, dates and kinds", SelfTest::covers);
            section("spine and canvas", SelfTest::spineAndCanvas);
            section("search", SelfTest::search);
            section("sync hooks", SelfTest::hooks);
            section("trash (Settings › Trash)", SelfTest::trashBin);
            section("bridge messages", SelfTest::bridgeJson);
            section("parallel commands", SelfTest::concurrency);
            List<String> missing = new ArrayList<>();
            for (String c : COMMANDS) if (!bridge.has(c) || !called.contains(c)) missing.add(c);
            check("every storage command is registered and exercised (" + COMMANDS.length + ")", missing.isEmpty(), missing);
        } catch (Throwable t) {
            check("self-test setup", false, t);
            t.printStackTrace(System.out);
        } finally {
            if (platform != null) platform.deleteAll();
        }
        if (failed > 0 && !logged.isEmpty()) {
            System.out.println();
            System.out.println("Log while testing:");
            for (String l : new ArrayList<>(logged)) System.out.println("  " + l);
        }
        System.out.println();
        System.out.println(passed + " passed, " + failed + " failed");
        for (String f : failures) System.out.println("  FAILED: " + f);
        System.exit(failed == 0 && passed > 0 ? 0 : 1);
    }

    // ------------------------------------------------------------------ test plumbing

    private static void section(String name, Body body) {
        System.out.println();
        System.out.println("== " + name);
        try {
            body.run();
        } catch (Throwable t) {
            check(name + " finished without an exception", false, t);
            t.printStackTrace(System.out);
        }
    }

    private static void check(String name, boolean ok) {
        check(name, ok, null);
    }

    private static void check(String name, boolean ok, Object detail) {
        if (ok) {
            passed++;
            System.out.println("PASS " + name);
        } else {
            failed++;
            failures.add(name);
            System.out.println("FAIL " + name + (detail == null ? "" : "  —  " + show(detail)));
        }
    }

    private static String show(Object o) {
        if (o instanceof String) return "\"" + ((String) o).replace("\r", "\\r").replace("\n", "\\n") + "\"";
        return String.valueOf(o);
    }

    private static boolean same(Object a, Object b) {
        if (a instanceof Number && b instanceof Number) return ((Number) a).doubleValue() == ((Number) b).doubleValue();
        return Objects.equals(a, b);
    }

    private static void eq(String name, Object expected, Object actual) {
        check(name, same(expected, actual), "expected " + show(expected) + ", got " + show(actual));
    }

    private static void keys(String name, Map<String, Object> m, String... expected) {
        eq(name, String.join(",", expected), m == null ? null : String.join(",", m.keySet()));
    }

    private static boolean throwsEx(Body b) {
        try {
            b.run();
            return false;
        } catch (Exception e) {
            return true;
        }
    }

    /** A command's result as the interface gets it (serialized to JSON and parsed back). */
    private static Object call(String cmd, Object... kv) throws Exception {
        called.add(cmd);
        return Json.parse(Json.write(bridge.call(cmd, Json.obj(kv))));
    }

    private static Map<String, Object> callMap(String cmd, Object... kv) throws Exception {
        return m(call(cmd, kv));
    }

    private static List<Object> callList(String cmd, Object... kv) throws Exception {
        return l(call(cmd, kv));
    }

    /** The error message of a command that must fail (null when it did not). */
    private static String error(String cmd, Object... kv) {
        called.add(cmd);
        try {
            bridge.call(cmd, Json.obj(kv));
            return null;
        } catch (Exception e) {
            return e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> m(Object o) {
        return (Map<String, Object>) o;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> l(Object o) {
        return (List<Object>) o;
    }

    private static String s(Object o) {
        return o == null ? "" : String.valueOf(o);
    }

    private static long num(Object o) {
        return o instanceof Number ? ((Number) o).longValue() : Long.MIN_VALUE;
    }

    private static String repeat(String s, int n) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < n; i++) sb.append(s);
        return sb.toString();
    }

    private static String b64(byte[] b) {
        return Base64.getEncoder().encodeToString(b);
    }

    private static File f(String rel) {
        return rel.isEmpty() ? new File(root) : new File(root, rel.replace('/', File.separatorChar));
    }

    private static boolean exists(String rel) {
        return f(rel).exists();
    }

    private static byte[] bytes(String rel) throws IOException {
        return Files.readAllBytes(f(rel).toPath());
    }

    private static String text(String rel) throws IOException {
        return new String(bytes(rel), UTF_8);
    }

    private static void writeBytes(File x, byte[] b) throws IOException {
        File parent = x.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("Could not create " + parent);
        Files.write(x.toPath(), b);
    }

    private static void writeBytes(String rel, byte[] b) throws IOException {
        writeBytes(f(rel), b);
    }

    private static void writeText(String rel, String s) throws IOException {
        writeBytes(rel, s.getBytes(UTF_8));
    }

    private static void mkdir(String rel) throws IOException {
        File d = f(rel);
        if (!d.isDirectory() && !d.mkdirs()) throw new IOException("Could not create " + d);
    }

    private static List<String> namesIn(String rel) {
        String[] l = f(rel).list();
        return l == null ? new ArrayList<>() : Arrays.asList(l);
    }

    private static long mtime(String rel) throws IOException {
        return Files.getLastModifiedTime(f(rel).toPath()).toMillis();
    }

    private static void setMtime(String rel, long ms) throws IOException {
        Files.setLastModifiedTime(f(rel).toPath(), FileTime.fromMillis(ms));
    }

    private static boolean trashHas(String name) {
        String[] l = platform.trashDir().list();
        if (l != null) for (String x : l) if (x.endsWith("-" + name)) return true;
        return false;
    }

    private static void deleteTree(File d) throws IOException {
        File[] kids = d.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        Files.deleteIfExists(d.toPath());
    }

    private static String ids(List<Object> wsList) {
        List<String> out = new ArrayList<>();
        for (Object o : wsList) out.add(s(m(o).get("id")));
        return String.join(",", out);
    }

    private static Map<String, Object> byDir(List<Object> wsList, String dir) {
        for (Object o : wsList) if (dir.equals(m(o).get("dir"))) return m(o);
        return null;
    }

    private static Map<String, Object> byTitle(List<Object> notes, String title) {
        for (Object o : notes) if (title.equals(m(o).get("title"))) return m(o);
        return null;
    }

    private static String paths(Map<String, Object> ws) {
        List<String> out = new ArrayList<>();
        for (Object o : l(ws.get("folders"))) out.add(s(m(o).get("path")));
        return String.join("|", out);
    }

    private static Map<String, Object> folderByPath(Map<String, Object> ws, String path) {
        for (Object o : l(ws.get("folders"))) if (path.equals(m(o).get("path"))) return m(o);
        return null;
    }

    private static String join(List<Object> list) {
        List<String> out = new ArrayList<>();
        for (Object o : list) out.add(s(o));
        return String.join("|", out);
    }

    private static long createdMs(String wsDir, String key) throws IOException {
        Map<String, Object> meta = Json.parseObject(text(wsDir + "/.workspace.json"));
        return Instant.parse(s(m(m(meta.get("notes")).get(key)).get("created"))).toEpochMilli();
    }

    /** The bytes a file with this text, encoding and line ends has (built with the JDK's own charsets). */
    private static byte[] encoded(String text, String enc, String eol) {
        String nl = eol.equals("lf") ? "\n" : eol.equals("cr") ? "\r" : "\r\n";
        String b = text.replace("\n", nl);
        byte[] body;
        byte[] bom = new byte[0];
        switch (enc) {
            case "utf8bom" -> {
                bom = new byte[] {(byte) 0xEF, (byte) 0xBB, (byte) 0xBF};
                body = b.getBytes(UTF_8);
            }
            case "utf16le" -> {
                bom = new byte[] {(byte) 0xFF, (byte) 0xFE};
                body = b.getBytes(StandardCharsets.UTF_16LE);
            }
            case "utf16be" -> {
                bom = new byte[] {(byte) 0xFE, (byte) 0xFF};
                body = b.getBytes(StandardCharsets.UTF_16BE);
            }
            case "ansi" -> body = b.getBytes(Charset.forName("windows-1252"));
            default -> body = b.getBytes(UTF_8);
        }
        byte[] r = new byte[bom.length + body.length];
        System.arraycopy(bom, 0, r, 0, bom.length);
        System.arraycopy(body, 0, r, bom.length, body.length);
        return r;
    }

    // ------------------------------------------------------------------ helpers (units)

    private static void units() {
        CiMap<String> cm = new CiMap<>();
        cm.put("General", "a");
        cm.put("Notes/x.md", "b");
        cm.put("GENERAL", "c");
        eq("CiMap: lookups ignore case", "c", cm.get("general"));
        eq("CiMap: the first spelling of a key is kept", "General,Notes/x.md", String.join(",", cm.keySet()));
        cm.remove("notes/X.MD");
        eq("CiMap: remove ignores case", 1, cm.size());

        List<String> names = new ArrayList<>(Arrays.asList("Zeta", "10 Ten", "beta", "Álbum", "2 Two", "alpha", "ab", "_Archive", "a b"));
        names.sort(NameOrder.LOGICAL);
        eq("Explorer name order", "_Archive|2 Two|10 Ten|a b|ab|Álbum|alpha|beta|Zeta", String.join("|", names));
        String emoji = new String(Character.toChars(0x1F600)) + " smile";
        List<String> word = new ArrayList<>(Arrays.asList(emoji, "file-1", "1", "co-op", "-dash", "file1", "01", "coop", "001", "eclair", "co op"));
        word.sort(NameOrder.LOGICAL);
        eq("Explorer order: leading zeros, hyphens skipped (word sort), emoji last (as on Windows)",
                "001|01|1|co op|coop|co-op|-dash|eclair|file1|file-1|" + emoji, String.join("|", word));

        eq("EscapeDataString", "a%20b%2F%C3%B1~%28x%29.png", UriCodec.escapeDataString("a b/ñ~(x).png"));
        eq("UnescapeDataString leaves bad sequences", "a bñ%FF%zz%", UriCodec.unescapeDataString("a%20b%C3%B1%FF%zz%"));

        eq("SanitizeName: forbidden characters", "Trabajo - Ideas- 2026-", NoteStore.sanitizeName("Trabajo / Ideas: 2026?", 60));
        eq("SanitizeName: dots and spaces at the ends", "hidden", NoteStore.sanitizeName("  ..hidden.  "));
        eq("SanitizeName: white space collapsed, control characters -> -", "a b|a-- b", NoteStore.sanitizeName("a  \u00A0 b") + "|" + NoteStore.sanitizeName("a\t\n b"));
        eq("SanitizeName: reserved names", "_CON|_con.txt", NoteStore.sanitizeName("CON") + "|" + NoteStore.sanitizeName("con.txt"));
        eq("SanitizeName: empty", "Untitled", NoteStore.sanitizeName(""));
        eq("SanitizeName: length", 80, NoteStore.sanitizeName(repeat("x", 100)).length());

        char sep = PathUtil.SEP;
        String a = root + sep + "Ws" + sep + "Sub" + sep + "x.md";
        check("IsInside ignores case", PathUtil.isInside(a, root.toUpperCase(java.util.Locale.ROOT) + sep + "ws"));
        check("IsInside: a folder is not inside itself", !PathUtil.isInside(root + sep + "Ws", root + sep + "Ws" + sep));
        check("PathEq resolves ..", PathUtil.pathEq(root + sep + "a" + sep + ".." + sep + "B", root + sep + "b" + sep));
        eq("GetRelativePath", ".." + sep + ".." + sep + "c" + sep + "d.png", PathUtil.relPath(root + sep + "a" + sep + "b", root + sep + "c" + sep + "d.png"));
        eq("Rel uses /", "Ws/Sub/x.md", PathUtil.rel(root, a));
        eq("GetExtension / GetFileNameWithoutExtension", ".gz|a.tar||a", PathUtil.ext("a.tar.gz") + "|" + PathUtil.stem("a.tar.gz") + "|" + PathUtil.ext("a.") + "|" + PathUtil.stem("a."));

        eq("EncodeLink", "a%20b/%28c%29%25.png", NoteStore.encodeLink("a b\\(c)%.png"));
        eq("DecodeLink", "a b.png", NoteStore.decodeLink(" <a%20b.png> "));
        eq("CleanTarget: wiki embed", "pic.png", NoteIndex.cleanTarget("![[pic.png|300]]"));
        eq("CleanTarget: markdown link", "my pic.png", NoteIndex.cleanTarget("[t](<my pic.png>)"));
        check("CleanTarget: web URL", NoteIndex.cleanTarget("https://x.com/y.png") == null);
        eq("CleanTarget: quotes and anchors", "cover.jpg|a", NoteIndex.cleanTarget("\"cover.jpg\"") + "|" + NoteIndex.cleanTarget("[[a#b]]"));

        String inside = root + sep + "Ws" + sep + "a b" + sep + "ñ.png";
        String url = NoteStore.fileUrl(inside, root);
        eq("FileUrl inside the notes folder", "https://files.marknotes.example/r/Ws/a%20b/%C3%B1.png", url);
        eq("resolveFileUrl gives the file back", inside, s(store.resolveFileUrl(url + "?v=1")));
        String outside = new File(outDir, "o x.png").getAbsolutePath();
        String ourl = NoteStore.fileUrl(outside, root);
        check("FileUrl outside the notes folder uses /a/", ourl.startsWith("https://files.marknotes.example/a/") && ourl.endsWith("/outside/o%20x.png"), ourl);
        eq("resolveFileUrl /a/", outside, s(store.resolveFileUrl(ourl)));
        check("resolveFileUrl never leaves the notes folder through /r/", store.resolveFileUrl("/r/..%2F..%2Fsecret.txt") == null
                && store.resolveFileUrl("/r/Ws/../../secret.txt") == null);

        WorkspaceMeta wm = WorkspaceMeta.parse("{\"ID\":\"w-1\",\"Name\":\"N\",\"Folders\":{\"A\":{\"Order\":\"3\",\"Bad\":1}},\"Notes\":{},\"later\":[1,2]}");
        eq("metadata: property names ignore case, numbers read from strings", "w-1|N|3", wm.id + "|" + wm.name + "|" + wm.folders.get("a").order);
        String pj = wm.toPrettyJson();
        check("metadata written like the PC (camelCase, CRLF, no nulls, unknown properties kept)",
                pj.equals("{\r\n  \"format\": \"marknotes-workspace\",\r\n  \"version\": 1,\r\n  \"id\": \"w-1\",\r\n  \"name\": \"N\",\r\n"
                        + "  \"folders\": {\r\n    \"A\": {\r\n      \"order\": 3,\r\n      \"Bad\": 1\r\n    }\r\n  },\r\n  \"notes\": {},\r\n"
                        + "  \"later\": [\r\n    1,\r\n    2\r\n  ]\r\n}"), pj);
        // Written by the PC (.NET 8 System.Text.Json, JsonOpts.Pretty): emoji, DEL, NBSP and U+2028 escaped, CRLF.
        String fromPc = "{\r\n"
                + "  \"format\": \"marknotes-workspace\",\r\n"
                + "  \"version\": 1,\r\n"
                + "  \"id\": \"w-1234abcd\",\r\n"
                + "  \"name\": \"Caf\u00e9 \u2615 \\uD83D\\uDCDA \\\"q\\\" <b> & 'x'\",\r\n"
                + "  \"color\": \"#5865f2\",\r\n"
                + "  \"bannerHover\": true,\r\n"
                + "  \"guide\": \"L\u00ednea\\n\\ttab \\\\ back\\u0001ctl\\u007F del \\u2028 ls \\u00A0 nbsp\",\r\n"
                + "  \"created\": \"2026-11-07T00:00:00.0000000Z\",\r\n"
                + "  \"folders\": {\r\n"
                + "    \"Notas\": {\r\n"
                + "      \"icon\": \"\\uD83D\\uDCDA\",\r\n"
                + "      \"order\": 0\r\n"
                + "    },\r\n"
                + "    \"Proyectos/2024\": {\r\n"
                + "      \"color\": \"#fff\",\r\n"
                + "      \"description\": \"A\u00f1o\"\r\n"
                + "    }\r\n"
                + "  },\r\n"
                + "  \"notes\": {\r\n"
                + "    \"Notas/a.md\": {\r\n"
                + "      \"pinned\": true,\r\n"
                + "      \"created\": \"2026-01-02T03:04:05.0000000Z\"\r\n"
                + "    }\r\n"
                + "  }\r\n"
                + "}";
        eq("a .workspace.json written by the PC is written back byte for byte", fromPc, WorkspaceMeta.parse(fromPc).toPrettyJson());
    }

    // ------------------------------------------------------------------ workspaces

    private static void workspaces() throws Exception {
        eq("ws.list of an empty notes folder", 0, callList("ws.list").size());
        Map<String, Object> p = callMap("ws.create", "name", "Personal", "color", "#5865f2", "firstFolder", "Notes");
        keys("ws.create result fields (WorkspaceDto)", p, "id", "name", "dir", "color", "iconUrl", "created", "folders", "looseCount", "linked",
                "root", "vault", "bannerUrl", "bannerHover", "guideOn", "browseOn");
        P = s(p.get("id"));
        check("workspace id is w-xxxxxxxx", P.matches("w-[0-9a-f]{8}"), P);
        eq("ws.create name/dir/color", "Personal|Personal|#5865f2", p.get("name") + "|" + p.get("dir") + "|" + p.get("color"));
        check("ws.create iconUrl is null (and present)", p.containsKey("iconUrl") && p.get("iconUrl") == null);
        check("created is DateTime.UtcNow.ToString(\"o\")", s(p.get("created")).matches("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{7}Z"), p.get("created"));
        eq("ws.create looseCount/linked/vault", "0|false|false", p.get("looseCount") + "|" + p.get("linked") + "|" + p.get("vault"));
        eq("ws.create root is the folder", new File(root, "Personal").getPath(), p.get("root"));
        check("ws.create bannerUrl null", p.containsKey("bannerUrl") && p.get("bannerUrl") == null);
        eq("ws.create bannerHover/guideOn/browseOn", "false|false|false", p.get("bannerHover") + "|" + p.get("guideOn") + "|" + p.get("browseOn"));
        List<Object> folders = l(p.get("folders"));
        eq("first folder", 1, folders.size());
        Map<String, Object> nf = m(folders.get(0));
        keys("folder fields (FolderDto)", nf, "path", "name", "color", "icon", "order", "count", "ctime", "description");
        eq("first folder path/name/order/count", "Notes|Notes|0|0", nf.get("path") + "|" + nf.get("name") + "|" + nf.get("order") + "|" + nf.get("count"));
        check("first folder ctime", num(nf.get("ctime")) > 0, nf.get("ctime"));
        String expected = "{\r\n  \"format\": \"marknotes-workspace\",\r\n  \"version\": 1,\r\n  \"id\": \"" + P + "\",\r\n  \"name\": \"Personal\",\r\n"
                + "  \"color\": \"#5865f2\",\r\n  \"created\": \"" + p.get("created") + "\",\r\n  \"folders\": {\r\n    \"Notes\": {\r\n      \"order\": 0\r\n"
                + "    }\r\n  },\r\n  \"notes\": {}\r\n}";
        eq(".workspace.json looks like the PC's (indented, CRLF, nulls left out)", expected, text("Personal/.workspace.json"));

        Map<String, Object> t = callMap("ws.create", "name", "Trabajo / Ideas: 2026?", "icon", "data:image/png;base64," + b64(PNG));
        T = s(t.get("id"));
        eq("ws.create makes the folder name safe, keeps the display name", TDIR + "|Trabajo / Ideas: 2026?", t.get("dir") + "|" + t.get("name"));
        check("ws.create iconUrl", s(t.get("iconUrl")).startsWith("https://files.marknotes.example/r/Trabajo%20-%20Ideas-%202026-/.workspace-icon.png?v="), t.get("iconUrl"));
        check("icon file written", Arrays.equals(PNG, bytes(TDIR + "/.workspace-icon.png")));
        eq("default first folder", "General", m(l(t.get("folders")).get(0)).get("path"));
        Map<String, Object> d = callMap("ws.create", "name", "personal");
        D = s(d.get("id"));
        eq("unique folder names ignore case", "personal (2)", d.get("dir"));
        Map<String, Object> w = callMap("ws.create", "name", "   ", "firstFolder", "");
        eq("blank name -> Workspace, no first folder", "Workspace|Workspace|0", w.get("name") + "|" + w.get("dir") + "|" + l(w.get("folders")).size());
        String W = s(w.get("id"));
        eq("ws.list in folder order", P + "," + D + "," + T + "," + W, ids(callList("ws.list")));
        eq("ws.get", "Personal", callMap("ws.get", "id", P).get("name"));
        eq("ws.get without id", "Missing id", error("ws.get"));
        eq("ws.get of an unknown id", "Workspace not found", error("ws.get", "id", "w-00000000"));

        Map<String, Object> u = callMap("ws.update", "id", D, "name", "Diario");
        keys("ws.update result fields", u, "ws", "oldDir");
        eq("ws.update renames the folder", "personal (2)|Diario", u.get("oldDir") + "|" + m(u.get("ws")).get("dir"));
        check("renamed on disk", !exists("personal (2)") && exists("Diario/.workspace.json"));
        u = callMap("ws.update", "id", D, "name", "diario");
        eq("case-only workspace rename", "Diario|diario", u.get("oldDir") + "|" + m(u.get("ws")).get("dir"));
        check("case-only rename on disk", namesIn("").contains("diario") && !namesIn("").contains("Diario"), namesIn(""));
        u = callMap("ws.update", "id", D, "name", "diario", "color", "#123456");
        check("same name -> oldDir null", u.containsKey("oldDir") && u.get("oldDir") == null);
        eq("ws.update color", "#123456", m(u.get("ws")).get("color"));
        u = callMap("ws.update", "id", D, "name", "diario");
        eq("colour kept when not given", "#123456", m(u.get("ws")).get("color"));
        u = callMap("ws.update", "id", D, "color", null);
        check("color: null clears it", m(u.get("ws")).get("color") == null);
        u = callMap("ws.update", "id", T, "icon", "data:image/jpeg;base64," + b64(JPG));
        check("ws.update icon (JPEG)", s(m(u.get("ws")).get("iconUrl")).contains("/.workspace-icon.jpg?v="), m(u.get("ws")).get("iconUrl"));
        check("old icon file removed", !exists(TDIR + "/.workspace-icon.png") && exists(TDIR + "/.workspace-icon.jpg"));
        u = callMap("ws.update", "id", T, "removeIcon", true);
        check("ws.update removeIcon", m(u.get("ws")).get("iconUrl") == null && !exists(TDIR + "/.workspace-icon.jpg"));

        Map<String, Object> bw = callMap("ws.banner", "id", P, "data", "data:image/gif;base64," + b64(GIF), "hover", true);
        check("ws.banner", s(bw.get("bannerUrl")).startsWith("https://files.marknotes.example/r/Personal/.workspace-banner.gif?v=")
                && Boolean.TRUE.equals(bw.get("bannerHover")), bw.get("bannerUrl"));
        check("banner in .workspace.json", text("Personal/.workspace.json").contains("\"banner\": \".workspace-banner.gif\",\r\n  \"bannerHover\": true,"));
        bw = callMap("ws.banner", "id", P, "remove", true);
        check("ws.banner remove", bw.get("bannerUrl") == null && !exists("Personal/.workspace-banner.gif"));
        eq("hover kept when not given", true, bw.get("bannerHover"));
        bw = callMap("ws.banner", "id", P, "hover", false);
        check("hover false is left out of the file", Boolean.FALSE.equals(bw.get("bannerHover")) && !text("Personal/.workspace.json").contains("bannerHover"));

        eq("ws.guide empty", "", call("ws.guide", "id", P));
        check("ws.setGuide returns null", call("ws.setGuide", "id", P, "text", "# Guía\n\nHola") == null);
        eq("ws.guide text", "# Guía\n\nHola", call("ws.guide", "id", P));
        call("ws.setGuide", "id", P, "text", "   ");
        eq("blank guide removed", "", call("ws.guide", "id", P));
        Map<String, Object> ft = callMap("ws.features", "id", P, "guide", true);
        eq("ws.features guide on", "true|false", ft.get("guideOn") + "|" + ft.get("browseOn"));
        ft = callMap("ws.features", "id", P, "browse", true);
        eq("ws.features browse on", "true|true", ft.get("guideOn") + "|" + ft.get("browseOn"));
        ft = callMap("ws.features", "id", P, "guide", false);
        eq("ws.features guide off, browse kept", "false|true", ft.get("guideOn") + "|" + ft.get("browseOn"));

        check("ws.delete returns null", call("ws.delete", "id", W) == null);
        check("ws.delete moves the folder to the trash", !exists("Workspace") && trashHas("Workspace"));
        check("deleted workspace no longer listed", !ids(callList("ws.list")).contains(W));
        eq("deleted workspace not found", "Workspace not found", error("ws.get", "id", W));

        mkdir("Imported/Sub");
        writeText("Imported/loose.md", "x");
        mkdir(".hidden");
        mkdir("~tmp");
        mkdir("$x");
        List<Object> list = callList("ws.list");
        Map<String, Object> imp = byDir(list, "Imported");
        check("a folder without metadata becomes a workspace", imp != null && "Imported".equals(imp.get("name")) && num(imp.get("looseCount")) == 1, imp);
        check("its .workspace.json is created", imp != null && text("Imported/.workspace.json").contains("\"id\": \"" + imp.get("id") + "\""));
        check("hidden folders are not workspaces", byDir(list, ".hidden") == null && byDir(list, "~tmp") == null && byDir(list, "$x") == null);
        mkdir("ImportedCopy");
        Files.copy(f("Imported/.workspace.json").toPath(), f("ImportedCopy/.workspace.json").toPath());
        Map<String, Object> cp = byDir(callList("ws.list"), "ImportedCopy");
        check("a copied workspace folder gets an id of its own", imp != null && cp != null && !s(cp.get("id")).equals(imp.get("id"))
                && text("ImportedCopy/.workspace.json").contains(s(cp.get("id"))), cp);
        call("ws.delete", "id", s(cp == null ? "" : cp.get("id")));
        call("ws.delete", "id", s(imp == null ? "" : imp.get("id")));

        mkdir("PcStyle/A");
        writeText("PcStyle/A/n.md", "pc");
        writeText("PcStyle/.workspace.json", "\uFEFF{\"Format\":\"marknotes-workspace\",\"Version\":\"1\",\"ID\":\"w-12345678\",\"Name\":\"From PC\","
                + "\"Folders\":{\"A\":{\"Order\":\"5\",\"Color\":\"#fff\"}},\"Notes\":{\"A/N.md\":{\"Pinned\":true}},\"futureField\":{\"x\":1}}");
        Map<String, Object> pc = byDir(callList("ws.list"), "PcStyle");
        eq("PC metadata with a BOM, other property case, numbers as strings", "w-12345678|From PC", pc == null ? null : pc.get("id") + "|" + pc.get("name"));
        Map<String, Object> fa = pc == null ? null : folderByPath(pc, "A");
        eq("its folder metadata", "5|#fff", fa == null ? null : fa.get("order") + "|" + fa.get("color"));
        Map<String, Object> pn = byTitle(callList("ws.notes", "id", "w-12345678"), "n");
        eq("note metadata keys ignore case (A/N.md vs A/n.md)", true, pn == null ? null : pn.get("pinned"));
        call("folder.setMeta", "wsId", "w-12345678", "name", "A", "icon", "book");
        String pcText = text("PcStyle/.workspace.json");
        check("saved with camelCase names", pcText.startsWith("{\r\n  \"format\": \"marknotes-workspace\",\r\n  \"version\": 1,\r\n  \"id\": \"w-12345678\",\r\n  \"name\": \"From PC\","), pcText);
        check("unknown properties survive a save", pcText.contains("\"futureField\": {\r\n    \"x\": 1\r\n  }"), pcText);
        check("keys keep their first spelling", pcText.contains("\"A/N.md\": {\r\n      \"pinned\": true\r\n    }"), pcText);
    }

    // ------------------------------------------------------------------ text files

    private static void textFiles() throws Exception {
        callMap("ws.create", "name", "Texts", "firstFolder", "");
        String body = "Línea uno\nSegunda línea ñ €\n\nÚltima";
        String[][] cases = {{"utf8", "crlf"}, {"utf8", "lf"}, {"utf8", "cr"}, {"utf8bom", "crlf"}, {"utf8bom", "lf"}, {"utf16le", "crlf"},
                {"utf16le", "lf"}, {"utf16be", "crlf"}, {"utf16be", "cr"}, {"ansi", "crlf"}, {"ansi", "lf"}};
        for (String[] c : cases) {
            String rel = "Texts/" + c[0] + "-" + c[1] + ".md";
            byte[] raw = encoded(body, c[0], c[1]);
            writeBytes(rel, raw);
            Map<String, Object> r = callMap("note.read", "path", rel);
            eq("read " + c[0] + " " + c[1], c[0] + "|" + c[1] + "|" + body, r.get("encoding") + "|" + r.get("eol") + "|" + r.get("text"));
            Map<String, Object> w = callMap("note.write", "path", rel, "text", r.get("text"), "encoding", r.get("encoding"), "eol", r.get("eol"),
                    "expectMtime", r.get("mtime"));
            check("save " + c[0] + " " + c[1] + " gives the same bytes back", Boolean.FALSE.equals(w.get("conflict")) && Arrays.equals(raw, bytes(rel)));
        }
        writeBytes("Texts/mixed.md", "a\r\nb\r\nc\nd".getBytes(UTF_8));
        Map<String, Object> r = callMap("note.read", "path", "Texts/mixed.md");
        eq("mostly CRLF -> crlf, text uses \\n", "crlf|a\nb\nc\nd", r.get("eol") + "|" + r.get("text"));
        writeBytes("Texts/mixed2.md", "a\nb\rc\rd".getBytes(UTF_8));
        eq("mostly CR -> cr", "cr", callMap("note.read", "path", "Texts/mixed2.md").get("eol"));
        writeBytes("Texts/empty.md", new byte[0]);
        r = callMap("note.read", "path", "Texts/empty.md");
        eq("empty file", "utf8|crlf|", r.get("encoding") + "|" + r.get("eol") + "|" + r.get("text"));

        byte[] all = new byte[254];
        for (int i = 0, k = 0; i < 256; i++) if (i != 10 && i != 13) all[k++] = (byte) i;
        TextFiles.TextContent tc = TextFiles.decode(all);
        eq("bytes that are not UTF-8 read as ANSI", "ansi", tc.encoding);
        String jdk = new String(all, Charset.forName("windows-1252"));
        StringBuilder want = new StringBuilder();
        for (int i = 0; i < all.length; i++) {
            int b = all[i] & 0xFF;
            want.append(b == 0x81 || b == 0x8D || b == 0x8F || b == 0x90 || b == 0x9D ? (char) b : jdk.charAt(i));
        }
        eq("ANSI is Windows-1252 (undefined bytes kept as C1 controls)", want.toString(), tc.text);
        check("every ANSI byte survives a round trip", Arrays.equals(all, TextFiles.encode(tc.text, "ansi", tc.eol)));
        eq("ANSI text with characters 1252 lacks is saved as UTF-8", "日本 €", new String(TextFiles.encode("日本 €", "ansi", "lf"), UTF_8));
        check("a lone surrogate becomes U+FFFD in UTF-8", Arrays.equals(new byte[] {'a', (byte) 0xEF, (byte) 0xBF, (byte) 0xBD}, TextFiles.encode("a\uD800", "utf8", "lf")));
        writeText("Texts/long.md", repeat("ñ", 50) + "abc");
        eq("Preview stops at maxChars without breaking UTF-8", repeat("ñ", 10), TextFiles.preview(f("Texts/long.md").getPath(), 10));

        writeBytes("Texts/app.md", encoded("uno", "utf16le", "crlf"));
        Object mt = call("note.append", "path", "Texts/app.md", "text", "\ndós");
        check("note.append keeps encoding and line ends", Arrays.equals(encoded("uno\ndós", "utf16le", "crlf"), bytes("Texts/app.md")));
        eq("note.append returns the new mtime", mtime("Texts/app.md"), num(mt));
    }

    // ------------------------------------------------------------------ folders

    private static void folders() throws Exception {
        Map<String, Object> f1 = callMap("folder.create", "wsId", P, "name", "Projects", "parent", "");
        keys("folder.create result fields", f1, "path", "name", "color", "icon", "order", "count", "ctime", "description");
        eq("folder.create", "Projects|Projects|1|0", f1.get("path") + "|" + f1.get("name") + "|" + f1.get("order") + "|" + f1.get("count"));
        Map<String, Object> f2 = callMap("folder.create", "wsId", P, "name", "2024", "parent", "Projects");
        eq("subfolder", "Projects/2024|0", f2.get("path") + "|" + f2.get("order"));
        Map<String, Object> f3 = callMap("folder.create", "wsId", P, "name", "projects", "parent", "");
        eq("folder names unique ignoring case", "projects (2)|2", f3.get("path") + "|" + f3.get("order"));
        eq("folder.create outside the workspace", "Attempted to perform an unauthorized operation.", error("folder.create", "wsId", P, "name", "x", "parent", "../.."));
        Map<String, Object> f4 = callMap("folder.create", "wsId", P, "name", "a/b:c");
        eq("folder.create makes the name safe", "a-b-c|3", f4.get("path") + "|" + f4.get("order"));

        for (String n : new String[] {"10 Ten", "2 Two", "_Archive", "beta", "Álbum"}) mkdir("Personal/Projects/" + n);
        writeText("Personal/Projects/2024/a.md", "a");
        writeText("Personal/Projects/2024/b.md", "b");
        writeText("Personal/loose.md", "l");
        Map<String, Object> pw = callMap("ws.get", "id", P);
        eq("folder tree: orders first, then Explorer's name order",
                "Notes|Projects|Projects/2024|Projects/_Archive|Projects/2 Two|Projects/10 Ten|Projects/Álbum|Projects/beta|projects (2)|a-b-c", paths(pw));
        eq("folder note counts and loose notes", "2|1", folderByPath(pw, "Projects/2024").get("count") + "|" + pw.get("looseCount"));

        check("folder.setMeta returns null", call("folder.setMeta", "wsId", P, "name", "Projects", "color", "#ff0000", "icon", "star",
                "description", "  Mis proyectos  ") == null);
        Map<String, Object> pf = folderByPath(callMap("ws.get", "id", P), "Projects");
        eq("folder.setMeta", "#ff0000|star|Mis proyectos", pf.get("color") + "|" + pf.get("icon") + "|" + pf.get("description"));
        call("folder.setMeta", "wsId", P, "name", "projects", "color", "");
        pf = folderByPath(callMap("ws.get", "id", P), "Projects");
        eq("colour cleared (name matched ignoring case), icon kept", "null|star", pf.get("color") + "|" + pf.get("icon"));
        check("folder.reorder returns null", call("folder.reorder", "wsId", P, "names", Arrays.asList("projects (2)", "Projects", "Notes")) == null);
        eq("folder.reorder", "projects (2)|Projects|Projects/2024|Projects/_Archive|Projects/2 Two|Projects/10 Ten|Projects/Álbum|Projects/beta|Notes|a-b-c",
                paths(callMap("ws.get", "id", P)));

        call("note.setMeta", "path", "Personal/Projects/2024/a.md", "patch", Json.obj("color", "#00ff00"));
        Map<String, Object> rn = callMap("folder.rename", "wsId", P, "name", "Projects", "newName", "Proyectos");
        keys("folder.rename result fields", rn, "name", "path", "oldPrefix", "newPrefix");
        eq("folder.rename", "Proyectos|Proyectos|Personal/Projects/|Personal/Proyectos/",
                rn.get("name") + "|" + rn.get("path") + "|" + rn.get("oldPrefix") + "|" + rn.get("newPrefix"));
        String meta = text("Personal/.workspace.json");
        check("folder and note metadata follow the rename", meta.contains("\"Proyectos\": {") && meta.contains("\"Proyectos/2024\": {")
                && meta.contains("\"Proyectos/2024/a.md\": {") && !meta.contains("\"Projects\""), meta);
        rn = callMap("folder.rename", "wsId", P, "name", "Proyectos", "newName", "proyectos");
        check("case-only folder rename", "proyectos".equals(rn.get("path")) && namesIn("Personal").contains("proyectos") && !namesIn("Personal").contains("Proyectos"),
                namesIn("Personal"));
        eq("rename onto an existing name", "Notes (2)", callMap("folder.rename", "wsId", P, "name", "a-b-c", "newName", "Notes").get("path"));
        eq("folder.rename of a missing folder", "nope", error("folder.rename", "wsId", P, "name", "nope", "newName", "x"));

        Map<String, Object> mv = callMap("folder.move", "wsId", P, "name", "proyectos/2024", "parent", "Notes");
        keys("folder.move result fields", mv, "path", "oldPrefix", "newPrefix");
        eq("folder.move", "Notes/2024|Personal/proyectos/2024/|Personal/Notes/2024/", mv.get("path") + "|" + mv.get("oldPrefix") + "|" + mv.get("newPrefix"));
        check("moved on disk with its note metadata", exists("Personal/Notes/2024/a.md") && !exists("Personal/proyectos/2024")
                && text("Personal/.workspace.json").contains("\"Notes/2024/a.md\": {"));
        eq("folder.move to the same parent", "Notes/2024", callMap("folder.move", "wsId", P, "name", "Notes/2024", "parent", "Notes").get("path"));
        eq("folder.move into itself", "A folder can't go inside itself.", error("folder.move", "wsId", P, "name", "Notes", "parent", "Notes/2024"));
        eq("folder.move to the top level", "2024", callMap("folder.move", "wsId", P, "name", "Notes/2024", "parent", "").get("path"));
        Map<String, Object> fc = callMap("folder.copy", "wsId", P, "name", "2024", "parent", "");
        keys("folder.copy result fields", fc, "path");
        eq("folder.copy next to itself", "2024 (2)", fc.get("path"));
        check("copied files are identical", Arrays.equals(bytes("Personal/2024/a.md"), bytes("Personal/2024 (2)/a.md")));
        eq("folder.copy into itself", "A folder can't be copied inside itself.", error("folder.copy", "wsId", P, "name", "2024", "parent", "2024"));
        check("folder.delete returns null", call("folder.delete", "wsId", P, "name", "2024 (2)") == null);
        check("folder.delete moves it to the trash and forgets its metadata", !exists("Personal/2024 (2)") && trashHas("2024 (2)")
                && !text("Personal/.workspace.json").contains("2024 (2)"));
        eq("folder.delete of the workspace itself", "Attempted to perform an unauthorized operation.", error("folder.delete", "wsId", P, "name", ""));
    }

    // ------------------------------------------------------------------ notes

    private static void notes() throws Exception {
        Map<String, Object> n1 = callMap("note.create", "wsId", P, "folder", "Notes");
        keys("note.create result fields (NoteDto)", n1, "path", "wsId", "folder", "title", "ext", "size", "mtime", "ctime", "color", "pinned", "autoTitle",
                "preview", "kind", "cover", "date");
        eq("automatic title", "Personal/Notes/Untitled.md|" + P + "|Notes|Untitled|md|0|true|note|false",
                n1.get("path") + "|" + n1.get("wsId") + "|" + n1.get("folder") + "|" + n1.get("title") + "|" + n1.get("ext") + "|" + n1.get("size") + "|"
                        + n1.get("autoTitle") + "|" + n1.get("kind") + "|" + n1.get("pinned"));
        eq("second automatic title", "Untitled (2)", callMap("note.create", "wsId", P, "folder", "Notes").get("title"));
        Lang.set("es");
        eq("automatic title in Spanish", "Sin título", callMap("note.create", "wsId", P, "folder", "Notes").get("title"));
        Lang.set("en");
        Map<String, Object> cv = callMap("note.create", "wsId", P, "folder", "Notes", "title", "Board", "ext", "canvas");
        eq("canvas note", "canvas|canvas", cv.get("ext") + "|" + cv.get("kind"));
        eq("empty canvas text", "{\"nodes\":[],\"edges\":[]}", text("Personal/Notes/Board.canvas"));
        eq("unknown extension -> md", "md", callMap("note.create", "wsId", P, "folder", "Notes", "title", "Plain", "ext", "exe").get("ext"));
        eq("reserved name", "_CON", callMap("note.create", "wsId", P, "folder", "Notes", "title", "CON").get("title"));
        eq("title made safe", "a-b-c-", callMap("note.create", "wsId", P, "folder", "Notes", "title", "a/b:c?").get("title"));
        eq("note.create outside the workspace", "Attempted to perform an unauthorized operation.", error("note.create", "wsId", P, "folder", "../.."));
        Map<String, Object> tx = callMap("note.create", "wsId", P, "folder", "Notes", "title", "Texto", "text", "Hola\nmundo", "autoTitle", false);
        eq("autoTitle false", false, tx.get("autoTitle"));
        check("new notes are UTF-8 with CRLF", Arrays.equals("Hola\r\nmundo".getBytes(UTF_8), bytes("Personal/Notes/Texto.md")));
        eq("ctime comes from the created metadata", createdMs("Personal", "Notes/Texto.md"), num(tx.get("ctime")));

        String np = "Personal/Notes/Texto.md";
        Map<String, Object> rd = callMap("note.read", "path", np);
        keys("note.read result fields", rd, "text", "encoding", "eol", "mtime", "size", "readOnly");
        eq("note.read", "Hola\nmundo|utf8|crlf|11|false", rd.get("text") + "|" + rd.get("encoding") + "|" + rd.get("eol") + "|" + rd.get("size") + "|" + rd.get("readOnly"));
        Map<String, Object> wr = callMap("note.write", "path", np, "text", "Hola\nmundo\nnuevo", "encoding", "utf8", "eol", "crlf", "expectMtime", rd.get("mtime"));
        keys("note.write result fields", wr, "conflict", "mtime");
        eq("note.write saves", false, wr.get("conflict"));
        eq("note.write returns the file's mtime", mtime(np), num(wr.get("mtime")));
        Map<String, Object> cf = callMap("note.write", "path", np, "text", "lost", "expectMtime", num(wr.get("mtime")) - 10000);
        check("changed on disk since -> conflict, nothing written", Boolean.TRUE.equals(cf.get("conflict")) && text(np).equals("Hola\r\nmundo\r\nnuevo"));
        eq("the conflict reports the file's mtime", mtime(np), num(cf.get("mtime")));
        call("note.write", "path", np, "text", "forzado", "expectMtime", 1L, "force", true);
        eq("force writes anyway", "forzado", text(np));
        eq("note.read of a missing file", "The file no longer exists", error("note.read", "path", "Personal/Notes/nope.md"));
        check("paths can't leave the notes folder", s(error("note.read", "path", "Personal/../../outside.md")).startsWith("Path escapes the notes folder"));
        eq("@id paths (folders opened in place) don't exist here", "Workspace not found", error("note.read", "path", "@w-00000000/x.md"));
        eq("empty path", "Empty path", error("note.read", "path", ""));
        eq("missing path", "Missing path", error("note.read"));

        Map<String, Object> sm = callMap("note.setMeta", "path", np, "patch", Json.obj("color", "#ff0000", "pinned", true));
        eq("note.setMeta", "#ff0000|true", sm.get("color") + "|" + sm.get("pinned"));
        Map<String, Object> rn = callMap("note.rename", "path", np, "title", "Mi nota");
        eq("note.rename keeps the metadata", "Personal/Notes/Mi nota.md|#ff0000|true", rn.get("path") + "|" + rn.get("color") + "|" + rn.get("pinned"));
        rn = callMap("note.rename", "path", "Personal/Notes/Mi nota.md", "title", "mi nota");
        check("case-only note rename", "Personal/Notes/mi nota.md".equals(rn.get("path")) && namesIn("Personal/Notes").contains("mi nota.md")
                && !namesIn("Personal/Notes").contains("Mi nota.md") && "#ff0000".equals(rn.get("color")), namesIn("Personal/Notes"));
        eq("rename onto an existing name", "Untitled (3)", callMap("note.rename", "path", "Personal/Notes/mi nota.md", "title", "Untitled").get("title"));
        String un3 = "Personal/Notes/Untitled (3).md";
        sm = callMap("note.setMeta", "path", un3, "patch", Json.obj("pinned", false, "color", ""));
        eq("note.setMeta clears", "null|false", sm.get("color") + "|" + sm.get("pinned"));
        Map<String, Object> entry = m(m(Json.parseObject(text("Personal/.workspace.json")).get("notes")).get("Notes/Untitled (3).md"));
        eq("cleared fields are left out of .workspace.json", "created", String.join(",", entry.keySet()));
        eq("note.setMeta without a patch", "Missing patch", error("note.setMeta", "path", un3));

        List<Object> st = callList("note.stat", "paths", Arrays.asList(un3, "Personal/Notes/nope.md", "../escape.md"));
        keys("note.stat item fields", m(st.get(0)), "path", "exists", "mtime");
        eq("note.stat", "true|false|false|0|0", m(st.get(0)).get("exists") + "|" + m(st.get(1)).get("exists") + "|" + m(st.get(2)).get("exists") + "|"
                + m(st.get(1)).get("mtime") + "|" + m(st.get(2)).get("mtime"));
        eq("note.stat mtime", mtime(un3), num(m(st.get(0)).get("mtime")));
        eq("note.info", "Untitled (3)", callMap("note.info", "path", un3).get("title"));
        check("note.info of a missing file is null", call("note.info", "path", "Personal/Notes/nope.md") == null);

        eq("note.deleteIfEmpty on an empty note", true, call("note.deleteIfEmpty", "path", "Personal/Notes/Untitled (2).md"));
        check("empty note deleted with its metadata", !exists("Personal/Notes/Untitled (2).md") && !text("Personal/.workspace.json").contains("Untitled (2).md"));
        eq("note.deleteIfEmpty on a note with text", false, call("note.deleteIfEmpty", "path", un3));
        eq("note.deleteIfEmpty on a missing note", true, call("note.deleteIfEmpty", "path", "Personal/Notes/nope.md"));
        check("note.delete returns null", call("note.delete", "path", un3) == null);
        check("note.delete moves it to the trash and forgets its metadata", !exists(un3) && trashHas("Untitled (3).md")
                && !text("Personal/.workspace.json").contains("Untitled (3).md"));

        File outNote = new File(outDir, "Outside Note.MD");
        writeBytes(outNote, "desde afuera".getBytes(UTF_8));
        File outImg = new File(outDir, "x.png");
        writeBytes(outImg, PNG);
        List<Object> im = callList("note.import", "paths", Arrays.asList(outNote.getPath(), outImg.getPath(), new File(outDir, "missing.md").getPath()),
                "wsId", P, "folder", "Notes");
        eq("note.import copies note files only", 1, im.size());
        eq("note.import", "Personal/Notes/Outside Note.md|md|desde afuera", m(im.get(0)).get("path") + "|" + m(im.get(0)).get("ext") + "|"
                + text("Personal/Notes/Outside Note.md"));
        check("the original stays where it was", outNote.isFile());
        Map<String, Object> oi = callMap("note.info", "path", outNote.getAbsolutePath());
        eq("note.info of a file outside the notes folder", "|Outside Note|md|" + outNote.getAbsolutePath(),
                oi.get("wsId") + "|" + oi.get("title") + "|" + oi.get("ext") + "|" + oi.get("path"));
        Map<String, Object> cp = callMap("note.copy", "path", "Personal/Notes/Board.canvas", "wsId", P, "folder", "Notes");
        eq("note.copy into its own folder", "Board (2)", cp.get("title"));
        check("same-folder copy is identical", Arrays.equals(bytes("Personal/Notes/Board.canvas"), bytes("Personal/Notes/Board (2).canvas")));
    }

    // ------------------------------------------------------------------ links

    private static void links() throws Exception {
        writeBytes("Personal/Shared/pic one.png", PNG);
        writeBytes("Personal/.assets/wiki pic.png", PNG);
        writeText("Personal/Links/other.md", "other");
        String linky = "# Linky\n![pic](../Shared/pic%20one.png)\n![angle](<../Shared/pic one.png>)\n[other](other.md \"Title\")\n![[wiki pic.png]]\n"
                + "[site](https://example.com/x.png)\n[anchor](#top)\n";
        writeText("Personal/Links/linky.md", linky);
        call("note.setMeta", "path", "Personal/Links/linky.md", "patch", Json.obj("color", "#00ff00"));
        Map<String, Object> mv = callMap("note.move", "path", "Personal/Links/linky.md", "wsId", P, "folder", "Deep/Er");
        keys("note.move result fields", mv, "note", "textChanged");
        eq("note.move", "true|Personal/Deep/Er/linky.md|#00ff00", mv.get("textChanged") + "|" + m(mv.get("note")).get("path") + "|" + m(mv.get("note")).get("color"));
        eq("relative links still point to the same files",
                "# Linky\n![pic](../../Shared/pic%20one.png)\n![angle](../../Shared/pic%20one.png)\n[other](../../Links/other.md \"Title\")\n"
                        + "![[wiki pic.png]]\n[site](https://example.com/x.png)\n[anchor](#top)\n", text("Personal/Deep/Er/linky.md"));
        mv = callMap("note.move", "path", "Personal/Deep/Er/linky.md", "wsId", P, "folder", "Deep/Er");
        eq("move into its own folder changes nothing", "false|Personal/Deep/Er/linky.md", mv.get("textChanged") + "|" + m(mv.get("note")).get("path"));

        mv = callMap("note.move", "path", "Personal/Deep/Er/linky.md", "wsId", T, "folder", "");
        eq("across workspaces: images are copied along, other links point back",
                "# Linky\n![pic](.assets/pic%20one.png)\n![angle](.assets/pic%20one%20%282%29.png)\n[other](../Personal/Links/other.md \"Title\")\n"
                        + "![[wiki pic.png]]\n[site](https://example.com/x.png)\n[anchor](#top)\n", text(TDIR + "/linky.md"));
        check("images copied into the other workspace (markdown and ![[wiki]])", Arrays.equals(PNG, bytes(TDIR + "/.assets/pic one.png"))
                && exists(TDIR + "/.assets/wiki pic.png"));
        check("note metadata moved to the other workspace", text(TDIR + "/.workspace.json").contains("\"linky.md\": {")
                && !text("Personal/.workspace.json").contains("linky.md"));
        eq("the moved note keeps its colour", "#00ff00", m(mv.get("note")).get("color"));

        Map<String, Object> cb = callMap("note.copy", "path", TDIR + "/linky.md", "wsId", P, "folder", "Links");
        eq("note.copy to another workspace (colour kept, unpinned)", "Personal/Links/linky.md|#00ff00|false", cb.get("path") + "|" + cb.get("color") + "|" + cb.get("pinned"));
        String copied = text("Personal/Links/linky.md");
        check("the copy's images and links work from its new folder", copied.contains("![pic](../.assets/pic%20one.png)")
                && copied.contains("[other](other.md \"Title\")") && copied.contains("![[wiki pic.png]]") && exists("Personal/.assets/pic one.png"), copied);
        check("the original stays", exists(TDIR + "/linky.md"));

        writeText("Personal/Book/ch1.md", "[next](ch2.md)\n![img](../Shared/pic%20one.png)\n");
        writeText("Personal/Book/ch2.md", "two");
        call("folder.setMeta", "wsId", P, "name", "Book", "color", "#0000ff");
        call("folder.create", "wsId", P, "name", "Archive");
        eq("folder.copy into another folder", "Archive/Book", callMap("folder.copy", "wsId", P, "name", "Book", "parent", "Archive").get("path"));
        eq("links between the copied files go to the copies, others still work", "[next](ch2.md)\n![img](../../Shared/pic%20one.png)\n",
                text("Personal/Archive/Book/ch1.md"));
        eq("the copied folder keeps its colour", "#0000ff", folderByPath(callMap("ws.get", "id", P), "Archive/Book").get("color"));
    }

    // ------------------------------------------------------------------ assets

    private static void assets() throws Exception {
        String note = "Personal/Links/other.md";
        Map<String, Object> sv = callMap("asset.save", "notePath", note, "data", "data:image/png;base64," + b64(PNG));
        keys("asset.save result fields", sv, "link", "wiki", "name", "url", "path");
        String nm = s(sv.get("name"));
        check("pasted image name", nm.matches("image-\\d{8}-\\d{6}\\.png"), nm);
        eq("asset.save", "../.assets/" + nm + "|false|https://files.marknotes.example/r/Personal/.assets/" + nm + "|Personal/.assets/" + nm,
                sv.get("link") + "|" + sv.get("wiki") + "|" + sv.get("url") + "|" + sv.get("path"));
        check("image bytes saved", Arrays.equals(PNG, bytes("Personal/.assets/" + nm)));
        sv = callMap("asset.save", "notePath", note, "data", "data:image/jpeg;base64," + b64(JPG), "name", "Mi foto.jpg");
        eq("asset.save with a name", "Mi foto.jpg|../.assets/Mi%20foto.jpg", sv.get("name") + "|" + sv.get("link"));
        eq("the same name again", "Mi foto (2).jpg", callMap("asset.save", "notePath", note, "data", "data:image/jpeg;base64," + b64(JPG), "name", "Mi foto.jpg").get("name"));
        check("plain base64 with an ext", s(callMap("asset.save", "notePath", note, "data", b64(GIF), "ext", "GIF").get("name")).endsWith(".gif"));
        eq("asset.url", "https://files.marknotes.example/r/Personal/.assets/Mi%20foto.jpg", call("asset.url", "notePath", note, "link", "../.assets/Mi%20foto.jpg"));
        check("asset.url of a web link is null", call("asset.url", "notePath", note, "link", "https://example.com/a.png") == null);
        eq("asset.url of a ![[wiki]] embed", "https://files.marknotes.example/r/Personal/.assets/Mi%20foto.jpg",
                call("asset.url", "notePath", note, "link", "Mi foto.jpg|200", "wiki", true));

        writeText("Personal/Links/uses.md", "![a](../.assets/Mi%20foto.jpg)\n![[Mi foto.jpg|200]]\n![[sub/Mi foto.jpg]]\n");
        writeText("Personal/Links/open.md", "![b](../.assets/Mi%20foto.jpg)\n");
        Map<String, Object> ra = callMap("asset.rename", "notePath", note, "link", "../.assets/Mi%20foto.jpg", "newName", "Foto nueva",
                "openPaths", Arrays.asList("Personal/Links/open.md"));
        keys("asset.rename result fields", ra, "name", "oldName", "link", "url", "updated", "edits");
        eq("asset.rename", "Foto nueva.jpg|Mi foto.jpg|../.assets/Foto%20nueva.jpg|https://files.marknotes.example/r/Personal/.assets/Foto%20nueva.jpg",
                ra.get("name") + "|" + ra.get("oldName") + "|" + ra.get("link") + "|" + ra.get("url"));
        eq("notes that show it are fixed", "[Personal/Links/uses.md]", String.valueOf(ra.get("updated")));
        eq("their links (markdown and ![[wiki]])", "![a](../.assets/Foto%20nueva.jpg)\n![[Foto nueva.jpg|200]]\n![[sub/Foto nueva.jpg]]\n",
                text("Personal/Links/uses.md"));
        eq("notes open in the editor are left to it", "![b](../.assets/Mi%20foto.jpg)\n", text("Personal/Links/open.md"));
        List<Object> edits = l(ra.get("edits"));
        keys("edit fields", m(edits.get(0)), "path", "from", "to");
        eq("edit for the open note", "Personal/Links/open.md|../.assets/Mi%20foto.jpg|../.assets/Foto%20nueva.jpg",
                m(edits.get(0)).get("path") + "|" + m(edits.get(0)).get("from") + "|" + m(edits.get(0)).get("to"));
        check("renamed on disk", exists("Personal/.assets/Foto nueva.jpg") && !exists("Personal/.assets/Mi foto.jpg"));
        eq("a new name with another image extension keeps the file's", "Final.jpg",
                callMap("asset.rename", "notePath", note, "link", "../.assets/Foto%20nueva.jpg", "newName", "Final.png", "openPaths", new ArrayList<>()).get("name"));
        eq("asset.rename of a missing image", "Image not found", error("asset.rename", "notePath", note, "link", "../.assets/none.png", "newName", "x"));
        check("asset.delete returns null", call("asset.delete", "notePath", note, "link", "../.assets/Final.jpg") == null);
        check("asset.delete moves it to the trash", !exists("Personal/.assets/Final.jpg") && trashHas("Final.jpg"));
        eq("asset.delete of a note", "Not an image", error("asset.delete", "notePath", note, "link", "uses.md"));
        eq("asset.delete of a web image", "Not a local image", error("asset.delete", "notePath", note, "link", "https://example.com/a.png"));

        File clip = new File(outDir, "clip.mp4");
        writeBytes(clip, new byte[] {1, 2, 3});
        File sp = new File(outDir, "spine");
        writeBytes(new File(sp, "c999_00.skel"), new byte[] {9});
        writeBytes(new File(sp, "c999_00.atlas"), "c999_00.png\nsize: 64,64\ntex/c999_00_2.png\n".getBytes(UTF_8));
        writeBytes(new File(sp, "c999_00.png"), PNG);
        writeBytes(new File(sp, "tex/c999_00_2.png"), PNG);
        writeBytes(new File(sp, "fuentes.json"), "{}".getBytes(UTF_8));
        List<Object> ai = callList("asset.import", "notePath", note, "paths", Arrays.asList(clip.getPath(), f("Personal/Shared/pic one.png").getPath(),
                new File(sp, "c999_00.skel").getPath(), "", new File(outDir, "nope.bin").getPath()));
        eq("asset.import results", 3, ai.size());
        keys("asset.import item fields", m(ai.get(0)), "path", "name", "copied");
        eq("a file from outside is copied to .assets", "Personal/.assets/clip.mp4|clip.mp4|true", m(ai.get(0)).get("path") + "|" + m(ai.get(0)).get("name") + "|" + m(ai.get(0)).get("copied"));
        eq("a file of the workspace is used where it is", "Personal/Shared/pic one.png|false", m(ai.get(1)).get("path") + "|" + m(ai.get(1)).get("copied"));
        eq("a Spine model gets a folder", "Personal/.assets/c999_00/c999_00.skel|true", m(ai.get(2)).get("path") + "|" + m(ai.get(2)).get("copied"));
        check("its atlas, textures and fuentes.json come along", exists("Personal/.assets/c999_00/c999_00.atlas") && exists("Personal/.assets/c999_00/c999_00.png")
                && exists("Personal/.assets/c999_00/tex/c999_00_2.png") && exists("Personal/.assets/c999_00/fuentes.json"));

        String V = s(callMap("ws.create", "name", "Vault").get("id"));
        writeText("Vault/.obsidian/app.json", "{\"attachmentFolderPath\":\"attachments\"}");
        writeText("Vault/General/n.md", "x");
        eq("a workspace with .obsidian is a vault", true, callMap("ws.get", "id", V).get("vault"));
        Map<String, Object> va = callMap("asset.save", "notePath", "Vault/General/n.md", "data", "data:image/png;base64," + b64(PNG));
        String vn = s(va.get("name"));
        check("vault: pasted images go to the attachment folder of app.json, linked by name", vn.matches("Pasted image \\d{14}\\.png")
                && Boolean.TRUE.equals(va.get("wiki")) && vn.equals(va.get("link")) && ("Vault/attachments/" + vn).equals(va.get("path")), va);
        writeBytes("Vault/General/dup.png", PNG);
        Map<String, Object> vd = callMap("asset.save", "notePath", "Vault/General/n.md", "data", "data:image/png;base64," + b64(PNG), "name", "dup.png");
        eq("vault: names stay unique in the whole vault (Obsidian finds images by name)", "dup 2.png|Vault/attachments/dup 2.png", vd.get("name") + "|" + vd.get("path"));
        writeText("Vault/.obsidian/app.json", "{\"attachmentFolderPath\":\"./img\"}");
        eq("vault: ./ attachment folders are next to the note", "Vault/General/img/x.png",
                callMap("asset.save", "notePath", "Vault/General/n.md", "data", b64(PNG), "name", "x.png").get("path"));

        List<Object> files = callList("ws.files", "id", P);
        check("ws.files lists attachments", files.contains("Shared/pic one.png") && files.contains(".assets/wiki pic.png")
                && files.contains(".assets/c999_00/c999_00.skel") && files.contains(".assets/clip.mp4"), files);
        boolean noNotes = true;
        for (Object o : files) if (s(o).endsWith(".md") || s(o).endsWith(".canvas")) noNotes = false;
        check("ws.files leaves notes out", noNotes, files);
    }

    // ------------------------------------------------------------------ covers

    private static void covers() throws Exception {
        String C = s(callMap("ws.create", "name", "Covers").get("id"));
        writeBytes("Covers/General/cover pic.png", PNG);
        writeBytes("Covers/General/inline.png", PNG);
        writeText("Covers/General/fm.md", "---\ntitle: X\ncover: \"[[cover pic.png]]\"\ndate: 2024-03-05\n---\nBody text here ![](inline.png)\n");
        writeText("Covers/General/first.md", "Intro\n\n![x](inline.png)\nmore");
        writeText("Covers/General/board.md", "---\nkanban-plugin: basic\n---\n\n## Todo\n");
        writeText("Covers/General/map.canvas", "{\"nodes\":[{\"id\":\"1\",\"type\":\"file\",\"file\":\"General/inline.png\"}],\"edges\":[]}");
        writeText("Covers/General/web.md", "---\nbanner: https://example.com/a.png\n---\ntext");
        writeText("Covers/General/datetime.md", "---\ndatetime: 2023-01-01T10:00\ncreated: 2022\n---\n");

        List<Object> quick = callList("ws.notes", "id", C, "preview", false);
        eq("ws.notes lists every note", 6, quick.size());
        Map<String, Object> qb = byTitle(quick, "board");
        check("without previews no file is read", qb != null && qb.get("preview") == null && "note".equals(qb.get("kind")) && qb.get("cover") == null, qb);
        eq("canvas kind from the extension", "canvas", byTitle(quick, "map").get("kind"));
        List<Object> full = callList("ws.notes", "id", C);
        Map<String, Object> fm = byTitle(full, "fm");
        check("front matter cover", s(fm.get("cover")).startsWith("https://files.marknotes.example/r/Covers/General/cover%20pic.png?w=480&v="), fm.get("cover"));
        eq("front matter date", "2024-03-05", fm.get("date"));
        eq("the preview starts after the front matter", "Body text here ![](inline.png)\n", fm.get("preview"));
        check("first image as the cover", s(byTitle(full, "first").get("cover")).startsWith("https://files.marknotes.example/r/Covers/General/inline.png?w=480&v="),
                byTitle(full, "first").get("cover"));
        eq("kanban kind", "kanban", byTitle(full, "board").get("kind"));
        Map<String, Object> mp = byTitle(full, "map");
        check("canvas kind and cover", "canvas".equals(mp.get("kind")) && s(mp.get("cover")).contains("/r/Covers/General/inline.png?w=480"), mp);
        check("web banners are no covers", byTitle(full, "web").get("cover") == null);
        eq("the first date key wins", "2023-01-01T10:00", byTitle(full, "datetime").get("date"));
        check("index entries serve later lists without previews", byTitle(callList("ws.notes", "id", C, "preview", false), "fm").get("preview") != null);
        store.flushIndex();
        File idx = new File(new File(platform.cacheDir(), "index"), C + ".json");
        check("the index is saved under cacheDir/index", idx.isFile() && new String(Files.readAllBytes(idx.toPath()), UTF_8).contains("\"General/fm.md\":{\"M\":"));
    }

    // ------------------------------------------------------------------ spine, canvas

    private static void spineAndCanvas() throws Exception {
        writeBytes("Covers/Spine/c820_00.skel", new byte[100]);
        String atlas = "c820_00.png\nsize: 1024,1024\nc820_00_2.png\n  missing.png  \n";
        writeText("Covers/Spine/c820_00.atlas", atlas);
        writeBytes("Covers/Spine/c820_00.png", new byte[50]);
        writeBytes("Covers/Spine/c820_00_2.png", new byte[25]);
        writeBytes("Covers/Spine/c820_aim_01.skel", new byte[7]);
        writeBytes("Covers/Spine/c820_cover_02.skel", new byte[10]);
        writeText("Covers/Spine/c820_cover_02.atlas", "c820_cover_02.png\n");
        writeBytes("Covers/Spine/c820_cover_02.png", new byte[5]);
        writeText("Covers/Spine/fuentes.json", "{\"personaje\":\"Rapi\",\"modelos\":[{\"modelo\":\"c820_00\",\"nombre\":\"Default\"},"
                + "{\"model\":\"c820_cover_02\",\"name\":\"Cover\"}]}");
        Map<String, Object> sp = callMap("spine.info", "path", "Covers/Spine/c820_00.skel");
        keys("spine.info result fields", sp, "character", "models");
        eq("spine.info character", "Rapi", sp.get("character"));
        List<Object> ms = l(sp.get("models"));
        eq("models that have an atlas", 2, ms.size());
        keys("model fields", m(ms.get(0)), "file", "atlas", "name", "bytes");
        long atlasLen = atlas.getBytes(UTF_8).length;
        eq("first model (skeleton + atlas + textures)", "c820_00.skel|c820_00.atlas|Default|" + (100 + atlasLen + 50 + 25),
                m(ms.get(0)).get("file") + "|" + m(ms.get(0)).get("atlas") + "|" + m(ms.get(0)).get("name") + "|" + m(ms.get(0)).get("bytes"));
        eq("second model", "c820_cover_02.skel|Cover|" + (10 + 18 + 5), m(ms.get(1)).get("file") + "|" + m(ms.get(1)).get("name") + "|" + m(ms.get(1)).get("bytes"));
        writeBytes("Covers/Spine2/a.skel", new byte[3]);
        writeText("Covers/Spine2/a.atlas", "");
        writeText("Covers/Spine2/fuentes.json", "{\"personaje\":5,\"modelos\":[{\"modelo\":\"a\",\"nombre\":\"A\"}]}");
        Map<String, Object> sp2 = callMap("spine.info", "path", "Covers/Spine2/a.skel");
        check("a fuentes.json with wrong types is ignored", sp2.get("character") == null && m(l(sp2.get("models")).get(0)).get("name") == null, sp2);

        File outImg = new File(outDir, "x.png");
        List<Object> cp = callList("canvas.paths", "path", "Covers/General/map.canvas", "paths",
                Arrays.asList("Covers/General/inline.png", "Covers/Spine/c820_00.png", outImg.getPath()));
        eq("canvas.paths relative to the workspace, absolute outside it", "General/inline.png|Spine/c820_00.png|" + outImg.getAbsolutePath(), join(cp));
        mkdir("Covers/Vaultish/.obsidian");
        writeText("Covers/Vaultish/sub/c.canvas", "{}");
        writeBytes("Covers/Vaultish/img/a.png", PNG);
        eq("canvas.paths relative to the closest vault", "img/a.png",
                join(callList("canvas.paths", "path", "Covers/Vaultish/sub/c.canvas", "paths", Arrays.asList("Covers/Vaultish/img/a.png"))));
        Map<String, Object> rf = callMap("note.resolveFiles", "path", "Covers/General/map.canvas", "files",
                Arrays.asList("General/inline.png", "inline.png", "cover pic.png", "nope-zz.png", "General/inline.png", "  ", "c820_00.png"));
        List<String> got = new ArrayList<>();
        for (Map.Entry<String, Object> e : rf.entrySet()) got.add(e.getKey() + "=" + e.getValue());
        eq("note.resolveFiles (workspace root, folders above, then by name)",
                "General/inline.png=Covers/General/inline.png|inline.png=Covers/General/inline.png|cover pic.png=Covers/General/cover pic.png|nope-zz.png=null|"
                        + "c820_00.png=Covers/Spine/c820_00.png", String.join("|", got));
    }

    // ------------------------------------------------------------------ search

    private static void search() throws Exception {
        String S = s(callMap("ws.create", "name", "Search").get("id"));
        writeText("Search/General/Canción.md", "La canción del verano\nOtra línea con CANCIÓN");
        writeText("Search/General/Recetas.md", "Una receta. " + repeat("relleno ", 40) + "y una cancion al final");
        writeText("Search/General/Other.md", "Calle Straße 5");
        List<Object> h = callList("search.query", "q", "cancion", "wsId", S);
        eq("search ignores case and accents", 2, h.size());
        Map<String, Object> h0 = m(h.get(0));
        keys("search hit fields (SearchHit)", h0, "path", "wsId", "folder", "title", "snippet", "matches", "mtime", "titleMatch");
        eq("title matches first", "Search/General/Canción.md|" + S + "|General|Canción|true|2",
                h0.get("path") + "|" + h0.get("wsId") + "|" + h0.get("folder") + "|" + h0.get("title") + "|" + h0.get("titleMatch") + "|" + h0.get("matches"));
        eq("snippet with white space collapsed", "La canción del verano Otra línea con CANCIÓN", h0.get("snippet"));
        Map<String, Object> h1 = m(h.get(1));
        check("a snippet far into the text starts with an ellipsis", s(h1.get("snippet")).startsWith("…") && s(h1.get("snippet")).endsWith("y una cancion al final")
                && num(h1.get("matches")) == 1, h1.get("snippet"));
        eq("quoted phrase", 1, callList("search.query", "q", "\"del verano\"", "wsId", S).size());
        eq("every term must match", 1, callList("search.query", "q", "cancion verano", "wsId", S).size());
        List<Object> ss = callList("search.query", "q", "STRASSE", "wsId", S);
        eq("German sharp s matches ss", "Other", ss.isEmpty() ? null : m(ss.get(0)).get("title"));
        eq("no match", 0, callList("search.query", "q", "zzzzqqq", "wsId", S).size());
        eq("empty query", 0, callList("search.query", "q", "").size());
        eq("limit", 1, callList("search.query", "q", "cancion", "wsId", S, "limit", 1L).size());
        check("search in every workspace", callList("search.query", "q", "cancion").size() >= 2);
        // Folding the PC's search does too (checked against .NET 8): ligatures, æ, ł, superscripts; dotless ı stays apart.
        String lig = "El " + (char) 0xFB01 + "nal de los " + (char) 0xC6 + "sir en " + (char) 0x141 + (char) 0xF3 + "d" + (char) 0x17A + ", x" + (char) 0xB2;
        writeText("Search/General/Lig.md", lig);
        writeText("Search/General/Dotless.md", "K" + (char) 0x131 + "r" + (char) 0x131 + "kkale");
        List<Object> lh = callList("search.query", "q", "final aesir lodz x2", "wsId", S);
        eq("ligatures, letters with strokes and superscripts match their plain forms", "Lig", lh.size() == 1 ? m(lh.get(0)).get("title") : lh);
        eq("dotless i is not i", 0, callList("search.query", "q", "kirikkale", "wsId", S).size());
    }

    // ------------------------------------------------------------------ sync hooks

    private static void hooks() throws Exception {
        check("root()", store.root().getPath().equals(new File(root).getPath()));
        WorkspaceRef pr = null;
        for (WorkspaceRef r : store.listWorkspaces()) if (r.id.equals(P)) pr = r;
        check("listWorkspaces gives id, name and folder", pr != null && "Personal".equals(pr.name) && pr.dir.getPath().equals(new File(root, "Personal").getPath()), pr);

        String json = "{\r\n  \"format\": \"marknotes-workspace\",\r\n  \"version\": 1,\r\n  \"id\": \"w-0a0b0c0d\",\r\n  \"name\": \"Synced\",\r\n"
                + "  \"folders\": {},\r\n  \"notes\": {}\r\n}";
        File adopted = store.adoptWorkspace("Synced Notes", json.getBytes(UTF_8));
        eq("adoptWorkspace makes the folder", new File(root, "Synced Notes").getPath(), adopted.getPath());
        check("adoptWorkspace writes the bytes as they are", Arrays.equals(json.getBytes(UTF_8), bytes("Synced Notes/.workspace.json")));
        Map<String, Object> sw = callMap("ws.get", "id", "w-0a0b0c0d");
        eq("the adopted workspace is registered", "Synced|Synced Notes", sw.get("name") + "|" + sw.get("dir"));
        check("adopting the same id again is refused", throwsEx(() -> store.adoptWorkspace("Again", json.getBytes(UTF_8))) && !exists("Again"));
        File second = store.adoptWorkspace("synced notes", json.replace("w-0a0b0c0d", "w-0a0b0c0e").getBytes(UTF_8));
        eq("adoptWorkspace makes the folder name unique ignoring case", "synced notes (2)", second.getName());
        check("invalid metadata is refused before anything is made", throwsEx(() -> store.adoptWorkspace("Broken", "{nope".getBytes(UTF_8))) && !exists("Broken"));

        String sid = "w-0a0b0c0d";
        String j3 = json.replace("\"name\": \"Synced\",", "\"name\": \"Synced\",\r\n  \"color\": \"#abcdef\",");
        store.writeWorkspaceMeta(sid, j3.getBytes(UTF_8));
        check("writeWorkspaceMeta writes the bytes as they are", Arrays.equals(j3.getBytes(UTF_8), bytes("Synced Notes/.workspace.json")));
        eq("writeWorkspaceMeta reloads the metadata", "#abcdef", callMap("ws.get", "id", sid).get("color"));
        String j4 = "{\"format\":\"marknotes-workspace\",\"version\":1,\"id\":\"w-ffffffff\",\"name\":\"Renamed\",\"folders\":{\"A\":{\"order\":2}},\"notes\":{},\"extraThing\":true}";
        store.writeWorkspaceMeta(sid, j4.getBytes(UTF_8));
        eq("another id in the JSON is replaced by the workspace's",
                "{\r\n  \"format\": \"marknotes-workspace\",\r\n  \"version\": 1,\r\n  \"id\": \"w-0a0b0c0d\",\r\n  \"name\": \"Renamed\",\r\n  \"folders\": {\r\n"
                        + "    \"A\": {\r\n      \"order\": 2\r\n    }\r\n  },\r\n  \"notes\": {},\r\n  \"extraThing\": true\r\n}", text("Synced Notes/.workspace.json"));
        eq("ws.get sees the new metadata", "Renamed", callMap("ws.get", "id", sid).get("name"));
        call("folder.create", "wsId", sid, "name", "B");
        String after = text("Synced Notes/.workspace.json");
        check("a later save builds on it (no stale copy)", after.contains("\"name\": \"Renamed\"") && after.contains("\"A\": {") && after.contains("\"extraThing\": true")
                && after.contains("\"B\": {\r\n      \"order\": 3"), after);
        check("writeWorkspaceMeta of an unknown workspace is refused", throwsEx(() -> store.writeWorkspaceMeta("w-99999999", j4.getBytes(UTF_8))));

        String pmeta = text("Personal/.workspace.json");
        writeText("Personal/.workspace.json", pmeta.replace("\"color\": \"#5865f2\"", "\"color\": \"#010203\""));
        eq("until reload the store keeps its metadata", "#5865f2", callMap("ws.get", "id", P).get("color"));
        store.reload(P);
        eq("reload re-reads .workspace.json", "#010203", callMap("ws.get", "id", P).get("color"));

        String other = "Personal/Links/other.md";
        check("unknown name", m(call("note.resolveFiles", "path", other, "files", Arrays.asList("late.png"))).get("late.png") == null);
        writeBytes("Personal/Deep/late.png", PNG);
        check("file names are cached for a while", m(call("note.resolveFiles", "path", other, "files", Arrays.asList("late.png"))).get("late.png") == null);
        store.reload(P);
        eq("reload drops the file-name cache", "Personal/Deep/late.png", m(call("note.resolveFiles", "path", other, "files", Arrays.asList("late.png"))).get("late.png"));

        callMap("note.create", "wsId", P, "folder", "Cache", "title", "cached", "text", "uniquewordalpha");
        eq("search finds the new text", 1, callList("search.query", "q", "uniquewordalpha", "wsId", P).size());
        String cpath = "Personal/Cache/cached.md";
        long cm = mtime(cpath);
        writeText(cpath, "uniquewordbetaa");
        setMtime(cpath, cm);
        eq("note texts are cached by mtime", 0, callList("search.query", "q", "uniquewordbetaa", "wsId", P).size());
        store.reload(P);
        eq("reload drops the cached texts", 1, callList("search.query", "q", "uniquewordbetaa", "wsId", P).size());

        callMap("note.create", "wsId", P, "folder", "Cache", "title", "idx", "text", "previewone");
        eq("preview from the index", "previewone", byTitle(callList("ws.notes", "id", P), "idx").get("preview"));
        long im = mtime("Personal/Cache/idx.md");
        writeText("Personal/Cache/idx.md", "previewtwo");
        setMtime("Personal/Cache/idx.md", im);
        eq("index entries are kept while size and mtime match", "previewone", byTitle(callList("ws.notes", "id", P), "idx").get("preview"));
        store.reload(P);
        eq("reload drops the index entries", "previewtwo", byTitle(callList("ws.notes", "id", P), "idx").get("preview"));

        store.reload(null);
        check("reload(null) keeps every workspace", ids(callList("ws.list")).contains(P) && ids(callList("ws.list")).contains(sid));
        String gone = s(callMap("ws.create", "name", "Gone").get("id"));
        deleteTree(f("Gone"));
        store.reload(gone);
        eq("reload of a folder removed from outside forgets it", "Workspace not found", error("ws.get", "id", gone));
    }

    // ------------------------------------------------------------------ bridge

    private static List<Object> items() throws Exception {
        return l(callMap("trash.list").get("items"));
    }

    private static Map<String, Object> item(String name) throws Exception {
        for (Object o : items()) if (name.equals(m(o).get("name"))) return m(o);
        return null;
    }

    private static List<Object> ids(Object... ids) {
        return new ArrayList<>(Arrays.asList(ids));
    }

    private static boolean wsListed(String id) throws Exception {
        for (Object o : callList("ws.list")) if (id.equals(m(o).get("id"))) return true;
        return false;
    }

    private static void trashBin() throws Exception {
        File binDir = new File(platform.base(), "trash-bin");
        Trash bin = new Trash(binDir, new File(root));
        TrashCommands.register(bridge, bin, store);
        Map<String, Object> w = callMap("ws.create", "name", "Trash test", "firstFolder", "Notes");
        String id = s(w.get("id")), dir = s(w.get("dir"));

        // Deleted on the phone: it waits, knowing where it was.
        writeText(dir + "/Notes/Gone.md", "gone\n");
        bin.put(f(dir + "/Notes/Gone.md"), "phone", null);
        check("put moves the note out of its folder", !exists(dir + "/Notes/Gone.md"));
        eq("trash.list shows it", 1, items().size());
        Map<String, Object> it = item("Gone.md");
        eq("where it was, its workspace, kind and who deleted it", dir + "/Notes/Gone.md|Trash test|note|phone",
                it.get("from") + "|" + it.get("ws") + "|" + it.get("kind") + "|" + it.get("by"));
        check("size and date", num(it.get("size")) == 5 && Math.abs(num(it.get("at")) - System.currentTimeMillis()) < 60000, it);
        eq("nothing is emptied by date unless asked (days 0)", 0L, num(call("trash.autoEmpty", "days", 0L)));
        eq("…and a recent item stays with 30 days", 0L, num(call("trash.autoEmpty", "days", 30L)));

        Map<String, Object> res = callMap("trash.restore", "ids", ids(it.get("id")), "wsId", id);
        check("trash.restore puts it back in its folder", exists(dir + "/Notes/Gone.md") && l(res.get("restored")).size() == 1 && l(res.get("errors")).isEmpty(), res);
        check("the restored note is listed again (ws.notes)", byTitle(callList("ws.notes", "id", id, "preview", false), "Gone") != null);
        eq("the trash is empty again", 0, items().size());
        String[] left = binDir.list();
        check("its trash entry is gone", left == null || left.length == 0, left == null ? null : Arrays.toString(left));

        // Removed by a sync; meanwhile a new note took the name → "(restored)".
        bin.put(f(dir + "/Notes/Gone.md"), "sync", "ASUS-PC");
        writeText(dir + "/Notes/Gone.md", "a new one\n");
        it = item("Gone.md");
        eq("removed by the sync with that PC", "sync|ASUS-PC", it.get("by") + "|" + it.get("pc"));
        res = callMap("trash.restore", "ids", ids(it.get("id")));
        check("restored next to the new note as “Gone (restored).md”", exists(dir + "/Notes/Gone (restored).md")
                && new String(bytes(dir + "/Notes/Gone.md"), UTF_8).equals("a new one\n")
                && new String(bytes(dir + "/Notes/Gone (restored).md"), UTF_8).equals("gone\n"), res);
        eq("restore says it was renamed", true, m(l(res.get("restored")).get(0)).get("renamed"));

        // Its folders are gone too: they are made again.
        writeText(dir + "/Deep/Er/Note.md", "deep\n");
        bin.put(f(dir + "/Deep/Er/Note.md"), "phone", null);
        bin.put(f(dir + "/Deep"), "phone", null);
        callMap("trash.restore", "ids", ids(item("Note.md").get("id")));
        check("missing folders are made again", exists(dir + "/Deep/Er/Note.md"));
        Map<String, Object> deep = item("Deep");
        eq("a folder is listed as a folder", "folder|true", deep == null ? null : deep.get("kind") + "|" + deep.get("dir"));
        callMap("trash.restore", "ids", ids(deep.get("id")));
        check("a folder whose name is taken comes back as “Deep (restored)”", f(dir + "/Deep (restored)/Er").isDirectory());

        // Delete forever, by date (only when turned on), empty.
        writeText(dir + "/a.md", "a");
        writeText(dir + "/b.md", "b");
        bin.put(f(dir + "/a.md"), "phone", null);
        bin.put(f(dir + "/b.md"), "phone", null);
        call("trash.delete", "ids", ids(item("b.md").get("id")));
        check("trash.delete deletes it for good", item("b.md") == null && !exists(dir + "/b.md"));
        writeText(dir + "/c.md", "c");
        bin.put(f(dir + "/c.md"), "phone", null);
        File[] entries = binDir.listFiles();
        File oldEntry = null;
        if (entries != null) for (File e : entries) if (new File(e, "a.md").exists()) oldEntry = e;
        check("each item has an entry with its info file", oldEntry != null && new File(oldEntry, ".trashinfo.json").isFile());
        if (oldEntry != null) {
            File info = new File(oldEntry, ".trashinfo.json");
            Map<String, Object> mi = Json.parseObject(new String(Files.readAllBytes(info.toPath()), UTF_8));
            mi.put("at", System.currentTimeMillis() - 40L * 24 * 3600 * 1000);
            Files.write(info.toPath(), Json.pretty(mi).getBytes(UTF_8));
        }
        eq("days 0 still keeps a 40-day-old item", 0L, num(call("trash.autoEmpty", "days", 0L)));
        eq("days 30 deletes only what is older than 30 days", 1L, num(call("trash.autoEmpty", "days", 30L)));
        check("the recent one stays", item("a.md") == null && item("c.md") != null);
        eq("trash.empty deletes everything", 1L, num(call("trash.empty")));
        eq("nothing left", 0, items().size());

        // A whole workspace comes back as a workspace.
        Map<String, Object> w2 = callMap("ws.create", "name", "Gone workspace");
        String w2id = s(w2.get("id"));
        bin.put(f(s(w2.get("dir"))), "sync", "ASUS-PC");
        store.reload(null);
        check("the workspace is gone from ws.list", !wsListed(w2id));
        it = item(s(w2.get("dir")));
        eq("listed as a workspace", "workspace|Gone workspace", it == null ? null : it.get("kind") + "|" + it.get("ws"));
        callMap("trash.restore", "ids", ids(it.get("id")));
        check("the restored workspace is listed again", wsListed(w2id));

        // Items from MarkNotes for Android 1.0 (no info file) go into the open workspace.
        File legacy = new File(binDir, "20261107-101010-123");
        writeBytes(new File(legacy, "Old.md"), "old\n".getBytes(UTF_8));
        it = item("Old.md");
        long when = new java.text.SimpleDateFormat("yyyyMMdd-HHmmss-SSS", java.util.Locale.ROOT).parse("20261107-101010-123").getTime();
        check("1.0 items are listed with their date", it != null && it.get("from") == null && num(it.get("at")) == when, it);
        res = callMap("trash.restore", "ids", ids(it.get("id")));
        check("without an open workspace it asks for one", l(res.get("restored")).isEmpty() && l(res.get("errors")).size() == 1, res);
        callMap("trash.restore", "ids", ids(it.get("id")), "wsId", id);
        check("with one it goes to its top level", exists(dir + "/Old.md"));

        // Ids never reach outside the trash.
        for (String bad : new String[] {"../x", "a/../b", "a/b/c", "/x", "x/", "..", "x/.trashinfo.json"}) {
            check("bad id refused: " + bad, error("trash.delete", "ids", ids(bad)) != null);
        }
        check("nothing outside the trash was touched", exists(dir + "/Notes/Gone.md") && exists(dir + "/Old.md"));
    }

    private static void bridgeJson() throws Exception {
        platform.posted.clear();
        bridge.receive("{\"id\":7,\"cmd\":\"ws.get\",\"args\":{\"id\":\"" + P + "\"}}");
        String msg = platform.posted.poll(15, TimeUnit.SECONDS);
        check("answer through Bridge.receive", msg != null && msg.startsWith("{\"id\":7,\"ok\":true,\"result\":{\"id\":\"" + P + "\",\"name\":\"Personal\",\"dir\":\"Personal\",\"color\":"), msg);
        check("nulls are kept in results", msg != null && msg.contains("\"iconUrl\":null") && msg.contains("\"linked\":false") && msg.contains("\"bannerUrl\":null"), msg);
        bridge.receive("{\"id\":8,\"cmd\":\"note.read\",\"args\":{}}");
        eq("an error answer", "{\"id\":8,\"ok\":false,\"error\":\"Missing path\"}", platform.posted.poll(15, TimeUnit.SECONDS));
        bridge.receive("{\"id\":9,\"cmd\":\"ws.setGuide\",\"args\":{\"id\":\"" + P + "\",\"text\":\"\"}}");
        eq("a null result", "{\"id\":9,\"ok\":true,\"result\":null}", platform.posted.poll(15, TimeUnit.SECONDS));
    }

    // ------------------------------------------------------------------ threads

    private static void concurrency() throws Exception {
        String busy = s(callMap("ws.create", "name", "Busy").get("id"));
        List<Throwable> errors = Collections.synchronizedList(new ArrayList<>());
        Thread[] threads = new Thread[4];
        for (int t = 0; t < threads.length; t++) {
            final int n = t;
            threads[t] = new Thread(() -> {
                try {
                    for (int k = 0; k < 25; k++) {
                        Map<String, Object> dto = callMap("note.create", "wsId", busy, "folder", "F" + (k % 3), "title", "T" + n + "-" + k, "text", "busy " + n + " " + k);
                        Map<String, Object> w = callMap("note.write", "path", dto.get("path"), "text", "busy text " + n + " " + k, "encoding", "utf8", "eol", "lf",
                                "expectMtime", dto.get("mtime"));
                        if (!Boolean.FALSE.equals(w.get("conflict"))) throw new IllegalStateException("unexpected conflict " + w);
                        if (k % 5 == 0) callList("ws.notes", "id", busy);
                        if (k % 7 == 0) callList("search.query", "q", "busy", "wsId", busy);
                        if (k % 9 == 0) callMap("ws.get", "id", busy);
                        if (k % 11 == 0) callList("ws.list");
                    }
                } catch (Throwable e) {
                    errors.add(e);
                }
            });
            threads[t].start();
        }
        for (Thread t : threads) t.join(180_000);
        check("parallel commands raise no errors", errors.isEmpty(), errors);
        eq("every parallel note.create made its note", 100, callList("ws.notes", "id", busy).size());
        eq("and the search sees them all", 100, callList("search.query", "q", "busy text", "wsId", busy).size());
    }
}

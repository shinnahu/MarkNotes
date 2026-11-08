package com.marknotes.core.store;

import com.marknotes.core.Json;
import com.marknotes.core.Lang;
import com.marknotes.core.Log;
import com.marknotes.core.Platform;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.security.SecureRandom;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.IntConsumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Everything about notes on disk (port of the PC's Storage/NoteStore.cs).
 * Layout: {@code <root>/<Workspace>/<folders…>/<Note>.md}, workspace metadata in .workspace.json, pasted images in
 * {@code <Workspace>/.assets}. Interface paths use '/', start with the workspace folder name and are relative to the
 * notes root; absolute paths stand for files outside the notes folder (opened from elsewhere).
 * Every name lookup ignores case like on the PC, whatever the phone's file system does.
 */
public final class NoteStore {
    public static final String WS_META_FILE = ".workspace.json";
    public static final String ASSETS_DIR = ".assets";
    public static final String FILES_HOST = "files.marknotes.example";

    private static Set<String> ciSet(String... items) {
        TreeSet<String> s = new TreeSet<>(String.CASE_INSENSITIVE_ORDER);
        Collections.addAll(s, items);
        return Collections.unmodifiableSet(s);
    }

    /** Video and audio files canvases can play. */
    public static final Set<String> MEDIA_EXTS = ciSet(".mp4", ".m4v", ".webm", ".mov", ".ogv", ".mp3", ".m4a", ".wav", ".ogg", ".flac");
    public static final Set<String> NOTE_EXTS = ciSet(".md", ".markdown", ".txt", ".canvas");
    public static final Set<String> IMAGE_EXTS = ciSet(".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".avif", ".ico");
    private static final Set<String> SKIP_DIRS = ciSet("node_modules", "$RECYCLE.BIN", "System Volume Information");
    private static final Set<String> RESERVED = ciSet("CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6",
            "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9");

    private static final int MAX_FILES = 200_000;
    private static final String W = Compat.WS;

    private static final class WsEntry {
        String dir = "";
        String dirName = "";
        WorkspaceMeta meta = new WorkspaceMeta();
        /** File name → paths relative to the workspace, for [[wiki]] style lookups. */
        CiMap<List<String>> names;
        long namesAt;

        String prefix() {
            return dirName;
        }

        boolean vault() {
            return new File(dir, ".obsidian").isDirectory();
        }
    }

    private static final class TextEntry {
        final long mtime;
        final String text;
        private volatile String folded;

        TextEntry(long mtime, String text) {
            this.mtime = mtime;
            this.text = text;
        }

        String folded() {
            String f = folded;
            if (f == null) folded = f = Fold.fold(text);
            return f;
        }
    }

    /** A function that may fail with an IOException (C# lambdas that copy files). */
    private interface IoFn {
        String apply(String s) throws IOException;
    }

    private interface NoteVisitor {
        void note(FileStat f, String relDir);
    }

    private interface StatVisitor {
        void accept(FileStat f);
    }

    private final Object gate = new Object();
    private final Map<String, WsEntry> byId = new LinkedHashMap<>();
    private final CiMap<TextEntry> textCache = new CiMap<>();
    private final NoteIndex index;
    private final Platform platform;
    private final String root;

    /** The notes folder of the platform; the search index goes to {@code cacheDir()/index}. */
    public NoteStore(Platform platform) {
        this(platform, platform.notesRoot());
    }

    public NoteStore(Platform platform, File notesRoot) {
        this.platform = platform;
        this.root = PathUtil.stripSep(PathUtil.full(notesRoot.getPath()));
        try {
            PathUtil.mkdirs(root);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        this.index = new NoteIndex(new File(platform.cacheDir(), "index"));
    }

    /** The notes folder. */
    public File root() {
        return new File(root);
    }

    /** The notes folder as a path string (NoteStore.Root on the PC). */
    public String rootPath() {
        return root;
    }

    // ───────────────────────────── helpers ─────────────────────────────

    private static final SecureRandom RNG = new SecureRandom();
    private static final char[] HEX = "0123456789abcdef".toCharArray();

    public static String newId(String prefix) {
        byte[] b = new byte[4];
        RNG.nextBytes(b);
        StringBuilder sb = new StringBuilder(prefix).append('-');
        for (byte x : b) sb.append(HEX[(x >> 4) & 15]).append(HEX[x & 15]);
        return sb.toString();
    }

    /** Last write time in Unix milliseconds (0 when the file is missing). */
    public static long mtimeMs(String path) {
        try {
            return Files.getLastModifiedTime(Paths.get(path)).toMillis();
        } catch (IOException | RuntimeException e) {
            return 0;
        }
    }

    static boolean isHiddenName(String name) {
        return name.startsWith(".") || name.startsWith("~") || name.startsWith("$");
    }

    public static boolean isNoteFile(String path) {
        String name = PathUtil.fileName(path);
        return NOTE_EXTS.contains(PathUtil.ext(name)) && !isHiddenName(name);
    }

    private static final Pattern BAD_NAME_RX = Pattern.compile("[<>:\"/\\\\|?*\\x00-\\x1f]");
    private static final Pattern WS_RUN_RX = Pattern.compile("[" + W + "]+");

    public static String sanitizeName(String name) {
        return sanitizeName(name, 80);
    }

    public static String sanitizeName(String name, int max) {
        String s = BAD_NAME_RX.matcher(name == null ? "" : name).replaceAll("-");
        s = Compat.trim(WS_RUN_RX.matcher(s).replaceAll(" "));
        s = Compat.trimEnd(Compat.trimStart(s, ". ~$"), ". ");
        if (s.length() > max) s = Compat.trimEnd(s.substring(0, max), ". ");
        if (s.isEmpty()) s = Lang.t("Untitled", "Sin título");
        String stem = Compat.before(s, '.');
        if (RESERVED.contains(stem)) s = "_" + s;
        return s;
    }

    public static boolean isInside(String path, String dir) {
        return PathUtil.isInside(path, dir);
    }

    private static Set<String> ciNames(String dir) {
        TreeSet<String> s = new TreeSet<>(String.CASE_INSENSITIVE_ORDER);
        String[] l = new File(dir).list();
        if (l != null) Collections.addAll(s, l);
        return s;
    }

    /** A file or folder of that name exists, in any case (the PC's file system ignores case; the phone's may not). */
    private static boolean isTaken(String candidate, Set<String> names) {
        return names.contains(PathUtil.fileName(candidate)) || new File(candidate).exists();
    }

    private static String uniqueFile(String dir, String baseName, String ext, String except) {
        Set<String> names = ciNames(dir);
        String candidate = PathUtil.combine(dir, baseName + ext);
        int n = 2;
        while (isTaken(candidate, names) && !PathUtil.pathEq(candidate, except))
            candidate = PathUtil.combine(dir, baseName + " (" + (n++) + ")" + ext);
        return candidate;
    }

    private static String uniqueDir(String parent, String baseName, String except) {
        Set<String> names = ciNames(parent);
        String candidate = PathUtil.combine(parent, baseName);
        int n = 2;
        while (isTaken(candidate, names) && !PathUtil.pathEq(candidate, except))
            candidate = PathUtil.combine(parent, baseName + " (" + (n++) + ")");
        return candidate;
    }

    private static SecurityException unauthorized() {
        return new SecurityException("Attempted to perform an unauthorized operation.");
    }

    private static IllegalStateException wsNotFound() {
        return new IllegalStateException(Lang.t("Workspace not found", "No se encontró el espacio de trabajo"));
    }

    /** UI path → absolute path. Relative paths must stay inside the notes folder. */
    public String resolve(String apiPath) {
        if (Compat.isBlank(apiPath)) throw new IllegalArgumentException("Empty path");
        // "@id/…" paths are folders opened in place on the PC, which the phone does not have.
        if (apiPath.startsWith("@")) throw wsNotFound();
        String p = PathUtil.toNative(apiPath);
        if (PathUtil.isRooted(p)) return PathUtil.full(p);
        String abs = PathUtil.full(PathUtil.combine(root, p));
        if (!PathUtil.isInside(abs, root)) throw new SecurityException("Path escapes the notes folder: " + apiPath);
        return abs;
    }

    /** Absolute path → UI path (absolute paths outside the notes folder stay absolute). */
    public String toApi(String abs) {
        abs = PathUtil.full(abs);
        if (PathUtil.isInside(abs, root)) return PathUtil.rel(root, abs);
        return abs;
    }

    /**
     * https://files.marknotes.example/r/&lt;path in the notes folder&gt;, or /a/&lt;absolute path&gt; for a file outside it
     * (without the leading '/' of a Unix path: /a/storage/emulated/0/x.png; see {@link #resolveFileUrl}).
     */
    public static String fileUrl(String abs, String root) {
        String rel;
        String kind;
        if (PathUtil.isInside(abs, root)) {
            kind = "r";
            rel = PathUtil.relPath(root, abs);
        } else {
            kind = "a";
            rel = PathUtil.full(abs);
            if (!PathUtil.WINDOWS) rel = Compat.trimStart(rel, "/");
        }
        String[] parts = rel.replace('\\', '/').split("/", -1);
        StringBuilder sb = new StringBuilder("https://").append(FILES_HOST).append('/').append(kind).append('/');
        for (int i = 0; i < parts.length; i++) {
            if (i > 0) sb.append('/');
            sb.append(UriCodec.escapeDataString(parts[i]));
        }
        return sb.toString();
    }

    /**
     * The file a files.marknotes.example URL (or just its path, "/r/Ws/.assets/x.png") stands for, or null. For the
     * WebView's request interceptor: /r/ paths never leave the notes folder.
     */
    public File resolveFileUrl(String url) {
        if (url == null) return null;
        String p = url;
        int cut = p.indexOf('?');
        if (cut >= 0) p = p.substring(0, cut);
        cut = p.indexOf('#');
        if (cut >= 0) p = p.substring(0, cut);
        String host = "https://" + FILES_HOST;
        if (Compat.startsWithIc(p, host)) p = p.substring(host.length());
        List<String> segs = new ArrayList<>();
        for (String s : p.split("/")) if (!s.isEmpty()) segs.add(UriCodec.unescapeDataString(s));
        if (segs.size() < 2) return null;
        String rest = PathUtil.toNative(String.join("/", segs.subList(1, segs.size())));
        try {
            if (segs.get(0).equals("r")) {
                String abs = PathUtil.full(PathUtil.combine(root, Compat.trimStart(rest, String.valueOf(PathUtil.SEP))));
                return PathUtil.isInside(abs, root) ? new File(abs) : null;
            }
            if (segs.get(0).equals("a")) return new File(PathUtil.full(PathUtil.WINDOWS ? rest : "/" + rest));
        } catch (RuntimeException ignored) {
        }
        return null;
    }

    private static final class Frame {
        final String dir;
        final int depth;
        final boolean assets;

        Frame(String dir, int depth, boolean assets) {
            this.dir = dir;
            this.depth = depth;
            this.assets = assets;
        }
    }

    /** Walks a workspace: note files, folders and every other file (for name lookups). */
    private static void walk(String root, NoteVisitor onNote, StatVisitor onFolder, StatVisitor onOther, int maxFiles) {
        int seen = 0;
        ArrayDeque<Frame> stack = new ArrayDeque<>();
        stack.push(new Frame(root, 0, false));
        while (!stack.isEmpty()) {
            Frame fr = stack.pop();
            List<FileStat> entries;
            try {
                entries = FileStat.list(fr.dir);
            } catch (Exception ex) {
                continue;
            }
            String relDir = PathUtil.pathEq(fr.dir, root) ? "" : PathUtil.rel(root, fr.dir);
            try {
                for (FileStat f : entries) {
                    if (f.dir) continue;
                    if (++seen > maxFiles) return;
                    if (!fr.assets && isNoteFile(f.name)) onNote.note(f, relDir);
                    else if (!f.name.startsWith(".") && onOther != null) onOther.accept(f);
                }
                if (fr.depth >= 16) continue;
                for (FileStat d : entries) {
                    if (!d.dir) continue;
                    String name = d.name;
                    if (SKIP_DIRS.contains(name)) continue;
                    if (name.equalsIgnoreCase(ASSETS_DIR)) {
                        if (onOther != null) stack.push(new Frame(d.path, fr.depth + 1, true));
                        continue;
                    }
                    if (isHiddenName(name)) continue;
                    if (!fr.assets && onFolder != null) onFolder.accept(d);
                    stack.push(new Frame(d.path, fr.depth + 1, fr.assets));
                }
            } catch (Exception ex) {
                Log.error("Walk " + fr.dir, ex);
            }
        }
    }

    /** Note files of a workspace with size and dates from the listing itself (one stat each). */
    private static List<FileStat> noteFiles(String root, int maxFiles) {
        List<FileStat> list = new ArrayList<>();
        ArrayDeque<Frame> stack = new ArrayDeque<>();
        stack.push(new Frame(root, 0, false));
        int seen = 0;
        while (!stack.isEmpty()) {
            Frame fr = stack.pop();
            try {
                for (FileStat fsi : FileStat.list(fr.dir)) {
                    if (!fsi.dir) {
                        if (++seen > maxFiles) return list;
                        if (isNoteFile(fsi.name)) list.add(fsi);
                    } else if (fr.depth < 16) {
                        String name = fsi.name;
                        if (SKIP_DIRS.contains(name) || isHiddenName(name) || name.equalsIgnoreCase(ASSETS_DIR)) continue;
                        stack.push(new Frame(fsi.path, fr.depth + 1, false));
                    }
                }
            } catch (Exception ex) {
                Log.error("NoteFiles " + fr.dir, ex);
            }
        }
        return list;
    }

    private static FileStat statOrThrow(String abs) throws FileNotFoundException {
        FileStat fi = FileStat.of(abs);
        if (fi == null || fi.dir) throw new FileNotFoundException(abs);
        return fi;
    }

    private static boolean isFile(String p) {
        return new File(p).isFile();
    }

    private static void move(String src, String dst) throws IOException {
        Files.move(Paths.get(src), Paths.get(dst));
    }

    /** A rename that also works when only the case changes (through a temporary name, as on Windows). */
    private static void rename(String src, String dst) throws IOException {
        if (PathUtil.pathEq(src, dst)) {
            String tmp = src + ".rename-" + Compat.hex6();
            move(src, tmp);
            move(tmp, dst);
        } else move(src, dst);
    }

    /** File.Copy (keeps the last write time, like Windows' CopyFile). */
    private static void copyFile(String src, String dst) throws IOException {
        Path s = Paths.get(src), d = Paths.get(dst);
        Files.copy(s, d);
        try {
            Files.setLastModifiedTime(d, Files.getLastModifiedTime(s));
        } catch (Exception ignored) {
        }
    }

    private static void deleteFile(String p) {
        try {
            Files.deleteIfExists(Paths.get(p));
        } catch (Exception ignored) {
        }
    }

    // ─────────────────────────── trash ───────────────────────────

    /** Deletes recoverably (the PC's Recycle Bin; the platform's trash here). */
    private void recycle(String path) throws IOException {
        File f = new File(path);
        if (!f.exists()) return;
        platform.trash(f);
        if (f.exists())
            throw new IOException(Lang.t("Could not move to the trash: " + path, "No se pudo mover a la papelera: " + path));
    }

    // ───────────────────────────── workspaces ─────────────────────────────

    private static String iconPath(WsEntry e) {
        if (Compat.isEmpty(e.meta.icon)) return null;
        String p = PathUtil.full(PathUtil.combine(e.dir, PathUtil.toNative(e.meta.icon)));
        return PathUtil.isInside(p, e.dir) ? p : null;
    }

    private static String bannerPath(WsEntry e) {
        if (Compat.isEmpty(e.meta.banner)) return null;
        String p = PathUtil.full(PathUtil.combine(e.dir, PathUtil.toNative(e.meta.banner)));
        return PathUtil.isInside(p, e.dir) ? p : null;
    }

    private static WorkspaceMeta loadMetaFile(String f) {
        if (!isFile(f)) return null;
        try {
            return WorkspaceMeta.parse(TextFiles.readAllText(f));
        } catch (Exception ex) {
            Log.error("LoadMeta " + f, ex);
            return null;
        }
    }

    /** Writes through a temp file renamed over the target. */
    private static void writeReplace(String f, byte[] bytes) throws IOException {
        Path target = Paths.get(f), tmp = Paths.get(f + ".tmp");
        Files.write(tmp, bytes);
        try {
            Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException ex) {
            Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    private static void saveMeta(WsEntry e) throws IOException {
        String f = PathUtil.combine(e.dir, WS_META_FILE);
        PathUtil.mkdirs(PathUtil.dirOf(f));
        writeReplace(f, e.meta.toPrettyJson().getBytes(StandardCharsets.UTF_8));
    }

    public List<WorkspaceDto> scan() {
        synchronized (gate) {
            scanEntries();
            List<WorkspaceDto> list = new ArrayList<>(byId.size());
            for (WsEntry e : byId.values()) list.add(toDto(e));
            return list;
        }
    }

    /** Re-reads every workspace folder and its metadata (Scan without building the DTOs). Caller holds the gate. */
    private void scanEntries() {
        Map<String, WsEntry> old = new HashMap<>(byId);
        byId.clear();
        File r = new File(root);
        if (!r.isDirectory()) r.mkdirs();
        List<FileStat> dirs;
        try {
            dirs = FileStat.list(root);
        } catch (IOException ex) {
            Log.error("Scan " + root, ex);
            return;
        }
        for (FileStat d : dirs) {
            if (!d.dir) continue;
            String name = d.name;
            if (isHiddenName(name)) continue;
            WorkspaceMeta meta = loadMetaFile(PathUtil.combine(d.path, WS_META_FILE));
            boolean dirty = false;
            if (meta == null) {
                meta = new WorkspaceMeta();
                meta.name = name;
                meta.created = Compat.nowO();
                dirty = true;
            }
            if (Compat.isBlank(meta.id) || byId.containsKey(meta.id)) {
                meta.id = newId("w");
                dirty = true;
            }
            if (Compat.isBlank(meta.name)) meta.name = name;
            WsEntry e = new WsEntry();
            e.dir = d.path;
            e.dirName = name;
            e.meta = meta;
            WsEntry prev = old.get(meta.id);
            if (prev != null && PathUtil.pathEq(prev.dir, d.path)) {
                e.names = prev.names;
                e.namesAt = prev.namesAt;
            }
            byId.put(meta.id, e);
            if (dirty) {
                try {
                    saveMeta(e);
                } catch (Exception ex) {
                    Log.error("Scan.SaveMeta", ex);
                }
            }
        }
    }

    private WsEntry ws(String id) {
        WsEntry e = byId.get(id);
        if (e != null && new File(e.dir).isDirectory()) return e;
        scanEntries();
        e = byId.get(id);
        if (e != null) return e;
        throw wsNotFound();
    }

    private WsEntry wsForAbs(String abs) {
        WsEntry best = null;
        for (WsEntry e : byId.values())
            if (PathUtil.isInside(abs, e.dir) && (best == null || e.dir.length() > best.dir.length())) best = e;
        if (best != null) return best;
        if (PathUtil.isInside(abs, root)) {
            scanEntries();
            for (WsEntry e : byId.values()) if (PathUtil.isInside(abs, e.dir)) return e;
        }
        return null;
    }

    private WorkspaceDto toDto(WsEntry e) {
        List<FolderDto> folders = new ArrayList<>();
        CiMap<Integer> counts = new CiMap<>();
        int[] loose = {0};
        try {
            walk(e.dir, (f, relDir) -> {
                if (relDir.isEmpty()) loose[0]++;
                else {
                    Integer c = counts.get(relDir);
                    counts.put(relDir, c == null ? 1 : c + 1);
                }
            }, d -> {
                String rel = PathUtil.rel(e.dir, d.path);
                WorkspaceMeta.FolderMeta fm = e.meta.folders.get(rel);
                folders.add(new FolderDto(rel, d.name, fm == null ? null : fm.color, fm == null ? null : fm.icon,
                        fm == null ? null : fm.order, 0, d.ctime, fm == null ? null : fm.description));
            }, null, MAX_FILES);
        } catch (Exception ex) {
            Log.error("ToDto " + e.dir, ex);
        }
        List<FolderDto> withCounts = new ArrayList<>(folders.size());
        for (FolderDto f : folders) {
            Integer c = counts.get(f.path);
            withCounts.add(f.withCount(c == null ? 0 : c));
        }
        sortTree(withCounts);

        String iconUrl = null;
        String ip = iconPath(e);
        if (ip != null && isFile(ip)) iconUrl = fileUrl(ip, root) + "?v=" + mtimeMs(ip);
        String bannerUrl = null;
        String bp = bannerPath(e);
        if (bp != null && isFile(bp)) bannerUrl = fileUrl(bp, root) + "?v=" + mtimeMs(bp);
        return new WorkspaceDto(e.meta.id, e.meta.name, e.prefix(), e.meta.color, iconUrl, e.meta.created, withCounts, loose[0], false,
                e.dir, e.vault(), bannerUrl, Boolean.TRUE.equals(e.meta.bannerHover), Boolean.TRUE.equals(e.meta.guideOn),
                Boolean.TRUE.equals(e.meta.browseOn));
    }

    private static String[] splitPath(String p) {
        return p.split("/", -1);
    }

    private static String joinPath(String[] s, int count) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < count; i++) {
            if (i > 0) sb.append('/');
            sb.append(s[i]);
        }
        return sb.toString();
    }

    /** Depth-first tree order: every folder right after its parent, siblings by their order, then by name like Explorer. */
    private static void sortTree(List<FolderDto> folders) {
        CiMap<FolderDto> byPath = new CiMap<>();
        for (FolderDto f : folders) byPath.put(f.path, f);
        folders.sort((a, b) -> {
            String[] sa = splitPath(a.path), sb = splitPath(b.path);
            int n = Math.min(sa.length, sb.length);
            for (int i = 0; i < n; i++) {
                if (sa[i].equalsIgnoreCase(sb[i])) continue;
                String pa = joinPath(sa, i + 1), pb = joinPath(sb, i + 1);
                FolderDto fa = byPath.get(pa), fb = byPath.get(pb);
                int oa = fa != null && fa.order != null ? fa.order : Integer.MAX_VALUE;
                int ob = fb != null && fb.order != null ? fb.order : Integer.MAX_VALUE;
                if (oa != ob) return Integer.compare(oa, ob);
                int c = NameOrder.compare(sa[i], sb[i]);
                return c != 0 ? c : pa.compareTo(pb);
            }
            return Integer.compare(sa.length, sb.length);
        });
    }

    public WorkspaceDto getWorkspace(String id) {
        synchronized (gate) {
            return toDto(ws(id));
        }
    }

    public WorkspaceDto createWorkspace(String name, String color, byte[] icon, String iconExt, String firstFolder) throws IOException {
        synchronized (gate) {
            String display = Compat.isBlank(name) ? "Workspace" : Compat.trim(name);
            String dir = uniqueDir(root, sanitizeName(display, 60), null);
            PathUtil.mkdirs(dir);
            WsEntry e = new WsEntry();
            e.dir = dir;
            e.dirName = PathUtil.fileName(dir);
            e.meta = new WorkspaceMeta();
            e.meta.id = newId("w");
            e.meta.name = display;
            e.meta.color = color;
            e.meta.created = Compat.nowO();
            if (!Compat.isBlank(firstFolder)) {
                String ff = sanitizeName(firstFolder);
                PathUtil.mkdirs(PathUtil.combine(dir, ff));
                WorkspaceMeta.FolderMeta fm = new WorkspaceMeta.FolderMeta();
                fm.order = 0;
                e.meta.folders.put(ff, fm);
            }
            if (icon != null) writeIcon(e, icon, iconExt);
            saveMeta(e);
            byId.put(e.meta.id, e);
            return toDto(e);
        }
    }

    private static String imageExt(String ext) {
        ext = Compat.isBlank(ext) ? ".png" : (ext.startsWith(".") ? ext : "." + ext);
        return IMAGE_EXTS.contains(ext) ? ext : ".png";
    }

    private static void writeIcon(WsEntry e, byte[] icon, String ext) throws IOException {
        ext = imageExt(ext);
        String old = iconPath(e);
        if (old != null) deleteFile(old);
        String fileName = ".workspace-icon" + ext;
        Files.write(Paths.get(PathUtil.combine(e.dir, fileName)), icon);
        e.meta.icon = fileName;
    }

    private static void writeBanner(WsEntry e, byte[] data, String ext) throws IOException {
        ext = imageExt(ext);
        String old = bannerPath(e);
        if (old != null) deleteFile(old);
        String fileName = ".workspace-banner" + ext;
        Files.write(Paths.get(PathUtil.combine(e.dir, fileName)), data);
        e.meta.banner = fileName;
    }

    /** Banner of a workspace: new image (null = keep), remove it, and whether a GIF plays only on hover (null = keep). */
    public WorkspaceDto updateBanner(String id, byte[] data, String ext, boolean remove, Boolean hover) throws IOException {
        synchronized (gate) {
            WsEntry e = ws(id);
            if (remove) {
                String bp = bannerPath(e);
                if (bp != null) deleteFile(bp);
                e.meta.banner = null;
            }
            if (data != null) writeBanner(e, data, ext);
            if (hover != null) e.meta.bannerHover = hover ? Boolean.TRUE : null;
            saveMeta(e);
            return toDto(e);
        }
    }

    public String getGuide(String id) {
        synchronized (gate) {
            String g = ws(id).meta.guide;
            return g == null ? "" : g;
        }
    }

    public void setGuide(String id, String text) throws IOException {
        synchronized (gate) {
            WsEntry e = ws(id);
            e.meta.guide = Compat.isBlank(text) ? null : text;
            saveMeta(e);
        }
    }

    /** Turns the Workspace Guide / Browse Folders pages on or off (null = leave as is). The guide text is kept. */
    public WorkspaceDto setFeatures(String id, Boolean guide, Boolean browse) throws IOException {
        synchronized (gate) {
            WsEntry e = ws(id);
            if (guide != null) e.meta.guideOn = guide ? Boolean.TRUE : null;
            if (browse != null) e.meta.browseOn = browse ? Boolean.TRUE : null;
            saveMeta(e);
            return toDto(e);
        }
    }

    /** {ws, oldDir}: the new DTO and the old path prefix when the folder on disk was renamed (else null). */
    public Map<String, Object> updateWorkspace(String id, String name, String color, boolean setColor, byte[] icon, String iconExt,
            boolean removeIcon) throws IOException {
        synchronized (gate) {
            WsEntry e = ws(id);
            String oldDir = null;
            if (name != null && !Compat.isBlank(name) && !Compat.trim(name).equals(e.meta.name)) {
                e.meta.name = Compat.trim(name);
                String wanted = sanitizeName(e.meta.name, 60);
                if (!wanted.equals(e.dirName)) {
                    String target = uniqueDir(root, wanted, e.dir);
                    try {
                        if (!PathUtil.pathEq(target, e.dir) || !PathUtil.fileName(target).equals(e.dirName)) {
                            rename(e.dir, target);
                            oldDir = e.dirName;
                            e.dir = target;
                            e.dirName = PathUtil.fileName(target);
                            e.names = null;
                            dropCacheUnder(root);
                        }
                    } catch (Exception ex) {
                        // A file inside may be open elsewhere; keep the old folder name, the display name still changes.
                        Log.error("UpdateWorkspace.Move", ex);
                    }
                }
            }
            if (setColor) e.meta.color = Compat.isBlank(color) ? null : color;
            if (removeIcon) {
                String ip = iconPath(e);
                if (ip != null) deleteFile(ip);
                e.meta.icon = null;
            }
            if (icon != null) writeIcon(e, icon, iconExt);
            saveMeta(e);
            return Json.obj("ws", toDto(e), "oldDir", oldDir);
        }
    }

    public void deleteWorkspace(String id) throws IOException {
        synchronized (gate) {
            WsEntry e = ws(id);
            recycle(e.dir);
            byId.remove(id);
            dropCacheUnder(e.dir);
            index.forget(id);
        }
    }

    public String workspaceDir(String id) {
        synchronized (gate) {
            return ws(id).dir;
        }
    }

    public void flushIndex() {
        index.flush();
    }

    /** What an export needs: the folder, the metadata JSON and the pictures. */
    public static final class ExportSource {
        public final String dir;
        public final String metaJson;
        public final String iconFile;
        public final boolean linked;
        public final String bannerFile;

        ExportSource(String dir, String metaJson, String iconFile, boolean linked, String bannerFile) {
            this.dir = dir;
            this.metaJson = metaJson;
            this.iconFile = iconFile;
            this.linked = linked;
            this.bannerFile = bannerFile;
        }
    }

    public ExportSource exportSource(String id) {
        synchronized (gate) {
            WsEntry e = ws(id);
            String icon = iconPath(e), banner = bannerPath(e);
            return new ExportSource(e.dir, e.meta.toPrettyJson(), icon != null && isFile(icon) ? icon : null, false,
                    banner != null && isFile(banner) ? banner : null);
        }
    }

    // ─────────────────────── workspaces for sync ───────────────────────

    /** Every workspace (folders of the notes root are re-read first), as id, display name and folder. */
    public List<WorkspaceRef> listWorkspaces() {
        synchronized (gate) {
            scanEntries();
            List<WorkspaceRef> list = new ArrayList<>(byId.size());
            for (WsEntry e : byId.values()) list.add(new WorkspaceRef(e.meta.id, e.meta.name, new File(e.dir)));
            return list;
        }
    }

    /**
     * After files were written into a workspace from outside (sync): re-reads its .workspace.json and drops every
     * cache for it (file-name lookups, note texts for search, index entries for previews and covers).
     * null = every workspace (the notes folder is scanned again).
     */
    public void reload(String wsId) {
        synchronized (gate) {
            if (wsId == null) {
                textCache.clear();
                index.forgetAll();
                scanEntries();
                for (WsEntry e : byId.values()) e.names = null;
                return;
            }
            WsEntry e = byId.get(wsId);
            if (e != null) {
                e.names = null;
                dropCacheUnder(e.dir);
            }
            index.forget(wsId);
            WorkspaceMeta m = e != null && new File(e.dir).isDirectory() ? loadMetaFile(PathUtil.combine(e.dir, WS_META_FILE)) : null;
            if (m != null && wsId.equals(m.id)) {
                if (Compat.isBlank(m.name)) m.name = e.dirName;
                e.meta = m;
            } else {
                // Gone, renamed, or its file no longer names this workspace: look at the folder again like a scan.
                scanEntries();
                e = byId.get(wsId);
                if (e != null) {
                    e.names = null;
                    dropCacheUnder(e.dir);
                }
            }
        }
    }

    /**
     * Creates a new workspace folder in the notes root (preferredDirName made safe and unique, ignoring case) and
     * writes {@code workspaceJson} into it as its .workspace.json, byte for byte, in one step under the store lock, so
     * a scan never sees the folder without its metadata. Then registers it. The JSON must be a workspace file with an
     * id no workspace here has.
     */
    public File adoptWorkspace(String preferredDirName, byte[] workspaceJson) throws IOException {
        if (workspaceJson == null) throw new IllegalArgumentException("Missing workspace metadata");
        WorkspaceMeta meta = WorkspaceMeta.parse(TextFiles.readAllText(workspaceJson));
        if (Compat.isBlank(meta.id)) throw new IllegalArgumentException("The workspace metadata has no id");
        synchronized (gate) {
            if (byId.isEmpty()) scanEntries();
            if (byId.containsKey(meta.id)) throw new IllegalStateException("A workspace with id " + meta.id + " already exists");
            String wanted = !Compat.isBlank(preferredDirName) ? preferredDirName : Compat.isBlank(meta.name) ? "Workspace" : meta.name;
            String dir = uniqueDir(root, sanitizeName(wanted, 200), null);
            PathUtil.mkdirs(dir);
            try {
                writeReplace(PathUtil.combine(dir, WS_META_FILE), workspaceJson);
            } catch (IOException | RuntimeException ex) {
                deleteFile(PathUtil.combine(dir, WS_META_FILE));
                deleteFile(PathUtil.combine(dir, WS_META_FILE) + ".tmp");
                deleteFile(dir);
                throw ex;
            }
            WsEntry e = new WsEntry();
            e.dir = dir;
            e.dirName = PathUtil.fileName(dir);
            e.meta = meta;
            if (Compat.isBlank(meta.name)) meta.name = e.dirName;
            byId.put(meta.id, e);
            return new File(dir);
        }
    }

    /**
     * Replaces a workspace's .workspace.json with these bytes (temp file + rename) and makes them its metadata in
     * memory, under the store lock, so no later interface action saves stale metadata over them. The bytes are
     * written as given, except when their "id" is not wsId: then the JSON is rewritten with wsId as its id.
     */
    public void writeWorkspaceMeta(String wsId, byte[] json) throws IOException {
        if (wsId == null || json == null) throw new IllegalArgumentException("Missing workspace metadata");
        String text = TextFiles.readAllText(json);
        WorkspaceMeta meta = WorkspaceMeta.parse(text);
        byte[] bytes = json;
        if (!wsId.equals(meta.id)) {
            Map<String, Object> raw = Json.parseObject(text);
            Map<String, Object> fixed = new LinkedHashMap<>();
            boolean done = false;
            for (Map.Entry<String, Object> kv : raw.entrySet()) {
                if (kv.getKey().equalsIgnoreCase("id")) {
                    if (!done) fixed.put("id", wsId);
                    done = true;
                } else fixed.put(kv.getKey(), kv.getValue());
            }
            if (!done) {
                Map<String, Object> withId = new LinkedHashMap<>();
                boolean placed = false;
                List<String> keys = new ArrayList<>(fixed.keySet());
                int after = -1;
                for (int i = 0; i < keys.size(); i++) if (keys.get(i).equalsIgnoreCase("format") || keys.get(i).equalsIgnoreCase("version")) after = i;
                if (after < 0) {
                    withId.put("id", wsId);
                    placed = true;
                }
                for (int i = 0; i < keys.size(); i++) {
                    withId.put(keys.get(i), fixed.get(keys.get(i)));
                    if (i == after) {
                        withId.put("id", wsId);
                        placed = true;
                    }
                }
                if (!placed) withId.put("id", wsId);
                fixed = withId;
            }
            bytes = WorkspaceMeta.pcText(Json.pretty(fixed)).getBytes(StandardCharsets.UTF_8);
            meta.id = wsId;
        }
        synchronized (gate) {
            WsEntry e = ws(wsId);
            writeReplace(PathUtil.combine(e.dir, WS_META_FILE), bytes);
            if (Compat.isBlank(meta.name)) meta.name = e.dirName;
            e.meta = meta;
        }
    }

    // ───────────────────────────── folders ─────────────────────────────

    private static String parentOf(String rel) {
        int i = rel.lastIndexOf('/');
        return i >= 0 ? rel.substring(0, i) : "";
    }

    private static int maxSiblingOrder(WorkspaceMeta meta, String parent, String except) {
        int max = -1;
        boolean any = false;
        for (Map.Entry<String, WorkspaceMeta.FolderMeta> kv : meta.folders.entrySet()) {
            if (!parentOf(kv.getKey()).equalsIgnoreCase(parent)) continue;
            if (except != null && kv.getKey().equalsIgnoreCase(except)) continue;
            int o = kv.getValue().order != null ? kv.getValue().order : 0;
            if (!any || o > max) max = o;
            any = true;
        }
        return any ? max : -1;
    }

    public FolderDto createFolder(String wsId, String name, String parent) throws IOException {
        synchronized (gate) {
            WsEntry e = ws(wsId);
            String parentDir = Compat.isEmpty(parent) ? e.dir : PathUtil.full(PathUtil.combine(e.dir, PathUtil.toNative(parent)));
            if (!PathUtil.pathEq(parentDir, e.dir) && !PathUtil.isInside(parentDir, e.dir)) throw unauthorized();
            String dir = uniqueDir(parentDir, sanitizeName(name, 60), null);
            PathUtil.mkdirs(dir);
            String rel = PathUtil.rel(e.dir, dir);
            int maxOrder = maxSiblingOrder(e.meta, parent == null ? "" : parent, null);
            WorkspaceMeta.FolderMeta fm = new WorkspaceMeta.FolderMeta();
            fm.order = maxOrder + 1;
            e.meta.folders.put(rel, fm);
            saveMeta(e);
            return new FolderDto(rel, PathUtil.fileName(dir), null, null, maxOrder + 1, 0, System.currentTimeMillis(), null);
        }
    }

    private static void rekeyMeta(WorkspaceMeta meta, String oldRel, String newRel) {
        String oldPrefix = oldRel + "/";
        for (String key : meta.folders.keyList()) {
            if (key.equalsIgnoreCase(oldRel) || Compat.startsWithIc(key, oldPrefix)) {
                WorkspaceMeta.FolderMeta v = meta.folders.remove(key);
                meta.folders.put(newRel + key.substring(oldRel.length()), v);
            }
        }
        for (String key : meta.notes.keyList()) {
            if (!Compat.startsWithIc(key, oldPrefix)) continue;
            WorkspaceMeta.NoteMeta v = meta.notes.remove(key);
            meta.notes.put(newRel + "/" + key.substring(oldPrefix.length()), v);
        }
    }

    /** {name, path, oldPrefix, newPrefix}. */
    public Map<String, Object> renameFolder(String wsId, String path, String newName) throws IOException {
        synchronized (gate) {
            WsEntry e = ws(wsId);
            String src = PathUtil.full(PathUtil.combine(e.dir, PathUtil.toNative(path)));
            if (!new File(src).isDirectory() || !PathUtil.isInside(src, e.dir)) throw new FileNotFoundException(path);
            String parentDir = PathUtil.dirOf(src);
            String target = uniqueDir(parentDir, sanitizeName(newName, 60), src);
            String finalName = PathUtil.fileName(target);
            if (!finalName.equals(PathUtil.fileName(src))) rename(src, target);
            String newRel = PathUtil.rel(e.dir, target);
            rekeyMeta(e.meta, path, newRel);
            saveMeta(e);
            dropCacheUnder(e.dir);
            e.names = null;
            return Json.obj("name", finalName, "path", newRel, "oldPrefix", e.prefix() + "/" + path + "/", "newPrefix", e.prefix() + "/" + newRel + "/");
        }
    }

    /**
     * Moves a folder with everything in it inside another folder of the same workspace ("" = top level). Its icon,
     * colour and description follow it; it goes last among its new siblings. {path, oldPrefix, newPrefix}.
     */
    public Map<String, Object> moveFolder(String wsId, String path, String newParent) throws IOException {
        synchronized (gate) {
            WsEntry e = ws(wsId);
            path = Compat.trimChars(path, "/");
            newParent = Compat.trimChars(newParent == null ? "" : newParent, "/");
            if (parentOf(path).equalsIgnoreCase(newParent))
                return Json.obj("path", path, "oldPrefix", e.prefix() + "/" + path + "/", "newPrefix", e.prefix() + "/" + path + "/");
            if (newParent.equalsIgnoreCase(path) || Compat.startsWithIc(newParent, path + "/"))
                throw new IllegalStateException(Lang.t("A folder can't go inside itself.", "Una carpeta no puede ir dentro de sí misma."));
            String src = PathUtil.full(PathUtil.combine(e.dir, PathUtil.toNative(path)));
            if (!new File(src).isDirectory() || !PathUtil.isInside(src, e.dir)) throw new FileNotFoundException(path);
            String parentDir = newParent.isEmpty() ? e.dir : PathUtil.full(PathUtil.combine(e.dir, PathUtil.toNative(newParent)));
            if (!new File(parentDir).isDirectory() || (!PathUtil.pathEq(parentDir, e.dir) && !PathUtil.isInside(parentDir, e.dir)))
                throw new FileNotFoundException(newParent);
            String target = uniqueDir(parentDir, PathUtil.fileName(src), null);
            move(src, target);
            String newRel = PathUtil.rel(e.dir, target);
            rekeyMeta(e.meta, path, newRel);
            int maxOrder = maxSiblingOrder(e.meta, newParent, newRel);
            WorkspaceMeta.FolderMeta fm = e.meta.folders.get(newRel);
            if (fm == null) e.meta.folders.put(newRel, fm = new WorkspaceMeta.FolderMeta());
            fm.order = maxOrder + 1;
            saveMeta(e);
            dropCacheUnder(e.dir);
            e.names = null;
            return Json.obj("path", newRel, "oldPrefix", e.prefix() + "/" + path + "/", "newPrefix", e.prefix() + "/" + newRel + "/");
        }
    }

    public void deleteFolder(String wsId, String path) throws IOException {
        synchronized (gate) {
            WsEntry e = ws(wsId);
            String dir = PathUtil.full(PathUtil.combine(e.dir, PathUtil.toNative(path)));
            if (!PathUtil.isInside(dir, e.dir)) throw unauthorized();
            recycle(dir);
            String prefix = path + "/";
            for (String key : e.meta.folders.keyList())
                if (key.equalsIgnoreCase(path) || Compat.startsWithIc(key, prefix)) e.meta.folders.remove(key);
            for (String key : e.meta.notes.keyList())
                if (Compat.startsWithIc(key, prefix)) e.meta.notes.remove(key);
            saveMeta(e);
            dropCacheUnder(dir);
            e.names = null;
        }
    }

    public void setFolderMeta(String wsId, String path, String color, String icon, Integer order, boolean setColor, boolean setIcon,
            String description, boolean setDescription) throws IOException {
        synchronized (gate) {
            WsEntry e = ws(wsId);
            WorkspaceMeta.FolderMeta fm = e.meta.folders.get(path);
            if (fm == null) e.meta.folders.put(path, fm = new WorkspaceMeta.FolderMeta());
            if (setColor) fm.color = Compat.isBlank(color) ? null : color;
            if (setIcon) fm.icon = Compat.isBlank(icon) ? null : icon;
            if (order != null) fm.order = order;
            if (setDescription) fm.description = Compat.isBlank(description) ? null : Compat.trim(description);
            saveMeta(e);
        }
    }

    /** Stores the order of sibling folders (full paths, same parent). */
    public void reorderFolders(String wsId, List<String> paths) throws IOException {
        synchronized (gate) {
            WsEntry e = ws(wsId);
            for (int i = 0; i < paths.size(); i++) {
                WorkspaceMeta.FolderMeta fm = e.meta.folders.get(paths.get(i));
                if (fm == null) e.meta.folders.put(paths.get(i), fm = new WorkspaceMeta.FolderMeta());
                fm.order = i;
            }
            saveMeta(e);
        }
    }

    // ───────────────────────────── name lookups ─────────────────────────────

    private static long ticks() {
        return System.nanoTime() / 1_000_000L;
    }

    private CiMap<List<String>> names(WsEntry e, boolean fresh) {
        if (!fresh && e.names != null && ticks() - e.namesAt < 15_000) return e.names;
        CiMap<List<String>> names = new CiMap<>();
        StatVisitor add = f -> {
            List<String> l = names.get(f.name);
            if (l == null) names.put(f.name, l = new ArrayList<>(1));
            l.add(PathUtil.rel(e.dir, f.path));
        };
        walk(e.dir, (f, relDir) -> add.accept(f), null, add, MAX_FILES);
        e.names = names;
        e.namesAt = ticks();
        return names;
    }

    /**
     * Finds a file the way Obsidian does for [[name]] / ![[name.png]]: an exact path first, then by file name
     * anywhere in the workspace, preferring the closest one.
     */
    private String findByName(WsEntry e, String target, String fromDir) {
        target = Compat.trim(target).replace('\\', '/');
        if (target.isEmpty()) return null;
        String nat = PathUtil.toNative(target);
        for (String candidate : new String[] {PathUtil.combine(fromDir, nat), PathUtil.combine(e.dir, nat)}) {
            try {
                String full = PathUtil.full(candidate);
                if (isFile(full) && PathUtil.isInside(full, e.dir)) return full;
            } catch (RuntimeException ignored) {
            }
        }
        String file = target.contains("/") ? target.substring(target.lastIndexOf('/') + 1) : target;
        CiMap<List<String>> names = names(e, false);
        List<String> paths = names.get(file);
        if (paths == null) paths = names.get(file + ".md");
        if (paths == null) return null;
        List<String> withPath = paths;
        if (target.contains("/")) {
            withPath = new ArrayList<>();
            for (String p : paths) if (Compat.endsWithIc(p, target)) withPath.add(p);
            if (withPath.isEmpty()) withPath = paths;
        }
        String fromRel = PathUtil.pathEq(fromDir, e.dir) ? "" : PathUtil.rel(e.dir, fromDir) + "/";
        String best = null;
        int bc = 0, bd = 0, bl = 0;
        for (String p : withPath) {
            int c = commonPrefix(p, fromRel), d = count(p, '/'), l = p.length();
            if (best == null || c > bc || (c == bc && (d < bd || (d == bd && l < bl)))) {
                best = p;
                bc = c;
                bd = d;
                bl = l;
            }
        }
        return PathUtil.combine(e.dir, PathUtil.toNative(best));
    }

    private static int count(String s, char c) {
        int n = 0;
        for (int i = 0; i < s.length(); i++) if (s.charAt(i) == c) n++;
        return n;
    }

    private static int commonPrefix(String a, String b) {
        int n = Math.min(a.length(), b.length()), i = 0;
        while (i < n && Character.toLowerCase(a.charAt(i)) == Character.toLowerCase(b.charAt(i))) i++;
        return i;
    }

    /** Every non-note file of a workspace (images…), relative paths, for wiki-style links in the editor. */
    public List<String> listFiles(String wsId) {
        synchronized (gate) {
            WsEntry e = ws(wsId);
            CiMap<List<String>> names = names(e, true);
            List<String> out = new ArrayList<>();
            for (List<String> l : names.values()) for (String p : l) if (!NOTE_EXTS.contains(PathUtil.ext(p))) out.add(p);
            return out;
        }
    }

    // ───────────────────────────── notes ─────────────────────────────

    private static final Pattern DRIVE_RX = Pattern.compile("^[a-zA-Z]:[\\\\/]");

    private String coverUrl(WsEntry e, String noteAbs, String raw) {
        if (Compat.isBlank(raw)) return null;
        String target = NoteIndex.cleanTarget(raw);
        if (target == null) return null;
        String abs;
        if (DRIVE_RX.matcher(target).find()) abs = PathUtil.WINDOWS && isFile(target) ? PathUtil.full(target) : null;
        else abs = findByName(e, decodeLink(target), PathUtil.dirOf(noteAbs));
        if (abs == null || !IMAGE_EXTS.contains(PathUtil.ext(abs))) return null;
        return fileUrl(abs, root) + "?w=480&v=" + mtimeMs(abs);
    }

    private NoteDto noteToDto(WsEntry e, FileStat fi, NoteIndex.Entry info) {
        String abs = fi.path;
        String relInWs = PathUtil.rel(e.dir, abs);
        String folder = parentOf(relInWs);
        WorkspaceMeta.NoteMeta m = e.meta.notes.get(relInWs);
        long ctime = fi.ctime;
        if (m != null && m.created != null) {
            Long c = Compat.parseDateMs(m.created);
            if (c != null) ctime = c;
        }
        String ext = Compat.trimStart(PathUtil.ext(fi.name), ".").toLowerCase(Locale.ROOT);
        String kind = info != null && info.kind != null ? info.kind : (ext.equals("canvas") ? "canvas" : "note");
        String cover = null;
        if (info != null) {
            try {
                cover = coverUrl(e, abs, info.banner);
                if (cover == null) cover = coverUrl(e, abs, info.firstImage);
            } catch (Exception ex) {
                Log.error("CoverUrl", ex);
            }
        }
        return new NoteDto(e.prefix() + "/" + relInWs, e.meta.id, folder, PathUtil.stem(fi.name), ext, fi.size, fi.mtime, ctime,
                m == null ? null : m.color, m != null && Boolean.TRUE.equals(m.pinned), m != null && Boolean.TRUE.equals(m.autoTitle),
                info == null ? null : info.preview, kind, cover, info == null ? null : info.date);
    }

    private static final ExecutorService POOL = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "mn-index");
        t.setDaemon(true);
        return t;
    });

    /** Parallel.For with at most max threads (this one included). */
    private static void parallelFor(int n, int max, IntConsumer body) {
        if (n == 0) return;
        AtomicInteger next = new AtomicInteger();
        Runnable worker = () -> {
            int i;
            while ((i = next.getAndIncrement()) < n) body.accept(i);
        };
        List<Future<?>> helpers = new ArrayList<>();
        for (int k = 1; k < Math.min(max, n); k++) helpers.add(POOL.submit(worker));
        worker.run();
        for (Future<?> f : helpers) {
            try {
                f.get();
            } catch (InterruptedException ex) {
                Thread.currentThread().interrupt();
                return;
            } catch (ExecutionException ex) {
                Log.error("parallelFor", ex.getCause());
            }
        }
    }

    /**
     * Lists every note of a workspace. Previews, covers and kinds come from a cached index, so only new or changed
     * files are read: thousands of notes list in milliseconds.
     */
    public List<NoteDto> listNotes(String wsId, boolean preview) {
        WsEntry e;
        synchronized (gate) {
            e = ws(wsId);
        }
        List<FileStat> files = noteFiles(e.dir, MAX_FILES);
        List<NoteDto> list = new ArrayList<>(files.size());
        if (!preview) {
            synchronized (gate) {
                for (FileStat f : files) list.add(noteToDto(e, f, index.peek(wsId, PathUtil.rel(e.dir, f.path), f)));
            }
            return list;
        }
        NoteIndex.Entry[] infos = new NoteIndex.Entry[files.size()];
        parallelFor(files.size(), 4, i -> {
            try {
                infos[i] = index.get(wsId, PathUtil.rel(e.dir, files.get(i).path), files.get(i));
            } catch (Exception ex) {
                Log.error("Index " + files.get(i).path, ex);
            }
        });
        synchronized (gate) {
            for (int i = 0; i < files.size(); i++) list.add(noteToDto(e, files.get(i), infos[i]));
        }
        index.saveSoon(wsId);
        return list;
    }

    public NoteDto noteInfo(String path) {
        synchronized (gate) {
            String abs = resolve(path);
            FileStat fi = FileStat.of(abs);
            if (fi == null || fi.dir) return null;
            WsEntry e = wsForAbs(abs);
            if (e == null) {
                String ext = Compat.trimStart(PathUtil.ext(abs), ".").toLowerCase(Locale.ROOT);
                return new NoteDto(toApi(abs), "", "", PathUtil.stem(abs), ext, fi.size, fi.mtime, fi.ctime, null, false, false, null,
                        ext.equals("canvas") ? "canvas" : "note", null, null);
            }
            return noteToDto(e, fi, index.get(e.meta.id, PathUtil.rel(e.dir, abs), fi));
        }
    }

    /** {text, encoding, eol, mtime, size, readOnly}. */
    public Map<String, Object> readNote(String path) throws IOException {
        String abs = resolve(path);
        FileStat fi = FileStat.of(abs);
        if (fi == null || fi.dir) throw new FileNotFoundException(Lang.t("The file no longer exists", "El archivo ya no existe"));
        if (fi.size > 64L * 1024 * 1024)
            throw new IOException(Lang.t("File is too large to open (over 64 MB)", "El archivo es demasiado grande para abrirlo (más de 64 MB)"));
        TextFiles.TextContent t = TextFiles.read(abs);
        boolean readOnly = !new File(abs).canWrite();
        return Json.obj("text", t.text, "encoding", t.encoding, "eol", t.eol, "mtime", fi.mtime, "size", fi.size, "readOnly", readOnly);
    }

    /** {conflict, mtime}: conflict when the file changed on disk since expectMtime (unless force). */
    public Map<String, Object> writeNote(String path, String text, String encoding, String eol, long expectMtime, boolean force) throws IOException {
        String abs = resolve(path);
        if (!force && expectMtime > 0 && isFile(abs)) {
            long cur = mtimeMs(abs);
            if (Math.abs(cur - expectMtime) > 2) return Json.obj("conflict", true, "mtime", cur);
        }
        TextFiles.write(abs, text, encoding, eol);
        synchronized (gate) {
            textCache.remove(abs);
        }
        return Json.obj("conflict", false, "mtime", mtimeMs(abs));
    }

    /** note.append: adds text at the end, keeping the file's encoding and line ends. Returns the new mtime. */
    public long appendNote(String path, String text) throws IOException {
        String abs = resolve(path);
        TextFiles.TextContent t = TextFiles.read(abs);
        TextFiles.write(abs, t.text + (text == null ? "" : text), t.encoding, t.eol);
        return mtimeMs(abs);
    }

    public NoteDto createNote(String wsId, String folder, String title, String ext, String text, boolean autoTitle) throws IOException {
        synchronized (gate) {
            WsEntry e = ws(wsId);
            String dir = Compat.isEmpty(folder) ? e.dir : PathUtil.full(PathUtil.combine(e.dir, PathUtil.toNative(folder)));
            if (!PathUtil.isInside(dir, e.dir) && !PathUtil.pathEq(dir, e.dir)) throw unauthorized();
            PathUtil.mkdirs(dir);
            ext = "." + (Compat.isBlank(ext) ? "md" : Compat.trimStart(ext, "."));
            if (!NOTE_EXTS.contains(ext)) ext = ".md";
            if (ext.equals(".canvas") && Compat.isEmpty(text)) text = "{\"nodes\":[],\"edges\":[]}";
            String abs = uniqueFile(dir, sanitizeName(Compat.isBlank(title) ? Lang.t("Untitled", "Sin título") : title), ext, null);
            TextFiles.write(abs, text == null ? "" : text, "utf8", ext.equals(".canvas") ? "lf" : "crlf");
            String rel = PathUtil.rel(e.dir, abs);
            WorkspaceMeta.NoteMeta nm = new WorkspaceMeta.NoteMeta();
            nm.autoTitle = autoTitle ? Boolean.TRUE : null;
            nm.created = Compat.nowO();
            e.meta.notes.put(rel, nm);
            saveMeta(e);
            e.names = null;
            FileStat fi = statOrThrow(abs);
            return noteToDto(e, fi, index.get(e.meta.id, rel, fi));
        }
    }

    public NoteDto renameNote(String path, String title) throws IOException {
        synchronized (gate) {
            String abs = resolve(path);
            if (!isFile(abs)) throw new FileNotFoundException(path);
            String dir = PathUtil.dirOf(abs);
            String ext = PathUtil.ext(abs);
            String target = uniqueFile(dir, sanitizeName(title), ext, abs);
            WsEntry e = wsForAbs(abs);
            if (!PathUtil.fileName(target).equals(PathUtil.fileName(abs))) {
                rename(abs, target);
                textCache.remove(abs);
                if (e != null) {
                    moveMetaKey(e, abs, e, target);
                    e.names = null;
                }
            }
            FileStat fi = statOrThrow(target);
            if (e == null) {
                return new NoteDto(toApi(target), "", "", PathUtil.stem(target), Compat.trimStart(PathUtil.ext(target), "."), fi.size,
                        fi.mtime, fi.ctime, null, false, false, null, "note", null, null);
            }
            return noteToDto(e, fi, index.get(e.meta.id, PathUtil.rel(e.dir, target), fi));
        }
    }

    private void moveMetaKey(WsEntry from, String fromAbs, WsEntry to, String toAbs) throws IOException {
        String k1 = PathUtil.rel(from.dir, fromAbs);
        String k2 = PathUtil.rel(to.dir, toAbs);
        WorkspaceMeta.NoteMeta m = from.meta.notes.remove(k1);
        if (m != null) {
            to.meta.notes.put(k2, m);
            saveMeta(from);
            if (from != to) saveMeta(to);
        }
    }

    private static final Pattern WIKI_RX = Pattern.compile("(!?\\[\\[)([^\\]|#\\n]+)((?:[#|][^\\]\\n]*)?\\]\\])");

    /** {note, textChanged}: moves a note to another folder or workspace; images it uses follow it across workspaces. */
    public Map<String, Object> moveNote(String path, String wsId, String folder) throws IOException {
        synchronized (gate) {
            String abs = resolve(path);
            if (!isFile(abs)) throw new FileNotFoundException(path);
            WsEntry dst = ws(wsId);
            WsEntry src = wsForAbs(abs);
            String dstDir = Compat.isEmpty(folder) ? dst.dir : PathUtil.full(PathUtil.combine(dst.dir, PathUtil.toNative(folder)));
            if (!PathUtil.isInside(dstDir, dst.dir) && !PathUtil.pathEq(dstDir, dst.dir)) throw unauthorized();
            PathUtil.mkdirs(dstDir);
            if (PathUtil.pathEq(PathUtil.dirOf(abs), dstDir)) {
                FileStat fi = statOrThrow(abs);
                return Json.obj("note", noteToDto(dst, fi, index.get(dst.meta.id, PathUtil.rel(dst.dir, abs), fi)), "textChanged", false);
            }

            String target = uniqueFile(dstDir, PathUtil.stem(abs), PathUtil.ext(abs), null);
            TextFiles.TextContent content = TextFiles.read(abs);
            String srcDir = PathUtil.dirOf(abs);
            String newText = relocateText(content.text, src, dst, srcDir, dstDir, null);
            move(abs, target);
            boolean changed = !newText.equals(content.text);
            if (changed) TextFiles.write(target, newText, content.encoding, content.eol);
            textCache.remove(abs);
            if (src != null) {
                moveMetaKey(src, abs, dst, target);
                src.names = null;
            } else {
                WorkspaceMeta.NoteMeta nm = new WorkspaceMeta.NoteMeta();
                nm.created = Compat.nowO();
                dst.meta.notes.put(PathUtil.rel(dst.dir, target), nm);
                saveMeta(dst);
            }
            dst.names = null;
            FileStat fi = statOrThrow(target);
            return Json.obj("note", noteToDto(dst, fi, index.get(dst.meta.id, PathUtil.rel(dst.dir, target), fi)), "textChanged", changed);
        }
    }

    /**
     * The text of a note going from srcDir to dstDir: relative links still point to the same files (or, with
     * mapTarget, to their copies) and, across workspaces, the images it uses are copied into the new one.
     */
    private String relocateText(String text, WsEntry src, WsEntry dst, String srcDir, String dstDir, IoFn mapTarget) throws IOException {
        IoFn copyImage = img -> {
            String assets = attachmentDir(dst, dstDir);
            PathUtil.mkdirs(assets);
            String copy = uniqueFile(assets, PathUtil.stem(img), PathUtil.ext(img), null);
            copyFile(img, copy);
            return copy;
        };
        String newText = rewriteLinks(text, srcDir, dstDir, target2 -> {
            String mapped = mapTarget == null ? null : mapTarget.apply(target2);
            if (mapped != null) return mapped;
            if (src != null && src != dst && PathUtil.isInside(target2, src.dir) && isFile(target2) && IMAGE_EXTS.contains(PathUtil.ext(target2)))
                return copyImage.apply(target2);
            return target2;
        });
        if (src != null && src != dst) {
            // ![[image.png]] embeds are found by name, so the image must exist in the new workspace too.
            try {
                newText = Compat.replace(WIKI_RX, newText, m -> {
                    String name = Compat.trim(m.group(2));
                    if (!IMAGE_EXTS.contains(PathUtil.ext(name))) return m.group();
                    if (findByName(dst, name, dstDir) != null) return m.group();
                    String found = findByName(src, name, srcDir);
                    if (found == null) return m.group();
                    String copy;
                    try {
                        copy = copyImage.apply(found);
                    } catch (IOException ex) {
                        throw new UncheckedIOException(ex);
                    }
                    dst.names = null;
                    return m.group(1) + PathUtil.fileName(copy) + m.group(3);
                });
            } catch (UncheckedIOException ex) {
                throw ex.getCause();
            }
        }
        return newText;
    }

    /**
     * A copy of a note in a folder of any workspace (its own folder: "Duplicate", named "Note (2)"). Its links and
     * images keep working like after a move; its colour comes along, it starts unpinned.
     */
    public NoteDto copyNote(String path, String wsId, String folder) throws IOException {
        synchronized (gate) {
            String abs = resolve(path);
            if (!isFile(abs)) throw new FileNotFoundException(path);
            WsEntry dst = ws(wsId);
            WsEntry src = wsForAbs(abs);
            String dstDir = Compat.isEmpty(folder) ? dst.dir : PathUtil.full(PathUtil.combine(dst.dir, PathUtil.toNative(folder)));
            if (!PathUtil.isInside(dstDir, dst.dir) && !PathUtil.pathEq(dstDir, dst.dir)) throw unauthorized();
            PathUtil.mkdirs(dstDir);
            String srcDir = PathUtil.dirOf(abs);
            String target = uniqueFile(dstDir, PathUtil.stem(abs), PathUtil.ext(abs), null);
            if (PathUtil.pathEq(srcDir, dstDir)) copyFile(abs, target);
            else {
                TextFiles.TextContent content = TextFiles.read(abs);
                TextFiles.write(target, relocateText(content.text, src, dst, srcDir, dstDir, null), content.encoding, content.eol);
            }
            WorkspaceMeta.NoteMeta m = src != null ? src.meta.notes.get(PathUtil.rel(src.dir, abs)) : null;
            WorkspaceMeta.NoteMeta nm = new WorkspaceMeta.NoteMeta();
            nm.color = m == null ? null : m.color;
            nm.created = Compat.nowO();
            dst.meta.notes.put(PathUtil.rel(dst.dir, target), nm);
            saveMeta(dst);
            dst.names = null;
            FileStat fi = statOrThrow(target);
            return noteToDto(dst, fi, index.get(dst.meta.id, PathUtil.rel(dst.dir, target), fi));
        }
    }

    /**
     * A copy of a folder with everything in it, inside a folder of the same workspace ("" = top level; its own
     * parent: "Duplicate", named "Folder (2)"). Notes keep their links working (links between files of the folder
     * go to the copies); icons, colours and descriptions come along. Returns the copy's path.
     */
    public String copyFolder(String wsId, String path, String newParent) throws IOException {
        synchronized (gate) {
            WsEntry e = ws(wsId);
            String p = Compat.trimChars(path, "/");
            String np = Compat.trimChars(newParent == null ? "" : newParent, "/");
            if (np.equalsIgnoreCase(p) || Compat.startsWithIc(np, p + "/"))
                throw new IllegalStateException(Lang.t("A folder can't be copied inside itself.", "Una carpeta no se puede copiar dentro de sí misma."));
            String src = PathUtil.full(PathUtil.combine(e.dir, PathUtil.toNative(p)));
            if (!new File(src).isDirectory() || !PathUtil.isInside(src, e.dir)) throw new FileNotFoundException(p);
            String parentDir = np.isEmpty() ? e.dir : PathUtil.full(PathUtil.combine(e.dir, PathUtil.toNative(np)));
            if (!new File(parentDir).isDirectory() || (!PathUtil.pathEq(parentDir, e.dir) && !PathUtil.isInside(parentDir, e.dir)))
                throw new FileNotFoundException(np);
            String target = uniqueDir(parentDir, PathUtil.fileName(src), null);
            // Next to the original the copy is at the same depth, so its files can be copied as they are.
            boolean sameDepth = PathUtil.pathEq(PathUtil.dirOf(src), parentDir);
            copyTree(src, target, e, sameDepth, abs -> PathUtil.pathEq(abs, src) ? target
                    : PathUtil.isInside(abs, src) ? PathUtil.combine(target, PathUtil.relPath(src, abs)) : null);
            String newRel = PathUtil.rel(e.dir, target);
            for (Map.Entry<String, WorkspaceMeta.FolderMeta> kv : new ArrayList<>(e.meta.folders.entrySet())) {
                String k = kv.getKey();
                if (!k.equalsIgnoreCase(p) && !Compat.startsWithIc(k, p + "/")) continue;
                WorkspaceMeta.FolderMeta c = kv.getValue().copy();
                e.meta.folders.put(newRel + k.substring(p.length()), c);
            }
            int maxOrder = maxSiblingOrder(e.meta, np, newRel);
            WorkspaceMeta.FolderMeta fm = e.meta.folders.get(newRel);
            if (fm == null) e.meta.folders.put(newRel, fm = new WorkspaceMeta.FolderMeta());
            fm.order = maxOrder + 1;
            String now = Compat.nowO();
            for (Map.Entry<String, WorkspaceMeta.NoteMeta> kv : new ArrayList<>(e.meta.notes.entrySet())) {
                String k = kv.getKey();
                if (!Compat.startsWithIc(k, p + "/")) continue;
                WorkspaceMeta.NoteMeta v = kv.getValue(), c = new WorkspaceMeta.NoteMeta();
                c.color = v.color;
                c.pinned = v.pinned;
                c.autoTitle = v.autoTitle;
                c.created = now;
                e.meta.notes.put(newRel + k.substring(p.length()), c);
            }
            saveMeta(e);
            e.names = null;
            return newRel;
        }
    }

    private void copyTree(String from, String to, WsEntry e, boolean sameDepth, IoFn mapTarget) throws IOException {
        PathUtil.mkdirs(to);
        List<FileStat> entries = FileStat.list(from);
        for (FileStat f : entries) {
            if (f.dir) continue;
            String dest = PathUtil.combine(to, f.name);
            if (sameDepth || !isNoteFile(f.name)) {
                copyFile(f.path, dest);
                continue;
            }
            TextFiles.TextContent content = TextFiles.read(f.path);
            TextFiles.write(dest, relocateText(content.text, e, e, from, to, mapTarget), content.encoding, content.eol);
        }
        for (FileStat d : entries) if (d.dir) copyTree(d.path, PathUtil.combine(to, d.name), e, sameDepth, mapTarget);
    }

    private static final Pattern TEXTURE_RX = Pattern.compile("\\.(png|webp|jpe?g)$", Pattern.CASE_INSENSITIVE);

    private static List<String> readLines(String path) throws IOException {
        String text = TextFiles.readAllText(path);
        List<String> lines = new ArrayList<>();
        int start = 0, n = text.length();
        for (int i = 0; i < n; i++) {
            char c = text.charAt(i);
            if (c == '\n' || c == '\r') {
                lines.add(text.substring(start, i));
                if (c == '\r' && i + 1 < n && text.charAt(i + 1) == '\n') i++;
                start = i + 1;
            }
        }
        if (start < n) lines.add(text.substring(start));
        return lines;
    }

    private static String jsonString(Object o) {
        if (o == null) return null;
        if (o instanceof String) return (String) o;
        throw new IllegalStateException("The node must be of type 'JsonValue' holding a string");
    }

    /**
     * The Spine models next to a skeleton (Nikke-style folders: c820_00, c820_aim_01, c820_cover_02…): every .skel
     * that has its .atlas there, with its name from the folder's fuentes.json when there is one, and its size
     * (skeleton + atlas + textures). {character, models: [{file, atlas, name, bytes}]}.
     */
    public Map<String, Object> spineInfo(String path) throws IOException {
        String abs = resolve(path);
        String dir = PathUtil.dirOf(abs);
        String character = null;
        CiMap<String> names = new CiMap<>();
        try {
            String fj = PathUtil.combine(dir, "fuentes.json");
            if (isFile(fj)) {
                Object root = Json.parse(TextFiles.readAllText(fj));
                if (root instanceof Map) {
                    Map<?, ?> o = (Map<?, ?>) root;
                    Object ch = o.get("personaje") != null ? o.get("personaje") : o.get("character");
                    character = jsonString(ch);
                    Object list = o.get("modelos") != null ? o.get("modelos") : o.get("models");
                    if (list instanceof List) {
                        for (Object m : (List<?>) list) {
                            if (m == null) continue;
                            if (!(m instanceof Map)) throw new IllegalStateException("The node must be of type 'JsonObject'");
                            Map<?, ?> mm = (Map<?, ?>) m;
                            String id = jsonString(mm.get("modelo") != null ? mm.get("modelo") : mm.get("model"));
                            String nm = jsonString(mm.get("nombre") != null ? mm.get("nombre") : mm.get("name"));
                            if (id != null && nm != null) names.put(id, nm);
                        }
                    }
                }
            }
        } catch (Exception ex) {
            Log.error("SpineInfo.fuentes", ex);
        }
        List<Object> models = new ArrayList<>();
        List<String> skels = new ArrayList<>();
        String[] all = new File(dir).list();
        if (all != null) for (String f : all) if (Compat.endsWithIc(f, ".skel") && isFile(PathUtil.combine(dir, f))) skels.add(f);
        skels.sort(String.CASE_INSENSITIVE_ORDER);
        for (String skelName : skels) {
            String skel = PathUtil.combine(dir, skelName);
            String stem = PathUtil.stem(skelName);
            String atlas = PathUtil.combine(dir, stem + ".atlas");
            if (!isFile(atlas)) continue;
            long bytes = new File(skel).length() + new File(atlas).length();
            try {
                for (String line : readLines(atlas)) {
                    String t = Compat.trim(line);
                    if (!TEXTURE_RX.matcher(t).find()) continue;
                    String tex = PathUtil.combine(dir, PathUtil.toNative(t));
                    if (isFile(tex)) bytes += new File(tex).length();
                }
            } catch (Exception ignored) {
            }
            models.add(Json.obj("file", skelName, "atlas", stem + ".atlas", "name", names.get(stem), "bytes", bytes));
        }
        return Json.obj("character", character, "models", models);
    }

    /** Copies note files from anywhere into a folder (import / drag &amp; drop). */
    public List<NoteDto> importFiles(List<String> files, String wsId, String folder) throws IOException {
        synchronized (gate) {
            WsEntry e = ws(wsId);
            String dir = Compat.isEmpty(folder) ? e.dir : PathUtil.full(PathUtil.combine(e.dir, PathUtil.toNative(folder)));
            if (!PathUtil.isInside(dir, e.dir) && !PathUtil.pathEq(dir, e.dir)) throw unauthorized();
            PathUtil.mkdirs(dir);
            List<NoteDto> result = new ArrayList<>();
            for (String f : files) {
                if (f == null || !isFile(f) || !NOTE_EXTS.contains(PathUtil.ext(f))) continue;
                String target = uniqueFile(dir, sanitizeName(PathUtil.stem(f)), PathUtil.ext(f).toLowerCase(Locale.ROOT), null);
                copyFile(f, target);
                String k = PathUtil.rel(e.dir, target);
                WorkspaceMeta.NoteMeta nm = new WorkspaceMeta.NoteMeta();
                nm.created = Compat.nowO();
                e.meta.notes.put(k, nm);
                FileStat fi = statOrThrow(target);
                result.add(noteToDto(e, fi, index.get(e.meta.id, k, fi)));
            }
            saveMeta(e);
            e.names = null;
            return result;
        }
    }

    public void deleteNote(String path) throws IOException {
        synchronized (gate) {
            String abs = resolve(path);
            WsEntry e = wsForAbs(abs);
            recycle(abs);
            textCache.remove(abs);
            if (e != null) {
                e.meta.notes.remove(PathUtil.rel(e.dir, abs));
                saveMeta(e);
                e.names = null;
            }
        }
    }

    /** Deletes a note that was created and never written to (closing an empty new note). */
    public boolean deleteIfEmpty(String path) throws IOException {
        synchronized (gate) {
            String abs = resolve(path);
            if (!isFile(abs)) return true;
            if (new File(abs).length() > 3) return false;
            String t = TextFiles.read(abs).text;
            if (Compat.trim(t).length() > 0) return false;
            Files.deleteIfExists(Paths.get(abs));
            WsEntry e = wsForAbs(abs);
            if (e != null) {
                e.meta.notes.remove(PathUtil.rel(e.dir, abs));
                saveMeta(e);
                e.names = null;
            }
            return true;
        }
    }

    /** Applies {color, pinned, autoTitle} from patch (present keys only); the updated note, or null. */
    public NoteDto setNoteMeta(String path, Map<String, Object> patch) throws IOException {
        synchronized (gate) {
            String abs = resolve(path);
            WsEntry e = wsForAbs(abs);
            if (e == null) return null;
            String k = PathUtil.rel(e.dir, abs);
            WorkspaceMeta.NoteMeta m = e.meta.notes.get(k);
            if (m == null) e.meta.notes.put(k, m = new WorkspaceMeta.NoteMeta());
            if (patch.containsKey("color")) {
                Object c = patch.get("color");
                m.color = c instanceof String && !((String) c).isEmpty() ? (String) c : null;
            }
            if (patch.containsKey("pinned")) m.pinned = Boolean.TRUE.equals(patch.get("pinned")) ? Boolean.TRUE : null;
            if (patch.containsKey("autoTitle")) m.autoTitle = Boolean.TRUE.equals(patch.get("autoTitle")) ? Boolean.TRUE : null;
            saveMeta(e);
            FileStat fi = FileStat.of(abs);
            return fi != null && !fi.dir ? noteToDto(e, fi, index.get(e.meta.id, k, fi)) : null;
        }
    }

    /** [{path, exists, mtime}]. */
    public List<Object> stat(List<String> paths) {
        List<Object> r = new ArrayList<>();
        for (String p : paths) {
            try {
                String abs = resolve(p);
                boolean exists = isFile(abs);
                r.add(Json.obj("path", p, "exists", exists, "mtime", exists ? mtimeMs(abs) : 0L));
            } catch (Exception ex) {
                r.add(Json.obj("path", p, "exists", false, "mtime", 0L));
            }
        }
        return r;
    }

    // ───────────────────────────── images ─────────────────────────────

    private static final Pattern LINK_RX = Pattern.compile(
            "(!?\\[(?:[^\\[\\]]|\\[[^\\]]*\\])*\\]\\()[" + W + "]*(<[^>\\n]+>|[^)" + W + "]+)((?:[" + W + "]+\"[^\"\\n]*\")?[" + W + "]*\\))");

    public static String encodeLink(String rel) {
        StringBuilder sb = new StringBuilder(rel.length() + 8);
        for (char ch : rel.replace('\\', '/').toCharArray()) {
            switch (ch) {
                case ' ' -> sb.append("%20");
                case '(' -> sb.append("%28");
                case ')' -> sb.append("%29");
                case '<' -> sb.append("%3C");
                case '>' -> sb.append("%3E");
                case '%' -> sb.append("%25");
                default -> sb.append(ch);
            }
        }
        return sb.toString();
    }

    public static String decodeLink(String dest) {
        dest = Compat.trim(dest);
        if (dest.length() >= 2 && dest.startsWith("<") && dest.endsWith(">")) dest = dest.substring(1, dest.length() - 1);
        return UriCodec.unescapeDataString(dest);
    }

    private static final Pattern SCHEME_RX = Pattern.compile("^[a-zA-Z][a-zA-Z0-9+.-]*:");

    private static boolean isRelativeLink(String decoded) {
        return decoded.length() > 0 && !decoded.startsWith("#") && !decoded.startsWith("/") && !decoded.startsWith("\\")
                && !SCHEME_RX.matcher(decoded).find();
    }

    /**
     * Re-targets every relative link/image so it still points to the same file after the note moves from fromDir to
     * toDir.
     */
    private static String rewriteLinks(String text, String fromDir, String toDir, IoFn mapTarget) throws IOException {
        try {
            return Compat.replace(LINK_RX, text, m -> {
                String dest = m.group(2);
                String decoded = decodeLink(dest);
                if (!isRelativeLink(decoded)) return m.group();
                String abs;
                try {
                    abs = PathUtil.full(PathUtil.combine(fromDir, PathUtil.toNative(decoded)));
                } catch (RuntimeException ex) {
                    return m.group();
                }
                String newAbs;
                try {
                    newAbs = mapTarget.apply(abs);
                } catch (IOException ex) {
                    throw new UncheckedIOException(ex);
                }
                if (PathUtil.pathEq(fromDir, toDir) && PathUtil.pathEq(abs, newAbs)) return m.group();
                String enc = encodeLink(PathUtil.relPath(toDir, newAbs));
                if (enc.equals(dest)) return m.group();
                return m.group(1) + enc + m.group(3);
            });
        } catch (UncheckedIOException ex) {
            throw ex.getCause();
        }
    }

    /** Obsidian vaults keep attachments where .obsidian/app.json says; MarkNotes uses .assets. */
    private static String attachmentDir(WsEntry e, String noteDir) {
        if (e == null) return PathUtil.combine(noteDir, ASSETS_DIR);
        if (e.vault()) {
            String setting = null;
            try {
                String appJson = PathUtil.combine(PathUtil.combine(e.dir, ".obsidian"), "app.json");
                if (isFile(appJson)) {
                    Object o = Json.parse(TextFiles.readAllText(appJson));
                    if (o instanceof Map) {
                        Object v = ((Map<?, ?>) o).get("attachmentFolderPath");
                        if (v instanceof String) setting = (String) v;
                    }
                }
            } catch (Exception ignored) {
            }
            if (Compat.isBlank(setting) || setting.equals("/")) return e.dir;
            if (setting.startsWith("./")) return PathUtil.full(PathUtil.combine(noteDir, PathUtil.toNative(setting.substring(2))));
            return PathUtil.full(PathUtil.combine(e.dir, PathUtil.toNative(Compat.trimChars(setting, "/"))));
        }
        return PathUtil.combine(e.dir, ASSETS_DIR);
    }

    /**
     * Files dropped or pasted on a canvas (videos, audio, PDFs…): files already in the workspace are used where they
     * are, others are copied to the attachments folder. [{path, name, copied}].
     */
    public List<Object> importAssets(String notePath, List<String> sources) throws IOException {
        List<Object> result = new ArrayList<>();
        synchronized (gate) {
            String noteAbs = resolve(notePath);
            WsEntry e = wsForAbs(noteAbs);
            String noteDir = PathUtil.dirOf(noteAbs);
            for (String srcPath : sources) {
                if (Compat.isBlank(srcPath) || !isFile(srcPath)) continue;
                String full = PathUtil.full(srcPath);
                if (e != null && PathUtil.isInside(full, e.dir)) {
                    result.add(Json.obj("path", toApi(full), "name", PathUtil.fileName(full), "copied", false));
                    continue;
                }
                String dir = attachmentDir(e, noteDir);
                PathUtil.mkdirs(dir);
                boolean wiki = e != null && e.vault();
                String ext = PathUtil.ext(full);
                if (ext.equalsIgnoreCase(".skel")) {
                    // A Spine model plays with its atlas and textures under their own names: they go together, in a folder.
                    String srcDir = PathUtil.dirOf(full);
                    String stem = PathUtil.stem(full);
                    String folder = uniqueDir(dir, sanitizeName(stem, 80), null);
                    PathUtil.mkdirs(folder);
                    String copiedSkel = PathUtil.combine(folder, PathUtil.fileName(full));
                    copyFile(full, copiedSkel);
                    String atlas = PathUtil.combine(srcDir, stem + ".atlas");
                    if (isFile(atlas)) {
                        copyFile(atlas, PathUtil.combine(folder, stem + ".atlas"));
                        for (String line : readLines(atlas)) {
                            String t = Compat.trim(line);
                            if (!TEXTURE_RX.matcher(t).find()) continue;
                            String tex = PathUtil.full(PathUtil.combine(srcDir, PathUtil.toNative(t)));
                            String to = PathUtil.full(PathUtil.combine(folder, PathUtil.toNative(t)));
                            if (!isFile(tex) || isFile(to) || !PathUtil.isInside(to, folder)) continue;
                            PathUtil.mkdirs(PathUtil.dirOf(to));
                            copyFile(tex, to);
                        }
                    }
                    String fj = PathUtil.combine(srcDir, "fuentes.json");
                    if (isFile(fj)) copyFile(fj, PathUtil.combine(folder, "fuentes.json"));
                    if (e != null) e.names = null;
                    result.add(Json.obj("path", toApi(copiedSkel), "name", PathUtil.fileName(copiedSkel), "copied", true));
                    continue;
                }
                String baseName = sanitizeName(PathUtil.stem(full), 80);
                String abs = uniqueFile(dir, baseName, ext, null);
                if (wiki) {
                    CiMap<List<String>> names = names(e, true);
                    Set<String> here = ciNames(dir);
                    int n = 2;
                    while (names.containsKey(PathUtil.fileName(abs)) || isTaken(abs, here)) abs = PathUtil.combine(dir, baseName + " " + (n++) + ext);
                }
                copyFile(full, abs);
                if (e != null) e.names = null;
                result.add(Json.obj("path", toApi(abs), "name", PathUtil.fileName(abs), "copied", true));
            }
        }
        return result;
    }

    private static final DateTimeFormatter WIKI_STAMP = DateTimeFormatter.ofPattern("yyyyMMddHHmmss", Locale.ROOT);
    private static final DateTimeFormatter IMAGE_STAMP = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss", Locale.ROOT);

    /** Saves a pasted/dropped image and returns how to link it from the note: {link, wiki, name, url, path}. */
    public Map<String, Object> saveAsset(String notePath, byte[] bytes, String ext, String preferredName) throws IOException {
        synchronized (gate) {
            String noteAbs = resolve(notePath);
            WsEntry e = wsForAbs(noteAbs);
            String noteDir = PathUtil.dirOf(noteAbs);
            String dir = attachmentDir(e, noteDir);
            PathUtil.mkdirs(dir);
            boolean wiki = e != null && e.vault();
            ext = "." + (Compat.isBlank(ext) ? "png" : Compat.trimStart(ext, ".").toLowerCase(Locale.ROOT));
            if (!IMAGE_EXTS.contains(ext)) ext = ".png";
            String baseName = !Compat.isBlank(preferredName) ? sanitizeName(PathUtil.stem(preferredName), 60)
                    : wiki ? "Pasted image " + LocalDateTime.now().format(WIKI_STAMP)
                    : "image-" + LocalDateTime.now().format(IMAGE_STAMP);
            String abs = uniqueFile(dir, baseName, ext, null);
            if (wiki) {
                // Obsidian finds images by name: keep the name unique in the whole vault.
                CiMap<List<String>> names = names(e, true);
                Set<String> here = ciNames(dir);
                int n = 2;
                while (names.containsKey(PathUtil.fileName(abs)) || isTaken(abs, here)) abs = PathUtil.combine(dir, baseName + " " + (n++) + ext);
            }
            Files.write(Paths.get(abs), bytes);
            if (e != null) e.names = null;
            String rel = PathUtil.relPath(noteDir, abs);
            // path: the workspace path of the image ("Ws/…"), what canvases store (minus the prefix).
            return Json.obj("link", wiki ? PathUtil.fileName(abs) : encodeLink(rel), "wiki", wiki, "name", PathUtil.fileName(abs),
                    "url", fileUrl(abs, root), "path", toApi(abs));
        }
    }

    /**
     * Finds the files a canvas points to. Obsidian stores them relative to the vault root, which may be a folder above
     * the one opened here, so try: the workspace root, the canvas folder and each folder above it, then the file name
     * anywhere in the workspace. Returns UI paths (null = not found).
     */
    public Map<String, Object> resolveFiles(String notePath, List<String> files) {
        String noteAbs = resolve(notePath);
        String noteDir = PathUtil.dirOf(noteAbs);
        WsEntry e;
        synchronized (gate) {
            e = wsForAbs(noteAbs);
        }
        Map<String, Object> result = new LinkedHashMap<>();
        for (String f : new LinkedHashSet<>(files)) {
            if (Compat.isBlank(f) || f.length() > 1000) continue;
            String abs = null;
            try {
                String nat = PathUtil.toNative(f);
                String rel = Compat.trimStart(nat, String.valueOf(PathUtil.SEP));
                if (PathUtil.isRooted(nat)) abs = isFile(nat) ? PathUtil.full(nat) : null;
                if (abs == null && e != null) {
                    String p = PathUtil.full(PathUtil.combine(e.dir, rel));
                    if (isFile(p)) abs = p;
                }
                int up = 0;
                for (String d = noteDir; abs == null && d != null && up < 8; d = PathUtil.dirOf(d), up++) {
                    String p = PathUtil.full(PathUtil.combine(d, rel));
                    if (isFile(p)) abs = p;
                }
                if (abs == null && e != null) {
                    synchronized (gate) {
                        abs = findByName(e, f, noteDir);
                    }
                }
            } catch (Exception ex) {
                Log.error("ResolveFiles " + f, ex);
            }
            result.put(f, abs == null ? null : toApi(abs));
        }
        return result;
    }

    /**
     * What a canvas stores for files it shows: Obsidian writes paths relative to the vault root (the closest folder
     * with .obsidian above the canvas); without a vault, relative to the workspace.
     */
    public List<String> canvasPaths(String canvasPath, List<String> paths) {
        String canvasAbs = resolve(canvasPath);
        WsEntry e;
        synchronized (gate) {
            e = wsForAbs(canvasAbs);
        }
        String base = null;
        int up = 0;
        for (String d = PathUtil.dirOf(canvasAbs); d != null && up < 12; d = PathUtil.dirOf(d), up++) {
            if (new File(d, ".obsidian").isDirectory()) {
                base = d;
                break;
            }
        }
        if (base == null) base = e != null ? e.dir : PathUtil.dirOf(canvasAbs);
        List<String> result = new ArrayList<>();
        for (String p : paths) {
            try {
                String abs = resolve(p);
                String rel = PathUtil.relPath(base, abs);
                result.add(rel.startsWith("..") || PathUtil.isRooted(rel) ? abs : rel.replace('\\', '/'));
            } catch (Exception ex) {
                result.add(p);
            }
        }
        return result;
    }

    /** "file:///C:/x/y.png" / "file:///storage/x.png" → the path (new Uri(x).LocalPath). */
    private static String fileUriPath(String uri) {
        String p = UriCodec.unescapeDataString(uri.substring("file://".length()));
        if (PathUtil.WINDOWS && p.length() >= 3 && p.charAt(0) == '/' && Character.isLetter(p.charAt(1)) && p.charAt(2) == ':') p = p.substring(1);
        return PathUtil.full(PathUtil.toNative(p));
    }

    /** Absolute path of a link/embed target in a note (markdown link, ![[name]] or absolute path), or null. */
    public String resolveLink(String notePath, String link, boolean wiki) {
        String noteAbs = resolve(notePath);
        String noteDir = PathUtil.dirOf(noteAbs);
        if (wiki) {
            synchronized (gate) {
                WsEntry e = wsForAbs(noteAbs);
                if (e != null) return findByName(e, Compat.before(Compat.before(link, '|'), '#'), noteDir);
            }
            String local = PathUtil.combine(noteDir, PathUtil.toNative(link));
            return isFile(local) ? local : null;
        }
        String decoded = decodeLink(link);
        if (!isRelativeLink(decoded)) {
            if (DRIVE_RX.matcher(decoded).find()) return PathUtil.WINDOWS ? PathUtil.full(decoded) : null;
            if (Compat.startsWithIc(decoded, "file:///")) return fileUriPath(decoded);
            return null;
        }
        return PathUtil.full(PathUtil.combine(noteDir, PathUtil.toNative(decoded)));
    }

    /** asset.url: the files.marknotes.example URL of a link target, or null. */
    public String assetUrl(String notePath, String link, boolean wiki) {
        String p = resolveLink(notePath, link, wiki);
        return p == null ? null : fileUrl(p, root);
    }

    private List<String> allNotes(WsEntry e) {
        List<String> list = new ArrayList<>();
        walk(e.dir, (f, relDir) -> list.add(f.path), null, null, MAX_FILES);
        return list;
    }

    /**
     * Renames an image and fixes every note of the workspace that shows it (markdown links and ![[name]] embeds).
     * Notes listed in openPaths are open in the editor; the UI patches those itself, so only the old/new link for
     * each of them is reported. {name, oldName, link, url, updated, edits: [{path, from, to}]}.
     */
    public Map<String, Object> renameAsset(String notePath, String link, String newName, List<String> openPaths, boolean wiki) throws IOException {
        synchronized (gate) {
            String noteAbs = resolve(notePath);
            String oldAbs = resolveLink(notePath, link, wiki);
            if (oldAbs == null) throw new IllegalStateException(Lang.t("Not a local image", "No es una imagen local"));
            if (!isFile(oldAbs)) throw new FileNotFoundException(Lang.t("Image not found", "No se encontró la imagen"));
            String ext = PathUtil.ext(oldAbs);
            String wantedExt = PathUtil.ext(newName);
            String stem = IMAGE_EXTS.contains(wantedExt) ? PathUtil.stem(newName) : newName;
            String newAbs = uniqueFile(PathUtil.dirOf(oldAbs), sanitizeName(stem, 80), ext, oldAbs);
            if (!PathUtil.fileName(newAbs).equals(PathUtil.fileName(oldAbs))) rename(oldAbs, newAbs);
            String oldName = PathUtil.fileName(oldAbs);
            String newFile = PathUtil.fileName(newAbs);

            Set<String> openSet = new TreeSet<>(String.CASE_INSENSITIVE_ORDER);
            for (String p : openPaths) {
                try {
                    openSet.add(resolve(p));
                } catch (Exception ex) {
                    openSet.add(p);
                }
            }
            WsEntry e = wsForAbs(noteAbs);
            List<String> updated = new ArrayList<>();
            if (e != null) {
                for (String f : allNotes(e)) {
                    if (openSet.contains(f)) continue;
                    try {
                        TextFiles.TextContent t = TextFiles.read(f);
                        if (!Compat.containsIc(t.text, oldName) && !Compat.containsIc(t.text, encodeLink(oldName))) continue;
                        String dir = PathUtil.dirOf(f);
                        String nt = Compat.replace(LINK_RX, t.text, m -> {
                            String dec = decodeLink(m.group(2));
                            if (!isRelativeLink(dec)) return m.group();
                            String abs;
                            try {
                                abs = PathUtil.full(PathUtil.combine(dir, PathUtil.toNative(dec)));
                            } catch (RuntimeException ex) {
                                return m.group();
                            }
                            if (!PathUtil.pathEq(abs, oldAbs)) return m.group();
                            return m.group(1) + encodeLink(PathUtil.relPath(dir, newAbs)) + m.group(3);
                        });
                        nt = Compat.replace(WIKI_RX, nt, m -> {
                            String target = Compat.trim(m.group(2));
                            int slash = target.lastIndexOf('/');
                            String file = slash >= 0 ? target.substring(slash + 1) : target;
                            if (!file.equalsIgnoreCase(oldName)) return m.group();
                            String replaced = slash >= 0 ? target.substring(0, slash + 1) + newFile : newFile;
                            return m.group(1) + replaced + m.group(3);
                        });
                        if (!nt.equals(t.text)) {
                            TextFiles.write(f, nt, t.encoding, t.eol);
                            textCache.remove(f);
                            updated.add(toApi(f));
                        }
                    } catch (Exception ex) {
                        Log.error("RenameAsset.update " + f, ex);
                    }
                }
                e.names = null;
            }
            List<Object> edits = new ArrayList<>();
            for (String p : openPaths) {
                String dir;
                try {
                    dir = PathUtil.dirOf(resolve(p));
                } catch (Exception ex) {
                    continue;
                }
                edits.add(Json.obj("path", p, "from", encodeLink(PathUtil.relPath(dir, oldAbs)), "to", encodeLink(PathUtil.relPath(dir, newAbs))));
            }
            return Json.obj("name", newFile, "oldName", oldName,
                    "link", wiki ? newFile : encodeLink(PathUtil.relPath(PathUtil.dirOf(noteAbs), newAbs)),
                    "url", fileUrl(newAbs, root), "updated", updated, "edits", edits);
        }
    }

    public void deleteAsset(String notePath, String link, boolean wiki) throws IOException {
        String abs = resolveLink(notePath, link, wiki);
        if (abs == null) throw new IllegalStateException(Lang.t("Not a local image", "No es una imagen local"));
        if (!IMAGE_EXTS.contains(PathUtil.ext(abs))) throw new IllegalStateException(Lang.t("Not an image", "No es una imagen"));
        recycle(abs);
        synchronized (gate) {
            WsEntry e = wsForAbs(abs);
            if (e != null) e.names = null;
        }
    }

    // ───────────────────────────── search ─────────────────────────────

    /** Caller holds the gate. */
    private void dropCacheUnder(String dir) {
        String d = PathUtil.stripSep(PathUtil.full(dir)) + PathUtil.SEP;
        for (String k : textCache.keyList()) {
            if (k.length() > d.length() && k.regionMatches(true, 0, d, 0, d.length())) textCache.remove(k);
        }
    }

    private TextEntry cachedText(String abs, long mt) throws IOException {
        synchronized (gate) {
            TextEntry c = textCache.get(abs);
            if (c != null && c.mtime == mt) return c;
        }
        String text = new File(abs).length() > 8 * 1024 * 1024 ? "" : TextFiles.read(abs).text;
        TextEntry te = new TextEntry(mt, text);
        synchronized (gate) {
            textCache.put(abs, te);
        }
        return te;
    }

    private static final Pattern TERMS_RX = Pattern.compile("\"([^\"]+)\"|([^" + W + "]+)");

    private static List<String> splitTerms(String q) {
        List<String> terms = new ArrayList<>();
        Matcher m = TERMS_RX.matcher(q);
        while (m.find()) terms.add(m.group(1) != null ? m.group(1) : m.group(2));
        return terms;
    }

    private static final class Scored {
        final SearchHit hit;
        final double score;

        Scored(SearchHit hit, double score) {
            this.hit = hit;
            this.score = score;
        }
    }

    /**
     * Notes whose title or text has every term (quoted phrases allowed), ignoring case and accents, best first:
     * title hits, then the number of matches, then the newest.
     */
    public List<SearchHit> search(String query, String wsId, int limit) {
        List<String> terms = splitTerms(query == null ? "" : query);
        if (terms.isEmpty()) return new ArrayList<>();
        List<String> folded = new ArrayList<>(terms.size());
        for (String t : terms) folded.add(Fold.fold(t));
        List<WsEntry> targets = new ArrayList<>();
        synchronized (gate) {
            if (wsId != null) targets.add(ws(wsId));
            else {
                if (byId.isEmpty()) scanEntries();
                targets.addAll(byId.values());
            }
        }
        List<WsEntry> fileWs = new ArrayList<>();
        List<FileStat> files = new ArrayList<>();
        for (WsEntry e : targets) {
            try {
                walk(e.dir, (f, relDir) -> {
                    fileWs.add(e);
                    files.add(f);
                }, null, null, MAX_FILES);
            } catch (Exception ex) {
                Log.error("Search.enum", ex);
            }
        }

        List<Scored> hits = new ArrayList<>();
        for (int fi = 0; fi < files.size(); fi++) {
            WsEntry e = fileWs.get(fi);
            FileStat f = files.get(fi);
            TextEntry te;
            try {
                te = cachedText(f.path, f.mtime);
            } catch (Exception ex) {
                continue;
            }
            String text = te.text, ftext = te.folded();
            String title = PathUtil.stem(f.name), ftitle = Fold.fold(title);
            int total = 0, titleHits = 0, firstPos = -1;
            boolean all = true;
            for (String term : folded) {
                boolean inTitle = ftitle.contains(term);
                int pos = ftext.indexOf(term);
                if (!inTitle && pos < 0) {
                    all = false;
                    break;
                }
                if (inTitle) titleHits++;
                if (pos >= 0) {
                    if (firstPos < 0 || pos < firstPos) firstPos = pos;
                    int count = 0, p = pos;
                    while (p >= 0 && count < 50) {
                        count++;
                        p = p + term.length() < ftext.length() ? ftext.indexOf(term, p + term.length()) : -1;
                    }
                    total += count;
                }
            }
            if (!all) continue;
            String snippet;
            if (firstPos >= 0) {
                int at = Fold.origIndex(text, firstPos);
                int start = Math.max(0, at - 60);
                int end = Math.min(text.length(), at + 160);
                snippet = (start > 0 ? "…" : "") + Compat.trim(WS_RUN_RX.matcher(text.substring(start, end)).replaceAll(" ")) + (end < text.length() ? "…" : "");
            } else {
                snippet = Compat.trim(WS_RUN_RX.matcher(text.length() > 200 ? text.substring(0, 200) : text).replaceAll(" "));
            }
            String rel = PathUtil.rel(e.dir, f.path);
            String folder = parentOf(rel);
            long mt = f.mtime;
            double score = titleHits * 20 + Math.min(total, 30) + mt / 1e13;
            hits.add(new Scored(new SearchHit(toApi(f.path), e.meta.id, folder, title, snippet, total, mt, titleHits > 0), score));
        }
        hits.sort((a, b) -> Double.compare(b.score, a.score));
        int take = Math.min(hits.size(), Math.max(1, limit));
        List<SearchHit> out = new ArrayList<>(take);
        for (int i = 0; i < take; i++) out.add(hits.get(i).hit);
        return out;
    }
}

package com.marknotes.devhost;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import com.marknotes.core.Json;
import com.marknotes.core.Trash;
import com.marknotes.core.sync.LocalStore;

/** A bare "phone" for sync tests: workspace folders with a .workspace.json, nothing else (no NoteStore). */
final class FileLocalStore implements LocalStore {
    final File root;
    final Trash bin;

    FileLocalStore(File root, File trash) {
        this.root = root;
        this.bin = new Trash(trash, root);
        root.mkdirs();
        trash.mkdirs();
    }

    @Override
    public List<Ws> workspaces() {
        List<Ws> out = new ArrayList<>();
        File[] dirs = root.listFiles();
        if (dirs == null) return out;
        for (File d : dirs) {
            File meta = new File(d, ".workspace.json");
            if (!d.isDirectory() || d.getName().startsWith(".") || !meta.isFile()) continue;
            try {
                Map<String, Object> m = Json.parseObject(new String(Files.readAllBytes(meta.toPath()), StandardCharsets.UTF_8));
                out.add(new Ws(Json.getString(m, "id", ""), Json.getString(m, "name", d.getName()), d));
            } catch (IOException | RuntimeException e) {
                throw new IllegalStateException("bad meta in " + d, e);
            }
        }
        return out;
    }

    File dirOf(String wsId) {
        for (Ws w : workspaces()) if (w.id.equals(wsId)) return w.dir;
        return null;
    }

    @Override
    public File adoptWorkspace(String preferredDirName, byte[] workspaceJson) throws IOException {
        File d = new File(root, preferredDirName);
        for (int n = 2; d.exists(); n++) d = new File(root, preferredDirName + " (" + n + ")");
        if (!d.mkdirs()) throw new IOException("mkdir " + d);
        write(new File(d, ".workspace.json"), workspaceJson);
        return d;
    }

    @Override
    public void writeWorkspaceMeta(String wsId, byte[] json) throws IOException {
        File d = dirOf(wsId);
        if (d == null) throw new IOException("no workspace " + wsId);
        write(new File(d, ".workspace.json"), json);
    }

    @Override
    public void reload(String wsId) {}

    @Override
    public void trash(File f) throws IOException { bin.put(f, "phone", null); }

    @Override
    public String trashFromSync(File f, String pcName) throws IOException { return bin.put(f, "sync", pcName); }

    @Override
    public File restoreFromTrash(String trashId) throws IOException {
        try {
            Object p = bin.restore(trashId, null).get("path");
            return p instanceof String ? new File(root, ((String) p).replace('/', File.separatorChar)) : null;
        } catch (IOException | IllegalArgumentException e) {
            return null;
        }
    }

    static void write(File f, byte[] b) throws IOException {
        f.getParentFile().mkdirs();
        try (OutputStream o = new FileOutputStream(f)) {
            o.write(b);
        }
    }
}

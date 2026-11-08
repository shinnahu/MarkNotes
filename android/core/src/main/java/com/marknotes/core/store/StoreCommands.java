package com.marknotes.core.store;

import com.marknotes.core.Args;
import com.marknotes.core.Bridge;
import com.marknotes.core.Lang;

import java.util.Base64;
import java.util.Locale;
import java.util.Map;

/**
 * The storage commands of the PC's Bridge.cs (ws.*, folder.*, note.*, spine.info, canvas.paths, asset.*,
 * search.query): same command names, argument names and JSON results. The store can be swapped (a new notes
 * folder) with {@link #setStore}.
 */
public final class StoreCommands {
    private volatile NoteStore store;

    public StoreCommands(NoteStore store) {
        this.store = store;
    }

    public NoteStore store() {
        return store;
    }

    public void setStore(NoteStore store) {
        this.store = store;
    }

    /** Registers the storage commands on the bridge; returns the registration (to swap the store later). */
    public static StoreCommands register(Bridge bridge, NoteStore store) {
        StoreCommands c = new StoreCommands(store);
        c.registerOn(bridge);
        return c;
    }

    /** Decoded data: URL (or plain base64) and the extension its MIME type stands for. */
    public static final class DataUrl {
        public final byte[] bytes;
        public final String ext;

        DataUrl(byte[] bytes, String ext) {
            this.bytes = bytes;
            this.ext = ext;
        }
    }

    public static DataUrl dataUrl(String dataUrl) {
        int comma = dataUrl.indexOf(',');
        if (!dataUrl.startsWith("data:") || comma < 0) return new DataUrl(base64(dataUrl), ".png");
        String head = dataUrl.substring(5, comma);
        String mime = Compat.before(head, ';').toLowerCase(Locale.ROOT);
        String ext = switch (mime) {
            case "image/jpeg" -> ".jpg";
            case "image/gif" -> ".gif";
            case "image/webp" -> ".webp";
            case "image/svg+xml" -> ".svg";
            case "image/bmp" -> ".bmp";
            case "image/avif" -> ".avif";
            default -> ".png";
        };
        return new DataUrl(base64(dataUrl.substring(comma + 1)), ext);
    }

    private static byte[] base64(String s) {
        return Base64.getMimeDecoder().decode(s);
    }

    private static Boolean optBool(Map<String, Object> a, String name) {
        return Args.has(a, name) ? Args.b(a, name) : null;
    }

    private static String or(String v, String def) {
        return v != null ? v : def;
    }

    public void registerOn(Bridge b) {
        // Workspaces
        b.on("ws.list", a -> store.scan());
        b.on("ws.get", a -> store.getWorkspace(Args.req(a, "id")));
        b.on("ws.create", a -> {
            NoteStore st = store;
            byte[] icon = null;
            String ext = null;
            String data = Args.s(a, "icon");
            if (data != null && !data.isEmpty()) {
                DataUrl d = dataUrl(data);
                icon = d.bytes;
                ext = d.ext;
            }
            return st.createWorkspace(Args.req(a, "name"), Args.s(a, "color"), icon, ext, or(Args.s(a, "firstFolder"), "General"));
        });
        b.on("ws.update", a -> {
            NoteStore st = store;
            byte[] icon = null;
            String ext = null;
            String data = Args.s(a, "icon");
            if (data != null && !data.isEmpty()) {
                DataUrl d = dataUrl(data);
                icon = d.bytes;
                ext = d.ext;
            }
            return st.updateWorkspace(Args.req(a, "id"), Args.s(a, "name"), Args.s(a, "color"), Args.has(a, "color"), icon, ext,
                    Args.b(a, "removeIcon"));
        });
        b.on("ws.banner", a -> {
            NoteStore st = store;
            byte[] data = null;
            String ext = null;
            String d = Args.s(a, "data");
            if (d != null && !d.isEmpty()) {
                DataUrl u = dataUrl(d);
                data = u.bytes;
                ext = u.ext;
            }
            if (data != null && data.length > 40 * 1024 * 1024)
                throw new IllegalStateException(Lang.t("That image is too large for a banner (over 40 MB).",
                        "Esa imagen es demasiado grande para un banner (más de 40 MB)."));
            Boolean hover = optBool(a, "hover");
            return st.updateBanner(Args.req(a, "id"), data, ext, Args.b(a, "remove"), hover);
        });
        b.on("ws.guide", a -> store.getGuide(Args.req(a, "id")));
        b.on("ws.setGuide", a -> {
            store.setGuide(Args.req(a, "id"), or(Args.s(a, "text"), ""));
            return null;
        });
        b.on("ws.features", a -> store.setFeatures(Args.req(a, "id"), optBool(a, "guide"), optBool(a, "browse")));
        b.on("ws.delete", a -> {
            store.deleteWorkspace(Args.req(a, "id"));
            return null;
        });
        b.on("ws.notes", a -> store.listNotes(Args.req(a, "id"), !Args.has(a, "preview") || Args.b(a, "preview")));
        b.on("ws.files", a -> store.listFiles(Args.req(a, "id")));

        // Folders
        b.on("folder.create", a -> store.createFolder(Args.req(a, "wsId"), Args.req(a, "name"), Args.s(a, "parent")));
        b.on("folder.rename", a -> store.renameFolder(Args.req(a, "wsId"), Args.req(a, "name"), Args.req(a, "newName")));
        b.on("folder.delete", a -> {
            store.deleteFolder(Args.req(a, "wsId"), Args.req(a, "name"));
            return null;
        });
        b.on("folder.setMeta", a -> {
            store.setFolderMeta(Args.req(a, "wsId"), Args.req(a, "name"), Args.s(a, "color"), Args.s(a, "icon"), null,
                    Args.has(a, "color"), Args.has(a, "icon"), Args.s(a, "description"), Args.has(a, "description"));
            return null;
        });
        b.on("folder.reorder", a -> {
            store.reorderFolders(Args.req(a, "wsId"), Args.strs(a, "names"));
            return null;
        });
        b.on("folder.move", a -> store.moveFolder(Args.req(a, "wsId"), Args.req(a, "name"), or(Args.s(a, "parent"), "")));
        b.on("folder.copy", a -> {
            String path = store.copyFolder(Args.req(a, "wsId"), Args.req(a, "name"), or(Args.s(a, "parent"), ""));
            return com.marknotes.core.Json.obj("path", path);
        });

        // Notes
        b.on("note.read", a -> store.readNote(Args.req(a, "path")));
        b.on("note.write", a -> store.writeNote(Args.req(a, "path"), or(Args.s(a, "text"), ""), or(Args.s(a, "encoding"), "utf8"),
                or(Args.s(a, "eol"), "crlf"), Args.l(a, "expectMtime"), Args.b(a, "force")));
        b.on("note.create", a -> store.createNote(Args.req(a, "wsId"), or(Args.s(a, "folder"), ""), Args.s(a, "title"),
                or(Args.s(a, "ext"), "md"), or(Args.s(a, "text"), ""), !Args.has(a, "autoTitle") || Args.b(a, "autoTitle")));
        b.on("note.rename", a -> store.renameNote(Args.req(a, "path"), Args.req(a, "title")));
        b.on("note.move", a -> store.moveNote(Args.req(a, "path"), Args.req(a, "wsId"), or(Args.s(a, "folder"), "")));
        b.on("note.copy", a -> store.copyNote(Args.req(a, "path"), Args.req(a, "wsId"), or(Args.s(a, "folder"), "")));
        b.on("note.delete", a -> {
            store.deleteNote(Args.req(a, "path"));
            return null;
        });
        b.on("note.deleteIfEmpty", a -> store.deleteIfEmpty(Args.req(a, "path")));
        b.on("note.setMeta", a -> {
            String path = Args.req(a, "path");
            Map<String, Object> patch = Args.map(a, "patch");
            if (patch == null) throw new IllegalArgumentException("Missing patch");
            return store.setNoteMeta(path, patch);
        });
        b.on("note.stat", a -> store.stat(Args.strs(a, "paths")));
        b.on("note.resolveFiles", a -> store.resolveFiles(Args.req(a, "path"), Args.strs(a, "files")));
        b.on("note.info", a -> store.noteInfo(Args.req(a, "path")));
        b.on("note.import", a -> store.importFiles(Args.strs(a, "paths"), Args.req(a, "wsId"), or(Args.s(a, "folder"), "")));
        b.on("note.append", a -> store.appendNote(Args.req(a, "path"), Args.s(a, "text")));

        // Spine models: the models of a folder (costumes, poses, names from fuentes.json).
        b.on("spine.info", a -> store.spineInfo(Args.req(a, "path")));
        b.on("canvas.paths", a -> store.canvasPaths(Args.req(a, "path"), Args.strs(a, "paths")));

        // Images and attachments
        b.on("asset.save", a -> {
            NoteStore st = store;
            DataUrl d = dataUrl(Args.req(a, "data"));
            return st.saveAsset(Args.req(a, "notePath"), d.bytes, or(Args.s(a, "ext"), d.ext), Args.s(a, "name"));
        });
        b.on("asset.import", a -> store.importAssets(Args.req(a, "notePath"), Args.strs(a, "paths")));
        b.on("asset.rename", a -> store.renameAsset(Args.req(a, "notePath"), Args.req(a, "link"), Args.req(a, "newName"),
                Args.strs(a, "openPaths"), Args.b(a, "wiki")));
        b.on("asset.delete", a -> {
            store.deleteAsset(Args.req(a, "notePath"), Args.req(a, "link"), Args.b(a, "wiki"));
            return null;
        });
        b.on("asset.url", a -> store.assetUrl(Args.req(a, "notePath"), Args.req(a, "link"), Args.b(a, "wiki")));

        // Search
        b.on("search.query", a -> {
            long limit = Args.l(a, "limit");
            return store.search(or(Args.s(a, "q"), ""), Args.s(a, "wsId"), (int) Math.max(1, limit == 0 ? 200 : Math.min(limit, Integer.MAX_VALUE)));
        });
    }
}

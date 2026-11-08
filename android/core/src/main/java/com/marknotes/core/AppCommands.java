package com.marknotes.core;

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
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;

/**
 * The app.* commands of the phone (settings, state, start-up info), and answers for the PC-only commands the
 * interface may still call (transcription, Explorer, file types, packs, PDF) so nothing fails loudly.
 */
public final class AppCommands {
    /** What only the device itself can do. */
    public interface Host {
        String version();

        /** Opens a web link in the phone's browser. */
        void openExternal(String url);

        /** The theme's colours, for the status and navigation bars. */
        void setChrome(String bg, String text);

        /** Notes passed to the app (shared to it, opened with it): absolute paths. */
        List<String> launchFiles();
    }

    private final Platform platform;
    private final Host host;
    private final Callable<Object> workspaces;
    private volatile boolean embeds = true;

    public AppCommands(Platform platform, Host host, Callable<Object> workspaces) {
        this.platform = platform;
        this.host = host;
        this.workspaces = workspaces;
    }

    /** Web videos (YouTube, X) may load inside notes (Settings › Editor). */
    public boolean embedsAllowed() { return embeds; }

    private File settingsFile() { return new File(platform.configDir(), "settings.json"); }

    private File stateFile() { return new File(platform.configDir(), "state.json"); }

    static String readText(File f) throws IOException {
        try (InputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream o = new ByteArrayOutputStream();
            byte[] buf = new byte[1 << 15];
            int n;
            while ((n = in.read(buf)) > 0) o.write(buf, 0, n);
            return new String(o.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    /** Temp file, then replace: a crash never leaves half a settings file. */
    static void writeText(File f, String text) throws IOException {
        File dir = f.getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new IOException("Can't create " + dir);
        File tmp = new File(dir, f.getName() + ".tmp");
        try (OutputStream o = new FileOutputStream(tmp)) {
            o.write(text.getBytes(StandardCharsets.UTF_8));
        }
        Files.move(tmp.toPath(), f.toPath(), StandardCopyOption.REPLACE_EXISTING);
    }

    private Object readJson(File f) {
        try {
            if (f.isFile()) return Json.parse(readText(f));
        } catch (IOException | RuntimeException e) {
            Log.error("readJson " + f, e);
        }
        return Json.obj();
    }

    public void register(Bridge b) {
        b.on("app.init", a -> {
            Map<String, Object> m = Json.obj();
            m.put("version", host.version());
            m.put("platform", platform.platformName());
            m.put("settings", readJson(settingsFile()));
            m.put("state", readJson(stateFile()));
            m.put("notesRoot", platform.notesRoot().getAbsolutePath());
            m.put("defaultNotesRoot", platform.notesRoot().getAbsolutePath());
            m.put("configDir", platform.configDir().getAbsolutePath());
            m.put("isTest", false);
            m.put("workspaces", workspaces.call());
            m.put("migration", null);
            m.put("launchFiles", new ArrayList<Object>(host.launchFiles()));
            m.put("speech", Json.obj("engine", false, "models", 0L));
            m.put("device", platform.deviceName());
            return m;
        });
        b.on("app.ready", a -> null);
        b.on("app.saveSettings", a -> {
            writeText(settingsFile(), Json.write(a.get("settings")));
            return null;
        });
        b.on("app.saveState", a -> {
            writeText(stateFile(), Json.write(a.get("state")));
            return null;
        });
        b.on("app.setTitle", a -> null);
        b.on("app.setLanguage", a -> { Lang.set(Args.s(a, "lang")); return null; });
        b.on("app.setChrome", a -> { host.setChrome(Args.s(a, "bg"), Args.s(a, "text")); return null; });
        b.on("app.openExternal", a -> {
            String url = Args.req(a, "url");
            String l = url.toLowerCase(java.util.Locale.ROOT);
            if (l.startsWith("http://") || l.startsWith("https://") || l.startsWith("mailto:") || l.startsWith("tel:")) host.openExternal(url);
            return null;
        });
        b.on("app.closeReady", a -> null);
        b.on("app.quit", a -> null);
        b.on("app.devtools", a -> null);
        b.on("app.setEmbeds", a -> { embeds = Args.b(a, "on"); return null; });

        // PC-only: Explorer, Windows file types, the notes folder picker.
        for (String c : new String[] {"app.reveal", "app.revealRoot", "app.revealConfig", "ws.reveal", "folder.reveal", "asset.reveal",
                "app.defaultAppsSettings", "asset.open", "pdf.open"}) {
            b.on(c, a -> null);
        }
        b.on("app.fileAssoc", a -> null);
        b.on("app.registerFileTypes", a -> null);
        b.on("app.chooseDefault", a -> null);
        b.on("app.pickFolder", a -> null);
        b.on("note.openDialog", a -> new ArrayList<Object>());
        b.on("theme.import", a -> new ArrayList<Object>());
        b.on("asset.copy", a -> false);
        b.on("clipboard.read", a -> Json.obj("canvas", null, "text", null, "files", new ArrayList<Object>(), "image", false));
        b.on("clipboard.writeCanvas", a -> null);
        b.on("clipboard.saveImage", a -> null);
        // Link previews stay on the PC for now: links show as plain links on the phone.
        b.on("link.preview", a -> null);
        b.on("link.refresh", a -> null);
        b.on("link.cached", a -> null);
        b.on("link.sync", a -> null);
        b.on("link.rename", a -> null);
        String onPc = Lang.t("That is only in MarkNotes on the PC.", "Eso está solo en MarkNotes para PC.");
        for (String c : new String[] {"app.setNotesRoot", "ws.link", "ws.unlink", "archive.exportWorkspace", "archive.exportAll",
                "archive.import", "theme.export", "pdf.choose", "pdf.print", "note.saveAs", "file.saveAs",
                "asr.status", "asr.download", "asr.cancelDownload", "asr.deleteModel", "asr.importModel", "asr.start", "asr.stop",
                "asr.transcribeFile"}) {
            if (!b.has(c)) b.on(c, a -> { throw new UnsupportedOperationException(onPc); });
        }
    }
}

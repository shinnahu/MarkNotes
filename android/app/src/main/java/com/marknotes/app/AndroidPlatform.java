package com.marknotes.app;

import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.webkit.WebView;

import java.io.File;
import java.io.IOException;

import com.marknotes.core.Platform;
import com.marknotes.core.Trash;

/** The phone side of {@link Platform}: folders, trash, the device's name, and messages to the page. */
final class AndroidPlatform implements Platform {
    private final Context ctx;
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile WebView web;
    private final File notes;
    private final File config;
    private final File cache;
    private final Trash trash;
    private final File history;

    AndroidPlatform(Context ctx) {
        this.ctx = ctx.getApplicationContext();
        // Notes in the app's own storage on the phone (reachable from a PC over USB in Android/data/com.marknotes.app).
        File ext = this.ctx.getExternalFilesDir(null);
        File base = ext != null ? ext : this.ctx.getFilesDir();
        notes = new File(base, "Notes");
        trash = new Trash(new File(base, "Trash"), notes);
        history = new File(base, "SyncHistory");
        config = new File(this.ctx.getFilesDir(), "config");
        cache = this.ctx.getCacheDir();
        notes.mkdirs();
        config.mkdirs();
    }

    void attach(WebView w) { web = w; }

    @Override
    public void postToUi(String json) {
        final String js = "window.__mnHost&&window.__mnHost(" + json + ")";
        main.post(() -> {
            WebView w = web;
            if (w != null) w.evaluateJavascript(js, null);
        });
    }

    @Override public File notesRoot() { return notes; }

    @Override public File configDir() { return config; }

    @Override public File cacheDir() { return cache; }

    /**
     * Deleted notes, folders and pictures wait in Trash until the user restores them or deletes them for good
     * (Settings › Trash); emptied by date only when the user turned that on.
     */
    @Override
    public void trash(File f) throws IOException { trash.put(f, "phone", null); }

    @Override
    public void trash(File f, String by, String pc) throws IOException { trash.put(f, by, pc); }

    @Override
    public Trash trashBin() { return trash; }

    /** Sync runs and the phone's versions they replaced (Settings › Sync with PC › Recent syncs). */
    @Override
    public File historyDir() { return history; }

    @Override
    public String deviceName() {
        String n = null;
        try {
            n = Settings.Global.getString(ctx.getContentResolver(), Settings.Global.DEVICE_NAME);
        } catch (RuntimeException ignored) {
        }
        if (n == null || n.trim().isEmpty()) n = Build.MODEL;
        return n == null ? "Android" : n.trim();
    }

    @Override
    public String deviceModel() {
        String m = Build.MANUFACTURER + " " + Build.MODEL;
        return m.trim();
    }

    @Override public String platformName() { return "android"; }
}

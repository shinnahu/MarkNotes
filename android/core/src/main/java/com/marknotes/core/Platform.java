package com.marknotes.core;

import java.io.File;
import java.io.IOException;

/**
 * What the shared code needs from the device it runs on (the Android app, or the PC test harness).
 * Everything else in core is plain Java.
 */
public interface Platform {
    /** Sends one message (a JSON object, already serialized) to the web UI. Any thread. */
    void postToUi(String json);

    /** Folder of the notes: one sub-folder per workspace. */
    File notesRoot();

    /** settings.json, state.json, sync pairings (kept with the app, backed up with it). */
    File configDir();

    /** Re-creatable data: search index, thumbnails. */
    File cacheDir();

    /**
     * Deletes a file or folder recoverably (the PC uses the Recycle Bin; the phone keeps it in MarkNotes' trash until
     * the user restores it or deletes it for good). Must not throw when the path is already gone.
     */
    void trash(File f) throws IOException;

    /**
     * {@link #trash(File)}, saying who deleted it: {@code by} = "phone" (this app) or "sync" (it was deleted on the PC
     * named {@code pc}).
     */
    default void trash(File f, String by, String pc) throws IOException { trash(f); }

    /** The trash the user opens in Settings › Trash, or null where there is none (storage tests). */
    default Trash trashBin() { return null; }

    /** Where sync runs are recorded with the phone's versions they replaced (to undo a sync). Never a cache folder. */
    default File historyDir() { return new File(configDir(), "sync-history"); }

    /** Device name shown to the PC while pairing ("Galaxy S23"). */
    String deviceName();

    /** Device model ("SM-S911B"). */
    String deviceModel();

    /** "android" in the app, "devhost" in the PC test harness. */
    String platformName();
}

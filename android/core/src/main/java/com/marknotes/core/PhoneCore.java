package com.marknotes.core;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

import com.marknotes.core.store.NoteStore;
import com.marknotes.core.store.StoreCommands;
import com.marknotes.core.store.WorkspaceRef;
import com.marknotes.core.sync.LocalStore;
import com.marknotes.core.sync.SyncCommands;

/** Everything behind the phone's interface, wired together (the Android app and the PC test harness both use it). */
public final class PhoneCore {
    public final NoteStore store;
    public final AppCommands app;
    public final SyncCommands sync;

    private PhoneCore(NoteStore store, AppCommands app, SyncCommands sync) {
        this.store = store;
        this.app = app;
        this.sync = sync;
    }

    public static PhoneCore start(final Platform platform, Bridge bridge, AppCommands.Host host) {
        final NoteStore store = new NoteStore(platform);
        StoreCommands.register(bridge, store);
        Trash bin = platform.trashBin();
        if (bin != null) TrashCommands.register(bridge, bin, store);
        AppCommands app = new AppCommands(platform, host, () -> store.scan());
        app.register(bridge);
        LocalStore local = new LocalStore() {
            @Override
            public List<Ws> workspaces() {
                List<Ws> out = new ArrayList<>();
                for (WorkspaceRef w : store.listWorkspaces()) out.add(new Ws(w.id, w.name, w.dir));
                return out;
            }

            @Override
            public File adoptWorkspace(String preferredDirName, byte[] workspaceJson) throws IOException {
                return store.adoptWorkspace(preferredDirName, workspaceJson);
            }

            @Override
            public void writeWorkspaceMeta(String wsId, byte[] json) throws IOException {
                store.writeWorkspaceMeta(wsId, json);
            }

            @Override
            public void reload(String wsId) { store.reload(wsId); }

            @Override
            public void trash(File f) throws IOException { platform.trash(f); }

            @Override
            public String trashFromSync(File f, String pcName) throws IOException {
                Trash t = platform.trashBin();
                if (t != null) return t.put(f, "sync", pcName);
                platform.trash(f, "sync", pcName);
                return null;
            }

            @Override
            public File restoreFromTrash(String trashId) throws IOException {
                Trash t = platform.trashBin();
                if (t == null || trashId == null) return null;
                try {
                    Object p = t.restore(trashId, null).get("path");
                    return p instanceof String ? new File(platform.notesRoot(), ((String) p).replace('/', File.separatorChar)) : null;
                } catch (IOException | IllegalArgumentException e) {
                    Log.info("Undo: " + trashId + ": " + e.getMessage());
                    return null;
                }
            }
        };
        SyncCommands sync = new SyncCommands(bridge, platform, local);
        sync.register();
        return new PhoneCore(store, app, sync);
    }
}

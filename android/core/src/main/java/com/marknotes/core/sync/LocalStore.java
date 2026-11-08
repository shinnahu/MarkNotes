package com.marknotes.core.sync;

import java.io.File;
import java.io.IOException;
import java.util.List;

/** What the sync needs from the phone's note store (adapter in SyncCommands). */
public interface LocalStore {
    final class Ws {
        public final String id;
        public final String name;
        public final File dir;

        public Ws(String id, String name, File dir) {
            this.id = id;
            this.name = name;
            this.dir = dir;
        }
    }

    /** Every workspace on this phone (scans the notes folder). */
    List<Ws> workspaces();

    /** A workspace that came from the PC: a new folder created together with its .workspace.json. */
    File adoptWorkspace(String preferredDirName, byte[] workspaceJson) throws IOException;

    /** Writes a workspace's .workspace.json and takes it as its metadata, under the store lock. */
    void writeWorkspaceMeta(String wsId, byte[] json) throws IOException;

    /** Drops cached data of a workspace after the sync changed its files (null = all). */
    void reload(String wsId);

    /** Recoverable delete (MarkNotes' trash on the phone). */
    void trash(File f) throws IOException;

    /** A recoverable delete made by a sync: the PC named {@code pcName} deleted it. Returns its Trash id (or null). */
    default String trashFromSync(File f, String pcName) throws IOException {
        trash(f);
        return null;
    }

    /** Undo of a sync: puts a Trash item back where it was. Returns where it went, or null when it is gone. */
    default File restoreFromTrash(String trashId) throws IOException { return null; }
}

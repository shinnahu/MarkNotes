package com.marknotes.core.store;

import java.io.File;

/** A workspace for code that works with its files (sync): its id, display name and folder. */
public final class WorkspaceRef {
    public final String id;
    public final String name;
    public final File dir;

    public WorkspaceRef(String id, String name, File dir) {
        this.id = id;
        this.name = name;
        this.dir = dir;
    }

    @Override
    public String toString() {
        return id + " " + name + " (" + dir + ")";
    }
}

package com.marknotes.core;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import com.marknotes.core.store.NoteStore;
import com.marknotes.core.store.WorkspaceRef;

/** The trash.* commands of the phone (Settings › Trash). */
public final class TrashCommands {
    private TrashCommands() {}

    public static void register(Bridge b, final Trash trash, final NoteStore store) {
        b.on("trash.list", a -> {
            List<Map<String, Object>> items = trash.list();
            long bytes = 0;
            for (Map<String, Object> m : items) bytes += Json.getLong(m, "size", 0);
            return Json.obj("items", new ArrayList<Object>(items), "bytes", bytes);
        });
        // ids: items to put back; wsId: the workspace that is open (for items that don't know where they were).
        b.on("trash.restore", a -> {
            String wsId = Args.s(a, "wsId");
            File fallback = null;
            if (wsId != null) for (WorkspaceRef w : store.listWorkspaces()) if (w.id.equals(wsId)) fallback = w.dir;
            List<Object> done = new ArrayList<>(), errors = new ArrayList<>();
            for (String id : Args.strs(a, "ids")) {
                try {
                    done.add(trash.restore(id, fallback));
                } catch (IOException | RuntimeException e) {
                    errors.add(Json.obj("id", id, "error", e.getMessage()));
                }
            }
            if (!done.isEmpty()) store.reload(null);
            return Json.obj("restored", done, "errors", errors);
        });
        b.on("trash.delete", a -> {
            for (String id : Args.strs(a, "ids")) trash.delete(id);
            return null;
        });
        b.on("trash.empty", a -> (long) trash.empty());
        // Settings › Trash › "Empty the trash automatically": 0 = never (the default).
        b.on("trash.autoEmpty", a -> {
            long days = Args.l(a, "days");
            return days > 0 ? (long) trash.emptyOlderThan((int) Math.min(days, 3650)) : 0L;
        });
    }
}

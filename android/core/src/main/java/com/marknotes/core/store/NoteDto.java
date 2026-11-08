package com.marknotes.core.store;

import com.marknotes.core.Json;

import java.util.LinkedHashMap;
import java.util.Map;

/** A note as lists and cards show it (same JSON as the PC's NoteDto record). */
public final class NoteDto implements Json.JsonValue {
    public final String path;
    public final String wsId;
    public final String folder;
    public final String title;
    public final String ext;
    public final long size;
    public final long mtime;
    public final long ctime;
    public final String color;
    public final boolean pinned;
    public final boolean autoTitle;
    public final String preview;
    public final String kind;
    public final String cover;
    public final String date;

    public NoteDto(String path, String wsId, String folder, String title, String ext, long size, long mtime, long ctime, String color,
            boolean pinned, boolean autoTitle, String preview, String kind, String cover, String date) {
        this.path = path;
        this.wsId = wsId;
        this.folder = folder;
        this.title = title;
        this.ext = ext;
        this.size = size;
        this.mtime = mtime;
        this.ctime = ctime;
        this.color = color;
        this.pinned = pinned;
        this.autoTitle = autoTitle;
        this.preview = preview;
        this.kind = kind;
        this.cover = cover;
        this.date = date;
    }

    @Override
    public Object toJson() {
        Map<String, Object> o = new LinkedHashMap<>();
        o.put("path", path);
        o.put("wsId", wsId);
        o.put("folder", folder);
        o.put("title", title);
        o.put("ext", ext);
        o.put("size", size);
        o.put("mtime", mtime);
        o.put("ctime", ctime);
        o.put("color", color);
        o.put("pinned", pinned);
        o.put("autoTitle", autoTitle);
        o.put("preview", preview);
        o.put("kind", kind);
        o.put("cover", cover);
        o.put("date", date);
        return o;
    }
}

package com.marknotes.core.store;

import com.marknotes.core.Json;

import java.util.LinkedHashMap;
import java.util.Map;

/** One search result (same JSON as the PC's SearchHit record). */
public final class SearchHit implements Json.JsonValue {
    public final String path;
    public final String wsId;
    public final String folder;
    public final String title;
    public final String snippet;
    public final int matches;
    public final long mtime;
    public final boolean titleMatch;

    public SearchHit(String path, String wsId, String folder, String title, String snippet, int matches, long mtime, boolean titleMatch) {
        this.path = path;
        this.wsId = wsId;
        this.folder = folder;
        this.title = title;
        this.snippet = snippet;
        this.matches = matches;
        this.mtime = mtime;
        this.titleMatch = titleMatch;
    }

    @Override
    public Object toJson() {
        Map<String, Object> o = new LinkedHashMap<>();
        o.put("path", path);
        o.put("wsId", wsId);
        o.put("folder", folder);
        o.put("title", title);
        o.put("snippet", snippet);
        o.put("matches", matches);
        o.put("mtime", mtime);
        o.put("titleMatch", titleMatch);
        return o;
    }
}

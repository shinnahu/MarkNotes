package com.marknotes.core.store;

import com.marknotes.core.Json;

import java.util.LinkedHashMap;
import java.util.Map;

/** A folder of a workspace; path is relative to the workspace ("Fanbox/EN"). Same JSON as the PC's FolderDto record. */
public final class FolderDto implements Json.JsonValue {
    public final String path;
    public final String name;
    public final String color;
    public final String icon;
    public final Integer order;
    public final int count;
    public final long ctime;
    public final String description;

    public FolderDto(String path, String name, String color, String icon, Integer order, int count, long ctime, String description) {
        this.path = path;
        this.name = name;
        this.color = color;
        this.icon = icon;
        this.order = order;
        this.count = count;
        this.ctime = ctime;
        this.description = description;
    }

    public FolderDto withCount(int c) {
        return new FolderDto(path, name, color, icon, order, c, ctime, description);
    }

    @Override
    public Object toJson() {
        Map<String, Object> o = new LinkedHashMap<>();
        o.put("path", path);
        o.put("name", name);
        o.put("color", color);
        o.put("icon", icon);
        o.put("order", order);
        o.put("count", count);
        o.put("ctime", ctime);
        o.put("description", description);
        return o;
    }
}

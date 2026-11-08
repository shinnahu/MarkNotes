package com.marknotes.core.store;

import com.marknotes.core.Json;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A workspace as the interface sees it (same JSON as the PC's WorkspaceDto record). dir is the prefix of every note
 * path of the workspace (its folder name); root is the folder's absolute path. Folders opened in place are not
 * supported here, so linked is always false.
 */
public final class WorkspaceDto implements Json.JsonValue {
    public final String id;
    public final String name;
    public final String dir;
    public final String color;
    public final String iconUrl;
    public final String created;
    public final List<FolderDto> folders;
    public final int looseCount;
    public final boolean linked;
    public final String root;
    public final boolean vault;
    public final String bannerUrl;
    public final boolean bannerHover;
    public final boolean guideOn;
    public final boolean browseOn;

    public WorkspaceDto(String id, String name, String dir, String color, String iconUrl, String created, List<FolderDto> folders,
            int looseCount, boolean linked, String root, boolean vault, String bannerUrl, boolean bannerHover, boolean guideOn, boolean browseOn) {
        this.id = id;
        this.name = name;
        this.dir = dir;
        this.color = color;
        this.iconUrl = iconUrl;
        this.created = created;
        this.folders = folders;
        this.looseCount = looseCount;
        this.linked = linked;
        this.root = root;
        this.vault = vault;
        this.bannerUrl = bannerUrl;
        this.bannerHover = bannerHover;
        this.guideOn = guideOn;
        this.browseOn = browseOn;
    }

    @Override
    public Object toJson() {
        Map<String, Object> o = new LinkedHashMap<>();
        o.put("id", id);
        o.put("name", name);
        o.put("dir", dir);
        o.put("color", color);
        o.put("iconUrl", iconUrl);
        o.put("created", created);
        o.put("folders", folders);
        o.put("looseCount", looseCount);
        o.put("linked", linked);
        o.put("root", root);
        o.put("vault", vault);
        o.put("bannerUrl", bannerUrl);
        o.put("bannerHover", bannerHover);
        o.put("guideOn", guideOn);
        o.put("browseOn", browseOn);
        return o;
    }
}

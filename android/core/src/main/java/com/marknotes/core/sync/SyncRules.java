package com.marknotes.core.sync;

import java.util.Locale;

/** Which paths of a workspace are synced. Same rule as the PC (src/host/Sync/SyncFiles.cs IsSynced). */
public final class SyncRules {
    private SyncRules() {}

    private static boolean skipDir(String s) {
        String l = s.toLowerCase(Locale.ROOT);
        return l.equals("node_modules") || l.equals("$recycle.bin") || l.equals("system volume information") || l.equals(".git")
                || l.equals(".trash");
    }

    public static boolean isSynced(String rel, boolean dir) {
        String[] seg = rel.split("/", -1);
        for (String s : seg) if (skipDir(s)) return false;
        String lower = rel.toLowerCase(Locale.ROOT);
        if (seg[0].equalsIgnoreCase(".obsidian")) {
            // Only what MarkNotes reads from a vault's settings.
            if (dir) {
                return lower.equals(".obsidian") || lower.equals(".obsidian/plugins") || lower.equals(".obsidian/plugins/obsidian-kanban")
                        || lower.equals(".obsidian/snippets") || lower.startsWith(".obsidian/snippets/");
            }
            return lower.equals(".obsidian/app.json") || lower.equals(".obsidian/appearance.json")
                    || lower.equals(".obsidian/plugins/obsidian-kanban/data.json") || lower.startsWith(".obsidian/snippets/");
        }
        if (dir) return true;
        String name = seg[seg.length - 1];
        String ln = name.toLowerCase(Locale.ROOT);
        if (ln.equals(".ds_store") || ln.equals("thumbs.db") || ln.equals("desktop.ini") || name.startsWith("~$")) return false;
        return !ln.endsWith(".tmp") && !ln.endsWith(".mnsync-tmp");
    }

    /** A path the PC can store: '/'-separated, no empty, ".", ".." parts, nothing Windows refuses in a name. */
    public static boolean windowsSafe(String rel) {
        if (rel == null || rel.isEmpty() || rel.length() > 1000) return false;
        for (String s : rel.split("/", -1)) {
            if (s.isEmpty() || s.equals(".") || s.equals("..") || s.endsWith(".") || s.endsWith(" ")) return false;
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                if (c < 32 || "<>:\"\\|?*".indexOf(c) >= 0) return false;
            }
            String stem = s.contains(".") ? s.substring(0, s.indexOf('.')) : s;
            String u = stem.toUpperCase(Locale.ROOT);
            if (u.equals("CON") || u.equals("PRN") || u.equals("AUX") || u.equals("NUL") || u.matches("(COM|LPT)[1-9]")) return false;
        }
        return true;
    }
}

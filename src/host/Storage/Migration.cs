using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace MarkNotes.Storage;

/// <summary>
/// Converts the flat MarkNotes 1.x folder (all notes side by side + .marknotes_index.json)
/// into the workspace layout. A full copy of the old folder is made first.
/// </summary>
public static class Migration
{
    public const string V1Index = ".marknotes_index.json";

    public sealed record Result(bool Migrated, int Notes, int Tabs, string? BackupDir, string? WorkspaceId, string? Error);

    /// <summary>First launch after upgrading: reuse the notes folder the old version used.</summary>
    public static void AdoptV1Settings()
    {
        if (AppPaths.IsTestProfile || File.Exists(AppPaths.SettingsFile)) return;
        try
        {
            var old = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".marknotes", "settings.json");
            if (!File.Exists(old)) return;
            var o = JsonNode.Parse(File.ReadAllText(old)) as JsonObject;
            var folder = o?["notes_folder"]?.GetValue<string>();
            var settings = new JsonObject();
            if (!string.IsNullOrWhiteSpace(folder) && Directory.Exists(folder)) settings["notesRoot"] = folder;
            var ext = o?["file_extension"]?.GetValue<string>();
            if (ext == "txt" || ext == "md") settings["defaultExt"] = ext;
            HostSettings.WriteJsonFile(AppPaths.SettingsFile, settings.ToJsonString(JsonOpts.Pretty));
        }
        catch (Exception ex) { Log.Error("AdoptV1Settings", ex); }
    }

    public static bool IsNeeded(string root) => File.Exists(Path.Combine(root, V1Index));

    public static Result Run(string root)
    {
        root = Path.GetFullPath(root).TrimEnd('\\');
        var indexPath = Path.Combine(root, V1Index);

        // 1. Safety copy of everything as it is right now.
        var backup = root + "_v1_backup_" + DateTime.Now.ToString("yyyyMMdd-HHmmss");
        try
        {
            CopyDir(root, backup);
        }
        catch (Exception ex)
        {
            Log.Error("Migration.Backup", ex);
            return new Result(false, 0, 0, null, null, UiLang.T("Could not back up the old notes folder, nothing was changed: ", "No se pudo hacer una copia de seguridad de la carpeta de notas anterior; no se cambió nada: ") + ex.Message);
        }

        try
        {
            JsonElement index = default;
            try { index = JsonDocument.Parse(File.ReadAllText(indexPath)).RootElement; } catch (Exception ex) { Log.Error("Migration.Index", ex); }

            // 2. Workspace "Personal" with an "Inbox" folder.
            var wsDir = Path.Combine(root, "Personal");
            int n = 2;
            while (Directory.Exists(wsDir) && File.Exists(Path.Combine(wsDir, NoteStore.WsMetaFile))) wsDir = Path.Combine(root, $"Personal ({n++})");
            var inbox = Path.Combine(wsDir, "Inbox");
            Directory.CreateDirectory(inbox);
            var meta = new WorkspaceMeta
            {
                Id = NoteStore.NewId("w"),
                Name = Path.GetFileName(wsDir),
                Color = "#5865f2",
                Created = DateTime.UtcNow.ToString("o"),
            };
            meta.Folders["Inbox"] = new FolderMeta { Order = 0, Icon = "📥" };

            // 3. Move the loose notes.
            var moved = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase); // old filename -> new name
            foreach (var f in Directory.EnumerateFiles(root))
            {
                if (!NoteStore.IsNoteFile(f)) continue;
                if (new FileInfo(f).Length == 0)
                {
                    // Empty leftovers of 1.x ("note-1234abcd.md"); the backup keeps them.
                    File.Delete(f);
                    continue;
                }
                var name = Path.GetFileName(f);
                var target = Path.Combine(inbox, name);
                int k = 2;
                while (File.Exists(target))
                    target = Path.Combine(inbox, $"{Path.GetFileNameWithoutExtension(name)} ({k++}){Path.GetExtension(name)}");
                File.Move(f, target);
                moved[name] = Path.GetFileName(target);
            }

            // 4. Pasted images move with them; links ".assets/x.png" become "../.assets/x.png".
            var oldAssets = Path.Combine(root, NoteStore.AssetsDir);
            if (Directory.Exists(oldAssets))
            {
                var newAssets = Path.Combine(wsDir, NoteStore.AssetsDir);
                if (!Directory.Exists(newAssets)) Directory.Move(oldAssets, newAssets);
                else
                {
                    foreach (var f in Directory.EnumerateFiles(oldAssets))
                    {
                        var t = Path.Combine(newAssets, Path.GetFileName(f));
                        if (!File.Exists(t)) File.Move(f, t);
                    }
                }
                foreach (var name in moved.Values)
                {
                    var p = Path.Combine(inbox, name);
                    var t = TextFiles.Read(p);
                    var nt = Regex.Replace(t.Text, @"(!?\[[^\]\n]*\]\(\s*<?)\.assets/", "$1../.assets/");
                    if (nt != t.Text) TextFiles.Write(p, nt, t.Encoding, t.Eol);
                }
            }

            // 5. Per-note colour and creation date from the old index; open tabs.
            var idToPath = new Dictionary<string, string>();
            if (index.ValueKind == JsonValueKind.Object && index.TryGetProperty("notes", out var notes) && notes.ValueKind == JsonValueKind.Array)
            {
                foreach (var nd in notes.EnumerateArray())
                {
                    var id = nd.TryGetProperty("id", out var idEl) ? idEl.GetString() : null;
                    var fn = nd.TryGetProperty("filename", out var fnEl) ? fnEl.GetString() : null;
                    var ext = nd.TryGetProperty("external_path", out var exEl) && exEl.ValueKind == JsonValueKind.String ? exEl.GetString() : null;
                    if (id == null) continue;
                    if (!string.IsNullOrEmpty(ext))
                    {
                        if (File.Exists(ext)) idToPath[id] = Path.GetFullPath(ext);
                        continue;
                    }
                    if (fn == null || !moved.TryGetValue(fn, out var newName)) continue;
                    var rel = "Inbox/" + newName;
                    idToPath[id] = Path.GetFileName(wsDir) + "/" + rel;
                    var nm = new NoteMeta();
                    if (nd.TryGetProperty("color", out var c) && c.ValueKind == JsonValueKind.String && !string.IsNullOrEmpty(c.GetString())) nm.Color = c.GetString();
                    if (nd.TryGetProperty("created_at", out var ca) && ca.ValueKind == JsonValueKind.String &&
                        DateTime.TryParse(ca.GetString(), CultureInfo.InvariantCulture, DateTimeStyles.AssumeLocal, out var created))
                        nm.Created = created.ToUniversalTime().ToString("o");
                    meta.Notes[rel] = nm;
                }
            }

            var tabs = new JsonArray();
            if (index.ValueKind == JsonValueKind.Object && index.TryGetProperty("open_tabs", out var ot) && ot.ValueKind == JsonValueKind.Array)
                foreach (var t in ot.EnumerateArray())
                    if (t.GetString() is string tid && idToPath.TryGetValue(tid, out var p)) tabs.Add(p);
            string? active = null;
            if (index.ValueKind == JsonValueKind.Object && index.TryGetProperty("active_tab", out var at) && at.GetString() is string aid)
                idToPath.TryGetValue(aid, out active);

            var json = JsonSerializer.Serialize(meta, JsonOpts.Pretty);
            File.WriteAllText(Path.Combine(wsDir, NoteStore.WsMetaFile), json);
            try { File.SetAttributes(Path.Combine(wsDir, NoteStore.WsMetaFile), FileAttributes.Hidden); } catch { }

            // 6. Initial UI state: the old open tabs reopen inside the new workspace.
            JsonObject state;
            try { state = File.Exists(AppPaths.StateFile) ? JsonNode.Parse(File.ReadAllText(AppPaths.StateFile)) as JsonObject ?? new() : new(); }
            catch { state = new(); }
            state["version"] = 1;
            state["activeWorkspace"] = meta.Id;
            var wsState = state["ws"] as JsonObject ?? new JsonObject();
            wsState[meta.Id] = new JsonObject { ["tabs"] = tabs, ["active"] = active };
            state["ws"] = wsState;
            HostSettings.WriteJsonFile(AppPaths.StateFile, state.ToJsonString(JsonOpts.Pretty));

            // 7. Retire the old index (kept for reference).
            var retired = Path.Combine(root, ".marknotes_index.v1-migrated.json");
            if (File.Exists(retired)) File.Delete(retired);
            File.Move(indexPath, retired);

            Log.Info($"Migrated {moved.Count} notes, {tabs.Count} tabs. Backup: {backup}");
            return new Result(true, moved.Count, tabs.Count, backup, meta.Id, null);
        }
        catch (Exception ex)
        {
            Log.Error("Migration.Run", ex);
            return new Result(false, 0, 0, backup, null, UiLang.T("Migration stopped part way: ", "La migración se cortó a mitad de camino: ") + ex.Message + UiLang.T(". Your original notes are in ", ". Tus notas originales están en ") + backup);
        }
    }

    private static void CopyDir(string src, string dst)
    {
        Directory.CreateDirectory(dst);
        foreach (var f in Directory.EnumerateFiles(src))
            File.Copy(f, Path.Combine(dst, Path.GetFileName(f)), false);
        foreach (var d in Directory.EnumerateDirectories(src))
            CopyDir(d, Path.Combine(dst, Path.GetFileName(d)));
    }
}

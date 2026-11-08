using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace MarkNotes.Storage;

/// <summary>
/// .mnpack files: a zip with manifest.json, workspaces/&lt;dir&gt;/..., themes/*.mntheme and
/// optionally settings.json. Used to share a workspace (notes, folders, images, icon) or
/// to back up everything.
/// </summary>
public static class Archive
{
    public const string Format = "marknotes-pack";

    public sealed record ThemeFile(string Name, string Json);

    public static void Export(NoteStore store, IReadOnlyList<string> wsIds, string destZip, string kind,
        string? settingsJson, IReadOnlyList<ThemeFile> themes)
    {
        var tmp = destZip + ".part";
        if (File.Exists(tmp)) File.Delete(tmp);
        var wsList = new JsonArray();
        using (var fs = new FileStream(tmp, FileMode.CreateNew))
        using (var zip = new ZipArchive(fs, ZipArchiveMode.Create))
        {
            foreach (var id in wsIds)
            {
                var ws = store.GetWorkspace(id);
                var (dir, metaJson, iconFile, linked, bannerFile) = store.ExportSource(id);
                // Folders opened in place are exported under their display name.
                var zipDir = linked ? NoteStore.SanitizeName(ws.Name, 60) : ws.Dir;
                wsList.Add(new JsonObject { ["id"] = ws.Id, ["name"] = ws.Name, ["dir"] = zipDir });
                static bool Skip(string rel) =>
                    rel.Split('/').Any(seg => seg is ".obsidian" or ".git" or ".trash" or "node_modules");
                // Empty folders are part of the workspace layout too.
                foreach (var d in Directory.EnumerateDirectories(dir, "*", SearchOption.AllDirectories))
                {
                    var relDir = Path.GetRelativePath(dir, d).Replace('\\', '/');
                    if (Skip(relDir) || Directory.EnumerateFileSystemEntries(d).Any()) continue;
                    zip.CreateEntry("workspaces/" + zipDir + "/" + relDir + "/");
                }
                foreach (var f in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories))
                {
                    var name = Path.GetFileName(f);
                    if (name.EndsWith(".tmp", StringComparison.OrdinalIgnoreCase) || name.EndsWith(".part", StringComparison.OrdinalIgnoreCase)) continue;
                    var rel = Path.GetRelativePath(dir, f).Replace('\\', '/');
                    if (Skip(rel) || rel.Equals(NoteStore.WsMetaFile, StringComparison.OrdinalIgnoreCase)) continue;
                    if (!linked && iconFile != null && Path.GetFullPath(f).Equals(Path.GetFullPath(iconFile), StringComparison.OrdinalIgnoreCase)) continue;
                    if (!linked && bannerFile != null && Path.GetFullPath(f).Equals(Path.GetFullPath(bannerFile), StringComparison.OrdinalIgnoreCase)) continue;
                    zip.CreateEntryFromFile(f, "workspaces/" + zipDir + "/" + rel, CompressionLevel.Optimal);
                }
                var metaEntry = zip.CreateEntry("workspaces/" + zipDir + "/" + NoteStore.WsMetaFile, CompressionLevel.Optimal);
                using (var s = new StreamWriter(metaEntry.Open(), new UTF8Encoding(false))) s.Write(metaJson);
                if (iconFile != null)
                    zip.CreateEntryFromFile(iconFile, "workspaces/" + zipDir + "/.workspace-icon" + Path.GetExtension(iconFile), CompressionLevel.Optimal);
                if (bannerFile != null)
                    zip.CreateEntryFromFile(bannerFile, "workspaces/" + zipDir + "/.workspace-banner" + Path.GetExtension(bannerFile), CompressionLevel.Optimal);
            }
            var themeList = new JsonArray();
            int i = 0;
            foreach (var t in themes)
            {
                var entryName = $"themes/{i++:00}-{NoteStore.SanitizeName(t.Name, 40)}.mntheme";
                var e = zip.CreateEntry(entryName, CompressionLevel.Optimal);
                using (var s = new StreamWriter(e.Open(), new UTF8Encoding(false))) s.Write(t.Json);
                themeList.Add(entryName);
            }
            if (settingsJson != null)
            {
                var e = zip.CreateEntry("settings.json", CompressionLevel.Optimal);
                using var s = new StreamWriter(e.Open(), new UTF8Encoding(false));
                s.Write(settingsJson);
            }
            var manifest = new JsonObject
            {
                ["format"] = Format,
                ["version"] = 1,
                ["kind"] = kind,
                ["created"] = DateTime.UtcNow.ToString("o"),
                ["app"] = "MarkNotes 2.0",
                ["workspaces"] = wsList,
                ["themes"] = themeList,
                ["settings"] = settingsJson != null ? "settings.json" : null,
            };
            var me = zip.CreateEntry("manifest.json", CompressionLevel.Optimal);
            using (var s = new StreamWriter(me.Open(), new UTF8Encoding(false))) s.Write(manifest.ToJsonString(JsonOpts.Pretty));
        }
        File.Move(tmp, destZip, true);
    }

    public static object Import(NoteStore store, string zipPath)
    {
        const long MaxTotal = 4L * 1024 * 1024 * 1024;
        using var zip = ZipFile.OpenRead(zipPath);
        var me = zip.GetEntry("manifest.json") ?? throw new InvalidDataException(UiLang.T("This file is not a MarkNotes pack (manifest.json missing).", "Este archivo no es un paquete de MarkNotes (falta manifest.json)."));
        JsonObject manifest;
        using (var r = new StreamReader(me.Open())) manifest = JsonNode.Parse(r.ReadToEnd()) as JsonObject ?? throw new InvalidDataException(UiLang.T("Bad manifest", "manifest.json dañado"));
        if ((string?)manifest["format"] != Format) throw new InvalidDataException(UiLang.T("This file is not a MarkNotes pack.", "Este archivo no es un paquete de MarkNotes."));
        if (zip.Entries.Sum(e => e.Length) > MaxTotal) throw new InvalidDataException(UiLang.T("Pack is too large.", "El paquete es demasiado grande."));

        var existing = store.Scan();
        var ids = existing.Select(w => w.Id).ToHashSet();
        var names = existing.Select(w => w.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var imported = new List<string>();

        if (manifest["workspaces"] is JsonArray wsArr)
        {
            foreach (var wsNode in wsArr.OfType<JsonObject>())
            {
                var dirName = (string?)wsNode["dir"];
                if (string.IsNullOrWhiteSpace(dirName)) continue;
                var display = (string?)wsNode["name"] ?? dirName;
                var prefix = "workspaces/" + dirName + "/";
                var target = Path.Combine(store.Root, NoteStore.SanitizeName(display, 60));
                int n = 2;
                var baseTarget = target;
                while (Directory.Exists(target) || File.Exists(target)) target = $"{baseTarget} ({n++})";
                Directory.CreateDirectory(target);
                foreach (var entry in zip.Entries)
                {
                    if (!entry.FullName.StartsWith(prefix, StringComparison.Ordinal)) continue;
                    var rel = entry.FullName[prefix.Length..];
                    if (rel.Length == 0) continue;
                    var dest = Path.GetFullPath(Path.Combine(target, rel.TrimEnd('/').Replace('/', '\\')));
                    if (!NoteStore.IsInside(dest, target)) continue; // never write outside the new workspace
                    if (entry.FullName.EndsWith('/')) { Directory.CreateDirectory(dest); continue; }
                    Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
                    entry.ExtractToFile(dest, false);
                }
                var metaPath = Path.Combine(target, NoteStore.WsMetaFile);
                WorkspaceMeta meta;
                try { meta = JsonSerializer.Deserialize<WorkspaceMeta>(File.ReadAllText(metaPath), JsonOpts.Pretty) ?? new(); }
                catch { meta = new WorkspaceMeta(); }
                meta.Normalize();
                if (string.IsNullOrWhiteSpace(meta.Id) || ids.Contains(meta.Id)) meta.Id = NoteStore.NewId("w");
                if (string.IsNullOrWhiteSpace(meta.Name)) meta.Name = display;
                if (names.Contains(meta.Name)) meta.Name += " (imported)";
                ids.Add(meta.Id);
                names.Add(meta.Name);
                File.WriteAllText(metaPath, JsonSerializer.Serialize(meta, JsonOpts.Pretty));
                try { File.SetAttributes(metaPath, FileAttributes.Hidden); } catch { }
                imported.Add(meta.Id);
            }
        }

        var themes = new List<string>();
        foreach (var entry in zip.Entries.Where(e => e.FullName.StartsWith("themes/", StringComparison.Ordinal) && e.FullName.EndsWith(".mntheme", StringComparison.OrdinalIgnoreCase)))
        {
            if (entry.Length > 8 * 1024 * 1024) continue;
            using var r = new StreamReader(entry.Open());
            themes.Add(r.ReadToEnd());
        }
        string? settings = null;
        var se = zip.GetEntry("settings.json");
        if (se != null && se.Length < 16 * 1024 * 1024)
        {
            using var r = new StreamReader(se.Open());
            settings = r.ReadToEnd();
        }

        var after = store.Scan();
        return new
        {
            kind = (string?)manifest["kind"] ?? "workspace",
            workspaces = after.Where(w => imported.Contains(w.Id)).ToList(),
            themes,
            settings,
        };
    }
}

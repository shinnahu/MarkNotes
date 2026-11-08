using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace MarkNotes.Storage;

/// <summary>
/// What phone sync (Sync/SyncServer.cs) needs from the store. Writes of workspace metadata go through here, under the
/// store lock, so the metadata kept in memory and the file on disk never disagree.
/// </summary>
public sealed partial class NoteStore
{
    public sealed record SyncWsInfo(string Id, string Name, string Dir, string? Color, bool Linked, int Notes);

    /// <summary>Every workspace with its folder and how many notes it has.</summary>
    public List<SyncWsInfo> SyncWorkspaces()
    {
        List<WsEntry> list;
        lock (_gate)
        {
            // Fresh: folders made in Explorer since the last listing count too.
            Scan();
            list = _byId.Values.ToList();
        }
        return list.Select(e => new SyncWsInfo(e.Meta.Id, e.Meta.Name, e.Dir, e.Meta.Color, e.Linked, NoteFiles(e.Dir).Count)).ToList();
    }

    /// <summary>A workspace's folder and whether it is a folder opened in place (an Obsidian vault).</summary>
    public (string Dir, bool Linked) SyncDir(string wsId)
    {
        lock (_gate)
        {
            var e = Ws(wsId);
            return (e.Dir, e.Linked);
        }
    }

    private static byte[] Utf8(string s) => new UTF8Encoding(false).GetBytes(s);

    private static string Sha256Hex(byte[] b) => Convert.ToHexString(SHA256.HashData(b)).ToLowerInvariant();

    /// <summary>
    /// The workspace's .workspace.json as a phone sees it. A folder opened in place keeps its metadata in the config
    /// folder; it is shown with its picture and banner named like in a workspace folder (.workspace-icon.png), the way
    /// an export does.
    /// </summary>
    public (byte[] Bytes, long Mtime)? SyncMeta(string wsId)
    {
        lock (_gate)
        {
            var e = Ws(wsId);
            var f = MetaPath(e);
            if (!e.Linked)
            {
                if (!File.Exists(f)) SaveMeta(e);
                return (File.ReadAllBytes(f), MtimeMs(f));
            }
            var meta = JsonSerializer.Deserialize<WorkspaceMeta>(JsonSerializer.Serialize(e.Meta, JsonOpts.Pretty), JsonOpts.Pretty)!;
            var icon = IconPath(e);
            var banner = BannerPath(e);
            if (icon != null) meta.Icon = ".workspace-icon" + Path.GetExtension(icon);
            if (banner != null) meta.Banner = ".workspace-banner" + Path.GetExtension(banner);
            return (Utf8(JsonSerializer.Serialize(meta, JsonOpts.Pretty)), File.Exists(f) ? MtimeMs(f) : 0);
        }
    }

    /// <summary>
    /// For a folder opened in place: where its picture or banner, as the phone names them (.workspace-icon.png,
    /// .workspace-banner.gif), lives on this PC (the config folder). Null for any other path.
    /// </summary>
    public string? SyncLinkedExtra(string wsId, string rel)
    {
        if (rel.Contains('/')) return null;
        var m = System.Text.RegularExpressions.Regex.Match(rel, @"^\.workspace-(icon|banner)(\.[A-Za-z0-9]{1,8})$");
        if (!m.Success) return null;
        lock (_gate)
        {
            var e = Ws(wsId);
            if (!e.Linked) return null;
            var ext = m.Groups[2].Value.ToLowerInvariant();
            if (!ImageExts.Contains(ext)) return null;
            return Path.Combine(LinkedDir, e.Meta.Id + "-" + m.Groups[1].Value + ext);
        }
    }

    /// <summary>The picture and banner of a folder opened in place, as (phone name, file on this PC).</summary>
    public List<(string Rel, string Abs)> SyncLinkedExtras(string wsId)
    {
        var list = new List<(string, string)>();
        lock (_gate)
        {
            var e = Ws(wsId);
            if (!e.Linked) return list;
            var icon = IconPath(e);
            if (icon != null && File.Exists(icon)) list.Add((".workspace-icon" + Path.GetExtension(icon), icon));
            var banner = BannerPath(e);
            if (banner != null && File.Exists(banner)) list.Add((".workspace-banner" + Path.GetExtension(banner), banner));
        }
        return list;
    }

    private static void WriteAtomically(string path, byte[] bytes, long mtimeMs, bool hidden)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var tmp = Path.Combine(Path.GetDirectoryName(path)!, "." + Path.GetFileName(path) + ".mnsync-tmp");
        File.WriteAllBytes(tmp, bytes);
        // Writing straight over a hidden file is refused by Windows; a move replaces it.
        File.Move(tmp, path, true);
        if (mtimeMs > 0)
        {
            try { File.SetLastWriteTimeUtc(path, DateTimeOffset.FromUnixTimeMilliseconds(mtimeMs).UtcDateTime); } catch { }
        }
        if (hidden)
        {
            try { File.SetAttributes(path, File.GetAttributes(path) | FileAttributes.Hidden); } catch { }
        }
    }

    /// <summary>
    /// Takes a .workspace.json that came from a phone as this workspace's metadata (the id always stays this
    /// workspace's). Returns the hash the next listing will show for it.
    /// </summary>
    public string SyncWriteMeta(string wsId, byte[] json, long mtimeMs)
    {
        lock (_gate)
        {
            var e = Ws(wsId);
            var meta = JsonSerializer.Deserialize<WorkspaceMeta>(json, JsonOpts.Pretty)
                ?? throw new InvalidDataException("Empty .workspace.json");
            meta.Normalize();
            bool sameId = meta.Id == e.Meta.Id;
            meta.Id = e.Meta.Id;
            if (string.IsNullOrWhiteSpace(meta.Name)) meta.Name = e.Meta.Name;
            byte[] bytes = json;
            if (e.Linked)
            {
                if (meta.Icon is { } ic && ic.StartsWith(".workspace-icon", StringComparison.OrdinalIgnoreCase))
                    meta.Icon = e.Meta.Id + "-icon" + Path.GetExtension(ic).ToLowerInvariant();
                if (meta.Banner is { } bn && bn.StartsWith(".workspace-banner", StringComparison.OrdinalIgnoreCase))
                    meta.Banner = e.Meta.Id + "-banner" + Path.GetExtension(bn).ToLowerInvariant();
                bytes = Utf8(JsonSerializer.Serialize(meta, JsonOpts.Pretty));
            }
            else if (!sameId)
            {
                bytes = Utf8(JsonSerializer.Serialize(meta, JsonOpts.Pretty));
            }
            WriteAtomically(MetaPath(e), bytes, mtimeMs, !e.Linked);
            e.Meta = meta;
        }
        var shown = SyncMeta(wsId);
        return shown == null ? "" : Sha256Hex(shown.Value.Bytes);
    }

    /// <summary>
    /// A workspace that came from a phone: a new folder in the notes folder, created together with its metadata so no
    /// scan ever sees it without its id. Returns its folder (the existing one when this id is already here).
    /// </summary>
    public string SyncAdoptWorkspace(string id, string preferredDir, byte[] json)
    {
        lock (_gate)
        {
            if (_byId.Count == 0) Scan();
            if (_byId.TryGetValue(id, out var have)) return have.Dir;
            var meta = JsonSerializer.Deserialize<WorkspaceMeta>(json, JsonOpts.Pretty) ?? new WorkspaceMeta();
            meta.Normalize();
            bool sameId = meta.Id == id;
            meta.Id = id;
            if (string.IsNullOrWhiteSpace(meta.Name)) meta.Name = string.IsNullOrWhiteSpace(preferredDir) ? "Workspace" : preferredDir;
            var dir = UniqueDir(Root, SanitizeName(string.IsNullOrWhiteSpace(preferredDir) ? meta.Name : preferredDir, 60));
            Directory.CreateDirectory(dir);
            var e = new WsEntry { Dir = dir, DirName = Path.GetFileName(dir), Meta = meta };
            WriteAtomically(Path.Combine(dir, WsMetaFile), sameId ? json : Utf8(JsonSerializer.Serialize(meta, JsonOpts.Pretty)), 0, true);
            _byId[id] = e;
            return dir;
        }
    }

    /// <summary>After a sync wrote into these workspaces: metadata read again from disk, name and text caches dropped.</summary>
    public void SyncReload(IEnumerable<string> wsIds)
    {
        lock (_gate)
        {
            Scan();
            foreach (var id in wsIds)
            {
                if (!_byId.TryGetValue(id, out var e)) continue;
                e.Names = null;
                DropCacheUnder(e.Dir);
            }
        }
    }
}

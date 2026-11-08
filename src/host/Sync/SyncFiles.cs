using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using MarkNotes.Storage;

namespace MarkNotes.Sync;

/// <summary>
/// The files of a workspace as a phone sees them (PROTOCOL.md §5): listing with hashes, reading, and writes that only
/// happen when the PC's copy is still the one the phone last saw. Deletions go to the Recycle Bin.
/// </summary>
internal sealed class SyncFiles
{
    private readonly Func<NoteStore> _store;
    private readonly string _hashDir;
    private readonly string _historyDir;
    private readonly object _gate = new();
    private readonly Dictionary<string, Dictionary<string, (long S, long M, string H)>> _hashes = new();

    public SyncFiles(Func<NoteStore> store, string localDir)
    {
        _store = store;
        _hashDir = Path.Combine(localDir, "sync", "hashes");
        _historyDir = Path.Combine(localDir, "sync", "history");
    }

    private NoteStore Store => _store();

    // ─────────────────────────── what is synced ───────────────────────────

    private static readonly HashSet<string> SkipDirs = new(StringComparer.OrdinalIgnoreCase)
        { "node_modules", "$RECYCLE.BIN", "System Volume Information", ".git", ".trash" };

    private static readonly HashSet<string> SkipFiles = new(StringComparer.OrdinalIgnoreCase)
        { ".DS_Store", "Thumbs.db", "desktop.ini" };

    /// <summary>Same rule as the phone (android core: SyncRules.java).</summary>
    public static bool IsSynced(string rel, bool dir)
    {
        var seg = rel.Split('/');
        foreach (var s in seg) if (SkipDirs.Contains(s)) return false;
        if (seg[0].Equals(".obsidian", StringComparison.OrdinalIgnoreCase))
        {
            // Only what MarkNotes reads from a vault's settings.
            var lower = rel.ToLowerInvariant();
            if (dir) return lower is ".obsidian" or ".obsidian/plugins" or ".obsidian/plugins/obsidian-kanban" || lower == ".obsidian/snippets" || lower.StartsWith(".obsidian/snippets/");
            return lower is ".obsidian/app.json" or ".obsidian/appearance.json" or ".obsidian/plugins/obsidian-kanban/data.json" || lower.StartsWith(".obsidian/snippets/");
        }
        if (dir) return true;
        var name = seg[^1];
        if (SkipFiles.Contains(name) || name.StartsWith("~$")) return false;
        if (name.EndsWith(".tmp", StringComparison.OrdinalIgnoreCase) || name.EndsWith(".mnsync-tmp", StringComparison.OrdinalIgnoreCase)) return false;
        return true;
    }

    private static readonly char[] BadChars = Path.GetInvalidFileNameChars();

    /// <summary>A phone's path, checked: '/'-separated, no empty, '.', '..' or Windows-invalid parts.</summary>
    public static string CheckRel(string? rel)
    {
        if (string.IsNullOrEmpty(rel) || rel.Length > 1000) throw new SyncError("badPath", "Bad path");
        foreach (var s in rel.Split('/'))
        {
            if (s.Length == 0 || s == "." || s == ".." || s.IndexOfAny(BadChars) >= 0 || s.EndsWith('.') || s.EndsWith(' '))
                throw new SyncError("badPath", "Bad path: " + rel);
        }
        return rel;
    }

    private const string MetaRel = NoteStore.WsMetaFile;

    private static bool IsMeta(string rel) => rel.Equals(MetaRel, StringComparison.OrdinalIgnoreCase);

    /// <summary>Where a phone path lives on this PC.</summary>
    private string Resolve(string wsId, string rel, out bool linked)
    {
        CheckRel(rel);
        var (dir, isLinked) = Store.SyncDir(wsId);
        linked = isLinked;
        if (isLinked)
        {
            var extra = Store.SyncLinkedExtra(wsId, rel);
            if (extra != null) return extra;
        }
        var abs = Path.GetFullPath(Path.Combine(dir, rel.Replace('/', '\\')));
        if (!NoteStore.IsInside(abs, dir)) throw new SyncError("badPath", "Path escapes the workspace");
        return abs;
    }

    // ─────────────────────────── hashes ───────────────────────────

    private Dictionary<string, (long S, long M, string H)> Cache(string wsId)
    {
        lock (_gate)
        {
            if (_hashes.TryGetValue(wsId, out var c)) return c;
            c = new Dictionary<string, (long, long, string)>(StringComparer.OrdinalIgnoreCase);
            try
            {
                var f = Path.Combine(_hashDir, wsId + ".json");
                if (File.Exists(f))
                {
                    var raw = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(File.ReadAllText(f));
                    if (raw != null)
                        foreach (var (k, v) in raw)
                            if (v.ValueKind == JsonValueKind.Array && v.GetArrayLength() == 3)
                                c[k] = (v[0].GetInt64(), v[1].GetInt64(), v[2].GetString() ?? "");
                }
            }
            catch (Exception ex) { Log.Error("SyncFiles.Cache", ex); }
            _hashes[wsId] = c;
            return c;
        }
    }

    private void SaveCache(string wsId)
    {
        try
        {
            Dictionary<string, object[]> snapshot;
            lock (_gate)
            {
                if (!_hashes.TryGetValue(wsId, out var c)) return;
                snapshot = c.ToDictionary(kv => kv.Key, kv => new object[] { kv.Value.S, kv.Value.M, kv.Value.H });
            }
            HostSettings.WriteJsonFile(Path.Combine(_hashDir, wsId + ".json"), JsonSerializer.Serialize(snapshot));
        }
        catch (Exception ex) { Log.Error("SyncFiles.SaveCache", ex); }
    }

    public static string HashFile(string path)
    {
        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1 << 16);
        return Proto.Hex(SHA256.HashData(fs));
    }

    private static long Mtime(FileInfo fi) => new DateTimeOffset(fi.LastWriteTimeUtc).ToUnixTimeMilliseconds();

    private string HashOf(string wsId, string rel, FileInfo fi)
    {
        var c = Cache(wsId);
        long m = Mtime(fi);
        lock (_gate)
        {
            if (c.TryGetValue(rel, out var h) && h.S == fi.Length && h.M == m) return h.H;
        }
        var hash = HashFile(fi.FullName);
        lock (_gate) c[rel] = (fi.Length, m, hash);
        return hash;
    }

    /// <summary>The hash of what a phone would get for this path now, or null when there is nothing.</summary>
    private string? CurrentHash(string wsId, string rel, string abs)
    {
        if (IsMeta(rel))
        {
            var meta = Store.SyncMeta(wsId);
            return meta == null ? null : Proto.Hex(SHA256.HashData(meta.Value.Bytes));
        }
        var fi = new FileInfo(abs);
        return fi.Exists ? HashOf(wsId, rel, fi) : null;
    }

    // ─────────────────────────── listing ───────────────────────────

    public List<Dictionary<string, object>> Manifest(string wsId)
    {
        var (dir, linked) = Store.SyncDir(wsId);
        var list = new List<Dictionary<string, object>>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var stack = new Stack<(DirectoryInfo Dir, string Rel, int Depth)>();
        stack.Push((new DirectoryInfo(dir), "", 0));
        while (stack.Count > 0)
        {
            var (d, relDir, depth) = stack.Pop();
            FileSystemInfo[] items;
            try { items = d.GetFileSystemInfos(); }
            catch (Exception ex) { Log.Error("Sync manifest " + d.FullName, ex); continue; }
            foreach (var fsi in items)
            {
                if ((fsi.Attributes & FileAttributes.ReparsePoint) != 0) continue;
                var rel = relDir.Length == 0 ? fsi.Name : relDir + "/" + fsi.Name;
                if (fsi is DirectoryInfo sub)
                {
                    if (depth >= 32 || !IsSynced(rel, true)) continue;
                    list.Add(new Dictionary<string, object> { ["p"] = rel, ["d"] = true });
                    stack.Push((sub, rel, depth + 1));
                }
                else if (fsi is FileInfo fi)
                {
                    if (!IsSynced(rel, false)) continue;
                    if (relDir.Length == 0 && (IsMeta(rel) || (linked && Store.SyncLinkedExtra(wsId, rel) != null))) continue;
                    if (relDir.Length == 0 && IsMeta(rel)) continue;
                    string h;
                    try { h = HashOf(wsId, rel, fi); }
                    catch (Exception ex) { Log.Info($"Sync: skipped {fi.FullName}: {ex.Message}"); continue; }
                    if (!seen.Add(rel)) continue;
                    list.Add(new Dictionary<string, object> { ["p"] = rel, ["s"] = fi.Length, ["m"] = Mtime(fi), ["h"] = h });
                }
            }
        }
        var meta = Store.SyncMeta(wsId);
        if (meta != null)
            list.Add(new Dictionary<string, object> { ["p"] = MetaRel, ["s"] = (long)meta.Value.Bytes.Length, ["m"] = meta.Value.Mtime, ["h"] = Proto.Hex(SHA256.HashData(meta.Value.Bytes)) });
        if (linked)
        {
            foreach (var (rel, abs) in Store.SyncLinkedExtras(wsId))
            {
                var fi = new FileInfo(abs);
                list.Add(new Dictionary<string, object> { ["p"] = rel, ["s"] = fi.Length, ["m"] = Mtime(fi), ["h"] = HashOf(wsId, rel, fi) });
            }
        }
        // Forget hashes of files that are gone.
        var c = Cache(wsId);
        lock (_gate)
        {
            var live = new HashSet<string>(list.Select(e => (string)e["p"]), StringComparer.OrdinalIgnoreCase);
            foreach (var k in c.Keys.Where(k => !live.Contains(k)).ToList()) c.Remove(k);
        }
        SaveCache(wsId);
        return list;
    }

    // ─────────────────────────── reading ───────────────────────────

    /// <summary>What a GET sends: the bytes (a stream) with size, mtime and hash. Null when the file is gone.</summary>
    public (Stream Data, long Size, long Mtime, string Hash)? Open(string wsId, string rel)
    {
        var abs = Resolve(wsId, rel, out _);
        if (IsMeta(rel))
        {
            var meta = Store.SyncMeta(wsId);
            if (meta == null) return null;
            var b = meta.Value.Bytes;
            return (new MemoryStream(b, false), b.Length, meta.Value.Mtime, Proto.Hex(SHA256.HashData(b)));
        }
        var fi = new FileInfo(abs);
        if (!fi.Exists) return null;
        var hash = HashOf(wsId, rel, fi);
        var fs = new FileStream(abs, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1 << 16);
        return (fs, fi.Length, Mtime(fi), hash);
    }

    /// <summary>
    /// Deletions go to the Recycle Bin. Test profiles (--data-dir) use a folder of their own instead, so automated tests
    /// never fill the user's Recycle Bin.
    /// </summary>
    private static void Recycle(string abs)
    {
        if (!AppPaths.IsTestProfile) { NoteStore.Recycle(abs); return; }
        var bin = Path.Combine(AppPaths.LocalDir, "test-recycle", DateTime.Now.ToString("yyyyMMdd-HHmmss-fff"));
        Directory.CreateDirectory(bin);
        var to = Path.Combine(bin, Path.GetFileName(abs));
        if (Directory.Exists(abs)) Directory.Move(abs, to);
        else File.Move(abs, to);
    }

    // ─────────────────────────── writing ───────────────────────────

    /// <summary>A temp file next to where a PUT's bytes will go (same folder: the final move is atomic).</summary>
    public string TempFor(string wsId, string rel)
    {
        var abs = Resolve(wsId, rel, out _);
        if (!IsSynced(rel, false)) throw new SyncError("badPath", "Not a synced path: " + rel);
        var dir = Path.GetDirectoryName(abs)!;
        if (File.Exists(dir)) throw new SyncError("badPath", "A file is in the way: " + rel);
        Directory.CreateDirectory(dir);
        return Path.Combine(dir, "." + Path.GetFileName(abs) + "." + Proto.Hex(RandomNumberGenerator.GetBytes(4)) + ".mnsync-tmp");
    }

    /// <summary>
    /// Puts a received file in place if the PC's copy still has hash <paramref name="baseHash"/> (null = must not
    /// exist) or already has the new content. Returns the hash the next listing will show.
    /// </summary>
    public string Commit(string wsId, string rel, string tmp, long mtime, string hash, string? baseHash, string? device = null, string? run = null)
    {
        try
        {
            var abs = Resolve(wsId, rel, out bool linked);
            var current = CurrentHash(wsId, rel, abs);
            if (current != hash && current != baseHash) throw new SyncError("changed", "Changed on the PC meanwhile");
            if (IsMeta(rel))
            {
                var bytes = File.ReadAllBytes(tmp);
                return Store.SyncWriteMeta(wsId, bytes, mtime);
            }
            if (Directory.Exists(abs)) throw new SyncError("badPath", "A folder is in the way: " + rel);
            if (current != null && current != hash) Keep(device, run, wsId, rel, abs);
            File.Move(tmp, abs, true);
            try { File.SetLastWriteTimeUtc(abs, DateTimeOffset.FromUnixTimeMilliseconds(mtime).UtcDateTime); } catch { }
            if (!linked && !rel.Contains('/') && rel.StartsWith(".workspace", StringComparison.OrdinalIgnoreCase))
            {
                try { File.SetAttributes(abs, File.GetAttributes(abs) | FileAttributes.Hidden); } catch { }
            }
            var fi = new FileInfo(abs);
            var c = Cache(wsId);
            lock (_gate) c[rel] = (fi.Length, Mtime(fi), hash);
            return hash;
        }
        finally
        {
            try { if (File.Exists(tmp)) File.Delete(tmp); } catch { }
        }
    }

    public void Delete(string wsId, string rel, string? baseHash, string? device = null, string? run = null)
    {
        var abs = Resolve(wsId, rel, out _);
        if (IsMeta(rel)) throw new SyncError("protected", "The workspace settings are never deleted by a sync");
        if (Directory.Exists(abs)) throw new SyncError("badPath", "That is a folder: " + rel);
        if (!File.Exists(abs)) return;
        var current = CurrentHash(wsId, rel, abs);
        if (current != baseHash) throw new SyncError("changed", "Changed on the PC meanwhile");
        Keep(device, run, wsId, rel, abs);
        Recycle(abs);
        var c = Cache(wsId);
        lock (_gate) c.Remove(rel);
    }

    public void Mkdir(string wsId, string rel)
    {
        var abs = Resolve(wsId, rel, out _);
        if (!IsSynced(rel, true)) throw new SyncError("badPath", "Not a synced folder: " + rel);
        if (File.Exists(abs)) throw new SyncError("badPath", "A file is in the way: " + rel);
        Directory.CreateDirectory(abs);
    }

    /// <summary>Removes a folder only when nothing that is synced is left in it.</summary>
    public void Rmdir(string wsId, string rel)
    {
        var abs = Resolve(wsId, rel, out _);
        if (!Directory.Exists(abs)) return;
        var (root, _) = Store.SyncDir(wsId);
        foreach (var p in Directory.EnumerateFileSystemEntries(abs, "*", SearchOption.AllDirectories))
        {
            var r = Path.GetRelativePath(root, p).Replace('\\', '/');
            bool isDir = Directory.Exists(p);
            if (isDir || IsSynced(r, false)) throw new SyncError("notEmpty", "The folder is not empty on the PC");
        }
        Recycle(abs);
    }

    // ─────────────────────────── old versions, for undoing a sync ───────────────────────────
    // history/<device>/<run>/<workspace>/<path>: the PC's copy of a file as it was before a phone's sync run replaced
    // or deleted it (PROTOCOL.md §7). Kept until that phone forgets the run or the user deletes it (Settings › Phone).

    private static readonly Regex RunId = new("^r[0-9]{8}-[0-9]{9}-[0-9a-f]{4}$");
    private static readonly Regex DeviceId = new("^[0-9a-f]{32}$");
    private static readonly Regex WsIdRx = new("^[A-Za-z0-9_-]{1,64}$");

    private string HistoryPath(string device, string run, string wsId, string rel)
    {
        if (!DeviceId.IsMatch(device) || !RunId.IsMatch(run) || !WsIdRx.IsMatch(wsId)) throw new SyncError("bad", "Bad history reference");
        CheckRel(rel);
        var root = Path.Combine(_historyDir, device, run, wsId);
        var p = Path.GetFullPath(Path.Combine(root, rel.Replace('/', '\\')));
        if (!NoteStore.IsInside(p, root)) throw new SyncError("badPath", "Bad path");
        return p;
    }

    /// <summary>Keeps the PC's version of a file before a sync run replaces or deletes it (the first one of the run wins).</summary>
    private void Keep(string? device, string? run, string wsId, string rel, string abs)
    {
        if (device == null || string.IsNullOrEmpty(run) || IsMeta(rel) || !File.Exists(abs)) return;
        var dst = HistoryPath(device, run, wsId, rel);
        if (File.Exists(dst)) return;
        Directory.CreateDirectory(Path.GetDirectoryName(dst)!);
        var tmp = dst + ".part";
        File.Copy(abs, tmp, true);
        File.SetAttributes(tmp, FileAttributes.Normal);
        File.SetLastWriteTimeUtc(tmp, File.GetLastWriteTimeUtc(abs));
        File.Move(tmp, dst, true);
    }

    /// <summary>
    /// Puts back the PC's version from before a sync run. <paramref name="expect"/> is the hash the phone thinks the PC
    /// has now (null = nothing): when that is still so, the old version takes the file's place (what is there now is
    /// kept first, under <paramref name="undoRun"/>); when it changed since, the old version is written next to it as
    /// "&lt;name&gt; (before sync).ext". Returns where it went and its hash.
    /// </summary>
    public (string Rel, string Hash) Restore(string device, string run, string wsId, string rel, string? expect, string? undoRun)
    {
        var src = HistoryPath(device, run, wsId, rel);
        if (!File.Exists(src)) throw new SyncError("missing", "That version is no longer kept on the PC");
        if (IsMeta(rel)) throw new SyncError("protected", "Workspace settings are not restored");
        var abs = Resolve(wsId, rel, out bool linked);
        var current = CurrentHash(wsId, rel, abs);
        string targetRel = rel, target = abs;
        if (current != expect)
        {
            if (linked && Store.SyncLinkedExtra(wsId, rel) != null) throw new SyncError("changed", "Changed on the PC meanwhile");
            var dir = Path.GetDirectoryName(abs)!;
            var stem = Path.GetFileNameWithoutExtension(abs);
            var ext = Path.GetExtension(abs);
            var relDir = rel.Contains('/') ? rel[..(rel.LastIndexOf('/') + 1)] : "";
            for (int n = 1; ; n++)
            {
                var name = stem + (n == 1 ? " (before sync)" : $" (before sync {n})") + ext;
                target = Path.Combine(dir, name);
                targetRel = relDir + name;
                if (!File.Exists(target) && !Directory.Exists(target)) break;
            }
        }
        else if (current != null && undoRun != null) Keep(device, undoRun, wsId, rel, abs);
        if (Directory.Exists(target)) throw new SyncError("badPath", "A folder is in the way: " + targetRel);
        var folder = Path.GetDirectoryName(target)!;
        if (File.Exists(folder)) throw new SyncError("badPath", "A file is in the way: " + targetRel);
        Directory.CreateDirectory(folder);
        var tmp = Path.Combine(folder, "." + Path.GetFileName(target) + "." + Proto.Hex(RandomNumberGenerator.GetBytes(4)) + ".mnsync-tmp");
        try
        {
            File.Copy(src, tmp, true);
            File.SetLastWriteTimeUtc(tmp, File.GetLastWriteTimeUtc(src));
            File.Move(tmp, target, true);
        }
        finally
        {
            try { if (File.Exists(tmp)) File.Delete(tmp); } catch { }
        }
        if (!linked && !targetRel.Contains('/') && targetRel.StartsWith(".workspace", StringComparison.OrdinalIgnoreCase))
        {
            try { File.SetAttributes(target, File.GetAttributes(target) | FileAttributes.Hidden); } catch { }
        }
        var fi = new FileInfo(target);
        var hash = HashFile(target);
        var c = Cache(wsId);
        lock (_gate) c[targetRel] = (fi.Length, Mtime(fi), hash);
        return (targetRel, hash);
    }

    /// <summary>The phone no longer offers these runs: their old versions go.</summary>
    public void ForgetRuns(string device, IEnumerable<string> runs)
    {
        if (!DeviceId.IsMatch(device)) return;
        foreach (var run in runs)
        {
            if (!RunId.IsMatch(run)) continue;
            var d = Path.Combine(_historyDir, device, run);
            try { if (Directory.Exists(d)) Directory.Delete(d, true); }
            catch (Exception ex) { Log.Error("Sync history " + d, ex); }
        }
    }

    private static long SizeOf(string dir)
    {
        long n = 0;
        try { foreach (var f in new DirectoryInfo(dir).EnumerateFiles("*", SearchOption.AllDirectories)) n += f.Length; }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        return n;
    }

    /// <summary>Bytes of old versions kept for a phone.</summary>
    public long HistoryBytes(string device)
    {
        var d = DeviceId.IsMatch(device) ? Path.Combine(_historyDir, device) : null;
        return d != null && Directory.Exists(d) ? SizeOf(d) : 0;
    }

    /// <summary>Bytes kept for phones that are no longer linked.</summary>
    public long OrphanBytes(IEnumerable<string> linked)
    {
        if (!Directory.Exists(_historyDir)) return 0;
        var keep = new HashSet<string>(linked, StringComparer.OrdinalIgnoreCase);
        long n = 0;
        foreach (var d in Directory.EnumerateDirectories(_historyDir)) if (!keep.Contains(Path.GetFileName(d))) n += SizeOf(d);
        return n;
    }

    /// <summary>Deletes the old versions kept for a phone, or (device "orphans") for phones no longer linked.</summary>
    public void ClearHistory(string device, IEnumerable<string> linked)
    {
        if (!Directory.Exists(_historyDir)) return;
        var keep = new HashSet<string>(linked, StringComparer.OrdinalIgnoreCase);
        foreach (var d in Directory.EnumerateDirectories(_historyDir))
        {
            var name = Path.GetFileName(d);
            bool hit = device == "orphans" ? !keep.Contains(name) : name.Equals(device, StringComparison.OrdinalIgnoreCase);
            if (!hit) continue;
            try { Directory.Delete(d, true); } catch (Exception ex) { Log.Error("Sync history " + d, ex); }
        }
    }
}

/// <summary>A refused sync request: <see cref="Code"/> goes back to the phone (changed, missing, badPath…).</summary>
internal sealed class SyncError : Exception
{
    public string Code { get; }

    public SyncError(string code, string message) : base(message) { Code = code; }
}

using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace MarkNotes.Storage;

public sealed class FolderMeta
{
    public string? Color { get; set; }
    public string? Icon { get; set; }
    public int? Order { get; set; }
    /// <summary>Shown in Browse Folders.</summary>
    public string? Description { get; set; }
}

public sealed class NoteMeta
{
    public string? Color { get; set; }
    public bool? Pinned { get; set; }
    public bool? AutoTitle { get; set; }
    public string? Created { get; set; }
}

/// <summary>Contents of &lt;workspace&gt;/.workspace.json (or config\linked\&lt;id&gt;.json for opened folders).</summary>
public sealed class WorkspaceMeta
{
    public string Format { get; set; } = "marknotes-workspace";
    public int Version { get; set; } = 1;
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string? Color { get; set; }
    public string? Icon { get; set; }
    /// <summary>Banner image or GIF shown at the top of the sidebar (file next to the icon).</summary>
    public string? Banner { get; set; }
    /// <summary>Animated banners play only while the pointer is over them.</summary>
    public bool? BannerHover { get; set; }
    /// <summary>Workspace Guide: markdown shown on the guide page (optional, see GuideOn).</summary>
    public string? Guide { get; set; }
    public bool? GuideOn { get; set; }
    /// <summary>Browse Folders page shown in the sidebar.</summary>
    public bool? BrowseOn { get; set; }
    public string? Created { get; set; }
    public Dictionary<string, FolderMeta> Folders { get; set; } = new(StringComparer.OrdinalIgnoreCase);
    public Dictionary<string, NoteMeta> Notes { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    public void Normalize()
    {
        Folders = new Dictionary<string, FolderMeta>(Folders ?? new(), StringComparer.OrdinalIgnoreCase);
        Notes = new Dictionary<string, NoteMeta>(Notes ?? new(), StringComparer.OrdinalIgnoreCase);
    }
}

/// <summary>A folder of a workspace; Path is relative to the workspace ("Fanbox/EN").</summary>
public sealed record FolderDto(string Path, string Name, string? Color, string? Icon, int? Order, int Count, long Ctime = 0, string? Description = null);

/// <summary>
/// Dir is the prefix of every note path of the workspace: the folder name for workspaces inside
/// the notes folder, "@&lt;id&gt;" for folders opened in place (e.g. an Obsidian vault).
/// </summary>
public sealed record WorkspaceDto(string Id, string Name, string Dir, string? Color, string? IconUrl, string? Created,
    List<FolderDto> Folders, int LooseCount, bool Linked, string Root, bool Vault, string? BannerUrl, bool BannerHover,
    bool GuideOn = false, bool BrowseOn = false);

public sealed record NoteDto(string Path, string WsId, string Folder, string Title, string Ext, long Size, long Mtime,
    long Ctime, string? Color, bool Pinned, bool AutoTitle, string? Preview, string Kind, string? Cover, string? Date);

public sealed record SearchHit(string Path, string WsId, string Folder, string Title, string Snippet, int Matches,
    long Mtime, bool TitleMatch);

/// <summary>
/// Everything about notes on disk.
/// Layout: &lt;root&gt;/&lt;Workspace&gt;/&lt;folders…&gt;/&lt;Note&gt;.md, workspace metadata in .workspace.json,
/// pasted images in &lt;Workspace&gt;/.assets. Any other folder (an Obsidian vault, a project folder)
/// can be opened as a workspace in place: nothing is added to it, its metadata lives in the
/// config folder and its note paths start with "@&lt;id&gt;/". Files outside any workspace
/// (opened from Explorer) use absolute paths.
/// </summary>
public sealed partial class NoteStore
{
    public const string WsMetaFile = ".workspace.json";
    public const string AssetsDir = ".assets";
    public const string FilesHost = "files.marknotes.example";

    /// <summary>Video and audio files canvases can play (and open with the system player).</summary>
    public static readonly HashSet<string> MediaExts = new(StringComparer.OrdinalIgnoreCase)
        { ".mp4", ".m4v", ".webm", ".mov", ".ogv", ".mp3", ".m4a", ".wav", ".ogg", ".flac" };
    public static readonly HashSet<string> NoteExts = new(StringComparer.OrdinalIgnoreCase) { ".md", ".markdown", ".txt", ".canvas" };
    public static readonly HashSet<string> ImageExts = new(StringComparer.OrdinalIgnoreCase)
        { ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".avif", ".ico" };

    private static readonly HashSet<string> SkipDirs = new(StringComparer.OrdinalIgnoreCase)
        { "node_modules", "$RECYCLE.BIN", "System Volume Information" };

    private static readonly HashSet<string> Reserved = new(StringComparer.OrdinalIgnoreCase)
    {
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"
    };

    private sealed class WsEntry
    {
        public string Dir = "";
        public string DirName = "";
        public bool Linked;
        public WorkspaceMeta Meta = new();
        public string Prefix => Linked ? "@" + Meta.Id : DirName;
        public bool Vault => Directory.Exists(Path.Combine(Dir, ".obsidian"));
        /// <summary>file name (lower case) → paths relative to the workspace, for [[wiki]] style lookups.</summary>
        public Dictionary<string, List<string>>? Names;
        public long NamesAt;
    }

    private sealed class LinkedEntry
    {
        public string Id { get; set; } = "";
        public string Path { get; set; } = "";
    }

    private readonly object _gate = new();
    private readonly Dictionary<string, WsEntry> _byId = new();
    private readonly Dictionary<string, (long Mtime, string Text)> _textCache = new(StringComparer.OrdinalIgnoreCase);
    private readonly NoteIndex _index;

    public string Root { get; }

    public NoteStore(string root)
    {
        Root = Path.GetFullPath(root).TrimEnd('\\', '/');
        Directory.CreateDirectory(Root);
        _index = new NoteIndex(Path.Combine(AppPaths.LocalDir, "index"));
    }

    // ───────────────────────────── helpers ─────────────────────────────

    public static string NewId(string prefix) => prefix + "-" + Convert.ToHexString(RandomNumberGenerator.GetBytes(4)).ToLowerInvariant();

    public static long Ms(DateTime utc) => new DateTimeOffset(DateTime.SpecifyKind(utc, DateTimeKind.Utc)).ToUnixTimeMilliseconds();

    public static long MtimeMs(string path) => Ms(File.GetLastWriteTimeUtc(path));

    private static bool IsHiddenName(string name) => name.StartsWith('.') || name.StartsWith('~') || name.StartsWith('$');

    public static bool IsNoteFile(string path) => NoteExts.Contains(Path.GetExtension(path)) && !IsHiddenName(Path.GetFileName(path));

    public static string SanitizeName(string? name, int max = 80)
    {
        var s = Regex.Replace(name ?? "", @"[<>:""/\\|?*\x00-\x1f]", "-");
        s = Regex.Replace(s, @"\s+", " ").Trim();
        s = s.TrimStart('.', ' ', '~', '$').TrimEnd('.', ' ');
        if (s.Length > max) s = s[..max].TrimEnd('.', ' ');
        if (s.Length == 0) s = UiLang.T("Untitled", "Sin título");
        var stem = s.Split('.')[0];
        if (Reserved.Contains(stem)) s = "_" + s;
        return s;
    }

    private static bool PathEq(string? a, string? b) =>
        a != null && b != null && string.Equals(Path.GetFullPath(a).TrimEnd('\\'), Path.GetFullPath(b).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);

    public static bool IsInside(string path, string dir)
    {
        var p = Path.GetFullPath(path);
        var d = Path.GetFullPath(dir).TrimEnd('\\') + "\\";
        return p.StartsWith(d, StringComparison.OrdinalIgnoreCase);
    }

    private static string Rel(string baseDir, string abs) => Path.GetRelativePath(baseDir, abs).Replace('\\', '/');

    private static string UniqueFile(string dir, string baseName, string ext, string? except = null)
    {
        var candidate = Path.Combine(dir, baseName + ext);
        int n = 2;
        while ((File.Exists(candidate) || Directory.Exists(candidate)) && !PathEq(candidate, except))
            candidate = Path.Combine(dir, $"{baseName} ({n++}){ext}");
        return candidate;
    }

    private static string UniqueDir(string parent, string baseName, string? except = null)
    {
        var candidate = Path.Combine(parent, baseName);
        int n = 2;
        while ((Directory.Exists(candidate) || File.Exists(candidate)) && !PathEq(candidate, except))
            candidate = Path.Combine(parent, $"{baseName} ({n++})");
        return candidate;
    }

    private WsEntry? LinkedById(string id)
    {
        if (_byId.TryGetValue(id, out var e) && e.Linked) return e;
        if (_byId.Count == 0 || !_byId.ContainsKey(id)) Scan();
        return _byId.TryGetValue(id, out e) && e.Linked ? e : null;
    }

    /// <summary>UI path → absolute path. Relative paths must stay inside their workspace.</summary>
    public string Resolve(string apiPath)
    {
        if (string.IsNullOrWhiteSpace(apiPath)) throw new ArgumentException("Empty path");
        if (apiPath.StartsWith('@'))
        {
            // Lock-free first: reading a note must not wait for a big listing in progress.
            var fast = ResolveLinkedFast(apiPath);
            if (fast != null) return fast;
            var slash = apiPath.IndexOf('/');
            var id = slash < 0 ? apiPath[1..] : apiPath[1..slash];
            var rest = slash < 0 ? "" : apiPath[(slash + 1)..];
            WsEntry e;
            lock (_gate) e = LinkedById(id) ?? throw new InvalidOperationException(UiLang.T("Workspace not found", "No se encontró el espacio de trabajo"));
            var p = Path.GetFullPath(Path.Combine(e.Dir, rest.Replace('/', '\\')));
            if (!IsInside(p, e.Dir) && !PathEq(p, e.Dir)) throw new UnauthorizedAccessException("Path escapes the workspace: " + apiPath);
            return p;
        }
        if (Path.IsPathRooted(apiPath)) return Path.GetFullPath(apiPath);
        var abs = Path.GetFullPath(Path.Combine(Root, apiPath.Replace('/', '\\')));
        if (!IsInside(abs, Root)) throw new UnauthorizedAccessException("Path escapes the notes folder: " + apiPath);
        return abs;
    }

    /// <summary>Absolute path → UI path.</summary>
    public string ToApi(string abs)
    {
        abs = Path.GetFullPath(abs);
        if (IsInside(abs, Root)) return Rel(Root, abs);
        lock (_gate)
        {
            // Opened folders may be nested (a vault and a folder inside it): the closest one wins.
            WsEntry? best = null;
            foreach (var e in _byId.Values)
                if (e.Linked && IsInside(abs, e.Dir) && (best == null || e.Dir.Length > best.Dir.Length)) best = e;
            if (best != null) return best.Prefix + "/" + Rel(best.Dir, abs);
        }
        return abs;
    }

    public static string FileUrl(string abs, string root)
    {
        string rel;
        string kind;
        if (IsInside(abs, root)) { kind = "r"; rel = Path.GetRelativePath(root, abs); }
        else { kind = "a"; rel = abs; }
        var parts = rel.Replace('\\', '/').Split('/').Select(Uri.EscapeDataString);
        return $"https://{FilesHost}/{kind}/{string.Join('/', parts)}";
    }

    /// <summary>Walks a workspace: note files, folders and every other file (for name lookups).</summary>
    private static void Walk(string root, Action<string, string> onNote, Action<string>? onFolder, Action<string>? onOther, int maxFiles = 200_000)
    {
        int seen = 0;
        var stack = new Stack<(string Dir, int Depth, bool Assets)>();
        stack.Push((root, 0, false));
        while (stack.Count > 0)
        {
            var (dir, depth, inAssets) = stack.Pop();
            IEnumerable<string> files, dirs;
            try
            {
                files = Directory.EnumerateFiles(dir);
                dirs = Directory.EnumerateDirectories(dir);
            }
            catch { continue; }
            var relDir = PathEq(dir, root) ? "" : Rel(root, dir);
            try
            {
                foreach (var f in files)
                {
                    if (++seen > maxFiles) return;
                    var name = Path.GetFileName(f);
                    if (!inAssets && IsNoteFile(f)) onNote(f, relDir);
                    else if (!name.StartsWith('.')) onOther?.Invoke(f);
                }
                if (depth >= 16) continue;
                foreach (var d in dirs)
                {
                    var name = Path.GetFileName(d);
                    if (SkipDirs.Contains(name)) continue;
                    if (name.Equals(AssetsDir, StringComparison.OrdinalIgnoreCase))
                    {
                        if (onOther != null) stack.Push((d, depth + 1, true));
                        continue;
                    }
                    if (IsHiddenName(name)) continue;
                    if (!inAssets) onFolder?.Invoke(d);
                    stack.Push((d, depth + 1, inAssets));
                }
            }
            catch (Exception ex) { Log.Error("Walk " + dir, ex); }
        }
    }

    /// <summary>
    /// Note files of a workspace as FileInfo objects filled from the directory listing itself,
    /// so size and dates cost no extra disk access (what makes 5,000+ notes list quickly).
    /// </summary>
    private static List<FileInfo> NoteFiles(string root, int maxFiles = 200_000)
    {
        var list = new List<FileInfo>();
        var stack = new Stack<(DirectoryInfo Dir, int Depth)>();
        stack.Push((new DirectoryInfo(root), 0));
        int seen = 0;
        while (stack.Count > 0)
        {
            var (dir, depth) = stack.Pop();
            try
            {
                foreach (var fsi in dir.EnumerateFileSystemInfos())
                {
                    if (fsi is FileInfo fi)
                    {
                        if (++seen > maxFiles) return list;
                        if (IsNoteFile(fi.Name)) list.Add(fi);
                    }
                    else if (fsi is DirectoryInfo d && depth < 16)
                    {
                        var name = d.Name;
                        if (SkipDirs.Contains(name) || IsHiddenName(name) || name.Equals(AssetsDir, StringComparison.OrdinalIgnoreCase)) continue;
                        stack.Push((d, depth + 1));
                    }
                }
            }
            catch (Exception ex) { Log.Error("NoteFiles " + dir.FullName, ex); }
        }
        return list;
    }

    // ─────────────────────────── recycle bin ───────────────────────────

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct SHFILEOPSTRUCT
    {
        public IntPtr hwnd;
        public uint wFunc;
        public string pFrom;
        public string? pTo;
        public ushort fFlags;
        public int fAnyOperationsAborted;
        public IntPtr hNameMappings;
        public string? lpszProgressTitle;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHFileOperation(ref SHFILEOPSTRUCT op);

    /// <summary>Deletes to the Recycle Bin so nothing is ever lost for good by accident.</summary>
    public static void Recycle(string path)
    {
        if (!File.Exists(path) && !Directory.Exists(path)) return;
        var op = new SHFILEOPSTRUCT
        {
            wFunc = 3, // FO_DELETE
            pFrom = Path.GetFullPath(path) + "\0\0",
            fFlags = 0x40 | 0x10 | 0x4 | 0x400, // ALLOWUNDO | NOCONFIRMATION | SILENT | NOERRORUI
        };
        int rc = SHFileOperation(ref op);
        if (rc != 0 && (File.Exists(path) || Directory.Exists(path)))
            throw new IOException(UiLang.T($"Could not move to the Recycle Bin (code {rc}): {path}", $"No se pudo mover a la papelera de reciclaje (código {rc}): {path}"));
    }

    // ───────────────────────────── workspaces ─────────────────────────────

    private static string LinkedRegistry => Path.Combine(AppPaths.ConfigDir, "linked-workspaces.json");
    private static string LinkedDir => Path.Combine(AppPaths.ConfigDir, "linked");

    private static List<LinkedEntry> LoadLinked()
    {
        try
        {
            if (File.Exists(LinkedRegistry))
                return JsonSerializer.Deserialize<List<LinkedEntry>>(File.ReadAllText(LinkedRegistry), JsonOpts.Pretty) ?? new();
        }
        catch (Exception ex) { Log.Error("LoadLinked", ex); }
        return new();
    }

    private static void SaveLinked(List<LinkedEntry> list) =>
        HostSettings.WriteJsonFile(LinkedRegistry, JsonSerializer.Serialize(list, JsonOpts.Pretty));

    private static string MetaPath(WsEntry e) => e.Linked ? Path.Combine(LinkedDir, e.Meta.Id + ".json") : Path.Combine(e.Dir, WsMetaFile);

    private static string? IconPath(WsEntry e) =>
        string.IsNullOrEmpty(e.Meta.Icon) ? null : Path.Combine(e.Linked ? LinkedDir : e.Dir, e.Meta.Icon);

    private static string? BannerPath(WsEntry e) =>
        string.IsNullOrEmpty(e.Meta.Banner) ? null : Path.Combine(e.Linked ? LinkedDir : e.Dir, e.Meta.Banner);

    private static WorkspaceMeta? LoadMetaFile(string f)
    {
        if (!File.Exists(f)) return null;
        try
        {
            var m = JsonSerializer.Deserialize<WorkspaceMeta>(File.ReadAllText(f), JsonOpts.Pretty);
            m?.Normalize();
            return m;
        }
        catch (Exception ex)
        {
            Log.Error("LoadMeta " + f, ex);
            return null;
        }
    }

    private static void SaveMeta(WsEntry e)
    {
        var f = MetaPath(e);
        Directory.CreateDirectory(Path.GetDirectoryName(f)!);
        var json = JsonSerializer.Serialize(e.Meta, JsonOpts.Pretty);
        var tmp = f + ".tmp";
        File.WriteAllText(tmp, json, new UTF8Encoding(false));
        File.Move(tmp, f, true);
        if (!e.Linked)
        {
            try { File.SetAttributes(f, File.GetAttributes(f) | FileAttributes.Hidden); } catch { }
        }
    }

    public List<WorkspaceDto> Scan()
    {
        lock (_gate)
        {
            var old = new Dictionary<string, WsEntry>(_byId);
            _byId.Clear();
            if (!Directory.Exists(Root)) Directory.CreateDirectory(Root);
            foreach (var dir in Directory.EnumerateDirectories(Root))
            {
                var name = Path.GetFileName(dir);
                if (IsHiddenName(name)) continue;
                try
                {
                    if ((File.GetAttributes(dir) & (FileAttributes.Hidden | FileAttributes.System)) != 0) continue;
                }
                catch { continue; }
                var meta = LoadMetaFile(Path.Combine(dir, WsMetaFile));
                bool dirty = false;
                if (meta == null)
                {
                    meta = new WorkspaceMeta { Name = name, Created = DateTime.UtcNow.ToString("o") };
                    dirty = true;
                }
                if (string.IsNullOrWhiteSpace(meta.Id) || _byId.ContainsKey(meta.Id)) { meta.Id = NewId("w"); dirty = true; }
                if (string.IsNullOrWhiteSpace(meta.Name)) meta.Name = name;
                var e = new WsEntry { Dir = dir, DirName = name, Meta = meta };
                if (old.TryGetValue(meta.Id, out var prev) && PathEq(prev.Dir, dir)) { e.Names = prev.Names; e.NamesAt = prev.NamesAt; }
                _byId[meta.Id] = e;
                if (dirty)
                {
                    try { SaveMeta(e); } catch (Exception ex) { Log.Error("Scan.SaveMeta", ex); }
                }
            }
            foreach (var l in LoadLinked())
            {
                if (string.IsNullOrWhiteSpace(l.Id) || _byId.ContainsKey(l.Id)) continue;
                if (!Directory.Exists(l.Path)) { Log.Info("Linked workspace folder missing: " + l.Path); continue; }
                var e = new WsEntry { Dir = Path.GetFullPath(l.Path).TrimEnd('\\'), Linked = true };
                e.DirName = Path.GetFileName(e.Dir);
                e.Meta = LoadMetaFile(Path.Combine(LinkedDir, l.Id + ".json")) ?? new WorkspaceMeta { Name = e.DirName, Created = DateTime.UtcNow.ToString("o") };
                e.Meta.Id = l.Id;
                if (string.IsNullOrWhiteSpace(e.Meta.Name)) e.Meta.Name = e.DirName;
                if (old.TryGetValue(l.Id, out var prev)) { e.Names = prev.Names; e.NamesAt = prev.NamesAt; }
                _byId[l.Id] = e;
            }
            SnapshotLinked();
            return _byId.Values.Select(ToDto).ToList();
        }
    }

    // Opened folders by id, readable without the store lock (images are served from the UI thread).
    private volatile Dictionary<string, string> _linkedDirs = new();

    private void SnapshotLinked() =>
        _linkedDirs = _byId.Values.Where(e => e.Linked).ToDictionary(e => e.Meta.Id, e => e.Dir);

    /// <summary>"@id/rel" → absolute path inside that opened folder, or null. Never waits for other store work.</summary>
    public string? ResolveLinkedFast(string apiPath)
    {
        var slash = apiPath.IndexOf('/');
        if (!apiPath.StartsWith('@') || slash < 2) return null;
        if (!_linkedDirs.TryGetValue(apiPath[1..slash], out var dir)) return null;
        var p = Path.GetFullPath(Path.Combine(dir, apiPath[(slash + 1)..].Replace('/', '\\')));
        return IsInside(p, dir) ? p : null;
    }

    private WsEntry Ws(string id)
    {
        if (_byId.TryGetValue(id, out var e) && Directory.Exists(e.Dir)) return e;
        Scan();
        if (_byId.TryGetValue(id, out e)) return e;
        throw new InvalidOperationException(UiLang.T("Workspace not found", "No se encontró el espacio de trabajo"));
    }

    private WsEntry? WsForAbs(string abs)
    {
        WsEntry? best = null;
        foreach (var e in _byId.Values)
            if (IsInside(abs, e.Dir) && (best == null || e.Dir.Length > best.Dir.Length)) best = e;
        if (best != null) return best;
        if (IsInside(abs, Root))
        {
            Scan();
            foreach (var e in _byId.Values)
                if (IsInside(abs, e.Dir)) return e;
        }
        return null;
    }

    private WorkspaceDto ToDto(WsEntry e)
    {
        var folders = new List<FolderDto>();
        var counts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        int loose = 0;
        try
        {
            Walk(e.Dir,
                (_, relDir) =>
                {
                    if (relDir.Length == 0) loose++;
                    else counts[relDir] = counts.TryGetValue(relDir, out var c) ? c + 1 : 1;
                },
                d =>
                {
                    var rel = Rel(e.Dir, d);
                    e.Meta.Folders.TryGetValue(rel, out var fm);
                    long ctime = 0;
                    try { ctime = Ms(Directory.GetCreationTimeUtc(d)); } catch { }
                    folders.Add(new FolderDto(rel, Path.GetFileName(d), fm?.Color, fm?.Icon, fm?.Order, 0, ctime, fm?.Description));
                },
                null);
        }
        catch (Exception ex) { Log.Error("ToDto " + e.Dir, ex); }

        folders = folders.Select(f => f with { Count = counts.TryGetValue(f.Path, out var c) ? c : 0 }).ToList();
        SortTree(folders);

        string? iconUrl = null;
        var iconPath = IconPath(e);
        if (iconPath != null && File.Exists(iconPath)) iconUrl = FileUrl(iconPath, Root) + "?v=" + MtimeMs(iconPath);
        string? bannerUrl = null;
        var bannerPath = BannerPath(e);
        if (bannerPath != null && File.Exists(bannerPath)) bannerUrl = FileUrl(bannerPath, Root) + "?v=" + MtimeMs(bannerPath);
        return new WorkspaceDto(e.Meta.Id, e.Meta.Name, e.Prefix, e.Meta.Color, iconUrl, e.Meta.Created, folders, loose, e.Linked, e.Dir, e.Vault,
            bannerUrl, e.Meta.BannerHover ?? false, e.Meta.GuideOn ?? false, e.Meta.BrowseOn ?? false);
    }

    [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
    private static extern int StrCmpLogicalW(string a, string b);

    /// <summary>Depth-first tree order: every folder right after its parent, siblings by their order, then by name like Explorer ("2" before "10").</summary>
    private static void SortTree(List<FolderDto> folders)
    {
        var byPath = new Dictionary<string, FolderDto>(StringComparer.OrdinalIgnoreCase);
        foreach (var f in folders) byPath[f.Path] = f;
        int Siblings(string pa, string pb)
        {
            byPath.TryGetValue(pa, out var fa);
            byPath.TryGetValue(pb, out var fb);
            int oa = fa?.Order ?? int.MaxValue, ob = fb?.Order ?? int.MaxValue;
            if (oa != ob) return oa.CompareTo(ob);
            int c = StrCmpLogicalW(pa[(pa.LastIndexOf('/') + 1)..], pb[(pb.LastIndexOf('/') + 1)..]);
            return c != 0 ? c : string.CompareOrdinal(pa, pb);
        }
        folders.Sort((a, b) =>
        {
            var sa = a.Path.Split('/');
            var sb = b.Path.Split('/');
            int n = Math.Min(sa.Length, sb.Length);
            for (int i = 0; i < n; i++)
            {
                if (string.Equals(sa[i], sb[i], StringComparison.OrdinalIgnoreCase)) continue;
                return Siblings(string.Join('/', sa, 0, i + 1), string.Join('/', sb, 0, i + 1));
            }
            return sa.Length.CompareTo(sb.Length);
        });
    }

    public WorkspaceDto GetWorkspace(string id)
    {
        lock (_gate) return ToDto(Ws(id));
    }

    public WorkspaceDto CreateWorkspace(string name, string? color, byte[]? icon, string? iconExt, string? firstFolder = "General")
    {
        lock (_gate)
        {
            var display = string.IsNullOrWhiteSpace(name) ? "Workspace" : name.Trim();
            var dir = UniqueDir(Root, SanitizeName(display, 60));
            Directory.CreateDirectory(dir);
            var e = new WsEntry
            {
                Dir = dir,
                DirName = Path.GetFileName(dir),
                Meta = new WorkspaceMeta { Id = NewId("w"), Name = display, Color = color, Created = DateTime.UtcNow.ToString("o") },
            };
            if (!string.IsNullOrWhiteSpace(firstFolder))
            {
                Directory.CreateDirectory(Path.Combine(dir, SanitizeName(firstFolder)));
                e.Meta.Folders[SanitizeName(firstFolder)] = new FolderMeta { Order = 0 };
            }
            if (icon != null) WriteIcon(e, icon, iconExt);
            SaveMeta(e);
            _byId[e.Meta.Id] = e;
            return ToDto(e);
        }
    }

    /// <summary>Opens an existing folder (e.g. an Obsidian vault) as a workspace, without copying or adding files.</summary>
    public WorkspaceDto LinkFolder(string path, string? color)
    {
        lock (_gate)
        {
            var dir = Path.GetFullPath(path).TrimEnd('\\');
            if (!Directory.Exists(dir)) throw new DirectoryNotFoundException(dir);
            if (PathEq(dir, Root) || IsInside(dir, Root) || IsInside(Root, dir))
                throw new InvalidOperationException(UiLang.T(
                    "That folder is (or contains) the MarkNotes notes folder. Pick another folder.",
                    "Esa carpeta es (o contiene) la carpeta de notas de MarkNotes. Elegí otra carpeta."));
            if (Path.GetPathRoot(dir) == dir + "\\" || Path.GetPathRoot(dir) == dir)
                throw new InvalidOperationException(UiLang.T("Pick a folder, not a whole drive.", "Elegí una carpeta, no un disco entero."));
            var list = LoadLinked();
            var existing = list.FirstOrDefault(l => PathEq(l.Path, dir));
            if (existing != null)
            {
                Scan();
                if (_byId.TryGetValue(existing.Id, out var already)) return ToDto(already);
            }
            var id = NewId("w");
            list.Add(new LinkedEntry { Id = id, Path = dir });
            SaveLinked(list);
            var e = new WsEntry
            {
                Dir = dir,
                DirName = Path.GetFileName(dir),
                Linked = true,
                Meta = new WorkspaceMeta { Id = id, Name = Path.GetFileName(dir), Color = color, Created = DateTime.UtcNow.ToString("o") },
            };
            SaveMeta(e);
            _byId[id] = e;
            SnapshotLinked();
            return ToDto(e);
        }
    }

    /// <summary>Removes an opened folder from MarkNotes. The folder and its files are left untouched.</summary>
    public void UnlinkFolder(string id)
    {
        lock (_gate)
        {
            var list = LoadLinked();
            list.RemoveAll(l => l.Id == id);
            SaveLinked(list);
            if (_byId.TryGetValue(id, out var e) && e.Linked)
            {
                try { File.Delete(MetaPath(e)); } catch { }
                var icon = IconPath(e);
                if (icon != null) { try { File.Delete(icon); } catch { } }
                var banner = BannerPath(e);
                if (banner != null) { try { File.Delete(banner); } catch { } }
                DropCacheUnder(e.Dir);
                _byId.Remove(id);
                SnapshotLinked();
            }
            _index.Forget(id);
        }
    }

    private static void WriteIcon(WsEntry e, byte[] icon, string? ext)
    {
        ext = string.IsNullOrWhiteSpace(ext) ? ".png" : (ext.StartsWith('.') ? ext : "." + ext);
        if (!ImageExts.Contains(ext)) ext = ".png";
        var oldIcon = IconPath(e);
        if (oldIcon != null) { try { File.Delete(oldIcon); } catch { } }
        string fileName;
        string p;
        if (e.Linked)
        {
            Directory.CreateDirectory(LinkedDir);
            fileName = e.Meta.Id + "-icon" + ext;
            p = Path.Combine(LinkedDir, fileName);
        }
        else
        {
            fileName = ".workspace-icon" + ext;
            p = Path.Combine(e.Dir, fileName);
        }
        File.WriteAllBytes(p, icon);
        if (!e.Linked)
        {
            try { File.SetAttributes(p, File.GetAttributes(p) | FileAttributes.Hidden); } catch { }
        }
        e.Meta.Icon = fileName;
    }

    private static void WriteBanner(WsEntry e, byte[] data, string? ext)
    {
        ext = string.IsNullOrWhiteSpace(ext) ? ".png" : (ext.StartsWith('.') ? ext : "." + ext);
        if (!ImageExts.Contains(ext)) ext = ".png";
        var old = BannerPath(e);
        if (old != null) { try { File.Delete(old); } catch { } }
        string fileName, p;
        if (e.Linked)
        {
            Directory.CreateDirectory(LinkedDir);
            fileName = e.Meta.Id + "-banner" + ext;
            p = Path.Combine(LinkedDir, fileName);
        }
        else
        {
            fileName = ".workspace-banner" + ext;
            p = Path.Combine(e.Dir, fileName);
        }
        File.WriteAllBytes(p, data);
        if (!e.Linked)
        {
            try { File.SetAttributes(p, File.GetAttributes(p) | FileAttributes.Hidden); } catch { }
        }
        e.Meta.Banner = fileName;
    }

    /// <summary>Banner of a workspace: new image (null = keep), remove it, and whether a GIF plays only on hover.</summary>
    public WorkspaceDto UpdateBanner(string id, byte[]? data, string? ext, bool remove, bool? hover)
    {
        lock (_gate)
        {
            var e = Ws(id);
            if (remove)
            {
                var bp = BannerPath(e);
                if (bp != null) { try { File.Delete(bp); } catch { } }
                e.Meta.Banner = null;
            }
            if (data != null) WriteBanner(e, data, ext);
            if (hover.HasValue) e.Meta.BannerHover = hover.Value ? true : null;
            SaveMeta(e);
            return ToDto(e);
        }
    }

    public string GetGuide(string id)
    {
        lock (_gate) return Ws(id).Meta.Guide ?? "";
    }

    public void SetGuide(string id, string text)
    {
        lock (_gate)
        {
            var e = Ws(id);
            e.Meta.Guide = string.IsNullOrWhiteSpace(text) ? null : text;
            SaveMeta(e);
        }
    }

    /// <summary>Turns the Workspace Guide / Browse Folders pages on or off (null = leave as is). The guide text is kept.</summary>
    public WorkspaceDto SetFeatures(string id, bool? guide, bool? browse)
    {
        lock (_gate)
        {
            var e = Ws(id);
            if (guide.HasValue) e.Meta.GuideOn = guide.Value ? true : null;
            if (browse.HasValue) e.Meta.BrowseOn = browse.Value ? true : null;
            SaveMeta(e);
            return ToDto(e);
        }
    }

    /// <summary>Returns the new DTO and the old path prefix when the folder on disk was renamed.</summary>
    public (WorkspaceDto Ws, string? OldDir) UpdateWorkspace(string id, string? name, string? color, bool setColor,
        byte[]? icon, string? iconExt, bool removeIcon)
    {
        lock (_gate)
        {
            var e = Ws(id);
            string? oldDir = null;
            if (name != null && !string.IsNullOrWhiteSpace(name) && name.Trim() != e.Meta.Name)
            {
                e.Meta.Name = name.Trim();
                var wanted = SanitizeName(e.Meta.Name, 60);
                // Opened folders keep their real folder name; only the display name changes.
                if (!e.Linked && !string.Equals(wanted, e.DirName, StringComparison.Ordinal))
                {
                    var target = UniqueDir(Root, wanted, e.Dir);
                    try
                    {
                        if (!PathEq(target, e.Dir) || !string.Equals(Path.GetFileName(target), e.DirName, StringComparison.Ordinal))
                        {
                            Directory.Move(e.Dir, target);
                            oldDir = e.DirName;
                            e.Dir = target;
                            e.DirName = Path.GetFileName(target);
                            e.Names = null;
                            DropCacheUnder(Root);
                        }
                    }
                    catch (Exception ex)
                    {
                        // A file inside may be open elsewhere; keep the old folder name, the display name still changes.
                        Log.Error("UpdateWorkspace.Move", ex);
                    }
                }
            }
            if (setColor) e.Meta.Color = string.IsNullOrWhiteSpace(color) ? null : color;
            if (removeIcon)
            {
                var ip = IconPath(e);
                if (ip != null) { try { File.Delete(ip); } catch { } }
                e.Meta.Icon = null;
            }
            if (icon != null) WriteIcon(e, icon, iconExt);
            SaveMeta(e);
            return (ToDto(e), oldDir);
        }
    }

    public void DeleteWorkspace(string id)
    {
        lock (_gate)
        {
            var e = Ws(id);
            if (e.Linked)
            {
                // Never delete a folder that MarkNotes did not create; just forget it.
                UnlinkFolder(id);
                return;
            }
            Recycle(e.Dir);
            _byId.Remove(id);
            DropCacheUnder(e.Dir);
            _index.Forget(id);
        }
    }

    public string WorkspaceDir(string id)
    {
        lock (_gate) return Ws(id).Dir;
    }

    public void FlushIndex() => _index.Flush();

    /// <summary>What an export needs: the folder, the metadata JSON and the picture (opened folders keep both outside).</summary>
    public (string Dir, string MetaJson, string? IconFile, bool Linked, string? BannerFile) ExportSource(string id)
    {
        lock (_gate)
        {
            var e = Ws(id);
            var icon = IconPath(e);
            var banner = BannerPath(e);
            var meta = JsonSerializer.Deserialize<WorkspaceMeta>(JsonSerializer.Serialize(e.Meta, JsonOpts.Pretty), JsonOpts.Pretty)!;
            if (e.Linked && icon != null) meta.Icon = ".workspace-icon" + Path.GetExtension(icon);
            if (e.Linked && banner != null) meta.Banner = ".workspace-banner" + Path.GetExtension(banner);
            return (e.Dir, JsonSerializer.Serialize(meta, JsonOpts.Pretty), icon != null && File.Exists(icon) ? icon : null, e.Linked,
                banner != null && File.Exists(banner) ? banner : null);
        }
    }

    // ───────────────────────────── folders ─────────────────────────────

    private static string ParentOf(string rel) => rel.Contains('/') ? rel[..rel.LastIndexOf('/')] : "";

    public FolderDto CreateFolder(string wsId, string name, string? parent = null)
    {
        lock (_gate)
        {
            var e = Ws(wsId);
            var parentDir = string.IsNullOrEmpty(parent) ? e.Dir : Path.Combine(e.Dir, parent.Replace('/', '\\'));
            if (!PathEq(parentDir, e.Dir) && !IsInside(parentDir, e.Dir)) throw new UnauthorizedAccessException();
            var dir = UniqueDir(parentDir, SanitizeName(name, 60));
            Directory.CreateDirectory(dir);
            var rel = Rel(e.Dir, dir);
            var siblingOrders = e.Meta.Folders.Where(kv => string.Equals(ParentOf(kv.Key), parent ?? "", StringComparison.OrdinalIgnoreCase))
                .Select(kv => kv.Value.Order ?? 0);
            var maxOrder = siblingOrders.DefaultIfEmpty(-1).Max();
            e.Meta.Folders[rel] = new FolderMeta { Order = maxOrder + 1 };
            SaveMeta(e);
            return new FolderDto(rel, Path.GetFileName(dir), null, null, maxOrder + 1, 0, Ms(DateTime.UtcNow));
        }
    }

    private static void RekeyMeta(WorkspaceMeta meta, string oldRel, string newRel)
    {
        var oldPrefix = oldRel + "/";
        foreach (var key in meta.Folders.Keys.ToList())
        {
            if (string.Equals(key, oldRel, StringComparison.OrdinalIgnoreCase) || key.StartsWith(oldPrefix, StringComparison.OrdinalIgnoreCase))
            {
                var v = meta.Folders[key];
                meta.Folders.Remove(key);
                meta.Folders[newRel + key[oldRel.Length..]] = v;
            }
        }
        foreach (var key in meta.Notes.Keys.Where(k => k.StartsWith(oldPrefix, StringComparison.OrdinalIgnoreCase)).ToList())
        {
            var v = meta.Notes[key];
            meta.Notes.Remove(key);
            meta.Notes[newRel + "/" + key[oldPrefix.Length..]] = v;
        }
    }

    public (string NewName, string NewPath, string OldPrefix, string NewPrefix) RenameFolder(string wsId, string path, string newName)
    {
        lock (_gate)
        {
            var e = Ws(wsId);
            var src = Path.Combine(e.Dir, path.Replace('/', '\\'));
            if (!Directory.Exists(src) || !IsInside(src, e.Dir)) throw new DirectoryNotFoundException(path);
            var parentDir = Path.GetDirectoryName(src)!;
            var target = UniqueDir(parentDir, SanitizeName(newName, 60), src);
            var finalName = Path.GetFileName(target);
            if (!string.Equals(finalName, Path.GetFileName(src), StringComparison.Ordinal))
            {
                if (string.Equals(finalName, Path.GetFileName(src), StringComparison.OrdinalIgnoreCase))
                {
                    // Case-only rename needs a hop through a temp name on Windows.
                    var tmp = src + ".rename-" + Guid.NewGuid().ToString("N")[..6];
                    Directory.Move(src, tmp);
                    Directory.Move(tmp, target);
                }
                else Directory.Move(src, target);
            }
            var newRel = Rel(e.Dir, target);
            RekeyMeta(e.Meta, path, newRel);
            SaveMeta(e);
            DropCacheUnder(e.Dir);
            e.Names = null;
            return (finalName, newRel, e.Prefix + "/" + path + "/", e.Prefix + "/" + newRel + "/");
        }
    }

    /// <summary>
    /// Moves a folder with everything in it inside another folder of the same workspace ("" = top level).
    /// Its icon, colour and description follow it; it goes last among its new siblings.
    /// </summary>
    public (string NewPath, string OldPrefix, string NewPrefix) MoveFolder(string wsId, string path, string newParent)
    {
        lock (_gate)
        {
            var e = Ws(wsId);
            path = path.Trim('/');
            newParent = (newParent ?? "").Trim('/');
            if (string.Equals(ParentOf(path), newParent, StringComparison.OrdinalIgnoreCase))
                return (path, e.Prefix + "/" + path + "/", e.Prefix + "/" + path + "/");
            if (string.Equals(newParent, path, StringComparison.OrdinalIgnoreCase) || newParent.StartsWith(path + "/", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException(UiLang.T("A folder can't go inside itself.", "Una carpeta no puede ir dentro de sí misma."));
            var src = Path.Combine(e.Dir, path.Replace('/', '\\'));
            if (!Directory.Exists(src) || !IsInside(src, e.Dir)) throw new DirectoryNotFoundException(path);
            var parentDir = newParent.Length == 0 ? e.Dir : Path.Combine(e.Dir, newParent.Replace('/', '\\'));
            if (!Directory.Exists(parentDir) || (!PathEq(parentDir, e.Dir) && !IsInside(parentDir, e.Dir))) throw new DirectoryNotFoundException(newParent);
            var target = UniqueDir(parentDir, Path.GetFileName(src));
            Directory.Move(src, target);
            var newRel = Rel(e.Dir, target);
            RekeyMeta(e.Meta, path, newRel);
            var maxOrder = e.Meta.Folders
                .Where(kv => string.Equals(ParentOf(kv.Key), newParent, StringComparison.OrdinalIgnoreCase) && !string.Equals(kv.Key, newRel, StringComparison.OrdinalIgnoreCase))
                .Select(kv => kv.Value.Order ?? 0).DefaultIfEmpty(-1).Max();
            if (!e.Meta.Folders.TryGetValue(newRel, out var fm)) e.Meta.Folders[newRel] = fm = new FolderMeta();
            fm.Order = maxOrder + 1;
            SaveMeta(e);
            DropCacheUnder(e.Dir);
            e.Names = null;
            return (newRel, e.Prefix + "/" + path + "/", e.Prefix + "/" + newRel + "/");
        }
    }

    public void DeleteFolder(string wsId, string path)
    {
        lock (_gate)
        {
            var e = Ws(wsId);
            var dir = Path.Combine(e.Dir, path.Replace('/', '\\'));
            if (!IsInside(dir, e.Dir)) throw new UnauthorizedAccessException();
            Recycle(dir);
            var prefix = path + "/";
            foreach (var key in e.Meta.Folders.Keys.Where(k => string.Equals(k, path, StringComparison.OrdinalIgnoreCase) || k.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)).ToList())
                e.Meta.Folders.Remove(key);
            foreach (var key in e.Meta.Notes.Keys.Where(k => k.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)).ToList())
                e.Meta.Notes.Remove(key);
            SaveMeta(e);
            DropCacheUnder(dir);
            e.Names = null;
        }
    }

    public void SetFolderMeta(string wsId, string path, string? color, string? icon, int? order, bool setColor, bool setIcon,
        string? description = null, bool setDescription = false)
    {
        lock (_gate)
        {
            var e = Ws(wsId);
            if (!e.Meta.Folders.TryGetValue(path, out var fm)) e.Meta.Folders[path] = fm = new FolderMeta();
            if (setColor) fm.Color = string.IsNullOrWhiteSpace(color) ? null : color;
            if (setIcon) fm.Icon = string.IsNullOrWhiteSpace(icon) ? null : icon;
            if (order.HasValue) fm.Order = order;
            if (setDescription) fm.Description = string.IsNullOrWhiteSpace(description) ? null : description.Trim();
            SaveMeta(e);
        }
    }

    /// <summary>Stores the order of sibling folders (full paths, same parent).</summary>
    public void ReorderFolders(string wsId, List<string> paths)
    {
        lock (_gate)
        {
            var e = Ws(wsId);
            for (int i = 0; i < paths.Count; i++)
            {
                if (!e.Meta.Folders.TryGetValue(paths[i], out var fm)) e.Meta.Folders[paths[i]] = fm = new FolderMeta();
                fm.Order = i;
            }
            SaveMeta(e);
        }
    }

    // ───────────────────────────── name lookups ─────────────────────────────

    private Dictionary<string, List<string>> Names(WsEntry e, bool fresh = false)
    {
        if (!fresh && e.Names != null && Environment.TickCount64 - e.NamesAt < 15_000) return e.Names;
        var names = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
        void Add(string f)
        {
            var key = Path.GetFileName(f);
            if (!names.TryGetValue(key, out var l)) names[key] = l = new List<string>(1);
            l.Add(Rel(e.Dir, f));
        }
        Walk(e.Dir, (f, _) => Add(f), null, Add);
        e.Names = names;
        e.NamesAt = Environment.TickCount64;
        return names;
    }

    /// <summary>
    /// Finds a file the way Obsidian does for [[name]] / ![[name.png]]: an exact path first,
    /// then by file name anywhere in the workspace, preferring the closest one.
    /// </summary>
    private string? FindByName(WsEntry e, string target, string fromDir)
    {
        target = target.Trim().Replace('\\', '/');
        if (target.Length == 0) return null;
        foreach (var candidate in new[] { Path.Combine(fromDir, target.Replace('/', '\\')), Path.Combine(e.Dir, target.Replace('/', '\\')) })
        {
            try
            {
                var full = Path.GetFullPath(candidate);
                if (File.Exists(full) && (IsInside(full, e.Dir))) return full;
            }
            catch { }
        }
        var file = target.Contains('/') ? target[(target.LastIndexOf('/') + 1)..] : target;
        var names = Names(e);
        if (!names.TryGetValue(file, out var paths) && !names.TryGetValue(file + ".md", out paths)) return null;
        var withPath = target.Contains('/') ? paths.Where(p => p.EndsWith(target, StringComparison.OrdinalIgnoreCase)).ToList() : paths;
        if (withPath.Count == 0) withPath = paths;
        var fromRel = PathEq(fromDir, e.Dir) ? "" : Rel(e.Dir, fromDir) + "/";
        var best = withPath
            .OrderByDescending(p => CommonPrefix(p, fromRel))
            .ThenBy(p => p.Count(ch => ch == '/'))
            .ThenBy(p => p.Length)
            .First();
        return Path.Combine(e.Dir, best.Replace('/', '\\'));
    }

    private static int CommonPrefix(string a, string b)
    {
        int n = Math.Min(a.Length, b.Length), i = 0;
        while (i < n && char.ToLowerInvariant(a[i]) == char.ToLowerInvariant(b[i])) i++;
        return i;
    }

    /// <summary>Every non-note file of a workspace (images…), relative paths, for wiki-style links in the editor.</summary>
    public List<string> ListFiles(string wsId)
    {
        lock (_gate)
        {
            var e = Ws(wsId);
            var names = Names(e, true);
            return names.Values.SelectMany(v => v).Where(p => !NoteExts.Contains(Path.GetExtension(p))).ToList();
        }
    }

    // ───────────────────────────── notes ─────────────────────────────

    private string? CoverUrl(WsEntry e, string noteAbs, string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var target = NoteIndex.CleanTarget(raw);
        if (target == null) return null;
        string? abs;
        if (Regex.IsMatch(target, @"^[a-zA-Z]:[\\/]")) abs = File.Exists(target) ? Path.GetFullPath(target) : null;
        else abs = FindByName(e, DecodeLink(target), Path.GetDirectoryName(noteAbs)!);
        if (abs == null || !ImageExts.Contains(Path.GetExtension(abs))) return null;
        return FileUrl(abs, Root) + "?w=480&v=" + MtimeMs(abs);
    }

    private NoteDto NoteToDto(WsEntry e, string abs, NoteIndex.Entry? info) => NoteToDto(e, new FileInfo(abs), info);

    private NoteDto NoteToDto(WsEntry e, FileInfo fi, NoteIndex.Entry? info)
    {
        var abs = fi.FullName;
        var relInWs = Rel(e.Dir, abs);
        var folder = ParentOf(relInWs);
        e.Meta.Notes.TryGetValue(relInWs, out var m);
        long ctime = Ms(fi.CreationTimeUtc);
        if (m?.Created != null && DateTime.TryParse(m.Created, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var c))
            ctime = Ms(c.ToUniversalTime());
        var ext = fi.Extension.TrimStart('.').ToLowerInvariant();
        var kind = info?.Kind ?? (ext == "canvas" ? "canvas" : "note");
        string? cover = null;
        if (info != null)
        {
            try { cover = CoverUrl(e, abs, info.Banner) ?? CoverUrl(e, abs, info.FirstImage); }
            catch (Exception ex) { Log.Error("CoverUrl", ex); }
        }
        return new NoteDto(
            e.Prefix + "/" + relInWs, e.Meta.Id, folder, Path.GetFileNameWithoutExtension(abs), ext,
            fi.Length, Ms(fi.LastWriteTimeUtc), ctime, m?.Color, m?.Pinned ?? false, m?.AutoTitle ?? false,
            info?.Preview, kind, cover, info?.Date);
    }

    /// <summary>
    /// Lists every note of a workspace. Previews, covers and kinds come from a cached index, so
    /// only new or changed files are read: thousands of notes list in milliseconds.
    /// </summary>
    public List<NoteDto> ListNotes(string wsId, bool preview)
    {
        WsEntry e;
        lock (_gate) e = Ws(wsId);
        var files = NoteFiles(e.Dir);
        var list = new List<NoteDto>(files.Count);
        if (!preview)
        {
            lock (_gate)
                foreach (var f in files) list.Add(NoteToDto(e, f, _index.Peek(wsId, Rel(e.Dir, f.FullName), f)));
            return list;
        }
        var infos = new NoteIndex.Entry?[files.Count];
        Parallel.For(0, files.Count, new ParallelOptions { MaxDegreeOfParallelism = 4 }, i =>
        {
            try { infos[i] = _index.Get(wsId, Rel(e.Dir, files[i].FullName), files[i]); }
            catch (Exception ex) { Log.Error("Index " + files[i].FullName, ex); }
        });
        lock (_gate)
            for (int i = 0; i < files.Count; i++) list.Add(NoteToDto(e, files[i], infos[i]));
        _index.SaveSoon(wsId);
        return list;
    }

    public NoteDto? NoteInfo(string path)
    {
        lock (_gate)
        {
            var abs = Resolve(path);
            if (!File.Exists(abs)) return null;
            var e = WsForAbs(abs);
            if (e == null)
            {
                var fi = new FileInfo(abs);
                var ext = fi.Extension.TrimStart('.').ToLowerInvariant();
                return new NoteDto(ToApi(abs), "", "", Path.GetFileNameWithoutExtension(abs), ext,
                    fi.Length, Ms(fi.LastWriteTimeUtc), Ms(fi.CreationTimeUtc), null, false, false, null, ext == "canvas" ? "canvas" : "note", null, null);
            }
            return NoteToDto(e, abs, _index.Get(e.Meta.Id, Rel(e.Dir, abs), abs));
        }
    }

    public object ReadNote(string path)
    {
        var abs = Resolve(path);
        var fi = new FileInfo(abs);
        if (!fi.Exists) throw new FileNotFoundException(UiLang.T("The file no longer exists", "El archivo ya no existe"), path);
        if (fi.Length > 64L * 1024 * 1024) throw new IOException(UiLang.T("File is too large to open (over 64 MB)", "El archivo es demasiado grande para abrirlo (más de 64 MB)"));
        var t = TextFiles.Read(abs);
        bool readOnly = fi.IsReadOnly;
        return new { text = t.Text, encoding = t.Encoding, eol = t.Eol, mtime = Ms(fi.LastWriteTimeUtc), size = fi.Length, readOnly };
    }

    public object WriteNote(string path, string text, string encoding, string eol, long expectMtime, bool force)
    {
        var abs = Resolve(path);
        if (!force && expectMtime > 0 && File.Exists(abs))
        {
            var cur = MtimeMs(abs);
            if (Math.Abs(cur - expectMtime) > 2) return new { conflict = true, mtime = cur };
        }
        TextFiles.Write(abs, text, encoding, eol);
        lock (_gate) _textCache.Remove(abs);
        return new { conflict = false, mtime = MtimeMs(abs) };
    }

    public NoteDto CreateNote(string wsId, string folder, string? title, string ext, string text, bool autoTitle)
    {
        lock (_gate)
        {
            var e = Ws(wsId);
            var dir = string.IsNullOrEmpty(folder) ? e.Dir : Path.Combine(e.Dir, folder.Replace('/', '\\'));
            if (!IsInside(dir, e.Dir) && !PathEq(dir, e.Dir)) throw new UnauthorizedAccessException();
            Directory.CreateDirectory(dir);
            ext = "." + (string.IsNullOrWhiteSpace(ext) ? "md" : ext.TrimStart('.'));
            if (!NoteExts.Contains(ext)) ext = ".md";
            if (ext == ".canvas" && string.IsNullOrEmpty(text)) text = "{\"nodes\":[],\"edges\":[]}";
            var abs = UniqueFile(dir, SanitizeName(string.IsNullOrWhiteSpace(title) ? UiLang.T("Untitled", "Sin título") : title), ext);
            TextFiles.Write(abs, text ?? "", "utf8", ext == ".canvas" ? "lf" : "crlf");
            var rel = Rel(e.Dir, abs);
            e.Meta.Notes[rel] = new NoteMeta { AutoTitle = autoTitle ? true : null, Created = DateTime.UtcNow.ToString("o") };
            SaveMeta(e);
            e.Names = null;
            return NoteToDto(e, abs, _index.Get(e.Meta.Id, rel, abs));
        }
    }

    public NoteDto RenameNote(string path, string title)
    {
        lock (_gate)
        {
            var abs = Resolve(path);
            if (!File.Exists(abs)) throw new FileNotFoundException(path);
            var dir = Path.GetDirectoryName(abs)!;
            var ext = Path.GetExtension(abs);
            var target = UniqueFile(dir, SanitizeName(title), ext, abs);
            var e = WsForAbs(abs);
            if (!string.Equals(Path.GetFileName(target), Path.GetFileName(abs), StringComparison.Ordinal))
            {
                if (PathEq(target, abs))
                {
                    var tmp = abs + ".rename-" + Guid.NewGuid().ToString("N")[..6];
                    File.Move(abs, tmp);
                    File.Move(tmp, target);
                }
                else File.Move(abs, target);
                _textCache.Remove(abs);
                if (e != null)
                {
                    MoveMetaKey(e, abs, e, target);
                    e.Names = null;
                }
            }
            if (e == null)
            {
                var fi = new FileInfo(target);
                return new NoteDto(ToApi(target), "", "", Path.GetFileNameWithoutExtension(target), fi.Extension.TrimStart('.'),
                    fi.Length, Ms(fi.LastWriteTimeUtc), Ms(fi.CreationTimeUtc), null, false, false, null, "note", null, null);
            }
            return NoteToDto(e, target, _index.Get(e.Meta.Id, Rel(e.Dir, target), target));
        }
    }

    private void MoveMetaKey(WsEntry from, string fromAbs, WsEntry to, string toAbs)
    {
        var k1 = Rel(from.Dir, fromAbs);
        var k2 = Rel(to.Dir, toAbs);
        if (from.Meta.Notes.Remove(k1, out var m))
        {
            to.Meta.Notes[k2] = m;
            SaveMeta(from);
            if (from != to) SaveMeta(to);
        }
    }

    private static readonly Regex WikiRx = new(@"(!?\[\[)([^\]\|#\n]+)((?:[#\|][^\]\n]*)?\]\])", RegexOptions.Compiled);

    /// <summary>Moves a note to another folder or workspace; images it uses follow it across workspaces.</summary>
    public (NoteDto Note, bool TextChanged) MoveNote(string path, string wsId, string folder)
    {
        lock (_gate)
        {
            var abs = Resolve(path);
            if (!File.Exists(abs)) throw new FileNotFoundException(path);
            var dst = Ws(wsId);
            var src = WsForAbs(abs);
            var dstDir = string.IsNullOrEmpty(folder) ? dst.Dir : Path.Combine(dst.Dir, folder.Replace('/', '\\'));
            if (!IsInside(dstDir, dst.Dir) && !PathEq(dstDir, dst.Dir)) throw new UnauthorizedAccessException();
            Directory.CreateDirectory(dstDir);
            if (PathEq(Path.GetDirectoryName(abs), dstDir)) return (NoteToDto(dst, abs, _index.Get(dst.Meta.Id, Rel(dst.Dir, abs), abs)), false);

            var target = UniqueFile(dstDir, Path.GetFileNameWithoutExtension(abs), Path.GetExtension(abs));
            var content = TextFiles.Read(abs);
            var srcDir = Path.GetDirectoryName(abs)!;
            var newText = RelocateText(content.Text, src, dst, srcDir, dstDir);
            File.Move(abs, target);
            bool changed = newText != content.Text;
            if (changed) TextFiles.Write(target, newText, content.Encoding, content.Eol);
            _textCache.Remove(abs);
            if (src != null)
            {
                MoveMetaKey(src, abs, dst, target);
                src.Names = null;
            }
            else
            {
                dst.Meta.Notes[Rel(dst.Dir, target)] = new NoteMeta { Created = DateTime.UtcNow.ToString("o") };
                SaveMeta(dst);
            }
            dst.Names = null;
            return (NoteToDto(dst, target, _index.Get(dst.Meta.Id, Rel(dst.Dir, target), target)), changed);
        }
    }

    /// <summary>
    /// The text of a note going from srcDir to dstDir: relative links still point to the same files (or, with
    /// mapTarget, to their copies) and, across workspaces, the images it uses are copied into the new one.
    /// </summary>
    private string RelocateText(string text, WsEntry? src, WsEntry dst, string srcDir, string dstDir, Func<string, string?>? mapTarget = null)
    {
        string CopyImage(string img)
        {
            var assets = AttachmentDir(dst, dstDir);
            Directory.CreateDirectory(assets);
            var copy = UniqueFile(assets, Path.GetFileNameWithoutExtension(img), Path.GetExtension(img));
            File.Copy(img, copy);
            return copy;
        }
        var newText = RewriteLinks(text, srcDir, dstDir, target2 =>
        {
            var mapped = mapTarget?.Invoke(target2);
            if (mapped != null) return mapped;
            if (src != null && src != dst && IsInside(target2, src.Dir) && File.Exists(target2) &&
                ImageExts.Contains(Path.GetExtension(target2)))
                return CopyImage(target2);
            return target2;
        });
        if (src != null && src != dst)
        {
            // ![[image.png]] embeds are found by name, so the image must exist in the new workspace too.
            newText = WikiRx.Replace(newText, m =>
            {
                var name = m.Groups[2].Value.Trim();
                if (!ImageExts.Contains(Path.GetExtension(name))) return m.Value;
                if (FindByName(dst, name, dstDir) != null) return m.Value;
                var found = FindByName(src, name, srcDir);
                if (found == null) return m.Value;
                var copy = CopyImage(found);
                dst.Names = null;
                return m.Groups[1].Value + Path.GetFileName(copy) + m.Groups[3].Value;
            });
        }
        return newText;
    }

    /// <summary>
    /// A copy of a note in a folder of any workspace (its own folder: "Duplicate", named "Note (2)"). Its links
    /// and images keep working like after a move; its colour comes along, it starts unpinned.
    /// </summary>
    public NoteDto CopyNote(string path, string wsId, string folder)
    {
        lock (_gate)
        {
            var abs = Resolve(path);
            if (!File.Exists(abs)) throw new FileNotFoundException(path);
            var dst = Ws(wsId);
            var src = WsForAbs(abs);
            var dstDir = string.IsNullOrEmpty(folder) ? dst.Dir : Path.Combine(dst.Dir, folder.Replace('/', '\\'));
            if (!IsInside(dstDir, dst.Dir) && !PathEq(dstDir, dst.Dir)) throw new UnauthorizedAccessException();
            Directory.CreateDirectory(dstDir);
            var srcDir = Path.GetDirectoryName(abs)!;
            var target = UniqueFile(dstDir, Path.GetFileNameWithoutExtension(abs), Path.GetExtension(abs));
            if (PathEq(srcDir, dstDir)) File.Copy(abs, target);
            else
            {
                var content = TextFiles.Read(abs);
                TextFiles.Write(target, RelocateText(content.Text, src, dst, srcDir, dstDir), content.Encoding, content.Eol);
            }
            NoteMeta? m = null;
            if (src != null) src.Meta.Notes.TryGetValue(Rel(src.Dir, abs), out m);
            dst.Meta.Notes[Rel(dst.Dir, target)] = new NoteMeta { Color = m?.Color, Created = DateTime.UtcNow.ToString("o") };
            SaveMeta(dst);
            dst.Names = null;
            return NoteToDto(dst, target, _index.Get(dst.Meta.Id, Rel(dst.Dir, target), target));
        }
    }

    /// <summary>
    /// A copy of a folder with everything in it, inside a folder of the same workspace ("" = top level; its own
    /// parent: "Duplicate", named "Folder (2)"). Notes keep their links working (links between files of the folder
    /// go to the copies); icons, colours and descriptions come along. Returns the copy's path.
    /// </summary>
    public string CopyFolder(string wsId, string path, string newParent)
    {
        lock (_gate)
        {
            var e = Ws(wsId);
            path = path.Trim('/');
            newParent = (newParent ?? "").Trim('/');
            if (string.Equals(newParent, path, StringComparison.OrdinalIgnoreCase) || newParent.StartsWith(path + "/", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException(UiLang.T("A folder can't be copied inside itself.", "Una carpeta no se puede copiar dentro de sí misma."));
            var src = Path.Combine(e.Dir, path.Replace('/', '\\'));
            if (!Directory.Exists(src) || !IsInside(src, e.Dir)) throw new DirectoryNotFoundException(path);
            var parentDir = newParent.Length == 0 ? e.Dir : Path.Combine(e.Dir, newParent.Replace('/', '\\'));
            if (!Directory.Exists(parentDir) || (!PathEq(parentDir, e.Dir) && !IsInside(parentDir, e.Dir))) throw new DirectoryNotFoundException(newParent);
            var target = UniqueDir(parentDir, Path.GetFileName(src));
            // Next to the original the copy is at the same depth, so its files can be copied as they are.
            bool sameDepth = PathEq(Path.GetDirectoryName(src), parentDir);
            CopyTree(src, target, e, sameDepth, abs => IsInside(abs, src) || PathEq(abs, src) ? Path.Combine(target, Path.GetRelativePath(src, abs)) : null);
            var newRel = Rel(e.Dir, target);
            foreach (var kv in e.Meta.Folders.Where(kv => string.Equals(kv.Key, path, StringComparison.OrdinalIgnoreCase) || kv.Key.StartsWith(path + "/", StringComparison.OrdinalIgnoreCase)).ToList())
                e.Meta.Folders[newRel + kv.Key[path.Length..]] = new FolderMeta { Color = kv.Value.Color, Icon = kv.Value.Icon, Description = kv.Value.Description, Order = kv.Value.Order };
            var maxOrder = e.Meta.Folders
                .Where(kv => string.Equals(ParentOf(kv.Key), newParent, StringComparison.OrdinalIgnoreCase) && !string.Equals(kv.Key, newRel, StringComparison.OrdinalIgnoreCase))
                .Select(kv => kv.Value.Order ?? 0).DefaultIfEmpty(-1).Max();
            if (!e.Meta.Folders.TryGetValue(newRel, out var fm)) e.Meta.Folders[newRel] = fm = new FolderMeta();
            fm.Order = maxOrder + 1;
            var now = DateTime.UtcNow.ToString("o");
            foreach (var kv in e.Meta.Notes.Where(kv => kv.Key.StartsWith(path + "/", StringComparison.OrdinalIgnoreCase)).ToList())
                e.Meta.Notes[newRel + kv.Key[path.Length..]] = new NoteMeta { Color = kv.Value.Color, Pinned = kv.Value.Pinned, AutoTitle = kv.Value.AutoTitle, Created = now };
            SaveMeta(e);
            e.Names = null;
            return newRel;
        }
    }

    private void CopyTree(string from, string to, WsEntry e, bool sameDepth, Func<string, string?> mapTarget)
    {
        Directory.CreateDirectory(to);
        foreach (var f in Directory.GetFiles(from))
        {
            var dest = Path.Combine(to, Path.GetFileName(f));
            if (sameDepth || !IsNoteFile(f)) { File.Copy(f, dest); continue; }
            var content = TextFiles.Read(f);
            TextFiles.Write(dest, RelocateText(content.Text, e, e, from, to, mapTarget), content.Encoding, content.Eol);
        }
        foreach (var d in Directory.GetDirectories(from))
            CopyTree(d, Path.Combine(to, Path.GetFileName(d)), e, sameDepth, mapTarget);
    }

    /// <summary>
    /// The Spine models next to a skeleton (Nikke-style folders: c820_00, c820_aim_01, c820_cover_02…): every
    /// .skel that has its .atlas there, with its name from the folder's fuentes.json when there is one, and its
    /// size (skeleton + atlas + textures).
    /// </summary>
    public object SpineInfo(string path)
    {
        var abs = Resolve(path);
        var dir = Path.GetDirectoryName(abs)!;
        string? character = null;
        var names = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            var fj = Path.Combine(dir, "fuentes.json");
            if (File.Exists(fj) && JsonNode.Parse(File.ReadAllText(fj)) is JsonObject o)
            {
                character = (o["personaje"] ?? o["character"])?.GetValue<string>();
                if ((o["modelos"] ?? o["models"]) is JsonArray list)
                    foreach (var m in list)
                    {
                        var id = (m?["modelo"] ?? m?["model"])?.GetValue<string>();
                        var nm = (m?["nombre"] ?? m?["name"])?.GetValue<string>();
                        if (id != null && nm != null) names[id] = nm;
                    }
            }
        }
        catch (Exception ex) { Log.Error("SpineInfo.fuentes", ex); }
        var models = new List<object>();
        foreach (var skel in Directory.EnumerateFiles(dir, "*.skel").OrderBy(f => f, StringComparer.OrdinalIgnoreCase))
        {
            var stem = Path.GetFileNameWithoutExtension(skel);
            var atlas = Path.Combine(dir, stem + ".atlas");
            if (!File.Exists(atlas)) continue;
            long bytes = new FileInfo(skel).Length + new FileInfo(atlas).Length;
            try
            {
                foreach (var line in File.ReadLines(atlas))
                {
                    var t = line.Trim();
                    if (!Regex.IsMatch(t, @"\.(png|webp|jpe?g)$", RegexOptions.IgnoreCase)) continue;
                    var tex = Path.Combine(dir, t);
                    if (File.Exists(tex)) bytes += new FileInfo(tex).Length;
                }
            }
            catch { }
            models.Add(new { file = Path.GetFileName(skel), atlas = stem + ".atlas", name = names.GetValueOrDefault(stem), bytes });
        }
        return new { character, models };
    }

    /// <summary>Copies files from anywhere into a folder (import / drag &amp; drop).</summary>
    public List<NoteDto> ImportFiles(IEnumerable<string> files, string wsId, string folder)
    {
        lock (_gate)
        {
            var e = Ws(wsId);
            var dir = string.IsNullOrEmpty(folder) ? e.Dir : Path.Combine(e.Dir, folder.Replace('/', '\\'));
            Directory.CreateDirectory(dir);
            var result = new List<NoteDto>();
            foreach (var f in files)
            {
                if (!File.Exists(f) || !NoteExts.Contains(Path.GetExtension(f))) continue;
                var target = UniqueFile(dir, SanitizeName(Path.GetFileNameWithoutExtension(f)), Path.GetExtension(f).ToLowerInvariant());
                File.Copy(f, target);
                var k = Rel(e.Dir, target);
                e.Meta.Notes[k] = new NoteMeta { Created = DateTime.UtcNow.ToString("o") };
                result.Add(NoteToDto(e, target, _index.Get(e.Meta.Id, k, target)));
            }
            SaveMeta(e);
            e.Names = null;
            return result;
        }
    }

    public void DeleteNote(string path)
    {
        lock (_gate)
        {
            var abs = Resolve(path);
            var e = WsForAbs(abs);
            Recycle(abs);
            _textCache.Remove(abs);
            if (e != null)
            {
                e.Meta.Notes.Remove(Rel(e.Dir, abs));
                SaveMeta(e);
                e.Names = null;
            }
        }
    }

    /// <summary>Deletes a note that was created and never written to (closing an empty new note).</summary>
    public bool DeleteIfEmpty(string path)
    {
        lock (_gate)
        {
            var abs = Resolve(path);
            if (!File.Exists(abs)) return true;
            var fi = new FileInfo(abs);
            if (fi.Length > 3) return false;
            var t = TextFiles.Read(abs).Text;
            if (t.Trim().Length > 0) return false;
            File.Delete(abs);
            var e = WsForAbs(abs);
            if (e != null)
            {
                e.Meta.Notes.Remove(Rel(e.Dir, abs));
                SaveMeta(e);
                e.Names = null;
            }
            return true;
        }
    }

    public NoteDto? SetNoteMeta(string path, JsonElement patch)
    {
        lock (_gate)
        {
            var abs = Resolve(path);
            var e = WsForAbs(abs);
            if (e == null) return null;
            var k = Rel(e.Dir, abs);
            if (!e.Meta.Notes.TryGetValue(k, out var m)) e.Meta.Notes[k] = m = new NoteMeta();
            if (patch.TryGetProperty("color", out var c)) m.Color = c.ValueKind == JsonValueKind.String && c.GetString()!.Length > 0 ? c.GetString() : null;
            if (patch.TryGetProperty("pinned", out var p)) m.Pinned = p.ValueKind == JsonValueKind.True ? true : null;
            if (patch.TryGetProperty("autoTitle", out var a)) m.AutoTitle = a.ValueKind == JsonValueKind.True ? true : null;
            SaveMeta(e);
            return File.Exists(abs) ? NoteToDto(e, abs, _index.Get(e.Meta.Id, k, abs)) : null;
        }
    }

    public List<object> Stat(IEnumerable<string> paths)
    {
        var r = new List<object>();
        foreach (var p in paths)
        {
            try
            {
                var abs = Resolve(p);
                var exists = File.Exists(abs);
                r.Add(new { path = p, exists, mtime = exists ? MtimeMs(abs) : 0 });
            }
            catch { r.Add(new { path = p, exists = false, mtime = 0L }); }
        }
        return r;
    }

    // ───────────────────────────── images ─────────────────────────────

    private static readonly Regex LinkRx = new(@"(!?\[(?:[^\[\]]|\[[^\]]*\])*\]\()\s*(<[^>\n]+>|[^)\s]+)((?:\s+""[^""\n]*"")?\s*\))", RegexOptions.Compiled);

    public static string EncodeLink(string rel)
    {
        var sb = new StringBuilder();
        foreach (var ch in rel.Replace('\\', '/'))
        {
            sb.Append(ch switch
            {
                ' ' => "%20", '(' => "%28", ')' => "%29", '<' => "%3C", '>' => "%3E", '%' => "%25", _ => ch.ToString()
            });
        }
        return sb.ToString();
    }

    public static string DecodeLink(string dest)
    {
        dest = dest.Trim();
        if (dest.StartsWith('<') && dest.EndsWith('>')) dest = dest[1..^1];
        try { return Uri.UnescapeDataString(dest); } catch { return dest; }
    }

    private static bool IsRelativeLink(string decoded) =>
        decoded.Length > 0 && !decoded.StartsWith('#') && !decoded.StartsWith('/') && !decoded.StartsWith('\\') &&
        !Regex.IsMatch(decoded, @"^[a-zA-Z][a-zA-Z0-9+.-]*:");

    /// <summary>
    /// Re-targets every relative link/image so it still points to the same file after the
    /// note moves from <paramref name="fromDir"/> to <paramref name="toDir"/>.
    /// </summary>
    private static string RewriteLinks(string text, string fromDir, string toDir, Func<string, string> mapTarget)
    {
        return LinkRx.Replace(text, m =>
        {
            var decoded = DecodeLink(m.Groups[2].Value);
            if (!IsRelativeLink(decoded)) return m.Value;
            string abs;
            try { abs = Path.GetFullPath(Path.Combine(fromDir, decoded.Replace('/', '\\'))); }
            catch { return m.Value; }
            var newAbs = mapTarget(abs);
            if (PathEq(fromDir, toDir) && PathEq(abs, newAbs)) return m.Value;
            var rel = Path.GetRelativePath(toDir, newAbs);
            var enc = EncodeLink(rel);
            if (enc == m.Groups[2].Value) return m.Value;
            return m.Groups[1].Value + enc + m.Groups[3].Value;
        });
    }

    /// <summary>Obsidian vaults keep attachments where .obsidian/app.json says; MarkNotes uses .assets.</summary>
    private static string AttachmentDir(WsEntry? e, string noteDir)
    {
        if (e == null) return Path.Combine(noteDir, AssetsDir);
        if (e.Vault)
        {
            string? setting = null;
            try
            {
                var appJson = Path.Combine(e.Dir, ".obsidian", "app.json");
                if (File.Exists(appJson)) setting = (JsonNode.Parse(File.ReadAllText(appJson)) as JsonObject)?["attachmentFolderPath"]?.GetValue<string>();
            }
            catch { }
            if (string.IsNullOrWhiteSpace(setting) || setting == "/") return e.Dir;
            if (setting.StartsWith("./")) return Path.GetFullPath(Path.Combine(noteDir, setting[2..].Replace('/', '\\')));
            return Path.GetFullPath(Path.Combine(e.Dir, setting.Trim('/').Replace('/', '\\')));
        }
        return Path.Combine(e.Dir, AssetsDir);
    }

    /// <summary>
    /// Files dropped or pasted on a canvas (videos, audio, PDFs…): files already in the workspace are used
    /// where they are, others are copied to the attachments folder. Returns their UI paths.
    /// </summary>
    public List<object> ImportFiles(string notePath, IEnumerable<string> sources)
    {
        var result = new List<object>();
        lock (_gate)
        {
            var noteAbs = Resolve(notePath);
            var e = WsForAbs(noteAbs);
            var noteDir = Path.GetDirectoryName(noteAbs)!;
            foreach (var src in sources)
            {
                if (string.IsNullOrWhiteSpace(src) || !File.Exists(src)) continue;
                var full = Path.GetFullPath(src);
                if (e != null && IsInside(full, e.Dir))
                {
                    result.Add(new { path = ToApi(full), name = Path.GetFileName(full), copied = false });
                    continue;
                }
                var dir = AttachmentDir(e, noteDir);
                Directory.CreateDirectory(dir);
                bool wiki = e != null && e.Vault;
                var ext = Path.GetExtension(full);
                if (ext.Equals(".skel", StringComparison.OrdinalIgnoreCase))
                {
                    // A Spine model plays with its atlas and textures under their own names: they go together, in a folder.
                    var srcDir = Path.GetDirectoryName(full)!;
                    var stem = Path.GetFileNameWithoutExtension(full);
                    var folder = UniqueDir(dir, SanitizeName(stem, 80));
                    Directory.CreateDirectory(folder);
                    var copiedSkel = Path.Combine(folder, Path.GetFileName(full));
                    File.Copy(full, copiedSkel);
                    var atlas = Path.Combine(srcDir, stem + ".atlas");
                    if (File.Exists(atlas))
                    {
                        File.Copy(atlas, Path.Combine(folder, stem + ".atlas"));
                        foreach (var line in File.ReadLines(atlas))
                        {
                            var t = line.Trim();
                            if (!Regex.IsMatch(t, @"\.(png|webp|jpe?g)$", RegexOptions.IgnoreCase)) continue;
                            var tex = Path.GetFullPath(Path.Combine(srcDir, t));
                            var to = Path.GetFullPath(Path.Combine(folder, t));
                            if (!File.Exists(tex) || File.Exists(to) || !IsInside(to, folder)) continue;
                            Directory.CreateDirectory(Path.GetDirectoryName(to)!);
                            File.Copy(tex, to);
                        }
                    }
                    var fj = Path.Combine(srcDir, "fuentes.json");
                    if (File.Exists(fj)) File.Copy(fj, Path.Combine(folder, "fuentes.json"));
                    if (e != null) e.Names = null;
                    result.Add(new { path = ToApi(copiedSkel), name = Path.GetFileName(copiedSkel), copied = true });
                    continue;
                }
                var baseName = SanitizeName(Path.GetFileNameWithoutExtension(full), 80);
                var abs = UniqueFile(dir, baseName, ext);
                if (wiki)
                {
                    var names = Names(e!, true);
                    int n = 2;
                    while (names.ContainsKey(Path.GetFileName(abs)) || File.Exists(abs))
                        abs = Path.Combine(dir, $"{baseName} {n++}{ext}");
                }
                File.Copy(full, abs);
                if (e != null) e.Names = null;
                result.Add(new { path = ToApi(abs), name = Path.GetFileName(abs), copied = true });
            }
        }
        return result;
    }

    /// <summary>Saves a pasted/dropped image and returns how to link it from the note.</summary>
    public object SaveAsset(string notePath, byte[] bytes, string ext, string? preferredName)
    {
        lock (_gate)
        {
            var noteAbs = Resolve(notePath);
            var e = WsForAbs(noteAbs);
            var noteDir = Path.GetDirectoryName(noteAbs)!;
            var dir = AttachmentDir(e, noteDir);
            Directory.CreateDirectory(dir);
            bool wiki = e != null && e.Vault;
            if (!wiki && Path.GetFileName(dir).Equals(AssetsDir, StringComparison.OrdinalIgnoreCase))
            {
                try { File.SetAttributes(dir, File.GetAttributes(dir) | FileAttributes.Hidden); } catch { }
            }
            ext = "." + (string.IsNullOrWhiteSpace(ext) ? "png" : ext.TrimStart('.').ToLowerInvariant());
            if (!ImageExts.Contains(ext)) ext = ".png";
            var baseName = !string.IsNullOrWhiteSpace(preferredName) ? SanitizeName(Path.GetFileNameWithoutExtension(preferredName), 60)
                : wiki ? "Pasted image " + DateTime.Now.ToString("yyyyMMddHHmmss")
                : "image-" + DateTime.Now.ToString("yyyyMMdd-HHmmss");
            var abs = UniqueFile(dir, baseName, ext);
            if (wiki)
            {
                // Obsidian finds images by name: keep the name unique in the whole vault.
                var names = Names(e!, true);
                int n = 2;
                while (names.ContainsKey(Path.GetFileName(abs)) || File.Exists(abs))
                    abs = Path.Combine(dir, $"{baseName} {n++}{ext}");
            }
            File.WriteAllBytes(abs, bytes);
            if (e != null) e.Names = null;
            var rel = Path.GetRelativePath(noteDir, abs);
            // path: the workspace path of the image ("Ws/…" or "@id/…"), what canvases store (minus the prefix).
            return new { link = wiki ? Path.GetFileName(abs) : EncodeLink(rel), wiki, name = Path.GetFileName(abs), url = FileUrl(abs, Root), path = ToApi(abs) };
        }
    }

    /// <summary>
    /// Finds the files a canvas points to. Obsidian stores them relative to the vault root, which may be
    /// a folder above the one opened here, so try: the workspace root, the canvas folder and each folder
    /// above it, then the file name anywhere in the workspace. Returns UI paths (null = not found).
    /// </summary>
    public Dictionary<string, string?> ResolveFiles(string notePath, List<string> files)
    {
        var noteAbs = Resolve(notePath);
        var noteDir = Path.GetDirectoryName(noteAbs)!;
        WsEntry? e;
        lock (_gate) e = WsForAbs(noteAbs);
        var result = new Dictionary<string, string?>();
        foreach (var f in files.Distinct())
        {
            if (string.IsNullOrWhiteSpace(f) || f.Length > 1000) continue;
            string? abs = null;
            try
            {
                var rel = f.Replace('/', '\\').TrimStart('\\');
                if (Path.IsPathRooted(f)) abs = File.Exists(f) ? Path.GetFullPath(f) : null;
                if (abs == null && e != null)
                {
                    var p = Path.GetFullPath(Path.Combine(e.Dir, rel));
                    if (File.Exists(p)) abs = p;
                }
                int up = 0;
                for (var d = noteDir; abs == null && d != null && up < 8; d = Path.GetDirectoryName(d), up++)
                {
                    var p = Path.GetFullPath(Path.Combine(d, rel));
                    if (File.Exists(p)) abs = p;
                }
                if (abs == null && e != null)
                    lock (_gate) abs = FindByName(e, f, noteDir);
            }
            catch (Exception ex) { Log.Error("ResolveFiles " + f, ex); }
            result[f] = abs == null ? null : ToApi(abs);
        }
        return result;
    }

    /// <summary>
    /// What a canvas stores for files it shows: Obsidian writes paths relative to the vault root (the closest
    /// folder with .obsidian above the canvas, which may be above the opened folder); without a vault, relative
    /// to the workspace.
    /// </summary>
    public List<string> CanvasPaths(string canvasPath, List<string> paths)
    {
        var canvasAbs = Resolve(canvasPath);
        WsEntry? e;
        lock (_gate) e = WsForAbs(canvasAbs);
        string? root = null;
        int up = 0;
        for (var d = Path.GetDirectoryName(canvasAbs); d != null && up < 12; d = Path.GetDirectoryName(d), up++)
            if (Directory.Exists(Path.Combine(d, ".obsidian"))) { root = d; break; }
        root ??= e?.Dir ?? Path.GetDirectoryName(canvasAbs)!;
        var result = new List<string>();
        foreach (var p in paths)
        {
            try
            {
                var abs = Resolve(p);
                var rel = Path.GetRelativePath(root, abs);
                result.Add(rel.StartsWith("..") || Path.IsPathRooted(rel) ? abs : rel.Replace('\\', '/'));
            }
            catch { result.Add(p); }
        }
        return result;
    }

    /// <summary>Absolute path of a link/embed target in a note (markdown link, ![[name]] or absolute path).</summary>
    public string? ResolveLink(string notePath, string link, bool wiki = false)
    {
        var noteAbs = Resolve(notePath);
        var noteDir = Path.GetDirectoryName(noteAbs)!;
        if (wiki)
        {
            lock (_gate)
            {
                var e = WsForAbs(noteAbs);
                if (e != null) return FindByName(e, link.Split('|')[0].Split('#')[0], noteDir);
            }
            var local = Path.Combine(noteDir, link);
            return File.Exists(local) ? local : null;
        }
        var decoded = DecodeLink(link);
        if (!IsRelativeLink(decoded))
        {
            if (Regex.IsMatch(decoded, @"^[a-zA-Z]:[\\/]")) return Path.GetFullPath(decoded);
            if (decoded.StartsWith("file:///", StringComparison.OrdinalIgnoreCase)) return Path.GetFullPath(new Uri(decoded).LocalPath);
            return null;
        }
        return Path.GetFullPath(Path.Combine(noteDir, decoded.Replace('/', '\\')));
    }

    private IEnumerable<string> AllNotes(WsEntry e)
    {
        var list = new List<string>();
        Walk(e.Dir, (f, _) => list.Add(f), null, null);
        return list;
    }

    /// <summary>
    /// Renames an image and fixes every note of the workspace that shows it (markdown links and
    /// ![[name]] embeds). Notes listed in <paramref name="openPaths"/> are open in the editor; the UI
    /// patches those itself, so we only report the old/new link for each of them.
    /// </summary>
    public object RenameAsset(string notePath, string link, string newName, List<string> openPaths, bool wiki = false)
    {
        lock (_gate)
        {
            var noteAbs = Resolve(notePath);
            var oldAbs = ResolveLink(notePath, link, wiki) ?? throw new InvalidOperationException(UiLang.T("Not a local image", "No es una imagen local"));
            if (!File.Exists(oldAbs)) throw new FileNotFoundException(UiLang.T("Image not found", "No se encontró la imagen"), oldAbs);
            var ext = Path.GetExtension(oldAbs);
            var wantedExt = Path.GetExtension(newName);
            var stem = ImageExts.Contains(wantedExt) ? Path.GetFileNameWithoutExtension(newName) : newName;
            var newAbs = UniqueFile(Path.GetDirectoryName(oldAbs)!, SanitizeName(stem, 80), ext, oldAbs);
            if (!string.Equals(Path.GetFileName(newAbs), Path.GetFileName(oldAbs), StringComparison.Ordinal))
            {
                if (PathEq(newAbs, oldAbs))
                {
                    var tmp = oldAbs + ".rename-" + Guid.NewGuid().ToString("N")[..6];
                    File.Move(oldAbs, tmp);
                    File.Move(tmp, newAbs);
                }
                else File.Move(oldAbs, newAbs);
            }
            var oldName = Path.GetFileName(oldAbs);
            var newFile = Path.GetFileName(newAbs);

            var openSet = new HashSet<string>(openPaths.Select(p => { try { return Resolve(p); } catch { return p; } }), StringComparer.OrdinalIgnoreCase);
            var e = WsForAbs(noteAbs);
            var updated = new List<string>();
            if (e != null)
            {
                foreach (var f in AllNotes(e))
                {
                    if (openSet.Contains(f)) continue;
                    try
                    {
                        var t = TextFiles.Read(f);
                        if (!t.Text.Contains(oldName, StringComparison.OrdinalIgnoreCase) &&
                            !t.Text.Contains(EncodeLink(oldName), StringComparison.OrdinalIgnoreCase)) continue;
                        var dir = Path.GetDirectoryName(f)!;
                        var nt = LinkRx.Replace(t.Text, m =>
                        {
                            var dec = DecodeLink(m.Groups[2].Value);
                            if (!IsRelativeLink(dec)) return m.Value;
                            string abs;
                            try { abs = Path.GetFullPath(Path.Combine(dir, dec.Replace('/', '\\'))); } catch { return m.Value; }
                            if (!PathEq(abs, oldAbs)) return m.Value;
                            return m.Groups[1].Value + EncodeLink(Path.GetRelativePath(dir, newAbs)) + m.Groups[3].Value;
                        });
                        nt = WikiRx.Replace(nt, m =>
                        {
                            var target = m.Groups[2].Value.Trim();
                            var file = target.Contains('/') ? target[(target.LastIndexOf('/') + 1)..] : target;
                            if (!file.Equals(oldName, StringComparison.OrdinalIgnoreCase)) return m.Value;
                            var replaced = target.Contains('/') ? target[..(target.LastIndexOf('/') + 1)] + newFile : newFile;
                            return m.Groups[1].Value + replaced + m.Groups[3].Value;
                        });
                        if (nt != t.Text)
                        {
                            TextFiles.Write(f, nt, t.Encoding, t.Eol);
                            _textCache.Remove(f);
                            updated.Add(ToApi(f));
                        }
                    }
                    catch (Exception ex) { Log.Error("RenameAsset.update " + f, ex); }
                }
                e.Names = null;
            }
            var edits = openPaths.Select(p =>
            {
                string dir;
                try { dir = Path.GetDirectoryName(Resolve(p))!; } catch { return null; }
                return new { path = p, from = EncodeLink(Path.GetRelativePath(dir, oldAbs)), to = EncodeLink(Path.GetRelativePath(dir, newAbs)) };
            }).Where(x => x != null).ToList();
            return new
            {
                name = newFile,
                oldName,
                link = wiki ? newFile : EncodeLink(Path.GetRelativePath(Path.GetDirectoryName(noteAbs)!, newAbs)),
                url = FileUrl(newAbs, Root),
                updated,
                edits,
            };
        }
    }

    public void DeleteAsset(string notePath, string link, bool wiki = false)
    {
        var abs = ResolveLink(notePath, link, wiki) ?? throw new InvalidOperationException(UiLang.T("Not a local image", "No es una imagen local"));
        if (!ImageExts.Contains(Path.GetExtension(abs))) throw new InvalidOperationException(UiLang.T("Not an image", "No es una imagen"));
        Recycle(abs);
        lock (_gate)
        {
            var e = WsForAbs(abs);
            if (e != null) e.Names = null;
        }
    }

    // ───────────────────────────── search ─────────────────────────────

    private void DropCacheUnder(string dir)
    {
        foreach (var k in _textCache.Keys.Where(k => IsInside(k, dir)).ToList()) _textCache.Remove(k);
    }

    private string CachedText(string abs)
    {
        var mt = MtimeMs(abs);
        lock (_gate)
        {
            if (_textCache.TryGetValue(abs, out var c) && c.Mtime == mt) return c.Text;
        }
        var fi = new FileInfo(abs);
        var text = fi.Length > 8 * 1024 * 1024 ? "" : TextFiles.Read(abs).Text;
        lock (_gate) _textCache[abs] = (mt, text);
        return text;
    }

    private static List<string> SplitTerms(string q)
    {
        var terms = new List<string>();
        foreach (Match m in Regex.Matches(q, @"""([^""]+)""|(\S+)"))
            terms.Add(m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Value);
        return terms;
    }

    public List<SearchHit> Search(string query, string? wsId, int limit)
    {
        var terms = SplitTerms(query ?? "");
        if (terms.Count == 0) return new();
        var ci = CultureInfo.InvariantCulture.CompareInfo;
        const CompareOptions opt = CompareOptions.IgnoreCase | CompareOptions.IgnoreNonSpace;
        List<(WsEntry E, string Abs)> files = new();
        WsEntry[] targets;
        lock (_gate)
            targets = wsId != null ? new[] { Ws(wsId) } : (_byId.Count == 0 ? Scan().Select(w => _byId[w.Id]) : _byId.Values).ToArray();
        foreach (var e in targets)
        {
            try { Walk(e.Dir, (f, _) => files.Add((e, f)), null, null); }
            catch (Exception ex) { Log.Error("Search.enum", ex); }
        }

        var hits = new List<(SearchHit Hit, double Score)>();
        foreach (var (e, abs) in files)
        {
            string text;
            try { text = CachedText(abs); } catch { continue; }
            var title = Path.GetFileNameWithoutExtension(abs);
            int total = 0, titleHits = 0, firstPos = -1;
            bool all = true;
            foreach (var term in terms)
            {
                bool inTitle = ci.IndexOf(title, term, opt) >= 0;
                int pos = ci.IndexOf(text, term, opt);
                if (!inTitle && pos < 0) { all = false; break; }
                if (inTitle) titleHits++;
                if (pos >= 0)
                {
                    if (firstPos < 0 || pos < firstPos) firstPos = pos;
                    int count = 0, p = pos;
                    while (p >= 0 && count < 50)
                    {
                        count++;
                        p = p + term.Length < text.Length ? ci.IndexOf(text, term, p + term.Length, opt) : -1;
                    }
                    total += count;
                }
            }
            if (!all) continue;
            string snippet;
            if (firstPos >= 0)
            {
                int start = Math.Max(0, firstPos - 60);
                int end = Math.Min(text.Length, firstPos + 160);
                snippet = (start > 0 ? "…" : "") + Regex.Replace(text[start..end], @"\s+", " ").Trim() + (end < text.Length ? "…" : "");
            }
            else snippet = Regex.Replace(text.Length > 200 ? text[..200] : text, @"\s+", " ").Trim();
            var rel = Rel(e.Dir, abs);
            var folder = ParentOf(rel);
            var mt = MtimeMs(abs);
            double score = titleHits * 20 + Math.Min(total, 30) + mt / 1e13;
            hits.Add((new SearchHit(ToApi(abs), e.Meta.Id, folder, title, snippet, total, mt, titleHits > 0), score));
        }
        return hits.OrderByDescending(h => h.Score).Take(Math.Max(1, limit)).Select(h => h.Hit).ToList();
    }
}

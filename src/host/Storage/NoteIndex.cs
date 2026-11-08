using System.Text.Json;
using System.Text.RegularExpressions;

namespace MarkNotes.Storage;

/// <summary>
/// Per-workspace cache of what lists and cards need from each note (kind, preview, cover, date),
/// keyed by path + modified time + size so unchanged files are never read again. Persisted in
/// %LOCALAPPDATA%\MarkNotes\index so even the first listing after a restart is instant.
/// </summary>
public sealed class NoteIndex
{
    public sealed class Entry
    {
        public long M { get; set; }
        public long S { get; set; }
        public string Kind { get; set; } = "note";
        public string? Preview { get; set; }
        public string? Banner { get; set; }
        public string? FirstImage { get; set; }
        public string? Date { get; set; }
    }

    private readonly string _dir;
    private readonly Dictionary<string, Dictionary<string, Entry>> _ws = new();
    private readonly HashSet<string> _dirty = new();
    private readonly object _gate = new();
    private System.Threading.Timer? _saveTimer;

    public NoteIndex(string dir) => _dir = dir;

    private string FileFor(string wsId) => Path.Combine(_dir, wsId + ".json");

    private Dictionary<string, Entry> Load(string wsId)
    {
        lock (_gate)
        {
            if (_ws.TryGetValue(wsId, out var d)) return d;
            d = new Dictionary<string, Entry>(StringComparer.OrdinalIgnoreCase);
            try
            {
                var f = FileFor(wsId);
                if (File.Exists(f))
                {
                    var loaded = JsonSerializer.Deserialize<Dictionary<string, Entry>>(File.ReadAllText(f));
                    if (loaded != null) foreach (var kv in loaded) d[kv.Key] = kv.Value;
                }
            }
            catch (Exception ex) { Log.Error("NoteIndex.Load", ex); }
            _ws[wsId] = d;
            return d;
        }
    }

    /// <summary>The cached entry when it is still valid, without reading the file.</summary>
    public Entry? Peek(string wsId, string rel, string abs) => Peek(wsId, rel, new FileInfo(abs));

    /// <summary>fi may come straight from a directory listing (size and date already known).</summary>
    public Entry? Peek(string wsId, string rel, FileInfo fi)
    {
        var d = Load(wsId);
        try
        {
            lock (_gate)
                if (d.TryGetValue(rel, out var e) && e.M == NoteStore.Ms(fi.LastWriteTimeUtc) && e.S == fi.Length) return e;
        }
        catch { }
        return null;
    }

    public Entry Get(string wsId, string rel, string abs) => Get(wsId, rel, new FileInfo(abs));

    public Entry Get(string wsId, string rel, FileInfo fi)
    {
        var d = Load(wsId);
        var abs = fi.FullName;
        long m = NoteStore.Ms(fi.LastWriteTimeUtc), s = fi.Length;
        lock (_gate)
            if (d.TryGetValue(rel, out var e) && e.M == m && e.S == s) return e;
        var entry = Build(abs, fi, m, s);
        lock (_gate)
        {
            d[rel] = entry;
            _dirty.Add(wsId);
        }
        return entry;
    }

    private static readonly Regex FrontRx = new(@"\A﻿?---[ \t]*\r?\n(.*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)", RegexOptions.Singleline | RegexOptions.Compiled);
    private static readonly Regex KeyRx = new(@"^([A-Za-z0-9_\-]+)[ \t]*:[ \t]*(.*?)\s*$", RegexOptions.Compiled);
    private static readonly Regex ImgRx = new(@"!\[\[([^\]\|#\n]+\.(?:png|jpe?g|gif|webp|bmp|avif))[^\]\n]*\]\]|!\[[^\]\n]*\]\(\s*<?([^)\s>]+\.(?:png|jpe?g|gif|webp|bmp|avif))>?", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex CanvasFileRx = new(@"""file""\s*:\s*""([^""]+\.(?:png|jpe?g|gif|webp|bmp))""", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static Entry Build(string abs, FileInfo fi, long m, long s)
    {
        var e = new Entry { M = m, S = s };
        if (fi.Extension.Equals(".canvas", StringComparison.OrdinalIgnoreCase))
        {
            e.Kind = "canvas";
            try
            {
                var text = fi.Length < 8_000_000 ? File.ReadAllText(abs) : "";
                var img = CanvasFileRx.Match(text);
                if (img.Success) e.FirstImage = Regex.Unescape(img.Groups[1].Value);
            }
            catch { }
            return e;
        }
        var head = TextFiles.Preview(abs, 12000);
        var body = head;
        var fm = FrontRx.Match(head);
        if (fm.Success)
        {
            foreach (var line in fm.Groups[1].Value.Split('\n'))
            {
                var kv = KeyRx.Match(line.TrimEnd('\r'));
                if (!kv.Success) continue;
                var key = kv.Groups[1].Value.ToLowerInvariant();
                var val = kv.Groups[2].Value.Trim().Trim('"', '\'');
                switch (key)
                {
                    case "banner" or "cover" or "image" or "cover-image" or "cover_image":
                        if (val.Length > 0) e.Banner ??= val;
                        break;
                    case "datetime" or "date" or "created":
                        if (val.Length > 0) e.Date ??= val;
                        break;
                    case "kanban-plugin":
                        e.Kind = "kanban";
                        break;
                }
            }
            body = head[fm.Length..];
        }
        var first = ImgRx.Match(body);
        if (first.Success) e.FirstImage = first.Groups[1].Success ? first.Groups[1].Value : first.Groups[2].Value;
        var pv = body.TrimStart('\r', '\n', ' ', '\t');
        e.Preview = pv.Length > 400 ? pv[..400] : pv;
        return e;
    }

    /// <summary>Strips banner syntax ("![[a.jpg]]", "[[a.jpg|x]]", "[t](a.jpg)") down to the file; null for web URLs.</summary>
    public static string? CleanTarget(string raw)
    {
        var s = raw.Trim().Trim('"', '\'').Trim();
        if (s.StartsWith('!')) s = s[1..];
        if (s.StartsWith("[[") && s.EndsWith("]]")) s = s[2..^2];
        else
        {
            var md = Regex.Match(s, @"^\[[^\]]*\]\((.+)\)$");
            if (md.Success) s = md.Groups[1].Value.Trim('<', '>');
        }
        s = s.Split('|')[0].Split('#')[0].Trim();
        if (s.Length == 0 || Regex.IsMatch(s, @"^[a-zA-Z][a-zA-Z0-9+.-]*://")) return null;
        return s;
    }

    public void SaveSoon(string wsId)
    {
        lock (_gate)
        {
            if (!_dirty.Contains(wsId)) return;
            _saveTimer ??= new System.Threading.Timer(_ => Flush(), null, Timeout.Infinite, Timeout.Infinite);
            _saveTimer.Change(1500, Timeout.Infinite);
        }
    }

    public void Flush()
    {
        List<(string Id, string Json)> work = new();
        lock (_gate)
        {
            foreach (var id in _dirty)
                if (_ws.TryGetValue(id, out var d)) work.Add((id, JsonSerializer.Serialize(d)));
            _dirty.Clear();
        }
        foreach (var (id, json) in work)
        {
            try
            {
                Directory.CreateDirectory(_dir);
                var f = FileFor(id);
                File.WriteAllText(f + ".tmp", json);
                File.Move(f + ".tmp", f, true);
            }
            catch (Exception ex) { Log.Error("NoteIndex.Flush", ex); }
        }
    }

    public void Forget(string wsId)
    {
        lock (_gate)
        {
            _ws.Remove(wsId);
            _dirty.Remove(wsId);
        }
        try { File.Delete(FileFor(wsId)); } catch { }
    }
}

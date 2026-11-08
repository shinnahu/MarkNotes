using System.Text.Json;
using System.Text.Json.Nodes;
using MarkNotes.Shell;
using MarkNotes.Speech;
using MarkNotes.Storage;
using Microsoft.Web.WebView2.Core;

namespace MarkNotes;

/// <summary>
/// JSON-RPC between the web UI and the native side.
/// UI → host: {id, cmd, args}. Host → UI: {id, ok, result|error} or {event, data}.
/// </summary>
public sealed class Bridge : IDisposable
{
    private delegate Task<object?> Handler(JsonElement args);

    private readonly MainForm _form;
    private readonly CoreWebView2 _core;
    private readonly Dictionary<string, Handler> _handlers = new(StringComparer.Ordinal);
    private NoteStore _store;
    private readonly AsrService _asr;
    private LinkPreviews? _links;
    /// <summary>Web videos may load inside the app (Settings › Editor › Play web videos inside MarkNotes).</summary>
    public bool EmbedsAllowed { get; private set; } = true;
    private LinkPreviews Links => _links ??= new LinkPreviews(Path.Combine(AppPaths.LocalDir, "linkcache"), _store.Root);
    private Migration.Result? _migration;
    private bool _migrationChecked;
    /// <summary>Where the next PDF goes (picked by the user) and the last one written (for "Open").</summary>
    private string? _pdfTarget, _lastPdf;

    public Bridge(MainForm form, CoreWebView2 core)
    {
        _form = form;
        _core = core;
        Migration.AdoptV1Settings();
        _store = new NoteStore(HostSettings.NotesRoot());
        _asr = new AsrService(Emit);
        // Phone sync (Settings › Phone): on when the user turned it on; the phone does the syncing.
        _sync = new Sync.SyncServer(() => _store, Emit,
            () => _form.BeginInvoke(() => _form.ActivateFromOtherInstance(new List<string>())), _form.SyncPort, _form.SyncLan);
        try
        {
            if (HostSettings.Load()["phoneSync"] is JsonNode n && n.GetValueKind() == JsonValueKind.True) _sync.SetEnabled(true);
        }
        catch (Exception ex) { Log.Error("Sync autostart", ex); }
        Register();
    }

    private readonly Sync.SyncServer _sync;

    public void Dispose()
    {
        try { _sync.Dispose(); } catch (Exception ex) { Log.Error("Sync stop", ex); }
        _asr.Dispose();
        try { _store.FlushIndex(); } catch (Exception ex) { Log.Error("FlushIndex", ex); }
        try { _links?.Save(); } catch (Exception ex) { Log.Error("LinkPreviews", ex); }
    }

    // ───────────────────────────── plumbing ─────────────────────────────

    public async void OnMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        long id = 0;
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            var root = doc.RootElement;
            id = root.TryGetProperty("id", out var idEl) ? idEl.GetInt64() : 0;
            var cmd = root.GetProperty("cmd").GetString() ?? "";
            var args = root.TryGetProperty("args", out var a) ? a.Clone() : default;

            object? result;
            if (cmd == "drop.files")
            {
                // Files dragged from Explorer arrive as WebView2 file objects carrying their path.
                var paths = new List<string>();
                var extra = e.AdditionalObjects;
                if (extra != null)
                    foreach (var o in extra)
                        if (o is CoreWebView2File f) paths.Add(f.Path);
                result = paths;
            }
            else if (_handlers.TryGetValue(cmd, out var h)) result = await h(args);
            else throw new InvalidOperationException("Unknown command " + cmd);

            if (id != 0) Post(new { id, ok = true, result });
        }
        catch (Exception ex)
        {
            Log.Error("Bridge", ex);
            if (id != 0) Post(new { id, ok = false, error = ex.Message });
        }
    }

    private void Post(object msg)
    {
        var json = JsonSerializer.Serialize(msg, JsonOpts.Web);
        if (_form.InvokeRequired) _form.BeginInvoke(() => SafePost(json));
        else SafePost(json);
    }

    private void SafePost(string json)
    {
        try { _core.PostWebMessageAsJson(json); }
        catch (Exception ex) { Log.Error("PostWebMessage", ex); }
    }

    public void Emit(string evt, object? data) => Post(new { @event = evt, data });

    private void OnAsync(string cmd, Func<JsonElement, Task<object?>> h) => _handlers[cmd] = new Handler(h);
    private void On(string cmd, Func<JsonElement, object?> h) => _handlers[cmd] = a => Task.FromResult(h(a));
    private void OnBg(string cmd, Func<JsonElement, object?> h) => _handlers[cmd] = a => Task.Run(() => h(a));

    private static string? S(JsonElement a, string name) =>
        a.ValueKind == JsonValueKind.Object && a.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    private static string Req(JsonElement a, string name) => S(a, name) ?? throw new ArgumentException("Missing " + name);
    private static bool B(JsonElement a, string name) =>
        a.ValueKind == JsonValueKind.Object && a.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;
    private static bool Has(JsonElement a, string name) => a.ValueKind == JsonValueKind.Object && a.TryGetProperty(name, out _);

    private const string CanvasClipFormat = "MarkNotes.Canvas";

    /// <summary>What the system clipboard holds, for pasting on a canvas: copied cards, files (Explorer), a picture, text.</summary>
    private static object ClipboardRead()
    {
        string? canvas = null, text = null;
        var files = new List<string>();
        bool image = false;
        try
        {
            var data = Clipboard.GetDataObject();
            if (data != null)
            {
                if (data.GetDataPresent(CanvasClipFormat) && data.GetData(CanvasClipFormat) is MemoryStream ms)
                    canvas = System.Text.Encoding.UTF8.GetString(ms.ToArray()).TrimEnd('\0');
                if (data.GetDataPresent(DataFormats.FileDrop) && data.GetData(DataFormats.FileDrop) is string[] drop)
                    files.AddRange(drop.Where(File.Exists));
                if (data.GetDataPresent(DataFormats.UnicodeText)) text = data.GetData(DataFormats.UnicodeText) as string;
                image = data.GetDataPresent(DataFormats.Bitmap) || data.GetDataPresent("PNG") || data.GetDataPresent(DataFormats.Dib);
            }
        }
        catch (Exception ex) { Log.Info("Clipboard read: " + ex.Message); }
        return new { canvas, text, files, image };
    }
    private static long L(JsonElement a, string name) =>
        a.ValueKind == JsonValueKind.Object && a.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt64() : 0;
    private static List<string> Strs(JsonElement a, string name) =>
        a.ValueKind == JsonValueKind.Object && a.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Array
            ? v.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String).Select(x => x.GetString()!).ToList()
            : new List<string>();

    private static (byte[] Bytes, string Ext) DataUrl(string dataUrl)
    {
        var comma = dataUrl.IndexOf(',');
        if (!dataUrl.StartsWith("data:") || comma < 0) return (Convert.FromBase64String(dataUrl), ".png");
        var head = dataUrl[5..comma];
        var mime = head.Split(';')[0].ToLowerInvariant();
        var ext = mime switch
        {
            "image/jpeg" => ".jpg", "image/gif" => ".gif", "image/webp" => ".webp", "image/svg+xml" => ".svg",
            "image/bmp" => ".bmp", "image/avif" => ".avif", _ => ".png",
        };
        return (Convert.FromBase64String(dataUrl[(comma + 1)..]), ext);
    }

    private static JsonNode? ReadJsonFile(string path)
    {
        try { return File.Exists(path) ? JsonNode.Parse(File.ReadAllText(path)) : null; }
        catch (Exception ex) { Log.Error("ReadJsonFile " + path, ex); return null; }
    }

    /// <summary>
    /// https://files.marknotes.example/r/&lt;path in notes folder&gt;, /r/@&lt;id&gt;/&lt;path in an opened folder&gt;
    /// or /a/&lt;absolute path&gt;.
    /// </summary>
    public string? ResolveFileUrl(Uri uri)
    {
        var segs = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries).Select(Uri.UnescapeDataString).ToArray();
        if (segs.Length < 2) return null;
        var rest = string.Join('\\', segs.Skip(1));
        try
        {
            if (segs[0] == "r" && segs[1].StartsWith('@')) return _store.ResolveLinkedFast(string.Join('/', segs.Skip(1)));
            if (segs[0] == "r")
            {
                var p = Path.GetFullPath(Path.Combine(_store.Root, rest));
                return NoteStore.IsInside(p, _store.Root) ? p : null;
            }
            if (segs[0] == "a") return Path.GetFullPath(rest);
        }
        catch { }
        return null;
    }

    private string? SaveDialog(string title, string filter, string fileName, string? ext = null, string? dir = null)
    {
        using var d = new SaveFileDialog { Title = title, Filter = filter, FileName = fileName, AddExtension = true, OverwritePrompt = true };
        if (ext != null) d.DefaultExt = ext;
        if (dir != null && Directory.Exists(dir)) d.InitialDirectory = dir;
        return d.ShowDialog(_form) == DialogResult.OK ? d.FileName : null;
    }

    /// <summary>
    /// Prints the page (the UI's print-only layout of a note) to PDF through the DevTools protocol, which also gives
    /// the page numbers a footer of their own and turns the headings into PDF bookmarks. The page margins take the
    /// WebView's background colour (the theme's), so that colour is white while printing.
    /// </summary>
    private async Task<byte[]> PrintPdfAsync(JsonElement a)
    {
        double N(string name, double def, double min, double max) =>
            a.ValueKind == JsonValueKind.Object && a.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? Math.Clamp(v.GetDouble(), min, max) : def;
        var margin = N("margin", 0.71, 0, 3);
        var footer = S(a, "footer");
        var args = new JsonObject
        {
            ["landscape"] = B(a, "landscape"),
            ["paperWidth"] = N("paperWidth", 8.27, 1, 50),
            ["paperHeight"] = N("paperHeight", 11.69, 1, 50),
            ["marginTop"] = margin, ["marginBottom"] = margin, ["marginLeft"] = margin, ["marginRight"] = margin,
            ["printBackground"] = true,
            ["displayHeaderFooter"] = footer != null,
            ["headerTemplate"] = "<span></span>",
            ["footerTemplate"] = footer ?? "<span></span>",
            ["generateTaggedPDF"] = true,
            ["generateDocumentOutline"] = true,
        };
        await _core.CallDevToolsProtocolMethodAsync("Emulation.setDefaultBackgroundColorOverride", "{\"color\":{\"r\":255,\"g\":255,\"b\":255,\"a\":1}}");
        try
        {
            using var res = JsonDocument.Parse(await _core.CallDevToolsProtocolMethodAsync("Page.printToPDF", args.ToJsonString()));
            return Convert.FromBase64String(res.RootElement.GetProperty("data").GetString() ?? "");
        }
        finally
        {
            try { await _core.CallDevToolsProtocolMethodAsync("Emulation.setDefaultBackgroundColorOverride", "{}"); }
            catch (Exception ex) { Log.Error("PDF background", ex); }
        }
    }

    private string[] OpenDialog(string title, string filter, bool multi)
    {
        using var d = new OpenFileDialog { Title = title, Filter = filter, Multiselect = multi, CheckFileExists = true };
        return d.ShowDialog(_form) == DialogResult.OK ? d.FileNames : Array.Empty<string>();
    }

    // File dialog filters in the interface language.
    private static string AllFiles => UiLang.T("All files", "Todos los archivos") + " (*.*)|*.*";
    private static string PackFilter(string patterns) => UiLang.T("MarkNotes pack", "Paquete de MarkNotes") + $" ({patterns})|{patterns}";
    private static string ThemeFilter(string patterns) => UiLang.T("MarkNotes theme", "Tema de MarkNotes") + $" ({patterns})|{patterns}";

    // ───────────────────────────── commands ─────────────────────────────

    private void Register()
    {
        // App
        OnAsync("app.init", async _ =>
        {
            if (!_migrationChecked)
            {
                _migrationChecked = true;
                var root = _store.Root;
                if (Migration.IsNeeded(root))
                {
                    _migration = await Task.Run(() => Migration.Run(root));
                    _store = new NoteStore(root);
                }
            }
            var workspaces = await Task.Run(() => _store.Scan());
            if (!AppPaths.IsTestProfile)
            {
                var settings = HostSettings.Load();
                var reg = settings["registerFileTypes"];
                bool wantReg = reg == null || reg.GetValue<bool>();
                if (wantReg && !FileAssociations.IsRegisteredHere())
                {
                    try { FileAssociations.Register(); } catch (Exception ex) { Log.Error("FileAssoc.Register", ex); }
                }
            }
            return new
            {
                version = Application.ProductVersion.Split('+')[0],
                settings = ReadJsonFile(AppPaths.SettingsFile) ?? new JsonObject(),
                state = ReadJsonFile(AppPaths.StateFile) ?? new JsonObject(),
                notesRoot = _store.Root,
                defaultNotesRoot = AppPaths.DefaultNotesRoot,
                configDir = AppPaths.ConfigDir,
                isTest = AppPaths.IsTestProfile,
                workspaces,
                migration = _migration,
                launchFiles = _form.LaunchFiles,
                speech = AsrService.Availability(),
            };
        });
        On("app.ready", _ =>
        {
            _form.UiReady();
            var ms = (DateTime.Now - System.Diagnostics.Process.GetCurrentProcess().StartTime).TotalMilliseconds;
            Log.Info($"UI ready {ms:0} ms after process start");
            return null;
        });
        OnBg("app.saveSettings", a =>
        {
            HostSettings.WriteJsonFile(AppPaths.SettingsFile, a.GetProperty("settings").GetRawText());
            return null;
        });
        OnBg("app.saveState", a =>
        {
            HostSettings.WriteJsonFile(AppPaths.StateFile, a.GetProperty("state").GetRawText());
            return null;
        });
        On("app.setTitle", a => { _form.Text = S(a, "title") ?? "MarkNotes"; return null; });
        On("app.setLanguage", a => { UiLang.Current = S(a, "lang") ?? "en"; return null; });
        On("app.setChrome", a =>
        {
            _form.ApplyChrome(HostSettings.ParseColor(S(a, "bg")), HostSettings.ParseColor(S(a, "text")));
            return null;
        });
        On("app.openExternal", a => { ShellUtil.OpenExternal(Req(a, "url")); return null; });
        On("app.reveal", a => { ShellUtil.Reveal(_store.Resolve(Req(a, "path"))); return null; });
        On("app.revealRoot", _ => { ShellUtil.Reveal(_store.Root); return null; });
        On("app.revealConfig", _ => { ShellUtil.Reveal(AppPaths.ConfigDir); return null; });
        On("app.closeReady", a => { _form.ConfirmClose(B(a, "cancel")); return null; });
        On("app.quit", _ => { _form.BeginInvoke(_form.Close); return null; });
        On("app.devtools", _ => { _core.OpenDevToolsWindow(); return null; });
        On("app.pickFolder", a =>
        {
            using var d = new FolderBrowserDialog { Description = S(a, "title") ?? UiLang.T("Choose a folder", "Elegí una carpeta"), UseDescriptionForTitle = true, ShowNewFolderButton = true };
            var init = S(a, "initial");
            if (init != null && Directory.Exists(init)) d.SelectedPath = init;
            return d.ShowDialog(_form) == DialogResult.OK ? d.SelectedPath : null;
        });
        OnAsync("app.setNotesRoot", async a =>
        {
            var path = Path.GetFullPath(Req(a, "path"));
            Directory.CreateDirectory(path);
            var store = new NoteStore(path);
            if (Migration.IsNeeded(path)) _migration = await Task.Run(() => Migration.Run(path));
            _store = store;
            return await Task.Run(() => _store.Scan());
        });
        On("app.fileAssoc", _ => FileAssociations.Status());
        On("app.registerFileTypes", _ => { FileAssociations.Register(); return FileAssociations.Status(); });
        On("app.chooseDefault", a => { FileAssociations.ShowOpenWith(_form.Handle, S(a, "ext") ?? ".md"); return FileAssociations.Status(); });
        On("app.defaultAppsSettings", _ => { FileAssociations.OpenDefaultAppsSettings(); return null; });

        // Workspaces
        OnBg("ws.list", _ => _store.Scan());
        OnBg("ws.get", a => _store.GetWorkspace(Req(a, "id")));
        OnBg("ws.create", a =>
        {
            byte[]? icon = null; string? ext = null;
            if (S(a, "icon") is string data && data.Length > 0) (icon, ext) = DataUrl(data);
            return _store.CreateWorkspace(Req(a, "name"), S(a, "color"), icon, ext, S(a, "firstFolder") ?? "General");
        });
        OnBg("ws.update", a =>
        {
            byte[]? icon = null; string? ext = null;
            if (S(a, "icon") is string data && data.Length > 0) (icon, ext) = DataUrl(data);
            var (ws, oldDir) = _store.UpdateWorkspace(Req(a, "id"), S(a, "name"), S(a, "color"), Has(a, "color"), icon, ext, B(a, "removeIcon"));
            return new { ws, oldDir };
        });
        OnBg("ws.banner", a =>
        {
            byte[]? data = null; string? ext = null;
            if (S(a, "data") is string d && d.Length > 0) (data, ext) = DataUrl(d);
            if (data != null && data.Length > 40 * 1024 * 1024)
                throw new InvalidOperationException(UiLang.T("That image is too large for a banner (over 40 MB).", "Esa imagen es demasiado grande para un banner (más de 40 MB)."));
            bool? hover = Has(a, "hover") ? B(a, "hover") : null;
            return _store.UpdateBanner(Req(a, "id"), data, ext, B(a, "remove"), hover);
        });
        OnBg("ws.guide", a => _store.GetGuide(Req(a, "id")));
        OnBg("ws.setGuide", a => { _store.SetGuide(Req(a, "id"), S(a, "text") ?? ""); return null; });
        OnBg("ws.features", a => _store.SetFeatures(Req(a, "id"), Has(a, "guide") ? B(a, "guide") : null, Has(a, "browse") ? B(a, "browse") : null));
        OnBg("ws.delete", a => { _store.DeleteWorkspace(Req(a, "id")); return null; });
        OnBg("ws.notes", a => _store.ListNotes(Req(a, "id"), !Has(a, "preview") || B(a, "preview")));
        OnBg("ws.files", a => _store.ListFiles(Req(a, "id")));
        On("ws.reveal", a => { ShellUtil.Reveal(_store.WorkspaceDir(Req(a, "id"))); return null; });
        OnAsync("ws.link", async a =>
        {
            var path = S(a, "path");
            if (path == null)
            {
                using var d = new FolderBrowserDialog
                {
                    Description = UiLang.T("Choose a folder to open as a workspace", "Elegí una carpeta para abrir como espacio de trabajo"),
                    UseDescriptionForTitle = true,
                    ShowNewFolderButton = false,
                };
                if (d.ShowDialog(_form) != DialogResult.OK) return null;
                path = d.SelectedPath;
            }
            var color = S(a, "color");
            return await Task.Run(() => _store.LinkFolder(path, color));
        });
        OnBg("ws.unlink", a => { _store.UnlinkFolder(Req(a, "id")); return null; });

        // Folders
        OnBg("folder.create", a => _store.CreateFolder(Req(a, "wsId"), Req(a, "name"), S(a, "parent")));
        OnBg("folder.rename", a =>
        {
            var (name, path, oldPrefix, newPrefix) = _store.RenameFolder(Req(a, "wsId"), Req(a, "name"), Req(a, "newName"));
            return new { name, path, oldPrefix, newPrefix };
        });
        OnBg("folder.delete", a => { _store.DeleteFolder(Req(a, "wsId"), Req(a, "name")); return null; });
        OnBg("folder.setMeta", a =>
        {
            _store.SetFolderMeta(Req(a, "wsId"), Req(a, "name"), S(a, "color"), S(a, "icon"), null, Has(a, "color"), Has(a, "icon"),
                S(a, "description"), Has(a, "description"));
            return null;
        });
        OnBg("folder.reorder", a => { _store.ReorderFolders(Req(a, "wsId"), Strs(a, "names")); return null; });
        OnBg("folder.move", a =>
        {
            var (path, oldPrefix, newPrefix) = _store.MoveFolder(Req(a, "wsId"), Req(a, "name"), S(a, "parent") ?? "");
            return new { path, oldPrefix, newPrefix };
        });
        On("folder.reveal", a =>
        {
            ShellUtil.Reveal(Path.Combine(_store.WorkspaceDir(Req(a, "wsId")), (S(a, "name") ?? "").Replace('/', '\\')));
            return null;
        });

        // Notes
        OnBg("note.read", a => _store.ReadNote(Req(a, "path")));
        OnBg("note.write", a => _store.WriteNote(Req(a, "path"), S(a, "text") ?? "", S(a, "encoding") ?? "utf8",
            S(a, "eol") ?? "crlf", L(a, "expectMtime"), B(a, "force")));
        OnBg("note.create", a => _store.CreateNote(Req(a, "wsId"), S(a, "folder") ?? "", S(a, "title"), S(a, "ext") ?? "md",
            S(a, "text") ?? "", !Has(a, "autoTitle") || B(a, "autoTitle")));
        OnBg("note.rename", a => _store.RenameNote(Req(a, "path"), Req(a, "title")));
        OnBg("note.move", a =>
        {
            var (note, textChanged) = _store.MoveNote(Req(a, "path"), Req(a, "wsId"), S(a, "folder") ?? "");
            return new { note, textChanged };
        });
        OnBg("note.copy", a => _store.CopyNote(Req(a, "path"), Req(a, "wsId"), S(a, "folder") ?? ""));
        // Spine models: the models of a folder (costumes, poses, names from fuentes.json).
        OnBg("spine.info", a => _store.SpineInfo(Req(a, "path")));
        // Snapshots and recordings: saved where the user picks.
        On("file.saveAs", a =>
        {
            var name = NoteStore.SanitizeName(S(a, "name") ?? "export", 120);
            var ext = Path.GetExtension(name).TrimStart('.').ToLowerInvariant();
            var filter = ext switch
            {
                "png" => UiLang.T("PNG image", "Imagen PNG") + " (*.png)|*.png",
                "webm" => UiLang.T("WebM video", "Video WebM") + " (*.webm)|*.webm",
                _ => UiLang.T("All files", "Todos los archivos") + " (*.*)|*.*",
            };
            var target = SaveDialog(UiLang.T("Save as", "Guardar como"), filter, name, ext.Length > 0 ? ext : null);
            if (target == null) return null;
            var data = Req(a, "data");
            var comma = data.IndexOf(',');
            File.WriteAllBytes(target, Convert.FromBase64String(data.StartsWith("data:") && comma >= 0 ? data[(comma + 1)..] : data));
            return target;
        });
        OnBg("folder.copy", a => new { path = _store.CopyFolder(Req(a, "wsId"), Req(a, "name"), S(a, "parent") ?? "") });
        OnBg("note.delete", a => { _store.DeleteNote(Req(a, "path")); return null; });
        OnBg("note.deleteIfEmpty", a => _store.DeleteIfEmpty(Req(a, "path")));
        OnBg("note.setMeta", a => _store.SetNoteMeta(Req(a, "path"), a.GetProperty("patch")));
        OnBg("note.stat", a => _store.Stat(Strs(a, "paths")));
        OnBg("note.resolveFiles", a => _store.ResolveFiles(Req(a, "path"), Strs(a, "files")));
        OnBg("canvas.paths", a => _store.CanvasPaths(Req(a, "path"), Strs(a, "paths")));

        // Link previews (title + thumbnail, fetched once per link and cached; the only online feature)
        OnAsync("link.preview", a => Links.GetAsync(Req(a, "url"), S(a, "doc") ?? ""));
        OnAsync("link.refresh", a => Links.RefreshAsync(Req(a, "url"), S(a, "doc") ?? ""));
        OnBg("link.sync", a => { Links.Sync(Req(a, "doc"), Strs(a, "urls")); return null; });
        OnBg("link.rename", a => { Links.Rename(Req(a, "from"), Req(a, "to")); return null; });
        // Only what is already on this PC (PDFs never fetch anything).
        OnBg("link.cached", a => Links.Cached(Req(a, "url")));
        On("app.setEmbeds", a => { EmbedsAllowed = B(a, "on"); return null; });
        OnBg("note.info", a => _store.NoteInfo(Req(a, "path")));
        OnBg("note.import", a => _store.ImportFiles(Strs(a, "paths"), Req(a, "wsId"), S(a, "folder") ?? ""));
        OnBg("note.append", a =>
        {
            var abs = _store.Resolve(Req(a, "path"));
            var t = TextFiles.Read(abs);
            TextFiles.Write(abs, t.Text + (S(a, "text") ?? ""), t.Encoding, t.Eol);
            return NoteStore.MtimeMs(abs);
        });
        On("note.openDialog", _ => OpenDialog(UiLang.T("Open", "Abrir"),
            UiLang.T("Notes and text", "Notas y texto") + " (*.md;*.markdown;*.txt)|*.md;*.markdown;*.txt|" + AllFiles, true));
        OnAsync("note.saveAs", async a =>
        {
            var name = S(a, "name") ?? UiLang.T("Note.md", "Nota.md");
            var ext = Path.GetExtension(name).TrimStart('.');
            var target = SaveDialog(UiLang.T("Save a copy as", "Guardar una copia como"),
                "Markdown (*.md)|*.md|" + UiLang.T("Text", "Texto") + " (*.txt)|*.txt|" + AllFiles, name, ext);
            if (target == null) return null;
            await Task.Run(() => TextFiles.Write(target, S(a, "text") ?? "", S(a, "encoding") ?? "utf8", S(a, "eol") ?? "crlf"));
            return target;
        });
        // Notes saved as PDF: the user picks the file, the UI lays the note out on a print-only page and WebView2
        // prints it (offline, with Edge's own engine). Only the file picked here is written.
        On("pdf.choose", a =>
        {
            var name = NoteStore.SanitizeName(S(a, "name") ?? UiLang.T("Note.pdf", "Nota.pdf"), 120);
            if (!name.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase)) name += ".pdf";
            // Automated tests of a scratch profile name the file instead of picking it.
            _pdfTarget = AppPaths.IsTestProfile && S(a, "path") is string test ? Path.GetFullPath(test)
                : SaveDialog(UiLang.T("Save as PDF", "Guardar como PDF"), "PDF (*.pdf)|*.pdf", name, "pdf", S(a, "dir"));
            return _pdfTarget;
        });
        OnAsync("pdf.print", async a =>
        {
            var target = _pdfTarget ?? throw new InvalidOperationException(UiLang.T("Choose where to save the PDF first.", "Primero elegí dónde guardar el PDF."));
            _pdfTarget = null;
            var pdf = await PrintPdfAsync(a);
            var tmp = target + ".tmp";
            try
            {
                await File.WriteAllBytesAsync(tmp, pdf);
                File.Move(tmp, target, true);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // A PDF open in a viewer that locks it, or a folder Windows protects.
                Log.Error("pdf.print", ex);
                throw new IOException(UiLang.T("The PDF could not be saved there. If it is open in another program, close it, or pick another folder.",
                    "No se pudo guardar el PDF ahí. Si está abierto en otro programa, cerralo, o elegí otra carpeta."));
            }
            finally
            {
                try { if (File.Exists(tmp)) File.Delete(tmp); } catch { }
            }
            _lastPdf = target;
            return target;
        });
        On("pdf.open", _ =>
        {
            if (_lastPdf != null && File.Exists(_lastPdf)) ShellUtil.OpenWithShell(_lastPdf);
            return null;
        });

        // Images
        OnBg("asset.save", a =>
        {
            var data = Req(a, "data");
            var (bytes, ext) = DataUrl(data);
            return _store.SaveAsset(Req(a, "notePath"), bytes, S(a, "ext") ?? ext, S(a, "name"));
        });
        OnBg("asset.import", a => _store.ImportFiles(Req(a, "notePath"), Strs(a, "paths")));
        OnBg("asset.rename", a => _store.RenameAsset(Req(a, "notePath"), Req(a, "link"), Req(a, "newName"), Strs(a, "openPaths"), B(a, "wiki")));
        OnBg("asset.delete", a => { _store.DeleteAsset(Req(a, "notePath"), Req(a, "link"), B(a, "wiki")); return null; });
        On("asset.reveal", a =>
        {
            var p = _store.ResolveLink(Req(a, "notePath"), Req(a, "link"), B(a, "wiki"));
            if (p != null) ShellUtil.Reveal(p);
            return null;
        });
        On("asset.open", a =>
        {
            var p = _store.ResolveLink(Req(a, "notePath"), Req(a, "link"), B(a, "wiki"));
            var ext = p == null ? "" : Path.GetExtension(p);
            // Pictures, videos, audio and PDFs of canvases open in their usual program; nothing else is started.
            if (p != null && (NoteStore.ImageExts.Contains(ext) || NoteStore.MediaExts.Contains(ext) || ext.Equals(".pdf", StringComparison.OrdinalIgnoreCase))) ShellUtil.OpenWithShell(p);
            return null;
        });
        On("asset.copy", a =>
        {
            var p = _store.ResolveLink(Req(a, "notePath"), Req(a, "link"), B(a, "wiki"));
            if (p == null || !File.Exists(p)) return false;
            using var img = Image.FromFile(p);
            Clipboard.SetImage(new Bitmap(img));
            return true;
        });
        // Canvas clipboard: a board has no text box for Ctrl+C / Ctrl+V to work in, so it uses the system
        // clipboard directly (on the UI thread, which the clipboard needs). Cards copied from a canvas travel
        // in their own format next to plain text, the files they show and, for one picture, the image itself.
        On("clipboard.read", _ => ClipboardRead());
        On("clipboard.writeCanvas", a =>
        {
            var data = new DataObject();
            data.SetData(CanvasClipFormat, new MemoryStream(System.Text.Encoding.UTF8.GetBytes(Req(a, "json"))));
            var text = S(a, "text") ?? "";
            if (text.Length > 0) data.SetText(text, TextDataFormat.UnicodeText);
            var files = new System.Collections.Specialized.StringCollection();
            foreach (var p in Strs(a, "files"))
            {
                try { var abs = _store.Resolve(p); if (File.Exists(abs)) files.Add(abs); } catch { }
            }
            if (files.Count > 0) data.SetFileDropList(files);
            if (files.Count == 1 && NoteStore.ImageExts.Contains(Path.GetExtension(files[0]!)) && !files[0]!.EndsWith(".svg", StringComparison.OrdinalIgnoreCase))
            {
                try { using var img = Image.FromFile(files[0]!); data.SetImage(new Bitmap(img)); } catch { }
            }
            Clipboard.SetDataObject(data, true, 5, 60);
            return null;
        });
        On("clipboard.saveImage", a =>
        {
            // A copied picture (screenshot, image copied in a browser) saved next to the canvas.
            if (!Clipboard.ContainsImage()) return null;
            using var img = Clipboard.GetImage();
            if (img == null) return null;
            using var ms = new MemoryStream();
            img.Save(ms, System.Drawing.Imaging.ImageFormat.Png);
            return _store.SaveAsset(Req(a, "notePath"), ms.ToArray(), "png", null);
        });
        OnBg("asset.url", a =>
        {
            var p = _store.ResolveLink(Req(a, "notePath"), Req(a, "link"), B(a, "wiki"));
            return p == null ? null : NoteStore.FileUrl(p, _store.Root);
        });

        // Search
        OnBg("search.query", a => _store.Search(S(a, "q") ?? "", S(a, "wsId"), (int)Math.Max(1, L(a, "limit") == 0 ? 200 : L(a, "limit"))));

        // Share / backup
        OnAsync("archive.exportWorkspace", async a =>
        {
            var wsId = Req(a, "wsId");
            var ws = await Task.Run(() => _store.GetWorkspace(wsId));
            var target = S(a, "path") ?? SaveDialog(UiLang.T("Export workspace", "Exportar espacio de trabajo"), PackFilter("*.mnpack"), NoteStore.SanitizeName(ws.Name) + ".mnpack", "mnpack");
            if (target == null) return null;
            var themes = ThemeFiles(a);
            await Task.Run(() => Archive.Export(_store, new[] { wsId }, target, "workspace", null, themes));
            return target;
        });
        OnAsync("archive.exportAll", async a =>
        {
            var target = S(a, "path") ?? SaveDialog(UiLang.T("Export everything", "Exportar todo"), PackFilter("*.mnpack"),
                UiLang.T("MarkNotes backup ", "Copia de seguridad de MarkNotes ") + DateTime.Now.ToString("yyyy-MM-dd") + ".mnpack", "mnpack");
            if (target == null) return null;
            var themes = ThemeFiles(a);
            var settings = S(a, "settings");
            var ids = await Task.Run(() => _store.Scan().Select(w => w.Id).ToList());
            await Task.Run(() => Archive.Export(_store, ids, target, "full", settings, themes));
            return target;
        });
        OnAsync("archive.import", async a =>
        {
            var file = S(a, "path") ?? OpenDialog(UiLang.T("Import", "Importar"), PackFilter("*.mnpack;*.zip"), false).FirstOrDefault();
            if (file == null) return null;
            return await Task.Run(() => Archive.Import(_store, file));
        });
        OnAsync("theme.export", async a =>
        {
            var name = S(a, "name") ?? UiLang.T("Theme", "Tema");
            var target = SaveDialog(UiLang.T("Export theme", "Exportar tema"), ThemeFilter("*.mntheme"), NoteStore.SanitizeName(name) + ".mntheme", "mntheme");
            if (target == null) return null;
            var json = Req(a, "json");
            await File.WriteAllTextAsync(target, json);
            return target;
        });
        OnAsync("theme.import", async _ =>
        {
            var files = OpenDialog(UiLang.T("Import theme", "Importar tema"), ThemeFilter("*.mntheme;*.json"), true);
            var list = new List<string>();
            foreach (var f in files)
            {
                if (new FileInfo(f).Length > 8 * 1024 * 1024) continue;
                list.Add(await File.ReadAllTextAsync(f));
            }
            return list;
        });

        // Phone sync: this PC answers paired phones on the home network (Sync/SyncServer.cs).
        OnBg("sync.status", _ => _sync.Status());
        OnBg("sync.setEnabled", a => { _sync.SetEnabled(B(a, "on")); return _sync.Status(); });
        On("sync.pairing", a => { _sync.SetPairing(B(a, "on")); return _sync.Status(); });
        On("sync.pairAnswer", a => { _sync.AnswerPair(Req(a, "id"), B(a, "allow")); return null; });
        OnBg("sync.unlink", a => { _sync.Unlink(Req(a, "id")); return _sync.Status(); });
        OnBg("sync.clearHistory", a => { _sync.ClearHistory(Req(a, "id")); return _sync.Status(); });

        // Transcription
        OnBg("asr.status", _ => _asr.Status());
        On("asr.download", a => { _asr.StartDownload(Req(a, "id")); return null; });
        On("asr.cancelDownload", a => { _asr.CancelDownload(Req(a, "id")); return null; });
        OnBg("asr.deleteModel", a => { _asr.DeleteModel(Req(a, "id")); return null; });
        OnAsync("asr.importModel", async a =>
        {
            var file = OpenDialog(UiLang.T("Choose a whisper.cpp model (ggml .bin)", "Elegí un modelo de whisper.cpp (ggml .bin)"),
                UiLang.T("Whisper model", "Modelo de Whisper") + " (*.bin)|*.bin", false).FirstOrDefault();
            if (file == null) return false;
            await Task.Run(() => _asr.ImportModel(Req(a, "id"), file));
            return true;
        });
        OnAsync("asr.start", async a =>
        {
            var o = JsonSerializer.Deserialize<AsrStartOptions>(a.GetRawText(), JsonOpts.Web) ?? new AsrStartOptions();
            await _asr.StartAsync(o);
            return new { backend = _asr.Backend };
        });
        OnAsync("asr.stop", async _ => { await _asr.StopAsync(); return null; });
        OnAsync("asr.transcribeFile", async a =>
        {
            var file = S(a, "path") ?? OpenDialog(UiLang.T("Transcribe an audio or video file", "Transcribir un archivo de audio o video"),
                UiLang.T("Audio and video", "Audio y video") + " (*.mp3;*.m4a;*.wav;*.wma;*.aac;*.flac;*.mp4;*.mov;*.m4v;*.webm;*.ogg)|*.mp3;*.m4a;*.wav;*.wma;*.aac;*.flac;*.mp4;*.mov;*.m4v;*.webm;*.ogg|" + AllFiles, false).FirstOrDefault();
            if (file == null) return null;
            var o = JsonSerializer.Deserialize<AsrStartOptions>(a.GetRawText(), JsonOpts.Web) ?? new AsrStartOptions();
            return await _asr.TranscribeFileAsync(file, o);
        });
    }

    private static List<Archive.ThemeFile> ThemeFiles(JsonElement a)
    {
        var list = new List<Archive.ThemeFile>();
        if (a.ValueKind == JsonValueKind.Object && a.TryGetProperty("themes", out var t) && t.ValueKind == JsonValueKind.Array)
            foreach (var x in t.EnumerateArray())
                list.Add(new Archive.ThemeFile(S(x, "name") ?? UiLang.T("Theme", "Tema"), S(x, "json") ?? "{}"));
        return list;
    }
}

using System.Runtime.InteropServices;
using System.Text.Json;
using MarkNotes.Shell;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace MarkNotes;

/// <summary>
/// A normal, fully resizable Windows window hosting the web UI in WebView2 (the Edge engine
/// that ships with Windows — nothing heavy is bundled, so it opens fast).
/// </summary>
public sealed class MainForm : Form
{
    public const string AppHost = "app.marknotes.example";

    private readonly AppOptions _opts;
    private readonly WebView2 _web;
    private Bridge? _bridge;
    private bool _closeConfirmed;
    private bool _closeRequested;
    private System.Windows.Forms.Timer? _closeFallback;
    private readonly List<string> _pendingFiles = new();
    private bool _uiReady;

    public CoreWebView2? Core => _web.CoreWebView2;
    public IReadOnlyList<string> LaunchFiles => _opts.Files;
    /// <summary>Phone sync port: --sync-port, else 47830 (47930 in test profiles, so a test copy never takes the installed app's port).</summary>
    public int SyncPort => _opts.SyncPort > 0 ? _opts.SyncPort : AppPaths.IsTestProfile ? Sync.Proto.TestPort : Sync.Proto.DefaultPort;
    /// <summary>Test profiles keep phone sync on this PC (127.0.0.1) unless started with --sync-lan.</summary>
    public bool SyncLan => !AppPaths.IsTestProfile || _opts.SyncLan;

    public MainForm(AppOptions opts)
    {
        _opts = opts;
        Text = "MarkNotes";
        Icon = LoadIcon();
        AutoScaleMode = AutoScaleMode.Dpi;
        MinimumSize = new Size(520, 360);
        StartPosition = FormStartPosition.Manual;
        KeyPreview = false;

        var (bg, _) = HostSettings.ChromeColors();
        var back = bg ?? Color.FromArgb(0x31, 0x33, 0x38);
        BackColor = back;
        RestoreBounds_();

        _web = new WebView2
        {
            Dock = DockStyle.Fill,
            DefaultBackgroundColor = back,
            AllowExternalDrop = true,
        };
        Controls.Add(_web);
        Load += async (_, _) => await InitWebAsync();
    }

    private static Icon LoadIcon()
    {
        try
        {
            using var s = typeof(MainForm).Assembly.GetManifestResourceStream("app.ico");
            if (s != null) return new Icon(s);
        }
        catch { }
        return SystemIcons.Application;
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        var (bg, text) = HostSettings.ChromeColors();
        WindowChrome.Apply(Handle, bg ?? Color.FromArgb(0x1e, 0x1f, 0x22), text ?? Color.FromArgb(0xdb, 0xde, 0xe1));
    }

    public void ApplyChrome(Color? bg, Color? text)
    {
        if (bg is Color b)
        {
            BackColor = b;
            if (_web.CoreWebView2 != null) _web.DefaultBackgroundColor = b;
        }
        WindowChrome.Apply(Handle, bg, text);
    }

    private async Task InitWebAsync()
    {
        try
        {
            var args = "--disable-background-networking --disable-component-update --disable-domain-reliability --disable-sync " +
                       "--disable-features=msSmartScreenProtection,msEdgeTranslate,msWebOOUI,msPdfOOUI,ElasticOverscroll";
            if (_opts.DebugPort > 0) args += $" --remote-debugging-port={_opts.DebugPort} --remote-allow-origins=*";
            var envOptions = new CoreWebView2EnvironmentOptions(args)
            {
                AllowSingleSignOnUsingOSPrimaryAccount = false,
            };
            var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(AppPaths.LocalDir, "WebView2"), envOptions);
            await _web.EnsureCoreWebView2Async(env);
            var core = _web.CoreWebView2;

            var s = core.Settings;
            s.AreDevToolsEnabled = _opts.DebugPort > 0 || Environment.GetEnvironmentVariable("MARKNOTES_DEVTOOLS") == "1";
            s.AreDefaultContextMenusEnabled = false;
            s.IsZoomControlEnabled = false;
            s.IsStatusBarEnabled = false;
            s.AreBrowserAcceleratorKeysEnabled = _opts.DebugPort > 0;
            s.IsPasswordAutosaveEnabled = false;
            s.IsGeneralAutofillEnabled = false;
            s.IsSwipeNavigationEnabled = false;
            s.IsPinchZoomEnabled = false;
            s.AreHostObjectsAllowed = false;
            s.IsWebMessageEnabled = true;

            core.SetVirtualHostNameToFolderMapping(AppHost, AppPaths.WebDir, CoreWebView2HostResourceAccessKind.DenyCors);
            core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += (_, e) => OnResource(env, e);
            core.NavigationStarting += (_, e) =>
            {
                if (!e.Uri.StartsWith($"https://{AppHost}/", StringComparison.OrdinalIgnoreCase))
                {
                    e.Cancel = true;
                    ShellUtil.OpenExternal(e.Uri);
                }
            };
            core.NewWindowRequested += (_, e) =>
            {
                e.Handled = true;
                ShellUtil.OpenExternal(e.Uri);
            };
            core.PermissionRequested += (_, e) =>
            {
                e.State = e.PermissionKind == CoreWebView2PermissionKind.ClipboardRead
                    ? CoreWebView2PermissionState.Allow
                    : CoreWebView2PermissionState.Deny;
            };
            // A video's full-screen button fills the screen, not just the window.
            core.ContainsFullScreenElementChanged += (_, _) => SetFullScreen(core.ContainsFullScreenElement);
            core.DocumentTitleChanged += (_, _) => { };
            core.ProcessFailed += (_, e) => Log.Info("WebView2 process failed: " + e.ProcessFailedKind);

            _bridge = new Bridge(this, core);
            core.WebMessageReceived += _bridge.OnMessage;
            core.Navigate($"https://{AppHost}/index.html");
        }
        catch (Exception ex)
        {
            Log.Error("InitWebAsync", ex);
            MessageBox.Show(this,
                UiLang.T("MarkNotes needs the Microsoft Edge WebView2 Runtime, which is part of Windows 11.\n\n",
                    "MarkNotes necesita Microsoft Edge WebView2 Runtime, que viene con Windows 11.\n\n") + ex.Message,
                "MarkNotes", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }

    /// <summary>
    /// Serves local images to the UI (files.marknotes.example) and blocks everything that
    /// would leave the computer: the app works fully offline.
    /// </summary>
    private void OnResource(CoreWebView2Environment env, CoreWebView2WebResourceRequestedEventArgs e)
    {
        try
        {
            var uri = new Uri(e.Request.Uri);
            if (uri.Host.Equals(AppHost, StringComparison.OrdinalIgnoreCase)) return; // folder mapping handles it
            if (uri.Scheme is "data" or "blob") return;
            if (uri.Host.Equals(Storage.NoteStore.FilesHost, StringComparison.OrdinalIgnoreCase) && _bridge != null)
            {
                var path = _bridge.ResolveFileUrl(uri);
                var ext = path == null ? "" : Path.GetExtension(path);
                if (path != null && File.Exists(path) && MediaTypes.ContainsKey(ext.ToLowerInvariant()))
                {
                    e.Response = MediaResponse(env, path, e.Request.Headers.Contains("Range") ? e.Request.Headers.GetHeader("Range") : null);
                    return;
                }
                if (path != null && File.Exists(path) && SpineTypes.TryGetValue(ext.ToLowerInvariant(), out var spineType))
                {
                    // Spine models (skeleton + atlas; their textures are images): read by the WebGL player.
                    var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                    e.Response = env.CreateWebResourceResponse(fs, 200, "OK", $"Content-Type: {spineType}\r\nCache-Control: no-cache\r\nAccess-Control-Allow-Origin: *");
                    return;
                }
                if (path == null || !File.Exists(path) || !Storage.NoteStore.ImageExts.Contains(ext))
                {
                    e.Response = env.CreateWebResourceResponse(null, 404, "Not Found", "");
                    return;
                }
                var q = System.Web.HttpUtility.ParseQueryString(uri.Query);
                if (int.TryParse(q["w"], out var width) && width > 0)
                {
                    // Card covers: answer with a cached small copy, made off the UI thread.
                    var deferral = e.GetDeferral();
                    _ = Task.Run(async () =>
                    {
                        string file = path;
                        try { file = await Storage.Thumbs.GetAsync(path, width); } catch (Exception ex) { Log.Error("Thumb", ex); }
                        BeginInvoke(() =>
                        {
                            try { e.Response = ImageResponse(env, file, true); }
                            catch (Exception ex) { Log.Error("ThumbResponse", ex); }
                            finally { deferral.Complete(); }
                        });
                    });
                    return;
                }
                e.Response = ImageResponse(env, path, false);
                return;
            }
            // Web videos played inside notes and canvases (YouTube player, X videos) when the user allows it.
            if (_bridge != null && _bridge.EmbedsAllowed && IsEmbedHost(uri.Host)) return;
            if (_blockedLogged.Add(uri.Host)) Log.Info("Blocked request to " + uri.Host);
            e.Response = env.CreateWebResourceResponse(null, 403, "Offline", "");
        }
        catch (Exception ex)
        {
            Log.Error("OnResource", ex);
            e.Response = env.CreateWebResourceResponse(null, 500, "Error", "");
        }
    }

    private readonly HashSet<string> _blockedLogged = new(StringComparer.OrdinalIgnoreCase);

    // Only what the YouTube privacy-mode player and X videos need; everything else stays offline.
    private static readonly string[] EmbedHosts =
    {
        "youtube-nocookie.com", "youtube.com", "ytimg.com", "googlevideo.com", "ggpht.com", "gstatic.com",
        "googleapis.com", "google.com", "video.twimg.com",
    };

    private static bool IsEmbedHost(string host) =>
        EmbedHosts.Any(h => host.Equals(h, StringComparison.OrdinalIgnoreCase) || host.EndsWith("." + h, StringComparison.OrdinalIgnoreCase));

    private static readonly Dictionary<string, string> SpineTypes = new()
    {
        [".skel"] = "application/octet-stream", [".atlas"] = "text/plain; charset=utf-8",
    };

    private static readonly Dictionary<string, string> MediaTypes = new()
    {
        [".mp4"] = "video/mp4", [".m4v"] = "video/mp4", [".webm"] = "video/webm", [".mov"] = "video/quicktime", [".ogv"] = "video/ogg",
        [".mp3"] = "audio/mpeg", [".m4a"] = "audio/mp4", [".wav"] = "audio/wav", [".ogg"] = "audio/ogg", [".flac"] = "audio/flac",
    };

    /// <summary>
    /// Local video/audio for canvases, with Range support so the player can seek. Readable by the page (CORS)
    /// so the sound can go through the app's video volume.
    /// </summary>
    private static CoreWebView2WebResourceResponse MediaResponse(CoreWebView2Environment env, string path, string? range)
    {
        var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        long len = fs.Length;
        var mime = MediaTypes[Path.GetExtension(path).ToLowerInvariant()];
        var m = range == null ? null : System.Text.RegularExpressions.Regex.Match(range, @"bytes=(\d*)-(\d*)");
        if (m == null || !m.Success || len == 0)
            return env.CreateWebResourceResponse(fs, 200, "OK", $"Content-Type: {mime}\r\nContent-Length: {len}\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *");
        long start = m.Groups[1].Value.Length > 0 ? long.Parse(m.Groups[1].Value) : Math.Max(0, len - long.Parse(m.Groups[2].Value));
        long end = m.Groups[1].Value.Length > 0 && m.Groups[2].Value.Length > 0 ? long.Parse(m.Groups[2].Value) : len - 1;
        end = Math.Min(end, Math.Min(len - 1, start + 8 * 1024 * 1024 - 1)); // at most 8 MB per answer
        if (start >= len) { fs.Dispose(); return env.CreateWebResourceResponse(null, 416, "Range Not Satisfiable", $"Content-Range: bytes */{len}"); }
        var buf = new byte[end - start + 1];
        fs.Seek(start, SeekOrigin.Begin);
        int read = 0;
        while (read < buf.Length) { int n = fs.Read(buf, read, buf.Length - read); if (n <= 0) break; read += n; }
        fs.Dispose();
        return env.CreateWebResourceResponse(new MemoryStream(buf, 0, read), 206, "Partial Content",
            $"Content-Type: {mime}\r\nContent-Length: {read}\r\nContent-Range: bytes {start}-{start + read - 1}/{len}\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *");
    }

    private static CoreWebView2WebResourceResponse ImageResponse(CoreWebView2Environment env, string path, bool cacheable)
    {
        var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        var mime = Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".png" => "image/png", ".jpg" or ".jpeg" => "image/jpeg", ".gif" => "image/gif",
            ".webp" => "image/webp", ".svg" => "image/svg+xml", ".bmp" => "image/bmp",
            ".avif" => "image/avif", ".ico" => "image/x-icon", _ => "application/octet-stream",
        };
        return env.CreateWebResourceResponse(stream, 200, "OK",
            $"Content-Type: {mime}\r\nCache-Control: {(cacheable ? "max-age=86400" : "no-cache")}\r\nAccess-Control-Allow-Origin: *");
    }

    // ───────────────────────────── files from Explorer ─────────────────────────────

    public void UiReady()
    {
        _uiReady = true;
        if (_pendingFiles.Count > 0)
        {
            _bridge?.Emit("app.openFiles", new { files = _pendingFiles.ToArray() });
            _pendingFiles.Clear();
        }
    }

    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);

    public void ActivateFromOtherInstance(List<string> files)
    {
        if (WindowState == FormWindowState.Minimized) WindowState = _wasMaximized ? FormWindowState.Maximized : FormWindowState.Normal;
        Show();
        Activate();
        SetForegroundWindow(Handle);
        if (files.Count == 0) return;
        if (_uiReady) _bridge?.Emit("app.openFiles", new { files });
        else _pendingFiles.AddRange(files);
    }

    private bool _wasMaximized;

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        if (WindowState != FormWindowState.Minimized) _wasMaximized = WindowState == FormWindowState.Maximized;
    }

    protected override void OnActivated(EventArgs e)
    {
        base.OnActivated(e);
        if (_uiReady) _bridge?.Emit("app.focus", null);
    }

    // ───────────────────────────── closing ─────────────────────────────

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (!_closeConfirmed && _uiReady && _bridge != null)
        {
            // Let the UI write any pending edits first (also when Task Manager, an installer
            // or Windows asks the app to close).
            e.Cancel = true;
            if (_closeRequested) return;
            _closeRequested = true;
            _bridge.Emit("app.beforeClose", new { reason = e.CloseReason.ToString() });
            bool hurry = e.CloseReason is CloseReason.WindowsShutDown or CloseReason.TaskManagerClosing;
            _closeFallback = new System.Windows.Forms.Timer { Interval = hurry ? 2500 : 6000 };
            _closeFallback.Tick += (_, _) => { _closeFallback.Stop(); ConfirmClose(); };
            _closeFallback.Start();
            return;
        }
        SaveBounds();
        _bridge?.Dispose();
        base.OnFormClosing(e);
    }

    /// <summary>The UI flushed its saves (or decided to stay open).</summary>
    public void ConfirmClose(bool cancel = false)
    {
        _closeFallback?.Stop();
        _closeRequested = false;
        if (cancel) return;
        _closeConfirmed = true;
        BeginInvoke(Close);
    }

    // ───────────────────────────── window position ─────────────────────────────

    private sealed class WinBounds
    {
        public int X { get; set; }
        public int Y { get; set; }
        public int W { get; set; }
        public int H { get; set; }
        public bool Max { get; set; }
    }

    private void RestoreBounds_()
    {
        var wa = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1280, 800);
        var def = new Rectangle(wa.X + wa.Width / 10, wa.Y + wa.Height / 12, Math.Min(1280, wa.Width * 8 / 10), Math.Min(820, wa.Height * 10 / 12));
        Rectangle r = def;
        bool max = false;
        try
        {
            if (File.Exists(AppPaths.WindowFile))
            {
                var b = JsonSerializer.Deserialize<WinBounds>(File.ReadAllText(AppPaths.WindowFile), JsonOpts.Web);
                if (b != null && b.W >= 400 && b.H >= 300)
                {
                    var cand = new Rectangle(b.X, b.Y, b.W, b.H);
                    if (Screen.AllScreens.Any(sc => sc.WorkingArea.IntersectsWith(cand) &&
                                                    Rectangle.Intersect(sc.WorkingArea, cand).Width > 120 &&
                                                    Rectangle.Intersect(sc.WorkingArea, cand).Height > 80))
                        r = cand;
                    max = b.Max;
                }
            }
        }
        catch (Exception ex) { Log.Error("RestoreBounds", ex); }
        Bounds = r;
        if (max) WindowState = FormWindowState.Maximized;
    }

    private bool _fullScreen;
    private FormWindowState _preFullState;
    private Rectangle _preFullBounds;

    private void SetFullScreen(bool on)
    {
        if (on == _fullScreen) return;
        _fullScreen = on;
        if (on)
        {
            _preFullState = WindowState;
            _preFullBounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            if (WindowState == FormWindowState.Maximized) WindowState = FormWindowState.Normal;
            FormBorderStyle = FormBorderStyle.None;
            Bounds = Screen.FromControl(this).Bounds;
        }
        else
        {
            FormBorderStyle = FormBorderStyle.Sizable;
            Bounds = _preFullBounds;
            if (_preFullState == FormWindowState.Maximized) WindowState = FormWindowState.Maximized;
        }
    }

    private void SaveBounds()
    {
        try
        {
            if (_fullScreen) SetFullScreen(false);
            var r = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            var b = new WinBounds { X = r.X, Y = r.Y, W = r.Width, H = r.Height, Max = WindowState == FormWindowState.Maximized };
            HostSettings.WriteJsonFile(AppPaths.WindowFile, JsonSerializer.Serialize(b, JsonOpts.Web));
        }
        catch (Exception ex) { Log.Error("SaveBounds", ex); }
    }
}

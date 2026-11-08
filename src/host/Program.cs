using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace MarkNotes;

/// <summary>Command line / environment options.</summary>
public sealed class AppOptions
{
    /// <summary>Alternative root for settings, state and (by default) notes. Used for testing.</summary>
    public string? DataDir { get; set; }
    /// <summary>Alternative folder for the web UI (dev builds).</summary>
    public string? WebDir { get; set; }
    /// <summary>When &gt; 0, WebView2 exposes the Chrome DevTools protocol on this port.</summary>
    public int DebugPort { get; set; }
    /// <summary>Phone sync TCP port (UDP discovery = port + 1). 0 = the default (47830; 47930 in test profiles).</summary>
    public int SyncPort { get; set; }
    /// <summary>Test profiles: let phones on the network reach the sync port (normally 127.0.0.1 only).</summary>
    public bool SyncLan { get; set; }
    public List<string> Files { get; } = new();

    public static AppOptions Parse(string[] args)
    {
        var o = new AppOptions
        {
            DataDir = Environment.GetEnvironmentVariable("MARKNOTES_DATA_DIR"),
            WebDir = Environment.GetEnvironmentVariable("MARKNOTES_WEB_DIR"),
        };
        if (int.TryParse(Environment.GetEnvironmentVariable("MARKNOTES_DEBUG_PORT"), out var p)) o.DebugPort = p;
        foreach (var a in args)
        {
            if (a.StartsWith("--data-dir=", StringComparison.OrdinalIgnoreCase)) o.DataDir = a[11..].Trim('"');
            else if (a.StartsWith("--web-dir=", StringComparison.OrdinalIgnoreCase)) o.WebDir = a[10..].Trim('"');
            else if (a.StartsWith("--debug-port=", StringComparison.OrdinalIgnoreCase) && int.TryParse(a[13..], out var dp)) o.DebugPort = dp;
            else if (a.StartsWith("--sync-port=", StringComparison.OrdinalIgnoreCase) && int.TryParse(a[12..], out var sp) && sp > 0 && sp < 65535) o.SyncPort = sp;
            else if (a.Equals("--sync-lan", StringComparison.OrdinalIgnoreCase)) o.SyncLan = true;
            else if (a.StartsWith("--")) continue;
            else if (a.Length > 0) o.Files.Add(Path.GetFullPath(a));
        }
        return o;
    }
}

internal static class Program
{
    [DllImport("user32.dll")] private static extern bool AllowSetForegroundWindow(int dwProcessId);
    private const int ASFW_ANY = -1;

    [STAThread]
    private static int Main(string[] args)
    {
        var opts = AppOptions.Parse(args);
        AppPaths.Init(opts);
        Log.Info($"Start {string.Join(' ', args)}");

        var instanceKey = InstanceKey();
        using var mutex = new Mutex(true, "Local\\MarkNotes." + instanceKey, out bool firstInstance);
        if (!firstInstance)
        {
            // Hand the files to the running window and quit.
            AllowSetForegroundWindow(ASFW_ANY);
            if (SingleInstance.TrySend(instanceKey, opts.Files)) return 0;
            Log.Info("Could not reach the running instance; starting a new one.");
        }

        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (_, e) => Log.Error("UI thread", e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Log.Error("Unhandled", e.ExceptionObject as Exception);
        TaskScheduler.UnobservedTaskException += (_, e) => { Log.Error("Task", e.Exception); e.SetObserved(); };

        ApplicationConfiguration.Initialize();
        var form = new MainForm(opts);
        if (firstInstance) SingleInstance.StartServer(instanceKey, form);
        Application.Run(form);
        return 0;
    }

    private static string InstanceKey()
    {
        var basis = (AppPaths.ConfigDir + "|" + Environment.UserName).ToLowerInvariant();
        uint h = 2166136261;
        foreach (var c in basis) { h ^= c; h *= 16777619; }
        return h.ToString("x8");
    }
}

/// <summary>Named-pipe channel used so double-clicking a file reuses the open window.</summary>
internal static class SingleInstance
{
    private static string PipeName(string key) => "MarkNotes.Pipe." + key;

    public static bool TrySend(string key, List<string> files)
    {
        try
        {
            using var client = new NamedPipeClientStream(".", PipeName(key), PipeDirection.Out);
            client.Connect(1500);
            var payload = JsonSerializer.Serialize(files);
            var bytes = Encoding.UTF8.GetBytes(payload);
            client.Write(bytes, 0, bytes.Length);
            client.Flush();
            return true;
        }
        catch (Exception ex)
        {
            Log.Error("SingleInstance.TrySend", ex);
            return false;
        }
    }

    public static void StartServer(string key, MainForm form)
    {
        var t = new Thread(() =>
        {
            while (true)
            {
                try
                {
                    using var server = new NamedPipeServerStream(PipeName(key), PipeDirection.In, 1,
                        PipeTransmissionMode.Byte, PipeOptions.None);
                    server.WaitForConnection();
                    using var ms = new MemoryStream();
                    server.CopyTo(ms);
                    var files = JsonSerializer.Deserialize<List<string>>(Encoding.UTF8.GetString(ms.ToArray())) ?? new();
                    if (form.IsHandleCreated)
                        form.BeginInvoke(() => form.ActivateFromOtherInstance(files));
                }
                catch (Exception ex)
                {
                    Log.Error("SingleInstance.Server", ex);
                    Thread.Sleep(500);
                }
            }
        })
        { IsBackground = true, Name = "MarkNotes.Pipe" };
        t.Start();
    }
}

internal static class Log
{
    private static readonly object Gate = new();

    private static string FilePath => Path.Combine(AppPaths.LocalDir, "logs", "marknotes.log");

    public static void Info(string msg) => Write("INFO", msg);
    public static void Error(string where, Exception? ex) => Write("ERROR", where + ": " + ex);

    private static void Write(string level, string msg)
    {
        try
        {
            lock (Gate)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
                var fi = new FileInfo(FilePath);
                if (fi.Exists && fi.Length > 2_000_000) fi.Delete();
                File.AppendAllText(FilePath, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} [{level}] {msg}{Environment.NewLine}");
            }
        }
        catch { /* logging must never crash the app */ }
    }
}

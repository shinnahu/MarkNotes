using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace MarkNotes.Shell;

/// <summary>Registers MarkNotes for .md/.txt (per user, no admin rights needed).</summary>
public static class FileAssociations
{
    private const string AppName = "MarkNotes";
    private static readonly (string Ext, string ProgId, string Desc)[] Types =
    {
        (".md", "MarkNotes.md", "Markdown note"),
        (".markdown", "MarkNotes.md", "Markdown note"),
        (".txt", "MarkNotes.txt", "Text document"),
    };

    [DllImport("shell32.dll")]
    private static extern void SHChangeNotify(int wEventId, uint uFlags, IntPtr dwItem1, IntPtr dwItem2);

    public static string ExePath => Environment.ProcessPath ?? Path.Combine(AppPaths.ExeDir, "MarkNotes.exe");

    private static string DocIcon
    {
        get
        {
            var ico = Path.Combine(AppPaths.ExeDir, "icons", "note.ico");
            return File.Exists(ico) ? $"\"{ico}\"" : $"\"{ExePath}\",0";
        }
    }

    /// <summary>True when the registry already points at this exe.</summary>
    public static bool IsRegisteredHere()
    {
        using var k = Registry.CurrentUser.OpenSubKey(@"Software\Classes\MarkNotes.md\shell\open\command");
        var v = k?.GetValue("") as string;
        return v != null && v.Contains(ExePath, StringComparison.OrdinalIgnoreCase);
    }

    public static void Register()
    {
        var exe = ExePath;
        var open = $"\"{exe}\" \"%1\"";
        using (var classes = Registry.CurrentUser.CreateSubKey(@"Software\Classes"))
        {
            foreach (var g in Types.GroupBy(t => t.ProgId))
            {
                using var p = classes.CreateSubKey(g.Key);
                p.SetValue("", g.First().Desc);
                p.SetValue("FriendlyTypeName", g.First().Desc);
                using (var di = p.CreateSubKey("DefaultIcon")) di.SetValue("", DocIcon);
                using (var sh = p.CreateSubKey(@"shell\open")) sh.SetValue("FriendlyAppName", AppName);
                using (var cmd = p.CreateSubKey(@"shell\open\command")) cmd.SetValue("", open);
            }
            foreach (var t in Types)
            {
                using var ext = classes.CreateSubKey(t.Ext);
                using (var owp = ext.CreateSubKey("OpenWithProgids")) owp.SetValue(t.ProgId, Array.Empty<byte>(), RegistryValueKind.None);
                // Only claim the extension when nothing else owns it; otherwise Windows asks the user.
                var current = ext.GetValue("") as string;
                if (string.IsNullOrEmpty(current) && t.Ext != ".txt" && !MachineHasDefault(t.Ext)) ext.SetValue("", t.ProgId);
            }
            using (var app = classes.CreateSubKey(@"Applications\MarkNotes.exe"))
            {
                app.SetValue("FriendlyAppName", AppName);
                using (var di = app.CreateSubKey("DefaultIcon")) di.SetValue("", $"\"{exe}\",0");
                using (var cmd = app.CreateSubKey(@"shell\open\command")) cmd.SetValue("", open);
                using var st = app.CreateSubKey("SupportedTypes");
                foreach (var t in Types) st.SetValue(t.Ext, "");
            }
        }
        using (var caps = Registry.CurrentUser.CreateSubKey(@"Software\MarkNotes\Capabilities"))
        {
            caps.SetValue("ApplicationName", AppName);
            caps.SetValue("ApplicationDescription", "Notes and code notepad");
            caps.SetValue("ApplicationIcon", $"\"{exe}\",0");
            using var fa = caps.CreateSubKey("FileAssociations");
            foreach (var t in Types) fa.SetValue(t.Ext, t.ProgId);
        }
        using (var reg = Registry.CurrentUser.CreateSubKey(@"Software\RegisteredApplications"))
            reg.SetValue(AppName, @"Software\MarkNotes\Capabilities");

        SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero); // SHCNE_ASSOCCHANGED
    }

    private static bool MachineHasDefault(string ext)
    {
        using var k = Registry.ClassesRoot.OpenSubKey(ext);
        return !string.IsNullOrEmpty(k?.GetValue("") as string);
    }

    /// <summary>Which program Windows currently uses for an extension (the user's choice wins).</summary>
    public static string? CurrentHandler(string ext)
    {
        using var uc = Registry.CurrentUser.OpenSubKey($@"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\{ext}\UserChoice");
        var progId = uc?.GetValue("ProgId") as string;
        if (!string.IsNullOrEmpty(progId)) return progId;
        using var k = Registry.ClassesRoot.OpenSubKey(ext);
        return k?.GetValue("") as string;
    }

    public static object Status() => new
    {
        registered = IsRegisteredHere(),
        md = CurrentHandler(".md"),
        txt = CurrentHandler(".txt"),
        mdIsDefault = (CurrentHandler(".md") ?? "").StartsWith("MarkNotes", StringComparison.OrdinalIgnoreCase) ||
                      (CurrentHandler(".md") ?? "").Contains("MarkNotes.exe", StringComparison.OrdinalIgnoreCase),
        txtIsDefault = (CurrentHandler(".txt") ?? "").StartsWith("MarkNotes", StringComparison.OrdinalIgnoreCase) ||
                       (CurrentHandler(".txt") ?? "").Contains("MarkNotes.exe", StringComparison.OrdinalIgnoreCase),
    };

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct OPENASINFO
    {
        public string pcszFile;
        public string? pcszClass;
        public int oaifInFlags;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHOpenWithDialog(IntPtr hwndParent, ref OPENASINFO oOAI);

    /// <summary>
    /// Shows Windows' own "How do you want to open .xx files?" picker, where the user can
    /// tick "Always use this app". Programs are not allowed to set themselves as default.
    /// </summary>
    public static void ShowOpenWith(IntPtr owner, string ext)
    {
        Register();
        var sample = Path.Combine(Path.GetTempPath(), "MarkNotes sample" + ext);
        if (!File.Exists(sample)) File.WriteAllText(sample, "MarkNotes\r\n");
        var info = new OPENASINFO
        {
            pcszFile = sample,
            pcszClass = null,
            oaifInFlags = 0x1 | 0x4 | 0x20, // ALLOW_REGISTRATION | REGISTER_EXT | HIDE_REGISTRATION
        };
        int hr = SHOpenWithDialog(owner, ref info);
        if (hr != 0 && hr != unchecked((int)0x800704C7)) // cancelled
            OpenDefaultAppsSettings();
    }

    public static void OpenDefaultAppsSettings()
    {
        try { Process.Start(new ProcessStartInfo("ms-settings:defaultapps?registeredAppUser=MarkNotes") { UseShellExecute = true }); }
        catch { Process.Start(new ProcessStartInfo("ms-settings:defaultapps") { UseShellExecute = true }); }
    }
}

public static class ShellUtil
{
    public static void OpenExternal(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var u)) return;
        if (u.Scheme is not ("http" or "https" or "mailto")) return;
        Process.Start(new ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true });
    }

    public static void Reveal(string path)
    {
        if (File.Exists(path)) Process.Start("explorer.exe", $"/select,\"{path}\"");
        else if (Directory.Exists(path)) Process.Start("explorer.exe", $"\"{path}\"");
    }

    public static void OpenWithShell(string path)
    {
        if (File.Exists(path) || Directory.Exists(path))
            Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
    }
}

/// <summary>Colours the native Windows 11 title bar to match the theme.</summary>
public static class WindowChrome
{
    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    private const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
    private const int DWMWA_BORDER_COLOR = 34;
    private const int DWMWA_CAPTION_COLOR = 35;
    private const int DWMWA_TEXT_COLOR = 36;

    private static int ColorRef(Color c) => c.R | (c.G << 8) | (c.B << 16);

    public static void Apply(IntPtr hwnd, Color? bg, Color? text)
    {
        if (hwnd == IntPtr.Zero) return;
        try
        {
            if (bg is Color b)
            {
                int dark = (0.299 * b.R + 0.587 * b.G + 0.114 * b.B) < 140 ? 1 : 0;
                DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, ref dark, 4);
                int cap = ColorRef(b);
                DwmSetWindowAttribute(hwnd, DWMWA_CAPTION_COLOR, ref cap, 4);
                int border = ColorRef(b);
                DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR, ref border, 4);
            }
            if (text is Color t)
            {
                int tc = ColorRef(t);
                DwmSetWindowAttribute(hwnd, DWMWA_TEXT_COLOR, ref tc, 4);
            }
        }
        catch (Exception ex) { Log.Error("WindowChrome", ex); }
    }
}

using System.Text.Json;
using System.Text.Json.Nodes;

namespace MarkNotes;

/// <summary>Where everything lives on disk.</summary>
public static class AppPaths
{
    /// <summary>Folder that contains MarkNotes.exe.</summary>
    public static string ExeDir { get; private set; } = AppContext.BaseDirectory;
    /// <summary>Settings, UI state, window position (roaming).</summary>
    public static string ConfigDir { get; private set; } = "";
    /// <summary>WebView2 cache, speech models, logs (local, not roaming).</summary>
    public static string LocalDir { get; private set; } = "";
    /// <summary>Notes root used when the settings don't name one.</summary>
    public static string DefaultNotesRoot { get; private set; } = "";
    /// <summary>The web UI (index.html + bundles).</summary>
    public static string WebDir { get; private set; } = "";
    public static bool IsTestProfile { get; private set; }

    public static string SettingsFile => Path.Combine(ConfigDir, "settings.json");
    public static string StateFile => Path.Combine(ConfigDir, "state.json");
    public static string WindowFile => Path.Combine(ConfigDir, "window.json");
    public static string ModelsDir => Path.Combine(LocalDir, "models");

    public static void Init(AppOptions o)
    {
        ExeDir = AppContext.BaseDirectory.TrimEnd('\\');
        if (!string.IsNullOrWhiteSpace(o.DataDir))
        {
            var d = Path.GetFullPath(o.DataDir);
            IsTestProfile = true;
            ConfigDir = Path.Combine(d, "config");
            LocalDir = Path.Combine(d, "local");
            DefaultNotesRoot = Path.Combine(d, "Notes");
        }
        else
        {
            ConfigDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "MarkNotes");
            LocalDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MarkNotes");
            DefaultNotesRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "MarkNotes");
        }
        WebDir = !string.IsNullOrWhiteSpace(o.WebDir) ? Path.GetFullPath(o.WebDir) : Path.Combine(ExeDir, "web");
        Directory.CreateDirectory(ConfigDir);
        Directory.CreateDirectory(LocalDir);
    }
}

/// <summary>
/// settings.json is owned by the web UI. The host only peeks at a few values it needs
/// before the UI is up (notes folder, window colours).
/// </summary>
public static class HostSettings
{
    public static JsonObject Load()
    {
        try
        {
            if (File.Exists(AppPaths.SettingsFile))
                return JsonNode.Parse(File.ReadAllText(AppPaths.SettingsFile)) as JsonObject ?? new JsonObject();
        }
        catch (Exception ex) { Log.Error("HostSettings.Load", ex); }
        return new JsonObject();
    }

    public static string NotesRoot()
    {
        var s = Load();
        var v = s["notesRoot"]?.GetValue<string>();
        return string.IsNullOrWhiteSpace(v) ? AppPaths.DefaultNotesRoot : v!;
    }

    /// <summary>Colours of the native title bar, saved by the UI whenever the theme changes.</summary>
    public static (Color? bg, Color? text) ChromeColors()
    {
        try
        {
            var s = Load();
            if (s["chrome"] is JsonObject c)
                return (ParseColor(c["bg"]?.GetValue<string>()), ParseColor(c["text"]?.GetValue<string>()));
        }
        catch { }
        return (null, null);
    }

    public static Color? ParseColor(string? hex)
    {
        if (string.IsNullOrWhiteSpace(hex)) return null;
        hex = hex.Trim().TrimStart('#');
        if (hex.Length == 3) hex = string.Concat(hex.Select(ch => new string(ch, 2)));
        if (hex.Length < 6) return null;
        try
        {
            return Color.FromArgb(Convert.ToInt32(hex[..2], 16), Convert.ToInt32(hex.Substring(2, 2), 16), Convert.ToInt32(hex.Substring(4, 2), 16));
        }
        catch { return null; }
    }

    /// <summary>Atomic-ish JSON write: temp file then replace.</summary>
    public static void WriteJsonFile(string path, string json)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, json);
        File.Move(tmp, path, true);
    }
}

public static class JsonOpts
{
    public static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = false,
    };

    public static readonly JsonSerializerOptions Pretty = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };
}

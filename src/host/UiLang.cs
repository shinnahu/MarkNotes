using System.Globalization;

namespace MarkNotes;

/// <summary>
/// Interface language of the native parts (file dialogs, error messages): "en" or "es".
/// Starts from settings.json (or the Windows display language) and then follows
/// Settings › Appearance › Language, which the UI reports through app.setLanguage.
/// </summary>
public static class UiLang
{
    private static string? _current;

    public static string Current
    {
        get => _current ??= Initial();
        set => _current = value == "es" ? "es" : "en";
    }

    public static bool Es => Current == "es";

    /// <summary>The English or the Spanish text, whichever matches the interface.</summary>
    public static string T(string en, string es) => Es ? es : en;

    private static string Initial()
    {
        try
        {
            var v = HostSettings.Load()["language"]?.GetValue<string>();
            if (v == "es" || v == "en") return v;
        }
        catch { }
        return CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "es" ? "es" : "en";
    }
}

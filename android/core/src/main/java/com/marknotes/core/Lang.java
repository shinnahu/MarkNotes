package com.marknotes.core;

/** Interface language for texts made here (error messages, default names): "en" or "es", set by app.setLanguage. */
public final class Lang {
    private Lang() {}

    private static volatile String current = "en";

    public static void set(String lang) {
        current = lang != null && lang.toLowerCase(java.util.Locale.ROOT).startsWith("es") ? "es" : "en";
    }

    public static String get() { return current; }

    /** English or Spanish text, like UiLang.T on the PC. */
    public static String t(String en, String es) {
        return "es".equals(current) ? es : en;
    }
}

package com.marknotes.core;

/** Logging that works on Android (the app installs a sink that writes to logcat) and on the PC (stderr). */
public final class Log {
    private Log() {}

    public interface Sink {
        void info(String msg);

        void error(String msg, Throwable t);
    }

    private static volatile Sink sink = new Sink() {
        @Override
        public void info(String msg) { System.err.println("[MarkNotes] " + msg); }

        @Override
        public void error(String msg, Throwable t) {
            System.err.println("[MarkNotes] ERROR " + msg + (t == null ? "" : ": " + t));
        }
    };

    public static void setSink(Sink s) { if (s != null) sink = s; }

    public static void info(String msg) { sink.info(msg); }

    public static void error(String msg, Throwable t) { sink.error(msg, t); }
}

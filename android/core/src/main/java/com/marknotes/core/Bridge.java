package com.marknotes.core;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * The same JSON-RPC the PC's Bridge.cs speaks with the web UI.
 * UI → here: {id, cmd, args}. Here → UI: {id, ok, result|error} or {event, data}.
 * Commands run on a thread pool (like the PC's Task.Run handlers), so a slow listing never blocks a note read.
 */
public final class Bridge {
    public interface Handler {
        Object handle(Map<String, Object> args) throws Exception;
    }

    private final Platform platform;
    private final Map<String, Handler> handlers = new ConcurrentHashMap<>();
    private final ExecutorService pool;

    public Bridge(Platform platform) {
        this.platform = platform;
        final AtomicInteger n = new AtomicInteger();
        this.pool = Executors.newCachedThreadPool(new ThreadFactory() {
            @Override
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "mn-bridge-" + n.incrementAndGet());
                t.setDaemon(true);
                return t;
            }
        });
    }

    public Platform platform() { return platform; }

    public void on(String cmd, Handler h) { handlers.put(cmd, h); }

    public boolean has(String cmd) { return handlers.containsKey(cmd); }

    /** A message from the UI (JSON text). Returns at once; the answer is posted when the command is done. */
    public void receive(final String json) {
        pool.execute(new Runnable() {
            @Override
            public void run() { dispatch(json); }
        });
    }

    /** Runs a command on this thread and returns its result (tests, and commands calling each other). */
    public Object call(String cmd, Map<String, Object> args) throws Exception {
        Handler h = handlers.get(cmd);
        if (h == null) throw new IllegalStateException("Unknown command " + cmd);
        return h.handle(args == null ? new LinkedHashMap<String, Object>() : args);
    }

    @SuppressWarnings("unchecked")
    private void dispatch(String json) {
        long id = 0;
        try {
            Map<String, Object> msg = Json.parseObject(json);
            id = Json.getLong(msg, "id", 0);
            String cmd = Json.getString(msg, "cmd", "");
            Object a = msg.get("args");
            Map<String, Object> args = a instanceof Map ? (Map<String, Object>) a : new LinkedHashMap<String, Object>();
            Object result = call(cmd, args);
            if (id != 0) post(Json.obj("id", id, "ok", true, "result", result));
        } catch (Throwable t) {
            Log.error("Bridge", t);
            String m = t.getMessage();
            if (m == null || m.isEmpty()) m = t.getClass().getSimpleName();
            if (id != 0) post(Json.obj("id", id, "ok", false, "error", m));
        }
    }

    /** An event for the UI ({event, data}), like the PC's Bridge.Emit. */
    public void emit(String event, Object data) {
        post(Json.obj("event", event, "data", data));
    }

    private void post(Map<String, Object> msg) {
        String text;
        try {
            text = Json.write(msg);
        } catch (RuntimeException e) {
            Log.error("Bridge.post serialize", e);
            return;
        }
        platform.postToUi(text);
    }

    /** Runs work in the background (sync, scans) on the same pool. */
    public void background(Runnable r) { pool.execute(r); }
}

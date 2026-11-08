package com.marknotes.devhost;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import com.marknotes.core.AppCommands;
import com.marknotes.core.Bridge;
import com.marknotes.core.Platform;
import com.marknotes.core.PhoneCore;
import com.marknotes.core.Trash;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

/**
 * Runs the phone's Java side (note store, app and sync commands) on the PC behind the real web UI, for tests in a
 * phone-sized browser (Puppeteer maps app.marknotes.example and files.marknotes.example here and plays the part of the
 * Android WebView's JavaScript bridge).
 *
 * args: <web dist folder> <data folder> <port>
 *   GET  /app/<path>     the interface files (like the APK's assets)
 *   GET  /files/<path>   pictures and media of the notes (like LocalServer)
 *   POST /bridge         one message from the page (MarkNotesAndroid.postMessage)
 *   GET  /events         waits up to 25 s for messages to the page (JSON array)
 */
public final class DevHost {
    public static void main(String[] args) throws Exception {
        final File web = new File(args[0]);
        final File data = new File(args[1]);
        int port = Integer.parseInt(args[2]);
        final LinkedBlockingQueue<String> out = new LinkedBlockingQueue<>();
        final File notes = new File(data, "Notes");
        final Trash trash = new Trash(new File(data, "Trash"), notes);
        notes.mkdirs();
        Platform platform = new Platform() {
            @Override public void postToUi(String json) { out.add(json); }
            @Override public File notesRoot() { return notes; }
            @Override public File configDir() { return new File(data, "config"); }
            @Override public File cacheDir() { return new File(data, "cache"); }
            @Override public void trash(File f) throws IOException { trash.put(f, "phone", null); }
            @Override public void trash(File f, String by, String pc) throws IOException { trash.put(f, by, pc); }
            @Override public Trash trashBin() { return trash; }
            @Override public File historyDir() { return new File(data, "SyncHistory"); }
            @Override public String deviceName() { return System.getProperty("mn.device", "Test Phone"); }
            @Override public String deviceModel() { return "DevHost"; }
            @Override public String platformName() { return "android"; }
        };
        final Bridge bridge = new Bridge(platform);
        PhoneCore.start(platform, bridge, new AppCommands.Host() {
            @Override public String version() { return "1.0-dev"; }
            @Override public void openExternal(String url) { System.out.println("OPEN " + url); }
            @Override public void setChrome(String bg, String text) { System.out.println("CHROME " + bg); }
            @Override public List<String> launchFiles() { return Collections.emptyList(); }
        });

        HttpServer http = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
        http.setExecutor(java.util.concurrent.Executors.newCachedThreadPool());
        http.createContext("/app/", ex -> serveFile(ex, web, ex.getRequestURI().getRawPath().substring(5)));
        http.createContext("/files/", ex -> {
            String rest = ex.getRequestURI().getRawPath().substring(7); // r/<path>
            if (!rest.startsWith("r/")) { send(ex, 404, "text/plain", new byte[0]); return; }
            serveFile(ex, notes, rest.substring(2));
        });
        http.createContext("/bridge", ex -> {
            byte[] body = readAll(ex.getRequestBody());
            bridge.receive(new String(body, StandardCharsets.UTF_8));
            send(ex, 204, "text/plain", null);
        });
        http.createContext("/events", ex -> {
            List<String> batch = new ArrayList<>();
            try {
                String first = out.poll(25, TimeUnit.SECONDS);
                if (first != null) {
                    batch.add(first);
                    out.drainTo(batch);
                }
            } catch (InterruptedException ignored) {
            }
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < batch.size(); i++) {
                if (i > 0) sb.append(',');
                sb.append(batch.get(i));
            }
            sb.append(']');
            send(ex, 200, "application/json", sb.toString().getBytes(StandardCharsets.UTF_8));
        });
        http.start();
        System.out.println("DEVHOST READY " + port);
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        byte[] buf = new byte[1 << 15];
        int n;
        while ((n = in.read(buf)) > 0) o.write(buf, 0, n);
        return o.toByteArray();
    }

    private static String type(String name) {
        String n = name.toLowerCase(Locale.ROOT);
        if (n.endsWith(".html")) return "text/html; charset=utf-8";
        if (n.endsWith(".js")) return "text/javascript; charset=utf-8";
        if (n.endsWith(".css")) return "text/css; charset=utf-8";
        if (n.endsWith(".json")) return "application/json";
        if (n.endsWith(".svg")) return "image/svg+xml";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".gif")) return "image/gif";
        if (n.endsWith(".webp")) return "image/webp";
        return "application/octet-stream";
    }

    private static void serveFile(HttpExchange ex, File root, String rawRel) throws IOException {
        String rel = URLDecoder.decode(rawRel.replace("+", "%2B"), "UTF-8");
        if (rel.isEmpty()) rel = "index.html";
        File f = new File(root, rel);
        if (rel.contains("..") || !f.isFile()) { send(ex, 404, "text/plain", new byte[0]); return; }
        byte[] b;
        try (InputStream in = new FileInputStream(f)) { b = readAll(in); }
        send(ex, 200, type(f.getName()), b);
    }

    private static void send(HttpExchange ex, int code, String type, byte[] body) throws IOException {
        ex.getResponseHeaders().set("Content-Type", type);
        ex.getResponseHeaders().set("Access-Control-Allow-Origin", "*");
        ex.getResponseHeaders().set("Cache-Control", "no-cache");
        if (body == null) {
            ex.sendResponseHeaders(code, -1);
        } else {
            ex.sendResponseHeaders(code, body.length);
            try (OutputStream o = ex.getResponseBody()) { o.write(body); }
        }
        ex.close();
    }
}

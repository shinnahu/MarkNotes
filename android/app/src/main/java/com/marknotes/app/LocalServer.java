package com.marknotes.app;

import android.content.res.AssetManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.marknotes.core.AppCommands;
import com.marknotes.core.Log;

/**
 * Answers the page's requests like the PC's WebView2 host does: the interface from the APK
 * (https://app.marknotes.example/), pictures, videos and Spine models from the notes (https://files.marknotes.example/r/…),
 * and nothing else: the app works offline. Web videos load only while Settings › Editor allows them.
 */
final class LocalServer {
    static final String APP_HOST = "app.marknotes.example";
    static final String FILES_HOST = "files.marknotes.example";

    private final AssetManager assets;
    private final File notesRoot;
    private final File thumbs;
    private final AppCommands app;

    LocalServer(AssetManager assets, File notesRoot, File cacheDir, AppCommands app) {
        this.assets = assets;
        this.notesRoot = notesRoot;
        this.thumbs = new File(cacheDir, "thumbs");
        this.app = app;
    }

    private static final Map<String, String> TYPES = new HashMap<>();

    static {
        String[][] t = {
            {"html", "text/html"}, {"js", "text/javascript"}, {"mjs", "text/javascript"}, {"css", "text/css"},
            {"json", "application/json"}, {"svg", "image/svg+xml"}, {"png", "image/png"}, {"jpg", "image/jpeg"},
            {"jpeg", "image/jpeg"}, {"gif", "image/gif"}, {"webp", "image/webp"}, {"bmp", "image/bmp"},
            {"avif", "image/avif"}, {"ico", "image/x-icon"}, {"woff2", "font/woff2"}, {"woff", "font/woff"},
            {"ttf", "font/ttf"}, {"txt", "text/plain"}, {"wasm", "application/wasm"},
            {"mp4", "video/mp4"}, {"m4v", "video/mp4"}, {"webm", "video/webm"}, {"mov", "video/quicktime"},
            {"ogv", "video/ogg"}, {"mp3", "audio/mpeg"}, {"m4a", "audio/mp4"}, {"wav", "audio/wav"},
            {"ogg", "audio/ogg"}, {"flac", "audio/flac"}, {"skel", "application/octet-stream"}, {"atlas", "text/plain"},
        };
        for (String[] p : t) TYPES.put(p[0], p[1]);
    }

    private static final String[] IMAGE = {"png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico"};
    private static final String[] MEDIA = {"mp4", "m4v", "webm", "mov", "ogv", "mp3", "m4a", "wav", "ogg", "flac"};

    private static boolean in(String[] list, String ext) {
        for (String s : list) if (s.equals(ext)) return true;
        return false;
    }

    private static String ext(String name) {
        int dot = name.lastIndexOf('.');
        return dot < 0 ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    // Only what the YouTube privacy-mode player and X videos need (MainForm.EmbedHosts on the PC).
    private static final String[] EMBED_HOSTS = {
        "youtube-nocookie.com", "youtube.com", "ytimg.com", "googlevideo.com", "ggpht.com", "gstatic.com",
        "googleapis.com", "google.com", "video.twimg.com",
    };

    private static boolean embedHost(String host) {
        if (host == null) return false;
        String h = host.toLowerCase(Locale.ROOT);
        for (String e : EMBED_HOSTS) if (h.equals(e) || h.endsWith("." + e)) return true;
        return false;
    }

    WebResourceResponse handle(WebResourceRequest req) {
        Uri u = req.getUrl();
        String scheme = u.getScheme();
        if ("data".equals(scheme) || "blob".equals(scheme)) return null;
        String host = u.getHost();
        try {
            if (APP_HOST.equalsIgnoreCase(host)) return asset(u.getPath());
            if (FILES_HOST.equalsIgnoreCase(host)) return file(u, req.getRequestHeaders());
        } catch (IOException | RuntimeException e) {
            Log.error("LocalServer " + u, e);
            return status(500, "Error");
        }
        if (app.embedsAllowed() && embedHost(host)) return null;
        return status(403, "Offline");
    }

    private static WebResourceResponse status(int code, String reason) {
        Map<String, String> h = new HashMap<>();
        h.put("Access-Control-Allow-Origin", "*");
        return new WebResourceResponse("text/plain", "utf-8", code, reason, h, new ByteArrayInputStream(new byte[0]));
    }

    private WebResourceResponse asset(String path) throws IOException {
        if (path == null || path.isEmpty() || path.equals("/")) path = "/index.html";
        if (path.contains("..")) return status(404, "Not Found");
        String type = TYPES.get(ext(path));
        InputStream in;
        try {
            in = assets.open("web" + path, AssetManager.ACCESS_STREAMING);
        } catch (IOException e) {
            return status(404, "Not Found");
        }
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-cache");
        boolean text = type != null && (type.startsWith("text/") || type.equals("application/json"));
        return new WebResourceResponse(type == null ? "application/octet-stream" : type, text ? "utf-8" : null, 200, "OK", h, in);
    }

    /** /r/<path in the notes folder> (or /a/<absolute path>, only inside the notes folder on the phone). */
    private File resolve(Uri u) throws IOException {
        List<String> seg = u.getPathSegments();
        if (seg.size() < 2) return null;
        String kind = seg.get(0);
        File f;
        if (kind.equals("r")) {
            StringBuilder rel = new StringBuilder();
            for (int i = 1; i < seg.size(); i++) {
                if (i > 1) rel.append('/');
                rel.append(seg.get(i));
            }
            f = new File(notesRoot, rel.toString());
        } else if (kind.equals("a")) {
            StringBuilder abs = new StringBuilder();
            for (int i = 1; i < seg.size(); i++) abs.append('/').append(seg.get(i));
            f = new File(abs.toString());
        } else {
            return null;
        }
        String root = notesRoot.getCanonicalPath() + File.separator;
        String p = f.getCanonicalPath();
        return p.startsWith(root) ? f : null;
    }

    private WebResourceResponse file(Uri u, Map<String, String> headers) throws IOException {
        File f = resolve(u);
        if (f == null || !f.isFile()) return status(404, "Not Found");
        String ext = ext(f.getName());
        String type = TYPES.get(ext);
        Map<String, String> h = new HashMap<>();
        h.put("Access-Control-Allow-Origin", "*");
        if (in(MEDIA, ext)) return media(f, type, headerIgnoreCase(headers, "Range"), h);
        if (ext.equals("skel") || ext.equals("atlas")) {
            h.put("Cache-Control", "no-cache");
            return new WebResourceResponse(type, ext.equals("atlas") ? "utf-8" : null, 200, "OK", h, new FileInputStream(f));
        }
        if (!in(IMAGE, ext)) return status(404, "Not Found");
        String w = u.getQueryParameter("w");
        if (w != null && !ext.equals("svg") && !ext.equals("gif")) {
            try {
                int width = Integer.parseInt(w);
                if (width > 0) {
                    File t = thumbnail(f, width);
                    if (t != null) {
                        h.put("Cache-Control", "max-age=86400");
                        return new WebResourceResponse(t.getName().endsWith(".png") ? "image/png" : "image/jpeg", null, 200, "OK", h, new FileInputStream(t));
                    }
                }
            } catch (NumberFormatException ignored) {
            }
        }
        h.put("Cache-Control", "no-cache");
        return new WebResourceResponse(type, null, 200, "OK", h, new FileInputStream(f));
    }

    private static String headerIgnoreCase(Map<String, String> headers, String name) {
        if (headers == null) return null;
        for (Map.Entry<String, String> e : headers.entrySet()) if (e.getKey() != null && e.getKey().equalsIgnoreCase(name)) return e.getValue();
        return null;
    }

    private static final Pattern RANGE = Pattern.compile("bytes=(\\d*)-(\\d*)");

    /** Local video/audio with Range support, so the player can seek (at most 8 MB per answer, like the PC). */
    private static WebResourceResponse media(File f, String type, String range, Map<String, String> h) throws IOException {
        long len = f.length();
        h.put("Accept-Ranges", "bytes");
        Matcher m = range == null ? null : RANGE.matcher(range);
        if (m == null || !m.find() || len == 0) {
            h.put("Content-Length", String.valueOf(len));
            return new WebResourceResponse(type, null, 200, "OK", h, new FileInputStream(f));
        }
        long start = m.group(1).isEmpty() ? Math.max(0, len - Long.parseLong(m.group(2))) : Long.parseLong(m.group(1));
        long end = !m.group(1).isEmpty() && !m.group(2).isEmpty() ? Long.parseLong(m.group(2)) : len - 1;
        end = Math.min(end, Math.min(len - 1, start + 8L * 1024 * 1024 - 1));
        if (start >= len) {
            h.put("Content-Range", "bytes */" + len);
            return new WebResourceResponse(type, null, 416, "Range Not Satisfiable", h, new ByteArrayInputStream(new byte[0]));
        }
        byte[] buf = new byte[(int) (end - start + 1)];
        int read = 0;
        try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
            raf.seek(start);
            while (read < buf.length) {
                int n = raf.read(buf, read, buf.length - read);
                if (n <= 0) break;
                read += n;
            }
        }
        h.put("Content-Range", "bytes " + start + "-" + (start + read - 1) + "/" + len);
        h.put("Content-Length", String.valueOf(read));
        return new WebResourceResponse(type, null, 206, "Partial Content", h, new ByteArrayInputStream(buf, 0, read));
    }

    /** A small copy for card covers, kept in the cache by file, date and width. */
    private File thumbnail(File f, int width) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-1");
            md.update((f.getAbsolutePath() + "|" + f.lastModified() + "|" + f.length() + "|" + width).getBytes("UTF-8"));
            StringBuilder name = new StringBuilder();
            for (byte b : md.digest()) name.append(String.format(Locale.ROOT, "%02x", b));
            File png = new File(thumbs, name + ".png"), jpg = new File(thumbs, name + ".jpg");
            if (png.isFile()) return png;
            if (jpg.isFile()) return jpg;
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(f.getAbsolutePath(), o);
            if (o.outWidth <= 0) return null;
            if (o.outWidth <= width) return null; // already small: the original is fine
            int sample = 1;
            while (o.outWidth / (sample * 2) >= width) sample *= 2;
            BitmapFactory.Options d = new BitmapFactory.Options();
            d.inSampleSize = sample;
            Bitmap bmp = BitmapFactory.decodeFile(f.getAbsolutePath(), d);
            if (bmp == null) return null;
            if (bmp.getWidth() > width) {
                Bitmap s = Bitmap.createScaledBitmap(bmp, width, Math.max(1, Math.round(bmp.getHeight() * (width / (float) bmp.getWidth()))), true);
                if (s != bmp) bmp.recycle();
                bmp = s;
            }
            if (!thumbs.isDirectory() && !thumbs.mkdirs()) return null;
            boolean alpha = bmp.hasAlpha();
            File out = alpha ? png : jpg;
            File tmp = new File(thumbs, out.getName() + ".tmp");
            try (OutputStream os = new FileOutputStream(tmp)) {
                bmp.compress(alpha ? Bitmap.CompressFormat.PNG : Bitmap.CompressFormat.JPEG, 85, os);
            } finally {
                bmp.recycle();
            }
            return tmp.renameTo(out) ? out : null;
        } catch (Exception | OutOfMemoryError e) {
            Log.info("Thumbnail " + f + ": " + e);
            return null;
        }
    }
}

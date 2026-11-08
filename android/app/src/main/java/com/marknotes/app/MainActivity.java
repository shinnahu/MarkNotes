package com.marknotes.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import com.marknotes.core.AppCommands;
import com.marknotes.core.Bridge;
import com.marknotes.core.Json;
import com.marknotes.core.Log;
import com.marknotes.core.PhoneCore;

/**
 * MarkNotes on Android: MarkNotes' own interface (the same web UI as on the PC) in a WebView, with the notes stored
 * on the phone by the Java port of the PC's note store, and sync with MarkNotes on the PC over the Wi-Fi.
 */
public final class MainActivity extends Activity {
    private static final int PICK_FILES = 41;

    private WebView web;
    private FrameLayout root;
    private AndroidPlatform platform;
    private Bridge bridge;
    private AppCommands app;
    private PhoneCore core;
    private ValueCallback<Uri[]> fileCallback;
    private volatile boolean pageReady;
    private Intent pendingShare;

    /** The page calls MarkNotesAndroid.postMessage(json) (api.js). */
    final class JsBridge {
        @JavascriptInterface
        public void postMessage(String json) {
            if (json != null && json.contains("\"cmd\":\"app.ready\"")) {
                pageReady = true;
                runOnUiThread(MainActivity.this::deliverShare);
            }
            bridge.receive(json);
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Log.setSink(new Log.Sink() {
            @Override public void info(String msg) { android.util.Log.i("MarkNotes", msg); }

            @Override public void error(String msg, Throwable t) { android.util.Log.e("MarkNotes", msg, t); }
        });

        platform = new AndroidPlatform(this);
        bridge = new Bridge(platform);
        Services s = Services.create(this, platform, bridge, new AppCommands.Host() {
            @Override public String version() { return versionName(); }

            @Override public void openExternal(String url) { runOnUiThread(() -> openLink(url)); }

            @Override public void setChrome(String bg, String text) { runOnUiThread(() -> applyChrome(bg)); }

            @Override public List<String> launchFiles() { return Collections.emptyList(); }
        });
        app = s.app;
        core = s.core;

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#313338"));
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);
        setupInsets();
        platform.attach(web);

        WebSettings ws = web.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setAllowFileAccess(false);
        ws.setAllowContentAccess(true); // pictures picked with the file chooser
        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setSupportZoom(false);
        ws.setBuiltInZoomControls(false);
        ws.setDisplayZoomControls(false);
        ws.setTextZoom(100);
        ws.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        ws.setCacheMode(WebSettings.LOAD_NO_CACHE);
        if (Build.VERSION.SDK_INT >= 26) ws.setSafeBrowsingEnabled(false); // nothing is browsed: no Google lookups
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setBackgroundColor(Color.TRANSPARENT);
        web.addJavascriptInterface(new JsBridge(), "MarkNotesAndroid");

        final LocalServer server = new LocalServer(getAssets(), platform.notesRoot(), platform.cacheDir(), app);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                return server.handle(req);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (LocalServer.APP_HOST.equalsIgnoreCase(u.getHost())) return false;
                // Links leave the app (like the PC opens them in the browser); embedded players stay in their frames.
                if (req.isForMainFrame()) {
                    openLink(u.toString());
                    return true;
                }
                return false;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                String[] types = params.getAcceptTypes();
                String type = types != null && types.length == 1 && types[0] != null && !types[0].isEmpty() ? types[0] : "*/*";
                i.setType(type);
                if (types != null && types.length > 1) i.putExtra(Intent.EXTRA_MIME_TYPES, types);
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try {
                    startActivityForResult(Intent.createChooser(i, null), PICK_FILES);
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                if (m.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                    android.util.Log.w("MarkNotes.js", m.message() + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
                }
                return true;
            }
        });
        if (BuildInfo.debuggable(this)) WebView.setWebContentsDebuggingEnabled(true);

        pendingShare = shareOf(getIntent());
        web.loadUrl("https://" + LocalServer.APP_HOST + "/index.html");
    }

    private String versionName() {
        try {
            PackageInfo p = getPackageManager().getPackageInfo(getPackageName(), 0);
            return p.versionName;
        } catch (Exception e) {
            return "1.0";
        }
    }

    /** System bars and the keyboard: the page fits between them, so the formatting bar sits right on the keyboard. */
    private void setupInsets() {
        Window w = getWindow();
        if (Build.VERSION.SDK_INT >= 30) {
            w.setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((v, insets) -> {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                Insets ime = insets.getInsets(WindowInsets.Type.ime());
                v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
                return WindowInsets.CONSUMED;
            });
        }
    }

    private static boolean isLight(int c) {
        double l = 0.299 * Color.red(c) + 0.587 * Color.green(c) + 0.114 * Color.blue(c);
        return l > 160;
    }

    /** The theme's background behind the status and navigation bars, with dark or light icons to match. */
    @SuppressWarnings("deprecation")
    private void applyChrome(String bg) {
        int c;
        try {
            c = Color.parseColor(bg == null || bg.isEmpty() ? "#313338" : bg.trim());
        } catch (IllegalArgumentException e) {
            return;
        }
        root.setBackgroundColor(c);
        Window w = getWindow();
        w.setStatusBarColor(c);
        w.setNavigationBarColor(c);
        boolean light = isLight(c);
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController ic = w.getInsetsController();
            if (ic != null) {
                int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                ic.setSystemBarsAppearance(light ? mask : 0, mask);
            }
        } else {
            View d = w.getDecorView();
            int f = d.getSystemUiVisibility();
            f = light ? (f | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR) : (f & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
            d.setSystemUiVisibility(f);
        }
    }

    private void openLink(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, R.string.no_browser, Toast.LENGTH_SHORT).show();
        }
    }

    // ─────────────────────────── sharing into MarkNotes ───────────────────────────

    private static Intent shareOf(Intent i) {
        return i != null && Intent.ACTION_SEND.equals(i.getAction()) && i.getStringExtra(Intent.EXTRA_TEXT) != null ? i : null;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        Intent s = shareOf(intent);
        if (s != null) {
            pendingShare = s;
            if (pageReady) deliverShare();
        }
    }

    /** Text or a link shared from another app becomes a new note (the page makes it, in the open workspace). */
    private void deliverShare() {
        Intent s = pendingShare;
        if (s == null || !pageReady) return;
        pendingShare = null;
        bridge.emit("app.share", Json.obj("text", s.getStringExtra(Intent.EXTRA_TEXT), "subject", s.getStringExtra(Intent.EXTRA_SUBJECT)));
    }

    // ─────────────────────────── lifecycle ───────────────────────────

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        if (pageReady) bridge.emit("app.focus", null);
    }

    @Override
    protected void onPause() {
        // Unsaved edits are written and sent to the PC before Android may stop the app; the search index is saved.
        if (pageReady) bridge.emit("app.background", null);
        final PhoneCore c = core;
        if (c != null) bridge.background(() -> {
            try { c.store.flushIndex(); } catch (RuntimeException e) { Log.error("flushIndex", e); }
        });
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        platform.attach(null);
        web.destroy();
        super.onDestroy();
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        if (!pageReady) {
            moveTaskToBack(true);
            return;
        }
        // The page closes its own menus, dialogs and drawer first; with nothing left, the app goes to the background.
        web.evaluateJavascript("window.__mnBack?window.__mnBack():false", (res) -> {
            if (!"true".equals(res)) moveTaskToBack(true);
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != PICK_FILES || fileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            List<Uri> list = new ArrayList<>();
            ClipData clip = data.getClipData();
            if (clip != null) for (int i = 0; i < clip.getItemCount(); i++) list.add(clip.getItemAt(i).getUri());
            else if (data.getData() != null) list.add(data.getData());
            result = list.toArray(new Uri[0]);
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    /** Keeps the note store, the app commands and the sync referenced for the activity's life. */
    static final class Services {
        AppCommands app;
        PhoneCore core;

        static Services create(Activity a, AndroidPlatform platform, Bridge bridge, AppCommands.Host host) {
            Services s = new Services();
            s.core = PhoneCore.start(platform, bridge, host);
            s.app = s.core.app;
            return s;
        }
    }
}

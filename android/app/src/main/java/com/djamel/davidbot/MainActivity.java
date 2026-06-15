package com.djamel.davidbot;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.BitmapShader;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.net.Uri;
import android.util.Base64;
import android.widget.ImageView;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.view.animation.DecelerateInterpolator;
import android.view.animation.OvershootInterpolator;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.JsResult;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.pm.ShortcutInfoCompat;
import androidx.core.content.pm.ShortcutManagerCompat;
import androidx.core.graphics.drawable.IconCompat;
import androidx.drawerlayout.widget.DrawerLayout;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends AppCompatActivity {

    // ── Constants ────────────────────────────────────────────────────────
    private static final int    FILE_CHOOSER_REQUEST  = 1001;
    private static final int    IMAGE_PICK_REQUEST    = 1002;
    private static final String PREF_PROFILES         = "bot_profiles_v2";
    private static final String PREF_ACTIVE_IDX       = "active_profile_idx";
    private static final String PREF_AVATAR_B64       = "bot_avatar_b64";
    private static final String PREF_APP_DISPLAY_NAME = "app_display_name";
    private static final String DEFAULT_URL           = "http://localhost:5000";

    // ── Views ────────────────────────────────────────────────────────────
    private DrawerLayout       drawerLayout;
    private WebView            webView;
    private ProgressBar        progressBar;
    private SwipeRefreshLayout swipeRefresh;
    private LinearLayout       drawerPanel;
    private TextView           fabMenu;

    // ── State ────────────────────────────────────────────────────────────
    private SharedPreferences prefs;
    private ValueCallback<Uri[]> fileCallback;
    private final List<BotProfile> profiles = new ArrayList<>();
    private int activeIdx = 0;

    // ── Phone-as-Host: WakeLock ───────────────────────────────────────────
    private PowerManager.WakeLock wakeLock;

    // ── Bot Engine Runner ─────────────────────────────────────────────────
    private boolean  botEngineRunning  = false;
    private final Handler   botStatusHandler  = new Handler(Looper.getMainLooper());
    private Runnable botStatusRunnable = null;
    private static final String TERMUX_PKG        = "com.termux";
    private static final String TERMUX_RUN_SVC    = "com.termux.app.RunCommandService";
    private static final String TERMUX_RUN_ACTION = "com.termux.RUN_COMMAND";
    private static final String PREF_BOT_PATH     = "bot_engine_path";

    // ── Custom Avatar + Display Name ──────────────────────────────────────
    private String botAvatarB64       = null;
    private String appDisplayName     = "DAVID V1";

    // ── BotProfile ───────────────────────────────────────────────────────
    static class BotProfile {
        String name, url, color;

        BotProfile(String name, String url, String color) {
            this.name = name;
            this.url  = url;
            this.color = color;
        }

        static BotProfile fromJSON(JSONObject o) throws Exception {
            return new BotProfile(
                o.optString("name", "بوت"),
                o.optString("url",  DEFAULT_URL),
                o.optString("color","#0A84FF")
            );
        }

        JSONObject toJSON() throws Exception {
            JSONObject o = new JSONObject();
            o.put("name", name);
            o.put("url",  url);
            o.put("color", color);
            return o;
        }
    }

    // ── JavaScript Bridge ────────────────────────────────────────────────
    public class AndroidBridge {

        @JavascriptInterface
        public void openSettings() {
            new Handler(Looper.getMainLooper()).post(MainActivity.this::showSettingsDialog);
        }

        @JavascriptInterface
        public void openDrawer() {
            new Handler(Looper.getMainLooper()).post(() ->
                drawerLayout.openDrawer(drawerPanel));
        }

        @JavascriptInterface
        public void showToast(String msg) {
            new Handler(Looper.getMainLooper()).post(() ->
                Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show());
        }

        @JavascriptInterface
        public String getServerUrl() {
            return getActiveUrl();
        }

        @JavascriptInterface
        public void onNicknameResult(boolean ok, String error) {
            new Handler(Looper.getMainLooper()).post(() -> {
                if (ok)
                    Toast.makeText(MainActivity.this, "✅ تم تغيير الكنية في كل الغروبات", Toast.LENGTH_LONG).show();
                else
                    Toast.makeText(MainActivity.this, "❌ فشل: " + error, Toast.LENGTH_LONG).show();
            });
        }

        @JavascriptInterface
        public void openRailwayHelp() {
            new Handler(Looper.getMainLooper()).post(MainActivity.this::showRailwayDialog);
        }

        @JavascriptInterface
        public void openPhoneHostHelp() {
            new Handler(Looper.getMainLooper()).post(MainActivity.this::showPhoneAsHostDialog);
        }

        @JavascriptInterface
        public void switchTab(String tab) {
            new Handler(Looper.getMainLooper()).post(() -> {
                String safe = tab.replaceAll("[^a-zA-Z0-9_-]", "");
                webView.evaluateJavascript(
                    "if(typeof switchTab==='function')switchTab('" + safe + "');", null);
                if (drawerLayout.isDrawerOpen(drawerPanel))
                    drawerLayout.closeDrawer(drawerPanel);
            });
        }

        @JavascriptInterface
        public void copyToClipboard(String text) {
            new Handler(Looper.getMainLooper()).post(() -> {
                try {
                    ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                    if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("copy", text));
                    Toast.makeText(MainActivity.this, "✅ تم النسخ", Toast.LENGTH_SHORT).show();
                } catch (Exception ignored) {}
            });
        }
    }

    // ── Lifecycle ────────────────────────────────────────────────────────
    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Full-screen dark iOS 26 style
        Window w = getWindow();
        w.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        w.setStatusBarColor(Color.BLACK);
        w.setNavigationBarColor(Color.BLACK);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            w.setDecorFitsSystemWindows(false);
        } else {
            w.getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
        }

        setContentView(R.layout.activity_main);

        prefs        = getSharedPreferences("david_prefs", MODE_PRIVATE);
        drawerLayout = findViewById(R.id.drawer_layout);
        progressBar  = findViewById(R.id.progress_bar);
        swipeRefresh = findViewById(R.id.swipe_refresh);
        webView      = findViewById(R.id.web_view);
        drawerPanel  = findViewById(R.id.drawer_panel);
        fabMenu      = findViewById(R.id.fab_menu);

        loadProfiles();
        loadAvatarAndName();
        setupWebView();
        buildDrawerContent();
        setupSwipeRefresh();
        setupFabMenu();
        requestNeededPermissions();
        loadUrl(getActiveUrl());
        startBotStatusMonitor();
    }

    @Override
    protected void onResume() {
        super.onResume();
        startBotStatusMonitor();
    }

    @Override
    protected void onPause() {
        super.onPause();
        stopBotStatusMonitor();
    }

    // ── Profile Management ───────────────────────────────────────────────
    private void loadProfiles() {
        profiles.clear();
        activeIdx = prefs.getInt(PREF_ACTIVE_IDX, 0);
        String json = prefs.getString(PREF_PROFILES, "");
        if (!json.isEmpty()) {
            try {
                JSONArray arr = new JSONArray(json);
                for (int i = 0; i < arr.length(); i++)
                    profiles.add(BotProfile.fromJSON(arr.getJSONObject(i)));
            } catch (Exception ignored) {}
        }
        if (profiles.isEmpty()) {
            profiles.add(new BotProfile("البوت الرئيسي", DEFAULT_URL, "#0A84FF"));
            saveProfiles();
        }
        if (activeIdx >= profiles.size()) activeIdx = 0;
    }

    private void saveProfiles() {
        try {
            JSONArray arr = new JSONArray();
            for (BotProfile p : profiles) arr.put(p.toJSON());
            prefs.edit()
                .putString(PREF_PROFILES, arr.toString())
                .putInt(PREF_ACTIVE_IDX, activeIdx)
                .apply();
        } catch (Exception ignored) {}
    }

    private String getActiveUrl() {
        if (profiles.isEmpty()) return DEFAULT_URL;
        if (activeIdx >= profiles.size()) activeIdx = 0;
        return profiles.get(activeIdx).url;
    }

    private BotProfile getActiveProfile() {
        if (profiles.isEmpty()) return new BotProfile("البوت الرئيسي", DEFAULT_URL, "#0A84FF");
        if (activeIdx >= profiles.size()) activeIdx = 0;
        return profiles.get(activeIdx);
    }

    // ── Avatar + Display Name ─────────────────────────────────────────────
    private void loadAvatarAndName() {
        botAvatarB64   = prefs.getString(PREF_AVATAR_B64, null);
        appDisplayName = prefs.getString(PREF_APP_DISPLAY_NAME, "DAVID V1");
    }

    private Bitmap circleBitmap(Bitmap src) {
        int size = Math.min(src.getWidth(), src.getHeight());
        Bitmap out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(out);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setShader(new BitmapShader(
            Bitmap.createScaledBitmap(src, size, size, true),
            Shader.TileMode.CLAMP, Shader.TileMode.CLAMP));
        canvas.drawCircle(size / 2f, size / 2f, size / 2f, paint);
        return out;
    }

    // ── WebView Setup ────────────────────────────────────────────────────
    @SuppressLint("SetJavaScriptEnabled")
    private void setupWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setSupportZoom(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setUserAgentString(
            "Mozilla/5.0 (Linux; Android " + Build.VERSION.RELEASE + "; " + Build.MODEL +
            ") AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36 DavidBotApp/4.0"
        );
        webView.addJavascriptInterface(new AndroidBridge(), "Android");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                String url = r.getUrl().toString();
                if (url.startsWith("http://") || url.startsWith("https://")) {
                    v.loadUrl(url); return true;
                }
                try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); }
                catch (Exception ignored) {}
                return true;
            }

            @Override
            public void onPageStarted(WebView v, String url, android.graphics.Bitmap f) {
                progressBar.setVisibility(View.VISIBLE);
                progressBar.setProgress(10);
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                progressBar.setVisibility(View.GONE);
                swipeRefresh.setRefreshing(false);
                injectEnhancements();
            }

            @Override
            public void onReceivedError(WebView v, int code, String desc, String failingUrl) {
                if (!isFinishing()) showConnectionError();
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView v, int p) {
                progressBar.setProgress(p);
                if (p >= 100) progressBar.setVisibility(View.GONE);
            }

            @Override
            public boolean onShowFileChooser(WebView wv, ValueCallback<Uri[]> cb,
                                             FileChooserParams params) {
                fileCallback = cb;
                try {
                    startActivityForResult(
                        Intent.createChooser(params.createIntent(), "اختر ملف"),
                        FILE_CHOOSER_REQUEST);
                } catch (Exception e) { fileCallback = null; return false; }
                return true;
            }

            @Override
            public void onPermissionRequest(PermissionRequest req) {
                req.grant(req.getResources());
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage m) { return true; }

            @Override
            public boolean onJsAlert(WebView v, String url, String msg, JsResult r) {
                new AlertDialog.Builder(MainActivity.this)
                    .setMessage(msg)
                    .setPositiveButton("حسناً", (d, w) -> r.confirm())
                    .setOnCancelListener(d -> r.cancel()).show();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView v, String url, String msg, JsResult r) {
                new AlertDialog.Builder(MainActivity.this)
                    .setMessage(msg)
                    .setPositiveButton("نعم", (d, w) -> r.confirm())
                    .setNegativeButton("لا",  (d, w) -> r.cancel())
                    .setOnCancelListener(d -> r.cancel()).show();
                return true;
            }
        });
    }

    private void injectEnhancements() {
        String accent = getActiveProfile().color.replace("'", "\\'");
        webView.evaluateJavascript(
            "(function(){" +
            // Viewport
            "var m=document.querySelector('meta[name=viewport]');" +
            "if(m)m.setAttribute('content','width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no,viewport-fit=cover');" +
            "document.body&&document.body.classList.add('android-app');" +
            // Base CSS overrides
            "if(!document.getElementById('_dv_android')){var s=document.createElement('style');s.id='_dv_android';" +
            "s.textContent='" +
            ":root{--android-app:1;--app-accent:" + accent + ";}" +
            "body.android-app{padding-top:env(safe-area-inset-top,0)!important;-webkit-overflow-scrolling:touch}" +
            "body.android-app ::-webkit-scrollbar{display:none}" +
            "body.android-app .nav-tabs{position:sticky;top:0;z-index:100;backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px)}" +
            "body.android-app .card{border-radius:18px!important}" +
            "body.android-app .btn{border-radius:12px!important;touch-action:manipulation}" +
            "body.android-app input,body.android-app textarea,body.android-app select{font-size:16px!important}" +
            "';" +
            "document.head&&document.head.appendChild(s);}" +
            // Swipe handle indicator (right edge — RTL Arabic drawer side)
            "if(!window._drawerHint){window._drawerHint=true;" +
            "var h=document.createElement('div');" +
            "h.id='_dv_handle';" +
            "h.style.cssText='position:fixed;right:0;top:50%;transform:translateY(-50%);" +
            "width:5px;height:64px;background:var(--app-accent," + accent + ");" +
            "border-radius:6px 0 0 6px;opacity:.4;z-index:9999;cursor:pointer;" +
            "transition:opacity .2s,width .2s,height .2s';" +
            "h.addEventListener('touchstart',function(e){" +
            "this.style.opacity='.85';this.style.width='8px';this.style.height='80px';},false);" +
            "h.addEventListener('touchend',function(e){" +
            "e.preventDefault();" +
            "this.style.opacity='.4';this.style.width='5px';this.style.height='64px';" +
            "if(window.Android)Android.openDrawer();},false);" +
            "h.onclick=function(){if(window.Android)Android.openDrawer();};" +
            "document.body&&document.body.appendChild(h);}" +
            // Bind copy button to Android bridge
            "document.querySelectorAll('[data-copy]').forEach(function(el){" +
            "el.onclick=function(){if(window.Android)Android.copyToClipboard(el.getAttribute('data-copy'));};" +
            "});" +
            "})();",
            null
        );
    }

    // ── Drawer Content ───────────────────────────────────────────────────
    private void buildDrawerContent() {
        drawerPanel.removeAllViews();
        drawerPanel.setOrientation(LinearLayout.VERTICAL);
        drawerPanel.setBackgroundColor(Color.parseColor("#111111"));

        // Status bar spacer
        View spacer = new View(this);
        int sbHeight = getStatusBarHeight();
        spacer.setLayoutParams(new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, sbHeight > 0 ? sbHeight : dp(32)));
        drawerPanel.addView(spacer);

        // ── Header ──
        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.VERTICAL);
        header.setPadding(dp(20), dp(14), dp(20), dp(18));
        header.setBackgroundColor(Color.parseColor("#1A1A1A"));

        // Logo row
        LinearLayout logoRow = new LinearLayout(this);
        logoRow.setOrientation(LinearLayout.HORIZONTAL);
        logoRow.setGravity(Gravity.CENTER_VERTICAL);

        // Avatar: custom image or fallback "D" letter
        View logoView;
        if (botAvatarB64 != null) {
            try {
                byte[] imgBytes = Base64.decode(botAvatarB64, Base64.DEFAULT);
                Bitmap raw = BitmapFactory.decodeByteArray(imgBytes, 0, imgBytes.length);
                Bitmap circ = circleBitmap(raw);
                ImageView iv = new ImageView(this);
                iv.setImageBitmap(circ);
                iv.setScaleType(ImageView.ScaleType.CENTER_CROP);
                iv.setLayoutParams(new LinearLayout.LayoutParams(dp(42), dp(42)));
                logoView = iv;
            } catch (Exception e) {
                logoView = makeLogoFallback();
            }
        } else {
            logoView = makeLogoFallback();
        }
        logoRow.addView(logoView);

        LinearLayout titleBlock = new LinearLayout(this);
        titleBlock.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams tbLp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        tbLp.leftMargin = dp(12);
        titleBlock.setLayoutParams(tbLp);

        TextView titleTv = new TextView(this);
        titleTv.setText(appDisplayName);
        titleTv.setTextSize(17);
        titleTv.setTypeface(null, Typeface.BOLD);
        titleTv.setTextColor(Color.WHITE);
        titleBlock.addView(titleTv);

        TextView subTv = new TextView(this);
        subTv.setText(getActiveProfile().name);
        subTv.setTextSize(11);
        subTv.setTextColor(Color.parseColor("#8E8E93"));
        titleBlock.addView(subTv);
        logoRow.addView(titleBlock);

        TextView closeBtn = new TextView(this);
        closeBtn.setText("✕");
        closeBtn.setTextSize(15);
        closeBtn.setTextColor(Color.parseColor("#48484A"));
        closeBtn.setGravity(Gravity.CENTER);
        closeBtn.setLayoutParams(new LinearLayout.LayoutParams(dp(30), dp(30)));
        closeBtn.setOnClickListener(v -> drawerLayout.closeDrawer(drawerPanel));
        logoRow.addView(closeBtn);
        header.addView(logoRow);

        // Active URL pill
        LinearLayout urlPill = new LinearLayout(this);
        urlPill.setOrientation(LinearLayout.HORIZONTAL);
        urlPill.setGravity(Gravity.CENTER_VERTICAL);
        urlPill.setBackground(makeRoundRect(dp(10), Color.parseColor("#2C2C2E")));
        urlPill.setPadding(dp(10), dp(7), dp(10), dp(7));
        LinearLayout.LayoutParams pillLp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        pillLp.topMargin = dp(12);
        urlPill.setLayoutParams(pillLp);

        View dot = new View(this);
        dot.setBackground(makeRoundRect(dp(5), Color.parseColor("#32D74B")));
        dot.setLayoutParams(new LinearLayout.LayoutParams(dp(8), dp(8)));
        urlPill.addView(dot);

        TextView urlTv = new TextView(this);
        urlTv.setText(getActiveUrl());
        urlTv.setTextSize(10);
        urlTv.setTextColor(Color.parseColor("#AEAEB2"));
        urlTv.setSingleLine(true);
        LinearLayout.LayoutParams urlLp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        urlLp.leftMargin = dp(8);
        urlTv.setLayoutParams(urlLp);
        urlPill.addView(urlTv);

        // Copy URL button
        TextView copyUrlBtn = new TextView(this);
        copyUrlBtn.setText("📋");
        copyUrlBtn.setTextSize(13);
        copyUrlBtn.setGravity(Gravity.CENTER);
        copyUrlBtn.setLayoutParams(new LinearLayout.LayoutParams(dp(28), dp(28)));
        copyUrlBtn.setOnClickListener(v -> copyUrlToClipboard());
        urlPill.addView(copyUrlBtn);

        header.addView(urlPill);
        drawerPanel.addView(header);

        // ── Scrollable area ──
        ScrollView scroll = new ScrollView(this);
        scroll.setLayoutParams(new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        scroll.setBackgroundColor(Color.parseColor("#111111"));

        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(12), dp(10), dp(12), dp(24));
        scroll.addView(content);

        // ── Bot Status Card ──
        addSectionLabel(content, "حالة الاتصال");

        LinearLayout statusCard = new LinearLayout(this);
        statusCard.setOrientation(LinearLayout.HORIZONTAL);
        statusCard.setGravity(Gravity.CENTER_VERTICAL);
        statusCard.setBackground(makeRoundRect(dp(12), Color.parseColor("#1A1A1E")));
        statusCard.setPadding(dp(14), dp(12), dp(12), dp(12));
        LinearLayout.LayoutParams scLp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        scLp.bottomMargin = dp(12);
        statusCard.setLayoutParams(scLp);

        final TextView statusDotTv = new TextView(this);
        statusDotTv.setText("●");
        statusDotTv.setTextSize(18);
        statusDotTv.setTextColor(Color.parseColor("#636366"));
        statusDotTv.setGravity(Gravity.CENTER);
        statusDotTv.setLayoutParams(new LinearLayout.LayoutParams(dp(24), dp(24)));
        statusCard.addView(statusDotTv);

        LinearLayout statusBlock = new LinearLayout(this);
        statusBlock.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams sbLp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        sbLp.setMargins(dp(10), 0, 0, 0);
        statusBlock.setLayoutParams(sbLp);

        TextView statusTitle = new TextView(this);
        statusTitle.setText("حالة البوت");
        statusTitle.setTextSize(13);
        statusTitle.setTypeface(null, Typeface.BOLD);
        statusTitle.setTextColor(Color.WHITE);
        statusBlock.addView(statusTitle);

        final TextView statusLabelTv = new TextView(this);
        statusLabelTv.setText("اضغط 🔍 للفحص");
        statusLabelTv.setTextSize(11);
        statusLabelTv.setTextColor(Color.parseColor("#8E8E93"));
        statusBlock.addView(statusLabelTv);
        statusCard.addView(statusBlock);

        final android.widget.Button pingBtn = new android.widget.Button(this);
        pingBtn.setText("🔍");
        pingBtn.setTextSize(14);
        pingBtn.setBackground(makeRoundRect(dp(10), Color.parseColor("#2C2C2E")));
        pingBtn.setTextColor(Color.WHITE);
        pingBtn.setLayoutParams(new LinearLayout.LayoutParams(dp(44), dp(44)));
        pingBtn.setOnClickListener(v -> pingBotServer(statusDotTv, statusLabelTv, pingBtn));
        statusCard.addView(pingBtn);
        content.addView(statusCard);

        // ── Quick Navigation Chips ──
        addSectionLabel(content, "تنقل سريع");
        LinearLayout navChips = new LinearLayout(this);
        navChips.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams ncLp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        ncLp.bottomMargin = dp(12);
        navChips.setLayoutParams(ncLp);

        String[][] quickTabs = {
            {"💬", "مسنجر", "messenger"},
            {"🍪", "كوكيز", "cookies"},
            {"📋", "سجلات", "logs"},
            {"🚀", "Railway", "railway"}
        };
        for (String[] t : quickTabs) {
            LinearLayout chip = new LinearLayout(this);
            chip.setOrientation(LinearLayout.VERTICAL);
            chip.setGravity(Gravity.CENTER);
            chip.setPadding(0, dp(8), 0, dp(8));
            chip.setBackground(makeSelector(dp(10), Color.parseColor("#1E1E22"), Color.parseColor("#2C2C2E")));
            LinearLayout.LayoutParams chipLp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
            chipLp.setMargins(dp(3), 0, dp(3), 0);
            chip.setLayoutParams(chipLp);
            final String tabTarget = t[2];
            chip.setOnClickListener(v -> {
                drawerLayout.closeDrawer(drawerPanel);
                webView.evaluateJavascript(
                    "if(typeof switchTab==='function')switchTab('" + tabTarget + "');", null);
            });
            addPressAnim(chip);
            TextView emTv = new TextView(this);
            emTv.setText(t[0]);
            emTv.setTextSize(18);
            emTv.setGravity(Gravity.CENTER);
            chip.addView(emTv);
            TextView lblTv = new TextView(this);
            lblTv.setText(t[1]);
            lblTv.setTextSize(9.5f);
            lblTv.setTextColor(Color.parseColor("#8E8E93"));
            lblTv.setGravity(Gravity.CENTER);
            chip.addView(lblTv);
            navChips.addView(chip);
        }
        content.addView(navChips);

        addDivider(content);

        // ── Bot Engine Status Panel ─────────────────────────────────────────
        addSectionLabel(content, "🤖 محرك البوت");

        String botPath = prefs.getString(PREF_BOT_PATH, "/sdcard/DAVID-V1");
        int cardBg = botEngineRunning ? Color.parseColor("#0A2215") : Color.parseColor("#220A0A");
        int dotClr = botEngineRunning ? Color.parseColor("#32D74B") : Color.parseColor("#FF453A");

        LinearLayout engCard = new LinearLayout(this);
        engCard.setOrientation(LinearLayout.VERTICAL);
        engCard.setBackground(makeRoundRect(dp(16), cardBg));
        engCard.setPadding(dp(14), dp(13), dp(14), dp(13));
        LinearLayout.LayoutParams ecLp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        ecLp.bottomMargin = dp(8);
        engCard.setLayoutParams(ecLp);

        // Status row (dot + text + path)
        LinearLayout engStatRow = new LinearLayout(this);
        engStatRow.setOrientation(LinearLayout.HORIZONTAL);
        engStatRow.setGravity(Gravity.CENTER_VERTICAL);
        engStatRow.setLayoutParams(new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView engDot = new TextView(this);
        engDot.setText("●");
        engDot.setTextSize(16);
        engDot.setTextColor(dotClr);
        LinearLayout.LayoutParams edLp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        edLp.rightMargin = dp(8);
        engDot.setLayoutParams(edLp);
        engStatRow.addView(engDot);

        LinearLayout engTxtCol = new LinearLayout(this);
        engTxtCol.setOrientation(LinearLayout.VERTICAL);
        engTxtCol.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        TextView engStatusTv = new TextView(this);
        engStatusTv.setText(botEngineRunning ? "البوت يعمل  ✓" : "البوت متوقف");
        engStatusTv.setTextSize(13.5f);
        engStatusTv.setTypeface(null, Typeface.BOLD);
        engStatusTv.setTextColor(dotClr);
        engTxtCol.addView(engStatusTv);

        TextView engPathTv = new TextView(this);
        engPathTv.setText(botPath.replace("/sdcard/", "~/"));
        engPathTv.setTextSize(10f);
        engPathTv.setTextColor(Color.parseColor("#636366"));
        engTxtCol.addView(engPathTv);

        engStatRow.addView(engTxtCol);

        // Refresh status button
        TextView refreshDot = new TextView(this);
        refreshDot.setText("↻");
        refreshDot.setTextSize(18);
        refreshDot.setTextColor(Color.parseColor("#636366"));
        refreshDot.setPadding(dp(6), 0, 0, 0);
        refreshDot.setOnClickListener(v ->
            checkBotEngineStatus(() -> buildDrawerContent()));
        engStatRow.addView(refreshDot);

        engCard.addView(engStatRow);

        // ── Buttons row — iOS 26 pill style ─────────────────────────────
        LinearLayout engBtnRow = new LinearLayout(this);
        engBtnRow.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams ebrLp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        ebrLp.topMargin = dp(12);
        engBtnRow.setLayoutParams(ebrLp);

        // START button
        LinearLayout startBtn = makeEngBtn(
            "▶  تشغيل",
            botEngineRunning ? Color.parseColor("#1A3A1A") : Color.parseColor("#32D74B"),
            botEngineRunning ? Color.parseColor("#2A5A2A") : Color.BLACK,
            botEngineRunning ? 0.4f : 1f);
        LinearLayout.LayoutParams sb1 = new LinearLayout.LayoutParams(0, dp(44), 1f);
        sb1.rightMargin = dp(6);
        startBtn.setLayoutParams(sb1);
        if (!botEngineRunning) {
            startBtn.setOnClickListener(v -> {
                drawerLayout.closeDrawer(drawerPanel);
                startBotEngine();
            });
            addPressAnim(startBtn);
        }
        engBtnRow.addView(startBtn);

        // STOP button
        LinearLayout stopBtn = makeEngBtn(
            "⏹  إيقاف",
            botEngineRunning ? Color.parseColor("#FF453A") : Color.parseColor("#2A0A0A"),
            botEngineRunning ? Color.WHITE : Color.parseColor("#4A1A1A"),
            botEngineRunning ? 1f : 0.4f);
        LinearLayout.LayoutParams sb2 = new LinearLayout.LayoutParams(0, dp(44), 1f);
        sb2.rightMargin = dp(6);
        stopBtn.setLayoutParams(sb2);
        if (botEngineRunning) {
            stopBtn.setOnClickListener(v -> {
                drawerLayout.closeDrawer(drawerPanel);
                stopBotEngine();
            });
            addPressAnim(stopBtn);
        }
        engBtnRow.addView(stopBtn);

        // RESTART button (always enabled)
        LinearLayout rstBtn = makeEngBtn("🔄", Color.parseColor("#2A1800"),
            Color.parseColor("#FF9F0A"), 1f);
        rstBtn.setLayoutParams(new LinearLayout.LayoutParams(dp(54), dp(44)));
        rstBtn.setOnClickListener(v -> {
            drawerLayout.closeDrawer(drawerPanel);
            restartBotEngine();
        });
        addPressAnim(rstBtn);
        engBtnRow.addView(rstBtn);

        engCard.addView(engBtnRow);

        // Dashboard shortcut (only when running)
        if (botEngineRunning) {
            LinearLayout dashBtn = makeEngBtn("🖥  فتح الواجهة",
                Color.parseColor("#0A2A4A"), Color.parseColor("#5AC8FA"), 1f);
            LinearLayout.LayoutParams dbLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(40));
            dbLp.topMargin = dp(7);
            dashBtn.setLayoutParams(dbLp);
            dashBtn.setOnClickListener(v -> {
                drawerLayout.closeDrawer(drawerPanel);
                loadUrl("http://localhost:5000");
            });
            addPressAnim(dashBtn);
            engCard.addView(dashBtn);
        }

        // Settings link
        TextView engSettTv = new TextView(this);
        engSettTv.setText("⚙️  تغيير مسار البوت");
        engSettTv.setTextSize(10.5f);
        engSettTv.setTextColor(Color.parseColor("#48484A"));
        engSettTv.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams estLp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        estLp.topMargin = dp(9);
        engSettTv.setLayoutParams(estLp);
        engSettTv.setOnClickListener(v -> showBotEngineSettingsDialog());
        addPressAnim(engSettTv);
        engCard.addView(engSettTv);

        content.addView(engCard);
        // ── End Bot Engine Panel ────────────────────────────────────────────

        addDivider(content);

        // ── Profiles ──
        addSectionLabel(content, "البوتات");

        for (int i = 0; i < profiles.size(); i++) {
            final int idx = i;
            BotProfile p = profiles.get(i);
            boolean isActive = (i == activeIdx);
            LinearLayout row = makeProfileRow(p.name, p.url, isActive, p.color);
            row.setOnClickListener(v -> {
                activeIdx = idx;
                saveProfiles();
                drawerLayout.closeDrawer(drawerPanel);
                loadUrl(p.url);
                new Handler(Looper.getMainLooper()).postDelayed(() -> buildDrawerContent(), 300);
                Toast.makeText(this, "✅ " + p.name, Toast.LENGTH_SHORT).show();
            });
            row.setOnLongClickListener(v -> { showEditProfileDialog(idx); return true; });
            content.addView(row);
        }

        LinearLayout addBtn = makeActionBtn("➕  إضافة بوت جديد", "#0A84FF");
        addBtn.setOnClickListener(v -> showAddProfileDialog());
        content.addView(addBtn);

        addDivider(content);

        // ── Quick actions ──
        addSectionLabel(content, "إجراءات سريعة");

        LinearLayout avatarBtn = makeActionBtn("🖼️  صورة البوت / اسم التطبيق", "#FF9F0A");
        avatarBtn.setOnClickListener(v -> { drawerLayout.closeDrawer(drawerPanel); showAvatarAndNameDialog(); });
        content.addView(avatarBtn);

        LinearLayout nickBtn = makeActionBtn("✏️  تغيير الكنية في الكل", "#BF5AF2");
        nickBtn.setOnClickListener(v -> { drawerLayout.closeDrawer(drawerPanel); showNicknameDialog(); });
        content.addView(nickBtn);

        LinearLayout shortcutBtn = makeActionBtn("📱  اختصار على الشاشة", "#32D74B");
        shortcutBtn.setOnClickListener(v -> { drawerLayout.closeDrawer(drawerPanel); createHomeShortcut(); });
        content.addView(shortcutBtn);

        LinearLayout reloadBtn = makeActionBtn("🔄  إعادة التحميل", "#FF9F0A");
        reloadBtn.setOnClickListener(v -> { drawerLayout.closeDrawer(drawerPanel); webView.reload(); });
        content.addView(reloadBtn);

        LinearLayout clearBtn = makeActionBtn("🗑️  مسح الكاش", "#FF453A");
        clearBtn.setOnClickListener(v -> {
            webView.clearCache(true);
            webView.clearHistory();
            Toast.makeText(this, "✅ تم مسح الكاش", Toast.LENGTH_SHORT).show();
        });
        content.addView(clearBtn);

        addDivider(content);

        // ── Hosting Mode (Railway / Phone) ──
        addSectionLabel(content, "📡 تشغيل البوت");

        LinearLayout hostBtn = makeActionBtn("📱  الهاتف كسيرفر (Termux)", "#32D74B");
        hostBtn.setOnClickListener(v -> { drawerLayout.closeDrawer(drawerPanel); showPhoneAsHostDialog(); });
        content.addView(hostBtn);

        LinearLayout railBtn = makeActionBtn("🚂  Railway — نشر على السحابة", "#6366F1");
        railBtn.setOnClickListener(v -> {
            drawerLayout.closeDrawer(drawerPanel);
            showRailwayDialog();
        });
        content.addView(railBtn);

        addDivider(content);

        // ── Settings ──
        addSectionLabel(content, "الإعدادات");

        LinearLayout settBtn = makeActionBtn("⚙️  إعدادات التطبيق", "#636366");
        settBtn.setOnClickListener(v -> { drawerLayout.closeDrawer(drawerPanel); showSettingsDialog(); });
        content.addView(settBtn);

        // Version footer
        TextView footer = new TextView(this);
        footer.setText("DAVID V1  •  v5.0  •  © 2025 DJAMEL");
        footer.setTextSize(10);
        footer.setTextColor(Color.parseColor("#3A3A3C"));
        footer.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams fLp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        fLp.topMargin = dp(18);
        footer.setLayoutParams(fLp);
        content.addView(footer);

        drawerPanel.addView(scroll);
    }

    // ── Drawer UI Helpers ────────────────────────────────────────────────
    private LinearLayout makeProfileRow(String name, String url, boolean active, String color) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(12), dp(11), dp(12), dp(11));
        row.setBackground(makeSelector(dp(10),
            active ? Color.parseColor("#1C2E42") : Color.TRANSPARENT,
            Color.parseColor("#1C1C1E")));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = dp(4);
        row.setLayoutParams(lp);

        View colorDot = new View(this);
        colorDot.setBackground(makeRoundRect(dp(5), Color.parseColor(color)));
        colorDot.setLayoutParams(new LinearLayout.LayoutParams(dp(10), dp(10)));
        row.addView(colorDot);

        LinearLayout block = new LinearLayout(this);
        block.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams bLp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        bLp.leftMargin = dp(10);
        block.setLayoutParams(bLp);

        TextView nameTv = new TextView(this);
        nameTv.setText(name);
        nameTv.setTextSize(14);
        nameTv.setTextColor(active ? Color.parseColor("#0A84FF") : Color.WHITE);
        nameTv.setTypeface(null, active ? Typeface.BOLD : Typeface.NORMAL);
        block.addView(nameTv);

        TextView urlTv = new TextView(this);
        urlTv.setText(url);
        urlTv.setTextSize(10);
        urlTv.setTextColor(Color.parseColor("#8E8E93"));
        urlTv.setSingleLine(true);
        block.addView(urlTv);

        row.addView(block);

        if (active) {
            TextView checkTv = new TextView(this);
            checkTv.setText("✔");
            checkTv.setTextSize(14);
            checkTv.setTextColor(Color.parseColor("#0A84FF"));
            checkTv.setGravity(Gravity.CENTER);
            checkTv.setLayoutParams(new LinearLayout.LayoutParams(dp(22), dp(22)));
            row.addView(checkTv);
        }
        addPressAnim(row);
        return row;
    }

    private LinearLayout makeActionBtn(String text, String color) {
        int accentColor;
        try { accentColor = Color.parseColor(color); } catch (Exception e) { accentColor = 0xFF0A84FF; }

        LinearLayout btn = new LinearLayout(this);
        btn.setOrientation(LinearLayout.HORIZONTAL);
        btn.setGravity(Gravity.CENTER_VERTICAL);
        btn.setBackground(makeSelector(dp(12), Color.parseColor("#1E1E22"), Color.parseColor("#28282C")));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = dp(6);
        btn.setLayoutParams(lp);

        // Left colored accent strip
        View accent = new View(this);
        accent.setBackground(makeRoundRect(dp(3), accentColor));
        LinearLayout.LayoutParams accentLp = new LinearLayout.LayoutParams(dp(3), dp(42));
        accentLp.setMargins(dp(2), dp(5), 0, dp(5));
        accent.setLayoutParams(accentLp);
        btn.addView(accent);

        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextSize(13.5f);
        tv.setTextColor(Color.WHITE);
        tv.setTypeface(null, Typeface.BOLD);
        LinearLayout.LayoutParams tvLp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        tvLp.setMargins(dp(12), dp(13), 0, dp(13));
        tv.setLayoutParams(tvLp);
        btn.addView(tv);

        // Colored dot indicator
        View dot = new View(this);
        GradientDrawable dotBg = new GradientDrawable();
        dotBg.setShape(GradientDrawable.OVAL);
        dotBg.setColor(accentColor);
        dot.setBackground(dotBg);
        LinearLayout.LayoutParams dotLp = new LinearLayout.LayoutParams(dp(7), dp(7));
        dotLp.setMargins(0, 0, dp(6), 0);
        dot.setLayoutParams(dotLp);
        btn.addView(dot);

        TextView arrow = new TextView(this);
        arrow.setText("›");
        arrow.setTextSize(17);
        arrow.setTextColor(Color.parseColor("#636366"));
        arrow.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams arrowLp = new LinearLayout.LayoutParams(dp(20), dp(20));
        arrowLp.setMargins(0, 0, dp(8), 0);
        arrow.setLayoutParams(arrowLp);
        btn.addView(arrow);

        addPressAnim(btn);
        return btn;
    }

    /** iOS 26 pill button for bot engine panel. */
    private LinearLayout makeEngBtn(String text, int bgColor, int textColor, float alpha) {
        LinearLayout btn = new LinearLayout(this);
        btn.setOrientation(LinearLayout.HORIZONTAL);
        btn.setGravity(Gravity.CENTER);
        btn.setBackground(makeRoundRect(dp(13), bgColor));
        btn.setAlpha(alpha);
        btn.setPadding(dp(6), 0, dp(6), 0);

        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextSize(12f);
        tv.setTypeface(null, Typeface.BOLD);
        tv.setTextColor(textColor);
        tv.setGravity(Gravity.CENTER);
        btn.addView(tv);
        return btn;
    }

    /** iOS 26 spring press animation — scale in on DOWN, spring back on UP. */
    @SuppressLint("ClickableViewAccessibility")
    private void addPressAnim(View v) {
        v.setOnTouchListener((view, event) -> {
            switch (event.getAction()) {
                case MotionEvent.ACTION_DOWN:
                    view.animate()
                        .scaleX(0.93f).scaleY(0.93f)
                        .alpha(0.72f)
                        .setDuration(85)
                        .setInterpolator(new DecelerateInterpolator(2f))
                        .start();
                    break;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    view.animate()
                        .scaleX(1f).scaleY(1f)
                        .alpha(1f)
                        .setDuration(400)
                        .setInterpolator(new OvershootInterpolator(3.5f))
                        .start();
                    break;
            }
            return false; // allow click events to pass through
        });
    }

    private void addSectionLabel(LinearLayout parent, String text) {
        TextView tv = new TextView(this);
        tv.setText(text.toUpperCase());
        tv.setTextSize(11);
        tv.setTextColor(Color.parseColor("#636366"));
        tv.setTypeface(null, Typeface.BOLD);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(8);
        lp.bottomMargin = dp(6);
        lp.leftMargin = dp(4);
        tv.setLayoutParams(lp);
        parent.addView(tv);
    }

    private void addDivider(LinearLayout parent) {
        View div = new View(this);
        div.setBackgroundColor(Color.parseColor("#2C2C2E"));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 1);
        lp.topMargin    = dp(8);
        lp.bottomMargin = dp(8);
        div.setLayoutParams(lp);
        parent.addView(div);
    }

    // ── Dialogs ──────────────────────────────────────────────────────────
    private void showSettingsDialog() {
        BotProfile active = getActiveProfile();
        ScrollView scroll = new ScrollView(this);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setBackgroundColor(Color.parseColor("#1C1C1E"));
        layout.setPadding(dp(20), dp(16), dp(20), dp(16));
        scroll.addView(layout);

        layout.addView(makeLabel("🔗 رابط السيرفر"));
        EditText urlInput = makeInput(active.url, "http://localhost:5000  أو  https://xxx.railway.app");
        layout.addView(urlInput);

        layout.addView(makeLabel("🏷️ اسم هذا الملف الشخصي"));
        EditText nameInput = makeInput(active.name, "مثال: البوت الرئيسي");
        layout.addView(nameInput);

        layout.addView(makeLabel("🎨 لون الملف الشخصي (Hex)"));
        EditText colorInput = makeInput(active.color, "#0A84FF");
        layout.addView(colorInput);

        new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
            .setTitle("⚙️ إعدادات DAVID V1")
            .setView(scroll)
            .setPositiveButton("💾 حفظ", (d, which) -> {
                String newUrl   = urlInput.getText().toString().trim();
                String newName  = nameInput.getText().toString().trim();
                String newColor = colorInput.getText().toString().trim();
                if (!newUrl.isEmpty())   active.url   = newUrl;
                if (!newName.isEmpty())  active.name  = newName;
                if (!newColor.isEmpty() && newColor.startsWith("#")) active.color = newColor;
                saveProfiles();
                loadUrl(getActiveUrl());
                buildDrawerContent();
                Toast.makeText(this, "✅ تم حفظ الإعدادات", Toast.LENGTH_SHORT).show();
            })
            .setNeutralButton("📱 اختصار", (d, which) -> createHomeShortcut())
            .setNegativeButton("❌ إلغاء", null)
            .show();
    }

    private void showAddProfileDialog() {
        ScrollView scroll = new ScrollView(this);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setBackgroundColor(Color.parseColor("#1C1C1E"));
        layout.setPadding(dp(20), dp(16), dp(20), dp(16));
        scroll.addView(layout);

        layout.addView(makeLabel("🔗 رابط السيرفر"));
        EditText urlInput = makeInput("", "http://localhost:5000  أو  https://xxx.railway.app");
        layout.addView(urlInput);

        layout.addView(makeLabel("🏷️ اسم البوت"));
        EditText nameInput = makeInput("", "مثال: بوت الاختبار");
        layout.addView(nameInput);

        final String[] COLORS = {"#0A84FF","#BF5AF2","#32D74B","#FF9F0A","#FF453A","#30D158"};
        final String[] chosen  = {COLORS[0]};

        layout.addView(makeLabel("🎨 اختر لوناً"));
        LinearLayout colorRow = new LinearLayout(this);
        colorRow.setOrientation(LinearLayout.HORIZONTAL);
        colorRow.setGravity(Gravity.CENTER_VERTICAL);
        colorRow.setPadding(0, dp(4), 0, dp(8));

        for (String c : COLORS) {
            View dot = new View(this);
            LinearLayout.LayoutParams dLp = new LinearLayout.LayoutParams(dp(30), dp(30));
            dLp.rightMargin = dp(8);
            dot.setLayoutParams(dLp);
            dot.setBackground(makeRoundRect(dp(15), Color.parseColor(c)));
            dot.setOnClickListener(v -> {
                chosen[0] = c;
                for (int i = 0; i < colorRow.getChildCount(); i++) {
                    View ch = colorRow.getChildAt(i);
                    ch.setScaleX(1f); ch.setScaleY(1f);
                    ch.setAlpha(0.6f);
                }
                v.setScaleX(1.3f); v.setScaleY(1.3f); v.setAlpha(1f);
            });
            dot.setAlpha(c.equals(chosen[0]) ? 1f : 0.6f);
            colorRow.addView(dot);
        }
        layout.addView(colorRow);

        new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
            .setTitle("➕ إضافة بوت جديد")
            .setView(scroll)
            .setPositiveButton("✅ إضافة", (d, which) -> {
                String url  = urlInput.getText().toString().trim();
                String name = nameInput.getText().toString().trim();
                if (url.isEmpty()) {
                    Toast.makeText(this, "❌ أدخل الرابط أولاً", Toast.LENGTH_SHORT).show();
                    return;
                }
                if (name.isEmpty()) name = "بوت " + (profiles.size() + 1);
                profiles.add(new BotProfile(name, url, chosen[0]));
                saveProfiles();
                buildDrawerContent();
                Toast.makeText(this, "✅ تمت إضافة: " + name, Toast.LENGTH_SHORT).show();
            })
            .setNegativeButton("❌ إلغاء", null)
            .show();
    }

    private void showEditProfileDialog(int idx) {
        if (idx < 0 || idx >= profiles.size()) return;
        BotProfile p = profiles.get(idx);

        ScrollView scroll = new ScrollView(this);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setBackgroundColor(Color.parseColor("#1C1C1E"));
        layout.setPadding(dp(20), dp(16), dp(20), dp(16));
        scroll.addView(layout);

        layout.addView(makeLabel("🔗 رابط السيرفر"));
        EditText urlInput = makeInput(p.url, "https://xxx.railway.app");
        layout.addView(urlInput);

        layout.addView(makeLabel("🏷️ الاسم"));
        EditText nameInput = makeInput(p.name, "اسم البوت");
        layout.addView(nameInput);

        new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
            .setTitle("✏️ تعديل " + p.name)
            .setView(scroll)
            .setPositiveButton("💾 حفظ", (d, which) -> {
                String u = urlInput.getText().toString().trim();
                String n = nameInput.getText().toString().trim();
                if (!u.isEmpty()) p.url  = u;
                if (!n.isEmpty()) p.name = n;
                saveProfiles();
                buildDrawerContent();
                if (idx == activeIdx) loadUrl(p.url);
            })
            .setNeutralButton("🗑️ حذف", (d, which) -> {
                if (profiles.size() <= 1) {
                    Toast.makeText(this, "⚠️ لا يمكن حذف الملف الشخصي الأخير", Toast.LENGTH_SHORT).show();
                    return;
                }
                profiles.remove(idx);
                if (activeIdx >= profiles.size()) activeIdx = profiles.size() - 1;
                saveProfiles();
                buildDrawerContent();
                if (idx == activeIdx) loadUrl(getActiveUrl());
            })
            .setNegativeButton("❌ إلغاء", null)
            .show();
    }

    private void showNicknameDialog() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setBackgroundColor(Color.parseColor("#1C1C1E"));
        layout.setPadding(dp(20), dp(16), dp(20), dp(16));

        layout.addView(makeLabel("✏️ الكنية الجديدة للبوت في جميع الغروبات"));
        EditText nickInput = makeInput("", "مثال: DAVID 🤖 أو اسمك");
        layout.addView(nickInput);

        new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
            .setTitle("✏️ تغيير الكنية")
            .setView(layout)
            .setPositiveButton("✅ تطبيق", (d, which) -> {
                String nick = nickInput.getText().toString().trim();
                if (!nick.isEmpty()) changeNicknameInAllGroups(nick);
                else Toast.makeText(this, "⚠️ أدخل الكنية أولاً", Toast.LENGTH_SHORT).show();
            })
            .setNegativeButton("❌ إلغاء", null)
            .show();
    }

    private void showRailwayDialog() {
        ScrollView scroll = new ScrollView(this);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setBackgroundColor(Color.parseColor("#111111"));
        layout.setPadding(dp(20), dp(16), dp(20), dp(28));
        scroll.addView(layout);

        String[][] steps = {
            {"🚂 ما هو Railway؟",
             "Railway هو خدمة استضافة سحابية مجانية تتيح تشغيل البوت 24/7 دون الحاجة لإبقاء الهاتف مفتوحاً."},
            {"1️⃣  إنشاء حساب",
             "اذهب إلى railway.app\nسجّل دخول عبر GitHub"},
            {"2️⃣  رفع الكود على GitHub",
             "من لوحة التحكم → تبويب Railway\nأدخل GitHub Token واضغط \"رفع على GitHub\""},
            {"3️⃣  إنشاء مشروع جديد",
             "في Railway: New Project → Deploy from GitHub Repo\nاختر: castrolmocro/divid-apk"},
            {"4️⃣  إضافة المتغيرات",
             "في Railway → Variables أضف:\nNODE_ENV=production\nPORT=3000\nDASHBOARD_PASSWORD=david2025"},
            {"5️⃣  ضبط الرابط هنا",
             "بعد النشر ستحصل على رابط مثل:\nhttps://your-project.railway.app\nأدخله في إعدادات التطبيق."},
            {"💡 Railway مجاناً",
             "يتيح Railway 500 ساعة مجانية شهرياً.\nراجع railway.app للخطط المدفوعة إذا احتجت أكثر."}
        };

        for (String[] step : steps) {
            LinearLayout card = new LinearLayout(this);
            card.setOrientation(LinearLayout.VERTICAL);
            card.setBackground(makeRoundRect(dp(12), Color.parseColor("#1C1C1E")));
            card.setPadding(dp(14), dp(12), dp(14), dp(12));
            LinearLayout.LayoutParams cLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            cLp.bottomMargin = dp(10);
            card.setLayoutParams(cLp);

            TextView titleTv = new TextView(this);
            titleTv.setText(step[0]);
            titleTv.setTextSize(14);
            titleTv.setTypeface(null, Typeface.BOLD);
            titleTv.setTextColor(Color.parseColor("#6366F1"));
            card.addView(titleTv);

            TextView bodyTv = new TextView(this);
            bodyTv.setText(step[1]);
            bodyTv.setTextSize(13);
            bodyTv.setTextColor(Color.parseColor("#EBEBF5"));
            bodyTv.setLineSpacing(0, 1.4f);
            LinearLayout.LayoutParams bLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            bLp.topMargin = dp(4);
            bodyTv.setLayoutParams(bLp);
            card.addView(bodyTv);
            layout.addView(card);
        }

        new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
            .setTitle("🚀 النشر على Railway")
            .setView(scroll)
            .setPositiveButton("⚙️ ضبط الرابط", (d, which) -> showSettingsDialog())
            .setNeutralButton("🌐 فتح Railway", (d, which) -> {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://railway.app")));
                } catch (Exception ignored) {}
            })
            .setNegativeButton("إغلاق", null)
            .show();
    }

    private void showPhoneAsHostDialog() {
        ScrollView scroll = new ScrollView(this);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setBackgroundColor(Color.parseColor("#111111"));
        layout.setPadding(dp(20), dp(16), dp(20), dp(28));
        scroll.addView(layout);

        String[][] steps = {
            {"1️⃣  تثبيت Termux",
             "حمّله من F-Droid (مجاناً).\nلا تستخدم نسخة Google Play القديمة."},
            {"2️⃣  تثبيت Node.js",
             "pkg update && pkg install nodejs git -y"},
            {"3️⃣  تشغيل البوت",
             "cd /sdcard/DAVID-V1\nnode index.js"},
            {"4️⃣  IP الهاتف",
             "ip addr show wlan0\nأو: الإعدادات > Wi-Fi > تفاصيل الشبكة"},
            {"5️⃣  ضبط الرابط هنا",
             "http://<IP الهاتف>:5000\nمثال: http://192.168.1.5:5000"},
            {"🌐  الوصول من الإنترنت",
             "Cloudflare Tunnel: cloudflared tunnel\nأو ngrok: ngrok http 5000\nثم انسخ الرابط العام."},
            {"💡  نصيحة",
             "فعّل «لا تنام عند الشحن» في خيارات المطور\nلإبقاء البوت يعمل طوال الوقت."}
        };

        for (String[] step : steps) {
            LinearLayout card = new LinearLayout(this);
            card.setOrientation(LinearLayout.VERTICAL);
            card.setBackground(makeRoundRect(dp(12), Color.parseColor("#1C1C1E")));
            card.setPadding(dp(14), dp(12), dp(14), dp(12));
            LinearLayout.LayoutParams cLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            cLp.bottomMargin = dp(10);
            card.setLayoutParams(cLp);

            TextView titleTv = new TextView(this);
            titleTv.setText(step[0]);
            titleTv.setTextSize(14);
            titleTv.setTypeface(null, Typeface.BOLD);
            titleTv.setTextColor(Color.parseColor("#0A84FF"));
            card.addView(titleTv);

            TextView bodyTv = new TextView(this);
            bodyTv.setText(step[1]);
            bodyTv.setTextSize(13);
            bodyTv.setTextColor(Color.parseColor("#EBEBF5"));
            bodyTv.setLineSpacing(0, 1.4f);
            LinearLayout.LayoutParams bLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            bLp.topMargin = dp(4);
            bodyTv.setLayoutParams(bLp);
            card.addView(bodyTv);
            layout.addView(card);
        }

        // ─── WakeLock card ──────────────────────────────────────────────
        LinearLayout wakeCard = new LinearLayout(this);
        wakeCard.setOrientation(LinearLayout.VERTICAL);
        wakeCard.setBackground(makeRoundRect(dp(12), Color.parseColor("#1C2E1C")));
        wakeCard.setPadding(dp(14), dp(12), dp(14), dp(12));
        LinearLayout.LayoutParams wcLp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        wcLp.bottomMargin = dp(10);
        wakeCard.setLayoutParams(wcLp);

        TextView wakeTitleTv = new TextView(this);
        wakeTitleTv.setText("⚡  حماية من إيقاف الهاتف (OPPO / ColorOS 16)");
        wakeTitleTv.setTextSize(14);
        wakeTitleTv.setTypeface(null, Typeface.BOLD);
        wakeTitleTv.setTextColor(Color.parseColor("#32D74B"));
        wakeCard.addView(wakeTitleTv);

        TextView wakeBodyTv = new TextView(this);
        wakeBodyTv.setText("اضغط الزرين أدناه لمنع ColorOS من إيقاف البوت أثناء الاستخدام كسيرفر. WakeLock يُبقي المعالج نشطاً دون إضاءة الشاشة.");
        wakeBodyTv.setTextSize(13);
        wakeBodyTv.setTextColor(Color.parseColor("#EBEBF5"));
        wakeBodyTv.setLineSpacing(0, 1.4f);
        LinearLayout.LayoutParams wbLp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        wbLp.topMargin = dp(4);
        wbLp.bottomMargin = dp(8);
        wakeBodyTv.setLayoutParams(wbLp);
        wakeCard.addView(wakeBodyTv);

        // Buttons row
        LinearLayout btnRow = new LinearLayout(this);
        btnRow.setOrientation(LinearLayout.HORIZONTAL);

        android.widget.Button wakeBtn = new android.widget.Button(this);
        wakeBtn.setText("🔒 تفعيل WakeLock");
        wakeBtn.setTextSize(12);
        wakeBtn.setTypeface(null, Typeface.BOLD);
        wakeBtn.setTextColor(Color.WHITE);
        wakeBtn.setBackground(makeRoundRect(dp(10), Color.parseColor("#1A4A1A")));
        LinearLayout.LayoutParams wb1 = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        wb1.rightMargin = dp(6);
        wakeBtn.setLayoutParams(wb1);
        wakeBtn.setOnClickListener(vv -> {
            acquireWakeLock();
            Toast.makeText(this, "✅ WakeLock مفعّل — البوت محمي لـ 4 ساعات", Toast.LENGTH_LONG).show();
        });
        btnRow.addView(wakeBtn);

        android.widget.Button battBtn = new android.widget.Button(this);
        battBtn.setText("⚙️ إعدادات ColorOS");
        battBtn.setTextSize(12);
        battBtn.setTypeface(null, Typeface.BOLD);
        battBtn.setTextColor(Color.parseColor("#32D74B"));
        battBtn.setBackground(makeRoundRect(dp(10), Color.parseColor("#1C1C1E")));
        LinearLayout.LayoutParams wb2 = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        battBtn.setLayoutParams(wb2);
        battBtn.setOnClickListener(vv -> showColorOsBatteryTips());
        btnRow.addView(battBtn);

        wakeCard.addView(btnRow);
        layout.addView(wakeCard);
        // ────────────────────────────────────────────────────────────────

        // ─── Auto-set localhost button ────────────────────────────────────
        LinearLayout autoCard = new LinearLayout(this);
        autoCard.setOrientation(LinearLayout.VERTICAL);
        autoCard.setBackground(makeRoundRect(dp(14), Color.parseColor("#0A2A0A")));
        autoCard.setPadding(dp(14), dp(14), dp(14), dp(14));
        LinearLayout.LayoutParams acLp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        acLp.bottomMargin = dp(10);
        autoCard.setLayoutParams(acLp);

        TextView autoTitle = new TextView(this);
        autoTitle.setText("⚡  ضبط تلقائي للرابط المحلي");
        autoTitle.setTextSize(14);
        autoTitle.setTypeface(null, Typeface.BOLD);
        autoTitle.setTextColor(Color.parseColor("#32D74B"));
        autoCard.addView(autoTitle);

        TextView autoBody = new TextView(this);
        autoBody.setText("إذا كنت تشغّل البوت على نفس الهاتف عبر Termux، اضغط لضبط الرابط تلقائياً.");
        autoBody.setTextSize(12);
        autoBody.setTextColor(Color.parseColor("#EBEBF5"));
        autoBody.setLineSpacing(0, 1.4f);
        LinearLayout.LayoutParams abLp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        abLp.topMargin = dp(4); abLp.bottomMargin = dp(10);
        autoBody.setLayoutParams(abLp);
        autoCard.addView(autoBody);

        android.widget.Button autoBtn = new android.widget.Button(this);
        autoBtn.setText("📱 ضبط http://localhost:5000");
        autoBtn.setTextSize(12);
        autoBtn.setTypeface(null, Typeface.BOLD);
        autoBtn.setTextColor(Color.BLACK);
        autoBtn.setBackground(makeRoundRect(dp(10), Color.parseColor("#32D74B")));
        LinearLayout.LayoutParams ab2 = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        autoBtn.setLayoutParams(ab2);
        autoBtn.setOnClickListener(vv -> {
            BotProfile active = getActiveProfile();
            active.url = "http://localhost:5000";
            saveProfiles();
            loadUrl("http://localhost:5000");
            buildDrawerContent();
            Toast.makeText(this, "✅ تم ضبط الرابط: http://localhost:5000", Toast.LENGTH_LONG).show();
        });
        autoCard.addView(autoBtn);
        layout.addView(autoCard);
        // ─────────────────────────────────────────────────────────────────

        new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
            .setTitle("📡 الهاتف كسيرفر (Termux)")
            .setView(scroll)
            .setPositiveButton("⚙️ ضبط الرابط يدوياً", (d, which) -> showSettingsDialog())
            .setNeutralButton("📥 تحميل Termux", (d, which) -> {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW,
                        Uri.parse("https://f-droid.org/packages/com.termux/")));
                } catch (Exception ignored) {}
            })
            .setNegativeButton("🔋 استثناء البطارية", (d, which) -> requestIgnoreBatteryOptimization())
            .show();
    }

    // ── Connection Error ──────────────────────────────────────────────────
    private void showConnectionError() {
        String url = getActiveUrl();
        boolean isLocal = url.contains("localhost") || url.contains("127.0.0.1") || url.contains("192.168.");
        String html =
            "<!DOCTYPE html><html dir='rtl'><head><meta charset='UTF-8'>" +
            "<meta name='viewport' content='width=device-width,initial-scale=1.0,maximum-scale=1.0'>" +
            "<style>" +
            "*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}" +
            "body{background:#050508;color:#fff;font-family:-apple-system,system-ui,'Segoe UI',sans-serif;" +
            "min-height:100vh;display:flex;flex-direction:column;align-items:center;" +
            "justify-content:center;gap:12px;padding:30px 20px;text-align:center;overflow-x:hidden}" +
            ".icon-wrap{width:90px;height:90px;border-radius:50%;" +
            "background:radial-gradient(circle,rgba(255,69,58,.22),rgba(255,69,58,0));" +
            "display:flex;align-items:center;justify-content:center;font-size:42px;" +
            "animation:pulse 2s ease-in-out infinite}" +
            "@keyframes pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.1);opacity:.75}}" +
            "h2{font-size:22px;font-weight:800;background:linear-gradient(135deg,#FF453A,#FF9F0A);" +
            "-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-top:4px}" +
            "p.sub{color:rgba(255,255,255,.42);font-size:12.5px;line-height:1.6;max-width:300px}" +
            ".url-box{background:rgba(10,132,255,.09);border:1px solid rgba(10,132,255,.22);border-radius:12px;" +
            "padding:9px 14px;font-size:11px;color:#5AC8FA;word-break:break-all;max-width:100%;width:90%}" +
            ".card{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);border-radius:18px;" +
            "padding:14px 16px;width:100%;max-width:340px;text-align:right;" +
            "-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px)}" +
            ".card-title{font-size:11px;font-weight:700;color:rgba(255,255,255,.4);margin-bottom:10px;text-align:center;letter-spacing:.8px;text-transform:uppercase}" +
            ".mode-row{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.05)}" +
            ".mode-row:last-child{border-bottom:none;padding-bottom:0}" +
            ".mode-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0;box-shadow:0 0 6px currentColor}" +
            ".mode-info{flex:1}" +
            ".mode-name{font-size:13px;font-weight:700;color:#fff}" +
            ".mode-desc{font-size:10.5px;color:rgba(255,255,255,.38);margin-top:1px}" +
            ".mode-rec{font-size:9.5px;font-weight:700;color:#32D74B;background:rgba(50,215,75,.12);" +
            "border:1px solid rgba(50,215,75,.25);border-radius:6px;padding:1px 6px;margin-right:6px}" +
            ".d-phone{background:#32D74B;color:#32D74B}" +
            ".d-rail{background:linear-gradient(135deg,#6366F1,#8B5CF6);color:#8B5CF6}" +
            ".d-replit{background:#0A84FF;color:#0A84FF}" +
            ".btns{display:flex;flex-direction:column;gap:8px;width:100%;max-width:340px}" +
            ".btn{width:100%;border:none;border-radius:15px;padding:14px 20px;" +
            "font-size:14px;font-weight:700;cursor:pointer;color:#fff;text-align:center;" +
            "letter-spacing:.2px;transition:opacity .15s}" +
            ".btn:active{opacity:.6;transform:scale(.97)}" +
            ".b-phone{background:linear-gradient(135deg,#32D74B,#30D158);color:#000;" +
            "box-shadow:0 4px 20px rgba(50,215,75,.4)}" +
            ".b-retry{background:linear-gradient(135deg,#0A84FF,#5AC8FA);box-shadow:0 4px 20px rgba(10,132,255,.3)}" +
            ".b-railway{background:rgba(99,102,241,.15);border:1px solid rgba(99,102,241,.3);color:#A5B4FC}" +
            ".b-settings{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1);color:rgba(255,255,255,.65)}" +
            ".b-drawer{background:rgba(191,90,242,.1);border:1px solid rgba(191,90,242,.22);color:#BF5AF2}" +
            ".sep{width:28px;height:2px;background:rgba(255,255,255,.08);border-radius:2px;margin:2px auto}" +
            ".ver{font-size:10px;color:rgba(255,255,255,.13);margin-top:8px}" +
            "</style></head><body>" +
            "<div class='icon-wrap'>📡</div>" +
            "<h2>تعذّر الاتصال</h2>" +
            "<p class='sub'>لا يمكن الوصول إلى البوت<br>تأكد أن Termux يعمل أو تحقق من الرابط</p>" +
            "<div class='url-box'>" + url + "</div>" +
            "<div class='card'>" +
            "<div class='card-title'>وضع الاستضافة</div>" +
            "<div class='mode-row'>" +
            "<div class='mode-dot d-phone'></div>" +
            "<div class='mode-info'><div class='mode-name'><span class='mode-rec'>موصى</span>الهاتف / Termux</div>" +
            "<div class='mode-desc'>node index.js  ←  شغّله في Termux</div></div></div>" +
            "<div class='mode-row'>" +
            "<div class='mode-dot d-rail'></div>" +
            "<div class='mode-info'><div class='mode-name'>Railway</div>" +
            "<div class='mode-desc'>سحابي 24/7 — railway.app</div></div></div>" +
            "<div class='mode-row'>" +
            "<div class='mode-dot d-replit'></div>" +
            "<div class='mode-info'><div class='mode-name'>Replit</div>" +
            "<div class='mode-desc'>تشغيل مباشر من المتصفح</div></div></div>" +
            "</div>" +
            "<div class='btns'>" +
            (isLocal ?
            "<button class='btn b-phone' onclick='Android.openPhoneHostHelp()'>📱 إعداد Termux كسيرفر</button>" :
            "<button class='btn b-phone' onclick='Android.openPhoneHostHelp()'>📱 استخدام الهاتف كسيرفر</button>") +
            "<button class='btn b-retry' onclick='location.reload()'>🔄 إعادة المحاولة</button>" +
            "<div class='sep'></div>" +
            "<button class='btn b-settings' onclick='Android.openSettings()'>⚙️ تغيير رابط السيرفر</button>" +
            "<button class='btn b-railway' onclick='Android.openRailwayHelp()'>🚂 النشر على Railway</button>" +
            "<button class='btn b-drawer' onclick='Android.openDrawer()'>☰ اختر بوتاً آخر</button>" +
            "</div>" +
            "<div class='ver'>DAVID V1 — v5.0</div>" +
            "</body></html>";
        webView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
    }

    // ── SwipeRefresh ──────────────────────────────────────────────────────
    private void setupSwipeRefresh() {
        swipeRefresh.setColorSchemeColors(
            Color.parseColor("#0A84FF"),
            Color.parseColor("#BF5AF2"),
            Color.parseColor("#32D74B")
        );
        swipeRefresh.setBackgroundColor(Color.BLACK);
        swipeRefresh.setOnRefreshListener(() -> webView.reload());
    }

    // ── Floating Menu Button Setup ────────────────────────────────────────
    private void setupFabMenu() {
        if (fabMenu == null) return;

        // Apply iOS 26 press animation
        addPressAnim(fabMenu);

        // Set top margin below status bar
        int sbH = getStatusBarHeight();
        if (fabMenu.getLayoutParams() instanceof androidx.coordinatorlayout.widget.CoordinatorLayout.LayoutParams) {
            androidx.coordinatorlayout.widget.CoordinatorLayout.LayoutParams lp =
                (androidx.coordinatorlayout.widget.CoordinatorLayout.LayoutParams) fabMenu.getLayoutParams();
            lp.setMargins(dp(12), sbH + dp(8), dp(12), 0);
            fabMenu.setLayoutParams(lp);
        }

        // Toggle drawer on click
        fabMenu.setOnClickListener(v -> {
            if (drawerLayout.isDrawerOpen(drawerPanel))
                drawerLayout.closeDrawer(drawerPanel);
            else
                drawerLayout.openDrawer(drawerPanel);
        });

        // Update FAB icon when drawer state changes
        drawerLayout.addDrawerListener(new DrawerLayout.SimpleDrawerListener() {
            @Override
            public void onDrawerOpened(View drawerView) {
                fabMenu.setText("✕");
            }
            @Override
            public void onDrawerClosed(View drawerView) {
                fabMenu.setText("☰");
            }
            @Override
            public void onDrawerSlide(View drawerView, float slideOffset) {
                // Fade FAB while drawer is sliding
                fabMenu.setAlpha(1f - slideOffset * 0.5f);
            }
        });
    }

    private void loadUrl(String url) {
        if (!url.startsWith("http://") && !url.startsWith("https://")) url = "http://" + url;
        webView.loadUrl(url);
    }

    // ── Nickname Changer ──────────────────────────────────────────────────
    private void changeNicknameInAllGroups(String nickname) {
        String safe = nickname.replace("\\","\\\\").replace("'","\\'").replace("\"","\\\"");
        String js =
            "(async function(){try{" +
            "var r=await apiFetch('/api/messenger/set-bot-nick-all'," +
            "{method:'POST',body:JSON.stringify({nickname:'" + safe + "'})});" +
            "Android.onNicknameResult(r.ok,r.error||'');" +
            "}catch(e){Android.onNicknameResult(false,e.message);}})();";
        webView.evaluateJavascript(js, null);
        Toast.makeText(this, "⏳ جاري تغيير الكنية…", Toast.LENGTH_SHORT).show();
    }

    // ── Home Shortcut ─────────────────────────────────────────────────────
    private void createHomeShortcut() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setAction(Intent.ACTION_VIEW);
        ShortcutInfoCompat shortcut = new ShortcutInfoCompat.Builder(this, "david_main")
            .setShortLabel("DAVID V1")
            .setLongLabel("DAVID V1 Bot Control")
            .setIcon(IconCompat.createWithResource(this, R.mipmap.ic_launcher))
            .setIntent(intent)
            .build();
        boolean done = ShortcutManagerCompat.requestPinShortcut(this, shortcut, null);
        Toast.makeText(this,
            done ? "✅ تمت إضافة الاختصار على الشاشة الرئيسية"
                 : "⚠️ المشغّل لا يدعم الاختصارات المثبّتة",
            Toast.LENGTH_LONG).show();
    }

    // ── Permissions ───────────────────────────────────────────────────────
    private void requestNeededPermissions() {
        String[] perms;
        if (Build.VERSION.SDK_INT >= 33) {
            perms = new String[]{
                Manifest.permission.CAMERA,
                Manifest.permission.RECORD_AUDIO,
                Manifest.permission.READ_MEDIA_IMAGES,
                Manifest.permission.READ_MEDIA_VIDEO,
                Manifest.permission.READ_MEDIA_AUDIO,
                Manifest.permission.POST_NOTIFICATIONS,
            };
        } else {
            perms = new String[]{
                Manifest.permission.CAMERA,
                Manifest.permission.RECORD_AUDIO,
                Manifest.permission.READ_EXTERNAL_STORAGE,
            };
        }
        ActivityCompat.requestPermissions(this, perms, 100);
    }

    // ── Activity Results ──────────────────────────────────────────────────
    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST && fileCallback != null) {
            Uri[] results = null;
            if (resultCode == Activity.RESULT_OK && data != null)
                results = new Uri[]{data.getData()};
            fileCallback.onReceiveValue(results);
            fileCallback = null;
        } else if (requestCode == IMAGE_PICK_REQUEST && resultCode == Activity.RESULT_OK && data != null) {
            Uri uri = data.getData();
            if (uri != null) {
                try {
                    android.graphics.Bitmap bmp = android.provider.MediaStore.Images.Media
                        .getBitmap(getContentResolver(), uri);
                    // Scale down to max 256×256 to save space in prefs
                    int maxSide = 256;
                    float scale = Math.min((float) maxSide / bmp.getWidth(), (float) maxSide / bmp.getHeight());
                    if (scale < 1f) bmp = Bitmap.createScaledBitmap(bmp,
                        (int)(bmp.getWidth() * scale), (int)(bmp.getHeight() * scale), true);

                    java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
                    bmp.compress(Bitmap.CompressFormat.JPEG, 88, baos);
                    botAvatarB64 = Base64.encodeToString(baos.toByteArray(), Base64.DEFAULT);
                    prefs.edit().putString(PREF_AVATAR_B64, botAvatarB64).apply();
                    buildDrawerContent();
                    Toast.makeText(this, "✅ تم تغيير صورة البوت", Toast.LENGTH_SHORT).show();
                } catch (Exception e) {
                    Toast.makeText(this, "❌ فشل تحميل الصورة: " + e.getMessage(), Toast.LENGTH_LONG).show();
                }
            }
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    // ── Back Key ──────────────────────────────────────────────────────────
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (drawerLayout.isDrawerOpen(drawerPanel)) {
                drawerLayout.closeDrawer(drawerPanel);
                return true;
            }
            if (webView.canGoBack()) {
                webView.goBack();
                return true;
            }
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public void onBackPressed() {
        if (drawerLayout.isDrawerOpen(drawerPanel)) {
            drawerLayout.closeDrawer(drawerPanel);
            return;
        }
        if (webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override protected void onPause()  { super.onPause();  webView.onPause(); }
    @Override protected void onResume() { super.onResume(); webView.onResume(); }
    @Override protected void onDestroy() {
        releaseWakeLock();
        if (webView != null) { webView.stopLoading(); webView.destroy(); }
        super.onDestroy();
    }

    // ── WakeLock Management (Phone-as-Host) ───────────────────────────────
    private void acquireWakeLock() {
        try {
            if (wakeLock == null) {
                PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
                if (pm != null) {
                    wakeLock = pm.newWakeLock(
                        PowerManager.PARTIAL_WAKE_LOCK,
                        "DAVID:ServerWakeLock"
                    );
                    wakeLock.setReferenceCounted(false);
                }
            }
            if (wakeLock != null && !wakeLock.isHeld()) {
                wakeLock.acquire(4 * 60 * 60 * 1000L); // 4 ساعات
            }
        } catch (Exception ignored) {}
    }

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
            }
        } catch (Exception ignored) {}
    }

    // ── Battery Optimization Exclusion ────────────────────────────────────
    private void requestIgnoreBatteryOptimization() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
                if (pm != null && !pm.isIgnoringBatteryOptimizations(getPackageName())) {
                    Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                    i.setData(Uri.parse("package:" + getPackageName()));
                    startActivity(i);
                }
            } catch (Exception ignored) {}
        }
    }

    // ── ColorOS/OPPO Battery Tips Dialog ──────────────────────────────────
    private void showColorOsBatteryTips() {
        ScrollView sv = new ScrollView(this);
        LinearLayout ll = new LinearLayout(this);
        ll.setOrientation(LinearLayout.VERTICAL);
        ll.setPadding(dp(4), dp(4), dp(4), dp(4));
        sv.addView(ll);

        String[] steps = {
            "① الإعدادات ← البطارية ← الاستهلاك الذكي",
            "   ← ابحث عن [DAVID V1] ← اختر: لا تُحسِّن",
            "",
            "② الإعدادات ← التطبيقات ← [DAVID V1]",
            "   ← استهلاك البطارية ← تشغيل في الخلفية: مسموح",
            "",
            "③ الإعدادات ← البطارية ← توفير الطاقة",
            "   ← إضافة [DAVID V1] إلى القائمة البيضاء",
            "",
            "④ الإعدادات ← الخصوصية ← الصلاحيات الخاصة",
            "   ← التشغيل التلقائي ← فعّل لـ [DAVID V1]",
            "",
            "⑤ من نافذة 'الهاتف كسيرفر' اضغط:",
            "   [استثناء من توفير البطارية]",
        };

        for (String step : steps) {
            TextView tv = new TextView(this);
            tv.setText(step);
            tv.setTextColor(step.isEmpty() ? Color.TRANSPARENT : Color.parseColor("#EBEBF5"));
            tv.setTextSize(step.startsWith("  ") ? 12 : 13);
            tv.setPadding(0, dp(2), 0, dp(2));
            tv.setTypeface(null, step.startsWith("①") || step.startsWith("②") ||
                step.startsWith("③") || step.startsWith("④") || step.startsWith("⑤")
                ? Typeface.BOLD : Typeface.NORMAL);
            ll.addView(tv);
        }

        new AlertDialog.Builder(this)
            .setTitle("⚡ إعدادات ColorOS لـ OPPO")
            .setView(sv)
            .setPositiveButton("✅ فهمت", null)
            .setNeutralButton("⚙️ إعدادات البطارية", (d, w) -> {
                try {
                    startActivity(new Intent(Settings.ACTION_BATTERY_SAVER_SETTINGS));
                } catch (Exception ignored) {}
            })
            .show()
            .getWindow().setBackgroundDrawable(makeRoundRect(dp(16), Color.parseColor("#1C1C1E")));
    }

    // ── Logo Fallback ─────────────────────────────────────────────────────
    private View makeLogoFallback() {
        TextView logo = new TextView(this);
        logo.setText(appDisplayName.isEmpty() ? "D" : String.valueOf(appDisplayName.charAt(0)).toUpperCase());
        logo.setTextSize(20);
        logo.setTypeface(null, Typeface.BOLD);
        logo.setTextColor(Color.WHITE);
        logo.setGravity(Gravity.CENTER);
        try {
            String c1 = getActiveProfile().color;
            int clr = Color.parseColor(c1);
            int dark = Color.argb(255,
                Math.max(0, Color.red(clr) - 60),
                Math.max(0, Color.green(clr) - 60),
                Math.max(0, Color.blue(clr) - 60));
            GradientDrawable gd = new GradientDrawable(
                GradientDrawable.Orientation.TOP_BOTTOM, new int[]{clr, dark});
            gd.setCornerRadius(dp(21));
            logo.setBackground(gd);
        } catch (Exception e) {
            logo.setBackground(makeRoundRect(dp(21), Color.parseColor("#0A84FF")));
        }
        logo.setLayoutParams(new LinearLayout.LayoutParams(dp(42), dp(42)));
        return logo;
    }

    // ── Avatar + Name Dialog ──────────────────────────────────────────────
    private void showAvatarAndNameDialog() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(dp(20), dp(16), dp(20), dp(8));
        layout.setBackgroundColor(Color.parseColor("#1C1C1E"));

        // Current avatar preview
        LinearLayout avatarRow = new LinearLayout(this);
        avatarRow.setOrientation(LinearLayout.HORIZONTAL);
        avatarRow.setGravity(Gravity.CENTER_VERTICAL);

        View prevView;
        if (botAvatarB64 != null) {
            try {
                byte[] imgBytes = Base64.decode(botAvatarB64, Base64.DEFAULT);
                Bitmap raw = BitmapFactory.decodeByteArray(imgBytes, 0, imgBytes.length);
                ImageView iv = new ImageView(this);
                iv.setImageBitmap(circleBitmap(raw));
                iv.setScaleType(ImageView.ScaleType.CENTER_CROP);
                iv.setLayoutParams(new LinearLayout.LayoutParams(dp(52), dp(52)));
                prevView = iv;
            } catch (Exception e) { prevView = makeLogoFallback(); }
        } else {
            prevView = makeLogoFallback();
        }
        avatarRow.addView(prevView);

        TextView previewLabel = new TextView(this);
        previewLabel.setText("  الصورة الحالية — اضغط 'تغيير' لاختيار جديدة");
        previewLabel.setTextSize(12);
        previewLabel.setTextColor(Color.parseColor("#8E8E93"));
        LinearLayout.LayoutParams plLp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        plLp.leftMargin = dp(8);
        previewLabel.setLayoutParams(plLp);
        avatarRow.addView(previewLabel);
        layout.addView(avatarRow);

        // App display name field
        TextView nameLbl = new TextView(this);
        nameLbl.setText("اسم التطبيق في الـ Header:");
        nameLbl.setTextSize(12);
        nameLbl.setTextColor(Color.parseColor("#8E8E93"));
        LinearLayout.LayoutParams lblLp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lblLp.topMargin = dp(18);
        nameLbl.setLayoutParams(lblLp);
        layout.addView(nameLbl);

        EditText nameEt = makeInput(appDisplayName, "DAVID V1");
        layout.addView(nameEt);

        // Reset avatar button
        android.widget.Button resetBtn = new android.widget.Button(this);
        resetBtn.setText("🔄 حذف الصورة (العودة لحرف D)");
        resetBtn.setTextSize(12);
        resetBtn.setTextColor(Color.parseColor("#FF453A"));
        resetBtn.setBackground(makeRoundRect(dp(10), Color.parseColor("#2C1010")));
        LinearLayout.LayoutParams rLp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        rLp.topMargin = dp(14);
        resetBtn.setLayoutParams(rLp);
        resetBtn.setOnClickListener(vv -> {
            botAvatarB64 = null;
            prefs.edit().remove(PREF_AVATAR_B64).apply();
            buildDrawerContent();
            Toast.makeText(this, "✅ تمت إزالة الصورة", Toast.LENGTH_SHORT).show();
        });
        layout.addView(resetBtn);

        ScrollView sv = new ScrollView(this);
        sv.addView(layout);

        new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
            .setTitle("🖼️ صورة البوت / اسم التطبيق")
            .setView(sv)
            .setPositiveButton("🖼️ تغيير الصورة", (d, which) -> {
                Intent pick = new Intent(Intent.ACTION_PICK,
                    android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI);
                pick.setType("image/*");
                startActivityForResult(Intent.createChooser(pick, "اختر صورة البوت"), IMAGE_PICK_REQUEST);
            })
            .setNeutralButton("💾 حفظ الاسم", (d, which) -> {
                String newName = nameEt.getText().toString().trim();
                if (newName.isEmpty()) newName = "DAVID V1";
                appDisplayName = newName;
                prefs.edit().putString(PREF_APP_DISPLAY_NAME, appDisplayName).apply();
                buildDrawerContent();
                Toast.makeText(this, "✅ تم حفظ الاسم: " + appDisplayName, Toast.LENGTH_SHORT).show();
            })
            .setNegativeButton("إلغاء", null)
            .show()
            .getWindow().setBackgroundDrawable(makeRoundRect(dp(16), Color.parseColor("#1C1C1E")));
    }

    // ── Ping Bot Connection ───────────────────────────────────────────────
    private void pingBotServer(TextView dotTv, TextView labelTv, android.widget.Button btn) {
        String pingUrl = getActiveUrl() + "/health";
        btn.setEnabled(false);
        btn.setText("⏳");
        dotTv.setTextColor(Color.parseColor("#FF9F0A"));
        labelTv.setText("جاري الفحص…");
        new Thread(() -> {
            boolean ok = false;
            long latency = 0;
            try {
                long t = System.currentTimeMillis();
                java.net.URL u = new java.net.URL(pingUrl);
                java.net.HttpURLConnection c = (java.net.HttpURLConnection) u.openConnection();
                c.setConnectTimeout(6000);
                c.setReadTimeout(6000);
                c.setRequestMethod("GET");
                int code = c.getResponseCode();
                latency = System.currentTimeMillis() - t;
                ok = (code >= 200 && code < 400);
                c.disconnect();
            } catch (Exception ignored) {}
            final boolean finalOk = ok;
            final long finalMs = latency;
            new Handler(Looper.getMainLooper()).post(() -> {
                btn.setEnabled(true);
                btn.setText("🔍");
                if (finalOk) {
                    dotTv.setTextColor(Color.parseColor("#32D74B"));
                    labelTv.setText("متصل ✓  (" + finalMs + "ms)");
                } else {
                    dotTv.setTextColor(Color.parseColor("#FF453A"));
                    labelTv.setText("غير متصل ✗  — تحقق من الرابط");
                }
            });
        }).start();
    }

    // ── Copy URL to Clipboard ─────────────────────────────────────────────
    private void copyUrlToClipboard() {
        try {
            ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            if (cm != null) {
                cm.setPrimaryClip(ClipData.newPlainText("bot_url", getActiveUrl()));
                Toast.makeText(this, "✅ تم نسخ رابط البوت", Toast.LENGTH_SHORT).show();
            }
        } catch (Exception e) {
            Toast.makeText(this, "❌ فشل النسخ", Toast.LENGTH_SHORT).show();
        }
    }

    // ── Drawing Helpers ───────────────────────────────────────────────────
    private GradientDrawable makeRoundRect(int radius, int color) {
        GradientDrawable d = new GradientDrawable();
        d.setShape(GradientDrawable.RECTANGLE);
        d.setCornerRadius(radius);
        d.setColor(color);
        return d;
    }

    private android.graphics.drawable.Drawable makeSelector(int radius, int normal, int pressed) {
        StateListDrawable sl = new StateListDrawable();
        sl.addState(new int[]{android.R.attr.state_pressed}, makeRoundRect(radius, pressed));
        sl.addState(new int[]{}, makeRoundRect(radius, normal));
        return sl;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private int getStatusBarHeight() {
        int resId = getResources().getIdentifier("status_bar_height", "dimen", "android");
        return resId > 0 ? getResources().getDimensionPixelSize(resId) : 0;
    }

    private TextView makeLabel(String text) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextColor(Color.parseColor("#8E8E93"));
        tv.setTextSize(12);
        tv.setPadding(0, dp(10), 0, dp(4));
        return tv;
    }

    private EditText makeInput(String value, String hint) {
        EditText et = new EditText(this);
        et.setText(value);
        et.setHint(hint);
        et.setTextColor(Color.WHITE);
        et.setHintTextColor(Color.parseColor("#48484A"));
        et.setBackground(null);
        et.setPadding(0, dp(4), 0, dp(8));
        et.setSelectAllOnFocus(true);
        return et;
    }

    // ══════════════════════════════════════════════════════════════════════
    //  BOT ENGINE RUNNER — run node index.js via Termux background service
    // ══════════════════════════════════════════════════════════════════════

    /** Returns true if Termux is installed on the device. */
    private boolean isTermuxInstalled() {
        try {
            getPackageManager().getPackageInfo(TERMUX_PKG, 0);
            return true;
        } catch (Exception e) { return false; }
    }

    /** Starts `node index.js` inside Termux as a background process (no terminal window). */
    private void startBotEngine() {
        if (!isTermuxInstalled()) {
            new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
                .setTitle("❌ Termux غير مثبت")
                .setMessage("يحتاج محرك البوت إلى Termux مثبتاً مع Node.js.\n\nالخطوات:\n1. حمّل Termux من F-Droid\n2. شغّل: pkg install nodejs git\n3. حمّل ملفات البوت في /sdcard/DAVID-V1\n4. أعطِ صلاحية RUN_COMMAND من إعدادات Termux")
                .setPositiveButton("📥 تحميل Termux", (d, w) -> {
                    try { startActivity(new Intent(Intent.ACTION_VIEW,
                        Uri.parse("https://f-droid.org/packages/com.termux/"))); }
                    catch (Exception ignored) {}
                })
                .setNegativeButton("إغلاق", null)
                .show();
            return;
        }
        String botPath = prefs.getString(PREF_BOT_PATH, "/sdcard/DAVID-V1");
        // Build the shell command: kill any existing node, then start fresh in background
        String cmd = "cd '" + botPath + "' && " +
                     "pkill -f 'node index.js' 2>/dev/null; " +
                     "nohup node index.js > '" + botPath + "/bot.log' 2>&1 &";
        Intent i = new Intent();
        i.setClassName(TERMUX_PKG, TERMUX_RUN_SVC);
        i.setAction(TERMUX_RUN_ACTION);
        i.putExtra("com.termux.RUN_COMMAND_PATH",
            "/data/data/com.termux/files/usr/bin/sh");
        i.putExtra("com.termux.RUN_COMMAND_ARGUMENTS", new String[]{"-c", cmd});
        i.putExtra("com.termux.RUN_COMMAND_WORKDIR", botPath);
        i.putExtra("com.termux.RUN_COMMAND_BACKGROUND", true);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                startForegroundService(i);
            else
                startService(i);
            Toast.makeText(this, "⏳ جاري تشغيل البوت في الخلفية…", Toast.LENGTH_LONG).show();
            // After 5s: check status → if online load dashboard, update profile URL
            botStatusHandler.postDelayed(() ->
                checkBotEngineStatus(() -> {
                    buildDrawerContent();
                    if (botEngineRunning) {
                        // Ensure active profile points to localhost
                        BotProfile act = getActiveProfile();
                        if (!act.url.contains("localhost") && !act.url.contains("127.0.0.1")) {
                            act.url = "http://localhost:5000";
                            saveProfiles();
                        }
                        loadUrl("http://localhost:5000");
                        Toast.makeText(this, "✅ البوت يعمل — تحميل الواجهة…", Toast.LENGTH_SHORT).show();
                    }
                }), 5000);
        } catch (SecurityException se) {
            new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
                .setTitle("❌ صلاحية مرفوضة")
                .setMessage("افتح تطبيق Termux ثم شغّل الأمر:\n\ntermux-open-url termux://settings\n\nأو اذهب إلى:\nTermux ← Settings ← Allow External Apps\nوفعّل الخيار.")
                .setPositiveButton("فهمت", null)
                .show();
        } catch (Exception e) {
            Toast.makeText(this, "❌ " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    /** Kills the node process via Termux. */
    private void stopBotEngine() {
        if (!isTermuxInstalled()) return;
        Intent i = new Intent();
        i.setClassName(TERMUX_PKG, TERMUX_RUN_SVC);
        i.setAction(TERMUX_RUN_ACTION);
        i.putExtra("com.termux.RUN_COMMAND_PATH",
            "/data/data/com.termux/files/usr/bin/sh");
        i.putExtra("com.termux.RUN_COMMAND_ARGUMENTS",
            new String[]{"-c", "pkill -f 'node index.js'; pkill -f node"});
        i.putExtra("com.termux.RUN_COMMAND_WORKDIR", "/sdcard");
        i.putExtra("com.termux.RUN_COMMAND_BACKGROUND", true);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                startForegroundService(i);
            else
                startService(i);
            botEngineRunning = false;
            buildDrawerContent();
            // Also reload WebView with connection error after 1s
            botStatusHandler.postDelayed(() -> {
                checkBotEngineStatus(null);
                buildDrawerContent();
            }, 2000);
            Toast.makeText(this, "✅ تم إيقاف البوت", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, "❌ " + e.getMessage(), Toast.LENGTH_SHORT).show();
        }
    }

    /** Stops then starts the bot with a 2-second gap. */
    private void restartBotEngine() {
        Toast.makeText(this, "🔄 جاري إعادة تشغيل البوت…", Toast.LENGTH_SHORT).show();
        stopBotEngine();
        botStatusHandler.postDelayed(this::startBotEngine, 2500);
    }

    /**
     * Pings localhost:5000 on a background thread.
     * Updates {@link #botEngineRunning} then runs {@code onUpdate} on the main thread.
     */
    private void checkBotEngineStatus(Runnable onUpdate) {
        new Thread(() -> {
            boolean alive = false;
            try {
                java.net.URL u = new java.net.URL("http://localhost:5000");
                java.net.HttpURLConnection c = (java.net.HttpURLConnection) u.openConnection();
                c.setConnectTimeout(1500);
                c.setReadTimeout(1500);
                c.connect();
                alive = (c.getResponseCode() < 600);
                c.disconnect();
            } catch (Exception ignored) {}
            final boolean isAlive = alive;
            botStatusHandler.post(() -> {
                botEngineRunning = isAlive;
                if (onUpdate != null) onUpdate.run();
            });
        }).start();
    }

    /** Starts the periodic status monitor (pings every 8 seconds). */
    private void startBotStatusMonitor() {
        stopBotStatusMonitor(); // avoid duplicate runnables
        botStatusRunnable = new Runnable() {
            @Override public void run() {
                checkBotEngineStatus(() -> buildDrawerContent());
                botStatusHandler.postDelayed(this, 8000);
            }
        };
        botStatusHandler.postDelayed(botStatusRunnable, 2000);
    }

    /** Stops the periodic status monitor. */
    private void stopBotStatusMonitor() {
        if (botStatusRunnable != null) {
            botStatusHandler.removeCallbacks(botStatusRunnable);
            botStatusRunnable = null;
        }
    }

    /** Dialog to configure the bot folder path. */
    private void showBotEngineSettingsDialog() {
        String cur = prefs.getString(PREF_BOT_PATH, "/sdcard/DAVID-V1");
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setBackgroundColor(Color.parseColor("#1C1C1E"));
        layout.setPadding(dp(20), dp(16), dp(20), dp(16));

        layout.addView(makeLabel("📁 مسار مجلد البوت (يحتوي index.js)"));
        EditText pathEt = makeInput(cur, "/sdcard/DAVID-V1");
        layout.addView(pathEt);

        // Quick-fill shortcuts
        String[] presets = {"/sdcard/DAVID-V1", "/storage/emulated/0/DAVID-V1",
                            "/data/data/com.termux/files/home/DAVID-V1"};
        for (String p : presets) {
            TextView pv = new TextView(this);
            pv.setText("📌 " + p);
            pv.setTextSize(11);
            pv.setTextColor(Color.parseColor("#0A84FF"));
            pv.setPadding(0, dp(6), 0, dp(2));
            pv.setOnClickListener(v -> pathEt.setText(p));
            layout.addView(pv);
        }

        TextView hint2 = new TextView(this);
        hint2.setText("\nملاحظة: تأكد من تفعيل 'Allow External Apps' في إعدادات Termux قبل أول تشغيل.");
        hint2.setTextSize(11);
        hint2.setTextColor(Color.parseColor("#636366"));
        hint2.setLineSpacing(0, 1.4f);
        layout.addView(hint2);

        new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
            .setTitle("⚙️ إعدادات محرك البوت")
            .setView(layout)
            .setPositiveButton("💾 حفظ", (d, w) -> {
                String p = pathEt.getText().toString().trim();
                if (!p.isEmpty()) {
                    prefs.edit().putString(PREF_BOT_PATH, p).apply();
                    buildDrawerContent();
                    Toast.makeText(this, "✅ مسار محفوظ", Toast.LENGTH_SHORT).show();
                }
            })
            .setNeutralButton("📱 ضبط localhost", (d, w) -> {
                BotProfile active = getActiveProfile();
                active.url = "http://localhost:5000";
                saveProfiles();
                loadUrl("http://localhost:5000");
                buildDrawerContent();
                Toast.makeText(this, "✅ رابط البوت: localhost:5000", Toast.LENGTH_SHORT).show();
            })
            .setNegativeButton("❌ إلغاء", null)
            .show();
    }
}

package com.djamel.davidbot;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
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
    private static final int    FILE_CHOOSER_REQUEST = 1001;
    private static final String PREF_PROFILES        = "bot_profiles_v2";
    private static final String PREF_ACTIVE_IDX      = "active_profile_idx";
    private static final String DEFAULT_URL          = "http://localhost:5000";

    // ── Views ────────────────────────────────────────────────────────────
    private DrawerLayout       drawerLayout;
    private WebView            webView;
    private ProgressBar        progressBar;
    private SwipeRefreshLayout swipeRefresh;
    private LinearLayout       drawerPanel;

    // ── State ────────────────────────────────────────────────────────────
    private SharedPreferences prefs;
    private ValueCallback<Uri[]> fileCallback;
    private final List<BotProfile> profiles = new ArrayList<>();
    private int activeIdx = 0;

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

        loadProfiles();
        setupWebView();
        buildDrawerContent();
        setupSwipeRefresh();
        requestNeededPermissions();
        loadUrl(getActiveUrl());
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
            "var m=document.querySelector('meta[name=viewport]');" +
            "if(m)m.setAttribute('content','width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no,viewport-fit=cover');" +
            "document.body&&document.body.classList.add('android-app');" +
            "if(!document.getElementById('_dv_a')){var s=document.createElement('style');s.id='_dv_a';" +
            "s.textContent=':root{--android-app:1;--app-accent:" + accent + "}" +
            "body.android-app{padding-top:env(safe-area-inset-top,0)!important}';" +
            "document.head&&document.head.appendChild(s);}" +
            "if(!window._drawerHint){window._drawerHint=true;" +
            "var h=document.createElement('div');" +
            "h.style.cssText='position:fixed;left:0;top:50%;transform:translateY(-50%);width:4px;height:48px;" +
            "background:var(--app-accent,#0A84FF);border-radius:0 4px 4px 0;opacity:.5;z-index:9999;cursor:pointer;';" +
            "h.title='القائمة الجانبية';" +
            "h.onclick=function(){if(window.Android)Android.openDrawer();};" +
            "document.body&&document.body.appendChild(h);}" +
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

        TextView logo = new TextView(this);
        logo.setText("D");
        logo.setTextSize(20);
        logo.setTypeface(null, Typeface.BOLD);
        logo.setTextColor(Color.WHITE);
        logo.setGravity(Gravity.CENTER);
        logo.setBackground(makeRoundRect(dp(10), Color.parseColor(getActiveProfile().color)));
        logo.setLayoutParams(new LinearLayout.LayoutParams(dp(42), dp(42)));
        logoRow.addView(logo);

        LinearLayout titleBlock = new LinearLayout(this);
        titleBlock.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams tbLp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        tbLp.leftMargin = dp(12);
        titleBlock.setLayoutParams(tbLp);

        TextView titleTv = new TextView(this);
        titleTv.setText("DAVID V1");
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

        // ── Phone as host ──
        addSectionLabel(content, "الهاتف كسيرفر");

        LinearLayout hostBtn = makeActionBtn("📡  إعداد الهاتف كسيرفر", "#0A84FF");
        hostBtn.setOnClickListener(v -> { drawerLayout.closeDrawer(drawerPanel); showPhoneAsHostDialog(); });
        content.addView(hostBtn);

        addDivider(content);

        // ── Settings ──
        addSectionLabel(content, "الإعدادات");

        LinearLayout settBtn = makeActionBtn("⚙️  إعدادات التطبيق", "#636366");
        settBtn.setOnClickListener(v -> { drawerLayout.closeDrawer(drawerPanel); showSettingsDialog(); });
        content.addView(settBtn);

        // Version footer
        TextView footer = new TextView(this);
        footer.setText("DAVID V1  •  v4.0  •  © 2025 DJAMEL");
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
        return row;
    }

    private LinearLayout makeActionBtn(String text, String color) {
        LinearLayout btn = new LinearLayout(this);
        btn.setOrientation(LinearLayout.HORIZONTAL);
        btn.setGravity(Gravity.CENTER_VERTICAL);
        btn.setPadding(dp(14), dp(13), dp(14), dp(13));
        btn.setBackground(makeSelector(dp(10), Color.parseColor("#1C1C1E"), Color.parseColor("#2C2C2E")));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = dp(6);
        btn.setLayoutParams(lp);

        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextSize(14);
        tv.setTextColor(Color.parseColor(color));
        tv.setTypeface(null, Typeface.BOLD);
        tv.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        btn.addView(tv);

        TextView arrow = new TextView(this);
        arrow.setText("›");
        arrow.setTextSize(18);
        arrow.setTextColor(Color.parseColor("#48484A"));
        arrow.setGravity(Gravity.CENTER);
        arrow.setLayoutParams(new LinearLayout.LayoutParams(dp(20), dp(20)));
        btn.addView(arrow);

        return btn;
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
        EditText urlInput = makeInput(active.url, "https://xxx.railway.app");
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
        EditText urlInput = makeInput("", "https://xxx.railway.app  أو  http://localhost:5000");
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

        new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
            .setTitle("📡 استخدام الهاتف كسيرفر")
            .setView(scroll)
            .setPositiveButton("⚙️ ضبط الرابط", (d, which) -> showSettingsDialog())
            .setNeutralButton("📥 تحميل Termux", (d, which) -> {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW,
                        Uri.parse("https://f-droid.org/packages/com.termux/")));
                } catch (Exception ignored) {}
            })
            .setNegativeButton("✕ إغلاق", null)
            .show();
    }

    // ── Connection Error ──────────────────────────────────────────────────
    private void showConnectionError() {
        String url = getActiveUrl();
        String html =
            "<html><head><meta charset='UTF-8'>" +
            "<meta name='viewport' content='width=device-width,initial-scale=1.0'>" +
            "<style>*{box-sizing:border-box;margin:0;padding:0}" +
            "body{background:#000;color:#fff;font-family:-apple-system,system-ui,sans-serif;" +
            "display:flex;align-items:center;justify-content:center;min-height:100vh;" +
            "flex-direction:column;gap:12px;padding:32px;text-align:center}" +
            "h2{color:#FF453A;font-size:22px;font-weight:700}" +
            "p{color:rgba(255,255,255,.6);font-size:14px;line-height:1.6}" +
            "code{color:#0A84FF;background:rgba(10,132,255,.12);padding:3px 10px;border-radius:6px;font-size:12px}" +
            "button{width:100%;max-width:300px;border:none;border-radius:14px;padding:14px;" +
            "font-size:15px;font-weight:700;cursor:pointer;color:#fff;transition:opacity .15s;margin-top:4px}" +
            "button:active{opacity:.65}" +
            ".b1{background:#0A84FF}.b2{background:rgba(255,255,255,.1)}.b3{background:rgba(191,90,242,.25);color:#BF5AF2}" +
            "</style></head><body>" +
            "<div style='font-size:58px'>📡</div>" +
            "<h2>تعذّر الاتصال</h2>" +
            "<p>الرابط الحالي:<br><code>" + url + "</code></p>" +
            "<p>تأكد أن البوت يعمل<br>وأن الرابط صحيح</p>" +
            "<button class='b1' onclick='location.reload()'>🔄 إعادة المحاولة</button>" +
            "<button class='b2' onclick='Android.openSettings()'>⚙️ تغيير الرابط</button>" +
            "<button class='b3' onclick='Android.openDrawer()'>☰ اختر بوتاً آخر</button>" +
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

    @Override protected void onPause()   { super.onPause();   webView.onPause();   }
    @Override protected void onResume()  { super.onResume();  webView.onResume();  }
    @Override protected void onDestroy() {
        if (webView != null) { webView.stopLoading(); webView.destroy(); }
        super.onDestroy();
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
}

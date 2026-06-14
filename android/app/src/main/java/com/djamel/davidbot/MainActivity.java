package com.djamel.davidbot;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.KeyEvent;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
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
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

public class MainActivity extends AppCompatActivity {

    private WebView webView;
    private ProgressBar progressBar;
    private SwipeRefreshLayout swipeRefresh;
    private SharedPreferences prefs;

    private static final int FILE_CHOOSER_REQUEST = 1001;
    private ValueCallback<Uri[]> fileCallback;

    private static final String DEFAULT_URL  = "http://localhost:5000";
    private static final String PREF_URL     = "server_url";

    // ─── JavaScript Bridge ───────────────────────────────────────────────
    public class AndroidBridge {

        @JavascriptInterface
        public void openSettings() {
            new Handler(Looper.getMainLooper()).post(() -> showSettingsDialog());
        }

        @JavascriptInterface
        public void showToast(String msg) {
            new Handler(Looper.getMainLooper()).post(() ->
                Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show());
        }

        @JavascriptInterface
        public String getServerUrl() {
            return prefs.getString(PREF_URL, DEFAULT_URL);
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

    // ─── Lifecycle ───────────────────────────────────────────────────────
    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Full-screen dark mode
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

        prefs       = getSharedPreferences("david_prefs", MODE_PRIVATE);
        progressBar = findViewById(R.id.progress_bar);
        swipeRefresh= findViewById(R.id.swipe_refresh);
        webView     = findViewById(R.id.web_view);

        setupWebView();
        setupSwipeRefresh();
        requestNeededPermissions();

        loadUrl(prefs.getString(PREF_URL, DEFAULT_URL));
    }

    // ─── WebView Setup ───────────────────────────────────────────────────
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
            ") AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36 DavidBotApp/3.0"
        );

        webView.addJavascriptInterface(new AndroidBridge(), "Android");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                String url = r.getUrl().toString();
                if (url.startsWith("http://") || url.startsWith("https://")) {
                    v.loadUrl(url); return true;
                }
                try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception ignored) {}
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
            public void onReceivedError(WebView v, int code, String desc, String url) {
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
        webView.evaluateJavascript(
            "(function(){" +
            "var m=document.querySelector('meta[name=viewport]');" +
            "if(m)m.setAttribute('content','width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no,viewport-fit=cover');" +
            "document.body&&document.body.classList.add('android-app');" +
            "if(!document.getElementById('_dv_a')){var s=document.createElement('style');s.id='_dv_a';" +
            "s.textContent=':root{--android-app:1}body.android-app{padding-top:env(safe-area-inset-top,0)!important}';" +
            "document.head&&document.head.appendChild(s);}})();",
            null
        );
    }

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

    // ─── Connection Error Page ───────────────────────────────────────────
    private void showConnectionError() {
        String url = prefs.getString(PREF_URL, DEFAULT_URL);
        String html =
            "<html><head><meta charset='UTF-8'>" +
            "<meta name='viewport' content='width=device-width,initial-scale=1.0'>" +
            "<style>" +
            "*{box-sizing:border-box;margin:0;padding:0}" +
            "body{background:#000;color:#fff;font-family:-apple-system,system-ui,sans-serif;" +
            "display:flex;align-items:center;justify-content:center;min-height:100vh;" +
            "flex-direction:column;gap:14px;padding:32px;text-align:center}" +
            "h2{color:#FF453A;font-size:22px;font-weight:700}" +
            "p{color:rgba(255,255,255,.6);font-size:14px;line-height:1.6}" +
            "code{color:#0A84FF;background:rgba(10,132,255,.12);padding:3px 10px;border-radius:6px;font-size:12px}" +
            "button{width:100%;max-width:300px;border:none;border-radius:14px;padding:14px;" +
            "font-size:15px;font-weight:700;cursor:pointer;color:#fff;transition:opacity .2s}" +
            "button:active{opacity:.7}" +
            ".primary{background:#0A84FF}.secondary{background:rgba(255,255,255,.12)}" +
            "</style></head><body>" +
            "<div style='font-size:60px'>📡</div>" +
            "<h2>تعذّر الاتصال</h2>" +
            "<p>الرابط الحالي:<br><code>" + url + "</code></p>" +
            "<p>تأكد أن البوت يعمل<br>وأن الرابط صحيح في الإعدادات</p>" +
            "<button class='primary' onclick='location.reload()'>🔄 إعادة المحاولة</button>" +
            "<button class='secondary' onclick='Android.openSettings()'>⚙️ تغيير الرابط</button>" +
            "</body></html>";
        webView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
    }

    // ─── Menu ────────────────────────────────────────────────────────────
    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        menu.add(0, 1, 0, "⚙️").setShowAsAction(MenuItem.SHOW_AS_ACTION_ALWAYS);
        menu.add(0, 2, 1, "🔄").setShowAsAction(MenuItem.SHOW_AS_ACTION_ALWAYS);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == 1) { showSettingsDialog(); return true; }
        if (item.getItemId() == 2) { webView.reload(); return true; }
        return super.onOptionsItemSelected(item);
    }

    // ─── Settings Dialog ─────────────────────────────────────────────────
    private void showSettingsDialog() {
        String currentUrl = prefs.getString(PREF_URL, DEFAULT_URL);

        // Build the dialog layout
        ScrollView scroll = new ScrollView(this);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setBackgroundColor(Color.parseColor("#1C1C1E"));
        layout.setPadding(52, 28, 52, 28);
        scroll.addView(layout);

        // ─ Server URL ─
        layout.addView(makeLabel("🔗 رابط السيرفر (Railway / localhost)"));
        EditText urlInput = makeInput(currentUrl, "https://xxx.railway.app  أو  http://localhost:5000");
        layout.addView(urlInput);

        // ─ Nickname ─
        layout.addView(makeLabel("✏️ كنية البوت في كل الغروبات"));
        layout.addView(makeLabel("(اتركه فارغاً لعدم التغيير)"));
        EditText nickInput = makeInput("", "مثال: DAVID 🤖 أو اسمك");
        layout.addView(nickInput);

        // ─ Shortcut note ─
        TextView note = new TextView(this);
        note.setText("💡 زر 'اختصار' يضيف أيقونة التطبيق على الشاشة الرئيسية");
        note.setTextColor(Color.parseColor("#636366"));
        note.setTextSize(11);
        note.setPadding(0, 20, 0, 0);
        layout.addView(note);

        new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
            .setTitle("⚙️ إعدادات DAVID V1")
            .setView(scroll)
            .setPositiveButton("💾 حفظ", (d, w) -> {
                String newUrl = urlInput.getText().toString().trim();
                if (!newUrl.isEmpty()) {
                    prefs.edit().putString(PREF_URL, newUrl).apply();
                    loadUrl(newUrl);
                    Toast.makeText(this, "✅ تم حفظ الرابط", Toast.LENGTH_SHORT).show();
                }
                String nick = nickInput.getText().toString().trim();
                if (!nick.isEmpty()) changeNicknameInAllGroups(nick);
            })
            .setNeutralButton("📱 اختصار", (d, w) -> createHomeShortcut())
            .setNegativeButton("❌ إلغاء", null)
            .show();
    }

    private TextView makeLabel(String text) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextColor(Color.parseColor("#8E8E93"));
        tv.setTextSize(12);
        tv.setPadding(0, 12, 0, 6);
        return tv;
    }

    private EditText makeInput(String value, String hint) {
        EditText et = new EditText(this);
        et.setText(value);
        et.setHint(hint);
        et.setTextColor(Color.WHITE);
        et.setHintTextColor(Color.parseColor("#48484A"));
        et.setBackground(null);
        et.setPadding(0, 6, 0, 10);
        et.setSelectAllOnFocus(true);
        return et;
    }

    // ─── Nickname Changer ────────────────────────────────────────────────
    private void changeNicknameInAllGroups(String nickname) {
        String safe = nickname.replace("\\", "\\\\").replace("'", "\\'").replace("\"", "\\\"");
        String js =
            "(async function(){" +
            "  try{" +
            "    var r=await apiFetch('/api/messenger/set-bot-nick-all'," +
            "      {method:'POST',body:JSON.stringify({nickname:'" + safe + "'})});" +
            "    Android.onNicknameResult(r.ok, r.error||'');" +
            "  } catch(e){ Android.onNicknameResult(false, e.message); }" +
            "})();";
        webView.evaluateJavascript(js, null);
        Toast.makeText(this, "⏳ جاري تغيير الكنية في كل الغروبات…", Toast.LENGTH_SHORT).show();
    }

    // ─── Home Screen Shortcut ─────────────────────────────────────────────
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
        if (done)
            Toast.makeText(this, "✅ تمت إضافة الاختصار على الشاشة الرئيسية", Toast.LENGTH_LONG).show();
        else
            Toast.makeText(this, "⚠️ المشغّل لا يدعم الاختصارات المثبّتة", Toast.LENGTH_SHORT).show();
    }

    // ─── Permissions ─────────────────────────────────────────────────────
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

    // ─── Activity Results ─────────────────────────────────────────────────
    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST) {
            if (fileCallback != null) {
                Uri[] results = null;
                if (resultCode == Activity.RESULT_OK && data != null) results = new Uri[]{data.getData()};
                fileCallback.onReceiveValue(results);
                fileCallback = null;
            }
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    // ─── Back Key ────────────────────────────────────────────────────────
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView.canGoBack()) {
            webView.goBack(); return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override protected void onPause()   { super.onPause();   webView.onPause();   }
    @Override protected void onResume()  { super.onResume();  webView.onResume();  }
    @Override
    protected void onDestroy() {
        if (webView != null) { webView.stopLoading(); webView.destroy(); }
        super.onDestroy();
    }
}

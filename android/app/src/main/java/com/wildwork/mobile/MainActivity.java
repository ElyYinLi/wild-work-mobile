package com.wildwork.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * 壳本体：一个 WebView + 一个本地反向代理。
 *
 * 刻意把「界面」全部放进 WebView 里的 mobile-ui，
 * 这样 Android / iOS / 浏览器三端共用同一份 UI，改一次三端同时生效。
 * 原生侧只负责三件事：存服务器地址、起代理、承载 WebView。
 */
public class MainActivity extends Activity {

    private static final int PROXY_PORT = 17863;
    private static final String PREFS = "wildwork";
    private static final String KEY_SERVER = "server";

    private WebView webView;
    private ProxyServer proxy;
    private SharedPreferences prefs;
    private FrameLayout root;
    private TextView errorView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        proxy = new ProxyServer(PROXY_PORT, getAssets());
        buildContentView();

        String saved = prefs.getString(KEY_SERVER, "");
        if (saved == null || saved.isEmpty()) {
            showServerDialog(true);
        } else {
            connect(saved);
        }
    }

    private void buildContentView() {
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0A0D12"));

        webView = new WebView(this);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setMediaPlaybackRequiresUserGesture(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            // 面板通常是局域网 HTTP；页面源虽然是 127.0.0.1，但保留放宽以免上游跳 http 时被拦
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        webView.setBackgroundColor(Color.parseColor("#0A0D12"));
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.addJavascriptInterface(new Bridge(), "WWNative");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (url == null) {
                    return false;
                }
                if (url.startsWith("http://127.0.0.1:" + PROXY_PORT)) {
                    return false;
                }
                if (url.startsWith("http://") || url.startsWith("https://")) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                        return true;
                    } catch (Exception ignored) {
                        return false;
                    }
                }
                return false;
            }

            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                showLoadError("无法加载界面：" + description);
            }
        });
        webView.setWebChromeClient(new WebChromeClient());

        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        errorView = new TextView(this);
        errorView.setTextColor(Color.parseColor("#8A94A6"));
        errorView.setTextSize(15);
        errorView.setGravity(android.view.Gravity.CENTER);
        errorView.setVisibility(View.GONE);
        int pad = dp(32);
        errorView.setPadding(pad, pad, pad, pad);
        errorView.setOnClickListener(v -> {
            String saved = prefs.getString(KEY_SERVER, "");
            if (saved != null && !saved.isEmpty()) {
                connect(saved);
            } else {
                showServerDialog(false);
            }
        });
        root.addView(errorView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(root);
    }

    private void connect(String server) {
        proxy.setUpstream(server);
        try {
            if (!proxy.isRunning()) {
                proxy.start();
            }
        } catch (Exception e) {
            // 端口偶尔被上一次未回收的进程占用，重启一次代理
            try {
                proxy.stop();
                Thread.sleep(120);
                proxy.start();
            } catch (Exception second) {
                showLoadError("本地代理启动失败：" + second.getMessage() + "\n\n点击屏幕重试，或长按右上角更换服务器。");
                return;
            }
        }
        errorView.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
        webView.loadUrl("http://127.0.0.1:" + PROXY_PORT + "/");
    }

    /** 错误兜底页：代理活着但上游不通时，至少让用户能改地址。 */
    private void showLoadError(String message) {
        errorView.setText(message + "\n\n点击屏幕重试");
        errorView.setVisibility(View.VISIBLE);
        webView.setVisibility(View.GONE);
        // 长按进入设置，避免地址填错后彻底出不去
        errorView.setOnLongClickListener(v -> {
            showServerDialog(false);
            return true;
        });
    }

    private void showServerDialog(boolean firstRun) {
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        input.setSingleLine(true);
        input.setHint("192.168.1.5:7863");
        input.setText(prefs.getString(KEY_SERVER, ""));
        int pad = dp(16);
        input.setPadding(pad, pad, pad, pad);

        new AlertDialog.Builder(this)
                .setTitle(firstRun ? "连接 wild-work" : "服务器地址")
                .setMessage("填写运行 wild-work 的电脑地址（含端口）。\n手机需与电脑在同一局域网。")
                .setView(input)
                .setCancelable(!firstRun)
                .setPositiveButton("保存并连接", (d, w) -> {
                    String v = input.getText().toString().trim();
                    if (v.isEmpty()) {
                        toast("地址不能为空");
                        return;
                    }
                    prefs.edit().putString(KEY_SERVER, v).apply();
                    connect(v);
                })
                .setNegativeButton(firstRun ? "退出" : "取消", (d, w) -> {
                    if (firstRun) {
                        finish();
                    }
                })
                .show();
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density);
    }

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (proxy != null) {
            proxy.stop();
        }
        if (webView != null) {
            try {
                root.removeView(webView);
                webView.destroy();
            } catch (Exception ignored) {
            }
        }
        super.onDestroy();
    }

    /** 暴露给 web 设置的极简桥：只做「读/改服务器地址」「开外链」「toast」，不碰任何账号数据。 */
    private class Bridge {
        @JavascriptInterface
        public String getServer() {
            return prefs.getString(KEY_SERVER, "");
        }

        @JavascriptInterface
        public void setServer() {
            runOnUiThread(() -> showServerDialog(false));
        }

        @JavascriptInterface
        public void openExternal(String url) {
            runOnUiThread(() -> {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                } catch (Exception e) {
                    toast("无法打开链接");
                }
            });
        }

        @JavascriptInterface
        public void toastMsg(String msg) {
            runOnUiThread(() -> toast(msg));
        }

        @JavascriptInterface
        public String platform() {
            return "android";
        }
    }
}

package org.familyquest.starter;

import android.app.Activity;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import org.json.JSONObject;

public final class MainActivity extends Activity {
    private static final String PAGE = "file:///android_asset/index.html";
    private WebView webView;
    private JournalTransport journal;
    private boolean ready;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        webView = new WebView(this);
        webView.setBackgroundColor(0xff0b1731);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setBlockNetworkLoads(true);
        webView.addJavascriptInterface(new Store(getSharedPreferences("family_quest", MODE_PRIVATE)), "FamilyQuestStore");
        journal = new JournalTransport(getAssets(), (status, body) -> runOnUiThread(() -> {
            if (ready) {
                evaluate("window.familyQuestSyncResult && window.familyQuestSyncResult("
                        + status + "," + JSONObject.quote(body) + ")");
            }
        }));
        webView.addJavascriptInterface(journal, "FamilyQuestSync");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !PAGE.equals(request.getUrl().toString());
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (PAGE.equals(url)) {
                    ready = true;
                    webView.requestFocus();
                    evaluate("window.familyTvStart && window.familyTvStart()");
                }
            }
        });
        setContentView(webView);
        webView.loadUrl(PAGE);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (ready) evaluate("window.familyTvRefresh && window.familyTvRefresh()");
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (ready && event.getKeyCode() == KeyEvent.KEYCODE_BACK) {
            if (event.getAction() == KeyEvent.ACTION_UP && !event.isCanceled()) onBackPressed();
            return true;
        }
        String key = remoteKey(event.getKeyCode());
        if (!ready || key == null) return super.dispatchKeyEvent(event);
        if (event.getAction() == KeyEvent.ACTION_DOWN
                && (!"Enter".equals(key) || event.getRepeatCount() == 0)) {
            evaluate("window.familyTvRemote && window.familyTvRemote('" + key + "')");
        }
        return true;
    }

    @Override
    public void onBackPressed() {
        if (!ready) {
            super.onBackPressed();
            return;
        }
        webView.evaluateJavascript("window.familyTvBack && window.familyTvBack()", result -> {
            if (!"true".equals(result) && !isFinishing()) finish();
        });
    }

    @Override
    protected void onDestroy() {
        ready = false;
        journal.close();
        webView.removeJavascriptInterface("FamilyQuestSync");
        webView.removeJavascriptInterface("FamilyQuestStore");
        setContentView(new View(this));
        webView.destroy();
        super.onDestroy();
    }

    private void evaluate(String script) {
        webView.evaluateJavascript(script, null);
    }

    private static String remoteKey(int code) {
        switch (code) {
            case KeyEvent.KEYCODE_DPAD_UP: return "ArrowUp";
            case KeyEvent.KEYCODE_DPAD_DOWN: return "ArrowDown";
            case KeyEvent.KEYCODE_DPAD_LEFT: return "ArrowLeft";
            case KeyEvent.KEYCODE_DPAD_RIGHT: return "ArrowRight";
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_NUMPAD_ENTER:
            case KeyEvent.KEYCODE_BUTTON_A: return "Enter";
            default: return null;
        }
    }

    public static final class Store {
        private final SharedPreferences preferences;

        Store(SharedPreferences preferences) {
            this.preferences = preferences;
        }

        @JavascriptInterface
        public String read() {
            return preferences.getString("starter_tracker_v1", "");
        }

        @JavascriptInterface
        public boolean write(String snapshot) {
            return preferences.edit().putString("starter_tracker_v1", snapshot).commit();
        }
    }
}

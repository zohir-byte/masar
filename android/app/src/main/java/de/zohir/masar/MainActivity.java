package de.zohir.masar;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {
    static final String HOST = "zohir-byte.github.io";
    static final String URL = "https://" + HOST + "/masar/?app=1";
    private static final int REQ_LOCATION = 1, REQ_NOTIF = 2;

    private WebView web;
    private GeolocationPermissions.Callback geoCallback;
    private String geoOrigin;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().setStatusBarColor(Color.parseColor("#0F2F36"));
        getWindow().setNavigationBarColor(Color.parseColor("#0B2328"));

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0B2328"));
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setGeolocationEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(true);

        web.addJavascriptInterface(new Bridge(), "MasarNative");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (HOST.equals(u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback cb) {
                if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
                    cb.invoke(origin, true, false);
                } else {
                    geoCallback = cb; geoOrigin = origin;
                    requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION,
                            Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOCATION);
                }
            }
        });

        if (saved != null) web.restoreState(saved); else web.loadUrl(URL);

        if (Build.VERSION.SDK_INT >= 33 &&
                checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Pick up stops marked from the bubble while we were in the background.
        if (web != null) web.evaluateJavascript("window.masarNativeSync && window.masarNativeSync()", null);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] res) {
        if (code == REQ_LOCATION && geoCallback != null) {
            boolean ok = res.length > 0 && res[0] == PackageManager.PERMISSION_GRANTED;
            geoCallback.invoke(geoOrigin, ok, false);
            geoCallback = null;
        }
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack(); else super.onBackPressed();
    }

    /** Called from the web page (window.MasarNative). */
    class Bridge {
        @JavascriptInterface public int version() { return 1; }

        @JavascriptInterface public boolean canOverlay() { return Settings.canDrawOverlays(MainActivity.this); }

        @JavascriptInterface public void requestOverlay() {
            runOnUiThread(() -> {
                Intent i = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        Uri.parse("package:" + getPackageName()));
                try { startActivity(i); } catch (Exception e) {
                    startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION));
                }
            });
        }

        /** Save the round and show the bubble (asks for the overlay permission if missing). */
        @JavascriptInterface public boolean startDrive(String json) {
            Drive.save(MainActivity.this, json);
            if (!Settings.canDrawOverlays(MainActivity.this)) { requestOverlay(); return false; }
            runOnUiThread(() -> BubbleService.start(MainActivity.this));
            return true;
        }

        /** Keep the stored round in sync after changes made inside the app. */
        @JavascriptInterface public void updateDrive(String json) {
            Drive.save(MainActivity.this, json);
            if (Settings.canDrawOverlays(MainActivity.this) && Drive.load(MainActivity.this) != null) {
                // only refresh a bubble that is already running
                if (isServiceRunning()) runOnUiThread(() -> BubbleService.start(MainActivity.this));
            }
        }

        @JavascriptInterface public void stopDrive() {
            runOnUiThread(() -> BubbleService.stop(MainActivity.this));
        }

        @JavascriptInterface public String getDrive() { return Drive.loadRaw(MainActivity.this); }

        @JavascriptInterface public void openNav(double lat, double lon) {
            runOnUiThread(() -> Drive.navigate(MainActivity.this, lat, lon));
        }

        @JavascriptInterface public boolean bubbleRunning() { return isServiceRunning(); }
    }

    @SuppressWarnings("deprecation")
    private boolean isServiceRunning() {
        android.app.ActivityManager am = (android.app.ActivityManager) getSystemService(ACTIVITY_SERVICE);
        for (android.app.ActivityManager.RunningServiceInfo s : am.getRunningServices(50)) {
            if (BubbleService.class.getName().equals(s.service.getClassName())) return true;
        }
        return false;
    }
}

package com.kirishimatoka00.nova120;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;

/*
 * 版本紀錄（本檔）
 *   v2.6.145 2026-11-16  常駐背景＋語音喚醒：註冊 NovaWakePlugin；onStart／onStop 告訴 NovaWakeService 畫面是否在前景（前景時服務讓出麥克風）；
 *                        回到前景時若有開常駐／喚醒就（重新）啟動服務（Android 14+ 需在前景啟動才拿得到背景麥克風）；
 *                        被喚醒或從通知「開新對話」打開時（Intent 帶 nova_wake）記下並通知 JS 開新對話。需重新打包 APK 才生效。
 *   v2.6.133 2026-11-14  啟動時的預設導覽列顏色 #020617 → #131a24（B 案黑夜背景；App 載入後由 JS novaSyncSystemBars 依主題設定）。需重新打包 APK 才生效。
 */
public class MainActivity extends BridgeActivity {

    private static final int PERM_REQ_CODE = 1001;

    // App 啟動時主動請求的 Android 系統權限清單
    private static final String[] REQUIRED_PERMISSIONS = {
        Manifest.permission.RECORD_AUDIO,
        Manifest.permission.CAMERA,
        Manifest.permission.ACCESS_FINE_LOCATION,
        Manifest.permission.ACCESS_COARSE_LOCATION,
        Manifest.permission.READ_MEDIA_AUDIO,
        Manifest.permission.READ_MEDIA_IMAGES,
    };

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(RecordingServicePlugin.class);
        registerPlugin(NovaFilesPlugin.class);   // v2.6.61：手機檔案瀏覽（所有檔案存取）
        registerPlugin(NovaSystemBarsPlugin.class);   // v2.6.67：導覽列顏色跟主題
        registerPlugin(NovaAccessibilityPlugin.class);   // v2.6.24：無障礙服務外掛（批次 5b）
        registerPlugin(NovaProactivePlugin.class);   // v2.6.101：AI 主動說話
        registerPlugin(NovaWakePlugin.class);   // v2.6.145：常駐背景＋語音喚醒
        super.onCreate(savedInstanceState);
        NovaWake.activity = new java.lang.ref.WeakReference<>(this);   // v2.6.145
        handleWakeIntent(getIntent());   // v2.6.145
        NovaProactive.saveLaunch(this, getIntent() == null ? null : getIntent().getStringExtra(NovaProactive.EXTRA_OPEN));   // v2.6.101：從主動訊息通知點開時，記下要切換的對話
        try { getWindow().setNavigationBarColor(android.graphics.Color.parseColor("#131a24")); } catch (Exception e) { /* 之後由 JS 依主題設定 */ }   // v2.6.67：啟動預設深色導覽列；v2.6.133：#020617→#131a24（B 案黑夜背景，與 App 同色）

        // ★ Step 1：App 啟動時主動請求所有必要的 Android 系統權限
        // 若未提前請求，WebView 的 getUserMedia / geolocation 即使宣告了也無法使用
        requestAppPermissions();

        // ★ Step 2：設定 WebChromeClient（繼承 BridgeWebChromeClient 保留 Capacitor 的
        //   file chooser / alert / confirm / prompt 等功能，只加上缺少的部分）
        getBridge().getWebView().setWebChromeClient(
            new BridgeWebChromeClient(getBridge()) {

                // ★ 核心修正：實作 onPermissionRequest
                // 沒有這個，getUserMedia({audio/video}) 會靜默被 WebView 拒絕，
                // Android 系統的麥克風/相機權限對話框永遠不會出現
                @Override
                public void onPermissionRequest(final PermissionRequest request) {
                    runOnUiThread(() -> request.grant(request.getResources()));
                }

                // ★ 允許 WebView 的 navigator.geolocation API
                @Override
                public void onGeolocationPermissionsShowPrompt(
                        String origin, GeolocationPermissions.Callback callback) {
                    callback.invoke(origin, true, false);
                }
            }
        );
    }

    // v2.6.101：App 已開著時點通知（singleTask 會走這裡）
    @Override
    protected void onNewIntent(android.content.Intent intent) {
        super.onNewIntent(intent);
        NovaProactive.saveLaunch(this, intent == null ? null : intent.getStringExtra(NovaProactive.EXTRA_OPEN));
        handleWakeIntent(intent);   // v2.6.145
    }

    // v2.6.145：被「嘿 小希」喚醒或從常駐通知按「開新對話」打開 → 記下，JS 用 NovaWake.pull() 取走後開新對話並開始聽
    private void handleWakeIntent(android.content.Intent intent) {
        if (intent == null || !intent.hasExtra(NovaWake.EXTRA_WAKE)) return;
        intent.removeExtra(NovaWake.EXTRA_WAKE);   // 畫面重建時不要重複觸發
        NovaWake.markLaunch(this);
        NovaWakePlugin.fireWake();
    }

    // v2.6.145：畫面在前景時，喚醒服務讓出麥克風；並在前景（重新）啟動服務
    @Override
    public void onStart() {
        super.onStart();
        NovaWake.appVisible = true;
        NovaWake.activity = new java.lang.ref.WeakReference<>(this);
        if (NovaWake.wanted(this)) NovaWake.startService(this, NovaWakeService.ACT_START);
    }

    @Override
    public void onStop() {
        NovaWake.appVisible = false;
        super.onStop();
    }

    // 統一在 App 啟動時請求所有權限（讓使用者一次授予，後續不用再問）
    private void requestAppPermissions() {
        boolean needRequest = false;
        for (String perm : REQUIRED_PERMISSIONS) {
            if (ContextCompat.checkSelfPermission(this, perm)
                    != PackageManager.PERMISSION_GRANTED) {
                needRequest = true;
                break;
            }
        }
        if (needRequest) {
            ActivityCompat.requestPermissions(this, REQUIRED_PERMISSIONS, PERM_REQ_CODE);
        }
    }
}

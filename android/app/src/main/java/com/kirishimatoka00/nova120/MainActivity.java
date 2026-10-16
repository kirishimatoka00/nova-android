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
        registerPlugin(NovaAccessibilityPlugin.class);   // v2.6.24：無障礙服務外掛（批次 5b）
        super.onCreate(savedInstanceState);

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

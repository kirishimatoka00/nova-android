package com.kirishimatoka00.nova120;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

/*
 * NovaLocPlugin — 原生定位（不經 WebView 的 navigator.geolocation）
 *
 * 版本紀錄（本檔）
 *   v1.0.0 2026-11-18  App v2.6.149 新增。修「右上方的定位跟天氣一直沒有反應」。
 *     WebView 的 navigator.geolocation 要先經過 Capacitor 的 onGeolocationPermissionsShowPrompt；它用單一 permissionListener 欄位，
 *     跟其他權限請求（麥克風、通知、選檔）同時發生時，定位那一份會被蓋掉、永遠不回呼；而 getCurrentPosition 的 timeout 不包含等權限的時間，
 *     結果就是整個卡住、右上角停在「更新／定位中」。這裡直接用 LocationManager：
 *     get({timeoutMs, maxAgeMs, prompt})
 *       ① 沒有位置權限：prompt 不是 false 就自己跳權限詢問（有「大概位置」也算可以）；被拒絕回 code "denied"。
 *       ② 先看各來源（gps／network／fused／passive）最後一次的位置，夠新（≤ maxAgeMs）就立刻回傳。
 *       ③ 不夠新就向已開啟的 gps／network／fused 同時要一次新位置，誰先回來用誰；逾時（timeoutMs）時有舊位置就回舊的（stale:true），
 *          完全沒有就回 code "timeout"。系統定位整個關閉時回 code "off"（有舊位置仍回舊的）。
 *     status()        權限（fine／coarse／none）、系統定位是否開啟、可用來源
 *     openSettings()  打開系統的定位設定
 */
@CapacitorPlugin(
    name = "NovaLoc",
    permissions = {
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION })
    }
)
public class NovaLocPlugin extends Plugin {

    private final Handler main = new Handler(Looper.getMainLooper());

    private boolean has(String p) {
        return ContextCompat.checkSelfPermission(getContext(), p) == PackageManager.PERMISSION_GRANTED;
    }
    private boolean hasAny() { return has(Manifest.permission.ACCESS_FINE_LOCATION) || has(Manifest.permission.ACCESS_COARSE_LOCATION); }

    private LocationManager lm() { return (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE); }

    private boolean enabled(LocationManager m) {
        try {
            if (Build.VERSION.SDK_INT >= 28) return m.isLocationEnabled();
            return m.isProviderEnabled(LocationManager.GPS_PROVIDER) || m.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
        } catch (Exception e) { return true; }
    }

    @PluginMethod
    public void status(PluginCall call) {
        LocationManager m = lm();
        JSObject o = new JSObject();
        o.put("perm", has(Manifest.permission.ACCESS_FINE_LOCATION) ? "fine" : has(Manifest.permission.ACCESS_COARSE_LOCATION) ? "coarse" : "none");
        o.put("enabled", m != null && enabled(m));
        StringBuilder sb = new StringBuilder();
        try { if (m != null) for (String p : m.getProviders(true)) { if (sb.length() > 0) sb.append(','); sb.append(p); } } catch (Exception e) { /* */ }
        o.put("providers", sb.toString());
        call.resolve(o);
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS);
            if (getActivity() != null) getActivity().startActivity(i);
            else getContext().startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception e) { /* */ }
        call.resolve();
    }

    @PluginMethod
    public void get(PluginCall call) {
        if (hasAny()) { locate(call); return; }
        if (Boolean.FALSE.equals(call.getBoolean("prompt", true)) || getActivity() == null) { call.reject("沒有位置權限", "denied"); return; }
        requestPermissionForAlias("location", call, "permCb");
    }

    @PermissionCallback
    private void permCb(PluginCall call) {
        if (hasAny()) locate(call);
        else call.reject("定位權限被拒絕", "denied");
    }

    private JSObject toJs(Location l, String src, boolean stale, boolean on) {
        JSObject o = new JSObject();
        o.put("lat", l.getLatitude());
        o.put("lon", l.getLongitude());
        o.put("acc", l.hasAccuracy() ? Math.round(l.getAccuracy()) : 0);
        o.put("at", l.getTime());
        o.put("age", ageMs(l));
        o.put("provider", l.getProvider() == null ? "" : l.getProvider());
        o.put("src", src);
        o.put("stale", stale);
        o.put("enabled", on);
        return o;
    }

    private long ageMs(Location l) {
        try { return Math.max(0, (SystemClock.elapsedRealtimeNanos() - l.getElapsedRealtimeNanos()) / 1000000L); }
        catch (Exception e) { return Math.max(0, System.currentTimeMillis() - l.getTime()); }
    }

    private List<String> candidates(LocationManager m, boolean onlyEnabled) {
        List<String> out = new ArrayList<>();
        List<String> all;
        try { all = m.getAllProviders(); } catch (Exception e) { return out; }
        String[] order = { "fused", LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER };
        for (String p : order) {
            if (!all.contains(p)) continue;
            if (onlyEnabled) {
                if (LocationManager.PASSIVE_PROVIDER.equals(p)) continue;
                try { if (!m.isProviderEnabled(p)) continue; } catch (Exception e) { continue; }
            }
            out.add(p);
        }
        return out;
    }

    @SuppressWarnings({"MissingPermission", "deprecation"})
    private void locate(final PluginCall call) {
        final LocationManager m = lm();
        if (m == null) { call.reject("這台裝置沒有定位功能", "unavailable"); return; }
        final int timeoutMs = Math.max(2000, Math.min(60000, call.getInt("timeoutMs", 12000)));
        final long maxAgeMs = Math.max(0, call.getInt("maxAgeMs", 120000));   // 用 getInt：JS 傳的整數在 JSON 裡是 Integer
        final boolean on = enabled(m);

        // ② 最後一次的位置
        Location best = null;
        for (String p : candidates(m, false)) {
            try {
                Location l = m.getLastKnownLocation(p);
                if (l == null) continue;
                if (best == null || ageMs(l) < ageMs(best) - 60000 || (Math.abs(ageMs(l) - ageMs(best)) <= 60000 && l.getAccuracy() < best.getAccuracy())) best = l;
            } catch (SecurityException e) { /* */ } catch (Exception e) { /* */ }
        }
        if (best != null && ageMs(best) <= maxAgeMs) { call.resolve(toJs(best, "last", false, on)); return; }

        final List<String> live = candidates(m, true);
        if (!on || live.isEmpty()) {
            if (best != null) call.resolve(toJs(best, "last", true, on));
            else call.reject("系統定位沒有開啟", "off");
            return;
        }

        // ③ 要一次新位置（各來源同時要，誰先回來用誰）
        final Location fallback = best;
        final AtomicBoolean done = new AtomicBoolean(false);
        final List<Runnable> cleanups = new ArrayList<>();
        final Runnable finishCleanup = () -> { for (Runnable r : cleanups) { try { r.run(); } catch (Exception e) { /* */ } } };

        final Runnable onTimeout = () -> {
            if (!done.compareAndSet(false, true)) return;
            finishCleanup.run();
            if (fallback != null) call.resolve(toJs(fallback, "last", true, on));
            else call.reject("定位逾時", "timeout");
        };
        main.postDelayed(onTimeout, timeoutMs);

        for (final String p : live) {
            try {
                if (Build.VERSION.SDK_INT >= 30) {
                    final CancellationSignal cs = new CancellationSignal();
                    cleanups.add(cs::cancel);
                    m.getCurrentLocation(p, cs, ContextCompat.getMainExecutor(getContext()), loc -> {
                        if (loc == null) return;
                        if (!done.compareAndSet(false, true)) return;
                        main.removeCallbacks(onTimeout);
                        finishCleanup.run();
                        call.resolve(toJs(loc, p, false, true));
                    });
                } else {
                    final LocationListener ll = new LocationListener() {
                        @Override public void onLocationChanged(Location loc) {
                            if (loc == null) return;
                            if (!done.compareAndSet(false, true)) return;
                            main.removeCallbacks(onTimeout);
                            finishCleanup.run();
                            call.resolve(toJs(loc, p, false, true));
                        }
                        @Override public void onStatusChanged(String provider, int status, Bundle extras) { }
                        @Override public void onProviderEnabled(String provider) { }
                        @Override public void onProviderDisabled(String provider) { }
                    };
                    cleanups.add(() -> m.removeUpdates(ll));
                    m.requestSingleUpdate(p, ll, Looper.getMainLooper());
                }
            } catch (SecurityException e) { /* */ } catch (Exception e) { /* 這個來源不行，換下一個 */ }
        }
    }
}

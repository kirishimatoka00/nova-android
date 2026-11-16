package com.kirishimatoka00.nova120;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.content.ContextCompat;

import java.io.File;
import java.lang.ref.WeakReference;

/*
 * NovaWake — 常駐與語音喚醒的共用設定與狀態（NovaWakeService／NovaWakePlugin／MainActivity 共用）
 *
 * 版本紀錄（本檔）
 *   v1.0.0 2026-11-15  App v2.6.145 新增。設定存 SharedPreferences「nova_wake」（服務被系統重啟時也讀得到，不靠 WebView）：
 *                      keepAlive（常駐背景，通知列「關閉 NOVA」才結束）、wakeOn（語音喚醒「嘿 小希」）、sens（靈敏度 0 低／1 中／2 高）、
 *                      userPaused（使用者從通知列暫停聆聽）、modelDir（Vosk 中文模型解壓後的資料夾）、launchAt（喚醒啟動待 JS 取走的時間）。
 */
final class NovaWake {
    private NovaWake() {}

    static final String PREFS = "nova_wake";
    static final String K_KEEP = "keepAlive", K_WAKE = "wakeOn", K_SENS = "sens", K_PAUSE = "userPaused", K_MODEL = "modelDir", K_LAUNCH = "launchAt";
    static final String EXTRA_WAKE = "nova_wake";

    /** MainActivity 目前是否在前景（前景時暫停聆聽，麥克風讓給 App 自己的語音輸入） */
    static volatile boolean appVisible = false;
    /** 目前的 MainActivity（「關閉 NOVA」時用來結束畫面） */
    static volatile WeakReference<Activity> activity = new WeakReference<>(null);

    static SharedPreferences sp(Context c) { return c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE); }
    static boolean keepAlive(Context c) { return sp(c).getBoolean(K_KEEP, false); }
    static boolean wakeOn(Context c) { return sp(c).getBoolean(K_WAKE, false); }
    static boolean userPaused(Context c) { return sp(c).getBoolean(K_PAUSE, false); }
    static int sens(Context c) { return Math.max(0, Math.min(2, sp(c).getInt(K_SENS, 1))); }
    static boolean wanted(Context c) { return keepAlive(c) || wakeOn(c); }

    /** 已下載且完整的模型資料夾（含 am／conf），沒有就回 null */
    static String modelDir(Context c) {
        String p = sp(c).getString(K_MODEL, null);
        if (p == null) return null;
        File d = new File(p);
        return (new File(d, "am").isDirectory() && new File(d, "conf").isDirectory()) ? p : null;
    }

    /** 喚醒後打開 App：記下時間，JS 起來後用 NovaWake.pull() 取走 → 開新對話＋開始聽 */
    static void markLaunch(Context c) { sp(c).edit().putLong(K_LAUNCH, System.currentTimeMillis()).apply(); }
    static boolean takeLaunch(Context c) {
        long t = sp(c).getLong(K_LAUNCH, 0);
        if (t == 0) return false;
        sp(c).edit().remove(K_LAUNCH).apply();
        return System.currentTimeMillis() - t < 90_000L;
    }

    static void startService(Context c, String action) {
        try {
            Intent i = new Intent(c, NovaWakeService.class).setAction(action);
            ContextCompat.startForegroundService(c.getApplicationContext(), i);
        } catch (Exception e) { /* 背景啟動被系統拒絕時忽略（下次打開 App 會再啟動） */ }
    }
    static void stopService(Context c) {
        try { c.getApplicationContext().stopService(new Intent(c, NovaWakeService.class)); } catch (Exception e) { /* */ }
    }

    /** 能不能從背景直接叫出畫面：有「顯示在其他應用程式上層」或 NOVA 無障礙服務正在執行 */
    static boolean canLaunchFromBackground(Context c) {
        try { if (Settings.canDrawOverlays(c)) return true; } catch (Exception e) { /* */ }
        return NovaAccessibilityService.getInstance() != null;
    }
    static boolean batteryIgnored(Context c) {
        try { PowerManager pm = (PowerManager) c.getSystemService(Context.POWER_SERVICE); return pm != null && pm.isIgnoringBatteryOptimizations(c.getPackageName()); }
        catch (Exception e) { return false; }
    }
}

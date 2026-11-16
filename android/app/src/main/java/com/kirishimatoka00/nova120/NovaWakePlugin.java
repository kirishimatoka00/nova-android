package com.kirishimatoka00.nova120;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/*
 * NovaWakePlugin — JS ↔ 常駐／語音喚醒（NovaWakeService）的橋
 *
 * 版本紀錄（本檔）
 *   v1.0.0 2026-11-16  App v2.6.145 新增。
 *     configure({keepAlive, wakeOn, sens})  寫入設定並啟動／停止常駐服務
 *     status()                             服務狀態、最後聽到的字、模型是否已下載、各項權限
 *     downloadModel() / deleteModel()      下載並解壓 Vosk 中文小模型（約 42MB，存 App 私有資料夾；進度用「model」事件回報）
 *     pull()                               JS 起來／回到前景時取走「這次是被喚醒打開的嗎」→ {wake:true} 就開新對話＋開始聽
 *     test()                               5 秒後模擬一次喚醒（讓使用者先把 NOVA 放到背景或鎖定螢幕來試）
 *     requestMic / requestNotify / openOverlaySettings / requestIgnoreBattery / openAppSettings   權限相關
 *     quit()                               等同通知列的「關閉 NOVA」
 */
@CapacitorPlugin(name = "NovaWake")
public class NovaWakePlugin extends Plugin {

    private static final String MODEL_NAME = "vosk-model-small-cn-0.22";
    private static final String[] MODEL_URLS = {
        "https://alphacephei.com/vosk/models/" + MODEL_NAME + ".zip",
        "https://huggingface.co/rhasspy/vosk-models/resolve/main/zh/" + MODEL_NAME + ".zip"
    };

    static volatile NovaWakePlugin inst;
    private static volatile boolean downloading = false;
    private static volatile int dlPct = 0;
    private static volatile String dlPhase = "";

    @Override
    public void load() { inst = this; }

    /** MainActivity 收到喚醒 Intent 時通知 JS（JS 收到後會再呼叫 pull() 確認，避免重複觸發） */
    static void fireWake() {
        NovaWakePlugin p = inst;
        if (p == null) return;
        try { p.notifyListeners("wake", new JSObject()); } catch (Exception e) { /* */ }
    }

    @PluginMethod
    public void configure(PluginCall call) {
        Context c = getContext();
        boolean keep = Boolean.TRUE.equals(call.getBoolean("keepAlive", false));
        boolean wake = Boolean.TRUE.equals(call.getBoolean("wakeOn", false));
        Integer sens = call.getInt("sens", 1);
        boolean wasWake = NovaWake.wakeOn(c);
        android.content.SharedPreferences.Editor e = NovaWake.sp(c).edit()
            .putBoolean(NovaWake.K_KEEP, keep).putBoolean(NovaWake.K_WAKE, wake).putInt(NovaWake.K_SENS, sens == null ? 1 : sens);
        if (wake && !wasWake) e.putBoolean(NovaWake.K_PAUSE, false);   // 重新打開語音喚醒時，取消先前的「暫停聆聽」
        e.apply();
        if (keep || wake) NovaWake.startService(c, NovaWakeService.ACT_START);
        else NovaWake.stopService(c);
        call.resolve(buildStatus());
    }

    @PluginMethod
    public void status(PluginCall call) { call.resolve(buildStatus()); }

    private JSObject buildStatus() {
        Context c = getContext();
        JSObject o = new JSObject();
        o.put("keepAlive", NovaWake.keepAlive(c));
        o.put("wakeOn", NovaWake.wakeOn(c));
        o.put("sens", NovaWake.sens(c));
        o.put("userPaused", NovaWake.userPaused(c));
        o.put("running", NovaWakeService.inst != null);
        o.put("state", NovaWakeService.state);
        o.put("stateMsg", NovaWakeService.stateMsg);
        o.put("lastHeard", NovaWakeService.lastHeard);
        o.put("lastWakeAt", NovaWakeService.lastWakeAt);
        o.put("micFgs", NovaWakeService.micFgs);
        o.put("model", NovaWake.modelDir(c) != null);
        o.put("downloading", downloading);
        o.put("dlPct", dlPct);
        o.put("dlPhase", dlPhase);
        o.put("mic", ContextCompat.checkSelfPermission(c, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED);
        boolean overlay = false;
        try { overlay = Settings.canDrawOverlays(c); } catch (Exception e) { /* */ }
        o.put("overlay", overlay);
        o.put("accessibility", NovaAccessibilityService.getInstance() != null);
        o.put("canLaunch", NovaWake.canLaunchFromBackground(c));
        o.put("battery", NovaWake.batteryIgnored(c));
        boolean notif = true;
        try { notif = NotificationManagerCompat.from(c).areNotificationsEnabled(); } catch (Exception e) { /* */ }
        o.put("notify", notif);
        o.put("sdk", Build.VERSION.SDK_INT);
        o.put("maker", Build.MANUFACTURER == null ? "" : Build.MANUFACTURER);
        return o;
    }

    @PluginMethod
    public void pull(PluginCall call) {
        JSObject o = new JSObject();
        o.put("wake", NovaWake.takeLaunch(getContext()));
        call.resolve(o);
    }

    @PluginMethod
    public void test(PluginCall call) {
        Context c = getContext();
        if (!NovaWake.wakeOn(c)) { call.reject("請先開啟語音喚醒"); return; }
        NovaWake.startService(c, NovaWakeService.ACT_TEST);
        call.resolve();
    }

    @PluginMethod
    public void quit(PluginCall call) {
        try { getContext().startService(new Intent(getContext(), NovaWakeService.class).setAction(NovaWakeService.ACT_QUIT)); }
        catch (Exception e) {
            Activity a = getActivity();
            if (a != null) a.finishAndRemoveTask();
        }
        call.resolve();
    }

    // ───────── 權限 ─────────
    @PluginMethod
    public void requestMic(PluginCall call) {
        Activity a = getActivity();
        if (a != null) ActivityCompat.requestPermissions(a, new String[]{ Manifest.permission.RECORD_AUDIO }, 1701);
        call.resolve();
    }

    @PluginMethod
    public void requestNotify(PluginCall call) {
        Activity a = getActivity();
        if (a != null && Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(a, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                && ActivityCompat.shouldShowRequestPermissionRationale(a, Manifest.permission.POST_NOTIFICATIONS) == false
                && !NovaWake.sp(a).getBoolean("askedNotify", false)) {
            NovaWake.sp(a).edit().putBoolean("askedNotify", true).apply();
            ActivityCompat.requestPermissions(a, new String[]{ Manifest.permission.POST_NOTIFICATIONS }, 1702);
        } else {
            openIntent(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName()), true);
        }
        call.resolve();
    }

    @PluginMethod
    public void openOverlaySettings(PluginCall call) {
        openIntent(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getContext().getPackageName())), true);
        call.resolve();
    }

    @PluginMethod
    public void requestIgnoreBattery(PluginCall call) {
        if (!openIntent(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getContext().getPackageName())), false))
            openIntent(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS), true);
        call.resolve();
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        openIntent(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName())), false);
        call.resolve();
    }

    private boolean openIntent(Intent i, boolean fallbackToAppSettings) {
        try {
            Activity a = getActivity();
            if (a != null) a.startActivity(i);
            else getContext().startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            return true;
        } catch (Exception e) {
            if (fallbackToAppSettings) {
                try {
                    Intent s = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(s);
                } catch (Exception e2) { /* */ }
            }
            return false;
        }
    }

    // ───────── 語音模型 ─────────
    private File voskRoot() { return new File(getContext().getFilesDir(), "vosk"); }

    private void progress(String phase, int pct) {
        dlPhase = phase; dlPct = pct;
        JSObject o = new JSObject();
        o.put("phase", phase);
        o.put("pct", pct);
        try { notifyListeners("model", o); } catch (Exception e) { /* */ }
    }

    @PluginMethod
    public void downloadModel(final PluginCall call) {
        if (NovaWake.modelDir(getContext()) != null) { call.resolve(buildStatus()); return; }
        if (downloading) { call.reject("正在下載中"); return; }
        downloading = true;
        new Thread(() -> {
            File root = voskRoot();
            File zip = new File(getContext().getCacheDir(), MODEL_NAME + ".zip");
            String err = null;
            try {
                deleteRec(root);
                if (!root.mkdirs() && !root.isDirectory()) throw new Exception("無法建立資料夾");
                boolean got = false;
                for (String u : MODEL_URLS) {
                    try { download(u, zip); got = true; break; }
                    catch (Exception e) { err = e.getMessage(); }
                }
                if (!got) throw new Exception("下載失敗：" + err);
                progress("unzip", 0);
                unzip(zip, root);
                File dir = findModel(root, 0);
                if (dir == null) throw new Exception("解壓後找不到模型內容");
                NovaWake.sp(getContext()).edit().putString(NovaWake.K_MODEL, dir.getAbsolutePath()).apply();
                progress("done", 100);
                downloading = false;
                call.resolve(buildStatus());
            } catch (Exception e) {
                downloading = false;
                deleteRec(root);
                progress("error", 0);
                call.reject(e.getMessage() == null ? "下載失敗" : e.getMessage());
            } finally {
                downloading = false;
                try { zip.delete(); } catch (Exception e) { /* */ }
            }
        }, "nova-wake-model").start();
    }

    private void download(String url, File out) throws Exception {
        HttpURLConnection con = null;
        try {
            String u = url;
            for (int hop = 0; hop < 5; hop++) {   // 自己跟轉址（跨網域轉址 HttpURLConnection 不一定會跟）
                con = (HttpURLConnection) new URL(u).openConnection();
                con.setConnectTimeout(20000);
                con.setReadTimeout(30000);
                con.setInstanceFollowRedirects(true);
                con.setRequestProperty("User-Agent", "NOVA-Android");
                int code = con.getResponseCode();
                if (code >= 300 && code < 400) {
                    String loc = con.getHeaderField("Location");
                    con.disconnect();
                    if (loc == null) throw new Exception("HTTP " + code);
                    u = new URL(new URL(u), loc).toString();
                    if (!u.startsWith("https://")) throw new Exception("轉址到非 https");
                    continue;
                }
                if (code != 200) throw new Exception("HTTP " + code);
                break;
            }
            long total = con.getContentLength();
            long done = 0;
            int last = -1;
            byte[] buf = new byte[65536];
            try (InputStream in = new BufferedInputStream(con.getInputStream());
                 OutputStream os = new BufferedOutputStream(new FileOutputStream(out))) {
                int n;
                while ((n = in.read(buf)) > 0) {
                    os.write(buf, 0, n);
                    done += n;
                    if (done > 300L * 1024 * 1024) throw new Exception("檔案過大");
                    int pct = total > 0 ? (int) (done * 100 / total) : (int) Math.min(99, done / (430 * 1024));
                    if (pct != last) { last = pct; progress("download", pct); }
                }
            }
            if (done < 5L * 1024 * 1024) throw new Exception("下載內容不完整");
        } finally {
            if (con != null) con.disconnect();
        }
    }

    private void unzip(File zip, File root) throws Exception {
        String base = root.getCanonicalPath() + File.separator;
        long total = zip.length(), written = 0;
        byte[] buf = new byte[65536];
        try (ZipInputStream zi = new ZipInputStream(new BufferedInputStream(new FileInputStream(zip)))) {
            ZipEntry ze;
            int count = 0, last = -1;
            while ((ze = zi.getNextEntry()) != null) {
                File f = new File(root, ze.getName());
                if (!f.getCanonicalPath().startsWith(base)) throw new Exception("壓縮檔路徑不安全");   // zip-slip
                if (++count > 5000) throw new Exception("壓縮檔內容異常");
                if (ze.isDirectory()) { f.mkdirs(); continue; }
                File parent = f.getParentFile();
                if (parent != null) parent.mkdirs();
                try (OutputStream os = new BufferedOutputStream(new FileOutputStream(f))) {
                    int n;
                    while ((n = zi.read(buf)) > 0) {
                        os.write(buf, 0, n);
                        written += n;
                        if (written > 600L * 1024 * 1024) throw new Exception("解壓後過大");
                    }
                }
                int pct = total > 0 ? (int) Math.min(99, written * 100 / (total * 2)) : 0;
                if (pct != last) { last = pct; progress("unzip", pct); }
            }
        }
    }

    private File findModel(File d, int depth) {
        if (d == null || !d.isDirectory() || depth > 3) return null;
        if (new File(d, "am").isDirectory() && new File(d, "conf").isDirectory()) return d;
        File[] kids = d.listFiles();
        if (kids != null) for (File k : kids) { File r = findModel(k, depth + 1); if (r != null) return r; }
        return null;
    }

    private void deleteRec(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteRec(k);
        try { f.delete(); } catch (Exception e) { /* */ }
    }

    @PluginMethod
    public void deleteModel(PluginCall call) {
        if (downloading) { call.reject("正在下載中"); return; }
        NovaWake.sp(getContext()).edit().remove(NovaWake.K_MODEL).apply();
        new Thread(() -> {
            try { Thread.sleep(2500); } catch (InterruptedException e) { /* 等服務放掉模型 */ }
            deleteRec(voskRoot());
        }).start();
        call.resolve(buildStatus());
    }
}

package com.kirishimatoka00.nova120;

/*
 * NovaAccessibilityPlugin.java
 * 版本：v1.0.0
 * 版本紀錄：
 * v1.0.0 - 批次 5b 新增。Capacitor 外掛 "NovaAccessibility"，把 NovaAccessibilityService 的能力開給 JS（nova-acc-bridge.js 使用）：
 *          status／openSettings／tap／swipe／globalAction／dump／screenshot／setText／paste／imeEnter／launchApp／openUrl／listPackages。
 *          服務尚未在系統「無障礙」設定開啟時，需要服務的方法一律回 reject("ACC_NOT_ENABLED")。
 */

import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.provider.Settings;
import android.text.TextUtils;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.List;

@CapacitorPlugin(name = "NovaAccessibility")
public class NovaAccessibilityPlugin extends Plugin {

    private boolean isEnabledInSettings() {
        Context ctx = getContext();
        String expected = ctx.getPackageName() + "/" + NovaAccessibilityService.class.getName();
        try {
            int on = Settings.Secure.getInt(ctx.getContentResolver(), Settings.Secure.ACCESSIBILITY_ENABLED, 0);
            if (on != 1) return false;
            String list = Settings.Secure.getString(ctx.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            if (list == null) return false;
            TextUtils.SimpleStringSplitter sp = new TextUtils.SimpleStringSplitter(':');
            sp.setString(list);
            while (sp.hasNext()) {
                String s = sp.next();
                if (s.equalsIgnoreCase(expected) || s.equalsIgnoreCase(ctx.getPackageName() + "/." + NovaAccessibilityService.class.getSimpleName())) return true;
            }
        } catch (Exception ignored) { }
        return false;
    }

    private NovaAccessibilityService svc(PluginCall call) {
        NovaAccessibilityService s = NovaAccessibilityService.getInstance();
        if (s == null) { call.reject("ACC_NOT_ENABLED"); return null; }
        return s;
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject o = new JSObject();
        NovaAccessibilityService s = NovaAccessibilityService.getInstance();
        o.put("enabled", isEnabledInSettings());
        o.put("connected", s != null);
        o.put("sdk", android.os.Build.SDK_INT);
        o.put("canScreenshot", android.os.Build.SDK_INT >= 30);
        o.put("model", android.os.Build.MODEL);
        if (s != null) {
            int[] sz = s.realSize();
            o.put("width", sz[0]);
            o.put("height", sz[1]);
        }
        call.resolve(o);
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("無法開啟無障礙設定：" + e.getMessage());
        }
    }

    @PluginMethod
    public void tap(final PluginCall call) {
        NovaAccessibilityService s = svc(call); if (s == null) return;
        float x = call.getFloat("x", 0f), y = call.getFloat("y", 0f);
        long d = call.getInt("duration", 60);
        s.gesture(x, y, x, y, d, ok -> { JSObject o = new JSObject(); o.put("ok", ok); call.resolve(o); });
    }

    @PluginMethod
    public void swipe(final PluginCall call) {
        NovaAccessibilityService s = svc(call); if (s == null) return;
        float x1 = call.getFloat("x1", 0f), y1 = call.getFloat("y1", 0f), x2 = call.getFloat("x2", 0f), y2 = call.getFloat("y2", 0f);
        long d = call.getInt("duration", 300);
        s.gesture(x1, y1, x2, y2, d, ok -> { JSObject o = new JSObject(); o.put("ok", ok); call.resolve(o); });
    }

    @PluginMethod
    public void globalAction(PluginCall call) {
        NovaAccessibilityService s = svc(call); if (s == null) return;
        JSObject o = new JSObject();
        o.put("ok", s.global(call.getString("action", "")));
        call.resolve(o);
    }

    @PluginMethod
    public void dump(PluginCall call) {
        NovaAccessibilityService s = svc(call); if (s == null) return;
        JSObject o = new JSObject();
        o.put("xml", s.dumpHierarchy());
        o.put("package", s.foregroundPackage());
        call.resolve(o);
    }

    @PluginMethod
    public void screenshot(final PluginCall call) {
        NovaAccessibilityService s = svc(call); if (s == null) return;
        int maxDim = call.getInt("maxDim", 768);
        int quality = call.getInt("quality", 70);
        s.screenshot(maxDim, quality, (b64, w, h, err) -> {
            if (err != null) { call.reject(err); return; }
            JSObject o = new JSObject();
            o.put("data", b64); o.put("width", w); o.put("height", h);
            call.resolve(o);
        });
    }

    @PluginMethod
    public void setText(PluginCall call) {
        NovaAccessibilityService s = svc(call); if (s == null) return;
        JSObject o = new JSObject();
        o.put("ok", s.setText(call.getString("text", "")));
        call.resolve(o);
    }

    @PluginMethod
    public void paste(PluginCall call) {
        NovaAccessibilityService s = svc(call); if (s == null) return;
        JSObject o = new JSObject();
        o.put("ok", s.paste());
        call.resolve(o);
    }

    @PluginMethod
    public void imeEnter(PluginCall call) {
        NovaAccessibilityService s = svc(call); if (s == null) return;
        JSObject o = new JSObject();
        o.put("ok", s.imeEnter());
        call.resolve(o);
    }

    @PluginMethod
    public void launchApp(PluginCall call) {
        String pkg = call.getString("package", "");
        String activity = call.getString("activity", "");
        try {
            Intent i;
            if (!activity.isEmpty()) {
                i = new Intent();
                i.setClassName(pkg, activity.startsWith(".") ? pkg + activity : activity);
            } else {
                i = getContext().getPackageManager().getLaunchIntentForPackage(pkg);
            }
            if (i == null) { call.reject("找不到可啟動的 App：" + pkg); return; }
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("啟動 App 失敗：" + e.getMessage());
        }
    }

    @PluginMethod
    public void openUrl(PluginCall call) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(call.getString("url", "")));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("開啟網址失敗：" + e.getMessage());
        }
    }

    @PluginMethod
    public void listPackages(PluginCall call) {
        try {
            PackageManager pm = getContext().getPackageManager();
            List<ApplicationInfo> apps = pm.getInstalledApplications(0);
            JSArray arr = new JSArray();
            for (ApplicationInfo a : apps) {
                if (pm.getLaunchIntentForPackage(a.packageName) != null) arr.put(a.packageName);
            }
            JSObject o = new JSObject();
            o.put("packages", arr);
            call.resolve(o);
        } catch (Exception e) {
            call.reject("讀取已安裝 App 失敗：" + e.getMessage());
        }
    }
}

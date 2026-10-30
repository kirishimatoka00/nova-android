package com.kirishimatoka00.nova120;

import android.app.AlarmManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

/**
 * v2.6.101：AI 主動說話——JS 橋接。
 * JS：Capacitor.Plugins.NovaProactive.configure({ config })／pull()／status()／testNow({ sid })／
 *     requestExactAlarm()／openBatterySettings()／clearAll()
 */
@CapacitorPlugin(name = "NovaProactive")
public class NovaProactivePlugin extends Plugin {

    /** 同步設定（含各對話的情境與預定時間表），並重新排程。 */
    @PluginMethod
    public void configure(PluginCall call) {
        try {
            JSObject cfg = call.getObject("config");
            if (cfg == null) { call.reject("缺少 config"); return; }
            NovaProactive.configure(getContext(), cfg);
            JSObject r = new JSObject();
            r.put("ok", true);
            r.put("next", NovaProactive.nextPlanned(getContext()));
            call.resolve(r);
        } catch (Exception e) {
            call.reject("configure 失敗：" + e.getMessage());
        }
    }

    /** 取回收件匣（取走即清空）與通知點開時指定的對話。 */
    @PluginMethod
    public void pull(PluginCall call) {
        try {
            Context c = getContext();
            JSObject r = new JSObject();
            r.put("items", NovaProactive.takeInbox(c));
            r.put("openSession", NovaProactive.takeLaunch(c));
            call.resolve(r);
        } catch (Exception e) {
            call.reject("pull 失敗：" + e.getMessage());
        }
    }

    /** 權限／排程狀態與各對話最近一次錯誤。 */
    @PluginMethod
    public void status(PluginCall call) {
        try {
            Context c = getContext();
            JSObject r = new JSObject();
            r.put("notifications", NotificationManagerCompat.from(c).areNotificationsEnabled());
            r.put("exactAlarm", NovaProactive.canExact(c));
            PowerManager pm = (PowerManager) c.getSystemService(Context.POWER_SERVICE);
            r.put("batteryUnrestricted", pm != null && pm.isIgnoringBatteryOptimizations(c.getPackageName()));
            r.put("next", NovaProactive.nextPlanned(c));
            r.put("state", new JSONObject(NovaProactive.readObj(c, NovaProactive.K_STATE).toString()));
            call.resolve(r);
        } catch (Exception e) {
            call.reject("status 失敗：" + e.getMessage());
        }
    }

    /** 立刻產生並送出一則（測試用，不受「連續未回應上限」限制）。 */
    @PluginMethod
    public void testNow(final PluginCall call) {
        final String sid = call.getString("sid", "");
        final Context c = getContext();
        new Thread(new Runnable() {
            @Override public void run() {
                JSObject r = new JSObject();
                try {
                    JSONObject cfg = NovaProactive.readObj(c, NovaProactive.K_CFG);
                    JSONObject sessions = cfg.optJSONObject("sessions");
                    JSONObject s = sessions == null ? null : sessions.optJSONObject(sid);
                    if (s == null) throw new Exception("原生端還沒有這個對話的資料，請先儲存設定");
                    boolean sent = NovaProactive.fireOne(c, cfg, sid, s, true, System.currentTimeMillis() + 30000L);
                    r.put("ok", true);
                    r.put("sent", sent);   // false＝模型判斷此刻不適合打擾（回 [SKIP]）
                    call.resolve(r);
                } catch (Exception e) {
                    call.reject(e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
                }
            }
        }, "nova-proactive-test").start();
    }

    /** 開啟「鬧鐘與提醒」系統設定頁（Android 12+ 要使用者手動允許精確鬧鐘）。 */
    @PluginMethod
    public void requestExactAlarm(PluginCall call) {
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                Intent i = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:" + getContext().getPackageName()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
            }
            call.resolve(new JSObject().put("ok", true));
        } catch (Exception e) {
            call.reject("無法開啟設定：" + e.getMessage());
        }
    }

    /** 開啟「電池最佳化」設定清單，讓使用者把 NOVA 設為不限制。 */
    @PluginMethod
    public void openBatterySettings(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve(new JSObject().put("ok", true));
        } catch (Exception e) {
            call.reject("無法開啟設定：" + e.getMessage());
        }
    }

    @PluginMethod
    public void clearAll(PluginCall call) {
        NovaProactive.clearAll(getContext());
        call.resolve(new JSObject().put("ok", true));
    }
}

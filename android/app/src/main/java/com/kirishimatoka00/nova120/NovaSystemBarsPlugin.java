package com.kirishimatoka00.nova120;

import android.graphics.Color;
import android.view.Window;

import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * v2.6.67：系統導覽列（畫面最下方的返回／首頁／最近工作列）顏色跟著 App 主題。
 * JS：Capacitor.Plugins.NovaSystemBars.setNavBar({ color: '#020617', light: false })
 *   color＝導覽列背景色；light＝true 時按鍵圖示用深色（淺色背景用）。
 * 註：Android 15 以上強制邊到邊，系統會忽略導覽列背景色（App 內容會延伸到導覽列後面），這時只有圖示明暗會生效。
 */
@CapacitorPlugin(name = "NovaSystemBars")
public class NovaSystemBarsPlugin extends Plugin {
    @PluginMethod
    public void setNavBar(final PluginCall call) {
        final String color = call.getString("color", "#020617");
        final boolean light = Boolean.TRUE.equals(call.getBoolean("light", false));
        getActivity().runOnUiThread(() -> {
            try {
                Window w = getActivity().getWindow();
                w.setNavigationBarColor(Color.parseColor(color));
                new WindowInsetsControllerCompat(w, w.getDecorView()).setAppearanceLightNavigationBars(light);
                call.resolve(new JSObject().put("ok", true));
            } catch (Exception e) {
                call.reject("setNavBar 失敗：" + e.getMessage());
            }
        });
    }
}

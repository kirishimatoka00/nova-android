package com.kirishimatoka00.nova120;

/*
 * NovaAccessibilityService.java
 * 版本：v1.0.0
 * 版本紀錄：
 * v1.0.0 - 批次 5b 新增。NOVA 的無障礙服務：提供自主任務所需的「眼睛與手」，取代 Termux + atx-agent：
 *          ① dumpHierarchy()：把目前視窗的元件樹輸出成 uiautomator 風格 XML（node／text／resource-id／content-desc／bounds…），
 *             JS 端 parseHierarchyElements() 可直接沿用。最外層加一個「整個螢幕」大小的虛擬根節點，讓解析度校正拿到真實螢幕尺寸。
 *          ② tap／swipe：dispatchGesture（API 24+）。
 *          ③ globalAction：返回／主畫面／最近工作／通知列。
 *          ④ screenshot()：AccessibilityService.takeScreenshot（API 30+），輸出縮小後的 JPEG base64。
 *          ⑤ setText／paste／imeEnter：對「目前輸入焦點」的節點做 ACTION_SET_TEXT／ACTION_PASTE／ACTION_IME_ENTER。
 *          ⑥ 前景 App 套件名稱。
 *          所有方法都由 NovaAccessibilityPlugin 呼叫；服務沒開啟時 getInstance() 為 null，外掛會回報「尚未啟用」。
 */

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Bitmap;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.util.DisplayMetrics;
import android.util.Base64;
import android.view.Display;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import java.io.ByteArrayOutputStream;

public class NovaAccessibilityService extends AccessibilityService {

    private static volatile NovaAccessibilityService instance;

    public static NovaAccessibilityService getInstance() { return instance; }

    public interface GestureCb { void done(boolean ok); }
    public interface ShotCb { void done(String base64Jpeg, int w, int h, String error); }

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
    }

    @Override
    public boolean onUnbind(android.content.Intent intent) {
        instance = null;
        return super.onUnbind(intent);
    }

    @Override
    public void onDestroy() {
        instance = null;
        super.onDestroy();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) { /* 不需要處理事件，只做主動查詢 */ }

    @Override
    public void onInterrupt() { }

    // ───────────── 螢幕尺寸 ─────────────
    public int[] realSize() {
        DisplayMetrics dm = new DisplayMetrics();
        WindowManager wm = (WindowManager) getSystemService(WINDOW_SERVICE);
        wm.getDefaultDisplay().getRealMetrics(dm);
        return new int[]{dm.widthPixels, dm.heightPixels};
    }

    // ───────────── 手勢 ─────────────
    public void gesture(float x1, float y1, float x2, float y2, long durationMs, final GestureCb cb) {
        try {
            Path path = new Path();
            path.moveTo(x1, y1);
            if (x1 != x2 || y1 != y2) path.lineTo(x2, y2);
            else path.lineTo(x1 + 0.01f, y1);   // 長按：起訖相同點時 lineTo 微小位移，避免部分系統忽略零長度路徑
            long d = Math.max(1, durationMs);
            GestureDescription.Builder b = new GestureDescription.Builder();
            b.addStroke(new GestureDescription.StrokeDescription(path, 0, d));
            boolean sent = dispatchGesture(b.build(), new GestureResultCallback() {
                @Override public void onCompleted(GestureDescription g) { cb.done(true); }
                @Override public void onCancelled(GestureDescription g) { cb.done(false); }
            }, null);
            if (!sent) cb.done(false);
        } catch (Exception e) {
            cb.done(false);
        }
    }

    public boolean global(String name) {
        int a;
        switch (name) {
            case "back": a = GLOBAL_ACTION_BACK; break;
            case "home": a = GLOBAL_ACTION_HOME; break;
            case "recents": a = GLOBAL_ACTION_RECENTS; break;
            case "notifications": a = GLOBAL_ACTION_NOTIFICATIONS; break;
            default: return false;
        }
        return performGlobalAction(a);
    }

    // ───────────── 輸入焦點操作 ─────────────
    private AccessibilityNodeInfo focusedInput() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return null;
        AccessibilityNodeInfo f = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        return f;
    }

    public boolean setText(String text) {
        AccessibilityNodeInfo f = focusedInput();
        if (f == null) return false;
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
        return f.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
    }

    public boolean paste() {
        AccessibilityNodeInfo f = focusedInput();
        if (f == null) return false;
        return f.performAction(AccessibilityNodeInfo.ACTION_PASTE);
    }

    public boolean imeEnter() {
        if (Build.VERSION.SDK_INT < 30) return false;
        AccessibilityNodeInfo f = focusedInput();
        if (f == null) return false;
        return f.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId());
    }

    public String foregroundPackage() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null || root.getPackageName() == null) return "";
        return root.getPackageName().toString();
    }

    // ───────────── 元件階層 → XML ─────────────
    public String dumpHierarchy() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        int[] sz = realSize();
        StringBuilder sb = new StringBuilder(8192);
        sb.append("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>");
        sb.append("<hierarchy rotation=\"0\">");
        sb.append("<node index=\"0\" text=\"\" resource-id=\"\" class=\"android.widget.FrameLayout\" package=\"")
          .append(esc(root != null && root.getPackageName() != null ? root.getPackageName().toString() : ""))
          .append("\" content-desc=\"\" checkable=\"false\" checked=\"false\" clickable=\"false\" enabled=\"true\" focusable=\"false\" focused=\"false\" scrollable=\"false\" long-clickable=\"false\" password=\"false\" selected=\"false\" bounds=\"[0,0][")
          .append(sz[0]).append(',').append(sz[1]).append("]\">");
        if (root != null) {
            int[] counter = new int[]{0};
            walk(root, sb, 0, counter);
        }
        sb.append("</node></hierarchy>");
        return sb.toString();
    }

    private void walk(AccessibilityNodeInfo n, StringBuilder sb, int depth, int[] counter) {
        if (n == null || depth > 60 || counter[0] > 3000) return;
        counter[0]++;
        Rect r = new Rect();
        n.getBoundsInScreen(r);
        boolean visible = n.isVisibleToUser();
        if (visible) {
            sb.append("<node index=\"").append(counter[0]).append("\" text=\"").append(esc(n.getText()))
              .append("\" resource-id=\"").append(esc(n.getViewIdResourceName()))
              .append("\" class=\"").append(esc(n.getClassName()))
              .append("\" package=\"").append(esc(n.getPackageName()))
              .append("\" content-desc=\"").append(esc(n.getContentDescription()))
              .append("\" checkable=\"").append(n.isCheckable())
              .append("\" checked=\"").append(n.isChecked())
              .append("\" clickable=\"").append(n.isClickable())
              .append("\" enabled=\"").append(n.isEnabled())
              .append("\" focusable=\"").append(n.isFocusable())
              .append("\" focused=\"").append(n.isFocused())
              .append("\" scrollable=\"").append(n.isScrollable())
              .append("\" long-clickable=\"").append(n.isLongClickable())
              .append("\" password=\"").append(n.isPassword())
              .append("\" selected=\"").append(n.isSelected())
              .append("\" bounds=\"[").append(r.left).append(',').append(r.top).append("][").append(r.right).append(',').append(r.bottom).append("]\">");
        }
        int c = n.getChildCount();
        for (int i = 0; i < c; i++) {
            AccessibilityNodeInfo ch = n.getChild(i);
            if (ch != null) {
                walk(ch, sb, depth + 1, counter);
                if (Build.VERSION.SDK_INT < 33) ch.recycle();
            }
        }
        if (visible) sb.append("</node>");
    }

    private static String esc(CharSequence s) {
        if (s == null) return "";
        StringBuilder o = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            switch (ch) {
                case '&': o.append("&amp;"); break;
                case '<': o.append("&lt;"); break;
                case '>': o.append("&gt;"); break;
                case '"': o.append("&quot;"); break;
                case '\'': o.append("&apos;"); break;
                case '\n': o.append("&#10;"); break;
                case '\r': o.append("&#13;"); break;
                default:
                    if (ch < 0x20 && ch != '\t') o.append(' '); else o.append(ch);
            }
        }
        return o.toString();
    }

    // ───────────── 截圖（API 30+） ─────────────
    public void screenshot(final int maxDim, final int quality, final ShotCb cb) {
        if (Build.VERSION.SDK_INT < 30) { cb.done(null, 0, 0, "截圖需要 Android 11（API 30）以上"); return; }
        try {
            takeScreenshot(Display.DEFAULT_DISPLAY, getMainExecutor(), new TakeScreenshotCallback() {
                @Override
                public void onSuccess(ScreenshotResult result) {
                    try {
                        Bitmap hw = Bitmap.wrapHardwareBuffer(result.getHardwareBuffer(), result.getColorSpace());
                        if (hw == null) { cb.done(null, 0, 0, "截圖緩衝區為空"); return; }
                        Bitmap sw = hw.copy(Bitmap.Config.ARGB_8888, false);
                        hw.recycle();
                        result.getHardwareBuffer().close();
                        int w = sw.getWidth(), h = sw.getHeight();
                        float scale = Math.min(1f, (float) maxDim / Math.max(w, h));
                        Bitmap out = sw;
                        if (scale < 1f) out = Bitmap.createScaledBitmap(sw, Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)), true);
                        ByteArrayOutputStream bos = new ByteArrayOutputStream();
                        out.compress(Bitmap.CompressFormat.JPEG, quality, bos);
                        String b64 = Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
                        int ow = out.getWidth(), oh = out.getHeight();
                        if (out != sw) out.recycle();
                        sw.recycle();
                        cb.done(b64, ow, oh, null);
                    } catch (Exception e) {
                        cb.done(null, 0, 0, "截圖處理失敗：" + e.getMessage());
                    }
                }

                @Override
                public void onFailure(int errorCode) {
                    cb.done(null, 0, 0, "截圖失敗（錯誤碼 " + errorCode + "；可能是畫面含 FLAG_SECURE 或呼叫太頻繁，兩次截圖需間隔約 1 秒）");
                }
            });
        } catch (Exception e) {
            cb.done(null, 0, 0, "截圖例外：" + e.getMessage());
        }
    }
}

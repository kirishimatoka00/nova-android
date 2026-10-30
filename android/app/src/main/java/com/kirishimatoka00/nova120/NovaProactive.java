package com.kirishimatoka00.nova120;

import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Calendar;
import java.util.Iterator;

/**
 * v2.6.101：AI 主動說話（原生端核心）。
 *
 * 流程：JS（nova-proactive.js）把「各對話的設定＋情境＋預定時間表（plan）」存進 SharedPreferences →
 *   這裡用 AlarmManager 排下一個預定時間 → 到點由 NovaProactiveReceiver 叫起，
 *   直接呼叫 Gemini 產生一句符合角色與當下時間的話 → 發通知，並放進「收件匣」→
 *   使用者下次打開 App，JS 取回收件匣並寫進對應對話。
 *
 * 設計取捨：
 *   - 隨機時間的計算放在 JS（可測試）；原生只負責「到點執行」，所以預定時間表用完（預設約 3 天）就會自己停下來，
 *     使用者很久沒開 App 時不會一直打擾。
 *   - 同一對話連續 maxUnanswered 則都沒被回應就暫停，使用者發言（lastUserTs 更新）後自動恢復。
 *   - Alarm 廣播只有約 10 秒可用（goAsync），所以整體有 deadline；失敗的單則直接略過，不重試。
 */
public final class NovaProactive {
    static final String PREFS = "nova_proactive";
    static final String K_CFG = "cfg";
    static final String K_STATE = "state";
    static final String K_INBOX = "inbox";
    static final String K_LAUNCH = "launch";
    static final String CHANNEL = "nova_proactive";
    static final String ACTION_FIRE = "com.kirishimatoka00.nova120.PROACTIVE_FIRE";
    static final String EXTRA_OPEN = "nova_open_session";
    static final long LATE_GRACE_MS = 20L * 60L * 1000L;     // 錯過超過 20 分鐘的預定時間就放棄
    static final int ALARM_REQ = 7301;
    private static final Object LOCK = new Object();

    private NovaProactive() {}

    /* ───────── SharedPreferences 小工具 ───────── */
    static SharedPreferences sp(Context c) { return c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    static JSONObject readObj(Context c, String key) {
        try { String s = sp(c).getString(key, null); if (s != null && s.length() > 0) return new JSONObject(s); } catch (Exception e) { /* 壞掉就當空的 */ }
        return new JSONObject();
    }

    static JSONArray readArr(Context c, String key) {
        try { String s = sp(c).getString(key, null); if (s != null && s.length() > 0) return new JSONArray(s); } catch (Exception e) { /* 壞掉就當空的 */ }
        return new JSONArray();
    }

    static void write(Context c, String key, Object json) { sp(c).edit().putString(key, String.valueOf(json)).apply(); }

    /* ───────── 設定與排程 ───────── */

    /** JS 同步設定。已發出但使用者之後有回應的對話，把「連續未回應數」歸零。 */
    static void configure(Context c, JSONObject cfg) {
        synchronized (LOCK) {
            try {
                JSONObject state = readObj(c, K_STATE);
                JSONObject sessions = cfg.optJSONObject("sessions");
                if (sessions != null) {
                    Iterator<String> it = sessions.keys();
                    while (it.hasNext()) {
                        String sid = it.next();
                        JSONObject s = sessions.optJSONObject(sid);
                        if (s == null) continue;
                        JSONObject st = state.optJSONObject(sid);
                        if (st == null) { st = new JSONObject(); state.put(sid, st); }
                        if (s.optLong("lastUserTs", 0) > st.optLong("lastSent", 0)) st.put("sentUnanswered", 0);
                    }
                }
                write(c, K_CFG, cfg);
                write(c, K_STATE, state);
            } catch (Exception e) { /* 設定壞了就維持舊的 */ }
        }
        schedule(c);
    }

    static void clearAll(Context c) {
        synchronized (LOCK) { sp(c).edit().remove(K_CFG).remove(K_STATE).remove(K_INBOX).apply(); }
        cancelAlarm(c);
    }

    /** 下一個尚未處理的預定時間（毫秒），沒有則 0。 */
    static long nextPlanned(Context c) {
        long now = System.currentTimeMillis(), best = 0;
        JSONObject cfg = readObj(c, K_CFG), state = readObj(c, K_STATE);
        JSONObject sessions = cfg.optJSONObject("sessions");
        if (sessions == null) return 0;
        Iterator<String> it = sessions.keys();
        while (it.hasNext()) {
            String sid = it.next();
            JSONObject s = sessions.optJSONObject(sid);
            if (s == null) continue;
            JSONObject st = state.optJSONObject(sid);
            long consumed = st == null ? 0 : st.optLong("consumed", 0);
            JSONArray plan = s.optJSONArray("plan");
            if (plan == null) continue;
            for (int i = 0; i < plan.length(); i++) {
                long at = plan.optLong(i, 0);
                if (at <= consumed || at < now - LATE_GRACE_MS) continue;
                if (best == 0 || at < best) best = at;
            }
        }
        return best;
    }

    static void schedule(Context c) {
        Context app = c.getApplicationContext();
        long next = nextPlanned(app);
        if (next == 0) { cancelAlarm(app); return; }
        long when = Math.max(next, System.currentTimeMillis() + 3000L);
        AlarmManager am = (AlarmManager) app.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        PendingIntent pi = alarmIntent(app);
        try {
            if (canExact(app)) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, when, pi);
            else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, when, pi);
        } catch (SecurityException e) {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, when, pi);
        }
    }

    static boolean canExact(Context c) {
        if (Build.VERSION.SDK_INT < 31) return true;
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        return am != null && am.canScheduleExactAlarms();
    }

    private static PendingIntent alarmIntent(Context c) {
        Intent i = new Intent(c, NovaProactiveReceiver.class).setAction(ACTION_FIRE);
        return PendingIntent.getBroadcast(c, ALARM_REQ, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static void cancelAlarm(Context c) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am != null) am.cancel(alarmIntent(c));
    }

    /* ───────── 到點執行 ───────── */

    /** 處理所有已到時間的預定項目。回傳實際送出的訊息數。deadline 前沒做完的留給下一輪。 */
    static int runDue(Context c, long deadlineMs) {
        int sent = 0;
        JSONObject cfg = readObj(c, K_CFG);
        JSONObject sessions = cfg.optJSONObject("sessions");
        if (sessions == null) return 0;
        java.util.ArrayList<String> sids = new java.util.ArrayList<>();
        Iterator<String> it = sessions.keys();
        while (it.hasNext()) sids.add(it.next());
        for (String sid : sids) {
            if (System.currentTimeMillis() > deadlineMs) break;
            JSONObject s = sessions.optJSONObject(sid);
            if (s == null) continue;
            long due = takeDue(c, sid, s);
            if (due == 0) continue;
            try {
                if (fireOne(c, cfg, sid, s, false, deadlineMs)) sent++;
            } catch (Exception e) {
                recordError(c, sid, e);
            }
        }
        return sent;
    }

    /** 找出這個對話已到時間的預定項目，標記為已處理（先標記，避免當掉後無限重來），回傳該時間；沒有則 0。 */
    private static long takeDue(Context c, String sid, JSONObject s) {
        synchronized (LOCK) {
            long now = System.currentTimeMillis();
            JSONObject state = readObj(c, K_STATE);
            JSONObject st = state.optJSONObject(sid);
            if (st == null) st = new JSONObject();
            long consumed = st.optLong("consumed", 0), take = 0, stale = 0;
            JSONArray plan = s.optJSONArray("plan");
            if (plan == null) return 0;
            for (int i = 0; i < plan.length(); i++) {
                long at = plan.optLong(i, 0);
                if (at <= consumed || at > now + 30000L) continue;
                if (at < now - LATE_GRACE_MS) { if (at > stale) stale = at; continue; }   // 錯過太久：略過不補
                if (at > take) take = at;
            }
            long mark = Math.max(take, stale);
            if (mark == 0) return 0;
            try { st.put("consumed", mark); state.put(sid, st); write(c, K_STATE, state); } catch (Exception e) { /* ignore */ }
            return take;
        }
    }

    private static void recordError(Context c, String sid, Exception e) {
        synchronized (LOCK) {
            try {
                JSONObject state = readObj(c, K_STATE);
                JSONObject st = state.optJSONObject(sid);
                if (st == null) st = new JSONObject();
                String m = e.getMessage();
                st.put("lastError", (m == null ? e.getClass().getSimpleName() : m) + " @" + System.currentTimeMillis());
                state.put(sid, st);
                write(c, K_STATE, state);
            } catch (Exception ignore) { /* ignore */ }
        }
    }

    /**
     * 產生並送出一則主動訊息。force=true（測試）時略過「連續未回應上限」。
     * 回傳是否真的送出（模型回 [SKIP] 或被擋則為 false）。
     */
    static boolean fireOne(Context c, JSONObject cfg, String sid, JSONObject s, boolean force, long deadlineMs) throws Exception {
        JSONObject state = readObj(c, K_STATE);
        JSONObject st = state.optJSONObject(sid);
        if (st == null) st = new JSONObject();
        int maxUn = s.optInt("maxUnanswered", 3);
        if (!force && st.optInt("sentUnanswered", 0) >= maxUn) return false;
        String key = cfg.optString("apiKey", "");
        if (key.length() == 0) throw new Exception("原生端沒有 Gemini 金鑰（請開啟 App 讓它同步）");
        String text = generate(cfg, s, st, deadlineMs);
        if (text == null) return false;
        deliver(c, sid, s.optString("title", "NOVA"), text, st);
        return true;
    }

    /* ───────── 呼叫 Gemini ───────── */

    static String generate(JSONObject cfg, JSONObject s, JSONObject st, long deadlineMs) throws Exception {
        String model = cfg.optString("model", "gemini-2.5-flash").replaceAll("[^A-Za-z0-9._-]", "");
        if (model.length() == 0) model = "gemini-2.5-flash";
        long now = System.currentTimeMillis();

        // 系統指令：角色口吻、規則
        StringBuilder sys = new StringBuilder();
        sys.append("你正在延續下方「對話紀錄」裡的角色扮演／日常對話。這一次不是使用者在發話，而是你要主動傳一則訊息給使用者。\n");
        sys.append("規則：\n");
        sys.append("1. 完全維持對話紀錄中你的角色、口吻、語言與設定，不要提到你是 AI 或這是自動產生的。\n");
        sys.append("2. 自然承接前文脈絡（使用者最近的狀況、答應過或約好的事、正在聊的話題），並符合「現在時間」（例如早上問候、中午問吃飯、深夜提醒休息）；不要硬找話題。\n");
        sys.append("3. 一到三句話，像真人傳訊息；不要標題、清單、動作旁白以外的格式。\n");
        sys.append("4. 不要重複「你最近主動說過的話」的內容與句型。\n");
        sys.append("5. 如果使用者很久沒回，可以輕鬆提起，但不要責備或催促。\n");
        sys.append("6. 如果此刻不適合打擾（例如前文使用者說要睡了、在忙到某個時間之後），只輸出 [SKIP]，不要輸出其他文字。\n");
        sys.append("只輸出訊息本身。");
        String extra = s.optString("extra", "").trim();
        if (extra.length() > 0) sys.append("\n\n使用者額外指示：").append(extra);

        // 使用者內容：時間感知＋對話紀錄
        Calendar cal = Calendar.getInstance();
        String[] wd = {"日", "一", "二", "三", "四", "五", "六"};
        int h = cal.get(Calendar.HOUR_OF_DAY), mi = cal.get(Calendar.MINUTE);
        StringBuilder u = new StringBuilder();
        u.append("【現在時間】")
                .append(cal.get(Calendar.YEAR)).append("-").append(two(cal.get(Calendar.MONTH) + 1)).append("-").append(two(cal.get(Calendar.DAY_OF_MONTH)))
                .append("（週").append(wd[cal.get(Calendar.DAY_OF_WEEK) - 1]).append("）")
                .append(two(h)).append(":").append(two(mi)).append(" ").append(period(h)).append("\n");
        long lastUser = s.optLong("lastUserTs", 0);
        if (lastUser > 0) u.append("【距離使用者上次發言】").append(gap(now - lastUser)).append("\n");
        JSONArray recent = st.optJSONArray("recent");
        if (recent != null && recent.length() > 0) {
            u.append("【你最近主動說過的話（不要重複）】\n");
            for (int i = 0; i < recent.length(); i++) u.append("- ").append(recent.optString(i)).append("\n");
        }
        u.append("\n【對話紀錄（舊到新）】\n");
        JSONArray ctx = s.optJSONArray("context");
        if (ctx != null) {
            for (int i = 0; i < ctx.length(); i++) {
                JSONObject m = ctx.optJSONObject(i);
                if (m == null) continue;
                u.append("u".equals(m.optString("r")) ? "使用者：" : "你：").append(m.optString("t")).append("\n");
            }
        }
        u.append("\n請寫出你這次要主動傳給使用者的訊息。");

        JSONObject body = new JSONObject();
        body.put("systemInstruction", new JSONObject().put("parts", new JSONArray().put(new JSONObject().put("text", sys.toString()))));
        body.put("contents", new JSONArray().put(new JSONObject().put("role", "user")
                .put("parts", new JSONArray().put(new JSONObject().put("text", u.toString())))));
        body.put("generationConfig", new JSONObject().put("maxOutputTokens", 2048));

        long left = deadlineMs - System.currentTimeMillis();
        int timeout = (int) Math.max(3000L, Math.min(left, 25000L));
        String resp = httpPost("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent",
                cfg.optString("apiKey", ""), body.toString(), timeout);
        JSONObject r = new JSONObject(resp);
        JSONObject pf = r.optJSONObject("promptFeedback");
        if (pf != null && pf.optString("blockReason", "").length() > 0) throw new Exception("提示被 Gemini 擋下：" + pf.optString("blockReason"));
        JSONArray cands = r.optJSONArray("candidates");
        if (cands == null || cands.length() == 0) throw new Exception("Gemini 沒有回覆");
        JSONObject cand = cands.optJSONObject(0);
        JSONObject content = cand == null ? null : cand.optJSONObject("content");
        JSONArray parts = content == null ? null : content.optJSONArray("parts");
        StringBuilder out = new StringBuilder();
        if (parts != null) {
            for (int i = 0; i < parts.length(); i++) {
                JSONObject p = parts.optJSONObject(i);
                if (p == null || p.optBoolean("thought", false)) continue;
                out.append(p.optString("text", ""));
            }
        }
        String text = out.toString().trim();
        if (text.length() == 0) throw new Exception("Gemini 回覆是空的（finishReason=" + (cand == null ? "?" : cand.optString("finishReason", "?")) + "）");
        if (text.startsWith("[SKIP]") || text.equalsIgnoreCase("skip")) return null;
        if (text.length() > 600) text = text.substring(0, 600);
        return text;
    }

    private static String httpPost(String url, String key, String body, int timeoutMs) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            c.setConnectTimeout(Math.min(timeoutMs, 6000));
            c.setReadTimeout(timeoutMs);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            c.setRequestProperty("x-goog-api-key", key);
            OutputStream os = c.getOutputStream();
            os.write(body.getBytes(StandardCharsets.UTF_8));
            os.close();
            int code = c.getResponseCode();
            InputStream is = code >= 200 && code < 300 ? c.getInputStream() : c.getErrorStream();
            String text = is == null ? "" : readAll(is);
            if (code < 200 || code >= 300) {
                String msg = text;
                try { msg = new JSONObject(text).getJSONObject("error").optString("message", text); } catch (Exception ignore) { /* 用原文 */ }
                if (msg.length() > 200) msg = msg.substring(0, 200);
                throw new Exception("Gemini HTTP " + code + "：" + msg);
            }
            return text;
        } finally {
            c.disconnect();
        }
    }

    private static String readAll(InputStream is) throws Exception {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = is.read(buf)) > 0) bo.write(buf, 0, n);
        is.close();
        return bo.toString("UTF-8");
    }

    /* ───────── 送達：收件匣＋通知 ───────── */

    static void deliver(Context c, String sid, String title, String text, JSONObject st) {
        long now = System.currentTimeMillis();
        synchronized (LOCK) {
            try {
                JSONArray inbox = readArr(c, K_INBOX);
                inbox.put(new JSONObject().put("sid", sid).put("text", text).put("ts", now));
                write(c, K_INBOX, inbox);
                JSONObject state = readObj(c, K_STATE);
                JSONObject cur = state.optJSONObject(sid);
                if (cur == null) cur = st != null ? st : new JSONObject();
                cur.put("sentUnanswered", cur.optInt("sentUnanswered", 0) + 1);
                cur.put("lastSent", now);
                cur.remove("lastError");
                JSONArray old = cur.optJSONArray("recent"), neu = new JSONArray();
                if (old != null) { for (int i = Math.max(0, old.length() - 4); i < old.length(); i++) neu.put(old.optString(i)); }
                neu.put(text.length() > 80 ? text.substring(0, 80) : text);
                cur.put("recent", neu);
                state.put(sid, cur);
                write(c, K_STATE, state);
            } catch (Exception e) { /* 收件匣寫入失敗仍嘗試發通知 */ }
        }
        notifyUser(c, sid, title, text);
    }

    static void notifyUser(Context c, String sid, String title, String text) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "NOVA 主動訊息", NotificationManager.IMPORTANCE_DEFAULT);
            ch.setDescription("AI 角色在對話中主動傳來的訊息");
            nm.createNotificationChannel(ch);
        }
        Intent open = new Intent(c, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        open.putExtra(EXTRA_OPEN, sid);
        int id = 9000 + Math.abs(sid.hashCode() % 900);
        PendingIntent pi = PendingIntent.getActivity(c, id, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CHANNEL)
                .setSmallIcon(c.getApplicationInfo().icon)
                .setContentTitle(title == null || title.length() == 0 ? "NOVA" : title)
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setAutoCancel(true)
                .setContentIntent(pi);
        nm.notify(id, b.build());
    }

    /* ───────── 取回收件匣／啟動資訊 ───────── */

    static JSONArray takeInbox(Context c) {
        synchronized (LOCK) {
            JSONArray a = readArr(c, K_INBOX);
            sp(c).edit().remove(K_INBOX).apply();
            return a;
        }
    }

    static void saveLaunch(Context c, String sid) { if (sid != null && sid.length() > 0) sp(c).edit().putString(K_LAUNCH, sid).apply(); }

    static String takeLaunch(Context c) {
        String s = sp(c).getString(K_LAUNCH, "");
        sp(c).edit().remove(K_LAUNCH).apply();
        return s == null ? "" : s;
    }

    /* ───────── 小工具 ───────── */

    private static String two(int n) { return n < 10 ? "0" + n : String.valueOf(n); }

    static String period(int h) {
        if (h >= 5 && h < 8) return "清晨";
        if (h >= 8 && h < 11) return "上午";
        if (h >= 11 && h < 13) return "中午";
        if (h >= 13 && h < 17) return "下午";
        if (h >= 17 && h < 19) return "傍晚";
        if (h >= 19 && h < 23) return "晚上";
        return "深夜";
    }

    static String gap(long ms) {
        long m = ms / 60000L;
        if (m < 2) return "剛剛";
        if (m < 60) return "約 " + m + " 分鐘";
        long h = m / 60;
        if (h < 24) return "約 " + h + " 小時";
        return "約 " + (h / 24) + " 天";
    }
}

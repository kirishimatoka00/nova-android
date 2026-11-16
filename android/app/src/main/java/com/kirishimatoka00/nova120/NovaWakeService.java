package com.kirishimatoka00.nova120;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.KeyguardManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.media.ToneGenerator;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONObject;
import org.vosk.LibVosk;
import org.vosk.LogLevel;
import org.vosk.Model;
import org.vosk.Recognizer;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/*
 * NovaWakeService — NOVA 常駐背景＋語音喚醒「嘿 小希」（Vosk 離線辨識）
 *
 * 版本紀錄（本檔）
 *   v1.0.0 2026-11-15  App v2.6.145 新增（使用者要求：①不會因「全部關閉」而被關掉，只有通知列「關閉 NOVA」才結束；
 *                      ②沒關閉時對手機喊「嘿 小希」就打開 NOVA、開新對話並自動開始聽）。
 *     ・前景服務＋常駐通知（stopWithTask=false：從最近使用清單滑掉／全部關閉只收掉畫面，服務與通知仍在）；通知按鈕：
 *       開新對話／暫停聆聽（恢復聆聽）／關閉 NOVA。「關閉 NOVA」結束畫面並結束程序（正在原生錄音時只關畫面與本服務，不中斷錄音）。
 *     ・聆聽：AudioRecord 16kHz 單聲道 → 簡單音量門檻（安靜時不送辨識、省電；開門時補送前 0.3 秒）→ Vosk 中文小模型，
 *       文法限定在喚醒詞與同音字（嘿 小希／小西／小溪／曉希）＋[unk]，只保留模型詞彙表裡有的寫法。
 *       靈敏度：低＝要完整聽到「嘿 小希」且信心 ≥0.90；中＝「小希」信心 ≥0.80；高＝「小希」信心 ≥0.60。觸發後 4 秒內不重複。
 *     ・讓麥克風：NOVA 畫面在前景（App 自己的語音輸入）、原生錄音中、等待解鎖時都會關掉麥克風；回到背景再恢復。
 *     ・喚醒後：嗶一聲。螢幕亮著且已解鎖 → 直接打開 NOVA；鎖定或螢幕關 → 點亮螢幕並顯示提示通知，等使用者解鎖（USER_PRESENT，
 *       30 秒內）才打開，對話內容不會出現在鎖定畫面上（使用者選的做法）。從背景叫出畫面需要「顯示在其他應用程式上層」或
 *       NOVA 無障礙服務執行中；兩者都沒有時改發高優先通知讓使用者點開。打開時帶 EXTRA_WAKE，JS 取走後開新對話並開始語音輸入。
 *     ・Android 14 以上從背景重啟服務時不能用麥克風類型，會改用 specialUse 常駐並在通知提示「打開 NOVA 一次」才恢復聆聽。
 */
public class NovaWakeService extends Service {

    static final String ACT_START = "com.kirishimatoka00.nova120.wake.START";
    static final String ACT_QUIT = "com.kirishimatoka00.nova120.wake.QUIT";
    static final String ACT_TOGGLE = "com.kirishimatoka00.nova120.wake.TOGGLE";
    static final String ACT_TEST = "com.kirishimatoka00.nova120.wake.TEST";

    private static final String CH_KEEP = "nova_keepalive";
    private static final String CH_ALERT = "nova_wake_alert";
    private static final int NID = 7201, NID_ALERT = 7202;
    private static final int RATE = 16000, CHUNK = 3200;   // 100 ms

    // 給 NovaWakePlugin 讀的狀態
    static volatile NovaWakeService inst;
    static volatile String state = "off";
    static volatile String stateMsg = "";
    static volatile String lastHeard = "";
    static volatile long lastWakeAt = 0;
    static volatile boolean micFgs = false;

    private Handler h;
    private Thread worker;
    private volatile boolean running;
    private volatile long testAt = 0;
    private volatile boolean pendingUnlock = false;
    private volatile long pendingUntil = 0;
    private BroadcastReceiver presentRx;
    private String lastNotifKey = "";

    private Model model;
    private String modelLoaded;
    private String grammar;
    private AudioRecord rec;
    private Recognizer recog;
    // 音量門檻
    private double noise = 0;
    private boolean gateOpen = false;
    private int hang = 0;
    private final ArrayList<byte[]> preRoll = new ArrayList<>();

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        inst = this;
        h = new Handler(Looper.getMainLooper());
        createChannels();
        presentRx = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) {
                if (Intent.ACTION_USER_PRESENT.equals(i.getAction()) && pendingUnlock && System.currentTimeMillis() < pendingUntil) {
                    pendingUnlock = false;
                    try { NotificationManagerCompat.from(c).cancel(NID_ALERT); } catch (Exception e) { /* */ }
                    launchApp();
                }
            }
        };
        try { ContextCompat.registerReceiver(this, presentRx, new IntentFilter(Intent.ACTION_USER_PRESENT), ContextCompat.RECEIVER_NOT_EXPORTED); } catch (Exception e) { /* */ }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String a = intent == null ? ACT_START : intent.getAction();
        if (ACT_TOGGLE.equals(a)) NovaWake.sp(this).edit().putBoolean(NovaWake.K_PAUSE, !NovaWake.userPaused(this)).apply();
        // 一律先進前景（用 startForegroundService 啟動的服務若沒呼叫 startForeground 就停止，系統會讓 App 當掉）
        boolean fg = goForeground();
        if (ACT_QUIT.equals(a)) { quitAll(); return START_NOT_STICKY; }
        if (!NovaWake.wanted(this)) { stopClean(); return START_NOT_STICKY; }
        if (!fg) return START_NOT_STICKY;
        if (ACT_TEST.equals(a)) testAt = System.currentTimeMillis() + 5000;
        ensureWorker();
        return START_STICKY;
    }

    // 使用者在最近使用清單把 NOVA 滑掉／按「全部關閉」：保持執行（只有通知列「關閉 NOVA」才結束）
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        super.onTaskRemoved(rootIntent);
        NovaWake.appVisible = false;
    }

    @Override
    public void onDestroy() {
        running = false;
        if (worker != null) worker.interrupt();
        try { unregisterReceiver(presentRx); } catch (Exception e) { /* */ }
        inst = null;
        state = "off";
        super.onDestroy();
    }

    private boolean micGranted() { return ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED; }

    /** 進入前景；有語音喚醒且有麥克風權限時用麥克風類型（Android 14+ 從背景啟動時會被拒絕，改用 specialUse） */
    private boolean goForeground() {
        Notification n = buildNotif();
        boolean wantMic = NovaWake.wakeOn(this) && micGranted();
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE;
                try {
                    startForeground(NID, n, wantMic ? (type | ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE) : type);
                    micFgs = wantMic;
                } catch (Exception e) {
                    startForeground(NID, n, type);
                    micFgs = false;
                }
            } else if (Build.VERSION.SDK_INT >= 29 && wantMic) {
                startForeground(NID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
                micFgs = true;
            } else {
                startForeground(NID, n);
                micFgs = wantMic;
            }
            return true;
        } catch (Exception e) {
            stateMsg = "無法啟動常駐服務：" + e.getMessage();
            stopSelf();
            return false;
        }
    }

    private void ensureWorker() {
        if (worker != null && worker.isAlive()) return;
        running = true;
        worker = new Thread(this::loop, "nova-wake");
        worker.setPriority(Thread.NORM_PRIORITY - 1);
        worker.start();
    }

    private void setState(String s) {
        if (!s.equals(state)) { state = s; updateNotif(); }
    }

    private void loop() {
        byte[] buf = new byte[CHUNK];
        while (running) {
            try {
                long now = System.currentTimeMillis();
                if (!NovaWake.wakeOn(this)) { closeAudio(); closeModel(); setState("keep"); Thread.sleep(1500); continue; }
                if (testAt > 0 && now >= testAt) { testAt = 0; onWake("（測試喚醒）"); continue; }
                if (NovaWake.userPaused(this)) { closeAudio(); setState("user-paused"); Thread.sleep(800); continue; }
                if (!micGranted()) { closeAudio(); setState("no-perm"); Thread.sleep(3000); continue; }
                if (pendingUnlock && now > pendingUntil) pendingUnlock = false;
                boolean busy = NovaWake.appVisible || NativeRecorder.get(this).isRecording() || pendingUnlock;
                if (busy) { closeAudio(); setState(pendingUnlock ? "unlock" : "app"); Thread.sleep(400); continue; }
                if (!micFgs && Build.VERSION.SDK_INT >= 30) { closeAudio(); setState("mic-bg"); Thread.sleep(3000); continue; }
                String md = NovaWake.modelDir(this);
                if (md == null) { closeAudio(); closeModel(); setState("no-model"); Thread.sleep(3000); continue; }
                if (model == null || !md.equals(modelLoaded)) {
                    setState("loading");
                    closeAudio(); closeModel();
                    try { LibVosk.setLogLevel(LogLevel.WARNINGS); } catch (Throwable t) { /* */ }
                    model = new Model(md);
                    modelLoaded = md;
                    grammar = buildGrammar(md);
                }
                if (rec == null && !openAudio()) { setState("mic-busy"); Thread.sleep(2000); continue; }
                setState("listening");
                int n = rec.read(buf, 0, buf.length);
                if (n <= 0) { closeAudio(); Thread.sleep(500); continue; }
                process(buf, n);
            } catch (InterruptedException ie) {
                break;
            } catch (Throwable t) {
                stateMsg = String.valueOf(t);
                closeAudio();
                setState("error");
                try { Thread.sleep(4000); } catch (InterruptedException ie) { break; }
            }
        }
        closeAudio();
        closeModel();
    }

    @SuppressLint("MissingPermission")
    private boolean openAudio() {
        try {
            if (!micGranted()) return false;
            int min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            AudioRecord r = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, CHUNK * 8));
            if (r.getState() != AudioRecord.STATE_INITIALIZED) { r.release(); return false; }
            r.startRecording();
            if (r.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) { r.release(); return false; }
            rec = r;
            recog = new Recognizer(model, (float) RATE, grammar);
            recog.setWords(true);
            noise = 0; gateOpen = false; hang = 0; preRoll.clear();
            return true;
        } catch (Exception e) {
            stateMsg = "麥克風開啟失敗：" + e.getMessage();
            closeAudio();
            return false;
        }
    }

    private void closeAudio() {
        try { if (rec != null) { rec.stop(); } } catch (Exception e) { /* */ }
        try { if (rec != null) { rec.release(); } } catch (Exception e) { /* */ }
        rec = null;
        try { if (recog != null) recog.close(); } catch (Exception e) { /* */ }
        recog = null;
        gateOpen = false; preRoll.clear();
    }

    private void closeModel() {
        try { if (model != null) model.close(); } catch (Exception e) { /* */ }
        model = null; modelLoaded = null;
    }

    /** 音量門檻：安靜時只估噪音、不送辨識；有聲音才把前 0.3 秒與後續送進 Vosk，聲音停 1 秒後收尾判斷 */
    private void process(byte[] b, int n) {
        long sum = 0;
        for (int i = 0; i + 1 < n; i += 2) { int s = (short) ((b[i] & 0xff) | (b[i + 1] << 8)); sum += (long) s * s; }
        double rms = Math.sqrt(sum / Math.max(1.0, n / 2.0));
        if (!gateOpen) noise = noise == 0 ? rms : noise * 0.97 + rms * 0.03;
        double thr = Math.max(220, noise * 2.5);
        byte[] copy = new byte[n];
        System.arraycopy(b, 0, copy, 0, n);
        if (rms > thr) {
            if (!gateOpen) {
                gateOpen = true;
                for (byte[] p : preRoll) feed(p, p.length);
                preRoll.clear();
            }
            hang = 10;
        }
        if (gateOpen) {
            feed(copy, n);
            if (rms <= thr && --hang <= 0) {
                gateOpen = false;
                try { handle(recog.getFinalResult()); recog.reset(); } catch (Exception e) { /* */ }
            }
        } else {
            preRoll.add(copy);
            while (preRoll.size() > 3) preRoll.remove(0);
        }
    }

    private void feed(byte[] b, int n) {
        try { if (recog != null && recog.acceptWaveForm(b, n)) handle(recog.getResult()); } catch (Exception e) { /* */ }
    }

    private static final String[] FULL = { "嘿小希", "嘿小西", "黑小希", "嘿小溪", "嘿曉希" };
    private static final String[] CORE = { "小希", "小西", "小溪", "曉希" };

    private void handle(String json) {
        if (json == null) return;
        try {
            JSONObject o = new JSONObject(json);
            String text = o.optString("text", "").trim();
            if (text.isEmpty()) return;
            lastHeard = text;
            String t = text.replace(" ", "");
            double minConf = 1.0;
            JSONArray ws = o.optJSONArray("result");
            if (ws != null) for (int i = 0; i < ws.length(); i++) {
                JSONObject w = ws.optJSONObject(i); if (w == null) continue;
                String word = w.optString("word", "");
                if (word.equals("嘿") || word.equals("黑") || word.equals("[unk]")) continue;
                minConf = Math.min(minConf, w.optDouble("conf", 1.0));
            }
            int sens = NovaWake.sens(this);
            boolean hit;
            if (sens == 0) hit = containsAny(t, FULL) && minConf >= 0.90;
            else if (sens == 1) hit = containsAny(t, CORE) && minConf >= 0.80;
            else hit = containsAny(t, CORE) && minConf >= 0.60;
            if (hit) onWake(text);
        } catch (Exception e) { /* */ }
    }

    private static boolean containsAny(String t, String[] arr) { for (String s : arr) if (t.contains(s)) return true; return false; }

    /** 文法：喚醒詞與同音字的幾種寫法，只留模型詞彙表裡有的（沒讀到詞彙表就全留，Vosk 會忽略不認得的） */
    private String buildGrammar(String md) {
        String[][] cand = {
            { "嘿", "小", "希" }, { "嘿", "小", "西" }, { "黑", "小", "希" }, { "嘿", "小", "溪" }, { "嘿", "曉", "希" },
            { "小", "希" }, { "小", "西" }, { "小", "溪" }, { "曉", "希" },
            { "嘿", "小希" }, { "嘿", "小西" }, { "小希" }, { "小西" }
        };
        Set<String> need = new HashSet<>();
        for (String[] c : cand) for (String w : c) need.add(w);
        Set<String> vocab = null;
        File wf = new File(md, "graph/words.txt");
        if (wf.isFile()) {
            vocab = new HashSet<>();
            try (BufferedReader br = new BufferedReader(new InputStreamReader(new FileInputStream(wf), StandardCharsets.UTF_8))) {
                String line;
                while ((line = br.readLine()) != null) {
                    int sp = line.indexOf(' ');
                    String w = sp > 0 ? line.substring(0, sp) : line;
                    if (need.contains(w)) vocab.add(w);
                }
            } catch (Exception e) { vocab = null; }
        }
        List<String> phrases = new ArrayList<>();
        for (String[] c : cand) {
            boolean ok = true;
            if (vocab != null) for (String w : c) if (!vocab.contains(w)) { ok = false; break; }
            if (ok) phrases.add(String.join(" ", c));
        }
        JSONArray g = new JSONArray();
        for (String p : phrases) g.put(p);
        g.put("[unk]");
        if (phrases.isEmpty()) stateMsg = "語音模型的詞彙表裡找不到「小希」，喚醒可能無法運作";
        return g.toString();
    }

    private void onWake(String heard) {
        long now = System.currentTimeMillis();
        if (now - lastWakeAt < 4000) return;
        lastWakeAt = now;
        lastHeard = heard;
        closeAudio();
        beep();
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        KeyguardManager km = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
        boolean locked = km != null && km.isKeyguardLocked();
        boolean screenOn = pm == null || pm.isInteractive();
        if (!screenOn && pm != null) {
            try {
                @SuppressWarnings("deprecation")
                PowerManager.WakeLock wl = pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP | PowerManager.ON_AFTER_RELEASE, "nova:wake");
                wl.acquire(8000);
            } catch (Exception e) { /* */ }
        }
        if (locked) {
            // 使用者選擇：鎖定時亮螢幕並要求解鎖，解鎖後才打開（對話內容不出現在鎖定畫面上）
            pendingUnlock = true;
            pendingUntil = now + 30_000L;
            showAlert("嘿 小希 👋", "解鎖後會打開 NOVA 並開新對話", false);
        } else {
            launchApp();
        }
    }

    private void launchApp() {
        NovaWake.markLaunch(this);
        Intent i = new Intent(this, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(NovaWake.EXTRA_WAKE, "1");
        if (NovaWake.canLaunchFromBackground(this)) {
            try { startActivity(i); return; } catch (Exception e) { /* 改用通知 */ }
        }
        showAlert("嘿 小希 👋", "點這裡打開 NOVA 開新對話（開啟「顯示在其他應用程式上層」權限後可直接打開）", true);
    }

    private void beep() {
        try {
            final ToneGenerator tg = new ToneGenerator(AudioManager.STREAM_NOTIFICATION, 70);
            tg.startTone(ToneGenerator.TONE_PROP_BEEP2, 160);
            h.postDelayed(() -> { try { tg.release(); } catch (Exception e) { /* */ } }, 500);
        } catch (Exception e) { /* */ }
    }

    private int piFlags() { return PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0); }

    private PendingIntent openPi(boolean wake, int req) {
        Intent i = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (wake) i.putExtra(NovaWake.EXTRA_WAKE, "1");
        return PendingIntent.getActivity(this, req, i, piFlags());
    }

    private PendingIntent svcPi(String action, int req) {
        Intent i = new Intent(this, NovaWakeService.class).setAction(action);
        return PendingIntent.getService(this, req, i, piFlags());
    }

    private void showAlert(String title, String text, boolean fullScreen) {
        try {
            NotificationCompat.Builder b = new NotificationCompat.Builder(this, CH_ALERT)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(title).setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setAutoCancel(true)
                .setTimeoutAfter(60_000L)
                .setContentIntent(openPi(true, 11));
            if (fullScreen) b.setFullScreenIntent(openPi(true, 12), true);
            NotificationManagerCompat.from(this).notify(NID_ALERT, b.build());
        } catch (SecurityException e) { /* 沒有通知權限 */ }
    }

    private String notifText() {
        if (!NovaWake.wakeOn(this)) return "常駐中。從最近使用清單滑掉也不會結束，按「關閉 NOVA」才會關閉";
        switch (state) {
            case "listening": return "正在聆聽「嘿 小希」";
            case "app": return "NOVA 開著，聆聽暫停（回到背景後恢復）";
            case "unlock": return "等待解鎖後打開 NOVA";
            case "user-paused": return "聆聽已暫停";
            case "no-model": return "語音喚醒：尚未下載語音模型（設定 → 語音）";
            case "no-perm": return "語音喚醒：沒有麥克風權限";
            case "mic-bg": return "請打開 NOVA 一次，才能在背景聆聽";
            case "mic-busy": return "麥克風被其他程式使用中，稍後重試";
            case "loading": return "載入語音模型中…";
            case "error": return "語音喚醒發生錯誤：" + stateMsg;
            default: return "常駐中";
        }
    }

    private Notification buildNotif() {
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CH_KEEP)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("NOVA 執行中")
            .setContentText(notifText())
            .setContentIntent(openPi(false, 1))
            .setOngoing(true)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .addAction(0, "開新對話", openPi(true, 2));
        if (NovaWake.wakeOn(this)) b.addAction(0, NovaWake.userPaused(this) ? "恢復聆聽" : "暫停聆聽", svcPi(ACT_TOGGLE, 3));
        b.addAction(0, "關閉 NOVA", svcPi(ACT_QUIT, 4));
        return b.build();
    }

    private void updateNotif() {
        String key = state + "|" + NovaWake.userPaused(this) + "|" + NovaWake.wakeOn(this);
        if (key.equals(lastNotifKey)) return;
        lastNotifKey = key;
        try { NotificationManagerCompat.from(this).notify(NID, buildNotif()); } catch (SecurityException e) { /* */ }
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel keep = new NotificationChannel(CH_KEEP, "NOVA 常駐與語音喚醒", NotificationManager.IMPORTANCE_LOW);
        keep.setDescription("讓 NOVA 在背景持續執行；通知上的「關閉 NOVA」可結束");
        keep.setShowBadge(false);
        nm.createNotificationChannel(keep);
        NotificationChannel alert = new NotificationChannel(CH_ALERT, "NOVA 語音喚醒提示", NotificationManager.IMPORTANCE_HIGH);
        alert.setDescription("聽到「嘿 小希」時的提示");
        nm.createNotificationChannel(alert);
    }

    /** 通知列「關閉 NOVA」：結束畫面、本服務，並結束程序（原生錄音中時不結束程序，以免中斷錄音） */
    private void quitAll() {
        running = false;
        if (worker != null) worker.interrupt();
        final Activity act = NovaWake.activity.get();
        if (act != null) h.post(() -> { try { act.finishAndRemoveTask(); } catch (Exception e) { /* */ } });
        try {
            if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE); else stopForeground(true);
        } catch (Exception e) { /* */ }
        stopSelf();
        final boolean recording = NativeRecorder.get(this).isRecording();
        if (!recording) h.postDelayed(() -> android.os.Process.killProcess(android.os.Process.myPid()), 700);
    }

    private void stopClean() {
        running = false;
        if (worker != null) worker.interrupt();
        try {
            if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE); else stopForeground(true);
        } catch (Exception e) { /* */ }
        stopSelf();
    }
}

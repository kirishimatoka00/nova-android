package com.kirishimatoka00.nova120;

import android.content.Context;
import android.media.AudioManager;
import android.media.AudioRecordingConfiguration;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.media.MediaRecorder;
import java.nio.ByteBuffer;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.FileInputStream;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * v2.6.49：原生錄音器（不經 WebView）。
 * 由前景服務（RecordingForegroundService）持有；錄成 AAC(ADTS) 串流檔，每 N 分鐘原生端自己換檔（自動分切）。
 * 檔案放在 App 外部私有資料夾 native_rec/：
 *   <sid>_<index>.aac   音檔（ADTS 是串流格式，就算行程被殺掉，已寫入的部分仍可播放）
 *   <sid>_<index>.done  該段結束的中繼資料（有 .done 才代表這段已結束可處理）
 *   <sid>.session       整次錄音的中繼資料
 * JS 端用 listFinished / ackSegment 取走檔案；WebView 崩潰或 App 被關掉都不影響錄音繼續。
 */
public class NativeRecorder {
    private static NativeRecorder inst;
    public static synchronized NativeRecorder get(Context c) {
        if (inst == null) inst = new NativeRecorder(c.getApplicationContext());
        return inst;
    }

    public static final int BITRATE = 64000;

    private final Context ctx;
    private final Handler h = new Handler(Looper.getMainLooper());
    private MediaRecorder rec;
    private boolean recording = false;
    private String sid = "";
    private String rctx = "record";
    private int idx = 0;
    private long segStart = 0;
    private long sessionStart = 0;
    private long splitMs = 0;
    private File curFile;
    private PowerManager.WakeLock wl;
    public volatile String lastError = "";

    private boolean lastSilenced = false;
    private long lastBeatSize = -1;
    private AudioManager.AudioRecordingCallback recCb;

    private NativeRecorder(Context c) { ctx = c; }

    // ───── v2.6.51：原生事件記錄（錄音異常時用來判斷原因）─────
    private final Object logLock = new Object();
    private final java.util.Set<String> remuxing = java.util.Collections.synchronizedSet(new java.util.HashSet<String>());
    private volatile Thread lastRemux = null;

    public void log(String m) {
        synchronized (logLock) { try {
            File f = new File(dir(), "rec.log");
            if (f.exists() && f.length() > 100 * 1024) {   // 過大就砍掉前半
                String all = readText(f);
                writeText(f, all.substring(all.length() / 2));
            }
            java.text.SimpleDateFormat sdf = new java.text.SimpleDateFormat("MM-dd HH:mm:ss", java.util.Locale.US);
            FileOutputStream o = new FileOutputStream(f, true);
            try { o.write((sdf.format(new java.util.Date()) + " " + m + "\n").getBytes("UTF-8")); } finally { o.close(); }
        } catch (Exception ignore) {} }
    }

    public String readLog(int maxChars) {
        synchronized (logLock) { try {
            File f = new File(dir(), "rec.log");
            if (!f.exists()) return "";
            String all = readText(f);
            return all.length() > maxChars ? all.substring(all.length() - maxChars) : all;
        } catch (Exception e) { return ""; } }
    }

    private final Runnable beatRun = new Runnable() {
        @Override public void run() {
            try {
                synchronized (NativeRecorder.this) {
                    if (!recording) return;
                    long sz = (curFile != null) ? curFile.length() : -1;
                    log("♥ 第" + (idx + 1) + "段 已寫入 " + (sz / 1024) + "KB" + (sz == lastBeatSize ? " ⚠檔案沒有成長（錄音可能已停擺或被靜音）" : ""));
                    lastBeatSize = sz;
                }
            } catch (Throwable ignore) {}
            h.postDelayed(this, 60000);
        }
    };

    private void registerSilenceWatch() {
        try {
            AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return;
            recCb = new AudioManager.AudioRecordingCallback() {
                @Override public void onRecordingConfigChanged(java.util.List<AudioRecordingConfiguration> configs) {
                    try {
                        boolean silenced = false;
                        if (Build.VERSION.SDK_INT >= 29 && configs != null) {
                            for (AudioRecordingConfiguration c : configs) if (c.isClientSilenced()) silenced = true;
                        }
                        if (silenced != lastSilenced) {
                            lastSilenced = silenced;
                            log(silenced ? "⚠ 麥克風被系統靜音（其他應用程式／系統佔用麥克風）" : "麥克風恢復");
                        }
                    } catch (Throwable ignore) {}
                }
            };
            am.registerAudioRecordingCallback(recCb, h);
        } catch (Throwable ignore) {}
    }

    private void unregisterSilenceWatch() {
        try {
            AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
            if (am != null && recCb != null) am.unregisterAudioRecordingCallback(recCb);
        } catch (Throwable ignore) {}
        recCb = null;
    }

    public synchronized boolean isRecording() { return recording; }
    public synchronized String getSid() { return sid; }
    public synchronized int getIndex() { return idx; }
    public synchronized long getSegStart() { return segStart; }
    public synchronized long getSessionStart() { return sessionStart; }
    public synchronized String getCtx() { return rctx; }

    public File dir() {
        File base = ctx.getExternalFilesDir(null);
        if (base == null) base = ctx.getFilesDir();
        File d = new File(base, "native_rec");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    private final Runnable splitRun = new Runnable() {
        @Override public void run() {
            try { doSplit(); }
            catch (Throwable t) { lastError = "分切發生例外：" + t; }
        }
    };

    public synchronized void start(String ctxName, int splitMins) throws Exception {
        if (recording) return;
        lastError = "";
        sid = Long.toString(System.currentTimeMillis());
        rctx = (ctxName == null || ctxName.isEmpty()) ? "record" : ctxName;
        splitMs = splitMins > 0 ? splitMins * 60000L : 0L;
        idx = 0;
        sessionStart = System.currentTimeMillis();
        acquireWake();
        try {
            beginSegment();
        } catch (Exception e) {
            releaseWake();
            lastError = String.valueOf(e.getMessage());
            throw e;
        }
        recording = true;
        writeSession(false);
        scheduleSplit();
        lastSilenced = false; lastBeatSize = -1;
        log("▶ 開始錄音 sid=" + sid + " ctx=" + rctx + " 分切=" + (splitMs / 60000) + "分");
        registerSilenceWatch();
        h.removeCallbacks(beatRun);
        h.postDelayed(beatRun, 60000);
    }

    private void beginSegment() throws Exception {
        curFile = new File(dir(), sid + "_" + idx + ".aac");
        MediaRecorder r = (Build.VERSION.SDK_INT >= 31) ? new MediaRecorder(ctx) : new MediaRecorder();
        try {
            r.setAudioSource(MediaRecorder.AudioSource.MIC);
            r.setOutputFormat(MediaRecorder.OutputFormat.AAC_ADTS);
            r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            r.setAudioChannels(1);
            r.setAudioSamplingRate(44100);
            r.setAudioEncodingBitRate(BITRATE);
            r.setOutputFile(curFile.getAbsolutePath());
            r.setOnErrorListener(new MediaRecorder.OnErrorListener() {
                @Override public void onError(MediaRecorder mr, int what, int extra) { log("⚠ 錄音器錯誤 what=" + what + " extra=" + extra); }
            });
            r.setOnInfoListener(new MediaRecorder.OnInfoListener() {
                @Override public void onInfo(MediaRecorder mr, int what, int extra) { log("ℹ 錄音器訊息 what=" + what + " extra=" + extra); }
            });
            r.prepare();
            r.start();
        } catch (Exception e) {
            try { r.release(); } catch (Exception ignore) {}
            throw e;
        }
        rec = r;
        segStart = System.currentTimeMillis();
    }

    private void endSegment() {
        final long end = System.currentTimeMillis();
        MediaRecorder r = rec;
        rec = null;
        if (r != null) {
            try { r.stop(); } catch (RuntimeException ignore) { /* 太短時 stop 會丟例外 */ }
            try { r.release(); } catch (Exception ignore) {}
        }
        final File dirF = dir();
        final String fsid = sid;
        final int fidx = idx;
        final String fctx = rctx;
        final long fstart = segStart;
        final File aac = curFile;
        final String base = fsid + "_" + fidx;
        remuxing.add(base);
        // v2.6.53：背景把 ADTS 轉封裝成 M4A（不重新編碼，只換容器），讓播放器拿得到正確總長度；失敗就沿用 aac
        Thread t = new Thread(new Runnable() {
            @Override public void run() {
                String finalName = base + ".aac";
                try {
                    if (aac != null && aac.exists() && aac.length() >= 2048) {
                        File tmp = new File(dirF, base + ".m4a.tmp");
                        File m4a = new File(dirF, base + ".m4a");
                        if (remux(aac, tmp) && tmp.length() > 1024 && tmp.renameTo(m4a)) {
                            aac.delete();
                            finalName = base + ".m4a";
                        } else {
                            tmp.delete();
                        }
                    }
                } catch (Throwable e) { log("⚠ 轉封裝例外：" + e); }
                try {
                    JSONObject o = new JSONObject();
                    o.put("sid", fsid);
                    o.put("index", fidx);
                    o.put("ctx", fctx);
                    o.put("startedAt", fstart);
                    o.put("endedAt", end);
                    o.put("file", finalName);
                    writeText(new File(dirF, base + ".done"), o.toString());
                } catch (Exception ignore) {}
                remuxing.remove(base);
            }
        });
        lastRemux = t;
        t.start();
    }

    /** ADTS(aac) → MP4(m4a)，不重新編碼 */
    private boolean remux(File in, File out) {
        MediaExtractor ex = new MediaExtractor();
        MediaMuxer mx = null;
        boolean started = false;
        try {
            ex.setDataSource(in.getAbsolutePath());
            int track = -1;
            MediaFormat fmt = null;
            for (int i = 0; i < ex.getTrackCount(); i++) {
                MediaFormat f = ex.getTrackFormat(i);
                String mime = f.getString(MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("audio/")) { track = i; fmt = f; break; }
            }
            if (track < 0) { log("⚠ 轉封裝：找不到音訊軌 " + in.getName()); return false; }
            ex.selectTrack(track);
            mx = new MediaMuxer(out.getAbsolutePath(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
            int dst = mx.addTrack(fmt);
            mx.start();
            started = true;
            ByteBuffer buf = ByteBuffer.allocate(1 << 16);
            MediaCodec.BufferInfo bi = new MediaCodec.BufferInfo();
            while (true) {
                buf.clear();
                int n = ex.readSampleData(buf, 0);
                if (n < 0) break;
                bi.offset = 0;
                bi.size = n;
                bi.presentationTimeUs = ex.getSampleTime();
                bi.flags = (ex.getSampleFlags() & MediaExtractor.SAMPLE_FLAG_SYNC) != 0 ? MediaCodec.BUFFER_FLAG_KEY_FRAME : 0;
                mx.writeSampleData(dst, buf, bi);
                ex.advance();
            }
            mx.stop();
            started = false;
            return true;
        } catch (Throwable t) {
            log("⚠ 轉封裝失敗（改用 aac）：" + t);
            return false;
        } finally {
            try { ex.release(); } catch (Throwable ignore) {}
            try { if (mx != null) { if (started) { try { mx.stop(); } catch (Throwable ignore2) {} } mx.release(); } } catch (Throwable ignore) {}
        }
    }

    private void scheduleSplit() {
        h.removeCallbacks(splitRun);
        if (splitMs > 0) h.postDelayed(splitRun, splitMs);
    }

    private synchronized void doSplit() {
        if (!recording) return;
        endSegment();
        idx++;
        log("✂ 分切 → 第" + (idx + 1) + "段");
        try {
            beginSegment();
        } catch (Exception e1) {
            try { Thread.sleep(300); beginSegment(); }
            catch (Exception e2) {
                lastError = "分切後無法重新開始錄音：" + e2.getMessage();
                log("⚠ " + lastError);
                recording = false;
                writeSession(true);
                releaseWake();
                return;
            }
        }
        writeSession(false);
        scheduleSplit();
    }

    public synchronized void stop() {
        if (!recording) return;
        recording = false;
        h.removeCallbacks(splitRun);
        h.removeCallbacks(beatRun);
        endSegment();
        writeSession(true);
        releaseWake();
        unregisterSilenceWatch();
        log("■ 停止錄音");
        Thread t = lastRemux;
        if (t != null) { try { t.join(30000); } catch (InterruptedException ignore) {} }   // 等最後一段轉封裝完成，JS 馬上就能取到
    }

    private void writeSession(boolean ended) {
        try {
            JSONObject o = new JSONObject();
            o.put("sid", sid);
            o.put("ctx", rctx);
            o.put("startedAt", sessionStart);
            o.put("ended", ended);
            o.put("segCount", idx + 1);
            writeText(new File(dir(), sid + ".session"), o.toString());
        } catch (Exception ignore) {}
    }

    private void acquireWake() {
        try {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "nova:nativeRec");
                wl.setReferenceCounted(false);
                wl.acquire();
            }
        } catch (Exception ignore) {}
    }

    private void releaseWake() {
        try { if (wl != null && wl.isHeld()) wl.release(); } catch (Exception ignore) {}
        wl = null;
    }

    /** 已結束、可由 JS 取走的段落。依 startedAt 排序。 */
    public synchronized List<JSONObject> listFinished() {
        List<JSONObject> out = new ArrayList<>();
        File d = dir();
        File[] files = d.listFiles();
        if (files == null) return out;
        // 1) 沒有 .done 的孤兒 aac（行程被殺掉時留下的）→ 補一個 .done
        for (File f : files) {
            String n = f.getName();
            if (!n.endsWith(".aac")) continue;
            String base = n.substring(0, n.length() - 4);
            int us = base.lastIndexOf('_');
            if (us <= 0) continue;
            String fsid = base.substring(0, us);
            if (recording && fsid.equals(sid) && f.equals(curFile)) continue;   // 正在錄的那一段
            if (remuxing.contains(base)) continue;                               // 背景轉封裝中
            if (new File(d, base + ".m4a").exists()) { f.delete(); continue; }   // 轉封裝已完成但 aac 沒刪掉
            File done = new File(d, base + ".done");
            if (!done.exists()) {
                try {
                    long end = f.lastModified();
                    long dur = f.length() * 8L * 1000L / BITRATE;
                    log("⚠ 找到沒有正常結束的錄音檔 " + n + "（" + (f.length() / 1024) + "KB，最後寫入時間 " + new java.text.SimpleDateFormat("MM-dd HH:mm:ss", java.util.Locale.US).format(new java.util.Date(end)) + "）");
                    JSONObject o = new JSONObject();
                    o.put("sid", fsid);
                    o.put("index", Integer.parseInt(base.substring(us + 1)));
                    o.put("ctx", "record");
                    o.put("startedAt", end - dur);
                    o.put("endedAt", end);
                    o.put("orphan", true);
                    writeText(done, o.toString());
                } catch (Exception ignore) {}
            }
        }
        files = d.listFiles();
        if (files == null) return out;
        for (File f : files) {
            String n = f.getName();
            if (n.endsWith(".m4a.tmp")) {   // 殘留的轉封裝暫存檔
                String b = n.substring(0, n.length() - 8);
                if (!remuxing.contains(b)) f.delete();
                continue;
            }
            if (!n.endsWith(".done")) continue;
            try {
                JSONObject o = new JSONObject(readText(f));
                String base = n.substring(0, n.length() - 5);
                if (remuxing.contains(base)) continue;
                File aac = new File(d, o.optString("file", base + ".aac"));
                if (!aac.exists() || aac.length() < 2048) {   // 太短／檔案不見：直接清掉
                    aac.delete(); f.delete(); continue;
                }
                String fsid = o.optString("sid");
                JSONObject s = null;
                File sf = new File(d, fsid + ".session");
                if (sf.exists()) { try { s = new JSONObject(readText(sf)); } catch (Exception ignore) {} }
                boolean activeSession = recording && fsid.equals(sid);
                boolean ended = !activeSession;
                o.put("path", aac.getAbsolutePath());
                o.put("size", aac.length());
                o.put("durationMs", Math.max(0L, o.optLong("endedAt") - o.optLong("startedAt")));
                o.put("sessionEnded", ended);
                o.put("segCount", s != null ? s.optInt("segCount", o.optInt("index") + 1) : o.optInt("index") + 1);
                if (s != null) o.put("ctx", s.optString("ctx", o.optString("ctx", "record")));
                out.add(o);
            } catch (Exception ignore) {}
        }
        java.util.Collections.sort(out, new java.util.Comparator<JSONObject>() {
            @Override public int compare(JSONObject a, JSONObject b) {
                return Long.compare(a.optLong("startedAt"), b.optLong("startedAt"));
            }
        });
        return out;
    }

    /** 已由 JS 存進資料庫：搬到 archive/ 保留 3 天（萬一存檔內容有問題還救得回來），不直接刪除 */
    public synchronized void ack(String path) {
        try {
            File aac = new File(path);
            if (!aac.getParentFile().equals(dir())) return;   // 安全檢查：只處理自己的資料夾
            String n = aac.getName();
            String base = (n.endsWith(".aac") || n.endsWith(".m4a")) ? n.substring(0, n.length() - 4) : n;
            File arch = new File(dir(), "archive");
            if (!arch.exists()) arch.mkdirs();
            if (aac.exists() && !aac.renameTo(new File(arch, n))) aac.delete();
            new File(dir(), base + ".done").delete();
            int us = base.lastIndexOf('_');
            if (us > 0) {
                String fsid = base.substring(0, us);
                boolean any = false;
                File[] left = dir().listFiles();
                if (left != null) for (File f : left) if (f.getName().startsWith(fsid + "_")) { any = true; break; }
                if (!any && !(recording && fsid.equals(sid))) new File(dir(), fsid + ".session").delete();
            }
            // 清掉超過 3 天的封存
            File[] old = arch.listFiles();
            long cut = System.currentTimeMillis() - 3L * 24 * 3600 * 1000;
            if (old != null) for (File f : old) if (f.lastModified() < cut) f.delete();
        } catch (Exception ignore) {}
    }

    private static void writeText(File f, String s) throws Exception {
        FileOutputStream o = new FileOutputStream(f);
        try { o.write(s.getBytes("UTF-8")); } finally { o.close(); }
    }

    private static String readText(File f) throws Exception {
        FileInputStream in = new FileInputStream(f);
        try {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[4096]; int r;
            while ((r = in.read(buf)) > 0) b.write(buf, 0, r);
            return new String(b.toByteArray(), "UTF-8");
        } finally { in.close(); }
    }
}

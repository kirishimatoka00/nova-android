package com.kirishimatoka00.nova120;

import android.content.Context;
import android.media.MediaRecorder;
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

    private NativeRecorder(Context c) { ctx = c; }

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
        long end = System.currentTimeMillis();
        MediaRecorder r = rec;
        rec = null;
        if (r != null) {
            try { r.stop(); } catch (RuntimeException ignore) { /* 太短時 stop 會丟例外 */ }
            try { r.release(); } catch (Exception ignore) {}
        }
        try {
            JSONObject o = new JSONObject();
            o.put("sid", sid);
            o.put("index", idx);
            o.put("ctx", rctx);
            o.put("startedAt", segStart);
            o.put("endedAt", end);
            writeText(new File(dir(), sid + "_" + idx + ".done"), o.toString());
        } catch (Exception ignore) {}
    }

    private void scheduleSplit() {
        h.removeCallbacks(splitRun);
        if (splitMs > 0) h.postDelayed(splitRun, splitMs);
    }

    private synchronized void doSplit() {
        if (!recording) return;
        endSegment();
        idx++;
        try {
            beginSegment();
        } catch (Exception e1) {
            try { Thread.sleep(300); beginSegment(); }
            catch (Exception e2) {
                lastError = "分切後無法重新開始錄音：" + e2.getMessage();
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
        endSegment();
        writeSession(true);
        releaseWake();
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
            File done = new File(d, base + ".done");
            if (!done.exists()) {
                try {
                    long end = f.lastModified();
                    long dur = f.length() * 8L * 1000L / BITRATE;
                    JSONObject o = new JSONObject();
                    o.put("sid", fsid);
                    o.put("index", Integer.parseInt(base.substring(us + 1)));
                    o.put("ctx", "record");
                    o.put("startedAt", end - dur);
                    o.put("endedAt", end);
                    writeText(done, o.toString());
                } catch (Exception ignore) {}
            }
        }
        files = d.listFiles();
        if (files == null) return out;
        for (File f : files) {
            String n = f.getName();
            if (!n.endsWith(".done")) continue;
            try {
                JSONObject o = new JSONObject(readText(f));
                String base = n.substring(0, n.length() - 5);
                File aac = new File(d, base + ".aac");
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

    public synchronized void ack(String path) {
        try {
            File aac = new File(path);
            if (!aac.getParentFile().equals(dir())) return;   // 安全檢查：只處理自己的資料夾
            String n = aac.getName();
            String base = n.endsWith(".aac") ? n.substring(0, n.length() - 4) : n;
            aac.delete();
            new File(dir(), base + ".done").delete();
            int us = base.lastIndexOf('_');
            if (us > 0) {
                String fsid = base.substring(0, us);
                boolean any = false;
                File[] left = dir().listFiles();
                if (left != null) for (File f : left) if (f.getName().startsWith(fsid + "_")) { any = true; break; }
                if (!any && !(recording && fsid.equals(sid))) new File(dir(), fsid + ".session").delete();
            }
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

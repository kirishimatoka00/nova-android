package com.kirishimatoka00.nova120;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.core.app.NotificationCompat;

public class RecordingForegroundService extends Service {

    private static final String CHANNEL_ID   = "nova_recording_channel";
    private static final String CHANNEL_NAME = "NOVA 錄音服務";
    private static final int    NOTIF_ID     = 2001;
    public  static final String ACTION_STOP  = "ACTION_STOP_RECORDING";
    public  static final String ACTION_START_REC = "ACTION_START_NATIVE_REC";   // v2.6.49：原生錄音
    public  static final String ACTION_STOP_REC  = "ACTION_STOP_NATIVE_REC";

    // v2.6.85：沒有在錄音卻一直顯示「錄音中」的防呆——錄音停止後 12 分鐘內若沒人收服務，就自己收掉
    private final Handler idleH = new Handler(Looper.getMainLooper());
    private final Runnable idleStop = new Runnable() {
        @Override public void run() {
            if (NativeRecorder.get(RecordingForegroundService.this).isRecording()) { idleH.postDelayed(this, 60 * 1000L); return; }
            stopForeground(true);
            stopSelf();
        }
    };

    @Override
    public void onTaskRemoved(Intent rootIntent) {   // 使用者把 App 從最近工作清掉：沒在錄音就不要留通知
        if (!NativeRecorder.get(this).isRecording()) { stopForeground(true); stopSelf(); }
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        idleH.removeCallbacks(idleStop);
        super.onDestroy();
    }

    // ── 建立服務時先建立 Notification Channel（Android 8+ 必要）
    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {

        // v2.6.49：停止原生錄音（服務保持前景，讓 App 之後還能在背景完成處理與上傳；之後由 ACTION_STOP 收掉）
        if (intent != null && ACTION_STOP_REC.equals(intent.getAction())) {
            NativeRecorder.get(this).stop();
            idleH.removeCallbacks(idleStop); idleH.postDelayed(idleStop, 12 * 60 * 1000L);
            return START_NOT_STICKY;
        }

        // 收到 STOP 指令時關閉服務（原生錄音進行中時一律忽略，避免其他功能呼叫 releaseMicrophone 把錄音砍掉）
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            if (NativeRecorder.get(this).isRecording()) return START_NOT_STICKY;
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }

        idleH.removeCallbacks(idleStop);
        // 點擊通知返回 App
        Intent openApp = new Intent(this, MainActivity.class);
        openApp.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT |
                (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                        ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent pendingIntent = PendingIntent.getActivity(
                this, 0, openApp, pendingFlags);

        // 建立持續顯示的通知（這是 Foreground Service 的核心）
        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("NOVA 120 SSP — 錄音中")
                .setContentText("點此返回 App，關閉螢幕不會中斷錄音")
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentIntent(pendingIntent)
                .setOngoing(true)          // 使用者無法手動滑掉
                .setSilent(true)           // 不發出提示音
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();

        startForeground(NOTIF_ID, notification);
        if (!(intent != null && ACTION_START_REC.equals(intent.getAction())) && !NativeRecorder.get(this).isRecording()) {
            // 一般保活（WebView 錄音／翻譯／持續聆聽）：萬一 JS 忘了收，6 小時後自動收掉
            idleH.postDelayed(idleStop, 6 * 60 * 60 * 1000L);
        }

        // v2.6.49：要求開始原生錄音（先 startForeground 再開麥克風，Android 12+ 才允許在背景持續使用麥克風）
        if (intent != null && ACTION_START_REC.equals(intent.getAction())) {
            try {
                NativeRecorder.get(this).start(intent.getStringExtra("ctx"), intent.getIntExtra("splitMins", 0));
            } catch (Exception e) {
                NativeRecorder.get(this).lastError = "原生錄音啟動失敗：" + e.getMessage();
            }
        }
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null; // 不需要綁定模式
    }

    // ── 建立 Notification Channel（Android 8.0 Oreo 以上必要）
    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    CHANNEL_NAME,
                    NotificationManager.IMPORTANCE_LOW  // LOW = 不震動、不發聲
            );
            channel.setDescription("錄音進行中的背景保活通知");
            channel.setSound(null, null);               // 靜音
            channel.enableVibration(false);

            NotificationManager manager =
                    (NotificationManager) getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }
}

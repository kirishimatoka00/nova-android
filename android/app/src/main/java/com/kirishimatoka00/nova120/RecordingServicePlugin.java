package com.kirishimatoka00.nova120;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "RecordingService")
public class RecordingServicePlugin extends Plugin {

    // JS 呼叫：Capacitor.Plugins.RecordingService.startService()
    @PluginMethod
    public void startService(PluginCall call) {
        try {
            Intent intent = new Intent(getContext(), RecordingForegroundService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getContext().startForegroundService(intent);
            } else {
                getContext().startService(intent);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("啟動錄音服務失敗: " + e.getMessage());
        }
    }

    // JS 呼叫：Capacitor.Plugins.RecordingService.stopService()
    @PluginMethod
    public void stopService(PluginCall call) {
        try {
            Intent intent = new Intent(getContext(), RecordingForegroundService.class);
            intent.setAction(RecordingForegroundService.ACTION_STOP);
            getContext().startService(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("停止錄音服務失敗: " + e.getMessage());
        }
    }

    // ───────── v2.6.49：原生錄音 API ─────────
    // startRecording({ctx:'record'|'note', splitMins:15}) → {sid}
    @PluginMethod
    public void startRecording(final PluginCall call) {
        try {
            if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                call.reject("沒有麥克風權限");
                return;
            }
            final NativeRecorder nr = NativeRecorder.get(getContext());
            if (nr.isRecording()) {
                JSObject r = new JSObject();
                r.put("sid", nr.getSid());
                r.put("already", true);
                call.resolve(r);
                return;
            }
            Intent intent = new Intent(getContext(), RecordingForegroundService.class);
            intent.setAction(RecordingForegroundService.ACTION_START_REC);
            intent.putExtra("ctx", call.getString("ctx", "record"));
            Integer sm = call.getInt("splitMins", 0);
            intent.putExtra("splitMins", sm == null ? 0 : sm.intValue());
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getContext().startForegroundService(intent);
            } else {
                getContext().startService(intent);
            }
            // 服務在另一個執行緒啟動錄音，這裡最多等 4 秒看結果
            new Thread(new Runnable() {
                @Override public void run() {
                    try {
                        for (int i = 0; i < 80; i++) {
                            if (nr.isRecording()) {
                                JSObject r = new JSObject();
                                r.put("sid", nr.getSid());
                                call.resolve(r);
                                return;
                            }
                            String err = nr.lastError;
                            if (err != null && !err.isEmpty()) { call.reject(err); return; }
                            Thread.sleep(50);
                        }
                        call.reject("原生錄音啟動逾時");
                    } catch (Exception e) {
                        call.reject("原生錄音啟動失敗: " + e.getMessage());
                    }
                }
            }).start();
        } catch (Exception e) {
            call.reject("原生錄音啟動失敗: " + e.getMessage());
        }
    }

    // stopRecording() → {}   （服務維持前景，之後 JS 呼叫 stopService() 才收掉）
    @PluginMethod
    public void stopRecording(PluginCall call) {
        try {
            NativeRecorder.get(getContext()).stop();   // 直接同步停止，確保馬上能取到最後一段
            call.resolve();
        } catch (Exception e) {
            call.reject("停止原生錄音失敗: " + e.getMessage());
        }
    }

    // getRecStatus() → {recording, sid, ctx, index, segStart, sessionStart, error}
    @PluginMethod
    public void getRecStatus(PluginCall call) {
        NativeRecorder nr = NativeRecorder.get(getContext());
        JSObject r = new JSObject();
        r.put("recording", nr.isRecording());
        r.put("sid", nr.getSid());
        r.put("ctx", nr.getCtx());
        r.put("index", nr.getIndex());
        r.put("segStart", nr.getSegStart());
        r.put("sessionStart", nr.getSessionStart());
        r.put("error", nr.lastError);
        call.resolve(r);
    }

    // listFinished() → {segments:[{path,size,sid,index,ctx,startedAt,endedAt,durationMs,sessionEnded,segCount}]}
    @PluginMethod
    public void listFinished(PluginCall call) {
        try {
            JSArray arr = new JSArray();
            for (org.json.JSONObject o : NativeRecorder.get(getContext()).listFinished()) arr.put(o);
            JSObject r = new JSObject();
            r.put("segments", arr);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("讀取錄音段落失敗: " + e.getMessage());
        }
    }

    // ackSegment({path}) → JS 已把這段存進資料庫，刪除原生端檔案
    @PluginMethod
    public void ackSegment(PluginCall call) {
        String p = call.getString("path");
        if (p != null) NativeRecorder.get(getContext()).ack(p);
        call.resolve();
    }
}

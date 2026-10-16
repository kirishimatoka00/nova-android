package com.kirishimatoka00.nova120;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Comparator;

/**
 * v2.6.61：手機檔案瀏覽（工作資料夾用）。
 * 需要「所有檔案存取」(MANAGE_EXTERNAL_STORAGE)：使用者在系統設定頁開啟後，可讀寫共用儲存空間（/storage/emulated/0）任意資料夾。
 * 路徑一律是絕對路徑；JS 端負責把相對路徑接在 root() 後面。
 */
@CapacitorPlugin(name = "NovaFiles")
public class NovaFilesPlugin extends Plugin {

    private boolean granted() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            return Environment.isExternalStorageManager();
        }
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
                && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
    }

    @PluginMethod
    public void hasAccess(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", granted());
        r.put("root", Environment.getExternalStorageDirectory().getAbsolutePath());
        r.put("sdk", Build.VERSION.SDK_INT);
        call.resolve(r);
    }

    @PluginMethod
    public void requestAccess(PluginCall call) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                try {
                    Intent i = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + getContext().getPackageName()));
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(i);
                } catch (Exception e) {
                    Intent i2 = new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION);
                    i2.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(i2);
                }
            } else if (getActivity() != null) {
                getActivity().requestPermissions(new String[]{Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE}, 7311);
            }
            call.resolve();
        } catch (Throwable e) {
            call.reject("無法開啟授權頁: " + e.getMessage());
        }
    }

    @PluginMethod
    public void list(PluginCall call) {
        try {
            File d = new File(call.getString("path", ""));
            if (!d.exists() || !d.isDirectory()) { call.reject("資料夾不存在: " + d.getPath()); return; }
            File[] fs = d.listFiles();
            if (fs == null) { call.reject("無法讀取這個資料夾（沒有權限或系統保護）"); return; }
            Arrays.sort(fs, new Comparator<File>() {
                @Override public int compare(File a, File b) {
                    if (a.isDirectory() != b.isDirectory()) return a.isDirectory() ? -1 : 1;
                    return a.getName().compareToIgnoreCase(b.getName());
                }
            });
            JSArray arr = new JSArray();
            for (File f : fs) {
                JSObject o = new JSObject();
                o.put("name", f.getName());
                o.put("isDir", f.isDirectory());
                o.put("size", f.isDirectory() ? 0 : f.length());
                o.put("mtime", f.lastModified());
                arr.put(o);
            }
            JSObject r = new JSObject();
            r.put("files", arr);
            call.resolve(r);
        } catch (Throwable e) {
            call.reject("列出失敗: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stat(PluginCall call) {
        try {
            File f = new File(call.getString("path", ""));
            JSObject r = new JSObject();
            r.put("exists", f.exists());
            r.put("isDir", f.isDirectory());
            r.put("size", f.exists() && f.isFile() ? f.length() : 0);
            call.resolve(r);
        } catch (Throwable e) {
            call.reject("stat 失敗: " + e.getMessage());
        }
    }

    // readText({path, max}) → {text, total}  整檔以 UTF-8 讀入，最多 max 位元組
    @PluginMethod
    public void readText(PluginCall call) {
        RandomAccessFile raf = null;
        try {
            File f = new File(call.getString("path", ""));
            if (!f.isFile()) { call.reject("不是檔案: " + f.getPath()); return; }
            int max = Math.max(1, Math.min(call.getData().optInt("max", 400000), 4 * 1024 * 1024));
            raf = new RandomAccessFile(f, "r");
            long size = raf.length();
            int n = (int) Math.min((long) max, size);
            byte[] buf = new byte[n];
            raf.readFully(buf);
            JSObject r = new JSObject();
            r.put("text", new String(buf, StandardCharsets.UTF_8));
            r.put("total", size);
            call.resolve(r);
        } catch (Throwable e) {
            call.reject("讀取失敗: " + e.getMessage());
        } finally {
            try { if (raf != null) raf.close(); } catch (Exception ignore) {}
        }
    }

    // writeText({path, text}) 覆寫（會建立缺少的上層資料夾）
    @PluginMethod
    public void writeText(PluginCall call) {
        FileOutputStream os = null;
        try {
            File f = new File(call.getString("path", ""));
            File p = f.getParentFile();
            if (p != null && !p.exists() && !p.mkdirs()) { call.reject("無法建立資料夾: " + p.getPath()); return; }
            os = new FileOutputStream(f, false);
            os.write(call.getString("text", "").getBytes(StandardCharsets.UTF_8));
            os.flush();
            call.resolve();
        } catch (Throwable e) {
            call.reject("寫入失敗: " + e.getMessage());
        } finally {
            try { if (os != null) os.close(); } catch (Exception ignore) {}
        }
    }

    @PluginMethod
    public void mkdir(PluginCall call) {
        try {
            File d = new File(call.getString("path", ""));
            if (d.exists() || d.mkdirs()) call.resolve(); else call.reject("無法建立資料夾");
        } catch (Throwable e) {
            call.reject("建立失敗: " + e.getMessage());
        }
    }

    // readChunk({path, offset, length}) → {data(base64), read, size}
    @PluginMethod
    public void readChunk(PluginCall call) {
        RandomAccessFile raf = null;
        try {
            File f = new File(call.getString("path", ""));
            if (!f.isFile()) { call.reject("不是檔案"); return; }
            long offset = call.getData().optLong("offset", 0L);   // 不用 getLong：遇到 Integer 會回傳預設值
            int want = Math.max(1, Math.min(call.getData().optInt("length", 786432), 1048576));
            raf = new RandomAccessFile(f, "r");
            long size = raf.length();
            int n = (int) Math.max(0L, Math.min((long) want, size - offset));
            byte[] buf = new byte[n];
            if (n > 0) { raf.seek(offset); raf.readFully(buf); }
            JSObject r = new JSObject();
            r.put("data", android.util.Base64.encodeToString(buf, android.util.Base64.NO_WRAP));
            r.put("read", n);
            r.put("size", size);
            call.resolve(r);
        } catch (Throwable e) {
            call.reject("讀取失敗: " + e.getMessage());
        } finally {
            try { if (raf != null) raf.close(); } catch (Exception ignore) {}
        }
    }

    // writeChunk({path, data(base64), append}) 分段寫入（append=false 先清空）
    @PluginMethod
    public void writeChunk(PluginCall call) {
        FileOutputStream os = null;
        try {
            File f = new File(call.getString("path", ""));
            File p = f.getParentFile();
            if (p != null && !p.exists() && !p.mkdirs()) { call.reject("無法建立資料夾: " + p.getPath()); return; }
            boolean append = call.getData().optBoolean("append", false);
            byte[] bytes = android.util.Base64.decode(call.getString("data", ""), android.util.Base64.DEFAULT);
            os = new FileOutputStream(f, append);
            os.write(bytes);
            os.flush();
            call.resolve();
        } catch (Throwable e) {
            call.reject("寫入失敗: " + e.getMessage());
        } finally {
            try { if (os != null) os.close(); } catch (Exception ignore) {}
        }
    }
}

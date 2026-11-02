/* ════════════════════════════════════════════════════════════
   nova-recrestore.js — 錄音紀錄「重裝後仍可播放」（跟 index.html 放同一個資料夾 www/）
   版本：v1.0.0
   版本紀錄：
   v1.0.0 - App v2.6.119。
            a. 還原：錄音紀錄（與語音筆記）的清單來自備份／Drive 同步，但音檔本體只存在 App 的 IndexedDB，重裝後會消失。
               現在遇到「有紀錄、沒音檔」時，卡片會出現「☁️ 取回音檔」按鈕：先試手機 Documents/NOVA_Recordings 裡的同名檔（30MB 以內），
               再從紀錄的 driveUrl 解出 Drive 檔案 ID，用 Google 授權下載，寫回 IndexedDB（audioBlobs），之後就能直接播放。
            b. 補備份：開機後與回到前景時，把「本機有音檔、卻還沒有 driveUrl」的舊錄音丟進既有的待上傳清單（nova-gdrive.js 的 novaAutoUpload），
               每次最多 5 筆，傳到雲端硬碟「NOVA 錄音」資料夾，之後才有東西可還原。關閉：localStorage nova_rec_backfill = '0'。
   對外：window.novaRecPlaceholder(id)、window.novaRecRestore(id, btn)、window.novaRecBackfill()、window.NovaRecRestore
   依賴：index.html 的 appState／loadAudioBlob／saveAudioBlob／renderAudioRecords／renderNotes／showToast；nova-google.js 的 NovaGoogle；nova-gdrive.js 的 novaAutoUpload／NovaGDrive.canUpload
   誠實聲明：只在沙盒用模擬環境驗證流程；Drive 下載與 Documents 讀檔未在真機驗證。
   ════════════════════════════════════════════════════════════ */
(function () {
    'use strict';
    if (window.NovaRecRestore) return;
    var W = window;
    function toast(m, t) { try { if (typeof W.showToast === 'function') W.showToast(m, t || 3500); } catch (e) { /* ignore */ } }
    function findRec(id) {
        var A = W.appState || {};
        return (A.audioRecords || []).find(function (x) { return String(x.id) === String(id); }) || (A.notes || []).find(function (x) { return String(x.id) === String(id); }) || null;
    }
    function driveId(rec) {
        var u = String(rec && rec.driveUrl || ''), m = /\/d\/([A-Za-z0-9_-]{15,})/.exec(u) || /[?&]id=([A-Za-z0-9_-]{15,})/.exec(u);
        return m ? m[1] : '';
    }
    function gConn() { return !!(W.NovaGoogle && W.NovaGoogle._connected && W.NovaGoogle._connected()); }
    function b64ToBlob(b64, mime) {
        var bin = atob(b64), n = bin.length, out = new Uint8Array(n);
        for (var i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
        return new Blob([out], { type: mime || 'audio/webm' });
    }
    async function fromLocalDir(rec) {
        var FS = W.Capacitor && W.Capacitor.Plugins && W.Capacitor.Plugins.Filesystem; if (!FS || !rec.filename) return null;
        var path = 'NOVA_Recordings/' + rec.filename;
        try {
            var st = await FS.stat({ path: path, directory: 'DOCUMENTS' });
            if (!st || !st.size || st.size > 30 * 1048576) return null;
            var r = await FS.readFile({ path: path, directory: 'DOCUMENTS' });
            if (!r || !r.data) return null;
            var b = typeof r.data === 'string' ? b64ToBlob(r.data, rec.mimeType) : r.data;
            return b && b.size ? b : null;
        } catch (e) { return null; }
    }
    async function fromDrive(rec) {
        var id = driveId(rec); if (!id) throw new Error('這筆紀錄沒有可用的雲端連結');
        if (!gConn()) throw new Error('請先在「Google 整合」連接 Google 並授權雲端硬碟');
        var r = await W.NovaGoogle._raw('https://www.googleapis.com/drive/v3/files/' + id + '?alt=media');
        if (r.status === 404) throw new Error('雲端找不到這個檔案（可能已被刪除或移到垃圾桶）');
        if (!r.ok) throw new Error('Drive 下載失敗 HTTP ' + r.status);
        var b = await r.blob(); if (!b || !b.size) throw new Error('下載到的檔案是空的');
        return rec.mimeType && b.type !== rec.mimeType ? new Blob([b], { type: rec.mimeType }) : b;
    }
    var busy = {};
    async function restore(id) {
        id = String(id); if (busy[id]) return busy[id];
        busy[id] = (async function () {
            try {
                var rec = findRec(id); if (!rec) throw new Error('找不到這筆紀錄');
                if (await W.loadAudioBlob(id)) return true;
                var b = await fromLocalDir(rec), src = '手機資料夾';
                if (!b) { b = await fromDrive(rec); src = 'Google Drive'; }
                await W.saveAudioBlob(id, b);
                try { W.revokeAudioBlobUrl(id); } catch (e) { /* ignore */ }
                toast('✅ 已從' + src + '取回音檔');
                return true;
            } finally { delete busy[id]; }
        })();
        return busy[id];
    }
    W.novaRecRestore = async function (id, btn) {
        if (btn) { btn.disabled = true; btn.textContent = '取回中…'; }
        try { await restore(id); try { W.renderAudioRecords(); } catch (e) { /* ignore */ } try { W.renderNotes(); } catch (e) { /* ignore */ } }
        catch (e) { toast('❌ 取回失敗：' + (e && e.message || e), 6000); if (btn) { btn.disabled = false; btn.textContent = '☁️ 取回音檔'; } }
    };
    W.novaRecPlaceholder = function (id) {
        var rec = findRec(id), ok = !!driveId(rec) || !!(rec && rec.filename);
        if (!ok) return '<p class="text-xs text-slate-500 italic py-1 px-1"><i class="ph-bold ph-cloud-slash mr-1"></i>這台裝置沒有音檔，也沒有雲端備份連結；請下載後匯入</p>';
        return '<div class="flex items-center gap-2 py-1 px-1"><span class="text-xs text-slate-500 italic"><i class="ph-bold ph-cloud-slash mr-1"></i>這台裝置沒有音檔</span>' +
            '<button type="button" onclick="novaRecRestore(\'' + String(id).replace(/[^\w-]/g, '') + '\',this)" class="text-xs px-2 py-1 rounded-lg bg-indigo-600 text-white font-bold">☁️ 取回音檔</button></div>';
    };
    // 補備份：本機有音檔、卻沒有 driveUrl 的舊錄音 → 丟進既有的待上傳清單
    var bfBusy = false;
    W.novaRecBackfill = async function () {
        if (bfBusy) return 0;
        try { if (localStorage.getItem('nova_rec_backfill') === '0') return 0; } catch (e) { /* ignore */ }
        if (W._nativeRecActive || !W.NovaGDrive || !W.NovaGDrive.canUpload || !W.NovaGDrive.canUpload() || typeof W.novaAutoUpload !== 'function') return 0;
        try { if (navigator.connection && navigator.connection.saveData) return 0; } catch (e) { /* ignore */ }
        bfBusy = true; var n = 0;
        try {
            var A = W.appState || {}, jobs = [];
            (A.audioRecords || []).forEach(function (r) { if (r && !r.driveUrl) jobs.push(['audioRecords', r]); });
            (A.notes || []).forEach(function (r) { if (r && r.type === 'audio' && !r.driveUrl) jobs.push(['notes', r]); });
            for (var i = 0; i < jobs.length && n < 5; i++) {
                var r = jobs[i][1]; if (!(await W.loadAudioBlob(r.id))) continue;
                W.novaAutoUpload(jobs[i][0], String(r.id)); n++;
            }
        } catch (e) { /* ignore */ } finally { bfBusy = false; }
        return n;
    };
    setTimeout(function () { W.novaRecBackfill(); }, 25000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) setTimeout(function () { W.novaRecBackfill(); }, 6000); });
    W.NovaRecRestore = { version: '1.0.0', restore: restore, driveId: driveId };
})();

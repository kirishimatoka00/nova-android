/* ═════════════════════════════════════════════════════════════════
   nova-imgsync.js — NOVA Android 聊天圖片「雲端備份／重裝後還原」（跟 index.html 放同一個資料夾 www/）
   版本：v1.0.0
   版本紀錄：
   v1.0.0 - App v2.6.97。圖片不進備份檔，改用兩條路讓重新安裝後對話裡的圖片能再顯示：
            ① Google Drive：把聊天圖片上傳到雲端硬碟「NOVA 圖片」資料夾，訊息只多記一個 __driveId（備份檔只多一小段文字）；
               重裝並還原備份後，圖片在對話中被讀到時若本機讀不到（舊安裝留下的檔案屬於舊 App，讀不到），自動從 Drive 下載回來；
               也可在設定頁按「從 Drive 還原全部圖片」一次補齊。新圖片可自動上傳（設定頁開關，預設開，需 Google 授權含 Drive）。
            ② 檔案匯出／匯入：匯入圖片改成會比對檔名並更新訊息的圖片路徑——舊安裝留下的同名檔寫不進去時，自動改存新檔名並改訊息路徑
               （原本只補檔、舊檔擋住就失敗）；可一次選很多檔。匯出沿用「分享」，另新增「匯出到 Documents/NOVA_圖片匯出」資料夾（之後可在檔案管理員複製走，重裝後用「匯入圖片檔案」選取）。
   依賴：index.html 的 NovaImageStore／appState／saveToDB／showToast、nova-gdrive.js（NovaGDrive.uploadBlob／canUpload）、nova-google.js（NovaGoogle._raw）
   ═════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';
    if (window.NovaImgSync) return;
    var W = window, D = document, FOLDER = 'NOVA 圖片', EXPORT_DIR = 'NOVA_圖片匯出', K_AUTO = 'nova_imgsync_auto';
    function lsGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
    function toast(m, t) { try { if (typeof W.showToast === 'function') W.showToast(m, t || 3500); } catch (e) { /* ignore */ } }
    function FS() { return W.Capacitor && W.Capacitor.Plugins && W.Capacitor.Plugins.Filesystem; }
    function store() { return W.NovaImageStore; }
    function canDrive() { return !!(W.NovaGDrive && W.NovaGDrive.canUpload && W.NovaGDrive.canUpload()); }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function baseName(ref) { return String(ref || '').split('/').pop(); }
    function blobToB64(blob) { return new Promise(function (res, rej) { var fr = new FileReader(); fr.onloadend = function () { res(String(fr.result).split(',')[1] || ''); }; fr.onerror = rej; fr.readAsDataURL(blob); }); }

    // 走訪所有訊息裡的聊天圖片（有 __fileRef 的）
    function eachImage(cb) {
        var arr = (W.appState && W.appState.messages) || [];
        for (var i = 0; i < arr.length; i++) {
            var m = arr[i], fa = Array.isArray(m.files) ? m.files : (m.file ? [m.file] : []);
            for (var j = 0; j < fa.length; j++) { var f = fa[j]; if (f && f.category === 'image' && f.__fileRef) cb(m, f); }
        }
    }
    function saveMsg(m) { try { if (typeof W.saveToDB === 'function') W.saveToDB('messages', m); } catch (e) { /* ignore */ } }

    /* 圖片能不能真的載入（舊安裝留下的檔案 getUri 會成功，但實際讀不到） */
    function probe(src) {
        return new Promise(function (res) {
            var im = new Image(), done = false, t = setTimeout(function () { if (!done) { done = true; res(false); } }, 8000);
            im.onload = function () { if (!done) { done = true; clearTimeout(t); res(true); } };
            im.onerror = function () { if (!done) { done = true; clearTimeout(t); res(false); } };
            im.src = src;
        });
    }
    // 寫入本機（原路徑寫不進去就改新檔名）；回傳實際使用的路徑，失敗回 null
    async function writeLocal(ref, b64) {
        var fs = FS(); if (!fs) return null;
        try { await fs.writeFile({ path: ref, data: b64, directory: 'DOCUMENTS', recursive: true }); return ref; }
        catch (e1) {
            var alt = (store() && store().IMG_DIR || 'NOVA_Images') + '/r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5) + '_' + baseName(ref);
            try { await fs.writeFile({ path: alt, data: b64, directory: 'DOCUMENTS', recursive: true }); return alt; } catch (e2) { return null; }
        }
    }
    function remapRef(oldRef, newRef) {
        if (!newRef || newRef === oldRef) return;
        eachImage(function (m, f) { if (f.__fileRef === oldRef) { f.__fileRef = newRef; saveMsg(m); } });
        resolved.delete(oldRef);
    }

    /* ───────── ① Drive 上傳 ───────── */
    var uploading = false;
    async function uploadAll(opts) {
        opts = opts || {};
        if (!canDrive()) { if (!opts.silent) toast('需要先在「Google 整合」連接 Google 並授權雲端硬碟'); return { ok: 0, fail: 0, skipped: 0 }; }
        if (uploading) return { ok: 0, fail: 0, skipped: 0, busy: true };
        uploading = true;
        var todo = [], seen = {};
        eachImage(function (m, f) { if (!f.__driveId) { (seen[f.__fileRef] = seen[f.__fileRef] || []).push({ m: m, f: f }); } });
        Object.keys(seen).forEach(function (k) { todo.push(k); });
        var ok = 0, fail = 0, miss = 0, limit = opts.limit || 400;
        try {
            for (var i = 0; i < todo.length && i < limit; i++) {
                var ref = todo[i], group = seen[ref], f0 = group[0].f;
                // 同一張圖片已在別則訊息上傳過
                var known = null; eachImage(function (m, f) { if (!known && f.__fileRef === ref && f.__driveId) known = f.__driveId; });
                try {
                    if (!known) {
                        var du = await store().readAsDataUri(ref, f0.mimeType);
                        if (!du) { miss++; continue; }
                        var blob = await (await fetch(du)).blob();
                        var up = await W.NovaGDrive.uploadBlob(blob, baseName(ref), f0.mimeType || blob.type || 'image/png', { folder: FOLDER });
                        known = up.id;
                    }
                    group.forEach(function (g) { g.f.__driveId = known; saveMsg(g.m); });
                    ok++;
                } catch (e) { fail++; if (fail === 1) console.warn('[NovaImgSync] 上傳失敗：', e && e.message || e); if (fail >= 5 && ok === 0) break; }
                if (!opts.silent && (i % 3 === 2)) toast('☁️ 上傳圖片 ' + (i + 1) + '/' + todo.length + '…', 2500);
            }
        } finally { uploading = false; }
        if (!opts.silent) toast((fail ? '⚠️ ' : '✅ ') + '圖片上傳完成：' + ok + ' 張' + (fail ? '，失敗 ' + fail : '') + (miss ? '，' + miss + ' 張本機找不到檔案' : '') + (todo.length > limit ? '（還有 ' + (todo.length - limit) + ' 張，再按一次）' : ''), 7000);
        refreshStat();
        return { ok: ok, fail: fail, skipped: miss };
    }

    /* ───────── ① Drive 還原（單張／全部） ───────── */
    var resolved = new Map();      // 舊 ref → 可用的 src（本次執行期間）
    async function downloadTo(ref, driveId) {
        var r = await W.NovaGoogle._raw('https://www.googleapis.com/drive/v3/files/' + driveId + '?alt=media');
        if (!r.ok) throw new Error('Drive 下載失敗 HTTP ' + r.status);
        var b64 = await blobToB64(await r.blob());
        var used = await writeLocal(ref, b64);
        if (!used) throw new Error('寫入本機失敗');
        if (store() && store()._clearCache) store()._clearCache(ref);
        return used;
    }
    function driveIdFor(ref) { var id = null; eachImage(function (m, f) { if (!id && f.__fileRef === ref && f.__driveId) id = f.__driveId; }); return id; }
    async function restoreOne(ref) {
        var id = driveIdFor(ref); if (!id || !W.NovaGoogle || !W.NovaGoogle._connected()) return null;
        var used = await downloadTo(ref, id);
        remapRef(ref, used);
        var src = await origResolve(used);
        return src;
    }
    var origResolve = null, pending = {};
    function wrapResolve() {
        var s = store(); if (!s || s._imgsyncWrapped) return !!(s && s._imgsyncWrapped);
        origResolve = s.resolveSrc;
        s.resolveSrc = async function (ref) {
            if (resolved.has(ref)) return resolved.get(ref);
            var src = await origResolve(ref);
            var id = driveIdFor(ref);
            if (!id) return src;                                  // 沒有雲端備份：行為不變
            if (src && await probe(src)) return src;              // 本機圖片正常
            if (!W.NovaGoogle || !W.NovaGoogle._connected()) return src;
            if (!pending[ref]) pending[ref] = restoreOne(ref).catch(function (e) { console.warn('[NovaImgSync] 還原失敗：', e && e.message || e); return null; }).then(function (r) { delete pending[ref]; return r; });
            var got = await pending[ref];
            if (got) { resolved.set(ref, got); return got; }
            return src;
        };
        s._imgsyncWrapped = true;
        return true;
    }
    async function restoreAll() {
        if (!W.NovaGoogle || !W.NovaGoogle._connected()) { toast('需要先在「Google 整合」連接 Google（與備份時同一個帳號）'); return; }
        var refs = [], seen = {};
        eachImage(function (m, f) { if (f.__driveId && !seen[f.__fileRef]) { seen[f.__fileRef] = 1; refs.push(f.__fileRef); } });
        if (!refs.length) { toast('目前的對話裡沒有「已上傳到 Drive」的圖片（需先還原含 __driveId 的備份）'); return; }
        var ok = 0, fail = 0, had = 0;
        for (var i = 0; i < refs.length; i++) {
            try {
                var src = await origResolve(refs[i]);
                if (src && await probe(src)) { had++; continue; }
                var used = await downloadTo(refs[i], driveIdFor(refs[i])); remapRef(refs[i], used); ok++;
            } catch (e) { fail++; }
            if (i % 3 === 2) toast('☁️ 還原圖片 ' + (i + 1) + '/' + refs.length + '…', 2500);
        }
        toast((fail ? '⚠️ ' : '✅ ') + '還原完成：下載 ' + ok + ' 張，本機本來就有 ' + had + ' 張' + (fail ? '，失敗 ' + fail : ''), 8000);
        document.querySelectorAll('.nova-fileref-wrap[data-resolved]').forEach(function (el) { delete el.dataset.resolved; });
        try { if (typeof W.renderMessages === 'function') W.renderMessages(); } catch (e) { /* ignore */ }
        refreshStat();
    }

    /* ───────── ② 檔案匯入／匯出 ───────── */
    async function importFiles(fileList) {
        var fs = FS(); if (!fs) return 0;
        var files = Array.from(fileList || []), want = {}, n = 0, remapped = 0;
        eachImage(function (m, f) { want[baseName(f.__fileRef)] = f.__fileRef; });
        for (var i = 0; i < files.length; i++) {
            var file = files[i];
            try {
                var ref = want[file.name] || ((store() && store().IMG_DIR || 'NOVA_Images') + '/' + file.name);
                var b64 = await blobToB64(file);
                var used = await writeLocal(ref, b64);
                if (!used) continue;
                if (used !== ref) { remapRef(ref, used); remapped++; }
                resolved.delete(ref); if (store() && store()._clearCache) store()._clearCache(ref);
                n++;
            } catch (e) { console.warn('[NovaImgSync] 匯入失敗', file.name, e && e.message || e); }
            if (i % 5 === 4) await sleep(5);
        }
        W._novaLastImportRemapped = remapped;
        return n;
    }
    async function exportToFolder() {
        var fs = FS(); if (!fs) { toast('這個功能只能在手機 App 內使用'); return; }
        var refs = [], seen = {}; eachImage(function (m, f) { if (!seen[f.__fileRef]) { seen[f.__fileRef] = 1; refs.push(f); } });
        if (!refs.length) { toast('目前沒有可匯出的圖片'); return; }
        var ok = 0, miss = 0;
        for (var i = 0; i < refs.length; i++) {
            try {
                var du = await store().readAsDataUri(refs[i].__fileRef, refs[i].mimeType);
                if (!du) { miss++; continue; }
                await fs.writeFile({ path: EXPORT_DIR + '/' + baseName(refs[i].__fileRef), data: du.split(',')[1], directory: 'DOCUMENTS', recursive: true }); ok++;
            } catch (e) { miss++; }
            if (i % 5 === 4) { toast('📦 匯出 ' + (i + 1) + '/' + refs.length + '…', 2000); await sleep(5); }
        }
        toast('✅ 已匯出 ' + ok + ' 張到「文件／' + EXPORT_DIR + '」' + (miss ? '（' + miss + ' 張讀不到）' : '') + '。重裝前請用檔案管理員把這個資料夾複製到別處，重裝後用「匯入圖片檔案」選取。', 12000);
    }

    /* ───────── 設定頁 ───────── */
    function counts() {
        var total = {}, up = {};
        eachImage(function (m, f) { total[f.__fileRef] = 1; if (f.__driveId) up[f.__fileRef] = 1; });
        return { total: Object.keys(total).length, up: Object.keys(up).length };
    }
    function refreshStat() {
        var el = D.getElementById('nis-stat'); if (!el) return;
        var c = counts();
        el.textContent = '對話圖片 ' + c.total + ' 張，已上傳 Drive ' + c.up + ' 張' + (canDrive() ? '' : '（尚未連接 Google 或沒有 Drive 授權）');
    }
    function injectUi() {
        if (D.getElementById('nova-imgsync-box')) return true;
        var input = D.getElementById('nova-images-import-input'); if (!input || !input.parentNode) return false;
        var box = D.createElement('div'); box.id = 'nova-imgsync-box'; box.style.cssText = 'margin-top:10px;padding:8px;border:1px solid rgba(148,163,184,.25);border-radius:8px;';
        box.innerHTML = '<div style="font-size:11px;font-weight:700;color:#c4b5fd;">重新安裝後保留對話圖片（圖片不會進備份檔）</div>' +
            '<div style="font-size:10px;color:#94a3b8;margin:4px 0;">方法一：上傳到 Google Drive（「' + FOLDER + '」資料夾），備份檔只記圖片的雲端編號；重裝並還原備份後，圖片顯示時會自動從 Drive 下載回來。方法二：匯出到資料夾，重裝後再匯入。</div>' +
            '<div id="nis-stat" style="font-size:10px;color:#e2e8f0;margin-bottom:6px;"></div>' +
            '<label style="display:flex;gap:6px;align-items:center;font-size:10px;color:#cbd5e1;margin-bottom:6px;"><input id="nis-auto" type="checkbox" style="accent-color:#a855f7;"> 新圖片自動上傳到 Drive（需 Google 授權含雲端硬碟）</label>' +
            '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
            '<button id="nis-up" class="px-2 py-1 text-[10px] bg-blue-700 hover:bg-blue-600 text-white rounded-md">☁️ 上傳圖片到 Drive</button>' +
            '<button id="nis-down" class="px-2 py-1 text-[10px] bg-blue-700 hover:bg-blue-600 text-white rounded-md">☁️ 從 Drive 還原全部圖片</button>' +
            '<button id="nis-exp" class="px-2 py-1 text-[10px] bg-purple-700 hover:bg-purple-600 text-white rounded-md">📦 匯出到資料夾</button></div>';
        input.parentNode.appendChild(box);
        var a = D.getElementById('nis-auto'); a.checked = lsGet(K_AUTO, '1') !== '0'; a.onchange = function () { lsSet(K_AUTO, a.checked ? '1' : '0'); };
        D.getElementById('nis-up').onclick = function () { uploadAll({}); };
        D.getElementById('nis-down').onclick = function () { restoreAll(); };
        D.getElementById('nis-exp').onclick = function () { exportToFolder(); };
        refreshStat();
        return true;
    }

    /* ───────── 自動上傳（新圖片） ───────── */
    var autoTimer = null;
    function scheduleAuto() { if (lsGet(K_AUTO, '1') === '0' || !canDrive()) return; clearTimeout(autoTimer); autoTimer = setTimeout(function () { uploadAll({ silent: true, limit: 40 }); }, 25000); }
    function wrapSave() {
        var s = store(); if (!s || s._imgsyncSaveWrapped) return !!(s && s._imgsyncSaveWrapped);
        var o = s.save; s.save = async function () { var r = await o.apply(this, arguments); if (r) scheduleAuto(); return r; };
        s._imgsyncSaveWrapped = true; return true;
    }
    function boot(n) {
        n = n || 0;
        var a = !!store() && wrapResolve(), b = !!store() && wrapSave(), c = injectUi();
        if ((!a || !b || !c) && n < 60) setTimeout(function () { boot(n + 1); }, 700);
        else if (a) { // 覆寫匯入（比對檔名＋改路徑）
            store().importImages = importFiles;
            D.addEventListener('visibilitychange', function () { if (!D.hidden) scheduleAuto(); });
            setTimeout(scheduleAuto, 15000);
        }
    }
    W.NovaImgSync = { uploadAll: uploadAll, restoreAll: restoreAll, exportToFolder: exportToFolder, importFiles: importFiles, version: '1.0.0' };
    if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', function () { boot(0); }); else boot(0);
})();

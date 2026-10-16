/* ═════════════════════════════════════════════════════════════════
   nova-workspace.js — NOVA Android「工作資料夾」（輸入區的資料夾按鈕；跟 index.html 放同一個資料夾 www/）
   版本：v1.1.0
   版本紀錄：
   v1.1.0 - App v2.6.61：① 手機分頁改用原生外掛 NovaFiles（MANAGE_EXTERNAL_STORAGE「所有檔案存取」）：授權後從手機儲存空間根目錄起可瀏覽、上一層、讀寫任意資料夾（分段讀寫大檔）；未授權時退回 NOVA 私有「文件」資料夾並顯示授權提示。② 視窗版面重排：標題＋關閉、分頁列、麵包屑列（上一層／重新整理圖示鈕）、搜尋＋新增資料夾＋上傳各自一列；按鈕一律無框無底色（只有主要動作有色）。
   v1.0.0 - App v2.6.59。移植桌面版 nova-workspace.js v1.0.1（工作資料夾），依手機架構改寫（手機沒有 Python 引擎／sidecar）：
            ① 輸入區多一顆資料夾按鈕（#composer-workspace-btn，接在多專家鈕後面）。按下彈出選單，為「這一輪對話」指定多個工作資料夾——
               Google Drive 與「手機文件資料夾」都可以、可混用；每個資料夾各自決定當「來源」（AI 優先到這裡讀取）、「寫入」（AI 優先把產出存這裡），
               預設兩者都開；不指定＝完全不指定。設定依對話 ID 保存（localStorage nova_ws_v1）。
            ② 檔案瀏覽視窗（全螢幕，Google Drive／手機文件 兩個分頁）：點資料夾進入、麵包屑／上一層／重新整理；資料夾可「＋加入」；
               檔案可勾選「附加為附件」（沿用對話框的 handleChatFileSelect）；可「上傳」手機檔案到目前資料夾、「新增資料夾」。
            ③ 設計決定（依使用者要求，同桌面版）：資料夾只是【引導】AI，不是限制，也不分唯讀／讀寫。做法：
               a. 指定資料夾後，對話走「工具呼叫」路徑（novaRunToolChat，Gemini／Grok），系統提示末尾加「指定的工作資料夾」說明（promptAddon）；
               b. 向 novaFcRegistry 註冊工具來源 workspace：drive_list／drive_read／drive_write／drive_create_folder（有指定 Drive 資料夾時）、
                  phone_list／phone_read／phone_write（有指定手機資料夾時）；寫入類工具呼叫前會先問使用者同意；
               c. AI 呼叫 drive_write／drive_create_folder／drive_list 沒帶資料夾時，自動補上對應的 Drive 資料夾（applyDriveDefaults）。
            ④ 手機限制（誠實聲明）：「手機文件資料夾」是 Android 的 Documents 目錄，Android 11 以後 App 只保證看得到自己建立的檔案
               （NOVA_Recordings、NOVA/Drive 等）；別的 App 放進去的檔案可能列不出來或讀不到，這是系統的分區儲存限制。
               附件單檔上限 10MB（手機一次要把整個檔案轉成 base64）；drive_read／phone_read 只讀文字（單次最多 8 萬字）。
            ⑤ 沒有桌面版的「遙控電腦」、「系統資料夾對話框」、本機電腦分頁（手機端不適用）。
            ⑥ 誠實聲明：Google Drive 與 Capacitor Filesystem 只在沙盒用模擬回應驗證流程，未用真機實測，請先用小檔案試。
   依賴：NovaGoogle（_raw／_connected／_has）、NovaGDrive.uploadBlob（可選）、Capacitor Filesystem、novaFcRegistry（nova-fc.js 註冊表）、handleChatFileSelect。
   對外：window.NovaWorkspace = { togglePopover, open, getFolders, hasFolders, promptAddon, applyDriveDefaults, version }
   ═════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';
    if (window.NovaWorkspace) return;

    var LS_KEY = 'nova_ws_v1';
    var MAX_FOLDERS = 12;
    var MAX_ATTACH = 10 * 1024 * 1024;
    var MAX_TEXT = 80000;
    var FOLDER_MIME = 'application/vnd.google-apps.folder';
    var GDOC_MIME = 'application/vnd.google-apps.document';

    function $(id) { return document.getElementById(id); }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function errText(e) { return (e && e.message) ? e.message : String(e); }
    function fmtSize(n) {
        n = Number(n); if (!isFinite(n) || n <= 0) return '';
        if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'; return (n / 1048576).toFixed(1) + ' MB';
    }
    function fmtDate(v) { if (!v) return ''; var d = new Date(v); if (isNaN(d)) return ''; return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
    function enc(s) { return encodeURIComponent(String(s == null ? '' : s)); }
    // 自己的提示條：全域 #toast 層級可能被視窗蓋住
    var _toastTimer = null;
    function toast(t) {
        try {
            ensureStyle();
            var el = $('nova-ws-toast');
            if (!el) { el = document.createElement('div'); el.id = 'nova-ws-toast'; document.body.appendChild(el); }
            el.textContent = String(t); el.className = 'show';
            clearTimeout(_toastTimer); _toastTimer = setTimeout(function () { el.className = ''; }, 3600);
        } catch (e) { console.log('[NovaWorkspace]', t); }
    }

    // ───────────────────────── 狀態（依對話 ID 保存）─────────────────────────
    var store = { sessions: {}, recent: [] };
    try {
        var raw = localStorage.getItem(LS_KEY);
        if (raw) { var o = JSON.parse(raw); if (o && typeof o === 'object') { store.sessions = o.sessions || {}; store.recent = Array.isArray(o.recent) ? o.recent : []; } }
    } catch (e) { /* 沒有 localStorage 也能用（只是不保存） */ }
    function saveStore() {
        try {
            var keys = Object.keys(store.sessions);
            if (keys.length > 300) { keys.slice(0, keys.length - 300).forEach(function (k) { delete store.sessions[k]; }); }
            localStorage.setItem(LS_KEY, JSON.stringify(store));
        } catch (e) { /* */ }
    }
    function sid() { try { return String((window.appState && window.appState.currentSessionId) || 'default'); } catch (e) { return 'default'; } }
    function folders() { var k = sid(); if (!Array.isArray(store.sessions[k])) store.sessions[k] = []; return store.sessions[k]; }
    function fid(kind, ref) { return kind + ':' + ref; }
    function roleOf(f) { return f.role === 'source' || f.role === 'target' ? f.role : 'both'; }
    function isSource(f) { var r = roleOf(f); return r === 'source' || r === 'both'; }
    function isTarget(f) { var r = roleOf(f); return r === 'target' || r === 'both'; }
    function sanitizeList(list) {
        var out = [], seen = {};
        (Array.isArray(list) ? list : []).forEach(function (f) {
            if (!f || (f.kind !== 'local' && f.kind !== 'drive') || !f.ref) return;
            var id = fid(f.kind, f.ref); if (seen[id]) return; seen[id] = 1;
            if (out.length >= MAX_FOLDERS) return;
            out.push({ id: id, kind: f.kind, ref: String(f.ref), name: String(f.name || f.ref), role: roleOf(f) });
        });
        return out;
    }
    function commit() { store.sessions[sid()] = sanitizeList(folders()); saveStore(); refreshButton(); renderPopover(); }
    function addFolder(kind, ref, name, role) {
        var list = folders(), id = fid(kind, ref);
        for (var i = 0; i < list.length; i++) if (list[i].id === id) { toast('這個資料夾已經在清單裡了'); return false; }
        if (list.length >= MAX_FOLDERS) { toast('最多指定 ' + MAX_FOLDERS + ' 個資料夾'); return false; }
        list.push({ id: id, kind: kind, ref: String(ref), name: String(name || ref), role: role || 'both' });
        store.recent = [{ kind: kind, ref: String(ref), name: String(name || ref) }].concat(store.recent.filter(function (r) { return fid(r.kind, r.ref) !== id; })).slice(0, 8);
        commit(); return true;
    }
    function removeFolder(id) { store.sessions[sid()] = folders().filter(function (f) { return f.id !== id; }); commit(); }
    function toggleRole(id, which) {
        var f = folders().filter(function (x) { return x.id === id; })[0]; if (!f) return;
        var s = isSource(f), t = isTarget(f);
        if (which === 'source') s = !s; else t = !t;
        if (!s && !t) { toast('來源與寫入至少要開一個；不需要的話請按 ✕ 移除'); return; }
        f.role = (s && t) ? 'both' : (s ? 'source' : 'target');
        commit();
    }
    function clearAll() { store.sessions[sid()] = []; commit(); }

    // ───────────────────────── 提示詞引導／Drive 預設資料夾 ─────────────────────────
    function describe(f) {
        return f.kind === 'local' ? ('手機資料夾：「' + (f.ref || '(手機儲存空間根目錄)') + '」（phone_* 工具用的相對路徑）')
            : ('Google Drive：「' + f.name + '」（folder_id=' + f.ref + '）');
    }
    function promptAddon() {
        var list = folders(); if (!list.length) return '';
        var src = list.filter(isSource), tgt = list.filter(isTarget), L = [];
        L.push('\n【📁 本輪指定的工作資料夾（僅供引導，不是限制）】');
        L.push('使用者在這個對話指定了下列資料夾，目的是讓你不必自己去找檔案的位置：');
        if (src.length) { L.push('▸ 來源資料夾（要讀取、參考的檔案請優先到這裡找）：'); src.forEach(function (f, i) { L.push('  ' + (i + 1) + '. ' + describe(f)); }); }
        if (tgt.length) { L.push('▸ 寫入資料夾（要產生、儲存的檔案請優先放這裡；使用者沒有另外指定存放位置時就直接存這裡）：'); tgt.forEach(function (f, i) { L.push('  ' + (i + 1) + '. ' + describe(f)); }); }
        L.push('使用方式：Google Drive 資料夾用 drive_list／drive_read／drive_write／drive_create_folder 並帶上 folder_id（沒帶時系統會自動補上上面對應的資料夾）；'
            + '手機文件資料夾用 phone_list／phone_read／phone_write，路徑是相對於手機儲存空間根目錄（授權「所有檔案存取」時，例如 Download/報告.txt；未授權時是 NOVA 私有文件目錄）的相對路徑。不確定內容時先列出再讀。'
            + '這些工具只能讀寫文字內容（讀取上限約 8 萬字）；圖片、PDF 等二進位檔無法用工具讀，請使用者用「附加為附件」。');
        L.push('若使用者這句話明確指到別的檔案或位置，以使用者的指示為準；這些資料夾不是權限限制，需要時也可以讀寫其他位置。');
        return L.join('\n') + '\n';
    }
    function firstDrive(pred) { var l = folders().filter(function (f) { return f.kind === 'drive' && pred(f); }); return l.length ? l[0] : null; }
    function applyDriveDefaults(tool, args) {
        try {
            var a = Object.assign({}, args || {});
            if (tool === 'drive_write') {
                if (!a.file_id && !a.folder_id) { var t = firstDrive(isTarget); if (t) a.folder_id = t.ref; }
            } else if (tool === 'drive_create_folder') {
                if (!a.parent_folder_id) { var t2 = firstDrive(isTarget); if (t2) a.parent_folder_id = t2.ref; }
            } else if (tool === 'drive_list') {
                if (!a.folder_id && !a.query) { var s = firstDrive(isSource); if (s) a.folder_id = s.ref; }
            }
            return a;
        } catch (e) { return args; }
    }

    // ───────────────────────── Google Drive 存取（沿用 NovaGoogle 的授權）─────────────────────────
    function G() { return window.NovaGoogle; }
    function driveReady() { try { return !!(G() && G()._connected() && G()._has('drive')); } catch (e) { return false; } }
    function needDrive() { if (!driveReady()) throw new Error('尚未連接 Google 或沒有 Drive 授權（設定 → Google 整合）'); }
    async function apiJson(url, opts) {
        needDrive();
        var r = await G()._raw(url, opts), t = await r.text(), j;
        try { j = JSON.parse(t); } catch (e) { j = { raw: t }; }
        if (!r.ok) throw new Error((j.error && (j.error.message || j.error)) || ('HTTP ' + r.status));
        return j;
    }
    var FIELDS = 'nextPageToken,files(id,name,mimeType,size,modifiedTime)';
    async function driveList(o) {
        o = o || {};
        var q;
        if (o.query) q = "name contains '" + String(o.query).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "' and trashed=false";
        else q = "'" + String(o.folder_id || 'root').replace(/'/g, "\\'") + "' in parents and trashed=false";
        var url = 'https://www.googleapis.com/drive/v3/files?q=' + enc(q) + '&fields=' + enc(FIELDS) + '&pageSize=' + (o.max || 100) + '&orderBy=' + enc('folder,name');
        var j = await apiJson(url);
        return j.files || [];
    }
    function isTextName(n, mime) { return /^text\//.test(mime || '') || /json|xml|javascript|csv|markdown|yaml/.test(mime || '') || /\.(txt|md|csv|json|xml|html?|js|css|py|log|ini|ya?ml|srt|vtt|tsv)$/i.test(n || ''); }
    async function driveReadText(fileId) {
        needDrive();
        var meta = await apiJson('https://www.googleapis.com/drive/v3/files/' + enc(fileId) + '?fields=id,name,mimeType,size');
        var native = /^application\/vnd\.google-apps\./.test(meta.mimeType);
        if (!native && !isTextName(meta.name, meta.mimeType)) throw new Error('「' + meta.name + '」不是文字檔（' + meta.mimeType + '），無法用工具讀取；請使用者用「附加為附件」');
        if (!native && Number(meta.size) > 2 * 1024 * 1024) throw new Error('「' + meta.name + '」超過 2MB，太大不適合用工具讀取');
        var url = native ? 'https://www.googleapis.com/drive/v3/files/' + enc(fileId) + '/export?mimeType=' + enc('text/plain') : 'https://www.googleapis.com/drive/v3/files/' + enc(fileId) + '?alt=media';
        var r = await G()._raw(url), t = await r.text();
        if (!r.ok) { var j = {}; try { j = JSON.parse(t); } catch (e) { /* */ } throw new Error((j.error && j.error.message) || ('HTTP ' + r.status)); }
        t = t.replace(/^﻿/, '');
        return { name: meta.name, text: t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) : t, truncated: t.length > MAX_TEXT, total: t.length };
    }
    async function driveUpload(blob, name, mime, opts) {
        needDrive();
        if (window.NovaGDrive && typeof NovaGDrive.uploadBlob === 'function') return await NovaGDrive.uploadBlob(blob, name, mime, opts);
        // 備援（無 NovaGDrive）：小檔 multipart
        var boundary = 'nova' + Date.now(), meta = { name: name, mimeType: mime }; if (opts && opts.parent) meta.parents = [opts.parent];
        var body = new Blob(['--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n--' + boundary + '\r\nContent-Type: ' + mime + '\r\n\r\n', blob, '\r\n--' + boundary + '--']);
        var url = (opts && opts.fileId) ? 'https://www.googleapis.com/upload/drive/v3/files/' + enc(opts.fileId) + '?uploadType=media&fields=id,name' : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name';
        var r = await G()._raw(url, { method: (opts && opts.fileId) ? 'PATCH' : 'POST', headers: { 'Content-Type': (opts && opts.fileId) ? mime : 'multipart/related; boundary=' + boundary }, body: (opts && opts.fileId) ? blob : body });
        var t = await r.text(); if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 120)); return JSON.parse(t || '{}');
    }
    async function driveWriteText(a) {
        needDrive();
        var name = String(a.name || '').trim(), content = String(a.content == null ? '' : a.content);
        if (a.file_id) {
            var meta = await apiJson('https://www.googleapis.com/drive/v3/files/' + enc(a.file_id) + '?fields=id,name,mimeType');
            if (meta.mimeType === GDOC_MIME) {
                var r = await G()._raw('https://www.googleapis.com/upload/drive/v3/files/' + enc(a.file_id) + '?uploadType=media', { method: 'PATCH', headers: { 'Content-Type': 'text/plain; charset=UTF-8' }, body: content });
                if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 120));
                return { id: meta.id, name: meta.name, updated: true };
            }
            var u = await driveUpload(new Blob([content], { type: meta.mimeType || 'text/plain' }), meta.name, meta.mimeType || 'text/plain', { fileId: a.file_id });
            return { id: u.id || a.file_id, name: meta.name, updated: true };
        }
        if (!name) throw new Error('要建立新檔案請提供 name（檔名，例如 報告.md）');
        var mime = /\.md$/i.test(name) ? 'text/markdown' : (/\.json$/i.test(name) ? 'application/json' : (/\.csv$/i.test(name) ? 'text/csv' : 'text/plain'));
        var up = await driveUpload(new Blob([content], { type: mime }), name, mime, { parent: a.folder_id || undefined });
        return { id: up.id, name: up.name || name, created: true };
    }
    async function driveMkdir(name, parent) {
        var meta = { name: name, mimeType: FOLDER_MIME }; if (parent) meta.parents = [parent];
        return await apiJson('https://www.googleapis.com/drive/v3/files?fields=id,name', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meta) });
    }
    async function driveBlob(f) {
        needDrive();
        if (/^application\/vnd\.google-apps\./.test(f.mime || '')) {
            // Google 原生檔案：文件匯出純文字，其他請改用 Drive 開啟
            if (f.mime !== GDOC_MIME) throw new Error('這是 Google 試算表／簡報，請在 Drive 另存成 Excel／PDF 再附加');
            var rr = await G()._raw('https://www.googleapis.com/drive/v3/files/' + enc(f.ref) + '/export?mimeType=' + enc('text/plain'));
            if (!rr.ok) throw new Error('HTTP ' + rr.status);
            return { blob: new Blob([await rr.text()], { type: 'text/plain' }), name: f.name.replace(/\.[^.]*$/, '') + '.txt' };
        }
        var r = await G()._raw('https://www.googleapis.com/drive/v3/files/' + enc(f.ref) + '?alt=media');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return { blob: await r.blob(), name: f.name };
    }

    // ───────────────────────── 手機檔案（v1.1.0：原生 NovaFiles「所有檔案存取」優先；沒授權才退回 App 私有「文件」資料夾）─────────────────────────
    function PL() { try { return window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.NovaFiles; } catch (e) { return null; } }
    function FS() { try { return window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.Filesystem; } catch (e) { return null; } }
    var LM = { full: false, root: '/storage/emulated/0', checked: false };
    async function checkAccess() {
        var pl = PL();
        if (pl && typeof pl.hasAccess === 'function') {
            try { var r = await pl.hasAccess(); LM.full = !!r.granted; if (r.root) LM.root = r.root; } catch (e) { LM.full = false; }
        } else LM.full = false;
        LM.checked = true; return LM.full;
    }
    function needFs() { var f = FS(); if (!f) throw new Error('手機檔案只能在 Android App 內使用'); return f; }
    function cleanPath(p) {
        p = String(p == null ? '' : p).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
        if (p.split('/').some(function (s) { return s === '..'; })) throw new Error('路徑不可包含 ..');
        return p;
    }
    function absPath(rel) { var p = cleanPath(rel); return LM.root + (p ? '/' + p : ''); }
    function rootLabel() { return LM.full ? '手機' : 'NOVA 私有文件'; }
    async function localList(path) {
        var p = cleanPath(path);
        if (LM.full) {
            var r0 = await PL().list({ path: absPath(p) });
            return (r0.files || []).map(function (e) { return { name: e.name, isDir: !!e.isDir, size: e.size, mtime: e.mtime, path: (p ? p + '/' : '') + e.name }; });
        }
        var r = await needFs().readdir({ path: p, directory: 'DOCUMENTS' });
        return (r.files || []).map(function (e) {
            return { name: e.name, isDir: e.type === 'directory', size: e.size, mtime: e.mtime, path: (p ? p + '/' : '') + e.name };
        }).sort(function (a, b) { return (b.isDir ? 1 : 0) - (a.isDir ? 1 : 0) || a.name.localeCompare(b.name); });
    }
    async function localReadText(path) {
        var p = cleanPath(path);
        if (LM.full) {
            var st0 = await PL().stat({ path: absPath(p) });
            if (st0 && Number(st0.size) > 2 * 1024 * 1024) throw new Error('檔案超過 2MB，太大不適合用工具讀取');
            var r0 = await PL().readText({ path: absPath(p), max: MAX_TEXT * 4 });
            var t0 = String(r0.text == null ? '' : r0.text);
            return { text: t0.length > MAX_TEXT ? t0.slice(0, MAX_TEXT) : t0, truncated: t0.length > MAX_TEXT, total: t0.length };
        }
        var fs = needFs();
        var st = await fs.stat({ path: p, directory: 'DOCUMENTS' });
        if (st && Number(st.size) > 2 * 1024 * 1024) throw new Error('檔案超過 2MB，太大不適合用工具讀取');
        var r = await fs.readFile({ path: p, directory: 'DOCUMENTS', encoding: 'utf8' });
        var t = String(r.data == null ? '' : r.data);
        return { text: t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) : t, truncated: t.length > MAX_TEXT, total: t.length };
    }
    async function localWriteText(path, content) {
        var p = cleanPath(path);
        if (!p) throw new Error('請提供檔案路徑');
        if (LM.full) await PL().writeText({ path: absPath(p), text: String(content == null ? '' : content) });
        else await needFs().writeFile({ path: p, data: String(content == null ? '' : content), directory: 'DOCUMENTS', encoding: 'utf8', recursive: true });
        return { path: p };
    }
    async function localMkdir(path) {
        if (LM.full) await PL().mkdir({ path: absPath(path) });
        else await needFs().mkdir({ path: cleanPath(path), directory: 'DOCUMENTS', recursive: true });
    }
    async function localBlob(f) {
        var p = cleanPath(f.ref), parts = [];
        if (LM.full) {
            var st0 = await PL().stat({ path: absPath(p) });
            if (st0 && Number(st0.size) > MAX_ATTACH) throw new Error('超過 10MB');
            var off = 0, size = Number(st0.size) || 0;
            while (off < size) {   // 分段讀，避免一次把整檔 base64 塞過橋接
                var c = await PL().readChunk({ path: absPath(p), offset: off, length: 786432 });
                var bin = atob(c.data || ''), u8 = new Uint8Array(bin.length);
                for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
                parts.push(u8); off += Number(c.read) || 0; if (!c.read) break;
            }
            return { blob: new Blob(parts, { type: guessMime(f.name) }), name: f.name };
        }
        var fs = needFs();
        var st = await fs.stat({ path: p, directory: 'DOCUMENTS' });
        if (st && Number(st.size) > MAX_ATTACH) throw new Error('超過 10MB');
        var r = await fs.readFile({ path: p, directory: 'DOCUMENTS' });
        var b64 = String(r.data || ''), bin2 = atob(b64), n = bin2.length, u82 = new Uint8Array(n);
        for (var k = 0; k < n; k++) u82[k] = bin2.charCodeAt(k);
        return { blob: new Blob([u82], { type: guessMime(f.name) }), name: f.name };
    }
    async function localWriteBlob(path, blob) {
        var p = cleanPath(path);
        if (LM.full) {
            var off = 0, first = true;
            if (!blob.size) { await PL().writeChunk({ path: absPath(p), data: '', append: false }); return; }
            while (off < blob.size) {
                var b64 = await blobToB64(blob.slice(off, off + 786432));
                await PL().writeChunk({ path: absPath(p), data: b64, append: !first });
                first = false; off += 786432;
            }
        } else {
            await needFs().writeFile({ path: p, data: await blobToB64(blob), directory: 'DOCUMENTS', recursive: true });
        }
    }
    function guessMime(n) {
        var m = /\.([a-z0-9]+)$/i.exec(n || ''); var x = m ? m[1].toLowerCase() : '';
        return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', html: 'text/html', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'video/mp4',
            docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' })[x] || 'application/octet-stream';
    }
    function blobToB64(blob) { return new Promise(function (res, rej) { var fr = new FileReader(); fr.onload = function () { var s = String(fr.result); res(s.slice(s.indexOf(',') + 1)); }; fr.onerror = function () { rej(new Error('讀取檔案失敗')); }; fr.readAsDataURL(blob); }); }

    // ───────────────────────── 工具來源（註冊到 novaFcRegistry）─────────────────────────
    function tool(name, label, desc, props, required, readOnly, run) {
        return { name: name, label: label, description: desc, parameters: { type: 'object', properties: props, required: required || [] }, readOnly: !!readOnly, needsConfirm: !readOnly, run: run };
    }
    async function ac() { if (!LM.checked) await checkAccess(); }
    function listTools() {
        var list = folders(), out = [];
        if (!list.length) return out;
        if (list.some(function (f) { return f.kind === 'drive'; })) {
            out.push(tool('drive_list', '雲端硬碟：列出', '列出 Google Drive 資料夾內的檔案與子資料夾，或用 query 依檔名搜尋。沒帶 folder_id 時用使用者指定的來源資料夾。回傳每個項目的 id、名稱、類型、大小。', {
                folder_id: { type: 'string', description: '資料夾 ID（可省略）' }, query: { type: 'string', description: '檔名關鍵字（可省略）' } }, [], true, async function (a) {
                a = applyDriveDefaults('drive_list', a);
                var fs = await driveList(a);
                if (!fs.length) return '（沒有項目）';
                return fs.map(function (f) { return (f.mimeType === FOLDER_MIME ? '[資料夾] ' : '') + f.name + '｜id=' + f.id + (f.size ? '｜' + fmtSize(f.size) : '') + (f.modifiedTime ? '｜' + fmtDate(f.modifiedTime) : ''); }).join('\n');
            }));
            out.push(tool('drive_read', '雲端硬碟：讀取文字檔', '讀取 Google Drive 上的文字檔或 Google 文件（以純文字）。需要 file_id（可先用 drive_list 取得）。只支援文字，最多讀 8 萬字。', {
                file_id: { type: 'string', description: '檔案 ID' } }, ['file_id'], true, async function (a) {
                var r = await driveReadText(String(a.file_id || ''));
                return '檔名：' + r.name + (r.truncated ? '（內容共 ' + r.total + ' 字，只顯示前 ' + MAX_TEXT + ' 字）' : '') + '\n\n' + r.text;
            }));
            out.push(tool('drive_write', '雲端硬碟：寫入文字檔', '在 Google Drive 建立新文字檔（提供 name，沒帶 folder_id 時存到使用者指定的寫入資料夾），或用 file_id 覆寫既有文字檔／Google 文件的全文。', {
                name: { type: 'string', description: '新檔名（建立新檔時必填，例如 報告.md）' }, content: { type: 'string', description: '檔案文字內容' },
                folder_id: { type: 'string', description: '存放的資料夾 ID（可省略）' }, file_id: { type: 'string', description: '要覆寫的既有檔案 ID（可省略）' } }, ['content'], false, async function (a) {
                a = applyDriveDefaults('drive_write', a);
                var r = await driveWriteText(a);
                return (r.created ? '已建立「' : '已更新「') + r.name + '」（id=' + r.id + '）';
            }));
            out.push(tool('drive_create_folder', '雲端硬碟：新增資料夾', '在 Google Drive 建立資料夾。沒帶 parent_folder_id 時建在使用者指定的寫入資料夾底下。', {
                name: { type: 'string', description: '資料夾名稱' }, parent_folder_id: { type: 'string', description: '上層資料夾 ID（可省略）' } }, ['name'], false, async function (a) {
                a = applyDriveDefaults('drive_create_folder', a);
                var r = await driveMkdir(String(a.name || '').trim(), a.parent_folder_id);
                return '已建立資料夾「' + r.name + '」（id=' + r.id + '）';
            }));
        }
        if (list.some(function (f) { return f.kind === 'local'; })) {
            out.push(tool('phone_list', '手機文件：列出', '列出手機儲存空間底下某個相對路徑的檔案與資料夾（路徑留空＝根目錄）。', {
                path: { type: 'string', description: '相對於手機儲存空間根目錄的路徑，例如 Download 或 Documents/報告' } }, [], true, async function (a) {
                await ac(); var items = await localList(a && a.path);
                if (!items.length) return '（沒有項目）';
                return items.map(function (e) { return (e.isDir ? '[資料夾] ' : '') + e.name + '｜path=' + e.path + (e.size ? '｜' + fmtSize(e.size) : ''); }).join('\n');
            }));
            out.push(tool('phone_read', '手機文件：讀取文字檔', '讀取手機儲存空間內的文字檔（UTF-8），最多 8 萬字。', {
                path: { type: 'string', description: '相對於手機儲存空間根目錄的檔案路徑' } }, ['path'], true, async function (a) {
                await ac(); var r = await localReadText(a.path);
                return (r.truncated ? '（內容共 ' + r.total + ' 字，只顯示前 ' + MAX_TEXT + ' 字）\n\n' : '') + r.text;
            }));
            out.push(tool('phone_write', '手機文件：寫入文字檔', '在手機儲存空間內建立或覆寫文字檔（UTF-8，會自動建立缺少的資料夾）。沒有指定位置時請放在使用者指定的手機寫入資料夾底下。', {
                path: { type: 'string', description: '相對於手機儲存空間根目錄的檔案路徑，例如 Documents/報告.md' }, content: { type: 'string', description: '檔案文字內容' } }, ['path', 'content'], false, async function (a) {
                await ac(); var r = await localWriteText(a.path, a.content);
                return '已寫入「' + rootLabel() + '/' + r.path + '」';
            }));
        }
        return out;
    }
    var _regTries = 0;
    function registerTools() {
        try {
            if (window.novaFcRegistry && typeof novaFcRegistry.register === 'function') {
                novaFcRegistry.register({ id: 'workspace', label: '工作資料夾', list: async function () { return listTools(); } });
                return;
            }
        } catch (e) { console.warn('[NovaWorkspace] 註冊工具失敗：', e); }
        if (++_regTries < 40) setTimeout(registerTools, 500);
    }

    // ───────────────────────── 樣式 ─────────────────────────
    function ensureStyle() {
        if ($('nova-ws-style')) return;
        var st = document.createElement('style'); st.id = 'nova-ws-style';
        st.textContent = [
            '#nova-ws-pop,#nova-ws-modal{--w-bg:var(--nv-card,#0f172a);--w-bg2:var(--nv-card-2,#1e293b);--w-bg3:var(--nv-hover,#334155);--w-bd:var(--nv-line-strong,#334155);--w-tx:var(--nv-text,#e2e8f0);--w-mu:var(--nv-muted,#94a3b8);--w-ac:#6366f1;--w-ac2:#818cf8;--w-grn:#34d399;--w-red:#f87171;font-family:inherit;color:var(--w-tx)}',
            '#nova-ws-pop,#nova-ws-pop *,#nova-ws-modal,#nova-ws-modal *{box-sizing:border-box}',
            '#nova-ws-pop{position:fixed;z-index:2147482900;background:var(--w-bg);border:1px solid var(--w-bd);border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.5);padding:10px;max-height:min(70vh,560px);overflow:auto;font-size:13px}',
            '.nw-h{font-weight:800;font-size:14px;display:flex;align-items:center;gap:6px;padding:2px 4px}',
            '.nw-hint{font-size:11.5px;color:var(--w-mu);padding:2px 4px 8px;line-height:1.5}',
            '.nw-sec{font-size:11px;color:var(--w-mu);padding:8px 4px 4px;font-weight:700}',
            '.nw-empty{font-size:12px;color:var(--w-mu);padding:10px;border:1px dashed var(--w-bd);border-radius:10px;text-align:center}',
            '.nw-row{display:flex;align-items:center;gap:8px;padding:6px;border:1px solid var(--w-bd);border-radius:10px;background:var(--w-bg2);margin-bottom:6px}',
            '.nw-ic{font-size:18px;flex:none}.nw-tx{flex:1;min-width:0}',
            '.nw-nm{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
            '.nw-sub{font-size:10.5px;color:var(--w-mu);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
            '#nova-ws-pop button.nw-btn,#nova-ws-modal button.nw-btn,#nova-ws-modal button.nw-tab{background:transparent !important;color:var(--w-tx) !important;border:0 !important;border-radius:10px;padding:8px 12px;font-size:14px;cursor:pointer;font-family:inherit;white-space:nowrap;box-shadow:none !important;min-height:40px;display:inline-flex;align-items:center;justify-content:center;gap:4px}',
            '#nova-ws-pop button.nw-btn:active,#nova-ws-modal button.nw-btn:active,#nova-ws-modal button.nw-tab:active{background:rgba(148,163,184,.22) !important}',
            '#nova-ws-pop button.nw-btn:disabled,#nova-ws-modal button.nw-btn:disabled{opacity:.35}',
            '#nova-ws-pop button.nw-btn.pri,#nova-ws-modal button.nw-btn.pri,#nova-ws-modal button.nw-tab.on{background:var(--w-ac) !important;color:#fff !important}',
            '#nova-ws-modal button.nw-tab{flex:1;font-weight:700;color:var(--w-mu) !important}',
            '#nova-ws-modal button.nw-tab.on{color:#fff !important}',
            '#nova-ws-pop button.nw-btn.on,#nova-ws-modal button.nw-btn.on{color:#059669 !important;font-weight:700}',
            '#nova-ws-pop button.nw-btn.x{padding:6px 10px;color:var(--w-red) !important}',
            '#nova-ws-modal button.nw-btn.ic{width:40px;padding:0;font-size:18px}',
            '.nw-btn.sm{padding:6px 10px !important;font-size:13px !important;min-height:34px !important}',
            '.nw-act{display:flex;flex-direction:column;gap:6px;margin-top:6px}.nw-act .nw-btn{text-align:left}',
            '.nw-roles{display:flex;gap:4px;flex:none}',
            '#nova-ws-modal{position:fixed;inset:0;z-index:2147482950;background:var(--w-bg);display:flex;flex-direction:column;padding-top:env(safe-area-inset-top,0px)}',
            '#nova-ws-modal.nw-hidden,#nova-ws-pop.nw-hidden{display:none}',
            '.nw-win{position:relative;flex:1;min-height:0;display:flex;flex-direction:column;font-size:14px}',
            '.nw-head{display:flex;align-items:center;gap:8px;padding:10px 8px 6px 14px}',
            '.nw-title{font-weight:800;font-size:16px;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
            '.nw-tabs{display:flex;gap:6px;padding:2px 12px 8px}',
            '.nw-warn{display:flex;align-items:center;gap:8px;margin:0 12px 6px;padding:8px 10px;border-radius:10px;background:rgba(245,158,11,.14);font-size:12px;line-height:1.45;color:var(--w-tx)}',
            '.nw-warn span{flex:1}',
            '.nw-bar{display:flex;align-items:center;gap:2px;padding:0 8px 0 4px;border-bottom:1px solid var(--w-bd)}',
            '.nw-crumb{flex:1;min-width:0;font-size:13px;color:var(--w-mu);display:flex;gap:4px;align-items:center;white-space:nowrap;overflow-x:auto;padding:8px 6px;scrollbar-width:none}',
            '.nw-crumb::-webkit-scrollbar{display:none}',
            '.nw-crumb a{color:var(--w-ac2);cursor:pointer;text-decoration:none;flex:none}.nw-crumb b{color:var(--w-tx);flex:none}',
            '.nw-tool{display:flex;align-items:center;gap:4px;padding:6px 8px 6px 12px;border-bottom:1px solid var(--w-bd)}',
            '.nw-in{background:var(--w-bg2);border:0;color:var(--w-tx);border-radius:10px;padding:9px 11px;font-size:14px;outline:none;min-width:0;flex:1;font-family:inherit}',
            '.nw-list{flex:1;overflow:auto;padding:8px 12px}',
            '.nw-item{display:flex;align-items:center;gap:8px;padding:9px 6px;border-radius:9px;border:1px solid transparent}',
            '.nw-item:active{background:var(--w-bg2)}',
            '.nw-item .nm{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
            '.nw-item .nm.fo{cursor:pointer;font-weight:700}',
            '.nw-item .meta{font-size:11px;color:var(--w-mu);flex:none}',
            '.nw-item input[type=checkbox]{width:20px;height:20px;flex:none}',
            '.nw-foot{display:flex;align-items:center;gap:8px;padding:10px 12px calc(10px + env(safe-area-inset-bottom,0px));border-top:1px solid var(--w-bd);flex-wrap:wrap}',
            '.nw-msg{flex:1;min-width:120px;font-size:12px;color:var(--w-mu)}.nw-msg.err{color:var(--w-red)}.nw-msg.ok{color:#059669}',
            '#nova-ws-toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%) translateY(8px);z-index:2147483600;max-width:min(92vw,520px);background:#334155;color:#fff;border:1px solid rgba(148,163,184,.35);border-radius:10px;padding:10px 14px;font-size:13px;opacity:0;visibility:hidden;transition:all .2s;pointer-events:none}',
            '#nova-ws-toast.show{opacity:1;visibility:visible;transform:translateX(-50%) translateY(0)}',
            '.nw-dlg{position:absolute;inset:0;z-index:5;background:rgba(2,6,23,.55);display:flex;align-items:center;justify-content:center;padding:16px}',
            '.nw-dlg>div{width:min(420px,100%);background:var(--w-bg);border:1px solid var(--w-bd);border-radius:14px;padding:16px;box-shadow:0 18px 50px rgba(0,0,0,.5)}',
            '.nw-dlg h4{margin:0 0 10px;font-size:14px;font-weight:800;color:var(--w-tx)}',
            '.nw-dlg input{width:100%;background:var(--w-bg2);border:1px solid var(--w-bd);color:var(--w-tx);border-radius:10px;padding:10px 11px;font-size:16px;outline:none;font-family:inherit}',
            '.nw-dlg .row{display:flex;gap:8px;margin-top:12px;justify-content:flex-end}',
            /* 輸入區按鈕：接在多專家鈕後面（第 5 欄）；樣式比照其他輸入區按鈕（無底色，作用中才有淡底） */
            'html:root body #nova-composer > #composer-workspace-btn{grid-column:5;grid-row:2;justify-self:start;margin:0 !important;position:relative;display:flex}',
            'html:root body #nova-composer > #composer-workspace-btn.nw-on{background:rgba(99,102,241,.2) !important;color:#818cf8 !important}',
            'html.theme-light:root body #nova-composer > #composer-workspace-btn.nw-on{color:#4338ca !important}',
            '#composer-workspace-btn .nw-badge{position:absolute;top:0;right:0;min-width:16px;height:16px;padding:0 4px;border-radius:9px;background:#6366f1;color:#fff;font-size:10px;font-weight:800;line-height:16px;text-align:center;display:none}'
        ].join('\n');
        document.head.appendChild(st);
    }

    // ───────────────────────── 輸入區按鈕 ─────────────────────────
    function ensureButton() {
        if ($('composer-workspace-btn')) return;
        var anchor = $('composer-experts-btn'); if (!anchor || !anchor.parentNode) return;
        var b = document.createElement('button');
        b.id = 'composer-workspace-btn'; b.type = 'button'; b.setAttribute('aria-label', '工作資料夾');
        b.className = 'p-2 mb-1 rounded-full shrink-0 transition-all flex items-center justify-center active:scale-90 h-[40px] w-[40px] bg-slate-800 text-slate-400';
        b.innerHTML = '<i class="ph-bold ph-folder text-xl"></i><span class="nw-badge"></span>';
        b.onclick = togglePopover;
        anchor.parentNode.insertBefore(b, anchor.nextSibling);
    }
    var _lastBtnSig = '';
    function refreshButton() {
        ensureButton();
        var b = $('composer-workspace-btn'); if (!b) return;
        var n = folders().length, sig = sid() + '|' + folders().map(function (f) { return f.id + f.role; }).join(',');
        if (sig === _lastBtnSig) return; _lastBtnSig = sig;
        b.classList.toggle('nw-on', n > 0);
        var ic = b.querySelector('i'); if (ic) ic.className = 'ph-bold ' + (n ? 'ph-folder-open' : 'ph-folder') + ' text-xl';
        b.title = n ? ('工作資料夾（' + n + '）：' + folders().map(function (f) { return f.name; }).join('、')) : '工作資料夾：未指定';
        var bd = b.querySelector('.nw-badge'); if (bd) { bd.textContent = n; bd.style.display = n ? 'block' : 'none'; }
    }

    // ───────────────────────── 選單（彈出）─────────────────────────
    function popEl() {
        var p = $('nova-ws-pop');
        if (!p) { p = document.createElement('div'); p.id = 'nova-ws-pop'; p.className = 'nw-hidden'; document.body.appendChild(p); p.addEventListener('click', function (e) { e.stopPropagation(); }); }
        return p;
    }
    function popOpen() { var p = $('nova-ws-pop'); return !!(p && !p.classList.contains('nw-hidden')); }
    function closePop() { var p = $('nova-ws-pop'); if (p) p.classList.add('nw-hidden'); document.removeEventListener('click', outsideClose, true); }
    function outsideClose(e) { var p = $('nova-ws-pop'), b = $('composer-workspace-btn'); if (p && !p.contains(e.target) && !(b && b.contains(e.target))) closePop(); }
    function placePop() {
        var p = popEl(), b = $('composer-workspace-btn'); if (!b) return;
        var r = b.getBoundingClientRect(), w = Math.min(380, window.innerWidth - 16);
        p.style.width = w + 'px';
        p.style.left = Math.max(8, Math.min(r.left - 8, window.innerWidth - w - 8)) + 'px';
        p.style.bottom = Math.max(8, window.innerHeight - r.top + 8) + 'px'; p.style.top = 'auto';
    }
    function togglePopover(ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        ensureStyle();
        if (popOpen()) { closePop(); return; }
        popEl().classList.remove('nw-hidden'); renderPopover(); placePop();
        setTimeout(function () { document.addEventListener('click', outsideClose, true); }, 0);
    }
    function renderPopover() {
        if (!popOpen()) return;
        var p = popEl(), list = folders(), h = [];
        h.push('<div class="nw-h">📁 工作資料夾<span style="font-weight:400;color:var(--w-mu);font-size:11px">（本輪對話）</span></div>');
        h.push('<div class="nw-hint">指定後，AI 會優先到這些位置讀寫，不必自己找檔案（需 Gemini／Grok 模型，寫入前會先問你）；這只是引導、不是限制。不指定＝完全不加以指定。可分別決定哪個當「來源」、哪個當「寫入」。</div>');
        if (!list.length) h.push('<div class="nw-empty">尚未指定任何資料夾</div>');
        list.forEach(function (f) {
            h.push('<div class="nw-row"><span class="nw-ic">' + (f.kind === 'local' ? '📱' : '☁️') + '</span><div class="nw-tx"><div class="nw-nm" title="' + esc(f.name) + '">' + esc(f.name) + '</div><div class="nw-sub">' + esc(f.kind === 'local' ? rootLabel() + '/' + f.ref : 'Google Drive') + '</div></div>'
                + '<div class="nw-roles"><button class="nw-btn sm' + (isSource(f) ? ' on' : '') + '" data-role="source" data-id="' + esc(f.id) + '">來源</button><button class="nw-btn sm' + (isTarget(f) ? ' on' : '') + '" data-role="target" data-id="' + esc(f.id) + '">寫入</button></div>'
                + '<button class="nw-btn x" data-rm="' + esc(f.id) + '" title="移除">✕</button></div>');
        });
        h.push('<div class="nw-act">');
        h.push('<button class="nw-btn" data-act="drive">☁️ 加入 Google Drive 資料夾／附加檔案…</button>');
        h.push('<button class="nw-btn" data-act="local">📱 加入手機文件資料夾／附加檔案…</button>');
        if (list.length) h.push('<button class="nw-btn" data-act="clear" style="color:var(--w-red) !important">清除全部資料夾設定</button>');
        h.push('</div>');
        var rec = store.recent.filter(function (r) { return !list.some(function (f) { return f.id === fid(r.kind, r.ref); }); }).slice(0, 5);
        if (rec.length) {
            h.push('<div class="nw-sec">最近使用</div>');
            rec.forEach(function (r, i) { h.push('<div class="nw-row" style="margin-bottom:4px"><span class="nw-ic">' + (r.kind === 'local' ? '📱' : '☁️') + '</span><div class="nw-tx"><div class="nw-nm">' + esc(r.name) + '</div></div><button class="nw-btn sm" data-rec="' + i + '">＋ 加入</button></div>'); });
        }
        p.innerHTML = h.join('');
        p.querySelectorAll('[data-role]').forEach(function (b) { b.onclick = function () { toggleRole(b.getAttribute('data-id'), b.getAttribute('data-role')); }; });
        p.querySelectorAll('[data-rm]').forEach(function (b) { b.onclick = function () { removeFolder(b.getAttribute('data-rm')); }; });
        p.querySelectorAll('[data-rec]').forEach(function (b) { b.onclick = function () { var r = rec[Number(b.getAttribute('data-rec'))]; if (r) addFolder(r.kind, r.ref, r.name); }; });
        p.querySelectorAll('[data-act]').forEach(function (b) {
            b.onclick = function () { var a = b.getAttribute('data-act'); if (a === 'local' || a === 'drive') { closePop(); openModal(a); } else if (a === 'clear') clearAll(); };
        });
        placePop();
    }

    // ───────────────────────── 檔案瀏覽視窗 ─────────────────────────
    var M = { tab: 'drive', local: { path: '', entries: [], filter: '', loaded: false }, drive: { stack: [{ id: 'root', name: '我的雲端硬碟' }], entries: [], q: '', loaded: false }, sel: {}, busy: false };
    function modalEl() {
        var m = $('nova-ws-modal');
        if (m) return m;
        m = document.createElement('div'); m.id = 'nova-ws-modal'; m.className = 'nw-hidden';
        m.innerHTML = '<div class="nw-win"><div class="nw-head"><div class="nw-title">📁 工作資料夾與附件</div><button class="nw-btn ic" id="nw-close" aria-label="關閉">✕</button></div>'
            + '<div class="nw-tabs"><button class="nw-tab" data-tab="drive">☁️ Google Drive</button><button class="nw-tab" data-tab="local">📱 手機</button></div>'
            + '<div class="nw-warn" id="nw-warn" style="display:none"><span>目前只看得到 NOVA 的私有資料夾。授權「所有檔案存取」後，才能瀏覽手機裡的其他資料夾。</span><button class="nw-btn sm pri" id="nw-auth">授權</button></div>'
            + '<div class="nw-bar"><button class="nw-btn ic" id="nw-up" aria-label="上一層">⬆</button><button class="nw-btn ic" id="nw-ref" aria-label="重新整理">⟳</button><div class="nw-crumb" id="nw-crumb"></div></div>'
            + '<div class="nw-tool"><input class="nw-in" id="nw-q" placeholder="搜尋／篩選…"><button class="nw-btn sm" id="nw-mk">＋ 資料夾</button><button class="nw-btn sm" id="nw-upl">⬆ 上傳</button><input type="file" id="nw-file" multiple style="display:none"></div>'
            + '<div class="nw-list" id="nw-list"></div>'
            + '<div class="nw-foot"><div class="nw-msg" id="nw-msg"></div><button class="nw-btn pri" id="nw-att" disabled>附加所選檔案</button></div></div>';
        document.body.appendChild(m);
        m.querySelector('#nw-close').onclick = closeModal;
        m.querySelector('#nw-auth').onclick = function () { var pl = PL(); if (!pl) { toast('只能在 Android App 內授權'); return; } pl.requestAccess().then(function () { toast('請在系統頁面開啟「允許存取所有檔案」，回到 NOVA 後會自動更新'); }).catch(function (e) { toast('❌ ' + errText(e)); }); };
        m.querySelectorAll('.nw-tab').forEach(function (b) { b.onclick = function () { setTab(b.getAttribute('data-tab')); }; });
        m.querySelector('#nw-up').onclick = goUp;
        m.querySelector('#nw-ref').onclick = function () { load(true); };
        m.querySelector('#nw-mk').onclick = makeFolder;
        m.querySelector('#nw-upl').onclick = function () { m.querySelector('#nw-file').click(); };
        m.querySelector('#nw-file').onchange = function (e) { var fs = Array.prototype.slice.call(e.target.files || []); e.target.value = ''; if (fs.length) uploadFiles(fs); };
        m.querySelector('#nw-att').onclick = attachSelected;
        var q = m.querySelector('#nw-q');
        q.oninput = function () { if (M.tab === 'local') { M.local.filter = q.value; renderList(); } };
        q.onkeydown = function (e) { if (e.key === 'Enter' && M.tab === 'drive') { M.drive.q = q.value.trim(); load(true); } };
        return m;
    }
    function msg(t, cls) { var el = $('nw-msg'); if (el) { el.textContent = t || ''; el.className = 'nw-msg' + (cls ? ' ' + cls : ''); } }
    function openModal(tab) { ensureStyle(); var m = modalEl(); m.classList.remove('nw-hidden'); M.sel = {}; setTab(tab || M.tab || 'drive'); }
    function closeModal() { var m = $('nova-ws-modal'); if (m) m.classList.add('nw-hidden'); M.sel = {}; }
    function setTab(t) {
        M.tab = t === 'local' ? 'local' : 'drive';
        var m = modalEl();
        m.querySelectorAll('.nw-tab').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === M.tab); });
        m.querySelector('#nw-q').value = M.tab === 'drive' ? M.drive.q : M.local.filter;
        var _w = $('nw-warn'); if (_w && M.tab === 'drive') _w.style.display = 'none';
        m.querySelector('#nw-q').placeholder = M.tab === 'drive' ? '搜尋檔名後按 Enter' : '篩選目前資料夾';
        if (M.tab === 'drive' ? !M.drive.loaded : !M.local.loaded) load(false); else renderList();
    }
    function load(force) {
        msg('載入中…');
        if (M.tab === 'local') {
            var st = M.local;
            checkAccess().then(function () { var w = $('nw-warn'); if (w) w.style.display = (!LM.full && PL()) ? 'flex' : 'none'; return localList(st.path); }).then(function (items) { st.entries = items; st.loaded = true; st.filter = ''; var q = $('nw-q'); if (q) q.value = ''; msg(items.length + ' 個項目'); renderList(); })
                .catch(function (e) { st.entries = []; st.loaded = true; msg('❌ ' + errText(e), 'err'); renderList(); });
        } else {
            var d = M.drive, cur = d.stack[d.stack.length - 1];
            if (!driveReady()) { d.entries = []; d.loaded = true; d.auth = false; renderList(); msg('尚未連接 Google', 'err'); return; }
            d.auth = true;
            driveList(d.q ? { query: d.q } : { folder_id: cur.id }).then(function (fs) {
                d.entries = fs; d.loaded = true;
                msg(d.q ? ('搜尋「' + d.q + '」：' + fs.length + ' 筆') : (cur.name + '：' + fs.length + ' 個項目')); renderList();
            }).catch(function (e) { d.entries = []; d.loaded = true; msg('❌ ' + errText(e), 'err'); renderList(); });
        }
    }
    function goUp() {
        if (M.tab === 'local') { var p = M.local.path; if (!p) return; M.local.path = p.indexOf('/') >= 0 ? p.slice(0, p.lastIndexOf('/')) : ''; load(); }
        else { if (M.drive.q) { M.drive.q = ''; load(); return; } if (M.drive.stack.length > 1) { M.drive.stack.pop(); load(); } }
    }
    function curTarget() {
        if (M.tab === 'local') return { kind: 'local', ref: M.local.path, name: M.local.path ? M.local.path.split('/').pop() : rootLabel() };
        var c = M.drive.stack[M.drive.stack.length - 1]; return { kind: 'drive', ref: c.id, name: c.name };
    }
    function renderCrumb() {
        var el = $('nw-crumb'), h = [];
        if (M.tab === 'local') {
            var parts = M.local.path ? M.local.path.split('/') : [], acc = '';
            h.push(parts.length ? '<a data-p="">' + esc(rootLabel()) + '</a>' : '<b>' + esc(rootLabel()) + '</b>');
            parts.forEach(function (seg, i) { acc = acc ? acc + '/' + seg : seg; h.push('›'); h.push(i === parts.length - 1 ? '<b>' + esc(seg) + '</b>' : '<a data-p="' + esc(acc) + '">' + esc(seg) + '</a>'); });
        } else {
            M.drive.stack.forEach(function (s, i) { if (i) h.push('›'); h.push(i === M.drive.stack.length - 1 && !M.drive.q ? '<b>' + esc(s.name) + '</b>' : '<a data-i="' + i + '">' + esc(s.name) + '</a>'); });
            if (M.drive.q) { h.push('›'); h.push('<b>搜尋：' + esc(M.drive.q) + '</b>'); }
        }
        el.innerHTML = h.join(' ');
        el.querySelectorAll('a[data-p]').forEach(function (a) { a.onclick = function () { M.local.path = a.getAttribute('data-p'); load(); }; });
        el.querySelectorAll('a[data-i]').forEach(function (a) { a.onclick = function () { M.drive.stack = M.drive.stack.slice(0, Number(a.getAttribute('data-i')) + 1); M.drive.q = ''; load(); }; });
    }
    function iconFor(it) {
        if (it.isDir) return '📁';
        var n = (it.name || '').toLowerCase(), m = it.mime || '';
        if (/\.(png|jpe?g|gif|webp|bmp|svg)$/.test(n) || /image\//.test(m)) return '🖼️'; if (/\.(mp4|mov|mkv|webm)$/.test(n) || /video\//.test(m)) return '🎬';
        if (/\.(mp3|wav|m4a|aac|weba|flac)$/.test(n) || /audio\//.test(m)) return '🎵'; if (/\.pdf$/.test(n) || /pdf/.test(m)) return '📕';
        if (/\.(xlsx?|csv)$/.test(n) || /spreadsheet|excel|csv/.test(m)) return '📊'; if (/\.(pptx?)$/.test(n) || /presentation|powerpoint/.test(m)) return '📽️';
        if (/\.(docx?|txt|md)$/.test(n) || /document|word|text\//.test(m)) return '📄'; if (/\.(zip|rar|7z)$/.test(n)) return '🗜️';
        return '📎';
    }
    function normEntries() {
        if (M.tab === 'local') {
            var f = (M.local.filter || '').toLowerCase();
            return M.local.entries.filter(function (e) { return !f || e.name.toLowerCase().indexOf(f) >= 0; }).map(function (e) { return { kind: 'local', ref: e.path, name: e.name, isDir: e.isDir, size: e.size, date: e.mtime }; });
        }
        return M.drive.entries.map(function (e) { return { kind: 'drive', ref: e.id, name: e.name, isDir: e.mimeType === FOLDER_MIME, size: e.size != null ? Number(e.size) : null, date: e.modifiedTime, mime: e.mimeType }; });
    }
    function renderList() {
        modalEl(); renderCrumb();
        var up = $('nw-up'), t = curTarget();
        up.disabled = M.tab === 'local' ? !M.local.path : (M.drive.stack.length <= 1 && !M.drive.q);
        $('nw-mk').disabled = (M.tab === 'drive' && !!M.drive.q); $('nw-upl').disabled = (M.tab === 'drive' && !!M.drive.q);
        var items = normEntries(), el = $('nw-list');
        if (M.tab === 'drive' && M.drive.auth === false) { el.innerHTML = '<div class="nw-empty" style="margin:16px">尚未連接 Google 帳號。<br>請到「設定 → Google 整合」登入並授權雲端硬碟。</div>'; updateAttachBtn(); return; }
        if (!items.length) { el.innerHTML = '<div class="nw-empty" style="margin:16px">這裡沒有項目' + (M.tab === 'local' && !LM.full ? '<br><span style="font-size:11px">（未授權「所有檔案存取」時只看得到 NOVA 自己建立的檔案）</span>' : '') + '</div>'; updateAttachBtn(); return; }
        var cur = folders(), h = [];
        items.forEach(function (it, i) {
            var added = it.isDir && cur.some(function (f) { return f.id === fid(it.kind, it.ref); });
            var key = fid(it.kind, it.ref), checked = !it.isDir && M.sel[key];
            h.push('<div class="nw-item">' + (it.isDir ? '<span style="width:20px;flex:none"></span>' : '<input type="checkbox" data-sel="' + i + '"' + (checked ? ' checked' : '') + '>')
                + '<span class="nw-ic">' + iconFor(it) + '</span><span class="nm' + (it.isDir ? ' fo' : '') + '" data-i="' + i + '" title="' + esc(it.name) + '">' + esc(it.name) + '</span>'
                + '<span class="meta">' + esc(it.isDir ? '' : fmtSize(it.size)) + '</span>'
                + (it.isDir ? ('<button class="nw-btn sm' + (added ? ' on' : '') + '" data-add="' + i + '">' + (added ? '✓ 已加入' : '＋ 加入') + '</button>') : '') + '</div>');
        });
        el.innerHTML = h.join('');
        el.querySelectorAll('.nm.fo').forEach(function (n) { n.onclick = function () { enter(items[Number(n.getAttribute('data-i'))]); }; });
        el.querySelectorAll('[data-add]').forEach(function (b) {
            b.onclick = function () {
                var it = items[Number(b.getAttribute('data-add'))], id = fid(it.kind, it.ref);
                if (folders().some(function (f) { return f.id === id; })) { removeFolder(id); } else { addFolder(it.kind, it.ref, it.name); }
                renderList();
            };
        });
        el.querySelectorAll('[data-sel]').forEach(function (c) { c.onchange = function () { var it = items[Number(c.getAttribute('data-sel'))], k = fid(it.kind, it.ref); if (c.checked) M.sel[k] = it; else delete M.sel[k]; updateAttachBtn(); }; });
        el.querySelectorAll('.nw-item .nm:not(.fo)').forEach(function (n) { n.style.cursor = 'pointer'; n.onclick = function () { var it = items[Number(n.getAttribute('data-i'))], k = fid(it.kind, it.ref); if (M.sel[k]) delete M.sel[k]; else M.sel[k] = it; renderList(); }; });
        updateAttachBtn();
    }
    function enter(it) {
        if (M.tab === 'local') { M.local.path = it.ref; load(); }
        else { M.drive.q = ''; M.drive.stack.push({ id: it.ref, name: it.name }); load(); }
    }
    function updateAttachBtn() {
        var n = Object.keys(M.sel).length, b = $('nw-att'); if (!b) return;
        b.disabled = !n || M.busy; b.textContent = n ? ('附加 ' + n + ' 個檔案') : '附加所選檔案';
    }
    async function attachOne(f) {
        if (f.size != null && f.size > MAX_ATTACH) { toast('⚠️「' + f.name + '」超過 10MB，已略過'); return false; }
        var x = f.kind === 'local' ? await localBlob(f) : await driveBlob({ ref: f.ref, name: f.name, mime: f.mime });
        if (x.blob.size > MAX_ATTACH) { toast('⚠️「' + x.name + '」超過 10MB，已略過'); return false; }
        var file = new File([x.blob], x.name, { type: x.blob.type && x.blob.type !== 'application/octet-stream' ? x.blob.type : guessMime(x.name) });
        if (typeof window.handleChatFileSelect !== 'function') throw new Error('找不到附件功能（handleChatFileSelect）');
        await window.handleChatFileSelect({ target: { files: [file] } });
        return true;
    }
    async function attachSelected() {
        var list = Object.keys(M.sel).map(function (k) { return M.sel[k]; }); if (!list.length || M.busy) return;
        M.busy = true; updateAttachBtn(); var ok = 0;
        for (var i = 0; i < list.length; i++) {
            msg('處理中（' + (i + 1) + '/' + list.length + '）：' + list[i].name + '…');
            try { if (await attachOne(list[i])) ok++; } catch (e) { toast('❌ 附加「' + list[i].name + '」失敗：' + errText(e)); }
        }
        M.busy = false; M.sel = {}; renderList();
        msg(ok === list.length ? ('✅ 已附加 ' + ok + ' 個檔案') : ('完成：成功 ' + ok + ' / ' + list.length + ' 個'), ok ? 'ok' : 'err');
        if (ok) { toast('📎 已附加 ' + ok + ' 個檔案'); closeModal(); }
    }
    function makeFolder() {
        var t = curTarget();
        askText('新資料夾名稱（建立在「' + t.name + '」底下）', '').then(function (name) {
            if (!name) return;
            msg('建立中…');
            var p = t.kind === 'local' ? localMkdir((t.ref ? t.ref + '/' : '') + name.replace(/[\\/:*?"<>|]/g, '_')) : driveMkdir(name, t.ref);
            return Promise.resolve(p).then(function () { msg('✅ 已建立：' + name, 'ok'); load(); }).catch(function (e) { msg('❌ 建立失敗：' + errText(e), 'err'); });
        });
    }
    function askText(title, def) {
        return new Promise(function (resolve) {
            var host = modalEl().querySelector('.nw-win'), old = host.querySelector('.nw-dlg'); if (old) old.remove();
            var d = document.createElement('div'); d.className = 'nw-dlg';
            d.innerHTML = '<div><h4>' + esc(title) + '</h4><input type="text" id="nw-dlg-in" maxlength="150" autocomplete="off"><div class="row"><button class="nw-btn" id="nw-dlg-no">取消</button><button class="nw-btn pri" id="nw-dlg-ok">確定</button></div></div>';
            host.appendChild(d);
            var inp = d.querySelector('#nw-dlg-in'); inp.value = def || '';
            function done(v) { d.remove(); resolve(v && String(v).trim() ? String(v).trim() : null); }
            d.querySelector('#nw-dlg-ok').onclick = function () { done(inp.value); };
            d.querySelector('#nw-dlg-no').onclick = function () { done(null); };
            d.addEventListener('click', function (e) { if (e.target === d) done(null); });
            inp.onkeydown = function (e) { e.stopPropagation(); if (e.key === 'Enter') done(inp.value); else if (e.key === 'Escape') done(null); };
            setTimeout(function () { inp.focus(); inp.select(); }, 30);
        });
    }
    async function uploadFiles(files) {
        var t = curTarget(), ok = 0;
        for (var i = 0; i < files.length; i++) {
            var f = files[i]; msg('上傳中（' + (i + 1) + '/' + files.length + '）：' + f.name + '…');
            try {
                if (t.kind === 'local') {
                    if (f.size > 50 * 1024 * 1024) throw new Error('超過 50MB');
                    await localWriteBlob((t.ref ? t.ref + '/' : '') + f.name.replace(/[\\/:*?"<>|]/g, '_'), f);
                } else {
                    await driveUpload(f, f.name, f.type || 'application/octet-stream', { parent: t.ref === 'root' ? undefined : t.ref });
                }
                ok++;
            } catch (e) { msg('❌ ' + f.name + '：' + errText(e), 'err'); }
        }
        msg('✅ 上傳完成 ' + ok + ' / ' + files.length + ' 個', ok ? 'ok' : 'err'); load();
    }

    // ───────────────────────── 對話切換監看 ─────────────────────────
    var _lastSid = null;
    setInterval(function () {
        var s = sid();
        if (s !== _lastSid) { _lastSid = s; _lastBtnSig = ''; refreshButton(); if (popOpen()) renderPopover(); }
        else refreshButton();   // 按鈕可能在 DOM 之後才出現／被重繪
    }, 700);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && $('nova-ws-modal') && !$('nova-ws-modal').classList.contains('nw-hidden') && M.tab === 'local' && !LM.full) { M.local.path = ''; load(true); } });
    window.addEventListener('resize', function () { if (popOpen()) placePop(); });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { ensureStyle(); refreshButton(); }); else { ensureStyle(); setTimeout(refreshButton, 0); }
    registerTools();

    window.NovaWorkspace = {
        version: '1.1.0',
        togglePopover: togglePopover,
        open: openModal,
        getFolders: function () { return folders().map(function (f) { return Object.assign({}, f); }); },
        hasFolders: function () { return folders().length > 0; },
        promptAddon: promptAddon,
        applyDriveDefaults: applyDriveDefaults,
        _debug: { store: store, M: M, listTools: listTools, driveReadText: driveReadText, localList: localList }
    };
})();

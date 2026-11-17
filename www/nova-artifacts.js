/*
  ════════════════════════════════════════════════════════════════
  nova-artifacts.js — NOVA Android：Canvas 作品庫（保存、版本、局部修改、作品內呼叫 AI、匯出、本機備份、雲端同步）
  ════════════════════════════════════════════════════════════════
  目前版本：v1.0.0（Android）
  最後更新：2026-11-18（App v2.6.152）
  對標桌面 nova-artifacts.js v1.1.0（nova-desktop/src，2026-11-17）；作品庫、版本、nova-edit 局部修改、nova.ask／nova.store 橋接、雲端同步的程式與桌面相同。

  版本紀錄（只記這個檔案自己的變更）：
  v1.0.0 - App v2.6.152 新增（使用者要求：移植 nova-desktop 的 Canvas 作品庫）。借鏡 Claude 的 Artifact，建在 NOVA 原有的 Canvas 上（搭配 nova-app-main.js v1.5.11 的 Canvas 掛勾）：
           ① 作品庫：Canvas 每次開啟的程式碼都存成「作品」（IndexedDB nova-artifacts，跨對話保留）；同一段程式碼不重複存。「+」選單「作品庫」與 Canvas 的作品列都能開：
              搜尋、釘選、改名、匯出、刪除。
           ② 版本：Canvas 開著時 AI 再產生的程式碼算成目前作品的新版本；程式碼裡有「nova-artifact:編號」標記時，不管 Canvas 有沒有開都會歸到那個作品。每個作品最多 50 版。
           ③ 局部修改：AI 用 ```nova-edit 區塊（SEARCH／REPLACE）只改需要改的幾行；任何一段找不到就整批不套用並顯示「請 AI 整份重寫」。只對 15 分鐘內的 AI 回覆自動套用。
           ④ 作品內呼叫 AI 與保存資料：nova.ask(提示詞, {json, search, system})、nova.store.get／set／remove／keys；第一次呼叫 AI 前先問你同不同意；5 分鐘最多 20 次、每個作品 512KB。
           ⑤ 匯出：「可直接開的 HTML」與「原始碼」，存到 Documents/NOVA/作品庫/匯出/ 並跳出分享面板。
           ⑥ 本機備份：作品有變動約 2 秒後寫 Documents/NOVA/作品庫/<作品名>_<編號>.<副檔名>（最新版原始碼）與 _資料/<編號>.json（完整作品，還原用）；
              作品庫可「從備份還原」。雲端：NovaDataSync 供應者 'artifacts'（Google Drive 的 NOVA_Artifacts_Sync.json，跟桌面同一個檔案、互通），
              子開關在 Google 整合 → Drive 同步 → 其他資料同步。
           【和桌面版不同的地方】
           ・Python：手機沒有 NOVA Python 引擎，Canvas 的 Python 照舊用瀏覽器內的 Pyodide（shouldUseRealPython 在手機上永遠回 false）。
           ・檔案存取用 Capacitor Filesystem 模擬桌面的 Tauri 檔案介面（同 nova-drawio.js v1.1.0），路徑在手機的 Documents 底下。
           ・Canvas 的作品列（版本切換、釘選、匯出、作品庫）放在 Canvas 標題列下方另起一列（手機標題列放不下）；改名用 NOVA 的輸入框。
           【限制】Canvas 的 iframe 原本就開了 allow-same-origin，作品程式碼理論上碰得到主視窗；nova.ask 只是正規管道，不是安全隔離。只在電腦瀏覽器用模擬環境測過，未在真機驗證。
  ════════════════════════════════════════════════════════════════
*/
(function () {
    'use strict';
    if (window.NovaArtifacts) return;

    var DB_NAME = 'nova-artifacts', STORE = 'artifacts', MAX_VERSIONS = 50, KV_LIMIT = 512 * 1024;
    var LS_EDITS = 'nova_artifact_edits';
    var CUR = { id: null, vIdx: -1, art: null, lang: 'html', suppress: false };
    var _cache = null;   // 記憶體裡的作品清單（啟動時載入）

    // ─────────────────────────── 小工具 ───────────────────────────
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function hashText(t) { var h = 5381, s = String(t || '').replace(/\s+$/g, ''); for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return 'h' + (h >>> 0).toString(36) + s.length.toString(36); }
    function newId() { return (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).slice(-10); }
    function toast(m, ms) { try { if (typeof window.showToast === 'function') window.showToast(m, ms || 3000); else console.log('[NovaArtifacts]', m); } catch (e) { /* */ } }
    function markerOf(code) { var m = /nova-artifact:\s*([a-z0-9]{6,16})/i.exec(String(code || '').slice(0, 600)); return m ? m[1].toLowerCase() : null; }
    function stripMarker(code) { return String(code || '').replace(/^[ \t]*(<!--\s*nova-artifact:[^>]*-->|\/\*\s*nova-artifact:[^*]*\*\/|\/\/\s*nova-artifact:.*|#\s*nova-artifact:.*)[ \t]*\r?\n?/im, ''); }
    function normLang(l) { l = String(l || 'html').toLowerCase(); return ({ js: 'javascript', py: 'python', ts: 'typescript' })[l] || l; }
    function extOf(lang) { return ({ html: 'html', css: 'css', javascript: 'js', jsx: 'jsx', tsx: 'tsx', typescript: 'ts', python: 'py', vue: 'vue', svelte: 'svelte', sql: 'sql' })[normLang(lang)] || 'txt'; }
    function titleFrom(code, lang) {
        var s = String(code || '');
        var m = /<title[^>]*>([^<]{1,80})<\/title>/i.exec(s) || /<h1[^>]*>([^<]{1,80})<\/h1>/i.exec(s);
        if (m && m[1].trim()) return m[1].trim();
        m = /^\s*(?:\/\/|#|<!--|\/\*)\s*(?!nova-artifact)([^\n]{3,60}?)\s*(?:-->|\*\/)?\s*$/m.exec(s.slice(0, 400));
        if (m && m[1].trim()) return m[1].trim();
        m = /(?:function|const|class)\s+([A-Z][A-Za-z0-9_]{2,40})/.exec(s);
        if (m) return m[1];
        var d = new Date();
        return normLang(lang).toUpperCase() + ' 作品 ' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    }

    // ─────────────────────────── IndexedDB ───────────────────────────
    var _dbp = null;
    function db() {
        if (_dbp) return _dbp;
        _dbp = new Promise(function (res, rej) {
            var rq = indexedDB.open(DB_NAME, 1);
            rq.onupgradeneeded = function () { var d = rq.result; if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' }); };
            rq.onsuccess = function () { res(rq.result); };
            rq.onerror = function () { rej(rq.error); };
        });
        return _dbp;
    }
    function tx(mode, fn) {
        return db().then(function (d) {
            return new Promise(function (res, rej) {
                var t = d.transaction(STORE, mode), st = t.objectStore(STORE), out;
                out = fn(st);
                t.oncomplete = function () { res(out && out.result !== undefined ? out.result : out); };
                t.onerror = function () { rej(t.error); };
                t.onabort = function () { rej(t.error); };
            });
        });
    }
    async function loadAll() {
        if (_cache) return _cache;
        try {
            var all = await tx('readonly', function (st) { return st.getAll(); });
            _cache = {}; (all || []).forEach(function (a) { _cache[a.id] = a; });
        } catch (e) { _cache = {}; }
        return _cache;
    }
    async function save(a) { a.updated = Date.now(); (await loadAll())[a.id] = a; try { await tx('readwrite', function (st) { return st.put(a); }); } catch (e) { toast('作品庫存檔失敗：' + (e && e.message || e)); } bkMark(a.id); syncTouch(); return a; }
    async function putRaw(a) { (await loadAll())[a.id] = a; await tx('readwrite', function (st) { return st.put(a); }); return a; }   // v1.1.0：不改 updated（同步／還原用）
    async function get(id) { return (await loadAll())[id] || null; }
    async function remove(id, opts) { var c = await loadAll(); delete c[id]; try { await tx('readwrite', function (st) { return st.delete(id); }); } catch (e) { /* */ } bkTrash(id); if (!(opts && opts.fromSync)) syncTouch(); }
    function syncTouch() { try { if (window.NovaDataSync && window.NovaDataSync.touch) window.NovaDataSync.touch(); } catch (e) { /* */ } }

    // ─────────────────────────── v1.1.0：本機備份（Documents\NOVA\作品庫）───────────────────────────
    var BK = { dir: null, data: null, index: null, dirty: {}, timer: null, chain: Promise.resolve(), last: 0, err: '' };
    // ─────────────────────────── Android：Capacitor Filesystem 模擬 Tauri 檔案介面（同 nova-drawio.js v1.1.0）───────────────────────────
    var CAPFS = null, DOC = '@DOC';
    function u8ToB64(u8) { var bin = '', CH = 0x8000; for (var i = 0; i < u8.length; i += CH) bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return btoa(bin); }
    function capfs() {
        if (CAPFS) return CAPFS;
        var C = window.Capacitor, P = C && C.Plugins, FS = P && P.Filesystem;
        if (!FS || !(C.isNativePlatform && C.isNativePlatform())) return null;
        var rel = function (p) { p = String(p || ''); return (p.indexOf(DOC) === 0 ? p.slice(DOC.length) : p).replace(/^\/+/, ''); };
        var o = function (p, extra) { return Object.assign({ path: rel(p), directory: 'DOCUMENTS' }, extra || {}); };
        CAPFS = {
            android: true, FS: FS,
            path: { documentDir: async function () { return DOC; }, join: async function () { return Array.prototype.slice.call(arguments).join('/').replace(/\/+/g, '/'); } },
            fs: {
                mkdir: async function (p) { try { await FS.mkdir(o(p, { recursive: true })); } catch (e) { if (!/exist/i.test(String(e && e.message || e))) throw e; } },
                writeTextFile: function (p, t) { return FS.writeFile(o(p, { data: String(t), encoding: 'utf8', recursive: true })); },
                writeFile: function (p, bytes) { return FS.writeFile(o(p, { data: u8ToB64(bytes), recursive: true })); },
                readTextFile: async function (p) { var r = await FS.readFile(o(p, { encoding: 'utf8' })); return r.data; },
                remove: function (p) { return FS.deleteFile(o(p)); },
                rename: function (a, b) { return FS.rename({ from: rel(a), to: rel(b), directory: 'DOCUMENTS', toDirectory: 'DOCUMENTS' }); }
            },
            uri: async function (p) { var r = await FS.getUri(o(p)); return r.uri; }
        };
        return CAPFS;
    }
    function shown(p) { return p ? String(p).replace(DOC, 'Documents') : p; }   // 給人看的路徑
    async function shareFile(p, title) {   // 跳出分享面板（取消分享無妨）
        var A = capfs(), SH = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Share;
        if (!A || !SH || !p) return false;
        try { var u = await A.uri(p); await SH.share({ title: title || '作品', files: [u], dialogTitle: '分享（檔案已存在 ' + shown(p).replace(/\/[^/]*$/, '') + '）' }); return true; }
        catch (e) { if (/cancel/i.test(String(e && e.message || e))) return true; throw e; }
    }

    function tfs() { var T = window.__TAURI__; return (T && T.fs && T.path && typeof T.path.documentDir === 'function') ? T : capfs(); }
    function safeName(t) { return String(t || '作品').replace(/[\\/:*?"<>|\r\n]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 50) || '作品'; }
    async function bkDirs() {
        var T = tfs(); if (!T) return null;
        if (!BK.dir) {
            var d = await T.path.join(await T.path.documentDir(), 'NOVA', '作品庫'), dd = await T.path.join(d, '_資料');
            try { await T.fs.mkdir(dd, { recursive: true }); } catch (e) { /* 已存在 */ }
            BK.dir = d; BK.data = dd;
        }
        return { dir: BK.dir, data: BK.data };
    }
    async function bkIndex() {
        if (BK.index) return BK.index;
        var T = tfs(), D = await bkDirs(); if (!D) return {};
        var idx = {}; try { idx = JSON.parse(await T.fs.readTextFile(await T.path.join(D.data, '_index.json'))) || {}; } catch (e) { idx = {}; }
        BK.index = idx; return idx;
    }
    function bkMark(id) { if (!tfs() || !id) return; BK.dirty[id] = 1; clearTimeout(BK.timer); BK.timer = setTimeout(bkFlush, 2000); }
    function bkFlush() {
        BK.chain = BK.chain.then(async function () {
            var T = tfs(); if (!T) return;
            var ids = Object.keys(BK.dirty); BK.dirty = {}; if (!ids.length) return;
            try {
                var D = await bkDirs(), idx = await bkIndex(), c = await loadAll();
                for (var i = 0; i < ids.length; i++) {
                    var id = ids[i], a = c[id]; if (!a || !a.versions || !a.versions.length) continue;
                    var src = safeName(a.title) + '_' + id + '.' + extOf(a.lang), old = idx[id];
                    await T.fs.writeTextFile(await T.path.join(D.data, id + '.json'), JSON.stringify(Object.assign({ __nova: 'artifact', v: 1 }, a)));
                    await T.fs.writeTextFile(await T.path.join(D.dir, src), latest(a).code);
                    if (old && old.src && old.src !== src) { try { await T.fs.remove(await T.path.join(D.dir, old.src)); } catch (e) { /* */ } }
                    idx[id] = { title: a.title, lang: a.lang, src: src, updated: a.updated || 0, versions: a.versions.length };
                }
                await T.fs.writeTextFile(await T.path.join(D.data, '_index.json'), JSON.stringify(idx));
                BK.last = Date.now(); BK.err = '';
            } catch (e) {
                BK.err = String(e && e.message || e).slice(0, 160);
                ids.forEach(function (k) { BK.dirty[k] = 1; });
                console.warn('[NovaArtifacts] 本機備份失敗：', e);
            }
        });
        return BK.chain;
    }
    function bkTrash(id) {
        if (BK.dirty[id]) delete BK.dirty[id];
        BK.chain = BK.chain.then(async function () {
            var T = tfs(); if (!T) return;
            try {
                var D = await bkDirs(), idx = await bkIndex(), it = idx[id];
                var td = await T.path.join(D.data, '_已刪除'); try { await T.fs.mkdir(td, { recursive: true }); } catch (e) { /* */ }
                try { await T.fs.rename(await T.path.join(D.data, id + '.json'), await T.path.join(td, id + '_' + Date.now() + '.json')); } catch (e) { /* 沒有備份檔 */ }
                if (it && it.src) { try { await T.fs.remove(await T.path.join(D.dir, it.src)); } catch (e) { /* */ } }
                if (it) { delete idx[id]; await T.fs.writeTextFile(await T.path.join(D.data, '_index.json'), JSON.stringify(idx)); }
            } catch (e) { /* */ }
        });
        return BK.chain;
    }
    function validArt(a) { return a && typeof a === 'object' && a.id && Array.isArray(a.versions) && a.versions.length && a.versions.every(function (v) { return v && typeof v.code === 'string'; }); }
    // 備份裡有、本機沒有（或備份較新）→ 讀回；本機有、備份沒有（或較舊）→ 補寫
    async function bkRestore() {
        if (!tfs()) return { restored: 0 };
        await BK.chain;
        var T = tfs(), D = await bkDirs(), c = await loadAll(), restored = 0;
        BK.index = null;
        var idx = await bkIndex();
        var ids = Object.keys(idx);
        for (var i = 0; i < ids.length; i++) {
            var id = ids[i], loc = c[id];
            if (loc && (loc.updated || 0) >= (idx[id].updated || 0)) continue;
            try {
                var a = JSON.parse(await T.fs.readTextFile(await T.path.join(D.data, id + '.json')));
                if (!validArt(a) || a.id !== id) continue;
                delete a.__nova; delete a.v;
                if (loc) a.aiAllowed = loc.aiAllowed;
                a.kv = a.kv || {};
                await putRaw(a); restored++;
            } catch (e) { /* 單一檔案壞掉不影響其他 */ }
        }
        Object.keys(c).forEach(function (id) { var a = c[id]; if (!idx[id] || (idx[id].updated || 0) < (a.updated || 0)) bkMark(id); });
        return { restored: restored };
    }
    async function openFolder() {
        var T = tfs(), D = await bkDirs();
        if (!T || !D) { toast('這個環境沒有本機檔案備份（只有雲端同步）'); return; }
        if (T.android) { toast('📁 作品自動備份在：' + shown(D.dir) + '（可用檔案管理員開啟）', 6000); return; }
        try { if (T.opener && T.opener.openPath) await T.opener.openPath(D.dir); else await T.opener.revealItemInDir(D.dir); } catch (e) { toast('備份資料夾：' + D.dir, 6000); }
    }

    // ─────────────────────────── v1.1.0：雲端同步（NovaDataSync 供應者 'artifacts'）───────────────────────────
    function syncValue(a) { return { id: a.id, title: a.title, lang: a.lang, created: a.created || 0, updated: a.updated || 0, pinned: !!a.pinned, sessionId: a.sessionId || '', versions: a.versions, kv: a.kv || {} }; }
    function mergeArt(a, b) {   // a＝本機、b＝遠端
        var n = (b.updated || 0) > (a.updated || 0) ? b : a, o = n === a ? b : a, seen = {}, vs = [];
        (o.versions || []).concat(n.versions || []).forEach(function (v) { var h = v.hash || hashText(v.code); if (!seen[h]) { seen[h] = 1; vs.push(v); } });
        vs.sort(function (x, y) { return (x.t || 0) - (y.t || 0); });
        if (vs.length > MAX_VERSIONS) vs = vs.slice(vs.length - MAX_VERSIONS);
        return Object.assign({}, o, n, { versions: vs, kv: Object.assign({}, o.kv || {}, n.kv || {}), created: Math.min(a.created || b.created || 0, b.created || a.created || 0), updated: Math.max(a.updated || 0, b.updated || 0) });
    }
    async function syncCollect() { var c = await loadAll(), L = {}; Object.keys(c).forEach(function (id) { if (validArt(c[id])) L[id] = syncValue(c[id]); }); return L; }
    async function syncApply(put, del) {
        var c = await loadAll(), ids = Object.keys(put || {});
        for (var i = 0; i < ids.length; i++) {
            var v = put[ids[i]]; if (!validArt(v)) continue;
            var loc = c[ids[i]], a = Object.assign({}, v, { kv: v.kv || {}, aiAllowed: loc ? loc.aiAllowed : null });
            await putRaw(a); bkMark(a.id);
            if (CUR.id === a.id) { try { setCurrent(a, Math.min(CUR.vIdx < 0 ? a.versions.length - 1 : CUR.vIdx, a.versions.length - 1), a.lang); } catch (e) { /* */ } }
        }
        for (var j = 0; j < (del || []).length; j++) { await remove(del[j], { fromSync: true }); if (CUR.id === del[j]) { try { setCurrent(null, -1); } catch (e) { /* */ } } }
    }
    var _regDone = false;
    function regSync() {
        var ds = window.NovaDataSync;
        if (_regDone || !ds || typeof ds.register !== 'function') return;
        _regDone = true;
        ds.register({
            id: 'artifacts', label: 'Canvas 作品庫', file: 'NOVA_Artifacts_Sync.json',
            merge: function (k, a, b) { return mergeArt(a, b); },
            collect: syncCollect,
            apply: async function (x) { await syncApply(x.put || {}, x.del || []); },
            after: function () { try { if (document.getElementById('nart-lib-ov') && _libRender) _libRender(); window.dispatchEvent(new CustomEvent('nova-artifacts-synced')); } catch (e) { /* */ } }
        });
    }
    async function syncNow() {
        var ds = window.NovaDataSync; if (!ds) { toast('同步模組沒有載入'); return null; }
        regSync();
        try {
            var r = await ds.sync('artifacts', { device: 'android' });
            toast('作品庫' + (r.skipped ? (r.skipped === 'disabled' ? '雲端同步已關閉（Google 整合 → Drive 同步 → Canvas 作品庫）' : '：' + (r.text || '這次略過')) : '雲端同步完成：' + (r.text || '沒有變動')), 5000);
            return r;
        } catch (e) { toast('作品庫雲端同步失敗：' + (e && e.message || e), 6000); return { error: String(e && e.message || e) }; }
    }
    var _libRender = null;
    async function list() {
        var c = await loadAll();
        return Object.keys(c).map(function (k) { return c[k]; }).sort(function (a, b) { return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updated - a.updated; });
    }

    // ─────────────────────────── 作品／版本 ───────────────────────────
    function latest(a) { return a.versions[a.versions.length - 1]; }
    async function findByHash(h) {
        var c = await loadAll();
        for (var k in c) { var a = c[k]; for (var i = a.versions.length - 1; i >= 0; i--) if (a.versions[i].hash === h) return { art: a, idx: i }; }
        return null;
    }
    async function create(code, lang, meta) {
        meta = meta || {};
        var a = { id: newId(), title: meta.title || titleFrom(code, lang), lang: normLang(lang), created: Date.now(), updated: Date.now(), pinned: false,
            sessionId: meta.sessionId || (window.appState && appState.currentSessionId) || '', versions: [], kv: {}, aiAllowed: null };
        a.versions.push({ code: code, hash: hashText(code), t: Date.now(), note: meta.note || '建立', source: meta.source || 'ai' });
        return save(a);
    }
    async function addVersion(a, code, note, source) {
        var h = hashText(code);
        if (latest(a).hash === h) return { art: a, idx: a.versions.length - 1, same: true };
        a.versions.push({ code: code, hash: h, t: Date.now(), note: note || '修改', source: source || 'ai' });
        if (a.versions.length > MAX_VERSIONS) a.versions.splice(0, a.versions.length - MAX_VERSIONS);
        await save(a);
        return { art: a, idx: a.versions.length - 1 };
    }

    // Canvas 開啟／更新時決定這段程式碼屬於哪個作品
    async function register(code, lang, opts) {
        opts = opts || {};
        var mk = markerOf(code);
        if (mk) { var am = await get(mk); if (am) return addVersion(am, code, opts.note || 'AI 修改', 'ai'); }
        var h = hashText(code);
        var f = await findByHash(h);
        if (f) return { art: f.art, idx: f.idx, same: true };
        if (opts.asVersionOf) { var av = await get(opts.asVersionOf); if (av) return addVersion(av, code, opts.note || 'AI 修改', 'ai'); }
        var a = await create(code, lang, { note: '建立' });
        if (mk && mk !== a.id) { /* AI 寫了不存在的編號 → 照樣建立新作品 */ }
        return { art: a, idx: 0 };
    }

    // ─────────────────────────── Canvas 掛勾 ───────────────────────────
    // nova-app-main.js 的 novaCanvas.open／streamUpdate 會呼叫這兩個函式
    var _streamT = null;
    function onCanvasOpen(code, lang) {
        if (CUR.suppress) { CUR.suppress = false; updateHeader(); return; }
        var wasOpenId = CUR.id;
        register(code, lang, {}).then(function (r) { setCurrent(r.art, r.idx, lang); }).catch(function () { /* */ });
        return wasOpenId;
    }
    function onCanvasStream(code, lang) {
        clearTimeout(_streamT);
        var base = CUR.id;
        _streamT = setTimeout(function () {
            // Canvas 開著時 AI 再產生的程式碼 → 目前作品的新版本
            register(code, lang, { asVersionOf: base, note: 'AI 更新' }).then(function (r) { setCurrent(r.art, r.idx, lang); }).catch(function () { /* */ });
        }, 1500);
    }
    // AI 回覆完成：有 nova-artifact 標記的程式碼區塊，不管 Canvas 有沒有開都歸到該作品
    function onAiMessage(text) {
        var re = /```([a-zA-Z0-9]+)[ \t]*\r?\n([\s\S]*?)```/g, m;
        while ((m = re.exec(String(text || '')))) {
            var code = m[2].replace(/\n$/, ''), mk = markerOf(code);
            if (!mk) continue;
            (function (c, l) {
                get(markerOf(c)).then(function (a) { if (a) addVersion(a, c, 'AI 修改', 'ai').then(function (r) { if (CUR.id === a.id) { setCurrent(r.art, r.idx, l); } }); });
            })(code, m[1]);
        }
    }
    function setCurrent(a, idx, lang) {
        CUR.id = a ? a.id : null; CUR.art = a; CUR.vIdx = idx; CUR.lang = normLang(lang || (a && a.lang));
        try { if (window.appState) appState._novaArtifactActive = { id: CUR.id, t: Date.now(), sessionId: appState.currentSessionId }; } catch (e) { /* */ }
        updateHeader();
    }
    function showVersion(idx) {
        var a = CUR.art; if (!a || idx < 0 || idx >= a.versions.length) return;
        CUR.vIdx = idx; CUR.suppress = true;
        try { window.novaCanvas.open(a.versions[idx].code, a.lang); } catch (e) { CUR.suppress = false; }
        updateHeader();
    }
    async function openArtifact(id, idx) {
        var a = await get(id); if (!a) { toast('找不到這個作品'); return; }
        var i = idx == null ? a.versions.length - 1 : idx;
        CUR.id = a.id; CUR.art = a; CUR.vIdx = i; CUR.suppress = true;
        try { window.novaCanvas.open(a.versions[i].code, a.lang); } catch (e) { CUR.suppress = false; }
        updateHeader();
    }

    // ─────────────────────────── Canvas 標題列 ───────────────────────────
    var BTN = 'display:flex;align-items:center;justify-content:center;gap:4px;height:34px;min-width:34px;padding:0 8px;border-radius:9px;background:#f3f4f6;color:#374151;border:1px solid #e5e7eb;cursor:pointer;font-size:11px;font-weight:700;';
    function ensureHeader() {
        if (document.getElementById('nart-bar')) return true;
        var hdr = document.getElementById('nova-canvas-header');
        if (!hdr || !hdr.parentNode) return false;
        var bar = document.createElement('div');
        bar.id = 'nart-bar';   // 手機：標題列放不下，另起一列放在標題列下方
        bar.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 12px;background:#ffffff;border-bottom:1px solid #e5e7eb;flex-shrink:0;overflow-x:auto;-webkit-overflow-scrolling:touch';
        bar.innerHTML =
            '<button id="nart-prev" title="上一個版本" style="' + BTN + '"><i class="ph-bold ph-caret-left"></i></button>'
            + '<span id="nart-ver" style="font-size:11px;color:#6b7280;min-width:52px;text-align:center;flex:none"></span>'
            + '<button id="nart-next" title="下一個版本" style="' + BTN + '"><i class="ph-bold ph-caret-right"></i></button>'
            + '<span style="flex:1"></span>'
            + '<button id="nart-pin" title="釘選到作品庫最上面" style="' + BTN + '"><i class="ph-bold ph-push-pin"></i></button>'
            + '<button id="nart-export" title="匯出" style="' + BTN + '"><i class="ph-bold ph-download-simple"></i><span>匯出</span></button>'
            + '<button id="nart-lib" title="作品庫" style="' + BTN + '"><i class="ph-bold ph-books"></i><span>作品庫</span></button>';
        hdr.parentNode.insertBefore(bar, hdr.nextSibling);
        Array.prototype.forEach.call(bar.querySelectorAll('button'), function (b) { b.style.flex = 'none'; });
        document.getElementById('nart-prev').onclick = function () { showVersion(CUR.vIdx - 1); };
        document.getElementById('nart-next').onclick = function () { showVersion(CUR.vIdx + 1); };
        document.getElementById('nart-pin').onclick = async function () { if (!CUR.art) return; CUR.art.pinned = !CUR.art.pinned; await save(CUR.art); updateHeader(); toast(CUR.art.pinned ? '已釘選' : '已取消釘選'); };
        document.getElementById('nart-export').onclick = function (e) { exportMenu(e.currentTarget); };
        document.getElementById('nart-lib').onclick = function () { openLibrary(); };
        var t = document.getElementById('nova-canvas-title');
        if (t) { t.style.cursor = 'text'; t.title = '點一下重新命名'; t.onclick = renameInline; }
        return true;
    }
    function updateHeader() {
        if (!ensureHeader()) return;
        var a = CUR.art, n = a ? a.versions.length : 0;
        var t = document.getElementById('nova-canvas-title');
        if (t && a) t.textContent = a.title;
        var v = document.getElementById('nart-ver'); if (v) v.textContent = a ? ('版本 ' + (CUR.vIdx + 1) + '/' + n) : '';
        var p = document.getElementById('nart-prev'), nx = document.getElementById('nart-next');
        if (p) { p.disabled = !a || CUR.vIdx <= 0; p.style.opacity = p.disabled ? '.4' : '1'; }
        if (nx) { nx.disabled = !a || CUR.vIdx >= n - 1; nx.style.opacity = nx.disabled ? '.4' : '1'; }
        var pin = document.getElementById('nart-pin'); if (pin) { pin.style.background = a && a.pinned ? '#fde68a' : '#f3f4f6'; }
        var st = document.getElementById('nova-canvas-status');
        if (st && a && a.versions[CUR.vIdx]) st.setAttribute('title', a.versions[CUR.vIdx].note + '・' + new Date(a.versions[CUR.vIdx].t).toLocaleString('zh-TW'));
    }
    function renameInline() {
        var t = document.getElementById('nova-canvas-title'); if (!t || !CUR.art) return;
        var inp = document.createElement('input');
        inp.value = CUR.art.title; inp.style.cssText = 'font-size:13px;font-weight:700;color:#111827;width:100%;border:1px solid #93c5fd;border-radius:6px;padding:2px 6px';
        t.style.display = 'none'; t.parentNode.insertBefore(inp, t); inp.focus(); inp.select();
        var done = async function (ok) {
            if (inp._done) return; inp._done = true;
            if (ok && inp.value.trim() && CUR.art) { CUR.art.title = inp.value.trim().slice(0, 80); await save(CUR.art); }
            inp.remove(); t.style.display = ''; updateHeader();
        };
        inp.onkeydown = function (e) { if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); };
        inp.onblur = function () { done(true); };
    }

    // ─────────────────────────── 匯出 ───────────────────────────
    async function saveText(name, text, mime) {
        var A = capfs();
        if (A) {   // 手機：寫到 Documents/NOVA/作品庫/匯出/ 再跳分享面板
            var d0 = new Date(), pz = function (n) { return ('0' + n).slice(-2); };
            var dir = DOC + '/NOVA/作品庫/匯出', nm = String(name).replace(/(\.[^.]+)$/, '_' + d0.getFullYear() + pz(d0.getMonth() + 1) + pz(d0.getDate()) + '_' + pz(d0.getHours()) + pz(d0.getMinutes()) + '$1');
            try { await A.fs.mkdir(dir); } catch (e) { /* */ }
            var p = dir + '/' + nm.replace(/[\\/:*?"<>|\r\n]/g, '_');
            await A.fs.writeTextFile(p, text);
            try { await shareFile(p, name); } catch (e) { console.warn('[NovaArtifacts] 分享失敗：', e); }
            return shown(p);
        }
        var T = window.__TAURI__;
        if (T && T.dialog && T.fs && typeof T.dialog.save === 'function') {
            var ext = name.split('.').pop();
            var dest = await T.dialog.save({ title: '匯出作品', defaultPath: name, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
            if (!dest) return false;
            await T.fs.writeTextFile(dest, text); return dest;
        }
        var blob = new Blob([text], { type: mime || 'text/plain' }), url = URL.createObjectURL(blob), a = document.createElement('a');
        a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
        return true;
    }
    function baseName(a) { return String((a && a.title) || '作品').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 60) || '作品'; }
    async function exportHtml(a, idx) {
        a = a || CUR.art; if (!a) return;
        var code = a.versions[idx == null ? (a === CUR.art ? CUR.vIdx : a.versions.length - 1) : idx].code;
        var doc = null;
        if (a === CUR.art && window._novaCanvasLastDocRaw && (idx == null || idx === CUR.vIdx)) doc = window._novaCanvasLastDocRaw;   // Canvas 實際顯示的完整頁面（React 已內嵌）
        else if (a.lang === 'html') doc = /<!DOCTYPE|<html/i.test(code) ? code : '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + esc(a.title) + '</title></head><body>' + code + '</body></html>';
        if (!doc) { toast('這個版本要先在 Canvas 開啟一次才能匯出成 HTML；或改匯出原始碼', 5000); return; }
        try { var r = await saveText(baseName(a) + '.html', stripMarker(doc), 'text/html'); toast(r ? '✅ 已匯出' + (typeof r === 'string' ? '：' + r : '') : '已取消', 4000); }
        catch (e) { toast('匯出失敗：' + (e && e.message || e), 5000); }
    }
    async function exportSource(a, idx) {
        a = a || CUR.art; if (!a) return;
        var code = a.versions[idx == null ? (a === CUR.art ? CUR.vIdx : a.versions.length - 1) : idx].code;
        try { var r = await saveText(baseName(a) + '.' + extOf(a.lang), code, 'text/plain'); toast(r ? '✅ 已匯出' + (typeof r === 'string' ? '：' + r : '') : '已取消', 4000); }
        catch (e) { toast('匯出失敗：' + (e && e.message || e), 5000); }
    }
    function exportMenu(anchor, a) {
        closePop();
        a = a || CUR.art; if (!a) return;
        var r = anchor.getBoundingClientRect();
        var m = document.createElement('div'); m.id = 'nart-pop';
        m.style.cssText = 'position:fixed;z-index:100002;top:' + (r.bottom + 4) + 'px;left:' + Math.max(8, Math.min(window.innerWidth - 228, r.right - 220)) + 'px;width:220px;background:#fff;border:1px solid #e5e7eb;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.18);padding:6px;font-size:12px;color:#111827';
        var canHtml = a.lang !== 'python';
        m.innerHTML = (canHtml ? '<button data-x="html" style="display:block;width:100%;text-align:left;padding:8px 10px;border-radius:8px;border:0;background:none;cursor:pointer">🌐 可直接開的 HTML</button>' : '')
            + '<button data-x="src" style="display:block;width:100%;text-align:left;padding:8px 10px;border-radius:8px;border:0;background:none;cursor:pointer">📄 原始碼（.' + extOf(a.lang) + '）</button>';
        document.body.appendChild(m);
        m.querySelectorAll('button').forEach(function (b) {
            b.onmouseenter = function () { b.style.background = '#f3f4f6'; }; b.onmouseleave = function () { b.style.background = 'none'; };
            b.onclick = function () { closePop(); if (b.getAttribute('data-x') === 'html') exportHtml(a); else exportSource(a); };
        });
        setTimeout(function () { document.addEventListener('mousedown', _popOut, true); }, 0);
    }
    function _popOut(e) { var p = document.getElementById('nart-pop'); if (p && !p.contains(e.target)) closePop(); }
    function closePop() { var p = document.getElementById('nart-pop'); if (p) p.remove(); document.removeEventListener('mousedown', _popOut, true); }

    // ─────────────────────────── 作品庫視窗 ───────────────────────────
    function isLight() { return document.documentElement.classList.contains('theme-light'); }
    function askText(label, def) { try { if (typeof window.novaPrompt === 'function') return Promise.resolve(window.novaPrompt(label, def)); } catch (e) { /* */ } return Promise.resolve(window.prompt ? window.prompt(label, def) : null); }
    async function openLibrary() {
        closeLibrary();
        var L = isLight(), bg = L ? '#ffffff' : '#0f172a', bd = L ? '#e2e8f0' : '#1e293b', tx = L ? '#0f172a' : '#e2e8f0', sub = L ? '#64748b' : '#94a3b8', card = L ? '#f8fafc' : '#111c33';
        var ov = document.createElement('div'); ov.id = 'nart-lib-ov';
        ov.style.cssText = 'position:fixed;inset:0;z-index:100001;background:rgba(2,6,23,.55);display:flex;align-items:center;justify-content:center;padding:calc(env(safe-area-inset-top,0px) + 10px) 10px calc(env(safe-area-inset-bottom,0px) + 10px)';
        ov.innerHTML = '<div style="width:min(860px,100%);max-height:88vh;display:flex;flex-direction:column;background:' + bg + ';color:' + tx + ';border:1px solid ' + bd + ';border-radius:16px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.4)">'
            + '<div style="display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid ' + bd + '"><span style="font-size:18px">📚</span><b style="font-size:15px;flex:1">作品庫</b>'
            + '<input id="nart-q" placeholder="搜尋…" style="flex:1;min-width:0;width:120px;padding:6px 10px;border-radius:8px;border:1px solid ' + bd + ';background:' + card + ';color:' + tx + ';font-size:12px">'
            + '<button id="nart-x" style="padding:6px 10px;border-radius:8px;border:1px solid ' + bd + ';background:none;color:' + tx + ';cursor:pointer;font-size:12px">✕ 關閉</button></div>'
            + '<div id="nart-list" style="overflow:auto;padding:12px 16px;display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px"></div>'
            + '<div style="padding:8px 16px;border-top:1px solid ' + bd + ';font-size:11px;color:' + sub + ';display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span style="flex:1;min-width:240px">Canvas 開過的程式碼都會自動存進來；同一個作品的修改會存成版本（最多 50 版）。<span id="nart-bkinfo"></span></span>'
            + ['folder:📁 備份資料夾', 'cloud:☁️ 立即同步到雲端', 'restore:⟳ 從備份還原'].map(function (x) { var p = x.split(':'); return '<button data-lib="' + p[0] + '" style="padding:4px 9px;border-radius:7px;border:1px solid ' + bd + ';background:none;color:' + tx + ';font-size:11px;cursor:pointer">' + p[1] + '</button>'; }).join('')
            + '</div></div>';
        document.body.appendChild(ov);
        ov.addEventListener('mousedown', function (e) { if (e.target === ov) closeLibrary(); });
        document.getElementById('nart-x').onclick = closeLibrary;
        var bkInfo = function () {   // v1.1.0
            var el = document.getElementById('nart-bkinfo'); if (!el) return;
            if (!tfs()) { el.textContent = '雲端備份：跨裝置同步（Google Drive）。'; return; }
            var t = BK.last ? new Date(BK.last) : null;
            el.textContent = '自動備份到「' + (tfs().android ? 'Documents/NOVA/作品庫' : '文件\\NOVA\\作品庫') + '」' + (BK.err ? '（上次失敗：' + BK.err + '）' : t ? '（上次 ' + ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2) + '）' : '') + '，並跟著 Google Drive 同步上傳（手機：Google 整合 → Drive 同步）。';
        };
        ov.querySelectorAll('[data-lib]').forEach(function (b) {
            b.onclick = async function () {
                var act = b.getAttribute('data-lib');
                if (act === 'folder') { await bkFlush(); openFolder(); }
                else if (act === 'cloud') { b.disabled = true; b.textContent = '☁️ 同步中…'; await syncNow(); b.disabled = false; b.textContent = '☁️ 立即同步到雲端'; render(); }
                else if (act === 'restore') { if (!tfs()) { toast('這個環境沒有本機備份'); return; } var r = await bkRestore(); toast(r.restored ? '已從備份還原 ' + r.restored + ' 個作品' : '備份裡沒有比這台更新的作品'); render(); }
                bkInfo();
            };
        });
        bkInfo();
        var render = async function () {
            var q = (document.getElementById('nart-q').value || '').trim().toLowerCase();
            var items = (await list()).filter(function (a) { return !q || a.title.toLowerCase().indexOf(q) >= 0 || latest(a).code.toLowerCase().indexOf(q) >= 0; });
            var box = document.getElementById('nart-list'); if (!box) return;
            if (!items.length) { box.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:' + sub + ';font-size:13px">' + (q ? '沒有符合的作品' : '還沒有作品。在對話裡請 AI 做網頁、小工具、互動圖表，打開 Canvas 就會自動存進來。') + '</div>'; return; }
            box.innerHTML = items.map(function (a) {
                var d = new Date(a.updated);
                return '<div data-id="' + esc(a.id) + '" style="border:1px solid ' + bd + ';border-radius:12px;background:' + card + ';padding:10px 12px;display:flex;flex-direction:column;gap:6px">'
                    + '<div style="display:flex;align-items:center;gap:6px"><b style="flex:1;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(a.title) + '">' + (a.pinned ? '📌 ' : '') + esc(a.title) + '</b>'
                    + '<span style="font-size:10px;padding:1px 6px;border-radius:6px;border:1px solid ' + bd + ';color:' + sub + '">' + esc(a.lang.toUpperCase()) + '</span></div>'
                    + '<div style="font-size:11px;color:' + sub + '">' + a.versions.length + ' 個版本・' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + (a.kv && Object.keys(a.kv).length ? '・有保存資料' : '') + '</div>'
                    + '<div style="display:flex;gap:6px;flex-wrap:wrap">'
                    + ['open:開啟', 'pin:' + (a.pinned ? '取消釘選' : '釘選'), 'rename:改名', 'export:匯出', 'del:刪除'].map(function (x) { var p = x.split(':'); return '<button data-act="' + p[0] + '" style="padding:3px 8px;border-radius:7px;border:1px solid ' + (p[0] === 'del' ? '#fca5a5' : bd) + ';background:none;color:' + (p[0] === 'del' ? '#ef4444' : tx) + ';font-size:11px;cursor:pointer">' + p[1] + '</button>'; }).join('')
                    + '</div></div>';
            }).join('');
            box.querySelectorAll('[data-act]').forEach(function (b) {
                b.onclick = async function (e) {
                    var id = b.closest('[data-id]').getAttribute('data-id'), a = await get(id), act = b.getAttribute('data-act');
                    if (!a) return;
                    if (act === 'open') { closeLibrary(); openArtifact(id); }
                    else if (act === 'pin') { a.pinned = !a.pinned; await save(a); render(); }
                    else if (act === 'rename') { var nn = await askText('作品名稱', a.title); if (nn && nn.trim()) { a.title = nn.trim().slice(0, 80); await save(a); render(); updateHeader(); } }
                    else if (act === 'export') exportMenu(b, a);
                    else if (act === 'del') {
                        if (b.getAttribute('data-sure') !== '1') { b.setAttribute('data-sure', '1'); b.textContent = '再按一次確定刪除'; return; }
                        await remove(id); if (CUR.id === id) setCurrent(null, -1); render(); toast('已刪除「' + a.title + '」');
                    }
                };
            });
        };
        document.getElementById('nart-q').oninput = function () { clearTimeout(this._t); this._t = setTimeout(render, 200); };
        _libRender = render;
        render();
    }
    function closeLibrary() { var o = document.getElementById('nart-lib-ov'); if (o) o.remove(); closePop(); }

    // ─────────────────────────── ③ 局部修改（```nova-edit）───────────────────────────
    function parseEdit(raw) {
        var s = String(raw || ''), id = null;
        var m = /^\s*(?:artifact|作品)\s*[:：=]\s*([a-z0-9]{6,16})/im.exec(s);
        if (m) id = m[1].toLowerCase();
        var blocks = [], re = /<{5,9}\s*SEARCH[^\n]*\n([\s\S]*?)\n?={5,9}[^\n]*\n([\s\S]*?)\n?>{5,9}\s*REPLACE/g, b;
        while ((b = re.exec(s))) blocks.push({ search: b[1], replace: b[2] });
        return { id: id, blocks: blocks };
    }
    function applyBlocks(code, blocks) {
        var out = String(code), fails = [];
        blocks.forEach(function (bl, i) {
            if (!bl.search.trim()) { fails.push(i + 1); return; }
            var at = out.indexOf(bl.search);
            if (at >= 0 && out.indexOf(bl.search, at + 1) < 0) { out = out.slice(0, at) + bl.replace + out.slice(at + bl.search.length); return; }
            if (at >= 0) { out = out.slice(0, at) + bl.replace + out.slice(at + bl.search.length); return; }   // 出現多次：改第一個
            // 寬鬆比對：逐行去掉頭尾空白
            var lines = out.split('\n'), want = bl.search.split('\n').map(function (l) { return l.trim(); });
            while (want.length && !want[0]) want.shift();
            while (want.length && !want[want.length - 1]) want.pop();
            if (!want.length) { fails.push(i + 1); return; }
            for (var k = 0; k + want.length <= lines.length; k++) {
                var ok = true;
                for (var j = 0; j < want.length; j++) if (lines[k + j].trim() !== want[j]) { ok = false; break; }
                if (ok) {
                    var indent = (/^\s*/.exec(lines[k]) || [''])[0];
                    var rep = bl.replace.split('\n');
                    var repIndent = (/^\s*/.exec(rep.find(function (x) { return x.trim(); }) || '') || [''])[0];
                    var fixed = rep.map(function (x) { return x.indexOf(repIndent) === 0 ? indent + x.slice(repIndent.length) : x; });
                    lines.splice.apply(lines, [k, want.length].concat(fixed));
                    out = lines.join('\n'); return;
                }
            }
            fails.push(i + 1);
        });
        return { ok: !fails.length, code: out, fails: fails, applied: blocks.length - fails.length };
    }
    function editsMap(h, v) {
        var m = {}; try { m = JSON.parse(localStorage.getItem(LS_EDITS) || '{}') || {}; } catch (e) { m = {}; }
        if (v === undefined) return m[h] || null;
        m[h] = v; var ks = Object.keys(m); if (ks.length > 400) ks.slice(0, ks.length - 400).forEach(function (k) { delete m[k]; });
        try { localStorage.setItem(LS_EDITS, JSON.stringify(m)); } catch (e) { /* */ }
        return v;
    }
    function msgOf(mid) { try { var arr = (window.appState && appState.messages) || []; for (var i = arr.length - 1; i >= 0; i--) if (String(arr[i].id) === String(mid)) return arr[i]; } catch (e) { /* */ } return null; }
    async function applyEditText(raw, opts) {
        opts = opts || {};
        var p = parseEdit(raw);
        var id = p.id || CUR.id || (window.appState && appState._novaArtifactActive && appState._novaArtifactActive.id);
        if (!p.blocks.length) return { ok: false, error: '沒有 SEARCH／REPLACE 區段' };
        var a = id ? await get(id) : null;
        if (!a) return { ok: false, error: '找不到要修改的作品（' + (id || '沒有指定編號') + '）' };
        var r = applyBlocks(latest(a).code, p.blocks);
        if (!r.ok) return { ok: false, art: a, error: '第 ' + r.fails.join('、') + ' 段找不到原文，整批沒有套用' };
        var v = await addVersion(a, r.code, '局部修改 ' + r.applied + ' 處', 'edit');
        if (window.novaCanvas && CUR.id === a.id) {
            var ov = document.getElementById('nova-canvas-overlay');
            if (ov && ov.style.display !== 'none') { CUR.art = a; CUR.vIdx = v.idx; CUR.suppress = true; window.novaCanvas.open(r.code, a.lang); updateHeader(); }
        }
        return { ok: true, art: a, idx: v.idx, applied: r.applied };
    }
    function editCardHtml(state) {
        var L = isLight(), bd = L ? '#cbd5e1' : '#334155', tx = L ? '#0f172a' : '#e2e8f0', sub = L ? '#64748b' : '#94a3b8';
        var bs = 'padding:3px 10px;border-radius:8px;border:1px solid ' + bd + ';background:none;color:' + tx + ';font-size:12px;font-weight:600;cursor:pointer;margin-left:6px';
        if (state.pending) return '<div style="margin:8px 0;padding:10px 12px;border:1px dashed ' + bd + ';border-radius:12px;font-size:12px;color:' + sub + '">✏️ 作品局部修改（' + state.n + ' 處）<button data-nart-apply="1" style="' + bs + '">套用到作品</button></div>';
        if (state.ok) return '<div style="margin:8px 0;padding:10px 12px;border:1px solid ' + bd + ';border-radius:12px;font-size:12px;color:' + tx + '">✅ 已更新作品「' + esc(state.title) + '」到版本 ' + (state.idx + 1) + '（改了 ' + state.applied + ' 處）'
            + '<button data-nart-open="' + esc(state.id) + '" data-v="' + state.idx + '" style="' + bs + '">開啟</button></div>';
        return '<div style="margin:8px 0;padding:10px 12px;border:1px solid #fca5a5;border-radius:12px;font-size:12px;color:' + tx + '">⚠️ 作品局部修改失敗：' + esc(state.error)
            + (state.id ? '<button data-nart-rewrite="' + esc(state.id) + '" style="' + bs + '">請 AI 整份重寫</button>' : '') + '<button data-nart-apply="1" style="' + bs + '">再試一次</button></div>';
    }
    function hydrateEdit(el, force) {
        if (!force && el.getAttribute('data-nart-state')) return;
        el.setAttribute('data-nart-state', '1');
        var raw = ''; try { raw = decodeURIComponent(escape(atob(el.getAttribute('data-enc') || ''))); } catch (e) { raw = ''; }
        var h = hashText(raw), done = editsMap(h);
        var bind = function () {
            el.querySelectorAll('[data-nart-open]').forEach(function (b) { b.onclick = function () { openArtifact(b.getAttribute('data-nart-open'), +b.getAttribute('data-v')); }; });
            el.querySelectorAll('[data-nart-apply]').forEach(function (b) { b.onclick = function () { editsMap(h, null); hydrateEdit(el, true); }; });
            el.querySelectorAll('[data-nart-rewrite]').forEach(function (b) {
                b.onclick = async function () {
                    var a = await get(b.getAttribute('data-nart-rewrite'));
                    var inp = document.getElementById('user-input');
                    if (inp && a) { inp.value = '剛剛的局部修改套用失敗，請把作品「' + a.title + '」整份重寫成修改後的完整版本（第一行保留 nova-artifact:' + a.id + ' 標記）。'; inp.focus(); toast('已把指示放進輸入框，確認後送出'); }
                };
            });
        };
        if (done && !force) {
            get(done.id).then(function (a) { el.innerHTML = editCardHtml(done.ok ? { ok: true, title: a ? a.title : '作品', idx: done.idx, applied: done.applied, id: done.id } : { error: done.error, id: done.id }); bind(); });
            return;
        }
        var msg = msgOf(el.getAttribute('data-msg'));
        var fresh = !!(msg && msg.sender !== 'user' && Date.now() - Number(msg.id) < 15 * 60 * 1000);
        if (!fresh && !force) { el.innerHTML = editCardHtml({ pending: true, n: parseEdit(raw).blocks.length }); bind(); return; }
        applyEditText(raw).then(function (r) {
            var rec = r.ok ? { ok: true, id: r.art.id, idx: r.idx, applied: r.applied } : { ok: false, id: r.art ? r.art.id : null, error: r.error };
            editsMap(h, rec);
            el.innerHTML = editCardHtml(r.ok ? { ok: true, title: r.art.title, idx: r.idx, applied: r.applied, id: r.art.id } : { error: r.error, id: rec.id });
            bind();
        });
    }
    function scanEdits() { document.querySelectorAll('.nova-artifact-edit:not([data-nart-state])').forEach(function (el) { hydrateEdit(el, false); }); }

    // ─────────────────────────── 對話提示詞 ───────────────────────────
    var EDIT_WORDS = /改|修|調整|加上|加入|新增|刪|移除|換成|變成|放大|縮小|顏色|按鈕|排版|bug|錯誤|fix|change|update|add|remove/i;
    function canvasOpen() { var ov = document.getElementById('nova-canvas-overlay'); return !!(ov && ov.style.display !== 'none'); }
    async function promptAddon(userText) {
        var act = window.appState && appState._novaArtifactActive;
        var id = canvasOpen() ? CUR.id : (act && act.sessionId === appState.currentSessionId && Date.now() - act.t < 60 * 60 * 1000 && EDIT_WORDS.test(String(userText || '')) ? act.id : null);
        if (!id) return '';
        var a = await get(id); if (!a) return '';
        var code = latest(a).code, big = code.length > 40000;
        return '\n【🎨 目前的 Canvas 作品】編號 ' + a.id + '｜標題「' + a.title + '」｜' + a.lang.toUpperCase() + '｜第 ' + a.versions.length + ' 版' + (canvasOpen() ? '（使用者正開著 Canvas 看它）' : '') + '\n'
            + '使用者要修改這個作品時：\n'
            + '・只改少數地方 → 輸出一個 ```nova-edit 區塊，第一行寫 artifact: ' + a.id + '，接著一段或多段：\n'
            + '<<<<<<< SEARCH\n（作品裡原本的幾行，逐字照抄，含縮排）\n=======\n（改好的幾行）\n>>>>>>> REPLACE\n'
            + '  SEARCH 要能在作品裡唯一找到；多處修改就寫多段。不要再另外貼完整程式碼。\n'
            + '・大幅改寫 → 輸出完整的新程式碼（```' + (a.lang === 'python' ? 'python' : a.lang) + '），第一行放 ' + (a.lang === 'python' ? '# nova-artifact:' + a.id : (a.lang === 'html' ? '<!-- nova-artifact:' + a.id + ' -->' : '/* nova-artifact:' + a.id + ' */')) + '，NOVA 會存成同一個作品的新版本。\n'
            + '・作品頁面裡可以用 await nova.ask(提示詞, {json:true|false, search:true|false}) 呼叫 AI、用 await nova.store.get(key)／set(key, value) 保存資料（只在 NOVA 裡有效）。\n'
            + (big ? '（作品太長，只附開頭與結尾；修改請用 nova-edit，SEARCH 內容只能取自下面看得到的部分）\n```\n' + code.slice(0, 20000) + '\n…（中間省略）…\n' + code.slice(-12000) + '\n```\n'
                : '目前內容：\n```' + a.lang + '\n' + code + '\n```\n');
    }

    // ─────────────────────────── ④ 作品內的 AI 與儲存 ───────────────────────────
    function bridgeScript(id) {
        return '<script data-nova-bridge="1">(function(){var A=' + JSON.stringify(id || '') + ',n=0,cb={};'
            + 'window.addEventListener("message",function(e){var d=e.data;if(!d||d.__novaArt!==1||d.reply==null)return;var c=cb[d.reply];if(!c)return;delete cb[d.reply];if(d.ok)c[0](d.value);else c[1](new Error(d.error||"失敗"));});'
            + 'function call(op,args){return new Promise(function(res,rej){var id=++n;cb[id]=[res,rej];parent.postMessage({__novaArt:1,op:op,args:args,id:id,artifact:A},"*");});}'
            + 'window.nova={ask:function(p,o){return call("ask",{prompt:String(p==null?"":p),opts:o||{}});},'
            + 'store:{get:function(k){return call("get",{k:String(k)});},set:function(k,v){return call("set",{k:String(k),v:v});},remove:function(k){return call("del",{k:String(k)});},keys:function(){return call("keys",{});}}};'
            + '})();</' + 'script>';
    }
    function injectBridge(doc) {
        var s = bridgeScript(CUR.id), d = String(doc || '');
        if (/<head[^>]*>/i.test(d)) return d.replace(/<head[^>]*>/i, function (m) { return m + s; });
        if (/<html[^>]*>/i.test(d)) return d.replace(/<html[^>]*>/i, function (m) { return m + '<head>' + s + '</head>'; });
        return s + d;
    }
    var _rate = {};
    function askPermission(a) {
        return new Promise(function (res) {
            var L = isLight();
            var ov = document.createElement('div');
            ov.style.cssText = 'position:fixed;inset:0;z-index:100003;background:rgba(2,6,23,.5);display:flex;align-items:center;justify-content:center;padding:16px';
            ov.innerHTML = '<div style="max-width:420px;background:' + (L ? '#fff' : '#0f172a') + ';color:' + (L ? '#0f172a' : '#e2e8f0') + ';border-radius:14px;padding:18px;border:1px solid ' + (L ? '#e2e8f0' : '#334155') + ';font-size:13px;line-height:1.6">'
                + '<b style="font-size:14px">🤖 作品要使用 AI</b><p style="margin:8px 0 14px">作品「' + esc(a.title) + '」想呼叫 AI 模型（用你目前選的模型，會花 API 用量；每 5 分鐘最多 20 次）。要允許嗎？之後這個作品不會再問。</p>'
                + '<div style="display:flex;gap:8px;justify-content:flex-end"><button data-x="0" style="padding:6px 14px;border-radius:8px;border:1px solid #94a3b8;background:none;color:inherit;cursor:pointer">不允許</button>'
                + '<button data-x="1" style="padding:6px 14px;border-radius:8px;border:0;background:#4f46e5;color:#fff;cursor:pointer;font-weight:700">允許</button></div></div>';
            document.body.appendChild(ov);
            ov.querySelectorAll('button').forEach(function (b) { b.onclick = function () { ov.remove(); res(b.getAttribute('data-x') === '1'); }; });
        });
    }
    async function onBridge(ev) {
        var d = ev.data;
        if (!d || d.__novaArt !== 1 || d.reply != null || !d.op) return;
        var fr = document.getElementById('nova-canvas-iframe');
        if (!fr || ev.source !== fr.contentWindow) return;
        var reply = function (ok, value, error) { try { ev.source.postMessage({ __novaArt: 1, reply: d.id, ok: ok, value: value, error: error }, '*'); } catch (e) { /* */ } };
        try {
            var a = await get(d.artifact || CUR.id);
            if (!a) { reply(false, null, '這個頁面還沒存成作品'); return; }
            var args = d.args || {};
            if (d.op === 'ask') {
                if (a.aiAllowed === false) { reply(false, null, '使用者不允許這個作品使用 AI'); return; }
                if (a.aiAllowed !== true) { var ok = await askPermission(a); a.aiAllowed = ok; await save(a); if (!ok) { reply(false, null, '使用者不允許這個作品使用 AI'); return; } }
                var now = Date.now(), q = (_rate[a.id] = (_rate[a.id] || []).filter(function (t) { return now - t < 300000; }));
                if (q.length >= 20) { reply(false, null, '呼叫太頻繁（5 分鐘最多 20 次）'); return; }
                q.push(now);
                var p = String(args.prompt || '').slice(0, 20000), o = args.opts || {};
                if (o.system) p = String(o.system).slice(0, 4000) + '\n\n' + p;
                if (typeof window.fetchAIResponse !== 'function') { reply(false, null, 'NOVA 模型呼叫還沒就緒'); return; }
                var r = await window.fetchAIResponse(p, (window.appState && appState.currentModel) || 'gemini',
                    { isAnalysis: true, noChatDecor: true, customHistory: [], jsonMode: !!o.json, enableSearch: !!o.search, disableSearch: !o.search });
                var text = (r && r.text) || '';
                if (o.json) { try { var mm = /[\[{][\s\S]*[\]}]/.exec(text); reply(true, JSON.parse(mm ? mm[0] : text)); return; } catch (e) { reply(false, null, 'AI 沒有回傳合法 JSON：' + text.slice(0, 120)); return; } }
                reply(true, text);
            } else if (d.op === 'get') { reply(true, a.kv && Object.prototype.hasOwnProperty.call(a.kv, args.k) ? a.kv[args.k] : null); }
            else if (d.op === 'keys') { reply(true, Object.keys(a.kv || {})); }
            else if (d.op === 'del') { if (a.kv) delete a.kv[args.k]; await save(a); reply(true, true); }
            else if (d.op === 'set') {
                a.kv = a.kv || {};
                var old = a.kv[args.k]; a.kv[args.k] = args.v;
                if (JSON.stringify(a.kv).length > KV_LIMIT) { if (old === undefined) delete a.kv[args.k]; else a.kv[args.k] = old; reply(false, null, '超過這個作品的儲存上限（512KB）'); return; }
                await save(a); reply(true, true);
            } else reply(false, null, '不支援的操作：' + d.op);
        } catch (e) { reply(false, null, String(e && e.message || e).slice(0, 300)); }
    }

    // ─────────────────────────── Canvas 的 Python → NOVA Python 引擎 ───────────────────────────
    var BROWSER_PY = /from\s+js\s+import|import\s+js\b|pyodide|create_proxy|getContext\s*\(|requestAnimationFrame|\bdocument\.|\bwindow\.|from\s+browser\s+import/;
    function shouldUseRealPython(code) {
        try { if (localStorage.getItem('nova_canvas_python') === 'pyodide') return false; } catch (e) { /* */ }
        if (!window.NovaEngine || typeof window.NovaEngine.post !== 'function') return false;
        return !BROWSER_PY.test(String(code || '')) && !/(^|[^\w.])input\s*\(/.test(String(code || ''));
    }
    function pyDoc(state) {
        var css = '<style>body{margin:0;background:#0d1117;color:#e6edf3;font-family:ui-monospace,Consolas,monospace;font-size:13px}'
            + '.bar{padding:10px 16px;background:#161b22;border-bottom:1px solid #30363d;color:#8b949e;font-family:sans-serif;font-size:12px}'
            + 'pre{margin:0;padding:14px 16px;white-space:pre-wrap;word-break:break-word;line-height:1.6}.err{color:#ff7b72}'
            + 'img{display:block;max-width:100%;margin:12px auto;background:#fff;border-radius:8px}</style>';
        if (state.running) return '<!DOCTYPE html><html><head><meta charset="utf-8">' + css + '</head><body><div class="bar">🐍 NOVA Python 引擎執行中…（完整 Python，pandas／matplotlib 等都可用）</div></body></html>';
        var imgs = (state.images || []).map(function (im) {
            var src = typeof im === 'string' ? im : (im && (im.data || im.b64 || im.base64)) || '';
            if (src && !/^data:/.test(src)) src = 'data:image/png;base64,' + src;
            return src ? '<img src="' + src + '">' : '';
        }).join('');
        return '<!DOCTYPE html><html><head><meta charset="utf-8">' + css + '</head><body>'
            + '<div class="bar">🐍 NOVA Python 引擎' + (state.ok ? '・執行完成' : '・執行失敗') + '（' + state.ms + ' ms）</div>'
            + (state.stdout ? '<pre>' + esc(state.stdout) + '</pre>' : '')
            + (state.error ? '<pre class="err">' + esc(state.error) + '</pre>' : '')
            + imgs + (!state.stdout && !state.error && !imgs ? '<pre style="color:#8b949e">（沒有輸出）</pre>' : '') + '</body></html>';
    }
    async function runPythonInto(fr, code, onDone) {
        var t0 = Date.now();
        fr.srcdoc = pyDoc({ running: true });
        var st;
        try {
            var ready = await window.NovaEngine.waitUntilReady(15000);
            if (!ready) st = { ok: false, error: 'Python 引擎尚未就緒（等待逾時）。可以稍後按「重新整理」，或設定 localStorage nova_canvas_python=pyodide 改用瀏覽器內的 Pyodide。' };
            else {
                var res = await window.NovaEngine.post('/execute', { code: String(code || '') });
                if (!res || !res.success || !res.data) st = { ok: false, error: (res && res.error) || 'Python 引擎連線失敗' };
                else st = { ok: !!res.data.success, stdout: res.data.stdout || '', error: res.data.error || '', images: res.data.images || [] };
            }
        } catch (e) { st = { ok: false, error: String(e && e.message || e) }; }
        st.ms = Date.now() - t0;
        var html = pyDoc(st);
        window._novaCanvasLastDocRaw = html;
        fr.srcdoc = html;
        if (typeof onDone === 'function') { try { onDone(st); } catch (e) { /* */ } }
    }

    // ─────────────────────────── 啟動 ───────────────────────────
    window.addEventListener('message', onBridge);
    regSync();
    var _mo = null;
    function boot() {
        loadAll().then(function () {   // v1.1.0：補備份／從備份還原
            regSync();
            setTimeout(function () { bkRestore().then(function (r) { if (r && r.restored) toast('已從「' + (tfs() && tfs().android ? 'Documents/NOVA/作品庫' : '文件\\NOVA\\作品庫') + '」還原 ' + r.restored + ' 個作品'); }).catch(function (e) { console.warn('[NovaArtifacts] 備份檢查失敗：', e); }); }, 2500);
        });
        try {
            _mo = new MutationObserver(function () { clearTimeout(_mo._t); _mo._t = setTimeout(scanEdits, 300); });
            _mo.observe(document.body, { childList: true, subtree: true });
        } catch (e) { /* */ }
        scanEdits();
    }
    // 「+」選單入口（和 draw.io／TravelAgent 同一個做法：選單可能被重畫，所以定時補上）
    function addEntry() {
        var grid = document.getElementById('plus-menu'); if (!grid || document.getElementById('nv-artlib-btn')) return;
        var ref = grid.querySelector('button.nv-pm'); if (!ref || !ref.parentNode) return;
        var b = document.createElement('button'); b.id = 'nv-artlib-btn'; b.type = 'button';
        b.className = 'nv-pm flex flex-col items-center justify-center gap-2 p-2 rounded-xl bg-slate-800 border border-indigo-400/50 hover:bg-slate-700 text-indigo-300 transition-colors active:scale-95'; b.style.setProperty('--pc', '#a5b4fc');
        b.title = 'Canvas 作品庫：AI 做過的網頁、小工具、互動圖表（版本、匯出、跨裝置同步）';
        b.innerHTML = '<i class="ph-bold ph-books text-xl"></i><span class="text-[10px] font-bold whitespace-nowrap">作品庫</span>';
        b.onclick = function () { window.openArtifactLibrary(); };
        var dv = document.getElementById('nv-drawio-btn');
        if (dv && dv.parentNode === ref.parentNode) dv.parentNode.insertBefore(b, dv.nextSibling); else ref.parentNode.appendChild(b);
    }
    var _boot0 = boot;
    boot = function () { _boot0(); addEntry(); setInterval(addEntry, 3000); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

    window.NovaArtifacts = {
        version: '1.0.0', desktopBase: '1.1.0', _capfs: capfs,
        backupNow: async function () { Object.keys(await loadAll()).forEach(bkMark); clearTimeout(BK.timer); return bkFlush(); },
        backupInfo: function () { return { dir: BK.dir, last: BK.last, error: BK.err, pending: Object.keys(BK.dirty).length }; },
        restoreFromBackup: bkRestore, openBackupFolder: openFolder, syncNow: syncNow, remove: remove,
        _syncCollect: syncCollect, _syncApply: syncApply, _mergeArt: mergeArt, _bkFlushed: function () { return BK.chain; }, _save: save,
        onCanvasOpen: onCanvasOpen, onCanvasStream: onCanvasStream, onAiMessage: onAiMessage,
        injectBridge: injectBridge, shouldUseRealPython: shouldUseRealPython, runPythonInto: runPythonInto,
        promptAddon: promptAddon, openLibrary: openLibrary, openArtifact: openArtifact,
        list: list, get: get, current: function () { return { id: CUR.id, vIdx: CUR.vIdx }; },
        exportHtml: exportHtml, exportSource: exportSource,
        _applyBlocks: applyBlocks, _parseEdit: parseEdit, _applyEditText: applyEditText, _hydrateEdit: hydrateEdit, _register: register
    };
    window.openArtifactLibrary = function () {
        try { document.getElementById('plus-menu').classList.add('hidden'); document.getElementById('plus-icon').classList.remove('rotate-45'); } catch (e) { /* */ }
        openLibrary();
    };
})();

/* nova-google.js — v1.1.0 (2026-10-11)
 * 手機版 Google 整合（階段 1~3）：App 內 OAuth（PKCE，系統瀏覽器＋GitHub Pages 轉址頁＋nova120://oauth 深度連結）、
 *   ① Drive 雙向同步：檔名 NOVA_Sync_Bundle.json，與桌面版同格式（todos／notes／deletedIds 做 last-write-wins 合併，
 *      其餘欄位 documents／folders／chunks 原封不動保留，不會被手機覆蓋）。
 *   ② Gmail 唯讀：列信、讀內文、請 AI 摘要。
 *   ③ Docs：筆記匯出成 Google 文件、把 Google 文件讀回成筆記。
 * 設定：Client ID／Client Secret 沿用桌面版同名設定（localStorage nova_key_google_client_id／_secret，會進備份）。
 *   需要「Web 應用程式」類型的 OAuth 用戶端，並把轉址 URI（預設 https://kirishimatoka00.github.io/nova-android/oauth.html）加進該用戶端。
 * 介面：+選單「Google」鈕、設定頁「Google 整合」鈕 → #nova-google-modal。
 * 版本紀錄
 *   v1.1.0 2026-10-11  Drive 同步新增：知識庫（documents／folders／chunks，向量不上傳、收到端用 Gemini 補算）、AI 記憶（呼叫 nova-memsync.js，與桌面版共用 NOVA_Memory_Sync.json）；合併知識庫頁記下的刪除墓碑
 *   v1.0.2 2026-10-11  Docs：筆記匯出／文件轉筆記改走 Drive 轉檔與 export（只需 Drive 權限，不需啟用 Docs API）；錯誤提示不再被視窗蓋住（toast 層級提高）
 *   v1.0.1 2026-10-11  修正介面顯示：專案 Tailwind 為預編譯，新類別不生效，導致視窗背景透明、按鈕無樣式；改為自帶 <style>（#nova-google-modal 範圍）＋實心背景，並修正設定頁按鈕樣式
 *   v1.0.0 2026-10-11  首版。誠實聲明：OAuth 與 Google API 全程只在沙盒用模擬回應驗證流程，沒有連過真實 Google，需真機實測。
 */
(function () {
  'use strict';
  var W = window, D = document, LS = localStorage;
  var DEFAULT_REDIR = 'https://kirishimatoka00.github.io/nova-android/oauth.html';
  var SCHEME = 'nova120://oauth';
  var SYNC_NAME = 'NOVA_Sync_Bundle.json';
  var SCOPES = { drive: 'https://www.googleapis.com/auth/drive', gmail: 'https://www.googleapis.com/auth/gmail.readonly', docs: 'https://www.googleapis.com/auth/documents' };
  function g(k, d) { try { var v = LS.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function s(k, v) { try { LS.setItem(k, v); } catch (e) {} }
  function toast(m, d) { try { W.showToast(m, d); } catch (e) {} }
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function cfg() { return { id: g('nova_key_google_client_id', ''), secret: g('nova_key_google_client_secret', ''), redir: g('nova_google_redirect', DEFAULT_REDIR) }; }
  function tokens() { try { return JSON.parse(g('nova_google_tokens', 'null')); } catch (e) { return null; } }
  function saveTokens(t) { s('nova_google_tokens', JSON.stringify(t)); }
  function scopesSel() { try { return JSON.parse(g('nova_google_scopes', '["drive","gmail","docs"]')); } catch (e) { return ['drive', 'gmail', 'docs']; } }
  function connected() { var t = tokens(); return !!(t && (t.refresh_token || t.access_token)); }
  function has(sc) { var t = tokens(); return !!(t && (t.scope || '').indexOf(SCOPES[sc]) !== -1); }

  /* ───────── OAuth（PKCE） ───────── */
  function b64url(buf) { var b = ''; new Uint8Array(buf).forEach(function (x) { b += String.fromCharCode(x); }); return btoa(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function rand(n) { var a = new Uint8Array(n); crypto.getRandomValues(a); return b64url(a); }
  async function connect() {
    var c = cfg(); if (!c.id) { toast('⚠️ 請先填 Google Client ID'); return; }
    var sel = scopesSel(); if (!sel.length) { toast('⚠️ 請至少勾一項功能'); return; }
    var ver = rand(48), state = rand(16);
    var ch = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ver)));
    s('nova_google_pkce', JSON.stringify({ ver: ver, state: state, t: Date.now() }));
    var scope = ['openid', 'email'].concat(sel.map(function (k) { return SCOPES[k]; })).join(' ');
    var url = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=' + encodeURIComponent(c.id) + '&redirect_uri=' + encodeURIComponent(c.redir) + '&response_type=code&scope=' + encodeURIComponent(scope) +
      '&code_challenge=' + ch + '&code_challenge_method=S256&access_type=offline&prompt=consent&state=' + state;
    try { var B = W.Capacitor && Capacitor.Plugins && Capacitor.Plugins.Browser; if (B && B.open) { await B.open({ url: url }); return; } } catch (e) {}
    W.open(url, '_system');
  }
  async function tokenPost(params) {
    var c = cfg(); params.client_id = c.id; if (c.secret) params.client_secret = c.secret;
    var body = Object.keys(params).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
    var r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body });
    var j = await r.json(); if (!r.ok) throw new Error(j.error_description || j.error || ('HTTP ' + r.status)); return j;
  }
  async function handleRedirect(urlStr) {
    try {
      var q = urlStr.indexOf('?') >= 0 ? urlStr.slice(urlStr.indexOf('?') + 1) : urlStr, p = new URLSearchParams(q.replace(/#.*$/, ''));
      var err = p.get('error'); if (err) { toast('❌ Google 授權失敗：' + err); return false; }
      var code = p.get('code'); if (!code) return false;
      var pk; try { pk = JSON.parse(g('nova_google_pkce', 'null')); } catch (e) {}
      if (!pk) { toast('⚠️ 找不到授權前的驗證資料，請重新按「連接」'); return false; }
      if (p.get('state') && p.get('state') !== pk.state) { toast('⚠️ 授權狀態不符，已拒絕'); return false; }
      var j = await tokenPost({ grant_type: 'authorization_code', code: code, code_verifier: pk.ver, redirect_uri: cfg().redir });
      var old = tokens() || {};
      saveTokens({ access_token: j.access_token, refresh_token: j.refresh_token || old.refresh_token, scope: j.scope || '', exp: Date.now() + (j.expires_in || 3600) * 1000 - 60000 });
      try { LS.removeItem('nova_google_pkce'); } catch (e) {}
      try { var ui = await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: 'Bearer ' + j.access_token } })).json(); if (ui.email) s('nova_google_email', ui.email); } catch (e) {}
      toast('✅ 已連接 Google 帳號'); render(); return true;
    } catch (e) { toast('❌ 連接失敗：' + (e.message || e), 5000); return false; }
  }
  async function accessToken() {
    var t = tokens(); if (!t) throw new Error('尚未連接 Google 帳號');
    if (t.access_token && t.exp && Date.now() < t.exp) return t.access_token;
    if (!t.refresh_token) throw new Error('授權已失效，請重新連接');
    var j = await tokenPost({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
    t.access_token = j.access_token; t.exp = Date.now() + (j.expires_in || 3600) * 1000 - 60000; if (j.scope) t.scope = j.scope; saveTokens(t); return t.access_token;
  }
  async function api(url, opts) {
    opts = opts || {}; var tk = await accessToken();
    opts.headers = Object.assign({ Authorization: 'Bearer ' + tk }, opts.headers || {});
    var r = await fetch(url, opts);
    if (r.status === 401) { var t = tokens(); t.exp = 0; saveTokens(t); tk = await accessToken(); opts.headers.Authorization = 'Bearer ' + tk; r = await fetch(url, opts); }
    return r;
  }
  async function apiJson(url, opts) { var r = await api(url, opts); var txt = await r.text(); var j; try { j = JSON.parse(txt); } catch (e) { j = { raw: txt }; } if (!r.ok) throw new Error((j.error && (j.error.message || j.error)) || ('HTTP ' + r.status)); return j; }
  function disconnect() {
    var t = tokens(); try { if (t && (t.refresh_token || t.access_token)) fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'token=' + encodeURIComponent(t.refresh_token || t.access_token) }); } catch (e) {}
    ['nova_google_tokens', 'nova_google_email', 'nova_drive_sync_file_id'].forEach(function (k) { try { LS.removeItem(k); } catch (e) {} });
    toast('已中斷 Google 連接'); render();
  }

  /* ───────── ① Drive 同步 ───────── */
  var syncing = false, debTimer = null;
  function syncOn() { return g('nova_gsync_enabled', '0') === '1'; }
  function mergeById(a, b, ts, del) {
    var m = {}; (a || []).forEach(function (x) { m[String(x.id)] = x; });
    (b || []).forEach(function (x) { var k = String(x.id), e = m[k]; if (!e || (x[ts] || 0) > (e[ts] || 0)) m[k] = x; });
    return Object.keys(m).map(function (k) { return m[k]; }).filter(function (x) { var d = del[String(x.id)]; return !(d && d >= (x[ts] || 0)); });
  }
  function mergeDel(a, b) { var m = Object.assign({}, a || {}); Object.keys(b || {}).forEach(function (k) { if (!m[k] || b[k] > m[k]) m[k] = b[k]; }); return m; }
  async function findFiles() {
    var q = "name='" + SYNC_NAME + "' and trashed=false";
    var j = await apiJson('https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) + '&fields=files(id,name,modifiedTime)&pageSize=10&orderBy=modifiedTime');
    return j.files || [];
  }
  async function readFile(id) { var r = await api('https://www.googleapis.com/drive/v3/files/' + id + '?alt=media'); if (!r.ok) throw new Error('讀取同步檔失敗 HTTP ' + r.status); return JSON.parse(await r.text()); }
  async function writeFile(id, bundle) {
    var body = JSON.stringify(bundle);
    if (id) { var r = await api('https://www.googleapis.com/upload/drive/v3/files/' + id + '?uploadType=media', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: body }); if (!r.ok) throw new Error('寫入同步檔失敗 HTTP ' + r.status); return id; }
    var bd = 'nova' + rand(8), meta = JSON.stringify({ name: SYNC_NAME, mimeType: 'application/json' });
    var multi = '--' + bd + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + meta + '\r\n--' + bd + '\r\nContent-Type: application/json\r\n\r\n' + body + '\r\n--' + bd + '--';
    var r2 = await api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + bd }, body: multi });
    var j = await r2.json(); if (!r2.ok) throw new Error('建立同步檔失敗 HTTP ' + r2.status); return j.id;
  }
  async function putLocal(store, item) {
    try { if (typeof db !== 'undefined' && db) { await new Promise(function (res) { var tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(item); tx.oncomplete = res; tx.onerror = res; }); return; } } catch (e) {}
    W.saveToDB(store, item);
  }
  /* v1.1.0：通用 Drive 檔案存取（給 nova-memsync.js 用；NOVA_Memory_Sync.json 與桌面版同名同格式） */
  async function findByName(name) {
    var q = "name='" + name + "' and trashed=false";
    var j = await apiJson('https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) + '&fields=files(id,name,modifiedTime)&pageSize=10&orderBy=modifiedTime');
    return j.files || [];
  }
  async function readJsonFile(id, soft) {
    var r = await api('https://www.googleapis.com/drive/v3/files/' + id + '?alt=media'); var tx = await r.text();
    if (!r.ok) { if (soft && r.status === 404) return null; throw new Error('讀取 Drive 檔案失敗 HTTP ' + r.status); }
    if (!tx.trim()) return null;
    try { return JSON.parse(tx); } catch (e) { throw new Error('Drive 上的同步檔不是合法 JSON（可能上次寫到一半），為避免覆蓋，這次中止'); }
  }
  async function writeNamed(id, name, obj) {
    var body = JSON.stringify(obj);
    if (id) { var r = await api('https://www.googleapis.com/upload/drive/v3/files/' + id + '?uploadType=media', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: body }); if (!r.ok) throw new Error('寫入 Drive 檔案失敗 HTTP ' + r.status); return id; }
    var bd = 'nova' + rand(8), meta = JSON.stringify({ name: name, mimeType: 'application/json' });
    var multi = '--' + bd + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + meta + '\r\n--' + bd + '\r\nContent-Type: application/json\r\n\r\n' + body + '\r\n--' + bd + '--';
    var r2 = await api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + bd }, body: multi });
    var j = await r2.json(); if (!r2.ok) throw new Error('建立 Drive 檔案失敗 HTTP ' + r2.status); return j.id;
  }
  async function trashFile(id) { await api('https://www.googleapis.com/drive/v3/files/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) }); }

  /* v1.1.0：知識庫（向量資料庫）同步 — 與桌面版同格式：documents／folders 以 _syncTs（沒有就用 addedAt／createdAt）last-write-wins，
   * chunks 只帶文字（不含向量），本機沒有的 chunk 收進來後標 pendingEmbed，由手機用 Gemini 嵌入補算向量 */
  function kbOn() { return g('nova_gsync_kb', '1') !== '0' && typeof W.novaKbGetAllDocs === 'function' && typeof W.novaKbPut === 'function'; }
  function memOn() { return !!(W.NovaMemSync && W.NovaMemSync.isEnabled()); }
  function stripChunk(c) { return { id: c.id, docId: c.docId, docName: c.docName, text: c.text, folderId: c.folderId }; }
  async function kbDelete(store, key) { var d = await W.novaKbOpenDb(); await new Promise(function (res) { var tx = d.transaction(store, 'readwrite'); tx.objectStore(store).delete(key); tx.oncomplete = res; tx.onerror = res; }); }
  async function kbCollect() {
    var docs = (await W.novaKbGetAllDocs()).map(function (d) { return Object.assign({}, d, { _syncTs: d._syncTs || d.addedAt || 0 }); });
    var folders = (await W.novaKbGetAllFolders()).map(function (f) { return Object.assign({}, f, { _syncTs: f._syncTs || f.createdAt || 0 }); });
    var chunks = await W.novaKbGetAllChunks();
    return { docs: docs, folders: folders, chunks: chunks };
  }
  function kbMerge(kb, remote, del) {
    var mdocs = mergeById(kb.docs, remote.documents, '_syncTs', del), mfold = mergeById(kb.folders, remote.folders, '_syncTs', del);
    var docIds = {}; mdocs.forEach(function (d) { docIds[String(d.id)] = 1; });
    var dead = function (c) { var k = String(c.docId); return !!(del[k] && !docIds[k]); };
    var rc = {}; (remote.chunks || []).forEach(function (c) { rc[String(c.id)] = 1; });
    var out = (remote.chunks || []).filter(function (c) { return !dead(c); });
    kb.chunks.forEach(function (c) { if (!rc[String(c.id)] && !dead(c)) out.push(stripChunk(c)); });
    return { docs: mdocs, folders: mfold, chunks: out };
  }
  async function kbApply(kb, m) {
    var r = { docs: 0, chunks: 0, removed: 0 };
    var ld = {}, lf = {}, lc = {}; kb.docs.forEach(function (d) { ld[String(d.id)] = d; }); kb.folders.forEach(function (f) { lf[String(f.id)] = f; }); kb.chunks.forEach(function (c) { lc[String(c.id)] = c; });
    var keepD = {}, keepF = {};
    for (var i = 0; i < m.folders.length; i++) { var f = m.folders[i]; keepF[String(f.id)] = 1; var l = lf[String(f.id)]; if (!l || (f._syncTs || 0) > (l._syncTs || 0)) await W.novaKbPut('folders', f); }
    for (var j = 0; j < m.docs.length; j++) { var d = m.docs[j]; keepD[String(d.id)] = 1; var l2 = ld[String(d.id)]; if (!l2 || (d._syncTs || 0) > (l2._syncTs || 0)) { await W.novaKbPut('documents', d); r.docs++; } }
    for (var k = 0; k < m.chunks.length; k++) { var c = m.chunks[k]; if (!lc[String(c.id)]) { await W.novaKbPut('chunks', Object.assign({}, c, { pendingEmbed: true })); r.chunks++; } }
    for (var q = 0; q < kb.docs.length; q++) { var od = kb.docs[q]; if (!keepD[String(od.id)]) { try { if (typeof W.novaKbDeleteChunksByDocId === 'function') await W.novaKbDeleteChunksByDocId(od.id); } catch (e) {} await kbDelete('documents', od.id); r.removed++; } }
    for (var w = 0; w < kb.folders.length; w++) { var of = kb.folders[w]; if (!keepF[String(of.id)] && String(of.id) !== 'uncat' && !of._protected) await kbDelete('folders', of.id); }
    return r;
  }
  async function kbEmbedPending(max) {
    if (typeof W.novaKbEmbedDocumentBatch !== 'function' || !(appState.keys && appState.keys.gemini)) return { done: 0, left: -1 };
    var all = await W.novaKbGetAllChunks(), pend = all.filter(function (c) { return !c.vector || !c.vector.length; }), done = 0;
    for (var i = 0; i < pend.length && done < max; i += 20) {
      var batch = pend.slice(i, i + 20);
      try { var vs = await W.novaKbEmbedDocumentBatch(batch.map(function (c) { return 'title: ' + (c.docName || 'none') + ' | text: ' + (c.text || ''); })); }
      catch (e) { break; }
      for (var j = 0; j < batch.length; j++) { if (!vs[j]) continue; var u = Object.assign({}, batch[j], { vector: vs[j] }); delete u.pendingEmbed; await W.novaKbPut('chunks', u); done++; }
    }
    return { done: done, left: pend.length - done };
  }

  async function syncNow(manual) {
    if (syncing) return; if (!connected() || !has('drive')) { if (manual) toast('⚠️ 請先連接 Google 並勾選 Drive'); return; }
    syncing = true; setStatus('同步中…');
    try {
      var todos = (await W.loadStoreFromDB('todos')).map(function (t) { return Object.assign({}, t, { _syncTs: t._syncTs || t.id || 0 }); });
      var notes = (await W.loadStoreFromDB('notes')).map(function (n) { return Object.assign({}, n, { _syncTs: n._syncTs || n.id || 0 }); });
      var localDel = Object.assign({}, (function () { try { return JSON.parse(g('nova_deleted_ids', '{}')); } catch (e) { return {}; } })(), appState.deletedIds || {});   // 含知識庫頁（另一頁）記下的墓碑
      var files = await findFiles(), id = files.length ? files[0].id : null, remote = {};
      if (files.length > 1) { /* 多份同名：依修改時間由舊到新合併，保留最舊那份當正本 */
        for (var i = 0; i < files.length; i++) { try { var r = await readFile(files[i].id); remote = remote.todos ? Object.assign(remote, { todos: mergeById(remote.todos, r.todos, '_syncTs', {}), notes: mergeById(remote.notes, r.notes, '_syncTs', {}), documents: mergeById(remote.documents, r.documents, '_syncTs', {}), folders: mergeById(remote.folders, r.folders, '_syncTs', {}), chunks: (remote.chunks || []).concat((r.chunks || []).filter(function (c) { return !(remote.chunks || []).some(function (x) { return String(x.id) === String(c.id); }); })), deletedIds: mergeDel(remote.deletedIds, r.deletedIds) }) : r; } catch (e) { throw new Error('偵測到重複的同步檔，但其中一份讀不到，為避免遺失資料先中止，請到 Google Drive 檢查 ' + SYNC_NAME); } }
      } else if (id) remote = await readFile(id);
      var del = mergeDel(localDel, remote.deletedIds);
      var mt = mergeById(todos, remote.todos, '_syncTs', del), mn = mergeById(notes, remote.notes, '_syncTs', del);
      var out = Object.assign({}, remote, { todos: mt, notes: mn, deletedIds: del });
      var kbInfo = '';
      if (kbOn()) {
        try {
          var kb = await kbCollect(), km = kbMerge(kb, remote, del);
          out.documents = km.docs; out.folders = km.folders; out.chunks = km.chunks;
          var ar = await kbApply(kb, km);
          kbInfo = '／文件 ' + km.docs.length + '・片段 ' + km.chunks.length + (ar.docs || ar.chunks ? '（↓ 新收 文件 ' + ar.docs + '・片段 ' + ar.chunks + '）' : '');
        } catch (e) { kbInfo = '／知識庫略過：' + (e.message || e); }
      }
      for (var a = 0; a < mt.length; a++) await putLocal('todos', mt[a]);
      for (var b = 0; b < mn.length; b++) await putLocal('notes', mn[b]);
      var keepT = {}, keepN = {}; mt.forEach(function (x) { keepT[String(x.id)] = 1; }); mn.forEach(function (x) { keepN[String(x.id)] = 1; });
      todos.forEach(function (x) { if (!keepT[String(x.id)]) W.deleteFromDB('todos', x.id); }); notes.forEach(function (x) { if (!keepN[String(x.id)]) W.deleteFromDB('notes', x.id); });
      appState.todos = mt.slice().sort(function (x, y) { return y.id - x.id; }); appState.notes = mn.slice().sort(function (x, y) { return y.id - x.id; });
      appState.deletedIds = del; s('nova_deleted_ids', JSON.stringify(del));
      try { W.renderTodos(); W.renderNotes(); } catch (e) {}
      var fid = await writeFile(id, out); s('nova_drive_sync_file_id', fid);
      var now = new Date().toLocaleString('zh-TW'); s('nova_gsync_last', now); setStatus('✅ 已同步 ' + now + '（任務 ' + mt.length + '／筆記 ' + mn.length + kbInfo + '）');
      if (kbOn()) { try { var ep = await kbEmbedPending(200); if (ep.done || ep.left > 0) { var st0 = g('nova_gsync_status', ''); setStatus(st0 + (ep.done ? '；補算向量 ' + ep.done + ' 段' : '') + (ep.left > 0 ? '；尚有 ' + ep.left + ' 段待補向量' + (ep.left === -1 ? '' : '（下次同步繼續）') : '')); } } catch (e) {} }
      if (memOn()) {
        try { var mr = await W.NovaMemSync.sync({ interactive: !!manual }); if (!mr.skipped) { var d = W.NovaMemSync.describe(mr); s('nova_gmem_status', '🧠 記憶：✅ ' + now + (d ? '（' + d + '）' : '')); if (manual && d && d !== '沒有變動') toast('🧠 記憶同步：' + d, 6000); } }
        catch (e) { s('nova_gmem_status', '🧠 記憶：❌ ' + (e.message || e)); if (manual) toast('❌ 記憶同步失敗（筆記已同步）：' + (e.message || e), 6000); }
        var me = D.getElementById('ng-mem-status'); if (me) me.textContent = g('nova_gmem_status', '');
      }
      if (manual) toast('☁️ 同步完成');
    } catch (e) { setStatus('❌ 同步失敗：' + (e.message || e)); if (manual) toast('❌ 同步失敗：' + (e.message || e), 5000); }
    finally { syncing = false; }
  }
  function schedule() { if (!syncOn() || !connected() || !has('drive')) return; clearTimeout(debTimer); debTimer = setTimeout(function () { syncNow(false); }, 4000); }
  (function hookSave() {   // 蓋 _syncTs，並在有變更時排程同步
    var o = W.saveToDB; if (typeof o !== 'function' || o._gHooked) return;
    var w = function (store, item) { if ((store === 'todos' || store === 'notes') && item && typeof item === 'object') { item._syncTs = Date.now(); schedule(); } return o.apply(this, arguments); };
    w._gHooked = true; W.saveToDB = w;
    var od = W.deleteFromDB; if (typeof od === 'function') { var wd = function (store) { if (store === 'todos' || store === 'notes') schedule(); return od.apply(this, arguments); }; wd._gHooked = true; W.deleteFromDB = wd; }
  })();

  /* ───────── ② Gmail ───────── */
  function hdr(m, n) { var h = ((m.payload && m.payload.headers) || []).find(function (x) { return x.name.toLowerCase() === n.toLowerCase(); }); return h ? h.value : ''; }
  async function gmailList(q, max) {
    var j = await apiJson('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=' + (max || 15) + (q ? '&q=' + encodeURIComponent(q) : ''));
    var ids = (j.messages || []).map(function (m) { return m.id; });
    return await Promise.all(ids.map(function (id) { return apiJson('https://gmail.googleapis.com/gmail/v1/users/me/messages/' + id + '?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date'); }));
  }
  function b64dec(x) { try { var b = atob(x.replace(/-/g, '+').replace(/_/g, '/')); return decodeURIComponent(escape(b)); } catch (e) { try { return atob(x.replace(/-/g, '+').replace(/_/g, '/')); } catch (e2) { return ''; } } }
  function bodyOf(p) {
    if (!p) return ''; var plain = '', html = '';
    (function walk(x) { if (!x) return; if (x.mimeType === 'text/plain' && x.body && x.body.data) plain += b64dec(x.body.data); else if (x.mimeType === 'text/html' && x.body && x.body.data) html += b64dec(x.body.data); (x.parts || []).forEach(walk); })(p);
    if (plain) return plain; var d = D.createElement('div'); d.innerHTML = html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n'); return d.textContent || '';
  }
  async function gmailRead(id) { var m = await apiJson('https://gmail.googleapis.com/gmail/v1/users/me/messages/' + id + '?format=full'); return { from: hdr(m, 'From'), subject: hdr(m, 'Subject'), date: hdr(m, 'Date'), body: bodyOf(m.payload).trim() }; }

  /* ───────── ③ Docs ───────── */
  function docText(doc) { var out = ''; ((doc.body && doc.body.content) || []).forEach(function (el) { if (el.paragraph) (el.paragraph.elements || []).forEach(function (e) { if (e.textRun) out += e.textRun.content; }); else if (el.table) (el.table.tableRows || []).forEach(function (r) { var cells = []; (r.tableCells || []).forEach(function (c) { var t = ''; (c.content || []).forEach(function (cc) { if (cc.paragraph) (cc.paragraph.elements || []).forEach(function (e) { if (e.textRun) t += e.textRun.content.replace(/\n/g, ' '); }); }); cells.push(t.trim()); }); out += cells.join(' | ') + '\n'; }); }); return out; }
  function noteText(n) { var t = n.isHtml ? (function () { var d = D.createElement('div'); d.innerHTML = String(n.content || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n'); return d.textContent; })() : String(n.content || ''); return t; }
  function escH(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  async function noteToDoc(id) {
    var n = appState.notes.find(function (x) { return String(x.id) === String(id); }); if (!n) throw new Error('找不到筆記');
    var title = n.title || '未命名筆記', docId;
    if (has('drive')) {
      /* v1.0.2：優先走 Drive 轉檔（text/html → Google 文件），只需 Drive 權限，不需在 Google Cloud 另外啟用 Docs API */
      var html = '<html><head><meta charset="utf-8"></head><body>' + (n.isHtml ? String(n.content || '') : '<p>' + escH(noteText(n)).replace(/\n/g, '<br>') + '</p>') + '</body></html>';
      var bd = 'novaB' + Date.now();
      var body = '--' + bd + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify({ name: title, mimeType: 'application/vnd.google-apps.document' }) + '\r\n--' + bd + '\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n' + html + '\r\n--' + bd + '--';
      var j = await apiJson('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + bd }, body: body });
      docId = j.id;
    } else {
      var doc = await apiJson('https://docs.googleapis.com/v1/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: title }) });
      var text = noteText(n); if (text) await apiJson('https://docs.googleapis.com/v1/documents/' + doc.documentId + ':batchUpdate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text: text } }] }) });
      docId = doc.documentId;
    }
    n.driveUrl = 'https://docs.google.com/document/d/' + docId + '/edit'; W.saveToDB('notes', n); try { W.renderNotes(); } catch (e) {}
    return n.driveUrl;
  }
  async function docsList() { var j = await apiJson('https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent("mimeType='application/vnd.google-apps.document' and trashed=false") + '&orderBy=modifiedTime desc&pageSize=20&fields=files(id,name,modifiedTime)'); return j.files || []; }
  async function docToNote(id, name) {
    var title = name, text;
    if (has('drive')) {
      /* v1.0.2：走 Drive export（text/plain），不需 Docs API */
      var r = await api('https://www.googleapis.com/drive/v3/files/' + id + '/export?mimeType=' + encodeURIComponent('text/plain')); var tx = await r.text();
      if (!r.ok) { var jj = {}; try { jj = JSON.parse(tx); } catch (e) {} throw new Error((jj.error && jj.error.message) || ('HTTP ' + r.status)); }
      text = tx.replace(/^\uFEFF/, '').trim();
      if (!title) { try { title = (await apiJson('https://www.googleapis.com/drive/v3/files/' + id + '?fields=name')).name; } catch (e) {} }
    } else { var doc = await apiJson('https://docs.googleapis.com/v1/documents/' + id); text = docText(doc).trim(); title = doc.title; }
    var doc = { title: title };
    var note = { id: Date.now(), title: doc.title || name || 'Google 文件', content: text, isHtml: false, date: new Date().toLocaleString(), type: 'text', images: [], folder: '未分類', driveUrl: 'https://docs.google.com/document/d/' + id + '/edit' };
    appState.notes.unshift(note); W.saveToDB('notes', note); try { W.renderNotes(); } catch (e) {}
    return note;
  }

  /* ───────── 介面 ───────── */
  function setStatus(t) { s('nova_gsync_status', t); var e = D.getElementById('ng-sync-status'); if (e) e.textContent = t; }
  var tab = 'main';
  function ensureModal() {
    if (D.getElementById('nova-google-modal')) return;
    if (!D.getElementById('ng-style')) { var st = D.createElement('style'); st.id = 'ng-style'; st.textContent = CSS; D.head.appendChild(st); }
    var m = D.createElement('div'); m.id = 'nova-google-modal'; m.style.cssText = 'display:none;position:fixed;top:0;right:0;bottom:0;left:0;background:#020617;z-index:100000;flex-direction:column;color:#e2e8f0';
    m.innerHTML = '<div class="ng-head"><h3><i class="ph-bold ph-google-logo" style="color:#38bdf8"></i> Google 整合</h3><button onclick="NovaGoogle.close()" class="ng-x"><i class="ph-bold ph-x" style="font-size:20px"></i></button></div>' +
      '<div id="ng-tabs" class="ng-tabs"></div><div id="ng-body" class="ng-body"></div>';
    D.body.appendChild(m);
  }

  var CSS = '#nova-google-modal *{box-sizing:border-box}' +
    '#nova-google-modal .ng-head{display:flex;align-items:center;justify-content:space-between;padding:calc(env(safe-area-inset-top,0px) + 12px) 16px 12px;background:#0f172a;border-bottom:1px solid #1e293b;flex-shrink:0}' +
    '#nova-google-modal .ng-head h3{margin:0;font-size:16px;font-weight:700;color:#fff;display:flex;align-items:center;gap:8px}' +
    '#nova-google-modal .ng-x{background:#1e293b;color:#94a3b8;border:0;border-radius:8px;padding:6px;display:flex}' +
    '#nova-google-modal .ng-tabs{display:flex;gap:4px;padding:8px;background:#0f172a;border-bottom:1px solid #1e293b;flex-shrink:0;font-size:12px}' +
    '#nova-google-modal .ng-tab{flex:1;padding:8px 2px;border:0;border-radius:8px;font-weight:700;background:#1e293b;color:#94a3b8;font-size:12px}' +
    '#nova-google-modal .ng-tab.on{background:#0284c7;color:#fff}' +
    '#nova-google-modal .ng-body{flex:1;overflow-y:auto;padding:16px;font-size:14px;color:#e2e8f0;display:flex;flex-direction:column;gap:12px;-webkit-overflow-scrolling:touch}' +
    '#nova-google-modal .ng-body>*{flex-shrink:0}' +
    '#nova-google-modal .ng-in{display:block;width:100%;background:#020617;border:1px solid #334155;border-radius:8px;padding:8px;font-size:13px;color:#fff;outline:none}' +
    '#nova-google-modal .ng-in:focus{border-color:#0ea5e9}' +
    '#nova-google-modal .ng-btn{padding:8px 12px;border:0;border-radius:8px;font-size:12px;font-weight:700;color:#fff;background:#334155}' +
    '#nova-google-modal .ng-sky{background:#0284c7;color:#fff}#nova-google-modal .ng-gray{background:#334155;color:#e2e8f0}#nova-google-modal .ng-green{background:#059669;color:#fff}#nova-google-modal .ng-purple{background:#9333ea;color:#fff}' +
    '#nova-google-modal label{display:block}#nova-google-modal label:has(input[type=checkbox]){display:flex;align-items:center;gap:6px}' +
    '#nova-google-modal input[type=checkbox]{width:16px;height:16px;flex-shrink:0}' +
    '#nova-google-modal .flex{display:flex}#nova-google-modal .flex-wrap{flex-wrap:wrap}#nova-google-modal .gap-1{gap:4px}#nova-google-modal .gap-2{gap:8px}#nova-google-modal .gap-3{gap:12px}' +
    '#nova-google-modal .items-center{align-items:center}#nova-google-modal .justify-between{justify-content:space-between}#nova-google-modal .shrink-0{flex-shrink:0}' +
    '#nova-google-modal .space-y-2>*+*{margin-top:8px}#nova-google-modal .mt-2{margin-top:8px}#nova-google-modal .mt-3{margin-top:12px}#nova-google-modal .mb-2{margin-bottom:8px}#nova-google-modal .my-1{margin:4px 0}#nova-google-modal .my-2{margin:8px 0}#nova-google-modal .mr-2{margin-right:8px}' +
    '#nova-google-modal .text-xs{font-size:12px}#nova-google-modal .text-sm{font-size:14px}#nova-google-modal .font-bold,#nova-google-modal b{font-weight:700}' +
    '#nova-google-modal .text-slate-400{color:#94a3b8}#nova-google-modal .text-slate-300{color:#cbd5e1}#nova-google-modal .text-slate-500{color:#64748b}#nova-google-modal .text-amber-400{color:#fbbf24}#nova-google-modal .text-red-400{color:#f87171}#nova-google-modal .text-sky-400{color:#38bdf8}' +
    '#nova-google-modal .truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}#nova-google-modal .text-left{text-align:left}#nova-google-modal .w-full{width:100%}' +
    '#nova-google-modal .p-2{padding:8px}#nova-google-modal .p-3{padding:12px}#nova-google-modal .rounded-lg{border-radius:8px}#nova-google-modal .rounded-xl{border-radius:12px}' +
    '#nova-google-modal .border{border:1px solid #334155}#nova-google-modal .bg-slate-900{background:#0f172a}' +
    '#nova-google-modal .border-slate-800{border-color:#1e293b}#nova-google-modal .border-slate-700{border-color:#334155}#nova-google-modal .border-sky-600\\/60{border-color:rgba(2,132,199,.6)}#nova-google-modal .border-emerald-600\\/50{border-color:rgba(5,150,105,.5)}#nova-google-modal .bg-emerald-900\\/20{background:rgba(6,78,59,.2)}' +
    '#nova-google-modal button.w-full{display:block;background:#0f172a;color:#e2e8f0;border-width:1px;border-style:solid}' +
    '#nova-google-modal pre{white-space:pre-wrap;word-break:break-word;margin:0;max-height:40vh;overflow-y:auto;background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:8px;font-size:12px}' +
    '#nova-google-modal details{font-size:12px;color:#94a3b8}#nova-google-modal summary{cursor:pointer}' +
    '#nova-google-modal p{margin:0}#nova-google-modal .text-\\[11px\\]{font-size:11px}#nova-google-modal .text-\\[10px\\]{font-size:10px}' +
    '#ng-settings-btn button{padding:10px 14px;border:0;border-radius:10px;font-size:13px;font-weight:700;background:#0369a1;color:#fff;display:inline-flex;align-items:center;gap:6px}';
  var IN = 'ng-in';
  var BTN = 'ng-btn ';
  function render() {
    var m = D.getElementById('nova-google-modal'); if (!m || m.style.display === 'none') return;
    var tabs = [['main', '連接'], ['drive', '☁️ Drive 同步'], ['gmail', '✉️ Gmail'], ['docs', '📄 Docs']];
    D.getElementById('ng-tabs').innerHTML = tabs.map(function (t) { return '<button onclick="NovaGoogle.tab(\'' + t[0] + '\')" class="ng-tab ' + (tab === t[0] ? 'on' : '') + '">' + t[1] + '</button>'; }).join('');
    var b = D.getElementById('ng-body'), c = cfg();
    if (tab === 'main') {
      var sel = scopesSel();
      b.innerHTML = '<div class="p-3 rounded-xl border ' + (connected() ? 'border-emerald-600/50 bg-emerald-900/20' : 'border-slate-700 bg-slate-900') + '">' + (connected() ? '✅ 已連接：' + esc(g('nova_google_email', '(帳號)')) : '尚未連接 Google 帳號') + '</div>' +
        '<label class="block text-xs text-slate-400">Client ID（Web 應用程式類型）</label><input id="ng-cid" class="' + IN + '" value="' + esc(c.id) + '" placeholder="xxxx.apps.googleusercontent.com">' +
        '<label class="block text-xs text-slate-400">Client Secret</label><input id="ng-sec" type="password" class="' + IN + '" value="' + esc(c.secret) + '">' +
        '<label class="block text-xs text-slate-400">轉址 URI（需先登錄到該用戶端的「已授權的重新導向 URI」）</label><input id="ng-red" class="' + IN + '" value="' + esc(c.redir) + '">' +
        '<div class="flex flex-wrap gap-3 text-xs">' + ['drive', 'gmail', 'docs'].map(function (k) { return '<label class="flex items-center gap-1"><input type="checkbox" class="ng-sc" value="' + k + '"' + (sel.indexOf(k) !== -1 ? ' checked' : '') + '> ' + { drive: 'Drive（完整，才能讀到桌面版建立的同步檔）', gmail: 'Gmail 唯讀', docs: 'Docs' }[k] + '</label>'; }).join('') + '</div>' +
        '<div class="flex gap-2"><button class="' + BTN + 'ng-sky" onclick="NovaGoogle._saveCfg();NovaGoogle.connect()">連接 Google</button>' + (connected() ? '<button class="' + BTN + 'ng-gray" onclick="NovaGoogle.disconnect()">中斷連接</button>' : '') + '</div>' +
        '<details class="text-xs text-slate-400"><summary>授權後沒有自動跳回 App？</summary><p class="my-2">轉址頁會顯示一串網址；複製整串貼到下面按「完成連接」。</p><input id="ng-paste" class="' + IN + '" placeholder="貼上轉址後的完整網址或 code"><button class="' + BTN + 'ng-gray mt-2" onclick="NovaGoogle._paste()">完成連接</button></details>' +
        '<p class="text-[11px] text-slate-500">個人自用提示：OAuth 同意畫面若維持「測試中」，授權每 7 天會過期；切到「正式版」（不必送審）會出現未驗證警告但可繼續，授權不會過期。Gmail／Drive 完整權限屬 Google 的「受限範圍」。</p>';
    } else if (!connected()) { b.innerHTML = '<p class="text-slate-400">請先到「連接」分頁完成 Google 授權。</p>'; }
    else if (tab === 'drive') {
      b.innerHTML = (has('drive') ? '' : '<p class="text-amber-400 text-xs">目前授權不含 Drive，請到「連接」勾選 Drive 後重新連接。</p>') +
        '<p class="text-xs text-slate-400">與桌面版共用 Drive 內的 <b>' + SYNC_NAME + '</b>：任務與筆記雙向合併（較新者為準，含刪除）。桌面版的知識庫文件、資料夾、向量片段會原封保留，不會被手機覆蓋。</p>' +
        '<label class="flex items-center gap-2 text-xs"><input type="checkbox" id="ng-auto" ' + (syncOn() ? 'checked' : '') + ' onchange="localStorage.setItem(\'nova_gsync_enabled\',this.checked?\'1\':\'0\')"> 變更後自動同步（約 4 秒後）</label>' +
        '<label class="flex items-center gap-2 text-xs"><input type="checkbox" ' + (g('nova_gsync_kb', '1') !== '0' ? 'checked' : '') + ' onchange="localStorage.setItem(\'nova_gsync_kb\',this.checked?\'1\':\'0\')"> 同步知識庫（向量資料庫：文件／資料夾／片段；向量由收到端重算）</label>' +
        '<label class="flex items-center gap-2 text-xs"><input type="checkbox" ' + (g('nova_mem_sync_enabled', '1') !== '0' ? 'checked' : '') + ' onchange="localStorage.setItem(\'nova_mem_sync_enabled\',this.checked?\'1\':\'0\')"> 同步 AI 記憶（長期事實／對話摘要，檔案 NOVA_Memory_Sync.json，與桌面版共用）</label>' +
        '<button class="' + BTN + 'ng-green" onclick="NovaGoogle.sync(true)">立即同步</button>' +
        '<div id="ng-mem-status" class="text-xs text-slate-400">' + esc(g('nova_gmem_status', '')) + '</div>' +
        '<div id="ng-sync-status" class="text-xs text-slate-400">' + esc(g('nova_gsync_status', g('nova_gsync_last', '尚未同步'))) + '</div>';
    } else if (tab === 'gmail') {
      b.innerHTML = (has('gmail') ? '' : '<p class="text-amber-400 text-xs">目前授權不含 Gmail。</p>') +
        '<div class="flex gap-2"><input id="ng-gq" class="' + IN + '" placeholder="搜尋（Gmail 語法，例如 is:unread newer_than:2d）"><button class="' + BTN + 'ng-sky shrink-0" onclick="NovaGoogle._gmailLoad()">列出</button></div><div id="ng-gl" class="space-y-2"></div><div id="ng-gr" style="display:none"></div>';
      if (has('gmail')) _gmailLoad();
    } else if (tab === 'docs') {
      b.innerHTML = (has('docs') ? '' : '<p class="text-amber-400 text-xs">目前授權不含 Docs。</p>') +
        '<p class="text-xs text-slate-400">筆記 → Google 文件：到筆記中心，於下方選擇筆記。Google 文件 → 筆記：點下方文件。</p>' +
        '<div class="text-xs font-bold text-slate-300">匯出筆記為 Google 文件</div><div class="flex gap-2"><select id="ng-nsel" class="' + IN + '">' + appState.notes.slice(0, 80).map(function (n) { return '<option value="' + n.id + '">' + esc(n.title || '(無標題)') + '</option>'; }).join('') + '</select><button class="' + BTN + 'ng-green shrink-0" onclick="NovaGoogle._n2d()">匯出</button></div>' +
        '<div class="text-xs font-bold text-slate-300 mt-3">我的 Google 文件（最近 20 份）</div><div id="ng-dl" class="space-y-2 text-xs">載入中…</div>';
      if (has('docs') || has('drive')) docsList().then(function (fs) { var e = D.getElementById('ng-dl'); if (e) e.innerHTML = fs.map(function (f) { return '<div class="flex items-center justify-between bg-slate-900 border border-slate-800 rounded-lg p-2"><span class="truncate mr-2">' + esc(f.name) + '</span><button class="' + BTN + 'ng-gray shrink-0" onclick="NovaGoogle._d2n(\'' + f.id + '\',this)">轉成筆記</button></div>'; }).join('') || '沒有文件'; }).catch(function (e) { var x = D.getElementById('ng-dl'); if (x) x.textContent = '讀取失敗：' + e.message; });
    }
  }
  async function _gmailLoad() {
    var l = D.getElementById('ng-gl'); if (!l) return; l.innerHTML = '<p class="text-slate-400 text-xs">載入中…</p>';
    try { var ms = await gmailList((D.getElementById('ng-gq') || {}).value || '', 15); l.innerHTML = ms.map(function (m) { var unread = (m.labelIds || []).indexOf('UNREAD') !== -1; return '<button class="w-full text-left bg-slate-900 border ' + (unread ? 'border-sky-600/60' : 'border-slate-800') + ' rounded-lg p-2" onclick="NovaGoogle._gmailOpen(\'' + m.id + '\')"><div class="text-xs text-slate-400 truncate">' + esc(hdr(m, 'From')) + '</div><div class="text-sm ' + (unread ? 'font-bold' : '') + ' truncate">' + esc(hdr(m, 'Subject') || '(無主旨)') + '</div><div class="text-[10px] text-slate-500">' + esc(hdr(m, 'Date')) + '</div></button>'; }).join('') || '<p class="text-slate-400 text-xs">沒有符合的信件</p>'; }
    catch (e) { l.innerHTML = '<p class="text-red-400 text-xs">讀取失敗：' + esc(e.message) + '</p>'; }
  }
  var curMail = null;
  async function _gmailOpen(id) {
    var r = D.getElementById('ng-gr'), l = D.getElementById('ng-gl'); if (!r) return; l.style.display = 'none'; r.style.display = 'block'; r.innerHTML = '<p class="text-xs text-slate-400">讀取中…</p>';
    try { curMail = await gmailRead(id); r.innerHTML = '<button class="text-xs text-sky-400 mb-2" onclick="NovaGoogle._gmailBack()">← 返回列表</button><div class="text-xs text-slate-400">' + esc(curMail.from) + '<br>' + esc(curMail.date) + '</div><div class="font-bold my-1">' + esc(curMail.subject) + '</div><pre class="whitespace-pre-wrap text-xs bg-slate-900 border border-slate-800 rounded-lg p-2 max-h-[40vh] overflow-y-auto">' + esc(curMail.body.slice(0, 20000)) + '</pre><div class="flex gap-2 mt-2"><button class="' + BTN + 'ng-purple" onclick="NovaGoogle._gmailAI()">請 AI 摘要</button><button class="' + BTN + 'ng-gray" onclick="NovaGoogle._gmailNote()">存成筆記</button></div><div id="ng-ai" class="text-xs mt-2 whitespace-pre-wrap"></div>'; }
    catch (e) { r.innerHTML = '<p class="text-red-400 text-xs">讀取失敗：' + esc(e.message) + '</p>'; }
  }
  function _gmailBack() { D.getElementById('ng-gr').style.display = 'none'; D.getElementById('ng-gl').style.display = 'block'; }
  async function _gmailAI() {
    var o = D.getElementById('ng-ai'); if (!curMail || !o) return; o.textContent = 'AI 摘要中…';
    try { var res = await W.fetchAIResponse('請用繁體中文摘要下面這封信（重點、需要我做的事、期限）：\n\n寄件者：' + curMail.from + '\n主旨：' + curMail.subject + '\n\n' + curMail.body.slice(0, 12000), appState.currentModel, { enableSearch: false }); o.textContent = typeof res === 'string' ? res : (res.text || '(無回應)'); }
    catch (e) { o.textContent = '摘要失敗：' + e.message; }
  }
  function _gmailNote() { if (!curMail) return; var n = { id: Date.now(), title: '信件：' + (curMail.subject || '(無主旨)'), content: '寄件者：' + curMail.from + '\n日期：' + curMail.date + '\n\n' + curMail.body, isHtml: false, date: new Date().toLocaleString(), type: 'text', images: [], folder: '未分類' }; appState.notes.unshift(n); W.saveToDB('notes', n); try { W.renderNotes(); } catch (e) {} toast('✅ 已存成筆記'); }
  async function _n2d() { var sel = D.getElementById('ng-nsel'); if (!sel) return; toast('⏳ 匯出中…'); try { var u = await noteToDoc(sel.value); toast('✅ 已建立 Google 文件'); if (u) W.open(u, '_system'); } catch (e) { toast('❌ 匯出失敗：' + e.message, 5000); } }
  async function _d2n(id, btn) { if (btn) btn.disabled = true; try { var n = await docToNote(id); toast('✅ 已轉成筆記「' + n.title + '」'); } catch (e) { toast('❌ ' + e.message, 5000); if (btn) btn.disabled = false; } }
  function _saveCfg() {
    var v = function (id) { var e = D.getElementById(id); return e ? e.value.trim() : ''; };
    s('nova_key_google_client_id', v('ng-cid')); s('nova_key_google_client_secret', v('ng-sec')); s('nova_google_redirect', v('ng-red') || DEFAULT_REDIR);
    try { if (W.appState && appState.keys) { appState.keys.google_client_id = v('ng-cid'); appState.keys.google_client_secret = v('ng-sec'); } } catch (e) {}
    var sel = []; D.querySelectorAll('.ng-sc').forEach(function (x) { if (x.checked) sel.push(x.value); }); s('nova_google_scopes', JSON.stringify(sel));
  }
  function _paste() { var e = D.getElementById('ng-paste'); if (!e || !e.value.trim()) return; var v = e.value.trim(); handleRedirect(/^https?:|^nova120:|\?/.test(v) ? v : ('?code=' + encodeURIComponent(v))); }
  function open(t) { ensureModal(); if (t) tab = t; var m = D.getElementById('nova-google-modal'); m.style.display = 'flex'; render(); }
  function close() { var m = D.getElementById('nova-google-modal'); if (m) m.style.display = 'none'; }
  W.NovaGoogle = { _drive: { find: async function (n) { return await findByName(n); }, read: readJsonFile, write: writeNamed, trash: trashFile }, schedule: schedule, open: open, close: close, tab: function (t) { tab = t; render(); }, connect: connect, disconnect: disconnect, sync: syncNow, isConnected: connected, api: apiJson,
    gmailList: gmailList, gmailRead: gmailRead, noteToDoc: noteToDoc, docToNote: docToNote, handleRedirect: handleRedirect,
    _saveCfg: _saveCfg, _paste: _paste, _gmailLoad: _gmailLoad, _gmailOpen: _gmailOpen, _gmailBack: _gmailBack, _gmailAI: _gmailAI, _gmailNote: _gmailNote, _n2d: _n2d, _d2n: _d2n, VERSION: '1.0.0' };

  /* 入口：+選單按鈕、設定頁按鈕、深度連結 */
  function addEntries() {
    var grid = D.getElementById('plus-menu'); if (grid && !D.getElementById('nv-google-btn')) {
      var ref = grid.querySelector('button.nv-pm'); if (ref && ref.parentNode) {
        var b = D.createElement('button'); b.id = 'nv-google-btn'; b.className = 'nv-pm flex flex-col items-center justify-center gap-2 p-2 rounded-xl bg-slate-800 border border-sky-500/50 hover:bg-slate-700 text-sky-400 transition-colors active:scale-95'; b.style.setProperty('--pc', '#38bdf8');
        b.innerHTML = '<i class="ph-bold ph-google-logo text-xl"></i><span class="text-[10px] font-bold whitespace-nowrap">Google</span>'; b.onclick = function () { try { W.togglePlusMenu(); } catch (e) {} open('main'); };
        ref.parentNode.appendChild(b);
      }
    }
    var drv = D.getElementById('key-drive-url'); if (drv && !D.getElementById('ng-settings-btn')) {
      var holder = drv.parentNode; var sb = D.createElement('div'); sb.id = 'ng-settings-btn'; sb.className = 'mt-2';
      sb.innerHTML = '<button type="button" onclick="NovaGoogle.open(\'main\')"><i class="ph-bold ph-google-logo"></i> Google 整合（Drive 同步／Gmail／Docs）</button>'; holder.parentNode.insertBefore(sb, holder.nextSibling);
    }
  }
  function boot() {
    addEntries(); setInterval(addEntries, 3000);
    try { var A = W.Capacitor && Capacitor.Plugins && Capacitor.Plugins.App; if (A && A.addListener) A.addListener('appUrlOpen', function (e) { if (e && e.url && /^nova120:\/\/oauth/.test(e.url)) { try { var B = Capacitor.Plugins.Browser; if (B && B.close) B.close(); } catch (x) {} open('main'); handleRedirect(e.url); } }); } catch (e) {}
    if (connected() && has('drive') && syncOn()) setTimeout(function () { syncNow(false); }, 6000);
    D.addEventListener('visibilitychange', function () { if (!D.hidden && connected() && has('drive') && syncOn()) syncNow(false); });
  }
  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', boot); else boot();
})();

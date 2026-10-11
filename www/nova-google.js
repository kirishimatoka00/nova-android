/* nova-google.js — v1.0.0 (2026-10-11)
 * 手機版 Google 整合（階段 1~3）：App 內 OAuth（PKCE，系統瀏覽器＋GitHub Pages 轉址頁＋nova120://oauth 深度連結）、
 *   ① Drive 雙向同步：檔名 NOVA_Sync_Bundle.json，與桌面版同格式（todos／notes／deletedIds 做 last-write-wins 合併，
 *      其餘欄位 documents／folders／chunks 原封不動保留，不會被手機覆蓋）。
 *   ② Gmail 唯讀：列信、讀內文、請 AI 摘要。
 *   ③ Docs：筆記匯出成 Google 文件、把 Google 文件讀回成筆記。
 * 設定：Client ID／Client Secret 沿用桌面版同名設定（localStorage nova_key_google_client_id／_secret，會進備份）。
 *   需要「Web 應用程式」類型的 OAuth 用戶端，並把轉址 URI（預設 https://kirishimatoka00.github.io/nova-android/oauth.html）加進該用戶端。
 * 介面：+選單「Google」鈕、設定頁「Google 整合」鈕 → #nova-google-modal。
 * 版本紀錄
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
  async function syncNow(manual) {
    if (syncing) return; if (!connected() || !has('drive')) { if (manual) toast('⚠️ 請先連接 Google 並勾選 Drive'); return; }
    syncing = true; setStatus('同步中…');
    try {
      var todos = (await W.loadStoreFromDB('todos')).map(function (t) { return Object.assign({}, t, { _syncTs: t._syncTs || t.id || 0 }); });
      var notes = (await W.loadStoreFromDB('notes')).map(function (n) { return Object.assign({}, n, { _syncTs: n._syncTs || n.id || 0 }); });
      var localDel = appState.deletedIds || {};
      var files = await findFiles(), id = files.length ? files[0].id : null, remote = {};
      if (files.length > 1) { /* 多份同名：依修改時間由舊到新合併，保留最舊那份當正本 */
        for (var i = 0; i < files.length; i++) { try { var r = await readFile(files[i].id); remote = remote.todos ? Object.assign(remote, { todos: mergeById(remote.todos, r.todos, '_syncTs', {}), notes: mergeById(remote.notes, r.notes, '_syncTs', {}), deletedIds: mergeDel(remote.deletedIds, r.deletedIds) }) : r; } catch (e) {} }
      } else if (id) remote = await readFile(id);
      var del = mergeDel(localDel, remote.deletedIds);
      var mt = mergeById(todos, remote.todos, '_syncTs', del), mn = mergeById(notes, remote.notes, '_syncTs', del);
      var out = Object.assign({}, remote, { todos: mt, notes: mn, deletedIds: del });   // 其他欄位（documents／folders／chunks…）原封保留
      for (var a = 0; a < mt.length; a++) await putLocal('todos', mt[a]);
      for (var b = 0; b < mn.length; b++) await putLocal('notes', mn[b]);
      var keepT = {}, keepN = {}; mt.forEach(function (x) { keepT[String(x.id)] = 1; }); mn.forEach(function (x) { keepN[String(x.id)] = 1; });
      todos.forEach(function (x) { if (!keepT[String(x.id)]) W.deleteFromDB('todos', x.id); }); notes.forEach(function (x) { if (!keepN[String(x.id)]) W.deleteFromDB('notes', x.id); });
      appState.todos = mt.slice().sort(function (x, y) { return y.id - x.id; }); appState.notes = mn.slice().sort(function (x, y) { return y.id - x.id; });
      appState.deletedIds = del; s('nova_deleted_ids', JSON.stringify(del));
      try { W.renderTodos(); W.renderNotes(); } catch (e) {}
      var fid = await writeFile(id, out); s('nova_drive_sync_file_id', fid);
      var now = new Date().toLocaleString('zh-TW'); s('nova_gsync_last', now); setStatus('✅ 已同步 ' + now + '（任務 ' + mt.length + '／筆記 ' + mn.length + '）');
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
  async function noteToDoc(id) {
    var n = appState.notes.find(function (x) { return String(x.id) === String(id); }); if (!n) return;
    var doc = await apiJson('https://docs.googleapis.com/v1/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: n.title || '未命名筆記' }) });
    var text = noteText(n); if (text) await apiJson('https://docs.googleapis.com/v1/documents/' + doc.documentId + ':batchUpdate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text: text } }] }) });
    n.driveUrl = 'https://docs.google.com/document/d/' + doc.documentId + '/edit'; W.saveToDB('notes', n); try { W.renderNotes(); } catch (e) {}
    return n.driveUrl;
  }
  async function docsList() { var j = await apiJson('https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent("mimeType='application/vnd.google-apps.document' and trashed=false") + '&orderBy=modifiedTime desc&pageSize=20&fields=files(id,name,modifiedTime)'); return j.files || []; }
  async function docToNote(id, name) {
    var doc = await apiJson('https://docs.googleapis.com/v1/documents/' + id); var text = docText(doc).trim();
    var note = { id: Date.now(), title: doc.title || name || 'Google 文件', content: text, isHtml: false, date: new Date().toLocaleString(), type: 'text', images: [], folder: '未分類', driveUrl: 'https://docs.google.com/document/d/' + id + '/edit' };
    appState.notes.unshift(note); W.saveToDB('notes', note); try { W.renderNotes(); } catch (e) {}
    return note;
  }

  /* ───────── 介面 ───────── */
  function setStatus(t) { s('nova_gsync_status', t); var e = D.getElementById('ng-sync-status'); if (e) e.textContent = t; }
  var tab = 'main';
  function ensureModal() {
    if (D.getElementById('nova-google-modal')) return;
    var m = D.createElement('div'); m.id = 'nova-google-modal'; m.className = 'hidden fixed inset-0 bg-slate-950/95 flex-col'; m.style.zIndex = '100000';
    m.innerHTML = '<div class="flex items-center justify-between px-4 py-3 bg-slate-900 border-b border-slate-800 shrink-0" style="padding-top:calc(env(safe-area-inset-top,0px) + 12px)"><h3 class="text-base font-bold text-white flex items-center gap-2"><i class="ph-bold ph-google-logo text-sky-400"></i> Google 整合</h3><button onclick="NovaGoogle.close()" class="text-slate-400 bg-slate-800 p-1.5 rounded-lg"><i class="ph-bold ph-x text-xl"></i></button></div>' +
      '<div id="ng-tabs" class="flex gap-1 p-2 bg-slate-900 border-b border-slate-800 shrink-0 text-xs"></div><div id="ng-body" class="flex-1 overflow-y-auto p-4 space-y-3 text-sm text-slate-200"></div>';
    D.body.appendChild(m);
  }
  var IN = 'w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-xs text-white outline-none focus:border-sky-500';
  var BTN = 'px-3 py-2 rounded-lg text-xs font-bold ';
  function render() {
    var m = D.getElementById('nova-google-modal'); if (!m || m.classList.contains('hidden')) return;
    var tabs = [['main', '連接'], ['drive', '☁️ Drive 同步'], ['gmail', '✉️ Gmail'], ['docs', '📄 Docs']];
    D.getElementById('ng-tabs').innerHTML = tabs.map(function (t) { return '<button onclick="NovaGoogle.tab(\'' + t[0] + '\')" class="flex-1 py-2 rounded-lg font-bold ' + (tab === t[0] ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-400') + '">' + t[1] + '</button>'; }).join('');
    var b = D.getElementById('ng-body'), c = cfg();
    if (tab === 'main') {
      var sel = scopesSel();
      b.innerHTML = '<div class="p-3 rounded-xl border ' + (connected() ? 'border-emerald-600/50 bg-emerald-900/20' : 'border-slate-700 bg-slate-900') + '">' + (connected() ? '✅ 已連接：' + esc(g('nova_google_email', '(帳號)')) : '尚未連接 Google 帳號') + '</div>' +
        '<label class="block text-xs text-slate-400">Client ID（Web 應用程式類型）</label><input id="ng-cid" class="' + IN + '" value="' + esc(c.id) + '" placeholder="xxxx.apps.googleusercontent.com">' +
        '<label class="block text-xs text-slate-400">Client Secret</label><input id="ng-sec" type="password" class="' + IN + '" value="' + esc(c.secret) + '">' +
        '<label class="block text-xs text-slate-400">轉址 URI（需先登錄到該用戶端的「已授權的重新導向 URI」）</label><input id="ng-red" class="' + IN + '" value="' + esc(c.redir) + '">' +
        '<div class="flex flex-wrap gap-3 text-xs">' + ['drive', 'gmail', 'docs'].map(function (k) { return '<label class="flex items-center gap-1"><input type="checkbox" class="ng-sc" value="' + k + '"' + (sel.indexOf(k) !== -1 ? ' checked' : '') + '> ' + { drive: 'Drive（完整，才能讀到桌面版建立的同步檔）', gmail: 'Gmail 唯讀', docs: 'Docs' }[k] + '</label>'; }).join('') + '</div>' +
        '<div class="flex gap-2"><button class="' + BTN + 'bg-sky-600 text-white" onclick="NovaGoogle._saveCfg();NovaGoogle.connect()">連接 Google</button>' + (connected() ? '<button class="' + BTN + 'bg-slate-700 text-slate-200" onclick="NovaGoogle.disconnect()">中斷連接</button>' : '') + '</div>' +
        '<details class="text-xs text-slate-400"><summary>授權後沒有自動跳回 App？</summary><p class="my-2">轉址頁會顯示一串網址；複製整串貼到下面按「完成連接」。</p><input id="ng-paste" class="' + IN + '" placeholder="貼上轉址後的完整網址或 code"><button class="' + BTN + 'bg-slate-700 text-slate-200 mt-2" onclick="NovaGoogle._paste()">完成連接</button></details>' +
        '<p class="text-[11px] text-slate-500">個人自用提示：OAuth 同意畫面若維持「測試中」，授權每 7 天會過期；切到「正式版」（不必送審）會出現未驗證警告但可繼續，授權不會過期。Gmail／Drive 完整權限屬 Google 的「受限範圍」。</p>';
    } else if (!connected()) { b.innerHTML = '<p class="text-slate-400">請先到「連接」分頁完成 Google 授權。</p>'; }
    else if (tab === 'drive') {
      b.innerHTML = (has('drive') ? '' : '<p class="text-amber-400 text-xs">目前授權不含 Drive，請到「連接」勾選 Drive 後重新連接。</p>') +
        '<p class="text-xs text-slate-400">與桌面版共用 Drive 內的 <b>' + SYNC_NAME + '</b>：任務與筆記雙向合併（較新者為準，含刪除）。桌面版的知識庫文件、資料夾、向量片段會原封保留，不會被手機覆蓋。</p>' +
        '<label class="flex items-center gap-2 text-xs"><input type="checkbox" id="ng-auto" ' + (syncOn() ? 'checked' : '') + ' onchange="localStorage.setItem(\'nova_gsync_enabled\',this.checked?\'1\':\'0\')"> 變更後自動同步（約 4 秒後）</label>' +
        '<button class="' + BTN + 'bg-emerald-600 text-white" onclick="NovaGoogle.sync(true)">立即同步</button>' +
        '<div id="ng-sync-status" class="text-xs text-slate-400">' + esc(g('nova_gsync_status', g('nova_gsync_last', '尚未同步'))) + '</div>';
    } else if (tab === 'gmail') {
      b.innerHTML = (has('gmail') ? '' : '<p class="text-amber-400 text-xs">目前授權不含 Gmail。</p>') +
        '<div class="flex gap-2"><input id="ng-gq" class="' + IN + '" placeholder="搜尋（Gmail 語法，例如 is:unread newer_than:2d）"><button class="' + BTN + 'bg-sky-600 text-white shrink-0" onclick="NovaGoogle._gmailLoad()">列出</button></div><div id="ng-gl" class="space-y-2"></div><div id="ng-gr" class="hidden"></div>';
      if (has('gmail')) _gmailLoad();
    } else if (tab === 'docs') {
      b.innerHTML = (has('docs') ? '' : '<p class="text-amber-400 text-xs">目前授權不含 Docs。</p>') +
        '<p class="text-xs text-slate-400">筆記 → Google 文件：到筆記中心，於下方選擇筆記。Google 文件 → 筆記：點下方文件。</p>' +
        '<div class="text-xs font-bold text-slate-300">匯出筆記為 Google 文件</div><div class="flex gap-2"><select id="ng-nsel" class="' + IN + '">' + appState.notes.slice(0, 80).map(function (n) { return '<option value="' + n.id + '">' + esc(n.title || '(無標題)') + '</option>'; }).join('') + '</select><button class="' + BTN + 'bg-emerald-600 text-white shrink-0" onclick="NovaGoogle._n2d()">匯出</button></div>' +
        '<div class="text-xs font-bold text-slate-300 mt-3">我的 Google 文件（最近 20 份）</div><div id="ng-dl" class="space-y-2 text-xs">載入中…</div>';
      if (has('docs') || has('drive')) docsList().then(function (fs) { var e = D.getElementById('ng-dl'); if (e) e.innerHTML = fs.map(function (f) { return '<div class="flex items-center justify-between bg-slate-900 border border-slate-800 rounded-lg p-2"><span class="truncate mr-2">' + esc(f.name) + '</span><button class="' + BTN + 'bg-slate-700 text-slate-200 shrink-0" onclick="NovaGoogle._d2n(\'' + f.id + '\',this)">轉成筆記</button></div>'; }).join('') || '沒有文件'; }).catch(function (e) { var x = D.getElementById('ng-dl'); if (x) x.textContent = '讀取失敗：' + e.message; });
    }
  }
  async function _gmailLoad() {
    var l = D.getElementById('ng-gl'); if (!l) return; l.innerHTML = '<p class="text-slate-400 text-xs">載入中…</p>';
    try { var ms = await gmailList((D.getElementById('ng-gq') || {}).value || '', 15); l.innerHTML = ms.map(function (m) { var unread = (m.labelIds || []).indexOf('UNREAD') !== -1; return '<button class="w-full text-left bg-slate-900 border ' + (unread ? 'border-sky-600/60' : 'border-slate-800') + ' rounded-lg p-2" onclick="NovaGoogle._gmailOpen(\'' + m.id + '\')"><div class="text-xs text-slate-400 truncate">' + esc(hdr(m, 'From')) + '</div><div class="text-sm ' + (unread ? 'font-bold' : '') + ' truncate">' + esc(hdr(m, 'Subject') || '(無主旨)') + '</div><div class="text-[10px] text-slate-500">' + esc(hdr(m, 'Date')) + '</div></button>'; }).join('') || '<p class="text-slate-400 text-xs">沒有符合的信件</p>'; }
    catch (e) { l.innerHTML = '<p class="text-red-400 text-xs">讀取失敗：' + esc(e.message) + '</p>'; }
  }
  var curMail = null;
  async function _gmailOpen(id) {
    var r = D.getElementById('ng-gr'), l = D.getElementById('ng-gl'); if (!r) return; l.classList.add('hidden'); r.classList.remove('hidden'); r.innerHTML = '<p class="text-xs text-slate-400">讀取中…</p>';
    try { curMail = await gmailRead(id); r.innerHTML = '<button class="text-xs text-sky-400 mb-2" onclick="NovaGoogle._gmailBack()">← 返回列表</button><div class="text-xs text-slate-400">' + esc(curMail.from) + '<br>' + esc(curMail.date) + '</div><div class="font-bold my-1">' + esc(curMail.subject) + '</div><pre class="whitespace-pre-wrap text-xs bg-slate-900 border border-slate-800 rounded-lg p-2 max-h-[40vh] overflow-y-auto">' + esc(curMail.body.slice(0, 20000)) + '</pre><div class="flex gap-2 mt-2"><button class="' + BTN + 'bg-purple-600 text-white" onclick="NovaGoogle._gmailAI()">請 AI 摘要</button><button class="' + BTN + 'bg-slate-700 text-slate-200" onclick="NovaGoogle._gmailNote()">存成筆記</button></div><div id="ng-ai" class="text-xs mt-2 whitespace-pre-wrap"></div>'; }
    catch (e) { r.innerHTML = '<p class="text-red-400 text-xs">讀取失敗：' + esc(e.message) + '</p>'; }
  }
  function _gmailBack() { D.getElementById('ng-gr').classList.add('hidden'); D.getElementById('ng-gl').classList.remove('hidden'); }
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
  function open(t) { ensureModal(); if (t) tab = t; var m = D.getElementById('nova-google-modal'); m.classList.remove('hidden'); m.classList.add('flex'); render(); }
  function close() { var m = D.getElementById('nova-google-modal'); if (m) { m.classList.add('hidden'); m.classList.remove('flex'); } }
  W.NovaGoogle = { open: open, close: close, tab: function (t) { tab = t; render(); }, connect: connect, disconnect: disconnect, sync: syncNow, isConnected: connected, api: apiJson,
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
      sb.innerHTML = '<button type="button" class="px-3 py-2 rounded-lg text-xs font-bold bg-sky-700 text-white" onclick="NovaGoogle.open(\'main\')"><i class="ph-bold ph-google-logo"></i> Google 整合（Drive 同步／Gmail／Docs）</button>'; holder.parentNode.insertBefore(sb, holder.nextSibling);
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

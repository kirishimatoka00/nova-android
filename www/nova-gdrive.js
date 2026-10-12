/* nova-gdrive.js — v1.0.1 (2026-10-12)
 * ① 錄音／筆記音訊改走「Google Drive 授權」直接上傳（Drive 可續傳上傳，分段送出，沒有 Apps Script 的 10MB 限制）；
 *    已連接 Google 且授權含 Drive 時優先使用，否則維持原本 Apps Script 路徑。檔案放在雲端硬碟的「NOVA 錄音」資料夾。
 *    覆寫 window.manualUploadToDrive／uploadNoteAudioToDrive／batchUploadToDrive／backupNoteToDrive（沒授權時呼叫原函式）；
 *    index.html 的「有沒有雲端可用」判斷改用 novaHasDrive()（Apps Script URL 或 Google Drive 授權任一個即可）。
 * ② 「Google 整合」的 Docs 分頁改成「📁 雲端硬碟」：瀏覽資料夾／搜尋、開啟與編輯文字檔與 Google 文件（純文字）、轉成筆記、
 *    上傳檔案、新增資料夾與文字檔、匯出筆記（Google 文件／.md）、重新命名、移到垃圾桶、下載到手機。需要 Drive 授權。
 * 上傳細節：原生 App 內用 CapacitorHttp（base64 分段，每段 4MB，Content-Range）；瀏覽器環境用 fetch(Blob)。
 * 依賴：NovaGoogle（_raw／_has／_connected／_token）、loadAudioBlob／base64ToBlob／saveToDB／renderAudioRecords／renderNotes／showToast
 * 對外：window.NovaGDrive
 * 版本紀錄
 *   v1.0.1 2026-10-12  自動上傳（novaAutoUpload）：上傳期間保留前景服務、失敗進待上傳清單並在回到前景時重試、顯示失敗原因
 *   v1.0.0 2026-10-11  首版。誠實聲明：只在沙盒用模擬的 Drive 端點驗證流程（瀏覽器路徑）；原生 CapacitorHttp 的分段上傳（308 回應處理）
 *                      與下載到手機未在真機驗證，請先用小檔案實測，再試大檔案
 */
(function () {
  'use strict';
  var W = window, D = document, LS = W.localStorage;
  var CHUNK = 4 * 1024 * 1024;
  var G = function () { return W.NovaGoogle; };
  function toast(m, d) { try { W.showToast(m, d); } catch (e) {} }
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function g(k, d) { try { var v = LS.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function s(k, v) { try { LS.setItem(k, v); } catch (e) {} }
  function canUpload() { return !!(G() && G()._connected() && G()._has('drive') && g('nova_gdrive_upload', '1') !== '0'); }
  function native() { return !!(W.Capacitor && W.Capacitor.isNativePlatform && W.Capacitor.isNativePlatform() && W.Capacitor.Plugins && W.Capacitor.Plugins.CapacitorHttp); }
  W.novaHasDrive = function () { try { return !!(W.appState && appState.driveUrl) || canUpload(); } catch (e) { return false; } };
  function api(url, opts) { return G()._raw(url, opts); }
  async function apiJson(url, opts) { var r = await api(url, opts); var t = await r.text(), j; try { j = JSON.parse(t); } catch (e) { j = { raw: t }; } if (!r.ok) throw new Error((j.error && (j.error.message || j.error)) || ('HTTP ' + r.status)); return j; }
  function b64(blob) { return new Promise(function (res, rej) { var fr = new FileReader(); fr.onloadend = function () { res(String(fr.result).split(',')[1] || ''); }; fr.onerror = rej; fr.readAsDataURL(blob); }); }
  function hget(h, n) { if (!h) return ''; if (typeof h.get === 'function') return h.get(n) || ''; var k = Object.keys(h).find(function (x) { return x.toLowerCase() === n.toLowerCase(); }); return k ? h[k] : ''; }

  /* ───────── 資料夾 ───────── */
  async function ensureFolder(name) {
    var key = 'nova_gdrive_folder_' + name, id = g(key, '');
    if (id) { try { var f = await apiJson('https://www.googleapis.com/drive/v3/files/' + id + '?fields=id,trashed'); if (f && f.id && !f.trashed) return id; } catch (e) {} }
    var q = "name='" + name.replace(/'/g, "\\'") + "' and mimeType='application/vnd.google-apps.folder' and 'root' in parents and trashed=false";
    var j = await apiJson('https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) + '&fields=files(id)&pageSize=1');
    if (j.files && j.files.length) id = j.files[0].id;
    else id = (await apiJson('https://www.googleapis.com/drive/v3/files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name, mimeType: 'application/vnd.google-apps.folder' }) })).id;
    s(key, id); return id;
  }

  /* ───────── 可續傳上傳（無大小限制） ───────── */
  async function nativeReq(method, url, headers, data, isFile) {
    var o = { url: url, method: method, headers: headers, disableRedirects: true, responseType: 'text' };
    if (data != null) { o.data = data; if (isFile) o.dataType = 'file'; }
    var r = await W.Capacitor.Plugins.CapacitorHttp.request(o);
    return { status: r.status, headers: r.headers || {}, data: r.data };
  }
  /* opts: {parent:folderId, folder:'名稱'(放根目錄下的此資料夾), onProgress(pct), fileId(更新既有檔案內容)} → {id, webViewLink, name} */
  async function uploadBlob(blob, filename, mime, opts) {
    opts = opts || {}; var tk = await G()._token();
    mime = mime || blob.type || 'application/octet-stream';
    var parent = opts.parent || (opts.folder ? await ensureFolder(opts.folder) : null);
    var meta = { name: filename, mimeType: mime }; if (parent && !opts.fileId) meta.parents = [parent];
    var initUrl = opts.fileId ? 'https://www.googleapis.com/upload/drive/v3/files/' + opts.fileId + '?uploadType=resumable&fields=id,name,webViewLink' : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,webViewLink';
    var ih = { Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(blob.size) };
    var loc, init;
    if (native()) init = await nativeReq(opts.fileId ? 'PATCH' : 'POST', initUrl, ih, opts.fileId ? JSON.stringify({}) : JSON.stringify(meta), false);
    else { var r0 = await fetch(initUrl, { method: opts.fileId ? 'PATCH' : 'POST', headers: ih, body: opts.fileId ? '{}' : JSON.stringify(meta) }); init = { status: r0.status, headers: r0.headers, data: await r0.text() }; }
    if (init.status < 200 || init.status >= 300) throw new Error('建立上傳工作失敗 HTTP ' + init.status + '：' + String(typeof init.data === 'string' ? init.data : JSON.stringify(init.data)).slice(0, 160));
    loc = hget(init.headers, 'location'); if (!loc) throw new Error('Drive 沒有回傳上傳位址');
    var size = blob.size, off = 0, last = null;
    if (!size) { /* 空檔案：直接一次送出 */ var re = native() ? await nativeReq('PUT', loc, { 'Content-Length': '0' }, '', false) : { status: (await fetch(loc, { method: 'PUT', body: '' })).status, data: '{}' }; return JSON.parse(typeof re.data === 'string' ? re.data || '{}' : JSON.stringify(re.data)); }
    while (off < size) {
      var end = Math.min(size, off + CHUNK), part = blob.slice(off, end), res, tries = 0;
      for (;;) {
        try {
          var ch = { 'Content-Range': 'bytes ' + off + '-' + (end - 1) + '/' + size, 'Content-Type': mime };
          if (native()) res = await nativeReq('PUT', loc, ch, await b64(part), true);
          else { var rr = await fetch(loc, { method: 'PUT', headers: ch, body: part }); res = { status: rr.status, headers: rr.headers, data: await rr.text() }; }
          if (res.status === 200 || res.status === 201 || res.status === 308) break;
          throw new Error('HTTP ' + res.status + '：' + String(typeof res.data === 'string' ? res.data : JSON.stringify(res.data)).slice(0, 160));
        } catch (e) {
          if (++tries >= 3) throw new Error('上傳中斷（已傳 ' + Math.round(off / 1048576) + ' MB）：' + (e.message || e));
          await new Promise(function (r) { setTimeout(r, 800 * tries); });
        }
      }
      off = end; if (opts.onProgress) { try { opts.onProgress(Math.round(off * 100 / size)); } catch (e) {} }
      if (res.status === 200 || res.status === 201) { last = res; break; }
    }
    if (!last) throw new Error('上傳未完成（Drive 沒有回傳完成訊號）');
    var out = typeof last.data === 'string' ? JSON.parse(last.data || '{}') : (last.data || {});
    if (!out.id) throw new Error('上傳完成但沒有取得檔案 ID');
    out.webViewLink = out.webViewLink || ('https://drive.google.com/file/d/' + out.id + '/view');
    return out;
  }

  /* ───────── 音訊／筆記上傳覆寫 ───────── */
  var orig = { manual: W.manualUploadToDrive, note: W.uploadNoteAudioToDrive, batch: W.batchUploadToDrive, backup: W.backupNoteToDrive };
  function audioName(rec, blob) { var mime = rec.mimeType || blob.type || 'audio/webm', ext = mime.indexOf('mp4') !== -1 ? '.m4a' : mime.indexOf('mpeg') !== -1 ? '.mp3' : mime.indexOf('wav') !== -1 ? '.wav' : '.weba'; return String(rec.title || rec.filename || ('NOVA_Audio_' + rec.id)).replace(/[\\/:*?"<>|]/g, '_') + ext; }
  async function getBlob(rec) { var b = await W.loadAudioBlob(rec.id); if (!b && rec.audioData) b = W.base64ToBlob(rec.audioData); return b; }
  async function uploadRecord(rec, store, label) {
    var blob = await getBlob(rec); if (!blob) throw new Error('找不到本地音訊資料');
    var mb = (blob.size / 1048576).toFixed(1), name = rec.type === 'audio' && rec.filename && store === 'notes' ? rec.filename : audioName(rec, blob);
    toast('☁️ 上傳至 Google Drive（' + mb + ' MB）…', 4000);
    var last = -10;
    var f = await uploadBlob(blob, name, rec.mimeType || blob.type || 'audio/webm', { folder: 'NOVA 錄音', onProgress: function (p) { if (p - last >= 20) { last = p; toast('☁️ ' + (label || '') + '上傳中 ' + p + '%（' + mb + ' MB）', 2500); } } });
    rec.driveUrl = f.webViewLink; W.saveToDB(store, rec); return f;
  }
  /* ───────── v1.0.1 自動上傳：保留前景服務＋失敗進待上傳清單，回前景重試 ───────── */
  var PK = 'nova_gdrive_pending', running = false;
  function pend() { try { return JSON.parse(g(PK, '[]')); } catch (e) { return []; } }
  function setPend(a) { s(PK, JSON.stringify(a.slice(-50))); }
  function pendAdd(kind, id) { var a = pend(); if (!a.some(function (x) { return x.k === kind && x.id === id; })) { a.push({ k: kind, id: id }); setPend(a); } }
  function pendDel(kind, id) { setPend(pend().filter(function (x) { return !(x.k === kind && x.id === id); })); }
  async function runPending(fromVisible) {
    if (running || !canUpload()) { if (!canUpload() && W._novaPreHold) { W._novaPreHold = false; try { W.novaFgsRelease(); } catch (e) {} } return; }
    var list = pend(); if (!list.length) return;
    running = true; try { W.novaFgsAcquire(); } catch (e) {}
    if (W._novaPreHold) { W._novaPreHold = false; try { W.novaFgsRelease(); } catch (e) {} }   // 歸還「錄音結束」時預先借的那一份
    try {
      for (var i = 0; i < list.length; i++) {
        var it = list[i], arr = it.k === 'notes' ? appState.notes : appState.audioRecords;
        var rec = arr.find(function (x) { return String(x.id) === String(it.id); });
        if (!rec || rec.driveUrl) { pendDel(it.k, it.id); continue; }
        try { await uploadRecord(rec, it.k, '自動上傳 '); pendDel(it.k, it.id); toast('✅ 已自動上傳至 Google Drive「NOVA 錄音」資料夾'); try { W.renderAudioRecords(); W.renderNotes(); } catch (e) {} }
        catch (e) { toast('❌ 自動上傳失敗：' + (e.message || e) + '（回到 App 時會自動重試，也可手動上傳）', 7000); }
      }
    } finally { running = false; try { W.novaFgsRelease(); } catch (e) {} }
  }
  W.novaAutoUpload = function (kind, id) { pendAdd(kind, String(id)); return runPending(false); };
  D.addEventListener('visibilitychange', function () { if (!D.hidden && pend().length) setTimeout(function () { runPending(true); }, 2500); });
  setTimeout(function () { if (pend().length) runPending(true); }, 8000);

  W.manualUploadToDrive = async function (id) {
    if (!canUpload()) return orig.manual ? orig.manual.apply(this, arguments) : toast('⚠️ 請先連接 Google 或設定 Apps Script URL');
    var rec = appState.audioRecords.find(function (x) { return String(x.id) === String(id); }); if (!rec) return;
    var card = D.getElementById('audio-card-' + id), btn = card ? card.querySelector('button[onclick*="manualUploadToDrive"]') : null, html0 = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ph-bold ph-spinner animate-spin"></i> 上傳中…'; }
    try { await uploadRecord(rec, 'audioRecords'); toast('✅ 已上傳至 Google Drive「NOVA 錄音」資料夾'); try { W.renderAudioRecords(); } catch (e) {} }
    catch (e) { toast('❌ 上傳失敗：' + (e.message || e), 6000); if (btn) { btn.disabled = false; btn.innerHTML = html0; } }
  };
  W.uploadNoteAudioToDrive = async function (id) {
    if (!canUpload()) return orig.note ? orig.note.apply(this, arguments) : undefined;
    var note = appState.notes.find(function (x) { return String(x.id) === String(id); }); if (!note || note.driveUrl) return;
    try { await uploadRecord(note, 'notes', '筆記音訊'); toast('✅ 筆記音訊已上傳至 Google Drive'); try { W.renderNotes(); } catch (e) {} }
    catch (e) { console.warn('uploadNoteAudioToDrive', e); toast('❌ 筆記音訊上傳失敗：' + (e.message || e), 5000); }
  };
  W.batchUploadToDrive = async function (groupIds) {
    if (!canUpload()) return orig.batch ? orig.batch.apply(this, arguments) : undefined;
    var ids = Array.isArray(groupIds) ? groupIds : [groupIds], ok = 0;
    for (var i = 0; i < ids.length; i++) {
      var rec = appState.audioRecords.find(function (x) { return String(x.id) === String(ids[i]); }) || appState.notes.find(function (x) { return String(x.id) === String(ids[i]); }); if (!rec) continue;
      try { await uploadRecord(rec, appState.audioRecords.indexOf(rec) !== -1 ? 'audioRecords' : 'notes', '第 ' + (i + 1) + '/' + ids.length + ' 段 '); ok++; }
      catch (e) { toast('❌ 第 ' + (i + 1) + ' 段上傳失敗：' + (e.message || e), 5000); }
    }
    toast('✅ 上傳完成（' + ok + '/' + ids.length + ' 段成功）'); try { W.renderAudioRecords(); W.renderNotes(); } catch (e) {}
  };
  W.backupNoteToDrive = async function (id) {
    if (!canUpload()) return orig.backup ? orig.backup.apply(this, arguments) : undefined;
    var n = appState.notes.find(function (x) { return String(x.id) === String(id); }); if (!n) return;
    var btn = D.getElementById('btn-backup-' + id), html0 = btn ? btn.innerHTML : '';
    if (btn) { btn.innerHTML = '<i class="ph-bold ph-spinner animate-spin"></i> 備份中...'; btn.disabled = true; }
    try {
      if (n.type === 'audio') await uploadRecord(n, 'notes', '筆記音訊');
      else {
        var imgs = n.images || (n.image ? [n.image] : []);
        var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + esc(n.title) + '</title></head><body style="font-family:sans-serif;padding:20px"><h1>' + esc(n.title) + '</h1><p style="color:gray">' + esc(n.date || '') + '</p><div>' + (n.isHtml ? n.content : esc(n.content || '').replace(/\n/g, '<br>')) + '</div>' + imgs.map(function (im) { return '<img src="' + im + '" style="max-width:100%;border-radius:8px;margin-top:10px"><br>'; }).join('') + '</body></html>';
        var f = await uploadBlob(new Blob([html], { type: 'text/html' }), (n.title || '筆記').replace(/[\\/:*?"<>|]/g, '_') + '.html', 'text/html', { folder: 'NOVA 筆記' });
        n.driveUrl = f.webViewLink; W.saveToDB('notes', n);
      }
      try { W.renderNotes(); } catch (e) {} toast('✅ 已備份至 Google Drive');
    } catch (e) { toast('❌ 備份失敗：' + (e.message || e), 6000); }
    if (btn) { btn.innerHTML = html0 || '<i class="ph-bold ph-cloud-arrow-up"></i> 雲端備份'; btn.disabled = false; }
  };

  /* ───────── 雲端硬碟瀏覽器（Google 整合視窗的第四個分頁） ───────── */
  var FOLDER = 'application/vnd.google-apps.folder', GDOC = 'application/vnd.google-apps.document';
  var st = { stack: [{ id: 'root', name: '我的雲端硬碟' }], q: '', items: [], next: '', busy: false, editing: null, el: null };
  function isText(f) { return /^text\//.test(f.mimeType) || /json|xml|javascript|csv|markdown|x-sh|yaml/.test(f.mimeType) || /\.(txt|md|csv|json|xml|html?|js|css|py|log|ini|yml|yaml|srt|vtt)$/i.test(f.name || ''); }
  function isGNative(f) { return /^application\/vnd\.google-apps\./.test(f.mimeType); }
  function icon(f) { return f.mimeType === FOLDER ? '📁' : f.mimeType === GDOC ? '📄' : /spreadsheet/.test(f.mimeType) ? '📊' : /presentation/.test(f.mimeType) ? '📽️' : /^audio\//.test(f.mimeType) ? '🎙️' : /^image\//.test(f.mimeType) ? '🖼️' : /pdf/.test(f.mimeType) ? '📕' : isText(f) ? '📝' : '📎'; }
  function size(n) { n = Number(n); if (!n) return ''; return n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }
  var cur = function () { return st.stack[st.stack.length - 1]; };
  var FIELDS = 'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink)';
  async function load(more) {
    if (st.busy) return; st.busy = true; paintStatus('載入中…');
    try {
      var q = st.q ? "name contains '" + st.q.replace(/'/g, "\\'") + "' and trashed=false" : "'" + cur().id + "' in parents and trashed=false";
      var url = 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) + '&fields=' + encodeURIComponent(FIELDS) + '&pageSize=50&orderBy=' + encodeURIComponent('folder,name') + (more && st.next ? '&pageToken=' + encodeURIComponent(st.next) : '');
      var j = await apiJson(url); st.items = more ? st.items.concat(j.files || []) : (j.files || []); st.next = j.nextPageToken || ''; paintStatus('');
    } catch (e) { paintStatus('❌ ' + (e.message || e)); }
    st.busy = false; paintList();
  }
  function $(id) { return D.getElementById(id); }
  function paintStatus(t) { var e = $('ngd-status'); if (e) e.textContent = t; }
  function paintList() {
    var l = $('ngd-list'); if (!l) return;
    l.innerHTML = st.items.map(function (f, i) {
      return '<div class="ngd-row"><div class="ngd-main" onclick="NovaGDrive._tap(' + i + ')"><span class="ngd-ic">' + icon(f) + '</span><span class="ngd-nm"><b>' + esc(f.name) + '</b><small>' + esc((f.modifiedTime || '').slice(0, 10)) + (f.size ? '・' + size(f.size) : '') + '</small></span></div>' +
        (f.mimeType === FOLDER ? '' : '<button class="ng-btn ng-gray" onclick="NovaGDrive._menu(' + i + ')">⋯</button>') + '</div>';
    }).join('') || '<p class="text-slate-400 text-xs">這裡沒有檔案</p>';
    if (st.next) l.innerHTML += '<button class="ng-btn ng-gray" style="width:100%;margin-top:8px" onclick="NovaGDrive._more()">載入更多</button>';
  }
  function crumbs() { return st.q ? '🔍 搜尋「' + esc(st.q) + '」 <a href="#" onclick="NovaGDrive._clearSearch();return false" style="color:#38bdf8">清除</a>' : st.stack.map(function (c, i) { return '<a href="#" onclick="NovaGDrive._goto(' + i + ');return false" style="color:' + (i === st.stack.length - 1 ? '#e2e8f0' : '#38bdf8') + '">' + esc(c.name) + '</a>'; }).join(' › '); }
  function render(b) {
    st.el = b;
    if (!G()._has('drive')) { b.innerHTML = '<p class="text-amber-400 text-xs">目前授權不含 Drive，請到「連接」勾選 Drive 後重新連接。</p>'; return; }
    if (st.editing) return renderEditor();
    b.innerHTML = '<style>#nova-google-modal .ngd-row{display:flex;align-items:center;gap:6px;background:#0f172a;border:1px solid #1e293b;border-radius:10px;padding:6px 8px;margin-bottom:6px}#nova-google-modal .ngd-main{flex:1;min-width:0;display:flex;align-items:center;gap:8px}#nova-google-modal .ngd-ic{font-size:20px}#nova-google-modal .ngd-nm{display:flex;flex-direction:column;min-width:0}#nova-google-modal .ngd-nm b{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}#nova-google-modal .ngd-nm small{font-size:10px;color:#64748b}#nova-google-modal .ngd-dlg{position:absolute;left:0;right:0;top:0;bottom:0;background:rgba(2,6,23,.85);display:flex;align-items:center;justify-content:center;padding:20px;z-index:5}#nova-google-modal .ngd-box{background:#0f172a;border:1px solid #334155;border-radius:14px;padding:16px;width:100%;max-width:340px;display:flex;flex-direction:column;gap:10px}</style>' +
      '<div class="text-xs" id="ngd-crumb" style="line-height:1.8">' + crumbs() + '</div>' +
      '<div class="flex gap-2"><input id="ngd-q" class="' + 'ng-in' + '" placeholder="搜尋檔名" value="' + esc(st.q) + '" onkeydown="if(event.key===\'Enter\')NovaGDrive._search()"><button class="ng-btn ng-sky shrink-0" onclick="NovaGDrive._search()">搜尋</button></div>' +
      '<div class="flex flex-wrap gap-2"><button class="ng-btn ng-green" onclick="NovaGDrive._pick()">⬆️ 上傳檔案</button><button class="ng-btn ng-gray" onclick="NovaGDrive._mkdir()">📁 新增資料夾</button><button class="ng-btn ng-gray" onclick="NovaGDrive._newText()">📝 新增文字檔</button><button class="ng-btn ng-gray" onclick="NovaGDrive._exportNote()">📤 匯出筆記</button><button class="ng-btn ng-gray" onclick="NovaGDrive._refresh()">🔄</button></div>' +
      '<input type="file" id="ngd-file" multiple style="display:none" onchange="NovaGDrive._upload(this)">' +
      '<div id="ngd-status" class="text-xs text-slate-400"></div><div id="ngd-list"></div><div id="ngd-dlg-host"></div>';
    paintList(); load(false);
  }
  function refreshCrumb() { var e = $('ngd-crumb'); if (e) e.innerHTML = crumbs(); }

  /* 視窗內的小對話框（App 內建的 prompt／confirm 會被 Google 視窗蓋住，所以自己做） */
  function dlg(html, onMount) { var h = $('ngd-dlg-host'); if (!h) return; h.innerHTML = '<div class="ngd-dlg"><div class="ngd-box">' + html + '</div></div>'; if (onMount) onMount(h); }
  function closeDlg() { var h = $('ngd-dlg-host'); if (h) h.innerHTML = ''; }
  function ask(title, def, ok) { dlg('<div class="font-bold text-sm">' + esc(title) + '</div><input id="ngd-in" class="ng-in" value="' + esc(def || '') + '"><div class="flex gap-2"><button class="ng-btn ng-gray" style="flex:1" onclick="NovaGDrive._dlgNo()">取消</button><button class="ng-btn ng-sky" style="flex:1" onclick="NovaGDrive._dlgOk()">確定</button></div>', function () { var i = $('ngd-in'); if (i) { i.focus(); i.select(); } }); st.dlgOk = function () { var v = ($('ngd-in') || {}).value || ''; closeDlg(); ok(v.trim()); }; }
  function sure(msg, ok) { dlg('<div class="text-sm">' + esc(msg) + '</div><div class="flex gap-2"><button class="ng-btn ng-gray" style="flex:1" onclick="NovaGDrive._dlgNo()">取消</button><button class="ng-btn ng-sky" style="flex:1" onclick="NovaGDrive._dlgOk()">確定</button></div>'); st.dlgOk = function () { closeDlg(); ok(); }; }

  /* 檔案操作 */
  async function readText(f) {
    var url = isGNative(f) ? 'https://www.googleapis.com/drive/v3/files/' + f.id + '/export?mimeType=' + encodeURIComponent('text/plain') : 'https://www.googleapis.com/drive/v3/files/' + f.id + '?alt=media';
    var r = await api(url), t = await r.text(); if (!r.ok) { var j = {}; try { j = JSON.parse(t); } catch (e) {} throw new Error((j.error && j.error.message) || 'HTTP ' + r.status); }
    return t.replace(/^﻿/, '');
  }
  function renderEditor() {
    var f = st.editing, b = st.el; if (!b) return;
    b.innerHTML = '<div class="font-bold text-sm">' + icon(f) + ' ' + esc(f.name) + '</div>' + (isGNative(f) ? '<p class="text-amber-400 text-xs">Google 文件以純文字編輯，儲存後會用純文字取代全文，原本的格式（粗體、表格、圖片）會消失。建議只在純文字文件使用，或另存成新檔。</p>' : '') +
      '<textarea id="ngd-ed" class="ng-in" style="min-height:48vh;font-family:monospace;line-height:1.5">' + esc(f.text) + '</textarea>' +
      '<div class="flex gap-2"><button class="ng-btn ng-green" onclick="NovaGDrive._saveEdit()">💾 儲存回 Drive</button><button class="ng-btn ng-gray" onclick="NovaGDrive._toNote()">轉成筆記</button><button class="ng-btn ng-gray" onclick="NovaGDrive._closeEdit()">返回</button></div><div id="ngd-status" class="text-xs text-slate-400"></div><div id="ngd-dlg-host"></div>';
  }
  async function openFile(f) {
    paintStatus('讀取中…');
    try { var t = await readText(f); st.editing = { id: f.id, name: f.name, mimeType: f.mimeType, text: t, isNew: false }; renderEditor(); }
    catch (e) { paintStatus('❌ 讀取失敗：' + (e.message || e)); }
  }
  async function saveEdit() {
    var f = st.editing, ta = $('ngd-ed'); if (!f || !ta) return; var text = ta.value; paintStatus('儲存中…');
    try {
      if (f.isNew) {
        var nf = await uploadBlob(new Blob([text], { type: f.mimeType || 'text/plain' }), f.name, f.mimeType || 'text/plain', { parent: cur().id });
        f.id = nf.id; f.isNew = false; f.mimeType = f.mimeType || 'text/plain';
      } else if (f.mimeType === GDOC) {
        var r = await api('https://www.googleapis.com/upload/drive/v3/files/' + f.id + '?uploadType=media', { method: 'PATCH', headers: { 'Content-Type': 'text/plain; charset=UTF-8' }, body: text }); if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 120));
      } else { await uploadBlob(new Blob([text], { type: f.mimeType || 'text/plain' }), f.name, f.mimeType || 'text/plain', { fileId: f.id }); }
      f.text = text; paintStatus('✅ 已儲存 ' + new Date().toLocaleTimeString()); toast('✅ 已儲存回 Google Drive');
    } catch (e) { paintStatus('❌ 儲存失敗：' + (e.message || e)); }
  }
  function toNote(text, title) {
    var note = { id: Date.now(), title: title || 'Drive 檔案', content: text, isHtml: false, date: new Date().toLocaleString(), type: 'text', images: [], folder: '未分類' };
    appState.notes.unshift(note); W.saveToDB('notes', note); try { W.renderNotes(); } catch (e) {} toast('✅ 已轉成筆記「' + note.title + '」');
  }
  async function download(f) {
    try {
      paintStatus('下載中…'); var Fs = W.Capacitor && W.Capacitor.Plugins && W.Capacitor.Plugins.Filesystem;
      if (isGNative(f)) { W.open(f.webViewLink, '_system'); paintStatus(''); return; }
      var r = await api('https://www.googleapis.com/drive/v3/files/' + f.id + '?alt=media'); if (!r.ok) throw new Error('HTTP ' + r.status);
      var blob = await r.blob();
      if (Fs) { var data = await b64(blob), path = 'NOVA/Drive/' + f.name.replace(/[\\/:*?"<>|]/g, '_'); await Fs.writeFile({ path: path, data: data, directory: 'DOCUMENTS', recursive: true }); paintStatus('✅ 已存到 文件/' + path); toast('✅ 已下載到 文件/' + path, 5000); }
      else { var a = D.createElement('a'); a.href = URL.createObjectURL(blob); a.download = f.name; D.body.appendChild(a); a.click(); a.remove(); paintStatus('✅ 已下載'); }
    } catch (e) { paintStatus('❌ 下載失敗：' + (e.message || e)); }
  }
  function menu(i) {
    var f = st.items[i]; if (!f) return;
    var btns = [];
    if (isText(f) || f.mimeType === GDOC) btns.push(['✏️ 開啟／編輯', 'edit'], ['📥 轉成筆記', 'note']);
    if (!isGNative(f)) btns.push(['⬇️ 下載到手機', 'dl']);
    btns.push(['🌐 用瀏覽器開啟', 'web'], ['🏷️ 重新命名', 'ren'], ['🗑️ 移到垃圾桶', 'del']);
    dlg('<div class="font-bold text-sm" style="word-break:break-all">' + esc(f.name) + '</div>' + btns.map(function (x) { return '<button class="ng-btn ng-gray" style="text-align:left;padding:10px 12px" onclick="NovaGDrive._act(' + i + ',\'' + x[1] + '\')">' + x[0] + '</button>'; }).join('') + '<button class="ng-btn ng-gray" onclick="NovaGDrive._dlgNo()">關閉</button>');
  }
  async function act(i, a) {
    var f = st.items[i]; closeDlg(); if (!f) return;
    try {
      if (a === 'edit') return openFile(f);
      if (a === 'note') { paintStatus('讀取中…'); var t = await readText(f); paintStatus(''); return toNote(t, f.name.replace(/\.[^.]+$/, '')); }
      if (a === 'dl') return download(f);
      if (a === 'web') return void W.open(f.webViewLink || ('https://drive.google.com/file/d/' + f.id + '/view'), '_system');
      if (a === 'ren') return ask('重新命名', f.name, async function (v) { if (!v) return; try { await apiJson('https://www.googleapis.com/drive/v3/files/' + f.id + '?fields=id', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: v }) }); load(false); } catch (e) { paintStatus('❌ ' + (e.message || e)); } });
      if (a === 'del') return sure('把「' + f.name + '」移到 Drive 垃圾桶？（30 天內可在 Drive 還原）', async function () { try { await apiJson('https://www.googleapis.com/drive/v3/files/' + f.id + '?fields=id', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) }); toast('🗑️ 已移到垃圾桶'); load(false); } catch (e) { paintStatus('❌ ' + (e.message || e)); } });
    } catch (e) { paintStatus('❌ ' + (e.message || e)); }
  }
  async function uploadFiles(inp) {
    var fs = Array.prototype.slice.call(inp.files || []); inp.value = ''; if (!fs.length) return;
    for (var i = 0; i < fs.length; i++) {
      var f = fs[i], lastP = -10;
      try { await uploadBlob(f, f.name, f.type || 'application/octet-stream', { parent: cur().id, onProgress: function (p) { if (p - lastP >= 10) { lastP = p; paintStatus('⬆️ ' + f.name + ' ' + p + '%（' + (i + 1) + '/' + fs.length + '）'); } } }); }
      catch (e) { paintStatus('❌ ' + f.name + '：' + (e.message || e)); toast('❌ 上傳失敗：' + (e.message || e), 5000); return; }
    }
    toast('✅ 已上傳 ' + fs.length + ' 個檔案'); load(false);
  }
  function exportNote() {
    var opts = appState.notes.slice(0, 80).map(function (n) { return '<option value="' + n.id + '">' + esc(n.title || '(無標題)') + '</option>'; }).join('');
    dlg('<div class="font-bold text-sm">匯出筆記到目前資料夾</div><select id="ngd-nsel" class="ng-in">' + opts + '</select><select id="ngd-nfmt" class="ng-in"><option value="doc">Google 文件</option><option value="md">Markdown／文字檔（.md）</option></select><div class="flex gap-2"><button class="ng-btn ng-gray" style="flex:1" onclick="NovaGDrive._dlgNo()">取消</button><button class="ng-btn ng-sky" style="flex:1" onclick="NovaGDrive._dlgOk()">匯出</button></div>');
    st.dlgOk = async function () {
      var id = ($('ngd-nsel') || {}).value, fmt = ($('ngd-nfmt') || {}).value; closeDlg(); var n = appState.notes.find(function (x) { return String(x.id) === String(id); }); if (!n) return;
      paintStatus('匯出中…');
      try {
        var plain = n.isHtml ? (function () { var d = D.createElement('div'); d.innerHTML = String(n.content || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n'); return d.textContent; })() : String(n.content || '');
        if (fmt === 'doc') {
          var html = '<html><head><meta charset="utf-8"></head><body>' + (n.isHtml ? String(n.content || '') : '<p>' + esc(plain).replace(/\n/g, '<br>') + '</p>') + '</body></html>', bd = 'novaB' + Date.now();
          var body = '--' + bd + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify({ name: n.title || '未命名筆記', mimeType: GDOC, parents: [cur().id] }) + '\r\n--' + bd + '\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n' + html + '\r\n--' + bd + '--';
          var j = await apiJson('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + bd }, body: body }); n.driveUrl = 'https://docs.google.com/document/d/' + j.id + '/edit';
        } else { var f = await uploadBlob(new Blob(['# ' + (n.title || '') + '\n\n' + plain], { type: 'text/markdown' }), (n.title || '筆記').replace(/[\\/:*?"<>|]/g, '_') + '.md', 'text/markdown', { parent: cur().id }); n.driveUrl = f.webViewLink; }
        W.saveToDB('notes', n); toast('✅ 已匯出'); load(false);
      } catch (e) { paintStatus('❌ 匯出失敗：' + (e.message || e)); }
    };
  }

  W.NovaGDrive = {
    version: '1.0.0', canUpload: canUpload, uploadBlob: uploadBlob, render: render,
    _tap: function (i) { var f = st.items[i]; if (!f) return; if (f.mimeType === FOLDER) { st.q = ''; st.stack.push({ id: f.id, name: f.name }); render(st.el); } else if (isText(f) || f.mimeType === GDOC) openFile(f); else menu(i); },
    _menu: menu, _act: act, _more: function () { load(true); }, _refresh: function () { load(false); },
    _goto: function (i) { st.q = ''; st.stack = st.stack.slice(0, i + 1); render(st.el); },
    _search: function () { st.q = (($('ngd-q') || {}).value || '').trim(); load(false); refreshCrumb(); },
    _clearSearch: function () { st.q = ''; render(st.el); },
    _pick: function () { var e = $('ngd-file'); if (e) e.click(); }, _upload: uploadFiles,
    _mkdir: function () { ask('新資料夾名稱', '', async function (v) { if (!v) return; try { await apiJson('https://www.googleapis.com/drive/v3/files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: v, mimeType: FOLDER, parents: [cur().id] }) }); load(false); } catch (e) { paintStatus('❌ ' + (e.message || e)); } }); },
    _newText: function () { ask('新文字檔名稱（例如 筆記.txt）', '新文字檔.txt', function (v) { if (!v) return; st.editing = { id: '', name: v, mimeType: /\.md$/i.test(v) ? 'text/markdown' : 'text/plain', text: '', isNew: true }; renderEditor(); }); },
    _exportNote: exportNote, _saveEdit: saveEdit, _closeEdit: function () { st.editing = null; render(st.el); },
    _toNote: function () { var f = st.editing, ta = $('ngd-ed'); if (f && ta) toNote(ta.value, f.name.replace(/\.[^.]+$/, '')); },
    _dlgOk: function () { if (st.dlgOk) st.dlgOk(); }, _dlgNo: closeDlg
  };
})();

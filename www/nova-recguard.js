/* nova-recguard.js v1.0.0 (2026-10-12) — 錄音保全與診斷
 * 目的：關螢幕長時間錄音後「整段沒錄到」時，(1) 不再因頁面被系統終止而遺失錄音，(2) 留下可讀的診斷紀錄。
 * 做法：包裝 MediaRecorder，每個資料片段即時寫入 IndexedDB（nova_recguard）；
 *       下次啟動若發現「沒有正常結束」的錄音，自動組回並存成錄音紀錄；同時顯示診斷摘要。
 * 變更紀錄：v1.0.0 初版
 */
(function () {
  'use strict';
  var W = window, Orig = W.MediaRecorder, PAGE_T0 = Date.now();
  if (!Orig || W._novaRecGuard) return;
  W._novaRecGuard = true;

  /* ---------- 診斷紀錄（localStorage，最多 150 行） ---------- */
  var DK = 'nova_rec_diag', BK = 'nova_rec_beat';
  function ts() { var d = new Date(); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2); }
  function log(msg) {
    try { var a = JSON.parse(localStorage.getItem(DK) || '[]'); a.push(ts() + ' ' + msg); if (a.length > 150) a = a.slice(-150); localStorage.setItem(DK, JSON.stringify(a)); } catch (e) {}
  }
  function readLog() { try { return JSON.parse(localStorage.getItem(DK) || '[]'); } catch (e) { return []; } }

  /* ---------- IndexedDB ---------- */
  var dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (res, rej) {
      var r = indexedDB.open('nova_recguard', 1);
      r.onupgradeneeded = function () { var d = r.result; d.createObjectStore('sessions', { keyPath: 'sid' }); d.createObjectStore('chunks', { keyPath: 'k' }); };
      r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); };
    });
    return dbp;
  }
  function tx(store, mode, fn) {
    return db().then(function (d) { return new Promise(function (res, rej) { var t = d.transaction(store, mode), s = t.objectStore(store), out = fn(s); t.oncomplete = function () { res(out && out.result !== undefined ? out.result : undefined); }; t.onerror = t.onabort = function () { rej(t.error); }; }); });
  }
  function putSession(s) { return tx('sessions', 'readwrite', function (st) { st.put(s); }).catch(function (e) { log('寫入診斷失敗：' + (e && e.name)); }); }
  function putChunk(k, blob) { return tx('chunks', 'readwrite', function (st) { st.put({ k: k, b: blob }); }).catch(function () {}); }
  function allOf(store) { return tx(store, 'readonly', function (st) { return st.getAll(); }); }
  function delSession(sid, n) {
    return db().then(function (d) { return new Promise(function (res) { var t = d.transaction(['sessions', 'chunks'], 'readwrite'); t.objectStore('sessions').delete(sid); var c = t.objectStore('chunks'); for (var i = 0; i < n; i++) c.delete(sid + '|' + i); t.oncomplete = t.onerror = t.onabort = function () { res(); }; }); }).catch(function () {});
  }

  /* ---------- 心跳：頁面被凍結／被終止時留下線索 ---------- */
  var active = 0, lastBeat = Date.now();
  setInterval(function () {
    var now = Date.now(), gap = now - lastBeat; lastBeat = now;
    if (!active) return;
    if (gap > 25000) log('⚠ JS 約暫停 ' + Math.round(gap / 1000) + ' 秒（螢幕關閉／系統凍結頁面）');
    try { localStorage.setItem(BK, JSON.stringify({ t: now, rec: active })); } catch (e) {}
  }, 10000);
  document.addEventListener('visibilitychange', function () { if (active) log('頁面' + (document.hidden ? '進入背景（隱藏）' : '回到前景')); });
  document.addEventListener('freeze', function () { if (active) log('⚠ 系統凍結頁面（freeze）'); });
  document.addEventListener('resume', function () { if (active) log('頁面解凍（resume）'); });
  W.addEventListener('pagehide', function () { if (active) log('⚠ pagehide（頁面被卸載／終止）'); });

  /* ---------- 包裝 MediaRecorder ---------- */
  function Wrapped(stream, opts) {
    var mr = opts === undefined ? new Orig(stream) : new Orig(stream, opts);
    try { hook(mr, stream); } catch (e) {}
    return mr;
  }
  Wrapped.prototype = Orig.prototype;
  Wrapped.isTypeSupported = Orig.isTypeSupported.bind(Orig);
  W.MediaRecorder = Wrapped;

  function hook(mr, stream) {
    var sid = Date.now() + '-' + Math.random().toString(36).slice(2, 6), seq = 0, bytes = 0, started = 0, stopCalled = false, counted = false;
    var origStop = mr.stop.bind(mr);
    mr.stop = function () { stopCalled = true; return origStop(); };
    mr.addEventListener('start', function () {
      started = Date.now(); if (!counted) { counted = true; active++; }
      putSession({ sid: sid, start: started, mime: mr.mimeType || 'audio/webm', ended: false, n: 0 });
      log('錄音器開始 ' + sid.slice(-4) + '（' + (mr.mimeType || '?') + '）');
      try {
        stream.getAudioTracks().forEach(function (t) {
          t.addEventListener('mute', function () { log('⚠ 麥克風音軌被系統靜音（mute）'); });
          t.addEventListener('unmute', function () { log('麥克風音軌恢復（unmute）'); });
          t.addEventListener('ended', function () { log('⚠ 麥克風音軌被終止（ended）'); });
        });
      } catch (e) {}
    });
    mr.addEventListener('dataavailable', function (e) {
      if (!e.data || !e.data.size) return;
      bytes += e.data.size; var k = sid + '|' + seq++;
      putChunk(k, e.data);
      if (seq % 30 === 0) putSession({ sid: sid, start: started, mime: mr.mimeType || 'audio/webm', ended: false, n: seq });
    });
    mr.addEventListener('error', function (e) { log('⚠ 錄音器錯誤：' + ((e.error && e.error.name) || e.type)); });
    mr.addEventListener('stop', function () {
      if (counted) { counted = false; active = Math.max(0, active - 1); }
      var sec = started ? Math.round((Date.now() - started) / 1000) : 0;
      log('錄音器停止 ' + sid.slice(-4) + '（' + (stopCalled ? '程式主動' : '⚠ 非程式主動／被系統中止') + '，' + sec + ' 秒，' + Math.round(bytes / 1024) + 'KB）');
      // 正常結束：標記完成；片段保留一小段時間後由啟動清理
      putSession({ sid: sid, start: started, mime: mr.mimeType || 'audio/webm', ended: true, n: seq, endedAt: Date.now() });
      if (!active) { try { localStorage.removeItem(BK); } catch (e) {} }
    });
  }

  /* ---------- 啟動時：還原未正常結束的錄音 ＋ 顯示診斷 ---------- */
  function say(t) { try { if (typeof addMessage === 'function') addMessage(t, 'system'); } catch (e) {} }
  async function recover() {
    var beat = null; try { beat = JSON.parse(localStorage.getItem(BK) || 'null'); } catch (e) {}
    var sessions = [], chunks = [];
    try { sessions = await allOf('sessions'); } catch (e) { return; }
    var recovered = 0, tooShort = 0;
    for (var i = 0; i < sessions.length; i++) {
      var s = sessions[i];
      if (s.start >= PAGE_T0 - 1000) continue;   // 本頁面正在進行的錄音，不是遺留的
      if (s.ended) { if (Date.now() - (s.endedAt || 0) > 24 * 3600 * 1000) await delSession(s.sid, s.n + 1000); continue; }
      // 未結束：把所有片段撈回（用連續編號探測）
      var parts = [];
      for (var q = 0; q < 100000; q++) {
        var c = await tx('chunks', 'readonly', function (st) { return st.get(s.sid + '|' + q); }).catch(function () { return null; });
        if (!c) break; parts.push(c.b);
      }
      if (parts.length >= 10 && typeof processAndSaveAudioSegment === 'function') {
        try {
          if (typeof appState !== 'undefined') appState.recGroupId = null;
          var blob = new Blob(parts, { type: s.mime || 'audio/webm' });
          await processAndSaveAudioSegment([blob], s.mime || 'audio/webm', s.start, 'record', false);
          recovered++; log('已還原未正常結束的錄音（' + parts.length + ' 片段，約 ' + parts.length + ' 秒）');
        } catch (e) { log('還原失敗：' + (e && e.message)); continue; }
      } else tooShort++;
      await delSession(s.sid, parts.length + 5);
    }
    if (recovered || (beat && beat.rec)) {
      var lines = readLog().slice(-14).join('\n');
      say('🛟 偵測到上次錄音沒有正常結束' + (beat ? '（最後心跳 ' + new Date(beat.t).toLocaleTimeString() + '）' : '') + '。' +
          (recovered ? '已自動還原 ' + recovered + ' 段到「錄音紀錄」。' : '沒有可還原的內容。') + '\n診斷紀錄（最後 14 行）：\n' + lines);
      try { localStorage.removeItem(BK); } catch (e) {}
    }
  }
  W.novaShowRecDiag = function () { say('🔍 錄音診斷紀錄：\n' + (readLog().slice(-40).join('\n') || '（無紀錄）')); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(recover, 4000); });
  else setTimeout(recover, 4000);
})();

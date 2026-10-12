/* nova-nativerec.js v1.0.1 (2026-10-12) — 原生錄音（Android）
 * 為什麼：WebView 的 MediaRecorder 在關螢幕長時間錄音時，頁面可能被系統凍結／回收（閃退），錄音就整段遺失。
 * 做法：錄音改由 Android 前景服務裡的原生 MediaRecorder 負責（AAC/ADTS 串流檔，原生端自己每 N 分鐘換檔＝自動分切）。
 *       JS 端只負責：開始／停止、把已結束的段落取回並存成錄音紀錄／語音筆記。WebView 當掉也不影響錄音，
 *       下次開啟會自動把遺留的段落找回來。非 Android 或原生失敗時，自動退回原本的 WebView 錄音。
 * 限制（誠實聲明）：只能在真機驗證；原生分切換檔時有極短（約 0.1–0.3 秒）的空檔；錄音期間不支援系統音訊混錄（手機本來就沒有）。
 * 開關：localStorage nova_native_rec（預設開，設定→錄音可關）
 * 版本紀錄：v1.0.1 修正大段落（約 1 小時）取回時一次傳整個 base64 造成 App 閃退；改分段讀檔，並加防閃退迴圈（同一檔案失敗 3 次先跳過）
 *           v1.0.0 初版
 */
(function () {
  'use strict';
  var W = window, D = document;
  var NR = { active: false, ctx: 'record', lastSid: null, timer: null, busy: false };
  function P() { return W.Capacitor && W.Capacitor.Plugins && W.Capacitor.Plugins.RecordingService; }
  function FS() { return W.Capacitor && W.Capacitor.Plugins && W.Capacitor.Plugins.Filesystem; }
  function isAndroid() { try { return W.Capacitor && W.Capacitor.getPlatform && W.Capacitor.getPlatform() === 'android'; } catch (e) { return false; } }
  function enabled() { try { return localStorage.getItem('nova_native_rec') !== '0'; } catch (e) { return true; } }
  function can() { return isAndroid() && enabled() && !!P() && !!FS() && (!W.appState || appState.translateMode === 'off'); }
  function msg(t) { try { addMessage(t, 'system'); } catch (e) {} }
  function toast(t, d) { try { showToast(t, d || 4000); } catch (e) {} }
  function ui(on) {
    var el = D.getElementById('recording-status'); if (!el) return;
    if (on) { el.classList.remove('hidden'); el.classList.add('flex'); var t = D.getElementById('recording-status-text'); if (t) t.innerText = '錄音中... (點擊停止)'; }
    else { el.classList.add('hidden'); el.classList.remove('flex'); }
  }
  W._nativeRecActive = false;
  function setActive(v) { NR.active = v; W._nativeRecActive = v; }

  function b64ToBlob(b64, mime) {
    var bin = atob(b64), n = bin.length, CH = 1 << 20, parts = [];
    for (var o = 0; o < n; o += CH) { var l = Math.min(CH, n - o), u = new Uint8Array(l); for (var i = 0; i < l; i++) u[i] = bin.charCodeAt(o + i); parts.push(u); }
    return new Blob(parts, { type: mime });
  }
  // v1.0.1：分段讀檔（每次約 0.75MB）。v1.0.0 一次把整檔 base64 傳過橋接，1 小時（約 29MB）的段落會讓 App 崩潰，重開又重試 → 一進 App 就閃退
  async function readSeg(path, size) {
    var CH = 786432, off = 0, parts = [];
    for (;;) {
      var r = await P().readChunk({ path: path, offset: off, length: CH });
      if (!r || !r.read) break;
      var bin = atob(r.data), u = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      parts.push(u); off += r.read;
      if (size && off >= size) break;
    }
    return new Blob(parts, { type: 'audio/aac' });
  }
  /* 防閃退迴圈：同一個檔案嘗試處理超過 3 次仍沒成功（很可能每次都讓 App 崩潰）就先跳過，讓 App 能正常開啟 */
  function tries(path) { try { return parseInt(localStorage.getItem('nova_nr_try_' + path) || '0') || 0; } catch (e) { return 0; } }
  function setTries(path, n) { try { if (n) localStorage.setItem('nova_nr_try_' + path, String(n)); else localStorage.removeItem('nova_nr_try_' + path); } catch (e) {} }

  /* 把原生端已結束的段落取回，存成錄音紀錄／語音筆記 */
  async function ingest() {
    if (NR.busy || !P()) return 0;
    NR.busy = true; var saved = 0;
    try {
      var r = await P().listFinished(), segs = (r && r.segments) || [];
      for (var i = 0; i < segs.length; i++) {
        var s = segs[i];
        try {
          var tn = tries(s.path);
          if (tn >= 3) { if (!NR.warned) { NR.warned = true; msg('⚠️ 有一段錄音（' + s.path.split('/').pop() + '，' + Math.round((s.size || 0) / 1048576) + 'MB）處理失敗多次，已先跳過以免 App 閃退；檔案仍在手機的 App 資料夾內。'); } continue; }
          setTries(s.path, tn + 1);
          var blob = await readSeg(s.path, s.size);
          if (!blob || blob.size < 2048) { await P().ackSegment({ path: s.path }); continue; }
          if (NR.lastSid !== s.sid) { appState.recGroupId = null; NR.lastSid = s.sid; }
          var cx = s.ctx === 'note' ? 'note' : 'record';
          appState.recordingContext = cx; appState.currentAudioTranscript = '';
          var isSeg = (s.segCount > 1) || !s.sessionEnded;
          await processAndSaveAudioSegment([blob], 'audio/aac', Date.now() - (s.durationMs || 0), cx, isSeg);
          await P().ackSegment({ path: s.path }); setTries(s.path, 0); saved++;
          if (s.sessionEnded && s.index >= s.segCount - 1) { appState.recGroupId = null; NR.lastSid = null; }
        } catch (e) {
          console.warn('[NativeRec] 段落處理失敗', e);
          toast('❌ 錄音段落處理失敗：' + (e.message || e) + '（檔案仍保留在手機，下次會重試）', 7000);
          break;
        }
      }
    } catch (e) { console.warn('[NativeRec] listFinished 失敗', e); }
    NR.busy = false;
    if (!NR.active) { appState.recordingContext = 'default'; appState.currentAudioTranscript = ''; }
    return saved;
  }

  async function tick() {
    if (!P()) return;
    if (NR.active) {
      try {
        var st = await P().getRecStatus();
        if (st && !st.recording) {           // 原生端自己停了（例如換檔失敗）
          setActive(false); stopPoll(); ui(false);
          msg('⚠️ 原生錄音已停止' + (st.error ? '：' + st.error : '') + '，已錄到的部分會儲存。');
          try { await stopRecordingForegroundService(); } catch (e) {}
        }
      } catch (e) {}
    }
    await ingest();
  }
  function startPoll() { stopPoll(); NR.timer = setInterval(tick, 5000); }
  function stopPoll() { if (NR.timer) { clearInterval(NR.timer); NR.timer = null; } }

  async function nativeStart() {
    var cx = appState.recordingContext === 'note' ? 'note' : 'record';
    try {
      await P().startRecording({ ctx: cx, splitMins: appState.recSettings.autoSplitMins || 0 });
    } catch (e) { console.warn('[NativeRec] 啟動失敗，退回 WebView 錄音：', e); toast('原生錄音啟動失敗，改用一般錄音：' + (e.message || e), 5000); return false; }
    setActive(true); NR.ctx = cx; appState.recGroupId = null; NR.lastSid = null;
    ui(true); startPoll();
    msg((cx === 'note' ? '🎙️ 開始錄製「語音筆記」' : '🎙️ 開始錄音') + '（原生錄音：關螢幕、App 被系統回收也不會中斷，點擊上方紅燈停止）');
    return true;
  }

  async function nativeStop() {
    setActive(false); stopPoll();
    try {   // 與 v2.6.47 相同：要自動上傳雲端時，先借住前景服務直到上傳完成
      if ((appState.recSettings.autoUploadAudio || appState.recSettings.autoUploadNotes) && typeof novaHasDrive === 'function' && novaHasDrive() && !W._novaPreHold) {
        W._novaPreHold = true; novaFgsAcquire();
        setTimeout(function () { if (W._novaPreHold) { W._novaPreHold = false; novaFgsRelease(); } }, 10 * 60 * 1000);
      }
    } catch (e) {}
    try { await P().stopRecording(); } catch (e) { console.warn(e); }
    ui(false); msg('⏹️ 錄音結束，正在處理並儲存...');
    await ingest();
    appState.recGroupId = null; appState.recordingContext = 'default'; appState.currentAudioTranscript = '';
    try { await stopRecordingForegroundService(); } catch (e) {}
  }

  var oStart = W.startAudioRecording, oMeet = W.startMeetingRecording, oStop = W.stopAudioRecording;
  W.startAudioRecording = async function (customCtx) {
    if (customCtx) appState.recordingContext = customCtx;
    if (can() && !NR.active) { if (await nativeStart()) return; }
    return oStart.apply(this, arguments);
  };
  W.startMeetingRecording = async function (context) {
    if (can() && !NR.active) {
      appState.recordingContext = context || 'record';
      try { switchTab('dashboard'); } catch (e) {}
      appState.currentAudioTranscript = '';
      if (await nativeStart()) return;
    }
    return oMeet.apply(this, arguments);
  };
  W.stopAudioRecording = function () {
    if (NR.active) return nativeStop();
    return oStop.apply(this, arguments);
  };

  /* 啟動時：若原生錄音還在進行（WebView 重載過）就接回畫面；並找回遺留的段落 */
  async function boot() {
    if (!isAndroid() || !P()) return;
    try {
      var st = await P().getRecStatus();
      if (st && st.recording) {
        setActive(true); NR.ctx = st.ctx === 'note' ? 'note' : 'record'; ui(true); startPoll();
        msg('🔄 偵測到原生錄音仍在進行，已接回錄音狀態。');
      }
    } catch (e) { return; }
    var n = await ingest();
    if (n) msg('🛟 已找回 ' + n + ' 段上次沒處理完的錄音，存到「錄音紀錄」。');
  }
  D.addEventListener('visibilitychange', function () { if (!D.hidden && P()) setTimeout(tick, 800); });
  setTimeout(boot, 4500);

  /* 設定→錄音：開關 */
  function injectToggle() {
    var tab = D.getElementById('tab-rec'); if (!tab || D.getElementById('nova-native-rec-card')) return;
    var box = D.createElement('div'); box.id = 'nova-native-rec-card';
    box.style.cssText = 'background:rgba(30,41,59,.6);border:1px solid #334155;border-radius:12px;padding:14px;margin-bottom:12px;';
    box.innerHTML = '<label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer;"><input type="checkbox" id="nova-native-rec-cb" style="margin-top:3px;width:18px;height:18px;">' +
      '<span><b style="font-size:13px;color:#e2e8f0;">使用原生錄音（建議）</b><br><span style="font-size:11px;color:#94a3b8;line-height:1.5;">由 Android 前景服務直接錄音（AAC 格式），關螢幕、WebView 閃退都不會中斷或遺失；自動分切也由原生端執行。關閉則使用原本的 WebView 錄音（webm）。</span></span></label>';
    tab.insertBefore(box, tab.firstChild);
    var cb = D.getElementById('nova-native-rec-cb'); cb.checked = enabled();
    cb.onchange = function () { try { localStorage.setItem('nova_native_rec', cb.checked ? '1' : '0'); } catch (e) {} toast(cb.checked ? '已啟用原生錄音' : '已改用 WebView 錄音'); };
  }
  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', injectToggle); else injectToggle();
  setTimeout(injectToggle, 3000);
  W.NovaNativeRec = { ingest: ingest, state: NR };
})();

/* nova-schedule-pro.js — v1.0.0 (2026-10-11)
 * 手機版「任務管理」對標桌面 v3.7.0+：新增任務視窗分成「🤖 AI排程任務」與「🔔 一般提醒」兩個分頁。
 *   AI排程任務：到時間讓 AI 實際執行（一般對話／聯網查詢／生成圖片／AI 自主模式／技能範本重播），資料格式與聊天室語意排程
 *   （askScheduleTaskType）完全一致：isAutoTask / taskQuery / taskType（replay 另有 replayFile / replayLoopCount），
 *   觸發邏輯在 index.html 的 checkReminders。一般提醒：純鬧鐘＋通知，不呼叫 AI。
 *   兩者都可「同步到手機行事曆」（CalEngine）。桌面版的「同步到 Google 行事曆」依賴桌面 sidecar，手機版沒有，所以不放（評估見回覆）。
 * 版本紀錄
 *   v1.0.0 2026-10-11  首版：移植桌面的新增任務邏輯（分頁切換、執行方式、技能範本選單、重複、行事曆同步）。
 */
(function () {
  'use strict';
  var W = window;
  W._novaAddTodoType = 'reminder';

  W.addTodoManually = function () {
    var modal = document.getElementById('add-todo-modal');
    if (!modal) { console.error('[NOVA] add-todo-modal 找不到'); return; }
    function v(id, val) { var e = document.getElementById(id); if (e) e.value = val; }
    v('add-todo-text', ''); v('add-todo-time', ''); v('add-todo-repeat', '0'); v('add-todo-ai-prompt', ''); v('add-todo-ai-mode', 'general'); v('add-todo-replay-loop-count', '1');
    W._novaOnAddTodoModeChange('general');
    var cal = document.getElementById('add-todo-cal-sync');
    if (cal) {
      try { cal.checked = (typeof CalEngine !== 'undefined' && typeof CalEngine.getSettings === 'function') ? !!CalEngine.getSettings().syncTodos : false; }
      catch (e) { cal.checked = false; }
    }
    W._novaSwitchTodoTypeTab('reminder');
    modal.classList.remove('hidden'); modal.style.display = 'flex';
  };

  W._novaSwitchTodoTypeTab = function (type) {
    W._novaAddTodoType = type;
    var aiTab = document.getElementById('add-todo-type-tab-ai'), remTab = document.getElementById('add-todo-type-tab-reminder');
    var aiFields = document.getElementById('add-todo-ai-fields'), desc = document.getElementById('add-todo-type-desc');
    var label = document.getElementById('add-todo-text-label'), input = document.getElementById('add-todo-text'), tl = document.getElementById('add-todo-time-label');
    var act = ['bg-blue-600', 'text-white'], inact = ['text-slate-400', 'hover:text-white'];
    if (aiTab && remTab) {
      [aiTab, remTab].forEach(function (b) { act.concat(inact).forEach(function (c) { b.classList.remove(c); }); });
      (type === 'ai' ? act : inact).forEach(function (c) { aiTab.classList.add(c); });
      (type === 'ai' ? inact : act).forEach(function (c) { remTab.classList.add(c); });
    }
    if (aiFields) aiFields.classList.toggle('hidden', type !== 'ai');
    if (desc) desc.textContent = type === 'ai'
      ? '到時間會讓 AI 實際執行下面描述的事情——查資料、生成圖片、整理內容、啟動 AI 自主模式，或重播先前存好的技能範本。'
      : '到時間單純跳出提醒通知，不會呼叫 AI，適合當鬧鐘／提醒用。';
    if (label) label.textContent = type === 'ai' ? '任務標題（必填，會顯示在提醒／紀錄裡）' : '提醒標題（必填）';
    if (input) input.placeholder = type === 'ai' ? '例如：每日新聞摘要' : '例如：吃藥、開會提醒';
    if (tl) tl.textContent = type === 'ai' ? '📅 執行日期時間（必填）' : '📅 提醒日期時間（選填）';
    if (type === 'ai') { var m = document.getElementById('add-todo-ai-mode'); W._novaOnAddTodoModeChange(m ? m.value : 'general'); }
  };

  W._novaOnAddTodoModeChange = function (mode) {
    var pw = document.getElementById('add-todo-ai-prompt-wrap'), rf = document.getElementById('add-todo-replay-fields');
    var isReplay = mode === 'replay';
    if (pw) pw.classList.toggle('hidden', isReplay);
    if (rf) rf.classList.toggle('hidden', !isReplay);
    if (isReplay) populateReplay();
  };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function populateReplay() {
    var sel = document.getElementById('add-todo-replay-file'); if (!sel) return;
    if (!W.NovaSkills || !NovaSkills.getManifest) { sel.innerHTML = '<option value="">（技能系統尚未就緒，請稍後再試）</option>'; return; }
    var skills = NovaSkills.getManifest().filter(function (s) { return !s.partial; });
    if (!skills.length) { sel.innerHTML = '<option value="">（目前沒有任何技能範本，請先到「技能」建立或匯入）</option>'; return; }
    sel.innerHTML = skills.map(function (s) {
      var icon = s.type === 'replay' ? '🔁' : (s.execMode === 'autonomous' ? '🤖' : '💬');
      var suffix = s.type === 'replay' ? ('（' + (s.stepCount || 0) + ' 步）') : '';
      return '<option value="' + esc(s.name) + '">' + icon + ' ' + esc((s.description || s.name).slice(0, 50)) + suffix + '</option>';
    }).join('');
  }

  W.confirmAddTodo = async function () {
    function g(id) { return document.getElementById(id); }
    var type = W._novaAddTodoType || 'reminder', text = g('add-todo-text') && g('add-todo-text').value.trim();
    if (!text) { showToast(type === 'ai' ? '⚠️ 請輸入任務標題' : '⚠️ 請輸入提醒標題'); return; }
    var alertTime = g('add-todo-time') && g('add-todo-time').value ? new Date(g('add-todo-time').value).getTime() : null;
    var repeat = g('add-todo-repeat') ? parseInt(g('add-todo-repeat').value) : 0;
    var todo;
    if (type === 'ai') {
      var mode = g('add-todo-ai-mode') ? g('add-todo-ai-mode').value : 'general';
      if (!alertTime) { showToast('⚠️ AI排程任務需要設定執行日期時間'); return; }
      var base = { id: Date.now(), text: '🔄 自動化任務: ' + text, done: false, alertTime: alertTime, alertEnabled: true, repeatInterval: repeat || 0, time: new Date(alertTime).toLocaleString('zh-TW'), alerted: false, isAutoTask: true };
      if (mode === 'replay') {
        var file = g('add-todo-replay-file') ? g('add-todo-replay-file').value : '';
        if (!file) { showToast('⚠️ 請選擇要執行的技能範本'); return; }
        todo = Object.assign(base, { taskType: 'replay', replayFile: file, replayLoopCount: Math.max(1, parseInt(g('add-todo-replay-loop-count') && g('add-todo-replay-loop-count').value) || 1) });
      } else {
        var prompt = g('add-todo-ai-prompt') && g('add-todo-ai-prompt').value.trim();
        if (!prompt) { showToast('⚠️ 請描述 AI 應該做什麼'); return; }
        todo = Object.assign(base, { taskQuery: prompt, taskType: mode });
      }
    } else {
      todo = { id: Date.now(), text: text, done: false, alertTime: alertTime, alertEnabled: !!alertTime, repeatInterval: repeat || 0, time: alertTime ? new Date(alertTime).toLocaleString('zh-TW') : '未設定提醒', alerted: false };
    }
    appState.todos.unshift(todo);
    saveToDB('todos', todo);
    try { scheduleEmergencyBackup(); } catch (e) {}
    renderTodos(); closeAddTodoModal();
    var wantCal = true;   // 與原手機版一致：有設定時間就同步行事曆
    if (alertTime && typeof CalEngine !== 'undefined' && wantCal) {
      var ok = false; try { ok = await CalEngine.addTodoToCalendar(todo); } catch (e) {}
      showToast(ok ? (type === 'ai' ? '✅ 已建立 AI 排程任務並同步至手機行事曆' : '✅ 已新增提醒並同步至手機行事曆')
                   : (type === 'ai' ? '✅ 已建立 AI 排程任務（行事曆同步失敗，請確認是否已授予行事曆權限）' : '✅ 已新增提醒（行事曆同步失敗，請確認是否已授予行事曆權限）'));
    } else {
      showToast(type === 'ai' ? '✅ 已建立 AI 排程任務' : ('✅ 已新增提醒' + (alertTime ? '' : '（未設定時間）')));
    }
  };
})();

/* nova-schedule-pro.js — v1.2.0 (2026-11-01)
 * 手機版「任務管理」對標桌面 v3.7.0+：新增任務視窗分成「🤖 AI排程任務」與「🔔 一般提醒」兩個分頁。
 *   AI排程任務：到時間讓 AI 實際執行（一般對話／聯網查詢／生成圖片／AI 自主模式／技能範本重播），資料格式與聊天室語意排程
 *   （askScheduleTaskType）完全一致：isAutoTask / taskQuery / taskType（replay 另有 replayFile / replayLoopCount），
 *   觸發邏輯在 index.html 的 checkReminders。一般提醒：純鬧鐘＋通知，不呼叫 AI。
 *   兩者都可「同步到手機行事曆」（CalEngine）。桌面版的「同步到 Google 行事曆」依賴桌面 sidecar，手機版沒有，所以不放（評估見回覆）。
 * 版本紀錄
 *   v1.2.0 2026-11-01  每筆排程可自己加「進度註解」（對標桌面 v3.86.0 ②）：輸入框按 Enter（輸入法選字中的 Enter 不算）或按「加入」，帶時間戳記，可逐則刪除；存在 todo.progressNotes: [{id, ts, text}]，隨 saveToDB 一起存／同步（整筆為單位）。重畫列表時保留尚未送出的輸入內容與游標。新增 addTodoNote／deleteTodoNote。
 *   v1.1.0 2026-11-01  排程管理列表分類對標桌面 v3.86.0：分成「未完成」（一般提醒）／「AI 排程任務」／「已完成」三區，每區可收合並顯示筆數（記在 localStorage nova_todo_sections_v1）。
 *                      AI 任務跑完（非循環）自動移到「已完成」並記 doneAt；觸發到跑完之間顯示「⏳ 執行中」（aiRunningAt，30 分鐘沒收尾視為結束）；舊資料用 alerted 推算，不搬資料。
 *                      本檔新增 _novaTodoIsAI／_novaTodoAiRunning／_novaTodoAiFinished／_novaTodoIsDone／_novaTodoSecOpen／_novaRenderScheduleSections；index.html 的 renderTodos／toggleTodo／編輯儲存／checkReminders 對應接上（見 index.html 版本 2.6.106）。
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

  /* ───────── v1.1.0：排程管理三分區（對標桌面 v3.86.0） ───────── */
  W._novaTodoIsAI = function (t) { return !!(t && (t.isAutoTask || t.isAutoSearch)); };
  W._novaTodoAiRunning = function (t) { return !!(t && t.aiRunningAt && !t.done && Date.now() - t.aiRunningAt < 30 * 60 * 1000); };
  W._novaTodoAiFinished = function (t) { return W._novaTodoIsAI(t) && !(t.repeatInterval > 0) && t.alerted === true && !W._novaTodoAiRunning(t); };
  W._novaTodoIsDone = function (t) { return !!t.done || W._novaTodoAiFinished(t); };
  W._novaTodoFmt = function (ts) {
    try { return new Date(ts).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); } catch (e) { return ''; }
  };
  W._novaTodoSecOpen = function () {
    var o = { open: true, ai: true, done: true };
    try { var v = JSON.parse(localStorage.getItem('nova_todo_sections_v1') || 'null'); if (v && typeof v === 'object') o = Object.assign(o, v); } catch (e) {}
    return o;
  };
  W._novaRenderScheduleSections = function (el, todoBadge) {
    var isDone = W._novaTodoIsDone, isAI = W._novaTodoIsAI, fmt = W._novaTodoFmt;
    // 重畫會洗掉正在打的註解，先記起來、畫完還原（含游標所在的那一格）
    var keep = {}, focusId = null;
    el.querySelectorAll('[data-todo-note-in]').forEach(function (inp) { if (inp.value) keep[inp.getAttribute('data-todo-note-in')] = inp.value; if (inp === document.activeElement) focusId = inp.getAttribute('data-todo-note-in'); });
    var card = function (t) {
      var d = isDone(t), running = W._novaTodoAiRunning(t);
      var runBadge = running ? '<span class="text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0" style="background:rgba(120,53,15,.55);color:#fcd34d">⏳ 執行中</span>' : '';
      var doneAt = (d && t.doneAt) ? ' ・ 完成於 ' + esc(fmt(t.doneAt)) : '';
      var on = t.alertEnabled !== false, sid = esc(String(t.id));
      var notes = Array.isArray(t.progressNotes) ? t.progressNotes : [];
      var noteRows = notes.map(function (n) { return '<div class="flex items-start gap-2 text-xs text-slate-400 py-0.5"><span class="text-slate-600 shrink-0">' + esc(fmt(n.ts)) + '</span><span class="flex-1" style="word-break:break-word;white-space:pre-wrap">' + esc(n.text) + '</span><button type="button" data-todo-note-del="' + sid + '" data-note-id="' + esc(String(n.id)) + '" class="text-slate-600 hover:text-red-400 shrink-0" title="刪除這則註解"><i class="ph-bold ph-x"></i></button></div>'; }).join('');
      return '<div class="group bg-slate-900 p-4 rounded-xl border border-slate-800 hover:border-slate-600 transition-all slide-in" data-todo-card="' + sid + '"><div class="flex justify-between items-center">'
        + '<div class="flex items-center space-x-4"><button onclick="toggleTodo(' + t.id + ')" class="text-slate-500 hover:text-blue-400"><i class="ph' + (d ? '-fill ph-check-circle text-green-500' : ' ph-circle') + ' text-2xl"></i></button>'
        + '<div><p class="text-base ' + (d ? 'line-through text-slate-600' : 'text-slate-200') + ' flex items-center gap-1.5 flex-wrap">' + todoBadge(t) + runBadge + '<span>' + esc(t.text) + '</span></p>'
        + '<span class="text-xs text-slate-500">' + esc(t.time) + doneAt + '</span></div></div>'
        + '<div class="flex items-center space-x-2"><button onclick="toggleTodoAlarm(' + t.id + ')" class="' + (on ? 'text-yellow-500' : 'text-slate-600') + ' hover:text-yellow-400 p-2" title="' + (on ? '關閉提醒' : '開啟提醒') + '"><i class="ph-bold ' + (on ? 'ph-bell-ringing' : 'ph-bell-slash') + '"></i></button>'
        + '<button onclick="openTodoEdit(\'' + t.id + '\')" class="text-slate-500 hover:text-blue-400 p-2" title="編輯"><i class="ph-bold ph-pencil-simple"></i></button>'
        + '<button onclick="deleteTodo(\'' + t.id + '\')" class="text-slate-500 hover:text-red-400 p-2" title="刪除"><i class="ph-bold ph-trash"></i></button></div></div>'
        + '<div style="margin-top:8px;margin-left:2.5rem">' + noteRows + '<div class="flex items-center gap-2" style="margin-top:4px"><input type="text" data-todo-note-in="' + sid + '" maxlength="500" placeholder="加入進度註解…（Enter 送出）" autocomplete="off" class="flex-1 bg-slate-950 border border-slate-700 text-white text-xs rounded-lg px-3 py-1.5 min-w-0"><button type="button" data-todo-note-add="' + sid + '" class="text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 px-3 py-1.5 rounded-lg whitespace-nowrap">加入</button></div></div></div>';
    };
    var all = (W.appState && appState.todos) || [];
    var secs = [
      { key: 'open', icon: 'ph-fill ph-list-checks text-blue-400', title: '未完成', hint: '', list: all.filter(function (t) { return !isDone(t) && !isAI(t); }) },
      { key: 'ai', icon: 'ph-fill ph-robot text-sky-400', title: 'AI 排程任務', hint: '到時間會自動呼叫 AI 執行；跑完（非循環）會自動移到「已完成」', list: all.filter(function (t) { return !isDone(t) && isAI(t); }) },
      { key: 'done', icon: 'ph-fill ph-check-circle text-green-500', title: '已完成', hint: '', list: all.filter(isDone).sort(function (a, b) { return (b.doneAt || b._syncTs || 0) - (a.doneAt || a._syncTs || 0); }) }
    ];
    var op = W._novaTodoSecOpen();
    el.innerHTML = secs.map(function (sc) {
      return '<details data-todo-sec="' + sc.key + '" ' + (op[sc.key] !== false ? 'open' : '') + ' style="margin-bottom:1.25rem"><summary class="cursor-pointer select-none flex items-center gap-2 flex-wrap" style="margin-bottom:.75rem;list-style:none"><i class="' + sc.icon + '"></i><span class="text-sm font-bold text-slate-300">' + sc.title + '</span><span class="text-xs text-slate-500">' + sc.list.length + '</span>' + (sc.hint ? '<span class="text-xs text-slate-600">' + sc.hint + '</span>' : '') + '</summary><div class="space-y-3">' + (sc.list.map(card).join('') || '<p class="text-slate-600 text-sm text-center py-3">無</p>') + '</div></details>';
    }).join('');
    el.querySelectorAll('[data-todo-note-in]').forEach(function (inp) {
      var k = inp.getAttribute('data-todo-note-in');
      if (keep[k]) inp.value = keep[k];
      if (focusId === k) { try { inp.focus(); var L = inp.value.length; inp.setSelectionRange(L, L); } catch (e) {} }
    });
    if (!el._novaSecBound) {
      el._novaSecBound = true;
      el.addEventListener('toggle', function (ev) {
        var d = ev.target; if (!d || !d.getAttribute || !d.hasAttribute('data-todo-sec')) return;
        var o = W._novaTodoSecOpen(); o[d.getAttribute('data-todo-sec')] = d.open;
        try { localStorage.setItem('nova_todo_sections_v1', JSON.stringify(o)); } catch (e) {}
      }, true);
      var submit = function (id) {
        var inp = el.querySelector('[data-todo-note-in="' + String(id).replace(/"/g, '') + '"]');
        if (!inp) return;
        var v = inp.value; inp.value = '';   // 先清空，重畫時才不會把已送出的字又還原回去
        if (!W.addTodoNote(id, v)) inp.value = v;
      };
      el.addEventListener('click', function (ev) {
        var a = ev.target.closest && ev.target.closest('[data-todo-note-add]');
        if (a) { submit(a.getAttribute('data-todo-note-add')); return; }
        var d = ev.target.closest && ev.target.closest('[data-todo-note-del]');
        if (d) W.deleteTodoNote(d.getAttribute('data-todo-note-del'), d.getAttribute('data-note-id'));
      });
      el.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter' || ev.isComposing || ev.keyCode === 229) return;   // 注音／拼音選字時的 Enter 不算送出
        var inp = ev.target.closest && ev.target.closest('[data-todo-note-in]');
        if (inp) { ev.preventDefault(); submit(inp.getAttribute('data-todo-note-in')); }
      });
    }
  };
  W.addTodoNote = function (id, text) {
    var t = appState.todos.find(function (x) { return String(x.id) === String(id); });
    text = String(text || '').trim();
    if (!t || !text) return false;
    if (!Array.isArray(t.progressNotes)) t.progressNotes = [];
    t.progressNotes.push({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 6), ts: Date.now(), text: text.slice(0, 500) });
    saveToDB('todos', t); renderTodos();
    return true;
  };
  W.deleteTodoNote = function (id, noteId) {
    var t = appState.todos.find(function (x) { return String(x.id) === String(id); });
    if (!t || !Array.isArray(t.progressNotes)) return;
    t.progressNotes = t.progressNotes.filter(function (n) { return String(n.id) !== String(noteId); });
    saveToDB('todos', t); renderTodos();
  };
  // 分區函式是在 renderTodos 第一次執行之後才載入，載入完補畫一次
  try { if (typeof renderTodos === 'function' && W.appState && appState.todos) renderTodos(); } catch (e) {}
})();

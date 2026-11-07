/* [NOVA Android] nova-bots-ui.js — 由 NOVA Desktop 同名檔案（v1.2.0）移植。
   Android 移植版本紀錄：v1.0.0-android.1 - 只改三處文字／標示：① 儲存狀態列改成手機用語（資料存在 App 內，不再提 sidecar）；② 排程區說明改成「手機版暫不支援排程」；
     ③ 工具勾選項目對 NB.UNSUPPORTED 內的工具加上「（手機版不支援）」並維持可勾選（設定仍會和桌面版同步，只是手機上不會執行）。 */
/* ═══════════════════════════════════════════════════════════════════
 * nova-bots-ui.js  v1.2.0  —  「多 Bot 模式」設定介面（專家管理視窗裡的「🤖 多 Bot」分頁）
 * 最後更新：2026-11-06
 *
 * 版本紀錄（只記這個檔案自己的變更）：
 *   v1.2.0 (2026-11-07) 配合 nova-bots.js v1.2.0 的討論／審稿：設定區新增「討論最多幾人／幾輪」「整批討論與審稿發言總數（0＝關閉）」「每個任務最多送審幾次（0＝關閉）」「發言／審稿的步數上限」；Bot 的「可交辦他人」改名「可交辦／邀請討論／送審」。
 *   v1.1.0 (2026-11-06) 配合 nova-bots.js v1.1.0 的寫入工具：設定區新增「寫入總開關」（預設關）、「每個任務寫入次數上限」、「手動派工前先讓我確認」；工具面板新增紅色「寫入動作」群組；說明文字從「全部唯讀」改成低風險免確認、高風險每次確認、排程不執行高風險。
 *   v1.0.0 (2026-11-06) 初版。內容：① 模式開關（關閉時分頁只剩開關與說明，其餘功能完全不出現）；② 多 Bot 設定（步數／交辦深度／交辦數／總任務數／呼叫上限／記憶／每日排程上限）；
 *     ③ 每位 Bot 的設定（工具迴圈、記憶、可否交辦、逐一勾選工具，信件／行事曆／雲端類會標示為敏感）與「記憶管理」視窗（編輯、釘選、刪除、新增、清空）；
 *     ④ 排程（每 N 分鐘或每天指定時間，可限定星期；立即執行／停用／刪除）；⑤ 最近執行紀錄（點開看完整成品）。
 *   純 DOM；外部能力（儲存、主題、開關、立即執行）全由 index.html 膠水層經 ctx 注入，本檔不碰 appState。
 * ═══════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';
  var API = { VERSION: '1.0.0', _tok: 0 };

  function fmtTime(ms) {
    if (!ms) return '—';
    try { return new Date(ms).toLocaleString('zh-TW', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (e) { return String(ms); }
  }
  var DAY_LABEL = ['一', '二', '三', '四', '五', '六', '日'];   // 0＝星期一（與 sidecar 的 weekday 一致）
  var STATUS_TXT = { done: '✅ 完成', failed: '❌ 失敗', cancelled: '⏹ 取消', blocked: '🚫 被擋下', running: '⏳ 進行中', skipped: '➖ 略過', queued: '⬜ 排隊' };

  API.render = async function (body, c) {
    var mk = c.mk, T = c.T, NB = global.NovaBots;
    var tok = ++API._tok;
    var alive = function () { return tok === API._tok && body.isConnected !== false; };
    var toast = function (m, ms) { try { c.showToast(m, ms); } catch (e) { /* ignore */ } };
    var fail = function (e) { toast('❌ ' + ((e && e.message) || e), 5000); };
    var section = function (title, hint) {
      var box = mk('div', 'border:1px solid ' + T.border + ';border-radius:12px;padding:10px 12px;margin-bottom:12px;background:' + T.card2 + ';');
      box.appendChild(mk('div', 'font-weight:700;font-size:13px;margin-bottom:' + (hint ? '2' : '8') + 'px;', title));
      if (hint) box.appendChild(mk('div', 'font-size:11px;color:' + T.muted + ';line-height:1.6;margin-bottom:8px;', hint));
      body.appendChild(box); return box;
    };
    var chk = function (label, val, onchange, title) {
      var w = mk('label', 'display:inline-flex;align-items:center;gap:5px;font-size:12px;cursor:pointer;margin-right:12px;');
      var i = mk('input'); i.type = 'checkbox'; i.checked = !!val; i.onchange = function () { onchange(i.checked); };
      w.appendChild(i); w.appendChild(mk('span', '', label)); if (title) w.title = title; return w;
    };

    body.textContent = '';
    if (!NB) { body.appendChild(mk('div', 'color:#f87171;', '找不到多 Bot 引擎（nova-bots.js 沒有載入）。')); return; }

    // ① 模式開關
    var on = c.isOn();
    var sw = section('🤖 多 Bot 模式');
    var swRow = mk('label', 'display:flex;align-items:center;gap:8px;font-size:14px;font-weight:700;cursor:pointer;');
    var swIn = mk('input'); swIn.type = 'checkbox'; swIn.checked = on; swIn.style.cssText = 'width:18px;height:18px;';
    swIn.onchange = function () { c.setOn(swIn.checked); toast(swIn.checked ? '🤖 已啟用多 Bot 模式：輸入框上方的模式列會多一個「🤖 多 Bot」' : '🤖 已關閉多 Bot 模式，一切回到原本的多專家行為'); c.rerender(); };
    swRow.appendChild(swIn); swRow.appendChild(mk('span', '', on ? '已啟用' : '未啟用（開啟後才會出現多 Bot 的功能）'));
    sw.appendChild(swRow);
    sw.appendChild(mk('div', 'font-size:12px;color:' + T.muted + ';line-height:1.7;margin-top:8px;',
      '多 Bot 模式把「專家」升級成持續存在的 Bot：① 有長期記憶（做過什麼、你的偏好）；② 能用工具（上網、查知識庫、查 Insight／Research、讀文件，需勾選才能讀信件／行事曆／雲端）；' +
      '③ 能把子任務交辦給別的 Bot，也能自己判斷需要時邀請別的 Bot 討論、或把草稿送給別的 Bot 審稿；④ 能依排程自己開工。預設所有工具是唯讀；「寫入總開關」打開並逐 Bot 勾選後，Bot 才能存草稿、寫 Drive／本機檔案、寄信、刪信——低風險（存草稿、新增檔案）直接做，高風險（寄信、刪除、移動、覆蓋）每次都會跳視窗問你，排程（你不在場）時高風險一律不執行；不會點擊網頁、不會付款。關閉開關後，原本的協作報告／會議／並行作業完全不受影響。'));
    if (!on) return;

    // 儲存層狀態
    var store;
    try { store = await c.getStore(); } catch (e) { fail(e); return; }
    if (!alive()) return;
    var st = mk('div', 'font-size:12px;line-height:1.7;margin-bottom:12px;padding:8px 10px;border-radius:10px;border:1px solid ' + T.border + ';');
    var ss = c.schedulerStatus ? c.schedulerStatus() : null;
    st.textContent = '儲存：App 內部（跟著「同步專家與 Bot」同步到其他裝置）　排程：手機版暫不支援（需要常駐背景，手機會被系統暫停）';
    body.appendChild(st);

    // ② 多 Bot 設定
    var sset = NB.normalizeSettings(c.getSettings()), f = {};
    var s2 = section('多 Bot 設定', '這些上限用來防止 Bot 失控地燒額度。');
    var grid = mk('div', 'display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:4px 14px;');
    var num = function (key, label, hint, lo, hi) {
      var w = mk('div'); w.appendChild(c.labelEl(label, hint));
      var e = mk('input', c.fieldStyle()); e.type = 'number'; e.min = lo; e.max = hi; e.value = sset[key]; f[key] = e; w.appendChild(e); grid.appendChild(w);
    };
    var sel = function (key, label, hint, opts) {
      var w = mk('div'); w.appendChild(c.labelEl(label, hint));
      var e = mk('select', c.fieldStyle()); opts.forEach(function (o) { e.appendChild(new Option(o[1], o[0])); }); e.value = String(sset[key]); f[key] = e; w.appendChild(e); grid.appendChild(w);
    };
    num('maxSteps', '每個任務最多幾步', '工具／交辦，1–12', 1, 12);
    num('maxDepth', '交辦深度', '0＝禁止交辦，最多 3', 0, 3);
    num('maxFanout', '每個任務最多交辦幾個', '0–6', 0, 6);
    num('maxParticipants', '討論最多邀請幾位', '1–4', 1, 4);
    num('maxRounds', '討論最多幾輪', '1–4', 1, 4);
    num('maxDiscussTurns', '整批討論＋審稿發言總數', '0＝關閉討論與審稿；0–30', 0, 30);
    num('maxReviews', '每個任務最多送審幾次', '0＝關閉審稿；0–5', 0, 5);
    num('turnSteps', '發言／審稿的步數上限', '1–6', 1, 6);
    num('maxTasks', '一批任務總數上限', '含被交辦的，1–30', 1, 30);
    num('maxCalls', '一批模型呼叫總數上限', '含上網搜尋，4–300', 4, 300);
    num('memoryTopN', '每次帶入幾則記憶', '0＝不帶入', 0, 30);
    num('memoryCap', '每位 Bot 最多存幾則記憶', '超過刪最舊的（釘選不刪）', 20, 2000);
    num('dailyCap', '每日排程執行次數上限', '所有排程合計', 1, 500);
    num('maxWrites', '每個任務寫入次數上限', '0＝不能寫；0–30', 0, 30);
    sel('autoRemember', '任務結束自動寫工作紀錄', '', [['true', '是'], ['false', '否']]);
    sel('schedulerOn', '執行排程', '', [['true', '是'], ['false', '否（暫停所有排程）']]);
    sel('writeEnabled', '✍️ 寫入總開關', '關閉時所有 Bot 都不能寫入', [['false', '關閉（唯讀）'], ['true', '開啟（仍需逐 Bot 勾選）']]);
    sel('confirmDispatch', '手動派工前先讓我確認', '關閉＝拆好任務直接開工（拆解有問題才跳視窗）', [['true', '是'], ['false', '否（直接開工）']]);
    s2.appendChild(grid);
    var saveRow = mk('div', 'display:flex;gap:8px;justify-content:flex-end;margin-top:10px;');
    var reset = mk('button', c.btnStyle(false), '還原預設'); reset.onclick = function () { c.saveSettings(NB.DEFAULT_SETTINGS); c.rerender(); };
    var save = mk('button', c.btnStyle(true), '儲存設定');
    save.onclick = function () {
      c.saveSettings({ maxSteps: f.maxSteps.value, maxDepth: f.maxDepth.value, maxFanout: f.maxFanout.value, maxParticipants: f.maxParticipants.value, maxRounds: f.maxRounds.value, maxDiscussTurns: f.maxDiscussTurns.value, maxReviews: f.maxReviews.value, turnSteps: f.turnSteps.value, maxTasks: f.maxTasks.value, maxCalls: f.maxCalls.value,
        memoryTopN: f.memoryTopN.value, memoryCap: f.memoryCap.value, dailyCap: f.dailyCap.value, autoRemember: f.autoRemember.value === 'true', schedulerOn: f.schedulerOn.value === 'true',
        maxWrites: f.maxWrites.value, writeEnabled: f.writeEnabled.value === 'true', confirmDispatch: f.confirmDispatch.value === 'true' });
      toast('✅ 多 Bot 設定已儲存'); c.onChanged();
    };
    saveRow.append(reset, save); s2.appendChild(saveRow);

    // ③ 每位 Bot
    var experts = c.experts();
    var profMap = {};
    try { (await store.botList()).forEach(function (p) { profMap[p.id] = p; }); } catch (e) { /* 沒有設定就用預設 */ }
    var memCount = {};
    await Promise.all(experts.map(function (e) { return store.memGet(e.id).then(function (m) { memCount[e.id] = ((m && m.notes) || []).length; }).catch(function () { memCount[e.id] = 0; }); }));
    if (!alive()) return;
    var s3 = section('Bot 設定與記憶', 'Bot ＝ 你在「專家」分頁定義的專家。角色、知識庫範圍、模型到那邊改；這裡設定工具、記憶與可否交辦。');
    experts.forEach(function (e) {
      var prof = NB.normalizeProfile(Object.assign({}, profMap[e.id] || {}, { id: e.id }));
      var row = mk('div', 'border:1px solid ' + T.border + ';border-radius:10px;padding:8px 10px;margin-bottom:8px;background:' + T.card + ';');
      var persist = function () { store.botPut(prof).then(function () { c.onChanged(); }).catch(fail); };
      var head = mk('div', 'display:flex;align-items:center;flex-wrap:wrap;gap:4px 0;');
      head.appendChild(mk('b', 'font-size:13px;margin-right:12px;', (e.icon || '🧑‍🔬') + ' ' + e.name + (e.enabled ? '' : '（未啟用）')));
      head.appendChild(chk('工具迴圈', prof.agentic, function (v) { prof.agentic = v; persist(); }, '關閉＝退回單次呼叫（仍會帶入記憶）'));
      head.appendChild(chk('記憶', prof.memory, function (v) { prof.memory = v; persist(); }));
      head.appendChild(chk('可交辦／邀請討論／送審', prof.canDelegate, function (v) { prof.canDelegate = v; persist(); }));
      var toolsBtn = mk('button', c.btnStyle(false) + 'padding:2px 9px;font-size:12px;margin-right:6px;', '🔧 工具（' + prof.tools.length + '）');
      var memBtn = mk('button', c.btnStyle(false) + 'padding:2px 9px;font-size:12px;', '🧠 記憶（' + (memCount[e.id] || 0) + '）');
      head.appendChild(toolsBtn); head.appendChild(memBtn);
      row.appendChild(head);
      var panel = mk('div', 'display:none;margin-top:8px;');
      var groups = NB.TOOL_GROUPS;
      Object.keys(groups).forEach(function (g) {
        var ks = Object.keys(NB.TOOLS).filter(function (k) { return NB.TOOLS[k].group === g; });
        var gl = mk('div', 'font-size:11px;font-weight:700;margin:6px 0 2px 0;color:' + (g === 'write' ? '#ef4444' : g === 'personal' ? '#f59e0b' : T.muted) + ';', (g === 'write' ? '✍️ ' : g === 'personal' ? '⚠️ ' : '') + groups[g]);
        panel.appendChild(gl);
        var wrap = mk('div', 'display:flex;flex-wrap:wrap;');
        ks.forEach(function (k) {
          wrap.appendChild(chk(NB.TOOLS[k].label + ((NB.UNSUPPORTED || []).indexOf(k) >= 0 ? '（手機版不支援）' : ''), prof.tools.indexOf(k) >= 0, function (v) {
            prof.tools = prof.tools.filter(function (x) { return x !== k; }); if (v) prof.tools.push(k);
            toolsBtn.textContent = '🔧 工具（' + prof.tools.length + '）'; persist();
          }, NB.TOOLS[k].desc));
        });
        panel.appendChild(wrap);
      });
      row.appendChild(panel);
      toolsBtn.onclick = function () { panel.style.display = panel.style.display === 'none' ? 'block' : 'none'; };
      memBtn.onclick = function () { openMemory(e, store, c, function (n) { memBtn.textContent = '🧠 記憶（' + n + '）'; }); };
      s3.appendChild(row);
    });

    // ④ 排程
    var s4 = section('排程', '到點時 Bot 會自己開工，成品貼到「🤖 Bot 排程」對話，並存成檔案。最短間隔 5 分鐘；錯過的次數只補跑一次。');
    if (true) { s4.appendChild(mk('div', 'font-size:12px;color:#f59e0b;line-height:1.6;', '手機版暫不支援 Bot 排程（手機沒有可靠的背景常駐）。排程請在桌面版建立與執行；要手動執行某位 Bot 請在輸入框用「@Bot名 要做的事」。')); }
    else {
      var scheds = [];
      try { scheds = await store.scheduleList(); } catch (e) { fail(e); }
      if (!alive()) return;
      var botName = {}; experts.forEach(function (e) { botName[e.id] = (e.icon || '') + ' ' + e.name; });
      scheds.sort(function (a, b) { return (a.created || 0) - (b.created || 0); });
      if (!scheds.length) s4.appendChild(mk('div', 'font-size:12px;color:' + T.muted + ';margin-bottom:8px;', '還沒有排程。'));
      scheds.forEach(function (s) {
        var r = mk('div', 'border:1px solid ' + T.border + ';border-radius:10px;padding:7px 10px;margin-bottom:6px;background:' + T.card + ';');
        var when = s.mode === 'daily' ? ('每天 ' + s.time + ((s.days && s.days.length && s.days.length < 7) ? '（週' + s.days.map(function (d) { return DAY_LABEL[d]; }).join('') + '）' : '')) : ('每 ' + s.minutes + ' 分鐘');
        r.appendChild(mk('div', 'font-size:13px;font-weight:600;', (botName[s.bot_id] || s.bot_id) + '：' + s.name));
        r.appendChild(mk('div', 'font-size:11px;color:' + T.muted + ';margin:2px 0 4px 0;white-space:pre-wrap;', when + '｜下次 ' + (s.enabled ? fmtTime(s.next_run) : '已停用') + '｜上次 ' + fmtTime(s.last_run) + (s.last_status ? '（' + (STATUS_TXT[s.last_status] || s.last_status) + (s.last_note ? '：' + s.last_note : '') + '）' : '') + '\n' + s.instruction));
        var b = mk('div', 'display:flex;align-items:center;');
        b.appendChild(chk('啟用', s.enabled, function (v) { store.schedulePut(Object.assign({}, s, { enabled: v })).then(function () { c.rerender(); }).catch(fail); }));
        var now = mk('button', c.btnStyle(false) + 'padding:2px 9px;font-size:12px;margin-right:6px;', '▶ 立即執行');
        now.onclick = function () { c.runNow(s); toast('🤖 已開始執行「' + s.name + '」，成品會貼到「🤖 Bot 排程」對話'); };
        var del = mk('button', c.btnStyle(false) + 'padding:2px 9px;font-size:12px;', '🗑 刪除');
        del.onclick = function () { if (confirm('刪除排程「' + s.name + '」？')) store.scheduleDelete(s.id).then(function () { c.rerender(); }).catch(fail); };
        b.append(now, del); r.appendChild(b); s4.appendChild(r);
      });
      // 新增排程
      var add = mk('div', 'border-top:1px dashed ' + T.border + ';margin-top:8px;padding-top:8px;');
      add.appendChild(mk('div', 'font-size:12px;font-weight:700;', '新增排程'));
      var ag = mk('div', 'display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:2px 12px;');
      var cell = function (label, el) { var w = mk('div'); w.appendChild(c.labelEl(label)); w.appendChild(el); ag.appendChild(w); return el; };
      var selBot = mk('select', c.fieldStyle()); experts.forEach(function (e) { selBot.appendChild(new Option((e.icon || '') + ' ' + e.name, e.id)); });
      var selType = mk('select', c.fieldStyle()); selType.appendChild(new Option('研究（可上網）', 'research')); selType.appendChild(new Option('報告', 'report'));
      var selMode = mk('select', c.fieldStyle()); selMode.appendChild(new Option('每 N 分鐘', 'interval')); selMode.appendChild(new Option('每天固定時間', 'daily'));
      var inMin = mk('input', c.fieldStyle()); inMin.type = 'number'; inMin.min = 5; inMin.value = 60;
      var inTime = mk('input', c.fieldStyle()); inTime.type = 'time'; inTime.value = '08:30';
      cell('負責的 Bot', selBot); cell('任務類型', selType); cell('頻率', selMode);
      var cellMin = cell('間隔（分鐘，≥5）', inMin), cellTime = cell('時間', inTime);
      var syncMode = function () { cellMin.parentNode.style.display = selMode.value === 'interval' ? '' : 'none'; cellTime.parentNode.style.display = selMode.value === 'daily' ? '' : 'none'; dayRow.style.display = selMode.value === 'daily' ? 'flex' : 'none'; };
      add.appendChild(ag);
      var dayRow = mk('div', 'display:none;flex-wrap:wrap;margin-top:6px;align-items:center;');
      dayRow.appendChild(mk('span', 'font-size:12px;color:' + T.muted + ';margin-right:8px;', '星期（全不勾＝每天）：'));
      var dayBoxes = DAY_LABEL.map(function (d, i) { var w = chk(d, false, function () { }); w.firstChild.dataset.d = i; dayRow.appendChild(w); return w.firstChild; });
      add.appendChild(dayRow);
      selMode.onchange = syncMode;
      var inName = mk('input', c.fieldStyle()); inName.placeholder = '名稱（可省略）';
      var inInstr = mk('textarea', c.fieldStyle() + 'min-height:64px;resize:vertical;'); inInstr.placeholder = '交辦內容，例如：整理過去 24 小時與塑料添加劑相關的新論文與專利，列出最值得看的 5 筆並說明原因';
      add.appendChild(c.labelEl('名稱')); add.appendChild(inName); add.appendChild(c.labelEl('交辦內容')); add.appendChild(inInstr);
      var addBtn = mk('button', c.btnStyle(true) + 'margin-top:8px;', '＋ 新增排程');
      addBtn.onclick = function () {
        if (!inInstr.value.trim()) { toast('請填交辦內容'); return; }
        store.schedulePut({ bot_id: selBot.value, instruction: inInstr.value.trim(), type: selType.value, mode: selMode.value, minutes: inMin.value, time: inTime.value,
          days: dayBoxes.filter(function (x) { return x.checked; }).map(function (x) { return +x.dataset.d; }), name: inName.value.trim(), enabled: true })
          .then(function () { toast('✅ 已新增排程'); c.rerender(); }).catch(fail);
      };
      add.appendChild(addBtn); s4.appendChild(add); syncMode();
    }

    // ⑤ 最近執行紀錄
    var s5 = section('最近的執行紀錄', '點一筆可看完整成品（含被交辦的子任務）。');
    var runs = [];
    try { runs = await store.runList('', 15); } catch (e) { /* ignore */ }
    if (!alive()) return;
    if (!runs.length) s5.appendChild(mk('div', 'font-size:12px;color:' + T.muted + ';', '還沒有紀錄。'));
    runs.forEach(function (r) {
      var line = mk('div', 'display:flex;gap:8px;align-items:center;padding:4px 6px;border-radius:8px;cursor:pointer;font-size:12px;');
      line.onmouseenter = function () { line.style.background = T.hover; }; line.onmouseleave = function () { line.style.background = 'transparent'; };
      line.appendChild(mk('span', 'flex:none;', STATUS_TXT[r.status] || r.status));
      line.appendChild(mk('span', 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', (r.bot_name || r.bot_id) + '：' + r.title + (r.parent_id ? '（被交辦）' : '') + (r.source === 'schedule' ? ' ⏰' : '')));
      line.appendChild(mk('span', 'flex:none;color:' + T.muted + ';', fmtTime(r.ended || r.updated)));
      line.onclick = function () { store.runGet(r.id).then(function (full) { openText(c, (full && full.title) || r.title, (full && (full.text || full.error)) || '（沒有內容）'); }).catch(fail); };
      s5.appendChild(line);
    });
  };

  // ───────────────────────── 共用彈窗 ─────────────────────────
  function overlay(c, title, build) {
    var mk = c.mk, T = c.T;
    var old = document.getElementById('nova-bots-modal'); if (old) old.remove();
    var ov = mk('div', 'position:fixed;inset:0;z-index:9200;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px;');
    ov.id = 'nova-bots-modal';
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) ov.remove(); });
    var card = mk('div', 'width:min(720px,100%);max-height:88vh;display:flex;flex-direction:column;background:' + T.card + ';color:' + T.text + ';border:1px solid ' + T.border + ';border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.5);overflow:hidden;');
    var head = mk('div', 'display:flex;align-items:center;padding:10px 14px;border-bottom:1px solid ' + T.border + ';');
    head.appendChild(mk('b', 'flex:1;font-size:14px;', title));
    var x = mk('button', 'background:transparent;border:0;color:' + T.muted + ';font-size:18px;cursor:pointer;', '✕'); x.onclick = function () { ov.remove(); };
    head.appendChild(x);
    var body = mk('div', 'padding:12px 14px;overflow-y:auto;flex:1;');
    card.append(head, body); ov.appendChild(card); document.body.appendChild(ov);
    build(body, ov); return ov;
  }
  function openText(c, title, text) {
    overlay(c, title, function (body) { body.appendChild(c.mk('div', 'white-space:pre-wrap;font-size:13px;line-height:1.7;user-select:text;', text)); });
  }

  // ───────────────────────── 記憶管理 ─────────────────────────
  function openMemory(expert, store, c, onCount) {
    var mk = c.mk, T = c.T;
    overlay(c, '🧠 ' + expert.name + ' 的記憶', function (body) {
      var render = async function () {
        body.textContent = '';
        var m; try { m = await store.memGet(expert.id); } catch (e) { body.appendChild(mk('div', 'color:#f87171;', String((e && e.message) || e))); return; }
        var notes = ((m && m.notes) || []).slice().sort(function (a, b) { return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.ts || 0) - (a.ts || 0); });
        onCount(notes.length);
        body.appendChild(mk('div', 'font-size:12px;color:' + T.muted + ';line-height:1.6;margin-bottom:8px;', '共 ' + notes.length + ' 則。任務前會挑出相關的帶進提示詞（📌 釘選的優先）。「工作紀錄」是任務結束時自動寫的。你可以直接改文字、釘選、刪除，或新增一則。'));
        var addRow = mk('div', 'display:flex;gap:6px;margin-bottom:10px;');
        var inp = mk('input', c.fieldStyle()); inp.placeholder = '新增一則記憶，例如：客戶 A 只收 PDF，不收 Word';
        var addB = mk('button', c.btnStyle(true), '新增'); addB.style.flex = 'none';
        addB.onclick = function () { if (!inp.value.trim()) return; store.memAdd(expert.id, [{ text: inp.value.trim(), pinned: true, kind: 'fact' }], 2000).then(render).catch(function (e) { c.showToast('❌ ' + e.message); }); };
        addRow.append(inp, addB); body.appendChild(addRow);
        notes.forEach(function (n) {
          var r = mk('div', 'display:flex;gap:6px;align-items:center;margin-bottom:5px;');
          r.appendChild(mk('span', 'flex:none;font-size:10px;color:' + T.muted + ';width:46px;', n.kind === 'log' ? '工作紀錄' : (n.kind === 'lesson' ? '心得' : '事實')));
          var t = mk('input', c.fieldStyle()); t.value = n.text;
          t.onchange = function () { store.memEdit(expert.id, n.id, { text: t.value }).catch(function (e) { c.showToast('❌ ' + e.message); }); };
          var pin = mk('button', 'flex:none;background:transparent;border:0;cursor:pointer;font-size:15px;opacity:' + (n.pinned ? '1' : '.35') + ';', '📌');
          pin.title = n.pinned ? '取消釘選' : '釘選（永遠帶入）';
          pin.onclick = function () { store.memEdit(expert.id, n.id, { pinned: !n.pinned }).then(render).catch(function (e) { c.showToast('❌ ' + e.message); }); };
          var del = mk('button', 'flex:none;background:transparent;border:0;cursor:pointer;font-size:14px;', '🗑');
          del.onclick = function () { store.memDelete(expert.id, n.id).then(render).catch(function (e) { c.showToast('❌ ' + e.message); }); };
          r.append(t, pin, del); body.appendChild(r);
        });
        if (notes.length) {
          var clr = mk('button', c.btnStyle(false) + 'margin-top:8px;', '清空這位 Bot 的所有記憶');
          clr.onclick = function () { if (confirm('清空「' + expert.name + '」的 ' + notes.length + ' 則記憶？（檔案會移到 _deleted，不是永久刪除）')) store.memClear(expert.id).then(render).catch(function (e) { c.showToast('❌ ' + e.message); }); };
          body.appendChild(clr);
        }
      };
      render();
    });
  }

  global.NovaBotsUI = API;
})(typeof window !== 'undefined' ? window : globalThis);

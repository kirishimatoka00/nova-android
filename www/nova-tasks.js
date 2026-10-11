/* [NOVA Android] nova-tasks.js — 由 NOVA Desktop 同名檔案原樣移植（純邏輯、不碰 DOM／appState，行為與桌面版一致）。
   Android 移植版本紀錄：v1.0.0-android.1 - 批次 4 初次移植，內容未修改。 */
/* ═══════════════════════════════════════════════════════════════════
 * nova-tasks.js  v1.0.0  —  多專家「並行作業」引擎（純邏輯，不碰 DOM）
 * 最後更新：2026-10-10
 *
 * 版本紀錄：
 *   v1.0.0 (2026-10-10) 初版。使用者要求：除了「協作報告」「多專家會議」，再加第三種模式——
 *     可同時交辦不同專家做「不同性質」的事（例如 A 做簡報、B 蒐集彙整資料），各自獨立進行、各自交出成品；
 *     也能指定「A 做完把成果交給 B 續做」。
 *     ・派工解析：優先認 `@專家名 任務` 的明確寫法；也能用口語，由「派工模型」拆成任務（必須遵守使用者 @ 指名的人選）；
 *       模型失敗時退回明確語法解析。語法裡 `→`、「接著」「然後」「做完後交給」會被視為接力（B 等 A 完成並拿到 A 的成果）。
 *     ・任務類型：report（報告／彙整）、research（上網蒐集研究，開聯網搜尋）、slides（簡報 JSON，對話區現有機制會把它變成可下載 .pptx）、
 *       code（網頁／前端程式；Python／PowerShell 區塊一律降級成純文字，避免背景任務產生的程式被自動執行）。
 *     ・排程：全域同時執行數上限（pool）、依賴關係（上游失敗則下游標為 blocked，不硬跑）、每個任務可單獨取消、
 *       429／5xx／逾時自動退避重試（最多 2 次）。簡報 JSON 會機械式驗證，格式錯誤時自動要求修正一次。
 *
 * 用法：
 *   NovaExpertTasks.planTasks({ text, experts, settings, deps })        → { tasks, how, notes }
 *   NovaExpertTasks.validateTasks(tasks, experts)                       → { ok, errors, tasks }
 *   NovaExpertTasks.runTasks({ tasks, experts, settings, deps, pool })  → Promise<tasks>
 *   deps: callModel({model,system,text,json,search,thinking,maxOutputTokens,tag,taskId}) → Promise<{text,sources?}>
 *         kbRetrieve(query,{docTypes,folderIds,docIds,topK}) → Promise<{items:[{docName,docType,text}]}>
 *         resolveModel(name)、defaultModel、isTaskCancelled(taskId)、onTaskUpdate(task)、onTaskDone(task)、sleep(ms)
 * ═══════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';
  var API = {};

  var TYPES = {
    report: '報告／彙整',
    research: '上網蒐集研究',
    slides: '簡報（可下載 .pptx）',
    code: '網頁／程式'
  };
  API.TYPES = TYPES;

  var DEFAULTS = {
    concurrency: 2,        // 全域同時執行的任務數（1–4）
    useKb: true,
    topK: 6,
    slidesImages: false,   // 簡報是否要配圖（需要的話，專家會附 imageQuery，交給對話區現有機制配圖）
    separateChats: false,  // 每個任務成果另開新對話（膠水層使用）
    retry: 2,              // 遇到暫時性錯誤時最多重試次數
    maxTasks: 8,
    models: { dispatcher: '', worker: '' }
  };
  API.DEFAULTS = DEFAULTS;

  function clampInt(v, lo, hi, d) { v = parseInt(v, 10); if (isNaN(v)) return d; return Math.max(lo, Math.min(hi, v)); }
  function normalizeSettings(s) {
    s = s || {}; var m = s.models || {};
    return {
      concurrency: clampInt(s.concurrency, 1, 4, DEFAULTS.concurrency),
      useKb: s.useKb !== false,
      topK: clampInt(s.topK, 1, 12, DEFAULTS.topK),
      slidesImages: !!s.slidesImages,
      separateChats: !!s.separateChats,
      retry: clampInt(s.retry, 0, 3, DEFAULTS.retry),
      maxTasks: clampInt(s.maxTasks, 1, 12, DEFAULTS.maxTasks),
      models: { dispatcher: String(m.dispatcher || ''), worker: String(m.worker || '') }
    };
  }
  API.normalizeSettings = normalizeSettings;

  function norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ''); }
  function realSleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ── 類型猜測 ──
  API.guessType = function (text) {
    var t = String(text || '');
    if (/(簡報|ppt|pptx|投影片|slides?|slide deck)/i.test(t)) return 'slides';
    if (/(網頁|網站|html|前端|小工具|腳本|程式|script|app\b|網頁應用|儀表板|dashboard)/i.test(t)) return 'code';
    if (/(蒐集|搜集|搜尋|查詢|查找|上網|調查|研究|找資料|整理.*資料|最新|市場|競品|新聞)/i.test(t)) return 'research';
    return 'report';
  };

  // ── 名稱去重（與 nova-meeting.js 相同規則）──
  function withNames(experts) {
    var seen = {};
    return (experts || []).map(function (p) {
      var base = String(p.name || '未命名').trim() || '未命名', n = base, i = 2;
      while (seen[norm(n)]) { n = base + i; i++; }
      seen[norm(n)] = 1;
      return Object.assign({}, p, { displayName: n });
    });
  }
  API.withNames = withNames;

  function matchExpert(token, list) {
    var q = norm(token); if (!q) return null;
    var exact = list.filter(function (p) { return norm(p.displayName) === q; })[0];
    if (exact) return exact;
    if (q.length < 2) return null;
    // 前綴（@文獻 → 文獻研究員）或 token 內含完整名稱
    var pre = list.filter(function (p) { return norm(p.displayName).indexOf(q) === 0; });
    if (pre.length === 1) return pre[0];
    var inc = list.filter(function (p) { return norm(p.displayName).length >= 2 && q.indexOf(norm(p.displayName)) === 0; })
      .sort(function (a, b) { return norm(b.displayName).length - norm(a.displayName).length; });
    return inc[0] || null;
  }

  var CHAIN_RE = /(→|->|=>|＝>|接著|然後|再由|再交給|交給|轉給|續做|接手|做完後|完成後|之後再|拿去|接續)/;

  // ── 明確語法解析：@專家 任務 [→ @專家 任務] ──
  API.parseMentions = function (text, experts) {
    var list = withNames(experts), t = String(text || '');
    var re = /@([^\s@，。！？,.!?:：;；、→]{1,20})/g, m, hits = [];
    while ((m = re.exec(t))) {
      // 逐步縮短 token 找到最長可匹配的專家名
      var tok = m[1], ex = null, used = tok;
      for (var len = tok.length; len >= 1 && !ex; len--) { used = tok.slice(0, len); ex = matchExpert(used, list); }
      if (ex) hits.push({ expert: ex, start: m.index, end: m.index + 1 + used.length });
    }
    if (!hits.length) return { items: [], prefix: t.trim() };
    var items = [];
    for (var i = 0; i < hits.length; i++) {
      var seg = t.slice(hits[i].end, i + 1 < hits.length ? hits[i + 1].start : t.length);
      var before = t.slice(i === 0 ? 0 : hits[i - 1].end, hits[i].start);
      var chained = i > 0 && (CHAIN_RE.test(before.slice(-12)) || /^[\s，,：:]*(接著|然後|再|做完|完成後|之後)/.test(seg));
      // 去掉任務文字前後的連接詞與標點（「→」「做完後交給」「接著」等）
      seg = seg.replace(/[\s，,、;；]*(?:→|->|=>|＝>|做完後|完成後|之後|然後|接著|再)?[\s，,、;；]*(?:交給|轉給|由|拿去給|丟給)?[\s，,、;；→\->=＝>]*$/, '')
        .replace(/^[\s，,：:、]+/, '').replace(/^(?:接著|然後|再|做完後|完成後|之後)[\s，,：:、]*/, '').trim();
      items.push({ expertId: hits[i].expert.id, name: hits[i].expert.displayName, text: seg, chained: chained });
    }
    return { items: items, prefix: t.slice(0, hits[0].start).trim() };
  };

  function mkTask(i, o) {
    return {
      id: 't' + (i + 1), title: String(o.title || '').slice(0, 40), assigneeId: o.assigneeId, assigneeName: o.assigneeName || '',
      type: TYPES[o.type] ? o.type : 'report', instruction: String(o.instruction || '').trim(), dependsOn: (o.dependsOn || []).slice(),
      status: 'pending'
    };
  }
  function shortTitle(s) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > 18 ? s.slice(0, 18) + '…' : s; }

  function explicitPlan(text, experts) {
    var pm = API.parseMentions(text, experts);
    var tasks = pm.items.filter(function (x) { return x.text; }).map(function (x, i) {
      return mkTask(i, { title: shortTitle(x.text), assigneeId: x.expertId, assigneeName: x.name, type: API.guessType(x.text),
        instruction: (pm.prefix && pm.prefix.length > 8 ? pm.prefix + '\n' : '') + x.text, dependsOn: x.chained && i > 0 ? ['t' + i] : [] });
    });
    // chained 依據原 items 索引；過濾空任務後索引可能位移，這裡重新對齊
    return tasks;
  }

  function parseJson(text) {
    var t = String(text || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    try { return JSON.parse(t); } catch (e) { /* fallthrough */ }
    var a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e2) { /* ignore */ } }
    return null;
  }
  API._parseJson = parseJson;

  // ── 派工：把使用者的一句話變成任務清單 ──
  API.planTasks = async function (args) {
    var settings = normalizeSettings(args.settings), deps = args.deps || {};
    var list = withNames((args.experts || []).filter(function (e) { return e.enabled !== false; }));
    if (!list.length) throw new Error('沒有啟用中的專家');
    var text = String(args.text || '').trim();
    if (!text) throw new Error('沒有交辦內容');
    var explicit = explicitPlan(text, list);
    var notes = [];
    if (deps.callModel) {
      try {
        var roster = list.map(function (p) { return '- ' + p.displayName + '：' + String(p.role || '').replace(/\s+/g, ' ').slice(0, 100); }).join('\n');
        var sys = '你是任務派工員，負責把使用者的交辦內容拆成可獨立執行的任務並指派給專家。只輸出 JSON，不要回答任務本身。';
        var user = '【專家名單】\n' + roster + '\n\n【使用者交辦】\n' + text +
          '\n\n規則：\n1. 使用者用 @名稱 指定的專家必須照辦，不可換人；沒指定時依專長挑最適合的人。\n' +
          '2. 一件事一個任務，任務之間互相獨立才可同時進行；若使用者說「A 做完交給 B 續做／接著／然後」，B 的任務要在 dependsOn 填上 A 的任務 id，並在 instruction 說明要承接上游成果做什麼。\n' +
          '3. type 只能是：report（報告／彙整）、research（需要上網蒐集的研究）、slides（簡報／PPT）、code（網頁或前端程式）。\n' +
          '4. instruction 要具體完整（包含使用者提到的主題、範圍、格式要求），讓專家不必再問；title 6~14 字。\n' +
          '5. 最多 ' + settings.maxTasks + ' 個任務；id 用 t1、t2…。\n' +
          '只輸出：{"tasks":[{"id":"t1","assignee":"專家名稱","title":"…","type":"report","instruction":"…","dependsOn":[]}]}';
        var r = await deps.callModel({ model: modelFor(deps, 'dispatcher', settings), system: sys, text: user, json: true, thinking: 'low', maxOutputTokens: 2500, tag: '派工' });
        var j = parseJson(r && r.text);
        if (j && Array.isArray(j.tasks) && j.tasks.length) {
          var idMap = {}, out = [];
          j.tasks.slice(0, settings.maxTasks).forEach(function (x, i) {
            var ex = matchExpert(x.assignee, list) || matchExpert(String(x.assignee || '').replace(/^@/, ''), list);
            if (!ex) { notes.push('派工模型指派了不存在的專家「' + x.assignee + '」，已略過該任務'); return; }
            var t = mkTask(out.length, { title: x.title || shortTitle(x.instruction), assigneeId: ex.id, assigneeName: ex.displayName, type: TYPES[x.type] ? x.type : API.guessType(x.instruction || x.title), instruction: x.instruction || x.title, dependsOn: [] });
            idMap[String(x.id || ('t' + (i + 1)))] = t.id;
            t._rawDeps = Array.isArray(x.dependsOn) ? x.dependsOn : [];
            out.push(t);
          });
          out.forEach(function (t) { t.dependsOn = (t._rawDeps || []).map(function (d) { return idMap[String(d)]; }).filter(function (d) { return d && d !== t.id; }); delete t._rawDeps; });
          // 使用者 @ 指名的專家都必須出現（否則模型漏派，退回明確語法）
          var wanted = explicit.map(function (x) { return x.assigneeId; });
          var have = out.map(function (x) { return x.assigneeId; });
          var missing = wanted.filter(function (w) { return have.indexOf(w) < 0; });
          if (out.length && !missing.length) return { tasks: out, how: 'llm', notes: notes };
          if (out.length) notes.push('派工模型漏掉了你 @ 指名的專家，改用明確語法解析');
        }
      } catch (e) { notes.push('派工模型失敗（' + ((e && e.message) || e) + '）'); }
    }
    if (explicit.length) { notes.push('已依 @專家 語法解析任務'); return { tasks: explicit, how: 'explicit', notes: notes }; }
    throw new Error('無法拆出任務：' + (notes[notes.length - 1] || '請用「@專家名 要做的事」的寫法交辦'));
  };

  function modelFor(deps, key, settings, expert) {
    var pick = (expert && expert.model) || (settings.models && settings.models[key]) || '';
    return deps.resolveModel ? deps.resolveModel(pick) : (pick || deps.defaultModel);
  }

  // ── 驗證任務清單（含循環依賴偵測）──
  API.validateTasks = function (tasks, experts) {
    var errors = [], ids = {}, byId = {};
    var exIds = {}; (experts || []).forEach(function (e) { exIds[e.id] = 1; });
    var out = (tasks || []).map(function (t) { return Object.assign({}, t, { dependsOn: (t.dependsOn || []).slice() }); });
    out.forEach(function (t) { if (ids[t.id]) errors.push('任務代號重複：' + t.id); ids[t.id] = 1; byId[t.id] = t; });
    out.forEach(function (t) {
      if (!t.instruction) errors.push('任務「' + (t.title || t.id) + '」沒有內容');
      if (!exIds[t.assigneeId]) errors.push('任務「' + (t.title || t.id) + '」沒有有效的負責專家');
      t.dependsOn = t.dependsOn.filter(function (d) { return d !== t.id && ids[d]; });
    });
    // 循環偵測（DFS）
    var state = {};
    function dfs(id, path) {
      if (state[id] === 2) return false;
      if (state[id] === 1) { errors.push('任務之間有循環依賴：' + path.concat(id).join(' → ')); return true; }
      state[id] = 1;
      var cyc = false;
      (byId[id].dependsOn || []).forEach(function (d) { if (!cyc && dfs(d, path.concat(id))) cyc = true; });
      state[id] = 2; return cyc;
    }
    out.forEach(function (t) { if (!state[t.id]) dfs(t.id, []); });
    if (!out.length) errors.push('沒有任務');
    return { ok: errors.length === 0, errors: errors, tasks: out };
  };

  // ── 全域名額（semaphore）──
  API.createPool = function (limit) {
    var lim = clampInt(limit, 1, 8, 2), active = 0, q = [];
    function pump() { while (active < lim && q.length) { active++; q.shift()(); } }
    return {
      setLimit: function (n) { lim = clampInt(n, 1, 8, lim); pump(); },
      active: function () { return active; },
      queued: function () { return q.length; },
      acquire: function () {
        return new Promise(function (resolve) {
          q.push(function () { var done = false; resolve(function () { if (done) return; done = true; active--; pump(); }); });
          pump();
        });
      }
    };
  };

  // ── 成品生成 ──
  function workerSystem(ex, t) {
    return '你是「' + ex.displayName + '」。' + (ex.role ? '\n【你的角色】\n' + ex.role : '') + (ex.knowledge ? '\n【你的專業知識與立場】\n' + ex.knowledge : '') +
      '\n\n你被指派了一項獨立任務，要自己完成並交出一份可直接使用的成品。不要寒暄、不要反問使用者；資訊不足時做合理假設並在成品開頭用一行註明。' +
      '沒有依據的內容要標明是推測，不得捏造數據或出處。一律使用繁體中文（台灣）。';
  }
  function evidenceBlock(items) {
    if (!items || !items.length) return '（沒有檢索到相關的知識庫資料）';
    return items.map(function (it, i) { return '[資料' + (i + 1) + '｜' + (it.docName || '未命名') + (it.docType ? '｜' + it.docType : '') + ']\n' + String(it.text || '').slice(0, 900); }).join('\n\n');
  }
  function upstreamBlock(ups) {
    if (!ups || !ups.length) return '';
    return '\n\n【上游任務的成果（你要承接使用，必要時可修正但不要照抄全文）】\n' + ups.map(function (u) {
      return '── 來自「' + u.assigneeName + '」的任務「' + u.title + '」──\n' + String(u.text || '').slice(0, 14000);
    }).join('\n\n');
  }

  var SLIDES_SPEC = function (wantImages) {
    return '只輸出一個 JSON 物件（不要任何說明文字、不要 Markdown 圍欄），格式：\n' +
      '{"title":"簡報主標題","subtitle":"副標題（選填）","wantImages":' + (wantImages ? 'true' : 'false') + ',"slides":[{"title":"第一頁標題","content":["重點1","重點2"]' + (wantImages ? ',"imageQuery":"3-5 English keywords"' : '') + '}]}\n' +
      '規則：slides 涵蓋所有必要章節（通常 6~14 頁）；每頁 content 是字串陣列，每條不超過 40 字；' + (wantImages ? '每頁都要填 imageQuery（3~5 個英文關鍵字）。' : '不要輸出 imageQuery 欄位。') + '絕對要保證 JSON 格式正確。';
  };

  // 驗證並正規化簡報 JSON；失敗回傳 null
  API.normalizeSlides = function (obj, wantImages) {
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.slides) || !obj.slides.length) return null;
    var slides = [];
    for (var i = 0; i < obj.slides.length; i++) {
      var s = obj.slides[i]; if (!s || typeof s !== 'object') continue;
      var title = String(s.title || '').trim(); if (!title) continue;
      var content = Array.isArray(s.content) ? s.content : (s.content != null ? [s.content] : []);
      content = content.map(function (x) { return String(x).trim(); }).filter(Boolean);
      var o = { title: title, content: content };
      if (wantImages && s.imageQuery) o.imageQuery = String(s.imageQuery).trim();
      slides.push(o);
    }
    if (!slides.length) return null;
    var out = { title: String(obj.title || slides[0].title).trim(), wantImages: !!wantImages, slides: slides };
    if (obj.subtitle) out.subtitle = String(obj.subtitle).trim();
    return out;
  };

  // Python／PowerShell／nova-exec 區塊降級成純文字，避免背景任務產生的程式碼被對話區自動攔截執行
  API.defang = function (text) {
    var changed = false;
    var out = String(text || '').replace(/```[ \t]*(python|py|nova-py|nova-exec|powershell|ps1|bash|sh|cmd|bat|shell)[ \t]*(\r?\n)/gi, function (m, lang, nl) { changed = true; return '```text' + nl + '# (' + lang + ' 程式碼，未自動執行；要執行請自行檢視後複製使用)' + nl; });
    return { text: out, changed: changed };
  };

  function isTransient(e) {
    var st = e && e.status, msg = String((e && e.message) || e || '');
    return st === 429 || st === 500 || st === 502 || st === 503 || st === 504 || /429|rate|quota|overload|unavailable|timeout|逾時|連線|fetch|network/i.test(msg);
  }

  async function callWithRetry(deps, settings, task, opts) {
    var attempt = 0, sleep = deps.sleep || realSleep;
    for (;;) {
      if (deps.isTaskCancelled && deps.isTaskCancelled(task.id)) { var ce = new Error('cancelled'); ce.cancelled = true; throw ce; }
      try {
        task.calls = (task.calls || 0) + 1;
        return await deps.callModel(Object.assign({ taskId: task.id }, opts));
      } catch (e) {
        if (deps.isTaskCancelled && deps.isTaskCancelled(task.id)) { var ce2 = new Error('cancelled'); ce2.cancelled = true; throw ce2; }
        if (attempt < settings.retry && isTransient(e) && !/使用者已手動停止/.test(String(e && e.message))) {
          attempt++; task.note = '遇到暫時性錯誤，第 ' + attempt + ' 次重試…';
          if (deps.onTaskUpdate) deps.onTaskUpdate(task);
          await sleep(attempt === 1 ? 3000 : 8000);
          continue;
        }
        throw e;
      }
    }
  }

  async function executeTask(task, ex, upstream, settings, deps) {
    var type = task.type;
    var model = modelFor(deps, 'worker', settings, ex);
    var kbItems = [];
    if (settings.useKb && deps.kbRetrieve) {
      try {
        var kb = ex.kb || {};
        var rr = await deps.kbRetrieve(task.instruction, { docTypes: kb.docTypes, folderIds: kb.folderIds, docIds: kb.docIds, topK: settings.topK });
        kbItems = (rr && rr.items) || [];
      } catch (e) { task.note = '知識庫檢索失敗：' + ((e && e.message) || e); }
    }
    var base = '【任務】' + task.title + '\n【詳細要求】\n' + task.instruction + upstreamBlock(upstream) +
      (kbItems.length ? '\n\n【可參考的知識庫資料】\n' + evidenceBlock(kbItems) : '');
    var sys = workerSystem(ex, task);
    var res = { kind: type, text: '', sources: [], kbNames: Array.from(new Set(kbItems.map(function (x) { return x.docName; }).filter(Boolean))).slice(0, 6) };

    if (type === 'slides') {
      var spec = SLIDES_SPEC(settings.slidesImages);
      var r1 = await callWithRetry(deps, settings, task, { model: model, system: sys, text: base + '\n\n【輸出格式】\n' + spec, json: true, thinking: 'low', maxOutputTokens: 8000, tag: '任務：' + task.title });
      var obj = API.normalizeSlides(parseJson(r1 && r1.text), settings.slidesImages);
      if (!obj) {
        task.note = '簡報格式有誤，自動要求修正一次…'; if (deps.onTaskUpdate) deps.onTaskUpdate(task);
        var r2 = await callWithRetry(deps, settings, task, { model: model, system: sys, text: base + '\n\n你上一次的輸出不是有效的簡報 JSON：\n' + String((r1 && r1.text) || '').slice(0, 3000) + '\n\n請重新輸出，只輸出 JSON。\n' + spec, json: true, thinking: 'low', maxOutputTokens: 8000, tag: '任務：' + task.title + '（修正）' });
        obj = API.normalizeSlides(parseJson(r2 && r2.text), settings.slidesImages);
      }
      if (!obj) throw new Error('專家兩次都沒有交出有效的簡報格式（JSON）');
      res.slides = obj;
      res.text = '**簡報：' + obj.title + '**（共 ' + obj.slides.length + ' 頁）\n下方按鈕可下載 .pptx；若要調整內容，直接跟我說要改哪一頁。\n\n```json\n' + JSON.stringify(obj, null, 2) + '\n```';
      return res;
    }

    var search = type === 'research' || !!ex.web;
    var instr;
    if (type === 'code') {
      instr = '\n\n【輸出格式】\n先用最多 5 行說明這份成品是什麼與使用方式，再給出「一個完整、可直接執行」的單一檔案成品，放在 ```html 區塊（含所需的 CSS 與 JavaScript，不依賴外部檔案；需要外部函式庫時只用 cdnjs.cloudflare.com 的固定版本）。不要輸出 Python／PowerShell 腳本。';
    } else {
      instr = '\n\n【輸出格式】\n輸出一份完整的 Markdown 成品：以 `## ` 標題開頭，依序為「摘要（3~5 行）」「正文（分章節；比較類用表格）」「結論與建議」「待確認／缺少的資料」。引用知識庫資料時標明資料名稱' + (search ? '；網路資料請標明來源網站名稱' : '') + '。';
    }
    var r = await callWithRetry(deps, settings, task, { model: model, system: sys, text: base + instr, search: search, thinking: 'low', maxOutputTokens: type === 'code' ? 12000 : 8000, tag: '任務：' + task.title });
    var text = String((r && r.text) || '').trim();
    if (!text) throw new Error('專家沒有交出內容');
    var d = API.defang(text);
    text = d.text;
    if (d.changed) res.defanged = true;
    if (r && Array.isArray(r.sources) && r.sources.length) {
      var seen = {}, srcs = [];
      r.sources.forEach(function (s) { if (s && s.uri && !seen[s.uri]) { seen[s.uri] = 1; srcs.push({ title: s.title || s.uri, uri: s.uri }); } });
      res.sources = srcs.slice(0, 10);
    }
    res.text = text;
    return res;
  }
  API._executeTask = executeTask;

  // ── 排程執行一批任務 ──
  API.runTasks = async function (args) {
    var settings = normalizeSettings(args.settings), deps = args.deps || {};
    var experts = withNames(args.experts || []);
    var byEx = {}; experts.forEach(function (e) { byEx[e.id] = e; });
    var pool = args.pool || API.createPool(settings.concurrency);
    var tasks = args.tasks, byId = {}, defer = {};
    tasks.forEach(function (t) { byId[t.id] = t; defer[t.id] = {}; defer[t.id].p = new Promise(function (r) { defer[t.id].resolve = r; }); if (!t.status || t.status === 'pending') t.status = t.dependsOn && t.dependsOn.length ? 'waiting_dep' : 'queued'; });
    function upd(t) { if (deps.onTaskUpdate) { try { deps.onTaskUpdate(t); } catch (e) { /* ignore */ } } }
    function finish(t) { defer[t.id].resolve(); if (deps.onTaskDone) { try { deps.onTaskDone(t); } catch (e) { /* ignore */ } } }
    function cancelled(t) { return deps.isTaskCancelled && deps.isTaskCancelled(t.id); }

    await Promise.all(tasks.map(function (t) {
      return (async function () {
        var ex = byEx[t.assigneeId];
        try {
          upd(t);
          await Promise.all((t.dependsOn || []).map(function (d) { return defer[d] ? defer[d].p : null; }));
          var ups = (t.dependsOn || []).map(function (d) { return byId[d]; }).filter(Boolean);
          var bad = ups.filter(function (u) { return u.status !== 'done'; })[0];
          if (bad) { t.status = 'blocked'; t.error = '上游任務「' + bad.title + '」' + (bad.status === 'cancelled' ? '已取消' : '沒有完成') + '，這個任務無法繼續'; t.endedAt = Date.now(); return finish(t); }
          if (cancelled(t)) { t.status = 'cancelled'; t.endedAt = Date.now(); return finish(t); }
          t.status = 'queued'; upd(t);
          var release = await pool.acquire();
          try {
            if (cancelled(t)) { t.status = 'cancelled'; t.endedAt = Date.now(); return finish(t); }
            if (!ex) { t.status = 'failed'; t.error = '找不到負責的專家'; t.endedAt = Date.now(); return finish(t); }
            t.status = 'running'; t.startedAt = Date.now(); upd(t);
            var upData = ups.map(function (u) { return { title: u.title, assigneeName: u.assigneeName, text: (u.result && u.result.text) || '' }; });
            t.result = await executeTask(t, ex, upData, settings, deps);
            if (cancelled(t)) { t.status = 'cancelled'; t.result = null; }   // 呼叫無法中途中斷（例如 Grok）時，回來後仍尊重停止，成品不貼出
            else t.status = 'done';
          } catch (e) {
            if ((e && e.cancelled) || cancelled(t)) t.status = 'cancelled';
            else { t.status = 'failed'; t.error = (e && e.message) || String(e); }
          } finally { release(); t.endedAt = Date.now(); }
          finish(t);
        } catch (e2) { t.status = 'failed'; t.error = (e2 && e2.message) || String(e2); t.endedAt = Date.now(); finish(t); }
      })();
    }));
    return tasks;
  };

  global.NovaExpertTasks = API;
})(typeof window !== 'undefined' ? window : globalThis);

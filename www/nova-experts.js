/* [NOVA Android] nova-experts.js — 由 NOVA Desktop 同名檔案原樣移植（純邏輯、不碰 DOM／appState，行為與桌面版一致）。
   Android 移植版本紀錄：v1.0.0-android.1 - 批次 4 初次移植，內容未修改。 */
/* ═══════════════════════════════════════════════════════════
   NOVA Experts Engine v1.0.0 — 多專家協作模式
   ------------------------------------------------------------
   獨立的共用檔案，由 index.html 用 <script src="./nova-experts.js"> 引入（跟
   deep-research-engine.js 同一種做法），對外只露出 window.NovaExperts。所有跟 App
   本體的耦合（呼叫模型、檢索知識庫、進度、停止）都透過 run() 的 deps 注入，引擎本身
   不碰 appState、不碰 DOM，所以可以用 node 加假的 deps 做單元測試。

   版本紀錄：
     v1.0.1 (2026-10-10) - 純文字更名：使用者要求把「多專家會診」改稱「多專家協作」，引擎輸出的進度文字、報告標題、提示詞裡的用語一併改掉；邏輯完全沒動。
     v1.0.0 (2026-10-10) - 初版。起因：評估「多 Agent 專家 RAG」附件後，使用者要求做成一個
             「模式」：遇到問題時，多位專家依各自專業（可手動定義、擴充各專家的角色與知識）分工
             提出看法，最後由「聚合者」與「審查者」整理出一份嚴謹的結論。
             流程（每一步都是一次或多次模型呼叫，由 deps.callModel 執行）：
               ① 調度（planner）：從啟用中的專家挑出相關者（auto 模式最多 maxExperts 位；all 模式
                  全部），並替每位寫出互補、不重複的子任務與共同背景。調度失敗時退回「每位專家都
                  回答原問題」，不會中斷。
               ② 專家並行（expert）：每位專家用「自己的知識庫範圍」（文件類型／資料夾／指定文件，
                  可各自設定）檢索證據，只能依據 [E編號] 證據、標明為「專業常識」的內容、或明講的
                  推論來下主張，輸出結構化 JSON（核心看法、主張＋依據＋信心、疑慮、缺少的資料、建議）。
                  程式會「機械式」驗證：引用不存在的 [E編號] 一律剔除並計數；宣稱依據證據卻沒有
                  有效引用的主張，自動降級為推論並標記。
               ③ 交叉審閱（crossReview 輪，預設 1，可 0–2）：每位專家看其他人的看法，指出同意與
                  質疑（附理由與證據），並可修正自己的看法。
               ④ 聚合（aggregator）：只能使用專家提出的內容與證據，不得新增證據；必須如實交代
                  共識、分歧與取捨，結論強度要與證據強度相稱。
               ⑤ 審查（reviewer，獨立提示詞，可指定不同模型）：專門挑錯——無證據支持的結論、引用
                  是否真的支持該句、被抹平的分歧、遺漏的疑慮、邏輯／數值矛盾、信心過度。有重大
                  問題時退回聚合者修訂，最多 reviseMax 輪；仍未解決的問題會原樣列在報告的
                  「審查紀錄」，不會被藏起來。
               ⑥ 組裝：報告含結論、共識、分歧、依據對照、不確定性、下一步，加上審查紀錄、證據
                  清單與各專家原始意見附錄。最終報告中不存在的 [E編號] 引用由程式標成 [E?]。
             ★ 誠實說明：「嚴謹」靠的是結構（強制引用、機械式驗證、獨立審查、如實列出未解決問題），
             不是保證答案正確；專家與審查者都是語言模型，仍可能出錯。單元測試只用假模型驗證流程
             與驗證邏輯，沒有用真實 Gemini／Grok 實測，也沒有量測多專家是否真的比單一模型更準。
   ═══════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var API = { VERSION: '1.0.0' };

  // ───────────────────────── 預設專家與設定 ─────────────────────────
  function defaultExperts() {
    return [
      {
        id: 'x_lit', name: '文獻研究員', icon: '📚', enabled: true, builtin: true, web: false, model: '',
        role: '你是嚴謹的文獻研究員，擅長從論文與技術文件中萃取可靠的證據，辨別研究的條件、樣本與限制。',
        knowledge: '優先使用知識庫中的論文。引用時要說明該研究的條件（材料、溫度、方法、樣本數）。看到彼此矛盾的文獻時，指出差異可能來自哪些條件，不要擅自擇一。區分「作者的實驗結果」與「作者的推測」。',
        kb: { docTypes: ['paper'], folderIds: [], docIds: [] }
      },
      {
        id: 'x_method', name: '實驗與方法專家', icon: '🧪', enabled: true, builtin: true, web: false, model: '',
        role: '你是實驗設計與數據分析專家，專門檢視論證的方法學是否站得住腳。',
        knowledge: '檢查：對照組是否合理、變因是否被控制、量測方法與單位是否一致、樣本數與重複性、是否有統計檢定、結論是否超出數據能支持的範圍。提出可行的驗證實驗（含對照與判定準則）。',
        kb: { docTypes: ['paper', 'report', 'note'], folderIds: [], docIds: [] }
      },
      {
        id: 'x_eng', name: '工程實務專家', icon: '🏭', enabled: true, builtin: true, web: false, model: '',
        role: '你是重視量產可行性的工程實務專家，從製程窗口、成本、穩定性與放大風險評估方案。',
        knowledge: '評估：製程條件是否現實、設備與操作限制、批次穩定性、成本與供應、從實驗室放大到量產的常見落差。對「論文上有效」但「工廠難做」的方案要直言。',
        kb: { docTypes: ['spec', 'report', 'note', 'paper'], folderIds: [], docIds: [] }
      },
      {
        id: 'x_risk', name: '風險與法規專家', icon: '⚠️', enabled: true, builtin: true, web: false, model: '',
        role: '你是風險與合規專家，負責找出安全、法規、失效模式與副作用。',
        knowledge: '檢查：安全與健康風險、相關法規與標準（不確定的條文不得捏造，直接說需要查證）、失效模式與副產物、長期穩定性、對下游製程或客戶的影響。',
        kb: { docTypes: [], folderIds: [], docIds: [] }
      },
      {
        id: 'x_note', name: '個人筆記與經驗', icon: '🗒️', enabled: true, builtin: true, web: false, model: '',
        role: '你代表使用者過去累積的筆記與實務經驗，負責回答「我們以前記錄過什麼」。',
        knowledge: '只根據知識庫中的筆記作答，筆記常零碎、可能過時或只是臨時想法：引用時要註明這是個人筆記而非已驗證結論，並指出筆記與正式文獻衝突的地方。沒有相關筆記就明說沒有。',
        kb: { docTypes: ['note'], folderIds: [], docIds: [] }
      },
      {
        id: 'x_devil', name: '反方質疑者', icon: '🛡️', enabled: false, builtin: true, web: false, model: '',
        role: '你是刻意唱反調的質疑者，任務是找出主流看法的漏洞、替代解釋與被忽略的反例。',
        knowledge: '對任何看似順理成章的結論，提出至少一個合理的替代解釋或反例，並說明什麼證據可以區分兩者。質疑必須有理有據，不為反對而反對。',
        kb: { docTypes: [], folderIds: [], docIds: [] }
      }
    ];
  }
  API.defaultExperts = defaultExperts;

  var DEFAULT_SETTINGS = {
    selection: 'auto',     // auto＝調度者挑相關專家（最多 maxExperts）；all＝所有啟用中的專家
    maxExperts: 4,
    crossReview: 1,        // 交叉審閱輪數 0–2
    reviewer: true,        // 是否啟用獨立審查者
    reviseMax: 1,          // 審查不通過時最多退回修訂幾輪
    concurrency: 3,
    topK: 6,               // 每位專家的知識庫檢索段數
    useKb: true,
    models: { planner: '', expert: '', aggregator: '', reviewer: '' }
  };
  API.DEFAULT_SETTINGS = DEFAULT_SETTINGS;

  function clampInt(v, lo, hi, dflt) {
    v = parseInt(v, 10);
    if (isNaN(v)) return dflt;
    return Math.max(lo, Math.min(hi, v));
  }
  function normalizeSettings(s) {
    s = s || {};
    var m = s.models || {};
    return {
      selection: s.selection === 'all' ? 'all' : 'auto',
      maxExperts: clampInt(s.maxExperts, 1, 8, DEFAULT_SETTINGS.maxExperts),
      crossReview: clampInt(s.crossReview, 0, 2, DEFAULT_SETTINGS.crossReview),
      reviewer: s.reviewer !== false,
      reviseMax: clampInt(s.reviseMax, 0, 2, DEFAULT_SETTINGS.reviseMax),
      concurrency: clampInt(s.concurrency, 1, 6, DEFAULT_SETTINGS.concurrency),
      topK: clampInt(s.topK, 2, 12, DEFAULT_SETTINGS.topK),
      useKb: s.useKb !== false,
      models: { planner: m.planner || '', expert: m.expert || '', aggregator: m.aggregator || '', reviewer: m.reviewer || '' }
    };
  }
  API.normalizeSettings = normalizeSettings;

  function normalizeExpert(e) {
    e = e || {};
    var kb = e.kb || {};
    var arr = function (v) { return Array.isArray(v) ? v.map(String).filter(Boolean) : []; };
    return {
      id: String(e.id || ('x_' + Math.random().toString(36).slice(2, 9))),
      name: String(e.name || '未命名專家').slice(0, 40),
      icon: String(e.icon || '🧑‍🔬').slice(0, 4),
      role: String(e.role || '').slice(0, 2000),
      knowledge: String(e.knowledge || '').slice(0, 8000),
      kb: { docTypes: arr(kb.docTypes), folderIds: arr(kb.folderIds), docIds: arr(kb.docIds) },
      model: String(e.model || ''),
      web: !!e.web,
      enabled: e.enabled !== false,
      builtin: !!e.builtin
    };
  }
  API.normalizeExpert = normalizeExpert;

  // 預估模型呼叫次數（給介面顯示）
  API.estimateCalls = function (settings, nExperts) {
    var s = normalizeSettings(settings);
    var n = Math.max(1, nExperts | 0);
    var calls = 1 + n + (n > 1 ? s.crossReview * n : 0) + 1;
    if (s.reviewer) calls += 1 + s.reviseMax * 2;     // 最壞情況：每輪修訂＝1 次修訂＋1 次再審
    return calls;
  };

  // ───────────────────────── 小工具 ─────────────────────────
  function clip(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n) + '…' : s;
  }
  function safeJsonParse(text) {
    if (text == null) return null;
    var t = String(text).trim();
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    var tryParse = function (x) { try { return JSON.parse(x); } catch (e) { return undefined; } };
    var r = tryParse(t);
    if (r !== undefined) return r;
    var a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a !== -1 && b > a) {
      var sub = t.slice(a, b + 1);
      r = tryParse(sub);
      if (r !== undefined) return r;
      r = tryParse(sub.replace(/,\s*([}\]])/g, '$1'));
      if (r !== undefined) return r;
    }
    return null;
  }
  async function mapLimit(items, limit, fn) {
    var out = new Array(items.length);
    var next = 0;
    var workers = [];
    var worker = async function () {
      while (true) {
        var i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    };
    for (var k = 0; k < Math.min(limit, items.length); k++) workers.push(worker());
    await Promise.all(workers);
    return out;
  }
  function fmtDuration(ms) {
    var s = Math.round(ms / 1000);
    return s < 60 ? s + ' 秒' : Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
  }
  var CANCELLED = 'NOVA_EXPERTS_CANCELLED';

  // ───────────────────────── 執行 ─────────────────────────
  function createRun(args) {
    var run = {
      question: String(args.question || '').trim(),
      history: String(args.history || ''),
      settings: normalizeSettings(args.settings),
      deps: args.deps || {},
      experts: [],          // 本次參與者 [{def, task, status, result, cross, sources, error}]
      evidence: [],         // [{id, docName, docType, text, score, url}]
      evKey: {},
      stats: { calls: 0, byModel: {}, invalidCitations: 0, downgradedClaims: 0, failedExperts: 0, retries: 0 },
      phases: [],
      current: '',
      t0: 0,
      review: null,
      notes: []
    };
    run.now = run.deps.now || Date.now;
    run.sleep = run.deps.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    run.t0 = run.now();
    return run;
  }

  function checkCancel(run) {
    if (run.deps.isCancelled && run.deps.isCancelled()) throw new Error(CANCELLED);
  }

  function setPhase(run, key, label, status, detail) {
    var p = null;
    for (var i = 0; i < run.phases.length; i++) if (run.phases[i].key === key) { p = run.phases[i]; break; }
    if (!p) { p = { key: key, label: label }; run.phases.push(p); }
    p.status = status; if (detail !== undefined) p.detail = detail;
    run.current = label + (detail ? '（' + detail + '）' : '');
    emit(run);
  }
  function renderProgress(run) {
    var icon = { pending: '⬜', running: '⏳', done: '✅', failed: '⚠️', skipped: '➖' };
    var lines = ['🧑‍🔬 **多專家協作進行中**（已用 ' + fmtDuration(run.now() - run.t0) + '，模型呼叫 ' + run.stats.calls + ' 次）', ''];
    run.phases.forEach(function (p) {
      lines.push((icon[p.status] || '⬜') + ' ' + p.label + (p.detail ? '：' + p.detail : ''));
    });
    if (run.experts.length) {
      lines.push('');
      run.experts.forEach(function (x) {
        var st = x.status === 'done' ? '✅' : x.status === 'running' ? '⏳' : x.status === 'failed' ? '⚠️' : '⬜';
        lines.push('　' + st + ' ' + x.def.icon + ' ' + x.def.name + (x.task ? '：' + clip(x.task, 40) : ''));
      });
    }
    return lines.join('\n');
  }
  function emit(run) {
    if (!run.deps.onProgress) return;
    try {
      run.deps.onProgress(renderProgress(run), {
        current: run.current, calls: run.stats.calls, elapsedMs: run.now() - run.t0,
        phases: run.phases.map(function (p) { return { key: p.key, label: p.label, status: p.status, detail: p.detail || '' }; }),
        experts: run.experts.map(function (x) { return { id: x.def.id, name: x.def.name, icon: x.def.icon, status: x.status }; }),
        evidence: run.evidence.length
      });
    } catch (e) { /* ignore */ }
  }

  function isTransient(e) {
    var st = e && e.status;
    var msg = String((e && e.message) || e || '');
    return st === 429 || st === 500 || st === 502 || st === 503 || st === 504 || /429|503|overload|rate|timeout|逾時|暫時|temporar|fetch failed|network/i.test(msg);
  }

  async function callLLM(run, label, o) {
    var attempts = 3;
    var lastErr = null;
    for (var a = 0; a < attempts; a++) {
      checkCancel(run);
      try {
        run.stats.calls++;
        run.stats.byModel[o.model] = (run.stats.byModel[o.model] || 0) + 1;
        emit(run);
        var res = await run.deps.callModel(Object.assign({ tag: label }, o));
        checkCancel(run);
        return res || { text: '' };
      } catch (e) {
        if (e && e.message === CANCELLED) throw e;
        lastErr = e;
        if (run.deps.isCancelled && run.deps.isCancelled()) throw new Error(CANCELLED);
        if (a < attempts - 1 && isTransient(e)) {
          run.stats.retries++;
          await run.sleep(1500 * (a + 1) + Math.floor(Math.random() * 400));
          continue;
        }
        break;
      }
    }
    throw lastErr || new Error(label + ' 失敗');
  }

  // 要 JSON 的呼叫：解析失敗時帶著提醒重試一次
  async function callJson(run, label, o) {
    var res = await callLLM(run, label, Object.assign({}, o, { json: true }));
    var obj = safeJsonParse(res.text);
    if (obj && typeof obj === 'object') return { obj: obj, res: res };
    var res2 = await callLLM(run, label + '（重試）', Object.assign({}, o, { json: true, text: o.text + '\n\n【提醒】上一次的輸出無法解析。這次請只輸出一個合法的 JSON 物件，不要有任何其他文字或 Markdown 圍欄。' }));
    var obj2 = safeJsonParse(res2.text);
    return { obj: (obj2 && typeof obj2 === 'object') ? obj2 : null, res: res2 };
  }

  function modelFor(run, role, expert) {
    var m = (expert && expert.model) || run.settings.models[role === 'expert' || role === 'cross' ? 'expert' : role] || run.deps.defaultModel || '';
    return (run.deps.resolveModel ? run.deps.resolveModel(m) : m) || run.deps.defaultModel || '';
  }

  // ── 證據登錄 ──
  function addEvidence(run, item) {
    var key = (item.docName || '') + '|' + String(item.text || '').slice(0, 120) + '|' + (item.url || '');
    if (run.evKey[key]) return run.evKey[key];
    var id = 'E' + (run.evidence.length + 1);
    run.evidence.push({ id: id, docName: item.docName || '(未命名)', docType: item.docType || '', text: String(item.text || ''), score: item.score, url: item.url || '' });
    run.evKey[key] = id;
    return id;
  }
  function evById(run, id) {
    for (var i = 0; i < run.evidence.length; i++) if (run.evidence[i].id === id) return run.evidence[i];
    return null;
  }
  function evLabel(e) {
    return '[' + e.id + '] 來源：' + e.docName + (e.docType ? '（' + e.docType + '）' : '') + (typeof e.score === 'number' ? ' 相似度 ' + (e.score * 100).toFixed(0) + '%' : '');
  }

  // ───────────────────────── ① 調度 ─────────────────────────
  async function planStage(run, pool) {
    var s = run.settings;
    var cap = s.selection === 'all' ? pool.length : Math.min(s.maxExperts, pool.length);
    setPhase(run, 'plan', '① 調度：挑選專家並分派任務', 'running');
    var listing = pool.map(function (e) {
      return '- id=' + e.id + '｜' + e.name + '｜職責：' + clip(e.role, 90) + '｜專長：' + clip(e.knowledge, 110);
    }).join('\n');
    var text = '【使用者問題】\n' + run.question + (run.history ? '\n\n【先前對話脈絡（僅供理解問題，不是證據）】\n' + clip(run.history, 1500) : '') +
      '\n\n【可用專家】\n' + listing +
      '\n\n請輸出 JSON：{"complexity":"simple|moderate|complex","sharedContext":"所有專家都應知道的問題背景或限制（沒有就空字串）",' +
      '"picks":[{"id":"專家id","task":"分派給這位專家的具體子任務，說明希望他從自己的專業回答什麼","why":"一句話理由"}]}\n' +
      '規則：\n' + (s.selection === 'all' ? '1. 必須替上面每一位專家各寫一個 task。\n' : '1. 最多選 ' + cap + ' 位，只選真正相關的；問題只涉及單一面向時少選幾位也可以（至少 1 位）。\n') +
      '2. 各專家的 task 要互補、避免重複；task 必須與該專家的專長直接相關。\n3. id 只能使用上面列出的 id。';
    var picks = [];
    var shared = '';
    try {
      var r = await callJson(run, '調度', {
        model: modelFor(run, 'planner'), system: '你是協作的調度者，只負責挑選專家與分派任務，不回答問題本身。', text: text,
        maxOutputTokens: 1500, thinking: 'low'
      });
      if (r.obj) {
        shared = String(r.obj.sharedContext || '');
        (Array.isArray(r.obj.picks) ? r.obj.picks : []).forEach(function (p) {
          var def = pool.filter(function (e) { return e.id === p.id; })[0];
          if (def && !picks.some(function (x) { return x.def.id === def.id; })) picks.push({ def: def, task: String(p.task || '').trim() || run.question, why: String(p.why || '') });
        });
      }
    } catch (e) {
      if (e && e.message === CANCELLED) throw e;
      run.notes.push('調度失敗（' + ((e && e.message) || e) + '），改為每位專家直接回答原問題。');
    }
    if (s.selection === 'all') {
      pool.forEach(function (d) { if (!picks.some(function (x) { return x.def.id === d.id; })) picks.push({ def: d, task: run.question, why: '' }); });
    }
    if (!picks.length) {
      run.notes.push('調度沒有產生有效的專家分派，改為前 ' + cap + ' 位專家各自回答原問題。');
      picks = pool.slice(0, cap).map(function (d) { return { def: d, task: run.question, why: '' }; });
    }
    picks = picks.slice(0, cap);
    run.sharedContext = shared;
    run.experts = picks.map(function (p) { return { def: p.def, task: p.task, why: p.why, status: 'pending', result: null, cross: null, sources: [], error: '' }; });
    setPhase(run, 'plan', '① 調度：挑選專家並分派任務', 'done', '選出 ' + run.experts.length + ' 位');
  }

  // ───────────────────────── ② 專家並行 ─────────────────────────
  function expertSystem(def, withWeb) {
    return def.role + '\n\n【你的專業知識與判斷準則】\n' + (def.knowledge || '（無額外設定，依你的專業判斷）') +
      '\n\n【工作守則】\n1. 你是多專家協作中的一位，只從你的專業角度回答，不替其他領域下結論。\n' +
      '2. 你只能依據三種來源下主張：(a)「知識庫證據」中的內容，必須用 [E編號] 引用（basis=evidence）；(b) 你可靠的專業常識，不得捏造具體數據、文獻、型號或出處（basis=knowledge）；(c) 由證據推論出來的結果，要說明推論路徑（basis=inference）。' +
      (withWeb ? '(d) 網路搜尋得到的資訊（basis=web）。' : '') + '\n' +
      '3. 證據不足就明說，列入 missing_info，不要硬答。數值、型號、條件必須與證據一致；沒把握就降低 confidence。\n' +
      '4. 只能使用使用者訊息中列出的 [E編號]，不可自創編號。\n5. 一律使用繁體中文。';
  }
  function evidenceBlock(items) {
    if (!items.length) return '（知識庫沒有找到與此任務相關的資料。你只能依專業常識作答，且 basis 不可標為 evidence。）';
    var total = 0;
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var e = items[i];
      var body = clip(e.text, /^【表格】/.test(e.text) ? 2600 : 1100);
      if (total + body.length > 9500) break;
      total += body.length;
      out.push(evLabel(e) + '\n' + body);
    }
    return out.join('\n\n');
  }
  var BASES = { evidence: 1, knowledge: 1, inference: 1, web: 1 };

  function validateResult(run, obj, allowedIds, webIds) {
    var res = { viewpoint: '', claims: [], concerns: [], missing_info: [], recommendation: '' };
    if (!obj || typeof obj !== 'object') return res;
    res.viewpoint = String(obj.viewpoint || '').trim();
    res.recommendation = String(obj.recommendation || '').trim();
    res.concerns = (Array.isArray(obj.concerns) ? obj.concerns : []).map(String).filter(Boolean).slice(0, 8);
    res.missing_info = (Array.isArray(obj.missing_info) ? obj.missing_info : []).map(String).filter(Boolean).slice(0, 8);
    (Array.isArray(obj.claims) ? obj.claims : []).slice(0, 8).forEach(function (c) {
      if (!c || !String(c.text || '').trim()) return;
      var basis = BASES[c.basis] ? c.basis : 'inference';
      var ids = (Array.isArray(c.evidence_ids) ? c.evidence_ids : []).map(function (x) { return String(x).replace(/[\[\]\s]/g, ''); });
      var valid = ids.filter(function (id) { return allowedIds.indexOf(id) !== -1; });
      run.stats.invalidCitations += ids.length - valid.length;
      var flag = '';
      if (basis === 'web') { valid = webIds.slice(); }
      if (basis === 'evidence' && !valid.length) { basis = 'inference'; flag = '原標為證據但沒有有效引用，已降級為推論'; run.stats.downgradedClaims++; }
      var conf = parseFloat(c.confidence);
      if (isNaN(conf)) conf = 0.5;
      conf = Math.max(0, Math.min(1, conf));
      if (basis !== 'evidence' && basis !== 'web' && conf > 0.85) conf = 0.85;   // 非證據主張不給過高信心
      res.claims.push({ text: String(c.text).trim(), basis: basis, evidence_ids: valid, confidence: conf, flag: flag });
    });
    return res;
  }

  async function runExpert(run, x, idx) {
    var def = x.def;
    x.status = 'running'; emit(run);
    try {
      var items = [];
      if (run.settings.useKb && run.deps.kbRetrieve) {
        try {
          var scope = { docTypes: def.kb.docTypes, folderIds: def.kb.folderIds, docIds: def.kb.docIds, topK: run.settings.topK };
          var r = await run.deps.kbRetrieve(x.task + '\n' + run.question, scope);
          items = (r && r.items) || [];
        } catch (e) { run.notes.push('「' + def.name + '」知識庫檢索失敗：' + ((e && e.message) || e)); }
      }
      checkCancel(run);
      var allowed = items.map(function (it) { return addEvidence(run, it); });
      var ctxItems = items.map(function (it, i) { return Object.assign({}, it, { id: allowed[i] }); });
      var user = '【使用者問題】\n' + run.question + (run.sharedContext ? '\n\n【共同背景】\n' + run.sharedContext : '') +
        '\n\n【分派給你的任務】\n' + x.task + '\n\n【知識庫證據】\n' + evidenceBlock(ctxItems) +
        '\n\n請輸出 JSON：\n{"viewpoint":"你的核心看法（繁體中文，120 字內）",' +
        '"claims":[{"text":"一個可被檢驗的主張，只講一件事","basis":"evidence|knowledge|inference' + (def.web ? '|web' : '') + '","evidence_ids":["E1"],"confidence":0.0}],' +
        '"concerns":["你看到的風險、疑慮或反例"],"missing_info":["要做出更確定的結論還缺什麼資料"],"recommendation":"你的具體建議（含下一步）"}\n' +
        'claims 寫 3~6 條；confidence 為 0~1 的小數，與證據強度相稱。';
      var webIds = [];
      var r2 = await callJson(run, '專家：' + def.name, {
        model: modelFor(run, 'expert', def), system: expertSystem(def, def.web), text: user,
        maxOutputTokens: 3000, thinking: 'low', search: !!def.web
      });
      if (def.web && r2.res && Array.isArray(r2.res.sources)) {
        r2.res.sources.slice(0, 6).forEach(function (s) {
          webIds.push(addEvidence(run, { docName: s.title || s.uri || '網路來源', docType: '網頁', text: '（網路搜尋來源，無片段）', url: s.uri || '' }));
          x.sources.push({ title: s.title || '', url: s.uri || '' });
        });
      }
      var allAllowed = allowed.concat(webIds);
      var val = validateResult(run, r2.obj, allAllowed, webIds);
      if (!r2.obj) {
        val.viewpoint = clip((r2.res && r2.res.text) || '', 400);
        run.notes.push('「' + def.name + '」的輸出無法解析為結構化格式，只保留原文摘要。');
      }
      x.result = val;
      x.allowedIds = allAllowed;
      x.status = 'done';
    } catch (e) {
      if (e && e.message === CANCELLED) throw e;
      x.status = 'failed'; x.error = (e && e.message) || String(e);
      run.stats.failedExperts++;
      run.notes.push('「' + def.name + '」發表意見失敗：' + x.error);
    }
    emit(run);
  }

  async function expertsStage(run) {
    setPhase(run, 'experts', '② 專家並行發表看法', 'running', '0/' + run.experts.length);
    var doneCount = 0;
    await mapLimit(run.experts, run.settings.concurrency, async function (x, i) {
      await runExpert(run, x, i);
      doneCount++;
      setPhase(run, 'experts', '② 專家並行發表看法', 'running', doneCount + '/' + run.experts.length);
    });
    var ok = run.experts.filter(function (x) { return x.status === 'done'; });
    if (!ok.length) throw new Error('所有專家都沒有成功發表意見：' + run.experts.map(function (x) { return x.def.name + '：' + x.error; }).join('；'));
    setPhase(run, 'experts', '② 專家並行發表看法', 'done', ok.length + '/' + run.experts.length + ' 位完成');
  }

  // ───────────────────────── ③ 交叉審閱 ─────────────────────────
  function claimsDigest(x) {
    var r = x.result;
    if (!r) return '';
    var lines = ['〈' + x.def.name + '〉核心看法：' + (r.viewpoint || '（無）')];
    r.claims.forEach(function (c, i) {
      lines.push('  [' + x.def.id + '#' + (i + 1) + '] ' + c.text + '（依據：' + c.basis + (c.evidence_ids.length ? ' ' + c.evidence_ids.map(function (d) { return '[' + d + ']'; }).join('') : '') + '；信心 ' + c.confidence.toFixed(2) + (c.flag ? '；' + c.flag : '') + '）');
    });
    if (r.concerns.length) lines.push('  疑慮：' + r.concerns.join('；'));
    if (r.missing_info.length) lines.push('  缺少資料：' + r.missing_info.join('；'));
    if (r.recommendation) lines.push('  建議：' + r.recommendation);
    return lines.join('\n');
  }
  function citedEvidenceBlock(run, xs, cap) {
    var ids = {};
    xs.forEach(function (x) { if (x.result) x.result.claims.forEach(function (c) { c.evidence_ids.forEach(function (d) { ids[d] = 1; }); }); });
    var out = Object.keys(ids).map(function (d) { return evById(run, d); }).filter(Boolean).map(function (e) {
      return evLabel(e) + '\n' + clip(e.text, cap);
    });
    return out.length ? out.join('\n\n') : '（專家沒有引用任何知識庫證據）';
  }

  async function crossStage(run) {
    var active = run.experts.filter(function (x) { return x.status === 'done'; });
    if (run.settings.crossReview < 1 || active.length < 2) {
      setPhase(run, 'cross', '③ 交叉審閱', 'skipped', active.length < 2 ? '只有一位專家' : '已關閉');
      return;
    }
    for (var round = 1; round <= run.settings.crossReview; round++) {
      setPhase(run, 'cross', '③ 交叉審閱', 'running', '第 ' + round + '/' + run.settings.crossReview + ' 輪');
      await mapLimit(active, run.settings.concurrency, async function (x) {
        checkCancel(run);
        var others = active.filter(function (o) { return o !== x; });
        var mine = claimsDigest(x);
        var user = '【使用者問題】\n' + run.question + '\n\n【你先前的看法】\n' + mine +
          '\n\n【其他專家的看法】\n' + others.map(claimsDigest).join('\n\n') +
          '\n\n【被引用的證據】\n' + citedEvidenceBlock(run, others, 500) +
          '\n\n請輸出 JSON：{"agreements":[{"ref":"專家id#序號","note":"同意的理由（簡短）"}],' +
          '"disputes":[{"ref":"專家id#序號","reason":"你認為有問題的理由，要引用證據或指出邏輯漏洞","evidence_ids":[],"severity":"high|medium|low"}],' +
          '"revision":{"viewpoint":"若需修正自己的核心看法，寫更新後的版本；不需要就空字串","changes":"改了什麼、為什麼"},' +
          '"questions":["想追問其他專家的問題"]}\n' +
          '規則：只質疑有實質問題的主張，不要為反對而反對；ref 必須使用上面出現的 [專家id#序號]。';
        try {
          var r = await callJson(run, '交叉審閱：' + x.def.name, {
            model: modelFor(run, 'cross', x.def), system: x.def.role + '\n現在你要以自己的專業審閱其他專家的看法：同意有道理的、質疑站不住的，必要時修正自己。使用繁體中文。',
            text: user, maxOutputTokens: 2000, thinking: 'low'
          });
          if (r.obj) {
            var prev = x.cross || { agreements: [], disputes: [], revision: null, questions: [] };
            var o = r.obj;
            var okRef = function (ref) { return /^[\w-]+#\d+$/.test(String(ref || '')); };
            prev.agreements = prev.agreements.concat((Array.isArray(o.agreements) ? o.agreements : []).filter(function (a) { return a && okRef(a.ref); }).map(function (a) { return { ref: String(a.ref), note: String(a.note || '') }; }));
            prev.disputes = prev.disputes.concat((Array.isArray(o.disputes) ? o.disputes : []).filter(function (d) { return d && okRef(d.ref) && String(d.reason || '').trim(); }).map(function (d) {
              var ids = (Array.isArray(d.evidence_ids) ? d.evidence_ids : []).map(function (v) { return String(v).replace(/[\[\]\s]/g, ''); }).filter(function (v) { return !!evById(run, v); });
              return { ref: String(d.ref), reason: String(d.reason), evidence_ids: ids, severity: ['high', 'medium', 'low'].indexOf(d.severity) !== -1 ? d.severity : 'medium' };
            }));
            if (o.revision && String(o.revision.viewpoint || '').trim()) {
              prev.revision = { viewpoint: String(o.revision.viewpoint).trim(), changes: String(o.revision.changes || '') };
              if (!x.firstViewpoint) x.firstViewpoint = x.result.viewpoint;   // 原看法留存，報告附錄會並列
              x.result.viewpoint = prev.revision.viewpoint;                    // 以修正後的看法為準
            }
            prev.questions = prev.questions.concat((Array.isArray(o.questions) ? o.questions : []).map(String).filter(Boolean).slice(0, 3));
            x.cross = prev;
          }
        } catch (e) {
          if (e && e.message === CANCELLED) throw e;
          run.notes.push('「' + x.def.name + '」的交叉審閱失敗：' + ((e && e.message) || e));
        }
      });
    }
    setPhase(run, 'cross', '③ 交叉審閱', 'done');
  }

  function disputesDigest(run) {
    var lines = [];
    run.experts.forEach(function (x) {
      if (!x.cross) return;
      x.cross.disputes.forEach(function (d) {
        lines.push('- ' + x.def.name + ' 質疑 ' + d.ref + '（' + d.severity + '）：' + d.reason + (d.evidence_ids.length ? ' ' + d.evidence_ids.map(function (i) { return '[' + i + ']'; }).join('') : ''));
      });
      if (x.cross.revision) lines.push('- ' + x.def.name + ' 修正了自己的看法：' + x.cross.revision.changes);
    });
    return lines.length ? lines.join('\n') : '（沒有提出質疑）';
  }

  // ───────────────────────── ④ 聚合與 ⑤ 審查 ─────────────────────────
  var AGG_SYSTEM = '你是協作的聚合者。你要把各專家的意見整合成一份嚴謹、誠實的結論。\n' +
    '鐵則：\n1. 只能使用專家提出的主張與證據清單，不得新增任何證據、數據、文獻或引用；引用用 [E編號]，編號必須存在於證據清單。\n' +
    '2. 專家之間的分歧與質疑必須如實交代，說明你採信哪一方與理由；無法裁決時就寫「無法裁決」並指出需要什麼資料。不可悄悄抹平或偏袒。\n' +
    '3. 結論的強度要與證據強度相稱：只有專業常識或推論支持的內容，要明確標示，不得說成已被證實。\n' +
    '4. 保留專家提出的疑慮與缺少的資料，列入「不確定性與限制」。\n5. 使用繁體中文，精確、簡潔，不要客套與贅述。';
  var REPORT_FORMAT = '請依下列結構輸出 Markdown（章節標題照用）：\n' +
    '## 結論\n（先用 1–3 句直接回答問題，並標明整體信心：高／中／低，以及一句話理由）\n' +
    '## 共識\n（各專家一致或高度重疊的重點，條列，附 [E編號] 或標明「專業常識」）\n' +
    '## 分歧與取捨\n（每個分歧：各方看法 → 你的判斷與理由；無法裁決的明說）\n' +
    '## 依據對照\n（關鍵主張各自的依據：證據 [E編號]／專業常識／推論）\n' +
    '## 不確定性與限制\n（缺少的資料、證據薄弱處、可能出錯的地方）\n' +
    '## 建議下一步\n（具體可執行的驗證或行動，由重要到次要）';

  function evidenceCatalog(run, cap) {
    if (!run.evidence.length) return '（本次沒有任何知識庫證據）';
    return run.evidence.map(function (e) { return evLabel(e) + '\n' + clip(e.text, cap); }).join('\n\n');
  }
  function expertsDigest(run) {
    return run.experts.filter(function (x) { return x.status === 'done'; }).map(function (x) {
      return '▍' + x.def.icon + ' ' + x.def.name + '｜任務：' + x.task + '\n' + claimsDigest(x);
    }).join('\n\n');
  }

  async function aggregateStage(run) {
    setPhase(run, 'agg', '④ 聚合：整理共識與分歧', 'running');
    var user = '【使用者問題】\n' + run.question + (run.sharedContext ? '\n\n【共同背景】\n' + run.sharedContext : '') +
      '\n\n【各專家意見】\n' + expertsDigest(run) + '\n\n【交叉審閱中的質疑與修正】\n' + disputesDigest(run) +
      '\n\n【證據清單】\n' + evidenceCatalog(run, 320) + '\n\n' + REPORT_FORMAT;
    var res = await callLLM(run, '聚合', {
      model: modelFor(run, 'aggregator'), system: AGG_SYSTEM, text: user, maxOutputTokens: 6000, thinking: 'medium'
    });
    run.draft = String(res.text || '').trim();
    if (!run.draft) throw new Error('聚合者沒有產生內容');
    setPhase(run, 'agg', '④ 聚合：整理共識與分歧', 'done');
  }

  var REV_SYSTEM = '你是獨立審查者，沒有參與前面的討論，立場是「挑錯」。你的任務不是改寫，而是找出草稿中站不住腳的地方。\n' +
    '逐項檢查：\n1. 每個關鍵結論是否有證據或專家共識支持？有沒有超出證據的推論或誇大（overclaim）？\n' +
    '2. 草稿引用的 [E編號] 是否存在、內容是否真的支持那一句（對照證據片段）？\n' +
    '3. 專家之間的分歧與質疑是否被如實呈現？有沒有被悄悄抹平、或偏袒其中一方？\n' +
    '4. 專家提出的疑慮、缺少的資料是否被遺漏？\n5. 有沒有邏輯矛盾、數值／單位／條件錯誤、因果誇大？\n6. 整體信心等級是否與證據強度相稱？\n' +
    '判定規則：有任何 high 等級問題，或 medium 等級問題達 3 項以上，verdict 必須是 revise；否則 pass。使用繁體中文。';

  async function reviewOnce(run, draft) {
    var user = '【使用者問題】\n' + run.question + '\n\n【待審查草稿】\n' + draft +
      '\n\n【各專家原始意見】\n' + expertsDigest(run) + '\n\n【交叉審閱中的質疑與修正】\n' + disputesDigest(run) +
      '\n\n【證據清單（含片段）】\n' + evidenceCatalog(run, 700) +
      '\n\n請輸出 JSON：{"verdict":"pass|revise","score":0到10的整數,"issues":[{"severity":"high|medium|low",' +
      '"type":"unsupported|citation|suppressed_dissent|omission|contradiction|overclaim|logic","quote":"草稿中的原句（盡量短）","problem":"問題是什麼","fix":"建議怎麼修"}],"summary":"整體評語（80 字內）"}';
    var r = await callJson(run, '審查', { model: modelFor(run, 'reviewer'), system: REV_SYSTEM, text: user, maxOutputTokens: 3000, thinking: 'medium' });
    var o = r.obj;
    if (!o) return null;
    var issues = (Array.isArray(o.issues) ? o.issues : []).filter(function (i) { return i && String(i.problem || '').trim(); }).slice(0, 12).map(function (i) {
      return {
        severity: ['high', 'medium', 'low'].indexOf(i.severity) !== -1 ? i.severity : 'medium',
        type: String(i.type || 'logic'), quote: clip(i.quote, 160), problem: String(i.problem), fix: String(i.fix || '')
      };
    });
    var high = issues.filter(function (i) { return i.severity === 'high'; }).length;
    var med = issues.filter(function (i) { return i.severity === 'medium'; }).length;
    // 不信任模型自己給的 verdict：以規則為準
    var verdict = (high > 0 || med >= 3) ? 'revise' : 'pass';
    var score = parseInt(o.score, 10);
    return { verdict: verdict, score: isNaN(score) ? null : Math.max(0, Math.min(10, score)), issues: issues, summary: String(o.summary || '') };
  }

  // 程式端機械檢查：草稿中引用了不存在的 [E編號]
  function citationIssues(run, draft) {
    var issues = [];
    var seen = {};
    var re = /\[E(\d+)\]/g, m;
    while ((m = re.exec(draft)) !== null) {
      var id = 'E' + m[1];
      if (!evById(run, id) && !seen[id]) {
        seen[id] = 1;
        issues.push({ severity: 'high', type: 'citation', quote: '[' + id + ']', problem: '草稿引用了不存在的證據編號 ' + id, fix: '移除這個引用，或改成實際存在的編號；沒有證據支持的句子要降級為推論' });
      }
    }
    return issues;
  }

  async function reviewStage(run) {
    if (!run.settings.reviewer) {
      setPhase(run, 'review', '⑤ 審查', 'skipped', '已關閉');
      return;
    }
    var loops = 0;
    var rounds = [];
    while (true) {
      setPhase(run, 'review', '⑤ 獨立審查', 'running', loops ? '修訂後第 ' + (loops + 1) + ' 次審查' : '');
      var rv = null;
      try { rv = await reviewOnce(run, run.draft); }
      catch (e) { if (e && e.message === CANCELLED) throw e; run.notes.push('審查失敗：' + ((e && e.message) || e)); }
      if (!rv) { rounds.push({ verdict: 'error', score: null, issues: [], summary: '審查者沒有產生可解析的結果' }); break; }
      var mech = citationIssues(run, run.draft);
      if (mech.length) { rv.issues = mech.concat(rv.issues); rv.verdict = 'revise'; }
      rounds.push(rv);
      if (rv.verdict === 'pass' || loops >= run.settings.reviseMax) break;
      // 退回聚合者修訂
      loops++;
      setPhase(run, 'review', '⑤ 獨立審查', 'running', '退回修訂（第 ' + loops + ' 輪）');
      var fixList = rv.issues.filter(function (i) { return i.severity !== 'low'; }).map(function (i, n) {
        return (n + 1) + '. [' + i.severity + '/' + i.type + '] ' + (i.quote ? '「' + i.quote + '」 ' : '') + i.problem + (i.fix ? '。建議：' + i.fix : '');
      }).join('\n');
      var user = '【使用者問題】\n' + run.question + '\n\n【你先前的草稿】\n' + run.draft + '\n\n【審查者指出的問題】\n' + fixList +
        '\n\n【各專家原始意見】\n' + expertsDigest(run) + '\n\n【交叉審閱中的質疑與修正】\n' + disputesDigest(run) + '\n\n【證據清單】\n' + evidenceCatalog(run, 320) +
        '\n\n請修訂草稿：逐項處理上面的每個問題——沒有證據支持的句子要刪除或降級為「推論／專業常識」並標明；引用錯誤要更正或移除；被抹平的分歧要補回；信心等級要與證據相稱。不得新增證據。' +
        '\n維持相同的章節結構，輸出完整的修訂後 Markdown。\n\n' + REPORT_FORMAT;
      try {
        var res = await callLLM(run, '修訂', { model: modelFor(run, 'aggregator'), system: AGG_SYSTEM, text: user, maxOutputTokens: 6000, thinking: 'medium' });
        var nd = String(res.text || '').trim();
        if (nd) run.draft = nd;
      } catch (e) { if (e && e.message === CANCELLED) throw e; run.notes.push('修訂失敗：' + ((e && e.message) || e)); break; }
    }
    run.review = { rounds: rounds, loops: loops, final: rounds[rounds.length - 1] };
    var f = run.review.final;
    setPhase(run, 'review', '⑤ 獨立審查', f.verdict === 'pass' ? 'done' : 'failed',
      f.verdict === 'pass' ? '通過' + (f.score != null ? '（' + f.score + '/10）' : '') : f.verdict === 'error' ? '審查失敗' : '仍有 ' + f.issues.length + ' 項未解決');
  }

  // ───────────────────────── ⑥ 組裝 ─────────────────────────
  function sanitizeCitations(run, text) {
    var bad = 0;
    var out = text.replace(/\[E(\d+)\]/g, function (m, n) {
      if (evById(run, 'E' + n)) return m;
      bad++; return '[E?]';
    });
    return { text: out, bad: bad };
  }
  function basisLabel(b) { return { evidence: '知識庫證據', knowledge: '專業常識', inference: '推論', web: '網路搜尋' }[b] || b; }

  function assemble(run, opts) {
    opts = opts || {};
    var done = run.experts.filter(function (x) { return x.status === 'done'; });
    var body = run.draft || '';
    var san = sanitizeCitations(run, body);
    body = san.text;
    var lines = [];
    lines.push('# 🧑‍🔬 多專家協作報告');
    lines.push('');
    lines.push('> **問題**：' + clip(run.question, 300));
    var rv = run.review && run.review.final;
    var rvText = !run.settings.reviewer ? '未啟用審查' : !rv ? '未完成審查' : rv.verdict === 'pass' ? ('審查通過' + (run.review.loops ? '（經 ' + run.review.loops + ' 輪修訂）' : '') + (rv.score != null ? '，評分 ' + rv.score + '/10' : '')) : rv.verdict === 'error' ? '審查失敗' : ('⚠️ 審查後仍有 ' + rv.issues.length + ' 項未解決問題（見下方審查紀錄）');
    lines.push('> **參與專家**：' + done.map(function (x) { return x.def.icon + x.def.name; }).join('、') + '｜**證據** ' + run.evidence.length + ' 則｜**交叉審閱** ' + (run.settings.crossReview && done.length > 1 ? run.settings.crossReview + ' 輪' : '無') + '｜' + rvText);
    if (opts.aborted) lines.push('> ⏹️ **本次已被使用者中止，以下為中止當下已完成的部分，不是完整結論。**');
    if (!run.evidence.length) lines.push('> ⚠️ 本次知識庫沒有檢索到相關資料，下列內容主要來自模型的專業常識，請當作待驗證的假說。');
    lines.push('');
    lines.push(body || '（沒有產生結論）');
    lines.push('');
    lines.push('---');
    lines.push('## 審查紀錄');
    if (rv && rv.verdict !== 'error') {
      lines.push('- 審查者判定：**' + (rv.verdict === 'pass' ? '通過' : '未通過') + '**' + (rv.score != null ? '，評分 ' + rv.score + '/10' : '') + (rv.summary ? '。' + rv.summary : ''));
      if (run.review.loops) lines.push('- 曾退回聚合者修訂 ' + run.review.loops + ' 輪。第一次審查提出 ' + run.review.rounds[0].issues.length + ' 項問題。');
      if (rv.issues.length) {
        lines.push('- **未解決的問題**（審查者最後一次仍指出）：');
        rv.issues.forEach(function (i) { lines.push('  - [' + i.severity + '｜' + i.type + '] ' + (i.quote ? '「' + i.quote + '」：' : '') + i.problem + (i.fix ? '（建議：' + i.fix + '）' : '')); });
      }
    } else if (!run.settings.reviewer) {
      lines.push('- 本次未啟用獨立審查者。');
    } else {
      lines.push('- 審查沒有完成（見下方「執行備註」）。');
    }
    lines.push('- 自動檢查：專家引用了不存在的證據編號 ' + run.stats.invalidCitations + ' 處（已剔除）；' + run.stats.downgradedClaims + ' 條「宣稱依據證據卻無有效引用」的主張已降級為推論；最終報告中不存在的引用 ' + san.bad + ' 處' + (san.bad ? '（已標成 [E?]）' : '') + '。');
    if (run.notes.length) {
      lines.push('');
      lines.push('**執行備註**');
      run.notes.forEach(function (n) { lines.push('- ' + n); });
    }
    lines.push('');
    lines.push('## 證據清單');
    if (!run.evidence.length) lines.push('（無）');
    run.evidence.forEach(function (e) {
      lines.push('- **[' + e.id + ']** ' + e.docName + (e.docType ? '（' + e.docType + '）' : '') + (typeof e.score === 'number' ? ' · 相似度 ' + (e.score * 100).toFixed(0) + '%' : '') + (e.url ? ' · ' + e.url : '') + '\n  > ' + clip(String(e.text).replace(/\s+/g, ' '), 180));
    });
    lines.push('');
    lines.push('## 附錄：各專家原始意見');
    run.experts.forEach(function (x) {
      lines.push('');
      lines.push('### ' + x.def.icon + ' ' + x.def.name + (x.status === 'failed' ? '（失敗）' : ''));
      if (x.status === 'failed') { lines.push('發表意見失敗：' + x.error); return; }
      lines.push('**分派任務**：' + x.task);
      lines.push('');
      lines.push('**核心看法**：' + (x.result.viewpoint || '（無）') + (x.firstViewpoint ? '\n\n（交叉審閱後已修正；原看法：' + x.firstViewpoint + '）' : ''));
      if (x.result.claims.length) {
        lines.push('');
        x.result.claims.forEach(function (c) {
          lines.push('- ' + c.text + '〔' + basisLabel(c.basis) + (c.evidence_ids.length ? ' ' + c.evidence_ids.map(function (d) { return '[' + d + ']'; }).join('') : '') + '；信心 ' + c.confidence.toFixed(2) + (c.flag ? '；' + c.flag : '') + '〕');
        });
      }
      if (x.result.concerns.length) lines.push('\n**疑慮**：' + x.result.concerns.join('；'));
      if (x.result.missing_info.length) lines.push('\n**缺少的資料**：' + x.result.missing_info.join('；'));
      if (x.result.recommendation) lines.push('\n**建議**：' + x.result.recommendation);
      if (x.cross && x.cross.disputes.length) {
        lines.push('\n**對其他專家的質疑**：');
        x.cross.disputes.forEach(function (d) { lines.push('- ' + d.ref + '（' + d.severity + '）：' + d.reason); });
      }
    });
    lines.push('');
    lines.push('---');
    var models = Object.keys(run.stats.byModel).map(function (m) { return m + ' ×' + run.stats.byModel[m]; }).join('、');
    lines.push('*耗時 ' + fmtDuration(run.now() - run.t0) + '｜模型呼叫 ' + run.stats.calls + ' 次（' + models + '）｜重試 ' + run.stats.retries + ' 次*');
    return lines.join('\n');
  }

  // ───────────────────────── 對外入口 ─────────────────────────
  // args: { question, history?, experts:[def...], settings, deps }
  // deps: callModel({model,system,text,json,search,thinking,maxOutputTokens,tag}) → Promise<{text, sources?}>
  //       kbRetrieve(query, {docTypes,folderIds,docIds,topK}) → Promise<{items:[{docName,docType,text,score}]}>
  //       resolveModel(name)、defaultModel、onProgress(text, snap)、isCancelled()、now()、sleep()
  async function run(args) {
    var R = createRun(args);
    if (!R.question) throw new Error('請先輸入要協作的問題');
    if (!R.deps.callModel) throw new Error('缺少 deps.callModel');
    var pool = (args.experts || []).map(normalizeExpert).filter(function (e) { return e.enabled; });
    if (!pool.length) throw new Error('沒有啟用中的專家，請先到「管理專家」啟用至少一位');

    R.phases = [
      { key: 'plan', label: '① 調度：挑選專家並分派任務', status: 'pending' },
      { key: 'experts', label: '② 專家並行發表看法', status: 'pending' },
      { key: 'cross', label: '③ 交叉審閱', status: 'pending' },
      { key: 'agg', label: '④ 聚合：整理共識與分歧', status: 'pending' },
      { key: 'review', label: '⑤ 獨立審查', status: 'pending' }
    ];
    var aborted = false;
    try {
      await planStage(R, pool);
      await expertsStage(R);
      await crossStage(R);
      await aggregateStage(R);
      await reviewStage(R);
    } catch (e) {
      if (e && e.message === CANCELLED) {
        aborted = true;
      } else if (R.experts.some(function (x) { return x.status === 'done'; }) && !R.draft) {
        // 聚合前就壞了，但專家意見已經有了：退回「只有專家意見」的報告，不要整個丟掉
        R.notes.push('聚合階段失敗（' + ((e && e.message) || e) + '），以下只附上各專家的原始意見，沒有整合結論。');
        R.draft = '## 結論\n（聚合失敗，沒有整合結論。請直接參考下方各專家的原始意見。）';
      } else if (R.draft) {
        R.notes.push('流程後段失敗（' + ((e && e.message) || e) + '），目前的結論可能未經完整審查。');
      } else {
        throw e;
      }
    }
    if (aborted && !R.experts.some(function (x) { return x.status === 'done'; })) {
      return { markdown: '⏹️ 多專家協作已被中止，沒有任何專家完成意見。', aborted: true, stats: R.stats, evidence: R.evidence, experts: R.experts };
    }
    if (aborted && !R.draft) R.draft = '## 結論\n（協作在聚合之前被中止，沒有整合結論。以下僅列出已完成的專家意見。）';
    var md = assemble(R, { aborted: aborted });
    return { markdown: md, aborted: aborted, stats: R.stats, evidence: R.evidence, experts: R.experts, review: R.review, notes: R.notes };
  }
  API.run = run;
  API._internal = { safeJsonParse: safeJsonParse, validateResult: validateResult, citationIssues: citationIssues, createRun: createRun, addEvidence: addEvidence };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.NovaExperts = API;
})(typeof window !== 'undefined' ? window : this);

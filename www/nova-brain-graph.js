/* ═══════════════════════════════════════════════════════════
   NOVA Brain Graph（手機版 v2.0.0；移植自桌面 v1.3.0，AI 大腦狀態組織圖）
   ------------------------------------------------------------
   版本紀錄：
   手機 v2.1.0 (2026-10-23) - ① 修正「AI 思考」（與檔案卡）圖層取消勾選後選項消失、無法再勾回來：圖層按鈕的顯示條件改看原始資料（有思考／檔案卡就顯示），不再看目前畫得出幾個節點；② 點「對話摘要」節點的詳情新增 ✏️ 編輯（主題、摘要內容、提到的實體）與 🗑 刪除；改完圖譜即時重畫（寫入／刪除由 index 膠水層的 episodicOps 負責）。
   手機 v2.0.0 (2026-10-17) - 整套移植桌面 v1.3.0：中心「你」＋AI 兩顆核心、五層同心殼層（依活躍度）、AI 思考節點、紅黃圈提醒、相似度門檻；介面改手機版（圖層標籤可橫滑、資訊改底部面板）。無 WebGL 時退回舊 2D 圖。
   以下為桌面版紀錄：
   v1.3.0 - ① 拖曳核心時整張圖譜跟著移動：兩顆核心綁在一起平移，殼層目標位置與導引圈都以兩核心中點為圓心，放開後停在新位置；
            ② AI 核心改顯示「使用者幫 AI 取的名字」（讀長期記憶，如「你的名字：你的名字是小希…」→「小希」；有多筆互相矛盾時取最新更新的；
            找不到才顯示 NOVA）。
   v1.2.0 - 新增金色「AI 思考」節點（nova-thoughts.js v0.1.0 產生的思考；input.thoughts），放在最外圍殼層，用「AI 思考來源」連線接到所屬記憶實體；
            點節點可看思考內容、叢集、是否已採納。沒有 nova-thoughts.js 或沒有思考時圖譜行為與 v1.1.0 完全相同。
   v1.1.0 - 同心殼層視覺：圖譜中心放「你」與「NOVA（AI）」兩顆核心；其餘節點向外依活躍度分五層殼層
            （近期常用 → 最近 30 天內 → 90 天內 → 更久 → 久未使用），同類型各佔一個扇區；核心與各節點之間有淡淡的輻射線，
            殼層有淡色導引圈。標題列新增「同心殼層」開關（關掉＝回到原本的自由力導向佈局）。為之後的「AI 思考」節點
            （thought 類型，金色）預留最外圍軌道。節點資料與連線種類不變。
   v1.0.0 - 新增（desktop-patch v3.34.0 起由 index.html 引入，需跟 index.html 放在同一個資料夾）。

   【這是什麼】
   把 NOVA 的「知識」整個畫成一張 3D 圖：筆記、向量庫文件、記憶 Wiki 的實體頁、
   （選用）對話摘要、技能、App／網站檔案卡——以及它們之間的關聯。原本只有「筆記↔筆記」的
   圖譜（openNoteGraph，沒有改動、繼續保留）；這張圖把記憶庫、向量庫、技能也接進來。

   【節點】筆記／向量庫文件／記憶實體頁／對話摘要（預設關）／技能／檔案卡
     （從筆記匯入向量庫產生的文件，就是那則筆記本身，不會另外畫一個重複的節點）
   【關聯（邊）】
     link    筆記→筆記的雙向連結（note.links，實線箭頭）
     xref    實體頁內文的 [[其他實體]] 交叉引用（對應記憶 Wiki schema 的寫法）
     source  實體頁的 source_refs → 它是從哪則筆記／文件／對話摘要固化出來的
     mention 對話摘要提到的實體（對話摘要層開啟時才有）
     sim     語意相似：筆記與文件各自取所有片段向量的平均當代表向量，算 cosine，
             每個節點只連最像的前 k 個且達到門檻（預設 0.65、k=3，介面上可調），
             已經有 link 的不重複畫。節點超過 500 個時略過這一類（避免卡住），圖上會提示。
     compose 組裝流程技能→它引用的子技能
     uses    檔案卡↔技能（比對詞出現在技能的目標／說明／步驟網域）
     same    檔案卡↔同名的記憶實體
   【狀態視覺】
     亮度＝最近 30 天被檢索／套用的次數（記憶檢索、知識庫檢索、技能執行／規劃參考、檔案卡套用）。
       活躍度「從這個版本起才開始累計」，剛升級時所有節點亮度一樣，用一陣子才有差別。
     灰暗＝超過 90 天沒更新、而且最近 30 天沒被用到。
     紅圈＝需要處理：實體頁超過 90 天沒更新（對應記憶健檢 ①）、檔案卡可能過時。
     黃圈＝提醒：實體還是舊格式只有一句話（健檢 ③）、半成品技能。
   【活躍度資料】存在 localStorage（nova_brain_hits，每個節點最多留最近 40 筆時間戳），
     不需要動 sidecar；換機器或清除瀏覽資料會歸零。

   對外只露出 window.NovaBrain；資料蒐集與開啟動作由 index.html 的膠水層用 init() 注入
   （buildGraph 是純函式，可用 node 測試）。
   ═══════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  var VERSION = '2.0.0-mobile';
  var DAY = 86400000;
  var LS_HITS = 'nova_brain_hits';
  var SIM_NODE_CAP = 500;

  function LIB() { return root.NovaGraph3D || {}; }
  var D = {
    collect: null,     // async (opts:{episodic:boolean}) => input（見 buildGraph）
    loadLib: null,     // async () => void（載入 three／3d-force-graph／three-spritetext）
    isLight: null,     // () => boolean
    mountEl: null,     // () => Element|null（圖譜要掛在哪；預設 #nova-main-content，找不到就全螢幕）
    escapeHtml: null, showToast: null,
    open: {}           // { note(id), skill(name), card(name) }
  };
  function init(deps) { Object.keys(deps || {}).forEach(function (k) { D[k] = deps[k]; }); }
  function esc(s) {
    s = String(s == null ? '' : s);
    if (D.escapeHtml) return D.escapeHtml(s);
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function toast(m, ms) { if (D.showToast) D.showToast(m, ms); else if (root.console) root.console.log('[NovaBrain] ' + m); }

  // ═══════════════════════════════════════════════════════════
  // 一、活躍度累計
  // ═══════════════════════════════════════════════════════════
  var _hits = null, _flushTimer = null;
  function loadHits() {
    if (_hits) return _hits;
    try { _hits = JSON.parse(root.localStorage.getItem(LS_HITS)) || {}; } catch (e) { _hits = {}; }
    return _hits;
  }
  function flushHits() {
    _flushTimer = null;
    try { root.localStorage.setItem(LS_HITS, JSON.stringify(_hits || {})); } catch (e) { /* 滿了就算了 */ }
  }
  function hit(key) {
    if (!key) return;
    try {
      var h = loadHits(), a = h[key] || (h[key] = []);
      a.push(Date.now());
      if (a.length > 40) a.splice(0, a.length - 40);
      if (!_flushTimer) _flushTimer = setTimeout(flushHits, 2000);
    } catch (e) { /* 不影響主流程 */ }
  }
  function hitMany(keys) { (keys || []).forEach(hit); }
  function count30(key, now) {
    var a = loadHits()[key]; if (!a || !a.length) return 0;
    var cut = (now || Date.now()) - 30 * DAY, n = 0;
    for (var i = 0; i < a.length; i++) if (a[i] >= cut) n++;
    return n;
  }
  function resetHits() { _hits = {}; flushHits(); }
  if (typeof root.addEventListener === 'function') root.addEventListener('pagehide', function () { if (_flushTimer) { clearTimeout(_flushTimer); flushHits(); } });

  // ═══════════════════════════════════════════════════════════
  // 二、向量小工具
  // ═══════════════════════════════════════════════════════════
  function cosine(a, b) {
    if (!a || !b || !a.length || a.length !== b.length) return 0;
    var dot = 0, na = 0, nb = 0;
    for (var i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
  }
  function avgVectors(list) {
    if (!list.length) return null;
    var dim = list[0].length, out = new Array(dim).fill(0), n = 0;
    list.forEach(function (v) { if (v && v.length === dim) { n++; for (var i = 0; i < dim; i++) out[i] += v[i]; } });
    if (!n) return null;
    for (var j = 0; j < dim; j++) out[j] /= n;
    return out;
  }
  function termHits(term, hay, keys) {
    var t = String(term || '').trim().toLowerCase();
    if (t.length < 2) return false;
    if (String(hay || '').toLowerCase().indexOf(t) >= 0) return true;
    for (var i = 0; i < (keys || []).length; i++) {
      var k = String(keys[i] || '').toLowerCase();
      if (!k) continue;
      if (k === t || k.slice(-t.length - 1) === '.' + t || t.slice(-k.length - 1) === '.' + k) return true;
    }
    return false;
  }
  function hostsOf(steps) {
    var set = Object.create(null);
    (steps || []).forEach(function (st) {
      var code = String((st && (st.code || st.command)) || ''), re = /https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi, m;
      while ((m = re.exec(code))) set[m[1].toLowerCase().replace(/^www\./, '')] = 1;
    });
    return Object.keys(set);
  }

  // ═══════════════════════════════════════════════════════════
  // 三、組圖（純函式）
  // ═══════════════════════════════════════════════════════════
  var TYPE_META = {
    note: { label: '筆記', color: '#60a5fa' }, entity: { label: '記憶實體', color: '#fbbf24' },
    doc: { label: '向量庫文件', color: '#2dd4bf' }, skill: { label: '技能', color: '#4ade80' },
    card: { label: '檔案卡', color: '#c084fc' }, episodic: { label: '對話摘要', color: '#94a3b8' },
    thought: { label: 'AI 思考', color: '#facc15' }, core: { label: '核心', color: '#e0f2fe' }
  };
  var CORE_USER = 'core:user', CORE_AI = 'core:ai';
  var OWNER = { note: CORE_USER, doc: CORE_USER, entity: CORE_AI, skill: CORE_AI, card: CORE_AI, episodic: CORE_AI, thought: CORE_AI };
  var SHELL_R = [92, 138, 184, 230, 276, 322];                       // 殼層半徑：0 常用、1 近 30 天、2 近 90 天、3 更久、4 久未使用、5 AI 思考軌道
  var SHELL_NAME = ['近期常用', '30 天內', '90 天內', '更久以前', '久未使用', 'AI 思考軌道'];
  var SECTOR = { note: [1, 0.35, 0], entity: [-1, 0.35, 0], doc: [0.1, 1, 0.5], skill: [0.1, -1, 0.5], card: [0.35, 0.1, 1], episodic: [-0.35, 0.1, -1], thought: [0, 0.2, -1] };
  var KIND_META = {
    link: { label: '筆記連結', color: 'rgba(147,197,253,0.85)', width: 1.4, arrow: true },
    xref: { label: '實體交叉引用', color: 'rgba(251,191,36,0.85)', width: 1.4, arrow: true },
    source: { label: '來源（固化自）', color: 'rgba(251,146,60,0.6)', width: 1.0, arrow: true },
    mention: { label: '對話提到', color: 'rgba(148,163,184,0.45)', width: 0.8, arrow: false },
    sim: { label: '語意相似', color: 'rgba(45,212,191,0.4)', width: 0.8, arrow: false },
    compose: { label: '流程組成', color: 'rgba(74,222,128,0.8)', width: 1.4, arrow: true },
    uses: { label: '卡片×技能', color: 'rgba(192,132,252,0.6)', width: 1.0, arrow: false },
    same: { label: '同名', color: 'rgba(192,132,252,0.6)', width: 1.0, arrow: false },
    core: { label: '與核心的輻射線', color: 'rgba(148,163,184,0.18)', width: 0.3, arrow: false },
    insight: { label: 'AI 思考來源', color: 'rgba(250,204,21,0.55)', width: 1.0, arrow: true }
  };
  var DEFAULT_LAYERS = { note: true, entity: true, doc: true, skill: true, card: true, episodic: false, thought: true };

  // input: {notes, docs, chunks, core, episodic, skills, cards, cardState, now}
  // opts:  {layers, simThreshold, simTopK, staleDays, hitsFn}
  // 從長期記憶找出使用者幫 AI 取的名字（找不到回 ''）
  var AI_ENT = /(你的名字|你的名稱|你的暱稱|AI.{0,8}(名字|名稱|暱稱|稱呼)|助理.{0,6}(名字|名稱|暱稱|稱呼)|[祕秘]書.{0,6}(名字|名稱|暱稱|稱呼)|替你取名|幫你取名|給你取名)/i;
  var NAME_RE = [/(?:名字|名稱|暱稱|稱呼)\s*(?:是|為|叫|叫做|改為|改成|:|：)\s*[「『"“']?([^\s,，。；;、」』"”'（(]{1,12})/, /(?:叫做|叫|取名為|命名為)\s*[「『"“']?([^\s,，。；;、」』"”'（(]{1,12})/];
  var NAME_BAD = /^(ai|a\.i\.|助理|助手|秘書|祕書|使用者|用戶|我|你|他|她|它|機器人|模型|系統|不|沒有|未|無)$/i;
  function findAiName(core) {
    var best = null;
    (core || []).forEach(function (c) {
      var ent = String(c.entity || ''); if (!AI_ENT.test(ent)) return;
      var fact = String(c.fact || ''), nm = null;
      for (var i = 0; i < NAME_RE.length && !nm; i++) { var m = NAME_RE[i].exec(fact); if (m && !NAME_BAD.test(m[1])) nm = m[1]; }
      if (!nm) return;
      var ts = Number(c.last_updated) || 0, exact = /^你的(名字|名稱|暱稱)$/.test(ent.trim()) ? 1 : 0;
      if (!best || ts > best.ts || (ts === best.ts && exact > best.exact)) best = { name: nm, ts: ts, exact: exact };
    });
    return best ? best.name : '';
  }

  function buildGraph(input, opts) {
    input = input || {}; opts = opts || {};
    var layers = Object.assign({}, DEFAULT_LAYERS, opts.layers || {});
    var simThreshold = typeof opts.simThreshold === 'number' ? opts.simThreshold : 0.65;
    var simTopK = opts.simTopK || 3, staleMs = (opts.staleDays || 90) * DAY, now = input.now || Date.now();
    var hitsFn = opts.hitsFn || function (k) { return count30(k, now); };
    var nodes = [], byKey = Object.create(null), links = [], linkSet = Object.create(null);
    var stats = { nodes: {}, links: {}, issues: [], simSkipped: false, hasHits: false };

    function addNode(n) { if (byKey[n.key]) return byKey[n.key]; n.id = n.key; nodes.push(n); byKey[n.key] = n; stats.nodes[n.type] = (stats.nodes[n.type] || 0) + 1; return n; }
    function addLink(a, b, kind, w) {
      if (!a || !b || a === b || !byKey[a] || !byKey[b]) return false;
      var pairKey = (kind === 'link' || kind === 'xref' || kind === 'source' || kind === 'compose') ? a + '>' + b + '|' + kind : (a < b ? a + '|' + b : b + '|' + a) + '|' + kind;
      if (linkSet[pairKey]) return false;
      linkSet[pairKey] = 1;
      links.push({ source: a, target: b, kind: kind, w: w || 1 });
      stats.links[kind] = (stats.links[kind] || 0) + 1;
      return true;
    }

    var noteIds = Object.create(null);
    if (layers.note) (input.notes || []).forEach(function (n) {
      var k = 'note:' + n.id; noteIds[String(n.id)] = k;
      addNode({ key: k, type: 'note', name: n.title || '(未命名)', ts: Number(n._syncTs || n.id) || 0, group: n.folder || '未分類', tags: n.tags || [], ref: n.id, hits: 0 });
    });

    var docKeyById = Object.create(null);
    (input.docs || []).forEach(function (d) {
      if (d.sourceType === 'note' || String(d.id).indexOf('note_') === 0) {
        // 筆記匯入向量庫產生的文件＝那則筆記本身
        var nk = noteIds[String(d.sourceNoteId != null ? d.sourceNoteId : String(d.id).slice(5))];
        if (nk) { docKeyById[d.id] = nk; byKey[nk].indexed = true; }
        return;
      }
      if (!layers.doc) return;
      var k = 'doc:' + d.id; docKeyById[d.id] = k;
      addNode({ key: k, type: 'doc', name: d.name || d.id, ts: Number(d.addedAt) || 0, group: d.folderId || '', ref: d.id, hits: 0 });
    });

    var entKey = Object.create(null);
    if (layers.entity) (input.core || []).forEach(function (c) {
      var k = 'ent:' + c.entity; entKey[c.entity] = k;
      addNode({ key: k, type: 'entity', name: c.entity, ts: Number(c.last_updated) || 0, group: '', page: c.page_md || '', fact: c.fact || '', ref: c.entity, hits: 0, legacy: !c.page_md });
    });

    var epiKey = Object.create(null);
    if (layers.episodic) (input.episodic || []).forEach(function (e) {
      var k = 'epi:' + e.id; epiKey[e.id] = k;
      addNode({ key: k, type: 'episodic', name: e.topic || '(對話摘要)', ts: Number(e.createdAt) || 0, group: '', summary: e.summary || '', entities: (e.entities || []).slice(), ref: e.id, hits: 0 });
    });

    var skillKey = Object.create(null);
    if (layers.skill) (input.skills || []).forEach(function (s) {
      if (s.type === 'script') return;
      var k = 'skill:' + s.name; skillKey[s.name] = k;
      addNode({ key: k, type: 'skill', name: s.description ? String(s.description).replace(/^【半成品】\s*/, '').slice(0, 30) : s.name, ts: Number(s.createdAt) || 0, group: s.type, partial: !!s.partial, ref: s.name, skillName: s.name, desc: s.description || '', hits: 0 });
    });

    var cardKey = Object.create(null), cardById = Object.create(null);
    if (layers.card) (input.cards || []).forEach(function (c) {
      var k = 'card:' + c.name; cardKey[c.name] = k; cardById[c.name] = c;
      var st = (input.cardState || {})[c.name] || {};
      addNode({ key: k, type: 'card', name: c.title || c.name, ts: Number(st.lastUsed) || (c.verified ? Date.parse(c.verified) : 0) || 0, group: c.kind, suspect: !!st.suspect, ref: c.name, body: c.body || '', hits: 0 });
    });

    if (layers.thought) (input.thoughts || []).forEach(function (t) {
      addNode({ key: 'thought:' + t.id, type: 'thought', name: t.title || '(AI 思考)', ts: Number(t.createdAt) || 0, group: t.cluster || '', body: t.text || '', adopted: t.status === 'adopted', thoughtKind: t.kind, ref: t.id, hits: 0 });
    });

    // ── 邊 ──
    if (layers.note) (input.notes || []).forEach(function (n) {
      (Array.isArray(n.links) ? n.links : []).forEach(function (l) { addLink('note:' + n.id, noteIds[String(l.id)], 'link'); });
    });
    (input.core || []).forEach(function (c) {
      var from = entKey[c.entity]; if (!from) return;
      var re = /\[\[([^\]\n]{1,60})\]\]/g, m;
      while ((m = re.exec(c.page_md || ''))) { var t = m[1].trim(); if (t !== c.entity) addLink(from, entKey[t], 'xref'); }
      (Array.isArray(c.source_refs) ? c.source_refs : []).forEach(function (ref) {
        var to = docKeyById[ref] || noteIds[String(ref).replace(/^note_/, '')] || epiKey[ref];
        addLink(from, to, 'source');
      });
    });
    (input.episodic || []).forEach(function (e) {
      (e.entities || []).forEach(function (en) { addLink(epiKey[e.id], entKey[en], 'mention'); });
    });
    (input.thoughts || []).forEach(function (t) {
      var tk = 'thought:' + t.id, ek = entKey[t.cluster] || entKey[Object.keys(entKey).filter(function (x) { return String(x).trim().toLowerCase() === String(t.cluster || '').trim().toLowerCase(); })[0]];
      addLink(tk, ek, 'insight');
    });
    (input.skills || []).forEach(function (s) {
      if (s.type !== 'flow') return;
      (s.steps || []).forEach(function (it) { if (it && it.blockKind === 'skill') addLink(skillKey[s.name], skillKey[it.skillName], 'compose'); });
    });
    (input.cards || []).forEach(function (c) {
      var ck = cardKey[c.name]; if (!ck) return;
      (input.skills || []).forEach(function (s) {
        var sk = skillKey[s.name]; if (!sk) return;
        var hay = [s.description, s.goal, s.name].join(' '), hosts = hostsOf(s.steps);
        if ((c.match || []).some(function (t) { return termHits(t, hay, hosts); })) addLink(ck, sk, 'uses');
      });
      var names = [c.title].concat(c.match || []).map(function (x) { return String(x || '').trim().toLowerCase(); });
      Object.keys(entKey).forEach(function (en) { if (names.indexOf(en.trim().toLowerCase()) >= 0) addLink(ck, entKey[en], 'same'); });
    });

    // ── 語意相似（筆記＋文件）──
    var vecByDoc = Object.create(null);
    (input.chunks || []).forEach(function (c) { if (c && c.docId && Array.isArray(c.vector) && c.vector.length) (vecByDoc[c.docId] || (vecByDoc[c.docId] = [])).push(c.vector); });
    var simNodes = [];
    Object.keys(vecByDoc).forEach(function (docId) {
      var nk = docKeyById[docId]; if (!nk || !byKey[nk]) return;
      var v = avgVectors(vecByDoc[docId]); if (v) simNodes.push({ key: nk, v: v });
    });
    if (simNodes.length > SIM_NODE_CAP) { stats.simSkipped = true; }
    else {
      var top = simNodes.map(function () { return []; });
      for (var i = 0; i < simNodes.length; i++) {
        for (var j = i + 1; j < simNodes.length; j++) {
          var sim = cosine(simNodes[i].v, simNodes[j].v);
          if (sim >= simThreshold) { top[i].push({ j: j, s: sim }); top[j].push({ j: i, s: sim }); }
        }
      }
      top.forEach(function (arr, i) {
        arr.sort(function (a, b) { return b.s - a.s; });
        arr.slice(0, simTopK).forEach(function (x) {
          var a = simNodes[i].key, b = simNodes[x.j].key;
          var already = linkSet[a + '>' + b + '|link'] || linkSet[b + '>' + a + '|link'];
          if (!already) addLink(a, b, 'sim', x.s);
        });
      });
    }

    // ── 狀態 ──
    var degree = Object.create(null);
    links.forEach(function (l) { degree[l.source] = (degree[l.source] || 0) + 1; degree[l.target] = (degree[l.target] || 0) + 1; });
    nodes.forEach(function (n) {
      var hk = n.type === 'note' ? ['note:' + n.ref, 'doc:note_' + n.ref] : [n.key];
      n.hits = hk.reduce(function (a, k) { return a + hitsFn(k); }, 0);
      if (n.hits) stats.hasHits = true;
      n.degree = degree[n.key] || 0;
      n.val = 1 + Math.min(n.degree, 12) + (n.hits ? 1 : 0);
      var staleAge = n.ts && (now - n.ts) > staleMs;
      n.stale = !!staleAge;
      n.issue = null;
      if (n.type === 'entity') {
        if (staleAge) n.issue = { level: 'bad', text: '超過 ' + Math.round((now - n.ts) / DAY) + ' 天沒更新，內容可能已過時' };
        else if (n.legacy) n.issue = { level: 'warn', text: '還是舊格式（只有一句話事實，沒有完整頁面）' };
        else if (n.legacy === false) { /* 正常 */ }
      } else if (n.type === 'card' && n.suspect) n.issue = { level: 'bad', text: '最近套用這張卡時任務失敗，內容可能已過時' };
      else if (n.type === 'skill' && n.partial) n.issue = { level: 'warn', text: '半成品技能（任務沒完成，只供參考，不能直接執行）' };
      if (n.issue) stats.issues.push({ key: n.key, name: n.name, level: n.issue.level, text: n.issue.text });
      // 灰暗：久未更新而且最近沒被用到（卡片沒有更新時間，不判定灰暗）
      n.dim = !!(staleAge && !n.hits && n.type !== 'card');
    });
    stats.issues.sort(function (a, b) { return (a.level === b.level ? 0 : a.level === 'bad' ? -1 : 1); });
    // ── 殼層（由內到外）與核心 ──
    nodes.forEach(function (n) {
      if (n.type === 'thought') { n.band = 5; return; }
      var age = n.ts ? now - n.ts : Infinity;
      n.band = n.hits >= 4 ? 0 : n.hits >= 1 ? 1 : age <= 30 * DAY ? 2 : age <= 90 * DAY ? 3 : n.ts ? 4 : 3;
    });
    if (opts.core !== false) {
      var regular = nodes.slice();
      addNode({ key: CORE_USER, type: 'core', name: '你', ts: now, group: '', hits: 0, degree: 0, val: 50, band: -1, who: 'user', stale: false, dim: false, issue: null });
      addNode({ key: CORE_AI, type: 'core', name: findAiName(input.core) || 'NOVA', ts: now, group: '', hits: 0, degree: 0, val: 50, band: -1, who: 'ai', stale: false, dim: false, issue: null });
      addLink(CORE_USER, CORE_AI, 'core', 1);
      regular.forEach(function (n) { addLink(OWNER[n.type] || CORE_AI, n.key, 'core', 1); });
      byKey[CORE_USER].degree = byKey[CORE_AI].degree = regular.length;
    }
    return { nodes: nodes, links: links, stats: stats };
  }

  function nodeAlpha(n, hasHits) {
    if (n.type === 'core') return 1;
    if (n.dim) return 0.22;
    if (!hasHits) return 0.85;
    return 0.5 + 0.5 * Math.min(n.hits, 8) / 8;
  }
  var CORE_COLOR = { user: '#38bdf8', ai: '#c084fc' };
  function nodeHex(n) { return n.type === 'core' ? (CORE_COLOR[n.who] || '#e0f2fe') : TYPE_META[n.type].color; }
  function hashStr(str) { var h = 2166136261; for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rgba(hex, a) {
    var h = hex.replace('#', ''), r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a.toFixed(2) + ')';
  }

  // ═══════════════════════════════════════════════════════════
  // 四、介面
  // ═══════════════════════════════════════════════════════════
  var _ui = null;   // 目前開著的圖譜 {el, graph, input, layers, ...}
  function fmtDate(ts) { return ts ? new Date(ts).toLocaleDateString('zh-TW') : '（無記錄）'; }

  function close() {
    if (!_ui) return;
    try { if (_ui.resizeHandler) root.removeEventListener('resize', _ui.resizeHandler); } catch (e) { /* 忽略 */ }
    try { if (_ui.graph && _ui.graph._destructor) _ui.graph._destructor(); } catch (e) { /* 忽略 */ }
    if (_ui.el && _ui.el.parentNode) _ui.el.parentNode.removeChild(_ui.el);
    _ui = null;
  }

  async function open() {
    if (_ui) close();
    if (!D.collect) { toast('大腦圖譜尚未就緒'); return; }
    var mount = null;
    var el = document.createElement('div');
    el.id = 'nbg-root';
    el.style.cssText = 'position:fixed;inset:0;z-index:230;display:flex;flex-direction:column;background:#020617;color:#cbd5e1;font-size:0.8rem;padding-top:env(safe-area-inset-top,0);';
    var BTN = 'padding:5px 10px;border-radius:8px;border:none;background:#1e293b;color:#cbd5e1;font-size:0.78rem;white-space:nowrap;';
    el.innerHTML = '<div id="nbg-head" style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:#0f172a;border-bottom:1px solid #1e293b;">'
      + '<div style="font-weight:700;font-size:0.95rem;color:#fff;flex:1;">🧠 AI 大腦圖譜</div>'
      + '<button id="nbg-refresh" style="' + BTN + '">🔄</button>'
      + '<button id="nbg-close" style="' + BTN + '">✕ 關閉</button></div>'
      + '<div id="nbg-layers" style="display:flex;gap:6px;padding:6px 12px;overflow-x:auto;white-space:nowrap;background:#0f172a;"></div>'
      + '<div id="nbg-ctl" style="display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:4px 12px 8px;background:#0f172a;border-bottom:1px solid #1e293b;">'
      + '<label style="display:flex;align-items:center;gap:6px;color:#94a3b8;">相似度 ≥ <span id="nbg-simv">0.65</span><input id="nbg-sim" type="range" min="0.5" max="0.9" step="0.01" value="0.65" style="width:90px;"></label>'
      + '<label style="display:flex;align-items:center;gap:4px;color:#94a3b8;"><input id="nbg-labels" type="checkbox" checked>標籤</label>'
      + '<label style="display:flex;align-items:center;gap:4px;color:#94a3b8;"><input id="nbg-shell" type="checkbox" checked>同心殼層</label>'
      + '<button id="nbg-issues" style="' + BTN + 'color:#fca5a5;"></button>'
      + '<button id="nbg-legend-btn" style="' + BTN + '">圖例</button></div>'
      + '<div id="nbg-body" style="flex:1;position:relative;overflow:hidden;min-height:0;">'
      + '<div id="nbg-canvas" style="position:absolute;inset:0;"></div>'
      + '<div id="nbg-legend" style="display:none;position:absolute;left:8px;bottom:8px;right:8px;max-height:45%;overflow:auto;background:rgba(15,23,42,0.94);border:1px solid #1e293b;border-radius:10px;padding:8px 10px;font-size:0.72rem;line-height:1.6;"></div>'
      + '<div id="nbg-detail" style="display:none;position:absolute;left:8px;right:8px;bottom:8px;max-height:52%;background:rgba(15,23,42,0.97);border:1px solid #334155;border-radius:12px;padding:10px 12px;overflow:auto;"></div>'
      + '<div id="nbg-issuelist" style="display:none;position:absolute;left:8px;right:8px;top:8px;max-height:60%;background:rgba(15,23,42,0.97);border:1px solid #7f1d1d;border-radius:12px;padding:10px;overflow:auto;"></div>'
      + '<div id="nbg-msg" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#64748b;text-align:center;padding:24px;pointer-events:none;"></div></div>';
    document.body.appendChild(el);
    var $ = function (s) { return el.querySelector(s); };
    var ui = _ui = { el: el, graph: null, input: null, layers: Object.assign({}, DEFAULT_LAYERS), sim: 0.65, labels: true, selected: null, episodicLoaded: false, data: null, shell: true };
    $('#nbg-close').onclick = close;
    $('#nbg-msg').textContent = '載入圖譜資料中…';
    try {
      await (D.loadLib ? D.loadLib() : Promise.resolve());
      ui.input = await D.collect({ episodic: false });
    } catch (e) {
      $('#nbg-msg').textContent = '載入失敗：' + (e.message || e); return;
    }
    if (_ui !== ui) return;   // 載入中途被關掉

    var light = D.isLight ? !!D.isLight() : false;
    var colors = light ? { bg: '#f8fafc', text: '#1e293b', label: 'rgba(248,250,252,0.8)' } : { bg: '#020617', text: '#f1f5f9', label: 'rgba(2,6,23,0.75)' };
    el.style.background = colors.bg;

    function renderLayers() {
      $('#nbg-layers').innerHTML = Object.keys(TYPE_META).filter(function (t) { return t !== 'core' && (t !== 'card' || (ui.data && ui.data.stats.nodes.card) || (ui.input && (ui.input.cards || []).length)) && (t !== 'thought' || (ui.input && (ui.input.thoughts || []).length) || (ui.data && ui.data.stats.nodes.thought)); }).map(function (t) {
        var n = ui.data ? (ui.data.stats.nodes[t] || 0) : 0;
        return '<label style="flex:0 0 auto;display:flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;border:1px solid ' + TYPE_META[t].color + ';cursor:pointer;color:' + TYPE_META[t].color + ';">'
          + '<input type="checkbox" data-layer="' + t + '"' + (ui.layers[t] ? ' checked' : '') + '>' + TYPE_META[t].label + (ui.layers[t] ? ' ' + n : '') + '</label>';
      }).join('');
      el.querySelectorAll('[data-layer]').forEach(function (cb) {
        cb.onchange = async function () {
          var t = cb.getAttribute('data-layer');
          ui.layers[t] = cb.checked;
          if (t === 'episodic' && cb.checked && !ui.episodicLoaded) {
            $('#nbg-msg').textContent = '讀取對話摘要中…';
            try { var more = await D.collect({ episodic: true }); ui.input.episodic = more.episodic || []; ui.episodicLoaded = true; } catch (e) { toast('讀取對話摘要失敗：' + (e.message || e)); }
            $('#nbg-msg').textContent = '';
          }
          rebuild();
        };
      });
    }
    function renderLegend() {
      var s = ui.data.stats;
      $('#nbg-legend').innerHTML = '<div style="color:#e2e8f0;font-weight:700;margin-bottom:2px;">圖例</div>'
        + (ui.shell ? '<div style="margin-bottom:3px;">中心＝<span style="color:#38bdf8;">你</span>＋<span style="color:#c084fc;">' + esc(((ui.data.nodes.find(function (x) { return x.key === CORE_AI; }) || {}).name) || 'NOVA') + '</span>；由內往外：' + SHELL_NAME.slice(0, 5).join(' → ') + '；同色同類型聚在同一扇區</div>' : '')
        + '<div>亮度＝最近 30 天被用到的次數' + (s.hasHits ? '' : '（<span style="color:#fbbf24;">活躍度從這個版本起才開始累計，目前還沒有資料</span>）') + '</div>'
        + '<div>灰暗＝超過 90 天沒更新且最近沒被用到</div>'
        + '<div><span style="color:#f87171;">◯ 紅圈</span>＝需要處理　<span style="color:#fbbf24;">◯ 黃圈</span>＝提醒</div>'
        + '<div style="margin-top:4px;color:#e2e8f0;font-weight:700;">連線</div>'
        + Object.keys(KIND_META).filter(function (k) { return s.links[k]; }).map(function (k) {
          return '<div><span style="display:inline-block;width:18px;height:3px;background:' + KIND_META[k].color + ';vertical-align:middle;margin-right:6px;"></span>' + KIND_META[k].label + ' ' + s.links[k] + '</div>';
        }).join('')
        + (s.simSkipped ? '<div style="color:#fbbf24;margin-top:4px;">筆記＋文件超過 ' + SIM_NODE_CAP + ' 個，已略過語意相似連線</div>' : '');
      var bad = s.issues.filter(function (i) { return i.level === 'bad'; }).length, warn = s.issues.length - bad;
      $('#nbg-issues').textContent = s.issues.length ? ('⚠️ ' + bad + ' 需處理・' + warn + ' 提醒') : '✅ 沒有需要處理的項目';
      $('#nbg-issues').style.color = s.issues.length ? '#fca5a5' : '#86efac';
    }
    function focus(key) {
      var n = ui.data && ui.data.nodes.find(function (x) { return x.key === key; });
      if (!n) return;
      if (ui.graph && n.x != null) {
        var r = 1 + 90 / Math.max(1, Math.hypot(n.x, n.y, n.z));
        ui.graph.cameraPosition({ x: n.x * r, y: n.y * r, z: n.z * r }, n, 800);
      }
      select(n);
    }
    function select(n) {
      ui.selected = n.key;
      var box = $('#nbg-detail'); box.style.display = 'block';
      var neigh = [];
      ui.data.links.forEach(function (l) {
        var s = typeof l.source === 'object' ? l.source.key : l.source, t = typeof l.target === 'object' ? l.target.key : l.target;
        var o = s === n.key ? t : (t === n.key ? s : null);
        if (o) { var on = ui.data.nodes.find(function (x) { return x.key === o; }); if (on) neigh.push({ n: on, kind: l.kind }); }
      });
      var body = '';
      if (n.type === 'entity') body = '<pre style="white-space:pre-wrap;background:#020617;border:1px solid #1e293b;border-radius:8px;padding:8px;max-height:240px;overflow:auto;margin:6px 0;">' + esc((n.page || n.fact || '').slice(0, 2000)) + '</pre>';
      else if (n.type === 'episodic') body = '<div style="margin:6px 0;color:#cbd5e1;white-space:pre-wrap;line-height:1.6;">' + esc(n.summary || '') + '</div>' + ((n.entities && n.entities.length) ? '<div style="color:#94a3b8;">提到：' + esc(n.entities.join('、')) + '</div>' : '')
        + (D.episodicOps ? '<div style="display:flex;gap:8px;margin:8px 0;"><button id="nbg-epi-edit" style="flex:1;padding:8px 12px;border-radius:8px;border:none;cursor:pointer;background:#0ea5e9;color:#fff;font-weight:700;">✏️ 編輯</button><button id="nbg-epi-del" style="flex:1;padding:8px 12px;border-radius:8px;border:none;cursor:pointer;background:#b91c1c;color:#fff;font-weight:700;">🗑 刪除</button></div>' : '');
      else if (n.type === 'thought') body = '<div style="margin:6px 0;padding:8px;border-radius:8px;background:rgba(250,204,21,.12);border:1px solid rgba(250,204,21,.4);color:#fde68a;line-height:1.6;">' + esc(n.body || '') + '</div><div style="color:#94a3b8;">叢集：' + esc(n.group) + (n.adopted ? '　✅ 已採納為正式記憶' : '　（AI 推演，尚未採納）') + '</div>';
      else if (n.type === 'skill') body = '<div style="margin:6px 0;color:#cbd5e1;">' + esc(n.desc) + '</div>';
      else if (n.type === 'card') body = '<pre style="white-space:pre-wrap;background:#020617;border:1px solid #1e293b;border-radius:8px;padding:8px;max-height:200px;overflow:auto;margin:6px 0;">' + esc((n.body || '').slice(0, 1200)) + '</pre>';
      else if (n.type === 'note') body = '<div style="margin:6px 0;color:#94a3b8;">資料夾：' + esc(n.group) + (n.tags && n.tags.length ? '　標籤：' + esc(n.tags.join('、')) : '') + '<br>' + (n.indexed ? '✅ 已匯入向量庫' : '⚪ 尚未匯入向量庫（沒有語意相似連線）') + '</div>';
      var openBtn = (n.type === 'note' && D.open.note) || (n.type === 'skill' && D.open.skill) || (n.type === 'card' && D.open.card);
      box.innerHTML = '<div style="display:flex;gap:6px;align-items:flex-start;"><div style="flex:1;"><div style="color:' + TYPE_META[n.type].color + ';font-size:0.72rem;">' + TYPE_META[n.type].label + (n.partial ? '・半成品' : '') + '</div>'
        + '<div style="color:#f1f5f9;font-weight:700;font-size:0.95rem;word-break:break-all;">' + esc(n.name) + '</div></div>'
        + '<button id="nbg-dclose" style="border:none;background:#1e293b;color:#cbd5e1;border-radius:6px;padding:2px 8px;cursor:pointer;">✕</button></div>'
        + '<div style="color:#94a3b8;margin-top:4px;">最後更新：' + fmtDate(n.ts) + '<br>最近 30 天被用到：' + n.hits + ' 次　連線：' + n.degree + '</div>'
        + (n.issue ? '<div style="margin-top:6px;padding:6px 8px;border-radius:8px;background:' + (n.issue.level === 'bad' ? '#450a0a' : '#422006') + ';color:' + (n.issue.level === 'bad' ? '#fca5a5' : '#fde68a') + ';">' + (n.issue.level === 'bad' ? '🔴 ' : '🟡 ') + esc(n.issue.text) + '</div>' : '')
        + (n.dim ? '<div style="margin-top:6px;color:#64748b;">灰暗：超過 90 天沒更新，最近也沒被用到</div>' : '')
        + body
        + (openBtn ? '<button id="nbg-open" style="margin:4px 0 8px;padding:6px 12px;border-radius:8px;border:none;cursor:pointer;background:#0ea5e9;color:#fff;font-weight:700;">' + (n.type === 'note' ? '開啟筆記' : n.type === 'card' ? '開啟檔案卡管理' : '查看技能') + '</button>' : '')
        + '<div style="color:#e2e8f0;font-weight:700;margin-top:6px;">相連的節點（' + neigh.length + '）</div>'
        + neigh.slice(0, 20).map(function (x, i) { return '<div data-nb="' + esc(x.n.key) + '" style="padding:3px 0;cursor:pointer;color:' + TYPE_META[x.n.type].color + ';">• ' + esc(x.n.name.slice(0, 36)) + ' <span style="color:#64748b;">（' + KIND_META[x.kind].label + '）</span></div>'; }).join('')
        + (neigh.length > 20 ? '<div style="color:#64748b;">…還有 ' + (neigh.length - 20) + ' 個</div>' : '');
      box.querySelector('#nbg-dclose').onclick = function () { box.style.display = 'none'; ui.selected = null; };
      var ob = box.querySelector('#nbg-open');
      if (ob) ob.onclick = function () {
        if (n.type === 'note') { close(); D.open.note(n.ref); }
        else if (n.type === 'card') D.open.card(n.ref);
        else if (n.type === 'skill') D.open.skill(n.ref);
      };
      box.querySelectorAll('[data-nb]').forEach(function (d) { d.onclick = function () { focus(d.getAttribute('data-nb')); }; });
      var eb = box.querySelector('#nbg-epi-edit'); if (eb) eb.onclick = function () { editEpisodic(n); };
      var db = box.querySelector('#nbg-epi-del'); if (db) db.onclick = function () { deleteEpisodic(n); };
    }
    // v2.1.0：對話摘要節點可直接編輯／刪除（點節點 → 詳情 → ✏️ 編輯／🗑 刪除）
    function editEpisodic(n) {
      var box = $('#nbg-detail'), inp = 'width:100%;box-sizing:border-box;padding:8px;border-radius:8px;border:1px solid #334155;background:#020617;color:#f1f5f9;font-size:14px;';
      box.innerHTML = '<div style="color:' + TYPE_META.episodic.color + ';font-size:0.72rem;">編輯對話摘要</div>'
        + '<div style="margin-top:6px;color:#94a3b8;">主題</div><input id="nbg-e-topic" style="' + inp + '" value="' + esc(n.name === '(對話摘要)' ? '' : n.name) + '">'
        + '<div style="margin-top:8px;color:#94a3b8;">摘要內容</div><textarea id="nbg-e-sum" rows="7" style="' + inp + 'line-height:1.5;">' + esc(n.summary || '') + '</textarea>'
        + '<div style="margin-top:8px;color:#94a3b8;">提到的實體（用逗號分隔，會連到同名的記憶實體）</div><input id="nbg-e-ents" style="' + inp + '" value="' + esc((n.entities || []).join('，')) + '">'
        + '<div style="display:flex;gap:8px;margin-top:10px;"><button id="nbg-e-cancel" style="flex:1;padding:8px;border-radius:8px;border:none;background:#334155;color:#e2e8f0;cursor:pointer;">取消</button><button id="nbg-e-save" style="flex:2;padding:8px;border-radius:8px;border:none;background:#0ea5e9;color:#fff;font-weight:700;cursor:pointer;">儲存</button></div>';
      box.querySelector('#nbg-e-cancel').onclick = function () { select(n); };
      box.querySelector('#nbg-e-save').onclick = async function () {
        var topic = box.querySelector('#nbg-e-topic').value.trim(), sum = box.querySelector('#nbg-e-sum').value.trim();
        var ents = box.querySelector('#nbg-e-ents').value.split(/[,，、\n]/).map(function (x) { return x.trim(); }).filter(Boolean).slice(0, 10);
        if (!sum) { toast('摘要內容不能是空的'); return; }
        var b = box.querySelector('#nbg-e-save'); b.disabled = true; b.textContent = '儲存中…';
        try {
          await D.episodicOps.update(n.ref, { topic: topic, summary: sum, entities: ents });
          var it = (ui.input.episodic || []).find(function (x) { return String(x.id) === String(n.ref); });
          if (it) { it.topic = topic; it.summary = sum; it.entities = ents; }
          var key = n.key; rebuild(); toast('✅ 已儲存');
          var nn = ui.data.nodes.find(function (x) { return x.key === key; }); if (nn) select(nn); else $('#nbg-detail').style.display = 'none';
        } catch (e) { toast('❌ 儲存失敗：' + (e.message || e), 4000); b.disabled = false; b.textContent = '儲存'; }
      };
    }
    async function deleteEpisodic(n) {
      var ok = (typeof window.showConfirm === 'function') ? await window.showConfirm('確定刪除這筆對話摘要「' + (n.name || '').slice(0, 30) + '」？無法復原。') : true;
      if (!ok) return;
      try {
        await D.episodicOps.remove(n.ref);
        ui.input.episodic = (ui.input.episodic || []).filter(function (x) { return String(x.id) !== String(n.ref); });
        $('#nbg-detail').style.display = 'none'; ui.selected = null; rebuild(); toast('已刪除');
      } catch (e) { toast('❌ 刪除失敗：' + (e.message || e), 4000); }
    }
    function renderIssueList() {
      var box = $('#nbg-issuelist');
      if (box.style.display === 'block') { box.style.display = 'none'; return; }
      var s = ui.data.stats;
      box.innerHTML = '<div style="color:#fca5a5;font-weight:700;margin-bottom:6px;">需要注意的項目（點一下飛到該節點）</div>'
        + (s.issues.length ? s.issues.map(function (i) {
          return '<div data-ik="' + esc(i.key) + '" style="padding:4px 0;border-top:1px solid #1e293b;cursor:pointer;"><span>' + (i.level === 'bad' ? '🔴' : '🟡') + '</span> <b style="color:#e2e8f0;">' + esc(i.name.slice(0, 30)) + '</b><div style="color:#94a3b8;font-size:0.72rem;">' + esc(i.text) + '</div></div>';
        }).join('') : '<div style="color:#86efac;">沒有需要處理的項目 🎉</div>');
      box.style.display = 'block';
      box.querySelectorAll('[data-ik]').forEach(function (d) { d.onclick = function () { focus(d.getAttribute('data-ik')); }; });
    }

    var ringTex = {};
    function ringSprite(level) {
      if (!LIB().THREE) return null;
      if (!ringTex[level]) {
        var c = document.createElement('canvas'); c.width = c.height = 64;
        var g = c.getContext('2d');
        if (!g) return null;
        g.lineWidth = 6; g.strokeStyle = level === 'bad' ? '#ef4444' : '#f59e0b';
        g.beginPath(); g.arc(32, 32, 27, 0, Math.PI * 2); g.stroke();
        ringTex[level] = new (LIB().THREE.CanvasTexture)(c);
        if (LIB().THREE.SRGBColorSpace) ringTex[level].colorSpace = LIB().THREE.SRGBColorSpace;   // 不設的話顏色會被當成線性色，紅色變粉紅
      }
      // depthTest 關掉＋renderOrder 拉高：圈圈一律畫在球體外面、不被半透明的球體蓋掉顏色
      var sp = new (LIB().THREE.Sprite)(new (LIB().THREE.SpriteMaterial)({ map: ringTex[level], transparent: true, depthWrite: false, depthTest: false }));
      sp.renderOrder = 10;
      return sp;
    }
    var glowTex = {};
    function glowSprite(hex) {
      var T = LIB().THREE; if (!T) return null;
      if (!glowTex[hex]) {
        var c = document.createElement('canvas'); c.width = c.height = 128;
        var g = c.getContext('2d'); if (!g) return null;
        var gr = g.createRadialGradient(64, 64, 4, 64, 64, 62);
        gr.addColorStop(0, rgba(hex, 0.85)); gr.addColorStop(0.35, rgba(hex, 0.28)); gr.addColorStop(1, rgba(hex, 0));
        g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
        glowTex[hex] = new T.CanvasTexture(c);
        if (T.SRGBColorSpace) glowTex[hex].colorSpace = T.SRGBColorSpace;
      }
      var sp = new T.Sprite(new T.SpriteMaterial({ map: glowTex[hex], transparent: true, depthWrite: false, blending: T.AdditiveBlending }));
      sp.renderOrder = 2; return sp;
    }
    function nodeObject(n) {
      var group = null, T = LIB().THREE;
      if (!T) return false;
      group = new T.Group();
      if (n.type === 'core') {
        var gs = glowSprite(nodeHex(n)); if (gs) { gs.scale.set(86, 86, 1); group.add(gs); }
        if (typeof LIB().SpriteText === 'function') {
          var ct = new (LIB().SpriteText)(n.name); ct.textHeight = 8; ct.color = colors.text; ct.fontWeight = '700'; ct.position.set(0, -(Math.cbrt(n.val) * 4 + 7), 0); group.add(ct);
        }
        return group;
      }
      if (n.issue) {
        var sp = ringSprite(n.issue.level);
        // 3d-force-graph 的球體半徑＝cbrt(val)×4；圈圈要比球體大一圈（畫布裡的圓只佔 54/64）
        if (sp) { var sz = Math.cbrt(n.val) * 4 * 2 * 1.45 * (64 / 54); sp.scale.set(sz, sz, 1); group.add(sp); }
      }
      if (ui.labels && typeof LIB().SpriteText === 'function') {
        var t = new (LIB().SpriteText)(n.name.length > 18 ? n.name.slice(0, 17) + '…' : n.name);
        t.textHeight = 3.4; t.color = colors.text; t.backgroundColor = colors.label; t.padding = 1; t.borderRadius = 2;
        t.position.set(0, -(Math.cbrt(n.val) * 4 * (n.issue ? 1.55 : 1) + 3.5), 0);
        group.add(t);
      }
      return group.children.length ? group : false;
    }

    function clearGuides() {
      if (ui.guides) { try { ui.graph.scene().remove(ui.guides); ui.guides.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); } catch (e) { /* 忽略 */ } ui.guides = null; }
    }
    function drawGuides() {
      clearGuides();
      var T = LIB().THREE; if (!T || !ui.graph || !ui.graph.scene) return;
      var grp = new T.Group(), lineHex = light ? 0x475569 : 0x94a3b8;
      var used = {}; ui.data.nodes.forEach(function (n) { if (n.band >= 0) used[n.band] = 1; });
      for (var b = 0; b < SHELL_R.length; b++) {
        if (!used[b]) continue;
        var R = SHELL_R[b], pts = [];
        for (var i = 0; i <= 120; i++) { var a = i / 120 * Math.PI * 2; pts.push(new T.Vector3(Math.cos(a) * R, 0, Math.sin(a) * R)); }
        var ring = new T.LineLoop(new T.BufferGeometry().setFromPoints(pts), new T.LineBasicMaterial({ color: lineHex, transparent: true, opacity: b === 5 ? 0.22 : 0.13, depthWrite: false }));
        grp.add(ring);
        if (typeof LIB().SpriteText === 'function') {
          var lb = new (LIB().SpriteText)(SHELL_NAME[b]); lb.textHeight = 4; lb.color = light ? 'rgba(71,85,105,0.7)' : 'rgba(148,163,184,0.7)'; lb.position.set(R * 0.7071, 0, R * 0.7071); grp.add(lb);
        }
      }
      ui.graph.scene().add(grp); ui.guides = grp;
    }
    function tiltCamera() {
      if (!ui.graph || !ui.shell) return;
      var mr = 0; ui.data.nodes.forEach(function (n) { if (n.band >= 0) mr = Math.max(mr, SHELL_R[n.band]); });
      try { ui.graph.cameraPosition({ x: 0, y: mr * 0.9, z: mr * 1.55 }, { x: 0, y: 0, z: 0 }, 900); } catch (e) { /* 忽略 */ }
    }
    function reheat(g) { setTimeout(function () { if (_ui === ui && ui.graph === g) { try { g.d3ReheatSimulation(); } catch (e) { /* 忽略 */ } } }, 120); }   // graphData 要等下一個畫面才會建好 layout，太早重啟會讓函式庫讀到 undefined
    // 殼層圓心＝兩顆核心的中點（拖曳核心時整張圖跟著走）
    function shellCenter() {
      var sx = 0, sy = 0, sz = 0, n = 0;
      (ui.data ? ui.data.nodes : []).forEach(function (x) { if (x.type === 'core') { sx += (x.fx != null ? x.fx : (x.x || 0)); sy += (x.fy != null ? x.fy : (x.y || 0)); sz += (x.fz != null ? x.fz : (x.z || 0)); n++; } });
      return n ? { x: sx / n, y: sy / n, z: sz / n } : { x: 0, y: 0, z: 0 };
    }
    function onCoreDrag(node, t) {
      if (!ui.shell || node.type !== 'core' || !t) return;
      ui.data.nodes.forEach(function (o) {      // 另一顆核心一起平移，兩核心維持相對位置
        if (o.type !== 'core' || o === node) return;
        ['x', 'y', 'z'].forEach(function (c) { if (o['f' + c] != null) o['f' + c] += t[c]; o[c] = (o[c] || 0) + t[c]; });
      });
    }
    function moveGuides() { if (ui.guides) { var c = shellCenter(); ui.guides.position.set(c.x, c.y, c.z); } }
    function applyShell() {
      var g = ui.graph; if (!g) return;
      if (!ui.shell) {
        g.d3Force('nbgShell', null);
        if (ui._center) g.d3Force('center', ui._center);   // 還原原本的置中力
        ui.data.nodes.forEach(function (n) { if (n.type === 'core') { n.fx = n.fy = n.fz = undefined; } n._sx = null; });
        var lk0 = g.d3Force('link'); if (lk0 && lk0.strength) lk0.strength(function (l) { return l.kind === 'core' ? 0 : 1; });
        var ch0 = g.d3Force('charge'); if (ch0 && ch0.strength) ch0.strength(-30);
        clearGuides(); reheat(g); return;
      }
      ui.data.nodes.forEach(function (n) {
        if (n.type === 'core') { n.fx = n.who === 'user' ? -14 : 14; n.fy = 0; n.fz = 0; return; }
        var d = SECTOR[n.type] || [0, 1, 0], h = hashStr(n.key);
        var v = [d[0] + ((h & 255) / 255 - 0.5) * 1.1, d[1] + (((h >>> 8) & 255) / 255 - 0.5) * 1.1, d[2] + (((h >>> 16) & 255) / 255 - 0.5) * 1.1];
        var L = Math.hypot(v[0], v[1], v[2]) || 1, r = SHELL_R[Math.max(0, Math.min(5, n.band))] * (0.93 + (h >>> 24) / 255 * 0.14);
        n._sx = v[0] / L * r; n._sy = v[1] / L * r; n._sz = v[2] / L * r;
        if (n.x == null) { n.x = n._sx; n.y = n._sy; n.z = n._sz; }
      });
      var cf = g.d3Force('center'); if (cf) { ui._center = cf; g.d3Force('center', null); }   // d3 的置中力會把整張圖拉回原點，拖曳核心時圖譜就不會跟著動
      var all = ui.data.nodes;
      var force = function (alpha) {
        var k = 0.32 * alpha, c = shellCenter();
        for (var i = 0; i < all.length; i++) { var n = all[i]; if (n._sx == null || n.type === 'core') continue; n.vx += (c.x + n._sx - n.x) * k; n.vy += (c.y + n._sy - n.y) * k; n.vz += (c.z + n._sz - n.z) * k; }
      };
      force.initialize = function (ns) { all = ns; };
      g.d3Force('nbgShell', force);
      var lk = g.d3Force('link'); if (lk && lk.strength) lk.strength(function (l) { return l.kind === 'core' ? 0 : 0.04; });
      var ch = g.d3Force('charge'); if (ch && ch.strength) ch.strength(-14);
      drawGuides(); reheat(g); if (!ui.tilted) { ui.tilted = true; setTimeout(function () { if (_ui === ui) tiltCamera(); }, 700); }
    }
    function rebuild() {
      ui.data = buildGraph(ui.input, { layers: ui.layers, simThreshold: ui.sim });
      renderLayers(); renderLegend();
      var has = ui.data.nodes.length > 0;
      $('#nbg-msg').textContent = has ? '' : '圖上還沒有任何節點——先建立筆記、匯入向量庫，或讓記憶累積一些長期事實。';
      if (!ui.graph) {
        if (typeof LIB().ForceGraph3D !== 'function') { $('#nbg-msg').textContent = '圖譜函式庫沒有載入成功'; return; }
        var cv = $('#nbg-canvas');
        ui.graph = LIB().ForceGraph3D()(cv)
          .backgroundColor(colors.bg)
          .nodeLabel(function (n) { return TYPE_META[n.type].label + '：' + n.name + (n.hits ? '（30 天內 ' + n.hits + ' 次）' : ''); })
          .nodeVal('val')
          .nodeColor(function (n) { return rgba(nodeHex(n), nodeAlpha(n, ui.data.stats.hasHits)); })
          .nodeOpacity(1)
          .linkColor(function (l) { return KIND_META[l.kind].color; })
          .linkWidth(function (l) { return KIND_META[l.kind].width; })
          .linkDirectionalArrowLength(function (l) { return KIND_META[l.kind].arrow ? 3 : 0; })
          .linkDirectionalArrowRelPos(1)
          .nodeThreeObject(nodeObject).nodeThreeObjectExtend(true)
          .cooldownTime(7000)
          .onNodeDrag(onCoreDrag)
          .onEngineTick(moveGuides)
          .onNodeClick(function (n) { focus(n.key); })
          .onBackgroundClick(function () { $('#nbg-detail').style.display = 'none'; });
        var fit = function () { if (ui.graph) ui.graph.width(cv.clientWidth).height(cv.clientHeight); };
        ui.resizeHandler = fit; root.addEventListener('resize', fit); fit();
      }
      ui.graph.graphData({ nodes: ui.data.nodes, links: ui.data.links });
      applyShell();
      if (ui.selected) { var sn = ui.data.nodes.find(function (x) { return x.key === ui.selected; }); if (sn) select(sn); else $('#nbg-detail').style.display = 'none'; }
    }
    $('#nbg-sim').oninput = function (e) {
      $('#nbg-simv').textContent = Number(e.target.value).toFixed(2);
      clearTimeout(ui._simT); ui._simT = setTimeout(function () { ui.sim = Number(e.target.value); rebuild(); }, 150);
    };
    $('#nbg-labels').onchange = function (e) { ui.labels = e.target.checked; if (ui.graph) ui.graph.nodeThreeObject(nodeObject); };
    $('#nbg-shell').onchange = function (e) { ui.shell = e.target.checked; renderLegend(); applyShell(); };
    $('#nbg-issues').onclick = renderIssueList;
    $('#nbg-legend-btn').onclick = function () { var l = $('#nbg-legend'); l.style.display = l.style.display === 'block' ? 'none' : 'block'; };
    $('#nbg-refresh').onclick = async function () {
      $('#nbg-msg').textContent = '重新讀取中…';
      try { ui.input = await D.collect({ episodic: ui.layers.episodic }); ui.episodicLoaded = !!ui.layers.episodic; } catch (e) { toast('讀取失敗：' + (e.message || e)); }
      $('#nbg-msg').textContent = ''; rebuild();
    };
    rebuild();
  }

  root.NovaBrain = {
    version: VERSION, init: init, open: open, close: close,
    hit: hit, hitMany: hitMany, count30: count30, resetHits: resetHits,
    buildGraph: buildGraph, cosine: cosine, avgVectors: avgVectors, nodeAlpha: nodeAlpha, TYPE_META: TYPE_META, KIND_META: KIND_META
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.NovaBrain;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));

/* ── 手機版接線層與舊 2D 備援（v2.0.0）── */
(function () {
  'use strict';
  var W = window, HIT_KEY = 'nova_brain_hits', DAY = 86400000;
  var KIND = {
    note:   { c: '#34d399', t: '筆記' },
    doc:    { c: '#60a5fa', t: '向量庫文件' },
    entity: { c: '#f59e0b', t: '記憶實體' },
    skill:  { c: '#c084fc', t: '技能' }
  };
  var S = null; // 目前狀態

  function hits() { try { return JSON.parse(localStorage.getItem(HIT_KEY) || '{}'); } catch (e) { return {}; } }
  function recordHit(id) {
    try {
      var h = hits(), now = Date.now(), a = (h[id] || []).filter(function (t) { return now - t < 30 * DAY; });
      a.push(now); h[id] = a.slice(-50); localStorage.setItem(HIT_KEY, JSON.stringify(h));
    } catch (e) {}
  }
  W.novaBrainRecordHit = recordHit;
  // 開啟筆記時記一次使用
  (function hook() {
    var o = W.openNoteEdit;
    if (typeof o === 'function' && !o._bgHooked) {
      var w = function (id) { try { recordHit('n:' + id); if (W.NovaBrain) W.NovaBrain.hit('note:' + id); } catch (e) {} return o.apply(this, arguments); };
      w._bgHooked = true; W.openNoteEdit = w;
    }
  })();

  function cos(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    var d = 0, x = 0, y = 0;
    for (var i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
    return x && y ? d / Math.sqrt(x * y) : 0;
  }
  function avg(vs) {
    if (!vs.length) return null;
    var n = vs[0].length, o = new Array(n).fill(0);
    vs.forEach(function (v) { for (var i = 0; i < n; i++) o[i] += v[i]; });
    return o.map(function (x) { return x / vs.length; });
  }

  async function collect() {
    var nodes = [], edges = [], byId = {}, eset = {};
    function addN(n) { if (!byId[n.id]) { byId[n.id] = n; nodes.push(n); } return byId[n.id]; }
    function addE(a, b, kind) {
      if (a === b || !byId[a] || !byId[b]) return;
      var k = a < b ? a + '|' + b : b + '|' + a; if (eset[k]) return; eset[k] = 1;
      edges.push({ a: a, b: b, kind: kind });
    }
    var notes = (W.appState && appState.notes) || [];
    var h = hits(), now = Date.now();
    function heat(id) { var a = (h[id] || []).filter(function (t) { return now - t < 30 * DAY; }); return Math.min(1, a.length / 8); }
    var kbChunks = [], kbDocs = [];
    try { if (typeof novaKbGetAllChunks === 'function') kbChunks = await novaKbGetAllChunks(); } catch (e) {}
    try { if (typeof novaKbGetAllDocs === 'function') kbDocs = await novaKbGetAllDocs(); } catch (e) {}
    var chunksByDoc = {};
    kbChunks.forEach(function (c) { (chunksByDoc[c.docId] = chunksByDoc[c.docId] || []).push(c); });
    var titleToId = {};
    notes.forEach(function (n) {
      var id = 'n:' + n.id;
      addN({ id: id, kind: 'note', label: n.title || '(無標題)', ref: n.id, heat: heat(id), kb: !!chunksByDoc['note_' + n.id] });
      if (n.title) titleToId[String(n.title).toLowerCase()] = id;
    });
    notes.forEach(function (n) {
      (Array.isArray(n.links) ? n.links : []).forEach(function (l) { addE('n:' + n.id, 'n:' + l.id, 'link'); });
      var txt = n.isHtml ? String(n.content || '').replace(/<[^>]+>/g, ' ') : String(n.content || '');
      var re = /\[\[([^\]]+)\]\]/g, m;
      while ((m = re.exec(txt))) { var t = titleToId[m[1].trim().toLowerCase()]; if (t) addE('n:' + n.id, t, 'xref'); }
    });
    kbDocs.forEach(function (d) {
      var did = String(d.id || '');
      if (did.indexOf('note_') === 0) return; // 筆記本身已是節點
      var id = 'd:' + did;
      addN({ id: id, kind: 'doc', label: d.name || d.title || did, ref: did, heat: heat(id) });
    });
    // 記憶實體
    var ents = [];
    try { if (W.NovaMemory && NovaMemory._getAll) ents = await NovaMemory._getAll('core'); } catch (e) {}
    ents.forEach(function (r) {
      if (!r || !r.entity) return;
      var id = 'e:' + r.entity;
      addN({ id: id, kind: 'entity', label: r.entity, ref: r.entity, heat: heat(id), vec: r.vector });
      var refs = r.sourceRefs || r.source_refs || [];
      (Array.isArray(refs) ? refs : []).forEach(function (s) {
        var m = String(s).match(/note[_:]?(\d+)/i); if (m) addE(id, 'n:' + m[1], 'src');
      });
      var en = String(r.entity).toLowerCase();
      if (en.length >= 2) notes.forEach(function (n) {
        if ((n.title || '').toLowerCase().indexOf(en) !== -1) addE(id, 'n:' + n.id, 'src');
      });
    });
    // 技能
    try {
      var sk = (W.NovaSkills && NovaSkills.getManifest && NovaSkills.getManifest()) || [];
      sk.forEach(function (s) { addN({ id: 's:' + s.name, kind: 'skill', label: s.name, ref: s.name, heat: heat('s:' + s.name) }); });
    } catch (e) {}
    // 筆記→向量庫文件（有對應的 note_ 文件則標記 kb；一般文件沒有明確關係，不連）
    // 語意相似
    if (nodes.length <= 500) {
      var vecs = [];
      notes.forEach(function (n) {
        var cs = chunksByDoc['note_' + n.id];
        if (cs && cs.length) { var v = avg(cs.map(function (c) { return c.vector || c.embedding; }).filter(Boolean)); if (v) vecs.push({ id: 'n:' + n.id, v: v }); }
      });
      kbDocs.forEach(function (d) {
        var did = String(d.id || ''); if (did.indexOf('note_') === 0) return;
        var cs = chunksByDoc[did]; if (cs && cs.length) { var v = avg(cs.map(function (c) { return c.vector || c.embedding; }).filter(Boolean)); if (v) vecs.push({ id: 'd:' + did, v: v }); }
      });
      ents.forEach(function (r) { if (r && r.vector && r.vector.length) vecs.push({ id: 'e:' + r.entity, v: r.vector }); });
      // 維度不同者不比較（cos 內已處理）
      vecs.forEach(function (a) {
        var sc = [];
        vecs.forEach(function (b) { if (a !== b) { var s = cos(a.v, b.v); if (s >= 0.65) sc.push({ id: b.id, s: s }); } });
        sc.sort(function (x, y) { return y.s - x.s; }).slice(0, 3).forEach(function (t) { addE(a.id, t.id, 'sem'); });
      });
    }
    var deg = {};
    edges.forEach(function (e) { deg[e.a] = (deg[e.a] || 0) + 1; deg[e.b] = (deg[e.b] || 0) + 1; });
    nodes.forEach(function (n) { n.deg = deg[n.id] || 0; });
    return { nodes: nodes, edges: edges };
  }

  function layout(g, w, h) {
    var N = g.nodes, idx = {};
    N.forEach(function (n, i) { idx[n.id] = i; var a = Math.random() * 6.283, r = 40 + Math.random() * Math.min(w, h) * 0.35; n.x = w / 2 + Math.cos(a) * r; n.y = h / 2 + Math.sin(a) * r; n.vx = 0; n.vy = 0; });
    var E = g.edges.map(function (e) { return [idx[e.a], idx[e.b]]; });
    var it = N.length > 300 ? 120 : 260;
    for (var k = 0; k < it; k++) {
      var cool = 1 - k / it, rep = 2600 * cool + 300;
      for (var i = 0; i < N.length; i++) for (var j = i + 1; j < N.length; j++) {
        var dx = N[i].x - N[j].x, dy = N[i].y - N[j].y, d2 = dx * dx + dy * dy + 0.01;
        if (d2 > 90000) continue;
        var f = rep / d2, d = Math.sqrt(d2);
        dx = dx / d * f; dy = dy / d * f;
        N[i].vx += dx; N[i].vy += dy; N[j].vx -= dx; N[j].vy -= dy;
      }
      E.forEach(function (p) {
        var a = N[p[0]], b = N[p[1]], dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) + 0.01, f = (d - 70) * 0.02;
        a.vx += dx / d * f; a.vy += dy / d * f; b.vx -= dx / d * f; b.vy -= dy / d * f;
      });
      N.forEach(function (n) {
        n.vx += (w / 2 - n.x) * 0.004; n.vy += (h / 2 - n.y) * 0.004;
        n.x += Math.max(-12, Math.min(12, n.vx)); n.y += Math.max(-12, Math.min(12, n.vy)); n.vx *= 0.6; n.vy *= 0.6;
      });
    }
  }

  function draw() {
    if (!S) return;
    var c = S.ctx, W2 = S.cv.width, H2 = S.cv.height, dpr = S.dpr;
    c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, W2, H2);
    c.setTransform(dpr * S.k, 0, 0, dpr * S.k, S.tx * dpr, S.ty * dpr);
    var byId = S.byId;
    c.lineWidth = 1 / S.k;
    S.g.edges.forEach(function (e) {
      var a = byId[e.a], b = byId[e.b];
      c.strokeStyle = e.kind === 'sem' ? 'rgba(148,163,184,0.22)' : e.kind === 'src' ? 'rgba(245,158,11,0.35)' : 'rgba(167,139,250,0.55)';
      if (e.kind === 'sem') c.setLineDash([3 / S.k, 3 / S.k]); else c.setLineDash([]);
      c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
    });
    c.setLineDash([]);
    S.g.nodes.forEach(function (n) {
      var r = 5 + Math.min(8, n.deg * 1.2), col = KIND[n.kind].c;
      c.globalAlpha = 0.35 + 0.65 * n.heat;
      c.fillStyle = col; c.beginPath(); c.arc(n.x, n.y, r, 0, 6.283); c.fill();
      c.globalAlpha = 1;
      if (n.kind === 'note' && !n.kb) { c.strokeStyle = '#facc15'; c.lineWidth = 2 / S.k; c.beginPath(); c.arc(n.x, n.y, r + 3, 0, 6.283); c.stroke(); }
      if (n.deg === 0) { c.strokeStyle = '#f87171'; c.lineWidth = 2 / S.k; c.beginPath(); c.arc(n.x, n.y, r + (n.kind === 'note' && !n.kb ? 6 : 3), 0, 6.283); c.stroke(); }
      if (S.sel === n) { c.strokeStyle = '#fff'; c.lineWidth = 2 / S.k; c.beginPath(); c.arc(n.x, n.y, r + 2, 0, 6.283); c.stroke(); }
      if (S.k > 0.7 || S.sel === n) {
        c.fillStyle = '#e2e8f0'; c.font = (11 / Math.max(S.k, 0.8)) + 'px sans-serif'; c.textAlign = 'center';
        c.fillText(String(n.label).slice(0, 14), n.x, n.y + r + 12 / Math.max(S.k, 0.8));
      }
    });
  }

  function pick(px, py) {
    var x = (px - S.tx) / S.k, y = (py - S.ty) / S.k, best = null, bd = 1e9;
    S.g.nodes.forEach(function (n) { var d = (n.x - x) * (n.x - x) + (n.y - y) * (n.y - y), r = 14 / S.k; if (d < r * r && d < bd) { bd = d; best = n; } });
    return best;
  }

  function info(n) {
    var el = document.getElementById('brain-graph-info'); if (!el) return;
    if (!n) { el.textContent = '點節點查看詳情；雙指縮放、單指拖曳。'; return; }
    var st = [];
    if (n.kind === 'note') st.push(n.kb ? '已匯入向量庫' : '⚠️ 尚未匯入向量庫（AI 檢索不到）');
    if (n.deg === 0) st.push('⚠️ 孤立：沒有任何連線');
    st.push('連線 ' + n.deg + '・近 30 天使用熱度 ' + Math.round(n.heat * 100) + '%');
    el.innerHTML = '<b style="color:' + KIND[n.kind].c + '">' + KIND[n.kind].t + '</b>・' + String(n.label).replace(/[<>&]/g, '') + '<br>' + st.join('・') +
      (n.kind === 'note' ? ' <button id="bg-open" style="margin-left:6px;padding:2px 10px;border-radius:8px;background:#059669;color:#fff;">開啟</button>' : '');
    var b = document.getElementById('bg-open');
    if (b) b.onclick = function () { closeBrainGraph(); if (W.openNoteEdit) W.openNoteEdit(String(n.ref)); };
  }

  function bind(cv) {
    var pts = {}, last = null, moved = 0, startPinch = null;
    function pos(e) { var r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    cv.addEventListener('pointerdown', function (e) {
      cv.setPointerCapture(e.pointerId); pts[e.pointerId] = pos(e); moved = 0;
      var ids = Object.keys(pts);
      if (ids.length === 2) { var a = pts[ids[0]], b = pts[ids[1]]; startPinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: S.k }; }
      last = pos(e);
    });
    cv.addEventListener('pointermove', function (e) {
      if (!pts[e.pointerId]) return;
      var p = pos(e), ids = Object.keys(pts);
      if (ids.length === 2 && startPinch) {
        pts[e.pointerId] = p;
        var a = pts[ids[0]], b = pts[ids[1]], d = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        var nk = Math.max(0.2, Math.min(5, startPinch.k * d / startPinch.d)), r = nk / S.k;
        S.tx = cx - (cx - S.tx) * r; S.ty = cy - (cy - S.ty) * r; S.k = nk; moved = 99; draw(); return;
      }
      moved += Math.abs(p.x - last.x) + Math.abs(p.y - last.y);
      S.tx += p.x - last.x; S.ty += p.y - last.y; last = p; pts[e.pointerId] = p; draw();
    });
    function up(e) {
      var p = pos(e);
      if (Object.keys(pts).length === 1 && moved < 8) { S.sel = pick(p.x, p.y); if (S.onPick) { if (S.sel) S.onPick(S.sel); } else info(S.sel); draw(); }
      delete pts[e.pointerId]; startPinch = null; last = null;
    }
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', function (e) { delete pts[e.pointerId]; startPinch = null; });
    cv.addEventListener('wheel', function (e) {
      e.preventDefault(); var p = pos(e), nk = Math.max(0.2, Math.min(5, S.k * (e.deltaY < 0 ? 1.15 : 0.87))), r = nk / S.k;
      S.tx = p.x - (p.x - S.tx) * r; S.ty = p.y - (p.y - S.ty) * r; S.k = nk; draw();
    }, { passive: false });
  }


  /* v2.0.0：預設用 NovaBrain（桌面版移植：核心＋同心殼層）；無 WebGL／使用者切到 2D／3D 函式庫載入失敗時才退回這裡的舊 2D 圖 */
  function use3D() { try { return localStorage.getItem('nova_brain_3d') !== '0'; } catch (e) { return true; } }
  function webglOk() { try { var c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { return false; } }
  async function ensure3D() {
    if (W.NovaGraph3D && W.NovaGraph3D.THREE) return true;
    if (W.NovaGraph3D && !W.NovaGraph3D.THREE) return !!W.NovaGraph3D; // 其他頁面先載入了舊版：仍可用（無光暈／圈圈）
    await new Promise(function (res, rej) { var sc = document.createElement('script'); sc.src = './vendor/nova-graph3d.js?v=2'; sc.onload = res; sc.onerror = function () { rej(new Error('3D 模組載入失敗')); }; document.head.appendChild(sc); });
    return !!W.NovaGraph3D;
  }
  W.novaBrainToggle3D = function () { try { localStorage.setItem('nova_brain_3d', use3D() ? '0' : '1'); } catch (e) {} W.openBrainGraph(); };

  // 把手機版資料轉成桌面版 buildGraph 的輸入格式
  async function collectForBrain(o) {
    var out = { now: Date.now(), notes: ((W.appState && W.appState.notes) || []).slice(), docs: [], chunks: [], core: [], episodic: [], skills: [], cards: [], cardState: {}, thoughts: [] };
    try { if (typeof W.novaKbGetAllDocs === 'function') out.docs = await W.novaKbGetAllDocs(); } catch (e) {}
    try { if (typeof W.novaKbGetAllChunks === 'function') out.chunks = (await W.novaKbGetAllChunks()).map(function (c) { return { docId: c.docId, vector: c.vector || c.embedding }; }); } catch (e) {}
    try {
      if (W.NovaMemory && W.NovaMemory._getAll) {
        out.core = (await W.NovaMemory._getAll('core')).filter(function (r) { return r && r.entity; }).map(function (r) {
          return { entity: r.entity, fact: r.fact || '', last_updated: r.lastUpdated || r.last_updated || 0, page_md: r.pageMd || r.page_md || '',
            source_refs: (r.sourceRefs || r.source_refs || []).map(function (s) { return String(s).replace(/^note[:_]?/i, 'note_'); }) };
        });
        if (o && o.episodic) out.episodic = (await W.NovaMemory._getAll('episodic')).map(function (e) { return { id: e.id, topic: e.topic, summary: e.summary, entities: e.entities, createdAt: e.createdAt }; });
      }
    } catch (e) {}
    try { out.skills = (W.NovaSkills && W.NovaSkills.getManifest && W.NovaSkills.getManifest()) || []; } catch (e) {}
    try { out.thoughts = W.NovaThoughts ? W.NovaThoughts.list() : []; } catch (e) {}
    return out;
  }
  function initBrain() {
    if (!W.NovaBrain) return;
    W.NovaBrain.init({
      escapeHtml: function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); },
      showToast: function (m, ms) { try { if (typeof W.showToast === 'function') W.showToast(m, ms); } catch (e) {} },
      loadLib: ensure3D,
      isLight: function () { return document.documentElement.classList.contains('theme-light'); },
      collect: collectForBrain,
      episodicOps: {   // v2.1.0：對話摘要編輯／刪除（主記憶；跟「設定→記憶」的刪除一樣會標記雲端同步）
        update: async function (id, f) {
          var M = W.NovaMemory; if (!M || !M._getOne) throw new Error('記憶模組尚未就緒');
          var r = await M._getOne('episodic', id); if (!r) throw new Error('找不到這筆摘要（可能已被刪除）');
          var changedText = r.summary !== f.summary || (r.topic || '') !== f.topic;
          r.topic = f.topic; r.summary = f.summary; r.entities = f.entities;
          if (changedText && typeof W.novaKbEmbedDocumentBatch === 'function' && W.appState && appState.keys && appState.keys.gemini) {   // 內容變了 → 重新算向量，檢索才準；失敗就保留舊向量
            try { var v = await W.novaKbEmbedDocumentBatch(['task: search result | title: ' + (f.topic || '對話摘要') + ' | text: ' + f.summary]); if (v && v[0]) r.vector = v[0]; } catch (e) { console.warn('[腦圖] 摘要重新嵌入失敗，沿用舊向量', e); }
          }
          await M._put('episodic', r);
          try { if (W.NovaMemSync && W.NovaMemSync.touch) W.NovaMemSync.touch(); } catch (e) {}
          try { W.dispatchEvent(new Event('nova-memory-changed')); } catch (e) {}
        },
        remove: async function (id) {
          var M = W.NovaMemory; if (!M || !M._del) throw new Error('記憶模組尚未就緒');
          await M._del('episodic', id);
          try { if (W.NovaMemSync && W.NovaMemSync.markEpisodicDeleted) W.NovaMemSync.markEpisodicDeleted(id); } catch (e) {}
          try { W.dispatchEvent(new Event('nova-memory-changed')); } catch (e) {}
        }
      },
      open: {
        note: function (id) { if (W.openNoteEdit) W.openNoteEdit(String(id)); },
        skill: function (name) {
          var t = ((W.NovaSkills && W.NovaSkills.getManifest && W.NovaSkills.getManifest()) || []).find(function (x) { return x.name === name; });
          if (typeof W.showToast === 'function') W.showToast('技能「' + name + '」：' + ((t && (t.description || t.goal)) || '（沒有說明）'), 6000);
        }
      }
    });
  }
  initBrain();

  W.openBrainGraph = async function () {
    if (use3D() && webglOk() && W.NovaBrain) {
      try { await ensure3D(); await W.NovaBrain.open(); return; } catch (e) { console.warn('[NOVA] 大腦圖譜 3D 失敗，改 2D：', e); try { W.NovaBrain.close(); } catch (e2) {} }
    }
    var m = document.getElementById('brain-graph-modal'), box = document.getElementById('brain-graph-container');
    if (!m || !box) return;
    m.classList.remove('hidden'); m.classList.add('flex');
    box.innerHTML = '<div style="color:#94a3b8;padding:16px;font-size:13px;">載入圖譜中…</div>';
    var g;
    try { g = await collect(); } catch (e) { box.innerHTML = '<div style="color:#f87171;padding:16px;">圖譜資料讀取失敗：' + (e.message || e) + '</div>'; return; }
    if (!g.nodes.length) { box.innerHTML = '<div style="color:#94a3b8;padding:24px;text-align:center;">還沒有任何筆記、向量庫文件、記憶或技能可以畫成圖。</div>'; return; }
    renderInto(box, g);
    var cnt = {}; g.nodes.forEach(function (n) { cnt[n.kind] = (cnt[n.kind] || 0) + 1; });
    var lg = document.getElementById('brain-graph-legend');
    if (lg) lg.innerHTML = Object.keys(KIND).map(function (k) { return '<span style="display:inline-flex;align-items:center;gap:4px;"><i style="width:9px;height:9px;border-radius:50%;background:' + KIND[k].c + ';display:inline-block"></i>' + KIND[k].t + ' ' + (cnt[k] || 0) + '</span>'; }).join('') +
      '<span style="color:#facc15">◯ 筆記未匯入向量庫</span><span style="color:#f87171">◯ 孤立</span><span style="color:#94a3b8">虛線＝語意相似（簡易 2D 版）</span>' +
      (webglOk() ? '<button onclick="novaBrainToggle3D()" style="margin-left:auto;padding:2px 10px;border-radius:8px;background:#334155;color:#e2e8f0;">切到 3D（核心＋殼層）</button>' : '<span style="margin-left:auto;color:#64748b;">（此裝置無 3D）</span>');
    info(null); draw();
  };
  function renderInto(box, g, onPick) {
    box.innerHTML = '';
    var cv = document.createElement('canvas'); cv.style.cssText = 'width:100%;height:100%;display:block;touch-action:none;';
    box.appendChild(cv);
    var dpr = Math.min(2, W.devicePixelRatio || 1), w = box.clientWidth || 360, h = box.clientHeight || 520;
    cv.width = w * dpr; cv.height = h * dpr;
    layout(g, w, h);
    var byId = {}; g.nodes.forEach(function (n) { byId[n.id] = n; });
    S = { g: g, byId: byId, cv: cv, ctx: cv.getContext('2d'), dpr: dpr, k: 1, tx: 0, ty: 0, sel: null, onPick: onPick || null };
    bind(cv);
    draw();
  }
  // 筆記圖譜的離線備援：3D 函式庫（需連網載入 CDN）載入失敗時，改畫 2D 版（只含筆記與其連結）
  W.novaRenderNoteGraph2D = async function (box) {
    var g = await collect();
    var ids = {}; g.nodes = g.nodes.filter(function (n) { if (n.kind === 'note') { ids[n.id] = 1; return true; } return false; });
    g.edges = g.edges.filter(function (e) { return ids[e.a] && ids[e.b] && e.kind !== 'src'; });
    var deg = {}; g.edges.forEach(function (e) { deg[e.a] = (deg[e.a] || 0) + 1; deg[e.b] = (deg[e.b] || 0) + 1; }); g.nodes.forEach(function (n) { n.deg = deg[n.id] || 0; });
    if (!g.nodes.length) { box.innerHTML = '<div style="color:#94a3b8;padding:24px;text-align:center;">還沒有筆記。</div>'; return; }
    renderInto(box, g, function (n) { if (n && W.closeNoteGraph) { W.closeNoteGraph(); if (W.openNoteEdit) W.openNoteEdit(String(n.ref)); } });
    box.insertAdjacentHTML('beforeend', '<div style="position:absolute;left:8px;bottom:8px;right:8px;font-size:11px;color:#94a3b8;background:rgba(2,6,23,.7);padding:4px 8px;border-radius:8px;">離線 2D 版（3D 函式庫需連網）。點節點開啟筆記；虛線＝語意相似。</div>');
  };
  (function wrapNoteGraph() {
    var o = W.openNoteGraph;
    if (typeof o !== 'function' || o._bgWrapped) return;
    var w = async function () {
      await o.apply(this, arguments);
      var box = document.getElementById('note-graph-container');
      if (box && /函式庫載入失敗/.test(box.innerText || '')) { try { await W.novaRenderNoteGraph2D(box); } catch (e) {} }
    };
    w._bgWrapped = true; W.openNoteGraph = w;
  })();
  W.closeBrainGraph = function () {
    var m = document.getElementById('brain-graph-modal'); if (m) { m.classList.add('hidden'); m.classList.remove('flex'); }
    S = null; try { if (W.NovaBrain) W.NovaBrain.close(); } catch (e) {}
  };
  W._novaBrainCollect = collect; // 供測試
})();

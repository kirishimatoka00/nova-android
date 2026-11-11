/* ═══════════════════════════════════════════════════════════
   NOVA Memory Core（AI 記憶的共用核心；桌面版與 nova-android 用同一份）
   ------------------------------------------------------------
   目前版本：v1.0.0
   最後更新：2026-11-11

   版本紀錄：
   v1.0.0 - 新檔（桌面 index.html desktop-patch v3.124.0、nova-app-main.js v1.4.0、main.py v0.8.69；nova-android App v2.6.129）。
            把「什麼會被記住」和「怎麼被找回來」的邏輯集中到這一份，桌面（資料在 sidecar SQLite）與手機（IndexedDB）
            各接自己的儲存（store adapter），行為一致、同步格式一致。內容：
            ① 摘要時直接抽「原子事實」（每筆帶類型 kind：identity／preference／procedure／project／decision／todo／fact、
               所屬實體、信心、是否使用者明確要求記住）。偏好／身分／做法類一次就進長期記憶，其餘照頻率（30 天 3 次）。
               使用者糾正 AI 的做法會抽成 procedure（程序性記憶）。
            ② 摘要失敗不再遺失：整段逐字稿存進「待處理佇列」，之後重試（retryPending）。
            ③ 實體別名：新實體先正規化（大小寫、空白、連字號）比對既有實體與別名，同一個東西不會再分散成好幾頁；
               疑似重複（名稱互相包含、只差一個字、向量幾乎相同）由夜間整理請模型確認後合併。
            ④ 混合檢索：向量相似度＋關鍵字（英數詞與中文二字片段；料號、人名、代號靠這個），長期事實也有相關度門檻；
               對話摘要「相關度過門檻」才入選、時間衰減只影響排序、被用到的記憶會延後衰減；釘選的不衰減。
               同專案的記憶加分、別的專案或 Bot 範圍的記憶降分。AI 自己的名字／角色設定永遠帶入。
            ⑤ 承接上文的查詢（「那個後來呢」）自動帶上最近一兩句再檢索；注入時附「多久以前」，
               高度相關的實體改帶 Wiki 頁面的「目前事實」段落，總長有上限。
            ⑥ 「記住／忘記／更正」：remember() 寫成使用者親口確認（釘選、不衰減）；forget() 刪整個實體或只拿掉其中一句。
            ⑦ 每筆長期事實的附加資料放在 x（kind、pinned、scope、aliases、facts 時間軸：何時成立／何時被取代、來源）。
               x 是同步檔裡的選用欄位，舊版 NOVA 看不到也不會出錯（見 nova-memory-sync.js v1.2.0）。
            ⑧ 夜間整理 maintain()：重試佇列 → 補算／重算向量（換嵌入模型時）→ 合併重複實體 → 檢查頁面內互相矛盾 →
               把很久沒用到的舊摘要濃縮成一則（原摘要標成封存、不刪除）。
            ⑨ 健檢 lint()：沒有向量、向量模型不符、疑似重複、最近發現的矛盾、待處理佇列、逾 180 天沒更新也沒用到。
            ⑩ 寫入前做機密偵測（金鑰、密碼、卡號、身分證字號樣式）；「這段對話不要記」名單；Bot 的記憶提案（待確認清單）。
            ⑪ 不綁特定模型：LLM 與嵌入都由呼叫端注入；沒有嵌入模型時只用關鍵字檢索也能運作。
            純邏輯、不碰 DOM；Node 測試在 tools/tests/memory-core.test.cjs。排序公式與 sidecar 的 nova_memory.py 相同
            （兩邊用同一份測試資料 tools/tests/memory-rank-fixture.json 對過）。

   對外：NovaMemoryCore.create(deps) → engine；另有純函式 normEntity／tokens／keywordScore／cosine／rankCore／rankEpisodic／
   detectSecret／parseJson／ageText／dupCandidates／mergeX（同步模組用）。
   ═══════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  root.NovaMemoryCore = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';
  var VERSION = '1.0.0';
  var DAY = 86400000;
  var KINDS = ['identity', 'preference', 'procedure', 'project', 'decision', 'todo', 'fact'];
  var KIND_ZH = { identity: '身分', preference: '偏好', procedure: '做法', project: '專案', decision: '決定', todo: '待辦', fact: '事實' };
  var DEFAULTS = {
    compressEvery: 10, promoteThreshold: 3, entityWindowDays: 30,
    topK: 5, coreTopK: 5, coreThreshold: 0.5, epiThreshold: 0.5,
    decayRate: 0.8, decayDays: 30, staleDays: 180,
    budgetChars: 1800, pageExcerptChars: 420, pageExcerptMin: 0.72,
    msgHead: 700, msgTail: 300, transcriptMax: 12000, maxFacts: 6, maxFactsKept: 40,
    digestAfterDays: 120, digestMinGroup: 3
  };
  var PERSONA_RX = /^你的|名字|稱呼|身分|角色|人設|persona/i;

  /* ───────────── 文字工具 ───────────── */
  function str(v) { return v == null ? '' : String(v); }
  function num(v) { v = Number(v); return isFinite(v) ? v : 0; }
  function clip(s, n) { s = str(s); return s.length > n ? s.slice(0, n) : s; }
  function normEntity(s) {
    s = str(s);
    try { s = s.normalize('NFKC'); } catch (e) { /* 舊環境沒有 normalize */ }
    return s.toLowerCase().replace(/[\s　\-_.·・,，、:：;；'"`“”‘’()（）\[\]【】「」『』\/\\|]+/g, '');
  }
  var STOP = { '的是': 1, '什麼': 1, '怎麼': 1, '可以': 1, '一個': 1, '我們': 1, '你們': 1, '這個': 1, '那個': 1, '是不': 1, '不是': 1, '有沒': 1, '沒有': 1, '還是': 1, '如何': 1, '為什': 1, '請問': 1, '一下': 1, '現在': 1, '今天': 1 };
  // 斷詞：英數詞（含料號、版本號這類帶數字的字串）＋中日韓文字的二字片段。回傳 {詞: 權重}
  function tokens(text) {
    var out = {}, s = str(text).toLowerCase();
    try { s = s.normalize('NFKC'); } catch (e) { /* ignore */ }
    var m, rx = /[a-z0-9][a-z0-9._\-]*[a-z0-9]|[a-z0-9]/g;
    while ((m = rx.exec(s))) {
      var w = m[0];
      if (w.length < 2) continue;
      out[w] = (/\d/.test(w) || w.length >= 4) ? 2 : 1;
    }
    var runs = s.match(/[぀-ヿ㐀-鿿豈-﫿]+/g) || [];
    for (var i = 0; i < runs.length; i++) {
      var r = runs[i];
      if (r.length === 1) { if (!out[r]) out[r] = 0.5; continue; }
      for (var j = 0; j < r.length - 1; j++) { var g = r.substr(j, 2); if (!out[g]) out[g] = STOP[g] ? 0.3 : 1; }
    }
    return out;
  }
  // 查詢的詞有多少（加權）比例出現在文件裡。查詢詞多時至少要中 2 個，避免只靠一個常見片段湊數。
  function keywordScore(qTok, docText) {
    var keys = Object.keys(qTok || {});
    if (!keys.length) return 0;
    var d = (docText && typeof docText === 'object') ? docText : tokens(docText);
    var tot = 0, hit = 0, n = 0;
    for (var i = 0; i < keys.length; i++) { var w = qTok[keys[i]]; tot += w; if (d[keys[i]]) { hit += w; n++; } }
    if (!tot) return 0;
    var strong = false, ident = false;
    for (var k = 0; k < keys.length; k++) if (d[keys[k]] && qTok[keys[k]] >= 2) { strong = true; if (/\d/.test(keys[k])) ident = true; }
    if (n < 2 && keys.length >= 4 && !strong) return 0;
    var sc = hit / tot;
    return ident ? Math.max(sc, 0.5) : sc;   // 料號、版本號這類帶數字的識別字整個命中：至少算中等相關
  }
  function cosine(a, b) {
    if (!a || !b || !a.length || a.length !== b.length) return 0;
    var d = 0, na = 0, nb = 0;
    for (var i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return na && nb ? d / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
  }
  function parseJson(raw) {
    var s = str(raw), a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
  }
  function ageText(ts, now) {
    var d = Math.floor((num(now) - num(ts)) / DAY);
    if (!ts || d < 0) return '';
    if (d < 1) return '今天';
    if (d < 2) return '昨天';
    if (d < 14) return d + ' 天前';
    if (d < 60) return Math.round(d / 7) + ' 週前';
    if (d < 365) return Math.round(d / 30) + ' 個月前';
    return (Math.round(d / 36.5) / 10) + ' 年前';
  }
  // 機密偵測：這類內容不寫進記憶（寧可漏記，不要把金鑰或密碼存起來還同步到雲端）
  var SECRET_RX = [
    /\bsk-[A-Za-z0-9_\-]{16,}/, /\bAIza[0-9A-Za-z_\-]{20,}/, /\bxai-[A-Za-z0-9]{16,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/,
    /\bBearer\s+[A-Za-z0-9._\-]{20,}/i, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /(密碼|password|passwd|pwd|api[ _-]?key|金鑰|token|secret)\s*(是|為|[:：=])\s*\S{4,}/i,
    /\b(?:\d[ -]?){15,16}\b/, /\b[A-Z][12]\d{8}\b/
  ];
  function detectSecret(text) { var s = str(text); for (var i = 0; i < SECRET_RX.length; i++) if (SECRET_RX[i].test(s)) return true; return false; }

  /* ───────────── x（附加資料）───────────── */
  function getX(row) { var x = row && row.x; return (x && typeof x === 'object' && !Array.isArray(x)) ? x : {}; }
  function activeFactsText(x) { var f = Array.isArray(x.facts) ? x.facts : []; var o = []; for (var i = 0; i < f.length; i++) if (f[i] && !f[i].until && f[i].t) o.push(f[i].t); return o.join(' '); }
  // 同步合併用：贏家沒有 x（舊版 NOVA 寫的）就沿用輸家的 x；兩邊都有時別名取聯集、釘選取「有釘的」
  function mergeX(winner, loser) {
    var hasW = winner && winner.x && typeof winner.x === 'object', hasL = loser && loser.x && typeof loser.x === 'object';
    if (!hasW) return hasL ? JSON.parse(JSON.stringify(loser.x)) : undefined;
    if (!hasL) return winner.x;
    var x = JSON.parse(JSON.stringify(winner.x)), seen = {}, al = [];
    (Array.isArray(x.aliases) ? x.aliases : []).concat(Array.isArray(loser.x.aliases) ? loser.x.aliases : []).forEach(function (a) { var k = normEntity(a); if (k && !seen[k]) { seen[k] = 1; al.push(str(a)); } });
    if (al.length) x.aliases = al.slice(0, 12);
    if (loser.x.pinned && x.pinned === undefined) x.pinned = true;
    return x;
  }

  /* ───────────── 同步檔（NOVA_Memory_Sync.json）的正規化與合併 ─────────────
     桌面的 nova-memory-sync.js v1.2.0 與手機的 nova-memsync.js v1.2.0 都改用這一份。
     格式維持 version 1，只多了選用欄位：長期事實與對話摘要的 x（附加資料）、對話摘要的 em（向量的嵌入模型）。
     舊版 NOVA 不認得這些欄位：它寫回同步檔時會把它們拿掉，但不會出錯；新版合併時「沒有 x」一律當成「不知道」
     而不是「清空」，沿用另一份的 x，所以資料不會因為中間經過舊版而遺失。 */
  var TOMB_KEEP = 365 * DAY;
  function quantize(v) { if (!Array.isArray(v)) return []; var o = new Array(v.length); for (var i = 0; i < v.length; i++) o[i] = Math.round(v[i] * 1e4) / 1e4; return o; }
  function cleanX(x) { if (!x || typeof x !== 'object' || Array.isArray(x) || !Object.keys(x).length) return undefined; try { return JSON.parse(JSON.stringify(x)); } catch (e) { return undefined; } }   // 空的 x 視同沒有（不然從舊版裝置收到的資料會多寫一次檔）
  function stable(v) {   // 鍵排序後的 JSON，兩台裝置才會算出一樣的字串
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + stable(v[k]); }).join(',') + '}';
    return JSON.stringify(v === undefined ? null : v);
  }
  function syncEmpty() { return { version: 1, episodic: [], core: [], entity_freq: [], tombstones: {}, clearedAt: 0 }; }
  function syncContentKey(c) { return str(c.page_md) + '\u0001' + str(c.fact); }
  function syncNormalize(b) {
    b = b || {};
    var o = syncEmpty();
    (Array.isArray(b.episodic) ? b.episodic : []).forEach(function (e) {
      if (!e || e.id == null) return;
      var it = { id: String(e.id), session_id: e.session_id || '', summary: e.summary || '', topic: e.topic || '', entities: Array.isArray(e.entities) ? e.entities : [], vector: quantize(e.vector), created_at: num(e.created_at), source_range: e.source_range || '', updated_at: num(e.updated_at) };
      var x = cleanX(e.x); if (x !== undefined) it.x = x;
      if (e.em) it.em = str(e.em);
      o.episodic.push(it);
    });
    (Array.isArray(b.core) ? b.core : []).forEach(function (c) {
      if (!c || !c.entity) return;
      var it = { entity: String(c.entity), fact: c.fact || '', hit_count: num(c.hit_count) || 1, last_updated: num(c.last_updated), page_md: c.page_md || '', source_refs: Array.isArray(c.source_refs) ? c.source_refs : [] };
      var x = cleanX(c.x); if (x !== undefined) it.x = x;
      o.core.push(it);
    });
    (Array.isArray(b.entity_freq) ? b.entity_freq : []).forEach(function (f) { if (!f || !f.entity) return; o.entity_freq.push({ entity: String(f.entity), count_30d: num(f.count_30d), last_seen: num(f.last_seen) }); });
    if (b.tombstones && typeof b.tombstones === 'object') Object.keys(b.tombstones).forEach(function (k) { var t = num(b.tombstones[k]); if (t) o.tombstones[k] = t; });
    o.clearedAt = num(b.clearedAt);
    var cmp = function (k) { return function (x, y) { return x[k] < y[k] ? -1 : x[k] > y[k] ? 1 : 0; }; };
    o.episodic.sort(cmp('id')); o.core.sort(cmp('entity')); o.entity_freq.sort(cmp('entity'));
    return o;
  }
  function syncSig(b) { return stable(syncNormalize(b)); }
  function withX(winner, loser) { var x = mergeX(winner, loser); if (x === undefined) return winner; var o = Object.assign({}, winner); o.x = x; return o; }
  // a＝本機，b＝遠端。回傳 {bundle, conflicts:[{entity, side:'local'|'remote', loser, winner}]}
  function syncMerge(a, b, o) {
    o = o || {};
    var now = o.now || Date.now(), lastSync = num(o.lastSync);
    a = syncNormalize(a); b = syncNormalize(b);
    var tomb = {};
    [a.tombstones, b.tombstones].forEach(function (t) { Object.keys(t).forEach(function (k) { if (!tomb[k] || t[k] > tomb[k]) tomb[k] = t[k]; }); });
    Object.keys(tomb).forEach(function (k) { if (now - tomb[k] > TOMB_KEEP) delete tomb[k]; });
    var cleared = Math.min(Math.max(a.clearedAt, b.clearedAt), now);
    // 對話摘要：依 id 聯集；編輯過的較新版本贏；沒有向量的補上有向量的；沒有 x 的沿用有 x 的
    var epMap = {};
    a.episodic.concat(b.episodic).forEach(function (e) {
      var ex = epMap[e.id];
      if (!ex) { epMap[e.id] = e; return; }
      var w = ex, l = e;
      if (e.updated_at !== ex.updated_at) { if (e.updated_at > ex.updated_at) { w = e; l = ex; } }
      else if (ex.x !== undefined && e.x !== undefined && stable(e.x) > stable(ex.x)) { w = e; l = ex; }   // 時間相同、x 不同：兩邊用同一個規則挑
      w = Object.assign({}, w);
      if (w.x === undefined && l.x !== undefined) w.x = l.x;
      if (!w.vector.length && l.vector.length) { w.vector = l.vector; if (l.em) w.em = l.em; else delete w.em; }
      else if (!w.em && l.em) w.em = l.em;   // 贏的那份不知道嵌入模型（經過舊版裝置後會遺失）：沿用另一份的，兩台才會算出一樣的結果
      epMap[e.id] = w;
    });
    var episodic = Object.keys(epMap).map(function (k) { return epMap[k]; }).filter(function (e) {
      var d = tomb['e:' + e.id], ts = Math.max(e.created_at, e.updated_at || 0);
      if (d && d >= ts) return false;
      if (ts <= cleared) return false;
      return true;
    });
    // 長期事實：last_updated 較新的贏
    var conflicts = [], coreMap = {};
    a.core.forEach(function (c) { coreMap[c.entity] = c; });
    b.core.forEach(function (r) {
      var l = coreMap[r.entity];
      if (!l) { coreMap[r.entity] = r; return; }
      var sameContent = l.last_updated === r.last_updated && syncContentKey(l) === syncContentKey(r);
      if (sameContent) {
        if (l.x === undefined && r.x !== undefined) coreMap[r.entity] = withX(l, r);
        else if (l.x !== undefined && r.x !== undefined && stable(l.x) !== stable(r.x)) {
          var lu = num(l.x.xu), ru = num(r.x.xu);
          // 兩邊用同一個規則挑贏家（xu 較新；相同就比字串），輸家的別名併進來——兩台算出來的結果才會一樣
          if (ru > lu || (ru === lu && stable(r.x) > stable(l.x))) coreMap[r.entity] = withX(r, l);
          else coreMap[r.entity] = withX(l, r);
        }
        return;
      }
      var winner, loser, side;
      if (r.last_updated > l.last_updated) { winner = r; loser = l; side = 'local'; }
      else if (r.last_updated < l.last_updated) { winner = l; loser = r; side = 'remote'; }
      else if (syncContentKey(r) > syncContentKey(l)) { winner = r; loser = l; side = 'local'; }
      else { winner = l; loser = r; side = 'remote'; }
      var bothChanged = !lastSync || (l.last_updated > lastSync && r.last_updated > lastSync);
      if (syncContentKey(l) !== syncContentKey(r) && bothChanged) conflicts.push({ entity: r.entity, side: side, loser: loser, winner: winner });
      coreMap[r.entity] = withX(winner, loser);
    });
    var core = Object.keys(coreMap).map(function (k) { return coreMap[k]; }).filter(function (c) {
      var d = tomb['c:' + c.entity];
      if (d && d >= c.last_updated) return false;
      if (c.last_updated <= cleared) return false;
      return true;
    });
    var frMap = {};
    a.entity_freq.concat(b.entity_freq).forEach(function (f) { var ex = frMap[f.entity]; if (!ex || f.last_seen > ex.last_seen || (f.last_seen === ex.last_seen && f.count_30d > ex.count_30d)) frMap[f.entity] = f; });
    var entity_freq = Object.keys(frMap).map(function (k) { return frMap[k]; }).filter(function (f) { return f.last_seen > cleared; });
    return { bundle: syncNormalize({ version: 1, episodic: episodic, core: core, entity_freq: entity_freq, tombstones: tomb, clearedAt: cleared }), conflicts: conflicts };
  }
  var SYNC = { normalize: syncNormalize, mergeBundles: syncMerge, sigOf: syncSig, contentKey: syncContentKey, emptyBundle: syncEmpty, stable: stable };

  /* ───────────── 排序（公式與 sidecar 的 nova_memory.py 相同）───────────── */
  function scopeMult(rowScope, wantScope) {
    rowScope = str(rowScope); wantScope = str(wantScope);
    if (!rowScope) return 1;
    if (!wantScope) return 0.9;                       // 一般對話裡，專案專屬的記憶略降
    return rowScope === wantScope ? 1.15 : 0.5;       // 同專案加分；別的專案明顯降分
  }
  function baseScore(sem, kw) {
    var kwb = Math.min(1, kw * 1.5);
    if (sem === null) return kwb * 0.85;
    return Math.max(sem * 0.8 + kwb * 0.2, kwb * 0.85);
  }
  function semOf(qv, row, qModel) {
    var v = row.vector;
    if (!qv || !qv.length || !v || !v.length || v.length !== qv.length) return null;
    if (qModel && row.emb_model && row.emb_model !== qModel) return null;
    return cosine(qv, v);
  }
  function rankCore(rows, q, cfg) {
    cfg = Object.assign({}, DEFAULTS, cfg || {});
    var now = num(q.now) || Date.now(), qTok = q.tokens || tokens(q.text), qNorm = normEntity(q.text), out = [];
    for (var i = 0; i < (rows || []).length; i++) {
      var r = rows[i], x = getX(r);
      var sem = semOf(q.vector, r, q.model);
      var doc = str(r.entity) + ' ' + (Array.isArray(x.aliases) ? x.aliases.join(' ') : '') + ' ' + str(r.fact) + ' ' + activeFactsText(x);
      var kw = keywordScore(qTok, doc);
      var base = baseScore(sem, kw);
      var names = [r.entity].concat(Array.isArray(x.aliases) ? x.aliases : []);
      for (var n = 0; n < names.length; n++) { var ne = normEntity(names[n]); if (ne.length >= 2 && qNorm.indexOf(ne) >= 0) { base = Math.max(base, 0.8); break; } }
      var used = Math.max(num(r.last_updated), num(r.last_used));
      var mult = scopeMult(x.scope, q.scope);
      if (x.pinned) mult *= 1.1;
      if (x.kind === 'identity' || x.kind === 'preference' || x.kind === 'procedure') mult *= 1.08;
      if (!x.pinned && used && now - used > cfg.staleDays * DAY) mult *= 0.85;
      var score = base * mult + Math.min(0.05, 0.01 * num(r.use_count));
      var persona = PERSONA_RX.test(str(r.entity)) && !x.scope;
      out.push({ row: r, score: Math.round(score * 1e4) / 1e4, base: Math.round(base * 1e4) / 1e4, sem: sem, kw: kw, persona: persona });
    }
    out.sort(function (a, b) { return b.score - a.score || (num(b.row.last_updated) - num(a.row.last_updated)); });
    var picks = out.filter(function (o) { return o.score >= cfg.coreThreshold; }).slice(0, cfg.coreTopK);
    var extra = out.filter(function (o) { return o.persona && picks.indexOf(o) < 0; }).slice(0, 3);   // AI 自己的名字／角色設定永遠帶入
    return picks.concat(extra);
  }
  function rankEpisodic(rows, q, cfg) {
    cfg = Object.assign({}, DEFAULTS, cfg || {});
    var now = num(q.now) || Date.now(), qTok = q.tokens || tokens(q.text), out = [];
    for (var i = 0; i < (rows || []).length; i++) {
      var r = rows[i], x = getX(r);
      var sem = semOf(q.vector, r, q.model);
      var kw = keywordScore(qTok, str(r.topic) + ' ' + str(r.summary) + ' ' + (Array.isArray(r.entities) ? r.entities.join(' ') : ''));
      var base = baseScore(sem, kw) * scopeMult(x.scope, q.scope);
      if (x.arch) base *= 0.5;       // 已被濃縮成更高層摘要的舊摘要：只有特別相關才出現
      if (base < cfg.epiThreshold) continue;
      var ref = Math.max(num(r.created_at), num(r.last_used));
      var days = Math.max(0, (now - ref) / DAY);
      var decay = x.pinned ? 1 : Math.max(0.35, Math.pow(cfg.decayRate, days / cfg.decayDays));
      out.push({ row: r, score: Math.round(base * decay * 1e4) / 1e4, base: Math.round(base * 1e4) / 1e4, sem: sem, kw: kw });
    }
    out.sort(function (a, b) { return b.score - a.score || (num(b.row.created_at) - num(a.row.created_at)); });
    return out.slice(0, cfg.topK);
  }

  /* ───────────── 重複實體偵測 ───────────── */
  function lev1(a, b) {   // 編輯距離是否 ≤ 1
    if (a === b) return true;
    var la = a.length, lb = b.length;
    if (Math.abs(la - lb) > 1) return false;
    var i = 0, j = 0, diff = 0;
    while (i < la && j < lb) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++diff > 1) return false;
      if (la > lb) i++; else if (lb > la) j++; else { i++; j++; }
    }
    return diff + (la - i) + (lb - j) <= 1;
  }
  function dupCandidates(rows, max) {
    var out = [], list = (rows || []).map(function (r) { return { r: r, n: normEntity(r.entity), al: (Array.isArray(getX(r).aliases) ? getX(r).aliases : []).map(normEntity) }; });
    for (var i = 0; i < list.length; i++) for (var j = i + 1; j < list.length; j++) {
      var a = list[i], b = list[j], why = '';
      if (!a.n || !b.n) continue;
      if (str(getX(a.r).scope) !== str(getX(b.r).scope)) continue;
      if (a.n === b.n || a.al.indexOf(b.n) >= 0 || b.al.indexOf(a.n) >= 0) why = '名稱正規化後相同';
      else if (Math.min(a.n.length, b.n.length) >= 3 && (a.n.indexOf(b.n) >= 0 || b.n.indexOf(a.n) >= 0) && Math.min(a.n.length, b.n.length) / Math.max(a.n.length, b.n.length) >= 0.5) why = '名稱互相包含';
      else if (Math.min(a.n.length, b.n.length) >= 5 && lev1(a.n, b.n)) why = '名稱只差一個字';
      else if (a.r.vector && b.r.vector && a.r.vector.length && a.r.vector.length === b.r.vector.length && cosine(a.r.vector, b.r.vector) >= 0.92) why = '內容幾乎相同';
      if (why) { out.push({ a: a.r.entity, b: b.r.entity, why: why }); if (out.length >= (max || 20)) return out; }
    }
    return out;
  }

  /* ───────────── 頁面（Markdown）小工具 ───────────── */
  function currentSection(pageMd) {
    var p = str(pageMd), cut = p.search(/##\s*已取代的舊資料/);
    if (cut >= 0) p = p.slice(0, cut);
    return p.replace(/^\s*##\s*目前事實\s*\n?/, '').trim();
  }
  function supersededSection(pageMd) { var m = str(pageMd).match(/##\s*已取代的舊資料[\s\S]*$/); return m ? m[0].replace(/^##\s*已取代的舊資料\s*\n?/, '').trim() : ''; }
  function buildPage(cur, sup) { return '## 目前事實\n' + (cur ? cur.trim() + '\n' : '') + (sup ? '\n## 已取代的舊資料\n' + sup.trim() + '\n' : ''); }
  function dateStr(ts) { var d = new Date(ts); return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate(); }

  /* ───────────── 提示詞 ───────────── */
  function extractPrompt(transcript, profile, known) {
    var p = '請閱讀下面這段對話，做兩件事：\n'
      + '（一）寫一則精簡摘要，只保留未來可能有用的事實／偏好／決定，不要寒暄、不要已經解決而且不需要再追蹤的細節。\n'
      + '（二）抽出「值得長期記住的原子事實」，一筆只講一件事，最多 6 筆。每筆要有：\n'
      + '  - entity：這件事是關於誰或什麼（人名／專案名／產品名／主題，簡短；使用者本人的事用「使用者」開頭，例如「使用者飲食」「使用者報告格式」；AI 自己的名字或角色用「你的名字」「你的角色」）\n'
      + '  - text：一句完整、看了就懂的陳述（不要用「他」「這個」這類代名詞）\n'
      + '  - kind：identity（使用者或 AI 的身分、名字、角色）／preference（偏好、習慣、禁忌、格式要求）／procedure（做事方法；尤其是使用者糾正 AI「不要這樣做、以後要那樣做」）／project（專案或工作的穩定資訊）／decision（已經做的決定）／todo（待辦或承諾）／fact（其他穩定事實）\n'
      + '  - confidence：0～1，你有多確定這是穩定、之後還會成立的事實\n'
      + '  - explicit：使用者是不是明確要求記住（說了「記住」「以後都」「不要再」之類）\n'
      + '只抽使用者本人、使用者的專案或工作、或使用者對 AI 的要求。不要抽純粹是查詢對象的第三方資料、新聞、一般知識，也不要抽密碼、金鑰、卡號這類機密。';
    if (profile) p += '\n\n使用者本人的背景（使用者自己填的，可信度最高，請用它判斷哪些內容跟使用者有關）：\n' + clip(profile, 1500);
    if (known && known.length) p += '\n\n目前記憶裡已經有這些實體，講的是同一個東西時請用一樣的名稱：' + known.slice(0, 40).join('、');
    p += '\n\n對話內容：\n' + transcript + '\n\n'
      + '請「只」輸出一個 JSON 物件（不要加 ```json 或其他文字）：\n'
      + '{"topic":"這段對話的主題，一句話","summary":"高密度摘要，120 字以內","entities":["最多 5 個關鍵實體"],"facts":[{"entity":"…","text":"…","kind":"preference","confidence":0.9,"explicit":false}]}\n'
      + '沒有值得記住的內容時：summary 給空字串、entities 與 facts 給空陣列。';
    return p;
  }
  function mergePrompt(schema, entity, existingPage, fact) {
    return schema + '\n\n---\n\n'
      + (existingPage
        ? '這個實體「' + entity + '」目前的完整頁面內容：\n' + existingPage + '\n\n現在有一則新事實要併入' + (fact.label ? '（來源：' + fact.label + '）' : '') + '：\n' + fact.text
        : '這個實體「' + entity + '」目前還沒有頁面，請建立初始頁面。新事實' + (fact.label ? '（來源：' + fact.label + '）' : '') + '：\n' + fact.text)
      + '\n\n請依照上面的維護守則，輸出合併/建立後的 JSON。'
      + '另外請在 JSON 裡多放一個 "superseded" 陣列：這次被新事實取代的舊事實原文（沒有就給空陣列）。';
  }
  var DEFAULT_RULE = '新事實如果跟既有內容明確矛盾就取代（舊內容搬到「## 已取代的舊資料」並加刪除線，不要刪除），只是補充就加進「## 目前事實」，不確定是否衝突就分開保留。'
    + '只能輸出一個 JSON 物件：{"page_md":"完整的新版頁面（## 目前事實／## 已取代的舊資料 兩個區段）","current_fact":"目前最重要的一句話事實","conflict":true 或 false,"note":"一句話說明"}';

  /* ───────────── 引擎 ───────────── */
  function create(deps) {
    deps = deps || {};
    var S = deps.store || {}, cfg = Object.assign({}, DEFAULTS, deps.config || {});
    var now = function () { return deps.now ? deps.now() : Date.now(); };
    var warn = function () { try { (deps.warn || console.warn).apply(null, arguments); } catch (e) { /* ignore */ } };
    var kv = deps.kv || { get: function () { return null; }, set: function () { } };
    function hasLlm() { return typeof deps.llm === 'function' && (!deps.hasLlm || deps.hasLlm()); }
    function hasEmbed() { return typeof deps.embedDocs === 'function' && (!deps.hasEmbed || deps.hasEmbed()); }
    function embModel() { return hasEmbed() ? str(deps.embModel || '') : ''; }
    function changed() { try { deps.changed && deps.changed(); } catch (e) { /* ignore */ } }
    async function log(op, entity, detail, sid) { try { S.log && await S.log(op, str(entity), clip(detail, 300), str(sid)); } catch (e) { /* 紀錄而已 */ } }
    async function embedOne(title, text) {
      if (!hasEmbed()) return null;
      try { var v = await deps.embedDocs(['task: search result | title: ' + title + ' | text: ' + text]); return (v && v[0] && v[0].length) ? v[0] : null; }
      catch (e) { warn('[NOVA][記憶] 嵌入失敗（不影響儲存，之後夜間整理會補算）', e); return null; }
    }

    /* ── 名單：不要記的對話、Bot 的記憶提案 ── */
    function skipList() { var a = kv.get('nova_mem_skip_sessions'); return Array.isArray(a) ? a.map(String) : []; }
    function isSkipped(sid) { return sid != null && skipList().indexOf(String(sid)) >= 0; }
    function setSkipped(sid, on) {
      var a = skipList().filter(function (x) { return x !== String(sid); });
      if (on) a.push(String(sid));
      kv.set('nova_mem_skip_sessions', a.slice(-500));
      return !!on;
    }
    function proposals() { var a = kv.get('nova_mem_proposals'); return Array.isArray(a) ? a : []; }
    function propose(o) {
      o = o || {};
      var text = clip(str(o.text).trim(), 400);
      if (!text) return { ok: false, error: '沒有內容' };
      if (detectSecret(text)) return { ok: false, error: '內容看起來含有金鑰或密碼，不能寫進記憶' };
      var a = proposals();
      if (a.some(function (p) { return normEntity(p.text) === normEntity(text); })) return { ok: true, duplicate: true };
      var item = { id: 'mp_' + now().toString(36) + Math.random().toString(36).slice(2, 6), text: text, entity: clip(str(o.entity).trim(), 60), kind: KINDS.indexOf(o.kind) >= 0 ? o.kind : 'fact', from: clip(str(o.from), 60), ts: now() };
      a.push(item); kv.set('nova_mem_proposals', a.slice(-100));
      try { deps.onProposal && deps.onProposal(item); } catch (e) { /* ignore */ }
      return { ok: true, id: item.id };
    }
    async function resolveProposal(id, accept) {
      var a = proposals(), it = a.filter(function (p) { return p.id === id; })[0];
      kv.set('nova_mem_proposals', a.filter(function (p) { return p.id !== id; }));
      if (!it || !accept) return { ok: !!it };
      return remember({ text: it.text, entity: it.entity, kind: it.kind, src: 'bot', label: 'Bot 提案（' + (it.from || 'Bot') + '），使用者同意' });
    }

    /* ── 實體解析（別名）── */
    async function resolveEntity(name) {
      name = clip(str(name).trim(), 80);
      if (!name) return '';
      if (S.resolve) { try { var r = await S.resolve(name); if (r && r.entity) return r.entity; } catch (e) { /* 退回本機比對 */ } }
      var n = normEntity(name);
      try {
        var core = await S.coreAll({ vectors: false });
        for (var i = 0; i < core.length; i++) {
          if (normEntity(core[i].entity) === n) return core[i].entity;
          var al = getX(core[i]).aliases;
          if (Array.isArray(al)) for (var j = 0; j < al.length; j++) if (normEntity(al[j]) === n) return core[i].entity;
        }
        if (S.freqAll) { var fr = await S.freqAll(); for (var k = 0; k < fr.length; k++) if (normEntity(fr[k].entity) === n) return fr[k].entity; }
      } catch (e) { /* 查不到就用原名 */ }
      return name;
    }

    /* ── 固化：把一筆事實併進實體頁面 ── */
    async function consolidate(entity, fact, ctx) {
      ctx = ctx || {};
      var t = now(), text = clip(str(fact.text).trim(), 600);
      if (!entity || !text) return { ok: false };
      if (detectSecret(text)) { await log('skip', entity, '內容看起來含有金鑰或密碼，沒有寫進記憶', ctx.sessionId); return { ok: false, secret: true }; }
      var existing = null;
      try { existing = await S.coreGet(entity); } catch (e) { existing = null; }
      var x = JSON.parse(JSON.stringify(getX(existing)));
      var facts = Array.isArray(x.facts) ? x.facts : [];
      if (facts.some(function (f) { return f && !f.until && normEntity(f.t) === normEntity(text); }) || (existing && normEntity(currentSection(existing.page_md)).indexOf(normEntity(text)) >= 0 && normEntity(text).length >= 6)) {
        if (fact.pinned && !x.pinned) { x.pinned = true; x.xu = t; await S.corePut(Object.assign({}, existing, { x: x, last_updated: t })); changed(); }
        return { ok: true, duplicate: true, entity: entity };
      }
      var refs = (existing && Array.isArray(existing.source_refs)) ? existing.source_refs : [];
      if (ctx.sourceRef) refs = refs.concat([ctx.sourceRef]).slice(-20);
      var label = fact.label || ({ user: '使用者親口確認', chat: '對話', doc: '文件/筆記匯入', bot: 'Bot', heal: '操作經驗', correction: '使用者糾正' }[fact.src] || '自動固化');
      var pageMd = '', currentFact = text, conflict = false, note = '', superseded = [];
      var oldPage = existing && existing.page_md ? existing.page_md : (existing && existing.fact ? buildPage('- ' + existing.fact, '') : '');
      var merged = false;
      if (hasLlm() && !fact.noLlm) {
        try {
          var schema = S.schema ? (await S.schema()) : '';
          var p = parseJson(await deps.llm(mergePrompt(schema || DEFAULT_RULE, entity, oldPage, { text: text, label: label }), { ms: 20000, purpose: 'merge' }));
          if (p && p.page_md && p.current_fact) {
            pageMd = str(p.page_md); currentFact = clip(p.current_fact, 400); conflict = !!p.conflict;
            note = str(p.note) || (conflict ? '偵測到矛盾，已取代舊內容' : '併入新事實，無衝突');
            superseded = Array.isArray(p.superseded) ? p.superseded.map(str) : [];
            merged = true;
          } else throw new Error('模型回傳格式不符預期');
        } catch (e) { warn('[NOVA][記憶Wiki] 合併判斷失敗，改成直接附加：', e); }
      }
      if (!merged) {
        var cur = currentSection(oldPage), sup = supersededSection(oldPage);
        pageMd = buildPage((cur ? cur + '\n' : '') + '- ' + text + ' [來源: ' + label + ', ' + dateStr(t) + ']', sup);
        currentFact = fact.pinned || !existing ? text : (existing.fact || text);
        note = hasLlm() && !fact.noLlm ? '合併判斷失敗，改成直接附加（未檢查是否與既有內容衝突）' : '直接附加';
      }
      superseded.forEach(function (old) {
        var qt = tokens(old), best = null, bs = 0;
        facts.forEach(function (f) { if (f && !f.until) { var s = keywordScore(qt, f.t); if (s > bs) { bs = s; best = f; } } });
        if (best && bs >= 0.6) best.until = t;
      });
      facts.push({ t: text, k: KINDS.indexOf(fact.kind) >= 0 ? fact.kind : 'fact', c: Math.round(num(fact.confidence || fact.conf || 0.7) * 100) / 100, s: str(fact.src || 'chat'), from: t, until: 0, ref: str(ctx.sourceRef || '') });
      if (facts.length > cfg.maxFactsKept) facts = facts.slice(facts.length - cfg.maxFactsKept);
      x.facts = facts;
      if (!x.kind || fact.pinned) x.kind = KINDS.indexOf(fact.kind) >= 0 ? fact.kind : (x.kind || 'fact');
      if (fact.pinned) x.pinned = true;
      if (fact.scope !== undefined && !existing) x.scope = str(fact.scope);
      if (!x.src) x.src = str(fact.src || 'chat');
      x.xu = t;
      var vec = await embedOne(entity, currentFact);
      var row = {
        entity: entity, fact: currentFact, hit_count: num(ctx.hitCount) || (existing && existing.hit_count) || 1, last_updated: t,
        page_md: pageMd, source_refs: refs, x: x
      };
      if (vec) { row.vector = vec; row.emb_model = embModel(); }
      await S.corePut(row);
      changed();
      await log(conflict ? 'supersede' : 'ingest', entity, note + (fact.pinned ? '（已釘選）' : ''), ctx.sessionId);
      return { ok: true, entity: entity, conflict: conflict, merged: merged };
    }

    function shouldPromote(f) {
      var c = num(f.confidence);
      if (f.kind === 'todo') return false;
      if (f.explicit) return true;
      if ((f.kind === 'identity' || f.kind === 'preference' || f.kind === 'procedure') && c >= 0.6) return true;
      if ((f.kind === 'project' || f.kind === 'decision') && c >= 0.8) return true;
      return false;
    }
    async function bumpFreq(entity) {
      var t = now(), ex = null, count = 1;
      try { ex = S.freqGet ? await S.freqGet(entity) : null; } catch (e) { ex = null; }
      if (ex && ex.count_30d && (t - num(ex.last_seen)) < cfg.entityWindowDays * DAY) count = num(ex.count_30d) + 1;
      try { S.freqPut && await S.freqPut({ entity: entity, count_30d: count, last_seen: t }); } catch (e) { /* ignore */ }
      return count;
    }

    /* ── 套用一次抽取結果 ── */
    async function applyExtract(parsed, ctx) {
      ctx = ctx || {};
      var t = now(), out = { episodicId: '', promoted: 0, counted: 0, skipped: 0 };
      var summary = clip(str(parsed && parsed.summary).trim(), 400);
      var facts = (parsed && Array.isArray(parsed.facts) ? parsed.facts : []).filter(function (f) { return f && str(f.entity).trim() && str(f.text).trim(); }).slice(0, cfg.maxFacts);
      if (!summary && !facts.length) return out;
      var ents = (parsed && Array.isArray(parsed.entities) ? parsed.entities : []).map(function (e) { return clip(str(e).trim(), 60); }).filter(Boolean).slice(0, 5);
      var resolved = {};
      for (var i = 0; i < ents.length; i++) resolved[ents[i]] = await resolveEntity(ents[i]);
      for (var j = 0; j < facts.length; j++) { var en = clip(str(facts[j].entity).trim(), 60); if (!resolved[en]) resolved[en] = await resolveEntity(en); }
      if (summary && !detectSecret(summary)) {
        var id = 'ep_' + str(ctx.sessionId || 's') + '_' + t;
        var vec = await embedOne(str(parsed.topic) || '對話摘要', summary);
        var ep = { id: id, session_id: str(ctx.sessionId), summary: summary, topic: clip(str(parsed.topic), 120), entities: ents.map(function (e) { return resolved[e] || e; }), vector: vec || [], created_at: t, source_range: str(ctx.range), x: {} };
        if (ctx.scope) ep.x.scope = str(ctx.scope);
        if (vec) ep.emb_model = embModel();
        await S.epiPut(ep);
        out.episodicId = id;
        changed();
      }
      var done = {};
      for (var k = 0; k < facts.length; k++) {
        var f = facts[k], entity = resolved[clip(str(f.entity).trim(), 60)];
        var kind = KINDS.indexOf(f.kind) >= 0 ? f.kind : 'fact';
        var fact = { text: f.text, kind: kind, confidence: num(f.confidence) || 0.7, explicit: !!f.explicit, src: f.explicit ? 'user' : (kind === 'procedure' ? 'correction' : 'chat'), pinned: !!f.explicit,
                     scope: (kind === 'project' || kind === 'decision') ? str(ctx.scope) : '' };
        if (detectSecret(f.text)) { out.skipped++; continue; }
        try {
          var cnt = done[entity] ? 0 : await bumpFreq(entity);
          done[entity] = 1;
          if (shouldPromote(fact) || (cnt >= cfg.promoteThreshold && kind !== 'todo')) {
            var r = await consolidate(entity, fact, { sourceRef: out.episodicId, sessionId: ctx.sessionId, hitCount: cnt || undefined });
            if (r.ok && !r.duplicate) out.promoted++;
          } else out.counted++;
        } catch (e) { warn('[NOVA][記憶] 事實固化失敗，略過這一筆：', e); }
      }
      // 沒被事實涵蓋的關鍵實體照舊計數（之後累積到門檻、又有新事實時固化）
      for (var m = 0; m < ents.length; m++) { var e2 = resolved[ents[m]]; if (e2 && !done[e2]) { done[e2] = 1; await bumpFreq(e2); } }
      return out;
    }

    function buildTranscript(msgs) {
      var lines = (msgs || []).map(function (m) {
        var t = str(m.text);
        if (t.length > cfg.msgHead + cfg.msgTail + 20) t = t.slice(0, cfg.msgHead) + ' …（中略）… ' + t.slice(-cfg.msgTail);
        return (m.sender === 'user' ? '使用者' : 'AI') + '：' + t;
      });
      var s = lines.join('\n');
      if (s.length > cfg.transcriptMax) s = s.slice(s.length - cfg.transcriptMax);   // 太長時保留後段（較新的內容）
      return s;
    }

    /* ── 一段對話 → 摘要＋事實。失敗就排進待處理佇列（不遺失）── */
    async function ingestTranscript(o) {
      o = o || {};
      var transcript = str(o.transcript);
      if (!transcript.trim()) return { ok: true, empty: true };
      if (!hasLlm()) { if (!o.fromQueue && S.pendingAdd) await S.pendingAdd({ session_id: str(o.sessionId), transcript: transcript, range: str(o.range), scope: str(o.scope), created_at: now() }); return { ok: false, queued: !o.fromQueue, error: '沒有可用的模型' }; }
      var parsed = null, err = '';
      try {
        var known = [];
        try { known = (await S.coreAll({ vectors: false })).map(function (r) { return r.entity; }); } catch (e) { known = []; }
        var raw = await deps.llm(extractPrompt(transcript, deps.profile ? deps.profile() : '', known), { ms: 30000, purpose: 'extract' });
        parsed = parseJson(raw);
        if (!parsed || (parsed.summary === undefined && !Array.isArray(parsed.facts))) { parsed = null; err = '模型回傳的內容不是預期的 JSON'; }
      } catch (e) { err = (e && e.message) || String(e); }
      if (!parsed) {
        if (!o.fromQueue && S.pendingAdd) { try { await S.pendingAdd({ session_id: str(o.sessionId), transcript: transcript, range: str(o.range), scope: str(o.scope), created_at: now(), last_error: clip(err, 200) }); } catch (e2) { /* 佇列也寫不進去就真的沒辦法了 */ } }
        warn('[NOVA][記憶] 這段對話的摘要失敗，已排進待處理佇列之後重試：', err);
        return { ok: false, queued: !o.fromQueue, error: err };
      }
      var res = await applyExtract(parsed, { sessionId: o.sessionId, range: o.range, scope: o.scope });
      return Object.assign({ ok: true }, res);
    }
    async function retryPending(max) {
      if (!S.pendingAll || !hasLlm()) return { tried: 0, done: 0 };
      var items = [], tried = 0, done = 0;
      try { items = await S.pendingAll(); } catch (e) { items = []; }
      for (var i = 0; i < items.length && tried < (max || 5); i++) {
        var it = items[i];
        if (num(it.attempts) >= 5) { await S.pendingDel(it.id); await log('skip', '', '一段對話重試 5 次仍然無法摘要，已放棄', it.session_id); continue; }
        tried++;
        var r = await ingestTranscript({ sessionId: it.session_id, transcript: it.transcript, range: it.range, scope: it.scope, fromQueue: true });
        if (r.ok) { await S.pendingDel(it.id); done++; }
        else if (S.pendingFail) await S.pendingFail(it.id, r.error || '');
      }
      return { tried: tried, done: done };
    }

    /* ── 記住／忘記 ── */
    var REMEMBER_RX = /^\s*(?:請|麻煩|幫我|拜託)?\s*(?:你)?\s*(?:要|幫我)?\s*(?:記住|記下來|記下|記起來)(?:一下)?\s*[，,：:；;\s]\s*(.{4,400})$/;
    function explicitFromUserText(text) {
      var s = str(text).trim();
      if (!s || s.length > 420 || /[?？嗎]\s*$/.test(s)) return null;
      var m = REMEMBER_RX.exec(s.replace(/\n+/g, ' '));
      return m ? m[1].trim() : null;
    }
    async function remember(o) {
      o = o || {};
      var text = clip(str(o.text).trim(), 600);
      if (!text) return { ok: false, error: '沒有內容' };
      if (detectSecret(text)) return { ok: false, error: '這段內容看起來含有金鑰、密碼或證號，為了安全不會寫進記憶' };
      var entity = clip(str(o.entity).trim(), 60), kind = KINDS.indexOf(o.kind) >= 0 ? o.kind : '';
      if ((!entity || !kind) && hasLlm()) {
        try {
          var p = parseJson(await deps.llm('使用者要你長期記住這件事：「' + text + '」\n請判斷它的主題與類型，只輸出 JSON：{"entity":"這件事是關於誰或什麼（簡短；使用者本人的事用「使用者」開頭，AI 自己的名字或角色用「你的名字」「你的角色」）","kind":"identity／preference／procedure／project／decision／todo／fact 其中一個","text":"改寫成一句完整、不含代名詞的陳述"}', { ms: 15000, purpose: 'remember' }));
          if (p) { entity = entity || clip(str(p.entity).trim(), 60); kind = kind || (KINDS.indexOf(p.kind) >= 0 ? p.kind : ''); if (!o.keepText && str(p.text).trim() && !detectSecret(p.text)) text = clip(str(p.text).trim(), 600); }
        } catch (e) { /* 判斷失敗就用預設 */ }
      }
      entity = await resolveEntity(entity || '使用者備忘');
      var r = await consolidate(entity, { text: text, kind: kind || 'fact', confidence: 1, src: o.src || 'user', pinned: o.pinned !== false, scope: o.scope, label: o.label, explicit: true }, { sessionId: o.sessionId });
      return r.ok ? { ok: true, entity: entity, duplicate: !!r.duplicate, text: text } : { ok: false, error: r.secret ? '內容含機密' : '寫入失敗' };
    }
    async function forget(o) {
      o = o || {};
      var q = str(o.query || o.text).trim(), name = str(o.entity).trim();
      if (!q && !name) return { ok: false, error: '沒有指定要忘記什麼' };
      var rows = await S.coreAll({ vectors: false });
      var target = null, whole = false;
      if (name) { var rn = await resolveEntity(name); target = rows.filter(function (r) { return r.entity === rn; })[0] || null; whole = !!target && !q; }
      if (!target && (q || name)) {
        var nq = normEntity(q || name);
        target = rows.filter(function (r) { return normEntity(r.entity) === nq || (Array.isArray(getX(r).aliases) && getX(r).aliases.map(normEntity).indexOf(nq) >= 0); })[0] || null;
        if (target) whole = true;
      }
      var qt = tokens(q || name);
      if (!target) {
        var best = null, bs = 0;
        rows.forEach(function (r) { var s = keywordScore(qt, str(r.entity) + ' ' + str(r.fact) + ' ' + currentSection(r.page_md)); if (s > bs) { bs = s; best = r; } });
        if (best && bs >= 0.5) target = best;
      }
      if (!target) return { ok: false, error: '記憶裡找不到相符的內容' };
      var t = now();
      if (!whole) {
        var lines = currentSection(target.page_md || ('- ' + str(target.fact))).split('\n').filter(function (l) { return l.trim(); });
        var keep = lines.filter(function (l) { return keywordScore(qt, l) < 0.5; });
        if (keep.length && keep.length < lines.length) {
          var removed = lines.filter(function (l) { return keep.indexOf(l) < 0; });
          var sup = supersededSection(target.page_md);
          var x = JSON.parse(JSON.stringify(getX(target)));
          (Array.isArray(x.facts) ? x.facts : []).forEach(function (f) { if (f && !f.until && keywordScore(qt, f.t) >= 0.5) f.until = t; });
          x.xu = t;
          var fact = keep[0].replace(/^\s*[-*]\s*/, '').replace(/\s*\[來源:[^\]]*\]\s*/g, '').trim();
          var row = { entity: target.entity, fact: fact || target.fact, hit_count: target.hit_count || 1, last_updated: t, source_refs: target.source_refs || [], x: x,
                      page_md: buildPage(keep.join('\n'), (sup ? sup + '\n' : '') + removed.map(function (l) { return '- ~~' + l.replace(/^\s*[-*]\s*/, '') + '~~ → 使用者要求忘記 [' + dateStr(t) + ']'; }).join('\n')) };
          var vec = await embedOne(row.entity, row.fact);
          if (vec) { row.vector = vec; row.emb_model = embModel(); }
          await S.corePut(row); changed();
          await log('manual', target.entity, '使用者要求忘記其中 ' + removed.length + ' 句', o.sessionId);
          return { ok: true, entity: target.entity, removed: removed.length, partial: true };
        }
      }
      await S.coreDel(target.entity); changed();
      await log('manual', target.entity, '使用者要求忘記，整筆刪除', o.sessionId);
      return { ok: true, entity: target.entity, deleted: true };
    }
    async function setPinned(entity, on) {
      var r = await S.coreGet(entity); if (!r) return false;
      var x = JSON.parse(JSON.stringify(getX(r))); x.pinned = !!on; x.xu = now();
      await S.corePut({ entity: r.entity, fact: r.fact, hit_count: r.hit_count || 1, last_updated: now(), page_md: r.page_md || '', source_refs: r.source_refs || [], x: x });
      changed(); return true;
    }

    /* ── 合併兩個實體（from 併入 into）── */
    async function mergeEntities(from, into, why) {
      if (S.merge) { var mr = await S.merge(from, into); changed(); await log('merge', into, '「' + from + '」併入「' + into + '」' + (why ? '（' + why + '）' : ''), ''); return mr; }
      var a = await S.coreGet(from), b = await S.coreGet(into);
      if (!a || !b || from === into) return { ok: false };
      var t = now(), xb = JSON.parse(JSON.stringify(getX(b))), xa = getX(a);
      var al = (Array.isArray(xb.aliases) ? xb.aliases : []).concat([a.entity]).concat(Array.isArray(xa.aliases) ? xa.aliases : []);
      var seen = {}; xb.aliases = al.filter(function (v) { var k = normEntity(v); if (!k || seen[k] || k === normEntity(b.entity)) return false; seen[k] = 1; return true; }).slice(0, 12);
      xb.facts = (Array.isArray(xb.facts) ? xb.facts : []).concat(Array.isArray(xa.facts) ? xa.facts : []).slice(-cfg.maxFactsKept);
      if (xa.pinned) xb.pinned = true;
      xb.xu = t;
      var cur = currentSection(b.page_md || ('- ' + str(b.fact))), curA = currentSection(a.page_md || ('- ' + str(a.fact)));
      var sup = [supersededSection(b.page_md), supersededSection(a.page_md)].filter(Boolean).join('\n');
      var row = { entity: b.entity, fact: b.fact || a.fact, hit_count: num(b.hit_count) + num(a.hit_count), last_updated: t, page_md: buildPage(cur + (curA ? '\n' + curA : ''), sup),
                  source_refs: (b.source_refs || []).concat(a.source_refs || []).slice(-20), x: xb };
      await S.corePut(row);
      await S.coreDel(a.entity);
      changed();
      await log('merge', into, '「' + from + '」併入「' + into + '」' + (why ? '（' + why + '）' : ''), '');
      return { ok: true };
    }

    /* ── 檢索 ── */
    var FOLLOW_RX = /(那個|這個|那件|這件|它|他們|她|上次|剛剛|剛才|後來|之前說|前面說|繼續|然後呢|怎麼樣了|還有呢)/;
    function buildQuery(text, history) {
      var s = str(text).trim();
      if (!Array.isArray(history) || !history.length) return clip(s, 600);
      if (s.length >= 8 && !FOLLOW_RX.test(s)) return clip(s, 600);   // 夠長（8 個字以上）而且沒有指代詞：本身就是完整的問題，不帶上文（帶了反而會把上一個話題的記憶拉進來）
      var prev = history.filter(function (m) { return m && m.text && str(m.text).trim() !== s; }).slice(-2).map(function (m) { return clip(str(m.text).replace(/\s+/g, ' '), 200); });
      return clip((prev.length ? prev.join(' ') + ' ' : '') + s, 800);
    }
    function formatContext(coreHits, epiHits, opts) {
      opts = opts || {};
      var t = now(), parts = [], budget = num(opts.budgetChars) || cfg.budgetChars;
      if (coreHits.length) {
        var rows = coreHits.slice().sort(function (a, b) { return num(b.row.last_updated) - num(a.row.last_updated); });
        var segs = [], used = 0;
        for (var i = 0; i < rows.length; i++) {
          var h = rows[i], r = h.row, x = getX(r), seg;
          var page = currentSection(r.page_md).replace(/\s*\[來源:[^\]]*\]/g, '').replace(/^\s*[-*]\s*/gm, '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
          if (h.score >= cfg.pageExcerptMin && page.length > 1) seg = r.entity + '：' + clip(page.join('；'), cfg.pageExcerptChars);
          else seg = r.entity + '：' + clip(r.fact, 240);
          if (x.pinned) seg += '（使用者親口確認）';
          if (used + seg.length > budget * 0.65 && segs.length) break;
          segs.push(seg); used += seg.length;
        }
        parts.push('[使用者已確認的長期事實（依確認時間由新到舊排序）——若與你原本的預設認知衝突（包含你自己的名字、身分、角色設定等），一律以下面這些為準，不要用其他預設值回答；如果列出的長期事實彼此衝突，一律以排在前面（較新）的為準：' + segs.join('；') + ']');
      }
      if (epiHits.length && !opts.coreOnly) {
        var es = [], eu = 0;
        for (var j = 0; j < epiHits.length; j++) {
          var e = epiHits[j].row, ag = ageText(e.created_at, t);
          var s2 = (e.topic || '過去對話') + (ag ? '（' + ag + '）' : '') + '：' + clip(e.summary, 260);
          if (eu + s2.length > budget * 0.45 && es.length) break;
          es.push(s2); eu += s2.length;
        }
        parts.push('[過去對話參考（背景資訊，供你理解脈絡用；括號是多久以前談的）：' + es.join('；') + ']');
      }
      return parts.join('\n');
    }
    async function retrieve(text, opts) {
      opts = opts || {};
      var query = buildQuery(text, opts.history);
      if (!query) return { found: false, context: '', core: [], episodic: [] };
      var qv = null;
      if (typeof deps.embedQuery === 'function' && (!deps.hasEmbed || deps.hasEmbed())) { try { qv = await deps.embedQuery(query); } catch (e) { qv = null; } }
      var q = { text: query, vector: qv, model: embModel(), scope: str(opts.scope), now: now() };
      var coreHits, epiHits;
      if (S.retrieve) {
        var d = await S.retrieve(Object.assign({}, q, { coreOnly: !!opts.coreOnly, cfg: cfg }));
        coreHits = (d.core || []).map(function (c) { return { row: c, score: num(c._score) }; });
        epiHits = (d.episodic || []).map(function (e) { return { row: e, score: num(e._score) }; });
      } else {
        var rows = await S.coreAll({ vectors: true });
        coreHits = rankCore(rows, q, cfg);
        epiHits = opts.coreOnly ? [] : rankEpisodic(await S.epiAll({ vectors: true }), q, cfg);
        if (S.touch) { try { await S.touch(coreHits.map(function (h) { return h.row.entity; }), epiHits.map(function (h) { return h.row.id; }), q.now); } catch (e) { /* 用量統計而已 */ } }
      }
      var context = formatContext(coreHits, epiHits, opts);
      return { found: !!context, context: context, core: coreHits.map(function (h) { return h.row; }), episodic: epiHits.map(function (h) { return h.row; }), query: query };
    }

    /* ── 健檢 ── */
    async function lint() {
      var t = now(), core = await S.coreAll({ vectors: true }), em = embModel();
      var rep = { noVector: [], modelMismatch: 0, dups: dupCandidates(core, 20), stale: [], pending: 0, conflicts: [], legacy: 0, total: core.length };
      core.forEach(function (r) {
        var x = getX(r);
        if (!r.vector || !r.vector.length) rep.noVector.push(r.entity);
        else if (em && r.emb_model && r.emb_model !== em) rep.modelMismatch++;
        if (!x.pinned && t - Math.max(num(r.last_updated), num(r.last_used)) > cfg.staleDays * DAY) rep.stale.push(r.entity);
        if (!r.page_md) rep.legacy++;
      });
      try { if (S.pendingAll) rep.pending = (await S.pendingAll()).length; } catch (e) { /* ignore */ }
      try {
        if (S.logRecent) {
          var seen = {};
          (await S.logRecent(200)).forEach(function (l) { if (l.op === 'conflict' && t - num(l.ts) < 30 * DAY && !seen[l.entity]) { seen[l.entity] = 1; rep.conflicts.push({ entity: l.entity, detail: l.detail }); } });
        }
      } catch (e) { /* ignore */ }
      return rep;
    }

    /* ── 夜間整理 ── */
    async function maintain(o) {
      o = o || {};
      var t0 = now(), budget = num(o.budgetMs) || 120000, rep = { pending: { tried: 0, done: 0 }, embedded: 0, merged: 0, conflicts: 0, digests: 0, notes: [] };
      var left = function () { return budget - (now() - t0); };
      // 1. 重試之前摘要失敗的對話
      try { rep.pending = await retryPending(5); } catch (e) { rep.notes.push('重試佇列失敗：' + (e.message || e)); }
      // 2. 補算／重算向量
      if (hasEmbed() && left() > 0) {
        try {
          var em = embModel(), core = await S.coreAll({ vectors: true }), n = 0;
          for (var i = 0; i < core.length && n < 40 && left() > 0; i++) {
            var r = core[i];
            if (r.vector && r.vector.length && (!r.emb_model || r.emb_model === em)) continue;
            var v = await embedOne(r.entity, r.fact);
            if (!v) break;
            await S.corePut({ entity: r.entity, fact: r.fact, hit_count: r.hit_count || 1, last_updated: r.last_updated, page_md: r.page_md || '', source_refs: r.source_refs || [], x: r.x, vector: v, emb_model: em, _vecOnly: true });
            n++;
          }
          if (S.epiAll) {
            var epi = await S.epiAll({ vectors: true });
            for (var j = 0; j < epi.length && n < 80 && left() > 0; j++) {
              var e = epi[j];
              if (e.vector && e.vector.length && (!e.emb_model || e.emb_model === em)) continue;
              var v2 = await embedOne(e.topic || '對話摘要', e.summary);
              if (!v2) break;
              await S.epiPut(Object.assign({}, e, { vector: v2, emb_model: em, _vecOnly: true }));
              n++;
            }
          }
          rep.embedded = n;
        } catch (e) { rep.notes.push('補算向量失敗：' + (e.message || e)); }
      }
      // 3. 合併重複實體（請模型確認是不是同一個東西）
      if (hasLlm() && left() > 0 && o.dedupe !== false) {
        try {
          var rows = await S.coreAll({ vectors: true }), cands = dupCandidates(rows, 8), byName = {};
          rows.forEach(function (r) { byName[r.entity] = r; });
          var skip = kv.get('nova_mem_dedupe_no') || {};
          cands = cands.filter(function (c) { return !skip[normEntity(c.a) + '|' + normEntity(c.b)]; }).slice(0, 5);
          if (cands.length) {
            var lines = cands.map(function (c, i) { return (i + 1) + '. A「' + c.a + '」：' + clip(byName[c.a].fact, 120) + '\n   B「' + c.b + '」：' + clip(byName[c.b].fact, 120); }).join('\n');
            var p = parseJson(await deps.llm('下面每一組是記憶裡的兩個實體頁面。請判斷每一組的 A 和 B 是不是「同一個人／專案／東西的不同寫法」。只有很確定是同一個才回 true；只是相關、或一個是另一個的一部分，都回 false。\n\n' + lines
              + '\n\n只輸出 JSON：{"pairs":[{"i":1,"same":true,"keep":"A 或 B（比較正式、完整的那個名稱）"}]}', { ms: 25000, purpose: 'dedupe' }));
            var pairs = (p && Array.isArray(p.pairs)) ? p.pairs : [];
            for (var k = 0; k < pairs.length; k++) {
              var c = cands[num(pairs[k].i) - 1]; if (!c) continue;
              if (pairs[k].same === true) {
                var keepB = /b/i.test(str(pairs[k].keep));
                var into = keepB ? c.b : c.a, from = keepB ? c.a : c.b;
                if (getX(byName[from]).pinned && !getX(byName[into]).pinned) { var tmp = into; into = from; from = tmp; }
                var mr = await mergeEntities(from, into, c.why);
                if (mr && mr.ok !== false) rep.merged++;
              } else { skip[normEntity(c.a) + '|' + normEntity(c.b)] = now(); }
            }
            kv.set('nova_mem_dedupe_no', skip);
          }
        } catch (e) { rep.notes.push('合併重複實體失敗：' + (e.message || e)); }
      }
      // 4. 檢查頁面內的事實有沒有互相矛盾（只標記、不自動改）
      if (hasLlm() && left() > 0 && o.conflicts !== false) {
        try {
          var chk = kv.get('nova_mem_conflict_chk') || {}, all = await S.coreAll({ vectors: false }), tn = now();
          var targets = all.filter(function (r) { var cur = currentSection(r.page_md).split('\n').filter(function (l) { return l.trim(); }); return cur.length >= 3 && (!chk[r.entity] || tn - chk[r.entity] > 30 * DAY || num(r.last_updated) > chk[r.entity]); }).slice(0, 3);
          for (var m = 0; m < targets.length && left() > 0; m++) {
            var tr = targets[m];
            var pj = parseJson(await deps.llm('下面是「' + tr.entity + '」目前記錄的事實。請檢查其中有沒有「互相矛盾、不可能同時成立」的兩句（同一件事兩個不同答案）。只是補充或不同面向不算。\n\n' + clip(currentSection(tr.page_md), 2000)
              + '\n\n只輸出 JSON：{"conflict":true 或 false,"detail":"有矛盾時，用一句話指出是哪兩句"}', { ms: 20000, purpose: 'conflict' }));
            chk[tr.entity] = tn;
            if (pj && pj.conflict === true) { rep.conflicts++; await log('conflict', tr.entity, str(pj.detail) || '頁面裡有互相矛盾的事實', ''); }
          }
          kv.set('nova_mem_conflict_chk', chk);
        } catch (e) { rep.notes.push('矛盾檢查失敗：' + (e.message || e)); }
      }
      // 5. 很久沒用到的舊摘要 → 濃縮成一則（原摘要標成封存，不刪除）
      if (hasLlm() && left() > 0 && o.digest !== false && S.epiAll) {
        try {
          var tn2 = now(), old = (await S.epiAll({ vectors: false })).filter(function (e) { var x = getX(e); return !x.arch && !x.digest && !x.pinned && !num(e.use_count) && tn2 - num(e.created_at) > cfg.digestAfterDays * DAY; });
          var groups = {};
          old.forEach(function (e) { var key = 's:' + str(e.session_id); (groups[key] = groups[key] || []).push(e); });
          var gkeys = Object.keys(groups).filter(function (k) { return groups[k].length >= cfg.digestMinGroup; }).slice(0, 2);
          for (var g = 0; g < gkeys.length && left() > 0; g++) {
            var grp = groups[gkeys[g]].sort(function (a, b) { return num(a.created_at) - num(b.created_at); }).slice(0, 12);
            var pd = parseJson(await deps.llm('下面是同一串對話在不同時間留下的 ' + grp.length + ' 則摘要。請濃縮成一則更高層的結論（200 字以內），保留最後成立的事實、決定與結果，省略過程。\n\n'
              + grp.map(function (e, i) { return (i + 1) + '. ' + (e.topic || '') + '：' + e.summary; }).join('\n') + '\n\n只輸出 JSON：{"topic":"主題","summary":"濃縮後的摘要"}', { ms: 25000, purpose: 'digest' }));
            if (!pd || !str(pd.summary).trim()) continue;
            var ents = {}; grp.forEach(function (e) { (e.entities || []).forEach(function (n2) { ents[n2] = 1; }); });
            var dv = await embedOne(str(pd.topic) || '對話摘要', str(pd.summary));
            var dg = { id: 'dg_' + tn2.toString(36) + '_' + g, session_id: grp[0].session_id, summary: clip(pd.summary, 400), topic: clip(pd.topic, 120), entities: Object.keys(ents).slice(0, 5), vector: dv || [], created_at: num(grp[grp.length - 1].created_at),
                       source_range: str(grp[0].source_range).split('~')[0] + '~' + str(grp[grp.length - 1].source_range).split('~').pop(), x: { digest: true, of: grp.map(function (e) { return e.id; }) } };
            var sc = getX(grp[0]).scope; if (sc) dg.x.scope = sc;
            if (dv) dg.emb_model = embModel();
            await S.epiPut(dg);
            for (var h = 0; h < grp.length; h++) { var xe = JSON.parse(JSON.stringify(getX(grp[h]))); xe.arch = true; await S.epiPut(Object.assign({}, grp[h], { x: xe, _edited: true })); }
            rep.digests++;
            await log('digest', '', '把 ' + grp.length + ' 則舊摘要濃縮成一則：' + clip(pd.topic, 60), grp[0].session_id);
          }
          if (rep.digests) changed();
        } catch (e) { rep.notes.push('濃縮舊摘要失敗：' + (e.message || e)); }
      }
      await log('maintain', '', '整理完成：重試 ' + rep.pending.done + '/' + rep.pending.tried + '、補向量 ' + rep.embedded + '、合併 ' + rep.merged + '、發現矛盾 ' + rep.conflicts + '、濃縮 ' + rep.digests, '');
      kv.set('nova_mem_maintain_last', now());
      return rep;
    }

    return {
      VERSION: VERSION, config: cfg,
      ingestTranscript: ingestTranscript, buildTranscript: buildTranscript, applyExtract: applyExtract, retryPending: retryPending,
      consolidate: consolidate, resolveEntity: resolveEntity, remember: remember, forget: forget, setPinned: setPinned, mergeEntities: mergeEntities,
      explicitFromUserText: explicitFromUserText, retrieve: retrieve, buildQuery: buildQuery, formatContext: formatContext,
      lint: lint, maintain: maintain, isSkipped: isSkipped, setSkipped: setSkipped, propose: propose, proposals: proposals, resolveProposal: resolveProposal,
      hasLlm: hasLlm, hasEmbed: hasEmbed
    };
  }

  return {
    VERSION: VERSION, KINDS: KINDS, KIND_ZH: KIND_ZH, DEFAULTS: DEFAULTS, create: create,
    normEntity: normEntity, tokens: tokens, keywordScore: keywordScore, cosine: cosine, parseJson: parseJson, ageText: ageText, detectSecret: detectSecret,
    rankCore: rankCore, rankEpisodic: rankEpisodic, dupCandidates: dupCandidates, mergeX: mergeX, getX: getX, sync: SYNC,
    currentSection: currentSection, supersededSection: supersededSection, buildPage: buildPage, extractPrompt: extractPrompt
  };
});

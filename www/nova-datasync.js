/* nova-datasync.js — v1.1.0 (2026-11-01)
 * 手機版「NovaResearch／Project Insight 資料同步」：把桌面 nova-data-sync.js v1.0.0 的比對／合併核心原樣移植，遠端存取改走 NovaGoogle._drive（Drive REST）。
 * 與桌面互通：同一個 Google 帳號的 Drive 根目錄，檔名 NOVA_Research_Sync.json（研發：專案／材料／實驗／情報／監看定義／報告／筆記）、NOVA_Insight_Sync.json（Insight：預判、個股、虛擬交易、日誌…）。
 *   檔案格式：{v:1, items:{鍵:{h:雜湊,ts:時間,v:內容}}, deleted:{鍵:時間}, at, from}；鍵＝「種類/id」（Research）或 localStorage 項目名（Insight）。
 * 合併規則（三方比對、安全網、重複檔案合併）與桌面完全相同：只一邊改→採用該邊；兩邊都改→Research 取 updated 較新、Insight 依 id 聯集；一邊刪另一邊沒改→傳播刪除；
 *   大量刪除（≥10 筆且過半）不做；遠端讀不到／不是合法 JSON→中止，不覆蓋。
 * 觸發：Drive 同步（nova-google.js 的 syncNow 在記憶同步後呼叫 NovaDataSync.syncAll）、資料改動後 4 秒（nova-research-changed／nova-insight-changed）、App 回到前景、設定頁手動按鈕。
 * 子開關（預設開）：localStorage nova_dsync_research_on／nova_dsync_insight_on；上次同步狀態 nova_dsync_<id>_state／_info；檔案 id 快取 nova_dsync_<id>_fileid。
 * 版本紀錄
 *   v1.1.0 2026-11-01  Insight 同步補「額外鍵」：桌面傳來但手機沒有介面的鍵（研究、劇本、校準…）改記在 nova_insight_extra_keys 一併收集，避免下次同步被誤判成手機刪除而回寫刪掉桌面資料。
 *   v1.0.0 2026-11-01  首版，核心比對與桌面同；以 Node 對 plan／applyRisk／sync 做過情境測試（雙邊修改、刪除傳播、大量刪除安全網、遠端壞檔中止、重複檔案合併）。【Drive 實際連線未在真機驗證】
 */
(function (root) {
  'use strict';
  var VERSION = '1.0.0';
  var TOMB_KEEP_MS = 90 * 24 * 3600 * 1000;

  /* ── 純函式：正規化、雜湊、合併（可單獨測試）── */
  function canon(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    return '{' + Object.keys(v).sort().filter(function (k) { return v[k] !== undefined; }).map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
  }
  function hash(v) {   // cyrb53
    var s = canon(v), h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + '.' + s.length.toString(36);
  }
  var TS_FIELDS = ['updated', 'updatedAt', 'updated_at', 'ts', 'at', 'resolved_at', 'settled_at', 'closed_at', 'time'];
  function tsOf(o, withCreated) {
    var m = 0; if (!o || typeof o !== 'object') return 0;
    TS_FIELDS.concat(withCreated ? ['created', 'createdAt'] : []).forEach(function (f) { var n = Number(o[f]); if (isFinite(n) && n > m) m = n; });
    return m;
  }
  function pickRicher(a, b) {   // 同一筆的兩個版本：時間較新 → 欄位較多 → 內容較長 → 本機
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      var ta = tsOf(a), tb = tsOf(b);
      if (ta !== tb) return ta > tb ? a : b;
      var ka = Object.keys(a).length, kb = Object.keys(b).length;
      if (ka !== kb) return ka > kb ? a : b;
      var la = canon(a).length, lb = canon(b).length;
      if (la !== lb) return la > lb ? a : b;
    }
    return a;
  }
  function elemKey(x) {
    if (x && typeof x === 'object') {
      if (x.id != null && x.id !== '') return 'id:' + x.id;
      if (x.symbol != null && x.symbol !== '') return 'sym:' + x.symbol + '|' + (x.type || '');
      return 'h:' + hash(x);
    }
    return 'p:' + canon(x);
  }
  function smerge(a, b) {   // 結構合併：a＝本機、b＝遠端
    if (a === undefined) return b; if (b === undefined) return a;
    if (Array.isArray(a) && Array.isArray(b)) {
      var map = {}, order = [];
      a.forEach(function (x) { var k = elemKey(x); if (!(k in map)) { map[k] = x; order.push(k); } else map[k] = pickRicher(map[k], x); });
      b.forEach(function (x) { var k = elemKey(x); if (!(k in map)) { map[k] = x; order.push(k); } else map[k] = pickRicher(map[k], x); });
      var out = order.map(function (k) { return map[k]; });
      var tm = out.map(function (x) { return tsOf(x, true); });
      if (out.length && tm.every(function (t) { return t > 0; })) { var idx = out.map(function (_, i) { return i; }); idx.sort(function (i, j) { return tm[j] - tm[i] || i - j; }); out = idx.map(function (i) { return out[i]; }); }
      return out;
    }
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      var o = {}; Object.keys(a).concat(Object.keys(b)).forEach(function (k) {
        if (k in o) return;
        if (k in a && k in b) {
          var x = a[k], y = b[k];
          if (canon(x) === canon(y)) o[k] = x;
          else if (typeof x === 'number' && typeof y === 'number' && /(^at$|time|updated|^ts$|last|created)/i.test(k)) o[k] = Math.max(x, y);
          else if (x && y && typeof x === 'object' && typeof y === 'object') o[k] = smerge(x, y);
          else o[k] = x;   // 純量衝突：本機優先
        } else o[k] = (k in a) ? a[k] : b[k];
      });
      return o;
    }
    return a;
  }
  function bundleMerge(x, y) {   // 重複檔案合併：每項取 ts 較大者；墓碑取較大 ts；墓碑 ≥ 項目 ts 就丟掉項目
    var items = {}, del = {};
    [x, y].forEach(function (b) {
      Object.keys(b.items || {}).forEach(function (k) { var e = b.items[k]; if (!items[k] || (e.ts || 0) > (items[k].ts || 0)) items[k] = e; });
      Object.keys(b.deleted || {}).forEach(function (k) { del[k] = Math.max(del[k] || 0, b.deleted[k] || 0); });
    });
    Object.keys(del).forEach(function (k) { if (items[k] && del[k] >= (items[k].ts || 0)) delete items[k]; });
    return { v: 1, items: items, deleted: del, at: Date.now() };
  }

  /* ── 三方比對（純函式，傳入本機快照 L、遠端 bundle R、上次同步清單 base）── */
  function plan(L, R, base, o) {
    o = o || {};
    var now = o.now || Date.now(), mergeFn = o.merge || smerge;
    var items = R.items || {}, del = R.deleted || {};
    var keys = {}; Object.keys(L).concat(Object.keys(items), Object.keys(base)).forEach(function (k) { keys[k] = 1; });
    var hL = {}; Object.keys(L).forEach(function (k) { hL[k] = hash(L[k]); });
    var res = { newItems: {}, newDel: {}, applyPut: {}, applyDel: [], newBase: {}, stat: { pushed: 0, pulled: 0, merged: 0, delLocal: 0, delRemote: 0, same: 0 }, risk: { delLocal: [], delRemote: [] } };
    Object.keys(items).forEach(function (k) { res.newItems[k] = items[k]; });
    Object.keys(del).forEach(function (k) { if (now - del[k] < TOMB_KEEP_MS) res.newDel[k] = del[k]; });
    Object.keys(keys).forEach(function (k) {
      var inL = k in L, inR = k in items, b = base[k], l = hL[k], r = inR ? items[k].h : null;
      function push(v) { res.newItems[k] = { h: hash(v), ts: now, v: v }; delete res.newDel[k]; res.newBase[k] = hash(v); res.stat.pushed++; }
      function pull() { res.applyPut[k] = items[k].v; res.newBase[k] = items[k].h; res.stat.pulled++; }
      if (inL && inR) {
        if (l === r) { res.newBase[k] = l; res.stat.same++; }
        else if (b !== undefined && b === r) push(L[k]);
        else if (b !== undefined && b === l) pull();
        else {
          var m = mergeFn(k, L[k], items[k].v), hm = hash(m);
          res.stat.merged++;
          if (hm === l) push(m);
          else if (hm === r) pull();
          else { push(m); res.applyPut[k] = m; }
        }
      } else if (inL && !inR) {
        if (b !== undefined && del[k] && l === b) { res.risk.delLocal.push(k); }   // 遠端刪了、本機沒改 → 刪本機（待安全網決定）
        else push(L[k]);                                                          // 新的，或本機有改，或遠端檔被重置 → 推上去
      } else if (!inL && inR) {
        if (b !== undefined && r === b) { res.risk.delRemote.push(k); }           // 本機刪了、遠端沒改 → 刪遠端（待安全網決定）
        else pull();                                                              // 新的，或遠端有改 → 拉回來
      }
    });
    return res;
  }
  function applyRisk(res, nLocal, nRemote, o) {   // 安全網：大量刪除就不做
    o = o || {}; var now = o.now || Date.now(), skipped = 0;
    var dl = res.risk.delLocal, dr = res.risk.delRemote;
    var bigL = dl.length >= 10 && dl.length > nLocal / 2, bigR = dr.length >= 10 && dr.length > nRemote / 2;
    dl.forEach(function (k) { if (bigL) skipped++; else { res.applyDel.push(k); res.stat.delLocal++; } });
    dr.forEach(function (k) { if (bigR) skipped++; else { delete res.newItems[k]; res.newDel[k] = now; res.stat.delRemote++; } });
    res.skipped = skipped;
    return res;
  }

  /* ── 執行環境（手機版）── */
  function create(deps0) {
    var D = Object.assign({ drive: function () { return root.NovaGoogle && root.NovaGoogle._drive; }, storage: null, schedule: null, now: function () { return Date.now(); } }, deps0 || {});
    var providers = {}, inFlight = {}, deb = null;
    function st() { return D.storage || root.localStorage; }
    function lsGet(k, d) { try { var v = JSON.parse(st().getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
    function lsSet(k, v) { try { st().setItem(k, JSON.stringify(v)); } catch (e) { /* */ } }
    function init(deps) { Object.keys(deps || {}).forEach(function (k) { D[k] = deps[k]; }); }
    function register(p) { providers[p.id] = p; }
    function K(id) { return { on: 'nova_dsync_' + id + '_on', state: 'nova_dsync_' + id + '_state', fid: 'nova_dsync_' + id + '_fileid', info: 'nova_dsync_' + id + '_info' }; }
    function isEnabled(id) { return st().getItem(K(id).on) !== '0'; }
    function setEnabled(id, on) { try { st().setItem(K(id).on, on ? '1' : '0'); } catch (e) { /* */ } }
    function lastInfo(id) { return lsGet(K(id).info, null); }
    function drv() { var d = D.drive(); if (!d) throw new Error('尚未連線 Google（請先在「Google」設定頁登入並授權 Drive）'); return d; }
    function checkBundle(p, b) {
      if (!b || typeof b !== 'object' || typeof b.items !== 'object' || b.items === null) throw new Error('遠端的 ' + p.file + ' 格式不對，為避免覆蓋它，這次同步中止');
      return b;
    }
    async function ensureFileId(p) {
      var k = K(p.id), cached = st().getItem(k.fid) || '', d = drv(), files = await d.find(p.file);
      if (!files.length) { if (cached) st().removeItem(k.fid); return null; }
      if (files.length === 1) { if (files[0].id !== cached) st().setItem(k.fid, files[0].id); return files[0].id; }
      files.sort(function (a, b) { return new Date(a.modifiedTime) - new Date(b.modifiedTime); });
      var survivor = files[0].id, merged = null;
      for (var i = 0; i < files.length; i++) {
        try { var pb = await d.read(files[i].id, false); if (!pb) throw new Error('x'); checkBundle(p, pb); merged = merged ? bundleMerge(merged, pb) : pb; }
        catch (e) { throw new Error('偵測到重複的同步檔案 ' + p.file + '，但其中一份讀不到，為避免遺失資料先中止，請到 Google Drive 手動檢查'); }
      }
      await d.write(survivor, p.file, merged);
      for (var j = 0; j < files.length; j++) { if (files[j].id !== survivor) { try { await d.trash(files[j].id); } catch (e) { /* */ } } }
      st().setItem(k.fid, survivor); return survivor;
    }
    async function readRemote(p) {
      var id = await ensureFileId(p); if (!id) return null;
      var b = await drv().read(id, true);   // soft：404 回 null；空檔回 null；不合法 JSON 會丟錯
      if (b == null) { st().removeItem(K(p.id).fid); return null; }
      return checkBundle(p, b);
    }
    async function writeRemote(p, bundle) {
      var id = await ensureFileId(p), fid = await drv().write(id, p.file, bundle);
      if (fid) st().setItem(K(p.id).fid, fid);
    }
    async function sync(id, opts) {
      opts = opts || {}; var p = providers[id];
      if (!p) return { skipped: 'unknown' };
      if (!isEnabled(id)) return { skipped: 'disabled' };
      if (inFlight[id]) return { skipped: 'busy' };
      inFlight[id] = true;
      try {
        var L = await p.collect();
        var remote = await readRemote(p), R = remote || { items: {}, deleted: {} };
        var state = lsGet(K(id).state, { base: {} });
        var res = plan(L, R, state.base || {}, { now: D.now(), merge: p.merge });
        applyRisk(res, Object.keys(L).length, Object.keys(R.items || {}).length, { now: D.now() });
        var changedRemote = !remote || canon(res.newItems) !== canon(R.items || {}) || canon(res.newDel) !== canon(R.deleted || {});
        if (changedRemote) await writeRemote(p, { v: 1, items: res.newItems, deleted: res.newDel, at: D.now(), from: opts.device || 'android' });
        var nPut = Object.keys(res.applyPut).length;
        if (nPut || res.applyDel.length) await p.apply({ put: res.applyPut, del: res.applyDel });
        var nb = res.newBase;
        res.risk.delLocal.concat(res.risk.delRemote).forEach(function (k) {
          var done = (res.applyDel.indexOf(k) >= 0) || (res.newDel[k] && !(k in res.newItems));
          if (!done) nb[k] = (state.base || {})[k];
        });
        Object.keys(nb).forEach(function (k) { if (nb[k] === undefined) delete nb[k]; });
        lsSet(K(id).state, { base: nb, at: D.now() });
        var s = res.stat, out = { pushed: s.pushed, pulled: s.pulled, merged: s.merged, delLocal: s.delLocal, delRemote: s.delRemote, skippedDeletes: res.skipped || 0 };
        out.text = describe(out);
        lsSet(K(id).info, { at: D.now(), text: out.text });
        if (nPut || res.applyDel.length) { try { if (p.after) p.after(out); } catch (e) { /* */ } }
        return out;
      } finally { inFlight[id] = false; }
    }
    function describe(r) {
      var a = [];
      if (r.pulled) a.push('取回 ' + r.pulled + ' 項'); if (r.pushed) a.push('上傳 ' + r.pushed + ' 項'); if (r.merged) a.push('合併 ' + r.merged + ' 項');
      if (r.delLocal) a.push('本機刪除 ' + r.delLocal + ' 項'); if (r.delRemote) a.push('雲端刪除 ' + r.delRemote + ' 項');
      if (r.skippedDeletes) a.push('為安全起見略過 ' + r.skippedDeletes + ' 項刪除');
      return a.join('、') || '沒有變動';
    }
    async function syncAll(opts) {
      var out = {};
      for (var id in providers) { try { out[id] = await sync(id, opts); } catch (e) { out[id] = { error: (e && e.message) || String(e) }; } }
      return out;
    }
    function touch() { try { if (D.schedule) D.schedule(); } catch (e) { /* */ } }
    return { version: VERSION, init: init, register: register, isEnabled: isEnabled, setEnabled: setEnabled, touch: touch, sync: sync, syncAll: syncAll, lastInfo: lastInfo, describe: describe,
      providers: function () { return Object.keys(providers).map(function (k) { return { id: k, label: providers[k].label }; }); },
      _t: { canon: canon, hash: hash, smerge: smerge, plan: plan, applyRisk: applyRisk, pickRicher: pickRicher, bundleMerge: bundleMerge } };
  }
  var inst = create();
  inst.create = create;
  /* ── 手機版接線：provider（研發／Insight）與觸發時機。僅瀏覽器環境執行 ── */
  if (typeof root.addEventListener === 'function' && root.document) {
    inst.register({
      id: 'research', label: 'NovaResearch', file: 'NOVA_Research_Sync.json',
      merge: function (k, a, b) { return inst._t.pickRicher(a, b); },
      collect: async function () {
        var C = root.NovaResearchCore; if (!C) throw new Error('NovaResearch 引擎沒有載入');
        var d = await C.store.dump(), L = {};
        Object.keys(d).forEach(function (kind) { (d[kind] || []).forEach(function (it) { if (it && it.id) L[kind + '/' + it.id] = it; }); });
        return L;
      },
      apply: async function (a) {
        var puts = [], dels = [];
        Object.keys(a.put || {}).forEach(function (k) { var i = k.indexOf('/'); puts.push({ kind: k.slice(0, i), data: a.put[k] }); });
        (a.del || []).forEach(function (k) { var i = k.indexOf('/'); dels.push({ kind: k.slice(0, i), id: k.slice(i + 1) }); });
        await root.NovaResearchCore.store.apply(puts, dels);
      },
      after: function () { try { root.dispatchEvent(new root.CustomEvent('nova-research-synced')); } catch (e) { /* */ } }
    });
    /* Insight 同步鍵＝手機認得的鍵 ∪ 桌面傳來但手機沒有介面的鍵（記在 nova_insight_extra_keys，否則下次同步會被當成「手機刪了」而回寫刪除桌面資料） */
    function insKnown() { return (root.NovaInsightCore && root.NovaInsightCore.syncKeys) || (root.NovaInsight && root.NovaInsight.syncKeys) || []; }
    function insExtra() { try { var x = JSON.parse(root.localStorage.getItem('nova_insight_extra_keys') || '[]'); return Array.isArray(x) ? x.filter(function (k) { return typeof k === 'string' && /^nova_insight_/.test(k); }) : []; } catch (e) { return []; } }
    function insKeys() { var k = insKnown().slice(); insExtra().forEach(function (x) { if (k.indexOf(x) < 0) k.push(x); }); return k; }
    inst.register({
      id: 'insight', label: 'Project Insight', file: 'NOVA_Insight_Sync.json',
      collect: async function () {
        var L = {}; insKeys().forEach(function (k) { var raw = root.localStorage.getItem(k); if (raw == null) return; try { L[k] = JSON.parse(raw); } catch (e) { /* 壞掉的不同步 */ } });
        return L;
      },
      apply: async function (a) {
        var ex = insExtra(), known = insKnown();
        Object.keys(a.put || {}).forEach(function (k) { try { root.localStorage.setItem(k, JSON.stringify(a.put[k])); if (known.indexOf(k) < 0 && ex.indexOf(k) < 0) ex.push(k); } catch (e) { /* */ } });
        (a.del || []).forEach(function (k) { try { root.localStorage.removeItem(k); } catch (e) { /* */ } });
        try { root.localStorage.setItem('nova_insight_extra_keys', JSON.stringify(ex.filter(function (k) { return root.localStorage.getItem(k) != null; }))); } catch (e) { /* */ }
      },
      after: function () { try { root.dispatchEvent(new root.CustomEvent('nova-insight-synced')); } catch (e) { /* */ } }
    });
    var timer = null, running = false;
    function connected() { return !!(root.NovaGoogle && root.NovaGoogle.isConnected && root.NovaGoogle.isConnected() && root.NovaGoogle._drive); }
    async function run(manual) {
      if (running) return null; if (!connected()) { if (manual) throw new Error('尚未連線 Google'); return null; }
      running = true;
      try {
        var out = await inst.syncAll({ device: 'android' });
        try { root.dispatchEvent(new root.CustomEvent('nova-dsync-done', { detail: out })); } catch (e) { /* */ }
        return out;
      } finally { running = false; }
    }
    inst.run = run;
    inst.schedule = function () { if (!connected()) return; clearTimeout(timer); timer = setTimeout(function () { run(false).catch(function () { /* */ }); }, 4000); };
    inst.init({ schedule: inst.schedule });
    root.addEventListener('nova-research-changed', inst.schedule);
    root.addEventListener('nova-insight-changed', inst.schedule);
    root.document.addEventListener('visibilitychange', function () { if (root.document.visibilityState === 'visible') inst.schedule(); });
    setTimeout(inst.schedule, 8000);   // App 啟動後同步一次
  }
  root.NovaDataSync = inst;
  if (typeof module !== 'undefined' && module.exports) module.exports = inst;
})(typeof window !== 'undefined' ? window : globalThis);

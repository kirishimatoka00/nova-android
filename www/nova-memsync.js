/* nova-memsync.js — v1.0.0 (2026-10-11)
 * 手機版「AI 記憶」跨裝置同步：與桌面版 nova-memory-sync.js v1.0.0 使用同一個 Drive 檔案 NOVA_Memory_Sync.json、同一份格式與同一套合併規則，
 *   讓桌面（sidecar SQLite）與手機（IndexedDB nova_memory_db）的記憶互通。
 * 格式對應（桌面 snake_case ↔ 手機 camelCase）：
 *   episodic：id／session_id↔sessionId／summary／topic／entities／vector／created_at↔createdAt／source_range↔sourceRange
 *   core    ：entity／fact／hit_count↔hitCount／last_updated↔lastUpdated／page_md↔pageMd／source_refs↔sourceRefs（向量不同步，收到端自己重算）
 *   entity_freq：entity／count_30d↔count30d／last_seen↔lastSeen
 * 合併：對話摘要依 id 聯集；長期事實 last_updated 較新者贏（兩邊都改過且內容不同時，輸的那份先存成筆記備份）；實體統計取 last_seen 較新者。
 * 刪除：墓碑存 localStorage nova_mem_tombstones（與桌面同名同格式，保留 365 天）、清空全部記憶存 nova_mem_cleared_at。
 * 安全網：遠端讀不到／不合法就中止不覆蓋；本機將被刪 ≥ 一半（且 ≥10 筆）時，手動同步先問、自動同步略過刪除。
 * 依賴：NovaGoogle._drive（Drive 讀寫）、NovaMemory._open/_getAll/_put/_del、novaKbEmbedDocumentBatch（算長期事實向量，缺 Gemini Key 則記下來之後補）。
 * 對外：window.NovaMemSync
 * 版本紀錄
 *   v1.0.0 2026-10-11  首版。誠實聲明：只在沙盒用模擬的 Drive 與桌面格式資料驗證合併／套用邏輯，沒有與真實桌面版互相同步過，需實機兩端測試
 */
(function () {
  'use strict';
  var W = window, LS = W.localStorage;
  var FILENAME = 'NOVA_Memory_Sync.json', DAY = 86400000, TOMB_KEEP = 365 * DAY;
  var K = { enabled: 'nova_mem_sync_enabled', tomb: 'nova_mem_tombstones', cleared: 'nova_mem_cleared_at', fileId: 'nova_mem_sync_file_id', last: 'nova_mem_sync_last_at', needVec: 'nova_mem_sync_need_vec', lastInfo: 'nova_mem_sync_last_info' };
  var inFlight = false;

  function num(x) { x = Number(x); return isFinite(x) ? x : 0; }
  function lsGet(k, d) { try { var v = JSON.parse(LS.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { LS.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function quantize(v) { if (!Array.isArray(v)) return []; var o = new Array(v.length); for (var i = 0; i < v.length; i++) o[i] = Math.round(v[i] * 1e4) / 1e4; return o; }
  function emptyBundle() { return { version: 1, episodic: [], core: [], entity_freq: [], tombstones: {}, clearedAt: 0 }; }
  function contentKey(c) { return String(c.page_md || '') + '\u0001' + String(c.fact || ''); }
  function normalize(b) {
    b = b || {}; var o = emptyBundle();
    (Array.isArray(b.episodic) ? b.episodic : []).forEach(function (e) { if (!e || e.id == null) return; o.episodic.push({ id: String(e.id), session_id: e.session_id || '', summary: e.summary || '', topic: e.topic || '', entities: Array.isArray(e.entities) ? e.entities : [], vector: quantize(e.vector), created_at: num(e.created_at), source_range: e.source_range || '' }); });
    (Array.isArray(b.core) ? b.core : []).forEach(function (c) { if (!c || !c.entity) return; o.core.push({ entity: String(c.entity), fact: c.fact || '', hit_count: num(c.hit_count) || 1, last_updated: num(c.last_updated), page_md: c.page_md || '', source_refs: Array.isArray(c.source_refs) ? c.source_refs : [] }); });
    (Array.isArray(b.entity_freq) ? b.entity_freq : []).forEach(function (f) { if (!f || !f.entity) return; o.entity_freq.push({ entity: String(f.entity), count_30d: num(f.count_30d), last_seen: num(f.last_seen) }); });
    if (b.tombstones && typeof b.tombstones === 'object') Object.keys(b.tombstones).forEach(function (k) { var t = num(b.tombstones[k]); if (t) o.tombstones[k] = t; });
    o.clearedAt = num(b.clearedAt);
    var cmp = function (k) { return function (x, y) { return x[k] < y[k] ? -1 : x[k] > y[k] ? 1 : 0; }; };
    o.episodic.sort(cmp('id')); o.core.sort(cmp('entity')); o.entity_freq.sort(cmp('entity'));
    return o;
  }
  function sigOf(b) { return JSON.stringify(normalize(b)); }

  /* 與桌面版 mergeBundles 同一套規則（a＝本機，b＝遠端） */
  function mergeBundles(a, b, o) {
    o = o || {}; var now = o.now || Date.now(), lastSync = num(o.lastSync);
    a = normalize(a); b = normalize(b);
    var tomb = {};
    [a.tombstones, b.tombstones].forEach(function (t) { Object.keys(t).forEach(function (k) { if (!tomb[k] || t[k] > tomb[k]) tomb[k] = t[k]; }); });
    Object.keys(tomb).forEach(function (k) { if (now - tomb[k] > TOMB_KEEP) delete tomb[k]; });
    var cleared = Math.min(Math.max(a.clearedAt, b.clearedAt), now);
    var epMap = {};
    a.episodic.concat(b.episodic).forEach(function (e) { var ex = epMap[e.id]; if (!ex || (!ex.vector.length && e.vector.length)) epMap[e.id] = e; });
    var episodic = Object.keys(epMap).map(function (k) { return epMap[k]; }).filter(function (e) { var d = tomb['e:' + e.id]; if (d && d >= e.created_at) return false; if (e.created_at <= cleared) return false; return true; });
    var conflicts = [], coreMap = {};
    a.core.forEach(function (c) { coreMap[c.entity] = c; });
    b.core.forEach(function (r) {
      var l = coreMap[r.entity]; if (!l) { coreMap[r.entity] = r; return; }
      if (l.last_updated === r.last_updated && contentKey(l) === contentKey(r)) return;
      var winner, loser, side;
      if (r.last_updated > l.last_updated) { winner = r; loser = l; side = 'local'; }
      else if (r.last_updated < l.last_updated) { winner = l; loser = r; side = 'remote'; }
      else if (contentKey(r) > contentKey(l)) { winner = r; loser = l; side = 'local'; }
      else { winner = l; loser = r; side = 'remote'; }
      var bothChanged = !lastSync || (l.last_updated > lastSync && r.last_updated > lastSync);
      if (contentKey(l) !== contentKey(r) && bothChanged) conflicts.push({ entity: r.entity, side: side, loser: loser, winner: winner });
      coreMap[r.entity] = winner;
    });
    var core = Object.keys(coreMap).map(function (k) { return coreMap[k]; }).filter(function (c) { var d = tomb['c:' + c.entity]; if (d && d >= c.last_updated) return false; if (c.last_updated <= cleared) return false; return true; });
    var frMap = {};
    a.entity_freq.concat(b.entity_freq).forEach(function (f) { var ex = frMap[f.entity]; if (!ex || f.last_seen > ex.last_seen || (f.last_seen === ex.last_seen && f.count_30d > ex.count_30d)) frMap[f.entity] = f; });
    var entity_freq = Object.keys(frMap).map(function (k) { return frMap[k]; }).filter(function (f) { return f.last_seen > cleared; });
    return { bundle: normalize({ version: 1, episodic: episodic, core: core, entity_freq: entity_freq, tombstones: tomb, clearedAt: cleared }), conflicts: conflicts };
  }

  /* ───────── 本機（IndexedDB nova_memory_db）↔ 同步格式 ───────── */
  function M() { return W.NovaMemory; }
  async function collectLocal() {
    var r = await Promise.all([M()._getAll('episodic'), M()._getAll('core'), M()._getAll('entity_freq')]);
    return normalize({
      episodic: r[0].map(function (e) { return { id: e.id, session_id: e.sessionId, summary: e.summary, topic: e.topic, entities: e.entities, vector: e.vector, created_at: e.createdAt, source_range: e.sourceRange }; }),
      core: r[1].map(function (c) { return { entity: c.entity, fact: c.fact, hit_count: c.hitCount, last_updated: c.lastUpdated, page_md: c.pageMd, source_refs: c.sourceRefs }; }),
      entity_freq: r[2].map(function (f) { return { entity: f.entity, count_30d: f.count30d, last_seen: f.lastSeen }; }),
      tombstones: lsGet(K.tomb, {}), clearedAt: num(lsGet(K.cleared, 0))
    });
  }
  async function embedCore(entity, fact) {
    try { if (typeof W.novaKbEmbedDocumentBatch !== 'function' || !(W.appState && appState.keys && appState.keys.gemini)) return null; var v = await W.novaKbEmbedDocumentBatch(['task: search result | title: ' + entity + ' | text: ' + fact]); return (v && v[0] && v[0].length) ? v[0] : null; } catch (e) { return null; }
  }
  async function pool(tasks, limit) {
    var errors = 0, i = 0;
    async function worker() { while (i < tasks.length) { var t = tasks[i++]; try { await t(); } catch (e) { errors++; console.warn('[NOVA][記憶同步] 單筆套用失敗：', e && e.message || e); } } }
    var ws = []; for (var w = 0; w < Math.min(limit, tasks.length); w++) ws.push(worker()); await Promise.all(ws); return errors;
  }
  async function applyMerged(local, merged, opts) {
    var res = { epAdded: 0, epRemoved: 0, coreUpdated: 0, coreRemoved: 0, freqUpdated: 0, vecPending: 0, errors: 0, deletionsSkipped: 0 };
    var localEp = {}, mergedEp = {}, localCore = {}, mergedCore = {}, localFr = {};
    local.episodic.forEach(function (e) { localEp[e.id] = e; }); merged.episodic.forEach(function (e) { mergedEp[e.id] = e; });
    local.core.forEach(function (c) { localCore[c.entity] = c; }); merged.core.forEach(function (c) { mergedCore[c.entity] = c; });
    local.entity_freq.forEach(function (f) { localFr[f.entity] = f; });
    var delEp = local.episodic.filter(function (e) { return !mergedEp[e.id]; });
    var delCore = local.core.filter(function (c) { return !mergedCore[c.entity]; });
    var total = local.episodic.length + local.core.length, removals = delEp.length + delCore.length;
    if (total >= 10 && removals >= total / 2) {
      var ok = false;
      if (opts.interactive && W.showConfirm) ok = await W.showConfirm('這次同步會從這支手機刪除 ' + removals + ' 筆記憶（共 ' + total + ' 筆）——通常是另一台裝置「清空全部記憶」或大量刪除所造成。\n\n確定要刪除嗎？（選「取消」會保留手機上的記憶，只做新增與更新）');
      if (!ok) { res.deletionsSkipped = removals; delEp = []; delCore = []; }
    }
    var needVec = lsGet(K.needVec, []).filter(function (e) { return mergedCore[e]; }), needVecSet = {}; needVec.forEach(function (e) { needVecSet[e] = true; });
    var tasks = [];
    merged.episodic.forEach(function (e) {
      var l = localEp[e.id]; if (l && (l.vector.length || !e.vector.length)) return;
      tasks.push(async function () { await M()._put('episodic', { id: e.id, sessionId: e.session_id, summary: e.summary, topic: e.topic, entities: e.entities, vector: e.vector, createdAt: e.created_at, sourceRange: e.source_range }); res.epAdded++; });
    });
    delEp.forEach(function (e) { tasks.push(async function () { await M()._del('episodic', e.id); res.epRemoved++; }); });
    merged.core.forEach(function (c) {
      var l = localCore[c.entity], same = l && l.last_updated === c.last_updated && contentKey(l) === contentKey(c);
      if (same && !needVecSet[c.entity]) return;
      tasks.push(async function () {
        var cur = await M()._getOne('core', c.entity);
        if (cur && num(cur.lastUpdated) > c.last_updated) return;   // 同步期間手機剛改過：不覆蓋，下次再處理
        var out = (cur && same) ? { entity: cur.entity, fact: cur.fact, hit_count: cur.hitCount, last_updated: cur.lastUpdated, page_md: cur.pageMd, source_refs: cur.sourceRefs } : c;
        var vec = await embedCore(out.entity, out.fact);
        await M()._put('core', { entity: out.entity, fact: out.fact, hitCount: out.hit_count || 1, lastUpdated: out.last_updated, vector: vec || (cur && cur.vector) || [], pageMd: out.page_md || '', sourceRefs: out.source_refs || [] });
        if (vec) delete needVecSet[c.entity]; else needVecSet[c.entity] = true;
        if (!same) res.coreUpdated++;
      });
    });
    delCore.forEach(function (c) { tasks.push(async function () { var cur = await M()._getOne('core', c.entity); if (cur && num(cur.lastUpdated) > c.last_updated) return; await M()._del('core', c.entity); res.coreRemoved++; delete needVecSet[c.entity]; }); });
    merged.entity_freq.forEach(function (f) { var l = localFr[f.entity]; if (l && l.last_seen === f.last_seen && l.count_30d === f.count_30d) return; tasks.push(async function () { await M()._put('entity_freq', { entity: f.entity, count30d: f.count_30d, lastSeen: f.last_seen }); res.freqUpdated++; }); });
    res.errors = await pool(tasks, 3);
    var still = Object.keys(needVecSet).filter(function (e) { return mergedCore[e]; }); lsSet(K.needVec, still); res.vecPending = still.length;
    return res;
  }

  /* ───────── Drive ───────── */
  function D() { return W.NovaGoogle && W.NovaGoogle._drive; }
  async function ensureFileId() {
    var cached = LS.getItem(K.fileId) || '', files = await D().find(FILENAME);
    if (!files.length) { if (cached) LS.removeItem(K.fileId); return null; }
    if (files.length === 1) { LS.setItem(K.fileId, files[0].id); return files[0].id; }
    var survivor = files[0].id, merged = null;   // find() 依修改時間由舊到新
    for (var i = 0; i < files.length; i++) { try { var p = await D().read(files[i].id); merged = merged ? mergeBundles(merged, p, { now: Date.now(), lastSync: 0 }).bundle : normalize(p); } catch (e) { throw new Error('偵測到重複的記憶同步檔案，但其中一份讀不到，為避免遺失資料先中止，請到 Google Drive 手動檢查 ' + FILENAME); } }
    if (merged) await D().write(survivor, FILENAME, merged);
    for (var j = 1; j < files.length; j++) { try { await D().trash(files[j].id); } catch (e) {} }
    LS.setItem(K.fileId, survivor); return survivor;
  }

  function isEnabled() { return LS.getItem(K.enabled) !== '0'; }
  function setEnabled(on) { try { LS.setItem(K.enabled, on ? '1' : '0'); } catch (e) {} }
  function touch() { try { if (W.NovaGoogle && W.NovaGoogle.schedule) W.NovaGoogle.schedule(); } catch (e) {} }
  function markEpisodicDeleted(id) { var t = lsGet(K.tomb, {}); t['e:' + id] = Date.now(); lsSet(K.tomb, t); touch(); }
  function markCoreDeleted(entity) { var t = lsGet(K.tomb, {}); t['c:' + entity] = Date.now(); lsSet(K.tomb, t); touch(); }
  function markClearedAll() { lsSet(K.cleared, Date.now()); lsSet(K.tomb, {}); lsSet(K.needVec, []); touch(); }
  function prune(t, now) { var o = {}; Object.keys(t || {}).forEach(function (k) { if (now - t[k] <= TOMB_KEEP) o[k] = t[k]; }); return o; }

  function describe(r) {
    if (!r || r.skipped) return '';
    var p = [], d = [];
    if (r.epAdded) d.push('對話摘要 ' + r.epAdded); if (r.coreUpdated) d.push('長期事實 ' + r.coreUpdated); if (d.length) p.push('↓ 收到 ' + d.join('、'));
    var u = []; if (r.pushed && r.pushed.episodic) u.push('對話摘要 ' + r.pushed.episodic); if (r.pushed && r.pushed.core) u.push('長期事實 ' + r.pushed.core); if (u.length) p.push('↑ 上傳 ' + u.join('、'));
    if (r.epRemoved || r.coreRemoved) p.push('刪除 ' + (r.epRemoved + r.coreRemoved) + ' 筆');
    if (r.conflicts) p.push('⚠️ ' + r.conflicts + ' 筆長期事實兩邊都改過，採用較新者，被覆蓋的版本已存成筆記');
    if (r.vecPending) p.push(r.vecPending + ' 筆長期事實向量待補（需 Gemini Key，下次同步再試）');
    if (r.deletionsSkipped) p.push('略過刪除 ' + r.deletionsSkipped + ' 筆（需手動同步確認）');
    if (r.errors) p.push(r.errors + ' 筆套用失敗');
    return p.length ? p.join('；') : '沒有變動';
  }

  async function saveConflictNote(c, loserFrom) {
    try {
      var note = { id: Date.now() + Math.floor(Math.random() * 1000), title: '記憶衝突備份：' + c.entity, content: '這是同步時被較新版本覆蓋的「' + (loserFrom === 'local' ? '這支手機' : '另一台裝置') + '」的版本（最後更新 ' + new Date(c.loser.last_updated).toLocaleString() + '）。要救回請到「設定 → 記憶 → 長期事實」手動編輯。\n\n## 一句話事實\n' + (c.loser.fact || '') + '\n\n## 完整頁面\n' + (c.loser.page_md || '（舊格式，沒有完整頁面）'), isHtml: false, date: new Date().toLocaleString(), type: 'text', images: [], folder: '未分類' };
      appState.notes.unshift(note); W.saveToDB('notes', note); try { W.renderNotes(); } catch (e) {}
      return true;
    } catch (e) { return false; }
  }

  /* opts: {interactive:boolean} */
  async function sync(opts) {
    opts = opts || {};
    if (!isEnabled()) return { skipped: 'disabled' };
    if (!W.NovaMemory || !M()._getAll || !D()) return { skipped: 'unavailable' };
    if (inFlight) return { skipped: 'busy' };
    inFlight = true; var t0 = Date.now();
    try {
      var local = await collectLocal();
      var id = await ensureFileId(), remote = null;
      if (id) { var raw = await D().read(id, true); if (raw != null) remote = normalize(raw); }
      var m = mergeBundles(local, remote || emptyBundle(), { now: t0, lastSync: num(lsGet(K.last, 0)) }), merged = m.bundle, pushed = { episodic: 0, core: 0 };
      if (remote) {
        var rEp = {}, rCore = {}; remote.episodic.forEach(function (e) { rEp[e.id] = 1; }); remote.core.forEach(function (c) { rCore[c.entity] = c; });
        pushed.episodic = merged.episodic.filter(function (e) { return !rEp[e.id]; }).length;
        pushed.core = merged.core.filter(function (c) { var r = rCore[c.entity]; return !r || r.last_updated !== c.last_updated || contentKey(r) !== contentKey(c); }).length;
      } else { pushed.episodic = merged.episodic.length; pushed.core = merged.core.length; }
      if (!remote || sigOf(merged) !== sigOf(remote)) { var fid = await D().write(id, FILENAME, merged); if (fid) LS.setItem(K.fileId, fid); }
      var saved = 0; for (var i = 0; i < m.conflicts.length; i++) { if (await saveConflictNote(m.conflicts[i], m.conflicts[i].side)) saved++; }
      lsSet(K.tomb, prune(merged.tombstones, t0)); if (merged.clearedAt) lsSet(K.cleared, merged.clearedAt);
      var applied = await applyMerged(local, merged, opts);
      applied.conflicts = m.conflicts.length; applied.conflictsSaved = saved; applied.pushed = pushed;
      if (!applied.errors) lsSet(K.last, t0);
      lsSet(K.lastInfo, { at: Date.now(), text: describe(applied) });
      if (applied.epAdded || applied.coreUpdated || applied.epRemoved || applied.coreRemoved) { try { W.dispatchEvent(new Event('nova-memory-refresh')); } catch (e) {} }
      return applied;
    } finally { inFlight = false; }
  }

  W.NovaMemSync = { version: '1.0.0', isEnabled: isEnabled, setEnabled: setEnabled, sync: sync, describe: describe, touch: touch, markEpisodicDeleted: markEpisodicDeleted, markCoreDeleted: markCoreDeleted, markClearedAll: markClearedAll, lastInfo: function () { return lsGet(K.lastInfo, null); },
    mergeBundles: mergeBundles, normalize: normalize };
  try { W.addEventListener('nova-memory-changed', touch); } catch (e) {}
})();

/* nova-brain-graph.js — v1.1.0 (2026-10-11)
 * 手機版「AI 大腦圖譜」：把筆記、向量庫文件、長期記憶實體、技能放在同一張 2D 力導向圖裡（Canvas，單指拖曳、雙指縮放、點節點看詳情）。
 * 對標桌面 v3.34.0 的規格自行實作（桌面的 nova-brain-graph.js 原始碼不在可讀來源內，所以這是依規格重寫，不是逐行移植）。
 *   節點：筆記 / 向量庫文件 / 記憶實體（core）/ 技能。（桌面的「檔案卡」手機版沒有這個功能，所以沒有；episodic 預設不畫。）
 *   連線：筆記的雙向連結 note.links、內文 [[標題]] 交叉引用、筆記→其向量庫文件、記憶實體→提到它的筆記、語意相似（餘弦 ≥0.65，每點取前 3，節點>500 時略過）。
 *   亮度：近 30 天被開啟/使用的次數（localStorage nova_brain_hits），越常用越亮。
 *   外圈：紅圈＝孤立（沒有任何連線）；黃圈＝筆記還沒匯入向量庫（AI 檢索不到）。
 * 版本紀錄
 *   v1.1.0 2026-10-11  新增 3D 模式（預設 3D，可切回 2D；無 WebGL 時自動 2D），共用 vendor/nova-graph3d.js
 *   v1.0.0 2026-10-11  首版。
 */
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
      var w = function (id) { try { recordHit('n:' + id); } catch (e) {} return o.apply(this, arguments); };
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


  /* v1.1.0：3D 模式（vendor/nova-graph3d.js；預設 3D，可切回 2D；無 WebGL 時自動用 2D） */
  function use3D() { try { return localStorage.getItem('nova_brain_3d') !== '0'; } catch (e) { return true; } }
  function webglOk() { try { var c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { return false; } }
  async function ensure3D() {
    if (W.NovaGraph3D) return true;
    await new Promise(function (res, rej) { var sc = document.createElement('script'); sc.src = './vendor/nova-graph3d.js?v=1'; sc.onload = res; sc.onerror = function () { rej(new Error('3D 模組載入失敗')); }; document.head.appendChild(sc); });
    return !!W.NovaGraph3D;
  }
  var G3 = null;
  function render3D(box, g) {
    box.innerHTML = '';
    var FG = W.NovaGraph3D.ForceGraph3D, ST = W.NovaGraph3D.SpriteText;
    var byId = {}; g.nodes.forEach(function (n) { byId[n.id] = n; });
    var gw = function () { return box.clientWidth || W.innerWidth; }, gh = function () { return box.clientHeight || Math.max(300, W.innerHeight - 170); };
    var links = g.edges.filter(function (e) { return byId[e.a] && byId[e.b]; }).map(function (e) { return { source: e.a, target: e.b, kind: e.kind }; });
    var nodes = g.nodes.map(function (n) { return { id: n.id, name: n.label, kind: n.kind, val: 1 + (n.deg || 0) * 0.8 + (n.heat || 0) * 3, color: KIND[n.kind].c, ref: n }; });
    if (G3 && G3._destructor) { try { G3._destructor(); } catch (e) {} }
    G3 = FG()(box).width(gw()).height(gh()).backgroundColor('#020617').graphData({ nodes: nodes, links: links })
      .nodeLabel(function (n) { return KIND[n.kind].t + '：' + n.name; }).nodeColor('color').nodeVal('val')
      .linkColor(function (l) { return l.kind === 'sim' ? 'rgba(148,163,184,0.35)' : 'rgba(226,232,240,0.7)'; }).linkWidth(function (l) { return l.kind === 'sim' ? 0.4 : 1.1; })
      .nodeThreeObjectExtend(true).nodeThreeObject(function (n) { if (typeof ST !== 'function') return false; var t = new ST(String(n.name).slice(0, 14)); t.textHeight = 2; t.color = '#e2e8f0'; t.backgroundColor = 'rgba(2,6,23,0.6)'; t.padding = 0.8; t.position.y = 7; return t; })
      .onNodeClick(function (n) { S = S || {}; info(n.ref); });
    try { if (W.ResizeObserver) { if (W._bgRO) W._bgRO.disconnect(); W._bgRO = new ResizeObserver(function () { try { G3.width(gw()).height(gh()); } catch (e) {} }); W._bgRO.observe(box); } } catch (e) {}
    setTimeout(function () { try { G3.width(gw()).height(gh()); } catch (e) {} }, 300);
  }
  W.novaBrainToggle3D = function () { try { localStorage.setItem('nova_brain_3d', use3D() ? '0' : '1'); } catch (e) {} W.openBrainGraph(); };

  W.openBrainGraph = async function () {
    var m = document.getElementById('brain-graph-modal'), box = document.getElementById('brain-graph-container');
    if (!m || !box) return;
    m.classList.remove('hidden'); m.classList.add('flex');
    box.innerHTML = '<div style="color:#94a3b8;padding:16px;font-size:13px;">載入圖譜中…</div>';
    var g;
    try { g = await collect(); } catch (e) { box.innerHTML = '<div style="color:#f87171;padding:16px;">圖譜資料讀取失敗：' + (e.message || e) + '</div>'; return; }
    if (!g.nodes.length) { box.innerHTML = '<div style="color:#94a3b8;padding:24px;text-align:center;">還沒有任何筆記、向量庫文件、記憶或技能可以畫成圖。</div>'; return; }
    var want3D = use3D() && webglOk(), ok3D = false;
    if (want3D) { try { if (await ensure3D()) { render3D(box, g); ok3D = true; } } catch (e) { console.warn('[NOVA] 腦圖 3D 失敗，改 2D：', e); } }
    if (!ok3D) renderInto(box, g);
    var cnt = {}; g.nodes.forEach(function (n) { cnt[n.kind] = (cnt[n.kind] || 0) + 1; });
    var lg = document.getElementById('brain-graph-legend');
    if (lg) lg.innerHTML = Object.keys(KIND).map(function (k) { return '<span style="display:inline-flex;align-items:center;gap:4px;"><i style="width:9px;height:9px;border-radius:50%;background:' + KIND[k].c + ';display:inline-block"></i>' + KIND[k].t + ' ' + (cnt[k] || 0) + '</span>'; }).join('') +
      '<span style="color:#facc15">◯ 筆記未匯入向量庫</span><span style="color:#f87171">◯ 孤立</span><span style="color:#94a3b8">' + (ok3D ? '淡線＝語意相似' : '虛線＝語意相似') + '</span>' +
      '<button onclick="novaBrainToggle3D()" style="margin-left:auto;padding:2px 10px;border-radius:8px;background:#334155;color:#e2e8f0;">' + (ok3D ? '切到 2D' : (webglOk() ? '切到 3D' : '（此裝置無 3D）')) + '</button>';
    info(null); if (!ok3D) draw();
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
    S = null;
  };
  W._novaBrainCollect = collect; // 供測試
})();

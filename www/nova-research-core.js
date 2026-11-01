/* nova-research-core.js — v1.1.1 (2026-11-01)
 * NovaResearch（研發情報 × 實驗系統）手機版「引擎層」：把桌面 python-engine/nova_research.py v1.1.0 的功能改成純 JS，
 * 在手機 WebView 內執行，不需要 sidecar。介面在 nova-research-ui.js。
 * 對應關係（桌面 → 手機）：
 *   儲存      store_get／put／delete／list／dump／apply  → Capacitor Filesystem「Documents/NOVA_Research/<種類>/<id>.json」（與桌面同結構；覆寫前留 .bak、刪除移到 _deleted／）
 *   文獻來源  OpenAlex／Semantic Scholar／Crossref／PubMed／arXiv ＋ 專利 Lens／EPO OPS／PatentsView → fetch（CapacitorHttp 已啟用，不受跨網域限制）
 *   PubChem   resolve（同義詞／CAS／SMILES）與 GHS
 *   監看      watch_run＋排程（App 開著時每 5 分鐘檢查到期的監看；桌面是引擎背景執行緒，手機沒有等價物）
 *   計算      make_doe（拉丁超立方／全因子／面心 CCD）、desirability、純 JS 高斯過程＋期望改善量（optimize）、色差 CIEDE2000、受限物質快篩、內建種子清單
 * 不做：RDKit 分子描述符（手機沒有）、scikit-learn 路徑（只用桌面也有的純程式高斯過程）。
 * 金鑰：localStorage nova_research_keys（Lens／EPO／PatentsView／S2／NCBI／聯絡信箱），刻意不同步、不進 Drive。
 * 事件：資料新增／修改／刪除時發 nova-research-changed（nova-datasync.js 用來觸發同步）；同步套用後由 nova-datasync.js 發 nova-research-synced。
 * 版本紀錄
 *   v1.1.1 2026-11-01  v1.1.0 仍失敗的真正原因：能在「文件」建新檔（探測成功），但資料夾裡已有、不是本 App 建立的同名檔（桌面專案 id）沒有權限覆寫（EACCES）。
 *                      改成逐筆退路：寫入失敗的那一筆改存 App 私有資料夾；刪除時文件裡刪不掉的用墓碑（localStorage nova_research_tomb）擋掉，之後同 id 再寫入就解除。
 *   v1.1.0 2026-11-01  修「同步失敗：writeFile EACCES」：沒有「所有檔案存取」權限時 Documents 不能寫。儲存層啟動時先試寫 Documents，失敗就請求權限、仍失敗改存 App 私有資料夾（DATA），
 *                      讀取時兩處合併（同 id 取 updated 較新），刪除兩處都清；store.dir() 回報目前位置。
 *   v1.0.0 2026-11-01  首版，對標桌面 nova_research.py v1.1.0。純函式（色差、desirability、DoE、高斯過程、最佳化、解析器）在 Node 用桌面的 Python 模組逐項對照過數值；
 *                      網路來源的實際連線沒有驗證（桌面版同樣未驗證），Filesystem 儲存只用記憶體替身測過。【未在真機驗證】
 */
(function (root) {
  'use strict';
  var VERSION = '1.0.0';
  var KINDS = ['project', 'material', 'experiment', 'landscape', 'watch', 'report', 'note'];
  var WATCH_LOCAL = ['seen', 'inbox', 'last_run'];
  var ROOT = 'NOVA_Research';
  var KEY_FIELDS = ['lens_token', 'epo_key', 'epo_secret', 'patentsview_key', 's2_key', 'contact_email', 'ncbi_key'];
  var LS = (function () { try { return root.localStorage; } catch (e) { return null; } })();

  /* ───────── 小工具 ───────── */
  function now() { return Date.now(); }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function safeId(s) { return String(s == null ? '' : s).replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 64); }
  function newId(kind) { return kind.slice(0, 3) + now().toString(16) + Math.floor(Math.random() * 46656).toString(16); }
  function emit(name) { try { if (root.dispatchEvent && root.CustomEvent) root.dispatchEvent(new root.CustomEvent(name)); } catch (e) { /* */ } }
  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function rnd4(v) { return Math.round(Number(v) * 1e4) / 1e4; }
  function round(v, n) { var m = Math.pow(10, n); return Math.round(v * m) / m; }

  /* ───────── 儲存 ───────── */
  var adapter = null, cache = {}, loaded = {};
  function capFS() { try { return root.Capacitor && root.Capacitor.Plugins && root.Capacitor.Plugins.Filesystem; } catch (e) { return null; } }
  function fsAdapter(fs) {
    var mode = null;   // 'DOCUMENTS'（公用「文件」資料夾，與桌面同名）或 'DATA'（App 私有；沒有檔案存取權限時的退路）
    function nm(f) { return typeof f === 'string' ? f : (f && f.name) || ''; }
    async function probe() { try { await fs.writeFile({ path: ROOT + '/.probe', data: '1', directory: 'DOCUMENTS', encoding: 'utf8', recursive: true }); return true; } catch (e) { return false; } }
    async function resolveMode() {
      if (mode) return mode;
      if (await probe()) mode = 'DOCUMENTS';
      else { try { await fs.requestPermissions(); } catch (e) { /* */ } mode = (await probe()) ? 'DOCUMENTS' : 'DATA'; }
      return mode;
    }
    async function listDir(kind, D) {
      var r; try { r = await fs.readdir({ path: ROOT + '/' + kind, directory: D }); } catch (e) { return []; }
      var out = [];
      for (var i = 0; i < (r.files || []).length; i++) {
        var n = nm(r.files[i]); if (!/\.json$/.test(n)) continue;
        try { var x = await fs.readFile({ path: ROOT + '/' + kind + '/' + n, directory: D, encoding: 'utf8' }); var d = JSON.parse(x.data); if (d && typeof d === 'object' && !Array.isArray(d)) out.push(d); }
        catch (e) {
          try { var b = await fs.readFile({ path: ROOT + '/' + kind + '/' + n + '.bak', directory: D, encoding: 'utf8' }); var d2 = JSON.parse(b.data); if (d2 && typeof d2 === 'object') out.push(d2); } catch (e2) { /* 讀不到就略過 */ }
        }
      }
      return out;
    }
    return {
      name: 'filesystem',
      dir: function () { return mode; },
      init: resolveMode,
      list: async function (kind) {
        var m = await resolveMode(), a = await listDir(kind, m), b = await listDir(kind, m === 'DOCUMENTS' ? 'DATA' : 'DOCUMENTS'), by = {}, tb = tomb();
        a.concat(b).forEach(function (d) { if (!d || !d.id) return; var o = by[d.id]; if (!o || (d.updated || 0) > (o.updated || 0)) by[d.id] = d; });   // 兩處都有同一筆時取較新的
        return Object.keys(by).map(function (k) { return by[k]; }).filter(function (d) { var t = tb[kind + '/' + d.id]; return !(t && (d.updated || 0) * 1 <= t); });   // 刪不掉的舊檔用墓碑擋掉
      },
      put: async function (kind, doc, prev) {
        var D = await resolveMode(), p = ROOT + '/' + kind + '/' + doc.id + '.json', body = JSON.stringify(doc, null, 1);
        async function wr(dir) {
          if (prev) { try { await fs.writeFile({ path: p + '.bak', data: JSON.stringify(prev, null, 1), directory: dir, encoding: 'utf8', recursive: true }); } catch (e) { /* */ } }
          await fs.writeFile({ path: p, data: body, directory: dir, encoding: 'utf8', recursive: true });
        }
        try { await wr(D); }
        catch (e) {   // 「文件」裡已存在、但不是這個 App 建立的檔案（例如別的來源放進去的）沒有權限覆寫 → 這一筆改存私有資料夾，列表時會取較新的
          if (D === 'DATA') throw e; await wr('DATA');
        }
        var tb = tomb(); if (tb[kind + '/' + doc.id]) { delete tb[kind + '/' + doc.id]; saveTomb(tb); }
      },
      del: async function (kind, doc) {
        var t = now(), D = await resolveMode(), left = false;
        try { await fs.writeFile({ path: ROOT + '/_deleted/' + kind + '_' + doc.id + '_' + Math.floor(t / 1000) + '.json', data: JSON.stringify(doc, null, 1), directory: D, encoding: 'utf8', recursive: true }); } catch (e) { try { await fs.writeFile({ path: ROOT + '/_deleted/' + kind + '_' + doc.id + '_' + Math.floor(t / 1000) + '.json', data: JSON.stringify(doc, null, 1), directory: 'DATA', encoding: 'utf8', recursive: true }); } catch (e2) { /* */ } }
        for (var i = 0; i < 2; i++) {
          var DD = ['DOCUMENTS', 'DATA'][i];
          try { await fs.deleteFile({ path: ROOT + '/' + kind + '/' + doc.id + '.json', directory: DD }); } catch (e) { if (DD === 'DOCUMENTS' && /EACCES|denied|permission/i.test(String(e && e.message || e))) left = true; }
          try { await fs.deleteFile({ path: ROOT + '/' + kind + '/' + doc.id + '.json.bak', directory: DD }); } catch (e) { /* */ }
        }
        if (left) { var tb = tomb(); tb[kind + '/' + doc.id] = Math.max(now(), (doc.updated || 0)) + 1; saveTomb(tb); }
      }
    };
  }
  function tomb() { try { return JSON.parse(LS.getItem('nova_research_tomb') || '{}') || {}; } catch (e) { return {}; } }
  function saveTomb(o) { try { LS.setItem('nova_research_tomb', JSON.stringify(o)); } catch (e) { /* */ } }
  function lsAdapter() {   // 沒有 Filesystem 外掛時（瀏覽器預覽）的退路
    function k(kind) { return 'nova_research_ls_' + kind; }
    function rd(kind) { try { return JSON.parse(LS.getItem(k(kind)) || '{}'); } catch (e) { return {}; } }
    return {
      name: 'localStorage',
      list: async function (kind) { var o = rd(kind); return Object.keys(o).map(function (i) { return o[i]; }); },
      put: async function (kind, doc) { var o = rd(kind); o[doc.id] = doc; LS.setItem(k(kind), JSON.stringify(o)); },
      del: async function (kind, doc) { var o = rd(kind); delete o[doc.id]; LS.setItem(k(kind), JSON.stringify(o)); }
    };
  }
  function getAdapter() { if (!adapter) { var fs = capFS(); adapter = fs ? fsAdapter(fs) : lsAdapter(); } return adapter; }
  function setAdapter(a) { adapter = a; cache = {}; loaded = {}; }
  function checkKind(kind) { if (KINDS.indexOf(kind) < 0) throw new Error('不支援的資料種類：' + kind); }
  async function load(kind) {
    checkKind(kind);
    if (loaded[kind]) return cache[kind];
    var items = await getAdapter().list(kind), m = {};
    items.forEach(function (d) { var id = safeId(d.id); if (id) m[id] = d; });
    cache[kind] = m; loaded[kind] = true; return m;
  }
  async function storeList(kind, pid) {
    var m = await load(kind);
    var arr = Object.keys(m).map(function (i) { return m[i]; });
    if (pid) arr = arr.filter(function (d) { return String(d.pid || '') === pid; });
    arr.sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); });
    return arr;
  }
  async function storeGet(kind, id) { var m = await load(kind); var d = m[safeId(id)]; return d ? clone(d) : null; }
  async function storePut(kind, data, keepUpdated, silent) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('資料必須是物件');
    var m = await load(kind), d = clone(data), id = safeId(d.id) || newId(kind), t = now();
    d.id = id; if (d.created == null) d.created = t;
    if (!(keepUpdated && typeof d.updated === 'number' && d.updated)) d.updated = t;
    await getAdapter().put(kind, d, m[id] || null);
    m[id] = d; if (!silent) emit('nova-research-changed');
    return clone(d);
  }
  async function storeDelete(kind, id, silent) {
    var m = await load(kind), sid = safeId(id), d = m[sid]; if (!d) return false;
    await getAdapter().del(kind, d); delete m[sid]; if (!silent) emit('nova-research-changed'); return true;
  }
  async function storeDump() {   // 同步用：所有種類完整紀錄；監看只含定義
    var out = {};
    for (var i = 0; i < KINDS.length; i++) {
      var k = KINDS[i], items = await storeList(k);
      if (k === 'watch') items = items.map(function (it) { var o = {}; Object.keys(it).forEach(function (f) { if (WATCH_LOCAL.indexOf(f) < 0) o[f] = it[f]; }); return o; });
      out[k] = items.map(clone);
    }
    return out;
  }
  async function storeApply(puts, dels) {
    var nPut = 0, nDel = 0, i;
    for (i = 0; i < (puts || []).length; i++) {
      var it = puts[i] || {}, k = String(it.kind || ''), d = it.data;
      if (KINDS.indexOf(k) < 0 || !d || typeof d !== 'object' || !safeId(d.id)) continue;
      d = clone(d);
      if (k === 'watch') { var cur = (await storeGet(k, d.id)) || {}; WATCH_LOCAL.forEach(function (f) { if (f in cur) d[f] = cur[f]; }); }
      await storePut(k, d, true, true); nPut++;
    }
    for (i = 0; i < (dels || []).length; i++) { var x = dels[i] || {}; if (KINDS.indexOf(String(x.kind || '')) >= 0 && await storeDelete(x.kind, String(x.id || ''), true)) nDel++; }
    return { ok: true, put: nPut, deleted: nDel };
  }

  /* ───────── 金鑰 ───────── */
  function loadKeys() { try { var d = JSON.parse(LS.getItem('nova_research_keys') || '{}'); return d && typeof d === 'object' ? d : {}; } catch (e) { return {}; } }
  function saveKeys(patch) {
    var cur = loadKeys();
    KEY_FIELDS.forEach(function (k) { if (patch && k in patch && patch[k] != null) { var v = String(patch[k]).trim(); if (v) cur[k] = v; else delete cur[k]; } });
    try { LS.setItem('nova_research_keys', JSON.stringify(cur)); } catch (e) { /* */ }
    return cur;
  }

  /* ───────── HTTP ───────── */
  var HTTP_TIMEOUT = 25000;
  function HttpError(status, body) { var e = new Error('HTTP ' + status + ' ' + String(body || '').replace(/\n/g, ' ').slice(0, 200)); e.status = status; return e; }
  async function http(url, o) {
    o = o || {};
    var ms = o.timeout || HTTP_TIMEOUT, ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null, timer;
    var req = fetch(url, { method: o.method || 'GET', headers: o.headers || {}, body: o.body, signal: ctl ? ctl.signal : undefined });
    var tp = new Promise(function (_, rej) { timer = setTimeout(function () { try { ctl && ctl.abort(); } catch (e) { /* */ } rej(new Error('逾時（' + Math.round(ms / 1000) + ' 秒）')); }, ms); });
    try {
      var r = await Promise.race([req, tp]);
      var txt = await r.text();
      if (!r.ok) throw HttpError(r.status, txt);
      return txt;
    } finally { clearTimeout(timer); }
  }
  async function httpJson(url, o) { return JSON.parse(await http(url, o)); }
  function qs(p) { return Object.keys(p).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(p[k]); }).join('&'); }
  function xml(text) { var d = new DOMParser().parseFromString(text, 'application/xml'); if (d.getElementsByTagName('parsererror').length) throw new Error('XML 解析失敗'); return d; }
  function txtOf(el, tag) { if (!el) return ''; var c = el.getElementsByTagName(tag)[0]; return c ? (c.textContent || '') : ''; }

  /* ───────── 文獻／專利來源 ───────── */
  var TAG_RE = /<[^>]+>/g, WS_RE = /\s+/g;
  function unescapeHtml(s) { return String(s).replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos|nbsp);/g, function (m, g) { var map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }; if (map[g]) return map[g]; var c = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10); try { return String.fromCodePoint(c); } catch (e) { return m; } }); }
  function clean(s, limit) { if (!s) return ''; s = unescapeHtml(String(s).replace(TAG_RE, ' ')); return s.replace(WS_RE, ' ').trim().slice(0, limit == null ? 1500 : limit); }
  function aslist(x) { return x == null ? [] : (Array.isArray(x) ? x : [x]); }
  function normTitle(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '').slice(0, 120); }
  function dedupeKeys(it) { var ks = [it.doi, normTitle(it.title)].filter(Boolean); return ks.length ? ks : [it.id]; }
  function mk(src, kind, id, title, abstract, year, date, authors, venue, url, doi, cited, jur) {
    return { id: src + ':' + id, src: src, kind: kind, title: clean(title, 400), abstract: clean(abstract, 1500), year: year == null ? null : year, date: date || '',
      authors: (authors || []).filter(Boolean).slice(0, 8), venue: clean(venue, 200), url: url || '', doi: String(doi || '').toLowerCase().replace('https://doi.org/', ''), cited: cited == null ? null : cited, jur: jur || '' };
  }
  function openalexAbstract(inv) {
    if (!inv || typeof inv !== 'object') return '';
    var pos = []; Object.keys(inv).forEach(function (w) { aslist(inv[w]).forEach(function (i) { if (typeof i === 'number') pos.push([i, w]); }); });
    pos.sort(function (a, b) { return a[0] - b[0]; }); return pos.map(function (p) { return p[1]; }).join(' ');
  }
  function parseOpenalex(d) {
    return (d.results || []).map(function (w) {
      var loc = w.primary_location || {}, src = (loc.source || {}).display_name || '';
      var au = (w.authorships || []).map(function (a) { return (a.author || {}).display_name || ''; });
      var wid = String(w.id || '').split('/').pop(), doi = w.doi || '';
      return mk('openalex', 'paper', wid, w.title || '', openalexAbstract(w.abstract_inverted_index), w.publication_year, w.publication_date || '', au, src,
        loc.landing_page_url || doi || w.id || '', doi, w.cited_by_count);
    });
  }
  async function srcOpenalex(q, n, yf, keys) {
    var p = { search: q, 'per-page': String(n), select: 'id,doi,title,publication_year,publication_date,cited_by_count,abstract_inverted_index,authorships,primary_location' };
    if (yf) p.filter = 'from_publication_date:' + parseInt(yf, 10) + '-01-01';
    if (keys.contact_email) p.mailto = keys.contact_email;
    return parseOpenalex(await httpJson('https://api.openalex.org/works?' + qs(p)));
  }
  function parseS2(d) {
    return (d.data || []).map(function (w) {
      var ext = w.externalIds || {};
      return mk('s2', 'paper', w.paperId || '', w.title || '', w.abstract || '', w.year, w.publicationDate || '', (w.authors || []).map(function (a) { return a.name; }), w.venue || '', w.url || '', ext.DOI || '', w.citationCount);
    });
  }
  async function srcS2(q, n, yf, keys) {
    var p = { query: q, limit: String(Math.min(n, 100)), fields: 'title,year,abstract,url,venue,citationCount,authors,externalIds,publicationDate' };
    if (yf) p.year = parseInt(yf, 10) + '-';
    return parseS2(await httpJson('https://api.semanticscholar.org/graph/v1/paper/search?' + qs(p), { headers: keys.s2_key ? { 'x-api-key': keys.s2_key } : {} }));
  }
  function parseCrossref(d) {
    return ((d.message || {}).items || []).map(function (w) {
      var title = (aslist(w.title)[0]) || '', dp = (((w.issued || {})['date-parts']) || [[null]])[0], yr = dp && dp.length ? dp[0] : null;
      var au = (w.author || []).map(function (a) { return ((a.given || '') + ' ' + (a.family || '')).trim(); });
      return mk('crossref', 'paper', w.DOI || '', title, w.abstract || '', yr, '', au, aslist(w['container-title'])[0] || '', w.URL || '', w.DOI || '', w['is-referenced-by-count']);
    });
  }
  async function srcCrossref(q, n, yf, keys) {
    var p = { query: q, rows: String(n), select: 'DOI,title,abstract,issued,container-title,author,URL,is-referenced-by-count' };
    if (yf) p.filter = 'from-pub-date:' + parseInt(yf, 10);
    if (keys.contact_email) p.mailto = keys.contact_email;
    return parseCrossref(await httpJson('https://api.crossref.org/works?' + qs(p)));
  }
  function parseArxiv(text) {
    var doc = xml(text), out = [], es = doc.getElementsByTagName('entry');
    for (var i = 0; i < es.length; i++) {
      var e = es[i], idu = txtOf(e, 'id').trim(), pub = txtOf(e, 'published').slice(0, 10), au = [], as = e.getElementsByTagName('author');
      for (var j = 0; j < as.length; j++) au.push(txtOf(as[j], 'name'));
      out.push(mk('arxiv', 'paper', idu.split('/').pop(), txtOf(e, 'title'), txtOf(e, 'summary'), /^\d{4}/.test(pub) ? parseInt(pub.slice(0, 4), 10) : null, pub, au, 'arXiv', idu));
    }
    return out;
  }
  async function srcArxiv(q, n, yf) {
    var items = parseArxiv(await http('https://export.arxiv.org/api/query?' + qs({ search_query: 'all:' + q, start: '0', max_results: String(Math.min(n, 50)), sortBy: 'relevance' })));
    return items.filter(function (i) { return !yf || (i.year || 0) >= parseInt(yf, 10); });
  }
  function parsePubmed(text) {
    var doc = xml(text), out = [], as = doc.getElementsByTagName('PubmedArticle');
    for (var i = 0; i < as.length; i++) {
      var a = as[i], pmid = txtOf(a.getElementsByTagName('MedlineCitation')[0], 'PMID');
      var title = txtOf(a, 'ArticleTitle'), abs = [], abEls = a.getElementsByTagName('AbstractText');
      for (var j = 0; j < abEls.length; j++) abs.push(abEls[j].textContent || '');
      var pd = a.getElementsByTagName('JournalIssue')[0], pdate = pd ? pd.getElementsByTagName('PubDate')[0] : null;
      var yr = pdate ? (txtOf(pdate, 'Year') || txtOf(pdate, 'MedlineDate').slice(0, 4)) : '';
      var au = [], aus = a.getElementsByTagName('Author');
      for (var k = 0; k < aus.length; k++) au.push((txtOf(aus[k], 'LastName') + ' ' + txtOf(aus[k], 'Initials')).trim());
      var doi = '', ids = a.getElementsByTagName('ArticleId');
      for (var m = 0; m < ids.length; m++) if (ids[m].getAttribute('IdType') === 'doi') doi = ids[m].textContent || '';
      var jt = a.getElementsByTagName('Journal')[0];
      out.push(mk('pubmed', 'paper', pmid, title, abs.join(' '), /^\d+$/.test(yr) ? parseInt(yr, 10) : null, '', au, jt ? txtOf(jt, 'Title') : '', 'https://pubmed.ncbi.nlm.nih.gov/' + pmid + '/', doi));
    }
    return out;
  }
  async function srcPubmed(q, n, yf, keys) {
    var base = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/', extra = keys.ncbi_key ? { api_key: keys.ncbi_key } : {};
    var p = Object.assign({ db: 'pubmed', term: q, retmax: String(Math.min(n, 50)), retmode: 'json' }, extra);
    if (yf) { p.datetype = 'pdat'; p.mindate = String(parseInt(yf, 10)); }
    var ids = (((await httpJson(base + 'esearch.fcgi?' + qs(p))).esearchresult || {}).idlist) || [];
    if (!ids.length) return [];
    return parsePubmed(await http(base + 'efetch.fcgi?' + qs(Object.assign({ db: 'pubmed', id: ids.join(','), retmode: 'xml' }, extra))));
  }
  function gpUrl(jur, num, kind) { return 'https://patents.google.com/patent/' + (jur || '') + (num || '') + (kind || '') + '/en'; }
  function parseLens(d) {
    return (d.data || []).map(function (r) {
      var b = r.biblio || {}, title = '', ab = '';
      aslist(b.invention_title).forEach(function (t) { if (t && typeof t === 'object' && (t.lang === 'en' || !title)) title = t.text || title; });
      aslist(r.abstract).forEach(function (t) { if (t && typeof t === 'object' && (t.lang === 'en' || !ab)) ab = t.text || ab; });
      var ap = []; aslist((b.parties || {}).applicants).forEach(function (x) { var v = ((x || {}).extracted_name || {}).value; if (v) ap.push(v); });
      var date = r.date_published || '';
      var it = mk('lens', 'patent', r.lens_id || '', title, ab, /^\d{4}/.test(date) ? parseInt(date.slice(0, 4), 10) : null, date, ap,
        (r.jurisdiction || '') + (r.doc_number || '') + (r.kind || ''), 'https://www.lens.org/lens/patent/' + (r.lens_id || ''), '', null, r.jurisdiction || '');
      it.gp = gpUrl(r.jurisdiction, r.doc_number, r.kind); return it;
    });
  }
  async function srcLens(q, n, yf, keys) {
    if (!keys.lens_token) throw permErr('未設定 Lens token');
    var must = [{ query_string: { query: q, fields: ['title', 'abstract', 'claim'], default_operator: 'and' } }];
    var body = { query: { bool: { must: must } }, size: Math.min(n, 50), include: ['lens_id', 'jurisdiction', 'doc_number', 'kind', 'date_published', 'biblio', 'abstract'] };
    if (yf) body.query.bool.filter = [{ range: { year_published: { gte: parseInt(yf, 10) } } }];
    var h = { Authorization: 'Bearer ' + keys.lens_token, 'Content-Type': 'application/json' };
    try { return parseLens(await httpJson('https://api.lens.org/patent/search', { method: 'POST', headers: h, body: JSON.stringify(body) })); }
    catch (e) { if (e.status !== 400) throw e; delete must[0].query_string.fields; return parseLens(await httpJson('https://api.lens.org/patent/search', { method: 'POST', headers: h, body: JSON.stringify(body) })); }
  }
  function permErr(m) { var e = new Error(m); e.perm = true; return e; }
  var epoTok = { v: '', exp: 0 };
  async function epoToken(keys) {
    if (epoTok.v && now() < epoTok.exp) return epoTok.v;
    if (!(keys.epo_key && keys.epo_secret)) throw permErr('未設定 EPO OPS key／secret');
    var d = await httpJson('https://ops.epo.org/3.2/auth/accesstoken', { method: 'POST', headers: { Authorization: 'Basic ' + btoa(keys.epo_key + ':' + keys.epo_secret), 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
    epoTok.v = d.access_token || ''; epoTok.exp = now() + Math.max(60, parseInt(d.expires_in || 1000, 10) - 60) * 1000;
    if (!epoTok.v) throw new Error('EPO 授權沒有回傳 access_token'); return epoTok.v;
  }
  function epoText(x) { return x && typeof x === 'object' ? (x.$ || '') : String(x == null ? '' : x); }
  function parseEpoBiblio(d) {
    var out = [], wpd = d['ops:world-patent-data'] || {};
    aslist(((wpd['exchange-documents'] || {})['exchange-document'])).forEach(function (ed) {
      var bd = ed['bibliographic-data'] || {}, title = '', ab = '';
      aslist(bd['invention-title']).forEach(function (t) { if (t && typeof t === 'object' && (t['@lang'] === 'en' || !title)) title = epoText(t); });
      aslist(ed.abstract).forEach(function (a) { if (a && typeof a === 'object' && (a['@lang'] === 'en' || !ab)) ab = aslist(a.p).map(epoText).join(' '); });
      var ap = []; aslist(((bd.parties || {}).applicants || {}).applicant).forEach(function (a) { var nm = epoText(((a || {})['applicant-name'] || {}).name); if (nm && ap.indexOf(nm) < 0) ap.push(nm); });
      var country = ed['@country'] || '', num = ed['@doc-number'] || '', kind = ed['@kind'] || '', date = '';
      aslist((bd['publication-reference'] || {})['document-id']).forEach(function (di) { if (di && di['@document-id-type'] === 'docdb') date = epoText(di.date); });
      if (date.length === 8) date = date.slice(0, 4) + '-' + date.slice(4, 6) + '-' + date.slice(6, 8);
      var it = mk('epo', 'patent', country + num + kind, title, ab, /^\d{4}/.test(date) ? parseInt(date.slice(0, 4), 10) : null, date, ap, country + num + kind,
        'https://worldwide.espacenet.com/patent/search?q=pn%3D' + country + num + kind, '', null, country);
      it.gp = gpUrl(country, num, kind); out.push(it);
    });
    return out;
  }
  async function srcEpo(q, n, yf, keys) {
    var tok = await epoToken(keys), words = (q.match(/[A-Za-z0-9\-]+/g) || []).filter(function (w) { return w.length > 2; }).slice(0, 5);
    if (!words.length) return [];
    var h = { Authorization: 'Bearer ' + tok, Accept: 'application/json' };
    var d = await httpJson('https://ops.epo.org/3.2/rest-services/published-data/search?' + qs({ q: words.map(function (w) { return 'ta=' + w; }).join(' and '), Range: '1-' + Math.min(n, 25) }), { headers: h });
    var sr = (((d['ops:world-patent-data'] || {})['ops:biblio-search'] || {})['ops:search-result']) || {}, refs = [];
    aslist(sr['ops:publication-reference']).forEach(function (pr) { aslist((pr || {})['document-id']).forEach(function (di) { if (di && di['@document-id-type'] === 'docdb') refs.push(epoText(di.country) + '.' + epoText(di['doc-number']) + '.' + epoText(di.kind)); }); });
    if (!refs.length) return [];
    var items = [];
    try { items = parseEpoBiblio(await httpJson('https://ops.epo.org/3.2/rest-services/published-data/publication/docdb/' + refs.slice(0, 25).join(',') + '/biblio', { headers: h })); } catch (e) { /* 取不到書目就只回公開號 */ }
    if (!items.length) items = refs.map(function (r) { var p = r.split('.'); return mk('epo', 'patent', p[0] + p[1] + p[2], p[0] + p[1] + p[2] + '（EPO；書目資料取得失敗，請點連結）', '', null, '', [], r, 'https://worldwide.espacenet.com/patent/search?q=pn%3D' + p[0] + p[1] + p[2], '', null, p[0]); });
    return yf ? items.filter(function (i) { return !i.year || i.year >= parseInt(yf, 10); }) : items;
  }
  function parsePatentsview(d) {
    return (d.patents || []).map(function (p) {
      var date = p.patent_date || '', ap = aslist(p.assignees).filter(function (a) { return a && typeof a === 'object' && a.assignee_organization; }).map(function (a) { return a.assignee_organization; });
      var pid = String(p.patent_id || ''), it = mk('patentsview', 'patent', pid, p.patent_title || '', p.patent_abstract || '', /^\d{4}/.test(date) ? parseInt(date.slice(0, 4), 10) : null, date, ap, 'US' + pid, 'https://patents.google.com/patent/US' + pid + '/en', '', null, 'US');
      it.gp = 'https://patents.google.com/patent/US' + pid + '/en'; return it;
    });
  }
  async function srcPatentsview(q, n, yf, keys) {
    if (!keys.patentsview_key) throw permErr('未設定 PatentsView key');
    var crit = [{ _text_all: { patent_abstract: q } }]; if (yf) crit.push({ _gte: { patent_date: parseInt(yf, 10) + '-01-01' } });
    var p = { q: JSON.stringify({ _and: crit }), f: JSON.stringify(['patent_id', 'patent_title', 'patent_abstract', 'patent_date', 'assignees.assignee_organization']), o: JSON.stringify({ size: Math.min(n, 50) }) };
    return parsePatentsview(await httpJson('https://search.patentsview.org/api/v1/patent/?' + qs(p), { headers: { 'X-Api-Key': keys.patentsview_key } }));
  }
  var SOURCES = {
    openalex: ['OpenAlex', 'paper', srcOpenalex, false], s2: ['Semantic Scholar', 'paper', srcS2, false], crossref: ['Crossref', 'paper', srcCrossref, false],
    pubmed: ['PubMed', 'paper', srcPubmed, false], arxiv: ['arXiv', 'paper', srcArxiv, false],
    lens: ['Lens 專利', 'patent', srcLens, true], epo: ['EPO OPS 專利', 'patent', srcEpo, true], patentsview: ['PatentsView（美國專利）', 'patent', srcPatentsview, true]
  };
  var searchCache = {}, SEARCH_TTL = 3600000;
  async function runSearch(q, sources, n, yearFrom) {
    q = String(q || '').trim(); if (!q) throw new Error('請輸入查詢內容');
    n = Math.max(3, Math.min(parseInt(n || 15, 10), 50));
    var srcs = (sources && sources.length ? sources : Object.keys(SOURCES)).filter(function (s) { return SOURCES[s]; });
    var ck = JSON.stringify([q.toLowerCase(), srcs, n, yearFrom || null]), hit = searchCache[ck];
    if (hit && now() - hit[0] < SEARCH_TTL) return Object.assign({}, hit[1], { cached: true });
    var keys = loadKeys(), results = {}, per = {};
    await Promise.all(srcs.map(async function (s) {
      var t0 = now(), meta = SOURCES[s];
      try {
        var items = await Promise.race([meta[2](q, n, yearFrom, keys), new Promise(function (_, rej) { setTimeout(function () { rej(new Error('逾時（45 秒）')); }, 45000); })]);
        results[s] = items || []; per[s] = { ok: true, n: results[s].length, ms: now() - t0, label: meta[0], kind: meta[1] };
      } catch (e) {
        per[s] = e && e.perm ? { ok: false, skipped: true, error: e.message, label: meta[0], kind: meta[1] } : { ok: false, error: String((e && e.message) || e).slice(0, 300), label: meta[0], kind: meta[1] };
      }
    }));
    var merged = [], seen = {}, order = srcs.filter(function (s) { return results[s]; }), depth = Math.max.apply(null, order.map(function (s) { return results[s].length; }).concat([0]));
    for (var i = 0; i < depth; i++) order.forEach(function (s) {
      if (i >= results[s].length) return;
      var it = results[s][i], ks = dedupeKeys(it);
      if (ks.some(function (k) { return seen[k]; })) return;
      ks.forEach(function (k) { seen[k] = 1; }); merged.push(it);
    });
    var out = { ok: true, q: q, items: merged, sources: per, n: merged.length, at: now() };
    if (Object.keys(per).some(function (k) { return per[k].ok; })) { var ks2 = Object.keys(searchCache); if (ks2.length > 60) delete searchCache[ks2[0]]; searchCache[ck] = [now(), out]; }
    return out;
  }

  /* ───────── PubChem ───────── */
  var CAS_RE = /^\d{2,7}-\d{2}-\d$/, pcCache = {};
  function pc(path, ms) { return httpJson('https://pubchem.ncbi.nlm.nih.gov/rest/' + path, { timeout: ms || 20000 }); }
  async function pubchemResolve(q) {
    q = String(q || '').trim(); if (!q) throw new Error('請輸入名稱、CAS 或 SMILES');
    var ck = q.toLowerCase(), hit = pcCache[ck]; if (hit && now() - hit[0] < 86400000) return hit[1];
    var ids;
    try { ids = /^smiles:/i.test(q) ? await pc('pug/compound/smiles/' + encodeURIComponent(q.slice(7).trim()) + '/cids/JSON') : await pc('pug/compound/name/' + encodeURIComponent(q) + '/cids/JSON'); }
    catch (e) { if (e.status === 404) return { found: false, q: q }; throw e; }
    var cids = (ids.IdentifierList || {}).CID || [];
    if (!cids.length || cids[0] === 0) return { found: false, q: q };
    var cid = cids[0], prop = {}, names = ['Title,MolecularFormula,MolecularWeight,IUPACName,SMILES,InChIKey', 'Title,MolecularFormula,MolecularWeight,IUPACName,CanonicalSMILES,InChIKey'];
    for (var i = 0; i < names.length; i++) {
      try { var rows = ((await pc('pug/compound/cid/' + cid + '/property/' + names[i] + '/JSON')).PropertyTable || {}).Properties || []; if (rows.length) { prop = rows[0]; break; } } catch (e) { /* 試下一組 */ }
    }
    var smiles = ''; Object.keys(prop).forEach(function (k) { if (!smiles && /SMILES/.test(k) && prop[k]) smiles = prop[k]; });
    var syn = []; try { syn = (((await pc('pug/compound/cid/' + cid + '/synonyms/JSON')).InformationList || {}).Information || [{}])[0].Synonym || []; } catch (e) { /* */ }
    var cas = []; syn.forEach(function (s) { if (CAS_RE.test(s) && cas.indexOf(s) < 0) cas.push(s); });
    var out = { found: true, q: q, cid: cid, title: prop.Title || '', formula: prop.MolecularFormula || '', mw: prop.MolecularWeight == null ? null : prop.MolecularWeight, iupac: prop.IUPACName || '', smiles: smiles, inchikey: prop.InChIKey || '',
      cas: cas.slice(0, 8), synonyms: syn.filter(function (s) { return !CAS_RE.test(s); }).slice(0, 30), candidates: cids.slice(1, 4), url: 'https://pubchem.ncbi.nlm.nih.gov/compound/' + cid };
    pcCache[ck] = [now(), out]; return out;
  }
  function walkInfo(node, acc) {
    if (Array.isArray(node)) node.forEach(function (v) { walkInfo(v, acc); });
    else if (node && typeof node === 'object') { if ('Name' in node && 'Value' in node) acc.push(node); Object.keys(node).forEach(function (k) { walkInfo(node[k], acc); }); }
  }
  function parseGhs(d) {
    var infos = []; walkInfo(d, infos);
    var pict = [], signal = '', hs = {}, hsOrder = [], ps = [];
    infos.forEach(function (it) {
      var name = String(it.Name || '');
      ((it.Value || {}).StringWithMarkup || []).forEach(function (sw) {
        var s = String(sw.String || '');
        if (name.indexOf('Pictogram') === 0) (sw.Markup || []).forEach(function (m) { if (m.Extra && pict.indexOf(m.Extra) < 0) pict.push(m.Extra); });
        else if (name === 'Signal') { if (s && !signal) signal = s; }
        else if (name.indexOf('GHS Hazard Statements') === 0) { var m = s.match(/^(H\d{3}[A-Za-z]?)\s*(?:\([^)]*\))?\s*:?\s*(.*)/); if (m && !(m[1] in hs)) { hs[m[1]] = m[2].replace(/\s*\[.*$/, '').slice(0, 160); hsOrder.push(m[1]); } }
        else if (name.indexOf('Precautionary Statement Codes') === 0) (s.match(/P\d{3}(?:\+P\d{3})*/g) || []).forEach(function (c) { if (ps.indexOf(c) < 0) ps.push(c); });
      });
    });
    return { signal: signal, pictograms: pict, h: hsOrder.map(function (k) { return { code: k, text: hs[k] }; }), p: ps.slice(0, 40) };
  }
  async function pubchemGhs(cid) {
    cid = parseInt(cid, 10); var d;
    try { d = await pc('pug_view/data/compound/' + cid + '/JSON?heading=GHS+Classification', 25000); } catch (e) { if (e.status === 404) return { found: false, cid: cid }; throw e; }
    var g = parseGhs(d); g.found = !!(g.h.length || g.signal || g.pictograms.length); g.cid = cid; return g;
  }

  /* ───────── 監看 ───────── */
  var watchBusy = {}, sched = { started: false, last: 0, timer: null };
  async function watchRun(wid) {
    var w = await storeGet('watch', wid); if (!w) throw new Error('找不到這個監看');
    var q = String(w.query || '').split(/\s+/).filter(Boolean).join(' '); if (!q) throw new Error('監看沒有查詢內容');
    if (watchBusy[wid]) return { ok: false, busy: true }; watchBusy[wid] = true;
    try {
      var res = await runSearch(q, w.sources || null, parseInt(w.n || 15, 10), w.year_from);
      w = (await storeGet('watch', wid)) || w;
      var seenArr = w.seen || [], seen = {}; seenArr.forEach(function (k) { seen[k] = 1; });
      var baseline = !w.last_run, fresh = [];
      res.items.forEach(function (it) {
        var ks = dedupeKeys(it);
        if (!ks.some(function (k) { return seen[k]; })) {
          ks.forEach(function (k) { if (!seen[k]) { seen[k] = 1; seenArr.push(k); } });
          if (!baseline || w.include_first) { var it2 = Object.assign({}, it, { found_at: now(), read: false }); fresh.push(it2); }
        }
      });
      w.seen = seenArr.slice(-6000); w.inbox = fresh.concat(w.inbox || []).slice(0, 300); w.last_run = now(); w.runs = (parseInt(w.runs || 0, 10)) + 1; w.last_new = fresh.length;
      w.last_error = Object.keys(res.sources).map(function (k) { return res.sources[k]; }).filter(function (v) { return !v.ok && !v.skipped; }).map(function (v) { return v.label + '：' + v.error; }).join('; ').slice(0, 400);
      await storePut('watch', w, false, true);   // 執行狀態不觸發同步（同步只帶定義）
      emit('nova-research-watch');
      return { ok: true, id: wid, 'new': fresh.length, baseline: baseline, total: res.n, sources: res.sources };
    } finally { watchBusy[wid] = false; }
  }
  async function watchTick(force) {
    if (!force && now() - sched.last < 300000) return; sched.last = now();
    var list = await storeList('watch');
    for (var i = 0; i < list.length; i++) {
      var w = list[i]; if (w.enabled === false) continue;
      var every = Math.max(1, parseFloat(w.interval_h || 24)) * 3600000;
      if (now() - (w.last_run || 0) >= every) {
        try { await watchRun(w.id); }
        catch (e) { try { var ww = (await storeGet('watch', w.id)) || w; ww.last_error = String(e.message || e).slice(0, 300); ww.last_run = now(); await storePut('watch', ww, false, true); } catch (e2) { /* */ } }
      }
    }
  }
  function startScheduler() { if (sched.started) return; sched.started = true; sched.timer = setInterval(function () { watchTick(false).catch(function () { /* */ }); }, 60000); setTimeout(function () { watchTick(false).catch(function () { /* */ }); }, 15000); }
  async function watchInbox() {
    var out = [], total = 0, list = await storeList('watch');
    list.forEach(function (w) { var un = (w.inbox || []).filter(function (i) { return !i.read; }).length; total += un; out.push({ id: w.id, name: w.name, pid: w.pid, unread: un, last_run: w.last_run, last_new: w.last_new, last_error: w.last_error, enabled: w.enabled !== false }); });
    return { total_unread: total, watches: out };
  }
  async function watchMarkRead(wid) {
    var w = await storeGet('watch', wid); if (!w) return 0; var n = 0;
    (w.inbox || []).forEach(function (i) { if (!i.read) { i.read = true; n++; } });
    await storePut('watch', w, false, true); return n;
  }

  /* ───────── 色彩科學 ───────── */
  function labToHex(L, a, b) {
    var fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
    function fi(t) { return Math.pow(t, 3) > 0.008856 ? Math.pow(t, 3) : (t - 16 / 116) / 7.787; }
    var X = 0.95047 * fi(fx), Y = fi(fy), Z = 1.08883 * fi(fz);
    var r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z, g = -0.9689 * X + 1.8758 * Y + 0.0415 * Z, bl = 0.0557 * X - 0.2040 * Y + 1.0570 * Z;
    function gam(c) { c = Math.max(0, Math.min(1, c)); return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }
    function h2(v) { var s = Math.round(gam(v) * 255).toString(16); return s.length < 2 ? '0' + s : s; }
    return '#' + h2(r) + h2(g) + h2(bl);
  }
  function de76(l1, l2) { return Math.sqrt((l1[0] - l2[0]) * (l1[0] - l2[0]) + (l1[1] - l2[1]) * (l1[1] - l2[1]) + (l1[2] - l2[2]) * (l1[2] - l2[2])); }
  function deg(x) { return x * 180 / Math.PI; }
  function rad(x) { return x * Math.PI / 180; }
  function de2000(l1, l2) {
    var L1 = l1[0], a1 = l1[1], b1 = l1[2], L2 = l2[0], a2 = l2[1], b2 = l2[2];
    var C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2, G = 0.5 * (1 - Math.sqrt(Math.pow(Cb, 7) / (Math.pow(Cb, 7) + Math.pow(25, 7))));
    var a1p = (1 + G) * a1, a2p = (1 + G) * a2, C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
    function mod360(x) { return ((x % 360) + 360) % 360; }
    var h1p = (b1 || a1p) ? mod360(deg(Math.atan2(b1, a1p))) : 0, h2p = (b2 || a2p) ? mod360(deg(Math.atan2(b2, a2p))) : 0;
    var dLp = L2 - L1, dCp = C2p - C1p, dhp;
    if (C1p * C2p === 0) dhp = 0; else { dhp = h2p - h1p; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360; }
    var dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp / 2)), Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2, hbp;
    if (C1p * C2p === 0) hbp = h1p + h2p; else if (Math.abs(h1p - h2p) <= 180) hbp = (h1p + h2p) / 2; else hbp = (h1p + h2p < 360) ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
    var T = 1 - 0.17 * Math.cos(rad(hbp - 30)) + 0.24 * Math.cos(rad(2 * hbp)) + 0.32 * Math.cos(rad(3 * hbp + 6)) - 0.20 * Math.cos(rad(4 * hbp - 63));
    var dTheta = 30 * Math.exp(-Math.pow((hbp - 275) / 25, 2)), Rc = 2 * Math.sqrt(Math.pow(Cbp, 7) / (Math.pow(Cbp, 7) + Math.pow(25, 7)));
    var Sl = 1 + 0.015 * Math.pow(Lbp - 50, 2) / Math.sqrt(20 + Math.pow(Lbp - 50, 2)), Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T, Rt = -Math.sin(rad(2 * dTheta)) * Rc;
    return Math.sqrt(Math.pow(dLp / Sl, 2) + Math.pow(dCp / Sc, 2) + Math.pow(dHp / Sh, 2) + Rt * (dCp / Sc) * (dHp / Sh));
  }
  function colorCompare(ref, samples) {
    ref = (ref || []).map(Number); if (ref.length !== 3 || ref.some(isNaN)) throw new Error('標準色需為 [L, a, b]');
    var rows = (samples || []).map(function (s) {
      s = s.map(Number); if (s.length !== 3 || s.some(isNaN)) throw new Error('樣品色需為 [L, a, b]');
      var d00 = de2000(ref, s), ca = Math.hypot(ref[1], ref[2]), cb = Math.hypot(s[1], s[2]);
      var verdict = d00 <= 0.5 ? '幾乎無差' : d00 <= 1 ? '極輕微' : d00 <= 2 ? '輕微（多數色母粒可接受）' : d00 <= 3.5 ? '明顯' : '差異很大';
      return { lab: s, hex: labToHex(s[0], s[1], s[2]), de00: round(d00, 3), de76: round(de76(ref, s), 3), dL: round(s[0] - ref[0], 2), da: round(s[1] - ref[1], 2), db: round(s[2] - ref[2], 2), dC: round(cb - ca, 2), verdict: verdict };
    });
    return { ref: ref, ref_hex: labToHex(ref[0], ref[1], ref[2]), rows: rows, note: 'Lab 以 D65 轉 sRGB 預覽；判讀門檻是常見經驗值，實際依客戶規格與 CMC/ΔE 條件。' };
  }

  var SEED_MATERIALS = [{"id": "seed-irganox1010", "name": "Irganox 1010", "alias": "Pentaerythritol tetrakis 酚類抗氧劑", "cas": "6683-19-8", "cls": "主抗氧劑（受阻酚）", "domain": "additive", "function": "加工與長期熱氧穩定", "typical": "0.05–0.3 phr", "notes": "常與 Irgafos 168 並用；高分子量、低揮發。", "seed": true}, {"id": "seed-irganox1076", "name": "Irganox 1076", "alias": "", "cas": "2082-79-3", "cls": "主抗氧劑（受阻酚）", "domain": "additive", "function": "長期熱氧穩定", "typical": "0.05–0.3 phr", "notes": "較低分子量，接觸食品的規範需另查。", "seed": true}, {"id": "seed-irgafos168", "name": "Irgafos 168", "alias": "", "cas": "31570-04-4", "cls": "副抗氧劑（亞磷酸酯）", "domain": "additive", "function": "加工穩定、分解氫過氧化物", "typical": "0.05–0.2 phr", "notes": "易水解，儲存要防潮；與主抗氧劑協同。", "seed": true}, {"id": "seed-bht", "name": "BHT", "alias": "", "cas": "128-37-0", "cls": "主抗氧劑（受阻酚）", "domain": "additive", "function": "低成本抗氧", "typical": "0.01–0.1 phr", "notes": "揮發性高，易黃變，高溫加工損失大。", "seed": true}, {"id": "seed-tinuvin770", "name": "Tinuvin 770", "alias": "", "cas": "52829-07-9", "cls": "光安定劑（HALS）", "domain": "additive", "function": "抗光氧化", "typical": "0.1–0.5 phr", "notes": "鹼性，與酸性成分（含硫、部分阻燃劑）可能交互作用。", "seed": true}, {"id": "seed-tinuvin326", "name": "Tinuvin 326", "alias": "", "cas": "3896-11-5", "cls": "紫外線吸收劑（苯并三唑）", "domain": "additive", "function": "吸收 UV", "typical": "0.1–0.5 phr", "notes": "屬 SVHC 清單物質之一，歐盟銷售前務必查規範。", "seed": true}, {"id": "seed-tinuvinp", "name": "Tinuvin P", "alias": "", "cas": "2440-22-4", "cls": "紫外線吸收劑（苯并三唑）", "domain": "additive", "function": "吸收 UV", "typical": "0.1–0.5 phr", "notes": "", "seed": true}, {"id": "seed-octabenzone", "name": "Octabenzone（UV-531）", "alias": "Chimassorb 81", "cas": "1843-05-6", "cls": "紫外線吸收劑（二苯甲酮）", "domain": "additive", "function": "吸收 UV", "typical": "0.1–0.5 phr", "notes": "", "seed": true}, {"id": "seed-dehp", "name": "DEHP", "alias": "", "cas": "117-81-7", "cls": "塑化劑（鄰苯二甲酸酯）", "domain": "additive", "function": "PVC 塑化", "typical": "—", "notes": "受限物質（RoHS 與 SVHC），僅供比對，不建議新配方使用。", "seed": true}, {"id": "seed-dinp", "name": "DINP", "alias": "", "cas": "28553-12-0", "cls": "塑化劑（鄰苯二甲酸酯）", "domain": "additive", "function": "PVC 塑化", "typical": "30–70 phr", "notes": "各地區玩具與接觸類應用有限制；CAS 另有 68515-48-0 的商品別。", "seed": true}, {"id": "seed-dotp", "name": "DOTP（DEHT）", "alias": "", "cas": "6422-86-2", "cls": "塑化劑（對苯二甲酸酯）", "domain": "additive", "function": "PVC 塑化", "typical": "20–60 phr", "notes": "常作為 DEHP 替代。", "seed": true}, {"id": "seed-znst", "name": "硬脂酸鋅", "alias": "", "cas": "557-05-1", "cls": "金屬皂／潤滑／酸中和", "domain": "additive", "function": "潤滑、脫模、酸清除", "typical": "0.1–1.0 phr", "notes": "PVC 中也有熱穩定輔助作用，過量可能影響透明度。", "seed": true}, {"id": "seed-cast", "name": "硬脂酸鈣", "alias": "", "cas": "1592-23-0", "cls": "金屬皂／酸清除", "domain": "additive", "function": "酸清除、潤滑", "typical": "0.05–0.3 phr", "notes": "", "seed": true}, {"id": "seed-erucamide", "name": "芥酸醯胺（Erucamide）", "alias": "", "cas": "112-84-5", "cls": "滑爽劑", "domain": "additive", "function": "降低薄膜摩擦係數", "typical": "0.05–0.3 phr", "notes": "會遷移到表面，影響印刷與熱封。", "seed": true}, {"id": "seed-oleamide", "name": "油酸醯胺（Oleamide）", "alias": "", "cas": "301-02-0", "cls": "滑爽劑", "domain": "additive", "function": "降低薄膜摩擦係數", "typical": "0.05–0.3 phr", "notes": "遷移快、達到穩定摩擦所需時間較短。", "seed": true}, {"id": "seed-silica", "name": "二氧化矽（抗結塊）", "alias": "", "cas": "7631-86-9", "cls": "抗結塊劑", "domain": "additive", "function": "防止薄膜黏連", "typical": "0.05–0.5 phr", "notes": "", "seed": true}, {"id": "seed-gms", "name": "單硬脂酸甘油酯（GMS）", "alias": "", "cas": "123-94-4", "cls": "抗靜電劑", "domain": "additive", "function": "表面抗靜電", "typical": "0.5–2 phr", "notes": "", "seed": true}, {"id": "seed-sodbenz", "name": "苯甲酸鈉", "alias": "", "cas": "532-32-1", "cls": "成核劑", "domain": "additive", "function": "PP 成核", "typical": "0.1–0.3 phr", "notes": "", "seed": true}, {"id": "seed-dmdbs", "name": "DMDBS（Millad 3988）", "alias": "", "cas": "135861-56-2", "cls": "成核／澄清劑（山梨醇系）", "domain": "additive", "function": "提高 PP 透明度", "typical": "0.1–0.4 phr", "notes": "", "seed": true}, {"id": "seed-talc", "name": "滑石粉", "alias": "", "cas": "14807-96-6", "cls": "填料／成核", "domain": "additive", "function": "提高剛性與耐熱", "typical": "5–40 phr", "notes": "粒徑與表面處理對衝擊強度影響很大。", "seed": true}, {"id": "seed-caco3", "name": "碳酸鈣", "alias": "", "cas": "471-34-1", "cls": "填料", "domain": "additive", "function": "降成本、提高剛性", "typical": "5–60 phr", "notes": "吸濕與表面處理影響加工。", "seed": true}, {"id": "seed-ath", "name": "氫氧化鋁（ATH）", "alias": "", "cas": "21645-51-2", "cls": "阻燃劑（無機）", "domain": "additive", "function": "吸熱分解阻燃、抑煙", "typical": "30–65 wt%", "notes": "分解溫度約 200°C 左右，加工溫度受限。", "seed": true}, {"id": "seed-mdh", "name": "氫氧化鎂（MDH）", "alias": "", "cas": "1309-42-8", "cls": "阻燃劑（無機）", "domain": "additive", "function": "吸熱分解阻燃、抑煙", "typical": "40–65 wt%", "notes": "分解溫度較 ATH 高，適合較高加工溫度。", "seed": true}, {"id": "seed-app", "name": "聚磷酸銨（APP）", "alias": "", "cas": "68333-79-9", "cls": "阻燃劑（膨脹型磷氮系）", "domain": "additive", "function": "成炭阻燃", "typical": "15–30 wt%", "notes": "對水敏感，常需表面包覆。", "seed": true}, {"id": "seed-melamine", "name": "三聚氰胺", "alias": "", "cas": "108-78-1", "cls": "阻燃協效劑", "domain": "additive", "function": "氮系阻燃", "typical": "5–20 wt%", "notes": "", "seed": true}, {"id": "seed-dbdpe", "name": "DBDPE（十溴二苯乙烷）", "alias": "", "cas": "84852-53-9", "cls": "阻燃劑（溴系）", "domain": "additive", "function": "氣相阻燃", "typical": "10–20 wt%", "notes": "通常搭配三氧化二銻；各地區環保規範變化快，請查最新。", "seed": true}, {"id": "seed-sb2o3", "name": "三氧化二銻", "alias": "", "cas": "1309-64-4", "cls": "阻燃協效劑", "domain": "additive", "function": "與鹵素協同", "typical": "3–7 wt%", "notes": "", "seed": true}, {"id": "seed-tio2", "name": "二氧化鈦（金紅石）", "alias": "", "cas": "13463-67-7", "cls": "白色顏料", "domain": "colorant", "function": "遮蔽、白度、UV 屏蔽", "typical": "1–10 phr（色母粒可達 50% 以上）", "notes": "C.I. Pigment White 6（77891）。光催化活性高，長期戶外需選包覆級並搭配 HALS。", "seed": true}, {"id": "seed-pbk7", "name": "碳黑", "alias": "", "cas": "1333-86-4", "cls": "黑色顏料", "domain": "colorant", "function": "著色、UV 屏蔽、導電（特定級）", "typical": "0.5–3 phr（色母粒可達 40%）", "notes": "C.I. Pigment Black 7。分散難，細粒徑著色力強但吸油高。", "seed": true}, {"id": "seed-pb153", "name": "酞菁藍 15:3", "alias": "", "cas": "147-14-8", "cls": "有機顏料（酞菁）", "domain": "colorant", "function": "藍色著色", "typical": "0.05–1.0 phr", "notes": "C.I. Pigment Blue 15:3（銅酞菁）。耐熱耐候佳；在 HDPE 可能造成成核與翹曲，需評估。", "seed": true}, {"id": "seed-pg7", "name": "酞菁綠 7", "alias": "", "cas": "1328-53-6", "cls": "有機顏料（酞菁）", "domain": "colorant", "function": "綠色著色", "typical": "0.05–1.0 phr", "notes": "C.I. Pigment Green 7。耐熱耐候佳，同樣要留意 HDPE 翹曲。", "seed": true}, {"id": "seed-pv19", "name": "喹吖啶酮紫 19", "alias": "", "cas": "1047-16-1", "cls": "有機顏料（喹吖啶酮）", "domain": "colorant", "function": "紅紫色著色", "typical": "0.05–0.5 phr", "notes": "C.I. Pigment Violet 19。耐候佳。", "seed": true}, {"id": "seed-pr122", "name": "喹吖啶酮紅 122", "alias": "", "cas": "980-26-7", "cls": "有機顏料（喹吖啶酮）", "domain": "colorant", "function": "洋紅色著色", "typical": "0.05–0.5 phr", "notes": "C.I. Pigment Red 122。耐候與耐熱良好。", "seed": true}, {"id": "seed-pr254", "name": "DPP 紅 254", "alias": "", "cas": "122390-98-1", "cls": "有機顏料（DPP）", "domain": "colorant", "function": "鮮紅色著色", "typical": "0.1–1.0 phr", "notes": "C.I. Pigment Red 254。耐熱耐候佳。", "seed": true}, {"id": "seed-py83", "name": "雙芳基黃 83", "alias": "", "cas": "5567-15-7", "cls": "有機顏料（偶氮）", "domain": "colorant", "function": "黃色著色", "typical": "0.1–1.0 phr", "notes": "C.I. Pigment Yellow 83。耐熱有限，高溫加工可能分解，需確認加工溫度。", "seed": true}, {"id": "seed-py180", "name": "苯并咪唑酮黃 180", "alias": "", "cas": "77804-81-0", "cls": "有機顏料（偶氮縮合）", "domain": "colorant", "function": "黃色著色", "typical": "0.1–1.0 phr", "notes": "C.I. Pigment Yellow 180。耐熱較雙芳基黃好。", "seed": true}, {"id": "seed-pr101", "name": "氧化鐵紅 101", "alias": "", "cas": "1309-37-1", "cls": "無機顏料", "domain": "colorant", "function": "紅棕色著色", "typical": "0.5–5 phr", "notes": "C.I. Pigment Red 101。耐熱耐候佳，著色力較有機顏料低。", "seed": true}, {"id": "seed-py42", "name": "氧化鐵黃 42", "alias": "", "cas": "51274-00-1", "cls": "無機顏料", "domain": "colorant", "function": "黃色著色", "typical": "0.5–5 phr", "notes": "C.I. Pigment Yellow 42。高溫會轉紅，加工溫度要留意。", "seed": true}, {"id": "seed-pb29", "name": "群青藍 29", "alias": "", "cas": "57455-37-5", "cls": "無機顏料", "domain": "colorant", "function": "藍色著色、增白（抵銷黃變）", "typical": "0.2–2 phr", "notes": "C.I. Pigment Blue 29。耐熱好、耐酸差。", "seed": true}, {"id": "seed-sy93", "name": "溶劑黃 93", "alias": "", "cas": "4702-90-3", "cls": "溶劑染料", "domain": "colorant", "function": "透明著色（PS、PC、PET 等）", "typical": "0.01–0.2 phr", "notes": "可溶於樹脂，透明鮮豔；需評估遷移與昇華。", "seed": true}, {"id": "seed-sr135", "name": "溶劑紅 135", "alias": "", "cas": "71902-17-5", "cls": "溶劑染料", "domain": "colorant", "function": "透明著色", "typical": "0.01–0.2 phr", "notes": "耐熱佳，常用於工程塑膠。", "seed": true}, {"id": "seed-sb104", "name": "溶劑藍 104", "alias": "", "cas": "116-75-6", "cls": "溶劑染料", "domain": "colorant", "function": "透明著色", "typical": "0.01–0.2 phr", "notes": "", "seed": true}, {"id": "seed-sg3", "name": "溶劑綠 3", "alias": "", "cas": "128-80-3", "cls": "溶劑染料", "domain": "colorant", "function": "透明著色", "typical": "0.01–0.2 phr", "notes": "", "seed": true}];
  var RESTRICTED = [{"cas": "117-81-7", "name": "DEHP", "basis": "RoHS 限用鄰苯二甲酸酯；REACH SVHC", "note": "RoHS 限值通常為均質材料 0.1%"}, {"cas": "84-74-2", "name": "DBP", "basis": "RoHS 限用鄰苯二甲酸酯；REACH SVHC", "note": ""}, {"cas": "85-68-7", "name": "BBP", "basis": "RoHS 限用鄰苯二甲酸酯；REACH SVHC", "note": ""}, {"cas": "84-69-5", "name": "DIBP", "basis": "RoHS 限用鄰苯二甲酸酯；REACH SVHC", "note": ""}, {"cas": "1306-23-6", "name": "硫化鎘（鎘黃）", "basis": "含鎘：RoHS 限用；REACH 附件 XVII 限制塑膠中鎘", "note": "鎘系顏料已大量被有機顏料取代"}, {"cas": "7758-97-6", "name": "鉻酸鉛", "basis": "含鉛與六價鉻：RoHS 限用；REACH SVHC", "note": ""}, {"cas": "1344-37-2", "name": "鉛鉻黃（C.I. PY34）", "basis": "含鉛與六價鉻：RoHS 限用；REACH SVHC", "note": ""}, {"cas": "12656-85-8", "name": "鉬鉻紅（C.I. PR104）", "basis": "含鉛與六價鉻：RoHS 限用；REACH SVHC", "note": ""}, {"cas": "1163-19-5", "name": "十溴二苯醚（decaBDE）", "basis": "RoHS 限用 PBDE；POPs 公約", "note": ""}, {"cas": "36355-01-8", "name": "六溴聯苯（PBB）", "basis": "RoHS 限用", "note": ""}, {"cas": "25637-99-4", "name": "HBCD（六溴環十二烷）", "basis": "POPs 公約；REACH SVHC", "note": ""}, {"cas": "85535-84-8", "name": "短鏈氯化石蠟（C10-13）", "basis": "POPs 公約；REACH SVHC", "note": ""}, {"cas": "80-05-7", "name": "雙酚 A", "basis": "REACH SVHC", "note": "接觸食品與熱感應紙另有專門限制"}, {"cas": "25973-55-1", "name": "UV-328", "basis": "REACH SVHC（vPvB）", "note": "苯并三唑類紫外線吸收劑"}, {"cas": "3846-71-7", "name": "UV-320", "basis": "REACH SVHC（vPvB）", "note": ""}, {"cas": "3864-99-1", "name": "UV-327", "basis": "REACH SVHC（vPvB）", "note": ""}, {"cas": "36437-37-3", "name": "UV-350", "basis": "REACH SVHC（vPvB）", "note": ""}, {"cas": "1763-23-1", "name": "PFOS", "basis": "POPs 公約", "note": ""}, {"cas": "7440-43-9", "name": "鎘", "basis": "RoHS 限用元素", "note": ""}, {"cas": "7439-92-1", "name": "鉛", "basis": "RoHS 限用元素", "note": ""}, {"cas": "7439-97-6", "name": "汞", "basis": "RoHS 限用元素", "note": ""}, {"cas": "18540-29-9", "name": "六價鉻", "basis": "RoHS 限用元素", "note": ""}];


  function screenItems(items) {
    var table = {}; RESTRICTED.forEach(function (r) { table[r.cas] = r; });
    var hits = [], unknown = [];
    (items || []).forEach(function (it) {
      var cas = String((it || {}).cas || '').trim();
      if (!cas) { unknown.push((it && it.name) || ''); return; }
      var r = table[cas]; if (r) hits.push({ name: it.name || r.name, cas: cas, basis: r.basis, note: r.note });
    });
    return { hits: hits, no_cas: unknown.filter(Boolean), checked: (items || []).length, list_size: RESTRICTED.length,
      disclaimer: '這是內建的小型快篩清單（約 ' + RESTRICTED.length + ' 項），不完整也會過期；正式合規請查 ECHA 候選清單、各地區最新法規與供應商 SDS。' };
  }

  /* ───────── 實驗設計（DoE）───────── */
  function fNorm(f) {
    var kind = f.kind === 'cat' ? 'cat' : 'num', name = String(f.name || '').trim();
    if (!name) throw new Error('因子需要名稱');
    if (kind === 'cat') {
      var lv = (f.levels || []).map(String).filter(function (x) { return x.trim(); });
      if (lv.length < 2) throw new Error('類別因子「' + name + '」至少要有 2 個水準');
      return { name: name, kind: 'cat', levels: lv };
    }
    var lo = parseFloat(f.low), hi = parseFloat(f.high);
    if (!(hi > lo)) throw new Error('因子「' + name + '」的上限必須大於下限');
    return { name: name, kind: 'num', low: lo, high: hi };
  }
  function shuffle(arr, rng) { for (var i = arr.length - 1; i > 0; i--) { var j = Math.floor(rng() * (i + 1)); var t = arr[i]; arr[i] = arr[j]; arr[j] = t; } return arr; }
  function centerRow(fs) { var r = { _type: 'center' }; fs.forEach(function (f) { r[f.name] = f.kind === 'num' ? rnd4((f.low + f.high) / 2) : f.levels[0]; }); return r; }
  function makeDoe(factors, method, n, seed, center) {
    var fs = (factors || []).map(fNorm); if (!fs.length) throw new Error('請先定義至少一個因子');
    var rng = mulberry32(parseInt(seed || 7, 10)), rows = []; method = String(method || 'lhs').toLowerCase();
    if (method === 'lhs') {
      n = Math.max(2, Math.min(parseInt(n || 12, 10), 200));
      var best = null, bd = -1, tries = n <= 60 ? 300 : 60;
      for (var t = 0; t < tries; t++) {
        var cols = fs.map(function (f) {
          var perm = shuffle(Array.apply(null, Array(n)).map(function (_, i) { return i; }), rng);
          if (f.kind === 'num') return perm.map(function (p) { return (p + rng()) / n; });
          var k = f.levels.length; return perm.map(function (p) { return k > 1 ? Math.floor(p * k / n) / Math.max(1, k - 1) : 0; });
        });
        var md = 1e9;
        for (var i = 0; i < n; i++) for (var j = i + 1; j < n; j++) { var d = 0; for (var c = 0; c < cols.length; c++) { var df = cols[c][i] - cols[c][j]; d += df * df; } if (d < md) md = d; }
        if (md > bd) { bd = md; best = cols; }
      }
      for (var r = 0; r < n; r++) { var row = { _type: 'lhs' }; fs.forEach(function (f, ci) { row[f.name] = f.kind === 'num' ? rnd4(f.low + best[ci][r] * (f.high - f.low)) : f.levels[Math.round(best[ci][r] * (f.levels.length - 1))]; }); rows.push(row); }
    } else if (method === 'factorial') {
      var lv = fs.map(function (f) { return f.kind === 'num' ? [f.low, f.high] : f.levels; }), total = lv.reduce(function (a, l) { return a * l.length; }, 1);
      if (total > 512) throw new Error('全因子組合有 ' + total + ' 組，超過上限 512；請減少因子或改用拉丁超立方');
      var combos = [[]]; lv.forEach(function (l) { var nx = []; combos.forEach(function (c) { l.forEach(function (v) { nx.push(c.concat([v])); }); }); combos = nx; });
      combos.forEach(function (combo) { var row = { _type: 'factorial' }; fs.forEach(function (f, i) { row[f.name] = f.kind === 'num' ? rnd4(combo[i]) : combo[i]; }); rows.push(row); });
      for (var cc = 0; cc < Math.max(0, parseInt(center == null ? 1 : center, 10)); cc++) rows.push(centerRow(fs));
    } else if (method === 'ccd') {
      var nums = fs.filter(function (f) { return f.kind === 'num'; }), k2 = nums.length;
      if (k2 < 2 || k2 > 5) throw new Error('面心中心複合設計需要 2～5 個數值因子（目前 ' + k2 + ' 個）');
      var base = centerRow(fs), cube = [], nb = k2 <= 4 ? k2 : k2 - 1;
      for (var bits = 0; bits < Math.pow(2, nb); bits++) {
        var sg = []; for (var q = 0; q < nb; q++) sg.push(((bits >> q) & 1) ? 1 : -1);
        if (k2 === 5) sg.push(sg.reduce(function (a, s) { return a * s; }, 1));
        cube.push(sg);
      }
      cube.forEach(function (sg) { var row = Object.assign({}, base, { _type: 'factorial' }); nums.forEach(function (f, i) { row[f.name] = rnd4(sg[i] > 0 ? f.high : f.low); }); rows.push(row); });
      nums.forEach(function (f) { [-1, 1].forEach(function (s) { var row = Object.assign({}, base, { _type: 'axial' }); row[f.name] = rnd4(s > 0 ? f.high : f.low); rows.push(row); }); });
      for (var c3 = 0; c3 < Math.max(0, parseInt(center == null ? 3 : center, 10)); c3++) rows.push(Object.assign({}, base));
    } else throw new Error('不支援的設計方法：' + method);
    return { ok: true, method: method, n: rows.length, rows: rows, factors: fs };
  }

  /* ───────── 預測與最佳化 ───────── */
  function encode(fs, inputs) {
    var v = [];
    fs.forEach(function (f) {
      var x = inputs[f.name];
      if (f.kind === 'num') { var nx = parseFloat(x); if (isNaN(nx)) throw new Error('bad number'); v.push((nx - f.low) / (f.high - f.low)); }
      else f.levels.forEach(function (l) { v.push(String(x) === l ? 1 : 0); });
    });
    return v;
  }
  function decode(fs, vec) {
    var out = {}, i = 0;
    fs.forEach(function (f) {
      if (f.kind === 'num') { out[f.name] = rnd4(f.low + Math.max(0, Math.min(1, vec[i])) * (f.high - f.low)); i++; }
      else { var k = f.levels.length, seg = vec.slice(i, i + k), mx = Math.max.apply(null, seg); out[f.name] = f.levels[seg.indexOf(mx)]; i += k; }
    });
    return out;
  }
  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function isSet(v) { return v !== null && v !== undefined && v !== ''; }
  function desirability(y, t, ymin, ymax) {
    var goal = t.goal || 'max', lo = isSet(t.low) ? parseFloat(t.low) : ymin, hi = isSet(t.high) ? parseFloat(t.high) : ymax;
    if (hi <= lo) hi = lo + 1e-9;
    if (goal === 'min') return clamp01((hi - y) / (hi - lo));
    if (goal === 'target') {
      var tg = isSet(t.target) ? parseFloat(t.target) : (lo + hi) / 2;
      if (y <= tg) return tg > lo ? clamp01((y - lo) / (tg - lo)) : (y === tg ? 1 : 0);
      return hi > tg ? clamp01((hi - y) / (hi - tg)) : 0;
    }
    return clamp01((y - lo) / (hi - lo));
  }
  function overallD(outputs, targets, ranges) {
    var num = 0, den = 0;
    targets.forEach(function (t) {
      var v = outputs[t.name]; if (!isSet(v)) return; var y = parseFloat(v); if (isNaN(y)) return;
      var w = parseFloat(t.weight || 1), rg = ranges[t.name] || [y, y], d = desirability(y, t, rg[0], rg[1]);
      num += w * Math.log(Math.max(d, 0.01)); den += w;
    });
    return den > 0 ? Math.exp(num / den) : null;
  }
  function cholesky(A) {
    var n = A.length, L = []; for (var i = 0; i < n; i++) L.push(new Array(n).fill(0));
    for (i = 0; i < n; i++) for (var j = 0; j <= i; j++) {
      var s = A[i][j]; for (var k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) { if (s <= 1e-12) return null; L[i][i] = Math.sqrt(s); } else L[i][j] = s / L[j][j];
    }
    return L;
  }
  function fwd(L, b) { var n = b.length, x = new Array(n).fill(0); for (var i = 0; i < n; i++) { var s = b[i]; for (var k = 0; k < i; k++) s -= L[i][k] * x[k]; x[i] = s / L[i][i]; } return x; }
  function bwd(L, b) { var n = b.length, x = new Array(n).fill(0); for (var i = n - 1; i >= 0; i--) { var s = b[i]; for (var k = i + 1; k < n; k++) s -= L[k][i] * x[k]; x[i] = s / L[i][i]; } return x; }
  function rbfK(X, ls, nz) {
    var n = X.length, inv = ls.map(function (l) { return 1 / (2 * l * l); }), K = []; for (var i = 0; i < n; i++) K.push(new Array(n).fill(0));
    for (i = 0; i < n; i++) { for (var j = 0; j <= i; j++) { var s = 0; for (var d = 0; d < inv.length; d++) { var df = X[i][d] - X[j][d]; s += inv[d] * df * df; } var v = Math.exp(-s); K[i][j] = v; K[j][i] = v; } K[i][i] += nz; }
    return K;
  }
  function lml(X, ys, ls, nz) {
    var L = cholesky(rbfK(X, ls, nz)); if (!L) return null;
    var a = bwd(L, fwd(L, ys)), s = 0, ld = 0; for (var i = 0; i < ys.length; i++) { s += ys[i] * a[i]; ld += Math.log(L[i][i]); }
    return [-0.5 * s - ld, L, a];
  }
  function gpPure(X, y, Xp, wantDiag) {
    var n = X.length, d = X[0].length, m = y.reduce(function (a, b) { return a + b; }, 0) / n;
    var sdv = Math.sqrt(y.reduce(function (a, v) { return a + (v - m) * (v - m); }, 0) / n) || 1, ys = y.map(function (v) { return (v - m) / sdv; }), best = null, i, j;
    [0.15, 0.25, 0.4, 0.7, 1.2, 2.0, 3.5].forEach(function (l0) { [1e-4, 1e-3, 1e-2, 5e-2, 2e-1].forEach(function (nz) {
      var ls = new Array(d).fill(l0), r = lml(X, ys, ls, nz); if (r && (best === null || r[0] > best[0])) best = [r[0], ls, nz, r[1], r[2]]; }); });
    if (!best) throw new Error('高斯過程矩陣無法分解（資料點可能重複）');
    if (n >= 6 && d <= 12 && n <= 120) {
      for (var it = 0; it < 2; it++) {
        var improved = false;
        for (j = 0; j < d; j++) [0.4, 0.7, 1.5, 2.5].forEach(function (mult) {
          var ls = best[1].slice(); ls[j] = Math.min(10, Math.max(0.05, ls[j] * mult)); var r = lml(X, ys, ls, best[2]);
          if (r && r[0] > best[0] + 1e-6) { best = [r[0], ls, best[2], r[1], r[2]]; improved = true; } });
        [best[2] * 0.3, best[2] * 3].forEach(function (nz0) {
          var nz = Math.min(Math.max(nz0, 1e-5), 0.5), r = lml(X, ys, best[1], nz);
          if (r && r[0] > best[0] + 1e-6) { best = [r[0], best[1], nz, r[1], r[2]]; improved = true; } });
        if (!improved) break;
      }
    }
    var ls2 = best[1], nz2 = best[2], L = best[3], alpha = best[4], inv = ls2.map(function (l) { return 1 / (2 * l * l); }), mu = [], sd = [];
    Xp.forEach(function (p) {
      var ks = new Array(n); for (i = 0; i < n; i++) { var s = 0; for (var dd = 0; dd < d; dd++) { var df = p[dd] - X[i][dd]; s += inv[dd] * df * df; } ks[i] = Math.exp(-s); }
      var mm = 0; for (i = 0; i < n; i++) mm += ks[i] * alpha[i]; mu.push(mm * sdv + m);
      var v = fwd(L, ks), q = 0; for (i = 0; i < n; i++) q += v[i] * v[i]; sd.push(Math.sqrt(Math.max(1 - q + nz2, 1e-12)) * sdv);
    });
    var res = { mu: mu, sd: sd, engine: 'pure' };
    if (wantDiag) {
      var Lk = cholesky(rbfK(X, ls2, nz2));
      if (Lk) {
        var diag = []; for (i = 0; i < n; i++) { var e = new Array(n).fill(0); e[i] = 1; diag.push(bwd(Lk, fwd(Lk, e))[i]); }
        var loo = ys.map(function (v, k) { return v - alpha[k] / diag[k]; }), my = ys.reduce(function (a, b) { return a + b; }, 0) / n;
        var sst = ys.reduce(function (a, v) { return a + (v - my) * (v - my); }, 0) || 1, sse = ys.reduce(function (a, v, k) { return a + (v - loo[k]) * (v - loo[k]); }, 0);
        res.r2_loo = round(1 - sse / sst, 3);
      }
      res.importance = ls2.map(function (l) { return 1 / l; });
    }
    return res;
  }
  function normCdf(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }
  function normPdf(z) { return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI); }
  function erf(x) {   // Abramowitz-Stegun 7.1.26 的高精度版本（Numerical Recipes erfc Chebyshev）
    var z = Math.abs(x), t = 1 / (1 + 0.5 * z);
    var r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
    return x >= 0 ? 1 - r : r - 1;
  }
  function sqd(a, b) { var s = 0; for (var i = 0; i < a.length; i++) s += (a[i] - b[i]) * (a[i] - b[i]); return s; }
  function optimize(factors, targets, runs, nSuggest, seed) {
    var fs = (factors || []).map(fNorm), tg = (targets || []).filter(function (t) { return String(t.name || '').trim(); });
    if (!fs.length) throw new Error('請先定義因子'); if (!tg.length) throw new Error('請先定義目標（要最佳化的性能）');
    nSuggest = Math.max(1, Math.min(parseInt(nSuggest || 5, 10), 12)); var rng = mulberry32(parseInt(seed || 11, 10)), ranges = {};
    tg.forEach(function (t) { var vals = []; (runs || []).forEach(function (r) { var v = parseFloat((r.outputs || {})[t.name]); if (!isNaN(v)) vals.push(v); }); if (vals.length) ranges[t.name] = [Math.min.apply(null, vals), Math.max.apply(null, vals)]; });
    var X = [], D = [], kept = [];
    (runs || []).forEach(function (r) { var vec; try { vec = encode(fs, r.inputs || {}); } catch (e) { return; } var dv = overallD(r.outputs || {}, tg, ranges); if (dv === null) return; X.push(vec); D.push(dv); kept.push(r); });
    var out = { ok: true, data_n: X.length, warnings: [] };
    if (X.length < 4) {
      var dd = makeDoe(fs, 'lhs', Math.max(nSuggest, 6), seed);
      out.fallback = 'doe'; out.suggestions = dd.rows.slice(0, nSuggest).map(function (r) { var inp = {}; Object.keys(r).forEach(function (k) { if (k !== '_type') inp[k] = r[k]; }); return { inputs: inp, reason: '資料不足（需要至少 4 筆有結果的實驗），先用拉丁超立方探索' }; });
      out.warnings.push('有效實驗只有 ' + X.length + ' 筆；至少要 4 筆（建議 ≥ 因子數×3）才能建立模型。'); out.engine = 'doe'; return out;
    }
    if (X.length < fs.length * 3) out.warnings.push('實驗筆數（' + X.length + '）少於因子數×3（' + (fs.length * 3) + '），模型不確定度會偏大，建議先補做 DoE。');
    var pool = [];
    for (var i = 0; i < 1000; i++) { var vec = []; fs.forEach(function (f) { if (f.kind === 'num') vec.push(rng()); else { var k = f.levels.length, hot = Math.floor(rng() * k); for (var q = 0; q < k; q++) vec.push(q === hot ? 1 : 0); } }); pool.push(vec); }
    var g = gpPure(X, D, pool, true), bestD = Math.max.apply(null, D), xi = 0.01, cand = [];
    pool.forEach(function (p, ix) { var mu = g.mu[ix], sd = Math.max(g.sd[ix], 1e-9), z = (mu - bestD - xi) / sd; cand.push([(mu - bestD - xi) * normCdf(z) + sd * normPdf(z), mu, sd, ix]); });
    cand.sort(function (a, b) { return b[0] - a[0]; });
    function far(v, others, thr) { thr = thr || 0.15; return others.every(function (o) { return Math.sqrt(sqd(v, o)) >= thr; }); }
    var chosen = [];
    for (i = 0; i < cand.length; i++) { if (chosen.length >= nSuggest) break; var c = cand[i]; if (far(pool[c[3]], X) && far(pool[c[3]], chosen.map(function (x) { return pool[x[3]]; }))) chosen.push(c); }
    if (chosen.length >= 3) {
      var used = chosen.map(function (x) { return x[3]; }), rest = cand.filter(function (c) { return used.indexOf(c[3]) < 0; }).sort(function (a, b) { return b[2] - a[2]; });
      for (i = 0; i < rest.length; i++) { var cr = rest[i]; if (far(pool[cr[3]], X) && far(pool[cr[3]], chosen.slice(0, -1).map(function (x) { return pool[x[3]]; }))) { chosen[chosen.length - 1] = [cr[0], cr[1], cr[2], cr[3]]; break; } }
    }
    var sug = chosen.map(function (c, k) { return { inputs: decode(fs, pool[c[3]]), D_pred: round(c[1], 3), D_sd: round(c[2], 3), ei: round(c[0], 4), reason: (chosen.length >= 3 && k === chosen.length - 1) ? '探索（模型最不確定）' : '期望改善量高', _x: pool[c[3]] }; });
    tg.forEach(function (t) {
      var xs = [], ys = []; kept.forEach(function (r) { var v = parseFloat((r.outputs || {})[t.name]); if (isNaN(v)) return; try { xs.push(encode(fs, r.inputs || {})); ys.push(v); } catch (e) { /* */ } });
      if (xs.length >= 4 && sug.length) { var tr = gpPure(xs, ys, sug.map(function (s) { return s._x; }), false); sug.forEach(function (s, k) { s.pred = s.pred || {}; s.pred[t.name] = { mean: round(tr.mu[k], 4), sd: round(tr.sd[k], 4) }; }); }
    });
    sug.forEach(function (s) { delete s._x; });
    var impRaw = g.importance || [], imp = [], p0 = 0;
    fs.forEach(function (f) { var k = f.kind === 'num' ? 1 : f.levels.length; imp.push(Math.max.apply(null, impRaw.slice(p0, p0 + k).concat([0]))); p0 += k; });
    var tot = imp.reduce(function (a, b) { return a + b; }, 0) || 1;
    out.suggestions = sug; out.engine = 'pure'; out.r2_loo = g.r2_loo == null ? null : g.r2_loo; out.best_D = round(bestD, 3);
    out.importance = fs.map(function (f, ix) { return { name: f.name, value: round(imp[ix] / tot, 3) }; });
    if (g.r2_loo != null && g.r2_loo < 0.3) out.warnings.push('留一法 R² 只有 ' + g.r2_loo.toFixed(2) + '：模型目前對資料的預測力低，建議把建議點當作「下一批探索」，不要當成可信的最佳配方。');
    return out;
  }

  /* ───────── 對外 ───────── */
  var API = {
    version: VERSION, KINDS: KINDS, SOURCES: SOURCES, KEY_FIELDS: KEY_FIELDS,
    store: { list: storeList, get: storeGet, put: storePut, del: storeDelete, dump: storeDump, apply: storeApply, setAdapter: setAdapter, adapterName: function () { return getAdapter().name; }, dir: async function () { var a = getAdapter(); if (a.init) await a.init(); return a.dir ? a.dir() : null; } },
    keys: { load: loadKeys, save: saveKeys },
    search: runSearch, resolve: pubchemResolve, ghs: pubchemGhs,
    watch: { run: watchRun, tick: watchTick, start: startScheduler, inbox: watchInbox, markRead: watchMarkRead },
    color: colorCompare, labToHex: labToHex, de2000: de2000, de76: de76, seed: function () { return clone(SEED_MATERIALS); }, restricted: function () { return clone(RESTRICTED); }, screen: screenItems,
    doe: makeDoe, desirability: desirability, overallD: overallD, optimize: optimize, newId: newId,
    _t: { gpPure: gpPure, parseOpenalex: parseOpenalex, parseS2: parseS2, parseCrossref: parseCrossref, parseArxiv: parseArxiv, parsePubmed: parsePubmed, parseLens: parseLens, parseEpoBiblio: parseEpoBiblio, parsePatentsview: parsePatentsview, parseGhs: parseGhs, openalexAbstract: openalexAbstract, clean: clean, dedupeKeys: dedupeKeys, erf: erf, encode: encode, decode: decode, mulberry32: mulberry32 }
  };
  root.NovaResearchCore = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);

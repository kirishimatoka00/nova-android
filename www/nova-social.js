/* ═══════════════════════════════════════════════════════════════════════
   nova-social.js — NOVA Android「社群近況研究」：某個主題「最近 N 天」在 Reddit／Hacker News／GitHub／YouTube／Polymarket 大家怎麼說
   （跟 index.html 放同一個資料夾 www/）
   版本：v1.0.0
   版本紀錄（只記這個檔案自己的變更）：
   v1.0.0 - App v2.6.156。新檔，JS 移植桌面 python-engine/nova_social.py v1.0.0（desktop-patch v3.145.0；概念借鏡 mvanhorn/last30days-skill）。
            手機沒有 Python 引擎，改成在 App 裡直接連各平台（App 內 GET 走 CapacitorHttp 原生請求，沒有瀏覽器 CORS 問題，並帶 NOVA 自己的 User-Agent）。
            ① 來源（全部免金鑰）：
               reddit     — www.reddit.com/search.json（t=day/week/month），前 3 篇再抓最高讚的 3 則留言；Reddit 常對未登入請求回 429，失敗只寫進 source_notes。
               hackernews — hn.algolia.com（只取時間窗內的 story，含分數與留言數）。
               github     — api.github.com/search/repositories（時間窗內新建、依星數排序；不足再補「時間窗內有更新」的）。未登入每分鐘 10 次。
               youtube    — 【和桌面不同】桌面用 yt-dlp；手機直接讀 YouTube 搜尋頁（用 YouTube 自己的「上傳日期」篩選：今天／本週／本月）裡的
                            ytInitialData，取標題、頻道、觀看數、上傳時間（「3 天前」這類相對時間換算成日期）。YouTube 改版就可能讀不到，失敗只寫進 source_notes。
               polymarket — 沿用 nova-insight-core.js 的 NovaInsightCore.predmarkets（同一個 gamma-api 公開搜尋）。
            ② 排序與合併照搬桌面：每筆分數＝0.5×互動（各來源內取 log 後正規化）＋0.3×相關度（查詢詞命中比例，中文用雙字詞）＋0.2×新鮮度；
               同一件事在不同平台出現（同網址或標題高度相似）併成一筆，標記 also_on。結果在記憶體快取 15 分鐘。
            ③ AI 工具 social_recent（declarations／run／format，nova-app-main.js v1.5.15 接進內建工具）：
               looksLikeSocial（同桌面 _NOVA_SOCIAL_TOOL_RX）＝工具迴圈已經在跑時才宣告這個工具；wantsAuto（較嚴格：討論／網友／口碑／Reddit…）
               ＝即使「自動使用工具」沒開，Gemini／Grok 也走工具迴圈。沒提到就不送給模型，不增加一般對話的 token。
            ④ 設定 → 整合 → 工具：內建工具清單多「社群近況研究」開關（builtin:social_recent），下面多一張「社群近況研究」試搜卡片
               （主題、英文關鍵字、天數、來源，直接看排序結果與各平台成功／失敗原因，確認哪些平台在你的網路連得到）。
            【沒有移植的】X／TikTok／Instagram（要付費 API 或登入）、Bluesky（搜尋要登入）——和桌面相同。
            【誠實限制】沙盒連不到 Reddit／HN／GitHub／YouTube／Polymarket；各來源的欄位對照照桌面實作與官方回應格式寫成，排序、合併、YouTube 解析
               用假資料測過，沒有在真機連線驗證。OpenAI、DeepSeek 等不走工具迴圈的模型不會自動查（可在設定卡片手動試搜）。
   對外：window.NovaSocial = { version, search(q, opt), aiSearch(args), looksLikeSocial(text), wantsAuto(text), declarations(), run(name, args), format(r), mount(), _t }
   ═══════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  var VERSION = '1.0.0';
  var SOURCES = ['reddit', 'hackernews', 'github', 'youtube', 'polymarket'];
  var SRC_ZH = { reddit: 'Reddit', hackernews: 'Hacker News', github: 'GitHub', youtube: 'YouTube', polymarket: 'Polymarket' };
  var UA = 'NOVA-Android/1.0 (personal research assistant; +https://github.com/kirishimatoka00/nova-android)';
  var BROWSER_UA = 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36';
  var TIMEOUT = 12000, CACHE_TTL = 900e3;
  var CACHE = {};

  function SocialError(msg) { this.message = msg; this.social = true; }

  /* ───────── HTTP ───────── */
  function withTimeout(p, ms) {
    return new Promise(function (res, rej) {
      var t = setTimeout(function () { rej(new Error('逾時（' + Math.round(ms / 1000) + ' 秒）')); }, ms);
      p.then(function (v) { clearTimeout(t); res(v); }, function (e) { clearTimeout(t); rej(e); });
    });
  }
  function nativeHttp() { var cp = root.Capacitor; return cp && cp.isNativePlatform && cp.isNativePlatform() && cp.Plugins && cp.Plugins.CapacitorHttp; }
  function errText(status) {
    if (status === 429) return '被限流（HTTP 429），請過幾分鐘再試';
    if (status === 403) return '被拒絕（HTTP 403）';
    return 'HTTP ' + status;
  }
  async function httpText(url, headers) {
    var h = Object.assign({ 'User-Agent': UA, 'Accept': 'application/json' }, headers || {});
    var CH = nativeHttp();
    if (CH) {
      var nr = await withTimeout(CH.request({ method: 'GET', url: url, headers: h, responseType: 'text', connectTimeout: TIMEOUT, readTimeout: TIMEOUT }), TIMEOUT + 2000);
      if (nr.status < 200 || nr.status >= 300) throw new Error(errText(nr.status));
      return typeof nr.data === 'string' ? nr.data : JSON.stringify(nr.data);
    }
    var hh = Object.assign({}, h); delete hh['User-Agent'];   // 瀏覽器不允許改 UA
    var r = await withTimeout(root.fetch(url, { headers: hh }), TIMEOUT);
    if (!r.ok) throw new Error(errText(r.status));
    return await r.text();
  }
  async function httpJson(url, headers) {
    var t = await httpText(url, headers);
    try { return JSON.parse(t); } catch (e) { throw new Error('回應不是 JSON：' + String(t).replace(/\s+/g, ' ').slice(0, 60)); }
  }
  function qs(o) { return Object.keys(o).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(o[k]); }).join('&'); }
  function clip(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length <= n ? s : s.slice(0, n - 1) + '…'; }
  function nowS() { return Date.now() / 1000; }

  /* ───────── 文字比對（同桌面） ───────── */
  var STOP = { the: 1, and: 1, 'for': 1, 'with': 1, of: 1, to: 1, 'in': 1, on: 1, is: 1, a: 1, an: 1 };
  function tokens(q) {
    q = String(q || '').toLowerCase();
    var out = {};
    (q.match(/[a-z0-9][a-z0-9+#.\-]*/g) || []).forEach(function (w) { w = w.replace(/^[.\-]+|[.\-]+$/g, ''); if (w.length >= 2 && !STOP[w]) out[w] = 1; });
    (q.match(/[㐀-鿿豈-﫿]+/g) || []).forEach(function (run) {
      if (run.length === 1) out[run] = 1;
      for (var i = 0; i < run.length - 1; i++) out[run.slice(i, i + 2)] = 1;
    });
    return Object.keys(out);
  }
  function relevance(qtok, text) {
    if (!qtok.length) return 0.5;
    var t = String(text || '').toLowerCase(), hit = 0;
    qtok.forEach(function (k) { if (t.indexOf(k) >= 0) hit++; });
    return hit / qtok.length;
  }
  function titleKey(s) { var o = {}; (String(s || '').toLowerCase().match(/[a-z0-9]{3,}|[㐀-鿿]{2}/g) || []).forEach(function (k) { o[k] = 1; }); return o; }
  function similar(a, b) {
    var ka = titleKey(a), kb = titleKey(b), la = Object.keys(ka), lb = Object.keys(kb);
    if (la.length < 3 || lb.length < 3) return false;
    var inter = 0, uni = {}; la.forEach(function (k) { uni[k] = 1; if (kb[k]) inter++; }); lb.forEach(function (k) { uni[k] = 1; });
    return inter / Object.keys(uni).length >= 0.6;
  }
  function normUrl(u) {
    u = String(u || '').trim().toLowerCase();
    return u.replace(/^https?:\/\/(www\.|m\.|old\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  }

  /* ───────── 各來源 ───────── */
  function redditT(days) { return days <= 1 ? 'day' : days <= 7 ? 'week' : days <= 31 ? 'month' : 'year'; }
  async function fetchReddit(q, days, n) {
    var d = await httpJson('https://www.reddit.com/search.json?' + qs({ q: q, sort: 'relevance', t: redditT(days), limit: Math.min(50, n * 2), raw_json: 1, include_over_18: 'off' }));
    var cutoff = nowS() - days * 86400, items = [];
    (((d || {}).data || {}).children || []).forEach(function (ch) {
      var p = (ch && ch.data) || {};
      if (p.over_18 || p.stickied) return;
      var ts = parseFloat(p.created_utc || 0);
      if (ts && ts < cutoff) return;
      var up = parseInt(p.score || 0, 10) || 0, nc = parseInt(p.num_comments || 0, 10) || 0;
      items.push({ source: 'reddit', id: p.id, title: clip(p.title, 300), url: 'https://www.reddit.com' + (p.permalink || ''),
        external_url: p.url_overridden_by_dest || '', community: 'r/' + (p.subreddit || ''), author: p.author || '', created: ts || null,
        metrics: { upvotes: up, comments: nc }, engagement: up + 2 * nc, snippet: clip(p.selftext, 400) });
    });
    items.sort(function (a, b) { return b.engagement - a.engagement; });
    items = items.slice(0, n);
    await Promise.all(items.slice(0, 3).map(async function (it) {   // 前 3 篇抓最高讚留言
      try {
        var cd = await httpJson('https://www.reddit.com/comments/' + encodeURIComponent(it.id) + '.json?' + qs({ sort: 'top', limit: 5, depth: 1, raw_json: 1 }));
        var tops = [];
        if (Array.isArray(cd) && cd.length > 1) {
          (((cd[1] || {}).data || {}).children || []).forEach(function (c) {
            if (!c || c.kind !== 't1') return;
            var cdat = c.data || {}, body = cdat.body || '';
            if (!body || body === '[deleted]' || body === '[removed]' || cdat.stickied) return;
            tops.push({ upvotes: parseInt(cdat.score || 0, 10) || 0, text: clip(body, 280) });
          });
        }
        it.top_comments = tops.sort(function (a, b) { return b.upvotes - a.upvotes; }).slice(0, 3);
      } catch (e) { /* 留言抓不到不影響 */ }
    }));
    return items;
  }

  async function fetchHackernews(q, days, n) {
    var since = Math.floor(nowS() - days * 86400);
    var d = await httpJson('https://hn.algolia.com/api/v1/search?' + qs({ query: q, tags: 'story', numericFilters: 'created_at_i>' + since, hitsPerPage: Math.min(50, n * 2) }));
    var items = [];
    ((d || {}).hits || []).forEach(function (h) {
      var title = h.title || h.story_title || ''; if (!title) return;
      var pts = parseInt(h.points || 0, 10) || 0, nc = parseInt(h.num_comments || 0, 10) || 0;
      items.push({ source: 'hackernews', id: h.objectID, title: clip(title, 300), url: 'https://news.ycombinator.com/item?id=' + h.objectID,
        external_url: h.url || '', community: 'Hacker News', author: h.author || '', created: parseFloat(h.created_at_i || 0) || null,
        metrics: { points: pts, comments: nc }, engagement: pts + 1.5 * nc, snippet: clip(String(h.story_text || '').replace(/<[^>]+>/g, ' '), 400) });
    });
    items.sort(function (a, b) { return b.engagement - a.engagement; });
    return items.slice(0, n);
  }

  function isoTs(s) { var t = Date.parse(s || ''); return isNaN(t) ? null : t / 1000; }
  async function fetchGithub(q, days, n) {
    var since = new Date((nowS() - days * 86400) * 1000).toISOString().slice(0, 10);
    var hdr = { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    var seen = {}, items = [], quals = ['created:>' + since, 'pushed:>' + since];
    for (var qi = 0; qi < quals.length; qi++) {
      if (items.length >= Math.max(5, Math.floor(n / 2))) break;
      var d = await httpJson('https://api.github.com/search/repositories?' + qs({ q: q + ' in:name,description,topics ' + quals[qi], sort: 'stars', order: 'desc', per_page: Math.min(30, n) }), hdr);
      ((d || {}).items || []).forEach(function (r) {
        var fn = r.full_name; if (!fn || seen[fn]) return; seen[fn] = 1;
        var created = isoTs(r.created_at), st = parseInt(r.stargazers_count || 0, 10) || 0, fk = parseInt(r.forks_count || 0, 10) || 0;
        items.push({ source: 'github', id: fn, title: fn + (r.description ? ' — ' + clip(r.description, 200) : ''), url: r.html_url || ('https://github.com/' + fn),
          external_url: r.homepage || '', community: r.language || 'GitHub', author: (r.owner || {}).login || '', created: isoTs(r.pushed_at) || created,
          metrics: { stars: st, forks: fk, new_in_window: !!(created && created >= nowS() - days * 86400) }, engagement: st + 2 * fk, snippet: '' });
      });
    }
    items.sort(function (a, b) { return b.engagement - a.engagement; });
    return items.slice(0, n);
  }

  // YouTube：搜尋頁的 ytInitialData（桌面用 yt-dlp；手機沒有，直接解析頁面）
  var YT_SP = { 1: 'EgIIAg%3D%3D', 7: 'EgIIAw%3D%3D', 31: 'EgIIBA%3D%3D' };   // 上傳日期：今天／本週／本月
  function ytText(o) { if (!o) return ''; if (o.simpleText) return o.simpleText; if (o.runs) return o.runs.map(function (r) { return r.text || ''; }).join(''); return ''; }
  function ytNum(s) {
    s = String(s || '').replace(/,/g, '').toLowerCase();
    var m = /([\d.]+)\s*([kmb])?/.exec(s); if (!m) return null;
    var v = parseFloat(m[1]); if (isNaN(v)) return null;
    return Math.round(v * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1));
  }
  function ytAgo(s) {   // "3 days ago" → 秒數時間戳
    var m = /(\d+)\s*(second|minute|hour|day|week|month|year)/i.exec(String(s || '')); if (!m) return null;
    var mul = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000, year: 31536000 }[m[2].toLowerCase()];
    return nowS() - parseInt(m[1], 10) * mul;
  }
  function ytDur(s) { var p = String(s || '').split(':').map(function (x) { return parseInt(x, 10); }); if (!p.length || p.some(isNaN)) return null; return p.reduce(function (a, b) { return a * 60 + b; }, 0); }
  function parseYtHtml(html, n) {
    var i = html.indexOf('ytInitialData'); if (i < 0) throw new SocialError('YouTube 頁面裡找不到搜尋結果（可能改版或要求同意 Cookie）');
    var s = html.indexOf('{', i); if (s < 0) throw new SocialError('YouTube 頁面格式不符');
    var depth = 0, inStr = false, esc = false, e = -1;
    for (var k = s; k < html.length; k++) {
      var c = html.charCodeAt(k);
      if (inStr) { if (esc) esc = false; else if (c === 92) esc = true; else if (c === 34) inStr = false; continue; }
      if (c === 34) inStr = true; else if (c === 123) depth++; else if (c === 125) { depth--; if (depth === 0) { e = k; break; } }
    }
    if (e < 0) throw new SocialError('YouTube 頁面格式不符');
    var data; try { data = JSON.parse(html.slice(s, e + 1)); } catch (er) { throw new SocialError('YouTube 搜尋結果解析失敗'); }
    var vids = [];
    (function walk(o, d) {
      if (!o || typeof o !== 'object' || d > 40 || vids.length >= n * 2) return;
      if (o.videoRenderer && o.videoRenderer.videoId) { vids.push(o.videoRenderer); return; }
      if (Array.isArray(o)) { for (var a = 0; a < o.length; a++) walk(o[a], d + 1); return; }
      for (var key in o) if (Object.prototype.hasOwnProperty.call(o, key)) walk(o[key], d + 1);
    })(data, 0);
    return vids.map(function (v) {
      var views = ytNum(ytText(v.viewCountText)), ch = ytText(v.ownerText) || ytText(v.longBylineText) || 'YouTube';
      var snip = ''; try { snip = ytText(((v.detailedMetadataSnippets || [])[0] || {}).snippetText) || ytText(v.descriptionSnippet); } catch (er) { /* */ }
      return { source: 'youtube', id: v.videoId, title: clip(ytText(v.title), 300), url: 'https://www.youtube.com/watch?v=' + v.videoId, external_url: '',
        community: ch, author: ch, created: ytAgo(ytText(v.publishedTimeText)),
        metrics: { views: views, duration_s: ytDur(ytText(v.lengthText)) }, engagement: views ? views / 100 : 0, snippet: clip(snip, 300) };
    });
  }
  async function fetchYoutube(q, days, n) {
    var key = days <= 1 ? 1 : days <= 7 ? 7 : 31;
    var html = await httpText('https://www.youtube.com/results?search_query=' + encodeURIComponent(q).replace(/%20/g, '+') + '&sp=' + YT_SP[key] + '&hl=en&gl=US',
      { 'User-Agent': BROWSER_UA, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.8' });
    var items = parseYtHtml(html, n);
    items.sort(function (a, b) { return b.engagement - a.engagement; });
    return items.slice(0, n);
  }

  async function fetchPolymarket(q, days, n) {
    var IC = root.NovaInsightCore;
    if (!IC || typeof IC.predmarkets !== 'function') throw new SocialError('Project Insight 模組沒有載入，略過 Polymarket');
    var d = await IC.predmarkets(String(q).slice(0, 200));
    return ((d && d.markets) || []).slice(0, n).map(function (m) {
      var vol = m.volume || 0;
      return { source: 'polymarket', id: m.url || m.question, title: clip(m.question, 300), url: m.url || '', external_url: '', community: 'Polymarket', author: '',
        created: null, metrics: { probability_yes: m.yes, volume_usd: vol, ends: m.end }, engagement: (parseFloat(vol) || 0) / 1000, snippet: '' };
    });
  }

  var FETCHERS = { reddit: fetchReddit, hackernews: fetchHackernews, github: fetchGithub, youtube: fetchYoutube, polymarket: fetchPolymarket };

  /* ───────── 排序與合併（同桌面） ───────── */
  function scoreItems(items, qtok, days, now) {
    now = now || nowS();
    var bySrc = {};
    items.forEach(function (it) { (bySrc[it.source] = bySrc[it.source] || []).push(it); });
    Object.keys(bySrc).forEach(function (src) {
      var arr = bySrc[src], mx = 0;
      arr.forEach(function (x) { mx = Math.max(mx, Math.log1p(Math.max(0, +x.engagement || 0))); });
      mx = mx || 1;
      arr.forEach(function (x) {
        var eng = Math.log1p(Math.max(0, +x.engagement || 0)) / mx;
        var rel = relevance(qtok, x.title + ' ' + (x.snippet || '') + ' ' + (x.community || ''));
        var rec = x.created ? Math.exp(-Math.max(0, (now - x.created) / 86400) / Math.max(1, days / 2)) : 0.5;
        x.score = Math.round((0.5 * eng + 0.3 * rel + 0.2 * rec) * 1e4) / 1e4;
        x._rel = rel;
      });
    });
    return items;
  }
  function mergeDupes(items) {
    var out = [];
    items.slice().sort(function (a, b) { return b.score - a.score; }).forEach(function (it) {
      var keys = [normUrl(it.url), normUrl(it.external_url)].filter(Boolean), dup = null;
      for (var i = 0; i < out.length; i++) {
        var o = out[i], ok = [normUrl(o.url), normUrl(o.external_url)].filter(Boolean);
        if (keys.some(function (k) { return ok.indexOf(k) >= 0; }) || similar(it.title, o.title)) { dup = o; break; }
      }
      if (!dup) out.push(it); else (dup.also_on = dup.also_on || []).push({ source: it.source, url: it.url, metrics: it.metrics });
    });
    return out;
  }
  function ymd(ts) { return new Date(ts * 1000).toISOString().slice(0, 10); }

  async function search(query, opt) {
    opt = opt || {};
    query = String(query || '').trim();
    if (!query) throw new SocialError('缺少 query（要查的主題）');
    if (query.length > 200) throw new SocialError('query 太長（最多 200 字）');
    var days = parseInt(opt.days, 10); days = isNaN(days) ? 30 : Math.max(1, Math.min(31, days));
    var limit = parseInt(opt.limit, 10); limit = isNaN(limit) ? 25 : Math.max(5, Math.min(60, limit));
    var srcs = (Array.isArray(opt.sources) ? opt.sources : []).filter(function (s) { return SOURCES.indexOf(s) >= 0; });
    if (!srcs.length) srcs = SOURCES.slice();
    var per = Math.max(6, Math.min(20, limit));
    var qEn = String(opt.en_query || '').trim() || query;
    var ck = JSON.stringify([query, qEn, days, srcs.slice().sort(), limit]);
    var hit = CACHE[ck];
    if (hit && Date.now() - hit.at < CACHE_TTL) return Object.assign({}, hit.data, { cached: true });
    var now = nowS(), notes = {}, results = [];
    // 國際社群多半用英文：一律先用英文查詢；Reddit／YouTube 沒結果再用原文
    await Promise.all(srcs.map(async function (src) {
      try {
        var arr = await FETCHERS[src](qEn, days, per);
        if (!arr.length && (src === 'reddit' || src === 'youtube') && qEn !== query) arr = await FETCHERS[src](query, days, per);
        results = results.concat(arr); notes[src] = arr.length + ' 筆';
      } catch (e) { notes[src] = String((e && e.message) || e).slice(0, 160); }
    }));
    var qtok = tokens(query).concat(tokens(qEn)).filter(function (k, i, a) { return a.indexOf(k) === i; });
    scoreItems(results, qtok, days, now);
    var rel = results.filter(function (r) { return r._rel > 0 || r.source === 'polymarket'; });
    var merged = mergeDupes(rel.length ? rel : results).slice(0, limit);
    merged.forEach(function (r) { delete r._rel; if (r.created) r.date = ymd(r.created); });
    var out = { ok: true, query: query, en_query: qEn, days: days, window_start: ymd(now - days * 86400), sources: srcs, source_notes: notes,
      count: merged.length, items: merged, fetched_at: Math.floor(now),
      note: '依互動數（讚、留言、星數、觀看、下注金額）＋相關度＋新鮮度排序；同一件事在多個平台出現會併成一筆（also_on）。Polymarket 的機率是市場下注傾向，不是事實。' };
    var ks = Object.keys(CACHE); if (ks.length > 50) ks.sort(function (a, b) { return CACHE[a].at - CACHE[b].at; }).slice(0, 25).forEach(function (k) { delete CACHE[k]; });
    CACHE[ck] = { at: Date.now(), data: out };
    return out;
  }

  // social_recent 工具：精簡欄位，避免吃太多 token（同桌面 ai_search）
  async function aiSearch(args) {
    args = args && typeof args === 'object' ? args : {};
    var srcs = args.sources;
    if (typeof srcs === 'string') srcs = srcs.split(/[,，\s]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    var r;
    try { r = await search(String(args.query || ''), { en_query: String(args.en_query || ''), days: args.days == null ? 30 : args.days, sources: srcs, limit: args.limit == null ? 20 : args.limit }); }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    var slim = r.items.map(function (it) {
      var s = { source: it.source, title: it.title, url: it.url, where: it.community, date: it.date, metrics: it.metrics, score: it.score };
      if (it.external_url) s.link = it.external_url;
      if (it.snippet) s.snippet = clip(it.snippet, 220);
      if (it.top_comments) s.top_comments = it.top_comments.slice(0, 2);
      if (it.also_on) s.also_on = it.also_on.map(function (a) { return a.source; });
      return s;
    });
    return { ok: true, query: r.query, days: r.days, window_start: r.window_start, source_notes: r.source_notes, items: slim,
      instructions: '請依互動數高低整理成重點摘要：大家在討論什麼、主要看法與爭議、值得注意的專案或影片；每個重點附來源平台與網址；沒有資料的平台照 source_notes 說明，不要自己補。' };
  }

  /* ───────── 給工具迴圈用 ───────── */
  var RX = /最近|近期|這陣子|這週|本週|這個月|本月|近\s*\d+\s*天|近一個月|近30天|討論|熱議|輿情|網友|社群|口碑|風評|評價|大家(怎麼|如何)看|鄉民|Reddit|Hacker\s*News|\bHN\b|GitHub.{0,6}(熱門|趨勢|新專案)|YouTube.{0,6}(影片|討論)|trending|what.{0,10}people.{0,10}say|sentiment|last\s*30\s*days/i;
  var RX_AUTO = /熱議|輿情|網友|鄉民|口碑|風評|大家(怎麼|如何)(看|說|評)|社群(上|的)?(討論|反應|近況|評價)|(討論|評價)度|Reddit|Hacker\s*News|\bHN\b|GitHub.{0,6}(熱門|趨勢|新專案)|YouTube.{0,6}(討論|熱門)|what.{0,10}people.{0,10}say|sentiment/i;
  function looksLikeSocial(t) { return RX.test(String(t || '')); }
  function wantsAuto(t) { return RX_AUTO.test(String(t || '')); }
  function declarations() {
    return [{ name: 'social_recent', label: '社群近況研究',
      description: '查某個主題「最近 N 天」在 Reddit、Hacker News、GitHub、YouTube、Polymarket 的熱門討論（依按讚／留言／星數／觀看／下注金額排序，跨平台同一件事會合併）。'
        + '適合「最近大家怎麼看 X」「X 這個月有什麼討論／新專案」「X 的口碑」。國際社群多用英文：請同時給 query（使用者原文）與 en_query（英文關鍵字）。回答時每個重點附平台與網址；source_notes 說某平台失敗就照實說。',
      parameters: { type: 'object', properties: {
        query: { type: 'string', description: '要查的主題（使用者原文）' },
        en_query: { type: 'string', description: '英文關鍵字（建議提供）' },
        days: { type: 'integer', description: '1-30，預設 30' },
        sources: { type: 'string', description: '選填，逗號分隔：reddit,hackernews,github,youtube,polymarket（預設全部）' },
        limit: { type: 'integer', description: '預設 20' } }, required: ['query'] } }];
  }
  async function run(name, args) { if (name !== 'social_recent') return { ok: false, error: '未知的工具：' + name }; return await aiSearch(args); }
  function format(r) { return JSON.stringify(r).slice(0, 14000); }

  /* ───────── 設定卡片（設定 → 整合 → 工具） ───────── */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmtMetrics(m) {
    m = m || {}; var a = [];
    if (m.upvotes != null) a.push('👍 ' + m.upvotes); if (m.points != null) a.push('▲ ' + m.points); if (m.comments != null) a.push('💬 ' + m.comments);
    if (m.stars != null) a.push('⭐ ' + m.stars); if (m.views != null) a.push('👁 ' + m.views.toLocaleString());
    if (m.probability_yes != null) a.push('是 ' + Math.round(m.probability_yes * 100) + '%'); if (m.volume_usd) a.push('$' + Math.round(m.volume_usd).toLocaleString());
    return a.join('　');
  }
  var busy = false;
  function mount() {
    var list = document.getElementById('fc-builtin-list');
    var card = list && list.closest ? list.closest('.nv-card') : null;
    if (!card || document.getElementById('nova-social-box')) return;
    var box = document.createElement('div');
    box.className = 'nv-card'; box.id = 'nova-social-box';
    box.innerHTML = '<h4>🗣 社群近況研究</h4>'
      + '<p class="nv-muted">查某個主題最近幾天在 Reddit、Hacker News、GitHub、YouTube、Polymarket 的熱門討論（免金鑰）。對話裡問「最近大家怎麼看…」「…的口碑」時，Gemini／Grok 會自己呼叫（上面內建工具的「社群近況研究」可關閉）。這裡可以先試搜，確認哪些平台在你的網路連得到。</p>'
      + '<input id="nsoc-q" class="nv-input" style="width:100%;margin-top:6px" placeholder="主題（例：Gemini 4、電動機車）">'
      + '<input id="nsoc-en" class="nv-input" style="width:100%;margin-top:6px" placeholder="英文關鍵字（選填，例：Gemini 4）">'
      + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px"><label class="nv-muted">最近 <input id="nsoc-days" type="number" min="1" max="31" value="30" class="nv-input" style="width:64px"> 天</label>'
      + SOURCES.map(function (s) { return '<label class="nv-muted" style="display:inline-flex;gap:4px;align-items:center"><input type="checkbox" data-nsoc-src="' + s + '" checked style="accent-color:#a855f7">' + SRC_ZH[s] + '</label>'; }).join('')
      + '</div><div style="margin-top:8px"><button type="button" class="nv-btn nv-primary" id="nsoc-go">試搜</button></div>'
      + '<div id="nsoc-out" style="margin-top:8px"></div>';
    card.parentNode.insertBefore(box, card.nextSibling);
    document.getElementById('nsoc-go').onclick = async function () {
      if (busy) return;
      var q = document.getElementById('nsoc-q').value.trim(), out = document.getElementById('nsoc-out'), btn = this;
      if (!q) { out.innerHTML = '<p class="nv-muted">請先輸入主題。</p>'; return; }
      var srcs = Array.prototype.slice.call(box.querySelectorAll('[data-nsoc-src]')).filter(function (c) { return c.checked; }).map(function (c) { return c.getAttribute('data-nsoc-src'); });
      busy = true; btn.disabled = true; btn.textContent = '搜尋中…'; out.innerHTML = '<p class="nv-muted">同時查各平台，約 5～15 秒…</p>';
      try {
        var r = await search(q, { en_query: document.getElementById('nsoc-en').value, days: document.getElementById('nsoc-days').value, sources: srcs, limit: 25 });
        var notes = Object.keys(r.source_notes).map(function (k) { var ok = /^\d+ 筆$/.test(r.source_notes[k]); return '<span style="white-space:nowrap">' + (ok ? '🟢' : '🔴') + ' ' + SRC_ZH[k] + '：' + esc(r.source_notes[k]) + '</span>'; }).join('　');
        out.innerHTML = '<p class="nv-muted" style="line-height:1.7">' + notes + (r.cached ? '　（15 分鐘內的快取）' : '') + '</p>'
          + (r.items.length ? r.items.map(function (it) {
            return '<div style="padding:6px 0;border-top:1px solid rgba(127,127,127,.2);font-size:12px;line-height:1.5">'
              + '<div><span class="nv-muted">' + SRC_ZH[it.source] + (it.date ? '・' + it.date : '') + '・' + esc(it.community || '') + '</span></div>'
              + '<a href="' + esc(it.url) + '" target="_blank" rel="noopener">' + esc(it.title) + '</a>'
              + '<div class="nv-muted">' + fmtMetrics(it.metrics) + (it.also_on ? '　也出現在 ' + it.also_on.map(function (a) { return SRC_ZH[a.source]; }).join('、') : '') + '</div></div>';
          }).join('') : '<p class="nv-muted">這段時間內沒有相關的討論。</p>');
      } catch (e) { out.innerHTML = '<p class="nv-muted">❌ ' + esc((e && e.message) || e) + '</p>'; }
      busy = false; btn.disabled = false; btn.textContent = '試搜';
    };
  }
  function boot() { mount(); var n = 0, t = setInterval(function () { mount(); if (document.getElementById('nova-social-box') || ++n > 40) clearInterval(t); }, 500); }

  root.NovaSocial = { version: VERSION, sources: SOURCES.slice(), search: search, aiSearch: aiSearch, looksLikeSocial: looksLikeSocial, wantsAuto: wantsAuto,
    declarations: declarations, run: run, format: format, mount: mount,
    _t: { tokens: tokens, relevance: relevance, similar: similar, normUrl: normUrl, scoreItems: scoreItems, mergeDupes: mergeDupes, parseYtHtml: parseYtHtml, ytNum: ytNum, ytAgo: ytAgo, FETCHERS: FETCHERS } };
  if (typeof document !== 'undefined') { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot(); }
})(typeof window !== 'undefined' ? window : globalThis);

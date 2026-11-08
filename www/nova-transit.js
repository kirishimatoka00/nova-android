/* ═══════════════════════════════════════════════════════════════════
   nova-transit.js — NOVA Android「大眾運輸查詢」（TDX 運輸資料流通服務）— 高鐵／台鐵／各捷運／公車（市區＋公路客運）
   版本：v1.0.0（2026-11-08，App v2.6.124）
   移植自桌面版 python-engine/nova_transit.py v1.1.0（邏輯與欄位解析一致，只換成 JS＋fetch；手機沒有 sidecar，直接在 WebView 呼叫 TDX）。

   版本紀錄（只記這個檔案自己的變更）：
   v1.0.0 - 首版。
     【定位】多 Bot 的「大眾運輸專家」與一般（非多 Bot）聊天的工具呼叫共用的資料來源。只呼叫交通部 TDX 官方 API（唯讀 GET），不呼叫任何 LLM，
            不寫入任何東西（金鑰除外）。
     【認證】TDX client_credentials：Client ID／Secret 存在 localStorage nova_tdx_keys_v1（{client_id,client_secret}），會隨「專家與 Bot」同步到其他裝置
            （同步檔 NOVA_Bots_Sync.json 的 tdx/all；金鑰會明文存在 Google 雲端硬碟的同步檔裡）。access token 只放記憶體（約一天），過期前 5 分鐘自動更新，
            遇 401 重取一次；token 端點每 IP 每分鐘最多 20 次，所以絕不每次查詢都重取。
     【工具】transit_thsr（高鐵時刻＋票價＋座位）、transit_tra（台鐵時刻＋票價＋誤點）、transit_metro（各捷運票價／首末班／即時到站）、
            transit_bus（公車到站動態／路線站序／時刻／票價說明；city 寫「公路客運」查國道客運）。站名可直接用中文（台北、臺中、板橋…，「台」「臺」通用，可省略「站」）；
            找不到或有多個候選會回報候選清單，不亂猜。
     【誠實的限制】沒有用真實 TDX 帳號在手機上實際呼叫過；欄位解析是依桌面版（同樣依 TDX 文件）移植，並對缺欄位做容錯。第一次使用請先到
            「專家管理 → 多 Bot → 交通 API（TDX 金鑰）」按「測試連線」。票價時刻以 TDX 回傳為準，這裡不做任何推算。
            捷運「含轉乘的行車時間」只在 TDX 的 OD 票價資料有附 TravelTime 時才顯示。
   ═══════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  var API = { VERSION: '1.0.0' };
  var BASE = 'https://tdx.transportdata.tw/api/basic';
  var TOKEN_URL = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
  var KEY_LS = 'nova_tdx_keys_v1';
  var TZ_OFFSET_MIN = 8 * 60;   // 台灣固定 UTC+8（沒有日光節約）
  var HTTP_TIMEOUT = 20000;
  var LS = (function () { try { return root.localStorage; } catch (e) { return null; } })();

  function TransitError(msg) { var e = new Error(msg); e.transit = true; return e; }
  API.TransitError = TransitError;

  // ───────────────────────── 金鑰與 token ─────────────────────────
  var tok = { token: '', exp: 0, pending: null };
  var cache = {};   // url -> {exp, val}

  function loadKeys() {
    try { var o = JSON.parse((LS && LS.getItem(KEY_LS)) || '{}'); return (o && typeof o === 'object') ? o : {}; } catch (e) { return {}; }
  }
  function creds() { var k = loadKeys(); return { id: String(k.client_id || '').trim(), sec: String(k.client_secret || '').trim() }; }
  /** 只回布林（遮罩）；要實際值用 revealKeys()（同步用） */
  API.keys = function () { var c = creds(); return { client_id: !!c.id, client_secret: !!c.sec }; };
  API.hasKeys = function () { var c = creds(); return !!(c.id && c.sec); };
  API.revealKeys = function () { var c = creds(); return { client_id: c.id, client_secret: c.sec }; };
  /** patch：{client_id, client_secret}；空字串＝清除該欄位；沒有帶的欄位不動 */
  API.setKeys = function (patch) {
    var cur = loadKeys(); patch = patch || {};
    ['client_id', 'client_secret'].forEach(function (f) {
      if (patch[f] != null) { var v = String(patch[f]).trim(); if (v) cur[f] = v; else delete cur[f]; }
    });
    try { LS.setItem(KEY_LS, JSON.stringify(cur)); } catch (e) { /* 儲存失敗就不處理 */ }
    tok.token = ''; tok.exp = 0; cache = {};   // 換了金鑰 → 舊 token 與快取作廢
    try { root.dispatchEvent(new root.CustomEvent('nova-bots-changed')); } catch (e2) { /* */ }   // 觸發同步
    return API.keys();
  };

  function withTimeout(p, ms, what) {
    return new Promise(function (res, rej) {
      var t = setTimeout(function () { rej(new Error((what || '請求') + '逾時（' + Math.round(ms / 1000) + ' 秒）')); }, ms);
      p.then(function (v) { clearTimeout(t); res(v); }, function (e) { clearTimeout(t); rej(e); });
    });
  }
  function httpErr(status, text) { return 'HTTP ' + status + ' ' + String(text || '').slice(0, 200).replace(/\s+/g, ' '); }

  async function getToken(force) {
    var c = creds();
    if (!c.id || !c.sec) throw TransitError('尚未設定 TDX 金鑰（Client ID／Client Secret）。請到「專家管理 → 🤖 多 Bot → 交通 API（TDX 金鑰）」填入後再查。');
    var now = Date.now() / 1000;
    if (!force && tok.token && now < tok.exp - 300) return tok.token;
    if (tok.pending) return tok.pending;   // 同時多個請求只取一次 token
    tok.pending = (async function () {
      try {
        var body = 'grant_type=client_credentials&client_id=' + encodeURIComponent(c.id) + '&client_secret=' + encodeURIComponent(c.sec);
        var r, txt;
        try {
          r = await withTimeout(root.fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' }, body: body }), HTTP_TIMEOUT, '取得 TDX token');
          txt = await r.text();
        } catch (e) { throw TransitError('取得 TDX token 失敗（網路問題？）：' + ((e && e.message) || e)); }
        var d = null; try { d = JSON.parse(txt); } catch (e2) { d = null; }
        if (!r.ok) throw TransitError('取得 TDX token 失敗（請確認 Client ID／Secret 正確；token 端點每 IP 每分鐘最多 20 次）：' + httpErr(r.status, txt));
        if (!d || !d.access_token) throw TransitError('TDX 沒有回傳 access_token：' + String(txt).slice(0, 200));
        tok.token = d.access_token; tok.exp = Date.now() / 1000 + (Number(d.expires_in) || 3600);
        return tok.token;
      } finally { tok.pending = null; }
    })();
    return tok.pending;
  }

  function qs(params) {
    return Object.keys(params).map(function (k) { return encodeURIComponent(k).replace(/%24/g, '$') + '=' + encodeURIComponent(params[k]); }).join('&');
  }
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  /** GET BASE+path；ttl>0（秒）時記憶體快取（靜態資料用）。回傳解析後的 JSON。 */
  async function tdxGet(path, params, ttl) {
    if (path.charAt(0) !== '/') path = '/' + path;
    var q = Object.assign({}, params || {}); if (!q.$format) q.$format = 'JSON';
    var url = BASE + path + '?' + qs(q);
    if (ttl) { var hit = cache[url]; if (hit && hit.exp > Date.now()) return hit.val; }
    var lastStatus = 0;
    for (var attempt = 0; attempt < 3; attempt++) {
      var t = await getToken(attempt === 1 && lastStatus === 401);
      var r, txt;
      try {
        r = await withTimeout(root.fetch(url, { method: 'GET', headers: { 'Authorization': 'Bearer ' + t, 'Accept': 'application/json' } }), HTTP_TIMEOUT, 'TDX 查詢');
        txt = await r.text();
      } catch (e) { throw TransitError('TDX 查詢失敗：' + ((e && e.message) || e) + '（' + path + '）'); }
      lastStatus = r.status;
      if (r.ok) {
        var val; try { val = JSON.parse(txt); } catch (e2) { throw TransitError('TDX 回傳不是 JSON（' + path + '）：' + String(txt).slice(0, 120)); }
        if (ttl) cache[url] = { exp: Date.now() + ttl * 1000, val: val };
        return val;
      }
      if (r.status === 401 && attempt === 0) continue;
      if (r.status === 429 && attempt < 2) { await sleep(1500); continue; }
      if (r.status === 404) throw TransitError('TDX 回 404（查無資料或路徑不存在）：' + path);
      throw TransitError('TDX 查詢失敗：' + httpErr(r.status, txt) + '（' + path + '）');
    }
    throw TransitError('TDX 查詢失敗：HTTP ' + lastStatus + '（' + path + '）');
  }
  API._tdxGet = tdxGet;

  API.test = async function () {
    try {
      await getToken(true);
      var n = lst(await tdxGet('/v2/Rail/THSR/Station')).length;
      return { ok: true, message: '連線成功（token 取得正常，高鐵車站 ' + n + ' 站）' };
    } catch (e) { return { ok: false, message: (e && e.message) || String(e) }; }
  };

  // ───────────────────────── 共用小工具 ─────────────────────────
  function zh(x) {
    if (x && typeof x === 'object') return String(x.Zh_tw || x.Zh_tw_name || x.En || '');
    return x == null ? '' : String(x);
  }
  /** TDX v3 常把陣列包在物件裡（{"Stations":[...]}）；v2 直接是陣列。 */
  function lst(x) {
    if (Array.isArray(x)) return x;
    if (x && typeof x === 'object') { var ks = Object.keys(x); for (var i = 0; i < ks.length; i++) if (Array.isArray(x[ks[i]])) return x[ks[i]]; }
    return [];
  }
  function normName(s) {
    s = String(s == null ? '' : s).trim().replace(/台/g, '臺').replace(/[\s　]+/g, '');
    ['車站', '站'].some(function (suf) { if (s.length > suf.length && s.slice(-suf.length) === suf) { s = s.slice(0, -suf.length); return true; } return false; });
    return s;
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  /** 現在的「台灣時間」，以 UTC 欄位表示（getUTC* 就是台灣的年月日時分） */
  function twNow() { return new Date(Date.now() + TZ_OFFSET_MIN * 60000); }
  function ymd(d) { return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()); }
  function addDays(d, n) { return new Date(d.getTime() + n * 86400000); }
  function normDate(d) {
    var s = String(d == null ? '' : d).trim(), now = twNow();
    if (!s || s === 'today' || s === '今天' || s === '今日') return ymd(now);
    if (s === 'tomorrow' || s === '明天' || s === '明日') return ymd(addDays(now, 1));
    if (s === '後天') return ymd(addDays(now, 2));
    var m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (m) return m[1] + '-' + pad2(+m[2]) + '-' + pad2(+m[3]);
    m = s.match(/^(\d{1,2})[-/.](\d{1,2})$/);   // 只給月日 → 用今年（已過去就用明年）
    if (m) {
      var y = now.getUTCFullYear(), cand = new Date(Date.UTC(y, +m[1] - 1, +m[2]));
      if (cand.getTime() < Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 86400000) y += 1;
      return y + '-' + pad2(+m[1]) + '-' + pad2(+m[2]);
    }
    throw TransitError('日期格式不對：「' + s + '」，請用 YYYY-MM-DD（例如 2026-11-20），或 today／tomorrow。');
  }
  function normTime(t) {
    var s = String(t == null ? '' : t).trim(); if (!s) return '';
    var m = s.match(/^(\d{1,2})[:：](\d{2})/);
    if (!m) throw TransitError('時間格式不對：「' + s + '」，請用 HH:MM（24 小時制，例如 08:30）。');
    return pad2(+m[1]) + ':' + pad2(+m[2]);
  }
  function hhmm(s) { s = String(s == null ? '' : s); var m = s.match(/(\d{1,2}):(\d{2})/); return m ? pad2(+m[1]) + ':' + m[2] : s; }
  function minutes(a, b) {
    try {
      var A = a.split(':'), B = b.split(':'), d = (+B[0] * 60 + +B[1]) - (+A[0] * 60 + +A[1]);
      if (isNaN(d)) return null; return d < 0 ? d + 1440 : d;
    } catch (e) { return null; }
  }
  /** stations: [[id,name]]；先找 ID 完全相同，再名稱完全相同，再前綴，再包含 */
  function resolve(query, stations, what) {
    var q = normName(query);
    if (!q) throw TransitError('缺少' + what + '。');
    var raw = String(query).trim();
    var ids = stations.filter(function (s) { return s[0] === raw; }); if (ids.length) return ids;
    var ex = stations.filter(function (s) { return normName(s[1]) === q; }); if (ex.length) return ex;
    var pre = stations.filter(function (s) { return normName(s[1]).indexOf(q) === 0; }); if (pre.length) return pre;
    return stations.filter(function (s) { return normName(s[1]).indexOf(q) >= 0; });
  }
  function pickOne(query, stations, what) {
    var m = resolve(query, stations, what);
    if (!m.length) throw TransitError('找不到' + what + '「' + query + '」。');
    if (m.length > 1) {
      var uniq = {}; m.forEach(function (x) { if (!(x[1] in uniq)) uniq[x[1]] = x[0]; });
      var names = Object.keys(uniq);
      if (names.length > 1) throw TransitError(what + '「' + query + '」有多個候選，請指定更精確的名稱：' + names.slice(0, 12).map(function (n) { return n + '(' + uniq[n] + ')'; }).join('、'));
    }
    return m[0];
  }
  function clip(items, n) { return items.slice(0, Math.max(1, Math.min(parseInt(n, 10) || 10, 40))); }
  function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }

  // ───────────────────────── 高鐵 ─────────────────────────
  var THSR_STATIONS = [['0990', '南港'], ['1000', '臺北'], ['1010', '板橋'], ['1020', '桃園'], ['1030', '新竹'], ['1035', '苗栗'],
    ['1040', '臺中'], ['1043', '彰化'], ['1047', '雲林'], ['1050', '嘉義'], ['1060', '臺南'], ['1070', '左營']];

  function fareLines(fares) {
    var out = [];
    lst(fares).forEach(function (f) {
      if (!isObj(f)) return;
      var label = ['TrainType', 'TrainTypeName', 'TicketType', 'FareClass', 'CabinClass'].map(function (k) { return f[k]; }).filter(function (v) { return v != null && v !== '' && typeof v !== 'object'; }).join(' ');
      if (isObj(f.TrainTypeName)) label = [zh(f.TrainTypeName), String(f.TicketType || ''), String(f.FareClass || '')].filter(Boolean).join(' ');
      if (f.Price == null) return;
      out.push((label.trim() || '票價') + '：' + f.Price + ' 元');
    });
    return out;
  }

  async function thsr(a) {
    var o = pickOne(a.from || '', THSR_STATIONS, '高鐵起站'), d = pickOne(a.to || '', THSR_STATIONS, '高鐵到站');
    if (o[0] === d[0]) throw TransitError('起站與到站相同。');
    var day = normDate(a.date), t0 = normTime(a.time);
    var rows = await tdxGet('/v2/Rail/THSR/DailyTimetable/OD/' + o[0] + '/to/' + d[0] + '/' + day);
    var trains = [];
    lst(rows).forEach(function (r) {
      var info = r.DailyTrainInfo || {};
      var dep = hhmm((r.OriginStopTime || {}).DepartureTime), arr = hhmm((r.DestinationStopTime || {}).ArrivalTime);
      if (t0 && dep < t0) return;
      trains.push({ train_no: String(info.TrainNo || ''), depart: dep, arrive: arr, minutes: minutes(dep, arr), note: info.EndingStationName ? '往' + zh(info.EndingStationName) : '' });
    });
    trains.sort(function (x, y) { return x.depart < y.depart ? -1 : x.depart > y.depart ? 1 : 0; });
    var total = trains.length; trains = clip(trains, a.limit);
    var out = { ok: true, system: '高鐵', from: o[1], to: d[1], date: day, after: t0 || null, matched_trains: total, trains: trains, source: 'TDX 高鐵每日時刻表（官方）' };
    try {
      var fr = await tdxGet('/v2/Rail/THSR/ODFare/' + o[0] + '/to/' + d[0], null, 3600), lines = [];
      lst(fr).forEach(function (rec) { lines = lines.concat(fareLines(isObj(rec) ? rec.Fares : null)); });
      out.fares = lines.length ? lines : null;
      if (!lines.length) out.fare_note = 'TDX 沒有回傳這個區間的票價。';
    } catch (e) { if (e.transit) out.fare_error = e.message; else throw e; }
    var wantSeats = !(a.seats === false || String(a.seats).toLowerCase() === 'false' || String(a.seats) === '0' || String(a.seats).toLowerCase() === 'no');
    if (wantSeats && trains.length) {
      try {
        var ss = await tdxGet('/v2/Rail/THSR/AvailableSeatStatus/Train/OD/' + o[0] + '/to/' + d[0] + '/TrainDate/' + day), seat = {}, hit = false;
        (Array.isArray(ss) ? ss : lst(isObj(ss) ? (ss.AvailableSeats || ss) : ss)).forEach(function (rec) {
          if (!isObj(rec)) return;
          (rec.StopStations || []).forEach(function (st) { if (String(st.StationID) === o[0]) seat[String(rec.TrainNo)] = '標準:' + st.StandardSeatStatus + '／商務:' + st.BusinessSeatStatus; });
        });
        trains.forEach(function (t) { if (seat[t.train_no]) { t.seats = seat[t.train_no]; hit = true; } });
        if (hit) out.seat_note = '座位狀態：Available 尚有、Limited 剩少數、Full 已無；只有尚未發車的班次才有資料。';
      } catch (e) { if (!e.transit) throw e; }
    }
    return out;
  }

  // ───────────────────────── 台鐵 ─────────────────────────
  async function traStations() {
    var paths = ['/v3/Rail/TRA/Station', '/v2/Rail/TRA/Station'];
    for (var i = 0; i < paths.length; i++) {
      try {
        var rows = lst(await tdxGet(paths[i], null, 86400));
        var st = rows.filter(function (r) { return isObj(r) && r.StationID; }).map(function (r) { return [String(r.StationID), zh(r.StationName)]; });
        if (st.length) return st;
      } catch (e) { if (!e.transit) throw e; }
    }
    throw TransitError('取不到台鐵車站清單（TDX 回應異常，或金鑰權限不足）。');
  }
  function traRow(rec, oid, did) {
    var info = rec.TrainInfo || rec.DailyTrainInfo || {}, stops = rec.StopTimes || [], dep = '', arr = '';
    stops.forEach(function (s) {
      var sid = String(s.StationID);
      if (sid === oid) dep = hhmm(s.DepartureTime || s.ArrivalTime);
      if (sid === did) arr = hhmm(s.ArrivalTime || s.DepartureTime);
    });
    if (!dep && rec.OriginStopTime) dep = hhmm((rec.OriginStopTime || {}).DepartureTime);
    if (!arr && rec.DestinationStopTime) arr = hhmm((rec.DestinationStopTime || {}).ArrivalTime);
    if (!dep && stops.length) dep = hhmm(stops[0].DepartureTime);
    if (!arr && stops.length) arr = hhmm(stops[stops.length - 1].ArrivalTime);
    if (!dep) return null;
    return { train_no: String(info.TrainNo || ''), type: zh(info.TrainTypeName), depart: dep, arrive: arr, minutes: minutes(dep, arr), to: zh(info.EndingStationName),
      note: isObj(info.Note) ? zh(info.Note) : String(info.Note || '') };
  }
  async function tra(a) {
    var st = await traStations();
    var o = pickOne(a.from || '', st, '台鐵起站'), d = pickOne(a.to || '', st, '台鐵到站');
    if (o[0] === d[0]) throw TransitError('起站與到站相同。');
    var day = normDate(a.date), t0 = normTime(a.time), recs = null, err = null;
    var paths = ['/v3/Rail/TRA/DailyTrainTimetable/OD/' + o[0] + '/to/' + d[0] + '/' + day, '/v2/Rail/TRA/DailyTimetable/OD/' + o[0] + '/to/' + d[0] + '/' + day];
    for (var i = 0; i < paths.length; i++) {
      try { recs = lst(await tdxGet(paths[i])); break; } catch (e) { if (!e.transit) throw e; err = e; }
    }
    if (recs === null) throw err || TransitError('台鐵時刻表查詢失敗。');
    var trains = [];
    recs.forEach(function (r) { if (isObj(r)) { var row = traRow(r, o[0], d[0]); if (row && (!t0 || row.depart >= t0)) trains.push(row); } });
    trains.sort(function (x, y) { return x.depart < y.depart ? -1 : x.depart > y.depart ? 1 : 0; });
    var total = trains.length; trains = clip(trains, a.limit);
    var out = { ok: true, system: '台鐵', from: o[1], to: d[1], date: day, after: t0 || null, matched_trains: total, trains: trains, source: 'TDX 台鐵每日時刻表（官方）' };
    if (day === ymd(twNow()) && trains.length) {   // 今天才有即時誤點
      try {
        var dl = await tdxGet('/v2/Rail/TRA/LiveTrainDelay'), dm = {}, hit = false;
        lst(dl).forEach(function (x) { if (isObj(x)) dm[String(x.TrainNo)] = x.DelayTime; });
        trains.forEach(function (t) { if (t.train_no in dm) { t.delay_min = dm[t.train_no]; hit = true; } });
        if (hit) out.delay_note = 'delay_min＝目前誤點分鐘數（即時資料）；沒有這個欄位代表 TDX 目前沒有該班次的即時資料，不代表準點。';
      } catch (e) { if (!e.transit) throw e; }
    }
    var fares = null, fp = ['/v3/Rail/TRA/ODFare/' + o[0] + '/to/' + d[0], '/v2/Rail/TRA/ODFare/' + o[0] + '/to/' + d[0]];
    for (var j = 0; j < fp.length; j++) {
      try {
        var fr = await tdxGet(fp[j], null, 3600), lines = [];
        lst(fr).forEach(function (rec) { lines = lines.concat(fareLines(isObj(rec) ? rec.Fares : null)); });
        if (lines.length) { fares = lines; break; }
      } catch (e) { if (e.transit) out.fare_error = e.message; else throw e; }
    }
    out.fares = fares;
    if (fares) { delete out.fare_error; out.fare_note = '票價依 TDX 的起訖站票價表，標籤是車種／票種／身分；請依班次的車種（type）對照。'; }
    return out;
  }

  // ───────────────────────── 捷運／輕軌／纜車 ─────────────────────────
  var METRO_OPERATORS = { TRTC: '台北捷運', KRTC: '高雄捷運', TYMC: '桃園捷運', TMRT: '台中捷運', KLRT: '高雄輕軌', NTDLRT: '新北淡海輕軌', NTALRT: '新北安坑輕軌', NTMC: '新北捷運', TRTCMG: '貓空纜車' };
  var METRO_ALIAS = { '台北': 'TRTC', '臺北': 'TRTC', '北捷': 'TRTC', '台北捷運': 'TRTC', '臺北捷運': 'TRTC', '高雄': 'KRTC', '高捷': 'KRTC', '高雄捷運': 'KRTC',
    '桃園': 'TYMC', '桃捷': 'TYMC', '桃園捷運': 'TYMC', '機場捷運': 'TYMC', '台中': 'TMRT', '臺中': 'TMRT', '中捷': 'TMRT', '台中捷運': 'TMRT', '臺中捷運': 'TMRT',
    '高雄輕軌': 'KLRT', '環狀輕軌': 'KLRT', '淡海': 'NTDLRT', '淡海輕軌': 'NTDLRT', '安坑': 'NTALRT', '安坑輕軌': 'NTALRT', '貓空': 'TRTCMG', '貓空纜車': 'TRTCMG' };
  function metroOp(s) {
    var q = String(s == null ? '' : s).trim();
    if (METRO_OPERATORS[q.toUpperCase()]) return q.toUpperCase();
    if (METRO_ALIAS[q]) return METRO_ALIAS[q];
    var q2 = q.replace(/台/g, '臺'), ks = Object.keys(METRO_ALIAS);
    for (var i = 0; i < ks.length; i++) if (ks[i].replace(/台/g, '臺') === q2) return METRO_ALIAS[ks[i]];
    throw TransitError('不認得的捷運系統「' + s + '」。可用：' + Object.keys(METRO_OPERATORS).map(function (k) { return k + '=' + METRO_OPERATORS[k]; }).join('、') + '（也可寫 台北／高雄／桃園／台中 等）。');
  }
  async function metroStations(op) {
    var rows = lst(await tdxGet('/v2/Rail/Metro/Station/' + op, null, 86400));
    return rows.filter(function (r) { return isObj(r) && r.StationID; }).map(function (r) { return [String(r.StationID), zh(r.StationName)]; });
  }
  function odataEq(field, val) { return field + " eq '" + String(val).replace(/'/g, "''") + "'"; }
  var DAYS = [['Monday', '一'], ['Tuesday', '二'], ['Wednesday', '三'], ['Thursday', '四'], ['Friday', '五'], ['Saturday', '六'], ['Sunday', '日']];
  function serviceDay(sd) {
    if (!isObj(sd)) return '';
    var on = DAYS.filter(function (p) { return sd[p[0]] === 1 || sd[p[0]] === true; }).map(function (p) { return p[1]; });
    if (on.length === 7) return '每天';
    if (on.join('') === '一二三四五') return '週一至週五';
    if (on.join('') === '六日') return '週六日';
    return on.length ? '週' + on.join('') : '';
  }
  function uniqNames(arr) { var s = {}; arr.forEach(function (x) { s[x[1]] = 1; }); return Object.keys(s); }

  async function metro(a) {
    var op = metroOp(a.system || 'TRTC'), st = await metroStations(op);
    if (!st.length) throw TransitError('TDX 沒有回傳 ' + METRO_OPERATORS[op] + ' 的車站資料。');
    var names = {}; st.forEach(function (x) { names[x[0]] = x[1]; });
    var from = a.from || '', to = a.to || '', station = a.station || '';
    var m = String(a.mode || '').trim().toLowerCase();
    if (!m) m = (from && to) ? 'fare' : (station ? 'first_last' : '');
    if (m === 'route' || m === 'price' || m === '票價') m = 'fare';
    if (m === 'live' || m === 'board' || m === '即時') m = 'live';
    if (m === 'firstlast' || m === 'first-last' || m === '首末班') m = 'first_last';
    var out = { ok: true, system: METRO_OPERATORS[op], operator: op };

    if (m === 'fare') {
      if (!(from && to)) throw TransitError('查票價請給 from 與 to（站名）。');
      var oc = resolve(from, st, '起站'), dc = resolve(to, st, '到站');
      if (!oc.length) throw TransitError('找不到起站「' + from + '」（' + METRO_OPERATORS[op] + '）。');
      if (!dc.length) throw TransitError('找不到到站「' + to + '」（' + METRO_OPERATORS[op] + '）。');
      var on = uniqNames(oc), dn = uniqNames(dc);
      if (on.length > 1 || dn.length > 1) throw TransitError('站名有多個候選，請指定更精確：起站 ' + on.sort().slice(0, 10).join('、') + '／到站 ' + dn.sort().slice(0, 10).join('、'));
      var found = null, tried = 0;   // 同名站可能有多個 ID（轉乘站），逐一嘗試直到有結果
      for (var i = 0; i < Math.min(oc.length, 4) && !found; i++) {
        for (var j = 0; j < Math.min(dc.length, 4); j++) {
          if (oc[i][0] === dc[j][0]) continue;
          tried++;
          var rows = lst(await tdxGet('/v2/Rail/Metro/ODFare/' + op, { $filter: odataEq('OriginStationID', oc[i][0]) + ' and ' + odataEq('DestinationStationID', dc[j][0]) }, 3600));
          if (rows.length) { found = rows; break; }
        }
      }
      out.from = on[0]; out.to = dn[0];
      if (!found) { out.ok = false; out.error = 'TDX 沒有這個起訖站（試了 ' + tried + ' 組站號）的票價資料。'; return out; }
      var fares = [], tt = null;
      found.forEach(function (rec) {
        if (!isObj(rec)) return;
        fares = fares.concat(fareLines(rec.Fares));
        if (rec.TravelTime != null && rec.TravelTime !== '' && tt === null) tt = rec.TravelTime;
      });
      out.fares = fares.length ? fares : null;
      if (tt !== null) { out.travel_time_min = tt; out.travel_time_note = 'TDX 票價資料附的起訖行車時間（分鐘）；不含候車與步行。'; }
      out.source = 'TDX 捷運起訖站票價（官方）';
      return out;
    }

    if (m === 'first_last' || m === 'live') {
      if (!station) throw TransitError('這個查詢請給 station（站名）。');
      var cands = resolve(station, st, '車站');
      if (!cands.length) throw TransitError('找不到車站「' + station + '」（' + METRO_OPERATORS[op] + '）。');
      out.station = cands[0][1];
      var res = [];
      for (var k = 0; k < Math.min(cands.length, 4); k++) {
        var sid = cands[k][0];
        var path = '/v2/Rail/Metro/' + (m === 'first_last' ? 'FirstLastTimetable' : 'LiveBoard') + '/' + op;
        var rs = lst(await tdxGet(path, { $filter: odataEq('StationID', sid) }, m === 'first_last' ? 1800 : 0));
        rs.forEach(function (r) {
          if (!isObj(r)) return;
          var dest = names[String(r.DestinationStationID || r.DestinationStaionID || '')] || zh(r.DestinationStationName);
          if (m === 'first_last') res.push({ station_id: sid, line: r.LineID || r.LineNo, to: dest || zh(r.TripHeadSign), first: hhmm(r.FirstTrainTime), last: hhmm(r.LastTrainTime), days: serviceDay(r.ServiceDay) });
          else res.push({ station_id: sid, line: r.LineID || r.LineNo, to: dest || zh(r.TripHeadSign), eta_min: r.EstimateTime, status: r.ServiceStatus });
        });
      }
      if (!res.length) { out.ok = false; out.error = 'TDX 沒有這個車站的' + (m === 'first_last' ? '首末班' : '即時到站') + '資料。'; return out; }
      out[m === 'live' ? 'items' : 'first_last'] = res.slice(0, 40);
      if (m === 'live') out.note = 'eta_min 是預估幾分鐘後進站；即時資料並非每個系統都有提供。';
      return out;
    }
    throw TransitError('捷運查詢請指定：票價（from＋to）、首末班（mode=first_last＋station）或即時到站（mode=live＋station）。');
  }

  // ───────────────────────── 公車 ─────────────────────────
  var BUS_CITIES = { '臺北': 'Taipei', '新北': 'NewTaipei', '桃園': 'Taoyuan', '臺中': 'Taichung', '臺南': 'Tainan', '高雄': 'Kaohsiung', '基隆': 'Keelung',
    '新竹市': 'Hsinchu', '新竹縣': 'HsinchuCounty', '苗栗': 'MiaoliCounty', '彰化': 'ChanghuaCounty', '南投': 'NantouCounty', '雲林': 'YunlinCounty',
    '嘉義市': 'Chiayi', '嘉義縣': 'ChiayiCounty', '屏東': 'PingtungCounty', '宜蘭': 'YilanCounty', '花蓮': 'HualienCounty', '臺東': 'TaitungCounty',
    '金門': 'KinmenCounty', '澎湖': 'PenghuCounty', '連江': 'LienchiangCounty', '馬祖': 'LienchiangCounty' };
  function busScope(city) {
    var c = String(city == null ? '' : city).trim();
    if (!c) throw TransitError('公車查詢請給 city（縣市，例如 臺北、新北、臺中、高雄；公路客運請寫 公路客運）。');
    if (c.toLowerCase() === 'intercity' || c.indexOf('客運') >= 0 || c.indexOf('國道') >= 0) return ['InterCity', '公路客運'];
    var t = c.replace(/台/g, '臺'), c2 = (t in BUS_CITIES) ? t : t.replace(/[市縣]$/, '');
    var tries = [t, c2, c2 + '市', c2 + '縣'];
    for (var i = 0; i < tries.length; i++) if (tries[i] in BUS_CITIES) return ['City/' + BUS_CITIES[tries[i]], tries[i]];
    var ens = Object.keys(BUS_CITIES).map(function (k) { return BUS_CITIES[k]; });
    for (var j = 0; j < ens.length; j++) if (ens[j].toLowerCase() === c.toLowerCase()) return ['City/' + ens[j], c];
    throw TransitError('不認得的縣市「' + city + '」。可用：' + Object.keys(BUS_CITIES).join('、') + '、公路客運。');
  }
  function busDir(info, d) {
    var n = parseInt(d, 10); if (isNaN(n)) return String(d);
    if (info) {
      if (n === 0 && info.to) return '去程（往' + info.to + '）';
      if (n === 1 && info.from) return '返程（往' + info.from + '）';
    }
    return n === 0 ? '去程' : n === 1 ? '返程' : String(d);
  }
  async function busRouteInfo(scope, route) {
    var rows;
    try { rows = lst(await tdxGet('/v2/Bus/Route/' + scope + '/' + encodeURIComponent(route), null, 3600)); } catch (e) { if (e.transit) return null; throw e; }
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i]; if (!isObj(r)) continue;
      return { name: zh(r.RouteName), from: r.DepartureStopNameZh || '', to: r.DestinationStopNameZh || '', ticket: r.TicketPriceDescriptionZh || '', buffer: r.FareBufferZoneDescriptionZh || '',
        operators: (r.Operators || []).filter(isObj).map(function (o) { return zh(o.OperatorName); }).join('、') };
    }
    return null;
  }
  var BUS_STATUS = { 1: '尚未發車', 2: '交管不停靠', 3: '末班車已過', 4: '今日未營運' };

  async function bus(a) {
    var sc = busScope(a.city), scope = sc[0], cname = sc[1], rt = String(a.route == null ? '' : a.route).trim();
    if (!rt) throw TransitError('請給路線名稱 route（例如 307、藍1、672）。');
    var m = String(a.mode || 'eta').trim().toLowerCase(), q = encodeURIComponent(rt);
    var info = await busRouteInfo(scope, rt);
    var out = { ok: true, city: cname, route: rt };
    if (info) { out.route_info = {}; Object.keys(info).forEach(function (k) { if (info[k]) out.route_info[k] = info[k]; }); }
    var dirF = null, ds = String(a.direction == null ? '' : a.direction).trim();
    if (ds === '0' || ds === '1') dirF = +ds;
    else if (ds) dirF = (/去|往|outbound/.test(ds) && ds.indexOf('返') < 0) ? 0 : (ds.indexOf('返') >= 0 || ds.indexOf('回') >= 0) ? 1 : null;
    var stopN = a.stop ? normName(a.stop) : '';

    if (['route', 'info', 'fare', '票價', '路線'].indexOf(m) >= 0) {
      out.note = '票價以 ticket 說明為準（TDX 路線資料）；沒有的話代表該業者未提供。';
      if (!info) { out.ok = false; out.error = '查無路線「' + rt + '」（' + cname + '）。請確認路線名稱與縣市。'; }
      return out;
    }
    if (['stops', 'stop_of_route', '站序'].indexOf(m) >= 0) {
      var rows = lst(await tdxGet('/v2/Bus/StopOfRoute/' + scope + '/' + q, null, 3600)), by = {};
      rows.forEach(function (r) {
        if (!isObj(r)) return;
        var d = r.Direction; if (dirF !== null && d !== dirF) return;
        var seq = (r.Stops || []).filter(isObj).map(function (s) { return [s.StopSequence, zh(s.StopName)]; });
        seq.sort(function (x, y) { return (x[0] == null ? 1e9 : x[0]) - (y[0] == null ? 1e9 : y[0]); });
        var cur = by[d] || [];
        if (seq.length > cur.length) by[d] = seq.map(function (x) { return x[1]; });   // 同方向有多個子路線時，取最長的
      });
      var dk = Object.keys(by);
      if (!dk.length) { out.ok = false; out.error = '查無路線「' + rt + '」的站序（' + cname + '）。'; return out; }
      out.directions = dk.sort().map(function (d) { return { direction: busDir(info, d), stops: by[d].slice(0, 80) }; });
      return out;
    }
    if (['schedule', 'timetable', '時刻'].indexOf(m) >= 0) {
      var srows = lst(await tdxGet('/v2/Bus/Schedule/' + scope + '/' + q, null, 1800)), res = [];
      srows.forEach(function (r) {
        if (!isObj(r)) return;
        var d = r.Direction; if (dirF !== null && d !== dirF) return;
        var item = { direction: busDir(info, d) }, fq = [];
        (r.Frequencys || []).forEach(function (f) {
          if (!isObj(f)) return;
          var sdy = serviceDay(f.ServiceDay);
          fq.push(hhmm(f.StartTime) + '–' + hhmm(f.EndTime) + ' 每 ' + f.MinHeadwayMins + '–' + f.MaxHeadwayMins + ' 分一班' + (sdy ? '（' + sdy + '）' : ''));
        });
        if (fq.length) item.frequency = fq.slice(0, 12);
        var times = [];
        (r.Timetables || []).forEach(function (t) {
          if (!isObj(t)) return;
          var sts = t.StopTimes || [];
          if (sts.length && isObj(sts[0])) times.push([hhmm(sts[0].DepartureTime || sts[0].ArrivalTime), serviceDay(t.ServiceDay)]);
        });
        times.sort(function (x, y) { return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0; });
        if (times.length) item.first_stop_departures = times.slice(0, 60).map(function (p) { return p[0] + (p[1] ? '（' + p[1] + '）' : ''); });
        res.push(item);
      });
      if (!res.length) { out.ok = false; out.error = 'TDX 沒有路線「' + rt + '」的班表（很多市區公車只提供動態，不提供固定時刻）。'; return out; }
      out.schedule = res; return out;
    }
    if (['eta', 'live', '動態', '到站'].indexOf(m) >= 0) {
      var erows = lst(await tdxGet('/v2/Bus/EstimatedTimeOfArrival/' + scope + '/' + q)), items = [];
      erows.forEach(function (r) {
        if (!isObj(r)) return;
        var d = r.Direction; if (dirF !== null && d !== dirF) return;
        var nm = zh(r.StopName); if (stopN && normName(nm).indexOf(stopN) < 0) return;
        var et = r.EstimateTime, stat = r.StopStatus, txt;
        if (et != null && (stat === 0 || stat == null)) txt = et <= 60 ? '進站中' : '約 ' + Math.floor((et + 59) / 60) + ' 分鐘';
        else txt = BUS_STATUS[stat] || (r.NextBusTime ? '下一班 ' + hhmm(r.NextBusTime) : '無預估資料');
        items.push([d != null ? d : 9, r.StopSequence || 0, nm, txt, r.PlateNumb || '']);
      });
      if (!items.length) { out.ok = false; out.error = '查無路線「' + rt + '」' + (a.stop ? '在「' + a.stop + '」站' : '') + '的到站資料（路線名稱／縣市／站名是否正確？）。'; return out; }
      items.sort(function (x, y) { return (x[0] - y[0]) || (x[1] - y[1]); });
      var total = items.length, cap = Math.max(5, Math.min(parseInt(a.limit, 10) || 40, 60));
      out.eta = items.slice(0, cap).map(function (x) { var e = { direction: busDir(info, x[0]), stop: x[2], eta: x[3] }; if (x[4] && x[4] !== '-1') e.plate = x[4]; return e; });
      out.total_rows = total;
      if (total > cap) out.note = '只列前 ' + cap + ' 筆；要看特定站請加 stop（站名），要看單一方向請加 direction（0 去程／1 返程）。';
      var n = twNow(); out.asof = ymd(n) + ' ' + pad2(n.getUTCHours()) + ':' + pad2(n.getUTCMinutes());
      out.source = 'TDX 公車預估到站（即時，僅供參考）';
      return out;
    }
    throw TransitError('公車 mode 請用：eta（到站動態，預設）、stops（站序）、schedule（班表）、route（路線與票價說明）。');
  }

  // ───────────────────────── 統一入口 ─────────────────────────
  /** tool：transit_thsr／transit_tra／transit_metro／transit_bus；args 同桌面版（from／to／date／time／limit／seats…）。永遠回傳 {ok,...}，不丟例外。 */
  API.run = async function (tool, args) {
    var a = Object.assign({}, args || {});
    try {
      if (tool === 'transit_thsr') return await thsr(a);
      if (tool === 'transit_tra') return await tra(a);
      if (tool === 'transit_metro') return await metro(a);
      if (tool === 'transit_bus') return await bus(a);
      return { ok: false, error: '未知的交通工具：' + tool };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  };
  API.TOOL_NAMES = ['transit_thsr', 'transit_tra', 'transit_metro', 'transit_bus'];
  /** 把結果轉成給模型看的文字（JSON；過長截斷） */
  API.format = function (r, max) {
    var s; try { s = JSON.stringify(r); } catch (e) { s = String(r); }
    max = max || 6500;
    return s.length > max ? s.slice(0, max) + '…（過長已截斷，請縮小範圍：加 time／limit／stop）' : s;
  };
  /** 一般聊天（Function Calling）用的宣告：{name,label,description,parameters,readOnly:true} */
  API.declarations = function () {
    var S = function (d) { return { type: 'string', description: d }; };
    return [
      { name: 'transit_thsr', label: '高鐵時刻票價', description: '查台灣高鐵（TDX 官方資料）：指定日期、起訖站、出發時間之後的班次（車次、出發／抵達時間、行車分鐘）、票價與座位狀態。站名用中文（台北、板橋、左營…）。',
        parameters: { type: 'object', properties: { from: S('起站，如 台北'), to: S('到站，如 左營'), date: S('日期 YYYY-MM-DD，或 today／tomorrow；省略＝今天'), time: S('出發時間之後 HH:MM（24 小時制），可省略'), limit: { type: 'integer', description: '最多幾班，預設 10' }, seats: { type: 'boolean', description: '是否附座位狀態，預設 true' } }, required: ['from', 'to'] } },
      { name: 'transit_tra', label: '台鐵時刻票價', description: '查臺鐵（TDX 官方資料）：指定日期、起訖站、出發時間之後的班次（車次、車種、時間）、票價與今日即時誤點。站名用中文（臺北、臺中、樹林…）。',
        parameters: { type: 'object', properties: { from: S('起站，如 臺北'), to: S('到站，如 臺中'), date: S('日期 YYYY-MM-DD，或 today／tomorrow；省略＝今天'), time: S('出發時間之後 HH:MM，可省略'), limit: { type: 'integer', description: '最多幾班，預設 10' } }, required: ['from', 'to'] } },
      { name: 'transit_metro', label: '捷運票價首末班', description: '查捷運／輕軌／纜車（TDX 官方資料）。system：台北／高雄／桃園／台中／高雄輕軌／淡海輕軌／安坑輕軌／貓空。票價：給 from＋to；首末班：mode=first_last＋station；即時到站：mode=live＋station。',
        parameters: { type: 'object', properties: { system: S('捷運系統，如 台北'), from: S('起站'), to: S('到站'), mode: S('fare（預設，有 from／to 時）／first_last／live'), station: S('車站（首末班或即時到站用）') }, required: ['system'] } },
      { name: 'transit_bus', label: '公車動態班表', description: '查公車（TDX 官方資料，含公路客運 city="公路客運"）。city＝縣市（臺北、新北、臺中、高雄…）。mode：eta（到站動態，預設）／stops（站序）／schedule（班表）／route（路線與票價說明）。',
        parameters: { type: 'object', properties: { city: S('縣市，如 臺北；公路客運寫 公路客運'), route: S('路線名稱，如 307、藍1'), mode: S('eta／stops／schedule／route'), stop: S('只看某站（站名，eta 用）'), direction: S('0 去程／1 返程'), limit: { type: 'integer', description: 'eta 最多幾筆' } }, required: ['city', 'route'] } }
    ].map(function (d) { d.readOnly = true; return d; });
  };
  /** 一般聊天要不要帶交通工具：訊息提到交通才送，避免平常浪費 token（比照桌面版 _NOVA_TRANSIT_TOOL_RX） */
  var RX = /高鐵|台鐵|臺鐵|火車|列車|捷運|輕軌|纜車|公車|客運|巴士|班次|時刻表|首末班|末班|頭班|票價|車資|車費|轉乘|到站|幾分鐘到|誤點|THSR|TRA\b|MRT|bus\b/i;
  API.looksLikeTransit = function (text) { return RX.test(String(text || '')); };

  root.NovaTransit = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);

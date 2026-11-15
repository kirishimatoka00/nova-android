/* ═══════════════════════════════════════════════════════════════════
   nova-travel-core.js — NOVA Android「TravelAgent」資料引擎（定位、周邊 2 公里設施、停車剩餘車位、天氣、路線規劃）
   版本：v1.0.2（2026-11-15，App v2.6.140）
   介面在 nova-travel.js；本檔不碰畫面，只負責抓資料與給 AI 用的工具（travel_where_am_i／travel_nearby／travel_route）。

   版本紀錄（只記這個檔案自己的變更）：
   v1.0.2 - App v2.6.140，依第二次真機截圖：
     ① 新北市停車場 0 筆：診斷顯示 TDX 的新北市路外停車場是 0 處。新北市改用市府開放資料（data.ntpc.gov.tw，免金鑰）：
        「新北市路外公共停車場資訊」（TWD97 二度分帶座標，前端換算成經緯度，用板橋遠東百貨驗算）＋「公有路外停車場即時賸餘車位數」
        （AVAILABLECAR，-9＝沒有即時資料），沒有設定 TDX 金鑰也能用。其他縣市照舊走 TDX。
     ② 周邊設施三個鏡像都逾時：查詢改用整體 bbox、只查 node／way（原本每類各一個 around 半徑查詢，密集市區很重），
        距離在前端篩；三個鏡像錯開 0／5／10 秒同時查、取最先成功的，單次等待上限 35 秒。
   v1.0.1 - App v2.6.139，依真機截圖修三個問題：
     ① 周邊設施全部查不到：overpass-api.de 回 406、private.coffee 回 429「請帶有意義的 User-Agent」、maps.mail.ru 憑證不被 Android 信任。
        原因是 App 內 fetch 走 CapacitorHttp 原生請求，User-Agent 是系統預設值。改成 App 裡的 GET 直接呼叫 CapacitorHttp 外掛並帶
        「NOVA-TravelAgent/1.0 (...)」UA（Overpass 改用 GET ?data=）；Nominatim／Photon／OSRM／Open-Meteo 也一併帶上。鏡像改為 overpass-api.de → private.coffee → kumi.systems。
     ② YouBike 回 404：TDX 的 NearBy 空間過濾最大半徑 1000 公尺，送 2000 會失敗。半徑 ≤1000 用 NearBy，否則（或 NearBy 失敗）改抓
        /v2/Bike/Station/City/{縣市}＋/v2/Bike/Availability/City/{縣市} 自己篩距離（站點快取 12 小時、可借數 60 秒）。
     ③ 停車 0 筆時看不出原因：範圍內沒有 TDX 停車場時，提示會列出各縣市 TDX 回傳幾處、幾處有座標、範圍內幾處。
   v1.0.0 - 首版。
     【定位】navigator.geolocation（WebView 內建，與主畫面右上角同一套權限）。先取高精度（逾時 15 秒、可用 1 分鐘內快取），失敗退回
            主畫面最近一次的真實位置（appState.lastLat/lastLon，manualLocIndex===0 時）或 localStorage nova_last_loc_v1（主程式 v1.4.6 存的），
            結果會標示來源（gps／app／cache）。地址用 Nominatim 反查（zh-TW、8 秒逾時）。
     【周邊設施】OpenStreetMap Overpass API（免金鑰；overpass-api.de → private.coffee → mail.ru 三個鏡像依序試，每個 25 秒逾時），
            一次查半徑內的 7 類：加油站（含電動車充電站）、停車場（汽車／機車）、醫療（醫院、診所、牙醫、藥局）、餐飲（餐廳、咖啡、速食、
            美食街、酒吧、甜點）、休閒（分室內／室外：電影院、博物館、KTV、健身、遊樂場、公園、景點…）、購物（超市、量販、百貨、商場、
            超商、藥妝、3C、書店）、大眾運輸（火車／捷運／輕軌站、捷運出入口併入車站、公車站、轉運站、YouBike、計程車招呼站）。
            沒有名稱的只保留加油站與停車場；公車站同名且相距 80 公尺內視為同一站（雙向站牌）。同一位置 10 分鐘內不重查。
     【停車剩餘車位】交通部 TDX（需要「專家與 Bot → 交通 API」的 TDX 金鑰，與大眾運輸工具共用 NovaTransit 的 token）：
            依地址判斷縣市，抓 /v1/Parking/OffStreet/CarPark/City/{City}（停車場位置，快取 12 小時）＋ ParkingAvailability/City/{City}
            （剩餘車位，快取 60 秒），篩出半徑內的停車場，附總車位、剩餘車位、汽車／機車分開的剩餘數、收費說明。台北／新北、新竹市／縣、
            嘉義市／縣互相鄰接，會兩個縣市一起查。和 OSM 的停車場在 60 公尺內視為同一處（用 TDX 的資料）。
            TDX 沒有「依座標查停車場」的端點，所以是抓整個縣市再自己算距離；沒有金鑰或縣市不在 TDX 時只顯示 OSM 停車場（沒有剩餘車位）。
            路邊停車格的即時資料（OnStreet）這版沒接。
     【YouBike】TDX /v2/Bike/Station/NearBy＋/v2/Bike/Availability/NearBy（$spatialFilter=nearby(lat,lon,半徑)），附可借／可還數；
            成功時取代 OSM 的自行車租借點。
     【天氣】Open-Meteo（免金鑰）：現在溫度／體感／濕度／降雨／風速／紫外線、今天高低溫與降雨機率、接下來 6 小時逐時。
     【路線】開車：OSRM（router.project-osrm.org，失敗改 routing.openstreetmap.de 的 routed-car）；走路／自行車：routing.openstreetmap.de
            （routed-foot／routed-bike）；大眾運輸：TDX MaaS 路徑規劃 /api/maas/routing（需要 TDX 金鑰；限流每分鐘 5 次，同起訖 5 分鐘快取）。
            逐步指示翻成中文；每條路線都附 Google 地圖導航連結（真正的語音導航交給 Google 地圖）。
     【目的地搜尋】先找已載入的周邊設施名稱，再查 Photon（komoot，以目前位置加權），最後 Nominatim。
     【誠實的限制】Overpass／OSRM／Photon／Nominatim 都是公益伺服器，尖峰時可能慢或拒絕；OSM 的店家資料由志工維護，可能缺漏或過時，
            營業時間只在 OSM 有填時才顯示。TDX 停車、YouBike、MaaS 的欄位是依 TDX 文件與公開範例寫的，沒有用真實金鑰在手機上實際呼叫過；
            MaaS 的參數格式若被 TDX 拒絕，會回報錯誤並提供 Google 地圖連結。
   ═══════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  var API = { VERSION: '1.0.2' };
  var LS = (function () { try { return root.localStorage; } catch (e) { return null; } })();

  // ───────────────────────── 共用 ─────────────────────────
  function withTimeout(p, ms, what) {
    return new Promise(function (res, rej) {
      var t = setTimeout(function () { rej(new Error((what || '請求') + '逾時（' + Math.round(ms / 1000) + ' 秒）')); }, ms);
      p.then(function (v) { clearTimeout(t); res(v); }, function (e) { clearTimeout(t); rej(e); });
    });
  }
  // v1.0.1：公益伺服器（Overpass、Nominatim、Photon、OSRM）要求可辨識的 User-Agent，WebView 的 fetch 改不了 UA，
  //   CapacitorHttp 原生請求預設的 UA（Dalvik／Java）會被 Overpass 回 406／429。所以 GET 請求在 App 裡改走 CapacitorHttp 外掛並帶上 App 自己的 UA。
  var UA = 'NOVA-TravelAgent/1.0 (Android app; +https://github.com/kirishimatoka00/nova-android)';
  function nativeHttp() { var cp = root.Capacitor; return cp && cp.isNativePlatform && cp.isNativePlatform() && cp.Plugins && cp.Plugins.CapacitorHttp; }
  async function httpJson(url, opt) {
    opt = opt || {};
    var CH = (!opt.method || opt.method === 'GET') && !opt.noNative ? nativeHttp() : null;
    if (CH) {
      var ms = opt.timeout || 15000;
      var nr = await withTimeout(CH.request({ method: 'GET', url: url, headers: Object.assign({ 'User-Agent': UA, 'Accept': opt.accept || 'application/json', 'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.5' }, opt.headers || {}),
        responseType: 'text', connectTimeout: ms, readTimeout: ms }), ms + 2000, opt.what || '連線');
      var body = typeof nr.data === 'string' ? nr.data : JSON.stringify(nr.data);
      if (nr.status < 200 || nr.status >= 300) throw new Error('HTTP ' + nr.status + (body ? ' ' + String(body).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 120) : ''));
      try { return typeof nr.data === 'object' && nr.data ? nr.data : JSON.parse(body); } catch (e) { throw new Error('回應不是 JSON：' + String(body).slice(0, 80)); }
    }
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var init = { method: opt.method || 'GET', headers: Object.assign({ 'Accept': 'application/json' }, opt.headers || {}) };
    if (opt.body != null) init.body = opt.body;
    if (ctl) init.signal = ctl.signal;
    var r;
    try { r = await withTimeout(root.fetch(url, init), opt.timeout || 15000, opt.what || '連線'); }
    catch (e) { try { ctl && ctl.abort(); } catch (e2) { /* */ } throw e; }
    var txt = await r.text();
    if (!r.ok) throw new Error('HTTP ' + r.status + (txt ? ' ' + String(txt).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 120) : ''));
    try { return JSON.parse(txt); } catch (e) { throw new Error('回應不是 JSON：' + String(txt).slice(0, 80)); }
  }
  var R_EARTH = 6371000;
  function dist(a, b, c, d) {   // 公尺
    var p = Math.PI / 180, dLa = (c - a) * p, dLo = (d - b) * p;
    var h = Math.sin(dLa / 2) * Math.sin(dLa / 2) + Math.cos(a * p) * Math.cos(c * p) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  API.dist = dist;
  function fmtDist(m) { return m < 1000 ? Math.round(m / 10) * 10 + ' 公尺' : (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' 公里'; }
  function fmtDur(s) { s = Math.round(s / 60); if (s < 60) return Math.max(1, s) + ' 分鐘'; return Math.floor(s / 60) + ' 小時' + (s % 60 ? ' ' + (s % 60) + ' 分' : ''); }
  API.fmtDist = fmtDist; API.fmtDur = fmtDur;
  function gmapsNav(lat, lon, mode, oLat, oLon) {
    var tm = { driving: 'driving', walking: 'walking', cycling: 'bicycling', transit: 'transit' }[mode] || 'driving';
    return 'https://www.google.com/maps/dir/?api=1' + (oLat != null ? '&origin=' + oLat.toFixed(6) + ',' + oLon.toFixed(6) : '') +
      '&destination=' + (+lat).toFixed(6) + ',' + (+lon).toFixed(6) + '&travelmode=' + tm + '&dir_action=navigate';
  }
  API.gmapsNav = gmapsNav;

  // ───────────────────────── 定位 ─────────────────────────
  var lastPos = null;   // {lat,lon,acc,src,at}
  function geoOnce(opt) {
    return new Promise(function (res, rej) {
      if (!root.navigator || !root.navigator.geolocation) return rej(new Error('這台裝置不支援定位'));
      root.navigator.geolocation.getCurrentPosition(function (p) { res(p); }, function (e) {
        rej(new Error(e && e.code === 1 ? '定位權限被拒絕（請到系統設定允許 NOVA 使用位置）' : e && e.code === 2 ? '目前取不到位置（定位服務可能沒開）' : '定位逾時'));
      }, opt);
    });
  }
  /** 取得目前位置。opts.fresh=true 不吃快取。回傳 {lat,lon,acc,src,at,warn?} */
  API.locate = async function (opts) {
    opts = opts || {};
    try {
      var p = await geoOnce({ enableHighAccuracy: true, timeout: opts.timeout || 15000, maximumAge: opts.fresh ? 0 : 60000 });
      lastPos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: Math.round(p.coords.accuracy || 0), src: 'gps', at: Date.now() };
      return lastPos;
    } catch (e) {
      // 高精度失敗 → 低精度再試一次（室內常見）
      try {
        var p2 = await geoOnce({ enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
        lastPos = { lat: p2.coords.latitude, lon: p2.coords.longitude, acc: Math.round(p2.coords.accuracy || 0), src: 'gps', at: Date.now() };
        return lastPos;
      } catch (e2) { /* 往下退 */ }
      var st = root.appState;
      if (st && st.manualLocIndex === 0 && !st._locFallback && isFinite(st.lastLat) && isFinite(st.lastLon) && st.lastLat) {
        return { lat: st.lastLat, lon: st.lastLon, acc: 0, src: 'app', at: Date.now(), warn: '這次定位失敗（' + e.message + '），改用 App 稍早取得的位置' };
      }
      try {
        var o = JSON.parse((LS && LS.getItem('nova_last_loc_v1')) || 'null');
        if (o && isFinite(o.lat) && isFinite(o.lon)) return { lat: o.lat, lon: o.lon, acc: 0, src: 'cache', at: o.at || 0, warn: '這次定位失敗（' + e.message + '），改用上次成功的位置（' + new Date(o.at || 0).toLocaleString('zh-TW', { hour12: false }) + '）' };
      } catch (e3) { /* */ }
      throw e;
    }
  };
  API.lastPos = function () { return lastPos; };

  var addrCache = {};
  /** 反查地址：{text, city, district, road} */
  API.reverse = async function (lat, lon) {
    var k = lat.toFixed(4) + ',' + lon.toFixed(4);
    if (addrCache[k]) return addrCache[k];
    var d = await httpJson('https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=' + lat.toFixed(6) + '&lon=' + lon.toFixed(6) + '&zoom=18&addressdetails=1&accept-language=zh-TW', { timeout: 8000, what: '地址查詢' });
    var a = d.address || {};
    var city = a.city || a.county || a.state || '', district = a.suburb || a.city_district || a.town || a.district || a.village || '';
    var road = (a.road || a.pedestrian || '') + (a.house_number ? a.house_number + (/號$/.test(a.house_number) ? '' : '號') : '');   // v1.0.2：門牌本身可能已含「號」
    var text = (city + district + road) || (d.display_name || '').split(',').reverse().map(function (x) { return x.trim(); }).filter(function (x) { return x && !/^\d{3,6}$/.test(x) && x !== '臺灣' && x !== '台灣'; }).join('');
    var out = { text: text || '目前位置', city: city, district: district, road: road, poi: d.name || '' };
    addrCache[k] = out; return out;
  };

  // ───────────────────────── 類別 ─────────────────────────
  var CATS = [
    { id: 'fuel', zh: '加油站', icon: '⛽', color: '#f59e0b' },
    { id: 'parking', zh: '停車', icon: '🅿️', color: '#ec4899' },
    { id: 'medical', zh: '醫療', icon: '🏥', color: '#ef4444' },
    { id: 'food', zh: '餐飲', icon: '🍜', color: '#f97316' },
    { id: 'fun', zh: '休閒', icon: '🎡', color: '#a855f7' },
    { id: 'shop', zh: '購物', icon: '🛒', color: '#10b981' },
    { id: 'transit', zh: '運輸', icon: '🚇', color: '#06b6d4' }
  ];
  API.CATS = CATS;
  var CAT_BY_ID = {}; CATS.forEach(function (c) { CAT_BY_ID[c.id] = c; });
  API.cat = function (id) { return CAT_BY_ID[id]; };

  var M = {   // tag=value → [cat, 子類, 室內(fun 用：1 室內 0 室外)]
    'amenity=fuel': ['fuel', '加油站'], 'amenity=charging_station': ['fuel', '充電站'],
    'amenity=parking': ['parking', '停車場'], 'amenity=motorcycle_parking': ['parking', '機車停車'],
    'amenity=hospital': ['medical', '醫院'], 'amenity=clinic': ['medical', '診所'], 'amenity=doctors': ['medical', '診所'],
    'amenity=dentist': ['medical', '牙醫'], 'amenity=pharmacy': ['medical', '藥局'], 'healthcare=hospital': ['medical', '醫院'],
    'healthcare=clinic': ['medical', '診所'], 'healthcare=doctor': ['medical', '診所'], 'healthcare=dentist': ['medical', '牙醫'], 'healthcare=pharmacy': ['medical', '藥局'],
    'amenity=restaurant': ['food', '餐廳'], 'amenity=cafe': ['food', '咖啡'], 'amenity=fast_food': ['food', '速食小吃'], 'amenity=food_court': ['food', '美食街'],
    'amenity=bar': ['food', '酒吧'], 'amenity=pub': ['food', '酒吧'], 'amenity=ice_cream': ['food', '甜點冰品'], 'shop=bakery': ['food', '麵包烘焙'], 'shop=pastry': ['food', '甜點冰品'],
    'amenity=cinema': ['fun', '電影院', 1], 'amenity=theatre': ['fun', '劇場', 1], 'amenity=arts_centre': ['fun', '藝文中心', 1], 'amenity=karaoke_box': ['fun', 'KTV', 1],
    'amenity=library': ['fun', '圖書館', 1], 'tourism=museum': ['fun', '博物館', 1], 'tourism=gallery': ['fun', '展覽館', 1], 'tourism=aquarium': ['fun', '水族館', 1],
    'leisure=sports_centre': ['fun', '運動中心', 1], 'leisure=fitness_centre': ['fun', '健身房', 1], 'leisure=bowling_alley': ['fun', '保齡球', 1],
    'leisure=amusement_arcade': ['fun', '遊藝場', 1], 'leisure=escape_game': ['fun', '密室逃脫', 1], 'leisure=ice_rink': ['fun', '溜冰場', 1], 'leisure=indoor_play': ['fun', '室內遊樂', 1],
    'leisure=park': ['fun', '公園', 0], 'leisure=playground': ['fun', '遊戲場', 0], 'leisure=garden': ['fun', '花園', 0], 'leisure=nature_reserve': ['fun', '自然保留區', 0],
    'leisure=stadium': ['fun', '體育場', 0], 'leisure=water_park': ['fun', '水上樂園', 0], 'leisure=swimming_pool': ['fun', '游泳池', 0],
    'tourism=attraction': ['fun', '景點', 0], 'tourism=theme_park': ['fun', '主題樂園', 0], 'tourism=zoo': ['fun', '動物園', 0], 'tourism=viewpoint': ['fun', '觀景點', 0], 'tourism=picnic_site': ['fun', '野餐區', 0],
    'shop=supermarket': ['shop', '超市'], 'shop=hypermarket': ['shop', '量販店'], 'shop=wholesale': ['shop', '量販店'], 'shop=department_store': ['shop', '百貨公司'],
    'shop=mall': ['shop', '購物中心'], 'shop=convenience': ['shop', '便利商店'], 'shop=chemist': ['shop', '藥妝'], 'shop=cosmetics': ['shop', '藥妝'],
    'shop=electronics': ['shop', '3C'], 'shop=mobile_phone': ['shop', '3C'], 'shop=books': ['shop', '書店'], 'shop=variety_store': ['shop', '生活百貨'], 'shop=doityourself': ['shop', '五金居家'], 'shop=hardware': ['shop', '五金居家'],
    'amenity=marketplace': ['shop', '市場'],
    'railway=station': ['transit', '車站'], 'railway=halt': ['transit', '車站'], 'public_transport=station': ['transit', '車站'], 'railway=subway_entrance': ['transit', '捷運出入口'],
    'highway=bus_stop': ['transit', '公車站'], 'amenity=bus_station': ['transit', '轉運站'], 'amenity=bicycle_rental': ['transit', '自行車租借'], 'amenity=taxi': ['transit', '計程車招呼站']
  };
  var KEYS = ['amenity', 'healthcare', 'shop', 'leisure', 'tourism', 'railway', 'public_transport', 'highway'];
  function classify(t) {
    for (var i = 0; i < KEYS.length; i++) { var k = KEYS[i]; if (t[k]) { var m = M[k + '=' + t[k]]; if (m) return m; } }
    return null;
  }
  function overpassQuery(lat, lon, r) {
    // v1.0.2：改用整體 bbox（比每條 around 快很多，密集市區 2 公里 around 常常 25 秒逾時），只查 node／way，距離在前端再篩
    var dLa = r / 111320, dLo = r / (111320 * Math.cos(lat * Math.PI / 180));
    var bb = (lat - dLa).toFixed(6) + ',' + (lon - dLo).toFixed(6) + ',' + (lat + dLa).toFixed(6) + ',' + (lon + dLo).toFixed(6);
    var a = '';
    function rx(vals) { return '"^(' + vals.join('|') + ')$"'; }
    var am = ['fuel', 'charging_station', 'parking', 'motorcycle_parking', 'hospital', 'clinic', 'doctors', 'dentist', 'pharmacy', 'restaurant', 'cafe', 'fast_food', 'food_court', 'bar', 'pub', 'ice_cream',
      'cinema', 'theatre', 'arts_centre', 'karaoke_box', 'library', 'marketplace', 'bus_station', 'bicycle_rental', 'taxi'];
    var shop = ['supermarket', 'hypermarket', 'wholesale', 'department_store', 'mall', 'convenience', 'chemist', 'cosmetics', 'electronics', 'mobile_phone', 'books', 'variety_store', 'doityourself', 'hardware', 'bakery', 'pastry'];
    var lei = ['sports_centre', 'fitness_centre', 'bowling_alley', 'amusement_arcade', 'escape_game', 'ice_rink', 'indoor_play', 'park', 'playground', 'garden', 'nature_reserve', 'stadium', 'water_park', 'swimming_pool'];
    var tour = ['museum', 'gallery', 'aquarium', 'attraction', 'theme_park', 'zoo', 'viewpoint', 'picnic_site'];
    return '[out:json][timeout:25][bbox:' + bb + '];(' +
      'nw["amenity"~' + rx(am) + '];' +
      'nw["healthcare"~' + rx(['hospital', 'clinic', 'doctor', 'dentist', 'pharmacy']) + '];' +
      'nw["shop"~' + rx(shop) + '];' +
      'nw["leisure"~' + rx(lei) + '];' +
      'nw["tourism"~' + rx(tour) + '];' +
      'nw["railway"~"^(station|halt|subway_entrance)$"];' +
      'nw["public_transport"="station"];' +
      'node["highway"="bus_stop"];' +
      ');out center qt;';
  }
  var OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];   // v1.0.1：拿掉 maps.mail.ru（Android 不信任它的憑證）
  function nameOf(t) { return t['name:zh-Hant'] || t['name:zh_hant'] || t['name:zh-TW'] || t.name || t['name:zh'] || t.brand || ''; }
  function addrOf(t) {
    var s = (t['addr:city'] || '') + (t['addr:district'] || '') + (t['addr:street'] || '') + (t['addr:housenumber'] ? t['addr:housenumber'] + (/號$/.test(t['addr:housenumber']) ? '' : '號') : '');
    return s || t['addr:full'] || '';
  }
  function parseOsm(els, lat, lon) {
    var out = [];
    (els || []).forEach(function (e) {
      var t = e.tags || {}, c = classify(t); if (!c) return;
      var la = e.lat != null ? e.lat : e.center && e.center.lat, lo = e.lon != null ? e.lon : e.center && e.center.lon;
      if (la == null || lo == null) return;
      var nm = nameOf(t);
      if (!nm) { if (c[0] === 'fuel' || c[0] === 'parking') nm = c[1]; else return; }
      var it = { id: 'osm:' + e.type + '/' + e.id, cat: c[0], sub: c[1], name: String(nm).trim(), lat: la, lon: lo, d: Math.round(dist(lat, lon, la, lo)), src: 'OSM' };
      if (c[0] === 'fun') it.indoor = t.indoor === 'yes' ? 1 : t.indoor === 'no' ? 0 : (c[2] != null ? c[2] : 0);
      var ad = addrOf(t); if (ad) it.addr = ad;
      if (t.opening_hours) it.hours = t.opening_hours;
      if (t.phone || t['contact:phone']) it.phone = t.phone || t['contact:phone'];
      if (t.brand && t.brand !== it.name) it.brand = t.brand;
      if (t.cuisine) it.cuisine = t.cuisine;
      if (c[0] === 'parking') { if (t.capacity) it.total = +t.capacity || undefined; if (t.fee) it.fee = t.fee === 'no' ? '免費' : t.fee === 'yes' ? '收費' : t.fee; if (t.parking) it.ptype = t.parking; }
      if (c[0] === 'fuel' && t.brand) it.brand = t.brand;
      if (c[1] === '捷運出入口') { it.sub = '捷運出入口'; }
      out.push(it);
    });
    // 去重：公車站同名 80m 內合併；捷運出入口若 250m 內有同名車站就併入；同名同類 30m 內合併（建築 way+node 重複）
    out.sort(function (a, b) { return a.d - b.d; });
    var keep = [];
    out.forEach(function (it) {
      var dup = keep.some(function (k) {
        if (k.cat !== it.cat) return false;
        var near = dist(k.lat, k.lon, it.lat, it.lon);
        if (it.sub === '公車站' && k.sub === '公車站' && k.name === it.name && near < 80) return true;
        if (it.sub === '捷運出入口' && (k.sub === '車站' || k.sub === '捷運出入口') && near < 250 && (it.name.indexOf(k.name.replace(/站$/, '')) >= 0 || k.name.indexOf(it.name.replace(/\s*\d+號?出口.*$/, '').replace(/站$/, '')) >= 0)) return true;
        return k.name === it.name && near < 30;
      });
      if (!dup) keep.push(it);
    });
    return keep;
  }
  var osmCache = null;   // {lat,lon,r,at,items}
  async function fetchOsm(lat, lon, r, force) {
    if (!force && osmCache && osmCache.r >= r && dist(osmCache.lat, osmCache.lon, lat, lon) < 200 && Date.now() - osmCache.at < 600000) {
      return osmCache.items.map(function (it) { return Object.assign({}, it, { d: Math.round(dist(lat, lon, it.lat, it.lon)) }); }).filter(function (it) { return it.d <= r; });
    }
    var q = overpassQuery(lat, lon, r), errs = [];
    // v1.0.2：三個鏡像錯開 0／5／10 秒同時查，取最先成功的（原本一個逾時才換下一個，最壞要等 90 秒）
    var res = await new Promise(function (resolve) {
      var left = OVERPASS.length, done = false;
      OVERPASS.forEach(function (host, i) {
        setTimeout(async function () {
          if (done) { left--; return; }
          try {
            var d = nativeHttp()
              ? await httpJson(host + '?data=' + encodeURIComponent(q), { timeout: 35000, accept: '*/*', what: '周邊設施查詢' })
              : await httpJson(host, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body: 'data=' + encodeURIComponent(q), timeout: 35000, what: '周邊設施查詢' });
            if (!done) { done = true; resolve(d); }
          } catch (e) { errs.push(host.split('/')[2] + '：' + ((e && e.message) || e)); }
          if (--left === 0 && !done) resolve(null);
        }, i * 5000);
      });
    });
    if (res) {
      var items = parseOsm(res.elements, lat, lon).filter(function (it) { return it.d <= r; });
      osmCache = { lat: lat, lon: lon, r: r, at: Date.now(), items: items };
      return items;
    }
    throw new Error('周邊設施查詢失敗（' + errs.join('；') + '）');
  }

  // ───────────────────────── TDX：停車、YouBike、MaaS ─────────────────────────
  function NT() { return root.NovaTransit; }
  API.hasTdx = function () { var t = NT(); return !!(t && t.hasKeys && t.hasKeys()); };
  var CITY = [['臺北市', 'Taipei'], ['台北市', 'Taipei'], ['新北市', 'NewTaipei'], ['桃園市', 'Taoyuan'], ['臺中市', 'Taichung'], ['台中市', 'Taichung'], ['臺南市', 'Tainan'], ['台南市', 'Tainan'],
    ['高雄市', 'Kaohsiung'], ['基隆市', 'Keelung'], ['新竹市', 'Hsinchu'], ['新竹縣', 'HsinchuCounty'], ['苗栗縣', 'MiaoliCounty'], ['彰化縣', 'ChanghuaCounty'], ['南投縣', 'NantouCounty'],
    ['雲林縣', 'YunlinCounty'], ['嘉義市', 'Chiayi'], ['嘉義縣', 'ChiayiCounty'], ['屏東縣', 'PingtungCounty'], ['宜蘭縣', 'YilanCounty'], ['花蓮縣', 'HualienCounty'],
    ['臺東縣', 'TaitungCounty'], ['台東縣', 'TaitungCounty'], ['澎湖縣', 'PenghuCounty'], ['金門縣', 'KinmenCounty'], ['連江縣', 'LienchiangCounty']];
  var PAIR = { Taipei: 'NewTaipei', NewTaipei: 'Taipei', Hsinchu: 'HsinchuCounty', HsinchuCounty: 'Hsinchu', Chiayi: 'ChiayiCounty', ChiayiCounty: 'Chiayi' };
  // 縣市中心（沒有地址時用最近的兩個）
  var CENTER = { Taipei: [25.04, 121.56], NewTaipei: [25.01, 121.46], Taoyuan: [24.99, 121.30], Taichung: [24.15, 120.67], Tainan: [22.99, 120.21], Kaohsiung: [22.63, 120.30], Keelung: [25.13, 121.74],
    Hsinchu: [24.80, 120.97], HsinchuCounty: [24.83, 121.01], MiaoliCounty: [24.56, 120.82], ChanghuaCounty: [24.07, 120.54], NantouCounty: [23.91, 120.68], YunlinCounty: [23.71, 120.43],
    Chiayi: [23.48, 120.45], ChiayiCounty: [23.46, 120.25], PingtungCounty: [22.67, 120.49], YilanCounty: [24.75, 121.75], HualienCounty: [23.99, 121.60], TaitungCounty: [22.76, 121.14],
    PenghuCounty: [23.57, 119.58], KinmenCounty: [24.43, 118.32], LienchiangCounty: [26.16, 119.95] };
  function citiesFor(addrCity, lat, lon) {
    var out = [];
    CITY.forEach(function (c) { if (addrCity && addrCity.indexOf(c[0]) >= 0 && out.indexOf(c[1]) < 0) out.push(c[1]); });
    if (!out.length) {
      var arr = Object.keys(CENTER).map(function (k) { return [k, dist(lat, lon, CENTER[k][0], CENTER[k][1])]; }).sort(function (a, b) { return a[1] - b[1]; });
      if (arr[0][1] < 60000) out.push(arr[0][0]);
    }
    if (out[0] && PAIR[out[0]]) out.push(PAIR[out[0]]);
    return out;
  }
  API._citiesFor = citiesFor;
  function zh(x) { return x && typeof x === 'object' ? (x.Zh_tw || x.En || '') : (x || ''); }
  function lst(x) { return Array.isArray(x) ? x : (x && (x.ParkingAvailabilities || x.CarParks || x.Stations || x.BikeStations || x.Availabilities)) || []; }
  /** TWD97 二度分帶（TM2，中央經線 121°）→ WGS84 經緯度（新北市開放資料用） */
  function tm2ToWgs(x, y) {
    var a = 6378137, f = 1 / 298.257222101, b = a * (1 - f), k0 = 0.9999, lon0 = 121 * Math.PI / 180;
    var e2 = 1 - (b * b) / (a * a), ep2 = e2 / (1 - e2);
    x -= 250000;
    var mu = (y / k0) / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 * e2 * e2 / 256));
    var e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
    var fp = mu + (3 * e1 / 2 - 27 * Math.pow(e1, 3) / 32) * Math.sin(2 * mu) + (21 * e1 * e1 / 16 - 55 * Math.pow(e1, 4) / 32) * Math.sin(4 * mu) + (151 * Math.pow(e1, 3) / 96) * Math.sin(6 * mu) + (1097 * Math.pow(e1, 4) / 512) * Math.sin(8 * mu);
    var s = Math.sin(fp), c = Math.cos(fp), t = Math.tan(fp);
    var C1 = ep2 * c * c, T1 = t * t, N1 = a / Math.sqrt(1 - e2 * s * s), R1 = a * (1 - e2) / Math.pow(1 - e2 * s * s, 1.5), D = x / (N1 * k0);
    var lat = fp - (N1 * t / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * Math.pow(D, 4) / 24 + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * Math.pow(D, 6) / 720);
    var lon = lon0 + (D - (1 + 2 * T1 + C1) * Math.pow(D, 3) / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * Math.pow(D, 5) / 120) / c;
    return [lat * 180 / Math.PI, lon * 180 / Math.PI];
  }
  API._tm2ToWgs = tm2ToWgs;
  // v1.0.2：新北市自己的開放資料（TDX 的新北市路外停車場是 0 筆）。免金鑰。
  //   靜態：新北市路外公共停車場資訊（ID、NAME、ADDRESS、PAYEX、SERVICETIME、TW97X／TW97Y、TOTALCAR、TOTALMOTOR），快取 12 小時
  //   即時：新北市公有路外停車場即時賸餘車位數（ID、AVAILABLECAR；-9＝沒有即時資料），每 3 分鐘更新，快取 60 秒
  var NTPC_STATIC = 'https://data.ntpc.gov.tw/api/datasets/b1464ef0-9c7c-4a6f-abf7-6bdf32847e68/json';
  var NTPC_AVAIL = 'https://data.ntpc.gov.tw/api/datasets/e09b35a5-a738-48cc-b0f5-570b67ad9c78/json';
  var ntpcCache = { st: null, stAt: 0, av: null, avAt: 0 };
  async function ntpcAll(url) {
    var out = [];
    for (var pg = 0; pg < 10; pg++) {
      var d = await httpJson(url + '?page=' + pg + '&size=1000', { timeout: 20000, what: '新北市停車資料' });
      if (!Array.isArray(d) || !d.length) break;
      out = out.concat(d); if (d.length < 1000) break;
    }
    return out;
  }
  async function fetchNtpcParking(lat, lon, r) {
    if (!ntpcCache.st || Date.now() - ntpcCache.stAt > 43200000) {
      ntpcCache.st = (await ntpcAll(NTPC_STATIC)).map(function (p) {
        var x = parseFloat(p.TW97X), y = parseFloat(p.TW97Y); if (!(x > 100000 && y > 2000000)) return null;
        var ll = tm2ToWgs(x, y);
        return { pid: p.ID, name: p.NAME, lat: ll[0], lon: ll[1], addr: (p.ADDRESS || '').indexOf('新北') === 0 ? p.ADDRESS : '新北市' + (p.ADDRESS || ''), fare: p.PAYEX || '', hours: p.SERVICETIME || '', total: +p.TOTALCAR || undefined, totalMoto: +p.TOTALMOTOR || undefined };
      }).filter(Boolean);
      ntpcCache.stAt = Date.now();
    }
    var near = ntpcCache.st.map(function (p) { var d = dist(lat, lon, p.lat, p.lon); return d <= r ? Object.assign({ id: 'ntpc:' + p.pid, cat: 'parking', sub: '停車場', d: Math.round(d), src: '新北市' }, p) : null; }).filter(Boolean);
    var note = '';
    if (near.length) {
      try {
        if (!ntpcCache.av || Date.now() - ntpcCache.avAt > 60000) {
          var m = {}; (await ntpcAll(NTPC_AVAIL)).forEach(function (a) { m[a.ID] = parseInt(a.AVAILABLECAR, 10); });
          ntpcCache.av = m; ntpcCache.avAt = Date.now();
        }
        near.forEach(function (it) { var v = ntpcCache.av[it.pid]; if (isFinite(v) && v >= 0) { it.avail = v; it.car = v; if (v === 0) it.full = true; } });
      } catch (e) { note = '新北市剩餘車位查詢失敗：' + e.message; }
    }
    return { items: near, stat: '新北市開放資料：停車場 ' + ntpcCache.st.length + ' 處，範圍內 ' + near.length + ' 處', note: note };
  }
  /** 半徑內 TDX 停車場（含剩餘車位） */
  async function fetchParking(lat, lon, r, addrCity) {
    var t = NT(), hasTdx = API.hasTdx();
    var cities = citiesFor(addrCity, lat, lon);
    var items = [], notes = [], stats = [];
    if (cities.indexOf('NewTaipei') >= 0) {   // v1.0.2：新北市用市府開放資料（TDX 沒有新北市路外停車場）
      try { var np = await fetchNtpcParking(lat, lon, r); items = items.concat(np.items); stats.push(np.stat); if (np.note) notes.push(np.note); }
      catch (e) { notes.push('新北市停車資料查詢失敗：' + e.message); }
    }
    if (!hasTdx) {
      if (!items.length) notes.push(cities.indexOf('NewTaipei') >= 0 ? '範圍內沒有新北市公有停車場資料' : '沒有設定 TDX 金鑰，停車場沒有剩餘車位資訊（設定 → 專家與 Bot → 交通 API）');
      return { items: items, note: notes.join('；') };
    }
    if (!cities.length) return { items: items, note: '這個位置不在 TDX 停車資料涵蓋的縣市' };
    for (var i = 0; i < cities.length; i++) {
      var city = cities[i];
      if (city === 'NewTaipei') continue;   // 新北市已用市府資料
      try {
        var parks = lst(await t._tdxGet('/v1/Parking/OffStreet/CarPark/City/' + city, { $select: 'CarParkID,CarParkName,CarParkPosition,Address,FareDescription' }, 43200));
        var withPos = parks.filter(function (p) { var q = p.CarParkPosition || {}; return isFinite(q.PositionLat) && isFinite(q.PositionLon) && q.PositionLat; }).length;
        var near = parks.map(function (p) {
          var pos = p.CarParkPosition || {}; if (!isFinite(pos.PositionLat) || !isFinite(pos.PositionLon)) return null;
          var d = dist(lat, lon, pos.PositionLat, pos.PositionLon); if (d > r) return null;
          return { id: 'tdx:' + city + ':' + p.CarParkID, pid: p.CarParkID, cat: 'parking', sub: '停車場', name: zh(p.CarParkName) || '停車場', lat: pos.PositionLat, lon: pos.PositionLon, d: Math.round(d),
            addr: p.Address || '', fare: p.FareDescription || '', src: 'TDX', city: city };
        }).filter(Boolean);
        stats.push(CITY_ZH[city] + '：TDX 停車場 ' + parks.length + ' 處（有座標 ' + withPos + '），範圍內 ' + near.length + ' 處');
        if (!near.length) continue;
        var avs = [];
        try { avs = lst(await t._tdxGet('/v1/Parking/OffStreet/ParkingAvailability/City/' + city, { $select: 'CarParkID,TotalSpaces,AvailableSpaces,Availabilities,ServiceStatus,FullStatus,DataCollectTime' }, 60)); }
        catch (e) { notes.push(city + ' 剩餘車位查詢失敗：' + e.message); }
        var byId = {}; avs.forEach(function (a) { byId[a.CarParkID] = a; });
        near.forEach(function (it) {
          var a = byId[it.pid]; if (!a) return;
          if (a.TotalSpaces > 0) it.total = a.TotalSpaces;
          if (a.AvailableSpaces >= 0) it.avail = a.AvailableSpaces;
          (a.Availabilities || []).forEach(function (x) {
            if (!(x.AvailableSpaces >= 0)) return;
            if (x.SpaceType === 1) it.car = x.AvailableSpaces; else if (x.SpaceType === 2) it.moto = x.AvailableSpaces;
          });
          if (a.ServiceStatus === 0) it.closed = true;
          if (a.FullStatus === 1) it.full = true;
          if (a.DataCollectTime) it.at = a.DataCollectTime;
        });
        items = items.concat(near);
      } catch (e) { notes.push(city + '：' + e.message); }
    }
    if (!items.length && stats.length) notes.push('範圍內沒有停車場即時資料（' + stats.join('；') + '）');
    return { items: items, note: notes.join('；') };
  }
  var CITY_ZH = {}; CITY.forEach(function (c) { if (!CITY_ZH[c[1]]) CITY_ZH[c[1]] = c[0]; });
  /** 半徑內 YouBike（含可借可還） */
  // v1.0.1：TDX 的 NearBy 空間過濾最大半徑 1000 公尺（送 2000 會失敗）。先用 NearBy（≤1000m），失敗或要更大範圍時改抓整個縣市再自己篩。
  function bikeItem(s, a, lat, lon) {
    var pos = s.StationPosition || {}; if (!isFinite(pos.PositionLat) || !pos.PositionLat) return null;
    a = a || {};
    var it = { id: 'bike:' + s.StationUID, cat: 'transit', sub: 'YouBike', name: zh(s.StationName).replace(/^YouBike\s*\d(\.\d)?_?/i, '') || 'YouBike', lat: pos.PositionLat, lon: pos.PositionLon,
      d: Math.round(dist(lat, lon, pos.PositionLat, pos.PositionLon)), src: 'TDX', addr: zh(s.StationAddress) };
    if (a.AvailableRentBikes >= 0) it.rent = a.AvailableRentBikes;
    if (a.AvailableReturnBikes >= 0) it.ret = a.AvailableReturnBikes;
    if (a.AvailableRentBikesDetail && a.AvailableRentBikesDetail.ElectricBikes >= 0) it.ebike = a.AvailableRentBikesDetail.ElectricBikes;
    if (a.ServiceStatus === 0 || a.ServiceStatus === 2) it.closed = true;
    return it;
  }
  async function fetchBikes(lat, lon, r, addrCity) {
    var t = NT(); if (!API.hasTdx()) return { items: [] };
    var errs = [];
    if (r <= 1000) {
      try {
        var sf = 'nearby(' + lat.toFixed(6) + ',' + lon.toFixed(6) + ',' + r + ')';
        var st = lst(await t._tdxGet('/v2/Bike/Station/NearBy', { $spatialFilter: sf, $top: 300 }, 3600));
        var av = []; try { av = lst(await t._tdxGet('/v2/Bike/Availability/NearBy', { $spatialFilter: sf, $top: 300 }, 0)); } catch (e) { /* 只有位置也可 */ }
        var by = {}; av.forEach(function (a) { by[a.StationUID] = a; });
        return { items: st.map(function (s) { return bikeItem(s, by[s.StationUID], lat, lon); }).filter(Boolean) };
      } catch (e) { errs.push(e.message); }
    }
    var cities = citiesFor(addrCity, lat, lon), items = [];
    for (var i = 0; i < cities.length; i++) {
      try {
        var all = lst(await t._tdxGet('/v2/Bike/Station/City/' + cities[i], { $select: 'StationUID,StationName,StationPosition,StationAddress' }, 43200));
        var near = all.filter(function (s) { var p = s.StationPosition || {}; return isFinite(p.PositionLat) && dist(lat, lon, p.PositionLat, p.PositionLon) <= r; });
        if (!near.length) continue;
        var avs = []; try { avs = lst(await t._tdxGet('/v2/Bike/Availability/City/' + cities[i], {}, 60)); } catch (e) { errs.push(CITY_ZH[cities[i]] + ' 可借數：' + e.message); }
        var byId = {}; avs.forEach(function (a) { byId[a.StationUID] = a; });
        items = items.concat(near.map(function (s) { return bikeItem(s, byId[s.StationUID], lat, lon); }).filter(Boolean));
      } catch (e) { if (!/404/.test(e.message)) errs.push(CITY_ZH[cities[i]] + '：' + e.message); }   // 404＝該縣市沒有公共自行車
    }
    if (!items.length && errs.length) throw new Error(errs.join('；'));
    return { items: items };
  }

  // ───────────────────────── 天氣 ─────────────────────────
  var WMO = { 0: '晴', 1: '大致晴朗', 2: '局部多雲', 3: '陰', 45: '霧', 48: '霧淞', 51: '毛毛雨', 53: '毛毛雨', 55: '濃毛毛雨', 56: '凍毛毛雨', 57: '凍毛毛雨', 61: '小雨', 63: '中雨', 65: '大雨',
    66: '凍雨', 67: '凍雨', 71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒', 80: '陣雨', 81: '較強陣雨', 82: '豪雨', 85: '陣雪', 86: '強陣雪', 95: '雷雨', 96: '雷雨夾冰雹', 99: '強雷雨夾冰雹' };
  var WICON = function (c) { return c === 0 ? '☀️' : c <= 2 ? '🌤️' : c === 3 ? '☁️' : c <= 48 ? '🌫️' : c <= 67 ? '🌧️' : c <= 77 ? '❄️' : c <= 82 ? '🌦️' : c <= 86 ? '🌨️' : '⛈️'; };
  API.wicon = WICON;
  var wxCache = {};
  API.weather = async function (lat, lon) {
    var k = lat.toFixed(2) + ',' + lon.toFixed(2), h = wxCache[k];
    if (h && Date.now() - h.at < 600000) return h.v;
    var d = await httpJson('https://api.open-meteo.com/v1/forecast?latitude=' + lat.toFixed(4) + '&longitude=' + lon.toFixed(4) +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,uv_index' +
      '&hourly=temperature_2m,precipitation_probability,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunset' +
      '&forecast_days=2&forecast_hours=7&timezone=auto', { timeout: 15000, what: '天氣' });
    var c = d.current || {}, hr = d.hourly || {}, dl = d.daily || {};
    var hours = (hr.time || []).slice(1, 7).map(function (t, i) { return { t: String(t).slice(11, 16), temp: (hr.temperature_2m || [])[i + 1], pop: (hr.precipitation_probability || [])[i + 1], code: (hr.weather_code || [])[i + 1] }; });
    var v = { temp: c.temperature_2m, feels: c.apparent_temperature, humidity: c.relative_humidity_2m, rain: c.precipitation, wind: c.wind_speed_10m, uv: c.uv_index,
      code: c.weather_code, text: WMO[c.weather_code] || '', icon: WICON(c.weather_code), tmax: (dl.temperature_2m_max || [])[0], tmin: (dl.temperature_2m_min || [])[0],
      pop: (dl.precipitation_probability_max || [])[0], sunset: String((dl.sunset || [])[0] || '').slice(11, 16), hours: hours.map(function (x) { x.text = WMO[x.code] || ''; x.icon = WICON(x.code); return x; }) };
    wxCache[k] = { at: Date.now(), v: v }; return v;
  };

  // ───────────────────────── 周邊總查詢 ─────────────────────────
  /** 一次抓全部：{pos, addr, wx, items[], notes[], at}。onPart(part) 可漸進更新畫面 */
  API.scan = async function (opts) {
    opts = opts || {};
    var r = Math.max(300, Math.min(+opts.radius || 2000, 5000));
    var pos = opts.pos || await API.locate({ fresh: !!opts.fresh });
    var res = { pos: pos, radius: r, addr: null, wx: null, items: [], notes: [], at: Date.now() };
    if (pos.warn) res.notes.push(pos.warn);
    var part = function (k) { try { opts.onPart && opts.onPart(k, res); } catch (e) { /* */ } };
    part('pos');
    var pAddr = API.reverse(pos.lat, pos.lon).then(function (a) { res.addr = a; part('addr'); return a; }, function (e) { res.notes.push('地址查詢失敗：' + e.message); return null; });
    var pWx = API.weather(pos.lat, pos.lon).then(function (w) { res.wx = w; part('wx'); }, function (e) { res.notes.push('天氣查詢失敗：' + e.message); res.wxErr = e.message; part('wx'); });
    var osm = [], tdxPark = [], bikes = null;
    var pOsm = fetchOsm(pos.lat, pos.lon, r, !!opts.force).then(function (x) { osm = x; merge(); part('items'); }, function (e) { res.notes.push(e.message); res.osmErr = e.message; part('items'); });
    var pPark = pAddr.then(function (a) { return fetchParking(pos.lat, pos.lon, r, a && a.city); }).then(function (x) { tdxPark = x.items; if (x.note) res.parkNote = x.note; merge(); part('items'); }, function (e) { res.parkNote = '停車剩餘車位查詢失敗：' + e.message; part('items'); });
    var pBike = pAddr.then(function (a) { return fetchBikes(pos.lat, pos.lon, r, a && a.city); }).then(function (x) { bikes = x.items; merge(); part('items'); }, function (e) { res.bikeNote = 'YouBike 查詢失敗：' + e.message; });
    function merge() {
      var list = osm.slice();
      if (tdxPark.length) list = list.filter(function (it) { return !(it.cat === 'parking' && tdxPark.some(function (p) { return dist(p.lat, p.lon, it.lat, it.lon) < 60; })); }).concat(tdxPark);
      if (bikes && bikes.length) list = list.filter(function (it) { return it.sub !== '自行車租借' || !/youbike|微笑/i.test(it.name); }).concat(bikes);
      list.sort(function (a, b) { return a.d - b.d; });
      res.items = list;
    }
    await Promise.all([pAddr, pWx, pOsm, pPark, pBike]);
    res.at = Date.now();
    lastScan = res;
    return res;
  };
  var lastScan = null;
  API.lastScan = function () { return lastScan; };

  // ───────────────────────── 目的地搜尋 ─────────────────────────
  API.search = async function (q, near) {
    q = String(q || '').trim(); if (!q) return [];
    var m = q.match(/^\s*(-?\d{1,2}\.\d+)\s*[, ]\s*(-?\d{1,3}\.\d+)\s*$/);
    if (m) return [{ name: q, lat: +m[1], lon: +m[2], addr: '座標', src: 'coord' }];
    var out = [], seen = {};
    function add(x) { var k = x.name + '@' + x.lat.toFixed(3) + ',' + x.lon.toFixed(3); if (seen[k]) return; seen[k] = 1; if (near) x.d = Math.round(dist(near.lat, near.lon, x.lat, x.lon)); out.push(x); }
    var ql = q.toLowerCase();
    if (lastScan) lastScan.items.forEach(function (it) { if (it.name.toLowerCase().indexOf(ql) >= 0) add({ name: it.name, lat: it.lat, lon: it.lon, addr: (it.sub || '') + (it.addr ? ' · ' + it.addr : ''), src: 'nearby' }); });
    var errs = [];
    try {
      var u = 'https://photon.komoot.io/api/?q=' + encodeURIComponent(q) + '&limit=8' + (near ? '&lat=' + near.lat.toFixed(5) + '&lon=' + near.lon.toFixed(5) : '');
      var d = await httpJson(u, { timeout: 10000, what: '地點搜尋' });
      (d.features || []).forEach(function (f) {
        var p = f.properties || {}, c = (f.geometry || {}).coordinates || []; if (c.length < 2) return;
        var ad = [p.city || p.county, p.district, p.locality, p.street, p.housenumber ? p.housenumber + (/^\d+(-\d+)?$/.test(p.housenumber) ? '號' : '') : ''].filter(Boolean).join('');
        add({ name: p.name || ad || q, lat: c[1], lon: c[0], addr: ad || p.state || '', src: 'photon' });
      });
    } catch (e) { errs.push('Photon：' + e.message); }
    if (out.length < 3) {
      try {
        var vb = near ? '&viewbox=' + (near.lon - 0.5).toFixed(3) + ',' + (near.lat + 0.5).toFixed(3) + ',' + (near.lon + 0.5).toFixed(3) + ',' + (near.lat - 0.5).toFixed(3) : '';
        var n = await httpJson('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=zh-TW&q=' + encodeURIComponent(q) + vb, { timeout: 10000, what: '地點搜尋' });
        (n || []).forEach(function (x) { add({ name: x.name || String(x.display_name || '').split(',')[0], lat: +x.lat, lon: +x.lon, addr: String(x.display_name || '').split(',').slice(1, 4).reverse().join('').replace(/\s+/g, ''), src: 'nominatim' }); });
      } catch (e) { errs.push('Nominatim：' + e.message); }
    }
    if (!out.length && errs.length) throw new Error('找不到「' + q + '」（' + errs.join('；') + '）');
    // 排序：名稱完全相同 → 名稱開頭相同 → 周邊清單裡的 → 其餘依距離
    var rank = function (x) { var n = String(x.name).toLowerCase(); return n === ql ? 0 : n.indexOf(ql) === 0 && n.length - ql.length <= 2 ? 1 : x.src === 'nearby' ? 2 : 3; };
    out.sort(function (a, b) { return rank(a) - rank(b) || ((a.d || 0) - (b.d || 0)); });
    return out.slice(0, 10);
  };

  // ───────────────────────── 路線 ─────────────────────────
  var MOD = { left: '左轉', right: '右轉', 'slight left': '靠左', 'slight right': '靠右', 'sharp left': '向左急轉', 'sharp right': '向右急轉', straight: '直行', uturn: '迴轉' };
  function stepText(s) {
    var mn = s.maneuver || {}, ty = mn.type, md = MOD[mn.modifier] || '', nm = s.name || s.ref || '';
    var onto = nm ? '進入' + nm : '';
    var t;
    if (ty === 'depart') t = '出發' + (nm ? '，沿' + nm : '');
    else if (ty === 'arrive') t = '抵達目的地' + (mn.modifier === 'left' ? '（在左側）' : mn.modifier === 'right' ? '（在右側）' : '');
    else if (ty === 'roundabout' || ty === 'rotary') t = '進入圓環，從第 ' + (mn.exit || 1) + ' 個出口離開' + (onto ? '，' + onto : '');
    else if (ty === 'merge') t = '匯入' + (nm || '道路');
    else if (ty === 'on ramp') t = (md ? md + '，' : '') + '上匝道' + (nm ? '往' + nm : '');
    else if (ty === 'off ramp') t = (md ? md + '，' : '') + '下匝道' + (nm ? '往' + nm : '');
    else if (ty === 'fork') t = '在岔路' + (md || '直行') + (onto ? '，' + onto : '');
    else if (ty === 'end of road') t = '道路盡頭' + (md || '轉彎') + (onto ? '，' + onto : '');
    else if (ty === 'new name' || ty === 'continue') t = (md && md !== '直行' ? md + '，' : '繼續') + (nm ? '沿' + nm : '前進');
    else t = (md || '前進') + (onto ? '，' + onto : '');
    return t;
  }
  var ROUTERS = {
    driving: ['https://router.project-osrm.org/route/v1/driving/', 'https://routing.openstreetmap.de/routed-car/route/v1/driving/'],
    walking: ['https://routing.openstreetmap.de/routed-foot/route/v1/driving/'],
    cycling: ['https://routing.openstreetmap.de/routed-bike/route/v1/driving/']
  };
  var routeCache = {};
  async function osrmRoute(o, d, mode) {
    var errs = [], list = ROUTERS[mode] || ROUTERS.driving;
    for (var i = 0; i < list.length; i++) {
      try {
        var j = await httpJson(list[i] + o.lon.toFixed(6) + ',' + o.lat.toFixed(6) + ';' + d.lon.toFixed(6) + ',' + d.lat.toFixed(6) + '?overview=full&geometries=geojson&steps=true&alternatives=false', { timeout: 15000, what: '路線規劃' });
        if (j.code && j.code !== 'Ok') throw new Error(j.message || j.code);
        var rt = (j.routes || [])[0]; if (!rt) throw new Error('找不到路線');
        var steps = [];
        (rt.legs || []).forEach(function (lg) { (lg.steps || []).forEach(function (s) { steps.push({ text: stepText(s), dist: Math.round(s.distance || 0), dur: Math.round(s.duration || 0) }); }); });
        // 合併連續的「繼續沿同一條路」
        var merged = []; steps.forEach(function (s) { var p = merged[merged.length - 1]; if (p && p.text === s.text && /^繼續/.test(s.text)) { p.dist += s.dist; p.dur += s.dur; } else merged.push(s); });
        return { ok: true, mode: mode, dist: Math.round(rt.distance), dur: Math.round(rt.duration), line: (rt.geometry && rt.geometry.coordinates || []).map(function (c) { return [c[1], c[0]]; }), steps: merged, src: list[i].split('/')[2] };
      } catch (e) { errs.push(list[i].split('/')[2] + '：' + e.message); }
    }
    throw new Error('路線規劃失敗（' + errs.join('；') + '）');
  }
  var maasCalls = [];
  async function transitRoute(o, d) {
    if (!API.hasTdx()) throw new Error('大眾運輸路線需要 TDX 金鑰（設定 → 專家與 Bot → 交通 API）');
    var now = Date.now(); maasCalls = maasCalls.filter(function (t) { return now - t < 60000; });
    if (maasCalls.length >= 5) throw new Error('TDX 路徑規劃每分鐘最多 5 次，請稍後再試');
    maasCalls.push(now);
    var tw = new Date(now + 8 * 3600000), p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    var depart = tw.getUTCFullYear() + '-' + p2(tw.getUTCMonth() + 1) + '-' + p2(tw.getUTCDate()) + 'T' + p2(tw.getUTCHours()) + ':' + p2(tw.getUTCMinutes()) + ':00';
    var j = await NT()._tdxGet('https://tdx.transportdata.tw/api/maas/routing', { origin: o.lat.toFixed(6) + ',' + o.lon.toFixed(6), destination: d.lat.toFixed(6) + ',' + d.lon.toFixed(6),
      gc: 1, top: 3, transit: '3,4,5,6,7', depart: depart, first_mile_mode: 0, last_mile_mode: 0 }, 300);
    var routes = ((j && j.data && j.data.routes) || (j && j.routes) || []);
    if (!routes.length) throw new Error('TDX 沒有找到大眾運輸路線');
    var plans = routes.slice(0, 3).map(function (rt) {
      var secs = Array.isArray(rt.sections) ? rt.sections : rt.sections ? [rt.sections] : [];
      var steps = [], line = [], total = 0;
      secs.forEach(function (s) {
        var ts = s.travelSummary || {}, dur = +ts.duration || 0, dd = +ts.length || 0; total += dur;
        var from = s.departure && s.departure.place && s.departure.place.name || '', to = s.arrival && s.arrival.place && s.arrival.place.name || '';
        if (s.type === 'pedestrian') steps.push({ text: '步行' + (to ? '到' + to : ''), dist: dd, dur: dur, kind: 'walk' });
        else if (s.type === 'waiting') steps.push({ text: '候車', dur: dur, kind: 'wait' });
        else if (s.type === 'transit') { var tr = s.transport || {}; var fz = [from ? from + ' 上車' : '', to ? to + ' 下車' : ''].filter(Boolean).join('，'); steps.push({ text: '搭 ' + (tr.shortName || tr.name || tr.mode || '大眾運輸') + (fz ? '（' + fz + '）' : ''), dist: dd, dur: dur, kind: 'ride' }); }
        [s.departure, s.arrival].forEach(function (x) { var l = x && x.place && x.place.location; if (l && isFinite(l.lat)) line.push([l.lat, l.lng != null ? l.lng : l.lon]); });
      });
      if (rt.travelSummary && +rt.travelSummary.duration) total = +rt.travelSummary.duration;
      return { dur: total, steps: steps, line: line };
    });
    return { ok: true, mode: 'transit', dur: plans[0].dur, dist: Math.round(dist(o.lat, o.lon, d.lat, d.lon)), line: plans[0].line.length ? [[o.lat, o.lon]].concat(plans[0].line, [[d.lat, d.lon]]) : [[o.lat, o.lon], [d.lat, d.lon]], steps: plans[0].steps, plans: plans, src: 'TDX MaaS' };
  }
  /** 規劃路線：o、d = {lat,lon,name}；mode：driving／walking／cycling／transit */
  API.route = async function (o, d, mode) {
    mode = ROUTERS[mode] || mode === 'transit' ? mode : 'driving';
    var k = mode + ':' + o.lat.toFixed(4) + ',' + o.lon.toFixed(4) + '>' + d.lat.toFixed(4) + ',' + d.lon.toFixed(4);
    if (routeCache[k] && Date.now() - routeCache[k].at < 120000) return routeCache[k].v;
    var v = mode === 'transit' ? await transitRoute(o, d) : await osrmRoute(o, d, mode);
    v.from = o; v.to = d; v.gmaps = gmapsNav(d.lat, d.lon, mode, o.lat, o.lon);
    routeCache[k] = { at: Date.now(), v: v };
    return v;
  };

  // ───────────────────────── 給 AI 的工具 ─────────────────────────
  var CAT_ALIAS = { all: 'all', '全部': 'all', fuel: 'fuel', gas: 'fuel', '加油站': 'fuel', '加油': 'fuel', '充電站': 'fuel', parking: 'parking', '停車': 'parking', '停車場': 'parking', '停車位': 'parking',
    medical: 'medical', hospital: 'medical', '醫院': 'medical', '醫療': 'medical', '診所': 'medical', '藥局': 'medical', food: 'food', restaurant: 'food', '餐廳': 'food', '餐飲': 'food', '美食': 'food', '吃': 'food', '咖啡': 'food',
    fun: 'fun', leisure: 'fun', '休閒': 'fun', '遊樂': 'fun', '娛樂': 'fun', '景點': 'fun', '公園': 'fun', shop: 'shop', shopping: 'shop', '購物': 'shop', '賣場': 'shop', '超市': 'shop', '便利商店': 'shop',
    transit: 'transit', '大眾運輸': 'transit', '捷運': 'transit', '公車': 'transit', '車站': 'transit', youbike: 'transit', weather: 'weather', '天氣': 'weather' };
  function itemForAi(it) {
    var o = { name: it.name, type: it.sub, distance: fmtDist(it.d) };
    if (it.cat === 'fun') o.indoor = it.indoor ? '室內' : '室外';
    if (it.addr) o.address = it.addr;
    if (it.hours) o.opening_hours = it.hours;
    if (it.phone) o.phone = it.phone;
    if (it.brand) o.brand = it.brand;
    if (it.cuisine) o.cuisine = it.cuisine;
    if (it.cat === 'parking') {
      if (it.avail != null) o.available_spaces = it.avail; if (it.total != null) o.total_spaces = it.total;
      if (it.car != null) o.car_available = it.car; if (it.moto != null) o.motorcycle_available = it.moto;
      if (it.full) o.full = true; if (it.closed) o.closed = true; if (it.fare) o.fare = String(it.fare).slice(0, 120); if (it.fee) o.fee = it.fee;
    }
    if (it.rent != null) o.bikes_to_rent = it.rent; if (it.ret != null) o.docks_to_return = it.ret;
    o.navigate = gmapsNav(it.lat, it.lon, it.cat === 'transit' || it.d < 800 ? 'walking' : 'driving');
    return o;
  }
  function wxForAi(w) { if (!w) return null; return { now: w.text + ' ' + Math.round(w.temp) + '°C（體感 ' + Math.round(w.feels) + '°C）', humidity: w.humidity + '%', wind: w.wind + ' km/h', uv: w.uv, today: Math.round(w.tmin) + '~' + Math.round(w.tmax) + '°C，降雨機率 ' + (w.pop == null ? '—' : w.pop + '%'), next_hours: (w.hours || []).map(function (h) { return h.t + ' ' + h.text + ' ' + Math.round(h.temp) + '° 降雨' + (h.pop == null ? '—' : h.pop + '%'); }).join('；') }; }
  function locForAi(res) {
    var p = res.pos, a = res.addr || {};
    return { address: a.text || '', city: a.city || '', district: a.district || '', lat: +p.lat.toFixed(5), lon: +p.lon.toFixed(5), accuracy_m: p.acc || undefined,
      source: p.src === 'gps' ? '手機定位（剛取得）' : p.src === 'app' ? 'App 稍早的定位' : '上次成功的定位', note: p.warn || undefined };
  }
  async function scanFor(a, needItems) {
    var r = Math.max(300, Math.min(+a.radius_m || 2000, 5000));
    var ls = lastScan;
    if (ls && Date.now() - ls.at < 120000 && ls.radius >= r && (!needItems || ls.items.length || ls.osmErr == null)) return ls;
    if (!needItems) {   // 只要位置＋天氣：不跑 Overpass
      var pos = await API.locate({});
      var res = { pos: pos, radius: r, addr: null, wx: null, items: [], notes: pos.warn ? [pos.warn] : [], at: Date.now() };
      await Promise.all([API.reverse(pos.lat, pos.lon).then(function (x) { res.addr = x; }, function (e) { res.notes.push('地址查詢失敗：' + e.message); }),
        API.weather(pos.lat, pos.lon).then(function (w) { res.wx = w; }, function (e) { res.notes.push('天氣查詢失敗：' + e.message); })]);
      return res;
    }
    return await API.scan({ radius: r });
  }
  API.run = async function (tool, args) {
    var a = Object.assign({}, args || {});
    try {
      if (tool === 'travel_where_am_i') {
        var r0 = await scanFor(a, false);
        return { ok: true, location: locForAi(r0), weather: wxForAi(r0.wx), notes: r0.notes.length ? r0.notes : undefined };
      }
      if (tool === 'travel_nearby') {
        var cat = CAT_ALIAS[String(a.category || 'all').toLowerCase()] || CAT_ALIAS[String(a.category || '')] || 'all';
        var r1 = await scanFor(a, cat !== 'weather');
        var lim = Math.max(1, Math.min(+a.limit || (cat === 'all' ? 4 : 10), 25)), kw = String(a.keyword || '').trim().toLowerCase();
        var out = { ok: true, location: locForAi(r1), radius: fmtDist(r1.radius), weather: wxForAi(r1.wx) };
        if (cat !== 'weather') {
          var pool = r1.items.filter(function (it) {
            if (kw && (it.name + ' ' + it.sub + ' ' + (it.brand || '') + ' ' + (it.cuisine || '')).toLowerCase().indexOf(kw) < 0) return false;
            if (a.indoor === true && it.cat === 'fun' && !it.indoor) return false;
            if (a.indoor === false && it.cat === 'fun' && it.indoor) return false;
            return true;
          });
          out.results = {};
          CATS.forEach(function (c) {
            if (cat !== 'all' && c.id !== cat) return;
            var xs = pool.filter(function (it) { return it.cat === c.id; });
            if (c.id === 'parking') xs.sort(function (p, q) { return (q.avail != null) - (p.avail != null) || p.d - q.d; });
            out.results[c.zh] = { count_in_radius: xs.length, nearest: xs.slice(0, lim).map(itemForAi) };
          });
          if (r1.parkNote && (cat === 'all' || cat === 'parking')) out.parking_note = r1.parkNote;
          if (r1.osmErr) out.error = r1.osmErr;
        }
        if (r1.notes.length) out.notes = r1.notes;
        out.tip = '使用者可從「＋選單 → TravelAgent」看地圖與完整清單。';
        return out;
      }
      if (tool === 'travel_route') {
        var mode = { car: 'driving', drive: 'driving', driving: 'driving', '開車': 'driving', walk: 'walking', walking: 'walking', '走路': 'walking', '步行': 'walking',
          bike: 'cycling', bicycle: 'cycling', cycling: 'cycling', '騎車': 'cycling', '自行車': 'cycling', transit: 'transit', '大眾運輸': 'transit', bus: 'transit', mrt: 'transit' }[String(a.mode || 'driving').toLowerCase()] || 'driving';
        var dest = String(a.destination || '').trim(); if (!dest) return { ok: false, error: '缺少 destination（目的地）' };
        var here = await API.locate({});
        var cands = await API.search(dest, here); if (!cands.length) return { ok: false, error: '找不到「' + dest + '」' };
        var to = cands[0], rt = await API.route({ lat: here.lat, lon: here.lon, name: '目前位置' }, { lat: to.lat, lon: to.lon, name: to.name }, mode);
        if (a.show_map && root.NovaTravel && root.NovaTravel.showRoute) { try { root.NovaTravel.showRoute(to, mode); } catch (e) { /* */ } }
        return { ok: true, from: '目前位置' + (here.warn ? '（' + here.warn + '）' : ''), to: { name: to.name, address: to.addr || '' }, mode: { driving: '開車', walking: '步行', cycling: '自行車', transit: '大眾運輸' }[mode],
          distance: fmtDist(rt.dist), duration: fmtDur(rt.dur), steps: rt.steps.slice(0, 14).map(function (s) { return s.text + (s.dist ? '（' + fmtDist(s.dist) + '）' : ''); }),
          other_plans: rt.plans && rt.plans.length > 1 ? rt.plans.slice(1).map(function (p) { return fmtDur(p.dur) + '：' + p.steps.filter(function (s) { return s.kind === 'ride'; }).map(function (s) { return s.text; }).join(' → '); }) : undefined,
          google_maps_navigation: rt.gmaps, other_candidates: cands.slice(1, 4).map(function (c) { return c.name + (c.addr ? '（' + c.addr + '）' : ''); }), source: rt.src };
      }
      return { ok: false, error: '未知的 TravelAgent 工具：' + tool };
    } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
  };
  API.TOOL_NAMES = ['travel_where_am_i', 'travel_nearby', 'travel_route'];
  API.format = function (r, max) { var s; try { s = JSON.stringify(r); } catch (e) { s = String(r); } max = max || 7000; return s.length > max ? s.slice(0, max) + '…（過長已截斷，請指定 category 或縮小 limit）' : s; };
  API.declarations = function () {
    var S = function (d) { return { type: 'string', description: d }; };
    return [
      { name: 'travel_where_am_i', label: 'TravelAgent 我的位置', description: 'TravelAgent：取得使用者「現在所在的位置」（手機定位→地址、縣市、行政區、經緯度）與當地即時天氣。使用者問「我在哪／我現在的位置／這裡是哪裡／這附近天氣」時一定先呼叫。',
        parameters: { type: 'object', properties: {} } },
      { name: 'travel_nearby', label: 'TravelAgent 附近設施', description: 'TravelAgent：查使用者目前位置附近（預設 2 公里內）的設施，依距離排序：加油站（含充電站）、停車場（有 TDX 時含即時剩餘車位）、醫療（醫院、診所、牙醫、藥局）、餐飲美食、休閒娛樂（分室內／室外）、購物賣場、大眾運輸（車站、公車站、YouBike 可借可還）＋天氣。使用者問「這附近有什麼／附近有沒有○○／離我最近的○○／附近哪裡可以停車」時一定先呼叫，不要用網路搜尋代替。',
        parameters: { type: 'object', properties: {
          category: S('all（預設，全部各取幾個）、fuel、parking、medical、food、fun、shop、transit、weather'),
          keyword: S('名稱／品牌／料理關鍵字過濾（例如 全家、拉麵、中油、牙醫），可省略'),
          indoor: { type: 'boolean', description: '只看室內（true）或室外（false）的休閒地點；省略＝都要' },
          radius_m: { type: 'number', description: '半徑公尺，預設 2000，最大 5000' },
          limit: { type: 'number', description: '每類最多幾筆（預設：全部模式 4、單一類別 10）' } } } },
      { name: 'travel_route', label: 'TravelAgent 路線規劃', description: 'TravelAgent：從使用者目前位置規劃到目的地的路線（距離、時間、逐步指示）並附 Google 地圖導航連結。使用者說「帶我去／怎麼去／導航到／開車到○○要多久」時呼叫。目的地可以是地名、店名、地址或「緯度,經度」。',
        parameters: { type: 'object', properties: {
          destination: S('目的地（地名、店名、地址或 緯度,經度）'),
          mode: S('driving（預設）、walking、cycling、transit（大眾運輸，需 TDX 金鑰）'),
          show_map: { type: 'boolean', description: '使用者明確要「導航／帶我去／在地圖上看」時設 true，會打開 TravelAgent 地圖顯示這條路線' } }, required: ['destination'] } }
    ].map(function (d) { d.readOnly = true; return d; });
  };
  /** 這句話跟「使用者所在位置／周邊／路線」有關嗎（決定要不要帶 TravelAgent 工具） */
  var RX = /附近|周邊|週邊|周遭|這一?帶|這裡有|這邊有|離我最?近|最近的(加油|停車|醫院|診所|藥局|餐廳|超商|便利|超市|捷運|車站|公車|公園|咖啡|廁所)|我(現在)?在哪|我的位置|我目前的?位置|我所在|所在(地|位置)|這裡是哪|導航|帶我去|怎麼去|怎麼走|開車到|走路到|騎車到|多遠|多久會到|路線規劃|停車位|哪裡(可以)?停車|找停車/;
  API.looksLikeTravel = function (text) { return RX.test(String(text || '')); };
  /** 比較嚴格：用來在不支援工具呼叫的模型前先抓資料帶進提示 */
  var RX_NEAR = /附近|周邊|週邊|周遭|這一?帶|這裡有|這邊有|離我最?近|我(現在)?在哪|我的位置|我目前的?位置|我所在|所在(地|位置)|這裡是哪|哪裡(可以)?停車|找停車/;
  API.looksNearby = function (text) { return RX_NEAR.test(String(text || '')); };
  /** 給不支援工具呼叫的模型：先查好資料，回傳要放進提示的文字 */
  API.contextFor = async function (text) {
    var t = String(text || ''), cat = 'all';
    [['fuel', /加油|充電/], ['parking', /停車/], ['medical', /醫院|診所|藥局|牙醫|看病|急診/], ['food', /吃|餐|美食|咖啡|小吃|飲料|早餐|午餐|晚餐|宵夜/], ['fun', /玩|休閒|娛樂|景點|公園|電影|遊樂/],
      ['shop', /買|購物|賣場|超市|超商|便利商店|百貨|商場|量販/], ['transit', /捷運|公車|車站|youbike|交通|搭車/i], ['weather', /天氣|下雨|溫度|氣溫/]].some(function (x) { if (x[1].test(t)) { cat = x[0]; return true; } return false; });
    var where = /我(現在)?在哪|我的位置|我目前的?位置|我所在|所在(地|位置)|這裡是哪/.test(t) && cat === 'all';
    var r = where ? await API.run('travel_where_am_i', {}) : await API.run('travel_nearby', { category: cat, limit: cat === 'all' ? 3 : 8 });
    return '【TravelAgent 即時資料（App 剛用手機定位查到的，請據此回答；距離是直線距離）】\n' + API.format(r, 6000);
  };

  root.NovaTravelCore = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);

/* ═══════════════════════════════════════════════════════════════════
   nova-travel.js — NOVA Android「TravelAgent」介面（全螢幕頁，入口在＋選單，和 Project Insight 一樣）
   版本：v1.1.2（2026-11-15，App v2.6.144）
   資料全部來自 nova-travel-core.js（NovaTravelCore）；地圖用 Leaflet 1.9.4（www/vendor/leaflet/，打開時才載入），底圖 CARTO（白晝 Voyager／黑夜 Dark Matter，
   連續載入失敗改用 OpenStreetMap 標準圖）。

   版本紀錄（只記這個檔案自己的變更）：
   v1.1.2 - App v2.6.144：醫療、購物、運輸、休閒點進去後多一列子分類（醫療：醫院／診所／中醫／牙醫／藥局；購物：便利商店／購物中心／超市／其他；
            運輸：捷運／公車／YouBike／其他；休閒：室內／室外），各附數量、沒有的不列；選子分類後地圖與清單只顯示該類。原本休閒的室內／室外
            篩選併入同一機制（S.sub）。選擇畫面的 Google 用量說明改為每次 15 次附近搜尋。
   v1.1.1 - App v2.6.143（使用者要求「任我決定每次開啟要不要用 Maps JavaScript API」）：
     ① 有 Google 金鑰且設定是「每次詢問」（預設）時，打開先問「這次要用哪種地圖？」：Google 地圖／OpenStreetMap（免費），可勾「記住我的選擇」；
        附本月 Google 用量與免費額度。選好才載入地圖、開始查詢。頁面最下方「打開時」可改 每次詢問／一律 Google／一律 OpenStreetMap，
        「這次改用…」鈕只切換這次；「本月 Google 用量」列出各項用量。建立 Google 地圖時計 1 次地圖載入。
     ② 2 分鐘自動更新改成只更新停車與 YouBike（scan keepPoi，沿用上次的周邊設施），不再重查 Google；沒有 TDX 金鑰也會更新（新北市停車不需要金鑰）。
   v1.1.0 - App v2.6.142：
     ① Google 模式（搭配 nova-travel-core.js v1.1.0）：有 Google Maps 金鑰時地圖改用 Google Maps JavaScript API（Google 的地點與路線依條款只能畫在 Google 地圖上）。
        地圖拆成同一組介面的兩種實作（GoogleMap／LeafletMap），switchMap() 依 NovaTravelCore.provider() 建立；Google 載入失敗、逾時或 gm_authFailure
        （金鑰沒啟用 Maps JavaScript API、應用程式限制不符）時標記 googleBroken 並整頁改回 OpenStreetMap 模式。🗺 鈕在 Google 模式切換 一般地圖／衛星圖。
        清單卡片多「⭐評分」「營業中／休息中」、選取後多「詳情」（開 Google 地圖頁）；路線多「🛵 機車」（只有 Google 模式）；頁尾可切換 Google／OpenStreetMap。
     ② 黑夜模式下地圖也用白晝樣式（使用者要求）：彈出框文字固定深色（原本跟著黑夜主題變淺色、白底上看不清）；拿掉 Leaflet 底圖反色濾鏡，國土測繪一律用彩色 EMAP，地圖區底色改淺灰。
   v1.0.3 - App v2.6.141：周邊設施暫用 Nominatim 備援資料時，清單上方加一行說明（完整資料到了會自動更新）。其他沒改。
   v1.0.2 - App v2.6.140：頁尾資料來源多列「新北市政府開放資料（停車）」（停車場改用市府資料時）。其他沒改。
   v1.0.1 - App v2.6.139：底圖修正。CARTO 現在要 API 金鑰（真機看到滿版「API KEY REQUIRED」，而且那是正常載入的圖磚、不會觸發錯誤，原本的自動退回沒作用）。
            改成台灣境內預設國土測繪中心「臺灣通用電子地圖」（中文、免金鑰；白晝彩色 EMAP、黑夜灰階 EMAP01 反色），境外預設 OpenStreetMap；
            地圖右側新增「🗺」鈕在 國土測繪／OpenStreetMap／Esri 間切換（記在 nova_travel_tiles）；沒手動選過時，連續 10 張圖磚載入失敗會自動換下一個。
            黑夜模式的底圖用 CSS 濾鏡反色，不再依賴各家的深色圖層。
   v1.0.0 - 首版。
     ・打開就重新定位（不吃快取），依序顯示：地址 → 天氣（現在＋接下來 6 小時）→ 2 公里內 7 類設施（加油站、停車、醫療、餐飲、休閒〔室內／室外〕、購物、運輸）。
       地圖畫出所在位置、定位誤差圈、2 公里範圍圈與各類設施（顏色分類）；下方清單依距離排序，點清單項目地圖會飛過去並顯示資訊。
     ・停車場有 TDX 時顯示剩餘車位（汽車／機車分開、綠／黃／紅標示），頁面開著每 2 分鐘自動更新剩餘車位與 YouBike。
     ・上方「想去哪裡？」搜尋目的地（先找周邊清單，再查 Photon／Nominatim），選定後立即規劃路線：開車／步行／自行車／大眾運輸可切換，
       地圖畫出路線、顯示距離、時間與逐步指示；「開始導航」交給 Google 地圖（語音導航）。清單每一項也有「路線」「導航」兩個鈕。
     ・Android 返回鍵：先關路線／搜尋，再關整頁。白晝／黑夜沿用 App 的 --nv-* 色票。
     ・AI 工具 travel_route 帶 show_map:true 時會呼叫 NovaTravel.showRoute(目的地, 模式) 直接打開這頁顯示路線。
   ═══════════════════════════════════════════════════════════════════ */
(function (W) {
  'use strict';
  var D = W.document, C = null, L = null, H = {};
  var S = { open: false, res: null, scanning: false, cat: 'all', fun: 'all', sub: {}, sel: null, route: null, routeTo: null, mode: 'driving', search: null, err: '', refreshT: null, layers: [] };
  function $(id) { return D.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(m, ms) { try { (H.toast || W.showToast)(m, ms || 3000); } catch (e) { /* */ } }
  function light() { return D.documentElement.classList.contains('theme-light'); }

  /* ───────── 返回鍵堆疊（和 Insight 同一個做法：history + popstate） ───────── */
  function pushLayer(fn) { S.layers.push(fn); try { history.pushState({ ntv: S.layers.length }, ''); } catch (e) { /* */ } }
  function closeTop() { if (S.layers.length) { try { history.back(); } catch (e) { var f = S.layers.pop(); f && f(); } } }
  W.addEventListener('popstate', function () { if (S.layers.length) { var f = S.layers.pop(); try { f(); } catch (e) { /* */ } } });

  /* ───────── 樣式與骨架 ───────── */
  var CSS = [
    '#ntv-win{--b:var(--nv-canvas,#020617);--c:var(--nv-card,#0f172a);--c2:var(--nv-card-2,#162036);--bd:var(--nv-line-strong,#26324d);--t:var(--nv-text,#e2e8f0);--t2:var(--nv-muted,#94a3b8);--ac:var(--nv-accent,#5b8def);--on:var(--nv-on-accent,#0b1220);',
    'position:fixed;inset:0;height:100dvh;z-index:99000;background:var(--b);color:var(--t);display:none;flex-direction:column;font-size:14px;padding-top:env(safe-area-inset-top,0px)}',
    '#ntv-win.on{display:flex}#ntv-win *{box-sizing:border-box}',
    '#ntv-win .top{display:flex;align-items:center;gap:4px;padding:4px 6px;border-bottom:1px solid var(--bd)}',
    '#ntv-win .ttl{flex:1;min-width:0}#ntv-win .ttl b{display:block;font-size:15px}#ntv-win .ttl .sub{display:block;font-size:12px;color:var(--t2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#ntv-win .ib{min-width:44px;min-height:44px;border:0;background:transparent;color:var(--t);font-size:20px;border-radius:12px;display:flex;align-items:center;justify-content:center}',
    '#ntv-win .ib:active{background:var(--c2)}#ntv-win .spin{animation:ntvSpin 1s linear infinite}@keyframes ntvSpin{to{transform:rotate(360deg)}}',
    '#ntv-map{position:relative;height:38dvh;min-height:180px;flex:none;background:#e5e7eb;z-index:0;overflow:hidden}#ntv-mapc{position:absolute;inset:0}#ntv-win.rt #ntv-map{height:46dvh}',
    '#ntv-map .leaflet-container{background:#e5e7eb;font:inherit}',   // v1.1.0：地圖一律白晝樣式
    '#ntv-map .fab{position:absolute;right:10px;z-index:500;width:44px;height:44px;border-radius:50%;border:1px solid rgba(0,0,0,.15);background:#fff;color:#1d4ed8;font-size:20px;box-shadow:0 2px 8px rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center}',
    '#ntv-map .fab.me{bottom:12px}#ntv-map .fab.fit{bottom:62px;font-size:17px}#ntv-map .fab.lay{bottom:112px;font-size:18px}',
    // v1.1.0：拿掉黑夜模式的地圖反色（使用者要求黑夜模式也顯示白晝版地圖）
    'html body #ntv-win #ntv-map .fab{background:#ffffff!important;color:#1d4ed8!important;border:1px solid rgba(0,0,0,.15)!important;box-shadow:0 2px 8px rgba(0,0,0,.3)!important;opacity:1!important}',   // 白晝模式全域按鈕規則會把底色清掉
    '#ntv-map .mapmsg{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:400;color:#64748b;font-size:13px;text-align:center;padding:0 20px}',
    '#ntv-wx{display:flex;align-items:center;gap:10px;padding:6px 10px;border-bottom:1px solid var(--bd);overflow-x:auto;scrollbar-width:none;white-space:nowrap;min-height:46px}#ntv-wx::-webkit-scrollbar{display:none}',
    '#ntv-wx .now{display:flex;align-items:center;gap:6px;flex:none}#ntv-wx .now .ic{font-size:24px}#ntv-wx .now b{font-size:18px}',
    '#ntv-wx .meta{font-size:11.5px;color:var(--t2);line-height:1.35;flex:none}#ntv-wx .hr{flex:none;text-align:center;font-size:11px;color:var(--t2);padding:0 2px}#ntv-wx .hr b{display:block;color:var(--t);font-size:12px}',
    '#ntv-sr{display:flex;gap:6px;padding:8px 10px 4px}#ntv-sr input{flex:1;min-width:0;height:42px;border-radius:21px;border:1px solid var(--bd);background:var(--c);color:var(--t);padding:0 16px;font-size:15px;outline:none}',
    '#ntv-sr input:focus{border-color:var(--ac)}#ntv-sr button{height:42px;min-width:56px;border-radius:21px;border:0;background:var(--ac);color:var(--on);font-weight:700;font-size:14px;padding:0 14px}',
    '#ntv-chips{display:flex;gap:6px;padding:6px 10px;overflow-x:auto;scrollbar-width:none;flex:none}#ntv-chips::-webkit-scrollbar{display:none}',
    '#ntv-win .chip{flex:none;min-height:36px;padding:0 12px;border-radius:18px;border:1px solid var(--bd);background:var(--c);color:var(--t);font-size:13px;white-space:nowrap;display:inline-flex;align-items:center;gap:4px}',
    '#ntv-win .chip.on{background:var(--ac);color:var(--on);border-color:var(--ac);font-weight:700}#ntv-win .chip .n{font-size:11px;opacity:.75}',
    '#ntv-win .chip.sm{min-height:32px;font-size:12px}',
    '#ntv-body{flex:1;overflow-y:auto;overscroll-behavior:contain;padding:2px 10px calc(16px + env(safe-area-inset-bottom,0px));-webkit-overflow-scrolling:touch}',
    '#ntv-win .card{background:var(--c);border:1px solid var(--bd);border-radius:14px;padding:10px 12px;margin:6px 0}#ntv-win .card.sel{border-color:var(--ac);box-shadow:0 0 0 1px var(--ac) inset}',
    '#ntv-win .row{display:flex;align-items:center;gap:8px}#ntv-win .grow{flex:1;min-width:0}#ntv-win .mut{color:var(--t2)}#ntv-win .sm{font-size:12px}',
    '#ntv-win .nm{font-weight:700;font-size:14.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#ntv-win .dot{width:10px;height:10px;border-radius:50%;flex:none;display:inline-block}',
    '#ntv-win .dist{font-weight:700;font-size:13px;flex:none}',
    '#ntv-win .bdg{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;font-weight:700;margin:4px 4px 0 0}',
    '#ntv-win .bdg.g{background:rgba(34,197,94,.18);color:#4ade80}#ntv-win .bdg.y{background:rgba(234,179,8,.2);color:#facc15}#ntv-win .bdg.r{background:rgba(239,68,68,.2);color:#f87171}#ntv-win .bdg.n{background:var(--c2);color:var(--t2)}',
    'html.theme-light #ntv-win .bdg.g{color:#15803d}html.theme-light #ntv-win .bdg.y{color:#a16207}html.theme-light #ntv-win .bdg.r{color:#b91c1c}',
    '#ntv-win .acts{display:flex;gap:6px;margin-top:8px}#ntv-win .btn{min-height:36px;padding:0 14px;border-radius:18px;border:1px solid var(--bd);background:var(--c2);color:var(--t);font-size:13px;font-weight:600}',
    '#ntv-win .btn.pri{background:var(--ac);border-color:var(--ac);color:var(--on)}#ntv-win .btn.big{min-height:46px;width:100%;font-size:15px;border-radius:23px}',
    '#ntv-win .modes{display:flex;gap:4px;padding:3px;border-radius:22px;background:var(--c2);margin:8px 0}#ntv-win .modes button{flex:1;min-width:0;min-height:38px;padding:0 2px;font-size:12.5px!important;white-space:nowrap;border:0;border-radius:19px;background:transparent;color:var(--t);font-size:13px}',
    '#ntv-win .modes button.on{background:var(--ac);color:var(--on);font-weight:700}',
    '#ntv-win .step{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--bd)}#ntv-win .step:last-child{border-bottom:0}#ntv-win .step .no{flex:none;width:22px;height:22px;border-radius:50%;background:var(--c2);font-size:11px;display:flex;align-items:center;justify-content:center;color:var(--t2)}',
    '#ntv-win .sum{font-size:22px;font-weight:800}#ntv-win .note{font-size:12px;color:var(--t2);margin:6px 2px}',
    '#ntv-win .empty{padding:24px 10px;text-align:center;color:var(--t2)}',
    '.ntv-pop{font-size:13px;line-height:1.4;min-width:150px;color:#1e293b}.ntv-pop b{color:#0f172a}.ntv-pop b{font-size:14px}.ntv-pop .a{display:flex;gap:6px;margin-top:6px}.ntv-pop button{min-height:32px;padding:0 10px;border-radius:16px;border:1px solid #cbd5e1;background:#fff;color:#1e293b;font-size:12px;font-weight:600}',
    '.ntv-pop button.p{background:#2f63d6;border-color:#2f63d6;color:#fff}',
    '.ntv-me{width:18px;height:18px;border-radius:50%;background:#2563eb;border:3px solid #fff;box-shadow:0 0 0 2px rgba(37,99,235,.35),0 1px 4px rgba(0,0,0,.4)}',
    '.ntv-dst{font-size:26px;line-height:26px;text-align:center;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))}'
  ].join('');

  function ensureDom() {
    if ($('ntv-win')) return;
    var st = D.createElement('style'); st.id = 'ntv-css'; st.textContent = CSS; D.head.appendChild(st);
    var w = D.createElement('div'); w.id = 'ntv-win';
    w.innerHTML =
      '<div class="top"><button class="ib" data-act="close" aria-label="返回"><i class="ph ph-arrow-left"></i></button>' +
      '<div class="ttl"><b>TravelAgent</b><span class="sub" id="ntv-loc">定位中…</span></div>' +
      '<button class="ib" data-act="refresh" aria-label="重新定位"><i class="ph ph-arrows-clockwise" id="ntv-rf"></i></button></div>' +
      '<div id="ntv-map" class="nv-keep"><div class="mapmsg" id="ntv-mapmsg">地圖載入中…</div>' +
      '<button class="fab lay" data-act="tiles" aria-label="切換底圖">🗺</button><button class="fab fit" data-act="fit" aria-label="顯示全部">⤢</button><button class="fab me" data-act="me" aria-label="回到我的位置"><i class="ph-bold ph-crosshair"></i></button></div>' +
      '<div id="ntv-wx"><span class="mut sm">天氣載入中…</span></div>' +
      '<form id="ntv-sr" autocomplete="off"><input id="ntv-q" type="search" placeholder="想去哪裡？輸入地名、店名或地址" enterkeyhint="search"><button type="submit">搜尋</button></form>' +
      '<div id="ntv-chips"></div><div id="ntv-body"></div>';
    D.body.appendChild(w);
    w.addEventListener('click', onClick);
    w.addEventListener('change', function (e) { if (e.target && e.target.id === 'ntv-pref') { C.providerPref(e.target.value); toast(e.target.value === 'ask' ? '之後每次打開都會詢問' : e.target.value === 'google' ? '之後一律使用 Google 地圖' : '之後一律使用 OpenStreetMap', 2200); } });
    $('ntv-sr').addEventListener('submit', function (e) { e.preventDefault(); doSearch($('ntv-q').value); try { $('ntv-q').blur(); } catch (e2) { /* */ } });
  }

  /* ───────── 地圖（v1.1.0：Google Maps JavaScript API／Leaflet 兩種實作，同一組介面） ─────────
     介面：setView(lat,lon,z)、getZoom()、fitPoints(pts)、fitCircle(lat,lon,r)、drawMe(pos,r)、drawPois(list,styleFn,onClick)、popup(it,el)、closePopup()、
           drawRoute(line,mode,to)、clearRoute()、resize()、layer()（切換底圖／圖層，回傳名稱）、destroy()。
     v1.1.0 起地圖一律用白晝樣式（使用者要求：黑夜模式下地圖也顯示白晝版），不再反色。 */
  var MP = null, mapKind = '';
  function mapBox() { var c = $('ntv-mapc'); if (!c) { c = D.createElement('div'); c.id = 'ntv-mapc'; $('ntv-map').insertBefore(c, $('ntv-map').firstChild); } return c; }
  function popEl(it) { var d = D.createElement('div'); d.innerHTML = popHtml(it); d = d.firstChild; d.addEventListener('click', onClick); return d; }   // 彈出框會擋點擊冒泡，按鈕自己綁

  // ── Leaflet（OpenStreetMap 模式） ──
  function loadLeaflet() {
    if (W.L && W.L.map) return Promise.resolve(W.L);
    if (loadLeaflet.p) return loadLeaflet.p;
    loadLeaflet.p = new Promise(function (res, rej) {
      if (!$('ntv-lcss')) { var l = D.createElement('link'); l.id = 'ntv-lcss'; l.rel = 'stylesheet'; l.href = './vendor/leaflet/leaflet.css'; D.head.appendChild(l); }
      var s = D.createElement('script'); s.src = './vendor/leaflet/leaflet.js'; s.onload = function () { W.L ? res(W.L) : rej(new Error('Leaflet 載入失敗')); };
      s.onerror = function () { loadLeaflet.p = null; rej(new Error('Leaflet 載入失敗')); }; D.head.appendChild(s);
    });
    return loadLeaflet.p;
  }
  // 底圖：台灣境內預設國土測繪中心「臺灣通用電子地圖」（中文、免金鑰），境外 OpenStreetMap；🗺 鈕在 國土測繪／OSM／Esri 間切換（nova_travel_tiles）。
  var TILES = {
    nlsc: { zh: '國土測繪中心電子地圖', url: 'https://wmts.nlsc.gov.tw/wmts/EMAP/default/GoogleMapsCompatible/{z}/{y}/{x}', max: 18, attr: '© 內政部國土測繪中心' },
    osm: { zh: 'OpenStreetMap', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', max: 19, attr: '© OpenStreetMap' },
    esri: { zh: 'Esri 街道圖', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', max: 18, attr: '© Esri' }
  };
  var TILE_ORDER = ['nlsc', 'osm', 'esri'];
  function inTaiwan(p) { return p && p.lat > 21.5 && p.lat < 26.6 && p.lon > 118 && p.lon < 122.3; }
  function tileKey() {
    var k = ''; try { k = localStorage.getItem('nova_travel_tiles') || ''; } catch (e) { /* */ }
    if (TILES[k]) return k;
    return inTaiwan(S.res && S.res.pos) || !S.res ? 'nlsc' : 'osm';
  }
  function LeafletMap() {
    var map = L.map(mapBox(), { zoomControl: false, attributionControl: true, preferCanvas: true, tap: true }).setView([25.04, 121.55], 15);
    map.attributionControl.setPrefix(false);
    var g = { range: L.layerGroup().addTo(map), poi: L.layerGroup().addTo(map), route: L.layerGroup().addTo(map), me: L.layerGroup().addTo(map) }, canvas = L.canvas({ padding: 0.3, tolerance: 8 });
    var tl = null, cur = '', errN = 0;
    function setTiles(key) {
      key = key || tileKey(); cur = key; var t = TILES[key];
      if (tl) { try { map.removeLayer(tl); } catch (e) { /* */ } }
      errN = 0; tl = L.tileLayer(t.url, { maxZoom: 19, maxNativeZoom: t.max, attribution: t.attr });
      tl.on('tileerror', function () { if (++errN === 10 && !localStorage.getItem('nova_travel_tiles')) { var nx = TILE_ORDER[(TILE_ORDER.indexOf(cur) + 1) % TILE_ORDER.length]; toast('底圖載入失敗，改用 ' + TILES[nx].zh); setTiles(nx); } });
      tl.on('tileload', function () { var m = $('ntv-mapmsg'); if (m) m.style.display = 'none'; });
      tl.addTo(map); $('ntv-map').setAttribute('data-tiles', key);
    }
    setTiles();
    setTimeout(function () { map.invalidateSize(); }, 80);
    return {
      kind: 'leaflet',
      setView: function (la, lo, z) { map.setView([la, lo], z || map.getZoom(), { animate: true }); },
      getZoom: function () { return map.getZoom(); },
      fitPoints: function (pts) { map.fitBounds(L.latLngBounds(pts), { padding: [30, 30] }); },
      fitCircle: function (la, lo, r) { map.fitBounds(L.latLng(la, lo).toBounds(r * 2), { padding: [6, 6] }); },
      drawMe: function (p, r) {
        if (cur !== tileKey() && !localStorage.getItem('nova_travel_tiles')) setTiles();
        g.me.clearLayers(); g.range.clearLayers();
        L.circle([p.lat, p.lon], { radius: r, color: '#5b8def', weight: 1.5, dashArray: '6 6', fill: false, interactive: false }).addTo(g.range);
        if (p.acc && p.acc < 1500) L.circle([p.lat, p.lon], { radius: p.acc, color: '#2563eb', weight: 0, fillColor: '#2563eb', fillOpacity: 0.12, interactive: false }).addTo(g.me);
        L.marker([p.lat, p.lon], { icon: L.divIcon({ className: '', html: '<div class="ntv-me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 1000, keyboard: false }).addTo(g.me);
      },
      drawPois: function (list, style, click) {
        g.poi.clearLayers();
        list.forEach(function (it) { var st = style(it); var m = L.circleMarker([it.lat, it.lon], { renderer: canvas, radius: st.r, color: '#ffffff', weight: st.w, fillColor: st.c, fillOpacity: 0.95 }); m.on('click', function () { click(it); }); m.addTo(g.poi); });
      },
      popup: function (it, el) { L.popup({ offset: [0, -4], autoPan: true }).setLatLng([it.lat, it.lon]).setContent(el).openOn(map); },
      closePopup: function () { map.closePopup(); },
      drawRoute: function (line, mode, to) {
        g.route.clearLayers();
        if (line && line.length > 1) {
          L.polyline(line, { color: '#ffffff', weight: 9, opacity: 0.9 }).addTo(g.route);
          L.polyline(line, { color: mode === 'transit' ? '#a855f7' : '#2563eb', weight: 5, opacity: 0.95, dashArray: mode === 'walking' ? '2 8' : null }).addTo(g.route);
        }
        if (to) L.marker([to.lat, to.lon], { icon: L.divIcon({ className: '', html: '<div class="ntv-dst">📍</div>', iconSize: [26, 26], iconAnchor: [13, 24] }) }).addTo(g.route);
      },
      clearRoute: function () { g.route.clearLayers(); },
      resize: function () { setTimeout(function () { map.invalidateSize(); }, 60); },
      layer: function () { var nx = TILE_ORDER[(TILE_ORDER.indexOf(cur) + 1) % TILE_ORDER.length]; try { localStorage.setItem('nova_travel_tiles', nx); } catch (e) { /* */ } setTiles(nx); return TILES[nx].zh; },
      destroy: function () { try { map.remove(); } catch (e) { /* */ } }
    };
  }

  // ── Google Maps JavaScript API（Google 模式；Places／Routes 的內容依 Google 條款必須畫在 Google 地圖上） ──
  function loadGoogle(key) {
    if (W.google && W.google.maps && W.google.maps.Map) return Promise.resolve();
    if (loadGoogle.p) return loadGoogle.p;
    loadGoogle.p = new Promise(function (res, rej) {
      var t = setTimeout(function () { loadGoogle.p = null; rej(new Error('Google 地圖載入逾時')); }, 15000);
      W.__ntvGmReady = function () { clearTimeout(t); res(); };
      var s = D.createElement('script'); s.async = true;
      s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key) + '&v=weekly&language=zh-TW&region=TW&callback=__ntvGmReady';
      s.onerror = function () { clearTimeout(t); loadGoogle.p = null; rej(new Error('無法連線到 Google 地圖')); };
      D.head.appendChild(s);
    });
    return loadGoogle.p;
  }
  // 金鑰不能用在 Maps JavaScript API（沒啟用、網域限制…）時 Google 會呼叫這個全域函式
  W.gm_authFailure = function () {
    if (!C) return;
    C.googleBroken('這把 Google 金鑰不能使用 Maps JavaScript API（請在 Google Cloud 啟用，或檢查金鑰的應用程式限制）');
    toast('Google 地圖無法使用，改用 OpenStreetMap 模式', 5000);
    if (S.open) switchMap().then(function () { scan(false, false); });
  };
  function GoogleMap() {
    var gm = W.google.maps;
    var map = new gm.Map(mapBox(), { center: { lat: 25.04, lng: 121.55 }, zoom: 15, disableDefaultUI: true, clickableIcons: false, gestureHandling: 'greedy', mapTypeId: 'roadmap', colorScheme: 'LIGHT' });
    var me = [], pois = [], rt = [], iw = new gm.InfoWindow({ pixelOffset: new gm.Size(0, -4) });
    function clear(arr) { arr.forEach(function (o) { o.setMap(null); }); arr.length = 0; }
    gm.event.addListenerOnce(map, 'tilesloaded', function () { var m = $('ntv-mapmsg'); if (m) m.style.display = 'none'; });
    $('ntv-map').setAttribute('data-tiles', 'google');
    function ll(la, lo) { return { lat: la, lng: lo }; }
    return {
      kind: 'google',
      setView: function (la, lo, z) { map.panTo(ll(la, lo)); if (z) map.setZoom(z); },
      getZoom: function () { return map.getZoom(); },
      fitPoints: function (pts) { var b = new gm.LatLngBounds(); pts.forEach(function (p) { b.extend(ll(p[0], p[1])); }); map.fitBounds(b, 30); },
      fitCircle: function (la, lo, r) { var c = new gm.Circle({ center: ll(la, lo), radius: r }); map.fitBounds(c.getBounds(), 6); },
      drawMe: function (p, r) {
        clear(me);
        me.push(new gm.Circle({ map: map, center: ll(p.lat, p.lon), radius: r, strokeColor: '#5b8def', strokeOpacity: 0.9, strokeWeight: 1.5, fillOpacity: 0, clickable: false }));
        if (p.acc && p.acc < 1500) me.push(new gm.Circle({ map: map, center: ll(p.lat, p.lon), radius: p.acc, strokeWeight: 0, fillColor: '#2563eb', fillOpacity: 0.12, clickable: false }));
        me.push(new gm.Marker({ map: map, position: ll(p.lat, p.lon), zIndex: 9999, clickable: false, icon: { path: gm.SymbolPath.CIRCLE, scale: 8, fillColor: '#2563eb', fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 3 } }));
      },
      drawPois: function (list, style, click) {
        clear(pois);
        list.forEach(function (it) {
          var st = style(it);
          var m = new gm.Marker({ map: map, position: ll(it.lat, it.lon), zIndex: st.w > 2 ? 900 : 1, icon: { path: gm.SymbolPath.CIRCLE, scale: st.r, fillColor: st.c, fillOpacity: 0.95, strokeColor: '#ffffff', strokeWeight: st.w } });
          m.addListener('click', function () { click(it); }); pois.push(m);
        });
      },
      popup: function (it, el) { iw.setContent(el); iw.setPosition(ll(it.lat, it.lon)); iw.open({ map: map, shouldFocus: false }); },
      closePopup: function () { iw.close(); },
      drawRoute: function (line, mode, to) {
        clear(rt);
        if (line && line.length > 1) {
          var path = line.map(function (p) { return ll(p[0], p[1]); });
          rt.push(new gm.Polyline({ map: map, path: path, strokeColor: '#ffffff', strokeWeight: 9, strokeOpacity: 0.9 }));
          if (mode === 'walking') rt.push(new gm.Polyline({ map: map, path: path, strokeOpacity: 0, icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeColor: '#2563eb', scale: 3 }, offset: '0', repeat: '12px' }] }));
          else rt.push(new gm.Polyline({ map: map, path: path, strokeColor: mode === 'transit' ? '#a855f7' : '#2563eb', strokeWeight: 5, strokeOpacity: 0.95 }));
        }
        if (to) rt.push(new gm.Marker({ map: map, position: ll(to.lat, to.lon), title: to.name || '' }));
      },
      clearRoute: function () { clear(rt); },
      resize: function () { /* Google 地圖會自己偵測容器大小 */ },
      layer: function () { var t = map.getMapTypeId() === 'roadmap' ? 'hybrid' : 'roadmap'; map.setMapTypeId(t); return t === 'hybrid' ? '衛星圖' : '一般地圖'; },
      destroy: function () { clear(me); clear(pois); clear(rt); iw.close(); }
    };
  }
  /** 依目前的資料來源建立（或換掉）地圖；Google 載入失敗就標記並改用 Leaflet */
  async function switchMap() {
    var want = C.provider() === 'google' ? 'google' : 'leaflet';
    if (MP && mapKind === want) { MP.resize(); return; }
    if (MP) { try { MP.destroy(); } catch (e) { /* */ } MP = null; var box = $('ntv-mapc'); if (box) box.parentNode.removeChild(box); }
    var msg = $('ntv-mapmsg'); if (msg) { msg.style.display = ''; msg.textContent = '地圖載入中…'; }
    if (want === 'google') {
      try { await loadGoogle(C.googleKey()); MP = GoogleMap(); mapKind = 'google'; C.countUsage('maps'); }
      catch (e) { C.googleBroken(e.message); toast(e.message + '，改用 OpenStreetMap 模式', 5000); want = 'leaflet'; }
    }
    if (want === 'leaflet') { L = await loadLeaflet(); MP = LeafletMap(); mapKind = 'leaflet'; }
    if (S.res) { drawMe(); drawPois(); if (S.route) drawRoute(); else MP.setView(S.res.pos.lat, S.res.pos.lon, 15); }
  }
  async function initMap() { await switchMap(); }

  function drawMe() { if (MP && S.res) MP.drawMe(S.res.pos, S.res.radius); }
  function visibleItems() {
    if (!S.res) return [];
    return S.res.items.filter(function (it) {
      if (S.cat !== 'all' && it.cat !== S.cat) return false;
      var sel = S.sub[S.cat] || 'all';   // v1.1.2：第二層子分類
      if (sel !== 'all') { if (S.cat === 'fun') { if ((sel === 'in') !== !!it.indoor) return false; } else if (it.grp !== sel) return false; }
      return true;
    });
  }
  function drawPois() {
    if (!MP) return;
    if (S.route) { MP.drawPois([], null, null); return; }   // 看路線時只畫路線
    MP.drawPois(visibleItems().slice(0, mapKind === 'google' ? 400 : 600), function (it) {
      var c = C.cat(it.cat), sel = S.sel === it.id;
      return { r: sel ? 10 : (S.cat === 'all' ? 5 : 7), w: sel ? 3 : 1.2, c: c ? c.color : '#94a3b8' };
    }, function (it) { select(it.id, false); });
  }
  function popHtml(it) {
    var c = C.cat(it.cat);
    return '<div class="ntv-pop"><b>' + esc(it.name) + '</b><br><span style="color:#64748b">' + esc((c ? c.icon + ' ' : '') + it.sub) + ' · ' + esc(C.fmtDist(it.d)) + '</span>' +
      (it.rating ? '<br>⭐ ' + it.rating + '（' + (it.ratings || 0) + '）' + (it.openNow != null ? ' · ' + (it.openNow ? '營業中' : '休息中') : '') : '') +
      (it.cat === 'parking' ? '<br>' + parkText(it) : '') + (it.rent != null ? '<br>可借 ' + it.rent + '／可還 ' + (it.ret == null ? '—' : it.ret) : '') +
      '<div class="a"><button data-ntv="route" data-id="' + esc(it.id) + '">路線</button><button class="p" data-ntv="nav" data-id="' + esc(it.id) + '">導航</button></div></div>';
  }
  function parkText(it) {
    if (it.closed) return '暫停營業';
    if (it.full) return '已滿';
    if (it.avail == null) return it.src === 'TDX' ? '沒有即時車位資料' : (it.total ? '約 ' + it.total + ' 格（無即時資料）' : '無即時車位資料');
    return '剩 ' + it.avail + (it.total ? '／' + it.total : '') + ' 格' + (it.car != null ? '（汽車 ' + it.car + (it.moto != null ? '、機車 ' + it.moto : '') + '）' : it.moto != null ? '（機車 ' + it.moto + '）' : '');
  }
  function fitAll() {
    if (!MP || !S.res) return;
    if (S.route && S.route.line && S.route.line.length) { MP.fitPoints(S.route.line); return; }
    MP.fitCircle(S.res.pos.lat, S.res.pos.lon, S.res.radius);
  }

  /* ───────── 掃描 ───────── */
  async function scan(fresh, silent) {
    if (S.scanning) return; S.scanning = true; S.err = '';
    var rf = $('ntv-rf'); if (rf) rf.classList.add('spin');
    if (!silent) { $('ntv-loc').textContent = '定位中…'; }
    try {
      var keep = silent && S.res && S.res.poi ? { keepPoi: S.res.poi, keepSrc: S.res.osmSrc, keepGErr: S.res.gErr, keepProvider: S.res.provider } : {};
      var res = await C.scan(Object.assign({ fresh: fresh, pos: silent && S.res ? S.res.pos : undefined, onPart: function (k, r) {
        S.res = r;
        if (k === 'pos') { $('ntv-loc').textContent = '已定位' + (r.pos.acc ? '（誤差約 ' + r.pos.acc + ' 公尺）' : '') + '，查詢地址…'; drawMe(); if (MP && !silent) MP.setView(r.pos.lat, r.pos.lon, 15); }
        if (k === 'addr') renderLoc();
        if (k === 'wx') renderWx();
        if (k === 'items') { drawPois(); renderChips(); if (!S.route && !S.search) renderBody(); }
      } }, keep));
      S.res = res;
    } catch (e) {
      S.err = e.message || String(e);
      $('ntv-loc').textContent = '定位失敗';
      if (!S.res) $('ntv-body').innerHTML = '<div class="empty">' + esc(S.err) + '<br><br><button class="btn pri" data-act="refresh">再試一次</button></div>';
      toast(S.err, 5000);
    } finally {
      S.scanning = false; if (rf) rf.classList.remove('spin');
      if (S.res) { renderLoc(); renderWx(); renderChips(); if (!S.route && !S.search) renderBody(); drawMe(); drawPois(); }
    }
  }
  function renderLoc() {
    var r = S.res; if (!r) return;
    var a = r.addr, p = r.pos;
    $('ntv-loc').textContent = (a ? a.text : p.lat.toFixed(5) + ', ' + p.lon.toFixed(5)) + (p.src !== 'gps' ? '（' + (p.src === 'app' ? '稍早的位置' : '上次的位置') + '）' : p.acc ? ' · ±' + p.acc + 'm' : '');
  }
  function renderWx() {
    var w = S.res && S.res.wx, el = $('ntv-wx'); if (!el) return;
    if (!w) { el.innerHTML = '<span class="mut sm">' + (S.res && S.res.wxErr ? '天氣暫時無法取得（' + esc(S.res.wxErr) + '）' : '天氣載入中…') + '</span>'; return; }
    el.innerHTML = '<div class="now"><span class="ic">' + w.icon + '</span><b>' + Math.round(w.temp) + '°</b></div>' +
      '<div class="meta">' + esc(w.text) + ' · 體感 ' + Math.round(w.feels) + '°<br>' + Math.round(w.tmin) + '~' + Math.round(w.tmax) + '° · 降雨 ' + (w.pop == null ? '—' : w.pop + '%') + '</div>' +
      '<div class="meta">濕度 ' + w.humidity + '% · 風 ' + Math.round(w.wind) + 'km/h<br>紫外線 ' + (w.uv == null ? '—' : Math.round(w.uv)) + (w.sunset ? ' · 日落 ' + w.sunset : '') + '</div>' +
      (w.hours || []).map(function (h) { return '<div class="hr">' + esc(h.t) + '<b>' + h.icon + ' ' + Math.round(h.temp) + '°</b>' + (h.pop == null ? '' : h.pop + '%') + '</div>'; }).join('');
  }
  function renderChips() {
    var el = $('ntv-chips'); if (!el || !S.res) return;
    if (S.route || S.search) { el.style.display = 'none'; return; } el.style.display = '';
    var cnt = { all: S.res.items.length }; S.res.items.forEach(function (it) { cnt[it.cat] = (cnt[it.cat] || 0) + 1; });
    var h = '<button class="chip' + (S.cat === 'all' ? ' on' : '') + '" data-act="cat" data-c="all">全部 <span class="n">' + cnt.all + '</span></button>' +
      C.CATS.map(function (c) { return '<button class="chip' + (S.cat === c.id ? ' on' : '') + '" data-act="cat" data-c="' + c.id + '">' + c.icon + ' ' + c.zh + ' <span class="n">' + (cnt[c.id] || 0) + '</span></button>'; }).join('');
    el.innerHTML = h;
  }
  var HOURS = { Mo: '一', Tu: '二', We: '三', Th: '四', Fr: '五', Sa: '六', Su: '日', PH: '國定假日', off: '休息' };
  function hoursZh(s) { return String(s).replace(/\b(Mo|Tu|We|Th|Fr|Sa|Su|PH|off)\b/g, function (m) { return HOURS[m]; }).replace(/24\/7/, '24 小時'); }
  function itemCard(it) {
    var c = C.cat(it.cat), b = '';
    if (it.cat === 'parking') {
      var cls = it.closed || it.full ? 'r' : it.avail == null ? 'n' : it.avail > 20 ? 'g' : it.avail > 5 ? 'y' : 'r';
      b += '<span class="bdg ' + cls + '">' + esc(parkText(it)) + '</span>';
      if (it.fee) b += '<span class="bdg n">' + esc(it.fee) + '</span>';
    }
    if (it.sub === 'YouBike') b += '<span class="bdg ' + (it.closed ? 'r' : it.rent > 3 ? 'g' : it.rent > 0 ? 'y' : 'r') + '">' + (it.closed ? '暫停' : '可借 ' + (it.rent == null ? '—' : it.rent) + (it.ebike ? '（電輔 ' + it.ebike + '）' : '') + '／可還 ' + (it.ret == null ? '—' : it.ret)) + '</span>';
    if (it.cat === 'fun') b += '<span class="bdg n">' + (it.indoor ? '室內' : '室外') + '</span>';
    if (it.grp === '中醫' && it.sub !== '中醫') b += '<span class="bdg n">🌿 中醫</span>';
    if (it.rating) b += '<span class="bdg n">⭐ ' + it.rating + '（' + (it.ratings || 0) + '）</span>';
    if (it.openNow != null) b += '<span class="bdg ' + (it.openNow ? 'g' : 'r') + '">' + (it.openNow ? '營業中' : '休息中') + '</span>';
    if (it.hours) b += '<span class="bdg n">🕒 ' + esc(hoursZh(it.hours).slice(0, 40)) + '</span>';
    var sel = S.sel === it.id;
    return '<div class="card' + (sel ? ' sel' : '') + '" data-act="pick" data-id="' + esc(it.id) + '">' +
      '<div class="row"><span class="dot" style="background:' + (c ? c.color : '#94a3b8') + '"></span><div class="grow"><div class="nm">' + esc(it.name) + '</div>' +
      '<div class="sm mut">' + esc(it.sub) + (it.brand && it.brand !== it.name ? ' · ' + esc(it.brand) : '') + (it.addr ? ' · ' + esc(it.addr) : '') + '</div></div><span class="dist">' + esc(C.fmtDist(it.d)) + '</span></div>' +
      (b ? '<div>' + b + '</div>' : '') +
      (sel ? '<div class="acts"><button class="btn" data-act="route" data-id="' + esc(it.id) + '">🧭 路線</button><button class="btn pri" data-act="nav" data-id="' + esc(it.id) + '">導航</button>' + (it.phone ? '<button class="btn" data-act="tel" data-id="' + esc(it.id) + '">📞</button>' : '') + (it.gurl ? '<button class="btn" data-act="gurl" data-id="' + esc(it.id) + '">詳情</button>' : '') + '</div>' : '') +
      '</div>';
  }
  function renderBody() {
    var el = $('ntv-body'); if (!el) return;
    if (S.route || S.search) return;
    if (!S.res) { el.innerHTML = '<div class="empty">' + (S.err ? esc(S.err) : '定位中…') + '</div>'; return; }
    var h = '';
    if (C.SUBS[S.cat]) {   // v1.1.2：子分類列（含各自數量；沒有的不列，但目前選中的保留）
      var base = S.res.items.filter(function (it) { return it.cat === S.cat; }), cur = S.sub[S.cat] || 'all';
      var cnt = function (k) { return base.filter(function (it) { return S.cat === 'fun' ? (k === 'in') === !!it.indoor : it.grp === k; }).length; };
      h += '<div class="row" style="gap:6px;margin:4px 0;flex-wrap:wrap">' + [['all', '全部', base.length]].concat(C.SUBS[S.cat].map(function (x) { return [x[0], x[1], cnt(x[0])]; })).filter(function (x) { return x[0] === 'all' || x[2] > 0 || x[0] === cur; })
        .map(function (x) { return '<button class="chip sm' + (cur === x[0] ? ' on' : '') + '" data-act="sub" data-f="' + esc(x[0]) + '">' + x[1] + ' <span class="n">' + x[2] + '</span></button>'; }).join('') + '</div>';
    }
    var list = visibleItems();
    if (S.cat === 'parking') list = list.slice().sort(function (a, b) { return (b.avail != null && !b.full) - (a.avail != null && !a.full) || a.d - b.d; });
    var notes = [];
    if ((S.cat === 'all' || S.cat === 'parking') && S.res.parkNote) notes.push('🅿️ ' + S.res.parkNote);
    if ((S.cat === 'all' || S.cat === 'transit') && S.res.bikeNote) notes.push('🚲 ' + S.res.bikeNote);
    if (S.res.osmErr) notes.push('⚠️ ' + S.res.osmErr);
    if (S.res.gErr) notes.push('⚠️ ' + S.res.gErr + '；這次改用 OpenStreetMap 資料');
    (S.res.notes || []).forEach(function (n) { if (/^部分類別查詢失敗/.test(n)) notes.push('⚠️ Google ' + n); });
    if (S.res.osmSrc === 'Nominatim') notes.push('ℹ️ 周邊設施暫用備援資料（OSM 類別搜尋，每類最多 40 筆，沒有公車站以外的小站點）；完整資料查到後會自動更新。');
    (S.res.pos.warn ? [S.res.pos.warn] : []).forEach(function (n) { notes.push('📍 ' + n); });
    h += notes.map(function (n) { return '<div class="note">' + esc(n) + '</div>'; }).join('');
    if (!list.length) h += '<div class="empty">' + (S.scanning ? '正在查詢周邊 ' + C.fmtDist(S.res.radius) + ' 內的設施…' : '這個範圍內沒有找到這類設施') + '</div>';
    else {
      var shown = list.slice(0, S.cat === 'all' ? 80 : 200);
      if (S.cat === 'all') {   // 全部：每類先列最近 3 個
        h += C.CATS.map(function (c) {
          var xs = list.filter(function (it) { return it.cat === c.id; });
          if (c.id === 'parking') xs = xs.slice().sort(function (a, b) { return (b.avail != null && !b.full) - (a.avail != null && !a.full) || a.d - b.d; });
          if (!xs.length) return '';
          return '<div class="row" style="margin-top:10px"><b class="grow">' + c.icon + ' ' + c.zh + '</b><button class="chip sm" data-act="cat" data-c="' + c.id + '">全部 ' + xs.length + ' ›</button></div>' + xs.slice(0, 3).map(itemCard).join('');
        }).join('');
      } else h += shown.map(itemCard).join('') + (list.length > shown.length ? '<div class="note">只列最近 ' + shown.length + ' 個（共 ' + list.length + ' 個）</div>' : '');
    }
    var gm = S.res.provider === 'google' && !S.res.gErr;
    h += '<div class="note">資料：' + (gm ? 'Google 地圖' : 'OpenStreetMap') + (C.hasTdx() ? '、交通部 TDX（停車、YouBike）' : '') + (S.res.items.some(function (x) { return x.src === '新北市'; }) ? '、新北市政府開放資料（停車）' : '') + '、Open-Meteo。距離為直線距離。' + (S.res.at ? ' 更新於 ' + new Date(S.res.at).toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '') + '</div>';
    if (C.googleKey()) {   // v1.1.0：Google／OpenStreetMap 切換
      var isG = C.provider() === 'google';
      h += '<div class="note">' + (isG ? (S.res.gErr ? '目前用 Google 地圖；地點資料這次用 OpenStreetMap。' : '目前用 Google 地圖與地點資料。') : (C.googleBroken() ? 'Google 地圖無法使用：' + esc(C.googleBroken()) + '。' : '目前用 OpenStreetMap 免費資料。')) +
        ' <button class="btn" style="min-height:30px;margin-left:4px" data-act="prov" data-p="' + (isG ? 'osm' : 'google') + '">' + (isG ? '這次改用 OpenStreetMap' : (C.googleBroken() ? '再試 Google' : '這次改用 Google')) + '</button></div>';
      var pf = C.providerPref();
      h += '<div class="note row" style="gap:6px;flex-wrap:wrap">打開時：<select id="ntv-pref" style="min-height:32px;border-radius:10px;border:1px solid var(--bd);background:var(--c);color:var(--t);padding:0 8px">' +
        [['ask', '每次詢問'], ['google', '一律 Google'], ['osm', '一律 OpenStreetMap']].map(function (o) { return '<option value="' + o[0] + '"' + (pf === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
        '</select><button class="btn" style="min-height:32px" data-act="usage">本月 Google 用量</button></div><div id="ntv-usage"></div>';
    }
    el.innerHTML = h;
  }
  function findItem(id) { return S.res && S.res.items.filter(function (x) { return x.id === id; })[0]; }
  function select(id, fromList) {
    S.sel = S.sel === id && fromList ? null : id; var it = findItem(id);
    drawPois();
    if (it && MP && S.sel) { MP.setView(it.lat, it.lon, Math.max(MP.getZoom() || 15, 16)); MP.popup(it, popEl(it)); }
    renderBody();
    if (!fromList && S.sel) { var c = D.querySelector('#ntv-body .card.sel'); if (c) c.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  }

  /* ───────── 搜尋目的地 ───────── */
  async function doSearch(q) {
    q = String(q || '').trim(); if (!q) return;
    if (!S.search) pushLayer(function () { S.search = null; renderChips(); renderBody(); });
    S.search = { q: q, loading: true, list: [] }; renderChips(); renderSearch();
    try { S.search.list = await C.search(q, S.res ? S.res.pos : C.lastPos()); }
    catch (e) { S.search.err = e.message; }
    S.search.loading = false; renderSearch();
  }
  function renderSearch() {
    var s = S.search, el = $('ntv-body'); if (!s || !el) return;
    var h = '<div class="row" style="margin:6px 0"><b class="grow">「' + esc(s.q) + '」的搜尋結果</b><button class="btn" data-act="back">關閉</button></div>';
    if (s.loading) h += '<div class="empty">搜尋中…</div>';
    else if (s.err) h += '<div class="empty">' + esc(s.err) + '</div>';
    else if (!s.list.length) h += '<div class="empty">找不到符合的地點，試試更完整的名稱或地址</div>';
    else h += s.list.map(function (x, i) {
      return '<div class="card" data-act="go" data-i="' + i + '"><div class="row"><span style="font-size:18px">' + (x.src === 'nearby' ? '📍' : '🔎') + '</span><div class="grow"><div class="nm">' + esc(x.name) + '</div><div class="sm mut">' + esc(x.addr || '') + '</div></div>' +
        (x.d != null ? '<span class="dist">' + esc(C.fmtDist(x.d)) + '</span>' : '') + '</div></div>';
    }).join('');
    el.innerHTML = h;
  }

  /* ───────── 路線 ───────── */
  function autoMode(d) { return d < 1200 ? 'walking' : 'driving'; }
  async function planTo(to, mode) {
    if (!S.res) { toast('還沒定位完成'); return; }
    var first = !S.route && !S.routeTo;
    S.routeTo = to; S.mode = mode || S.mode || 'driving';
    if (first) pushLayer(function () { S.route = null; S.routeTo = null; MP && MP.clearRoute(); $('ntv-win').classList.remove('rt'); renderChips(); drawPois(); if (S.search) renderSearch(); else renderBody(); setTimeout(function () { MP && MP.resize(); fitAll(); }, 80); });
    S.route = { loading: true, to: to, mode: S.mode }; $('ntv-win').classList.add('rt'); renderChips(); drawPois(); renderRoute();
    setTimeout(function () { MP && MP.resize(); }, 80);
    var from = { lat: S.res.pos.lat, lon: S.res.pos.lon, name: '目前位置' };
    var want = S.mode;
    try { var r = await C.route(from, to, want); if (S.routeTo !== to || S.mode !== want) return; S.route = r; if (r.mode !== want) S.route.fallbackFrom = want; }
    catch (e) { if (S.routeTo !== to) return; S.route = { err: e.message, to: to, mode: S.mode, gmaps: C.gmapsNav(to.lat, to.lon, S.mode, from.lat, from.lon) }; }
    drawRoute(); renderRoute();
  }
  function drawRoute() {
    if (!MP) return; MP.clearRoute();
    var r = S.route; if (!r) return;
    MP.drawRoute(r.line, r.mode, r.to || S.routeTo);
    fitAll();
  }
  function renderRoute() {
    var r = S.route, el = $('ntv-body'); if (!r || !el) return;
    var to = r.to || S.routeTo, modes = [['driving', '🚗 開車']].concat(C.provider() === 'google' ? [['moto', '🛵 機車']] : [], [['walking', '🚶 步行'], ['cycling', '🚲 單車'], ['transit', '🚌 大眾']]);   // v1.1.0：機車只有 Google 有
    var h = '<div class="row" style="margin-top:6px"><div class="grow"><div class="sm mut">目的地</div><div class="nm">' + esc(to.name) + '</div>' + (to.addr ? '<div class="sm mut">' + esc(to.addr) + '</div>' : '') + '</div><button class="ib" data-act="back" aria-label="關閉路線">✕</button></div>' +
      '<div class="modes">' + modes.map(function (m) { return '<button class="' + (S.mode === m[0] ? 'on' : '') + '" data-act="mode" data-m="' + m[0] + '">' + m[1] + '</button>'; }).join('') + '</div>';
    if (r.loading) h += '<div class="empty">規劃路線中…</div>';
    else if (r.err) h += '<div class="card"><div>' + esc(r.err) + '</div><div class="acts"><button class="btn pri" data-act="gmaps">改用 Google 地圖導航</button></div></div>';
    else {
      h += '<div class="card"><div class="row"><div class="grow"><div class="sum">' + esc(C.fmtDur(r.dur)) + '</div><div class="mut sm">' + esc(C.fmtDist(r.dist)) + (r.mode === 'transit' && !/^Google/.test(r.src || '') ? '（直線距離）' : '') + ' · ' + esc(r.src || '') + '</div></div></div>' +
        '<div class="acts"><button class="btn pri big" data-act="gmaps">▶ 開始導航（Google 地圖）</button></div></div>';
      if (r.plans && r.plans.length > 1) h += '<div class="note">其他方案：' + r.plans.slice(1).map(function (p) { return esc(C.fmtDur(p.dur)) + '（' + esc(p.steps.filter(function (s) { return s.kind === 'ride'; }).map(function (s) { return s.text.replace(/（.*$/, ''); }).join(' → ') || '步行') + '）'; }).join('；') + '</div>';
      h += '<div class="card">' + (r.steps || []).map(function (s, i) {
        return '<div class="step"><span class="no">' + (i + 1) + '</span><div class="grow">' + esc(s.text) + '<div class="sm mut">' + [s.dist ? C.fmtDist(s.dist) : '', s.dur ? C.fmtDur(s.dur) : ''].filter(Boolean).join(' · ') + '</div></div></div>';
      }).join('') + '</div>';
      if (r.fallbackFrom === 'moto') h += '<div class="note">Google 機車路線查詢失敗，先顯示開車路線。</div>';
      if (r.mode !== 'transit' && !/^Google/.test(r.src || '')) h += '<div class="note">路線由 OpenStreetMap 開放路網計算，沒有即時路況；實際導航請以 Google 地圖為準。</div>';
    }
    el.innerHTML = h; el.scrollTop = 0;
  }
  function openExt(url) { try { W.open(url, '_system'); } catch (e) { location.href = url; } }

  /* ───────── 事件 ───────── */
  function onClick(e) {
    var t = e.target.closest('[data-act],[data-ntv]'); if (!t) return;
    var a = t.getAttribute('data-act') || t.getAttribute('data-ntv'), id = t.getAttribute('data-id');
    if (a !== 'pick') e.stopPropagation();
    switch (a) {
      case 'close': return close();
      case 'back': return closeTop();
      case 'refresh': return scan(true, false);
      case 'me': if (MP && S.res) MP.setView(S.res.pos.lat, S.res.pos.lon, 16); return;
      case 'fit': return fitAll();
      case 'tiles': if (MP) toast((MP.kind === 'google' ? '地圖：' : '底圖：') + MP.layer(), 1800); return;
      case 'choose': return pickProvider(t.getAttribute('data-p'));
      case 'usage': { var u = $('ntv-usage'); if (u) u.innerHTML = u.innerHTML ? '' : usageHtml(true); return; }
      case 'prov': {   // 這次改用另一種；設定是「一律」時一併改設定
        var toG = t.getAttribute('data-p') === 'google';
        if (toG) C.googleBroken('');
        C.sessionProvider(toG ? 'google' : 'osm'); if (C.providerPref() !== 'ask') C.providerPref(toG ? 'google' : 'osm');
        S.sel = null; switchMap().then(function () { scan(false, false); }); return;
      }
      case 'gurl': { var ig = findItem(id); if (ig && ig.gurl) openExt(ig.gurl); return; }
      case 'cat': S.cat = t.getAttribute('data-c'); S.sel = null; if (MP) MP.closePopup(); renderChips(); renderBody(); drawPois(); $('ntv-body').scrollTop = 0; return;
      case 'sub': S.sub[S.cat] = t.getAttribute('data-f'); S.sel = null; if (MP) MP.closePopup(); renderBody(); drawPois(); $('ntv-body').scrollTop = 0; return;
      case 'pick': if (e.target.closest('button')) return; return select(id, true);
      case 'route': { var it = findItem(id); if (it) { if (MP) MP.closePopup(); planTo({ lat: it.lat, lon: it.lon, name: it.name, addr: it.addr || it.sub }, autoMode(it.d)); } return; }
      case 'nav': { var it2 = findItem(id); if (it2 && S.res) openExt(C.gmapsNav(it2.lat, it2.lon, autoMode(it2.d), S.res.pos.lat, S.res.pos.lon)); return; }
      case 'tel': { var it3 = findItem(id); if (it3 && it3.phone) openExt('tel:' + String(it3.phone).split(/[;,]/)[0].replace(/[^\d+]/g, '')); return; }
      case 'go': { var x = S.search && S.search.list[+t.getAttribute('data-i')]; if (x) planTo(x, autoMode(x.d != null ? x.d : 99999)); return; }
      case 'mode': { var m = t.getAttribute('data-m'); if (S.routeTo && m !== S.mode) planTo(S.routeTo, m); return; }
      case 'gmaps': { var r = S.route, to = r && (r.to || S.routeTo); if (to && S.res) openExt(r.gmaps || C.gmapsNav(to.lat, to.lon, S.mode, S.res.pos.lat, S.res.pos.lon)); return; }
    }
  }
  /* ───────── v1.1.1：這次用哪種地圖（Google 會用到 Google Maps Platform 的免費額度／費用） ───────── */
  function usageHtml(all) {
    var rows = C.usageRows().filter(function (r) { return all || r.used > 0 || r.key === 'nearby' || r.key === 'maps'; });
    return '<div class="sm mut" style="margin-top:8px;line-height:1.6">本月 Google 用量（這支手機的 TravelAgent；費用以 Google Cloud 帳單為準）：<br>' +
      rows.map(function (r) { var pct = r.used / r.free; return esc(r.zh) + ' <b style="color:' + (pct >= 1 ? '#f87171' : pct >= 0.8 ? '#facc15' : 'inherit') + '">' + r.used + '</b>／免費 ' + r.free.toLocaleString() + ' 次'; }).join('<br>') + '</div>';
  }
  var choiceResolve = null;
  function askProvider() {
    var el = $('ntv-body'); $('ntv-chips').style.display = 'none';
    var m = $('ntv-mapmsg'); if (m) { m.style.display = ''; m.textContent = '請在下方選擇這次要用的地圖'; }
    el.innerHTML = '<div class="card" style="margin-top:10px"><b style="font-size:15px">這次要用哪種地圖？</b>' +
      '<div class="sm mut" style="margin:6px 0 10px">Google 的店家資料較完整（含評分、營業中），每次打開約用 1 次地圖載入＋15 次附近搜尋，超過每月免費額度會計費；OpenStreetMap 免費，但店家可能有缺漏。停車剩餘車位、YouBike、天氣兩種都有。</div>' +
      '<button class="btn pri big" data-act="choose" data-p="google">Google 地圖</button>' +
      '<button class="btn big" style="margin-top:8px" data-act="choose" data-p="osm">OpenStreetMap（免費）</button>' +
      '<label class="row sm" style="margin-top:10px;gap:8px"><input type="checkbox" id="ntv-remember" style="width:18px;height:18px"> 記住我的選擇，下次不再詢問（頁面最下方可以改回）</label>' +
      usageHtml(false) + '</div>';
    return new Promise(function (res) { choiceResolve = res; });
  }
  function pickProvider(p) {
    var rem = $('ntv-remember') && $('ntv-remember').checked;
    C.sessionProvider(p); if (rem) C.providerPref(p);
    var f = choiceResolve; choiceResolve = null; f && f(p);
  }

  /* ───────── 開關 ───────── */
  async function open(opts) {
    C = W.NovaTravelCore; if (!C) return toast('TravelAgent 引擎沒有載入');
    ensureDom();
    if (!S.open) {
      S.open = true; $('ntv-win').classList.add('on');
      pushLayer(function () { S.open = false; $('ntv-win').classList.remove('on'); clearInterval(S.refreshT); S.refreshT = null; if (choiceResolve) { var f = choiceResolve; choiceResolve = null; f(''); } });
    }
    // v1.1.1：每次打開都由使用者決定這次要不要用 Google（設定成「一律」就不問）
    C.sessionProvider('');
    if (C.needsChoice()) { await askProvider(); if (!S.open) return; }
    try { await initMap(); } catch (e) { $('ntv-mapmsg').textContent = '地圖載入失敗：' + e.message; }
    renderBody();
    var p = scan(true, false);
    clearInterval(S.refreshT);
    S.refreshT = setInterval(function () { if (S.open && !S.scanning && S.res && !D.hidden) scan(false, true); }, 120000);   // 只更新停車與 YouBike（v1.1.1）
    return p;
  }
  function close() { while (S.layers.length > 1) { var f = S.layers.pop(); try { f(); } catch (e) { /* */ } } closeTop(); }
  /** AI 工具用：打開 TravelAgent 並規劃到 to 的路線 */
  async function showRoute(to, mode) {
    await open();
    if (to && isFinite(to.lat)) planTo({ lat: to.lat, lon: to.lon, name: to.name || '目的地', addr: to.addr || '' }, mode || 'driving');
  }
  function addEntry() {
    var grid = D.getElementById('plus-menu'); if (!grid) return;
    var mine = D.getElementById('nv-travel-btn'), ins0 = D.getElementById('nv-insight-btn');
    if (mine) { if (ins0 && ins0.parentNode === mine.parentNode && ins0.nextSibling !== mine) ins0.parentNode.insertBefore(mine, ins0.nextSibling); return; }   // Insight 鈕較晚加入時，移到它後面
    var ref = grid.querySelector('button.nv-pm'); if (!ref || !ref.parentNode) return;
    var b = D.createElement('button'); b.id = 'nv-travel-btn'; b.type = 'button';
    b.className = 'nv-pm flex flex-col items-center justify-center gap-2 p-2 rounded-xl bg-slate-800 border border-cyan-500/50 hover:bg-slate-700 text-cyan-400 transition-colors active:scale-95'; b.style.setProperty('--pc', '#22d3ee');
    b.innerHTML = '<i class="ph-bold ph-map-trifold text-xl"></i><span class="text-[10px] font-bold whitespace-nowrap">TravelAgent</span>';
    b.onclick = function () { try { W.togglePlusMenu(); } catch (e) { /* */ } open(); };
    var ins = D.getElementById('nv-insight-btn'); if (ins && ins.parentNode === ref.parentNode) ins.parentNode.insertBefore(b, ins.nextSibling); else ref.parentNode.appendChild(b);
  }
  function boot() { addEntry(); setInterval(addEntry, 3000); }
  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', boot); else boot();
  W.NovaTravel = { version: '1.1.2', init: function (h) { H = h || {}; }, open: open, close: close, showRoute: showRoute, _S: S, _map: function () { return MP; } };
})(window);

/* ═══════════════════════════════════════════════════════════════════════
   nova-acc-bridge.js — NOVA Android 自主任務的「無障礙服務執行器」（跟 index.html 放同一個資料夾 www/）
   版本：v1.0.0
   版本紀錄：
   v1.0.0 - 初版（批次 5b）。把原生 Capacitor 外掛 NovaAccessibility（NovaAccessibilityService.java）包成「長得像 atx-agent」的介面，
            讓 novaAutoTask 引擎（執行層／截圖／UI 階層解析）完全不用改，只要把 fetch(baseUrl()+path) 換成 atxFetch(path)：
            ① /info、/screenshot/0、/uiautomator(DELETE)、/shell?command=…、/jsonrpc/0（deviceInfo、dumpWindowHierarchy、setClipboard、setText）。
            ② shell 指令對照：input tap／swipe／keyevent／text、monkey／am start（開 App／開網址）、dumpsys window windows（前景 App）、pm list packages。
               不支援的指令（ime／settings／logcat／am broadcast…）回傳空字串，引擎的文字輸入走「剪貼簿＋KEYCODE_PASTE」不需要它們。
            ③ KEYCODE_PASTE（279）：先 ACTION_PASTE；失敗就讀剪貼簿改用 ACTION_SET_TEXT。
            ④ 啟用條件：設定「自主任務執行器」選「無障礙服務」(localStorage nova_autotask_executor = 'acc') 且外掛存在；
               Android 11 以下沒有無障礙截圖 API，會明確回報錯誤（請改用 atx-agent）。
   對外：window.NovaAccBridge = { active(), fetch(path, opts), status(), openSettings(), typeText? }
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';
    function plug() { return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NovaAccessibility; }
    function mode() { try { return localStorage.getItem('nova_autotask_executor') || 'atx'; } catch (e) { return 'atx'; } }
    function active() { return mode() === 'acc' && !!plug(); }
    var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

    function jsonRes(obj, status) { return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } }); }
    function textRes(t, status) { return new Response(String(t == null ? '' : t), { status: status || 200 }); }
    function errRes(e) {
        var m = (e && e.message) || String(e);
        if (/ACC_NOT_ENABLED/.test(m)) m = '無障礙服務尚未啟用：請到 設定 →「AI 自主任務」按「開啟無障礙服務」，在系統清單裡打開 NOVA';
        return textRes(m, 503);
    }
    function b64ToBlob(b64, type) { var bin = atob(b64), n = bin.length, u = new Uint8Array(n); for (var i = 0; i < n; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type: type || 'image/jpeg' }); }

    var lastShotAt = 0, cachedStatus = null;

    async function status() { var s = await plug().status(); cachedStatus = s; return s; }

    async function doScreenshot() {
        var wait = 1100 - (Date.now() - lastShotAt);   // 系統限制：截圖要間隔約 1 秒
        if (wait > 0) await sleep(wait);
        var r = await plug().screenshot({ maxDim: 1080, quality: 75 });
        lastShotAt = Date.now();
        return r;
    }

    async function pasteWithFallback() {
        var r = await plug().paste();
        if (r && r.ok) return 'paste ok';
        try {
            var C = window.Capacitor.Plugins.Clipboard;
            var cur = C && C.read ? await C.read() : null;
            var txt = cur && (cur.value || cur.string);
            if (txt) { var r2 = await plug().setText({ text: String(txt) }); return r2 && r2.ok ? 'paste→setText ok' : 'paste FAILED（找不到輸入焦點）'; }
        } catch (e) { /* ignore */ }
        return 'paste FAILED（找不到輸入焦點）';
    }

    function unquote(s) { s = String(s || '').trim(); if ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'")) s = s.slice(1, -1); return s.replace(/\\"/g, '"'); }

    async function shell(cmd) {
        cmd = String(cmd || '').trim();
        var m;
        if ((m = cmd.match(/^input tap (-?[\d.]+) (-?[\d.]+)$/))) { var r = await plug().tap({ x: +m[1], y: +m[2], duration: 60 }); return r.ok ? '' : 'tap FAILED（手勢被系統取消）'; }
        if ((m = cmd.match(/^input swipe (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)(?: (\d+))?$/))) {
            var s = await plug().swipe({ x1: +m[1], y1: +m[2], x2: +m[3], y2: +m[4], duration: +(m[5] || 300) });
            return s.ok ? '' : 'swipe FAILED（手勢被系統取消）';
        }
        if ((m = cmd.match(/^input keyevent (\S+)$/))) {
            var k = m[1].toUpperCase().replace(/^KEYCODE_/, '');
            if (k === '4' || k === 'BACK') return (await plug().globalAction({ action: 'back' })).ok ? '' : 'back FAILED';
            if (k === '3' || k === 'HOME') return (await plug().globalAction({ action: 'home' })).ok ? '' : 'home FAILED';
            if (k === '187' || k === 'APP_SWITCH') return (await plug().globalAction({ action: 'recents' })).ok ? '' : 'recents FAILED';
            if (k === '279' || k === 'PASTE') return await pasteWithFallback();
            if (k === '66' || k === 'ENTER') { var e = await plug().imeEnter(); return e.ok ? '' : 'enter FAILED（Android 11 以上才支援 IME Enter；請改點畫面上的送出／搜尋按鈕）'; }
            if (k === '82' || k === 'MENU') return (await plug().globalAction({ action: 'notifications' })).ok ? '' : 'menu FAILED';
            return 'keyevent ' + k + ' 無障礙模式不支援（只支援 返回／Home／最近／Enter／貼上）';
        }
        if ((m = cmd.match(/^input text (.*)$/))) { var t = m[1].replace(/%s/g, ' '); var r3 = await plug().setText({ text: t }); return r3.ok ? '' : 'setText FAILED（找不到輸入焦點）'; }
        if ((m = cmd.match(/^monkey -p (\S+)/))) { await plug().launchApp({ package: m[1] }); return 'launched ' + m[1]; }
        if ((m = cmd.match(/^am start -n ([^\s/]+)\/(\S+)$/))) { await plug().launchApp({ package: m[1], activity: m[2] }); return 'started ' + m[1]; }
        if ((m = cmd.match(/^am start -a android\.intent\.action\.VIEW -d (.+)$/))) { await plug().openUrl({ url: unquote(m[1]) }); return 'started VIEW'; }
        if (/^dumpsys window windows/.test(cmd)) { var d = await plug().dump(); return 'mCurrentFocus=Window{nova u0 ' + (d.package || 'unknown') + '/.Main}'; }
        if (/^pm list packages/.test(cmd)) { var p = await plug().listPackages(); return (p.packages || []).map(function (x) { return 'package:' + x; }).join('\n'); }
        return '';   // ime／settings／logcat／am broadcast 等：無障礙模式用不到
    }

    async function rpc(method, params) {
        switch (method) {
            case 'deviceInfo': { var s = await status(); return { displayWidth: s.width || 0, displayHeight: s.height || 0, screenOn: true, productName: s.model || '' }; }
            case 'dumpWindowHierarchy': return (await plug().dump()).xml;
            case 'setClipboard': { var C = window.Capacitor.Plugins.Clipboard; if (C && C.write) { await C.write({ string: String(params[0] || '') }); return true; } throw new Error('沒有剪貼簿外掛'); }
            case 'setText': { var r = await plug().setText({ text: String(params[1] == null ? '' : params[1]) }); if (!r.ok) throw new Error('找不到輸入焦點'); return true; }
            default: throw new Error('無障礙模式不支援 RPC：' + method);
        }
    }

    // 模擬 fetch(baseUrl() + path, opts)
    async function bridgeFetch(path, opts) {
        opts = opts || {};
        try {
            if (!plug()) return textRes('這個版本沒有 NovaAccessibility 外掛（請安裝新版 APK）', 503);
            if (path.indexOf('/info') === 0) {
                var s = await status();
                if (!s.connected) return textRes('ACC_NOT_ENABLED', 503);
                if (!s.canScreenshot) return textRes('無障礙截圖需要 Android 11 以上（本機 API ' + s.sdk + '），請改用 atx-agent', 503);
                return jsonRes({ model: s.model + '（無障礙服務）', serial: 'accessibility' });
            }
            if (path.indexOf('/screenshot') === 0) { var shot = await doScreenshot(); return new Response(b64ToBlob(shot.data, 'image/jpeg'), { status: 200 }); }
            if (path.indexOf('/uiautomator') === 0) return textRes('ok');
            if (path.indexOf('/shell') === 0) {
                var q = path.split('?')[1] || ''; var cmd = decodeURIComponent((q.match(/(?:^|&)command=([^&]*)/) || [])[1] || '');
                return jsonRes({ output: await shell(cmd), exitCode: 0 });
            }
            if (path.indexOf('/jsonrpc') === 0) {
                var body = JSON.parse(opts.body || '{}');
                try { return jsonRes({ jsonrpc: '2.0', id: body.id, result: await rpc(body.method, body.params || []) }); }
                catch (e) { return jsonRes({ jsonrpc: '2.0', id: body.id, error: { message: e.message } }); }
            }
            return textRes('not found', 404);
        } catch (e) { return errRes(e); }
    }

    window.NovaAccBridge = {
        active: active, mode: mode, fetch: bridgeFetch, status: function () { return plug() ? status() : Promise.reject(new Error('沒有 NovaAccessibility 外掛')); },
        openSettings: function () { return plug() ? plug().openSettings() : Promise.reject(new Error('沒有 NovaAccessibility 外掛')); },
        hasPlugin: function () { return !!plug(); }, _shell: shell
    };
})();

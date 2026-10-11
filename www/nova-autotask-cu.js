/* ═══════════════════════════════════════════════════════════════════════
   nova-autotask-cu.js — NOVA Android 自主任務的「Gemini Computer Use 判斷器」（跟 index.html 放同一個資料夾 www/）
   版本：v1.0.0
   版本紀錄：
   v1.0.0 - 初版（批次 5a）。用 Gemini 官方 Computer Use（Interactions API：POST /v1beta/interactions，tools:[{type:'computer_use',environment:'mobile'}]）
            取代「提示詞＋截圖＋元件清單」的判斷方式；模型回傳的 function_call 會被轉成 novaAutoTask 既有的動作格式
            （tap／long_press／swipe／text／key／open_app／open_url／wait／done／fail），所以執行層（atx-agent 或無障礙外掛）完全不用改。
            ① 座標：模型用 0–999 正規化座標 → 轉成 0.0–1.0 相對比例（既有引擎再乘上裝置真實解析度）。
            ② 多步動作：type（點欄位→貼上文字→可選 Enter）會拆成佇列，逐回合交給引擎執行；佇列清空後才把 function_result＋最新截圖回給模型。
            ③ 對話狀態由伺服器端 previous_interaction_id 維持，不用每回合重送歷史；每個任務開始前呼叫 reset()。
            ④ open_app：模型給的是 App 名稱，這裡用「內建別名表＋已安裝套件清單」解析成套件名；解析不到會把候選清單回給模型（不浪費回合）。
            ⑤ safety_decision：require_confirmation 會用 App 的確認視窗問使用者，同意才執行並回報 safety_acknowledgement；拒絕／blocked 則回傳 fail。
            ⑥ 自訂函式：press_home、open_url、task_done、task_fail（Computer Use 預設函式沒有「完成／失敗」）。
   誠實說明：依官方文件寫成，只用模擬回應測過；官方 REST 欄位細節（steps 內 function_call 的 id 位置、function_result 的 image 欄位）文件沒有完整範例，
            解析採「寬鬆多路徑」寫法；設定頁預設勾選「失敗時自動退回舊判斷器」，真機上若欄位對不上不會讓任務中斷。
   對外：window.NovaAutoCU = { decide(ctx), reset(), mapCall(call), _state }。
   ctx = { goal, history, screenshotB64, imgW, imgH, apiKey, model, fetchImpl?, deps:{ shell(cmd), confirm(msg), log(msg) } }
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';
    var ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
    var ST = { interactionId: null, pending: [], awaiting: [], extra: [], lastGoal: null, apps: null };

    var ALIASES = {
        'chrome': 'com.android.chrome', 'google chrome': 'com.android.chrome', '瀏覽器': 'com.android.chrome',
        'line': 'jp.naver.line.android', 'youtube': 'com.google.android.youtube', 'gmail': 'com.google.android.gm',
        'google maps': 'com.google.android.apps.maps', 'maps': 'com.google.android.apps.maps', '地圖': 'com.google.android.apps.maps',
        'messages': 'com.google.android.apps.messaging', '訊息': 'com.google.android.apps.messaging', 'sms': 'com.google.android.apps.messaging',
        'settings': 'com.android.settings', '設定': 'com.android.settings', 'camera': 'com.android.camera', '相機': 'com.android.camera',
        'play store': 'com.android.vending', 'google play': 'com.android.vending', 'photos': 'com.google.android.apps.photos', '相簿': 'com.google.android.apps.photos',
        'calendar': 'com.google.android.calendar', '行事曆': 'com.google.android.calendar', 'clock': 'com.google.android.deskclock', '時鐘': 'com.google.android.deskclock',
        'phone': 'com.google.android.dialer', '電話': 'com.google.android.dialer', 'contacts': 'com.google.android.contacts', '聯絡人': 'com.google.android.contacts',
        'files': 'com.google.android.documentsui', '檔案': 'com.google.android.documentsui', 'whatsapp': 'com.whatsapp', 'telegram': 'org.telegram.messenger',
        'facebook': 'com.facebook.katana', 'instagram': 'com.instagram.android', 'spotify': 'com.spotify.music', 'nova': 'com.nova.android'
    };

    // ── 工具宣告 ──
    function tools() {
        var fn = function (name, description, props, req) { return { type: 'function', name: name, description: description, parameters: { type: 'object', properties: props || {}, required: req || [] } }; };
        return [
            { type: 'computer_use', environment: 'mobile' },
            fn('press_home', '回到手機主畫面（Home 鍵）。'),
            fn('open_url', '直接用瀏覽器開啟完整網址（比在網頁裡點搜尋框更可靠）。', { url: { type: 'string', description: '含 https:// 的完整網址' } }, ['url']),
            fn('task_done', '任務已完成，且你在最新截圖裡親眼看到完成證據時才呼叫。', { summary: { type: 'string', description: '完成了什麼（給使用者看）' } }, ['summary']),
            fn('task_fail', '任務無法完成（例如連續嘗試仍找不到目標、需要使用者登入或授權）時呼叫。', { reason: { type: 'string', description: '無法完成的原因' } }, ['reason'])
        ];
    }

    function clamp01(n) { n = Number(n); if (!isFinite(n)) n = 0; return Math.max(0, Math.min(1, n / 1000)); }
    function r3(n) { return Math.round(n * 1000) / 1000; }

    // ── function_call → 引擎動作陣列（純函式，可單元測試） ──
    function mapCall(call, ctx) {
        var n = call.name, a = call.arguments || call.args || {};
        var say = a.intent || a.summary || a.reason || '';
        var rel = function (v) { return r3(clamp01(v)); };
        switch (n) {
            case 'click': case 'click_at': case 'tap':
                return [{ type: 'tap', x: rel(a.x), y: rel(a.y), say: say || '點擊' }];
            case 'long_press': case 'long_press_at':
                return [{ type: 'long_press', x: rel(a.x), y: rel(a.y), say: say || '長按' }];
            case 'type': case 'type_text_at': {
                var out = [];
                if (a.x != null && a.y != null) out.push({ type: 'tap', x: rel(a.x), y: rel(a.y), say: (say || '點選輸入框') + '（先聚焦）' });
                out.push({ type: 'text', text: String(a.text == null ? '' : a.text), say: say || '輸入文字' });
                if (a.press_enter) out.push({ type: 'key', key: 'enter', say: '按 Enter 送出' });
                return out;
            }
            case 'drag_and_drop': {
                var sx = a.start_x != null ? a.start_x : a.x, sy = a.start_y != null ? a.start_y : a.y;
                var ex = a.end_x != null ? a.end_x : a.destination_x, ey = a.end_y != null ? a.end_y : a.destination_y;
                return [{ type: 'swipe', x1: rel(sx), y1: rel(sy), x2: rel(ex), y2: rel(ey), duration_ms: 500, say: say || '拖曳' }];
            }
            case 'scroll': case 'scroll_at': case 'scroll_document': {
                var x = a.x != null ? clamp01(a.x) : 0.5, y = a.y != null ? clamp01(a.y) : 0.5;
                var px = Number(a.magnitude_in_pixels || a.magnitude || 300);
                var d = Math.max(0.1, Math.min(0.7, (px > 999 ? 999 : px) / (a.magnitude_in_pixels ? 1200 : 1000) * 0.6));   // 約略換算成螢幕比例
                var dir = String(a.direction || 'down').toLowerCase();
                // 「往下捲」＝內容往上走＝手指由下往上滑
                var x1 = x, y1 = y, x2 = x, y2 = y;
                if (dir === 'down') { y1 = Math.min(0.9, y + d / 2); y2 = Math.max(0.1, y - d / 2); }
                else if (dir === 'up') { y1 = Math.max(0.1, y - d / 2); y2 = Math.min(0.9, y + d / 2); }
                else if (dir === 'right') { x1 = Math.min(0.9, x + d / 2); x2 = Math.max(0.1, x - d / 2); }
                else { x1 = Math.max(0.1, x - d / 2); x2 = Math.min(0.9, x + d / 2); }
                return [{ type: 'swipe', x1: r3(x1), y1: r3(y1), x2: r3(x2), y2: r3(y2), duration_ms: 350, say: say || ('捲動（' + dir + '）') }];
            }
            case 'go_back': return [{ type: 'key', key: 'back', say: say || '返回' }];
            case 'press_home': return [{ type: 'key', key: 'home', say: '回到主畫面' }];
            case 'press_key': case 'key_combination': case 'hotkey': {
                var k = String(a.key || (Array.isArray(a.keys) ? a.keys.join('+') : a.keys) || '').toLowerCase();
                if (/enter|return/.test(k)) return [{ type: 'key', key: 'enter', say: say || 'Enter' }];
                if (/back|escape|esc/.test(k)) return [{ type: 'key', key: 'back', say: say || '返回' }];
                if (/home/.test(k)) return [{ type: 'key', key: 'home', say: say || 'Home' }];
                return [{ type: 'wait', ms: 300, say: '（不支援的按鍵 ' + k + '，已略過）' }];
            }
            case 'wait': case 'wait_5_seconds': return [{ type: 'wait', ms: Math.round((Number(a.seconds) || (n === 'wait_5_seconds' ? 5 : 1)) * 1000), say: '等待畫面載入' }];
            case 'open_url': return [{ type: 'open_url', url: String(a.url || ''), say: say || '開啟網址' }];
            case 'task_done': return [{ type: 'done', say: a.summary || '任務完成' }];
            case 'task_fail': return [{ type: 'fail', say: a.reason || '任務無法完成' }];
            case 'take_screenshot': return [{ type: 'wait', ms: 300, say: '重新擷取畫面' }];
            default: return null;
        }
    }

    // ── open_app 名稱解析 ──
    async function listInstalled(deps) {
        if (ST.apps) return ST.apps;
        var out = '';
        try { out = String(await deps.shell('pm list packages')); } catch (e) { out = ''; }
        ST.apps = out.split(/\s+/).map(function (l) { return l.replace(/^package:/, '').trim(); }).filter(function (p) { return /^[a-z][\w.]+$/i.test(p); });
        return ST.apps;
    }
    async function resolveApp(name, deps) {
        var key = String(name || '').trim().toLowerCase();
        var apps = await listInstalled(deps);
        var has = function (p) { return !apps.length || apps.indexOf(p) >= 0; };
        if (/^[a-z][\w]*(\.[\w]+)+$/i.test(key) && has(key)) return { pkg: key };
        if (ALIASES[key] && has(ALIASES[key])) return { pkg: ALIASES[key] };
        var cands = apps.filter(function (p) { return p.toLowerCase().indexOf(key.replace(/\s+/g, '')) >= 0; });
        if (cands.length === 1) return { pkg: cands[0] };
        return { error: cands.length ? '找到多個可能的套件：' + cands.slice(0, 8).join(', ') + '。請改用 open_app 搭配更精確的名稱，或從主畫面點選。' : '找不到名稱「' + name + '」對應的已安裝 App；請回到主畫面用畫面上的圖示開啟。', cands: cands };
    }

    // ── 回應解析（寬鬆） ──
    function collectCalls(data) {
        var calls = [];
        (function walk(o, depth) {
            if (!o || depth > 6) return;
            if (Array.isArray(o)) { o.forEach(function (x) { walk(x, depth + 1); }); return; }
            if (typeof o !== 'object') return;
            if ((o.type === 'function_call' || o.functionCall) ) {
                var c = o.functionCall || o;
                calls.push({ id: o.id || o.call_id || c.id || c.call_id || null, name: c.name, arguments: c.arguments || c.args || {} });
                return;
            }
            ['steps', 'outputs', 'content', 'parts'].forEach(function (k) { if (o[k]) walk(o[k], depth + 1); });
        })(data, 0);
        return calls;
    }
    function collectText(data) {
        var t = [];
        (function walk(o, d) {
            if (!o || d > 6) return;
            if (Array.isArray(o)) return o.forEach(function (x) { walk(x, d + 1); });
            if (typeof o !== 'object') return;
            if ((o.type === 'text' || o.type === 'output_text') && typeof o.text === 'string') t.push(o.text);
            ['steps', 'outputs', 'content', 'parts'].forEach(function (k) { if (o[k]) walk(o[k], d + 1); });
        })(data, 0);
        return t.join('\n').trim();
    }

    function reset() { ST.interactionId = null; ST.pending = []; ST.awaiting = []; ST.extra = []; ST.apps = null; }

    async function post(ctx, body) {
        var f = ctx.fetchImpl || fetch;
        var res = await f(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ctx.apiKey }, body: JSON.stringify(body) });
        var raw = await res.text(); var data = null; try { data = JSON.parse(raw); } catch (e) { data = null; }
        if (!res.ok) { var er = new Error('Computer Use 呼叫失敗 HTTP ' + res.status + '：' + ((data && data.error && data.error.message) || raw.slice(0, 200))); er.status = res.status; throw er; }
        return data || {};
    }

    var SYS = '你正在操作一支 Android 手機，目標是完成使用者交辦的任務。每回合你會看到最新的手機截圖。' +
        '請用 computer_use 的動作（click、type、scroll、drag_and_drop、long_press、go_back、wait 等）一步一步操作；要開 App 請先 press_home 再點圖示，或直接用 open_url 開網址。' +
        '輸入文字請用 type 並附上輸入框座標（會先點選再貼上）。只有在最新截圖裡親眼看到完成證據時才呼叫 task_done；確定無法完成才呼叫 task_fail。每次只做一個動作。';

    // 回傳「引擎動作」；佇列有東西時不呼叫 API
    async function decide(ctx) {
        var deps = ctx.deps || {};
        if (ctx.goal !== ST.lastGoal || (ctx.history && ctx.history.length === 0 && ST.interactionId && !ST.pending.length && !ST.awaiting.length)) { if (ctx.goal !== ST.lastGoal) reset(); ST.lastGoal = ctx.goal; }
        if (ST.pending.length) return ST.pending.shift();

        var img = { type: 'image', data: ctx.screenshotB64, mime_type: 'image/jpeg' };
        var lastRes = ctx.history && ctx.history.length ? ctx.history[ctx.history.length - 1] : null;
        var body;
        if (!ST.interactionId || !ST.awaiting.length) {
            body = { model: ctx.model, input: [{ type: 'text', text: SYS + '\n\n任務：' + ctx.goal + (lastRes && ST.interactionId ? '\n（上一步結果：' + String(lastRes.result || '').slice(0, 200) + '）' : '') }, img], tools: tools() };
            if (ST.interactionId) body.previous_interaction_id = ST.interactionId;
        } else {
            var failed = lastRes && /^FAILED/.test(String(lastRes.result || ''));
            var results = ST.awaiting.map(function (c, i) {
                var isLast = i === ST.awaiting.length - 1;
                var info = { status: failed && isLast ? 'failed' : 'ok', detail: isLast && lastRes ? String(lastRes.result || '').slice(0, 300) : '', app: ctx.fgApp || undefined };
                if (c.safetyAck) info.safety_acknowledgement = true;
                var res = [{ type: 'text', text: JSON.stringify(info) }];
                if (isLast) res.push(img);
                return { type: 'function_result', name: c.name, call_id: c.id, result: res };
            });
            body = { model: ctx.model, previous_interaction_id: ST.interactionId, input: ST.extra.concat(results), tools: tools() };
            ST.extra = [];
        }
        ST.awaiting = [];

        for (var guard = 0; guard < 4; guard++) {
            var data = await post(ctx, body);
            if (data.id) ST.interactionId = data.id;
            var calls = collectCalls(data);
            if (!calls.length) {
                var txt = collectText(data);
                throw new Error('Computer Use 沒有回傳動作' + (txt ? '：' + txt.slice(0, 160) : ''));
            }
            // 內部處理：list_apps／open_app 先解析成套件名；解析失敗直接回報模型，不佔用引擎回合
            var internalResults = [], actions = [], keep = [];
            for (var i = 0; i < calls.length; i++) {
                var c = calls[i], a = c.arguments || {};
                var sd = a.safety_decision;
                if (sd && sd.decision && /block/i.test(sd.decision)) { actions.push({ type: 'fail', say: '安全機制擋下此動作：' + (sd.explanation || '') }); keep.push(c); break; }
                if (sd && sd.decision === 'require_confirmation') {
                    var ok = deps.confirm ? await deps.confirm('⚠️ AI 想執行需要你確認的動作：\n' + (sd.explanation || c.name) + '\n\n要允許嗎？') : false;
                    if (!ok) { actions.push({ type: 'fail', say: '使用者拒絕了需要確認的動作：' + (sd.explanation || c.name) }); keep.push(c); break; }
                    c.safetyAck = true;
                }
                if (c.name === 'list_apps') {
                    var apps = await listInstalled(deps);
                    internalResults.push({ type: 'function_result', name: c.name, call_id: c.id, result: [{ type: 'text', text: JSON.stringify({ apps: apps.slice(0, 120) }) }] });
                    continue;
                }
                if (c.name === 'open_app') {
                    var r = await resolveApp(a.app_name || a.package || a.name, deps);
                    if (r.error) { internalResults.push({ type: 'function_result', name: c.name, call_id: c.id, result: [{ type: 'text', text: JSON.stringify({ status: 'failed', detail: r.error }) }] }); continue; }
                    actions.push({ type: 'open_app', package: r.pkg, say: a.intent || ('開啟 ' + (a.app_name || r.pkg)) }); keep.push(c); continue;
                }
                var m = mapCall(c, ctx);
                if (!m) { internalResults.push({ type: 'function_result', name: c.name, call_id: c.id, result: [{ type: 'text', text: JSON.stringify({ status: 'failed', detail: '不支援的動作 ' + c.name }) }] }); continue; }
                Array.prototype.push.apply(actions, m); keep.push(c);
            }
            if (!actions.length && internalResults.length) {   // 全部是內部處理 → 把結果回給模型再問一次
                internalResults[internalResults.length - 1].result.push(img);
                body = { model: ctx.model, previous_interaction_id: ST.interactionId, input: internalResults, tools: tools() };
                continue;
            }
            if (!actions.length) throw new Error('Computer Use 回傳的動作都無法轉換');
            ST.awaiting = keep;
            ST.extra = internalResults;   // 同一回合已由內部處理的呼叫，結果要跟著下一次 function_result 一起送
            var first = actions.shift(); ST.pending = actions;
            return first;
        }
        throw new Error('Computer Use 內部處理超過上限');
    }

    window.NovaAutoCU = { decide: decide, reset: reset, mapCall: mapCall, collectCalls: collectCalls, tools: tools, _state: ST, ENDPOINT: ENDPOINT };
})();

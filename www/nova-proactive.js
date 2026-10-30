/* ═════════════════════════════════════════════════════════════════
   nova-proactive.js — AI 主動說話（針對單一對話，隨機時間、依前文與當下時間主動傳訊息）（跟 index.html 放同一個資料夾 www/）
   版本：v1.1.0
   版本紀錄：
   v1.1.0 - App v2.6.102。訊息數量可設定：每天則數改為輸入 1–12；新增 ctxHead（開頭設定 0/3/6/10/20 則）與 ctxRecent（最近 8/16/30/50/80 則）；總量上限 9000→24000 字。
   v1.0.0 - App v2.6.101。新功能（方案 B：到點由原生端自己呼叫 Gemini，沒開 App 也會響）。
            · 入口：對話記錄「⋮」選單 →「主動說話…」。每個對話各自設定：開關、每天約幾則、可說話的時段（時段外為安靜時間）、
              最短間隔、連續幾則沒回就暫停、補充指示（角色口吻等）；可「立即測試一則」；顯示通知權限／精確鬧鐘／電池限制狀態與最近錯誤。
            · 隨機時間在這裡算（makePlan，可單獨測試）：每天依設定抽時間，時段有權重（中午、晚上較高），維持最短間隔，
              預設一次排 3 天；預定時間用完就自己停（使用者很久沒開 App 不會一直打擾）。
            · 情境：把對話開頭 6 則（角色設定）＋最近 16 則（純文字、截斷）同步給原生端（SharedPreferences，App 私有）。
              原生端到點時自己帶入現在時間（週幾、早／午／晚）與「距離使用者上次發言」，讓 AI 依時間感知說話，不適合時回 [SKIP]。
            · 收件匣：原生端把產生的訊息存起來並發通知；使用者打開 App（或點通知）時取回，寫進對應對話（msg.proactive=true）。
            · 私密對話（NovaPrivate）不允許開啟（情境會存在原生端）。
   依賴：原生外掛 NovaProactive（NovaProactivePlugin.java，需重新打包 APK）、index.html 的 appState／addMessage／saveToDB／showToast／
         loadChatSession、nova-chatmenu.js 的 openChatItemMenu／_novaShowItemMenu。
   ═════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';
    var W = window, D = document;
    var K_CFG = 'nova_proactive_cfg', K_PLAN = 'nova_proactive_plan', K_LASTUSER = 'nova_proactive_lastuser', K_MODEL = 'nova_proactive_model';
    var DEFAULTS = { enabled: false, perDay: 3, start: '09:00', end: '22:00', minGap: 90, maxUnanswered: 3, ctxHead: 6, ctxRecent: 16, extra: '' };
    var PLAN_DAYS = 3;

    function lsGet(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } }
    function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
    function plug() { return W.Capacitor && W.Capacitor.Plugins && W.Capacitor.Plugins.NovaProactive; }
    function toast(m) { try { if (typeof W.showToast === 'function') W.showToast(m); } catch (e) {} }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

    /* ───────── 設定 ───────── */
    function allCfg() { var o = lsGet(K_CFG, {}); return (o && typeof o === 'object') ? o : {}; }
    function getCfg(sid) { var c = allCfg()[sid] || {}; var r = {}; Object.keys(DEFAULTS).forEach(function (k) { r[k] = c[k] === undefined ? DEFAULTS[k] : c[k]; }); return r; }
    function setCfg(sid, c) { var o = allCfg(); o[sid] = c; lsSet(K_CFG, o); }
    function modelId() {
        var m = lsGet(K_MODEL, 'default');
        if (m === 'lite') return W.NOVA_GEMINI_MODEL_LITE || 'gemini-3.5-flash-lite';
        return W.NOVA_GEMINI_MODEL_DEFAULT || 'gemini-3.6-flash';
    }

    /* ───────── 隨機時間表（純函式，可測試） ───────── */
    function hm(str, fb) { var m = /^(\d{1,2}):(\d{2})$/.exec(String(str || '')); if (!m) return fb; return Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]); }
    // 一天裡各時間的抽中權重：中午與晚上較高，其餘偏低
    function weight(min) {
        var h = min / 60;
        if (h >= 19 && h < 22) return 1.6;
        if (h >= 11.5 && h < 13.5) return 1.3;
        if (h >= 7 && h < 9.5) return 1.0;
        if (h >= 17 && h < 19) return 1.0;
        return 0.6;
    }
    function pickMinute(s, e, rng) {
        var tot = 0, i, w = [];
        for (i = s; i < e; i++) { var x = weight(i % 1440); w.push(x); tot += x; }
        var r = rng() * tot;
        for (i = 0; i < w.length; i++) { r -= w[i]; if (r <= 0) return s + i; }
        return e - 1;
    }
    /**
     * @param cfg  {perDay, start, end, minGap}
     * @param now  毫秒
     * @param days 排幾天（含今天）
     * @param rng  亂數函式（測試時可傳固定的）
     * @param sentToday 今天已經主動說過幾則（今天只補不足的）
     */
    function makePlan(cfg, now, days, rng, sentToday) {
        rng = rng || Math.random;
        var s = hm(cfg.start, 540), e = hm(cfg.end, 1320);
        if (e <= s) e += 1440;
        var gap = Math.max(10, +cfg.minGap || 90) * 60000, perDay = Math.max(1, Math.min(12, +cfg.perDay || 3));
        var out = [], d0 = new Date(now); d0.setHours(0, 0, 0, 0);
        for (var d = 0; d < days; d++) {
            var base = new Date(d0.getTime()); base.setDate(base.getDate() + d);
            var n = perDay + (rng() < 0.2 ? -1 : (rng() > 0.8 ? 1 : 0));
            n = Math.max(1, n);
            if (d === 0) n = Math.max(0, n - (sentToday || 0));
            var chosen = [], tries = 0;
            while (chosen.length < n && tries++ < 300) {
                var at = base.getTime() + pickMinute(s, e, rng) * 60000 + Math.floor(rng() * 60000);
                if (at < now + 10 * 60000) continue;
                var ok = true, all = out.concat(chosen);
                for (var j = 0; j < all.length; j++) if (Math.abs(all[j] - at) < gap) { ok = false; break; }
                if (ok) chosen.push(at);
            }
            out = out.concat(chosen);
        }
        out.sort(function (a, b) { return a - b; });
        return out;
    }
    function sigOf(c) { return [c.perDay, c.start, c.end, c.minGap].join('|'); }
    function sentTodayOf(sid) {
        var d0 = new Date(); d0.setHours(0, 0, 0, 0); var t0 = d0.getTime(), n = 0;
        (W.appState && appState.messages || []).forEach(function (m) { if (String(m.sessionId) === String(sid) && m.proactive && (m.proactiveTs || 0) >= t0) n++; });
        return n;
    }
    function ensurePlan(sid, c) {
        var all = lsGet(K_PLAN, {}), p = all[sid], now = Date.now(), sig = sigOf(c);
        var future = p && Array.isArray(p.plan) ? p.plan.filter(function (t) { return t > now - 20 * 60000; }) : [];
        var covered = future.length ? future[future.length - 1] : 0;
        if (!p || p.sig !== sig || covered < now + 24 * 3600000) {
            future = makePlan(c, now, PLAN_DAYS, Math.random, sentTodayOf(sid));
            all[sid] = { sig: sig, plan: future, builtAt: now };
            lsSet(K_PLAN, all);
        }
        return future;
    }

    /* ───────── 情境（對話內容摘要） ───────── */
    function cleanText(t) {
        t = String(t == null ? '' : t);
        t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '[圖片]').replace(/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+\/=]+/gi, '[檔案]').replace(/```[\s\S]*?```/g, '[程式碼]').replace(/\s+/g, ' ').trim();
        return t.length > 600 ? t.slice(0, 600) + '…' : t;
    }
    function buildContext(sid, headN, recentN) {
        headN = Math.max(0, Math.min(40, headN == null ? 6 : +headN)); recentN = Math.max(2, Math.min(100, recentN == null ? 16 : +recentN));
        var ms = (W.appState && appState.messages || []).filter(function (m) { return String(m.sessionId) === String(sid) && (m.sender === 'user' || m.sender === 'ai') && m.text; });
        var head = ms.slice(0, headN), tail = ms.slice(Math.max(headN, ms.length - recentN)), seen = {}, out = [], total = 0;
        head.concat(tail).forEach(function (m) {
            var key = m.id || (m.sender + m.text.slice(0, 20));
            if (seen[key]) return; seen[key] = 1;
            var t = cleanText(m.text); if (!t) return;
            out.push({ r: m.sender === 'user' ? 'u' : 'a', t: t });
        });
        // 總量上限：從最舊（但保留開頭設定）之後開始丟
        for (var i = 0; i < out.length; i++) total += out[i].t.length;
        var keepHead = Math.min(headN, out.length - 1);
        while (total > 24000 && out.length > keepHead + 2) { var rm = out.splice(keepHead, 1)[0]; total -= rm.t.length; }   // 太長就從「開頭設定」之後最舊的開始丟
        return out;
    }
    function titleOf(sid) {
        var t = W.appState && appState.chatTitles && appState.chatTitles[sid];
        if (t) return t;
        var m = (W.appState && appState.messages || []).filter(function (x) { return String(x.sessionId) === String(sid) && x.sender === 'user' && x.text; })[0];
        return m ? cleanText(m.text).slice(0, 20) : 'NOVA';
    }
    function isPrivate(sid) { try { return !!(W.NovaPrivate && NovaPrivate.isPrivate && NovaPrivate.isPrivate(String(sid))); } catch (e) { return false; } }

    /* ───────── 同步給原生端 ───────── */
    var syncTimer = null, syncing = false;
    function scheduleSync(ms) { clearTimeout(syncTimer); syncTimer = setTimeout(sync, ms == null ? 4000 : ms); }
    async function sync() {
        var P = plug(); if (!P || syncing) return null;
        syncing = true;
        try {
            var cfgs = allCfg(), sessions = {}, lastUser = lsGet(K_LASTUSER, {});
            Object.keys(cfgs).forEach(function (sid) {
                var c = getCfg(sid);
                if (!c.enabled || isPrivate(sid)) return;
                sessions[sid] = {
                    title: titleOf(sid), extra: String(c.extra || '').slice(0, 800), maxUnanswered: +c.maxUnanswered || 3,
                    lastUserTs: lastUser[sid] || 0, context: buildContext(sid, c.ctxHead, c.ctxRecent), plan: ensurePlan(sid, c)
                };
            });
            var key = (W.appState && appState.keys && appState.keys.gemini) || '';
            return await P.configure({ config: { apiKey: key, model: modelId(), sessions: sessions } });
        } catch (e) {
            console.warn('[NOVA][主動說話] 同步失敗：', e && e.message || e);
            return null;
        } finally { syncing = false; }
    }

    /* ───────── 取回收件匣 ───────── */
    async function pull() {
        var P = plug(); if (!P) return 0;
        if (!(W.appState && appState.messages && appState.messages.length)) return -1;   // 對話還沒從資料庫載入完：先不取（取走收件匣就清空了，載入前取會把訊息弄丟）
        var n = 0;
        try {
            var r = await P.pull();
            (r && r.items || []).forEach(function (it) {
                if (!it || !it.text || !it.sid) return;
                var sid = String(it.sid);
                if (!(appState.messages || []).some(function (m) { return String(m.sessionId) === sid; })) return;   // 對話已被刪除
                W.addMessage(it.text, 'ai', appState.currentModel, [], null, null, sid);
                var msg = appState.messages[appState.messages.length - 1];
                if (msg) { msg.proactive = true; msg.proactiveTs = it.ts || Date.now(); try { saveToDB('messages', msg); } catch (e) {} }
                n++;
            });
            if (r && r.openSession && typeof W.loadChatSession === 'function' && String(appState.currentSessionId) !== String(r.openSession)) {
                W.loadChatSession(r.openSession);
            }
        } catch (e) { console.warn('[NOVA][主動說話] 取回失敗：', e && e.message || e); }
        if (n) scheduleSync(1500);
        return n;
    }

    /* ───────── 對話事件：記下使用者發言時間、觸發同步 ───────── */
    function hookAddMessage() {
        if (W.__novaProactiveAddHooked || typeof W.addMessage !== 'function') return false;
        W.__novaProactiveAddHooked = true;
        var orig = W.addMessage;
        W.addMessage = function (text, sender, model, sources, files, actionData, sessionId) {
            var r = orig.apply(this, arguments);
            try {
                var sid = String(sessionId || (W.appState && appState.currentSessionId) || '');
                var c = allCfg()[sid];
                if (sender === 'user' && sid) { var lu = lsGet(K_LASTUSER, {}); lu[sid] = Date.now(); lsSet(K_LASTUSER, lu); }
                if (c && c.enabled) scheduleSync(sender === 'user' ? 4000 : 8000);
            } catch (e) {}
            return r;
        };
        return true;
    }

    /* ───────── 設定畫面 ───────── */
    function row(label, inner, hint) {
        return '<div style="margin-bottom:10px;"><div style="font-size:11px;font-weight:700;color:#e2e8f0;margin-bottom:3px;">' + label + '</div>' + inner +
            (hint ? '<div style="font-size:10px;color:#94a3b8;margin-top:2px;">' + hint + '</div>' : '') + '</div>';
    }
    var SEL = 'width:100%;background:#1e293b;border:1px solid #334155;color:#e2e8f0;font-size:12px;border-radius:6px;padding:5px 8px;';
    function opts(list, cur) { return list.map(function (o) { return '<option value="' + o[0] + '"' + (String(o[0]) === String(cur) ? ' selected' : '') + '>' + o[1] + '</option>'; }).join(''); }
    function fmt(ts) { var d = new Date(ts), p = function (n) { return n < 10 ? '0' + n : n; }; return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); }

    async function fillStatus(sid, box) {
        var P = plug();
        if (!P) { box.innerHTML = '<span style="color:#fbbf24;">⚠️ 這個版本的 App 還沒有原生支援，需要重新打包 APK 才能使用。</span>'; return; }
        try {
            var st = await P.status(), lines = [];
            var s = (st.state && st.state[sid]) || {};
            lines.push(st.notifications ? '✅ 通知權限已開啟' : '⚠️ 通知權限未開啟 <button data-act="notif" style="margin-left:4px;" class="np-btn">要求權限</button>');
            lines.push(st.exactAlarm ? '✅ 精確鬧鐘已允許' : '⚠️ 精確鬧鐘未允許（時間可能晚幾分鐘） <button data-act="exact" class="np-btn">開啟設定</button>');
            lines.push(st.batteryUnrestricted ? '✅ 電池不受限制' : '⚠️ 電池可能被限制（手機休眠時可能收不到） <button data-act="battery" class="np-btn">開啟設定</button>');
            lines.push(st.next ? ('⏰ 下一則預定：' + fmt(st.next)) : '⏰ 目前沒有預定的時間（儲存設定後會排程）');
            if (s.sentUnanswered) lines.push('💤 已連續 ' + s.sentUnanswered + ' 則未回應（達上限會暫停，你發言後恢復）');
            if (s.lastError) lines.push('<span style="color:#f87171;">❌ 最近錯誤：' + esc(String(s.lastError).replace(/ @\d+$/, '')) + '</span>');
            box.innerHTML = lines.join('<br>');
            Array.prototype.forEach.call(box.querySelectorAll('button[data-act]'), function (b) {
                b.style.cssText = 'padding:1px 6px;font-size:10px;background:#334155;color:#fff;border-radius:4px;';
                b.onclick = async function () {
                    var a = b.getAttribute('data-act');
                    try {
                        if (a === 'notif') { var LN = W.Capacitor.Plugins.LocalNotifications; if (LN) await LN.requestPermissions(); }
                        else if (a === 'exact') await P.requestExactAlarm();
                        else if (a === 'battery') await P.openBatterySettings();
                    } catch (e) { toast('❌ ' + (e.message || e)); }
                    setTimeout(function () { fillStatus(sid, box); }, 1200);
                };
            });
        } catch (e) { box.textContent = '讀取狀態失敗：' + (e.message || e); }
    }

    function openModal(sid) {
        sid = String(sid);
        if (isPrivate(sid)) { toast('🔒 私密對話不能開啟主動說話（情境會存在原生端）'); return; }
        var old = D.getElementById('nova-proactive-modal'); if (old) old.remove();
        var c = getCfg(sid);
        var ov = D.createElement('div'); ov.id = 'nova-proactive-modal';
        ov.style.cssText = 'position:fixed;inset:0;z-index:1000000;background:rgba(2,6,23,.75);display:flex;align-items:center;justify-content:center;padding:12px;';
        var gap = [[30, '30 分鐘'], [60, '1 小時'], [90, '1.5 小時'], [120, '2 小時'], [180, '3 小時'], [240, '4 小時']];
        var headL = [[0, '不帶'], [3, '3 則'], [6, '6 則'], [10, '10 則'], [20, '20 則']];
        var recL = [[8, '8 則'], [16, '16 則'], [30, '30 則'], [50, '50 則'], [80, '80 則']];
        var maxUn = [[1, '1 則'], [2, '2 則'], [3, '3 則'], [5, '5 則']];
        ov.innerHTML = '<div style="width:100%;max-width:420px;max-height:92vh;overflow:auto;background:#0f172a;border:1px solid #334155;border-radius:12px;padding:14px;color:#e2e8f0;">' +
            '<div style="font-size:14px;font-weight:800;margin-bottom:2px;">💬 主動說話</div>' +
            '<div style="font-size:10px;color:#94a3b8;margin-bottom:10px;">對話：' + esc(titleOf(sid)) + '。AI 會在隨機時間依前文與現在的時間主動傳訊息給你，沒開 App 也會用通知提醒。</div>' +
            '<label style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:700;margin-bottom:10px;"><input id="np-en" type="checkbox"' + (c.enabled ? ' checked' : '') + ' style="accent-color:#10b981;"> 對這個對話開啟</label>' +
            row('每天大約幾則（最多 12）', '<input id="np-per" type="number" min="1" max="12" value="' + esc(c.perDay) + '" style="' + SEL + '">', '實際每天會有些許浮動；越多越花 Gemini 費用') +
            row('可說話的時段', '<div style="display:flex;gap:6px;align-items:center;"><input id="np-st" type="time" value="' + esc(c.start) + '" style="' + SEL + '"> ～ <input id="np-ed" type="time" value="' + esc(c.end) + '" style="' + SEL + '"></div>', '時段以外是安靜時間，不會打擾') +
            row('兩則之間至少隔', '<select id="np-gap" style="' + SEL + '">' + opts(gap, c.minGap) + '</select>') +
            row('連續幾則沒回就暫停', '<select id="np-un" style="' + SEL + '">' + opts(maxUn, c.maxUnanswered) + '</select>', '你再發言一次就會恢復') +
            row('使用的模型', '<select id="np-model" style="' + SEL + '">' + opts([['default', '標準（品質較好）'], ['lite', '省錢（Flash-Lite）']], lsGet(K_MODEL, 'default')) + '</select>', '每則主動訊息會呼叫一次，費用算在你的 Gemini 金鑰') +
            row('帶給 AI 的對話：開頭設定', '<select id="np-head" style="' + SEL + '">' + opts(headL, c.ctxHead) + '</select>', '對話最前面的幾則（通常是角色設定），一定會帶') +
            row('帶給 AI 的對話：最近幾則', '<select id="np-rec" style="' + SEL + '">' + opts(recL, c.ctxRecent) + '</select>', '越多越能接上前文，但每次呼叫越貴；總量上限約 24000 字') +
            row('補充指示（選填）', '<textarea id="np-ex" rows="3" placeholder="例如：口吻再撒嬌一點、不要提到工作" style="' + SEL + 'resize:vertical;">' + esc(c.extra) + '</textarea>') +
            '<div id="np-status" style="font-size:11px;color:#cbd5e1;background:#1e293b;border-radius:8px;padding:8px;margin-bottom:10px;line-height:1.7;">讀取狀態中…</div>' +
            '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
            '<button id="np-save" style="flex:1;padding:7px;background:#059669;color:#fff;border-radius:8px;font-size:12px;font-weight:700;">儲存</button>' +
            '<button id="np-test" style="padding:7px 10px;background:#1d4ed8;color:#fff;border-radius:8px;font-size:12px;">立即測試一則</button>' +
            '<button id="np-cancel" style="padding:7px 10px;background:#334155;color:#fff;border-radius:8px;font-size:12px;">關閉</button></div></div>';
        D.body.appendChild(ov);
        var $ = function (id) { return D.getElementById(id); };
        function collect() {
            return {
                enabled: $('np-en').checked, perDay: Math.max(1, Math.min(12, Math.round(+$('np-per').value) || 3)), ctxHead: +$('np-head').value, ctxRecent: +$('np-rec').value, start: $('np-st').value || '09:00', end: $('np-ed').value || '22:00',
                minGap: +$('np-gap').value, maxUnanswered: +$('np-un').value, extra: $('np-ex').value.trim()
            };
        }
        async function save(quiet) {
            var nc = collect();
            if (nc.enabled && !(W.appState && appState.keys && appState.keys.gemini)) { toast('❌ 需要先在設定填入 Gemini 金鑰'); return false; }
            setCfg(sid, nc); lsSet(K_MODEL, $('np-model').value);
            var r = await sync();
            if (!quiet) toast(nc.enabled ? (r && r.next ? '✅ 已開啟，下一則約 ' + fmt(r.next) : '✅ 已儲存') : '已關閉這個對話的主動說話');
            fillStatus(sid, $('np-status'));
            return true;
        }
        $('np-save').onclick = async function () { if (await save(false)) ov.remove(); };
        $('np-cancel').onclick = function () { ov.remove(); };
        ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });
        $('np-test').onclick = async function () {
            var P = plug(); if (!P) { toast('❌ 需要重新打包 APK 才有原生支援'); return; }
            $('np-en').checked = true;
            if (!(await save(true))) return;
            var b = $('np-test'); b.disabled = true; var t0 = b.textContent; b.textContent = '產生中…';
            try {
                var r = await P.testNow({ sid: sid });
                if (r && r.sent) { toast('✅ 已送出一則，請看通知；也已寫進這個對話'); await pull(); }
                else toast('AI 判斷現在不適合打擾（回了 [SKIP]），可再試一次');
            } catch (e) { toast('❌ ' + (e && e.message || e), 6000); }
            b.disabled = false; b.textContent = t0;
            fillStatus(sid, $('np-status'));
        };
        fillStatus(sid, $('np-status'));
    }

    /* ───────── 掛進對話「⋮」選單 ───────── */
    function hookMenu() {
        if (W.__novaProactiveMenuHooked || typeof W.openChatItemMenu !== 'function' || typeof W._novaShowItemMenu !== 'function') return false;
        W.__novaProactiveMenuHooked = true;
        var origOpen = W.openChatItemMenu, origShow = W._novaShowItemMenu;
        W.openChatItemMenu = function (sid) { W.__novaProactiveSid = sid; try { return origOpen.apply(this, arguments); } finally { W.__novaProactiveSid = null; } };
        W._novaShowItemMenu = function (event, items) {
            var sid = W.__novaProactiveSid;
            if (sid && Array.isArray(items)) {
                var on = !!getCfg(String(sid)).enabled, at = items.length;
                for (var i = 0; i < items.length; i++) if (items[i] && items[i].danger) { at = i; break; }
                items = items.slice(0, at).concat([{ label: on ? '主動說話（已開啟）…' : '主動說話…', icon: 'ph-bold ph-chat-circle-dots', onClick: function () { openModal(sid); } }], items.slice(at));
            }
            return origShow.call(this, event, items);
        };
        return true;
    }

    /* ───────── 啟動 ───────── */
    function boot(n) {
        n = n || 0;
        var a = hookAddMessage(), b = hookMenu();
        if ((!a || !b) && n < 60) { setTimeout(function () { boot(n + 1); }, 500); return; }
        (function first(k) {   // 等對話載入完再取回收件匣（最久約 40 秒）
            setTimeout(function () { pull().then(function (r) { if (r === -1 && k < 20) first(k + 1); else scheduleSync(500); }); }, k === 0 ? 2500 : 2000);
        })(0);
        D.addEventListener('visibilitychange', function () {
            if (D.hidden) { clearTimeout(syncTimer); sync(); }
            else pull();
        });
        W.addEventListener('pagehide', function () { sync(); });
        try {
            var App = W.Capacitor && W.Capacitor.Plugins && W.Capacitor.Plugins.App;
            if (App && App.addListener) App.addListener('appStateChange', function (s) { if (s && s.isActive) pull(); else sync(); });
        } catch (e) {}
    }

    W.NovaProactiveJS = { makePlan: makePlan, buildContext: buildContext, openModal: openModal, sync: sync, pull: pull, getCfg: getCfg, version: '1.1.0' };
    if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', function () { boot(0); }); else boot(0);
})();

/* ═════════════════════════════════════════════════════════════════
   nova-autoreport.js — 自主任務的「結束處理」：token 用量統計、提示詞明確快取、完成／失敗時跳回 NOVA（跟 index.html 放同一個資料夾 www/）
   版本：v1.1.0
   版本紀錄：
   v1.1.0 - App v2.6.104。任務結束自動輸出執行 log 檔（對標桌面版 v3.31.40「匯出執行紀錄」，格式沿用 schema 'nova-autonomous-run'）：存到 Documents/NOVA_AutoRun/NOVA_AutoRun_<目標>_<時間>.json（不彈分享視窗，避免蓋掉跳回 NOVA）；
            內容＝目標／狀態／起訖與耗時／設定快照／統計／steps（任務期間對話區出現的每一則系統訊息，含時間與距上一步秒數）／actions（每回合 AI 的完整動作與執行結果）／codeOutputs（run_python 程式碼、run_shell 指令）／usage（逐次呼叫的 tokens 與是否用快取）／cache。
            不含截圖與金鑰。設定頁新增「自動存 log 檔」開關（nova_auto_log_file，預設開）與「匯出上次任務 log」按鈕（會開分享）；上一次的 log 另存 localStorage nova_auto_lastrun_log（超過 1.5MB 不存）。
   v1.0.0 - App v2.6.103。對標桌面版 v3.31.63～65 的自主任務用量與明確快取，並新增「結束時一定要叫回 NOVA」。
            ① 用量統計：任務執行期間，在 fetch 這一層統一記下所有 Gemini 回應的 usageMetadata（規劃、每回合判斷、聯網搜尋都算，不必逐處改）；
               任務結束在對話區印一行「📊 這次自主任務用量」：呼叫次數、輸入（含快取命中與百分比）、輸出、思考、合計、估算費用
               （只有 Gemini 3.6／3.7／3.8 Flash 有價格資料，其他模型只列 tokens），並附明確快取的建立次數與估算儲存費。最近 30 次存 localStorage 'nova_auto_usage_history'。
               Computer Use 判斷器走 Interactions API，回應的 usage 欄位格式文件沒有完整範例，採寬鬆解析（total_input_tokens／total_cached_tokens…）；讀不到就不計入並註明。
            ② 明確快取（只用在「提示詞＋元件清單」判斷器）：從任務的第 3 次判斷起，把每回合都相同的固定規則前綴建成 Gemini cachedContents（放在 systemInstruction），
               之後每回合只送「快取名稱＋歷史與元件清單＋截圖」。前綴不足 6000 字元、建立失敗或快取請求被拒都自動退回完整提示詞（失敗後 10 分鐘內不再嘗試）；任務結束主動刪除快取。
               Computer Use 判斷器的對話狀態由伺服器端保存（previous_interaction_id），不適用明確快取。
            ③ 結束時跳回 NOVA：完成或失敗／逾時／達回合上限／錯誤中止時，先用執行器的 shell 執行 am start 開啟 NOVA（不受背景啟動限制），
               還在背景就呼叫原生外掛 NovaProactive.bringToFront（直接開啟＋高優先通知，Android 14 以前帶全螢幕意圖）。使用者自己中斷的不跳。
            設定（設定頁自主任務區塊，皆預設開啟）：nova_auto_front／nova_auto_explicit_cache／nova_auto_usage_msg，值 '0' 為關閉；
            nova_auto_cache_start_round 可調整第幾次判斷開始快取（預設 3）。
   依賴：index.html 的 addMessage、自主任務引擎（run() 開頭呼叫 begin、結束呼叫 finish、decideNextAction 呼叫 NovaAutoCache.apply）、原生外掛 NovaProactive（可選）。
   ═════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';
    var W = window, D = document;
    var APP_PKG = 'com.kirishimatoka00.nova120';
    var ST = null;   // 目前進行中的任務：{ t0, goal, rows[], cacheLog[], judgeCalls, noted{} }

    function raw(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function on(k) { return raw(k) !== '0'; }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function say(text) { try { if (ST && typeof W.addMessage === 'function') { ST.muted = true; try { W.addMessage(text, 'system'); } finally { ST.muted = false; } } } catch (e) {} }
    // 任務期間對話區出現的系統／AI 訊息 = 執行紀錄的 steps（類似桌面版的「執行紀錄」時間軸）
    function stepType(t) {
        if (/^⚙️/.test(t)) return 'action'; if (/^✅ 第/.test(t)) return 'result'; if (/^✅ 自主任務完成/.test(t)) return 'done';
        if (/^⚠️ 自主任務無法繼續/.test(t)) return 'fail'; if (/^⚠️/.test(t)) return 'warn'; if (/^❌/.test(t)) return 'error'; if (/^⏱️/.test(t)) return 'timeout';
        if (/^⏸️/.test(t)) return 'skip'; if (/^🔁/.test(t)) return 'limit'; if (/^⏹/.test(t)) return 'cancel'; if (/^🧊/.test(t)) return 'cache'; if (/^⚡/.test(t)) return 'verify';
        if (/^🤖/.test(t)) return 'start'; return 'message';
    }
    function hookAddMessage() {
        if (W.__novaAutoReportAddHooked || typeof W.addMessage !== 'function') return false;
        W.__novaAutoReportAddHooked = true;
        var orig = W.addMessage;
        W.addMessage = function (text, sender) {
            try {
                if (ST && !ST.muted && (sender === 'system' || sender === 'ai') && typeof text === 'string') {
                    var m = /第\s*(\d+)\s*(?:\/\s*\d+\s*)?回合/.exec(text);
                    ST.steps.push({ time: Date.now(), sender: sender, type: stepType(text), round: m ? +m[1] : null, text: text.slice(0, 4000) });
                }
            } catch (e) {}
            return orig.apply(this, arguments);
        };
        return true;
    }
    function fmt(n) { return Number(n).toLocaleString('en-US'); }

    /* ───────── 價格（美元／百萬 tokens；與桌面版同一份資料） ─────────
       Google 官方價格頁（2026-09）：Gemini 3.6／3.7／3.8 Flash 優惠價 $0.75 輸入、$3.75 輸出（含思考）、快取命中輸入 $0.075；
       優惠價到 2026-12-31，2027-01-01 起標準價為兩倍（下面自動換算）。沒列在這裡的模型只顯示 tokens、不估費用。 */
    var PRICES = {
        'gemini-3.8-flash': { inp: 0.75, out: 3.75, cached: 0.075 },
        'gemini-3.7-flash': { inp: 0.75, out: 3.75, cached: 0.075 },
        'gemini-3.6-flash': { inp: 0.75, out: 3.75, cached: 0.075 }
    };
    var STORAGE_USD_PER_M_HOUR = 4.50;   // 明確快取儲存費（官方價格頁的數字，只用於估算）
    function priceOf(model, now) {
        var p = PRICES[String(model || '').toLowerCase().replace(/^models\//, '')];
        if (!p) return null;
        var mult = (now == null ? Date.now() : now) >= Date.UTC(2027, 0, 1) ? 2 : 1;
        return { inp: p.inp * mult, out: p.out * mult, cached: p.cached * mult, standard: mult === 2 };
    }

    /* ───────── 用量記錄（fetch 統一攔截） ───────── */
    function normMeta(m) {
        var out = +m.candidatesTokenCount || 0, th = +m.thoughtsTokenCount || 0, total = +m.totalTokenCount || 0;
        var prompt = m.promptTokenCount != null ? (+m.promptTokenCount || 0) : Math.max(0, total - out - th);
        var cached = Math.min(+m.cachedContentTokenCount || 0, prompt);
        return { prompt: prompt, cached: cached, out: out, thoughts: th, total: total || (prompt + out + th) };
    }
    function normInteraction(u) {   // Interactions API（Computer Use）的 usage：欄位名稱依官方文件寬鬆解析
        var inp = +(u.total_input_tokens != null ? u.total_input_tokens : u.input_tokens) || 0;
        var out = +(u.total_output_tokens != null ? u.total_output_tokens : u.output_tokens) || 0;
        var th = +(u.total_thought_tokens != null ? u.total_thought_tokens : u.thought_tokens) || 0;
        var cached = Math.min(+(u.total_cached_tokens != null ? u.total_cached_tokens : u.cached_tokens) || 0, inp);
        var total = +(u.total_tokens != null ? u.total_tokens : 0) || (inp + out + th);
        return { prompt: inp, cached: cached, out: out, thoughts: th, total: total };
    }
    function record(st, data, model, viaCache) {
        var row = null;
        if (data && data.usageMetadata) row = normMeta(data.usageMetadata);
        else if (data && data.usage && typeof data.usage === 'object') row = normInteraction(data.usage);
        if (!row) { st.noUsage = (st.noUsage || 0) + 1; return; }
        row.model = model || ''; row.viaCache = !!viaCache;
        st.rows.push(row);
    }
    var RE = /generativelanguage\.googleapis\.com\/[^?]*\/(?:models\/([^\/:?]+):generateContent|interactions)/i;
    function patchFetch() {
        if (W.__novaAutoReportFetchPatched || typeof W.fetch !== 'function') return;
        W.__novaAutoReportFetchPatched = true;
        var orig = W.fetch;
        W.fetch = function (input, init) {
            var p = orig.apply(this, arguments);
            var st = ST;
            if (!st) return p;
            try {
                var url = typeof input === 'string' ? input : ((input && input.url) || '');
                var m = RE.exec(url);
                if (!m) return p;
                var model = m[1] || '', viaCache = false, body = init && typeof init.body === 'string' ? init.body : '';
                if (body) {
                    viaCache = body.indexOf('"cachedContent"') >= 0;
                    if (!model) { try { model = JSON.parse(body).model || ''; } catch (e) {} }
                }
                return p.then(function (res) {
                    try {
                        if (res && res.ok) {
                            var ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
                            if (!/event-stream/i.test(ct)) res.clone().json().then(function (d) { record(st, d, model, viaCache); }).catch(function () {});
                        }
                    } catch (e) {}
                    return res;
                });
            } catch (e) { return p; }
        };
    }

    function summary(st, now) {
        var rows = st.rows;
        if (!rows.length) return null;
        var sum = { prompt: 0, cached: 0, out: 0, thoughts: 0, total: 0 }, cost = 0, priced = true, standard = false;
        rows.forEach(function (r) {
            sum.prompt += r.prompt; sum.cached += r.cached; sum.out += r.out; sum.thoughts += r.thoughts; sum.total += r.total;
            var p = priceOf(r.model, now);
            if (!p) { priced = false; return; }
            standard = standard || p.standard;
            cost += ((r.prompt - r.cached) * p.inp + r.cached * p.cached + (r.out + r.thoughts) * p.out) / 1e6;
        });
        var createTok = 0, storageUsd = 0;
        st.cacheLog.forEach(function (c) {
            createTok += c.tokens || 0;
            var p = priceOf(c.model, now);
            if (p) cost += (c.tokens || 0) * p.inp / 1e6; else priced = false;
            storageUsd += (c.tokens || 0) * (Math.max(0, (c.releasedMs || now) - c.createdMs) / 3600000) * STORAGE_USD_PER_M_HOUR / 1e6;
        });
        if (priced) cost += storageUsd;
        sum.total += createTok;
        var pct = sum.prompt ? Math.round(sum.cached / sum.prompt * 100) : 0;
        var t = '📊 這次自主任務用量：' + rows.length + ' 次呼叫｜輸入 ' + fmt(sum.prompt) + '（快取命中 ' + fmt(sum.cached) + '，' + pct + '%）｜輸出 ' + fmt(sum.out) +
            '｜思考 ' + fmt(sum.thoughts) + '｜合計 ' + fmt(sum.total) + ' tokens';
        if (priced) t += '｜約 $' + cost.toFixed(4) + (standard ? '（標準價）' : '（優惠價，2027-01-01 起加倍）');
        else t += '｜（這個模型沒有價格資料，不估費用）';
        if (st.cacheLog.length) t += '\n🧊 明確快取：建立 ' + st.cacheLog.length + ' 次（共 ' + fmt(createTok) + ' tokens，按一般輸入價計費，已算進合計），估算儲存費 $' + storageUsd.toFixed(4) + '（實際以 Google 帳單為準）';
        else if (sum.prompt && !sum.cached) t += '\n（沒有任何快取命中）';
        if (st.noUsage) t += '\n（另有 ' + st.noUsage + ' 次回應沒有可讀的用量欄位，未計入）';
        return { text: t, sum: sum, cost: priced ? cost : null, calls: rows.length };
    }
    function storeHistory(st, s, status) {
        try {
            var h = JSON.parse(raw('nova_auto_usage_history') || '[]');
            h.push({ t: Date.now(), goal: String(st.goal || '').slice(0, 80), status: status, calls: s.calls, prompt: s.sum.prompt, cached: s.sum.cached, out: s.sum.out, thoughts: s.sum.thoughts, total: s.sum.total, cost: s.cost });
            localStorage.setItem('nova_auto_usage_history', JSON.stringify(h.slice(-30)));
        } catch (e) {}
    }

    /* ───────── 明確快取 ───────── */
    var CACHE_TTL = 720, CACHE_MIN_CHARS = 6000, CACHE_BLOCK_MS = 10 * 60000;
    var cacheReg = {}, cacheBlocked = {};
    function simpleHash(str) { var h = 0; for (var i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0; return 'h' + (h >>> 0).toString(36) + '_' + str.length; }
    function startCall() { var n = parseInt(raw('nova_auto_cache_start_round'), 10); return (n >= 1 && n <= 20) ? n : 3; }
    function noteOnce(key, text) { if (!ST) return; ST.noted = ST.noted || {}; if (ST.noted[key]) return; ST.noted[key] = 1; say(text); }

    async function getOrCreate(model, prefix, key) {
        var now = Date.now(), b = cacheBlocked[model];
        if (b && b.until > now) return null;
        var rk = model + '|' + simpleHash(prefix), reg = cacheReg[rk];
        if (reg && reg.expireAtMs - 60000 > now) return reg;
        var fail = function (msg) { cacheBlocked[model] = { until: now + CACHE_BLOCK_MS, reason: msg }; noteOnce('create_failed', '⚠️ 提示詞快取建立失敗（' + msg + '），這次任務改用完整提示詞，10 分鐘內不再嘗試。'); return null; };
        try {
            var ctl = new AbortController(), tid = setTimeout(function () { ctl.abort(); }, 25000), res, data;
            try {
                res = await fetch('https://generativelanguage.googleapis.com/v1beta/cachedContents?key=' + encodeURIComponent(key), {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal,
                    body: JSON.stringify({ model: 'models/' + model, systemInstruction: { parts: [{ text: prefix }] }, ttl: CACHE_TTL + 's' })
                });
                data = await res.json();
            } finally { clearTimeout(tid); }
            if (!res.ok || !data || !data.name) return fail(String((data && data.error && data.error.message) || ('HTTP ' + res.status)).slice(0, 120));
            var tokens = (data.usageMetadata && +data.usageMetadata.totalTokenCount) || 0;
            var entry = { name: data.name, expireAtMs: data.expireTime ? Date.parse(data.expireTime) : now + CACHE_TTL * 1000, tokens: tokens, createdMs: now, model: model };
            cacheReg[rk] = entry;
            if (ST) ST.cacheLog.push(entry);
            say('🧊 已建立提示詞快取（約 ' + fmt(tokens) + ' tokens），之後每回合的固定規則按快取價計費。');
            return entry;
        } catch (e) { return fail(String((e && e.message) || e).slice(0, 120)); }
    }
    function noteFailure(model, name, reason) {
        Object.keys(cacheReg).forEach(function (k) { if (cacheReg[k].name === name) delete cacheReg[k]; });
        cacheBlocked[model] = { until: Date.now() + CACHE_BLOCK_MS, reason: String(reason || '').slice(0, 160) };
        noteOnce('request_failed', '⚠️ 快取請求失敗（' + String(reason || '').slice(0, 100) + '），已改用完整提示詞重送。');
    }
    /**
     * 把「提示詞＋截圖」請求改成「快取名稱＋剩下的內容」。成功回傳 { name, restore, fail(reason) }；不適用或失敗回傳 null（呼叫端照原本的完整請求送）。
     * payload.contents 必須是單一 user 內容（第一段是整份提示詞文字，可再接截圖）。ctx = { model, key, prefix, full, image }
     */
    async function apply(payload, ctx) {
        try {
            if (!ST || !on('nova_auto_explicit_cache')) return null;
            ST.judgeCalls = (ST.judgeCalls || 0) + 1;
            if (ST.judgeCalls < startCall()) return null;
            var prefix = ctx.prefix, full = ctx.full;
            if (!prefix || prefix.length < CACHE_MIN_CHARS) { noteOnce('short', 'ℹ️ 固定規則前綴只有 ' + (prefix ? prefix.length : 0) + ' 字元（不足 ' + CACHE_MIN_CHARS + '），這次任務不使用提示詞快取。'); return null; }
            if (!ctx.key || /image|imagen/i.test(String(ctx.model || ''))) return null;
            if (payload.systemInstruction || payload.tools || payload.toolConfig || payload.cachedContent) return null;
            if (full.indexOf(prefix) !== 0 || full.length === prefix.length) return null;
            var entry = await getOrCreate(ctx.model, prefix, ctx.key);
            if (!entry) return null;
            var parts = [{ text: full.slice(prefix.length) }];
            if (ctx.image) parts.push({ inline_data: { mime_type: 'image/jpeg', data: ctx.image } });
            var original = payload.contents;
            payload.contents = [{ role: 'user', parts: parts }];
            payload.cachedContent = entry.name;
            return {
                name: entry.name,
                restore: function () { payload.contents = original; delete payload.cachedContent; },
                fail: function (reason) { noteFailure(ctx.model, entry.name, reason); }
            };
        } catch (e) { return null; }
    }
    async function releaseCaches(st, key) {
        var list = st.cacheLog.filter(function (c) { return !c.releasedMs; });
        for (var i = 0; i < list.length; i++) {
            var c = list[i];
            try {
                var ctl = new AbortController(), tid = setTimeout(function () { ctl.abort(); }, 4000);
                try { await fetch('https://generativelanguage.googleapis.com/v1beta/' + c.name + '?key=' + encodeURIComponent(key), { method: 'DELETE', signal: ctl.signal }); }
                finally { clearTimeout(tid); }
            } catch (e) { /* 刪不掉就等 TTL（12 分鐘）到期 */ }
            c.releasedMs = Date.now();
            Object.keys(cacheReg).forEach(function (k) { if (cacheReg[k].name === c.name) delete cacheReg[k]; });
        }
    }

    /* ───────── 執行 log 檔（對標桌面版 v3.31.40） ───────── */
    function clip(t, n) { t = String(t == null ? '' : t); return t.length > n ? t.slice(0, n) + '…（已截斷 ' + (t.length - n) + ' 字）' : t; }
    function buildRecord(st, ctx, sum) {
        var iso = function (ms) { return ms ? new Date(ms).toISOString() : null; };
        var end = Date.now(), prev = st.t0;
        var steps = st.steps.map(function (x, i) {
            var r = { index: i + 1, round: x.round, time: iso(x.time), elapsedSec: Math.round((x.time - prev) / 100) / 10, type: x.type, sender: x.sender, text: x.text };
            prev = x.time; return r;
        });
        var hist = (ctx && Array.isArray(ctx.history)) ? ctx.history : [];
        var actions = hist.map(function (h) {
            var a = h && h.action ? JSON.parse(JSON.stringify(h.action, function (k, v) { return typeof v === 'string' && v.length > 20000 ? v.slice(0, 20000) + '…' : v; })) : null;
            return { round: h.round, action: a, result: clip(h.result, 6000) };
        });
        var codeOutputs = [];
        hist.forEach(function (h) {
            var a = h && h.action; if (!a) return;
            if (a.type === 'run_python' && a.code) codeOutputs.push({ round: h.round, kind: 'python', code: clip(a.code, 20000), result: clip(h.result, 6000) });
            else if (a.type === 'run_shell' && a.cmd) codeOutputs.push({ round: h.round, kind: 'shell', code: clip(a.cmd, 20000), result: clip(h.result, 6000) });
        });
        var rounds = {}; steps.forEach(function (x) { if (x.round != null) rounds[x.round] = 1; });
        var as = (W.appState && W.appState.autoTaskSettings) || {};
        var ver = ''; try { ver = typeof NOVA_APP_VERSION !== 'undefined' ? NOVA_APP_VERSION : ''; } catch (e) {}
        return {
            schema: 'nova-autonomous-run', schemaVersion: 1, platform: 'android',
            exportedAt: iso(end), novaVersion: 'android ' + ver,
            session: { id: String((W.appState && W.appState.currentSessionId) || '') },
            goal: st.goal, status: ctx && ctx.status || '', finalStatusText: ctx && ctx.detail || '',
            startedAt: iso(st.t0), endedAt: iso(end), durationSec: Math.round((end - st.t0) / 1000),
            settings: { judge: as.judge, executor: as.executor, cuModel: as.cuModel, maxRounds: as.maxRounds, roundTimeoutSec: as.roundTimeoutSec, textFirst: as.textFirst, explicitCache: on('nova_auto_explicit_cache') },
            stats: { stepCount: steps.length, roundCount: Object.keys(rounds).length, actionCount: actions.length, errorSteps: steps.filter(function (x) { return x.type === 'error'; }).length,
                     warnSteps: steps.filter(function (x) { return x.type === 'warn'; }).length, longestStepSec: steps.reduce(function (m, x) { return Math.max(m, x.elapsedSec || 0); }, 0) },
            usageSummary: sum ? { calls: sum.calls, prompt: sum.sum.prompt, cached: sum.sum.cached, out: sum.sum.out, thoughts: sum.sum.thoughts, total: sum.sum.total, costUsd: sum.cost } : null,
            usage: st.rows.map(function (r) { return { model: r.model, prompt: r.prompt, cached: r.cached, out: r.out, thoughts: r.thoughts, viaCache: r.viaCache }; }),
            cache: st.cacheLog.map(function (c) { return { name: c.name, model: c.model, tokens: c.tokens, createdAt: iso(c.createdMs), releasedAt: iso(c.releasedMs) }; }),
            steps: steps, actions: actions, codeOutputs: codeOutputs,
            notes: [
                'steps：任務期間對話區出現的每一則系統／AI 訊息（⚙️ 動作、✅/⚠️ 結果、❌ 錯誤…），elapsedSec 是距離上一則的秒數（含等 AI 判斷的時間），用來找慢步驟。',
                'actions：每回合 AI 回傳的完整動作與執行結果（結果最多 6000 字元）；run_python／run_shell 的完整程式碼與指令另列在 codeOutputs。',
                'usage：每次 Gemini 呼叫的輸入／快取命中／輸出／思考 tokens；viaCache 為 true 但 cached 為 0 代表用了快取請求卻沒命中。Computer Use 判斷器的 usage 欄位格式為推測，讀不到的呼叫不會出現在這裡。',
                '截圖與 API 金鑰不放進這份檔案。每次任務一份檔案，不會互相覆蓋。'
            ]
        };
    }
    function logFileName(rec) {
        var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
        var stamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
        var slug = String(rec.goal || 'task').replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').replace(/\s+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'task';
        return 'NOVA_AutoRun_' + slug.replace(/[^a-zA-Z0-9._\-一-鿿]/g, '_') + '_' + stamp + '.json';
    }
    async function saveLog(rec) {
        var json = JSON.stringify(rec, null, 2), name = logFileName(rec);
        try { if (json.length < 1500000) localStorage.setItem('nova_auto_lastrun_log', json); } catch (e) {}
        var FS = W.Capacitor && W.Capacitor.Plugins && W.Capacitor.Plugins.Filesystem;
        if (!FS) return null;
        try {
            await FS.writeFile({ path: 'NOVA_AutoRun/' + name, data: json, directory: 'DOCUMENTS', encoding: 'utf8', recursive: true });
            return 'Documents/NOVA_AutoRun/' + name;
        } catch (e) { say('⚠️ 執行 log 檔儲存失敗：' + String((e && e.message) || e).slice(0, 120)); return null; }
    }
    async function exportLast() {
        var json = raw('nova_auto_lastrun_log');
        if (!json) { try { W.showToast('還沒有可匯出的任務 log（跑完一次自主任務後才會有）'); } catch (e) {} return false; }
        var name = 'NOVA_AutoRun_last_' + Date.now() + '.json';
        try { var rec = JSON.parse(json); name = logFileName(rec); } catch (e) {}
        if (typeof W._novaExportTextFile === 'function') return await W._novaExportTextFile(json, name, 'application/json');
        return false;
    }

    /* ───────── 跳回 NOVA ───────── */
    async function bringToFront(ctx, status) {
        if (!on('nova_auto_front') || status === 'cancelled') return;
        if (D.visibilityState === 'visible' && !D.hidden) return;   // 已在前景
        var ok = status === 'done';
        var title = ok ? '✅ NOVA 自主任務完成' : '⚠️ NOVA 自主任務未完成';
        var text = String(ctx.detail || (ok ? '任務已完成' : '任務失敗或中止')).replace(/\s+/g, ' ').slice(0, 140);
        if (ctx.goal) text = '「' + String(ctx.goal).slice(0, 30) + '」' + text;
        // 1) 用執行器的 shell 開 NOVA（shell 身分，不受背景啟動限制）
        if (typeof ctx.shell === 'function') {
            try { await Promise.race([ctx.shell('am start -n ' + APP_PKG + '/.MainActivity'), sleep(4000)]); } catch (e) {}
            await sleep(1200);
            if (D.visibilityState === 'visible' && !D.hidden) return;
        }
        // 2) 原生外掛：直接開啟＋通知（需要重新打包 APK 才有）
        var P = W.Capacitor && W.Capacitor.Plugins && W.Capacitor.Plugins.NovaProactive;
        if (P && P.bringToFront) { try { await P.bringToFront({ title: title, text: text }); } catch (e) {} }
    }

    /* ───────── 對外：任務開始／結束 ───────── */
    function begin(info) { ST = { t0: Date.now(), goal: info && info.goal || '', rows: [], cacheLog: [], judgeCalls: 0, noted: {}, steps: [] }; }
    async function finish(ctx) {
        var st = ST; if (!st) return;
        var key = (W.appState && W.appState.keys && W.appState.keys.gemini) || '';
        try {
            await sleep(400);   // 讓最後一次回應的 clone().json() 先處理完
            await releaseCaches(st, key);
            var s = summary(st, Date.now());
            if (s) {
                storeHistory(st, s, ctx && ctx.status);
                if (on('nova_auto_usage_msg')) say(s.text);
            }
            if (on('nova_auto_log_file')) {
                var rec = buildRecord(st, ctx || {}, s);
                var where = await saveLog(rec);
                if (where) say('📄 已輸出執行 log：' + where + '（' + rec.stats.stepCount + ' 個步驟、' + rec.stats.actionCount + ' 個動作）');
            }
        } catch (e) { /* 統計失敗不能影響任務 */ }
        try { await bringToFront(ctx || {}, ctx && ctx.status); } catch (e) {}
        ST = null;
    }

    /* ───────── 設定頁開關 ───────── */
    var TOGGLES = [
        ['nova_auto_front', '🔔 完成或失敗時自動跳回 NOVA', '你自己中斷的不會跳。Android 對背景開啟畫面限制很多，所以另外會發通知。'],
        ['nova_auto_usage_msg', '📊 任務結束顯示 token 用量', '在對話區印一行用量與估算費用。'],
        ['nova_auto_explicit_cache', '🧊 提示詞明確快取（提示詞判斷器）', '第 3 次判斷起把固定規則存成 Gemini 快取，省輸入費用；失敗會自動退回。Computer Use 判斷器不適用。'],
        ['nova_auto_log_file', '📄 任務結束自動輸出執行 log 檔', '存到 Documents/NOVA_AutoRun/，內容含每回合動作、結果、程式碼與 token 用量，不含截圖與金鑰。']
    ];
    function injectUi() {
        if (D.getElementById('nova-autoreport-box')) return true;
        var j = D.getElementById('autotask-judge'); if (!j) return false;
        var grid = j.closest ? j.closest('.grid') : null; if (!grid || !grid.parentNode) return false;
        var box = D.createElement('div'); box.id = 'nova-autoreport-box';
        box.className = 'bg-slate-900/60 border border-slate-700 rounded-lg p-2 space-y-1';
        box.innerHTML = TOGGLES.map(function (t, i) {
            return '<label class="flex items-start gap-2 text-[11px] text-slate-300"><input type="checkbox" data-k="' + t[0] + '" id="nar-' + i + '" style="margin-top:2px;accent-color:#10b981;"><span>' + t[1] + '<span class="block text-[10px] text-slate-500">' + t[2] + '</span></span></label>';
        }).join('');
        box.innerHTML += '<button id="nar-export" class="px-2 py-1 text-[10px] bg-blue-700 hover:bg-blue-600 text-white rounded-md">📤 匯出上次任務 log</button>';
        grid.parentNode.insertBefore(box, grid.nextSibling);
        var eb = D.getElementById('nar-export'); if (eb) eb.onclick = function () { exportLast(); };
        Array.prototype.forEach.call(box.querySelectorAll('input[data-k]'), function (c) {
            c.checked = on(c.getAttribute('data-k'));
            c.onchange = function () { try { localStorage.setItem(c.getAttribute('data-k'), c.checked ? '1' : '0'); } catch (e) {} };
        });
        return true;
    }
    function boot(n) { n = n || 0; if (!injectUi() && n < 60) setTimeout(function () { boot(n + 1); }, 700); }

    patchFetch();
    W.NovaAutoCache = { apply: apply, _reg: cacheReg };
    (function hk(n) { if (!hookAddMessage() && n < 60) setTimeout(function () { hk(n + 1); }, 500); })(0);
    W.NovaAutoReport = { begin: begin, finish: finish, exportLast: exportLast, _buildRecord: buildRecord, _summary: summary, _state: function () { return ST; }, version: '1.1.0' };
    if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', function () { boot(0); }); else boot(0);
})();

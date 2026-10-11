/* ═══════════════════════════════════════════════════════════════════════
   nova-dr-glue.js — NOVA Android「Pro 深度研究」接線層（跟 index.html 放同一個資料夾 www/）
   版本：v1.0.0
   版本紀錄：
   v1.0.0 - 初版（批次 6a）。引擎本體沿用 deep-research-engine.js（桌面版 v1.1.0 原樣移植）；這支檔案負責把引擎接到手機版 App，移植自桌面版 index.html 的
            「NOVA-PRO-RESEARCH-GLUE」（_novaDrBuildDeps／_novaStartProResearch／狀態面板），差異如下：
            ① 手機沒有 sidecar：Firecrawl（search／scrape）、SerpApi 直接由 App 發請求（CapacitorHttp 原生請求無 CORS）；讀網頁原始位元組用 CapacitorHttp（arraybuffer）。
            ② 模型呼叫共用 nova-llm.js 的 _novaDr* 輔助函式；Gemini 走 generateContent、gpt- 走 Responses API、Grok 走 Responses＋web_search／x_search。
            ③ 介面：全螢幕「Pro 深度研究」設定視窗（主題、深度、規劃／撰稿／審稿／讀取模型、搜尋策略、Firecrawl／Grok 開關、預估），
               進度面板貼在畫面上方（避開輸入列），可收合、停止、強制結束、回到研究對話。入口：「＋」選單 →「Pro研究」。
            ④ 報告貼回研究所在的對話（不走 addMessage，避免 Telegram 推播被長文洗版與餵進記憶摘要）；同時存成文件/ 資料夾的 .md（報告＋證據附錄）。
            ⑤ 研究期間鎖定該對話的輸入框；切到別的對話自動解鎖，研究不受影響。
            ⑥ 不支援附加檔案（手機版先不做）；多模型池（讀取池／搜尋池／Grok 池）簡化成單一模型選擇，引擎本身仍支援。
   依賴（全域）：appState、addMessage、renderMessages、saveToDB、scheduleEmergencyBackup、showToast、showConfirm、loadChatSession、nova-llm.js、window.NovaDeepResearch。
   對外：window.NovaProResearch = { open(topic?), start(params), isActive() }
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';
    var W = window;
    W._novaDrActive = false; W._novaDrCancelFlag = false; W._novaDrXSearchBroken = false; W._novaDrLockSession = null; W._novaDrAbortControllers = new Set();
    var PREF_KEY = 'nova_dr_prefs';
    var PHASES = [['plan', '規劃'], ['gather', '蒐集'], ['reflect', '反思'], ['live', '即時情報'], ['cross', '交叉審查'], ['write', '撰寫'], ['assemble', '組裝']];
    var mk = function (tag, css, text) { var e = document.createElement(tag); if (css) e.style.cssText = css; if (text != null) e.textContent = text; return e; };
    var K = function (n) { return (W.appState && appState.keys && appState.keys[n]) || localStorage.getItem('nova_key_' + n) || ''; };
    var fmt = function (ms) { var s = Math.max(0, Math.floor(ms / 1000)), m = Math.floor(s / 60), h = Math.floor(m / 60), p = function (n) { return String(n).padStart(2, '0'); }; return h ? h + ':' + p(m % 60) + ':' + p(s % 60) : p(m) + ':' + p(s); };
    function prefs() { try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {}; } catch (e) { return {}; } }

    // ───────── 網路層 ─────────
    async function drFetch(url, opts, timeout) {
        var ms = timeout || 300000, c = new AbortController();
        var tid = setTimeout(function () { try { c.abort('timeout'); } catch (e) { c.abort(); } }, ms);
        W._novaDrAbortControllers.add(c);
        try { return await W._novaLLMProxyFetch(url, Object.assign({}, opts, { signal: c.signal })); }
        catch (e) {
            if (c.signal.aborted) throw new Error(c.signal.reason === 'user_stop' ? '使用者已手動停止' : '連線逾時（' + Math.round(ms / 1000) + ' 秒）');
            throw new Error((e && e.message) ? e.message : String(e));
        } finally { clearTimeout(tid); W._novaDrAbortControllers.delete(c); }
    }
    async function callOpenAI(o) {
        var key = K('openai'); if (!key) throw new Error('尚未設定 OpenAI API Key（Pro 深度研究選了 OpenAI 模型）');
        var content = [];
        (o.parts || []).forEach(function (pt) {
            if (pt && pt.inlineData && pt.inlineData.data) {
                var mime = pt.inlineData.mimeType || 'application/pdf';
                if (/pdf/i.test(mime)) content.push({ type: 'input_file', filename: 'document.pdf', file_data: 'data:' + mime + ';base64,' + pt.inlineData.data });
                else if (/^image\//i.test(mime)) content.push({ type: 'input_image', image_url: 'data:' + mime + ';base64,' + pt.inlineData.data });
            }
        });
        var text = o.text || ''; if (o.json && !/json/i.test(text + (o.system || ''))) text += '\n\n請只輸出 JSON。';
        content.push({ type: 'input_text', text: text });
        var body = { model: o.model, input: [{ role: 'user', content: content }], max_output_tokens: Math.min(100000, (o.maxOutputTokens || 8192) * 2) };
        if (o.system) body.instructions = o.system; if (o.json) body.text = { format: { type: 'json_object' } }; if (o.search) body.tools = [{ type: 'web_search' }];
        var res = await drFetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, Math.min(240, o.timeoutSec || 180) * 1000 + 15000);
        var raw = await res.text(), data = null; try { data = JSON.parse(raw); } catch (e) { data = null; }
        if (!res.ok) { var er = new Error('OpenAI API 錯誤（模型：' + o.model + '）：' + ((data && data.error && data.error.message) || ('HTTP ' + res.status + ' ' + raw.slice(0, 140)))); er.status = res.status; throw er; }
        var parsed = W._novaOpenAiParseResponses(data); if (!parsed.text) throw new Error('OpenAI 沒有回傳內容');
        var cut = data && data.status === 'incomplete' && data.incomplete_details && data.incomplete_details.reason === 'max_output_tokens';
        return { text: parsed.text, sources: parsed.sources, finishReason: cut ? 'MAX_TOKENS' : 'STOP', usage: null };
    }
    async function callGemini(o) {
        if (String(o && o.model || '').indexOf('gpt-') === 0) return callOpenAI(o);
        var key = K('gemini'); if (!key) throw new Error('尚未在設定頁填入 Gemini API Key');
        var model = o.model, gc = { maxOutputTokens: o.maxOutputTokens || 8192 };
        if (o.json) gc.responseMimeType = 'application/json';
        var tc = W._novaDrThinkingConfig(model, o.thinking); if (tc) gc.thinkingConfig = tc;
        var userParts = (o.parts && o.parts.length) ? o.parts.concat([{ text: o.text || '' }]) : [{ text: o.text || '' }];
        var payload = { contents: [{ role: 'user', parts: userParts }], generationConfig: gc };
        if (o.system) payload.systemInstruction = { parts: [{ text: o.system }] };
        if (o.search) payload.tools = [{ googleSearch: {} }];
        var url = 'https://generativelanguage.googleapis.com/' + W._novaDrGeminiApiVer(model) + '/models/' + model + ':generateContent?key=' + key;
        var tsec = Math.min(120, o.timeoutSec || 120);
        var res = await drFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, tsec * 1000 + 15000);
        var raw = await res.text(), data = null; try { data = JSON.parse(raw); } catch (e) { data = null; }
        if (!res.ok) { var er = new Error((data && data.error && data.error.message) || ('HTTP ' + res.status + ' ' + raw.slice(0, 140))); er.status = res.status; throw er; }
        var cand = data && data.candidates && data.candidates[0];
        if (!cand) { var blk = data && data.promptFeedback && data.promptFeedback.blockReason; throw new Error('Gemini 沒有回傳內容' + (blk ? '（被安全機制攔截：' + blk + '）' : '')); }
        var parts = (cand.content && cand.content.parts) || [];
        var text = parts.filter(function (p) { return p.text && !p.thought; }).map(function (p) { return p.text; }).join('');
        var sources = [], chunks = cand.groundingMetadata && cand.groundingMetadata.groundingChunks;
        if (chunks) chunks.forEach(function (c) { if (c.web && c.web.uri) sources.push({ title: c.web.title || '', uri: c.web.uri }); });
        return { text: text, sources: sources, finishReason: cand.finishReason || '', usage: data.usageMetadata || null };
    }
    async function callGrok(o) {
        var key = K('grok'); if (!key) throw new Error('尚未設定 Grok API Key');
        var once = async function (withX) {
            var tools = [{ type: 'web_search' }]; if (withX) tools.push({ type: 'x_search' });
            var res = await drFetch('https://api.x.ai/v1/responses', { method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: o.model, input: [{ role: 'user', content: o.text }], tools: tools, include: ['no_inline_citations'] }) }, o.timeoutMs || 240000);
            var t = await res.text(); if (!res.ok) { var er = new Error('Grok API 錯誤：' + t.slice(0, 300)); er.status = res.status; throw er; }
            var data = JSON.parse(t), out = '';
            (data.output || []).forEach(function (it) { if (it.type === 'message' && Array.isArray(it.content)) it.content.forEach(function (c) { if (c.type === 'output_text' && c.text) out += c.text; }); });
            return { text: out, citations: Array.isArray(data.citations) ? data.citations : [] };
        };
        var wantX = !!o.xSearch && !W._novaDrXSearchBroken;
        try { return await once(wantX); } catch (e) { if (wantX && /x_search|unsupported|not support|invalid.*tool|tool.*invalid|unknown.*tool/i.test(String(e.message))) { W._novaDrXSearchBroken = true; return await once(false); } throw e; }
    }
    async function jsonPost(url, headers, body, ms) {
        var res = await drFetch(url, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: JSON.stringify(body) }, ms);
        var t = await res.text(), d = null; try { d = JSON.parse(t); } catch (e) { d = null; }
        if (!res.ok) { var er = new Error((d && (d.error || d.message)) ? String(typeof (d.error || d.message) === 'string' ? (d.error || d.message) : JSON.stringify(d.error || d.message)) : ('HTTP ' + res.status)); er.status = res.status; throw er; }
        return d || {};
    }
    async function httpGet(url, opt) {
        opt = opt || {}; var timeoutMs = opt.timeoutMs || 25000, maxBytes = opt.maxBytes || 16 * 1024 * 1024;
        var headers = { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36', 'Accept': 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8', 'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8' };
        var c = new AbortController(); W._novaDrAbortControllers.add(c);
        var tid = setTimeout(function () { try { c.abort('timeout'); } catch (e) { c.abort(); } }, timeoutMs);
        try {
            var Cap = W.Capacitor && W.Capacitor.Plugins && W.Capacitor.Plugins.CapacitorHttp;
            var work;
            if (Cap && Cap.request) {
                work = Cap.request({ method: 'GET', url: url, headers: headers, responseType: 'arraybuffer', readTimeout: timeoutMs, connectTimeout: 15000 }).then(function (r) {
                    var bin = atob(r.data || ''), bytes = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                    var h = r.headers || {}, ct = h['Content-Type'] || h['content-type'] || '';
                    if (bytes.length > maxBytes) return { status: 413, contentType: '', finalUrl: r.url || url, bytes: null };
                    return { status: r.status, contentType: ct, finalUrl: r.url || url, bytes: bytes };
                });
            } else {
                work = fetch(url, { headers: headers }).then(async function (r) { var buf = new Uint8Array(await r.arrayBuffer()); return { status: r.status, contentType: r.headers.get('content-type') || '', finalUrl: r.url || url, bytes: buf.length > maxBytes ? null : buf }; });
            }
            return await Promise.race([work, new Promise(function (_, rej) { c.signal.addEventListener('abort', function () { rej(new Error(c.signal.reason === 'user_stop' ? '使用者已手動停止' : '連線逾時（直連讀頁 ' + Math.round(timeoutMs / 1000) + 's）')); }); })]);
        } finally { clearTimeout(tid); W._novaDrAbortControllers.delete(c); }
    }
    function bytesToBase64(bytes) { var bin = '', CH = 0x8000; for (var i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH)); return btoa(bin); }
    async function saveFile(path, content) {
        var FS = W.Capacitor && W.Capacitor.Plugins && W.Capacitor.Plugins.Filesystem; if (!FS) throw new Error('沒有檔案系統存取能力');
        await FS.writeFile({ path: 'NOVA/' + path, data: content, directory: 'DOCUMENTS', recursive: true, encoding: 'utf8' });
    }
    function buildDeps(extra) {
        return Object.assign({
            callGemini: callGemini, callGrok: callGrok,
            hasFirecrawl: function () { return !!K('firecrawl'); },
            firecrawlSearch: async function (q, o) {
                var d = await jsonPost('https://api.firecrawl.dev/v1/search', { 'Authorization': 'Bearer ' + K('firecrawl') }, { query: q, limit: (o && o.limit) || 5, scrapeOptions: (o && o.scrape) ? { formats: ['markdown'], onlyMainContent: true } : undefined }, 80000);
                return (d.data || d.results || []).map(function (x) { return { url: x.url || (x.metadata && x.metadata.sourceURL) || '', title: x.title || (x.metadata && x.metadata.title) || '', description: x.description || (x.metadata && x.metadata.description) || '', markdown: x.markdown || '' }; });
            },
            firecrawlScrape: async function (url) {
                var d = await jsonPost('https://api.firecrawl.dev/v1/scrape', { 'Authorization': 'Bearer ' + K('firecrawl') }, { url: url, formats: ['markdown'], onlyMainContent: true }, 75000);
                var x = d.data || d; return { markdown: x.markdown || '', title: (x.metadata && x.metadata.title) || x.title || '' };
            },
            hasSerpApi: function () { return !!K('serpapi'); },
            serpSearch: async function (q, o) {
                var cjk = /[一-龥]/.test(q);
                var u = 'https://serpapi.com/search.json?q=' + encodeURIComponent(q) + '&api_key=' + K('serpapi') + '&engine=google&num=' + ((o && o.limit) || 8) + '&hl=' + (cjk ? 'zh-tw' : 'en') + '&gl=' + (cjk ? 'tw' : 'us');
                var res = await drFetch(u, {}, 20000); var d = await res.json().catch(function () { return {}; });
                if (!res.ok) { var er = new Error((d && d.error) || ('HTTP ' + res.status)); er.status = res.status; throw er; }
                return ((d && d.organic_results) || []).map(function (x) { return { title: x.title || '', url: x.link || '', snippet: x.snippet || '' }; });
            },
            httpGet: httpGet, bytesToBase64: bytesToBase64, saveFile: saveFile,
            isCancelled: function () { return !!W._novaDrCancelFlag; }
        }, extra || {});
    }

    // ───────── 輸入框鎖定 ─────────
    function syncComposer() {
        var locked = !!W._novaDrLockSession && String(W._novaDrLockSession) === String(appState.currentSessionId);
        var input = document.getElementById('user-input'), btn = document.getElementById('smart-action-btn');
        if (locked && !W._novaDrComposerSaved) {
            W._novaDrComposerSaved = { placeholder: input ? input.placeholder : '', disabled: input ? input.disabled : false, btnDisabled: btn ? btn.disabled : false, btnOpacity: btn ? btn.style.opacity : '' };
            if (input) { input.disabled = true; input.placeholder = '🧠 深度研究進行中，此對話輸入已鎖定（可切到其他對話）'; }
            if (btn) { btn.disabled = true; btn.style.opacity = '0.35'; }
        } else if (!locked && W._novaDrComposerSaved) {
            var sv = W._novaDrComposerSaved; W._novaDrComposerSaved = null;
            if (input) { input.disabled = sv.disabled; input.placeholder = sv.placeholder; }
            if (btn) { btn.disabled = sv.btnDisabled; btn.style.opacity = sv.btnOpacity; }
        }
    }

    // ───────── 進度面板 ─────────
    function panelOpen(o) {
        var old = document.getElementById('nova-dr-panel'); if (old) old.remove();
        if (!document.getElementById('nova-dr-style')) { var st = document.createElement('style'); st.id = 'nova-dr-style'; st.textContent = '@keyframes novaDrSpin{to{transform:rotate(360deg)}}'; document.head.appendChild(st); }
        var root = mk('div', 'position:fixed;left:8px;right:8px;top:calc(58px + env(safe-area-inset-top,0px));max-height:62vh;overflow-y:auto;z-index:75;background:var(--nv-card,#0f172a);border:1px solid rgba(168,85,247,.6);border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.55);color:var(--nv-text,#e2e8f0);font-size:12px;padding:10px 12px;');
        root.id = 'nova-dr-panel';
        var head = mk('div', 'display:flex;align-items:center;gap:8px;');
        var spin = mk('span', 'display:inline-block;width:14px;height:14px;border:2px solid #a855f7;border-top-color:transparent;border-radius:50%;animation:novaDrSpin .9s linear infinite;flex:none;');
        var title = mk('b', 'flex:1;color:#d8b4fe;font-size:13px;', '🧠 Pro 深度研究進行中');
        var total = mk('span', 'font-family:ui-monospace,monospace;color:#c4b5fd;font-size:13px;', '00:00');
        var miniStop = mk('button', 'background:#dc2626;color:#fff;border:0;border-radius:6px;padding:4px 10px;font-size:12px;font-weight:700;', '⏹');
        var fold = mk('button', 'background:var(--nv-card-2,#1e293b);border:0;color:var(--nv-muted,#94a3b8);border-radius:6px;padding:4px 10px;font-size:14px;', '—');
        head.append(spin, title, total, miniStop, fold);
        var body = mk('div', 'margin-top:8px;');
        var topic = mk('div', 'color:var(--nv-muted,#94a3b8);margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', '📌 ' + o.topic);
        var chips = mk('div', 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;'), chipEls = {};
        PHASES.forEach(function (pp) { var c = mk('span', 'padding:2px 8px;border-radius:999px;background:var(--nv-card-2,#1e293b);color:var(--nv-muted,#64748b);font-size:11px;', '⬜ ' + pp[1]); chipEls[pp[0]] = c; chips.appendChild(c); });
        var cur = mk('div', 'word-break:break-all;', '▶ 準備中…'), stepRow = mk('div', 'color:var(--nv-muted,#94a3b8);font-size:11px;', ''), callsEl = mk('div', 'color:#a5b4fc;font-size:11px;margin-top:4px;word-break:break-all;', ''), stats = mk('div', 'color:var(--nv-muted,#94a3b8);font-size:11px;margin-top:4px;', ''), heart = mk('div', 'font-size:11px;margin-top:6px;color:#4ade80;', '');
        var btns = mk('div', 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;');
        var stopBtn = mk('button', 'flex:1;min-height:38px;background:#dc2626;color:#fff;border:0;border-radius:8px;padding:6px 10px;font-weight:700;', '⏹ 停止並保留已完成內容');
        var forceBtn = mk('button', 'display:none;min-height:38px;background:#7f1d1d;color:#fecaca;border:0;border-radius:8px;padding:6px 10px;font-weight:700;', '強制結束');
        var gotoBtn = mk('button', 'display:none;min-height:38px;background:transparent;border:1px solid #a855f7;color:#d8b4fe;border-radius:8px;padding:6px 10px;', '📄 回到研究對話');
        var closeBtn = mk('button', 'display:none;min-height:38px;background:#334155;color:#e2e8f0;border:0;border-radius:8px;padding:6px 10px;', '關閉');
        btns.append(stopBtn, forceBtn, gotoBtn, closeBtn); body.append(topic, chips, cur, stepRow, callsEl, stats, heart, btns); root.append(head, body); document.body.appendChild(root);
        var P = { startedAt: Date.now(), stepAt: Date.now(), lastAt: Date.now(), sig: '', active: new Map(), stopping: false, stopAt: 0, finished: false, timer: null, forceShown: false };
        var icon = { pending: '⬜', running: '🔄', done: '✅', skipped: '➖', error: '⚠️' };
        P.progress = function (snap) {
            P.lastAt = Date.now(); snap = snap || {}; var ph = snap.phases || {};
            var sig = Object.keys(ph).map(function (k) { return k + ':' + ph[k].s; }).join(','); if (sig !== P.sig) { P.sig = sig; P.stepAt = Date.now(); }
            var running = [];
            PHASES.forEach(function (pp) {
                var p = ph[pp[0]] || { s: 'pending', note: '' }, c = chipEls[pp[0]];
                c.textContent = (icon[p.s] || '⬜') + ' ' + pp[1]; c.title = p.note || '';
                c.style.background = p.s === 'running' ? '#581c87' : (p.s === 'done' ? '#14532d' : (p.s === 'error' ? '#7f1d1d' : 'var(--nv-card-2,#1e293b)'));
                c.style.color = p.s === 'running' ? '#f3e8ff' : (p.s === 'done' ? '#bbf7d0' : (p.s === 'error' ? '#fecaca' : 'var(--nv-muted,#64748b)'));
                if (p.s === 'running') running.push(pp[1] + (p.note ? '（' + p.note + '）' : ''));
            });
            cur.textContent = '▶ ' + (snap.current || running.join('、') || '處理中…');
            var s = snap.stats || {};
            stats.textContent = '📚 已讀 ' + (s.pagesRead || 0) + '（成功 ' + (snap.sourcesOk || 0) + '／失敗 ' + (s.pagesFailed || 0) + '）｜🧩 事實 ' + (snap.facts || 0) + '｜🔎 搜尋 ' + (s.searches || 0) + '｜🤖 Gemini ' + (s.geminiCalls || 0) + (s.grokCalls ? '／Grok ' + s.grokCalls : '') + (snap.sectionsTotal ? '｜章節 ' + (snap.sectionsDone || 0) + '/' + snap.sectionsTotal : '');
        };
        P.call = function (ev) { P.lastAt = Date.now(); if (ev.event === 'start') P.active.set(ev.id, { label: ev.label + (ev.model ? '｜' + String(ev.model).replace(/^gemini-/, '').replace(/^grok-/, '') : ''), t: Date.now() }); else P.active.delete(ev.id); };
        P.touch = function () { P.lastAt = Date.now(); };
        P.tick = function () {
            if (P.finished) return; var now = Date.now();
            total.textContent = fmt(now - P.startedAt); stepRow.textContent = '本階段已進行 ' + fmt(now - P.stepAt);
            var calls = Array.from(P.active.values()).sort(function (a, b) { return a.t - b.t; });
            callsEl.textContent = calls.length ? '⏳ 等待中：' + calls.slice(0, 3).map(function (c) { return c.label + '（' + Math.round((now - c.t) / 1000) + 's）'; }).join('、') + (calls.length > 3 ? ' 等共 ' + calls.length + ' 項' : '') : '⏳ 目前沒有進行中的網路請求（本機處理中）';
            var oldest = calls.length ? now - calls[0].t : 0, idle = now - P.lastAt, msg, color;
            if (P.stopping) { msg = '⏹ 正在停止…等待進行中的請求中斷'; color = '#fbbf24'; }
            else if (oldest > 180000 || (!calls.length && idle > 120000)) { msg = '🔴 已 ' + Math.round(Math.max(oldest, idle) / 1000) + ' 秒沒有進展，可能卡住；可再等一下或按「停止」保留已完成內容'; color = '#f87171'; }
            else if (oldest > 90000) { msg = '🟡 有請求等待較久（' + Math.round(oldest / 1000) + ' 秒）：長章節撰寫與 Grok 搜尋常需 1～3 分鐘，屬正常'; color = '#fbbf24'; }
            else { msg = '🟢 運作中'; color = '#4ade80'; }
            heart.textContent = msg; heart.style.color = color; syncComposer();
            gotoBtn.style.display = String(appState.currentSessionId) !== String(o.ownerSession) ? '' : 'none';
            if (P.stopping && !P.forceShown && now - P.stopAt > 8000) { forceBtn.style.display = ''; P.forceShown = true; }
        };
        P.setStopping = function () { if (P.stopping) return; P.stopping = true; P.stopAt = Date.now(); stopBtn.disabled = true; stopBtn.style.opacity = '.5'; stopBtn.textContent = '正在停止…'; miniStop.disabled = true; miniStop.style.opacity = '.5'; title.textContent = '⏹ 正在停止…'; P.tick(); };
        P.finish = function (t, d, ok) {
            P.finished = true; if (P.timer) { clearInterval(P.timer); P.timer = null; }
            spin.style.animation = 'none'; spin.style.borderColor = ok ? '#4ade80' : '#fbbf24'; title.textContent = t; total.textContent = fmt(Date.now() - P.startedAt); cur.textContent = d || '';
            stepRow.textContent = ''; callsEl.textContent = ''; heart.textContent = ''; stopBtn.style.display = 'none'; forceBtn.style.display = 'none'; miniStop.style.display = 'none'; closeBtn.style.display = '';
            gotoBtn.style.display = String(appState.currentSessionId) !== String(o.ownerSession) ? '' : 'none'; gotoBtn.textContent = '📄 查看報告';
            if (String(appState.currentSessionId) === String(o.ownerSession)) setTimeout(function () { P.destroy(); }, 25000);
        };
        P.destroy = function () { if (P.timer) { clearInterval(P.timer); P.timer = null; } if (root.parentNode) root.parentNode.removeChild(root); };
        miniStop.onclick = stopBtn.onclick = function () { if (o.onStop) o.onStop(); };
        forceBtn.onclick = function () { if (o.onForce) o.onForce(); }; gotoBtn.onclick = function () { if (o.onGoto) o.onGoto(); }; closeBtn.onclick = function () { P.destroy(); };
        fold.onclick = function () { var hide = body.style.display !== 'none'; body.style.display = hide ? 'none' : ''; fold.textContent = hide ? '＋' : '—'; };
        P.timer = setInterval(P.tick, 1000); P.tick(); return P;
    }

    // ───────── 啟動研究 ─────────
    async function start(p) {
        var eng = W.NovaDeepResearch;
        if (!eng) { addMessage('❌ 找不到深度研究引擎（deep-research-engine.js 沒有載入）。', 'system'); return; }
        if (W._novaDrActive) { showToast('已經有一個 Pro 深度研究正在執行中'); return; }
        if (!K('gemini')) { showToast('Pro 深度研究需要 Gemini API Key，請先到設定頁填寫'); return; }
        var topic = String(p.topic || '').trim(); if (!topic) { showToast('請輸入研究主題'); return; }
        var uniq = function (a) { var s = {}; return a.filter(function (x) { if (!x || s[x]) return false; s[x] = 1; return true; }); };
        var rm = function (m, fb) { m = String(m || ''); if (m.indexOf('gpt-') === 0) return W._novaDrResolveGptModel(m); return W._novaDrResolveGeminiModel(m, fb); };
        var plan = rm(p.planner), write = p.writer ? rm(p.writer, plan) : plan, critic = p.critic ? rm(p.critic, plan) : plan, reader = rm(p.reader, plan);
        var usesOpenAi = [plan, write, critic, reader].some(function (m) { return String(m).indexOf('gpt-') === 0; });
        if (usesOpenAi && !K('openai')) { showToast('選了 OpenAI 模型，但還沒設定 OpenAI API Key（設定頁）'); return; }
        var useGrok = !!p.useGrok && !!K('grok');
        var grokModel = W._novaDrResolveGrokModel(p.grokModel || (appState.grokModel || ''));
        var grokPool = useGrok ? [grokModel] : [];
        var strategy = (p.strategy === 'max' && !useGrok) ? 'parallel' : (['chain', 'parallel', 'max'].indexOf(p.strategy) !== -1 ? p.strategy : 'chain');
        var useFirecrawl = !!p.useFirecrawl && !!K('firecrawl');
        try { localStorage.setItem(PREF_KEY, JSON.stringify({ planner: p.planner || '', writer: p.writer || '', critic: p.critic || '', reader: p.reader || '', grokModel: p.grokModel || '', strategy: p.strategy || 'chain', depth: p.depth || 'standard', useGrok: !!p.useGrok, useFirecrawl: !!p.useFirecrawl })); } catch (e) { /* ignore */ }
        var depth = eng.DEPTH_PRESETS[p.depth] ? p.depth : 'standard';
        var est = eng.estimate(depth, { useGrok: useGrok, hasFirecrawl: useFirecrawl, hasSerpApi: !!K('serpapi'), searchStrategy: strategy, readerPoolSize: 1, grokPoolSize: Math.max(1, grokPool.length) });
        if (depth !== 'standard') {
            var ok = await showConfirm('即將啟動 Pro 深度研究（' + eng.DEPTH_PRESETS[depth].label + '）。\n預估：約 ' + est.sections + ' 章、' + est.approxChars.toLocaleString() + ' 字；最多讀取 ' + est.sources + ' 個來源；Gemini 約 ' + est.geminiCalls + ' 次' + (est.grokCalls ? '、Grok 約 ' + est.grokCalls + ' 次' : '') + '。\n\n會消耗相當額度與時間（可能數十分鐘），確定開始？');
            if (!ok) return;
        }
        W._novaDrActive = true; W._novaDrCancelFlag = false; W._novaDrAbortControllers.clear();
        var ownerSession = appState.currentSessionId; W._novaDrLockSession = ownerSession;
        var strategyLabel = { chain: '依序備援', parallel: '平行多管道', max: '全力（平行＋Grok 偵察）' }[strategy];
        addMessage('🚀 **啟動 Pro 深度研究**\n📌 主題：「' + topic + '」\n📊 深度：' + eng.DEPTH_PRESETS[depth].label + '\n🧭 規劃：' + plan + '｜✍️ 撰稿：' + write + '｜🧐 審稿：' + critic + '\n🔍 讀取：' + reader + '\n🌐 搜尋：' + strategyLabel + (useFirecrawl ? '＋Firecrawl' : '') + (K('serpapi') ? '＋SerpApi' : '') + '＋Gemini 接地' + (useGrok ? '\n⚡ Grok：' + grokModel : ''), 'system');
        addMessage('⏳ 準備中…', 'system', null, [], null, null, ownerSession);
        var progMsg = appState.messages[appState.messages.length - 1];
        var forceResolve = null, forced = new Promise(function (r) { forceResolve = r; });
        var panel;
        var doStop = function () { if (W._novaDrCancelFlag) return; W._novaDrCancelFlag = true; W._novaDrAbortControllers.forEach(function (c) { try { c.abort('user_stop'); } catch (e) { /* ignore */ } }); W._novaDrAbortControllers.clear(); panel.setStopping(); showToast('⏹️ 正在停止，已完成的章節會保留…', 4000); };
        panel = panelOpen({ topic: topic, ownerSession: ownerSession, onStop: doStop, onForce: function () { if (forceResolve) forceResolve('FORCED'); }, onGoto: function () { if (typeof loadChatSession === 'function') loadChatSession(ownerSession); } });
        syncComposer();
        var lastRender = 0, timer = null;
        var flush = function () { timer = null; lastRender = Date.now(); if (String(ownerSession) === String(appState.currentSessionId)) renderMessages(); };
        var onProgress = function (text, snap) { panel.progress(snap); progMsg.text = text; var gap = Date.now() - lastRender; if (gap > 1500) flush(); else if (!timer) timer = setTimeout(flush, 1500 - gap); };
        var t0 = Date.now(), control = {}, result = null;
        try {
            var runP = eng.run({ topic: topic, depth: depth, models: { planner: plan, writer: write, critic: critic, reader: [reader], searcher: [], grok: grokPool, grokReview: '' }, searchStrategy: strategy, useFirecrawl: useFirecrawl, useGrok: useGrok, useXSearch: true, files: [], control: control,
                deps: buildDeps({ onProgress: onProgress, onCall: function (ev) { panel.call(ev); }, log: function (l) { console.log('[NOVA][DeepResearch]', l); panel.touch(); } }) });
            var raced = await Promise.race([runP, forced]);
            if (raced === 'FORCED') {
                var snap = control.snapshot ? control.snapshot() : null;
                result = { ok: false, cancelled: true, forced: true, elapsedMs: Date.now() - t0, markdown: snap ? snap.markdown : '', chars: snap ? snap.chars : 0, cited: snap ? snap.cited : 0, saved: {}, stats: {}, error: '已強制結束等待，保留目前完成的章節' };
                runP.catch(function () { /* 背景收尾不再處理 */ });
            } else result = raced;
        } catch (e) { result = { ok: false, error: (e && e.message) || String(e), markdown: '', saved: {}, logs: [], stats: {}, elapsedMs: Date.now() - t0 }; }
        finally { if (timer) { clearTimeout(timer); timer = null; } W._novaDrActive = false; W._novaDrLockSession = null; W._novaDrAbortControllers.clear(); syncComposer(); }
        var secs = Math.round((result.elapsedMs || 0) / 1000), took = secs >= 60 ? Math.floor(secs / 60) + ' 分 ' + (secs % 60) + ' 秒' : secs + ' 秒', head;
        if (result.markdown) {
            W._novaDrPostReportMessage(result.markdown, write, ownerSession);
            var st = result.stats || {};
            head = result.ok ? '🎉 **Pro 深度研究完成**' : (result.cancelled ? '⏹️ **已停止，保留已完成的章節**' : '⚠️ **執行中發生錯誤，保留已完成的章節**');
            progMsg.text = head + '｜耗時 ' + took + '｜正文約 ' + (result.chars || 0).toLocaleString() + ' 字｜引用 ' + (result.cited || 0) + ' 個來源' + (st.pagesRead != null ? '｜讀取 ' + (st.pagesRead || 0) + ' 頁（失敗 ' + (st.pagesFailed || 0) + '）' : '') +
                (result.saved && result.saved.report ? '\n📄 已存檔：文件/NOVA/' + result.saved.report : '') + (result.saved && result.saved.evidence ? '\n🗂️ 證據附錄：文件/NOVA/' + result.saved.evidence : '') + (result.error ? '\n⚠️ ' + result.error : '');
        } else {
            head = result.cancelled ? '⏹️ **已停止**（尚未產生任何章節）' : '❌ **Pro 深度研究失敗**';
            progMsg.text = head + '｜耗時 ' + took + (result.error ? '\n原因：' + result.error : '') + (result.ok === false && !result.cancelled ? '\n💡 可檢查 Gemini／Firecrawl／SerpApi 金鑰與額度，或降低深度重試。' : '');
        }
        saveToDB('messages', progMsg); scheduleEmergencyBackup();
        if (String(ownerSession) === String(appState.currentSessionId)) renderMessages();
        if (typeof renderChatHistoryList === 'function') renderChatHistoryList();
        panel.finish(result.ok ? '✅ 深度研究完成（' + took + '）' : (result.cancelled ? '⏹ 已停止（' + took + '）' : '❌ 深度研究失敗（' + took + '）'), result.markdown ? '報告約 ' + (result.chars || 0).toLocaleString() + ' 字，已放進研究所在的對話' : (result.error || ''), !!result.ok);
        if (String(ownerSession) !== String(appState.currentSessionId)) showToast(result.ok ? '✅ 深度研究完成，可用上方面板回到研究對話' : '深度研究已結束，可用上方面板回到研究對話', 7000);
    }

    // ───────── 設定視窗 ─────────
    function modelOptions() {
        var g = W._novaDrTextModelOptions('gemini'), o = W._novaDrTextModelOptions('openai'), k = W._novaDrTextModelOptions('grok');
        return { gemini: g, openai: o, grok: k };
    }
    function open(topicPrefill) {
        var old = document.getElementById('nova-dr-modal'); if (old) old.remove();
        try { document.getElementById('plus-menu').classList.add('hidden'); document.getElementById('plus-icon').classList.remove('rotate-45'); } catch (e) { /* ignore */ }
        var eng = W.NovaDeepResearch, pf = prefs(), mo = modelOptions();
        var overlay = mk('div', 'position:fixed;inset:0;z-index:9000;background:var(--nv-canvas,#020617);display:flex;flex-direction:column;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);color:var(--nv-text,#e2e8f0);');
        overlay.id = 'nova-dr-modal';
        var head = mk('div', 'display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--nv-line-strong,#334155);');
        head.appendChild(mk('b', 'flex:1;font-size:15px;', '🧠 Pro 深度研究'));
        var x = mk('button', 'background:transparent;border:0;color:var(--nv-muted,#94a3b8);font-size:20px;min-width:40px;min-height:40px;', '✕'); x.onclick = function () { overlay.remove(); }; head.appendChild(x);
        var body = mk('div', 'flex:1;overflow-y:auto;padding:12px 16px;');
        var fld = 'width:100%;box-sizing:border-box;background:var(--nv-card-2,#1e293b);color:var(--nv-text,#e2e8f0);border:1px solid var(--nv-line-strong,#334155);border-radius:9px;padding:9px 10px;font-size:16px;outline:none;font-family:inherit;';
        var lab = function (t, hint) { var l = mk('div', 'font-size:12px;font-weight:600;margin:12px 0 4px;', t); if (hint) l.appendChild(mk('span', 'font-weight:400;color:var(--nv-muted,#94a3b8);margin-left:6px;', hint)); return l; };
        var topic = mk('textarea', fld + 'min-height:84px;resize:vertical;'); topic.placeholder = '研究主題（例：台灣電動機車市場 2026 競爭格局與政策影響）'; topic.value = topicPrefill || '';
        var mkSel = function (withFollow, val) {
            var s = mk('select', fld);
            s.appendChild(new Option(withFollow ? '（跟隨規劃模型）' : '（預設）', ''));
            [['Gemini', mo.gemini], ['OpenAI', mo.openai]].forEach(function (gp) { if (!gp[1].length) return; var og = document.createElement('optgroup'); og.label = gp[0]; gp[1].forEach(function (o) { og.appendChild(new Option(o.label, o.value)); }); s.appendChild(og); });
            s.value = Array.from(s.options).some(function (o) { return o.value === val; }) ? val : ''; return s;
        };
        var depth = mk('select', fld); Object.keys(eng ? eng.DEPTH_PRESETS : { standard: 1 }).forEach(function (k) { depth.appendChild(new Option(eng ? eng.DEPTH_PRESETS[k].label : k, k)); }); depth.value = pf.depth || 'standard';
        var planner = mkSel(false, pf.planner), writer = mkSel(true, pf.writer), critic = mkSel(true, pf.critic), reader = mkSel(true, pf.reader);
        var strategy = mk('select', fld); [['chain', '依序備援（最省額度）'], ['parallel', '平行多管道（更全面）'], ['max', '全力（平行＋Grok 偵察，需 Grok）']].forEach(function (s) { strategy.appendChild(new Option(s[1], s[0])); }); strategy.value = pf.strategy || 'chain';
        var chk = function (text, checked, disabled, hint) { var w = mk('label', 'display:flex;align-items:center;gap:8px;min-height:40px;font-size:13px;'); var c = mk('input'); c.type = 'checkbox'; c.checked = !!checked && !disabled; c.disabled = !!disabled; c.style.cssText = 'width:20px;height:20px;'; w.append(c, document.createTextNode(text + (disabled ? '（' + hint + '）' : ''))); return { w: w, c: c }; };
        var fc = chk('使用 Firecrawl 搜尋／讀頁', pf.useFirecrawl !== false, !K('firecrawl'), '尚未設定 Firecrawl Key，將用 SerpApi／Gemini 搜尋＋直連讀頁');
        var gk = chk('啟用 Grok 即時情報＋交叉審查', pf.useGrok !== false, !K('grok'), '尚未設定 Grok Key');
        var grokSel = mk('select', fld); grokSel.appendChild(new Option('（預設 Grok 模型）', '')); mo.grok.forEach(function (o) { grokSel.appendChild(new Option(o.label, o.value)); }); grokSel.value = Array.from(grokSel.options).some(function (o) { return o.value === pf.grokModel; }) ? pf.grokModel : '';
        var est = mk('div', 'font-size:12px;color:var(--nv-muted,#94a3b8);margin-top:12px;line-height:1.6;');
        var refresh = function () {
            if (!eng) { est.textContent = '找不到引擎'; return; }
            var useGrok = gk.c.checked && !!K('grok'), e = eng.estimate(depth.value, { useGrok: useGrok, hasFirecrawl: fc.c.checked && !!K('firecrawl'), hasSerpApi: !!K('serpapi'), searchStrategy: (strategy.value === 'max' && !useGrok) ? 'parallel' : strategy.value, readerPoolSize: 1, grokPoolSize: 1 });
            est.textContent = '預估：約 ' + e.sections + ' 章、' + e.approxChars.toLocaleString() + ' 字；最多讀取 ' + e.sources + ' 個來源；Gemini 約 ' + e.geminiCalls + ' 次' + (e.grokCalls ? '、Grok 約 ' + e.grokCalls + ' 次' : '') + '。研究期間請保持 App 開啟（螢幕可關，已啟用背景保活）。';
        };
        [depth, strategy, fc.c, gk.c].forEach(function (el) { el.onchange = refresh; });
        body.append(lab('研究主題'), topic, lab('研究深度'), depth, lab('規劃模型（專案經理／總編輯）'), planner, lab('撰稿模型', '留空＝同規劃'), writer, lab('審稿模型', '留空＝同規劃'), critic, lab('資料讀取模型', '留空＝同規劃'), reader, lab('搜尋策略'), strategy, fc.w, gk.w, lab('Grok 模型'), grokSel, est);
        var foot = mk('div', 'display:flex;gap:10px;padding:10px 16px;border-top:1px solid var(--nv-line-strong,#334155);');
        var cancel = mk('button', 'flex:0 0 auto;min-height:44px;padding:0 18px;border-radius:10px;border:1px solid var(--nv-line-strong,#334155);background:var(--nv-card-2,#1e293b);color:var(--nv-text,#e2e8f0);font-size:14px;', '取消'); cancel.onclick = function () { overlay.remove(); };
        var go = mk('button', 'flex:1;min-height:44px;border-radius:10px;border:0;background:#9333ea;color:#fff;font-size:15px;font-weight:700;', '🚀 開始研究');
        go.onclick = function () { var p = { topic: topic.value, depth: depth.value, planner: planner.value, writer: writer.value, critic: critic.value, reader: reader.value, strategy: strategy.value, useFirecrawl: fc.c.checked, useGrok: gk.c.checked, grokModel: grokSel.value }; overlay.remove(); start(p); };
        foot.append(cancel, go); overlay.append(head, body, foot); document.body.appendChild(overlay); refresh();
    }

    W.NovaProResearch = { open: open, start: start, isActive: function () { return !!W._novaDrActive; }, buildDeps: buildDeps };
    W.openProResearch = open;
})();

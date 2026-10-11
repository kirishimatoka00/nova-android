/* ═══════════════════════════════════════════════════════════════════════
   nova-dr-glue.js — NOVA Android「Pro 深度研究」接線層（跟 index.html 放同一個資料夾 www/）
   版本：v1.1.0
   版本紀錄：
   v1.1.0 - v2.6.37：設定視窗改版成桌面版「多 AI 深度協同研究控制台」（v3.59.0）：研究深度、Firecrawl／Grok 勾選、進階（規劃／撰稿／審稿／Grok 交叉審查、讀取／搜尋接地／Grok 三個勾選式模型池與快速預設、搜尋策略）、
            研究主題＋參考檔案上傳（文字／CSV／Excel／PDF）、專案經理／資料研究員／審查委員三角色、「🤖 AI 模型智能分配」（gemini-3.1-pro-preview 依任務性質改寫所有模型設定）。start() 同步支援多模型池、Grok 池、交叉審查、參考檔案。入口名稱改為「深度研究」。
   v1.0.0 - 初版（批次 6a）。引擎本體沿用 deep-research-engine.js（桌面版 v1.1.0 原樣移植）；這支檔案負責把引擎接到手機版 App，移植自桌面版 index.html 的
            「NOVA-PRO-RESEARCH-GLUE」（_novaDrBuildDeps／_novaStartProResearch／狀態面板），差異如下：
            ① 手機沒有 sidecar：Firecrawl（search／scrape）、SerpApi 直接由 App 發請求（CapacitorHttp 原生請求無 CORS）；讀網頁原始位元組用 CapacitorHttp（arraybuffer）。
            ② 模型呼叫共用 nova-llm.js 的 _novaDr* 輔助函式；Gemini 走 generateContent、gpt- 走 Responses API、Grok 走 Responses＋web_search／x_search。
            ③ 介面：全螢幕「Pro 深度研究」設定視窗（主題、深度、規劃／撰稿／審稿／讀取模型、搜尋策略、Firecrawl／Grok 開關、預估），
               進度面板貼在畫面上方（避開輸入列），可收合、停止、強制結束、回到研究對話。入口：「＋」選單 →「深度研究」。
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
        var pc = p.pro || {};
        // 參考檔案：只吃文字（含 CSV／Excel 已轉文字）與 PDF（與桌面版相同）
        var rawFiles = Array.isArray(p.files) ? p.files : [], files = [], fnotes = [];
        rawFiles.forEach(function (f) {
            if (f.category === 'text') files.push({ name: f.name, text: String(f.data || '') });
            else if (f.category === 'document' && /pdf/i.test((f.mime || '') + ' ' + (f.name || ''))) { var b64 = String(f.data || '').split(',')[1]; if (b64) files.push({ name: f.name, pdfBase64: b64 }); }
        });
        if (rawFiles.length > files.length) fnotes.push('有 ' + (rawFiles.length - files.length) + ' 個檔案（圖片／影音／其他格式）不會被讀取，只支援文字、CSV／Excel（已轉文字）與 PDF');
        var topic = String(p.topic || '').trim() || (files.length ? '綜合分析使用者提供的資料，並延伸做深度研究' : ''); if (!topic) { showToast('請輸入研究主題，或上傳參考檔案'); return; }
        var uniq = function (a) { var s = {}; return a.filter(function (x) { if (!x || s[x]) return false; s[x] = 1; return true; }); };
        var rm = function (m, fb) { m = String(m || ''); if (m.indexOf('gpt-') === 0) return W._novaDrResolveGptModel(m); return W._novaDrResolveGeminiModel(m, fb); };
        var plan = rm(pc.planner || p.orchestrator), write = pc.writer ? rm(pc.writer, plan) : plan, critic = pc.critic ? rm(pc.critic, plan) : plan;
        var readerBase = rm(p.researcher, plan);
        var readerPool = uniq((pc.readerPool && pc.readerPool.length ? pc.readerPool : [readerBase]).map(function (m) { return rm(m, plan); }));
        var searcherPool = (pc.searcherPool && pc.searcherPool.length) ? uniq(pc.searcherPool.map(function (m) { return rm(m, plan); })) : [];
        var usesOpenAi = [plan, write, critic].concat(readerPool, searcherPool).some(function (m) { return String(m).indexOf('gpt-') === 0; });
        if (usesOpenAi && !K('openai')) { showToast('選了 OpenAI 模型，但還沒設定 OpenAI API Key（設定頁）'); return; }
        var useGrok = !!p.useGrok && !!K('grok');
        var grokDefault = W._novaDrResolveGrokModel(String(p.verifier || '').indexOf('grok-') === 0 ? p.verifier : (appState.grokModel || ''));
        var grokPool = useGrok ? uniq((pc.grokPool && pc.grokPool.length ? pc.grokPool : [grokDefault]).map(W._novaDrResolveGrokModel)) : [];
        var grokReview = (useGrok && pc.grokReview) ? W._novaDrResolveGrokModel(pc.grokReview) : '';
        var grokModel = grokPool[0] || grokDefault;
        var strategy = (pc.strategy === 'max' && !useGrok) ? 'parallel' : (['chain', 'parallel', 'max'].indexOf(pc.strategy) !== -1 ? pc.strategy : 'chain');
        if (pc.strategy === 'max' && !useGrok) fnotes.push('「全力」搜尋策略需要 Grok，已改用「平行多管道」');
        var useFirecrawl = !!p.useFirecrawl && !!K('firecrawl');
        try { localStorage.setItem(PREF_KEY, JSON.stringify({ planner: pc.planner || '', writer: pc.writer || '', critic: pc.critic || '', grokReview: pc.grokReview || '', readerPool: pc.readerPool || [], searcherPool: pc.searcherPool || [], grokPool: pc.grokPool || [], strategy: pc.strategy || 'chain', orchestrator: p.orchestrator || '', researcher: p.researcher || '', verifier: p.verifier || '', depth: p.depth || 'standard', useGrok: !!p.useGrok, useFirecrawl: !!p.useFirecrawl })); } catch (e) { /* ignore */ }
        var depth = eng.DEPTH_PRESETS[p.depth] ? p.depth : 'standard';
        var est = eng.estimate(depth, { useGrok: useGrok, hasFirecrawl: useFirecrawl, hasSerpApi: !!K('serpapi'), searchStrategy: strategy, readerPoolSize: readerPool.length, grokPoolSize: Math.max(1, grokPool.length) });
        if (depth !== 'standard') {
            var ok = await showConfirm('即將啟動 Pro 深度研究（' + eng.DEPTH_PRESETS[depth].label + '）。\n預估：約 ' + est.sections + ' 章、' + est.approxChars.toLocaleString() + ' 字；最多讀取 ' + est.sources + ' 個來源；Gemini 約 ' + est.geminiCalls + ' 次' + (est.grokCalls ? '、Grok 約 ' + est.grokCalls + ' 次' : '') + '。\n\n會消耗相當額度與時間（可能數十分鐘），確定開始？');
            if (!ok) return;
        }
        W._novaDrActive = true; W._novaDrCancelFlag = false; W._novaDrAbortControllers.clear();
        var ownerSession = appState.currentSessionId; W._novaDrLockSession = ownerSession;
        var strategyLabel = { chain: '依序備援', parallel: '平行多管道', max: '全力（平行＋Grok 偵察）' }[strategy];
        addMessage('🚀 **啟動 Pro 深度研究**\n📌 主題：「' + topic + '」\n📊 深度：' + eng.DEPTH_PRESETS[depth].label + '\n🧭 規劃：' + plan + '｜✍️ 撰稿：' + write + '｜🧐 審稿：' + critic + '\n🔍 讀取池：' + readerPool.join('、') + (readerPool.length > 1 ? '（並行分派）' : '') + (searcherPool.length ? '\n🌐 搜尋接地池：' + searcherPool.join('、') : '') + '\n🌐 搜尋：' + strategyLabel + (useFirecrawl ? '＋Firecrawl' : '') + (K('serpapi') ? '＋SerpApi' : '') + '＋Gemini 接地' + (useGrok ? '\n⚡ Grok：' + grokPool.join('、') + (grokReview ? '｜交叉審查：' + grokReview : '') : '') + (fnotes.length ? '\n⚠️ ' + fnotes.join('；') : '') + (files.length ? '\n📎 參考檔案：' + files.map(function (x) { return x.name; }).join('、') : ''), 'system');
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
            var runP = eng.run({ topic: topic, depth: depth, models: { planner: plan, writer: write, critic: critic, reader: readerPool, searcher: searcherPool, grok: grokPool, grokReview: grokReview }, searchStrategy: strategy, useFirecrawl: useFirecrawl, useGrok: useGrok, useXSearch: true, files: files, control: control,
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

    // ───────── 多 AI 深度協同研究控制台（對標桌面版 v3.59.0）─────────
    // 模型能力（啟發式：依型號名稱判斷定位，不是官方跑分；給下拉標籤與「AI 模型智能分配」參考）
    function modelCaps(v) {
        v = String(v || '');
        var mkc = function (tier, tag, best, cost, ctx, note) { return { tier: tier, tag: tag, best: best, cost: cost, ctx: ctx || '', note: note || '' }; };
        var none = { tier: '', tag: '', best: [], cost: 0, ctx: '', note: '' };
        if (/^gemini-/.test(v)) {
            if (/multi|image|imagen|nano-banana|tts|live|audio|embedding|veo|robotics|computer/i.test(v)) return none;
            var old = /^gemini-2\./.test(v) ? '舊代・' : '';
            if (/pro/.test(v)) return mkc('旗艦', old + '旗艦推理｜規劃・撰稿・審稿', ['plan', 'write', 'critic'], 3, '1M', 'Google 搜尋接地；長文品質與推理最強，額度與成本最高');
            if (/lite/.test(v)) return mkc('輕量', old + '輕量低成本｜讀取・搜尋', ['read', 'search'], 1, '1M', '最快最便宜，適合大量逐頁抽取事實');
            return mkc('均衡', old + '均衡快速｜規劃・讀取・搜尋', ['plan', 'read', 'search', 'critic'], 2, '1M', 'Google 搜尋接地；速度與品質平衡，讀取池主力');
        }
        if (/^gpt-/.test(v)) {
            if (/image|tts|audio|realtime|embedding|transcribe/i.test(v)) return none;
            if (/sol/.test(v)) return mkc('旗艦', '旗艦推理・1M 脈絡｜規劃・撰稿・審稿', ['plan', 'write', 'critic', 'read', 'search'], 3, '1.05M', 'OpenAI 旗艦推理；Responses web_search 搜尋');
            if (/mini/.test(v)) return mkc('輕量', '輕量低成本｜讀取', ['read'], 1, '128K', '便宜但脈絡短、推理弱，只適合讀取抽取');
            return mkc('均衡', '均衡快速｜規劃・讀取・搜尋', ['plan', 'read', 'search', 'critic'], 2, '', 'OpenAI 均衡模型；Responses web_search 搜尋');
        }
        if (/^grok-/.test(v)) {
            if (/multi|imagine|code/i.test(v)) return none;
            if (/non-reasoning/.test(v)) return mkc('快速', '快速｜即時情報', ['grok'], 1, '', 'Grok 無推理版，快、適合大量偵察');
            if (/reasoning|4\.20/.test(v)) return mkc('推理', '推理｜即時情報・反證', ['grok'], 2, '', 'Grok 推理版，適合交叉審查找反證');
            return mkc('旗艦', '即時情報＋X 搜尋｜Grok 池・交叉審查', ['grok'], 2, '', 'Grok 4.x：網頁＋X(推特)即時搜尋，社群反饋與反證');
        }
        return none;
    }
    function modelCatalog(onlyKeyed) {
        var has = { Gemini: !!K('gemini'), OpenAI: !!K('openai'), Grok: !!K('grok') }, out = [];
        [['gemini', 'Gemini'], ['openai', 'OpenAI'], ['grok', 'Grok']].forEach(function (kp) {
            if (onlyKeyed && !has[kp[1]]) return;
            (W._novaDrTextModelOptions(kp[0]) || []).forEach(function (o) { out.push({ value: o.value, label: o.label, provider: kp[1], caps: modelCaps(o.value), available: has[kp[1]] }); });
        });
        return out;
    }
    // 勾選式下拉：回傳 { el, get(), set(arr), onChange }
    function msBuild(groups, saved, onChange, ctx) {
        var box = mk('div', ''); box.className = 'nova-ms';
        var btn = mk('button'); btn.type = 'button'; btn.className = 'nova-ms-btn';
        var sum = mk('span'); sum.className = 'nova-ms-sum'; var arrow = mk('span', '', '▾'); arrow.className = 'nova-ms-arrow'; btn.append(sum, arrow);
        var panel = mk('div'); panel.className = 'nova-ms-panel'; panel.style.display = 'none';
        var cbs = [];
        groups.forEach(function (g) {
            if (!g.items.length) return;
            var h = mk('div', '', g.label); h.className = 'nova-ms-group'; panel.appendChild(h);
            g.items.forEach(function (o) {
                var lab = mk('label'); lab.className = 'nova-ms-item'; lab.style.minHeight = '40px';
                var cb = mk('input'); cb.type = 'checkbox'; cb.value = o.value; cb.style.cssText = 'accent-color:#a855f7;width:18px;height:18px;flex:none;';
                cb.checked = Array.isArray(saved) && saved.indexOf(o.value) !== -1;
                var t = mk('span', '', o.label); t.className = 'nova-ms-name';
                cb.onchange = function () { api.sync(); if (onChange) onChange(); };
                lab.append(cb, t);
                if (o.tag) { var tg = mk('span', '', o.tag); tg.className = 'nova-ms-tag'; lab.appendChild(tg); }
                panel.appendChild(lab); cbs.push(cb);
            });
        });
        box.append(btn, panel);
        var api = { el: box, panel: panel, cbs: cbs,
            get: function () { return cbs.filter(function (c) { return c.checked; }).map(function (c) { return c.value; }); },
            set: function (arr) { cbs.forEach(function (c) { c.checked = arr.indexOf(c.value) !== -1; }); api.sync(); },
            sync: function () {
                var names = cbs.filter(function (c) { return c.checked; }).map(function (c) { return c.parentNode.querySelector('.nova-ms-name').textContent; });
                sum.textContent = names.length ? ('已選 ' + names.length + ' 個：' + names.join('、')) : '未指定（沿用下方角色設定）';
                sum.classList.toggle('nova-ms-empty', !names.length);
            } };
        var place = function () {
            var r = btn.getBoundingClientRect(), below = window.innerHeight - r.bottom - 12, h = Math.max(160, Math.min(320, below > 200 ? below : r.top - 16));
            var w = Math.min(window.innerWidth - 16, Math.max(260, r.width));
            panel.style.width = w + 'px'; panel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px'; panel.style.maxHeight = h + 'px';
            if (below > 200) { panel.style.top = (r.bottom + 4) + 'px'; panel.style.bottom = 'auto'; } else { panel.style.bottom = (window.innerHeight - r.top + 4) + 'px'; panel.style.top = 'auto'; }
        };
        btn.onclick = function (e) { e.stopPropagation(); var open = panel.style.display === 'none'; ctx.closeAll(); if (open) { panel.style.display = 'block'; panel.style.position = 'fixed'; place(); } };
        ctx.panels.push(panel); api.sync(); return api;
    }

    function open(topicPrefill) {
        var old = document.getElementById('nova-dr-modal'); if (old) old.remove();
        try { document.getElementById('plus-menu').classList.add('hidden'); document.getElementById('plus-icon').classList.remove('rotate-45'); } catch (e) { /* ignore */ }
        var eng = W.NovaDeepResearch, pf = prefs();
        var cat = modelCatalog(false);
        var by = function (prov) { return cat.filter(function (m) { return m.provider === prov; }); };
        var ctx = { panels: [], closeAll: function () { ctx.panels.forEach(function (p) { p.style.display = 'none'; }); } };
        var overlay = mk('div', 'position:fixed;inset:0;z-index:9000;background:var(--nv-canvas,#020617);display:flex;flex-direction:column;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);color:var(--nv-text,#e2e8f0);');
        overlay.id = 'nova-dr-modal';
        var head = mk('div', 'display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--nv-line-strong,#334155);');
        head.appendChild(mk('b', 'flex:1;font-size:15px;', '🧠 多 AI 深度協同研究控制台'));
        var close = function () { ctx.panels.forEach(function (p) { if (p.parentNode) p.parentNode.removeChild(p); }); overlay.remove(); };
        var x = mk('button', 'background:transparent;border:0;color:var(--nv-muted,#94a3b8);font-size:20px;min-width:40px;min-height:40px;', '✕'); x.onclick = close; head.appendChild(x);
        var body = mk('div', 'flex:1;overflow-y:auto;padding:12px 16px;-webkit-overflow-scrolling:touch;');
        var fld = 'width:100%;box-sizing:border-box;background:var(--nv-card-2,#1e293b);color:var(--nv-text,#e2e8f0);border:1px solid var(--nv-line-strong,#334155);border-radius:9px;padding:9px 10px;font-size:16px;outline:none;font-family:inherit;';
        var card = function () { return mk('div', 'background:var(--nv-card,#0f172a);border:1px solid var(--nv-line-strong,#334155);border-radius:12px;padding:12px;margin-bottom:12px;'); };
        var lab = function (t, hint) { var l = mk('div', 'font-size:12px;font-weight:600;margin:10px 0 4px;', t); if (hint) l.appendChild(mk('span', 'font-weight:400;color:var(--nv-muted,#94a3b8);margin-left:6px;', hint)); return l; };
        var note = function (t) { return mk('div', 'font-size:11px;color:var(--nv-muted,#94a3b8);line-height:1.6;margin-top:6px;', t); };

        // 說明列
        var banner = mk('div', 'background:rgba(147,51,234,.14);border:1px solid rgba(168,85,247,.4);border-radius:12px;padding:10px 12px;margin-bottom:12px;font-size:12px;line-height:1.6;color:#d8b4fe;', 'Pro 引擎：1.規劃研究計畫樹 ➡️ 2.搜尋＋爬取來源 ➡️ 3.反思補查 ➡️ 4.Gemini×Grok 交叉審查 ➡️ 5.分章長文撰寫 ➡️ 6.引用溯源');

        // 選項
        var optSel = function (prov, saved, blankText) {
            var s = mk('select', fld); s.appendChild(new Option(blankText, ''));
            var provs = Array.isArray(prov) ? prov : [prov], all = [];
            provs.forEach(function (p) { var items = by(p); if (!items.length) return; var og = document.createElement('optgroup'); og.label = p; items.forEach(function (m) { all.push(m.value); og.appendChild(new Option(m.label + (m.caps.tag ? '　〔' + m.caps.tag + '〕' : ''), m.value)); }); s.appendChild(og); });
            s.value = all.indexOf(saved) !== -1 ? saved : ''; return s;
        };
        var refresh = function () { /* 於下方定義 */ };
        var onAny = function () { refresh(); };

        // ① 研究引擎卡
        var c1 = card();
        c1.appendChild(mk('div', 'font-size:12px;font-weight:700;margin-bottom:6px;', '🧠 研究引擎'));
        c1.appendChild(mk('div', 'font-size:13px;padding:9px 10px;border:1px solid var(--nv-line-strong,#334155);border-radius:9px;background:var(--nv-card-2,#1e293b);', '🚀 Pro 深度研究引擎（多輪爬取＋反思＋雙模型審查＋分章長文，可達 3～4 萬字）'));
        var depth = mk('select', fld); Object.keys(eng ? eng.DEPTH_PRESETS : { standard: 1 }).forEach(function (k) { depth.appendChild(new Option(eng ? eng.DEPTH_PRESETS[k].label : k, k)); }); depth.value = (pf.depth && eng && eng.DEPTH_PRESETS[pf.depth]) ? pf.depth : (eng && eng.DEPTH_PRESETS.deep ? 'deep' : 'standard');
        c1.append(lab('報告深度'), depth);
        var chk = function (text, checked, disabled, hint) { var w = mk('label', 'display:flex;align-items:flex-start;gap:8px;min-height:40px;font-size:13px;margin-top:6px;line-height:1.5;'); var c = mk('input'); c.type = 'checkbox'; c.checked = !!checked && !disabled; c.disabled = !!disabled; c.style.cssText = 'width:20px;height:20px;flex:none;margin-top:1px;accent-color:#a855f7;'; w.append(c, document.createTextNode(text + (disabled ? '（' + hint + '）' : ''))); return { w: w, c: c }; };
        var fc = chk('使用 Firecrawl 爬取網頁（可繞過反爬蟲、抓 JS 動態頁）', pf.useFirecrawl !== false, !K('firecrawl'), '尚未設定 Firecrawl Key，將改用 SerpApi／Gemini 搜尋＋直連讀頁');
        var gk = chk('啟用 Grok 即時情報＋與 Gemini 雙向交叉審查（找社群反饋與反證）', pf.useGrok !== false, !K('grok'), '尚未設定 Grok Key，將只用 Gemini 單模型');
        c1.append(fc.w, gk.w);
        // 進階
        var adv = document.createElement('details'); adv.style.cssText = 'border:1px solid var(--nv-line-strong,#334155);border-radius:10px;padding:8px 12px;margin-top:10px;';
        var sm = mk('summary', 'font-size:12px;font-weight:700;cursor:pointer;min-height:32px;line-height:32px;', '🎛 進階：細部指定每個角色的模型與並行搜尋（可不動，預設沿用下方設定）'); adv.appendChild(sm);
        var mPlanner = optSel(['Gemini', 'OpenAI'], pf.planner, '（跟下方角色設定相同）'), mWriter = optSel(['Gemini', 'OpenAI'], pf.writer, '（跟下方角色設定相同）'), mCritic = optSel(['Gemini', 'OpenAI'], pf.critic, '（跟下方角色設定相同）'), mGrokRev = optSel(['Grok'], pf.grokReview, '（跟下方角色設定相同）');
        adv.append(lab('🧭 規劃 Planner'), mPlanner, lab('✍️ 撰稿 Writer', '決定文章品質'), mWriter, lab('🧐 審稿 Critic／查核'), mCritic, lab('⚖️ Grok 交叉審查'), mGrokRev);
        var grpsOf = function (provs) { return provs.map(function (p) { return { label: p + (p === 'Gemini' ? '（Google 搜尋接地）' : (p === 'OpenAI' ? '（Responses web_search）' : '（網頁＋X 即時搜尋）')), items: by(p).map(function (m) { return { value: m.value, label: m.label, tag: m.caps.tag }; }) }; }); };
        var preset = function (ms, mode) { ms.set(ms.cbs.filter(function (c) { var v = c.value; return mode === 'all' ? true : mode === 'flash' ? (/^gemini-/.test(v) && /flash/i.test(v) && !/lite/i.test(v)) : mode === 'openai' ? (/^gpt-/.test(v) && !/mini/.test(v)) : false; }).map(function (c) { return c.value; })); onAny(); };
        var presetLinks = function (ms, defs) { var w = mk('span', 'margin-left:6px;'); defs.forEach(function (d) { var a = mk('a', 'color:#c4b5fd;margin-right:10px;text-decoration:underline;display:inline-block;min-height:28px;', d[1]); a.href = 'javascript:void(0)'; a.onclick = function () { preset(ms, d[0]); }; w.appendChild(a); }); return w; };
        var poolReader = msBuild(grpsOf(['Gemini', 'OpenAI']), pf.readerPool, onAny, ctx), poolSearch = msBuild(grpsOf(['Gemini', 'OpenAI']), pf.searcherPool, onAny, ctx), poolGrok = msBuild(grpsOf(['Grok']), pf.grokPool, onAny, ctx);
        var lr = lab('🔍 讀取抽取池 Reader', '勾多個＝並行，各模型額度獨立、被限流自動改派；不勾＝只用下方「資料研究員」'); lr.appendChild(presetLinks(poolReader, [['flash', 'Flash 全部'], ['openai', 'OpenAI'], ['all', '全選'], ['none', '清除']]));
        var ls = lab('🌐 搜尋接地池 Searcher', 'Gemini 用 Google 搜尋、OpenAI 用 web_search；不勾＝沿用讀取池'); ls.appendChild(presetLinks(poolSearch, [['flash', 'Flash 全部'], ['none', '清除']]));
        var lg = lab('⚔️ Grok 池', '即時情報與偵察並行、輪流派給勾選的模型；不勾＝審查委員的 Grok 或目前使用的 Grok'); lg.appendChild(presetLinks(poolGrok, [['all', '全選'], ['none', '清除']]));
        var strategy = mk('select', fld); [['chain', '依序備援（最省額度：Firecrawl → SerpApi → Gemini 搜尋，第一個有結果就用）'], ['parallel', '平行多管道（同時搜、結果合併，多管道都找到的來源加分；耗額度較多、較快較全）'], ['max', '全力（平行多管道＋Grok 依章節當資料偵察員找權威網址，需啟用 Grok）']].forEach(function (s) { strategy.appendChild(new Option(s[1], s[0])); }); strategy.value = ['chain', 'parallel', 'max'].indexOf(pf.strategy) !== -1 ? pf.strategy : 'chain';
        adv.append(lr, poolReader.el, ls, poolSearch.el, lg, poolGrok.el, lab('🕸️ 搜尋策略', '同一條查詢要不要同時派給多個管道'), strategy, note('「分派」由引擎的排程器負責：主模型規劃出章節與查詢後，這些就是可並行的工作單位，依「沒被限流、用得最少」的原則派給池內模型；某個模型 429 或不可用會自動改派、冷卻後再用。'));
        c1.appendChild(adv);
        var est = mk('div', 'font-size:12px;color:var(--nv-muted,#94a3b8);margin-top:10px;line-height:1.6;');
        c1.append(est, note('角色對應：🧠 專案經理＆總編輯＝規劃／審稿／撰寫（建議 Gemini 3.x Flash 或 Pro）；🔍 資料研究員＝逐頁讀取並抽取事實（用量最大，建議 Flash）；⚖️ 審查委員＝若選 Grok 模型，就作為即時情報與交叉審查的 Grok 版本。'));

        // ② 主題＋檔案
        var c2 = card();
        c2.appendChild(mk('div', 'font-size:12px;font-weight:700;margin-bottom:6px;', '🎯 研究主題或目標任務'));
        var topic = mk('textarea', fld + 'min-height:84px;resize:vertical;'); topic.placeholder = '例如：分析2026年全球固態電池的商業化進程與主要玩家，並給出投資建議。'; topic.value = topicPrefill || '';
        c2.appendChild(topic);
        var files = [];
        var fileRow = mk('div', 'display:flex;align-items:center;gap:8px;margin-top:10px;padding-top:10px;border-top:1px solid var(--nv-line,#1e293b);flex-wrap:wrap;');
        var fileLab = mk('label', 'cursor:pointer;background:var(--nv-card-2,#1e293b);color:var(--nv-text,#e2e8f0);border:1px solid var(--nv-line-strong,#334155);padding:0 12px;min-height:40px;display:inline-flex;align-items:center;gap:6px;border-radius:9px;font-size:12px;font-weight:700;', '📎 上傳參考檔案');
        var fin = mk('input'); fin.type = 'file'; fin.multiple = true; fin.style.display = 'none'; fileLab.appendChild(fin);
        var fname = mk('span', 'font-size:12px;color:var(--nv-muted,#94a3b8);', '未選擇檔案');
        var fclear = mk('button', 'display:none;background:var(--nv-card-2,#1e293b);color:var(--nv-muted,#94a3b8);border:1px solid var(--nv-line-strong,#334155);border-radius:8px;min-width:36px;min-height:36px;', '✕');
        fclear.onclick = function () { files = []; fin.value = ''; fname.textContent = '未選擇檔案'; fclear.style.display = 'none'; };
        fin.onchange = async function () {
            var list = Array.from(fin.files || []);
            for (var i = 0; i < list.length; i++) {
                var f = list[i], isImage = (f.type || '').indexOf('image/') === 0, isMedia = /^(audio|video)/.test(f.type || ''), low = f.name.toLowerCase(), isExcel = /\.(xlsx|xls|csv)$/.test(low), isText = (f.type || '').indexOf('text/') === 0 || /\.(txt|md)$/.test(low) || isExcel;
                var category = isImage ? 'image' : (isMedia ? 'media' : (isText ? 'text' : 'document'));
                var data = await new Promise(function (resolve) {
                    var r = new FileReader();
                    r.onload = function (evt) {
                        if (isExcel && !/\.csv$/.test(low)) { try { var wb = XLSX.read(new Uint8Array(evt.target.result), { type: 'array' }), out = ''; wb.SheetNames.forEach(function (n) { out += '[Sheet: ' + n + ']\n' + XLSX.utils.sheet_to_csv(wb.Sheets[n]) + '\n\n'; }); resolve(out); } catch (e) { resolve('Excel 解析失敗：' + e.message); } }
                        else resolve(evt.target.result);
                    };
                    r.onerror = function () { resolve(''); };
                    if (isExcel && !/\.csv$/.test(low)) r.readAsArrayBuffer(f); else if (category === 'text') r.readAsText(f); else r.readAsDataURL(f);
                });
                files.push({ category: category, name: f.name, mime: f.type || 'application/octet-stream', data: data });
            }
            fname.textContent = '已選取 ' + files.length + ' 個檔案'; fclear.style.display = files.length ? '' : 'none'; fin.value = '';
        };
        fileRow.append(fileLab, fname, fclear); c2.appendChild(fileRow);

        // ③ 指派
        var c3 = card();
        var h3 = mk('div', 'display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:8px;');
        h3.appendChild(mk('div', 'font-size:12px;font-weight:700;', '👥 指派參與協作的 AI 模型'));
        var assignBtn = mk('button', 'min-height:40px;', '🤖 AI 模型智能分配'); assignBtn.type = 'button'; assignBtn.className = 'nova-assign-btn'; assignBtn.title = '由 Gemini 3.1 Pro 判斷任務性質，依各模型能力直接改寫下方與「進階」裡的模型設定';
        h3.appendChild(assignBtn); c3.appendChild(h3);
        var assignOut = mk('div'); assignOut.className = 'nova-assign-result'; assignOut.style.display = 'none'; c3.appendChild(assignOut);
        var defGem = (function () { var o = by('Gemini'); var cur = (W.appState && appState.geminiModel) || ''; if (o.some(function (m) { return m.value === cur; })) return cur; var fl = o.filter(function (m) { return /flash/i.test(m.value) && !/lite/i.test(m.value); })[0]; return (fl || o[0] || {}).value || ''; })();
        var roleSel = function (provs, saved, fallback) { var s = optSel(provs, saved || fallback, '（自動選擇）'); if (!s.value && fallback) s.value = fallback; return s; };
        var orch = roleSel(['Gemini', 'OpenAI'], pf.orchestrator, defGem), resr = roleSel(['Gemini', 'OpenAI'], pf.researcher, defGem), verf = roleSel(['Gemini', 'OpenAI', 'Grok'], pf.verifier, '');
        c3.append(lab('🧠 專案經理 & 總編輯'), orch, lab('🔍 資料研究員'), resr, lab('⚖️ 邏輯審查委員'), verf);

        // 估算
        refresh = function () {
            if (!eng) { est.textContent = '找不到引擎（deep-research-engine.js 沒有載入）'; return; }
            var useGrok = gk.c.checked && !!K('grok'), st = (strategy.value === 'max' && !useGrok) ? 'parallel' : strategy.value;
            var e = eng.estimate(depth.value, { useGrok: useGrok, hasFirecrawl: fc.c.checked && !!K('firecrawl'), hasSerpApi: !!K('serpapi'), searchStrategy: st, readerPoolSize: Math.max(1, poolReader.get().length), grokPoolSize: Math.max(1, poolGrok.get().length) });
            est.textContent = '預估：約 ' + e.sections + ' 章、' + e.approxChars.toLocaleString() + ' 字；最多讀取 ' + e.sources + ' 個來源' + (e.readConcurrency ? '（讀取並行度 ' + e.readConcurrency + '）' : '') + '；Gemini 約 ' + e.geminiCalls + ' 次' + (e.grokCalls ? '、Grok 約 ' + e.grokCalls + ' 次' : '') + '。研究期間請保持 App 開啟（螢幕可關，已啟用背景保活）。';
        };
        [depth, strategy, fc.c, gk.c].forEach(function (el) { el.onchange = onAny; });

        // 智能分配
        var ASSIGN_MODEL = 'gemini-3.1-pro-preview';
        var say = function (lines, bad) { assignOut.style.display = ''; assignOut.textContent = ''; assignOut.classList.toggle('nova-assign-bad', !!bad); lines.forEach(function (ln) { assignOut.appendChild(mk('div', '', ln)); }); };
        assignBtn.onclick = async function () {
            var tp = topic.value.trim(), fileNames = files.map(function (f) { return f.name; });
            if (!tp && !fileNames.length) { say(['請先在「研究主題或目標任務」輸入主題（或上傳參考檔案），AI 才能判斷任務性質。'], true); return; }
            if (!K('gemini')) { say(['智能分配固定使用 ' + ASSIGN_MODEL + '，需要先在設定頁填入 Gemini API Key。'], true); return; }
            var cs = modelCatalog(true).filter(function (m) { return m.caps.best.length; });
            var gp = cs.filter(function (m) { return m.provider !== 'Grok'; }), gkm = cs.filter(function (m) { return m.provider === 'Grok'; });
            var val = function (a) { return a.map(function (m) { return m.value; }); }, gpV = val(gp), gkV = val(gkm), grokOk = gkV.length > 0 && !!K('grok');
            var line = function (m) { var c = m.caps; return '- ' + m.value + '｜' + m.provider + '｜' + c.tier + '｜成本' + c.cost + '/3｜適合角色:' + c.best.join('/') + (c.ctx ? '｜脈絡:' + c.ctx : '') + '｜' + c.note; };
            var system = '你是 AI 模型調度專家。依「研究任務的性質」把可用模型分派到各角色，只輸出一個 JSON 物件，不要任何說明文字或 Markdown。';
            var text = [
                '【研究任務】' + (tp || '（只有上傳檔案）') + (fileNames.length ? '\n【參考檔案】' + fileNames.slice(0, 8).join('、') : ''),
                '【引擎】Pro 深度研究引擎（多輪爬取＋反思＋分章長文）；專案經理/研究員只能選 Gemini 或 OpenAI 模型；報告深度：' + depth.value,
                '【可用模型（只能從這些 value 挑，已排除沒有金鑰的供應商）】',
                gp.concat(gkm).map(line).join('\n'),
                '【角色說明】orchestrator＝專案經理＆總編輯（規劃／撰寫，決定文章品質）；researcher＝資料研究員（逐頁讀取抽事實，用量最大）；verifier＝邏輯審查委員（若選 Grok 則作為即時情報與交叉審查的 Grok 版本）。planner 規劃、writer 撰稿、critic 審稿（皆從 Gemini/OpenAI 選，留空字串＝沿用 orchestrator）；readerPool 讀取池／searcherPool 搜尋接地池（Gemini/OpenAI，可多選並行，各模型額度獨立，讀取量大請用便宜快速的 2~4 個）；grokPool 與 grokReview 只能是 Grok；strategy 為 chain|parallel|max；useGrok 布林。',
                '【分派原則】1) 先判斷任務性質（例：時事/社群輿情、技術/學術、財經投資、長文白皮書、資料整理…）；2) 撰稿 writer 用最強模型；3) 審稿 critic 盡量用與 writer 不同供應商的模型，增加獨立性；4) 讀取池用快速低成本模型（成本1~2），不要拿成本3的旗艦做大量讀取；5) 需要最新資訊／社群反饋才啟用 Grok 與 max 策略；6) 不要選沒列出的模型；7) ' + (grokOk ? '' : '目前沒有可用的 Grok，useGrok 必須為 false，grokPool 為空陣列。'),
                '【輸出 JSON 格式】{"taskType":"一句話任務性質","reason":"2~3句分派理由","orchestrator":"value","researcher":"value","verifier":"value","planner":"value或空字串","writer":"value","critic":"value","readerPool":["value"],"searcherPool":["value"],"grokPool":["value"],"grokReview":"value或空字串","strategy":"chain|parallel|max","useGrok":true}'
            ].join('\n');
            assignBtn.disabled = true; var oldTxt = assignBtn.textContent; assignBtn.textContent = '⏳ ' + ASSIGN_MODEL + ' 分析中…';
            say(['正在請 ' + ASSIGN_MODEL + ' 判斷任務性質並分派模型…']);
            try {
                var res = await callGemini({ model: ASSIGN_MODEL, system: system, text: text, json: true, thinking: 'low', maxOutputTokens: 16384, timeoutSec: 100 });
                var raw = String(res.text || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim(), a = raw.indexOf('{'), b = raw.lastIndexOf('}');
                if (a < 0 || b < a) throw new Error('回傳內容不是 JSON：' + raw.slice(0, 120));
                var r = JSON.parse(raw.slice(a, b + 1)), inL = function (l) { return function (v) { return l.indexOf(v) !== -1; }; }, okGp = inL(gpV), okGk = inL(gkV), okAll = inL(gpV.concat(gkV)), lines = [], warn = [];
                var nameOf = function (v) { var m = cs.filter(function (x) { return x.value === v; })[0]; return m ? (m.provider === 'OpenAI' ? 'OpenAI ' : '') + m.label : v; };
                var setSel = function (el, v, label, check, blankOk) {
                    if (v === '' && blankOk) { el.value = ''; lines.push(label + '：沿用下方角色'); return; }
                    if (!check(v) || !Array.from(el.options).some(function (o) { return o.value === v; })) { if (v) warn.push(label + ' 的建議「' + v + '」不在可用清單，已保留原設定'); return; }
                    el.value = v; lines.push(label + '：' + nameOf(v));
                };
                setSel(orch, r.orchestrator, '🧠 專案經理＆總編輯', okGp); setSel(resr, r.researcher, '🔍 資料研究員', okGp); setSel(verf, r.verifier, '⚖️ 邏輯審查委員', okAll);
                setSel(mPlanner, r.planner || '', '🧭 規劃 Planner', okGp, true); setSel(mWriter, r.writer || '', '✍️ 撰稿 Writer', okGp, true); setSel(mCritic, r.critic || '', '🧐 審稿 Critic', okGp, true); setSel(mGrokRev, grokOk ? (r.grokReview || '') : '', '⚖️ Grok 交叉審查', okGk, true);
                var setPool = function (ms, arr, label, check) { var want = (Array.isArray(arr) ? arr : []).filter(check); ms.set(want); lines.push(label + '：' + (want.length ? want.map(nameOf).join('、') : '不指定（沿用下方）')); };
                setPool(poolReader, r.readerPool, '🔍 讀取池', okGp); setPool(poolSearch, r.searcherPool, '🌐 搜尋接地池', okGp); setPool(poolGrok, grokOk ? r.grokPool : [], '⚔️ Grok 池', okGk);
                var useG = grokOk && r.useGrok !== false; if (!gk.c.disabled) gk.c.checked = useG;
                var strat = ['chain', 'parallel', 'max'].indexOf(r.strategy) !== -1 ? r.strategy : 'chain'; if (strat === 'max' && !useG) strat = 'parallel';
                strategy.value = strat; lines.push('🕸️ 搜尋策略：' + ({ chain: '依序備援', parallel: '平行多管道', max: '全力' }[strat]));
                adv.open = true; refresh();
                assignOut.style.display = ''; assignOut.textContent = ''; assignOut.classList.remove('nova-assign-bad');
                var hh = mk('div', '', '✅ 已依任務性質改寫設定（' + ASSIGN_MODEL + '）'); hh.className = 'nova-assign-h'; assignOut.appendChild(hh);
                assignOut.appendChild(mk('div', '', '📌 任務性質：' + String(r.taskType || '').slice(0, 120)));
                if (r.reason) assignOut.appendChild(mk('div', '', '💡 ' + String(r.reason).slice(0, 400)));
                lines.forEach(function (ln) { assignOut.appendChild(mk('div', '', '・' + ln)); });
                warn.forEach(function (ln) { var d = mk('div', '', '⚠ ' + ln); d.className = 'nova-assign-warn'; assignOut.appendChild(d); });
            } catch (e) { say(['智能分配失敗（' + ASSIGN_MODEL + '）：' + (e && e.message ? e.message : e), '設定沒有被改動，可以重按一次，或手動指定。'], true); }
            finally { assignBtn.disabled = false; assignBtn.textContent = oldTxt; }
        };

        body.append(banner, c1, c2, c3);
        // 點到面板以外就收起下拉；捲動視窗本體時也收起（面板自己的捲動不收）
        var outside = function (e) { if (e.target && e.target.closest && (e.target.closest('.nova-ms-panel') || e.target.closest('.nova-ms-btn'))) return; ctx.closeAll(); };
        overlay.addEventListener('pointerdown', outside, true);
        body.addEventListener('scroll', function () { ctx.closeAll(); }, { passive: true });
        var foot = mk('div', 'display:flex;gap:10px;padding:10px 16px;border-top:1px solid var(--nv-line-strong,#334155);');
        var cancel = mk('button', 'flex:0 0 auto;min-height:44px;padding:0 18px;border-radius:10px;border:1px solid var(--nv-line-strong,#334155);background:var(--nv-card-2,#1e293b);color:var(--nv-text,#e2e8f0);font-size:14px;', '取消'); cancel.onclick = close;
        var go = mk('button', 'flex:1;min-height:44px;border-radius:10px;border:0;background:#9333ea;color:#fff;font-size:15px;font-weight:700;', '🚀 開始分析作業');
        go.onclick = function () {
            var p = { topic: topic.value, depth: depth.value, orchestrator: orch.value, researcher: resr.value, verifier: verf.value, useFirecrawl: fc.c.checked, useGrok: gk.c.checked, files: files,
                pro: { planner: mPlanner.value, writer: mWriter.value, critic: mCritic.value, grokReview: mGrokRev.value, readerPool: poolReader.get(), searcherPool: poolSearch.get(), grokPool: poolGrok.get(), strategy: strategy.value } };
            close(); start(p);
        };
        foot.append(cancel, go); overlay.append(head, body, foot); document.body.appendChild(overlay);
        // 面板掛在 overlay 上（position:fixed）
        ctx.panels.forEach(function (p) { overlay.appendChild(p); });
        refresh();
    }

    W.NovaProResearch = { open: open, start: start, isActive: function () { return !!W._novaDrActive; }, buildDeps: buildDeps };
    W.openProResearch = open;
})();

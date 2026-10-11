/* ═══════════════════════════════════════════════════════════════════════
   nova-llm.js — NOVA Android 的「模型呼叫輔助層」（跟 index.html 放同一個資料夾 www/）
   版本：v1.0.0
   版本紀錄：
   v1.0.0 - 初版（批次 4）。把桌面版 index.html 裡 _novaDr* ／ _novaCallModel 這組「多專家／深度研究引擎共用的小工具」
            獨立成一支檔案，讓手機版的多專家協作（nova-experts-glue.js）、之後的深度研究 Pro 引擎共用：
            ① 模型名稱解析：_novaDrResolveGeminiModel／GptModel／GrokModel（舊模型自動轉新版、不適合的換成預設）。
            ② _novaDrGeminiApiVer（v1alpha／v1beta）、_novaDrThinkingConfig（thinkingLevel／thinkingBudget）。
            ③ _novaOpenAiParseResponses（Responses API 回應 → {text, sources}）。
            ④ _novaLLMProxyFetch：手機版沒有 sidecar 代理，CapacitorHttp 已把 fetch 換成原生請求，所以這裡直接 fetch；
               原生請求不吃 AbortSignal，因此額外用 Promise.race 讓「停止」立刻生效（背景請求會自然結束，結果被丟棄）。
            ⑤ _novaCallModel（Grok 文字對話）、_novaDrCallGrok（Grok Responses API ＋ web_search）。
            ⑥ _novaDrTextModelOptions：從主畫面的子模型下拉選單取出可當「專家」的文字模型清單（會尊重「啟用的模型」過濾）。
            ⑦ _novaDrPostReportMessage：把報告貼回指定對話（手機版 addMessage 只吃目前對話，所以這裡自己組訊息）。
   依賴（全域）：appState、genMsgId、getTime、saveToDB、scheduleEmergencyBackup、renderMessages、renderChatHistoryList。
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';
    var W = window;
    function def(name, fn) { if (typeof W[name] !== 'function') W[name] = fn; }

    def('_novaDrGeminiApiVer', function (model) {
        var m = String(model || '');
        return (m.includes('preview') || m.includes('gemini-3') || m.includes('thinking') || m.includes('research') || m.includes('computer') || m.includes('-image') || m.includes('nano-banana')) ? 'v1alpha' : 'v1beta';
    });

    def('_novaDrThinkingConfig', function (model, level) {
        if (!level) return null;
        var name = String(model || '').toLowerCase();
        if (name.indexOf('image') !== -1 || name.indexOf('imagen') !== -1 || name.indexOf('lite') !== -1) return null;
        var isPro = name.indexOf('pro') !== -1;
        var lvl = ['minimal', 'low', 'medium', 'high'].indexOf(level) !== -1 ? level : 'low';
        if (/^gemini-3/.test(name)) {
            if (lvl === 'minimal' && (isPro || /^gemini-3\.8/.test(name))) return { thinkingLevel: 'LOW' };
            return { thinkingLevel: lvl.toUpperCase() };
        }
        if (/^gemini-2\.5/.test(name)) {
            var budgets = { minimal: isPro ? 128 : 0, low: 1024, medium: 4096, high: 8192 };
            return { thinkingBudget: budgets[lvl] };
        }
        return null;
    });

    def('_novaDrResolveGeminiModel', function (name, fallback) {
        var n = String(name || '').trim();
        var bad = !n || n.indexOf('gemini-') !== 0 || /multi|image|imagen|nano-banana|tts|live|audio|embedding|veo|robotics|computer/i.test(n);
        if (n === 'gemini-3.5-flash') return 'gemini-3.6-flash';
        if (n === 'gemini-3.7-flash') return 'gemini-3.8-flash';
        return bad ? (fallback || W.NOVA_GEMINI_MODEL_DEFAULT || 'gemini-3.6-flash') : n;
    });
    def('_novaDrResolveGptModel', function (name) {
        var n = String(name || '').trim();
        return (n.indexOf('gpt-') === 0 && !/image|tts|audio|realtime|embedding|transcribe/i.test(n)) ? n : ((W.appState && appState.gptModel) || 'gpt-6-luna');
    });
    def('_novaDrResolveGrokModel', function (name) {
        var n = String(name || '').trim();
        var bad = !n || n.indexOf('grok-') !== 0 || /multi|imagine|code/i.test(n);
        return bad ? 'grok-4.3' : n;
    });

    def('_novaOpenAiParseResponses', function (data) {
        var text = '', seen = {}, sources = [];
        ((data && data.output) || []).forEach(function (item) {
            if (item.type === 'message' && Array.isArray(item.content)) item.content.forEach(function (c) {
                if (c.type === 'output_text') {
                    if (c.text) text += c.text;
                    (c.annotations || []).forEach(function (a) { if (a.type === 'url_citation' && a.url && !seen[a.url]) { seen[a.url] = 1; sources.push({ title: a.title || '參考連結', uri: a.url }); } });
                }
            });
        });
        if (!text && data && typeof data.output_text === 'string') text = data.output_text;
        return { text: text, sources: sources };
    });

    // 手機版：直接 fetch（CapacitorHttp 原生請求）；AbortSignal 用 race 保證能立即中止。
    def('_novaLLMProxyFetch', function (url, opts) {
        opts = opts || {};
        var sig = opts.signal;
        var o = Object.assign({}, opts); delete o.novaTimeoutSec;
        var p = fetch(url, o);
        if (!sig) return p;
        return new Promise(function (resolve, reject) {
            var done = false;
            var onAbort = function () { if (done) return; done = true; var e = new Error('aborted'); e.name = 'AbortError'; reject(e); };
            if (sig.aborted) return onAbort();
            sig.addEventListener('abort', onAbort, { once: true });
            p.then(function (r) { if (done) return; done = true; resolve(r); }, function (e) { if (done) return; done = true; reject(e); });
        });
    });

    function withTimeout(url, opts, ms) {
        var c = new AbortController();
        var t = setTimeout(function () { try { c.abort('timeout'); } catch (e) { c.abort(); } }, ms || 180000);
        return W._novaLLMProxyFetch(url, Object.assign({}, opts, { signal: c.signal })).then(function (r) { clearTimeout(t); return r; }, function (e) { clearTimeout(t); if (c.signal.aborted) throw new Error('連線逾時（' + Math.round((ms || 180000) / 1000) + ' 秒）'); throw e; });
    }

    // Grok 文字對話（chat/completions）。opts: {model, systemInstruction, userText, timeoutMs}
    def('_novaCallModel', async function (opts) {
        opts = opts || {};
        var key = (W.appState && appState.keys && appState.keys.grok) || localStorage.getItem('nova_key_grok') || '';
        if (!key) throw new Error('尚未設定 Grok API Key');
        var msgs = [];
        if (opts.systemInstruction) msgs.push({ role: 'system', content: opts.systemInstruction });
        msgs.push({ role: 'user', content: opts.userText || '' });
        var res = await withTimeout('https://api.x.ai/v1/chat/completions', { method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: opts.model, messages: msgs }) }, opts.timeoutMs || 180000);
        var raw = await res.text();
        var data = null; try { data = JSON.parse(raw); } catch (e) { data = null; }
        if (!res.ok) { var er = new Error('Grok API 錯誤：' + ((data && data.error && (data.error.message || data.error)) || raw.slice(0, 200))); er.status = res.status; throw er; }
        var m = data && data.choices && data.choices[0] && data.choices[0].message;
        return { text: (m && m.content) || '', provider: 'grok', raw: data };
    });

    // Grok Responses API ＋ web_search。o: {model,text,timeoutMs,xSearch}
    def('_novaDrCallGrok', async function (o) {
        var key = (W.appState && appState.keys && appState.keys.grok) || localStorage.getItem('nova_key_grok') || '';
        if (!key) throw new Error('尚未設定 Grok API Key');
        var once = async function (withX) {
            var tools = [{ type: 'web_search' }]; if (withX) tools.push({ type: 'x_search' });
            var payload = { model: o.model, input: [{ role: 'user', content: o.text }], tools: tools, include: ['no_inline_citations'] };
            var res = await withTimeout('https://api.x.ai/v1/responses', { method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, o.timeoutMs || 240000);
            var t = await res.text();
            if (!res.ok) { var err = new Error('Grok API 錯誤：' + t.slice(0, 300)); err.status = res.status; throw err; }
            var data = JSON.parse(t), out = '';
            (data.output || []).forEach(function (item) { if (item.type === 'message' && Array.isArray(item.content)) item.content.forEach(function (c) { if (c.type === 'output_text' && c.text) out += c.text; }); });
            return { text: out, citations: Array.isArray(data.citations) ? data.citations : [] };
        };
        var wantX = !!o.xSearch && !W._novaDrXSearchBroken;
        try { return await once(wantX); } catch (e) {
            if (wantX && /x_search|unsupported|not support|invalid.*tool|tool.*invalid|unknown.*tool/i.test(String(e.message))) { W._novaDrXSearchBroken = true; return await once(false); }
            throw e;
        }
    });

    // 從主畫面子模型下拉選單取文字模型（kind: gemini／grok／openai）。
    def('_novaDrTextModelOptions', function (kind) {
        var sel = document.getElementById(kind === 'gemini' ? 'gemini-sub-model-select' : kind === 'openai' ? 'gpt-sub-model-select' : 'grok-sub-model-select');
        var out = [];
        if (!sel) return out;
        Array.prototype.slice.call(sel.querySelectorAll('option')).forEach(function (op) {
            var v = op.value;
            var okGem = kind === 'gemini' && v.indexOf('gemini-') === 0 && !/multi|image|imagen|nano-banana|tts|live|audio|embedding|veo|robotics|computer/i.test(v);
            var okGrok = kind === 'grok' && v.indexOf('grok-') === 0 && !/multi|imagine|code/i.test(v);
            var okGpt = kind === 'openai' && v.indexOf('gpt-') === 0 && !/image|tts|audio|realtime|embedding|transcribe/i.test(v);
            if ((okGem || okGrok || okGpt) && !op.disabled && !op.hidden) out.push({ value: v, label: op.textContent.trim() });
        });
        return out;
    });

    // 把報告貼回指定對話（sessionId 預設目前對話）
    def('_novaDrPostReportMessage', function (text, modelName, sessionId) {
        var msg = { id: genMsgId(), sessionId: sessionId || appState.currentSessionId, text: text, sender: 'ai', model: modelName || appState.currentModel, time: getTime(), sources: [], files: [], actionData: null };
        appState.messages.push(msg);
        saveToDB('messages', msg);
        scheduleEmergencyBackup();
        if (String(msg.sessionId) === String(appState.currentSessionId)) renderMessages();
        if (typeof renderChatHistoryList === 'function') renderChatHistoryList();
        return msg;
    });
})();

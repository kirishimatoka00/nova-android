/* ═════════════════════════════════════════════════════════════════
   nova-lean-llm.js — NOVA Android 輕量模型呼叫（給「專案視窗」「AI 思考」這類背景整理工作用；跟 index.html 放同一個資料夾 www/）
   版本：v1.1.0
   版本紀錄：
   v1.1.0 - App v2.6.151（對標桌面 nova-app-main.js v1.24.0 ⑥ pickModel）：加入 DeepSeek——主模型選 DeepSeek（或指定 deepseek- 模型）時，
            Project Insight、NovaResearch、專案視窗、AI 思考等背景整理工作改用 DeepSeek（NovaDeepSeek.chat，思考強度 low）；缺 DeepSeek 金鑰時照舊退回有金鑰的模型。
            novaLeanHasKey 多 'deepseek'。
   v1.0.0 - App v2.6.64。window.novaLeanLLM({system,user,timeoutMs,model})：不帶對話歷史、不注入記憶、不套回覆長度設定，
            直接依「指定模型（或目前聊天模型）」呼叫 Gemini／Grok／OpenAI 的 REST；缺該家 API Key 時退回有 Key 的 Gemini。
            window.novaLeanHasKey(provider)：provider = gemini | grok | gpt。
   ═════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';
    var W = window;
    function keys() { return (W.appState && appState.keys) || {}; }
    function hasKey(p) { var k = keys(); if (p === 'deepseek') return !!(k.deepseek || localStorage.getItem('nova_key_deepseek')); if (p === 'gemini') return !!k.gemini; if (p === 'grok') return !!k.grok; if (p === 'gpt') return !!(k.gpt || k.openai || localStorage.getItem('nova_key_openai')); return false; }
    function gptKey() { var k = keys(); return k.gpt || k.openai || localStorage.getItem('nova_key_openai') || ''; }
    function provOf(id) { id = String(id || ''); if (/^deepseek[-:]/.test(id)) return 'deepseek'; if (/^gpt-/.test(id)) return 'gpt'; if (/^grok-/.test(id)) return 'grok'; if (/^gemini-/.test(id)) return 'gemini'; return ''; }
    function resolve(model) {
        var S = W.appState || {}, p, id;
        if (model) { p = provOf(model); id = model; }
        if (!p || !hasKey(p)) {
            p = S.currentModel; id = p === 'gemini' ? S.geminiModel : p === 'grok' ? S.grokModel : p === 'gpt' ? S.gptModel : p === 'deepseek' ? S.deepseekModel : '';
        }
        if (p !== 'gemini' && p !== 'grok' && p !== 'gpt' && p !== 'deepseek') { p = 'gemini'; id = ''; }
        if (!hasKey(p)) { p = ['gemini', 'grok', 'gpt', 'deepseek'].filter(hasKey)[0] || 'gemini'; id = ''; }
        if (p === 'gemini' && (!id || /multi|auto/.test(id))) id = W.NOVA_GEMINI_MODEL_DEFAULT || 'gemini-3.6-flash';
        if (p === 'grok' && (!id || /multi|auto|imagine|image/.test(id))) id = 'grok-4.3';
        if (p === 'gpt' && !id) id = 'gpt-6-luna';
        if (p === 'deepseek') id = (W._novaMigrateDeepseekId ? W._novaMigrateDeepseekId(id || 'deepseek-v4-pro') : (id || 'deepseek-v4-pro'));
        return { p: p, id: id };
    }
    function race(p, ms) { return Promise.race([p, new Promise(function (_, rej) { setTimeout(function () { rej(new Error('模型回應逾時')); }, ms); })]); }
    async function call(o) {
        o = o || {}; var r = resolve(o.model), ms = o.timeoutMs || 120000, res, data;
        if (!hasKey(r.p)) throw new Error('尚未設定任何可用的 API Key');
        if (r.p === 'deepseek') {   // v1.1.0：走 NovaDeepSeek.chat（不搜尋、不帶附件；背景整理用，思考強度低）
            if (!W.NovaDeepSeek || !NovaDeepSeek.chat) throw new Error('DeepSeek 模組沒有載入（nova-deepseek.js）');
            var dr = await race(NovaDeepSeek.chat({ model: r.id, system: o.system || '', text: o.user || '', thinking: 'low', timeoutMs: ms }), ms + 5000);
            return String(dr.text || '').trim();
        }
        if (r.p === 'gemini') {
            res = await race(fetch('https://generativelanguage.googleapis.com/v1beta/models/' + r.id + ':generateContent?key=' + keys().gemini, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: o.user || '' }] }], systemInstruction: { parts: [{ text: o.system || '' }] }, generationConfig: { maxOutputTokens: 8192 } }) }), ms);
            if (!res.ok) throw new Error('Gemini 呼叫失敗 ' + res.status);
            data = await res.json(); var c = data.candidates && data.candidates[0];
            return ((c && c.content && c.content.parts || []).map(function (x) { return x.text || ''; }).join('')).trim();
        }
        var url = r.p === 'grok' ? 'https://api.x.ai/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions';
        var key = r.p === 'grok' ? keys().grok : gptKey();
        res = await race(fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify({ model: r.id, messages: [{ role: 'system', content: o.system || '' }, { role: 'user', content: o.user || '' }] }) }), ms);
        if (!res.ok) throw new Error((r.p === 'grok' ? 'Grok' : 'OpenAI') + ' 呼叫失敗 ' + res.status);
        data = await res.json();
        return String((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').trim();
    }
    W.novaLeanLLM = call;
    W.novaLeanHasKey = hasKey;
})();

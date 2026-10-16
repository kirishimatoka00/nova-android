/* ═══════════════════════════════════════════════════════════════════════
   nova-experts-glue.js — NOVA Android 多專家協作／多專家會議／並行作業的「接線層」（跟 index.html 放同一個資料夾 www/）
   版本：v1.1.0
   版本紀錄：
   v1.1.0 - App v2.6.58。移植桌面版 v3.66／v3.67「智慧分派」的專家部分：新增 autoRoute(text)（先問 Jev routeTask，不確定／失敗退回一次輕量 LLM 判斷；失敗一律回 chat）與 autoRouteAvailable()；
            dispatch(text, o) 新增 o.auto（對話區提示「AI 判斷這是需要多位專家分工的任務」）、o.skipConfirm（驗證通過就直接開工，驗證不過仍跳確認視窗）、o.reason。開關與送出掛鉤在 nova-autoroute.js。
   v1.0.0 - 初版（批次 4）。移植自 NOVA Desktop 的 index.html「NOVA-EXPERTS-GLUE」區塊（v3.5x，不改桌面版）：
            ① 引擎本體沿用 nova-experts.js／nova-meeting.js／nova-tasks.js（原樣移植），這支檔案負責把引擎接到手機版 App：
               專家／設定的儲存（localStorage nova_experts_v1／nova_experts_settings_v1／nova_experts_mode …）、模型呼叫（Gemini／OpenAI／Grok，
               透過 nova-llm.js 的輔助函式）、知識庫檢索（novaKbRetrieveContext）、輸入框上方狀態列、管理視窗、進度面板、任務看板、派工確認視窗。
            ② 手機介面：所有視窗的外觀由 nova-ui.css（v1.1.0 起）的 #nova-experts-modal／#nova-dispatch-modal／#nova-roster-modal／#nova-exp-panel／
               #nova-tasks-board／#nova-experts-bar 區塊覆寫成手機排版（全螢幕管理視窗、可橫向滑動的分頁、單欄表單、貼底進度面板）。
            ③ 入口：「＋」選單裡的「多專家」按鈕（#experts-mode-toggle-btn）；開啟後 handleSendMessage 會把一般提問交給 NovaExpertsGlue.send()
               （斜線指令、自主／即時／翻譯模式不攔截）。
   依賴（全域）：appState、addMessage（第 7 個參數 sessionId）、renderMessages、saveToDB、scheduleEmergencyBackup、showToast、genMsgId、getTime、
                 novaKbRetrieveContext、_novaKbEffectiveDocType、nova-llm.js 的 _novaDr* 系列、window.NovaExperts／NovaMeeting／NovaExpertTasks。
   ═══════════════════════════════════════════════════════════════════════ */
window._novaExpAbort = new Set();
window._novaExpState = { running: false, cancel: false, owner: null };

window.NovaExpertsGlue = (function () {
    const K_EXPERTS = 'nova_experts_v1', K_SETTINGS = 'nova_experts_settings_v1', K_MODE = 'nova_experts_mode';
    const ENG = function () { return window.NovaExperts; };
    const css = function (el, s) { el.style.cssText = s; return el; };
    const mk = function (tag, style, text) { const e = document.createElement(tag); if (style) e.style.cssText = style; if (text != null) e.textContent = text; return e; };
    const T = {   // 主題色：吃 nova-ui.css 的 token，沒有就用深色預設
        card: 'var(--nv-card, #0f172a)', card2: 'var(--nv-card-2, #1e293b)', text: 'var(--nv-text, #e2e8f0)', muted: 'var(--nv-muted, #94a3b8)',
        border: 'var(--nv-line-strong, #334155)', accent: 'var(--nv-accent, #a855f7)', hover: 'var(--nv-hover, rgba(148,163,184,.15))'
    };

    // ── 儲存 ──
    function loadExperts() {
        let list = null;
        try { list = JSON.parse(localStorage.getItem(K_EXPERTS) || 'null'); } catch (e) { list = null; }
        if (!Array.isArray(list) || !list.length) return ENG().defaultExperts();
        return list.map(ENG().normalizeExpert);
    }
    function saveExperts(list) { try { localStorage.setItem(K_EXPERTS, JSON.stringify(list.map(ENG().normalizeExpert))); } catch (e) { console.warn('[NOVA][專家] 儲存失敗', e); } }
    function loadSettings() {
        let s = null;
        try { s = JSON.parse(localStorage.getItem(K_SETTINGS) || 'null'); } catch (e) { s = null; }
        return ENG().normalizeSettings(s || {});
    }
    function saveSettings(s) { try { localStorage.setItem(K_SETTINGS, JSON.stringify(ENG().normalizeSettings(s))); } catch (e) { /* ignore */ } }
    function isOn() { return !!ENG() && localStorage.getItem(K_MODE) === 'on'; }

    // ── 模型解析 ──
    // ★ v3.54.0：主選單選的是 OpenAI 且有 OpenAI 金鑰時，「跟隨預設模型」就跟著用 OpenAI 子模型；其餘行為不變（Gemini）。
    function hasOpenAiKey() { return !!(appState.keys.openai || localStorage.getItem('nova_key_openai')); }
    function hasLlmKey() { return !!(appState.keys.gemini || localStorage.getItem('nova_key_gemini') || hasOpenAiKey()); }
    function defaultModel() {
        if (appState.currentModel === 'gpt' && hasOpenAiKey()) return _novaDrResolveGptModel(appState.gptModel);
        return _novaDrResolveGeminiModel(appState.geminiModel, 'gemini-3.6-flash');
    }
    function resolveModel(name) {
        const n = String(name || '').trim();
        if (!n) return defaultModel();
        if (n.indexOf('grok-') === 0) return _novaDrResolveGrokModel(n);
        if (n.indexOf('gpt-') === 0) return _novaDrResolveGptModel(n);
        return _novaDrResolveGeminiModel(n, defaultModel());
    }

    // ── 模型呼叫（Gemini 走 sidecar 代理、登記到專家模式自己的中止登記處） ──
    async function expFetch(url, fetchOpts, timeoutMs, taskId) {
        const controller = new AbortController();
        const tid = setTimeout(function () { try { controller.abort('timeout'); } catch (e) { controller.abort(); } }, timeoutMs);
        window._novaExpAbort.add(controller);
        if (taskId) { (window._novaExpTasksRT = window._novaExpTasksRT || { abortByTask: {}, cancelled: new Set() }); (window._novaExpTasksRT.abortByTask[taskId] = window._novaExpTasksRT.abortByTask[taskId] || new Set()).add(controller); }
        try {
            return await _novaLLMProxyFetch(url, Object.assign({}, fetchOpts, { signal: controller.signal }));
        } catch (error) {
            if (controller.signal.aborted) throw new Error(controller.signal.reason === 'user_stop' ? '使用者已手動停止' : '連線逾時（' + Math.round(timeoutMs / 1000) + ' 秒）');
            throw new Error((error && error.message) ? error.message : String(error));
        } finally {
            clearTimeout(tid);
            window._novaExpAbort.delete(controller);
            if (taskId && window._novaExpTasksRT && window._novaExpTasksRT.abortByTask[taskId]) window._novaExpTasksRT.abortByTask[taskId].delete(controller);
        }
    }
    async function callGemini(o) {
        const key = appState.keys.gemini || localStorage.getItem('nova_key_gemini') || '';
        if (!key) throw new Error('尚未在設定頁填入 Gemini API Key');
        const model = o.model;
        const gc = { maxOutputTokens: o.maxOutputTokens || 4096 };
        if (o.json && !o.search) gc.responseMimeType = 'application/json';   // 搜尋工具與 JSON 模式不能同時用
        const tc = _novaDrThinkingConfig(model, o.thinking);
        if (tc) gc.thinkingConfig = tc;
        const payload = { contents: [{ role: 'user', parts: [{ text: o.text || '' }] }], generationConfig: gc };
        if (o.system) payload.systemInstruction = { parts: [{ text: o.system }] };
        if (o.search) payload.tools = [{ googleSearch: {} }];
        const url = `https://generativelanguage.googleapis.com/${_novaDrGeminiApiVer(model)}/models/${model}:generateContent?key=${key}`;
        const tsec = 120;
        const res = await expFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), novaTimeoutSec: tsec }, tsec * 1000 + 15000);
        const raw = await res.text();
        let data = null; try { data = JSON.parse(raw); } catch (e) { data = null; }
        if (!res.ok) {
            const err = new Error((data && data.error && data.error.message) || ('HTTP ' + res.status + ' ' + raw.slice(0, 140)));
            err.status = res.status; throw err;
        }
        const cand = data && data.candidates && data.candidates[0];
        if (!cand) {
            const blk = data && data.promptFeedback && data.promptFeedback.blockReason;
            throw new Error('Gemini 沒有回傳內容' + (blk ? '（被安全機制攔截：' + blk + '）' : ''));
        }
        const parts = (cand.content && cand.content.parts) || [];
        const text = parts.filter(function (p) { return p.text && !p.thought; }).map(function (p) { return p.text; }).join('');
        const sources = [];
        const chunks = cand.groundingMetadata && cand.groundingMetadata.groundingChunks;
        if (chunks) chunks.forEach(function (c) { if (c.web && c.web.uri) sources.push({ title: c.web.title || '', uri: c.web.uri }); });
        return { text: text, sources: sources };
    }
    // ★ v3.54.0：OpenAI。走 expFetch → 「停止」可真正中斷連線。o.search 時改走 Responses API 的內建 web_search，來源由 url_citation 取得。
    async function callGpt(o) {
        const key = appState.keys.openai || localStorage.getItem('nova_key_openai') || '';
        if (!key) throw new Error('尚未設定 OpenAI API Key（此專家／階段選了 OpenAI 模型）');
        if (o.search) {
            // 聯網：Responses API ＋ 內建 web_search（Chat Completions 沒有這個內建工具）
            const rb = { model: o.model, input: [{ role: 'user', content: (o.system ? o.system + '\n\n' : '') + (o.text || '') }], tools: [{ type: 'web_search' }] };
            const rr = await expFetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(rb) }, 240000, o.taskId);
            const rraw = await rr.text();
            let rdata = null; try { rdata = JSON.parse(rraw); } catch (e) { rdata = null; }
            if (!rr.ok) { const er = new Error('OpenAI API 錯誤（模型：' + o.model + '）：' + ((rdata && rdata.error && rdata.error.message) || ('HTTP ' + rr.status + ' ' + rraw.slice(0, 140)))); er.status = rr.status; throw er; }
            const parsed = _novaOpenAiParseResponses(rdata);
            if (!parsed.text) throw new Error('OpenAI 沒有回傳內容');
            return parsed;
        }
        const msgs = [];
        if (o.system) msgs.push({ role: 'system', content: o.system });
        msgs.push({ role: 'user', content: o.text || '' });
        const body = { model: o.model, messages: msgs };
        if (o.json) body.response_format = { type: 'json_object' };
        const res = await expFetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 180000, o.taskId);
        const raw = await res.text();
        let data = null; try { data = JSON.parse(raw); } catch (e) { data = null; }
        if (!res.ok) {
            const err = new Error('OpenAI API 錯誤（模型：' + o.model + '）：' + ((data && data.error && data.error.message) || ('HTTP ' + res.status + ' ' + raw.slice(0, 140))));
            err.status = res.status; throw err;
        }
        const msg = data && data.choices && data.choices[0] && data.choices[0].message;
        if (!msg) throw new Error('OpenAI 沒有回傳內容');
        return { text: msg.content || '', sources: [] };
    }
    async function callModel(o) {
        if (String(o.model).indexOf('gpt-') === 0) return await callGpt(o);
        if (String(o.model).indexOf('grok-') === 0) {
            if (!appState.keys.grok) throw new Error('尚未設定 Grok API Key（此專家／階段選了 Grok 模型）');
            if (o.search) {
                const r = await _novaDrCallGrok({ model: o.model, text: (o.system ? o.system + '\n\n' : '') + o.text, timeoutMs: 180000 });
                return { text: r.text, sources: (r.citations || []).map(function (u) { return { title: '', uri: typeof u === 'string' ? u : (u && u.url) || '' }; }) };
            }
            const r = await _novaCallModel({ model: o.model, systemInstruction: o.system, userText: o.text, timeoutMs: 180000 });
            return { text: r.text };
        }
        return await callGemini(o);
    }
    async function kbRetrieve(query, scope) {
        scope = scope || {};
        const r = await novaKbRetrieveContext(query, {
            docTypes: Array.isArray(scope.docTypes) ? scope.docTypes : [],   // 明確傳陣列＝不套用全域「限定類型」
            folderIds: scope.folderIds, docIds: scope.docIds, topK: scope.topK, threshold: 0.5, wantMeta: true
        });
        return { items: (r && r.items) || [] };
    }

    // ── 輸入列按鈕與狀態列 ──
    function injectStyle() {
        if (document.getElementById('nova-exp-style')) return;
        const st = document.createElement('style');
        st.id = 'nova-exp-style';
        st.textContent =
            '@keyframes novaExpSpin{to{transform:rotate(360deg)}}' +
            '@keyframes novaExpGlow{0%,100%{background-position:0% 50%;box-shadow:0 0 0 1px rgba(168,85,247,.45),0 0 6px rgba(168,85,247,.25)}50%{background-position:100% 50%;box-shadow:0 0 0 1px rgba(216,180,254,.85),0 0 16px rgba(168,85,247,.6)}}' +
            'html:root body #nova-composer > #experts-mode-toggle-btn{grid-column:4;grid-row:2;justify-self:start;margin:0 !important;box-shadow:none;outline:none}' +
            'html:root body #experts-mode-toggle-btn{background:var(--nv-card-2,#1e293b) !important;color:var(--nv-muted,#64748b) !important;transition:background .25s,color .25s}' +
            'html:root body #experts-mode-toggle-btn:hover{color:var(--nv-text,#e2e8f0) !important}' +
            'html:root body #experts-mode-toggle-btn.nova-exp-on{background:linear-gradient(135deg,rgba(168,85,247,.55),rgba(99,102,241,.25),rgba(168,85,247,.55)) !important;background-size:220% 220% !important;color:#e9d5ff !important;animation:novaExpGlow 2.6s ease-in-out infinite}' +
            'html.theme-light:root body #experts-mode-toggle-btn.nova-exp-on{color:#581c87 !important}' +
            '#nova-experts-bar button{cursor:pointer}' +
            'html:root body #nova-experts-bar{box-sizing:border-box;width:calc(100% - 40px);max-width:820px;margin:0 auto 4px auto !important}' +
            'html:root body #nova-experts-bar .nova-exp-seg button{background:transparent !important;color:var(--nv-text,#e2e8f0) !important;box-shadow:none}' +
            'html:root body #nova-experts-bar .nova-exp-seg button.nova-exp-seg-on{background:#9333ea !important;color:#fff !important}' +
            'html:root body #nova-experts-modal .nova-exp-tabs button{background:var(--nv-card-2,#1e293b) !important;color:var(--nv-text,#e2e8f0) !important;border:1px solid var(--nv-line-strong,#334155) !important}' +
            'html:root body #nova-experts-modal .nova-exp-tabs button.nova-exp-tab-on{background:#9333ea !important;color:#fff !important;border-color:#7e22ce !important;font-weight:700}' +
            'html:root body #nova-experts-modal .nova-exp-close{background:transparent !important;border:0 !important;color:var(--nv-muted,#94a3b8) !important}';
        document.head.appendChild(st);
    }
    function renderBar() {
        const btn = document.getElementById('experts-mode-toggle-btn');
        const on = isOn();
        const sub = subMode();
        if (btn) {
            btn.classList.toggle('nova-exp-on', on);
            btn.title = on ? '多專家模式（' + (sub === 'meeting' ? '多專家會議' : sub === 'tasks' ? '並行作業' : '協作報告') + '）：開啟（點一下關閉）' : '多專家模式：關閉（點一下開啟）';
        }
        let bar = document.getElementById('nova-experts-bar');
        if (!on) { if (bar) bar.remove(); return; }
        const composer = document.getElementById('nova-composer');
        if (!composer || !composer.parentNode) return;
        if (!bar) {
            bar = mk('div', 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 auto 4px auto;width:calc(100% - 40px);max-width:820px;box-sizing:border-box;padding:5px 10px;border-radius:10px;font-size:12px;border:1px solid rgba(168,85,247,.45);background:rgba(168,85,247,.10);color:' + T.text + ';');
            bar.id = 'nova-experts-bar';
            injectStyle();
            composer.parentNode.insertBefore(bar, composer);
        }
        bar.textContent = '';
        const list = loadExperts().filter(function (e) { return e.enabled; });
        const small = function (label, fn, extra) { const b = mk('button', 'padding:2px 9px;border-radius:7px;border:1px solid ' + T.border + ';background:' + T.card2 + ';color:' + T.text + ';' + (extra || ''), label); b.onclick = fn; return b; };
        // 模式切換（協作報告／多專家會議）
        const seg = mk('div', 'display:inline-flex;border-radius:8px;overflow:hidden;border:1px solid rgba(168,85,247,.55);');
        [['report', '🧑‍🔬 協作報告'], ['meeting', '🗣️ 多專家會議'], ['tasks', '⚡ 並行作業']].forEach(function (m) {
            const act = sub === m[0];
            const b = mk('button', 'padding:2px 10px;border:0;font-size:12px;font-weight:' + (act ? '700' : '400') + ';background:' + (act ? 'rgba(147,51,234,.55)' : 'transparent') + ';color:' + (act ? '#fff' : T.text) + ';', m[1]);
            if (act) b.className = 'nova-exp-seg-on';
            b.onclick = function () { if (!act) { setSubMode(m[0]); showToast(m[0] === 'meeting' ? '🗣️ 已切換為【多專家會議】：專家會在對話裡一起跟你討論，說「請總結」收尾' : m[0] === 'tasks' ? '⚡ 已切換為【並行作業】：用「@專家 要做的事」交辦，多位專家同時開工，成品貼回對話' : '🧑‍🔬 已切換為【協作報告】：專家分工後產出一份完整報告'); } };
            seg.appendChild(b);
        });
        seg.className = 'nova-exp-seg';
        bar.appendChild(seg);
        const info = mk('span', 'color:' + T.muted + ';flex:0 0 100%;order:99;min-width:0;font-size:11px;line-height:1.5;');   // v3.54.1：說明文字獨立放在按鈕列下方，不再撐寬
        if (sub === 'tasks') {
            const ts = loadTSettings(); const act = activeTaskCount();
            info.textContent = '成員 ' + list.length + ' 位｜輸入「@專家 要做的事」交辦，例如 @小白 做簡報 → @老王 蒐集資料｜同時最多 ' + ts.concurrency + ' 項｜' + (act ? act + ' 項進行中' : '目前沒有進行中的任務');
        } else if (sub === 'meeting') {
            const ms = loadMSettings();
            const meet = getMeet(appState.currentSessionId);
            const spoke = meet ? meetMessages(appState.currentSessionId, meet).filter(function (m) { return m.speaker; }).length : 0;
            const names = MT().withDisplayNames(list).map(function (p) { return p.displayName; });
            info.textContent = '成員 ' + list.length + ' 位：' + (names.slice(0, 5).join('、') + (names.length > 5 ? '…' : '')) + '｜' + (ms.speakerMode === 'all' ? '全員發言' : '主持人挑選最多 ' + ms.maxSpeakers + ' 位') + '｜每次 ' + ms.rounds + ' 回合｜' + (meet ? '會議進行中（專家已發言 ' + spoke + ' 則）' : '尚未開始，直接發言即可');
        } else {
            const st = loadSettings();
            const n = st.selection === 'all' ? list.length : Math.min(st.maxExperts, list.length);
            info.textContent = '啟用 ' + list.length + ' 位專家｜' + (st.selection === 'all' ? '全員協作' : '自動挑選最多 ' + st.maxExperts + ' 位') + '｜交叉審閱 ' + st.crossReview + ' 輪｜' + (st.reviewer ? '含獨立審查' : '無審查') + '｜約 ' + ENG().estimateCalls(st, n) + ' 次模型呼叫';
        }
        bar.appendChild(info);
        if (sub === 'tasks') {
            bar.appendChild(small('📋 任務看板' + (activeTaskCount() ? '（' + activeTaskCount() + '）' : ''), function () { toggleBoard(); }, TRT.boardOpen ? 'background:rgba(147,51,234,.35);' : ''));
        } else if (sub === 'meeting') {
            const meet2 = getMeet(appState.currentSessionId);
            if (meet2) {
                bar.appendChild(small('📝 總結', function () { summarizeNow(); }, 'background:#9333ea;color:#fff;border-color:transparent;font-weight:700;'));
                bar.appendChild(small('🔄 新會議', function () { newMeeting(); }));
            }
        } else {
            bar.appendChild(small('管理專家', function () { openManager('experts'); }));
        }
        bar.appendChild(small('設定', function () { openManager(sub === 'meeting' ? 'meeting' : sub === 'tasks' ? 'tasks' : 'settings'); }));
        const b3 = mk('button', 'padding:2px 9px;border-radius:7px;border:0;background:transparent;color:' + T.muted + ';', '關閉模式');
        b3.onclick = function () { toggle(); };
        bar.appendChild(b3);
    }
    function toggle() {
        if (!ENG()) { showToast('找不到多專家引擎（nova-experts.js 沒有載入）'); return; }
        const on = isOn();
        localStorage.setItem(K_MODE, on ? 'off' : 'on');
        renderBar();
        showToast(!on ? '🧑‍🔬 已開啟【多專家模式】（' + (subMode() === 'meeting' ? '多專家會議' : subMode() === 'tasks' ? '並行作業' : '協作報告') + '）：可在輸入框上方切換' : '🧑‍🔬 已關閉多專家模式');
    }

    // ── 管理視窗 ──
    let ui = { tab: 'experts', editing: null, draft: null };
    function closeManager() { const m = document.getElementById('nova-experts-modal'); if (m) m.remove(); }
    function btnStyle(primary) {
        return 'padding:6px 14px;border-radius:9px;font-size:13px;font-weight:600;cursor:pointer;border:1px solid ' + (primary ? 'transparent' : T.border) + ';background:' + (primary ? '#9333ea' : T.card2) + ';color:' + (primary ? '#fff' : T.text) + ';';
    }
    function fieldStyle() { return 'width:100%;box-sizing:border-box;background:' + T.card2 + ';color:' + T.text + ';border:1px solid ' + T.border + ';border-radius:8px;padding:6px 9px;font-size:13px;outline:none;font-family:inherit;'; }
    function labelEl(text, hint) {
        const l = mk('div', 'font-size:12px;font-weight:600;color:' + T.text + ';margin:10px 0 3px 0;', text);
        if (hint) l.appendChild(mk('span', 'font-weight:400;color:' + T.muted + ';margin-left:6px;', hint));
        return l;
    }
    function modelSelect(value, followLabel) {
        const sel = mk('select', fieldStyle());
        sel.appendChild(new Option(followLabel || '（跟隨預設模型）', ''));
        const g = _novaDrTextModelOptions('gemini'), k = _novaDrTextModelOptions('grok'), gp = _novaDrTextModelOptions('openai');
        g.forEach(function (o) { sel.appendChild(new Option(o.label, o.value)); });
        k.forEach(function (o) { sel.appendChild(new Option(o.label, o.value)); });
        gp.forEach(function (o) { sel.appendChild(new Option('OpenAI ' + o.label, o.value)); });
        sel.value = Array.from(sel.options).some(function (o) { return o.value === value; }) ? value : '';
        return sel;
    }
    function openManager(tab, editId) {
        closeManager();
        ui = { tab: tab || 'experts', editing: null, draft: null };
        if (editId) { const ex = loadExperts().filter(function (x) { return x.id === editId; })[0]; if (ex) { ui.editing = ex.id; ui.draft = JSON.parse(JSON.stringify(ex)); } }
        const overlay = mk('div', 'position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px;');
        overlay.id = 'nova-experts-modal';
        overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) closeManager(); });
        const card = mk('div', 'width:min(780px,100%);max-height:90vh;display:flex;flex-direction:column;background:' + T.card + ';color:' + T.text + ';border:1px solid ' + T.border + ';border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.5);overflow:hidden;');
        const head = mk('div', 'display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid ' + T.border + ';');
        head.appendChild(mk('b', 'font-size:15px;flex:1;', '🧑‍🔬 多專家協作'));
        const tabs = mk('div', 'display:flex;gap:6px;');
        tabs.className = 'nova-exp-tabs';
        injectStyle();
        const body = mk('div', 'padding:14px 16px;overflow-y:auto;flex:1;');
        const render = function () {
            tabs.textContent = '';
            [['experts', '專家'], ['settings', '協作設定'], ['meeting', '會議設定'], ['tasks', '並行設定']].forEach(function (t) {
                const b = mk('button', 'padding:4px 12px;border-radius:8px;font-size:13px;cursor:pointer;border:1px solid ' + (ui.tab === t[0] ? '#9333ea' : T.border) + ';background:' + (ui.tab === t[0] ? 'rgba(147,51,234,.25)' : T.card2) + ';color:' + T.text + ';', t[1]);
                if (ui.tab === t[0]) b.className = 'nova-exp-tab-on';
                b.onclick = function () { ui.tab = t[0]; ui.editing = null; render(); };
                tabs.appendChild(b);
            });
            body.textContent = '';
            if (ui.tab === 'settings') renderSettings(body, render);
            else if (ui.tab === 'meeting') renderMeetingSettings(body, render);
            else if (ui.tab === 'tasks') renderTaskSettings(body, render);
            else if (ui.editing) renderEditor(body, render);
            else renderList(body, render);
        };
        const close = mk('button', 'background:transparent;border:0;color:' + T.muted + ';font-size:18px;cursor:pointer;padding:0 6px;', '✕');
        close.className = 'nova-exp-close';
        close.onclick = closeManager;
        head.append(tabs, close);
        card.append(head, body);
        overlay.appendChild(card);
        document.body.appendChild(overlay);
        render();
    }

    function kbScopeText(e) {
        const k = e.kb || {};
        const types = (k.docTypes || []).map(function (t) { return window.NovaKbTables ? window.NovaKbTables.docTypeLabel(t) : t; });
        const parts = [];
        parts.push(types.length ? '類型：' + types.join('、') : '類型：全部');
        if (k.folderIds && k.folderIds.length) parts.push(k.folderIds.length + ' 個資料夾');
        if (k.docIds && k.docIds.length) parts.push(k.docIds.length + ' 份指定文件');
        return parts.join('｜');
    }
    function renderList(body, rerender) {
        const list = loadExperts();
        body.appendChild(mk('div', 'font-size:12px;color:' + T.muted + ';margin-bottom:10px;line-height:1.6;',
            '勾選＝啟用。每位專家有自己的角色、專業知識與知識庫範圍；提問時由「調度者」挑出相關專家並分派子任務，專家各自檢索證據後並行發表看法，再經交叉審閱、聚合者整理、獨立審查者挑錯，產出一份附證據與審查紀錄的報告。'));
        list.forEach(function (e) {
            const row = mk('div', 'display:flex;align-items:flex-start;gap:10px;padding:9px 10px;border:1px solid ' + T.border + ';border-radius:10px;margin-bottom:8px;background:' + T.card2 + ';');
            const cb = mk('input'); cb.type = 'checkbox'; cb.checked = !!e.enabled; cb.style.cssText = 'margin-top:4px;accent-color:#9333ea;';
            cb.onchange = function () { e.enabled = cb.checked; saveExperts(list); renderBar(); };
            const mid = mk('div', 'flex:1;min-width:0;');
            mid.appendChild(mk('div', 'font-weight:700;font-size:14px;', e.icon + ' ' + e.name + (e.web ? '  🌐' : '') + (e.model ? '  · ' + e.model : '')));
            mid.appendChild(mk('div', 'font-size:12px;color:' + T.muted + ';margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', e.role));
            mid.appendChild(mk('div', 'font-size:11px;color:' + T.muted + ';margin-top:2px;', '知識庫範圍　' + kbScopeText(e) + (e.knowledge ? '｜專業知識 ' + e.knowledge.length + ' 字' : '')));
            const acts = mk('div', 'display:flex;gap:6px;flex-shrink:0;');
            const be = mk('button', btnStyle(false), '編輯'); be.onclick = function () { ui.editing = e.id; ui.draft = JSON.parse(JSON.stringify(e)); rerender(); };
            const bc = mk('button', btnStyle(false), '複製'); bc.onclick = function () {
                const c = JSON.parse(JSON.stringify(e)); c.id = 'x_' + Math.random().toString(36).slice(2, 9); c.name += '（複本）'; c.builtin = false;
                list.push(c); saveExperts(list); rerender();
            };
            const bd = mk('button', btnStyle(false), '刪除'); bd.onclick = async function () {
                const ok = await showConfirm('確定刪除專家「' + e.name + '」？' + (e.builtin ? '\n（內建專家之後可用「還原預設專家」補回）' : ''));
                if (!ok) return;
                saveExperts(list.filter(function (x) { return x.id !== e.id; })); renderBar(); rerender();
            };
            acts.append(be, bc, bd);
            row.append(cb, mid, acts);
            body.appendChild(row);
        });
        const foot = mk('div', 'display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;');
        const add = mk('button', btnStyle(true), '＋ 新增專家');
        add.onclick = function () {
            const d = ENG().normalizeExpert({ id: 'x_' + Math.random().toString(36).slice(2, 9), name: '新專家', icon: '🧑‍🔬', role: '', knowledge: '', enabled: true });
            ui.editing = d.id; ui.draft = d; ui.isNew = true; rerender();
        };
        const restore = mk('button', btnStyle(false), '還原預設專家');
        restore.onclick = function () {
            const have = {}; list.forEach(function (x) { have[x.id] = 1; });
            const add2 = ENG().defaultExperts().filter(function (d) { return !have[d.id]; });
            if (!add2.length) { showToast('預設專家都還在，沒有需要補回的'); return; }
            saveExperts(list.concat(add2)); showToast('已補回 ' + add2.length + ' 位預設專家（你修改過的不會被覆蓋）'); renderBar(); rerender();
        };
        const exp = mk('button', btnStyle(false), '匯出 JSON');
        exp.onclick = function () {
            const blob = new Blob([JSON.stringify({ type: 'nova_experts', version: 1, experts: list }, null, 2)], { type: 'application/json' });
            const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'NOVA_Experts_' + new Date().toISOString().slice(0, 10) + '.json';
            document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
        };
        const imp = mk('button', btnStyle(false), '匯入 JSON');
        imp.onclick = function () {
            const inp = mk('input'); inp.type = 'file'; inp.accept = '.json,application/json';
            inp.onchange = async function () {
                const f = inp.files && inp.files[0]; if (!f) return;
                try {
                    const data = JSON.parse(await f.text());
                    const arr = Array.isArray(data) ? data : data.experts;
                    if (!Array.isArray(arr) || !arr.length) throw new Error('檔案裡沒有專家資料');
                    const cur = loadExperts(); const ids = {}; cur.forEach(function (x) { ids[x.id] = 1; });
                    let n = 0;
                    arr.forEach(function (raw) {
                        const d = ENG().normalizeExpert(raw);
                        if (ids[d.id]) d.id = 'x_' + Math.random().toString(36).slice(2, 9);
                        d.builtin = false; cur.push(d); n++;
                    });
                    saveExperts(cur); showToast('已匯入 ' + n + ' 位專家'); renderBar(); rerender();
                } catch (err) { showToast('匯入失敗：' + (err.message || err)); }
            };
            inp.click();
        };
        foot.append(add, restore, exp, imp);
        body.appendChild(foot);
    }

    function renderEditor(body, rerender) {
        const d = ui.draft;
        const f = {};
        const addField = function (label, hint, el) { body.appendChild(labelEl(label, hint)); body.appendChild(el); return el; };
        const top = mk('div', 'display:flex;gap:8px;');
        f.icon = mk('input', fieldStyle() + 'width:64px;text-align:center;'); f.icon.value = d.icon; f.icon.maxLength = 4;
        f.name = mk('input', fieldStyle()); f.name.value = d.name; f.name.placeholder = '專家名稱，例如：高分子加工專家';
        top.append(f.icon, f.name);
        body.appendChild(labelEl('圖示與名稱'));
        body.appendChild(top);
        f.role = addField('角色與職責', '（這位專家是誰、負責什麼、從什麼角度看問題）', mk('textarea', fieldStyle() + 'min-height:64px;resize:vertical;'));
        f.role.value = d.role; f.role.placeholder = '例如：你是 PET 固相聚合與水解穩定性專家，負責從材料與製程角度評估…';
        f.knowledge = addField('專業知識與判斷準則', '（可貼上守則、公式、經驗法則、常見陷阱；也可從文字檔載入）', mk('textarea', fieldStyle() + 'min-height:150px;resize:vertical;'));
        f.knowledge.value = d.knowledge;
        const counter = mk('div', 'font-size:11px;color:' + T.muted + ';margin-top:3px;display:flex;gap:10px;align-items:center;');
        const upd = function () { counter.firstChild.textContent = f.knowledge.value.length + ' / 8000 字'; };
        counter.appendChild(mk('span', '', ''));
        const load = mk('button', btnStyle(false) + 'padding:2px 10px;font-size:12px;', '從文字檔載入（附加在後面）');
        load.onclick = function () {
            const inp = mk('input'); inp.type = 'file'; inp.accept = '.txt,.md,.csv,.json,text/plain';
            inp.onchange = async function () {
                const file = inp.files && inp.files[0]; if (!file) return;
                const txt = await file.text();
                const merged = (f.knowledge.value ? f.knowledge.value + '\n\n' : '') + '【' + file.name + '】\n' + txt;
                f.knowledge.value = merged.slice(0, 8000);
                if (merged.length > 8000) showToast('內容超過 8000 字，已截斷。較大的資料建議匯入向量資料庫，再用下方「知識庫範圍」指定。');
                upd();
            };
            inp.click();
        };
        counter.appendChild(load);
        body.appendChild(counter);
        f.knowledge.addEventListener('input', upd); upd();

        // 知識庫範圍
        body.appendChild(labelEl('知識庫範圍', '（這位專家檢索證據時只看這些；全部不勾＝不限制）'));
        const scope = mk('div', 'border:1px solid ' + T.border + ';border-radius:10px;padding:8px 10px;background:' + T.card2 + ';');
        const typeRow = mk('div', 'display:flex;gap:10px;flex-wrap:wrap;font-size:12px;');
        typeRow.appendChild(mk('span', 'color:' + T.muted + ';', '文件類型：'));
        f.types = {};
        ((window.NovaKbTables && window.NovaKbTables.DOC_TYPES) || []).forEach(function (t) {
            const lab = mk('label', 'display:inline-flex;align-items:center;gap:4px;cursor:pointer;');
            const cb = mk('input'); cb.type = 'checkbox'; cb.checked = d.kb.docTypes.indexOf(t.id) !== -1; cb.style.accentColor = '#9333ea';
            f.types[t.id] = cb; lab.append(cb, document.createTextNode(t.label)); typeRow.appendChild(lab);
        });
        scope.appendChild(typeRow);
        const folderBox = mk('div', 'display:flex;gap:10px;flex-wrap:wrap;font-size:12px;margin-top:8px;');
        folderBox.appendChild(mk('span', 'color:' + T.muted + ';', '資料夾：（讀取中…）'));
        scope.appendChild(folderBox);
        const docSel = mk('select', fieldStyle() + 'margin-top:8px;height:96px;'); docSel.multiple = true;
        scope.appendChild(mk('div', 'font-size:12px;color:' + T.muted + ';margin-top:8px;', '指定文件（按住 Ctrl／Shift 多選；不選＝不限制）：'));
        scope.appendChild(docSel);
        body.appendChild(scope);
        f.folders = {};
        Promise.all([novaKbGetAllFolders(), novaKbGetAllDocs()]).then(function (res) {
            folderBox.textContent = '';
            folderBox.appendChild(mk('span', 'color:' + T.muted + ';', '資料夾：'));
            if (!res[0].length) folderBox.appendChild(mk('span', 'color:' + T.muted + ';', '（尚無資料夾）'));
            res[0].forEach(function (fo) {
                const lab = mk('label', 'display:inline-flex;align-items:center;gap:4px;cursor:pointer;');
                const cb = mk('input'); cb.type = 'checkbox'; cb.checked = d.kb.folderIds.indexOf(String(fo.id)) !== -1; cb.style.accentColor = '#9333ea';
                f.folders[fo.id] = cb; lab.append(cb, document.createTextNode(fo.name)); folderBox.appendChild(lab);
            });
            res[1].sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); }).forEach(function (doc) {
                const op = new Option(doc.name + '（' + (window.NovaKbTables ? window.NovaKbTables.docTypeLabel(_novaKbEffectiveDocType(doc)) : '') + '）', doc.id);
                op.selected = d.kb.docIds.indexOf(String(doc.id)) !== -1; docSel.appendChild(op);
            });
        }).catch(function () { folderBox.textContent = '資料夾：讀取失敗'; });

        const row2 = mk('div', 'display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;');
        const mWrap = mk('div', 'flex:1;min-width:220px;'); mWrap.appendChild(labelEl('專屬模型', '（Grok 模型不支援結構化輸出強制，偶爾需重試）'));
        f.model = modelSelect(d.model); mWrap.appendChild(f.model);
        const wWrap = mk('label', 'display:inline-flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;padding-bottom:6px;');
        f.web = mk('input'); f.web.type = 'checkbox'; f.web.checked = !!d.web; f.web.style.accentColor = '#9333ea';
        wWrap.append(f.web, document.createTextNode('允許這位專家用網路搜尋補充（較慢、較耗額度）'));
        row2.append(mWrap, wWrap);
        body.appendChild(row2);

        const foot = mk('div', 'display:flex;gap:8px;justify-content:flex-end;margin-top:16px;');
        const cancel = mk('button', btnStyle(false), '取消'); cancel.onclick = function () { ui.editing = null; ui.isNew = false; rerender(); };
        const save = mk('button', btnStyle(true), '儲存');
        save.onclick = function () {
            const name = f.name.value.trim();
            if (!name) { showToast('請輸入專家名稱'); return; }
            if (!f.role.value.trim()) { showToast('請描述這位專家的角色與職責'); return; }
            d.name = name; d.icon = f.icon.value.trim() || '🧑‍🔬'; d.role = f.role.value.trim(); d.knowledge = f.knowledge.value.trim();
            d.kb.docTypes = Object.keys(f.types).filter(function (k) { return f.types[k].checked; });
            d.kb.folderIds = Object.keys(f.folders).filter(function (k) { return f.folders[k].checked; });
            d.kb.docIds = Array.from(docSel.options).filter(function (o) { return o.selected; }).map(function (o) { return o.value; });
            d.model = f.model.value; d.web = f.web.checked;
            const list = loadExperts();
            const i = list.findIndex(function (x) { return x.id === d.id; });
            const nd = ENG().normalizeExpert(d);
            if (i === -1) list.push(nd); else list[i] = nd;
            saveExperts(list); ui.editing = null; ui.isNew = false; renderBar(); rerender();
        };
        foot.append(cancel, save);
        body.appendChild(foot);
    }

    function renderSettings(body, rerender) {
        const s = loadSettings();
        const f = {};
        const est = mk('div', 'font-size:12px;color:' + T.muted + ';margin:2px 0 8px 0;');
        const sel = function (opts, val) {
            const e = mk('select', fieldStyle());
            opts.forEach(function (o) { e.appendChild(new Option(o[1], o[0])); });
            e.value = String(val); return e;
        };
        const num = function (val, lo, hi) { const e = mk('input', fieldStyle()); e.type = 'number'; e.min = lo; e.max = hi; e.value = val; return e; };
        const refresh = function () {
            const cur = collect();
            const n = cur.selection === 'all' ? loadExperts().filter(function (e) { return e.enabled; }).length : Math.min(cur.maxExperts, loadExperts().filter(function (e) { return e.enabled; }).length);
            est.textContent = '預估一次協作約 ' + ENG().estimateCalls(cur, n) + ' 次模型呼叫（以 ' + n + ' 位專家的最壞情況計；每次呼叫都會消耗額度）。';
        };
        const grid = mk('div', 'display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:4px 14px;');
        const cell = function (label, hint, el) { const w = mk('div'); w.appendChild(labelEl(label, hint)); w.appendChild(el); grid.appendChild(w); el.addEventListener('change', refresh); el.addEventListener('input', refresh); return el; };
        f.selection = cell('專家挑選方式', '', sel([['auto', '自動：調度者挑選相關專家'], ['all', '全員：所有啟用的專家都參與']], s.selection));
        f.maxExperts = cell('自動模式最多幾位', '1–8', num(s.maxExperts, 1, 8));
        f.crossReview = cell('交叉審閱輪數', '專家互相質疑', sel([['0', '0（不審閱，最省）'], ['1', '1 輪（建議）'], ['2', '2 輪（最嚴謹、最耗）']], s.crossReview));
        f.reviewer = cell('獨立審查者', '專門挑錯', sel([['true', '啟用（建議）'], ['false', '關閉']], String(s.reviewer)));
        f.reviseMax = cell('審查不通過時最多退回修訂', '', sel([['0', '0（不修訂，只列出問題）'], ['1', '1 輪'], ['2', '2 輪']], s.reviseMax));
        f.topK = cell('每位專家的知識庫檢索段數', '2–12', num(s.topK, 2, 12));
        f.concurrency = cell('同時發言的專家數', '1–6，太高容易被限流', num(s.concurrency, 1, 6));
        f.useKb = cell('使用知識庫證據', '', sel([['true', '是'], ['false', '否（只靠專家的專業常識）']], String(s.useKb)));
        body.appendChild(est);
        body.appendChild(grid);
        body.appendChild(labelEl('各階段使用的模型', '（留空＝跟隨預設；建議審查者用和聚合者不同的模型，降低同一種盲點）'));
        const mg = mk('div', 'display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:4px 14px;');
        [['planner', '調度者'], ['expert', '專家（預設）'], ['aggregator', '聚合者'], ['reviewer', '審查者']].forEach(function (p) {
            const w = mk('div'); w.appendChild(labelEl(p[1])); f['m_' + p[0]] = modelSelect(s.models[p[0]]); w.appendChild(f['m_' + p[0]]); mg.appendChild(w);
            f['m_' + p[0]].addEventListener('change', refresh);
        });
        body.appendChild(mg);
        function collect() {
            return {
                selection: f.selection.value, maxExperts: f.maxExperts.value, crossReview: f.crossReview.value, reviewer: f.reviewer.value === 'true',
                reviseMax: f.reviseMax.value, topK: f.topK.value, concurrency: f.concurrency.value, useKb: f.useKb.value === 'true',
                models: { planner: f.m_planner.value, expert: f.m_expert.value, aggregator: f.m_aggregator.value, reviewer: f.m_reviewer.value }
            };
        }
        refresh();
        const foot = mk('div', 'display:flex;gap:8px;justify-content:flex-end;margin-top:16px;');
        const reset = mk('button', btnStyle(false), '還原預設');
        reset.onclick = function () { saveSettings(ENG().DEFAULT_SETTINGS); renderBar(); rerender(); };
        const save = mk('button', btnStyle(true), '儲存');
        save.onclick = function () { saveSettings(collect()); renderBar(); showToast('✅ 協作設定已儲存'); };
        foot.append(reset, save);
        body.appendChild(foot);
    }

    // ── 執行 ──
    function openPanel(o) {
        const old = document.getElementById('nova-exp-panel'); if (old) old.remove();
        const root = mk('div', 'position:fixed;right:16px;bottom:92px;width:min(380px,calc(100vw - 32px));z-index:76;background:' + T.card + ';border:1px solid rgba(168,85,247,.6);border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.45);padding:10px 12px;font-size:12px;color:' + T.text + ';');
        root.id = 'nova-exp-panel';
        const head = mk('div', 'display:flex;align-items:center;gap:8px;');
        const spin = mk('span', 'display:inline-block;width:14px;height:14px;border:2px solid #a855f7;border-top-color:transparent;border-radius:50%;animation:novaExpSpin .9s linear infinite;flex:none;');
        const title = mk('b', 'flex:1;font-size:13px;', o.title || '🧑‍🔬 多專家協作進行中');
        const clock = mk('span', 'font-family:ui-monospace,Consolas,monospace;color:' + T.muted + ';', '00:00');
        const stop = mk('button', 'background:#dc2626;color:#fff;border:0;border-radius:6px;padding:2px 10px;font-size:12px;font-weight:700;cursor:pointer;', '⏹ 停止');
        head.append(spin, title, clock, stop);
        const q = mk('div', 'color:' + T.muted + ';margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', '📌 ' + o.question);
        const cur = mk('div', 'margin-top:6px;line-height:1.5;', '準備中…');
        const chips = mk('div', 'display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;');
        root.append(head, q, cur, chips);
        document.body.appendChild(root);
        const t0 = Date.now();
        const timer = setInterval(function () { const s = Math.floor((Date.now() - t0) / 1000); clock.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }, 1000);
        stop.onclick = function () { o.onStop(); stop.disabled = true; stop.textContent = '停止中…'; };
        return {
            progress: function (snap) {
                cur.textContent = (snap.current || '') + '｜呼叫 ' + snap.calls + ' 次｜證據 ' + snap.evidence + ' 則';
                chips.textContent = '';
                (snap.experts || []).forEach(function (x) {
                    const c = mk('span', 'padding:1px 7px;border-radius:999px;font-size:11px;background:' + T.card2 + ';color:' + (x.status === 'done' ? '#4ade80' : x.status === 'running' ? '#c084fc' : x.status === 'failed' ? '#f87171' : T.muted) + ';', (x.status === 'done' ? '✅ ' : x.status === 'running' ? '⏳ ' : x.status === 'failed' ? '⚠️ ' : '⬜ ') + x.icon + x.name);
                    chips.appendChild(c);
                });
            },
            progressText: function (t) { cur.textContent = t; },
            finish: function (text) {
                clearInterval(timer); spin.style.display = 'none'; stop.style.display = 'none'; title.textContent = text;
                setTimeout(function () { if (root.parentNode) root.remove(); }, 15000);
            }
        };
    }

    async function ask(question) {
        const E = ENG();
        if (!E) { showToast('找不到多專家引擎（nova-experts.js 沒有載入）'); return; }
        if (window._novaExpState.running) { restoreInput(question); showToast('已經有一場多專家協作正在進行中，請等它結束或先按停止'); return; }
        const experts = loadExperts();
        const settings = loadSettings();
        const enabled = experts.filter(function (e) { return e.enabled; });
        if (!enabled.length) { restoreInput(question); showToast('沒有啟用中的專家，請先到「管理專家」勾選'); openManager('experts'); return; }
        const dm = defaultModel();
        if (!hasLlmKey()) { restoreInput(question); showToast('多專家協作需要 Gemini 或 OpenAI API Key，請先到設定頁填寫'); return; }
        if (settings.useKb && !(await novaKbGetAllChunks().then(function (c) { return c && c.length; }).catch(function () { return 0; }))) {
            addMessage('ℹ️ 向量資料庫目前是空的，這次協作專家只能依專業常識作答，報告會標示為待驗證的假說。', 'system');
        }
        const ownerSession = appState.currentSessionId;
        // 先取對話脈絡（不含這次的問題），再加入使用者訊息
        const histMsgs = (appState.messages || []).filter(function (m) { return String(m.sessionId) === String(ownerSession) && (m.sender === 'user' || m.sender === 'ai'); }).slice(-6);
        const history = histMsgs.map(function (m) { return (m.sender === 'user' ? '使用者' : 'AI') + '：' + String(m.text || '').replace(/\s+/g, ' ').slice(0, 300); }).join('\n');
        if (appState.chatFiles && appState.chatFiles.length) showToast('多專家模式目前不讀取附加檔案；請先把資料匯入向量資料庫');
        addMessage(question, 'user');

        const st = window._novaExpState;
        st.running = true; st.cancel = false; st.owner = ownerSession; window._novaExpAbort.clear();
        addMessage('⏳ 準備多專家協作…', 'system', null, [], null, null, ownerSession);
        const progMsg = appState.messages[appState.messages.length - 1];
        const panel = openPanel({
            question: question,
            onStop: function () {
                st.cancel = true;
                window._novaExpAbort.forEach(function (c) { try { c.abort('user_stop'); } catch (e) { /* ignore */ } });
                window._novaExpAbort.clear();
                showToast('⏹️ 正在停止協作，已完成的專家意見會保留…', 4000);
            }
        });
        let lastRender = 0, timer = null;
        const flush = function () { timer = null; lastRender = Date.now(); if (String(ownerSession) === String(appState.currentSessionId)) renderMessages(); };
        const t0 = Date.now();
        let result = null, errText = '';
        try {
            result = await E.run({
                question: question, history: history, experts: experts, settings: settings,
                deps: {
                    callModel: callModel, kbRetrieve: kbRetrieve, resolveModel: resolveModel, defaultModel: dm,
                    isCancelled: function () { return st.cancel; },
                    onProgress: function (text, snap) {
                        panel.progress(snap);
                        progMsg.text = text;
                        const gap = Date.now() - lastRender;
                        if (gap > 1500) flush(); else if (!timer) timer = setTimeout(flush, 1500 - gap);
                    }
                }
            });
        } catch (e) {
            errText = (e && e.message) || String(e);
        } finally {
            if (timer) { clearTimeout(timer); timer = null; }
            st.running = false; st.owner = null; window._novaExpAbort.clear();
        }
        const secs = Math.round((Date.now() - t0) / 1000);
        const took = secs >= 60 ? Math.floor(secs / 60) + ' 分 ' + (secs % 60) + ' 秒' : secs + ' 秒';
        if (result && result.markdown && !(result.aborted && !result.experts.some(function (x) { return x.status === 'done'; }))) {
            _novaDrPostReportMessage(result.markdown, dm, ownerSession);
            progMsg.text = (result.aborted ? '⏹️ **協作已中止，保留已完成的部分**' : '🎉 **多專家協作完成**') + '｜耗時 ' + took + '｜模型呼叫 ' + result.stats.calls + ' 次｜證據 ' + result.evidence.length + ' 則';
            panel.finish(result.aborted ? '⏹ 已中止（' + took + '）' : '✅ 協作完成（' + took + '）');
        } else {
            progMsg.text = (result && result.aborted ? '⏹️ **協作已中止**（沒有任何專家完成意見）' : '❌ **多專家協作失敗**') + '｜耗時 ' + took + (errText ? '\n原因：' + errText : '');
            panel.finish(result && result.aborted ? '⏹ 已中止' : '❌ 協作失敗');
        }
        saveToDB('messages', progMsg);
        scheduleEmergencyBackup();
        if (String(ownerSession) === String(appState.currentSessionId)) renderMessages();
        if (typeof renderChatHistoryList === 'function') renderChatHistoryList();
        if (String(ownerSession) !== String(appState.currentSessionId)) showToast('🧑‍🔬 多專家協作已結束，報告在原本的對話裡');
    }

    // ═══════════ 多專家會議（nova-meeting.js 的膠水層）═══════════
    const K_SUB = 'nova_experts_submode', K_MSET = 'nova_meeting_settings_v1', K_MEET = 'nova_meeting_state_v1';
    const MT = function () { return window.NovaMeeting; };
    function subMode() { const v = localStorage.getItem(K_SUB); if (v === 'meeting' && MT()) return 'meeting'; if (v === 'tasks' && window.NovaExpertTasks) return 'tasks'; return 'report'; }
    function setSubMode(m) { try { localStorage.setItem(K_SUB, (m === 'meeting' || m === 'tasks') ? m : 'report'); } catch (e) { /* ignore */ } renderBar(); }
    function loadMSettings() { let s = null; try { s = JSON.parse(localStorage.getItem(K_MSET) || 'null'); } catch (e) { s = null; } return MT().normalizeSettings(s || {}); }
    function saveMSettings(s) { try { localStorage.setItem(K_MSET, JSON.stringify(MT().normalizeSettings(s))); } catch (e) { /* ignore */ } }
    function meetMap() { try { return JSON.parse(localStorage.getItem(K_MEET) || '{}') || {}; } catch (e) { return {}; } }
    function getMeet(sid) { return meetMap()[String(sid)] || null; }
    function setMeet(sid, v) { const m = meetMap(); if (v) m[String(sid)] = v; else delete m[String(sid)]; try { localStorage.setItem(K_MEET, JSON.stringify(m)); } catch (e) { /* ignore */ } }
    function meetMessages(sid, meet) {
        return (appState.messages || []).filter(function (m) { return String(m.sessionId) === String(sid) && meet && m.meetingId === meet.id; });
    }
    function buildTranscript(sid, meet) {
        const t = [];
        if (meet && meet.context) t.push({ role: 'note', name: '背景', text: '（會議開始前的對話背景）\n' + meet.context });
        meetMessages(sid, meet).forEach(function (m) {
            if (m.sender === 'user') t.push({ role: 'user', name: '使用者', text: String(m.text || '') });
            else if (m.speaker) t.push({ role: 'expert', name: m.speaker.name || '專家', text: String(m.text || ''), expertId: m.speaker.id });
        });
        return t;
    }
    function lastMsg() { return appState.messages[appState.messages.length - 1]; }
    function meetingParticipants() { return loadExperts().filter(function (e) { return e.enabled; }); }

    function postSpeakerMessage(p, text, sid, meetId, meta) {
        let body = String(text || '');
        if (meta && meta.sources && meta.sources.length) body += '\n\n<sub>📚 參考：' + Array.from(new Set(meta.sources)).slice(0, 4).join('、') + '</sub>';
        const msg = { id: genMsgId(), sessionId: sid, text: body, sender: 'ai', model: appState.currentModel, time: getTime(), sources: [], files: [], actionData: null,
            speaker: { id: p.id, name: p.displayName || p.name, icon: p.icon, role: '', color: speakerColor(p.id) }, meetingId: meetId };
        appState.messages.push(msg);
        saveToDB('messages', msg);
        scheduleEmergencyBackup();
        if (String(sid) === String(appState.currentSessionId)) renderMessages();
        return msg;
    }
    function speakerColor(id) {
        const pal = ['#7c3aed', '#0e7490', '#b45309', '#be123c', '#15803d', '#1d4ed8', '#a21caf', '#475569'];
        let h = 0; String(id).split('').forEach(function (c) { h = (h * 31 + c.charCodeAt(0)) >>> 0; });
        return pal[h % pal.length];
    }
    function meetDeps(st, ownerSession, extra) {
        return Object.assign({
            callModel: callModel, kbRetrieve: kbRetrieve, resolveModel: resolveModel, defaultModel: defaultModel(),
            isCancelled: function () { return st.cancel; }
        }, extra || {});
    }
    function stopHandler(st) {
        return function () {
            st.cancel = true;
            window._novaExpAbort.forEach(function (c) { try { c.abort('user_stop'); } catch (e) { /* ignore */ } });
            window._novaExpAbort.clear();
            showToast('⏹️ 正在停止，已發表的意見會保留…', 3500);
        };
    }

    async function say(text) {
        if (!MT() || !ENG()) { showToast('找不到多專家會議引擎（nova-meeting.js 沒有載入）'); return; }
        const st = window._novaExpState;
        if (st.running) { restoreInput(text); showToast('專家還在討論或總結中，請等他們說完或先按停止'); return; }
        const sid = appState.currentSessionId;
        const participants = meetingParticipants();
        if (!participants.length) { restoreInput(text); showToast('沒有啟用中的專家，請先到「管理專家」勾選'); openManager('experts'); return; }
        if (!hasLlmKey()) { restoreInput(text); showToast('多專家會議需要 Gemini 或 OpenAI API Key，請先到設定頁填寫'); return; }
        const wantSummary = MT().isSummaryCommand(text);
        let meet = getMeet(sid);
        if (wantSummary && !meet) { restoreInput(text); showToast('目前沒有進行中的會議；先發言討論後再請專家總結'); return; }
        const settings = loadMSettings();
        const isNew = !meet;
        if (isNew) {
            const hist = (appState.messages || []).filter(function (m) { return String(m.sessionId) === String(sid) && (m.sender === 'user' || (m.sender === 'ai' && !m.speaker)); }).slice(-6)
                .map(function (m) { return (m.sender === 'user' ? '使用者' : 'AI') + '：' + String(m.text || '').replace(/\s+/g, ' ').slice(0, 300); }).join('\n');
            meet = { id: 'm_' + Date.now().toString(36), startedAt: Date.now(), context: hist, topic: text };
            setMeet(sid, meet);
            const names = MT().withDisplayNames(participants).map(function (p) { return p.icon + p.displayName; }).join('、');
            addMessage('🗣️ **多專家會議開始**｜與會：' + names + '\n提示：用 `@名稱` 可指定某位專家發言；想結束時說「請總結」（或按輸入框上方的「📝 總結」），總結模型會依整場討論產出報告。', 'system', null, [], null, null, sid);
            if (settings.useKb && !(await novaKbGetAllChunks().then(function (c) { return c && c.length; }).catch(function () { return 0; }))) {
                addMessage('ℹ️ 向量資料庫目前是空的，專家只能依專業常識發言。', 'system', null, [], null, null, sid);
            }
        }
        const transcript = buildTranscript(sid, meet);
        addMessage(text, 'user');
        const um = lastMsg(); if (um && um.sender === 'user') { um.meetingId = meet.id; saveToDB('messages', um); }
        if (wantSummary) { renderBar(); return summarizeMeeting(sid, meet, participants, settings); }

        st.running = true; st.cancel = false; st.owner = sid; window._novaExpAbort.clear();
        const panel = openPanel({ question: text, title: '🗣️ 專家討論中', onStop: stopHandler(st) });
        let res = null, errText = '';
        try {
            res = await MT().runTurn({
                userText: text, participants: participants, transcript: transcript, settings: settings,
                deps: meetDeps(st, sid, {
                    onStatus: function (t) { panel.progressText(t); },
                    onSpeaker: async function (p, t, meta) { postSpeakerMessage(p, t, sid, meet.id, meta); }
                })
            });
        } catch (e) { errText = (e && e.message) || String(e); }
        finally { st.running = false; st.owner = null; window._novaExpAbort.clear(); }
        if (errText) { addMessage('❌ 會議發言失敗：' + errText, 'system', null, [], null, null, sid); panel.finish('❌ 失敗'); }
        else {
            if (res.notes && res.notes.length) addMessage('ℹ️ ' + res.notes.join('；'), 'system', null, [], null, null, sid);
            if (!res.spoken.length && !res.aborted) addMessage('（這一輪沒有專家發言）', 'system', null, [], null, null, sid);
            panel.finish(res.aborted ? '⏹ 已停止' : '✅ 這一輪討論完成（' + res.spoken.length + ' 則）');
        }
        renderBar();
        if (typeof renderChatHistoryList === 'function') renderChatHistoryList();
    }
    function restoreInput(text) {
        const inp = document.getElementById('user-input');
        if (inp && !inp.value) { inp.value = text; try { autoResizeInput(inp); } catch (e) { /* ignore */ } }
    }

    async function summarizeMeeting(sid, meet, participants, settings) {
        const st = window._novaExpState;
        if (st.running) { showToast('專家還在討論中，請等他們說完或先按停止'); return; }
        st.running = true; st.cancel = false; st.owner = sid; window._novaExpAbort.clear();
        const panel = openPanel({ question: meet.topic || '會議總結', title: '📝 總結中', onStop: stopHandler(st) });
        panel.progressText('總結模型整理討論紀錄…');
        const dm = defaultModel();
        let res = null, errText = '';
        try {
            res = await MT().summarize({
                topic: meet.topic, participants: participants, transcript: buildTranscript(sid, meet), settings: settings,
                stamp: new Date().toLocaleString('zh-TW', { hour12: false }), deps: meetDeps(st, sid)
            });
        } catch (e) { errText = (e && e.message) || String(e); }
        finally { st.running = false; st.owner = null; window._novaExpAbort.clear(); }
        if (res && res.markdown) {
            _novaDrPostReportMessage(res.markdown, dm, sid);
            setMeet(sid, null);
            addMessage('✅ 會議已結束，總結報告在上面。接下來的發言會開啟一場新的會議。', 'system', null, [], null, null, sid);
            panel.finish('✅ 總結完成');
        } else {
            addMessage('❌ 總結失敗：' + (errText || '沒有內容') + '\n會議仍保持進行，可再說一次「請總結」。', 'system', null, [], null, null, sid);
            panel.finish(st.cancel ? '⏹ 已停止' : '❌ 總結失敗');
        }
        renderBar();
        if (typeof renderChatHistoryList === 'function') renderChatHistoryList();
    }
    function summarizeNow() {
        const sid = appState.currentSessionId, meet = getMeet(sid);
        if (!MT()) return;
        if (!meet) { showToast('目前沒有進行中的會議'); return; }
        if (window._novaExpState.running) { showToast('專家還在討論中，請等他們說完或先按停止'); return; }
        const tr = buildTranscript(sid, meet);
        if (!tr.some(function (m) { return m.role === 'expert'; })) { showToast('專家還沒有發言，沒有內容可以總結'); return; }
        addMessage('請總結', 'user');
        const um = lastMsg(); if (um && um.sender === 'user') { um.meetingId = meet.id; saveToDB('messages', um); }
        summarizeMeeting(sid, meet, meetingParticipants(), loadMSettings());
    }
    function newMeeting() {
        const sid = appState.currentSessionId;
        if (window._novaExpState.running) { showToast('專家還在討論中，請先停止'); return; }
        if (!getMeet(sid)) { showToast('目前沒有進行中的會議'); return; }
        setMeet(sid, null);
        addMessage('🔄 已結束上一場會議（未總結）。接下來的發言會開啟一場新的會議。', 'system', null, [], null, null, sid);
        renderBar();
    }
    function send(text) { const m = subMode(); return m === 'meeting' ? say(text) : m === 'tasks' ? dispatch(text) : ask(text); }

    // ── 成員命名視窗 ──
    function openRoster() {
        const old = document.getElementById('nova-roster-modal'); if (old) old.remove();
        const overlay = mk('div', 'position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px;');
        overlay.id = 'nova-roster-modal';
        overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) { overlay.remove(); renderBar(); } });
        const card = mk('div', 'width:min(640px,100%);max-height:88vh;display:flex;flex-direction:column;background:' + T.card + ';color:' + T.text + ';border:1px solid ' + T.border + ';border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.5);overflow:hidden;');
        const head = mk('div', 'display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid ' + T.border + ';');
        head.appendChild(mk('b', 'font-size:15px;flex:1;', '👥 會議成員與命名'));
        const x = mk('button', 'background:transparent;border:0;color:' + T.muted + ';font-size:18px;cursor:pointer;padding:0 6px;', '✕');
        x.onclick = function () { overlay.remove(); renderBar(); };
        head.appendChild(x);
        const body = mk('div', 'padding:14px 16px;overflow-y:auto;flex:1;');
        const render = function () {
            body.textContent = '';
            body.appendChild(mk('div', 'font-size:12px;color:' + T.muted + ';margin-bottom:10px;line-height:1.6;', '勾選＝參加會議。名稱與圖示可以隨意改（改完離開輸入框就會儲存，之後的發言就用新名字；已經發出的訊息不會改）。要調整角色、專業知識或知識庫範圍，按「詳細編輯」。'));
            const list = loadExperts();
            list.forEach(function (e) {
                const row = mk('div', 'display:flex;align-items:center;gap:8px;padding:7px 9px;border:1px solid ' + T.border + ';border-radius:10px;margin-bottom:7px;background:' + T.card2 + ';');
                const cb = mk('input'); cb.type = 'checkbox'; cb.checked = !!e.enabled; cb.style.cssText = 'accent-color:#9333ea;flex:none;';
                cb.onchange = function () { e.enabled = cb.checked; saveExperts(list); };
                const ic = mk('input', fieldStyle() + 'width:54px;flex:none;text-align:center;'); ic.value = e.icon; ic.maxLength = 4;
                ic.onchange = function () { e.icon = ic.value.trim() || '🧑‍🔬'; saveExperts(list); };
                const nm = mk('input', fieldStyle() + 'flex:1;min-width:0;font-weight:700;'); nm.value = e.name; nm.maxLength = 40; nm.placeholder = '成員名稱';
                nm.onchange = function () { e.name = nm.value.trim() || '未命名專家'; nm.value = e.name; saveExperts(list); };
                const rl = mk('div', 'flex:1.3;min-width:0;font-size:11px;color:' + T.muted + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', e.role || '（未設定角色）');
                const ed = mk('button', btnStyle(false), '詳細編輯'); ed.onclick = function () { overlay.remove(); openManager('experts', e.id); };
                row.append(cb, ic, nm, rl, ed);
                body.appendChild(row);
            });
            const add = mk('button', btnStyle(true), '＋ 新增成員');
            add.onclick = function () {
                const l = loadExperts();
                l.push(ENG().normalizeExpert({ id: 'x_' + Math.random().toString(36).slice(2, 9), name: '新成員', icon: '🙋', role: '你是一位熟悉相關領域的專家，請從你的專業角度發表看法。', knowledge: '', enabled: true }));
                saveExperts(l); render();
            };
            body.appendChild(add);
        };
        card.append(head, body); overlay.appendChild(card); document.body.appendChild(overlay); render();
    }
    // ── 會議設定分頁 ──
    function renderMeetingSettings(body, rerender) {
        const s = loadMSettings(), f = {};
        const sel = function (opts, val) { const e = mk('select', fieldStyle()); opts.forEach(function (o) { e.appendChild(new Option(o[1], o[0])); }); e.value = String(val); return e; };
        const num = function (val, lo, hi) { const e = mk('input', fieldStyle()); e.type = 'number'; e.min = lo; e.max = hi; e.value = val; return e; };
        const grid = mk('div', 'display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:4px 14px;');
        const cell = function (label, hint, el) { const w = mk('div'); w.appendChild(labelEl(label, hint)); w.appendChild(el); grid.appendChild(w); return el; };
        f.speakerMode = cell('誰來發言', '', sel([['auto', '主持人依問題挑選相關專家'], ['all', '全員依名單順序發言']], s.speakerMode));
        f.maxSpeakers = cell('主持人模式每回合最多幾位', '1–8', num(s.maxSpeakers, 1, 8));
        f.rounds = cell('每次發言後討論幾回合', '第 2 回合起專家互相回應', sel([['1', '1 回合（最省）'], ['2', '2 回合'], ['3', '3 回合']], s.rounds));
        f.length = cell('每則發言長度', '', sel([['short', '簡短（約 100 字）'], ['medium', '中等（約 200 字）'], ['long', '詳細（約 400 字）']], s.length));
        f.useKb = cell('專家發言前查知識庫', '', sel([['true', '是'], ['false', '否（只靠專業常識）']], String(s.useKb)));
        f.topK = cell('每位專家檢索段數', '1–12', num(s.topK, 1, 12));
        body.appendChild(mk('div', 'font-size:12px;color:' + T.muted + ';margin:2px 0 8px 0;line-height:1.6;', '每次你發言，大約會呼叫「（主持人 1 次）＋ 發言專家數 × 回合數」次模型；總結 1 次。成員與命名請按輸入框上方的「成員命名」。'));
        body.appendChild(grid);
        body.appendChild(labelEl('各角色使用的模型', '（留空＝專家用自己設定的模型，否則跟隨預設）'));
        const mg = mk('div', 'display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:4px 14px;');
        [['moderator', '主持人（挑人）'], ['speaker', '專家發言（預設）'], ['summarizer', '總結者']].forEach(function (p) {
            const w = mk('div'); w.appendChild(labelEl(p[1])); f['m_' + p[0]] = modelSelect(s.models[p[0]]); w.appendChild(f['m_' + p[0]]); mg.appendChild(w);
        });
        body.appendChild(mg);
        const foot = mk('div', 'display:flex;gap:8px;justify-content:flex-end;margin-top:16px;');
        const reset = mk('button', btnStyle(false), '還原預設');
        reset.onclick = function () { saveMSettings(MT().DEFAULTS); renderBar(); rerender(); };
        const save = mk('button', btnStyle(true), '儲存');
        save.onclick = function () {
            saveMSettings({ speakerMode: f.speakerMode.value, maxSpeakers: f.maxSpeakers.value, rounds: f.rounds.value, length: f.length.value, useKb: f.useKb.value === 'true', topK: f.topK.value,
                models: { moderator: f.m_moderator.value, speaker: f.m_speaker.value, summarizer: f.m_summarizer.value } });
            renderBar(); showToast('✅ 會議設定已儲存');
        };
        foot.append(reset, save); body.appendChild(foot);
    }


    // ═══════════ 並行作業（nova-tasks.js 的膠水層）═══════════
    const K_TSET = 'nova_tasks_settings_v1', K_TLOG = 'nova_exp_tasks_v1';
    const TK = function () { return window.NovaExpertTasks; };
    const TRT = window._novaExpTasksRT = window._novaExpTasksRT || { batches: [], cancelled: new Set(), abortByTask: {}, pool: null, boardOpen: false, timer: null };
    const ST_ICON = { pending: '⬜', waiting_dep: '⏳', queued: '🕓', running: '⚙️', done: '✅', failed: '❌', cancelled: '⏹', blocked: '🚫', interrupted: '⚠️' };
    const ST_TEXT = { pending: '待命', waiting_dep: '等上游完成', queued: '排隊中', running: '進行中', done: '完成', failed: '失敗', cancelled: '已取消', blocked: '被擋下', interrupted: '已中斷' };
    function loadTSettings() { let s = null; try { s = JSON.parse(localStorage.getItem(K_TSET) || 'null'); } catch (e) { s = null; } return TK().normalizeSettings(s || {}); }
    function saveTSettings(s) { try { localStorage.setItem(K_TSET, JSON.stringify(TK().normalizeSettings(s))); } catch (e) { /* ignore */ } if (TRT.pool) TRT.pool.setLimit(TK().normalizeSettings(s).concurrency); }
    function getPool() { if (!TRT.pool) TRT.pool = TK().createPool(loadTSettings().concurrency); return TRT.pool; }
    function isActiveStatus(s) { return s === 'pending' || s === 'waiting_dep' || s === 'queued' || s === 'running'; }
    function activeTaskCount() { let n = 0; TRT.batches.forEach(function (b) { b.tasks.forEach(function (t) { if (isActiveStatus(t.status)) n++; }); }); return n; }
    function persistBatches() {
        try {
            const slim = TRT.batches.slice(-20).map(function (b) {
                return { id: b.id, sessionId: b.sessionId, createdAt: b.createdAt, request: String(b.request || '').slice(0, 200), tasks: b.tasks.map(function (t) {
                    return { id: t.id, title: t.title, assigneeId: t.assigneeId, assigneeName: t.assigneeName, type: t.type, status: t.status, error: t.error || '', startedAt: t.startedAt || 0, endedAt: t.endedAt || 0, dependsOn: t.dependsOn };
                }) };
            });
            localStorage.setItem(K_TLOG, JSON.stringify(slim));
        } catch (e) { /* ignore */ }
    }
    function loadBatches() {
        let arr = []; try { arr = JSON.parse(localStorage.getItem(K_TLOG) || '[]') || []; } catch (e) { arr = []; }
        arr.forEach(function (b) { b.tasks.forEach(function (t) { if (isActiveStatus(t.status)) { t.status = 'interrupted'; t.error = '程式關閉或重新整理，任務中斷'; } }); b.restored = true; });
        TRT.batches = arr;
    }

    // ── 任務看板 ──
    function fmtDur(ms) { const s = Math.max(0, Math.floor(ms / 1000)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }
    let boardThrottle = null;
    function refreshBoard() { if (boardThrottle) return; boardThrottle = setTimeout(function () { boardThrottle = null; renderBoard(); renderBar(); }, 300); }
    function toggleBoard(force) {
        TRT.boardOpen = force == null ? !TRT.boardOpen : !!force;
        renderBoard(); renderBar();
    }
    function renderBoard() {
        let root = document.getElementById('nova-tasks-board');
        if (!TRT.boardOpen) { if (root) root.remove(); if (TRT.timer) { clearInterval(TRT.timer); TRT.timer = null; } return; }
        if (!root) {
            root = mk('div', 'position:fixed;right:16px;bottom:92px;width:min(420px,calc(100vw - 32px));max-height:60vh;display:flex;flex-direction:column;z-index:76;background:' + T.card + ';border:1px solid rgba(168,85,247,.6);border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.45);font-size:12px;color:' + T.text + ';');
            root.id = 'nova-tasks-board';
            document.body.appendChild(root);
        }
        root.textContent = '';
        const act = activeTaskCount();
        const head = mk('div', 'display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid ' + T.border + ';');
        head.appendChild(mk('b', 'flex:1;font-size:13px;', '⚡ 並行作業　' + (act ? act + ' 項進行中' : '目前沒有進行中的任務')));
        if (act) { const all = mk('button', 'background:#dc2626;color:#fff;border:0;border-radius:6px;padding:2px 9px;font-size:12px;font-weight:700;cursor:pointer;', '全部停止'); all.onclick = function () { stopAll(); }; head.appendChild(all); }
        const clr = mk('button', 'background:transparent;border:0;color:' + T.muted + ';cursor:pointer;font-size:12px;', '清除已結束'); clr.onclick = function () { clearFinished(); }; head.appendChild(clr);
        const x = mk('button', 'background:transparent;border:0;color:' + T.muted + ';font-size:16px;cursor:pointer;padding:0 4px;', '✕'); x.onclick = function () { toggleBoard(false); }; head.appendChild(x);
        const body = mk('div', 'overflow-y:auto;padding:8px 10px;');
        const batches = TRT.batches.slice().reverse().slice(0, 8);
        if (!batches.length) body.appendChild(mk('div', 'color:' + T.muted + ';padding:10px 4px;line-height:1.7;', '還沒有派過工。切到「並行作業」模式後，輸入像「@小白 做一份簡報 → @老王 蒐集資料」的交辦內容就會出現在這裡。'));
        const exMap = {}; loadExperts().forEach(function (e) { exMap[e.id] = e; });
        batches.forEach(function (b) {
            const bh = mk('div', 'color:' + T.muted + ';margin:6px 0 4px 0;font-size:11px;', new Date(b.createdAt).toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' }) + '　' + (b.request || '').slice(0, 40));
            body.appendChild(bh);
            b.tasks.forEach(function (t) {
                const ex = exMap[t.assigneeId];
                const row = mk('div', 'display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid ' + T.border + ';border-radius:9px;margin-bottom:5px;background:' + T.card2 + ';');
                row.appendChild(mk('span', 'flex:none;', ST_ICON[t.status] || '•'));
                const mid = mk('div', 'flex:1;min-width:0;');
                mid.appendChild(mk('div', 'font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', ((ex && ex.icon) || '🧑‍🔬') + ' ' + (t.assigneeName || '?') + '：' + t.title));
                const sub = (ST_TEXT[t.status] || t.status) + (t.status === 'running' && t.startedAt ? '　' + fmtDur(Date.now() - t.startedAt) : '') + (t.endedAt && t.startedAt && !isActiveStatus(t.status) ? '　耗時 ' + fmtDur(t.endedAt - t.startedAt) : '') + (t.note && isActiveStatus(t.status) ? '　' + t.note : '') + (t.error && !isActiveStatus(t.status) ? '　' + t.error : '');
                mid.appendChild(mk('div', 'font-size:11px;color:' + (t.status === 'failed' || t.status === 'blocked' ? '#f87171' : T.muted) + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', sub));
                row.appendChild(mid);
                if (isActiveStatus(t.status)) {
                    const s = mk('button', 'flex:none;background:#dc2626;color:#fff;border:0;border-radius:6px;padding:2px 8px;font-size:11px;font-weight:700;cursor:pointer;', '⏹ 停止');
                    s.onclick = function () { stopTask(t.id, t.title); };
                    row.appendChild(s);
                }
                body.appendChild(row);
            });
        });
        root.append(head, body);
        if (act && !TRT.timer) TRT.timer = setInterval(function () { if (TRT.boardOpen) renderBoard(); }, 1000);
        if (!act && TRT.timer) { clearInterval(TRT.timer); TRT.timer = null; }
    }
    function stopTask(id, title) {
        TRT.cancelled.add(id);
        const set = TRT.abortByTask[id];
        if (set) { set.forEach(function (c) { try { c.abort('user_stop'); } catch (e) { /* ignore */ } }); set.clear(); }
        showToast('⏹ 正在停止「' + (title || id) + '」…', 2500);
        refreshBoard();
    }
    function stopAll() { TRT.batches.forEach(function (b) { b.tasks.forEach(function (t) { if (isActiveStatus(t.status)) stopTask(t.id, t.title); }); }); }
    function clearFinished() {
        TRT.batches = TRT.batches.filter(function (b) { return b.tasks.some(function (t) { return isActiveStatus(t.status); }); });
        persistBatches(); renderBoard(); renderBar();
    }

    // ── 把成品貼回對話 ──
    function newSessionFor(task, request) {
        const id = String(Date.now()) + String(Math.floor(Math.random() * 90 + 10));
        try { appState.chatTitles = appState.chatTitles || {}; appState.chatTitles[id] = '⚡ ' + task.title; localStorage.setItem('nova_chat_titles', JSON.stringify(appState.chatTitles)); } catch (e) { /* ignore */ }
        const um = { id: genMsgId(), sessionId: id, text: '【交辦給 ' + task.assigneeName + '】' + task.instruction, sender: 'user', model: null, time: getTime(), sources: [], files: [], actionData: null };
        appState.messages.push(um); saveToDB('messages', um);
        return id;
    }
    function postTaskMessage(sid, task, ex, body, sources) {
        const msg = { id: genMsgId(), sessionId: sid, text: body, sender: 'ai', model: appState.currentModel, time: getTime(), sources: sources || [], files: [], actionData: null,
            speaker: { id: task.assigneeId, name: task.assigneeName, icon: (ex && ex.icon) || '🧑‍🔬', role: '', color: speakerColor(task.assigneeId) }, taskKey: task.id };
        appState.messages.push(msg); saveToDB('messages', msg); scheduleEmergencyBackup();
        if (String(sid) === String(appState.currentSessionId)) renderMessages();
        if (typeof renderChatHistoryList === 'function') renderChatHistoryList();
        return msg;
    }
    function onTaskFinished(batch, task) {
        persistBatches(); refreshBoard();
        const ex = loadExperts().filter(function (e) { return e.id === task.assigneeId; })[0];
        const origin = batch.sessionId;
        const dur = task.startedAt && task.endedAt ? '　耗時 ' + fmtDur(task.endedAt - task.startedAt) : '';
        if (task.status === 'done' && task.result) {
            let sid = origin;
            if (batch.settings.separateChats) { sid = newSessionFor(task, batch.request); }
            let body = '**✅ 任務完成：' + task.title + '**（' + (TK().TYPES[task.type] || task.type) + dur + '）\n\n' + task.result.text;
            if (task.result.defanged) body += '\n\n<sub>⚠️ 內含的 Python／命令列程式碼已降級為純文字，不會自動執行。</sub>';
            if (task.result.kbNames && task.result.kbNames.length && task.type !== 'slides') body += '\n\n<sub>📚 參考知識庫：' + task.result.kbNames.join('、') + '</sub>';
            const srcs = (task.result.sources || []).map(function (s) { return { uri: s.uri, title: s.title }; });
            postTaskMessage(sid, task, ex, body, srcs);
            const there = String(sid) !== String(appState.currentSessionId);
            if (there) showToast('⚡「' + task.title + '」已完成，' + (batch.settings.separateChats ? '已另開新對話：⚡ ' + task.title : '在原對話裡'), 7000);
        } else if (task.status === 'failed' || task.status === 'blocked') {
            addMessage((task.status === 'blocked' ? '🚫 任務「' : '❌ 任務「') + task.title + '」' + (task.status === 'blocked' ? '沒有執行：' : '失敗：') + (task.error || '未知原因') + '（' + task.assigneeName + '）', 'system', null, [], null, null, origin);
            if (String(origin) !== String(appState.currentSessionId)) showToast('⚡「' + task.title + '」' + (task.status === 'blocked' ? '被擋下' : '失敗') + '，詳情在原對話裡', 6000);
        } else if (task.status === 'cancelled') {
            addMessage('⏹ 任務「' + task.title + '」已取消（' + task.assigneeName + '）', 'system', null, [], null, null, origin);
        }
    }
    function batchSummary(batch) {
        const c = { done: 0, failed: 0, cancelled: 0, blocked: 0 };
        batch.tasks.forEach(function (t) { if (c[t.status] != null) c[t.status]++; });
        return '⚡ 並行作業結束：' + c.done + ' 項完成' + (c.failed ? '、' + c.failed + ' 項失敗' : '') + (c.blocked ? '、' + c.blocked + ' 項被擋下' : '') + (c.cancelled ? '、' + c.cancelled + ' 項取消' : '') + '。';
    }

    // ── 開始一批任務 ──
    function startBatch(sid, tasks, settings, request) {
        const bid = 'b' + Date.now().toString(36);
        const idMap = {}; tasks.forEach(function (t) { idMap[t.id] = bid + '_' + t.id; });
        const run = tasks.map(function (t) { return Object.assign({}, t, { id: idMap[t.id], dependsOn: (t.dependsOn || []).map(function (d) { return idMap[d]; }).filter(Boolean), status: 'pending', calls: 0 }); });
        const batch = { id: bid, sessionId: sid, createdAt: Date.now(), request: request, tasks: run, settings: settings };
        TRT.batches.push(batch); persistBatches();
        const lines = run.map(function (t, i) {
            const ups = (t.dependsOn || []).map(function (d) { const u = run.filter(function (x) { return x.id === d; })[0]; return u ? u.title : ''; }).filter(Boolean);
            return (i + 1) + '. **' + t.assigneeName + '**：' + t.title + '（' + (TK().TYPES[t.type] || t.type) + '）' + (ups.length ? ' ← 等「' + ups.join('、') + '」完成後承接' : '');
        }).join('\n');
        addMessage('⚡ **已派工 ' + run.length + ' 項**（同時最多 ' + settings.concurrency + ' 項，其餘排隊）\n' + lines + '\n\n你可以繼續聊天或切換對話；做好的成品會貼回' + (settings.separateChats ? '各自新開的對話' : '這個對話') + '，進度看右下角「任務看板」。', 'system', null, [], null, null, sid);
        TRT.boardOpen = true; renderBoard(); renderBar();
        const deps = {
            callModel: callModel, kbRetrieve: kbRetrieve, resolveModel: resolveModel, defaultModel: defaultModel(),
            isTaskCancelled: function (id) { return TRT.cancelled.has(id); },
            onTaskUpdate: function () { refreshBoard(); },
            onTaskDone: function (t) { onTaskFinished(batch, t); }
        };
        TK().runTasks({ tasks: run, experts: loadExperts(), settings: settings, deps: deps, pool: getPool() }).then(function () {
            persistBatches(); refreshBoard();
            if (run.length > 1 || run[0].status !== 'done') addMessage(batchSummary(batch), 'system', null, [], null, null, sid);
        }).catch(function (e) { addMessage('❌ 並行作業發生錯誤：' + ((e && e.message) || e), 'system', null, [], null, null, sid); });
    }

    // ── 派工確認視窗 ──
    function openDispatchConfirm(tasks0, experts, settings0, notes) {
        return new Promise(function (resolve) {
            const enabled = experts.filter(function (e) { return e.enabled; });
            const tasks = tasks0.map(function (t) { return Object.assign({}, t, { dependsOn: (t.dependsOn || []).slice() }); });
            const opts = { slidesImages: settings0.slidesImages, separateChats: settings0.separateChats, concurrency: settings0.concurrency };
            const old = document.getElementById('nova-dispatch-modal'); if (old) old.remove();
            const overlay = mk('div', 'position:fixed;inset:0;z-index:9100;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px;');
            overlay.id = 'nova-dispatch-modal';
            const card = mk('div', 'width:min(760px,100%);max-height:90vh;display:flex;flex-direction:column;background:' + T.card + ';color:' + T.text + ';border:1px solid ' + T.border + ';border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.5);overflow:hidden;');
            const head = mk('div', 'padding:12px 16px;border-bottom:1px solid ' + T.border + ';');
            head.appendChild(mk('b', 'font-size:15px;', '⚡ 確認派工'));
            head.appendChild(mk('div', 'font-size:12px;color:' + T.muted + ';margin-top:3px;', '請檢查負責人、任務內容與先後關係；確認後才會開始（每項任務都會消耗模型額度）。' + (notes && notes.length ? '　' + notes.join('；') : '')));
            const body = mk('div', 'padding:12px 16px;overflow-y:auto;flex:1;');
            const err = mk('div', 'color:#f87171;font-size:12px;margin:0 16px 6px 16px;display:none;');
            const foot = mk('div', 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:10px 16px;border-top:1px solid ' + T.border + ';');
            const render = function () {
                body.textContent = '';
                tasks.forEach(function (t, idx) {
                    const box = mk('div', 'border:1px solid ' + T.border + ';border-radius:10px;padding:9px 10px;margin-bottom:9px;background:' + T.card2 + ';');
                    const top = mk('div', 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;');
                    top.appendChild(mk('b', 'flex:none;color:#c084fc;', '#' + (idx + 1)));
                    const ti = mk('input', fieldStyle() + 'flex:1;min-width:120px;font-weight:700;'); ti.value = t.title; ti.maxLength = 40; ti.onchange = function () { t.title = ti.value.trim() || '未命名任務'; };
                    const as = mk('select', fieldStyle() + 'width:auto;');
                    enabled.forEach(function (e) { as.appendChild(new Option(e.icon + ' ' + e.name, e.id)); });
                    as.value = t.assigneeId; as.onchange = function () { t.assigneeId = as.value; const ex = enabled.filter(function (e) { return e.id === as.value; })[0]; t.assigneeName = ex ? ex.name : ''; };
                    const ty = mk('select', fieldStyle() + 'width:auto;');
                    Object.keys(TK().TYPES).forEach(function (k) { ty.appendChild(new Option(TK().TYPES[k], k)); });
                    ty.value = t.type; ty.onchange = function () { t.type = ty.value; };
                    const del = mk('button', btnStyle(false), '移除'); del.onclick = function () { tasks.splice(idx, 1); tasks.forEach(function (x) { x.dependsOn = x.dependsOn.filter(function (d) { return d !== t.id; }); }); render(); };
                    top.append(ti, as, ty, del);
                    const ins = mk('textarea', fieldStyle() + 'margin-top:6px;min-height:58px;resize:vertical;'); ins.value = t.instruction; ins.onchange = function () { t.instruction = ins.value.trim(); };
                    box.append(top, ins);
                    const others = tasks.filter(function (x) { return x.id !== t.id; });
                    if (others.length) {
                        const dep = mk('div', 'margin-top:6px;font-size:12px;color:' + T.muted + ';display:flex;flex-wrap:wrap;gap:4px 12px;align-items:center;');
                        dep.appendChild(mk('span', '', '等這些任務完成、拿到成果後才開始：'));
                        others.forEach(function (o) {
                            const lab = mk('label', 'display:inline-flex;align-items:center;gap:4px;cursor:pointer;');
                            const cb = mk('input'); cb.type = 'checkbox'; cb.checked = t.dependsOn.indexOf(o.id) >= 0; cb.style.accentColor = '#9333ea';
                            cb.onchange = function () { t.dependsOn = t.dependsOn.filter(function (d) { return d !== o.id; }); if (cb.checked) t.dependsOn.push(o.id); };
                            lab.append(cb, document.createTextNode('#' + (tasks.indexOf(o) + 1) + ' ' + o.title));
                            dep.appendChild(lab);
                        });
                        box.appendChild(dep);
                    }
                    body.appendChild(box);
                });
                const add = mk('button', btnStyle(false), '＋ 新增任務');
                add.onclick = function () {
                    const used = {}; tasks.forEach(function (x) { used[x.id] = 1; }); let n = tasks.length + 1; while (used['t' + n]) n++;
                    const ex = enabled[0]; tasks.push({ id: 't' + n, title: '新任務', assigneeId: ex.id, assigneeName: ex.name, type: 'report', instruction: '', dependsOn: [], status: 'pending' }); render();
                };
                body.appendChild(add);
                estimate();
            };
            const est = mk('span', 'font-size:12px;color:' + T.muted + ';flex:1;min-width:160px;');
            const estimate = function () { est.textContent = '共 ' + tasks.length + ' 項，約 ' + tasks.reduce(function (n, t) { return n + (t.type === 'slides' ? 1 : 1); }, 0) + ' 次模型呼叫（不含重試）'; };
            const mkChk = function (label, key) {
                const lab = mk('label', 'display:inline-flex;align-items:center;gap:5px;font-size:12px;cursor:pointer;');
                const cb = mk('input'); cb.type = 'checkbox'; cb.checked = !!opts[key]; cb.style.accentColor = '#9333ea'; cb.onchange = function () { opts[key] = cb.checked; };
                lab.append(cb, document.createTextNode(label)); return lab;
            };
            const cancel = mk('button', btnStyle(false), '取消');
            const go = mk('button', btnStyle(true), '⚡ 開始派工');
            cancel.onclick = function () { overlay.remove(); resolve(null); };
            go.onclick = function () {
                tasks.forEach(function (t) { t.instruction = String(t.instruction || '').trim(); });
                const v = TK().validateTasks(tasks, enabled);
                if (!v.ok) { err.style.display = 'block'; err.textContent = '⚠️ ' + v.errors.join('；'); return; }
                overlay.remove(); resolve({ tasks: v.tasks, opts: opts });
            };
            foot.append(est, mkChk('簡報要配圖', 'slidesImages'), mkChk('成果另開新對話', 'separateChats'), cancel, go);
            card.append(head, body, err, foot); overlay.appendChild(card); document.body.appendChild(overlay); render();
        });
    }

    // ── 入口：使用者在「並行作業」模式送出一句話 ──
    async function dispatch(text, o) {
        o = o || {};   // v1.1.0：o.auto＝由「智慧分派」自動轉進來；o.skipConfirm＝不跳確認視窗直接開工；o.reason＝判斷理由
        if (!TK() || !ENG()) { restoreInput(text); showToast('找不到並行作業引擎（nova-tasks.js 沒有載入）'); return; }
        const sid = appState.currentSessionId;
        const experts = loadExperts();
        if (!experts.some(function (e) { return e.enabled; })) { restoreInput(text); showToast('沒有啟用中的專家，請先到「管理專家」勾選'); openManager('experts'); return; }
        if (!hasLlmKey()) { restoreInput(text); showToast('並行作業需要 Gemini 或 OpenAI API Key，請先到設定頁填寫'); return; }
        const settings = loadTSettings();
        addMessage(text, 'user');
        if (o.auto) addMessage('🧭 AI 判斷這是需要多位專家分工的任務' + (o.reason ? '（' + String(o.reason).slice(0, 40) + '）' : '') + '，交給專家團隊並行處理。', 'system', null, [], null, null, sid);
        const st = { cancel: false };
        const panel = openPanel({ question: text, title: '⚡ 拆解任務中', onStop: stopHandler(st) });
        panel.progressText('派工模型正在把交辦內容拆成任務…');
        let plan = null, errText = '';
        try {
            plan = await TK().planTasks({ text: text, experts: experts, settings: settings, deps: { callModel: callModel, resolveModel: resolveModel, defaultModel: defaultModel() } });
        } catch (e) { errText = (e && e.message) || String(e); }
        window._novaExpAbort.clear();
        if (!plan) { panel.finish('❌ 無法拆出任務'); addMessage('❌ ' + errText + '\n\n範例：`@小白 做一份簡報 → @老王 蒐集資料` 或 `@老王 蒐集 X；@小白 同時寫一個小網頁`', 'system', null, [], null, null, sid); return; }
        panel.finish('✅ 已拆出 ' + plan.tasks.length + ' 項任務');
        let ans = null;
        if (o.skipConfirm) {   // v1.1.0：智慧分派且使用者關掉了「派工前確認」→ 驗證通過就直接開工；驗證不過仍跳確認視窗讓使用者修
            const v0 = TK().validateTasks(plan.tasks, experts.filter(function (e) { return e.enabled; }));
            if (v0 && v0.ok) ans = { tasks: v0.tasks, opts: { slidesImages: !!settings.slidesImages, separateChats: !!settings.separateChats } };
        }
        if (!ans) ans = await openDispatchConfirm(plan.tasks, experts, settings, plan.notes);
        if (!ans) { addMessage('已取消派工。', 'system', null, [], null, null, sid); return; }
        const eff = Object.assign({}, settings, { slidesImages: ans.opts.slidesImages, separateChats: ans.opts.separateChats });
        startBatch(sid, ans.tasks, eff, text);
    }

    // ═══ v1.1.0：一般對話「智慧分派」判斷（只回傳判斷結果，不執行；執行與設定在 nova-autoroute.js）。失敗／不確定一律回 chat ═══
    async function autoRoute(text) {
        try {
            const experts = (ENG() && TK()) ? loadExperts().filter(function (e) { return e.enabled; }) : [];
            if (!experts.length) return { route: 'chat', reason: '' };
            // 先問 Jev（有把握才採用；不確定／失敗／冷卻中／沒開 → 退回下面原本的 LLM 判斷）
            if (window.NovaJev && typeof NovaJev.routeTask === 'function') {
                try {
                    const jr = await NovaJev.routeTask(text, { experts: true, autonomous: false, expertNames: experts.slice(0, 12).map(function (e) { return e.name; }).join('、') });
                    if (jr && jr.ok && jr.route && (jr.route === 'chat' || jr.route === 'experts')) {
                        return { route: jr.route, reason: 'Jev 判斷（信心 ' + Math.round((jr.confidence || 0) * 100) + '%）', via: 'jev' };
                    }
                } catch (e) { /* Jev 出錯 → 照舊 LLM */ }
            }
            if (!hasLlmKey()) return { route: 'chat', reason: '沒有可用的 Gemini／OpenAI 金鑰' };
            const opts = ['- "chat"：一般問答、閒聊、解釋、查詢資訊、單一段文字／翻譯／程式碼片段、給建議、教學（「教我怎麼做」也算）。【不確定時一律選 chat】',
                '- "experts"：需要「多個面向／多項成果」的工作，能拆成 2 項以上可以同時進行的任務，分給不同專長的專家（例如：研究後做成報告＋簡報、同時做資料蒐集與網頁、比較多個方案並產出文件）。只要單一、簡單的成果就不要選 experts。可用專家：'
                + experts.slice(0, 12).map(function (e) { return e.name + (e.desc || e.description || e.role ? '（' + String(e.desc || e.description || e.role).slice(0, 24) + '）' : ''); }).join('、')];
            const prompt = '你是 NOVA 的「任務分流員」。使用者在一般對話框送出下面這句話，請判斷最適合的處理方式：\n' + opts.join('\n')
                + '\n\n只輸出 JSON，不要其他文字：{"route":"chat|experts","reason":"一句話（20 字內）"}\n\n使用者說：\n"""\n' + String(text).slice(0, 1500) + '\n"""';
            let out = null;
            try { out = await callModel({ model: defaultModel(), system: '你只輸出一個 JSON 物件。', text: prompt, json: true, maxOutputTokens: 200, thinking: 'low' }); }
            finally { try { window._novaExpAbort.clear(); } catch (e) { /* ignore */ } }
            const m = String((out && out.text) || '').match(/\{[\s\S]*\}/);
            if (!m) return { route: 'chat', reason: '' };
            const j = JSON.parse(m[0]);
            const route = String(j.route || 'chat').toLowerCase() === 'experts' ? 'experts' : 'chat';
            return { route: route, reason: String(j.reason || '').slice(0, 60) };
        } catch (e) {
            console.warn('[NOVA][智慧分派] 判斷失敗，照一般對話處理：', e && e.message);
            return { route: 'chat', reason: '' };
        }
    }
    function autoRouteAvailable() { try { return !!(ENG() && TK() && loadExperts().some(function (e) { return e.enabled; })); } catch (e) { return false; } }

    // ── 並行作業設定分頁 ──
    function renderTaskSettings(body, rerender) {
        const s = loadTSettings(), f = {};
        const sel = function (opts, val) { const e = mk('select', fieldStyle()); opts.forEach(function (o) { e.appendChild(new Option(o[1], o[0])); }); e.value = String(val); return e; };
        const num = function (val, lo, hi) { const e = mk('input', fieldStyle()); e.type = 'number'; e.min = lo; e.max = hi; e.value = val; return e; };
        const grid = mk('div', 'display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:4px 14px;');
        const cell = function (label, hint, el) { const w = mk('div'); w.appendChild(labelEl(label, hint)); w.appendChild(el); grid.appendChild(w); return el; };
        f.concurrency = cell('同時執行的任務數', '1–4；太高容易被限流（429）', num(s.concurrency, 1, 4));
        f.separateChats = cell('成果放在哪裡', '', sel([['false', '貼回交辦的同一個對話（預設）'], ['true', '每個任務成果另開新對話']], String(s.separateChats)));
        f.slidesImages = cell('簡報要配圖', '', sel([['false', '不配圖（純文字，最穩）'], ['true', '配圖（交給對話區現有機制搜圖）']], String(s.slidesImages)));
        f.useKb = cell('專家開工前查知識庫', '', sel([['true', '是'], ['false', '否']], String(s.useKb)));
        f.topK = cell('每個任務檢索段數', '1–12', num(s.topK, 1, 12));
        f.retry = cell('遇到暫時性錯誤重試次數', '0–3', num(s.retry, 0, 3));
        body.appendChild(mk('div', 'font-size:12px;color:' + T.muted + ';margin:2px 0 8px 0;line-height:1.6;', '並行作業：在輸入框上方切到「⚡ 並行作業」，用「@專家名 要做的事」交辦（可一次交辦多位；用「→」或「做完後交給」表示 B 要等 A 的成果續做）。確認後各專家同時開工，成品貼回對話。'));
        body.appendChild(grid);
        body.appendChild(labelEl('各角色使用的模型', '（留空＝專家用自己設定的模型，否則跟隨預設）'));
        const mg = mk('div', 'display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:4px 14px;');
        [['dispatcher', '派工（拆任務）'], ['worker', '執行任務（預設）']].forEach(function (p) {
            const w = mk('div'); w.appendChild(labelEl(p[1])); f['m_' + p[0]] = modelSelect(s.models[p[0]]); w.appendChild(f['m_' + p[0]]); mg.appendChild(w);
        });
        body.appendChild(mg);
        try { if (window.NovaAutoRoute) NovaAutoRoute.renderSettings(body); } catch (e) { /* ignore */ }
        const foot = mk('div', 'display:flex;gap:8px;justify-content:flex-end;margin-top:16px;');
        const reset = mk('button', btnStyle(false), '還原預設');
        reset.onclick = function () { saveTSettings(TK().DEFAULTS); renderBar(); rerender(); };
        const save = mk('button', btnStyle(true), '儲存');
        save.onclick = function () {
            saveTSettings({ concurrency: f.concurrency.value, separateChats: f.separateChats.value === 'true', slidesImages: f.slidesImages.value === 'true', useKb: f.useKb.value === 'true', topK: f.topK.value, retry: f.retry.value,
                models: { dispatcher: f.m_dispatcher.value, worker: f.m_worker.value } });
            renderBar(); showToast('✅ 並行作業設定已儲存');
        };
        foot.append(reset, save); body.appendChild(foot);
    }


    function init() {
        injectStyle();
        if (TK()) { try { loadBatches(); } catch (e) { /* ignore */ } }
        renderBar();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else setTimeout(init, 0);

    return { isOn: isOn, toggle: toggle, ask: ask, say: say, send: send, dispatch: dispatch, autoRoute: autoRoute, autoRouteAvailable: autoRouteAvailable, toggleBoard: toggleBoard, summarizeNow: summarizeNow, newMeeting: newMeeting, openRoster: openRoster, subMode: subMode, setSubMode: setSubMode, openManager: openManager, loadExperts: loadExperts, loadSettings: loadSettings, renderBar: renderBar, rerender: renderBar };
})();
window.toggleNovaExpertsMode = function () { window.NovaExpertsGlue.toggle(); };


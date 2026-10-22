/* ═════════════════════════════════════════════
   nova-autoroute.js — NOVA Android 一般對話「智慧分派」（跟 index.html 放同一個資料夾 www/）
   版本：v1.1.1
   版本紀錄：
   v1.1.2 - App v2.6.89。私密對話不做智慧分派判斷。
   v1.1.1 - App v2.6.76。定位改由 novaAutoTask.run 統一附加（所有自主任務都適用），這裡不再自己附加座標。
   v1.1.0 - App v2.6.75。新增「自主任務」這條路（參考桌面版 NovaAutoRoute／nova-jev.js routeTask）：一般對話送出的話，除了判斷要不要派專家，
            也判斷「是不是該交給 AI 自主任務（/ap）」。判斷流程：
            ① 便宜條件先擋（不是 / 指令、沒附檔案、非即時／口譯／翻譯模式、沒有正在跑的自主任務、不是簡報／生圖／排程／提醒／鬧鐘這類已有專屬流程的需求、
              自主任務這條路另外要求訊息裡有「動手」的線索：開啟／傳送／儲存／整理／執行／下載／附近…，避免每句話都多花一次判斷）；
            ② 固定規則：「離我／附近／最近」＋「放映／場次／營業時間／價格／整理／列出…」的複合查詢，不看說法直接判自主任務；
            ③ 先問 Jev（NovaJev.routeTask；有把握才採用，判 chat 要 ≥ 門檻、判 autonomous 要 ≥ max(門檻, 0.8)）；
            ④ Jev 沒開／不確定／失敗 → 退回一次輕量 Gemini 判斷（chat／experts／autonomous ＋ 是否要操作畫面）；失敗或不確定一律照一般對話。
            判成自主任務後的同意流程（設定「智慧分派：自主任務」）：預設「每次先問我」（按確定＝自主任務、取消＝改用一般對話）；
            選「只在不用操作畫面時自動執行」時，純文字任務（搜尋／Python／指令）直接開始，需要操作手機畫面的仍會先問。
            訊息涉及「附近／離我／最近」且 App 已有定位時，會把座標附在任務目標後面（避免自主任務自己去猜位置）。
            設定：設定 → Agent 與自主任務 →「智慧分派：自主任務」（預設開啟、先問我）。renderSettings(body, 'autonomous') 畫這一區；
            舊的專家區仍由「多專家 → 並行作業」分頁呼叫 renderSettings(body)。儲存鍵 nova_autoroute_v1 新增 autonomous／autonomousConsent 兩欄。
   v1.0.0 - App v2.6.58。移植桌面版 v3.66／v3.67 的「智慧分派」專家部分（NOVA-AUTOROUTE 區塊）：開啟後，一般對話（多專家模式關閉時）送出的話
            （10 字以上、不是 / 指令、沒附檔案、非即時／口譯／翻譯模式）先判斷類型（NovaExpertsGlue.autoRoute：先問 Jev，不確定退回一次輕量 LLM）；
            判成「需要多面向成果」就交給並行作業流程（NovaExpertsGlue.dispatch）。可選「派工前先顯示任務清單確認」（預設勾選）。
            預設【關閉】＝完全不判斷、不多花額度；判斷失敗／不確定一律照一般對話。手機版沒有「自主任務／桌面操作」分流，所以只有專家這一條。
            設定：「多專家 → 並行作業」分頁的「智慧分派」區（nova-experts-glue.js 呼叫 NovaAutoRoute.renderSettings）。儲存鍵 nova_autoroute_v1。
   對外：window.NovaAutoRoute = { shouldTry(text, ctx), run(text, input), load(), save(s), renderSettings(body, part), classify(text, want) }
   ═════════════════════════════════════════════ */
(function () {
    'use strict';
    var KEY = 'nova_autoroute_v1';
    var busy = false;
    function load() {
        var o = null; try { o = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { o = null; } o = o || {};
        return { experts: !!o.experts, expertsConfirm: o.expertsConfirm !== false,
                 autonomous: o.autonomous !== false, autonomousConsent: o.autonomousConsent === 'auto' ? 'auto' : 'ask' };
    }
    function save(s) {
        try {
            localStorage.setItem(KEY, JSON.stringify({ experts: !!s.experts, expertsConfirm: s.expertsConfirm !== false,
                autonomous: s.autonomous !== false, autonomousConsent: s.autonomousConsent === 'auto' ? 'auto' : 'ask' }));
        } catch (e) { /* ignore */ }
    }
    function toast(m, d) { try { showToast(m, d); } catch (e) { /* ignore */ } }

    // 「動手」的線索：沒有這類字眼的訊息（純問答、聊天、寫作）不送去判斷自主任務，省一次呼叫、也不會讓每句話都卡一下
    var ACTION_HINT = /打開|開啟|啟動|關閉|關掉|切換|點擊|點開|點選|按下|滑動|傳送|傳給|傳訊|發送|發訊|發給|寄給|寄信|回覆|打電話|撥打|訂位|預約|預訂|下單|付款|轉帳|安裝|解除安裝|下載|上傳|截圖|拍照|拍張|錄影|錄下|儲存|存到|存成|存檔|寫入|建立檔案|建立資料夾|整理|搬移|重新命名|刪除|備份|執行|運行|跑一下|定位|附近|離我|最近的|termux|python|shell|指令|腳本|藍牙|wifi|音量|亮度|手電筒|並且|然後再|接著|之後再|app/i;
    // 已有專屬流程的需求（簡報／生圖／排程／提醒／鬧鐘…）不要搶
    var SKIP = /簡報|ppt|生圖|畫(一|個|張|幅)|生成.{0,6}圖|圖片|每(天|週|周|月|個)|定時|排程|循環|提醒我|鬧鐘|錄音|live影像|口譯/i;
    var NEARBY = /附近|離我|最近的?|我這邊|我這裡|我這裡|周邊|周圍/;
    var NEARBY_EXTRA = /放映|場次|營業時間|開到幾點|價格|有賣|比較|並且|然後|整理|列出/;

    function hasGemini() { try { return !!(appState.keys && appState.keys.gemini); } catch (e) { return false; } }
    function canExperts() { try { return !!(load().experts && window.NovaExpertsGlue && typeof NovaExpertsGlue.autoRoute === 'function' && NovaExpertsGlue.autoRouteAvailable()); } catch (e) { return false; } }
    function canAutonomous() {
        try {
            if (!load().autonomous || !hasGemini()) return false;
            var at = window.novaAutoTask;
            if (!at || typeof at.run !== 'function') return false;
            if (typeof at.isRunning === 'function' && at.isRunning()) return false;
            return true;
        } catch (e) { return false; }
    }
    function want(text) {
        var t = String(text || '').trim();
        return { experts: canExperts() && t.length >= 10,
                 autonomous: canAutonomous() && t.length >= 6 && !SKIP.test(t) && ACTION_HINT.test(t) };
    }

    // 這一則訊息要不要送去判斷（便宜的條件先擋掉，避免每句話都多花一次判斷）
    function shouldTry(text, ctx) {
        ctx = ctx || {};
        var t = String(text || '').trim();
        if (!t || t.charAt(0) === '/') return false;
        if (window.novaPrivIsCur && novaPrivIsCur()) return false;   // v1.1.2：私密對話不做智慧分派判斷（不經 Gemini／OpenAI／Jev）
        if (ctx.hasFile || appState.isLiveMode || appState.pendingAnalyzeContextId) return false;
        if (appState.translateMode && appState.translateMode !== 'off') return false;
        if (/錄音|live影像|口譯/i.test(t)) return false;
        var w = want(t);
        return !!(w.experts || w.autonomous);
    }
    function clearInput(input) { try { if (input) { input.value = ''; if (typeof autoResizeInput === 'function') autoResizeInput(input); if (typeof updateSmartActionBtn === 'function') updateSmartActionBtn(); } chatInitialInput = ''; } catch (e) { /* ignore */ } }

    // ── 判斷：回傳 {route:'chat'|'experts'|'autonomous', needsScreen, reason}；任何失敗／不確定一律 chat ──
    async function classify(text, w) {
        var t = String(text || '').trim();
        w = w || want(t);
        if (!w.experts && !w.autonomous) return { route: 'chat', reason: '' };
        try {
            var experts = [];
            if (w.experts) { try { experts = NovaExpertsGlue.loadExperts().filter(function (e) { return e.enabled; }); } catch (e) { experts = []; } if (!experts.length) w.experts = false; }
            if (!w.experts && !w.autonomous) return { route: 'chat', reason: '' };
            // ② 固定規則：「附近」＋額外條件的複合查詢，不看說法直接判自主任務
            if (w.autonomous && NEARBY.test(t) && NEARBY_EXTRA.test(t)) return { route: 'autonomous', needsScreen: false, reason: '附近＋額外條件的複合查詢（固定規則）' };
            // ③ 先問 Jev（有把握才採用；沒開／不確定／失敗／冷卻中 → 退回 ④）
            if (window.NovaJev && typeof NovaJev.routeTask === 'function') {
                try {
                    var jr = await NovaJev.routeTask(t, { experts: !!w.experts, autonomous: !!w.autonomous, expertNames: experts.slice(0, 12).map(function (e) { return e.name; }).join('、') });
                    if (jr && jr.ok && jr.route && (jr.route === 'chat' || (jr.route === 'experts' && w.experts) || (jr.route === 'autonomous' && w.autonomous))) {
                        return { route: jr.route, needsScreen: jr.route === 'autonomous' && !!jr.desktop, reason: 'Jev 判斷（信心 ' + Math.round((jr.confidence || 0) * 100) + '%）', via: 'jev' };
                    }
                } catch (e) { /* Jev 出錯 → 照舊 LLM */ }
            }
            // ④ 一次輕量 Gemini 判斷
            if (!hasGemini()) return { route: 'chat', reason: '沒有 Gemini 金鑰' };
            var opts = ['- "chat"：一般問答、閒聊、解釋、查一個資訊（單次搜尋就能回答，例如天氣、新聞、一般知識）、單一段文字／翻譯／程式碼片段、給建議、教學（「教我怎麼做」也算）。【不確定時一律選 chat】'];
            if (w.experts) opts.push('- "experts"：需要「多個面向／多項成果」的工作，能拆成 2 項以上可以同時進行的任務，分給不同專長的專家（例如：研究後做成報告＋簡報、同時做資料蒐集與網頁、比較多個方案並產出文件）。只要單一、簡單的成果就不要選 experts。可用專家：'
                + experts.slice(0, 12).map(function (e) { return e.name + (e.desc || e.description || e.role ? '（' + String(e.desc || e.description || e.role).slice(0, 24) + '）' : ''); }).join('、'));
            if (w.autonomous) opts.push('- "autonomous"：要在使用者的手機上「實際動手」完成好幾個步驟——操作手機 App（開啟 App、點按、輸入、傳訊息、設定）、執行 Python 或 Termux 指令（整理／讀寫檔案、批次處理、取得手機資料如定位／電量／簡訊）、需要連續查資料再整理成結果或檔案的多步驟任務。只是問答、查一個資訊、寫文章／翻譯／教學、或寫一段程式給使用者自己跑，都不算。若主要得靠操作手機畫面（點擊、輸入、開 App），把 "needs_screen" 設為 true；只靠搜尋／Python／指令就能完成則設為 false。');
            var routes = ['chat'].concat(w.experts ? ['experts'] : [], w.autonomous ? ['autonomous'] : []).join('|');
            var prompt = '你是 NOVA 的「任務分流員」。使用者在一般對話框送出下面這句話，請判斷最適合的處理方式：\n' + opts.join('\n')
                + '\n\n只輸出 JSON，不要其他文字：{"route":"' + routes + '","needs_screen":false,"reason":"一句話（20 字內）"}\n\n使用者說：\n"""\n' + t.slice(0, 1500) + '\n"""';
            var model = window.NOVA_GEMINI_MODEL_DEFAULT || 'gemini-3.6-flash';
            var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
            var timer = setTimeout(function () { try { if (ctl) ctl.abort(); } catch (e) { /* ignore */ } }, 8000);
            var res;
            try {
                res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(appState.keys.gemini), {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl ? ctl.signal : undefined,
                    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }],
                        generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 1024 } })
                });
            } finally { clearTimeout(timer); }
            if (!res || !res.ok) return { route: 'chat', reason: '' };
            var d = await res.json();
            var parts = (((d.candidates || [])[0] || {}).content || {}).parts || [];
            var txt = parts.filter(function (p) { return !p.thought; }).map(function (p) { return p.text || ''; }).join('');
            var m = txt.match(/\{[\s\S]*\}/);
            if (!m) return { route: 'chat', reason: '' };
            var j = JSON.parse(m[0]);
            var route = String(j.route || 'chat').toLowerCase();
            if (route === 'experts' && !w.experts) route = 'chat';
            if (route === 'autonomous' && !w.autonomous) route = 'chat';
            if (route !== 'experts' && route !== 'autonomous') route = 'chat';
            return { route: route, needsScreen: route === 'autonomous' && !!j.needs_screen, reason: String(j.reason || '').slice(0, 60), via: 'llm' };
        } catch (e) {
            console.warn('[NOVA][智慧分派] 判斷失敗，照一般對話處理：', e && e.message);
            return { route: 'chat', reason: '' };
        }
    }

    // 回傳 true＝這句話已被接手（呼叫端直接 return）；false＝照一般對話走
    async function run(text, input) {
        if (busy) return true;                 // 判斷中再按送出：吞掉，避免同一句送兩次
        busy = true;
        try {
            var s = load();
            var w = want(text);
            if (!w.experts && !w.autonomous) return false;
            toast('🧭 AI 正在判斷任務類型…', 1600);
            var r = await classify(text, w);
            if (!r || r.route === 'chat') return false;
            if (r.route === 'experts') {
                clearInput(input);
                NovaExpertsGlue.dispatch(text, { auto: true, reason: r.reason, skipConfirm: !s.expertsConfirm });   // 不 await：派工視窗開著時輸入框不鎖
                return true;
            }
            if (r.route === 'autonomous') {
                var needAsk = s.autonomousConsent === 'ask' || !!r.needsScreen;   // 要操作手機畫面的，即使選了自動也一定先問
                if (needAsk) {
                    var ok = await showConfirm('🧭 AI 判斷這件事適合交給「AI 自主任務」——會自己連續動手完成多個步驟（' + (r.needsScreen ? '需要操作手機畫面、' : '') + '搜尋、執行 Python／指令）。'
                        + (r.reason ? '\n判斷理由：' + String(r.reason).replace(/[<>&]/g, '') : '') + '\n\n按「確定」＝用 AI 自主任務執行；按「取消」＝改用一般對話回答。');
                    if (!ok) return false;
                } else {
                    try { addMessage('🧭 AI 判斷這是需要連續動手執行的任務' + (r.reason ? '（' + r.reason + '）' : '') + '，已自動切換成 AI 自主任務（不需要操作畫面）。', 'system'); } catch (e) { /* ignore */ }
                }
                if (!window.novaAutoTask || typeof window.novaAutoTask.run !== 'function') return false;
                clearInput(input);
                addMessage('🤖 啟動 AI 自主任務：' + String(text).trim(), 'user');
                window.novaAutoTask.run(String(text).trim());   // 定位由 novaAutoTask.run 自動附加（v2.6.76）   // 不 await：任務可能跑很久
                return true;
            }
            return false;
        } catch (e) {
            console.warn('[NOVA][智慧分派] 失敗，照一般對話處理：', e && e.message);
            return false;
        } finally { busy = false; }
    }

    // 設定區。part==='autonomous'：自主任務這一區（畫進「Agent 與自主任務」分頁，樣式沿用該分頁的 Tailwind 類別）；
    // 其他：專家這一區（畫進「並行作業」設定分頁；樣式沿用該分頁的行內樣式）
    function renderSettings(body, part) {
        if (!body) return;
        var s = load();
        if (part === 'autonomous') {
            body.innerHTML = '';
            var box = document.createElement('div');
            box.className = 'bg-slate-800/50 rounded-xl p-3 border border-slate-700 space-y-2';
            var h1 = document.createElement('div'); h1.className = 'text-xs font-bold text-sky-300'; h1.textContent = '🧭 智慧分派：自主任務'; box.appendChild(h1);
            var d1 = document.createElement('p'); d1.className = 'text-[10px] text-slate-400 leading-relaxed';
            d1.textContent = '在一般對話輸入需要「連續動手」的要求（例如開 App 做事、整理檔案、跑 Python／指令、取得手機資料），AI 會先判斷是不是該交給自主任務，不必自己輸入 /ap。純問答、寫作、查單一資訊仍走一般對話。判斷失敗或不確定一律當一般對話；只有含「開啟／傳送／儲存／整理／執行…」這類動手字眼的訊息才會送去判斷。';
            box.appendChild(d1);
            var lab = document.createElement('label'); lab.className = 'flex items-center gap-2 text-[12px] text-slate-200';
            var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = s.autonomous; cb.style.cssText = 'width:18px;height:18px;accent-color:#9333ea;';
            lab.appendChild(cb); lab.appendChild(document.createTextNode('一般對話自動判斷是否使用自主任務')); box.appendChild(lab);
            var sl = document.createElement('div'); sl.className = 'text-[10px] text-slate-300 font-bold'; sl.textContent = '判斷成自主任務之後'; box.appendChild(sl);
            var sel = document.createElement('select'); sel.className = 'w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-xs text-slate-200 outline-none';
            [['ask', '每次先問我（建議）'], ['auto', '只在不需要操作畫面時自動執行（要操作畫面的仍會先問）']].forEach(function (o) { var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; sel.appendChild(op); });
            sel.value = s.autonomousConsent; sel.disabled = !s.autonomous; box.appendChild(sel);
            cb.onchange = function () { var x = load(); x.autonomous = cb.checked; save(x); sel.disabled = !cb.checked; };
            sel.onchange = function () { var x = load(); x.autonomousConsent = sel.value === 'auto' ? 'auto' : 'ask'; save(x); };
            body.appendChild(box);
            return;
        }
        var wrap = document.createElement('div');
        wrap.style.cssText = 'margin-top:14px;padding-top:10px;border-top:1px solid var(--nv-line,#334155);';
        var h = document.createElement('div'); h.style.cssText = 'font-size:13px;font-weight:700;'; h.textContent = '🧭 智慧分派（一般對話）'; wrap.appendChild(h);
        var d = document.createElement('div'); d.style.cssText = 'font-size:12px;opacity:.7;line-height:1.6;margin:2px 0 6px;';
        d.textContent = '開啟後，在一般對話送出的長要求會先判斷：需要多位專家分工的，自動交給並行作業；其餘照一般對話。預設關閉，關閉時完全不判斷、不多花額度。（要不要自動改用「自主任務」，在設定 → Agent 與自主任務。）';
        wrap.appendChild(d);
        function row(label, checked, onchg) {
            var lab = document.createElement('label'); lab.style.cssText = 'display:flex;align-items:center;gap:10px;min-height:40px;font-size:14px;cursor:pointer;';
            var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = checked; cb.style.cssText = 'width:20px;height:20px;flex:none;accent-color:#9333ea;';
            cb.onchange = function () { onchg(cb.checked); };
            lab.append(cb, document.createTextNode(label)); wrap.appendChild(lab); return cb;
        }
        var c2;
        var c1 = row('自動派專家並行作業', s.experts, function (v) { var x = load(); x.experts = v; save(x); c2.disabled = !v; });
        c2 = row('派工前先顯示任務清單確認（建議）', s.expertsConfirm, function (v) { var x = load(); x.expertsConfirm = v; save(x); });
        c2.disabled = !s.experts;
        body.appendChild(wrap);
    }
    window.NovaAutoRoute = { shouldTry: shouldTry, run: run, load: load, save: save, renderSettings: renderSettings, classify: classify };
})();

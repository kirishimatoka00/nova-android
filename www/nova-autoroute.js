/* ═════════════════════════════════════════════
   nova-autoroute.js — NOVA Android 一般對話「智慧分派」（跟 index.html 放同一個資料夾 www/）
   版本：v1.0.0
   版本紀錄：
   v1.0.0 - App v2.6.58。移植桌面版 v3.66／v3.67 的「智慧分派」專家部分（NOVA-AUTOROUTE 區塊）：開啟後，一般對話（多專家模式關閉時）送出的話
            （10 字以上、不是 / 指令、沒附檔案、非即時／口譯／翻譯模式）先判斷類型（NovaExpertsGlue.autoRoute：先問 Jev，不確定退回一次輕量 LLM）；
            判成「需要多面向成果」就交給並行作業流程（NovaExpertsGlue.dispatch）。可選「派工前先顯示任務清單確認」（預設勾選）。
            預設【關閉】＝完全不判斷、不多花額度；判斷失敗／不確定一律照一般對話。手機版沒有「自主任務／桌面操作」分流，所以只有專家這一條。
            設定：「多專家 → 並行作業」分頁的「智慧分派」區（nova-experts-glue.js 呼叫 NovaAutoRoute.renderSettings）。儲存鍵 nova_autoroute_v1。
   對外：window.NovaAutoRoute = { shouldTry(text, ctx), run(text, input), load(), save(s), renderSettings(body) }
   ═════════════════════════════════════════════ */
(function () {
    'use strict';
    var KEY = 'nova_autoroute_v1';
    var busy = false;
    function load() {
        var o = null; try { o = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { o = null; } o = o || {};
        return { experts: !!o.experts, expertsConfirm: o.expertsConfirm !== false };
    }
    function save(s) { try { localStorage.setItem(KEY, JSON.stringify({ experts: !!s.experts, expertsConfirm: s.expertsConfirm !== false })); } catch (e) { /* ignore */ } }
    function toast(m, d) { try { showToast(m, d); } catch (e) { /* ignore */ } }

    // 這一則訊息要不要送去判斷（便宜的條件先擋掉，避免每句話都多花一次判斷）
    function shouldTry(text, ctx) {
        ctx = ctx || {};
        var s = load();
        if (!s.experts) return false;
        if (!window.NovaExpertsGlue || typeof NovaExpertsGlue.autoRoute !== 'function' || !NovaExpertsGlue.autoRouteAvailable()) return false;
        var t = String(text || '').trim();
        if (t.length < 10 || t.charAt(0) === '/') return false;
        if (ctx.hasFile || appState.isLiveMode || appState.pendingAnalyzeContextId) return false;
        if (appState.translateMode && appState.translateMode !== 'off') return false;
        if (/錄音|live影像|口譯/i.test(t)) return false;
        return true;
    }
    function clearInput(input) { try { if (input) { input.value = ''; if (typeof autoResizeInput === 'function') autoResizeInput(input); if (typeof updateSmartActionBtn === 'function') updateSmartActionBtn(); } chatInitialInput = ''; } catch (e) { /* ignore */ } }

    // 回傳 true＝這句話已被接手（呼叫端直接 return）；false＝照一般對話走
    async function run(text, input) {
        if (busy) return true;                 // 判斷中再按送出：吞掉，避免同一句送兩次
        busy = true;
        try {
            var s = load();
            toast('🧭 AI 正在判斷任務類型…', 1600);
            var r = await NovaExpertsGlue.autoRoute(text);
            if (!r || r.route !== 'experts') return false;
            clearInput(input);
            NovaExpertsGlue.dispatch(text, { auto: true, reason: r.reason, skipConfirm: !s.expertsConfirm });   // 不 await：派工視窗開著時輸入框不鎖
            return true;
        } catch (e) {
            console.warn('[NOVA][智慧分派] 失敗，照一般對話處理：', e && e.message);
            return false;
        } finally { busy = false; }
    }

    // 設定區（畫進「並行作業」設定分頁；樣式沿用該分頁的行內樣式）
    function renderSettings(body) {
        if (!body) return;
        var s = load();
        var wrap = document.createElement('div');
        wrap.style.cssText = 'margin-top:14px;padding-top:10px;border-top:1px solid var(--nv-line,#334155);';
        var h = document.createElement('div'); h.style.cssText = 'font-size:13px;font-weight:700;'; h.textContent = '🧭 智慧分派（一般對話）'; wrap.appendChild(h);
        var d = document.createElement('div'); d.style.cssText = 'font-size:12px;opacity:.7;line-height:1.6;margin:2px 0 6px;';
        d.textContent = '開啟後，在一般對話送出的長要求會先判斷：需要多位專家分工的，自動交給並行作業；其餘照一般對話。預設關閉，關閉時完全不判斷、不多花額度。';
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
    window.NovaAutoRoute = { shouldTry: shouldTry, run: run, load: load, save: save, renderSettings: renderSettings };
})();

/* ═════════════════════════════════════════════════════════════════
   nova-gemini-safety.js — Gemini 安全設定（逐類別調整封鎖閾值）（跟 index.html 放同一個資料夾 www/）
   版本：v1.0.0
   版本紀錄：
   v1.0.0 - App v2.6.101。依官方文件 ai.google.dev/gemini-api/docs/generate-content/safety-settings：
            設定頁新增「Gemini 安全設定」區塊，四個類別（騷擾／仇恨言論／煽情露骨內容／危險內容）各自選封鎖閾值：
            預設（不送）、OFF、BLOCK_NONE、BLOCK_ONLY_HIGH、BLOCK_MEDIUM_AND_ABOVE、BLOCK_LOW_AND_ABOVE。
            做法：在 fetch 這一層統一處理（與 index.html 的 gemini-3.8 取樣參數處理相同理由——呼叫點有幾十處），
            只對 generativelanguage.googleapis.com 的 generateContent／streamGenerateContent JSON 請求補上 safetySettings；
            選「預設」的類別不送（沿用官方預設）；請求本身已帶 safetySettings 的原樣放行；embedding／predict／interactions 不動。
            設定存在 localStorage 'nova_gemini_safety'。
   ═════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';
    var W = window, D = document, KEY = 'nova_gemini_safety';
    var CATS = [
        ['HARM_CATEGORY_HARASSMENT', '騷擾', '針對特定身分或受保護特質的負面或有害言論'],
        ['HARM_CATEGORY_HATE_SPEECH', '仇恨言論', '粗俗、不尊重或不雅的內容'],
        ['HARM_CATEGORY_SEXUALLY_EXPLICIT', '煽情露骨內容', '涉及性行為或其他猥褻情事的內容'],
        ['HARM_CATEGORY_DANGEROUS_CONTENT', '危險內容', '宣傳、鼓吹或助長有害行為的內容']
    ];
    var LEVELS = [
        ['', '預設（不送，沿用官方預設）'],
        ['OFF', '關閉篩選器（OFF）'],
        ['BLOCK_NONE', '不封鎖任何項目（BLOCK_NONE）'],
        ['BLOCK_ONLY_HIGH', '封鎖少數：只擋高機率（BLOCK_ONLY_HIGH）'],
        ['BLOCK_MEDIUM_AND_ABOVE', '封鎖一些：中等以上（BLOCK_MEDIUM_AND_ABOVE）'],
        ['BLOCK_LOW_AND_ABOVE', '封鎖多數：低以上（BLOCK_LOW_AND_ABOVE）']
    ];
    var VALID = {}; LEVELS.forEach(function (l) { if (l[0]) VALID[l[0]] = 1; });

    function load() {
        try { var o = JSON.parse(localStorage.getItem(KEY) || '{}'); return (o && typeof o === 'object') ? o : {}; } catch (e) { return {}; }
    }
    function save(o) { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) {} }
    function build() {
        var o = load(), out = [];
        CATS.forEach(function (c) { if (VALID[o[c[0]]]) out.push({ category: c[0], threshold: o[c[0]] }); });
        return out;
    }

    /* ───────── fetch 統一補上 safetySettings ───────── */
    var RE = /generativelanguage\.googleapis\.com\/[^?]*\/models\/[^\/:?]+:(?:stream)?generateContent/i;
    function patchFetch() {
        if (W.__novaGeminiSafetyPatched || typeof W.fetch !== 'function') return;
        W.__novaGeminiSafetyPatched = true;
        var orig = W.fetch;
        W.fetch = function (input, init) {
            try {
                var url = typeof input === 'string' ? input : ((input && input.url) || '');
                if (init && typeof init.body === 'string' && RE.test(url)) {
                    var s = build();
                    if (s.length) {
                        var j = JSON.parse(init.body);
                        if (j && typeof j === 'object' && !j.safetySettings && !j.safety_settings) {
                            j.safetySettings = s;
                            init = Object.assign({}, init, { body: JSON.stringify(j) });
                        }
                    }
                }
            } catch (e) { /* 不影響原請求 */ }
            return orig.call(this, input, init);
        };
    }

    /* ───────── 設定頁 UI ───────── */
    function injectUi() {
        if (D.getElementById('nova-gemsafe-box')) return true;
        var input = D.getElementById('nova-images-import-input'); if (!input) return false;
        var row = input.closest ? input.closest('div.flex.items-center.justify-between') : null;
        if (!row || !row.parentNode) return false;
        var o = load();
        var box = D.createElement('div'); box.id = 'nova-gemsafe-box';
        var h = '<div class="w-full"><label class="block text-xs text-amber-400 font-bold flex items-center gap-1"><i class="ph-fill ph-shield-check"></i> Gemini 安全設定</label>' +
            '<p class="text-[10px] text-slate-500 mt-1">逐類別調整 Gemini 的內容封鎖閾值。選「預設」表示不送這個類別，沿用官方預設（Gemini 2.5 起為關閉）。官方建議除非應用程式有必要，否則不要調整；危害兒童安全等核心內容一律封鎖，無法調整。較寬鬆的設定請自行確保符合 Google 服務條款。</p>' +
            '<div style="display:flex;flex-direction:column;gap:8px;margin-top:8px;">';
        CATS.forEach(function (c, i) {
            h += '<div><div class="text-[11px] text-slate-200 font-bold">' + c[1] + ' <span class="text-[9px] text-slate-500 font-normal">' + c[2] + '</span></div>' +
                '<select data-cat="' + c[0] + '" id="nova-gemsafe-' + i + '" class="w-full mt-1 bg-slate-800 border border-slate-700 text-slate-200 text-[11px] rounded-md px-2 py-1">';
            LEVELS.forEach(function (l) { h += '<option value="' + l[0] + '"' + (o[c[0]] === l[0] ? ' selected' : '') + '>' + l[1] + '</option>'; });
            h += '</select></div>';
        });
        h += '</div><div class="flex gap-2 mt-2"><button id="nova-gemsafe-reset" class="px-2 py-1 text-[10px] bg-slate-700 hover:bg-slate-600 text-white rounded-md">↩︎ 全部恢復預設</button></div>' +
            '<p id="nova-gemsafe-stat" class="text-[10px] text-slate-400 mt-1"></p></div>';
        box.innerHTML = h;
        row.parentNode.insertBefore(box, row);
        function stat() {
            var n = build().length, el = D.getElementById('nova-gemsafe-stat');
            if (el) el.textContent = n ? ('目前有 ' + n + ' 個類別使用自訂閾值，下次請求起生效。') : '目前全部使用官方預設。';
        }
        Array.prototype.forEach.call(box.querySelectorAll('select[data-cat]'), function (sel) {
            sel.onchange = function () { var cur = load(); if (sel.value) cur[sel.getAttribute('data-cat')] = sel.value; else delete cur[sel.getAttribute('data-cat')]; save(cur); stat(); };
        });
        D.getElementById('nova-gemsafe-reset').onclick = function () {
            save({}); Array.prototype.forEach.call(box.querySelectorAll('select[data-cat]'), function (s) { s.value = ''; }); stat();
            if (typeof W.showToast === 'function') W.showToast('已恢復 Gemini 安全設定預設');
        };
        stat();
        return true;
    }
    function boot(n) {
        n = n || 0;
        if (!injectUi() && n < 60) setTimeout(function () { boot(n + 1); }, 700);
    }

    patchFetch();
    W.NovaGeminiSafety = { get: load, build: build, version: '1.0.0' };
    if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', function () { boot(0); }); else boot(0);
})();

/* ═════════════════════════════════════════════════════════════════
   nova-ghost.js — 白晝模式：按鈕不要框、不要灰底（跟 index.html 放同一個資料夾 www/）
   版本：v1.0.0
   版本紀錄：
   v1.0.0 - App v2.6.61。白晝模式下，介面按鈕（頂列圖示、⋮、清除對話、天氣膠囊、各頁灰色按鈕、排程列的圖示鈕…）全域覆寫後都變成淺灰底或帶邊框，
            改成：凡是「按鈕的底色是中性灰／白」或「有框的透明按鈕」，一律加上 .nv-ghost（nova-ui.css 第 20 節：透明底、無框、無陰影，只有按下時才有淡淡底色）。
            有彩度的主要按鈕（新增、送出、儲存、錄音中紅色、作用中的分頁…）不受影響，維持顏色。黑夜模式完全不動（樣式只在 html.theme-light 生效）。
            個別元素想保留底色可加 class="nv-keep"。
   ═════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';
    if (window.NovaGhost) return;
    function parse(c) { var m = /rgba?\(([^)]+)\)/.exec(c || ''); if (!m) return null; var p = m[1].split(',').map(function (x) { return parseFloat(x); }); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
    function neutralLight(c) { var o = parse(c); if (!o || o.a < 0.05) return false; var mx = Math.max(o.r, o.g, o.b), mn = Math.min(o.r, o.g, o.b); return mn >= 200 && (mx - mn) <= 18; }
    function hasBorder(cs) { return parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none' && parse(cs.borderTopColor) && parse(cs.borderTopColor).a > 0.05; }
    function run() {
        try {
            if (!document.documentElement.classList.contains('theme-light') || !document.body) return;
            var els = document.querySelectorAll('button, [role="button"], #nova-mobile-topbar > div > div');
            for (var i = 0; i < els.length; i++) {
                var el = els[i];
                if (el.classList.contains('nv-keep') || el.classList.contains('nv-ghost')) continue;
                if (el.closest('#smart-action-btn')) continue;
                var r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
                var cs = getComputedStyle(el), bg = cs.backgroundColor, hasBg = parse(bg) && parse(bg).a >= 0.05;
                if (hasBg ? neutralLight(bg) : hasBorder(cs)) el.classList.add('nv-ghost');
                else if (hasBg && hasBorder(cs) && neutralLight(bg)) el.classList.add('nv-ghost');
            }
        } catch (e) { /* 樣式優化失敗不影響功能 */ }
    }
    var t = null;
    function sched() { if (t) return; t = setTimeout(function () { t = null; run(); }, 450); }
    function start() {
        if (!document.body) return setTimeout(start, 200);
        new MutationObserver(sched).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
        sched();
    }
    window.NovaGhost = { run: run, version: '1.0.0' };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();

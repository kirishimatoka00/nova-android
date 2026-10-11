/* ═════════════════════════════════════════════
   nova-mainui.js — NOVA Android 主畫面（頂列＋抽屜選單）重新設計（跟 index.html 放同一個資料夾 www/）
   版本：v1.2.0
   版本紀錄：
   v1.2.0 - v2.6.39：抽屜拿掉「技能／電腦遙控／深度研究／Jev 與自主任務設定」四個項目與 Jev／技能數／遙控狀態；頂列 logo 與天氣之間顯示目前對話標題（#nova-top-title），按鈕間距壓縮。
   v1.1.1 - v2.6.37：抽屜項目「Pro 研究」改名「深度研究」。
   v1.1.0 - v2.6.35：輸入區「多專家」快捷鈕（#composer-experts-btn）開啟狀態跟 #experts-mode-toggle-btn 同步。
   v1.0.1 - v2.6.34：頂列拿掉「電腦遙控」鈕（對標桌面版手機殼只有 logo／天氣／設定／選單；遙控入口在抽屜與「+」選單）。
   v1.0.0 - 批次 9（App v2.6.33）。對標桌面版在手機寬度（遠端 /app 網頁殼）的主畫面：頂列＝logo／天氣／（新）電腦遙控／設定／選單；抽屜選單＝新增對話、
            最近的對話（含資料夾）、工具與紀錄、設定。手機版在這基礎上補：
            ① 頂列「🖥️ 電腦遙控」鈕（對應桌面版手機殼的 🖥️ 浮動鈕）② 自主任務執行中，頂列出現紅色「⏹ 中止」膠囊（對標桌面版的緊急中止鈕；呼叫 novaAutoTask.cancel）
            ③ 抽屜「工具與紀錄」新增：技能、電腦遙控、Pro 研究、設定捷徑（Agent／Jev）；項目加大成 48px 觸控高度
            ④ 抽屜頂部顯示自主任務／Jev／電腦遙控狀態列。純 DOM 補充，不改原本任何按鈕與函式；樣式在 nova-ui.css 第 11 節。
   依賴：index.html 的 #mobile-menu／頂列結構、novaAutoTask（isRunning／cancel）、openSkillManager、openRemoteDesktop、openSettings、switchSettingsCategory。
   ═════════════════════════════════════════════ */
(function (W) {
    'use strict';
    var D = document;
    function $(id) { return D.getElementById(id); }
    function mk(tag, cls, html) { var e = D.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
    function call(fn) { try { var f = W[fn]; if (typeof f === 'function') return f.apply(null, Array.prototype.slice.call(arguments, 1)); } catch (e) { /* 單一入口失敗不影響其他 */ } }
    function closeMenu() { var m = $('mobile-menu'); if (m) m.style.display = 'none'; }

    function itemBtn(icon, label, fn, id) {
        var b = mk('button', 'nv-drawer-item', '<i class="ph-fill ' + icon + '"></i><span>' + label + '</span><i class="ph-bold ph-caret-right nv-drawer-caret"></i>');
        b.type = 'button'; if (id) b.id = id; b.onclick = function () { closeMenu(); setTimeout(fn, 60); }; return b;
    }

    function buildTopbar() {
        var top = D.querySelector('main > .md\\:hidden.flex.items-center.justify-between'); if (!top || $('nova-task-stop')) return;
        top.id = top.id || 'nova-mobile-topbar';
        var right = top.querySelector('.ml-auto'); if (!right) return;
        var stop = mk('button', 'nv-stop-pill hidden', '<i class="ph-bold ph-stop-circle"></i><span>中止</span>'); stop.id = 'nova-task-stop'; stop.type = 'button'; stop.setAttribute('aria-label', '中止自主任務');
        stop.onclick = function () { try { if (W.novaAutoTask && W.novaAutoTask.cancel) W.novaAutoTask.cancel(); } catch (e) {} };
        var ttl = mk('span', 'nv-top-title', ''); ttl.id = 'nova-top-title'; top.insertBefore(ttl, right); top.insertBefore(stop, right);
        Array.prototype.forEach.call(right.querySelectorAll('button'), function (b) { b.classList.add('nv-top-btn'); });
    }

    function buildDrawer() {
        var menu = $('mobile-menu'); if (!menu || $('nv-drawer-extra')) return;
        var nav = menu.querySelector('nav.space-y-1'); if (!nav) return;
        // 抽屜頂部狀態列
        var st = mk('div', 'nv-drawer-status'); st.id = 'nv-drawer-status';
        var head = menu.firstElementChild; if (head && head.nextSibling) menu.insertBefore(st, head.nextSibling);
        // 工具項目統一加 class（原本的 dashboard／schedule／notes／audio）
        Array.prototype.forEach.call(nav.querySelectorAll(':scope > button'), function (b) { b.classList.add('nv-drawer-item'); });
    }

    function curTitle() {
        try {
            var A = W.appState; if (!A) return '';
            var sid = String(A.currentSessionId || '');
            if (A.chatTitles && A.chatTitles[sid]) return A.chatTitles[sid];
            var m = (A.messages || []).find(function (x) { return String(x.sessionId) === sid && x.sender === 'user' && x.text; });
            return m ? m.text.replace(/\s+/g, ' ').slice(0, 40) : '';
        } catch (e) { return ''; }
    }
    function lsGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
    function refresh() {
        try { var src = $('experts-mode-toggle-btn'), cb = $('composer-experts-btn'); if (src && cb) cb.classList.toggle('nova-exp-on', src.classList.contains('nova-exp-on')); } catch (e) {}
        var tt = $('nova-top-title'); if (tt) { var t = curTitle(); if (tt.textContent !== t) tt.textContent = t; }
        var running = false; try { running = !!(W.novaAutoTask && W.novaAutoTask.isRunning && W.novaAutoTask.isRunning()); } catch (e) {}
        var stop = $('nova-task-stop'); if (stop) stop.classList.toggle('hidden', !running);
        var st = $('nv-drawer-status');
        if (st) {
            var parts = [];
            if (running) parts.push('🤖 自主任務執行中');
            st.textContent = parts.join('　'); st.style.display = parts.length ? '' : 'none';
        }
    }

    function init() { buildTopbar(); buildDrawer(); refresh(); setInterval(refresh, 1200); var m = $('mobile-menu'); if (m && W.MutationObserver) new MutationObserver(refresh).observe(m, { attributes: true, attributeFilter: ['style'] }); }
    W.NovaMainUI = { refresh: refresh, init: init, VERSION: '1.0.0' };
    if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', init); else setTimeout(init, 300);
})(window);

/* ═══════════════════════════════════════════════════════════════════════
   nova-settings-ui.js — NOVA Android 設定頁重新分類（跟 index.html 放同一個資料夾 www/）
   版本：v1.2.0
   版本紀錄：
   v1.2.0 - 批次 7b（v2.6.31）。「Agent 與自主任務」分類新增「⚡ Jev 快速判斷」區塊（tab-jev，內容由 nova-jev-ui.js 繪製）。
   v1.1.0 - 批次 7a（v2.6.30）。「Agent 與自主任務」分類新增「技能」區塊（tab-skills，內容由 nova-skill-ui.js 繪製）。
   v1.0.0 - 初版（v2.6.28）。對標桌面版 v3.51.0「設定頁分 6～7 大類」的手機版：頂端搜尋框＋橫向膠囊分類列（一般與外觀／模型與金鑰／Agent 與自主任務／記憶／整合／語音與錄音），
            每個分類下是帶標題與說明的卡片區塊（.ns-sec）。做法：執行時把原本的 tab-* 區塊「整塊搬進」對應卡片（元素 id、事件完全不變），tab-main 依內容拆成
            「Google 與代理」「API 金鑰與 Local API」「資料與備份」三塊。舊的 switchSettingsTab(tab-xxx) 仍可用（會切到所屬分類並捲到該區塊），所以其他程式不用改。
            舊的 10 顆分頁按鈕保留在 DOM（隱藏），讓原本函式不會找不到元素。桌面版有「技能」分類，手機版沒有對應功能所以不放。
   樣式在 nova-ui.css 第 10 節（.ns-*）。
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';
    var W = window, $ = function (id) { return document.getElementById(id); };
    var CATS = [
        { id: 'general', icon: 'ph-sliders-horizontal', name: '一般與外觀', desc: '介面主題、資料備份與儲存位置。', secs: [['ui', '外觀與主題', '選擇黑夜或白晝模式。'], ['data', '資料與備份', '記憶、儲存位置與完整備份。']] },
        { id: 'models', icon: 'ph-lock-key', name: '模型與金鑰', desc: 'API 金鑰、本機模型，以及主畫面可選的模型。', secs: [['keys', 'API 金鑰與 Local API', '各家 AI 與搜尋服務的金鑰，只存在這支手機。'], ['models', '啟用的模型', '取消勾選的模型不會出現在主畫面選單。']] },
        { id: 'agent', icon: 'ph-robot', name: 'Agent 與自主任務', desc: 'AI 操作手機的執行器、判斷器與限制。', secs: [['autotask', 'AI 自主任務', '執行器、判斷器、回合數與逾時。'], ['skills', '技能', '自主任務存成技能、重播與管理。'], ['jev', '⚡ Jev 快速判斷', 'TypeSafe 小決策模型：完成複查、技能比對、參數建議。']] },
        { id: 'memory', icon: 'ph-brain', name: '記憶', desc: '跨對話的長期記憶與 Profile。', secs: [['memory', 'AI 記憶', '中期摘要、長期事實與維護守則。']] },
        { id: 'integrations', icon: 'ph-plug', name: '整合', desc: 'Google、Telegram、行事曆與工具。', secs: [['google', 'Google 與代理', '系統代理、雲端備份與 Canvas CORS 代理。'], ['tg', 'Telegram', '接收排程推播與提醒。'], ['cal', '行事曆', '行事曆提醒與同步。'], ['tools', '工具與 MCP', 'Function Calling、遠端 MCP、Context Caching。']] },
        { id: 'voice', icon: 'ph-microphone', name: '語音與錄音', desc: '朗讀、語音辨識與錄音。', secs: [['voice', '語音與朗讀', '人聲、AWS Polly 與語音設定。'], ['rec', '錄音', '錄音與口譯設定。']] }
    ];
    var secOf = {};   // tab-xxx → cat id
    var current = 'general', built = false;

    function build() {
        var modal = $('settings-modal'); if (!modal || built) return; built = true;
        var card = modal.firstElementChild, scroller = card.querySelector('.overflow-y-auto.flex-1');
        var pillBar = card.querySelector('.mb-4.shrink-0.overflow-x-auto'); if (pillBar) pillBar.style.display = 'none';
        var tabs = {}; ['main', 'voice', 'tg', 'ui', 'rec', 'cal', 'models', 'memory', 'tools', 'autotask', 'skills', 'jev'].forEach(function (k) { tabs[k] = $('tab-' + k); });
        // 拆 tab-main
        var main = tabs.main, parts = { google: null, keys: null, data: null };
        if (main) {
            Array.prototype.slice.call(main.children).forEach(function (el) {
                if (el.querySelector('#key-doc-url')) parts.google = el; else if (el.querySelector('#key-gemini')) parts.keys = el; else if (!parts.data) parts.data = el; else parts.data.appendChild(el);
            });
        }
        var content = { ui: tabs.ui, models: tabs.models, autotask: tabs.autotask, skills: tabs.skills, jev: tabs.jev, memory: tabs.memory, tg: tabs.tg, cal: tabs.cal, tools: tabs.tools, voice: tabs.voice, rec: tabs.rec, google: parts.google, keys: parts.keys, data: parts.data };
        var wrap = document.createElement('div'); wrap.className = 'ns-nav-wrap';
        var sb = document.createElement('div'); sb.className = 'ns-search';
        sb.innerHTML = '<i class="ph-bold ph-magnifying-glass"></i><input id="ns-search-input" type="text" autocomplete="off" placeholder="搜尋設定…">';
        var nav = document.createElement('div'); nav.className = 'ns-nav'; nav.id = 'settings-nav-list';
        wrap.append(sb, nav);
        var holder = document.createElement('div'); holder.id = 'ns-cats';
        var empty = document.createElement('div'); empty.id = 'ns-search-empty'; empty.className = 'hidden ns-empty'; empty.textContent = '找不到符合的設定項目'; holder.appendChild(empty);
        CATS.forEach(function (c) {
            var b = document.createElement('button'); b.type = 'button'; b.id = 'scat-btn-' + c.id; b.className = 'ns-nav-item' + (c.id === current ? ' active' : '');
            b.innerHTML = '<i class="ph-bold ' + c.icon + '"></i><span>' + c.name + '</span>'; b.onclick = function () { W.switchSettingsCategory(c.id); }; nav.appendChild(b);
            var cat = document.createElement('div'); cat.id = 'scat-' + c.id; cat.className = 'ns-cat' + (c.id === current ? '' : ' hidden'); cat.setAttribute('data-cat', c.id);
            var head = document.createElement('div'); head.className = 'ns-cat-head'; head.innerHTML = '<h2>' + c.name + '</h2><p>' + c.desc + '</p>'; cat.appendChild(head);
            c.secs.forEach(function (s) {
                var el = content[s[0]]; if (!el) return;
                var sec = document.createElement('section'); sec.className = 'ns-sec'; sec.setAttribute('data-ns-id', s[0]);
                var h = document.createElement('div'); h.className = 'ns-sec-head'; h.innerHTML = '<h3>' + s[1] + '</h3><p>' + s[2] + '</p>';
                var body = document.createElement('div'); body.className = 'ns-sec-body'; body.appendChild(el); el.classList.remove('hidden');
                sec.append(h, body); cat.appendChild(sec); secOf['tab-' + s[0]] = c.id;
            });
            holder.appendChild(cat);
        });
        secOf['tab-main'] = 'models';
        card.insertBefore(wrap, scroller); scroller.textContent = ''; scroller.appendChild(holder);
        $('ns-search-input').addEventListener('input', function () { search(this.value); });
    }

    var orig = W.switchSettingsTab;
    function runHooks(cat) {   // 原本 switchSettingsTab 在切到各分頁時會做的同步（重畫清單、填值…）
        if (typeof orig !== 'function') return;
        var tabs = []; CATS.forEach(function (c) { if (c.id === cat) c.secs.forEach(function (s) { tabs.push('tab-' + s[0]); }); });
        tabs.forEach(function (t) { if ($(t)) { try { orig(t); } catch (e) { /* 單一分頁同步失敗不影響其他 */ } } });
        if (cat === 'agent' && typeof W.novaSkillRenderSettings === 'function') { try { W.novaSkillRenderSettings(); if (W.novaJevRenderSettings) W.novaJevRenderSettings(); } catch (e) { /* 技能區塊繪製失敗不影響其他 */ } }
        Array.prototype.forEach.call(document.querySelectorAll('#ns-cats [id^="tab-"]'), function (el) { el.classList.remove('hidden'); });
    }
    W.switchSettingsCategory = function (id) {
        build(); current = id;
        CATS.forEach(function (c) { var el = $('scat-' + c.id), b = $('scat-btn-' + c.id); if (el) el.classList.toggle('hidden', c.id !== id); if (b) b.classList.toggle('active', c.id === id); });
        var si = $('ns-search-input'); if (si && si.value) { si.value = ''; search(''); }
        runHooks(id);
        var sc = $('ns-cats') && $('ns-cats').parentNode; if (sc) sc.scrollTop = 0;
        var b = $('scat-btn-' + id); if (b && b.scrollIntoView) { try { b.scrollIntoView({ inline: 'center', block: 'nearest' }); } catch (e) { /* ignore */ } }
    };
    W.switchSettingsTab = function (tabId) {   // 舊介面：切到分頁＝切到所屬分類並捲到該區塊
        build(); var cat = secOf[tabId] || 'general';
        W.switchSettingsCategory(cat);
        var el = $(tabId); if (el && el.closest) { var sec = el.closest('.ns-sec'); if (sec && sec.scrollIntoView) { sec.scrollIntoView({ block: 'start' }); sec.classList.add('ns-flash'); setTimeout(function () { sec.classList.remove('ns-flash'); }, 1200); } }
    };
    function search(q) {
        q = String(q || '').trim().toLowerCase(); var any = false, root = $('ns-cats'); if (!root) return;
        root.classList.toggle('ns-searching', !!q);
        CATS.forEach(function (c) {
            var cat = $('scat-' + c.id), hit = false;
            Array.prototype.forEach.call(cat.querySelectorAll('.ns-sec'), function (sec) {
                var txt = (sec.textContent + ' ' + Array.prototype.map.call(sec.querySelectorAll('input,textarea'), function (i) { return (i.placeholder || '') + ' ' + (i.type === 'password' ? '' : i.value || ''); }).join(' ')).toLowerCase();
                var m = !q || txt.indexOf(q) !== -1; sec.classList.toggle('ns-hit-hide', !m); if (m) hit = true;
            });
            cat.classList.toggle('hidden', q ? !hit : c.id !== current); if (hit && q) any = true;
        });
        var e = $('ns-search-empty'); if (e) e.classList.toggle('hidden', !q || any);
    }
    var origOpen = W.openSettings;
    W.openSettings = function () { var r = origOpen && origOpen.apply(this, arguments); try { build(); W.switchSettingsCategory(current); } catch (e) { /* ignore */ } return r; };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();

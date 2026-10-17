/* ═════════════════════════════════════════════════════════════════
   nova-private.js — NOVA Android「私密對話」（側邊欄新增對話旁的幽靈圖示；跟 index.html 放同一個資料夾 www/）
   版本：v1.0.0
   版本紀錄：
   v1.0.0 - App v2.6.62。
            ① createPrivateChat()：開一個新對話並標記為私密（nova-memory.js 的 NovaPrivate，localStorage nova_private_sessions）。
            ② 私密對話的記憶完全獨立：回覆後的摘要、長期事實固化、回答前帶入的記憶，全部走另一個資料庫（NovaMemoryPrivate／IndexedDB nova_memory_private_db），
               不讀主記憶、不寫主記憶；主記憶與一般對話也看不到私密記憶。私密對話不使用知識庫（不比對、不匯入、AI 的 kb_search 工具也回空）。
            ③ 私密記憶不上雲端同步（Drive 記憶同步只處理主記憶）；完整備份另存 privateMemoryData／privateSessions，還原時只回私密庫，不併入主記憶。
            ④ 介面：側邊欄對話項目用幽靈圖示標示；私密對話中，聊天區上方顯示「私密對話」小標籤；設定 → 記憶 分頁下方有「私密記憶」專區（開關、Profile、清單、清空）。
            ⑤ 誠實聲明：對話訊息本身（聊天紀錄）仍和一般對話一樣存在手機本機，也會跟著一般的對話備份／雲端同步；「獨立」指的是記憶與知識庫。
               對話內容仍會送給你選的 AI 模型（Gemini／Grok…）處理；摘要與固化會呼叫 Gemini 輕量模型。
   依賴：nova-memory.js v1.2.0（NovaPrivate、NovaMemoryPrivate）、createNewChat。
   ═════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';
    var W = window;
    // 目前對話該用哪個記憶庫（私密對話→私密記憶；一般→主記憶；沒載入→null）
    W._novaMemStore = function () {
        try { return (W.NovaPrivate && W.NovaPrivate.isCurrent()) ? (W.NovaMemoryPrivate || null) : (W.NovaMemory || null); } catch (e) { return W.NovaMemory || null; }
    };
    W.createPrivateChat = function () {
        try {
            if (typeof W.createNewChat !== 'function') return;
            W.createNewChat();
            var sid = W.appState && W.appState.currentSessionId;
            if (sid && W.NovaPrivate) W.NovaPrivate.mark(sid);
            if (typeof W.renderChatHistoryList === 'function') W.renderChatHistoryList();
            try { if (typeof W.showToast === 'function') W.showToast('🕶️ 已開啟私密對話：記憶與知識庫獨立'); } catch (e) { /* */ }
            refresh();
        } catch (e) { console.warn('[NovaPrivate] 建立失敗', e); }
    };
    var css = document.createElement('style');
    css.textContent = '#nova-private-badge{position:fixed;left:50%;top:calc(env(safe-area-inset-top,0px) + 58px);transform:translateX(-50%);z-index:40;display:none;align-items:center;gap:6px;padding:5px 12px;border-radius:999px;font-size:12px;font-weight:700;background:rgba(99,102,241,.16);color:#6366f1;pointer-events:none;white-space:nowrap}'
        + 'html:root body #nova-private-new{background:transparent !important;border-color:transparent !important;box-shadow:none !important}';
    document.head.appendChild(css);
    function badge() {
        var b = document.getElementById('nova-private-badge');
        if (!b && document.body) { b = document.createElement('div'); b.id = 'nova-private-badge'; b.innerHTML = '<i class="ph-bold ph-ghost"></i><span>私密對話・記憶獨立</span>'; document.body.appendChild(b); }
        return b;
    }
    function refresh() {
        try {
            var b = badge(); if (!b) return;
            var on = !!(W.NovaPrivate && W.NovaPrivate.isCurrent());
            var dash = document.getElementById('view-dashboard');
            var onChat = !dash || (!dash.classList.contains('hidden') && dash.offsetParent !== null);
            b.style.display = (on && onChat) ? 'flex' : 'none';
        } catch (e) { /* */ }
    }
    setInterval(refresh, 600);
    W.NovaPrivateUI = { refresh: refresh, version: '1.0.0' };
})();

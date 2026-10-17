/* ═════════════════════════════════════════════════════════════════
   nova-private.js — NOVA Android「私密對話」（側邊欄新增對話旁的幽靈圖示；跟 index.html 放同一個資料夾 www/）
   版本：v1.1.0
   版本紀錄：
   v1.1.0 - App v2.6.63：私密記憶／私密對話加密碼鎖（NovaPrivateLock）。密碼以 PBKDF2-SHA256（隨機 salt、120000 次）雜湊後存本機 localStorage nova_private_pw，不存明文、不隨備份／同步出去。
            尚未設密碼時，進入私密對話或私密記憶會先要求設定；解鎖狀態只存在記憶體，App 重開或按「上鎖」即失效。誠實聲明：這是「進入」的介面鎖，
            IndexedDB 與聊天紀錄本身沒有另外加密；忘記密碼只能在「變更密碼」輸入舊密碼，或清除 App 資料（私密記憶也會一併消失）。
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
            if (W.NovaPrivateLock && !W.NovaPrivateLock.unlocked()) { W.NovaPrivateLock.ask().then(function (ok) { if (ok) W.createPrivateChat(); }); return; }
            if (typeof W.createNewChat !== 'function') return;
            W.createNewChat();
            var sid = W.appState && W.appState.currentSessionId;
            if (sid && W.NovaPrivate) W.NovaPrivate.mark(sid);
            if (typeof W.renderChatHistoryList === 'function') W.renderChatHistoryList();
            try { if (typeof W.showToast === 'function') W.showToast('🕶️ 已開啟私密對話：記憶與知識庫獨立'); } catch (e) { /* */ }
            refresh();
        } catch (e) { console.warn('[NovaPrivate] 建立失敗', e); }
    };

    // ───────── 密碼鎖（v1.1.0）─────────
    var PWK = 'nova_private_pw', _unlocked = false;
    function rec() { try { return JSON.parse(localStorage.getItem(PWK) || 'null'); } catch (e) { return null; } }
    function b64(u8) { var s = ''; for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); }
    function unb64(t) { var s = atob(t), u = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
    async function derive(pw, salt) {
        var key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
        return b64(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: 120000, hash: 'SHA-256' }, key, 256)));
    }
    var Lock = {
        hasPw: function () { return !!rec(); },
        unlocked: function () { return _unlocked; },
        lock: function () { _unlocked = false; },
        verify: async function (pw) { var r = rec(); if (!r) return false; return (await derive(pw, unb64(r.salt))) === r.hash; },
        setPassword: async function (pw) {
            var salt = crypto.getRandomValues(new Uint8Array(16));
            localStorage.setItem(PWK, JSON.stringify({ salt: b64(salt), hash: await derive(pw, salt) }));
            _unlocked = true;
        },
        unlock: async function (pw) { if (await Lock.verify(pw)) { _unlocked = true; return true; } return false; },
        // 彈出視窗：已有密碼→輸入解鎖；尚無→設定新密碼。回傳 Promise<boolean>
        ask: function () {
            if (_unlocked) return Promise.resolve(true);
            return new Promise(function (resolve) {
                var has = Lock.hasPw();
                var o = document.createElement('div');
                o.style.cssText = 'position:fixed;inset:0;z-index:100002;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:20px';
                o.innerHTML = '<div style="width:100%;max-width:340px;background:var(--nv-card,#0f172a);color:var(--nv-text,#e2e8f0);border:1px solid var(--nv-line,#334155);border-radius:16px;padding:16px">'
                    + '<div style="font-weight:700;margin-bottom:4px">🕶️ ' + (has ? '輸入私密密碼' : '設定私密密碼') + '</div>'
                    + '<div style="font-size:12px;color:var(--nv-muted,#94a3b8);margin-bottom:10px">' + (has ? '解鎖後才能進入私密對話與私密記憶。' : '首次使用請先設定密碼（至少 4 個字元）。') + '</div>'
                    + '<input id="npl-a" type="password" autocomplete="off" placeholder="密碼" style="width:100%;box-sizing:border-box;padding:9px;border-radius:10px;border:1px solid var(--nv-line-strong,#334155);background:var(--nv-canvas,#020617);color:inherit;font-size:14px">'
                    + (has ? '' : '<input id="npl-b" type="password" autocomplete="off" placeholder="再輸入一次" style="width:100%;box-sizing:border-box;padding:9px;border-radius:10px;border:1px solid var(--nv-line-strong,#334155);background:var(--nv-canvas,#020617);color:inherit;font-size:14px;margin-top:8px">')
                    + '<div id="npl-err" style="color:#ef4444;font-size:12px;min-height:16px;margin-top:6px"></div>'
                    + '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:6px"><button id="npl-no" style="padding:8px 14px;border-radius:10px;border:0;background:transparent;color:var(--nv-muted,#94a3b8);font-weight:700">取消</button><button id="npl-ok" style="padding:8px 16px;border-radius:10px;border:0;background:var(--nv-accent,#0284c7);color:#fff;font-weight:700">' + (has ? '解鎖' : '設定') + '</button></div></div>';
                document.body.appendChild(o);
                var q = function (id) { return o.querySelector('#' + id); };
                var done = function (v) { o.remove(); resolve(v); };
                q('npl-no').onclick = function () { done(false); };
                q('npl-ok').onclick = async function () {
                    var a = q('npl-a').value;
                    try {
                        if (has) { if (await Lock.unlock(a)) return done(true); q('npl-err').textContent = '密碼錯誤'; return; }
                        if (a.length < 4) { q('npl-err').textContent = '密碼至少 4 個字元'; return; }
                        if (a !== q('npl-b').value) { q('npl-err').textContent = '兩次輸入不一致'; return; }
                        await Lock.setPassword(a); done(true);
                    } catch (e) { q('npl-err').textContent = '失敗：' + (e && e.message || e); }
                };
                setTimeout(function () { try { q('npl-a').focus(); } catch (e) {} }, 50);
            });
        }
    };
    W.NovaPrivateLock = Lock;
    // 進入私密對話前的檢查（供 loadChatSession 使用）：回傳 Promise<boolean>
    W.novaPrivateGate = function (sid) {
        try { if (!(W.NovaPrivate && W.NovaPrivate.isPrivate(sid))) return Promise.resolve(true); } catch (e) { return Promise.resolve(true); }
        return Lock.ask();
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
    W.NovaPrivateUI = { refresh: refresh, version: '1.1.0' };
})();

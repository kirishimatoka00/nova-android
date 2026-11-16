/* ════════════════════════════════════════════════════════════
   nova-wake.js — NOVA Android「常駐背景＋語音喚醒（嘿 小希）」的設定介面與喚醒後的動作
   版本：v1.0.1（2026-11-16，App v2.6.146）
   原生端：android/…/NovaWake.java、NovaWakeService.java、NovaWakePlugin.java（Capacitor 外掛名稱 NovaWake）。
   需要含這些原生檔的新版 APK；舊 APK 或瀏覽器裡這張卡片只會顯示「需要新版 App」。

   版本紀錄（只記這個檔案自己的變更）：
   v1.0.1 - App v2.6.146：靈敏度說明改成新的判斷方式（原生 NovaWakeService v1.0.1 修「嘿 小希認不出來」）；程式邏輯沒改。
   v1.0.0 - App v2.6.145 新增（使用者要求：①NOVA 不容易被關掉，要從通知列另外按關閉才會關、不會因「全部關閉」被關；
            ②沒關閉時對手機喊就打開 NOVA 並自動開新對話）。
     ・設定 → 語音 最上方加一張卡片：常駐背景 開關、語音喚醒 開關、靈敏度（低／中／高）、語音模型下載（Vosk 中文小模型，約 42MB，
       只下載一次、存在 App 內）、目前狀態與「最後聽到」、權限檢查（麥克風／通知／顯示在其他應用程式上層／電池不受限制）各附一鍵前往、
       「5 秒後測試喚醒」。開語音喚醒會一併開常駐背景；關常駐背景會一併關語音喚醒。
     ・設定存 localStorage：nova_wake_keep、nova_wake_on、nova_wake_sens（nova_ 開頭，已包含在完整備份／本地快照／還原裡）；
       每次開 App 會把設定套用到原生端（還原備份後重開 App 即生效；語音模型不在備份內，換手機要重新下載）。
     ・喚醒後的動作：原生端打開畫面時留下記號，這裡在 App 啟動、回到前景、收到「wake」事件時用 NovaWake.pull() 取走，
       取到就關掉設定視窗 → createNewChat() 開新對話 → 約 0.9 秒後（等背景服務放掉麥克風）toggleContinuous() 開始連續語音輸入
       （已在連續語音或自動口譯模式時不重複開）。通知列的「開新對話」按鈕走同一條路。
   ════════════════════════════════════════════════════════════ */
(function () {
    'use strict';
    var VERSION = '1.0.1';
    var LS_KEEP = 'nova_wake_keep', LS_ON = 'nova_wake_on', LS_SENS = 'nova_wake_sens';

    function plugin() {
        try {
            var C = window.Capacitor;
            if (!C || !C.Plugins) return null;
            if (C.isPluginAvailable && !C.isPluginAvailable('NovaWake')) return null;
            return C.Plugins.NovaWake || null;
        } catch (e) { return null; }
    }
    function cfg() {
        var s = parseInt(localStorage.getItem(LS_SENS), 10);
        return {
            keepAlive: localStorage.getItem(LS_KEEP) === '1',
            wakeOn: localStorage.getItem(LS_ON) === '1',
            sens: (s === 0 || s === 1 || s === 2) ? s : 1
        };
    }
    function save(c) {
        localStorage.setItem(LS_KEEP, c.keepAlive ? '1' : '0');
        localStorage.setItem(LS_ON, c.wakeOn ? '1' : '0');
        localStorage.setItem(LS_SENS, String(c.sens));
    }
    function toast(m, ms) { try { if (typeof showToast === 'function') showToast(m, ms || 2600); } catch (e) { /* */ } }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }

    var st = null;          // 最近一次原生狀態
    var dl = null;          // 下載進度 {phase, pct}
    var timer = null;

    async function apply() {
        var P = plugin();
        if (!P) return null;
        try { st = await P.configure(cfg()); } catch (e) { console.warn('[NovaWake] configure 失敗', e); }
        return st;
    }
    async function refresh() {
        var P = plugin();
        if (!P) { render(); return; }
        try { st = await P.status(); } catch (e) { /* */ }
        render();
    }

    // ───────── 喚醒後：開新對話＋開始聽 ─────────
    var waking = false;
    async function checkWake() {
        var P = plugin();
        if (!P || waking) return;
        var r = null;
        try { r = await P.pull(); } catch (e) { return; }
        if (!r || !r.wake) return;
        waking = true;
        var tries = 0;
        (function go() {
            if (typeof window.createNewChat !== 'function' || !window.appState) {
                if (++tries < 40) { setTimeout(go, 250); return; }   // 冷啟動：等主程式準備好（最多 10 秒）
                waking = false; return;
            }
            try {
                var m = document.getElementById('settings-modal');
                if (m && !m.classList.contains('hidden')) m.classList.add('hidden');
                if (window.NovaTravel && typeof window.NovaTravel.close === 'function') window.NovaTravel.close();
            } catch (e) { /* */ }
            try { window.createNewChat(); } catch (e) { console.warn('[NovaWake] 開新對話失敗', e); }
            toast('👋 我在，請說', 2000);
            setTimeout(function () {
                waking = false;
                try {
                    var a = window.appState;
                    if (document.visibilityState !== 'visible') return;
                    if (a.isContinuous || a.translateMode === 'auto') return;
                    if (typeof toggleContinuous === 'function') toggleContinuous();
                } catch (e) { console.warn('[NovaWake] 開始語音輸入失敗', e); }
            }, 900);
        })();
    }

    // ───────── 設定卡片 ─────────
    var STATE_TXT = {
        'off': '未執行', 'keep': '常駐中', 'listening': '正在聆聽「嘿 小希」', 'app': 'NOVA 開著，聆聽暫停（回到背景後恢復）',
        'unlock': '等待解鎖', 'user-paused': '已從通知列暫停聆聽', 'no-model': '尚未下載語音模型', 'no-perm': '沒有麥克風權限',
        'mic-bg': '需要打開 NOVA 一次才能在背景聆聽', 'mic-busy': '麥克風被其他程式使用中', 'loading': '載入語音模型中…', 'error': '發生錯誤'
    };

    function row(ok, label, btnTxt, act, note) {
        return '<div class="flex items-center gap-2 text-[11px]">' +
            '<span class="' + (ok ? 'text-emerald-400' : 'text-amber-400') + '">' + (ok ? '✓' : '⚠') + '</span>' +
            '<span class="flex-1 text-slate-300">' + label + (note ? '<span class="text-slate-500">　' + note + '</span>' : '') + '</span>' +
            (ok || !btnTxt ? '' : '<button type="button" data-nw="' + act + '" class="px-2 py-1 rounded-md bg-slate-800 border border-slate-600 text-slate-200">' + btnTxt + '</button>') +
            '</div>';
    }
    function sw(id, on, dis) {
        return '<button type="button" data-nw="' + id + '" ' + (dis ? 'disabled ' : '') + 'role="switch" aria-checked="' + (on ? 'true' : 'false') + '" ' +
            'style="width:44px;height:24px;border-radius:9999px;position:relative;flex:none;border:0;transition:background .15s;background:' + (on ? '#10b981' : '#475569') + ';' + (dis ? 'opacity:.45;' : '') + '">' +
            '<span style="position:absolute;top:2px;left:' + (on ? '22px' : '2px') + ';width:20px;height:20px;border-radius:9999px;background:#fff;transition:left .15s"></span></button>';
    }

    function render() {
        var box = document.getElementById('nova-wake-card');
        if (!box) return;
        var P = plugin(), c = cfg();
        var h = '<div class="flex items-center gap-2"><span class="text-xs font-bold text-emerald-400">🛡 常駐背景與語音喚醒</span></div>';
        if (!P) {
            h += '<div class="text-[11px] text-slate-400 leading-relaxed">這項功能需要新版 NOVA App（v2.6.145 以上的 APK）。請安裝新版後再回到這裡設定。</div>';
            box.innerHTML = h; return;
        }
        var s = st || {};
        h += '<div class="flex items-center gap-3"><div class="flex-1"><div class="text-xs text-slate-200 font-bold">常駐背景</div>' +
            '<div class="text-[11px] text-slate-400 leading-relaxed">開啟後通知列會固定顯示「NOVA 執行中」。從最近使用清單滑掉或按「全部關閉」只會收起畫面，要按通知上的「關閉 NOVA」才會真的關閉。</div></div>' + sw('keep', c.keepAlive) + '</div>';
        h += '<div class="flex items-center gap-3"><div class="flex-1"><div class="text-xs text-slate-200 font-bold">語音喚醒「嘿 小希」</div>' +
            '<div class="text-[11px] text-slate-400 leading-relaxed">NOVA 在背景時對手機說「嘿 小希」，就會打開 NOVA、開一個新對話並開始聽你說話。辨識在手機上離線進行，聲音不會上傳。螢幕鎖定時會先亮螢幕，解鎖後才打開。</div></div>' + sw('wake', c.wakeOn) + '</div>';

        if (c.wakeOn || c.keepAlive) {
            var stTxt = STATE_TXT[s.state] || s.state || '';
            if (s.state === 'error' && s.stateMsg) stTxt += '：' + s.stateMsg;
            h += '<div class="text-[11px] text-slate-300">狀態：<span class="text-emerald-300">' + esc(s.running ? stTxt : '未執行') + '</span>' +
                (c.wakeOn && s.lastHeard ? '<span class="text-slate-500">　最後聽到：' + esc(s.lastHeard) + '</span>' : '') + '</div>';
        }

        if (c.wakeOn) {
            h += '<div class="flex items-center gap-2 text-[11px]"><span class="text-slate-300">靈敏度</span>';
            ['低', '中', '高'].forEach(function (t, i) {
                h += '<button type="button" data-nw="sens' + i + '" class="px-3 py-1 rounded-md border ' + (c.sens === i ? 'bg-emerald-600 border-emerald-500 text-white' : 'bg-slate-800 border-slate-600 text-slate-300') + '">' + t + '</button>';
            });
            h += '</div><div class="text-[11px] text-slate-500 leading-relaxed">低：安靜時單獨說「嘿 小希」才觸發。中：說完「嘿 小希」就觸發，前面有雜音也可以。高：前後有雜音都可以，單獨說「小希」也會觸發，較容易誤觸。請在說完後停一下。</div>';

            // 語音模型
            if (s.downloading || (dl && (dl.phase === 'download' || dl.phase === 'unzip'))) {
                var ph = (dl && dl.phase) || s.dlPhase || 'download', pc = (dl && dl.pct) || s.dlPct || 0;
                h += '<div class="text-[11px] text-slate-300">' + (ph === 'unzip' ? '解壓縮語音模型…' : '下載語音模型… ' + pc + '%') + '</div>' +
                    '<div style="height:6px;border-radius:9999px;background:#334155;overflow:hidden"><div style="height:100%;width:' + Math.max(3, Math.min(100, pc)) + '%;background:#10b981"></div></div>';
            } else if (s.model) {
                h += row(true, '語音模型已下載', null, null, '') +
                    '<div class="text-right"><button type="button" data-nw="delmodel" class="text-[11px] text-slate-500 underline">刪除語音模型</button></div>';
            } else {
                h += row(false, '尚未下載語音模型（約 42MB，只需下載一次）', '下載', 'dlmodel');
            }
            h += row(!!s.mic, '麥克風權限', '允許', 'mic');
        }
        if (c.wakeOn || c.keepAlive) {
            h += row(!!s.notify, '通知權限', '允許', 'notify', s.notify ? '' : '沒開就看不到常駐通知與「關閉 NOVA」按鈕');
            if (c.wakeOn) h += row(!!s.canLaunch, '喚醒後直接跳出畫面', '去開啟', 'overlay', s.canLaunch ? '' : '需要「顯示在其他應用程式上層」；沒開時改為跳通知讓你點');
            h += row(!!s.battery, '電池用量不受限制', '去設定', 'battery', s.battery ? '' : '沒設定的話，系統可能在幾小時後把 NOVA 停掉');
            if (/samsung/i.test(s.maker || '')) h += '<div class="text-[11px] text-slate-500 leading-relaxed">Samsung 手機建議再做一件事：在最近使用清單點 NOVA 的圖示 →「保持開啟」，並到 設定 → 電池 → 背景使用限制，確認 NOVA 不在「休眠」或「深度休眠」的應用程式清單裡。</div>';
        }
        if (c.wakeOn) {
            h += '<div class="flex items-center gap-2"><button type="button" data-nw="test" class="px-3 py-1.5 rounded-md bg-slate-800 border border-slate-600 text-[11px] text-slate-200">5 秒後測試喚醒</button>' +
                '<span class="text-[11px] text-slate-500">按下後把 NOVA 放到背景（或鎖定螢幕），看會不會自動打開</span></div>';
            h += '<div class="text-[11px] text-slate-500 leading-relaxed">說明：NOVA 畫面開著、錄音中、或自己用麥克風時，背景聆聽會自動暫停。持續聆聽會多耗一些電；通知上可隨時「暫停聆聽」。Android 會在狀態列顯示麥克風使用中的綠點，這是正常的。</div>';
        }
        box.innerHTML = h;
    }

    async function onClick(ev) {
        var b = ev.target && ev.target.closest ? ev.target.closest('[data-nw]') : null;
        if (!b) return;
        var act = b.getAttribute('data-nw'), P = plugin(), c = cfg();
        if (!P) return;
        try {
            if (act === 'keep') {
                c.keepAlive = !c.keepAlive;
                if (!c.keepAlive) c.wakeOn = false;
                save(c); await apply();
                if (c.keepAlive && st && !st.notify) { try { await P.requestNotify(); } catch (e) { /* */ } }
                toast(c.keepAlive ? '已開啟常駐背景' : '已關閉常駐背景與語音喚醒');
            } else if (act === 'wake') {
                c.wakeOn = !c.wakeOn;
                if (c.wakeOn) c.keepAlive = true;
                save(c); await apply();
                if (c.wakeOn && st) {
                    if (!st.notify) { try { await P.requestNotify(); } catch (e) { /* */ } }
                    else if (!st.mic) { try { await P.requestMic(); } catch (e) { /* */ } }
                    if (!st.model && !st.downloading) toast('還需要下載語音模型（約 42MB），請按下方「下載」', 3500);
                    else toast('已開啟語音喚醒：把 NOVA 放到背景後說「嘿 小希」', 3500);
                } else if (!c.wakeOn) toast('已關閉語音喚醒');
            } else if (act.indexOf('sens') === 0) {
                c.sens = parseInt(act.slice(4), 10) || 0;
                save(c); await apply();
            } else if (act === 'dlmodel') {
                dl = { phase: 'download', pct: 0 }; render();
                try { st = await P.downloadModel(); dl = null; toast('語音模型下載完成'); await apply(); }
                catch (e) { dl = null; toast('語音模型下載失敗：' + ((e && e.message) || e), 5000); }
            } else if (act === 'delmodel') {
                if (!window.confirm('刪除語音模型？刪除後語音喚醒會停用，要再用需重新下載。')) return;
                st = await P.deleteModel();
            } else if (act === 'mic') { await P.requestMic(); }
            else if (act === 'notify') { await P.requestNotify(); }
            else if (act === 'overlay') { await P.openOverlaySettings(); }
            else if (act === 'battery') { await P.requestIgnoreBattery(); }
            else if (act === 'test') { await P.test(); toast('5 秒後模擬喚醒，現在把 NOVA 放到背景', 4000); }
        } catch (e) { toast('操作失敗：' + ((e && e.message) || e), 4000); }
        refresh();
    }

    function mount() {
        var tab = document.getElementById('tab-voice');
        if (!tab || document.getElementById('nova-wake-card')) return;
        var box = document.createElement('div');
        box.id = 'nova-wake-card';
        box.className = 'space-y-3 border border-slate-700 rounded-lg p-3';
        box.addEventListener('click', onClick);
        tab.insertBefore(box, tab.firstChild);
        render();
        // 設定頁的語音分頁看得到時每 2 秒更新狀態（看不到就不查）
        if (!timer) timer = setInterval(function () {
            if (document.visibilityState !== 'visible') return;
            if (!box.offsetParent) return;
            refresh();
        }, 2000);
    }

    function boot() {
        mount();
        var P = plugin();
        if (!P) return;
        try { P.addListener('wake', function () { checkWake(); }); } catch (e) { /* */ }
        try { P.addListener('model', function (d) { dl = d && (d.phase === 'download' || d.phase === 'unzip') ? d : null; render(); }); } catch (e) { /* */ }
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') { setTimeout(checkWake, 150); setTimeout(refresh, 600); }
        });
        apply().then(render);
        setTimeout(checkWake, 400);
    }

    window.NovaWakeUI = { version: VERSION, refresh: refresh, checkWake: checkWake, config: cfg };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();

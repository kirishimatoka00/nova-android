/* ═════════════════════════════════════════════
   nova-remote.js — NOVA Android「電腦遙控」（跟 index.html 放同一個資料夾 www/）
   版本：v1.0.0
   版本紀錄：
   v1.0.0 - 批次 8（App v2.6.32）。對標桌面版「手機遠端存取」：桌面版 Python 引擎（sidecar，預設 8000 埠）在 /app/ 提供完整的 NOVA 網頁殼，
            手機用瀏覽器開 http://<電腦位址>:8000/app 就能操作電腦端 nova-desktop（配對碼、任務狀態、遠端指令、金鑰留在電腦）。
            這支把那個頁面「內嵌」進手機版的全螢幕頁面：① 輸入電腦位址（Tailscale／同網段 IP；可存多組、記住上次用的）② 連線測試（GET /app/）
            ③ 內嵌 iframe 顯示桌面版網頁殼（配對碼流程都在桌面版頁面裡完成，這邊不碰金鑰或配對）④ 重新整理／換位址／關閉。
            連線只走使用者自己的私有網路；本檔不儲存任何配對憑證（憑證由內嵌頁面存在它自己的 localStorage）。
   對外：window.NovaRemote = { open, close, test, getHosts, VERSION }；window.openRemoteDesktop()；window.novaRemoteRenderSettings()
   ═════════════════════════════════════════════ */
(function (W) {
    'use strict';
    var VERSION = '1.0.0', LS_HOSTS = 'nova_remote_hosts', LS_LAST = 'nova_remote_last', LS_AUTO = 'nova_remote_auto';
    function lsGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
    function mk(tag, css, txt) { var e = document.createElement(tag); if (css) e.style.cssText = css; if (txt != null) e.textContent = txt; return e; }
    function toast(m) { try { if (W.showToast) W.showToast(m); else if (W.novaToast) W.novaToast(m); } catch (e) {} }
    var INP = 'width:100%;min-height:46px;padding:8px 12px;border-radius:10px;border:1px solid var(--nv-line,#334155);background:var(--nv-bg2,rgba(15,23,42,.6));color:inherit;font-size:15px;box-sizing:border-box;';
    var BTN = 'min-height:46px;padding:0 16px;border-radius:10px;border:1px solid var(--nv-line,#334155);background:transparent;color:inherit;font-weight:700;font-size:14px;';
    var BTNP = 'min-height:46px;padding:0 16px;border-radius:10px;border:0;background:#6366f1;color:#fff;font-weight:700;font-size:14px;';

    // 正規化使用者輸入：補 http://、補預設埠 8000、去掉結尾的 /app 與斜線
    function normalize(s) {
        s = String(s || '').trim(); if (!s) return '';
        if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
        s = s.replace(/\/+$/, '').replace(/\/app$/i, '');
        var m = /^(https?:\/\/)([^\/:]+)(:\d+)?(\/.*)?$/i.exec(s); if (!m) return '';
        return m[1] + m[2] + (m[3] || ':8000') + (m[4] || '');
    }
    function getHosts() { try { var a = JSON.parse(lsGet(LS_HOSTS, '[]')); return Array.isArray(a) ? a.filter(function (x) { return typeof x === 'string'; }) : []; } catch (e) { return []; } }
    function remember(url) { var a = getHosts().filter(function (x) { return x !== url; }); a.unshift(url); lsSet(LS_HOSTS, JSON.stringify(a.slice(0, 5))); lsSet(LS_LAST, url); }
    function forget(url) { lsSet(LS_HOSTS, JSON.stringify(getHosts().filter(function (x) { return x !== url; }))); if (lsGet(LS_LAST, '') === url) lsSet(LS_LAST, ''); }

    async function test(url) {
        url = normalize(url); if (!url) return { ok: false, error: '位址格式不對（例：100.64.1.2 或 192.168.1.20:8000）' };
        var t0 = Date.now(), ctl = typeof AbortController !== 'undefined' ? new AbortController() : null, to = ctl ? setTimeout(function () { ctl.abort(); }, 8000) : null;
        try {
            var r = await fetch(url + '/app/', { method: 'GET', signal: ctl ? ctl.signal : undefined, cache: 'no-store' });
            var txt = ''; try { txt = await r.text(); } catch (e) {}
            if (r.status === 404) return { ok: false, error: '電腦有回應，但找不到網頁殼（HTTP 404）：請確認電腦端 NOVA 版本支援遠端存取，且 web 資料夾有 index.html（Documents/NOVA/web/）' };
            if (r.status >= 400) return { ok: false, error: '電腦回應 HTTP ' + r.status };
            if (txt && txt.indexOf('<') < 0) return { ok: false, error: '回應內容不像網頁（可能不是 NOVA 引擎）' };
            return { ok: true, ms: Date.now() - t0, url: url };
        } catch (e) {
            return { ok: false, error: '連不到 ' + url + '：請確認 ① 電腦開著且 NOVA 引擎在跑 ② 手機跟電腦在同一個私有網路（Tailscale 已連線／同一個 Wi-Fi）③ 電腦端已開啟「手機遠端存取」並允許該網路。（' + ((e && e.message) || e) + '）' };
        } finally { if (to) clearTimeout(to); }
    }

    var ov = null;
    function close() { if (ov) { ov.remove(); ov = null; } }
    function open(urlArg) {
        close();
        ov = mk('div', 'position:fixed;inset:0;z-index:100000;display:flex;flex-direction:column;background:var(--nv-bg,#020617);color:var(--nv-text,#e2e8f0);'); ov.id = 'nova-remote-overlay';
        var bar = mk('div', 'display:flex;align-items:center;gap:6px;padding:calc(env(safe-area-inset-top,0px) + 8px) 10px 8px;border-bottom:1px solid var(--nv-line,#1e293b);flex:none;');
        var title = mk('div', 'flex:1;min-width:0;font-weight:800;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', '🖥️ 電腦遙控');
        function ib(txt, label, fn) { var b = mk('button', 'width:44px;height:44px;border-radius:10px;border:0;background:transparent;color:inherit;font-size:20px;', txt); b.type = 'button'; b.setAttribute('aria-label', label); b.onclick = fn; return b; }
        var bReload = ib('⟳', '重新整理', function () { if (frame && frame.src) frame.src = frame.src; });
        var bSwitch = ib('⇄', '換電腦位址', function () { showConnect(); });
        var bClose = ib('✕', '關閉', close);
        bar.append(title, bReload, bSwitch, bClose);
        var body = mk('div', 'flex:1;min-height:0;position:relative;'); ov.append(bar, body); document.body.appendChild(ov);
        var frame = null;

        function showFrame(url) {
            body.textContent = ''; title.textContent = '🖥️ ' + url.replace(/^https?:\/\//, '');
            frame = mk('iframe', 'position:absolute;inset:0;width:100%;height:100%;border:0;background:#020617;'); frame.id = 'nova-remote-frame';
            frame.setAttribute('allow', 'clipboard-read; clipboard-write; microphone; camera; fullscreen');
            var load = mk('div', 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:13px;opacity:.7;pointer-events:none;', '連線中…'); body.append(frame, load);
            frame.onload = function () { load.remove(); };
            frame.src = url + '/app/';
        }
        function showConnect(msg) {
            frame = null; title.textContent = '🖥️ 電腦遙控'; body.textContent = '';
            var box = mk('div', 'position:absolute;inset:0;overflow-y:auto;padding:16px;-webkit-overflow-scrolling:touch;');
            box.appendChild(mk('div', 'font-size:13px;line-height:1.6;opacity:.8;', '遠端操作你電腦上的 NOVA Desktop：輸入電腦的位址（建議用 Tailscale 的 100.x.x.x，或同一個 Wi-Fi 的區網 IP；預設埠 8000）。連上後在電腦端產生配對碼，於下方頁面輸入即可。API 金鑰留在電腦，不會傳到手機。'));
            box.appendChild(mk('div', 'font-size:13px;font-weight:700;margin-top:14px;', '電腦位址'));
            var inp = mk('input', INP + 'margin-top:6px;'); inp.type = 'url'; inp.placeholder = '例：100.64.1.2:8000'; inp.autocapitalize = 'off'; inp.autocomplete = 'off'; inp.value = urlArg || lsGet(LS_LAST, ''); box.appendChild(inp);
            var res = mk('div', 'font-size:12px;margin-top:8px;line-height:1.5;word-break:break-all;', msg || ''); box.appendChild(res);
            var row = mk('div', 'display:flex;gap:8px;margin-top:10px;');
            var bT = mk('button', BTN + 'flex:1;', '測試連線'); bT.type = 'button';
            var bC = mk('button', BTNP + 'flex:1;', '連線'); bC.type = 'button';
            bT.onclick = async function () { bT.disabled = true; res.textContent = '測試中…'; var r = await test(inp.value); res.textContent = r.ok ? '✅ 連線成功（' + r.ms + ' ms）' : '❌ ' + r.error; bT.disabled = false; };
            bC.onclick = async function () { var u = normalize(inp.value); if (!u) { res.textContent = '❌ 位址格式不對'; return; } bC.disabled = true; res.textContent = '連線中…'; var r = await test(u); bC.disabled = false; if (!r.ok) { res.textContent = '❌ ' + r.error; return; } remember(u); showFrame(u); };
            row.append(bT, bC); box.appendChild(row);
            var hs = getHosts();
            if (hs.length) {
                box.appendChild(mk('div', 'font-size:13px;font-weight:700;margin-top:18px;', '已存的電腦'));
                hs.forEach(function (h) {
                    var r = mk('div', 'display:flex;align-items:center;gap:6px;margin-top:6px;');
                    var b = mk('button', BTN + 'flex:1;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', h.replace(/^https?:\/\//, '')); b.type = 'button'; b.onclick = function () { inp.value = h; bC.click(); };
                    var d = mk('button', 'width:44px;height:46px;border-radius:10px;border:0;background:transparent;color:inherit;font-size:18px;', '🗑'); d.type = 'button'; d.setAttribute('aria-label', '刪除'); d.onclick = function () { forget(h); showConnect(); };
                    r.append(b, d); box.appendChild(r);
                });
            }
            var au = mk('label', 'display:flex;gap:10px;align-items:center;margin-top:18px;font-size:14px;'); var cb = mk('input'); cb.type = 'checkbox'; cb.checked = lsGet(LS_AUTO, '1') === '1'; cb.style.cssText = 'width:20px;height:20px;'; cb.onchange = function () { lsSet(LS_AUTO, cb.checked ? '1' : '0'); };
            au.append(cb, mk('span', '', '下次開啟時自動連到上次的電腦')); box.appendChild(au);
            body.appendChild(box);
        }
        var last = lsGet(LS_LAST, '');
        if (!urlArg && last && lsGet(LS_AUTO, '1') === '1') { body.appendChild(mk('div', 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:13px;opacity:.7;', '連線到 ' + last.replace(/^https?:\/\//, '') + '…')); test(last).then(function (r) { if (!ov) return; if (r.ok) showFrame(last); else showConnect('❌ ' + r.error); }); }
        else showConnect();
    }

    function renderSettings() {
        var el = document.getElementById('tab-remote'); if (!el) return; el.textContent = '';
        el.appendChild(mk('div', 'font-size:12px;opacity:.75;line-height:1.5;', '把電腦上的 NOVA Desktop 網頁殼內嵌進來遠端操作（配對碼、任務狀態、遠端指令）。需要電腦端 NOVA 引擎在跑，且手機能連到電腦（Tailscale／同網段）。'));
        var hs = getHosts(); el.appendChild(mk('div', 'font-size:13px;margin-top:10px;', hs.length ? '已存電腦：' + hs.map(function (h) { return h.replace(/^https?:\/\//, ''); }).join('、') : '尚未連過任何電腦'));
        var b = mk('button', BTNP + 'width:100%;margin-top:12px;', '🖥️ 開啟電腦遙控'); b.type = 'button'; b.onclick = function () { open(); }; el.appendChild(b);
    }
    W.openRemoteDesktop = function () { open(); };
    W.novaRemoteRenderSettings = renderSettings;
    W.NovaRemote = { open: open, close: close, test: test, getHosts: getHosts, _normalize: normalize, VERSION: VERSION };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', renderSettings); else setTimeout(renderSettings, 800);
})(window);

/* ═════════════════════════════════════════════════════════════════
   nova-termux.js — NOVA Android「執行 Python／指令」（跟 index.html 放同一個資料夾 www/）
   版本：v1.0.2
   版本紀錄：
   v1.0.2 - App v2.6.78。修正還原備份後設定卡片仍是空白的：還原只寫 localStorage，已建好的卡片沒更新，之後 syncFromDom 反而用空值蓋掉剛還原的 Token。
            importCfg 沒有資料（舊備份檔沒有 termuxConfig）時，改成把 localStorage 目前的值刷新到卡片；syncFromDom 只在使用者實際輸入過（或 localStorage 沒有值）時才寫回，
            卡片欄位空白但 localStorage 有值時不覆蓋。
   v1.0.1 - App v2.6.77。修正 Termux Token／網址沒進完整備份與快照：設定卡片原本只在欄位「失焦（change）」時才存到 localStorage，貼上 Token 後直接關設定或直接備份就沒存到；
            且改設定不會觸發 NOVA_Live.json 快照。現在：輸入時（input／change／blur）即存、2 秒後自動重寫快照；備份與快照時直接讀畫面上欄位的值存檔；
            備份新增專用欄位 termuxConfig（url／token／auto／pyodide），還原時寫回並更新設定卡片。新增 exportCfg()／importCfg()。
   v1.0.0 - App v2.6.72。讓工具呼叫（一般對話）與自主任務（/ap）能執行真正的 Python 與指令：
            ① Termux 橋接（主要）：把程式碼送到 Termux 裡的 nova_bridge.py（repo 的 termux/ 資料夾，install.sh 一行安裝）執行，
               原生 Python、可 pip 安裝、有網路與檔案系統、可呼叫 termux-* 指令；輸出、退出碼、新增或修改的檔案都會回傳。
            ② Pyodide 備援：橋接沒設定或連不上時，改在 App 內建的 Pyodide（Web Worker，有逾時）執行；只能做運算與文字處理，沒有網路與檔案。
            工具：run_python、run_shell、pip_install（後兩者只有設了橋接才出現）。預設每次執行前先問使用者，設定頁可改成自動允許。
            設定頁「🔌 工具」分頁新增「Termux 橋接」卡片：網址、Token、自動允許、Pyodide 備援、測試連線、安裝指令。
   對外：window.NovaTermux = { configured, ping, runPython, runShell, pipInstall, agentRun, exportCfg, importCfg, version }
   依賴：window.novaFcRegistry（index.html）、可選 window.showConfirm／showToast
   ═════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';
    if (window.NovaTermux) return;
    var W = window, D = document;
    var K_URL = 'nova_termux_url', K_TOKEN = 'nova_termux_token', K_AUTO = 'nova_termux_auto', K_PYO = 'nova_termux_pyodide';
    var DEF_URL = 'http://127.0.0.1:7913';
    var INSTALL_CMD = 'curl -fsSL https://raw.githubusercontent.com/kirishimatoka00/nova-android/main/termux/install.sh | bash';

    function lsGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
    function toast(m, t) { try { if (typeof W.showToast === 'function') W.showToast(m, t || 3500); } catch (e) { /* ignore */ } }
    function cfg() { return { url: (lsGet(K_URL, DEF_URL) || DEF_URL).replace(/\/+$/, ''), token: lsGet(K_TOKEN, '').trim(), auto: lsGet(K_AUTO, '0') === '1', pyodide: lsGet(K_PYO, '1') === '1' }; }
    function configured() { return !!cfg().token; }
    function soft(msg) { var e = new Error(msg); e.soft = true; return e; }   // 自主任務裡的「軟失敗」：回報給 AI，不中止任務

    /* ───────── 橋接呼叫 ───────── */
    async function call(method, path, body, timeoutMs) {
        var c = cfg(), url = c.url + path, headers = { 'Content-Type': 'application/json', 'X-Nova-Token': c.token };
        var CH = W.Capacitor && W.Capacitor.Plugins && W.Capacitor.Plugins.CapacitorHttp, st, j;
        if (CH) {
            var r = await CH.request({ method: method, url: url, headers: headers, data: body || undefined, connectTimeout: 5000, readTimeout: timeoutMs || 15000, responseType: 'json' });
            st = r.status; j = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
        } else {
            var ctl = new AbortController(), to = setTimeout(function () { ctl.abort(); }, timeoutMs || 15000);
            try { var rr = await fetch(url, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal }); st = rr.status; j = await rr.json().catch(function () { return null; }); }
            finally { clearTimeout(to); }
        }
        if (st === 401) throw new Error('Token 不正確（請重新貼上 Termux 安裝完成時顯示的 Token）');
        if (st === 403) throw new Error('橋接服務拒絕了這個請求（Host／Origin 不符）');
        if (!j) throw new Error('橋接服務沒有回應有效內容（HTTP ' + st + '）');
        if (st >= 400) throw new Error(j.error || ('HTTP ' + st));
        return j;
    }
    async function ping() {
        var c = cfg(), CH = W.Capacitor && W.Capacitor.Plugins && W.Capacitor.Plugins.CapacitorHttp;
        var headers = { 'X-Nova-Token': c.token };
        if (CH) { var r = await CH.request({ method: 'GET', url: c.url + '/ping', headers: headers, connectTimeout: 4000, readTimeout: 6000, responseType: 'json' }); return typeof r.data === 'string' ? JSON.parse(r.data) : r.data; }
        var ctl = new AbortController(), to = setTimeout(function () { ctl.abort(); }, 6000);
        try { return await (await fetch(c.url + '/ping', { headers: headers, signal: ctl.signal })).json(); } finally { clearTimeout(to); }
    }

    /* ───────── Pyodide 備援（Web Worker） ───────── */
    var pyW = null, pyIdle = null;
    function pyWorker() {
        if (pyW) return pyW;
        var src = 'var py=null;self.onmessage=async function(e){var m=e.data;try{' +
            'if(!py){importScripts(m.base+"pyodide.js");py=await loadPyodide({indexURL:m.base});}' +
            'var out="",err="";py.setStdout({batched:function(s){out+=s+"\\n";}});py.setStderr({batched:function(s){err+=s+"\\n";}});' +
            'try{try{await py.loadPackagesFromImports(m.code);}catch(x){}var r=await py.runPythonAsync(m.code);self.postMessage({ok:true,out:out,err:err,result:(r===undefined||r===null)?null:String(r)});}' +
            'catch(ex){self.postMessage({ok:false,out:out,err:err+String(ex&&ex.message||ex)});}' +
            '}catch(ex){self.postMessage({ok:false,out:"",err:"Pyodide 啟動失敗："+String(ex&&ex.message||ex)});}};';
        pyW = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        return pyW;
    }
    function pyKill() { if (pyW) { try { pyW.terminate(); } catch (e) { /* ignore */ } pyW = null; } if (pyIdle) { clearTimeout(pyIdle); pyIdle = null; } }
    function runPyodide(code, timeoutSec) {
        return new Promise(function (resolve) {
            var w = pyWorker(), base = new URL('./pyodide/', W.location.href).href, done = false, t0 = Date.now();
            var finish = function (r) { if (done) return; done = true; clearTimeout(tm); w.onmessage = null; w.onerror = null; if (pyIdle) clearTimeout(pyIdle); pyIdle = setTimeout(pyKill, 180000); r.ms = Date.now() - t0; resolve(r); };
            var tm = setTimeout(function () { pyKill(); finish({ ok: false, exit: -9, timed_out: true, stdout: '', stderr: '', files: [] }); }, Math.max(5, Math.min(timeoutSec || 60, 300)) * 1000 + 25000);   // +25 秒給第一次載入 Pyodide
            w.onmessage = function (e) { var m = e.data; finish({ ok: !!m.ok, exit: m.ok ? 0 : 1, timed_out: false, stdout: (m.out || '') + (m.result ? '（回傳值）' + m.result + '\n' : ''), stderr: m.err || '', files: [] }); };
            w.onerror = function (e) { pyKill(); finish({ ok: false, exit: 1, timed_out: false, stdout: '', stderr: 'Worker 錯誤：' + (e && e.message || e), files: [] }); };
            w.postMessage({ code: code, base: base });
        });
    }

    /* ───────── 對外執行函式（回傳統一格式文字） ───────── */
    function fmt(engine, r) {
        var o = ['【' + engine + '】' + (r.timed_out ? '⏱️ 逾時被強制結束' : (r.ok ? '執行成功' : '執行失敗（退出碼 ' + r.exit + '）')) + '，耗時 ' + (r.ms || 0) + ' ms'];
        if (r.stdout) o.push('— 標準輸出 —\n' + r.stdout.replace(/\s+$/, ''));
        if (r.stderr) o.push('— 標準錯誤 —\n' + r.stderr.replace(/\s+$/, ''));
        if (!r.stdout && !r.stderr) o.push('（沒有輸出；要看結果請用 print）');
        if (r.files && r.files.length) o.push('— 新增／修改的檔案（在 ~/nova_work）—\n' + r.files.map(function (f) { return f.path + '（' + f.size + ' bytes）'; }).join('\n'));
        return o.join('\n');
    }
    async function runPython(code, timeoutSec, engine) {
        var c = cfg(), want = engine || 'auto', t = Math.max(1, Math.min(+timeoutSec || 60, 600));
        if (want !== 'pyodide' && c.token) {
            try { return fmt('Termux Python', await call('POST', '/run', { code: String(code), timeout: t }, (t + 15) * 1000)); }
            catch (e) {
                if (want === 'termux' || !c.pyodide) throw new Error('Termux 橋接無法使用：' + ((e && e.message) || e) + (/Token/.test(String((e && e.message) || e)) ? '' : '（請確認 Termux 有執行：bash ~/nova_bridge/start.sh）'));
                // 其餘情況退回 Pyodide
                var back = await runPyodide(String(code), t);
                return '⚠️ Termux 橋接無法使用（' + ((e && e.message) || e) + '），已改用 App 內建 Pyodide（沒有網路與檔案、套件有限）。\n' + fmt('Pyodide', back);
            }
        }
        if (!c.pyodide && want !== 'pyodide') throw new Error('尚未設定 Termux 橋接，且 Pyodide 備援已關閉（設定 → 🔌 工具 → Termux 橋接）');
        return fmt('Pyodide', await runPyodide(String(code), t));
    }
    async function runShell(cmd, timeoutSec) {
        if (!configured()) throw new Error('執行指令需要 Termux 橋接（設定 → 🔌 工具 → Termux 橋接）');
        var t = Math.max(1, Math.min(+timeoutSec || 60, 600));
        return fmt('Termux 指令', await call('POST', '/shell', { cmd: String(cmd), timeout: t }, (t + 15) * 1000));
    }
    async function pipInstall(pkgs) {
        if (!configured()) throw new Error('安裝套件需要 Termux 橋接');
        var list = (Array.isArray(pkgs) ? pkgs : String(pkgs || '').split(/[\s,]+/)).filter(Boolean);
        return fmt('pip install', await call('POST', '/pip', { packages: list, timeout: 300 }, 320000));
    }

    /* 自主任務用：先確認（除非設成自動允許），失敗一律丟軟失敗 */
    async function agentRun(kind, a) {
        var c = cfg();
        var desc = kind === 'python' ? 'Python 程式碼：\n' + String(a.code || '').slice(0, 600) : '指令：\n' + String(a.cmd || a.command || '').slice(0, 600);
        if (!c.auto && typeof W.showConfirm === 'function') {
            var ok = await W.showConfirm('自主任務想在手機上執行' + desc + '\n\n要允許嗎？');
            if (!ok) throw soft('使用者拒絕了這次執行。請改用其他方式，或在 say 欄位說明為什麼需要執行。');
        }
        try { return kind === 'python' ? await runPython(a.code, a.timeout_sec) : await runShell(a.cmd || a.command, a.timeout_sec); }
        catch (e) { throw soft((e && e.message) || String(e)); }
    }

    /* ───────── 註冊成工具呼叫來源 ───────── */
    function toolList() {
        var c = cfg(), need = !c.auto;
        var base = function (o) { o.readOnly = false; o.needsConfirm = need; o.serial = true; return o; };
        var out = [];
        if (c.token || c.pyodide) out.push(base({ name: 'run_python', label: '執行 Python',
            description: '在手機上執行 Python 程式碼並回傳輸出（用 print 輸出結果）。適合：計算、處理與整理文字／JSON／表格、解析網頁或搜尋結果、產生檔案、呼叫 API。' + (c.token ? '預設在 Termux 的原生 Python 執行（有網路、可讀寫 ~/nova_work、可 pip 安裝套件）；橋接連不上時自動退回內建 Pyodide（沒有網路與檔案）。' : '目前只有內建 Pyodide（沒有網路與檔案系統、套件有限）。') + '一次寫完整程式，不要假設上一次呼叫的變數還在。',
            parameters: { type: 'object', properties: { code: { type: 'string', description: '完整的 Python 程式碼' }, timeout_sec: { type: 'number', description: '逾時秒數，預設 60，最大 600' }, engine: { type: 'string', description: 'auto（預設）、termux、pyodide' } }, required: ['code'] },
            run: async function (a) { return await runPython(a.code, a.timeout_sec, a.engine); } }));
        if (c.token) {
            out.push(base({ name: 'run_shell', label: '執行指令',
                description: '在 Termux 執行 shell 指令（bash）。可用 termux-* 指令（需另外安裝 Termux:API）讀簡訊、定位、剪貼簿、通知等；也可用 curl、git、ls 等。工作資料夾 ~/nova_work。',
                parameters: { type: 'object', properties: { command: { type: 'string', description: '要執行的指令' }, timeout_sec: { type: 'number', description: '逾時秒數，預設 60' } }, required: ['command'] },
                run: async function (a) { return await runShell(a.command, a.timeout_sec); } }));
            out.push(base({ name: 'pip_install', label: '安裝 Python 套件',
                description: '用 pip 在 Termux 安裝 Python 套件（例如 requests、beautifulsoup4）。裝完後 run_python 才能 import。',
                parameters: { type: 'object', properties: { packages: { type: 'array', items: { type: 'string' }, description: '套件名稱清單' } }, required: ['packages'] },
                run: async function (a) { return await pipInstall(a.packages); } }));
        }
        return out;
    }
    function register() {
        if (!W.novaFcRegistry) return false;
        W.novaFcRegistry.register({ id: 'termux', label: 'Termux／Python', list: async function () { return toolList(); } });
        return true;
    }

    /* ───────── 備份／快照 ───────── */
    // 把設定卡片上目前的值寫進 localStorage（欄位還沒失焦也一樣）；卡片還沒建立就什麼都不做
    function syncFromDom() {
        var u = D.getElementById('ntx-url'), t = D.getElementById('ntx-token'), a = D.getElementById('ntx-auto'), p = D.getElementById('ntx-pyo');
        if (!u || !t) return;
        var tv = t.value.trim();
        lsSet(K_URL, u.value.trim() || DEF_URL);
        if (tv || !lsGet(K_TOKEN, '') || t.dataset.touched === '1') lsSet(K_TOKEN, tv);   // 卡片空白但儲存空間有值（剛還原、卡片還沒刷新）→ 不覆蓋
        if (a) lsSet(K_AUTO, a.checked ? '1' : '0'); if (p) lsSet(K_PYO, p.checked ? '1' : '0');
    }
    var snapTimer = null;
    function scheduleSnap() { clearTimeout(snapTimer); snapTimer = setTimeout(function () { try { if (typeof W._novaWalSnapshot === 'function') W._novaWalSnapshot(); } catch (e) { /* ignore */ } }, 2000); }
    function exportCfg() { syncFromDom(); var c = cfg(); return { url: c.url, token: c.token, auto: c.auto ? '1' : '0', pyodide: c.pyodide ? '1' : '0' }; }
    function importCfg(o) {
        o = (o && typeof o === 'object') ? o : {};
        if (o.url) lsSet(K_URL, String(o.url)); if (typeof o.token === 'string') lsSet(K_TOKEN, o.token);
        if (o.auto != null) lsSet(K_AUTO, String(o.auto) === '1' || o.auto === true ? '1' : '0'); if (o.pyodide != null) lsSet(K_PYO, String(o.pyodide) === '0' || o.pyodide === false ? '0' : '1');
        var c = cfg(), set = function (id, f) { var el = D.getElementById(id); if (el) f(el); };
        set('ntx-url', function (el) { el.value = c.url; }); set('ntx-token', function (el) { el.value = c.token; el.dataset.touched = '0'; });
        set('ntx-auto', function (el) { el.checked = c.auto; }); set('ntx-pyo', function (el) { el.checked = c.pyodide; });
        return true;
    }

    /* ───────── 設定頁卡片 ───────── */
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]; }); }
    function injectCard() {
        var tab = D.getElementById('tab-tools'); if (!tab || D.getElementById('nv-termux-card')) return !!D.getElementById('nv-termux-card');
        var c = cfg(), card = D.createElement('div'); card.className = 'nv-card'; card.id = 'nv-termux-card';
        card.innerHTML = '<h4>Termux 橋接（執行 Python／指令）</h4>' +
            '<p class="nv-muted">讓 AI 在手機的 Termux 裡執行真正的 Python 與指令（可上網、讀寫檔案、pip 安裝套件）。沒設定時，只能用 App 內建的 Pyodide（沒有網路與檔案）。</p>' +
            '<div style="display:grid;gap:6px;margin-top:8px;">' +
            '<input id="ntx-url" class="nv-input" placeholder="橋接網址" value="' + esc(c.url) + '" autocomplete="off" inputmode="url">' +
            '<input id="ntx-token" type="password" class="nv-input" placeholder="Token（Termux 安裝完成時顯示）" value="' + esc(c.token) + '" autocomplete="off">' +
            '<label class="nova-em-item"><input id="ntx-auto" type="checkbox" ' + (c.auto ? 'checked' : '') + ' style="accent-color:#a855f7;"><span>執行前不再詢問（⚠️ 網頁或檔案內的惡意文字可能誘使 AI 執行危險指令，建議保持關閉）</span></label>' +
            '<label class="nova-em-item"><input id="ntx-pyo" type="checkbox" ' + (c.pyodide ? 'checked' : '') + ' style="accent-color:#a855f7;"><span>橋接連不上時，退回內建 Pyodide 執行 Python</span></label>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;"><button type="button" class="nv-btn nv-primary" id="ntx-test">測試連線</button><button type="button" class="nv-btn" id="ntx-copy">複製 Termux 安裝指令</button></div>' +
            '<div id="ntx-status" class="nv-muted" style="min-height:18px;"></div></div>';
        var anchor = D.getElementById('fc-skill-list'); anchor = anchor && anchor.closest ? anchor.closest('.nv-card') : null;
        if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(card, anchor); else tab.appendChild(card);
        var save = function () { syncFromDom(); scheduleSnap(); };
        ['ntx-url', 'ntx-token'].forEach(function (id) { ['input', 'change', 'blur'].forEach(function (ev) { D.getElementById(id).addEventListener(ev, function () { if (ev === 'input') D.getElementById(id).dataset.touched = '1'; save(); }); }); });
        ['ntx-auto', 'ntx-pyo'].forEach(function (id) { D.getElementById(id).addEventListener('change', save); });
        D.getElementById('ntx-test').onclick = async function () {
            save(); var st = D.getElementById('ntx-status'); st.textContent = '連線中…';
            try {
                var r = await ping();
                if (!r || !r.ok) st.textContent = '❌ 橋接服務回應異常';
                else if (!r.auth) st.textContent = '⚠️ 已連上橋接服務（v' + r.version + '），但 Token 不正確或沒填';
                else st.textContent = '✅ 連線成功：橋接 v' + r.version + '、Python ' + r.python + '、工作資料夾 ' + r.work_dir + '、Termux:API ' + (r.termux_api ? '可用' : '未安裝');
            } catch (e) { st.textContent = '❌ 連不上 ' + cfg().url + '：請確認 Termux 在執行（bash ~/nova_bridge/start.sh）。' + ((e && e.message) || ''); }
        };
        D.getElementById('ntx-copy').onclick = async function () {
            try { var CB = W.Capacitor && W.Capacitor.Plugins && W.Capacitor.Plugins.Clipboard; if (CB) await CB.write({ string: INSTALL_CMD }); else await navigator.clipboard.writeText(INSTALL_CMD); toast('已複製，到 Termux 貼上執行'); }
            catch (e) { D.getElementById('ntx-status').textContent = INSTALL_CMD; }
        };
        return true;
    }

    function boot(n) {
        n = n || 0;
        var a = register(), b = injectCard();
        if ((!a || !b) && n < 40) setTimeout(function () { boot(n + 1); }, 500);
    }
    W.NovaTermux = { configured: configured, ping: ping, runPython: runPython, runShell: runShell, pipInstall: pipInstall, agentRun: agentRun, exportCfg: exportCfg, importCfg: importCfg, installCommand: INSTALL_CMD, version: '1.0.2' };
    if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', function () { boot(0); }); else boot(0);
})();

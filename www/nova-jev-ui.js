/* ═════════════════════════════════════════════
   nova-jev-ui.js — NOVA Android 的 Jev 設定頁＋與技能／自主任務的銜接（跟 index.html 放同一個資料夾 www/）
   版本：v1.0.0
   版本紀錄：
   v1.0.0 - 批次 7b（App v2.6.31）。① 設定頁「⚡ Jev 快速判斷」區塊（#tab-jev，id 跟 nova-jev.js 的 loadUI／saveUI 對得上：jev-key／jev-enabled／jev-thr／jev-f-*）。
            ② 銜接層 window.NovaJevUI：verifyDone（自主任務宣告完成前複查）。
            ③ 在 window.NovaJev 補上 nova-skill-ui.js 預期的介面：isOn(用途)、matchSkill(goal, [{name,text}])、suggestParams(候選值, goal)、suggestDrop(goal, steps)。
            手機版只顯示已接上的 4 個用途開關（verify／skill／params／partial）。
   依賴：nova-jev.js（window.NovaJev）。Jev 沒開或任何失敗，一律回 null／false，呼叫端照原本流程。
   ═════════════════════════════════════════════ */
(function (W) {
    'use strict';
    var J = function () { return W.NovaJev; };
    var $ = function (id) { return document.getElementById(id); };
    var WIRED = [['verify', '完成前驗證', 'AI 宣告「任務完成」時用三題機率題複查；只有很有把握不對才退回，同一任務最多退回 2 次。'],
                 ['skill', '技能比對', '/ap 執行前，用 Jev 判斷已存技能能不能套用到這次任務（快、便宜）；不確定才問 AI。'],
                 ['params', '技能參數建議', '存技能設定參數時，「⚡ Jev 建議」會判斷哪些值下次會變。'],
                 ['partial', '半成品步驟篩選', '存成半成品時，建議取消冗餘／試探性的步驟。']];

    function mk(tag, css, txt) { var e = document.createElement(tag); if (css) e.style.cssText = css; if (txt != null) e.textContent = txt; return e; }
    function field(label, hint) { var d = mk('div', 'margin-top:12px;'); d.appendChild(mk('div', 'font-size:13px;font-weight:700;', label)); if (hint) d.appendChild(mk('div', 'font-size:11px;opacity:.65;margin:2px 0 6px;', hint)); return d; }
    var INP = 'width:100%;min-height:44px;padding:8px 12px;border-radius:10px;border:1px solid var(--nv-line,#334155);background:var(--nv-bg2,rgba(15,23,42,.6));color:inherit;font-size:14px;box-sizing:border-box;';
    function toggle(id, label, hint) {
        var row = mk('label', 'display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-top:1px solid var(--nv-line,#1e293b);');
        var cb = mk('input'); cb.type = 'checkbox'; cb.id = id; cb.style.cssText = 'width:20px;height:20px;flex:none;margin-top:2px;';
        cb.onchange = function () { J().saveUI(true); };
        var tx = mk('div'); tx.appendChild(mk('div', 'font-size:14px;font-weight:600;', label)); if (hint) tx.appendChild(mk('div', 'font-size:11px;opacity:.65;', hint));
        row.append(cb, tx); return row;
    }

    function render() {
        var el = $('tab-jev'); if (!el || !J()) return; el.textContent = '';
        el.appendChild(mk('div', 'font-size:12px;opacity:.75;line-height:1.5;', 'Jev 是 TypeSafe AI 的小決策模型：只回預先定義的選項（選一個／打分／機率），延遲約 0.1～0.5 秒、很便宜；不產生文字，所以只拿來做「判斷」。預設關閉，要填金鑰並打開總開關才會動；任何失敗都會退回原本流程。送出的內容（任務目標、執行紀錄摘要、技能描述）會傳到 TypeSafe AI。'));
        var f = field('TypeSafe API Key', '存在這支手機的本機儲存，不會同步。'); var key = mk('input', INP); key.id = 'jev-key'; key.type = 'password'; key.autocomplete = 'off'; key.placeholder = 'API Key'; key.onchange = function () { J().saveUI(true); }; f.appendChild(key); el.appendChild(f);
        el.appendChild(toggle('jev-enabled', '啟用 Jev（總開關）', '關閉時下面所有用途都不會呼叫 Jev。'));
        var t = field('信心門檻（0.5～0.95）', '越高越保守：只在很有把握時才採用 Jev 的判斷。預設 0.7。'); var thr = mk('input', INP); thr.id = 'jev-thr'; thr.type = 'number'; thr.step = '0.05'; thr.min = '0.5'; thr.max = '0.95'; thr.inputMode = 'decimal'; thr.onchange = function () { J().saveUI(true); }; t.appendChild(thr); el.appendChild(t);
        WIRED.forEach(function (w) { el.appendChild(toggle('jev-f-' + w[0], w[1], w[2])); });
        var row = mk('div', 'display:flex;gap:8px;margin-top:12px;');
        var save = mk('button', 'flex:1;min-height:44px;border-radius:10px;border:0;background:#6366f1;color:#fff;font-weight:700;', '儲存'); save.type = 'button'; save.onclick = function () { J().saveUI(false); };
        var test = mk('button', 'flex:1;min-height:44px;border-radius:10px;border:1px solid var(--nv-line,#334155);background:transparent;color:inherit;font-weight:700;', '測試連線'); test.type = 'button'; test.onclick = function () { J().testConnection(); };
        row.append(save, test); el.appendChild(row);
        var out = mk('div', 'font-size:12px;margin-top:8px;word-break:break-all;'); out.id = 'jev-test-result'; el.appendChild(out);
        var st = mk('div', 'font-size:11px;opacity:.7;margin-top:8px;white-space:pre-wrap;line-height:1.5;'); st.id = 'jev-stats'; el.appendChild(st);
        J().loadUI();
    }
    W.novaJevRenderSettings = render;

    // ── 銜接 nova-skill-ui.js 預期的介面 ──
    function install() {
        var j = J(); if (!j || j._androidGlue) return; j._androidGlue = true;
        j.isOn = function (use) { try { return !!j.isActive(use); } catch (e) { return false; } };
        j.matchSkill = async function (goal, cands) {
            try { var r = await j.pickSkills(goal, (cands || []).map(function (c) { return { name: c.name, desc: c.text, outline: c.text }; }), 1); return r && r.ok && r.names && r.names[0] ? { name: r.names[0] } : null; } catch (e) { return null; }
        };
        j.suggestParams = async function (cands, goal) {
            try {
                var r = await j.rateParams(goal, (cands || []).map(function (c) { return { value: c.value, where: [c.label || ''] }; })); if (!r || !r.ok) return null;
                var thr = r.threshold || 0.7; return r.probs.map(function (p) { return p == null ? null : (p >= thr ? true : (p <= 1 - thr ? false : null)); });
            } catch (e) { return null; }
        };
        j.suggestDrop = async function (goal, steps) {
            try { var r = await j.rateSteps(goal, (steps || []).map(function (s) { return { label: s.label || '', outcome: s.outcome || '' }; })); return r && r.ok ? r.drop : null; } catch (e) { return null; }
        };
    }

    // 自主任務宣告 done 時複查。回傳 {reject:true, reason} 或 null（放行）
    async function verifyDone(goal, history, summary) {
        try {
            var j = J(); if (!j || !j.isActive('verify')) return null;
            var steps = (history || []).slice(-6).map(function (h) { var a = h.action || {}; return { label: (a.say || a.type || '') + (a.type ? '（' + a.type + '）' : ''), outcome: String(h.result || 'OK') }; });
            var r = await j.verifyCompletion({ goal: goal, steps: steps, summary: summary || '' });
            if (r && r.ok && r.approved === false) return { reject: true, reason: r.reason || '' };
        } catch (e) { /* 任何錯誤一律放行 */ }
        return null;
    }
    W.NovaJevUI = { verifyDone: verifyDone, render: render, install: install };
    install();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render); else setTimeout(render, 800);
})(window);

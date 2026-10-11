/* ═══════════════════════════════════════════════════════════════════════
   nova-skill-ui.js — NOVA Android 技能介面與接線層（跟 index.html 放同一個資料夾 www/）
   版本：v1.1.0
   版本紀錄：
   v1.1.0 - 批次 7b。存半成品視窗加「⚡ Jev 建議取消冗餘步驟」（Jev 開啟且 partial 開關開才顯示）。
   v1.0.0 - 批次 7a。對標桌面版「技能」功能（nova-skill-params.js／nova-skill-clone.js 的手機版重寫；桌面版以 Python／Windows 步驟為主，手機版改以手機操作步驟為主）：
            ① 技能管理頁（全螢幕）：搜尋、分類（可重播／提示範本／組裝流程／腳本／半成品）、每個技能有 執行／參數／編輯／複製／改名／刪除；
               ＋選單：新增提示範本、新增組裝流程、匯入／匯出、修復索引。
            ② 自主任務成功後轉技能：任務完成時底部出現「💾 存成技能」；可勾選要保留的步驟、命名、寫說明，存完可接著設定參數。
               失敗／中斷後出現「📎 存成半成品」：挑出做對的步驟＋失敗位置＋AI 整理的避坑筆記；半成品不能直接執行，只在規劃新任務時以「僅供參考」提示 AI。
            ③ 技能參數化：偵測步驟裡每次可能不同的值（輸入文字、網址搜尋字、點選的項目文字），勾選後換成 {{名稱}} 佔位符；執行時跳表單（預填上次的值，
               可請 AI 依任務敘述填）。型別：文字／數字／日期／選項。
            ④ 複製（一次最多 20 份）與編輯（說明、目標、步驟 JSON 可上移／下移／複製／刪除、新增步驟、提示範本內文、流程項目順序）。
            ⑤ /ap 執行前自動比對技能（字面分數＋AI 判斷；若有 Jev 則先用 Jev）；找到就詢問是否直接重播，重播失敗可讓 AI 從目前畫面接手。
            ⑥ 設定頁「技能」分類：比對／自動重播／成功後詢問／失敗後詢問 四個開關。
   對外：window.NovaSkillUI = { open, openParams, runSkill, onTaskEnd, tryMatchAndReplay, planningHints, saveLastRun, renderSettings }
   依賴：NovaSkills（nova-skills.js）、novaAutoTask（index.html）、appState.keys.gemini、可選的 NovaJev（批次 7b）。
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';
    var W = window, $ = function (id) { return document.getElementById(id); };
    var S = function () { return W.NovaSkills; };
    function lsGet(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
    var opt = {
        match: function () { return lsGet('nova_skill_match', '1') === '1'; },
        auto: function () { return lsGet('nova_skill_auto_replay', '0') === '1'; },
        offerSave: function () { return lsGet('nova_skill_offer_save', '1') === '1'; },
        offerPartial: function () { return lsGet('nova_skill_offer_partial', '1') === '1'; }
    };
    function toast(m, d) { if (typeof W.showToast === 'function') W.showToast(m, d || 3000); }

    // ───────── DOM 小工具 ─────────
    var CSS = {
        card: 'background:var(--nv-card-2,#1e293b);border:1px solid var(--nv-line,#1e293b);border-radius:12px;padding:12px;margin-bottom:10px;',
        fld: 'width:100%;box-sizing:border-box;background:var(--nv-card,#0f172a);color:var(--nv-text,#e2e8f0);border:1px solid var(--nv-line-strong,#334155);border-radius:9px;padding:9px 10px;font-size:16px;outline:none;font-family:inherit;',
        btn: 'min-height:38px;padding:0 12px;border-radius:9px;border:1px solid var(--nv-line-strong,#334155);background:transparent;color:var(--nv-text-2,#cbd5e1);font-size:13px;cursor:pointer;',
        btnP: 'min-height:42px;padding:0 16px;border-radius:10px;border:0;background:var(--nv-accent,#3b82f6);color:#fff;font-size:15px;font-weight:700;cursor:pointer;',
        muted: 'color:var(--nv-muted,#94a3b8);font-size:12px;line-height:1.5;',
        chip: 'display:inline-block;font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--nv-line-strong,#334155);color:var(--nv-muted,#94a3b8);margin-right:4px;'
    };
    function mk(tag, css, text, attrs) {
        var e = document.createElement(tag); if (css) e.style.cssText = css; if (text != null) e.textContent = text;
        if (attrs) Object.keys(attrs).forEach(function (k) { e[k] = attrs[k]; });
        return e;
    }
    function btn(label, css, fn) { var b = mk('button', css || CSS.btn, label); b.type = 'button'; if (fn) b.onclick = fn; return b; }
    function overlay(title, z) {   // 全螢幕視窗：回傳 {root, body, foot, close}
        var root = mk('div', 'position:fixed;inset:0;z-index:' + (z || 9000) + ';background:var(--nv-canvas,#020617);color:var(--nv-text,#e2e8f0);display:flex;flex-direction:column;padding-top:env(safe-area-inset-top,0px);');
        var head = mk('div', 'display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--nv-line-strong,#334155);flex:0 0 auto;');
        head.appendChild(mk('b', 'flex:1;font-size:16px;', title));
        var body = mk('div', 'flex:1;overflow-y:auto;padding:12px 14px;-webkit-overflow-scrolling:touch;');
        var foot = mk('div', 'display:flex;gap:10px;padding:10px 14px calc(10px + env(safe-area-inset-bottom,0px));border-top:1px solid var(--nv-line-strong,#334155);flex:0 0 auto;');
        var api = { root: root, head: head, body: body, foot: foot, close: function () { if (root.parentNode) root.parentNode.removeChild(root); if (api.onClose) api.onClose(); } };
        var x = btn('✕', 'background:transparent;border:0;color:var(--nv-muted,#94a3b8);font-size:20px;min-width:40px;min-height:40px;', api.close); head.appendChild(x);
        root.append(head, body, foot); document.body.appendChild(root); return api;
    }
    function lab(t, hint) { var l = mk('div', 'font-size:12px;font-weight:600;margin:12px 0 4px;', t); if (hint) l.appendChild(mk('span', 'font-weight:400;color:var(--nv-muted,#94a3b8);margin-left:6px;', hint)); return l; }
    function ask(title, fields, okLabel) {   // 小對話框：fields [{key,label,value,type:'text'|'area'|'select',options,hint}] → Promise<values|null>
        return new Promise(function (resolve) {
            var o = overlay(title, 9500), inputs = {};
            fields.forEach(function (f) {
                o.body.appendChild(lab(f.label, f.hint));
                var el;
                if (f.type === 'area') { el = mk('textarea', CSS.fld + 'min-height:110px;resize:vertical;'); el.value = f.value || ''; }
                else if (f.type === 'select') { el = mk('select', CSS.fld); (f.options || []).forEach(function (op) { el.appendChild(new Option(op[1], op[0])); }); el.value = f.value || (f.options[0] && f.options[0][0]); }
                else { el = mk('input', CSS.fld); el.type = f.type || 'text'; el.value = f.value || ''; if (f.placeholder) el.placeholder = f.placeholder; }
                inputs[f.key] = el; o.body.appendChild(el);
            });
            var done = false;
            o.onClose = function () { if (!done) { done = true; resolve(null); } };
            o.foot.append(btn('取消', CSS.btn, function () { o.close(); }), (function () { var b = btn(okLabel || '確定', CSS.btnP + 'flex:1;', function () { var v = {}; Object.keys(inputs).forEach(function (k) { v[k] = inputs[k].value; }); done = true; o.close(); resolve(v); }); return b; })());
        });
    }
    function banner(text, buttons) {   // 底部浮動提示列（任務結束後）
        var old = $('nova-skill-banner'); if (old) old.remove();
        var b = mk('div', 'position:fixed;left:10px;right:10px;bottom:calc(86px + env(safe-area-inset-bottom,0px));z-index:8000;background:var(--nv-card,#0f172a);border:1px solid var(--nv-accent,#3b82f6);border-radius:14px;padding:10px 12px;box-shadow:0 8px 24px rgba(0,0,0,.45);color:var(--nv-text,#e2e8f0);');
        b.id = 'nova-skill-banner';
        b.appendChild(mk('div', 'font-size:13px;margin-bottom:8px;line-height:1.5;', text));
        var row = mk('div', 'display:flex;gap:8px;flex-wrap:wrap;');
        buttons.forEach(function (x) { row.appendChild(btn(x[0], x[2] ? CSS.btnP + 'min-height:38px;font-size:13px;' : CSS.btn, function () { b.remove(); if (x[1]) x[1](); })); });
        b.appendChild(row); document.body.appendChild(b);
        setTimeout(function () { if (b.parentNode) b.remove(); }, 25000);
    }

    // ───────── LLM（Gemini 小模型） ─────────
    async function llm(prompt, wantJson) {
        var key = W.appState && appState.keys && appState.keys.gemini; if (!key) throw new Error('尚未設定 Gemini API Key');
        var model = 'gemini-3.5-flash-lite';
        var body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: wantJson ? { responseMimeType: 'application/json', temperature: 0.1 } : { temperature: 0.3 } };
        var res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) });
        if (!res.ok) throw new Error('Gemini HTTP ' + res.status);
        var d = await res.json(); var t = (((d.candidates || [])[0] || {}).content || {}).parts; t = (t || []).map(function (p) { return p.text || ''; }).join('');
        if (!wantJson) return t.trim();
        var m = t.match(/[\[{][\s\S]*[\]}]/); if (!m) throw new Error('AI 回傳格式不對'); return JSON.parse(m[0]);
    }

    // ═══════════════ 參數：偵測／套用 ═══════════════
    var COMMON_UI = /^(確定|取消|返回|搜尋|送出|下一步|完成|儲存|關閉|設定|首頁|更多|OK|Cancel|Search|Back|Next|Done|Save|Close|Settings)$/i;
    function kindOf(v) {
        v = String(v).trim();
        if (/^https?:\/\//i.test(v)) return '網址';
        if (/^\d{4}[-\/.]\d{1,2}[-\/.]\d{1,2}$/.test(v) || /^\d{1,2}[-\/]\d{1,2}$/.test(v) || /\d{4}年\d{1,2}月\d{1,2}日/.test(v)) return '日期';
        if (/^\d{1,2}:\d{2}/.test(v)) return '時間';
        if (/^-?\d+(\.\d+)?$/.test(v)) return '數字';
        return '文字';
    }
    function unparam(steps, params) {   // 把佔位符還原成預設值，得到「原始步驟」
        var def = {}; (params || []).forEach(function (p) { def[p.name] = p.default == null ? '' : String(p.default); });
        return (steps || []).map(function (st) {
            var o = {}; Object.keys(st).forEach(function (k) {
                var v = st[k]; if (typeof v === 'string') v = v.replace(/\{\{([^{}@]+)(@u)?\}\}/g, function (m, n, u) { return n in def ? (u ? encodeURIComponent(def[n]) : def[n]) : m; });
                o[k] = v;
            }); return o;
        });
    }
    function detect(steps, goal) {
        var out = [], g = String(goal || '').toLowerCase();
        steps.forEach(function (st, i) {
            var push = function (field, value, label) {
                value = String(value == null ? '' : value).trim(); if (value.length < 1) return;
                if (out.some(function (c) { return c.value === value && c.step === i && c.field === field; })) return;
                out.push({ step: i, field: field, value: value, label: label, kind: kindOf(value), goalHit: value.length >= 2 && g.indexOf(value.toLowerCase()) >= 0 });
            };
            if (st.type === 'text') push('text', st.text, '輸入文字');
            else if (st.type === 'open_url') {
                try {
                    var u = new URL(st.url); u.searchParams.forEach(function (v, k) { if (v && v.length < 80 && !/^(hl|gl|ie|oe|source|sa|ved|client|sclient|authuser)$/i.test(k)) push('url', v, '網址參數 ' + k); });
                } catch (e) { /* 不是合法網址就略過 */ }
            } else if (st.type === 'tap_el') {
                var t = st.text || ''; if (t && t.length >= 2 && !COMMON_UI.test(t)) push('text', t, '點選的項目');
            }
        });
        out.sort(function (a, b) { return (b.goalHit - a.goalHit) || ((b.kind !== '文字') - (a.kind !== '文字')); });
        return out;
    }
    function suggestName(c, i) { var base = c.kind === '日期' ? 'date' : c.kind === '時間' ? 'time' : c.kind === '數字' ? 'number' : c.kind === '網址' ? 'url' : (c.label.indexOf('點選') >= 0 ? 'item' : 'text'); return base + (i ? i : ''); }
    function applyParamsToSteps(raw, chosen) {   // chosen: [{name, value, cands:[{step,field}]}] → 新 steps
        var steps = JSON.parse(JSON.stringify(raw));
        chosen.forEach(function (p) {
            p.cands.forEach(function (c) {
                var st = steps[c.step]; if (!st) return;
                if (c.field === 'url') { var enc = encodeURIComponent(p.value); var url = String(st.url); if (url.indexOf(enc) >= 0) st.url = url.split(enc).join('{{' + p.name + '@u}}'); else if (url.indexOf(p.value) >= 0) st.url = url.split(p.value).join('{{' + p.name + '@u}}'); }
                else if (c.field === 'text') {
                    if (st.type === 'tap_el') { if (st.text === p.value) st.text = '{{' + p.name + '}}'; }
                    else st.text = String(st.text).split(p.value).join('{{' + p.name + '}}');
                }
            });
        });
        return steps;
    }

    // 參數編輯器（entry 是技能；回傳後存檔）
    async function openParams(name, preset) {
        var e = S().get(name); if (!e || e.type !== 'replay') { toast('只有「可重播」技能可以設定參數'); return; }
        var raw = unparam(e.steps, e.params), cands = detect(raw, e.goal), existing = (e.params || []).slice();
        // 已存在的參數 → 對應的候選（用預設值比對）
        var rows = cands.map(function (c, i) {
            var ex = existing.find(function (p) { return String(p.default) === c.value; });
            return { c: c, on: !!ex || (!existing.length && c.goalHit), name: ex ? ex.name : '', label: ex ? ex.label : '', type: ex ? ex.type : (c.kind === '數字' ? 'number' : c.kind === '日期' ? 'date' : 'text'), choices: ex ? (ex.choices || '') : '' };
        });
        if (preset) preset.forEach(function (idx) { if (rows[idx]) rows[idx].on = true; });
        var o = overlay('🧩 參數：' + name, 9300);
        o.body.appendChild(mk('div', CSS.muted + 'margin-bottom:8px;', '勾選「每次執行可能不同」的值（例如搜尋字、要點的人名、日期）。執行時會跳出表單讓你填，不用重新教 AI。目標：' + (e.goal || '')));
        var list = mk('div'); o.body.appendChild(list);
        function draw() {
            list.textContent = '';
            if (!rows.length) list.appendChild(mk('div', CSS.muted, '這個技能的步驟裡沒有偵測到可參數化的值（輸入文字／網址搜尋字／點選的項目）。'));
            rows.forEach(function (r, i) {
                var card = mk('div', CSS.card), top = mk('label', 'display:flex;gap:8px;align-items:flex-start;min-height:40px;');
                var cb = mk('input'); cb.type = 'checkbox'; cb.checked = r.on; cb.style.cssText = 'width:20px;height:20px;margin-top:2px;flex:none;';
                cb.onchange = function () { r.on = cb.checked; if (r.on && !r.name) r.name = suggestName(r.c, rows.filter(function (x) { return x.on && x !== r && x.name && x.name.indexOf(suggestName(r.c, 0)) === 0; }).length); draw(); };
                var tx = mk('div', 'flex:1;min-width:0;'); tx.appendChild(mk('div', 'font-size:14px;word-break:break-all;', r.c.value));
                tx.appendChild(mk('div', CSS.muted, '第 ' + (r.c.step + 1) + ' 步・' + r.c.label + '・' + r.c.kind + (r.c.goalHit ? '・與任務目標吻合' : '')));
                top.append(cb, tx); card.appendChild(top);
                if (r.on) {
                    var g = mk('div', 'display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;');
                    var nm = mk('input', CSS.fld); nm.placeholder = '參數名稱（英文）'; nm.value = r.name || ''; nm.oninput = function () { r.name = nm.value.replace(/[^a-zA-Z0-9_]/g, ''); };
                    var lb = mk('input', CSS.fld); lb.placeholder = '顯示名稱（例：收件人）'; lb.value = r.label || ''; lb.oninput = function () { r.label = lb.value; };
                    var ty = mk('select', CSS.fld); [['text', '文字'], ['number', '數字'], ['date', '日期'], ['choice', '選項']].forEach(function (x) { ty.appendChild(new Option(x[1], x[0])); }); ty.value = r.type; ty.onchange = function () { r.type = ty.value; draw(); };
                    g.append(nm, lb, ty); card.appendChild(g);
                    if (r.type === 'choice') { var ch = mk('input', CSS.fld + 'margin-top:8px;'); ch.placeholder = '選項（用逗號分隔）'; ch.value = r.choices; ch.oninput = function () { r.choices = ch.value; }; card.appendChild(ch); }
                }
                list.appendChild(card);
            });
        }
        draw();
        var aiBtn = btn('🤖 請 AI 建議', CSS.btn, async function () {
            aiBtn.disabled = true; aiBtn.textContent = '分析中…';
            try {
                var r = await llm('手機自動化技能：目標「' + (e.goal || '') + '」。下列是步驟中出現的值，請判斷每個值「下次執行時是否可能不同（應該變成參數）」。\n' + rows.map(function (x, i) { return i + ': ' + JSON.stringify(x.c.value) + '（' + x.c.label + '）'; }).join('\n') + '\n只回 JSON：{"params":[{"i":索引,"name":"英文參數名","label":"中文顯示名"}]}', true);
                (r.params || []).forEach(function (p) { var row = rows[p.i]; if (row) { row.on = true; row.name = String(p.name || '').replace(/[^a-zA-Z0-9_]/g, '') || row.name; row.label = p.label || row.label; } });
                draw(); toast('AI 已建議（可自行調整）');
            } catch (er) { toast('❌ AI 建議失敗：' + er.message, 4000); }
            aiBtn.disabled = false; aiBtn.textContent = '🤖 請 AI 建議';
        });
        var tools = mk('div', 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;'); tools.appendChild(aiBtn);
        if (W.NovaJev && W.NovaJev.isOn && W.NovaJev.isOn('params') && W.NovaJev.suggestParams) {
            var jb = btn('⚡ Jev 建議', CSS.btn, async function () {
                jb.disabled = true;
                try { var res = await W.NovaJev.suggestParams(rows.map(function (x) { return x.c; }), e.goal); (res || []).forEach(function (on, i) { if (rows[i] && on !== null) { rows[i].on = !!on; if (on && !rows[i].name) rows[i].name = suggestName(rows[i].c, i); } }); draw(); toast('⚡ Jev 已建議'); } catch (er) { toast('Jev 建議失敗：' + er.message); }
                jb.disabled = false;
            }); tools.appendChild(jb);
        }
        o.body.insertBefore(tools, list);
        o.foot.append(btn('取消', CSS.btn, o.close), btn('儲存參數', CSS.btnP + 'flex:1;', async function () {
            var on = rows.filter(function (r) { return r.on; }), names = {};
            for (var i = 0; i < on.length; i++) {
                var r = on[i]; if (!r.name || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(r.name)) { toast('每個勾選的參數都要有英文名稱（不能以數字開頭）'); return; }
                if (names[r.name] && names[r.name].c.value !== r.c.value) { toast('參數名稱「' + r.name + '」重複了'); return; } names[r.name] = r;
            }
            // 同名同值 → 合併成一個參數（多個出現處）
            var byName = {}; on.forEach(function (r) { var p = byName[r.name] || (byName[r.name] = { name: r.name, value: r.c.value, label: r.label, type: r.type, choices: r.choices, cands: [] }); p.cands.push({ step: r.c.step, field: r.c.field }); });
            var chosen = Object.keys(byName).map(function (k) { return byName[k]; });
            var newSteps = applyParamsToSteps(raw, chosen);
            var params = chosen.map(function (p) { var o2 = { name: p.name, label: p.label || p.name, type: p.type, default: p.value }; if (p.type === 'choice') o2.choices = String(p.choices || '').split(/[,，]/).map(function (x) { return x.trim(); }).filter(Boolean); return o2; });
            try {
                await S().saveSkill(name, 'replay', { description: e.description, goal: e.goal, createdAt: e.createdAt, params: params, partial: e.partial, partialInfo: e.partialInfo }, '', newSteps);
                toast('✅ 已儲存 ' + params.length + ' 個參數'); o.close(); refreshMgr();
            } catch (er) { toast('❌ 儲存失敗：' + er.message, 4000); }
        }));
    }

    // 執行前的參數表單 → Promise<values|null>
    function askValues(entry, goalText) {
        var params = entry.params || []; if (!params.length) return Promise.resolve({});
        return new Promise(function (resolve) {
            var o = overlay('▶ 執行：' + entry.name, 9400), inputs = {}, last = entry.lastValues || {}, done = false;
            o.onClose = function () { if (!done) { done = true; resolve(null); } };
            o.body.appendChild(mk('div', CSS.muted, '目標：' + (entry.goal || entry.description || '')));
            var aiRow = mk('div', 'margin-top:8px;display:flex;gap:8px;'); var aiIn = mk('input', CSS.fld + 'flex:1;'); aiIn.placeholder = '用一句話描述這次要做什麼，讓 AI 幫你填';
            aiIn.value = goalText || ''; var aiB = btn('🤖 填入', CSS.btn, async function () {
                if (!aiIn.value.trim()) return; aiB.disabled = true;
                try {
                    var r = await llm('技能目標：「' + entry.goal + '」。參數定義：' + JSON.stringify(params.map(function (p) { return { name: p.name, label: p.label, type: p.type, default: p.default, choices: p.choices }; })) + '。使用者這次的需求：「' + aiIn.value + '」。請推出每個參數這次該填的值，推不出的用預設值。只回 JSON 物件：{參數名: 值}', true);
                    Object.keys(r).forEach(function (k) { if (inputs[k]) inputs[k].value = r[k]; }); toast('已填入，請確認');
                } catch (er) { toast('❌ AI 填入失敗：' + er.message, 4000); }
                aiB.disabled = false;
            }); aiRow.append(aiIn, aiB); o.body.appendChild(aiRow);
            params.forEach(function (p) {
                o.body.appendChild(lab(p.label || p.name, p.name));
                var el;
                if (p.type === 'choice') { el = mk('select', CSS.fld); (p.choices || []).forEach(function (c) { el.appendChild(new Option(c, c)); }); }
                else { el = mk('input', CSS.fld); el.type = p.type === 'number' ? 'text' : (p.type === 'date' ? 'date' : 'text'); if (p.type === 'number') el.inputMode = 'decimal'; }
                el.value = (p.name in last) ? last[p.name] : (p.default == null ? '' : p.default); inputs[p.name] = el; o.body.appendChild(el);
            });
            o.foot.append(btn('取消', CSS.btn, o.close), btn('▶ 開始', CSS.btnP + 'flex:1;', function () {
                var v = {}; params.forEach(function (p) { v[p.name] = inputs[p.name].value; }); done = true; o.close(); resolve(v);
            }));
        });
    }

    // ═══════════════ 執行 ═══════════════
    async function runSkill(name, goalText) {
        var e = S().get(name); if (!e) { toast('找不到技能：' + name); return; }
        if (e.type === 'replay') {
            if (e.partial) { showPartial(name); return; }
            var values = await askValues(e, goalText); if (values === null) return;
            closeMgr();
            if (Object.keys(values).length) { try { await S().setLastValues(name, values); } catch (er) { /* ignore */ } }
            await W.novaAutoTask.replay(e, values, {}); return;
        }
        if (e.type === 'prompt' || e.type === 'imported') {
            closeMgr();
            if (e.execMode === 'autonomous') { W.novaAutoTask.run(e.goal, { noSkill: true }); return; }
            var inp = $('user-input'); if (inp) { inp.value = e.goal; if (typeof W.autoResizeInput === 'function') W.autoResizeInput(inp); if (typeof W.updateSmartActionBtn === 'function') W.updateSmartActionBtn(); inp.focus(); toast('已把提示範本放進輸入框，確認後送出'); }
            return;
        }
        if (e.type === 'flow') { closeMgr(); try { var r = await S().run(name, {}); toast('✅ 流程完成：' + (r.ran || []).length + ' 項'); } catch (er) { toast('❌ ' + er.message, 5000); } return; }
        try { var rr = await S().run(name, {}); toast('✅ 技能已執行' + (rr !== undefined ? '：' + String(typeof rr === 'string' ? rr : JSON.stringify(rr)).slice(0, 80) : '')); } catch (er2) { toast('❌ ' + er2.message, 5000); }
    }

    // ═══════════════ 管理頁 ═══════════════
    var mgr = null, mgrTab = 'all', mgrQ = '';
    var TYPE_LABEL = { replay: '可重播', prompt: '提示範本', imported: '匯入文件', flow: '組裝流程', script: '腳本' };
    function closeMgr() { if (mgr) { mgr.close(); mgr = null; } }
    function refreshMgr() { if (mgr) drawMgr(); renderSettings(); }
    function open() {
        if (mgr) return; mgr = overlay('🧰 技能'); mgr.onClose = function () { mgr = null; };
        var bar = mk('div', 'padding:10px 14px 0;flex:0 0 auto;');
        var sr = mk('input', CSS.fld); sr.placeholder = '搜尋技能名稱或說明…'; sr.value = mgrQ; sr.oninput = function () { mgrQ = sr.value; drawMgr(); };
        var tabs = mk('div', 'display:flex;gap:6px;overflow-x:auto;padding:8px 0 4px;scrollbar-width:none;'); tabs.id = 'nsk-tabs';
        bar.append(sr, tabs); mgr.root.insertBefore(bar, mgr.body);
        var more = btn('＋', 'background:transparent;border:1px solid var(--nv-line-strong,#334155);color:var(--nv-text,#e2e8f0);border-radius:9px;min-width:40px;min-height:40px;font-size:20px;', function () { plusMenu(); });
        mgr.head.insertBefore(more, mgr.head.lastChild);
        mgr.foot.style.display = 'none';
        S().load().then(function () { drawMgr(); });
        drawMgr();
    }
    function plusMenu() {
        askChoice('新增／管理', [
            ['新增提示範本', function () { newPrompt(); }],
            ['新增組裝流程（依序執行多個技能）', function () { newFlow(); }],
            ['把最近一次自主任務存成技能', function () { saveLastRun(); }],
            ['匯出全部技能（JSON）', function () { exportSkills(); }],
            ['匯入技能（JSON）', function () { importSkills(); }],
            ['修復索引（找回有檔案但沒登記的技能）', async function () { var n = await S().repairIndex(); toast(n ? '已找回 ' + n + ' 個技能' : '沒有需要修復的項目'); refreshMgr(); }],
            ['重新載入', async function () { await S().load(); refreshMgr(); toast('已重新載入'); }]
        ]);
    }
    function askChoice(title, items) {
        var o = overlay(title, 9500); items.forEach(function (it) { var b = btn(it[0], CSS.btn + 'display:block;width:100%;text-align:left;margin-bottom:8px;min-height:46px;font-size:14px;', function () { o.close(); it[1](); }); o.body.appendChild(b); });
        o.foot.appendChild(btn('取消', CSS.btn + 'flex:1;', o.close));
    }
    function drawMgr() {
        if (!mgr) return; var all = S().getManifest();
        var tabsEl = $('nsk-tabs'); if (tabsEl) {
            tabsEl.textContent = '';
            [['all', '全部'], ['replay', '可重播'], ['prompt', '提示範本'], ['flow', '組裝流程'], ['script', '腳本'], ['partial', '半成品']].forEach(function (t) {
                var cnt = all.filter(function (s) { return matchTab(s, t[0]); }).length;
                var b = btn(t[1] + (cnt ? ' ' + cnt : ''), 'flex:0 0 auto;white-space:nowrap;min-height:34px;padding:0 13px;border-radius:999px;font-size:13px;cursor:pointer;border:1px solid ' + (mgrTab === t[0] ? 'var(--nv-accent,#3b82f6)' : 'var(--nv-line,#1e293b)') + ';background:' + (mgrTab === t[0] ? 'var(--nv-active,rgba(148,163,184,.17))' : 'transparent') + ';color:' + (mgrTab === t[0] ? 'var(--nv-text,#e2e8f0)' : 'var(--nv-muted,#94a3b8)') + ';', function () { mgrTab = t[0]; drawMgr(); });
                tabsEl.appendChild(b);
            });
        }
        var b = mgr.body; b.textContent = '';
        var lr = W.novaAutoTask && W.novaAutoTask.getLastRun && W.novaAutoTask.getLastRun();
        if (lr && lr.steps && lr.steps.length && !lr.saved) {
            var c = mk('div', CSS.card + 'border-color:var(--nv-accent,#3b82f6);'); c.appendChild(mk('div', 'font-size:13px;font-weight:600;', '最近一次自主任務（' + (lr.status === 'done' ? '已完成' : '未完成') + '，' + lr.steps.length + ' 步）'));
            c.appendChild(mk('div', CSS.muted + 'margin:4px 0 8px;', lr.goal)); c.appendChild(btn(lr.status === 'done' ? '💾 存成技能' : '📎 存成半成品', CSS.btnP + 'min-height:38px;font-size:13px;', function () { saveLastRun(); })); b.appendChild(c);
        }
        var q = mgrQ.trim().toLowerCase();
        var list = all.filter(function (s) { return matchTab(s, mgrTab) && (!q || (s.name + ' ' + s.description + ' ' + (s.goal || '')).toLowerCase().indexOf(q) >= 0); });
        if (!list.length) { b.appendChild(mk('div', CSS.muted + 'text-align:center;padding:40px 10px;line-height:1.8;', S().getLastError() ? '⚠️ ' + S().getLastError() : (all.length ? '沒有符合的技能' : '還沒有任何技能。\n用 /ap 讓 AI 完成一件事，成功後點「💾 存成技能」就會出現在這裡。'))); b.lastChild.style.whiteSpace = 'pre-line'; return; }
        list.forEach(function (s) { b.appendChild(skillCard(s)); });
    }
    function matchTab(s, t) { return t === 'all' ? true : t === 'partial' ? !!s.partial : t === 'prompt' ? (s.type === 'prompt' || s.type === 'imported') : (s.type === t && !s.partial); }
    function skillCard(s) {
        var c = mk('div', CSS.card);
        var top = mk('div', 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;');
        top.appendChild(mk('b', 'font-size:14px;font-family:ui-monospace,Menlo,monospace;color:var(--nv-accent-text,#60a5fa);word-break:break-all;', s.name));
        top.appendChild(mk('span', CSS.chip, s.partial ? '半成品' : TYPE_LABEL[s.type] || s.type));
        if (s.type === 'replay') top.appendChild(mk('span', CSS.chip, s.steps.length + ' 步'));
        if (s.params && s.params.length) top.appendChild(mk('span', CSS.chip + 'color:var(--nv-accent-text,#60a5fa);', '🧩 ' + s.params.length + ' 參數'));
        if (s.type === 'flow') top.appendChild(mk('span', CSS.chip, s.steps.length + ' 項'));
        c.appendChild(top);
        var desc = s.description || s.goal || ''; if (desc) c.appendChild(mk('div', CSS.muted + 'margin:4px 0 8px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;', desc));
        var row = mk('div', 'display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;');
        row.appendChild(btn(s.partial ? '👁 檢視' : '▶ 執行', CSS.btnP + 'min-height:36px;font-size:13px;padding:0 14px;', function () { runSkill(s.name); }));
        if (s.type === 'replay' && !s.partial) row.appendChild(btn('🧩 參數', CSS.btn, function () { openParams(s.name); }));
        row.appendChild(btn('✏️ 編輯', CSS.btn, function () { editSkill(s.name); }));
        row.appendChild(btn('⧉ 複製', CSS.btn, function () { cloneSkill(s.name); }));
        row.appendChild(btn('🏷 改名', CSS.btn, function () { renameFlow(s.name); }));
        row.appendChild(btn('🗑', CSS.btn + 'color:var(--nv-danger,#ef4444);', async function () { if (await W.showConfirm('確定刪除技能「' + s.name + '」？無法復原。')) { try { await S().deleteSkill(s.name); toast('已刪除'); refreshMgr(); } catch (er) { toast('❌ ' + er.message, 4000); } } }));
        c.appendChild(row); return c;
    }
    async function renameFlow(name) {
        var v = await ask('改名：' + name, [{ key: 'n', label: '新名稱', value: name, hint: '英文字母／數字／底線，不能以數字開頭' }], '改名'); if (!v) return;
        try { await S().renameSkill(name, v.n.trim()); toast('✅ 已改名'); refreshMgr(); } catch (er) { toast('❌ ' + er.message, 4000); }
    }
    async function newPrompt() {
        var v = await ask('新增提示範本', [{ key: 'name', label: '名稱', hint: '英文字母／數字／底線' }, { key: 'desc', label: '說明' }, { key: 'mode', label: '執行方式', type: 'select', options: [['general', '一般對話（放進輸入框）'], ['autonomous', 'AI 自主任務（/ap）']] }, { key: 'body', label: '提示內容', type: 'area' }], '建立'); if (!v) return;
        try { await S().saveSkill(v.name.trim(), 'prompt', { description: v.desc, execMode: v.mode }, v.body); toast('✅ 已建立'); refreshMgr(); } catch (er) { toast('❌ ' + er.message, 4000); }
    }
    async function newFlow() {
        var skills = S().getManifest().filter(function (s) { return !s.partial && s.type !== 'flow'; });
        if (!skills.length) { toast('先要有至少一個技能才能組裝流程'); return; }
        var v = await ask('新增組裝流程', [{ key: 'name', label: '名稱' }, { key: 'desc', label: '說明' }, { key: 'order', label: '依序執行的技能', type: 'area', value: '', hint: '一行一個技能名稱，由上往下執行' + '\n可用：' + skills.map(function (s) { return s.name; }).join('、') }], '建立'); if (!v) return;
        var names = v.order.split(/[\n,，]/).map(function (x) { return x.trim(); }).filter(Boolean);
        var bad = names.filter(function (n) { return !S().get(n); }); if (bad.length) { toast('找不到技能：' + bad.join('、'), 4500); return; }
        try { await S().saveSkill(v.name.trim(), 'flow', { description: v.desc }, '', names.map(function (n) { return { blockKind: 'skill', skillName: n, mode: 'prompt' }; })); toast('✅ 已建立流程'); refreshMgr(); } catch (er) { toast('❌ ' + er.message, 4000); }
    }
    async function exportSkills() {
        try {
            var data = await S().exportAll(), text = JSON.stringify(data, null, 2);
            var fn = 'NOVA_skills_' + new Date().toISOString().slice(0, 10) + '.json';
            var CapFS = W.Capacitor && W.Capacitor.Plugins && W.Capacitor.Plugins.Filesystem;
            if (CapFS) { await CapFS.writeFile({ path: 'NOVA/' + fn, data: text, directory: 'DOCUMENTS', recursive: true, encoding: 'utf8' }); toast('✅ 已匯出到 Documents/NOVA/' + fn + '（' + data.skills.length + ' 個技能）', 4500); }
        } catch (er) { toast('❌ 匯出失敗：' + er.message, 4000); }
    }
    function importSkills() {
        var f = mk('input'); f.type = 'file'; f.accept = '.json,application/json';
        f.onchange = async function () {
            if (!f.files[0]) return;
            try { var d = JSON.parse(await f.files[0].text()); var n = await S().importAll(d, { overwrite: false }); toast('✅ 已匯入 ' + n + ' 個技能（同名的略過）', 4000); refreshMgr(); } catch (er) { toast('❌ 匯入失敗：' + er.message, 4000); }
        }; f.click();
    }

    // ═══════════════ 複製／編輯 ═══════════════
    async function cloneSkill(name) {
        var e = S().get(name); if (!e) return;
        var v = await ask('複製：' + name, [{ key: 'n', label: '份數', value: '1', type: 'number', hint: '最多 20 份' }], '下一步'); if (!v) return;
        var n = Math.max(1, Math.min(20, parseInt(v.n, 10) || 1));
        var names = [], used = {}; S().getManifest().forEach(function (s) { used[s.name] = 1; });
        for (var i = 0; i < n; i++) { var base = n === 1 ? name + '_copy' : name + '_copy' + (i + 1), nm = base, k = 2; while (used[nm]) nm = base + '_' + (k++); used[nm] = 1; names.push(nm); }
        var fields = names.map(function (nm, i) { return { key: 'n' + i, label: '第 ' + (i + 1) + ' 份名稱', value: nm }; });
        var v2 = await ask('確認複製名稱', fields, '建立'); if (!v2) return;
        var made = [];
        for (var j = 0; j < n; j++) {
            var nn = v2['n' + j].trim();
            try {
                var meta = { description: e.description, goal: e.goal, params: e.params ? JSON.parse(JSON.stringify(e.params)) : undefined, partial: e.partial, partialInfo: e.partialInfo, execMode: e.execMode, parameters: e.parameters };
                var payload = e.type === 'script' ? null : JSON.parse(JSON.stringify(e.steps || []));
                if (e.type === 'script') { var CapFS = W.Capacitor.Plugins.Filesystem; payload = (await CapFS.readFile({ path: 'NovaSkills/' + e.name + '.js', directory: 'DOCUMENTS', encoding: 'utf8' })).data; }
                await S().saveSkill(nn, e.type, meta, (e.type === 'prompt' || e.type === 'imported') ? e.goal : '', payload); made.push(nn);
            } catch (er) { toast('❌ ' + nn + '：' + er.message, 4500); }
        }
        toast('✅ 已複製 ' + made.length + ' 份'); refreshMgr(); if (made.length === 1) editSkill(made[0]);
    }

    function editSkill(name) {
        var e = S().get(name); if (!e) return;
        var o = overlay('✏️ 編輯：' + name, 9400);
        var desc = mk('textarea', CSS.fld + 'min-height:64px;'); desc.value = e.description || '';
        o.body.append(lab('說明'), desc);
        var goal, mode, steps = e.steps ? JSON.parse(JSON.stringify(e.steps)) : null, list;
        if (e.type === 'replay') { goal = mk('textarea', CSS.fld + 'min-height:64px;'); goal.value = e.goal || ''; o.body.append(lab('目標文字', '重新判讀／比對技能時 AI 看的任務描述'), goal); }
        if (e.type === 'prompt' || e.type === 'imported') {
            mode = mk('select', CSS.fld); [['general', '一般對話'], ['autonomous', 'AI 自主任務']].forEach(function (x) { mode.appendChild(new Option(x[1], x[0])); }); mode.value = e.execMode || 'general';
            goal = mk('textarea', CSS.fld + 'min-height:200px;'); goal.value = e.goal || ''; o.body.append(lab('執行方式'), mode, lab('內容'), goal);
        }
        if (e.type === 'script') {
            var CapFS = W.Capacitor.Plugins.Filesystem; goal = mk('textarea', CSS.fld + 'min-height:260px;font-family:ui-monospace,Menlo,monospace;font-size:13px;'); goal.value = '載入中…';
            CapFS.readFile({ path: 'NovaSkills/' + name + '.js', directory: 'DOCUMENTS', encoding: 'utf8' }).then(function (r) { goal.value = r.data; }); o.body.append(lab('程式碼', '⚠️ 等同執行任意程式碼'), goal);
        }
        if (steps) {
            o.body.appendChild(lab(e.type === 'flow' ? '流程項目' : '步驟', '每步是一段 JSON；點標題展開'));
            list = mk('div'); o.body.appendChild(list);
            var draw = function () {
                list.textContent = '';
                steps.forEach(function (st, i) {
                    var c = mk('div', CSS.card + 'padding:8px;'), h = mk('div', 'display:flex;align-items:center;gap:6px;');
                    var title = mk('div', 'flex:1;min-width:0;font-size:13px;cursor:pointer;word-break:break-all;', (i + 1) + '. ' + (st.blockKind === 'skill' ? '[技能] ' + st.skillName : S().stepOutline(st)));
                    var ta = mk('textarea', CSS.fld + 'display:none;margin-top:6px;min-height:110px;font-family:ui-monospace,Menlo,monospace;font-size:12px;'); ta.value = JSON.stringify(st, null, 2);
                    ta.onchange = function () { try { steps[i] = JSON.parse(ta.value); ta.style.borderColor = ''; title.textContent = (i + 1) + '. ' + (steps[i].blockKind === 'skill' ? '[技能] ' + steps[i].skillName : S().stepOutline(steps[i])); } catch (er) { ta.style.borderColor = 'var(--nv-danger,#ef4444)'; toast('JSON 格式不對：' + er.message); } };
                    title.onclick = function () { ta.style.display = ta.style.display === 'none' ? 'block' : 'none'; };
                    var sm = 'min-width:34px;min-height:34px;padding:0;';
                    h.append(title, btn('↑', CSS.btn + sm, function () { if (i > 0) { var t = steps[i - 1]; steps[i - 1] = steps[i]; steps[i] = t; draw(); } }), btn('↓', CSS.btn + sm, function () { if (i < steps.length - 1) { var t = steps[i + 1]; steps[i + 1] = steps[i]; steps[i] = t; draw(); } }), btn('⧉', CSS.btn + sm, function () { steps.splice(i + 1, 0, JSON.parse(JSON.stringify(steps[i]))); draw(); }), btn('🗑', CSS.btn + sm, function () { steps.splice(i, 1); draw(); }));
                    c.append(h, ta); list.appendChild(c);
                });
                var add = btn('＋ 新增步驟', CSS.btn + 'width:100%;', function () {
                    var tpl = { tap_el: { type: 'tap_el', text: '按鈕文字' }, tap: { type: 'tap', x: 0.5, y: 0.5 }, swipe: { type: 'swipe', x1: 0.5, y1: 0.75, x2: 0.5, y2: 0.25, duration_ms: 300 }, text: { type: 'text', text: '要輸入的文字' }, key: { type: 'key', key: 'back' }, open_app: { type: 'open_app', package: 'com.android.settings' }, open_url: { type: 'open_url', url: 'https://' }, wait: { type: 'wait', ms: 1500 } };
                    askChoice('新增哪種步驟？', Object.keys(tpl).map(function (k) { return [S().stepOutline(tpl[k]) + '（' + k + '）', function () { steps.push(JSON.parse(JSON.stringify(tpl[k]))); draw(); }]; }));
                });
                if (e.type !== 'flow') list.appendChild(add);
            }; draw();
        }
        o.foot.append(btn('取消', CSS.btn, o.close), btn('儲存', CSS.btnP + 'flex:1;', async function () {
            try {
                var meta = { description: desc.value.trim(), createdAt: e.createdAt, goal: e.type === 'replay' ? goal.value.trim() : undefined, params: e.params, partial: e.partial, partialInfo: e.partialInfo, execMode: mode ? mode.value : e.execMode, parameters: e.parameters };
                if (e.type === 'replay' && e.params) {   // 提醒：參數佔位符在所有步驟裡都找不到了
                    var all = JSON.stringify(steps); var miss = e.params.filter(function (p) { return all.indexOf('{{' + p.name + '}}') < 0 && all.indexOf('{{' + p.name + '@u}}') < 0; });
                    if (miss.length && !(await W.showConfirm('參數 ' + miss.map(function (p) { return p.name; }).join('、') + ' 在步驟裡找不到佔位符了，照存嗎？'))) return;
                }
                var payload = e.type === 'script' ? goal.value : steps;
                await S().saveSkill(name, e.type, meta, (e.type === 'prompt' || e.type === 'imported') ? goal.value : '', payload);
                toast('✅ 已儲存'); o.close(); refreshMgr();
            } catch (er) { toast('❌ 儲存失敗：' + er.message, 5000); }
        }));
    }

    // ═══════════════ 任務結束：存成技能／半成品 ═══════════════
    function onTaskEnd(run) {
        if (!run || !run.steps || !run.steps.length) return;
        if (run.status === 'done' && opt.offerSave()) {
            banner('✅ 任務完成（' + run.steps.length + ' 步）。要把這次的操作存成技能嗎？下次可以直接重播，不用再讓 AI 一步步判斷。', [['💾 存成技能', function () { saveLastRun(); }, true], ['略過']]);
        } else if (run.status !== 'done' && run.steps.length >= 2 && opt.offerPartial()) {
            banner('任務沒有完成（已做對 ' + run.steps.length + ' 步）。可以把做對的部分存成「半成品技能」，下次 AI 規劃時會當參考避開失敗點。', [['📎 存成半成品', function () { saveLastRun(); }, true], ['略過']]);
        }
    }
    async function suggestSkillName(goal) {
        try { var t = await llm('把這個手機任務取一個英文 snake_case 技能名稱（小寫字母／數字／底線、以字母開頭、不超過 30 字元），只回名稱本身：「' + goal + '」'); t = t.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+|_+$/g, '').toLowerCase().slice(0, 30); if (/^[a-z]/.test(t)) return t; } catch (e) { /* 用預設 */ }
        return 'skill_' + new Date().toISOString().slice(5, 16).replace(/[-:T]/g, '');
    }
    async function saveLastRun() {
        var lr = W.novaAutoTask && W.novaAutoTask.getLastRun && W.novaAutoTask.getLastRun();
        if (!lr || !lr.steps || !lr.steps.length) { toast('沒有可存的自主任務紀錄（先用 /ap 執行一次）'); return; }
        var partial = lr.status !== 'done';
        var nm = await suggestSkillName(lr.goal); while (S().get(nm)) nm += '_2';
        var o = overlay(partial ? '📎 存成半成品技能' : '💾 存成技能', 9400), keep = lr.steps.map(function () { return true; });
        o.body.appendChild(lab('名稱', '英文字母／數字／底線'));
        var nIn = mk('input', CSS.fld); nIn.value = nm; o.body.appendChild(nIn);
        o.body.appendChild(lab('說明')); var dIn = mk('textarea', CSS.fld + 'min-height:60px;'); dIn.value = lr.goal; o.body.appendChild(dIn);
        var note, pit;
        if (partial) {
            var last = (lr.history || []).slice(-1)[0];
            o.body.appendChild(lab('失敗位置／你的備註', '會一起存起來')); note = mk('textarea', CSS.fld + 'min-height:60px;'); note.value = last ? '最後一步：' + (last.say || last.action || '') + '→' + last.result : ''; o.body.appendChild(note);
            o.body.appendChild(lab('避坑筆記', '給之後的 AI 規劃參考')); pit = mk('textarea', CSS.fld + 'min-height:70px;'); o.body.appendChild(pit);
            var ai = btn('🤖 請 AI 整理避坑筆記', CSS.btn + 'margin-top:6px;', async function () {
                ai.disabled = true; ai.textContent = '整理中…';
                try { pit.value = await llm('手機自動化任務「' + lr.goal + '」沒有完成。已成功的步驟：\n' + S().outline(lr.steps) + '\n最近的紀錄：' + JSON.stringify(lr.history || []) + '\n請用繁體中文寫 3～5 行「避坑筆記」：哪裡卡住、可能原因、下次該怎麼避開。'); } catch (er) { toast('❌ ' + er.message, 4000); }
                ai.disabled = false; ai.textContent = '🤖 請 AI 整理避坑筆記';
            }); o.body.appendChild(ai);
        }
        o.body.appendChild(lab('要保留的步驟', '取消勾選冗餘或試探性的步驟'));
        var jevBox = null;
        lr.steps.forEach(function (st, i) {
            var l = mk('label', 'display:flex;gap:8px;align-items:center;min-height:38px;font-size:13px;'); var cb = mk('input'); cb.type = 'checkbox'; cb.checked = true; cb.style.cssText = 'width:20px;height:20px;flex:none;'; cb.onchange = function () { keep[i] = cb.checked; };
            l.append(cb, mk('span', 'min-width:0;word-break:break-all;', (i + 1) + '. ' + S().stepOutline(st) + (st.say ? '　— ' + st.say : ''))); o.body.appendChild(l);
        });
        if (partial && W.NovaJev && W.NovaJev.isOn && W.NovaJev.isOn('partial') && W.NovaJev.suggestDrop) {
            var jd = btn('⚡ Jev 建議取消冗餘步驟', CSS.btn + 'margin-top:6px;', async function () {
                jd.disabled = true; jd.textContent = 'Jev 判斷中…';
                try {
                    var drop = await W.NovaJev.suggestDrop(lr.goal, lr.steps.map(function (s) { return { label: S().stepOutline(s), outcome: s.say || '' }; }));
                    if (drop && drop.length) { var cbs = o.body.querySelectorAll('input[type=checkbox]'); var base = cbs.length - lr.steps.length; drop.forEach(function (i) { if (cbs[base + i]) { cbs[base + i].checked = false; cbs[base + i].onchange && cbs[base + i].onchange(); } }); toast('⚡ Jev 建議取消 ' + drop.length + ' 步'); }
                    else toast(drop ? '⚡ Jev 認為這些步驟都值得保留' : 'Jev 沒有回應（照原樣）');
                } catch (er) { toast('Jev 失敗：' + er.message); }
                jd.disabled = false; jd.textContent = '⚡ Jev 建議取消冗餘步驟';
            }); o.body.appendChild(jd);
        }
        o.foot.append(btn('取消', CSS.btn, o.close), btn('儲存', CSS.btnP + 'flex:1;', async function () {
            var steps = lr.steps.filter(function (s, i) { return keep[i]; }); if (!steps.length && !partial) { toast('至少保留一個步驟'); return; }
            var name = nIn.value.trim(); if (S().get(name)) { toast('已有同名技能，請換名稱'); return; }
            try {
                await S().saveSkill(name, 'replay', { description: dIn.value.trim(), goal: lr.goal, partial: partial || undefined, partialInfo: partial ? { note: note.value, pitfalls: pit.value, steps: lr.steps.length, at: Date.now(), history: lr.history } : undefined }, '', steps);
                lr.saved = true; o.close(); refreshMgr(); var b = $('nova-skill-banner'); if (b) b.remove();
                toast('✅ 已存成技能「' + name + '」');
                if (!partial && detect(steps, lr.goal).length && (await W.showConfirm('要現在設定參數嗎？\n（例如把搜尋字、要點的人名變成每次可以填的欄位）'))) openParams(name);
            } catch (er) { toast('❌ 儲存失敗：' + er.message, 5000); }
        }));
    }
    function showPartial(name) {
        var e = S().get(name); if (!e) return; var info = e.partialInfo || {};
        var o = overlay('📎 半成品：' + name, 9400);
        o.body.appendChild(mk('div', CSS.muted, '半成品不能直接執行，只會在 AI 規劃相似任務時當參考。'));
        o.body.appendChild(lab('目標')); o.body.appendChild(mk('div', 'font-size:14px;', e.goal || ''));
        if (info.note) { o.body.appendChild(lab('失敗位置／備註')); o.body.appendChild(mk('div', 'font-size:13px;white-space:pre-wrap;', info.note)); }
        if (info.pitfalls) { o.body.appendChild(lab('避坑筆記')); o.body.appendChild(mk('div', 'font-size:13px;white-space:pre-wrap;', info.pitfalls)); }
        o.body.appendChild(lab('做對的步驟（' + e.steps.length + '）')); o.body.appendChild(mk('div', 'font-size:13px;white-space:pre-wrap;line-height:1.7;', S().outline(e.steps)));
        o.foot.append(btn('關閉', CSS.btn + 'flex:1;', o.close));
    }

    // ═══════════════ 比對＋規劃提示 ═══════════════
    function tokens(s) {
        s = String(s || '').toLowerCase(); var set = {};
        (s.match(/[a-z0-9]+/g) || []).forEach(function (w) { if (w.length > 1) set[w] = 1; });
        var cjk = s.replace(/[^一-鿿]/g, ''); for (var i = 0; i < cjk.length - 1; i++) set[cjk.slice(i, i + 2)] = 1;
        return set;
    }
    function overlap(a, b) { var ta = tokens(a), tb = tokens(b), n = 0, m = Object.keys(ta).length; if (!m) return 0; Object.keys(ta).forEach(function (k) { if (tb[k]) n++; }); return n / m; }
    function candidates(goal, includePartial) {
        return S().getManifest().filter(function (s) { return s.type === 'replay' && (includePartial ? s.partial : !s.partial); })
            .map(function (s) { return { s: s, score: Math.max(overlap(goal, s.goal), overlap(goal, s.description), overlap(goal, s.name.replace(/_/g, ' '))) }; })
            .sort(function (a, b) { return b.score - a.score; });
    }
    async function tryMatchAndReplay(goal) {
        if (!opt.match() || !S()) return false;
        try { await S().load(); } catch (e) { return false; }
        var cs = candidates(goal, false).filter(function (c) { return c.score >= 0.15; }).slice(0, 6);
        if (!cs.length) return false;
        var pick = null, values = null, why = '';
        if (W.NovaJev && W.NovaJev.isOn && W.NovaJev.isOn('skill') && W.NovaJev.matchSkill) {   // 先用 Jev（快、便宜），不確定才問 LLM
            try { var jr = await W.NovaJev.matchSkill(goal, cs.map(function (c) { return { name: c.s.name, text: (c.s.goal || '') + ' ' + (c.s.description || '') }; })); if (jr && jr.name) { pick = S().get(jr.name); why = 'Jev'; } } catch (e) { /* 退回 LLM */ }
        }
        if (!pick) {
            try {
                var r = await llm('使用者要做的手機任務：「' + goal + '」。已存的技能（可直接重播）：\n' + cs.map(function (c) { return '- ' + c.s.name + '：' + (c.s.goal || c.s.description) + (c.s.params && c.s.params.length ? '（參數：' + c.s.params.map(function (p) { return p.name + '=' + p.label + '，預設 ' + p.default; }).join('；') + '）' : ''); }).join('\n') + '\n哪個技能「做法能直接套用到這個任務」（只是參數不同也算）？都不適用就回 null。只回 JSON：{"skill":"名稱或null","params":{參數名:這次的值},"reason":"一句話"}', true);
                if (r && r.skill && S().get(r.skill)) { pick = S().get(r.skill); values = r.params || null; why = r.reason || ''; }
            } catch (e) { return false; }
        }
        if (!pick) return false;
        // 補參數值（沒有的用上次／預設）
        var vals = {}; (pick.params || []).forEach(function (p) { vals[p.name] = (values && values[p.name] != null) ? values[p.name] : ((pick.lastValues && p.name in pick.lastValues) ? pick.lastValues[p.name] : p.default); });
        var go = opt.auto();
        if (!go) {
            go = await W.showConfirm('🧰 找到已存的技能「' + pick.name + '」（' + pick.steps.length + ' 步）' + (why ? '\n' + why : '') + '\n' + (pick.description || '') + (Object.keys(vals).length ? '\n\n這次的參數：' + Object.keys(vals).map(function (k) { return k + '=' + vals[k]; }).join('、') : '') + '\n\n要直接重播嗎？（取消＝讓 AI 重新做）');
        }
        if (!go) return false;
        if (Object.keys(vals).length && !opt.auto()) { var v2 = await askValues(Object.assign({}, pick, { lastValues: vals }), goal); if (v2 === null) return true; vals = v2; }
        try { await S().setLastValues(pick.name, vals); } catch (e) { /* ignore */ }
        W.novaAutoTask.replay(pick, vals, {});
        return true;
    }
    function planningHints(goal) {
        try {
            var ps = candidates(goal, true).filter(function (c) { return c.score >= 0.2; }).slice(0, 2);
            if (!ps.length) return '';
            return '【過去類似任務的半成品經驗（未完成，僅供參考，不保證正確）】\n' + ps.map(function (c) {
                var i = c.s.partialInfo || {}; return '・任務：' + c.s.goal + '\n　已驗證可行的步驟：' + S().outline(c.s.steps).replace(/\n/g, '；') + (i.pitfalls ? '\n　避坑：' + String(i.pitfalls).replace(/\n/g, ' ') : '') + (i.note ? '\n　失敗位置：' + String(i.note).replace(/\n/g, ' ') : '');
            }).join('\n');
        } catch (e) { return ''; }
    }

    // ═══════════════ 設定頁「技能」區塊 ═══════════════
    function renderSettings() {
        var el = $('tab-skills'); if (!el || !S()) return; el.textContent = '';
        var all = S().getManifest();
        el.appendChild(mk('div', CSS.muted + 'margin-bottom:10px;', '目前有 ' + all.length + ' 個技能（可重播 ' + all.filter(function (s) { return s.type === 'replay' && !s.partial; }).length + '、提示範本 ' + all.filter(function (s) { return s.type === 'prompt' || s.type === 'imported'; }).length + '、流程 ' + all.filter(function (s) { return s.type === 'flow'; }).length + '、半成品 ' + all.filter(function (s) { return s.partial; }).length + '）。技能存在手機的 Documents/NovaSkills/。'));
        el.appendChild(btn('🧰 開啟技能管理', CSS.btnP + 'width:100%;margin-bottom:12px;', open));
        [['nova_skill_match', '1', '/ap 執行前先比對技能', '比對到相似的已存技能時，詢問要不要直接重播（比 AI 一步步判斷快、省額度）'],
         ['nova_skill_auto_replay', '0', '比對到就直接重播（不詢問）', '開啟後不再跳確認；失敗時仍會問要不要讓 AI 接手'],
         ['nova_skill_offer_save', '1', '任務成功後提示「存成技能」', '自主任務完成時，底部出現存成技能的按鈕'],
         ['nova_skill_offer_partial', '1', '任務失敗後提示「存成半成品」', '至少做對 2 步時才提示']].forEach(function (t) {
            var row = mk('label', 'display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-top:1px solid var(--nv-line,#1e293b);'); var cb = mk('input'); cb.type = 'checkbox'; cb.checked = lsGet(t[0], t[1]) === '1'; cb.style.cssText = 'width:20px;height:20px;flex:none;margin-top:2px;'; cb.onchange = function () { lsSet(t[0], cb.checked ? '1' : '0'); };
            var tx = mk('div'); tx.appendChild(mk('div', 'font-size:14px;font-weight:600;', t[2])); tx.appendChild(mk('div', CSS.muted, t[3])); row.append(cb, tx); el.appendChild(row);
        });
    }
    W.novaSkillRenderSettings = function () { if (S()) S().load().then(renderSettings); };

    W.NovaSkillUI = { open: open, openParams: openParams, runSkill: runSkill, onTaskEnd: onTaskEnd, tryMatchAndReplay: tryMatchAndReplay, planningHints: planningHints, saveLastRun: saveLastRun, renderSettings: renderSettings, _detect: detect, _applyParams: applyParamsToSteps, _unparam: unparam };
    W.openSkillManager = open;
    if (S()) setTimeout(function () { S().load().then(renderSettings); }, 1200);
})();

/* ═══════════════════════════════════════════════════════════════════════
   nova-proactive-research.js — NOVA Android「主動研究（唯讀）」（跟 index.html 放同一個資料夾 www/）
   版本：v1.0.0
   版本紀錄（只記這個檔案自己的變更）：
   v1.0.0 - App v2.6.156。新檔，移植桌面 nova-proactive.js v1.0.0（desktop-patch v3.135.0；借鑑 OpenAI dots 的分級：背景只做「唯讀」研究，
            任何會動到帳號、檔案或對外送出的事都留給你決定）。手機原本的 nova-proactive.js 是「AI 主動說話」，所以這裡另開新檔，
            全域名稱用 window.NovaProactiveResearch（不和 window.NovaProactive 衝突）；資料存 localStorage nova_proactive_v1（和桌面同名、同格式）。
            ① 設定 → Agent 與自主任務 → AI 自主任務 最下方「🔭 主動研究（唯讀）」卡片：開關（預設關閉）、關注主題（一行一個：主題｜關注重點｜每幾小時，
               最多 12 個）、通知門檻（低／中／高）、「高」重要度另推 Telegram、立即跑一次、最近發現。
            ② NOVA 開著的時候每 10 分鐘檢查一次哪些主題到期（App 回到前景時也檢查）；到期就用最高級的已啟用 Gemini Flash＋Google 搜尋
               查「上次之後的新進展」。程式上只有一個出口：直接呼叫 Gemini generateContent（經 nova-interactions.js 轉換），不呼叫任何工具、
               不開瀏覽器、不寫檔、不寄信。每輪最多跑 2 個主題；自主任務執行中、沒有 Gemini 金鑰、私密對話開著時跳過這一輪。
            ③ 有新進展而且重要程度達到門檻 →【和桌面不同】桌面寫進常駐大腦收件匣；手機沒有常駐大腦，改發手機通知（LocalNotifications，
               點通知打開 NOVA 並跳到這張卡片），「高」重要度可另外推 Telegram（預設開，可關）。
            ④ 每則附「建議動作」，但不會自己執行：「▶ 交給自主任務」只是把 /ap 指令放進輸入框，要你自己按送出。
            ⑤ 每個主題記住最近 12 個已知重點，下次只回報新的，避免重複通知。發現最多留 60 筆。完整備份會一起備份（nova_ 開頭的 localStorage）。
            【誠實限制】只在 NOVA 開著時才會跑；常駐背景開著、畫面不在 NOVA 時，Android 可能暫停 WebView 的計時器，所以到期的主題會在你下次打開
               NOVA 時才補跑。重要程度由模型判斷，可能誤判；通知內容請點來源確認。沒有在真機用真的 Gemini 金鑰測過（沙盒以假的 Gemini 回應驗證流程）。
   對外：window.NovaProactiveResearch = { version, tick(force), runNow(btn), render(), mount(), _parseTopics, _load }
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';
    if (window.NovaProactiveResearch) return;
    var VERSION = '1.0.0';
    var LS = 'nova_proactive_v1';
    var RANK = { low: 1, medium: 2, high: 3 };
    var ZH = { low: '低', medium: '中', high: '高' };
    var NOTIF_BASE = 7300;
    var running = false;
    var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
    var toast = function (m, d) { try { if (typeof window.showToast === 'function') window.showToast(m, d); } catch (e) { /* */ } };

    function load() {
        var d = null;
        try { d = JSON.parse(localStorage.getItem(LS) || 'null'); } catch (e) { d = null; }
        d = d && typeof d === 'object' ? d : {};
        return { enabled: !!d.enabled, minImportance: RANK[d.minImportance] ? d.minImportance : 'medium', tgHigh: d.tgHigh !== false,
                 topics: Array.isArray(d.topics) ? d.topics : [], findings: Array.isArray(d.findings) ? d.findings : [] };
    }
    function save(d) { try { localStorage.setItem(LS, JSON.stringify(d)); } catch (e) { /* 空間不足就不存 */ } }
    function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
    function fmt(t) { return new Date(t).toLocaleString('zh-TW', { hour12: false }); }

    // 「主題｜關注重點｜每幾小時」一行一個 → 合併進既有主題（同名保留 lastRun 與已知重點）
    function parseTopics(text, old) {
        var byTitle = {};
        (old || []).forEach(function (t) { byTitle[t.title] = t; });
        return String(text || '').split(/\r?\n/).map(function (line) {
            var p = line.split(/[｜|]/).map(function (x) { return x.trim(); });
            if (!p[0]) return null;
            var h = parseFloat(p[2]);
            var prev = byTitle[p[0]] || {};
            return { id: prev.id || uid(), title: p[0].slice(0, 80), focus: (p[1] || '').slice(0, 200), hours: isFinite(h) && h >= 1 ? Math.min(h, 168) : 12,
                     lastRun: prev.lastRun || 0, known: Array.isArray(prev.known) ? prev.known.slice(-12) : [] };
        }).filter(Boolean).slice(0, 12);
    }
    function topicsText(d) { return d.topics.map(function (t) { return t.title + '｜' + (t.focus || '') + '｜' + t.hours; }).join('\n'); }

    function geminiKey() { try { return (window.appState && appState.keys && appState.keys.gemini) || localStorage.getItem('nova_key_gemini') || ''; } catch (e) { return ''; } }
    // 最高級的已啟用 Gemini Flash（桌面 _novaAutoFlashModel 的手機版）
    function flashModel() {
        var list = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash'];
        for (var i = 0; i < list.length; i++) { try { if (!window.novaModelEnabled || window.novaModelEnabled(list[i])) return list[i]; } catch (e) { return list[i]; } }
        return window.NOVA_GEMINI_MODEL_DEFAULT || 'gemini-3.6-flash';
    }
    function busy() {
        try { if (window.novaAutoTask && typeof window.novaAutoTask.isRunning === 'function' && window.novaAutoTask.isRunning()) return true; } catch (e) { /* */ }
        return false;
    }
    function privOn() { try { return !!(window.novaPrivIsCur && window.novaPrivIsCur()); } catch (e) { return false; } }

    function parseJson(text) {
        var m = String(text || '').match(/\{[\s\S]*\}/);
        if (!m) throw new Error('回應裡沒有 JSON');
        return JSON.parse(m[0]);
    }

    // 唯一的出口：Gemini generateContent ＋ google_search（不帶任何其他工具）
    async function callGemini(prompt) {
        var key = geminiKey(); if (!key) throw new Error('沒有 Gemini 金鑰');
        var model = flashModel(), ver = (typeof window._novaDrGeminiApiVer === 'function') ? window._novaDrGeminiApiVer(model) : 'v1beta';
        var gen = { temperature: 0.3, maxOutputTokens: 4096 };
        try { var th = window._novaDrThinkingConfig && window._novaDrThinkingConfig(model, 'low'); if (th) gen.thinkingConfig = th; } catch (e) { /* */ }
        var ctl = new AbortController(), timer = setTimeout(function () { try { ctl.abort(); } catch (e) { /* */ } }, 120000);
        var res;
        try {
            res = await fetch('https://generativelanguage.googleapis.com/' + ver + '/models/' + model + ':generateContent?key=' + encodeURIComponent(key), {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal,
                body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], tools: [{ google_search: {} }], generationConfig: gen }) });
        } finally { clearTimeout(timer); }
        var raw = await res.text(), data = null;
        try { data = JSON.parse(raw); } catch (e) { data = null; }
        if (!res.ok) throw new Error('Gemini 錯誤 ' + res.status + '：' + (((data && data.error && data.error.message) || raw) + '').slice(0, 160));
        var cand = ((data && data.candidates) || [])[0] || {};
        var text = ((cand.content && cand.content.parts) || []).filter(function (p) { return p && p.text && !p.thought; }).map(function (p) { return p.text; }).join('');
        var sources = (((cand.groundingMetadata || {}).groundingChunks) || []).map(function (c) { return c && c.web; }).filter(function (w) { return w && w.uri; })
            .slice(0, 8).map(function (w) { return { title: String(w.title || w.uri).slice(0, 120), uri: String(w.uri) }; });
        return { text: text, sources: sources, model: model };
    }

    async function researchTopic(t) {
        var prompt = '你是使用者的背景研究助理，只做唯讀的資料蒐集與整理，不執行任何動作。\n'
            + '現在時間：' + fmt(Date.now()) + '\n'
            + '【主題】' + t.title + '\n' + (t.focus ? '【關注重點】' + t.focus + '\n' : '')
            + (t.lastRun ? '【上次查詢時間】' + fmt(t.lastRun) + '\n' : '')
            + (t.known && t.known.length ? '【已經通知過的重點（不要重複回報）】\n- ' + t.known.join('\n- ') + '\n' : '')
            + '\n請用 Google 搜尋查這個主題「最近」的新進展，只回報上次之後、且不在已知重點裡的新資訊。'
            + '沒有實質新進展就把 has_new 設為 false，不要硬湊。每個重點都要能對應到搜尋到的來源；不確定的不要寫。'
            + '「建議動作」只是給使用者參考的下一步，寫成可以直接交給 AI 自主任務的一句話目標（不要包含付款、下單、寄信、刪除這類動作）。\n'
            + '只輸出一個 JSON（不要 code fence）：{"has_new":true|false,"importance":"low|medium|high","headline":"一句話（30 字內）",'
            + '"findings":["重點1","重點2"],"suggested_actions":[{"title":"簡短標題","goal":"交給自主任務的一句話目標"}]}';
        var res = await callGemini(prompt);
        var j = parseJson(res.text);
        return {
            has_new: !!j.has_new, importance: RANK[j.importance] ? j.importance : 'low', headline: String(j.headline || '').slice(0, 80),
            findings: (Array.isArray(j.findings) ? j.findings : []).map(function (x) { return String(x || '').trim().slice(0, 300); }).filter(Boolean).slice(0, 6),
            actions: (Array.isArray(j.suggested_actions) ? j.suggested_actions : []).map(function (a) { return { title: String((a && a.title) || '').slice(0, 40), goal: String((a && a.goal) || '').slice(0, 300) }; }).filter(function (a) { return a.goal; }).slice(0, 3),
            sources: res.sources
        };
    }

    async function notify(d, t, r, fid) {
        var title = '🔭 ' + t.title + '：' + (r.headline || '有新進展');
        var body = r.findings.length ? r.findings.map(function (x) { return '• ' + x; }).join('\n') : '';
        try {
            var LN = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications;
            if (LN) {
                var id = NOTIF_BASE + (Math.abs(String(fid).split('').reduce(function (a, c) { return (a * 31 + c.charCodeAt(0)) | 0; }, 7)) % 600);
                await LN.schedule({ notifications: [{ id: id, title: title.slice(0, 120), body: (body || '點開查看').slice(0, 900) + '\n（主動研究・唯讀；重要程度：' + ZH[r.importance] + '）',
                    largeBody: (body || '').slice(0, 3000), schedule: { at: new Date(Date.now() + 1000), allowWhileIdle: true }, extra: { novaPR: fid } }] });
            } else if (document.visibilityState === 'visible') {
                toast(title, 6000);
            }
        } catch (e) { console.warn('[NovaProactiveResearch] 通知失敗', e); toast(title, 6000); }
        if (r.importance === 'high' && d.tgHigh && typeof window.pushToTelegram === 'function') {
            var tg = title + '\n\n' + body
                + (r.actions.length ? '\n\n建議動作（不會自動執行；要做請到 NOVA 設定 → AI 自主任務 → 主動研究 按「▶ 交給自主任務」）：\n' + r.actions.map(function (a) { return '→ ' + (a.title ? a.title + '：' : '') + a.goal; }).join('\n') : '')
                + (r.sources.length ? '\n\n來源：\n' + r.sources.map(function (s) { return s.title + '\n' + s.uri; }).join('\n') : '')
                + '\n\n（主動研究・唯讀；重要程度：' + ZH[r.importance] + '）';
            try { window.pushToTelegram(tg.slice(0, 3800)); } catch (e) { /* */ }
        }
    }

    async function runTopic(d, t, manual) {
        var r = await researchTopic(t);
        t.lastRun = Date.now();
        var pass = r.has_new && (manual || RANK[r.importance] >= RANK[d.minImportance]);
        if (r.has_new && r.findings.length) t.known = (t.known || []).concat(r.findings.map(function (x) { return x.slice(0, 120); })).slice(-12);
        var fid = uid();
        if (r.has_new) {
            d.findings.unshift({ id: fid, topic: t.title, at: t.lastRun, notified: pass, importance: r.importance, headline: r.headline, findings: r.findings, actions: r.actions, sources: r.sources });
            d.findings = d.findings.slice(0, 60);
        }
        if (pass) await notify(d, t, r, fid);
        return r;
    }

    async function tick(force) {
        if (running) return { skipped: '上一輪還在跑' };
        var d = load();
        if (!force && !d.enabled) return { skipped: '沒有開啟' };
        if (!geminiKey()) return { skipped: '沒有 Gemini 金鑰' };
        if (!force && busy()) return { skipped: '自主任務執行中' };
        if (!force && privOn()) return { skipped: '私密對話開著' };
        var now = Date.now();
        var due = d.topics.filter(function (t) { return force || now - (t.lastRun || 0) >= t.hours * 3600 * 1000; }).slice(0, force ? 12 : 2);
        if (!due.length) return { ran: 0, newCount: 0, errors: [] };
        running = true;
        var ran = 0, newCount = 0, errors = [];
        try {
            for (var i = 0; i < due.length; i++) {
                var cur = load();   // 每個主題重新讀，避免覆蓋你在設定頁剛改的內容
                var t = cur.topics.filter(function (x) { return x.id === due[i].id; })[0];
                if (!t) continue;
                try { var r = await runTopic(cur, t, !!force); ran++; if (r.has_new) newCount++; delete t.lastError; }
                catch (e) { t.lastRun = Date.now(); t.lastError = String((e && e.message) || e).slice(0, 160); errors.push(t.title + '：' + t.lastError); }
                save(cur);
            }
        } finally { running = false; }
        render();
        return { ran: ran, newCount: newCount, errors: errors };
    }

    /* ───────── 設定卡片（設定 → Agent 與自主任務 → AI 自主任務 最下方） ───────── */
    function render() {
        var box = document.getElementById('nova-pr-card'); if (!box) return;
        var d = load();
        var cb = document.getElementById('npr-enabled'); if (cb) cb.checked = d.enabled;
        var ta = document.getElementById('npr-topics'); if (ta && document.activeElement !== ta) ta.value = topicsText(d);
        var sel = document.getElementById('npr-min'); if (sel) sel.value = d.minImportance;
        var tg = document.getElementById('npr-tg'); if (tg) tg.checked = d.tgHigh;
        var st = document.getElementById('npr-status');
        if (st) st.textContent = d.topics.length ? d.topics.map(function (t) { return t.title + '：' + (t.lastRun ? '上次 ' + fmt(t.lastRun) : '還沒跑過') + '，每 ' + t.hours + ' 小時' + (t.lastError ? '（上次失敗：' + t.lastError + '）' : ''); }).join('\n') : '還沒有主題。';
        var list = document.getElementById('npr-list'); if (!list) return;
        if (!d.findings.length) { list.innerHTML = '<p class="text-[11px] text-slate-500">還沒有發現。</p>'; return; }
        list.innerHTML = d.findings.slice(0, 10).map(function (f, i) {
            return '<div data-npr-f="' + esc(f.id) + '" style="padding:8px 0;border-top:1px solid rgba(127,127,127,.25);font-size:12px;line-height:1.55">'
                + '<div class="text-slate-200"><b>' + esc(f.topic) + '</b>：' + esc(f.headline || '') + ' <span class="text-slate-500">（' + ZH[f.importance] + '・' + fmt(f.at) + (f.notified ? '・已通知' : '・未達通知門檻') + '）</span></div>'
                + (f.findings || []).map(function (x) { return '<div class="text-slate-300">• ' + esc(x) + '</div>'; }).join('')
                + (f.sources || []).slice(0, 4).map(function (s) { return '<div class="text-slate-500" style="font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">🔗 <a href="' + esc(s.uri) + '" target="_blank" rel="noopener">' + esc(s.title) + '</a></div>'; }).join('')
                + (f.actions || []).map(function (a, k) { return '<div style="margin-top:4px;display:flex;gap:6px;align-items:center"><span class="text-slate-300" style="flex:1;min-width:0">→ ' + esc((a.title ? a.title + '：' : '') + a.goal) + '</span><button type="button" class="px-2 py-1 rounded-md bg-slate-800 border border-slate-600 text-slate-200 text-[11px]" data-npr-act="' + i + ':' + k + '">▶ 交給自主任務</button></div>'; }).join('')
                + '</div>';
        }).join('');
    }

    function onChange(id, el) {
        var d = load();
        if (id === 'enabled') d.enabled = !!el.checked;
        if (id === 'topics') d.topics = parseTopics(el.value, d.topics);
        if (id === 'min') d.minImportance = RANK[el.value] ? el.value : 'medium';
        if (id === 'tg') d.tgHigh = !!el.checked;
        save(d);
        if (id === 'enabled') {
            toast(d.enabled ? '已開啟主動研究（' + d.topics.length + ' 個主題；NOVA 開著時每 10 分鐘檢查一次）' : '已關閉主動研究', 4000);
            if (d.enabled) { try { var LN = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications; if (LN && LN.requestPermissions) LN.requestPermissions(); } catch (e) { /* */ } }
        }
        render();
    }

    async function runNow(btn) {
        var d = load();
        var ta = document.getElementById('npr-topics');
        if (ta) { d.topics = parseTopics(ta.value, d.topics); save(d); }
        if (!d.topics.length) { toast('請先輸入至少一個主題', 3500); return; }
        if (!geminiKey()) { toast('主動研究需要 Gemini 金鑰（用 Google 搜尋）', 4000); return; }
        if (btn) { btn.disabled = true; btn.textContent = '研究中…'; }
        var r;
        try { r = await tick(true); } finally { if (btn) { btn.disabled = false; btn.textContent = '立即跑一次'; } }
        toast(r.skipped ? '這次沒有執行（' + r.skipped + '）' : '完成：' + r.ran + ' 個主題、' + r.newCount + ' 個有新進展' + (r.errors && r.errors.length ? '；失敗：' + r.errors.join('；') : ''), 6000);
    }

    function giveToAutoTask(ij) {
        ij = String(ij).split(':');
        var f = load().findings[+ij[0]], a = f && f.actions[+ij[1]];
        if (!a) return;
        var inp = document.getElementById('user-input');
        if (inp) { inp.value = '/ap ' + a.goal; try { inp.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) { /* */ } try { if (typeof window.autoResizeInput === 'function') window.autoResizeInput(inp); if (typeof window.updateSmartActionBtn === 'function') window.updateSmartActionBtn(); } catch (e) { /* */ } }
        try { if (typeof window.closeSettings === 'function') window.closeSettings(); } catch (e) { /* */ }
        try { if (inp) inp.focus(); } catch (e) { /* */ }
        toast('已把指令放進輸入框——確認內容後自己按送出才會開始（主動研究不會自動執行）', 5000);
    }

    function mount() {
        var tab = document.getElementById('tab-autotask');
        if (!tab || document.getElementById('nova-pr-card')) return;
        var box = document.createElement('div');
        box.id = 'nova-pr-card';
        box.className = 'space-y-2 border border-slate-700 rounded-lg p-3';
        box.innerHTML = '<div class="flex items-center gap-2"><span class="text-xs font-bold text-sky-400">🔭 主動研究（唯讀）</span></div>'
            + '<p class="text-[11px] text-slate-400 leading-relaxed">NOVA 開著時，每 10 分鐘檢查一次你關注的主題，到期就用 Gemini Flash＋Google 搜尋查「上次之後的新進展」。只查資料、不執行任何動作；有重要新進展才發手機通知。需要 Gemini 金鑰（每次查詢會用到額度）。</p>'
            + '<label class="flex items-center gap-2 text-[11px] text-slate-300"><input type="checkbox" id="npr-enabled"><span>開啟主動研究</span></label>'
            + '<div><label class="block text-[10px] text-sky-300 mb-1 font-bold">關注主題（一行一個：主題｜關注重點｜每幾小時，最多 12 個）</label>'
            + '<textarea id="npr-topics" rows="4" class="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-xs text-slate-200 outline-none" placeholder="Gemini 新模型｜發表、價格、API 變更｜12&#10;台積電｜法說會、重大新聞｜24"></textarea></div>'
            + '<div class="flex items-center gap-2 text-[11px] text-slate-300"><span>通知門檻</span><select id="npr-min" class="bg-slate-950 border border-slate-700 rounded-lg p-1 text-xs text-slate-200"><option value="low">低（有新進展就通知）</option><option value="medium">中</option><option value="high">高（只有重大進展）</option></select></div>'
            + '<label class="flex items-center gap-2 text-[11px] text-slate-300"><input type="checkbox" id="npr-tg"><span>「高」重要度另外推到 Telegram（需設定 Telegram）</span></label>'
            + '<div class="flex gap-2"><button type="button" id="npr-run" class="px-2 py-1 rounded-md bg-slate-800 border border-slate-600 text-slate-200 text-[11px]">立即跑一次</button></div>'
            + '<pre id="npr-status" class="text-[10px] text-slate-500 whitespace-pre-wrap" style="margin:0"></pre>'
            + '<div class="text-[11px] text-slate-400 font-bold" style="margin-top:4px">最近發現</div><div id="npr-list"></div>'
            + '<p class="text-[10px] text-slate-500 leading-relaxed">「建議動作」不會自動執行：按「▶ 交給自主任務」只會把 /ap 指令放進輸入框，要你自己按送出。常駐背景時 Android 可能暫停計時器，到期的主題會在下次打開 NOVA 時補跑。</p>';
        tab.appendChild(box);
        document.getElementById('npr-enabled').onchange = function () { onChange('enabled', this); };
        document.getElementById('npr-topics').onchange = function () { onChange('topics', this); };
        document.getElementById('npr-min').onchange = function () { onChange('min', this); };
        document.getElementById('npr-tg').onchange = function () { onChange('tg', this); };
        document.getElementById('npr-run').onclick = function () { runNow(this); };
        box.addEventListener('click', function (e) { var b = e.target && e.target.closest && e.target.closest('[data-npr-act]'); if (b) giveToAutoTask(b.getAttribute('data-npr-act')); });
        render();
    }

    // 點通知：打開設定 → AI 自主任務，捲到這張卡片
    function openCard() {
        try {
            if (typeof window.openSettings === 'function') window.openSettings();
            else { var m = document.getElementById('settings-modal'); if (m) m.classList.remove('hidden'); }
            if (typeof window.switchSettingsTab === 'function') window.switchSettingsTab('tab-autotask');
            setTimeout(function () { var c = document.getElementById('nova-pr-card'); if (c && c.scrollIntoView) c.scrollIntoView({ behavior: 'smooth', block: 'start' }); render(); }, 350);
        } catch (e) { /* */ }
    }

    function boot() {
        mount();
        var n = 0, t = setInterval(function () { mount(); if (document.getElementById('nova-pr-card') || ++n > 40) clearInterval(t); }, 500);
        try {
            var LN = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications;
            if (LN && LN.addListener) LN.addListener('localNotificationActionPerformed', function (ev) {
                try { if (ev && ev.notification && ev.notification.extra && ev.notification.extra.novaPR) setTimeout(openCard, 600); } catch (e) { /* */ }
            });
        } catch (e) { /* */ }
        document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') setTimeout(function () { tick(false); }, 5000); });
        setTimeout(function () { tick(false); }, 90 * 1000);
        setInterval(function () { tick(false); }, 10 * 60 * 1000);
    }

    window.NovaProactiveResearch = { version: VERSION, tick: tick, runNow: runNow, render: render, mount: mount, openCard: openCard, _parseTopics: parseTopics, _load: load };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();

/*
  ════════════════════════════════════════════════════════════════
  nova-drawio.js — NOVA Android：內嵌 draw.io 編輯器＋用 NOVA 的模型直接產生／修改 draw.io 圖表
  ════════════════════════════════════════════════════════════════
  目前版本：v1.0.0（Android）
  最後更新：2026-11-17（App v2.6.148）
  對標桌面 nova-drawio.js v1.0.0（nova-desktop/src，2026-11-17）；XML 檢查、產生／修改、版本、最近的圖、對話按鈕的程式和桌面版相同，差異在版面、存檔與入口。

  版本紀錄（只記這個檔案自己的變更）：
  v1.0.0 - App v2.6.148 新增（使用者要求：把 nova-desktop 最新一輪「在 NOVA 內嵌 draw.io 編輯器，讓自己的模型直接產生 draw.io 圖檔」移植到 nova-android）。
           做法借鏡 DayuanJiang/next-ai-draw-io（Apache-2.0），沒有安裝它的程式。
           ① 編輯器：全螢幕視窗內嵌官方 draw.io 編輯器（iframe https://embed.diagrams.net，embed 模式＋JSON 訊息協定），可拖拉、改字、改樣式；
              每次修改自動回傳最新圖檔（autosave）。深色／淺色跟著 NOVA 主題。
           ② AI 產生：輸入描述 → 用目前對話選的模型產生 mxGraphModel XML → 檢查（XML 格式、根節點 0／1、重複 id、連線指到不存在的節點）→ 有錯丟回模型重寫一次 → 載入編輯器。
           ③ AI 修改：把編輯器裡最新的圖（含手動改過的部分）連同指示送給模型，回傳完整新版本。
           ④ 看圖重建：附加圖片或 PDF（白板照片、截圖、手繪草圖）重建成可編輯的圖。
           ⑤ 版本：每次 AI 產生／修改存一版，可上一版／下一版；最近 15 張圖存在 localStorage nova_drawio_recent（nova_ 開頭，包含在完整備份內）。
           ⑥ 匯出：.drawio、PNG、SVG（PNG／SVG 內嵌圖檔資料，丟回 draw.io 仍可編輯）。
           ⑦ 對話整合：對話裡含 <mxGraphModel>／<mxfile> 的程式碼區塊上方加「在 draw.io 開啟」按鈕。
           入口：「+」選單「draw.io 圖表」（本檔自己加的按鈕 #nv-drawio-btn）、指令 /draw（nova-app-main.js v1.5.7）。
           【和桌面版不同的地方】
           ・版面改成手機直向：第一列標題＋「AI」收合鈕＋關閉；第二列工具（可左右滑）；AI 輸入區可收合，產生成功後自動收起讓出畫面給編輯器。
           ・draw.io 介面用精簡版（ui=min），比較適合小螢幕與觸控。
           ・匯出：寫到手機的 Documents/NOVA_Drawio/ 並跳出分享面板（Capacitor Filesystem＋Share；WebView 的 <a download> 不可靠）。瀏覽器裡仍用下載。
           ・手機返回鍵會關閉視窗（history＋popstate，和 TravelAgent／Insight 同一個做法）。
           ・模型呼叫由 index.html 的接線透過 fetchAIResponse 提供（手機沒有桌面版的 pickModel／_novaCallModel 通用呼叫）。
           【限制】編輯器從 embed.diagrams.net 載入，需要網路；離線時仍可 AI 產生並匯出 .drawio。embed 模式不會把圖上傳到 draw.io 伺服器。
           只在電腦瀏覽器用手機尺寸＋模擬的模型回應測過；draw.io 編輯器在手機 WebView 裡的觸控操作與匯出未在真機驗證。
  ════════════════════════════════════════════════════════════════
*/
(function () {
    'use strict';
    if (window.NovaDrawio) return;

    var ORIGIN = 'https://embed.diagrams.net';
    var LS_RECENT = 'nova_drawio_recent';
    var MAX_RECENT = 15;
    var BLANK = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';

    var H = {   // 由 nova-app-main.js 的 NovaDrawio.init() 注入
        llm: null,          // async ({system, user, images:[{b64,mime,name}], purpose}) → string
        modelLabel: null,   // () → '目前模型名稱'
        toast: function (m) { try { console.log('[NovaDrawio]', m); } catch (e) { /* */ } },
        isLight: function () { return document.documentElement.classList.contains('theme-light'); }
    };

    var S = {
        open: false, ready: false, xml: BLANK, title: '未命名圖表', id: null,
        versions: [], vIdx: -1, busy: false, pendingExport: null, readyTimer: null, images: []
    };

    // ─────────────────────────── XML 工具 ───────────────────────────
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

    async function inflateDiagram(b64) {   // draw.io 壓縮格式：base64 → raw deflate → URL 編碼的 XML
        var bin = atob(String(b64).replace(/\s+/g, ''));
        var u = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        if (typeof DecompressionStream !== 'function') throw new Error('這個環境不支援解壓縮 draw.io 圖檔');
        var stream = new Blob([u]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        var txt = await new Response(stream).text();
        try { return decodeURIComponent(txt); } catch (e) { return txt; }
    }

    // 把 draw.io 回傳的 xml（可能是 <mxfile><diagram>…</diagram></mxfile>，內容可能壓縮）統一成第一頁的 <mxGraphModel>
    async function toGraphModel(xml) {
        var s = String(xml || '').trim();
        if (!s) return BLANK;
        if (/^<mxGraphModel[\s>]/.test(s)) return s;
        var doc = new DOMParser().parseFromString(s, 'text/xml');
        if (doc.getElementsByTagName('parsererror').length) return s;
        var gm = doc.getElementsByTagName('mxGraphModel')[0];
        if (gm) return new XMLSerializer().serializeToString(gm);
        var dg = doc.getElementsByTagName('diagram')[0];
        if (dg && dg.textContent.trim()) {
            var inner = await inflateDiagram(dg.textContent.trim());
            if (/<mxGraphModel/.test(inner)) return inner.slice(inner.indexOf('<mxGraphModel'));
        }
        return s;
    }

    function extractXml(text) {
        var t = String(text || '');
        var m = /```(?:xml|drawio|mxgraph)?\s*([\s\S]*?)```/i.exec(t);
        if (m && /<mx(GraphModel|file)/.test(m[1])) t = m[1];
        var a = t.search(/<mxfile[\s>]/), b;
        if (a >= 0) { b = t.lastIndexOf('</mxfile>'); if (b > a) return t.slice(a, b + 9); }
        a = t.search(/<mxGraphModel[\s>]/);
        if (a >= 0) { b = t.lastIndexOf('</mxGraphModel>'); if (b > a) return t.slice(a, b + 15); }
        return '';
    }

    // 檢查並修正常見錯誤；回傳 {ok, xml, error, fixes}
    function validate(xml) {
        var fixes = [];
        if (!xml) return { ok: false, error: '回覆裡沒有找到 <mxGraphModel> … </mxGraphModel>' };
        var doc = new DOMParser().parseFromString(xml, 'text/xml');
        var pe = doc.getElementsByTagName('parsererror')[0];
        if (pe) return { ok: false, error: 'XML 格式錯誤：' + (pe.textContent || '').replace(/\s+/g, ' ').slice(0, 200) };
        var gm = doc.getElementsByTagName('mxGraphModel')[0];
        if (!gm) return { ok: false, error: '缺少 <mxGraphModel>' };
        var root = gm.getElementsByTagName('root')[0];
        if (!root) { root = doc.createElement('root'); gm.appendChild(root); fixes.push('補上 <root>'); }
        var cells = Array.prototype.slice.call(root.getElementsByTagName('mxCell'));
        var ids = {};
        var has0 = cells.some(function (c) { return c.getAttribute('id') === '0'; });
        var has1 = cells.some(function (c) { return c.getAttribute('id') === '1'; });
        if (!has1) { var c1 = doc.createElement('mxCell'); c1.setAttribute('id', '1'); c1.setAttribute('parent', '0'); root.insertBefore(c1, root.firstChild); fixes.push('補上根節點 1'); }
        if (!has0) { var c0 = doc.createElement('mxCell'); c0.setAttribute('id', '0'); root.insertBefore(c0, root.firstChild); fixes.push('補上根節點 0'); }
        cells = Array.prototype.slice.call(root.getElementsByTagName('mxCell'));
        var seq = 0;
        cells.forEach(function (c) {
            var id = c.getAttribute('id');
            if (!id) { id = 'n' + (++seq); c.setAttribute('id', id); fixes.push('補上缺少的 id'); }
            if (ids[id]) { var nid = id + '_' + (++seq); c.setAttribute('id', nid); id = nid; fixes.push('重新命名重複的 id'); }
            ids[id] = c;
        });
        var vertexCount = 0, edgeCount = 0;
        cells.forEach(function (c) {
            var id = c.getAttribute('id');
            if (id === '0') return;
            if (!c.getAttribute('parent') || !ids[c.getAttribute('parent')]) {
                if (id !== '1') { c.setAttribute('parent', '1'); fixes.push('父節點不存在 → 改掛在 1 底下'); }
            }
            if (c.getAttribute('vertex') === '1') {
                vertexCount++;
                if (!c.getElementsByTagName('mxGeometry')[0]) {
                    var g = doc.createElement('mxGeometry'); g.setAttribute('x', String(40 + (vertexCount % 6) * 180)); g.setAttribute('y', String(40 + Math.floor(vertexCount / 6) * 120));
                    g.setAttribute('width', '140'); g.setAttribute('height', '60'); g.setAttribute('as', 'geometry'); c.appendChild(g); fixes.push('補上缺少的位置大小');
                }
            }
            if (c.getAttribute('edge') === '1') {
                edgeCount++;
                ['source', 'target'].forEach(function (k) {
                    var v = c.getAttribute(k);
                    if (v && !ids[v]) { c.removeAttribute(k); fixes.push('連線的' + (k === 'source' ? '起點' : '終點') + '「' + v + '」不存在'); }
                });
                if (!c.getElementsByTagName('mxGeometry')[0]) {
                    var eg = doc.createElement('mxGeometry'); eg.setAttribute('relative', '1'); eg.setAttribute('as', 'geometry'); c.appendChild(eg);
                }
            }
        });
        var dangling = fixes.filter(function (f) { return /不存在$/.test(f); }).length;
        if (vertexCount === 0) return { ok: false, error: '圖裡沒有任何圖形（vertex="1" 的 mxCell）' };
        if (dangling > Math.max(2, edgeCount / 3)) return { ok: false, error: '有 ' + dangling + ' 條連線指到不存在的節點 id，請確認每條連線的 source／target 都是已定義的圖形 id' };
        return { ok: true, xml: new XMLSerializer().serializeToString(gm), fixes: fixes, vertices: vertexCount, edges: edgeCount };
    }

    // ─────────────────────────── 提示詞 ───────────────────────────
    var SYSTEM = [
        '你是 draw.io（diagrams.net）圖表專家，只輸出 draw.io 的 mxGraphModel XML，不要任何說明文字、不要 markdown 標題。',
        '格式規定：',
        '1. 最外層是 <mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827"><root> … </root></mxGraphModel>。',
        '2. root 裡第一個一定是 <mxCell id="0"/>，第二個是 <mxCell id="1" parent="0"/>；其他圖形與連線都 parent="1"（放在泳道／群組裡的才 parent=該容器 id）。',
        '3. 圖形：<mxCell id="唯一id" value="文字" style="…" vertex="1" parent="1"><mxGeometry x="…" y="…" width="…" height="…" as="geometry"/></mxCell>。',
        '4. 連線：<mxCell id="唯一id" value="（可空）" style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;" edge="1" parent="1" source="起點id" target="終點id"><mxGeometry relative="1" as="geometry"/></mxCell>；source／target 必須是已定義的圖形 id。',
        '5. 所有 id 不可重複；value 裡的 < > & " 要寫成 &lt; &gt; &amp; &quot;；需要換行用 &lt;br&gt; 並在 style 加 html=1。',
        '6. 版面：依流程方向（由上而下或由左而右）整齊排列在 10 的倍數格線上，圖形之間至少留 40px，連線不要穿過其他圖形，整張圖不超過 pageWidth。',
        '7. 常用樣式：一般步驟 rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;、判斷 rhombus;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;、',
        '   開始／結束 ellipse;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;、資料庫 shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;size=15;、',
        '   泳道／分區 swimlane;whiteSpace=wrap;html=1;startSize=30;、文件 shape=document;whiteSpace=wrap;html=1;、角色 shape=umlActor;verticalLabelPosition=bottom;html=1;、',
        '   雲端服務可用 draw.io 內建圖示庫（例如 shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.lambda;），不確定圖示名稱就用一般圖形加文字。同類元素用同一種顏色。',
        '8. 文字使用繁體中文（台灣），除非使用者要求其他語言或是專有名詞。',
        '9. 修改既有圖表時：保留沒被要求改動的圖形、id、位置與樣式，只改需要改的部分，並回傳「完整」的新 mxGraphModel（不是只回差異）。'
    ].join('\n');

    async function askModel(userText, images, purpose) {
        if (typeof H.llm !== 'function') throw new Error('NOVA 模型呼叫尚未就緒');
        var raw = await H.llm({ system: SYSTEM, user: userText, images: images || [], purpose: purpose || 'drawio' });
        var xml = extractXml(raw);
        var v = validate(xml);
        if (!v.ok) {
            // 把錯誤丟回去重寫一次
            var raw2 = await H.llm({ system: SYSTEM, user: userText + '\n\n【上一次的輸出有問題，請修正後重新輸出完整 XML】\n問題：' + v.error + '\n上一次的輸出（節錄）：\n' + String(xml || raw || '').slice(0, 6000), images: images || [], purpose: purpose || 'drawio' });
            var xml2 = extractXml(raw2);
            v = validate(xml2);
            if (!v.ok) throw new Error('模型產生的圖表格式不正確：' + v.error);
        }
        return v;
    }

    // ─────────────────────────── 對外 API（不開 UI 也能用）───────────────────────────
    async function generate(desc, opts) {
        opts = opts || {};
        var prompt = '請畫這張圖：\n' + String(desc || '').trim();
        if (opts.images && opts.images.length) prompt = '請把附加的圖片重建成可以編輯的 draw.io 圖表：辨識每個方塊、文字、箭頭方向、分組與顏色，盡量維持原本的相對位置。'
            + (desc ? '\n額外要求：' + desc : '');
        return askModel(prompt, opts.images, opts.images && opts.images.length ? 'drawio-image' : 'drawio');
    }
    async function modify(currentXml, instruction) {
        var cur = await toGraphModel(currentXml);
        if (cur.length > 150000) throw new Error('目前的圖太大（' + Math.round(cur.length / 1000) + 'K 字元），請拆成幾張圖再請 AI 修改');
        return askModel('這是目前的 draw.io 圖表：\n' + cur + '\n\n請依照這個指示修改，回傳完整的新 mxGraphModel：\n' + String(instruction || '').trim(), [], 'drawio-edit');
    }
    function toMxFile(gm, name) {
        return '<mxfile host="NOVA" agent="NOVA Android"><diagram id="nova-' + Date.now().toString(36) + '" name="' + esc(name || 'Page-1') + '">' + gm + '</diagram></mxfile>';
    }

    // ─────────────────────────── 最近的圖 ───────────────────────────
    function recentList() { try { var a = JSON.parse(localStorage.getItem(LS_RECENT) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
    function saveRecent() {
        if (!S.id) S.id = 'd' + Date.now().toString(36);
        if (!S.xml || S.xml === BLANK) return;
        var list = recentList().filter(function (x) { return x && x.id !== S.id; });
        list.unshift({ id: S.id, title: S.title, xml: S.xml.length > 400000 ? S.xml.slice(0, 0) : S.xml, t: Date.now() });
        list = list.filter(function (x) { return x.xml; }).slice(0, MAX_RECENT);
        for (var i = 0; i < 5; i++) {
            try { localStorage.setItem(LS_RECENT, JSON.stringify(list)); return; } catch (e) { list.pop(); }
        }
    }
    var _saveT = null;
    function saveRecentSoon() { clearTimeout(_saveT); _saveT = setTimeout(saveRecent, 1500); }

    // ─────────────────────────── UI ───────────────────────────
    function $(id) { return document.getElementById(id); }
    function theme() {
        var L = !!H.isLight();
        return L ? { bg: '#f8fafc', panel: '#ffffff', border: '#e2e8f0', text: '#0f172a', sub: '#64748b', input: '#ffffff', btn: '#e2e8f0', btnText: '#0f172a', accent: '#4f46e5' }
                 : { bg: '#0b1120', panel: '#0f172a', border: '#1e293b', text: '#e2e8f0', sub: '#94a3b8', input: '#1e293b', btn: '#1e293b', btnText: '#e2e8f0', accent: '#6366f1' };
    }
    function btn(id, label, title, primary) {
        var c = theme();
        return '<button type="button" id="' + id + '" title="' + esc(title || label) + '" style="padding:6px 10px;border-radius:8px;border:1px solid ' + (primary ? c.accent : c.border) + ';background:' + (primary ? c.accent : c.btn) + ';color:' + (primary ? '#fff' : c.btnText) + ';font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap">' + label + '</button>';
    }
    function setStatus(t, isErr) { var el = $('ndio-status'); if (el) { el.textContent = t || ''; el.style.color = isErr ? '#ef4444' : theme().sub; } }
    function setBusy(b, label) {
        S.busy = !!b;
        ['ndio-gen', 'ndio-edit', 'ndio-img'].forEach(function (id) { var el = $(id); if (el) { el.disabled = !!b; el.style.opacity = b ? '.5' : '1'; } });
        if (b) setStatus(label || 'AI 處理中…');
    }
    function updateVerUi() {
        var p = $('ndio-prev'), n = $('ndio-next'), l = $('ndio-ver');
        if (l) l.textContent = S.versions.length ? ('版本 ' + (S.vIdx + 1) + '/' + S.versions.length) : '';
        if (p) p.disabled = S.vIdx <= 0;
        if (n) n.disabled = S.vIdx >= S.versions.length - 1;
    }
    function pushVersion(xml, note) {
        S.versions = S.versions.slice(0, S.vIdx + 1);
        S.versions.push({ xml: xml, note: note || '', t: Date.now() });
        if (S.versions.length > 30) S.versions.shift();
        S.vIdx = S.versions.length - 1;
        updateVerUi();
    }

    function iframeUrl() {
        var L = !!H.isLight();
        return ORIGIN + '/?embed=1&proto=json&spin=1&libraries=1&noExitBtn=1&noSaveBtn=1&saveAndExit=0&lang=zh-tw&ui=min&dark=' + (L ? '0' : '1') + '&configure=0';   // 手機：精簡介面
    }
    function post(msg) {
        var fr = $('ndio-frame');
        if (fr && fr.contentWindow) fr.contentWindow.postMessage(JSON.stringify(msg), ORIGIN);
    }
    function loadIntoEditor(xml) {
        S.xml = xml || BLANK;
        if (S.ready) post({ action: 'load', xml: S.xml, autosave: 1, title: S.title });
    }

    function onMessage(ev) {
        if (ev.origin !== ORIGIN || !S.open) return;
        var fr = $('ndio-frame');
        if (!fr || ev.source !== fr.contentWindow) return;
        var m; try { m = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data; } catch (e) { return; }
        if (!m || !m.event) return;
        if (m.event === 'init') {
            S.ready = true; clearTimeout(S.readyTimer);
            var off = $('ndio-offline'); if (off) off.style.display = 'none';
            post({ action: 'load', xml: S.xml, autosave: 1, title: S.title });
            var _st = $('ndio-status'); if (_st && !/^(✅|失敗)/.test(_st.textContent) && !S.busy) setStatus('');   // 編輯器比 AI 晚載入完成時，不要把產生結果的訊息清掉
        } else if (m.event === 'autosave' || m.event === 'save') {
            if (m.xml) {
                toGraphModel(m.xml).then(function (gm) { S.xml = gm; saveRecentSoon(); }).catch(function () { S.xml = m.xml; saveRecentSoon(); });
            }
        } else if (m.event === 'export') {
            var p = S.pendingExport; S.pendingExport = null;
            if (p) p.resolve(m);
        }
    }

    function exportFromEditor(format) {
        return new Promise(function (resolve, reject) {
            if (!S.ready) { reject(new Error('draw.io 編輯器沒有載入（需要網路），只能匯出 .drawio')); return; }
            if (S.pendingExport) S.pendingExport.reject(new Error('被新的匯出取代'));
            S.pendingExport = { resolve: resolve, reject: reject };
            post({ action: 'export', format: format, spinKey: 'export', border: 10, background: format.indexOf('svg') >= 0 ? 'none' : '#ffffff' });
            setTimeout(function () { if (S.pendingExport && S.pendingExport.resolve === resolve) { S.pendingExport = null; reject(new Error('匯出逾時')); } }, 30000);
        });
    }
    function dataUrlBytes(d) {
        var s = String(d || ''), i = s.indexOf(','), head = s.slice(0, i);
        if (/;base64/.test(head)) { var bin = atob(s.slice(i + 1)), u = new Uint8Array(bin.length); for (var k = 0; k < bin.length; k++) u[k] = bin.charCodeAt(k); return u; }
        return new TextEncoder().encode(decodeURIComponent(s.slice(i + 1)));
    }
    async function saveBytes(name, bytes, mime) {
        var P = window.Capacitor && window.Capacitor.Plugins, FS = P && P.Filesystem, SH = P && P.Share;
        var native = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
        if (native && FS) {   // 手機：寫到 Documents/NOVA_Drawio/，再跳分享面板（取消分享不影響已存好的檔案）
            var bin = '', CH = 0x8000;
            for (var i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
            var safe = name.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fff]/g, '_');
            var res = await FS.writeFile({ path: 'NOVA_Drawio/' + safe, data: btoa(bin), directory: 'DOCUMENTS', recursive: true });
            if (res && res.uri && SH) { try { await SH.share({ title: safe, files: [res.uri], dialogTitle: '分享檔案（已存於 Documents/NOVA_Drawio/）' }); } catch (e) { /* 取消分享無妨 */ } }
            return 'Documents/NOVA_Drawio/' + safe;
        }
        var blob = new Blob([bytes], { type: mime }), url = URL.createObjectURL(blob), a = document.createElement('a');
        a.href = url; a.download = name; document.body.appendChild(a); a.click(); document.body.removeChild(a); setTimeout(function () { URL.revokeObjectURL(url); }, 4000); return true;
    }
    function fileBase() { return String(S.title || '圖表').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || '圖表'; }
    async function doExport(kind) {
        try {
            var r;
            if (kind === 'drawio') {
                var gm = await toGraphModel(S.xml);
                r = await saveBytes(fileBase() + '.drawio', new TextEncoder().encode(toMxFile(gm, S.title)), 'application/xml');
            } else {
                setStatus('匯出中…');
                var res = await exportFromEditor(kind === 'png' ? 'xmlpng' : 'xmlsvg');
                r = await saveBytes(fileBase() + '.' + kind, dataUrlBytes(res.data), kind === 'png' ? 'image/png' : 'image/svg+xml');
            }
            setStatus(r ? '✅ 已匯出' + (typeof r === 'string' ? '：' + r : '') : '已取消');
        } catch (e) { setStatus('匯出失敗：' + (e && e.message || e), true); }
    }

    async function runGenerate(isEdit) {
        if (S.busy) return;
        var inp = $('ndio-prompt'), txt = (inp && inp.value || '').trim();
        if (!isEdit && !txt && !S.images.length) { setStatus('請先輸入要畫什麼，或附加一張圖片', true); return; }
        if (isEdit && !txt) { setStatus('請輸入要怎麼修改', true); return; }
        setBusy(true, (isEdit ? '修改中' : '產生中') + '…（' + ((H.modelLabel && H.modelLabel(S.images.length > 0)) || '目前模型') + '）');
        var t0 = Date.now();
        try {
            var v;
            if (isEdit) v = await modify(S.xml, txt);
            else v = await generate(txt, { images: S.images.slice() });
            if (!isEdit && txt && (S.title === '未命名圖表' || !S.versions.length)) {
                S.title = txt.replace(/\s+/g, ' ').slice(0, 30); var ti = $('ndio-title'); if (ti) ti.value = S.title;
            }
            pushVersion(v.xml, (isEdit ? '修改：' : '產生：') + txt.slice(0, 40));
            loadIntoEditor(v.xml);
            saveRecent();
            S.images = []; renderImgs();
            if (inp) inp.value = '';
            if (S.ready) setAi(false);   // 手機：收起輸入區，讓出畫面給編輯器
            setStatus('✅ ' + (isEdit ? '已修改' : '已產生') + '：' + v.vertices + ' 個圖形、' + v.edges + ' 條連線（' + Math.round((Date.now() - t0) / 1000) + ' 秒）'
                + (v.fixes.length ? '；自動修正 ' + v.fixes.length + ' 處' : '') + (S.ready ? '' : '；編輯器沒有載入，可先匯出 .drawio'));
        } catch (e) {
            setStatus('失敗：' + String(e && e.message || e).slice(0, 220), true);
        } finally { setBusy(false); if (S.busy === false && $('ndio-status') && /中…/.test($('ndio-status').textContent)) setStatus(''); }
    }

    function renderImgs() {
        var box = $('ndio-imgs'); if (!box) return;
        box.innerHTML = S.images.map(function (im, i) {
            return '<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:2px 6px;border-radius:6px;border:1px solid ' + theme().border + '">🖼️ ' + esc(im.name || '圖片') + ' <a href="#" data-i="' + i + '" style="color:#ef4444;text-decoration:none">✕</a></span>';
        }).join(' ');
        Array.prototype.forEach.call(box.querySelectorAll('a[data-i]'), function (a) {
            a.onclick = function (e) { e.preventDefault(); S.images.splice(+a.getAttribute('data-i'), 1); renderImgs(); };
        });
    }
    function pickImages() {
        var fi = document.createElement('input'); fi.type = 'file'; fi.accept = 'image/*,application/pdf'; fi.multiple = true;
        fi.onchange = function () {
            Array.prototype.forEach.call(fi.files || [], function (f) {
                if (f.size > 15 * 1024 * 1024) { setStatus('「' + f.name + '」超過 15MB', true); return; }
                var r = new FileReader();
                r.onload = function () { var d = String(r.result); S.images.push({ name: f.name, mime: f.type || 'image/png', b64: d.slice(d.indexOf(',') + 1) }); renderImgs(); };
                r.readAsDataURL(f);
            });
        };
        fi.click();
    }

    function renderRecentMenu() {
        var sel = $('ndio-recent'); if (!sel) return;
        var list = recentList();
        sel.innerHTML = '<option value="">最近的圖（' + list.length + '）</option>' + list.map(function (x) {
            var d = new Date(x.t); return '<option value="' + esc(x.id) + '">' + esc(x.title || '未命名') + '　' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + '</option>';
        }).join('');
    }

    function setAi(on) {
        var p = $('ndio-ai'), t = $('ndio-ai-toggle');
        if (p) p.style.display = on ? 'block' : 'none';
        if (t) t.textContent = on ? 'AI ▴' : 'AI ▾';
    }
    function build() {
        var c = theme();
        var ov = document.createElement('div');
        ov.id = 'ndio-overlay';
        ov.style.cssText = 'position:fixed;inset:0;height:100dvh;z-index:99000;background:' + c.bg + ';display:flex;flex-direction:column;color:' + c.text + ';font-family:inherit;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);box-sizing:border-box';
        var inS = 'padding:6px 8px;border-radius:8px;border:1px solid ' + c.border + ';background:' + c.input + ';color:' + c.text + ';font-size:13px;box-sizing:border-box';
        ov.innerHTML =
            '<div style="display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid ' + c.border + ';background:' + c.panel + '">'
            + '<span style="font-size:16px">🧩</span>'
            + '<input id="ndio-title" value="' + esc(S.title) + '" aria-label="圖表名稱" style="flex:1;min-width:0;' + inS + '">'
            + btn('ndio-ai-toggle', 'AI ▴', '顯示／收起 AI 輸入區', true)
            + btn('ndio-close', '✕', '關閉（圖會留在「最近的圖」）')
            + '</div>'
            + '<div style="display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid ' + c.border + ';background:' + c.panel + ';overflow-x:auto;-webkit-overflow-scrolling:touch">'
            + '<select id="ndio-recent" style="flex:none;max-width:150px;' + inS + ';font-size:12px"></select>'
            + btn('ndio-new', '＋新圖', '開一張空白圖')
            + btn('ndio-prev', '↶', 'AI 產生／修改的上一個版本') + '<span id="ndio-ver" style="flex:none;font-size:11px;white-space:nowrap;color:' + c.sub + '"></span>' + btn('ndio-next', '↷', 'AI 產生／修改的下一個版本')
            + btn('ndio-x-drawio', '.drawio', '匯出 draw.io 檔') + btn('ndio-x-png', 'PNG', '匯出 PNG（內嵌圖檔，可再用 draw.io 編輯）') + btn('ndio-x-svg', 'SVG', '匯出 SVG（內嵌圖檔）')
            + '</div>'
            + '<div id="ndio-ai" style="padding:8px;border-bottom:1px solid ' + c.border + ';background:' + c.panel + '">'
            + '<textarea id="ndio-prompt" rows="2" placeholder="描述要畫的圖（例如：電商下單流程，含付款失敗重試與庫存不足分支）；或描述要怎麼修改目前的圖" style="display:block;width:100%;resize:vertical;min-height:44px;' + inS + '"></textarea>'
            + '<div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;align-items:center">' + btn('ndio-gen', '✨ 產生新圖', '依描述產生一張新圖', true) + btn('ndio-edit', '✏️ 修改目前圖表', '把目前的圖（含你手動改的部分）跟指示一起送給 AI')
            + btn('ndio-img', '🖼️ 看圖重建', '附加白板照片、截圖、手繪草圖或 PDF，重建成可編輯的圖') + '<span id="ndio-imgs"></span></div>'
            + '</div>'
            + '<div id="ndio-status" style="padding:3px 10px;font-size:12px;min-height:18px;color:' + c.sub + '"></div>'
            + '<div style="flex:1;position:relative;min-height:0">'
            + '<iframe id="ndio-frame" src="' + iframeUrl() + '" style="position:absolute;inset:0;width:100%;height:100%;border:0;background:' + c.bg + '" allow="clipboard-read; clipboard-write"></iframe>'
            + '<div id="ndio-offline" style="display:none;position:absolute;inset:0;align-items:center;justify-content:center;flex-direction:column;gap:10px;background:' + c.bg + ';text-align:center;padding:20px">'
            + '<div style="font-size:15px;font-weight:700">draw.io 編輯器載入不了</div>'
            + '<div style="font-size:12px;color:' + c.sub + ';max-width:520px">編輯器從 embed.diagrams.net 載入，需要網路。仍然可以用上面的 AI 產生圖表，再按「.drawio」匯出，之後用 draw.io 開啟。</div>'
            + btn('ndio-retry', '重新載入編輯器', '') + '</div>'
            + '</div>';
        document.body.appendChild(ov);
        Array.prototype.forEach.call(ov.querySelectorAll('button'), function (b) { b.style.flex = 'none'; });

        $('ndio-close').onclick = function () { close(); };
        $('ndio-ai-toggle').onclick = function () { setAi($('ndio-ai').style.display === 'none'); };
        $('ndio-gen').onclick = function () { runGenerate(false); };
        $('ndio-edit').onclick = function () { runGenerate(true); };
        $('ndio-img').onclick = pickImages;
        $('ndio-prompt').onkeydown = function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runGenerate(false); } };
        $('ndio-title').oninput = function () { S.title = this.value.trim() || '未命名圖表'; saveRecentSoon(); };
        $('ndio-x-drawio').onclick = function () { doExport('drawio'); };
        $('ndio-x-png').onclick = function () { doExport('png'); };
        $('ndio-x-svg').onclick = function () { doExport('svg'); };
        $('ndio-prev').onclick = function () { if (S.vIdx > 0) { S.vIdx--; loadIntoEditor(S.versions[S.vIdx].xml); updateVerUi(); setStatus('已切到：' + S.versions[S.vIdx].note); } };
        $('ndio-next').onclick = function () { if (S.vIdx < S.versions.length - 1) { S.vIdx++; loadIntoEditor(S.versions[S.vIdx].xml); updateVerUi(); setStatus('已切到：' + S.versions[S.vIdx].note); } };
        $('ndio-new').onclick = function () { saveRecent(); S.id = null; S.title = '未命名圖表'; $('ndio-title').value = S.title; S.versions = []; S.vIdx = -1; updateVerUi(); loadIntoEditor(BLANK); renderRecentMenu(); setAi(true); setStatus('已開新圖'); };
        $('ndio-recent').onchange = function () {
            var id = this.value; if (!id) return;
            var it = recentList().filter(function (x) { return x.id === id; })[0];
            if (it) { saveRecent(); S.id = it.id; S.title = it.title || '未命名圖表'; $('ndio-title').value = S.title; S.versions = []; S.vIdx = -1; pushVersion(it.xml, '開啟'); loadIntoEditor(it.xml); setAi(false); setStatus('已開啟「' + S.title + '」'); }
            this.value = '';
        };
        $('ndio-retry').onclick = function () { S.ready = false; $('ndio-offline').style.display = 'none'; $('ndio-frame').src = iframeUrl(); armReadyTimer(); };
        renderRecentMenu(); updateVerUi();
    }
    function armReadyTimer() {
        clearTimeout(S.readyTimer);
        S.readyTimer = setTimeout(function () { if (!S.ready && S.open) { var off = $('ndio-offline'); if (off) off.style.display = 'flex'; } }, 20000);
    }
    function open(opts) {
        opts = opts || {};
        if (S.open) doClose(true);
        S.open = true; S.ready = false;
        S.id = opts.id || null; S.title = opts.title || '未命名圖表';
        S.versions = []; S.vIdx = -1; S.images = [];
        S.xml = BLANK;
        build();
        try { history.pushState({ ndio: 1 }, ''); S.hist = true; } catch (e) { S.hist = false; }   // 手機返回鍵 → 關閉
        armReadyTimer();
        var start = Promise.resolve();
        if (opts.xml) {
            setAi(false);
            start = toGraphModel(opts.xml).then(function (gm) { var v = validate(gm); var x = v.ok ? v.xml : gm; pushVersion(x, '開啟'); loadIntoEditor(x); saveRecent(); });
        }
        if (opts.prompt) {
            start.then(function () { var p = $('ndio-prompt'); if (p) p.value = opts.prompt; runGenerate(false); });
        }
    }
    function doClose(silent) {
        if (!S.open) return;
        saveRecent();
        S.open = false; S.ready = false; clearTimeout(S.readyTimer);
        if (S.pendingExport) { S.pendingExport.reject(new Error('已關閉')); S.pendingExport = null; }
        var ov = $('ndio-overlay'); if (ov) ov.remove();
        if (!silent) H.toast('圖表已存到「最近的圖」', 2500);
    }
    function close(silent) {
        if (!S.open) return;
        if (S.hist) { S.hist = false; S.closeSilent = !!silent; try { history.back(); return; } catch (e) { /* 落到下面直接關 */ } }
        doClose(silent);
    }
    window.addEventListener('popstate', function () { if (S.open) { S.hist = false; var s = S.closeSilent; S.closeSilent = false; doClose(s); } });

    // 「+」選單入口（和 TravelAgent／Insight 同一個做法：選單可能被重畫，所以定時補上）
    function addEntry() {
        var grid = document.getElementById('plus-menu'); if (!grid || document.getElementById('nv-drawio-btn')) return;
        var ref = grid.querySelector('button.nv-pm'); if (!ref || !ref.parentNode) return;
        var b = document.createElement('button'); b.id = 'nv-drawio-btn'; b.type = 'button';
        b.className = 'nv-pm flex flex-col items-center justify-center gap-2 p-2 rounded-xl bg-slate-800 border border-orange-400/50 hover:bg-slate-700 text-orange-400 transition-colors active:scale-95'; b.style.setProperty('--pc', '#fb923c');
        b.title = 'draw.io 圖表：用描述或圖片產生可編輯的流程圖／架構圖（也可輸入 /draw 描述）';
        b.innerHTML = '<i class="ph-bold ph-flow-arrow text-xl"></i><span class="text-[10px] font-bold whitespace-nowrap">draw.io 圖表</span>';
        b.onclick = function () { window.openDrawio({}); };
        var tv = document.getElementById('nv-travel-btn');
        if (tv && tv.parentNode === ref.parentNode) tv.parentNode.insertBefore(b, tv.nextSibling); else ref.parentNode.appendChild(b);
    }

    // ─────────────────────────── 對話裡的 draw.io 程式碼區塊 ───────────────────────────
    function scanChat(rootEl) {
        var codes = (rootEl || document).querySelectorAll('pre code, pre, .msg-content code');   // 手機的對話有時把 ```xml 區塊畫成單獨的 <code>（沒有 <pre>）
        Array.prototype.forEach.call(codes, function (el) {
            var pre = el.tagName === 'PRE' ? el : (el.closest('pre') || el);
            if (!pre || pre.getAttribute('data-ndio') || pre.closest('#ndio-overlay')) return;
            var txt = el.textContent || '';
            if (txt.length < 40 || !/<mx(GraphModel|file)[\s>]/.test(txt)) return;
            pre.setAttribute('data-ndio', '1');
            var b = document.createElement('button');
            b.type = 'button';
            b.textContent = '🧩 在 draw.io 開啟';
            b.style.cssText = 'display:block;margin:4px 0;padding:4px 10px;border-radius:8px;border:1px solid #6366f1;background:#6366f1;color:#fff;font-size:12px;font-weight:600;cursor:pointer';
            b.onclick = function (e) { e.preventDefault(); e.stopPropagation(); var x = extractXml(el.textContent || ''); if (!x) { H.toast('這段內容不是完整的 draw.io 圖'); return; } open({ xml: x, title: '對話裡的圖表' }); };
            pre.parentNode.insertBefore(b, pre);
        });
    }
    var _scanT = null;
    function watchChat() {
        try {
            var mo = new MutationObserver(function () { clearTimeout(_scanT); _scanT = setTimeout(function () { scanChat(document); }, 600); });
            mo.observe(document.body, { childList: true, subtree: true });
            scanChat(document);
        } catch (e) { /* */ }
    }

    window.addEventListener('message', onMessage);
    function boot() { watchChat(); addEntry(); setInterval(addEntry, 3000); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

    window.NovaDrawio = {
        version: '1.0.0',
        init: function (h) { Object.keys(h || {}).forEach(function (k) { if (h[k] != null) H[k] = h[k]; }); },
        open: open, close: close, generate: generate, modify: modify,
        isOpen: function () { return S.open; },
        _setImages: function (arr) { S.images = (arr || []).slice(0, 6); renderImgs(); },
        current: function () { return S.xml; },
        _validate: validate, _extractXml: extractXml, _toGraphModel: toGraphModel, _toMxFile: toMxFile
    };
    window.openDrawio = function (o) {
        try { document.getElementById('plus-menu').classList.add('hidden'); document.getElementById('plus-icon').classList.remove('rotate-45'); } catch (e) { /* */ }
        open(o || {});
    };
})();

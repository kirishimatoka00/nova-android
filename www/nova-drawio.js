/*
  ════════════════════════════════════════════════════════════════
  nova-drawio.js — NOVA Android：內嵌 draw.io 編輯器＋用 NOVA 的模型直接產生／修改 draw.io 圖表＋對話圖卡＋Mermaid＋圖庫備份與雲端同步
  ════════════════════════════════════════════════════════════════
  目前版本：v1.1.0（Android）
  最後更新：2026-11-18（App v2.6.150）
  對標桌面 nova-drawio.js v1.3.0（nova-desktop/src，2026-11-17）：XML 檢查、Mermaid 解析與排版、圖庫、對話圖卡、背景轉檔、雲端同步的程式與桌面相同；
  差異在檔案存取（Capacitor Filesystem）、版面（手機直向）、分享與入口。

  版本紀錄（只記這個檔案自己的變更）：
  v1.1.0 - App v2.6.150（使用者要求：移植 nova-desktop「draw.io 對話圖卡＋Mermaid」與「draw.io 雲端同步」）。以桌面 v1.1.0～v1.3.0 為底重新整合：
           ① AI 可用的畫圖工具 NovaDrawio.tool({description | xml | mermaid, title?, png?})：只有描述就呼叫目前模型產生；有 XML 只檢查修正；Mermaid flowchart 本機排版。
              存進圖庫並寫成 Documents/NOVA/圖表/<標題>_<時間>.drawio（png:true 另存 PNG）。
           ② 對話圖卡：```drawio／```draw.io／```mxgraph／```mermaid 區塊（nova-app-main.js v1.5.9 的 formatMessage 換成 .nova-drawio-card 佔位）變成圖卡——
              預覽圖、✏️ 開啟編輯、📤 分享檔案、🖼️ 匯出 PNG。描述型只對 15 分鐘內的 AI 回覆自動產生，舊訊息顯示「產生這張圖」；同一段內容只產生一次
              （nova_drawio_chatmap）。localStorage nova_drawio_chat_tool='0' 可關閉對話裡的自動畫圖。
           ③ Mermaid：flowchart／graph 本機解析並自動分層排版（不用呼叫模型）；其他類型（時序、類別、ER、狀態、甘特、心智圖…）交給模型轉；
              其他地方的 Mermaid 程式碼區塊上方多「🧩 轉成 draw.io 圖」；編輯器描述框貼 Mermaid 按「產生新圖」＝本機轉換；AI 產生單純流程圖時可以用 Mermaid 回答
              （nova_drawio_mermaid='0' 可關閉）。
           ④ 圖庫 nova_drawio_store 取代 v1.0.0 的 nova_drawio_recent（自動搬移），最多 60 張、約 3.5MB。背景隱藏的 draw.io 頁面產生預覽圖（需要網路）。
           ⑤ 本機備份：每張圖有變動約 2 秒後寫成 Documents/NOVA/圖表/圖庫/<標題>_<編號>.drawio（另有 _index.json）；被擠出圖庫的舊圖檔案還在，
              「最近的圖」選單下方列出「備份資料夾裡的其他圖」；圖庫是空的（重裝、清資料）時自動從備份讀回。雲端刪除的圖移到 圖庫/_已刪除。
              （Android 11 以上，重新安裝後讀不讀得到舊檔案取決於「所有檔案存取」權限；讀不到就只靠雲端。）
           ⑥ 雲端同步：NovaDataSync 供應者 'drawio'（Google Drive 上的 NOVA_Drawio_Sync.json，跟桌面同一個檔案、互通），三方比對、刪除會傳播、大量刪除略過；
              被擠出圖庫的圖標成「這輪讀不到」不當刪除。跟著 Drive 同步一起跑；子開關在 Google 整合 → Drive 同步（nova-google.js v1.8.0）；編輯器「☁️」可立即同步。
           【和桌面版不同的地方】
           ・檔案存取：用 Capacitor Filesystem 模擬桌面用到的 Tauri 檔案介面（documentDir／join／mkdir／readTextFile／writeTextFile／writeFile／remove／rename），
             備份與存檔邏輯照搬；路徑一律在手機的 Documents 底下。v1.0.0 的匯出資料夾 Documents/NOVA_Drawio/ 改成 Documents/NOVA/圖表/（跟桌面一致）。
           ・匯出與圖卡的「顯示檔案」改成存檔後跳出分享面板（@capacitor/share，App v2.6.150 起有安裝）；「📁」顯示備份資料夾路徑（手機不能直接開資料夾）。
           ・版面沿用 v1.0.0 的手機直向設計（AI 區可收合、工具列可左右滑），draw.io 用精簡介面 ui=min；手機返回鍵關閉視窗。
           ・模型呼叫由 index.html 的接線透過 fetchAIResponse 提供。
           【限制】編輯器、預覽圖、PNG／SVG 匯出需要網路（embed.diagrams.net）；離線仍可 AI 產生、Mermaid 本機轉換、存 .drawio。只在電腦瀏覽器用模擬環境測過，未在真機驗證。
  v1.0.0 - App v2.6.148 新增。移植桌面 v1.0.0（內嵌編輯器、AI 產生／修改、看圖重建、版本、最近的圖、匯出、對話裡 XML 區塊的「在 draw.io 開啟」按鈕）。
           入口：「+」選單「draw.io 圖表」、指令 /draw。做法借鏡 DayuanJiang/next-ai-draw-io（Apache-2.0），沒有安裝它的程式。
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

    // ─────────────────────────── v1.3.0：Mermaid → draw.io ───────────────────────────
    // flowchart／graph 在本機解析＋自動分層排版（不用呼叫模型、立即完成）；其他 Mermaid 類型（時序、類別、ER、狀態、甘特、心智圖…）交給目前的模型轉成 draw.io。
    var MM_KINDS = /^(flowchart|graph|sequenceDiagram|classDiagram(-v2)?|stateDiagram(-v2)?|erDiagram|gantt|pie|mindmap|journey|gitGraph|timeline|quadrantChart|requirementDiagram|C4[A-Za-z]+|block-beta|sankey-beta|xychart-beta|architecture-beta|packet-beta|kanban)\b/;
    function mermaidBody(t) {
        var s = String(t || '').replace(/\r/g, '');
        var f = /```[ \t]*mermaid[^\n]*\n([\s\S]*?)```/i.exec(s); if (f) s = f[1];
        s = s.replace(/^\s*---\n[\s\S]*?\n---[ \t]*\n/, '');            // YAML 前置設定
        s = s.replace(/^\s*%%\{[\s\S]*?\}%%[ \t]*\n?/, '');              // %%{init}%%
        s = s.replace(/^(\s*%%[^\n]*\n)+/, '');                         // 開頭的註解
        return s.trim();
    }
    function isMermaid(t) { return MM_KINDS.test(mermaidBody(t)); }
    function splitTop(line) {   // 只在括號、引號外面的分號切開
        var out = [], cur = '', depth = 0, q = false;
        for (var i = 0; i < line.length; i++) {
            var c = line.charAt(i);
            if (c === '"') q = !q;
            else if (!q && '[({'.indexOf(c) >= 0) depth++;
            else if (!q && '])}'.indexOf(c) >= 0) depth = Math.max(0, depth - 1);
            if (c === ';' && !q && depth === 0) { out.push(cur); cur = ''; } else cur += c;
        }
        out.push(cur); return out;
    }
    var MM_SHAPES = [   // 由長到短比對
        ['(((', ')))', 'dcircle'], ['([', '])', 'stadium'], ['[[', ']]', 'subroutine'], ['[(', ')]', 'cylinder'], ['((', '))', 'circle'],
        ['{{', '}}', 'hexagon'], ['[/', '/]', 'para'], ['[\\', '\\]', 'para_alt'], ['[/', '\\]', 'trap'], ['[\\', '/]', 'trap_alt'],
        ['>', ']', 'asym'], ['[', ']', 'rect'], ['(', ')', 'round'], ['{', '}', 'diamond']
    ];
    function mmText(s) {
        s = String(s == null ? '' : s).trim();
        if (/^"[\s\S]*"$/.test(s)) s = s.slice(1, -1);
        if (/^`[\s\S]*`$/.test(s)) s = s.slice(1, -1);
        return s.replace(/#quot;/g, '"').replace(/#amp;/g, '&').replace(/#lt;/g, '<').replace(/#gt;/g, '>').replace(/#35;/g, '#')
            .replace(/<br\s*\/?>/gi, '\n').replace(/\\n/g, '\n').replace(/\*\*([^*]+)\*\*/g, '$1');
    }
    function parseFlow(src) {
        var lines = mermaidBody(src).split('\n');
        var head = (lines.shift() || '').trim();
        var hm = /^(flowchart|graph)\b[ \t]*(TB|TD|BT|LR|RL)?/i.exec(head);
        if (!hm) return null;
        var dir = (hm[2] || 'TD').toUpperCase(); if (dir === 'TB') dir = 'TD';
        var rest = head.slice(hm[0].length).replace(/^\s*;/, '').trim(); if (rest) lines.unshift(rest);
        var G = { dir: dir, nodes: {}, order: [], edges: [], groups: [] }, stack = [];
        function node(id) {
            if (!G.nodes[id]) { G.nodes[id] = { id: id, text: id, shape: 'rect' }; G.order.push(id); }
            if (stack.length) {   // 同一個節點出現在多個子圖：以最後一個為準（同 Mermaid）
                var g = stack[stack.length - 1];
                if (g.members.indexOf(id) < 0) { G.groups.forEach(function (o) { var k = o.members.indexOf(id); if (k >= 0) o.members.splice(k, 1); }); g.members.push(id); }
            }
            return G.nodes[id];
        }
        var ID_RE = /^\s*([A-Za-z0-9_À-￿][\wÀ-￿.]*)/;
        function parseNode(s, pos) {
            var m = ID_RE.exec(s.slice(pos)); if (!m) return null;
            var id = m[1], p = pos + m[0].length, n = node(id);
            for (var i = 0; i < MM_SHAPES.length; i++) {
                var sh = MM_SHAPES[i];
                if (s.substr(p, sh[0].length) !== sh[0]) continue;
                var q = p + sh[0].length, end = -1;
                if (s.charAt(q) === '"') { var cq = s.indexOf('"', q + 1); if (cq > 0 && s.substr(cq + 1, sh[1].length) === sh[1]) end = cq + 1; }
                if (end < 0) end = s.indexOf(sh[1], q);
                if (end < 0) continue;
                n.text = mmText(s.slice(q, end)); n.shape = sh[2];
                p = end + sh[1].length; break;
            }
            var cls = /^:::[\w-]+/.exec(s.slice(p)); if (cls) p += cls[0].length;
            return { id: id, pos: p };
        }
        function parseGroup(s, pos) {
            var ids = [], r = parseNode(s, pos); if (!r) return null;
            ids.push(r.id); pos = r.pos;
            for (;;) {
                var a = /^\s*&\s*/.exec(s.slice(pos)); if (!a) break;
                var r2 = parseNode(s, pos + a[0].length); if (!r2) break;
                ids.push(r2.id); pos = r2.pos;
            }
            return { ids: ids, pos: pos };
        }
        var LABELED = /^\s*(<)?(--|==|-\.)\s+(.+?)\s+(-{2,}[>ox]|={2,}>|\.-+>|-{3,}|={3,}|\.-+)(?![-=.>])\s*/;
        var PLAIN = /^\s*(<)?(-\.+-|-{2,}|={2,})([>ox])?(?![-=.>])\s*(?:\|([^|]*)\|)?\s*/;
        var INVIS = /^\s*~{3,}\s*/;
        function parseEdge(s, pos) {
            var t = s.slice(pos), m;
            if ((m = INVIS.exec(t))) return { len: m[0].length, invisible: true };
            if ((m = LABELED.exec(t)) && !/^\|/.test(m[3])) {
                var body = m[2] + m[4];
                return { len: m[0].length, label: mmText(m[3]), bi: !!m[1], dotted: body.indexOf('.') >= 0, thick: body.indexOf('=') >= 0, head: /[>ox]$/.test(m[4]) ? m[4].slice(-1) : '' };
            }
            if ((m = PLAIN.exec(t))) return { len: m[0].length, label: m[4] ? mmText(m[4]) : '', bi: !!m[1], dotted: m[2].indexOf('.') >= 0, thick: m[2].charAt(0) === '=', head: m[3] || '' };
            return null;
        }
        lines.forEach(function (line) {
            splitTop(line).forEach(function (st) {
                st = st.trim();
                if (!st || /^%%/.test(st)) return;
                var sg = /^subgraph\s+(.+)$/.exec(st);
                if (sg) {
                    var body = sg[1].trim(), gm = /^([\wÀ-￿.-]+)\s*\[(.*)\]$/.exec(body);
                    var g = gm ? { id: gm[1], title: mmText(gm[2]), members: [] } : { id: /^[\w.-]+$/.test(body) ? body : 'sg' + G.groups.length, title: mmText(body), members: [] };
                    g.parent = stack.length ? stack[stack.length - 1] : null;
                    G.groups.push(g); stack.push(g); return;
                }
                if (/^end$/.test(st)) { stack.pop(); return; }
                if (/^(classDef|class|style|linkStyle|click|direction|accTitle|accDescr)\b/.test(st)) return;
                var pos = 0, prev = parseGroup(st, 0); if (!prev) return;
                pos = prev.pos;
                for (;;) {
                    var e = parseEdge(st, pos); if (!e) break;
                    var nx = parseGroup(st, pos + e.len); if (!nx) break;
                    if (!e.invisible) prev.ids.forEach(function (a) { nx.ids.forEach(function (b) { G.edges.push({ from: a, to: b, label: e.label, bi: e.bi, dotted: e.dotted, thick: e.thick, head: e.head }); }); });
                    prev = nx; pos = nx.pos;
                }
            });
        });
        // subgraph 也可以被當成節點連線：把指向群組 id 的連線改指到群組的第一個成員
        G.groups.forEach(function (g) {
            if (!G.nodes[g.id] || !g.members.length) return;
            var inner = g.members.filter(function (m) { return m !== g.id; });
            if (!inner.length) return;
            G.edges.forEach(function (e) { if (e.from === g.id) e.from = inner[inner.length - 1]; if (e.to === g.id) e.to = inner[0]; });
            delete G.nodes[g.id]; G.order = G.order.filter(function (x) { return x !== g.id; });
            G.groups.forEach(function (g2) { g2.members = g2.members.filter(function (x) { return x !== g.id; }); });
        });
        return G.order.length ? G : null;
    }
    function textW(s) { var w = 0; for (var i = 0; i < s.length; i++) w += /[⺀-￿]/.test(s.charAt(i)) ? 14 : 7.5; return w; }
    function nodeSize(n) {
        var ls = String(n.text || '').split('\n'), maxW = 0, lines = 0;
        ls.forEach(function (l) { var w = textW(l); maxW = Math.max(maxW, Math.min(w, 210)); lines += Math.max(1, Math.ceil(w / 210)); });
        var w = Math.max(100, Math.round(maxW + 36)), h = Math.max(50, 22 * lines + 20);
        if (n.shape === 'diamond') { w = Math.round(w * 1.45); h = Math.max(80, Math.round(h * 1.6)); }
        else if (n.shape === 'circle' || n.shape === 'dcircle') { w = h = Math.max(70, Math.max(w, h)); }
        else if (n.shape === 'hexagon' || n.shape === 'para' || n.shape === 'para_alt' || n.shape === 'trap' || n.shape === 'trap_alt' || n.shape === 'asym') w += 30;
        else if (n.shape === 'cylinder') h += 16;
        return { w: Math.ceil(w / 10) * 10, h: Math.ceil(h / 10) * 10 };
    }
    function layoutFlow(G) {
        var ids = G.order, succ = {}, pred = {};
        ids.forEach(function (id) { succ[id] = []; pred[id] = []; });
        var dag = [];
        // 去掉造成循環的連線（只影響分層，不影響畫出來的連線）
        var state = {}, back = {};
        G.edges.forEach(function (e, i) { if (e.from !== e.to && succ[e.from] && succ[e.to]) succ[e.from].push({ to: e.to, i: i }); });
        function dfs(u) { state[u] = 1; succ[u].forEach(function (x) { if (state[x.to] === 1) back[x.i] = 1; else if (!state[x.to]) dfs(x.to); }); state[u] = 2; }
        ids.forEach(function (u) { if (!state[u]) dfs(u); });
        ids.forEach(function (id) { succ[id] = []; });
        G.edges.forEach(function (e, i) { if (e.from !== e.to && !back[i] && succ[e.from] && succ[e.to]) { succ[e.from].push(e.to); pred[e.to].push(e.from); dag.push(e); } });
        var layer = {}, indeg = {}, q = [];
        ids.forEach(function (id) { indeg[id] = pred[id].length; layer[id] = 0; if (!indeg[id]) q.push(id); });
        while (q.length) { var u = q.shift(); succ[u].forEach(function (v) { layer[v] = Math.max(layer[v], layer[u] + 1); if (--indeg[v] === 0) q.push(v); }); }
        var L = []; ids.forEach(function (id) { (L[layer[id]] = L[layer[id]] || []).push(id); });
        L = L.filter(function (x) { return x && x.length; });
        var posIn = {};
        function idx() { L.forEach(function (row) { row.forEach(function (id, i) { posIn[id] = i; }); }); }
        idx();
        for (var sweep = 0; sweep < 6; sweep++) {
            var down = sweep % 2 === 0;
            var rows = down ? L.slice(1) : L.slice(0, -1).reverse();
            rows.forEach(function (row) {
                var bc = {};
                row.forEach(function (id) {
                    var nb = down ? pred[id] : succ[id];
                    bc[id] = nb.length ? nb.reduce(function (s, x) { return s + posIn[x]; }, 0) / nb.length : posIn[id];
                });
                row.sort(function (a, b) { return bc[a] - bc[b] || posIn[a] - posIn[b]; });
                row.forEach(function (id, i) { posIn[id] = i; });
            });
        }
        var horiz = G.dir === 'LR' || G.dir === 'RL', rev = G.dir === 'BT' || G.dir === 'RL';
        var size = {}; ids.forEach(function (id) { size[id] = nodeSize(G.nodes[id]); });
        var GAP_MAIN = G.groups.length ? 90 : 70, GAP_CROSS = G.groups.length ? 60 : 40;
        var mainOf = function (id) { return horiz ? size[id].w : size[id].h; }, crossOf = function (id) { return horiz ? size[id].h : size[id].w; };
        var rowMain = L.map(function (row) { return Math.max.apply(null, row.map(mainOf)); });
        var rowCross = L.map(function (row) { return row.reduce(function (s, id) { return s + crossOf(id); }, 0) + GAP_CROSS * (row.length - 1); });
        var maxCross = Math.max.apply(null, rowCross);
        var P = {}, m0 = 40;
        L.forEach(function (row, li) {
            var c = 40 + (maxCross - rowCross[li]) / 2;
            row.forEach(function (id) {
                var mm = m0 + (rowMain[li] - mainOf(id)) / 2;
                P[id] = horiz ? { x: mm, y: c } : { x: c, y: mm };
                c += crossOf(id) + GAP_CROSS;
            });
            m0 += rowMain[li] + GAP_MAIN;
        });
        if (rev) {
            var total = m0 - GAP_MAIN + 40;
            ids.forEach(function (id) { if (horiz) P[id].x = total - P[id].x - size[id].w; else P[id].y = total - P[id].y - size[id].h; });
        }
        ids.forEach(function (id) { P[id].x = Math.round(P[id].x / 10) * 10; P[id].y = Math.round(P[id].y / 10) * 10; });
        return { P: P, size: size, horiz: horiz };
    }
    var MM_STYLE = {
        rect: 'rounded=0;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;',
        round: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;',
        stadium: 'rounded=1;arcSize=50;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;',
        subroutine: 'shape=process;whiteSpace=wrap;html=1;backgroundOutline=1;fillColor=#dae8fc;strokeColor=#6c8ebf;',
        cylinder: 'shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=12;fillColor=#e1d5e7;strokeColor=#9673a6;',
        circle: 'ellipse;whiteSpace=wrap;html=1;aspect=fixed;fillColor=#d5e8d4;strokeColor=#82b366;',
        dcircle: 'ellipse;shape=doubleEllipse;whiteSpace=wrap;html=1;aspect=fixed;fillColor=#d5e8d4;strokeColor=#82b366;',
        diamond: 'rhombus;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;',
        hexagon: 'shape=hexagon;perimeter=hexagonPerimeter2;whiteSpace=wrap;html=1;fixedSize=1;fillColor=#ffe6cc;strokeColor=#d79b00;',
        para: 'shape=parallelogram;perimeter=parallelogramPerimeter;whiteSpace=wrap;html=1;fixedSize=1;fillColor=#dae8fc;strokeColor=#6c8ebf;',
        para_alt: 'shape=parallelogram;perimeter=parallelogramPerimeter;whiteSpace=wrap;html=1;fixedSize=1;flipH=1;fillColor=#dae8fc;strokeColor=#6c8ebf;',
        trap: 'shape=trapezoid;perimeter=trapezoidPerimeter;whiteSpace=wrap;html=1;fixedSize=1;fillColor=#dae8fc;strokeColor=#6c8ebf;',
        trap_alt: 'shape=trapezoid;perimeter=trapezoidPerimeter;whiteSpace=wrap;html=1;fixedSize=1;flipV=1;fillColor=#dae8fc;strokeColor=#6c8ebf;',
        asym: 'shape=step;perimeter=stepPerimeter;whiteSpace=wrap;html=1;fixedSize=1;size=12;fillColor=#f8cecc;strokeColor=#b85450;'
    };
    function xa(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&lt;br&gt;'); }
    function flowToXml(G) {
        var lay = layoutFlow(G), P = lay.P, S0 = lay.size, out = [], n = 0;
        var cid = {}; G.order.forEach(function (id) { cid[id] = 'n' + (++n); });
        var maxX = 0, maxY = 0;
        G.order.forEach(function (id) { maxX = Math.max(maxX, P[id].x + S0[id].w); maxY = Math.max(maxY, P[id].y + S0[id].h); });
        // 分組框（畫在最底層）
        function allMem(g) { var a = g.members.slice(); G.groups.forEach(function (c) { if (c.parent === g) a = a.concat(allMem(c)); }); return a; }
        function depthBelow(g) { var d = 0; G.groups.forEach(function (c) { if (c.parent === g) d = Math.max(d, 1 + depthBelow(c)); }); return d; }
        G.groups.forEach(function (g, gi) {
            var mem = allMem(g).filter(function (m) { return P[m]; }); if (!mem.length) return;
            var x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
            mem.forEach(function (m) { x1 = Math.min(x1, P[m].x); y1 = Math.min(y1, P[m].y); x2 = Math.max(x2, P[m].x + S0[m].w); y2 = Math.max(y2, P[m].y + S0[m].h); });
            var db = depthBelow(g), pad = 20 + 18 * db, top = 30 + 30 * db;
            out.push('<mxCell id="g' + (gi + 1) + '" value="' + xa(g.title || g.id) + '" style="rounded=1;arcSize=4;whiteSpace=wrap;html=1;fillColor=#f5f5f5;strokeColor=#999999;dashed=1;verticalAlign=top;align=left;spacingLeft=8;fontStyle=1;fontColor=#333333;" vertex="1" parent="1"><mxGeometry x="' + (x1 - pad) + '" y="' + (y1 - pad - top) + '" width="' + (x2 - x1 + pad * 2) + '" height="' + (y2 - y1 + pad * 2 + top) + '" as="geometry"/></mxCell>');
        });
        G.order.forEach(function (id) {
            var nd = G.nodes[id];
            out.push('<mxCell id="' + cid[id] + '" value="' + xa(nd.text) + '" style="' + (MM_STYLE[nd.shape] || MM_STYLE.rect) + '" vertex="1" parent="1"><mxGeometry x="' + P[id].x + '" y="' + P[id].y + '" width="' + S0[id].w + '" height="' + S0[id].h + '" as="geometry"/></mxCell>');
        });
        var e = 0;
        G.edges.forEach(function (ed) {
            if (!cid[ed.from] || !cid[ed.to]) return;
            var head = ed.head === 'o' ? 'oval' : ed.head === 'x' ? 'cross' : ed.head === '>' ? 'block' : 'none';
            var st = 'edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;endArrow=' + head + ';endFill=' + (head === 'cross' ? 0 : 1) + ';'
                + (ed.bi ? 'startArrow=block;startFill=1;' : '') + (ed.dotted ? 'dashed=1;' : '') + (ed.thick ? 'strokeWidth=3;' : '') + (ed.label ? 'labelBackgroundColor=#ffffff;' : '');
            out.push('<mxCell id="e' + (++e) + '" value="' + xa(ed.label) + '" style="' + st + '" edge="1" parent="1" source="' + cid[ed.from] + '" target="' + cid[ed.to] + '"><mxGeometry relative="1" as="geometry"/></mxCell>');
        });
        var pw = Math.max(850, Math.ceil((maxX + 60) / 10) * 10), ph = Math.max(1100, Math.ceil((maxY + 60) / 10) * 10);
        return '<mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="' + pw + '" pageHeight="' + ph + '"><root><mxCell id="0"/><mxCell id="1" parent="0"/>' + out.join('') + '</root></mxGraphModel>';
    }
    function mermaidLocal(src) {   // 本機轉得了就回傳驗證過的結果，否則 null
        var G = null; try { G = parseFlow(src); } catch (e) { G = null; }
        if (!G) return null;
        var v = validate(flowToXml(G)); if (!v.ok) return null;
        v.local = true; v.mermaid = true; return v;
    }
    async function fromMermaid(src) {
        var v = mermaidLocal(src); if (v) return v;
        var body = mermaidBody(src);
        if (!MM_KINDS.test(body)) throw new Error('這段內容不是 Mermaid 圖（第一行要是 flowchart、graph、sequenceDiagram、classDiagram、erDiagram、stateDiagram、gantt、mindmap 等）');
        var kind = (MM_KINDS.exec(body) || [''])[0];
        var r = await askModel('請把這段 Mermaid（' + kind + '）圖轉成等效、版面整齊的 draw.io 圖：保留所有節點、文字、連線方向與標籤、分組；'
            + (kind === 'sequenceDiagram' ? '時序圖用 UML 生命線（shape=umlLifeline）與訊息箭頭，訊息由上到下依序排列。' : '')
            + (kind === 'erDiagram' || /^classDiagram/.test(kind) ? '實體／類別用表格樣式（swimlane 加欄位列），關聯線標示基數。' : '')
            + '\n```mermaid\n' + body + '\n```', [], 'drawio-mermaid');
        r.local = false; r.mermaid = true; return r;
    }
    function mermaidTitle(src) {
        var b = mermaidBody(src), t = /^\s*title[:\s]+(.+)$/m.exec(b) || /accTitle:\s*(.+)$/m.exec(b) || /^---\ntitle:\s*(.+)$/m.exec(String(src || ''));
        if (t) return t[1].trim().slice(0, 40);
        var G = null; try { G = parseFlow(src); } catch (e) { /* */ }
        if (G && G.order.length) return (G.nodes[G.order[0]].text || '').split('\n')[0].slice(0, 24) + ' 流程圖';
        return 'Mermaid 圖表';
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

    async function askModel(userText, images, purpose, allowMm) {
        if (typeof H.llm !== 'function') throw new Error('NOVA 模型呼叫尚未就緒');
        var raw = await H.llm({ system: SYSTEM, user: userText, images: images || [], purpose: purpose || 'drawio' });
        if (allowMm && !/<mxGraphModel/.test(String(raw || ''))) { var mv = mermaidLocal(raw); if (mv) return mv; }   // v1.3.0：模型用 Mermaid 回答
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
        var allowMm = !(opts.images && opts.images.length) && mmAllowed();
        if (allowMm) prompt += '\n\n（如果這是單純的流程圖——步驟、判斷、分支、可以有分組——也可以只輸出 Mermaid flowchart 語法，放在 ```mermaid 區塊裡，系統會自動排版成 draw.io 圖；'
            + '架構圖、泳道圖、需要指定位置、雲端圖示或特殊樣式的圖，照常輸出 mxGraphModel XML。）';
        return askModel(prompt, opts.images, opts.images && opts.images.length ? 'drawio-image' : 'drawio', allowMm);
    }
    function mmAllowed() { try { return localStorage.getItem('nova_drawio_mermaid') !== '0'; } catch (e) { return true; } }
    async function modify(currentXml, instruction) {
        var cur = await toGraphModel(currentXml);
        if (cur.length > 150000) throw new Error('目前的圖太大（' + Math.round(cur.length / 1000) + 'K 字元），請拆成幾張圖再請 AI 修改');
        return askModel('這是目前的 draw.io 圖表：\n' + cur + '\n\n請依照這個指示修改，回傳完整的新 mxGraphModel：\n' + String(instruction || '').trim(), [], 'drawio-edit');
    }
    function toMxFile(gm, name) {
        return '<mxfile host="NOVA" agent="NOVA Android"><diagram id="nova-' + Date.now().toString(36) + '" name="' + esc(name || 'Page-1') + '">' + gm + '</diagram></mxfile>';
    }

    // ─────────────────────────── 圖庫（v1.1.0：取代只存 15 張的 nova_drawio_recent）───────────────────────────
    // localStorage nova_drawio_store：{ id: {title, xml, t, svg?, path?, desc?, hash?} }，依最近使用排序，最多 60 張、約 3.5MB（超過丟最舊的）
    // localStorage nova_drawio_chatmap：{ 內容雜湊: id } —— 對話裡的 ```drawio 區塊只產生一次，重新整理／切換對話不會再花一次模型呼叫
    var LS_STORE = 'nova_drawio_store', LS_MAP = 'nova_drawio_chatmap', MAX_STORE = 60, MAX_BYTES = 3500000;
    function loadStore() {
        var st = null;
        try { st = JSON.parse(localStorage.getItem(LS_STORE) || 'null'); } catch (e) { st = null; }
        if (!st || typeof st !== 'object') {
            st = {};
            try {   // 從 v1.0.0 的 nova_drawio_recent 搬過來
                var old = JSON.parse(localStorage.getItem(LS_RECENT) || '[]');
                (Array.isArray(old) ? old : []).forEach(function (x) { if (x && x.id && x.xml) st[x.id] = { title: x.title, xml: x.xml, t: x.t || Date.now() }; });
            } catch (e) { /* */ }
        }
        return st;
    }
    function saveStore(st) {
        var ids = Object.keys(st).sort(function (a, b) { return (st[b].t || 0) - (st[a].t || 0); });
        var ev0 = Object.keys(st);
        try { return saveStore0(st, ids); }
        finally {   // v1.2.0：記下這次被擠掉的編號（備份資料夾裡還有檔案）
            var gone = ev0.filter(function (k) { return !(k in st); });
            if (gone.length) { var a = evictedList(); gone.forEach(function (k) { if (a.indexOf(k) < 0) a.push(k); }); setEvicted(a); }
        }
    }
    function saveStore0(st, ids) {
        while (ids.length > MAX_STORE) delete st[ids.pop()];
        for (var i = 0; i < 40; i++) {
            var str = JSON.stringify(st);
            if (str.length <= MAX_BYTES) {
                try { localStorage.setItem(LS_STORE, str); return true; } catch (e) { /* 配額不夠 → 丟最舊的再試 */ }
            }
            var victim = ids.pop(); if (!victim) break;
            if (st[victim] && st[victim].svg && ids.length > 5) { delete st[victim].svg; ids.push(victim); continue; }   // 先丟預覽圖
            delete st[victim];
        }
        return false;
    }
    function getDiagram(id) { var st = loadStore(); return st[id] || null; }
    function putDiagram(id, patch) {
        var st = loadStore();
        var cur = st[id] || {};
        var content = !st[id] || ['xml', 'title', 'desc'].some(function (k) { return k in (patch || {}) && (patch[k] || '') !== (cur[k] || ''); });   // v1.2.0
        Object.keys(patch || {}).forEach(function (k) { cur[k] = patch[k]; });
        cur.t = Date.now();
        if (content) cur.updated = cur.t;
        st[id] = cur; unEvict(id); saveStore(st);
        if (content && cur.xml) { bkMark(id); syncTouch(); }
        return cur;
    }
    // ─────────── v1.2.0：被擠出圖庫的編號（雲端同步時標成「讀不到」而不是「刪除」；開機還原時不硬塞回來）───────────
    var LS_EVICT = 'nova_drawio_evicted';
    function evictedList() { try { var a = JSON.parse(localStorage.getItem(LS_EVICT) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
    function setEvicted(a) { try { localStorage.setItem(LS_EVICT, JSON.stringify(a.slice(-500))); } catch (e) { /* */ } }
    function unEvict(id) { var a = evictedList(), i = a.indexOf(id); if (i >= 0) { a.splice(i, 1); setEvicted(a); } }
    function syncTouch() { try { if (window.NovaDataSync && window.NovaDataSync.touch) window.NovaDataSync.touch(); } catch (e) { /* */ } }
    function newId() { return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
    function recentList() {
        var st = loadStore();
        return Object.keys(st).map(function (id) { return { id: id, title: st[id].title, xml: st[id].xml, t: st[id].t }; })
            .sort(function (a, b) { return b.t - a.t; });
    }
    function chatMap(hash, id) {
        var m = {}; try { m = JSON.parse(localStorage.getItem(LS_MAP) || '{}') || {}; } catch (e) { m = {}; }
        if (id === undefined) return m[hash] || null;
        m[hash] = id;
        var ks = Object.keys(m); if (ks.length > 300) ks.slice(0, ks.length - 300).forEach(function (k) { delete m[k]; });
        try { localStorage.setItem(LS_MAP, JSON.stringify(m)); } catch (e) { /* */ }
        return id;
    }
    function hashText(t) { var h = 5381, s = String(t || ''); for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return 'h' + (h >>> 0).toString(36) + s.length.toString(36); }
    function saveRecent() {
        if (!S.id) S.id = newId();
        if (!S.xml || S.xml === BLANK) return;
        var cur = getDiagram(S.id);
        var changed = !cur || cur.xml !== S.xml;
        putDiagram(S.id, changed ? { title: S.title, xml: S.xml, svg: null } : { title: S.title });
        if (changed) setTimeout(refreshCards, 50);
    }
    var _saveT = null;
    function saveRecentSoon() { clearTimeout(_saveT); _saveT = setTimeout(saveRecent, 1500); }

    // ─────────────────────────── Android：用 Capacitor Filesystem 模擬桌面用到的 Tauri 檔案介面（路徑都在手機的 Documents 底下）───────────────────────────
    var CAPFS = null, DOC = '@DOC';
    function u8ToB64(u8) { var bin = '', CH = 0x8000; for (var i = 0; i < u8.length; i += CH) bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return btoa(bin); }
    function capfs() {
        if (CAPFS) return CAPFS;
        var C = window.Capacitor, P = C && C.Plugins, FS = P && P.Filesystem;
        if (!FS || !(C.isNativePlatform && C.isNativePlatform())) return null;
        var rel = function (p) { p = String(p || ''); return (p.indexOf(DOC) === 0 ? p.slice(DOC.length) : p).replace(/^\/+/, ''); };
        var o = function (p, extra) { return Object.assign({ path: rel(p), directory: 'DOCUMENTS' }, extra || {}); };
        CAPFS = {
            android: true, FS: FS,
            path: { documentDir: async function () { return DOC; }, join: async function () { return Array.prototype.slice.call(arguments).join('/').replace(/\/+/g, '/'); } },
            fs: {
                mkdir: async function (p) { try { await FS.mkdir(o(p, { recursive: true })); } catch (e) { if (!/exist/i.test(String(e && e.message || e))) throw e; } },
                writeTextFile: function (p, t) { return FS.writeFile(o(p, { data: String(t), encoding: 'utf8', recursive: true })); },
                writeFile: function (p, bytes) { return FS.writeFile(o(p, { data: u8ToB64(bytes), recursive: true })); },
                readTextFile: async function (p) { var r = await FS.readFile(o(p, { encoding: 'utf8' })); return r.data; },
                remove: function (p) { return FS.deleteFile(o(p)); },
                rename: function (a, b) { return FS.rename({ from: rel(a), to: rel(b), directory: 'DOCUMENTS', toDirectory: 'DOCUMENTS' }); }
            },
            uri: async function (p) { var r = await FS.getUri(o(p)); return r.uri; }
        };
        return CAPFS;
    }
    function shown(p) { return p ? String(p).replace(DOC, 'Documents') : p; }   // 給人看的路徑
    async function shareFile(p, title) {   // 跳出分享面板（取消分享無妨）
        var A = capfs(), SH = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Share;
        if (!A || !SH || !p) return false;
        try { var u = await A.uri(p); await SH.share({ title: title || '圖表', files: [u], dialogTitle: '分享（檔案已存在 ' + shown(p).replace(/\/[^/]*$/, '') + '）' }); return true; }
        catch (e) { if (/cancel/i.test(String(e && e.message || e))) return true; throw e; }
    }

    // ─────────────────────────── 存檔（Documents/NOVA/圖表）───────────────────────────
    function stamp() { var d = new Date(), p = function (n) { return ('0' + n).slice(-2); }; return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); }
    async function saveToDocuments(title, gm, ext, bytes) {
        var T = tfs(); if (!T) return null;
        var dir = await T.path.join(await T.path.documentDir(), 'NOVA', '圖表');
        try { await T.fs.mkdir(dir, { recursive: true }); } catch (e) { /* 已存在 */ }
        var base = String(title || '圖表').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 50) || '圖表';
        var full = await T.path.join(dir, base + '_' + stamp() + '.' + (ext || 'drawio'));
        if (bytes) await T.fs.writeFile(full, bytes);
        else await T.fs.writeTextFile(full, toMxFile(gm, title));
        return full;
    }

    // ─────────────────────────── v1.2.0：本機備份（Documents\NOVA\圖表\圖庫）───────────────────────────
    var BK = { dir: null, index: null, dirty: {}, timer: null, chain: Promise.resolve(), last: 0, err: '' };
    function tfs() { var T = window.__TAURI__; return (T && T.fs && T.path && typeof T.path.documentDir === 'function') ? T : capfs(); }
    function safeName(t) { return String(t || '圖表').replace(/[\\/:*?"<>|\r\n]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 50) || '圖表'; }
    async function bkDir() {
        var T = tfs(); if (!T) return null;
        if (!BK.dir) { var d = await T.path.join(await T.path.documentDir(), 'NOVA', '圖表', '圖庫'); try { await T.fs.mkdir(d, { recursive: true }); } catch (e) { /* 已存在 */ } BK.dir = d; }
        return BK.dir;
    }
    async function bkIndex() {
        if (BK.index) return BK.index;
        var T = tfs(), d = await bkDir(); if (!d) return {};
        var idx = {};
        try { idx = JSON.parse(await T.fs.readTextFile(await T.path.join(d, '_index.json'))) || {}; } catch (e) { idx = {}; }
        BK.index = idx; return idx;
    }
    function bkMark(id) { if (!tfs()) return; BK.dirty[id] = 1; clearTimeout(BK.timer); BK.timer = setTimeout(bkFlush, 2000); }
    function bkFlush() {
        BK.chain = BK.chain.then(async function () {
            var T = tfs(); if (!T) return;
            var ids = Object.keys(BK.dirty); BK.dirty = {}; if (!ids.length) return;
            try {
                var d = await bkDir(), idx = await bkIndex(), st = loadStore();
                for (var i = 0; i < ids.length; i++) {
                    var id = ids[i], r = st[id]; if (!r || !r.xml) continue;
                    var file = safeName(r.title) + '_' + id + '.drawio', old = idx[id];
                    await T.fs.writeTextFile(await T.path.join(d, file), toMxFile(r.xml, r.title || '圖表'));
                    if (old && old.file && old.file !== file) { try { await T.fs.remove(await T.path.join(d, old.file)); } catch (e) { /* */ } }
                    idx[id] = { title: r.title || '', file: file, updated: r.updated || r.t || Date.now(), desc: String(r.desc || '').slice(0, 300) };
                }
                await T.fs.writeTextFile(await T.path.join(d, '_index.json'), JSON.stringify(idx));
                BK.last = Date.now(); BK.err = '';
            } catch (e) {
                BK.err = String(e && e.message || e).slice(0, 160);
                ids.forEach(function (k) { BK.dirty[k] = 1; });
                console.warn('[NovaDrawio] 本機備份失敗：', e);
            }
        });
        return BK.chain;
    }
    function bkTrash(id) {   // 雲端傳來的刪除：檔案移到 圖庫\_已刪除（不直接刪）
        BK.chain = BK.chain.then(async function () {
            var T = tfs(); if (!T) return;
            try {
                var d = await bkDir(), idx = await bkIndex(), it = idx[id]; if (!it) return;
                var td = await T.path.join(d, '_已刪除'); try { await T.fs.mkdir(td, { recursive: true }); } catch (e) { /* */ }
                try { await T.fs.rename(await T.path.join(d, it.file), await T.path.join(td, it.file)); } catch (e) { /* 檔案已不在 */ }
                delete idx[id];
                await T.fs.writeTextFile(await T.path.join(d, '_index.json'), JSON.stringify(idx));
            } catch (e) { /* */ }
        });
        return BK.chain;
    }
    async function bkRead(id) {
        var T = tfs(); if (!T) return null;
        var d = await bkDir(), idx = await bkIndex(), it = idx[id]; if (!it) return null;
        var gm = await toGraphModel(await T.fs.readTextFile(await T.path.join(d, it.file)));
        if (!/<mxGraphModel/.test(gm)) return null;
        return { title: it.title || '圖表', xml: gm, updated: it.updated || 0, desc: it.desc || '' };
    }
    // 開機：圖庫是空的 → 讀回最新的 60 張；備份比本機新 → 讀回；本機有、備份沒有（或較舊）→ 補寫
    async function bkBoot() {
        if (!tfs()) return { restored: 0 };
        await BK.chain;
        var idx = await bkIndex(), st = loadStore(), empty = !Object.keys(st).length, ev = evictedList(), restored = 0;
        var cand = Object.keys(idx).filter(function (id) {
            var r = st[id];
            if (r) return (idx[id].updated || 0) > (r.updated || r.t || 0);
            return empty;   // 平常不把被擠出的舊圖硬塞回來（從選單「備份資料夾裡的其他圖」開啟）
        }).sort(function (a, b) { return (idx[b].updated || 0) - (idx[a].updated || 0); }).slice(0, MAX_STORE);
        for (var i = 0; i < cand.length; i++) {
            try {
                var x = await bkRead(cand[i]); if (!x) continue;
                var cur = st[cand[i]] || {};
                st[cand[i]] = Object.assign({}, cur, { title: x.title, xml: x.xml, desc: x.desc, updated: x.updated, t: Math.max(cur.t || 0, x.updated || 0), svg: cur.xml === x.xml ? cur.svg : null });
                restored++;
            } catch (e) { /* 單一檔案壞掉不影響其他 */ }
        }
        if (restored) saveStore(st);
        st = loadStore();
        Object.keys(st).forEach(function (id) { var r = st[id]; if (r && r.xml && (!idx[id] || (idx[id].updated || 0) < (r.updated || r.t || 0))) bkMark(id); });
        return { restored: restored };
    }
    async function bkArchive() {   // 備份資料夾裡、不在最近清單的圖
        var idx = await bkIndex(), st = loadStore();
        return Object.keys(idx).filter(function (id) { return !st[id]; }).map(function (id) { return { id: id, title: idx[id].title, t: idx[id].updated || 0 }; })
            .sort(function (a, b) { return b.t - a.t; });
    }
    async function openFolder() {
        var T = tfs(), d = await bkDir();
        if (!T || !d) { H.toast('這個環境沒有本機檔案備份（只有雲端同步）'); return; }
        if (T.android) { H.toast('📁 每張圖自動備份在：' + shown(d) + '（可用檔案管理員開啟）', 6000); return; }
        try { if (T.opener && T.opener.openPath) await T.opener.openPath(d); else await T.opener.revealItemInDir(d); } catch (e) { H.toast('備份資料夾：' + d, 6000); }
    }
    function bkPathOf(id) { var it = BK.index && BK.index[id]; return it && BK.dir ? BK.dir + (BK.dir.indexOf('\\') >= 0 ? '\\' : '/') + it.file : null; }

    // ─────────────────────────── v1.2.0：雲端同步（NovaDataSync 供應者 'drawio'）───────────────────────────
    function syncCollect() {
        var st = loadStore(), L = {};
        Object.keys(st).forEach(function (id) { var r = st[id]; if (r && r.xml) L[id] = { title: r.title || '', xml: r.xml, updated: r.updated || r.t || 0, desc: r.desc || '' }; });
        var ev = evictedList().filter(function (id) { return !(id in L); });
        if (ev.length) L.__skip__ = ev;   // 被擠出圖庫 ≠ 刪除
        return L;
    }
    function syncApply(put, del) {
        var st = loadStore(), ids = Object.keys(put || {});
        ids.forEach(function (id) {
            var v = put[id]; if (!v || !v.xml) return;
            var cur = st[id] || {};
            st[id] = Object.assign({}, cur, { title: v.title || '圖表', xml: v.xml, desc: v.desc || '', updated: v.updated || 0, t: Math.max(cur.t || 0, v.updated || 0), svg: cur.xml === v.xml ? (cur.svg || null) : null });
            unEvict(id);
        });
        (del || []).forEach(function (id) { delete st[id]; });
        saveStore(st);
        ids.forEach(bkMark);
        (del || []).forEach(bkTrash);
        if (S.id && (del || []).indexOf(S.id) >= 0) S.id = null;
        if (S.open && S.id && put[S.id] && put[S.id].xml !== S.xml) setStatus('這張圖在另一台裝置被修改過，「最近的圖」裡已是新版；重新開啟即可看到');
    }
    function regSync() {
        var ds = window.NovaDataSync;
        if (regSync.done || !ds || typeof ds.register !== 'function') return;
        regSync.done = true;
        ds.register({
            id: 'drawio', label: 'draw.io 圖表', file: 'NOVA_Drawio_Sync.json',
            merge: function (k, a, b) { return ds._t && ds._t.pickRicher ? ds._t.pickRicher(a, b) : ((b && (b.updated || 0) > ((a && a.updated) || 0)) ? b : a); },
            collect: async function () { return syncCollect(); },
            apply: async function (a) { syncApply(a.put || {}, a.del || []); },
            after: function () { try { refreshCards(); if (S.open) renderRecentMenu(); window.dispatchEvent(new CustomEvent('nova-drawio-synced')); } catch (e) { /* */ } }
        });
    }
    async function syncNow() {
        var ds = window.NovaDataSync; if (!ds) { H.toast('同步模組沒有載入'); return null; }
        regSync();
        setStatus('☁️ 同步到 Google Drive 中…');
        try {
            var r = await ds.sync('drawio', { device: 'android' });
            var t = r.skipped ? (r.skipped === 'disabled' ? '雲端同步已關閉（Google 整合 → Drive 同步 → draw.io 圖表）' : (r.text || '這次略過')) : '雲端同步完成：' + (r.text || '沒有變動');
            setStatus('☁️ ' + t); H.toast('draw.io ' + t);
            return r;
        } catch (e) { var m = String(e && e.message || e); setStatus('☁️ 同步失敗：' + m, true); H.toast('draw.io 雲端同步失敗：' + m, 6000); return { error: m }; }
    }

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
        if (ev.origin !== ORIGIN) return;
        if (W.frame && ev.source === W.frame.contentWindow) { workerMsg(ev); return; }
        if (!S.open) return;
        var fr = $('ndio-frame');
        if (!fr || ev.source !== fr.contentWindow) return;
        var m; try { m = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data; } catch (e) { return; }
        if (!m || !m.event) return;
        if (m.event === 'init') {
            S.ready = true; clearTimeout(S.readyTimer);
            var off = $('ndio-offline'); if (off) off.style.display = 'none';
            post({ action: 'load', xml: S.xml, autosave: 1, title: S.title });
            setStatus('');
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
        var A = capfs();
        if (A) {   // 手機：寫到 Documents/NOVA/圖表/ 再跳分享面板
            var dir = DOC + '/NOVA/圖表';
            try { await A.fs.mkdir(dir); } catch (e) { /* */ }
            var p = dir + '/' + String(name).replace(/[\\/:*?"<>|\r\n]/g, '_');
            await A.fs.writeFile(p, bytes);
            try { await shareFile(p, name); } catch (e) { console.warn('[NovaDrawio] 分享失敗：', e); }
            return shown(p);
        }
        var T = window.__TAURI__;
        if (T && T.dialog && T.fs && typeof T.dialog.save === 'function') {
            var ext = name.split('.').pop();
            var dest = await T.dialog.save({ title: '匯出圖表', defaultPath: name, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
            if (!dest) return false;
            await T.fs.writeFile(dest, bytes); return dest;
        }
        var blob = new Blob([bytes], { type: mime }), url = URL.createObjectURL(blob), a = document.createElement('a');
        a.href = url; a.download = name; document.body.appendChild(a); a.click(); document.body.removeChild(a); setTimeout(function () { URL.revokeObjectURL(url); }, 4000); return true;
    }
    function fileBase() { return (String(S.title || '圖表').replace(/[\\/:*?"<>|]/g, '_').slice(0, 50) || '圖表') + (capfs() ? '_' + stamp() : ''); }
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
            var mmIn = !isEdit && !S.images.length && isMermaid(txt);   // v1.3.0：貼上的是 Mermaid
            if (isEdit) v = await modify(S.xml, txt);
            else if (mmIn) v = await fromMermaid(txt);
            else v = await generate(txt, { images: S.images.slice() });
            if (!isEdit && txt && (S.title === '未命名圖表' || !S.versions.length)) {
                S.title = mmIn ? mermaidTitle(txt) : txt.replace(/\s+/g, ' ').slice(0, 30); var ti = $('ndio-title'); if (ti) ti.value = S.title;
            }
            pushVersion(v.xml, (isEdit ? '修改：' : mmIn ? 'Mermaid：' : '產生：') + txt.slice(0, 40));
            loadIntoEditor(v.xml);
            saveRecent();
            S.images = []; renderImgs();
            if (inp) inp.value = '';
            if (S.ready) setAi(false);   // 手機：收起輸入區，讓出畫面給編輯器
            setStatus('✅ ' + (isEdit ? '已修改' : v.mermaid ? (v.local ? '已從 Mermaid 轉換（本機排版）' : '已從 Mermaid 轉換（模型）') : '已產生') + '：' + v.vertices + ' 個圖形、' + v.edges + ' 條連線（' + Math.round((Date.now() - t0) / 1000) + ' 秒）'
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
        var opt = function (x, pre) { var d = new Date(x.t); return '<option value="' + pre + esc(x.id) + '">' + esc(x.title || '未命名') + '　' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + '</option>'; };
        sel.innerHTML = '<option value="">最近的圖（' + list.length + '）</option>' + list.map(function (x) { return opt(x, ''); }).join('');
        if (tfs()) bkArchive().then(function (arc) {   // v1.2.0
            if (!arc.length || !$('ndio-recent')) return;
            $('ndio-recent').insertAdjacentHTML('beforeend', '<optgroup label="備份資料夾裡的其他圖（' + arc.length + '）">' + arc.slice(0, 300).map(function (x) { return opt(x, 'disk:'); }).join('') + '</optgroup>');
        }).catch(function () { /* */ });
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
            + btn('ndio-folder', '📁', '備份資料夾（Documents/NOVA/圖表/圖庫；每張圖自動存成 .drawio）') + btn('ndio-cloud', '☁️', '立即同步到 Google Drive（NOVA_Drawio_Sync.json，跟桌面互通）')
            + '</div>'
            + '<div id="ndio-ai" style="padding:8px;border-bottom:1px solid ' + c.border + ';background:' + c.panel + '">'
            + '<textarea id="ndio-prompt" rows="2" placeholder="描述要畫的圖（例如：電商下單流程，含付款失敗重試與庫存不足分支），或貼上 Mermaid（flowchart 本機立即排版）；也可描述要怎麼修改目前的圖" style="display:block;width:100%;resize:vertical;min-height:44px;' + inS + '"></textarea>'
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
        $('ndio-folder').onclick = function () { saveRecent(); bkFlush(); openFolder(); };
        $('ndio-cloud').onclick = function () { saveRecent(); syncNow(); };
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
            if (id.indexOf('disk:') === 0) {   // 從備份資料夾開啟
                id = id.slice(5); this.value = '';
                bkRead(id).then(function (x) {
                    if (!x) { setStatus('讀不到這張圖的備份檔', true); return; }
                    saveRecent();
                    var st = loadStore(); st[id] = { title: x.title, xml: x.xml, desc: x.desc, updated: x.updated, t: Date.now() }; unEvict(id); saveStore(st);
                    S.id = id; S.title = x.title; $('ndio-title').value = S.title; S.versions = []; S.vIdx = -1; pushVersion(x.xml, '開啟'); loadIntoEditor(x.xml); renderRecentMenu(); setAi(false); setStatus('已從備份資料夾開啟「' + S.title + '」');
                }).catch(function (e) { setStatus('開啟備份失敗：' + (e && e.message || e), true); });
                return;
            }
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
        if (!opts.xml && opts.id) { var dd = getDiagram(opts.id); if (dd) { opts.xml = dd.xml; S.title = opts.title || dd.title || S.title; var ti0 = $('ndio-title'); if (ti0) ti0.value = S.title; } }
        if (opts.xml) {
            setAi(false);
            start = toGraphModel(opts.xml).then(function (gm) { var v = validate(gm); var x = v.ok ? v.xml : gm; pushVersion(x, '開啟'); loadIntoEditor(x); if (!opts.id) saveRecent(); });
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
        refreshCards();
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
        var codes = (rootEl || document).querySelectorAll('pre code, pre, .msg-content code');   // 手機的對話有時把 ``` 區塊畫成單獨的 <code>（沒有 <pre>）
        Array.prototype.forEach.call(codes, function (el) {
            var pre = el.tagName === 'PRE' ? el : (el.closest('pre') || el);
            if (!pre || pre.getAttribute('data-ndio') || pre.closest('#ndio-overlay') || pre.closest('.nova-drawio-card')) return;
            var txt = el.textContent || '';
            var cls = (el.className || '') + ' ' + (pre.className || '');
            if (!/<mx(GraphModel|file)[\s>]/.test(txt) && (/mermaid/i.test(cls) || isMermaid(txt)) && txt.length >= 10) {   // v1.3.0：Mermaid 程式碼區塊
                pre.setAttribute('data-ndio', '1');
                var mb = document.createElement('button');
                mb.type = 'button'; mb.textContent = '🧩 轉成 draw.io 圖';
                mb.title = mermaidLocal(txt) ? '在本機排版成可編輯的 draw.io 圖並存進圖庫' : '這種 Mermaid 圖會請目前的模型轉成 draw.io 圖';
                mb.style.cssText = 'display:block;margin:4px 0;padding:4px 10px;border-radius:8px;border:1px solid #6366f1;background:#6366f1;color:#fff;font-size:12px;font-weight:600;cursor:pointer';
                mb.onclick = function (e) {
                    e.preventDefault(); e.stopPropagation();
                    mb.disabled = true; mb.textContent = '🧩 轉換中…';
                    tool({ mermaid: el.textContent || '' }).then(function (r) { mb.textContent = '🧩 已轉成 draw.io 圖（開啟）'; mb.disabled = false; mb.onclick = function (ev) { ev.preventDefault(); open({ id: r.id }); }; open({ id: r.id }); })
                        .catch(function (er) { mb.disabled = false; mb.textContent = '🧩 轉成 draw.io 圖'; H.toast('Mermaid 轉換失敗：' + (er && er.message || er), 6000); });
                };
                pre.parentNode.insertBefore(mb, pre);
                return;
            }
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
            var mo = new MutationObserver(function () { clearTimeout(_scanT); _scanT = setTimeout(function () { scanChat(document); scanCards(); }, 400); });
            mo.observe(document.body, { childList: true, subtree: true });
            scanChat(document); scanCards();
        } catch (e) { /* */ }
    }

    // ─────────────────────────── 背景轉檔（隱藏的 draw.io 頁面：預覽 SVG、PNG）───────────────────────────
    var W = { frame: null, ready: false, queue: [], cur: null, initWait: [] };
    function workerEnsure() {
        if (W.frame && document.body.contains(W.frame)) return;
        W.ready = false;
        var f = document.createElement('iframe');
        f.id = 'ndio-worker'; f.setAttribute('aria-hidden', 'true'); f.tabIndex = -1;
        f.style.cssText = 'position:fixed;left:-12000px;top:0;width:1200px;height:900px;border:0;opacity:0;pointer-events:none';
        f.src = ORIGIN + '/?embed=1&proto=json&spin=0&noExitBtn=1&noSaveBtn=1&saveAndExit=0&ui=min&configure=0';
        document.body.appendChild(f);
        W.frame = f;
        setTimeout(function () { if (!W.ready) { var q = W.queue.splice(0); if (W.cur) { q.unshift(W.cur); W.cur = null; } q.forEach(function (j) { j.reject(new Error('draw.io 頁面載入不了（需要網路）')); }); try { f.remove(); } catch (e) { /* */ } W.frame = null; } }, 25000);
    }
    function workerPost(msg) { if (W.frame && W.frame.contentWindow) W.frame.contentWindow.postMessage(JSON.stringify(msg), ORIGIN); }
    function workerNext() {
        if (W.cur || !W.ready || !W.queue.length) return;
        W.cur = W.queue.shift();
        W.cur.stage = 'load';
        W.cur.timer = setTimeout(function () { if (W.cur) { var j = W.cur; W.cur = null; j.reject(new Error('draw.io 轉檔逾時')); workerNext(); } }, 30000);
        workerPost({ action: 'load', xml: W.cur.xml });
    }
    function workerMsg(ev) {
        var m; try { m = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data; } catch (e) { return; }
        if (!m || !m.event) return;
        if (m.event === 'init') { W.ready = true; workerNext(); return; }
        if (!W.cur) return;
        if (m.event === 'load' && W.cur.stage === 'load') {
            W.cur.stage = 'export';
            workerPost({ action: 'export', format: W.cur.format, border: 10, background: W.cur.format.indexOf('png') >= 0 ? '#ffffff' : 'none', spinKey: 'export' });
        } else if (m.event === 'export' && W.cur.stage === 'export') {
            var j = W.cur; W.cur = null; clearTimeout(j.timer); j.resolve(m.data); workerNext();
        }
    }
    function render(xml, format) {   // format：svg｜png｜xmlpng｜xmlsvg → dataURL
        return new Promise(function (resolve, reject) {
            W.queue.push({ xml: xml, format: format || 'svg', resolve: resolve, reject: reject });
            workerEnsure(); workerNext();
        });
    }

    // ─────────────────────────── 給 AI 用的工具（一般對話、自主任務、桌面操作共用）───────────────────────────
    // NovaDrawio.tool({description | xml, title?, png?}) → {ok, id, title, path, png_path?, vertices, edges, labels[], fixes[], error?}
    //   有 xml 就只檢查／修正，不再呼叫模型；只有描述就用 generate() 產生（呼叫一次目前的模型，格式錯會自動重寫一次）。
    //   結果存進圖庫並寫成 Documents\NOVA\圖表\<標題>_<時間>.drawio；png:true 時另存一張 PNG（內嵌圖檔，需要網路）。
    function labelsOf(gm) {
        try {
            var doc = new DOMParser().parseFromString(gm, 'text/xml'), out = [];
            Array.prototype.forEach.call(doc.getElementsByTagName('mxCell'), function (c) {
                if (c.getAttribute('vertex') !== '1') return;
                var v = String(c.getAttribute('value') || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
                if (v) out.push(v.slice(0, 40));
            });
            return out;
        } catch (e) { return []; }
    }
    async function tool(args) {
        args = args || {};
        var title = String(args.title || '').trim();
        var v;
        var mmSrc = args.mermaid || (args.xml && !/<mx(GraphModel|file)/.test(String(args.xml)) && isMermaid(args.xml) ? args.xml : '') || (!args.xml && args.description && isMermaid(args.description) ? args.description : '');
        if (mmSrc) {   // v1.3.0
            v = await fromMermaid(String(mmSrc));
            if (!title) title = mermaidTitle(mmSrc);
        } else if (args.xml && /<mx(GraphModel|file)/.test(String(args.xml))) {
            var gm0 = await toGraphModel(extractXml(String(args.xml)) || String(args.xml));
            v = validate(gm0);
            if (!v.ok) throw new Error('圖表 XML 有問題：' + v.error);
        } else {
            var desc = String(args.description || args.prompt || '').trim();
            if (!desc) throw new Error('需要 description（要畫的圖的描述）或 xml');
            v = await generate(desc, {});
            if (!title) title = desc.replace(/\s+/g, ' ').slice(0, 30);
        }
        title = title || '圖表';
        var id = args.id && getDiagram(args.id) ? args.id : newId();
        putDiagram(id, { title: title, xml: v.xml, svg: null, desc: mmSrc ? String(mmSrc).slice(0, 2000) : (args.description || '') });
        var res = { ok: true, id: id, title: title, path: null, vertices: v.vertices, edges: v.edges, labels: labelsOf(v.xml), fixes: v.fixes || [] };
        if (v.mermaid) res.from = v.local ? 'mermaid-local' : 'mermaid-model';
        try { res.path = await saveToDocuments(title, v.xml, 'drawio'); if (res.path) putDiagram(id, { path: res.path }); } catch (e) { res.save_error = String(e && e.message || e).slice(0, 160); }
        if (args.png) {
            try {
                var png = await render(v.xml, 'xmlpng');
                res.png_path = await saveToDocuments(title, v.xml, 'png', dataUrlBytes(png));
            } catch (e) { res.png_error = String(e && e.message || e).slice(0, 160); }
        }
        render(v.xml, 'svg').then(function (svg) { putDiagram(id, { svg: svg }); refreshCards(); }).catch(function () { /* 離線：圖卡不顯示預覽 */ });
        return res;
    }
    function toolSummary(r) {
        if (!r || !r.ok) return '圖表產生失敗：' + ((r && r.error) || '未知錯誤');
        return '已產生 draw.io 圖表「' + r.title + '」（' + r.vertices + ' 個圖形、' + r.edges + ' 條連線）'
            + (r.path ? '，已存檔：' + shown(r.path) : '（沒有存成檔案' + (r.save_error ? '：' + r.save_error : '') + '）')
            + (r.png_path ? '；PNG：' + shown(r.png_path) : (r.png_error ? '；PNG 沒有產生：' + r.png_error : ''))
            + (r.labels.length ? '。圖中的節點：' + r.labels.slice(0, 40).join('、') : '')
            + (r.fixes.length ? '。自動修正 ' + r.fixes.length + ' 處格式問題' : '') + '。';
    }

    // ─────────────────────────── 對話圖卡（```drawio 區塊）───────────────────────────
    // nova-app-main.js 的 formatMessage 把 ```drawio 區塊換成 <div class="nova-drawio-card" data-enc="…" data-msg="訊息編號">；這裡把它變成圖卡。
    //   區塊內容：@id:xxx（指向圖庫）｜draw.io XML（直接檢查載入）｜文字描述（產生一次，記在 nova_drawio_chatmap）。
    //   描述型的只對「剛產生（15 分鐘內）的 AI 回覆」自動產生；舊訊息、使用者自己打的，顯示「產生這張圖」按鈕，避免重新整理時大量花費模型呼叫。
    var _inflight = {};
    function chatToolOn() { try { return localStorage.getItem('nova_drawio_chat_tool') !== '0'; } catch (e) { return true; } }
    function decodeEnc(enc) { try { return decodeURIComponent(escape(atob(enc))); } catch (e) { return ''; } }
    function msgOf(mid) {
        try { var arr = (window.appState && appState.messages) || []; for (var i = arr.length - 1; i >= 0; i--) if (String(arr[i].id) === String(mid)) return arr[i]; } catch (e) { /* */ }
        return null;
    }
    function cardHtml(id, d, note) {
        var L = !!H.isLight();
        var bg = L ? '#ffffff' : '#0f172a', bd = L ? '#cbd5e1' : '#334155', tx = L ? '#0f172a' : '#e2e8f0', sub = L ? '#64748b' : '#94a3b8';
        var bs = 'padding:4px 10px;border-radius:8px;border:1px solid ' + bd + ';background:transparent;color:' + tx + ';font-size:12px;font-weight:600;cursor:pointer';
        var cnt = d && d.xml ? (function () { var x = d.xml; return ((x.match(/vertex="1"/g) || []).length) + ' 個圖形、' + ((x.match(/edge="1"/g) || []).length) + ' 條連線'; })() : '';
        return '<div style="margin:10px 0;border:1px solid ' + bd + ';border-radius:14px;background:' + bg + ';overflow:hidden;max-width:720px">'
            + '<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid ' + bd + '">'
            + '<span style="font-size:15px">🧩</span><b style="color:' + tx + ';font-size:13px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc((d && d.title) || 'draw.io 圖表') + '</b>'
            + '<span style="color:' + sub + ';font-size:11px">' + esc(cnt) + '</span></div>'
            + (d && d.svg ? '<div style="background:#fff;padding:8px;text-align:center;cursor:zoom-in" data-ndio-open="' + esc(id) + '"><img src="' + d.svg + '" style="max-width:100%;max-height:360px" alt="圖表預覽"></div>'
                : '<div style="padding:18px;text-align:center;color:' + sub + ';font-size:12px">' + esc(note || (d ? '預覽產生中…（需要網路）' : '')) + '</div>')
            + (d ? '<div style="display:flex;gap:6px;flex-wrap:wrap;padding:8px 12px;border-top:1px solid ' + bd + '">'
                + '<button type="button" style="' + bs + '" data-ndio-open="' + esc(id) + '">✏️ 開啟編輯</button>'
                + ((d.path || bkPathOf(id)) ? '<button type="button" style="' + bs + '" data-ndio-reveal="' + esc(id) + '" title="' + esc(shown(d.path || bkPathOf(id))) + '">' + (capfs() ? '📤 分享檔案' : '📁 顯示檔案') + '</button>' : '')
                + '<button type="button" style="' + bs + '" data-ndio-png="' + esc(id) + '">🖼️ 匯出 PNG</button>'
                + '</div>' : '')
            + '</div>';
    }
    function bindCard(el) {
        Array.prototype.forEach.call(el.querySelectorAll('[data-ndio-open]'), function (b) { b.onclick = function (e) { e.preventDefault(); e.stopPropagation(); open({ id: b.getAttribute('data-ndio-open') }); }; });
        Array.prototype.forEach.call(el.querySelectorAll('[data-ndio-reveal]'), function (b) {
            b.onclick = async function (e) {
                e.preventDefault(); e.stopPropagation();
                var rid = b.getAttribute('data-ndio-reveal'), d = getDiagram(rid), fp = (d && d.path) || bkPathOf(rid);
                if (capfs()) { try { if (!(await shareFile(fp, d && d.title))) H.toast('檔案位置：' + shown(fp), 6000); } catch (er) { H.toast('分享失敗（檔案在 ' + shown(fp) + '）：' + (er && er.message || er), 6000); } return; }
                try { await window.__TAURI__.opener.revealItemInDir(fp); } catch (er) { H.toast('檔案位置：' + fp, 6000); }
            };
        });
        Array.prototype.forEach.call(el.querySelectorAll('[data-ndio-png]'), function (b) {
            b.onclick = async function (e) {
                e.preventDefault(); e.stopPropagation();
                var id = b.getAttribute('data-ndio-png'), d = getDiagram(id); if (!d) return;
                b.disabled = true; var old = b.textContent; b.textContent = '匯出中…';
                try {
                    var png = await render(d.xml, 'xmlpng');
                    var r = await saveBytes(String(d.title || '圖表').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) + '.png', dataUrlBytes(png), 'image/png');
                    H.toast(r ? '✅ 已匯出 PNG' + (typeof r === 'string' ? '：' + r : '') : '已取消', 4000);
                } catch (er) { H.toast('匯出失敗：' + (er && er.message || er), 5000); }
                b.disabled = false; b.textContent = old;
            };
        });
        Array.prototype.forEach.call(el.querySelectorAll('[data-ndio-gen]'), function (b) {
            b.onclick = function (e) { e.preventDefault(); e.stopPropagation(); el.removeAttribute('data-ndio-state'); hydrate(el, true); };
        });
    }
    function showCard(el, id, note) {
        var d = getDiagram(id);
        el.setAttribute('data-ndio-id', id);
        el.innerHTML = cardHtml(id, d, d ? '' : (note || '這張圖已不在圖庫裡（圖庫最多保留 60 張）'));
        bindCard(el);
        if (d && !d.svg && !d._previewTried) {
            d._previewTried = true;
            render(d.xml, 'svg').then(function (svg) { putDiagram(id, { svg: svg }); refreshCards(); }).catch(function () {
                var ph = el.querySelector('div > div:nth-child(2)'); if (ph && !getDiagram(id).svg) ph.textContent = '預覽需要網路（draw.io 頁面載入不了）；仍可開啟編輯或' + (capfs() ? '分享檔案' : '顯示檔案');
            });
        }
    }
    function showMsg(el, html) { el.innerHTML = '<div style="margin:10px 0;padding:12px 14px;border:1px dashed #6366f1;border-radius:14px;font-size:12px;color:#94a3b8;max-width:720px">' + html + '</div>'; bindCard(el); }
    function hydrate(el, force) {
        if (!force && el.getAttribute('data-ndio-state')) return;
        el.setAttribute('data-ndio-state', '1');
        var txt = decodeEnc(el.getAttribute('data-enc') || '').trim();
        var m = /^@id:\s*([\w-]+)/.exec(txt);
        if (m) { showCard(el, m[1]); return; }
        var h = hashText(txt), known = chatMap(h);
        if (known && getDiagram(known)) { showCard(el, known); return; }
        var isXml = /<mx(GraphModel|file)[\s>]/.test(txt);
        var isMm = !isXml && isMermaid(txt), mmLocal = isMm && !!mermaidLocal(txt);   // v1.3.0：本機轉得了的 Mermaid 跟 XML 一樣立即載入
        var msg = msgOf(el.getAttribute('data-msg'));
        var fresh = !!(msg && msg.sender !== 'user' && Date.now() - Number(msg.id) < 15 * 60 * 1000);
        if (mmLocal) isXml = true;
        if (!isXml && !force && !fresh) {
            showMsg(el, (isMm ? '🧩 Mermaid 圖（' + esc((MM_KINDS.exec(mermaidBody(txt)) || [''])[0]) + '，需要模型轉換）：' : '🧩 draw.io 圖表（描述）：') + esc(txt.slice(0, 160)) + (txt.length > 160 ? '…' : '')
                + ' <button type="button" data-ndio-gen="1" style="margin-left:6px;padding:3px 10px;border-radius:8px;border:1px solid #6366f1;background:#6366f1;color:#fff;font-size:12px;font-weight:600;cursor:pointer">產生這張圖</button>');
            return;
        }
        if (!isXml && !chatToolOn() && !force) { showMsg(el, '🧩 已關閉對話裡的自動畫圖 <button type="button" data-ndio-gen="1" style="margin-left:6px;padding:3px 10px;border-radius:8px;border:1px solid #6366f1;background:#6366f1;color:#fff;font-size:12px;cursor:pointer">產生這張圖</button>'); return; }
        showMsg(el, isXml ? '🧩 載入圖表中…' : '🧩 正在畫圖…（' + esc((H.modelLabel && H.modelLabel(false)) || '目前模型') + '）');
        if (!_inflight[h]) {
            _inflight[h] = tool(isMm ? { mermaid: txt } : isXml ? { xml: txt, title: (msg && '對話裡的圖表') || '' } : { description: txt })
                .then(function (r) { chatMap(h, r.id); return r; })
                .finally(function () { setTimeout(function () { delete _inflight[h]; }, 1000); });
        }
        _inflight[h].then(function () { refreshCards(); }).catch(function (e) {
            Array.prototype.forEach.call(document.querySelectorAll('.nova-drawio-card'), function (c) {
                if (hashText(decodeEnc(c.getAttribute('data-enc') || '').trim()) === h) {
                    c.setAttribute('data-ndio-state', 'err');
                    showMsg(c, '⚠️ 圖表產生失敗：' + esc(String(e && e.message || e).slice(0, 200)) + ' <button type="button" data-ndio-gen="1" style="margin-left:6px;padding:3px 10px;border-radius:8px;border:1px solid #6366f1;background:#6366f1;color:#fff;font-size:12px;cursor:pointer">重試</button>');
                }
            });
        });
    }
    function refreshCards() {
        Array.prototype.forEach.call(document.querySelectorAll('.nova-drawio-card'), function (c) {
            var id = c.getAttribute('data-ndio-id');
            if (id) { if (getDiagram(id)) { c.innerHTML = cardHtml(id, getDiagram(id), ''); bindCard(c); } return; }
            var txt = decodeEnc(c.getAttribute('data-enc') || '').trim();
            var known = /^@id:/.test(txt) ? txt.replace(/^@id:\s*/, '') : chatMap(hashText(txt));
            if (known && getDiagram(known)) showCard(c, known);
        });
    }
    function scanCards() { Array.prototype.forEach.call(document.querySelectorAll('.nova-drawio-card:not([data-ndio-state])'), function (c) { hydrate(c, false); }); }

    window.addEventListener('message', onMessage);
    function boot() { watchChat(); addEntry(); setInterval(addEntry, 3000); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
    // v1.2.0：註冊雲端同步供應者；開機後補備份／必要時從備份還原
    regSync();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', regSync);
    setTimeout(function () {
        regSync();
        bkBoot().then(function (r) { if (r && r.restored) { H.toast('已從「Documents/NOVA/圖表/圖庫」還原 ' + r.restored + ' 張 draw.io 圖'); refreshCards(); } })
            .catch(function (e) { console.warn('[NovaDrawio] 備份檢查失敗：', e); });
    }, 2500);

    window.NovaDrawio = {
        version: '1.1.0', desktopBase: '1.3.0',
        fromMermaid: fromMermaid, isMermaid: isMermaid, _parseMermaidFlow: parseFlow, _mermaidLocal: mermaidLocal,
        backupNow: function () { Object.keys(loadStore()).forEach(bkMark); clearTimeout(BK.timer); return bkFlush(); },
        backupInfo: function () { return { dir: BK.dir, last: BK.last, error: BK.err, pending: Object.keys(BK.dirty).length }; },
        restoreFromBackup: bkBoot, openBackupFolder: openFolder, syncNow: syncNow,
        _syncCollect: syncCollect, _syncApply: syncApply, _bkFlushed: function () { return BK.chain; },
        tool: tool, toolSummary: toolSummary, render: render, chatToolOn: chatToolOn,
        get: getDiagram, list: recentList, refreshCards: refreshCards,
        init: function (h) { Object.keys(h || {}).forEach(function (k) { if (h[k] != null) H[k] = h[k]; }); },
        open: open, close: close, generate: generate, modify: modify,
        isOpen: function () { return S.open; },
        _setImages: function (arr) { S.images = (arr || []).slice(0, 6); renderImgs(); },
        current: function () { return S.xml; },
        _capfs: capfs, _shown: shown,
        _validate: validate, _extractXml: extractXml, _hash: hashText, _hydrate: hydrate, _toGraphModel: toGraphModel, _toMxFile: toMxFile
    };
    window.openDrawio = function (o) {
        try { document.getElementById('plus-menu').classList.add('hidden'); document.getElementById('plus-icon').classList.remove('rotate-45'); } catch (e) { /* */ }
        open(o || {});
    };
})();

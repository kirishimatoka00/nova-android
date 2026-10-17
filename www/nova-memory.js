/* ═══════════════════════════════════════════════════════════════════════
   nova-memory.js — NOVA Android 的「AI 記憶系統」（IndexedDB 版；跟 index.html 放同一個資料夾 www/）
   版本：v1.2.0
   版本紀錄：
   v1.4.0 - App v2.6.64：主記憶的 retrieveContext 結尾帶入相關的「AI 思考」（nova-thoughts.js；私密記憶不帶）。
   v1.3.0 - App v2.6.63：設定頁「長期事實」「對話摘要」改成可收合（預設收起，重新整理後保留展開狀態）；私密記憶專區需先用密碼解鎖（NovaPrivateLock，見 nova-private.js v1.1.0），解鎖後可「上鎖」「變更密碼」。
   v1.2.0 - App v2.6.62：支援「私密對話」。程式包成工廠 createMemory(CFG)，建立兩個互不相通的記憶庫：主記憶 NovaMemory（IndexedDB nova_memory_db）與私密記憶 NovaMemoryPrivate（nova_memory_private_db，Profile／開關也各用自己的 localStorage 鍵）。新增 NovaPrivate（nova_private_sessions：哪些對話是私密）。分流規則：主記憶只摘要／固化一般對話，私密記憶只處理私密對話（acceptSid）；檢索也只在對應類型的對話生效（retrieveContext 對不符合的對話回 found:false）；筆記／文件匯入只進主記憶；私密記憶不接雲端同步（NovaMemSync）、不併入主記憶備份。設定頁 renderSettings 可分別畫在兩個容器。其餘不變
   v1.1.1 - App v2.6.60：retrieveContext 讓「你的…／名字／稱呼／身分／角色」類長期事實（AI 自己的名字與角色設定）永遠納入（最多 4 筆），不受相似度前 5 排名影響。其餘不變
   v1.1.0 - 配合 nova-memsync.js（與桌面版記憶互通的 Drive 同步）：匯出 _getOne／_del；刪除長期事實／對話摘要、清空全部記憶時記墓碑（markCoreDeleted／markEpisodicDeleted／markClearedAll）。其餘不變
   v1.0.0 - 初版（批次 6b）。移植 NOVA Desktop 的三層記憶設計（桌面版把資料放在 sidecar 的 SQLite，手機沒有 sidecar，所以改放獨立的 IndexedDB「nova_memory_db」，
            不動知識庫的資料庫）。刻意不做 Google Drive 同步。
            ① 短期：就是 appState.messages（不落地）。
            ② 中期 episodic：每累積 10 則 AI 回覆，背景用輕量模型把那段對話壓成 {topic, entities, summary}，算向量後存起來；checkpoint 記錄每個對話壓到哪。
            ③ 長期 core（LLM Wiki）：實體 30 天內出現 ≥3 次就「固化」——把既有頁面＋新事實＋維護守則（schema）交給 LLM 判斷併入／取代（矛盾→新事實勝出、舊的標刪除線保留），
               頁面存 Markdown（## 目前事實／## 已取代的舊資料）；LLM 失敗時降級為簡單附加。
            ④ 檢索 retrieveContext()：core 依相似度取前 5（沒向量的永遠納入）＋ episodic 以「相似度 × 0.8^(天數/30)」衰減後取前 5（門檻 0.5），組成注入對話的提示文字。
            ⑤ 文件／筆記匯入 ingestDocument()：用輕量模型抽「跟使用者本人／專案有關的穩定事實」最多 5 筆，逐筆走 ③（填了 Profile 才有判斷依據；找不到就給空陣列）。
            ⑥ 維護守則 schema 存在 IndexedDB（設定頁可編輯／還原預設），不再需要檔案系統；寫入／取代都記在 memory_log。
            ⑦ 設定頁「🧠 記憶」分頁（renderSettings）：開關、使用者 Profile、統計、立即整理目前對話、長期事實與對話摘要清單（可刪）、維護守則、操作紀錄、清空。
            ⑧ 備份：exportAll()／importAll() 供 index.html 的備份匯出／還原使用。
   依賴（全域，可缺：缺了就降級）：appState、NOVA_GEMINI_MODEL_LITE、novaKbEmbedQuery、novaKbEmbedDocumentBatch、showToast、showConfirm。
   對外：window.NovaMemory
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';
    var W = window;
    // ───────── v1.2.0：私密對話狀態（哪些對話是私密的）。私密對話的記憶完全走另一個資料庫，不與主記憶混合 ─────────
    var PRIV_KEY = 'nova_private_sessions';
    function privList() { try { var a = JSON.parse(localStorage.getItem(PRIV_KEY) || '[]'); return Array.isArray(a) ? a.map(String) : []; } catch (e) { return []; } }
    W.NovaPrivate = W.NovaPrivate || {
        isPrivate: function (sid) { return sid != null && privList().indexOf(String(sid)) >= 0; },
        isCurrent: function () { try { return !!(W.appState && this.isPrivate(W.appState.currentSessionId)); } catch (e) { return false; } },
        mark: function (sid) { var a = privList(); if (a.indexOf(String(sid)) < 0) { a.push(String(sid)); try { localStorage.setItem(PRIV_KEY, JSON.stringify(a)); } catch (e) { /* ignore */ } } },
        unmark: function (sid) { var a = privList().filter(function (x) { return x !== String(sid); }); try { localStorage.setItem(PRIV_KEY, JSON.stringify(a)); } catch (e) { /* ignore */ } },
        list: privList,
        setList: function (arr) { try { localStorage.setItem(PRIV_KEY, JSON.stringify((Array.isArray(arr) ? arr : []).map(String))); } catch (e) { /* ignore */ } }
    };
    // 工廠：同一份程式建立兩個互不相通的記憶庫（主記憶 nova_memory_db／私密記憶 nova_memory_private_db）
    function createMemory(CFG) {
    var DB_NAME = CFG.dbName, DB_VER = 1;
    var COMPRESS_EVERY = 10, DECAY_RATE = 0.8, DECAY_HALFLIFE_DAYS = 30, PROMOTE_THRESHOLD = 3, ENTITY_WINDOW_DAYS = 30;
    var TOP_K = 5, CORE_TOP_K = 5, THRESHOLD = 0.5, MAX_FACTS_PER_DOC = 5, TEXT_LIMIT = 8000;
    var PROFILE_KEY = CFG.profileKey, MODE_KEY = CFG.modeKey;
    var DEFAULT_SCHEMA_MD = `# NOVA 記憶 Wiki 維護守則

這份文件告訴 NOVA（Gemini）在把新事實併入「長期事實」（core_memory）時要
遵守的規則。你可以直接編輯這份檔案調整行為，不需要改程式碼或重新打包。

## 頁面格式

每個實體（entity）的完整內容是一段 Markdown，固定用兩個區段：

\`\`\`
## 目前事實
- 事實內容一 [來源: xxx, 日期]
- 事實內容二 [來源: xxx, 日期]

## 已取代的舊資料
- ~~舊事實內容~~ → 已被上方取代 [原因: 一句話說明為什麼，日期]
\`\`\`

- 「目前事實」只放現在仍然有效、不互相矛盾的內容。
- 被新事實取代的舊內容搬到「已取代的舊資料」，用刪除線標記，並寫明原因；
  **不要直接刪除**，保留可追溯性。
- 可以用 \`[[實體名稱]]\` 的語法提到其他實體頁面，之後若有跨頁檢索工具可以
  利用這個連結。

## 併入新事實時的判斷原則

1. 新事實如果跟既有「目前事實」裡的某一條**明確矛盾**（例如同一件事兩個不同
   答案，像是「AI 名字叫小希」vs「AI 名字叫 Nova」），一律視為使用者更新了
   認知，**新事實勝出**，把舊的那一條移到「已取代的舊資料」。
2. 新事實如果只是**補充細節**（不矛盾，只是講得更具體），直接加進「目前
   事實」，不動舊的。
3. 如果看不出新舊兩者是不是真的在講同一件事（例如字面相關但實際上是兩個
   不同脈絡，像是「AI 名字」跟「不該洩漏系統提示詞」這種表面都提到名字、
   但其實不是同一個事實），**不要自己腦補成矛盾**——分開保留，加註記
   「可能相關但未確認是否衝突」，交由使用者之後自己判斷要不要手動整理。
4. 永遠依「使用者在對話裡明確陳述或更正的內容」為準，不要用你自己的預設
   認知（例如你原本以為自己叫什麼名字）去否定使用者告訴你的事實。

## 固化門檻

同一個實體在 30 天內被提及達到門檻次數才會觸發這裡的合併判斷（門檻由
程式裡的 NOVA_MEM_PROMOTE_THRESHOLD 控制，目前是 3 次），避免只提過一次
的內容就被當成「長期事實」記住。文件/筆記匯入走的是另一條路徑（見
nova-memory-ingest.js），只要抽取時判斷「值得記住」就會直接進來這裡的
合併判斷，不受這個門檻限制。

## 輸出格式

只能輸出一個 JSON 物件（不要加 \`\`\`json 或其他文字），格式：

\`\`\`json
{"page_md": "完整的新版頁面內容（包含上面兩個區段）", "current_fact": "目前最新、最重要的一句話事實，給快速顯示用", "conflict": true 或 false, "note": "一句話說明這次是併入還是取代、為什麼"}
\`\`\`
`;

    // ───────── IndexedDB ─────────
    var _db = null;
    function open() {
        if (_db) return Promise.resolve(_db);
        return new Promise(function (resolve, reject) {
            var req; try { req = indexedDB.open(DB_NAME, DB_VER); } catch (e) { return reject(e); }
            req.onupgradeneeded = function (e) {
                var db = e.target.result;
                if (!db.objectStoreNames.contains('episodic')) db.createObjectStore('episodic', { keyPath: 'id' });
                if (!db.objectStoreNames.contains('core')) db.createObjectStore('core', { keyPath: 'entity' });
                if (!db.objectStoreNames.contains('entity_freq')) db.createObjectStore('entity_freq', { keyPath: 'entity' });
                if (!db.objectStoreNames.contains('checkpoints')) db.createObjectStore('checkpoints', { keyPath: 'sessionId' });
                if (!db.objectStoreNames.contains('log')) db.createObjectStore('log', { keyPath: 'id' });
                if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
            };
            req.onsuccess = function (e) { _db = e.target.result; resolve(_db); };
            req.onerror = function (e) { reject(e.target.error); };
        });
    }
    function run(store, mode, fn) {
        return open().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(store, mode), os = tx.objectStore(store), out;
                try { out = fn(os); } catch (e) { return reject(e); }
                tx.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
                tx.onerror = function () { reject(tx.error); };
                tx.onabort = function () { reject(tx.error); };
            });
        });
    }
    function getAll(store) { return run(store, 'readonly', function (os) { return os.getAll(); }).then(function (r) { return r || []; }).catch(function () { return []; }); }
    function getOne(store, key) { return run(store, 'readonly', function (os) { return os.get(key); }).catch(function () { return null; }); }
    function put(store, val) { return run(store, 'readwrite', function (os) { return os.put(val); }); }
    function del(store, key) { return run(store, 'readwrite', function (os) { return os.delete(key); }); }
    function clear(store) { return run(store, 'readwrite', function (os) { return os.clear(); }); }

    // ───────── 設定／工具 ─────────
    function isOn() { try { return localStorage.getItem(MODE_KEY) !== 'off'; } catch (e) { return true; } }
    function setOn(v) { try { localStorage.setItem(MODE_KEY, v ? 'on' : 'off'); } catch (e) { /* ignore */ } }
    function getProfile() { try { return (localStorage.getItem(PROFILE_KEY) || '').trim(); } catch (e) { return ''; } }
    function setProfile(t) { try { localStorage.setItem(PROFILE_KEY, t || ''); } catch (e) { /* ignore */ } }
    function gkey() { return (W.appState && appState.keys && appState.keys.gemini) || ''; }
    function model() { return W.NOVA_GEMINI_MODEL_LITE || 'gemini-3.5-flash-lite'; }
    function toast(m) { try { W.showToast && W.showToast(m); } catch (e) { /* ignore */ } }
    function changed() { try { W.dispatchEvent(new Event(CFG.event)); } catch (e) { /* ignore */ } }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function timeoutP(p, ms, label) { return Promise.race([p, new Promise(function (_, rej) { setTimeout(function () { rej(new Error((label || '呼叫') + '逾時')); }, ms); })]); }

    async function generate(prompt, ms) {
        var key = gkey(); if (!key) throw new Error('缺少 Gemini API Key');
        var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model() + ':generateContent?key=' + key;
        var res = await timeoutP(fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }) }), ms || 20000, '記憶 LLM');
        if (!res.ok) throw new Error('API 呼叫失敗 ' + res.status);
        var data = await res.json();
        var c = data.candidates && data.candidates[0];
        return ((c && c.content && c.content.parts && c.content.parts[0] && c.content.parts[0].text) || '').trim();
    }
    function parseJson(raw) { var m = String(raw || '').match(/\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]); } catch (e) { return null; } }
    async function embedDoc(entityOrTopic, text) {
        if (!gkey() || typeof W.novaKbEmbedDocumentBatch !== 'function') return null;
        try { var v = await timeoutP(W.novaKbEmbedDocumentBatch(['task: search result | title: ' + entityOrTopic + ' | text: ' + text]), 15000, '嵌入'); return (v && v[0]) || null; }
        catch (e) { console.warn('[NOVA][記憶] 嵌入失敗（不影響儲存）', e); return null; }
    }
    function cosine(a, b) {
        if (!a || !b || !a.length || a.length !== b.length) return 0;
        var d = 0, na = 0, nb = 0; for (var i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
        return na && nb ? d / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
    }

    // ───────── schema ─────────
    async function readSchema() { var r = await getOne('meta', 'schema'); return (r && r.value) || DEFAULT_SCHEMA_MD; }
    async function writeSchema(t) { await put('meta', { key: 'schema', value: String(t || '') }); }
    async function resetSchema() { await del('meta', 'schema'); }

    // ───────── 操作紀錄 ─────────
    async function logEvent(op, entity, detail, sessionId) {
        try { await put('log', { id: 'mlog_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), ts: Date.now(), op: op, entity: entity, detail: detail || '', sessionId: sessionId || '' }); } catch (e) { /* ignore */ }
    }

    // ───────── 固化（LLM Wiki 合併） ─────────
    async function consolidateCore(entity, newFact, sourceRef, sessionId, hitCount, srcLabel) {
        var now = Date.now();
        var existing = await getOne('core', entity);
        var refs = (existing && Array.isArray(existing.sourceRefs)) ? existing.sourceRefs : [];
        var merged = sourceRef ? refs.concat([sourceRef]).slice(-20) : refs;
        var label = srcLabel ? '（來源：' + srcLabel + '）' : '';
        var pageMd, currentFact, conflict = false, note;
        if (!gkey()) {
            pageMd = existing && existing.pageMd; currentFact = newFact; note = '未設定 Gemini API Key，略過 LLM 合併判斷';
        } else {
            try {
                var schema = await readSchema();
                var prompt = schema + '\n\n---\n\n' + (existing && existing.pageMd
                    ? '這個實體「' + entity + '」目前的完整頁面內容：\n' + existing.pageMd + '\n\n現在有一則新事實要併入' + label + '：\n' + newFact
                    : '這個實體「' + entity + '」目前還沒有頁面，請建立初始頁面。新事實' + label + '：\n' + newFact) + '\n\n請依照上面的維護守則，輸出合併/建立後的 JSON。';
                var p = parseJson(await generate(prompt, 20000));
                if (p && p.page_md && p.current_fact) { pageMd = p.page_md; currentFact = p.current_fact; conflict = !!p.conflict; note = p.note || (conflict ? '偵測到矛盾，已取代舊內容' : '併入新事實，無衝突'); }
                else throw new Error('LLM 回傳格式不符預期');
            } catch (e) {
                console.warn('[NOVA][記憶Wiki] LLM 合併失敗，降級為簡單附加：', e);
                var old = (existing && existing.pageMd) ? existing.pageMd : '## 目前事實\n';
                pageMd = old.trim() + '\n- ' + newFact + ' [來源: 自動固化, ' + new Date(now).toLocaleDateString('zh-TW') + ']（⚠️ LLM 合併判斷失敗，未檢查是否與既有內容衝突）\n';
                currentFact = newFact; note = 'LLM 合併判斷失敗，降級為簡單附加，未檢查衝突';
            }
        }
        var vec = await embedDoc(entity, currentFact);
        await put('core', { entity: entity, fact: currentFact, hitCount: hitCount || (existing && existing.hitCount) || 1, lastUpdated: now, vector: vec || (existing && existing.vector) || [], pageMd: pageMd || ('## 目前事實\n- ' + currentFact + '\n'), sourceRefs: merged });
        changed();
        await logEvent(conflict ? 'supersede' : 'ingest', entity, note, sessionId);
    }

    async function updateEntityFreq(entities, latestSummary, sourceRef, sessionId) {
        var now = Date.now();
        for (var i = 0; i < entities.length; i++) {
            var key = String(entities[i] || '').trim(); if (!key) continue;
            var ex = await getOne('entity_freq', key), count = 1;
            if (ex && ex.count30d && (now - ex.lastSeen) < ENTITY_WINDOW_DAYS * 86400000) count = (ex.count30d || 0) + 1;
            await put('entity_freq', { entity: key, count30d: count, lastSeen: now });
            if (count >= PROMOTE_THRESHOLD) { try { await consolidateCore(key, latestSummary || key, sourceRef || '', sessionId || '', count); } catch (e) { console.warn('[NOVA][記憶] 固化失敗，略過：', e); } }
        }
    }

    // ───────── 中期摘要 ─────────
    function sessionMsgs(sid) { return (W.appState ? appState.messages : []).filter(function (m) { return String(m.sessionId) === String(sid) && (m.sender === 'user' || m.sender === 'ai'); }); }
    function acceptSid(sid) { return !!sid && (W.NovaPrivate.isPrivate(sid) === CFG.priv); }   // 主記憶只收一般對話、私密記憶只收私密對話
    var _busy = {};
    async function maybeCompress(sessionId, force) {
        if (!isOn() || !gkey() || !sessionId || !acceptSid(sessionId)) return;
        try {
            var ai = sessionMsgs(sessionId).filter(function (m) { return m.sender === 'ai'; });
            var cp = await getOne('checkpoints', String(sessionId)); var done = (cp && cp.compressedCount) || 0;
            var left = ai.length - done; if (left <= 0) return; if (!force && left < COMPRESS_EVERY) return;
            if (_busy[sessionId]) return; _busy[sessionId] = true;
            compressSession(sessionId, done).catch(function (e) { console.warn('[NOVA][記憶] 背景摘要失敗：', e); }).then(function () { _busy[sessionId] = false; });
        } catch (e) { /* 背景任務 */ }
    }
    async function compressSession(sessionId, fromAi) {
        if (!acceptSid(sessionId)) return;
        var msgs = sessionMsgs(sessionId), ai = msgs.filter(function (m) { return m.sender === 'ai'; });
        var target = ai.slice(fromAi, fromAi + COMPRESS_EVERY); if (!target.length) return;
        var s = msgs.findIndex(function (m) { return m.id === target[0].id; }), e = msgs.findIndex(function (m) { return m.id === target[target.length - 1].id; });
        var transcript = msgs.slice(Math.max(0, s - COMPRESS_EVERY), e + 1).map(function (m) { return (m.sender === 'user' ? '使用者' : 'AI') + '：' + String(m.text || '').slice(0, 500); }).join('\n');
        if (!transcript.trim()) return;
        var profile = getProfile();
        var prompt = '請把以下這段對話壓縮成精簡的結構化摘要，只保留未來可能有用的事實/偏好/決定，不要保留寒暄或已經解決、不需要再追蹤的細節。';
        if (profile) prompt += '\n\n以下是使用者本人的背景資訊（由使用者自己填寫，可信度最高，請以此為主要依據判斷相關性）：\n' + profile + '\n\n抽取 entities 時，只列出「跟上面這位使用者本人、或使用者的專案/工作有關」的詞彙，不要列出對話裡提到、但純粹是查詢對象、跟使用者本身無關的第三方技術詞彙或名稱。';
        prompt += '\n\n對話內容：\n' + transcript.slice(0, 6000) + '\n\n請「只」輸出一個 JSON 物件（不要加 ```json 或任何其他文字），格式：\n{"topic":"這段對話的主題，一句話","entities":["提到的人名/專案名/產品名/重要關鍵詞，最多5個"],"summary":"高密度摘要，控制在80字以內"}\n如果這段對話沒有任何值得記住的內容，entities 給空陣列、summary 給空字串即可。';
        var parsed = null;
        try { parsed = parseJson(await generate(prompt, 20000)); } catch (err) { console.warn('[NOVA][記憶] 摘要失敗，checkpoint 仍前進：', err); }
        await put('checkpoints', { sessionId: String(sessionId), compressedCount: fromAi + target.length });   // 不論成敗都推進，避免卡住
        if (!parsed || !parsed.summary) return;
        var vec = await embedDoc(parsed.topic || '對話摘要', parsed.summary); if (!vec) return;
        var id = 'ep_' + sessionId + '_' + Date.now();
        await put('episodic', { id: id, sessionId: String(sessionId), summary: parsed.summary, topic: parsed.topic || '', entities: Array.isArray(parsed.entities) ? parsed.entities.slice(0, 5) : [], vector: vec, createdAt: Date.now(), sourceRange: target[0].time + '~' + target[target.length - 1].time });
        changed();
        if (Array.isArray(parsed.entities) && parsed.entities.length) await updateEntityFreq(parsed.entities, parsed.summary, id, String(sessionId));
    }

    // ───────── 檢索 ─────────
    async function retrieveContext(queryText, opts) {
        opts = opts || {};
        if (!isOn() || !gkey() || (W.NovaPrivate.isCurrent() !== CFG.priv)) return { found: false, context: '' };
        try {
            var qv = (typeof W.novaKbEmbedQuery === 'function') ? await timeoutP(W.novaKbEmbedQuery(String(queryText || '').slice(0, 600)), 10000, '嵌入') : null;
            var core = await getAll('core'), epi = opts.coreOnly ? [] : await getAll('episodic');
            var coreRows = core.map(function (r) { return { r: r, s: (r.vector && r.vector.length && qv) ? cosine(qv, r.vector) : null }; });
            var withVec = coreRows.filter(function (x) { return x.s !== null; }).sort(function (a, b) { return b.s - a.s; }).slice(0, CORE_TOP_K).map(function (x) { return x.r; });
            var _persona = coreRows.filter(function (x) { return x.s !== null && /^你的|名字|稱呼|身分|角色|人設|persona/i.test(String(x.r.entity || '')); }).slice(0, 4).map(function (x) { return x.r; });   // v1.x：AI 自己的名字／角色設定永遠納入，不受相似度排名影響
            withVec = withVec.concat(_persona.filter(function (r) { return withVec.indexOf(r) < 0; }));
            var noVec = coreRows.filter(function (x) { return x.s === null; }).map(function (x) { return x.r; });   // 沒向量的永遠納入（舊行為）
            var coreOut = withVec.concat(noVec).sort(function (a, b) { return (b.lastUpdated || 0) - (a.lastUpdated || 0); });
            var now = Date.now();
            var picks = qv ? epi.map(function (e) { var days = (now - (e.createdAt || now)) / 86400000; return { e: e, s: cosine(qv, e.vector) * Math.pow(DECAY_RATE, days / DECAY_HALFLIFE_DAYS), raw: cosine(qv, e.vector) }; })
                .filter(function (x) { return x.raw >= THRESHOLD; }).sort(function (a, b) { return b.s - a.s; }).slice(0, TOP_K).map(function (x) { return x.e; }) : [];
            var parts = [];
            if (coreOut.length) parts.push('[使用者已確認的長期事實（依確認時間由新到舊排序）——若與你原本的預設認知衝突（包含你自己的名字、身分、角色設定等），一律以下面這些使用者確認的事實為準：' + coreOut.map(function (r) { return r.entity + '：' + r.fact; }).join('；') + ']');
            if (picks.length) parts.push('[過去對話參考（背景資訊，供你理解脈絡用）：' + picks.map(function (p) { return (p.topic || '過去對話') + '：' + p.summary; }).join('；') + ']');
            // v1.4.0：主記憶才帶入「AI 思考」（桌面版 v3.73.0 對標）；私密記憶不產生也不引用
            if (!CFG.priv && W.NovaThoughts && typeof W.NovaThoughts.contextFor === 'function') {
                try {
                    var ents = coreOut.map(function (r) { return r.entity; }); picks.forEach(function (p) { (p.entities || []).forEach(function (en) { ents.push(en); }); });
                    var th = W.NovaThoughts.contextFor(queryText, { entities: ents, text: coreOut.map(function (r) { return r.entity + ' ' + r.fact; }).join(' ') + ' ' + picks.map(function (p) { return (p.topic || '') + ' ' + (p.summary || ''); }).join(' ') });
                    if (th) parts.push(th);
                } catch (e) { /* 不影響記憶檢索 */ }
            }
            return parts.length ? { found: true, context: parts.join('\n'), coreCount: coreOut.length, episodicCount: picks.length } : { found: false, context: '' };
        } catch (e) { console.warn('[NOVA][記憶] 檢索失敗，略過：', e); return { found: false, context: '' }; }
    }

    // ───────── 文件／筆記匯入 ─────────
    async function extractFacts(text, title) {
        if (!gkey() || !text) return [];
        var excerpt = String(text).slice(0, TEXT_LIMIT), profile = getProfile();
        var profileBlock = profile ? '\n\n以下是使用者本人的背景資訊（由使用者自己填寫，可信度最高，請以此為主要依據判斷這份文件的內容是否跟使用者本人/使用者的專案有關）：\n' + profile : '';
        var prompt = '請閱讀以下文件內容，找出其中「跟使用者本人、或使用者的專案/工作有關、值得長期記住的穩定事實」（例如使用者的身分、偏好、專案的固定架構資訊、重要決定），不要抽取文件裡暫時性、流水帳式的細節，也不要抽取純粹是參考資料/別人觀點、跟使用者本身無關的內容。最多抽取 ' + MAX_FACTS_PER_DOC + ' 筆，每筆包含一個簡短的主題名稱（entity）跟具體內容（fact）。如果這份文件裡沒有這類值得記住的穩定事實，facts 給空陣列即可，不要勉強硬湊。' + profileBlock +
            '\n\n文件標題：' + (title || '未命名') + '\n文件內容：\n' + excerpt + '\n\n請「只」輸出一個 JSON 物件（不要加 ```json 或任何其他文字），格式：\n{"facts": [{"entity": "...", "fact": "..."}]}';
        try { var p = parseJson(await generate(prompt, 20000)); return ((p && Array.isArray(p.facts)) ? p.facts : []).filter(function (f) { return f && f.entity && f.fact; }).slice(0, MAX_FACTS_PER_DOC); }
        catch (e) { console.warn('[NOVA][記憶Wiki] 文件事實抽取失敗，略過：', e); return []; }
    }
    // fire-and-forget 安全：內部吞掉所有錯誤
    async function ingestDocument(o) {
        o = o || {};
        if (CFG.priv || !isOn() || !gkey() || !o.text) return 0;   // 筆記／文件匯入只進主記憶，私密記憶不收
        try {
            var facts = await extractFacts(o.text, o.title), n = 0;
            for (var i = 0; i < facts.length; i++) { await consolidateCore(String(facts[i].entity).trim(), String(facts[i].fact).trim(), o.sourceRef || '', o.sessionId || '', 1, '文件/筆記匯入'); n++; }
            return n;
        } catch (e) { console.warn('[NOVA][記憶Wiki] ingestDocument 失敗，略過：', e); return 0; }
    }

    // ───────── 管理／備份 ─────────
    async function stats() { var r = await Promise.all([getAll('core'), getAll('episodic'), getAll('entity_freq'), getAll('log')]); return { core: r[0].length, episodic: r[1].length, entities: r[2].length, log: r[3].length }; }
    async function exportAll() {
        var r = await Promise.all([getAll('core'), getAll('episodic'), getAll('entity_freq'), getAll('checkpoints'), getAll('log'), getOne('meta', 'schema')]);
        return { v: 1, core: r[0], episodic: r[1], entityFreq: r[2], checkpoints: r[3], log: r[4].slice(-300), schema: (r[5] && r[5].value) || '', profile: getProfile(), mode: isOn() ? 'on' : 'off' };
    }
    async function importAll(d) {
        if (!d || typeof d !== 'object') return 0; var n = 0;
        var pairs = [['core', d.core], ['episodic', d.episodic], ['entity_freq', d.entityFreq], ['checkpoints', d.checkpoints], ['log', d.log]];
        for (var i = 0; i < pairs.length; i++) { var arr = pairs[i][1]; if (!Array.isArray(arr)) continue; for (var j = 0; j < arr.length; j++) { try { await put(pairs[i][0], arr[j]); n++; } catch (e) { /* 單筆壞掉略過 */ } } }
        if (d.schema) await writeSchema(d.schema);
        if (typeof d.profile === 'string' && d.profile) setProfile(d.profile);
        if (d.mode) setOn(d.mode !== 'off');
        return n;
    }
    async function clearAll() { await Promise.all(['core', 'episodic', 'entity_freq', 'checkpoints', 'log'].map(clear)); try { !CFG.priv && W.NovaMemSync && W.NovaMemSync.markClearedAll(); } catch (e) {} changed(); }

    // ───────── 設定頁 ─────────
    var ui = { root: null }, openSet = {};
    async function renderSettings(el) {
        ui.root = el || ui.root; el = ui.root; if (!el) return;
        var LK = CFG.priv ? W.NovaPrivateLock : null;
        if (LK && !LK.unlocked()) {
            el.innerHTML = '<div class="nv-card"><h4>🕶️ 私密記憶・已上鎖</h4><p class="nv-muted">' + (LK.hasPw() ? '輸入密碼後才能查看與管理私密記憶。' : '尚未設定密碼，請先設定才能進入私密記憶。') + '</p><button class="nv-btn" id="nm-unlock" style="margin-top:6px">' + (LK.hasPw() ? '🔓 解鎖' : '🔐 設定密碼並進入') + '</button></div>';
            el.querySelector('#nm-unlock').onclick = async function () { if (await LK.ask()) renderSettings(el); };
            return;
        }
        var st = await stats(), core = (await getAll('core')).sort(function (a, b) { return (b.lastUpdated || 0) - (a.lastUpdated || 0); });
        var epi = (await getAll('episodic')).sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); }).slice(0, 30);
        var log = (await getAll('log')).sort(function (a, b) { return b.ts - a.ts; }).slice(0, 20);
        var sid = W.appState && appState.currentSessionId;
        el.innerHTML = (LK ? '<div class="nv-card"><div style="display:flex;align-items:center;gap:8px"><b style="flex:1">🔓 私密記憶已解鎖</b><button class="nv-btn" id="nm-relock">上鎖</button></div><details style="margin-top:6px"><summary style="cursor:pointer" class="nv-muted">變更密碼</summary><input id="nm-pw-old" type="password" class="nv-input" placeholder="舊密碼" style="margin-top:6px"><input id="nm-pw-new" type="password" class="nv-input" placeholder="新密碼（至少 4 字元）" style="margin-top:6px"><button class="nv-btn" id="nm-pw-save" style="margin-top:6px">儲存新密碼</button></details></div>' : '') +
            '<div class="nv-card" style="margin-top:' + (LK ? 8 : 0) + 'px"><h4>' + (CFG.priv ? '🕶️ 私密記憶（只供私密對話使用，與上方主記憶完全分開）' : '🧠 AI 記憶') + '</h4><label class="nova-em-item"><input type="checkbox" id="nm-on" ' + (isOn() ? 'checked' : '') + '> <span>啟用記憶（背景摘要對話、固化長期事實、回答前自動帶入相關記憶）</span></label>' +
            '<p class="nv-muted" style="margin-top:6px">資料只存在這支手機（IndexedDB），不上傳；摘要與固化會呼叫 Gemini 輕量模型。</p></div>' +
            '<div class="nv-card" style="margin-top:8px"><h4>目前記憶量</h4><div class="nv-muted">長期事實 ' + st.core + ' 筆｜對話摘要 ' + st.episodic + ' 筆｜追蹤中的實體 ' + st.entities + ' 個</div>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px"><button class="nv-btn" id="nm-now">立即整理目前對話</button><button class="nv-btn nv-danger" id="nm-clear">清空全部記憶</button></div></div>' +
            '<div class="nv-card" style="margin-top:8px"><h4>使用者 Profile</h4><textarea id="nm-profile" class="nv-input" rows="3" placeholder="例：我是 XX，從事 XX，目前專案是 XX（讓記憶只記跟你有關的事）">' + esc(getProfile()) + '</textarea><button class="nv-btn" id="nm-profile-save" style="margin-top:6px">儲存 Profile</button></div>' +
            '<details class="nv-card nm-fold" data-f="core"' + (openSet.core ? ' open' : '') + ' style="margin-top:8px"><summary style="cursor:pointer;font-weight:700">長期事實（' + core.length + '）</summary>' + (core.length ? core.map(function (r) { return '<div class="nova-em-item" style="align-items:flex-start;gap:8px"><div style="flex:1;min-width:0"><b>' + esc(r.entity) + '</b><div class="nv-muted" style="word-break:break-word">' + esc(r.fact) + '</div></div><button class="nv-btn nm-del-core" data-k="' + esc(r.entity) + '">刪除</button></div>'; }).join('') : '<p class="nv-muted">還沒有。同一個主題 30 天內被提到 3 次、或匯入文件／筆記時抽到穩定事實，就會出現在這裡。</p>') + '</details>' +
            '<details class="nv-card nm-fold" data-f="epi"' + (openSet.epi ? ' open' : '') + ' style="margin-top:8px"><summary style="cursor:pointer;font-weight:700">對話摘要（最近 ' + epi.length + ' 筆）</summary>' + (epi.length ? epi.map(function (r) { return '<div class="nova-em-item" style="align-items:flex-start;gap:8px"><div style="flex:1;min-width:0"><b>' + esc(r.topic || '對話') + '</b><div class="nv-muted" style="word-break:break-word">' + esc(r.summary) + '</div></div><button class="nv-btn nm-del-epi" data-k="' + esc(r.id) + '">刪除</button></div>'; }).join('') : '<p class="nv-muted">還沒有。每 10 則 AI 回覆會自動摘要一次。</p>') + '</details>' +
            '<details class="nv-card" style="margin-top:8px"><summary style="cursor:pointer;font-weight:700">維護守則（schema）</summary><textarea id="nm-schema" class="nv-input" rows="10" style="margin-top:6px;font-size:12px"></textarea><div style="display:flex;gap:8px;margin-top:6px"><button class="nv-btn" id="nm-schema-save">儲存</button><button class="nv-btn" id="nm-schema-reset">還原預設</button></div></details>' +
            '<details class="nv-card" style="margin-top:8px"><summary style="cursor:pointer;font-weight:700">操作紀錄（最近 20 筆）</summary>' + (log.length ? log.map(function (l) { return '<div class="nv-muted" style="margin-top:4px">' + new Date(l.ts).toLocaleString() + '｜' + esc(l.op) + '｜' + esc(l.entity) + '：' + esc(l.detail) + '</div>'; }).join('') : '<p class="nv-muted">沒有紀錄</p>') + '</details>';
        var $ = function (id) { return el.querySelector('#' + id); };
        readSchema().then(function (t) { var s = $('nm-schema'); if (s) s.value = t; });
        Array.prototype.forEach.call(el.querySelectorAll('details.nm-fold'), function (d) { d.addEventListener('toggle', function () { openSet[d.getAttribute('data-f')] = d.open; }); });
        if (LK) {
            $('nm-relock').onclick = function () { LK.lock(); renderSettings(el); };
            $('nm-pw-save').onclick = async function () {
                var o = $('nm-pw-old').value, n = $('nm-pw-new').value;
                if (!(await LK.verify(o))) { toast('舊密碼錯誤'); return; }
                if (n.length < 4) { toast('新密碼至少 4 個字元'); return; }
                await LK.setPassword(n); toast('🔐 密碼已更新'); renderSettings(el);
            };
        }
        $('nm-on').onchange = function (e) { setOn(e.target.checked); toast(e.target.checked ? '🧠 記憶已開啟' : '🧠 記憶已關閉'); };
        $('nm-profile-save').onclick = function () { setProfile($('nm-profile').value); toast('✅ 已儲存 Profile'); };
        $('nm-now').onclick = async function () { if (!sid || !acceptSid(sid)) { toast(CFG.priv ? '目前不是私密對話' : '目前沒有對話或目前是私密對話'); return; } if (!gkey()) { toast('需要 Gemini API Key'); return; } toast('整理中…'); await maybeCompress(sid, true); setTimeout(function () { renderSettings(); }, 4000); };
        $('nm-clear').onclick = async function () { var ok = W.showConfirm ? await W.showConfirm('確定清空全部 AI 記憶（長期事實、對話摘要、實體統計）？此操作無法復原。') : true; if (ok) { await clearAll(); toast('已清空'); renderSettings(); } };
        $('nm-schema-save').onclick = async function () { await writeSchema($('nm-schema').value); toast('✅ 已儲存維護守則'); };
        $('nm-schema-reset').onclick = async function () { await resetSchema(); $('nm-schema').value = DEFAULT_SCHEMA_MD; toast('已還原預設'); };
        Array.prototype.forEach.call(el.querySelectorAll('.nm-del-core'), function (b) { b.onclick = async function () { await del('core', b.getAttribute('data-k')); try { !CFG.priv && W.NovaMemSync && W.NovaMemSync.markCoreDeleted(b.getAttribute('data-k')); } catch (e) {} changed(); renderSettings(); }; });
        Array.prototype.forEach.call(el.querySelectorAll('.nm-del-epi'), function (b) { b.onclick = async function () { await del('episodic', b.getAttribute('data-k')); try { !CFG.priv && W.NovaMemSync && W.NovaMemSync.markEpisodicDeleted(b.getAttribute('data-k')); } catch (e) {} changed(); renderSettings(); }; });
    }

    return { isOn: isOn, setOn: setOn, getProfile: getProfile, setProfile: setProfile, maybeCompress: maybeCompress, compressSession: compressSession, retrieveContext: retrieveContext,
        ingestDocument: ingestDocument, extractFacts: extractFacts, consolidateCore: consolidateCore, updateEntityFreq: updateEntityFreq, stats: stats, exportAll: exportAll, importAll: importAll, clearAll: clearAll,
        renderSettings: renderSettings, readSchema: readSchema, DEFAULT_SCHEMA_MD: DEFAULT_SCHEMA_MD, _open: open, _getAll: getAll, _getOne: getOne, _put: put, _del: del, _cosine: cosine };
    }
    W.NovaMemory = createMemory({ dbName: 'nova_memory_db', profileKey: 'nova_mem_user_profile', modeKey: 'nova_mem_mode', event: 'nova-memory-changed', priv: false });
    W.NovaMemoryPrivate = createMemory({ dbName: 'nova_memory_private_db', profileKey: 'nova_pmem_user_profile', modeKey: 'nova_pmem_mode', event: 'nova-pmemory-changed', priv: true });
})();

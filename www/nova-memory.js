/* ═══════════════════════════════════════════════════════════════════════
   nova-memory.js — NOVA Android 的「AI 記憶系統」（IndexedDB 版；跟 index.html 放同一個資料夾 www/）
   版本：v1.6.0
   版本紀錄：
   v1.6.0 - App v2.6.129：主記憶接上與桌面共用的記憶核心（新檔 nova-memory-core.js v1.0.0，對標桌面 desktop-patch v3.124.0；nova-memsync.js v1.2.0）。私密記憶完全不動。
            ① 摘要時直接抽「原子事實」（類型、所屬實體、信心）：偏好／身分／做法類一次就進長期記憶，其餘照頻率；摘要失敗排進重試佇列（存在 meta 的 pending，
               不改資料庫版本），不再遺失；逐字稿只帶這一段新的對話。
            ② 檢索改成向量＋關鍵字混合、長期事實有相關度門檻（原本沒向量的一律帶入、有向量的固定帶前 5 筆）、被用到的延後衰減、承接上文的問句帶上前兩句、
               附「多久以前」、同專案加分。
            ③ 實體別名（不同寫法併成同一個實體）、記住／忘記（remember／forget）、釘選、這段對話不要記（setSkipped）、Bot 的記憶提案、機密偵測。
            ④ 記憶整理 maintain（重試、補向量、合併重複、檢查矛盾、濃縮舊摘要；每 20 小時在背景做一次，設定頁可手動）與健檢 lint。
            ⑤ 不綁 Gemini：沒有 Gemini 金鑰時用 OpenAI 或 Grok 摘要，檢索退成只用關鍵字。
            ⑥ 每筆記憶多了選用欄位 x（附加資料）、embModel、lastUsed、useCount；舊資料沒有這些欄位照常使用。備份 exportAll 多帶 pending。
            ⑦ 設定頁：長期事實顯示類型／釘選／別名並可切換釘選；新增「記憶整理與進階」卡片。
            nova-memory-core.js 沒載入時，全部退回 v1.5.0 的做法。對外多：engine／remember／forget／setPinned／lint／maintain／isSkipped／setSkipped／explicitFromUserText。
   v1.5.0 - App v2.6.89：私密記憶（CFG.priv）完全用 Grok：回覆後摘要、長期事實固化、文件事實抽取都呼叫 Grok（沒有 Grok 金鑰就不處理，不退回 Gemini）；不呼叫嵌入模型，檢索改成本機關鍵字（2 字片段）比對。主記憶不受影響。
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
    // v1.5.0：私密記憶只用 Grok（摘要／固化／事實抽取），不碰 Gemini／OpenAI／Jev，也不呼叫嵌入模型（檢索改本機關鍵字比對）
    function gkey() { return CFG.priv ? ((W.appState && appState.keys && appState.keys.grok) || localStorage.getItem('nova_key_grok') || '') : ((W.appState && appState.keys && appState.keys.gemini) || ''); }
    function model() { return W.NOVA_GEMINI_MODEL_LITE || 'gemini-3.5-flash-lite'; }
    function toast(m) { try { W.showToast && W.showToast(m); } catch (e) { /* ignore */ } }
    function changed() { try { W.dispatchEvent(new Event(CFG.event)); } catch (e) { /* ignore */ } }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function timeoutP(p, ms, label) { return Promise.race([p, new Promise(function (_, rej) { setTimeout(function () { rej(new Error((label || '呼叫') + '逾時')); }, ms); })]); }

    async function generate(prompt, ms) {
        var key = gkey(); if (!key) throw new Error(CFG.priv ? '缺少 Grok API Key（私密記憶只用 Grok）' : '缺少 Gemini API Key');
        if (CFG.priv) {
            var gm = (W.appState && appState.grokModel) || ''; if (!/^grok-/.test(gm) || /multi|auto|imagine|image|video/.test(gm)) gm = 'grok-4.3';
            var gr = await timeoutP(fetch('https://api.x.ai/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key }, body: JSON.stringify({ model: gm, messages: [{ role: 'user', content: prompt }], temperature: 0.2 }) }), ms || 20000, 'Grok 呼叫');
            if (!gr.ok) throw new Error('Grok API 呼叫失敗 ' + gr.status);
            var gd = await gr.json(); return String((gd.choices && gd.choices[0] && gd.choices[0].message && gd.choices[0].message.content) || '').trim();
        }
        var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model() + ':generateContent?key=' + key;
        var res = await timeoutP(fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }) }), ms || 20000, '記憶 LLM');
        if (!res.ok) throw new Error('API 呼叫失敗 ' + res.status);
        var data = await res.json();
        var c = data.candidates && data.candidates[0];
        return ((c && c.content && c.content.parts && c.content.parts[0] && c.content.parts[0].text) || '').trim();
    }
    function parseJson(raw) { var m = String(raw || '').match(/\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]); } catch (e) { return null; } }
    async function embedDoc(entityOrTopic, text) {
        if (CFG.priv) return [];   // 私密記憶不呼叫嵌入模型（空向量＝改用關鍵字比對）
        if (!gkey() || typeof W.novaKbEmbedDocumentBatch !== 'function') return null;
        try { var v = await timeoutP(W.novaKbEmbedDocumentBatch(['task: search result | title: ' + entityOrTopic + ' | text: ' + text]), 15000, '嵌入'); return (v && v[0]) || null; }
        catch (e) { console.warn('[NOVA][記憶] 嵌入失敗（不影響儲存）', e); return null; }
    }
    function grams(t) { t = String(t || '').toLowerCase().replace(/[\s\u3000,，。.!！?？、;；:：()（）「」\[\]"'`~\-]+/g, ''); var g = {}, n = 0; for (var i = 0; i < t.length - 1; i++) { g[t.substr(i, 2)] = 1; n++; } if (t.length === 1) { g[t] = 1; n = 1; } return { g: g, n: n }; }
    function lexScore(q, text) { var a = grams(q), b = grams(text); if (!a.n || !b.n) return 0; var hit = 0; Object.keys(a.g).forEach(function (k) { if (b.g[k]) hit++; }); var na = Object.keys(a.g).length; return (hit >= 2 || na < 8) ? hit / na : 0; }   // 查詢的 2 字片段有多少比例出現在記憶裡（查詢長時至少要中 2 個，避免只靠「今天」之類的字湊數）
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
        var E0 = engine();
        if (E0) {   // v1.6.0：走記憶核心（別名解析、事實時間軸、機密偵測）；失敗才用下面原本的做法
            try { var r0 = await E0.consolidate(await E0.resolveEntity(entity), { text: newFact, kind: 'fact', src: srcLabel ? 'doc' : 'chat', label: srcLabel || undefined }, { sourceRef: sourceRef || '', sessionId: sessionId || '', hitCount: hitCount }); if (r0 && (r0.ok || r0.secret)) return; }
            catch (e0) { console.warn('[NOVA][記憶] 核心固化失敗，改用原本的做法：', e0); }
        }
        var now = Date.now();
        var existing = await getOne('core', entity);
        var refs = (existing && Array.isArray(existing.sourceRefs)) ? existing.sourceRefs : [];
        var merged = sourceRef ? refs.concat([sourceRef]).slice(-20) : refs;
        var label = srcLabel ? '（來源：' + srcLabel + '）' : '';
        var pageMd, currentFact, conflict = false, note;
        if (!gkey()) {
            pageMd = existing && existing.pageMd; currentFact = newFact; note = '未設定 API Key，略過 LLM 合併判斷';
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

    // ───────── v1.6.0：記憶核心（nova-memory-core.js；桌面與手機共用同一份邏輯，這裡接 IndexedDB）─────────
    var _eng = null, _maintBusy = false;
    function kvGet(k) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? null : v; } catch (e) { return null; } }
    function kvSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } }
    function keyOf(name) { try { return (W.appState && appState.keys && appState.keys[name]) || localStorage.getItem('nova_key_' + name) || ''; } catch (e) { return ''; } }
    function embModelName() { try { return (typeof NOVA_KB_EMBED_MODEL !== 'undefined' && NOVA_KB_EMBED_MODEL) || 'gemini-embedding-2'; } catch (e) { return 'gemini-embedding-2'; } }
    function scopeOf(sid) { try { var n = ((W.appState && appState.sessionFolderMap) || {})[String(sid)]; return n ? 'proj:' + n : ''; } catch (e) { return ''; } }
    // 摘要／合併用的模型：Gemini 輕量 → OpenAI → Grok（主記憶不綁特定廠商；私密記憶仍只用 Grok，見 generate）
    async function generateAny(prompt, ms) {
        if (keyOf('gemini')) return generate(prompt, ms);
        var ok = keyOf('openai'), gk = keyOf('grok'), url, key, model;
        if (ok) { url = 'https://api.openai.com/v1/chat/completions'; key = ok; model = (W.appState && appState.gptModel) || 'gpt-6-luna'; if (!/^gpt-/.test(model) || /image|tts|audio|realtime|embedding|transcribe/i.test(model)) model = 'gpt-6-luna'; }
        else if (gk) { url = 'https://api.x.ai/v1/chat/completions'; key = gk; model = (W.appState && appState.grokModel) || ''; if (!/^grok-/.test(model) || /multi|auto|imagine|image|video/.test(model)) model = 'grok-4.3'; }
        else throw new Error('沒有可用的模型金鑰');
        var r = await timeoutP(fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key }, body: JSON.stringify({ model: model, messages: [{ role: 'user', content: prompt }] }) }), ms || 20000, '記憶 LLM');
        if (!r.ok) throw new Error('API 呼叫失敗 ' + r.status);
        var d = await r.json(); return String((d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '').trim();
    }
    function toCore(r) { return r ? { entity: r.entity, fact: r.fact || '', hit_count: r.hitCount || 1, last_updated: r.lastUpdated || 0, vector: r.vector || [], page_md: r.pageMd || '', source_refs: r.sourceRefs || [], x: (r.x && typeof r.x === 'object') ? r.x : undefined, emb_model: r.embModel || '', last_used: r.lastUsed || 0, use_count: r.useCount || 0 } : null; }
    function toEpi(e) { return e ? { id: e.id, session_id: e.sessionId || '', summary: e.summary || '', topic: e.topic || '', entities: e.entities || [], vector: e.vector || [], created_at: e.createdAt || 0, source_range: e.sourceRange || '', x: (e.x && typeof e.x === 'object') ? e.x : undefined, emb_model: e.embModel || '', last_used: e.lastUsed || 0, use_count: e.useCount || 0 } : null; }
    async function pendList() { var r = await getOne('meta', 'pending'); return (r && Array.isArray(r.value)) ? r.value : []; }
    async function pendSave(a) { await put('meta', { key: 'pending', value: a.slice(-100) }); }
    function engine() {
        if (CFG.priv || !W.NovaMemoryCore) return null;   // 私密記憶維持原本的做法（只用 Grok、本機關鍵字）
        if (_eng) return _eng;
        var store = {
            coreAll: async function () { return (await getAll('core')).map(toCore); },
            coreGet: async function (entity) { return toCore(await getOne('core', entity)); },
            corePut: async function (r) {
                var cur = (await getOne('core', r.entity)) || {};
                if (r._vecOnly) { if (!cur.entity) return; cur.vector = r.vector || []; cur.embModel = r.emb_model || ''; await put('core', cur); return; }
                var hasVec = !!(r.vector && r.vector.length);
                await put('core', { entity: r.entity, fact: r.fact || '', hitCount: r.hit_count || 1, lastUpdated: r.last_updated || Date.now(), vector: hasVec ? r.vector : (cur.vector || []),
                    pageMd: r.page_md || '', sourceRefs: r.source_refs || [], x: r.x === undefined ? cur.x : r.x, embModel: hasVec ? (r.emb_model || '') : (cur.embModel || ''), lastUsed: cur.lastUsed || 0, useCount: cur.useCount || 0 });
            },
            coreDel: async function (entity) { await del('core', entity); try { W.NovaMemSync && W.NovaMemSync.markCoreDeleted(entity); } catch (e) { /* 同步墓碑 */ } },
            epiAll: async function () { return (await getAll('episodic')).map(toEpi); },
            epiPut: async function (e) {
                var cur = (await getOne('episodic', e.id)) || {};
                if (e._vecOnly) { if (!cur.id) return; cur.vector = e.vector || []; cur.embModel = e.emb_model || ''; await put('episodic', cur); return; }
                var hasVec = !!(e.vector && e.vector.length);
                await put('episodic', { id: e.id, sessionId: e.session_id || '', summary: e.summary || '', topic: e.topic || '', entities: e.entities || [], vector: hasVec ? e.vector : (cur.vector || []),
                    createdAt: e.created_at || Date.now(), sourceRange: e.source_range || '', x: e.x === undefined ? cur.x : e.x, embModel: hasVec ? (e.emb_model || '') : (cur.embModel || ''), lastUsed: cur.lastUsed || 0, useCount: cur.useCount || 0 });
                if (e._edited) { try { W.NovaMemSync && W.NovaMemSync.markEpisodicEdited(e.id); } catch (e2) { /* 讓這次修改能同步出去 */ } }
            },
            freqGet: async function (entity) { var f = await getOne('entity_freq', entity); return f ? { entity: f.entity, count_30d: f.count30d || 0, last_seen: f.lastSeen || 0 } : null; },
            freqPut: function (f) { return put('entity_freq', { entity: f.entity, count30d: f.count_30d, lastSeen: f.last_seen }); },
            freqAll: async function () { return (await getAll('entity_freq')).map(function (f) { return { entity: f.entity, count_30d: f.count30d || 0, last_seen: f.lastSeen || 0 }; }); },
            pendingAdd: async function (d) {
                var a = await pendList();
                a.push({ id: 'mp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), session_id: String(d.session_id || ''), transcript: String(d.transcript || '').slice(0, 40000), range: String(d.range || ''), scope: String(d.scope || ''), attempts: 0, created_at: d.created_at || Date.now(), last_error: String(d.last_error || '').slice(0, 200) });
                await pendSave(a); return { ok: true };
            },
            pendingAll: pendList,
            pendingDel: async function (id) { await pendSave((await pendList()).filter(function (p) { return p.id !== id; })); },
            pendingFail: async function (id, err) { var a = await pendList(); a.forEach(function (p) { if (p.id === id) { p.attempts = (p.attempts || 0) + 1; p.last_error = String(err || '').slice(0, 200); } }); await pendSave(a); },
            log: logEvent,
            logRecent: async function (n) { return (await getAll('log')).sort(function (a, b) { return b.ts - a.ts; }).slice(0, n || 100).map(function (l) { return { ts: l.ts, op: l.op, entity: l.entity, detail: l.detail, session_id: l.sessionId }; }); },
            schema: readSchema,
            touch: async function (ents, ids, t) {
                for (var i = 0; i < ents.length; i++) { var c = await getOne('core', ents[i]); if (c) { c.lastUsed = t; c.useCount = (c.useCount || 0) + 1; await put('core', c); } }
                for (var j = 0; j < ids.length; j++) { var e = await getOne('episodic', ids[j]); if (e) { e.lastUsed = t; e.useCount = (e.useCount || 0) + 1; await put('episodic', e); } }
            }
        };
        _eng = W.NovaMemoryCore.create({
            store: store, kv: { get: kvGet, set: kvSet },
            llm: function (prompt, o) { return generateAny(prompt, (o && o.ms) || 20000); },
            hasLlm: function () { return !!(keyOf('gemini') || keyOf('openai') || keyOf('grok')); },
            embedDocs: function (texts) { return timeoutP(W.novaKbEmbedDocumentBatch(texts), 15000, '嵌入'); },
            embedQuery: function (t) { return timeoutP(W.novaKbEmbedQuery(t), 10000, '嵌入'); },
            hasEmbed: function () { return !!keyOf('gemini') && typeof W.novaKbEmbedDocumentBatch === 'function' && typeof W.novaKbEmbedQuery === 'function'; },
            embModel: embModelName(), profile: getProfile, changed: changed,
            onProposal: function () { toast('🧠 Bot 提議記住一件事，請到「設定 → 記憶」確認'); },
            warn: function () { console.warn.apply(console, arguments); }
        });
        return _eng;
    }
    async function compress2(E, sessionId, fromAi) {
        var msgs = sessionMsgs(sessionId), ai = msgs.filter(function (m) { return m.sender === 'ai'; });
        var target = ai.slice(fromAi, fromAi + COMPRESS_EVERY); if (!target.length) return;
        var s0 = msgs.findIndex(function (m) { return m.id === target[0].id; }), e0 = msgs.findIndex(function (m) { return m.id === target[target.length - 1].id; });
        for (var k = 0; k < 3 && s0 > 0 && msgs[s0 - 1].sender === 'user'; k++) s0--;   // 帶上這段開頭的使用者提問；更早的已經摘要過
        var r = await E.ingestTranscript({ sessionId: String(sessionId), transcript: E.buildTranscript(msgs.slice(Math.max(0, s0), e0 + 1)), range: target[0].time + '~' + target[target.length - 1].time, scope: scopeOf(sessionId) });
        if (r.ok || r.queued || r.empty) await put('checkpoints', { sessionId: String(sessionId), compressedCount: fromAi + target.length });   // 失敗的已經進重試佇列，進度可以往前
    }
    async function maintain(o) {
        var E = engine(); if (!E) return { ok: false, note: '記憶核心沒有載入' };
        if (_maintBusy) return { ok: false, note: '記憶整理進行中' };
        _maintBusy = true;
        try {
            var rep = await E.maintain(Object.assign({ budgetMs: 90000 }, o || {}));
            return { ok: true, rep: rep, note: '重試摘要 ' + rep.pending.done + '/' + rep.pending.tried + '、補向量 ' + rep.embedded + '、合併重複 ' + rep.merged + '、發現矛盾 ' + rep.conflicts + '、濃縮舊摘要 ' + rep.digests };
        } catch (e) { return { ok: false, note: '記憶整理失敗：' + (e.message || e) }; }
        finally { _maintBusy = false; }
    }
    // 背景：重試佇列有東西、或超過 20 小時沒整理 → 整理一次（最多每小時試一次；手機沒有常駐大腦，靠這裡）
    function poke() {
        try {
            var E = engine(); if (!E || !isOn() || !E.hasLlm()) return;
            var now = Date.now(), last = Number(kvGet('nova_mem_maintain_last')) || 0, tried = Number(kvGet('nova_mem_maintain_try')) || 0;
            if (now - tried < 3600000) return;
            pendList().then(function (p) { if (p.length || now - last > 20 * 3600000) { kvSet('nova_mem_maintain_try', now); maintain({}); } }).catch(function () { /* 背景工作 */ });
        } catch (e) { /* 背景工作 */ }
    }

    // ───────── 中期摘要 ─────────
    function sessionMsgs(sid) { return (W.appState ? appState.messages : []).filter(function (m) { return String(m.sessionId) === String(sid) && (m.sender === 'user' || m.sender === 'ai'); }); }
    function acceptSid(sid) { return !!sid && (W.NovaPrivate.isPrivate(sid) === CFG.priv); }   // 主記憶只收一般對話、私密記憶只收私密對話
    var _busy = {};
    async function maybeCompress(sessionId, force) {
        if (!isOn() || !sessionId || !acceptSid(sessionId)) return;
        var E = engine();
        if (E) {   // v1.6.0：主記憶走記憶核心
            try {
                if (E.isSkipped(sessionId) || !E.hasLlm()) return;
                var ai2 = sessionMsgs(sessionId).filter(function (m) { return m.sender === 'ai'; });
                var cp2 = await getOne('checkpoints', String(sessionId)), done2 = (cp2 && cp2.compressedCount) || 0, left2 = ai2.length - done2;
                poke();
                if (left2 <= 0) return; if (!force && left2 < COMPRESS_EVERY) return;
                if (_busy[sessionId]) return; _busy[sessionId] = true;
                compress2(E, sessionId, done2).catch(function (e) { console.warn('[NOVA][記憶] 背景摘要失敗：', e); }).then(function () { _busy[sessionId] = false; });
            } catch (e) { /* 背景任務 */ }
            return;
        }
        if (!gkey()) return;
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
        if (!isOn() || (W.NovaPrivate.isCurrent() !== CFG.priv)) return { found: false, context: '' };
        var E = engine();
        if (E) {   // v1.6.0：主記憶走記憶核心的混合檢索；失敗才用下面原本的做法
            try {
                var sidN = String((W.appState && appState.currentSessionId) || '');
                var hist = (W.appState ? appState.messages : []).filter(function (m) { return (m.sender === 'user' || m.sender === 'ai') && m.text && String(m.sessionId) === sidN; }).slice(-5).map(function (m) { return { text: m.text }; });
                var rr = await E.retrieve(String(queryText || '').slice(0, 600), { coreOnly: !!opts.coreOnly, history: hist, scope: scopeOf(sidN) });
                var ctx = rr.context || '';
                if (W.NovaThoughts && !opts.coreOnly) {
                    try { var th0 = W.NovaThoughts.contextFor(queryText, { entities: rr.core.map(function (c) { return c.entity; }), text: rr.core.map(function (c) { return c.entity + ' ' + c.fact; }).concat(rr.episodic.map(function (p) { return (p.topic || '') + ' ' + (p.summary || ''); })).join(' ') }); if (th0) ctx = ctx ? ctx + '\n' + th0 : th0; } catch (eT) { /* 不影響檢索 */ }
                }
                return ctx ? { found: true, context: ctx, coreCount: rr.core.length, episodicCount: rr.episodic.length } : { found: false, context: '' };
            } catch (eR) { console.warn('[NOVA][記憶] 新版檢索失敗，這次改用原本的檢索：', eR); }
        }
        if (!CFG.priv && !gkey()) return { found: false, context: '' };
        try {
            var qv = CFG.priv ? null : (typeof W.novaKbEmbedQuery === 'function') ? await timeoutP(W.novaKbEmbedQuery(String(queryText || '').slice(0, 600)), 10000, '嵌入') : null;
            var core = await getAll('core'), epi = opts.coreOnly ? [] : await getAll('episodic');
            if (CFG.priv) {   // 私密記憶：本機關鍵字比對（不用任何外部模型）
                var q = String(queryText || '').slice(0, 600), now0 = Date.now();
                var cs = core.map(function (r) { return { r: r, s: lexScore(q, (r.entity || '') + ' ' + (r.fact || '')) }; });
                var cOut = cs.filter(function (x) { return x.s >= 0.15; }).sort(function (a, b) { return b.s - a.s; }).slice(0, CORE_TOP_K).map(function (x) { return x.r; });
                cs.forEach(function (x) { if (/^你的|名字|稱呼|身分|角色|人設|persona/i.test(String(x.r.entity || '')) && cOut.indexOf(x.r) < 0 && cOut.length < CORE_TOP_K + 4) cOut.push(x.r); });
                cOut.sort(function (a, b) { return (b.lastUpdated || 0) - (a.lastUpdated || 0); });
                var eOut = epi.map(function (e) { var d = (now0 - (e.createdAt || now0)) / 86400000; return { e: e, raw: lexScore(q, (e.topic || '') + ' ' + (e.summary || '') + ' ' + (e.entities || []).join(' ')), d: d }; })
                    .filter(function (x) { return x.raw >= 0.15; }).sort(function (a, b) { return b.raw * Math.pow(DECAY_RATE, b.d / DECAY_HALFLIFE_DAYS) - a.raw * Math.pow(DECAY_RATE, a.d / DECAY_HALFLIFE_DAYS); }).slice(0, TOP_K).map(function (x) { return x.e; });
                var pp = [];
                if (cOut.length) pp.push('[使用者已確認的長期事實（依確認時間由新到舊排序）——若與你原本的預設認知衝突，一律以下面這些使用者確認的為準：' + cOut.map(function (r) { return r.entity + '：' + r.fact; }).join('；') + ']');
                if (eOut.length) pp.push('[過去對話參考（背景資訊，供你理解脈絡用）：' + eOut.map(function (p) { return (p.topic || '過去對話') + '：' + p.summary; }).join('；') + ']');
                return pp.length ? { found: true, context: pp.join('\n'), coreCount: cOut.length, episodicCount: eOut.length } : { found: false, context: '' };
            }
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
        return { v: 1, core: r[0], episodic: r[1], entityFreq: r[2], checkpoints: r[3], log: r[4].slice(-300), schema: (r[5] && r[5].value) || '', profile: getProfile(), mode: isOn() ? 'on' : 'off', pending: await pendList() };   // v1.6.0：多帶重試佇列
    }
    async function importAll(d) {
        if (!d || typeof d !== 'object') return 0; var n = 0;
        var pairs = [['core', d.core], ['episodic', d.episodic], ['entity_freq', d.entityFreq], ['checkpoints', d.checkpoints], ['log', d.log]];
        for (var i = 0; i < pairs.length; i++) { var arr = pairs[i][1]; if (!Array.isArray(arr)) continue; for (var j = 0; j < arr.length; j++) { try { await put(pairs[i][0], arr[j]); n++; } catch (e) { /* 單筆壞掉略過 */ } } }
        if (d.schema) await writeSchema(d.schema);
        if (Array.isArray(d.pending) && d.pending.length) { try { await pendSave(d.pending); } catch (e) { /* 舊備份沒有 */ } }   // v1.6.0
        if (typeof d.profile === 'string' && d.profile) setProfile(d.profile);
        if (d.mode) setOn(d.mode !== 'off');
        return n;
    }
    async function clearAll() { await Promise.all(['core', 'episodic', 'entity_freq', 'checkpoints', 'log'].map(clear)); try { await del('meta', 'pending'); } catch (e) { /* v1.6.0：重試佇列一併清掉 */ } try { !CFG.priv && W.NovaMemSync && W.NovaMemSync.markClearedAll(); } catch (e) {} changed(); }

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
            '<p class="nv-muted" style="margin-top:6px">資料只存在這支手機（IndexedDB），不上傳；' + (CFG.priv ? '摘要與固化只用 Grok（需要 Grok 金鑰），檢索在手機本機比對，不經 Gemini／OpenAI／Jev。' : '摘要與固化會呼叫 Gemini 輕量模型（沒有 Gemini 金鑰時改用 OpenAI 或 Grok）。') + '</p></div>' +
            '<div class="nv-card" style="margin-top:8px"><h4>目前記憶量</h4><div class="nv-muted">長期事實 ' + st.core + ' 筆｜對話摘要 ' + st.episodic + ' 筆｜追蹤中的實體 ' + st.entities + ' 個</div>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px"><button class="nv-btn" id="nm-now">立即整理目前對話</button><button class="nv-btn nv-danger" id="nm-clear">清空全部記憶</button></div></div>' +
            '<div class="nv-card" style="margin-top:8px"><h4>使用者 Profile</h4><textarea id="nm-profile" class="nv-input" rows="3" placeholder="例：我是 XX，從事 XX，目前專案是 XX（讓記憶只記跟你有關的事）">' + esc(getProfile()) + '</textarea><button class="nv-btn" id="nm-profile-save" style="margin-top:6px">儲存 Profile</button></div>' +
            '<details class="nv-card nm-fold" data-f="core"' + (openSet.core ? ' open' : '') + ' style="margin-top:8px"><summary style="cursor:pointer;font-weight:700">長期事實（' + core.length + '）</summary>' + (core.length ? core.map(function (r) {
                var x = (r.x && typeof r.x === 'object') ? r.x : {}, kz = (W.NovaMemoryCore && W.NovaMemoryCore.KIND_ZH) || {}, al = Array.isArray(x.aliases) ? x.aliases : [];   // v1.6.0：類型／釘選／別名
                var tags = (x.pinned ? ' 📌' : '') + (x.kind && kz[x.kind] ? ' <span class="nv-muted">〔' + esc(kz[x.kind]) + '〕</span>' : '') + (x.scope ? ' <span class="nv-muted">〔' + esc(String(x.scope).replace(/^proj:/, '專案：')) + '〕</span>' : '') + (al.length ? ' <span class="nv-muted">別名：' + esc(al.slice(0, 4).join('、')) + '</span>' : '');
                return '<div class="nova-em-item" style="align-items:flex-start;gap:8px"><div style="flex:1;min-width:0"><b>' + esc(r.entity) + '</b>' + tags + '<div class="nv-muted" style="word-break:break-word">' + esc(r.fact) + '</div></div>'
                    + (engine() ? '<button class="nv-btn nm-pin-core" data-k="' + esc(r.entity) + '" data-on="' + (x.pinned ? '0' : '1') + '">' + (x.pinned ? '取消釘選' : '釘選') + '</button>' : '')
                    + '<button class="nv-btn nm-del-core" data-k="' + esc(r.entity) + '">刪除</button></div>'; }).join('') : '<p class="nv-muted">還沒有。同一個主題 30 天內被提到 3 次、或匯入文件／筆記時抽到穩定事實，就會出現在這裡。</p>') + '</details>' +
            '<details class="nv-card nm-fold" data-f="epi"' + (openSet.epi ? ' open' : '') + ' style="margin-top:8px"><summary style="cursor:pointer;font-weight:700">對話摘要（最近 ' + epi.length + ' 筆）</summary>' + (epi.length ? epi.map(function (r) { return '<div class="nova-em-item" style="align-items:flex-start;gap:8px"><div style="flex:1;min-width:0"><b>' + esc(r.topic || '對話') + '</b><div class="nv-muted" style="word-break:break-word">' + esc(r.summary) + '</div></div><button class="nv-btn nm-del-epi" data-k="' + esc(r.id) + '">刪除</button></div>'; }).join('') : '<p class="nv-muted">還沒有。每 10 則 AI 回覆會自動摘要一次。</p>') + '</details>' +
            (engine() ? (function () {   // v1.6.0：記憶整理與進階（只有主記憶）
                var E = engine(), last = Number(kvGet('nova_mem_maintain_last')) || 0, props = E.proposals(), skipped = sid != null && E.isSkipped(sid);
                return '<div class="nv-card" style="margin-top:8px"><h4>🧩 記憶整理與進階</h4><p class="nv-muted">記憶核心 v' + esc(W.NovaMemoryCore.VERSION) + '。' + (keyOf('gemini') ? '檢索：向量＋關鍵字。' : '檢索：只用關鍵字（沒有 Gemini 金鑰，無法算向量）。') + '上次整理：' + (last ? new Date(last).toLocaleString() : '還沒有') + '。</p>'
                    + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px"><button class="nv-btn" id="nm-maintain">🧹 立即整理</button><button class="nv-btn" id="nm-lint">🩺 健檢</button></div>'
                    + '<label class="nova-em-item" style="margin-top:6px"><input type="checkbox" id="nm-skip" ' + (skipped ? 'checked' : '') + '> <span>目前這段對話不要寫進記憶</span></label>'
                    + '<div id="nm-lint-out" class="nv-muted" style="margin-top:6px;white-space:pre-wrap"></div>'
                    + (props.length ? '<p style="margin-top:8px;font-weight:700">🤖 Bot 的記憶提案（同意後才會寫進長期記憶）</p>' + props.slice(-12).map(function (p) { return '<div class="nova-em-item" style="align-items:flex-start;gap:8px"><div style="flex:1;min-width:0">' + esc(p.text) + ' <span class="nv-muted">（' + esc(p.from || 'Bot') + '）</span></div><button class="nv-btn nm-prop" data-k="' + esc(p.id) + '" data-a="1">同意</button><button class="nv-btn nm-prop" data-k="' + esc(p.id) + '" data-a="0">不要</button></div>'; }).join('') : '')
                    + '</div>';
            })() : '') +
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
        if (engine()) {   // v1.6.0
            var E1 = engine();
            if ($('nm-maintain')) $('nm-maintain').onclick = async function () { if (!E1.hasLlm()) { toast('需要至少一組模型金鑰（Gemini／OpenAI／Grok）'); return; } toast('🧠 記憶整理中…（最多約一分半）'); var r = await maintain({}); toast((r.ok ? '✅ ' : '⚠️ ') + r.note); renderSettings(); };
            if ($('nm-lint')) $('nm-lint').onclick = async function () {
                var o = $('nm-lint-out'); if (o) o.textContent = '健檢中…';
                try { var rep = await E1.lint(), L = [];
                    if (rep.conflicts.length) L.push('⚡ 互相矛盾（' + rep.conflicts.length + '）：' + rep.conflicts.slice(0, 5).map(function (c) { return c.entity; }).join('、'));
                    if (rep.dups.length) L.push('👯 疑似重複（' + rep.dups.length + ' 組，按「立即整理」會請模型確認後合併）：' + rep.dups.slice(0, 5).map(function (d) { return d.a + '↔' + d.b; }).join('、'));
                    if (rep.noVector.length) L.push('🧮 沒有向量（' + rep.noVector.length + ' 筆，按「立即整理」會補算）');
                    if (rep.modelMismatch) L.push('🔁 向量是舊的嵌入模型算的（' + rep.modelMismatch + ' 筆）');
                    if (rep.pending) L.push('⏳ 等待重試的對話：' + rep.pending + ' 段');
                    if (rep.stale.length) L.push('⏰ 很久沒更新也沒用到（' + rep.stale.length + ' 筆）');
                    if (o) o.textContent = L.length ? L.join('\n') : '✅ 沒有發現需要注意的問題（共 ' + rep.total + ' 筆長期事實）';
                } catch (e) { if (o) o.textContent = '健檢失敗：' + (e.message || e); }
            };
            if ($('nm-skip')) $('nm-skip').onchange = function (e) { if (sid == null) { toast('目前沒有對話'); return; } E1.setSkipped(sid, e.target.checked); toast(e.target.checked ? '🙈 這段對話之後的內容不會寫進記憶' : '🧠 這段對話恢復寫進記憶'); };
            Array.prototype.forEach.call(el.querySelectorAll('.nm-pin-core'), function (b) { b.onclick = async function () { await E1.setPinned(b.getAttribute('data-k'), b.getAttribute('data-on') === '1'); renderSettings(); }; });
            Array.prototype.forEach.call(el.querySelectorAll('.nm-prop'), function (b) { b.onclick = async function () { var r = await E1.resolveProposal(b.getAttribute('data-k'), b.getAttribute('data-a') === '1'); if (b.getAttribute('data-a') === '1') toast(r && r.ok ? '✅ 已記住' : '⚠️ 沒有記下'); renderSettings(); }; });
        }
        $('nm-now').onclick = async function () { if (!sid || !acceptSid(sid)) { toast(CFG.priv ? '目前不是私密對話' : '目前沒有對話或目前是私密對話'); return; } if (!gkey() && !(engine() && engine().hasLlm())) { toast('需要 Gemini API Key'); return; } toast('整理中…'); await maybeCompress(sid, true); setTimeout(function () { renderSettings(); }, 4000); };
        $('nm-clear').onclick = async function () { var ok = W.showConfirm ? await W.showConfirm('確定清空全部 AI 記憶（長期事實、對話摘要、實體統計）？此操作無法復原。') : true; if (ok) { await clearAll(); toast('已清空'); renderSettings(); } };
        $('nm-schema-save').onclick = async function () { await writeSchema($('nm-schema').value); toast('✅ 已儲存維護守則'); };
        $('nm-schema-reset').onclick = async function () { await resetSchema(); $('nm-schema').value = DEFAULT_SCHEMA_MD; toast('已還原預設'); };
        Array.prototype.forEach.call(el.querySelectorAll('.nm-del-core'), function (b) { b.onclick = async function () { await del('core', b.getAttribute('data-k')); try { !CFG.priv && W.NovaMemSync && W.NovaMemSync.markCoreDeleted(b.getAttribute('data-k')); } catch (e) {} changed(); renderSettings(); }; });
        Array.prototype.forEach.call(el.querySelectorAll('.nm-del-epi'), function (b) { b.onclick = async function () { await del('episodic', b.getAttribute('data-k')); try { !CFG.priv && W.NovaMemSync && W.NovaMemSync.markEpisodicDeleted(b.getAttribute('data-k')); } catch (e) {} changed(); renderSettings(); }; });
    }

    return { isOn: isOn, setOn: setOn, getProfile: getProfile, setProfile: setProfile, maybeCompress: maybeCompress, compressSession: compressSession, retrieveContext: retrieveContext,
        ingestDocument: ingestDocument, extractFacts: extractFacts, consolidateCore: consolidateCore, updateEntityFreq: updateEntityFreq, stats: stats, exportAll: exportAll, importAll: importAll, clearAll: clearAll,
        renderSettings: renderSettings, readSchema: readSchema, DEFAULT_SCHEMA_MD: DEFAULT_SCHEMA_MD, _open: open, _getAll: getAll, _getOne: getOne, _put: put, _del: del, _cosine: cosine,
        // v1.6.0：記憶核心（私密記憶的 engine() 是 null，下面這些都安全地回傳「沒做」）
        engine: engine, maintain: maintain,
        remember: async function (o) { var E = engine(); return E ? E.remember(o) : { ok: false, error: '記憶核心沒有載入' }; },
        forget: async function (o) { var E = engine(); return E ? E.forget(o) : { ok: false, error: '記憶核心沒有載入' }; },
        setPinned: async function (entity, on) { var E = engine(); return E ? E.setPinned(entity, on) : false; },
        lint: async function () { var E = engine(); return E ? E.lint() : null; },
        isSkipped: function (sid) { var E = engine(); return E ? E.isSkipped(sid) : false; },
        setSkipped: function (sid, on) { var E = engine(); return E ? E.setSkipped(sid, on) : false; },
        propose: function (o) { var E = engine(); return E ? E.propose(o) : { ok: false }; },
        explicitFromUserText: function (t) { var E = engine(); return E ? E.explicitFromUserText(t) : null; } };
    }
    W.NovaMemory = createMemory({ dbName: 'nova_memory_db', profileKey: 'nova_mem_user_profile', modeKey: 'nova_mem_mode', event: 'nova-memory-changed', priv: false });
    // v1.6.0：使用者明講「記住，…」→ 直接寫進主記憶（釘選、不衰減）。回傳要附給模型的一句說明（沒觸發回空字串）。
    //   同一句話 15 秒內只記一次（工具呼叫路徑與一般對話路徑都會呼叫這裡）。私密對話、已關閉記憶、標成「不要記」的對話都不觸發。
    W._novaMemExplicitHook = function (text) {
        try {
            var M = W.NovaMemory;
            if (!M || !M.engine() || !M.isOn() || W.NovaPrivate.isCurrent()) return '';
            var sid = W.appState && appState.currentSessionId;
            if (M.isSkipped(sid)) return '';
            var mx = M.explicitFromUserText(text);
            if (!mx) return '';
            var NOTE = '[系統：使用者這句「記住」的內容已由記憶系統直接寫入長期記憶，簡短確認已經記住即可。]', now = Date.now(), last = W._novaMemExplicitLast;
            if (last && last.t === mx && now - last.at < 15000) return NOTE;
            W._novaMemExplicitLast = { t: mx, at: now };
            M.remember({ text: mx, sessionId: String(sid || '') }).then(function (r) { try { if (r && r.ok) W.showToast && W.showToast(r.duplicate ? '🧠 這件事之前就記住了' : '🧠 已記住（' + r.entity + '）'); else if (r && r.error) W.showToast && W.showToast('🧠 沒有記下：' + r.error); } catch (e) { /* ignore */ } }).catch(function () { /* 記不進去不影響這次回覆 */ });
            return NOTE;
        } catch (e) { return ''; }
    };
    W.NovaMemoryPrivate = createMemory({ dbName: 'nova_memory_private_db', profileKey: 'nova_pmem_user_profile', modeKey: 'nova_pmem_mode', event: 'nova-pmemory-changed', priv: true });
})();

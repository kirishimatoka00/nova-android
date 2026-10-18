/* ═══════════════════════════════════════════════════════════════════════
   nova-skills.js — NOVA Android 技能引擎（跟 index.html 放同一個資料夾 www/）
   版本：v2.1.0
   版本紀錄：
   v2.1.0 - App v2.6.79。replay 新增三種「不用操作畫面」的步驟：web_search（query、nearby）、run_python（code、timeout_sec）、run_shell（cmd、timeout_sec），
            讓純文字模式（v2.6.74）完成的自主任務也能存成技能、之後重播；stepOutline 補上這三種的顯示文字。
   v2.0.0 - 批次 7a。取代 index.html 內舊的「只有腳本 .js」NovaSkills，改成對標桌面版 v3.x 的統一技能格式（資料夾 Documents/NovaSkills/）：
            ① 登記檔 skills.json＋每個技能一個定義檔：script（<name>.js＋.md，舊版相容）／prompt（提示範本，.md）／imported（匯入文件，.md）／
               replay（可重播的手機操作紀錄，<name>.replay.json＋.md）／flow（組裝流程，<name>.flow.json＋.md）。
            ② replay 的步驟型別是手機版自己的：tap_el（用元件文字／描述／id 找，找不到才用相對座標）、tap／long_press／swipe（0～1 相對座標）、
               text、key、open_app、open_url、wait、shell（進階）。參數佔位符：{{名稱}}（原樣）、{{名稱@u}}（網址編碼）。
               半成品（partial）：失敗後挑出做對的步驟＋避坑筆記存成技能，不能直接執行，只在規劃新任務時給 AI 參考。
            ③ API：load／run／get／getManifest／getPromptSkills／getReplaySkills／getPartialSkills／getLastError／getCount／
               saveSkill／deleteSkill／renameSkill／repairIndex／exportAll／importAll；所有「讀 skills.json→改→寫回」用互斥鎖排隊（避免互相蓋掉）。
            ④ saveSkill 同時相容舊呼叫 saveSkill(name, description, parameters, code)（AI 生成腳本技能用）。
            ⑤ 執行 replay 需要 index.html 自主任務引擎提供 novaAutoTask.replay()；執行 flow 會依序呼叫子技能（執行時才查，子技能更新後自動套用最新版）。
   依賴（全域）：Capacitor.Plugins.Filesystem、appState（僅腳本技能的 nova 輔助物件）、novaAutoTask（replay／run）。
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';
    var W = window;
    var NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
    var TYPES = ['script', 'prompt', 'imported', 'replay', 'flow'];
    var STEP_TYPES = ['tap_el', 'tap', 'long_press', 'swipe', 'text', 'key', 'open_app', 'open_url', 'wait', 'shell', 'web_search', 'run_python', 'run_shell'];
    var DIR = 'NovaSkills';

    var registry = {};          // script 技能：name → fn
    var manifest = [];          // 全部技能（含 steps／goal／params 等）
    var lastLoadError = null;
    var lock = Promise.resolve();
    function withLock(fn) { var run = lock.then(fn, fn); lock = run.catch(function () {}); return run; }
    function FS() { return W.Capacitor && W.Capacitor.Plugins && W.Capacitor.Plugins.Filesystem; }
    async function rd(path) { var r = await FS().readFile({ path: DIR + '/' + path, directory: 'DOCUMENTS', encoding: 'utf8' }); return r.data; }
    async function wr(path, data) { await FS().writeFile({ path: DIR + '/' + path, data: data, directory: 'DOCUMENTS', recursive: true, encoding: 'utf8' }); }
    async function rm(path) { try { await FS().deleteFile({ path: DIR + '/' + path, directory: 'DOCUMENTS' }); } catch (e) { /* 檔案不存在就算了 */ } }
    function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }

    // ── .md（frontmatter＋內文） ──
    function parseMd(text) {
        var m = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
        if (!m) return { fm: {}, body: text || '' };
        var fm = {}; m[1].split(/\r?\n/).forEach(function (l) { var i = l.indexOf(':'); if (i > 0) fm[l.slice(0, i).trim()] = l.slice(i + 1).trim(); });
        return { fm: fm, body: m[2] || '' };
    }
    function buildMd(fm, body) {
        var lines = ['---']; Object.keys(fm).forEach(function (k) { if (fm[k] !== undefined && fm[k] !== null && fm[k] !== '') lines.push(k + ': ' + String(fm[k]).replace(/\r?\n/g, ' ')); });
        lines.push('---'); return lines.join('\n') + '\n' + (body || '');
    }
    function outline(steps) {
        return (steps || []).map(function (s, i) { return (i + 1) + '. ' + stepOutline(s); }).join('\n');
    }
    function stepOutline(s) {
        if (!s) return '';
        switch (s.type) {
            case 'tap_el': return '點「' + (s.text || s.desc || s.id || '元件') + '」';
            case 'tap': return '點座標 (' + n3(s.x) + ',' + n3(s.y) + ')';
            case 'long_press': return '長按 (' + n3(s.x) + ',' + n3(s.y) + ')';
            case 'swipe': return '滑動 (' + n3(s.x1) + ',' + n3(s.y1) + ')→(' + n3(s.x2) + ',' + n3(s.y2) + ')';
            case 'text': return '輸入「' + String(s.text || '').slice(0, 40) + '」';
            case 'key': return '按鍵 ' + s.key;
            case 'open_app': return '開啟 App ' + s.package;
            case 'open_url': return '開網址 ' + String(s.url || '').slice(0, 60);
            case 'wait': return '等待 ' + (s.ms || 1000) + 'ms';
            case 'web_search': return '搜尋「' + String(s.query || '').slice(0, 40) + '」' + (s.nearby ? '（附近）' : '');
            case 'run_python': return '執行 Python（' + String(s.code || '').split('\n').length + ' 行）' + String(s.code || '').replace(/\s+/g, ' ').slice(0, 30);
            case 'run_shell': return 'Termux 指令 ' + String(s.cmd || s.command || '').slice(0, 50);
            case 'shell': return 'shell ' + String(s.command || '').slice(0, 50);
            default: return s.type + ' ' + JSON.stringify(s).slice(0, 50);
        }
    }
    function n3(v) { return typeof v === 'number' ? v.toFixed(3) : v; }

    // ── 載入 ──
    async function readIndex() {
        try { var d = JSON.parse(await rd('skills.json')); return Array.isArray(d.skills) ? d.skills : []; }
        catch (e) {
            if (e && /not exist|ENOENT|no such file|does not exist|找不到/i.test(e.message || '')) return [];
            throw e;
        }
    }
    async function writeIndex(list) { await wr('skills.json', JSON.stringify({ skills: list }, null, 2)); }

    async function load() {
        if (!FS()) { lastLoadError = '僅 Android App 支援本地技能'; manifest = []; return []; }
        var idx;
        try { idx = await readIndex(); lastLoadError = null; } catch (e) { lastLoadError = '無法讀取 skills.json: ' + (e.message || e); manifest = []; return []; }
        var out = [], fails = [];
        Object.keys(registry).forEach(function (k) { delete registry[k]; });
        for (var i = 0; i < idx.length; i++) {
            var s = idx[i];
            if (!s || !NAME_RE.test(s.name || '')) { fails.push((s && s.name || '(未命名)') + ': 名稱不合法'); continue; }
            var type = TYPES.indexOf(s.type) >= 0 ? s.type : 'script';
            try {
                var e = { name: s.name, type: type, description: s.description || '', createdAt: s.createdAt || 0 };
                if (type === 'script') {
                    var js = await rd(s.name + '.js');
                    registry[s.name] = new Function('args', 'nova', 'return (async () => { ' + js + ' })();');   // ⚠️ 等同執行任意程式碼，只放信任的技能
                    e.parameters = s.parameters || { type: 'object', properties: {} };
                } else if (type === 'replay') {
                    var r = JSON.parse(await rd(s.name + '.replay.json'));
                    e.goal = r.goal || e.description; e.steps = Array.isArray(r.steps) ? r.steps : [];
                    if (Array.isArray(r.params) && r.params.length) e.params = r.params;
                    if (r.partial) { e.partial = true; e.partialInfo = r.partialInfo || null; }
                    if (r.lastValues) e.lastValues = r.lastValues;
                    e.parameters = paramsSchema(e.params);
                } else if (type === 'flow') {
                    var f = JSON.parse(await rd(s.name + '.flow.json'));
                    e.steps = Array.isArray(f.steps) ? f.steps : []; e.parameters = { type: 'object', properties: {} };
                } else {
                    var md = parseMd(await rd(s.name + '.md'));
                    e.goal = md.body; e.execMode = md.fm.execMode === 'autonomous' ? 'autonomous' : 'general'; e.parameters = { type: 'object', properties: {} };
                }
                out.push(e);
            } catch (err) { fails.push(s.name + ': ' + (err.message || err)); }
        }
        manifest = out;
        if (!out.length && fails.length) lastLoadError = fails.join('；');
        else if (fails.length) console.warn('[NovaSkills] 部分技能載入失敗：', fails.join('；'));
        return out;
    }

    function paramsSchema(params) {
        var props = {}, req = [];
        (params || []).forEach(function (p) { props[p.name] = { type: p.type === 'number' ? 'number' : 'string', description: p.label || p.name }; });
        return { type: 'object', properties: props, required: req };
    }

    // ── 儲存 ──
    async function saveSkill(name, type, meta, body, payload) {
        if (!FS()) throw new Error('僅 Android App 支援本地技能');
        if (typeof type === 'string' && TYPES.indexOf(type) < 0) {   // 舊呼叫：saveSkill(name, description, parameters, code)
            var desc = type, parameters = meta, code = body;
            await saveSkill(name, 'script', { description: desc, parameters: parameters }, '', code);
            return { name: name, description: desc || '', parameters: parameters || { type: 'object', properties: {} } };
        }
        if (!NAME_RE.test(name || '')) throw new Error('技能名稱不合法: ' + name + '（只能英文字母／數字／底線，且不能以數字開頭）');
        meta = meta || {}; var createdAt = meta.createdAt || Date.now();
        var entry = { name: name, type: type, description: meta.description || '', createdAt: createdAt };
        if (type === 'replay') {
            var steps = Array.isArray(payload) ? payload : (payload && payload.steps);
            if (!Array.isArray(steps) || (!steps.length && !meta.partial)) throw new Error('可重播的執行紀錄不可為空（至少要有一個步驟）');
            var bad = steps.find(function (s) { return !s || STEP_TYPES.indexOf(s.type) < 0; });
            if (bad) throw new Error('步驟格式不合法：type 必須是 ' + STEP_TYPES.join('／') + ' 其中之一');
            var rj = { goal: meta.goal || meta.description || name, steps: steps };
            if (Array.isArray(meta.params) && meta.params.length) rj.params = meta.params;
            if (meta.lastValues) rj.lastValues = meta.lastValues;
            if (meta.partial) { rj.partial = true; if (meta.partialInfo) rj.partialInfo = meta.partialInfo; entry.partial = true; }
            await wr(name + '.replay.json', JSON.stringify(rj, null, 2));
            await wr(name + '.md', buildMd({ type: 'replay', description: entry.description, createdAt: createdAt }, body || ('（可重播的手機操作紀錄，共 ' + steps.length + ' 步）\n\n' + outline(steps))));
        } else if (type === 'flow') {
            var items = Array.isArray(payload) ? payload : (payload && payload.steps);
            if (!Array.isArray(items) || !items.length) throw new Error('組裝流程不可為空（至少要有一個項目）');
            var bad2 = items.find(function (s) { return !s || (s.blockKind === 'skill' ? !s.skillName : STEP_TYPES.indexOf(s.type) < 0); });
            if (bad2) throw new Error('項目格式不合法：必須是 {blockKind:"skill", skillName} 或手機操作步驟');
            await wr(name + '.flow.json', JSON.stringify({ description: entry.description || name, steps: items }, null, 2));
            await wr(name + '.md', buildMd({ type: 'flow', description: entry.description, createdAt: createdAt }, body || ('（組裝流程，共 ' + items.length + ' 項）\n\n' + items.map(function (s, i) { return (i + 1) + '. ' + (s.blockKind === 'skill' ? '[技能] ' + s.skillName : stepOutline(s)); }).join('\n'))));
        } else if (type === 'script') {
            if (typeof payload !== 'string' || !payload.trim()) throw new Error('技能程式碼不可為空');
            await wr(name + '.js', payload);
            await wr(name + '.md', buildMd({ type: 'script', description: entry.description, createdAt: createdAt }, body || '（可執行技能，程式碼在對應的 .js 檔中）'));
            entry.parameters = meta.parameters || { type: 'object', properties: {} };
        } else {   // prompt / imported
            if (typeof body !== 'string' || !body.trim()) throw new Error((type === 'imported' ? '匯入的文件內容' : 'prompt 內容') + '不可為空');
            var em = meta.execMode === 'autonomous' ? 'autonomous' : 'general';
            await wr(name + '.md', buildMd({ type: type, description: entry.description, execMode: em, createdAt: createdAt }, body));
            entry.execMode = em;
        }
        await withLock(async function () {
            var idx = []; try { idx = await readIndex(); } catch (e) { /* 沒有就新建 */ }
            var rec = { name: name, type: type, description: entry.description, createdAt: createdAt };
            if (entry.parameters && type === 'script') rec.parameters = entry.parameters;
            if (entry.partial) rec.partial = true;
            var i = idx.findIndex(function (s) { return s.name === name; });
            if (i >= 0) idx[i] = rec; else idx.push(rec);
            await writeIndex(idx);
        });
        await load();
        return entry;
    }

    async function deleteSkill(name) {
        var e = get(name); if (!e) throw new Error('找不到技能: ' + name);
        await withLock(async function () { var idx = await readIndex(); await writeIndex(idx.filter(function (s) { return s.name !== name; })); });
        await rm(name + '.md'); await rm(name + '.js'); await rm(name + '.replay.json'); await rm(name + '.flow.json');
        await load(); return true;
    }

    async function renameSkill(oldName, newName) {
        var e = get(oldName); if (!e) throw new Error('找不到技能: ' + oldName);
        if (!NAME_RE.test(newName || '')) throw new Error('新名稱不合法（英文字母／數字／底線，不能以數字開頭）');
        if (get(newName)) throw new Error('已有同名技能: ' + newName);
        var meta = { description: e.description, createdAt: e.createdAt, goal: e.goal, params: e.params, partial: e.partial, partialInfo: e.partialInfo, execMode: e.execMode, parameters: e.parameters, lastValues: e.lastValues };
        var payload = e.type === 'script' ? await rd(oldName + '.js') : e.steps;
        var body = e.type === 'prompt' || e.type === 'imported' ? e.goal : '';
        await saveSkill(newName, e.type, meta, body, payload);
        await deleteSkill(oldName); return true;
    }

    async function setLastValues(name, values) {   // 記住「上次填的參數值」
        var e = get(name); if (!e || e.type !== 'replay') return;
        var rj = JSON.parse(await rd(name + '.replay.json')); rj.lastValues = values; await wr(name + '.replay.json', JSON.stringify(rj, null, 2)); e.lastValues = values;
    }

    // 掃描資料夾：有 .md 但沒登記的技能補回索引
    async function repairIndex() {
        if (!FS()) return 0;
        var files; try { files = (await FS().readdir({ path: DIR, directory: 'DOCUMENTS' })).files.map(function (f) { return f.name || f; }); } catch (e) { return 0; }
        var added = 0;
        await withLock(async function () {
            var idx = []; try { idx = await readIndex(); } catch (e) { /* ignore */ }
            for (var i = 0; i < files.length; i++) {
                var m = /^([a-zA-Z_][a-zA-Z0-9_]*)\.md$/.exec(files[i]); if (!m || idx.some(function (s) { return s.name === m[1]; })) continue;
                try {
                    var md = parseMd(await rd(files[i])); var t = TYPES.indexOf(md.fm.type) >= 0 ? md.fm.type : 'prompt';
                    idx.push({ name: m[1], type: t, description: md.fm.description || '', createdAt: +md.fm.createdAt || Date.now() }); added++;
                } catch (e) { /* 跳過壞檔 */ }
            }
            if (added) await writeIndex(idx);
        });
        if (added) await load(); return added;
    }

    // 匯出／匯入（單一 JSON，方便備份或在手機之間搬）
    async function exportAll() {
        var out = [];
        for (var i = 0; i < manifest.length; i++) {
            var e = manifest[i], r = { name: e.name, type: e.type, description: e.description, createdAt: e.createdAt };
            if (e.type === 'script') r.code = await rd(e.name + '.js'), r.parameters = e.parameters;
            else if (e.type === 'replay') r.goal = e.goal, r.steps = e.steps, r.params = e.params, r.partial = e.partial, r.partialInfo = e.partialInfo;
            else if (e.type === 'flow') r.steps = e.steps;
            else r.body = e.goal, r.execMode = e.execMode;
            out.push(r);
        }
        return { version: 2, skills: out };
    }
    async function importAll(data, opts) {
        var list = data && Array.isArray(data.skills) ? data.skills : []; var n = 0;
        for (var i = 0; i < list.length; i++) {
            var r = list[i]; if (!r || !NAME_RE.test(r.name || '')) continue;
            if (get(r.name) && !(opts && opts.overwrite)) continue;
            var meta = { description: r.description, createdAt: r.createdAt, goal: r.goal, params: r.params, partial: r.partial, partialInfo: r.partialInfo, execMode: r.execMode, parameters: r.parameters };
            try { await saveSkill(r.name, r.type, meta, r.body || '', r.type === 'script' ? r.code : r.steps); n++; } catch (e) { console.warn('[NovaSkills] 匯入略過 ' + r.name + '：' + e.message); }
        }
        return n;
    }

    // ── 執行 ──
    var helper = {
        showToast: function (m, d) { if (typeof W.showToast === 'function') W.showToast(m, d); },
        getAppState: function () { return W.appState; },
        fetch: function () { return W.fetch.apply(W, arguments); }
    };
    function get(name) { return manifest.find(function (s) { return s.name === name; }); }

    async function run(name, args) {
        var e = get(name); if (!e) throw new Error('未知的技能: ' + name);
        args = args || {};
        if (e.type === 'script') return await registry[name](args, helper);
        if (e.type === 'replay') {
            if (e.partial) throw new Error('「' + name + '」是半成品技能，不能直接執行（只供規劃新任務時參考）');
            if (!W.novaAutoTask || typeof W.novaAutoTask.replay !== 'function') throw new Error('重播引擎尚未就緒');
            return await W.novaAutoTask.replay(e, args.params || args, { silent: !!args.silent });
        }
        if (e.type === 'flow') return await runFlow(e, args);
        // prompt / imported：autonomous → 交給自主任務；general → 回傳 prompt 全文給呼叫端（對話層）使用
        if (e.execMode === 'autonomous' && W.novaAutoTask) { W.novaAutoTask.run(e.goal, { noSkill: true }); return { started: 'autonomous' }; }
        return { prompt: e.goal };
    }

    async function runFlow(e, args) {
        var results = [];
        for (var i = 0; i < e.steps.length; i++) {
            var it = e.steps[i];
            if (it.blockKind === 'skill') {
                var sub = get(it.skillName); if (!sub) throw new Error('流程第 ' + (i + 1) + ' 項：找不到技能「' + it.skillName + '」');
                var r = await run(it.skillName, { params: it.params || args.params || {} });
                if (r && r.ok === false) throw new Error('流程第 ' + (i + 1) + ' 項（' + it.skillName + '）失敗：' + (r.error || '未知'));
                results.push(it.skillName);
            } else {
                var rr = await W.novaAutoTask.replay({ name: e.name + '#' + (i + 1), goal: e.description, steps: [it] }, {}, { silent: true });
                if (rr && rr.ok === false) throw new Error('流程第 ' + (i + 1) + ' 項失敗：' + (rr.error || ''));
                results.push(stepOutline(it));
            }
        }
        return { ok: true, ran: results };
    }

    W.NovaSkills = {
        load: load, run: run, get: get, getManifest: function () { return manifest; },
        getPromptSkills: function () { return manifest.filter(function (s) { return s.type === 'prompt' || s.type === 'imported'; }); },
        getReplaySkills: function () { return manifest.filter(function (s) { return s.type === 'replay' && !s.partial; }); },
        getPartialSkills: function () { return manifest.filter(function (s) { return s.type === 'replay' && s.partial; }); },
        getLastError: function () { return lastLoadError; }, getCount: function () { return manifest.length; },
        saveSkill: saveSkill, deleteSkill: deleteSkill, renameSkill: renameSkill, repairIndex: repairIndex, setLastValues: setLastValues,
        exportAll: exportAll, importAll: importAll, stepOutline: stepOutline, outline: outline,
        STEP_TYPES: STEP_TYPES, NAME_RE: NAME_RE, VERSION: '2.1.0'
    };
})();

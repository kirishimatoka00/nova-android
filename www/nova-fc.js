/* ═══════════════════════════════════════════════════════════
   NOVA FC v1.0.0 — 前端 Function Calling 迴圈＋工具註冊表＋Context Caching
   ------------------------------------------------------------
   給 NOVA Android 用（手機沒有 sidecar，整個迴圈在 WebView 裡跑）。對外只露出 window.NovaFC（Node 下是 module.exports）；
   不碰 DOM、不碰 appState，所有外部依賴（fetch、金鑰、確認視窗）都由呼叫端注入，可用 node 直接測試。

   版本紀錄：
     v1.0.0 (2026-10-11) - 初版（App 2.6.22，批次 3）。
        ① 工具註冊表 createRegistry()：多個「來源」（本地技能、遠端 MCP、內建工具）各自提供工具清單，合併成一份，函式名稱唯一化。
        ② Gemini 迴圈 runGeminiLoop()：送出帶 functionDeclarations 的請求 → 模型回 functionCall → 執行（同一輪多個呼叫並行；
           標記 serial 的工具依序執行）→ 結果以 functionResponse 回填 → 重複，直到純文字或達輪數上限。
           ★ 回填模型輪時保留「整個 candidate.content」（含 thoughtSignature）；桌面版只保留 functionCall 欄位，Gemini 3 系列
           對缺少 thoughtSignature 的函式呼叫輪可能報 400，這裡不丟掉它。
        ③ OpenAI 相容迴圈 runOpenAILoop()：給 Grok（api.x.ai chat/completions，tools／tool_calls／role:'tool'）。
           ★ OpenAI 的 GPT-6 系列目前主程式只送 model＋messages，沒有驗證過帶 tools，所以不在這條路徑。
        ④ Context Caching：迴圈跑到第 N 輪（預設第 3 輪）且「系統提示＋工具宣告＋起始對話」夠長（預設 ≥ 6000 字元），
           建立 Gemini cachedContents（放 systemInstruction＋tools＋起始 contents），之後每輪只送快取名稱＋新增的 functionCall／Response 輪，
           快取部分按快取價計費。保證退回：建立失敗或帶快取的請求被拒 → 當輪改送完整請求並在 10 分鐘內不再對該模型嘗試；
           迴圈結束主動刪除快取（快取有儲存費，TTL 到期也會自己消失）。
        ⑤ 寫入類工具（readOnly !== true 且來源要求確認）呼叫前由 confirm(tool,args) 取得使用者同意；拒絕時把「使用者拒絕」回給模型，不中斷迴圈。
        ★ 誠實限制：只用模擬的 Gemini／xAI／MCP 回應做過單元與整合測試，沒有用真實 API 實測。
   ═══════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var API = { VERSION: '1.0.0' };
  var GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

  function sanitizeName(s, max) { return String(s == null ? '' : s).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, max || 63); }
  API.sanitizeName = sanitizeName;

  // ───────────── schema 轉換 ─────────────
  // MCP／JSON Schema → Gemini 接受的 OpenAPI 子集（每個欄位都要有 type；丟掉 $schema／additionalProperties 等不支援的鍵）
  function schemaToGemini(schema, depth) {
    depth = depth || 0;
    if (!schema || typeof schema !== 'object' || depth > 8) return { type: 'object', properties: {} };
    var s = schema;
    if (!s.type && (s.anyOf || s.oneOf)) {
      var alt = (s.anyOf || s.oneOf).filter(function (x) { return x && x.type !== 'null'; })[0];
      if (alt) s = Object.assign({}, alt, s.description ? { description: s.description } : {});
    }
    var out = {};
    var t = Array.isArray(s.type) ? (s.type.filter(function (x) { return x !== 'null'; })[0] || 'string') : s.type;
    if (t) out.type = t;
    if (s.description) out.description = String(s.description).slice(0, 400);
    if (Array.isArray(s.enum)) out.enum = s.enum.map(String);
    if (s.format && /^(enum|date-time)$/.test(s.format)) out.format = s.format;
    if (s.items) out.items = schemaToGemini(s.items, depth + 1);
    if (s.properties && typeof s.properties === 'object') {
      out.properties = {};
      Object.keys(s.properties).forEach(function (k) { out.properties[k] = schemaToGemini(s.properties[k], depth + 1); });
      if (!out.type) out.type = 'object';
    }
    if (Array.isArray(s.required) && out.properties) {
      var req = s.required.filter(function (k) { return out.properties[k]; });
      if (req.length) out.required = req;
    }
    if (!out.type) out.type = 'string';
    if (out.type === 'array' && !out.items) out.items = { type: 'string' };
    if (out.type === 'object' && !out.properties) out.properties = {};
    return out;
  }
  API.schemaToGemini = schemaToGemini;

  function toGeminiDeclarations(tools) {
    return (tools || []).map(function (t) {
      return {
        name: t.name,
        description: String(t.description || '').replace(/\s+/g, ' ').slice(0, 300),
        parameters: schemaToGemini(t.parameters)
      };
    });
  }
  API.toGeminiDeclarations = toGeminiDeclarations;

  function schemaToOpenAI(schema) {
    if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
    var s = JSON.parse(JSON.stringify(schema));
    delete s.$schema;
    if (!s.type) s.type = 'object';
    if (s.type === 'object' && !s.properties) s.properties = {};
    return s;
  }
  function toOpenAITools(tools) {
    return (tools || []).map(function (t) {
      return { type: 'function', function: { name: t.name, description: String(t.description || '').replace(/\s+/g, ' ').slice(0, 300), parameters: schemaToOpenAI(t.parameters) } };
    });
  }
  API.toOpenAITools = toOpenAITools;

  // ───────────── 工具註冊表 ─────────────
  // 來源：{ id, label, list: async () => [{ name, description, parameters, run(args, ctx), readOnly, needsConfirm, serial }] }
  // 工具函式名稱必須唯一；撞名的後者加 _2、_3 …
  function createRegistry() {
    var sources = [];
    return {
      register: function (src) {
        if (!src || !src.id || typeof src.list !== 'function') throw new Error('來源需要 id 與 list()');
        sources = sources.filter(function (s) { return s.id !== src.id; });
        sources.push(src);
      },
      unregister: function (id) { sources = sources.filter(function (s) { return s.id !== id; }); },
      sources: function () { return sources.slice(); },
      collect: async function (opts) {
        opts = opts || {};
        var only = opts.sources || null;
        var out = [], seen = {};
        for (var i = 0; i < sources.length; i++) {
          var src = sources[i];
          if (only && only.indexOf(src.id) === -1) continue;
          var list = [];
          try { list = (await src.list()) || []; } catch (e) { if (opts.onError) opts.onError(src, e); continue; }
          list.forEach(function (t) {
            if (!t || !t.name || typeof t.run !== 'function') return;
            var name = sanitizeName(t.name), n = name, k = 2;
            while (seen[n]) { n = sanitizeName(name, 60) + '_' + (k++); }
            seen[n] = 1;
            out.push(Object.assign({}, t, { name: n, source: src.id }));
          });
        }
        return out;
      }
    };
  }
  API.createRegistry = createRegistry;

  // ───────────── Context Caching ─────────────
  var cacheBlocked = {};    // model → untilMs
  var cacheRegistry = {};   // key → entry
  function simpleHash(str) { var h = 5381; for (var i = 0; i < str.length; i++) { h = ((h << 5) + h + str.charCodeAt(i)) | 0; } return (h >>> 0).toString(36) + ':' + str.length; }
  API._simpleHash = simpleHash;
  API._cacheReset = function () { cacheBlocked = {}; cacheRegistry = {}; };

  async function cacheCreate(o) {
    // o: { fetchImpl, apiKey, model, systemInstruction(text), tools(declarations), contents, ttlSec, blockMs, onEvent }
    var now = Date.now();
    var emit = function (e) { if (o.onEvent) { try { o.onEvent(e); } catch (x) {} } };
    if (cacheBlocked[o.model] && cacheBlocked[o.model] > now) return null;
    var body = {
      model: 'models/' + o.model,
      contents: o.contents,
      ttl: (o.ttlSec || 720) + 's'
    };
    if (o.systemInstruction) body.systemInstruction = { parts: [{ text: o.systemInstruction }] };
    if (o.tools && o.tools.length) body.tools = [{ functionDeclarations: o.tools }];
    var rk = o.model + '|' + simpleHash(JSON.stringify(body));
    var reg = cacheRegistry[rk];
    if (reg && reg.expireAtMs - 60000 > now) return reg;
    var fail = function (msg) { cacheBlocked[o.model] = now + (o.blockMs || 600000); emit({ type: 'cache_create_failed', reason: String(msg).slice(0, 160) }); return null; };
    try {
      var res = await o.fetchImpl(GEMINI_BASE + '/cachedContents?key=' + encodeURIComponent(o.apiKey), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      var data = await res.json().catch(function () { return null; });
      if (!res.ok || !data || !data.name) return fail((data && data.error && data.error.message) || ('HTTP ' + res.status));
      var entry = { name: data.name, expireAtMs: data.expireTime ? Date.parse(data.expireTime) : now + (o.ttlSec || 720) * 1000, tokens: (data.usageMetadata && +data.usageMetadata.totalTokenCount) || 0, model: o.model, rk: rk };
      cacheRegistry[rk] = entry;
      emit({ type: 'cache_created', name: entry.name, tokens: entry.tokens, model: o.model });
      return entry;
    } catch (e) { return fail((e && e.message) || e); }
  }
  async function cacheDelete(o) {
    try {
      var res = await o.fetchImpl(GEMINI_BASE + '/' + o.name + '?key=' + encodeURIComponent(o.apiKey), { method: 'DELETE' });
      Object.keys(cacheRegistry).forEach(function (k) { if (cacheRegistry[k].name === o.name) delete cacheRegistry[k]; });
      return res.ok || res.status === 404;
    } catch (e) { return false; }
  }
  API.cacheCreate = cacheCreate;
  API.cacheDelete = cacheDelete;

  // ───────────── 共用小工具 ─────────────
  function clip(text, max) {
    text = String(text == null ? '' : text);
    if (text.length <= max) return text;
    return text.slice(0, max) + '\n…（內容過長，已截斷 ' + (text.length - max) + ' 字）';
  }
  function parseJsonSafe(s) { try { return JSON.parse(s); } catch (e) { return {}; } }

  async function execTool(tool, args, opts, log, roundIdx) {
    var t0 = Date.now();
    var emit = function (e) { if (opts.onEvent) { try { opts.onEvent(e); } catch (x) {} } };
    var result;
    try {
      if (tool.needsConfirm && !tool.readOnly && typeof opts.confirm === 'function') {
        var ok = await opts.confirm(tool, args);
        if (!ok) {
          result = { success: false, text: '使用者拒絕了這次工具呼叫（' + tool.name + '）。請改用其他方式，或詢問使用者要不要換個做法。' };
          log.push({ round: roundIdx + 1, tool: tool.name, args: args, result: result, denied: true, ms: Date.now() - t0 });
          return result;
        }
      }
      emit({ type: 'tool_start', name: tool.name, label: tool.label, args: args, round: roundIdx + 1 });
      var r = await tool.run(args || {}, { round: roundIdx + 1 });
      if (r && typeof r === 'object' && 'text' in r) result = { success: r.success !== false, text: String(r.text) };
      else result = { success: true, text: typeof r === 'string' ? r : JSON.stringify(r) };
    } catch (e) {
      result = { success: false, text: '呼叫失敗：' + ((e && e.message) || e) };
    }
    result.text = clip(result.text, opts.maxResultChars || 20000);
    if (tool.screen && result.success) { try { result.text = await tool.screen(result.text); } catch (e) {} }
    log.push({ round: roundIdx + 1, tool: tool.name, args: args, result: result, ms: Date.now() - t0 });
    emit({ type: 'tool_end', name: tool.name, label: tool.label, success: result.success, ms: Date.now() - t0, round: roundIdx + 1 });
    return result;
  }

  // 同一輪的多個呼叫：並行；serial 的工具（例如需要使用者逐一確認的寫入類）串成一條鏈依序執行
  async function execMany(calls, toolMap, opts, log, roundIdx) {
    var results = new Array(calls.length), chain = Promise.resolve();
    var pending = calls.map(function (c, idx) {
      var tool = toolMap[c.name];
      var job = function () {
        if (!tool) { results[idx] = { success: false, text: '沒有這個工具：' + c.name }; return Promise.resolve(); }
        return execTool(tool, c.args, opts, log, roundIdx).then(function (r) { results[idx] = r; });
      };
      if (tool && (tool.serial || (tool.needsConfirm && !tool.readOnly))) { chain = chain.then(job); return chain; }
      return job();
    });
    await Promise.all(pending);
    return results;
  }

  function addUsage(total, m) {
    if (!m) return;
    total.prompt += +m.promptTokenCount || 0;
    total.output += +m.candidatesTokenCount || 0;
    total.cached += +m.cachedContentTokenCount || 0;
  }

  // ───────────── Gemini 迴圈 ─────────────
  // opts: { fetchImpl, apiKey, model, systemInstruction, contents, tools, maxRounds, confirm, onEvent, maxResultChars,
  //         generationConfig, cache:{ enabled, startRound, minChars, ttlSec } }
  // 回傳 { text, rounds, log, usage:{prompt,output,cached}, cacheUsed }
  async function runGeminiLoop(opts) {
    var fetchImpl = opts.fetchImpl;
    if (!fetchImpl) throw new Error('缺少 fetchImpl');
    if (!opts.apiKey) throw new Error('尚未設定 Gemini API Key');
    var tools = opts.tools || [];
    if (!tools.length) throw new Error('目前沒有可用的工具');
    var toolMap = {}; tools.forEach(function (t) { toolMap[t.name] = t; });
    var declarations = toGeminiDeclarations(tools);
    var contents = (opts.contents || []).slice();
    var baseLen = contents.length;           // 起始對話長度（快取只放這一段）
    var maxRounds = opts.maxRounds || 5;
    var cacheCfg = Object.assign({ enabled: true, startRound: 3, minChars: 6000, ttlSec: 720 }, opts.cache || {});
    var emit = function (e) { if (opts.onEvent) { try { opts.onEvent(e); } catch (x) {} } };
    var log = [], usage = { prompt: 0, output: 0, cached: 0 };
    var cacheEntry = null, cacheUsed = false, createdCaches = [];
    var url = GEMINI_BASE + '/models/' + opts.model + ':generateContent?key=' + encodeURIComponent(opts.apiKey);

    try {
      for (var round = 0; round < maxRounds; round++) {
        emit({ type: 'round', round: round + 1 });
        // 第 N 輪起嘗試建立快取
        if (cacheCfg.enabled && !cacheEntry && round + 1 >= cacheCfg.startRound && !/image|imagen/i.test(opts.model)) {
          var prefixChars = (opts.systemInstruction || '').length + JSON.stringify(declarations).length + JSON.stringify(contents.slice(0, baseLen)).length;
          if (prefixChars >= cacheCfg.minChars) {
            cacheEntry = await cacheCreate({ fetchImpl: fetchImpl, apiKey: opts.apiKey, model: opts.model, systemInstruction: opts.systemInstruction, tools: declarations, contents: contents.slice(0, baseLen), ttlSec: cacheCfg.ttlSec, onEvent: emit });
            if (cacheEntry) createdCaches.push(cacheEntry.name);
          }
        }
        var body, usingCache = !!cacheEntry;
        var buildBody = function (withCache) {
          var b = withCache
            ? { cachedContent: cacheEntry.name, contents: contents.slice(baseLen) }
            : { contents: contents, tools: [{ functionDeclarations: declarations }] };
          if (!withCache && opts.systemInstruction) b.systemInstruction = { parts: [{ text: opts.systemInstruction }] };
          if (opts.generationConfig) b.generationConfig = opts.generationConfig;
          return b;
        };
        var res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildBody(usingCache)) });
        if (!res.ok && usingCache) {
          // 帶快取的請求被拒：丟掉快取、10 分鐘內不再對這個模型嘗試，當輪改送完整請求
          var why = ''; try { why = (await res.text()).slice(0, 160); } catch (e) {}
          cacheBlocked[opts.model] = Date.now() + 600000;
          Object.keys(cacheRegistry).forEach(function (k) { if (cacheRegistry[k].name === cacheEntry.name) delete cacheRegistry[k]; });
          emit({ type: 'cache_rejected', reason: why });
          cacheEntry = null; usingCache = false;
          res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildBody(false)) });
        }
        if (!res.ok) {
          var errText = ''; try { var ej = await res.json(); errText = (ej && ej.error && ej.error.message) || JSON.stringify(ej); } catch (e) { errText = 'HTTP ' + res.status; }
          throw new Error('Gemini API 錯誤：' + errText);
        }
        if (usingCache) cacheUsed = true;
        var data = await res.json();
        addUsage(usage, data.usageMetadata);
        var cand = data.candidates && data.candidates[0];
        var parts = (cand && cand.content && cand.content.parts) || [];
        var fcParts = parts.filter(function (p) { return p.functionCall; });
        if (!fcParts.length) {
          var text = parts.filter(function (p) { return !p.thought; }).map(function (p) { return p.text || ''; }).join('');
          if (!text && cand && cand.finishReason && cand.finishReason !== 'STOP') text = '(模型沒有給出文字，結束原因：' + cand.finishReason + ')';
          return { text: text, rounds: round + 1, log: log, usage: usage, cacheUsed: cacheUsed };
        }
        var calls = fcParts.map(function (p) { return { name: p.functionCall.name, args: p.functionCall.args || {} }; });
        var results = await execMany(calls, toolMap, opts, log, round);
        // 保留整個模型輪（含 thoughtSignature），再接 functionResponse
        contents.push({ role: 'model', parts: parts });
        contents.push({
          role: 'user',
          parts: fcParts.map(function (p, idx) {
            var r = results[idx];
            return { functionResponse: { name: p.functionCall.name, response: r.success ? { result: r.text } : { error: r.text } } };
          })
        });
      }
      throw new Error('超過 ' + maxRounds + ' 輪工具呼叫還沒有最終答案，強制停止（避免模型陷入呼叫迴圈）');
    } finally {
      for (var i = 0; i < createdCaches.length; i++) { await cacheDelete({ fetchImpl: fetchImpl, apiKey: opts.apiKey, name: createdCaches[i] }); }
    }
  }
  API.runGeminiLoop = runGeminiLoop;

  // ───────────── OpenAI 相容迴圈（Grok） ─────────────
  // opts: { fetchImpl, apiKey, endpoint, model, messages（含 system／history／user）, tools, maxRounds, confirm, onEvent }
  async function runOpenAILoop(opts) {
    var fetchImpl = opts.fetchImpl;
    if (!fetchImpl) throw new Error('缺少 fetchImpl');
    if (!opts.apiKey) throw new Error('尚未設定 API Key');
    var tools = opts.tools || [];
    if (!tools.length) throw new Error('目前沒有可用的工具');
    var toolMap = {}; tools.forEach(function (t) { toolMap[t.name] = t; });
    var oaTools = toOpenAITools(tools);
    var messages = (opts.messages || []).slice();
    var maxRounds = opts.maxRounds || 5;
    var emit = function (e) { if (opts.onEvent) { try { opts.onEvent(e); } catch (x) {} } };
    var log = [], usage = { prompt: 0, output: 0, cached: 0 };
    for (var round = 0; round < maxRounds; round++) {
      emit({ type: 'round', round: round + 1 });
      var res = await fetchImpl(opts.endpoint || 'https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + opts.apiKey },
        body: JSON.stringify({ model: opts.model, messages: messages, tools: oaTools, tool_choice: 'auto' })
      });
      if (!res.ok) {
        var t = ''; try { t = await res.text(); } catch (e) {}
        throw new Error('API 錯誤 HTTP ' + res.status + '：' + t.slice(0, 300));
      }
      var data = await res.json();
      if (data.usage) { usage.prompt += +data.usage.prompt_tokens || 0; usage.output += +data.usage.completion_tokens || 0; }
      var msg = data.choices && data.choices[0] && data.choices[0].message;
      if (!msg) throw new Error('API 回應沒有 message');
      var tcs = msg.tool_calls || [];
      if (!tcs.length) return { text: msg.content || '', rounds: round + 1, log: log, usage: usage, cacheUsed: false };
      var calls = tcs.map(function (tc) { return { name: tc.function && tc.function.name, args: parseJsonSafe(tc.function && tc.function.arguments) }; });
      var results = await execMany(calls, toolMap, opts, log, round);
      messages.push({ role: 'assistant', content: msg.content || null, tool_calls: tcs });
      tcs.forEach(function (tc, idx) { messages.push({ role: 'tool', tool_call_id: tc.id, content: results[idx].success ? results[idx].text : ('錯誤：' + results[idx].text) }); });
    }
    throw new Error('超過 ' + maxRounds + ' 輪工具呼叫還沒有最終答案，強制停止（避免模型陷入呼叫迴圈）');
  }
  API.runOpenAILoop = runOpenAILoop;

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.NovaFC = API;
})(typeof window !== 'undefined' ? window : this);

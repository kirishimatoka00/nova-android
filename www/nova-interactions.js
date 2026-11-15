/* ═══════════════════════════════════════════════════════════
   nova-interactions.js（Android）— 把 Gemini generateContent 請求自動改走 Interactions API
   目前版本：v1.0.0
   最後更新：2026-11-15

   版本紀錄：
   v1.0.0 - App v2.6.134：移植桌面 nova-interactions.js v1.0.0（desktop-patch v3.130.0）。轉換核心（請求／回應互轉、續寫、退回舊介面、
            連續 3 次 404 改走舊介面 30 分鐘、store:false、思考簽章與工具呼叫 id 配對）逐字相同，用桌面的 interactions.test.cjs 與 ix_fixtures.json 驗證過。
            與桌面版的差異：① 手機沒有 Python 引擎（sidecar），拿掉 /llm/api_mode 同步；手機的 Gemini 呼叫全部由前端直接送出，所以全部都會經過這層。
            ② 設定頁的說明與統計只顯示「這個 App」一行。③ index.html、knowledgebank.html、presentation_generator.html 都在最前面載入本檔。
            手機開了 CapacitorHttp（window.fetch 由原生改寫），本檔包住的是改寫後的 fetch，回應用標準 Response 物件回傳給呼叫端。
            不轉、照舊走 generateContent：要求輸出圖片／語音（生圖、Gemini 語音）、看不懂的工具或內容類型；嵌入（記憶、知識庫）、Imagen、
            自主任務的 Computer Use（本來就用 Interactions）不經過這裡。
            設定 → API 金鑰：Gemini API Key 下方「Gemini API 介面」可切回舊版 generateContent（localStorage nova_gemini_api='legacy'）。
            【誠實限制】在電腦的 Chrome 以假的 Gemini 回應驗證轉換、退回與統計；沒有在真機用真的 API 金鑰測過。
   ═══════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  var VERSION = '1.0.0';
  var MODE_KEY = 'nova_gemini_api';
  var IX_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
  var GC_RE = /^https:\/\/generativelanguage\.googleapis\.com\/(v1beta|v1alpha|v1)\/models\/([^:?\/]+):generateContent(\?.*)?$/;
  var MAX_HOPS = 6;
  var stats = { ix: 0, legacy: 0, skipped: 0, fallback: 0, continued: 0, lastFallback: '', lastSkip: '', byModel: {} };
  var bypass = {};   // model → {n404, until}

  function getMode() { try { return (root.localStorage && root.localStorage.getItem(MODE_KEY)) === 'legacy' ? 'legacy' : 'interactions'; } catch (e) { return 'interactions'; } }

  /* ───────── 轉換：generateContent 請求 → Interactions 請求 ───────── */
  function Skip(reason) { this.skip = true; this.reason = reason; }
  function pick(o) { for (var i = 1; i < arguments.length; i++) { if (o && o[arguments[i]] !== undefined) return o[arguments[i]]; } return undefined; }
  var NO_MINIMAL = /pro|gemini-4-(carbon|hydrogen)/;
  function levelFrom(tc, model) {
    if (!tc) return null;
    var lv = pick(tc, 'thinkingLevel', 'thinking_level');
    if (lv) {
      lv = String(lv).toLowerCase();
      if (['minimal', 'low', 'medium', 'high', 'xhigh'].indexOf(lv) < 0) return null;
    } else {
      var b = pick(tc, 'thinkingBudget', 'thinking_budget');
      if (b === undefined || b === null || +b < 0) return null;
      b = +b;
      lv = b === 0 ? 'minimal' : b <= 1024 ? 'low' : b <= 8192 ? 'medium' : 'high';
    }
    if (lv === 'minimal' && NO_MINIMAL.test(model)) lv = 'low';
    return lv;
  }
  // generateContent 的 Schema（OpenAPI 子集，型別大寫）→ JSON Schema（小寫）
  function convSchema(s) {
    if (Array.isArray(s)) return s.map(convSchema);
    if (!s || typeof s !== 'object') return s;
    var o = {};
    Object.keys(s).forEach(function (k) {
      var v = s[k];
      if (k === 'propertyOrdering' || k === 'property_ordering' || k === 'nullable') return;
      if (k === 'type' && typeof v === 'string') o.type = v.toLowerCase();
      else if (k === 'properties' && v && typeof v === 'object') { o.properties = {}; Object.keys(v).forEach(function (p) { o.properties[p] = convSchema(v[p]); }); }
      else if (k === 'items' || k === 'anyOf' || k === 'any_of') o[k === 'any_of' ? 'anyOf' : k] = convSchema(v);
      else o[k] = v;
    });
    if (s.nullable === true && typeof o.type === 'string') o.type = [o.type, 'null'];
    return o;
  }
  function b64ToText(b64) {
    try {
      if (typeof Buffer !== 'undefined') return Buffer.from(b64, 'base64').toString('utf8');
      var bin = atob(b64), bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder('utf-8').decode(bytes);
    } catch (e) { throw new Skip('文字附件解碼失敗'); }
  }
  var IMG = /^image\/(png|jpeg|webp|heic|heif|gif|bmp|tiff)$/, AUD = /^audio\//, VID = /^video\//, TXT = /^(text\/(plain|markdown|html|x-[\w-]+|xml|javascript|css)|application\/(json|xml|javascript|x-python))/;
  var DOC = /^(application\/pdf|text\/csv|application\/vnd\.|application\/msword)/;
  function mediaItem(mime, data, uri) {
    mime = String(mime || '').toLowerCase();
    if (mime === 'image/jpg') mime = 'image/jpeg';
    var it = null;
    if (IMG.test(mime)) it = { type: 'image', mime_type: mime };
    else if (AUD.test(mime)) it = { type: 'audio', mime_type: mime };
    else if (VID.test(mime)) it = { type: 'video', mime_type: mime };
    else if (DOC.test(mime)) it = { type: 'document', mime_type: mime };
    else if (TXT.test(mime) && data != null) return { type: 'text', text: b64ToText(data) };
    else throw new Skip('不支援的附件類型 ' + (mime || '（未標示）'));
    if (data != null) it.data = data; else it.uri = uri;
    return it;
  }
  function toInteraction(model, gc) {
    gc = gc || {};
    var gcfg = pick(gc, 'generationConfig', 'generation_config') || {};
    var mods = pick(gcfg, 'responseModalities', 'response_modalities');
    if (mods && mods.some(function (m) { return /image|audio/i.test(m); })) throw new Skip('要求輸出圖片／語音');
    if (pick(gcfg, 'speechConfig', 'speech_config')) throw new Skip('語音設定');
    var body = { model: model, store: false };
    // 系統指令
    var si = pick(gc, 'systemInstruction', 'system_instruction');
    if (si) {
      var sit = typeof si === 'string' ? si : (si.parts || []).map(function (p) { return p && p.text ? p.text : ''; }).join('\n');
      if (sit) body.system_instruction = sit;
    }
    // 對話內容 → steps
    var steps = [], idq = {}, turn = 0;
    (gc.contents || []).forEach(function (c) {
      turn++;
      var role = c.role === 'model' ? 'model' : 'user';
      var parts = c.parts || [], userBuf = [], outBuf = [], i = 0;
      function flushUser() { if (userBuf.length) { steps.push({ type: 'user_input', content: userBuf }); userBuf = []; } }
      function flushOut() { if (outBuf.length) { steps.push({ type: 'model_output', content: outBuf }); outBuf = []; } }
      parts.forEach(function (p) {
        i++;
        if (!p || typeof p !== 'object') return;
        var sig = pick(p, 'thoughtSignature', 'thought_signature');
        var fc = pick(p, 'functionCall', 'function_call'), fr = pick(p, 'functionResponse', 'function_response');
        var inl = pick(p, 'inlineData', 'inline_data'), fd = pick(p, 'fileData', 'file_data');
        if (role === 'model') {
          if (p.thought === true) { if (sig) { flushOut(); steps.push({ type: 'thought', signature: sig }); } return; }   // 思考摘要不回送，只留簽章
          if (sig) { flushOut(); steps.push({ type: 'thought', signature: sig }); }
          if (fc) {
            flushOut();
            var id = fc.id || ('call_' + turn + '_' + i);
            (idq[fc.name] = idq[fc.name] || []).push(id);
            steps.push({ type: 'function_call', id: id, name: fc.name, arguments: fc.args || fc.arguments || {} });
          } else if (typeof p.text === 'string') outBuf.push({ type: 'text', text: p.text });
          else if (inl) outBuf.push(mediaItem(pick(inl, 'mimeType', 'mime_type'), inl.data, null));
          else if (pick(p, 'executableCode', 'executable_code')) outBuf.push({ type: 'text', text: '```python\n' + (pick(p, 'executableCode', 'executable_code').code || '') + '\n```' });
          else if (pick(p, 'codeExecutionResult', 'code_execution_result')) outBuf.push({ type: 'text', text: String(pick(p, 'codeExecutionResult', 'code_execution_result').output || '') });
          else throw new Skip('看不懂的模型回應內容');
        } else {
          if (fr) {
            flushUser();
            var q = idq[fr.name] || [];
            var cid = fr.id || q.shift() || ('call_' + turn + '_' + i);
            steps.push({ type: 'function_result', call_id: cid, name: fr.name, result: [{ type: 'text', text: typeof fr.response === 'string' ? fr.response : JSON.stringify(fr.response === undefined ? {} : fr.response) }] });
          } else if (typeof p.text === 'string') userBuf.push({ type: 'text', text: p.text });
          else if (inl) userBuf.push(mediaItem(pick(inl, 'mimeType', 'mime_type'), inl.data, null));
          else if (fd) userBuf.push(mediaItem(pick(fd, 'mimeType', 'mime_type'), null, pick(fd, 'fileUri', 'file_uri')));
          else throw new Skip('看不懂的輸入內容');
        }
      });
      flushUser(); flushOut();
    });
    if (!steps.length) throw new Skip('沒有輸入內容');
    var mres = String(pick(gcfg, 'mediaResolution', 'media_resolution') || '').toLowerCase().replace('media_resolution_', '');
    if (mres === 'low' || mres === 'medium' || mres === 'high') steps.forEach(function (st) { (st.content || []).forEach(function (it) { if ((it.type === 'image' || it.type === 'video') && !it.resolution) it.resolution = mres; }); });
    body.input = steps;
    // 產生設定
    var g = {}, v;
    if ((v = pick(gcfg, 'temperature')) !== undefined) g.temperature = v;
    if ((v = pick(gcfg, 'topP', 'top_p')) !== undefined) g.top_p = v;
    if ((v = pick(gcfg, 'maxOutputTokens', 'max_output_tokens')) !== undefined) g.max_output_tokens = v;
    if ((v = pick(gcfg, 'stopSequences', 'stop_sequences')) !== undefined) g.stop_sequences = v;
    if ((v = pick(gcfg, 'seed')) !== undefined) g.seed = v;
    var tc = pick(gcfg, 'thinkingConfig', 'thinking_config'), lv = levelFrom(tc, model);
    if (lv) g.thinking_level = lv;
    var wantThoughts = !!(tc && pick(tc, 'includeThoughts', 'include_thoughts'));
    if (wantThoughts) g.thinking_summaries = 'auto';
    // 工具
    var tools = [];
    (gc.tools || []).forEach(function (t) {
      Object.keys(t || {}).forEach(function (k) {
        var tv = t[k];
        if (k === 'functionDeclarations' || k === 'function_declarations') (tv || []).forEach(function (fd2) {
          var f = { type: 'function', name: fd2.name };
          if (fd2.description) f.description = fd2.description;
          var ps = pick(fd2, 'parametersJsonSchema', 'parameters_json_schema');
          if (ps) f.parameters = ps; else if (fd2.parameters) f.parameters = convSchema(fd2.parameters);
          tools.push(f);
        });
        else if (k === 'googleSearch' || k === 'google_search' || k === 'googleSearchRetrieval' || k === 'google_search_retrieval') { if (!tools.some(function (x) { return x.type === 'google_search'; })) tools.push({ type: 'google_search' }); }
        else if (k === 'codeExecution' || k === 'code_execution') tools.push({ type: 'code_execution' });
        else if (k === 'urlContext' || k === 'url_context') tools.push({ type: 'url_context' });
        else throw new Skip('不支援的工具 ' + k);
      });
    });
    if (tools.length) body.tools = tools;
    var tcfg = pick(gc, 'toolConfig', 'tool_config'), fcc = tcfg && pick(tcfg, 'functionCallingConfig', 'function_calling_config');
    if (fcc && fcc.mode) {
      var md = String(fcc.mode).toLowerCase(); if (md === 'mode_unspecified') md = 'auto';
      var allow = pick(fcc, 'allowedFunctionNames', 'allowed_function_names');
      g.tool_choice = allow && allow.length ? { allowed_tools: { mode: md, tools: allow } } : md;
    }
    if (Object.keys(g).length) body.generation_config = g;
    // 結構化輸出
    var rmt = pick(gcfg, 'responseMimeType', 'response_mime_type');
    var rjs = pick(gcfg, 'responseJsonSchema', 'response_json_schema'), rs = pick(gcfg, 'responseSchema', 'response_schema');
    if (rmt === 'application/json' || rjs || rs) {
      var rf = { type: 'text', mime_type: 'application/json' };
      if (rjs) rf.schema = rjs; else if (rs) rf.schema = convSchema(rs);
      body.response_format = rf;
    } else if (rmt && rmt !== 'text/plain') throw new Skip('不支援的輸出格式 ' + rmt);
    // 安全設定
    var ss = pick(gc, 'safetySettings', 'safety_settings');
    if (ss && ss.length) body.safety_settings = ss.map(function (x) {
      var cat = String(x.category || x.type || '').toLowerCase().replace(/^harm_category_/, '');
      var th = String(x.threshold || '').toLowerCase().replace(/^harm_block_threshold_/, '');
      if (th === 'block_low_and_above' || th === 'block_medium_and_above' || th === 'block_only_high' || th === 'block_none' || th === 'off') return { type: cat, threshold: th };
      throw new Skip('看不懂的安全設定 ' + x.threshold);
    });
    var cc = pick(gc, 'cachedContent', 'cached_content');
    if (cc) body.cached_content = cc;
    return { body: body, meta: { model: model, thoughts: wantThoughts } };
  }

  /* ───────── 轉換：Interactions 回應 → generateContent 回應 ───────── */
  var OUT_TYPES = { model_output: 1, thought: 1, function_call: 1, code_execution_call: 1, code_execution_result: 1, google_search_call: 1, google_search_result: 1, url_context_call: 1, url_context_result: 1 };
  function outputSteps(resp) {
    var st = resp.steps || [], last = -1;
    for (var i = 0; i < st.length; i++) if (st[i] && (st[i].type === 'user_input' || st[i].type === 'function_result')) last = i;
    return st.slice(last + 1).filter(function (s) { return s && OUT_TYPES[s.type]; });
  }
  function fromInteraction(resps, meta) {
    if (!Array.isArray(resps)) resps = [resps];
    meta = meta || {};
    var parts = [], pendingSig = null, chunks = [], supports = [], queries = [], textLen = 0, last = resps[resps.length - 1] || {};
    var usage = { in: 0, out: 0, th: 0, ca: 0, tot: 0 };
    function push(p) { if (pendingSig) { p.thoughtSignature = pendingSig; pendingSig = null; } parts.push(p); }
    resps.forEach(function (resp, hop) {
      var u = resp.usage || {};
      usage.in += u.total_input_tokens || 0;   // 續寫的每一段都會重新計算輸入，照實加總
      usage.out += u.total_output_tokens || 0; usage.th += u.total_thought_tokens || 0; usage.ca += u.total_cached_tokens || 0; usage.tot += u.total_tokens || 0;
      outputSteps(resp).forEach(function (s) {
        if (s.type === 'thought') {
          if (s.signature) pendingSig = s.signature;
          if (meta.thoughts) (s.summary || []).forEach(function (c) { if (c && c.type === 'text' && c.text) parts.push({ text: c.text, thought: true }); });
        } else if (s.type === 'model_output') {
          (s.content || []).forEach(function (c) {
            if (!c) return;
            if (c.type === 'text') {
              var txt = String(c.text || '');
              // 續寫的段落直接接在上一段文字後面
              if (hop > 0 && parts.length && typeof parts[parts.length - 1].text === 'string' && !parts[parts.length - 1].thought && !pendingSig) parts[parts.length - 1].text += txt;
              else push({ text: txt });
              (c.annotations || []).forEach(function (a) {
                if (a && a.type === 'url_citation' && a.url) {
                  var ci = chunks.length; chunks.push({ web: { uri: a.url, title: a.title || a.url } });
                  supports.push({ segment: { startIndex: textLen + (a.start_index || 0), endIndex: textLen + (a.end_index || 0) }, groundingChunkIndices: [ci] });
                }
              });
              textLen += txt.length;
            } else if (c.data) push({ inlineData: { mimeType: c.mime_type || 'application/octet-stream', data: c.data } });
          });
        } else if (s.type === 'function_call') push({ functionCall: { id: s.id, name: s.name, args: s.arguments || {} } });
        else if (s.type === 'code_execution_call') push({ executableCode: { language: String((s.arguments && s.arguments.language) || 'python').toUpperCase(), code: (s.arguments && s.arguments.code) || '' } });
        else if (s.type === 'code_execution_result') push({ codeExecutionResult: { outcome: s.is_error ? 'OUTCOME_FAILED' : 'OUTCOME_OK', output: typeof s.result === 'string' ? s.result : (s.result || []).map(function (c) { return c && c.text ? c.text : ''; }).join('') } });
        else if (s.type === 'google_search_call') ((s.arguments && s.arguments.queries) || []).forEach(function (q) { queries.push(q); });
      });
    });
    if (pendingSig && parts.length) parts[parts.length - 1].thoughtSignature = parts[parts.length - 1].thoughtSignature || pendingSig;
    else if (pendingSig) parts.push({ text: '', thoughtSignature: pendingSig });
    var st = last.status, finish = 'STOP';
    if (st === 'incomplete' || st === 'budget_exceeded' || st === 'requires_continuation') finish = 'MAX_TOKENS';
    var errStep = null;
    resps.forEach(function (r) { outputSteps(r).forEach(function (s) { if (s.type === 'model_output' && s.error) errStep = s.error; }); });
    if (errStep) finish = /safety|block/i.test(String(errStep.message || '')) ? 'SAFETY' : 'OTHER';
    var cand = { content: { role: 'model', parts: parts }, finishReason: finish, index: 0 };
    if (chunks.length || queries.length) cand.groundingMetadata = { groundingChunks: chunks, groundingSupports: supports, webSearchQueries: queries };
    var out = { candidates: [cand], usageMetadata: { promptTokenCount: usage.in, candidatesTokenCount: usage.out, totalTokenCount: usage.tot || (usage.in + usage.out + usage.th) }, modelVersion: last.model || meta.model, responseId: last.id || '', novaApi: 'interactions' };
    if (usage.th) out.usageMetadata.thoughtsTokenCount = usage.th;
    if (usage.ca) out.usageMetadata.cachedContentTokenCount = usage.ca;
    return out;
  }
  function failedError(resp) {
    var e = (resp.errors && resp.errors[0]) || {};
    return { error: { code: 500, message: 'Interactions 狀態 ' + resp.status + (e.message ? '：' + e.message : ''), status: String(e.code || 'INTERNAL') } };
  }

  /* ───────── 送出：含續寫、退回舊介面 ───────── */
  function keyOf(url, init) {
    var m = /[?&]key=([^&]+)/.exec(url || ''); if (m) return decodeURIComponent(m[1]);
    var h = init && init.headers; if (!h) return '';
    if (typeof h.get === 'function') return h.get('x-goog-api-key') || '';
    return h['x-goog-api-key'] || h['X-Goog-Api-Key'] || '';
  }
  function jsonResponse(obj, status) { return new Response(JSON.stringify(obj), { status: status, headers: { 'Content-Type': 'application/json' } }); }
  function noteModel(model, k) { var b = stats.byModel[model] || (stats.byModel[model] = { ix: 0, fallback: 0, skipped: 0 }); b[k]++; }
  async function viaInteractions(origFetch, url, init, model) {
    var gc = JSON.parse(init.body);
    var t = toInteraction(model, gc);
    var key = keyOf(url, init), resps = [], body = t.body;
    for (var hop = 0; hop < MAX_HOPS; hop++) {
      var res = await origFetch(IX_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body), signal: init.signal });
      var txt = await res.text(), j = null;
      try { j = txt ? JSON.parse(txt) : {}; } catch (e) { j = null; }
      if (!res.ok) return { status: res.status, json: j || { error: { code: res.status, message: txt.slice(0, 300) } }, raw: txt };
      if (!j || !Array.isArray(j.steps)) return { status: 599, json: { error: { message: 'Interactions 回應沒有 steps' } } };
      resps.push(j);
      if (j.status === 'requires_continuation' && j.continuation_token) { stats.continued++; body = Object.assign({}, t.body, { continuation_token: j.continuation_token }); continue; }
      if (j.status === 'failed' || j.status === 'cancelled') return { status: 500, json: failedError(j), final: true };
      break;
    }
    return { status: 200, json: fromInteraction(resps, t.meta) };
  }
  function install() {
    if (root.__novaIxInstalled || typeof root.fetch !== 'function') return;
    root.__novaIxInstalled = true;
    var origFetch = root.fetch.bind(root);
    root.fetch = async function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var m = GC_RE.exec(url);
      if (!m || getMode() !== 'interactions' || !init || String(init.method || 'GET').toUpperCase() !== 'POST' || typeof init.body !== 'string') return origFetch(input, init);
      var model = decodeURIComponent(m[2]).replace(/^models\//, '');
      if (root.novaMapRetiredModel) { try { model = root.novaMapRetiredModel(model); } catch (e) { /* */ } }
      var bp = bypass[model];
      if (bp && bp.until > Date.now()) { stats.legacy++; return origFetch(input, init); }
      var r;
      try { r = await viaInteractions(origFetch, url, init, model); }
      catch (e) {
        if (e && e.skip) { stats.skipped++; stats.lastSkip = model + '：' + e.reason; noteModel(model, 'skipped'); return origFetch(input, init); }
        if (e && e.name === 'AbortError') throw e;
        r = { status: 599, json: { error: { message: String((e && e.message) || e) } } };
      }
      if (r.status === 200 || r.final) { stats.ix++; noteModel(model, 'ix'); if (bypass[model]) bypass[model].n404 = 0; return jsonResponse(r.json, r.status); }
      if ([400, 404, 405, 501, 599].indexOf(r.status) >= 0) {
        stats.fallback++; noteModel(model, 'fallback');
        stats.lastFallback = model + '：HTTP ' + r.status + ' ' + String((r.json && r.json.error && r.json.error.message) || '').slice(0, 160);
        if (r.status === 404) { var b = bypass[model] || (bypass[model] = { n404: 0, until: 0 }); if (++b.n404 >= 3) { b.until = Date.now() + 30 * 60 * 1000; b.n404 = 0; } }
        return origFetch(input, init);
      }
      stats.ix++; noteModel(model, 'ix');
      return jsonResponse(r.json, r.status);   // 401／403／429／5xx：照原格式回給呼叫端
    };
  }

  /* ───────── 設定頁與 sidecar 同步 ───────── */
  // 手機沒有 Python 引擎（sidecar），桌面版的 /llm/api_mode 同步拿掉
  function setMode(mode) {
    mode = mode === 'legacy' ? 'legacy' : 'interactions';
    try { root.localStorage.setItem(MODE_KEY, mode); } catch (e) { /* */ }
    renderUI();
    return mode;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  async function renderUI() {
    var box = root.document && root.document.getElementById('nova-ix-box'); if (!box) return;
    var mode = getMode();
    var line = function (label, s) { return label + '：走 Interactions ' + (s.ix || 0) + ' 次、退回舊介面 ' + (s.fallback || 0) + ' 次、不需轉換（圖片／語音等）' + (s.skipped || 0) + ' 次' + (s.continued ? '、自動續寫 ' + s.continued + ' 段' : ''); };
    box.innerHTML = '<div class="flex items-center gap-2 text-xs text-slate-300">Gemini API 介面 '
      + '<select id="nova-ix-mode" class="flex-1 min-w-0 bg-slate-950 border border-slate-700 rounded-lg p-1.5 text-xs outline-none">'
      + '<option value="interactions"' + (mode === 'interactions' ? ' selected' : '') + '>Interactions API（新，預設）</option>'
      + '<option value="legacy"' + (mode === 'legacy' ? ' selected' : '') + '>generateContent（舊版）</option></select></div>'
      + '<p class="text-[11px] text-slate-500 leading-relaxed mt-1">Google 把 generateContent 標成舊版、建議改用 Interactions API。NOVA 會在送出前自動轉換格式，失敗時自動退回舊介面重送一次，平常感覺不到差別。'
      + '不保存對話在 Google（store:false）。要求輸出圖片或語音的呼叫照舊走 generateContent；嵌入（記憶、知識庫）、Imagen、即時語音不受影響。</p>'
      + '<pre class="text-[11px] text-slate-500 whitespace-pre-wrap bg-slate-950 border border-slate-800 rounded-lg p-2 mt-1">'
      + esc(line('這個 App（開啟以來）', stats)) + (stats.lastFallback ? '\n最近一次退回：' + esc(stats.lastFallback) : '') + (stats.lastSkip ? '\n最近一次不轉換：' + esc(stats.lastSkip) : '')
      + '</pre>';
    var sel = root.document.getElementById('nova-ix-mode');
    if (sel) sel.onchange = function () { setMode(sel.value); };
  }

  install();
  if (root.document) {
    var boot = function () { renderUI(); };
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', boot); else setTimeout(boot, 0);
  }
  var api = { VERSION: VERSION, getMode: getMode, setMode: setMode, stats: stats, renderUI: renderUI, toInteraction: toInteraction, fromInteraction: fromInteraction, convSchema: convSchema, Skip: Skip };
  root.NovaIX = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

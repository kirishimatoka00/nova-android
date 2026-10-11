/* ═══════════════════════════════════════════════════════════
   NOVA MCP Remote v1.0.0 — 遠端 MCP（Model Context Protocol）客戶端
   ------------------------------------------------------------
   給 NOVA Android 用：手機上沒有 sidecar、也不能開子行程，所以只支援「遠端」MCP 伺服器（HTTP）。
   對外只露出 window.NovaMcpRemote（Node 下是 module.exports）；不碰 DOM、不碰 appState，可用 node 直接測試。

   版本紀錄：
     v1.0.0 (2026-10-11) - 初版（App 2.6.22，批次 3）。
        ① Streamable HTTP（MCP 2025-03-26／2025-06-18）：每則 JSON-RPC 以 POST 送到同一個網址，
           Accept: application/json, text/event-stream；回應可能是 application/json 或 text/event-stream（一個 POST 一串 SSE），
           兩種都會解析；initialize 之後保存 Mcp-Session-Id 並帶在後續請求；收到 404（session 過期）自動重新 initialize 一次；
           關閉時盡力送 DELETE 結束 session。
        ② 舊版 HTTP+SSE（2024-11-05）退路：Streamable HTTP 的 initialize 被拒（404／405／400）時，改 GET 網址開 SSE 串流，
           等 endpoint 事件取得 POST 位址，之後的回應從串流事件回來。
           ★ 誠實限制：這條路需要「真的可以串流讀取的 fetch」。NOVA Android 開了 CapacitorHttp，fetch 會被換成原生請求，
           原生請求通常是整包回應、不能邊收邊讀，所以舊版 SSE 在 App 內可能連不上，遇到會明確報錯「請改用 Streamable HTTP 網址」。
        ③ tools/list（含分頁 cursor）、tools/call（結果的 text／resource 轉成文字；image 只留 [圖片 mime] 註記，不把 base64 塞進模型）。
        ④ 只用 fetch；可由呼叫端注入 fetchImpl（測試或換成原生 HTTP）。逾時預設 30 秒。
   ═══════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var API = { VERSION: '1.0.0' };
  var PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

  function sanitizeName(s, max) {
    return String(s == null ? '' : s).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, max || 63);
  }
  API.sanitizeName = sanitizeName;

  // 解析一段 SSE 文字 → [{event, data}]（data 多行會用 \n 接起來）
  function parseSse(text) {
    var out = [];
    var blocks = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split(/\n\n+/);
    blocks.forEach(function (b) {
      if (!b.trim()) return;
      var ev = 'message', data = [];
      b.split('\n').forEach(function (line) {
        if (!line || line.charAt(0) === ':') return;
        var i = line.indexOf(':');
        var f = i === -1 ? line : line.slice(0, i);
        var v = i === -1 ? '' : line.slice(i + 1).replace(/^ /, '');
        if (f === 'event') ev = v; else if (f === 'data') data.push(v);
      });
      if (data.length) out.push({ event: ev, data: data.join('\n') });
    });
    return out;
  }
  API.parseSse = parseSse;

  // tools/call 的 result → { success, text }
  function resultToText(result) {
    if (!result) return { success: false, text: '(沒有結果)' };
    var parts = [];
    (result.content || []).forEach(function (c) {
      if (!c) return;
      if (c.type === 'text') parts.push(String(c.text == null ? '' : c.text));
      else if (c.type === 'image') parts.push('[圖片 ' + (c.mimeType || '') + '（內容未附上）]');
      else if (c.type === 'audio') parts.push('[音訊 ' + (c.mimeType || '') + '（內容未附上）]');
      else if (c.type === 'resource' && c.resource) parts.push(c.resource.text != null ? String(c.resource.text) : '[資源 ' + (c.resource.uri || '') + ']');
      else if (c.type === 'resource_link') parts.push('[資源連結 ' + (c.uri || '') + ']');
      else parts.push(JSON.stringify(c));
    });
    if (!parts.length && result.structuredContent) parts.push(JSON.stringify(result.structuredContent));
    return { success: !result.isError, text: parts.join('\n') || (result.isError ? '(工具回報錯誤，沒有訊息)' : '(沒有輸出)') };
  }
  API.resultToText = resultToText;

  function Client(cfg) {
    cfg = cfg || {};
    this.url = String(cfg.url || '').trim();
    this.headers = cfg.headers || {};
    this.fetchImpl = cfg.fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(root) : null);
    this.timeoutMs = cfg.timeoutMs || 30000;
    this.name = cfg.name || 'mcp';
    this.sessionId = null;
    this.protocolVersion = PROTOCOL_VERSIONS[0];
    this.transport = null;     // 'streamable' | 'legacy-sse'
    this.serverInfo = null;
    this.capabilities = null;
    this._id = 0;
    this._legacy = null;
    this.connected = false;
  }

  Client.prototype._hdrs = function (extra) {
    var h = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
    if (this.transport === 'streamable' || this.transport === null) {
      if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
      if (this.sessionId || this.transport === 'streamable') h['MCP-Protocol-Version'] = this.protocolVersion;
    }
    var self = this;
    Object.keys(this.headers).forEach(function (k) { h[k] = self.headers[k]; });
    if (extra) Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
    return h;
  };

  Client.prototype._fetch = async function (url, init) {
    if (!this.fetchImpl) throw new Error('這個環境沒有 fetch');
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var tid = ctl ? setTimeout(function () { ctl.abort(); }, this.timeoutMs) : null;
    try {
      if (ctl) init.signal = ctl.signal;
      return await this.fetchImpl(url, init);
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('連線逾時（' + Math.round(this.timeoutMs / 1000) + ' 秒）：' + url);
      throw e;
    } finally { if (tid) clearTimeout(tid); }
  };

  function getHeader(res, name) {
    try { return res.headers && res.headers.get ? res.headers.get(name) : null; } catch (e) { return null; }
  }

  // ── Streamable HTTP ──
  Client.prototype._postStreamable = async function (msg, expectId, retried) {
    var res = await this._fetch(this.url, { method: 'POST', headers: this._hdrs(), body: JSON.stringify(msg) });
    var sid = getHeader(res, 'mcp-session-id');
    if (sid) this.sessionId = sid;
    if (res.status === 404 && this.sessionId && !retried && msg.method !== 'initialize') {
      // session 過期：重新 initialize 後重送一次
      this.sessionId = null; this.connected = false;
      await this._initializeStreamable();
      return this._postStreamable(msg, expectId, true);
    }
    if (res.status === 202 || res.status === 204) return null;
    if (!res.ok) {
      var t = ''; try { t = await res.text(); } catch (e) {}
      var err = new Error('MCP HTTP ' + res.status + (t ? '：' + t.slice(0, 200) : ''));
      err.status = res.status;
      throw err;
    }
    if (expectId == null) { try { await res.text(); } catch (e) {} return null; }
    var ctype = String(getHeader(res, 'content-type') || '').toLowerCase();
    var text = await res.text();
    var msgs = [];
    if (ctype.indexOf('text/event-stream') !== -1) {
      parseSse(text).forEach(function (e) { try { msgs.push(JSON.parse(e.data)); } catch (x) {} });
    } else {
      try { var j = JSON.parse(text); msgs = Array.isArray(j) ? j : [j]; } catch (e2) {
        // 有些伺服器沒標 content-type，但內容其實是 SSE
        parseSse(text).forEach(function (e) { try { msgs.push(JSON.parse(e.data)); } catch (x) {} });
        if (!msgs.length) throw new Error('MCP 回應不是 JSON：' + text.slice(0, 120));
      }
    }
    for (var i = 0; i < msgs.length; i++) {
      if (msgs[i] && msgs[i].id === expectId) return msgs[i];
    }
    throw new Error('MCP 回應裡找不到對應 id=' + expectId + ' 的結果');
  };

  Client.prototype._initParams = function () {
    return { protocolVersion: this.protocolVersion, capabilities: {}, clientInfo: { name: 'nova-android', version: API.VERSION } };
  };

  Client.prototype._initializeStreamable = async function () {
    this.transport = 'streamable';
    var id = ++this._id;
    var r = await this._postStreamable({ jsonrpc: '2.0', id: id, method: 'initialize', params: this._initParams() }, id, true);
    if (r.error) throw new Error('initialize 失敗：' + (r.error.message || JSON.stringify(r.error)));
    var res = r.result || {};
    if (res.protocolVersion) this.protocolVersion = res.protocolVersion;
    this.serverInfo = res.serverInfo || null;
    this.capabilities = res.capabilities || null;
    await this._postStreamable({ jsonrpc: '2.0', method: 'notifications/initialized' }, null, true);
    this.connected = true;
  };

  // ── 舊版 HTTP+SSE ──
  Client.prototype._initializeLegacy = async function () {
    var self = this;
    this.transport = 'legacy-sse';
    var res = await this._fetch(this.url, { method: 'GET', headers: Object.assign({ 'Accept': 'text/event-stream' }, this.headers) });
    if (!res.ok) throw new Error('舊版 SSE 連線失敗 HTTP ' + res.status);
    if (!res.body || !res.body.getReader) throw new Error('這個環境的 fetch 不能串流讀取 SSE（CapacitorHttp 會整包回應），請改用 Streamable HTTP 網址');
    var L = { pending: {}, postUrl: null, reader: res.body.getReader(), closed: false };
    this._legacy = L;
    var endpointResolve, endpointReject;
    var endpointP = new Promise(function (rs, rj) { endpointResolve = rs; endpointReject = rj; });
    (async function pump() {
      var dec = new TextDecoder(), buf = '';
      try {
        while (true) {
          var chunk = await L.reader.read();
          if (chunk.done) break;
          buf += dec.decode(chunk.value, { stream: true });
          var cut;
          while ((cut = buf.search(/\r?\n\r?\n/)) !== -1) {
            var block = buf.slice(0, cut); buf = buf.slice(cut).replace(/^\r?\n\r?\n/, '');
            parseSse(block).forEach(function (e) {
              if (e.event === 'endpoint') { try { L.postUrl = new URL(e.data.trim(), self.url).href; endpointResolve(); } catch (x) { endpointReject(x); } }
              else { try { var m = JSON.parse(e.data); if (m && m.id != null && L.pending[m.id]) { L.pending[m.id](m); delete L.pending[m.id]; } } catch (x) {} }
            });
          }
        }
      } catch (e) { endpointReject(e); }
      L.closed = true;
      endpointReject(new Error('SSE 串流已中斷'));
      Object.keys(L.pending).forEach(function (k) { L.pending[k]({ error: { message: 'SSE 串流已中斷' } }); });
    })();
    await Promise.race([endpointP, new Promise(function (_, rj) { setTimeout(function () { rj(new Error('等不到 SSE endpoint 事件')); }, self.timeoutMs); })]);
    var id = ++this._id;
    var r = await this._requestLegacy({ jsonrpc: '2.0', id: id, method: 'initialize', params: this._initParams() }, id);
    if (r.error) throw new Error('initialize 失敗：' + (r.error.message || JSON.stringify(r.error)));
    this.serverInfo = (r.result && r.result.serverInfo) || null;
    this.capabilities = (r.result && r.result.capabilities) || null;
    await this._fetch(L.postUrl, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, this.headers), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    this.connected = true;
  };

  Client.prototype._requestLegacy = async function (msg, id) {
    var L = this._legacy, self = this;
    var waiter = new Promise(function (rs, rj) {
      L.pending[id] = rs;
      setTimeout(function () { if (L.pending[id]) { delete L.pending[id]; rj(new Error('等不到回應（' + msg.method + '）')); } }, self.timeoutMs);
    });
    var res = await this._fetch(L.postUrl, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, this.headers), body: JSON.stringify(msg) });
    if (!res.ok && res.status !== 202) { delete L.pending[id]; throw new Error('MCP HTTP ' + res.status); }
    return waiter;
  };

  // ── 對外 ──
  Client.prototype.connect = async function () {
    if (!this.url) throw new Error('沒有填 MCP 網址');
    if (this.connected) return this;
    try {
      await this._initializeStreamable();
    } catch (e) {
      var st = e && e.status;
      if (st === 404 || st === 405 || st === 400 || st === 415) {
        this.sessionId = null; this.transport = null;
        try { await this._initializeLegacy(); }
        catch (e2) { throw new Error('Streamable HTTP 失敗（' + (e.message || e) + '），舊版 SSE 也失敗（' + (e2.message || e2) + '）'); }
      } else throw e;
    }
    return this;
  };

  Client.prototype.request = async function (method, params) {
    if (!this.connected) await this.connect();
    var id = ++this._id;
    var msg = { jsonrpc: '2.0', id: id, method: method };
    if (params !== undefined) msg.params = params;
    var r = this.transport === 'legacy-sse' ? await this._requestLegacy(msg, id) : await this._postStreamable(msg, id);
    if (r.error) throw new Error(method + ' 失敗：' + (r.error.message || JSON.stringify(r.error)));
    return r.result;
  };

  Client.prototype.listTools = async function () {
    var tools = [], cursor, guard = 0;
    do {
      var r = await this.request('tools/list', cursor ? { cursor: cursor } : {});
      (r.tools || []).forEach(function (t) { tools.push(t); });
      cursor = r.nextCursor; guard++;
    } while (cursor && guard < 20);
    return tools;
  };

  Client.prototype.callTool = async function (name, args) {
    var r = await this.request('tools/call', { name: name, arguments: args || {} });
    return resultToText(r);
  };

  Client.prototype.close = async function () {
    try {
      if (this.transport === 'streamable' && this.sessionId) {
        await this._fetch(this.url, { method: 'DELETE', headers: this._hdrs() }).catch(function () {});
      }
      if (this._legacy && this._legacy.reader) { try { this._legacy.reader.cancel(); } catch (e) {} }
    } catch (e) {}
    this.connected = false; this.sessionId = null; this._legacy = null;
  };

  API.createClient = function (cfg) { return new Client(cfg); };
  API.Client = Client;

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.NovaMcpRemote = API;
})(typeof window !== 'undefined' ? window : this);

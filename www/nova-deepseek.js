/*
  ════════════════════════════════════════════════════════════════
  nova-deepseek.js — NOVA Android：DeepSeek 進階能力（聯網搜尋、讀網頁、OCR、文件解析、語音識別 ASR）
  ════════════════════════════════════════════════════════════════
  目前版本：v1.0.0（Android）
  最後更新：2026-11-17（App v2.6.147）
  對標桌面 nova-deepseek.js v1.0.0（nova-desktop/src，2026-11-16）；函式介面相同，差異只在傳輸與設定介面。

  版本紀錄（只記這個檔案自己的變更）：
  v1.0.0 - App v2.6.147 新增（使用者要求：參考 nova-desktop 的更新，把五項 DeepSeek 功能都接進 nova-android）。搭配 nova-app-main.js v1.5.6。
           ①② 聯網搜尋＋讀網頁：對話時宣告 DeepSeek 內建工具 deepseek_web_search／deepseek_read_url（伺服器端執行）；
              message.annotations（url_citation）與 message.server_tool_calls 轉成 NOVA 的來源清單。工具宣告格式官方沒寫死，
              所以依序試：目前模型＋{type}、目前模型＋{type,name}、（V4 Pro 時）改 V4.1 Flash 再試兩種；4xx 才換下一種，
              成功的組合記在 localStorage nova_ds_web_variant；全部失敗就不帶工具照常回答並註明。
           ③ OCR（POST /v1/tools/ocr）：PDF、DOC/DOCX、PPT/PPTX、圖片 → 逐頁文字；同一個檔案這次開啟期間只辨識一次。
           ④ 文件解析（POST /files 上傳＋Anthropic 格式 /anthropic/v1/messages 的 document 區塊，固定 deepseek-flash）：EPUB、MOBI、XLS／XLSX 等。
           ⑤ 語音識別（POST /v1/tools/asr）：音訊重新取樣成 16kHz 單聲道 16 位元 WAV，每 110 秒切一段送出再接起來。
           【和桌面版不同的地方】
           ・手機沒有 sidecar：一律直連 api.deepseek.com（App 內 fetch 由 CapacitorHttp 走原生請求，沒有瀏覽器 CORS 問題）。
           ・上傳不用 FormData：自己組 multipart/form-data 的位元組（Uint8Array）並自訂 boundary 送出——CapacitorHttp 對 FormData 的轉換
             依版本而異，自己組的內容在瀏覽器與 App 內完全一樣。單檔上限 30MB（位元組要轉 base64 過橋接，太大會吃光記憶體）。
           ・逾時用 Promise.race（原生請求不吃 AbortController）。
           ・設定卡片由本檔自己加在 設定 → DeepSeek API Key 下方（#nova-ds-adv）：聯網搜尋＋讀網頁（nova_ds_web，預設開）、
             附檔用 DeepSeek OCR／文件解析（nova_ds_docs，預設開）、錄音逐字稿引擎（nova_transcribe_engine：gemini｜deepseek，預設 gemini）。
             三個鍵都是 nova_ 開頭，已包含在完整備份／本地快照／還原裡。
           【誠實限制】沒有用真的 DeepSeek 金鑰實測（桌面版同）；只用模擬的 API 回應在瀏覽器驗證過請求內容與流程。App 內的 multipart 上傳未在真機驗證。
  ════════════════════════════════════════════════════════════════
*/
(function () {
    'use strict';
    if (window.NovaDeepSeek) return;

    var API = 'https://api.deepseek.com';
    var ls = function (k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } };
    function key() {
        try { return (appState && appState.keys && appState.keys.deepseek) || localStorage.getItem('nova_key_deepseek') || ''; } catch (e) { return ''; }
    }
    function webOn() { return ls('nova_ds_web', '1') !== '0'; }
    function docsOn() { return ls('nova_ds_docs', '1') !== '0'; }
    function transcribeEngine() { return ls('nova_transcribe_engine', 'gemini') === 'deepseek' ? 'deepseek' : 'gemini'; }

    // 手機沒有 sidecar：直連。原生請求不吃 AbortController，所以另外用 Promise.race 逾時
    function call(path, init, ms) {
        ms = ms || 180000;
        var ctl = null, t = null;
        try { ctl = new AbortController(); init = Object.assign({}, init, { signal: ctl.signal }); } catch (e) { /* */ }
        var timeout = new Promise(function (_, rej) { t = setTimeout(function () { try { if (ctl) ctl.abort(); } catch (e) { /* */ } rej(new Error('DeepSeek 逾時（' + Math.round(ms / 1000) + ' 秒）')); }, ms); });
        return Promise.race([fetch(API + path, init), timeout]).finally(function () { clearTimeout(t); });
    }
    async function readJson(res, label) {
        var txt = await res.text(), data;
        try { data = JSON.parse(txt); } catch (e) { throw new Error((label || 'DeepSeek') + ' 回應異常：' + txt.slice(0, 120)); }
        if (!res.ok || (data && data.error && !data.choices && !data.pages && !data.text && !data.id)) {
            var m = (data && data.error && (data.error.message || data.error)) || ('HTTP ' + res.status);
            var err = new Error((label || 'DeepSeek') + ' 錯誤：' + (typeof m === 'string' ? m : JSON.stringify(m)).slice(0, 300));
            err.status = res.status;
            throw err;
        }
        return data;
    }
    function authHeaders(extra) { return Object.assign({ 'Authorization': 'Bearer ' + key() }, extra || {}); }

    var MAX_UPLOAD = 30 * 1024 * 1024;
    function dataUrlToBytes(d) {
        var s = String(d || ''), i = s.indexOf(',');
        var bin = atob(i >= 0 ? s.slice(i + 1) : s), u = new Uint8Array(bin.length);
        for (var k = 0; k < bin.length; k++) u[k] = bin.charCodeAt(k);
        return u;
    }
    function mimeOf(f) { var m = /^data:([^;,]+)/.exec(String(f && f.data || '')); return (f && f.mime) || (m && m[1]) || 'application/octet-stream'; }
    // 自己組 multipart/form-data：parts = [{name, value}] 或 [{name, bytes, filename, type}]，依陣列順序輸出
    function multipart(parts) {
        var bd = '----NovaDS' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
        var enc = new TextEncoder(), chunks = [], total = 0;
        var add = function (u) { chunks.push(u); total += u.length; };
        parts.forEach(function (p) {
            if (p.bytes) {
                var fn = String(p.filename || 'file').replace(/["\r\n]/g, '_');
                add(enc.encode('--' + bd + '\r\nContent-Disposition: form-data; name="' + p.name + '"; filename="' + fn + '"\r\nContent-Type: ' + (p.type || 'application/octet-stream') + '\r\n\r\n'));
                add(p.bytes); add(enc.encode('\r\n'));
            } else add(enc.encode('--' + bd + '\r\nContent-Disposition: form-data; name="' + p.name + '"\r\n\r\n' + String(p.value) + '\r\n'));
        });
        add(enc.encode('--' + bd + '--\r\n'));
        var out = new Uint8Array(total), o = 0;
        chunks.forEach(function (c) { out.set(c, o); o += c.length; });
        return { body: out, contentType: 'multipart/form-data; boundary=' + bd };
    }
    function fileBytes(f) {
        var u = dataUrlToBytes(f.data);
        if (u.length > MAX_UPLOAD) throw new Error('檔案「' + (f.name || '') + '」超過 30MB，手機上無法送給 DeepSeek');
        return u;
    }
    function fingerprint(f) {
        var s = String(f.data || '');
        var h = 0; for (var i = 0; i < Math.min(s.length, 4096); i++) h = (h * 31 + s.charCodeAt(i)) | 0;
        return (f.name || '') + '|' + s.length + '|' + h;
    }

    // ── 檔案類型判斷 ──
    var OCR_EXT = /\.(pdf|docx?|pptx?|png|jpe?g|webp|gif|bmp|tiff?)$/i;
    var OCR_MIME = /pdf|msword|wordprocessingml|powerpoint|presentationml|^image\//i;
    var PARSE_EXT = /\.(xlsx?|epub|mobi)$/i;
    function kindOf(f) {
        var n = String(f && f.name || ''), m = String(f && f.mime || '');
        if (OCR_EXT.test(n) || OCR_MIME.test(m) || (f && f.category === 'image')) return 'ocr';
        if (PARSE_EXT.test(n) || /spreadsheet|ms-excel|epub|mobipocket/i.test(m)) return 'parse';
        return '';
    }

    // ── ② OCR ──
    var _ocrCache = {};
    async function ocr(f, purpose) {
        var fp = fingerprint(f) + '|' + (purpose || 'text_recognition');
        if (_ocrCache[fp]) return _ocrCache[fp];
        var mp = multipart([{ name: 'purpose', value: purpose || 'text_recognition' },   // 官方：purpose 要在 file 前面
            { name: 'file', bytes: fileBytes(f), filename: f.name || 'file', type: mimeOf(f) }]);
        var res = await call('/v1/tools/ocr', { method: 'POST', headers: authHeaders({ 'Content-Type': mp.contentType }), body: mp.body }, 200000);
        var d = await readJson(res, 'DeepSeek OCR');
        if (d.error) throw new Error('DeepSeek OCR：' + (d.error.message || d.error));
        var pages = Array.isArray(d.pages) ? d.pages : [];
        var cut = pages.filter(function (p) { return p.finish_reason === 'length'; }).map(function (p) { return p.index + 1; });
        var text = pages.map(function (p) {
            var t = String(p.text || '').replace(/<｜(?:ref|\/ref|box|\/box|det|\/det)｜>/g, '').replace(/\[\[\d+,\s*\d+,\s*\d+,\s*\d+\]\]/g, '');
            return (pages.length > 1 ? '--- 第 ' + (p.index + 1) + ' 頁 ---\n' : '') + t.trim() + (p.finish_reason === 'length' ? '\n（這一頁的辨識結果可能不完整）' : '');
        }).join('\n\n');
        var out = { ok: true, text: text, pageCount: d.page_count || pages.length, cutPages: cut, usage: d.usage || null };
        _ocrCache[fp] = out;
        return out;
    }

    // ── ③ 文件解析（Files API ＋ Anthropic 格式引用）──
    var _fileCache = {};
    async function uploadFile(f) {
        var fp = fingerprint(f);
        if (_fileCache[fp]) return _fileCache[fp];
        var n = String(f.name || '');
        var purpose = /\.(txt|md|csv|json|log|ya?ml|xml|html?|js|ts|py|java|c|cpp|cs|go|rs)$/i.test(n) ? 'user_data' : 'text_recognition';
        var mp = multipart([{ name: 'purpose', value: purpose }, { name: 'file', bytes: fileBytes(f), filename: n || 'file', type: mimeOf(f) }]);
        var res = await call('/files', { method: 'POST', headers: authHeaders({ 'Content-Type': mp.contentType }), body: mp.body }, 260000);
        var d = await readJson(res, 'DeepSeek 文件解析');
        if (!d.id) throw new Error('DeepSeek 文件解析沒有回傳 file_id');
        _fileCache[fp] = d.id;
        return d.id;
    }
    async function askWithFiles(prompt, fileIds, opts) {
        opts = opts || {};
        var content = fileIds.map(function (id) { return { type: 'document', source: { type: 'file', file_id: id } }; }).concat([{ type: 'text', text: String(prompt || '') }]);
        var body = { model: 'deepseek-flash', max_tokens: opts.maxTokens || 16000, messages: (opts.history || []).concat([{ role: 'user', content: content }]) };
        if (opts.thinking === false) body.thinking = { type: 'disabled' };
        var res = await call('/anthropic/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key(), 'anthropic-version': '2023-06-01', 'anthropic-beta': 'files-api-2025-04-14' }, body: JSON.stringify(body) }, 300000);
        var d = await readJson(res, 'DeepSeek 文件問答');
        var text = (Array.isArray(d.content) ? d.content : []).filter(function (b) { return b && b.type === 'text'; }).map(function (b) { return b.text; }).join('');
        return { text: text, usage: d.usage || null, model: 'deepseek-flash' };
    }

    // ── ① 聯網工具 ──
    var WEB_VARIANTS = [
        { id: 'typed', tools: [{ type: 'deepseek_web_search' }, { type: 'deepseek_read_url' }] },
        { id: 'named', tools: [{ type: 'deepseek_web_search', name: 'deepseek_web_search' }, { type: 'deepseek_read_url', name: 'deepseek_read_url' }] }
    ];
    // 回傳要嘗試的 [{model, tools, vid}]；記住成功過的組合
    function webPlan(model) {
        var remembered = ls('nova_ds_web_variant', '');   // 例如 'typed@deepseek-flash'
        var plans = [];
        var push = function (m, v) { if (!plans.some(function (p) { return p.model === m && p.vid === v.id; })) plans.push({ model: m, tools: v.tools, vid: v.id }); };
        if (remembered) {
            var rv = remembered.split('@'), vv = WEB_VARIANTS.filter(function (v) { return v.id === rv[0]; })[0];
            if (vv && (rv[1] === model || rv[1] === 'deepseek-flash')) push(rv[1] === model ? model : 'deepseek-flash', vv);
        }
        WEB_VARIANTS.forEach(function (v) { push(model, v); });
        if (!/flash/i.test(model)) WEB_VARIANTS.forEach(function (v) { push('deepseek-flash', v); });
        return plans;
    }
    function rememberWeb(model, vid) { try { localStorage.setItem('nova_ds_web_variant', vid + '@' + model); } catch (e) { /* */ } }
    function webSources(msg) {
        var out = [], seen = {};
        var add = function (u, t) { u = String(u || ''); if (!/^https?:\/\//.test(u) || seen[u]) return; seen[u] = 1; out.push({ uri: u, title: String(t || u).slice(0, 200) }); };
        (msg && Array.isArray(msg.annotations) ? msg.annotations : []).forEach(function (a) {
            var c = a && (a.url_citation || a);
            if (c && c.url) add(c.url, c.title);
        });
        (msg && Array.isArray(msg.server_tool_calls) ? msg.server_tool_calls : []).forEach(function (step) {
            (step && Array.isArray(step.calls) ? step.calls : []).forEach(function (c) {
                (Array.isArray(c.sources) ? c.sources : []).forEach(function (s) { if (s) add(s.url || s.uri, s.title || s.site_name); });
                if (c.page && (c.page.url || c.page.uri)) add(c.page.url || c.page.uri, c.page.title);
            });
        });
        return out.slice(0, 30);
    }
    function webSteps(msg) {
        var n = { search: 0, read: 0 };
        (msg && Array.isArray(msg.server_tool_calls) ? msg.server_tool_calls : []).forEach(function (step) {
            (step && Array.isArray(step.calls) ? step.calls : []).forEach(function (c) { if (/search/i.test(c.type || c.kind || '')) n.search++; else n.read++; });
        });
        return n;
    }

    // ── ④ ASR ──
    function wav16k(buf) {   // Float32Array（16kHz 單聲道）→ 16 位元 PCM WAV 位元組
        var n = buf.length, ab = new ArrayBuffer(44 + n * 2), v = new DataView(ab);
        var w = function (o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
        w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
        v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
        for (var i = 0, o = 44; i < n; i++, o += 2) { var s = Math.max(-1, Math.min(1, buf[i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7FFF, true); }
        return new Uint8Array(ab);
    }
    async function resample16k(audioBuffer, startSec, endSec) {
        var sr = audioBuffer.sampleRate, s0 = Math.floor(startSec * sr), s1 = Math.min(Math.ceil(endSec * sr), audioBuffer.length), len = s1 - s0;
        if (len <= 0) return null;
        var outLen = Math.max(1, Math.ceil(len * 16000 / sr));
        var Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        var oc = new Off(1, outLen, 16000);
        var src = oc.createBuffer(audioBuffer.numberOfChannels, len, sr);
        for (var c = 0; c < audioBuffer.numberOfChannels; c++) src.copyToChannel(audioBuffer.getChannelData(c).subarray(s0, s1), c);
        var node = oc.createBufferSource(); node.buffer = src; node.connect(oc.destination); node.start();
        var out = await oc.startRendering();
        return out.getChannelData(0);
    }
    async function asrBlob(wavBytes) {   // wavBytes：Uint8Array（16kHz 單聲道 16 位元 WAV）
        var mp = multipart([{ name: 'file', bytes: wavBytes, filename: 'speech.wav', type: 'audio/wav' }]);
        var res = await call('/v1/tools/asr', { method: 'POST', headers: authHeaders({ 'Content-Type': mp.contentType }), body: mp.body }, 130000);
        var d = await readJson(res, 'DeepSeek 語音識別');
        return { text: String(d.text || ''), durationMs: d.duration_ms || 0 };
    }
    // 把 audioBuffer 的 [startSec, endSec) 切成 ≤110 秒的小段逐一辨識；onPiece(i, n) 可回報進度
    async function asrRange(audioBuffer, startSec, endSec, onPiece) {
        var PIECE = 110, parts = [], n = Math.max(1, Math.ceil((endSec - startSec) / PIECE));
        for (var i = 0; i < n; i++) {
            var a = startSec + i * PIECE, b = Math.min(endSec, a + PIECE);
            if (b - a < 0.3) continue;
            var pcm = await resample16k(audioBuffer, a, b);
            if (!pcm) continue;
            var r = await asrBlob(wav16k(pcm));
            if (r.text.trim()) parts.push(r.text.trim());
            if (typeof onPiece === 'function') { try { onPiece(i + 1, n); } catch (e) { /* */ } }
        }
        return parts.join('\n');
    }


    // ── 設定卡片（設定 → DeepSeek API Key 下方）──
    function sw(k, on) {
        return '<button type="button" data-ds="' + k + '" role="switch" aria-checked="' + (on ? 'true' : 'false') + '" style="width:44px;height:24px;border-radius:9999px;position:relative;flex:none;border:0;transition:background .15s;background:' + (on ? '#0ea5e9' : '#475569') + '">' +
            '<span style="position:absolute;top:2px;left:' + (on ? '22px' : '2px') + ';width:20px;height:20px;border-radius:9999px;background:#fff;transition:left .15s"></span></button>';
    }
    function renderCard() {
        var box = document.getElementById('nova-ds-adv');
        if (!box) return;
        var row = function (title, hint, ctl) { return '<div class="flex items-center gap-3"><div class="flex-1"><div class="text-xs text-slate-200 font-bold">' + title + '</div><div class="text-[11px] text-slate-400 leading-relaxed">' + hint + '</div></div>' + ctl + '</div>'; };
        box.innerHTML = '<div class="text-xs font-bold text-sky-400">DeepSeek 進階功能</div>' +
            row('聯網搜尋＋讀網頁', '對話用 DeepSeek 且搜尋開關打開時，讓 DeepSeek 自己搜尋（文字＋圖片）與讀取你貼的網址，回覆下方列出來源。每 1,000 次搜尋約 5 元人民幣。官方只確認 V4.1 Flash 支援；選 V4 Pro 被拒絕時，這次會自動改用 V4.1 Flash 並註明。', sw('nova_ds_web', webOn())) +
            row('附檔用 DeepSeek OCR／文件解析', 'PDF、Word、PPT（以及送給 V4 Pro 的圖片）先用 DeepSeek OCR 轉成文字；EPUB、MOBI 等改用文件解析（以 V4.1 Flash 回答）。每 1,000 頁約 1.5 元人民幣；手機上單檔上限 30MB。關掉時文件附檔不會送給 DeepSeek。', sw('nova_ds_docs', docsOn())) +
            row('錄音逐字稿引擎', '錄音紀錄的 AI 深度分析與上傳音檔轉錄。DeepSeek 語音識別每小時約 0.39 元人民幣，每 110 秒切一段送出，不分講者。摘要仍由 Gemini 產生（沒有 Gemini 金鑰時改由 DeepSeek 產生）。',
                '<select data-ds="nova_transcribe_engine" class="bg-slate-950 border border-slate-700 rounded-lg p-2 text-xs outline-none text-slate-300" style="flex:none"><option value="gemini"' + (transcribeEngine() === 'gemini' ? ' selected' : '') + '>Gemini</option><option value="deepseek"' + (transcribeEngine() === 'deepseek' ? ' selected' : '') + '>DeepSeek</option></select>');
    }
    function mountCard() {
        var inp = document.getElementById('key-deepseek');
        if (!inp || document.getElementById('nova-ds-adv')) return;
        var host = inp.parentElement, box = document.createElement('div');
        box.id = 'nova-ds-adv';
        box.className = 'space-y-3 border border-slate-700 rounded-lg p-3';
        box.addEventListener('click', function (ev) {
            var b = ev.target && ev.target.closest ? ev.target.closest('button[data-ds]') : null;
            if (!b) return;
            var k = b.getAttribute('data-ds');
            try { localStorage.setItem(k, ls(k, '1') !== '0' ? '0' : '1'); } catch (e) { /* */ }
            renderCard();
        });
        box.addEventListener('change', function (ev) {
            var s = ev.target;
            if (s && s.getAttribute && s.getAttribute('data-ds') === 'nova_transcribe_engine') { try { localStorage.setItem('nova_transcribe_engine', s.value === 'deepseek' ? 'deepseek' : 'gemini'); } catch (e) { /* */ } }
        });
        host.parentNode.insertBefore(box, host.nextSibling);
        renderCard();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountCard); else mountCard();

    window.NovaDeepSeek = {
        version: '1.0.0',
        key: key, webOn: webOn, docsOn: docsOn, transcribeEngine: transcribeEngine,
        call: call, readJson: readJson, kindOf: kindOf,
        ocr: ocr, uploadFile: uploadFile, askWithFiles: askWithFiles,
        webPlan: webPlan, rememberWeb: rememberWeb, webSources: webSources, webSteps: webSteps,
        asrBlob: asrBlob, asrRange: asrRange, _wav16k: wav16k, _resample16k: resample16k, _multipart: multipart, renderCard: renderCard,
        setPref: function (k, v) { try { localStorage.setItem(k, String(v)); } catch (e) { /* */ } }
    };
})();

/* ═══════════════════════════════════════════════════════════
   NOVA KB Tables v1.0.0-android.1 — 知識庫「表格感知」共用模組
   ------------------------------------------------------------
   由 index.html 與 knowledgebank.html 共同引入（跟 nova-memory-ingest.js 同一種做法），
   對外只露出 window.NovaKbTables。目的是讓「PDF 擷取」「切分」「文件類型」三件事
   在兩個頁面永遠是同一份邏輯（架構說明 28.4 記載過：兩頁各有一份切分常數，改一邊
   漏一邊是反覆踩的坑）。本檔不碰 DOM、不碰 appState，可用 node 直接單元測試。

   版本紀錄：
     v1.0.0-android.1 (2026-10-11) - 自 NOVA Desktop 的 nova-kb-tables.js v1.0.0 原樣移植到 NOVA Android（程式邏輯一字未改，只改這段標頭）。
             由 index.html（v2.6.21）與 knowledgebank.html（v2）共同引入，兩頁共用同一份切分／PDF 表格擷取／文件類型邏輯。
     v1.0.0 (2026-10-10) - 初版。起因：評估「多 Agent 專家 RAG」附件後，使用者決定全部導入。
             本檔負責其中三項：
             ① 表格原子化切分 chunkText()：偵測 Markdown 表格區塊（含筆記序列化出來沒有分隔列的
                表格、OCR/視覺轉出來的表格），整張表當一個 chunk，並在前面加上「章節＋表格說明」
                語意前綴；過大的表格依列拆分且每段重複表頭。沒有表格的文字走跟舊版逐字元相同的
                演算法（零回歸）。
             ② PDF 表格擷取 extractPdfText()：四種模式——off（舊行為）、local（本機座標分群，
                不花 Token）、vision（每頁交給 Gemini 轉 Markdown，較準但耗 Token）、auto（先本機
                偵測，只有「有表格／疑似有表格／沒有文字層」的頁面才送視覺）。本機模式刻意保留
                pdf.js 原始項目順序（雙欄論文的閱讀順序才不會被破壞），只把偵測到表格的區域換成
                Markdown 表格；偵測不到任何表格時輸出與舊版逐字元相同。
             ③ 文件類型 DOC_TYPES／guessDocType()：論文、規格書、報告、筆記、網頁、其他。
             ★ 誠實的限制：本機座標分群是啟發式（投影法找欄位間隙＋文字長度/數字比例過濾，專門
             避免把雙欄論文的左右兩欄誤認成 2 欄表格），只用合成資料與單元測試驗證，沒有用真實
             論文 PDF 實測；文字型（幾乎沒有數字）的表格本機模式會判成「疑似」而不轉換，auto 模式
             才會送視覺。
   ═══════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var API = { VERSION: '1.0.0' };

  // ───────────────────────── 文件類型 ─────────────────────────
  var DOC_TYPES = [
    { id: 'paper', label: '論文' },
    { id: 'spec', label: '規格書/TDS' },
    { id: 'report', label: '報告' },
    { id: 'note', label: '筆記' },
    { id: 'web', label: '網頁/文章' },
    { id: 'other', label: '其他' }
  ];
  API.DOC_TYPES = DOC_TYPES;

  function docTypeLabel(id) {
    for (var i = 0; i < DOC_TYPES.length; i++) if (DOC_TYPES[i].id === id) return DOC_TYPES[i].label;
    return '其他';
  }
  function normalizeDocType(id) {
    for (var i = 0; i < DOC_TYPES.length; i++) if (DOC_TYPES[i].id === id) return id;
    return 'other';
  }
  // 沒有 docType 的舊文件：筆記匯入的就是 note，其餘 other（不寫回資料庫，只在讀取時推斷）
  function effectiveDocType(doc) {
    if (!doc) return 'other';
    if (doc.docType) return normalizeDocType(doc.docType);
    if (doc.sourceType === 'note') return 'note';
    return 'other';
  }
  function guessDocType(name, text) {
    var n = String(name || '');
    var t = String(text || '').slice(0, 8000);
    if (/(^|[^a-z])(tds|sds|msds|datasheet|data[ _-]?sheet)([^a-z]|$)|規格書|技術資料|型錄/i.test(n)) return 'spec';
    if (/technical data sheet|safety data sheet|typical (physical )?properties|規格書|物性表/i.test(t.slice(0, 1500))) return 'spec';
    if (/\babstract\b|\bdoi\b|doi\.org|\bkeywords?\b\s*[:：]|\breferences\b|摘要|關鍵[詞字]|參考文獻/i.test(t)) return 'paper';
    if (/報告|report|週報|月報|會議紀錄|minutes/i.test(n)) return 'report';
    return 'other';
  }
  API.docTypeLabel = docTypeLabel;
  API.normalizeDocType = normalizeDocType;
  API.effectiveDocType = effectiveDocType;
  API.guessDocType = guessDocType;

  // ───────────────────────── Markdown 表格切分 ─────────────────────────
  var DEFAULTS = { size: 900, overlap: 150, tableMax: 3000 };

  // 跟舊版 chunkText()／novaKbChunkText() 逐字元相同的滑動視窗（零回歸基準）
  function legacyChunk(clean, size, overlap) {
    if (!clean) return [];
    var chunks = [];
    var start = 0;
    while (start < clean.length) {
      var end = Math.min(start + size, clean.length);
      if (end < clean.length) {
        var lastBreak = clean.lastIndexOf('\n', end);
        var lastPeriod = Math.max(clean.lastIndexOf('。', end), clean.lastIndexOf('. ', end));
        var breakPoint = Math.max(lastBreak, lastPeriod);
        if (breakPoint > start + size * 0.5) end = breakPoint + 1;
      }
      var piece = clean.slice(start, end).trim();
      if (piece) chunks.push(piece);
      if (end >= clean.length) break;
      start = end - overlap;
      if (start < 0) start = 0;
    }
    return chunks;
  }

  function normalizeText(text) {
    return (text || '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  }

  function isTableLine(line) {
    var s = String(line).trim();
    if (s.length < 3 || s.charAt(0) !== '|' || s.charAt(s.length - 1) !== '|') return false;
    var pipes = (s.match(/\|/g) || []).length;
    return pipes >= 3;
  }
  function isSepLine(line) {
    return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(String(line).trim());
  }

  // 把文字切成 [{type:'text'|'table', lines:[...]}]；單獨一行含 | 的不算表格（至少 2 行）
  function splitBlocks(clean) {
    var lines = clean.split('\n');
    var blocks = [];
    var i = 0;
    while (i < lines.length) {
      if (isTableLine(lines[i])) {
        var j = i;
        while (j < lines.length && isTableLine(lines[j])) j++;
        if (j - i >= 2) {
          blocks.push({ type: 'table', lines: lines.slice(i, j) });
          i = j;
          continue;
        }
      }
      var k = i;
      while (k < lines.length && !(isTableLine(lines[k]) && k + 1 < lines.length && isTableLine(lines[k + 1]))) k++;
      if (k === i) k = i + 1;
      blocks.push({ type: 'text', lines: lines.slice(i, k) });
      i = k;
    }
    // 合併相鄰 text
    var merged = [];
    blocks.forEach(function (b) {
      var last = merged[merged.length - 1];
      if (last && last.type === 'text' && b.type === 'text') last.lines = last.lines.concat(b.lines);
      else merged.push(b);
    });
    return merged;
  }

  var CAPTION_RE = /^(?:表格說明[:：]\s*)?((?:table|tab\.?|表|figure|fig\.?)\s*[\dA-Za-z一二三四五六七八九十]+.*)$/i;
  var MARKER_RE = /^\[(?:表格內容|圖片內容辨識)[^\]]*\](?:\[\[NOVA_IMG_REF:\d+\]\])?$/;
  var NOTE_RE = /^(?:備註[:：]\s*)?((?:(?:notes?|source)\b|[註※*]|資料來源|備註).*)$/i;
  var HEADING_RE = [
    /^#{1,6}\s+(.+)$/,
    /^(\d+(?:\.\d+){0,3}[\s.、]+[^\s].{0,80})$/,
    /^(第[一二三四五六七八九十\d]+[章節部分].{0,60})$/,
    /^((?:abstract|introduction|methods?|materials and methods|experimental|results?(?: and discussion)?|discussion|conclusions?|references)\b.{0,40})$/i
  ];

  function lastNonEmptyIndex(lines) {
    for (var i = lines.length - 1; i >= 0; i--) if (String(lines[i]).trim()) return i;
    return -1;
  }
  function findHeading(lines) {
    var scanned = 0;
    for (var i = lines.length - 1; i >= 0 && scanned < 80; i--, scanned++) {
      var s = String(lines[i]).trim();
      if (!s || s.length > 90) continue;
      if (/[。.;；,，]$/.test(s) && !/^#{1,6}\s/.test(s)) continue;
      for (var r = 0; r < HEADING_RE.length; r++) {
        var m = s.match(HEADING_RE[r]);
        if (m) return (m[1] || s).replace(/^#+\s*/, '').trim();
      }
    }
    return '';
  }

  // 從表格前一個文字區塊的尾端取出「表格說明」，並把它（與前導標記行）從文字區塊移除
  function takeCaption(textLines) {
    var caption = '';
    var idx = lastNonEmptyIndex(textLines);
    // 先吃掉 [表格內容] 之類的標記行
    while (idx >= 0 && MARKER_RE.test(String(textLines[idx]).trim())) {
      textLines.splice(idx, 1);
      idx = lastNonEmptyIndex(textLines);
    }
    if (idx >= 0) {
      var s = String(textLines[idx]).trim();
      if (s.length <= 220) {
        var m = s.match(CAPTION_RE);
        if (m) { caption = m[1].trim(); textLines.splice(idx, 1); }
        else if (s.length <= 60 && !/[。.;；:：]$/.test(s) && !isTableLine(s)) {
          // 很短、不像句子的一行，當作表格標題
          caption = s; textLines.splice(idx, 1);
        }
      }
    }
    return caption;
  }
  // 從表格後一個文字區塊的開頭取出一行備註
  function takeNote(textLines) {
    var i = 0;
    while (i < textLines.length && !String(textLines[i]).trim()) i++;
    if (i < textLines.length) {
      var s = String(textLines[i]).trim();
      var m = s.match(NOTE_RE);
      if (m && s.length <= 240) { textLines.splice(i, 1); return m[1].trim(); }
    }
    return '';
  }

  function tablePrefix(heading, caption) {
    var parts = [];
    if (heading) parts.push('章節：' + heading);
    if (caption) parts.push('說明：' + caption);
    return '【表格】' + parts.join('｜');
  }

  // 一張表 → 一個或多個 chunk（超過 tableMax 就依列拆，每段重複表頭）
  function tableToChunks(lines, heading, caption, note, tableMax) {
    var prefix = tablePrefix(heading, caption);
    var suffix = note ? '\n備註：' + note : '';
    var body = lines.map(function (l) { return String(l).trim(); });
    var whole = prefix + '\n' + body.join('\n') + suffix;
    if (whole.length <= tableMax) return [whole];

    var header = [body[0]];
    var start = 1;
    if (body.length > 1 && isSepLine(body[1])) { header.push(body[1]); start = 2; }
    var headText = header.join('\n');
    var out = [];
    var cur = [];
    var curLen = prefix.length + headText.length + 2;
    for (var i = start; i < body.length; i++) {
      var add = body[i].length + 1;
      if (cur.length && curLen + add > tableMax) {
        out.push(cur);
        cur = [];
        curLen = prefix.length + headText.length + 2;
      }
      cur.push(body[i]);
      curLen += add;
    }
    if (cur.length) out.push(cur);
    return out.map(function (rows, n) {
      var tag = out.length > 1 ? '（續表 ' + (n + 1) + '/' + out.length + '）' : '';
      return prefix + tag + '\n' + headText + '\n' + rows.join('\n') + (n === out.length - 1 ? suffix : '');
    });
  }

  // 主要 API：回傳 [{text, kind:'text'|'table'}]
  function chunkTextEx(text, opts) {
    opts = opts || {};
    var size = opts.size || DEFAULTS.size;
    var overlap = typeof opts.overlap === 'number' ? opts.overlap : DEFAULTS.overlap;
    var tableMax = opts.tableMax || DEFAULTS.tableMax;
    var clean = normalizeText(text);
    if (!clean) return [];

    var blocks = splitBlocks(clean);
    var hasTable = blocks.some(function (b) { return b.type === 'table'; });
    if (!hasTable) {
      return legacyChunk(clean, size, overlap).map(function (t) { return { text: t, kind: 'text' }; });
    }

    var out = [];
    var before = [];   // 到目前為止所有文字行（找章節標題用）
    for (var bi = 0; bi < blocks.length; bi++) {
      var b = blocks[bi];
      if (b.type === 'text') {
        var textLines = b.lines.slice();
        var next = blocks[bi + 1];
        // 這個 text 區塊後面接表格 → 尾端的表格說明要被拿走
        var caption = '';
        if (next && next.type === 'table') caption = takeCaption(textLines);
        // 這個 text 區塊前面是表格 → 開頭的備註已在處理上一張表時被拿走（見下方），這裡不再處理
        var segText = textLines.join('\n').trim();
        if (segText) {
          legacyChunk(segText, size, overlap).forEach(function (t) { out.push({ text: t, kind: 'text' }); });
        }
        before = before.concat(textLines);
        b._caption = caption;
      } else {
        var heading = findHeading(before);
        var prev = blocks[bi - 1];
        var cap = (prev && prev.type === 'text' && prev._caption) || '';
        var nextBlock = blocks[bi + 1];
        var note = '';
        if (nextBlock && nextBlock.type === 'text') note = takeNote(nextBlock.lines);
        tableToChunks(b.lines, heading, cap, note, tableMax).forEach(function (t) { out.push({ text: t, kind: 'table' }); });
      }
    }
    return out;
  }

  function chunkText(text, opts) {
    return chunkTextEx(text, opts).map(function (c) { return c.text; });
  }
  API.chunkText = chunkText;
  API.chunkTextEx = chunkTextEx;
  API.hasTables = function (text) {
    return splitBlocks(normalizeText(text)).some(function (b) { return b.type === 'table'; });
  };

  // ───────────────────────── PDF 表格偵測（pdf.js 文字項目 → Markdown） ─────────────────────────
  function median(arr) {
    if (!arr.length) return 0;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function percentile(arr, p) {
    if (!arr.length) return 0;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  }

  function buildLines(items) {
    var els = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || it.str == null) continue;
      var s = String(it.str);
      if (!s.trim()) continue;
      var tr = it.transform || [1, 0, 0, 1, 0, 0];
      var h = Math.abs(it.height || tr[3] || 0) || 10;
      var w = typeof it.width === 'number' ? it.width : s.length * h * 0.5;
      els.push({ i: i, s: s, x: tr[4] || 0, y: tr[5] || 0, w: w, h: h });
    }
    var order = els.slice().sort(function (a, b) { return (b.y - a.y) || (a.x - b.x); });
    var lines = [];
    order.forEach(function (e) {
      var ln = null;
      for (var k = lines.length - 1; k >= 0 && k >= lines.length - 3; k--) {
        if (Math.abs(lines[k].y - e.y) <= Math.max(2, Math.min(lines[k].h, e.h) * 0.45)) { ln = lines[k]; break; }
      }
      if (!ln) { ln = { y: e.y, h: e.h, els: [] }; lines.push(ln); }
      ln.els.push(e);
      if (e.h > ln.h) ln.h = e.h;
    });
    lines.forEach(function (ln) {
      ln.els.sort(function (a, b) { return a.x - b.x; });
      var segs = [];
      var cur = null;
      ln.els.forEach(function (e) {
        var gapThr = Math.max(e.h * 0.9, 5);
        if (cur && (e.x - cur.x1) <= gapThr) {
          cur.text += ((e.x - cur.x1) > e.h * 0.12 ? ' ' : '') + e.s;
          if (e.x + e.w > cur.x1) cur.x1 = e.x + e.w;
          cur.idxs.push(e.i);
        } else {
          cur = { x0: e.x, x1: e.x + e.w, text: e.s, idxs: [e.i] };
          segs.push(cur);
        }
      });
      ln.segs = segs;
      ln.text = segs.map(function (s) { return s.text; }).join(' ');
    });
    return lines;
  }

  function unionIntervals(ivs, pad) {
    var s = ivs.map(function (v) { return [v[0] - pad, v[1] + pad]; }).sort(function (a, b) { return a[0] - b[0]; });
    var out = [];
    s.forEach(function (v) {
      var last = out[out.length - 1];
      if (last && v[0] <= last[1]) { if (v[1] > last[1]) last[1] = v[1]; }
      else out.push([v[0], v[1]]);
    });
    return out;
  }
  function colIndexOf(cols, x0, x1) {
    var c = (x0 + x1) / 2;
    for (var i = 0; i < cols.length; i++) if (c >= cols[i][0] && c <= cols[i][1]) return i;
    var best = 0, bd = Infinity;
    for (var j = 0; j < cols.length; j++) {
      var d = Math.min(Math.abs(c - cols[j][0]), Math.abs(c - cols[j][1]));
      if (d < bd) { bd = d; best = j; }
    }
    return best;
  }
  function escCell(s) {
    return String(s || '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
  }

  // 對一個候選 run（lines 的連續區間）評估是否為表格。回傳 {ok, reason, rows, cols}
  function evaluateRun(run, pageWidth, o) {
    var rows = run.rows;
    var allSegs = [];
    rows.forEach(function (r) { r.segs.forEach(function (s) { allSegs.push([s.x0, s.x1]); }); });
    var cols = unionIntervals(allSegs, 2);
    if (cols.length < 2) return { ok: false, reason: 'onecol' };
    if (cols.length > o.maxCols) return { ok: false, reason: 'toomanycols' };
    var bodyRows = rows.filter(function (r) { return !r.cont; });
    if (bodyRows.length < o.minRows) return { ok: false, reason: 'fewrows' };
    var multi = bodyRows.filter(function (r) {
      var set = {};
      r.segs.forEach(function (s) { set[colIndexOf(cols, s.x0, s.x1)] = 1; });
      return Object.keys(set).length >= 2;
    }).length;
    if (multi / bodyRows.length < 0.7) return { ok: false, reason: 'notmulti' };

    var lens = [], digitCells = 0, totalCells = 0;
    bodyRows.forEach(function (r, ri) {
      r.segs.forEach(function (s) {
        var t = s.text.trim();
        lens.push(t.length);
        if (ri > 0) { totalCells++; if (/\d/.test(t)) digitCells++; }
      });
    });
    var med = median(lens), p90 = percentile(lens, 0.9);
    var tabular = med <= 40 && p90 <= 90;
    // 雙欄論文：左右兩欄的整行文字被橫向併成「2 欄」
    if (cols.length === 2) {
      var w0 = cols[0][1] - cols[0][0], w1 = cols[1][1] - cols[1][0];
      if (med > 18 && pageWidth && w0 > pageWidth * 0.3 && w1 > pageWidth * 0.3) return { ok: false, reason: 'twocolprose' };
    }
    if (!(med <= o.maxMedianLen && p90 <= o.maxP90Len)) return { ok: false, reason: 'prose', tabular: tabular };
    var ratio = totalCells ? digitCells / totalCells : 0;
    if (ratio < o.minNumericRatio) return { ok: false, reason: 'lownumeric', tabular: tabular };
    return { ok: true, cols: cols, ratio: ratio };
  }

  function rowToCells(row, cols, n) {
    var cells = [];
    for (var i = 0; i < n; i++) cells.push('');
    row.segs.forEach(function (s) {
      var ci = colIndexOf(cols, s.x0, s.x1);
      cells[ci] = (cells[ci] ? cells[ci] + ' ' : '') + s.text.trim();
    });
    return cells;
  }

  function toMarkdown(matrix) {
    if (!matrix.length) return '';
    var n = matrix[0].length;
    var lines = [];
    matrix.forEach(function (cells, i) {
      lines.push('| ' + cells.map(escCell).join(' | ') + ' |');
      if (i === 0) {
        var sep = [];
        for (var k = 0; k < n; k++) sep.push('---');
        lines.push('| ' + sep.join(' | ') + ' |');
      }
    });
    return lines.join('\n');
  }

  var PDF_DEFAULTS = { minRows: 3, maxRows: 90, maxCols: 14, maxMedianLen: 28, maxP90Len: 70, minNumericRatio: 0.2 };

  // items：pdf.js getTextContent().items；pageWidth：viewport.width（可省略）
  // 回傳 { text, legacyText, tables:[{md,caption,note}], suspect }
  function analyzePdfPage(items, pageWidth, options) {
    var o = Object.assign({}, PDF_DEFAULTS, options || {});
    items = items || [];
    var legacyText = items.map(function (it) { return it.str; }).join(' ');
    var lines = buildLines(items);
    var tables = [];
    var suspect = false;
    var captionSeen = false;
    var consumed = {};     // item index → table id
    var tableInfo = [];

    var li = 0;
    while (li < lines.length) {
      var ln = lines[li];
      if (CAPTION_RE.test(ln.text.trim()) && ln.text.length < 260) captionSeen = true;
      if (ln.segs.length < 2) { li++; continue; }
      // 建立 run
      var run = { rows: [ln], start: li };
      var lj = li + 1;
      while (lj < lines.length) {
        var nx = lines[lj];
        var prevLn = lines[lj - 1];
        var gap = prevLn.y - nx.y;
        if (gap > Math.max(prevLn.h, nx.h) * 2.4) break;
        if (nx.segs.length >= 2) { run.rows.push(nx); lj++; continue; }
        // 單一區段：若落在目前欄位範圍內的單一欄、文字短、已有 ≥2 列，視為換行延續
        if (run.rows.length >= 2 && nx.segs.length === 1 && nx.text.trim().length <= 40) {
          var colsNow = unionIntervals([].concat.apply([], run.rows.map(function (r) { return r.segs.map(function (s) { return [s.x0, s.x1]; }); })), 2);
          var s0 = nx.segs[0];
          var inOne = colsNow.some(function (c) { return s0.x0 >= c[0] - 1 && s0.x1 <= c[1] + 1; });
          // 延續行之後必須還有多欄列才算（避免吃掉表格下面的單行註解）
          var after = lines[lj + 1];
          if (inOne && after && after.segs.length >= 2 && (nx.y - after.y) <= Math.max(nx.h, after.h) * 2.4) {
            nx.cont = true; run.rows.push(nx); lj++; continue;
          }
        }
        break;
      }
      var res = (run.rows.length >= o.minRows && run.rows.length <= o.maxRows) ? evaluateRun(run, pageWidth, o) : { ok: false, reason: 'fewrows' };
      if (res.ok) {
        var cols = res.cols, n = cols.length;
        var matrix = [];
        run.rows.forEach(function (r) {
          if (r.cont && matrix.length) {
            var extra = rowToCells(r, cols, n), last = matrix[matrix.length - 1];
            for (var c = 0; c < n; c++) if (extra[c]) last[c] = (last[c] ? last[c] + ' ' : '') + extra[c];
          } else {
            matrix.push(rowToCells(r, cols, n));
          }
        });
        var tid = tableInfo.length;
        var itemIdxs = [];
        run.rows.forEach(function (r) { r.segs.forEach(function (s) { itemIdxs = itemIdxs.concat(s.idxs); }); });
        // 前一行若像表格標題 → 一併吃掉；後一行若像備註 → 一併吃掉
        var caption = '', note = '';
        var above = lines[run.start - 1];
        if (above && above.segs.length <= 3 && above.text.trim().length <= 260 && (above.y - run.rows[0].y) <= Math.max(above.h, run.rows[0].h) * 3.2) {
          var cm = above.text.trim().match(CAPTION_RE);
          if (cm) { caption = cm[1].trim(); above.segs.forEach(function (s) { itemIdxs = itemIdxs.concat(s.idxs); }); }
        }
        var below = lines[lj];
        if (below && below.text.trim().length <= 260 && (run.rows[run.rows.length - 1].y - below.y) <= Math.max(below.h, 10) * 2.4) {
          var nm = below.text.trim().match(NOTE_RE);
          if (nm && below.segs.length <= 3) { note = nm[1].trim(); below.segs.forEach(function (s) { itemIdxs = itemIdxs.concat(s.idxs); }); }
        }
        var minIdx = Infinity;
        itemIdxs.forEach(function (ix) { consumed[ix] = tid; if (ix < minIdx) minIdx = ix; });
        tableInfo.push({ md: toMarkdown(matrix), caption: caption, note: note, first: minIdx });
        tables.push({ md: toMarkdown(matrix), caption: caption, note: note, rows: matrix.length, cols: n });
      } else if (run.rows.length >= o.minRows && res.tabular) {
        suspect = true;
      }
      li = Math.max(lj, li + 1);
    }
    if (captionSeen && tables.length === 0) suspect = true;

    if (!tables.length) return { text: legacyText, legacyText: legacyText, tables: [], suspect: suspect };

    // 依 pdf.js 原始項目順序輸出，表格在其第一個項目的位置展開
    var parts = [];
    var emitted = {};
    for (var i = 0; i < items.length; i++) {
      if (consumed[i] != null) {
        var t = consumed[i];
        if (!emitted[t] && tableInfo[t].first === i) {
          emitted[t] = true;
          var info = tableInfo[t];
          parts.push('\n\n' + (info.caption ? '表格說明：' + info.caption + '\n' : '') + info.md + (info.note ? '\n備註：' + info.note : '') + '\n\n');
        }
        continue;
      }
      parts.push(items[i].str);
    }
    var text = parts.join(' ').replace(/ ?\n\n ?/g, '\n\n');
    return { text: text, legacyText: legacyText, tables: tables, suspect: suspect };
  }
  API.analyzePdfPage = analyzePdfPage;

  // ───────────────────────── PDF 整份擷取（四種模式） ─────────────────────────
  var VISION_PROMPT = [
    '你是 PDF 頁面轉錄工具。請把這一頁完整轉成 Markdown：',
    '- 依閱讀順序輸出；雙欄排版先左欄後右欄。',
    '- 內文逐字轉錄，不要摘要、不要翻譯、不要補充說明。',
    '- 表格一律用 Markdown 表格，完整保留每一欄、每一列、數值、單位、上下標與表頭；合併儲存格請在對應欄重複或留空，不要自行推測。',
    '- 表格上方的標題（例如 Table 2 ...）與下方的註解請原樣各留一行，緊貼表格。',
    '- 圖表只轉錄標題與圖例文字，不要編造任何數據點。',
    '- 略過頁首、頁尾與頁碼。',
    '- 數學式用純文字或簡單 LaTeX。',
    '- 看不清楚的字用 [?] 標示，不要猜。',
    '只輸出轉錄結果，不要加任何開頭或結尾說明。'
  ].join('\n');
  API.VISION_PROMPT = VISION_PROMPT;
  API.PDF_MODES = [
    { id: 'off', label: '關閉（舊行為，表格會被攤平）' },
    { id: 'local', label: '本機座標分群（免費，準度中）' },
    { id: 'auto', label: '自動（本機偵測，有表格的頁面才用 Gemini 視覺）' },
    { id: 'vision', label: 'Gemini 視覺（每頁，最準、最耗 Token）' }
  ];
  API.normalizePdfMode = function (m) {
    return ['off', 'local', 'auto', 'vision'].indexOf(m) !== -1 ? m : 'local';
  };

  // args: { pdf, mode, renderPage(page)->Promise<dataUrl>, callVision(dataUrl,prompt)->Promise<string>,
  //         onProgress(label), shouldStop(), maxVisionPages }
  // 回傳 { text, stats:{pages, tablePages, tables, visionPages, visionFailed, suspectPages} }
  async function extractPdfText(args) {
    var pdf = args.pdf;
    var mode = API.normalizePdfMode(args.mode);
    var maxVision = typeof args.maxVisionPages === 'number' ? args.maxVisionPages : 80;
    var stats = { pages: pdf.numPages, tablePages: 0, tables: 0, visionPages: 0, visionFailed: 0, suspectPages: 0, mode: mode };
    var full = '';
    for (var p = 1; p <= pdf.numPages; p++) {
      if (args.shouldStop && args.shouldStop()) break;
      var page = await pdf.getPage(p);
      var content = await page.getTextContent();
      var items = content.items || [];
      var width = 0;
      try { width = page.getViewport({ scale: 1 }).width; } catch (e) { width = 0; }
      var out;
      var local = null;
      if (mode === 'off') {
        out = items.map(function (it) { return it.str; }).join(' ');
      } else {
        local = analyzePdfPage(items, width);
        out = local.text;
        if (local.tables.length) { stats.tablePages++; stats.tables += local.tables.length; }
        if (local.suspect) stats.suspectPages++;
        var noTextLayer = items.length === 0 || local.legacyText.replace(/\s+/g, '').length < 20;
        var wantVision = mode === 'vision' || (mode === 'auto' && (local.tables.length > 0 || local.suspect || noTextLayer));
        if (wantVision && args.renderPage && args.callVision && stats.visionPages < maxVision) {
          try {
            if (args.onProgress) args.onProgress('第 ' + p + '/' + pdf.numPages + ' 頁：Gemini 視覺轉錄中…');
            var dataUrl = await args.renderPage(page);
            var md = await args.callVision(dataUrl, VISION_PROMPT);
            md = String(md || '').trim();
            if (md.length >= 20) { out = md; stats.visionPages++; }
            else stats.visionFailed++;
          } catch (e) {
            stats.visionFailed++;
            if (args.onWarn) args.onWarn('第 ' + p + ' 頁視覺轉錄失敗，改用本機結果：' + (e && e.message ? e.message : e));
          }
        }
      }
      full += out + '\n\n';
      if (args.onProgress && mode !== 'vision') args.onProgress('已解析 ' + p + '/' + pdf.numPages + ' 頁');
    }
    return { text: full, stats: stats };
  }
  API.extractPdfText = extractPdfText;

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.NovaKbTables = API;
})(typeof window !== 'undefined' ? window : this);

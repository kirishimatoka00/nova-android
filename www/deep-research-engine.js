/* [NOVA Android] deep-research-engine.js — 由 NOVA Desktop 同名檔案原樣移植（純邏輯、不碰 DOM／appState，所有外部能力由 deps 注入，行為與桌面版 v1.1.0 一致）。
   Android 移植版本紀錄：v1.0.0-android.1 - 批次 6a 初次移植，內容未修改。 */
/* ═══════════════════════════════════════════════════════════
   NOVA Deep Research Engine v1.0.0
   ------------------------------------------------------------
   獨立的共用檔案，由 index.html 用 <script src="./deep-research-engine.js">
   引入（跟 workflow-scheduler.js 同一種做法），對外只露出
   window.NovaDeepResearch。所有跟 App 本體的耦合（呼叫 Gemini/Grok、
   Firecrawl、原生 HTTP、寫檔、進度回報）都透過 run() 的 deps 參數注入，
   引擎本身不碰 appState、不碰 DOM，所以可以用 node 加假的 deps 做單元測試。

   版本紀錄：
     v1.1.0 (2026-09-20) - 使用者要求：① 深度研究可以細部指定多個 Gemini／Grok 模型；② 搜尋資料時
             由主模型分派多個模型「並行」搜索。引擎端的實作：
             ① 角色細分：planner／writer／critic 各自可指定模型；reader（讀取抽取）、
             searcher（Gemini 接地搜尋）、grok（即時情報）可以各指定「一組」模型（模型池）；
             grokReview（交叉審查）可另外指定。全部向下相容：傳單一字串等於池裡只有一個模型。
             ② 模型池排程（makePool／geminiPooled）：每次呼叫挑「目前沒被限流、用得最少」的模型，
             某個模型回 429 時只冷卻「那一個模型」並立刻改派池內其他模型（不必睡等），模型
             不存在／不支援則從池中剔除（Grok 連續失敗 2 次也剔除該模型）。Gemini 的額度是「每個
             模型各自計算」，所以池越大，同時能跑的讀取越多、被限流的機率越低；讀取並行度也依池的
             大小自動放寬（上限 6，避免打滿 sidecar 的執行緒池）。冷卻改成「每個模型獨立」，
             寫作模型被限流不會再拖住讀取池。
             ③ 搜尋策略 searchStrategy：chain（原本的依序備援，最省額度）、parallel（同一條
             查詢同時丟給 Firecrawl／SerpApi／Gemini 接地搜尋，合併去重，多個管道都找到的來源
             加分）、max（parallel＋Grok 依章節當「資料偵察員」，用網頁搜尋找權威來源網址，
             併入候選後仍由 Reader 讀原文驗證；偵察最多等 100 秒，慢的結果留給之後的補查輪）。
             ④ 即時情報階段的 Grok 任務改成並行（原本逐一執行），依池輪流派給不同 Grok 模型。
             ⑤ 「分派」的說明：分派由引擎的排程器決定（確定性、零延遲），主模型 Planner 已經把
             主題拆成章節與查詢，這些就是可並行的工作單位；不另外呼叫一個 LLM 來當調度員，
             因為那只會多一次往返、多一份費用，卻不會比輪流＋失敗改派更聰明。
             ⑥ 報告的「研究方法與限制」與證據附錄會列出各模型實際被呼叫的次數，可以直接看出
             分派是否平均。onCall 事件補上 model 欄位，UI 可顯示每個請求用哪個模型。
     v1.0.2 (2026-09-20) - 使用者回報「進行中看不出是在跑還是當機、無法及時中斷」。引擎端的配合：
             ① 新增 deps.onCall({id,label,event:'start'|'end'})：每一次 Gemini／Grok／
             Firecrawl／SerpApi／直連讀頁在開始與結束時都會回報，UI 才能顯示「正在等待
             哪個請求、已等多久」，並區分「正常等待」與「疑似卡住」。
             ② 重試退避與冷卻等待改成「可取消的睡眠」（每 400ms 檢查一次停止旗標）：
             原本 429 退避最多睡 60 秒，期間按停止要等睡醒才生效。
             ③ progress 快照補上 sectionsDone／sectionsTotal；新增 opts.control.snapshot()：
             給 UI 在「強制結束」時，不等引擎收尾就能立刻拿到目前已完成章節組成的部分報告。
     v1.0.1 (2026-09-20) - 使用者第一次實跑（標準深度、6 章、約 2.8 萬字）後回報並實際檢查
             報告與證據附錄，修正下列問題：
             ① 【參考來源連結被汙染】原本每行結尾是「網址（Grok 搜尋結果…）」，
             全形括號緊貼在網址後面，Markdown／App 的自動連結會把整段註解也算進
             網址，點了打不開。改成「擷取方式寫在網址前面、網址放在整行最後、
             前面用半形空白隔開、後面什麼都不接」；證據附錄的來源表也補一欄純網址。
             另外標題本身就是網址的來源（PDF、Grok 引用）不再把網址印兩遍，改用
             「網域／檔名」，Reader 也會回報文件標題來補。
             ② 【Firecrawl 太早被整個停用】原本只要遇到一次 429 或累計 4 次失敗，
             本次研究後面就完全不用 Firecrawl（實跑在 1 分 07 秒就停用，之後大量
             網頁改走直連而抓不到，Critic 第一輪平均只有 1.8/10）。改成：429 只
             暫停 Firecrawl 一段時間（20 秒起、逐次加長，期間該次呼叫改走其他管道），
             累計 6 次限流才停用；401／402（金鑰無效／額度用盡）才立刻停用；同時
             限制 Firecrawl 同時最多 2 個請求，降低被限流的機率。
             ③ 【讀不到的網頁佔掉來源額度】原本 maxSources 算的是「嘗試次數」，
             實跑 46 個來源有 24 個讀不到（付費牆／擋爬蟲），有效來源只剩不到一半。
             改成算「成功讀到的來源」，讀不到的自動遞補下一個候選（嘗試次數上限為
             額度的 2.5 倍，避免無限重試）。
             ④ 【Grok 太慢】一次逾時 240 秒後又重試 240 秒，交叉審查一步就花了
             10 分鐘。改成：逾時不重試、其他暫時性錯誤最多重試 1 次；單次逾時縮為
             180 秒；每次最多要 8 條；即時情報階段跟 Gemini 的反思補查階段改成
             同時進行（原本是先後）。
             ⑤ 【來源類型標錯】Grok 引用的 sciencedirect／wiley 被標成「新聞媒體」。
             現在先用網域判斷（學術出版商→學術論文、政府／教育／法規機構／專利→
             官方文件、知乎／Reddit 等→社群論壇），判斷不出來才採用模型的說法。
             ⑥ 【研究方法與限制裡的缺口過時】Critic 是在 Grok 證據進來之前評分的，
             所以報告寫「第五章證據分 0/10、完全沒有內容」，但正文其實已經有 70 個
             引用。現在每條缺口都標明「補查前評估」並附上目前該章實際證據數，
             證據已充足的章節不再列為缺口。
             ⑦ 【排版】撰稿提示詞禁止 LaTeX（$\\text{NO}_x$ 在 Markdown 裡會顯示成亂碼，
             改寫 NOx、ΔE）與章節內的 --- 分隔線；規劃器不再在章節標題自帶
             「第X章」（會跟自動編號重複成「5. 第五章：」）。
             ⑧ 搜尋走 Gemini 接地時，來源網址是 Google 的轉址連結；讀頁成功後改用
             最終網址當作來源網址。
             ⑨ SerpApi 回 401／403（金鑰無效或額度用盡）就整個停用，不再每條查詢
             都試一次。
     v1.0.0 (2026-09-20) - 初版。起因：使用者要求把「多 AI 深度研究」加強到
             不遜於 Gemini Deep Research。舊版（index.html 的
             startMultiAgentResearch）是線性 4 階段：只拆 3~4 個子問題、
             研究員只做「一次」開啟搜尋的呼叫、審查委員只是把摘要再改寫
             一遍、總編輯一次寫完，而且提示詞把長度寫死成「超過 2500 字」，
             所以報告短、內容淺、沒有可追溯的來源。這個引擎改成依照
             使用者提供的概念（Planner／Search&Browse／Critic／Memory／
             Synthesizer 五大模組 + Gemini×Grok 異構雙軌）實作：
             ① Planner：Gemini 產出「研究計畫樹」（章節、關鍵問題、中英
             混合查詢、反方命題），失敗時退回內建的通用章節模板，不會整個
             中止。
             ② Search & Browse：搜尋管道 Firecrawl search（可連同內文）→
             SerpApi → Gemini Google 搜尋接地（三段式備援，任一段有結果就用）；
             讀頁管道 Firecrawl scrape → 原生 HTTP 直連（自動判斷編碼，支援
             Big5/GBK；HTML→本文萃取，保留標題與表格結構）→ PDF 走 Gemini
             原生 PDF 讀取。每個來源只讀一次，由 Reader 一次抽出「可引用的
             事實」並標記適用章節（不是整頁塞進報告），引述與數字會回頭比對
             原文，對不上的引述直接丟掉、數字降為低信心，避免模型編造。
             ③ Critic / Reflection：每輪由 Gemini 逐章評分「證據是否足夠」、
             列出缺口與衝突，缺口觸發補查；設有 Early Exit（資料充足、或
             補查新增事實 <3 條就停），不會無限循環燒 Token。
             ④ 異構雙軌交叉審查（需要 Grok Key）：Grok 當「即時情報＋唱反調」，
             找社群/一線反饋與反證（每條必須附網址，沒有網址的丟掉）；再由
             Gemini 逐條判定 corroborated／contradicted／unverified／reject，
             並且把 Grok 引用的網址實際抓回來讓 Reader 用原文驗證。整段只跑
             一輪、有重試上限。沒有 Grok Key 時自動略過，其餘流程照跑。
             ⑤ Synthesizer：依章節「逐章」撰寫（每章獨立呼叫，只帶該章證據包
             ＋全書大綱＋前面章節摘要），章節寫太短會自動擴寫一輪，被
             MAX_TOKENS 截斷會自動接續；最後由整本正文產生執行摘要與結論。
             這是突破單次輸出長度上限、也避開 sidecar 單次請求 120 秒上限的
             關鍵（見 main.py _llm_proxy_sync），比「一次叫模型寫 3 萬字」
             可靠得多。
             ⑥ 引用與溯源：正文一律用 [S#] 標記證據來源，組裝時依首次出現順序
             重新編號成 [1][2]...，不存在的編號直接移除，文末列出「只有被引用
             過」的來源清單（含網址、來源類型、擷取方式）；另外輸出一份證據
             附錄（所有事實、來源、判定、執行紀錄）供查核。
             ⑦ 韌性：Gemini 429/5xx/逾時自動退避重試，429 時全域冷卻；單一
             來源/單一章節失敗不會中止整個流程；使用者按「停止」會保留已完成
             的章節。
             ⑧ 深度預設：standard／deep／max 三檔（章節數、查詢數、來源上限、
             反思輪數、每章字數），並提供 estimate() 讓 UI 顯示預估呼叫數與
             時間。
   ═══════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  const VERSION = '1.1.0';

  // ────────────────────────────────────────────────────────────
  // 深度預設。sectionChars 是「每章目標字數（中文字元，不含空白）」，
  // 刻意控制在單次呼叫 120 秒內能穩定寫完的量（約 3~4K tokens）——想要更長
  // 的報告靠「更多章節」而不是「更長的單章」。
  // ────────────────────────────────────────────────────────────
  const DEPTH_PRESETS = {
    standard: { key: 'standard', label: '標準深度（約 8,000～12,000 字）', sectionsMin: 5, sectionsMax: 7, queriesPerSection: 3, resultsPerQuery: 5, maxSources: 16, pageCharCap: 25000, reflectionRounds: 1, followupQueries: 6, sectionChars: 1700, grokSections: 2, readConcurrency: 3, expandThreshold: 0.7 },
    deep:     { key: 'deep',     label: '深入研究（約 18,000～25,000 字）', sectionsMin: 8, sectionsMax: 10, queriesPerSection: 4, resultsPerQuery: 6, maxSources: 34, pageCharCap: 40000, reflectionRounds: 2, followupQueries: 10, sectionChars: 2400, grokSections: 4, readConcurrency: 3, expandThreshold: 0.7 },
    max:      { key: 'max',      label: '出版級白皮書（約 30,000～42,000 字）', sectionsMin: 10, sectionsMax: 13, queriesPerSection: 5, resultsPerQuery: 6, maxSources: 60, pageCharCap: 60000, reflectionRounds: 3, followupQueries: 14, sectionChars: 3200, grokSections: 6, readConcurrency: 3, expandThreshold: 0.7 },
  };

  class CancelledError extends Error { constructor(msg) { super(msg || '使用者已手動停止'); this.name = 'CancelledError'; this.cancelled = true; } }
  const isCancelErr = (e) => !!(e && (e.cancelled || e.name === 'CancelledError' || /使用者已手動停止/.test(String(e.message || e))));

  // ────────────────────────────────────────────────────────────
  // 小工具
  // ────────────────────────────────────────────────────────────
  const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));
  const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; };
  const countChars = (s) => String(s || '').replace(/\s/g, '').length;
  const uniq = (arr) => Array.from(new Set(arr));

  async function mapLimit(items, limit, fn, shouldStop) {
    const results = new Array(items.length);
    let idx = 0;
    const workerCount = Math.max(1, Math.min(limit || 1, items.length || 1));
    const workers = [];
    for (let w = 0; w < workerCount; w++) {
      workers.push((async () => {
        for (;;) {
          if (shouldStop && shouldStop()) return;
          const i = idx++;
          if (i >= items.length) return;
          results[i] = await fn(items[i], i);
        }
      })());
    }
    await Promise.all(workers);
    return results;
  }

  function fmtDuration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(s / 60);
    return m > 0 ? `${m} 分 ${String(s % 60).padStart(2, '0')} 秒` : `${s} 秒`;
  }

  function slugify(s) {
    const t = String(s || '').replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').trim().replace(/\s+/g, '_');
    return (t || 'research').slice(0, 36);
  }

  function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }

  function normalizeUrl(u) {
    if (!u) return '';
    try {
      const x = new URL(String(u).trim());
      if (!/^https?:$/.test(x.protocol)) return '';
      x.hash = '';
      const drop = [];
      x.searchParams.forEach((v, k) => { if (/^(utm_|fbclid|gclid|mc_|ref$|ref_src|spm|share)/i.test(k)) drop.push(k); });
      drop.forEach((k) => x.searchParams.delete(k));
      let s = x.toString();
      if (s.endsWith('/') && x.pathname === '/') s = s.slice(0, -1);
      return s;
    } catch (e) { return ''; }
  }

  // 容錯 JSON 解析：去掉 ``` 圍欄、抓第一個 { 或 [ 到最後一個對應的 } 或 ]、修尾逗號。
  function safeJsonParse(text) {
    if (text == null) return null;
    if (typeof text === 'object') return text;
    let s = String(text).trim();
    if (!s) return null;
    s = s.replace(/^```(?:json|JSON)?\s*/, '').replace(/```\s*$/, '').trim();
    try { return JSON.parse(s); } catch (e) { /* 往下嘗試 */ }
    const firstObj = s.indexOf('{'), firstArr = s.indexOf('[');
    let start = -1, endCh = '';
    if (firstObj !== -1 && (firstArr === -1 || firstObj < firstArr)) { start = firstObj; endCh = '}'; }
    else if (firstArr !== -1) { start = firstArr; endCh = ']'; }
    if (start === -1) return null;
    const end = s.lastIndexOf(endCh);
    if (end <= start) return null;
    let body = s.slice(start, end + 1);
    try { return JSON.parse(body); } catch (e) { /* 修尾逗號 */ }
    body = body.replace(/,\s*([}\]])/g, '$1');
    try { return JSON.parse(body); } catch (e) { return null; }
  }

  const normWs = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
  function containsNormalized(haystack, needle) {
    const n = normWs(needle);
    if (n.length < 6) return false;
    return normWs(haystack).indexOf(n) !== -1;
  }

  // ────────────────────────────────────────────────────────────
  // 位元組解碼（自動判斷編碼）與 HTML → 本文萃取
  // ────────────────────────────────────────────────────────────
  function decodeBytes(bytes, contentType) {
    let charset = ((String(contentType || '').match(/charset\s*=\s*["']?([\w-]+)/i)) || [])[1];
    if (!charset) {
      let head = '';
      const n = Math.min(bytes.length, 4096);
      for (let i = 0; i < n; i++) head += String.fromCharCode(bytes[i]);
      const m = head.match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i);
      charset = m && m[1];
    }
    charset = String(charset || 'utf-8').toLowerCase();
    if (charset === 'gb2312') charset = 'gbk';
    if (charset === 'big5-hkscs') charset = 'big5';
    try { return new TextDecoder(charset).decode(bytes); }
    catch (e) { return new TextDecoder('utf-8').decode(bytes); }
  }

  const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', copy: '©', reg: '®', middot: '·', bull: '•', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', times: '×', deg: '°' };
  function decodeEntities(s) {
    return String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, g) => {
      if (g[0] === '#') {
        const code = g[1].toLowerCase() === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
        try { return String.fromCodePoint(code); } catch (e) { return ' '; }
      }
      const v = ENTITIES[g.toLowerCase()];
      return v === undefined ? m : v;
    });
  }

  function htmlToText(html) {
    if (!html) return { title: '', description: '', text: '' };
    html = String(html);
    const pick = (re) => { const m = html.match(re); return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : ''; };
    const title = pick(/<title[^>]*>([\s\S]*?)<\/title>/i) || pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i);
    const description = pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i);

    let body = html;
    const bm = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    if (bm) body = bm[1];
    body = body.replace(/<!--[\s\S]*?-->/g, '');
    body = body.replace(/<(script|style|noscript|svg|iframe|form|template|canvas|button|select|option)\b[\s\S]*?<\/\1\s*>/gi, ' ');

    // 優先只取 <article> / <main>（夠長才採用，避免抓到很小的區塊）
    let narrowed = false;
    for (const tag of ['article', 'main']) {
      const re = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)<\\/' + tag + '\\s*>', 'i');
      const m = body.match(re);
      if (m && m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, '').length > 800) { body = m[1]; narrowed = true; break; }
    }
    body = body.replace(/<(nav|footer|aside)\b[\s\S]*?<\/\1\s*>/gi, ' ');
    if (!narrowed) body = body.replace(/<header\b[\s\S]*?<\/header\s*>/gi, ' ');

    body = body
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<h([1-6])\b[^>]*>/gi, (m, n) => '\n\n' + '#'.repeat(Math.min(4, +n)) + ' ')
      .replace(/<\/h[1-6]\s*>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<tr\b[^>]*>/gi, '\n| ')
      .replace(/<\/t[dh]\s*>/gi, ' | ')
      .replace(/<\/(p|div|section|article|tr|blockquote|pre|table|ul|ol|dd|dt|figure|figcaption|caption)\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ');

    let text = decodeEntities(body);
    const lines = text.split('\n').map((l) => l.replace(/[ \t\u00a0\u3000]+/g, ' ').trim());
    const out = [];
    let prev = '';
    for (const l of lines) {
      if (!l) { if (out.length && out[out.length - 1] !== '') out.push(''); continue; }
      if (/^[|\s-]+$/.test(l)) continue;                        // 空表格列 / 分隔線
      if (l.length < 4 && !/^#/.test(l) && !/[\u4e00-\u9fa5]{2}/.test(l)) continue;   // 太短的雜訊
      if (l === prev) continue;
      out.push(l); prev = l;
    }
    text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return { title, description, text };
  }

  // ────────────────────────────────────────────────────────────
  // 來源品質啟發式 / 封鎖清單
  // ────────────────────────────────────────────────────────────
  function domainScore(host) {
    host = String(host || '').toLowerCase();
    if (/(^|\.)(gov|edu|mil)(\.[a-z]{2})?$/.test(host) || /\.(gov|edu)\.[a-z]{2}$/.test(host) ||
        /(^|\.)(europa\.eu|who\.int|oecd\.org|worldbank\.org|imf\.org|iso\.org|ieee\.org|acm\.org|nature\.com|science\.org|sciencedirect\.com|springer\.com|wiley\.com|arxiv\.org|nih\.gov|ncbi\.nlm\.nih\.gov|doi\.org|semanticscholar\.org|tandfonline\.com|mdpi\.com|jstor\.org|ssrn\.com)$/.test(host)) return 3;
    if (/(^|\.)(github\.com|readthedocs\.io|docs\.[a-z0-9-]+\.[a-z]+|developer\.[a-z0-9-]+\.[a-z]+|sec\.gov|reuters\.com|bloomberg\.com|ft\.com|wsj\.com|economist\.com|nikkei\.com|digitimes\.com|trendforce\.com|gartner\.com|mckinsey\.com|deloitte\.com|pwc\.com|statista\.com)$/.test(host)) return 2;
    if (/wikipedia\.org$/.test(host)) return 1;
    if (/(reddit\.com|quora\.com|medium\.com|blogspot\.|wordpress\.com|pinterest\.|zhihu\.com|csdn\.net|baijiahao|toutiao\.com|sohu\.com|163\.com|pixnet\.net|kknews|cirno)/.test(host)) return -2;
    return 0;
  }
  function isBlockedUrl(u) {
    const h = hostOf(u);
    if (!h) return true;
    if (/(^|\.)(facebook|instagram|tiktok|linkedin|pinterest|x|twitter|youtube|youtu)\.(com|be)$/.test(h)) return true;
    if (/\.(zip|rar|7z|exe|dmg|msi|mp4|mp3|avi|mov|jpg|jpeg|png|gif|webp|svg)(\?|$)/i.test(u)) return true;
    return false;
  }
  // 依網域判斷來源類型（比模型自己填的 source_kind 可靠，尤其是 Grok 常把期刊網站標成「新聞媒體」）
  function guessTypeByHost(host) {
    host = String(host || '').toLowerCase();
    if (/(^|\.)(patents\.google\.com|uspto\.gov|epo\.org|wipo\.int|patentimages\.storage\.googleapis\.com)$/.test(host)) return '官方文件';
    if (/(^|\.)(sciencedirect\.com|springer\.com|springerlink\.com|wiley\.com|acs\.org|mdpi\.com|nature\.com|science\.org|pubmed\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov|researchgate\.net|tandfonline\.com|ieee\.org|arxiv\.org|semanticscholar\.org|jstor\.org|ssrn\.com|rsc\.org|elsevier\.com|sagepub\.com|frontiersin\.org|plos\.org|doi\.org|cambridge\.org|oup\.com|iop\.org|aip\.org|scitation\.org)$/.test(host)) return '學術論文';
    if (/(^|\.)(gov|edu|mil)(\.[a-z]{2})?$/.test(host) || /(^|\.)(echa\.europa\.eu|efsa\.europa\.eu|europa\.eu|who\.int|oecd\.org|iso\.org|astm\.org|un\.org|worldbank\.org)$/.test(host) || /\.(gov|edu|ac)\.[a-z]{2}$/.test(host)) return '官方文件';
    if (/(^|\.)(zhihu\.com|reddit\.com|quora\.com|tieba\.baidu\.com|ptt\.cc|stackexchange\.com|stackoverflow\.com|dcard\.tw)$/.test(host)) return '社群論壇';
    return '';
  }
  const urlLikeTitle = (t) => !t || /^https?:\/\//i.test(String(t).trim());
  function prettyTitleFromUrl(u) {
    try {
      const x = new URL(u);
      let last = '';
      try { last = decodeURIComponent(x.pathname.split('/').filter(Boolean).pop() || ''); } catch (e) { last = x.pathname.split('/').filter(Boolean).pop() || ''; }
      last = last.replace(/\.(pdf|html?|aspx?|php)$/i, '').replace(/[-_+]+/g, ' ').trim();
      return x.hostname.replace(/^www\./, '') + (last ? ' / ' + last : '');
    } catch (e) { return String(u || ''); }
  }
  const isXUrl = (u) => /(^|\.)(x|twitter)\.com$/.test(hostOf(u));
  const isPdfUrl = (u) => /\.pdf(\?|#|$)/i.test(u || '');

  // ────────────────────────────────────────────────────────────
  // Run 上下文
  // ────────────────────────────────────────────────────────────
  const PHASES = [
    ['plan', '規劃研究計畫樹'],
    ['gather', '搜尋與爬取來源'],
    ['reflect', '反思驗證與補查'],
    ['live', '即時情報（Grok 唱反調）'],
    ['cross', '跨模型交叉審查'],
    ['write', '分章撰寫'],
    ['assemble', '組裝、引用與存檔'],
  ];

  function createRun(opts) {
    const deps = opts.deps || {};
    const preset = DEPTH_PRESETS[opts.depth] || DEPTH_PRESETS.standard;
    const cfg = Object.assign({}, preset, opts.overrides || {});
    cfg.topic = String(opts.topic || '').trim();
    const asList = (v) => uniq((Array.isArray(v) ? v : (v ? [v] : [])).map((x) => String(x || '').trim()).filter(Boolean));
    const m = opts.models || {};
    cfg.models = { planner: String(m.planner || '').trim(), writer: '', critic: '', reader: '', grok: '', grokReview: '' };
    cfg.models.writer = String(m.writer || '').trim() || cfg.models.planner;
    cfg.models.critic = String(m.critic || '').trim() || cfg.models.planner;
    const readerList = asList(m.reader); if (!readerList.length) readerList.push(cfg.models.planner);
    const searcherList = asList(m.searcher);
    cfg.pools = { reader: readerList, searcher: searcherList.length ? searcherList : readerList, grok: asList(m.grok) };
    cfg.models.reader = readerList[0];
    cfg.models.grok = cfg.pools.grok[0] || '';
    cfg.models.grokReview = String(m.grokReview || '').trim() || cfg.models.grok;
    cfg.searchStrategy = ['chain', 'parallel', 'max'].indexOf(opts.searchStrategy) !== -1 ? opts.searchStrategy : 'chain';
    cfg.useFirecrawl = opts.useFirecrawl !== false;
    cfg.useGrok = !!(opts.useGrok && cfg.pools.grok.length);
    // 並行度依模型池大小放寬（各模型額度獨立），上限刻意壓在 6：sidecar 的執行緒池有限
    cfg.readConcurrency = Math.min(6, Math.ceil(cfg.readConcurrency * (1 + 0.5 * (readerList.length - 1))));
    cfg.searchConcurrency = Math.min(5, 3 + (cfg.searchStrategy !== 'chain' ? 1 : 0) + (cfg.pools.searcher.length > 1 ? 1 : 0));
    cfg.grokConcurrency = Math.min(3, Math.max(2, cfg.pools.grok.length));
    cfg.useXSearch = opts.useXSearch !== false;
    cfg.files = Array.isArray(opts.files) ? opts.files : [];
    cfg.today = opts.today || (function () {
      const d = new Date(); const w = ['日', '一', '二', '三', '四', '五', '六'];
      return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（星期${w[d.getDay()]}）`;
    })();

    const st = {
      startedAt: Date.now(), plan: null, sources: [], sourceByUrl: new Map(), facts: [], nextSid: 1, nextFid: 1,
      candidates: new Map(), phases: {}, stats: { geminiCalls: 0, grokCalls: 0, searches: 0, pagesRead: 0, pagesFailed: 0, viaFirecrawl: 0, viaDirect: 0, viaPdf: 0, viaGrounding: 0, viaUpload: 0, retries: 0, byModel: {} },
      cooldownUntil: 0, modelCooldown: {}, poolSeq: 0, firecrawlFails: 0, firecrawlDisabled: false, logs: [], current: '', sectionsDone: 0, sectionsTotal: 0,
      callSeq: 0, lastCritic: null, conflicts: [], grokDisabled: false, extraNotes: [], readTarget: 0, readDone: 0,
    };
    PHASES.forEach(([k]) => { st.phases[k] = { s: 'pending', note: '' }; });

    const run = { deps, cfg, st };
    // 預設的睡眠是「可取消」的：每 400ms 檢查一次停止旗標，避免 429 退避睡 60 秒期間按停止卡住。
    run.sleep = deps.sleep || (async (ms) => {
      const end = Date.now() + ms;
      for (;;) {
        run.checkCancel();
        const left = end - Date.now();
        if (left <= 0) return;
        await sleepReal(Math.min(400, left));
      }
    });
    run.now = deps.now || Date.now;
    run.pools = { reader: makePool(run, 'reader', cfg.pools.reader), searcher: makePool(run, 'searcher', cfg.pools.searcher), grok: makePool(run, 'grok', cfg.pools.grok) };
    run.grokOn = () => cfg.useGrok && !st.grokDisabled;
    run.cancelled = () => !!(deps.isCancelled && deps.isCancelled());
    run.checkCancel = () => { if (run.cancelled()) throw new CancelledError(); };
    run.log = (msg) => {
      const line = `[${fmtDuration(Date.now() - st.startedAt)}] ${msg}`;
      st.logs.push(line);
      if (deps.log) { try { deps.log(line); } catch (e) { /* ignore */ } }
    };
    run.progress = () => {
      if (!deps.onProgress) return;
      try { deps.onProgress(renderProgress(run), { phases: st.phases, stats: st.stats, current: st.current, sectionsDone: st.sectionsDone, sectionsTotal: st.sectionsTotal, sourcesOk: st.sources.filter((x) => x.ok).length, facts: st.facts.length }); } catch (e) { /* ignore */ }
    };
    run.phase = (key, s, note) => { st.phases[key] = { s, note: note || st.phases[key].note || '' }; run.progress(); };
    return run;
  }

  function renderProgress(run) {
    const { st, cfg } = run;
    const icon = { pending: '⬜', running: '🔄', done: '✅', skipped: '➖', error: '⚠️' };
    const lines = [];
    lines.push(`🧠 **NOVA Pro 深度研究**｜${clip(cfg.topic, 60)}`);
    lines.push(`⏱ 已用時 ${fmtDuration(Date.now() - st.startedAt)}｜${cfg.label}`);
    lines.push('');
    PHASES.forEach(([k, label], i) => {
      const p = st.phases[k] || { s: 'pending', note: '' };
      lines.push(`${icon[p.s] || '⬜'} ${i + 1}. ${label}${p.note ? '　' + p.note : ''}`);
    });
    lines.push('');
    lines.push(`📚 已讀來源 ${st.stats.pagesRead}（失敗 ${st.stats.pagesFailed}）｜🔎 搜尋 ${st.stats.searches} 次｜🤖 Gemini ${st.stats.geminiCalls} 次${cfg.useGrok ? `｜Grok ${st.stats.grokCalls} 次` : ''}`);
    if (st.current) lines.push(`▶ ${st.current}`);
    return lines.join('\n');
  }

  // ────────────────────────────────────────────────────────────
  // LLM 呼叫封裝（含重試／429 全域冷卻）
  // ────────────────────────────────────────────────────────────
  // 每一次對外請求（LLM／搜尋／讀頁）都經過這裡回報開始與結束，讓 UI 顯示「正在等什麼、等多久」
  async function tracked(run, label, fn, model) {
    const cb = run.deps.onCall;
    const id = ++run.st.callSeq;
    if (cb) { try { cb({ id, label, event: 'start', model: model || '' }); } catch (e) { /* ignore */ } }
    try { return await fn(); }
    finally { if (cb) { try { cb({ id, label, event: 'end', model: model || '' }); } catch (e) { /* ignore */ } } }
  }

  // 冷卻「每個模型各自計算」（Gemini 的額度本來就是每個模型獨立），沒指定模型的呼叫用 '*'
  async function waitCooldown(run, model) {
    const mc = run.st.modelCooldown;
    const until = Math.max(mc[model || '*'] || 0, mc['*'] || 0);
    const d = until - Date.now();
    if (d > 0) await run.sleep(d);
  }

  // ── 模型池：挑「沒被限流、用得最少」的；限流只冷卻那一個模型；失敗太多就剔除 ──
  function makePool(run, name, models) {
    const st = run.st;
    const mk = (m) => ({ model: m, until: 0, fails: 0, uses: 0, seq: 0, dead: false, coolHits: 0 });
    const entries = uniq(models || []).map(mk);
    return {
      name, entries,
      alive() { return entries.filter((e) => !e.dead).length; },
      models() { return entries.map((e) => e.model); },
      pick() {
        const live = entries.filter((e) => !e.dead);
        if (!live.length) return null;
        const now = run.now();
        const free = live.filter((e) => e.until <= now);
        const from = (free.length ? free : live).slice();
        from.sort((a, b) => (Math.max(0, a.until - now) - Math.max(0, b.until - now)) || (a.uses - b.uses) || (a.seq - b.seq));
        const e = from[0];
        e.uses++; e.seq = ++st.poolSeq;
        e.waitMs = Math.max(0, e.until - now);
        return e;
      },
      cool(e, ms) { e.coolHits++; e.until = run.now() + (ms || [30000, 60000, 90000][Math.min(e.coolHits - 1, 2)]); },
      fail(e) { e.fails++; if (e.fails >= 2) e.dead = true; },
      ok(e) { e.fails = 0; },
      entryFor(model) { let e = entries.find((x) => x.model === model); if (!e) { e = mk(model); entries.push(e); } return e; },
    };
  }

  function classifyError(e) {
    const msg = String((e && e.message) || e || '');
    const status = e && e.status;
    const rate = status === 429 || /\b429\b|RESOURCE_EXHAUSTED|rate.?limit|quota|額度|過於頻繁/i.test(msg);
    const transient = rate || (status >= 500 && status < 600) || /timeout|逾時|ECONN|network|fetch failed|\b50[234]\b|overloaded|UNAVAILABLE|Failed to fetch|連線/i.test(msg);
    return { rate, transient, msg };
  }

  async function withRetry(run, label, fn, counter, opts) {
    opts = opts || {};
    const maxRetries = opts.maxRetries == null ? 3 : opts.maxRetries;
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      run.checkCancel();
      await waitCooldown(run, opts.model);
      try {
        run.st.stats[counter] = (run.st.stats[counter] || 0) + 1;
        if (opts.model) run.st.stats.byModel[opts.model] = (run.st.stats.byModel[opts.model] || 0) + 1;
        return await tracked(run, attempt ? `${label}（重試 ${attempt}）` : label, fn, opts.model);
      } catch (e) {
        if (isCancelErr(e)) throw new CancelledError();
        lastErr = e;
        const c = classifyError(e);
        if (c.rate && opts.failFastRate) break;                       // 模型池：限流不在原地睡，交給池改派其他模型
        if (!c.transient || attempt >= maxRetries) break;
        if (opts.noTimeoutRetry && /逾時|timeout|timed out/i.test(c.msg)) break;      // 逾時再等一次通常還是逾時，直接放棄比較省時間
        const wait = c.rate ? [12000, 30000, 60000][attempt] : [2000, 6000, 15000][attempt];
        if (c.rate) { const k = opts.model || '*'; run.st.modelCooldown[k] = Math.max(run.st.modelCooldown[k] || 0, Date.now() + wait); }
        run.st.stats.retries++;
        run.log(`⚠️ ${label} 失敗（${clip(c.msg, 70)}），${Math.round(wait / 1000)} 秒後重試 (${attempt + 1}/3)`);
        await run.sleep(wait);
      }
    }
    if (lastErr && !lastErr.rate) { try { lastErr.rate = classifyError(lastErr).rate; } catch (e2) { /* ignore */ } }
    throw lastErr;
  }

  const gemini = (run, label, o) => withRetry(run, label, () => run.deps.callGemini(Object.assign({ tag: label }, o)), 'geminiCalls', { model: o && o.model });
  const grok = (run, label, o) => withRetry(run, label, () => run.deps.callGrok(Object.assign({ tag: label }, o)), 'grokCalls', { maxRetries: 1, noTimeoutRetry: true, model: o && o.model });

  const shortModel = (m) => String(m || '').replace(/^gemini-/, '').replace(/^grok-/, '');

  // 用模型池呼叫 Gemini：單一模型時等同 gemini()；多個模型時，被限流／出錯就改派下一個模型。
  async function geminiPooled(run, label, pool, o) {
    if (pool.entries.length <= 1 && pool.alive() <= 1) return gemini(run, label, Object.assign({}, o, { model: (pool.entries[0] && pool.entries[0].model) || o.model }));
    let lastErr;
    const maxTries = pool.entries.length * 2 + 2;
    for (let i = 0; i < maxTries; i++) {
      run.checkCancel();
      const e = pool.pick();
      if (!e) break;
      if (e.waitMs > 0) { run.log(`⏳ ${pool.name} 池的模型都在冷卻，等 ${Math.ceil(e.waitMs / 1000)} 秒`); await run.sleep(e.waitMs); }
      try {
        const res = await withRetry(run, label, () => run.deps.callGemini(Object.assign({ tag: label }, o, { model: e.model })), 'geminiCalls', { maxRetries: 1, failFastRate: true, model: e.model });
        pool.ok(e);
        return res;
      } catch (err) {
        if (isCancelErr(err)) throw new CancelledError();
        lastErr = err;
        const c = classifyError(err);
        if (c.rate) { pool.cool(e); run.log(`↪️ ${e.model} 被限流，冷卻 ${Math.round((e.until - run.now()) / 1000)} 秒，改派池內其他模型`); }
        else if (/404|not found|not supported|unsupported|invalid model|is not a valid|does not exist/i.test(c.msg)) { e.dead = true; run.log(`🚫 ${e.model} 不可用（${clip(c.msg, 60)}），已從 ${pool.name} 池剔除`); }
        else { pool.fail(e); run.log(`↪️ ${e.model} 失敗（${clip(c.msg, 60)}），改派池內其他模型`); }
      }
    }
    throw lastErr || new Error(`${pool.name} 模型池沒有可用的模型`);
  }

  async function geminiJson(run, label, o, pool) {
    const call = (l, oo) => (pool ? geminiPooled(run, l, pool, oo) : gemini(run, l, oo));
    let res = await call(label, Object.assign({ json: true }, o));
    let parsed = safeJsonParse(res.text);
    if (parsed == null) {
      run.log(`⚠️ ${label} 輸出不是合法 JSON，要求重新輸出一次`);
      const o2 = Object.assign({}, o, { json: true, text: (o.text || '') + '\n\n【重要】你上一次的輸出無法被解析成 JSON。這次請「只輸出」一個合法的 JSON，不要任何說明文字、不要 Markdown 圍欄。' });
      res = await call(label + '·重試', o2);
      parsed = safeJsonParse(res.text);
    }
    return parsed;
  }

  // ────────────────────────────────────────────────────────────
  // ① Planner
  // ────────────────────────────────────────────────────────────
  function fallbackPlan(run) {
    const t = run.cfg.topic;
    const heads = [
      ['背景與發展脈絡', '說明主題的來龍去脈與現況', ['它的起源與關鍵發展節點？', '目前處於什麼階段？']],
      ['核心概念與運作機制', '拆解主題的核心原理、架構或運作方式', ['核心原理與架構為何？', '關鍵組成與流程？']],
      ['現況、主要參與者與方案比較', '盤點主要參與者/方案並做橫向比較', ['主要參與者與方案有哪些？', '各自的優勢、限制與適用情境？']],
      ['關鍵爭議、風險與限制', '呈現正反觀點、風險與尚未解決的問題', ['主要爭議與批評是什麼？', '有哪些風險或未解問題？']],
      ['趨勢展望與行動建議', '整理未來趨勢並給出可執行的建議', ['未來 1~3 年的趨勢？', '對決策者的具體建議？']],
    ];
    return {
      title: t, research_question: t, audience: '一般專業讀者', scope_notes: '（自動產生的通用章節；規劃器未能回傳有效計畫）',
      sections: heads.map(([h, p, kq], i) => ({
        heading: h, purpose: p, key_questions: kq,
        queries: [`${t} ${h}`, `${t} overview`, `${t} 最新 研究`].slice(0, run.cfg.queriesPerSection),
        needs_table: i === 2, needs_swot: false, live_signal: i === 3,
      })),
      controversies: [`${t} 的主流說法是否被高估？`],
    };
  }

  function normalizePlan(plan, run) {
    const cfg = run.cfg;
    if (!plan || !Array.isArray(plan.sections) || plan.sections.length < 2) {
      run.log('⚠️ 規劃器沒有回傳有效計畫，改用內建通用章節模板');
      plan = fallbackPlan(run);
    }
    const sections = plan.sections.slice(0, cfg.sectionsMax).map((s, i) => {
      const queries = uniq((Array.isArray(s.queries) ? s.queries : []).map((q) => String(q).trim()).filter(Boolean)).slice(0, cfg.queriesPerSection + 1);
      const kq = (Array.isArray(s.key_questions) ? s.key_questions : []).map((q) => String(q).trim()).filter(Boolean).slice(0, 5);
      const heading = String(s.heading || `章節 ${i + 1}`).trim().replace(/^第\s*[一二三四五六七八九十百零\d]+\s*(?:章|節|部分|部)\s*[：:、.．\s-]*/, '') || `章節 ${i + 1}`;
      return {
        id: 's' + (i + 1), heading, purpose: String(s.purpose || '').trim(), key_questions: kq.length ? kq : [heading],
        queries: queries.length ? queries : [`${cfg.topic} ${heading}`],
        needs_table: !!s.needs_table, needs_swot: !!s.needs_swot, live_signal: !!s.live_signal,
      };
    });
    let liveCount = 0;
    sections.forEach((s) => { if (s.live_signal) { liveCount++; if (liveCount > cfg.grokSections) s.live_signal = false; } });
    return {
      title: String(plan.title || cfg.topic).trim(), research_question: String(plan.research_question || cfg.topic).trim(),
      audience: String(plan.audience || '').trim(), scope_notes: String(plan.scope_notes || '').trim(),
      sections, controversies: (Array.isArray(plan.controversies) ? plan.controversies : []).map((c) => String(c).trim()).filter(Boolean).slice(0, 6),
    };
  }

  async function planStage(run) {
    const { cfg, st } = run;
    run.phase('plan', 'running');
    st.current = 'Planner 正在拆解研究主題…';
    run.progress();
    const filesNote = cfg.files.length ? `\n【使用者附加資料】共 ${cfg.files.length} 份（${cfg.files.map((f) => f.name).join('、')}）。請讓章節涵蓋這些資料的重點；資料摘要：\n${cfg.files.map((f) => `- ${f.name}：${clip(String(f.text || '').replace(/\s+/g, ' '), 400)}`).join('\n')}\n` : '';
    const targetTotal = Math.round((cfg.sectionChars * (cfg.sectionsMin + cfg.sectionsMax) / 2 + 2500) / 1000) * 1000;
    const system = '你是頂級智庫的「研究總監」。任務：把使用者的研究主題拆解成一份可執行、可並行的研究計畫樹（Research Plan Tree）。你只輸出一個 JSON 物件，不要任何解釋、不要 Markdown 圍欄。';
    const user = `【今天日期】${cfg.today}
【研究主題】${cfg.topic}
${filesNote}
【篇幅規格】本報告目標約 ${targetTotal} 字，正文請規劃 ${cfg.sectionsMin}～${cfg.sectionsMax} 個章節（不含「執行摘要」與「結論與建議」，這兩章由系統自動撰寫）。

【規劃原則】
1. 章節彼此互補、不重疊，由淺入深推進：背景與脈絡 → 核心架構／機制 → 現況與主要參與者／方案比較 → 關鍵爭議與風險（必須包含反方或質疑觀點）→ 趨勢與展望。只安排與主題真正相關的章節，不要硬湊。
2. 若適用，請安排：歷史沿革、核心架構或技術原理、競爭者／方案對比（needs_table=true，並在 key_questions 列出可比較的維度）、SWOT 分析（needs_swot=true）、關鍵爭議、未來趨勢與行動建議。
3. 每章 2～4 個 key_questions：具體、可以被證據回答，避免空泛。章節標題（heading）請直接寫主題，不要自帶「第一章」「第X章」之類的編號（系統會自動編號）。
4. 每章給 ${cfg.queriesPerSection} 條 queries：繁體中文與英文混合（英文通常能找到更權威的一手來源），要包含具體的實體名稱／術語／年份；分別針對不同來源類型（官方文件與白皮書、學術論文、財報與統計、產業媒體、一線使用者／從業者反饋）。
5. live_signal=true 表示這章適合用「即時社群與爭議觀點」補強（快速變動、社群討論多、爭議大），最多 ${cfg.grokSections} 章。
6. controversies：列出 3～6 個最值得「唱反調」查證的命題（例如廠商宣稱、共識看法、樂觀預測）。

【輸出 JSON 格式】
{"title":"報告標題","research_question":"一句話界定核心研究問題","audience":"目標讀者","scope_notes":"範圍與刻意排除的部分","sections":[{"heading":"章節標題","purpose":"本章要回答什麼","key_questions":["..."],"queries":["..."],"needs_table":false,"needs_swot":false,"live_signal":false}],"controversies":["..."]}`;
    let plan = null;
    try {
      plan = await geminiJson(run, 'Planner', { model: cfg.models.planner, system, text: user, maxOutputTokens: 12000, thinking: 'medium', timeoutSec: 120 });
    } catch (e) {
      if (isCancelErr(e)) throw e;
      run.log('⚠️ Planner 呼叫失敗：' + clip(e.message, 100));
    }
    st.plan = normalizePlan(plan, run);
    st.sectionsTotal = st.plan.sections.length;
    const nq = st.plan.sections.reduce((a, s) => a + s.queries.length, 0);
    run.phase('plan', 'done', `${st.plan.sections.length} 章、${nq} 條查詢`);
    run.log(`📋 研究計畫：${st.plan.title}（${st.plan.sections.length} 章、${nq} 條查詢）`);
  }

  // ────────────────────────────────────────────────────────────
  // ② Search & Browse：搜尋（Firecrawl → SerpApi → Gemini 接地）
  // ────────────────────────────────────────────────────────────
  function handleFirecrawlError(run, e) {
    const st = run.st;
    const c = classifyError(e);
    const status = e && e.status;
    if (status === 401 || /\b401\b|無效|invalid api|過期|尚未設定/i.test(c.msg)) { st.firecrawlDisabled = true; run.log('⚠️ Firecrawl Key 無效或未設定，本次改用其他管道'); return; }
    if (status === 402 || /insufficient credits|payment required|out of credits/i.test(c.msg)) { st.firecrawlDisabled = true; run.log('⚠️ Firecrawl 額度已用盡，本次改用其他管道'); return; }
    if (c.rate) {
      st.firecrawlRateHits = (st.firecrawlRateHits || 0) + 1;
      const wait = Math.min(90000, 20000 * st.firecrawlRateHits);
      st.firecrawlCooldownUntil = run.now() + wait;
      run.log(`⚠️ Firecrawl 被限流（第 ${st.firecrawlRateHits} 次），暫停 ${Math.round(wait / 1000)} 秒，期間改用其他管道`);
      if (st.firecrawlRateHits >= 6) { st.firecrawlDisabled = true; run.log('⚠️ Firecrawl 反覆被限流，本次不再使用'); }
      return;
    }
    st.firecrawlFails++;
    if (st.firecrawlFails >= 6) { st.firecrawlDisabled = true; run.log('⚠️ Firecrawl 連續失敗多次，本次不再使用'); }
  }
  const firecrawlOn = (run) => run.cfg.useFirecrawl && !run.st.firecrawlDisabled && run.deps.hasFirecrawl && run.deps.hasFirecrawl() && run.now() >= (run.st.firecrawlCooldownUntil || 0);
  // Firecrawl 同時最多 2 個請求（免費／低階方案的限流很容易被 3 條並行的搜尋＋讀頁打到）
  async function fcCall(run, fn) {
    const st = run.st;
    while ((st.fcActive || 0) >= 2) { run.checkCancel(); await sleepReal(150); }
    st.fcActive = (st.fcActive || 0) + 1;
    try { return await fn(); } finally { st.fcActive--; }
  }

  // 三個搜尋管道各自獨立，失敗回傳 []（取消例外照常往上丟）
  async function chFirecrawl(run, q) {
    const { cfg, deps } = run;
    if (!(firecrawlOn(run) && deps.firecrawlSearch)) return [];
    try {
      const r = await fcCall(run, () => tracked(run, 'Firecrawl 搜尋：' + clip(q, 22), () => deps.firecrawlSearch(q, { limit: cfg.resultsPerQuery, scrape: true })));
      return (r || []).map((x, i) => ({ url: x.url, title: x.title || '', snippet: x.description || '', markdown: x.markdown || '', via: 'firecrawl', rank: i }));
    } catch (e) { if (isCancelErr(e)) throw new CancelledError(); handleFirecrawlError(run, e); return []; }
  }
  async function chSerp(run, q) {
    const { cfg, deps } = run;
    if (!(deps.hasSerpApi && deps.hasSerpApi() && deps.serpSearch && !run.st.serpDisabled)) return [];
    try {
      const r = await tracked(run, 'SerpApi 搜尋：' + clip(q, 22), () => deps.serpSearch(q, { limit: cfg.resultsPerQuery }));
      return (r || []).map((x, i) => ({ url: x.url, title: x.title || '', snippet: x.snippet || '', markdown: '', via: 'serpapi', rank: i }));
    } catch (e) {
      if (isCancelErr(e)) throw new CancelledError();
      run.log('⚠️ SerpApi 搜尋失敗：' + clip(e.message, 80));
      if (/\b40[123]\b|金鑰|invalid|quota|limit/i.test(String(e.message)) || (e && (e.status === 401 || e.status === 403))) { run.st.serpDisabled = true; run.log('⚠️ SerpApi 金鑰無效或額度用盡，本次不再使用'); }
      return [];
    }
  }
  async function chGrounding(run, q) {
    const { cfg } = run;
    try {
      const res = await geminiPooled(run, '接地搜尋', run.pools.searcher, { model: cfg.pools.searcher[0], text: `請針對下列查詢上網搜尋，用 5～8 點條列最重要、最具體的事實（含數字、日期、來源名稱）：\n${q}`, search: true, thinking: 'minimal', maxOutputTokens: 2500, timeoutSec: 90 });
      const srcs = (res.sources || []).filter((s) => s && s.uri);
      run.st.stats.viaGrounding += srcs.length ? 1 : 0;
      return srcs.slice(0, cfg.resultsPerQuery).map((s, i) => ({ url: s.uri, title: s.title || '', snippet: clip(res.text || '', 600), markdown: '', via: 'grounding', rank: i }));
    } catch (e) { if (isCancelErr(e)) throw new CancelledError(); run.log('⚠️ 接地搜尋失敗：' + clip(e.message, 80)); return []; }
  }

  // chain：依序備援，第一個有結果就用（最省額度）。
  // parallel／max：三個管道同時搜，結果合併（多個管道都找到的網址在 addCandidates 加分）。
  async function searchQuery(run, q) {
    const { cfg } = run;
    run.checkCancel();
    run.st.stats.searches++;
    if (cfg.searchStrategy === 'chain') {
      let r = await chFirecrawl(run, q); if (r.length) return r;
      r = await chSerp(run, q); if (r.length) return r;
      return await chGrounding(run, q);
    }
    const parts = await Promise.all([chFirecrawl(run, q), chSerp(run, q), chGrounding(run, q)]);
    return parts.reduce((a, b) => a.concat(b), []);
  }

  function addCandidates(run, results, query) {
    const { st } = run;
    let added = 0;
    (results || []).forEach((r) => {
      const url = normalizeUrl(r.url);
      if (!url || isBlockedUrl(url)) return;
      if (st.sourceByUrl.has(url)) return;
      const score = (10 - Math.min(9, r.rank || 0)) + domainScore(hostOf(url)) * 1.5 + (r.markdown && r.markdown.length > 800 ? 1 : 0) + (isPdfUrl(url) ? 0.5 : 0);
      const cur = st.candidates.get(url);
      if (cur) {
        const newChannel = cur.channels.indexOf(r.via) === -1;
        if (newChannel) cur.channels.push(r.via);
        cur.score = Math.max(cur.score, score) + (newChannel ? 2 : 0.5);      // 不同搜尋管道都找到同一個網址 = 更可能是相關且重要的來源
        cur.queries.push(query); if (!cur.markdown && r.markdown) cur.markdown = r.markdown; return;
      }
      st.candidates.set(url, { url, title: r.title || '', snippet: r.snippet || '', markdown: r.markdown || '', via: r.via, channels: [r.via], score, queries: [query], origin: r.origin || 'search' });
      added++;
    });
    return added;
  }

  // ────────────────────────────────────────────────────────────
  // ② Search & Browse：讀頁（Firecrawl scrape → 直連 → PDF）
  // ────────────────────────────────────────────────────────────
  function capText(text, cap) {
    if (text.length <= cap) return text;
    const head = Math.floor(cap * 0.72), tail = cap - head;
    return text.slice(0, head) + '\n\n[…中段省略…]\n\n' + text.slice(text.length - tail);
  }

  async function fetchPage(run, url) {
    const { deps, cfg } = run;
    let firecrawlTried = false;
    const tryFirecrawl = async () => {
      if (!firecrawlOn(run) || !deps.firecrawlScrape) return null;
      firecrawlTried = true;
      try {
        const r = await fcCall(run, () => tracked(run, 'Firecrawl 讀取：' + hostOf(url), () => deps.firecrawlScrape(url)));
        if (r && r.markdown && r.markdown.length >= 300) return { text: r.markdown, title: r.title || '', via: 'firecrawl' };
      } catch (e) { if (isCancelErr(e)) throw new CancelledError(); handleFirecrawlError(run, e); }
      return null;
    };
    if (!isPdfUrl(url)) { const fc = await tryFirecrawl(); if (fc) return fc; }
    if (deps.httpGet) {
      try {
        const r = await tracked(run, '直連讀取：' + hostOf(url), () => deps.httpGet(url, { timeoutMs: 25000, maxBytes: 16 * 1024 * 1024 }));
        if (r && r.status >= 200 && r.status < 300 && r.bytes) {
          const ct = String(r.contentType || '');
          const isPdf = /pdf/i.test(ct) || isPdfUrl(url) || (r.bytes.length > 4 && r.bytes[0] === 0x25 && r.bytes[1] === 0x50 && r.bytes[2] === 0x44 && r.bytes[3] === 0x46);
          if (isPdf) {
            if (r.bytes.length > 12 * 1024 * 1024) return null;
            if (!deps.bytesToBase64) return null;
            return { pdfBase64: deps.bytesToBase64(r.bytes), title: '', via: 'pdf', finalUrl: r.finalUrl };
          }
          const decoded = decodeBytes(r.bytes, ct);
          if (/html|xml/i.test(ct) || /^\s*<(!doctype|html)/i.test(decoded)) {
            const t = htmlToText(decoded);
            if (t.text.length >= 400) return { text: t.text, title: t.title, via: 'direct', finalUrl: r.finalUrl };
          } else if (decoded.length >= 300) {
            return { text: decoded, title: '', via: 'direct', finalUrl: r.finalUrl };
          }
        }
      } catch (e) { if (isCancelErr(e)) throw new CancelledError(); }
    }
    if (isPdfUrl(url)) { const fc = await tryFirecrawl(); if (fc) return fc; }
    else if (!firecrawlTried) { const fc = await tryFirecrawl(); if (fc) return fc; }
    return null;
  }

  // ────────────────────────────────────────────────────────────
  // ② Reader：一次抽出「可引用的事實」並標記適用章節
  // ────────────────────────────────────────────────────────────
  function sectionListText(run) {
    return run.st.plan.sections.map((s) => `- ${s.id}｜${s.heading}：${s.key_questions.join('；')}`).join('\n');
  }

  function extractNumbers(s) {
    return (String(s).match(/\d[\d,.]*\d|\d/g) || []).map((n) => n.replace(/,/g, '')).filter((n) => n.replace(/\./g, '').length >= 2);
  }

  async function extractFacts(run, src, page) {
    const { cfg, st } = run;
    const secIds = st.plan.sections.map((s) => s.id);
    const system = '你是資深研究助理，負責從「單一來源」擷取可以被引用的事實。你只能根據提供的原文，不得加入你自己的背景知識或推測。你只輸出一個 JSON 物件。';
    let bodyText = '';
    let parts = null;
    if (page.pdfBase64) {
      parts = [{ inlineData: { mimeType: 'application/pdf', data: page.pdfBase64 } }];
    } else {
      bodyText = capText(page.text, cfg.pageCharCap);
    }
    const prompt = `【研究主題】${cfg.topic}
【章節清單】（請把每條事實標記它適用於哪些章節，可多個；若與所有章節都無關就不要列）
${sectionListText(run)}

【來源資訊】網址：${src.url}\n標題：${src.title || page.title || '（未知）'}\n擷取方式：${page.via}
${parts ? '（原文為附加的 PDF 文件）' : '【原文】\n<<<\n' + bodyText + '\n>>>'}

【輸出 JSON 格式】
{"title":"這份文件或文章的標題（原文看得出來才填，否則空字串）","relevance":0到10的整數（與研究主題的相關度）,"source_type":"官方文件|學術論文|產業報告|新聞媒體|廠商行銷|社群論壇|百科教學|其他","published":"發布日期或年份，不確定填 unknown","facts":[{"section_ids":["s1"],"claim":"完整、自足的一句話事實（含主詞、數字、單位、時間、條件）","data":"關鍵數據（可空字串）","quote":"原文中的逐字短句，25 字內（可空字串）","confidence":"high|medium|low"}],"caveats":"來源本身的立場偏見、限制或時效性問題（可空字串）"}

【規則】
1. 只抽取原文明確寫出的內容；原文沒有的絕對不要補。
2. 每條 claim 必須自足，讀者不看原文也能懂；語言用繁體中文（專有名詞保留原文）。
3. quote 必須是原文逐字片段，不確定就留空字串。
4. 最多 14 條，挑「最具體、最有資訊量」的（數據、機制、比較、日期、限制、爭議）；不要抽泛泛而談的敘述。
5. 若這個來源與研究主題幾乎無關，relevance 給 0～2，facts 給空陣列。`;
    const res = await geminiJson(run, 'Reader', { model: cfg.models.reader, system, text: prompt, parts, maxOutputTokens: 6000, thinking: 'minimal', timeoutSec: 120 }, run.pools.reader);
    if (!res || typeof res !== 'object') return { relevance: 0, facts: [] };
    const out = [];
    const haystack = page.text || '';
    (Array.isArray(res.facts) ? res.facts : []).slice(0, 14).forEach((f) => {
      if (!f || typeof f.claim !== 'string' || f.claim.trim().length < 8) return;
      let ids = (Array.isArray(f.section_ids) ? f.section_ids : []).map(String).filter((x) => secIds.indexOf(x) !== -1);
      if (!ids.length) return;
      let quote = typeof f.quote === 'string' ? f.quote.trim() : '';
      if (quote && haystack && !containsNormalized(haystack, quote)) quote = '';     // 對不上原文的引述丟掉
      let confidence = /^(high|medium|low)$/.test(f.confidence) ? f.confidence : 'medium';
      const data = typeof f.data === 'string' ? f.data.trim() : '';
      if (haystack) {
        const hay = haystack.replace(/,/g, '');
        const nums = extractNumbers(f.claim + ' ' + data);
        if (nums.length && nums.some((n) => hay.indexOf(n) === -1)) confidence = 'low';    // 數字在原文找不到 → 降為低信心
      }
      out.push({ sections: ids, claim: f.claim.trim(), data, quote, confidence });
    });
    return { title: typeof res.title === 'string' ? res.title.trim().slice(0, 200) : '', relevance: Math.max(0, Math.min(10, parseInt(res.relevance, 10) || 0)), srcType: String(res.source_type || '其他'), published: String(res.published || 'unknown'), caveats: String(res.caveats || ''), facts: out };
  }

  function registerFacts(run, src, extracted, origin) {
    const { st } = run;
    extracted.facts.forEach((f) => {
      st.facts.push({ fid: 'F' + (st.nextFid++), sid: src.sid, sections: f.sections, claim: f.claim, data: f.data || '', quote: f.quote || '', confidence: f.confidence, origin: origin || 'page', verdict: null, srcType: extracted.srcType || src.srcType || '其他', published: extracted.published || src.published || 'unknown' });
    });
  }

  async function readOne(run, cand) {
    const { st } = run;
    run.checkCancel();
    if (st.sourceByUrl.has(cand.url)) return st.sourceByUrl.get(cand.url);      // 並行的即時情報任務可能引用同一個網址
    const sid = 'S' + (st.nextSid++);
    const src = { sid, url: cand.url, title: cand.title || cand.url, domain: hostOf(cand.url), via: '', ok: false, srcType: '', published: '', chars: 0, origin: cand.origin || 'search', facts: 0 };
    st.sources.push(src); st.sourceByUrl.set(cand.url, src);
    st.current = `讀取：${clip(src.domain + ' ' + (cand.title || ''), 60)}`;
    let page = null;
    try {
      if (cand.markdown && cand.markdown.length >= 400) page = { text: cand.markdown, title: cand.title, via: 'firecrawl' };
      else page = await fetchPage(run, cand.url);
    } catch (e) { if (isCancelErr(e)) throw e; }
    st.readDone++;
    if (!page) { src.readErr = '無法取得內容'; st.stats.pagesFailed++; run.progress(); return src; }
    src.via = page.via; src.chars = page.text ? page.text.length : 0;
    if (page.title && urlLikeTitle(src.title)) src.title = page.title;
    // 搜尋接地給的是 Google 轉址連結，讀成功後改用最終網址當來源網址
    if (page.finalUrl && /vertexaisearch\.cloud\.google\.com|google\.com\/url/.test(src.url)) {
      const fu = normalizeUrl(page.finalUrl);
      if (fu && !/vertexaisearch\.cloud\.google\.com/.test(fu)) { src.url = fu; src.domain = hostOf(fu); st.sourceByUrl.set(fu, src); }
    }
    st.stats[page.via === 'firecrawl' ? 'viaFirecrawl' : page.via === 'pdf' ? 'viaPdf' : 'viaDirect']++;
    try {
      const ex = await extractFacts(run, src, page);
      if (urlLikeTitle(src.title) && ex.title) src.title = ex.title;
      ex.srcType = guessTypeByHost(src.domain) || ex.srcType || '其他';        // 網域比模型自己填的類型可靠
      src.srcType = ex.srcType; src.published = ex.published || ''; src.relevance = ex.relevance; src.caveats = ex.caveats;
      if (ex.relevance >= 3 && ex.facts.length) { registerFacts(run, src, ex, cand.origin === 'grok' ? 'page-verify' : 'page'); src.ok = true; src.facts = ex.facts.length; }
      else src.readErr = ex.relevance < 3 ? '與主題關聯度低' : '沒有可用事實';
      st.stats.pagesRead++;
    } catch (e) {
      if (isCancelErr(e)) throw e;
      src.readErr = '事實抽取失敗：' + clip(e.message, 60); st.stats.pagesFailed++;
    }
    run.progress();
    return src;
  }

  const okCount = (run) => run.st.sources.filter((x) => x.ok && x.via !== 'grok').length;

  // 一輪「搜尋 → 選來源 → 讀取」。budget 是「要成功讀到幾個來源」（讀不到的自動遞補下一個候選，
  // 嘗試次數上限為 budget 的 2.5 倍）。回傳這輪新增的事實數。
  async function gatherRound(run, queries, budget, label, extras) {
    const { cfg, st } = run;
    const before = st.facts.length;
    st.current = `${label}：搜尋 ${queries.length} 條查詢…`; run.progress();
    // extras：與查詢並行的額外搜尋任務（例如 Grok 偵察員）。最多多等 100 秒，慢的結果之後仍會進候選池，留給補查輪使用。
    const extraP = (extras || []).map((fn) => fn().catch((e) => { if (!isCancelErr(e)) run.log('⚠️ 額外搜尋任務失敗：' + clip(e && e.message, 80)); }));
    await mapLimit(queries, cfg.searchConcurrency, async (q) => {
      try { const r = await searchQuery(run, q); addCandidates(run, r, q); return r.length; }
      catch (e) { if (isCancelErr(e)) throw e; run.log('⚠️ 搜尋失敗：' + clip(q, 40) + '｜' + clip(e.message, 60)); return 0; }
    }, () => run.cancelled());
    if (extraP.length) {
      let tm;
      await Promise.race([Promise.all(extraP), new Promise((r) => { tm = setTimeout(r, 100000); })]);
      clearTimeout(tm);
    }
    run.checkCancel();
    const poolSize = st.candidates.size;
    const startOk = okCount(run);
    const maxAttempts = Math.ceil(budget * 2.5) + 2;
    let attempts = 0, guard = 0;
    while (attempts < maxAttempts && okCount(run) - startOk < budget && guard++ < 20) {
      run.checkCancel();
      const need = budget - (okCount(run) - startOk);
      const pool = Array.from(st.candidates.values()).sort((a, b) => b.score - a.score);
      if (!pool.length) break;
      const batch = pool.slice(0, Math.max(1, Math.min(need, maxAttempts - attempts)));
      batch.forEach((c) => st.candidates.delete(c.url));
      attempts += batch.length;
      st.readTarget += batch.length;
      await mapLimit(batch, cfg.readConcurrency, (c) => readOne(run, c), () => run.cancelled());
    }
    run.checkCancel();
    const got = okCount(run) - startOk;
    run.log(`🔎 ${label}：${queries.length} 條查詢 → 候選 ${poolSize}，嘗試讀取 ${attempts} 個、成功 ${got} 個（目標 ${budget}）`);
    return st.facts.length - before;
  }

  // 使用者上傳的檔案也當作來源（Reader 一樣抽事實，這樣統一走同一套引用機制）
  async function ingestFiles(run) {
    const { cfg, st } = run;
    for (const f of cfg.files) {
      run.checkCancel();
      const sid = 'S' + (st.nextSid++);
      const src = { sid, url: '（使用者上傳）' + f.name, title: f.name, domain: '使用者上傳', via: 'upload', ok: false, srcType: '使用者提供', published: '', chars: 0, origin: 'upload', facts: 0 };
      st.sources.push(src);
      try {
        const page = f.pdfBase64 ? { pdfBase64: f.pdfBase64, via: 'upload', title: f.name } : { text: String(f.text || ''), via: 'upload', title: f.name };
        if (!page.pdfBase64 && page.text.length < 50) { src.readErr = '內容為空'; continue; }
        src.chars = page.text ? page.text.length : 0;
        const ex = await extractFacts(run, src, page);
        src.srcType = '使用者提供';
        if (ex.facts.length) { registerFacts(run, src, Object.assign(ex, { srcType: '使用者提供' }), 'upload'); src.ok = true; src.facts = ex.facts.length; st.stats.viaUpload++; }
        else src.readErr = '沒有可用事實';
      } catch (e) { if (isCancelErr(e)) throw e; src.readErr = '讀取失敗：' + clip(e.message, 60); }
    }
  }

  // ────────────────────────────────────────────────────────────
  // 共用：證據存取
  // ────────────────────────────────────────────────────────────
  const factsForSection = (run, secId) => run.st.facts.filter((f) => f.sections.indexOf(secId) !== -1 && f.verdict !== 'reject');
  const isGrokOrigin = (f) => f.origin === 'grok' || f.origin === 'grok-counter';

  function evidenceDigest(run, perSection, perClip, totalCap, skipGrok) {
    const { st } = run;
    let out = '';
    st.plan.sections.forEach((s) => {
      let fs = factsForSection(run, s.id);
      if (skipGrok) fs = fs.filter((f) => !isGrokOrigin(f));
      out += `\n## ${s.id}｜${s.heading}\n關鍵問題：${s.key_questions.join('；')}\n已有事實 ${fs.length} 條（來源 ${uniq(fs.map((f) => f.sid)).length} 個）：\n`;
      out += fs.slice(0, perSection).map((f) => `- [${f.sid}|${f.srcType}] ${clip(f.claim, perClip)}`).join('\n') + '\n';
    });
    return clip(out, totalCap);
  }

  // ────────────────────────────────────────────────────────────
  // ③ Critic / Reflection
  // ────────────────────────────────────────────────────────────
  async function criticStage(run, round) {
    const { cfg, st } = run;
    st.current = `Critic 第 ${round} 輪：評估證據是否足夠…`; run.progress();
    const system = '你是極其嚴格的研究審稿人（Critic）。你的工作是判斷「目前蒐集到的證據，足不足以支撐一份出版級的深度報告」，並指出缺口與衝突。你只輸出一個 JSON 物件。';
    const user = `【今天日期】${cfg.today}
【研究主題】${cfg.topic}
【核心研究問題】${st.plan.research_question}

以下是各章目前蒐集到的證據摘要（每條前面是來源編號與來源類型）：
${evidenceDigest(run, 30, 110, 60000, false)}

請逐章評估：
1. score：0～10，證據是否足以回答該章的關鍵問題（有具體數據、多個獨立來源、涵蓋正反觀點才算高分；只有單一來源或只有廠商說法要扣分）。
2. missing：缺什麼？每個缺口給 1～2 條「可直接拿去搜尋」的查詢（繁中或英文，具體、含關鍵術語）。
3. conflicts：不同來源之間互相矛盾的地方（註明來源編號與各自說法）。
另外給 global_gaps：跨章節、整體層面的缺口（例如缺少一線使用者反饋、缺少最新數據、缺少反方觀點）。

【輸出 JSON】
{"sections":[{"id":"s1","score":6,"missing":[{"question":"缺什麼","queries":["查詢1","查詢2"]}],"conflicts":[{"topic":"矛盾主題","note":"S3 說…，但 S7 說…"}]}],"global_gaps":[{"question":"...","queries":["..."]}]}`;
    const res = await geminiJson(run, `Critic·第${round}輪`, { model: cfg.models.critic, system, text: user, maxOutputTokens: 9000, thinking: 'medium', timeoutSec: 120 });
    const out = { sections: [], global_gaps: [] };
    if (res && Array.isArray(res.sections)) {
      res.sections.forEach((s) => {
        if (!s || !st.plan.sections.some((x) => x.id === s.id)) return;
        out.sections.push({
          id: s.id, score: Math.max(0, Math.min(10, Number(s.score) || 0)),
          missing: (Array.isArray(s.missing) ? s.missing : []).map((m) => ({ question: String((m && m.question) || ''), queries: (Array.isArray(m && m.queries) ? m.queries : []).map(String).filter(Boolean) })),
          conflicts: (Array.isArray(s.conflicts) ? s.conflicts : []).map((c) => ({ topic: String((c && c.topic) || ''), note: String((c && c.note) || '') })).filter((c) => c.topic || c.note),
        });
      });
    }
    if (res && Array.isArray(res.global_gaps)) out.global_gaps = res.global_gaps.map((m) => ({ question: String((m && m.question) || ''), queries: (Array.isArray(m && m.queries) ? m.queries : []).map(String).filter(Boolean) }));
    // 衝突累積給撰稿用（同一章同一主題只留最新）
    out.sections.forEach((s) => s.conflicts.forEach((c) => {
      st.conflicts = st.conflicts.filter((x) => !(x.section === s.id && x.topic === c.topic));
      st.conflicts.push({ section: s.id, topic: c.topic, note: c.note });
    }));
    return out;
  }

  async function reflectStage(run) {
    const { cfg, st } = run;
    if (cfg.reflectionRounds <= 0) { run.phase('reflect', 'skipped'); return; }
    run.phase('reflect', 'running');
    const used = st.usedQueries || (st.usedQueries = new Set());
    const THRESHOLD = 7;
    let note = '';
    for (let round = 1; round <= cfg.reflectionRounds; round++) {
      run.checkCancel();
      const critic = await criticStage(run, round);
      st.lastCritic = critic;
      const weak = critic.sections.filter((s) => s.score < THRESHOLD).sort((a, b) => a.score - b.score);
      const queries = [];
      const pushQ = (q) => { const k = String(q).trim(); if (k && !used.has(k.toLowerCase()) && queries.indexOf(k) === -1 && queries.length < cfg.followupQueries) queries.push(k); };
      weak.forEach((s) => s.missing.forEach((m) => m.queries.slice(0, 2).forEach(pushQ)));
      critic.global_gaps.forEach((g) => g.queries.slice(0, 2).forEach(pushQ));
      const avg = critic.sections.length ? (critic.sections.reduce((a, s) => a + s.score, 0) / critic.sections.length).toFixed(1) : '?';
      run.log(`🧐 Critic 第 ${round} 輪：平均證據分 ${avg}/10，證據不足章節 ${weak.length} 個，補查查詢 ${queries.length} 條`);
      if (!queries.length) { note = `第 ${round} 輪判定證據充足，提前結束`; break; }
      const remaining = cfg.maxSources - okCount(run);
      if (remaining <= 0) { note = '來源額度已用完，停止補查'; break; }
      queries.forEach((q) => used.add(q.toLowerCase()));
      const added = await gatherRound(run, queries, Math.min(remaining, Math.max(4, queries.length * 2)), `補查第 ${round} 輪`);
      note = `補查 ${round} 輪（+${added} 條事實）`;
      run.phase('reflect', 'running', note);
      if (added < 3) { note += '，新增事實太少，提前結束'; break; }
    }
    run.phase('reflect', 'done', note);
  }

  // ────────────────────────────────────────────────────────────
  // ④ 即時情報（Grok）與跨模型交叉審查
  // ────────────────────────────────────────────────────────────
  const KIND_MAP = { '官方': '官方文件', '媒體': '新聞媒體', '論壇': '社群論壇', 'x貼文': '社群論壇', '部落格': '社群論壇', '其他': '其他' };
  const CONF_MAP = { high: 'high', medium: 'medium', low: 'low' };

  // entry：模型池裡的一個 Grok 模型（沒給就由池挑一個）。單一模型連續失敗 2 次就從池剔除，
  // 池裡全部剔除才停用整個 Grok（其餘流程照常）。opts.xSearch 預設跟隨設定。
  async function callGrokJson(run, label, prompt, entry, opts) {
    const { cfg, st } = run;
    opts = opts || {};
    if (st.grokDisabled) return null;
    const pool = run.pools.grok;
    const e = entry || pool.pick();
    if (!e) { st.grokDisabled = true; return null; }
    try {
      const r = await grok(run, label, { model: e.model, text: prompt, search: true, xSearch: opts.xSearch == null ? cfg.useXSearch : opts.xSearch, timeoutMs: 180000 });
      pool.ok(e);
      const parsed = safeJsonParse(r.text);
      return { parsed, citations: r.citations || [], raw: r.text, model: e.model };
    } catch (err) {
      if (isCancelErr(err)) throw err;
      pool.fail(e);
      run.log(`⚠️ ${label}（${e.model}）失敗：${clip(err.message, 100)}${e.dead ? '，已從 Grok 池剔除' : ''}`);
      if (pool.alive() === 0) { st.grokDisabled = true; run.log('⚠️ Grok 模型全部失敗，本次停用 Grok 相關步驟（其餘流程照常進行）'); }
      return null;
    }
  }

  // 「資料偵察員」（searchStrategy = max）：Grok 依章節用網頁搜尋找權威來源網址，併入候選池。
  // 只當作「找路的人」：網址仍由本引擎抓回來、Reader 用原文抽事實，不直接採信 Grok 的描述。
  async function grokScouts(run) {
    const { cfg, st } = run;
    if (!run.grokOn()) return;
    const pool = run.pools.grok;
    await mapLimit(st.plan.sections, cfg.grokConcurrency, async (sec) => {
      run.checkCancel();
      if (!run.grokOn()) return;
      const e = pool.pick(); if (!e) return;
      const prompt = `你是研究團隊的「資料偵察員」。今天是 ${cfg.today}。
【研究主題】${cfg.topic}
【負責章節】「${sec.heading}」：${sec.purpose || ''}
【關鍵問題】
${sec.key_questions.map((q) => '- ' + q).join('\n')}

請用網頁搜尋，找出最能回答這些問題的 6～8 個「權威、具體」的來源網頁（優先一手來源：官方文件與白皮書、學術論文、標準與法規、財報與統計、技術文件、一線產業報導）。
【嚴格規則】只列出你真的搜尋到的完整 https 網址，不要編造；每條附一句話說明它能回答什麼；找不到就回傳空陣列。
【輸出】只輸出一個 JSON：{"sources":[{"url":"https://...","title":"標題","why":"能回答什麼"}]}`;
      const r = await callGrokJson(run, `Grok偵察·${sec.id}`, prompt, e, { xSearch: false });
      if (!r || !r.parsed) return;
      const arr = Array.isArray(r.parsed) ? r.parsed : (Array.isArray(r.parsed.sources) ? r.parsed.sources : []);
      const n = addCandidates(run, arr.slice(0, 10).map((x, i) => ({ url: x && x.url, title: (x && x.title) || '', snippet: (x && x.why) || '', markdown: '', via: 'grok-scout', rank: i })), `Grok偵察：${sec.heading}`);
      run.log(`🛰️ Grok 偵察（${e.model}）第「${clip(sec.heading, 16)}」章：找到 ${arr.length} 個網址，新增候選 ${n} 個`);
    }, () => run.cancelled());
  }

  // 把 Grok 回傳的項目落地成「來源＋事實」。網址能讀就實際抓回來讓 Reader 用原文驗證。
  async function ingestGrokItems(run, items, origin) {
    const { st } = run;
    const clean = [];
    (items || []).slice(0, 10).forEach((it) => {
      if (!it || typeof it.claim !== 'string' || it.claim.trim().length < 8) return;
      const url = normalizeUrl(it.url);
      if (!url) return;                                  // 沒有網址 → 不採用
      clean.push({ it, url });
    });
    const toRead = uniq(clean.map((c) => c.url)).filter((u) => !st.sourceByUrl.has(u) && !isXUrl(u) && !isBlockedUrl(u)).slice(0, 10);
    await mapLimit(toRead, 2, (u) => readOne(run, { url: u, title: '', markdown: '', origin: 'grok' }), () => run.cancelled());
    const secIds = st.plan.sections.map((s) => s.id);
    let n = 0;
    clean.forEach(({ it, url }) => {
      let src = st.sourceByUrl.get(url);
      if (!src) {
        src = { sid: 'S' + (st.nextSid++), url, title: prettyTitleFromUrl(url), domain: hostOf(url), via: 'grok', ok: true, srcType: guessTypeByHost(hostOf(url)) || KIND_MAP[String(it.source_kind || '').toLowerCase()] || '社群論壇', published: String(it.recency || ''), chars: 0, origin: 'grok', facts: 0 };
        st.sources.push(src); st.sourceByUrl.set(url, src);
      }
      let ids = (Array.isArray(it.section_ids) ? it.section_ids : []).map(String).filter((x) => secIds.indexOf(x) !== -1);
      if (!ids.length) ids = secIds.slice(0, 1);
      const pageOk = !!(src.ok && src.via !== 'grok');       // 網頁有實際抓回來且抽得出原文事實，才算「有原文可比對」
      if (!src.ok) { src.ok = true; src.via = 'grok'; src.srcType = guessTypeByHost(src.domain) || src.srcType || KIND_MAP[String(it.source_kind || '').toLowerCase()] || '社群論壇'; if (urlLikeTitle(src.title)) src.title = prettyTitleFromUrl(url); }   // Grok 引用的網址本身就是這條說法的出處，即使頁面沒讀成也要能被引用
      const claim = it.claim.trim() + (it.evidence ? `（依據：${clip(String(it.evidence).trim(), 160)}）` : '');
      st.facts.push({ fid: 'F' + (st.nextFid++), sid: src.sid, sections: ids, claim, data: '', quote: '', confidence: CONF_MAP[it.confidence] || 'low', origin, verdict: null, srcType: src.srcType || '社群論壇', published: String(it.recency || src.published || 'unknown'), stance: String(it.stance || ''), pageChecked: pageOk });
      src.facts++; n++;
    });
    return n;
  }

  function grokTaskPrompt(run, task) {
    const { cfg } = run;
    return `你是「即時情報員兼唱反調的審查員（Devil's Advocate）」。今天是 ${cfg.today}。
【研究主題】${cfg.topic}
【本次任務】${task}

請使用網頁搜尋${cfg.useXSearch ? '與 X（Twitter）搜尋' : ''}，找出：
1. 一線使用者、開發者、從業者的真實反饋、抱怨與爭議點；
2. 與官方或主流說法相矛盾的證據；
3. 近 90 天內與主題相關的最新動態。

【嚴格規則】
- 只列出你在搜尋結果中「真的看到」的內容；每一條都必須附上完整、可點擊的網址；找不到就回傳空陣列，絕對不要編造。
- 社群傳言要如實標明 source_kind 與 confidence，不要包裝成事實。
- 最多 8 條，挑最有資訊量、最能挑戰主流說法的（少而精，回答越快越好）。

【章節清單】（請標記每條適用於哪些章節）
${sectionListText(run)}

【輸出】只輸出一個 JSON（可用 \`\`\`json 圍住）：
{"items":[{"section_ids":["s2"],"claim":"完整的一句話","evidence":"你看到的具體依據","url":"https://...","source_kind":"官方|媒體|論壇|X貼文|部落格|其他","stance":"支持|反對|中立","confidence":"high|medium|low","recency":"YYYY-MM 或 未知"}]}`;
  }

  async function liveStage(run) {
    const { cfg, st } = run;
    if (!cfg.useGrok) { run.phase('live', 'skipped', '未啟用 Grok'); return; }
    run.phase('live', 'running');
    const targets = [{ label: 'Grok·全域爭議', task: `針對下列命題找反面證據與社群真實反饋：\n${st.plan.controversies.map((c, i) => `${i + 1}. ${c}`).join('\n') || '（無指定，請自行找出主題最有爭議的說法）'}` }];
    st.plan.sections.filter((s) => s.live_signal).forEach((s) => targets.push({ label: `Grok·${s.id}`, task: `聚焦在章節「${s.heading}」：${s.purpose || s.key_questions.join('；')}` }));
    let total = 0;
    // 各任務互不相依，並行執行並輪流派給池內不同的 Grok 模型（原本是逐一執行，Grok 單次常要 1～3 分鐘）
    await mapLimit(targets, cfg.grokConcurrency, async (t) => {
      run.checkCancel();
      if (st.grokDisabled) return;
      const e = run.pools.grok.pick(); if (!e) return;
      st.current = `${t.label}：搜尋即時情報與反面觀點…`; run.progress();
      const r = await callGrokJson(run, t.label, grokTaskPrompt(run, t.task), e);
      if (!r || !r.parsed) return;
      const items = Array.isArray(r.parsed) ? r.parsed : r.parsed.items;
      total += await ingestGrokItems(run, items, 'grok');
      run.phase('live', 'running', `已取得 ${total} 條`);
    }, () => run.cancelled());
    run.phase('live', (st.grokDisabled && !total) ? 'error' : 'done', (st.grokDisabled && !total) ? 'Grok 不可用' : `${total} 條社群／即時觀點`);
  }

  async function crossStage(run) {
    const { cfg, st } = run;
    if (!cfg.useGrok || st.grokDisabled) { run.phase('cross', 'skipped', cfg.useGrok ? 'Grok 不可用' : '未啟用 Grok'); return; }
    run.phase('cross', 'running');
    // A. Grok 審查 Gemini 的證據（是否過度偏信官方文宣、缺少一線反饋）
    st.current = 'Grok 審查 Gemini 蒐集的證據…'; run.progress();
    const reviewPrompt = `你是「唱反調的審查員」。今天是 ${cfg.today}。另一位研究員（Gemini）為主題「${cfg.topic}」蒐集了下列證據（每條前面是來源編號與來源類型）：
${evidenceDigest(run, 12, 100, 30000, true)}

請做交叉審查：
1. 指出哪些結論可能「過度信任官方／廠商說法」、已經過時、或缺少一線反饋；
2. 對每個疑點用網頁搜尋${cfg.useXSearch ? '與 X 搜尋' : ''}找反證或不同觀點；
3. 提出最多 4 條值得補查的查詢。
【嚴格規則】只列出你真的找到、且附有完整網址的反證；找不到就回空陣列，不要編造。
【輸出】只輸出 JSON：
{"objections":[{"section_ids":["s2"],"target_sids":["S3"],"issue":"質疑點","counter_evidence":"你找到的反證（完整一句話）","url":"https://...","confidence":"high|medium|low"}],"extra_queries":["..."]}`;
    const rvEntry = (() => { const e = cfg.models.grokReview ? run.pools.grok.entryFor(cfg.models.grokReview) : null; return (e && !e.dead) ? e : run.pools.grok.pick(); })();
    const rv = await callGrokJson(run, 'Grok·交叉審查', reviewPrompt, rvEntry);
    let extraQueries = [];
    if (rv && rv.parsed && typeof rv.parsed === 'object') {
      const objs = Array.isArray(rv.parsed.objections) ? rv.parsed.objections : [];
      const items = objs.map((o) => ({ section_ids: o.section_ids, claim: `【質疑】${String(o.issue || '').trim()}——${String(o.counter_evidence || '').trim()}`, evidence: (Array.isArray(o.target_sids) && o.target_sids.length) ? `針對來源 ${o.target_sids.join('、')}` : '', url: o.url, source_kind: '其他', confidence: o.confidence, stance: '反對' })).filter((x) => x.claim.length > 12);
      await ingestGrokItems(run, items, 'grok-counter');
      extraQueries = (Array.isArray(rv.parsed.extra_queries) ? rv.parsed.extra_queries : []).map(String).filter(Boolean).slice(0, 4);
      run.log(`⚔️ Grok 交叉審查：提出 ${objs.length} 項質疑、${extraQueries.length} 條補查建議`);
    }
    // 補查（只做一輪，有重試上限）
    const used = st.usedQueries || (st.usedQueries = new Set());
    extraQueries = extraQueries.filter((q) => !used.has(q.toLowerCase()));
    const remaining = cfg.maxSources - okCount(run);
    if (extraQueries.length && remaining > 0) {
      extraQueries.forEach((q) => used.add(q.toLowerCase()));
      await gatherRound(run, extraQueries, Math.min(remaining, extraQueries.length * 2), '交叉審查補查');
    }
    // B. Gemini 審查 Grok 的說法（過濾未證實的社群傳言）
    const gf = st.facts.filter(isGrokOrigin);
    if (gf.length) {
      st.current = 'Gemini 逐條驗證 Grok 的說法…'; run.progress();
      const digest = evidenceDigest(run, 14, 100, 26000, true);
      const batches = [];
      for (let i = 0; i < gf.length; i += 25) batches.push(gf.slice(i, i + 25));
      for (const b of batches) {
        run.checkCancel();
        const list = b.map((f) => {
          const pageFacts = st.facts.filter((x) => x.sid === f.sid && x.origin === 'page-verify').slice(0, 4).map((x) => '   · ' + clip(x.claim, 110)).join('\n');
          const src = st.sources.find((s) => s.sid === f.sid);
          return `${f.fid}｜${f.origin === 'grok-counter' ? '反證' : '社群/即時'}｜${clip(f.claim, 220)}｜網址：${src ? src.url : ''}｜${f.pageChecked ? '網頁已實際抓取，原文事實如下：\n' + (pageFacts || '   （抓到頁面但沒有可用事實）') : '網頁未能抓取（可能是 X 貼文或需登入）'}`;
        }).join('\n');
        const system = '你是嚴格的事實查核員。你要過濾未經證實的社群謠言與情緒偏見，強制要求精準佐證。你只輸出一個 JSON 物件。';
        const user = `【研究主題】${cfg.topic}
【Gemini 蒐集並經原文驗證的證據摘要】
${digest}

【待查核的 Grok 說法】
${list}

對每一條給出 verdict：
- corroborated：與上方原文證據或該網頁原文事實相互印證；
- contradicted：與已驗證的證據相反或衝突（仍值得在報告中並陳，但要標明爭議）；
- unverified：合理但缺乏佐證（只能標成「社群說法，未證實」）；
- reject：明顯是謠言、情緒性發言、與主題無關、或與網頁原文不符。
【輸出 JSON】{"verdicts":[{"id":"F12","verdict":"corroborated","reason":"一句話"}]}`;
        let vr = null;
        try { vr = await geminiJson(run, 'Gemini·查核Grok', { model: cfg.models.critic, system, text: user, maxOutputTokens: 6000, thinking: 'low', timeoutSec: 120 }); }
        catch (e) { if (isCancelErr(e)) throw e; run.log('⚠️ 查核 Grok 說法失敗：' + clip(e.message, 80)); }
        const map = {};
        if (vr && Array.isArray(vr.verdicts)) vr.verdicts.forEach((v) => { if (v && v.id) map[String(v.id)] = v; });
        b.forEach((f) => {
          const v = map[f.fid];
          f.verdict = v && /^(corroborated|contradicted|unverified|reject)$/.test(v.verdict) ? v.verdict : 'unverified';
          f.verdictReason = v ? String(v.reason || '') : '';
        });
      }
      const c = (k) => gf.filter((f) => f.verdict === k).length;
      run.log(`⚖️ 查核 Grok 說法 ${gf.length} 條：佐證 ${c('corroborated')}、爭議 ${c('contradicted')}、未證實 ${c('unverified')}、剔除 ${c('reject')}`);
      run.phase('cross', 'done', `佐證 ${c('corroborated')}／爭議 ${c('contradicted')}／未證實 ${c('unverified')}／剔除 ${c('reject')}`);
    } else {
      run.phase('cross', 'done', '沒有可查核的社群說法');
    }
  }

  // ────────────────────────────────────────────────────────────
  // ⑤ Synthesizer：逐章撰寫
  // ────────────────────────────────────────────────────────────
  const WRITER_SYSTEM = `你是出版級產業研究白皮書的資深撰稿人，使用繁體中文（台灣慣用語），文風專業、客觀、有洞察，水準對標頂級智庫與 Gemini Deep Research 的深度報告。

【最高原則：證據紀律】
1. 你只能根據使用者提供的【證據包】撰寫。證據包以外的具體數據、日期、金額、人名、機構名、產品型號、事件，一律不得出現。
2. 可以做邏輯推論、比較與綜合，但推論必須明確標示（例如「據此推論」「這意味著」），且不得包裝成已證實的事實。
3. 每一個來自證據的事實，句尾標註來源，格式 [S12]；同一句有多個來源寫成 [S3][S12]。證據行開頭方括號裡若列出多個編號，代表多個來源獨立支持同一件事，引用時請全部標出，並可在文中點出「多個來源一致」。只能使用證據包裡出現過的編號，絕對不可自行創造編號，也不要輸出任何網址。
4. 標示「⚠️社群說法·未證實」的內容不得當成事實陳述，若要使用必須寫成「有社群反映…（未證實）」；標示「與其他證據相左」的內容要並陳雙方並說明差異可能的原因。
5. 來源之間有衝突時，並陳各方說法與來源，不要自己選邊；證據不足時直接寫「目前公開資料不足以…」，不要用空話填充。

【寫作品質】
- 以連貫的論述段落為主：每個論點都要走完「現象 → 機制／原因 → 證據 → 含義／限制」，不要只是把事實一條條列出來。
- 嚴禁過度條列。僅在「比較」「步驟」「清單性資訊」時使用條列或表格；比較類內容優先用 Markdown 表格。
- 專有名詞首次出現時附英文原文；數字要帶單位與時間；避免「近年來」「眾所周知」等空泛用語。
- 不要重複前面章節已經寫過的內容；需要時用「如第 N 章所述」簡短回指。
- 不要輸出前言式客套話，不要輸出「以下是…」之類的說明。
- 格式限制：不要使用 LaTeX（例如 $\\text{NO}_x$），一律寫成純文字（NOx、ΔE、CO2、mg/kg）；章節內不要使用 --- 分隔線；只用 Markdown 標題、段落、表格與必要的條列。`;

  const SUMMARY_MARK = '[[本章摘要]]';

  const claimKey = (str) => String(str).replace(/[\s，。、；：,.;:！!？?（）()「」『』"'\-—\[\]]/g, '').toLowerCase();
  // 只合併「幾乎一模一樣」的事實：正規化後相同，或其中一條完整包含另一條（例如多加了「（路透）」之類的尾巴，
  // 長度比 ≥ 0.75）。刻意不用字面相似度：像「台積電 2025 年營收 100 億」跟「聯電 2025 年營收 100 億」
  // 字面相似度高達 0.8，卻是兩件不同的事，誤併會直接丟掉資訊，比漏併（只是多佔一點 Token）嚴重得多。
  function sameClaim(ka, kb) {
    if (ka === kb) return true;
    const [sh, lg] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
    return sh.length >= 12 && lg.indexOf(sh) !== -1 && sh.length / lg.length >= 0.75;
  }

  // 證據包：依信心／來源類型排序後，把「幾乎一模一樣的事實」合併成一條（多個來源一致 = 更強的佐證，
  // 而且不會把同一句話重複塞進提示詞浪費 Token）。Grok 來源與一般來源分開合併，避免標記混在一起。
  function buildEvidencePack(run, sec) {
    const conf = { high: 3, medium: 2, low: 1 };
    const score = (f) => (conf[f.confidence] || 1) + ((f.origin === 'page' || f.origin === 'upload' || f.origin === 'page-verify') ? 1 : 0) + (f.verdict === 'corroborated' ? 1 : 0) - (isGrokOrigin(f) && f.verdict !== 'corroborated' ? 0.5 : 0) + (/官方|學術|使用者/.test(f.srcType) ? 1 : 0);
    const sorted = factsForSection(run, sec.id).slice().sort((a, b) => score(b) - score(a)).slice(0, 160);
    const groups = [];
    sorted.forEach((f) => {
      const key = claimKey(f.claim);
      const g = groups.find((x) => isGrokOrigin(x.rep) === isGrokOrigin(f) && sameClaim(x.key, key));
      if (g) { if (g.sids.indexOf(f.sid) === -1) g.sids.push(f.sid); if (!g.rep.data && f.data) g.rep.data = f.data; if (!g.rep.quote && f.quote) g.rep.quote = f.quote; }
      else groups.push({ rep: Object.assign({}, f), key, sids: [f.sid] });
    });
    let chars = 0;
    const lines = [];
    for (const g of groups.slice(0, 70)) {
      const f = g.rep;
      const flags = [];
      if (isGrokOrigin(f)) {
        if (f.verdict === 'corroborated') flags.push('社群說法·已有旁證');
        else if (f.verdict === 'contradicted') flags.push('⚠️與其他證據相左');
        else flags.push('⚠️社群說法·未證實');
      }
      if (f.confidence === 'low' && !isGrokOrigin(f)) flags.push('低信心');
      const line = `[${g.sids.join(', ')}｜${f.srcType}｜${f.published}${flags.length ? '｜' + flags.join('｜') : ''}] ${f.claim}${f.data ? '｜數據：' + f.data : ''}${f.quote ? '｜原文：「' + f.quote + '」' : ''}`;
      if (chars + line.length > 30000) break;
      lines.push(line); chars += line.length + 1;
    }
    return { text: lines.join('\n'), count: lines.length };
  }

  function stripFence(t) {
    t = String(t || '').trim();
    const m = t.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/);
    return m ? m[1].trim() : t;
  }

  function splitSummary(t) {
    const i = t.indexOf(SUMMARY_MARK);
    if (i === -1) return { body: t.trim(), summary: '' };
    return { body: t.slice(0, i).trim(), summary: t.slice(i + SUMMARY_MARK.length).replace(/\s+/g, ' ').trim() };
  }

  function normalizeHeadings(body, idx, heading) {
    const lines = body.split('\n');
    let seen = false;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(#{1,6})\s+(.*)$/);
      if (!m) continue;
      if (!seen) { lines[i] = `## ${idx + 1}. ${heading}`; seen = true; }
      else if (m[1].length <= 2) lines[i] = '### ' + m[2];
    }
    if (!seen) lines.unshift(`## ${idx + 1}. ${heading}`, '');
    return lines.join('\n');
  }

  function sectionPrompt(run, sec, idx, pack, target) {
    const { cfg, st } = run;
    const outline = st.plan.sections.map((s, i) => `${i + 1}. ${s.heading}`).join('\n');
    const prev = st.sectionResults.filter((r) => r.summary).map((r) => `- 第 ${r.idx + 1} 章「${r.heading}」：${r.summary}`).join('\n');
    const conflicts = st.conflicts.filter((c) => c.section === sec.id).map((c) => `- ${c.topic}：${c.note}`).join('\n');
    return `【今天日期】${cfg.today}
【全書主題】${cfg.topic}
【核心研究問題】${st.plan.research_question}
${st.plan.scope_notes ? '【範圍說明】' + st.plan.scope_notes + '\n' : ''}【全書章節】（本章為第 ${idx + 1} 章）
${outline}
${prev ? '\n【前面章節摘要（避免重複）】\n' + prev + '\n' : ''}
【本章任務】
標題：${sec.heading}
要回答：${sec.purpose || sec.key_questions.join('；')}
關鍵問題：
${sec.key_questions.map((q) => '- ' + q).join('\n')}
${sec.needs_table ? '本章必須包含至少一張比較表格（Markdown 表格），維度取自關鍵問題，儲存格內的事實也要標註 [S#]。\n' : ''}${sec.needs_swot ? '本章必須包含 SWOT 分析（Markdown 表格或四個小節），每一項都要有證據支撐 [S#]。\n' : ''}${conflicts ? '已知的來源衝突（請在文中並陳）：\n' + conflicts + '\n' : ''}
【證據包】共 ${pack.count} 條
${pack.text}

【篇幅與格式】
- 本章目標約 ${target} 字（中文字元，不含空白與標記），不得少於 ${Math.round(target * 0.85)} 字；但證據不足時，寧可簡短並點明資料缺口，不要灌水。
- 第一行必須是 \`## ${sec.heading}\`，內文用 \`###\` 分成 2～5 個小節。不要使用 \`#\` 標題。
- 最後另起一行，輸出 ${SUMMARY_MARK} 接著不超過 60 字的本章重點摘要（這一行不會出現在報告裡）。`;
  }

  async function callWriter(run, label, text, maxOut) {
    const { cfg } = run;
    let res = await gemini(run, label, { model: cfg.models.writer, system: WRITER_SYSTEM, text, maxOutputTokens: maxOut || 12000, thinking: 'low', timeoutSec: 120 });
    let out = String(res.text || '');
    if (res.finishReason === 'MAX_TOKENS' && out.length > 200) {
      run.log(`↪️ ${label} 被長度上限截斷，自動接續`);
      const res2 = await gemini(run, label + '·接續', { model: cfg.models.writer, system: WRITER_SYSTEM, text: `下面是一段被截斷的章節草稿。請從斷點自然接續，把這一章寫完（不要重複已寫的內容，不要重新開頭），最後仍要輸出 ${SUMMARY_MARK} 摘要行。\n\n【已寫內容】\n${out}`, maxOutputTokens: maxOut || 12000, thinking: 'low', timeoutSec: 120 });
      out += '\n' + String(res2.text || '');
    }
    return out;
  }

  async function writeSection(run, sec, idx) {
    const { cfg, st } = run;
    const pack = buildEvidencePack(run, sec);
    const result = { id: sec.id, idx, heading: sec.heading, text: '', summary: '', failed: false, chars: 0, factCount: pack.count };
    if (pack.count === 0) {
      result.text = `## ${idx + 1}. ${sec.heading}\n\n> 本章在本次研究中沒有蒐集到足夠的公開資料，因此不做推論。建議日後針對「${sec.key_questions.slice(0, 2).join('」「')}」另行補充研究。`;
      result.summary = '本章資料不足'; result.failed = true; result.chars = countChars(result.text);
      return result;
    }
    const target = pack.count < 6 ? Math.round(cfg.sectionChars * 0.6) : cfg.sectionChars;
    let raw = '';
    try {
      raw = await callWriter(run, `撰寫第${idx + 1}章`, sectionPrompt(run, sec, idx, pack, target), 12000);
    } catch (e) {
      if (isCancelErr(e)) throw e;
      run.log(`⚠️ 第 ${idx + 1} 章第一次撰寫失敗（${clip(e.message, 70)}），縮短篇幅重試`);
      try { raw = await callWriter(run, `撰寫第${idx + 1}章·縮短`, sectionPrompt(run, sec, idx, pack, Math.round(target * 0.7)), 9000); }
      catch (e2) { if (isCancelErr(e2)) throw e2; run.log(`❌ 第 ${idx + 1} 章撰寫失敗：${clip(e2.message, 90)}`); }
    }
    raw = stripFence(raw);
    if (!raw || raw.length < 80) {
      result.text = `## ${idx + 1}. ${sec.heading}\n\n> ⚠️ 本章自動撰寫失敗，證據已保留在附錄的證據清單中，可稍後重新產生。`;
      result.failed = true; result.chars = countChars(result.text);
      return result;
    }
    let { body, summary } = splitSummary(raw);
    // 太短就擴寫一輪（分階段擴展）
    if (pack.count >= 8 && countChars(body) < target * cfg.expandThreshold) {
      run.log(`📏 第 ${idx + 1} 章只有 ${countChars(body)} 字（目標 ${target}），自動擴寫一輪`);
      try {
        const exp = `下面是第 ${idx + 1} 章「${sec.heading}」的草稿（約 ${countChars(body)} 字），目標約 ${target} 字。請在「不重複、不灌水」的前提下擴寫成完整的一章：
- 補足機制解釋、數據細節、案例、比較、反例與限制，把證據包裡尚未被充分使用的事實寫進去；
- 保留原有正確內容與 [S#] 標註，不得新增證據包以外的事實；
- 格式同樣：首行 \`## ${sec.heading}\`、\`###\` 小節、結尾 ${SUMMARY_MARK} 摘要行。
輸出擴寫後「完整」的章節。

【草稿】
${body}

【證據包】
${pack.text}`;
        const raw2 = stripFence(await callWriter(run, `擴寫第${idx + 1}章`, exp, 12000));
        const sp = splitSummary(raw2);
        if (countChars(sp.body) > countChars(body) * 1.15) { body = sp.body; if (sp.summary) summary = sp.summary; }
      } catch (e) { if (isCancelErr(e)) throw e; run.log('⚠️ 擴寫失敗，保留原稿：' + clip(e.message, 70)); }
    }
    result.text = normalizeHeadings(body, idx, sec.heading);
    result.summary = summary || clip(body.replace(/^#+.*$/gm, '').replace(/\s+/g, ' ').trim(), 60);
    result.chars = countChars(result.text);
    return result;
  }

  async function writeStage(run) {
    const { st } = run;
    st.sectionResults = [];
    run.phase('write', 'running', `0/${st.plan.sections.length}`);
    for (let i = 0; i < st.plan.sections.length; i++) {
      run.checkCancel();
      const sec = st.plan.sections[i];
      st.current = `正在撰寫第 ${i + 1}/${st.plan.sections.length} 章「${clip(sec.heading, 30)}」…`;
      run.progress();
      const r = await writeSection(run, sec, i);
      st.sectionResults.push(r);
      st.sectionsDone = st.sectionResults.length;
      run.phase('write', 'running', `${st.sectionsDone}/${st.plan.sections.length}（累計約 ${st.sectionResults.reduce((a, x) => a + x.chars, 0)} 字）`);
    }
    run.phase('write', 'done', `${st.plan.sections.length} 章、約 ${st.sectionResults.reduce((a, x) => a + x.chars, 0)} 字`);
  }

  // 由整本正文產生「執行摘要」與「結論與建議」
  async function finalizeStage(run) {
    const { cfg, st } = run;
    st.current = '撰寫執行摘要與結論…'; run.progress();
    const body = st.sectionResults.map((r) => r.text).join('\n\n');
    const system = '你是首席分析師，負責替一份深度研究報告撰寫「執行摘要」與「結論與建議」。你只能使用報告正文已經出現的事實與 [S#] 來源編號，不得引入新事實。繁體中文（台灣慣用語），專業、精確、有洞察。';
    const user = `【研究主題】${cfg.topic}
【核心研究問題】${st.plan.research_question}

【報告正文】
${clip(body, 150000)}

請輸出兩個部分，中間用單獨一行 ===SPLIT=== 分隔（不要輸出其他標記或說明）：

第一部分「執行摘要」（約 700～1000 字）：
- 開頭一段直接給出核心結論（回答核心研究問題）；
- 接著 4～6 個關鍵發現，每項 1～3 句，含具體數據，沿用正文的 [S#] 標註；
- 最後一段說明對決策者的意義與最大的不確定性。

第二部分「結論與建議」（約 900～1500 字）：
- 總結論；
- 依情境或對象給出可執行的建議（可用編號清單，每項說明理由並標 [S#]）；
- 需要持續追蹤的風險與指標；
- 本研究的主要限制（例如證據薄弱的面向）。`;
    let text = '';
    try {
      const res = await gemini(run, '執行摘要與結論', { model: cfg.models.writer, system, text: user, maxOutputTokens: 9000, thinking: 'low', timeoutSec: 120 });
      text = stripFence(res.text);
    } catch (e) { if (isCancelErr(e)) throw e; run.log('⚠️ 執行摘要／結論產生失敗：' + clip(e.message, 80)); }
    const parts = text.split(/\n\s*===SPLIT===\s*\n/);
    st.execSummary = parts[0] ? parts[0].replace(/^#+\s.*\n?/, '').trim() : '';
    st.conclusion = parts[1] ? parts[1].replace(/^#+\s.*\n?/, '').trim() : '';
  }

  // ────────────────────────────────────────────────────────────
  // ⑥ 引用重新編號、組裝、附錄
  // ────────────────────────────────────────────────────────────
  const VIA_LABEL = { firecrawl: 'Firecrawl 全文', direct: '直連全文', pdf: 'PDF 全文', upload: '使用者上傳', grok: 'Grok 搜尋結果（未能抓取全文）' };

  function renumberCitations(text, okSids, order, counters) {
    const SEP = '\\s*[,，、;；]\\s*';
    text = String(text || '').replace(new RegExp('【\\s*(S\\d+(?:' + SEP + 'S\\d+)*)\\s*】', 'g'), '[$1]');
    return text.replace(new RegExp('\\[\\s*(S\\d+(?:' + SEP + 'S\\d+)*)\\s*\\]', 'g'), (m, g) => {
      const ids = g.split(new RegExp(SEP)).map((x) => x.trim());
      let nums = [];
      ids.forEach((id) => {
        if (!okSids.has(id)) { counters.unknown++; return; }
        if (!order.has(id)) order.set(id, order.size + 1);
        nums.push(order.get(id));
      });
      nums = uniq(nums).sort((a, b) => a - b);
      counters.total += nums.length;
      return nums.length ? '[' + nums.join(', ') + ']' : '';
    });
  }

  function methodSection(run, order) {
    const { st, cfg } = run;
    const s = st.stats;
    const gf = st.facts.filter(isGrokOrigin);
    const cnt = (k) => gf.filter((f) => f.verdict === k).length;
    const thin = st.plan.sections.filter((x) => factsForSection(run, x.id).length < 4).map((x) => x.heading);
    const gaps = [];
    if (st.lastCritic) {
      st.lastCritic.sections.filter((x) => x.score < 7).forEach((x) => {
        const sec = st.plan.sections.find((y) => y.id === x.id);
        if (!sec) return;
        const n = factsForSection(run, sec.id).length;
        if (n >= 12) return;      // Critic 是在 Grok 證據進來之前評分的；現在證據已經夠多的章節不再列為缺口
        gaps.push(`「${sec.heading}」（補查前評估 ${x.score}/10，目前實際證據 ${n} 條）：${x.missing.map((m) => m.question).filter(Boolean).slice(0, 2).join('；') || '證據仍偏薄'}`);
      });
    }
    const lines = [];
    lines.push('## 研究方法與限制', '');
    lines.push(`- **蒐集方式**：由規劃器把主題拆成 ${st.plan.sections.length} 個章節與 ${st.plan.sections.reduce((a, x) => a + x.queries.length, 0)} 條起始查詢，共執行 ${s.searches} 次搜尋；成功讀取 ${s.pagesRead} 個來源（Firecrawl ${s.viaFirecrawl}、直連 ${s.viaDirect}、PDF ${s.viaPdf}${s.viaUpload ? '、使用者上傳 ' + s.viaUpload : ''}），另有 ${s.pagesFailed} 個來源無法讀取或抽取失敗。`);
    const bm = st.stats.byModel || {};
    const usage = Object.keys(bm).sort((a, b) => bm[b] - bm[a]).map((k) => `${k}×${bm[k]}`).join('、');
    const stratLabel = { chain: '依序備援', parallel: '平行多管道', max: '全力（平行多管道＋Grok 偵察）' }[cfg.searchStrategy];
    lines.push(`- **模型分工**：規劃 ${cfg.models.planner}、撰稿 ${cfg.models.writer}、審稿與查核 ${cfg.models.critic}；讀取池 ${cfg.pools.reader.join('／')}${cfg.pools.searcher.join() !== cfg.pools.reader.join() ? '；搜尋池 ' + cfg.pools.searcher.join('／') : ''}${cfg.useGrok ? '；Grok 池 ' + cfg.pools.grok.join('／') + (cfg.models.grokReview ? '（交叉審查 ' + cfg.models.grokReview + '）' : '') : ''}；搜尋策略：${stratLabel}。實際呼叫次數：${usage || '無'}。`);
    lines.push(`- **證據處理**：每個來源由 Reader 逐條抽取「可引用的事實」，引述會回頭比對原文（對不上者捨棄），數字在原文找不到者降為低信心；報告只使用這些事實，文內以 [n] 標註來源。`);
    lines.push(`- **反思與補查**：${cfg.reflectionRounds > 0 ? '由 Critic 逐章評估證據是否足夠，並針對缺口補查（最多 ' + cfg.reflectionRounds + ' 輪，資料充足或新增事實過少時提前結束）。' : '本次未啟用反思補查。'}`);
    if (cfg.useGrok) lines.push(`- **異構交叉審查**：Grok 負責即時社群與反面觀點，Gemini 負責原文佐證與過濾；共收錄社群／即時說法 ${gf.length} 條（已有旁證 ${cnt('corroborated')}、與其他證據相左 ${cnt('contradicted')}、未證實 ${cnt('unverified')}，另剔除 ${cnt('reject')} 條）。未證實者在正文中一律標示為社群說法。`);
    else lines.push('- **異構交叉審查**：本次未啟用 Grok，僅由 Gemini 單一模型完成蒐集與審查，可能較偏向官方與主流媒體觀點。');
    if (thin.length) lines.push(`- **證據較薄弱的章節**：${thin.join('、')}。這些章節的結論請保守看待。`);
    if (gaps.length) { lines.push('- **審稿時指出、補查後仍可能不足的缺口**（Critic 在補查前評分，括號內為目前實際證據數）：'); gaps.forEach((g) => lines.push(`  - ${g}`)); }
    lines.push('- **免責聲明**：本報告由 AI 依公開資料自動蒐集、查核與撰寫，可能有遺漏或誤讀；涉及重大決策（投資、醫療、法律、採購等）前，請對照文末列出的原始來源自行確認。');
    return lines.join('\n');
  }

  function assembleReport(run, opts) {
    opts = opts || {};
    const { st, cfg } = run;
    const order = new Map();
    const counters = { unknown: 0, total: 0 };
    const okSids = new Set(st.sources.filter((x) => x.ok).map((x) => x.sid));
    const rn = (t) => renumberCitations(t, okSids, order, counters);

    const secs = st.sectionResults || [];
    const parts = [];
    let exec = '', concl = '';
    if (!opts.partial) { exec = rn(st.execSummary || ''); }
    const bodies = secs.map((r) => rn(r.text));
    if (!opts.partial) { concl = rn(st.conclusion || ''); }

    const bodyChars = secs.reduce((a, r) => a + countChars(r.text), 0) + countChars(exec) + countChars(concl);
    const title = st.plan ? st.plan.title : cfg.topic;
    const meta = `> 研究主題：${cfg.topic}｜產出日期：${cfg.today}｜正文約 ${bodyChars.toLocaleString('en-US')} 字｜引用來源 ${order.size} 個（另讀取 ${st.stats.pagesRead} 個）｜引擎：NOVA Pro Deep Research v${VERSION}`;
    parts.push(`# ${title}`, '', meta, '');
    if (opts.partial) parts.push(`> ⚠️ **這是中途停止的部分結果**（${opts.reason || '使用者停止或發生錯誤'}）：僅包含已完成的 ${secs.length} 章，沒有執行摘要與結論。`, '');
    const toc = [];
    if (exec) toc.push('執行摘要');
    secs.forEach((r) => toc.push(`${r.idx + 1}. ${r.heading}`));
    if (concl) toc.push('結論與建議');
    toc.push('研究方法與限制', '參考來源');
    parts.push('**目錄**：' + toc.join(' ｜ '), '');
    if (exec) parts.push('## 執行摘要', '', exec, '');
    bodies.forEach((b) => parts.push(b, ''));
    if (concl) parts.push('## 結論與建議', '', concl, '');
    parts.push(methodSection(run, order), '');
    parts.push('## 參考來源', '');
    const bySid = new Map(st.sources.map((x) => [x.sid, x]));
    const refs = Array.from(order.entries()).sort((a, b) => a[1] - b[1]);
    if (!refs.length) parts.push('（本報告沒有可標註的來源）');
    refs.forEach(([sid, n]) => {
      const s = bySid.get(sid); if (!s) return;
      const pub = s.published && s.published !== 'unknown' ? `｜${s.published}` : '';
      const ttl = urlLikeTitle(s.title) ? prettyTitleFromUrl(s.url) : s.title;
      // 網址一律放在整行最後、前面用半形空白隔開、後面不接任何字：全形括號等標點緊貼在網址後面，
      // Markdown／App 的自動連結會把它們算進網址，點開就是壞的。
      parts.push(`- **[${n}]** ${clip(ttl, 120)} — ${s.domain}｜${s.srcType || '其他'}${pub}｜擷取：${VIA_LABEL[s.via] || s.via || '未知'} ${s.url}`);
    });
    const used = new Set(refs.map((r) => r[0]));
    const readNotCited = st.sources.filter((x) => x.ok && !used.has(x.sid)).length;
    if (readNotCited) parts.push('', `> 另有 ${readNotCited} 個已讀取的來源提供了背景理解，但沒有被正文直接引用；詳見證據附錄。`);
    return { markdown: parts.join('\n').replace(/\n{3,}/g, '\n\n'), chars: bodyChars, cited: order.size, unknownCitations: counters.unknown, order };
  }

  function buildEvidenceAppendix(run, report) {
    const { st, cfg } = run;
    const L = [];
    L.push(`# 證據附錄｜${cfg.topic}`, '', `產出日期：${cfg.today}｜引擎 NOVA Pro Deep Research v${VERSION}`, '');
    L.push('## 來源清單（S 編號＝引擎內部編號；報告中的 [n] 依首次出現順序重新編號）', '');
    L.push('| S | 報告編號 | 標題 | 網域 | 類型 | 發布 | 擷取 | 事實數 | 狀態 | 網址 |', '|---|---|---|---|---|---|---|---|---|---|');
    st.sources.forEach((s) => {
      const n = report && report.order && report.order.get(s.sid);
      const ttl = urlLikeTitle(s.title) ? prettyTitleFromUrl(s.url) : s.title;
      L.push(`| ${s.sid} | ${n || ''} | ${clip(String(ttl || '').replace(/\|/g, '/'), 60)} | ${s.domain} | ${s.srcType || ''} | ${s.published || ''} | ${VIA_LABEL[s.via] || s.via || ''} | ${s.facts || 0} | ${s.ok ? 'OK' : (s.readErr || '未使用')} | ${s.url} |`);
    });
    L.push('', '## 各章證據（引擎抽取的事實）', '');
    st.plan.sections.forEach((sec) => {
      L.push(`### ${sec.id}｜${sec.heading}`, '');
      factsForSection(run, sec.id).forEach((f) => {
        const tag = isGrokOrigin(f) ? `〔${f.origin === 'grok-counter' ? 'Grok反證' : 'Grok'}·${f.verdict || '未判定'}〕` : '';
        L.push(`- [${f.sid}] ${tag}${f.claim}${f.data ? '｜數據：' + f.data : ''}${f.quote ? '｜原文：「' + f.quote + '」' : ''}｜信心：${f.confidence}`);
      });
      L.push('');
    });
    if (st.conflicts.length) { L.push('## Critic 標出的來源衝突', ''); st.conflicts.forEach((c) => L.push(`- (${c.section}) ${c.topic}：${c.note}`)); L.push(''); }
    L.push('## 執行紀錄', '', '```', ...st.logs, '```');
    return L.join('\n');
  }

  async function saveOutputs(run, report, partial) {
    const { deps, cfg } = run;
    const d = new Date(); const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
    const base = `NovaResearch/${stamp}_${slugify(cfg.topic)}${partial ? '_部分' : ''}`;
    const saved = { report: '', evidence: '' };
    if (!deps.saveFile) return saved;
    try { await deps.saveFile(base + '.md', report.markdown); saved.report = base + '.md'; } catch (e) { run.log('⚠️ 存檔（報告）失敗：' + clip(e.message, 80)); }
    try { await deps.saveFile(base + '_證據附錄.md', buildEvidenceAppendix(run, report)); saved.evidence = base + '_證據附錄.md'; } catch (e) { run.log('⚠️ 存檔（證據附錄）失敗：' + clip(e.message, 80)); }
    return saved;
  }

  // ────────────────────────────────────────────────────────────
  // 對外：run()
  // ────────────────────────────────────────────────────────────
  async function runResearch(opts) {
    const R = createRun(opts);
    const { st, cfg } = R;
    let cancelled = false, error = null;
    // 給 UI 的「強制結束」用：不等引擎收尾，立刻拿目前已完成章節組成的部分報告（沒有任何章節時回傳 null）
    if (opts.control) {
      opts.control.snapshot = () => {
        try {
          if (!st.plan || !st.sectionResults || !st.sectionResults.length) return null;
          const rep = assembleReport(R, { partial: true, reason: '強制結束' });
          return { markdown: rep.markdown, chars: rep.chars, cited: rep.cited, evidence: buildEvidenceAppendix(R, rep) };
        } catch (e) { return null; }
      };
    }
    try {
      if (!cfg.topic && !cfg.files.length) throw new Error('缺少研究主題');
      if (!cfg.topic) cfg.topic = '綜合分析使用者提供的資料，並延伸做深度研究';
      await planStage(R);

      R.phase('gather', 'running');
      st.usedQueries = new Set();
      await ingestFiles(R);
      const firstQueries = uniq(st.plan.sections.reduce((a, s) => a.concat(s.queries), []));
      firstQueries.forEach((q) => st.usedQueries.add(q.toLowerCase()));
      const budget = Math.max(4, Math.ceil(cfg.maxSources * 0.65));
      const extras = (cfg.searchStrategy === 'max' && R.grokOn()) ? [() => grokScouts(R)] : [];
      await gatherRound(R, firstQueries, budget, '初始蒐集', extras);
      R.phase('gather', 'done', `讀取 ${st.stats.pagesRead} 個來源、${st.facts.length} 條事實`);
      if (st.facts.length < 3 && !cfg.files.length) throw new Error('幾乎沒有蒐集到任何資料（請檢查網路、Firecrawl／SerpApi／Gemini 金鑰與額度），已中止以避免產出空洞報告');

      // Gemini 的反思補查與 Grok 的即時情報互不相依，同時進行（Grok 單次呼叫常要一兩分鐘，
      // 原本先後執行會讓總時間直接相加）。任何一邊被停止就以停止為準。
      const par = await Promise.allSettled([reflectStage(R), liveStage(R)]);
      const cancelRej = par.find((x) => x.status === 'rejected' && isCancelErr(x.reason));
      if (cancelRej) throw cancelRej.reason;
      const otherRej = par.find((x) => x.status === 'rejected');
      if (otherRej) throw otherRej.reason;
      await crossStage(R);
      await writeStage(R);
      await finalizeStage(R);

      R.phase('assemble', 'running');
      st.current = '組裝報告、重新編號引用…'; R.progress();
      const report = assembleReport(R, {});
      if (report.unknownCitations) R.log(`🧹 已移除 ${report.unknownCitations} 個無效的引用編號`);
      const saved = await saveOutputs(R, report, false);
      R.phase('assemble', 'done', `約 ${report.chars.toLocaleString('en-US')} 字、引用 ${report.cited} 個來源`);
      st.current = '';
      R.progress();
      return { ok: true, markdown: report.markdown, evidence: buildEvidenceAppendix(R, report), chars: report.chars, cited: report.cited, saved, stats: st.stats, elapsedMs: Date.now() - st.startedAt, logs: st.logs };
    } catch (e) {
      if (isCancelErr(e)) cancelled = true; else { error = e; R.log('❌ ' + (e && e.message)); }
    }
    // 中止或錯誤：有已完成的章節就盡量保留
    const out = { ok: false, cancelled, error: error ? String(error.message || error) : '', stats: st.stats, elapsedMs: Date.now() - st.startedAt, logs: st.logs, markdown: '', evidence: '', saved: { report: '', evidence: '' } };
    try {
      if (st.plan && st.sectionResults && st.sectionResults.length) {
        const report = assembleReport(R, { partial: true, reason: cancelled ? '使用者按下停止' : '執行中發生錯誤' });
        out.markdown = report.markdown; out.chars = report.chars; out.cited = report.cited;
        out.evidence = buildEvidenceAppendix(R, report);
        out.saved = await saveOutputs(R, report, true);
      } else if (st.plan && st.facts.length) {
        out.evidence = buildEvidenceAppendix(R, null);
        const d = new Date(); const p = (n) => String(n).padStart(2, '0');
        const path = `NovaResearch/${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}_${slugify(cfg.topic)}_證據附錄_未完成.md`;
        if (R.deps.saveFile) { try { await R.deps.saveFile(path, out.evidence); out.saved.evidence = path; } catch (e2) { /* ignore */ } }
      }
    } catch (e3) { /* 保底，不再拋錯 */ }
    return out;
  }

  // ────────────────────────────────────────────────────────────
  // 預估（給 UI 顯示，粗估）
  // ────────────────────────────────────────────────────────────
  function estimate(depthKey, o) {
    o = o || {};
    const p = DEPTH_PRESETS[depthKey] || DEPTH_PRESETS.standard;
    const strat = ['chain', 'parallel', 'max'].indexOf(o.searchStrategy) !== -1 ? o.searchStrategy : 'chain';
    const nR = Math.max(1, o.readerPoolSize || 1), nG = Math.max(1, o.grokPoolSize || 1);
    const secs = (p.sectionsMin + p.sectionsMax) / 2;
    const searches = Math.round(secs * p.queriesPerSection + p.followupQueries * p.reflectionRounds * 0.7);
    const reads = p.maxSources;
    const readConc = Math.min(6, Math.ceil(p.readConcurrency * (1 + 0.5 * (nR - 1))));
    const searchConc = Math.min(5, 3 + (strat !== 'chain' ? 1 : 0));
    const grokConc = Math.min(3, Math.max(2, nG));
    const scouts = (strat === 'max' && o.useGrok) ? Math.round(secs) : 0;
    const grokLive = o.useGrok ? 1 + p.grokSections : 0;
    const grokCalls = grokLive + scouts + (o.useGrok ? 1 : 0);
    const groundingCalls = strat === 'chain' ? ((o.hasFirecrawl || o.hasSerpApi) ? 0 : searches) : searches;
    const gemini = 1 + reads + p.reflectionRounds + Math.round(secs * 1.3) + 2 + (o.useGrok ? 1 : 0) + groundingCalls;
    const tSearch = (searches * 8) / searchConc, tRead = (reads * 18) / readConc, tReflect = p.reflectionRounds * 40;
    const tLive = grokLive ? Math.ceil(grokLive / grokConc) * 90 : 0;
    const tScout = scouts ? Math.min(100, Math.ceil(scouts / grokConc) * 90) : 0;
    const tCross = o.useGrok ? 120 : 0;
    const sec = tSearch + tScout + tRead + Math.max(tReflect, tLive) + tCross + secs * 65 + 60;     // 反思補查與即時情報是同時進行的
    const minM = Math.max(3, Math.round(sec / 60));
    return { sections: Math.round(secs), sources: reads, searches, geminiCalls: gemini, grokCalls, minMinutes: minM, maxMinutes: Math.round(minM * 1.8), approxChars: Math.round((p.sectionChars * secs + 2500) / 1000) * 1000, readConcurrency: readConc };
  }

  const api = {
    version: VERSION, DEPTH_PRESETS, run: runResearch, estimate,
    _t: { makePool, addCandidates, buildEvidencePack, guessTypeByHost, prettyTitleFromUrl, urlLikeTitle, handleFirecrawlError, assembleReport, safeJsonParse, htmlToText, decodeBytes, normalizeUrl, renumberCitations, containsNormalized, mapLimit, domainScore, isBlockedUrl, normalizePlan, createRun, extractNumbers, capText, countChars, fmtDuration, slugify },
  };
  root.NovaDeepResearch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

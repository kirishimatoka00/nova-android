/* [NOVA Android] nova-meeting.js — 由 NOVA Desktop 同名檔案原樣移植（純邏輯、不碰 DOM／appState，行為與桌面版一致）。
   Android 移植版本紀錄：v1.0.0-android.1 - 批次 4 初次移植，內容未修改。 */
/* ═══════════════════════════════════════════════════════════════════
 * nova-meeting.js  v1.0.0  —  多專家會議引擎（純邏輯，不碰 DOM）
 * 最後更新：2026-10-10
 *
 * 版本紀錄：
 *   v1.0.0 (2026-10-10) 初版。多位專家（名稱可任意命名）在同一個對話框裡像開會一樣跟使用者討論：
 *     ・每次使用者發言 → 挑出這一輪要發言的專家（優先看使用者有沒有 @ 點名；沒有點名就由「主持人」挑，
 *       主持人失敗或設為「全員」時照名單順序）→ 專家依序發言，後發言的人看得到本輪前面專家說了什麼，
 *       可同意、質疑、補充、@ 其他專家。可設定每輪討論 1～3 回合（第 2 回合起專家可以回覆「（無補充）」略過）。
 *     ・使用者說「請總結」（或按總結鈕）→ 總結模型依整場討論的逐字紀錄產出固定章節的總結報告。
 *     ・每位專家可帶自己的知識庫範圍（沿用 nova-experts.js 的專家定義：角色、專業知識、kb 範圍、模型、是否上網）。
 *
 * 用法（index.html 膠水層）：
 *   window.NovaMeeting.runTurn({ userText, participants, transcript, settings, deps })
 *   window.NovaMeeting.summarize({ topic, participants, transcript, settings, deps })
 *   deps: callModel({model,system,text,json,search,thinking,maxOutputTokens,tag}) → Promise<{text,sources?}>
 *         kbRetrieve(query,{docTypes,folderIds,docIds,topK}) → Promise<{items:[{docName,docType,text}]}>
 *         resolveModel(name)、defaultModel、isCancelled()、onSpeaker(speaker,text,meta)、onStatus(text)
 *   transcript 項目：{ role:'user'|'expert', name, text, expertId? }
 * ═══════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';
  var API = {};

  var DEFAULTS = {
    speakerMode: 'auto',     // auto＝主持人挑 1～maxSpeakers 位；all＝全員依序發言
    maxSpeakers: 3,          // auto 時每回合最多幾位發言（1–8）
    rounds: 1,               // 每次使用者發言後討論幾回合（1–3）
    length: 'medium',        // short｜medium｜long
    useKb: true,
    topK: 4,
    historyChars: 14000,     // 帶給模型的討論紀錄字數上限（超過就丟最舊的）
    models: { moderator: '', speaker: '', summarizer: '' }
  };
  API.DEFAULTS = DEFAULTS;

  function clampInt(v, lo, hi, d) { v = parseInt(v, 10); if (isNaN(v)) return d; return Math.max(lo, Math.min(hi, v)); }
  function normalizeSettings(s) {
    s = s || {}; var m = s.models || {};
    return {
      speakerMode: s.speakerMode === 'all' ? 'all' : 'auto',
      maxSpeakers: clampInt(s.maxSpeakers, 1, 8, DEFAULTS.maxSpeakers),
      rounds: clampInt(s.rounds, 1, 3, DEFAULTS.rounds),
      length: ['short', 'medium', 'long'].indexOf(s.length) >= 0 ? s.length : DEFAULTS.length,
      useKb: s.useKb !== false,
      topK: clampInt(s.topK, 1, 12, DEFAULTS.topK),
      historyChars: clampInt(s.historyChars, 2000, 60000, DEFAULTS.historyChars),
      models: { moderator: String(m.moderator || ''), speaker: String(m.speaker || ''), summarizer: String(m.summarizer || '') }
    };
  }
  API.normalizeSettings = normalizeSettings;

  // ── 小工具 ──
  var LEN_HINT = { short: '每次發言 100 字內', medium: '每次發言 200 字內', long: '每次發言 400 字內' };
  var LEN_TOKENS = { short: 700, medium: 1200, long: 2200 };

  function checkCancel(deps) { if (deps && deps.isCancelled && deps.isCancelled()) { var e = new Error('cancelled'); e.cancelled = true; throw e; } }
  function norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ''); }

  // 偵測「請總結」類指令：短句、含總結／結案／結束會議等字樣，且不像是在問某個具體問題
  API.isSummaryCommand = function (text) {
    var t = String(text || '').trim();
    if (!t || t.length > 40) return false;
    if (/[?？]\s*$/.test(t) && !/(總結|結論)嗎|可以.*總結/.test(t)) return false;
    return /(總結|做結論|出結論|下結論|結案|結束會議|散會|summar(y|ize)|wrap\s*up)/i.test(t);
  };

  // 名稱去重（兩位專家取同名時，後者加 2、3…），回傳新陣列（含 displayName）
  API.withDisplayNames = function (participants) {
    var seen = {};
    return (participants || []).map(function (p) {
      var base = String(p.name || '未命名').trim() || '未命名', n = base, i = 2;
      while (seen[norm(n)]) { n = base + i; i++; }
      seen[norm(n)] = 1;
      return Object.assign({}, p, { displayName: n });
    });
  };

  // 找出使用者訊息裡被點名的成員（@名字 或 直接寫出完整名稱；名字至少 2 字才比對完整名稱，避免誤判）
  API.findMentioned = function (text, participants) {
    var t = String(text || ''), tl = t.toLowerCase(), out = [];
    var list = API.withDisplayNames(participants);
    list.forEach(function (p) {
      var nm = p.displayName.toLowerCase();
      var hit = tl.indexOf('@' + nm) >= 0 || (nm.length >= 2 && tl.indexOf(nm) >= 0);
      if (!hit) { // 也接受 @ 後面接名稱的前綴（如 @文獻 對應「文獻研究員」），前綴至少 2 字
        var re = /@([^\s@，。！？,.!?:：;；]{2,20})/g, m;
        while ((m = re.exec(t))) { var q = m[1].toLowerCase(); if (nm.indexOf(q) === 0 || q.indexOf(nm) === 0) { hit = true; break; } }
      }
      if (hit) out.push(p);
    });
    return out;
  };

  // 討論紀錄 → 文字（超過字數上限就丟最舊的，並註明）
  API.transcriptToText = function (transcript, budget) {
    var lines = (transcript || []).map(function (m) {
      return (m.role === 'user' ? '【使用者】' : m.role === 'note' ? '【背景】' : '【' + (m.name || '專家') + '】') + String(m.text || '').trim();
    });
    var total = 0, keep = [];
    for (var i = lines.length - 1; i >= 0; i--) {
      if (total + lines[i].length > budget && keep.length) { keep.unshift('（較早的討論已省略）'); break; }
      keep.unshift(lines[i].length > budget ? lines[i].slice(0, budget) : lines[i]); total += lines[i].length;
    }
    return keep.join('\n\n');
  };

  function stripSelfPrefix(text, name) {
    var t = String(text || '').trim();
    var esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp('^(?:\\*\\*)?[【\\[(（]?\\s*' + esc + '\\s*[】\\])）]?(?:\\*\\*)?\\s*[:：]\\s*', 'i'), '');
    return t.trim();
  }
  API._stripSelfPrefix = stripSelfPrefix;

  function parseJson(text) {
    var t = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    try { return JSON.parse(t); } catch (e) { /* fallthrough */ }
    var a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e2) { /* ignore */ } }
    return null;
  }

  function modelFor(deps, key, settings, expert) {
    var pick = (expert && expert.model) || (settings.models && settings.models[key]) || '';
    return deps.resolveModel ? deps.resolveModel(pick) : (pick || deps.defaultModel);
  }

  // ── 選出本輪發言者 ──
  async function selectSpeakers(args) {
    var plist = args.participants, settings = args.settings, deps = args.deps, text = args.userText;
    var notes = [];
    var mentioned = API.findMentioned(text, plist);
    if (mentioned.length) return { speakers: mentioned, how: 'mention', notes: notes };
    if (settings.speakerMode === 'all' || plist.length <= 1) return { speakers: plist.slice(), how: 'all', notes: notes };
    // 主持人挑人
    try {
      var roster = plist.map(function (p, i) { return (i + 1) + '. ' + p.displayName + '：' + String(p.role || '').replace(/\s+/g, ' ').slice(0, 120); }).join('\n');
      var sys = '你是一場多專家討論會議的主持人，只負責決定這一輪該由哪些與會者發言，不要自己回答問題。';
      var user = '【與會者】\n' + roster + '\n\n【目前的討論】\n' + API.transcriptToText(args.transcript, 4000) +
        '\n\n【使用者最新發言】\n' + text +
        '\n\n請挑出最適合回應的與會者（最多 ' + settings.maxSpeakers + ' 位，依發言順序排列；與主題無關的不要挑）。只輸出 JSON：' +
        '{"speakers":["與會者名稱",...],"reason":"一句話理由"}';
      var r = await deps.callModel({ model: modelFor(deps, 'moderator', settings), system: sys, text: user, json: true, thinking: 'minimal', maxOutputTokens: 600, tag: '主持人' });
      var j = parseJson(r && r.text), out = [];
      if (j && Array.isArray(j.speakers)) {
        j.speakers.forEach(function (nm) {
          var k = norm(nm);
          var hit = plist.filter(function (p) { return norm(p.displayName) === k; })[0] ||
            plist.filter(function (p) { return norm(p.displayName).indexOf(k) >= 0 || (k && k.indexOf(norm(p.displayName)) >= 0); })[0];
          if (hit && out.indexOf(hit) < 0) out.push(hit);
        });
      }
      if (out.length) return { speakers: out.slice(0, settings.maxSpeakers), how: 'moderator', notes: notes, reason: j && j.reason };
      notes.push('主持人沒有挑出有效人選，改為依名單順序');
    } catch (e) {
      if (e && e.cancelled) throw e;
      notes.push('主持人挑人失敗（' + ((e && e.message) || e) + '），改為依名單順序');
    }
    return { speakers: plist.slice(0, settings.maxSpeakers), how: 'fallback', notes: notes };
  }
  API._selectSpeakers = selectSpeakers;

  function evidenceBlock(items) {
    if (!items || !items.length) return '（沒有檢索到相關的知識庫資料）';
    return items.map(function (it, i) {
      return '[資料' + (i + 1) + '｜' + (it.docName || '未命名') + (it.docType ? '｜' + it.docType : '') + ']\n' + String(it.text || '').slice(0, 900);
    }).join('\n\n');
  }

  function speakerSystem(p, plist, settings) {
    var others = plist.filter(function (x) { return x.id !== p.id; }).map(function (x) { return x.displayName; });
    return '你是「' + p.displayName + '」。' + (p.role ? '\n【你的角色】\n' + p.role : '') +
      (p.knowledge ? '\n【你的專業知識與立場】\n' + p.knowledge : '') +
      '\n\n你正在一場多專家討論會議中，與使用者和其他專家即時交談。其他與會專家：' + (others.length ? others.join('、') : '（只有你）') + '。' +
      '\n發言規則：' +
      '\n1. 以第一人稱、用你自己的專業角度說話；不要替別人發言，也不要在開頭寫自己的名字。' +
      '\n2. 先回應使用者的最新發言；如果前面有專家說了與你專業相關的內容，可以同意、質疑或補充，要點名時用 @名稱。' +
      '\n3. 不要重複別人已經說過的話；沒有新東西可說就只提出你獨有的觀點或疑慮。' +
      '\n4. ' + LEN_HINT[settings.length] + '，口語自然像開會討論，可用條列但不要寫成長篇報告。' +
      '\n5. 引用知識庫資料時標明資料名稱；沒有依據的推論要說明是推測，不得捏造數據或出處。' +
      '\n6. 一律使用繁體中文（台灣）。';
  }

  // ── 跑一次使用者發言後的討論 ──
  // 回傳 { spoken:[{expertId,name,text,round}], notes:[], aborted, how }
  API.runTurn = async function (args) {
    var settings = normalizeSettings(args.settings), deps = args.deps || {};
    if (!deps.callModel) throw new Error('缺少 deps.callModel');
    var plist = API.withDisplayNames((args.participants || []).filter(function (p) { return p.enabled !== false; }));
    if (!plist.length) throw new Error('沒有與會專家，請先到「管理專家」啟用至少一位');
    var userText = String(args.userText || '').trim();
    if (!userText) throw new Error('沒有發言內容');
    var transcript = (args.transcript || []).slice();   // 不含這次使用者發言；內部會自己加
    transcript.push({ role: 'user', name: '使用者', text: userText });
    var result = { spoken: [], notes: [], aborted: false, how: '' };
    try {
      checkCancel(deps);
      if (deps.onStatus) deps.onStatus('主持人挑選發言者…');
      var sel = await selectSpeakers({ userText: userText, participants: plist, transcript: transcript.slice(0, -1), settings: settings, deps: deps });
      result.how = sel.how; result.notes = result.notes.concat(sel.notes || []);
      var speakers = sel.speakers;
      for (var round = 1; round <= settings.rounds; round++) {
        var spokeThisRound = 0;
        for (var i = 0; i < speakers.length; i++) {
          checkCancel(deps);
          var p = speakers[i];
          if (deps.onStatus) deps.onStatus((settings.rounds > 1 ? '第 ' + round + ' 回合｜' : '') + p.displayName + ' 發言中…（' + (i + 1) + '/' + speakers.length + '）');
          var items = [];
          if (settings.useKb && deps.kbRetrieve && round === 1) {
            try {
              var kb = p.kb || {};
              var rr = await deps.kbRetrieve(userText + '\n' + String(p.role || '').slice(0, 80), { docTypes: kb.docTypes, folderIds: kb.folderIds, docIds: kb.docIds, topK: settings.topK });
              items = (rr && rr.items) || [];
            } catch (e) { result.notes.push('「' + p.displayName + '」知識庫檢索失敗：' + ((e && e.message) || e)); }
          }
          var user = '【目前為止的討論】\n' + API.transcriptToText(transcript, settings.historyChars) +
            (items.length ? '\n\n【你可參考的知識庫資料】\n' + evidenceBlock(items) : '') +
            '\n\n現在輪到你（' + p.displayName + '）發言。' +
            (round > 1 ? '這是第 ' + round + ' 回合：只針對其他專家剛才的發言做回應；若沒有值得補充的，只回覆「（無補充）」。' : '');
          var text = '';
          try {
            var r = await deps.callModel({ model: modelFor(deps, 'speaker', settings, p), system: speakerSystem(p, plist, settings), text: user, thinking: 'low', maxOutputTokens: LEN_TOKENS[settings.length], search: !!p.web, tag: '發言：' + p.displayName });
            text = stripSelfPrefix(r && r.text, p.displayName);
          } catch (e) {
            if (e && e.cancelled) throw e;
            if (deps.isCancelled && deps.isCancelled()) { var ce = new Error('cancelled'); ce.cancelled = true; throw ce; }
            result.notes.push('「' + p.displayName + '」發言失敗：' + ((e && e.message) || e));
            if (deps.onSpeaker) await deps.onSpeaker(p, '（發言失敗：' + ((e && e.message) || e) + '）', { failed: true, round: round });
            continue;
          }
          if (!text) { result.notes.push('「' + p.displayName + '」沒有產生內容'); continue; }
          if (/^[（(]\s*無補充\s*[)）]?[。.]?$/.test(text)) continue;
          spokeThisRound++;
          transcript.push({ role: 'expert', name: p.displayName, text: text, expertId: p.id });
          result.spoken.push({ expertId: p.id, name: p.displayName, text: text, round: round });
          if (deps.onSpeaker) await deps.onSpeaker(p, text, { round: round, sources: items.map(function (it) { return it.docName; }).filter(Boolean) });
        }
        if (round > 1 && !spokeThisRound) break;
      }
    } catch (e) {
      if (e && e.cancelled) result.aborted = true; else throw e;
    }
    return result;
  };

  // ── 總結 ──
  API.summarize = async function (args) {
    var settings = normalizeSettings(args.settings), deps = args.deps || {};
    if (!deps.callModel) throw new Error('缺少 deps.callModel');
    var plist = API.withDisplayNames(args.participants || []);
    var transcript = args.transcript || [];
    if (!transcript.some(function (m) { return m.role === 'expert'; })) throw new Error('這場會議還沒有任何專家發言，沒有內容可以總結');
    var speakers = {}; transcript.forEach(function (m) { if (m.role === 'expert') speakers[m.name] = (speakers[m.name] || 0) + 1; });
    var names = Object.keys(speakers);
    var topic = String(args.topic || '').trim();
    var sys = '你是一場多專家討論會議的「總結者」。你只根據逐字紀錄整理，不加入紀錄裡沒有的新事實、數據或出處；' +
      '紀錄裡專家之間的矛盾要如實呈現，不要為了好看而抹平；不確定或缺乏依據的地方標明「待驗證」。一律使用繁體中文（台灣）。';
    var user = '【會議主題（參考）】\n' + (topic || '（見討論紀錄第一則使用者發言）') + '\n\n【與會專家】\n' +
      plist.map(function (p) { return '- ' + p.displayName + (p.role ? '：' + String(p.role).replace(/\s+/g, ' ').slice(0, 100) : ''); }).join('\n') +
      '\n\n【完整討論紀錄】\n' + API.transcriptToText(transcript, Math.max(settings.historyChars, 30000)) +
      '\n\n請輸出 Markdown 總結報告，固定使用以下章節（二級標題）：' +
      '\n## 一、討論主題與背景' +
      '\n## 二、各專家觀點摘要（每位發言過的專家一個小標題，標明名稱，條列其主要立場與理由）' +
      '\n## 三、已形成的共識' +
      '\n## 四、仍有分歧或未解的問題（寫出誰與誰在哪一點不同）' +
      '\n## 五、風險與待驗證事項' +
      '\n## 六、結論與建議的下一步（要具體、可執行，並說明這個結論有多確定）' +
      '\n只輸出報告本文，不要多餘的開場白。';
    var r = await deps.callModel({ model: modelFor(deps, 'summarizer', settings), system: sys, text: user, thinking: 'medium', maxOutputTokens: 6000, tag: '總結' });
    var body = String((r && r.text) || '').trim();
    if (!body) throw new Error('總結模型沒有回傳內容');
    var stamp = args.stamp || '';
    var md = '# 多專家會議總結\n\n' +
      '> 與會專家：' + names.join('、') + '｜專家發言 ' + transcript.filter(function (m) { return m.role === 'expert'; }).length + ' 則｜使用者發言 ' +
      transcript.filter(function (m) { return m.role === 'user'; }).length + ' 則' + (stamp ? '｜' + stamp : '') + '\n\n' + body + '\n';
    return { markdown: md, speakers: speakers };
  };

  global.NovaMeeting = API;
})(typeof window !== 'undefined' ? window : globalThis);

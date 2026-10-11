/* ═════════════════════════════════════════════
   nova-tts-gemini.js — NOVA Android 的 Gemini 語音朗讀（跟 index.html 放同一個資料夾 www/，在 <head> 載入）
   版本：v1.0.0
   版本紀錄：
   v1.0.0 - 批次 10（App v2.6.36）。移植桌面版 v3.31.61／v3.31.62 的 Gemini 語音朗讀（模型 gemini-3.8-flash-lite-tts，備援 gemini-3.8-flash-tts；30 個內建聲音）：
            分段合成（第一段短、之後大段）、最多領先播放 2 段、失敗進入冷卻並改用系統語音、系統附加說明不唸、WAV／PCM 轉 data URL。
            供應商選擇：選了 Gemini 聲音→Gemini；選 Zhiyu／Mia→Polly；選系統語音→系統語音；「自動」→Gemini→Polly→系統語音。
            只放常數與純函式，播放佇列（pollyAudioQueue 等）仍在 index.html，speakText() 接線也在 index.html。
            Android 差異：沒有 Python 代打，直接 fetch（CapacitorHttp 走原生，不受 CORS 限制）。
   ═════════════════════════════════════════════ */
function _novaIsModelUnavailableError(e) {
    const m = String((e && e.message) || e || ''); const st = e && e.status;
    return st === 404 || /not.?found|no longer available|deprecated|is not supported|does not exist/i.test(m);
}
        const NOVA_TTS_MODELS = ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts'];   // 主要模型、備援模型（兩者 API 格式相同；主要模型被下架／找不到時才換）
        const NOVA_TTS_DEFAULT_VOICE = 'Kore';
        const NOVA_TTS_TIMEOUT_MS = 40000;          // 單段合成的等待上限
        const NOVA_TTS_THROTTLE_MS = 150;           // 合成端最多領先播放 2 段，超過就每隔這麼久檢查一次
        const NOVA_GEMINI_TTS_VOICES = [            // 官方 30 個內建聲音與風格（官方沒有標性別，這裡也不標）
            ['Zephyr', '明亮'], ['Puck', '輕快'], ['Charon', '資訊感'], ['Kore', '沉穩'], ['Fenrir', '激昂'], ['Leda', '年輕'],
            ['Orus', '沉穩'], ['Aoede', '輕鬆'], ['Callirrhoe', '隨和'], ['Autonoe', '明亮'], ['Enceladus', '氣音'], ['Iapetus', '清晰'],
            ['Umbriel', '隨和'], ['Algieba', '圓潤'], ['Despina', '圓潤'], ['Erinome', '清晰'], ['Algenib', '沙啞'], ['Rasalgethi', '資訊感'],
            ['Laomedeia', '輕快'], ['Achernar', '柔和'], ['Alnilam', '沉穩'], ['Schedar', '平穩'], ['Gacrux', '成熟'], ['Pulcherrima', '直率'],
            ['Achird', '友善'], ['Zubenelgenubi', '隨性'], ['Vindemiatrix', '溫和'], ['Sadachbia', '活潑'], ['Sadaltager', '博學'], ['Sulafat', '溫暖']
        ];
        const _novaTtsDeadModels = new Set();      // 這次開啟 NOVA 期間已確認不可用的 TTS 模型（重開會再試，避免暫時性誤判永久封鎖）
        let _novaTtsCooldownUntil = 0;             // 合成失敗後的冷卻期（毫秒時間戳）：期間直接用瀏覽器語音，不再打會失敗的請求
        let _novaTtsSeq = 0;                       // 每次開始朗讀＋每次停止都遞增；合成請求回來時比對，過期的一律丟棄（避免舊訊息的語音混進新的）
        let _novaTtsProducing = false;             // 合成端是否還在產生下一段（佇列暫時空了不代表播完）
        let _novaTtsQueueKind = 'polly';           // 目前佇列裡的音訊是誰產生的（'gemini'｜'polly'）：只有 Gemini 語音套用「語音速度」設定

        function _novaTtsGeminiKey() {
            return String((typeof appState !== 'undefined' && appState.keys && appState.keys.gemini) || '').trim();
        }
        function _novaTtsGeminiReady() {
            return !!_novaTtsGeminiKey() && Date.now() >= _novaTtsCooldownUntil;
        }
        function _novaTtsVoiceName(v) {   // 'gemini:Kore' → 'Kore'；不認得的（過期或手誤）退回預設聲音
            const n = String(v || '').replace(/^gemini:/, '');
            return NOVA_GEMINI_TTS_VOICES.some(function (x) { return x[0] === n; }) ? n : NOVA_TTS_DEFAULT_VOICE;
        }
        // 決定這一次用哪一套：'gemini'｜'polly'｜'native'｜'none'
        //   明確選 Gemini 聲音 → Gemini（金鑰或冷卻不允許就用瀏覽器語音）；明確選 Polly 聲音 → Polly（沒有 AWS 金鑰就用瀏覽器語音）；
        //   明確選瀏覽器語音 → 瀏覽器語音（原本有 AWS 金鑰時會被無視，硬用 Polly——這是舊 bug）；
        //   選「自動」→ Gemini（有金鑰且不在冷卻）→ Polly（有 AWS 金鑰）→ 瀏覽器語音。
        function _novaTtsPickProvider(voice, ctx) {
            const v = String(voice || '');
            let p;
            if (v.indexOf('gemini:') === 0) p = ctx.geminiReady ? 'gemini' : 'native';
            else if (v === 'Zhiyu' || v === 'Mia') p = ctx.hasAws ? 'polly' : 'native';
            else if (v) p = 'native';
            else p = ctx.geminiReady ? 'gemini' : (ctx.hasAws ? 'polly' : 'native');
            if (p === 'native' && !ctx.hasSpeech) return ctx.hasAws ? 'polly' : 'none';
            return p;
        }
        // ★ v3.31.62：朗讀前先拿掉「系統附加的說明」，只唸回覆的主體。
        //   程式會在 AI 回覆後面附上斜體說明（fetchAIResponse 等處）：
        //     *(系統提示：已為您動態調配至 **模型名** 執行此任務)*、*(備援提示：Gemini 圖片模型本次未回傳圖片，已自動切換至 …)*、*(第 N 段，共 N 段 — 已輸出完畢)*，
        //   而且這些附加說明會跟著歷史再送回模型，模型會模仿著自己寫出全形括號、括號裡再有括號等變體。原本那條規則（/\(?系統提示：[^\)]+\)?/）只認「系統提示：」
        //   加半形括號，而且是貪婪的（遇到全形括號版本會連後面的正文一起刪掉），所以上面這些變體會被唸出來，或是把正文吃掉。
        //   規則：① 括號（半形或全形，外面可以有 * 包著，裡面可以再有一層括號）整段包起來、而且內容看起來是系統說明的，整段拿掉，只刪到同一行的右括號，不會碰到後面的正文；
        //         ② 沒有括號、整行以「系統提示：」「[系統提示]」「【備援提示】」開頭的說明行，只刪那一行。
        //   判斷「像系統說明」靠關鍵字（系統／備援／路由／降級＋提示／訊息／通知／說明、動態調配、自動切換、第 N 段共 N 段、System note…），一般的括號補充說明不受影響。
        function _novaTtsStripSystemNotes(text) {
            let t = String(text == null ? '' : text);
            const KEY = /(?:系統|備援|路由|降級)\s*(?:提示|訊息|通知|說明)|動態調配|自動調配|已自動(?:切換|降級|調配)|第\s*\d+\s*段\s*[，,、]?\s*共\s*\d+\s*段|novaDualAI|system\s*(?:note|notice|message|hint)|(?:dynamically|automatically)\s+routed|auto[- ]?routed/i;
            // 拿掉的地方先放一個暫時記號（\u0001），最後再把「整行只剩記號」的行連換行一起收掉——說明單獨佔一行時不會留下多餘的空行（多一個停頓）
            t = t.replace(/[ \t]*\*{0,3}[ \t]*[\(（](?:[^\(（\)）\n]|[\(（][^\(（\)）\n]*[\)）])*[\)）][ \t]*\*{0,3}/g, function (m) { return KEY.test(m) ? '\u0001' : m; });
            t = t.replace(/^[ \t*_>\-•⚠ℹ💡🔔⚙\uFE0F]*(?:[\[【][ \t]*(?:系統|備援)\s*(?:提示|訊息|通知)[ \t]*[\]】][^\n]*|(?:系統|備援)\s*(?:提示|訊息|通知)[ \t]*[：:][^\n]*)(?:\n|$)/gmu, '');
            t = t.replace(/^[ \t]*\u0001[ \t]*(?:\n|$)/gm, '').replace(/\u0001/g, '');
            return t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        }

        // 送給 Gemini 之前的清理：3.8 把角括號當語氣標籤、把 |…| 當插話標記，AI 回覆裡的 HTML 標籤與表格線不能原樣送進去
        function _novaTtsSanitize(text) {
            return String(text == null ? '' : text)
                .replace(/<\/?[a-zA-Z][^<>\n]{0,60}>/g, ' ')
                .replace(/^[ \t|:\-]{3,}(?:\n|$)/gm, '')   // 表格分隔列（|---|---|）與水平線（---）連同換行整列拿掉，不然可能被唸成「破折號」，也不會留下多餘的空行
                .replace(/\|/g, ' ')
                .replace(/[ \t]+/g, ' ')
                .replace(/ ?\n ?/g, '\n')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
        }
        // 切成要分段合成的片段：第一段短（讓播放盡快開始），之後每段盡量大（請求次數少、語調連貫）；沒有標點的超長句子在逗號／空白處硬切
        function _novaTtsChunks(text, firstMax, maxLen) {
            firstMax = firstMax || 120; maxLen = maxLen || 360;
            const t = String(text == null ? '' : text).replace(/\r/g, '').trim();
            if (!t) return [];
            const sentences = [];
            t.split(/\n+/).forEach(function (par) {
                (par.match(/[^。？！.?!；;]+[。？！.?!；;]*/g) || []).forEach(function (s) { s = s.trim(); if (s) sentences.push(s); });
            });
            const pieces = [];
            sentences.forEach(function (s) {
                if (s.length <= maxLen) { pieces.push(s); return; }
                let rest = s;
                while (rest.length > maxLen) {
                    let cut = -1;
                    for (const re of [/[，,、：:]\s*/g, /\s+/g]) {
                        let m, last = -1; re.lastIndex = 0;
                        while ((m = re.exec(rest)) && m.index + m[0].length <= maxLen) last = m.index + m[0].length;
                        if (last > maxLen * 0.4) { cut = last; break; }
                    }
                    if (cut < 0) cut = maxLen;
                    pieces.push(rest.slice(0, cut).trim());
                    rest = rest.slice(cut);
                }
                if (rest.trim()) pieces.push(rest.trim());
            });
            const out = []; let cur = '';
            pieces.forEach(function (p) {
                if (!cur) { cur = p; return; }
                const limit = out.length === 0 ? firstMax : maxLen;
                const joiner = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af。？！，、；：]$/.test(cur) ? '' : ' ';   // 中日韓／全形標點結尾不加空白，英文之間加空白
                if ((cur + joiner + p).length <= limit) cur += joiner + p;
                else { out.push(cur); cur = p; }
            });
            if (cur) out.push(cur);
            return out;
        }
        // 裸 PCM（audio/L16;rate=24000）→ 加上 WAV 檔頭。3.8 單次請求預設就是 WAV，這是保險：萬一回的是裸 PCM 也能播
        function _novaTtsPcmToWav(b64, rate) {
            const bin = atob(b64), n = bin.length, buf = new Uint8Array(44 + n), dv = new DataView(buf.buffer);
            const w = function (o, s) { for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i); };
            rate = rate || 24000;
            w(0, 'RIFF'); dv.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true);
            dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true);
            dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n, true);
            for (let i = 0; i < n; i++) buf[44 + i] = bin.charCodeAt(i);
            let s = '';
            for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
            return 'data:audio/wav;base64,' + btoa(s);
        }
        function _novaTtsToDataUrl(inline) {
            const b64 = inline && inline.data;
            if (!b64) throw new Error('Gemini 語音沒有回傳音訊資料');
            const mime = String((inline && inline.mimeType) || '').toLowerCase();
            if (b64.indexOf('UklGR') === 0 || /wav|wave/.test(mime)) return 'data:audio/wav;base64,' + b64;   // "UklGR" ＝ base64 的 "RIFF"
            if (/mpeg|mp3/.test(mime)) return 'data:audio/mpeg;base64,' + b64;
            if (/ogg|opus/.test(mime)) return 'data:audio/ogg;base64,' + b64;
            const m = mime.match(/rate=(\d+)/);
            return _novaTtsPcmToWav(b64, m ? parseInt(m[1], 10) : 24000);
        }
        async function _novaGeminiTtsCall(model, text, voice, key) {
            const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key;
            const payload = { contents: [{ role: 'user', parts: [{ text: text }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { voice: voice } } } };
            // 不走 fetchWithTimeout：它會把請求登記進「輸入框旁停止按鈕」的全域清單，按「停止」會連帶中斷正在合成的語音，被當成失敗而進入冷卻
            const ctl = new AbortController();
            const tid = setTimeout(function () { ctl.abort(); }, NOVA_TTS_TIMEOUT_MS);
            let res;
            try {
                res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: ctl.signal });   // Android：CapacitorHttp 讓 fetch 走原生（無 CORS；逾時由下方 timer 保底）
            } catch (e) {
                if (e && e.name === 'AbortError') throw new Error('Gemini 語音逾時（' + Math.round(NOVA_TTS_TIMEOUT_MS / 1000) + ' 秒）');
                throw e;
            } finally { clearTimeout(tid); }
            let data = {};
            try { data = await res.json(); } catch (e) { data = {}; }
            if (!res.ok) {
                const err = new Error((data && data.error && data.error.message) || ('HTTP ' + res.status));
                err.status = res.status;
                throw err;
            }
            const cand = (data.candidates || [])[0] || {};
            const parts = (cand.content && cand.content.parts) || [];
            const audio = parts.find(function (p) { return p && p.inlineData && p.inlineData.data; });
            if (!audio) throw new Error('Gemini 語音沒有回傳音訊（' + (cand.finishReason || (data.promptFeedback && data.promptFeedback.blockReason) || '沒有原因') + '）');
            return _novaTtsToDataUrl(audio.inlineData);
        }
        // 依序嘗試 NOVA_TTS_MODELS：主要模型「已下架／找不到」才換備援；其他錯誤（額度、金鑰、逾時…）不換，直接丟出去讓呼叫端走備援語音
        async function _novaGeminiTtsSynth(text, voice) {
            const key = _novaTtsGeminiKey();
            if (!key) throw new Error('沒有設定 Gemini API Key');
            const alive = NOVA_TTS_MODELS.filter(function (m) { return !_novaTtsDeadModels.has(m); });
            const list = alive.length ? alive : NOVA_TTS_MODELS;
            for (let i = 0; i < list.length; i++) {
                try {
                    return await _novaGeminiTtsCall(list[i], text, voice, key);
                } catch (e) {
                    if (i === list.length - 1 || !_novaIsModelUnavailableError(e)) throw e;
                    _novaTtsDeadModels.add(list[i]);
                    console.warn('[NOVA][TTS] 模型 ' + list[i] + ' 不可用（' + String((e && e.message) || e).slice(0, 120) + '），改用 ' + list[i + 1]);
                }
            }
        }
        // 合成失敗：進入冷卻期（期間直接用瀏覽器語音）並告訴使用者原因，避免每一句都先等一個注定失敗的請求
        function _novaTtsNoteFailure(e) {
            const msg = String((e && e.message) || e || '');
            const st = e && e.status;
            let secs = 30, why = '暫時性錯誤';
            if (st === 429 || /quota|exhausted|rate.?limit|too many/i.test(msg)) { secs = 120; why = '額度或速率限制'; }
            else if (st === 401 || st === 403 || /api key|permission|unauthenticated|forbidden/i.test(msg)) { secs = 300; why = 'Gemini 金鑰或權限問題'; }
            else if (st === 400) { secs = 300; why = '請求被拒絕'; }
            _novaTtsCooldownUntil = Date.now() + secs * 1000;
            try { showToast('🔊 Gemini 語音暫時無法使用（' + why + '），改用瀏覽器語音，約 ' + secs + ' 秒後自動再試。'); } catch (e2) {}
            console.warn('[NOVA][TTS] Gemini 語音失敗：', msg.slice(0, 200));
        }
        // 立刻停止所有朗讀（瀏覽器語音＋Polly／Gemini 的音訊佇列＋還在合成中的請求）
        function _novaStopAllTTS() {
            _novaTtsSeq++;                 // 讓所有還在合成中的請求作廢：回來之後不會再進佇列
            _novaTtsProducing = false;
            try { if (window.speechSynthesis && typeof window.speechSynthesis.cancel === 'function') window.speechSynthesis.cancel(); } catch (e) {}
            try { currentPollyAudio.pause(); } catch (e) {}
            pollyAudioQueue = [];
            isPollyPlayingQueue = false;
            queueContinueLoopCb = null;
            appState.isTTSPlaying = false;
            appState.playingMsgId = null;
            try { if (typeof renderMessages === 'function') renderMessages(); } catch (e) {}
        }

        function _novaExtractFirstJsonObject(text, accept) {
            const s = String(text == null ? '' : text);
            let from = 0;
            for (let attempts = 0; attempts < 50; attempts++) {   // 上限：病態輸入（一堆沒配對的 {）不會拖慢
                const start = s.indexOf('{', from);
                if (start === -1) return null;
                let depth = 0, inStr = false, esc = false, end = -1;
                for (let i = start; i < s.length; i++) {
                    const ch = s[i];
                    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
                    if (ch === '"') { inStr = true; continue; }
                    if (ch === '{') depth++;
                    else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
                }
                if (end !== -1) {
                    try {
                        const obj = JSON.parse(s.slice(start, end + 1));
                        if (!accept || accept(obj)) return obj;
                    } catch (e) { /* 這一段不是合法 JSON，往後找 */ }
                }
                from = start + 1;
            }
            return null;
        }
        function _novaIsTranslationJson(o) { return !!o && typeof o === 'object' && !Array.isArray(o) && Object.prototype.hasOwnProperty.call(o, 'translated'); }

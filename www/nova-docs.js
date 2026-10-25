/* ═════════════════════════════════════════════════════════════════
   nova-docs.js — NOVA Android「文件轉 Markdown（markitdown）＋影片字幕（yt-dlp）」（跟 index.html 放同一個資料夾 www/）
   版本：v1.0.0
   版本紀錄：
   v1.0.0 - App v2.6.92。移植桌面版 v3.80.14–17（python-engine v0.8.50／0.8.53）：透過 Termux 橋接（v1.1.0 以上，termux/nova_tools.py）呼叫手機上的 markitdown 與 yt-dlp。
            ① window._novaMarkItDown(file)：docx／pptx／xlsx／xls／pdf／html／epub／csv／xml／msg → Markdown（簡報分頁註解換成「投影片 N」，其餘 HTML 註解移除）；
               回傳 {ok, markdown, truncated} 或 {ok:false, reason:'noconfig|missing|old|empty|fail', error}。
            ② 筆記中心「匯入文件」importDocsAsNotes：每個檔案一則筆記；「影片字幕」importVideoSubtitleNote：貼影片連結 → 抓字幕（人工優先，其次自動字幕；不下載影片）→ 一則筆記（標籤「影片字幕」）。
            ③ 聊天附件 docx／pptx（以及 xls／xlsx 失敗時）由 index.html 呼叫 _novaMarkItDown；沒設橋接或失敗就維持原本的讀法。localStorage nova_markitdown='0' 可關閉。
            ④ 工具呼叫新增 video_subtitles（取得影片字幕逐字稿）；只在橋接已設定時出現。
   依賴：window.NovaTermux（nova-termux.js v1.1.0）、index.html 的 appState／saveToDB／renderNotes／formatMessage／showToast／novaPrompt／novaFcRegistry
   ═════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';
    if (window.NovaDocs) return;
    var W = window;
    function toast(m, t) { try { if (typeof W.showToast === 'function') W.showToast(m, t || 3500); } catch (e) { /* ignore */ } }
    function T() { return W.NovaTermux; }
    function reasonOf(msg) {
        msg = String(msg || '');
        if (/尚未安裝|缺少讀取|未安裝/.test(msg)) return 'missing';
        if (/版本太舊|沒有這個功能|nova_tools/.test(msg)) return 'old';
        return 'fail';
    }
    W._novaMarkItDownExts = ['docx', 'pptx', 'xlsx', 'xls', 'pdf', 'html', 'htm', 'epub', 'csv', 'xml', 'msg'];

    function readB64(file) {
        return new Promise(function (res, rej) {
            var fr = new FileReader();
            fr.onload = function () { res(String(fr.result).split(',')[1] || ''); };
            fr.onerror = function () { rej(fr.error || new Error('讀檔失敗')); };
            fr.readAsDataURL(file);
        });
    }
    W._novaMarkItDown = async function (file, opts) {
        opts = opts || {};
        try {
            if (!T() || !T().configured()) return { ok: false, reason: 'noconfig', error: '尚未設定 Termux 橋接（設定 → 🔌 工具 → Termux 橋接）' };
            var b64 = await readB64(file);
            var data = await T().toolPost('/markitdown', { name: file.name || 'file', data_base64: b64, max_chars: opts.maxChars || 400000 }, opts.timeoutMs || 180000);
            var md = String(data.markdown || '').replace(/<!--\s*Slide number:\s*(\d+)\s*-->/gi, '\n\n---\n\n**投影片 $1**\n').replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n');
            if (!md.trim()) return { ok: false, reason: 'empty', error: '轉換後沒有文字內容（可能是掃描檔／純圖片）' };
            return { ok: true, markdown: md, truncated: !!data.truncated };
        } catch (e) {
            var m = String((e && e.message) || e);
            return { ok: false, reason: reasonOf(m), error: m.slice(0, 300) };
        }
    };

    function fmtDur(dur) {
        dur = Math.round(dur || 0); if (!dur) return '';
        return (Math.floor(dur / 3600) ? Math.floor(dur / 3600) + ':' : '') + String(Math.floor((dur % 3600) / 60)).padStart(dur >= 3600 ? 2 : 1, '0') + ':' + String(dur % 60).padStart(2, '0');
    }
    // 向橋接要字幕；回傳桌面版同格式的資料，或丟 Error
    async function fetchSubtitles(url, lang, timestamps) {
        if (!T() || !T().configured()) throw new Error('尚未設定 Termux 橋接（設定 → 🔌 工具 → Termux 橋接）');
        return await T().toolPost('/subtitles', { url: url, lang: lang || '', langs: ['zh-Hant', 'zh-TW', 'zh-Hans', 'zh-CN', 'zh', 'en'], timestamps: timestamps !== false }, 150000);
    }
    function addNote(note) {
        W.appState.notes.unshift(note);
        try { saveToDB('notes', note); } catch (e) { /* ignore */ }
        try { scheduleEmergencyBackup(); } catch (e) { /* ignore */ }
    }
    function mkHtml(md) { return (typeof formatMessage === 'function') ? formatMessage(md) : '<pre>' + String(md).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }) + '</pre>'; }

    W.importDocsAsNotes = async function (ev) {
        var files = Array.from((ev && ev.target && ev.target.files) || []).slice(0, 20);
        if (ev && ev.target) ev.target.value = '';
        if (!files.length) return;
        var ok = 0, bad = [];
        for (var i = 0; i < files.length; i++) {
            var f = files[i];
            toast('⏳ 轉換中 (' + (i + 1) + '/' + files.length + ')：' + f.name, 4000);
            var r = await W._novaMarkItDown(f);
            if (!r.ok) { bad.push(f.name + '：' + r.error); if (r.reason === 'missing' || r.reason === 'noconfig' || r.reason === 'old') break; continue; }
            addNote({ id: Date.now() + i, title: String(f.name || '匯入文件').replace(/\.[^.]+$/, ''), content: mkHtml(r.markdown), isHtml: true, date: new Date().toLocaleString(), type: 'text', folder: '未分類' });
            ok++;
            if (r.truncated) bad.push(f.name + '：內容太長，只匯入前 40 萬字');
        }
        if (ok) { try { renderNotes(); } catch (e) { /* ignore */ } }
        if (bad.length) toast((ok ? '✅ 已匯入 ' + ok + ' 則；' : '❌ ') + bad.join('；'), 9000);
        else toast('✅ 已匯入 ' + ok + ' 則筆記（Markdown 轉換）');
    };

    W.importVideoSubtitleNote = async function () {
        var url = await W.novaPrompt('貼上影片連結（YouTube、Bilibili、Vimeo…）。只會抓字幕，不會下載影片。', '');
        url = String(url || '').trim();
        if (!url) return;
        if (!/^https?:\/\/\S+$/i.test(url)) { toast('❌ 請貼完整的影片網址（http:// 或 https:// 開頭）', 5000); return; }
        toast('⏳ 讀取影片字幕中…', 6000);
        var data;
        try { data = await fetchSubtitles(url, '', true); }
        catch (e) { toast('❌ ' + String((e && e.message) || e).slice(0, 300), 12000); return; }
        if (!data || !data.ok) {
            var langs = ((data && data.available_manual) || []).concat((data && data.available_auto) || []);
            toast('⚠️ ' + ((data && data.title) ? '「' + data.title + '」' : '這部影片') + (data && data.reason === 'live' ? '是直播，直播結束後才抓得到字幕。' : '沒有字幕（人工字幕和自動字幕都沒有），所以抓不到內容。') + (langs.length ? '（偵測到的字幕軌：' + langs.join('、') + '）' : ''), 9000);
            return;
        }
        var durStr = fmtDur(data.duration), srcLabel = data.source === 'manual' ? '人工字幕' : '自動產生字幕（可能有錯字）';
        var meta = '> 來源：' + (data.webpage_url || url) + (data.uploader ? '　作者：' + data.uploader : '') + (durStr ? '　長度：' + durStr : '') + '　字幕：' + srcLabel + '（' + data.lang + '）' + (data.truncated ? '　⚠️ 內容太長，只保留前 40 萬字' : '');
        var note = { id: Date.now(), title: String(data.title || '影片字幕').slice(0, 120), content: mkHtml(meta + '\n\n' + data.transcript), isHtml: true, date: new Date().toLocaleString(), type: 'text', folder: '未分類', tags: ['影片字幕'] };
        addNote(note);
        try { renderNotes(); } catch (e) { /* ignore */ }
        toast('✅ 已建立筆記：' + note.title + '（' + srcLabel + '，' + data.chars + ' 字）', 6000);
    };

    /* ───────── AI 工具 ───────── */
    function register() {
        if (!W.novaFcRegistry) return false;
        W.novaFcRegistry.register({ id: 'nova-docs', label: '影片字幕', list: async function () {
            if (!T() || !T().configured()) return [];
            return [{ name: 'video_subtitles', label: '影片字幕', readOnly: true,
                description: '取得影片的字幕逐字稿（YouTube、Bilibili、Vimeo 等 yt-dlp 支援的網站；只抓字幕，不下載影片）。人工字幕優先，其次自動字幕。用於：整理或摘要影片內容、查影片裡講了什麼。沒有字幕的影片會回報沒有。需要 Termux 橋接與 yt-dlp。',
                parameters: { type: 'object', properties: { url: { type: 'string', description: '完整的影片網址（http/https）' }, lang: { type: 'string', description: '指定字幕語言代碼（如 en、zh-Hant）；不填就自動挑' }, timestamps: { type: 'boolean', description: '是否在每段開頭加 [hh:mm:ss]，預設 true' } }, required: ['url'] },
                run: async function (a) {
                    var u = String(a.url || '').trim();
                    if (!/^https?:\/\/\S+$/i.test(u)) return { success: false, text: '請提供完整的影片網址（http:// 或 https:// 開頭）' };
                    var d;
                    try { d = await fetchSubtitles(u, a.lang, a.timestamps); } catch (e) { return { success: false, text: '抓字幕失敗：' + ((e && e.message) || e) }; }
                    if (!d || !d.ok) return { success: false, text: (d && d.detail) || '這部影片沒有可用的字幕。' + (d && d.available_manual && d.available_manual.length ? '可用字幕軌：' + d.available_manual.join('、') : '') };
                    var src = d.source === 'manual' ? '人工字幕' : '自動產生字幕（可能有錯字）';
                    return '【' + (d.title || '影片') + '】' + (d.uploader ? ' 作者：' + d.uploader : '') + (fmtDur(d.duration) ? ' 長度：' + fmtDur(d.duration) : '') + ' 字幕：' + src + '（' + d.lang + '）' + (d.truncated ? ' ⚠️已截斷' : '') + '\n\n' + d.transcript;
                } }];
        } });
        return true;
    }
    function boot(n) { n = n || 0; if (!register() && n < 40) setTimeout(function () { boot(n + 1); }, 500); }
    W.NovaDocs = { markItDown: W._novaMarkItDown, importDocsAsNotes: W.importDocsAsNotes, importVideoSubtitleNote: W.importVideoSubtitleNote, fetchSubtitles: fetchSubtitles, version: '1.0.0' };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { boot(0); }); else boot(0);
})();

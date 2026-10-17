/* ═════════════════════════════════════════════
   nova-backup-ext.js — NOVA Android 完整備份補強（跟 index.html 放同一個資料夾 www/，在 <head> 載入）
   版本：v1.0.4
   版本紀錄：
   v1.0.4 - App v2.6.64：新增專用欄位 aiThoughts（nova_thoughts_v1，AI 思考＋各叢集設定）與 projectsMeta（nova_projects_v1，專案視窗資料），不受 collectLs 單項 3MB 上限影響（對標桌面版 v3.73.3）；還原寫回見 index.html。
   v1.0.3 - App v2.6.63：明確排除 nova_private_pw（私密密碼雜湊只留本機，不進備份）；確認 nova_session_models（對話模型記憶）、nova_ws_v1（工作資料夾）、nova_private_sessions 會由 lsSettings 自動進備份。
   v1.0.0 - App v2.6.39。備份原本只列舉固定欄位，之後新增的設定頁參數（自主任務、Jev、遙控主機、技能自動比對、記憶模式、翻譯輸入模式、
            深度研究偏好、口譯／語音設定…）都沒進備份。改成：把 localStorage 裡所有 nova_／cal_ 開頭的設定一次收進 lsSettings（排除
            對話、筆記、待辦、錄音清單、向量庫、各種暫存備份這些「資料」——它們有自己的備份欄位），還原時整批寫回。
            另提供 stripAudio()：錄音清單備份時移除所有音檔本體（含分段 segments 裡的 audioData），但保留 AI 分析、摘要、逐字稿等文字欄位。
   對外：window.NovaBackupExt = { collectLs(), applyLs(obj), stripAudio(records), extraFields() }
   ═════════════════════════════════════════════ */
(function () {
    'use strict';
    var EXCLUDE = { nova_messages: 1, nova_notes: 1, nova_todos: 1, nova_audio_records: 1, nova_audio_meta_backup: 1, nova_kb_backup: 1, nova_kb_db: 1, nova_memory_db: 1,
        nova_em_backup: 1, nova_persist_warned: 1, nova_tg_last_update_id: 1, nova_current_session: 1,
        nova_firstrun_dismissed: 1, nova_wal_prev_kept: 1, nova_rec_beat: 1, nova_rec_diag: 1, nova_gdrive_pending: 1, nova_private_pw: 1 };
    var MAX_VAL = 3 * 1024 * 1024;
    function collectLs() {
        var out = {};
        try {
            for (var i = 0; i < localStorage.length; i++) {
                var k = localStorage.key(i);
                if (!k || !/^(nova_|cal_)/.test(k) || EXCLUDE[k] || k.indexOf('nova_nr_try') === 0) continue;
                var v = localStorage.getItem(k);
                if (v != null && v.length <= MAX_VAL) out[k] = v;
            }
        } catch (e) { /* ignore */ }
        return out;
    }
    function applyLs(obj) {
        var n = 0;
        if (!obj || typeof obj !== 'object') return 0;
        Object.keys(obj).forEach(function (k) {
            if (!/^(nova_|cal_)/.test(k) || EXCLUDE[k]) return;
            try { localStorage.setItem(k, String(obj[k])); n++; } catch (e) { /* ignore */ }
        });
        return n;
    }
    function strip(o, depth) {
        if (!o || typeof o !== 'object' || depth > 4) return o;
        if (Array.isArray(o)) return o.map(function (x) { return strip(x, depth + 1); });
        var r = {};
        Object.keys(o).forEach(function (k) {
            if (k === 'audioData' || k === 'audioBlob' || k === 'blob') return;
            if (typeof o[k] === 'string' && /^data:(audio|video)\//i.test(o[k])) return;   // 內嵌的音訊 data URL 也不備份
            r[k] = strip(o[k], depth + 1);
        });
        return r;
    }
    function stripAudio(records) { return (records || []).map(function (r) { return strip(r, 0); }); }
    async function extraFields() {
        var A = window.appState || {}, f = { lsSettings: collectLs() };
        try { var _t = localStorage.getItem('nova_thoughts_v1'), _p = localStorage.getItem('nova_projects_v1'); if (_t) f.aiThoughts = _t; if (_p) f.projectsMeta = _p; } catch (e) { /* 專用欄位：不受 collectLs 單項 3MB 上限影響 */ }
        try { f.disabledModels = window.novaDisabledModels ? window.novaDisabledModels() : []; } catch (e) { /* ignore */ }
        try { if (window.NovaMemory && NovaMemory.exportAll) f.memoryData = await NovaMemory.exportAll().catch(function () { return null; }); } catch (e) { /* ignore */ }
        try { if (window.NovaMemoryPrivate && NovaMemoryPrivate.exportAll) { f.privateMemoryData = await NovaMemoryPrivate.exportAll().catch(function () { return null; }); f.privateSessions = window.NovaPrivate ? NovaPrivate.list() : []; } } catch (e) { /* ignore */ }
        ['currentModel', 'geminiModel', 'grokModel', 'gptModel', 'theme', 'uiColor', 'deepDiveMode'].forEach(function (k) { if (A[k] !== undefined) f[k] = A[k]; });
        return f;
    }
    window.NovaBackupExt = { collectLs: collectLs, applyLs: applyLs, stripAudio: stripAudio, extraFields: extraFields };
})();

/* ═══════════════════════════════════════════════════════════════════════
   nova-model-picker.js — NOVA Android 單一模型選單（跟 index.html 放同一個資料夾 www/）
   版本：v1.0.0
   版本紀錄：
   v1.0.0 - 初版（v2.6.28）。把輸入區原本的「主模型＋子模型」兩層下拉，合併成一個全展開的選單：點開後 Gemini／Grok／OpenAI／Groq／Cohere／Local
            全部列出，只分「文字模型」與「生圖模型」兩組。選項值格式「供應商::型號」，選取時依序呼叫原本的 setModel() 與 setGeminiModel／setGrokModel／setGptModel()，
            所以所有舊邏輯（狀態、持久化、設定頁停用模型過濾）都不用改。原本三個子模型下拉與主模型下拉仍留在 DOM（CSS 隱藏），當作資料來源與相容用。
            選單內容每次 updateModelUI() 時重建，因此設定頁「啟用的模型」停用的型號會自動從選單消失。
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';
    var W = window, ID = 'nova-unified-model-select';
    var SUBS = [['gemini', 'gemini-sub-model-select', 'Gemini', 'geminiModel', 'setGeminiModel'], ['grok', 'grok-sub-model-select', 'Grok', 'grokModel', 'setGrokModel'], ['gpt', 'gpt-sub-model-select', 'OpenAI', 'gptModel', 'setGptModel']];
    var OTHERS = [['groq', 'Groq (Llama)'], ['cohere', 'Cohere (Command-R-Plus)'], ['local', 'Local API']];
    function opt(v, t) { var o = document.createElement('option'); o.value = v; o.textContent = t; return o; }
    function build() {
        var sel = document.getElementById(ID); if (!sel) return null;
        var text = document.createElement('optgroup'); text.label = '文字模型';
        var img = document.createElement('optgroup'); img.label = '生圖模型';
        SUBS.forEach(function (p) {
            var src = document.getElementById(p[1]); if (!src) return;
            Array.prototype.forEach.call(src.querySelectorAll('option'), function (o) {
                var g = o.parentNode && o.parentNode.tagName === 'OPTGROUP' ? o.parentNode.label : '';
                var isImg = /圖像|生圖/.test(g) || /image|imagine|nano-banana/i.test(o.value);
                var t = o.textContent.trim().replace(/\s*\(繪圖\)$/, '');
                if (t.toLowerCase().indexOf(p[2].toLowerCase()) !== 0 && !/^GPT/i.test(t)) t = p[2] + ' ' + t;
                if (p[0] === 'gpt' && /^GPT/i.test(t)) t = 'OpenAI ' + t;
                (isImg ? img : text).appendChild(opt(p[0] + '::' + o.value, t));
            });
        });
        OTHERS.forEach(function (x) { text.appendChild(opt(x[0] + '::', x[1])); });
        sel.textContent = ''; sel.appendChild(text); if (img.children.length) sel.appendChild(img);
        return sel;
    }
    function current() {
        var st = W.appState || {}, m = st.currentModel;
        for (var i = 0; i < SUBS.length; i++) if (SUBS[i][0] === m) return m + '::' + (st[SUBS[i][3]] || '');
        return m + '::';
    }
    function sync() {
        var sel = build(); if (!sel) return;
        var v = current();
        if (!Array.prototype.some.call(sel.options, function (o) { return o.value === v; })) { // 目前型號不在清單（例如被停用）：臨時補一個，避免顯示成別的模型
            var o = opt(v, v.replace('::', ' ')); sel.insertBefore(o, sel.firstChild);
        }
        sel.value = v;
    }
    W.novaUnifiedModelChange = function (val) {
        var i = String(val).indexOf('::'), prov = val.slice(0, i), model = val.slice(i + 2);
        SUBS.forEach(function (p) { if (p[0] === prov && model && typeof W[p[4]] === 'function') W[p[4]](model); });
        if (typeof W.setModel === 'function') W.setModel(prov); else sync();
        try { var s = document.getElementById(ID); if (s) s.blur(); } catch (e) { /* ignore */ }
    };
    var orig = W.updateModelUI;
    if (typeof orig === 'function') { W.updateModelUI = function () { var r = orig.apply(this, arguments); try { sync(); } catch (e) { /* ignore */ } return r; }; }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sync); else sync();
    setTimeout(sync, 600);
    W.NovaModelPicker = { sync: sync };
})();

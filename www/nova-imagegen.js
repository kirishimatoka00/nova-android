/* ═════════════════════════════════════════════════════════════════
   nova-imagegen.js — NOVA Android「生圖模式」（跟 index.html 放同一個資料夾 www/）
   版本：v1.0.0
   版本紀錄：
   v1.0.0 - App v2.6.68。新增專門生成圖片的全螢幕介面（＋選單 →「生圖」）：
            a. 圖片描述　b. Gemini／Grok 生圖模型選擇　c. 解析度（依模型列出可用尺寸，並顯示約略像素）
            d. 圖片比例（依模型列出，附形狀預覽）　e. 參考圖片上傳（自動縮圖，數量依模型）
            f. 圖片風格（15 種：真實相片、電影感、動漫、3D、水彩…，以英文風格提示詞附加在描述後面）　g. 張數 1～4
            結果可：儲存到手機、送到對話、當作參考圖再生成、放大檢視；最近 24 張有歷史紀錄。
            配色全部使用 nova-ui.css 的 --nv-* 色票（黑夜／白晝自動切換），按鈕自帶 nv-keep 避免被白晝無框規則吃掉。
            這個檔案自己呼叫 API（Gemini generateContent／Grok images），不經過聊天流程，不影響既有的對話生圖。
            參數不被模型接受（HTTP 400）時自動降級重試：先去掉 imageSize，再去掉整個 imageConfig（比例改寫進提示詞）。
   對外：window.NovaImageGen = { open, close, version }；window.openImageGen()
   依賴：appState.keys.gemini／grok、NovaImageStore、addMessage、downloadDataUriFile、showToast（皆為 index.html 既有）
   ═════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';
    if (window.NovaImageGen) return;
    var W = window, D = document;
    var PREF_KEY = 'nova_imggen_prefs', HIST_KEY = 'nova_imggen_hist', DRAFT_KEY = 'nova_imggen_draft';
    var PROXY = 'https://grokcaller.kirishimatoka00.workers.dev/';

    function lsGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
    function toast(m, t) { try { if (typeof W.showToast === 'function') W.showToast(m, t || 3000); } catch (e) { /* ignore */ } }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

    /* ───────── 模型能力表 ─────────
       cfg: 'full'＝可帶 imageConfig（比例＋解析度）；'ratio'＝只帶比例；'size'＝Grok 以 WxH 表達；maxRef＝參考圖上限 */
    var R10 = ['1:1', '4:5', '5:4', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9'];
    var RG = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2'];
    var MODELS = [
        { id: 'gemini-nano-banana-2.1', prov: 'gemini', name: 'Nano Banana 2.1', desc: '最新主力：速度與品質平衡，支援多張參考圖', sizes: ['512', '1K', '2K', '4K'], ratios: R10, cfg: 'full', maxRef: 10, ver: 'v1alpha' },
        { id: 'gemini-3-pro-image', prov: 'gemini', name: 'Gemini 3 Pro Image', desc: '最高品質，文字排版與細節最佳', sizes: ['1K', '2K', '4K'], ratios: R10, cfg: 'full', maxRef: 14, ver: 'v1alpha' },
        { id: 'gemini-3.1-flash-lite-image', prov: 'gemini', name: '3.1 Flash-Lite Image', desc: '最省額度、最快，適合草稿與大量嘗試', sizes: ['1K'], ratios: R10, cfg: 'full', maxRef: 10, ver: 'v1alpha' },
        { id: 'gemini-2.5-flash-image', prov: 'gemini', name: '2.5 Flash Image', desc: '舊版穩定款（官方預定 2027-03 停用），固定約 1K', sizes: ['1K'], ratios: R10, cfg: 'ratio', maxRef: 3, ver: 'v1beta' },
        { id: 'grok-imagine-image-2.0', prov: 'grok', name: 'Grok Imagine 2.0', desc: 'xAI 新版繪圖，風格鮮明、人物表現佳', sizes: ['1K', '2K'], ratios: RG, cfg: 'size', maxRef: 1 },
        { id: 'grok-imagine-image', prov: 'grok', name: 'Grok Imagine', desc: 'xAI 前代繪圖模型', sizes: ['1K', '2K'], ratios: RG, cfg: 'size', maxRef: 1 }
    ];
    function modelOf(id) { for (var i = 0; i < MODELS.length; i++) if (MODELS[i].id === id) return MODELS[i]; return MODELS[0]; }

    var SIZE_LABEL = { '512': '0.5K', '1K': '1K', '2K': '2K', '4K': '4K' };
    var SIZE_BASE = { '512': 512, '1K': 1024, '2K': 2048, '4K': 4096 };

    /* ───────── 風格 ───────── */
    var STYLES = [
        { id: 'auto', e: '🎲', n: '自動', p: '' },
        { id: 'real', e: '📷', n: '真實相片', p: 'Photorealistic photograph, natural lighting, realistic textures and skin detail, shot on a full-frame camera with a 50mm lens, sharp focus, true-to-life colors.' },
        { id: 'cinema', e: '🎬', n: '電影感', p: 'Cinematic still frame, anamorphic lens, dramatic lighting, shallow depth of field, color graded, subtle film grain.' },
        { id: 'anime', e: '🌸', n: '動漫', p: 'Japanese anime illustration style, clean line art, vibrant cel shading, detailed background.' },
        { id: '3d', e: '🧊', n: '3D 渲染', p: 'High-quality 3D render, physically based materials, soft global illumination, polished look.' },
        { id: 'water', e: '💧', n: '水彩', p: 'Watercolor painting, soft washes of color, visible paper texture, delicate gradients.' },
        { id: 'oil', e: '🎨', n: '油畫', p: 'Classic oil painting, rich brush strokes, painterly texture, museum quality.' },
        { id: 'pixel', e: '👾', n: '像素風', p: 'Pixel art, limited color palette, crisp pixels, retro video game aesthetic.' },
        { id: 'line', e: '✏️', n: '線稿', p: 'Minimal black ink line drawing on a white background, clean confident lines, no shading.' },
        { id: 'clay', e: '🧸', n: '黏土', p: 'Cute claymation style, handmade clay figures, soft studio lighting, tactile fingerprint texture.' },
        { id: 'film', e: '🎞️', n: '復古底片', p: 'Vintage 35mm film photograph, analog grain, faded colors, light leaks, nostalgic mood.' },
        { id: 'cyber', e: '🌃', n: '賽博龐克', p: 'Cyberpunk mood, glowing neon lights, rain-soaked reflections, futuristic city atmosphere.' },
        { id: 'concept', e: '🏔️', n: '概念藝術', p: 'Epic concept art, matte painting, highly detailed environment design, dramatic composition.' },
        { id: 'product', e: '📦', n: '產品攝影', p: 'Professional product photography, clean studio background, softbox lighting, crisp detail, commercial advertising quality.' },
        { id: 'vector', e: '🖼️', n: '向量插畫', p: 'Flat vector illustration, bold shapes, clean modern design, cohesive color palette.' }
    ];
    function styleOf(id) { for (var i = 0; i < STYLES.length; i++) if (STYLES[i].id === id) return STYLES[i]; return STYLES[0]; }

    /* ───────── 狀態 ───────── */
    var P = { model: 'gemini-nano-banana-2.1', ratio: '1:1', size: '1K', style: 'auto', count: 1, prompt: '', refs: [], results: [], busy: false, open: false, viewer: null, histOpen: false };
    var root = null;

    function loadPrefs() {
        try {
            var o = JSON.parse(lsGet(PREF_KEY, '{}')) || {};
            if (o.model) P.model = o.model; if (o.ratio) P.ratio = o.ratio; if (o.size) P.size = o.size;
            if (o.style) P.style = o.style; if (o.count) P.count = Math.max(1, Math.min(4, +o.count || 1));
        } catch (e) { /* ignore */ }
        P.prompt = lsGet(DRAFT_KEY, '');
        clamp();
    }
    function savePrefs() { lsSet(PREF_KEY, JSON.stringify({ model: P.model, ratio: P.ratio, size: P.size, style: P.style, count: P.count })); }
    function clamp() {
        var m = modelOf(P.model); P.model = m.id;
        if (m.ratios.indexOf(P.ratio) < 0) P.ratio = '1:1';
        if (m.sizes.indexOf(P.size) < 0) P.size = m.sizes.indexOf('1K') >= 0 ? '1K' : m.sizes[0];
    }

    /* ───────── 尺寸計算（約略像素） ───────── */
    function dims(m, size, ratio) {
        var rp = ratio.split(':'), rw = +rp[0], rh = +rp[1], base = SIZE_BASE[size] || 1024;
        if (m.prov === 'grok') {
            var w, h; if (rw >= rh) { w = base; h = base * rh / rw; } else { h = base; w = base * rw / rh; }
            return [Math.round(w / 64) * 64, Math.round(h / 64) * 64];
        }
        var k = Math.sqrt(rw / rh);
        return [Math.round(base * k / 16) * 16, Math.round(base / k / 16) * 16];
    }

    /* ───────── 樣式 ───────── */
    var CSS = '' +
        '#nig-root{position:fixed;inset:0;z-index:99990;display:none;flex-direction:column;background:var(--nv-canvas,#020617);color:var(--nv-text,#f1f5f9);font-family:var(--nv-font,system-ui,sans-serif);-webkit-tap-highlight-color:transparent}' +
        '#nig-root.nig-open{display:flex}' +
        '#nig-root *{box-sizing:border-box}' +
        '#nig-root .nig-top{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:calc(env(safe-area-inset-top,0px) + 8px) 12px 8px;border-bottom:1px solid var(--nv-line,#1e293b);background:var(--nv-chrome,#0f172a)}' +
        '#nig-root .nig-title{flex:1;font-size:17px;font-weight:700;letter-spacing:.2px;display:flex;align-items:center;gap:8px}' +
        '#nig-root .nig-title small{font-size:11px;font-weight:600;color:var(--nv-accent-text,#60a5fa);background:var(--nv-accent-soft,rgba(59,130,246,.14));padding:2px 8px;border-radius:999px}' +
        'html:root body #nig-root .nig-ib{width:40px;height:40px;border-radius:12px;border:0 !important;background:transparent !important;color:var(--nv-text-2,#cbd5e1) !important;display:inline-flex;align-items:center;justify-content:center;font-size:20px;cursor:pointer;box-shadow:none !important}' +
        'html:root body #nig-root .nig-ib:active{background:var(--nv-active,rgba(148,163,184,.17)) !important}' +
        '#nig-root .nig-scroll{flex:1 1 auto;overflow-y:auto;overflow-x:hidden;padding:12px 12px 24px;-webkit-overflow-scrolling:touch}' +
        '#nig-root .nig-card{background:var(--nv-card,#0f172a);border:1px solid var(--nv-line,#1e293b);border-radius:16px;padding:12px;margin-bottom:12px}' +
        '#nig-root .nig-lb{display:flex;align-items:center;justify-content:space-between;margin:0 2px 8px;font-size:12px;font-weight:700;letter-spacing:.4px;color:var(--nv-muted,#94a3b8)}' +
        '#nig-root .nig-lb em{font-style:normal;font-weight:500;color:var(--nv-faint,#7c8aa0);font-size:11px}' +
        '#nig-root textarea.nig-ta{width:100%;min-height:112px;max-height:240px;resize:none;border:0;outline:none;background:transparent;color:var(--nv-text,#f1f5f9);font:inherit;font-size:16px;line-height:1.55;padding:2px}' +
        '#nig-root textarea.nig-ta::placeholder{color:var(--nv-faint,#7c8aa0)}' +
        '#nig-root .nig-row{display:flex;gap:8px;overflow-x:auto;padding:2px 2px 4px;scrollbar-width:none;-webkit-overflow-scrolling:touch}' +
        '#nig-root .nig-row::-webkit-scrollbar{display:none}' +
        'html:root body #nig-root .nig-chip{flex:0 0 auto;min-height:40px;padding:0 14px;border-radius:999px;border:1px solid var(--nv-line-strong,#334155) !important;background:var(--nv-card-2,#1e293b) !important;color:var(--nv-text-2,#cbd5e1) !important;font-size:13px;font-weight:600;display:inline-flex;align-items:center;gap:6px;cursor:pointer;box-shadow:none !important;white-space:nowrap}' +
        'html:root body #nig-root .nig-chip.on{border-color:var(--nv-accent,#3b82f6) !important;background:var(--nv-accent-soft,rgba(59,130,246,.14)) !important;color:var(--nv-accent-text,#60a5fa) !important}' +
        'html:root body #nig-root .nig-chip:active{transform:scale(.97)}' +
        '#nig-root .nig-shape{display:inline-block;border:1.5px solid currentColor;border-radius:3px;opacity:.85}' +
        '#nig-root .nig-seg{display:flex;padding:3px;border-radius:12px;background:var(--nv-card-2,#1e293b);margin-bottom:10px}' +
        'html:root body #nig-root .nig-seg button{flex:1;min-height:36px;border:0 !important;border-radius:9px;background:transparent !important;color:var(--nv-muted,#94a3b8) !important;font-size:13px;font-weight:700;cursor:pointer;box-shadow:none !important}' +
        'html:root body #nig-root .nig-seg button.on{background:var(--nv-card,#0f172a) !important;color:var(--nv-text,#f1f5f9) !important;box-shadow:var(--nv-shadow-sm,0 1px 2px rgba(0,0,0,.3)) !important}' +
        'html:root body #nig-root .nig-model{width:100%;text-align:left;display:flex;align-items:center;gap:10px;padding:10px 12px;margin-bottom:8px;border-radius:12px;border:1px solid var(--nv-line-strong,#334155) !important;background:transparent !important;color:var(--nv-text,#f1f5f9) !important;cursor:pointer;box-shadow:none !important}' +
        'html:root body #nig-root .nig-model:last-child{margin-bottom:0}' +
        'html:root body #nig-root .nig-model.on{border-color:var(--nv-accent,#3b82f6) !important;background:var(--nv-accent-soft,rgba(59,130,246,.14)) !important}' +
        '#nig-root .nig-dot{flex:0 0 18px;height:18px;border-radius:50%;border:2px solid var(--nv-line-strong,#334155)}' +
        '#nig-root .nig-model.on .nig-dot{border:5px solid var(--nv-accent,#3b82f6)}' +
        '#nig-root .nig-mn{font-size:14px;font-weight:700}' +
        '#nig-root .nig-md{font-size:12px;color:var(--nv-muted,#94a3b8);margin-top:2px;line-height:1.4}' +
        '#nig-root .nig-refs{display:flex;gap:8px;overflow-x:auto;padding:2px;scrollbar-width:none}' +
        '#nig-root .nig-refs::-webkit-scrollbar{display:none}' +
        '#nig-root .nig-ref{position:relative;flex:0 0 72px;height:72px;border-radius:12px;overflow:hidden;border:1px solid var(--nv-line-strong,#334155)}' +
        '#nig-root .nig-ref img{width:100%;height:100%;object-fit:cover;display:block}' +
        'html:root body #nig-root .nig-ref button{position:absolute;top:3px;right:3px;width:22px;height:22px;border-radius:50%;border:0 !important;background:rgba(0,0,0,.62) !important;color:#fff !important;font-size:12px;display:flex;align-items:center;justify-content:center;padding:0;cursor:pointer}' +
        'html:root body #nig-root .nig-add{flex:0 0 72px;height:72px;border-radius:12px;border:1.5px dashed var(--nv-line-strong,#334155) !important;background:transparent !important;color:var(--nv-muted,#94a3b8) !important;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;font-size:11px;cursor:pointer}' +
        'html:root body #nig-root .nig-add i{font-size:20px}' +
        '#nig-root .nig-hint{font-size:11.5px;color:var(--nv-faint,#7c8aa0);line-height:1.5;margin:6px 2px 0}' +
        '#nig-root .nig-bar{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:10px 12px calc(env(safe-area-inset-bottom,0px) + 10px);border-top:1px solid var(--nv-line,#1e293b);background:var(--nv-chrome,#0f172a)}' +
        '#nig-root .nig-sum{flex:1;min-width:0;font-size:12px;line-height:1.45;color:var(--nv-muted,#94a3b8)}' +
        '#nig-root .nig-sum b{display:block;color:var(--nv-text,#f1f5f9);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
        'html:root body #nig-root .nig-go{flex:0 0 auto;min-height:48px;padding:0 22px;border-radius:14px;border:0 !important;background:var(--nv-accent,#3b82f6) !important;color:var(--nv-on-accent,#fff) !important;font-size:16px;font-weight:800;display:inline-flex;align-items:center;gap:8px;cursor:pointer;box-shadow:0 4px 14px color-mix(in srgb,var(--nv-accent,#3b82f6) 35%,transparent) !important}' +
        'html:root body #nig-root .nig-go:active{transform:scale(.97)}' +
        'html:root body #nig-root .nig-go[disabled]{opacity:.55}' +
        '#nig-root .nig-res{display:grid;gap:10px;margin-bottom:12px}' +
        '#nig-root .nig-res.c1{grid-template-columns:1fr}#nig-root .nig-res.cN{grid-template-columns:1fr 1fr}' +
        '#nig-root .nig-img{position:relative;border-radius:14px;overflow:hidden;background:var(--nv-card-2,#1e293b);border:1px solid var(--nv-line,#1e293b)}' +
        '#nig-root .nig-img>img{display:block;width:100%;height:auto;cursor:zoom-in}' +
        '#nig-root .nig-ph{display:flex;align-items:center;justify-content:center;text-align:center;padding:16px;font-size:12px;color:var(--nv-muted,#94a3b8);min-height:140px;background:linear-gradient(110deg,var(--nv-card-2,#1e293b) 30%,var(--nv-accent-soft,rgba(59,130,246,.14)) 50%,var(--nv-card-2,#1e293b) 70%);background-size:220% 100%;animation:nigSh 1.6s linear infinite}' +
        '#nig-root .nig-ph.err{animation:none;background:var(--nv-card-2,#1e293b);color:var(--nv-danger,#ef4444);flex-direction:column;gap:6px;line-height:1.5}' +
        '@keyframes nigSh{0%{background-position:120% 0}100%{background-position:-120% 0}}' +
        '#nig-root .nig-acts{display:flex;gap:6px;padding:8px;background:var(--nv-card,#0f172a)}' +
        'html:root body #nig-root .nig-acts button{flex:1;min-height:36px;padding:0 4px;border-radius:10px;border:1px solid var(--nv-line-strong,#334155) !important;background:transparent !important;color:var(--nv-text-2,#cbd5e1) !important;font-size:11.5px;font-weight:600;cursor:pointer;display:inline-flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;white-space:nowrap;min-height:48px;box-shadow:none !important}' +
        '#nig-root .nig-acts button i{font-size:16px}' +
        'html:root body #nig-root .nig-acts button:active{background:var(--nv-active,rgba(148,163,184,.17)) !important}' +
        '#nig-root .nig-cnt{display:flex;gap:8px}' +
        'html:root body #nig-root .nig-cnt button{flex:1;min-height:40px;border-radius:12px;border:1px solid var(--nv-line-strong,#334155) !important;background:var(--nv-card-2,#1e293b) !important;color:var(--nv-text-2,#cbd5e1) !important;font-size:14px;font-weight:700;cursor:pointer;box-shadow:none !important}' +
        'html:root body #nig-root .nig-cnt button.on{border-color:var(--nv-accent,#3b82f6) !important;background:var(--nv-accent-soft,rgba(59,130,246,.14)) !important;color:var(--nv-accent-text,#60a5fa) !important}' +
        '#nig-root .nig-ov{position:absolute;inset:0;z-index:5;background:rgba(0,0,0,.88);display:flex;flex-direction:column}' +
        '#nig-root .nig-ov .nig-vimg{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:12px}' +
        '#nig-root .nig-ov img{max-width:100%;max-height:100%;object-fit:contain;border-radius:8px}' +
        'html:root body #nig-root .nig-ov .nig-ib{color:#fff !important;margin:calc(env(safe-area-inset-top,0px) + 8px) 8px 0 auto}' +
        '#nig-root .nig-sheet{position:absolute;left:0;right:0;bottom:0;max-height:78%;z-index:6;display:flex;flex-direction:column;background:var(--nv-chrome,#0f172a);border-radius:20px 20px 0 0;border-top:1px solid var(--nv-line,#1e293b);box-shadow:0 -12px 32px rgba(0,0,0,.35)}' +
        '#nig-root .nig-scrim{position:absolute;inset:0;z-index:5;background:rgba(0,0,0,.45)}' +
        '#nig-root .nig-hg{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:0 12px calc(env(safe-area-inset-bottom,0px) + 14px);overflow-y:auto}' +
        '#nig-root .nig-ht{aspect-ratio:1;border-radius:12px;overflow:hidden;background:var(--nv-card-2,#1e293b);border:1px solid var(--nv-line,#1e293b);cursor:pointer}' +
        '#nig-root .nig-ht img{width:100%;height:100%;object-fit:cover;display:block}' +
        '#nig-root .nig-empty{padding:28px 12px;text-align:center;color:var(--nv-muted,#94a3b8);font-size:13px}';

    function injectCss() {
        if (D.getElementById('nig-style')) return;
        var s = D.createElement('style'); s.id = 'nig-style'; s.textContent = CSS; D.head.appendChild(s);
    }

    /* ───────── 畫面 ───────── */
    function shape(r) {
        var p = r.split(':'), w = +p[0], h = +p[1], max = 20, ww, hh;
        if (w >= h) { ww = max; hh = Math.max(6, Math.round(max * h / w)); } else { hh = max; ww = Math.max(6, Math.round(max * w / h)); }
        return '<span class="nig-shape" style="width:' + ww + 'px;height:' + hh + 'px"></span>';
    }
    function summary() {
        var m = modelOf(P.model), d = dims(m, P.size, P.ratio), st = styleOf(P.style);
        var line1 = m.name + (P.count > 1 ? ' ×' + P.count : '');
        var size = m.sizes.length > 1 || m.cfg === 'size' ? SIZE_LABEL[P.size] + ' · ' : '';
        return '<b>' + esc(line1) + '</b>' + esc(P.ratio + ' · ' + size + '約 ' + d[0] + '×' + d[1] + (P.style !== 'auto' ? ' · ' + st.n : ''));
    }
    function resultsHtml() {
        if (!P.results.length) return '';
        var h = '<div class="nig-res ' + (P.results.length === 1 ? 'c1' : 'cN') + '">';
        P.results.forEach(function (r, i) {
            h += '<div class="nig-img">';
            if (r.state === 'busy') h += '<div class="nig-ph" style="aspect-ratio:' + P.ratio.replace(':', '/') + '">生成中…</div>';
            else if (r.state === 'err') h += '<div class="nig-ph err" style="aspect-ratio:' + P.ratio.replace(':', '/') + '"><span>⚠️ ' + esc(r.msg) + '</span></div>';
            else {
                h += '<img src="' + r.dataUri + '" alt="" data-act="view" data-i="' + i + '">' +
                    '<div class="nig-acts nv-keep">' +
                    '<button class="nv-keep" data-act="save" data-i="' + i + '"><i class="ph-bold ph-download-simple"></i>儲存</button>' +
                    '<button class="nv-keep" data-act="chat" data-i="' + i + '"><i class="ph-bold ph-chat-circle"></i>送對話</button>' +
                    '<button class="nv-keep" data-act="asref" data-i="' + i + '"><i class="ph-bold ph-image-square"></i>當參考</button></div>';
            }
            h += '</div>';
        });
        return h + '</div>';
    }
    function body() {
        var m = modelOf(P.model), h = '';
        h += '<div id="nig-results">' + resultsHtml() + '</div>';

        // a. 描述
        h += '<div class="nig-card"><div class="nig-lb">圖片描述<em id="nig-cc">' + P.prompt.length + ' 字</em></div>' +
            '<textarea id="nig-ta" class="nig-ta" placeholder="描述你想要的畫面：主體、場景、光線、氛圍、構圖…&#10;例如：清晨的海邊咖啡館，木質吧台，窗外有浪花，柔和的金色陽光">' + esc(P.prompt) + '</textarea></div>';

        // e. 參考圖
        h += '<div class="nig-card"><div class="nig-lb">參考圖片<em>' + P.refs.length + ' / ' + m.maxRef + '</em></div><div class="nig-refs">';
        P.refs.forEach(function (r, i) { h += '<div class="nig-ref"><img src="' + r.dataUri + '" alt=""><button class="nv-keep" data-act="rmref" data-i="' + i + '" aria-label="移除">✕</button></div>'; });
        if (P.refs.length < m.maxRef) h += '<button class="nig-add nv-keep" data-act="addref"><i class="ph-bold ph-plus"></i>新增</button>';
        h += '</div>' + (m.prov === 'grok' ? '<div class="nig-hint">Grok 有參考圖時走「圖片編輯」，輸出會沿用參考圖的比例，比例與解析度設定可能不生效。</div>' : '<div class="nig-hint">可上傳人物、商品或風格範例，描述裡可寫「把參考圖中的…改成…」。</div>') + '</div>';

        // b. 模型
        h += '<div class="nig-card"><div class="nig-lb">生圖模型</div><div class="nig-seg">' +
            '<button class="nv-keep' + (m.prov === 'gemini' ? ' on' : '') + '" data-act="prov" data-v="gemini">Gemini</button>' +
            '<button class="nv-keep' + (m.prov === 'grok' ? ' on' : '') + '" data-act="prov" data-v="grok">Grok</button></div>';
        MODELS.filter(function (x) { return x.prov === m.prov; }).forEach(function (x) {
            h += '<button class="nig-model nv-keep' + (x.id === P.model ? ' on' : '') + '" data-act="model" data-v="' + x.id + '"><span class="nig-dot"></span><span><div class="nig-mn">' + esc(x.name) + '</div><div class="nig-md">' + esc(x.desc) + '</div></span></button>';
        });
        h += '</div>';

        // f. 風格
        h += '<div class="nig-card"><div class="nig-lb">圖片風格</div><div class="nig-row">';
        STYLES.forEach(function (s) { h += '<button class="nig-chip nv-keep' + (s.id === P.style ? ' on' : '') + '" data-act="style" data-v="' + s.id + '"><span>' + s.e + '</span>' + esc(s.n) + '</button>'; });
        h += '</div></div>';

        // d. 比例
        h += '<div class="nig-card"><div class="nig-lb">圖片比例</div><div class="nig-row">';
        m.ratios.forEach(function (r) { h += '<button class="nig-chip nv-keep' + (r === P.ratio ? ' on' : '') + '" data-act="ratio" data-v="' + r + '">' + shape(r) + r + '</button>'; });
        h += '</div></div>';

        // c. 解析度
        h += '<div class="nig-card"><div class="nig-lb">解析度<em>此模型支援 ' + m.sizes.map(function (s) { return SIZE_LABEL[s]; }).join('／') + '</em></div><div class="nig-row">';
        m.sizes.forEach(function (s) { var d = dims(m, s, P.ratio); h += '<button class="nig-chip nv-keep' + (s === P.size ? ' on' : '') + '" data-act="size" data-v="' + s + '">' + SIZE_LABEL[s] + '<span style="opacity:.65;font-weight:500;font-size:11px">約 ' + d[0] + '×' + d[1] + '</span></button>'; });
        h += '</div>' + (m.sizes.length === 1 && m.prov === 'gemini' ? '<div class="nig-hint">這個模型只有單一解析度。</div>' : '') + '</div>';

        // 張數
        h += '<div class="nig-card"><div class="nig-lb">生成張數<em>每張各呼叫一次，額度照張數計算</em></div><div class="nig-cnt">';
        [1, 2, 3, 4].forEach(function (n) { h += '<button class="nv-keep' + (n === P.count ? ' on' : '') + '" data-act="count" data-v="' + n + '">' + n + '</button>'; });
        h += '</div></div>';
        return h;
    }
    function shell() {
        return '<div class="nig-top"><button class="nig-ib nv-keep" data-act="close" aria-label="關閉"><i class="ph-bold ph-x"></i></button>' +
            '<div class="nig-title">生圖模式<small>Gemini · Grok</small></div>' +
            '<button class="nig-ib nv-keep" data-act="hist" aria-label="歷史紀錄"><i class="ph-bold ph-clock-counter-clockwise"></i></button></div>' +
            '<div class="nig-scroll" id="nig-scroll"></div>' +
            '<div class="nig-bar"><div class="nig-sum" id="nig-sum"></div><button class="nig-go nv-keep" id="nig-go" data-act="go"></button></div>' +
            '<input type="file" id="nig-file" accept="image/*" multiple style="display:none">' +
            '<div id="nig-layer"></div>';
    }
    function goLabel() { return P.busy ? '生成中…' : (P.results.length ? '<i class="ph-bold ph-arrows-clockwise"></i>再生成' : '<i class="ph-bold ph-sparkle"></i>生成'); }
    function render() {
        if (!root) return;
        var sc = D.getElementById('nig-scroll'), top = sc ? sc.scrollTop : 0, ta = D.getElementById('nig-ta');
        if (ta) P.prompt = ta.value;
        sc.innerHTML = body();
        sc.scrollTop = top;
        D.getElementById('nig-sum').innerHTML = summary();
        var go = D.getElementById('nig-go'); go.innerHTML = goLabel(); go.disabled = P.busy;
        ta = D.getElementById('nig-ta');
        if (ta) { autosize(ta); ta.addEventListener('input', function () { P.prompt = ta.value; lsSet(DRAFT_KEY, P.prompt); var c = D.getElementById('nig-cc'); if (c) c.textContent = P.prompt.length + ' 字'; autosize(ta); }); }
    }
    function autosize(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(240, Math.max(112, ta.scrollHeight)) + 'px'; }

    /* ───────── 參考圖 ───────── */
    function readRef(file) {
        return new Promise(function (resolve) {
            var fr = new FileReader();
            fr.onload = function () {
                var img = new Image();
                img.onload = function () {
                    try {
                        var max = 1536, w = img.width, h = img.height, k = Math.min(1, max / Math.max(w, h));
                        var c = D.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
                        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                        resolve({ dataUri: c.toDataURL('image/jpeg', 0.9), name: file.name });
                    } catch (e) { resolve({ dataUri: fr.result, name: file.name }); }
                };
                img.onerror = function () { resolve(null); };
                img.src = fr.result;
            };
            fr.onerror = function () { resolve(null); };
            fr.readAsDataURL(file);
        });
    }
    async function addFiles(files) {
        var m = modelOf(P.model), left = m.maxRef - P.refs.length;
        if (left <= 0) { toast('此模型最多 ' + m.maxRef + ' 張參考圖'); return; }
        var list = Array.prototype.slice.call(files).slice(0, left);
        if (files.length > left) toast('此模型最多 ' + m.maxRef + ' 張參考圖，多的已略過');
        for (var i = 0; i < list.length; i++) { var r = await readRef(list[i]); if (r) P.refs.push(r); }
        render();
    }

    /* ───────── API ───────── */
    function buildPrompt(m, withRatioHint) {
        var t = P.prompt.trim(), st = styleOf(P.style), parts = [];
        if (t) parts.push(t);
        if (P.refs.length && m.prov === 'gemini') parts.push(t ? 'Use the attached reference image(s) as visual reference.' : 'Create a new image inspired by the attached reference image(s).');
        if (st.p) parts.push('Style: ' + st.p);
        if (withRatioHint) parts.push('Compose the image in a ' + P.ratio + ' aspect ratio.');
        return parts.join('\n\n');
    }
    function dataUriParts(u) { var mm = /^data:([^;]+);base64,(.*)$/.exec(u); return mm ? { mime: mm[1], data: mm[2] } : null; }
    async function post(url, headers, body) {
        var ctl = new AbortController(), to = setTimeout(function () { ctl.abort(); }, 300000);
        try {
            var res = await fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body), signal: ctl.signal });
            var txt = await res.text(), data = null;
            try { data = JSON.parse(txt); } catch (e) { /* 非 JSON */ }
            return { ok: res.ok, status: res.status, data: data, text: txt };
        } finally { clearTimeout(to); }
    }
    function errMsg(r) {
        var d = r.data; var m = d && d.error && (d.error.message || d.error) || (d && d.message) || r.text || ('HTTP ' + r.status);
        return String(typeof m === 'string' ? m : JSON.stringify(m)).slice(0, 220);
    }
    async function genGemini(m, key) {
        var parts = [];
        P.refs.slice(0, m.maxRef).forEach(function (r) { var p = dataUriParts(r.dataUri); if (p) parts.push({ inlineData: { mimeType: p.mime, data: p.data } }); });
        var stages = m.cfg === 'full' ? ['full', 'ratio', 'hint'] : ['ratio', 'hint'], warn = '', last = null;
        for (var s = 0; s < stages.length; s++) {
            var stage = stages[s], gc = { responseModalities: ['TEXT', 'IMAGE'] };
            if (stage === 'full') gc.imageConfig = { aspectRatio: P.ratio, imageSize: P.size };
            else if (stage === 'ratio') gc.imageConfig = { aspectRatio: P.ratio };
            var body = { contents: [{ role: 'user', parts: parts.concat([{ text: buildPrompt(m, stage === 'hint') }]) }], generationConfig: gc };
            var url = 'https://generativelanguage.googleapis.com/' + m.ver + '/models/' + m.id + ':generateContent?key=' + encodeURIComponent(key);
            var r = await post(url, { 'Content-Type': 'application/json' }, body);
            last = r;
            if (r.ok) {
                var d = r.data || {}, cand = d.candidates && d.candidates[0], ps = cand && cand.content && cand.content.parts || [], txt = '';
                for (var i = 0; i < ps.length; i++) {
                    var idn = ps[i].inlineData || ps[i].inline_data;
                    if (idn && idn.data) return { dataUri: 'data:' + (idn.mimeType || idn.mime_type || 'image/png') + ';base64,' + idn.data, warn: warn };
                    if (ps[i].text) txt += ps[i].text;
                }
                var why = (d.promptFeedback && d.promptFeedback.blockReason) || (cand && cand.finishReason && cand.finishReason !== 'STOP' ? cand.finishReason : '');
                throw new Error('模型沒有回傳圖片' + (why ? '（' + why + '，可能被安全審查擋下）' : '') + (txt ? '：' + txt.slice(0, 120) : '。請調整描述再試'));
            }
            if (r.status !== 400 || s === stages.length - 1) break;
            warn = s === 0 ? '此模型不接受解析度參數，已改用預設解析度' : '此模型不接受尺寸參數，已把比例寫進描述';
        }
        throw new Error(errMsg(last));
    }
    async function toDataUri(url) {
        var res = await fetch(url), blob = await res.blob();
        return await new Promise(function (ok, no) { var fr = new FileReader(); fr.onload = function () { ok(fr.result); }; fr.onerror = no; fr.readAsDataURL(blob); });
    }
    async function genGrok(m, key) {
        var useEdit = P.refs.length > 0, api, body;
        if (useEdit) {
            api = 'https://api.x.ai/v1/images/edits';
            body = { model: m.id, prompt: buildPrompt(m, false), response_format: 'b64_json', image: { url: P.refs[0].dataUri, type: 'image_url' } };
        } else {
            var d = dims(m, P.size, P.ratio);
            api = 'https://api.x.ai/v1/images/generations';
            body = { model: m.id, prompt: buildPrompt(m, false), response_format: 'b64_json', image_size: d[0] + 'x' + d[1] };
        }
        var r = await post(PROXY + '?url=' + encodeURIComponent(api), { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' }, body);
        if (!r.ok) throw new Error(errMsg(r));
        var it = r.data && r.data.data && r.data.data[0];
        if (!it) throw new Error('Grok 沒有回傳圖片');
        if (it.b64_json) return { dataUri: 'data:image/png;base64,' + it.b64_json, warn: useEdit && P.refs.length > 1 ? 'Grok 一次只用第 1 張參考圖' : '' };
        if (it.url) return { dataUri: await toDataUri(it.url), warn: '' };
        throw new Error('Grok 回傳格式無法辨識');
    }
    function stamp() { var n = new Date(), p = function (x) { return String(x).padStart(2, '0'); }; return n.getFullYear() + p(n.getMonth() + 1) + p(n.getDate()) + '_' + p(n.getHours()) + p(n.getMinutes()) + p(n.getSeconds()); }
    async function persist(item) {
        item.name = 'NOVA_IMG_' + stamp() + '_' + Math.random().toString(36).slice(2, 6) + '.png';
        try { if (W.NovaImageStore) { var s = await W.NovaImageStore.save(item.dataUri, item.name); if (s) item.ref = s.__fileRef; item.mime = s && s.mimeType; } } catch (e) { /* 保留記憶體內的圖 */ }
        if (item.ref) {
            try {
                var h = JSON.parse(lsGet(HIST_KEY, '[]')) || [];
                h.unshift({ ref: item.ref, name: item.name, mime: item.mime || 'image/png', prompt: P.prompt.trim().slice(0, 300), model: P.model, ratio: P.ratio, size: P.size, style: P.style, t: Date.now() });
                lsSet(HIST_KEY, JSON.stringify(h.slice(0, 24)));
            } catch (e) { /* ignore */ }
        }
    }
    async function generate() {
        if (P.busy) return;
        var ta = D.getElementById('nig-ta'); if (ta) P.prompt = ta.value;
        if (!P.prompt.trim() && !P.refs.length) { toast('請先輸入圖片描述，或上傳參考圖'); return; }
        var m = modelOf(P.model), A = W.appState || {}, key = A.keys && A.keys[m.prov];
        if (!key) { toast('尚未設定 ' + (m.prov === 'gemini' ? 'Gemini' : 'Grok') + ' API Key（設定 → 主要）', 4000); return; }
        P.busy = true; P.results = []; for (var i = 0; i < P.count; i++) P.results.push({ state: 'busy' });
        savePrefs(); render();
        var sc = D.getElementById('nig-scroll'); if (sc) sc.scrollTop = 0;
        var warns = {};
        await Promise.all(P.results.map(function (slot, idx) {
            return (async function () {
                try {
                    var out = m.prov === 'gemini' ? await genGemini(m, key) : await genGrok(m, key);
                    var item = { state: 'ok', dataUri: out.dataUri }; await persist(item); P.results[idx] = item;
                    if (out.warn) warns[out.warn] = 1;
                } catch (e) { P.results[idx] = { state: 'err', msg: (e && e.name === 'AbortError') ? '等待逾時，請重試' : (e && e.message) || String(e) }; }
                var box = D.getElementById('nig-results'); if (box) box.innerHTML = resultsHtml();
            })();
        }));
        P.busy = false; render();
        var w = Object.keys(warns)[0]; if (w) toast('ℹ️ ' + w, 4500);
    }

    /* ───────── 結果動作 ───────── */
    function sendToChat(i) {
        var r = P.results[i]; if (!r || r.state !== 'ok') return;
        var f = r.ref ? { category: 'image', __fileRef: r.ref, mimeType: r.mime || 'image/png', name: r.name } : { category: 'image', data: r.dataUri, name: r.name };
        var m = modelOf(P.model);
        try { W.addMessage('🎨 **生圖模式**｜' + (P.prompt.trim() || '（以參考圖生成）') + '\n\n' + m.name + ' · ' + P.ratio + (m.sizes.length > 1 ? ' · ' + SIZE_LABEL[P.size] : '') + (P.style !== 'auto' ? ' · ' + styleOf(P.style).n : ''), 'ai', P.model, [], f); toast('已送到目前對話'); close(); }
        catch (e) { toast('送到對話失敗：' + e.message); }
    }
    async function saveOne(i) {
        var r = P.results[i]; if (!r || r.state !== 'ok') return;
        try { if (typeof W.downloadDataUriFile === 'function') { var o = await W.downloadDataUriFile(r.dataUri, r.name); if (o && o.success === false) throw new Error(o.detail || '儲存失敗'); toast('✅ 已儲存：' + r.name); } else toast('已存在 NOVA_Images：' + r.name); }
        catch (e) { toast('儲存失敗：' + (e.message || e), 4000); }
    }
    function viewer(i) {
        var r = P.results[i]; if (!r) return;
        D.getElementById('nig-layer').innerHTML = '<div class="nig-ov"><button class="nig-ib nv-keep" data-act="vclose" aria-label="關閉"><i class="ph-bold ph-x"></i></button><div class="nig-vimg"><img src="' + r.dataUri + '" alt=""></div></div>';
    }
    async function histSheet() {
        var h = []; try { h = JSON.parse(lsGet(HIST_KEY, '[]')) || []; } catch (e) { /* ignore */ }
        var g = h.length ? '<div class="nig-hg">' + h.map(function (x, i) { return '<div class="nig-ht" data-act="hitem" data-i="' + i + '"><img data-ref="' + esc(x.ref) + '" alt=""></div>'; }).join('') + '</div>' : '<div class="nig-empty">還沒有生成紀錄</div>';
        D.getElementById('nig-layer').innerHTML = '<div class="nig-scrim" data-act="vclose"></div><div class="nig-sheet"><div class="nig-top" style="border:0;background:transparent;padding-top:12px"><div class="nig-title">最近生成</div><button class="nig-ib nv-keep" data-act="vclose" aria-label="關閉"><i class="ph-bold ph-x"></i></button></div>' + g + '</div>';
        var imgs = D.querySelectorAll('#nig-layer img[data-ref]');
        for (var k = 0; k < imgs.length; k++) (function (el) { W.NovaImageStore && W.NovaImageStore.resolveSrc(el.getAttribute('data-ref')).then(function (u) { if (u) el.src = u; }).catch(function () {}); })(imgs[k]);
    }
    function histPick(i) {
        var h = []; try { h = JSON.parse(lsGet(HIST_KEY, '[]')) || []; } catch (e) { /* ignore */ }
        var x = h[i]; if (!x) return;
        P.prompt = x.prompt || ''; lsSet(DRAFT_KEY, P.prompt);
        if (x.model) P.model = x.model; if (x.ratio) P.ratio = x.ratio; if (x.size) P.size = x.size; if (x.style) P.style = x.style;
        clamp(); savePrefs(); D.getElementById('nig-layer').innerHTML = ''; render(); toast('已帶入這張的描述與設定');
    }
    function asRef(i) {
        var r = P.results[i]; if (!r || r.state !== 'ok') return;
        var m = modelOf(P.model); if (P.refs.length >= m.maxRef) { toast('參考圖已達上限 ' + m.maxRef + ' 張'); return; }
        P.refs.push({ dataUri: r.dataUri, name: r.name }); render(); toast('已加入參考圖，可修改描述後再生成');
    }

    /* ───────── 事件 ───────── */
    function onClick(e) {
        var t = e.target.closest('[data-act]'); if (!t || !root.contains(t)) return;
        var a = t.getAttribute('data-act'), v = t.getAttribute('data-v'), i = +t.getAttribute('data-i');
        var ta = D.getElementById('nig-ta'); if (ta) P.prompt = ta.value;
        switch (a) {
            case 'close': close(); break;
            case 'vclose': D.getElementById('nig-layer').innerHTML = ''; break;
            case 'hist': histSheet(); break;
            case 'hitem': histPick(i); break;
            case 'go': generate(); break;
            case 'prov': { var cur = modelOf(P.model); if (cur.prov !== v) { P.model = MODELS.filter(function (x) { return x.prov === v; })[0].id; clamp(); savePrefs(); render(); } break; }
            case 'model': P.model = v; clamp(); savePrefs(); render(); break;
            case 'style': P.style = v; savePrefs(); render(); break;
            case 'ratio': P.ratio = v; savePrefs(); render(); break;
            case 'size': P.size = v; savePrefs(); render(); break;
            case 'count': P.count = +v; savePrefs(); render(); break;
            case 'addref': D.getElementById('nig-file').click(); break;
            case 'rmref': P.refs.splice(i, 1); render(); break;
            case 'view': viewer(i); break;
            case 'save': saveOne(i); break;
            case 'chat': sendToChat(i); break;
            case 'asref': asRef(i); break;
        }
    }

    /* ───────── 開關 ───────── */
    function build() {
        if (root) return;
        injectCss();
        root = D.createElement('div'); root.id = 'nig-root'; root.innerHTML = shell();
        D.body.appendChild(root);
        root.addEventListener('click', onClick);
        D.getElementById('nig-file').addEventListener('change', function (e) { var f = e.target.files; if (f && f.length) addFiles(f); e.target.value = ''; });
    }
    function open() {
        try { if (!P._loaded) { loadPrefs(); P._loaded = true; } build(); P.open = true; root.classList.add('nig-open'); render(); } catch (e) { console.warn('[NOVA][生圖] 開啟失敗', e); toast('生圖模式開啟失敗：' + e.message); }
    }
    function close() { if (!root) return; P.open = false; root.classList.remove('nig-open'); D.getElementById('nig-layer').innerHTML = ''; }

    W.NovaImageGen = { open: open, close: close, version: '1.0.0', _models: MODELS };
    W.openImageGen = open;
})();

/* nova-notes-pro.js — v1.1.0 (2026-10-11)
 * 手機版筆記本對標桌面版：富文本編輯器（字體大小/文字色/螢光筆/表格儲存格色/框線色/字型統一）、
 * 標籤、雙向連結、AI 建議相關筆記（向量相似度）、貼圖 OCR（文字/表格，可選 Gemini/Grok 模型）、
 * 筆記關聯圖譜、標籤篩選、單篇/跨筆記 AI 分析模式（含 ###TAGS###/###RELATED### 解析）。
 * 內容移植自 nova-desktop index.html（唯讀來源），並於本檔補上手機版缺少的輔助函式。
 * 載入位置：index.html 主腳本之後（同名函式以本檔為準）。
 *
 * 版本紀錄
 *   v1.1.1 2026-10-17  3D 函式庫載入網址升為 ?v=2（配合大腦圖譜移植；函式庫多開放 THREE 元件，介面不變）
 *   v1.1.0 2026-10-11  筆記 3D 圖譜：函式庫改本地打包（vendor/nova-graph3d.js，單一 three 實例，不需網路）、明確指定尺寸＋ResizeObserver、無 WebGL 或建立失敗改 2D 備援、顯示筆記／連結數；修正移植時漏宣告 _novaGraphInstance 造成的 ReferenceError（手機上整片空白的真正原因）
 *   v1.0.0 2026-10-11  首版：自桌面版移植編輯器/標籤/連結/OCR/圖譜/分析；補 4 個輔助函式（代理 fetch 直通、Gemini genCfg 直通）。
 */
(function () {
  /* 手機版輔助：Capacitor 的 fetch 已是原生（無 CORS），不需代理 */
  if (typeof window._novaLLMProxyFetch !== 'function') window._novaLLMProxyFetch = function (u, o) { return fetch(u, o); };
  if (typeof window._novaGrokImageProxyUrl !== 'function') window._novaGrokImageProxyUrl = function () { return ''; };
  if (typeof window._novaGeminiSanitizeGenCfg !== 'function') window._novaGeminiSanitizeGenCfg = function (m, c) { return c; };
  if (typeof window.appState !== 'undefined' || typeof appState !== 'undefined') {
    try {
      if (!Array.isArray(appState.selectedNoteIdsForAnalysis)) appState.selectedNoteIdsForAnalysis = [];
      if (appState.currentNoteTagFilter === undefined) appState.currentNoteTagFilter = null;
    } catch (_) {}
  }
})();

(function(){

        function _novaLoadScriptOnce(src) {
            return new Promise(function (resolve, reject) {
                if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
                const script = document.createElement('script');
                script.src = src;
                script.onload = function () { resolve(); };
                script.onerror = function () { reject(new Error('函式庫載入失敗，請確認網路連線後再試一次')); };
                document.head.appendChild(script);
            });
        }

        window.addNoteManually = function() {
            try {
                document.getElementById('edit-note-id').value = '';
                document.getElementById('edit-note-title').value = '';
                // ★ v3.30.130：新筆記一樣要同步「圖片自動辨識」開關的畫面
                // 狀態，這是跨筆記共用的全域設定，不是每篇筆記各自獨立。
                const ocrAutoToggle = document.getElementById('note-ocr-auto-toggle');
                if (ocrAutoToggle) ocrAutoToggle.checked = localStorage.getItem('nova_note_ocr_auto_enabled') !== '0';
                const contentEl = document.getElementById('edit-note-content');
                if (contentEl) contentEl.innerHTML = '';
                // ★ v3.30.121：新筆記一開始是空的，沒有表格，但把觀察者
                // 設起來，之後貼上/插入表格時會自動偵測到並加上拖曳把手，
                // 不需要另外處理「新筆記」跟「編輯既有筆記」兩條不同路徑。
                if (contentEl) _novaNoteSetupTableResizeObserver(contentEl);
                
                appState.editNoteImagesBase64 = [];
                const imgContainer = document.getElementById('edit-note-img-preview-container');
                if (imgContainer) {
                    imgContainer.innerHTML = '';
                    imgContainer.classList.add('hidden');
                    imgContainer.classList.remove('flex');
                }
                
                const folderSelect = document.getElementById('edit-note-folder');
                if (folderSelect && appState.noteFolders) {
                    folderSelect.innerHTML = appState.noteFolders.map(f => `<option value="${f}">${f}</option>`).join('');
                    folderSelect.value = appState.currentNoteFolder === '全部' ? '未分類' : appState.currentNoteFolder;
                }

                // ★ v3.30.128：新筆記一開始沒有標籤/連結，AI 建議相關筆記
                // 也用不到（還沒存檔、也不可能已經匯入向量資料庫），清空
                // 暫存陣列跟畫面即可。
                _novaEditingNoteTags = [];
                _novaEditingNoteLinks = [];
                renderNoteTagsChips();
                renderNoteLinksChips();
                const backlinksEl = document.getElementById('edit-note-backlinks-container');
                if (backlinksEl) backlinksEl.innerHTML = '';
                const linkSuggestEl = document.getElementById('edit-note-link-suggestions-container');
                if (linkSuggestEl) { linkSuggestEl.classList.add('hidden'); linkSuggestEl.innerHTML = ''; }
                
                const titleEl = document.getElementById('note-modal-title-text');
                if (titleEl) titleEl.innerText = "新增圖文筆記";
                
                const modal = document.getElementById('note-edit-modal');
                if (modal) {
                    modal.classList.remove('hidden');
                    modal.classList.add('flex');
                } else {
                    showToast("找不到編輯器視窗元件 (note-edit-modal)");
                }
            } catch(e) {
                showToast("開啟新增筆記時發生錯誤：" + e.message);
            }
        };

        // ── 全螢幕筆記內容編輯器 ────────────────────────────────────────
        window.openFullscreenEditor = function() {
            const noteContent = document.getElementById('edit-note-content');
            const noteTitle   = document.getElementById('edit-note-title');
            const fseEl       = document.getElementById('fullscreen-content-editor');
            const fseContent  = document.getElementById('fse-content');
            const fseTitle    = document.getElementById('fse-title');
            if (!fseEl || !noteContent) return;
            // 同步目前內容到全螢幕編輯器——用 _novaStripNoteEditorHelpers()
            // 先清掉主編輯器裡可能已經存在的表格拖曳把手，避免把手被複製
            // 進 fse-content 之後，兩邊的 MutationObserver 各自又疊加一輪
            // 新把手，變成同一個儲存格裡混著兩組座標系統不一致的把手。
            fseContent.innerHTML = _novaStripNoteEditorHelpers(noteContent.innerHTML);
            if (fseTitle) fseTitle.textContent = `✏️ ${noteTitle?.value || '筆記內容'}`;
            fseEl.classList.remove('hidden');
            // ★ v3.30.122：全螢幕編輯器現在也支援表格拖曳調整（見版本
            // 紀錄），內容複製進來之後要重新掛上觀察者/把手，不能只依賴
            // 主編輯器那邊的觀察者——兩個是各自獨立的 DOM 元素。
            _novaNoteSetupTableResizeObserver(fseContent);
            // 手機：滾到最頂並聚焦
            fseContent.focus();
            setTimeout(() => {
                fseContent.scrollTop = 0;
                fseContent.focus();
                // 移游標到末尾
                const range = document.createRange();
                const sel = window.getSelection();
                range.selectNodeContents(fseContent);
                range.collapse(false);
                sel.removeAllRanges();
                sel.addRange(range);
            }, 80);
        };

        // 把全螢幕編輯器目前的內容同步回主編輯器、關閉全螢幕——存檔
        // （saveFullscreenEditor）跟單純縮小視窗（collapseFullscreenEditor）
        // 共用的核心邏輯，差別只在要不要多顯示一句「記得按儲存筆記」的
        // 提示（縮小視窗不強調「儲存」這個字眼，避免使用者誤以為這樣就
        // 已經真的寫進資料庫了）。
        function _novaFseCollapseCore() {
            const fseContent  = document.getElementById('fse-content');
            const noteContent = document.getElementById('edit-note-content');
            if (fseContent && noteContent) {
                // 存回主編輯器前一樣要清掉這份內容裡的表格拖曳把手，理由
                // 跟 openFullscreenEditor() 那邊對稱——把手是每個編輯器
                // 各自的暫時性 UI，不應該互相複製。
                noteContent.innerHTML = _novaStripNoteEditorHelpers(fseContent.innerHTML);
                _novaNoteSetupTableResizeObserver(noteContent); // 複製回來的內容如果含表格，主編輯器這邊也要補上把手
            }
            closeFullscreenEditor();
        }

        window.saveFullscreenEditor = function() {
            _novaFseCollapseCore();
            showToast('✅ 內容已更新，請記得按「儲存筆記」完成儲存。');
        };

        // ★ v3.30.122：使用者回報全螢幕模式沒有「切換回原本視窗大小」的
        // 功能——「儲存」按鈕雖然功能上也會把內容同步回主編輯器再關閉
        // 全螢幕，但按鈕標示是「儲存」，容易讓人誤會成「這會直接把筆記
        // 存進資料庫」，因為真正會寫進 IndexedDB 的是主編輯器視窗裡的
        // 「儲存筆記」按鈕（saveNoteEdit()），這裡的「儲存」其實只是
        // 「把全螢幕的編輯結果帶回主編輯器」。新增這個語意明確、單純
        // 「縮小回原本視窗大小」的動作，內容一樣會保留（不是取消/捨棄），
        // 只是不使用「儲存」這個字眼，避免混淆兩種不同層級的「存」。
        window.collapseFullscreenEditor = function() {
            _novaFseCollapseCore();
        };

        window.closeFullscreenEditor = function() {
            const fseEl = document.getElementById('fullscreen-content-editor');
            if (fseEl) fseEl.classList.add('hidden');
        };

        window.openNoteEdit = function(id) {
            try {
                // 手機鍵盤彈出時自動滾動 modal 到 focused 欄位
                if (!window._noteModalVVListener) {
                    window._noteModalVVListener = true;
                    const vv = window.visualViewport;
                    if (vv) {
                        vv.addEventListener('resize', () => {
                            const modal = document.getElementById('note-edit-modal');
                            if (!modal || modal.classList.contains('hidden')) return;
                            const focused = modal.querySelector(':focus');
                            if (focused) {
                                setTimeout(() => focused.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 80);
                            }
                        });
                    }
                }
                const n = appState.notes.find(x => String(x.id) === String(id));
                if(!n) return;
                
                document.getElementById('edit-note-id').value = id;
                document.getElementById('edit-note-title').value = n.title || '';

                // ★ v3.30.99：每次開啟編輯視窗時，把「筆記圖形辨識模型」
                // 下拉選單同步成使用者上次選的值（存在 localStorage，跨筆記
                // 都共用同一個設定，不是每篇筆記各自獨立）；還沒選過就用
                // NOVA_GEMINI_MODEL_DEFAULT 當預設值。
                const ocrModelSel = document.getElementById('note-ocr-model-select');
                if (ocrModelSel) ocrModelSel.value = (typeof novaResolveSaved === 'function' ? novaResolveSaved : function (x) { return x; })(localStorage.getItem('nova_note_ocr_model') || NOVA_GEMINI_MODEL_DEFAULT);   // v3.60.0
                // ★ v3.30.130：同步「圖片自動辨識」開關的畫面狀態，預設
                // 開啟（localStorage 沒有值時視為開啟，維持既有行為）。
                const ocrAutoToggle = document.getElementById('note-ocr-auto-toggle');
                if (ocrAutoToggle) ocrAutoToggle.checked = localStorage.getItem('nova_note_ocr_auto_enabled') !== '0';

                const contentEl = document.getElementById('edit-note-content');
                if (contentEl) {
                    if (n.isHtml) contentEl.innerHTML = n.content || '';
                    else contentEl.innerText = n.content || '';
                    // ★ v3.30.121：既有筆記如果本來就含有表格（例如舊筆記、
                    // 或從其他裝置同步過來的），開啟編輯時就要立刻可以拖曳
                    // 調整，不用等使用者自己先動一下內容才觸發。
                    _novaNoteSetupTableResizeObserver(contentEl);
                }
                
                const folderSelect = document.getElementById('edit-note-folder');
                if (folderSelect && appState.noteFolders) {
                    folderSelect.innerHTML = appState.noteFolders.map(f => `<option value="${f}">${f}</option>`).join('');
                    folderSelect.value = n.folder || '未分類';
                }

                // ★ v3.30.128：標籤／雙向連結初始化——把這則筆記既有的
                // tags/links 載進編輯用的暫存陣列，畫面上渲染出來；
                // backlinks 是現掃的，不需要初始化，直接渲染。
                _novaEditingNoteTags = Array.isArray(n.tags) ? n.tags.slice() : [];
                _novaEditingNoteLinks = Array.isArray(n.links) ? n.links.slice() : [];
                renderNoteTagsChips();
                renderNoteLinksChips();
                renderNoteBacklinksChips(id);
                const linkSuggestEl = document.getElementById('edit-note-link-suggestions-container');
                if (linkSuggestEl) { linkSuggestEl.classList.add('hidden'); linkSuggestEl.innerHTML = ''; }
                
                appState.editNoteImagesBase64 = [...(n.images || (n.image ? [n.image] : []))];
                const imgContainer = document.getElementById('edit-note-img-preview-container');
                if(imgContainer) {
                    if(appState.editNoteImagesBase64.length > 0) {
                        imgContainer.innerHTML = appState.editNoteImagesBase64.map((img, idx) => `<div class="relative"><img src="${img}" class="h-16 w-auto rounded border border-slate-700 object-cover"><button onclick="removeNoteEditImage(${idx})" class="absolute -top-2 -right-2 bg-red-600 rounded-full p-1 shadow hover:bg-red-500 flex items-center justify-center"><i class="ph-bold ph-x text-white text-xs"></i></button></div>`).join('');
                        imgContainer.classList.remove('hidden'); 
                        imgContainer.classList.add('flex');
                    } else { 
                        imgContainer.innerHTML = ''; 
                        imgContainer.classList.add('hidden'); 
                        imgContainer.classList.remove('flex');
                    }
                }
                
                const titleEl = document.getElementById('note-modal-title-text');
                if (titleEl) titleEl.innerText = "檢視與編輯筆記";

                // 錄音筆記：顯示播放器（含同群組所有分段）
                const audioArea = document.getElementById('edit-note-audio-area');
                const audioPlayer = document.getElementById('edit-note-audio-player');
                const audioActions = document.getElementById('edit-note-audio-actions');
                if (audioArea && audioPlayer && audioActions) {
                    if (n.type === 'audio') {
                        audioArea.classList.remove('hidden');

                        // 找出同群組所有段，按時間排序
                        const noteGid = n.groupId || n.id;
                        const noteSegs = appState.notes
                            .filter(x => (x.groupId || x.id) === noteGid && x.type === 'audio')
                            .sort((a, b) => a.id - b.id);

                        // 動態替換播放器區為多段列表
                        const playersContainer = audioArea.querySelector('.modal-audio-players') || (() => {
                            const div = document.createElement('div');
                            div.className = 'modal-audio-players space-y-1 mb-2';
                            audioPlayer.parentNode.insertBefore(div, audioPlayer);
                            audioPlayer.style.display = 'none'; // 隱藏原本的單一播放器
                            return div;
                        })();

                        // 清除舊播放器並建立新的
                        playersContainer.innerHTML = noteSegs.map((seg, i) => `
                            <div class="flex items-center gap-2">
                                ${noteSegs.length > 1 ? `<span class="text-[10px] text-purple-300 shrink-0 w-10 font-bold">第${i+1}段</span>` : ''}
                                <audio id="modal-audio-${seg.id}" controls class="flex-1 h-9 rounded-lg bg-slate-900 shadow-inner min-w-0"></audio>
                                ${seg.duration ? `<span class="text-[10px] text-slate-600 shrink-0">${Math.floor(seg.duration/60)}m${seg.duration%60}s</span>` : ''}
                            </div>`).join('');

                        // 異步載入每段的 Blob URL
                        noteSegs.forEach(async (seg) => {
                            const el = document.getElementById(`modal-audio-${seg.id}`);
                            if (!el) return;
                            let blob = await loadAudioBlob(seg.id);
                            if (!blob && seg.audioData) blob = base64ToBlob(seg.audioData);
                            if (blob) el.src = URL.createObjectURL(blob);
                        });

                        // 操作按鈕
                        const segIdsForModal = `[${noteSegs.map(s => `'${s.id}'`).join(',')}]`;
                        const aiLabel = noteSegs.length > 1 ? `AI 分析 (全 ${noteSegs.length} 段)` : 'AI 分析';
                        audioActions.innerHTML = `
                            <button onclick="batchDownloadWeba(${segIdsForModal}, 'note')" class="flex items-center gap-1 text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 border border-slate-600 px-3 py-1.5 rounded-lg transition-colors"><i class="ph-bold ph-download-simple"></i> weba${noteSegs.length>1?` (${noteSegs.length})`:''}</button>
                            <button onclick="batchDownloadMp3(${segIdsForModal}, 'note')" class="flex items-center gap-1 text-xs bg-slate-700 hover:bg-slate-600 text-green-300 border border-green-700/50 px-3 py-1.5 rounded-lg transition-colors"><i class="ph-bold ph-file-audio"></i> MP3${noteSegs.length>1?` (${noteSegs.length})`:''}</button>
                            <button onclick="closeNoteEdit(); summarizeVoiceNote('${n.id}');" class="flex items-center gap-1 text-xs bg-purple-700 hover:bg-purple-600 text-white px-3 py-1.5 rounded-lg transition-colors"><i class="ph-bold ph-sparkle"></i> ${aiLabel}</button>`;
                    } else {
                        audioArea.classList.add('hidden');
                        audioPlayer.style.display = '';
                        audioPlayer.src = '';
                        audioActions.innerHTML = '';
                        const old = audioArea.querySelector('.modal-audio-players');
                        if (old) old.innerHTML = '';
                    }
                }
                
                const modal = document.getElementById('note-edit-modal');
                if (modal) {
                    modal.classList.remove('hidden');
                    modal.classList.add('flex');
                } else {
                    showToast("找不到編輯器視窗元件 (note-edit-modal)");
                }
            } catch(e) {
                showToast("開啟筆記時發生錯誤：" + e.message);
            }
        };

        window.closeNoteEdit = function() { 
            const modal = document.getElementById('note-edit-modal');
            if (modal) {
                modal.classList.add('hidden'); 
                modal.classList.remove('flex');
            }
            // ★ v3.30.130：關閉編輯視窗時，順便把可能還飄在畫面上的
            // 「辨識這張圖片」浮動按鈕收起來，避免使用者關掉筆記後，
            // 按鈕還顯示在畫面上某個位置、點了卻沒有對應的圖片可以轉換。
            if (typeof window._novaHideImageOcrBar === 'function') window._novaHideImageOcrBar();
        };

        // ════════════════════════════════════════════════════════════
        // ★ v3.30.121：筆記本格式化功能——字體大小、文字顏色、螢光筆
        // 顏色/去除、字型自動統一、表格欄寬/列高拖曳調整。全部透過既有
        // 的 document.execCommand()（跟這個檔案裡插入圖片/YouTube 用的
        // 是同一套機制）或直接操作 DOM/style 完成，不需要引入額外的
        // 富文本編輯器套件。
        //
        // 第 4 項「同步時同步以上改變」不需要另外寫程式碼：這些格式
        // 最終都只是 #edit-note-content 這個 contenteditable 區塊
        // innerHTML 裡的 inline style，saveNoteEdit() 存檔時整份
        // content 一起存進 note.content，跨裝置同步引擎（v3.30.115）
        // 本來就是整份 note.content 一起同步——格式改變只是這個字串
        // 裡多了幾個 style 屬性，對同步邏輯來說完全透明，不需要額外
        // 處理。唯一需要額外處理的是table 拖曳把手這種「暫時性 UI
        // 元素」不應該被存進去、同步出去（見下方
        // _novaStripNoteEditorHelpers()）。
        // ════════════════════════════════════════════════════════════
        // ★ v3.30.122：使用者要求把工具列/表格拖曳也加進全螢幕編輯模式
        // （#fse-content）——原本這幾個函式寫死操作 #edit-note-content，
        // 這裡改成接受 targetId 參數（預設仍是 'edit-note-content'，維持
        // 主編輯器既有的 onclick 呼叫方式不用改），全螢幕編輯器的工具列
        // 按鈕會明確傳 'fse-content'，兩邊共用同一套邏輯，不用維護兩份。
        // ★ v3.30.124：使用者回報「文字顏色」「螢光筆」選色後常常改不到
        // 顏色——原因是點下 <input type="color"> 會把焦點從 contenteditable
        // 編輯區搶走去開啟系統原生的選色視窗，選完顏色、onchange 觸發時，
        // 編輯區原本反白選取的文字範圍（Selection/Range）早就已經遺失或
        // 被瀏覽器重置掉了；這時候即使呼叫 el.focus() 把焦點移回編輯區，
        // 也只是把游標移到某個預設位置（通常是開頭或上次游標處），不是
        // 原本使用者選取的那段文字，所以 execCommand 套用顏色時常常套用到
        // 錯的地方或完全沒有反應。
        // 修法：在每個工具列控制項「即將搶走焦點的那一刻」（mousedown，
        // 這時候原本的選取範圍還沒被破壞）先把目前的 Range 存下來，等到
        // 真正要套用格式時（onchange/onclick 觸發），先把存下來的 Range
        // 還原回 Selection，再呼叫 execCommand——確保套用的一定是使用者
        // 點工具列按鈕「當下」選取的那段文字，不受中間跳出選色視窗這種
        // 會搶走焦點的操作影響。這個修法套用到全部工具列控制項（字體
        // 大小/文字顏色/螢光筆/去除螢光筆/字型自動統一），不只是顏色類
        // 的，因為任何一個都可能發生同樣的焦點/選取範圍遺失問題。
        let _novaNoteSavedRange = null;

        window._novaNoteSaveSelection = function () {
            const sel = window.getSelection();
            if (sel && sel.rangeCount > 0) {
                _novaNoteSavedRange = sel.getRangeAt(0).cloneRange();
            }
        };

        function _novaNoteRestoreSelection() {
            if (!_novaNoteSavedRange) return false;
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(_novaNoteSavedRange);
            return true;
        }

        window._novaNoteApplyFontSize = function (px, targetId) {
            if (!px) return;
            const el = document.getElementById(targetId || 'edit-note-content');
            if (!el) return;
            el.focus();
            _novaNoteRestoreSelection();
            // ★ v3.30.125：使用者回報字體大小選什麼都沒有作用。根本原因：
            // 這裡跟顏色/螢光筆共用同一份程式碼邏輯，之前誤把
            // styleWithCSS 開成 true——但 Chromium 的 execCommand('fontSize')
            // 在 styleWithCSS=true 時，行為會從「產生 <font size="7">
            // 標籤」變成「直接產生 <span style="font-size:xx-large">
            // 這種固定的 7 級 CSS 關鍵字大小」，不是使用者實際選的 px
            // 數值，而且完全不會有 <font size="7"> 標籤可以讓下面的
            // querySelectorAll 找到、轉換成正確的 px 值——等於整個轉換
            // 邏輯落空，套用了也看不出使用者選的那個確切大小，容易被
            // 誤以為「完全沒有作用」。而且 styleWithCSS 這個旗標是
            // document 層級的持久狀態，只要之前點過一次顏色/螢光筆
            // （會把它設成 true），之後字體大小就會一直受影響，不是
            // 只有第一次會發生。
            // 修法：呼叫 fontSize 之前明確關掉 styleWithCSS，強制回到
            // 會產生 <font size="7"> 標籤的舊版行為，跟下面「找標籤轉
            // px」的邏輯搭配才會正確運作；顏色/螢光筆維持原本開啟
            // styleWithCSS 的做法不受影響（互不干擾，各自在呼叫前
            // 設成自己需要的狀態）。
            document.execCommand('styleWithCSS', false, false);
            // execCommand('fontSize', ...) 只支援 1~7 這種舊式相對大小，
            // 不能直接指定像素值——用「先標記成 size=7，再把標記出來的
            // <font size="7"> 轉成 style="font-size:Npx" 的 <span>」這個
            // 通用做法，Chromium（WebView2 底層引擎）對這個轉換模式支援
            // 良好，是業界常見的 WYSIWYG 編輯器 workaround，但前提是
            // styleWithCSS 必須是 false，見上方說明。
            document.execCommand('fontSize', false, '7');
            el.querySelectorAll('font[size="7"]').forEach(function (f) {
                const span = document.createElement('span');
                span.style.fontSize = px + 'px';
                while (f.firstChild) span.appendChild(f.firstChild);
                f.replaceWith(span);
            });
        };

        window._novaNoteApplyTextColor = function (color, targetId) {
            const el = document.getElementById(targetId || 'edit-note-content');
            if (!el) return;
            el.focus();
            _novaNoteRestoreSelection();
            document.execCommand('styleWithCSS', false, true);
            document.execCommand('foreColor', false, color);
        };

        window._novaNoteApplyHighlight = function (color, targetId) {
            const el = document.getElementById(targetId || 'edit-note-content');
            if (!el) return;
            el.focus();
            _novaNoteRestoreSelection();
            document.execCommand('styleWithCSS', false, true);
            // hiliteColor 是 Chromium/Firefox 支援的標準指令名稱；少數
            // 環境只認得舊名 backColor，兩個都試一次。
            const ok = document.execCommand('hiliteColor', false, color);
            if (!ok) document.execCommand('backColor', false, color);
        };

        window._novaNoteClearHighlight = function (targetId) {
            const el = document.getElementById(targetId || 'edit-note-content');
            if (!el) return;
            el.focus();
            _novaNoteRestoreSelection();
            document.execCommand('styleWithCSS', false, true);
            // 「去除螢光筆」＝把背景色設回透明，跟 Word/Google 文件
            // 「無螢光筆色」的做法一致。
            const ok = document.execCommand('hiliteColor', false, 'transparent');
            if (!ok) document.execCommand('backColor', false, 'transparent');
        };

        // ★ v3.30.136：使用者要求可以編輯表格「儲存格底色」跟「框線
        // 顏色」——這兩個是表格專屬的格式，跟一般文字的顏色/螢光筆是
        // 不同層級的東西（螢光筆是選取範圍內文字的背景色，這裡要調的是
        // 整個儲存格、或整張表格框線的顏色，不需要先選取文字，只要
        // 游標點在儲存格/表格裡面就可以套用）。共用同一套
        // _novaNoteSaveSelection()／_novaNoteRestoreSelection() 選取範圍
        // 保存機制（點色盤一樣會搶走 contenteditable 的焦點，道理跟
        // v3.30.124 修文字顏色/螢光筆選了沒反應是同一個原因），差別是
        // 這裡不是直接對選取範圍的文字套用格式，而是先找出選取位置
        // 「所在的」<td>/<th> 或 <table>，再對那個元素本身套用樣式。
        function _novaNoteFindAncestorInSelection(selector, el) {
            _novaNoteRestoreSelection();
            const sel = window.getSelection();
            if (!sel || sel.rangeCount === 0) return null;
            let node = sel.getRangeAt(0).startContainer;
            if (node.nodeType === 3) node = node.parentElement; // 文字節點要先取父元素才能呼叫 closest()
            if (!node || typeof node.closest !== 'function') return null;
            const found = node.closest(selector);
            return (found && el.contains(found)) ? found : null;
        }

        window._novaNoteApplyCellColor = function (color, targetId) {
            const el = document.getElementById(targetId || 'edit-note-content');
            if (!el) return;
            el.focus();
            const cell = _novaNoteFindAncestorInSelection('td, th', el);
            if (!cell) { showToast('請先把游標點進表格的某個儲存格裡，再選擇底色'); return; }
            cell.style.backgroundColor = color;
        };

        window._novaNoteApplyTableBorderColor = function (color, targetId) {
            const el = document.getElementById(targetId || 'edit-note-content');
            if (!el) return;
            el.focus();
            const table = _novaNoteFindAncestorInSelection('table', el);
            if (!table) { showToast('請先把游標點進表格裡，再選擇框線顏色'); return; }
            // 只改邊框「顏色」這個部分——用 style.borderColor 而不是整個
            // 重寫 border 這個 shorthand，這樣原本每個儲存格各自的邊框
            // 寬度/樣式（實線/虛線）都不會被動到，只有顏色換掉。表格
            // 產生時（_novaMdTableToHtml()／OCR 轉出的表格）本來就是每個
            // <td>/<th> 各自帶 inline 的 border 樣式，不是表格層級的共用
            // CSS 規則，所以這裡要逐一改每個儲存格，不能只改 <table>
            // 本身。
            table.querySelectorAll('td, th').forEach(function (c) { c.style.borderColor = color; });
        };

        window._novaNoteUnifyFont = function (targetId) {
            const el = document.getElementById(targetId || 'edit-note-content');
            if (!el) return;
            // 筆記內容常常是從不同網頁貼上湊起來的，每一段可能各自帶著
            // 來源網站的字型設定（inline style="font-family:..." 或舊式
            // <font face="...">），讀起來不一致。這裡只清掉字型相關的
            // 設定，不影響已經套用過的字體大小/顏色/螢光筆（那些是
            // style 裡各自獨立的屬性）。
            el.querySelectorAll('[style]').forEach(function (node) {
                node.style.fontFamily = '';
                if (!node.getAttribute('style')) node.removeAttribute('style');
            });
            el.querySelectorAll('font[face]').forEach(function (node) { node.removeAttribute('face'); });
            showToast('✅ 已將筆記內容統一成同一種字型');
        };

        // ── 表格欄寬/列高拖曳調整 ──────────────────────────────────
        // 在每個表格儲存格右邊界放一個垂直把手（拖曳調整該欄寬度，套用到
        // 整欄所有列）、下邊界放一個水平把手（拖曳調整該列高度，套用到
        // 該 <tr>）。把手用 contenteditable="false" 標記，不會被當成
        // 筆記文字內容編輯；存檔前會被 _novaStripNoteEditorHelpers()
        // 清掉，不會留在存進資料庫、參與跨裝置同步的 note.content 裡。
        const NOVA_TBL_HANDLE_CLASS = 'nova-tbl-resize-handle';

        function _novaTblCellIndex(cell) {
            return Array.prototype.indexOf.call(cell.parentElement.children, cell);
        }

        // ★ v3.30.126：使用者要求表格欄寬調整要跟 Word 的反應一致——Word
        // 拖曳兩欄之間的邊界時，是「此消彼長」：左邊那一欄變寬多少，緊鄰
        // 的右邊那一欄就跟著變窄多少，兩欄加起來的寬度、整個表格的總
        // 寬度都維持不變；只有拖曳表格最右邊那條邊界（沒有下一欄可以
        // 補償）時，才會真的改變表格整體寬度。原本的做法是「只讓被拖的
        // 這一欄變寬，其他欄不動、表格自己跟著變寬」，跟 Word 的直覺不
        // 一樣，這裡改成對應 Word 的行為。
        function _novaTblStartColResize(ev, table, cell) {
            ev.preventDefault(); ev.stopPropagation();
            const row = cell.parentElement;
            const colIndex = _novaTblCellIndex(cell);
            const nextCellInRow = row.children[colIndex + 1] || null;
            const hasNextColumn = !!nextCellInRow;
            const startX = ev.clientX;
            const startWidth = cell.offsetWidth;
            const startNextWidth = hasNextColumn ? nextCellInRow.offsetWidth : 0;
            const MIN_W = 30;
            function onMove(e) {
                let delta = e.clientX - startX;
                if (hasNextColumn) {
                    // 補償模式：這一欄跟下一欄的寬度總和維持不變，把拖曳
                    // 距離限制在「兩欄都不會小於最小寬度」的範圍內。
                    delta = Math.max(delta, -(startWidth - MIN_W));
                    delta = Math.min(delta, startNextWidth - MIN_W);
                    const newWidth = startWidth + delta;
                    const newNextWidth = startNextWidth - delta;
                    table.querySelectorAll('tr').forEach(function (tr) {
                        const c = tr.children[colIndex];
                        const cNext = tr.children[colIndex + 1];
                        if (c) c.style.width = newWidth + 'px';
                        if (cNext) cNext.style.width = newNextWidth + 'px';
                    });
                } else {
                    // 拖的是表格最右邊那條邊界，沒有下一欄可以補償——這時候
                    // 改變的是整個表格的總寬度，也是 Word 對最右邊界的處理
                    // 方式。
                    const newWidth = Math.max(MIN_W, startWidth + delta);
                    table.querySelectorAll('tr').forEach(function (tr) {
                        const c = tr.children[colIndex];
                        if (c) c.style.width = newWidth + 'px';
                    });
                }
            }
            function onUp() {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            }
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        }

        // 列高維持原本的做法——Word 的列高調整本來就是各列各自獨立，
        // 拖曳一列不會影響其他列，不需要跟欄寬一樣做補償。
        function _novaTblStartRowResize(ev, row) {
            ev.preventDefault(); ev.stopPropagation();
            const startY = ev.clientY;
            const startHeight = row.offsetHeight;
            function onMove(e) {
                const newHeight = Math.max(20, startHeight + (e.clientY - startY));
                row.style.height = newHeight + 'px';
            }
            function onUp() {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            }
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        }

        function _novaMakeTablesResizable(container) {
            if (!container) return;
            container.querySelectorAll('table').forEach(function (table) {
                table.style.tableLayout = 'fixed';
                table.querySelectorAll('td, th').forEach(function (cell) {
                    if (!cell.style.position) cell.style.position = 'relative';
                    // 避免同一個儲存格重複加把手（例如 MutationObserver
                    // 對同一批內容連續觸發好幾次）。
                    if (!cell.querySelector('.' + NOVA_TBL_HANDLE_CLASS + '-col')) {
                        const colHandle = document.createElement('span');
                        colHandle.className = NOVA_TBL_HANDLE_CLASS + ' ' + NOVA_TBL_HANDLE_CLASS + '-col';
                        colHandle.contentEditable = 'false';
                        colHandle.title = '拖曳調整欄寬';
                        colHandle.style.cssText = 'position:absolute; top:0; right:-3px; width:6px; height:100%; cursor:col-resize; z-index:5; user-select:none;';
                        cell.appendChild(colHandle);
                        colHandle.addEventListener('mousedown', function (ev) { _novaTblStartColResize(ev, table, cell); });
                    }
                    if (!cell.querySelector('.' + NOVA_TBL_HANDLE_CLASS + '-row')) {
                        const rowHandle = document.createElement('span');
                        rowHandle.className = NOVA_TBL_HANDLE_CLASS + ' ' + NOVA_TBL_HANDLE_CLASS + '-row';
                        rowHandle.contentEditable = 'false';
                        rowHandle.title = '拖曳調整列高';
                        rowHandle.style.cssText = 'position:absolute; left:0; bottom:-3px; height:6px; width:100%; cursor:row-resize; z-index:5; user-select:none;';
                        cell.appendChild(rowHandle);
                        rowHandle.addEventListener('mousedown', function (ev) { _novaTblStartRowResize(ev, cell.parentElement); });
                    }
                });
            });
        }

        // 用 MutationObserver 而不是在每個「可能插入表格」的地方各自呼叫
        // 一次——筆記內容插入表格的管道很多（直接貼上、OCR 辨識結果轉出、
        // 使用者自己手動 insertHTML），與其每個管道都要記得補呼叫，不如
        // 在編輯器層級統一監看「有沒有新的表格出現」，不管表格是怎麼
        // 進來的都會自動處理，比較不容易漏掉、之後新增別的插入管道也不用
        // 記得同步修改這裡。函式本身是 idempotent（見上面「避免重複加
        // 把手」的檢查），重複呼叫不會累加、不會無限迴圈。
        function _novaNoteSetupTableResizeObserver(container) {
            // ★ v3.30.130：這個函式原本只處理表格拖曳把手，這次擴充成
            // 「內容變化時要重新掃描的雜項」共用入口，一併負責掃描/補上
            // OCR 參考縮圖區塊的「刪除原圖」按鈕（見
            // window._novaNoteEnsureOcrDeleteButtons() 的說明）——沒有
            // 另外拉一個新的 MutationObserver，同一個觀察者、同一次
            // debounce 觸發就把兩件事都做完，不需要重複監聽同一個
            // container 兩次。
            const _runAllScans = function () {
                _novaMakeTablesResizable(container);
                if (typeof window._novaNoteEnsureOcrDeleteButtons === 'function') window._novaNoteEnsureOcrDeleteButtons(container);
            };
            if (!container || container._novaTblObserver) {
                if (container) _runAllScans(); // 已存在觀察者，至少處理一次目前的內容
                return;
            }
            const observer = new MutationObserver(function () {
                clearTimeout(container._novaTblObserverTimer);
                container._novaTblObserverTimer = setTimeout(_runAllScans, 150);
            });
            observer.observe(container, { childList: true, subtree: true });
            container._novaTblObserver = observer;
            _runAllScans();
        }

        // 存檔前呼叫——把加進去的拖曳把手 DOM 節點清掉，不要把這些暫時性
        // UI 元素存進 note.content（那樣下次開啟會變成看得到、點了沒作用
        // 的殘留節點，而且會一直疊加，也會被不必要地同步到其他裝置）。
        // 用複製一份再清理的方式，不動到畫面上正在顯示的實際 DOM。
        // ════════════════════════════════════════════════════════════
        // ★ v3.31.69：筆記編輯器的「貼上」輔助函式（背景與根因見檔頭 v3.31.69）
        // ════════════════════════════════════════════════════════════
        // 只有「整段貼上的內容就是單一一個 YouTube 連結」才回傳 match（[完整, 影片代碼]）；文字中間有連結、多行、多個連結都回傳 null。
        function _novaPastedYoutubeMatch(plainText) {
            const t = String(plainText == null ? '' : plainText).trim();
            if (!t || /\s/.test(t)) return null;
            return t.match(/^(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]+)(?:[&?#]\S*)?$/);
        }

        // 在筆記編輯器自己複製／剪下的內容，貼回編輯器時要保留原本的顏色（工具列設定的顏色不能被洗掉）。
        function _novaNormClipText(t) { return String(t == null ? '' : t).replace(/\s+/g, ' ').trim(); }
        function _novaRememberInternalClip() {
            try { const sel = window.getSelection(); window._novaInternalClip = { text: _novaNormClipText(sel ? sel.toString() : ''), t: Date.now() }; } catch (e) {}
        }
        function _novaIsInternalClip(plainText) {
            const c = window._novaInternalClip;
            return !!(c && c.text && (Date.now() - c.t) < 30 * 60 * 1000 && c.text === _novaNormClipText(plainText));
        }

        // 行內樣式清理：拿掉文字色與背景；邊框／外框的顏色換成 currentColor（黑夜、白天兩種主題都看得到）；其他一律保留。
        // 用「括號與引號感知」的方式切宣告，url(data:…;base64,…) 與 font-family: "A;B" 裡的分號不會被誤切。
        const NOVA_PASTE_COLOR_TOKENS = /#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)|\b(?:black|white|gray|grey|silver|red|green|blue|yellow|orange|purple|navy|teal|maroon|olive|lime|aqua|fuchsia)\b/gi;
        const NOVA_PASTE_DROP_PROPS = { 'color': 1, 'background': 1, 'background-color': 1, 'background-image': 1, '-webkit-text-fill-color': 1 };
        function _novaSplitCssDecls(text) {
            const out = []; let cur = '', depth = 0, q = '';
            for (let i = 0; i < text.length; i++) {
                const ch = text[i];
                if (q) { cur += ch; if (ch === q && text[i - 1] !== '\\') q = ''; continue; }
                if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
                if (ch === '(') depth++; else if (ch === ')') depth = Math.max(0, depth - 1);
                if (ch === ';' && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
                cur += ch;
            }
            if (cur.trim()) out.push(cur.trim());
            return out;
        }
        function _novaCleanInlineStyle(styleText) {
            return _novaSplitCssDecls(String(styleText == null ? '' : styleText)).map(function (decl) {
                const i = decl.indexOf(':'); if (i < 0) return '';
                const prop = decl.slice(0, i).trim().toLowerCase(); const val = decl.slice(i + 1).trim();
                if (NOVA_PASTE_DROP_PROPS[prop]) return '';
                if (/^(?:border|outline)/.test(prop)) return prop + ': ' + val.replace(NOVA_PASTE_COLOR_TOKENS, 'currentColor');
                return prop + ': ' + val;
            }).filter(Boolean).join('; ');
        }

        // 整理貼上的 HTML：拿掉顏色與危險內容，結構保留。
        function _novaSanitizePastedHtml(html) {
            const doc = new DOMParser().parseFromString(String(html == null ? '' : html), 'text/html');
            const body = doc && doc.body; if (!body) return '';
            body.querySelectorAll('script,style,meta,link,title,base,iframe,frame,frameset,object,embed,applet,noscript,template').forEach(function (n) { n.remove(); });
            body.querySelectorAll('*').forEach(function (el) {
                Array.from(el.attributes).forEach(function (a) {
                    const n = a.name.toLowerCase();
                    if (n.indexOf('on') === 0) el.removeAttribute(a.name);
                    else if ((n === 'href' || n === 'src' || n === 'xlink:href' || n === 'action' || n === 'formaction') && /^\s*(?:javascript|vbscript):/i.test(a.value)) el.removeAttribute(a.name);
                });
                el.removeAttribute('color'); el.removeAttribute('bgcolor'); el.removeAttribute('background');
                if (el.hasAttribute('style')) {
                    const cleaned = _novaCleanInlineStyle(el.getAttribute('style'));
                    if (cleaned) el.setAttribute('style', cleaned); else el.removeAttribute('style');
                }
                if (el.id && el.id.indexOf('docs-internal-guid') === 0) el.removeAttribute('id');
            });
            return body.innerHTML;
        }

        // 貼上 HTML：整理後插入。只要呼叫了 preventDefault，就保證一定會插入（insertHTML → 純文字 → Range → 附加在尾端）。
        // 回傳 false＝不處理（整理失敗、或整理後沒有任何實際內容），交給瀏覽器預設貼上。
        function _novaNoteInsertPastedHtml(e, html, plainText, el) {
            let clean = '';
            try { clean = _novaSanitizePastedHtml(html); } catch (err) { console.warn('[NOVA][貼上] 整理貼上的 HTML 失敗，交給瀏覽器預設處理：', err); return false; }
            const hasContent = /<(?:img|table|hr|svg|video|audio)\b/i.test(clean) || clean.replace(/<[^>]*>/g, '').replace(/&nbsp;|\s/g, '') !== '';
            if (!hasContent) return false;
            e.preventDefault();
            let done = false;
            try { done = !!document.execCommand('insertHTML', false, clean); } catch (err) { done = false; }
            if (!done && plainText) { try { done = !!document.execCommand('insertText', false, plainText); } catch (err) { done = false; } }
            if (!done) {
                try {
                    const sel = window.getSelection();
                    if (sel && sel.rangeCount && el && el.contains(sel.getRangeAt(0).commonAncestorContainer)) {
                        const r = sel.getRangeAt(0); r.deleteContents(); r.insertNode(r.createContextualFragment(clean)); r.collapse(false); done = true;
                    }
                } catch (err) { done = false; }
            }
            if (!done && el) { try { el.insertAdjacentHTML('beforeend', clean); done = true; } catch (err) { /* 沒有更多辦法了 */ } }
            if (!done) console.warn('[NOVA][貼上] insertHTML、純文字、Range、附加 都失敗');
            return true;
        }

        function _novaStripNoteEditorHelpers(html) {
            const tmp = document.createElement('div');
            tmp.innerHTML = html;
            tmp.querySelectorAll('.' + NOVA_TBL_HANDLE_CLASS).forEach(function (h) { h.remove(); });
            return tmp.innerHTML;
        }

        // ════════════════════════════════════════════════════════════
        // ★ v3.30.128：標籤 + 雙向連結（AI 建議）。完整設計原理見 HTML
        // 那邊「標籤」「相關筆記」兩個區塊上方的模組註解，這裡是實際邏輯。
        //
        // 資料模型：
        //   note.tags  = ['標籤1', '標籤2', ...]（字串陣列，沒有另外的
        //                標籤主檔，自由格式）
        //   note.links = [{ id, title }, ...]（只存「這則筆記主動連出去」
        //                的對象；「被誰連結」現算，不另外存）
        // 這兩個都只是 note 物件上的一般欄位，saveNoteEdit() 存檔時會
        // 隨著整個 note 物件一起寫進 IndexedDB，跨裝置同步引擎
        // （_novaDriveSyncCollectLocal 等）本來就是整份 note 物件一起
        // 同步、合併、寫回，不需要另外幫這兩個新欄位寫同步邏輯。
        // ════════════════════════════════════════════════════════════
        let _novaEditingNoteTags = [];
        let _novaEditingNoteLinks = [];

        function renderNoteTagsChips() {
            const container = document.getElementById('edit-note-tags-container');
            const input = document.getElementById('edit-note-tag-input');
            if (!container || !input) return;
            container.querySelectorAll('.nova-tag-chip').forEach(function (c) { c.remove(); });
            _novaEditingNoteTags.forEach(function (tag, i) {
                const chip = document.createElement('span');
                chip.className = 'nova-tag-chip inline-flex items-center gap-1 text-xs bg-purple-900/30 border border-purple-700/50 text-purple-200 rounded-full px-2.5 py-1';
                chip.innerHTML = `<i class="ph-bold ph-tag"></i> ${escapeHtml(tag)} <button type="button" onclick="removeNoteTagAt(${i})" class="hover:text-red-400"><i class="ph-bold ph-x"></i></button>`;
                container.insertBefore(chip, input);
            });
        }

        window.addNoteTagFromInput = function () {
            const input = document.getElementById('edit-note-tag-input');
            if (!input) return;
            const val = input.value.trim();
            if (!val) return;
            if (!_novaEditingNoteTags.includes(val)) _novaEditingNoteTags.push(val);
            input.value = '';
            renderNoteTagsChips();
        };

        window.removeNoteTagAt = function (i) {
            _novaEditingNoteTags.splice(i, 1);
            renderNoteTagsChips();
        };

        function renderNoteLinksChips() {
            const container = document.getElementById('edit-note-links-container');
            if (!container) return;
            if (!_novaEditingNoteLinks.length) {
                container.innerHTML = '<span class="text-xs text-slate-600">尚未連結其他筆記</span>';
                return;
            }
            container.innerHTML = _novaEditingNoteLinks.map(function (l, i) {
                const exists = appState.notes.some(function (n) { return String(n.id) === String(l.id); });
                const clickAttr = exists ? `onclick="jumpToLinkedNote('${l.id}')" style="cursor:pointer"` : '';
                return `<span class="inline-flex items-center gap-1 text-xs ${exists ? 'bg-blue-900/30 border-blue-700/50 text-blue-200' : 'bg-slate-800 border-slate-700 text-slate-500'} border rounded-full px-2.5 py-1">
                    <i class="ph-bold ph-link" ${clickAttr}></i>
                    <span ${clickAttr}>${escapeHtml(l.title)}${exists ? '' : '（已刪除）'}</span>
                    <button type="button" onclick="removeNoteLinkAt(${i})" class="hover:text-red-400"><i class="ph-bold ph-x"></i></button>
                </span>`;
            }).join('');
        }

        window.removeNoteLinkAt = function (i) {
            _novaEditingNoteLinks.splice(i, 1);
            renderNoteLinksChips();
        };

        // backlinks 不存資料，每次都用 appState.notes 現掃一次——資料量
        // 對個人筆記量來說可以忽略不計，換取「不用維護雙份、永遠不會跟
        // note.links 本身對不上」的正確性保證。
        function renderNoteBacklinksChips(noteId) {
            const container = document.getElementById('edit-note-backlinks-container');
            if (!container) return;
            const backlinks = appState.notes.filter(function (n) {
                return String(n.id) !== String(noteId) && Array.isArray(n.links) && n.links.some(function (l) { return String(l.id) === String(noteId); });
            });
            if (!backlinks.length) { container.innerHTML = ''; return; }
            container.innerHTML = '<span class="text-[11px] text-slate-500 w-full mb-0.5 block">被以下筆記連結：</span>' + backlinks.map(function (n) {
                return `<span class="inline-flex items-center gap-1 text-xs bg-slate-800 border border-slate-700 text-slate-300 rounded-full px-2.5 py-1 cursor-pointer hover:border-emerald-600" onclick="jumpToLinkedNote('${n.id}')"><i class="ph-bold ph-arrow-bend-up-left"></i> ${escapeHtml(n.title)}</span>`;
            }).join('');
        }

        window.jumpToLinkedNote = async function (targetId) {
            const proceed = await showConfirm('要跳轉到這則筆記嗎？目前編輯中、還沒儲存的變更會遺失。');
            if (!proceed) return;
            openNoteEdit(targetId);
        };

        // 取得一則筆記在向量資料庫裡所有片段向量的平均值，當作這整則
        // 筆記的代表向量——note.id 對應到匯入時固定的 docId 命名規則
        // 'note_' + id（見 importNoteToKb()）。回傳 null 代表這則筆記
        // 還沒有匯入過向量資料庫，沒有向量可以比對。
        async function _novaKbGetNoteVector(noteId) {
            try {
                const allChunks = await novaKbGetAllChunks();
                const relevant = allChunks.filter(function (c) { return c.docId === 'note_' + noteId && Array.isArray(c.vector) && c.vector.length; });
                if (!relevant.length) return null;
                const dim = relevant[0].vector.length;
                const avg = new Array(dim).fill(0);
                relevant.forEach(function (c) { c.vector.forEach(function (v, i) { avg[i] += v; }); });
                for (let i = 0; i < dim; i++) avg[i] /= relevant.length;
                return avg;
            } catch (e) {
                console.warn('[NOVA][Links] 取得筆記向量失敗：', e);
                return null;
            }
        }

        // 核心 AI 建議連結邏輯：這則筆記 vs. 其他每一則「已經匯入過向量
        // 資料庫」的筆記，各自算代表向量、算 cosine 相似度，取分數最高
        // 的幾個且達到門檻的才建議（避免筆記數量少時，把「最不像的裡面
        // 比較不那麼不像」的也硬推薦出來）。
        async function _novaSuggestRelatedNotes(noteId, topN, threshold) {
            topN = topN || 5;
            threshold = typeof threshold === 'number' ? threshold : 0.6;
            const myVector = await _novaKbGetNoteVector(noteId);
            if (!myVector) return { ok: false, reason: 'not_indexed' };
            let allChunks;
            try { allChunks = await novaKbGetAllChunks(); } catch (e) { return { ok: false, reason: 'error' }; }
            const byNote = {};
            allChunks.forEach(function (c) {
                if (!c.docId || c.docId.indexOf('note_') !== 0) return;
                const otherNoteId = c.docId.slice('note_'.length);
                if (String(otherNoteId) === String(noteId)) return;
                if (!Array.isArray(c.vector) || !c.vector.length) return;
                if (!byNote[otherNoteId]) byNote[otherNoteId] = [];
                byNote[otherNoteId].push(c.vector);
            });
            const scored = [];
            Object.keys(byNote).forEach(function (otherNoteId) {
                const vectors = byNote[otherNoteId];
                const dim = vectors[0].length;
                const avg = new Array(dim).fill(0);
                vectors.forEach(function (v) { v.forEach(function (x, i) { avg[i] += x; }); });
                for (let i = 0; i < dim; i++) avg[i] /= vectors.length;
                const sim = novaKbCosineSim(myVector, avg);
                if (sim >= threshold) scored.push({ noteId: otherNoteId, similarity: sim });
            });
            scored.sort(function (a, b) { return b.similarity - a.similarity; });
            return { ok: true, suggestions: scored.slice(0, topN) };
        }

        window.suggestRelatedNotesForCurrentEdit = async function () {
            const noteId = document.getElementById('edit-note-id').value;
            const container = document.getElementById('edit-note-link-suggestions-container');
            if (!container) return;
            if (!noteId) { showToast('請先儲存這則筆記一次，才能使用 AI 建議相關筆記'); return; }
            container.classList.remove('hidden');
            container.innerHTML = '<p class="text-xs text-slate-500 flex items-center gap-1"><i class="ph-bold ph-circle-notch animate-spin"></i> 正在比對向量資料庫中的相關筆記...</p>';
            const result = await _novaSuggestRelatedNotes(noteId);
            if (!result.ok) {
                container.innerHTML = '<p class="text-xs text-amber-400">這則筆記還沒有匯入向量資料庫，請先按「匯入向量資料庫」再使用這個功能。</p>';
                return;
            }
            const candidates = result.suggestions
                .map(function (s) {
                    const otherNote = appState.notes.find(function (n) { return String(n.id) === String(s.noteId); });
                    const already = _novaEditingNoteLinks.some(function (l) { return String(l.id) === String(s.noteId); });
                    return { s: s, otherNote: otherNote, already: already };
                })
                .filter(function (x) { return x.otherNote && !x.already; });
            if (!candidates.length) {
                container.innerHTML = '<p class="text-xs text-slate-500">目前向量資料庫裡沒有找到足夠相關、且尚未連結的其他筆記。</p>';
                return;
            }
            container.innerHTML = '<p class="text-xs text-slate-400 mb-1.5">AI 找到以下可能相關的筆記：</p>' +
                candidates.map(function (x) {
                    const title = x.otherNote.title || '(未命名)';
                    return `<button type="button" onclick="addSuggestedNoteLink('${x.s.noteId}', '${title.replace(/'/g, "\\'")}')" class="inline-flex items-center gap-1 text-xs bg-slate-900 hover:bg-emerald-900/40 border border-slate-600 hover:border-emerald-600 rounded-full px-2.5 py-1 mr-1 mb-1"><i class="ph-bold ph-plus"></i> ${escapeHtml(title)} <span class="text-slate-500">(${Math.round(x.s.similarity * 100)}%)</span></button>`;
                }).join('');
        };

        window.addSuggestedNoteLink = function (targetId, targetTitle) {
            if (_novaEditingNoteLinks.some(function (l) { return String(l.id) === String(targetId); })) return;
            _novaEditingNoteLinks.push({ id: targetId, title: targetTitle });
            renderNoteLinksChips();
            suggestRelatedNotesForCurrentEdit(); // 重新整理建議清單，排除掉剛加入的
        };

        window.saveNoteEdit = function() {
            try {
                const id = document.getElementById('edit-note-id').value;
                const title = document.getElementById('edit-note-title').value.trim() || '未命名筆記';
                const contentEl = document.getElementById('edit-note-content');
                const contentHTML = contentEl ? _novaStripNoteEditorHelpers(contentEl.innerHTML) : '';
                const folderSelect = document.getElementById('edit-note-folder');
                const folder = folderSelect ? folderSelect.value : '未分類';
                // ★ v3.30.128：使用者可能打完標籤但忘記按 Enter 就直接按
                // 「儲存變更」，這裡先幫忙補送一次，不要讓打好的標籤因為
                // 沒按 Enter 就悄悄遺失。
                addNoteTagFromInput();
                const tags = _novaEditingNoteTags.slice();
                const links = _novaEditingNoteLinks.filter(function (l) { return String(l.id) !== String(id); }).slice(); // 防呆：不允許連結到自己
                
                if(id) {
                    const n = appState.notes.find(x => String(x.id) === String(id));
                    if(!n) return;
                    n.title = title; 
                    n.content = contentHTML; 
                    n.isHtml = true; 
                    n.images = [...appState.editNoteImagesBase64]; 
                    n.image = null; 
                    n.folder = folder;
                    n.tags = tags;
                    n.links = links;
                    saveToDB('notes', n);
                } else {
                    const newNote = { 
                        id: Date.now(), 
                        title: title, 
                        content: contentHTML, 
                        isHtml: true, 
                        date: new Date().toLocaleString(), 
                        type: 'text', 
                        images: [...appState.editNoteImagesBase64], 
                        folder: folder,
                        tags: tags,
                        links: links
                    };
                    appState.notes.unshift(newNote); 
                    saveToDB('notes', newNote);
                }
                renderNotes(); 
                closeNoteEdit(); 
                showToast("✅ 筆記已儲存");
            } catch(e) {
                showToast("儲存筆記時發生錯誤：" + e.message);
            }
        };

        window.handleNoteEditImage = function(e) {
            const files = Array.from(e.target.files);
            files.forEach(file => {
                if(!file.type.startsWith('image/')) return;
                const reader = new FileReader();
                reader.onload = (evt) => {
                    appState.editNoteImagesBase64.push(evt.target.result);
                    const imgContainer = document.getElementById('edit-note-img-preview-container');
                    if(imgContainer) {
                        imgContainer.innerHTML = appState.editNoteImagesBase64.map((img, idx) => `<div class="relative"><img src="${img}" class="h-16 w-auto rounded border border-slate-700 object-cover"><button onclick="removeNoteEditImage(${idx})" class="absolute -top-2 -right-2 bg-red-600 rounded-full p-1 shadow hover:bg-red-500 flex items-center justify-center"><i class="ph-bold ph-x text-white text-xs"></i></button></div>`).join('');
                        imgContainer.classList.remove('hidden'); 
                        imgContainer.classList.add('flex');
                    }
                };
                reader.readAsDataURL(file);
            });
            e.target.value = '';
        };

        window.removeNoteEditImage = function(idx) {
            appState.editNoteImagesBase64.splice(idx, 1);
            const imgContainer = document.getElementById('edit-note-img-preview-container');
            if(imgContainer) {
                if(appState.editNoteImagesBase64.length > 0) {
                    imgContainer.innerHTML = appState.editNoteImagesBase64.map((img, i) => `<div class="relative"><img src="${img}" class="h-16 w-auto rounded border border-slate-700 object-cover"><button onclick="removeNoteEditImage(${i})" class="absolute -top-2 -right-2 bg-red-600 rounded-full p-1 shadow hover:bg-red-500 flex items-center justify-center"><i class="ph-bold ph-x text-white text-xs"></i></button></div>`).join('');
                } else {
                    imgContainer.innerHTML = '';
                    imgContainer.classList.add('hidden');
                    imgContainer.classList.remove('flex');
                }
            }
        };

        const NOVA_NOTE_OCR_PROMPT = `你是一個圖片文字辨識(OCR)工具，請判斷這張圖片「主要內容」是不是可辨識的文字段落或表格，並依規則輸出：

- 如果圖片主要是一張表格（有清楚的欄列結構）：用 Markdown 表格語法完整轉錄，儘量保留每一欄、每一列的內容，儲存格內容維持原文字（可以是中文/英文/數字混合），看不清楚的部分用「?」標示，不要用猜的填入內容。
- 如果圖片主要是文字段落（沒有表格結構）：直接逐字轉錄文字內容，保留合理的分段/換行，不要加任何額外說明、翻譯或摘要。
- 如果圖片主要是照片、圖示、單純的圖表/示意圖，或截圖裡沒有值得轉錄的大量文字（例如只有零星按鈕文字/UI 圖示）：只回傳這一行文字，不要加其他任何內容：NO_TEXT_DETECTED

只能是以上三種情況其中一種，不要加開頭/結尾的任何說明文字，直接輸出轉錄結果或 NO_TEXT_DETECTED。`;

        function _novaNoteEsc(s) {
            const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML;
        }

        // 把辨識回來的 Markdown 表格轉成真正的 <table>（筆記內容區是
        // contenteditable，塞進去的 <table> 使用者可以直接點進去修改，
        // 不是一段固定死的圖片或純文字）。抓不到有效的表格結構就回傳
        // null，讓呼叫端改用「純文字段落」那條路徑處理，不強行湊出一個
        // 只有一欄的怪表格。
        function _novaMdTableToHtml(md) {
            const lines = md.trim().split('\n').map(l => l.trim()).filter(l => l.indexOf('|') !== -1);
            const isSepRow = l => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(l);
            const rows = lines.filter(l => !isSepRow(l)).map(l => l.replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
            if (rows.length < 1 || rows[0].length < 2) return null;   // 只有一欄就不算表格，交給純文字路徑
            let html = '<table style="border-collapse:collapse;width:100%;margin:8px 0;">';
            rows.forEach(function (cells, i) {
                const tag = i === 0 ? 'th' : 'td';
                html += '<tr>' + cells.map(function (c) {
                    return `<${tag} style="border:1px solid #475569;padding:6px 10px;text-align:left;${i === 0 ? 'background:#1e293b;font-weight:bold;' : ''}">${_novaNoteEsc(c)}</${tag}>`;
                }).join('') + '</tr>';
            });
            html += '</table>';
            return html;
        }

        // ★ v3.30.101：抽出成獨立、不碰 DOM 的核心辨識函式——原本這段
        // API 呼叫邏輯整個寫在 _novaHandleNotePasteImageWithOCR() 裡面，
        // 跟「貼上圖片時要怎麼插入畫面」的 DOM 操作綁在一起，這次新增
        // 的「AI 分析／匯入向量資料庫」都需要「單純辨識一張圖片的內容」
        // 這個能力、但不需要、也不應該去動編輯器的畫面，所以拆出來共用，
        // 三個呼叫端（貼上圖片、AI 分析、匯入向量資料庫）都吃同一份
        // 邏輯，行為（用哪個模型、怎麼判斷「不是文字/表格」）永遠一致，
        // 不會各自維護一份、之後改一邊忘記改另一邊。
        // 回傳 { recognized, isTable, markdown, error }：recognized
        // 為 false 代表模型判定為 NO_TEXT_DETECTED，或呼叫過程中出錯
        // （沒有設定對應 API Key、網路/API 錯誤……），這兩種情況呼叫端
        // 都應該視同「這張圖片沒有可用的文字/表格內容」處理，error 只
        // 在真的發生錯誤時才有值，方便呼叫端要不要另外告知使用者。
        async function _novaOcrRecognizeImage(dataUrl) {
            try {
                const ocrModel = (typeof novaResolveSaved === 'function' ? novaResolveSaved : function (x) { return x; })(localStorage.getItem('nova_note_ocr_model') || NOVA_GEMINI_MODEL_DEFAULT);   // v3.60.0
                const isGrok = ocrModel.indexOf('grok-') === 0;
                const base64Data = dataUrl.split(',')[1] || '';
                const mimeMatch = dataUrl.match(/^data:([^;]+);/);
                const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';

                let resultText;
                if (isGrok) {
                    const grokKey = localStorage.getItem('nova_key_grok') || '';
                    if (!grokKey) return { recognized: false, isTable: false, markdown: '', error: '尚未設定 Grok API Key' };
                    const myProxy = (typeof _novaGrokImageProxyUrl === 'function') ? _novaGrokImageProxyUrl() : '';
                    const apiUrl = 'https://api.x.ai/v1/chat/completions';
                    const fullUrl = myProxy ? `${myProxy}?url=${encodeURIComponent(apiUrl)}` : apiUrl;
                    const payload = {
                        model: ocrModel,
                        messages: [{ role: 'user', content: [
                            { type: 'text', text: NOVA_NOTE_OCR_PROMPT },
                            { type: 'image_url', image_url: { url: dataUrl } }
                        ]}],
                        temperature: 0
                    };
                    const res = await fetch(fullUrl, { method: 'POST', headers: { 'Authorization': `Bearer ${grokKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                    const resText = await res.text();
                    if (!res.ok) throw new Error(resText);
                    const data = JSON.parse(resText);
                    resultText = ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').trim();
                } else {
                    const key = localStorage.getItem('nova_key_gemini') || '';
                    if (!key) return { recognized: false, isTable: false, markdown: '', error: '尚未設定 Gemini API Key' };
                    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${ocrModel}:generateContent?key=${key}`;
                    const payload = {
                        contents: [{ role: 'user', parts: [
                            { text: NOVA_NOTE_OCR_PROMPT },
                            { inlineData: { mimeType: mimeType, data: base64Data } }
                        ]}],
                        generationConfig: _novaGeminiSanitizeGenCfg(ocrModel, { temperature: 0, maxOutputTokens: 4096 })
                    };
                    const res = await _novaLLMProxyFetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                    const data = await res.json();
                    if (!res.ok) throw new Error((data.error && data.error.message) || `HTTP ${res.status}`);
                    resultText = ((data.candidates && data.candidates[0] && data.candidates[0].content &&
                        data.candidates[0].content.parts || []).filter(function (p) { return p.text; }).map(function (p) { return p.text; }).join('')).trim();
                }

                if (!resultText || /^NO_TEXT_DETECTED/i.test(resultText)) {
                    return { recognized: false, isTable: false, markdown: '', error: null };
                }
                const isTable = !!_novaMdTableToHtml(resultText);
                return { recognized: true, isTable: isTable, markdown: resultText, error: null };
            } catch (e) {
                return { recognized: false, isTable: false, markdown: '', error: (e.message || String(e)) };
            }
        }

        window.setNoteFolder = function(f) {
            appState.currentNoteFolder = f;
            renderFolderTabs();
            renderNotes();
        }
        // v1.1.0：3D 圖譜函式庫改用本地打包檔 vendor/nova-graph3d.js（three.js＋3d-force-graph＋three-spritetext 以 esbuild 打成同一包，
        //         只有一份 three.js——原本分開載入 CDN 會有兩份 three 實例，文字標籤與球體混用會讓渲染迴圈出錯、畫面空白；也不再需要網路）
        let _novaGraphInstance = null;   // v1.1.0：移植時漏宣告 → openNoteGraph 在建圖前就丟 ReferenceError，畫面整片空白（真正的空白原因）
        async function _novaLoadGraphLib() {
            if (window.NovaGraph3D) return;
            await _novaLoadScriptOnce('./vendor/nova-graph3d.js?v=2');
            if (!window.NovaGraph3D) throw new Error('函式庫載入失敗：3D 圖譜模組沒有成功載入');
        }
        function _novaWebglOk() { try { var c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { return false; } }

        window.openNoteGraph = async function () {
            const modal = document.getElementById('note-graph-modal');
            const container = document.getElementById('note-graph-container');
            if (!modal || !container) return;
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            container.innerHTML = '<div class="absolute inset-0 flex items-center justify-center text-slate-500 text-sm gap-2"><i class="ph-bold ph-circle-notch animate-spin"></i> 載入圖譜函式庫中（第一次使用需要下載，之後會加速）...</div>';

            try {
                await _novaLoadGraphLib();
            } catch (e) {
                container.innerHTML = `<div class="absolute inset-0 flex items-center justify-center text-red-400 text-sm px-6 text-center">${escapeHtml(e.message)}</div>`;
                return;
            }
            container.innerHTML = '';
            const ForceGraph3D = window.NovaGraph3D.ForceGraph3D, SpriteText = window.NovaGraph3D.SpriteText;
            if (!_novaWebglOk()) { try { await window.novaRenderNoteGraph2D(container); } catch (e) { container.innerHTML = '<div style="color:#f87171;padding:24px;text-align:center;">這台裝置不支援 3D（WebGL），且 2D 備援也失敗：' + escapeHtml(e.message) + '</div>'; } return; }

            // ★ v3.30.134：使用者要求① 連線顏色在深色背景下要更容易辨識、
            // ② 節點上直接顯示筆記標題、③ 也要有白晝模式（淺色背景/深色
            // 連線）。這裡讀取 NOVA 既有的全域主題設定（跟其他畫面共用
            // 同一個 nova_theme localStorage 值/html.theme-light class，
            // 不是另外幫圖譜做一套獨立的主題開關），決定背景／連線／
            // 文字要用哪一組配色。
            const _novaGraphIsLight = document.documentElement.classList.contains('theme-light');
            const _novaGraphColors = _novaGraphIsLight
                ? { bg: '#f8fafc', link: 'rgba(51,65,85,0.55)', text: '#1e293b' }   // 白晝：淺底、深色連線、深色文字
                : { bg: '#020617', link: 'rgba(226,232,240,0.85)', text: '#f1f5f9' }; // 深色：暗底、淺色連線、淺色文字

            // 節點＝每一則筆記；邊＝ note.links 裡的每一筆連結（只保留
            // 目標筆記確實存在的邊，避免連結到已刪除筆記造成圖譜渲染
            // 錯誤——同一套防呆邏輯已經在筆記編輯視窗的
            // renderNoteLinksChips() 用過一次）。
            const nodes = appState.notes.map(function (n) {
                return { id: String(n.id), name: n.title || '(未命名)', folder: n.folder || '未分類' };
            });
            const nodeIds = new Set(nodes.map(function (n) { return n.id; }));
            const links = [];
            appState.notes.forEach(function (n) {
                (Array.isArray(n.links) ? n.links : []).forEach(function (l) {
                    if (nodeIds.has(String(l.id))) links.push({ source: String(n.id), target: String(l.id) });
                });
            });
            // 依連結數量調整節點大小——連結越多的筆記節點越大，呼應
            // Obsidian 圖譜裡「樞紐筆記看起來比較顯眼」的視覺習慣，
            // 一眼就能看出哪幾則筆記是目前知識網絡裡的核心。
            const degree = {};
            links.forEach(function (e) { degree[e.source] = (degree[e.source] || 0) + 1; degree[e.target] = (degree[e.target] || 0) + 1; });
            nodes.forEach(function (n) { n.val = 1 + (degree[n.id] || 0); });

            if (_novaGraphInstance) { try { _novaGraphInstance._destructor && _novaGraphInstance._destructor(); } catch (e) {} }
            // 明確指定尺寸（容器剛顯示時高度可能還是 0，3d-force-graph 預設用視窗大小會被裁掉或畫面空白）
            const _gw = function () { return container.clientWidth || window.innerWidth; }, _gh = function () { return container.clientHeight || Math.max(300, window.innerHeight - 70); };
            try {
            _novaGraphInstance = ForceGraph3D()(container)
                .width(_gw()).height(_gh())
                .graphData({ nodes: nodes, links: links })
                .nodeLabel('name')
                .nodeAutoColorBy('folder')
                .nodeVal('val')
                .linkDirectionalArrowLength(4)
                .linkDirectionalArrowRelPos(1)
                .linkWidth(1.2)
                .linkColor(function () { return _novaGraphColors.link; })
                .backgroundColor(_novaGraphColors.bg)
                // ★ v3.30.134：nodeThreeObjectExtend(true) 保留原本依資料夾
                // 上色的球體節點，額外疊加一個永遠面向鏡頭的文字標籤
                // （three-spritetext）顯示筆記標題——縮小字級
                // （textHeight，單位是場景座標，不是像素，數值越小字越
                // 小），確保不會蓋過球體本身或彼此重疊到看不清楚，同時
                // 文字顏色依主題選擇跟背景對比夠高的顏色，確保可辨識。
                .nodeThreeObject(function (node) {
                    // ★ v3.30.135：防呆——萬一 SpriteText 因為任何原因（例如
                    // CDN 那次剛好連不上）還是沒有成功載入，這裡直接跳過
                    // 文字標籤（回傳 false 讓 3d-force-graph 只畫預設的球體
                    // 節點），不要讓單一節點畫失敗就拖垮整個圖譜的渲染
                    // 迴圈——這正是這次要修的「畫面整個空白」的成因。
                    if (typeof SpriteText !== 'function') return false;
                    const sprite = new SpriteText(node.name);
                    sprite.textHeight = 2.2;
                    sprite.color = _novaGraphColors.text;
                    sprite.backgroundColor = _novaGraphIsLight ? 'rgba(248,250,252,0.75)' : 'rgba(2,6,23,0.75)';
                    sprite.padding = 1;
                    sprite.borderRadius = 2;
                    return sprite;
                })
                .nodeThreeObjectExtend(true)
                .onNodeClick(function (node) {
                    closeNoteGraph();
                    openNoteEdit(node.id);
                });
            } catch (e) {
                console.warn('[NOVA] 3D 圖譜建立失敗，改用 2D：', e);
                try { await window.novaRenderNoteGraph2D(container); } catch (e2) { container.innerHTML = '<div style="color:#f87171;padding:24px;text-align:center;">圖譜建立失敗：' + escapeHtml(String(e.message || e)) + '</div>'; }
                return;
            }
            try { if (window.ResizeObserver) { if (window._novaGraphRO) window._novaGraphRO.disconnect(); window._novaGraphRO = new ResizeObserver(function () { try { _novaGraphInstance.width(_gw()).height(_gh()); } catch (e) {} }); window._novaGraphRO.observe(container); } } catch (e) {}
            setTimeout(function () { try { _novaGraphInstance.width(_gw()).height(_gh()); } catch (e) {} }, 300);
            container.insertAdjacentHTML('beforeend', '<div style="position:absolute;left:8px;bottom:8px;font-size:11px;color:#94a3b8;background:rgba(2,6,23,.65);padding:3px 8px;border-radius:8px;pointer-events:none;">3D・' + nodes.length + ' 則筆記・' + links.length + ' 條連結｜單指旋轉、雙指縮放、點節點開啟筆記</div>');

            if (!nodes.length) {
                container.innerHTML = '<div class="absolute inset-0 flex items-center justify-center text-slate-500 text-sm">目前還沒有任何筆記，建立筆記後再回來看圖譜。</div>';
            } else if (!links.length) {
                showToast('目前的筆記彼此之間還沒有建立任何連結，圖上暫時都是孤立節點——可以在筆記編輯視窗用「AI 建議相關筆記」建立連結');
            }
        };

        window.closeNoteGraph = function () {
            const modal = document.getElementById('note-graph-modal');
            if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
        };

        window.toggleNoteTagFilter = function (tag) {
            appState.currentNoteTagFilter = (appState.currentNoteTagFilter === tag) ? null : tag;
            renderNotes();
        };

        async function renderNotes() { 
            const el = document.getElementById('full-note-list'); const mini = document.getElementById('mini-note-list');
            const searchInput = document.getElementById('note-search-input');
            const keyword = searchInput ? searchInput.value.toLowerCase() : '';

            // 【記憶體修復】重新渲染前，先釋放筆記列表中已掛載的 Blob URL
            if (el) {
                el.querySelectorAll('audio[data-audio-id]').forEach(audioEl => {
                    if (audioEl.src && audioEl.src.startsWith('blob:')) {
                        const cacheKey = String(audioEl.getAttribute('data-audio-id'));
                        if (_audioBlobUrlCache[cacheKey] === audioEl.src) {
                            URL.revokeObjectURL(audioEl.src);
                            delete _audioBlobUrlCache[cacheKey];
                        }
                        audioEl.src = '';
                    }
                });
            }

            let filteredNotes = appState.notes;
            // 多段錄音只顯示群組第一段（最早的），後續段隱藏（整合在同一張卡片）
            const shownGroupIds = new Set();
            filteredNotes = filteredNotes.filter(n => {
                const gid = n.groupId || n.id;
                if (n.type === 'audio' && n.groupId) {
                    if (shownGroupIds.has(gid)) return false; // 已有同群組卡片
                    // 只顯示最早那段（groupId 的創建者，即 groupId === n.id，或是群組中最小 id）
                    const groupSegs = appState.notes.filter(x => (x.groupId || x.id) === gid && x.type === 'audio');
                    const leaderId = groupSegs.reduce((min, x) => x.id < min ? x.id : min, groupSegs[0].id);
                    if (String(n.id) !== String(leaderId)) return false;
                    shownGroupIds.add(gid);
                }
                return true;
            });
            if (appState.currentNoteFolder !== '全部') {
                filteredNotes = filteredNotes.filter(n => (n.folder || '未分類') === appState.currentNoteFolder);
            }
            if (keyword) {
                filteredNotes = filteredNotes.filter(n => {
                    const titleMatch = (n.title || '').toLowerCase().includes(keyword);
                    const contentMatch = (n.content || '').toLowerCase().includes(keyword);
                    return titleMatch || contentMatch;
                });
            }

            // ★ v3.30.128：標籤瀏覽/篩選——先渲染「目前有哪些標籤」這排
            // 篩選列（用還沒套用標籤篩選前的 filteredNotes 統計，這樣切換
            // 資料夾/搜尋關鍵字時，標籤列會跟著現在看得到的筆記範圍更新，
            // 不會列出「篩選後根本看不到任何一則」的標籤選項），再套用
            // 目前選定的標籤篩選（如果有）。
            const tagFilterEl = document.getElementById('note-tag-filter-container');
            if (tagFilterEl) {
                const tagCounts = {};
                filteredNotes.forEach(function (n) {
                    (Array.isArray(n.tags) ? n.tags : []).forEach(function (t) {
                        tagCounts[t] = (tagCounts[t] || 0) + 1;
                    });
                });
                const allTags = Object.keys(tagCounts).sort();
                if (!allTags.length) {
                    tagFilterEl.classList.add('hidden');
                    tagFilterEl.innerHTML = '';
                } else {
                    tagFilterEl.classList.remove('hidden');
                    tagFilterEl.innerHTML = '<span class="text-xs text-slate-500 flex items-center gap-1 mr-1"><i class="ph-bold ph-tag"></i> 標籤：</span>' +
                        allTags.map(function (t) {
                            const active = appState.currentNoteTagFilter === t;
                            return `<button type="button" onclick="toggleNoteTagFilter('${t.replace(/'/g, "\\'")}')" class="text-xs px-2.5 py-1 rounded-full border transition-colors ${active ? 'bg-purple-600 border-purple-500 text-white' : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-purple-600'}">${escapeHtml(t)} <span class="opacity-60">(${tagCounts[t]})</span></button>`;
                        }).join('');
                }
            }
            if (appState.currentNoteTagFilter) {
                filteredNotes = filteredNotes.filter(function (n) {
                    return Array.isArray(n.tags) && n.tags.indexOf(appState.currentNoteTagFilter) !== -1;
                });
            }

            // ★ v3.30.132：使用者回報「已匯入」的筆記，離開畫面再回來看
            // 又變回「匯入向量資料庫」——根本原因是這個按鈕的「已匯入」
            // 狀態，原本只在剛匯入成功的那個當下，直接改按鈕自己的
            // innerHTML（見 importNoteToKb() 裡的 _setBtnState()），沒有
            // 持久化，下次 renderNotes() 重繪（切分類/搜尋/離開再回來）
            // 就會被這裡的範本蓋回預設的「匯入向量資料庫」文字，即使
            // 向量資料庫裡的資料其實還在，畫面卻顯示成「還沒匯入」，
            // 容易讓人誤以為向量遺失了、跑去重複匯入一次。
            // 修法：渲染卡片之前，先查一次 nova_kb_db 裡實際有哪些筆記
            // 已經有對應的 chunk（docId 是固定的 'note_'+id 命名規則，
            // 見 importNoteToKb()），讓按鈕的初始狀態就正確反映實際
            // 資料庫內容，不是每次都預設成「未匯入」。查詢失敗（例如
            // 知識庫還沒初始化過）就維持原本「未匯入」的顯示，不影響
            // 筆記列表其他功能正常運作。
            let importedNoteIds = new Set();
            try {
                const allChunks = await novaKbGetAllChunks();
                allChunks.forEach(function (c) {
                    if (c.docId && c.docId.indexOf('note_') === 0) importedNoteIds.add(c.docId.slice('note_'.length));
                });
            } catch (e) { /* 查詢失敗就維持預設「未匯入」顯示 */ }

            if(el) el.innerHTML = filteredNotes.map(n => {
                const isAudio = n.type === 'audio'; const icon = isAudio ? '<i class="ph-fill ph-microphone text-purple-400"></i>' : '<i class="ph-fill ph-notebook text-emerald-400"></i>';
                const folderBadge = `<span class="absolute top-3 right-3 text-[9px] bg-slate-800 text-slate-400 px-2 py-0.5 rounded border border-slate-700">${escapeHtml(n.folder || '未分類')}</span>`;
                
                let actionButtons = `<button onclick="exportNoteWord('${n.id}')" class="text-xs bg-slate-800 hover:bg-slate-700 px-2 py-1.5 rounded text-slate-300 transition-colors border border-slate-700 flex items-center justify-center gap-1" title="匯出為 Word 相容格式 (.rtf)"><i class="ph-bold ph-file-doc"></i> Word</button>`;
                actionButtons += `<button onclick="exportNoteRichText('${n.id}')" class="text-xs bg-slate-800 hover:bg-slate-700 px-2 py-1.5 rounded text-slate-300 transition-colors border border-slate-700 flex items-center justify-center gap-1" title="匯出為 HTML"><i class="ph-bold ph-file-html"></i> RichText</button>`;
                actionButtons += `<button id="btn-backup-${n.id}" onclick="backupNoteToDrive('${n.id}')" class="text-xs bg-blue-900/50 hover:bg-blue-800/50 border border-blue-500/50 px-2 py-1.5 rounded text-blue-200 transition-colors flex items-center justify-center gap-1"><i class="ph-bold ph-cloud-arrow-up"></i> 雲端備份</button>`;
                actionButtons += importedNoteIds.has(String(n.id))
                    ? `<button id="btn-kb-import-${n.id}" onclick="importNoteToKb('${n.id}')" class="text-xs bg-emerald-900/40 hover:bg-emerald-800/50 border border-emerald-600/50 px-2 py-1.5 rounded text-emerald-300 transition-colors flex items-center justify-center gap-1" title="重新向量化（會覆蓋舊索引）"><i class="ph-bold ph-check-circle"></i> 已匯入（點擊更新）</button>`
                    : `<button id="btn-kb-import-${n.id}" onclick="importNoteToKb('${n.id}')" class="text-xs bg-emerald-900/40 hover:bg-emerald-800/50 border border-emerald-600/50 px-2 py-1.5 rounded text-emerald-300 transition-colors flex items-center justify-center gap-1" title="向量化並匯入向量資料庫"><i class="ph-bold ph-database"></i> 匯入向量資料庫</button>`;
                actionButtons += `<button onclick="openNoteEdit('${n.id}')" class="text-xs bg-emerald-900/50 hover:bg-emerald-800/50 border border-emerald-500/50 px-3 py-1.5 rounded text-emerald-200 transition-colors flex items-center justify-center gap-1 font-bold"><i class="ph-bold ph-corners-out"></i> 檢視與編輯</button>`;

                let extraAudioButtons = '';
                if(isAudio) {
                    const noteGid = n.groupId || n.id;
                    const noteSegsAll = appState.notes.filter(x => (x.groupId || x.id) === noteGid && x.type === 'audio').sort((a,b) => a.id - b.id);
                    const noteSegCount = noteSegsAll.length;
                    const segIdsJs = `[${noteSegsAll.map(s => `'${s.id}'`).join(',')}]`;
                    const noteGroupBadge = noteSegCount > 1
                        ? `<span class="inline-flex items-center gap-1 text-[10px] font-bold bg-orange-900/40 text-orange-300 border border-orange-500/30 px-2 py-0.5 rounded-full"><i class="ph-fill ph-scissors"></i> 分段 ${noteSegCount} 段</span>`
                        : '';
                    if (noteGroupBadge) extraAudioButtons += `<div class="col-span-full mb-1">${noteGroupBadge}</div>`;
                    extraAudioButtons += `<button onclick="batchDownloadWeba(${segIdsJs}, 'note')" class="text-xs bg-slate-800 hover:bg-slate-700 px-2 py-1.5 rounded text-slate-300 transition-colors border border-slate-700 flex items-center justify-center gap-1"><i class="ph-bold ph-download-simple"></i> weba${noteSegCount>1?` (${noteSegCount})`:''}</button>`;
                    extraAudioButtons += `<button onclick="batchDownloadMp3(${segIdsJs}, 'note')" class="text-xs bg-slate-700 hover:bg-slate-600 px-2 py-1.5 rounded text-green-300 transition-colors border border-green-700/50 flex items-center justify-center gap-1"><i class="ph-bold ph-file-audio"></i> MP3${noteSegCount>1?` (${noteSegCount})`:''}</button>`;
                    if (noteSegCount > 1) extraAudioButtons += `<button onclick="downloadMergedMp3(${segIdsJs}, '${n.title.replace(/'/g,"\\'")}', 'note')" class="text-xs bg-orange-700 hover:bg-orange-600 px-2 py-1.5 rounded text-white transition-colors flex items-center justify-center gap-1" title="接合所有分段為一個 MP3"><i class="ph-bold ph-music-notes-plus"></i> 合併 MP3</button>`;
                    const aiLabel = noteSegCount > 1 ? `AI 分析 (全 ${noteSegCount} 段)` : 'AI 分析';
                    extraAudioButtons += `<button onclick="summarizeVoiceNote('${n.id}')" class="text-xs bg-purple-900/50 border border-purple-500/50 hover:bg-purple-800/50 px-2 py-1.5 rounded text-purple-200 transition-colors flex items-center justify-center gap-1"><i class="ph-bold ph-sparkle"></i> ${aiLabel}</button>`;
                } else {
                    extraAudioButtons += `<button onclick="openNoteAnalysisModePicker('${n.id}')" class="text-xs bg-purple-900/50 border border-purple-500/50 hover:bg-purple-800/50 px-2 py-1.5 rounded text-purple-200 transition-colors flex items-center justify-center gap-1"><i class="ph-bold ph-sparkle"></i> AI 分析</button>`;
                }
                extraAudioButtons += `<button onclick="generatePPTFromNote('${n.id}')" class="text-xs bg-emerald-900/50 border border-emerald-500/50 hover:bg-emerald-800/50 px-2 py-1.5 rounded text-emerald-200 transition-colors flex items-center justify-center gap-1"><i class="ph-bold ph-presentation-chart"></i> 製作 PPT</button>`;
                
                let imgHtml = '';
                const displayImages = n.images || (n.image ? [n.image] : []);
                if (displayImages.length > 0) {
                    imgHtml = `<div class="mt-2 mb-2 flex flex-wrap gap-2">` + displayImages.map(img => `<img src="${img}" class="max-h-24 rounded border border-slate-700/50 object-cover">`).join('') + `</div>`;
                }

                // 錄音筆記：若是多段群組，顯示所有段的播放器
                let audioPlayerHtml = '';
                if (n.type === 'audio') {
                    const noteGid = n.groupId || n.id;
                    const noteSegs = appState.notes
                        .filter(x => (x.groupId || x.id) === noteGid && x.type === 'audio')
                        .sort((a, b) => a.id - b.id);
                    if (noteSegs.length > 1) {
                        audioPlayerHtml = `<div class="mt-3 mb-2 space-y-1">` +
                            noteSegs.map((seg, i) => `<div class="flex items-center gap-2"><span class="text-[10px] text-slate-500 shrink-0 w-8">第${i+1}段</span><audio controls class="flex-1 h-9 rounded-lg bg-slate-800 shadow-inner min-w-0" data-audio-id="${seg.id}"></audio>${seg.duration ? `<span class="text-[10px] text-slate-600 shrink-0">${Math.floor(seg.duration/60)}m${seg.duration%60}s</span>` : ''}</div>`).join('') +
                            `</div>`;
                    } else {
                        audioPlayerHtml = `<div class="mt-3 mb-2" data-audio-wrapper><audio controls class="w-full h-10 rounded-lg bg-slate-800 shadow-inner" data-audio-id="${n.id}"></audio></div>`;
                    }
                }
                let linkHtml = (n.driveUrl && !n.driveUrl.startsWith('blob:')) ? `<div class="mt-2"><a href="${n.driveUrl}" target="_blank" class="text-xs text-blue-400 underline flex items-center gap-1"><i class="ph-bold ph-cloud"></i> 在雲端查看已備份筆記</a></div>` : '';
                
                let renderedContent = n.isHtml ? n.content : formatMessage(n.content);
                
                // ★ v3.30.103：跨筆記分析用的選取核取方塊——放在資料夾標籤
                // 旁邊，勾選狀態存在 appState.selectedNoteIdsForAnalysis
                // （陣列，跨次 renderNotes() 重繪都要保留，不能存在 DOM 上
                // 自己的 checked 屬性，重繪就會被沖掉）。
                const isSelectedForAnalysis = appState.selectedNoteIdsForAnalysis.indexOf(String(n.id)) !== -1;
                const selectCheckbox = `<label class="absolute top-3 left-3 z-10 cursor-pointer" title="勾選以加入跨筆記分析"><input type="checkbox" onclick="toggleNoteSelectForAnalysis('${n.id}')" ${isSelectedForAnalysis ? 'checked' : ''} class="w-4 h-4 rounded accent-purple-500 cursor-pointer"></label>`;
                // ★ 標籤顯示（AI 分析自動下的標籤，見 summarizeTextNote()／
                // 消費端那段解析 ###TAGS### 的邏輯——v3.30.128 的手動標籤
                // 編輯器沿用同一個 n.tags 欄位，兩邊完全相容，AI 自動下的
                // 標籤一樣可以在編輯器裡看到、手動增刪）——純顯示用，點擊
                // 沒有額外行為，只是讓使用者一眼看到這篇筆記被歸類成什麼。
                const tagsBadgeHtml = (n.tags && n.tags.length)
                    ? `<div class="flex flex-wrap gap-1 mb-2">` + n.tags.map(function (t) { return `<span class="text-[9px] bg-emerald-900/30 text-emerald-300 border border-emerald-600/30 px-1.5 py-0.5 rounded-full">${escapeHtml(t)}</span>`; }).join('') + `</div>`
                    : '';
                // ★ v3.30.128：雙向連結數量提示——只是讓使用者從筆記列表
                // 一眼看出「這篇筆記有沒有連結/被連結」，不用每篇都打開
                // 編輯器才看得到，實際檢視/編輯連結內容還是要進編輯器。
                const outgoingCount = Array.isArray(n.links) ? n.links.length : 0;
                const backlinkCount = appState.notes.filter(function (other) {
                    return String(other.id) !== String(n.id) && Array.isArray(other.links) && other.links.some(function (l) { return String(l.id) === String(n.id); });
                }).length;
                const linksBadgeHtml = (outgoingCount || backlinkCount)
                    ? `<div class="mb-2"><span class="text-[9px] bg-blue-900/30 text-blue-300 border border-blue-600/30 px-1.5 py-0.5 rounded-full inline-flex items-center gap-1"><i class="ph-bold ph-link"></i> ${outgoingCount ? `連出 ${outgoingCount}` : ''}${outgoingCount && backlinkCount ? '・' : ''}${backlinkCount ? `被連 ${backlinkCount}` : ''}</span></div>`
                    : '';
                return `<div class="bg-slate-900 p-5 rounded-2xl border ${isSelectedForAnalysis ? 'border-purple-500' : 'border-slate-800'} flex flex-col relative overflow-hidden slide-in pt-8">${selectCheckbox}${folderBadge}<div class="flex justify-between items-start mb-2"><h3 class="text-lg font-bold text-white flex items-center gap-2 truncate pr-2 w-full">${icon} <span class="truncate">${escapeHtml(n.title)}</span></h3><div class="flex space-x-1 shrink-0"><button onclick="deleteNote('${n.id}')" class="text-slate-500 hover:text-red-400 p-1.5 bg-slate-950/50 rounded"><i class="ph-bold ph-trash"></i></button></div></div><span class="text-[10px] text-slate-500 mb-2">${n.date}</span>${tagsBadgeHtml}${linksBadgeHtml}${imgHtml}${audioPlayerHtml}<div class="note-html-content text-slate-300 text-sm overflow-y-auto max-h-40 scrollbar-thin ${n.isHtml ? 'whitespace-normal' : 'whitespace-pre-wrap'} relative after:absolute after:bottom-0 after:left-0 after:w-full after:h-8 after:bg-gradient-to-t after:from-slate-900 after:to-transparent">${renderedContent}</div>${linkHtml}<div class="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-4 pt-3 border-t border-slate-800">${extraAudioButtons}</div><div class="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-2">${actionButtons}</div></div>`;
            }).join('')||'<p class="text-slate-500 text-center col-span-3 mt-10">找不到符合的筆記</p>'; 
            
            if(mini) mini.innerHTML=appState.notes.slice(0,2).map(n=>{
                let plainText = n.isHtml ? n.content.replace(/<[^>]+>/g, ' ') : n.content;
                return `<div class="bg-slate-950/50 p-3 rounded-lg border border-slate-800/50 cursor-pointer hover:border-slate-700" onclick="switchTab('notes')"><h4 class="text-slate-300 text-xs font-bold mb-1 truncate flex items-center gap-1">${n.type==='audio'?'<i class="ph-fill ph-microphone text-purple-400"></i>':''}${escapeHtml(n.title)}</h4><p class="text-slate-500 text-[10px] line-clamp-1">${escapeHtml(plainText)}</p></div>`;
            }).join('')||'<p class="text-xs text-slate-500 text-center">無筆記</p>'; 
            attachAudioPlayers(); // 異步掛載音訊 Blob URL
        }
        const NOVA_NOTE_ANALYSIS_MODES = {
            summary: { label: '摘要重點', icon: 'ph-sparkle', instruction: '請深度分析並總結這份內容，提取出最重要的關鍵字與結構化重點。' },
            todo:    { label: '待辦清單', icon: 'ph-check-square', instruction: '請從這份內容中找出所有可以執行的待辦事項/行動項目，用清單格式列出（每一項前面加上「- [ ] 」），如果內容裡有明確的截止日期或負責人也一併標註在該項目後面；如果內容裡完全沒有可執行的行動項目，請直接明說「這份內容沒有明顯的待辦事項」，不要硬湊。' },
            table:   { label: '萃取成表格', icon: 'ph-table', instruction: '請找出這份內容裡最適合用表格呈現的結構化資訊（例如比較、清單、數據），用 Markdown 表格語法輸出；如果內容本身不適合轉成表格，請直接說明原因，不要硬湊一個沒有意義的表格。' },
            outline: { label: '產生大綱', icon: 'ph-list-bullets', instruction: '請把這份內容整理成清楚的階層式大綱（用縮排跟編號呈現章節/子項目的層級關係），保留原文原本的邏輯順序，不要重新排序、也不要加入自己的見解或沒出現過的內容。' }
        };

        // ★ 自動標籤／相關筆記連結共用的提示詞片段——附加在任何一種分析
        // 模式的指令後面，統一格式方便後續用同一組正規表示式解析。
        function _novaBuildTagLinkPromptSuffix(excludeNoteId) {
            const otherTitles = appState.notes
                .filter(function (x) { return String(x.id) !== String(excludeNoteId) && x.title; })
                .map(function (x) { return x.title; })
                .slice(0, 60);   // 標題清單太長會佔用過多 prompt 空間，取近期/前面 60 筆即可
            return `\n\n完成以上分析後，請【另起一行】，用下面這個固定格式輸出（一定要照這個格式，不要用其他文字包裝或省略）：\n###TAGS### 標籤1, 標籤2, 標籤3\n###RELATED### 標題A, 標題B\n\n（TAGS 是幫這篇內容下 2~5 個精簡的分類標籤，用逗號分隔；RELATED 是從下面「既有筆記標題清單」裡，挑出主題明顯相關的筆記標題，最多 3 個，完全找不到相關的就留空白，絕對不要為了填滿而勉強挑一個不相關的標題，也不要自己編清單以外的標題）\n\n【既有筆記標題清單】：\n${otherTitles.join('、') || '（目前沒有其他筆記）'}`;
        }

        // 從模型回應裡把 ###TAGS###／###RELATED### 那兩行解析出來，並把這
        // 兩行從要顯示/存回筆記的正文裡拿掉——使用者不需要在筆記內文裡
        // 看到這種給機器讀的格式化標記。
        function _novaParseTagLinkSuffix(text) {
            const tagsMatch = text.match(/###TAGS###\s*(.*)/);
            const relatedMatch = text.match(/###RELATED###\s*(.*)/);
            const tags = tagsMatch ? tagsMatch[1].split(/[,，、]/).map(function (t) { return t.trim(); }).filter(Boolean) : [];
            const relatedTitles = relatedMatch ? relatedMatch[1].split(/[,，、]/).map(function (t) { return t.trim(); }).filter(Boolean) : [];
            const cleanText = text.replace(/###TAGS###[^\n]*/g, '').replace(/###RELATED###[^\n]*/g, '').trim();
            return { tags: tags, relatedTitles: relatedTitles, cleanText: cleanText };
        }

        function _novaEnsureNoteAnalysisModal() {
            if (document.getElementById('note-analysis-mode-modal')) return;
            const div = document.createElement('div');
            div.id = 'note-analysis-mode-modal';
            div.className = 'hidden fixed inset-0 bg-black/70 z-[100] items-center justify-center p-4';
            div.innerHTML = `
              <div class="bg-slate-900 border border-slate-700 rounded-2xl p-5 w-full max-w-sm">
                <h3 class="text-white font-bold text-lg mb-1">選擇分析方式</h3>
                <p id="note-analysis-modal-subtitle" class="text-slate-400 text-xs mb-4"></p>
                <div id="note-analysis-mode-list" class="space-y-2"></div>
                <button onclick="document.getElementById('note-analysis-mode-modal').classList.add('hidden');document.getElementById('note-analysis-mode-modal').classList.remove('flex');" class="mt-4 w-full text-center text-xs text-slate-500 hover:text-slate-300 py-2">取消</button>
              </div>`;
            document.body.appendChild(div);
        }

        // 工具列按鈕呼叫的入口——原本直接呼叫 summarizeTextNote(id)，現在
        // 改成先跳出模式選擇，選完才真正執行分析。
        window.openNoteAnalysisModePicker = function(id) {
            const n = appState.notes.find(function (x) { return String(x.id) === String(id); });
            if (!n) return;
            _novaEnsureNoteAnalysisModal();
            document.getElementById('note-analysis-modal-subtitle').textContent = `針對「${n.title || '未命名筆記'}」`;
            const listEl = document.getElementById('note-analysis-mode-list');
            listEl.innerHTML = Object.keys(NOVA_NOTE_ANALYSIS_MODES).map(function (key) {
                const m = NOVA_NOTE_ANALYSIS_MODES[key];
                return `<button onclick="document.getElementById('note-analysis-mode-modal').classList.add('hidden');document.getElementById('note-analysis-mode-modal').classList.remove('flex');summarizeTextNote('${id}','${key}')" class="w-full flex items-center gap-2 text-left px-3 py-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm transition-colors"><i class="ph-bold ${m.icon} text-purple-400"></i> ${m.label}</button>`;
            }).join('');
            const modal = document.getElementById('note-analysis-mode-modal');
            modal.classList.remove('hidden'); modal.classList.add('flex');
        };

        // ★ v3.30.103：跨筆記分析——選取/清除/更新浮動列，以及真正執行
        // 分析的 analyzeCrossNotes()。跟單篇筆記分析共用同一份
        // NOVA_NOTE_ANALYSIS_MODES／_novaBuildTagLinkPromptSuffix()／
        // _novaParseTagLinkSuffix()，不是另外做一套。
        window.toggleNoteSelectForAnalysis = function (id) {
            const key = String(id);
            const idx = appState.selectedNoteIdsForAnalysis.indexOf(key);
            if (idx === -1) appState.selectedNoteIdsForAnalysis.push(key);
            else appState.selectedNoteIdsForAnalysis.splice(idx, 1);
            _novaUpdateCrossAnalysisBar();
            renderNotes();   // 重繪讓卡片的邊框/勾選狀態立刻同步
        };
        window.clearNoteSelectionForAnalysis = function () {
            appState.selectedNoteIdsForAnalysis = [];
            _novaUpdateCrossAnalysisBar();
            renderNotes();
        };
        function _novaUpdateCrossAnalysisBar() {
            const bar = document.getElementById('note-cross-analysis-bar');
            const countEl = document.getElementById('note-cross-analysis-count');
            if (!bar) return;
            const cnt = appState.selectedNoteIdsForAnalysis.length;
            // 至少要選 2 篇才有「跨筆記」的意義，只選 1 篇請直接用一般的
            // 「AI 分析」按鈕即可，不需要另外走這條路徑。
            if (cnt >= 2) {
                bar.classList.remove('hidden'); bar.classList.add('flex');
                if (countEl) countEl.textContent = `已選取 ${cnt} 篇筆記`;
            } else {
                bar.classList.add('hidden'); bar.classList.remove('flex');
            }
        }

        window.openCrossNoteAnalysisModePicker = function () {
            if (appState.selectedNoteIdsForAnalysis.length < 2) { showToast('請至少選取 2 篇筆記才能跨筆記分析'); return; }
            _novaEnsureNoteAnalysisModal();
            document.getElementById('note-analysis-modal-subtitle').textContent = `跨 ${appState.selectedNoteIdsForAnalysis.length} 篇筆記一起分析`;
            const listEl = document.getElementById('note-analysis-mode-list');
            listEl.innerHTML = Object.keys(NOVA_NOTE_ANALYSIS_MODES).map(function (key) {
                const m = NOVA_NOTE_ANALYSIS_MODES[key];
                return `<button onclick="document.getElementById('note-analysis-mode-modal').classList.add('hidden');document.getElementById('note-analysis-mode-modal').classList.remove('flex');analyzeCrossNotes('${key}')" class="w-full flex items-center gap-2 text-left px-3 py-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm transition-colors"><i class="ph-bold ${m.icon} text-purple-400"></i> ${m.label}</button>`;
            }).join('');
            const modal = document.getElementById('note-analysis-mode-modal');
            modal.classList.remove('hidden'); modal.classList.add('flex');
        };

        async function analyzeCrossNotes(mode) {
            const ids = appState.selectedNoteIdsForAnalysis.slice();
            const notes = ids.map(function (id) { return appState.notes.find(function (x) { return String(x.id) === id; }); }).filter(Boolean);
            if (notes.length < 2) { showToast('請至少選取 2 篇筆記才能跨筆記分析'); return; }
            if (appState.currentModel !== 'gemini') { showToast("跨筆記分析建議使用 Gemini 模型，系統已自動為您切換。"); setModel('gemini'); }

            const modeKey = (mode && NOVA_NOTE_ANALYSIS_MODES[mode]) ? mode : 'summary';
            const modeInfo = NOVA_NOTE_ANALYSIS_MODES[modeKey];

            let combinedText = '';
            const allImages = [];
            notes.forEach(function (n, idx) {
                const ct = n.isHtml ? n.content.replace(/<[^>]+>/g, '\n').replace(/&nbsp;/g, ' ') : (n.content || '');
                combinedText += `\n\n【筆記 ${idx + 1}：「${n.title || '未命名筆記'}」】\n${ct.trim()}`;
                if (n.images && n.images.length) allImages.push.apply(allImages, n.images);
            });
            const uniqueImages = Array.from(new Set(allImages)).slice(0, 8);   // 跨筆記來源更多，上限維持跟單篇分析一致，避免單次請求過大

            appState._crossNoteAnalysisTitles = notes.map(function (n) { return n.title || '未命名筆記'; });
            // pendingAnalyzeContextId 這裡只是拿來當「有一次待處理分析」的
            // 旗標（消費端只判斷 truthy，不會真的拿它去比對筆記 id——
            // crossNotes 分支改用 appState._crossNoteAnalysisTitles），
            // 隨便給一個非 null 值即可。
            appState.pendingAnalyzeContextId = 'cross_' + Date.now();
            appState.pendingAnalyzeType = 'crossNotes';
            appState.pendingAnalyzeMode = modeKey;
            const tagLinkSuffix = _novaBuildTagLinkPromptSuffix(null);
            appState.pendingAnalyzePrompt = `你會收到 ${notes.length} 篇筆記的內容，請把它們當成一個整體來處理（不是個別各自摘要，是要找出跨筆記共通的重點/關聯/矛盾之處）。\n\n${modeInfo.instruction}\n\n【嚴格約束】：請「絕對忠於提供的筆記內容」，只做客觀的整理，不要自行腦補外部資訊。\n${combinedText}${uniqueImages.length ? `\n\n【以上筆記另外還附有 ${uniqueImages.length} 張圖片，已經一併附加給你，請一併判讀】` : ''}${tagLinkSuffix}`;

            const roughTokenEstimate = Math.ceil(combinedText.length / 1.5);
            const costHint = `合計文字約 ${combinedText.length} 字元（粗估 ${roughTokenEstimate.toLocaleString()} tokens）${uniqueImages.length ? `，另外會附上 ${uniqueImages.length} 張圖片一起分析（會顯著增加 token 用量與等待時間）` : ''}。`;
            if (!await showConfirm(`即將以「${modeInfo.label}」模式跨 ${notes.length} 篇筆記一起分析：\n${appState._crossNoteAnalysisTitles.join('、')}\n${costHint}`)) {
                appState.pendingAnalyzeContextId = null; appState.pendingAnalyzeType = ''; appState.pendingAnalyzeMode = ''; appState._crossNoteAnalysisTitles = null; return;
            }

            if (uniqueImages.length) {
                if (!appState.chatFiles) appState.chatFiles = [];
                uniqueImages.forEach(function (dataUrl, idx) {
                    const mimeMatch = dataUrl.match(/^data:([^;]+);/);
                    appState.chatFiles.push({ category: 'image', name: `跨筆記附圖_${idx + 1}.png`, mime: mimeMatch ? mimeMatch[1] : 'image/png', data: dataUrl });
                });
            }

            clearNoteSelectionForAnalysis();
            switchTab('dashboard');
            document.getElementById('user-input').value = appState.pendingAnalyzePrompt; handleSendMessage();
        }

        async function summarizeTextNote(id, mode) {
            const n = appState.notes.find(x => String(x.id) === String(id)); if (!n) return;
            if (appState.currentModel !== 'gemini') { showToast("文字深度分析建議使用 Gemini 模型，系統已自動為您切換。"); setModel('gemini'); }

            // ★ v3.30.103：沒指定模式（例如舊的呼叫端還沒改）就退回原本的
            // 「摘要重點」模式，行為不變、不會因為這次升級而壞掉。
            const modeKey = (mode && NOVA_NOTE_ANALYSIS_MODES[mode]) ? mode : 'summary';
            const modeInfo = NOVA_NOTE_ANALYSIS_MODES[modeKey];

            // ★ 修復：原本完全沒有把筆記內容帶入 prompt，AI 收到的只有指令本身，
            //   沒有任何「以下筆記內容」的實際文字，因此永遠回覆「筆記內容不足以產生有效摘要」。
            //   現在比照 generatePPTFromNote() 的做法，將 HTML 筆記轉為純文字後一併附上。
            let contentText = n.isHtml ? n.content.replace(/<[^>]+>/g, '\n').replace(/&nbsp;/g, ' ') : (n.content || '');
            contentText = contentText.trim();

            // ★ v3.30.101：使用者要求「筆記含有圖片時，AI 分析要一併辨識
            // 圖片內容」——評估過兩種做法：①先對每張圖片各跑一次 OCR，
            // 轉成 markdown 文字後再併入純文字一起送給模型摘要；②直接把
            // 圖片當附件，跟文字一起在【同一次】呼叫裡送給 Gemini，讓它
            // 自己在多模態理解的過程中處理圖片裡的文字/表格。
            // 【結論：採用②，不做①】理由：
            // - Gemini 本身就有很強的原生多模態理解能力，圖片裡的文字/
            //   表格在「一次看到文字+圖片」的情境下，通常辨識/理解品質
            //   跟專門先跑一次 OCR 再丟純文字給它是同一個水準，甚至因為
            //   模型能同時看到版面配置、上下文（例如圖表的座標軸、圖說），
            //   直接给圖有時候理解得更好，不是只抽取文字。
            // - 先跑①的 OCR 前處理，等於「每張圖多打一次 API」，多一輪
            //   延遲、多一份成本，換來的往往不是更好的分析品質（單純把
            //   OCR 結果的純文字塞回去，反而失去圖片本身的版面/視覺資訊）。
            // - 真正「非做 OCR 前處理不可」的情境是「匯入向量資料庫」
            //   （見下面 importNoteToKb() 的修改）——那裡的 embedding 模型
            //   只吃純文字，圖片完全沒有管道被向量化，不轉成文字就等於
            //   資訊直接遺失，這種情況才真的必要，AI 分析這裡並不適用
            //   同一個理由，兩者不能一概而論。
            // 因此這裡只需要把筆記裡的圖片抓出來，用既有的
            // appState.chatFiles 附件機制，跟文字一起送進同一次對話，不用
            // 另外呼叫 _novaOcrRecognizeImage()。
            const noteImages = [];
            if (n.images && n.images.length) noteImages.push.apply(noteImages, n.images);
            if (n.isHtml && n.content) {
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = n.content;
                tempDiv.querySelectorAll('img').forEach(function (img) {
                    if (img.src && img.src.indexOf('data:') === 0) noteImages.push(img.src);
                });
            }
            const uniqueImages = Array.from(new Set(noteImages)).slice(0, 8);   // 上限 8 張，避免單則筆記附圖過多把單次請求塞爆

            if (!contentText && uniqueImages.length === 0) {
                addMessage('⚠️ 這篇筆記目前沒有任何內容，無法進行分析。', 'system');
                return;
            }

            const imageHint = uniqueImages.length
                ? `\n\n【筆記另外還附有 ${uniqueImages.length} 張圖片，已經一併附加給你，如果圖片裡有文字或表格，請直接判讀並納入分析與摘要，不要略過圖片內容不看】`
                : '';
            // ★ v3.30.103：把「AI 自動標籤／相關筆記連結」這個共用提示詞
            // 片段接在任何一種分析模式的指令後面（不分模式都做，摘要/
            // 待辦清單/表格/大綱都一樣有機會被下標籤、找到相關筆記）。
            const tagLinkSuffix = _novaBuildTagLinkPromptSuffix(id);
            appState.pendingAnalyzeContextId = id;
            appState.pendingAnalyzeType = 'textNote';
            appState.pendingAnalyzeMode = modeKey;
            appState.pendingAnalyzePrompt = `${modeInfo.instruction}\n\n【嚴格約束】：請「絕對忠於提供的筆記內容」，只做客觀的整理，絕對不要給出任何額外的個人建議、評論，也不要自行腦補外部資訊。若筆記內容過短或無具體意義，請直接回覆「筆記內容不足以產生有效摘要」。\n\n【以下為筆記「${n.title || '(未命名)'}」的完整內容】：\n${contentText || '（本篇筆記文字內容為空，主要內容都在附圖裡，請直接看圖分析）'}${imageHint}${tagLinkSuffix}`;

            // ★ v3.30.103：使用者要求「成本/範圍的防護提示」——多模態呼叫
            // 附上的圖片愈多、文字愈長，實際花費的 token／等待時間就愈多，
            // 這裡在確認彈窗裡直接把「大概要送出去多少東西」講清楚，讓
            // 使用者自己決定要不要繼續，而不是送出去之後才發現這次分析
            // 意外地慢/意外地貴。字數/token 估算刻意保守（用字元數簡單
            // 估，不去強求精確到跟實際計費一致），重點是給使用者一個
            // 「大概規模」的概念，不是要做到會計等級的精準預估。
            const roughTokenEstimate = Math.ceil((contentText.length + tagLinkSuffix.length) / 1.5);
            const costHint = `這篇筆記文字內容約 ${contentText.length} 字元（粗估 ${roughTokenEstimate.toLocaleString()} tokens）${uniqueImages.length ? `，另外會附上 ${uniqueImages.length} 張圖片一起分析（圖片會顯著增加這次呼叫的 token 用量與等待時間）` : ''}。`;
            if(!await showConfirm(`即將以「${modeInfo.label}」模式分析「${n.title}」。\n${costHint}`)) {
                appState.pendingAnalyzeContextId = null; appState.pendingAnalyzeType = ''; appState.pendingAnalyzeMode = ''; return;
            }

            // 把筆記裡的圖片轉成聊天附件格式，讓 handleSendMessage() 用既有的
            // 多模態機制，一次把文字＋圖片都送給 Gemini。
            if (uniqueImages.length) {
                if (!appState.chatFiles) appState.chatFiles = [];
                uniqueImages.forEach(function (dataUrl, idx) {
                    const mimeMatch = dataUrl.match(/^data:([^;]+);/);
                    appState.chatFiles.push({ category: 'image', name: `筆記附圖_${idx + 1}.png`, mime: mimeMatch ? mimeMatch[1] : 'image/png', data: dataUrl });
                });
            }

            switchTab('dashboard');
            document.getElementById('user-input').value = appState.pendingAnalyzePrompt; handleSendMessage();
        }
(function () {
            // 邏輯，跟既有的 attachRichPasteHandler() 圖片分支接在一起，
            // 只在筆記編輯器（edit-note-content／全螢幕編輯的 fse-content）
            // 這兩個元素生效，其餘沒有指定的呼叫端保持原本「直接插入原始
            // 圖片」的行為不變。
            const NOVA_NOTE_OCR_ELEMENTS = ['edit-note-content', 'fse-content'];
            // ★ v3.30.127：NOVA_NOTE_OCR_PROMPT／_novaNoteEsc()／
            // _novaMdTableToHtml()／_novaOcrRecognizeImage() 這四個原本
            // 定義在這裡（DOMContentLoaded 事件監聽器的閉包內），已經搬到
            // 上層、跟 importNoteToKb() 放在一起的頂層作用域——完整原因
            // 見那邊的說明，這裡留一個指標避免以後有人在這裡找不到、
            // 又重複定義一次。

            // ★ v3.30.130：抽出成共用函式——「給一個已經插入 DOM 的
            // placeholder 元素 + 一張圖片的 dataUrl，跑 OCR、把結果轉成
            // 畫面上的 HTML」這件事，貼上圖片自動辨識
            // （_novaHandleNotePasteImageWithOCR）跟事後手動點選「辨識
            // 這張圖片」（convertNoteImageInPlace）兩條路徑都需要，抽出來
            // 兩邊共用同一份邏輯，行為（保留原圖當參考縮圖、可以事後刪除
            // 原圖……）永遠一致，不會兩邊各自維護一份、之後改一邊忘記
            // 改另一邊。
            async function _novaRunOcrIntoPlaceholder(dataUrl, placeholder) {
                const finishWithImage = function () {
                    if (placeholder) placeholder.outerHTML = `<img src="${dataUrl}" style="max-width:100%;border-radius:8px;margin:8px 0;">`;
                };

                const ocrResult = await _novaOcrRecognizeImage(dataUrl);
                if (ocrResult.error && typeof showToast === 'function') {
                    showToast('⚠️ 圖片文字辨識失敗，已改為插入原始圖片（' + ocrResult.error + '）', 5000);
                }
                if (!ocrResult.recognized) {
                    finishWithImage();
                    return;
                }

                const resultText = ocrResult.markdown;
                const tableHtml = _novaMdTableToHtml(resultText);
                const convertedHtml = tableHtml || resultText.split(/\n{2,}/).map(function (p) {
                    return `<p>${_novaNoteEsc(p).replace(/\n/g, '<br>')}</p>`;
                }).join('');
                // 保留原圖當可收合的參考縮圖——OCR 不是 100% 準確，使用者
                // 應該隨時能核對辨識結果對不對，不是憑空信任轉換出來的
                // 文字/表格，這也是唯一能發現辨識錯誤、自己手動修正的方式。
                // ★ v3.30.130：<summary> 裡加一個「刪除原圖」按鈕——使用者
                // 核對過辨識結果沒問題之後，可以只留轉換出來的文字/表格、
                // 把原圖從筆記內容裡拿掉，省空間，也避免這張圖之後匯入
                // 向量資料庫時被重複處理（見 importNoteToKb() 對應的
                // 修改）。用 event.stopPropagation() 避免點到按鈕也觸發
                // <summary> 本身的收合/展開行為。
                const wrapperHtml = `<div style="border-left:3px solid #10b981;padding-left:10px;margin:8px 0;">${convertedHtml}</div>`
                    + `<details style="margin:4px 0 12px 0;"><summary style="cursor:pointer;color:#64748b;font-size:12px;display:flex;align-items:center;justify-content:space-between;"><span>🖼️ 顯示原始圖片（供核對辨識結果）</span><button type="button" contenteditable="false" onclick="event.preventDefault(); event.stopPropagation(); this.closest('details').remove();" style="color:#f87171;font-size:11px;background:transparent;border:1px solid #7f1d1d;border-radius:4px;padding:2px 6px;cursor:pointer;" title="刪除保留的原始圖片，只留下已轉換的文字/表格">🗑️ 刪除原圖</button></summary><img src="${dataUrl}" style="max-width:100%;border-radius:8px;margin-top:6px;"></details>`;
                if (placeholder) placeholder.outerHTML = wrapperHtml;
                if (typeof showToast === 'function') showToast(tableHtml ? '✅ 已將圖片中的表格轉為可編輯表格' : '✅ 已將圖片中的文字轉為可編輯文字');
            }

            async function _novaHandleNotePasteImageWithOCR(dataUrl) {
                const placeholderId = 'nova-note-ocr-' + Date.now();
                document.execCommand('insertHTML', false, `<div id="${placeholderId}" contenteditable="false" style="color:#94a3b8;font-size:13px;padding:8px 0;">🔍 正在辨識圖片內容...</div>`);
                const placeholder = document.getElementById(placeholderId);
                // ★ v3.30.99：使用者要求「自己設定用來作為筆記圖形辨識的
                // model」——讀使用者在筆記編輯器選的模型（存在
                // localStorage，見 note-ocr-model-select 那個下拉選單），
                // 沒選過就退回原本的 NOVA_GEMINI_MODEL_DEFAULT。依模型
                // 名稱字首判斷要打 Gemini 還是 Grok 的 API，兩邊各自的
                // 呼叫方式/金鑰/CORS 代理都沿用主程式一般對話已經在用的
                // 那一套（_novaLLMProxyFetch／_novaGrokImageProxyUrl），
                // 不是另外兜一份。
                // ★ v3.30.101：實際的 API 呼叫邏輯抽到 _novaOcrRecognizeImage()
                // 共用，這裡只負責處理「怎麼插入 placeholder」，結果呈現
                // 交給 _novaRunOcrIntoPlaceholder()（v3.30.130 抽出共用）。
                await _novaRunOcrIntoPlaceholder(dataUrl, placeholder);
            }

            // ════════════════════════════════════════════════════════════
            // ★ v3.30.130：使用者要求「事後（例如已經貼入含有文字或表格的
            // 圖片），再點選需要轉換的圖片進行轉換」——貼上當下如果關閉了
            // 「圖片自動辨識」、或這張圖片是舊筆記裡本來就有的，都可以用
            // 這裡補做轉換，不用刪掉重貼一次。
            //
            // 做法：點擊筆記內容區裡任何一張「還沒被 OCR 轉換過」的圖片
            // （判斷依據：不在 OCR 參考用的 <details> 裡面），浮出一個
            // 固定定位的小按鈕讓使用者選擇要不要轉換。按鈕本身掛在
            // document.body，不是插進 contenteditable 的 DOM 結構裡——
            // 避免直接操作 contenteditable 內部結構可能造成的游標位置/
            // undo 堆疊意外行為，只有使用者真的按下「辨識這張圖片」才會
            // 去動 contenteditable 裡的 DOM（把圖片換成 placeholder）。
            // ════════════════════════════════════════════════════════════
            function _novaShowImageOcrBar(img) {
                let bar = document.getElementById('nova-img-ocr-bar');
                if (!bar) {
                    bar = document.createElement('div');
                    bar.id = 'nova-img-ocr-bar';
                    bar.style.cssText = 'position:fixed; z-index:9999; background:#0f172a; border:1px solid #10b981; border-radius:8px; box-shadow:0 4px 12px rgba(0,0,0,0.4);';
                    bar.innerHTML = '<button type="button" style="font-size:12px;color:#10b981;background:transparent;border:none;cursor:pointer;padding:6px 10px;white-space:nowrap;" onclick="convertNoteImageInPlace()"><i class="ph-bold ph-magic-wand"></i> 辨識這張圖片</button>';
                    document.body.appendChild(bar);
                }
                const rect = img.getBoundingClientRect();
                bar.style.top = Math.max(4, rect.top - 40) + 'px';
                bar.style.left = Math.max(4, rect.left) + 'px';
                bar.style.display = 'block';
                bar._novaTargetImg = img;
            }

            // ★ v3.30.130：跟 _novaNoteEnsureOcrDeleteButtons() 同樣的
            // scope 理由——window.closeNoteEdit()（頂層作用域）需要呼叫
            // 這個函式，掛到 window 上避免又一次 v3.30.127 那種
            // ReferenceError。
            window._novaHideImageOcrBar = function () {
                const bar = document.getElementById('nova-img-ocr-bar');
                if (bar) bar.style.display = 'none';
            };
            const _novaHideImageOcrBar = window._novaHideImageOcrBar; // 同檔案內就近呼叫用的短別名

            function _novaNoteImageClickHandler(e) {
                const img = (e.target && e.target.tagName === 'IMG') ? e.target : null;
                if (!img || !img.closest('#edit-note-content, #fse-content')) { _novaHideImageOcrBar(); return; }
                if (img.closest('details')) { _novaHideImageOcrBar(); return; } // 已經是 OCR 過的參考縮圖，不需要再提供轉換
                if (!img.src || img.src.indexOf('data:') !== 0) { _novaHideImageOcrBar(); return; } // 只處理筆記本機圖片，不是外部連結圖
                _novaShowImageOcrBar(img);
            }
            document.addEventListener('click', _novaNoteImageClickHandler);
            // 捲動時原本的定位就不準了，直接先隱藏，比讓按鈕飄在錯誤位置好；
            // 用 capture:true 才能連筆記內容區自己的內部捲動（overflow-y:auto）
            // 也一併偵測到，不是只有整個視窗捲動才會觸發。
            document.addEventListener('scroll', _novaHideImageOcrBar, true);

            window.convertNoteImageInPlace = async function () {
                const bar = document.getElementById('nova-img-ocr-bar');
                const img = bar && bar._novaTargetImg;
                if (!img) return;
                _novaHideImageOcrBar();
                const dataUrl = img.src;
                const placeholder = document.createElement('div');
                placeholder.id = 'nova-note-ocr-' + Date.now();
                placeholder.contentEditable = 'false';
                placeholder.style.cssText = 'color:#94a3b8;font-size:13px;padding:8px 0;';
                placeholder.textContent = '🔍 正在辨識圖片內容...';
                img.replaceWith(placeholder);
                await _novaRunOcrIntoPlaceholder(dataUrl, placeholder);
            };

            // ★ v3.30.130：舊筆記在這次更新之前就已經產生過的 OCR 參考
            // 縮圖 <details> 區塊，內容是舊版 HTML，沒有「刪除原圖」按鈕
            // ——回溯幫這些既有內容補上按鈕，不用重新跑一次 OCR 才能拿到
            // 這個能力。跟表格拖曳把手（_novaMakeTablesResizable()）用
            // 同一個 idempotent 設計：判斷「已經有按鈕就跳過」，可以放心
            // 重複呼叫，不會疊加。
            // ★ v3.30.130：這裡刻意用 window.X = function 而不是 plain
            // function 宣告——這個函式定義在 DOMContentLoaded 閉包內部
            // （旁邊其他 OCR 相關函式都在這裡），但需要被頂層作用域的
            // _novaNoteSetupTableResizeObserver() 呼叫（見該處說明）。
            // v3.30.127 才剛修過一次因為「頂層函式呼叫不到定義在閉包
            // 內部的函式」造成的 ReferenceError，這裡直接用 window.X
            // 掛到全域，不要重蹈覆轍再製造一個同類型的 scope bug。
            window._novaNoteEnsureOcrDeleteButtons = function (container) {
                if (!container) return;
                container.querySelectorAll('details').forEach(function (details) {
                    const summary = details.querySelector('summary');
                    if (!summary) return;
                    if (summary.querySelector('.nova-ocr-del-btn')) return;
                    if (summary.textContent.indexOf('顯示原始圖片') === -1) return;
                    summary.style.display = 'flex';
                    summary.style.alignItems = 'center';
                    summary.style.justifyContent = 'space-between';
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.contentEditable = 'false';
                    btn.className = 'nova-ocr-del-btn';
                    btn.title = '刪除保留的原始圖片，只留下已轉換的文字/表格';
                    btn.style.cssText = 'color:#f87171;font-size:11px;background:transparent;border:1px solid #7f1d1d;border-radius:4px;padding:2px 6px;cursor:pointer;';
                    btn.innerHTML = '🗑️ 刪除原圖';
                    btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); details.remove(); });
                    summary.appendChild(btn);
                });
            };

            function attachRichPasteHandler(elementId) {
                const el = document.getElementById(elementId);
                if (!el) return;
                // ★ v3.31.69：記下「在編輯器自己複製／剪下」的內容，貼回來時保留原本的顏色（見 _novaIsInternalClip）
                el.addEventListener('copy', _novaRememberInternalClip);
                el.addEventListener('cut', _novaRememberInternalClip);
                el.addEventListener('paste', function(e) {
                    const clipboardData = e.clipboardData || window.clipboardData;
                    if (!clipboardData) return;
                    
                    let plainText = clipboardData.getData('text/plain');
                    // ★ v3.31.69：只有「整段貼上的內容就是單一一個 YouTube 連結」才嵌入。原本的 regex 沒有錨定，貼上的文字裡任何位置有 YouTube 連結
                    //   （例如研究報告的參考文獻清單），整份貼上就被換成一個影片嵌入、其餘文字全部丟掉。
                    let ytMatch = _novaPastedYoutubeMatch(plainText);
                    if (ytMatch && ytMatch[1]) {
                        e.preventDefault();
                        let embedHtml = `<br><div contenteditable="false" style="margin: 10px 0;"><iframe width="100%" height="315" src="https://www.youtube.com/embed/${ytMatch[1]}" frameborder="0" allowfullscreen style="border-radius: 8px;"></iframe></div><br>`;
                        document.execCommand('insertHTML', false, embedHtml);
                        return;
                    }

                    // ★ v3.30.100：使用者實際回報貼上一張圖片（螢幕截圖/簡報
                    // 匯出的圖檔）完全沒有反應——追查後發現根因：這裡原本用
                    // 「剪貼簿裡有沒有 text/html 或 text/plain」來判斷「這不是
                    // 圖片貼上」，只有【完全沒有】文字/html 資料時才會去檢查
                    // 圖片。但很多實際來源（瀏覽器裡對著一張圖按右鍵複製、
                    // PowerPoint／Word、部分螢幕截圖工具）複製圖片時，剪貼簿
                    // 會【同時】附上 image 跟一份 text/html 或 text/plain 的
                    // 替代內容（例如一段 <img src="file:///..."> 或純檔名），
                    // 這種「同時有圖片也有文字/html」的情況原本會直接被這個
                    // if 判斷排除掉，完全不會進到下面的圖片處理分支，最後
                    // 交給瀏覽器處理那份通常沒什麼用的替代 html/text，使用者
                    // 看起來就像「貼了完全沒反應」。
                    // 修法：不要再用「有沒有文字/html」去判斷要不要檢查圖片，
                    // 改成一律先掃剪貼簿的 items 裡有沒有實際的圖片檔案，
                    // 找到就優先用圖片流程處理（不管是否也帶了文字/html）；
                    // 真的完全沒有圖片，才照原本的方式交給瀏覽器處理文字/
                    // html 貼上。
                    // ★ v3.31.69：只認「真的是圖片檔案」的項目（kind 為 file、type 為 image/*、getAsFile() 拿得到東西）。
                    //   原本只比對 type 字串含不含 "image"：剪貼簿裡有一個名稱含 image 的非檔案項目（例如 Google 文件的 …image-clip+wrapped），
                    //   getAsFile() 回傳 null，後面 FileReader.readAsDataURL(null) 丟例外，而 e.preventDefault() 已經呼叫過——什麼都沒插入，「貼上完全沒有反應」。
                    const items = clipboardData.items || [];
                    for (let i = 0; i < items.length; i++) {
                        if (items[i].kind === 'file' && /^image\//i.test(items[i].type || '') && items[i].getAsFile()) {
                            e.preventDefault();
                            const blob = items[i].getAsFile();
                            const reader = new FileReader();
                            reader.onload = function(evt) {
                                // ★ v3.30.98：筆記編輯器（一般模式／全螢幕模式）貼上
                                // 純圖片時，先送給 Gemini 判斷是不是文字/表格，是的話
                                // 轉成可編輯內容；不是的話（一般照片/截圖）維持原本
                                // 直接插入圖片的行為，見
                                // _novaHandleNotePasteImageWithOCR() 的完整說明。
                                // ★ v3.30.130：使用者要求可以關閉這個自動辨識行為——
                                // 加上 nova_note_ocr_auto_enabled 這個開關的檢查，
                                // 關閉時（值為 '0'）不管是不是筆記編輯器，一律直接
                                // 插入原始圖片，完全不呼叫 AI；圖片還在，之後可以用
                                // 「事後手動點選圖片辨識」（見 convertNoteImageInPlace()）
                                // 再決定要不要轉換。
                                const ocrAutoEnabled = localStorage.getItem('nova_note_ocr_auto_enabled') !== '0';
                                if (NOVA_NOTE_OCR_ELEMENTS.indexOf(elementId) !== -1 && ocrAutoEnabled) {
                                    _novaHandleNotePasteImageWithOCR(evt.target.result);
                                } else {
                                    document.execCommand('insertImage', false, evt.target.result);
                                }
                            };
                            reader.readAsDataURL(blob);
                            return;
                        }
                    }

                    // ★ v3.31.69：HTML 貼上——整理掉來源的文字色／背景色（黑夜模式會變成黑底黑字）與危險內容後再插入，保證一定會插入；
                    //   在編輯器自己複製的內容、純文字、整理後沒有內容的，都交給瀏覽器預設處理。見 _novaNoteInsertPastedHtml。
                    let pastedHtml = '';
                    try { pastedHtml = clipboardData.getData('text/html') || ''; } catch (_) { pastedHtml = ''; }
                    try { if (localStorage.getItem('nova_debug_paste') === '1') console.info('[NOVA][貼上]', elementId, Array.from(items).map(function (it) { return it.kind + ':' + it.type; }).join(', '), '｜html ' + pastedHtml.length + ' 字元｜純文字 ' + plainText.length + ' 字元'); } catch (_) {}
                    if (pastedHtml.trim() && localStorage.getItem('nova_note_paste_keep_colors') !== '1' && !_novaIsInternalClip(plainText)) {
                        if (_novaNoteInsertPastedHtml(e, pastedHtml, plainText, el)) return;
                    }
                });
            }

            attachRichPasteHandler('edit-note-content');
            attachRichPasteHandler('fse-content');
})();

// 對外匯出（讓行內 onclick 與主腳本找得到）
['NOVA_NOTE_ANALYSIS_MODES','_novaParseTagLinkSuffix','_novaBuildTagLinkPromptSuffix','_novaMdTableToHtml','_novaNoteEsc','NOVA_NOTE_OCR_PROMPT','_novaLoadScriptOnce','addNoteManually','openFullscreenEditor','saveFullscreenEditor','collapseFullscreenEditor','closeFullscreenEditor','openNoteEdit','closeNoteEdit','saveNoteEdit','handleNoteEditImage','removeNoteEditImage','_novaNoteSaveSelection','_novaNoteRestoreSelection','_novaNoteApplyFontSize','_novaNoteApplyTextColor','_novaNoteApplyHighlight','_novaNoteClearHighlight','_novaNoteApplyCellColor','_novaNoteApplyTableBorderColor','_novaNoteUnifyFont','renderNoteTagsChips','addNoteTagFromInput','removeNoteTagAt','renderNoteLinksChips','removeNoteLinkAt','renderNoteBacklinksChips','jumpToLinkedNote','suggestRelatedNotesForCurrentEdit','addSuggestedNoteLink','_novaOcrRecognizeImage','openNoteGraph','closeNoteGraph','toggleNoteTagFilter','renderNotes','setNoteFolder','openNoteAnalysisModePicker','toggleNoteSelectForAnalysis','clearNoteSelectionForAnalysis','openCrossNoteAnalysisModePicker','analyzeCrossNotes','summarizeTextNote','_novaSuggestRelatedNotes','_novaMakeTablesResizable','_novaStripNoteEditorHelpers'].forEach(function(n){ try { var v = eval(n); if (v !== undefined) window[n] = v; } catch(e){} });
})();

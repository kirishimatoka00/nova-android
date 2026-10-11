/* nova-chatmenu.js — v1.0.0 (2026-10-11)
 * 對話紀錄與資料夾旁的功能收進「⋮」三點選單（對標桌面版）：
 *   對話：重新命名／建立分支對話／匯出成 Markdown（新增）／移至資料夾／刪除
 *   資料夾：重新命名資料夾／刪除資料夾（收合箭頭維持在最右邊）
 * 版本紀錄
 *   v1.0.0 2026-10-11  首版。Markdown 匯出沿用 _novaExportTextFile（Capacitor 檔案輸出），內容格式同桌面版 exportChatSessionAsMarkdown。
 */
(function () {
  'use strict';
  var W = window;
  W.closeNovaItemMenu = function () {
    if (W._novaMenuPopupEl && W._novaMenuPopupEl.parentNode) W._novaMenuPopupEl.parentNode.removeChild(W._novaMenuPopupEl);
    W._novaMenuPopupEl = null;
    if (W._novaMenuOutsideHandler) { document.removeEventListener('click', W._novaMenuOutsideHandler, true); W._novaMenuOutsideHandler = null; }
  };
  W._novaShowItemMenu = function (event, items) {
    if (event && event.stopPropagation) event.stopPropagation();
    W.closeNovaItemMenu();
    var anchor = (event && (event.currentTarget || event.target)) || null;
    var rect = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { top: 80, bottom: 80, right: W.innerWidth - 10, left: 10 };
    var menu = document.createElement('div');
    menu.style.cssText = 'position:fixed;background:#1e293b;border:1px solid #334155;border-radius:12px;box-shadow:0 25px 50px -12px rgba(0,0,0,.6);padding:6px 0;z-index:999999;min-width:170px;visibility:hidden;';
    document.body.appendChild(menu);
    items.forEach(function (it) {
      var b = document.createElement('button');
      b.style.cssText = 'width:100%;text-align:left;padding:12px 14px;font-size:.875rem;display:flex;align-items:center;gap:8px;background:transparent;border:none;color:' + (it.danger ? '#f87171' : '#e2e8f0') + ';';
      b.innerHTML = '<i class="' + it.icon + '" style="font-size:1rem;"></i><span>' + it.label + '</span>';
      b.onclick = function (e) { e.stopPropagation(); W.closeNovaItemMenu(); it.onClick(); };
      menu.appendChild(b);
    });
    var h = menu.offsetHeight, w = menu.offsetWidth, top = rect.bottom + 4, left = rect.right - w;
    if (top + h > W.innerHeight - 8) top = Math.max(8, rect.top - h - 4);
    if (left < 8) left = 8;
    menu.style.top = top + 'px'; menu.style.left = left + 'px'; menu.style.visibility = 'visible';
    W._novaMenuPopupEl = menu;
    W._novaMenuOutsideHandler = function (e) { if (!menu.contains(e.target)) W.closeNovaItemMenu(); };
    setTimeout(function () { document.addEventListener('click', W._novaMenuOutsideHandler, true); }, 0);
  };

  W.exportChatSessionAsMarkdown = async function (sid) {
    var msgs = appState.messages.filter(function (m) {
      return (String(m.sessionId) === String(sid) || (!m.sessionId && sid === 'legacy')) && (m.sender === 'user' || m.sender === 'ai');
    }).sort(function (a, b) { return (a.id || 0) - (b.id || 0); });
    if (!msgs.length) { showToast('⚠️ 這個對話沒有可以匯出的內容'); return; }
    var first = msgs.find(function (m) { return m.sender === 'user'; });
    var def = first ? first.text.substring(0, 80) : (sid === 'legacy' ? '舊對話紀錄' : '新對話');
    var title = (appState.chatTitles && appState.chatTitles[sid]) ? appState.chatTitles[sid] : def;
    var md = '# ' + title + '\n\n匯出時間：' + new Date().toLocaleString() + '\n\n---\n\n';
    msgs.forEach(function (m) {
      var sp = m.sender === 'user' ? '👤 使用者' : '🤖 ' + ((m.model && W.MODEL_CONFIG && MODEL_CONFIG[m.model]) ? MODEL_CONFIG[m.model].name : 'AI');
      md += '## ' + sp + '　*(' + (m.time || '') + ')*\n\n' + (m.text || '') + '\n\n';
      var files = Array.isArray(m.files) ? m.files : (m.file ? [m.file] : []);
      if (files.length) md += files.map(function (f) { return '> 📎 附加檔案：' + (f.name || '(未命名)'); }).join('\n') + '\n\n';
      if (Array.isArray(m.sources) && m.sources.length) md += '**參考來源：**\n' + m.sources.map(function (s, i) { return (i + 1) + '. [' + (s.title || s.uri) + '](' + s.uri + ')'; }).join('\n') + '\n\n';
      md += '---\n\n';
    });
    var safe = title.replace(/[\\/:*?"<>|]/g, '_').trim() || '對話匯出';
    try {
      if (typeof W._novaExportTextFile === 'function') await W._novaExportTextFile(md, safe + '.md', 'text/markdown');
      else { var u = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' })), a = document.createElement('a'); a.href = u; a.download = safe + '.md'; document.body.appendChild(a); a.click(); setTimeout(function () { a.remove(); URL.revokeObjectURL(u); }, 700); }
      showToast('📄 已匯出「' + title + '」為 Markdown 檔案');
    } catch (e) { showToast('❌ 匯出失敗：' + (e.message || e)); }
  };

  W.openChatItemMenu = function (sid, event) {
    var noop = { stopPropagation: function () {} };
    W._novaShowItemMenu(event, [
      { label: '重新命名', icon: 'ph-bold ph-pencil-simple', onClick: function () { W.renameChatSession(sid, noop); } },
      { label: '建立分支對話', icon: 'ph-bold ph-git-fork', onClick: function () { W.branchChatSession(sid, noop); } },
      { label: '匯出成 Markdown', icon: 'ph-bold ph-file-md', onClick: function () { W.exportChatSessionAsMarkdown(sid); } },
      { label: '移至資料夾', icon: 'ph-fill ph-folder-open', onClick: function () { W.openMoveFolderModal(sid, noop); } },
      { label: '刪除', icon: 'ph-bold ph-trash', danger: true, onClick: function () { W.deleteChatSession(sid, noop); } }
    ]);
  };
  W.openChatFolderMenu = function (name, event) {
    W._novaShowItemMenu(event, [
      { label: '重新命名資料夾', icon: 'ph-bold ph-pencil-simple', onClick: function () { W.renameChatFolder(name); } },
      { label: '刪除資料夾', icon: 'ph-bold ph-trash', danger: true, onClick: function () { W.deleteChatFolder(name); } }
    ]);
  };
})();

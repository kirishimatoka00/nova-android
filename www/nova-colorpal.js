/* nova-colorpal.js — v1.0.0 (2026-10-16)
 * 筆記編輯器的「文字顏色／螢光筆／儲存格底色／框線顏色」改用 App 內建色盤。
 * 原因：Android WebView 沒有系統選色視窗（<input type="color"> 點了沒有任何反應），所以選字後點顏色無法改變。
 * 做法：攔截這四個色塊的點擊（一般編輯器 note-fmt-*、全螢幕編輯器 fse-fmt-*），改彈出色盤；選色後呼叫原本的
 *       _novaNoteApplyTextColor／_novaNoteApplyHighlight／_novaNoteApplyCellColor／_novaNoteApplyTableBorderColor。
 *       點色盤不會搶走編輯區焦點，並在按下色塊的瞬間先存下選取範圍（_novaNoteSaveSelection）。
 * 依賴：nova-notes-pro.js 的 _novaNoteSaveSelection 與四個 apply 函式；樣式在 nova-ui.css 第 18 節（.nv-palette）。
 * 版本紀錄
 *   v1.0.0 2026-10-16  首版（含「選取範圍保護」：按下色塊時選取被收成游標，不能蓋掉剛存好的選取）。只在沙盒用 Chromium 驗證選取範圍＋execCommand 流程；真機（Android WebView）請實測。
 */
(function () {
  'use strict';
  var D = document, W = window;
  var COLORS = [
    '#000000', '#475569', '#94a3b8', '#e2e8f0', '#ffffff', '#92400e', '#166534', '#1e3a8a',
    '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#6366f1', '#a855f7',
    '#fecaca', '#fed7aa', '#fef08a', '#bbf7d0', '#99f6e4', '#bfdbfe', '#c7d2fe', '#e9d5ff'
  ];
  var MAP = {
    'note-fmt-textcolor': ['文字顏色', '_novaNoteApplyTextColor', 'edit-note-content'],
    'note-fmt-highlight': ['螢光筆顏色', '_novaNoteApplyHighlight', 'edit-note-content'],
    'note-fmt-cellcolor': ['儲存格底色（游標先點進表格儲存格）', '_novaNoteApplyCellColor', 'edit-note-content'],
    'note-fmt-tableborder': ['表格框線顏色（游標先點進表格）', '_novaNoteApplyTableBorderColor', 'edit-note-content'],
    'fse-fmt-textcolor': ['文字顏色', '_novaNoteApplyTextColor', 'fse-content'],
    'fse-fmt-highlight': ['螢光筆顏色', '_novaNoteApplyHighlight', 'fse-content'],
    'fse-fmt-cellcolor': ['儲存格底色（游標先點進表格儲存格）', '_novaNoteApplyCellColor', 'fse-content'],
    'fse-fmt-tableborder': ['表格框線顏色（游標先點進表格）', '_novaNoteApplyTableBorderColor', 'fse-content']
  };
  var pal = null;

  function closePal() { if (pal && pal.parentNode) pal.parentNode.removeChild(pal); pal = null; }

  function colorInputOf(target) {
    if (!target || !target.closest) return null;
    var inp = target.matches && target.matches('input[type=color]') ? target : null;
    if (!inp) { var lab = target.closest('label'); if (lab) inp = lab.querySelector('input[type=color]'); }
    return inp && MAP[inp.id] ? inp : null;
  }

  function open(inp) {
    closePal();
    var cfg = MAP[inp.id], anchor = (inp.closest('label') || inp).getBoundingClientRect();
    var box = D.createElement('div'); box.className = 'nv-palette';
    var html = '<div class="nv-pal-title">' + cfg[0] + '</div><div class="nv-pal-grid">';
    COLORS.forEach(function (c) { html += '<button type="button" class="nv-sw" data-c="' + c + '" style="background:' + c + '" aria-label="' + c + '"></button>'; });
    html += '</div><div class="nv-pal-row"><input type="text" placeholder="#RRGGBB" maxlength="7" value="' + (inp.value || '') + '"><button type="button" class="nv-pal-btn" data-ok="1">套用</button></div>';
    box.innerHTML = html;
    D.body.appendChild(box);
    // 點色盤不要搶走編輯區的焦點／選取範圍（文字輸入框除外）
    box.addEventListener('pointerdown', function (e) { if (!(e.target.tagName === 'INPUT')) e.preventDefault(); });
    box.addEventListener('mousedown', function (e) { if (!(e.target.tagName === 'INPUT')) e.preventDefault(); });
    function pick(c) {
      if (!/^#[0-9a-fA-F]{6}$/.test(c)) { if (W.showToast) W.showToast('請輸入 #RRGGBB 格式，例如 #ff8800'); return; }
      try { inp.value = c; } catch (e) {}
      try { if (typeof W[cfg[1]] === 'function') W[cfg[1]](c, cfg[2]); } catch (e) { console.warn('[colorpal]', e); }
      closePal();
    }
    box.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('button'); if (!b) return;
      e.stopPropagation();
      if (b.dataset.c) pick(b.dataset.c);
      else if (b.dataset.ok) pick((box.querySelector('input').value || '').trim());
    });
    var w = box.offsetWidth, h = box.offsetHeight;
    var left = Math.min(Math.max(8, anchor.left), W.innerWidth - w - 8), top = anchor.bottom + 6;
    if (top + h > W.innerHeight - 8) top = Math.max(8, anchor.top - h - 6);
    box.style.left = left + 'px'; box.style.top = top + 'px';
    pal = box;
  }

  // 保護：按下色塊的過程中，選取範圍可能先被瀏覽器收成游標（collapsed），後面的儲存呼叫不能把剛存好的「有選取文字」範圍蓋掉
  (function guardSave() {
    var orig = W._novaNoteSaveSelection, goodAt = 0;
    if (typeof orig !== 'function') return;
    W._novaNoteSaveSelection = function () {
      var s = W.getSelection && W.getSelection();
      if (!s || !s.rangeCount) return;
      if (!s.isCollapsed) { goodAt = Date.now(); orig(); }
      else if (Date.now() - goodAt > 2000) orig();
    };
  })();
  // 按下色塊的瞬間先存選取範圍（這時選取還沒被破壞）
  ['pointerdown', 'touchstart', 'mousedown'].forEach(function (ev) {
    D.addEventListener(ev, function (e) {
      if (pal && !pal.contains(e.target)) closePal();
      if (colorInputOf(e.target) && typeof W._novaNoteSaveSelection === 'function') W._novaNoteSaveSelection();
    }, true);
  });
  // 攔截點擊：不讓 WebView 嘗試開（不存在的）系統選色視窗，改開內建色盤
  D.addEventListener('click', function (e) {
    var inp = colorInputOf(e.target);
    if (!inp) return;
    e.preventDefault(); e.stopPropagation();
    open(inp);
  }, true);
  W.novaClosePalette = closePal;
})();

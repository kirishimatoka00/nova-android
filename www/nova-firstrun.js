/* nova-firstrun.js v1.0.0 (2026-10-12) — 重新安裝後「從舊備份還原」提示
 * 背景：解除安裝會清掉 App 的內部資料（設定、對話、筆記）。Android 11+ 的分區儲存下，新安裝的 App
 *       不一定讀得到上次安裝寫在 Documents/NOVA_Backups 的檔案，所以改成偵測到「全新安裝」時，
 *       主動請使用者用系統檔案選擇器指定備份檔（NOVA_Live.json 或 NOVA_FullBackup_*.json），走既有的還原流程。
 * 版本紀錄：v1.0.0 初版
 */
(function () {
  'use strict';
  var D = document, W = window;
  function ls(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function fresh() {
    var A = W.appState; if (!A) return false;
    var hasKey = A.keys && (A.keys.gemini || A.keys.openai || A.keys.grok || A.keys.groq);
    return !hasKey && (A.notes || []).length === 0 && (A.todos || []).length === 0 && (A.messages || []).length <= 1;
  }
  function show() {
    if (D.getElementById('nova-firstrun')) return;
    var el = D.createElement('div'); el.id = 'nova-firstrun';
    el.style.cssText = 'position:fixed;inset:0;z-index:2147482000;background:rgba(2,6,23,.85);display:flex;align-items:center;justify-content:center;padding:16px;';
    el.innerHTML = '<div style="max-width:420px;width:100%;background:#0f172a;border:1px solid #334155;border-radius:16px;padding:20px;color:#e2e8f0;font-size:14px;line-height:1.6;">' +
      '<div style="font-weight:700;font-size:16px;margin-bottom:8px;">🔄 要從舊備份還原嗎？</div>' +
      '<div style="color:#94a3b8;margin-bottom:12px;">看起來這是全新安裝（沒有任何設定與資料）。如果之前備份過，可以選擇備份檔，一次還原設定、金鑰、對話、筆記與 AI 記憶。</div>' +
      '<div style="color:#94a3b8;font-size:12px;margin-bottom:14px;">備份檔位置：內部儲存空間 → Documents → NOVA_Backups<br>・NOVA_Live.json（自動快照）<br>・NOVA_FullBackup_日期.json（手動完整備份）<br>・NOVA_Live_上次安裝.json（重裝後自動保留的舊快照）</div>' +
      '<div style="display:flex;gap:8px;"><button id="nfr-pick" style="flex:1;padding:10px;border-radius:10px;background:#2563eb;color:#fff;font-weight:700;">選擇備份檔</button>' +
      '<button id="nfr-skip" style="padding:10px 14px;border-radius:10px;background:#334155;color:#e2e8f0;">略過</button></div></div>';
    D.body.appendChild(el);
    D.getElementById('nfr-skip').onclick = function () { try { localStorage.setItem('nova_firstrun_dismissed', '1'); } catch (e) {} el.remove(); };
    D.getElementById('nfr-pick').onclick = function () {
      var inp = D.getElementById('import-settings-input');
      if (!inp) { alert('找不到還原功能，請到 設定 → 完整備份旁的還原鍵手動選擇'); return; }
      el.remove();
      try { localStorage.setItem('nova_firstrun_dismissed', '1'); } catch (e) {}
      inp.click();
    };
  }
  function check() { if (ls('nova_firstrun_dismissed') === '1') return; if (fresh()) show(); }
  setTimeout(check, 6000);
  W.novaShowRestorePrompt = show;
})();

# NOVA Termux 橋接

讓 NOVA（手機版）的「工具呼叫」與「自主任務」能在 Termux 裡執行真正的 Python／指令。

安裝（在 Termux 貼上一行）：

```
curl -fsSL https://raw.githubusercontent.com/kirishimatoka00/nova-android/main/termux/install.sh | bash
```

完成後會顯示 Token，貼到 NOVA：設定 → 🔌 工具 → Termux 橋接。

- 只監聽 `127.0.0.1:7913`，每個請求都要 token；Python 標準函式庫即可，沒有額外依賴。
- 工作資料夾：`~/nova_work`（Python／指令預設在這裡執行，新增或修改的檔案會回報給 NOVA）。
- 讀取簡訊、定位、通知等手機功能：另外安裝 **Termux:API** App（F-Droid 版，需與 Termux 同來源），再用 `termux-sms-list`、`termux-location` 等指令。
- 建議在系統設定把 Termux 的電池使用設為「不受限制」，並保持 Termux 通知存在，否則 Android 會在背景把它殺掉。
- 重新啟動 `bash ~/nova_bridge/start.sh`、停止 `bash ~/nova_bridge/stop.sh`、記錄 `~/nova_bridge/bridge.log`。

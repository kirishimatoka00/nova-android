#!/data/data/com.termux/files/usr/bin/bash
# NOVA Termux Bridge 安裝／更新腳本（在 Termux 裡執行；重複執行就是更新，token 會保留）
# 版本紀錄：
#   v1.1.0 - App v2.6.76。先 pkg update／upgrade（含重試；修 curl 與 openssl 版本不一致的連結錯誤）；套件安裝失敗時重裝 openssl／curl 再試；
#            橋接程式下載 curl 失敗時改用 Python urllib 備援，並檢查語法完整；找不到 python 時明確中止。
#   v1.0.0 - App v2.6.72。初版。
#   curl -fsSL https://raw.githubusercontent.com/kirishimatoka00/nova-android/main/termux/install.sh | bash
set -e
RAW="https://raw.githubusercontent.com/kirishimatoka00/nova-android/main/termux"
D="$HOME/nova_bridge"
echo "▶ 更新套件庫並升級已安裝套件（避免 curl／openssl 版本不一致造成 SSL_set_quic_tls_transport_params 之類的連結錯誤）…"
export DEBIAN_FRONTEND=noninteractive
pkg_try() { "$@" || { echo "  （失敗，3 秒後重試一次）"; sleep 3; "$@"; }; }
pkg_try pkg update -y || true
pkg_try pkg upgrade -y -o Dpkg::Options::="--force-confold" || echo "⚠️ 套件升級沒有完全成功，繼續嘗試安裝…"
echo "▶ 安裝套件（python、curl、termux-api 指令列工具）…"
pkg install -y python curl termux-api || { echo "⚠️ 安裝失敗，嘗試重新安裝 curl／openssl 後再試…"; pkg install -y --reinstall openssl curl libcurl || true; pkg install -y python curl termux-api; }
if ! curl --version >/dev/null 2>&1; then
  echo "⚠️ curl 無法執行，重新安裝 openssl／curl…"
  pkg install -y --reinstall openssl libcurl curl || true
fi
command -v python >/dev/null 2>&1 || { echo "❌ python 沒有安裝成功，請先執行 pkg upgrade -y 後再重跑安裝指令"; exit 1; }
mkdir -p "$D" "$HOME/nova_work"
echo "▶ 下載橋接程式…"
# 先用 curl；curl 壞掉或失敗時改用 Python 內建的 urllib 下載（不依賴 curl／openssl 命令列工具）
fetch() {
  curl -fsSL "$1" -o "$2" 2>/dev/null && [ -s "$2" ] && return 0
  echo "  curl 下載失敗，改用 Python 下載…"
  python - "$1" "$2" <<'EOPY'
import sys, urllib.request
urllib.request.urlretrieve(sys.argv[1], sys.argv[2])
EOPY
  [ -s "$2" ]
}
fetch "$RAW/nova_bridge.py" "$D/nova_bridge.py" || { echo "❌ 下載 nova_bridge.py 失敗，請確認網路後重新執行"; exit 1; }
python -m py_compile "$D/nova_bridge.py" || { echo "❌ nova_bridge.py 內容不完整，請重新執行"; exit 1; }
if [ ! -s "$D/token" ]; then
  python -c "import secrets;print(secrets.token_urlsafe(24))" > "$D/token"
fi
chmod 600 "$D/token"
cat > "$D/start.sh" <<'EOS'
#!/data/data/com.termux/files/usr/bin/bash
# 啟動（或重啟）NOVA 橋接服務；termux-wake-lock 讓 Termux 在背景不被系統睡眠
termux-wake-lock 2>/dev/null || true
pkill -f nova_bridge.py 2>/dev/null || true
sleep 1
nohup python "$HOME/nova_bridge/nova_bridge.py" >> "$HOME/nova_bridge/bridge.log" 2>&1 &
echo "NOVA 橋接服務已啟動（http://127.0.0.1:7913）"
EOS
cat > "$D/stop.sh" <<'EOS'
#!/data/data/com.termux/files/usr/bin/bash
pkill -f nova_bridge.py && echo "已停止" || echo "沒有在執行"
termux-wake-unlock 2>/dev/null || true
EOS
chmod +x "$D/start.sh" "$D/stop.sh"
# 若有安裝 Termux:Boot，開機後自動啟動
mkdir -p "$HOME/.termux/boot"
printf '#!/data/data/com.termux/files/usr/bin/bash\nbash "$HOME/nova_bridge/start.sh"\n' > "$HOME/.termux/boot/nova_bridge.sh"
chmod +x "$HOME/.termux/boot/nova_bridge.sh"
bash "$D/start.sh"
sleep 2
echo
echo "════════════════════════════════════════"
echo "✅ 安裝完成。請把下面這串 Token 貼到 NOVA："
echo "   設定 → 🔌 工具 → Termux 橋接 → Token"
echo
echo "   $(cat "$D/token")"
echo
echo "之後重新啟動：bash ~/nova_bridge/start.sh　　停止：bash ~/nova_bridge/stop.sh"
echo "════════════════════════════════════════"

#!/data/data/com.termux/files/usr/bin/bash
# NOVA Termux Bridge 安裝／更新腳本（在 Termux 裡執行；重複執行就是更新，token 會保留）
#   curl -fsSL https://raw.githubusercontent.com/kirishimatoka00/nova-android/main/termux/install.sh | bash
set -e
RAW="https://raw.githubusercontent.com/kirishimatoka00/nova-android/main/termux"
D="$HOME/nova_bridge"
echo "▶ 安裝套件（python、curl、termux-api 指令列工具）…"
pkg update -y >/dev/null 2>&1 || true
pkg install -y python curl termux-api
mkdir -p "$D" "$HOME/nova_work"
echo "▶ 下載橋接程式…"
curl -fsSL "$RAW/nova_bridge.py" -o "$D/nova_bridge.py"
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

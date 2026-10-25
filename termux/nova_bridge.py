#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
NOVA Termux Bridge v1.1.0
讓手機上的 NOVA（Android App）把 Python／指令送到 Termux 執行，結果回傳給 NOVA。
核心只用 Python 標準函式庫。選用工具（檔案轉 Markdown、影片字幕）在 nova_tools.py，需另外 pip 安裝 markitdown／yt-dlp。
v1.1.0：新增 /tools/status、/markitdown、/subtitles（App v2.6.92）。

安全設計（這個服務等於把手機的 Termux 交給持有 token 的人，請務必留意）：
  1. 只監聽 127.0.0.1（手機本機），區網與外部連不到。
  2. 每個請求都要帶 X-Nova-Token，token 存在 ~/nova_bridge/token（安裝時隨機產生）。
  3. 檢查 Host 標頭（擋 DNS rebinding）與 Origin 標頭（只允許 NOVA 的 http(s)://localhost；一般網頁的請求會被拒絕）。
  4. 執行逾時會連同子行程一起強制結束；輸出有長度上限。
"""
import hmac
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    import nova_tools
except Exception as _e:  # noqa: BLE001  橋接核心不因選用工具壞掉而無法啟動
    nova_tools = None
    sys.stderr.write("nova_tools 載入失敗：%s\n" % _e)

VERSION = "1.1.0"
HOST = "127.0.0.1"
PORT = int(os.environ.get("NOVA_BRIDGE_PORT", "7913"))
BASE = os.path.expanduser("~/nova_bridge")
WORK = os.path.expanduser(os.environ.get("NOVA_WORK_DIR", "~/nova_work"))
MAX_OUT = 20000
MAX_BODY = 2 * 1024 * 1024
MAX_BODY_BIG = 64 * 1024 * 1024   # /markitdown 帶檔案（base64）
MAX_TIMEOUT = 600
ALLOWED_ORIGINS = {"http://localhost", "https://localhost", "capacitor://localhost"}


def load_token():
    t = os.environ.get("NOVA_BRIDGE_TOKEN", "").strip()
    if t:
        return t
    try:
        with open(os.path.join(BASE, "token"), "r", encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


TOKEN = load_token()


def clip(s):
    if len(s) <= MAX_OUT:
        return s
    head = MAX_OUT * 2 // 3
    tail = MAX_OUT - head
    return s[:head] + "\n…（輸出過長，中間省略 %d 字）…\n" % (len(s) - MAX_OUT) + s[-tail:]


def snapshot():
    snap = {}
    n = 0
    for root, dirs, files in os.walk(WORK):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for name in files:
            p = os.path.join(root, name)
            try:
                st = os.stat(p)
            except OSError:
                continue
            snap[p] = (st.st_mtime, st.st_size)
            n += 1
            if n > 3000:
                return snap
    return snap


def changed_files(before, after):
    out = []
    for p, v in after.items():
        if before.get(p) != v:
            out.append({"path": os.path.relpath(p, WORK), "size": v[1]})
    return out[:60]


def run_proc(argv=None, cmd=None, timeout=60, cwd=None):
    timeout = max(1, min(int(timeout or 60), MAX_TIMEOUT))
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUNBUFFERED"] = "1"
    before = snapshot()
    t0 = time.time()
    timed_out = False
    kw = dict(stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=cwd or WORK, env=env, start_new_session=True)
    if argv is not None:
        p = subprocess.Popen(argv, **kw)
    else:
        p = subprocess.Popen(["bash", "-c", cmd], **kw)
    try:
        out, err = p.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except OSError:
            p.kill()
        out, err = p.communicate()
    return {
        "ok": (not timed_out) and p.returncode == 0,
        "exit": p.returncode,
        "timed_out": timed_out,
        "stdout": clip(out.decode("utf-8", "replace")),
        "stderr": clip(err.decode("utf-8", "replace")),
        "ms": int((time.time() - t0) * 1000),
        "files": changed_files(before, snapshot()),
    }


def run_python(code, timeout):
    d = os.path.join(WORK, ".run")
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, uuid.uuid4().hex + ".py")
    with open(path, "w", encoding="utf-8") as f:
        f.write(code)
    try:
        return run_proc(argv=[sys.executable, "-u", path], timeout=timeout)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


class H(BaseHTTPRequestHandler):
    server_version = "NovaBridge/" + VERSION
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def _cors(self):
        o = self.headers.get("Origin")
        if o in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", o)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Nova-Token")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _send(self, code, obj):
        b = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self._cors()
        self.end_headers()
        self.wfile.write(b)

    def _host_ok(self):
        h = (self.headers.get("Host") or "").lower()
        return h in ("127.0.0.1:%d" % PORT, "localhost:%d" % PORT)

    def _origin_ok(self):
        o = self.headers.get("Origin")
        return (o is None) or (o in ALLOWED_ORIGINS)

    def _authed(self):
        t = self.headers.get("X-Nova-Token") or ""
        return bool(TOKEN) and hmac.compare_digest(t.encode(), TOKEN.encode())

    def do_OPTIONS(self):
        if not (self._host_ok() and self._origin_ok()):
            return self._send(403, {"ok": False, "error": "forbidden"})
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self._cors()
        self.end_headers()

    def do_GET(self):
        if not (self._host_ok() and self._origin_ok()):
            return self._send(403, {"ok": False, "error": "forbidden"})
        if self.path.split("?")[0] == "/ping":
            info = {"ok": True, "version": VERSION, "auth": self._authed()}
            if info["auth"]:
                info.update({
                    "python": sys.version.split()[0],
                    "work_dir": WORK,
                    "termux_api": bool(shutil.which("termux-battery-status")),
                    "tools": nova_tools is not None,
                })
            return self._send(200, info)
        if self.path.split("?")[0] == "/tools/status":
            if not self._authed():
                return self._send(401, {"ok": False, "error": "token 不正確或未設定"})
            if nova_tools is None:
                return self._send(200, {"ok": True, "tools": False, "markitdown": {"available": False, "error": "nova_tools.py 沒有載入（請重新執行 install.sh）"}, "ytdlp": {"available": False, "error": "nova_tools.py 沒有載入"}})
            return self._send(200, {"ok": True, "tools": True, "markitdown": nova_tools.markitdown_status(), "ytdlp": nova_tools.ytdlp_status()})
        self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        # HTTP/1.1 長連線：任何提早回應都必須先讀完（或放棄）請求本文，否則殘留的本文會污染同一條連線的下一個請求
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if not (self._host_ok() and self._origin_ok()):
            self.close_connection = True
            return self._send(403, {"ok": False, "error": "forbidden"})
        if n > (MAX_BODY_BIG if self.path.split("?")[0] == "/markitdown" else MAX_BODY):
            self.close_connection = True
            return self._send(413, {"ok": False, "error": "內容過大"})
        raw = self.rfile.read(n) if n else b""
        if not self._authed():
            return self._send(401, {"ok": False, "error": "token 不正確或未設定"})
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except Exception as e:  # noqa: BLE001
            return self._send(400, {"ok": False, "error": "請求格式錯誤：%s" % e})
        path = self.path.split("?")[0]
        try:
            os.makedirs(WORK, exist_ok=True)
            if path == "/run":
                code = str(body.get("code") or "")
                if not code.strip():
                    return self._send(400, {"ok": False, "error": "缺少 code"})
                return self._send(200, run_python(code, body.get("timeout")))
            if path == "/shell":
                cmd = str(body.get("cmd") or "")
                if not cmd.strip():
                    return self._send(400, {"ok": False, "error": "缺少 cmd"})
                return self._send(200, run_proc(cmd=cmd, timeout=body.get("timeout")))
            if path == "/pip":
                pk = [str(x) for x in (body.get("packages") or []) if str(x).strip()]
                if not pk or any(x.startswith("-") for x in pk):
                    return self._send(400, {"ok": False, "error": "packages 不可為空，也不可以 - 開頭"})
                return self._send(200, run_proc(argv=[sys.executable, "-m", "pip", "install", "--disable-pip-version-check"] + (["--upgrade"] if body.get("upgrade") else []) + pk, timeout=body.get("timeout") or 300))
            if path in ("/markitdown", "/subtitles"):
                if nova_tools is None:
                    return self._send(501, {"ok": False, "error": "nova_tools.py 沒有載入，請在 Termux 重新執行 install.sh 更新"})
                try:
                    if path == "/markitdown":
                        return self._send(200, nova_tools.markitdown_convert(body.get("name"), body.get("data_base64"), body.get("max_chars") or 400000))
                    return self._send(200, nova_tools.video_subtitles(body.get("url"), body.get("langs"), body.get("lang") or "", body.get("timestamps") is not False, body.get("max_chars") or 400000))
                except nova_tools.ToolError as te:
                    return self._send(te.status, {"ok": False, "error": te.detail})
        except Exception as e:  # noqa: BLE001
            return self._send(500, {"ok": False, "error": "橋接服務內部錯誤：%s" % e})
        self._send(404, {"ok": False, "error": "not found"})


def main():
    if not TOKEN:
        sys.stderr.write("找不到 token（%s/token）。請先執行 install.sh，或設定環境變數 NOVA_BRIDGE_TOKEN。\n" % BASE)
        sys.exit(2)
    os.makedirs(WORK, exist_ok=True)
    srv = ThreadingHTTPServer((HOST, PORT), H)
    srv.daemon_threads = True
    sys.stderr.write("NOVA Termux Bridge v%s 已啟動：http://%s:%d　工作資料夾：%s\n" % (VERSION, HOST, PORT, WORK))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

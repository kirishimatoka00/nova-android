# -*- coding: utf-8 -*-
"""
nova_tools.py v1.0.0 — NOVA Termux 橋接的選用工具：檔案轉 Markdown（markitdown）、影片字幕（yt-dlp）。
移植自 NOVA Desktop python-engine（v0.8.50–0.8.53）。markitdown／yt-dlp 都是選用套件，沒裝時只影響對應端點。
由 nova_bridge.py 匯入；本檔不單獨執行。
"""
import base64
import datetime
import json
import os
import re
import tempfile
import threading
import time


class ToolError(Exception):
    def __init__(self, status, detail):
        Exception.__init__(self, detail)
        self.status = status
        self.detail = detail


_MARKITDOWN_OBJ = None
_MARKITDOWN_ERR = ""
_MARKITDOWN_LOCK = threading.Lock()
_MARKITDOWN_MAX_BYTES = 60 * 1024 * 1024
_MARKITDOWN_FORMATS = ["docx", "pptx", "xlsx", "xls", "pdf", "html", "htm", "epub", "csv", "json", "xml", "msg", "zip", "txt", "md"]


def _md_fix_empty_header(text: str) -> str:
    """★ v0.8.52：markitdown 轉 docx 的表格會多出一列全空的表頭（|  |  |），真正的欄名變成第一列資料。
    這裡把「全空表頭」整列拿掉，並把下一列升為表頭（保留原本的分隔列位置語意），其餘行不動。"""
    if not text or "|" not in text:
        return text
    lines = text.split("\n")
    out = []
    i = 0
    n = len(lines)
    def _cells(l):
        t = l.strip()
        if not (t.startswith("|") and t.endswith("|")):
            return None
        return [c.strip() for c in t.strip("|").split("|")]
    def _is_sep(l):
        c = _cells(l)
        return c is not None and len(c) > 0 and all(re.fullmatch(r":?-{3,}:?", x or "") for x in c)
    while i < n:
        c0 = _cells(lines[i])
        if c0 is not None and all(x == "" for x in c0) and i + 2 < n and _is_sep(lines[i + 1]) and _cells(lines[i + 2]) is not None and not _is_sep(lines[i + 2]):
            out.append(lines[i + 2])      # 新表頭＝原本第一列資料
            out.append(lines[i + 1])      # 分隔列
            i += 3
            continue
        out.append(lines[i])
        i += 1
    return "\n".join(out)


def _markitdown_get():
    """惰性載入 MarkItDown；失敗時記下原因（_MARKITDOWN_ERR）並回 None。"""
    global _MARKITDOWN_OBJ, _MARKITDOWN_ERR
    if _MARKITDOWN_OBJ is not None:
        return _MARKITDOWN_OBJ
    with _MARKITDOWN_LOCK:
        if _MARKITDOWN_OBJ is None and not _MARKITDOWN_ERR:
            try:
                try:
                    if os.environ.get("NOVA_FORCE_NO_MAGIKA") == "1":
                        raise ImportError("magika (forced)")
                    from markitdown import MarkItDown
                except ImportError as ie:
                    # Termux（Android／ARM）常裝不到 magika 依賴的 onnxruntime。markitdown 只拿 magika 輔助猜檔案類型，
                    # 我們一律用副檔名轉檔，所以塞一個「永遠回報無法判斷」的替身讓 markitdown 能載入。
                    if "magika" not in str(ie).lower() and "onnxruntime" not in str(ie).lower():
                        raise
                    import types
                    import sys as _sys
                    stub = types.ModuleType("magika")

                    class _Magika(object):
                        def identify_stream(self, *_a, **_k):
                            return types.SimpleNamespace(status="error", prediction=None)

                        def identify_bytes(self, *_a, **_k):
                            return types.SimpleNamespace(status="error", prediction=None)

                        def identify_path(self, *_a, **_k):
                            return types.SimpleNamespace(status="error", prediction=None)
                    stub.Magika = _Magika
                    _sys.modules["magika"] = stub
                    for _k in [k for k in _sys.modules if k == "markitdown" or k.startswith("markitdown.")]:
                        del _sys.modules[_k]
                    from markitdown import MarkItDown
                _MARKITDOWN_OBJ = MarkItDown(enable_plugins=False)
            except Exception as e:
                _MARKITDOWN_ERR = "%s: %s" % (type(e).__name__, e)
    return _MARKITDOWN_OBJ


def _markitdown_version():
    try:
        import importlib.metadata as _im
        return _im.version("markitdown")
    except Exception:
        return ""




def markitdown_status():
    md = _markitdown_get()
    return {"available": md is not None, "version": _markitdown_version() if md is not None else "",
            "error": _MARKITDOWN_ERR, "formats": _MARKITDOWN_FORMATS}


def markitdown_convert(name, data_base64, max_chars=400000):
    t0 = time.time()
    md = _markitdown_get()
    if md is None:
        raise ToolError(501, '尚未安裝 markitdown（%s）。請在 Termux 執行：pip install "markitdown[docx,pptx,xlsx,xls,pdf]"（或到 NOVA 設定 → 工具 → Termux 橋接按「安裝文件／影片工具」）。' % (_MARKITDOWN_ERR or "import 失敗"))
    try:
        raw = base64.b64decode(data_base64 or "", validate=False)
    except Exception as e:
        raise ToolError(400, "data_base64 解碼失敗：%s" % e)
    if not raw:
        raise ToolError(400, "檔案內容是空的")
    if len(raw) > _MARKITDOWN_MAX_BYTES:
        raise ToolError(413, "檔案太大（上限 %d MB）" % (_MARKITDOWN_MAX_BYTES // 1024 // 1024))
    base = os.path.basename(str(name or "file").replace("\\", "/")) or "file"
    ext = os.path.splitext(base)[1].lower()
    if not re.fullmatch(r"\.[a-z0-9]{1,8}", ext or ""):
        ext = ""
    if ext in (".docx", ".pptx", ".xlsx", ".epub", ".zip") and not raw.startswith(b"PK"):
        raise ToolError(422, "這不是有效的 %s 檔（檔頭不符）" % ext)
    if ext == ".xls" and not raw.startswith(b"\xd0\xcf\x11\xe0"):
        raise ToolError(422, "這不是有效的 .xls 檔（檔頭不符）")
    if ext == ".pdf" and not raw.lstrip()[:5] == b"%PDF-":
        raise ToolError(422, "這不是有效的 .pdf 檔（檔頭不符）")
    tmp_path = ""
    try:
        with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tf:
            tf.write(raw)
            tmp_path = tf.name
        res = md.convert(tmp_path)
        text = getattr(res, "markdown", None) or getattr(res, "text_content", "") or ""
    except Exception as e:
        msg = str(e)
        m = re.search(r"markitdown\[([^\]]+)\]", msg)
        if "MissingDependencyException" in msg or "dependencies needed" in msg:
            raise ToolError(501, '缺少讀取這種檔案的相依套件。請執行：pip install "markitdown[%s]"' % (m.group(1).split(",")[0].strip() if m else "all"))
        raise ToolError(422, "轉換失敗（%s）：%s" % (type(e).__name__, msg[:300]))
    finally:
        if tmp_path:
            try:
                os.remove(tmp_path)
            except Exception:
                pass
    text = _md_fix_empty_header(text)
    limit = max(1000, min(int(max_chars or 400000), 2000000))
    truncated = len(text) > limit
    if truncated:
        text = text[:limit]
    return {"ok": True, "markdown": text, "chars": len(text), "truncated": truncated, "elapsed_ms": int((time.time() - t0) * 1000)}


_YTDLP_PREF_EXTS = ("vtt", "srt", "json3", "srv1", "srv3", "ttml")
_YTDLP_DEFAULT_LANGS = ["zh-Hant", "zh-TW", "zh-Hans", "zh-CN", "zh", "en"]


def _ytdlp_get():
    try:
        import yt_dlp
        return yt_dlp
    except Exception as e:
        return None


def ytdlp_status():
    y = _ytdlp_get()
    if y is None:
        return {"available": False, "version": "", "stale": False, "error": '尚未安裝 yt-dlp（pip install -U "yt-dlp[default]"）'}
    ver = ""
    try:
        ver = y.version.__version__
    except Exception:
        pass
    stale = False
    try:
        d = datetime.datetime.strptime(".".join(ver.split(".")[:3]), "%Y.%m.%d").date()
        stale = (datetime.date.today() - d).days > 120
    except Exception:
        pass
    return {"available": True, "version": ver, "stale": stale, "error": ""}


def _ts_clock(sec):
    sec = int(max(0, sec))
    return "%02d:%02d:%02d" % (sec // 3600, (sec % 3600) // 60, sec % 60)


def _sub_clean(t):
    import html as _html
    t = re.sub(r"<[^>]+>", "", t or "")
    t = _html.unescape(_html.unescape(t)).replace("\u200b", "").replace("\xa0", " ")     # YouTube 的 srv1 是雙重跳脫（&amp;#39;）；\u200b＝零寬空白
    return re.sub(r"\s+", " ", t).strip()


def _vtt_time(s):
    s = s.strip().replace(",", ".")
    parts = s.split(":")
    try:
        parts = [float(x) for x in parts]
    except Exception:
        return None
    sec = 0.0
    for p_ in parts:
        sec = sec * 60 + p_
    return sec


def _parse_subtitle(raw: str, ext: str):
    """各種字幕格式 → [(開始秒, 文字)]。自動字幕的 VTT 會「滾動重複」前一行，這裡去掉重複。"""
    ext = (ext or "").lower()
    cues = []
    if ext in ("vtt", "srt"):
        blocks = re.split(r"\r?\n\r?\n+", raw.replace("﻿", ""))
        for b in blocks:
            lines = [l for l in b.splitlines() if l.strip()]
            for i, l in enumerate(lines):
                if "-->" in l:
                    st = _vtt_time(l.split("-->")[0].strip().split(" ")[0])
                    body = lines[i + 1:]
                    if st is not None:
                        cues.append((st, [x for x in body]))
                    break
        out = []
        last = ""
        for st, body in cues:
            for ln in body:
                tx = _sub_clean(ln)
                if not tx or tx == last:
                    continue
                out.append((st, tx))
                last = tx
        return out
    if ext == "json3":
        data = json.loads(raw)
        out = []
        last = ""
        for ev in data.get("events", []):
            segs = ev.get("segs") or []
            tx = _sub_clean("".join(sg.get("utf8", "") for sg in segs))
            if not tx or tx == last:
                continue
            out.append(((ev.get("tStartMs") or 0) / 1000.0, tx))
            last = tx
        return out
    if ext in ("srv1", "srv2", "srv3", "ttml", "xml"):
        out = []
        last = ""
        for m in re.finditer(r"<(?:text|p)\b([^>]*)>([\s\S]*?)</(?:text|p)>", raw):
            attrs, body = m.group(1), m.group(2)
            st = None
            a = re.search(r'\bstart="([\d.]+)"', attrs)
            if a:
                st = float(a.group(1))
            else:
                a = re.search(r'\bt="(\d+)"', attrs)
                if a:
                    st = int(a.group(1)) / 1000.0
                else:
                    a = re.search(r'\bbegin="([\d:.,]+)"', attrs)
                    if a:
                        st = _vtt_time(a.group(1))
            tx = _sub_clean(body)
            if st is None or not tx or tx == last:
                continue
            out.append((st, tx))
            last = tx
        return out
    raise ValueError("不支援的字幕格式：%s" % ext)


def _cues_to_text(cues, with_ts=True, para_sec=45):
    """把 [(秒, 文字)] 合併成段落（每約 para_sec 秒一段，段首加 [hh:mm:ss]）。"""
    paras = []
    cur_start = None
    cur = []
    for st, tx in cues:
        if cur_start is None:
            cur_start = st
        if cur and st - cur_start >= para_sec:
            paras.append((cur_start, " ".join(cur)))
            cur_start, cur = st, []
        cur.append(tx)
    if cur:
        paras.append((cur_start or 0, " ".join(cur)))
    if with_ts:
        return "\n\n".join("[%s] %s" % (_ts_clock(s), t) for s, t in paras)
    return "\n\n".join(t for _, t in paras)


def _lang_match(key, want, base_only=False):
    k, w = key.lower(), want.lower()
    if base_only:
        return k.split("-")[0] == w.split("-")[0]
    return k == w or k.startswith(w + "-") or w.startswith(k + "-")


def _pick_subtitle_track(info, langs, force_lang=""):
    """回傳 (source, lang_key, 該語言的格式清單) 或 None。source：manual／auto。"""
    manual = {k: v for k, v in (info.get("subtitles") or {}).items() if v and k != "live_chat"}
    auto = {k: v for k, v in (info.get("automatic_captions") or {}).items() if v}
    def usable(fmts):
        return any((f.get("ext") or "").lower() in _YTDLP_PREF_EXTS for f in fmts)
    manual = {k: v for k, v in manual.items() if usable(v)}
    auto = {k: v for k, v in auto.items() if usable(v)}
    if force_lang:
        for src, pool in (("manual", manual), ("auto", auto)):
            if force_lang in pool:
                return src, force_lang, pool[force_lang]
        return None
    for w in langs:
        for k in manual:
            if _lang_match(k, w):
                return "manual", k, manual[k]
    for w in langs:        # 同語系但寫法不同（例如想要 zh-TW、影片只有 zh-Hant／zh-Hans）
        for k in manual:
            if _lang_match(k, w, True):
                return "manual", k, manual[k]
    vid_lang = (info.get("language") or "").lower()
    if manual:
        for k in manual:
            if vid_lang and _lang_match(k, vid_lang):
                return "manual", k, manual[k]
        k = next(iter(manual))
        return "manual", k, manual[k]
    # 自動字幕：YouTube 會列出幾十種「機器翻譯」語言，原語言的軌道 key 帶 -orig（或等於影片語言）；優先用原語言，才是最準的
    orig = [k for k in auto if k.endswith("-orig")]
    if orig:
        return "auto", orig[0], auto[orig[0]]
    for k in auto:
        if vid_lang and _lang_match(k, vid_lang):
            return "auto", k, auto[k]
    for w in langs:
        for k in auto:
            if _lang_match(k, w):
                return "auto", k, auto[k]
    if auto:
        k = next(iter(auto))
        return "auto", k, auto[k]
    return None


def _ytdlp_clean_error(msg):
    m = re.sub(r"\x1b\[[0-9;]*m", "", str(msg or "")).strip()
    m = re.sub(r"^ERROR:\s*", "", m)
    low = m.lower()
    hint = ""
    if "sign in to confirm" in low or "not a bot" in low:
        hint = "平台要求登入或人機驗證，yt-dlp 目前沒有帶登入資料，這支影片抓不到。"
    elif "private video" in low or "members-only" in low or "join this channel" in low:
        hint = "這是私人或會員限定的影片。"
    elif "confirm your age" in low or "age-restricted" in low:
        hint = "這支影片有年齡限制，需要登入才能存取。"
    elif "not available in your country" in low or "geo" in low:
        hint = "這支影片有地區限制。"
    elif "unsupported url" in low:
        hint = "這個網址不是 yt-dlp 支援的影音頁面。"
    elif "429" in low or "too many requests" in low:
        hint = "被平台暫時限流，請稍後再試。"
    elif "is live" in low or "live event" in low:
        hint = "這是直播，還沒有可抓的字幕。"
    tail = "（若影片在瀏覽器可以正常播放，常見原因是 yt-dlp 版本太舊——平台改版後舊版會失效，需要更新 yt-dlp 並重新打包。）" if not hint else ""
    return ((hint + " ") if hint else "") + m[:300] + tail

def video_subtitles(url, langs=None, lang="", timestamps=True, max_chars=400000):
    """貼影音連結 → 抓字幕（不下載影片）→ 回傳逐字稿文字。沒有字幕回 ok:False, reason:"no_subtitles"。"""
    t0 = time.time()
    y = _ytdlp_get()
    if y is None:
        raise ToolError(501, '尚未安裝 yt-dlp。請在 Termux 執行：pip install -U "yt-dlp[default]"（或到 NOVA 設定 → 工具 → Termux 橋接按「安裝文件／影片工具」）。')
    url = (url or "").strip()
    from urllib.parse import urlparse
    pu = urlparse(url)
    host = (pu.hostname or "").lower()
    if pu.scheme not in ("http", "https") or not host:
        raise ToolError(400, "請貼完整的影片網址（http:// 或 https:// 開頭）")
    if host == "localhost" or host.endswith(".local") or re.fullmatch(r"(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)[\d.]*", host) or host in ("0.0.0.0", "::1"):
        raise ToolError(400, "不支援本機或內網網址")
    langs = [str(x) for x in (langs or []) if str(x).strip()] or list(_YTDLP_DEFAULT_LANGS)
    langs = [str(x) for x in (langs or []) if str(x).strip()] or list(_YTDLP_DEFAULT_LANGS)
    opts = {"skip_download": True, "quiet": True, "no_warnings": True, "noplaylist": True, "noprogress": True,
            "socket_timeout": 20, "retries": 2, "extractor_retries": 1, "color": "never"}
    try:
        with y.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
            if not isinstance(info, dict):
                raise ToolError(422, "讀不到這個網址的影片資訊")
            if info.get("_type") == "playlist" and info.get("entries"):
                entries = [e for e in info["entries"] if e]
                if not entries:
                    raise ToolError(422, "這個播放清單是空的")
                info = ydl.extract_info(entries[0].get("webpage_url") or entries[0].get("url") or url, download=False)
            if info.get("is_live"):
                return {"ok": False, "reason": "live", "title": info.get("title", ""), "detail": "這是直播，直播結束後才抓得到字幕。"}
            meta = {"title": info.get("title") or "", "uploader": info.get("uploader") or info.get("channel") or "",
                    "duration": info.get("duration") or 0, "webpage_url": info.get("webpage_url") or url,
                    "upload_date": info.get("upload_date") or ""}
            pick = _pick_subtitle_track(info, langs, (lang or "").strip())
            avail_manual = sorted(k for k, v in (info.get("subtitles") or {}).items() if v and k != "live_chat")
            avail_auto = sorted(k for k, v in (info.get("automatic_captions") or {}).items() if v and k.endswith("-orig"))
            if not pick:
                return dict(meta, ok=False, reason="no_subtitles", available_manual=avail_manual, available_auto=avail_auto,
                            detail="這部影片沒有可用的字幕（人工字幕與自動字幕都沒有），所以抓不到內容。")
            source, lang_key, fmts = pick
            fmt = None
            for pe in _YTDLP_PREF_EXTS:
                fmt = next((f for f in fmts if (f.get("ext") or "").lower() == pe and f.get("url")), None)
                if fmt:
                    break
            if not fmt:
                return dict(meta, ok=False, reason="no_subtitles", available_manual=avail_manual, available_auto=avail_auto,
                            detail="找到字幕軌，但格式不支援。")
            raw = ydl.urlopen(fmt["url"]).read().decode("utf-8", errors="replace")
    except ToolError:
        raise
    except Exception as e:
        raise ToolError(422, _ytdlp_clean_error(e))
    try:
        cues = _parse_subtitle(raw, fmt.get("ext"))
    except Exception as e:
        raise ToolError(422, "字幕解析失敗（%s）：%s" % (type(e).__name__, str(e)[:200]))
    if not cues:
        return dict(meta, ok=False, reason="no_subtitles", available_manual=avail_manual, available_auto=avail_auto, detail="字幕檔是空的。")
    text = _cues_to_text(cues, bool(timestamps))
    limit = max(1000, min(int(max_chars or 400000), 2000000))
    truncated = len(text) > limit
    if truncated:
        text = text[:limit]
    return dict(meta, ok=True, transcript=text, lang=lang_key, source=source, ext=fmt.get("ext"),
                available_manual=avail_manual, available_auto=avail_auto, chars=len(text), truncated=truncated,
                elapsed_ms=int((time.time() - t0) * 1000))



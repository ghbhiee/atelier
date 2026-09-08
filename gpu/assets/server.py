#!/usr/bin/env python3
"""Atelier asset service on the GPU box: the browser uploads and previews straight here.

Why: the 13 → GPU leg of the tunnel is per-flow shaped to ~30-75 KB/s, while the browser (in the same
country as the box) reaches it at line rate. So assets go browser → GPU, and 13 pulls its backup copy
afterwards in the fast direction (GPU → 13, ~1 MB/s).

Runs on the system python (no venv, stdlib only). TLS on 8443: ports 80/443 are intercepted by the
IDC's ICP filter whenever the request carries a hostname, 8000-10000 is open and unfiltered.

Auth: short-lived HMAC tokens minted by 13 (shared secret in /root/runners/assets.env), no call back
to 13 at request time. Token = "<assetId>.<op>.<expEpoch>.<base64url sig>", op in {put,get,admin}.

  GET  /health                 no auth: liveness for the browser probe and for 13
  GET  /trust                  no auth: the page the user opens once to accept the self-signed cert
  PUT  /a/<id>?name=x.mp4      op=put  store bytes, hard-link into ComfyUI's input as h3s_<id><ext>
  PUT  /a/<id>?part=N&of=M     op=put  one slice of a parallel upload (13 → GPU is per-flow shaped)
  POST /a/<id>/assemble?of=M   op=put  join the slices in order, then treat it as a normal upload
  GET  /a/<id>[?t=…]           op=get  serve with Range (video seeking in the browser)
  GET  /a/<id>/thumb           op=get  poster / waveform jpeg
  GET  /a/<id>/meta            op=get  the stored metadata record
  HEAD /a/<id>                 op=get
  DELETE /a/<id>               op=put
  GET  /list                   op=admin  ids + sizes, so 13 can reconcile what it has backed up
  GET  /out/<name>             op=get  serve a file straight from ComfyUI's output dir
"""
import base64, hashlib, hmac, json, mimetypes, os, re, shutil, ssl, subprocess, sys, time, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "1"
PORT = int(os.environ.get("ASSETS_PORT") or 8443)
SECRET = (os.environ.get("ASSETS_SECRET") or "").encode()
ROOT = os.environ.get("ASSETS_DIR") or "/root/atelier-assets"
COMFY_IN = os.environ.get("COMFY_INPUT") or "/root/ComfyUI/input"
COMFY_OUT = os.environ.get("COMFY_OUTPUT") or "/root/ComfyUI/output"
ORIGIN = os.environ.get("ALLOW_ORIGIN") or "https://atelier.example.com"
PUBLIC_IP = os.environ.get("PUBLIC_IP") or ""
BLOBS, META, TLS = os.path.join(ROOT, "blobs"), os.path.join(ROOT, "meta"), os.path.join(ROOT, "tls")
PARTS = os.path.join(ROOT, "parts")
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
CHUNK = 1 << 20
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
VIDEO_EXT = {".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm", ".flv", ".wmv", ".mpg", ".mpeg"}
AUDIO_EXT = {".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma"}


def ff(args, timeout=1800):
    r = subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *args], capture_output=True, text=True, timeout=timeout)
    if r.returncode: raise RuntimeError((r.stderr or "ffmpeg failed").strip()[:300])


def probe(f):
    r = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", f], capture_output=True, text=True, timeout=120)
    j = json.loads(r.stdout or "{}")
    v = next((s for s in j.get("streams", []) if s.get("codec_type") == "video"), None)
    a = next((s for s in j.get("streams", []) if s.get("codec_type") == "audio"), None)
    fps = None
    if v and v.get("r_frame_rate"):
        n, _, d = v["r_frame_rate"].partition("/")
        if d and float(d): fps = float(n) / float(d)
    dur = float(j.get("format", {}).get("duration") or (v or {}).get("duration") or 0)
    frames = int(v["nb_frames"]) if v and v.get("nb_frames") else (round(fps * dur) if fps and dur else None)
    return {"duration": dur, "width": (v or {}).get("width"), "height": (v or {}).get("height"), "fps": fps,
            "hasAudio": bool(a), "codec": (v or {}).get("codec_name"), "frames": frames}


def exif_orientation(path):
    """EXIF orientation tag (0x0112) straight out of the JPEG. ffmpeg 4.4 on this box does not auto-rotate
    JPEGs (5.x does), so a phone photo would arrive sideways compared to what 13 produces. Read it ourselves."""
    try:
        with open(path, "rb") as f: d = f.read(128 * 1024)
        if d[:2] != b"\xff\xd8": return 1
        i = 2
        while i + 4 < len(d):
            if d[i] != 0xFF: return 1
            marker, size = d[i + 1], int.from_bytes(d[i + 2:i + 4], "big")
            if marker == 0xE1 and d[i + 4:i + 10] == b"Exif\x00\x00":
                t = i + 10
                if d[t:t + 2] not in (b"II", b"MM"): return 1
                be = d[t:t + 2] == b"MM"
                order = "big" if be else "little"
                off = int.from_bytes(d[t + 4:t + 8], order)
                n = int.from_bytes(d[t + off:t + off + 2], order)
                for k in range(n):
                    e = t + off + 2 + k * 12
                    if int.from_bytes(d[e:e + 2], order) == 0x0112:
                        v = int.from_bytes(d[e + 8:e + 10], order)
                        return v if 1 <= v <= 8 else 1
                return 1
            if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7: i += 2
            else: i += 2 + size
    except Exception as e:
        log("exif read failed:", e)
    return 1


# EXIF orientation → the ffmpeg filter that puts the image upright
ROTATE_VF = {1: None, 2: "hflip", 3: "transpose=2,transpose=2", 4: "vflip",
             5: "transpose=0", 6: "transpose=1", 7: "transpose=3", 8: "transpose=2"}


def normalize(raw, aid, ext):
    """Same canonical forms 13 uses, done here so the slow 13 -> GPU leg is never needed:
       image -> <id>.jpg, audio -> <id>.wav 48k stereo, non-mp4 video -> <id>.mp4 h264."""
    if ext in IMAGE_EXT:
        out = os.path.join(BLOBS, aid + ".jpg")
        rot = ROTATE_VF.get(exif_orientation(raw) if ext in (".jpg", ".jpeg") else 1)
        vf = (rot + ",format=yuvj420p") if rot else "format=yuvj420p"
        ff(["-i", raw, "-vf", vf, "-frames:v", "1", "-q:v", "2", out]); os.remove(raw)
        return out, "image"
    if ext in AUDIO_EXT:
        out = os.path.join(BLOBS, aid + ".wav")
        ff(["-i", raw, "-vn", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", out]); os.remove(raw)
        return out, "audio"
    if ext in VIDEO_EXT:
        out = os.path.join(BLOBS, aid + ".mp4")
        if ext == ".mp4": os.replace(raw, out)
        else:
            ff(["-i", raw, "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out]); os.remove(raw)
        return out, "video"
    raise RuntimeError("不支持的格式 " + (ext or "(无扩展名)"))


def thumbnail(f, kind, aid):
    out = os.path.join(BLOBS, aid + "_t.jpg")
    try:
        if kind == "video":
            at = min(0.5, max(0.0, probe(f)["duration"] / 2))
            ff(["-ss", f"{at:.3f}", "-i", f, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", out])
        elif kind == "audio":
            ff(["-i", f, "-filter_complex", "showwavespic=s=480x160:colors=#f59e0b", "-frames:v", "1", out])
        else:
            ff(["-i", f, "-vf", "scale='if(lt(iw,ih),min(iw,360),-2)':'if(lt(iw,ih),-2,min(ih,360))':flags=lanczos,format=yuvj420p",
                "-frames:v", "1", "-q:v", "3", out])
        return os.path.basename(out)
    except Exception as e:
        log("thumb failed:", e); return None


def log(*a): print(f"[assets {time.strftime('%H:%M:%S')}]", *a, flush=True)


def token_ok(tok, asset_id, op):
    if not SECRET or not tok: return False
    parts = tok.split(".")
    if len(parts) != 4: return False
    tid, top, exp, sig = parts
    try:
        if int(exp) < time.time(): return False
    except ValueError:
        return False
    if top != op and not (top == "admin" and op in ("get", "put")): return False
    if tid != "*" and tid != asset_id: return False
    want = base64.urlsafe_b64encode(hmac.new(SECRET, f"{tid}.{top}.{exp}".encode(), hashlib.sha256).digest()).decode().rstrip("=")
    return hmac.compare_digest(want, sig)


def meta_path(aid): return os.path.join(META, aid + ".json")


def read_meta(aid):
    try:
        with open(meta_path(aid)) as f: return json.load(f)
    except Exception: return None


def blob_path(aid):
    m = read_meta(aid)
    return os.path.join(BLOBS, m["file"]) if m else None


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "atelier-assets/" + VERSION

    def log_message(self, *a): pass

    # ---- helpers ---------------------------------------------------------------------------
    def cors(self):
        self.send_header("Access-Control-Allow-Origin", ORIGIN)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Credentials", "false")

    def reply(self, code, body=b"", ctype="application/json; charset=utf-8", extra=()):
        if isinstance(body, str): body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.cors()
        for k, v in extra: self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD": self.wfile.write(body)

    def fail(self, code, msg):
        self.reply(code, json.dumps({"error": msg}, ensure_ascii=False))

    def parts(self):
        u = urllib.parse.urlparse(self.path)
        return u.path.rstrip("/"), urllib.parse.parse_qs(u.query)

    def auth(self, aid, op, q):
        tok = (q.get("t") or [None])[0]
        head = self.headers.get("Authorization") or ""
        if head.lower().startswith("bearer "): tok = head[7:].strip()
        return token_ok(tok, aid, op)

    # ---- verbs -----------------------------------------------------------------------------
    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header("Access-Control-Allow-Methods", "GET,PUT,HEAD,DELETE,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "authorization,content-type,x-asset-name")
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self, head=False):
        path, q = self.parts()
        if path in ("/health", ""):
            n = len(os.listdir(META)) if os.path.isdir(META) else 0
            free = shutil.disk_usage(ROOT).free // (1 << 30)
            return self.reply(200, json.dumps({"ok": True, "version": VERSION, "assets": n, "freeGb": free, "ip": PUBLIC_IP}))
        if path == "/trust":
            return self.reply(200, "<!doctype html><meta charset=utf-8><title>Atelier GPU</title>"
                                   "<body style='font:16px/1.6 system-ui;padding:40px;max-width:34em'>"
                                   "<h2>已信任这台 GPU 机器</h2><p>浏览器现在可以直接把素材传到 GPU、也能直接播放结果。"
                                   "关掉这个标签页回到工作台即可。</p>", "text/html; charset=utf-8")
        if path == "/list":
            if not self.auth("*", "admin", q): return self.fail(403, "token 无效")
            out = []
            for f in sorted(os.listdir(META)) if os.path.isdir(META) else []:
                if f.endswith(".json"):
                    m = read_meta(f[:-5])
                    if m: out.append(m)
            return self.reply(200, json.dumps({"assets": out}, ensure_ascii=False))
        if path.startswith("/out/"):
            name = os.path.basename(urllib.parse.unquote(path[5:]))
            if not self.auth("*", "get", q): return self.fail(403, "token 无效")
            f = os.path.join(COMFY_OUT, name)
            return self.send_file(f, name, head)
        if path.startswith("/a/"):
            rest = urllib.parse.unquote(path[3:])
            want_meta = rest.endswith("/meta")
            aid, want_thumb = (rest[:-6], True) if rest.endswith("/thumb") else ((rest[:-5], False) if want_meta else (rest, False))
            if not ID_RE.match(aid): return self.fail(400, "id 不合法")
            if not self.auth(aid, "get", q): return self.fail(403, "token 无效")
            m = read_meta(aid)
            if not m: return self.fail(404, "素材不在 GPU 上")
            if want_meta: return self.reply(200, json.dumps(m, ensure_ascii=False))
            if want_thumb:
                if not m.get("thumb"): return self.fail(404, "没有缩略图")
                return self.send_file(os.path.join(BLOBS, m["thumb"]), aid + "_t.jpg", head)
            return self.send_file(os.path.join(BLOBS, m["file"]), m["name"], head)
        return self.fail(404, "no such path")

    def do_HEAD(self): self.do_GET(head=True)

    def send_file(self, f, name, head=False):
        if not os.path.isfile(f): return self.fail(404, "文件不存在")
        size = os.path.getsize(f)
        ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        if rng and rng.startswith("bytes="):
            a, _, b = rng[6:].partition("-")
            try:
                if a: start = int(a); end = int(b) if b else size - 1
                else: start = max(0, size - int(b)); end = size - 1
            except ValueError: start, end = 0, size - 1
            if start >= size: 
                return self.reply(416, b"", ctype, [("Content-Range", f"bytes */{size}")])
            end = min(end, size - 1)
        partial = bool(rng) and (start, end) != (0, size - 1)
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        if partial: self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Cache-Control", "private, max-age=3600")
        self.cors()
        self.send_header("Access-Control-Expose-Headers", "content-length,content-range,accept-ranges")
        self.end_headers()
        if head: return
        left = end - start + 1
        with open(f, "rb") as fh:
            fh.seek(start)
            while left > 0:
                b = fh.read(min(CHUNK, left))
                if not b: break
                self.wfile.write(b); left -= len(b)

    def do_PUT(self):
        path, q = self.parts()
        if not path.startswith("/a/"): return self.fail(404, "no such path")
        aid = urllib.parse.unquote(path[3:])
        if not ID_RE.match(aid): return self.fail(400, "id 不合法")
        if not self.auth(aid, "put", q): return self.fail(403, "token 无效")
        name = (q.get("name") or [self.headers.get("X-Asset-Name") or aid])[0]
        name = os.path.basename(urllib.parse.unquote(name))[:120] or aid
        size = int(self.headers.get("Content-Length") or 0)
        if size <= 0: return self.fail(411, "缺少 Content-Length")
        # A slice of a parallel upload: 13 → GPU is shaped per TCP flow, so the only way to use the line is
        # to open several. Slices land as .partN and are joined by /assemble once they are all here.
        part = (q.get("part") or [None])[0]
        if part is not None:
            os.makedirs(PARTS, exist_ok=True)
            tmp = os.path.join(PARTS, f"{aid}.part{int(part)}")
            got = 0
            with open(tmp + ".tmp", "wb") as out:
                while got < size:
                    b = self.rfile.read(min(CHUNK, size - got))
                    if not b: break
                    out.write(b); got += len(b)
            if got != size:
                os.remove(tmp + ".tmp"); return self.fail(400, "分片只收到 %d/%d 字节" % (got, size))
            os.replace(tmp + ".tmp", tmp)
            return self.reply(200, json.dumps({"ok": True, "part": int(part), "bytes": got}))
        ext = os.path.splitext(name)[1].lower()[:8]
        os.makedirs(BLOBS, exist_ok=True); os.makedirs(META, exist_ok=True)
        raw, t0 = os.path.join(BLOBS, aid + ext + ".part"), time.time()
        h, got = hashlib.sha256(), 0
        with open(raw, "wb") as out:
            while got < size:
                b = self.rfile.read(min(CHUNK, size - got))
                if not b: break
                out.write(b); h.update(b); got += len(b)
        if got != size:
            os.remove(raw); return self.fail(400, "只收到 %d/%d 字节" % (got, size))
        return self.finish_upload(aid, name, ext, raw, size, h, t0)

    def link_into_comfy(self, src, dest_name):
        try:
            os.makedirs(COMFY_IN, exist_ok=True)
            dest = os.path.join(COMFY_IN, dest_name)
            if os.path.exists(dest): os.remove(dest)
            try: os.link(src, dest)
            except OSError: shutil.copy2(src, dest)
            return dest_name
        except Exception as e:
            log("comfy link failed:", e); return None

    def do_POST(self):
        path, q = self.parts()
        m = re.match(r"^/a/([^/]+)/fetch$", path)
        if m: return self.do_fetch(m.group(1), q)
        m = re.match(r"^/a/([^/]+)/assemble$", path)
        if not m: return self.fail(404, "no such path")
        aid = urllib.parse.unquote(m.group(1))
        if not ID_RE.match(aid): return self.fail(400, "id 不合法")
        if not self.auth(aid, "put", q): return self.fail(403, "token 无效")
        of = int((q.get("of") or ["0"])[0] or 0)
        name = os.path.basename(urllib.parse.unquote((q.get("name") or [aid])[0]))[:120] or aid
        if of <= 0: return self.fail(400, "缺少 of")
        files = [os.path.join(PARTS, f"{aid}.part{i}") for i in range(of)]
        missing = [i for i, f in enumerate(files) if not os.path.isfile(f)]
        if missing: return self.fail(400, "缺少分片 " + ",".join(map(str, missing)))
        ext = os.path.splitext(name)[1].lower()[:8]
        os.makedirs(BLOBS, exist_ok=True); os.makedirs(META, exist_ok=True)
        raw, t0 = os.path.join(BLOBS, aid + ext + ".part"), time.time()
        h, total = hashlib.sha256(), 0
        with open(raw, "wb") as out:
            for f in files:
                with open(f, "rb") as fh:
                    while True:
                        b = fh.read(CHUNK)
                        if not b: break
                        out.write(b); h.update(b); total += len(b)
        for f in files:
            try: os.remove(f)
            except Exception: pass
        return self.finish_upload(aid, name, ext, raw, total, h, t0, parallel=of)

    def do_fetch(self, aid, q):
        """Pull the bytes ourselves through the fleet tunnel instead of having 13 push them.

        13 -> here over plain TCP is about 24 KB/s per flow whichever side opens the connection; the
        same path over the Hysteria2 tunnel measured 6 MB/s, because QUIC with a loss-agnostic
        congestion control ignores the loss that collapses cubic. The URL always points at 13's own
        loopback (that is all the tunnel's ACL allows), so nothing here can be aimed elsewhere.
        """
        aid = urllib.parse.unquote(aid)
        if not ID_RE.match(aid): return self.fail(400, "id 不合法")
        if not self.auth(aid, "put", q): return self.fail(403, "token 无效")
        url = (q.get("url") or [""])[0]
        name = os.path.basename(urllib.parse.unquote((q.get("name") or [aid])[0]))[:120] or aid
        u = urllib.parse.urlparse(url)
        if u.scheme != "http" or u.hostname not in ("127.0.0.1", "localhost"):
            return self.fail(400, "只接受经隧道到 13 本机的 http URL")
        proxy = os.environ.get("FLEET_PROXY", "127.0.0.1:11080")
        ext = os.path.splitext(name)[1].lower()[:8]
        os.makedirs(BLOBS, exist_ok=True); os.makedirs(META, exist_ok=True)
        raw, t0 = os.path.join(BLOBS, aid + ext + ".part"), time.time()
        cmd = ["curl", "-sS", "--fail", "--max-time", "3600", "--socks5-hostname", proxy, "-o", raw, url]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0 or not os.path.isfile(raw):
            try: os.remove(raw)
            except Exception: pass
            return self.fail(502, "经隧道拉取失败（代理 %s）：%s" % (proxy, (r.stderr or "")[-200:]))
        h, size = hashlib.sha256(), 0
        with open(raw, "rb") as fh:
            while True:
                b = fh.read(CHUNK)
                if not b: break
                h.update(b); size += len(b)
        return self.finish_upload(aid, name, ext, raw, size, h, t0, parallel=-1)

    def finish_upload(self, aid, name, ext, raw, size, h, t0, parallel=0):
        try:
            f, kind = normalize(raw, aid, ext)
        except Exception as e:
            try: os.remove(raw)
            except Exception: pass
            return self.fail(400, str(e))
        info = probe(f)
        thumb = thumbnail(f, kind, aid)
        fname = os.path.basename(f)
        comfy = self.link_into_comfy(f, "h3s_" + fname)
        m = {"id": aid, "name": name, "file": fname, "kind": kind, "size": os.path.getsize(f), "uploaded": size,
             "sha256": h.hexdigest(), "at": int(time.time()), "comfyName": comfy, "thumb": thumb,
             "width": info["width"], "height": info["height"], "duration": round(info["duration"], 3),
             "fps": info["fps"], "frames": info["frames"], "hasAudio": info["hasAudio"], "parallel": parallel}
        with open(meta_path(aid), "w") as f2: json.dump(m, f2, ensure_ascii=False)
        up = max(0.001, time.time() - t0)
        log("%s %s %s %.1f MB in %.1fs = %.1f MB/s → %s" % ("TUNNEL" if parallel < 0 else "ASSEMBLE" if parallel else "PUT", aid, name, size / 1048576, up, size / up / 1048576, fname))
        return self.reply(200, json.dumps(m, ensure_ascii=False))

    def do_DELETE(self):
        path, q = self.parts()
        if not path.startswith("/a/"): return self.fail(404, "no such path")
        aid = urllib.parse.unquote(path[3:])
        if not ID_RE.match(aid): return self.fail(400, "id 不合法")
        if not self.auth(aid, "put", q): return self.fail(403, "token 无效")
        m = read_meta(aid)
        if m:
            for p in (os.path.join(BLOBS, m["file"]), os.path.join(BLOBS, m.get("thumb") or ""), meta_path(aid), os.path.join(COMFY_IN, m.get("comfyName") or "")):
                try:
                    if p and os.path.isfile(p): os.remove(p)
                except Exception: pass
        return self.reply(200, json.dumps({"ok": True, "id": aid}))


def ensure_cert():
    """A real Let's Encrypt cert for the box's hostname is issued on 13 (DNS-01 through the registrar's API,
    because the IDC blocks ACME on 80/443 for any hostname) and pushed into tls/. Only when none is there do
    we fall back to a self-signed one, which the browser has to be told to trust once."""
    os.makedirs(TLS, exist_ok=True)
    crt, key = os.path.join(TLS, "cert.pem"), os.path.join(TLS, "key.pem")
    if os.path.isfile(crt) and os.path.isfile(key):
        if not _self_signed(crt): return crt, key          # a real cert: never touch it
        # our own throwaway cert: regenerate when the box came back with a different EIP (SAN no longer matches)
        if not PUBLIC_IP or _san_has(crt, PUBLIC_IP): return crt, key
    san = ["DNS:localhost", "IP:127.0.0.1"]
    if PUBLIC_IP:
        san += [f"IP:{PUBLIC_IP}", "DNS:" + PUBLIC_IP.replace(".", "-") + ".sslip.io", "DNS:" + PUBLIC_IP.replace(".", "-") + ".nip.io"]
    cn = PUBLIC_IP or "atelier-gpu"
    os.system(f'openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes -keyout {key} -out {crt} '
              f'-subj "/CN={cn}" -addext "subjectAltName={",".join(san)}" >/dev/null 2>&1')
    log("self-signed cert for", cn, san)
    return crt, key


def _self_signed(crt):
    try:
        import subprocess
        out = subprocess.run(["openssl", "x509", "-in", crt, "-noout", "-subject", "-issuer"], capture_output=True, text=True).stdout
        subj = next((l.split("=", 1)[1] for l in out.splitlines() if l.startswith("subject=")), "s")
        iss = next((l.split("=", 1)[1] for l in out.splitlines() if l.startswith("issuer=")), "i")
        return subj.strip() == iss.strip()
    except Exception: return True


def _san_has(crt, ip):
    try:
        import subprocess
        out = subprocess.run(["openssl", "x509", "-in", crt, "-noout", "-text"], capture_output=True, text=True).stdout
        return f"IP Address:{ip}" in out
    except Exception: return False


def main():
    if not SECRET: sys.exit("ASSETS_SECRET missing (write /root/runners/assets.env)")
    for d in (BLOBS, META, TLS, PARTS): os.makedirs(d, exist_ok=True)
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), H)
    srv.daemon_threads = True
    tls = os.environ.get("ASSETS_TLS", "1") != "0"      # tests run it in the clear on localhost
    if tls:
        crt, key = ensure_cert()
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(crt, key)
        srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    log(f"listening on :{PORT} {'tls' if tls else 'plain'}, root={ROOT}, comfy_in={COMFY_IN}, origin={ORIGIN}, ip={PUBLIC_IP or '?'}")
    srv.serve_forever()


if __name__ == "__main__":
    main()

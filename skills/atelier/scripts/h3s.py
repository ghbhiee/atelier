#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Atelier API client (stdlib only). Config: ~/.config/atelier/config.json {"base": "...", "key": "h3s_..."}."""
import argparse, json, mimetypes, os, sys, time, urllib.request, urllib.parse, urllib.error

CFG = next((p for p in (os.path.expanduser("~/.config/atelier/config.json"), os.path.expanduser("~/.config/h3studio/config.json")) if os.path.exists(p)), os.path.expanduser("~/.config/atelier/config.json"))


def cfg():
    try:
        c = json.load(open(CFG))
    except FileNotFoundError:
        sys.exit(f"缺配置 {CFG}：{{\"base\": \"https://atelier.example.com/studio\", \"key\": \"h3s_…\"}}（网页 设置 → API Keys 创建）")
    return c["base"].rstrip("/"), c["key"]


def api(path, method="GET", body=None, raw=None, timeout=120, stream_to=None):
    base, key = cfg()
    headers = {"Authorization": "Bearer " + key}
    data = None
    if body is not None:
        data = json.dumps(body).encode(); headers["Content-Type"] = "application/json"
    elif raw is not None:
        data, ct = raw if isinstance(raw, tuple) else (raw, "application/octet-stream"); headers["Content-Type"] = ct
    req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            if stream_to:
                with open(stream_to, "wb") as f:
                    while True:
                        chunk = r.read(1 << 20)
                        if not chunk: break
                        f.write(chunk)
                return stream_to
            out = r.read()
            return json.loads(out) if out else {}
    except urllib.error.HTTPError as e:
        try: msg = json.loads(e.read()).get("error")
        except Exception: msg = e.reason
        sys.exit(f"HTTP {e.code}: {msg}")


def upload(path, project):
    p = os.path.expanduser(path)
    if not os.path.exists(p): sys.exit(f"文件不存在：{p}")
    with open(p, "rb") as f: data = f.read()
    a = api(f"/api/projects/{project}/assets?name={urllib.parse.quote(os.path.basename(p))}", "PUT", raw=data, timeout=1800)
    print(f"上传 {os.path.basename(p)} → {a['id']} ({a['kind']} {a.get('width')}x{a.get('height')}{' ' + str(a.get('duration')) + 's' if a.get('duration') else ''})", file=sys.stderr)
    return a["id"]


def resolve(items, project):
    return [x if x.startswith("a_") else upload(x, project) for x in (items or [])]


def fmt_job(j):
    line = f"{j['id']}  {j['status']:10} {j.get('title','')[:40]:40} {j['width']}x{j['height']} {j['length']}f seed={j['seed']}"
    if j.get("progress") and j["status"] == "running": line += f"  {j['progress']['value']}/{j['progress']['max']}"
    if j.get("output"): line += f"  {j['output']['duration']}s"
    if j.get("warning"): line += "  ⚠ " + j["warning"]
    if j.get("error"): line += "  ✗ " + j["error"][:80]
    return line


def cmd_status(a):
    g = api("/api/gpu")
    print(f"GPU {g['state']}  队列 {g['queue']['running']} 跑 / {g['queue']['pending']} 等  今日 ¥{g['cost']['todayCny']}  本次 ¥{g['cost']['currentCny']}  累计 ¥{g['cost']['totalCny']}" + (f"  设备 {g['device']['name']}" if g.get("device") else ""))


def cmd_upload(a):
    for f in a.files: print(upload(f, a.project))


def cmd_gen(a):
    prompt = open(os.path.expanduser(a.prompt[1:])).read() if a.prompt.startswith("@") else a.prompt
    spec = {"projectId": a.project, "title": a.title or "", "workflow": a.workflow, "prompt": prompt, "width": a.width, "height": a.height, "seconds": a.seconds, "refSize": a.ref_size,
            "images": resolve(a.image, a.project), "videos": resolve(a.video, a.project), "audios": resolve(a.audio, a.project), "videoAudio": bool(a.video_audio)}
    if a.last_frame: spec["lastFrame"] = resolve([a.last_frame], a.project)[0]
    if a.steps: spec["steps"] = a.steps
    if a.seed is not None: spec["seed"] = a.seed
    j = api("/api/jobs", "POST", spec)
    print(fmt_job(j))
    if a.wait: wait_job(j["id"], a.out, a.share)


def wait_job(jid, out=None, share=False):
    last = ""
    while True:
        j = api(f"/api/jobs/{jid}")
        line = fmt_job(j)
        if line != last: print(line, file=sys.stderr); last = line
        if j["status"] in ("done", "error", "cancelled"): break
        time.sleep(6)
    if j["status"] != "done": sys.exit(1)
    dest = os.path.expanduser(out or f"~/Downloads/h3/{jid}.mp4")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    api(f"/api/jobs/{jid}/file", stream_to=dest, timeout=1800)
    print(dest)
    if share: print(api(f"/api/jobs/{jid}/share", "POST", {})["url"])
    return j


def cmd_jobs(a):
    for j in api(f"/api/jobs?limit={a.limit}" + (f"&projectId={a.project}" if a.project else "")): print(fmt_job(j))


def cmd_get(a):
    j = api(f"/api/jobs/{a.id}"); print(json.dumps({k: v for k, v in j.items() if k != "prompt"}, ensure_ascii=False, indent=1)); print("prompt:\n" + j["prompt"])


def cmd_wait(a): wait_job(a.id, a.out, a.share)
def cmd_download(a): print(api(f"/api/jobs/{a.id}/file", stream_to=os.path.expanduser(a.out or f"~/Downloads/h3/{a.id}.mp4"), timeout=1800))
def cmd_share(a): print(api(f"/api/jobs/{a.id}/share", "POST", {"permanent": bool(a.permanent)})["url"])
def cmd_cancel(a): print(fmt_job(api(f"/api/jobs/{a.id}/cancel", "POST")))


def cmd_search(a):
    r = api(f"/api/prompts/search?q={urllib.parse.quote(a.query)}&k={a.k}" + ("&h3=1" if a.h3 else ""))
    for it in r.get("mine", []): print(f"★ {it['id']}  {it['name']}  [{' '.join(it.get('tags', [])[:6])}]")
    for it in r["results"]:
        print(f"{it.get('score', 0) * 100:3.0f}%  {it['id']}  {it['model'] or ''} {it['duration'] or ''}  {it['title_zh']}  [{' '.join(it['tags'][:6])}]  {it.get('source_post_url') or ''}")


def cmd_prompt(a):
    it = api(f"/api/prompts/item/{urllib.parse.quote(a.id)}")
    print(f"# {it['title_zh']}  ({it['model']} {it['duration'] or ''})\n# 溯源 {it.get('source_post_url') or '-'}  视频 {it.get('video_url') or '-'}\n")
    print(it["prompt"])


def cmd_draft(a):
    r = api("/api/llm/prompt", "POST", {"mode": a.mode, "idea": a.idea, "seconds": a.seconds, "dialogueLang": a.lang, "refs": [], "deep": bool(a.deep)}, timeout=320)
    print(r["prompt"])


def cmd_whitemodel(a):
    """Real footage → white-model (clay) render on the GPU. Not an H3 generation; runs in the same queue."""
    vid = resolve([a.video], a.project)[0]
    wm = {"preset": a.preset, "keepAudio": not a.no_audio}
    if a.relief: wm["relief"] = a.relief
    if a.photo: wm["photo"] = a.photo
    if a.ao: wm["ao"] = a.ao
    j = api("/api/jobs", "POST", {"projectId": a.project, "workflow": "whitemodel", "videos": [vid], "title": a.title or "", "whitemodel": wm})
    print(fmt_job(j))
    if a.wait: wait_job(j["id"], a.out, a.share)


def cmd_models(a):
    """Model manager: what is loaded, VRAM, catalogue; --task / --load / --unload change it."""
    if a.task: print(json.dumps(api("/api/models/task", "POST", {"task": a.task, "modelId": a.model}), ensure_ascii=False)); return
    if a.load: print(json.dumps(api(f"/api/models/{a.load}/load", "POST", {}), ensure_ascii=False)); return
    if a.unload: r = api("/api/models/unload", "POST", {"modality": a.unload}); print("unloaded", a.unload, "vram", r.get("gpu", {}).get("vram")); return
    s = api("/api/models")
    g = s.get("gpu") or {}
    print(f"gpuctl {'ok' if s.get('available') else 'n/a'}  vram {g.get('vram', {}).get('used', '?')}/{g.get('vram', {}).get('total', '?')} MiB  busy {s.get('busy', {}).get('action') if s.get('busy') else '-'}  err {s.get('lastError') or '-'}")
    for mod, l in (s.get("loaded") or {}).items(): print(f"  loaded {mod}: {l.get('modelId') or '(runner up)'}" + ("  [H3 weights in VRAM]" if mod == "video" and s.get("comfyModelsLoaded") else ""))
    print("tasks:", " ".join(s.get("tasks", {}).keys()))
    for m in s.get("models", []):
        print(f"  {m['id']:26} {m['modality']:10} {m.get('quant') or '':10} {str(m.get('fileGb') or '-'):>6} GB  vram {m.get('vram') or ('≈' + str(m.get('vramEstimate')))} MiB  {'tested' if m.get('tested') else 'untested'}")


def cmd_voices(a):
    """List TTS engines and voices (saved / sample / built-in)."""
    eng = api("/voice/engines", timeout=900)
    for e in eng: print(f"{'*' if e.get('default') else ' '} {e['id']:12} {e['name']:22} {'已加载' if e.get('loaded') else '     '} {'可克隆' if e.get('clone') else '内置音色'}  {'' if e.get('installed') else '（未安装）'}  控制: {', '.join(c['key'] for c in e.get('controls', []))}")
    v = api("/voice/voices", timeout=900)
    print("我的音色:"); [print(f"  {x['id']:12} {x['name']}  {x.get('seconds') or ''}s  “{(x.get('refText') or '')[:30]}”") for x in v.get("saved", [])]
    print("示例声:", " ".join(x["id"] for x in v.get("samples", [])))
    for eid, lst in (v.get("builtin") or {}).items():
        if lst: print(f"{eid} 内置:", " ".join(x["id"] for x in lst))


def cmd_tts(a):
    """Text → audio file. --voice = saved voice id / sample:voice_05 / built-in id; --model = engine."""
    text = open(os.path.expanduser(a.text[1:])).read() if a.text.startswith("@") else a.text
    params = {k: v for k, v in dict(emotion=a.emotion, emo_alpha=a.emo_alpha, instruct=a.instruct, speed=a.speed, language=a.language, design=a.design).items() if v not in (None, "")}
    out = os.path.expanduser(a.out or f"~/Downloads/atelier/tts_{int(time.time())}.{a.format}")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    if a.ref:
        import mimetypes, uuid
        boundary = "----atl" + uuid.uuid4().hex
        fields = {"text": text, "format": a.format, "model": a.model or "", "voice": a.voice or "", **{k: str(v) for k, v in params.items()}}
        body = b""
        for k, v in fields.items():
            if v == "": continue
            body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()
        fn = os.path.basename(a.ref); data = open(os.path.expanduser(a.ref), "rb").read()
        body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"ref\"; filename=\"{fn}\"\r\nContent-Type: {mimetypes.guess_type(fn)[0] or 'application/octet-stream'}\r\n\r\n".encode() + data + f"\r\n--{boundary}--\r\n".encode()
        api("/voice/tts", "POST", raw=(body, f"multipart/form-data; boundary={boundary}"), stream_to=out, timeout=900)
    else:
        api("/voice/tts", "POST", {"text": text, "model": a.model, "voice": a.voice, "format": a.format, "params": params}, stream_to=out, timeout=900)
    print(out)


def cmd_voice_save(a):
    """Save a reference clip as a named voice (transcribed automatically); usable by every clone-capable engine."""
    import mimetypes, uuid
    boundary = "----atl" + uuid.uuid4().hex
    fn = os.path.basename(a.file); data = open(os.path.expanduser(a.file), "rb").read()
    body = f"--{boundary}\r\nContent-Disposition: form-data; name=\"name\"\r\n\r\n{a.name}\r\n".encode()
    if a.note: body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"note\"\r\n\r\n{a.note}\r\n".encode()
    body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"ref\"; filename=\"{fn}\"\r\nContent-Type: {mimetypes.guess_type(fn)[0] or 'application/octet-stream'}\r\n\r\n".encode() + data + f"\r\n--{boundary}--\r\n".encode()
    v = api("/voice/voices", "POST", raw=(body, f"multipart/form-data; boundary={boundary}"), timeout=900)
    print(json.dumps(v, ensure_ascii=False))


def cmd_chat(a):
    """One question to the GPU LLM through the OpenAI-compatible endpoint (auto-starts the GPU, first call may take minutes)."""
    body = {"model": a.model or "qwen3.8-27b-q4", "messages": ([{"role": "system", "content": a.system}] if a.system else []) + [{"role": "user", "content": a.prompt + ("" if a.think else " /no_think")}], "max_tokens": a.max_tokens, "temperature": a.temperature}
    r = api("/llm/v1/chat/completions", "POST", body, timeout=900)
    print(r["choices"][0]["message"]["content"])
    t = r.get("timings") or {}
    if t: print(f"[{r.get('usage', {}).get('completion_tokens', '?')} tok · {t.get('predicted_per_second', 0):.0f} tok/s]", file=sys.stderr)


def main():
    p = argparse.ArgumentParser(prog="atl.py", description="Atelier API client")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status").set_defaults(f=cmd_status)
    c = sub.add_parser("upload"); c.add_argument("files", nargs="+"); c.add_argument("--project", default="default"); c.set_defaults(f=cmd_upload)
    c = sub.add_parser("gen"); c.add_argument("prompt"); c.add_argument("-w", "--workflow", default="native_t2v"); c.add_argument("-i", "--image", action="append"); c.add_argument("--last-frame", dest="last_frame"); c.add_argument("-v", "--video", action="append"); c.add_argument("--video-audio", dest="video_audio", action="store_true"); c.add_argument("--audio", action="append")
    c.add_argument("--width", type=int, default=832); c.add_argument("--height", type=int, default=448); c.add_argument("--seconds", type=float, default=5); c.add_argument("--steps", type=int); c.add_argument("--seed", type=int); c.add_argument("--ref-size", dest="ref_size", default="max"); c.add_argument("--project", default="default"); c.add_argument("--title"); c.add_argument("--wait", action="store_true"); c.add_argument("-o", "--out"); c.add_argument("--share", action="store_true"); c.set_defaults(f=cmd_gen)
    c = sub.add_parser("jobs"); c.add_argument("--limit", type=int, default=20); c.add_argument("--project"); c.set_defaults(f=cmd_jobs)
    c = sub.add_parser("get"); c.add_argument("id"); c.set_defaults(f=cmd_get)
    c = sub.add_parser("wait"); c.add_argument("id"); c.add_argument("-o", "--out"); c.add_argument("--share", action="store_true"); c.set_defaults(f=cmd_wait)
    c = sub.add_parser("download"); c.add_argument("id"); c.add_argument("-o", "--out"); c.set_defaults(f=cmd_download)
    c = sub.add_parser("share"); c.add_argument("id"); c.add_argument("--permanent", action="store_true"); c.set_defaults(f=cmd_share)
    c = sub.add_parser("cancel"); c.add_argument("id"); c.set_defaults(f=cmd_cancel)
    c = sub.add_parser("search"); c.add_argument("query"); c.add_argument("-k", type=int, default=10); c.add_argument("--h3", action="store_true"); c.set_defaults(f=cmd_search)
    c = sub.add_parser("prompt"); c.add_argument("id"); c.set_defaults(f=cmd_prompt)
    c = sub.add_parser("draft"); c.add_argument("idea"); c.add_argument("--mode", default="ref"); c.add_argument("--seconds", type=float, default=5); c.add_argument("--lang", default="Chinese"); c.add_argument("--deep", action="store_true"); c.set_defaults(f=cmd_draft)
    c = sub.add_parser("whitemodel", help="实拍视频 → 白模（石膏/粘土）渲染"); c.add_argument("video"); c.add_argument("--preset", default="clay", choices=["clay", "sculpt", "soft", "toon"]); c.add_argument("--relief", type=float); c.add_argument("--photo", type=float); c.add_argument("--ao", type=float); c.add_argument("--no-audio", action="store_true"); c.add_argument("--project", default="default"); c.add_argument("--title"); c.add_argument("--wait", action="store_true"); c.add_argument("-o", "--out"); c.add_argument("--share", action="store_true"); c.set_defaults(f=cmd_whitemodel)
    c = sub.add_parser("models", help="模型管家：已加载 / 显存 / 目录；--task chat|video|tts|asr… --load ID --unload llm|voice|all"); c.add_argument("--task"); c.add_argument("--model"); c.add_argument("--load"); c.add_argument("--unload"); c.set_defaults(f=cmd_models)
    c = sub.add_parser("voices", help="语音引擎与音色列表（我的音色 / 示例声 / 内置）"); c.set_defaults(f=cmd_voices)
    c = sub.add_parser("tts", help="文字 → 语音文件"); c.add_argument("text", help="文字或 @文件"); c.add_argument("--model", help="indextts-2 | qwen3-tts | kokoro"); c.add_argument("--voice", help="我的音色 id / sample:voice_05 / 内置音色 id"); c.add_argument("--ref", help="参考声文件（临时克隆，不保存）"); c.add_argument("--emotion"); c.add_argument("--emo-alpha", dest="emo_alpha", type=float); c.add_argument("--instruct", help="Qwen3-TTS 的风格指令，如「用非常兴奋的语气说」"); c.add_argument("--speed", type=float); c.add_argument("--language"); c.add_argument("--design", help="Qwen3-TTS VoiceDesign 音色描述"); c.add_argument("--format", default="wav", choices=["wav", "mp3"]); c.add_argument("-o", "--out"); c.set_defaults(f=cmd_tts)
    c = sub.add_parser("voice-save", help="把参考声保存为可复用的音色（自动转写）"); c.add_argument("name"); c.add_argument("file"); c.add_argument("--note"); c.set_defaults(f=cmd_voice_save)
    c = sub.add_parser("chat", help="问一次 GPU 上的 LLM（OpenAI 兼容端点）"); c.add_argument("prompt"); c.add_argument("--model"); c.add_argument("--system"); c.add_argument("--max-tokens", type=int, default=1024); c.add_argument("--temperature", type=float, default=0.7); c.add_argument("--think", action="store_true"); c.set_defaults(f=cmd_chat)
    a = p.parse_args(); a.f(a)


if __name__ == "__main__":
    main()

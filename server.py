#!/usr/bin/env python3
"""X5 Regia – server locale: proxy 360 dagli .insv, orientamento da giroscopio, progetti, export."""
import json, os, re, subprocess, sys, threading, time, math
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote

import numpy as np
import lens

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
CACHE = ROOT / "cache"
MEDIA_DIR = Path(os.environ.get("X5_MEDIA", Path.home() / "Desktop"))
PORT = int(os.environ.get("X5_PORT", "8360"))
PROXY_W = 2880
PROXY_VERSION = 2  # 2 = doppio fisheye, cucitura nello shader

jobs = {}  # stem -> {"kind","progress","status","error","out"}


def stem_of(name):
    return Path(name).name.rsplit(".", 1)[0]


def find_media(name):
    p = (MEDIA_DIR / Path(name).name)
    if not p.exists() or p.suffix.lower() not in (".insv", ".mp4"):
        raise FileNotFoundError(name)
    return p


def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                          "stream=index,codec_type,width,height,r_frame_rate,nb_frames:format=duration",
                          "-of", "json", str(path)], capture_output=True, text=True).stdout
    return json.loads(out)


def is_dual(info):
    return len([s for s in info["streams"] if s["codec_type"] == "video"]) >= 2


def run_ffmpeg(args, stem, duration, kind):
    job = jobs[stem] = {"kind": kind, "progress": 0.0, "status": "running", "error": None}
    cmd = ["ffmpeg", "-hide_banner", "-nostats", "-progress", "pipe:1", "-y"] + args
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    job["proc"] = proc
    err_tail = []

    def drain():
        for line in proc.stderr:
            err_tail.append(line)
            del err_tail[:-30]
    threading.Thread(target=drain, daemon=True).start()
    for line in proc.stdout:
        if line.startswith("out_time_us=") and duration:
            try:
                job["progress"] = min(0.999, int(line.split("=")[1]) / 1e6 / duration)
            except ValueError:
                pass
    proc.wait()
    if proc.returncode == 0:
        job["status"], job["progress"] = "done", 1.0
    else:
        job["status"], job["error"] = "error", "".join(err_tail[-8:])
    job.pop("proc", None)
    return proc.returncode == 0


# ---------- orientamento da IMU ----------

def quat_mul(a, b):
    w1, x1, y1, z1 = a; w2, x2, y2, z2 = b
    return np.array([w1*w2 - x1*x2 - y1*y2 - z1*z2, w1*x2 + x1*w2 + y1*z2 - z1*y2,
                     w1*y2 - x1*z2 + y1*w2 + z1*x2, w1*z2 + x1*y2 - y1*x2 + z1*w2])


def quat_rot(q, v):
    qv = np.array([0.0, *v])
    qc = q * np.array([1, -1, -1, -1])
    return quat_mul(quat_mul(q, qv), qc)[1:]


def compute_orientation(path, fps, nframes):
    """Filtro di Mahony: quaternione sensore->mondo (mondo: +Y = alto) per ogni frame."""
    import telemetry_parser as tp
    d = tp.Parser(str(path)).normalized_imu()
    t = np.array([s["timestamp_ms"] for s in d]) / 1000.0
    g = np.radians(np.array([s["gyro"] for s in d]))
    a = np.array([s["accl"] for s in d])
    q = np.array([1.0, 0, 0, 0])
    # allinea l'alto iniziale alla gravità media del primo secondo
    a0 = a[: max(1, min(len(a), 500))].mean(0)
    a0 /= np.linalg.norm(a0)
    up = np.array([0, 1.0, 0])
    axis = np.cross(a0, up); s = np.linalg.norm(axis); c = float(np.dot(a0, up))
    if s > 1e-6:
        ang = math.atan2(s, c); axis /= s
        q = np.array([math.cos(ang/2), *(axis*math.sin(ang/2))])
    kp = 1.2
    out_t = np.arange(nframes) / fps
    out = np.zeros((nframes, 4)); j = 0
    for i in range(len(t)):
        dt = (t[i] - t[i-1]) if i else 0.001
        dt = min(max(dt, 0.0), 0.02)
        w = g[i].copy()
        an = np.linalg.norm(a[i])
        if 7.0 < an < 12.5:  # correggi solo quando non ci sono accelerazioni forti
            v_up = quat_rot(q * np.array([1, -1, -1, -1]), up)  # alto del mondo in coordinate sensore
            w += kp * np.cross(a[i] / an, v_up)
        dq = np.array([0.0, *w]) * 0.5
        q = q + quat_mul(q, dq) * dt
        q /= np.linalg.norm(q)
        while j < nframes and out_t[j] <= t[i]:
            out[j] = q; j += 1
    out[j:] = q
    return out


# ---------- job ----------

def prepare(name):
    path = find_media(name)
    stem = stem_of(name)
    d = CACHE / stem; d.mkdir(parents=True, exist_ok=True)
    info = probe(path)
    dur = float(info["format"]["duration"])
    v0 = [s for s in info["streams"] if s["codec_type"] == "video"][0]
    num, den = map(int, v0["r_frame_rate"].split("/"))
    fps = num / den
    nframes = int(v0.get("nb_frames") or round(dur * fps))
    meta = {"name": path.name, "duration": dur, "fps": fps, "fps_num": num, "fps_den": den,
            "nframes": nframes, "dual": is_dual(info), "proxy_version": PROXY_VERSION,
            "lens": lens.DEFAULT, "shader": lens.shader_params(lens.DEFAULT)}
    (d / "meta.json").write_text(json.dumps(meta))
    jobs[stem] = {"kind": "imu", "progress": 0, "status": "running", "error": None}
    try:
        ori = compute_orientation(path, fps, nframes)
        (d / "orient.json").write_text(json.dumps(np.round(ori, 5).tolist()))
    except Exception as e:  # senza giroscopio si lavora comunque
        print("IMU non disponibile:", e)
    if meta["dual"]:
        h = PROXY_W // 2
        vf = f"[0:v:0]scale={h}:{h}[a];[0:v:1]scale={h}:{h}[b];[a][b]hstack[v]"
    else:
        vf = f"[0:v:0]scale={PROXY_W}:{PROXY_W//2}[v]"
    tmp = d / "proxy.tmp.mp4"
    ok = run_ffmpeg(["-hwaccel", "videotoolbox", "-i", str(path), "-filter_complex", vf,
                     "-map", "[v]", "-map", "0:a?", "-c:v", "h264_videotoolbox", "-b:v", "14M",
                     "-g", "15", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(tmp)],
                    stem, dur, "proxy")
    if ok:
        tmp.rename(d / "proxy.mp4")


EXPORT_CHUNKS = 2  # oltre, la decodifica 8K satura memoria e decoder hardware


def export(name, payload):
    """Divide il video in blocchi e li renderizza in parallelo con export_worker.py."""
    path = find_media(name)
    stem = stem_of(name)
    d = CACHE / stem
    meta = json.loads((d / "meta.json").read_text())
    frames = payload["frames"]  # [[R vista->camera 3x3 per righe], campo visivo sul lato lungo]
    W, H = int(payload.get("width", 1920)) // 2 * 2, int(payload.get("height", 1080)) // 2 * 2
    codec, quality = payload.get("codec", "hevc"), payload.get("quality", "alta")
    mbps = {"standard": 25, "alta": 40, "massima": 70}.get(quality, 40) * (W * H) / (1920 * 1080)
    if codec == "prores":
        codec_args = ["-c:v", "prores_videotoolbox", "-profile:v", {"standard": "2", "alta": "3", "massima": "3"}[quality]]
        ext, audio = ".mov", ["-c:a", "pcm_s16le"]
    elif codec == "h264":
        codec_args = ["-c:v", "h264_videotoolbox", "-b:v", f"{mbps * 1.5:.0f}M", "-profile:v", "high"]
        ext, audio = ".mp4", ["-c:a", "aac", "-b:a", "256k"]
    else:
        codec_args = ["-c:v", "hevc_videotoolbox", "-b:v", f"{mbps:.0f}M", "-tag:v", "hvc1"]
        ext, audio = ".mp4", ["-c:a", "aac", "-b:a", "256k"]
    fps = meta["fps"]
    n = len(frames)
    job = jobs[stem] = {"kind": "export", "progress": 0.0, "status": "running", "error": None}
    bounds = [round(n * i / EXPORT_CHUNKS) for i in range(EXPORT_CHUNKS + 1)]
    parts, procs = [], []
    for c in range(EXPORT_CHUNKS):
        a, b = bounds[c], bounds[c + 1]
        if b <= a:
            continue
        part = d / f"part_{c}{ext}"
        jf = d / f"job_{c}.json"
        jf.write_text(json.dumps({"lens": meta["lens"], "width": W, "height": H, "fps": fps,
                                  "rate": f"{meta['fps_num']}/{meta['fps_den']}",
                                  "codec_args": codec_args, "input": str(path),
                                  "start": a / fps, "output": str(part), "frames": frames[a:b]}))
        parts.append(part)
        procs.append(subprocess.Popen([sys.executable, str(ROOT / "export_worker.py"), str(jf)],
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=str(ROOT)))
    job["proc"] = procs
    done = [0] * len(procs)

    def watch(ix, proc):
        for line in proc.stdout:
            try:
                done[ix] = int(line)
            except ValueError:
                pass
            job["progress"] = 0.97 * sum(done) / n
    ths = [threading.Thread(target=watch, args=(i, p), daemon=True) for i, p in enumerate(procs)]
    [t.start() for t in ths]
    errs = []
    for p in procs:
        p.wait()
        if p.returncode:
            errs.append(p.stderr.read()[-800:] or f"interrotto ({p.returncode})")
    if errs:
        job["status"], job["error"] = "error", "\n".join(errs)
        job.pop("proc", None)
        return
    lst = d / "parts.txt"
    lst.write_text("".join(f"file '{p}'\n" for p in parts))
    label = re.sub(r"[^\w-]", "", str(payload.get("label", "")))
    out = MEDIA_DIR / f"{stem}_regia{'_' + label if label else ''}{ext}"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst),
                    "-i", str(path), "-map", "0:v", "-map", "1:a?", "-c:v", "copy", *audio,
                    "-t", f"{n / fps:.6f}", "-movflags", "+faststart", str(out)], check=False)
    for p in parts:
        p.unlink(missing_ok=True)
    job.update(status="done", progress=1.0, out=out.name)
    job.pop("proc", None)


def track(name, body):
    """Lancia tracker.py e salva il risultato in cache/<stem>/track_<id>.json."""
    stem = stem_of(name); d = CACHE / stem
    key = stem + "#track"
    job = jobs[key] = {"kind": "track", "progress": 0.0, "status": "running", "error": None}
    meta = json.loads((d / "meta.json").read_text())
    tid = re.sub(r"[^\w-]", "", str(body.get("tid", "x")))
    out = d / f"track_{tid}.json"
    jf = d / "track_job.json"
    jf.write_text(json.dumps({**body, "meta": meta, "orient": str(d / "orient.json") if (d / "orient.json").exists() else None,
                              "proxy": str(d / "proxy.mp4"), "proxy_w": PROXY_W, "proxy_h": PROXY_W // 2,
                              "output": str(out)}))
    p = subprocess.Popen([sys.executable, str(ROOT / "tracker.py"), str(jf)], stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, text=True, cwd=str(ROOT))
    job["proc"] = p
    for line in p.stdout:
        parts = line.split()
        if len(parts) == 2 and parts[0].isdigit():
            job["progress"] = int(parts[0]) / max(1, int(parts[1]))
    p.wait()
    if p.returncode == 0 and out.exists():
        job.update(status="done", progress=1.0, out=out.name)
    else:
        job.update(status="error", error=p.stderr.read()[-800:])
    job.pop("proc", None)


def proxy_ready(s):
    try:
        return (CACHE / s / "proxy.mp4").exists() and \
            json.loads((CACHE / s / "meta.json").read_text()).get("proxy_version") == PROXY_VERSION
    except Exception:
        return False


# ---------- HTTP ----------

class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(WEB), **k)

    def log_message(self, *a):
        pass

    def end_headers(self):
        if not self.path.startswith("/cache/"):
            self.send_header("Cache-Control", "no-store")  # l'interfaccia deve sempre essere l'ultima versione
        super().end_headers()

    def send_json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def body(self):
        n = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        u = urlparse(self.path); q = parse_qs(u.query)
        if u.path == "/api/files":
            files = []
            for p in sorted(MEDIA_DIR.glob("*.insv"), key=lambda p: p.stat().st_mtime, reverse=True):
                s = stem_of(p.name)
                files.append({"name": p.name, "size": p.stat().st_size, "mtime": p.stat().st_mtime,
                              "ready": proxy_ready(s),
                              "job": {k: v for k, v in jobs.get(s, {}).items() if k != "proc"}})
            return self.send_json({"dir": str(MEDIA_DIR), "files": files})
        if u.path == "/api/status":
            s = stem_of(q["name"][0]) + ("#" + q["kind"][0] if "kind" in q else "")
            return self.send_json({k: v for k, v in jobs.get(s, {}).items() if k != "proc"})
        m = re.match(r"^/cache/([^/]+)/(proxy\.mp4|meta\.json|orient\.json|project\.json|track_[\w-]+\.json)$", u.path)
        if m:
            f = CACHE / unquote(m.group(1)) / m.group(2)
            if not f.exists():
                return self.send_json({"error": "not found"}, 404)
            return self.serve_file(f)
        return super().do_GET()

    def serve_file(self, f):
        size = f.stat().st_size
        ctype = "video/mp4" if f.suffix == ".mp4" else "application/json"
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng)
            if m.group(1):
                start = int(m.group(1))
                if m.group(2):
                    end = min(int(m.group(2)), size - 1)
            else:
                start = size - int(m.group(2))
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        with open(f, "rb") as fh:
            fh.seek(start); left = end - start + 1
            try:
                while left > 0:
                    chunk = fh.read(min(1 << 20, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk); left -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def do_POST(self):
        u = urlparse(self.path); q = parse_qs(u.query)
        name = q.get("name", [""])[0]
        s = stem_of(name)
        if u.path == "/api/prepare":
            if jobs.get(s, {}).get("status") == "running":
                return self.send_json({"ok": True})
            threading.Thread(target=prepare, args=(name,), daemon=True).start()
            return self.send_json({"ok": True})
        if u.path == "/api/project":
            d = CACHE / s; d.mkdir(parents=True, exist_ok=True)
            (d / "project.json").write_text(json.dumps(self.body()))
            return self.send_json({"ok": True})
        if u.path == "/api/export":
            if jobs.get(s, {}).get("status") == "running":
                return self.send_json({"error": "già in corso"}, 409)
            threading.Thread(target=export, args=(name, self.body()), daemon=True).start()
            return self.send_json({"ok": True})
        if u.path == "/api/track":
            if jobs.get(s + "#track", {}).get("status") == "running":
                return self.send_json({"error": "tracking già in corso"}, 409)
            threading.Thread(target=track, args=(name, self.body()), daemon=True).start()
            return self.send_json({"ok": True})
        if u.path == "/api/cancel":
            p = jobs.get(s + ("#" + q["kind"][0] if "kind" in q else ""), {}).get("proc")
            for x in (p if isinstance(p, list) else [p] if p else []):
                x.terminate()
            return self.send_json({"ok": True})
        if u.path == "/api/reveal":
            subprocess.run(["open", "-R", str(MEDIA_DIR / Path(name).name)])
            return self.send_json({"ok": True})
        self.send_json({"error": "?"}, 404)


if __name__ == "__main__":
    CACHE.mkdir(exist_ok=True)
    print(f"X5 Regia → http://localhost:{PORT}  (cartella video: {MEDIA_DIR})")
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()

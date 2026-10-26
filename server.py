#!/usr/bin/env python3
"""X5 Regia – server locale.

Libreria di file .insv (da qualsiasi cartella), progetti con una o più clip in sequenza,
copie leggere per l'anteprima, orientamento da giroscopio, forma d'onda, sincronizzazione
dell'audio esterno, tracking ed export su GPU.
"""
import hashlib, json, math, os, re, shutil, subprocess, sys, threading, time, uuid
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote

import numpy as np
import lens

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
CACHE = ROOT / "cache"
DATA = ROOT / "data"
PROJECTS = DATA / "projects"
LIBRARY = DATA / "library.json"
MEDIA_DIR = Path(os.environ.get("X5_MEDIA", Path.home() / "Desktop"))
OUT_DIR = Path(os.environ.get("X5_OUT", MEDIA_DIR))
PORT = int(os.environ.get("X5_PORT", "8360"))
PROXY_W = 2880
PROXY_VERSION = 3  # 3 = doppio fisheye + forma d'onda
AUDIO_EXT = (".wav", ".aif", ".aiff", ".mp3", ".m4a", ".flac", ".caf")
EXPORT_PARALLEL = 2  # oltre, la decodifica 8K satura memoria e decoder hardware

jobs = {}  # chiave -> {"kind","progress","status","error","out", "proc"}
lock = threading.Lock()


def public(job):
    return {k: v for k, v in (job or {}).items() if k != "proc"}


# ---------- libreria ----------

def fid_of(path):
    p = Path(path)
    return f"{p.stem}-{hashlib.sha1(str(p.resolve()).encode()).hexdigest()[:6]}"


def load_library():
    try:
        return json.loads(LIBRARY.read_text())
    except Exception:
        return {"files": [], "audio": []}


def save_library(lib):
    DATA.mkdir(exist_ok=True)
    LIBRARY.write_text(json.dumps(lib, indent=1))


def library_files():
    lib = load_library()
    paths = {str(p) for p in MEDIA_DIR.glob("*.insv")} | set(lib["files"])
    return {fid_of(p): Path(p) for p in paths if Path(p).exists()}


def library_audio():
    lib = load_library()
    paths = {str(p) for p in MEDIA_DIR.iterdir() if p.suffix.lower() in AUDIO_EXT} | set(lib.get("audio", []))
    return [Path(p) for p in sorted(paths) if Path(p).exists()]


def file_path(fid):
    p = library_files().get(fid)
    if not p:
        raise FileNotFoundError(fid)
    return p


def file_dir(fid):
    return CACHE / "files" / fid


def file_ready(fid):
    try:
        m = json.loads((file_dir(fid) / "meta.json").read_text())
        return (file_dir(fid) / "proxy.mp4").exists() and m.get("proxy_version") == PROXY_VERSION
    except Exception:
        return False


def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                          "stream=index,codec_type,width,height,r_frame_rate,nb_frames:format=duration",
                          "-of", "json", str(path)], capture_output=True, text=True).stdout
    return json.loads(out)


def run_ffmpeg(args, key, duration, kind):
    job = jobs[key] = {"kind": kind, "progress": 0.0, "status": "running", "error": None}
    proc = subprocess.Popen(["ffmpeg", "-hide_banner", "-nostats", "-progress", "pipe:1", "-y"] + args,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    job["proc"] = proc
    err_tail = []

    def drain():
        for line in proc.stderr:
            err_tail.append(line); del err_tail[:-30]
    threading.Thread(target=drain, daemon=True).start()
    for line in proc.stdout:
        if line.startswith("out_time_us=") and duration:
            try:
                job["progress"] = min(0.999, int(line.split("=")[1]) / 1e6 / duration)
            except ValueError:
                pass
    proc.wait()
    ok = proc.returncode == 0
    job.update(status="done" if ok else "error", progress=1.0 if ok else job["progress"],
               error=None if ok else "".join(err_tail[-8:]))
    job.pop("proc", None)
    return ok


# ---------- orientamento da IMU ----------

def quat_mul(a, b):
    w1, x1, y1, z1 = a; w2, x2, y2, z2 = b
    return np.array([w1*w2 - x1*x2 - y1*y2 - z1*z2, w1*x2 + x1*w2 + y1*z2 - z1*y2,
                     w1*y2 - x1*z2 + y1*w2 + z1*x2, w1*z2 + x1*y2 - y1*x2 + z1*w2])


def quat_rot(q, v):
    return quat_mul(quat_mul(q, np.array([0.0, *v])), q * np.array([1, -1, -1, -1]))[1:]


def compute_orientation(path, fps, nframes):
    """Filtro di Mahony: quaternione sensore->mondo (mondo: +Y = alto) per ogni frame."""
    import telemetry_parser as tp
    d = tp.Parser(str(path)).normalized_imu()
    t = np.array([s["timestamp_ms"] for s in d]) / 1000.0
    g = np.radians(np.array([s["gyro"] for s in d]))
    a = np.array([s["accl"] for s in d])
    q = np.array([1.0, 0, 0, 0])
    a0 = a[: max(1, min(len(a), 500))].mean(0); a0 /= np.linalg.norm(a0)
    up = np.array([0, 1.0, 0])
    axis = np.cross(a0, up); s = np.linalg.norm(axis); c = float(np.dot(a0, up))
    if s > 1e-6:
        ang = math.atan2(s, c); axis /= s
        q = np.array([math.cos(ang / 2), *(axis * math.sin(ang / 2))])
    kp = 1.2
    out_t = np.arange(nframes) / fps
    out = np.zeros((nframes, 4)); j = 0
    for i in range(len(t)):
        dt = min(max((t[i] - t[i - 1]) if i else 0.001, 0.0), 0.02)
        w = g[i].copy()
        an = np.linalg.norm(a[i])
        if 7.0 < an < 12.5:  # correggi solo quando non ci sono accelerazioni forti
            w += kp * np.cross(a[i] / an, quat_rot(q * np.array([1, -1, -1, -1]), up))
        q = q + quat_mul(q, np.array([0.0, *w]) * 0.5) * dt
        q /= np.linalg.norm(q)
        while j < nframes and out_t[j] <= t[i]:
            out[j] = q; j += 1
    out[j:] = q
    return out


def audio_peaks(path, rate=100):
    """Forma d'onda: picco per ogni 1/rate di secondo, 0..255."""
    p = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-map", "0:a:0", "-ac", "1", "-ar", str(rate * 40),
                        "-f", "s16le", "-"], capture_output=True)
    a = np.abs(np.frombuffer(p.stdout, np.int16).astype(np.float32))
    n = len(a) // 40
    if not n:
        return []
    pk = a[: n * 40].reshape(n, 40).max(1) / 32768
    return np.round(np.sqrt(pk) * 255).astype(int).tolist()


# ---------- preparazione file ----------

def prepare_file(fid):
    path = file_path(fid)
    d = file_dir(fid); d.mkdir(parents=True, exist_ok=True)
    info = probe(path)
    dur = float(info["format"]["duration"])
    vs = [s for s in info["streams"] if s["codec_type"] == "video"]
    num, den = map(int, vs[0]["r_frame_rate"].split("/"))
    fps = num / den
    nframes = int(vs[0].get("nb_frames") or round(dur * fps))
    meta = {"fid": fid, "name": path.name, "duration": nframes / fps, "fps": fps, "fps_num": num, "fps_den": den,
            "nframes": nframes, "dual": len(vs) >= 2, "proxy_version": PROXY_VERSION,
            "lens": lens.DEFAULT, "shader": lens.shader_params(lens.DEFAULT)}
    jobs[fid] = {"kind": "imu", "progress": 0, "status": "running", "error": None}
    try:
        (d / "orient.json").write_text(json.dumps(np.round(compute_orientation(path, fps, nframes), 5).tolist()))
    except Exception as e:  # senza giroscopio si lavora comunque
        print("IMU non disponibile:", e)
    try:
        (d / "peaks.json").write_text(json.dumps(audio_peaks(path)))
    except Exception as e:
        print("audio non disponibile:", e)
    h = PROXY_W // 2
    vf = (f"[0:v:0]scale={h}:{h}[a];[0:v:1]scale={h}:{h}[b];[a][b]hstack[v]" if meta["dual"]
          else f"[0:v:0]scale={PROXY_W}:{PROXY_W // 2}[v]")
    tmp = d / "proxy.tmp.mp4"
    ok = run_ffmpeg(["-hwaccel", "videotoolbox", "-i", str(path), "-filter_complex", vf, "-map", "[v]", "-map", "0:a?",
                     "-c:v", "h264_videotoolbox", "-b:v", "14M", "-g", "15", "-c:a", "aac", "-b:a", "192k",
                     "-movflags", "+faststart", str(tmp)], fid, dur, "proxy")
    if ok:
        tmp.rename(d / "proxy.mp4")
        (d / "meta.json").write_text(json.dumps(meta))


# ---------- progetti ----------

def project_path(pid):
    if not re.fullmatch(r"[\w-]+", pid or ""):
        raise FileNotFoundError(pid)
    return PROJECTS / f"{pid}.json"


def load_project(pid):
    return json.loads(project_path(pid).read_text())


def project_dir(pid):
    return CACHE / "projects" / pid


def clips_signature(clips):
    return hashlib.sha1(json.dumps(clips).encode()).hexdigest()[:10]


def build_project(pid):
    """Unisce le clip del progetto in un'unica sequenza: copia leggera, giroscopio, forma d'onda."""
    key = pid + "#build"
    jobs[key] = {"kind": "build", "progress": 0.0, "status": "running", "error": None}
    try:
        P = load_project(pid)
        clips = P["clips"]
        for k, fid in enumerate(clips):
            if not file_ready(fid):
                jobs[key]["phase"] = f"Preparazione {k + 1}/{len(clips)}"
                prepare_file(fid)
                if not file_ready(fid):
                    raise RuntimeError(jobs.get(fid, {}).get("error") or f"preparazione di {fid} fallita")
            jobs[key]["progress"] = (k + 1) / (len(clips) + 1)
        d = project_dir(pid); d.mkdir(parents=True, exist_ok=True)
        metas = [json.loads((file_dir(f) / "meta.json").read_text()) for f in clips]
        f0, segs, orient, peaks = 0, [], [], []
        for f, m in zip(clips, metas):
            segs.append({"fid": f, "name": m["name"], "f0": f0, "nframes": m["nframes"], "duration": m["duration"]})
            f0 += m["nframes"]
            o = file_dir(f) / "orient.json"
            orient += json.loads(o.read_text()) if o.exists() else [[1, 0, 0, 0]] * m["nframes"]
            pk = file_dir(f) / "peaks.json"
            pv = json.loads(pk.read_text()) if pk.exists() else []
            want = int(round(m["duration"] * 100))
            peaks += (pv + [0] * want)[:want]
        m0 = metas[0]
        meta = {**{k: m0[k] for k in ("fps", "fps_num", "fps_den", "dual", "lens", "shader")},
                "pid": pid, "nframes": f0, "duration": f0 / m0["fps"], "clips": segs,
                "signature": clips_signature(clips), "proxy_version": PROXY_VERSION}
        (d / "orient.json").write_text(json.dumps(orient))
        (d / "peaks.json").write_text(json.dumps(peaks))
        proxy = d / "proxy.mp4"
        if len(clips) == 1:
            if proxy.exists() or proxy.is_symlink():
                proxy.unlink()
            os.symlink(file_dir(clips[0]) / "proxy.mp4", proxy)
        else:
            lst = d / "concat.txt"
            lst.write_text("".join(f"file '{file_dir(f) / 'proxy.mp4'}'\n" for f in clips))
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy",
                            "-movflags", "+faststart", str(d / "proxy.tmp.mp4")], check=True)
            (d / "proxy.tmp.mp4").replace(proxy)
        try:  # colore uniforme tra i due obiettivi
            L = dict(m0["lens"])
            ga, gb = lens.estimate_gains(proxy, L, np.linspace(0.1, 0.9, 6) * meta["duration"])
            L.update(gainA=ga, gainB=gb)
            meta["lens"], meta["shader"] = L, lens.shader_params(L)
        except Exception as e:
            print("guadagni non stimati:", e)
        (d / "meta.json").write_text(json.dumps(meta))
        jobs[key].update(status="done", progress=1.0)
    except Exception as e:
        jobs[key].update(status="error", error=str(e))


def project_ready(pid):
    try:
        P = load_project(pid)
        m = json.loads((project_dir(pid) / "meta.json").read_text())
        return m.get("signature") == clips_signature(P["clips"]) and (project_dir(pid) / "proxy.mp4").exists()
    except Exception:
        return False


def migrate_old_cache():
    """Prima versione: cache/<stem>/project.json legato a un singolo file sulla Scrivania."""
    if not CACHE.exists():
        return
    files = library_files()
    for old in CACHE.iterdir():
        pj = old / "project.json"
        if old.name in ("files", "projects") or not pj.exists():
            continue
        match = [fid for fid, p in files.items() if p.stem == old.name]
        if match:
            PROJECTS.mkdir(parents=True, exist_ok=True)
            pid = re.sub(r"[^\w-]", "", old.name)
            if not project_path(pid).exists():
                data = json.loads(pj.read_text())
                data.update(name=old.name, clips=[match[0]])
                project_path(pid).write_text(json.dumps(data))
            shutil.rmtree(old, ignore_errors=True)


# ---------- export ----------

def codec_settings(codec, quality, W, H):
    mbps = {"standard": 25, "alta": 40, "massima": 70}.get(quality, 40) * (W * H) / (1920 * 1080)
    if codec == "prores":
        return ["-c:v", "prores_videotoolbox", "-profile:v", "2" if quality == "standard" else "3"], ".mov", ["-c:a", "pcm_s16le"]
    if codec == "h264":
        return ["-c:v", "h264_videotoolbox", "-b:v", f"{mbps * 1.5:.0f}M", "-profile:v", "high"], ".mp4", ["-c:a", "aac", "-b:a", "256k"]
    return ["-c:v", "hevc_videotoolbox", "-b:v", f"{mbps:.0f}M", "-tag:v", "hvc1"], ".mp4", ["-c:a", "aac", "-b:a", "256k"]


def export(pid, payload, key):
    """payload.segments: [{f0, frames:[[R,fov],...]}] in frame di timeline (già tagliati/velocità).
    Ogni segmento viene diviso per clip e renderizzato su GPU; l'audio segue gli stessi intervalli."""
    job = jobs[key]
    d = project_dir(pid)
    meta = json.loads((d / "meta.json").read_text())
    fps = meta["fps"]
    W, H = int(payload.get("width", 1920)) // 2 * 2, int(payload.get("height", 1080)) // 2 * 2
    codec_args, ext, audio_codec = codec_settings(payload.get("codec", "hevc"), payload.get("quality", "alta"), W, H)
    work = d / f"export_{uuid.uuid4().hex[:6]}"; work.mkdir()
    # pezzi contigui dentro una sola clip; seg.src = frame sorgente (timeline) per ogni frame d'uscita
    pieces = []
    for seg in payload["segments"]:
        frames, src = seg["frames"], seg["src"]
        k = 0
        while k < len(frames):
            clip = next(c for c in meta["clips"] if c["f0"] <= src[k] < c["f0"] + c["nframes"])
            e = k
            while e < len(frames) and src[e] < clip["f0"] + clip["nframes"]:
                e += 1
            pieces.append({"clip": clip, "local": src[k] - clip["f0"], "frames": frames[k:e],
                           "src": [x - clip["f0"] for x in src[k:e]]})
            k = e
    total = sum(len(p["frames"]) for p in pieces)
    done = {}
    parts = []
    running = []

    def launch(i, p):
        part = work / f"part_{i:04d}{ext}"
        jf = work / f"job_{i:04d}.json"
        jf.write_text(json.dumps({"lens": meta["lens"], "width": W, "height": H, "fps": fps,
                                  "rate": f"{meta['fps_num']}/{meta['fps_den']}", "codec_args": codec_args,
                                  "input": str(file_path(p["clip"]["fid"])), "start": p["local"] / fps,
                                  "src": p["src"], "output": str(part), "frames": p["frames"],
                                  "grade": payload.get("grade"), "proj": payload.get("proj")}))
        proc = subprocess.Popen([sys.executable, str(ROOT / "export_worker.py"), str(jf)], stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, cwd=str(ROOT))

        def watch():
            for line in proc.stdout:
                try:
                    done[i] = int(line)
                except ValueError:
                    pass
                job["progress"] = 0.95 * sum(done.values()) / max(1, total)
        threading.Thread(target=watch, daemon=True).start()
        return proc, part

    queue = list(enumerate(pieces))
    job["proc"] = []
    errs = []
    while queue or running:
        while queue and len(running) < EXPORT_PARALLEL and not errs:
            i, p = queue.pop(0)
            proc, part = launch(i, p)
            running.append(proc); job["proc"].append(proc); parts.append((i, part))
        for proc in list(running):
            if proc.poll() is not None:
                running.remove(proc)
                if proc.returncode:
                    errs.append(proc.stderr.read()[-800:] or f"interrotto ({proc.returncode})")
        if errs and not running:
            break
        time.sleep(0.2)
    if errs:
        job.update(status="error", error="\n".join(errs)); job.pop("proc", None)
        shutil.rmtree(work, ignore_errors=True)
        return
    job["phase"] = "Audio"
    parts.sort()
    lst = work / "parts.txt"
    lst.write_text("".join(f"file '{p}'\n" for _, p in parts))
    # audio: stessi intervalli della timeline, dalla camera e/o da un file esterno
    au = payload.get("audio") or {}
    inputs, chains, labels = [], [], []
    cam_gain = float(au.get("cam", 1.0)); ext_gain = float(au.get("ext", 0.0)) if au.get("path") else 0.0
    clip_inputs = {}
    for seg in payload["segments"]:
        n = len(seg["frames"])
        speed = seg.get("speed", 1.0)
        dur_src = (seg["src"][-1] - seg["src"][0] + 1) / fps
        src0 = seg["src"][0]
        tempo = ""
        if abs(speed - 1) > 1e-3:
            sp = speed; tl = []
            while sp > 2: tl.append("atempo=2"); sp /= 2
            while sp < 0.5: tl.append("atempo=0.5"); sp /= 0.5
            tl.append(f"atempo={sp:.4f}"); tempo = "," + ",".join(tl)
        parts_a = []
        if cam_gain > 0:
            # la parte camera può attraversare più clip
            t0 = src0
            left = dur_src
            while left > 1e-4:
                clip = next(c for c in meta["clips"] if c["f0"] <= t0 < c["f0"] + c["nframes"])
                take = min(left, (clip["f0"] + clip["nframes"] - t0) / fps)
                if clip["fid"] not in clip_inputs:
                    clip_inputs[clip["fid"]] = len(inputs) // 2 + 1; inputs += ["-i", str(file_path(clip["fid"]))]  # 0 = video
                ii = clip_inputs[clip["fid"]]
                s = (t0 - clip["f0"]) / fps
                lab = f"c{len(chains)}"
                chains.append(f"[{ii}:a:0]atrim=start={s:.6f}:duration={take:.6f},asetpts=PTS-STARTPTS[{lab}]")
                parts_a.append(lab)
                t0 += take * fps; left -= take
        cam_lab = None
        if parts_a:
            cam_lab = f"cam{len(chains)}"
            chains.append("".join(f"[{l}]" for l in parts_a) + f"concat=n={len(parts_a)}:v=0:a=1,volume={cam_gain}[{cam_lab}]")
        ext_lab = None
        if ext_gain > 0:
            if "ext" not in clip_inputs:
                clip_inputs["ext"] = len(inputs) // 2 + 1; inputs += ["-i", au["path"]]
            s = src0 / fps + float(au.get("offset", 0))
            ext_lab = f"e{len(chains)}"
            pad = f",adelay={-s * 1000:.0f}:all=1" if s < 0 else ""
            chains.append(f"[{clip_inputs['ext']}:a:0]atrim=start={max(0, s):.6f}:duration={dur_src:.6f},"
                          f"asetpts=PTS-STARTPTS{pad},apad,atrim=duration={dur_src:.6f},volume={ext_gain}[{ext_lab}]")
        lab = f"s{len(chains)}"
        if cam_lab and ext_lab:
            chains.append(f"[{cam_lab}][{ext_lab}]amix=inputs=2:normalize=0:duration=first{tempo}[{lab}]")
        elif cam_lab or ext_lab:
            chains.append(f"[{cam_lab or ext_lab}]anull{tempo}[{lab}]")
        else:
            chains.append(f"anullsrc=r=48000:cl=stereo,atrim=duration={n / fps:.6f}[{lab}]")
        labels.append(lab)
    fc = ";".join(chains) + ";" + "".join(f"[{l}]" for l in labels) + f"concat=n={len(labels)}:v=0:a=1[aout]"
    (work / "audio_graph.txt").write_text(fc)
    label = re.sub(r"[^\w-]", "", str(payload.get("label", "")))
    name = re.sub(r"[^\w-]", "_", load_project(pid).get("name", pid))
    out = OUT_DIR / f"{name}_regia{'_' + label if label else ''}{ext}"
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), *inputs,
                        "-filter_complex_script", str(work / "audio_graph.txt"), "-map", "0:v", "-map", "[aout]",
                        "-c:v", "copy", *audio_codec, "-shortest", "-movflags", "+faststart", str(out)],
                       capture_output=True, text=True)
    if r.returncode:
        job.update(status="error", error=r.stderr[-800:]); job.pop("proc", None)
        return
    shutil.rmtree(work, ignore_errors=True)
    job.update(status="done", progress=1.0, out=str(out)); job.pop("proc", None)


# ---------- tracking ----------

def track(pid, body):
    key = pid + "#track"
    job = jobs[key] = {"kind": "track", "progress": 0.0, "status": "running", "error": None}
    d = project_dir(pid)
    meta = json.loads((d / "meta.json").read_text())
    tid = re.sub(r"[^\w-]", "", str(body.get("tid", "x")))
    out = d / f"track_{tid}.json"
    jf = d / "track_job.json"
    jf.write_text(json.dumps({**body, "meta": meta, "orient": str(d / "orient.json"), "proxy": str(d / "proxy.mp4"),
                              "proxy_w": PROXY_W, "proxy_h": PROXY_W // 2, "output": str(out)}))
    script = "detect.py" if body.get("mode") == "detect" else "tracker.py"
    p = subprocess.Popen([sys.executable, str(ROOT / script), str(jf)], stdout=subprocess.PIPE,
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


# ---------- sincronizzazione audio esterno ----------

def audio_sync(pid, path):
    key = pid + "#sync"
    job = jobs[key] = {"kind": "sync", "progress": 0.1, "status": "running", "error": None}
    try:
        import audiosync
        off, conf = audiosync.find_offset(str(project_dir(pid) / "proxy.mp4"), path)
        job.update(status="done", progress=1.0, out={"offset": off, "confidence": conf})
    except Exception as e:
        job.update(status="error", error=str(e))


def director(pid, body):
    key = pid + "#director"
    job = jobs[key] = {"kind": "director", "progress": 0.1, "status": "running", "error": None}
    try:
        import autodirector
        d = project_dir(pid)
        body.update(meta=json.loads((d / "meta.json").read_text()), orient=str(d / "orient.json"),
                    proxy_w=PROXY_W, proxy_h=PROXY_W // 2)
        res = autodirector.analyze(str(d / "proxy.mp4"), body,
                                   progress=lambda x: job.__setitem__("progress", x))
        job.update(status="done", progress=1.0, out=res)
    except Exception as e:
        import traceback; traceback.print_exc()
        job.update(status="error", error=str(e))


def choose_files(kind):
    """Finestra nativa di macOS per scegliere i file (anche da scheda SD)."""
    types = '{"insv", "mp4"}' if kind == "video" else '{"wav", "aif", "aiff", "mp3", "m4a", "flac", "caf"}'
    script = (f'set fs to choose file with prompt "Scegli i file" of type {types} with multiple selections allowed\n'
              'set out to ""\nrepeat with f in fs\nset out to out & POSIX path of f & linefeed\nend repeat\nreturn out')
    r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
    return [l for l in r.stdout.splitlines() if l.strip()]


# ---------- HTTP ----------

class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(WEB), **k)

    def log_message(self, *a):
        pass

    def end_headers(self):
        if not self.path.startswith("/media/"):
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
        g = lambda k, dflt="": q.get(k, [dflt])[0]
        try:
            if u.path == "/api/library":
                files = []
                for fid, p in sorted(library_files().items(), key=lambda kv: kv[1].stat().st_mtime, reverse=True):
                    files.append({"fid": fid, "name": p.name, "path": str(p), "size": p.stat().st_size,
                                  "mtime": p.stat().st_mtime, "ready": file_ready(fid), "job": public(jobs.get(fid))})
                audio = [{"path": str(p), "name": p.name} for p in library_audio()]
                return self.send_json({"dir": str(MEDIA_DIR), "files": files, "audio": audio})
            if u.path == "/api/projects":
                out = []
                PROJECTS.mkdir(parents=True, exist_ok=True)
                for f in sorted(PROJECTS.glob("*.json"), key=lambda f: f.stat().st_mtime, reverse=True):
                    try:
                        P = json.loads(f.read_text())
                        out.append({"pid": f.stem, "name": P.get("name", f.stem), "clips": P.get("clips", []),
                                    "mtime": f.stat().st_mtime, "ready": project_ready(f.stem)})
                    except Exception:
                        pass
                return self.send_json(out)
            if u.path == "/api/project":
                return self.send_json(load_project(g("pid")))
            if u.path == "/api/status":
                return self.send_json(public(jobs.get(g("key"))))
            m = re.match(r"^/media/([\w-]+)/(proxy\.mp4|meta\.json|orient\.json|peaks\.json|track_[\w-]+\.json)$", u.path)
            if m:
                f = project_dir(m.group(1)) / m.group(2)
                return self.serve_file(f) if f.exists() else self.send_json({"error": "not found"}, 404)
            if u.path == "/media/audio":
                p = Path(g("path"))
                if p not in library_audio():
                    return self.send_json({"error": "non in libreria"}, 403)
                return self.serve_file(p)
            if u.path.startswith("/luts/"):
                f = DATA / "luts" / Path(unquote(u.path[6:])).name
                return self.serve_file(f) if f.exists() else self.send_json({"error": "not found"}, 404)
            if u.path == "/api/luts":
                (DATA / "luts").mkdir(parents=True, exist_ok=True)
                return self.send_json(sorted(p.name for p in (DATA / "luts").glob("*.cube")))
        except FileNotFoundError as e:
            return self.send_json({"error": f"non trovato: {e}"}, 404)
        return super().do_GET()

    def serve_file(self, f):
        f = Path(f)
        size = f.stat().st_size
        ctype = {".mp4": "video/mp4", ".json": "application/json", ".wav": "audio/wav", ".mp3": "audio/mpeg",
                 ".m4a": "audio/mp4", ".aif": "audio/aiff", ".aiff": "audio/aiff", ".flac": "audio/flac",
                 ".cube": "text/plain"}.get(f.suffix.lower(), "application/octet-stream")
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

    def start(self, key, target, *args):
        if jobs.get(key, {}).get("status") == "running":
            return self.send_json({"error": "già in corso"}, 409)
        jobs[key] = {"kind": key.split("#")[-1], "progress": 0.0, "status": "running", "error": None}
        threading.Thread(target=target, args=args, daemon=True).start()
        return self.send_json({"ok": True, "key": key})

    def do_POST(self):
        u = urlparse(self.path); q = parse_qs(u.query)
        g = lambda k, dflt="": q.get(k, [dflt])[0]
        pid = g("pid")
        try:
            if u.path == "/api/import":
                paths = choose_files(g("kind", "video"))
                lib = load_library()
                key = "files" if g("kind", "video") == "video" else "audio"
                lib.setdefault(key, [])
                lib[key] = sorted(set(lib[key]) | set(paths))
                save_library(lib)
                return self.send_json({"added": paths, "fids": [fid_of(p) for p in paths] if key == "files" else []})
            if u.path == "/api/projects":
                b = self.body()
                PROJECTS.mkdir(parents=True, exist_ok=True)
                pid = re.sub(r"[^\w-]", "", b.get("name", "progetto").replace(" ", "_"))[:40] or "progetto"
                base, k = pid, 2
                while project_path(pid).exists():
                    pid = f"{base}_{k}"; k += 1
                project_path(pid).write_text(json.dumps({"name": b.get("name", pid), "clips": b["clips"]}))
                return self.send_json({"pid": pid})
            if u.path == "/api/project":
                b = self.body()
                old = load_project(pid) if project_path(pid).exists() else {}
                b.setdefault("clips", old.get("clips", [])); b.setdefault("name", old.get("name", pid))
                tmp = project_path(pid).with_suffix(".tmp")
                tmp.write_text(json.dumps(b)); tmp.replace(project_path(pid))
                return self.send_json({"ok": True, "rebuild": not project_ready(pid)})
            if u.path == "/api/project_delete":
                project_path(pid).unlink(missing_ok=True)
                shutil.rmtree(project_dir(pid), ignore_errors=True)
                return self.send_json({"ok": True})
            if u.path == "/api/build":
                return self.start(pid + "#build", build_project, pid)
            if u.path == "/api/export":
                key = pid + "#export"
                if jobs.get(key, {}).get("status") == "running":
                    return self.send_json({"error": "export già in corso"}, 409)
                jobs[key] = {"kind": "export", "progress": 0.0, "status": "running", "error": None}
                threading.Thread(target=export, args=(pid, self.body(), key), daemon=True).start()
                return self.send_json({"ok": True, "key": key})
            if u.path == "/api/track":
                return self.start(pid + "#track", track, pid, self.body())
            if u.path == "/api/sync":
                p = self.body().get("path")
                if Path(p) not in library_audio():
                    return self.send_json({"error": "file audio non in libreria"}, 403)
                return self.start(pid + "#sync", audio_sync, pid, p)
            if u.path == "/api/director":
                return self.start(pid + "#director", director, pid, self.body())
            if u.path == "/api/cancel":
                p = jobs.get(g("key"), {}).get("proc")
                for x in (p if isinstance(p, list) else [p] if p else []):
                    x.terminate()
                return self.send_json({"ok": True})
            if u.path == "/api/reveal":
                p = Path(g("path"))
                if p.exists() and p.parent == OUT_DIR:
                    subprocess.run(["open", "-R", str(p)])
                return self.send_json({"ok": True})
            if u.path == "/api/import_lut":
                paths = [l for l in subprocess.run(["osascript", "-e",
                         'POSIX path of (choose file with prompt "Scegli una LUT .cube" of type {"cube"})'],
                         capture_output=True, text=True).stdout.splitlines() if l.strip()]
                (DATA / "luts").mkdir(parents=True, exist_ok=True)
                for p in paths:
                    shutil.copy(p, DATA / "luts" / Path(p).name)
                return self.send_json({"added": [Path(p).name for p in paths]})
        except FileNotFoundError as e:
            return self.send_json({"error": f"non trovato: {e}"}, 404)
        self.send_json({"error": "?"}, 404)


if __name__ == "__main__":
    CACHE.mkdir(exist_ok=True); PROJECTS.mkdir(parents=True, exist_ok=True)
    migrate_old_cache()
    print(f"X5 Regia → http://localhost:{PORT}  (cartella video: {MEDIA_DIR})")
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()

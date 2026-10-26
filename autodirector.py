"""Regia automatica di partenza.

- Audio: tempo (BPM) e attacchi → i cambi di inquadratura cadono a inizio battuta.
- Immagine: per ogni soggetto, quanta "azione" c'è nel suo riquadro (differenza tra fotogrammi):
  chi suona/canta si muove di più.
- Scelta: per ogni tratto il soggetto più attivo, evitando ripetizioni, con qualche totale.
I soggetti arrivano dal browser già campionati: per ogni istante direzione e dimensione nel mondo.
"""
import json, math, subprocess
import numpy as np
import audiosync

SAMPLE = 0.5  # passo di analisi (s)


def beats(proxy, duration):
    R = 8000
    x = audiosync.load(proxy, R)
    ER = 100
    e = audiosync.envelope(x, R, ER)
    e = np.convolve(e, np.ones(3) / 3, "same")
    # tempo: autocorrelazione dell'inviluppo degli attacchi tra 70 e 180 BPM
    n = len(e)
    ac = np.fft.irfft(np.abs(np.fft.rfft(e, 2 * n)) ** 2)[: n]
    lo, hi = int(ER * 60 / 180), int(ER * 60 / 70)
    period = lo + int(np.argmax(ac[lo:hi])) if hi < n else int(ER * 0.5)
    bpm = 60 * ER / period
    # fase: dove gli attacchi cadono più spesso
    phase = int(np.argmax([e[p::period].sum() for p in range(period)]))
    beat_t = (phase + np.arange(0, n - phase, period)) / ER
    strength = np.array([e[max(0, int(t * ER) - 2): int(t * ER) + 3].max(initial=0) for t in beat_t])
    return bpm, beat_t, strength


def activity(J, progress):
    """Energia di movimento per soggetto: differenza tra fotogrammi chiave consecutivi (ogni 0,5 s)
    nel riquadro del soggetto, renderizzato con la stessa proiezione dell'anteprima."""
    import re, threading
    from detect import Renderer
    R = Renderer(J)
    fps = R.fps
    times = np.array(J["times"])
    subs = J["subjects"]
    act = np.zeros((len(subs), len(times)))
    fsz = R.W * R.H * 3
    p = subprocess.Popen(["ffmpeg", "-v", "info", "-skip_frame", "nokey", "-i", J["proxy"], "-vf", "showinfo",
                          "-vsync", "0", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=1 << 25)
    pts = []

    def read_err():
        for line in p.stderr:
            m = re.search(rb"pts_time:([\d.]+)", line)
            if m:
                pts.append(float(m.group(1)))
    threading.Thread(target=read_err, daemon=True).start()
    prev_crops, n = None, 0
    while True:
        b = p.stdout.read(fsz)
        if len(b) < fsz:
            break
        while len(pts) <= n:  # aspetta il timestamp di questo fotogramma
            if p.poll() is not None:
                break
            __import__("time").sleep(0.001)
        t = pts[n] if n < len(pts) else n * 0.5
        k = int(np.clip(np.searchsorted(times, t), 0, len(times) - 1))
        R.load(b)
        crops = []
        for s in subs:
            d = np.array(s["dirs"][k]); size = max(s["sizes"][k][1], 8)
            R.view(int(t * fps), d, min(100, size * 1.4))
            crops.append(np.frombuffer(R.fb.read(components=4, alignment=1), np.uint8).astype(np.int16))
        if prev_crops is not None:
            for si in range(len(subs)):
                act[si, k] = max(act[si, k], float(np.abs(crops[si] - prev_crops[si]).mean()))
        prev_crops = crops; n += 1
        if n % 20 == 0:
            progress(0.2 + 0.7 * min(1, t / max(1e-6, times[-1])))
    p.kill()
    # riempi i campioni vuoti e normalizza per soggetto (chi è sempre mosso non vince sempre)
    for si in range(len(subs)):
        row = act[si]; idx = np.nonzero(row)[0]
        if len(idx):
            act[si] = np.interp(np.arange(len(row)), idx, row[idx])
    return act / (np.median(act, 1, keepdims=True) + 1e-6)


def analyze(proxy, body, progress=lambda x: None):
    J = body
    J["proxy"] = proxy
    duration = J["duration"]
    subs = J["subjects"]
    progress(0.05)
    bpm, beat_t, strength = beats(proxy, duration)
    progress(0.15)
    act = activity(J, progress) if subs else np.zeros((0, len(J["times"])))
    times = np.array(J["times"])
    pace = float(J.get("pace", 1.0))  # 1 = normale; <1 più tagli
    bar = 4 * 60 / bpm
    min_len, max_len = max(2.5, 2 * bar) * pace, max(6, 4 * bar) * pace
    # punti di taglio: battute con attacco forte, distanziate tra min e max
    cuts = [0.0]
    downbeats = beat_t[::4] if len(beat_t) else np.arange(0, duration, bar)
    t = 0.0
    while t < duration - min_len:
        cand = downbeats[(downbeats >= t + min_len) & (downbeats <= t + max_len)]
        if len(cand):
            sc = [strength[np.argmin(np.abs(beat_t - c))] if len(beat_t) else 1 for c in cand]
            t = float(cand[int(np.argmax(sc))])
        else:
            t = t + max_len
        if t < duration - 1:
            cuts.append(round(t, 3))
    kfs = []
    last, since_wide = None, 0
    framings = J.get("framings", [52, 34, 78])
    for i, c in enumerate(cuts):
        e = cuts[i + 1] if i + 1 < len(cuts) else duration
        sel = (times >= c) & (times < e)
        score = act[:, sel].mean(1) if sel.any() and len(subs) else np.zeros(len(subs))
        if len(subs):
            if last is not None:
                score[last] *= 0.55  # varietà
            best = int(np.argmax(score))
            spread = score.max() - np.median(score) if len(score) > 1 else 1
        if not len(subs) or (since_wide >= 4) or (len(subs) > 1 and spread < 0.15 and i > 0):
            kfs.append({"t": c, "sid": None, "wide": True, "mode": "move" if i else "move"})
            since_wide = 0; last = None
            continue
        strong = len(beat_t) and strength[np.argmin(np.abs(beat_t - c))] > np.percentile(strength, 70)
        kfs.append({"t": c, "sid": subs[best]["id"], "fov": framings[i % len(framings)],
                    "mode": "cut" if (strong and i % 2 == 0) else "move"})
        last = best; since_wide += 1
    progress(1.0)
    return {"bpm": round(bpm, 1), "kfs": kfs, "activity": np.round(act, 2).tolist()}

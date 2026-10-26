"""Allinea un audio esterno (mix dello studio, registratore) all'audio della camera.

Correlazione incrociata degli inviluppi (robusta a microfoni e mix diversi), poi rifinitura
sul segnale a 8 kHz attorno al picco. Ritorna offset tale che: tempo_esterno = tempo_video + offset.
"""
import subprocess
import numpy as np


def load(path, rate):
    p = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-map", "0:a:0", "-ac", "1", "-ar", str(rate),
                        "-f", "f32le", "-"], capture_output=True)
    return np.frombuffer(p.stdout, np.float32)


def envelope(x, rate, out_rate=200):
    # passa-alto grezzo (toglie il rimbombo) e inviluppo log
    x = np.diff(x, prepend=0)
    k = rate // out_rate
    n = len(x) // k
    e = np.sqrt((x[: n * k].reshape(n, k) ** 2).mean(1) + 1e-10)
    e = np.log(e)
    e = np.diff(e, prepend=e[0])  # attacchi
    e = np.maximum(e, 0)
    return (e - e.mean()) / (e.std() + 1e-9)


def xcorr(a, b):
    n = 1 << int(np.ceil(np.log2(len(a) + len(b))))
    c = np.fft.irfft(np.fft.rfft(a, n) * np.conj(np.fft.rfft(b, n)), n)
    return np.concatenate([c[-(len(b) - 1):], c[: len(a)]])  # lag da -(len(b)-1) a len(a)-1


def find_offset(video, ext, max_minutes=30):
    R = 8000
    v = load(video, R)[: R * 60 * max_minutes]
    e = load(ext, R)[: R * 60 * max_minutes]
    if len(v) < R or len(e) < R:
        raise RuntimeError("audio troppo corto o assente")
    ER = 200
    ev, ee = envelope(v, R, ER), envelope(e, R, ER)
    c = xcorr(ee, ev)  # picco a lag L: ee[i + L] ≈ ev[i]
    lags = np.arange(-(len(ev) - 1), len(ee))
    k = int(np.argmax(c))
    lag = lags[k] / ER
    conf = float((c[k] - np.median(c)) / (np.std(c) + 1e-9))
    # rifinitura a 8 kHz in ±30 ms
    s = int(lag * R)
    win = R * 20
    i0 = max(0, -s) + R
    a = v[i0: i0 + win]
    best, bl = -1e18, s
    seg_e = e
    for d in range(-240, 241, 2):
        j = i0 + s + d
        if j < 0 or j + len(a) > len(seg_e):
            continue
        val = float(np.dot(a, seg_e[j: j + len(a)]))
        if val > best:
            best, bl = val, s + d
    return round(bl / R, 4), round(conf, 1)


if __name__ == "__main__":
    import sys
    print(find_offset(sys.argv[1], sys.argv[2]))

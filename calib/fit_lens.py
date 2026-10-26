"""Stima il modello delle lenti X5 confrontando la zona di sovrapposizione dei due fisheye."""
import glob, json, sys
import numpy as np, cv2, warnings
warnings.filterwarnings('ignore')
from scipy.optimize import minimize

S = 0.5  # lavoriamo a metà risoluzione
pairs = []
for a in sorted(glob.glob('calib/a_*.png')):
    A = cv2.imread(a, cv2.IMREAD_GRAYSCALE); B = cv2.imread(a.replace('/a_', '/b_'), cv2.IMREAD_GRAYSCALE)
    A, B = [cv2.resize(x, None, fx=S, fy=S, interpolation=cv2.INTER_AREA).astype(np.float32) for x in (A, B)]
    hp = lambda x: cv2.GaussianBlur(x, (0, 0), 1.2) - cv2.GaussianBlur(x, (0, 0), 12)
    pairs.append((hp(A), hp(B)))
N = pairs[0][0].shape[0]

# direzioni campione nella fascia di sovrapposizione (theta dal'asse dell'obiettivo frontale)
th = np.radians(np.linspace(80, 100, 41)); ph = np.radians(np.arange(0, 360, 0.25))
TH, PH = np.meshgrid(th, ph)
D = np.stack([np.sin(TH) * np.cos(PH), np.sin(TH) * np.sin(PH), np.cos(TH)], -1).reshape(-1, 3)  # x destra, y alto, z avanti


def rot(yaw, pitch, roll):
    cy, sy, cp, sp, cr, sr = np.cos(yaw), np.sin(yaw), np.cos(pitch), np.sin(pitch), np.cos(roll), np.sin(roll)
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]]); Rx = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]])
    Rz = np.array([[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]])
    return Ry @ Rx @ Rz


def project(d, cx, cy, f1, f3, f5):
    """d in coordinate dell'obiettivo (z = asse ottico). Ritorna pixel (scala piena 3840)."""
    t = np.arccos(np.clip(d[:, 2], -1, 1))
    r = f1 * t + f3 * t ** 3 + f5 * t ** 5
    rxy = np.hypot(d[:, 0], d[:, 1]) + 1e-9
    return cx + r * d[:, 0] / rxy, cy - r * d[:, 1] / rxy


FLIP = np.diag([-1, 1, -1])  # obiettivo posteriore: guarda verso -z, destra = -x


def unpack(p):
    cxa, cya, cxb, cyb, ya, pa, ra, yb, pb, rb, f1, f3, f5 = p
    return dict(a=dict(cx=1920 + cxa, cy=1920 + cya, R=rot(*np.radians([ya, pa, ra]))),
                b=dict(cx=1920 + cxb, cy=1920 + cyb, R=rot(*np.radians([yb, pb, rb]))), f=(f1 * 1000, f3 * 100, f5 * 10))


def sample(img, u, v):
    n = len(u); pad = (-n) % 1024
    mx = np.r_[u * S, np.full(pad, -10)].astype(np.float32).reshape(-1, 1024)
    my = np.r_[v * S, np.full(pad, -10)].astype(np.float32).reshape(-1, 1024)
    return cv2.remap(img, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=np.nan).ravel()[:n]


def loss(p, verbose=False):
    m = unpack(p)
    da = D @ m['a']['R']            # mondo -> obiettivo A (R: obiettivo->mondo)
    db = (D @ m['b']['R']) @ FLIP
    ua, va = project(da, m['a']['cx'], m['a']['cy'], *m['f'])
    ub, vb = project(db, m['b']['cx'], m['b']['cy'], *m['f'])
    ok = (np.hypot(ua - 1920, va - 1920) < 1890) & (np.hypot(ub - 1920, vb - 1920) < 1890)
    if ok.mean() < 0.15:
        return 1e3
    errs = []
    for A, B in pairs:
        e = np.abs(sample(A, ua[ok], va[ok]) - sample(B, ub[ok], vb[ok]))
        e = e[np.isfinite(e)]
        errs.append(np.mean(np.sort(e)[: int(len(e) * 0.7)]))
    if verbose:
        print('copertura', round(ok.mean(), 3), 'errori', np.round(errs, 3))
    return float(np.mean(errs))


p0 = np.array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1.92 / 1.745, 0, 0])
# 1) solo f1 (equidistante) a griglia
best = min((loss(np.r_[p0[:10], f, 0, 0]), f) for f in np.linspace(1.0, 1.3, 31))
print('equidistante migliore f1=', best)
p = np.r_[p0[:10], best[1], 0, 0]
loss(p, True)
FREE = [0, 1, 2, 3, 7, 8, 9, 10, 11, 12]
def lf(q):
    pp = p.copy(); pp[FREE] = q; return loss(pp)
for it in range(3):
    r = minimize(lf, p[FREE], method='Powell', options=dict(maxiter=6000, xtol=1e-3, ftol=1e-6))
    p[FREE] = r.x; print(it, r.fun, np.round(p, 4), flush=True)
loss(p, True)
json.dump(unpack_p := p.tolist(), open('calib/lens_fit.json', 'w'))

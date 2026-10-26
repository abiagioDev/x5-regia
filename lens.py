"""Modello lenti X5 (stimato dalla sovrapposizione dei due fisheye) e rendering con cucitura sfumata.

Coordinate: x destra, y alto, z avanti (obiettivo frontale). Il posteriore guarda verso -z.
Le stesse formule sono replicate nello shader di web/app.js.
"""
import math
import numpy as np, cv2

# valori stimati su X5 (calib/fit_lens.py); pixel riferiti al fotogramma 3840x3840 di ciascun obiettivo
DEFAULT = {
    "size": 3840,
    "f1": 1140.8, "f3": 0.0, "f5": -0.04,           # r = f1·θ + f3·θ³ + f5·θ⁵ (θ in radianti)
    "a": {"cx": 1919.58, "cy": 1920.29, "ypr": [0, 0, 0]},
    "b": {"cx": 1918.79, "cy": 1914.02, "ypr": [-0.2212, 0.1693, 0.3824]},
    "seam": 4.0,                                     # semi-larghezza della sfumatura in gradi
    "edge": 1890,                                    # raggio utile del cerchio (px)
}


def rot(yaw, pitch, roll):
    yaw, pitch, roll = map(math.radians, (yaw, pitch, roll))
    cy, sy, cp, sp, cr, sr = math.cos(yaw), math.sin(yaw), math.cos(pitch), math.sin(pitch), math.cos(roll), math.sin(roll)
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]]); Rx = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]])
    Rz = np.array([[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]])
    return Ry @ Rx @ Rz


FLIP = np.diag([-1.0, 1.0, -1.0])


def lens_matrices(L):
    """Matrici camera -> coordinate obiettivo, per vettori riga: d_lens = d @ M.
    "a" = primo stream video, "b" = secondo. Il fronte della camera (asse del giroscopio) è "b",
    quindi la camera è ruotata di 180° rispetto al sistema in cui è stato fatto il fit."""
    return FLIP @ rot(*L["a"]["ypr"]), FLIP @ rot(*L["b"]["ypr"]) @ FLIP


def shader_params(L):
    Ma, Mb = lens_matrices(L)
    return {"Ma": Ma.ravel().tolist(), "Mb": Mb.ravel().tolist(), "ca": [L["a"]["cx"], L["a"]["cy"]],
            "cb": [L["b"]["cx"], L["b"]["cy"]], "f": [L["f1"], L["f3"], L["f5"]], "size": L["size"], "seam": L["seam"]}


def maps_for_dirs(d, L, scale=1.0):
    """d: (H,W,3) float32 direzioni in coordinate camera. Ritorna mappe e pesi per i due obiettivi."""
    Ma, Mb = lens_matrices(L)
    out = []
    thetas = []
    f1, f3, f5 = (np.float32(L[k]) for k in ("f1", "f3", "f5"))
    for M, P in ((Ma, L["a"]), (Mb, L["b"])):
        dl = cv2.transform(d, M.T.astype(np.float32))  # = d @ M
        x, y, z = cv2.split(dl)
        rxy, _ = cv2.cartToPolar(x, y)
        _, t = cv2.cartToPolar(z, rxy)  # angolo dall'asse ottico, 0..π
        t2 = t * t
        r = t * (f1 + t2 * (f3 + t2 * f5))
        k = r / (rxy + np.float32(1e-9)) * np.float32(scale)
        mx = k * x; mx += np.float32(P["cx"] * scale)
        my = k * y; np.subtract(np.float32(P["cy"] * scale), my, out=my)
        out.append((mx, my)); thetas.append(t)
    w = np.float32(np.radians(L["seam"]))
    s = np.clip((thetas[1] - thetas[0]) / (2 * w) + np.float32(0.5), 0, 1)
    wa = s * s * (np.float32(3) - 2 * s)
    return out[0], out[1], wa


def equirect_dirs(W, H):
    lon = (np.arange(W, dtype=np.float32) + 0.5) / W * 2 * np.pi - np.pi
    lat = np.pi / 2 - (np.arange(H, dtype=np.float32) + 0.5) / H * np.pi
    LON, LAT = np.meshgrid(lon, lat)
    return np.stack([np.sin(LON) * np.cos(LAT), np.sin(LAT), np.cos(LON) * np.cos(LAT)], -1).astype(np.float32)


def blend(imgA, imgB, ma, mb, wa):
    A = cv2.remap(imgA, ma[0], ma[1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE).astype(np.float32)
    B = cv2.remap(imgB, mb[0], mb[1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE).astype(np.float32)
    w = wa[..., None] if A.ndim == 3 else wa
    return (A * w + B * (1 - w)).astype(np.uint8)

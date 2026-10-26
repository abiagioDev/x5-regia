"""Trova le persone in tutta la sfera a un dato frame (Apple Vision).

Renderizza 8 viste prospettiche attorno all'orizzonte più una verso il basso, rileva le persone
(figura intera) in ciascuna e unisce i doppioni. Uscita: [{yaw, pitch, w, h, conf}] nel mondo stabilizzato.
"""
import json, math, subprocess, sys
import numpy as np
import moderngl
import Quartz, Vision
from tracker import FS, VS, AXIS_MAPS, CROP, dir_of, yaw_pitch, view_matrix, quat_mat


def detect_people(cg):
    req = Vision.VNDetectHumanRectanglesRequest.alloc().init()
    try:
        req.setUpperBodyOnly_(False)
    except Exception:
        pass
    h = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cg, None)
    ok, _ = h.performRequests_error_([req], None)
    out = []
    for r in (req.results() or []) if ok else []:
        b = r.boundingBox()
        out.append((b.origin.x, b.origin.y, b.size.width, b.size.height, float(r.confidence())))
    return out


class Renderer:
    def __init__(self, J):
        meta, st = J["meta"], J["settings"]
        self.fps = meta["fps"]
        self.orient = json.load(open(J["orient"])) if st.get("stab", True) else None
        self.M = AXIS_MAPS[st.get("axis", 0)]
        self.off = st.get("gyroOffset", 0) / 1000
        ctx = self.ctx = moderngl.create_standalone_context()
        self.prog = prog = ctx.program(vertex_shader=VS, fragment_shader=FS)
        self.vao = ctx.vertex_array(prog, [(ctx.buffer(np.array([-1, -1, 1, -1, -1, 1, 1, 1], "f4").tobytes()), "2f", "p")])
        sp = meta["shader"]
        prog["Ma"].write(np.array(sp["Ma"], "f4").tobytes()); prog["Mb"].write(np.array(sp["Mb"], "f4").tobytes())
        prog["ca"].value = tuple(sp["ca"]); prog["cb"].value = tuple(sp["cb"]); prog["fk"].value = tuple(sp["f"])
        prog["size"].value = float(sp["size"]); prog["seam"].value = math.radians(sp["seam"])
        self.W, self.H = J["proxy_w"], J["proxy_h"]
        self.tex = ctx.texture((self.W, self.H), 3, dtype="f1"); self.tex.filter = (moderngl.LINEAR, moderngl.LINEAR)
        self.fb = ctx.simple_framebuffer((CROP, CROP), components=4, dtype="f1")
        self.cs = Quartz.CGColorSpaceCreateDeviceRGB()

    def cam(self, i):
        if not self.orient:
            return np.eye(3)
        k = min(max(round(i + self.off * self.fps), 0), len(self.orient) - 1)
        return self.M @ quat_mat(self.orient[k]) @ self.M.T

    def load(self, frame_bytes):
        self.tex.write(frame_bytes)

    def view(self, i, center, fov):
        th = math.tan(math.radians(fov) / 2)
        R = self.cam(i).T @ view_matrix(center)
        self.prog["rot"].write(R.T.astype("f4").copy().tobytes()); self.prog["th"].value = th
        self.fb.use(); self.tex.use(0); self.vao.render(moderngl.TRIANGLE_STRIP)
        data = self.fb.read(components=4, alignment=1)
        prov = Quartz.CGDataProviderCreateWithData(None, data, len(data), None)
        return Quartz.CGImageCreate(CROP, CROP, 8, 32, CROP * 4, self.cs, Quartz.kCGImageAlphaNoneSkipLast, prov,
                                    None, False, Quartz.kCGRenderingIntentDefault), th


def box_to_world(center, th, b):
    cx = (b[0] + b[2] / 2) * 2 - 1; cy = (b[1] + b[3] / 2) * 2 - 1
    dv = np.array([cx * th, cy * th, 1.0])
    d = view_matrix(center) @ (dv / np.linalg.norm(dv))
    return d, math.degrees(2 * math.atan(b[2] * th)), math.degrees(2 * math.atan(b[3] * th))


def main(job_file):
    J = json.load(open(job_file))
    R = Renderer(J)
    f = J["frame"]
    p = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{f / R.fps:.6f}", "-i", J["proxy"], "-frames:v", "1",
                        "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True)
    R.load(p.stdout)
    found = []
    views = [(y, -12, 100) for y in range(0, 360, 45)] + [(0, -70, 120), (0, 50, 110)]
    for k, (yaw, pitch, fov) in enumerate(views):
        c = dir_of(yaw, pitch)
        img, th = R.view(f, c, fov)
        for b in detect_people(img):
            if b[4] < 0.2 or b[3] < 0.04:
                continue
            # scarta riquadri tagliati dal bordo della vista: li vedrà meglio una vista vicina
            edge = min(b[0], b[1], 1 - b[0] - b[2], 1 - b[1] - b[3])
            d, w, h = box_to_world(c, th, b)
            found.append({"d": d, "w": w, "h": h, "conf": b[4], "edge": edge})
        print(k + 1, len(views), flush=True)
    # unisci i doppioni (stessa persona vista da due viste): tieni quello più lontano dal bordo
    found.sort(key=lambda x: (-x["edge"], -x["conf"]))
    people = []
    for x in found:
        if any(math.degrees(math.acos(min(1, float(np.dot(x["d"], y["d"]))))) < 0.45 * max(y["h"], x["h"]) for y in people):
            continue
        people.append(x)
    out = []
    for x in people:
        yaw, pitch = yaw_pitch(x["d"])
        out.append({"yaw": round(yaw, 2), "pitch": round(pitch, 2), "w": round(x["w"], 2), "h": round(x["h"], 2),
                    "conf": round(x["conf"], 2)})
    out.sort(key=lambda p: p["yaw"])
    json.dump({"frame": f, "people": out}, open(J["output"], "w"))
    print("done", len(out), flush=True)


if __name__ == "__main__":
    main(sys.argv[1])

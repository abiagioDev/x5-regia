"""Tracking di una persona/oggetto nel video 360 con Apple Vision.

Si segue il soggetto in una vista prospettica (ricavata dalla copia leggera con lo stesso modello
delle lenti) puntata nella sua direzione nel mondo stabilizzato: così non contano le giunte né la
deformazione dell'equirettangolare. Quando il soggetto si allontana dal centro la vista si ri-centra.
Uscita: per frame [yaw, pitch, larghezza°, altezza°, confidenza] in coordinate mondo.
"""
import json, math, subprocess, sys
import numpy as np
import moderngl
import Quartz, Vision
import lens

CROP = 384
FS = """#version 330
uniform sampler2D tex; uniform mat3 rot; uniform float th;
uniform mat3 Ma, Mb; uniform vec2 ca, cb; uniform vec3 fk; uniform float size, seam;
out vec4 o;
vec2 lensUV(vec3 d, vec2 c, out float t) {
  float rxy = length(d.xy); t = atan(rxy, d.z);
  float t2 = t * t, r = t * (fk.x + t2 * (fk.y + t2 * fk.z));
  return clamp((c + vec2(d.x, -d.y) * (r / max(rxy, 1e-6))) / size, 0., 1.);
}
void main() {
  vec2 uv = vec2(gl_FragCoord.x / %d. * 2. - 1., 1. - gl_FragCoord.y / %d. * 2.);
  vec3 d = normalize(rot * vec3(uv.x * th, uv.y * th, 1.));
  float ta, tb;
  vec2 pa = lensUV(Ma * d, ca, ta), pb = lensUV(Mb * d, cb, tb);
  vec4 A = texture(tex, vec2(pa.x * 0.5, pa.y)), B = texture(tex, vec2(0.5 + pb.x * 0.5, pb.y));
  float s = clamp((tb - ta) / (2. * seam) + 0.5, 0., 1.);
  o = vec4(mix(B, A, s * s * (3. - 2. * s)).rgb, 1.);
}""" % (CROP, CROP)
VS = "#version 330\nin vec2 p; void main(){ gl_Position = vec4(p, 0., 1.); }"
AXIS_MAPS = [np.array(m, float) for m in (
    [[0, 0, 1], [0, 1, 0], [1, 0, 0]], [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
    [[0, 0, 1], [0, 1, 0], [-1, 0, 0]], [[0, 0, -1], [0, 1, 0], [-1, 0, 0]])]


def dir_of(yaw, pitch):
    y, p = math.radians(yaw), math.radians(pitch)
    return np.array([math.sin(y) * math.cos(p), math.sin(p), math.cos(y) * math.cos(p)])


def yaw_pitch(d):
    d = d / np.linalg.norm(d)
    return math.degrees(math.atan2(d[0], d[2])), math.degrees(math.asin(max(-1, min(1, d[1]))))


def view_matrix(f):  # colonne: destra, alto, avanti (come viewMatrix in app.js)
    f = f / np.linalg.norm(f)
    r = np.cross([0, 1, 0], f); r = r / (np.linalg.norm(r) or 1)
    return np.stack([r, np.cross(f, r), f], 1)


def quat_mat(q):
    w, x, y, z = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
                     [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
                     [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]])


def main(job_file):
    J = json.load(open(job_file))
    meta, st = J["meta"], J["settings"]
    fps, nframes = meta["fps"], meta["nframes"]
    orient = json.load(open(J["orient"])) if J.get("orient") and st.get("stab", True) else None
    M = AXIS_MAPS[st.get("axis", 0)]

    def cam(i):  # camera -> mondo
        if not orient:
            return np.eye(3)
        k = min(max(round(i + st.get("gyroOffset", 0) / 1000 * fps), 0), len(orient) - 1)
        return M @ quat_mat(orient[k]) @ M.T

    ctx = moderngl.create_standalone_context()
    prog = ctx.program(vertex_shader=VS, fragment_shader=FS)
    vao = ctx.vertex_array(prog, [(ctx.buffer(np.array([-1, -1, 1, -1, -1, 1, 1, 1], "f4").tobytes()), "2f", "p")])
    sp = meta["shader"]
    prog["Ma"].write(np.array(sp["Ma"], "f4").tobytes()); prog["Mb"].write(np.array(sp["Mb"], "f4").tobytes())
    prog["ca"].value = tuple(sp["ca"]); prog["cb"].value = tuple(sp["cb"]); prog["fk"].value = tuple(sp["f"])
    prog["size"].value = float(sp["size"]); prog["seam"].value = math.radians(sp["seam"])
    W, H = J["proxy_w"], J["proxy_h"]
    tex = ctx.texture((W, H), 3, dtype="f1"); tex.filter = (moderngl.LINEAR, moderngl.LINEAR)
    fb = ctx.simple_framebuffer((CROP, CROP), components=4, dtype="f1")
    cs = Quartz.CGColorSpaceCreateDeviceRGB()

    # vista di tracking: campo ~3 volte il soggetto
    size = max(J["w"], J["h"])
    F = min(110.0, max(24.0, size * 3.0))
    th = math.tan(math.radians(F) / 2)
    center = dir_of(J["yaw"], J["pitch"])
    bw = math.tan(math.radians(J["w"]) / 2) / th; bh = math.tan(math.radians(J["h"]) / 2) / th
    box = (0.5 - bw / 2, 0.5 - bh / 2, bw, bh)  # Vision: normalizzato, origine in basso a sinistra

    handler = Vision.VNSequenceRequestHandler.alloc().init()

    def new_request(b):
        obs = Vision.VNDetectedObjectObservation.observationWithBoundingBox_(Quartz.CGRectMake(*b))
        req = Vision.VNTrackObjectRequest.alloc().initWithDetectedObjectObservation_(obs)
        req.setTrackingLevel_(Vision.VNRequestTrackingLevelAccurate)
        return req
    req = new_request(box)

    def render(frame_bytes, i):
        tex.write(frame_bytes)
        R = cam(i).T @ view_matrix(center)  # vista -> camera
        prog["rot"].write(R.T.astype("f4").copy().tobytes()); prog["th"].value = th
        fb.use(); tex.use(0); vao.render(moderngl.TRIANGLE_STRIP)
        data = fb.read(components=4, alignment=1)
        prov = Quartz.CGDataProviderCreateWithData(None, data, len(data), None)
        return Quartz.CGImageCreate(CROP, CROP, 8, 32, CROP * 4, cs, Quartz.kCGImageAlphaNoneSkipLast, prov,
                                    None, False, Quartz.kCGRenderingIntentDefault)

    step = 1 if J["dir"] >= 0 else -1
    f0 = J["frame"]
    last = (nframes - 1) if step > 0 else 0
    limit = min(abs(last - f0) + 1, J.get("max_frames", 10 ** 9))
    fsz = W * H * 3

    def frames():
        if step > 0:
            p = subprocess.Popen(["ffmpeg", "-v", "error", "-ss", f"{f0 / fps:.6f}", "-i", J["proxy"],
                                  "-frames:v", str(limit), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                                 stdout=subprocess.PIPE, bufsize=1 << 25)
            for k in range(limit):
                b = p.stdout.read(fsz)
                if len(b) < fsz:
                    break
                yield f0 + k, b
            p.kill()
        else:  # all'indietro: blocchi decodificati in avanti e letti al contrario
            end = f0 + 1
            stop = f0 - limit + 1
            while end > stop:
                s = max(stop, end - 45)
                p = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{s / fps:.6f}", "-i", J["proxy"],
                                    "-frames:v", str(end - s), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                                   capture_output=True)
                buf = p.stdout
                cnt = len(buf) // fsz
                for k in range(cnt - 1, -1, -1):
                    yield s + k, buf[k * fsz:(k + 1) * fsz]
                end = s

    out = {}
    weak = 0
    for n, (i, b) in enumerate(frames()):
        img = render(b, i)
        if n == 0:
            res = box; conf = 1.0
        else:
            ok, err = handler.performRequests_onCGImage_error_([req], img, None)
            r = req.results()[0] if ok and req.results() else None
            if r is None:
                break
            req.setInputObservation_(r)
            bb = r.boundingBox(); res = (bb.origin.x, bb.origin.y, bb.size.width, bb.size.height)
            conf = float(r.confidence())
        cx = (res[0] + res[2] / 2) * 2 - 1; cy = (res[1] + res[3] / 2) * 2 - 1
        dview = np.array([cx * th, cy * th, 1.0])
        d = view_matrix(center) @ (dview / np.linalg.norm(dview))
        yaw, pitch = yaw_pitch(d)
        wdeg = math.degrees(2 * math.atan(res[2] * th)); hdeg = math.degrees(2 * math.atan(res[3] * th))
        weak = weak + 1 if conf < 0.3 else 0
        if weak > 6:
            break
        out[i] = [round(yaw, 3), round(pitch, 3), round(wdeg, 2), round(hdeg, 2), round(conf, 2)]
        if abs(cx) > 0.2 or abs(cy) > 0.2:  # ri-centra la vista e riparte dal riquadro attuale
            center = d
            req = new_request((0.5 - res[2] / 2, 0.5 - res[3] / 2, res[2], res[3]))
            handler = Vision.VNSequenceRequestHandler.alloc().init()
        if n % 10 == 0:
            print(n, limit, flush=True)
        if J.get("debug") and n % 60 == 0:
            import cv2
            a = np.frombuffer(fb.read(components=4, alignment=1), np.uint8).reshape(CROP, CROP, 4)[..., :3][..., ::-1].copy()
            x0, y0 = int(res[0] * CROP), int((1 - res[1] - res[3]) * CROP)
            cv2.rectangle(a, (x0, y0), (x0 + int(res[2] * CROP), y0 + int(res[3] * CROP)), (0, 0, 255), 2)
            cv2.imwrite(f"{J['debug']}/trk_{n:05d}.jpg", a)
    keys = sorted(out)
    json.dump({"f0": keys[0] if keys else f0, "pts": [out[k] for k in keys]}, open(J["output"], "w"))
    print("done", len(keys), flush=True)


if __name__ == "__main__":
    main(sys.argv[1])

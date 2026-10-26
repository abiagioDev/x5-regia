"""Render di un pezzo di export: ffmpeg decodifica i due obiettivi a piena risoluzione, la GPU cuce,
inquadra e corregge il colore con lo stesso shader dell'anteprima (web/core.glsl), ffmpeg ricodifica."""
import json, math, subprocess, sys
from pathlib import Path
import numpy as np
import moderngl
import lens

ROOT = Path(__file__).resolve().parent
CORE = (ROOT / "web" / "core.glsl").read_text()
FS = """#version 330
uniform sampler2D texY, texU, texV;
uniform mat3 rot; uniform float hf, projK; uniform vec2 asp, res;
out vec4 o;
""" + CORE + """
vec3 yuv(vec2 p) { // BT.709 a range pieno (come i file X5)
  float y = texture(texY, p).r, u = texture(texU, p).r - 0.5, v = texture(texV, p).r - 0.5;
  return vec3(y + 1.5748 * v, y - 0.1873 * u - 0.4681 * v, y + 1.8556 * u);
}
vec3 fetchA(vec2 p) { return yuv(vec2(p.x * 0.5, p.y)); }
vec3 fetchB(vec2 p) { return yuv(vec2(0.5 + p.x * 0.5, p.y)); }
void main() {
  vec2 uv = vec2(gl_FragCoord.x / res.x * 2. - 1., 1. - gl_FragCoord.y / res.y * 2.);  // riga 0 = alto
  vec3 d = normalize(rot * viewRay(uv, hf, asp, projK));
  o = vec4(gradeColor(sampleSphere(d)), 1.);
}"""
VS = "#version 330\nin vec2 p; void main(){ gl_Position = vec4(p, 0., 1.); }"


def load_cube(path):
    size, data = 0, []
    for line in Path(path).read_text().splitlines():
        t = line.strip().split()
        if not t or t[0].startswith("#"):
            continue
        if t[0] == "LUT_3D_SIZE":
            size = int(t[1])
        elif len(t) == 3:
            try:
                data.append([float(x) for x in t])
            except ValueError:
                pass
    return size, np.array(data, "f4")


def setup(ctx, prog, L, grade):
    sp = lens.shader_params(L)
    prog["Ma"].write(np.array(sp["Ma"], "f4").tobytes()); prog["Mb"].write(np.array(sp["Mb"], "f4").tobytes())
    prog["ca"].value = tuple(sp["ca"]); prog["cb"].value = tuple(sp["cb"]); prog["fk"].value = tuple(sp["f"])
    prog["size"].value = float(sp["size"]); prog["seam"].value = math.radians(sp["seam"])
    prog["baseline"].value = float(sp.get("baseline", 0.03))
    g = grade or {}
    prog["gainA"].value = tuple(g.get("gainA", sp.get("gainA", [1, 1, 1])))
    prog["gainB"].value = tuple(g.get("gainB", sp.get("gainB", [1, 1, 1])))
    lut_mix, size = float(g.get("lutMix", 0)), 2
    tex3 = None
    if g.get("lut") and lut_mix > 0:
        size, data = load_cube(ROOT / "data" / "luts" / Path(g["lut"]).name)
        tex3 = ctx.texture3d((size, size, size), 3, data.tobytes(), dtype="f4")
    else:
        tex3 = ctx.texture3d((2, 2, 2), 3, np.zeros(24, "f4").tobytes(), dtype="f4")
        lut_mix = 0
    tex3.filter = (moderngl.LINEAR, moderngl.LINEAR)
    prog["lutSize"].value = float(size)
    prog["grade1"].value = (float(g.get("exposure", 0)), float(g.get("contrast", 1)), float(g.get("saturation", 1)), lut_mix)
    prog["grade2"].value = (float(g.get("temperature", 0)), float(g.get("tint", 0)))
    return tex3


def main(job_file):
    J = json.load(open(job_file))
    L, W, H = J["lens"], J["width"], J["height"]
    S = L["size"]
    frames = J["frames"]  # [[R vista->camera 3x3 per righe], fov lato lungo, proiezione 0..1, distanza cucitura]
    src = J.get("src")  # frame sorgente (relativi alla clip) per ogni frame d'uscita: rallentatori/accelerazioni
    n = len(frames)
    need = (src[-1] - src[0] + 1) if src else n
    start = src[0] / J["fps"] if src else J["start"]
    dec = subprocess.Popen(["ffmpeg", "-v", "error", "-hwaccel", "videotoolbox", "-ss", f"{start:.6f}",
                            "-i", J["input"], "-filter_complex", "[0:v:0][0:v:1]hstack,format=yuv420p[v]",
                            "-map", "[v]", "-frames:v", str(need), "-f", "rawvideo", "-"], stdout=subprocess.PIPE,
                           bufsize=1 << 26)
    enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba",
                            "-s", f"{W}x{H}", "-r", J["rate"], "-i", "-",
                            "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=" +
                            ("yuv422p10le" if "prores_videotoolbox" in J["codec_args"] else "yuv420p"),
                            "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
                            "-color_range", "tv", *J["codec_args"], J["output"]], stdin=subprocess.PIPE)

    ctx = moderngl.create_standalone_context()
    prog = ctx.program(vertex_shader=VS, fragment_shader=FS)
    vao = ctx.vertex_array(prog, [(ctx.buffer(np.array([-1, -1, 1, -1, -1, 1, 1, 1], "f4").tobytes()), "2f", "p")])
    tex3 = setup(ctx, prog, L, J.get("grade"))
    texY = ctx.texture((2 * S, S), 1, dtype="f1"); texU = ctx.texture((S, S // 2), 1, dtype="f1")
    texV = ctx.texture((S, S // 2), 1, dtype="f1")
    for t in (texY, texU, texV):
        t.filter = (moderngl.LINEAR, moderngl.LINEAR); t.repeat_x = t.repeat_y = False
    texY.use(0); texU.use(1); texV.use(2); tex3.use(3)
    prog["texY"].value, prog["texU"].value, prog["texV"].value, prog["lut"].value = 0, 1, 2, 3
    fb = ctx.simple_framebuffer((W, H), components=4, dtype="f1")
    prog["res"].value = (float(W), float(H))
    a = W / H
    prog["asp"].value = (1.0, 1 / a) if a >= 1 else (a, 1.0)

    ysz, csz = 2 * S * S, S * S // 2
    have = -1  # indice dell'ultimo frame sorgente caricato
    base = src[0] if src else 0
    for i in range(n):
        want = (src[i] - base) if src else i
        while have < want:
            buf = dec.stdout.read(ysz + 2 * csz)
            if len(buf) < ysz + 2 * csz:
                break
            have += 1
            if have == want:
                mv = memoryview(buf)
                texY.write(mv[:ysz]); texU.write(mv[ysz:ysz + csz]); texV.write(mv[ysz + csz:])
        if have < want:
            break
        fr = frames[i]
        R = np.array(fr[0], "f4").reshape(3, 3)
        prog["rot"].write(R.T.copy().tobytes())  # GLSL è per colonne
        prog["hf"].value = math.radians(fr[1]) / 2
        prog["projK"].value = float(fr[2]) if len(fr) > 2 else 0.0
        prog["stitchD"].value = float(fr[3]) if len(fr) > 3 else 0.0
        fb.use(); vao.render(moderngl.TRIANGLE_STRIP)
        enc.stdin.write(fb.read(components=4, alignment=1))
        print(i + 1, flush=True)
    enc.stdin.close(); enc.wait(); dec.kill()
    sys.exit(enc.returncode)


if __name__ == "__main__":
    main(sys.argv[1])

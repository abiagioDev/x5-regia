"""Render dell'export: ffmpeg decodifica i due obiettivi a piena risoluzione, la GPU cuce e
inquadra ogni frame con lo stesso shader dell'anteprima (web/app.js), ffmpeg ricodifica."""
import json, subprocess, sys
import numpy as np
import moderngl
import lens

FS = """#version 330
uniform sampler2D tex; uniform mat3 rot; uniform vec2 th; uniform vec2 res;
uniform mat3 Ma, Mb; uniform vec2 ca, cb; uniform vec3 fk; uniform float size, seam;
out float o;
vec2 lensUV(vec3 d, vec2 c, out float t) {
  float rxy = length(d.xy); t = atan(rxy, d.z);
  float t2 = t * t, r = t * (fk.x + t2 * (fk.y + t2 * fk.z));
  return clamp((c + vec2(d.x, -d.y) * (r / max(rxy, 1e-6))) / size, 0., 1.);
}
void main() {
  // riga 0 letta dal framebuffer = alto dell'immagine
  vec2 uv = vec2(gl_FragCoord.x / res.x * 2. - 1., 1. - gl_FragCoord.y / res.y * 2.);
  vec3 d = normalize(rot * vec3(uv.x * th.x, uv.y * th.y, 1.));
  float ta, tb;
  vec2 pa = lensUV(Ma * d, ca, ta), pb = lensUV(Mb * d, cb, tb);
  float A = texture(tex, vec2(pa.x * 0.5, pa.y)).r, B = texture(tex, vec2(0.5 + pb.x * 0.5, pb.y)).r;
  float s = clamp((tb - ta) / (2. * seam) + 0.5, 0., 1.);
  o = mix(B, A, s * s * (3. - 2. * s));
}"""
VS = "#version 330\nin vec2 p; void main(){ gl_Position = vec4(p, 0., 1.); }"


def main(job_file):
    J = json.load(open(job_file))
    L, W, H = J["lens"], J["width"], J["height"]
    S = L["size"]
    frames = J["frames"]  # [[R vista->camera 3x3 per righe], fov]
    n = len(frames)
    dec = subprocess.Popen(["ffmpeg", "-v", "error", "-hwaccel", "videotoolbox", "-ss", f"{J['start']:.6f}",
                            "-i", J["input"], "-filter_complex", "[0:v:0][0:v:1]hstack,format=yuv420p[v]",
                            "-map", "[v]", "-frames:v", str(n), "-f", "rawvideo", "-"], stdout=subprocess.PIPE,
                           bufsize=1 << 26)
    enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "yuv420p",
                            "-s", f"{W}x{H}", "-r", J["rate"], "-i", "-", *J["codec_args"], J["output"]],
                           stdin=subprocess.PIPE)

    ctx = moderngl.create_standalone_context()
    prog = ctx.program(vertex_shader=VS, fragment_shader=FS)
    vbo = ctx.buffer(np.array([-1, -1, 1, -1, -1, 1, 1, 1], "f4").tobytes())
    vao = ctx.vertex_array(prog, [(vbo, "2f", "p")])
    sp = lens.shader_params(L)
    prog["Ma"].write(np.array(sp["Ma"], "f4").tobytes())
    prog["Mb"].write(np.array(sp["Mb"], "f4").tobytes())
    prog["ca"].value = tuple(sp["ca"]); prog["cb"].value = tuple(sp["cb"])
    prog["fk"].value = tuple(sp["f"]); prog["size"].value = float(S)
    prog["seam"].value = float(np.radians(sp["seam"]))
    prog["tex"].value = 0
    texY = ctx.texture((2 * S, S), 1, dtype="f1"); texU = ctx.texture((S, S // 2), 1, dtype="f1")
    texV = ctx.texture((S, S // 2), 1, dtype="f1")
    for t in (texY, texU, texV):
        t.filter = (moderngl.LINEAR, moderngl.LINEAR); t.repeat_x = t.repeat_y = False
    fbY = ctx.simple_framebuffer((W, H), components=1, dtype="f1")
    fbU = ctx.simple_framebuffer((W // 2, H // 2), components=1, dtype="f1")
    fbV = ctx.simple_framebuffer((W // 2, H // 2), components=1, dtype="f1")

    ysz, csz = 2 * S * S, S * S // 2
    for i in range(n):
        buf = dec.stdout.read(ysz + 2 * csz)
        if len(buf) < ysz + 2 * csz:
            break
        mv = memoryview(buf)
        texY.write(mv[:ysz]); texU.write(mv[ysz:ysz + csz]); texV.write(mv[ysz + csz:])
        R = np.array(frames[i][0], "f4").reshape(3, 3)
        prog["rot"].write(R.T.copy().tobytes())  # GLSL è per colonne
        t = float(np.tan(np.radians(frames[i][1]) / 2))  # campo visivo sul lato lungo
        prog["th"].value = (t, t * H / W) if W >= H else (t * W / H, t)
        out = []
        for tex, fb in ((texY, fbY), (texU, fbU), (texV, fbV)):
            fb.use(); tex.use(0)
            prog["res"].value = tuple(map(float, fb.size))
            vao.render(moderngl.TRIANGLE_STRIP)
            out.append(fb.read(components=1, alignment=1))
        enc.stdin.write(b"".join(out))
        print(i + 1, flush=True)
    enc.stdin.close(); enc.wait(); dec.kill()
    sys.exit(enc.returncode)


if __name__ == "__main__":
    main(sys.argv[1])

'use strict';
// ===================== matematica =====================
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const mmul = (A, B) => A.map((r, i) => [0, 1, 2].map(j => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
const mT = A => [0, 1, 2].map(i => [0, 1, 2].map(j => A[j][i]));
const mv = (A, v) => A.map(r => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const norm = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
// coordinate: x destra, y alto, z avanti (obiettivo frontale = centro equirettangolare)
const dirOf = (yaw, pitch) => [Math.sin(yaw * D2R) * Math.cos(pitch * D2R), Math.sin(pitch * D2R), Math.cos(yaw * D2R) * Math.cos(pitch * D2R)];
const yawPitchOf = d => [Math.atan2(d[0], d[2]) * R2D, Math.asin(clamp(d[1], -1, 1)) * R2D];
function viewMatrix(dir) { // colonne: destra, alto, avanti (orizzonte sempre dritto)
  const f = norm(dir);
  let r = cross([0, 1, 0], f); if (Math.hypot(...r) < 1e-6) r = [1, 0, 0]; r = norm(r);
  const u = cross(f, r);
  return [[r[0], u[0], f[0]], [r[1], u[1], f[1]], [r[2], u[2], f[2]]];
}
function quatMat([w, x, y, z]) {
  return [[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
          [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
          [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]];
}
function slerpDir(a, b, t) {
  const c = clamp(dot(a, b), -1, 1), om = Math.acos(c);
  if (om < 1e-5) return b;
  const s = Math.sin(om);
  return norm([0, 1, 2].map(i => (Math.sin((1 - t) * om) * a[i] + Math.sin(t * om) * b[i]) / s));
}
// mappe assi IMU -> camera (E = M·S)
const AXIS_MAPS = [
  [[0, 0, 1], [0, 1, 0], [1, 0, 0]],
  [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  [[0, 0, 1], [0, 1, 0], [-1, 0, 0]],
  [[0, 0, -1], [0, 1, 0], [-1, 0, 0]],
];

// ===================== movimento di camera =====================
const FRAMINGS = { a: ['Stretto', 32], s: ['Medio', 52], d: ['Largo', 78], f: ['Totale', 110] };
const COLORS = ['#ff7a3d', '#3dd6c6', '#f5c542', '#b48cff', '#ff5d8f', '#6fd36f', '#5aa9ff', '#ffa8a8', '#c9e265'];
const MODES = { move: 'Movimento', glide: 'Scivola dal precedente', cut: 'Stacco' };
const minJerk = s => s * s * s * (10 - 15 * s + 6 * s * s);
// accelera un po' più deciso e "atterra" più lento, come un operatore
const ease = s => minJerk(Math.pow(clamp(s, 0, 1), 0.82));
const easeInOut = s => { s = clamp(s, 0, 1); return s < 0.5 ? 4 * s * s * s : 1 - Math.pow(-2 * s + 2, 3) / 2; };
const lerpFov = (a, b, e) => {
  const la = Math.log(Math.tan(a * D2R / 2)), lb = Math.log(Math.tan(b * D2R / 2));
  return 2 * Math.atan(Math.exp(la + (lb - la) * e)) * R2D;
};
const subjOf = id => id != null ? P.subjects.find(s => s.id === id) : null;
const subjColor = s => COLORS[Math.max(0, P.subjects.indexOf(s)) % COLORS.length];

// ---- percorsi dei soggetti (tracking) ----
// cache per soggetto: direzione levigata per frame + indice del frame tracciato più vicino (entro 3 s)
const pathCache = new Map();
function trkMap(s) { // {frame: [yaw,pitch,w,h,conf]}
  const m = new Map();
  (s.trk || []).forEach(r => r.pts.forEach((p, k) => m.set(r.f0 + k, p)));
  return m;
}
function setTrk(s, m) { // ri-codifica in intervalli contigui
  const keys = [...m.keys()].sort((a, b) => a - b), out = [];
  for (const k of keys) {
    const last = out[out.length - 1];
    if (last && last.f0 + last.pts.length === k) last.pts.push(m.get(k)); else out.push({ f0: k, pts: [m.get(k)] });
  }
  s.trk = out; pathCache.delete(s.id);
}
function subjPath(s) {
  let c = pathCache.get(s.id);
  if (c && c.follow === P.settings.follow) return c;
  const n = META.nframes, raw = new Float32Array(n * 3), have = new Uint8Array(n), size = new Float32Array(n * 2);
  trkMap(s).forEach((p, f) => {
    if (f < 0 || f >= n) return;
    const d = dirOf(p[0], p[1]); raw.set(d, f * 3); have[f] = 1; size[f * 2] = p[2]; size[f * 2 + 1] = p[3];
  });
  // levigatura gaussiana solo dentro gli intervalli tracciati
  const sig = Math.max(0.5, P.settings.follow * META.fps * 0.6), R = Math.ceil(sig * 2.5);
  const w = Array.from({ length: 2 * R + 1 }, (_, k) => Math.exp(-((k - R) ** 2) / (2 * sig * sig)));
  const dirs = new Float32Array(n * 3);
  for (let f = 0; f < n; f++) {
    if (!have[f]) continue;
    let x = 0, y = 0, z = 0;
    for (let k = -R; k <= R; k++) {
      const g = f + k; if (g < 0 || g >= n || !have[g]) continue;
      const ww = w[k + R]; x += raw[g * 3] * ww; y += raw[g * 3 + 1] * ww; z += raw[g * 3 + 2] * ww;
    }
    const d = norm([x, y, z]); dirs.set(d, f * 3);
  }
  const near = new Int32Array(n).fill(-1), lim = Math.round(3 * META.fps);
  let last = -1e9;
  for (let f = 0; f < n; f++) { if (have[f]) last = f; if (f - last <= lim) near[f] = last; }
  last = 1e9;
  for (let f = n - 1; f >= 0; f--) { if (have[f]) last = f; if (last - f <= lim && (near[f] < 0 || last - f < f - near[f])) near[f] = last; }
  c = { follow: P.settings.follow, dirs, near, size, have };
  pathCache.set(s.id, c);
  return c;
}
function frameOf(t) { return clamp(Math.round(t * META.fps), 0, META.nframes - 1); }
function subjDir(s, t) {
  if (META && s.trk && s.trk.length) {
    const c = subjPath(s), k = c.near[frameOf(t)];
    if (k >= 0) return [c.dirs[k * 3], c.dirs[k * 3 + 1], c.dirs[k * 3 + 2]];
  }
  return dirOf(s.yaw, s.pitch);
}
function subjSize(s, t) {
  if (META && s.trk && s.trk.length) {
    const c = subjPath(s), k = c.near[frameOf(t)];
    if (k >= 0) return [c.size[k * 2], c.size[k * 2 + 1], k === frameOf(t)];
  }
  return [s.w || 15, s.h || 25, false];
}

// ---- keyframe ----
function kfDir(kf, t) {
  const s = subjOf(kf.sid);
  if (s) {
    const [y, p] = yawPitchOf(subjDir(s, t));
    return dirOf(y + (kf.dy || 0), clamp(p + (kf.dp || 0), -89, 89));
  }
  return dirOf(kf.yaw, kf.pitch);
}
function autoDuration(angle, fa, fb) {
  const z = Math.abs(Math.log(Math.tan(fb * D2R / 2) / Math.tan(fa * D2R / 2)));
  return clamp(0.55 + 1.7 * Math.sqrt(angle / 180) + 0.9 * z, 0.6, 4) * P.settings.pace;
}
let segs = []; // per ogni keyframe: stato di partenza, durata del movimento
function rebuild(save = true) {
  P.kfs.sort((a, b) => a.t - b.t);
  segs = [];
  for (let i = 0; i < P.kfs.length; i++) {
    const kf = P.kfs[i];
    const sg = { t: kf.t, kf, i, dur: 0, angle: 0, breathe: 0 };
    segs.push(sg); // serve già per valutare il precedente
    const from = i ? evalSeg(i - 1, kf.t) : null;
    sg.from = from || { dir: kfDir(kf, kf.t), fov: kf.fov };
    const to = kfDir(kf, kf.t);
    sg.angle = Math.acos(clamp(dot(sg.from.dir, to), -1, 1)) * R2D;
    if (i && kf.mode === 'move') {
      sg.dur = kf.dur || autoDuration(sg.angle, sg.from.fov, kf.fov);
      sg.breathe = sg.angle > 25 ? Math.min(28, (sg.angle - 25) * 0.3) * P.settings.breathe * (kf.breathe ?? 1) : 0;
    }
  }
  if (save) scheduleSave();
}
function evalSeg(i, t) {
  const sg = segs[i], kf = sg.kf;
  let dir = kfDir(kf, t), fov = kf.fov, moving = false;
  if (sg.dur > 0 && t < sg.t + sg.dur) {
    const e = ease((t - sg.t) / sg.dur);
    dir = slerpDir(sg.from.dir, dir, e);
    fov = Math.min(120, lerpFov(sg.from.fov, kf.fov, e) + sg.breathe * Math.sin(Math.PI * e));
    moving = true;
  }
  const nx = P.kfs[i + 1];
  if (nx && nx.mode === 'glide' && nx.t > sg.t) { // il prossimo keyframe "tira" la camera per tutto l'intervallo
    const e = easeInOut((t - sg.t) / (nx.t - sg.t));
    dir = slerpDir(dir, kfDir(nx, t), e); fov = lerpFov(fov, nx.fov, e); moving = e > 0 && e < 1;
  }
  return { dir, fov, moving };
}
function viewAt(t) {
  if (!segs.length) return { dir: dirOf(P.free.yaw, P.free.pitch), fov: P.free.fov };
  const i = segIndex(t);
  return evalSeg(Math.max(0, i), t);
}
function segIndex(t) {
  let lo = 0, hi = segs.length - 1, r = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (segs[m].t <= t + 1e-6) { r = m; lo = m + 1; } else hi = m - 1; }
  return r;
}

// ===================== stato =====================
let META = null, ORIENT = null, FILE = null;
let P = blankProject();
function blankProject() {
  return { subjects: [], kfs: [], free: { yaw: 0, pitch: 0, fov: 78 },
    settings: { pace: 1, breathe: 1, follow: 0.5, showBoxes: true, stab: true, axis: 0, gyroOffset: 0 },
    format: { ratio: '16:9', cw: 16, ch: 9, res: 1080, codec: 'hevc', quality: 'alta', guide: '' } };
}
// ---- formato di uscita: il campo visivo (fov) è sempre misurato sul lato lungo ----
const RATIOS = { '16:9': [16, 9], '9:16': [9, 16], '1:1': [1, 1], '4:5': [4, 5], '4:3': [4, 3], '2.39:1': [2.39, 1], '3:2': [3, 2] };
function ratioOf(f = P.format) {
  const r = f.ratio === 'custom' ? [f.cw, f.ch] : RATIOS[f.ratio] || [16, 9];
  return clamp(r[0] / r[1], 0.25, 4);
}
function outSize(f = P.format) { // il lato corto = risoluzione scelta
  const a = ratioOf(f), even = x => Math.round(x / 2) * 2;
  return a >= 1 ? [even(f.res * a), even(f.res)] : [even(f.res), even(f.res / a)];
}
function tanHalf(fov, a = ratioOf()) { const t = Math.tan(fov * D2R / 2); return a >= 1 ? [t, t / a] : [t * a, t]; }
function migrate(p) { // progetti della prima versione (musicisti / inquadrature)
  if (p.musicians && !p.subjects) p.subjects = p.musicians.map(m => ({ ...m, trk: [] }));
  if (p.shots && !p.kfs) p.kfs = p.shots.map(s => ({ t: s.t, sid: s.mid ?? null, dy: s.dy || 0, dp: s.dp || 0, yaw: s.yaw, pitch: s.pitch,
    fov: s.fov, mode: s.cut ? 'cut' : 'move', dur: s.dur || null, breathe: s.breathe }));
  delete p.musicians; delete p.shots;
  return p;
}
function camMatrix(t) { // camera -> mondo
  if (!ORIENT || !P.settings.stab) return I3;
  const i = clamp(Math.round((t + P.settings.gyroOffset / 1000) * META.fps), 0, ORIENT.length - 1);
  const M = AXIS_MAPS[P.settings.axis];
  return mmul(mmul(M, quatMat(ORIENT[i])), mT(M));
}
function renderRot(t, view) { // direzione vista -> coordinate camera
  return mmul(mT(camMatrix(t)), viewMatrix(view.dir));
}

// ===================== WebGL =====================
const $ = id => document.getElementById(id);
const canvas = $('view'), gl = canvas.getContext('webgl2');
const vid = $('vid');
const VS = `#version 300 es
in vec2 p; out vec2 uv; void main(){ uv = p; gl_Position = vec4(p,0.,1.); }`;
const FS = `#version 300 es
precision highp float; in vec2 uv; out vec4 o;
uniform sampler2D tex; uniform mat3 rot; uniform vec2 th;
uniform int dual, outEq;
uniform mat3 Ma, Mb; uniform vec2 ca, cb; uniform vec3 fk; uniform float size, seam;
vec2 lensUV(vec3 d, vec2 c, out float t) {
  float rxy = length(d.xy); t = atan(rxy, d.z);
  float t2 = t * t, r = t * (fk.x + t2 * (fk.y + t2 * fk.z));
  return clamp((c + vec2(d.x, -d.y) * (r / max(rxy, 1e-6))) / size, 0., 1.);
}
void main(){
  vec3 d;
  if (outEq == 1) { float lon = uv.x * 3.14159265359, lat = uv.y * 1.57079632679;
    d = vec3(sin(lon) * cos(lat), sin(lat), cos(lon) * cos(lat)); }
  else d = normalize(rot * vec3(uv.x*th.x, uv.y*th.y, 1.));
  if (dual == 1) {
    float ta, tb;
    vec2 pa = lensUV(Ma * d, ca, ta), pb = lensUV(Mb * d, cb, tb);
    vec4 A = texture(tex, vec2(pa.x * 0.5, pa.y)), B = texture(tex, vec2(0.5 + pb.x * 0.5, pb.y));
    float s = clamp((tb - ta) / (2. * seam) + 0.5, 0., 1.);
    o = mix(B, A, s * s * (3. - 2. * s));
  } else {
    float lon = atan(d.x, d.z), lat = asin(clamp(d.y,-1.,1.));
    o = texture(tex, vec2(0.5 + lon/6.28318530718, 0.5 - lat/3.14159265359));
  }
}`;
function sh(type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw gl.getShaderInfoLog(s); return s; }
const prog = gl.createProgram();
gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
gl.linkProgram(prog); gl.useProgram(prog);
gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
const ploc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(ploc);
gl.vertexAttribPointer(ploc, 2, gl.FLOAT, false, 0, 0);
const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
const U = n => gl.getUniformLocation(prog, n);
const uRot = U('rot'), uTh = U('th'), uOutEq = U('outEq');
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
function setLensUniforms() {
  const L = META && META.shader, dual = !!(META && META.dual && L);
  gl.uniform1i(U('dual'), dual ? 1 : 0);
  if (!dual) { gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); return; }
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.uniformMatrix3fv(U('Ma'), false, new Float32Array(L.Ma)); // = Ma^T: d_lente = Ma^T·d
  gl.uniformMatrix3fv(U('Mb'), false, new Float32Array(L.Mb));
  gl.uniform2f(U('ca'), ...L.ca); gl.uniform2f(U('cb'), ...L.cb);
  gl.uniform3f(U('fk'), ...L.f); gl.uniform1f(U('size'), L.size); gl.uniform1f(U('seam'), L.seam * D2R);
}
let texReady = false;

function draw() {
  const t = curTime();
  const view = viewAt(t);
  if (vid.readyState >= 2) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, vid); texReady = true;
  }
  if (texReady) { // prima la panoramica 360 (stesso shader, uscita equirettangolare), poi la vista
    gl.viewport(0, 0, ov.width, ov.height); gl.uniform1i(uOutEq, 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    oc.drawImage(canvas, 0, canvas.height - ov.height, ov.width, ov.height, 0, 0, ov.width, ov.height);
    gl.uniform1i(uOutEq, 0);
  }
  gl.viewport(0, 0, canvas.width, canvas.height);
  if (texReady) {
    const R = renderRot(t, view);
    gl.uniformMatrix3fv(uRot, false, new Float32Array([R[0][0], R[1][0], R[2][0], R[0][1], R[1][1], R[2][1], R[0][2], R[1][2], R[2][2]]));
    const [tx, ty] = tanHalf(view.fov);
    gl.uniform2f(uTh, tx, ty);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  drawOverview(t, view);
  drawOverlay(t, view);
  drawTimeline();
  updateHud(t, view);
}

// ===================== riquadri sull'anteprima =====================
const ovl = $('overlay'), lc = ovl.getContext('2d');
function viewProject(view, dWorld) { // mondo -> pixel dell'anteprima (null se dietro)
  const V = viewMatrix(view.dir), d = mv(mT(V), dWorld);
  if (d[2] <= 0.05) return null;
  const [tx, ty] = tanHalf(view.fov);
  return [(d[0] / d[2] / tx * 0.5 + 0.5) * ovl.width, (0.5 - d[1] / d[2] / ty * 0.5) * ovl.height];
}
function viewUnproject(view, x, y) { // pixel dell'anteprima -> direzione nel mondo
  const [tx, ty] = tanHalf(view.fov);
  return norm(mv(viewMatrix(view.dir), [(x / ovl.width * 2 - 1) * tx, (1 - y / ovl.height * 2) * ty, 1]));
}
function drawOverlay(t, view) {
  const r = canvas.getBoundingClientRect(), pr = canvas.parentElement.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  Object.assign(ovl.style, { left: (r.left - pr.left) + 'px', top: (r.top - pr.top) + 'px', width: r.width + 'px', height: r.height + 'px' });
  if (ovl.width !== Math.round(r.width * dpr)) { ovl.width = Math.round(r.width * dpr); ovl.height = Math.round(r.height * dpr); }
  lc.clearRect(0, 0, ovl.width, ovl.height);
  if (!META) return;
  const pxPerDeg = Math.max(ovl.width, ovl.height) / view.fov;
  if (P.format.guide && RATIOS[P.format.guide]) { // guida per un secondo formato
    const g = RATIOS[P.format.guide], ga = g[0] / g[1], a = ovl.width / ovl.height;
    const gw = ga > a ? ovl.width : ovl.height * ga, gh = ga > a ? ovl.width / ga : ovl.height;
    const gx = (ovl.width - gw) / 2, gy = (ovl.height - gh) / 2;
    lc.fillStyle = 'rgba(0,0,0,.45)';
    lc.fillRect(0, 0, ovl.width, gy); lc.fillRect(0, gy + gh, ovl.width, ovl.height - gy - gh);
    lc.fillRect(0, gy, gx, gh); lc.fillRect(gx + gw, gy, ovl.width - gx - gw, gh);
    lc.strokeStyle = 'rgba(255,255,255,.7)'; lc.lineWidth = 1 * dpr; lc.strokeRect(gx, gy, gw, gh);
    lc.fillStyle = 'rgba(255,255,255,.8)'; lc.font = `${11 * dpr}px -apple-system, sans-serif`; lc.fillText(P.format.guide, gx + 6 * dpr, gy + gh - 8 * dpr);
  }
  lc.font = `600 ${12 * dpr}px -apple-system, sans-serif`; lc.lineWidth = 2 * dpr;
  if (P.settings.showBoxes) P.subjects.forEach(s => {
    const p = viewProject(view, subjDir(s, t)); if (!p) return;
    const [w, h, live] = subjSize(s, t), bw = w * pxPerDeg, bh = h * pxPerDeg;
    const col = subjColor(s);
    lc.strokeStyle = col; lc.setLineDash(live ? [] : [6 * dpr, 5 * dpr]);
    lc.strokeRect(p[0] - bw / 2, p[1] - bh / 2, bw, bh); lc.setLineDash([]);
    lc.fillStyle = col; lc.fillText(`${s.key} ${s.name}`, p[0] - bw / 2, p[1] - bh / 2 - 5 * dpr);
  });
  if (boxDraw && boxDraw.x1 != null) {
    lc.strokeStyle = '#fff'; lc.setLineDash([4 * dpr, 4 * dpr]);
    lc.strokeRect(boxDraw.x0, boxDraw.y0, boxDraw.x1 - boxDraw.x0, boxDraw.y1 - boxDraw.y0); lc.setLineDash([]);
  }
  if (boxDraw) { lc.fillStyle = 'rgba(0,0,0,.6)'; lc.fillRect(0, 0, ovl.width, 26 * dpr); lc.fillStyle = '#fff';
    lc.fillText(boxDraw.sid ? `Disegna il riquadro attorno a ${subjOf(boxDraw.sid).name} · Esc annulla` : 'Disegna un riquadro attorno a una persona o un oggetto da seguire · Esc annulla', 10 * dpr, 17 * dpr); }
}

// ===================== panoramica 360 =====================
const ov = $('overview'), oc = ov.getContext('2d');
function camToPx(d) { const [y, p] = yawPitchOf(norm(d)); return [(0.5 + y / 360) * ov.width, (0.5 - p / 180) * ov.height]; }
function drawOverview(t, view) {
  if (!META || !texReady) { oc.fillStyle = '#000'; oc.fillRect(0, 0, ov.width, ov.height); return; }
  const Ct = mT(camMatrix(t));
  const V = viewMatrix(view.dir), [tx, ty] = tanHalf(view.fov);
  const pts = [];
  for (let k = 0; k <= 80; k++) {
    const s = k / 20, e = s % 1, side = Math.floor(s) % 4;
    const uv = [[-1 + 2 * e, -1], [1, -1 + 2 * e], [1 - 2 * e, 1], [-1, 1 - 2 * e]][side];
    pts.push(camToPx(mv(Ct, mv(V, [uv[0] * tx, uv[1] * ty, 1]))));
  }
  oc.strokeStyle = 'rgba(255,255,255,.9)'; oc.lineWidth = 2; oc.beginPath();
  pts.forEach((p, k) => { if (k === 0 || Math.abs(p[0] - pts[k - 1][0]) > ov.width / 2) oc.moveTo(...p); else oc.lineTo(...p); });
  oc.stroke();
  oc.font = 'bold 13px -apple-system, sans-serif';
  P.subjects.forEach(s => {
    const [x, y] = camToPx(mv(Ct, subjDir(s, t)));
    oc.fillStyle = subjColor(s); oc.beginPath(); oc.arc(x, y, 9, 0, 7); oc.fill();
    oc.fillStyle = '#111'; oc.textAlign = 'center'; oc.textBaseline = 'middle'; oc.fillText(s.key, x, y + 1);
    oc.fillStyle = '#fff'; oc.textAlign = 'left'; oc.fillText(s.name, x + 12, y);
  });
}

// ===================== timeline =====================
const tl = $('timeline'), tc = tl.getContext('2d');
let tlView = [0, 1];
const TL = { ruler: 18, cam: 42, row: 22 };
function tlRows() { return { camY: TL.ruler, subY: TL.ruler + TL.cam + 6, H: TL.ruler + TL.cam + 6 + P.subjects.length * TL.row + 4 }; }
function tx2t(x) { return tlView[0] + x / tl.width * (tlView[1] - tlView[0]); }
function t2tx(t) { return (t - tlView[0]) / (tlView[1] - tlView[0]) * tl.width; }
const LABEL_W = 92;
function drawTimeline() {
  const dpr = devicePixelRatio || 1, rows = tlRows();
  tl.style.height = rows.H + 'px';
  const w = tl.clientWidth * dpr;
  if (tl.width !== w || tl.height !== rows.H * dpr) { tl.width = w; tl.height = rows.H * dpr; }
  const s = dpr, H = tl.height;
  tc.clearRect(0, 0, tl.width, H);
  if (!META) return;
  tc.fillStyle = '#8b8f96'; tc.font = `${10 * s}px ui-monospace, monospace`; tc.textBaseline = 'top';
  const span = tlView[1] - tlView[0];
  const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find(x => span / x < tl.width / (70 * s)) || 600;
  for (let t = Math.ceil(tlView[0] / step) * step; t < tlView[1]; t += step) {
    const x = t2tx(t); tc.fillRect(x, 0, 1, 6 * s); tc.fillText(fmt(t, false), x + 3 * s, 2 * s);
  }
  // --- traccia camera ---
  const y0 = rows.camY * s, h = TL.cam * s;
  tc.fillStyle = '#1d2024'; tc.fillRect(0, y0, tl.width, h);
  segs.forEach((sg, i) => {
    const kf = sg.kf, end = i + 1 < segs.length ? segs[i + 1].t : META.duration;
    const x0 = t2tx(sg.t), x1 = t2tx(end);
    if (x1 < 0 || x0 > tl.width) return;
    const su = subjOf(kf.sid), col = su ? subjColor(su) : '#8a8f98';
    tc.fillStyle = col + (kf === selKf ? 'ee' : '99'); tc.fillRect(x0, y0 + 10 * s, Math.max(1, x1 - x0), h - 14 * s);
    if (sg.dur > 0) {
      const xd = t2tx(sg.t + sg.dur), g = tc.createLinearGradient(x0, 0, xd, 0);
      g.addColorStop(0, 'rgba(0,0,0,.55)'); g.addColorStop(1, 'rgba(0,0,0,0)'); tc.fillStyle = g; tc.fillRect(x0, y0 + 10 * s, xd - x0, h - 14 * s);
    }
    const nx = P.kfs[i + 1];
    if (nx && nx.mode === 'glide') { // tratteggio: la camera scivola verso il prossimo
      tc.save(); tc.beginPath(); tc.rect(x0, y0 + 10 * s, x1 - x0, h - 14 * s); tc.clip();
      tc.strokeStyle = 'rgba(0,0,0,.25)'; tc.lineWidth = 3 * s;
      for (let x = x0 - h; x < x1; x += 10 * s) { tc.beginPath(); tc.moveTo(x, y0 + h); tc.lineTo(x + h, y0); tc.stroke(); }
      tc.restore();
    }
    if (x1 - x0 > 50 * s) {
      tc.fillStyle = '#111'; tc.font = `600 ${11 * s}px -apple-system, sans-serif`; tc.textBaseline = 'middle';
      tc.fillText(`${su ? su.name : 'Libera'} · ${fovName(kf.fov)}`, x0 + 8 * s, y0 + 10 * s + (h - 14 * s) / 2, x1 - x0 - 14 * s);
    }
  });
  segs.forEach(sg => { // rombi dei keyframe
    const x = t2tx(sg.t), kf = sg.kf, cy = y0 + 7 * s, r = (kf === selKf ? 7 : 5.5) * s;
    if (x < -10 || x > tl.width + 10) return;
    tc.fillStyle = kf.mode === 'cut' ? '#fff' : kf === selKf ? '#ff7a3d' : '#e8e6e1';
    tc.beginPath(); tc.moveTo(x, cy - r); tc.lineTo(x + r, cy); tc.lineTo(x, cy + r); tc.lineTo(x - r, cy); tc.closePath(); tc.fill();
    tc.fillStyle = 'rgba(255,255,255,.5)'; tc.fillRect(x - 0.5 * s, y0 + 10 * s, 1 * s, h - 14 * s);
  });
  // --- tracce dei soggetti ---
  P.subjects.forEach((su, k) => {
    const yy = (rows.subY + k * TL.row) * s, hh = (TL.row - 4) * s, col = subjColor(su);
    tc.fillStyle = su.id === selSubj ? '#262a30' : '#191b1e'; tc.fillRect(0, yy, tl.width, hh);
    (su.trk || []).forEach(r => {
      const xa = t2tx(r.f0 / META.fps), xb = t2tx((r.f0 + r.pts.length) / META.fps);
      if (xb < 0 || xa > tl.width) return;
      tc.fillStyle = col + 'cc'; tc.fillRect(xa, yy + 3 * s, Math.max(2 * s, xb - xa), hh - 6 * s);
    });
    if (trackJob && trackJob.sid === su.id) {
      const xa = t2tx(trackJob.t0), xb = t2tx(trackJob.t0 + trackJob.dir * trackJob.progress * trackJob.span);
      tc.fillStyle = '#ffffff55'; tc.fillRect(Math.min(xa, xb), yy, Math.abs(xb - xa), hh);
    }
    tc.fillStyle = '#e8e6e1'; tc.font = `600 ${10.5 * s}px -apple-system, sans-serif`; tc.textBaseline = 'middle';
    tc.fillStyle = col; tc.fillRect(4 * s, yy + 4 * s, 3 * s, hh - 8 * s);
    tc.fillStyle = '#e8e6e1'; tc.fillText(`${su.key} ${su.name}`, 11 * s, yy + hh / 2, LABEL_W * s);
  });
  const px = t2tx(curTime());
  tc.fillStyle = '#fff'; tc.fillRect(px - s, 0, 2 * s, H);
}
function fovName(f) { const e = Object.values(FRAMINGS).reduce((a, b) => Math.abs(b[1] - f) < Math.abs(a[1] - f) ? b : a); return Math.abs(e[1] - f) < 4 ? e[0] : Math.round(f) + '°'; }
let tlDrag = null;
function tlHit(e) {
  const s = devicePixelRatio || 1, x = e.offsetX * s, y = e.offsetY, rows = tlRows();
  const zone = y < rows.camY ? 'ruler' : y < rows.camY + TL.cam ? 'cam' : y >= rows.subY ? 'subj' : 'gap';
  const kf = zone === 'cam' ? P.kfs.find(k => Math.abs(t2tx(k.t) - x) < 8 * s) : null;
  const si = zone === 'subj' ? Math.floor((y - rows.subY) / TL.row) : -1;
  return { x, t: tx2t(x), zone, kf, subj: P.subjects[si] };
}
tl.addEventListener('mousedown', e => {
  if (!META) return;
  const h = tlHit(e);
  if (h.kf) { selKf = h.kf; tlDrag = { kf: h.kf, moved: false }; renderKfPanel(); requestDraw(); return; }
  if (h.zone === 'cam') { const i = segIndex(h.t); selKf = i >= 0 ? P.kfs[i] : null; renderKfPanel(); }
  if (h.subj) { selSubj = h.subj.id; renderSubjects(); }
  seek(h.t); tlDrag = { seek: true };
});
tl.addEventListener('dblclick', e => {
  if (!META) return;
  const h = tlHit(e);
  if (h.zone === 'cam' && !h.kf) { seek(h.t); addKeyframeHere(); }
});
addEventListener('mousemove', e => {
  if (!tlDrag) return;
  const r = tl.getBoundingClientRect(), t = clamp(tx2t((e.clientX - r.left) * (devicePixelRatio || 1)), 0, META.duration);
  if (tlDrag.kf) { tlDrag.kf.t = t; rebuild(); requestDraw(); } else seek(t);
});
addEventListener('mouseup', () => { if (tlDrag && tlDrag.kf) renderKfPanel(); tlDrag = null; });
tl.addEventListener('wheel', e => {
  if (!META) return; e.preventDefault();
  const s = devicePixelRatio || 1, tm = tx2t(e.offsetX * s), span = tlView[1] - tlView[0];
  if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
    const ns = clamp(span * Math.exp(e.deltaY * 0.004), 2, META.duration), k = (tm - tlView[0]) / span;
    tlView = [tm - k * ns, tm - k * ns + ns];
  } else { const d = e.deltaX / tl.width * span * 2; tlView = [tlView[0] + d, tlView[1] + d]; }
  const sp = tlView[1] - tlView[0];
  if (tlView[0] < 0) tlView = [0, sp]; if (tlView[1] > META.duration) tlView = [META.duration - sp, META.duration];
  requestDraw();
}, { passive: false });

// ===================== keyframe: aggiungere / modificare =====================
function kfAtNow() { const i = segIndex(curTime()); return i >= 0 ? P.kfs[i] : null; }
function putKf(props) {
  const t = curTime();
  let kf = P.kfs.find(k => Math.abs(k.t - t) < 0.2);
  if (!kf) { kf = { t, dy: 0, dp: 0, mode: 'move', dur: null }; P.kfs.push(kf); }
  Object.assign(kf, props);
  selKf = kf; rebuild(); renderKfPanel(); requestDraw();
  return kf;
}
function addKeyframeHere() { // fissa lo stato attuale della camera: soggetto seguito o direzione libera
  const v = viewAt(curTime()), cur = kfAtNow(), su = cur && subjOf(cur.sid);
  if (su) putKf({ sid: su.id, dy: cur.dy || 0, dp: cur.dp || 0, fov: v.fov, mode: P.kfs.length ? 'glide' : 'move' });
  else { const [yaw, pitch] = yawPitchOf(v.dir); putKf({ sid: null, yaw, pitch, fov: v.fov, mode: P.kfs.length ? 'glide' : 'move' }); }
}
function goSubject(s, cut) { putKf({ sid: s.id, dy: 0, dp: 0, fov: s.fov || 52, mode: cut ? 'cut' : 'move', dur: null }); }
function setFraming(fov) {
  const cur = kfAtNow();
  if (!cur) { P.free.fov = fov; scheduleSave(); requestDraw(); return; }
  if (Math.abs(cur.t - curTime()) < 0.2 || (vid.paused && cur === selKf)) { cur.fov = fov; rebuild(); renderKfPanel(); requestDraw(); }
  else putKf({ sid: cur.sid, dy: cur.dy, dp: cur.dp, yaw: cur.yaw, pitch: cur.pitch, fov, mode: 'move', dur: null });
}
function nudge(dyaw, dpitch) {
  const kf = kfAtNow();
  if (!kf) { P.free.yaw = wrap(P.free.yaw + dyaw); P.free.pitch = clamp(P.free.pitch + dpitch, -89, 89); scheduleSave(); requestDraw(); return; }
  if (subjOf(kf.sid)) { kf.dy = (kf.dy || 0) + dyaw; kf.dp = (kf.dp || 0) + dpitch; }
  else { const [y, p] = kf.yaw != null ? [kf.yaw, kf.pitch] : yawPitchOf(kfDir(kf, curTime())); kf.yaw = wrap(y + dyaw); kf.pitch = clamp(p + dpitch, -89, 89); kf.sid = null; }
  selKf = kf; rebuild(); renderKfPanel(); requestDraw();
}
function aimAt(dirWorld) {
  const [y, p] = yawPitchOf(dirWorld), kf = kfAtNow();
  if (!kf) { P.free.yaw = y; P.free.pitch = p; scheduleSave(); requestDraw(); return; }
  const cur = yawPitchOf(kfDir(kf, curTime()));
  nudge(wrap(y - cur[0]), p - cur[1]);
}
const wrap = a => ((a + 540) % 360) - 180;
function zoomBy(f) {
  const kf = kfAtNow();
  if (!kf) P.free.fov = clamp(P.free.fov * f, 15, 120);
  else { kf.fov = clamp(kf.fov * f, 15, 120); rebuild(); renderKfPanel(); }
  scheduleSave(); requestDraw();
}

// trascina l'anteprima per mirare, oppure disegna il riquadro da tracciare
let drag = null, boxDraw = null;
function ovlXY(e) { const r = ovl.getBoundingClientRect(), d = devicePixelRatio || 1; return [(e.clientX - r.left) * d, (e.clientY - r.top) * d]; }
ovl.addEventListener('mousedown', e => {
  if (!META) return;
  if (boxDraw) { const [x, y] = ovlXY(e); Object.assign(boxDraw, { x0: x, y0: y, x1: x, y1: y, down: true }); return; }
  drag = { x: e.clientX, y: e.clientY };
});
addEventListener('mousemove', e => {
  if (boxDraw && boxDraw.down) { [boxDraw.x1, boxDraw.y1] = ovlXY(e); requestDraw(); return; }
  if (!drag) return;
  const fov = viewAt(curTime()).fov, k = fov / Math.max(ovl.clientWidth, ovl.clientHeight);
  nudge(-(e.clientX - drag.x) * k, (e.clientY - drag.y) * k);
  drag = { x: e.clientX, y: e.clientY };
});
addEventListener('mouseup', () => {
  drag = null;
  if (!boxDraw || !boxDraw.down) return;
  const b = boxDraw; boxDraw = null; ovl.style.cursor = '';
  const w = Math.abs(b.x1 - b.x0), h = Math.abs(b.y1 - b.y0);
  if (w < 8 || h < 8) { requestDraw(); return; }
  const v = viewAt(curTime()), dir = viewUnproject(v, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
  const L = Math.max(ovl.width, ovl.height), wd = w / L * v.fov, hd = h / L * v.fov, [yaw, pitch] = yawPitchOf(dir);
  let s = subjOf(b.sid);
  if (!s) s = newSubject(yaw, pitch, v.fov); else { s.yaw = yaw; s.pitch = pitch; }
  s.w = wd; s.h = hd;
  renderSubjects(); requestDraw();
  startTrack(s, 1, { yaw, pitch, w: wd, h: hd });
});
ovl.addEventListener('wheel', e => { e.preventDefault(); zoomBy(Math.exp(e.deltaY * 0.002)); }, { passive: false });
ov.addEventListener('mousedown', e => {
  if (!META) return;
  const r = ov.getBoundingClientRect();
  const yaw = ((e.clientX - r.left) / r.width - 0.5) * 360, pitch = (0.5 - (e.clientY - r.top) / r.height) * 180;
  aimAt(mv(camMatrix(curTime()), dirOf(yaw, pitch)));
});
function beginBox(sid) { if (!META) return; vid.pause(); boxDraw = { sid: sid || null }; ovl.style.cursor = 'crosshair'; requestDraw(); }

// ===================== tracking =====================
let trackJob = null;
async function startTrack(s, dir, init) {
  if (trackJob) return alert('Un tracking è già in corso.');
  const t = curTime(), f = frameOf(t);
  if (!init) { const [w, h] = subjSize(s, t), [yaw, pitch] = yawPitchOf(subjDir(s, t)); init = { yaw, pitch, w, h }; }
  const tid = s.id + '_' + Date.now().toString(36);
  const r = await fetch(`/api/track?name=${encodeURIComponent(FILE)}`, { method: 'POST',
    body: JSON.stringify({ tid, frame: f, dir, ...init, settings: P.settings }) });
  if (!r.ok) return alert((await r.json()).error);
  trackJob = { sid: s.id, t0: t, dir, progress: 0, span: dir > 0 ? META.duration - t : t };
  renderSubjects();
  for (;;) {
    await new Promise(r => setTimeout(r, 400));
    const j = await (await fetch(`/api/status?name=${encodeURIComponent(FILE)}&kind=track`)).json();
    trackJob.progress = j.progress || 0; requestDraw();
    if (j.status === 'running') continue;
    trackJob = null;
    if (j.status === 'error') { renderSubjects(); return alert('Errore nel tracking:\n' + j.error); }
    const res = await (await fetch(`/cache/${encodeURIComponent(stemOf(FILE))}/${j.out}`)).json();
    const m = trkMap(s);
    res.pts.forEach((p, k) => m.set(res.f0 + k, p));
    setTrk(s, m); rebuild(); renderSubjects(); requestDraw();
    const secs = res.pts.length / META.fps;
    $('saveState').textContent = `${s.name}: seguito per ${secs.toFixed(1)} s`;
    return;
  }
}
function clearTrack(s, fromT, dir) { // cancella il tracking da qui in avanti/indietro
  const f = frameOf(fromT), m = trkMap(s);
  [...m.keys()].forEach(k => { if (dir > 0 ? k >= f : k <= f) m.delete(k); });
  setTrk(s, m); rebuild(); renderSubjects(); requestDraw();
}

// ===================== pannelli =====================
let selKf = null, selSubj = null;
function newSubject(yaw, pitch, fov) {
  if (P.subjects.length >= 9) { alert('Massimo 9 soggetti (tasti 1–9).'); return null; }
  const id = Math.random().toString(36).slice(2, 8);
  const s = { id, name: `Soggetto ${P.subjects.length + 1}`, yaw, pitch, fov: clamp(fov, 30, 80), w: 15, h: 25, key: P.subjects.length + 1, trk: [] };
  P.subjects.push(s); selSubj = id; scheduleSave();
  setTimeout(() => { const ins = $('subjList').querySelectorAll('input'); if (ins.length) ins[ins.length - 1].select(); }, 0);
  return s;
}
function renderSubjects() {
  const box = $('subjList'); box.innerHTML = '';
  P.subjects.forEach(s => {
    const row = document.createElement('div'); row.className = 'mus' + (s.id === selSubj ? ' sel' : '');
    const busy = trackJob && trackJob.sid === s.id;
    const frames = (s.trk || []).reduce((a, r) => a + r.pts.length, 0);
    row.innerHTML = `<div class="k" style="background:${subjColor(s)}">${s.key}</div>
      <input value="${s.name.replace(/"/g, '&quot;')}">
      <div class="btns">
        <button data-a="box" title="Disegna di nuovo il riquadro qui e segui da qui in avanti">▢</button>
        <button data-a="back" title="Segui all'indietro da qui" ${trackJob ? 'disabled' : ''}>◀</button>
        <button data-a="fwd" title="Segui in avanti da qui" ${trackJob ? 'disabled' : ''}>▶</button>
        <button data-a="more" title="Altro">⋯</button>
      </div>
      <div class="sub muted">${busy ? 'tracking in corso…' : frames ? `seguito per ${(frames / META.fps).toFixed(1)} s` : 'posizione fissa'}</div>`;
    row.onclick = ev => { if (ev.target.tagName !== 'INPUT' && ev.target.tagName !== 'BUTTON') { selSubj = s.id; renderSubjects(); requestDraw(); } };
    const inp = row.querySelector('input');
    inp.onchange = () => { s.name = inp.value; scheduleSave(); requestDraw(); };
    row.querySelectorAll('button').forEach(b => b.onclick = () => {
      selSubj = s.id;
      const a = b.dataset.a;
      if (a === 'box') beginBox(s.id);
      if (a === 'fwd') startTrack(s, 1);
      if (a === 'back') startTrack(s, -1);
      if (a === 'more') {
        const c = prompt(`${s.name}:\n1 = cancella tracking da qui in avanti\n2 = cancella tracking da qui indietro\n3 = fissa la posizione all'inquadratura attuale (toglie il tracking)\n4 = elimina soggetto`);
        if (c === '1') clearTrack(s, curTime(), 1);
        if (c === '2') clearTrack(s, curTime(), -1);
        if (c === '3') { const v = viewAt(curTime()); [s.yaw, s.pitch] = yawPitchOf(v.dir); s.trk = []; pathCache.delete(s.id);
          P.kfs.forEach(k => { if (k.sid === s.id) { k.dy = 0; k.dp = 0; } }); rebuild(); renderSubjects(); requestDraw(); }
        if (c === '4' && confirm(`Eliminare ${s.name}? I suoi keyframe diventano liberi.`)) {
          P.kfs.forEach(k => { if (k.sid === s.id) { [k.yaw, k.pitch] = yawPitchOf(kfDir(k, k.t)); k.sid = null; } });
          P.subjects = P.subjects.filter(x => x !== s); P.subjects.forEach((x, i) => x.key = i + 1);
          rebuild(); renderSubjects(); renderKfPanel(); requestDraw();
        }
      }
      renderSubjects();
    });
    box.appendChild(row);
  });
}
$('addSubj').onclick = () => beginBox(null);
$('addKf').onclick = () => META && addKeyframeHere();
function renderKfPanel() {
  const b = $('kfBody'), kf = selKf;
  if (!kf || !P.kfs.includes(kf)) { b.className = 'muted'; b.innerHTML = 'Nessun keyframe selezionato.<br>Premi <kbd>K</kbd> o fai doppio clic sulla traccia Camera per aggiungerne uno.'; return; }
  const i = P.kfs.indexOf(kf), sg = segs[i];
  b.className = '';
  b.innerHTML = `
    <div class="row">A <b>${fmt(kf.t)}</b> <span><button id="kPrev">◀</button> <button id="kGo">Vai</button> <button id="kNext">▶</button></span></div>
    <label class="row">Inquadra <select id="kSubj"><option value="">Direzione libera</option>${P.subjects.map(s => `<option value="${s.id}" ${s.id === kf.sid ? 'selected' : ''}>${s.key} · ${s.name}${s.trk && s.trk.length ? ' (seguito)' : ''}</option>`).join('')}</select></label>
    <div class="row">Taglio <div class="seg">${Object.entries(FRAMINGS).map(([k, [n, f]]) => `<button data-f="${f}" class="${Math.abs(kf.fov - f) < 2 ? 'on' : ''}">${n}</button>`).join('')}</div></div>
    <label class="row">Campo <input type="range" id="kFov" min="15" max="120" value="${kf.fov}"> <span>${Math.round(kf.fov)}°</span></label>
    <div class="row">Arrivo <div class="seg">${Object.entries(MODES).map(([m, n]) => `<button data-m="${m}" class="${kf.mode === m ? 'on' : ''}" ${i === 0 && m !== 'move' ? 'disabled' : ''}>${n}</button>`).join('')}</div></div>
    <div class="muted hint">${kf.mode === 'move' ? 'La camera parte qui e raggiunge il soggetto in un gesto unico.' : kf.mode === 'glide' ? 'La camera si muove per tutto l\'intervallo dal keyframe precedente e arriva qui esattamente.' : 'Cambio di inquadratura netto.'}</div>
    ${kf.mode === 'move' && i > 0 ? `
    <label class="row">Durata <span><input type="checkbox" id="kAuto" ${kf.dur ? '' : 'checked'}> auto</span></label>
    <label class="row"><input type="range" id="kDur" min="0.3" max="6" step="0.05" value="${sg ? sg.dur : 1}" ${kf.dur ? '' : 'disabled'}> <span>${sg ? sg.dur.toFixed(2) : ''} s</span></label>
    <label class="row">Respiro <input type="range" id="kBr" min="0" max="2" step="0.1" value="${kf.breathe ?? 1}"></label>` : ''}
    <div class="row" style="margin-top:10px">${kf.sid ? '<button id="kReset">Centra sul soggetto</button>' : '<span></span>'}<button id="kDel">Elimina</button></div>`;
  const on = (id, ev, fn) => { const el = b.querySelector('#' + id); if (el) el.addEventListener(ev, fn); };
  const upd = () => { rebuild(); renderKfPanel(); requestDraw(); };
  on('kGo', 'click', () => seek(kf.t));
  on('kPrev', 'click', () => { const k = P.kfs[i - 1]; if (k) { selKf = k; seek(k.t); renderKfPanel(); } });
  on('kNext', 'click', () => { const k = P.kfs[i + 1]; if (k) { selKf = k; seek(k.t); renderKfPanel(); } });
  on('kSubj', 'change', e => { const v = e.target.value; if (!v) [kf.yaw, kf.pitch] = yawPitchOf(kfDir(kf, kf.t)); kf.sid = v || null; kf.dy = kf.dp = 0; upd(); });
  b.querySelectorAll('[data-f]').forEach(x => x.onclick = () => { kf.fov = +x.dataset.f; upd(); });
  b.querySelectorAll('[data-m]').forEach(x => x.onclick = () => { kf.mode = x.dataset.m; upd(); });
  on('kFov', 'input', e => { kf.fov = +e.target.value; rebuild(); requestDraw(); e.target.nextElementSibling.textContent = Math.round(kf.fov) + '°'; });
  on('kFov', 'change', upd);
  on('kAuto', 'change', e => { kf.dur = e.target.checked ? null : (sg ? +sg.dur.toFixed(2) : 1); upd(); });
  on('kDur', 'input', e => { kf.dur = +e.target.value; rebuild(); requestDraw(); e.target.nextElementSibling.textContent = kf.dur.toFixed(2) + ' s'; });
  on('kBr', 'change', e => { kf.breathe = +e.target.value; upd(); });
  on('kReset', 'click', () => { kf.dy = kf.dp = 0; upd(); });
  on('kDel', 'click', deleteSel);
}
function deleteSel() {
  if (!selKf) return;
  P.kfs = P.kfs.filter(k => k !== selKf); selKf = null; rebuild(); renderKfPanel(); requestDraw();
}
function bindSettings() {
  const s = P.settings;
  $('pace').value = String(s.pace); $('breathe').value = s.breathe; $('stab').checked = s.stab;
  $('axisMap').value = s.axis; $('gyroOff').value = s.gyroOffset; $('follow').value = s.follow; $('showBoxes').checked = s.showBoxes;
  $('pace').onchange = e => { s.pace = +e.target.value; rebuild(); requestDraw(); };
  $('breathe').oninput = e => { s.breathe = +e.target.value; rebuild(); requestDraw(); };
  $('follow').oninput = e => { s.follow = +e.target.value; pathCache.clear(); rebuild(); requestDraw(); };
  $('showBoxes').onchange = e => { s.showBoxes = e.target.checked; scheduleSave(); requestDraw(); };
  $('stab').onchange = e => { s.stab = e.target.checked; scheduleSave(); requestDraw(); };
  $('axisMap').onchange = e => { s.axis = +e.target.value; scheduleSave(); requestDraw(); };
  $('gyroOff').onchange = e => { s.gyroOffset = +e.target.value; scheduleSave(); requestDraw(); };
}

// ===================== formato =====================
const CODECS = { hevc: 'HEVC (H.265)', h264: 'H.264 (massima compatibilità)', prores: 'ProRes 422 (montaggio)' };
function applyFormat() {
  const a = ratioOf(), L = 1440;
  canvas.width = a >= 1 ? L : Math.round(L * a); canvas.height = a >= 1 ? Math.round(L / a) : L;
  canvas.style.aspectRatio = `${canvas.width} / ${canvas.height}`;
  ov.width = Math.min(720, canvas.width, canvas.height * 2); ov.height = ov.width / 2;
  const [W, H] = outSize();
  $('fmtSize').textContent = `${W} × ${H}`;
  requestDraw();
}
function bindFormat() {
  const f = P.format, on = (id, fn) => { $(id).onchange = e => { fn(e.target.value); scheduleSave(); bindFormat(); }; };
  $('fmtRatio').value = f.ratio; $('fmtRes').value = String(f.res); $('fmtCodec').value = f.codec;
  $('fmtQual').value = f.quality; $('fmtGuide').value = f.guide; $('fmtCw').value = f.cw; $('fmtCh').value = f.ch;
  $('fmtCustom').classList.toggle('hidden', f.ratio !== 'custom');
  $('fmtQualRow').classList.toggle('hidden', false);
  on('fmtRatio', v => f.ratio = v); on('fmtRes', v => f.res = +v); on('fmtCodec', v => f.codec = v);
  on('fmtQual', v => f.quality = v); on('fmtGuide', v => f.guide = v);
  on('fmtCw', v => f.cw = clamp(+v || 1, 1, 100)); on('fmtCh', v => f.ch = clamp(+v || 1, 1, 100));
  applyFormat();
}

// ===================== tastiera =====================
addEventListener('keydown', e => {
  if (!META || e.target.matches('input[type=text], input:not([type]), select, textarea') || e.metaKey || e.ctrlKey) return;
  const k = e.key.toLowerCase();
  if (e.key === 'Escape') { if (boxDraw) { boxDraw = null; ovl.style.cursor = ''; requestDraw(); } return; }
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); return; }
  const dm = e.code.match(/^Digit([1-9])$/);
  if (dm) { const s = P.subjects[+dm[1] - 1]; if (s) goSubject(s, e.shiftKey); e.preventDefault(); return; }
  if (FRAMINGS[k]) { setFraming(FRAMINGS[k][1]); return; }
  if (k === 'k') { addKeyframeHere(); return; }
  if (k === 't') { beginBox(null); return; }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault(); const d = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 5 : 1 / META.fps);
    vid.pause(); seek(curTime() + d); return;
  }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { // salta al keyframe precedente/successivo
    e.preventDefault(); const t = curTime();
    const kf = e.key === 'ArrowUp' ? [...P.kfs].reverse().find(k => k.t < t - 0.01) : P.kfs.find(k => k.t > t + 0.01);
    if (kf) { selKf = kf; seek(kf.t); renderKfPanel(); } return;
  }
  if (e.key === 'Backspace' || e.key === 'Delete') { deleteSel(); e.preventDefault(); }
});

// ===================== trasporto =====================
let frameTime = 0;
const curTime = () => frameTime;
function seek(t) { if (!META) return; t = clamp(t, 0, META.duration - 0.01); vid.currentTime = t; frameTime = t; requestDraw(); }
function togglePlay() { if (vid.paused) vid.play(); else vid.pause(); }
$('playBtn').onclick = togglePlay;
vid.addEventListener('play', () => { $('playBtn').textContent = '❚❚'; });
vid.addEventListener('pause', () => { $('playBtn').textContent = '▶'; frameTime = vid.currentTime; requestDraw(); });
vid.addEventListener('seeked', () => requestDraw());
vid.addEventListener('loadeddata', () => requestDraw());
function onFrame(_, md) { frameTime = md.mediaTime; draw(); vid.requestVideoFrameCallback(onFrame); }
vid.requestVideoFrameCallback(onFrame);
let drawQueued = false;
function requestDraw() { if (drawQueued) return; drawQueued = true; requestAnimationFrame(() => { drawQueued = false; draw(); }); }
addEventListener('resize', requestDraw);
function fmt(t, cs = true) {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${cs ? s.toFixed(2).padStart(5, '0') : String(Math.floor(s)).padStart(2, '0')}`;
}
function updateHud(t, view) {
  $('tc').textContent = fmt(t);
  const kf = kfAtNow(), su = kf && subjOf(kf.sid);
  $('hud').textContent = META ? `${su ? su.name : kf ? 'Direzione libera' : 'Vista libera'} · ${Math.round(view.fov)}°${view.moving ? ' · in movimento' : ''}` : '';
  $('hud').classList.toggle('hidden', !META);
}

// ===================== file, salvataggio, export =====================
let saveTimer = null;
function scheduleSave() {
  if (!FILE) return;
  $('saveState').textContent = 'modifiche…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await fetch(`/api/project?name=${encodeURIComponent(FILE)}`, { method: 'POST', body: JSON.stringify(P) });
    $('saveState').textContent = 'salvato';
  }, 800);
}
async function loadFiles() {
  const r = await (await fetch('/api/files')).json();
  const sel = $('fileSel'), prev = sel.value;
  sel.innerHTML = r.files.map(f => `<option value="${f.name}">${f.ready ? '● ' : '○ '}${f.name} · ${(f.size / 1e9).toFixed(1)} GB</option>`).join('');
  if (prev) sel.value = prev;
  return r.files;
}
const stemOf = n => n.replace(/\.[^.]+$/, '');
async function openFile(name) {
  const st = encodeURIComponent(stemOf(name));
  META = await (await fetch(`/cache/${st}/meta.json`)).json();
  const o = await fetch(`/cache/${st}/orient.json`); ORIENT = o.ok ? await o.json() : null;
  const p = await fetch(`/cache/${st}/project.json`);
  P = Object.assign(blankProject(), migrate(p.ok ? await p.json() : {}));
  P.settings = Object.assign(blankProject().settings, P.settings);
  P.format = Object.assign(blankProject().format, P.format);
  FILE = name; selKf = null; selSubj = null; pathCache.clear(); setLensUniforms(); texReady = false; tlView = [0, META.duration];
  vid.src = `/cache/${st}/proxy.mp4`; frameTime = 0;
  $('empty').classList.add('hidden'); $('exportBtn').disabled = false;
  $('durLbl').textContent = '/ ' + fmt(META.duration) + (ORIENT ? '' : ' · giroscopio non trovato');
  bindSettings(); bindFormat(); renderSubjects(); rebuild(false); renderKfPanel(); $('saveState').textContent = '';
  requestDraw();
}
async function pollJob(name, label) {
  const box = $('jobBox'); box.classList.remove('hidden');
  for (;;) {
    const j = await (await fetch(`/api/status?name=${encodeURIComponent(name)}`)).json();
    box.querySelector('i').style.width = ((j.progress || 0) * 100) + '%';
    box.querySelector('span').textContent = j.status === 'running' ? `${label} ${Math.round((j.progress || 0) * 100)}%` : '';
    if (j.status !== 'running') { box.classList.add('hidden'); return j; }
    await new Promise(r => setTimeout(r, 1000));
  }
}
$('prepBtn').onclick = async () => {
  const name = $('fileSel').value; if (!name) return;
  const files = await loadFiles(), f = files.find(f => f.name === name);
  if (f && f.ready) return openFile(name);
  await fetch(`/api/prepare?name=${encodeURIComponent(name)}`, { method: 'POST' });
  const j = await pollJob(name, f && f.job && f.job.kind === 'imu' ? 'Giroscopio' : 'Preparazione');
  if (j.status === 'error') return alert('Errore nella preparazione:\n' + j.error);
  await loadFiles(); $('fileSel').value = name; openFile(name);
};
$('fileSel').onchange = async () => {
  const files = await loadFiles(), f = files.find(f => f.name === $('fileSel').value);
  $('prepBtn').textContent = f && f.ready ? 'Apri' : 'Prepara';
};
$('exportBtn').onclick = async () => {
  const [W, H] = outSize(), F = P.format, label = `${F.ratio === 'custom' ? F.cw + 'x' + F.ch : F.ratio.replace(':', 'x')}_${F.res}p`;
  const ext = F.codec === 'prores' ? 'mov' : 'mp4';
  if (!META || !confirm(`Esporto in ${W}×${H} (${F.ratio === 'custom' ? F.cw + ':' + F.ch : F.ratio}, ${CODECS[F.codec]}) dal file originale 8K.\nSalvo ${stemOf(FILE)}_regia_${label}.${ext} sulla Scrivania. Procedo?`)) return;
  const frames = [];
  for (let i = 0; i < META.nframes; i++) {
    const t = i / META.fps, v = viewAt(t), R = renderRot(t, v);
    frames.push([R.flat().map(x => +x.toFixed(6)), +v.fov.toFixed(3)]);
  }
  const r = await fetch(`/api/export?name=${encodeURIComponent(FILE)}`, { method: 'POST', body: JSON.stringify({ frames, width: W, height: H, codec: F.codec, quality: F.quality, label }) });
  if (!r.ok) return alert((await r.json()).error);
  const j = await pollJob(FILE, 'Export');
  if (j.status === 'error') return alert('Errore export:\n' + j.error);
  if (confirm(`Fatto: ${j.out}. Mostrarlo nel Finder?`)) fetch(`/api/reveal?name=${encodeURIComponent(j.out)}`, { method: 'POST' });
};

(async () => {
  const files = await loadFiles();
  const ready = files.find(f => f.ready);
  if (ready) { $('fileSel').value = ready.name; $('prepBtn').textContent = 'Apri'; openFile(ready.name); }
  else $('fileSel').onchange();
  for (const f of files) if (f.job && f.job.status === 'running') { $('fileSel').value = f.name; $('prepBtn').onclick(); break; }
})();

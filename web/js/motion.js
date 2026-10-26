'use strict';
// ===================== movimento di camera =====================
const FRAMINGS = { a: ['Stretto', 32], s: ['Medio', 52], d: ['Largo', 78], f: ['Totale', 110] };
// tagli sul corpo (per soggetti-persona): campo verticale = altezza persona × k; mira spostata verso la testa
const BODY = { close: ['Primo piano', 0.42, 0.33], medium: ['Mezza figura', 0.78, 0.2], full: ['Figura intera', 1.3, 0.02] };
const COLORS = ['#ff7a3d', '#3dd6c6', '#f5c542', '#b48cff', '#ff5d8f', '#6fd36f', '#5aa9ff', '#ffa8a8', '#c9e265'];
const MODES = { move: 'Movimento', glide: 'Scivola dal precedente', cut: 'Stacco' };
const minJerk = s => s * s * s * (10 - 15 * s + 6 * s * s);
const easeInOut = s => s < 0.5 ? 4 * s * s * s : 1 - Math.pow(-2 * s + 2, 3) / 2;
const CURVES = {
  morbida: ['Morbida', s => minJerk(Math.pow(s, 0.82))], // accelera deciso e "atterra" lento, come un operatore
  lineare: ['Costante', s => s],
  decisa: ['Partenza decisa', s => 1 - Math.pow(1 - s, 3)],
  lenta: ['Partenza lenta', s => s * s * (2 - s)],
  elastica: ['Con assestamento', s => { const k = 1 - Math.pow(1 - s, 3); return k + Math.sin(Math.PI * s) * 0.06 * (1 - s); }],
};
const curveFn = (kf, dflt) => (CURVES[kf.curve] ? CURVES[kf.curve][1] : dflt);
const lerpFov = (a, b, e) => { // interpolazione "percettiva" dello zoom
  const ta = Math.tan(Math.min(a, 170) * D2R / 2), tb = Math.tan(Math.min(b, 170) * D2R / 2);
  if (a > 170 || b > 170) return a + (b - a) * e;
  return 2 * Math.atan(Math.exp(Math.log(ta) + (Math.log(tb) - Math.log(ta)) * e)) * R2D;
};
const projK = fov => smoothstep(95, 150, fov); // grandangoli: da rettilineo a stereografico
const subjOf = id => id != null ? P.subjects.find(s => s.id === id) : null;
const subjColor = s => COLORS[Math.max(0, P.subjects.indexOf(s)) % COLORS.length];

// ---- percorsi dei soggetti (tracking) ----
const pathCache = new Map();
function trkMap(s) { const m = new Map(); (s.trk || []).forEach(r => r.pts.forEach((p, k) => m.set(r.f0 + k, p))); return m; }
function setTrk(s, m) {
  const keys = [...m.keys()].sort((a, b) => a - b), out = [];
  for (const k of keys) {
    const last = out[out.length - 1];
    if (last && last.f0 + last.pts.length === k) last.pts.push(m.get(k)); else out.push({ f0: k, pts: [m.get(k)] });
  }
  s.trk = out; pathCache.delete(s.id);
}
function subjPath(s) {
  let c = pathCache.get(s.id);
  if (c && c.follow === P.settings.follow && c.n === META.nframes) return c;
  const n = META.nframes, raw = new Float32Array(n * 3), have = new Uint8Array(n), size = new Float32Array(n * 2);
  trkMap(s).forEach((p, f) => {
    if (f < 0 || f >= n) return;
    raw.set(dirOf(p[0], p[1]), f * 3); have[f] = 1; size[f * 2] = p[2]; size[f * 2 + 1] = p[3];
  });
  const sig = Math.max(0.5, P.settings.follow * META.fps * 0.6), R = Math.ceil(sig * 2.5);
  const w = Array.from({ length: 2 * R + 1 }, (_, k) => Math.exp(-((k - R) ** 2) / (2 * sig * sig)));
  const dirs = new Float32Array(n * 3), sz = new Float32Array(n * 2);
  for (let f = 0; f < n; f++) {
    if (!have[f]) continue;
    let x = 0, y = 0, z = 0, a = 0, b = 0, ws = 0;
    for (let k = -R; k <= R; k++) {
      const g = f + k; if (g < 0 || g >= n || !have[g]) continue;
      const ww = w[k + R]; x += raw[g * 3] * ww; y += raw[g * 3 + 1] * ww; z += raw[g * 3 + 2] * ww;
      a += size[g * 2] * ww; b += size[g * 2 + 1] * ww; ws += ww;
    }
    dirs.set(norm([x, y, z]), f * 3); sz[f * 2] = a / ws; sz[f * 2 + 1] = b / ws;
  }
  const near = new Int32Array(n).fill(-1), lim = Math.round(3 * META.fps);
  let last = -1e9;
  for (let f = 0; f < n; f++) { if (have[f]) last = f; if (f - last <= lim) near[f] = last; }
  last = 1e9;
  for (let f = n - 1; f >= 0; f--) { if (have[f]) last = f; if (last - f <= lim && (near[f] < 0 || last - f < f - near[f])) near[f] = last; }
  c = { follow: P.settings.follow, n, dirs, near, size: sz, have };
  pathCache.set(s.id, c);
  return c;
}
const frameOf = t => clamp(Math.round(t * META.fps), 0, META.nframes - 1);
function subjDir(s, t) {
  if (META && s.trk && s.trk.length) {
    const c = subjPath(s), k = c.near[frameOf(t)];
    if (k >= 0) return [c.dirs[k * 3], c.dirs[k * 3 + 1], c.dirs[k * 3 + 2]];
  }
  return dirOf(s.yaw, s.pitch);
}
function subjSize(s, t) { // [larghezza°, altezza°, tracciato in questo frame]
  if (META && s.trk && s.trk.length) {
    const c = subjPath(s), k = c.near[frameOf(t)];
    if (k >= 0) return [c.size[k * 2], c.size[k * 2 + 1], k === frameOf(t)];
  }
  return [s.w || 15, s.h || 25, false];
}
function groupView(t) { // inquadra tutti i soggetti
  if (!P.subjects.length) return { dir: dirOf(P.free.yaw, P.free.pitch), fov: 110 };
  const ds = P.subjects.map(s => subjDir(s, t));
  const c = norm(ds.reduce((a, d) => [a[0] + d[0], a[1] + d[1], a[2] + d[2]], [0, 0, 0]));
  let spread = 0;
  P.subjects.forEach((s, i) => { spread = Math.max(spread, Math.acos(clamp(dot(c, ds[i]), -1, 1)) * R2D + subjSize(s, t)[0] / 2); });
  return { dir: c, fov: clamp(spread * 2.3, 60, 150) };
}
const vToLong = vf => { const a = ratioOf(); return a >= 1 ? 2 * Math.atan(Math.tan(vf * D2R / 2) * a) * R2D : vf; };

// ---- keyframe ----
function kfTarget(kf, t) { // direzione e campo voluti in quell'istante
  if (kf.group) { const g = groupView(t); return { dir: g.dir, fov: kf.fov ? kf.fov : g.fov }; }
  const s = subjOf(kf.sid);
  if (s) {
    let [y, p] = yawPitchOf(subjDir(s, t));
    let fov = kf.fov;
    if (kf.body && BODY[kf.body]) {
      const h = subjSize(s, t)[1], B = BODY[kf.body];
      p += h * B[2];
      fov = clamp(vToLong(h * B[1]), 12, 150);
    }
    return { dir: dirOf(y + (kf.dy || 0), clamp(p + (kf.dp || 0), -89.9, 89.9)), fov };
  }
  return { dir: dirOf(kf.yaw, kf.pitch), fov: kf.fov };
}
function autoDuration(angle, fa, fb) {
  const z = Math.abs(Math.log(Math.tan(Math.min(fb, 170) * D2R / 2) / Math.tan(Math.min(fa, 170) * D2R / 2)));
  return clamp(0.55 + 1.7 * Math.sqrt(angle / 180) + 0.9 * z, 0.6, 4) * P.settings.pace;
}
let segs = [];
function rebuild(save = true) {
  P.kfs.sort((a, b) => a.t - b.t);
  segs = [];
  for (let i = 0; i < P.kfs.length; i++) {
    const kf = P.kfs[i];
    const sg = { t: kf.t, kf, i, dur: 0, angle: 0, breathe: 0 };
    segs.push(sg);
    const to = kfTarget(kf, kf.t);
    sg.from = i ? evalSeg(i - 1, kf.t) : to;
    sg.angle = Math.acos(clamp(dot(sg.from.dir, to.dir), -1, 1)) * R2D;
    if (i && kf.mode === 'move') {
      sg.dur = kf.dur || autoDuration(sg.angle, sg.from.fov, to.fov);
      sg.breathe = sg.angle > 25 ? Math.min(28, (sg.angle - 25) * 0.3) * P.settings.breathe * (kf.breathe ?? 1) : 0;
    }
  }
  if (save) scheduleSave();
}
function evalSeg(i, t) {
  const sg = segs[i], kf = sg.kf, tg = kfTarget(kf, t);
  let dir = tg.dir, fov = tg.fov, moving = false;
  if (sg.dur > 0 && t < sg.t + sg.dur) {
    const e = curveFn(kf, CURVES.morbida[1])(clamp((t - sg.t) / sg.dur, 0, 1));
    dir = slerpDir(sg.from.dir, dir, e);
    fov = Math.min(300, lerpFov(sg.from.fov, tg.fov, e) + sg.breathe * Math.sin(Math.PI * e));
    moving = true;
  }
  const nx = P.kfs[i + 1];
  if (nx && nx.mode === 'glide' && nx.t > sg.t) { // il prossimo keyframe "tira" la camera per tutto l'intervallo
    const e = curveFn(nx, easeInOut)(clamp((t - sg.t) / (nx.t - sg.t), 0, 1)), nt = kfTarget(nx, t);
    dir = slerpDir(dir, nt.dir, e); fov = lerpFov(fov, nt.fov, e); moving = moving || (e > 0 && e < 1);
  }
  return { dir, fov, moving };
}
function viewAt(t) {
  if (!segs.length) return { dir: dirOf(P.free.yaw, P.free.pitch), fov: P.free.fov };
  return evalSeg(Math.max(0, segIndex(t)), t);
}
function segIndex(t) {
  let lo = 0, hi = segs.length - 1, r = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (segs[m].t <= t + 1e-6) { r = m; lo = m + 1; } else hi = m - 1; }
  return r;
}

// ===================== montaggio: tagli, intervallo, velocità =====================
function mergedCuts() {
  const c = P.cuts.map(x => [Math.min(x[0], x[1]), Math.max(x[0], x[1])]).sort((a, b) => a[0] - b[0]), out = [];
  for (const x of c) { const l = out[out.length - 1]; if (l && x[0] <= l[1]) l[1] = Math.max(l[1], x[1]); else out.push([...x]); }
  return out;
}
function cutAt(t) { return mergedCuts().find(c => t >= c[0] && t < c[1]); }
function speedAt(t) { const s = P.speeds.find(s => t >= s.t0 && t < s.t1); return s ? s.speed : 1; }
function keptRanges() { // intervalli della timeline che finiscono nel video
  const a = P.range ? Math.max(0, P.range[0]) : 0, b = P.range ? Math.min(META.duration, P.range[1]) : META.duration;
  const out = []; let t = a;
  for (const c of mergedCuts()) {
    if (c[1] <= t || c[0] >= b) continue;
    if (c[0] > t) out.push([t, c[0]]);
    t = Math.max(t, c[1]);
  }
  if (t < b) out.push([t, b]);
  return out.filter(r => r[1] - r[0] > 1 / META.fps);
}
function outputPlan() { // segmenti a velocità costante: frame sorgente e istanti per la camera
  const fps = META.fps, plan = [];
  for (const [a, b] of keptRanges()) {
    const bounds = new Set([a, b]);
    P.speeds.forEach(s => { if (s.t0 > a && s.t0 < b) bounds.add(s.t0); if (s.t1 > a && s.t1 < b) bounds.add(s.t1); });
    const bs = [...bounds].sort((x, y) => x - y);
    for (let i = 0; i + 1 < bs.length; i++) {
      const t0 = bs[i], t1 = bs[i + 1], sp = speedAt((t0 + t1) / 2);
      const n = Math.max(1, Math.round((t1 - t0) / sp * fps));
      const times = Array.from({ length: n }, (_, k) => t0 + k * sp / fps);
      plan.push({ t0, t1, speed: sp, times, src: times.map(frameOf) });
    }
  }
  return plan;
}
function outputDuration() { return outputPlan().reduce((a, s) => a + s.times.length, 0) / META.fps; }

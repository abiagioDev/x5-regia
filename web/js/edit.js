'use strict';
// ===================== keyframe, soggetti, tracking, montaggio =====================
let selKf = null, selSubj = null, selCut = null, selSpeed = null, markIn = null, candidates = null;

// ---- keyframe ----
function kfAtNow() { const i = segIndex(curTime()); return i >= 0 ? P.kfs[i] : null; }
function putKf(props) {
  const t = curTime();
  let kf = P.kfs.find(k => Math.abs(k.t - t) < 0.2);
  if (!kf) { kf = { t, dy: 0, dp: 0, mode: 'move', dur: null }; P.kfs.push(kf); }
  delete kf.body; delete kf.group;
  Object.assign(kf, props);
  selKf = kf; rebuild(); renderKfPanel(); requestDraw();
  return kf;
}
function addKeyframeHere() { // fissa lo stato attuale: soggetto seguito o direzione libera
  const v = viewAt(curTime()), cur = kfAtNow(), su = cur && subjOf(cur.sid);
  const mode = P.kfs.length ? 'glide' : 'move';
  if (cur && cur.group) putKf({ group: true, sid: null, fov: cur.fov, mode });
  else if (su) putKf({ sid: su.id, dy: cur.dy || 0, dp: cur.dp || 0, fov: v.fov, body: cur.body, mode });
  else { const [yaw, pitch] = yawPitchOf(v.dir); putKf({ sid: null, yaw, pitch, fov: v.fov, mode }); }
}
function goSubject(s, cut) {
  putKf({ sid: s.id, dy: 0, dp: 0, fov: s.fov || 52, body: s.person ? 'medium' : undefined, mode: cut ? 'cut' : 'move', dur: null });
}
function setFraming(fov, body) {
  const cur = kfAtNow();
  if (!cur) { P.free.fov = fov; scheduleSave(); requestDraw(); return; }
  const apply = k => { k.fov = fov; if (body && subjOf(k.sid)) k.body = body; else delete k.body; };
  if (Math.abs(cur.t - curTime()) < 0.2 || (vid.paused && cur === selKf)) { apply(cur); rebuild(); renderKfPanel(); requestDraw(); }
  else { const k = putKf({ sid: cur.sid, group: cur.group, dy: cur.dy, dp: cur.dp, yaw: cur.yaw, pitch: cur.pitch, mode: 'move', dur: null }); apply(k); rebuild(); renderKfPanel(); }
}
function nudge(dyaw, dpitch) {
  const kf = kfAtNow();
  if (!kf) { P.free.yaw = wrap(P.free.yaw + dyaw); P.free.pitch = clamp(P.free.pitch + dpitch, -90, 90); scheduleSave(); requestDraw(); return; }
  if (subjOf(kf.sid)) { kf.dy = (kf.dy || 0) + dyaw; kf.dp = (kf.dp || 0) + dpitch; }
  else {
    const [y, p] = !kf.group && kf.yaw != null ? [kf.yaw, kf.pitch] : yawPitchOf(kfTarget(kf, curTime()).dir);
    if (kf.group) { kf.fov = kfTarget(kf, curTime()).fov; delete kf.group; }
    kf.yaw = wrap(y + dyaw); kf.pitch = clamp(p + dpitch, -90, 90); kf.sid = null;
  }
  selKf = kf; rebuild(); renderKfPanel(); requestDraw();
}
function aimAt(dirWorld) {
  const [y, p] = yawPitchOf(dirWorld), kf = kfAtNow();
  if (!kf) { P.free.yaw = y; P.free.pitch = p; scheduleSave(); requestDraw(); return; }
  const cur = yawPitchOf(kfTarget(kf, curTime()).dir);
  nudge(wrap(y - cur[0]), p - cur[1]);
}
function zoomBy(f) {
  const kf = kfAtNow();
  if (!kf) P.free.fov = clamp(P.free.fov * f, 12, 300);
  else { if (kf.body) { kf.fov = kfTarget(kf, curTime()).fov; delete kf.body; } kf.fov = clamp((kf.fov || 60) * f, 12, 300); rebuild(); renderKfPanel(); }
  scheduleSave(); requestDraw();
}
function deleteSelected() {
  if (selKf) { P.kfs = P.kfs.filter(k => k !== selKf); selKf = null; rebuild(); renderKfPanel(); }
  else if (selCut) { P.cuts = P.cuts.filter(c => !(Math.min(...c) >= selCut[0] && Math.max(...c) <= selCut[1])); selCut = null; scheduleSave(); renderEditPanel(); }
  else if (selSpeed) { P.speeds = P.speeds.filter(s => s !== selSpeed); selSpeed = null; scheduleSave(); renderEditPanel(); }
  requestDraw();
}

// ---- interazione sull'anteprima: mira, zoom, riquadri ----
let drag = null, boxDraw = null;
function ovlXY(e) { const r = ovl.getBoundingClientRect(), d = devicePixelRatio || 1; return [(e.clientX - r.left) * d, (e.clientY - r.top) * d]; }
ovl.addEventListener('mousedown', e => {
  if (!META) return;
  if (boxDraw) { const [x, y] = ovlXY(e); Object.assign(boxDraw, { x0: x, y0: y, x1: x, y1: y, down: true }); return; }
  if (candidates) { // clic su una persona proposta
    const [x, y] = ovlXY(e), v = viewAt(curTime()), ppd = Math.max(ovl.width, ovl.height) / v.fov;
    const hit = candidates.find(c => { const p = viewProject(v, dirOf(c.yaw, c.pitch)); return p && Math.abs(p[0] - x) < c.w * ppd / 2 && Math.abs(p[1] - y) < c.h * ppd / 2; });
    if (hit) { addCandidate(hit); return; }
  }
  drag = { x: e.clientX, y: e.clientY };
});
addEventListener('mousemove', e => {
  if (boxDraw && boxDraw.down) { [boxDraw.x1, boxDraw.y1] = ovlXY(e); requestDraw(); return; }
  if (!drag) return;
  const fov = Math.min(viewAt(curTime()).fov, 150), k = fov / Math.max(ovl.clientWidth, ovl.clientHeight);
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
  if (!s) s = newSubject({ yaw, pitch, fov: v.fov }); else { s.yaw = yaw; s.pitch = pitch; }
  if (!s) return;
  s.w = wd; s.h = hd;
  renderSubjects(); requestDraw();
  queueTrack(s, 1, { yaw, pitch, w: wd, h: hd });
});
ovl.addEventListener('wheel', e => { e.preventDefault(); zoomBy(Math.exp(e.deltaY * 0.002)); }, { passive: false });
ov.addEventListener('mousedown', e => {
  if (!META) return;
  const r = ov.getBoundingClientRect();
  const yaw = ((e.clientX - r.left) / r.width - 0.5) * 360, pitch = (0.5 - (e.clientY - r.top) / r.height) * 180;
  aimAt(mv(camMatrix(curTime()), dirOf(yaw, pitch)));
});
function beginBox(sid) { if (!META) return; vid.pause(); boxDraw = { sid: sid || null }; ovl.style.cursor = 'crosshair'; requestDraw(); }

// ---- soggetti ----
function newSubject(props) {
  if (P.subjects.length >= 9) { toast('Massimo 9 soggetti (tasti 1–9).'); return null; }
  const id = Math.random().toString(36).slice(2, 8);
  const s = { id, name: props.name || `Soggetto ${P.subjects.length + 1}`, fov: clamp(props.fov || 52, 30, 80), w: 15, h: 25,
    key: P.subjects.length + 1, trk: [], ...props };
  delete s.conf;
  P.subjects.push(s); selSubj = id; scheduleSave();
  return s;
}
async function detectPeople() {
  if (!META) return;
  vid.pause();
  const t = curTime(), tid = 'scan_' + Date.now().toString(36);
  try {
    await api.post(`/api/track?pid=${PID}`, { mode: 'detect', tid, frame: frameOf(t), settings: P.settings });
  } catch (e) { return toast(e.message); }
  const j = await pollJob(`${PID}#track`, 'Ricerca persone');
  if (j.status !== 'done') return toast('Ricerca non riuscita: ' + (j.error || ''));
  const res = await api.get(`/media/${PID}/${j.out}`);
  // scarta chi è già un soggetto
  candidates = res.people.filter(c => !P.subjects.some(s => Math.acos(clamp(dot(subjDir(s, t), dirOf(c.yaw, c.pitch)), -1, 1)) * R2D < c.h * 0.4));
  renderSubjects(); requestDraw();
  toast(candidates.length ? `${candidates.length} persone trovate: clicca su un riquadro bianco o "Aggiungi tutte"` : 'Nessuna nuova persona trovata qui');
}
function addCandidate(c, track = true) {
  const s = newSubject({ yaw: c.yaw, pitch: c.pitch, w: c.w, h: c.h, person: true, name: `Persona ${P.subjects.length + 1}` });
  candidates = candidates.filter(x => x !== c); if (!candidates.length) candidates = null;
  renderSubjects(); requestDraw();
  if (s && track) { queueTrack(s, 1, { yaw: c.yaw, pitch: c.pitch, w: c.w, h: c.h, person: true }); queueTrack(s, -1, { yaw: c.yaw, pitch: c.pitch, w: c.w, h: c.h, person: true }); }
  return s;
}

// ---- tracking (in coda, uno alla volta) ----
let trackJob = null, trackRunning = false;
const trackQueue = [];
function queueTrack(s, dir, init) {
  trackQueue.push({ sid: s.id, dir, init, t: curTime() });
  if (!trackRunning) runTrackQueue();
  renderSubjects();
}
async function runTrackQueue() {
  trackRunning = true;
  try { while (trackQueue.length) {
    const q = trackQueue.shift(), s = subjOf(q.sid);
    if (!s) continue;
    let init = q.init;
    if (!init) { const [w, h] = subjSize(s, q.t), [yaw, pitch] = yawPitchOf(subjDir(s, q.t)); init = { yaw, pitch, w, h }; }
    const tid = s.id + '_' + Date.now().toString(36);
    try {
      await api.post(`/api/track?pid=${PID}`, { tid, frame: frameOf(q.t), dir: q.dir, person: s.person ? true : null, ...init, settings: P.settings });
    } catch (e) {
      if (/in corso/.test(e.message)) { trackQueue.unshift(q); await new Promise(r => setTimeout(r, 1500)); continue; } // un altro lavoro sta finendo
      toast(e.message); continue;
    }
    trackJob = { sid: s.id, t0: q.t, dir: q.dir, progress: 0, span: q.dir > 0 ? META.duration - q.t : q.t };
    renderSubjects();
    const j = await pollJob(`${PID}#track`, `Tracking ${s.name}`, st => { trackJob.progress = st.progress || 0; requestDraw(); });
    trackJob = null;
    if (j.status !== 'done') { toast('Tracking interrotto' + (j.error ? ': ' + j.error.slice(-120) : '')); continue; }
    const res = await api.get(`/media/${PID}/${j.out}`);
    const m = trkMap(s); res.pts.forEach((p, k) => m.set(res.f0 + k, p));
    setTrk(s, m); rebuild(); renderSubjects(); requestDraw();
    toast(`${s.name}: seguito per ${(res.pts.length / META.fps).toFixed(1)} s`);
  } } finally { trackRunning = false; }
  renderSubjects();
}
function clearTrack(s, fromT, dir) {
  const f = frameOf(fromT), m = trkMap(s);
  [...m.keys()].forEach(k => { if (dir > 0 ? k >= f : k <= f) m.delete(k); });
  setTrk(s, m); rebuild(); renderSubjects(); requestDraw();
}

// ---- montaggio ----
function setIn() { markIn = curTime(); if (P.range && P.range[1] > markIn) P.range = [markIn, P.range[1]]; renderEditPanel(); requestDraw(); }
function setOut() {
  const t = curTime();
  P.range = [markIn != null && markIn < t ? markIn : (P.range ? P.range[0] : 0), t];
  markIn = null; scheduleSave(); renderEditPanel(); requestDraw();
}
function cutRange() { // toglie il tratto tra il segno di inizio (I) e la testina
  const t = curTime();
  if (markIn == null) return toast('Premi I all\'inizio del pezzo da togliere, poi X alla fine');
  const a = Math.min(markIn, t), b = Math.max(markIn, t);
  if (b - a < 0.05) return;
  P.cuts.push([a, b]); markIn = null; scheduleSave(); renderEditPanel(); requestDraw();
  toast(`Tolti ${fmt(b - a)} · ⌘Z per annullare`);
}
function addSpeed(speed) {
  const t = curTime(), a = markIn != null ? Math.min(markIn, t) : t, b = markIn != null ? Math.max(markIn, t) : Math.min(META.duration, t + 4);
  P.speeds = P.speeds.filter(s => s.t1 <= a || s.t0 >= b);
  const sp = { t0: a, t1: b, speed }; P.speeds.push(sp); P.speeds.sort((x, y) => x.t0 - y.t0);
  selSpeed = sp; markIn = null; scheduleSave(); renderEditPanel(); requestDraw();
}

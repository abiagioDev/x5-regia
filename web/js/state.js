'use strict';
// ===================== progetto, salvataggio, annulla/ripeti =====================
let META = null, ORIENT = null, PEAKS = null, PID = null;
let P = blankProject();

function blankProject() {
  return {
    name: '', clips: [], subjects: [], kfs: [], cuts: [], speeds: [], range: null,
    free: { yaw: 0, pitch: 0, fov: 78 },
    settings: { pace: 1, breathe: 1, follow: 0.5, showBoxes: true, stab: true, axis: 0, gyroOffset: 0, stitch: 0 },
    format: { ratio: '16:9', cw: 16, ch: 9, res: 1080, codec: 'hevc', quality: 'alta', guide: '' },
    grade: { exposure: 0, contrast: 1, saturation: 1, temperature: 0, tint: 0, lut: '', lutMix: 1 },
    audio: { path: '', offset: 0, cam: 1, ext: 1 },
    queue: [],
  };
}
function migrate(p) {
  if (p.musicians && !p.subjects) p.subjects = p.musicians.map(m => ({ ...m, trk: [] }));
  if (p.shots && !p.kfs) p.kfs = p.shots.map(s => ({ t: s.t, sid: s.mid ?? null, dy: s.dy || 0, dp: s.dp || 0, yaw: s.yaw, pitch: s.pitch,
    fov: s.fov, mode: s.cut ? 'cut' : 'move', dur: s.dur || null, breathe: s.breathe }));
  delete p.musicians; delete p.shots;
  const b = blankProject();
  const out = Object.assign(b, p);
  for (const k of ['settings', 'format', 'grade', 'audio', 'free']) out[k] = Object.assign(blankProject()[k], p[k] || {});
  return out;
}

// ---- salvataggio (con raggruppamento delle modifiche per l'annulla) ----
let saveTimer = null, undoStack = [], redoStack = [], lastSnap = null;
const snap = () => JSON.stringify(P);
function commitUndo() {
  const cur = snap();
  if (lastSnap !== null && cur !== lastSnap) {
    undoStack.push(lastSnap); if (undoStack.length > 80) undoStack.shift();
    redoStack = [];
  }
  lastSnap = cur;
  updateUndoButtons();
}
function scheduleSave() {
  if (!PID) return;
  $('saveState').textContent = 'modifiche…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 700);
}
async function flushSave() {
  clearTimeout(saveTimer); saveTimer = null;
  if (!PID) return;
  commitUndo();
  const r = await api.post(`/api/project?pid=${encodeURIComponent(PID)}`, P);
  $('saveState').textContent = 'salvato';
  if (r.rebuild) buildProject();
}
function restoreSnap(json) {
  const clipsBefore = JSON.stringify(P.clips);
  P = migrate(JSON.parse(json)); lastSnap = json;
  pathCache.clear(); selKf = null; selCut = null; selSpeed = null;
  afterLoad(false);
  api.post(`/api/project?pid=${encodeURIComponent(PID)}`, P).then(r => {
    $('saveState').textContent = 'salvato';
    if (r.rebuild && JSON.stringify(P.clips) !== clipsBefore) buildProject();
  });
}
async function undo() {
  if (saveTimer) await flushSave();
  if (!undoStack.length) return toast('Niente da annullare');
  redoStack.push(snap()); restoreSnap(undoStack.pop()); updateUndoButtons();
}
async function redo() {
  if (saveTimer) await flushSave();
  if (!redoStack.length) return toast('Niente da ripetere');
  undoStack.push(snap()); restoreSnap(redoStack.pop()); updateUndoButtons();
}
function updateUndoButtons() { $('undoBtn').disabled = !undoStack.length; $('redoBtn').disabled = !redoStack.length; }

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
function aspVec(a = ratioOf()) { return a >= 1 ? [1, 1 / a] : [a, 1]; }
function ratioLabel(f = P.format) { return f.ratio === 'custom' ? `${f.cw}:${f.ch}` : f.ratio; }

// ---- orientamento della camera ----
function camMatrix(t) { // camera -> mondo
  if (!ORIENT || !P.settings.stab) return I3;
  const i = clamp(Math.round((t + P.settings.gyroOffset / 1000) * META.fps), 0, ORIENT.length - 1);
  const M = AXIS_MAPS[P.settings.axis];
  return mmul(mmul(M, quatMat(ORIENT[i])), mT(M));
}
function renderRot(t, view) { return mmul(mT(camMatrix(t)), viewMatrix(view.dir)); } // vista -> camera

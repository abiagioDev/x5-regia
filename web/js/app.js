'use strict';
// ===================== trasporto =====================
let frameTime = 0;
const curTime = () => frameTime;
function seek(t) {
  if (!META) return;
  t = clamp(t, 0, META.duration - 0.01); vid.currentTime = t; frameTime = t; syncExtAudio(true); requestDraw();
}
function togglePlay() { if (vid.paused) { const c = cutAt(curTime()); if (c) seek(c[1]); vid.play(); } else vid.pause(); }
$('playBtn').onclick = togglePlay;
vid.addEventListener('play', () => { $('playBtn').textContent = '❚❚'; syncExtAudio(true); });
vid.addEventListener('pause', () => { $('playBtn').textContent = '▶'; frameTime = vid.currentTime; extAudio.pause(); requestDraw(); });
vid.addEventListener('seeked', requestDraw);
vid.addEventListener('loadeddata', requestDraw);
function onFrame(_, md) {
  frameTime = md.mediaTime;
  if (!vid.paused && META) {
    const c = cutAt(frameTime); // salta i pezzi tolti e rispetta intervallo e velocità
    if (c) seek(c[1]);
    else if (P.range && frameTime >= P.range[1]) { vid.pause(); }
    const sp = speedAt(frameTime);
    if (Math.abs(vid.playbackRate - sp) > 1e-3) vid.playbackRate = clamp(sp, 0.0625, 16);
    syncExtAudio(false);
  }
  draw(); vid.requestVideoFrameCallback(onFrame);
}
vid.requestVideoFrameCallback(onFrame);
addEventListener('resize', requestDraw);
function updateHud(t, view) {
  $('tc').textContent = fmt(t);
  const kf = kfAtNow(), su = kf && subjOf(kf.sid);
  $('hud').textContent = `${kf && kf.group ? 'Tutti' : su ? su.name : kf ? 'Direzione libera' : 'Vista libera'} · ${Math.round(view.fov)}°${view.moving ? ' · in movimento' : ''}${speedAt(t) !== 1 ? ` · ${speedAt(t)}×` : ''}`;
}

// ===================== tastiera =====================
addEventListener('keydown', e => {
  if (e.target.matches('input:not([type=range]):not([type=checkbox]), select, textarea')) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); flushSave(); return; }
  if (!META || e.metaKey || e.ctrlKey) return;
  const k = e.key.toLowerCase();
  if (e.key === 'Escape') { boxDraw = null; candidates = null; ovl.style.cursor = ''; markIn = null; renderSubjects(); renderEditPanel(); requestDraw(); return; }
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); return; }
  const dm = e.code.match(/^Digit([1-9])$/);
  if (dm) { const s = P.subjects[+dm[1] - 1]; if (s) goSubject(s, e.shiftKey); e.preventDefault(); return; }
  if (k === '0') { putKf({ group: true, sid: null, fov: 0, mode: e.shiftKey ? 'cut' : 'move', dur: null }); return; }
  if (FRAMINGS[k]) { const kf = kfAtNow(), su = kf && subjOf(kf.sid);
    const body = su && su.person ? { a: 'close', s: 'medium', d: 'full' }[k] : null;
    setFraming(FRAMINGS[k][1], body); return; }
  if (k === 'k') { addKeyframeHere(); return; }
  if (k === 't') { beginBox(null); return; }
  if (k === 'p') { detectPeople(); return; }
  if (k === 'i') { setIn(); return; }
  if (k === 'o') { setOut(); return; }
  if (k === 'x') { cutRange(); return; }
  if (k === 'j' || k === 'l') { seek(curTime() + (k === 'j' ? -2 : 2)); return; }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault(); const d = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 5 : 1 / META.fps);
    vid.pause(); seek(curTime() + d); return;
  }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault(); const t = curTime();
    const kf = e.key === 'ArrowUp' ? [...P.kfs].reverse().find(q => q.t < t - 0.01) : P.kfs.find(q => q.t > t + 0.01);
    if (kf) { selKf = kf; seek(kf.t); renderKfPanel(); } return;
  }
  if (e.key === 'Backspace' || e.key === 'Delete') { deleteSelected(); e.preventDefault(); }
});
$('undoBtn').onclick = undo; $('redoBtn').onclick = redo;

// ===================== progetti =====================
async function loadProjects(select) {
  const list = await api.get('/api/projects'), sel = $('projSel');
  sel.innerHTML = list.map(p => `<option value="${p.pid}">${esc(p.name)} · ${p.clips.length} clip</option>`).join('') +
    '<option value="__new">+ Nuovo progetto…</option>';
  if (select) sel.value = select;
  return list;
}
$('projSel').onchange = e => { if (e.target.value === '__new') { openNewDialog(); e.target.value = PID || ''; } else openProject(e.target.value); };
async function openProject(pid) {
  if (saveTimer) await flushSave();
  PID = pid; META = null; ORIENT = null; PEAKS = null; texReady = false;
  localStorage.setItem('x5-last', pid);
  P = migrate(await api.get(`/api/project?pid=${encodeURIComponent(pid)}`));
  undoStack = []; redoStack = []; lastSnap = snap(); updateUndoButtons();
  const list = await loadProjects(pid), info = list.find(p => p.pid === pid);
  $('empty').classList.remove('hidden');
  if (!info || !info.ready) return buildProject();
  await loadMedia();
}
async function buildProject() {
  $('emptyMsg').innerHTML = 'Preparo le clip del progetto…<br><span class="muted">La prima volta crea una copia leggera per l\'anteprima (circa 1/3 della durata).</span>';
  $('empty').classList.remove('hidden');
  try { await api.post(`/api/build?pid=${encodeURIComponent(PID)}`); } catch (e) { /* già in corso */ }
  const j = await pollJob(`${PID}#build`, 'Preparazione');
  if (j.status !== 'done') { $('emptyMsg').textContent = 'Errore nella preparazione: ' + (j.error || ''); return; }
  await loadMedia();
}
async function loadMedia() {
  const base = `/media/${encodeURIComponent(PID)}/`;
  META = await api.get(base + 'meta.json');
  ORIENT = await fetch(base + 'orient.json').then(r => r.ok ? r.json() : null);
  PEAKS = await fetch(base + 'peaks.json').then(r => r.ok ? r.json() : null);
  vid.src = base + 'proxy.mp4?v=' + META.signature; frameTime = 0; texReady = false;
  tlView = [0, META.duration];
  gl.useProgram(prog); setLensUniforms();
  $('empty').classList.add('hidden'); $('exportBtn').disabled = false;
  $('durLbl').textContent = '/ ' + fmt(META.duration) + (ORIENT ? '' : ' · giroscopio non trovato');
  afterLoad(true);
}
function afterLoad(full) {
  pathCache.clear(); rebuild(false);
  bindSettings(); bindFormat(); renderSubjects(); renderKfPanel(); renderEditPanel(); renderClips();
  if (full) { renderAudioPanel(); renderColorPanel(); setupExtAudio(); }
  loadLut(P.grade.lut); $('saveState').textContent = '';
  requestDraw();
}
// ---- nuovo progetto ----
async function openNewDialog() {
  const dlg = $('newDlg'), lib = await api.get('/api/library'), order = [];
  const render = files => {
    $('newFiles').innerHTML = files.length ? files.map(f => `<label class="frow"><input type="checkbox" value="${f.fid}"> <span>${esc(f.name)}</span>
      <span class="muted">${(f.size / 1e9).toFixed(1)} GB · ${new Date(f.mtime * 1000).toLocaleDateString()}${f.ready ? ' · pronto' : ''}</span><b class="ord"></b></label>`).join('')
      : `<div class="muted">Nessun .insv in ${esc(lib.dir)}. Usa "Importa…".</div>`;
    $('newFiles').querySelectorAll('input').forEach(cb => cb.onchange = () => {
      const i = order.indexOf(cb.value); if (cb.checked && i < 0) order.push(cb.value); if (!cb.checked && i >= 0) order.splice(i, 1);
      $('newFiles').querySelectorAll('label').forEach(l => { const v = l.querySelector('input').value, n = order.indexOf(v); l.querySelector('.ord').textContent = n >= 0 ? n + 1 : ''; });
      if (!$('newName').value || $('newName').dataset.auto) { $('newName').value = order.length ? lib.files.find(f => f.fid === order[0]).name.replace(/\.[^.]+$/, '') : ''; $('newName').dataset.auto = 1; }
    });
  };
  render(lib.files);
  $('newName').value = ''; $('newName').dataset.auto = 1; $('newName').oninput = () => delete $('newName').dataset.auto;
  $('newImport').onclick = async () => { await api.post('/api/import?kind=video'); const l2 = await api.get('/api/library'); lib.files = l2.files; order.length = 0; render(l2.files); };
  $('newCreate').onclick = async () => {
    if (!order.length) return toast('Scegli almeno una clip');
    const r = await api.post('/api/projects', { name: $('newName').value || 'Progetto', clips: order });
    dlg.close(); openProject(r.pid);
  };
  $('newCancel').onclick = () => dlg.close();
  dlg.showModal();
}
$('importBtn').onclick = openNewDialog;

// ===================== regia automatica =====================
$('autoBtn').onclick = async () => {
  if (!META) return;
  if (!P.subjects.length && !confirm('Non ci sono soggetti: la regia userà solo inquadrature larghe. Conviene prima "Trova persone" (P). Continuo?')) return;
  if (P.kfs.length && !confirm(`La regia automatica sostituisce i ${P.kfs.length} keyframe attuali (⌘Z per tornare indietro). Procedo?`)) return;
  const times = []; for (let t = 0; t < META.duration; t += 0.5) times.push(+t.toFixed(3));
  const subjects = P.subjects.map(s => ({ id: s.id, dirs: times.map(t => subjDir(s, t)), sizes: times.map(t => subjSize(s, t).slice(0, 2)) }));
  await api.post(`/api/director?pid=${PID}`, { times, subjects, duration: META.duration, pace: P.settings.pace, settings: P.settings,
    framings: [52, 34, 78] });
  const j = await pollJob(`${PID}#director`, 'Regia automatica');
  if (j.status !== 'done') return toast('Regia automatica non riuscita: ' + (j.error || ''));
  P.kfs = j.out.kfs.map(k => {
    const su = subjOf(k.sid);
    const kf = { t: k.t, sid: k.sid, mode: k.mode, dy: 0, dp: 0, dur: null };
    if (k.wide) { kf.group = true; kf.fov = 0; }
    else if (su && su.person) kf.body = { 52: 'medium', 34: 'close', 78: 'full' }[k.fov] || 'medium';
    else kf.fov = k.fov;
    return kf;
  });
  selKf = null; rebuild(); renderKfPanel(); requestDraw();
  toast(`Regia pronta: ${P.kfs.length} inquadrature a ~${Math.round(j.out.bpm)} BPM. Ritocca liberamente.`, 5000);
};

// ===================== export =====================
function exportPayload(fmtObj) {
  const [W, H] = outSize(fmtObj), plan = outputPlan();
  const segments = plan.map(sg => ({ speed: sg.speed, src: sg.src, frames: sg.times.map(t => {
    const v = viewAt(t), R = renderRot(t, v);
    return [R.flat().map(x => +x.toFixed(6)), +v.fov.toFixed(3), +projK(v.fov).toFixed(3), P.settings.stitch || 0];
  }) }));
  const label = `${ratioLabel(fmtObj).replace(':', 'x')}_${fmtObj.res}p`;
  return { segments, width: W, height: H, codec: fmtObj.codec, quality: fmtObj.quality, label,
    grade: { ...P.grade, gainA: META.shader.gainA, gainB: META.shader.gainB }, audio: P.audio };
}
async function runExport(fmtObj) {
  if (saveTimer) await flushSave();
  const payload = exportPayload(fmtObj);
  const r = await api.post(`/api/export?pid=${encodeURIComponent(PID)}`, payload);
  const j = await pollJob(r.key, `Export ${formatLabel(fmtObj)}`);
  if (j.status !== 'done') { toast('Export non riuscito: ' + (j.error || '').slice(-200), 8000); return null; }
  return j.out;
}
$('exportBtn').onclick = async () => {
  if (!META) return;
  const [W, H] = outSize();
  if (!confirm(`Esporto ${fmt(outputDuration(), false)} in ${W}×${H} (${formatLabel(P.format)}) dai file originali.\nProcedo?`)) return;
  const out = await runExport(P.format);
  if (out && confirm(`Fatto: ${out.split('/').pop()}\nMostrarlo nel Finder?`)) api.post(`/api/reveal?path=${encodeURIComponent(out)}`);
};
$('runQueue').onclick = async () => {
  const done = [];
  for (const q of [...P.queue]) { const out = await runExport(q); if (!out) break; done.push(out); }
  if (done.length && confirm(`Esportati ${done.length} file. Mostrare l'ultimo nel Finder?`)) api.post(`/api/reveal?path=${encodeURIComponent(done[done.length - 1])}`);
};

// ===================== pulsanti vari e avvio =====================
$('addSubj').onclick = () => beginBox(null);
$('detectBtn').onclick = detectPeople;
$('candAll').onclick = () => { [...(candidates || [])].forEach(c => addCandidate(c)); };
$('candNone').onclick = () => { candidates = null; renderSubjects(); requestDraw(); };
$('addKf').onclick = () => META && addKeyframeHere();
document.querySelectorAll('aside .panel h3').forEach(h => h.addEventListener('click', e => {
  if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
  h.parentElement.classList.toggle('closed');
  try { localStorage.setItem('x5-panels', JSON.stringify([...document.querySelectorAll('aside .panel.closed')].map(p => p.id))); } catch (_) {}
}));
try { (JSON.parse(localStorage.getItem('x5-panels')) || []).forEach(id => $(id) && $(id).classList.add('closed')); } catch (_) {}

(async () => {
  await initGL();
  const list = await loadProjects();
  const last = localStorage.getItem('x5-last');
  const pick = list.find(p => p.pid === last) || list[0];
  if (pick) openProject(pick.pid);
  else { $('emptyMsg').innerHTML = 'Crea un progetto: scegli una o più clip .insv.<br><button id="firstNew" class="primary">+ Nuovo progetto</button>'; $('firstNew').onclick = openNewDialog; }
})();

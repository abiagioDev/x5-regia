'use strict';
// ===================== pannelli laterali =====================
const on = (root, sel, ev, fn) => { const el = root.querySelector(sel); if (el) el.addEventListener(ev, fn); };

// ---- clip del progetto ----
function renderClips() {
  const b = $('clipBody');
  if (!META) { b.innerHTML = ''; return; }
  b.innerHTML = (META.clips || []).map((c, i) => `<div class="clip" data-i="${i}">
      <span class="num">${i + 1}</span><span class="nm" title="${esc(c.name)}">${esc(c.name)}</span><span class="muted">${fmt(c.duration, false)}</span>
      <span class="btns"><button data-a="up" ${i ? '' : 'disabled'}>↑</button><button data-a="down" ${i < META.clips.length - 1 ? '' : 'disabled'}>↓</button><button data-a="del" ${META.clips.length > 1 ? '' : 'disabled'}>✕</button></span>
    </div>`).join('') + `<div class="row"><select id="clipAdd"><option value="">+ Aggiungi clip in coda…</option></select><button id="clipImport" title="Importa da un'altra cartella o dalla scheda SD">Importa…</button></div>
    <div class="muted hint">Le clip vengono messe una dopo l'altra. Spostarle o toglierle sposta anche keyframe e tracking che stanno dopo.</div>`;
  api.get('/api/library').then(lib => {
    const sel = $('clipAdd'); if (!sel) return;
    lib.files.forEach(f => { const o = document.createElement('option'); o.value = f.fid; o.textContent = f.name; sel.appendChild(o); });
  });
  b.querySelectorAll('.clip button').forEach(btn => btn.onclick = () => {
    const i = +btn.closest('.clip').dataset.i, c = [...P.clips];
    if (btn.dataset.a === 'up') [c[i - 1], c[i]] = [c[i], c[i - 1]];
    if (btn.dataset.a === 'down') [c[i + 1], c[i]] = [c[i], c[i + 1]];
    if (btn.dataset.a === 'del' && !confirm(`Togliere ${META.clips[i].name} dal progetto?`)) return;
    if (btn.dataset.a === 'del') c.splice(i, 1);
    P.clips = c; flushSave();
  });
  on(b, '#clipAdd', 'change', e => { if (!e.target.value) return; P.clips = [...P.clips, e.target.value]; flushSave(); });
  on(b, '#clipImport', 'click', async () => {
    const r = await api.post('/api/import?kind=video');
    if (r.fids.length && confirm(`Aggiungere ${r.fids.length} file in coda al progetto?`)) { P.clips = [...P.clips, ...r.fids]; flushSave(); }
    else renderClips();
  });
}

// ---- soggetti ----
function renderSubjects() {
  const box = $('subjList'); box.innerHTML = '';
  P.subjects.forEach(s => {
    const row = document.createElement('div'); row.className = 'mus' + (s.id === selSubj ? ' sel' : '');
    const busy = trackJob && trackJob.sid === s.id, queued = trackQueue.some(q => q.sid === s.id);
    const frames = (s.trk || []).reduce((a, r) => a + r.pts.length, 0);
    row.innerHTML = `<div class="k" style="background:${subjColor(s)}">${s.key}</div>
      <input value="${esc(s.name)}">
      <div class="btns">
        <button data-a="box" title="Disegna di nuovo il riquadro qui e segui da qui in avanti">▢</button>
        <button data-a="back" title="Segui all'indietro da qui">◀</button>
        <button data-a="fwd" title="Segui in avanti da qui">▶</button>
        <button data-a="more" title="Altro">⋯</button>
      </div>
      <div class="sub muted">${busy ? 'tracking in corso…' : queued ? 'in coda…' : frames ? `seguito per ${fmt(frames / META.fps, false)}` : 'posizione fissa'}${s.person ? ' · persona' : ''}</div>
      <div class="menu hidden">
        <button data-a="clrF">Cancella tracking da qui in avanti</button>
        <button data-a="clrB">Cancella tracking da qui indietro</button>
        <button data-a="fix">Fissa all'inquadratura attuale</button>
        <button data-a="person">${s.person ? 'Non è una persona' : 'È una persona (tagli sul corpo)'}</button>
        <button data-a="del" class="danger">Elimina soggetto</button>
      </div>`;
    row.onclick = ev => { if (!['INPUT', 'BUTTON'].includes(ev.target.tagName)) { selSubj = s.id; renderSubjects(); requestDraw(); } };
    const inp = row.querySelector('input');
    inp.onchange = () => { s.name = inp.value; scheduleSave(); requestDraw(); };
    row.querySelectorAll('button').forEach(b => b.onclick = () => {
      selSubj = s.id;
      const a = b.dataset.a;
      if (a === 'more') { row.querySelector('.menu').classList.toggle('hidden'); return; }
      if (a === 'box') beginBox(s.id);
      if (a === 'fwd') queueTrack(s, 1);
      if (a === 'back') queueTrack(s, -1);
      if (a === 'clrF') clearTrack(s, curTime(), 1);
      if (a === 'clrB') clearTrack(s, curTime(), -1);
      if (a === 'fix') { const v = viewAt(curTime()); [s.yaw, s.pitch] = yawPitchOf(v.dir); s.trk = []; pathCache.delete(s.id);
        P.kfs.forEach(k => { if (k.sid === s.id) { k.dy = 0; k.dp = 0; } }); rebuild(); }
      if (a === 'person') { s.person = !s.person; scheduleSave(); }
      if (a === 'del' && confirm(`Eliminare ${s.name}? I suoi keyframe diventano liberi.`)) {
        P.kfs.forEach(k => { if (k.sid === s.id) { [k.yaw, k.pitch] = yawPitchOf(kfTarget(k, k.t).dir); k.fov = kfTarget(k, k.t).fov; k.sid = null; delete k.body; } });
        P.subjects = P.subjects.filter(x => x !== s); P.subjects.forEach((x, i) => x.key = i + 1); rebuild(); renderKfPanel();
      }
      renderSubjects(); requestDraw();
    });
    box.appendChild(row);
  });
  $('candBar').classList.toggle('hidden', !candidates);
  if (candidates) $('candCount').textContent = `${candidates.length} persone trovate`;
}

// ---- keyframe ----
function renderKfPanel() {
  const b = $('kfBody'), kf = selKf;
  if (!kf || !P.kfs.includes(kf)) { b.className = 'muted'; b.innerHTML = 'Nessun keyframe selezionato.<br>Premi <kbd>K</kbd>, un tasto <kbd>1</kbd>–<kbd>9</kbd> o fai doppio clic sulla traccia Camera.'; return; }
  const i = P.kfs.indexOf(kf), sg = segs[i], su = subjOf(kf.sid);
  b.className = '';
  const target = kf.group ? 'group' : kf.sid || '';
  b.innerHTML = `
    <div class="row">A <b>${fmt(kf.t)}</b> <span><button id="kPrev">◀</button> <button id="kGo">Vai</button> <button id="kNext">▶</button></span></div>
    <label class="row">Inquadra <select id="kSubj"><option value="">Direzione libera</option><option value="group" ${target === 'group' ? 'selected' : ''}>Tutti i soggetti</option>${P.subjects.map(s => `<option value="${s.id}" ${s.id === kf.sid ? 'selected' : ''}>${s.key} · ${esc(s.name)}${s.trk && s.trk.length ? ' (seguito)' : ''}</option>`).join('')}</select></label>
    ${su && su.person ? `<div class="row">Corpo <div class="seg">${Object.entries(BODY).map(([k, [n]]) => `<button data-b="${k}" class="${kf.body === k ? 'on' : ''}">${n}</button>`).join('')}</div></div>` : ''}
    <div class="row">Taglio <div class="seg">${Object.entries(FRAMINGS).map(([k, [n, f]]) => `<button data-f="${f}" class="${!kf.body && Math.abs((kf.fov || 0) - f) < 2 ? 'on' : ''}">${n}</button>`).join('')}</div></div>
    <label class="row">Campo <input type="range" id="kFov" min="12" max="300" value="${Math.round(kfTarget(kf, kf.t).fov)}"> <span>${Math.round(kfTarget(kf, kf.t).fov)}°</span></label>
    <div class="row">Effetti <div class="seg"><button id="kPlanet">Pianetino</button><button id="kTunnel">Tunnel</button></div></div>
    <div class="row">Arrivo <div class="seg">${Object.entries(MODES).map(([m, n]) => `<button data-m="${m}" class="${kf.mode === m ? 'on' : ''}" ${i === 0 && m !== 'move' ? 'disabled' : ''}>${n}</button>`).join('')}</div></div>
    <div class="muted hint">${kf.mode === 'move' ? 'La camera parte qui e raggiunge il soggetto in un gesto unico.' : kf.mode === 'glide' ? 'La camera si muove per tutto l\'intervallo dal keyframe precedente e arriva qui esattamente.' : 'Cambio di inquadratura netto.'}</div>
    ${kf.mode !== 'cut' && i > 0 ? `<label class="row">Curva <select id="kCurve">${Object.entries(CURVES).map(([k, [n]]) => `<option value="${k}" ${(kf.curve || 'morbida') === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <canvas id="kCurveView" width="240" height="48"></canvas>` : ''}
    ${kf.mode === 'move' && i > 0 ? `
    <label class="row">Durata <span><input type="checkbox" id="kAuto" ${kf.dur ? '' : 'checked'}> auto</span></label>
    <label class="row"><input type="range" id="kDur" min="0.3" max="8" step="0.05" value="${sg ? sg.dur : 1}" ${kf.dur ? '' : 'disabled'}> <span>${sg ? sg.dur.toFixed(2) : ''} s</span></label>
    <label class="row">Respiro <input type="range" id="kBr" min="0" max="2" step="0.1" value="${kf.breathe ?? 1}"></label>` : ''}
    <div class="row" style="margin-top:10px">${kf.sid ? '<button id="kReset">Centra sul soggetto</button>' : '<span></span>'}<button id="kDel" class="danger">Elimina</button></div>`;
  const upd = () => { rebuild(); renderKfPanel(); requestDraw(); };
  on(b, '#kGo', 'click', () => seek(kf.t));
  on(b, '#kPrev', 'click', () => { const k = P.kfs[i - 1]; if (k) { selKf = k; seek(k.t); renderKfPanel(); } });
  on(b, '#kNext', 'click', () => { const k = P.kfs[i + 1]; if (k) { selKf = k; seek(k.t); renderKfPanel(); } });
  on(b, '#kSubj', 'change', e => {
    const v = e.target.value, tg = kfTarget(kf, kf.t);
    delete kf.group; delete kf.body;
    if (v === 'group') { kf.group = true; kf.sid = null; kf.fov = 0; }
    else if (!v) { [kf.yaw, kf.pitch] = yawPitchOf(tg.dir); kf.fov = tg.fov; kf.sid = null; }
    else { kf.sid = v; kf.fov = kf.fov || 52; if (subjOf(v).person) kf.body = 'medium'; }
    kf.dy = kf.dp = 0; upd();
  });
  b.querySelectorAll('[data-b]').forEach(x => x.onclick = () => { kf.body = x.dataset.b; upd(); });
  b.querySelectorAll('[data-f]').forEach(x => x.onclick = () => { kf.fov = +x.dataset.f; delete kf.body; upd(); });
  b.querySelectorAll('[data-m]').forEach(x => x.onclick = () => { kf.mode = x.dataset.m; upd(); });
  on(b, '#kFov', 'input', e => { kf.fov = +e.target.value; delete kf.body; if (kf.group) kf.fov = +e.target.value; rebuild(); requestDraw(); e.target.nextElementSibling.textContent = kf.fov + '°'; });
  on(b, '#kFov', 'change', upd);
  on(b, '#kPlanet', 'click', () => { Object.assign(kf, { sid: null, yaw: kfTarget(kf, kf.t) && yawPitchOf(kfTarget(kf, kf.t).dir)[0], pitch: -90, fov: 260 }); delete kf.group; delete kf.body; upd(); });
  on(b, '#kTunnel', 'click', () => { Object.assign(kf, { sid: null, yaw: yawPitchOf(kfTarget(kf, kf.t).dir)[0], pitch: 90, fov: 250 }); delete kf.group; delete kf.body; upd(); });
  on(b, '#kCurve', 'change', e => { kf.curve = e.target.value; upd(); });
  on(b, '#kAuto', 'change', e => { kf.dur = e.target.checked ? null : (sg ? +sg.dur.toFixed(2) : 1); upd(); });
  on(b, '#kDur', 'input', e => { kf.dur = +e.target.value; rebuild(); requestDraw(); e.target.nextElementSibling.textContent = kf.dur.toFixed(2) + ' s'; });
  on(b, '#kBr', 'change', e => { kf.breathe = +e.target.value; upd(); });
  on(b, '#kReset', 'click', () => { kf.dy = kf.dp = 0; upd(); });
  on(b, '#kDel', 'click', () => { selCut = selSpeed = null; deleteSelected(); });
  const cv = b.querySelector('#kCurveView');
  if (cv) { // disegno della curva di velocità
    const c = cv.getContext('2d'), f = curveFn(kf, kf.mode === 'glide' ? easeInOut : CURVES.morbida[1]);
    c.strokeStyle = '#ff7a3d'; c.lineWidth = 2; c.beginPath();
    for (let k = 0; k <= 60; k++) { const s = k / 60, x = 4 + s * 232, y = 44 - f(s) * 40; k ? c.lineTo(x, y) : c.moveTo(x, y); }
    c.stroke();
  }
}

// ---- montaggio ----
function renderEditPanel() {
  const b = $('editBody');
  if (!META) { b.innerHTML = ''; return; }
  const kept = keptRanges().reduce((a, r) => a + r[1] - r[0], 0);
  b.innerHTML = `
    <div class="row"><span>Durata finale</span><b>${fmt(outputDuration(), false)}</b></div>
    <div class="row"><span>Intervallo da esportare</span><span class="muted">${P.range ? `${fmt(P.range[0], false)} → ${fmt(P.range[1], false)}` : 'tutto'}</span></div>
    <div class="row"><span><button id="eIn">Inizio <kbd>I</kbd></button> <button id="eOut">Fine <kbd>O</kbd></button></span><button id="eClrRange" ${P.range ? '' : 'disabled'}>Tutto</button></div>
    <div class="row"><span>Pezzi tolti: ${P.cuts.length}</span><button id="eCut" title="Toglie il tratto dal segno di inizio alla testina">Togli tratto <kbd>X</kbd></button></div>
    ${selCut ? `<div class="row sel-row"><span>Tratto tolto ${fmt(selCut[0], false)}–${fmt(selCut[1], false)}</span><button id="eRestore">Ripristina</button></div>` : ''}
    <div class="row">Velocità <div class="seg">${[0.25, 0.5, 2, 4].map(v => `<button data-sp="${v}">${v}×</button>`).join('')}</div></div>
    ${selSpeed ? `<div class="row sel-row"><span>${fmt(selSpeed.t0, false)}–${fmt(selSpeed.t1, false)}</span><span><input type="number" id="eSpeed" step="0.05" min="0.1" max="16" value="${selSpeed.speed}" style="width:64px">× <button id="eSpDel">✕</button></span></div>` : ''}
    <div class="muted hint">Segna l'inizio con <kbd>I</kbd>, sposta la testina: <kbd>X</kbd> toglie quel tratto, <kbd>O</kbd> lo usa come intervallo da esportare, un pulsante velocità lo rallenta/accelera.${markIn != null ? ` <b>Inizio segnato a ${fmt(markIn)}</b>` : ''}</div>`;
  on(b, '#eIn', 'click', setIn); on(b, '#eOut', 'click', setOut);
  on(b, '#eClrRange', 'click', () => { P.range = null; scheduleSave(); renderEditPanel(); requestDraw(); });
  on(b, '#eCut', 'click', cutRange);
  on(b, '#eRestore', 'click', () => { selKf = selSpeed = null; deleteSelected(); });
  b.querySelectorAll('[data-sp]').forEach(x => x.onclick = () => addSpeed(+x.dataset.sp));
  on(b, '#eSpeed', 'change', e => { selSpeed.speed = clamp(+e.target.value || 1, 0.1, 16); scheduleSave(); renderEditPanel(); requestDraw(); });
  on(b, '#eSpDel', 'click', () => { selKf = selCut = null; deleteSelected(); });
}

// ---- audio ----
async function renderAudioPanel() {
  const b = $('audioBody'), a = P.audio;
  if (!META) { b.innerHTML = ''; return; }
  const lib = await api.get('/api/library');
  b.innerHTML = `
    <label class="row">Audio esterno <select id="aFile"><option value="">Nessuno (solo camera)</option>${lib.audio.map(f => `<option value="${esc(f.path)}" ${f.path === a.path ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select></label>
    <div class="row"><button id="aImport">Importa audio…</button><button id="aSync" ${a.path ? '' : 'disabled'}>Sincronizza</button></div>
    ${a.path ? `<label class="row">Spostamento <span><input type="number" id="aOff" step="0.01" value="${a.offset}" style="width:84px"> s</span></label>
    <label class="row">Volume esterno <input type="range" id="aExt" min="0" max="2" step="0.05" value="${a.ext}"></label>` : ''}
    <label class="row">Volume camera <input type="range" id="aCam" min="0" max="2" step="0.05" value="${a.cam}"></label>
    <div class="muted hint">Carica il mix dello studio o un registratore: "Sincronizza" lo allinea da solo all'audio della camera.</div>`;
  on(b, '#aFile', 'change', e => { a.path = e.target.value; if (a.path) { a.cam = 0; a.ext = 1; } scheduleSave(); setupExtAudio(); renderAudioPanel(); });
  on(b, '#aImport', 'click', async () => { const r = await api.post('/api/import?kind=audio'); if (r.added.length) { a.path = r.added[0]; a.cam = 0; a.ext = 1; scheduleSave(); setupExtAudio(); } renderAudioPanel(); });
  on(b, '#aSync', 'click', async () => {
    await api.post(`/api/sync?pid=${PID}`, { path: a.path });
    const j = await pollJob(`${PID}#sync`, 'Sincronizzazione audio');
    if (j.status !== 'done') return toast('Sincronizzazione non riuscita: ' + (j.error || ''));
    a.offset = j.out.offset; scheduleSave(); setupExtAudio(); renderAudioPanel();
    toast(j.out.confidence > 8 ? `Sincronizzato: ${a.offset > 0 ? '+' : ''}${a.offset.toFixed(2)} s` : `Allineamento incerto (${a.offset.toFixed(2)} s): controlla a orecchio`, 5000);
  });
  on(b, '#aOff', 'change', e => { a.offset = +e.target.value || 0; scheduleSave(); syncExtAudio(true); });
  on(b, '#aExt', 'input', e => { a.ext = +e.target.value; scheduleSave(); applyVolumes(); });
  on(b, '#aCam', 'input', e => { a.cam = +e.target.value; scheduleSave(); applyVolumes(); });
}
function setupExtAudio() {
  const p = P.audio.path;
  if (!p) { extAudio.removeAttribute('src'); extAudio.load(); applyVolumes(); return; }
  const url = '/media/audio?path=' + encodeURIComponent(p);
  if (extAudio.getAttribute('src') !== url) extAudio.src = url;
  applyVolumes(); syncExtAudio(true);
}
function applyVolumes() {
  vid.volume = clamp(P.audio.cam, 0, 1); vid.muted = P.audio.cam <= 0;
  extAudio.volume = clamp(P.audio.ext, 0, 1);
}
function syncExtAudio(force) {
  if (!P.audio.path || !extAudio.src) return;
  const want = vid.currentTime + P.audio.offset;
  if (want < 0 || want > (extAudio.duration || 1e9)) { extAudio.pause(); return; }
  if (force || Math.abs(extAudio.currentTime - want) > 0.06) extAudio.currentTime = want;
  extAudio.playbackRate = vid.playbackRate;
  if (!vid.paused && extAudio.paused) extAudio.play().catch(() => {});
  if (vid.paused && !extAudio.paused) extAudio.pause();
}

// ---- colore ----
async function renderColorPanel() {
  const b = $('colorBody'), g = P.grade;
  const luts = await api.get('/api/luts');
  const sl = (id, label, min, max, step, val) => `<label class="row">${label} <span class="rng"><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}"><output>${(+val).toFixed(2)}</output></span></label>`;
  b.innerHTML = sl('gExp', 'Esposizione', -2, 2, 0.05, g.exposure) + sl('gCon', 'Contrasto', 0.5, 1.6, 0.01, g.contrast) +
    sl('gSat', 'Saturazione', 0, 2, 0.01, g.saturation) + sl('gTemp', 'Temperatura', -1, 1, 0.02, g.temperature) +
    sl('gTint', 'Tinta', -1, 1, 0.02, g.tint) +
    `<label class="row">LUT <select id="gLut"><option value="">Nessuna</option>${luts.map(n => `<option ${n === g.lut ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
     ${g.lut ? sl('gLutMix', 'Intensità LUT', 0, 1, 0.01, g.lutMix) : ''}
     <div class="row"><button id="gImport">Importa LUT .cube…</button><button id="gReset">Azzera</button></div>`;
  const bind = (id, key) => on(b, '#' + id, 'input', e => { g[key] = +e.target.value; e.target.nextElementSibling.textContent = g[key].toFixed(2); scheduleSave(); requestDraw(); });
  bind('gExp', 'exposure'); bind('gCon', 'contrast'); bind('gSat', 'saturation'); bind('gTemp', 'temperature'); bind('gTint', 'tint'); bind('gLutMix', 'lutMix');
  on(b, '#gLut', 'change', async e => { g.lut = e.target.value; scheduleSave(); await loadLut(g.lut); renderColorPanel(); requestDraw(); });
  on(b, '#gImport', 'click', async () => { const r = await api.post('/api/import_lut'); if (r.added.length) { g.lut = r.added[0]; scheduleSave(); await loadLut(g.lut); } renderColorPanel(); requestDraw(); });
  on(b, '#gReset', 'click', () => { Object.assign(g, blankProject().grade); scheduleSave(); renderColorPanel(); requestDraw(); });
}

// ---- formato, export, coda ----
function bindFormat() {
  const f = P.format, set = (id, fn) => { $(id).onchange = e => { fn(e.target.value); scheduleSave(); bindFormat(); }; };
  $('fmtRatio').value = f.ratio; $('fmtRes').value = String(f.res); $('fmtCodec').value = f.codec;
  $('fmtQual').value = f.quality; $('fmtGuide').value = f.guide; $('fmtCw').value = f.cw; $('fmtCh').value = f.ch;
  $('fmtCustom').classList.toggle('hidden', f.ratio !== 'custom');
  set('fmtRatio', v => f.ratio = v); set('fmtRes', v => f.res = +v); set('fmtCodec', v => f.codec = v);
  set('fmtQual', v => f.quality = v); set('fmtGuide', v => f.guide = v);
  set('fmtCw', v => f.cw = clamp(+v || 1, 1, 100)); set('fmtCh', v => f.ch = clamp(+v || 1, 1, 100));
  applyFormat(); renderQueue();
}
const CODECS = { hevc: 'HEVC', h264: 'H.264', prores: 'ProRes 422' };
function formatLabel(f) { return `${ratioLabel(f)} · ${f.res}p · ${CODECS[f.codec]}`; }
function renderQueue() {
  const b = $('queueList');
  b.innerHTML = P.queue.length ? P.queue.map((q, i) => `<div class="qrow"><span>${esc(formatLabel(q))}</span><button data-i="${i}">✕</button></div>`).join('')
    : '<div class="muted hint">Aggiungi più formati (es. 16:9 e 9:16) ed esportali tutti in fila con la stessa regia.</div>';
  b.querySelectorAll('button').forEach(x => x.onclick = () => { P.queue.splice(+x.dataset.i, 1); scheduleSave(); renderQueue(); });
  $('runQueue').disabled = !P.queue.length;
}
$('addQueue').onclick = () => { P.queue.push({ ...P.format }); scheduleSave(); renderQueue(); };

// ---- impostazioni regia ----
function bindSettings() {
  const s = P.settings;
  $('pace').value = String(s.pace); $('breathe').value = s.breathe; $('stab').checked = s.stab;
  $('axisMap').value = s.axis; $('gyroOff').value = s.gyroOffset; $('follow').value = s.follow; $('showBoxes').checked = s.showBoxes;
  $('stitch').value = s.stitch ? 1 / s.stitch : 0; $('stitchLbl').textContent = s.stitch ? s.stitch.toFixed(1) + ' m' : '∞';
  $('pace').onchange = e => { s.pace = +e.target.value; rebuild(); requestDraw(); };
  $('breathe').oninput = e => { s.breathe = +e.target.value; rebuild(); requestDraw(); };
  $('follow').oninput = e => { s.follow = +e.target.value; pathCache.clear(); rebuild(); requestDraw(); };
  $('stitch').oninput = e => { const v = +e.target.value; s.stitch = v > 0.01 ? 1 / v : 0; $('stitchLbl').textContent = s.stitch ? s.stitch.toFixed(1) + ' m' : '∞'; scheduleSave(); requestDraw(); };
  $('showBoxes').onchange = e => { s.showBoxes = e.target.checked; scheduleSave(); requestDraw(); };
  $('stab').onchange = e => { s.stab = e.target.checked; scheduleSave(); requestDraw(); };
  $('axisMap').onchange = e => { s.axis = +e.target.value; scheduleSave(); requestDraw(); };
  $('gyroOff').onchange = e => { s.gyroOffset = +e.target.value; scheduleSave(); requestDraw(); };
}

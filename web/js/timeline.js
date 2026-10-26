'use strict';
// ===================== timeline: righello, audio, camera, velocità, soggetti =====================
const tl = $('timeline'), tc = tl.getContext('2d');
let tlView = [0, 1];
const TL = { ruler: 18, wave: 34, cam: 42, speed: 16, row: 20 };
function tlRows() {
  const wave = TL.ruler, cam = wave + TL.wave + 2, speed = cam + TL.cam + 2, subj = speed + TL.speed + 4;
  return { wave, cam, speed, subj, H: subj + P.subjects.length * TL.row + 4 };
}
const tx2t = x => tlView[0] + x / tl.width * (tlView[1] - tlView[0]);
const t2tx = t => (t - tlView[0]) / (tlView[1] - tlView[0]) * tl.width;
function fovName(kf) {
  if (kf.group) return 'Gruppo';
  if (kf.body && BODY[kf.body]) return BODY[kf.body][0];
  const f = kf.fov, e = Object.values(FRAMINGS).reduce((a, b) => Math.abs(b[1] - f) < Math.abs(a[1] - f) ? b : a);
  return Math.abs(e[1] - f) < 4 ? e[0] : Math.round(f) + '°';
}
function hatch(x0, x1, y0, h, color, s) {
  tc.save(); tc.beginPath(); tc.rect(x0, y0, x1 - x0, h); tc.clip();
  tc.strokeStyle = color; tc.lineWidth = 2 * s;
  for (let x = x0 - h; x < x1; x += 8 * s) { tc.beginPath(); tc.moveTo(x, y0 + h); tc.lineTo(x + h, y0); tc.stroke(); }
  tc.restore();
}
function drawTimeline() {
  const dpr = devicePixelRatio || 1, rows = tlRows();
  tl.style.height = rows.H + 'px';
  const w = tl.clientWidth * dpr;
  if (tl.width !== w || tl.height !== rows.H * dpr) { tl.width = w; tl.height = rows.H * dpr; }
  const s = dpr, H = tl.height;
  tc.clearRect(0, 0, tl.width, H);
  if (!META) return;
  // righello e confini delle clip
  tc.fillStyle = '#8b8f96'; tc.font = `${10 * s}px ui-monospace, monospace`; tc.textBaseline = 'top';
  const span = tlView[1] - tlView[0];
  const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find(x => span / x < tl.width / (70 * s)) || 1200;
  for (let t = Math.ceil(tlView[0] / step) * step; t < tlView[1]; t += step) {
    const x = t2tx(t); tc.fillRect(x, 0, 1, 6 * s); tc.fillText(fmt(t, false), x + 3 * s, 2 * s);
  }
  if (P.range) {
    const a = t2tx(P.range[0]), b = t2tx(P.range[1]);
    tc.fillStyle = '#ff7a3d55'; tc.fillRect(a, 12 * s, b - a, 5 * s);
    tc.fillStyle = '#ff7a3d'; tc.fillRect(a, 0, 2 * s, rows.cam * s); tc.fillRect(b - 2 * s, 0, 2 * s, rows.cam * s);
  }
  (META.clips || []).slice(1).forEach(c => {
    const x = t2tx(c.f0 / META.fps); tc.fillStyle = '#5aa9ff'; tc.fillRect(x - s / 2, 0, s, H);
  });
  // forma d'onda
  const wy = rows.wave * s, wh = TL.wave * s;
  tc.fillStyle = '#17191c'; tc.fillRect(0, wy, tl.width, wh);
  if (PEAKS && PEAKS.length) {
    tc.fillStyle = '#6b7380';
    const mid = wy + wh / 2;
    for (let x = 0; x < tl.width; x += 2 * s) {
      const a = Math.floor(tx2t(x) * 100), b = Math.max(a + 1, Math.floor(tx2t(x + 2 * s) * 100));
      let m = 0; for (let k = a; k < b && k < PEAKS.length; k++) if (k >= 0 && PEAKS[k] > m) m = PEAKS[k];
      const hh = m / 255 * wh * 0.48; tc.fillRect(x, mid - hh, 1.4 * s, hh * 2);
    }
  }
  // traccia camera
  const y0 = rows.cam * s, h = TL.cam * s;
  tc.fillStyle = '#1d2024'; tc.fillRect(0, y0, tl.width, h);
  segs.forEach((sg, i) => {
    const kf = sg.kf, end = i + 1 < segs.length ? segs[i + 1].t : META.duration;
    const x0 = t2tx(sg.t), x1 = t2tx(end);
    if (x1 < 0 || x0 > tl.width) return;
    const su = subjOf(kf.sid), col = kf.group ? '#e8e6e1' : su ? subjColor(su) : '#8a8f98';
    tc.fillStyle = col + (kf === selKf ? 'ee' : '88'); tc.fillRect(x0, y0 + 10 * s, Math.max(1, x1 - x0), h - 14 * s);
    if (sg.dur > 0) {
      const xd = t2tx(sg.t + sg.dur), g = tc.createLinearGradient(x0, 0, xd, 0);
      g.addColorStop(0, 'rgba(0,0,0,.55)'); g.addColorStop(1, 'rgba(0,0,0,0)'); tc.fillStyle = g; tc.fillRect(x0, y0 + 10 * s, xd - x0, h - 14 * s);
    }
    const nx = P.kfs[i + 1];
    if (nx && nx.mode === 'glide') hatch(x0, x1, y0 + 10 * s, h - 14 * s, 'rgba(0,0,0,.25)', s);
    if (x1 - x0 > 50 * s) {
      tc.fillStyle = '#111'; tc.font = `600 ${11 * s}px -apple-system, sans-serif`; tc.textBaseline = 'middle';
      tc.fillText(`${kf.group ? 'Tutti' : su ? su.name : 'Libera'} · ${fovName(kf)}`, x0 + 8 * s, y0 + 10 * s + (h - 14 * s) / 2, x1 - x0 - 14 * s);
    }
  });
  segs.forEach(sg => {
    const x = t2tx(sg.t), kf = sg.kf, cy = y0 + 6 * s, r = (kf === selKf ? 6.5 : 5) * s;
    if (x < -10 || x > tl.width + 10) return;
    tc.fillStyle = kf.mode === 'cut' ? '#fff' : kf === selKf ? '#ff7a3d' : '#e8e6e1';
    tc.beginPath(); tc.moveTo(x, cy - r); tc.lineTo(x + r, cy); tc.lineTo(x, cy + r); tc.lineTo(x - r, cy); tc.closePath(); tc.fill();
    tc.fillStyle = 'rgba(255,255,255,.4)'; tc.fillRect(x - 0.5 * s, y0 + 10 * s, s, h - 14 * s);
  });
  // velocità
  const sy = rows.speed * s, shh = TL.speed * s;
  tc.fillStyle = '#17191c'; tc.fillRect(0, sy, tl.width, shh);
  P.speeds.forEach(sp => {
    const a = t2tx(sp.t0), b = t2tx(sp.t1);
    tc.fillStyle = sp === selSpeed ? '#b48cff' : '#b48cff88'; tc.fillRect(a, sy + 2 * s, b - a, shh - 4 * s);
    tc.fillStyle = '#111'; tc.font = `600 ${10 * s}px -apple-system, sans-serif`; tc.textBaseline = 'middle';
    if (b - a > 30 * s) tc.fillText(`${sp.speed}×`, a + 5 * s, sy + shh / 2);
  });
  // soggetti
  P.subjects.forEach((su, k) => {
    const yy = (rows.subj + k * TL.row) * s, hh = (TL.row - 3) * s, col = subjColor(su);
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
    tc.fillStyle = col; tc.fillRect(4 * s, yy + 4 * s, 3 * s, hh - 8 * s);
    tc.fillStyle = '#e8e6e1'; tc.font = `600 ${10.5 * s}px -apple-system, sans-serif`; tc.textBaseline = 'middle';
    tc.fillText(`${su.key} ${su.name}`, 11 * s, yy + hh / 2, 110 * s);
  });
  // parti tagliate e fuori intervallo
  mergedCuts().forEach(c => {
    const a = t2tx(c[0]), b = t2tx(c[1]); if (b < 0 || a > tl.width) return;
    tc.fillStyle = 'rgba(10,10,12,.62)'; tc.fillRect(a, rows.wave * s, b - a, H - rows.wave * s);
    hatch(a, b, rows.wave * s, H - rows.wave * s, selCut && selCut[0] === c[0] ? '#ff5d8faa' : '#ff5d8f44', s);
  });
  if (P.range) {
    tc.fillStyle = 'rgba(10,10,12,.5)';
    tc.fillRect(0, rows.wave * s, t2tx(P.range[0]), H); tc.fillRect(t2tx(P.range[1]), rows.wave * s, tl.width, H);
  }
  if (markIn != null) { tc.fillStyle = '#3dd6c6'; tc.fillRect(t2tx(markIn) - s, 0, 2 * s, H); }
  const px = t2tx(curTime());
  tc.fillStyle = '#fff'; tc.fillRect(px - s, 0, 2 * s, H);
}
let tlDrag = null;
function tlHit(e) {
  const s = devicePixelRatio || 1, x = e.offsetX * s, y = e.offsetY, rows = tlRows(), t = tx2t(x);
  const zone = y < rows.wave ? 'ruler' : y < rows.cam ? 'wave' : y < rows.speed ? 'cam' : y < rows.subj ? 'speed' : 'subj';
  const kf = zone === 'cam' ? P.kfs.find(k => Math.abs(t2tx(k.t) - x) < 8 * s) : null;
  const subj = zone === 'subj' ? P.subjects[Math.floor((y - rows.subj) / TL.row)] : null;
  const sp = zone === 'speed' ? P.speeds.find(q => t >= q.t0 && t < q.t1) : null;
  const spEdge = zone === 'speed' ? P.speeds.find(q => Math.abs(t2tx(q.t0) - x) < 6 * s || Math.abs(t2tx(q.t1) - x) < 6 * s) : null;
  const cut = zone === 'wave' ? mergedCuts().find(c => t >= c[0] && t < c[1]) : null;
  return { x, t, zone, kf, subj, sp, spEdge, cut };
}
tl.addEventListener('mousedown', e => {
  if (!META) return;
  const h = tlHit(e);
  selCut = null;
  if (h.kf) { selKf = h.kf; tlDrag = { kf: h.kf }; renderKfPanel(); requestDraw(); return; }
  if (h.spEdge) {
    const sp = h.spEdge; selSpeed = sp; tlDrag = { sp, edge: Math.abs(t2tx(sp.t0) - h.x) < Math.abs(t2tx(sp.t1) - h.x) ? 't0' : 't1' };
    renderEditPanel(); requestDraw(); return;
  }
  if (h.sp) { selSpeed = h.sp; renderEditPanel(); }
  if (h.cut) { selCut = h.cut; renderEditPanel(); }
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
  if (tlDrag.kf) { tlDrag.kf.t = t; rebuild(); requestDraw(); }
  else if (tlDrag.sp) { tlDrag.sp[tlDrag.edge] = t; if (tlDrag.sp.t1 < tlDrag.sp.t0 + 0.2) tlDrag.sp[tlDrag.edge] = tlDrag.edge === 't0' ? tlDrag.sp.t1 - 0.2 : tlDrag.sp.t0 + 0.2; scheduleSave(); requestDraw(); }
  else seek(t);
});
addEventListener('mouseup', () => { if (tlDrag && (tlDrag.kf || tlDrag.sp)) { renderKfPanel(); renderEditPanel(); } tlDrag = null; });
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

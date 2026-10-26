'use strict';
// ===================== matematica =====================
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const mmul = (A, B) => A.map(r => [0, 1, 2].map(j => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
const mT = A => [0, 1, 2].map(i => [0, 1, 2].map(j => A[j][i]));
const mv = (A, v) => A.map(r => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const norm = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const wrap = a => ((a + 540) % 360) - 180;
// coordinate: x destra, y alto, z avanti
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
const AXIS_MAPS = [ // assi IMU -> camera (E = M·S)
  [[0, 0, 1], [0, 1, 0], [1, 0, 0]], [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  [[0, 0, 1], [0, 1, 0], [-1, 0, 0]], [[0, 0, -1], [0, 1, 0], [-1, 0, 0]],
];

// ===================== DOM, formato orario, API =====================
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function fmt(t, cs = true) {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t - Math.floor(t / 60) * 60;
  const ss = cs ? s.toFixed(2).padStart(5, '0') : String(Math.floor(s)).padStart(2, '0');
  return (h ? h + ':' : '') + `${String(m).padStart(2, '0')}:${ss}`;
}
const api = {
  async get(u) { const r = await fetch(u); const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j; },
  async post(u, body) {
    const r = await fetch(u, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j;
  },
};
// lavori in corso (preparazione, tracking, export...) mostrati in alto
const JOBS = new Map();
function renderJobs() {
  const box = $('jobs'); box.innerHTML = '';
  JOBS.forEach((j, key) => {
    const el = document.createElement('div'); el.className = 'job';
    el.innerHTML = `<span>${esc(j.label)}${j.phase ? ' · ' + esc(j.phase) : ''}</span><div class="bar"><i style="width:${Math.round(j.progress * 100)}%"></i></div><button title="Annulla">✕</button>`;
    el.querySelector('button').onclick = () => api.post(`/api/cancel?key=${encodeURIComponent(key)}`);
    box.appendChild(el);
  });
}
async function pollJob(key, label, onTick) {
  JOBS.set(key, { label, progress: 0 }); renderJobs();
  try {
    for (;;) {
      const j = await api.get(`/api/status?key=${encodeURIComponent(key)}`);
      JOBS.set(key, { label, progress: j.progress || 0, phase: j.phase }); renderJobs();
      if (onTick) onTick(j);
      if (j.status !== 'running') return j;
      await new Promise(r => setTimeout(r, 500));
    }
  } finally { JOBS.delete(key); renderJobs(); }
}
function toast(msg, ms = 3500) {
  const el = $('toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), ms);
}

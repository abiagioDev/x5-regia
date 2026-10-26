'use strict';
// ===================== anteprima WebGL (stesso shader dell'export: core.glsl) =====================
const canvas = $('view'), gl = canvas.getContext('webgl2', { preserveDrawingBuffer: false });
const vid = $('vid'), extAudio = $('extAudio');
const ov = $('overview'), oc = ov.getContext('2d');
const ovl = $('overlay'), lc = ovl.getContext('2d');
let prog = null, U = null, texReady = false;
const tex = gl.createTexture(), lutTex = gl.createTexture();

async function initGL() {
  const core = await (await fetch('core.glsl')).text();
  const VS = `#version 300 es
in vec2 p; out vec2 uv; void main(){ uv = p; gl_Position = vec4(p,0.,1.); }`;
  const FS = `#version 300 es
precision highp float; precision mediump sampler3D;
in vec2 uv; out vec4 o;
uniform sampler2D tex; uniform mat3 rot; uniform float hf, projK; uniform vec2 asp; uniform int outEq;
${core}
vec3 fetchA(vec2 p) { return texture(tex, vec2(p.x * 0.5, p.y)).rgb; }
vec3 fetchB(vec2 p) { return texture(tex, vec2(0.5 + p.x * 0.5, p.y)).rgb; }
void main(){
  if (outEq == 1) {
    float lon = uv.x * 3.14159265359, lat = uv.y * 1.57079632679;
    o = vec4(sampleSphere(vec3(sin(lon) * cos(lat), sin(lat), cos(lon) * cos(lat))), 1.);
  } else o = vec4(gradeColor(sampleSphere(normalize(rot * viewRay(uv, hf, asp, projK)))), 1.);
}`;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog); gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const ploc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(ploc);
  gl.vertexAttribPointer(ploc, 2, gl.FLOAT, false, 0, 0);
  const cache = {}; U = n => (n in cache ? cache[n] : (cache[n] = gl.getUniformLocation(prog, n)));
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
  for (const [k, v] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
    [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  gl.uniform1i(U('tex'), 0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_3D, lutTex);
  for (const [k, v] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE],
    [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]]) gl.texParameteri(gl.TEXTURE_3D, k, v);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, 2, 2, 2, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array(24));
  gl.uniform1i(U('lut'), 1); gl.uniform1f(U('lutSize'), 2);
  gl.activeTexture(gl.TEXTURE0);
}
function setLensUniforms() {
  const L = META.shader;
  gl.uniformMatrix3fv(U('Ma'), false, new Float32Array(L.Ma)); // = Ma^T: d_lente = Ma^T·d (vedi lens.py)
  gl.uniformMatrix3fv(U('Mb'), false, new Float32Array(L.Mb));
  gl.uniform2f(U('ca'), ...L.ca); gl.uniform2f(U('cb'), ...L.cb);
  gl.uniform3f(U('fk'), ...L.f); gl.uniform1f(U('size'), L.size); gl.uniform1f(U('seam'), L.seam * D2R);
  gl.uniform3f(U('gainA'), ...(L.gainA || [1, 1, 1])); gl.uniform3f(U('gainB'), ...(L.gainB || [1, 1, 1]));
  gl.uniform1f(U('baseline'), L.baseline || 0.03);
}
let lutLoaded = '';
async function loadLut(name) {
  if (name === lutLoaded) return;
  lutLoaded = name;
  if (!name) return;
  const txt = await (await fetch('/luts/' + encodeURIComponent(name))).text();
  let size = 0; const data = [];
  for (const line of txt.split('\n')) {
    const t = line.trim().split(/\s+/);
    if (t[0] === 'LUT_3D_SIZE') size = +t[1];
    else if (t.length === 3 && !isNaN(+t[0])) data.push(+t[0], +t[1], +t[2]);
  }
  if (!size || data.length < size ** 3 * 3) return toast('LUT non valida');
  const u8 = new Uint8Array(data.map(x => clamp(Math.round(x * 255), 0, 255)));
  gl.activeTexture(gl.TEXTURE1);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); // righe da size*3 byte, non multiple di 4
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, size, size, size, 0, gl.RGB, gl.UNSIGNED_BYTE, u8);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.activeTexture(gl.TEXTURE0);
  gl.useProgram(prog); gl.uniform1f(U('lutSize'), size);
  requestDraw();
}
function setGradeUniforms() {
  const g = P.grade;
  gl.uniform4f(U('grade1'), g.exposure, g.contrast, g.saturation, g.lut && lutLoaded === g.lut ? g.lutMix : 0);
  gl.uniform2f(U('grade2'), g.temperature, g.tint);
  gl.uniform1f(U('stitchD'), P.settings.stitch || 0);
}

function draw() {
  if (!prog || !META) { drawTimeline(); return; }
  const t = curTime(), view = viewAt(t);
  if (vid.readyState >= 2) { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, vid); texReady = true; }
  setGradeUniforms();
  if (texReady) { // panoramica 360 (senza correzione colore), poi la vista
    gl.viewport(0, 0, ov.width, ov.height); gl.uniform1i(U('outEq'), 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    oc.drawImage(canvas, 0, canvas.height - ov.height, ov.width, ov.height, 0, 0, ov.width, ov.height);
    gl.uniform1i(U('outEq'), 0);
    gl.viewport(0, 0, canvas.width, canvas.height);
    const R = renderRot(t, view);
    gl.uniformMatrix3fv(U('rot'), false, new Float32Array([R[0][0], R[1][0], R[2][0], R[0][1], R[1][1], R[2][1], R[0][2], R[1][2], R[2][2]]));
    gl.uniform1f(U('hf'), view.fov * D2R / 2); gl.uniform2f(U('asp'), ...aspVec()); gl.uniform1f(U('projK'), projK(view.fov));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  drawOverview(t, view);
  drawOverlay(t, view);
  drawTimeline();
  updateHud(t, view);
}
let drawQueued = false;
function requestDraw() { if (drawQueued) return; drawQueued = true; requestAnimationFrame(() => { drawQueued = false; draw(); }); }

// ---- riquadri dei soggetti e guide sopra l'anteprima ----
function tanHalf(fov) { const t = Math.tan(Math.min(fov, 170) * D2R / 2), [ax, ay] = aspVec(); return [t * ax, t * ay]; }
function viewProject(view, dWorld) {
  const V = viewMatrix(view.dir), d = mv(mT(V), dWorld);
  if (d[2] <= 0.05) return null;
  const [tx, ty] = tanHalf(view.fov);
  return [(d[0] / d[2] / tx * 0.5 + 0.5) * ovl.width, (0.5 - d[1] / d[2] / ty * 0.5) * ovl.height];
}
function viewUnproject(view, x, y) {
  const [tx, ty] = tanHalf(view.fov);
  return norm(mv(viewMatrix(view.dir), [(x / ovl.width * 2 - 1) * tx, (1 - y / ovl.height * 2) * ty, 1]));
}
function drawOverlay(t, view) {
  const r = canvas.getBoundingClientRect(), pr = canvas.parentElement.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  Object.assign(ovl.style, { left: (r.left - pr.left) + 'px', top: (r.top - pr.top) + 'px', width: r.width + 'px', height: r.height + 'px' });
  if (ovl.width !== Math.round(r.width * dpr)) { ovl.width = Math.round(r.width * dpr); ovl.height = Math.round(r.height * dpr); }
  lc.clearRect(0, 0, ovl.width, ovl.height);
  if (!META) return;
  if (P.format.guide && RATIOS[P.format.guide]) {
    const g = RATIOS[P.format.guide], ga = g[0] / g[1], a = ovl.width / ovl.height;
    const gw = ga > a ? ovl.width : ovl.height * ga, gh = ga > a ? ovl.width / ga : ovl.height;
    const gx = (ovl.width - gw) / 2, gy = (ovl.height - gh) / 2;
    lc.fillStyle = 'rgba(0,0,0,.45)';
    lc.fillRect(0, 0, ovl.width, gy); lc.fillRect(0, gy + gh, ovl.width, ovl.height - gy - gh);
    lc.fillRect(0, gy, gx, gh); lc.fillRect(gx + gw, gy, ovl.width - gx - gw, gh);
    lc.strokeStyle = 'rgba(255,255,255,.7)'; lc.lineWidth = dpr; lc.strokeRect(gx, gy, gw, gh);
  }
  const pxPerDeg = Math.max(ovl.width, ovl.height) / view.fov;
  lc.font = `600 ${12 * dpr}px -apple-system, sans-serif`; lc.lineWidth = 2 * dpr;
  if (P.settings.showBoxes && projK(view.fov) < 0.3) P.subjects.forEach(s => {
    const p = viewProject(view, subjDir(s, t)); if (!p) return;
    const [w, h, live] = subjSize(s, t), bw = w * pxPerDeg, bh = h * pxPerDeg, col = subjColor(s);
    lc.strokeStyle = col; lc.setLineDash(live ? [] : [6 * dpr, 5 * dpr]);
    lc.strokeRect(p[0] - bw / 2, p[1] - bh / 2, bw, bh); lc.setLineDash([]);
    lc.fillStyle = col; lc.fillText(`${s.key} ${s.name}`, p[0] - bw / 2, p[1] - bh / 2 - 5 * dpr);
  });
  if (candidates) candidates.forEach((c, i) => {
    const p = viewProject(view, dirOf(c.yaw, c.pitch)); if (!p) return;
    const bw = c.w * pxPerDeg, bh = c.h * pxPerDeg;
    lc.strokeStyle = '#fff'; lc.setLineDash([3 * dpr, 3 * dpr]); lc.strokeRect(p[0] - bw / 2, p[1] - bh / 2, bw, bh); lc.setLineDash([]);
  });
  if (boxDraw && boxDraw.x1 != null) {
    lc.strokeStyle = '#fff'; lc.setLineDash([4 * dpr, 4 * dpr]);
    lc.strokeRect(boxDraw.x0, boxDraw.y0, boxDraw.x1 - boxDraw.x0, boxDraw.y1 - boxDraw.y0); lc.setLineDash([]);
  }
  if (boxDraw) {
    lc.fillStyle = 'rgba(0,0,0,.6)'; lc.fillRect(0, 0, ovl.width, 26 * dpr); lc.fillStyle = '#fff';
    lc.fillText(boxDraw.sid ? `Disegna il riquadro attorno a ${subjOf(boxDraw.sid).name} · Esc annulla`
      : 'Disegna un riquadro attorno a una persona o un oggetto da seguire · Esc annulla', 10 * dpr, 17 * dpr);
  }
}

// ---- panoramica 360 ----
function camToPx(d) { const [y, p] = yawPitchOf(norm(d)); return [(0.5 + y / 360) * ov.width, (0.5 - p / 180) * ov.height]; }
function drawOverview(t, view) {
  if (!texReady) { oc.fillStyle = '#000'; oc.fillRect(0, 0, ov.width, ov.height); return; }
  const Ct = mT(camMatrix(t)), V = viewMatrix(view.dir), [tx, ty] = tanHalf(view.fov);
  const pts = [];
  for (let k = 0; k <= 80; k++) {
    const s = k / 20, e = s % 1, side = Math.floor(s) % 4;
    const uv = [[-1 + 2 * e, -1], [1, -1 + 2 * e], [1 - 2 * e, 1], [-1, 1 - 2 * e]][side];
    pts.push(camToPx(mv(Ct, mv(V, [uv[0] * tx, uv[1] * ty, 1]))));
  }
  oc.strokeStyle = 'rgba(255,255,255,.9)'; oc.lineWidth = 2; oc.beginPath();
  pts.forEach((p, k) => { if (k === 0 || Math.abs(p[0] - pts[k - 1][0]) > ov.width / 2) oc.moveTo(...p); else oc.lineTo(...p); });
  oc.stroke();
  oc.font = 'bold 12px -apple-system, sans-serif';
  P.subjects.forEach(s => {
    const [x, y] = camToPx(mv(Ct, subjDir(s, t)));
    oc.fillStyle = subjColor(s); oc.beginPath(); oc.arc(x, y, 8, 0, 7); oc.fill();
    oc.fillStyle = '#111'; oc.textAlign = 'center'; oc.textBaseline = 'middle'; oc.fillText(s.key, x, y + 1);
    oc.fillStyle = '#fff'; oc.textAlign = 'left'; oc.fillText(s.name, x + 11, y);
  });
  (candidates || []).forEach(c => {
    const [x, y] = camToPx(mv(Ct, dirOf(c.yaw, c.pitch)));
    oc.strokeStyle = '#fff'; oc.lineWidth = 2; oc.beginPath(); oc.arc(x, y, 8, 0, 7); oc.stroke();
  });
}
function applyFormat() {
  const a = ratioOf(), L = 1440;
  canvas.width = a >= 1 ? L : Math.round(L * a); canvas.height = a >= 1 ? Math.round(L / a) : L;
  canvas.style.aspectRatio = `${canvas.width} / ${canvas.height}`;
  ov.width = Math.min(720, canvas.width, canvas.height * 2); ov.height = ov.width / 2;
  const [W, H] = outSize();
  $('fmtSize').textContent = `${W} × ${H}`;
  requestDraw();
}

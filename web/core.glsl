// Nucleo condiviso tra anteprima (WebGL2, web/app.js) ed export (OpenGL 3.3, export_worker.py).
// Chi include questo file deve definire: vec3 fetchA(vec2 p); vec3 fetchB(vec2 p);  (p normalizzato 0..1
// dentro il cerchio di ciascun obiettivo).
// Coordinate camera: x destra, y alto, z avanti (obiettivo "b").

uniform mat3 Ma, Mb;          // camera -> obiettivo
uniform vec2 ca, cb;          // centri ottici (px sul fotogramma dell'obiettivo)
uniform vec3 fk;              // r = f1·θ + f3·θ³ + f5·θ⁵
uniform float size, seam;     // lato del fotogramma dell'obiettivo (px), semi-larghezza giunta (rad)
uniform vec3 gainA, gainB;    // uniformazione colore tra obiettivi
uniform float stitchD;        // distanza di cucitura in metri (0 = infinito)
uniform float baseline;       // distanza tra i centri ottici (m)
uniform vec4 grade1;          // esposizione (stop), contrasto, saturazione, intensità LUT
uniform vec2 grade2;          // temperatura, tinta (-1..1)
uniform float lutSize;
uniform mediump sampler3D lut;

vec3 fetchA(vec2 p);
vec3 fetchB(vec2 p);

// raggio di vista per uv in -1..1. hf = metà del campo visivo sul lato lungo (rad),
// asp = estensione dei due assi (lato lungo = 1), k = 0 rettilineo .. 1 stereografico
vec3 viewRay(vec2 uv, float hf, vec2 asp, float k) {
  vec2 p = uv * asp;
  float n = length(p);
  if (n < 1e-6) return vec3(0., 0., 1.);
  float ts = 2. * atan(n * tan(hf * 0.5));
  float th = ts;
  if (k < 0.999) th = mix(atan(n * tan(min(hf, 1.52))), ts, k);
  return vec3(p / n * sin(th), cos(th));
}

vec2 lensUV(vec3 d, vec2 c, out float t) {
  float rxy = length(d.xy); t = atan(rxy, d.z);
  float t2 = t * t, r = t * (fk.x + t2 * (fk.y + t2 * fk.z));
  return clamp((c + vec2(d.x, -d.y) * (r / max(rxy, 1e-6))) / size, 0., 1.);
}

vec3 sampleSphere(vec3 d) {
  vec3 da = d, db = d;
  if (stitchD > 0.) { // parallasse: i due obiettivi sono a ±baseline/2 lungo z
    vec3 P = d * stitchD;
    da = normalize(P + vec3(0., 0., baseline * 0.5));
    db = normalize(P - vec3(0., 0., baseline * 0.5));
  }
  float ta, tb, ta2, tb2;
  vec2 pa = lensUV(Ma * da, ca, ta), pb = lensUV(Mb * db, cb, tb);
  lensUV(Ma * d, ca, ta2); lensUV(Mb * d, cb, tb2); // la giunta resta dove è sempre
  vec3 A = fetchA(pa) * gainA, B = fetchB(pb) * gainB;
  float s = clamp((tb2 - ta2) / (2. * seam) + 0.5, 0., 1.);
  return mix(B, A, s * s * (3. - 2. * s));
}

vec3 gradeColor(vec3 c) {
  c *= exp2(grade1.x);
  c *= vec3(1. + 0.12 * grade2.x, 1. - 0.08 * grade2.y, 1. - 0.12 * grade2.x);
  c = (c - 0.5) * grade1.y + 0.5;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, grade1.z);
  c = clamp(c, 0., 1.);
  if (grade1.w > 0.) {
    vec3 lc = texture(lut, c * ((lutSize - 1.) / lutSize) + 0.5 / lutSize).rgb;
    c = mix(c, lc, grade1.w);
  }
  return c;
}

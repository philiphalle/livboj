// Livbojen — the water: a WebGL layer under the game canvas (stylised cartoon
// water drawn by one fragment shader) with a 2D fallback of the same look.
//
// The GPU layer is a second <canvas> created here, absolutely positioned under
// the game canvas inside #stage (same box, same CSS rules for the rounded
// corners / shadow / fullscreen). While it runs, the game canvas is transparent
// where the water is and render.js skips its 2D water; everything else is still
// drawn on the game canvas. Light comes from the top left everywhere: shadows
// fall to the bottom right.
//
// Quality ladder (only ever steps down within a session):
//   0  GPU, full resolution        1  GPU, 0.75 resolution
//   2  GPU, 0.6 resolution, cheaper shader (one caustic layer, no fine waves, no glints)
//   3  2D fallback
// It steps down when the measured frame time during play stays poor; the level
// reached is remembered for two weeks (localStorage, best effort). No WebGL,
// a failed shader, or a context lost while the page is visible -> 2D for the
// session. Query overrides: ?water=2d | gl (full, no ladder) | low (level 2, no ladder).

const fract = (x) => x - Math.floor(x);
// the shader's hash12, so the 2D wave marks land in the same places
function h12(x, y) {
  let a = fract(x * 0.1031), b = fract(y * 0.1031), c = a;
  const d = a * (b + 33.33) + b * (c + 33.33) + c * (a + 33.33);
  a += d; b += d; c += d;
  return fract((a + b) * c);
}

// ---- Shared palette (the shader uses the same numbers) --------------------
const OUT = "#08222f";
const C = {
  sky: [33, 120, 160], deep: [13, 77, 114], mid: [17, 92, 130],
  teal: [26, 134, 156], turq: [56, 176, 180], sandSea: [150, 204, 184], wetSand: [199, 184, 140],
};
const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

// ---- Shaders ----------------------------------------------------------------
const VS = `attribute vec2 a_p; void main() { gl_Position = vec4(a_p, 0.0, 1.0); }`;
function fragSource(nObj, low) {
  return `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
#define NOBJ ${nObj}
${low ? "#define LOWQ 1" : ""}
uniform vec4 u_map;    // world.x = fc.x*x + y, world.y = fc.y*z + w
uniform vec4 u_world;  // w, h, shoreY, world units per pixel
uniform vec2 u_res;
uniform float u_t;
uniform float u_lowfx;
uniform vec4 u_sun;    // x, y, radius, strength
uniform int u_nobj; uniform vec4 u_oa[NOBJ]; uniform vec4 u_ob[NOBJ];
uniform int u_ndock; uniform vec4 u_dock[8];
uniform int u_nwhirl; uniform vec4 u_whirl[2];
uniform int u_nswamp; uniform vec4 u_swamp[4];
const float PI = 3.14159265;

float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 h22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h12(i), h12(i + vec2(1.0, 0.0)), f.x), mix(h12(i + vec2(0.0, 1.0)), h12(i + vec2(1.0, 1.0)), f.x), f.y); }
float sdBox(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
// a sine-like wave of period 1 without a transcendental (a smoothed triangle), for every cell of the caustics
vec2 wsin(vec2 x) { vec2 tr = abs(fract(x) - 0.5) * 4.0 - 1.0; return tr * (1.5 - 0.5 * tr * tr); }

// distance (in cell units) to the nearest edge of a drifting Voronoi diagram: the caustic network
// (one pass: the distance to the bisector of the two nearest sites, which is the nearest edge almost everywhere)
float vedge(vec2 p, float t) {
  vec2 n = floor(p), f = fract(p), r1 = vec2(8.0), r2 = vec2(8.0); float d1 = 64.0, d2 = 64.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j)), o = h22(n + g); o = 0.5 + 0.38 * wsin(t * 0.159 + o);
    vec2 r = g + o - f; float d = dot(r, r);
    if (d < d1) { d2 = d1; r2 = r1; d1 = d; r1 = r; } else if (d < d2) { d2 = d; r2 = r; }
  }
  return dot(0.5 * (r1 + r2), normalize(r2 - r1));
}
// cartoon wave marks: short arcs (lit crest, soft trough below) on drifting rows
float crest(vec2 p, float t, float S, float L, float seed, float aa, out float shade) {
  float row = floor(p.y / S), hr = h12(vec2(row, seed));
  float xs = p.x + hr * L + t * (4.0 + 6.0 * hr), cx = floor(xs / L);
  vec2 id = vec2(cx, row + seed * 17.0);
  float h = h12(id), h2 = h12(id + 7.13), h3 = h12(id + 3.71);
  float len = 0.42 + 0.4 * h2, u0 = 0.5 - len * 0.5 + (h3 - 0.5) * (1.0 - len) * 0.8;
  float uu = (fract(xs / L) - u0) / len, inside = step(0.0, uu) * step(uu, 1.0);
  float life = 0.5 + 0.5 * sin(t * (0.35 + 0.45 * h) + h * 50.0);
  float present = step(0.32, h3) * smoothstep(0.15, 0.65, life) * inside;
  float k = clamp(uu, 0.0, 1.0), taper = sin(k * PI);
  float yc = S * (0.3 + 0.32 * h2) + S * 0.15 * (2.0 * k - 1.0) * (2.0 * k - 1.0);
  float d = (p.y - row * S) - yc, w = 0.45 + 1.25 * taper;
  shade = smoothstep(0.0, 2.0, d) * (1.0 - smoothstep(2.0, 2.5 + 7.0 * taper, d)) * present * taper;
  return (1.0 - smoothstep(w - aa, w + aa, abs(d))) * present * smoothstep(0.0, 0.3, taper);
}
float glint(vec2 p, float t, float aa) {
  vec2 g = floor(p / 19.0), f = fract(p / 19.0);
  float h = h12(g + 91.0); vec2 o = h22(g + 3.3) * 0.6 + 0.2; vec2 r = (f - o) * 19.0;
  float tw = pow(max(0.0, sin(t * (1.3 + 2.2 * h) + h * 60.0)), 10.0) * step(0.5, h);
  float s = 0.5 + tw * (2.4 + 1.8 * h);   // a four-point star that grows as it flares
  float a = (1.0 - smoothstep(0.0, s, abs(r.x))) * (1.0 - smoothstep(0.3, 0.3 + aa, abs(r.y)));
  float b = (1.0 - smoothstep(0.0, s * 0.7, abs(r.y))) * (1.0 - smoothstep(0.3, 0.3 + aa, abs(r.x)));
  float c = 1.0 - smoothstep(0.5, 0.5 + aa, length(r));
  return max(max(a, b), c) * tw;
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 p = vec2(fc.x * u_map.x + u_map.y, fc.y * u_map.z + u_map.w);
  float W = u_world.x, H = u_world.y, shore = u_world.z, pxw = u_world.w, t = u_t;
  if (p.x < 0.0 || p.x > W || p.y < 0.0 || p.y > H) { gl_FragColor = vec4(0.031, 0.133, 0.184, 1.0); return; }
  float aa = pxw * 0.85 + 0.12;

  // ---- whirlpool: twist the sample point, keep the funnel terms for later
  vec2 q = p; float funnel = 0.0, warm = 0.0, core = 0.0, rimL = 0.0, wfoam = 0.0;
  for (int i = 0; i < 2; i++) {
    if (i >= u_nwhirl) break;
    vec4 z = u_whirl[i]; vec2 rel = p - z.xy; float R = z.z, d = length(rel);
    if (d > R * 1.4) continue;
    float k = clamp(1.0 - d / (R * 1.4), 0.0, 1.0), tw = 3.4 * k * k, c = cos(tw), s = sin(tw);
    q = z.xy + vec2(c * rel.x - s * rel.y, s * rel.x + c * rel.y);
    funnel = max(funnel, pow(1.0 - smoothstep(R * 0.14, R * 1.08, d), 1.4));
    core = max(core, 1.0 - smoothstep(R * 0.12, R * 0.17, d));
    rimL = max(rimL, (1.0 - smoothstep(0.0, R * 0.035 + aa, abs(d - R * 0.18))) * smoothstep(-0.2, 0.6, -rel.y / max(d, 1.0) - rel.x / max(d, 1.0) * 0.4));
    float ang = atan(rel.y, rel.x), lg = log(max(d, 1.0) / R);
    float NA = 4.0;
    float ph = fract((ang - 1.75 * lg + 1.5 * t) * NA / (2.0 * PI));
    float arc = min(ph, 1.0 - ph) * d * 2.0 * PI / NA;                 // world distance to the nearest arm
    float wA = mix(1.4, 9.0, smoothstep(R * 0.15, R * 0.95, d));
    float brk = 0.7 + 0.3 * vn(vec2(lg * 9.0 + t * 0.7, ang * 2.0 + float(i) * 5.0));
    float env = smoothstep(R * 0.16, R * 0.32, d) * (1.0 - smoothstep(R * 0.85, R * 1.15, d));
    wfoam = max(wfoam, (1.0 - smoothstep(wA * 0.35, wA + aa, arc)) * env * brk);
    warm = max(warm, (0.5 + 0.5 * cos(ph * 2.0 * PI)) * env);       // lighter streaks between arms
    // a broken ring of foam where the water starts to fall in
    float seg = smoothstep(0.38, 0.62, vn(vec2(ang * 4.0 - t * 2.2, float(i))));   // pieces that taper at both ends
    float rf = (1.0 - smoothstep(0.4 + 1.2 * seg, 1.0 + 2.2 * seg + aa, abs(d - R * (0.97 + 0.03 * sin(ang * 5.0 + t * 2.0))))) * seg;
    wfoam = max(wfoam, rf * 0.8);
  }

  // ---- swamps: calm, murky water under the 2D swamp art (it is drawn on top)
  float damp = 0.0;
  for (int i = 0; i < 4; i++) { if (i >= u_nswamp) break; vec4 z = u_swamp[i]; damp = max(damp, 1.0 - smoothstep(0.7, 1.1, length((p - z.xy) / z.zw))); }

  // ---- depth: sky-tinted far edge -> deep blue -> teal -> turquoise shallows -> wet sand at the shore
  float ds = shore - p.y, yN = p.y / H;
  vec3 col = mix(vec3(${C.sky.map((v) => (v / 255).toFixed(3)).join(",")}), vec3(${C.deep.map((v) => (v / 255).toFixed(3)).join(",")}), smoothstep(0.0, 0.25, yN));
  col = mix(col, vec3(${C.mid.map((v) => (v / 255).toFixed(3)).join(",")}), smoothstep(0.35, 0.85, yN));
  col *= 1.0 + (vn(p / 230.0 + vec2(t * 0.012, 0.0)) - 0.5) * 0.16;           // seabed patches
  col = mix(col, vec3(${C.teal.map((v) => (v / 255).toFixed(3)).join(",")}), 1.0 - smoothstep(70.0, 230.0, ds));
  col = mix(col, vec3(${C.turq.map((v) => (v / 255).toFixed(3)).join(",")}), 1.0 - smoothstep(18.0, 105.0, ds));
  col = mix(col, vec3(${C.sandSea.map((v) => (v / 255).toFixed(3)).join(",")}), 1.0 - smoothstep(4.0, 28.0, ds));
  col = mix(col, vec3(${C.wetSand.map((v) => (v / 255).toFixed(3)).join(",")}), 1.0 - smoothstep(-2.0, 9.0, ds));
  float shallow = 1.0 - smoothstep(20.0, 150.0, ds), wet = 1.0 - smoothstep(0.0, 12.0, ds);
  // sand ripples on the bottom in the shallows
  col += vec3(0.05, 0.06, 0.04) * shallow * (1.0 - wet) * smoothstep(0.55, 0.95, sin(p.y * 0.3 + sin(p.x * 0.043) * 2.4 + vn(p / 38.0) * 3.0));
  // broad swell: slow light/dark bands
  col *= 1.0 + 0.045 * sin(q.y * 0.022 + sin(q.x * 0.006 + t * 0.2) * 2.0 - t * 0.5) * (1.0 - wet);

  // ---- surface: caustic network, wave marks, sun
  float calm = (1.0 - damp * 0.75) * (1.0 - wet) * (1.0 - core);
  // the cell edges are bent by two warps (broad drift + a finer wobble), so the network is round and organic
  vec2 wq = q + vec2(vn(q / 90.0 + t * 0.05), vn(q / 90.0 + 7.0 - t * 0.05)) * 16.0;
  wq += vec2(sin(wq.y * 0.21 + t * 0.6) + sin(wq.y * 0.083 - wq.x * 0.05), sin(wq.x * 0.19 - t * 0.5) + sin(wq.x * 0.077 + wq.y * 0.06)) * 3.2;
  float lw = 0.55 + 0.6 * vn(wq / 31.0);                                         // line weight varies along the network
  float e1 = vedge(wq / 70.0, t * 0.55) * 70.0;
  float caus = (1.0 - smoothstep(lw - aa * 0.5, lw + aa, e1)) * 0.8 + exp(-e1 / 3.4) * 0.28;
#ifndef LOWQ
  float e2 = vedge(wq / 41.0 + 13.7, t * 0.7 + 2.0) * 41.0;
  caus = max(caus, ((1.0 - smoothstep(lw * 0.7 - aa * 0.5, lw * 0.7 + aa, e2)) * 0.5 + exp(-e2 / 2.6) * 0.16));
#endif
  caus *= 0.3 + 0.7 * smoothstep(0.25, 0.75, vn(q / 180.0 + vec2(t * 0.03, -t * 0.02)));  // brighter and fainter patches
  float sunD = length((p - u_sun.xy) / u_sun.z), sunM = exp(-sunD * sunD * 1.8) * u_sun.w;
  vec2 cq = q; cq.y += sin(q.x * 0.019 + t * 0.8) * 3.0 + sin(q.x * 0.0071 - t * 0.33 + q.y * 0.01) * 5.0;
  float sh1, cr1 = crest(cq, t, 58.0, 124.0, 0.0, aa, sh1);
  float sh2 = 0.0, cr2 = 0.0, gl = 0.0;
#ifndef LOWQ
  cr2 = crest(cq + vec2(31.0, 17.0), t * 1.15, 33.0, 72.0, 3.0, aa, sh2) * 0.55; sh2 *= 0.5;
  gl = glint(q, t, aa) * sunM * (1.0 - damp);
#endif

  // ---- what sits in the water: shadows, waterline foam, ripples, wakes
  float shadow = 0.0, foam = 0.0, under = 0.0;
  for (int i = 0; i < NOBJ; i++) {
    if (i >= u_nobj) break;
    vec4 a = u_oa[i], b = u_ob[i];
    vec2 rel = p - a.xy; float r = a.z, kind = a.w, spd = length(b.xy), sub = b.z;
    float wl = clamp(spd * 0.5, 0.0, 120.0) * (kind < 0.5 && b.w > 0.5 ? 1.6 : 1.0);   // wake length (longer while dashing)
    float reach = r * 3.6 + wl;
    if (abs(rel.x) > reach || abs(rel.y) > reach) continue;
    float fi = float(i), up = 1.0 - sub;
    vec2 c0; vec2 sc; vec2 so; vec2 fr; float rip = 0.4, wk = 0.75;
    if (kind < 0.5) {            // livboj
      c0 = vec2(0.0); sc = vec2(1.1, 1.06) * r; so = vec2(0.3, 0.42) * r; fr = vec2(1.05, 1.02) * r; rip = 0.45; wk = 1.0;
    } else if (kind < 1.5) {     // swimmer (torso in the water below the head)
      c0 = vec2(0.0, 0.62 * r); sc = vec2(1.15, 0.95) * r; so = vec2(0.34, 0.42) * r; fr = vec2(0.92, 0.6) * r; rip = u_lowfx > 0.5 ? 0.0 : 0.42; wk = u_lowfx > 0.5 ? 0.0 : 0.55;
    } else {                     // monster (b.w = facing)
      c0 = vec2(-0.12 * r * b.w, 0.36 * r); sc = vec2(1.45, 0.72) * r; so = vec2(0.36, 0.42) * r; fr = vec2(1.18, 0.46) * r; rip = 0.36; wk = 0.9;
    }
    vec2 lr = rel - c0;
    // soft contact shadow, offset away from the light; a ring lets light through its hole
    float sd = length((lr - so) / sc);
    float sh = (1.0 - smoothstep(0.5, 1.3, sd));
    if (kind < 0.5) sh *= 0.45 + 0.55 * smoothstep(0.36, 0.62, sd);
    if (kind > 1.5) {            // the raised neck and head throw a shadow too
      vec2 hc = rel - vec2((1.05 * b.w + 0.55) * r, 0.05 * r);
      sh = max(sh, 1.0 - smoothstep(0.25 * r, 0.55 * r, length(hc * vec2(1.0, 1.4))));
    }
    shadow = max(shadow, sh * up * (kind > 0.5 && kind < 1.5 ? 0.8 : 1.0));
    // a diving monster: a dark shape under the surface
    if (kind > 1.5) under = max(under, sub * (1.0 - smoothstep(0.4, 1.0, length((rel - vec2(-0.25 * r * b.w, 0.3 * r)) / (vec2(1.75, 0.8) * r)))));
    // waterline foam, broken and churning
    float ed = length(lr / fr), ang = atan(lr.y, lr.x);
    float brk = 0.45 + 0.55 * vn(vec2(ang * 3.0 + fi * 7.0, t * 1.6 + fi));
    float band = 1.0 - smoothstep(0.0, (2.2 + aa) / length(fr) * 1.4, abs(ed - 1.0));
    foam = max(foam, band * brk * up * 0.9);
    // ripples spreading out
    for (int k = 0; k < 2; k++) {
      float ph = fract(t * 0.42 + h12(vec2(fi, 3.0)) + float(k) * 0.5), rr = 1.0 + ph * 1.5;
      foam = max(foam, (1.0 - smoothstep(0.0, (1.0 + aa) / length(fr) * 1.4 * (1.0 + ph), abs(ed - rr))) * pow(1.0 - ph, 1.6) * rip * (0.4 + 0.6 * up));
    }
    // wake: a V of foam behind anything that moves, churned water right behind it
    if (spd > 6.0 && wk > 0.0) {
      vec2 dir = b.xy / spd;
      float along = -dot(rel, dir), lat = dot(rel, vec2(-dir.y, dir.x));
      if (along > 0.0) {
        float fade = (1.0 - smoothstep(0.0, wl + r, along)) * exp(-along / max(wl, 1.0)) * smoothstep(0.0, r * 0.4, along), str = clamp(spd / 70.0, 0.0, 1.0) * wk;
        float o = r * 0.7 + along * 0.36;                                          // the arms open at ~20 degrees
        float aw = (0.09 * r + 0.05 * along) * (0.6 + 0.4 * str);                  // thick foam near the object, thinning out
        float arm = 1.0 - smoothstep(aw * 0.3, aw + aa, abs(abs(lat) - o));
        arm *= 0.35 + 0.65 * smoothstep(0.25, 0.7, vn(vec2(along * 0.09 - t * 2.2, sign(lat) * 3.0 + fi)));
        float tw = r * 0.6 * (1.0 + along / max(wl, 1.0));
        float trail = exp(-lat * lat / (tw * tw)) * exp(-along / max(wl * 0.6, 1.0)) * smoothstep(0.35, 0.7, vn(vec2(along * 0.15 - t * 3.0, lat * 0.15 + fi * 2.0)));
        foam = max(foam, (arm * 0.9 + trail * 0.7) * fade * str * (1.0 - sub * 0.6));
      }
    }
  }
  float refl = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= u_ndock) break;
    vec4 o = u_dock[i]; vec2 hb = o.zw * 0.5, rel = p - o.xy - hb;
    if (abs(rel.x) > hb.x + 30.0 || abs(rel.y) > hb.y + 30.0) continue;
    float sd0 = sdBox(rel, hb), sds = sdBox(rel - vec2(8.0, 13.0), hb), fi = float(i);
    shadow = max(shadow, (1.0 - smoothstep(-4.0, 8.0, sds)) * 0.95);
    float brk = smoothstep(0.3, 0.75, vn(vec2((rel.x + rel.y) * 0.11 - t * 0.6, fi * 3.0 + t * 0.3)));
    foam = max(foam, (1.0 - smoothstep(0.2, 1.8 + aa, abs(sd0 - 1.2 - brk * 1.2))) * brk * 0.6);
    float lp = fract(t * 0.4 + fi * 0.37);
    foam = max(foam, (1.0 - smoothstep(0.0, 0.9 + aa, abs(sd0 - 3.0 - lp * 9.0))) * (1.0 - lp) * 0.28 * brk);
    float wob = sin(p.x * 0.23 + t * 2.0) * 1.3 + sin(p.y * 0.19 - t * 1.6) * 1.3;
    refl = max(refl, (1.0 - smoothstep(1.0, 14.0, sd0 + wob)) * step(0.0, sd0));
  }

  // ---- compose
  float lightK = (1.0 - shadow * 0.85) * calm;
  col = mix(col, col * vec3(0.93, 0.78, 0.62), refl * 0.35);                   // warm wood colour on the water
  col = mix(col, vec3(0.02, 0.13, 0.22), sh1 * 0.2 * calm + sh2 * 0.14 * calm);    // wave troughs
  col = mix(col, vec3(0.70, 0.92, 0.97), caus * (0.2 + 0.16 * shallow) * lightK); // refracted sunlight
  col += vec3(1.0, 0.96, 0.86) * sunM * 0.05 * calm;                              // sun sheen
  col = mix(col, vec3(0.97, 0.98, 0.94), (cr1 * 0.5 + cr2 * 0.36) * calm * (0.85 + 0.3 * sunM));  // lit crests
  col = mix(col, vec3(1.0, 0.98, 0.9), clamp(gl, 0.0, 1.0) * calm * 0.95);
  // whirlpool funnel: darker, deeper water, streaks between the arms, a black core with a lit lip
  col = mix(col, vec3(0.02, 0.1, 0.18), funnel * 0.78);
  col = mix(col, vec3(0.16, 0.42, 0.55), warm * funnel * 0.22);
  col = mix(col, vec3(0.01, 0.035, 0.06), core);
  col = mix(col, vec3(0.75, 0.9, 0.97), rimL * 0.75);
  col = mix(col, col * vec3(0.5, 0.6, 0.72), shadow * 0.72);                    // cool shadow
  col = mix(col, vec3(0.03, 0.14, 0.2), under * 0.8);
  col = mix(col, vec3(0.93, 0.97, 1.0), clamp(foam * (1.0 - core) + wfoam, 0.0, 1.0) * 0.82);
  vec2 vu = fc / u_res - 0.5;
  col *= 1.0 - dot(vu, vu) * 0.42;                                              // vignette
  gl_FragColor = vec4(col, 1.0);
}`;
}

// ---- Settings: query override, remembered level, device -------------------
const LS_KEY = "livboj-water";
const FORCE = (() => { try { const v = new URLSearchParams(location.search).get("water"); return v === "2d" || v === "gl" || v === "low" ? v : null; } catch { return null; } })();
function rememberedLevel() {
  try { const o = JSON.parse(localStorage.getItem(LS_KEY) || "null"); if (o && Date.now() - o.at < 14 * 864e5 && o.q >= 0 && o.q <= 3) return o.q | 0; } catch {}
  return 0;
}
function remember(q) { try { localStorage.setItem(LS_KEY, JSON.stringify({ q, at: Date.now() })); } catch {} }
let glClaimed = false; // never more than one WebGL context per page

/**
 * The water for one game canvas. -> {
 *   draw(scene) -> true when the GPU layer drew this frame (render.js then skips its 2D water)
 *   info()      -> { mode, level, size, avgMs } for tests
 * }
 * scene = { v, f, t, lowFx, saved, selfId, selfDash, CW, CH, playing }
 */
export function createWater(canvas2d, CW, CH) {
  const coarse = matchMedia("(pointer: coarse)");
  let level = FORCE === "2d" ? 3 : FORCE === "gl" ? 0 : FORCE === "low" ? 2 : rememberedLevel();
  const ladder = !FORCE;
  let gl = null, glc = null, progs = {}, buf = null, nObj = 0, lostVisible = false, active = false;

  function show(on) {
    active = on;
    if (glc) glc.style.display = on ? "block" : "none";
    // the game canvas lets the water through; its own shadow would double the layer's
    canvas2d.style.background = on ? "transparent" : "";
    canvas2d.style.boxShadow = on ? "none" : "";
  }
  function fail() { level = 3; show(false); }

  function compile(type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) { gl.deleteShader(s); return null; }
    return s;
  }
  function program(low) {
    const key = low ? "low" : "hi";
    if (progs[key]) return progs[key];
    const vs = compile(gl.VERTEX_SHADER, VS), fs = compile(gl.FRAGMENT_SHADER, fragSource(nObj, low));
    if (!vs || !fs) return null;
    const p = gl.createProgram(); gl.attachShader(p, vs); gl.attachShader(p, fs); gl.bindAttribLocation(p, 0, "a_p"); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return null;
    const u = {};
    for (const n of ["u_map", "u_world", "u_res", "u_t", "u_lowfx", "u_sun", "u_nobj", "u_oa", "u_ob", "u_ndock", "u_dock", "u_nwhirl", "u_whirl", "u_nswamp", "u_swamp"]) u[n] = gl.getUniformLocation(p, n);
    return (progs[key] = { p, u });
  }
  function initGL() {
    progs = {};
    const maxU = gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS) || 0;
    nObj = Math.max(0, Math.min(coarse.matches ? 24 : 32, Math.floor((maxU - 32) / 2)));
    if (nObj < 8) return false;
    buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    return !!program(level >= 2);
  }

  if (level < 3 && !glClaimed && canvas2d.parentNode) {
    try {
      glc = document.createElement("canvas");
      glc.className = "water";
      glc.setAttribute("aria-hidden", "true");
      // same box as the game canvas: the stage is sized by the game canvas, this one fills the stage
      glc.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;display:none";
      canvas2d.parentNode.insertBefore(glc, canvas2d);
      canvas2d.style.position = "relative"; // positioned after the layer in the DOM -> painted above it
      const attrs = { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: "default", failIfMajorPerformanceCaveat: FORCE !== "gl" && FORCE !== "low" };
      gl = glc.getContext("webgl", attrs) || glc.getContext("experimental-webgl", attrs);
      if (gl) glClaimed = true;
      if (gl && initGL()) {
        glc.addEventListener("webglcontextlost", (e) => { e.preventDefault(); lostVisible = !document.hidden; show(false); }, false);
        glc.addEventListener("webglcontextrestored", () => { if (!lostVisible && level < 3 && initGL()) show(true); else fail(); }, false);
        show(true);
      } else fail();
    } catch { fail(); }
  } else level = 3;

  // ---- frame-time watch (during play only) ---------------------------------
  // The frame interval tells "slow", the time render.js spends on the CPU tells
  // whose fault: when the CPU takes most of the frame, the 2D water (more CPU
  // work) would not help, so the last step (GPU -> 2D) is only taken when it doesn't.
  let lastNow = 0, winSum = 0, winN = 0, win30 = 0, winStart = 0, bad = 0, graceUntil = 0, avgMs = 0, cpuSum = 0, avgCpu = 0, drawAt = 0;
  function watch(now, playing) {
    const dt = now - lastNow; lastNow = now;
    if (!ladder || level >= 3 || !playing || document.hidden || !(dt > 0 && dt < 250) || now < graceUntil) { winSum = winN = win30 = cpuSum = 0; winStart = now; return; }
    winSum += dt; winN++; if (dt > 30 && dt < 37) win30++;
    if (now - winStart < 1500 || winN < 20) return;
    avgMs = winSum / winN; avgCpu = cpuSum / winN;
    const capped30 = avgMs > 30 && avgMs < 37 && win30 / winN > 0.85; // a steady 30 Hz cap (iOS low power mode), not overload
    const cpuBound = avgCpu > avgMs * 0.6;
    const limit = level >= 2 ? 30 : 22;
    bad = avgMs > limit && !capped30 && !(level >= 2 && cpuBound) ? bad + 1 : 0;
    winSum = winN = win30 = cpuSum = 0; winStart = now;
    if (bad >= 2 || (avgMs > 55 && !(level >= 2 && cpuBound))) { bad = 0; stepDown(now); }
  }
  // end of render.js's frame: its CPU time since draw() started
  function frameDone() { if (drawAt) cpuSum += performance.now() - drawAt; drawAt = 0; }
  function stepDown(now) {
    level++;
    remember(level);
    graceUntil = now + 2500;
    if (level >= 3) { show(false); return; }
    if (level >= 2 && !program(true)) fail();
  }

  // ---- motion of things in the water (for wakes) ---------------------------
  const motion = new WeakMap(), pmotion = new Map();
  let mNow = 0, mDt = 0.016;
  function vel(key, x, y, store) {
    let m = store.get(key);
    if (!m) { m = { x, y, vx: 0, vy: 0, at: mNow }; store.set(key, m); return m; }
    const jump = Math.hypot(x - m.x, y - m.y);
    if (jump > 90) { m.vx = m.vy = 0; } else if (mDt > 0) { const k = Math.min(1, mDt * 8); m.vx += ((x - m.x) / mDt - m.vx) * k; m.vy += ((y - m.y) / mDt - m.vy) * k; }
    m.x = x; m.y = y; m.at = mNow; return m;
  }

  // ---- uniforms ---------------------------------------------------------------
  const OA = new Float32Array(32 * 4), OB = new Float32Array(32 * 4), DOCK = new Float32Array(8 * 4), WH = new Float32Array(2 * 4), SW = new Float32Array(4 * 4);
  let size = [0, 0];
  function draw(sc) {
    const now = performance.now();
    watch(now, sc.playing);
    drawAt = now;
    mDt = Math.min(0.1, (now - (mNow || now)) / 1000); mNow = now;
    if (!active || level >= 3 || !gl || gl.isContextLost()) return false;
    const prog = program(level >= 2);
    if (!prog) { fail(); return false; }
    const cssW = canvas2d.clientWidth;
    if (!cssW) return false;
    // soft content: its own (lower) resolution cap
    const k = Math.min(window.devicePixelRatio || 1, 1.25) * [1, 0.75, 0.6][level]; // (width capped below: 1400 on touch devices, 1920 elsewhere)
    const gw = Math.max(64, Math.round(Math.min(cssW * k, coarse.matches ? 1400 : 1920))), gh = Math.round(gw * CH / CW);
    if (glc.width !== gw || glc.height !== gh) { glc.width = gw; glc.height = gh; graceUntil = now + 1000; }
    if (size[0] !== gw || size[1] !== gh) size = [gw, gh];
    gl.viewport(0, 0, gw, gh);
    const { v, f, t } = sc, W = v.world.w, H = v.world.h;
    gl.useProgram(prog.p);
    const U = prog.u;
    gl.uniform4f(U.u_map, CW / (gw * f.s), -f.ox / f.s, -CH / (gh * f.s), (CH - f.oy) / f.s);
    gl.uniform4f(U.u_world, W, H, H - sc.SHORE_H, CW / (gw * f.s));
    gl.uniform2f(U.u_res, gw, gh);
    gl.uniform1f(U.u_t, t % 3600);
    gl.uniform1f(U.u_lowfx, sc.lowFx ? 1 : 0);
    gl.uniform4f(U.u_sun, W * 0.36 + Math.sin(t * 0.05) * W * 0.05, H * 0.3 + Math.cos(t * 0.04) * H * 0.04, Math.min(W, H) * 0.5, 1);
    // things in the water: players first, then monsters, then swimmers nearest to me
    const list = [];
    const self = (v.players || []).find((p) => p.id === sc.selfId);
    const sx = self ? self.x : W / 2, sy = self ? self.y : H / 2;
    for (const p of v.players || []) {
      const m = vel("p" + p.id, p.x, p.y, pmotion), r = p.r || 30;
      const dash = p.id === sc.selfId ? sc.selfDash : (p.dashActive || 0) > 0;
      list.push([p.x, p.y + Math.sin(t * 2.1 + p.x * 0.03) * 1.5, r, 0, m.vx, m.vy, 0, dash ? 1 : 0]);
    }
    for (const mo of v.monsters || []) {
      const m = vel(mo, mo.x, mo.y, motion), R = mo.r || 30, sub = mo.sub || 0;
      const face = mo.face !== undefined ? mo.face : (Math.cos(mo.dir || 0) < 0 ? -1 : 1);
      list.push([mo.x, mo.y + Math.sin(mo.wob || 0) * 2 + sub * R * 0.5, R, 2, m.vx, m.vy, sub, face]);
    }
    const sw = [];
    for (const s of v.swimmers || []) { const m = vel(s, s.x, s.y, motion); sw.push([s.x, s.y + Math.sin(s.bob || 0) * 2.6, s.r || 16, 1, m.vx, m.vy, 0, 0]); }
    for (const s of sc.saved || []) if (s.state === "swim") { const m = vel(s, s.x, s.y, motion); sw.push([s.x, s.y + Math.sin(s.ph || 0) * 1.5 - 5, 9, 1, m.vx, m.vy, 0, 0]); }
    sw.sort((a, b) => Math.hypot(a[0] - sx, a[1] - sy) - Math.hypot(b[0] - sx, b[1] - sy));
    for (const s of sw) list.push(s);
    const n = Math.min(list.length, nObj);
    for (let i = 0; i < n; i++) { const o = list[i]; OA.set(o.slice(0, 4), i * 4); OB.set(o.slice(4, 8), i * 4); }
    gl.uniform1i(U.u_nobj, n);
    gl.uniform4fv(U.u_oa, OA.subarray(0, nObj * 4)); gl.uniform4fv(U.u_ob, OB.subarray(0, nObj * 4));
    const docks = (v.obstacles || []).slice(0, 8);
    docks.forEach((o, i) => DOCK.set([o.x, o.y, o.w, o.h], i * 4));
    gl.uniform1i(U.u_ndock, docks.length); gl.uniform4fv(U.u_dock, DOCK);
    const wh = (v.whirls || []).slice(0, 2);
    wh.forEach((z, i) => WH.set([z.x, z.y, z.r, 0], i * 4));
    gl.uniform1i(U.u_nwhirl, wh.length); gl.uniform4fv(U.u_whirl, WH);
    const swp = (v.swamps || []).slice(0, 4);
    swp.forEach((z, i) => SW.set([z.x + z.w / 2, z.y + z.h / 2, z.w / 2, z.h / 2], i * 4));
    gl.uniform1i(U.u_nswamp, swp.length); gl.uniform4fv(U.u_swamp, SW);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // forget players that left
    for (const [key, m] of pmotion) if (now - m.at > 3000) pmotion.delete(key);
    return true;
  }

  return {
    draw, frameDone,
    info: () => ({ mode: active && level < 3 ? "gl" : "2d", level, forced: FORCE, size, avgMs: Math.round(avgMs * 10) / 10, avgCpu: Math.round(avgCpu * 10) / 10, nObj, glCanvas: !!glc }),
    // tests: force the next step down now
    _stepDown: () => stepDown(performance.now()),
  };
}

// =============================================================================
// 2D fallback: the same water drawn with canvas 2D (simpler sibling, same palette)
// =============================================================================

// A seamless tile of crisp caustic lines (Voronoi cell edges on a periodic
// lattice), generated at the resolution the backing store needs.
const TILE_W = 256, TILE_CELLS = 4; // world units per tile, cells per tile side
let tileCanvas = null, tilePx = 0;
function causticTile(px) {
  if (tileCanvas && tilePx >= px) return tileCanvas;
  const S = px, N = TILE_CELLS, cell = S / N;
  const pts = [];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) pts.push([(i + 0.15 + 0.7 * h12(i + 11, j * 3 + 5)) * cell, (j + 0.15 + 0.7 * h12(i * 7 + 2, j + 19)) * cell]);
  const cv = document.createElement("canvas"); cv.width = cv.height = S;
  const c2 = cv.getContext("2d"), img = c2.createImageData(S, S), d = img.data;
  const unit = S / TILE_W; // px per world unit
  const TAU = Math.PI * 2, A = cell * 0.13;
  for (let y0 = 0; y0 < S; y0++) {
    for (let x0 = 0; x0 < S; x0++) {
      // bend the cell edges (periodic in the tile, so it stays seamless), vary the line weight
      const u = x0 / S, v = y0 / S;
      const x = x0 + A * (Math.sin(TAU * v * 2 + 1.3) + 0.6 * Math.sin(TAU * (u + v) * 3 + 0.4) + 0.35 * Math.sin(TAU * (u * 5 - v * 2)));
      const y = y0 + A * (Math.sin(TAU * u * 2 + 2.1) + 0.6 * Math.sin(TAU * (u - v) * 3 + 2.0) + 0.35 * Math.sin(TAU * (v * 5 + u * 3)));
      const lw = 0.5 + 0.55 * (0.5 + 0.5 * Math.sin(TAU * (u * 3 + v * 2) + 0.7) * Math.sin(TAU * (v * 4 - u) + 1.9));
      const ci = Math.floor(x / cell), cj = Math.floor(y / cell);
      let f1 = 1e9, f2 = 1e9;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = ci + di, jj = cj + dj, pi = ((ii % N) + N) % N, pj = ((jj % N) + N) % N, p = pts[pj * N + pi];
        const px0 = p[0] + Math.floor(ii / N) * S, py0 = p[1] + Math.floor(jj / N) * S; // the periodic copy next to this tile
        const dx = px0 - x, dy = py0 - y, dd = dx * dx + dy * dy;
        if (dd < f1) { f2 = f1; f1 = dd; } else if (dd < f2) f2 = dd;
      }
      const e = (Math.sqrt(f2) - Math.sqrt(f1)) / 2 / unit; // world units to the edge (approx.)
      const line = 1 - Math.min(1, Math.max(0, (e - lw) / (0.35 + 1 / unit)));
      const a = Math.min(1, line * 0.85 + Math.exp(-e / 3) * 0.28);
      const k = (y0 * S + x0) * 4; d[k] = 200; d[k + 1] = 238; d[k + 2] = 248; d[k + 3] = Math.round(a * 255);
    }
  }
  c2.putImageData(img, 0, 0);
  tileCanvas = cv; tilePx = px; return cv;
}

/** Draw the 2D water in world coordinates (ctx already has the world transform). pxPerUnit = backing px per world unit. */
export function drawWater2D(ctx, w, h, shore, t, lowFx, pxPerUnit) {
  ctx.fillStyle = OUT; ctx.fillRect(-w, -h, w * 3, h * 3); // letterbox
  // depth
  const g = ctx.createLinearGradient(0, 0, 0, shore);
  const at = (y) => Math.max(0, Math.min(1, y / shore));
  g.addColorStop(0, rgb(C.sky)); g.addColorStop(at(h * 0.25), rgb(C.deep)); g.addColorStop(at(Math.max(h * 0.6, shore - 240)), rgb(C.mid));
  g.addColorStop(at(shore - 150), rgb(C.teal)); g.addColorStop(at(shore - 60), rgb(C.turq)); g.addColorStop(at(shore - 20), rgb(C.sandSea)); g.addColorStop(1, rgb(C.wetSand));
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, shore + 1);
  // broad swell bands
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, w, shore - 12); ctx.clip();
  // caustics: two layers of a crisp tile, drifting apart
  const want = Math.min(768, Math.max(256, Math.ceil(TILE_W * pxPerUnit / 32) * 32)); // one-time cost: ~70 ms at 728 px on a fast laptop
  const tile = causticTile(want), sc = TILE_W / tile.width;
  const pat = ctx.createPattern(tile, "repeat");
  ctx.globalCompositeOperation = "screen";
  const layers = lowFx ? [[1, 0.2, 7, 4]] : [[1, 0.2, 7, 4], [0.6, 0.13, -10, 5]];
  for (const [s, op, vx, vy] of layers) {
    const k = sc * s, span = TILE_W * s, ox = ((t * vx) % span + span) % span, oy = ((t * vy) % span + span) % span;
    ctx.save(); ctx.globalAlpha = op; ctx.translate(ox - span, oy - span); ctx.scale(k, k); ctx.fillStyle = pat;
    ctx.fillRect(0, 0, (w + span * 2) / k, (shore + span * 2) / k); ctx.restore();
  }
  ctx.globalCompositeOperation = "source-over";
  // wave marks: the shader's crest arcs, as strokes
  ctx.lineCap = "round";
  const rows = (S, L, seed, alpha, tt) => {
    for (let row = Math.floor(-S / S); row * S < shore; row++) {
      const hr = h12(row, seed), off = hr * L + tt * (4 + 6 * hr);
      for (let cx = Math.floor((0 + off) / L) - 1; cx * L - off < w + L; cx++) {
        const ix = cx, iy = row + seed * 17;
        const hh = h12(ix, iy), h2 = h12(ix + 7.13, iy + 7.13), h3 = h12(ix + 3.71, iy + 3.71);
        if (h3 < 0.32) continue;
        const life = 0.5 + 0.5 * Math.sin(tt * (0.35 + 0.45 * hh) + hh * 50), pres = Math.max(0, Math.min(1, (life - 0.15) / 0.5));
        if (pres <= 0.02) continue;
        const len = 0.42 + 0.4 * h2, u0 = 0.5 - len * 0.5 + (h3 - 0.5) * (1 - len) * 0.8;
        const x0 = (cx + u0) * L - off, x1 = x0 + len * L, yc = row * S + S * (0.3 + 0.32 * h2), sag = S * 0.15;
        const wav = Math.sin(((x0 + x1) / 2) * 0.019 + tt * 0.8) * 3;
        const y = yc - wav;
        if (y > shore - 30) continue;
        ctx.strokeStyle = `rgba(5,33,56,${0.16 * pres * alpha})`; ctx.lineWidth = 4.5;
        ctx.beginPath(); ctx.moveTo(x0 + 4, y + sag + 3.5); ctx.quadraticCurveTo((x0 + x1) / 2, y - sag + 3.5, x1 - 4, y + sag + 3.5); ctx.stroke();
        ctx.strokeStyle = `rgba(247,250,240,${0.5 * pres * alpha})`; ctx.lineWidth = 2.2;
        ctx.beginPath(); ctx.moveTo(x0, y + sag); ctx.quadraticCurveTo((x0 + x1) / 2, y - sag, x1, y + sag); ctx.stroke();
      }
    }
  };
  rows(58, 124, 0, 1, t);
  if (!lowFx) rows(33, 72, 3, 0.55, t * 1.15);
  ctx.restore();
  // sun sheen and glints
  const gx = w * 0.36 + Math.sin(t * 0.05) * w * 0.05, gy = h * 0.3 + Math.cos(t * 0.04) * h * 0.04, gr = Math.min(w, h) * 0.5;
  const sun = ctx.createRadialGradient(gx, gy, 0, gx, gy, gr);
  sun.addColorStop(0, "rgba(255,246,220,0.09)"); sun.addColorStop(1, "rgba(255,246,220,0)");
  ctx.fillStyle = sun; ctx.fillRect(gx - gr, gy - gr, gr * 2, gr * 2);
  if (!lowFx) {
    ctx.fillStyle = "#fffbea";
    for (let i = 0; i < 60; i++) {
      const a = i * 2.399, rr = Math.sqrt((i + 0.5) / 60) * gr * 0.85, sx = gx + Math.cos(a) * rr, sy = gy + Math.sin(a) * rr * 0.7;
      const tw = Math.sin(t * (1.3 + (i % 5) * 0.45) + i * 1.7);
      if (tw > 0.7 && sy < shore - 20) { const s = (tw - 0.7) * 10 * (1 - rr / gr); ctx.globalAlpha = Math.min(1, s * 0.5); ctx.fillRect(sx - s, sy - 0.6, s * 2, 1.2); ctx.fillRect(sx - 0.6, sy - s * 0.7, 1.2, s * 1.4); }
    }
    ctx.globalAlpha = 1;
  }
  // lapping foam lines in the shallows, rolling in to the beach
  ctx.lineWidth = 1.6;
  for (let k = 0; k < 2; k++) {
    const ph = (t * 0.18 + k * 0.5) % 1, dy = 60 - ph * 46;
    ctx.strokeStyle = `rgba(240,250,250,${0.45 * (1 - ph) * Math.min(1, ph * 4)})`; ctx.setLineDash([26, 14, 8, 18]); ctx.lineDashOffset = k * 31;
    ctx.beginPath(); for (let x = 0; x <= w; x += 14) { const y = shore - dy + Math.sin(x * 0.035 + k * 2 + t * 0.6) * 4; x ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.stroke();
  }
  ctx.setLineDash([]); ctx.lineCap = "butt";
  // vignette
  const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.hypot(w, h) * 0.55);
  vg.addColorStop(0, "rgba(0,10,20,0)"); vg.addColorStop(1, "rgba(0,10,20,0.24)");
  ctx.fillStyle = vg; ctx.fillRect(0, 0, w, h);
}

// Livbojen — the canvas UI: the HUD, the on-canvas buttons (mute, Spurt, the
// host's "Avsluta spelet", the screens' action / leave buttons), the screens
// (intro, level cleared, game over, win, lobby, waiting) and the vector icons
// they use. No emoji on the canvas: those look different on every device.
//
// render.js calls it after the world is drawn, in logical CW×CH (1200×600)
// canvas coords. `u` (1 … 1.4) scales the HUD and the buttons up when the
// canvas is small on screen (a phone), so text stays legible and the buttons
// stay thumb-sized; at desktop sizes u is 1 and the HUD scales with the canvas.
// The DOM fullscreen button (.fsbtn in index.html and host.html) repeats the
// formula in CSS to sit beside the mute button: change both together.
//
// Type: Fredoka (SIL OFL 1.1, fonts/), added through FontFace without blocking
// anything — the system stack draws until document.fonts has it.
//
// Sibling modules are imported with this module's own ?v=<build> (see boot.js).
const { Phase, BASE_LEVELS } = await import(`./sim.js${new URL(import.meta.url).search}`);

export const FONT_FAMILY = "Livboj";
const FONT_FILE = "fonts/fredoka-latin-v17.woff2"; // not fingerprinted by boot.js: a changed font gets a new name
const STACK = 'ui-rounded, "SF Pro Rounded", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
let fontOk = false;
try {
  if (typeof FontFace === "function" && typeof document !== "undefined" && document.fonts) {
    const face = new FontFace(FONT_FAMILY, `url("${new URL(FONT_FILE, import.meta.url).href}") format("woff2")`, { weight: "300 700", display: "swap" });
    document.fonts.add(face);
    face.load().then(() => { fontOk = true; }, () => {});
  }
} catch { /* no FontFace: the system stack it is */ }
/** A canvas font string: Fredoka once loaded, else the system stack a notch bolder (Fredoka 600 ≈ system 700). */
export function uiFont(weight, px) {
  return fontOk ? `${Math.min(700, weight)} ${px}px "${FONT_FAMILY}", ${STACK}` : `${Math.min(900, weight + 100)} ${px}px ${STACK}`;
}

const C = {
  ink: "#f2f9ff", soft: "#cfe6f3", muted: "#9ec6d9", accent: "#f4571d", accentHi: "#ff8a4c", gold: "#ffc94a",
  good: "#3fd68b", goodHi: "#9af5c8", warn: "#ffb020", bad: "#ff4d4f", badHi: "#ff8a80",
};
const DASH_COOLDOWN = 0.9; // sim.js movePlayer: a dash recharges in 0.9 s
const QUIT_ARM_MS = 3000;  // game.js pressQuit: the second tap must come within 3 s
const CONF = ["#ffb020", "#e5484d", "#3aa0ff", "#22c55e", "#ec4899", "#f4f4f0"];

/**
 * deps: { CW, CH, mode, myName, netSummary(), selfPos, live(), drawRing(x, y, r, hue, glow),
 *         drawGauge(o) (a swimmer's sink gauge again, on top of the HUD), underlay() (the GPU water canvas or null) }
 * The button objects (MUTE_BTN, DASH_BTN, QUIT_BTN) are laid out again every
 * frame and changed in place, so game.js's hit tests always see the drawn size.
 *
 * See-through: the world fills the whole canvas, so swimmers, monsters and rings
 * pass under the HUD. game(v, occ) gets their boxes in canvas coords; every HUD
 * piece with something under it fades (per piece, animated) to a faint outline
 * while its text keeps a dark halo, and a swimmer under any piece gets its sink
 * gauge drawn again above the HUD — a hidden swimmer would be an unfair miss.
 */
export function createHud(canvas, ctx, { CW, CH, mode, myName, netSummary, selfPos, live, drawRing, drawGauge, underlay }) {
  let u = 1;     // UI scale (>= 1 on small canvases)
  let Q = 1;     // the scale of what is being drawn right now (u in the HUD, 1 inside a screen)
  let dk = 1;    // device px per logical px (for shadow blur, which ignores the transform)
  let SK = 1;    // the current screen's own scale (screens are drawn scaled about (CW/2, SCY))
  let SCY = CH / 2;
  let t = 0, L = {};
  const DASH_BTN = { x: CW - 58, y: CH - 58, r: 42 };
  const MUTE_BTN = { x: 32, y: CH - 32, r: 20 };
  const QUIT_BTN = { x: 0, y: 0, w: 0, h: 0 }; // the hit area (a little larger than the drawn pill)
  let quitBox = { x: 0, y: 0, w: 0, h: 0 };
  let ACTION_BTN = null, LEAVE_BTN = null;
  // ---- see-through (occlusion) state ----
  let occ = [], frameDt = 0.016, HALO = 0;
  const seeAnim = new Map();   // piece id -> 0 (solid) … 1 (see-through)
  const seeRects = {};         // piece id -> its rect this frame (canvas coords): debug() and the smoke test read it
  const under = new Set();     // occluders under some HUD piece this frame
  let fsEl, fsOp = "";
  /** How see-through the HUD piece `id` (rect r, canvas coords) is this frame: fades out fast, back in slowly. */
  function see(id, r) {
    let hit = false;
    for (const o of occ) if (o.x < r.x + r.w && o.x + o.w > r.x && o.y < r.y + r.h && o.y + o.h > r.y) { hit = true; under.add(o); }
    const s0 = seeAnim.get(id) || 0, s = s0 + ((hit ? 1 : 0) - s0) * Math.min(1, frameDt * (hit ? 11 : 3.5));
    seeAnim.set(id, s < 0.002 ? 0 : s);
    seeRects[id] = { x: r.x, y: r.y, w: r.w, h: r.h, see: +s.toFixed(3), hit };
    return s;
  }
  const anim = { caught: 0, level: -1, score: null, pop: 0, missed: null, flash: 0, ready: true, ping: 0, phase: null, phaseT: 0 };

  // ---- pointer, for pressed / hover looks only (game.js does the hit tests) ----
  const ptr = { x: -99, y: -99, down: false, mouse: false }, press = { x: -99, y: -99, at: -1e9 };
  const toC = (e) => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * CW / (r.width || 1), y: (e.clientY - r.top) * CH / (r.height || 1) }; };
  canvas.addEventListener("pointerdown", (e) => { const c = toC(e); Object.assign(ptr, c, { down: true, mouse: e.pointerType === "mouse" }); Object.assign(press, c, { at: performance.now() }); }, { passive: true });
  canvas.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse" || ptr.down) Object.assign(ptr, toC(e), { mouse: e.pointerType === "mouse" }); }, { passive: true });
  canvas.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") { ptr.x = ptr.y = -99; } }, { passive: true });
  const up = () => { ptr.down = false; if (!ptr.mouse) ptr.x = ptr.y = -99; };
  addEventListener("pointerup", up, { passive: true });
  addEventListener("pointercancel", up, { passive: true });
  let hoverAny = false, cursor = "";
  const inR = (p, r) => !!r && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  const inC = (p, c, slop = 0) => Math.hypot(p.x - c.x, p.y - c.y) <= c.r + slop;
  function stateOf(hit) { // hit(point) -> { pressed, hover }
    const pressed = (ptr.down && hit(ptr)) || (performance.now() - press.at < 160 && hit(press));
    const hover = ptr.mouse && !ptr.down && hit(ptr);
    if (hover) hoverAny = true;
    return { pressed, hover };
  }

  function layout() {
    const s = (canvas.clientWidth || CW) / CW; // css px per logical px
    u = Math.min(1.4, Math.max(1, 0.92 / s));  // .fsbtn's --u in the pages is the same formula
    MUTE_BTN.r = 20 * u; MUTE_BTN.x = 12 * u + MUTE_BTN.r; MUTE_BTN.y = CH - 12 * u - MUTE_BTN.r;
    DASH_BTN.r = 42 * u; DASH_BTN.x = CW - 16 * u - DASH_BTN.r; DASH_BTN.y = CH - 16 * u - DASH_BTN.r;
    const f = uiFont(600, 13 * u), lw = Math.max(tw("Avsluta spelet", f), tw("Säker? Tryck igen", f));
    const w = Math.ceil(lw + 46 * u), h = 32 * u, x = CW - 10 * u - w, y = 10 * u + 48 * u + 8 * u;
    quitBox = { x, y, w, h };
    Object.assign(QUIT_BTN, { x: x - 6 * u, y: y - 10 * u, w: w + 12 * u, h: h + 20 * u });
  }

  // ---- primitives ----------------------------------------------------------
  function rr(x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function tw(s, f) { ctx.font = f; return ctx.measureText(s).width; }
  function text(s, x, y, f, col, align = "left", base = "alphabetic") {
    ctx.font = f; ctx.textAlign = align; ctx.textBaseline = base;
    if (HALO > 0.02) { // over a see-through panel: a dark outline keeps the text readable on bright water
      ctx.save(); ctx.lineJoin = "round"; ctx.lineWidth = 3.4 * Q; ctx.strokeStyle = `rgba(3,18,30,${0.78 * HALO})`; ctx.strokeText(s, x, y); ctx.restore();
    }
    ctx.fillStyle = col; ctx.fillText(s, x, y);
  }
  /** Icons on a see-through panel: a soft dark shadow under them (the text has its outline). */
  function haloOn() { if (HALO > 0.02) { ctx.save(); ctx.shadowColor = `rgba(3,18,30,${0.9 * HALO})`; ctx.shadowBlur = 3 * Q * dk; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0; return true; } return false; }
  function fitText(s, f, max) { ctx.font = f; if (ctx.measureText(s).width <= max) return s; let a = s; while (a.length > 1 && ctx.measureText(a + "…").width > max) a = a.slice(0, -1); return a.trimEnd() + "…"; }
  const shadow = (blur, dy = 0, col = "rgba(0,8,16,0.4)") => { ctx.shadowColor = col; ctx.shadowBlur = blur * dk * SK; ctx.shadowOffsetY = dy * dk * SK; ctx.shadowOffsetX = 0; };
  /** The UI's one surface: deep-sea glass with a lit top edge and a hairline rim. */
  // o.see (0..1): something is under this piece — the glass thins to a faint tinted outline
  function glass(x, y, w, h, r, o = {}) {
    const sv = o.see || 0, keep = 1 - sv;
    const a = (o.alpha != null ? o.alpha : 0.72) * (1 - 0.86 * sv);
    ctx.save();
    if (keep > 0.05) shadow(14 * Q, 3 * Q, `rgba(0,8,16,${0.42 * Math.min(1, a + 0.2) * keep})`);
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, `rgba(18,56,78,${a})`); g.addColorStop(1, `rgba(5,24,37,${Math.min(1, a + 0.1 * keep)})`);
    rr(x, y, w, h, r); ctx.fillStyle = g; ctx.fill();
    ctx.restore();
    ctx.save(); rr(x, y, w, h, r); ctx.clip();
    if (keep > 0.05) { const sh = Math.min(h * 0.5, 20 * Q), s = ctx.createLinearGradient(0, y, 0, y + sh);
      s.addColorStop(0, `rgba(255,255,255,${0.10 * keep})`); s.addColorStop(1, "rgba(255,255,255,0)"); ctx.fillStyle = s; ctx.fillRect(x, y, w, sh); }
    if (o.tint) { ctx.globalAlpha = 1 - 0.5 * sv; ctx.fillStyle = o.tint; ctx.fillRect(x, y, w, h); }
    ctx.restore();
    rr(x + 0.5, y + 0.5, w - 1, h - 1, r - 0.5); ctx.lineWidth = o.lw || 1;
    if (sv > 0.02 && !o.stroke) { ctx.strokeStyle = `rgba(3,18,30,${0.35 * sv})`; ctx.lineWidth = (o.lw || 1) + 2 * Q * sv; ctx.stroke(); ctx.lineWidth = o.lw || 1; } // dark under the hairline: the outline reads on bright water
    ctx.strokeStyle = o.stroke || `rgba(190,230,250,${0.20 + 0.25 * sv})`; ctx.stroke();
  }
  /** A filled, glossy pill or disc in one colour family (primary orange / danger red). */
  function solid(x, y, w, h, r, top, bottom, glow) {
    ctx.save();
    if (glow) shadow(18 * Q, 3 * Q, glow);
    const g = ctx.createLinearGradient(0, y, 0, y + h); g.addColorStop(0, top); g.addColorStop(1, bottom);
    rr(x, y, w, h, r); ctx.fillStyle = g; ctx.fill(); ctx.restore();
    ctx.save(); rr(x, y, w, h, r); ctx.clip();
    const s = ctx.createLinearGradient(0, y, 0, y + h * 0.55); s.addColorStop(0, "rgba(255,255,255,0.30)"); s.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = s; ctx.fillRect(x, y, w, h * 0.55);
    ctx.restore();
    rr(x + 0.5, y + 0.5, w - 1, h - 1, r - 0.5); ctx.strokeStyle = "rgba(255,255,255,0.30)"; ctx.lineWidth = 1; ctx.stroke();
  }

  // ---- icons (centred on x,y; s = nominal size) ---------------------------
  const icon = {
    ring(x, y, s) { // a small livboj
      const r = s * 0.5, ri = r * 0.52;
      ctx.save(); ctx.translate(x, y);
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.arc(0, 0, ri, 0, Math.PI * 2, true);
      const g = ctx.createLinearGradient(-r, -r, r, r); g.addColorStop(0, "#ff7a3d"); g.addColorStop(1, "#d8430f"); ctx.fillStyle = g; ctx.fill("evenodd");
      ctx.fillStyle = "#fbf4e6";
      for (let i = 0; i < 4; i++) { ctx.save(); ctx.rotate(Math.PI / 4 + i * Math.PI / 2); ctx.beginPath(); ctx.arc(0, 0, r, -0.36, 0.36); ctx.arc(0, 0, ri, 0.36, -0.36, true); ctx.closePath(); ctx.fill(); ctx.restore(); }
      ctx.strokeStyle = "rgba(60,20,0,0.45)"; ctx.lineWidth = Math.max(0.8, s * 0.05);
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.arc(0, 0, ri, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.5)"; ctx.beginPath(); ctx.ellipse(-r * 0.45, -r * 0.5, r * 0.2, r * 0.09, -0.8, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    },
    speaker(x, y, s, on, col) {
      ctx.save(); ctx.translate(x, y); ctx.fillStyle = col; ctx.strokeStyle = col; ctx.lineCap = "round"; ctx.lineJoin = "round";
      const k = s / 24;
      ctx.beginPath(); ctx.moveTo(-9 * k, -3.5 * k); ctx.lineTo(-4.5 * k, -3.5 * k); ctx.lineTo(1.5 * k, -9 * k); ctx.lineTo(1.5 * k, 9 * k); ctx.lineTo(-4.5 * k, 3.5 * k); ctx.lineTo(-9 * k, 3.5 * k); ctx.closePath();
      ctx.lineWidth = 1.6 * k; ctx.fill(); ctx.stroke();
      ctx.lineWidth = 2.1 * k;
      if (on) { ctx.beginPath(); ctx.arc(2 * k, 0, 5 * k, -0.85, 0.85); ctx.stroke(); ctx.beginPath(); ctx.arc(2 * k, 0, 9.5 * k, -0.85, 0.85); ctx.stroke(); }
      else { ctx.beginPath(); ctx.moveTo(5.5 * k, -4 * k); ctx.lineTo(12.5 * k, 4 * k); ctx.moveTo(12.5 * k, -4 * k); ctx.lineTo(5.5 * k, 4 * k); ctx.stroke(); }
      ctx.restore();
    },
    trophy(x, y, s) {
      const k = s / 24; ctx.save(); ctx.translate(x, y); ctx.lineJoin = "round";
      const gold = ctx.createLinearGradient(-10 * k, 0, 10 * k, 0); gold.addColorStop(0, "#ffe27a"); gold.addColorStop(0.5, "#ffc531"); gold.addColorStop(1, "#d8930f");
      ctx.strokeStyle = "#e8a417"; ctx.lineWidth = 2.2 * k; // handles
      ctx.beginPath(); ctx.arc(-8 * k, -4 * k, 4 * k, Math.PI * 0.5, Math.PI * 1.5); ctx.stroke();
      ctx.beginPath(); ctx.arc(8 * k, -4 * k, 4 * k, -Math.PI * 0.5, Math.PI * 0.5); ctx.stroke();
      ctx.fillStyle = gold; ctx.beginPath(); ctx.moveTo(-8 * k, -10 * k); ctx.lineTo(8 * k, -10 * k); ctx.quadraticCurveTo(8 * k, 4 * k, 0, 5 * k); ctx.quadraticCurveTo(-8 * k, 4 * k, -8 * k, -10 * k); ctx.fill();
      ctx.fillRect(-1.6 * k, 4 * k, 3.2 * k, 4 * k);
      ctx.fillStyle = "#c7820c"; rr(-6.5 * k, 7.5 * k, 13 * k, 3.6 * k, 1.2 * k); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.55)"; ctx.beginPath(); ctx.ellipse(-3.6 * k, -5 * k, 1.4 * k, 3.6 * k, 0.15, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    },
    crown(x, y, s) {
      const k = s / 24; ctx.save(); ctx.translate(x, y); ctx.lineJoin = "round";
      const g = ctx.createLinearGradient(0, -9 * k, 0, 8 * k); g.addColorStop(0, "#ffe680"); g.addColorStop(1, "#e59a12");
      ctx.fillStyle = g; ctx.beginPath();
      ctx.moveTo(-11 * k, 7 * k); ctx.lineTo(-12 * k, -5 * k); ctx.lineTo(-5.5 * k, 0); ctx.lineTo(0, -9 * k); ctx.lineTo(5.5 * k, 0); ctx.lineTo(12 * k, -5 * k); ctx.lineTo(11 * k, 7 * k); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = "rgba(120,60,0,0.55)"; ctx.lineWidth = 1.2 * k; ctx.stroke();
      ctx.fillStyle = "#ffd84d"; for (const [px, py] of [[-12, -5], [0, -9], [12, -5]]) { ctx.beginPath(); ctx.arc(px * k, py * k, 2 * k, 0, Math.PI * 2); ctx.fill(); }
      ctx.fillStyle = "#e5484d"; ctx.beginPath(); ctx.arc(0, 3 * k, 2 * k, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#3aa0ff"; ctx.beginPath(); ctx.arc(-6.5 * k, 3.5 * k, 1.5 * k, 0, Math.PI * 2); ctx.arc(6.5 * k, 3.5 * k, 1.5 * k, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    },
    arrowUp(x, y, s, col) {
      const k = s / 24; ctx.save(); ctx.translate(x, y); ctx.strokeStyle = col; ctx.lineWidth = 3.2 * k; ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.beginPath(); ctx.moveTo(0, 9 * k); ctx.lineTo(0, -8 * k); ctx.moveTo(-7 * k, -1 * k); ctx.lineTo(0, -8.5 * k); ctx.lineTo(7 * k, -1 * k); ctx.stroke(); ctx.restore();
    },
    play(x, y, s, col) {
      const k = s / 24; ctx.save(); ctx.translate(x, y); ctx.fillStyle = col; ctx.strokeStyle = col; ctx.lineJoin = "round"; ctx.lineWidth = 2.5 * k;
      ctx.beginPath(); ctx.moveTo(-5 * k, -8 * k); ctx.lineTo(8 * k, 0); ctx.lineTo(-5 * k, 8 * k); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore();
    },
    replay(x, y, s, col) {
      const k = s / 24; ctx.save(); ctx.translate(x, y); ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 2.8 * k; ctx.lineCap = "round";
      ctx.beginPath(); ctx.arc(0, 0, 8 * k, -Math.PI * 0.35, Math.PI * 1.45); ctx.stroke();
      const a = -Math.PI * 0.35, ex = Math.cos(a) * 8 * k, ey = Math.sin(a) * 8 * k;
      ctx.beginPath(); ctx.moveTo(ex + 5 * k, ey - 3.5 * k); ctx.lineTo(ex + 0.5 * k, ey + 4.5 * k); ctx.lineTo(ex - 4.5 * k, ey - 3 * k); ctx.closePath(); ctx.fill(); ctx.restore();
    },
    home(x, y, s, col) {
      const k = s / 24; ctx.save(); ctx.translate(x, y); ctx.strokeStyle = col; ctx.lineWidth = 2.4 * k; ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.beginPath(); ctx.moveTo(-9 * k, -0.5 * k); ctx.lineTo(0, -8.5 * k); ctx.lineTo(9 * k, -0.5 * k); ctx.moveTo(-6.5 * k, -2.5 * k); ctx.lineTo(-6.5 * k, 8 * k); ctx.lineTo(6.5 * k, 8 * k); ctx.lineTo(6.5 * k, -2.5 * k); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-2 * k, 8 * k); ctx.lineTo(-2 * k, 3 * k); ctx.lineTo(2 * k, 3 * k); ctx.lineTo(2 * k, 8 * k); ctx.stroke(); ctx.restore();
    },
    exit(x, y, s, col) { // a door with an arrow leaving it
      const k = s / 24; ctx.save(); ctx.translate(x, y); ctx.strokeStyle = col; ctx.lineWidth = 2.3 * k; ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.beginPath(); ctx.moveTo(1 * k, -9 * k); ctx.lineTo(-8 * k, -9 * k); ctx.lineTo(-8 * k, 9 * k); ctx.lineTo(1 * k, 9 * k); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-2 * k, 0); ctx.lineTo(9.5 * k, 0); ctx.moveTo(5.5 * k, -4 * k); ctx.lineTo(9.5 * k, 0); ctx.lineTo(5.5 * k, 4 * k); ctx.stroke(); ctx.restore();
    },
    bolt(x, y, s, col) {
      const k = s / 24; ctx.save(); ctx.translate(x, y); ctx.fillStyle = col; ctx.strokeStyle = col; ctx.lineJoin = "round"; ctx.lineWidth = 1.4 * k;
      ctx.beginPath(); ctx.moveTo(2.5 * k, -11 * k); ctx.lineTo(-7 * k, 1.5 * k); ctx.lineTo(-0.5 * k, 1.5 * k); ctx.lineTo(-2.5 * k, 11 * k); ctx.lineTo(7 * k, -1.5 * k); ctx.lineTo(0.5 * k, -1.5 * k); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore();
    },
    person(x, y, s, col) {
      const k = s / 24; ctx.save(); ctx.translate(x, y); ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(0, -4.5 * k, 4.2 * k, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-8 * k, 9 * k); ctx.quadraticCurveTo(-8 * k, 1 * k, 0, 1 * k); ctx.quadraticCurveTo(8 * k, 1 * k, 8 * k, 9 * k); ctx.closePath(); ctx.fill(); ctx.restore();
    },
    warn(x, y, s, col) {
      const k = s / 24; ctx.save(); ctx.translate(x, y); ctx.fillStyle = col; ctx.lineJoin = "round"; ctx.strokeStyle = col; ctx.lineWidth = 2.5 * k;
      ctx.beginPath(); ctx.moveTo(0, -9 * k); ctx.lineTo(9.5 * k, 8 * k); ctx.lineTo(-9.5 * k, 8 * k); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#2a0a08"; rr(-1.3 * k, -3.5 * k, 2.6 * k, 7 * k, 1.3 * k); ctx.fill(); ctx.beginPath(); ctx.arc(0, 6 * k, 1.4 * k, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    },
    wave(x, y, s, col) { // a sinking swimmer's last ripple: the "game over" mark
      const k = s / 24; ctx.save(); ctx.translate(x, y); ctx.strokeStyle = col; ctx.lineWidth = 2.6 * k; ctx.lineCap = "round";
      for (const dy of [-3, 4]) { ctx.beginPath(); for (let i = 0; i <= 16; i++) { const xx = (-10 + i * 1.25) * k, yy = (dy + Math.sin(i * 0.8) * 2) * k; i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); } ctx.stroke(); }
      ctx.restore();
    },
  };

  // ---- buttons: one family (solid primary / glass secondary / red danger, all pills or discs) --------
  /** Draw a pill button with an icon and a label. r = rect in the current (screen) coords; hit = mapped rect. */
  function pill(r, label, ico, kind, fpx, st, extra, sv = 0) {
    const { x, y, w, h } = r, cx = x + w / 2, cy = y + h / 2, sc = st.pressed ? 0.95 : st.hover ? 1.03 : 1;
    ctx.save(); ctx.translate(cx, cy); ctx.scale(sc, sc); ctx.translate(-cx, -cy);
    if (kind !== "glass") ctx.globalAlpha = 1 - 0.6 * sv;
    if (kind === "primary") solid(x, y, w, h, h / 2, st.hover ? "#ff8f57" : "#ff7a3d", st.pressed ? "#c93c0b" : "#e2470f", "rgba(244,87,29,0.5)");
    else if (kind === "danger") solid(x, y, w, h, h / 2, "#ff6a5c", "#d22f2f", "rgba(229,72,77,0.55)");
    else glass(x, y, w, h, h / 2, { alpha: st.hover ? 0.82 : 0.68, stroke: sv > 0.02 ? undefined : st.hover ? "rgba(220,240,255,0.45)" : "rgba(190,230,250,0.28)", see: sv });
    if (extra) extra(x, y, w, h);
    ctx.globalAlpha = 1;
    const f = uiFont(kind === "primary" ? 700 : 600, fpx), lw = tw(label, f), is = fpx * 1.15, gap = ico ? fpx * 0.45 : 0, total = (ico ? is + gap : 0) + lw;
    let lx = cx - total / 2;
    const col = "#ffffff";
    if (ico) { const hs = haloOn(); ico(lx + is / 2, cy, is, col); if (hs) ctx.restore(); lx += is + gap; }
    ctx.save(); if (kind !== "glass") shadow(3 * Q, 1 * Q, "rgba(80,20,0,0.35)");
    text(label, lx, cy + fpx * 0.05, f, col, "left", "middle"); ctx.restore();
    ctx.restore();
  }
  // the screens are drawn scaled by SK about the canvas centre: map a rect from there to canvas coords
  const mapR = (r, slop = 0) => ({ x: CW / 2 + (r.x - CW / 2) * SK - slop, y: SCY + (r.y - CH / 2) * SK - slop, w: r.w * SK + slop * 2, h: r.h * SK + slop * 2 });
  /** The host's "go on" button (also Enter / a tap anywhere), centred on cx,cy. */
  function actionButton(label, ico, cx, cy, hint = true) {
    const fpx = 19, f = uiFont(700, fpx), h = 50, w = Math.ceil(tw(label, f) + fpx * 1.6 + 60), r = { x: cx - w / 2, y: cy - h / 2, w, h };
    ACTION_BTN = mapR(r);
    const st = stateOf((p) => inR(p, ACTION_BTN));
    const pulse = 0.5 + 0.5 * Math.sin(t * 3.2);
    ctx.save(); ctx.globalAlpha = 0.25 + 0.25 * pulse; rr(r.x - 5, r.y - 5, w + 10, h + 10, (h + 10) / 2); ctx.strokeStyle = C.accentHi; ctx.lineWidth = 2; ctx.stroke(); ctx.restore();
    pill(r, label, ico, "primary", fpx, st);
    if (hint) text(L.usingTouch ? "eller tryck var som helst" : "eller tryck Enter", cx, cy + h / 2 + 18, uiFont(500, 13), C.muted, "center");
    return w;
  }
  function leaveButton(cx, cy) {
    const label = "Till startsidan", fpx = 16, f = uiFont(600, fpx), h = 44, w = Math.ceil(tw(label, f) + fpx * 1.6 + 44), r = { x: cx - w / 2, y: cy - h / 2, w, h };
    LEAVE_BTN = mapR(r, 8); // 8 px of slop: a thumb-sized target on a phone
    const st = stateOf((p) => inR(p, mapR(r)));
    pill(r, label, icon.home, "glass", fpx, st);
    return w;
  }
  const leaveWidth = () => Math.ceil(tw("Till startsidan", uiFont(600, 16)) + 16 * 1.6 + 44);
  const actionWidth = (label) => Math.ceil(tw(label, uiFont(700, 19)) + 19 * 1.6 + 60);

  function drawMute(game) {
    const b = MUTE_BTN, st = stateOf((p) => inC(p, b, 8)), sc = st.pressed ? 0.92 : st.hover ? 1.05 : 1;
    const sv = game ? see("mute", { x: b.x - b.r, y: b.y - b.r, w: b.r * 2, h: b.r * 2 }) : 0;
    ctx.save(); ctx.translate(b.x, b.y); ctx.scale(sc, sc);
    glass(-b.r, -b.r, b.r * 2, b.r * 2, b.r, { alpha: st.hover ? 0.8 : 0.66, stroke: L.muted ? "rgba(255,140,128,0.55)" : sv > 0.02 ? undefined : "rgba(190,230,250,0.30)", tint: L.muted ? "rgba(229,72,77,0.16)" : null, see: sv });
    HALO = sv; const hs = haloOn();
    icon.speaker(-1 * u, 0, b.r * 1.1, !L.muted, L.muted ? "#ffd2cc" : "#ffffff");
    if (hs) ctx.restore(); HALO = 0;
    ctx.restore();
  }
  /** The DOM fullscreen button beside the mute button (index.html / host.html): the same see-through, through its opacity. */
  function seeFs() {
    if (fsEl === undefined) fsEl = document.getElementById("fsBtn");
    if (!fsEl) return;
    let sv = 0;
    if (!fsEl.hidden) {
      const c = canvas.getBoundingClientRect(), b = fsEl.getBoundingClientRect(), k = CW / (c.width || 1);
      if (b.width > 0 && b.bottom <= c.bottom + 1) sv = see("fs", { x: (b.left - c.left) * k, y: (b.top - c.top) * k, w: b.width * k, h: b.height * k });
    }
    const op = sv > 0.01 ? (1 - 0.62 * sv).toFixed(2) : "";
    if (op !== fsOp) { fsOp = op; fsEl.style.opacity = op; }
  }
  function drawDash(v) {
    if (!(L.usingTouch && v.phase === Phase.PLAY)) { anim.ready = true; return; }
    const me = (v.players || []).find((p) => p.id === L.selfId);
    const cd = L.authoritative ? ((me && me.dashCooldown) || 0) : (selfPos.dashCd || 0);
    const active = (L.authoritative ? ((me && me.dashActive) || 0) : (selfPos.dashActive || 0)) > 0;
    const ready = cd <= 0.0001, frac = 1 - Math.min(1, cd / DASH_COOLDOWN);
    if (ready && !anim.ready) anim.ping = 1;
    anim.ready = ready;
    const b = DASH_BTN, st = stateOf((p) => inC(p, b)), down = active || st.pressed, R = b.r;
    // something under the big thumb button: it thins out (the press look stays), the swimmer's gauge is drawn over it
    const sv = see("dash", { x: b.x - R, y: b.y - R, w: R * 2, h: R * 2 }) * (down ? 0.5 : 1);
    ctx.save(); ctx.translate(b.x, b.y); ctx.globalAlpha = 1 - 0.58 * sv;
    if (anim.ping > 0) { ctx.globalAlpha = anim.ping * 0.8; ctx.strokeStyle = C.accentHi; ctx.lineWidth = 3 * u; ctx.beginPath(); ctx.arc(0, 0, R * (1.02 + 0.3 * (1 - anim.ping)), 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1; }
    ctx.scale(down ? 0.92 : 1, down ? 0.92 : 1);
    if (ready) solid(-R, -R, R * 2, R * 2, R, down ? "#ffa06a" : "#ff7a3d", "#d8410c", down ? "rgba(255,170,110,0.9)" : "rgba(244,87,29,0.55)");
    else {
      glass(-R, -R, R * 2, R * 2, R, { alpha: 0.72 });
      // recharge: an orange arc filling clockwise from the top, on a faint track
      const ar = R - 5 * u; ctx.lineCap = "round";
      ctx.strokeStyle = "rgba(255,255,255,0.13)"; ctx.lineWidth = 5 * u; ctx.beginPath(); ctx.arc(0, 0, ar, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = C.accentHi; ctx.beginPath(); ctx.arc(0, 0, ar, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac); ctx.stroke();
    }
    ctx.globalAlpha = (ready ? 1 : 0.55) * (1 - 0.25 * sv);
    HALO = sv; const hs = haloOn();
    icon.bolt(0, -R * 0.2, R * 0.5, "#ffffff");
    if (hs) ctx.restore();
    ctx.save(); if (ready && sv < 0.02) shadow(3 * u, 1 * u, "rgba(80,20,0,0.4)"); text("Spurt", 0, R * 0.38, uiFont(700, 15 * u), "#ffffff", "center", "middle"); ctx.restore();
    HALO = 0;
    ctx.restore();
  }
  function drawQuit(v) {
    if (!L.authoritative || !(v.phase === Phase.PLAY || v.phase === Phase.INTRO || v.phase === Phase.CLEARED)) return;
    if (v.phase === Phase.CLEARED) { // the level board's card owns the middle: join the bottom row of controls
      quitBox = { ...quitBox, y: CH - 12 * u - 20 * u - quitBox.h / 2 };
      Object.assign(QUIT_BTN, { y: quitBox.y - 10 * u });
    }
    const now = performance.now(), armed = L.quitArmedUntil > now, st = stateOf((p) => inR(p, QUIT_BTN));
    const left = armed ? Math.max(0, (L.quitArmedUntil - now) / QUIT_ARM_MS) : 0;
    const sv = v.phase === Phase.CLEARED ? 0 : see("quit", quitBox) * (st.hover || st.pressed ? 0.3 : 1);
    HALO = sv;
    pill(quitBox, armed ? "Säker? Tryck igen" : "Avsluta spelet", armed ? icon.warn : icon.exit, armed ? "danger" : "glass", 13 * u, st, armed ? (x, y, w, h) => {
      // the time left to confirm: a bar draining along the bottom edge
      ctx.save(); rr(x, y, w, h, h / 2); ctx.clip(); ctx.fillStyle = "rgba(255,255,255,0.35)"; ctx.fillRect(x, y + h - 3 * u, w * left, 3 * u); ctx.restore();
    } : null, sv);
    HALO = 0;
  }

  // ---- HUD -----------------------------------------------------------------
  function drawTop(v) {
    const h = v.hud, T = 10 * u, PH = 48 * u, R = 14 * u;
    // left: level + misses (the danger)
    const allowed = Math.max(1, h.allowedMisses | 0), missed = h.missed | 0, rem = allowed - missed;
    if (anim.missed != null && missed > anim.missed) anim.flash = 1;
    anim.missed = missed;
    const crit = rem <= 0, warn = rem === 1, amber = rem === 2;
    const pulse = crit ? 0.5 + 0.5 * Math.sin(t * 7) : warn ? 0.5 + 0.5 * Math.sin(t * 4) : 0;
    const shake = anim.flash > 0 ? Math.sin(t * 60) * 3 * u * anim.flash : 0;
    const LW = 164 * u, lx = T + shake;
    const danger = crit || warn;
    let sv = see("level", { x: T, y: T, w: LW, h: PH });
    glass(lx, T, LW, PH, R, {
      stroke: danger || anim.flash > 0 ? `rgba(255,95,90,${Math.max(0.45 + 0.45 * pulse, anim.flash)})` : undefined, lw: danger ? 1.6 * u : 1,
      tint: danger || anim.flash > 0 ? `rgba(229,60,60,${Math.max(0.12 + 0.16 * pulse, anim.flash * 0.35)})` : null, see: sv,
    });
    HALO = sv;
    let hs = haloOn(); icon.ring(lx + 19 * u, T + 14.5 * u, 15 * u); if (hs) ctx.restore();
    text(`Nivå ${h.level + 1}/${BASE_LEVELS.length}`, lx + 33 * u, T + 20.5 * u, uiFont(600, 17 * u), C.ink);
    const mcol = crit || warn ? C.badHi : amber ? "#ffc56b" : "#ffd7c7", mf = uiFont(600, 12.5 * u), ml = `Missade ${missed}/${allowed}`;
    let mx = lx + 12 * u;
    if (danger) { hs = haloOn(); icon.warn(mx + 6 * u, T + 34.5 * u, 12 * u, crit ? `rgba(255,${90 + 60 * pulse},80,1)` : "#ff7a6a"); if (hs) ctx.restore(); mx += 15 * u; }
    text(ml, mx, T + 39 * u, mf, mcol);
    // the misses meter: one slot per allowed miss, filled red as they go
    const sx = mx + tw(ml, mf) + 9 * u, sw = lx + LW - 12 * u - sx, n = allowed, gap = n > 12 ? 1.5 * u : 2.5 * u, seg = (sw - gap * (n - 1)) / n, sy = T + 31.5 * u, sh = 6 * u;
    for (let i = 0; i < n; i++) {
      rr(sx + i * (seg + gap), sy, seg, sh, Math.min(sh / 2, seg / 2));
      if (sv > 0.02) { ctx.strokeStyle = `rgba(3,18,30,${0.6 * sv})`; ctx.lineWidth = 2 * u; ctx.stroke(); }
      ctx.fillStyle = i < missed ? (crit ? `rgb(255,${70 + 50 * pulse},${60 + 40 * pulse})` : "#ff6257") : `rgba(255,255,255,${0.16 + 0.1 * sv})`; ctx.fill();
    }
    HALO = 0;

    // centre: rescued / quota (the goal) with a progress bar
    const quota = Math.max(1, h.quota | 0), caught = Math.min(quota, h.caught | 0);
    if (h.level !== anim.level || caught < anim.caught) anim.caught = caught; // a new level starts at 0
    anim.level = h.level;
    anim.caught += (caught - anim.caught) * Math.min(1, 0.18);
    const CWp = 280 * u, cx0 = CW / 2 - CWp / 2;
    sv = see("goal", { x: cx0, y: T, w: CWp, h: PH });
    glass(cx0, T, CWp, PH, R, { see: sv });
    HALO = sv;
    const fl = uiFont(500, 15 * u), fn = uiFont(700, 21 * u), fq = uiFont(600, 15 * u);
    let x = cx0 + 14 * u; const by = T + 21.5 * u;
    text("Räddade", x, by, fl, C.soft); x += tw("Räddade ", fl);
    text(String(caught), x, by, fn, C.ink); x += tw(String(caught), fn);
    text(` / ${quota}`, x, by, fq, C.muted);
    const pl = `${h.n} spelare`, pf = uiFont(500, 12.5 * u), pw = tw(pl, pf);
    text(pl, cx0 + CWp - 14 * u, by, pf, C.muted, "right");
    hs = haloOn(); icon.person(cx0 + CWp - 14 * u - pw - 9 * u, by - 4.5 * u, 12 * u, C.muted); if (hs) ctx.restore();
    const bx = cx0 + 14 * u, bw = CWp - 28 * u, bh = 9 * u, bY = T + 29 * u, fr = Math.max(0, Math.min(1, anim.caught / quota));
    rr(bx, bY, bw, bh, bh / 2); ctx.fillStyle = `rgba(0,12,22,${0.55 - 0.3 * sv})`; ctx.fill(); ctx.strokeStyle = `rgba(255,255,255,${0.10 + 0.25 * sv})`; ctx.lineWidth = 1; ctx.stroke();
    if (fr > 0.002) {
      const fw = Math.max(bh, bw * fr), g = ctx.createLinearGradient(bx, 0, bx + bw, 0);
      g.addColorStop(0, "#21b878"); g.addColorStop(1, "#5fe8a8");
      ctx.save(); shadow(8 * u, 0, "rgba(80,240,170,0.55)"); rr(bx, bY, fw, bh, bh / 2); ctx.fillStyle = g; ctx.fill(); ctx.restore();
      ctx.save(); rr(bx, bY, fw, bh, bh / 2); ctx.clip(); ctx.fillStyle = "rgba(255,255,255,0.35)"; ctx.fillRect(bx, bY + 1, fw, bh * 0.38); ctx.restore();
    }
    // quarter ticks, so "how far" reads at a glance
    ctx.fillStyle = "rgba(255,255,255,0.22)"; for (const q of [0.25, 0.5, 0.75]) { if (q > fr) ctx.fillRect(bx + bw * q - 0.5, bY + 2 * u, 1, bh - 4 * u); }

    // right: your score (pops when it grows)
    const sc = h.yourScore | 0;
    if (anim.score != null && sc > anim.score) anim.pop = 1;
    anim.score = sc;
    const sl = "Din poäng", slf = uiFont(500, 12.5 * u), snf = uiFont(700, 24 * u);
    const RW = Math.max(104 * u, tw(String(sc), snf) + 30 * u, tw(sl, slf) + 28 * u), rx = CW - T - RW;
    sv = see("score", { x: rx, y: T, w: RW, h: PH });
    glass(rx, T, RW, PH, R, { see: sv });
    HALO = sv;
    text(sl, rx + RW / 2, T + 16.5 * u, slf, C.muted, "center");
    const pop = 1 + 0.22 * anim.pop * anim.pop;
    ctx.save(); ctx.translate(rx + RW / 2, T + 40.5 * u); ctx.scale(pop, pop);
    text(String(sc), 0, 0, snf, anim.pop > 0.05 ? "#ffb184" : C.accentHi, "center"); ctx.restore();
    HALO = 0;
  }
  function drawScoreboard(v) {
    if (v.hud.n < 2 || !v.players) return;
    const all = [...v.players].map((p) => ({ name: p.id === L.selfId ? "Du" : (p.name || "Spelare"), score: p.score || 0, hue: p.hue, you: p.id === L.selfId })).sort((a, b) => b.score - a.score);
    // a short list: the leaders, and you on the last row (with your place) when you are further down.
    // Phones (u > 1.15) get four rows, larger canvases six: the full table is on the level board.
    const max = u > 1.15 ? 4 : 6;
    let board = all.slice(0, max);
    if (all.length > max) { const yi = all.findIndex((b) => b.you); if (yi >= max) board = [...all.slice(0, max - 1), { ...all[yi], place: yi + 1 }]; }
    const T = 10 * u, x = T, y = T + 48 * u + 8 * u, rh = 18 * u, w = 164 * u, hgt = board.length * rh + 10 * u;
    const sv = see("board", { x, y, w, h: hgt });
    glass(x, y, w, hgt, 12 * u, { alpha: 0.55, see: sv });
    HALO = sv;
    const nf = uiFont(600, 13 * u), sf = uiFont(700, 13 * u);
    board.forEach((b, i) => {
      const ry = y + 5 * u + i * rh, mid = ry + rh / 2;
      if (b.you) { rr(x + 4 * u, ry + 1 * u, w - 8 * u, rh - 2 * u, 7 * u); ctx.fillStyle = `rgba(244,87,29,${0.22 * (1 - 0.5 * sv)})`; ctx.fill(); }
      ctx.fillStyle = `hsl(${b.hue},85%,60%)`; ctx.beginPath(); ctx.arc(x + 14 * u, mid, 4.5 * u, 0, Math.PI * 2); ctx.fill();
      if (sv > 0.02) { ctx.strokeStyle = `rgba(3,18,30,${0.6 * sv})`; ctx.lineWidth = 1.5 * u; ctx.stroke(); }
      const st = `${b.score} p`, sw = tw(st, sf), nm = b.place ? `${b.place}. ${b.name}` : b.name;
      text(fitText(nm, nf, w - 40 * u - sw), x + 24 * u, mid + 0.5 * u, nf, b.you ? "#ffd7c7" : C.ink, "left", "middle");
      text(st, x + w - 10 * u, mid + 0.5 * u, sf, b.you ? "#ffd7c7" : C.soft, "right", "middle");
    });
    HALO = 0;
  }

  // ---- screens ---------------------------------------------------------------
  let blurA = null, blurB = null;
  /** Soften the frame drawn so far: shrink it to 1/16 in two steps and stretch it back (cheap everywhere, no ctx.filter). */
  function backdrop(dim = 0.6) {
    try {
      const W = canvas.width, H = canvas.height;
      if (!blurA) { blurA = document.createElement("canvas"); blurB = document.createElement("canvas"); }
      const aw = Math.max(16, Math.round(W / 4)), ah = Math.max(10, Math.round(H / 4)), bw = Math.max(8, Math.round(W / 16)), bh = Math.max(6, Math.round(H / 16));
      if (blurA.width !== aw || blurA.height !== ah) { blurA.width = aw; blurA.height = ah; }
      if (blurB.width !== bw || blurB.height !== bh) { blurB.width = bw; blurB.height = bh; }
      const a = blurA.getContext("2d"), b = blurB.getContext("2d");
      a.imageSmoothingQuality = b.imageSmoothingQuality = "high";
      // with the GPU water the game canvas is transparent over the water: blur the water layer
      // (read back in the same frame it was drawn) together with what is drawn on top of it
      const layer = underlay && underlay();
      a.clearRect(0, 0, aw, ah);
      if (layer) a.drawImage(layer, 0, 0, layer.width, layer.height, 0, 0, aw, ah);
      a.drawImage(canvas, 0, 0, W, H, 0, 0, aw, ah);
      if ("filter" in b) b.filter = "blur(1.2px)"; // (tiny canvas: cheap) rounds off the bilinear blocks
      b.clearRect(0, 0, bw, bh); b.drawImage(blurA, 0, 0, aw, ah, 0, 0, bw, bh);
      if ("filter" in b) b.filter = "none";
      a.clearRect(0, 0, aw, ah); a.drawImage(blurB, 0, 0, bw, bh, 0, 0, aw, ah); // back up in two steps
      ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high"; ctx.drawImage(blurA, 0, 0, CW, CH); ctx.restore();
    } catch { /* tainted or unsupported: the dim alone */ }
    const g = ctx.createRadialGradient(CW / 2, CH / 2, CH * 0.15, CW / 2, CH / 2, CW * 0.65);
    g.addColorStop(0, `rgba(3,18,30,${dim * 0.75})`); g.addColorStop(1, `rgba(2,12,22,${Math.min(0.95, dim * 1.25)})`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, CW, CH);
  }
  /**
   * Draw fn() — laid out for a W×H card centred on the canvas — scaled to fit between the top edge and
   * the bottom row of controls (mute, fullscreen, quit): grows with u on a phone, shrinks to fit.
   */
  function scaled(W, H, fn) {
    const top = 8, bottom = CH - 12 * u - 40 * u - 8, k = Math.min(u, (CW - 20) / W, (bottom - top) / H);
    SK = k; SCY = (top + bottom) / 2; Q = 1;
    ctx.save(); ctx.translate(CW / 2, SCY); ctx.scale(k, k); ctx.translate(-CW / 2, -CH / 2);
    try { fn(); } finally { ctx.restore(); SK = 1; SCY = CH / 2; Q = u; }
  }
  function card(x, y, w, h) { glass(x, y, w, h, 24, { alpha: 0.8, stroke: "rgba(190,230,250,0.22)" }); seeRects._card = mapR({ x, y, w, h }); } // (_card, _team: for the tests, canvas coords)
  /** The team's name (when the host gave one) as a small heading under a screen's title: centred, short hairlines either side, ellipsised to maxW. */
  const TEAM_H = 30; // the height a screen grows by when it shows the line
  function teamLine(name, cx, y, maxW) {
    const f = uiFont(600, 18), full = tw(name, f) > maxW - 2 * (26 + 12), rule = full ? 0 : 26, gap = full ? 0 : 12; // a long name takes the rules' room
    const s = fitText(name, f, maxW - 2 * (rule + gap)), w = tw(s, f);
    if (rule) for (const d of [-1, 1]) {
      const x0 = cx + d * (w / 2 + gap), x1 = x0 + d * rule, g = ctx.createLinearGradient(x0, 0, x1, 0);
      g.addColorStop(0, "rgba(255,138,76,0.7)"); g.addColorStop(1, "rgba(255,138,76,0)");
      ctx.fillStyle = g; ctx.fillRect(Math.min(x0, x1), y - 7, rule, 1.5);
    }
    text(s, cx, y, f, C.accentHi, "center");
    seeRects._team = { text: s, ...mapR({ x: cx - w / 2 - gap - rule, y: y - 18, w: w + 2 * (gap + rule), h: 24 }) };
  }
  function confetti(n) {
    for (let i = 0; i < n; i++) {
      const x = ((i * 197) % CW) + Math.sin(t * 1.3 + i) * 22;
      const y = ((((t * (38 + (i % 5) * 11) + i * 53) % (CH + 40)) + CH + 40) % (CH + 40)) - 20;
      ctx.save(); ctx.translate(x, y); ctx.rotate(t * 2 + i); ctx.scale(1, 0.6 + 0.4 * Math.sin(t * 5 + i)); ctx.globalAlpha = 0.9; ctx.fillStyle = CONF[i % CONF.length]; ctx.fillRect(-4, -2.5, 8, 5); ctx.restore();
    }
  }
  function levelDots(cx, y, cur) {
    const n = BASE_LEVELS.length, gap = 20, x0 = cx - (n - 1) * gap / 2;
    for (let i = 0; i < n; i++) {
      const x = x0 + i * gap;
      ctx.beginPath(); ctx.arc(x, y, i === cur ? 6 : 4.5, 0, Math.PI * 2);
      if (i < cur) { ctx.fillStyle = C.good; ctx.fill(); }
      else if (i === cur) { ctx.fillStyle = C.accent; ctx.fill(); ctx.strokeStyle = "rgba(255,200,170,0.9)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 9 + Math.sin(t * 4) * 1, 0, Math.PI * 2); ctx.stroke(); }
      else { ctx.fillStyle = "rgba(255,255,255,0.18)"; ctx.fill(); }
    }
  }
  function drawIntro(v) {
    const h = v.hud, fade = Math.min(1, anim.phaseT * 4);
    const W = 360, H = 176, x = CW / 2 - W / 2, y = CH / 2 - H / 2;
    const grow = 0.92 + 0.08 * Math.min(1, anim.phaseT * 5);
    scaled(W / grow, H / grow, () => {
      ctx.globalAlpha = fade;
      card(x, y, W, H);
      icon.ring(CW / 2, y + 2, 40);
      text(`Nivå ${h.level + 1}`, CW / 2, y + 74, uiFont(700, 44), C.ink, "center");
      text(`Rädda ${h.quota} · ${h.n} spelare`, CW / 2, y + 108, uiFont(500, 19), C.soft, "center");
      levelDots(CW / 2, y + 142, h.level);
      ctx.globalAlpha = 1;
    });
  }
  // Between levels: confetti, a top-three podium, the "på väg upp" riser and the
  // host's button. Only the host advances (advance() is gated).
  function drawLevelBoard(v) {
    backdrop(0.62);
    confetti(46);
    const rows = [...(v.players || [])].map((p) => ({ id: p.id, name: p.id === L.selfId ? "Du" : (p.name || "Spelare"), score: p.score || 0, rescues: p.rescues || 0, hue: p.hue, you: p.id === L.selfId, gain: (p.score || 0) - ((L.levelStartScore && L.levelStartScore.get(p.id)) || 0) })).sort((a, b) => b.score - a.score);
    const TH = v.team ? TEAM_H : 0; // the team's name under the title
    const W = 620, H = (rows.length > 3 ? 478 : 450) + TH, x0 = CW / 2 - W / 2, y0 = CH / 2 - H / 2;
    scaled(W, H, () => {
      card(x0, y0, W, H);
      text(`Nivå ${v.hud.level + 1} avklarad!`, CW / 2, y0 + 50, uiFont(700, 34), C.ink, "center");
      if (TH) teamLine(v.team, CW / 2, y0 + 82, W - 80);
      text(`Lagets poäng ${v.hud.score}`, CW / 2, y0 + 78 + TH, uiFont(500, 17), C.soft, "center");
      // podium: 2nd left, 1st centre, 3rd right
      const baseY = y0 + 252 + TH, slots = [[1, -128, 64, ["#e6ebf2", "#a9b3c1"]], [0, 0, 88, ["#ffe27a", "#e6a417"]], [2, 128, 48, ["#eaa66b", "#b86a32"]]];
      for (const [rank, dx, hgt, [c0, c1]] of slots) {
        const r = rows[rank]; if (!r) continue;
        const x = CW / 2 + dx, bounce = rank === 0 ? Math.abs(Math.sin(t * 3)) * 6 : 0;
        ctx.save(); shadow(12, 4, "rgba(0,0,0,0.35)");
        const g = ctx.createLinearGradient(0, baseY - hgt, 0, baseY); g.addColorStop(0, c0); g.addColorStop(1, c1);
        ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x - 48, baseY - hgt, 96, hgt, [10, 10, 4, 4]); else ctx.rect(x - 48, baseY - hgt, 96, hgt);
        ctx.fillStyle = g; ctx.fill(); ctx.restore();
        ctx.fillStyle = "rgba(255,255,255,0.35)"; ctx.fillRect(x - 44, baseY - hgt + 3, 88, 3);
        text(String(rank + 1), x, baseY - hgt / 2 + 11, uiFont(700, 30), "rgba(60,30,0,0.35)", "center");
        drawRing(x, baseY - hgt - 24 - bounce, 18, r.hue, rank === 0);
        if (rank === 0) icon.crown(x, baseY - hgt - 56 - bounce, 30);
        text(fitText(r.name, uiFont(600, 16), 120), x, baseY + 24, uiFont(600, 16), r.you ? "#ffd7c7" : C.ink, "center");
        text(`${r.score} p · ${r.rescues} räddade`, x, baseY + 43, uiFont(500, 13.5), C.muted, "center");
      }
      let y = baseY + 80;
      // up-and-coming: biggest gain this level among players not already leading
      const riser = rows.length > 1 ? rows.slice(1).reduce((m, r) => (r.gain > (m ? m.gain : 0) ? r : m), null) : null;
      const rl = riser && riser.gain > 0 ? `På väg upp: ${riser.name}  +${riser.gain} p den här nivån` : rows[0] ? `Bra jobbat! +${rows[0].gain} p den här nivån` : "";
      if (rl) {
        const f = uiFont(600, 16), w = tw(rl, f) + (riser && riser.gain > 0 ? 58 : 36), cx = CW / 2;
        rr(cx - w / 2, y - 17, w, 34, 17); ctx.fillStyle = "rgba(63,214,139,0.16)"; ctx.fill(); ctx.strokeStyle = "rgba(63,214,139,0.45)"; ctx.lineWidth = 1; ctx.stroke();
        let tx = cx - w / 2 + 18;
        if (riser && riser.gain > 0) { icon.arrowUp(tx + 8, y, 18, C.goodHi); tx += 24; }
        text(rl, tx, y + 1, f, "#a8f0c8", "left", "middle");
      }
      y += 34;
      if (rows.length > 3) text(fitText(rows.slice(3, 12).map((r, i) => `${i + 4}. ${r.name} ${r.score} p`).join("   ·   "), uiFont(500, 14), W - 40), CW / 2, y + 4, uiFont(500, 14), C.muted, "center");
      const by = y0 + H - 56;
      if (L.authoritative) actionButton("Starta nästa nivå", icon.play, CW / 2, by - 6);
      else { ctx.globalAlpha = 0.75 + 0.25 * Math.sin(t * 3); text("Väntar på att värden startar nästa nivå…", CW / 2, by, uiFont(500, 16), C.soft, "center", "middle"); ctx.globalAlpha = 1; }
    });
  }
  function drawEndScreen(v, win) {
    backdrop(0.66);
    if (win) confetti(60);
    const lines = win ? ["Ni vann!", `Alla ${BASE_LEVELS.length} nivåer klara`] : ["Spelet är slut"];
    const sub = win ? `Slutpoäng ${v.hud.score}` : `Totalpoäng ${v.hud.score}`;
    const rows = [...(v.players || [])].map((p) => ({ name: p.id === L.selfId ? "Du" : (p.name || "Spelare"), score: p.score || 0, rescues: p.rescues || 0, hue: p.hue, you: p.id === L.selfId })).sort((a, b) => b.score - a.score).slice(0, 8);
    const soloGame = (v.players || []).length <= 1;
    const board = (v.board || []).filter((e) => (e.n === 1) === soloGame).slice(0, 3); // solo runs compare with solo runs, teams with teams
    // Entries from before individual crediting worked have a total but all-zero players: show names only.
    const fmt = (e) => { const ps = e.players || []; const noSplit = ps.every((pp) => typeof pp === "string" || !pp.score); return ps.map((pp) => typeof pp === "string" ? pp : (noSplit ? pp.name : `${pp.name} ${pp.score}p`)).join(", "); };
    const W = 580, RH = 27, BH = 24, TH = v.team ? TEAM_H + 4 : 0;
    const H = 30 + 52 + lines.length * 42 + TH + 30 + 18 + 30 + rows.length * RH + 16 + 30 + Math.max(1, board.length) * BH + 26 + 50 + (L.authoritative ? 30 : 56) + 14;
    const x0 = CW / 2 - W / 2, y0 = CH / 2 - H / 2;
    scaled(W, H, () => {
      card(x0, y0, W, H);
      let y = y0 + 30;
      // emblem: a trophy on a won game, a last ripple on a lost one, in a soft halo
      const g = ctx.createRadialGradient(CW / 2, y + 20, 4, CW / 2, y + 20, 46); g.addColorStop(0, win ? "rgba(255,201,74,0.45)" : "rgba(120,190,230,0.30)"); g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g; ctx.fillRect(CW / 2 - 50, y - 30, 100, 100);
      if (win) icon.trophy(CW / 2, y + 20, 46); else { icon.ring(CW / 2, y + 16 + Math.sin(t * 2) * 2, 38); icon.wave(CW / 2, y + 40, 30, "rgba(190,230,250,0.85)"); }
      y += 52;
      for (const l of lines) {
        y += 36;
        let col = C.ink;
        if (win && l === lines[0]) { col = ctx.createLinearGradient(0, y - 32, 0, y + 4); col.addColorStop(0, "#fff3b8"); col.addColorStop(0.55, "#ffd34d"); col.addColorStop(1, "#f0a417"); }
        text(l, CW / 2, y, uiFont(700, lines.length > 1 && l !== lines[0] ? 28 : 36), col, "center"); y += 6;
      }
      if (TH) { y += TH; teamLine(v.team, CW / 2, y - 2, W - 80); } // the team's name, then its score
      y += 26; text(sub, CW / 2, y, uiFont(600, 19), C.gold, "center");
      y += 18;
      // standings
      const L0 = x0 + 34, R0 = x0 + W - 34;
      y += 22; text("Ställning", L0, y, uiFont(700, 16), C.accentHi); ctx.fillStyle = "rgba(255,255,255,0.12)"; ctx.fillRect(L0 + tw("Ställning", uiFont(700, 16)) + 12, y - 5, R0 - L0 - tw("Ställning", uiFont(700, 16)) - 12, 1);
      y += 8;
      rows.forEach((r, i) => {
        const mid = y + RH / 2;
        if (r.you) { rr(L0 - 10, y + 2, R0 - L0 + 20, RH - 4, 9); ctx.fillStyle = "rgba(244,87,29,0.18)"; ctx.fill(); }
        text(`${i + 1}.`, L0 + 14, mid + 1, uiFont(600, 15), C.muted, "right", "middle");
        ctx.fillStyle = `hsl(${r.hue},85%,60%)`; ctx.beginPath(); ctx.arc(L0 + 28, mid, 5.5, 0, Math.PI * 2); ctx.fill();
        const right = `${r.rescues} räddade`, rf = uiFont(500, 14), sf = uiFont(700, 16), rw = tw(right, rf);
        text(right, R0, mid + 1, rf, C.muted, "right", "middle");
        text(`${r.score} p`, R0 - rw - 16, mid + 1, sf, r.you ? "#ffd7c7" : C.ink, "right", "middle");
        text(fitText(r.name, uiFont(600, 16), R0 - L0 - 200), L0 + 42, mid + 1, uiFont(600, 16), r.you ? "#ffd7c7" : C.ink, "left", "middle");
        y += RH;
      });
      y += 16;
      // the leaderboard (global when the relay answers)
      y += 22; icon.trophy(L0 + 9, y - 6, 20); text("Topplista", L0 + 24, y, uiFont(700, 16), C.accentHi);
      ctx.fillStyle = "rgba(255,255,255,0.12)"; ctx.fillRect(L0 + 24 + tw("Topplista", uiFont(700, 16)) + 12, y - 5, R0 - L0 - 36 - tw("Topplista", uiFont(700, 16)), 1);
      y += 8;
      const bf = uiFont(500, 14.5);
      if (!board.length) { text("Inga resultat än", L0, y + BH / 2 + 1, bf, C.muted, "left", "middle"); y += BH; }
      else board.forEach((e, i) => { text(fitText(`${i + 1}.  ${e.team || (e.n === 1 ? "Solo" : "Lag")} ${e.score} p  ·  ${fmt(e)}  (Nivå ${e.level})`, bf, R0 - L0), L0, y + BH / 2 + 1, bf, C.soft, "left", "middle"); y += BH; });
      y += 26;
      const by = y + 25;
      if (L.authoritative) {
        // solo has no lobby: advance() starts a new solo game from level 1
        const label = mode === "solo" ? "Spela igen" : "Till lobbyn", ico = mode === "solo" ? icon.replay : icon.play;
        const aw = actionWidth(label), lw = leaveWidth(), gap = 18, tot = aw + gap + lw, ax = CW / 2 - tot / 2 + aw / 2, lx = CW / 2 + tot / 2 - lw / 2;
        actionButton(label, ico, ax, by); leaveButton(lx, by);
      } else {
        ctx.globalAlpha = 0.75 + 0.25 * Math.sin(t * 3); text("Väntar på värden…", CW / 2, by - 8, uiFont(500, 16), C.soft, "center", "middle"); ctx.globalAlpha = 1;
        leaveButton(CW / 2, by + 30);
      }
    });
  }
  /** Lobby / waiting backdrop: a calm deep-water gradient with light shafts and rising bubbles. */
  function screenBackdrop() {
    const g = ctx.createLinearGradient(0, 0, 0, CH); g.addColorStop(0, "#14587a"); g.addColorStop(0.55, "#0b3a53"); g.addColorStop(1, "#06212f");
    ctx.fillStyle = g; ctx.fillRect(0, 0, CW, CH);
    ctx.save(); ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < 5; i++) {
      const x = CW * (0.12 + i * 0.2) + Math.sin(t * 0.3 + i) * 30, w = 50 + (i % 3) * 30;
      const s = ctx.createLinearGradient(0, 0, 0, CH * 0.9); s.addColorStop(0, "rgba(140,210,240,0.10)"); s.addColorStop(1, "rgba(140,210,240,0)");
      ctx.fillStyle = s; ctx.beginPath(); ctx.moveTo(x - w * 0.3, 0); ctx.lineTo(x + w * 0.3, 0); ctx.lineTo(x + w + 60, CH * 0.9); ctx.lineTo(x - w + 60, CH * 0.9); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
    ctx.strokeStyle = "rgba(200,235,255,0.28)"; ctx.lineWidth = 1.2;
    for (let i = 0; i < 18; i++) { const x = (i * 131) % CW + Math.sin(t + i) * 6, y = CH + 20 - ((t * (18 + (i % 4) * 9) + i * 97) % (CH + 40)), r = 2 + (i % 3) * 1.5; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke(); }
    const vg = ctx.createRadialGradient(CW / 2, CH / 2, CH * 0.3, CW / 2, CH / 2, CW * 0.7); vg.addColorStop(0, "rgba(0,0,0,0)"); vg.addColorStop(1, "rgba(0,8,16,0.45)");
    ctx.fillStyle = vg; ctx.fillRect(0, 0, CW, CH);
  }
  function drawNetLine() {
    if (mode === "solo") return;
    const s = netSummary(); if (!s) return;
    const bad = /blockera|kan inte/.test(s), f = uiFont(500, 12.5 * u), w = Math.min(CW - 140 * u, tw(s, f) + 26 * u), h = 24 * u, y = CH - 12 * u - h;
    Q = u; glass(CW / 2 - w / 2, y, w, h, h / 2, { alpha: 0.55, stroke: bad ? "rgba(255,138,106,0.5)" : undefined });
    text(fitText(s, f, w - 20 * u), CW / 2, y + h / 2 + 0.5, f, bad ? "#ff9a7e" : C.muted, "center", "middle");
  }
  function drawWait(msg) {
    screenBackdrop();
    scaled(360, 250, () => {
      const y = CH / 2 - 40;
      drawRing(CW / 2, y - 14 + Math.sin(t * 2) * 4, 46, null, true);
      text("Livbojen", CW / 2, y + 74, uiFont(700, 34), C.ink, "center");
      const dots = ".".repeat(1 + (Math.floor(t * 2.5) % 3));
      text(msg.replace(/…$/, ""), CW / 2, y + 106, uiFont(500, 18), C.soft, "center");
      if (/…$/.test(msg)) { const w = tw(msg.replace(/…$/, ""), uiFont(500, 18)); text(dots, CW / 2 + w / 2 + 1, y + 106, uiFont(500, 18), C.soft, "left"); }
    });
    drawNetLine(); drawMute();
  }
  function drawLobby(v) {
    screenBackdrop();
    const names = (v.players || []).map((p) => ({ name: p.id === L.selfId ? myName + " (du)" : (p.name || "Spelare"), hue: p.hue, you: p.id === L.selfId })).slice(0, 12);
    // name chips, wrapped into centred rows
    const cf = uiFont(600, 15), maxRow = 400, chips = names.map((n) => ({ ...n, w: Math.ceil(tw(n.name, cf)) + (n.hue != null ? 38 : 26) }));
    const lines = []; let cur = [], cw = 0;
    for (const c of chips) { if (cur.length && cw + 8 + c.w > maxRow) { lines.push(cur); cur = []; cw = 0; } cur.push(c); cw += (cur.length > 1 ? 8 : 0) + c.w; }
    if (cur.length) lines.push(cur);
    const TH = v.team ? TEAM_H : 0; // the team's name under the title
    const W = 460, H = 222 + TH + lines.length * 40, x0 = CW / 2 - W / 2, y0 = CH / 2 - H / 2 + 6;
    scaled(W, H + 20, () => {
      card(x0, y0, W, H);
      drawRing(CW / 2, y0 + 4 + Math.sin(t * 2) * 3, 36, null, true);
      text("Lobby", CW / 2, y0 + 82, uiFont(700, 30), C.ink, "center");
      if (TH) teamLine(v.team, CW / 2, y0 + 112, W - 60);
      let y = y0 + 128 + TH;
      if (L.authoritative) actionButton("Starta spelet", icon.play, CW / 2, y, false);
      else { ctx.globalAlpha = 0.75 + 0.25 * Math.sin(t * 3); text("Väntar på att värden startar…", CW / 2, y, uiFont(500, 17), C.soft, "center", "middle"); ctx.globalAlpha = 1; }
      y += 56;
      const hl = `${names.length} spelare i lobbyn`, hf = uiFont(700, 16), hw = tw(hl, hf);
      icon.person(CW / 2 - hw / 2 - 2, y - 5, 15, C.accentHi); text(hl, CW / 2 + 9, y, hf, C.accentHi, "center");
      y += 18;
      for (const ln of lines) {
        const total = ln.reduce((s, c) => s + c.w, 0) + 8 * (ln.length - 1); let x = CW / 2 - total / 2;
        for (const c of ln) {
          rr(x, y, c.w, 30, 15); ctx.fillStyle = c.you ? "rgba(244,87,29,0.22)" : "rgba(255,255,255,0.07)"; ctx.fill(); ctx.strokeStyle = c.you ? "rgba(255,138,76,0.55)" : "rgba(255,255,255,0.14)"; ctx.lineWidth = 1; ctx.stroke();
          let tx = x + 13;
          if (c.hue != null) { ctx.fillStyle = `hsl(${c.hue},85%,60%)`; ctx.beginPath(); ctx.arc(x + 16, y + 15, 5, 0, Math.PI * 2); ctx.fill(); tx = x + 27; }
          text(c.name, tx, y + 16, cf, c.you ? "#ffd7c7" : C.ink, "left", "middle");
          x += c.w + 8;
        }
        y += 40;
      }
    });
    drawNetLine(); drawMute();
  }

  // ---- entry points (render.js) ----------------------------------------------
  function begin() {
    L = live() || {};
    dk = ctx.getTransform ? ctx.getTransform().a : 1; Q = u; SK = 1; hoverAny = false;
    delete seeRects._team; delete seeRects._card;
  }
  function end() {
    const want = hoverAny ? "pointer" : "";
    if (want !== cursor) { cursor = want; canvas.style.cursor = want; }
  }
  /** occList: what is in the water, as boxes in canvas coords: { x, y, w, h, kind: "swimmer" | "monster" | "ring", gauge? } */
  function game(v, occList) {
    begin();
    if (v.phase !== anim.phase) { anim.phase = v.phase; anim.phaseT = 0; }
    const screen = v.phase === Phase.CLEARED || v.phase === Phase.OVER || v.phase === Phase.WIN;
    occ = screen ? [] : occList || []; under.clear(); for (const k in seeRects) delete seeRects[k];
    ctx.save();
    if (!screen) {
      if (v.phase === Phase.INTRO) { ctx.save(); ctx.globalAlpha = Math.min(1, anim.phaseT * 4); ctx.fillStyle = "rgba(3,16,26,0.34)"; ctx.fillRect(0, 0, CW, CH); ctx.restore(); } // dim the water, not the HUD
      drawTop(v); drawScoreboard(v); if (v.phase === Phase.INTRO) drawIntro(v); drawDash(v);
    }
    else if (v.phase === Phase.CLEARED) drawLevelBoard(v);
    else drawEndScreen(v, v.phase === Phase.WIN);
    drawQuit(v); drawMute(!screen); seeFs();
    // a swimmer under any HUD piece: its sink gauge again, above the HUD
    let gauges = 0;
    if (!screen && drawGauge) for (const o of under) if (o.gauge) { drawGauge(o.gauge); gauges++; }
    seeRects._gauges = gauges;
    ctx.restore();
    end();
  }

  return {
    DASH_BTN, MUTE_BTN, QUIT_BTN,
    actionBtn: () => ACTION_BTN, leaveBtn: () => LEAVE_BTN,
    /** Start of a frame: animation clock, nothing clickable until drawn, the layout for this canvas size. */
    beginFrame(dt) {
      t += dt; frameDt = Math.min(0.1, Math.max(0, dt)); ACTION_BTN = null; LEAVE_BTN = null; layout();
      anim.pop = Math.max(0, anim.pop - dt * 3); anim.flash = Math.max(0, anim.flash - dt * 1.4); anim.ping = Math.max(0, anim.ping - dt * 3); anim.phaseT += dt;
    },
    game,
    lobby(v) { begin(); occ = []; ctx.save(); drawLobby(v); ctx.restore(); seeFs(); end(); },
    wait(msg) { begin(); occ = []; ctx.save(); drawWait(msg); ctx.restore(); seeFs(); end(); },
    /** tests / debug(): each HUD piece's rect this frame and how see-through it is (+ _gauges: sink gauges redrawn above the HUD) */
    see: () => JSON.parse(JSON.stringify(seeRects)),
  };
}

// Livbojen — rendering: everything drawn on the canvas (water, shore, docks,
// swamps, whirlpools, swimmers, monsters, the livboj rings, HUD, overlays and
// the end / between-level screens), plus the HiDPI backing store.
//
// Draws a view (game.js currentView(): the sim's state for solo/host, the
// interpolated snapshot for a joiner); never changes game state.
//
// Sibling modules are imported with this module's own ?v=<build> (see boot.js):
// a plain `import … from "./sim.js"` would load a second, uncached copy.
const { SHORE_H, EAT_DWELL, shoreY, Phase, BASE_LEVELS, SKINS, HAIRS } = await import(`./sim.js${new URL(import.meta.url).search}`);
// the water (GPU layer under the canvas, or its 2D fallback): water.js
const { createWater, drawWater2D } = await import(`./water.js${new URL(import.meta.url).search}`);

const SUITS = ["#e5484d", "#3aa0ff", "#ffb020", "#8b5cf6", "#22c55e", "#ec4899"];
const GULLS = [{ y: 46, sp: 26, x0: 0, ph: 0 }, { y: 82, sp: 34, x0: 220, ph: 1.4 }, { y: 62, sp: 20, x0: 440, ph: 2.7 }];
// Lighten/darken a #rrggbb colour to an "rgb(...)" string for shading.
function shadeHex(hex, f) {
  const n = parseInt(hex.slice(1), 16), c = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${c((n >> 16) & 255)},${c((n >> 8) & 255)},${c(n & 255)})`;
}
const shade = (c) => shadeHex(c, 0.72);
const tint = (c) => shadeHex(c, 1.2);
const hi = (c) => shadeHex(c, 1.34);

/**
 * One renderer per game canvas. `ui` connects it to game.js:
 *   myName, mode, selfPos, netSummary()   fixed for the game
 *   view()                                 the view to draw this frame (called once per render)
 *   live()                                 { authoritative, selfId, usingTouch, muted, quitArmedUntil, levelStartScore, saved }
 */
export function createRenderer(canvas, ui) {
  const ctx = canvas.getContext("2d");
  const CW = canvas.width, CH = canvas.height;
  const { myName, mode, selfPos, netSummary } = ui;
  // what game.js owns, read fresh at the start of every render()
  let authoritative = false, selfId = null, usingTouch = false, muted = false, quitArmedUntil = 0, levelStartScore = new Map(), saved = [];
  let lowFx = false; // level-of-detail: lighten shading when the water is crowded
  const DASH_BTN = { x: CW - 66, y: CH - 66, r: 46 };
  const MUTE_BTN = { x: 28, y: CH - 28, r: 16 };
  const QUIT_BTN = { x: CW - 132, y: 44, w: 114, h: 24 }; // host-only "Avsluta spelet"
  // The host's "go on" prompt is a real button (mouse/touch) as well as Enter.
  let ACTION_BTN = null;
  function drawActionButton(label, cx, cy) {
    ctx.font = "800 20px system-ui, sans-serif";
    const w = Math.ceil(ctx.measureText(label).width) + 48, h = 44, x = cx - w / 2, y = cy - h / 2;
    ACTION_BTN = { x, y, w, h };
    ctx.save(); ctx.shadowColor = "rgba(244,87,29,0.45)"; ctx.shadowBlur = 18; ctx.fillStyle = "#f4571d";
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 14); ctx.fill(); ctx.restore();
    ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(label, cx, cy + 1); ctx.textBaseline = "alphabetic";
    ctx.font = "600 12px system-ui, sans-serif"; ctx.fillStyle = "#bfe0f2"; ctx.fillText(usingTouch ? "eller tryck var som helst" : "eller tryck Enter", cx, cy + h / 2 + 17);
  }
  // "Till startsidan" on the end screen, for everyone. Leaves the room and goes to the menu.
  let LEAVE_BTN = null;
  function drawLeaveButton(cx, cy) {
    ctx.font = "700 15px system-ui, sans-serif";
    const label = "Till startsidan";
    const w = Math.ceil(ctx.measureText(label).width) + 36, h = 36, x = cx - w / 2, y = cy - h / 2;
    LEAVE_BTN = { x, y, w, h };
    ctx.fillStyle = "rgba(255,255,255,0.12)"; ctx.beginPath(); ctx.roundRect(x, y, w, h, 12); ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.22)"; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = "#eaf6ff"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(label, cx, cy + 1); ctx.textBaseline = "alphabetic";
  }
  function drawNetLine() {
    if (mode === "solo") return;
    ctx.save(); ctx.textAlign = "center"; ctx.font = "600 12px system-ui, sans-serif";
    const s = netSummary(); ctx.fillStyle = /blockera|kan inte/.test(s) ? "#ff8a6a" : "#9fc4d6"; ctx.fillText(s, CW / 2, CH - 36); ctx.restore();
  }

  // ---- Rendering ----------------------------------------------------------
  let waveT = 0;
  const water = createWater(canvas, CW, CH);
  let glWater = false; // this frame's water came from the GPU layer: skip the 2D shadows/ripples/wakes it draws
  function fit(w, h) { const s = Math.min(CW / w, CH / h); return { s, ox: (CW - w * s) / 2, oy: (CH - h * s) / 2 }; }
  function toWorld(cx, cy, w, h) { const f = fit(w, h); return { x: (cx - f.ox) / f.s, y: (cy - f.oy) / f.s }; }
  function drawShore(w, h) {
    const y0 = shoreY({ w, h });
    const g = ctx.createLinearGradient(0, y0, 0, h);
    g.addColorStop(0, "#cdb583"); g.addColorStop(0.16, "#e7d4a4"); g.addColorStop(1, "#d6bd85");
    ctx.fillStyle = g; ctx.fillRect(0, y0, w, SHORE_H);
    // wet sand with a faint sky reflection
    const wet = ctx.createLinearGradient(0, y0, 0, y0 + 18);
    wet.addColorStop(0, "rgba(120,150,170,0.38)"); wet.addColorStop(1, "rgba(150,120,70,0)");
    ctx.fillStyle = wet; ctx.fillRect(0, y0, w, 18);
    // foam edge: two soft white bands breathing with the swell, plus bubbles
    const edge = (x) => y0 + Math.sin(x * 0.05 + waveT * 1.6) * 3 + Math.sin(x * 0.013 - waveT * 0.9) * 2;
    ctx.fillStyle = "rgba(255,255,255,0.75)"; ctx.beginPath();
    for (let x = 0; x <= w; x += 12) { const yy = edge(x); x === 0 ? ctx.moveTo(x, yy) : ctx.lineTo(x, yy); }
    ctx.lineTo(w, y0 - 7); ctx.lineTo(0, y0 - 7); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.32)"; ctx.beginPath();
    for (let x = 0; x <= w; x += 12) { const yy = edge(x) - 6 + Math.sin(x * 0.11 + waveT * 2) * 2; x === 0 ? ctx.moveTo(x, yy) : ctx.lineTo(x, yy); }
    ctx.lineTo(w, y0 - 17); ctx.lineTo(0, y0 - 17); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#ffffff";
    for (let i = 0; i < Math.round(w / 22); i++) {
      const bx = (i * 61) % w, by = y0 - 3 - ((i * 37) % 9), br = 1 + (i % 3) * 0.6;
      ctx.globalAlpha = 0.25 + 0.45 * Math.abs(Math.sin(waveT * 1.5 + i)); ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    // sand speckles
    ctx.fillStyle = "rgba(120,95,55,0.22)";
    for (let i = 0; i < 46; i++) { const sx = (i * 97) % w, sy = y0 + 12 + ((i * 53) % (SHORE_H - 14)); ctx.beginPath(); ctx.arc(sx, sy, 1, 0, Math.PI * 2); ctx.fill(); }
  }
  function drawSaved(sv) {
    const skin = SKINS[sv.sk % SKINS.length], hair = HAIRS[sv.hr % HAIRS.length], suit = SUITS[sv.sid % SUITS.length];
    if (sv.state === "swim") {
      const cy = sv.y + Math.sin(sv.ph) * 1.5;
      ctx.strokeStyle = "rgba(190,225,240,0.35)"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.ellipse(sv.x, cy + 5, 12, 5, 0, 0, Math.PI * 2); ctx.stroke();
      const wv = Math.sin(sv.ph * 1.4) * 3;
      ctx.strokeStyle = skin; ctx.lineWidth = 3; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(sv.x - 5, cy); ctx.lineTo(sv.x - 10, cy - 5 + wv); ctx.moveTo(sv.x + 5, cy); ctx.lineTo(sv.x + 10, cy - 5 - wv); ctx.stroke(); ctx.lineCap = "butt";
      shadedBall(sv.x, cy, 8, skin);
      ctx.fillStyle = hair; ctx.beginPath(); ctx.arc(sv.x, cy - 1, 8, Math.PI, Math.PI * 2); ctx.fill();
    } else {
      const jump = Math.abs(Math.sin(sv.cheer * 6)) * 6, bx = sv.x, by = sv.y - jump;
      ctx.fillStyle = "rgba(0,0,0,0.15)"; ctx.beginPath(); ctx.ellipse(sv.x, sv.y + 11, 9, 3, 0, 0, Math.PI * 2); ctx.fill();
      if (lowFx) { ctx.fillStyle = suit; } else { const tg = ctx.createLinearGradient(bx, by - 1, bx, by + 11); tg.addColorStop(0, hi(suit)); tg.addColorStop(1, shade(suit)); ctx.fillStyle = tg; }
      ctx.beginPath(); ctx.roundRect ? ctx.roundRect(bx - 5, by - 1, 10, 12, 3) : ctx.rect(bx - 5, by - 1, 10, 12); ctx.fill();
      ctx.strokeStyle = skin; ctx.lineWidth = 3; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(bx - 3, by + 11); ctx.lineTo(bx - 3, by + 18); ctx.moveTo(bx + 3, by + 11); ctx.lineTo(bx + 3, by + 18); ctx.stroke();
      const raise = 2 + Math.sin(sv.cheer * 6) * 2;
      ctx.beginPath(); ctx.moveTo(bx - 4, by + 1); ctx.lineTo(bx - 10, by - 8 - raise); ctx.moveTo(bx + 4, by + 1); ctx.lineTo(bx + 10, by - 8 - raise); ctx.stroke(); ctx.lineCap = "butt";
      shadedBall(bx, by - 8, 6, skin);
      ctx.fillStyle = hair; ctx.beginPath(); ctx.arc(bx, by - 9, 6, Math.PI, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#3a2a1c"; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(bx, by - 7, 2.4, 0.12 * Math.PI, 0.88 * Math.PI); ctx.stroke();
    }
  }
  function drawScenery(w, h) {
    const gy = shoreY({ w, h });
    drawTower(w * 0.15, gy);
    drawUmbrella(w * 0.85, gy);
    drawStarfish(w * 0.63, gy + 52);
    drawBeachBall(w * 0.5, gy + 50);
  }
  function drawTower(bx, gy) {
    const cabW = 42, cabH = 30, legH = 26, baseY = gy + 42, cy = baseY - legH - cabH;
    // legs + cross braces
    ctx.strokeStyle = "#8a5a2b"; ctx.lineWidth = 4; ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(bx - cabW * 0.42, baseY); ctx.lineTo(bx - cabW * 0.3, baseY - legH);
    ctx.moveTo(bx + cabW * 0.42, baseY); ctx.lineTo(bx + cabW * 0.3, baseY - legH);
    ctx.moveTo(bx - cabW * 0.4, baseY - legH * 0.5); ctx.lineTo(bx + cabW * 0.4, baseY - legH * 0.5);
    ctx.stroke(); ctx.lineCap = "butt";
    // cabin (with a soft warm outline)
    ctx.fillStyle = "#cf934f"; ctx.fillRect(bx - cabW / 2, cy, cabW, cabH);
    ctx.strokeStyle = "rgba(45,26,10,0.42)"; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.strokeRect(bx - cabW / 2, cy, cabW, cabH);
    ctx.fillStyle = "#0e3b52"; ctx.fillRect(bx - cabW * 0.32, cy + 5, cabW * 0.64, cabH * 0.4);
    ctx.fillStyle = "#a86a34"; ctx.fillRect(bx - cabW / 2, cy + cabH * 0.52, cabW, 3);
    // red-cross panel
    ctx.fillStyle = "#e5484d"; ctx.fillRect(bx - 7, cy + cabH * 0.6, 14, 10);
    ctx.fillStyle = "#fff"; ctx.fillRect(bx - 1.5, cy + cabH * 0.6 + 2, 3, 6); ctx.fillRect(bx - 5, cy + cabH * 0.6 + 3.5, 10, 3);
    // roof
    ctx.fillStyle = "#e5484d"; ctx.beginPath(); ctx.moveTo(bx - cabW * 0.62, cy); ctx.lineTo(bx, cy - 16); ctx.lineTo(bx + cabW * 0.62, cy); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "rgba(45,26,10,0.42)"; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.stroke();
    // flag
    ctx.strokeStyle = "#7a4f2a"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(bx + cabW * 0.5, cy - 16); ctx.lineTo(bx + cabW * 0.5, cy - 42); ctx.stroke();
    ctx.fillStyle = "#ffb020"; const fl = Math.sin(waveT * 4) * 3;
    ctx.beginPath(); ctx.moveTo(bx + cabW * 0.5, cy - 42); ctx.lineTo(bx + cabW * 0.5 + 16, cy - 38 + fl); ctx.lineTo(bx + cabW * 0.5, cy - 33); ctx.closePath(); ctx.fill();
  }
  function drawUmbrella(bx, gy) {
    const baseY = gy + 48, topY = baseY - 42, R = 28;
    ctx.fillStyle = "rgba(0,0,0,0.12)"; ctx.beginPath(); ctx.ellipse(bx, baseY, 14, 4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#7a4f2a"; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(bx, baseY); ctx.lineTo(bx, topY); ctx.stroke();
    const cols = ["#e5484d", "#f4f4f0"];
    for (let k = 0; k < 6; k++) { ctx.fillStyle = cols[k % 2]; ctx.beginPath(); ctx.moveTo(bx, topY); ctx.arc(bx, topY, R, Math.PI + k * Math.PI / 6, Math.PI + (k + 1) * Math.PI / 6); ctx.closePath(); ctx.fill(); }
    ctx.fillStyle = "#c93a3e"; for (let k = 0; k < 6; k++) { const a = Math.PI + (k + 0.5) * Math.PI / 6; ctx.beginPath(); ctx.arc(bx + Math.cos(a) * R, topY + Math.sin(a) * R, 3, 0, Math.PI * 2); ctx.fill(); }
    // canopy outline
    ctx.strokeStyle = "rgba(45,26,10,0.42)"; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.beginPath(); ctx.arc(bx, topY, R, Math.PI, Math.PI * 2); ctx.closePath(); ctx.stroke();
    ctx.fillStyle = "#7a4f2a"; ctx.beginPath(); ctx.arc(bx, topY - 2, 2.6, 0, Math.PI * 2); ctx.fill();
  }
  function drawBeachBall(bx, by) {
    ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(bx, by, 8, 0, Math.PI * 2); ctx.fill();
    const cols = ["#e5484d", "#3aa0ff", "#ffb020"];
    for (let k = 0; k < 3; k++) { ctx.fillStyle = cols[k]; ctx.beginPath(); ctx.moveTo(bx, by); ctx.arc(bx, by, 8, k * 2 * Math.PI / 3, (k * 2 / 3 + 0.24) * Math.PI); ctx.closePath(); ctx.fill(); }
    ctx.strokeStyle = "rgba(45,26,10,0.42)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(bx, by, 8, 0, Math.PI * 2); ctx.stroke();
  }
  function drawStarfish(bx, by) {
    ctx.save(); ctx.translate(bx, by); ctx.fillStyle = "#f2884b"; ctx.beginPath();
    for (let k = 0; k < 5; k++) { const a = -Math.PI / 2 + k * 2 * Math.PI / 5; ctx.lineTo(Math.cos(a) * 7, Math.sin(a) * 7); const a2 = a + Math.PI / 5; ctx.lineTo(Math.cos(a2) * 3, Math.sin(a2) * 3); }
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "rgba(45,26,10,0.42)"; ctx.lineWidth = 1.6; ctx.lineJoin = "round"; ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.35)"; ctx.beginPath(); ctx.arc(0, 0, 2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  function drawSeagulls(w, t) {
    ctx.strokeStyle = "rgba(240,246,252,0.85)"; ctx.lineCap = "round";
    for (let i = 0; i < GULLS.length; i++) {
      const g = GULLS[i], x = ((t * g.sp + g.x0) % (w + 100)) - 50, y = g.y + Math.sin(t * 0.8 + i) * 6, wing = 5 + (Math.sin(t * 8 + g.ph) + 1) / 2 * 4;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x - 9, y); ctx.quadraticCurveTo(x - 3, y - wing, x, y); ctx.quadraticCurveTo(x + 3, y - wing, x + 9, y); ctx.stroke();
      ctx.fillStyle = "rgba(240,246,252,0.85)"; ctx.beginPath(); ctx.arc(x, y, 1.6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.lineCap = "butt";
  }
  function drawSwamp(z) {
    // an organic blob (three sine harmonics on an ellipse), feathered edge, murk thickening inward
    const cx = z.x + z.w / 2, cy = z.y + z.h / 2, rx = z.w / 2, ry = z.h / 2, seed = z.x * 0.03 + z.y * 0.07;
    const rad = (a) => 1 + 0.07 * Math.sin(a * 3 + seed) + 0.05 * Math.sin(a * 5 + seed * 1.3) + 0.03 * Math.sin(a * 8 - seed);
    const blob = (k) => { ctx.beginPath(); for (let i = 0; i <= 64; i++) { const a = i / 64 * Math.PI * 2, f = rad(a) * k; const x = cx + Math.cos(a) * rx * f, y = cy + Math.sin(a) * ry * f; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.closePath(); };
    for (let k = 3; k >= 1; k--) { blob(1 + k * 0.045); ctx.fillStyle = "rgba(70,95,40,0.07)"; ctx.fill(); }
    const g = ctx.createRadialGradient(cx, cy, Math.min(rx, ry) * 0.2, cx, cy, Math.max(rx, ry));
    g.addColorStop(0, "rgba(45,70,30,0.62)"); g.addColorStop(0.7, "rgba(60,90,40,0.45)"); g.addColorStop(1, "rgba(70,95,40,0.28)");
    blob(1); ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = "rgba(120,150,70,0.22)"; ctx.lineWidth = 2; ctx.stroke();
    // scum streaks drifting on the surface
    ctx.strokeStyle = "rgba(150,170,90,0.18)"; ctx.lineWidth = 3; ctx.lineCap = "round";
    for (let i = 0; i < 5; i++) { const a = seed + i * 1.3, px = cx + Math.cos(a) * rx * 0.5, py = cy + Math.sin(a) * ry * 0.5 + Math.sin(waveT * 0.5 + i) * 3; ctx.beginPath(); ctx.moveTo(px - 18, py); ctx.quadraticCurveTo(px, py - 4, px + 18, py + 2); ctx.stroke(); }
    // lily pads (bobbing) inside the blob, a few with a flower
    for (let i = 0; i < 8; i++) {
      const a = seed * 0.7 + i * 2.4, f = 0.25 + ((i * 37) % 60) / 100, px = cx + Math.cos(a) * rx * f, py = cy + Math.sin(a) * ry * f, r = 7 + (i % 3) * 2, wob = Math.sin(waveT * 1.2 + i) * 1.5;
      ctx.fillStyle = "rgba(90,150,70,0.92)"; ctx.beginPath(); ctx.moveTo(px, py + wob); ctx.arc(px, py + wob, r, 0.35 + i, Math.PI * 2 - 0.35 + i); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = "rgba(60,110,50,0.5)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(px, py + wob); ctx.lineTo(px + Math.cos(i) * r * 0.8, py + wob + Math.sin(i) * r * 0.8); ctx.stroke();
      ctx.fillStyle = "rgba(160,200,120,0.5)"; ctx.beginPath(); ctx.arc(px - r * 0.3, py + wob - r * 0.3, r * 0.35, 0, Math.PI * 2); ctx.fill();
      if (i % 4 === 0) { ctx.fillStyle = "rgba(255,190,220,0.9)"; ctx.beginPath(); ctx.arc(px + r * 0.4, py + wob - r * 0.5, 2.4, 0, Math.PI * 2); ctx.fill(); }
    }
    // reeds around the rim, swaying; every third one a cattail
    for (let i = 0; i < 14; i++) {
      const a = seed + i * 0.45 + (i % 2) * 0.2, f = rad(a) * (0.86 + (i % 3) * 0.05), rx0 = cx + Math.cos(a) * rx * f, ry0 = cy + Math.sin(a) * ry * f, hgt = 18 + (i % 4) * 7, sway = Math.sin(waveT * 1.6 + i) * 3;
      ctx.strokeStyle = i % 3 ? "rgba(60,95,35,0.85)" : "rgba(95,120,45,0.85)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(rx0, ry0); ctx.quadraticCurveTo(rx0 + sway, ry0 - hgt * 0.6, rx0 + sway * 1.6, ry0 - hgt); ctx.stroke();
      if (i % 3 === 0) { ctx.fillStyle = "#6b4a2a"; ctx.beginPath(); ctx.ellipse(rx0 + sway * 1.6, ry0 - hgt, 1.8, 4, 0, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.lineCap = "butt";
  }
  function drawBrygga(o) {
    const horiz = o.w >= o.h, L = horiz ? o.w : o.h, T = horiz ? o.h : o.w; // along / across
    const seed = Math.round(o.x * 7 + o.y * 13);
    const rnd = (i) => { const v = Math.sin(seed + i * 12.9898) * 43758.5453; return v - Math.floor(v); };
    // pilings: round posts along both long edges, standing in the water
    const nPost = Math.max(2, Math.round(L / 110)), pr = T * 0.22;
    const posts = [];
    for (let i = 0; i < nPost; i++) { const a = (i + 0.5) / nPost; for (const side of [-1, 1]) posts.push(horiz ? [o.x + a * L, o.y + o.h / 2 + side * (T / 2 + pr * 0.35)] : [o.x + o.w / 2 + side * (T / 2 + pr * 0.35), o.y + a * L]); }
    // shadow on the water (away from the light), warm reflection, foam lapping at the edge
    // (the GPU water draws these itself)
    if (!glWater) {
      ctx.fillStyle = "rgba(0,10,20,0.30)"; ctx.beginPath(); ctx.roundRect(o.x + 6, o.y + 10, o.w, o.h, 3); ctx.fill();
      ctx.fillStyle = "rgba(90,60,30,0.12)"; ctx.beginPath(); ctx.roundRect(o.x - 6, o.y - 6, o.w + 12, o.h + 12, 8); ctx.fill();
      // short pieces of foam along the edges that come and go
      ctx.strokeStyle = "#eef8ff"; ctx.lineWidth = 1.8; ctx.lineCap = "round";
      const per = 2 * (o.w + o.h), n = Math.round(per / 15);
      for (let i = 0; i < n; i++) {
        const life = 0.5 + 0.5 * Math.sin(waveT * (0.8 + rnd(i + 300)) + i * 2.1);
        if (life < 0.35) continue;
        const s = (i + rnd(i + 400) * 0.6) / n * per, len = 5 + rnd(i + 500) * 9, off = 1.5 + rnd(i + 600) * 2.5;
        let x0, y0, dx = 0, dy = 0;
        if (s < o.w) { x0 = o.x + s; y0 = o.y - off; dx = 1; }
        else if (s < o.w + o.h) { x0 = o.x + o.w + off; y0 = o.y + s - o.w; dy = 1; }
        else if (s < 2 * o.w + o.h) { x0 = o.x + o.w - (s - o.w - o.h); y0 = o.y + o.h + off; dx = -1; }
        else { x0 = o.x - off; y0 = o.y + o.h - (s - 2 * o.w - o.h); dy = -1; }
        ctx.globalAlpha = Math.min(1, (life - 0.35) * 1.6) * 0.65;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 + dx * len, y0 + dy * len); ctx.stroke();
      }
      ctx.globalAlpha = 1; ctx.lineCap = "butt";
    }
    // pilings: shadow, a churning foam collar and a ripple spreading from each
    for (let i = 0; i < posts.length; i++) {
      const [px, py] = posts[i], rp = (waveT * 0.5 + i * 0.37) % 1;
      ctx.fillStyle = "rgba(0,10,20,0.28)"; ctx.beginPath(); ctx.ellipse(px + pr * 0.45, py + pr * 0.6, pr * 1.25, pr * 1.0, 0, 0, Math.PI * 2); ctx.fill();
      if (!lowFx) { ctx.strokeStyle = `rgba(225,244,252,${0.4 * (1 - rp)})`; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(px, py, pr * (1.3 + rp * 1.4), 0, Math.PI * 2); ctx.stroke(); }
      ctx.strokeStyle = "rgba(240,250,255,0.7)"; ctx.lineWidth = 1.8; ctx.setLineDash([pr * 0.9, pr * 0.45]); ctx.lineDashOffset = -waveT * 6 - i * 3;
      ctx.beginPath(); ctx.arc(px, py, pr * 1.18, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = "#3d2612"; ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.fill();
    }
    // deck: planks laid across the dock — mixed wood tones and grey weathered boards, the odd one missing or cracked
    const PALETTE = ["#a8713d", "#b07a44", "#9a6635", "#a46b38", "#8d7a62", "#7f7468"];
    const nn = Math.max(3, Math.round(L / 18)), pw = L / nn, ins = 0.6;
    const rect = (s0) => horiz ? [o.x + s0 + ins, o.y, pw - ins * 2, o.h] : [o.x, o.y + s0 + ins, o.w, pw - ins * 2];
    for (let i = 0; i < nn; i++) {
      const s0 = pw * i, r1 = rnd(i), r2 = rnd(i + 31), r3 = rnd(i + 71);
      if (r3 > 0.93 && i > 0 && i < nn - 1) { // missing plank: dark water and two broken stubs
        ctx.fillStyle = "rgba(6,28,44,0.78)"; ctx.fillRect(...rect(s0));
        const stub = T * (0.16 + rnd(i + 5) * 0.14), col = shade(PALETTE[Math.floor(r1 * PALETTE.length)]);
        ctx.fillStyle = col;
        ctx.beginPath();
        if (horiz) { const x0 = o.x + s0 + ins, x1 = x0 + pw - ins * 2; ctx.moveTo(x0, o.y); ctx.lineTo(x1, o.y); ctx.lineTo(x1, o.y + stub * 0.7); ctx.lineTo((x0 + x1) / 2, o.y + stub * 1.3); ctx.lineTo(x0, o.y + stub * 0.9); ctx.closePath(); ctx.fill();
          ctx.beginPath(); ctx.moveTo(x0, o.y + o.h); ctx.lineTo(x1, o.y + o.h); ctx.lineTo(x1, o.y + o.h - stub * 1.1); ctx.lineTo((x0 + x1) / 2, o.y + o.h - stub * 0.6); ctx.lineTo(x0, o.y + o.h - stub); ctx.closePath(); ctx.fill(); }
        else { const y0 = o.y + s0 + ins, y1 = y0 + pw - ins * 2; ctx.moveTo(o.x, y0); ctx.lineTo(o.x, y1); ctx.lineTo(o.x + stub * 0.7, y1); ctx.lineTo(o.x + stub * 1.3, (y0 + y1) / 2); ctx.lineTo(o.x + stub * 0.9, y0); ctx.closePath(); ctx.fill();
          ctx.beginPath(); ctx.moveTo(o.x + o.w, y0); ctx.lineTo(o.x + o.w, y1); ctx.lineTo(o.x + o.w - stub * 1.1, y1); ctx.lineTo(o.x + o.w - stub * 0.6, (y0 + y1) / 2); ctx.lineTo(o.x + o.w - stub, y0); ctx.closePath(); ctx.fill(); }
        continue;
      }
      const base = tint(PALETTE[Math.floor(r1 * PALETTE.length)], 0.9 + r2 * 0.2);
      const g = horiz ? ctx.createLinearGradient(0, o.y, 0, o.y + o.h) : ctx.createLinearGradient(o.x, 0, o.x + o.w, 0);
      g.addColorStop(0, hi(base)); g.addColorStop(0.45, base); g.addColorStop(1, shade(base));
      ctx.fillStyle = g; ctx.fillRect(...rect(s0));
      // grain: two faint lines along the plank
      ctx.strokeStyle = "rgba(60,35,15,0.22)"; ctx.lineWidth = 1;
      for (let k = 0; k < 2; k++) { const f = 0.3 + k * 0.4 + (rnd(i + 7 * k) - 0.5) * 0.15; ctx.beginPath(); if (horiz) { const x = o.x + s0 + pw * f; ctx.moveTo(x, o.y + 2); ctx.lineTo(x + (rnd(i + k) - 0.5) * 2, o.y + o.h - 2); } else { const y = o.y + s0 + pw * f; ctx.moveTo(o.x + 2, y); ctx.lineTo(o.x + o.w - 2, y + (rnd(i + k) - 0.5) * 2); } ctx.stroke(); }
      // a knot on some planks, a crack on others
      if (rnd(i + 13) > 0.8) { const kx = horiz ? o.x + s0 + pw / 2 : o.x + o.w * (0.3 + r2 * 0.4), ky = horiz ? o.y + o.h * (0.3 + r2 * 0.4) : o.y + s0 + pw / 2; ctx.fillStyle = "rgba(60,35,15,0.5)"; ctx.beginPath(); ctx.ellipse(kx, ky, 2.2, 1.5, 0, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = "rgba(60,35,15,0.35)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.ellipse(kx, ky, 3.6, 2.6, 0, 0, Math.PI * 2); ctx.stroke(); }
      if (rnd(i + 43) > 0.86) { ctx.strokeStyle = "rgba(20,12,5,0.7)"; ctx.lineWidth = 1; ctx.beginPath(); if (horiz) { const x = o.x + s0 + pw * 0.5; ctx.moveTo(x - 1, o.y + o.h * 0.15); ctx.lineTo(x + 1.5, o.y + o.h * 0.5); ctx.lineTo(x - 0.5, o.y + o.h * 0.9); } else { const y = o.y + s0 + pw * 0.5; ctx.moveTo(o.x + o.w * 0.15, y - 1); ctx.lineTo(o.x + o.w * 0.5, y + 1.5); ctx.lineTo(o.x + o.w * 0.9, y - 0.5); } ctx.stroke(); }
      // nails at both ends (one occasionally missing)
      ctx.fillStyle = "rgba(40,30,25,0.7)";
      for (const e of [0.18, 0.82]) { if (rnd(i + 200 + e * 10) > 0.9) continue; const cx = horiz ? o.x + s0 + pw / 2 : o.x + o.w * e, cy = horiz ? o.y + o.h * e : o.y + s0 + pw / 2; ctx.beginPath(); ctx.arc(cx, cy, 1.1, 0, Math.PI * 2); ctx.fill(); }
    }
    // gaps between planks (water shows through)
    ctx.strokeStyle = "rgba(10,25,35,0.55)"; ctx.lineWidth = 1.2;
    for (let i = 1; i < nn; i++) { ctx.beginPath(); if (horiz) { const x = o.x + pw * i; ctx.moveTo(x, o.y); ctx.lineTo(x, o.y + o.h); } else { const y = o.y + pw * i; ctx.moveTo(o.x, y); ctx.lineTo(o.x + o.w, y); } ctx.stroke(); }
    // moss along the shaded edge, lit near edge, dark far edge
    ctx.fillStyle = "rgba(70,110,60,0.3)"; if (horiz) ctx.fillRect(o.x, o.y + o.h - 6, o.w, 6); else ctx.fillRect(o.x + o.w - 6, o.y, 6, o.h);
    ctx.fillStyle = "rgba(255,225,185,0.45)"; ctx.fillRect(o.x, o.y, horiz ? o.w : 2.5, horiz ? 2.5 : o.h);
    ctx.fillStyle = "rgba(20,10,4,0.5)"; if (horiz) ctx.fillRect(o.x, o.y + o.h - 3, o.w, 3); else ctx.fillRect(o.x + o.w - 3, o.y, 3, o.h);
    // post tops above the deck, with a highlight
    for (const [px, py] of posts) {
      ctx.fillStyle = "#5a3a1c"; ctx.beginPath(); ctx.arc(px, py - 2, pr, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#7d5330"; ctx.beginPath(); ctx.arc(px, py - 2, pr * 0.72, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(255,225,185,0.35)"; ctx.beginPath(); ctx.arc(px - pr * 0.25, py - 2 - pr * 0.25, pr * 0.3, 0, Math.PI * 2); ctx.fill();
    }
    // a mooring rope slung between the posts on the far side
    if (!lowFx && posts.length >= 4) {
      ctx.strokeStyle = "rgba(230,215,180,0.7)"; ctx.lineWidth = 1.4; ctx.lineCap = "round";
      const far = posts.filter((_, i) => i % 2 === 1);
      ctx.beginPath(); ctx.moveTo(far[0][0], far[0][1] - 2);
      for (let i = 1; i < far.length; i++) { const [ax, ay] = far[i - 1], [bx, by] = far[i]; ctx.quadraticCurveTo((ax + bx) / 2 + (horiz ? 0 : 6), (ay + by) / 2 + (horiz ? 6 : 0), bx, by - 2); }
      ctx.stroke(); ctx.lineCap = "butt";
    }
  }
  // 2D fallback of the GPU whirlpool: a dark funnel, tapered foam arms turning
  // the way the sim pulls (counter-clockwise on screen), a churning rim, a black core.
  function drawWhirl(z) {
    const t = waveT, R = z.r;
    ctx.save(); ctx.translate(z.x, z.y);
    const g = ctx.createRadialGradient(0, 0, R * 0.05, 0, 0, R * 1.08);
    g.addColorStop(0, "rgba(2,10,18,0.95)"); g.addColorStop(0.16, "rgba(4,22,40,0.86)"); g.addColorStop(0.45, "rgba(6,38,62,0.55)"); g.addColorStop(0.8, "rgba(12,62,92,0.2)"); g.addColorStop(1, "rgba(20,80,110,0)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, R * 1.08, 0, Math.PI * 2); ctx.fill();
    // arms: angle = a0 + 1.75 ln(d/R) - 1.5 t (the shader's spiral), width tapering inward
    const arms = lowFx ? 2 : 4, N = 28;
    for (let a = 0; a < arms; a++) {
      const a0 = a * Math.PI * 2 / arms - 1.5 * t, side = [];
      for (let k = 0; k <= N; k++) {
        const d = R * (0.95 - 0.77 * k / N), ang = a0 + 1.75 * Math.log(d / R), hw = (0.4 + 2.9 * (d - R * 0.15) / (R * 0.8)) / d;
        side.push([d, ang, hw]);
      }
      ctx.beginPath();
      side.forEach(([d, ang, hw], i) => { const x = Math.cos(ang + hw) * d, y = Math.sin(ang + hw) * d; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      for (let i = side.length - 1; i >= 0; i--) { const [d, ang, hw] = side[i]; ctx.lineTo(Math.cos(ang - hw) * d, Math.sin(ang - hw) * d); }
      ctx.closePath(); ctx.fillStyle = "rgba(235,247,255,0.72)"; ctx.fill();
      ctx.strokeStyle = "rgba(235,247,255,0.18)"; ctx.lineWidth = 5; ctx.lineJoin = "round"; ctx.stroke();
    }
    // churning rim, black core with a lit lip on the light side
    ctx.setLineDash([16, 12, 6, 18]); ctx.lineDashOffset = t * 30; ctx.strokeStyle = "rgba(240,250,255,0.6)"; ctx.lineWidth = 2.6;
    ctx.beginPath(); ctx.arc(0, 0, R * 0.97, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = "#020b14"; ctx.beginPath(); ctx.arc(0, 0, R * 0.15, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(195,230,248,0.75)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, R * 0.17, Math.PI * 0.95, Math.PI * 1.75); ctx.stroke();
    if (!lowFx) { ctx.fillStyle = "rgba(230,245,255,0.75)"; for (let i = 0; i < 6; i++) { const ang = -t * 1.5 + i * 1.05; ctx.beginPath(); ctx.arc(Math.cos(ang) * R * 1.02, Math.sin(ang) * R * 1.02, 1.6, 0, Math.PI * 2); ctx.fill(); } }
    ctx.restore(); ctx.lineCap = "butt";
  }
  // One light for the whole scene: warm sun from the top left, a cool fall-off toward the bottom right.
  function drawLightGrade(w, h) {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, "rgba(255,226,170,0.08)"); g.addColorStop(0.42, "rgba(255,226,170,0)"); g.addColorStop(0.68, "rgba(8,28,58,0)"); g.addColorStop(1, "rgba(8,28,58,0.12)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  }
  function drawLivboj(x, y, r, hue, glow, label, you, stunned) {
    const bob = Math.sin(waveT * 2.1 + x * 0.03) * 1.5, tilt = 1 - 0.03 * (0.5 + 0.5 * Math.sin(waveT * 1.4 + y * 0.02));
    ctx.save(); ctx.translate(x, y);
    // water contact: soft shadow away from the light, foam hugging the tube, ripples
    // (the GPU water draws these itself, with a wake)
    if (!glWater) {
      ctx.fillStyle = "rgba(3,20,36,0.3)"; ctx.beginPath(); ctx.ellipse(r * 0.16, r * 0.26 + bob, r * 1.06, r * 0.98, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "rgba(235,248,255,0.55)"; ctx.lineWidth = 2.2; ctx.setLineDash([r * 0.55, r * 0.2, r * 0.25, r * 0.3]); ctx.lineDashOffset = -waveT * 10 - x * 0.1;
      ctx.beginPath(); ctx.ellipse(0, bob, r * 1.05, r * 1.02, 0, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      if (!lowFx) {
        const rip = (waveT * 0.9 + x * 0.01) % 1;
        for (let k = 0; k < 2; k++) {
          const f = (rip + k * 0.5) % 1;
          ctx.strokeStyle = `rgba(215,240,255,${(1 - f) * (glow ? 0.5 : 0.3)})`; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.ellipse(0, bob, r * (1.12 + f * 0.8), r * (1.08 + f * 0.75), 0, 0, Math.PI * 2); ctx.stroke();
        }
      }
    }
    ctx.translate(0, bob); ctx.scale(1, tilt);
    if (stunned) ctx.globalAlpha = 0.6 + 0.25 * Math.sin(waveT * 20);
    // player colour: a soft glowing ring outside the rope
    if (hue != null) { ctx.save(); ctx.shadowColor = `hsla(${hue},90%,65%,0.9)`; ctx.shadowBlur = 14; ctx.strokeStyle = `hsla(${hue},85%,62%,0.85)`; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(0, 0, r + 8, 0, Math.PI * 2); ctx.stroke(); ctx.restore(); }
    const donut = () => { ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.arc(0, 0, r * 0.55, 0, Math.PI * 2, true); };
    // Today's Trygg-Hansa look: a clean orange torus with four white bands, no rope.
    if (glow) { ctx.shadowColor = "rgba(255,255,255,0.9)"; ctx.shadowBlur = 22; }
    // body: orange tube with four warm-white bands
    donut(); ctx.fillStyle = "#ef5a1f"; ctx.fill("evenodd"); ctx.shadowBlur = 0;
    ctx.fillStyle = "#f7f3e8";
    for (let i = 0; i < 4; i++) { ctx.save(); ctx.rotate(i * Math.PI / 2 + Math.PI / 4); ctx.beginPath(); ctx.arc(0, 0, r, -0.32, 0.32); ctx.arc(0, 0, r * 0.55, 0.32, -0.32, true); ctx.closePath(); ctx.fill(); ctx.restore(); }
    // tube shading: light from the top-left across the torus cross-section (dark inner lip, lit crest, dark outer edge)
    const lx = -r * 0.16, ly = -r * 0.18;
    const tube = ctx.createRadialGradient(lx, ly, r * 0.5, lx, ly, r * 1.08);
    tube.addColorStop(0, "rgba(0,0,0,0.42)"); tube.addColorStop(0.16, "rgba(0,0,0,0.08)"); tube.addColorStop(0.38, "rgba(255,255,255,0.30)");
    tube.addColorStop(0.62, "rgba(255,255,255,0.02)"); tube.addColorStop(0.86, "rgba(0,0,0,0.22)"); tube.addColorStop(1, "rgba(0,0,0,0.45)");
    donut(); ctx.fillStyle = tube; ctx.fill("evenodd");
    const dir = ctx.createLinearGradient(-r, -r, r, r);
    dir.addColorStop(0, "rgba(255,255,255,0.16)"); dir.addColorStop(0.5, "rgba(255,255,255,0)"); dir.addColorStop(1, "rgba(0,0,0,0.28)");
    donut(); ctx.fillStyle = dir; ctx.fill("evenodd");
    // edges, specular hot spot on the crest, cool water reflection on the far rim
    ctx.strokeStyle = "rgba(40,15,0,0.45)"; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "rgba(40,15,0,0.55)"; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(0, 0, r * 0.55, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.55)"; ctx.beginPath(); ctx.ellipse(-r * 0.5, -r * 0.5, r * 0.17, r * 0.08, -Math.PI / 4, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(150,215,245,0.45)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, r * 0.94, Math.PI * 0.12, Math.PI * 0.42); ctx.stroke();
    if (label) { ctx.font = "700 14px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.shadowColor = "rgba(0,0,0,0.6)"; ctx.shadowBlur = 4; ctx.fillStyle = you ? "#ffd7c7" : "#eaf6ff"; ctx.fillText(you ? "Du" : label, 0, -r - 12); ctx.shadowBlur = 0; }
    ctx.globalAlpha = 1;
    if (stunned) { ctx.fillStyle = "#fdd23a"; ctx.font = "14px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; for (let i = 0; i < 3; i++) { const a = waveT * 4 + i * (Math.PI * 2 / 3); ctx.fillText("★", Math.cos(a) * r * 0.85, -r * 0.95 + Math.sin(a) * r * 0.22); } ctx.textBaseline = "alphabetic"; }
    ctx.restore();
  }
  function drawHairTop(style, R, hair) {
    // hairline at -0.45R, crown around -0.9R; the shape is a cap closed by a style-specific fringe
    const top = -R * 0.92, side = R * 0.74, line = -R * 0.45;
    ctx.fillStyle = hair; ctx.beginPath();
    ctx.moveTo(-side, line);
    ctx.bezierCurveTo(-side * 1.05, top, side * 1.05, top, side, line);
    if (style === 0) { ctx.quadraticCurveTo(R * 0.5, -R * 0.62, R * 0.05, -R * 0.5); ctx.quadraticCurveTo(-R * 0.35, -R * 0.36, -side, line); } // side-swept fringe
    else if (style === 2) { ctx.lineTo(side, line + R * 0.08); ctx.lineTo(-side, line + R * 0.08); } // straight bangs
    else if (style === 3) { ctx.lineTo(-side, line); } // spiky: spikes added below
    else { ctx.quadraticCurveTo(0, -R * 0.58, -side, line); } // rounded fringe
    ctx.closePath(); ctx.fill();
    if (style === 1) shadedBall(0, -R * 0.88, R * 0.3, hair); // bun
    if (style === 3) { ctx.fillStyle = hair; for (let k = -2; k <= 2; k++) { const a = k * R * 0.3; ctx.beginPath(); ctx.moveTo(a - R * 0.16, -R * 0.7); ctx.lineTo(a + k * R * 0.06, -R * 1.12); ctx.lineTo(a + R * 0.16, -R * 0.7); ctx.closePath(); ctx.fill(); } }
    if (style === 4) { shadedBall(-R * 0.82, R * 0.12, R * 0.27, hair); shadedBall(R * 0.82, R * 0.12, R * 0.27, hair); } // pigtails
    // wet strands (a touch lighter than the hair) + sheen
    ctx.strokeStyle = "rgba(255,255,255,0.16)"; ctx.lineWidth = 1.1; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(-R * 0.35, -R * 0.66); ctx.quadraticCurveTo(-R * 0.1, -R * 0.84, R * 0.25, -R * 0.72); ctx.moveTo(R * 0.15, -R * 0.56); ctx.quadraticCurveTo(R * 0.4, -R * 0.7, R * 0.55, -R * 0.52); ctx.stroke(); ctx.lineCap = "butt";
    ctx.fillStyle = "rgba(255,255,255,0.22)"; ctx.beginPath(); ctx.ellipse(-R * 0.25, -R * 0.68, R * 0.26, R * 0.08, -0.45, 0, Math.PI * 2); ctx.fill();
  }
  // A shaded sphere (light from top-left) — the building block for the 3D look.
  function shadedBall(x, y, r, col) {
    if (lowFx) { // cheap fallback: flat fill + a single highlight ellipse
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.18)"; ctx.beginPath(); ctx.ellipse(x - r * 0.3, y - r * 0.35, r * 0.42, r * 0.28, 0, 0, Math.PI * 2); ctx.fill();
      return;
    }
    const g = ctx.createRadialGradient(x - r * 0.38, y - r * 0.42, r * 0.12, x, y, r * 1.05);
    g.addColorStop(0, hi(col)); g.addColorStop(0.55, col); g.addColorStop(1, shade(col));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  // Same shading on an ellipse — heads and bodies aren't spheres.
  function shadedEllipse(x, y, rx, ry, col, rot = 0) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(rx, ry);
    if (lowFx) ctx.fillStyle = col;
    else { const g = ctx.createRadialGradient(-0.38, -0.42, 0.1, 0, 0, 1.05); g.addColorStop(0, hi(col)); g.addColorStop(0.55, col); g.addColorStop(1, shade(col)); ctx.fillStyle = g; }
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
  function drawSwimmer(s) {
    const R = s.r, bob = Math.sin(s.bob || 0), t = s.bob || 0, id = s.id || 0;
    const frac = s.frac != null ? s.frac : Math.max(0, s.life / s.maxLife);
    const skin = SKINS[s.sk % SKINS.length], hair = HAIRS[s.hr % HAIRS.length];
    const suit = SUITS[id % SUITS.length], ph = id * 1.7, style = id % 5;
    const cap = id % 7 === 3, goggles = !cap && id % 5 === 4, freckles = id % 3 === 0;
    const eyeCol = ["#3b6ea5", "#5a3a22", "#3f7a4a", "#2a2320"][id % 4];

    ctx.save(); ctx.translate(s.x, s.y + bob * 2.6); ctx.rotate(bob * 0.06);

    if (!glWater) { // (the GPU water draws the shadow, foam and ripples itself)
      // soft cast shadow into the water, away from the light (top left)
      if (lowFx) { ctx.fillStyle = "rgba(0,18,32,0.2)"; ctx.beginPath(); ctx.ellipse(R * 0.25, R * 0.8, R * 1.2, R * 0.85, 0, 0, Math.PI * 2); ctx.fill(); }
      else { const ao = ctx.createRadialGradient(R * 0.25, R * 0.8, R * 0.2, R * 0.25, R * 0.8, R * 1.5); ao.addColorStop(0, "rgba(0,18,32,0.34)"); ao.addColorStop(1, "rgba(0,18,32,0)"); ctx.fillStyle = ao; ctx.beginPath(); ctx.ellipse(R * 0.25, R * 0.8, R * 1.45, R * 1.0, 0, 0, Math.PI * 2); ctx.fill(); }
      // ripples
      for (let k = 0; k < (lowFx ? 1 : 2); k++) {
        const rp = ((t * 0.3 + ph + k * 0.5) % 1 + 1) % 1;
        ctx.strokeStyle = `rgba(225,244,252,${0.32 * (1 - rp)})`; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.ellipse(0, R * 0.62, R * (0.95 + rp * 1.4), R * (0.62 + rp * 0.9), 0, 0, Math.PI * 2); ctx.stroke();
      }
    }
    // sink-time gauge: dark backing (reads on bright water too), soft glow, crisp arc, bright tip
    const hue = 120 * frac, a0 = -Math.PI / 2, a1 = a0 + Math.PI * 2 * frac, gr = R + 10;
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(2,22,38,0.38)"; ctx.lineWidth = 4.6; ctx.beginPath(); ctx.arc(0, 0, gr, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.12)"; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(0, 0, gr, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = `hsla(${hue},85%,60%,0.22)`; ctx.lineWidth = 7; ctx.beginPath(); ctx.arc(0, 0, gr, a0, a1); ctx.stroke();
    ctx.strokeStyle = `hsl(${hue},85%,62%)`; ctx.lineWidth = 2.4; ctx.beginPath(); ctx.arc(0, 0, gr, a0, a1); ctx.stroke();
    ctx.fillStyle = `hsl(${hue},90%,80%)`; ctx.beginPath(); ctx.arc(Math.cos(a1) * gr, Math.sin(a1) * gr, 2.2, 0, Math.PI * 2); ctx.fill();
    ctx.lineCap = "butt";
    // danger ring: a monster is holding this swimmer — rises red until eaten
    const ch = s.ch != null ? s.ch : Math.min(1, (s.chomp || 0) / EAT_DWELL);
    if (ch > 0) { ctx.strokeStyle = `rgba(255,70,60,${0.35 + 0.45 * ch})`; ctx.lineWidth = 2 + 4 * ch; ctx.beginPath(); ctx.arc(0, 0, gr + 6 + Math.sin(t * 14) * 1.5 * ch, 0, Math.PI * 2); ctx.stroke(); }

    // --- submerged: kicking legs, refracted and water-tinted ---
    const refr = Math.sin(t * 2) * R * 0.06, kick = Math.sin(t * 2.2);
    ctx.globalAlpha = 0.42; ctx.strokeStyle = skin; ctx.lineWidth = 4.5; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(-R * 0.25 + refr, R * 1.05); ctx.lineTo(-R * 0.34 + refr, R * 1.65 + kick * 5); ctx.moveTo(R * 0.25 + refr, R * 1.05); ctx.lineTo(R * 0.34 + refr, R * 1.65 - kick * 5); ctx.stroke();
    ctx.globalAlpha = 1; ctx.lineCap = "butt";
    // torso in the swimsuit, mostly under the surface
    const tx = refr * 0.6;
    shadedEllipse(tx, R * 0.9, R * 0.64, R * 0.6, suit);
    ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(tx - R * 0.3, R * 0.5); ctx.quadraticCurveTo(tx, R * 0.72, tx + R * 0.3, R * 0.5); ctx.stroke(); // neckline
    ctx.globalAlpha = 0.28; ctx.fillStyle = "#1f6f9e"; ctx.beginPath(); ctx.ellipse(tx, R * 1.05, R * 0.9, R * 0.62, 0, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1; // water depth tint
    ctx.strokeStyle = "rgba(230,248,255,0.55)"; ctx.lineWidth = 1.8; ctx.beginPath(); ctx.ellipse(tx, R * 0.66, R * 0.8, R * 0.2, 0, Math.PI * 0.05, Math.PI * 0.95); ctx.stroke(); // waterline foam

    // neck (in the chin's shadow) and shoulder line
    ctx.fillStyle = shade(skin); ctx.beginPath(); ctx.roundRect(-R * 0.18, R * 0.3, R * 0.36, R * 0.32, R * 0.08); ctx.fill();
    shadedEllipse(0, R * 0.56, R * 0.64, R * 0.24, skin);

    // arms: shoulder -> elbow -> open hand, waving above the water
    const swL = Math.sin(t * 1.8), swR = Math.sin(t * 1.8 + Math.PI);
    const hand = [];
    const arm = (sgn, sw) => {
      const sx = sgn * R * 0.56, sy = R * 0.46;            // shoulder
      const ex = sgn * R * 1.12, ey = R * 0.08 + sw * 3;    // elbow
      const hx = sgn * R * 1.28, hy = -R * 0.5 + sw * 6;    // hand
      hand.push([hx, hy]);
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.strokeStyle = shade(skin); ctx.lineWidth = 6.6; ctx.beginPath(); ctx.moveTo(sx, sy + 1.2); ctx.lineTo(ex, ey + 1.2); ctx.lineTo(hx, hy + 1.2); ctx.stroke();
      ctx.strokeStyle = skin; ctx.lineWidth = 5.4; ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.lineWidth = 4.6; ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(hx, hy); ctx.stroke();
      ctx.lineCap = "butt";
      shadedEllipse(hx, hy - 1, 4.2, 4.8, skin); // palm
      if (!lowFx) { // fingers + thumb
        ctx.fillStyle = skin;
        for (let f = -1; f <= 1; f++) { ctx.beginPath(); ctx.ellipse(hx + f * 2.6 + sgn * 0.4, hy - 5.6 - (f === 0 ? 1 : 0), 1.3, 2.4, f * 0.25, 0, Math.PI * 2); ctx.fill(); }
        ctx.beginPath(); ctx.ellipse(hx - sgn * 4.4, hy - 1.5, 1.3, 2.2, -sgn * 0.9, 0, Math.PI * 2); ctx.fill();
      }
    };
    arm(-1, swL); arm(1, swR);
    // glossy droplets flung from the hands
    for (let k = 0; k < 2; k++) { const dp = ((t * 0.5 + ph + k) % 1 + 1) % 1, dr = 2.3 * (1 - dp); if (dr > 0.5) { ctx.fillStyle = "rgba(215,240,251,0.9)"; for (const [hx, hy] of hand) { ctx.beginPath(); ctx.arc(hx, hy - 6 - dp * 15, dr, 0, Math.PI * 2); ctx.fill(); } } }

    // --- head: an oval with a chin, not a ball ---
    if (style === 2 && !cap) { // long hair: a mass behind the head that ends at the jaw, and two falls beside it
      shadedEllipse(0, -R * 0.05, R * 0.9, R * 0.85, hair);
      shadedEllipse(-R * 0.8, R * 0.38, R * 0.2, R * 0.5, hair, -0.1); shadedEllipse(R * 0.8, R * 0.38, R * 0.2, R * 0.5, hair, 0.1);
    }
    shadedEllipse(-R * 0.72, R * 0.02, R * 0.13, R * 0.17, skin); shadedEllipse(R * 0.72, R * 0.02, R * 0.13, R * 0.17, skin); // ears
    shadedEllipse(0, 0, R * 0.72, R * 0.84, skin);
    ctx.fillStyle = "rgba(90,50,30,0.09)"; ctx.beginPath(); ctx.ellipse(0, R * 0.7, R * 0.3, R * 0.1, 0, 0, Math.PI); ctx.fill(); // faint chin shadow
    // waterline meniscus where the chin meets the water
    ctx.strokeStyle = "rgba(222,245,255,0.5)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.ellipse(0, R * 0.72, R * 0.62, R * 0.16, 0, 0, Math.PI, false); ctx.stroke();
    // cheeks + freckles
    ctx.fillStyle = "rgba(240,120,110,0.28)"; ctx.beginPath(); ctx.ellipse(-R * 0.4, R * 0.22, R * 0.16, R * 0.11, 0, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.ellipse(R * 0.4, R * 0.22, R * 0.16, R * 0.11, 0, 0, Math.PI * 2); ctx.fill();
    if (freckles && !lowFx) { ctx.fillStyle = "rgba(120,70,40,0.3)"; for (const [fx, fy] of [[-0.44, 0.1], [-0.34, 0.16], [-0.5, 0.18], [0.44, 0.1], [0.34, 0.16], [0.5, 0.18]]) { ctx.beginPath(); ctx.arc(fx * R, fy * R, 0.55, 0, Math.PI * 2); ctx.fill(); } } // faint, high on the cheeks (lower they read as stubble)
    // hair or a swim cap; some wear goggles pushed up on the forehead
    if (cap) {
      shadedEllipse(0, -R * 0.34, R * 0.74, R * 0.58, ["#ff7aa8", "#ffd23a", "#2dd4bf"][id % 3]); // bright caps (white read as a bald head)
      ctx.strokeStyle = "rgba(0,0,0,0.25)"; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.ellipse(0, -R * 0.1, R * 0.72, R * 0.26, 0, Math.PI * 0.06, Math.PI * 0.94, true); ctx.stroke();
    } else drawHairTop(style, R, hair);
    if (goggles && !lowFx) {
      ctx.strokeStyle = "#1c1c1c"; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.ellipse(0, -R * 0.44, R * 0.72, R * 0.14, 0, Math.PI * 1.08, Math.PI * 1.92); ctx.stroke(); // strap
      for (const gx of [-R * 0.27, R * 0.27]) { ctx.fillStyle = "#1c1c1c"; ctx.beginPath(); ctx.ellipse(gx, -R * 0.56, R * 0.2, R * 0.12, 0, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = "rgba(120,200,240,0.85)"; ctx.beginPath(); ctx.ellipse(gx, -R * 0.56, R * 0.15, R * 0.08, 0, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = "rgba(255,255,255,0.6)"; ctx.beginPath(); ctx.ellipse(gx - R * 0.05, -R * 0.59, R * 0.05, R * 0.025, -0.5, 0, Math.PI * 2); ctx.fill(); }
    }
    // brows: worried arch
    const brow = -R * 0.28 - Math.abs(bob) * 1.2;
    ctx.strokeStyle = "rgba(60,38,26,0.8)"; ctx.lineWidth = 1.5; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(-R * 0.46, brow + 3); ctx.quadraticCurveTo(-R * 0.3, brow - 3, -R * 0.12, brow); ctx.moveTo(R * 0.12, brow); ctx.quadraticCurveTo(R * 0.3, brow - 3, R * 0.46, brow + 3); ctx.stroke(); ctx.lineCap = "butt";
    // eyes: whites, coloured iris, pupil, catchlight, upper lid
    const blink = Math.sin(t * 0.9 + id * 1.3) > 0.94;
    for (const ex of [-R * 0.28, R * 0.28]) {
      if (blink) { ctx.strokeStyle = "#2a2320"; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(ex - R * 0.12, -R * 0.02); ctx.lineTo(ex + R * 0.12, -R * 0.02); ctx.stroke(); continue; }
      ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.ellipse(ex, -R * 0.02, R * 0.14, R * 0.17, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = eyeCol; ctx.beginPath(); ctx.arc(ex + R * 0.02, -R * 0.03, R * 0.085, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#151210"; ctx.beginPath(); ctx.arc(ex + R * 0.02, -R * 0.03, R * 0.045, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.beginPath(); ctx.arc(ex - R * 0.02, -R * 0.08, R * 0.035, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "rgba(60,35,25,0.6)"; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.ellipse(ex, -R * 0.02, R * 0.14, R * 0.17, 0, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke();
    }
    // nose
    ctx.strokeStyle = "rgba(120,80,60,0.55)"; ctx.lineWidth = 1.4; ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(-R * 0.02, R * 0.08); ctx.quadraticCurveTo(-R * 0.1, R * 0.24, R * 0.03, R * 0.27); ctx.stroke(); ctx.lineCap = "butt";
    // mouth: shouting — lips, dark inside, upper teeth, tongue
    const gape = R * 0.12 + (Math.sin(t * 3) + 1) * R * 0.09, mw = R * 0.16 + gape * 0.25, my = R * 0.5;
    ctx.fillStyle = "#b34a44"; ctx.beginPath(); ctx.ellipse(0, my, mw + 1.4, gape + 1.4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#5a2020"; ctx.beginPath(); ctx.ellipse(0, my, mw, gape, 0, 0, Math.PI * 2); ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.ellipse(0, my, mw, gape, 0, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = "#f7f3ea"; ctx.fillRect(-mw, my - gape - 1, mw * 2, gape * 0.5);
    ctx.fillStyle = "#d9605a"; ctx.beginPath(); ctx.ellipse(0, my + gape * 0.75, mw * 0.7, gape * 0.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    // rim light + specular on the head
    ctx.strokeStyle = "rgba(255,255,255,0.22)"; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.ellipse(0, 0, R * 0.7, R * 0.82, 0, Math.PI * 1.06, Math.PI * 1.5); ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.22)"; ctx.beginPath(); ctx.ellipse(-R * 0.3, -R * 0.2, R * 0.14, R * 0.09, -0.6, 0, Math.PI * 2); ctx.fill();
    // panic bubble
    const bpp = ((t * 0.4 + id) % 1 + 1) % 1;
    if (bpp < 0.5) { ctx.strokeStyle = "rgba(210,238,250,0.6)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(R * 0.6, -R * 0.8 - bpp * R, 1.5 + bpp * 2, 0, Math.PI * 2); ctx.stroke(); }

    ctx.restore();
  }
  function drawSplash(sp) { const p = sp.t / 0.6; ctx.strokeStyle = sp.good ? `rgba(120,230,160,${1 - p})` : `rgba(230,120,120,${1 - p})`; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(sp.x, sp.y, 6 + p * 26, 0, Math.PI * 2); ctx.stroke(); }
  function drawMonster(m) {
    const R = m.r || 30, t = m.wob || 0, sub = m.sub || 0;
    // eased turn instead of a snap flip; the nose dips or rises with the heading; a diving beast sinks and fades
    const faceWant = Math.cos(m.dir || 0) < 0 ? -1 : 1;
    m.face = m.face === undefined ? faceWant : m.face + (faceWant - m.face) * 0.1;
    const pitch = -Math.sin(m.dir || 0) * 0.3 * Math.sign(m.face || 1), bob = Math.sin(t) * 2 + sub * R * 0.5;
    ctx.save(); ctx.translate(m.x, m.y);
    if (!glWater) { // (the GPU water draws the shadow, the shape under the surface and the wake itself)
      const by = Math.sin(t) * 2 + sub * R * 0.5, fc = m.face || 1;
      const mao = ctx.createRadialGradient(R * 0.2, by + R * 0.68, R * 0.3, R * 0.2, by + R * 0.68, R * 1.9);
      mao.addColorStop(0, `rgba(0,18,32,${0.32 * (1 - sub)})`); mao.addColorStop(1, "rgba(0,18,32,0)");
      ctx.fillStyle = mao; ctx.beginPath(); ctx.ellipse(R * 0.2, by + R * 0.68, R * 1.8, R * 0.9, 0, 0, Math.PI * 2); ctx.fill();
      if (sub > 0.05) { ctx.fillStyle = `rgba(3,26,40,${0.5 * sub})`; ctx.beginPath(); ctx.ellipse(-R * 0.25 * fc, by + R * 0.3, R * 1.7, R * 0.75, 0, 0, Math.PI * 2); ctx.fill(); }
    }
    if (sub > 0.15 && !glWater) { // surface disturbance where it went under
      ctx.strokeStyle = `rgba(220,242,250,${0.4 * sub})`; ctx.lineWidth = 2;
      for (let k = 0; k < 3; k++) { const f = ((t * 0.35 + k / 3) % 1); ctx.globalAlpha = (1 - f) * sub; ctx.beginPath(); ctx.ellipse(0, R * 0.3, R * (0.6 + f * 1.6), R * (0.25 + f * 0.7), 0, 0, Math.PI * 2); ctx.stroke(); }
      ctx.globalAlpha = sub; ctx.fillStyle = "rgba(222,242,250,0.6)"; for (let k = 0; k < 5; k++) { ctx.beginPath(); ctx.arc(Math.sin(t * 1.3 + k * 2) * R * 0.8, R * 0.25 + Math.cos(t * 0.9 + k) * R * 0.3, 1.5 + (k % 2), 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.globalAlpha = 1 - sub * 0.8;
    ctx.translate(0, bob); ctx.scale(m.face, 1 - sub * 0.4); ctx.rotate(pitch * 0.35);
    const dark = "#1f4f2b", mid = "#3f8f4a", light = "#6cc276", belly = "#bfd98f";
    const body = ctx.createRadialGradient(-R * 0.35, -R * 0.35, R * 0.2, -R * 0.15, 0, R * 1.7);
    body.addColorStop(0, light); body.addColorStop(0.5, mid); body.addColorStop(1, "#245f35");
    // wake (a V of foam trailing behind; the GPU water draws its own) and drifting bubbles
    ctx.lineCap = "round";
    if (!glWater) {
      ctx.strokeStyle = "rgba(220,242,250,0.35)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(R * 0.6, R * 0.3); ctx.quadraticCurveTo(-R * 1.2, R * 0.9, -R * 2.9, R * 1.05 + Math.sin(t * 2) * 3); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(R * 0.6, R * 0.3); ctx.quadraticCurveTo(-R * 1.2, -R * 0.2, -R * 2.9, -R * 0.35 + Math.sin(t * 2 + 1) * 3); ctx.stroke();
    }
    ctx.fillStyle = "rgba(222,242,250,0.45)";
    for (let i = 0; i < 5; i++) { ctx.beginPath(); ctx.arc(-R * 1.5 - i * R * 0.4, R * 0.45 + Math.sin(t * 2 + i) * 4, 3 - i * 0.45, 0, Math.PI * 2); ctx.fill(); }
    // waterline ring where the body breaks the surface
    ctx.strokeStyle = "rgba(230,248,255,0.5)"; ctx.lineWidth = 1.8; ctx.beginPath(); ctx.ellipse(-R * 0.15, R * 0.42, R * 1.15, R * 0.28, 0, Math.PI * 0.05, Math.PI * 0.95); ctx.stroke();

    // tail: tapering S-curve ending in a fluke
    const tw = Math.sin(t * 2.2 - 3.6) * R * 0.24; // the same wave, further down the body
    ctx.strokeStyle = body; ctx.lineCap = "round";
    ctx.lineWidth = R * 0.34; ctx.beginPath(); ctx.moveTo(-R * 1.1, R * 0.05); ctx.quadraticCurveTo(-R * 1.7, -R * 0.1 + tw, -R * 2.05, -R * 0.3 + tw * 0.6); ctx.stroke();
    ctx.lineWidth = R * 0.18; ctx.beginPath(); ctx.moveTo(-R * 2.0, -R * 0.3 + tw * 0.6); ctx.quadraticCurveTo(-R * 2.3, -R * 0.55 + tw, -R * 2.45, -R * 0.75 + tw * 0.8); ctx.stroke();
    ctx.fillStyle = dark; ctx.beginPath(); const fx = -R * 2.45, fy = -R * 0.75 + tw * 0.8; // fluke
    ctx.moveTo(fx, fy); ctx.quadraticCurveTo(fx - R * 0.35, fy - R * 0.45, fx - R * 0.15, fy - R * 0.6); ctx.quadraticCurveTo(fx + R * 0.05, fy - R * 0.25, fx + R * 0.2, fy - R * 0.05); ctx.quadraticCurveTo(fx + R * 0.1, fy + R * 0.3, fx - R * 0.25, fy + R * 0.32); ctx.closePath(); ctx.fill();

    // back humps with a serrated dorsal ridge, each hump shaded and scaled
    for (let i = 0; i < 3; i++) {
      const hx = -R * 1.15 + i * R * 0.6, hy = Math.sin(t * 2.2 - i * 1.1) * R * 0.16, hr = R * 0.42 - i * 2; // a wave travelling down the back
      ctx.fillStyle = dark; for (let k = -1; k <= 1; k++) { const sx = hx + k * hr * 0.42; ctx.beginPath(); ctx.moveTo(sx - hr * 0.2, hy - hr * 0.8); ctx.lineTo(sx, hy - hr * 1.28 + Math.abs(k) * hr * 0.15); ctx.lineTo(sx + hr * 0.2, hy - hr * 0.8); ctx.closePath(); ctx.fill(); }
      ctx.fillStyle = body; ctx.beginPath(); ctx.arc(hx, hy, hr, Math.PI, 0); ctx.fill();
      ctx.strokeStyle = "rgba(20,60,30,0.35)"; ctx.lineWidth = 1; for (let row = 0; row < 2; row++) for (let k = -2; k <= 2; k++) { ctx.beginPath(); ctx.arc(hx + k * hr * 0.36 + (row % 2) * hr * 0.18, hy - hr * 0.25 - row * hr * 0.3, hr * 0.18, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke(); } // scales
      ctx.fillStyle = "rgba(255,255,255,0.14)"; ctx.beginPath(); ctx.ellipse(hx - hr * 0.25, hy - hr * 0.45, hr * 0.4, hr * 0.18, -0.3, 0, Math.PI * 2); ctx.fill();
    }

    // main body: shaded, with scale rows, a pale plated belly, rim light, and two flippers
    ctx.fillStyle = body; ctx.beginPath(); ctx.ellipse(-R * 0.15, R * 0.02, R * 0.98, R * 0.58, 0, 0, Math.PI * 2); ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.ellipse(-R * 0.15, R * 0.02, R * 0.98, R * 0.58, 0, 0, Math.PI * 2); ctx.clip();
    ctx.strokeStyle = "rgba(20,60,30,0.32)"; ctx.lineWidth = 1;
    for (let row = 0; row < 4; row++) for (let k = -5; k <= 4; k++) { const sx = -R * 0.15 + k * R * 0.2 + (row % 2) * R * 0.1, sy = -R * 0.35 + row * R * 0.17; ctx.beginPath(); ctx.arc(sx, sy, R * 0.1, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke(); }
    ctx.fillStyle = belly; ctx.beginPath(); ctx.ellipse(-R * 0.1, R * 0.34, R * 0.78, R * 0.3, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(90,110,60,0.45)"; ctx.lineWidth = 1; for (let k = -3; k <= 3; k++) { const sx = -R * 0.1 + k * R * 0.2; ctx.beginPath(); ctx.moveTo(sx, R * 0.12); ctx.lineTo(sx, R * 0.6); ctx.stroke(); } // belly plates
    ctx.restore();
    ctx.strokeStyle = "rgba(200,255,210,0.25)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.ellipse(-R * 0.15, R * 0.02, R * 0.96, R * 0.56, 0, Math.PI * 1.12, Math.PI * 1.96); ctx.stroke(); // rim light
    ctx.fillStyle = "rgba(255,255,255,0.16)"; ctx.beginPath(); ctx.ellipse(-R * 0.45, -R * 0.25, R * 0.4, R * 0.16, -0.4, 0, Math.PI * 2); ctx.fill(); // specular
    const flap = Math.sin(t * 2) * R * 0.12;
    ctx.fillStyle = "#2b6b3a"; ctx.beginPath(); ctx.moveTo(-R * 0.05, R * 0.3); ctx.quadraticCurveTo(-R * 0.45, R * 0.98 + flap, -R * 0.7, R * 0.72); ctx.quadraticCurveTo(-R * 0.35, R * 0.5, -R * 0.05, R * 0.3); ctx.fill(); // near flipper
    ctx.fillStyle = "#245f35"; ctx.beginPath(); ctx.moveTo(-R * 0.75, R * 0.2); ctx.quadraticCurveTo(-R * 1.1, R * 0.7 - flap, -R * 1.3, R * 0.5); ctx.quadraticCurveTo(-R * 1.0, R * 0.35, -R * 0.75, R * 0.2); ctx.fill(); // rear flipper
    ctx.strokeStyle = "rgba(20,60,30,0.4)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(-R * 0.2, R * 0.42); ctx.lineTo(-R * 0.55, R * 0.72); ctx.moveTo(-R * 0.3, R * 0.4); ctx.lineTo(-R * 0.66, R * 0.62); ctx.stroke(); // flipper bones

    // neck: thick S-curve with a pale throat and ridge spikes
    const sway = Math.sin(t * 1.2) * R * 0.08;
    ctx.strokeStyle = body; ctx.lineWidth = R * 0.46; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(R * 0.35, R * 0.02); ctx.quadraticCurveTo(R * 0.85 + sway, -R * 0.7, R * 0.98 + sway, -R * 1.05); ctx.stroke();
    ctx.strokeStyle = belly; ctx.lineWidth = R * 0.16; ctx.beginPath(); ctx.moveTo(R * 0.5, R * 0.1); ctx.quadraticCurveTo(R * 0.98 + sway, -R * 0.62, R * 1.08 + sway, -R * 0.98); ctx.stroke(); // throat
    ctx.strokeStyle = "rgba(90,110,60,0.4)"; ctx.lineWidth = 1; for (let i = 0; i < 5; i++) { const nt = 0.15 + i * 0.17, nx = R * (0.5 + nt * 0.58) + sway * nt, ny = R * (0.1 - 1.08 * nt * nt); ctx.beginPath(); ctx.moveTo(nx - R * 0.07, ny); ctx.lineTo(nx + R * 0.07, ny + R * 0.02); ctx.stroke(); } // throat rings
    ctx.fillStyle = dark;
    for (let i = 0; i < 4; i++) { const nt = 0.3 + i * 0.18, nx = R * (0.32 + nt * 0.58) + sway * nt, ny = R * (-0.1 - 1.05 * nt * nt); ctx.beginPath(); ctx.moveTo(nx - 3.5, ny); ctx.lineTo(nx - 0.5, ny - 7); ctx.lineTo(nx + 3, ny); ctx.closePath(); ctx.fill(); }

    // head: brow ridge, nostrils, jaws with gums, teeth top and bottom, tongue, slit-pupil eye, ear frill
    ctx.save(); ctx.translate(R * 1.02 + sway, -R * 1.08); ctx.rotate(-0.35 + pitch);
    const gape = (Math.sin(t * 3) + 1) / 2 * R * 0.18 + 1.5;
    // lower jaw (opens downward)
    ctx.save(); ctx.translate(R * 0.18, R * 0.12); ctx.rotate(gape / R * 1.6);
    ctx.fillStyle = "#2f7a3e"; ctx.beginPath(); ctx.ellipse(R * 0.2, R * 0.05, R * 0.26, R * 0.1, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#7a1f22"; ctx.beginPath(); ctx.ellipse(R * 0.2, R * 0.02, R * 0.22, R * 0.06, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#c8615a"; ctx.beginPath(); ctx.ellipse(R * 0.14, R * 0.03, R * 0.1, R * 0.035, 0, 0, Math.PI * 2); ctx.fill(); // tongue
    ctx.fillStyle = "#fff"; for (let i = 0; i < 3; i++) { const tx = R * 0.1 + i * R * 0.1; ctx.beginPath(); ctx.moveTo(tx, R * 0.0); ctx.lineTo(tx + 2.6, R * 0.0); ctx.lineTo(tx + 1.3, -3); ctx.closePath(); ctx.fill(); }
    ctx.restore();
    // upper head + snout
    ctx.fillStyle = body; ctx.beginPath(); ctx.ellipse(0, 0, R * 0.44, R * 0.31, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(R * 0.36, R * 0.04, R * 0.23, R * 0.15, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#7a1f22"; ctx.beginPath(); ctx.moveTo(R * 0.16, R * 0.12); ctx.lineTo(R * 0.58, R * 0.1); ctx.lineTo(R * 0.56, R * 0.15); ctx.lineTo(R * 0.16, R * 0.17); ctx.closePath(); ctx.fill(); // upper gum
    ctx.fillStyle = "#fff"; for (let i = 0; i < 4; i++) { const tx = R * 0.22 + i * R * 0.09; ctx.beginPath(); ctx.moveTo(tx, R * 0.13); ctx.lineTo(tx + 3, R * 0.13); ctx.lineTo(tx + 1.5, R * 0.13 + 4); ctx.closePath(); ctx.fill(); }
    ctx.fillStyle = "#173d20"; ctx.beginPath(); ctx.ellipse(R * 0.5, -R * 0.02, 2, 1.3, 0.3, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.ellipse(R * 0.44, -R * 0.06, 1.6, 1.1, 0.3, 0, Math.PI * 2); ctx.fill(); // nostrils
    ctx.fillStyle = "rgba(255,255,255,0.14)"; ctx.beginPath(); ctx.ellipse(-R * 0.1, -R * 0.14, R * 0.2, R * 0.08, -0.2, 0, Math.PI * 2); ctx.fill(); // head sheen
    ctx.fillStyle = dark; ctx.beginPath(); ctx.moveTo(-R * 0.08, -R * 0.24); ctx.lineTo(0, -R * 0.46); ctx.lineTo(R * 0.1, -R * 0.2); ctx.closePath(); ctx.fill(); // crest
    ctx.fillStyle = "#2b6b3a"; ctx.beginPath(); ctx.moveTo(-R * 0.3, -R * 0.1); ctx.quadraticCurveTo(-R * 0.6, -R * 0.35, -R * 0.62, -R * 0.02); ctx.quadraticCurveTo(-R * 0.5, R * 0.1, -R * 0.3, R * 0.02); ctx.closePath(); ctx.fill(); // ear frill
    // eye: brow ridge, yellow sclera, slit pupil, catchlight
    ctx.fillStyle = dark; ctx.beginPath(); ctx.ellipse(R * 0.06, -R * 0.14, R * 0.17, R * 0.06, -0.15, Math.PI, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fdd23a"; ctx.beginPath(); ctx.ellipse(R * 0.06, -R * 0.04, R * 0.15, R * 0.12, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#111"; ctx.beginPath(); ctx.ellipse(R * 0.09, -R * 0.04, R * 0.04, R * 0.1, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.beginPath(); ctx.arc(R * 0.12, -R * 0.09, 1.8, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // drips falling off the neck
    if (!lowFx) { ctx.fillStyle = "rgba(215,240,251,0.8)"; for (let k = 0; k < 2; k++) { const dp = ((t * 0.45 + k * 0.5) % 1 + 1) % 1; ctx.beginPath(); ctx.arc(R * 0.75 + sway * 0.6, -R * 0.55 + dp * R * 0.9, 1.8 * (1 - dp * 0.6), 0, Math.PI * 2); ctx.fill(); } }
    ctx.restore(); ctx.lineCap = "butt";
  }
  // HiDPI backing store: draw in logical CW×CH coords but back the canvas with
  // (displayed size × devicePixelRatio) pixels so text and edges stay crisp.
  // Capped so a big retina screen doesn't melt: pixel ratio at most 2 on
  // desktop and 1.5 on phones/tablets, and at most MAX_BACK_W pixels wide.
  // Checked every frame (cheap), so it follows resizes, fullscreen, a window
  // moved to another screen and the cap itself changing.
  let backK = 1;
  const MAX_BACK_W = 2560, coarseMQ = matchMedia("(pointer: coarse)");
  function fitBacking() {
    const cw = canvas.clientWidth;
    if (!cw) return;
    const k = Math.min(window.devicePixelRatio || 1, coarseMQ.matches ? 1.5 : 2, MAX_BACK_W / cw);
    const w = Math.max(1, Math.round(cw * k)), h = Math.round(w * CH / CW);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    backK = canvas.width / CW;
  }
  function resetBase() { ctx.setTransform(backK, 0, 0, backK, 0, 0); }

  function render() {
    ({ authoritative, selfId, usingTouch, muted, quitArmedUntil, levelStartScore, saved } = ui.live());
    resetBase();
    const v = ui.view();
    const inGame = !!v && v.phase !== Phase.LOBBY;
    const f = inGame ? fit(v.world.w, v.world.h) : null;
    if (inGame) lowFx = (v.swimmers.length + saved.length) > 18; // lighten shading when crowded
    // the GPU water layer under this canvas (false: no GPU water this frame -> 2D water)
    glWater = inGame && water.draw({ v, f, t: waveT, lowFx, saved, selfId, selfDash: selfPos.dashActive > 0, SHORE_H, playing: v.phase === Phase.PLAY });
    if (glWater) ctx.clearRect(0, 0, CW, CH); else { ctx.fillStyle = "#08222f"; ctx.fillRect(0, 0, CW, CH); }
    if (!v) { drawWaitScreen("Ansluter…"); return; }
    if (v.phase === Phase.LOBBY) { drawLobbyScreen(v); return; }
    ctx.setTransform(backK * f.s, 0, 0, backK * f.s, backK * f.ox, backK * f.oy);
    if (!glWater) drawWater2D(ctx, v.world.w, v.world.h, shoreY(v.world), waveT, lowFx, backK * f.s);
    for (const z of v.swamps || []) drawSwamp(z);
    if (!glWater) for (const z of v.whirls || []) drawWhirl(z);
    drawShore(v.world.w, v.world.h);
    drawScenery(v.world.w, v.world.h);
    for (const o of v.obstacles) drawBrygga(o);
    for (const s of v.swimmers) drawSwimmer(s);
    for (const m of v.monsters || []) drawMonster(m);
    for (const sv of saved) drawSaved(sv);
    if (v.splashes) for (const sp of v.splashes) drawSplash(sp);
    for (const p of v.players) { const you = p.id === selfId; const stunned = you ? selfPos.stun > 0 : !!(p.stunned || p.stun); drawLivboj(p.x, p.y, p.r || 30, p.hue, you && (p.dashActive > 0 || selfPos.dashActive > 0), p.name, you, stunned); }
    drawSeagulls(v.world.w, waveT);
    drawLightGrade(v.world.w, v.world.h);
    resetBase();
    drawHUD(v); drawScoreboard(v); drawOverlays(v); drawQuitBtn(v); drawMute();
  }
  function drawWaitScreen(msg) {
    drawNetLine();
    drawLivboj(CW / 2, CH / 2 - 30, 46, null, true, null, false);
    ctx.fillStyle = "#eaf6ff"; ctx.textAlign = "center"; ctx.font = "800 30px system-ui, sans-serif"; ctx.fillText("Livbojen", CW / 2, CH / 2 + 40);
    ctx.font = "500 18px system-ui, sans-serif"; ctx.fillStyle = "#bfe0f2"; ctx.fillText(msg, CW / 2, CH / 2 + 74);
    drawMute();
  }
  function drawLobbyScreen(v) {
    drawLivboj(CW / 2, CH / 2 - 96, 38, null, true, null, false);
    ctx.textAlign = "center";
    ctx.fillStyle = "#eaf6ff"; ctx.font = "800 26px system-ui, sans-serif"; ctx.fillText("Lobby", CW / 2, CH / 2 - 34);
    ctx.font = "500 16px system-ui, sans-serif"; ctx.fillStyle = "#bfe0f2";
    if (authoritative) drawActionButton("Starta spelet", CW / 2, CH / 2 - 8);
    else ctx.fillText("Väntar på att värden startar…", CW / 2, CH / 2 - 8);
    const names = (v.players || []).map((p) => (p.id === selfId ? myName + " (du)" : (p.name || "Spelare")));
    ctx.font = "700 16px system-ui, sans-serif"; ctx.fillStyle = "#f4571d"; ctx.fillText(`${names.length} spelare i lobbyn`, CW / 2, CH / 2 + 22);
    ctx.font = "600 15px system-ui, sans-serif"; ctx.fillStyle = "#eaf6ff";
    let y = CH / 2 + 46; for (const nm of names.slice(0, 12)) { ctx.fillText(nm, CW / 2, y); y += 20; }
    drawNetLine();
    drawMute();
  }
  function drawHUD(v) {
    ctx.textAlign = "left"; ctx.font = "700 20px system-ui, sans-serif"; ctx.fillStyle = "#eaf6ff";
    ctx.fillText(`Nivå ${v.hud.level + 1}/${BASE_LEVELS.length}`, 18, 30);
    ctx.font = "600 14px system-ui, sans-serif"; ctx.fillStyle = "#ffd7c7"; ctx.fillText(`Missade ${v.hud.missed}/${v.hud.allowedMisses}`, 18, 52);
    ctx.textAlign = "center"; ctx.font = "700 20px system-ui, sans-serif"; ctx.fillStyle = "#eaf6ff"; ctx.fillText(`Räddade ${v.hud.caught} / ${v.hud.quota}`, CW / 2, 30);
    ctx.font = "600 14px system-ui, sans-serif"; ctx.fillStyle = "#bfe0f2"; ctx.fillText(`${v.hud.n} spelare`, CW / 2, 52);
    ctx.textAlign = "right"; ctx.font = "800 22px system-ui, sans-serif"; ctx.fillStyle = "#f4571d"; ctx.fillText(`Din poäng ${v.hud.yourScore}`, CW - 18, 32);
    if (usingTouch && v.phase === Phase.PLAY) {
      ctx.save(); ctx.globalAlpha = 0.9; ctx.fillStyle = "#f4571d"; ctx.beginPath(); ctx.arc(DASH_BTN.x, DASH_BTN.y, DASH_BTN.r, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
      ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.font = "800 18px system-ui, sans-serif"; ctx.fillText("Spurt", DASH_BTN.x, DASH_BTN.y); ctx.textBaseline = "alphabetic"; ctx.restore();
    }
  }
  function drawScoreboard(v) {
    if (v.hud.n < 2 || !v.players) return;
    const board = [...v.players].map((p) => ({ name: p.id === selfId ? "Du" : (p.name || "Spelare"), score: p.score || 0, hue: p.hue, you: p.id === selfId })).sort((a, b) => b.score - a.score).slice(0, 8);
    let y = 82;
    ctx.textAlign = "left"; ctx.font = "700 14px system-ui, sans-serif";
    for (const b of board) {
      ctx.fillStyle = `hsl(${b.hue},85%,60%)`; ctx.beginPath(); ctx.arc(24, y - 4, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = b.you ? "#ffd7c7" : "#eaf6ff"; ctx.fillText(`${b.name}: ${b.score} p`, 36, y); y += 20;
    }
  }
  function panel(lines, sub) {
    ctx.fillStyle = "rgba(4,20,30,0.62)"; ctx.fillRect(0, 0, CW, CH); ctx.textAlign = "center"; ctx.fillStyle = "#eaf6ff"; ctx.font = "800 40px system-ui, sans-serif";
    let y = CH / 2 - (lines.length - 1) * 28 - (sub ? 24 : 0);
    for (const l of lines) { ctx.fillText(l, CW / 2, y); y += 52; }
    if (sub) { ctx.font = "500 20px system-ui, sans-serif"; ctx.fillStyle = "#bfe0f2"; ctx.fillText(sub, CW / 2, y + 6); }
  }
  function drawOverlays(v) {
    const prompt = (txt) => { ctx.font = "800 22px system-ui, sans-serif"; ctx.fillStyle = "#f4571d"; ctx.textAlign = "center"; ctx.fillText(txt, CW / 2, CH / 2 + 74); };
    const wait = () => { ctx.font = "600 18px system-ui, sans-serif"; ctx.fillStyle = "#bfe0f2"; ctx.textAlign = "center"; ctx.fillText("Väntar på värden…", CW / 2, CH / 2 + 74); };
    if (v.phase === Phase.INTRO) panel([`Nivå ${v.hud.level + 1}`], `Rädda ${v.hud.quota} · ${v.hud.n} spelare`);
    else if (v.phase === Phase.CLEARED) drawLevelBoard(v);
    else if (v.phase === Phase.OVER) drawEndScreen(["Spelet är slut"], `Totalpoäng ${v.hud.score}`, v);
    else if (v.phase === Phase.WIN) drawEndScreen(["Ni vann! 🛟", `Alla ${BASE_LEVELS.length} nivåer klara`], `Slutpoäng ${v.hud.score}`, v);
  }
  // Current-round standings: every player ranked by points (used between
  // levels and on the end screen).
  function drawStandings(v, y, maxRows) {
    const rows = [...(v.players || [])].map((p) => ({ name: p.id === selfId ? "Du" : (p.name || "Spelare"), score: p.score || 0, rescues: p.rescues || 0, hue: p.hue, you: p.id === selfId })).sort((a, b) => b.score - a.score).slice(0, maxRows);
    ctx.font = "800 18px system-ui, sans-serif"; ctx.fillStyle = "#f4571d"; ctx.textAlign = "center"; ctx.fillText("Ställning", CW / 2, y); y += 26;
    ctx.font = "700 16px system-ui, sans-serif";
    rows.forEach((r, i) => {
      const txt = `${i + 1}.  ${r.name}  —  ${r.score} p  ·  ${r.rescues} räddade`;
      const tw = ctx.measureText(txt).width;
      ctx.fillStyle = `hsl(${r.hue},85%,60%)`; ctx.beginPath(); ctx.arc(CW / 2 - tw / 2 - 14, y - 5, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = r.you ? "#ffd7c7" : "#eaf6ff"; ctx.fillText(txt, CW / 2, y); y += 23;
    });
    return y;
  }
  // Between levels: confetti, a top-three podium, the "på väg upp" riser, and
  // a pulsing wait prompt. Only the host advances (advance() is gated).
  function drawLevelBoard(v) {
    const t = waveT;
    ctx.fillStyle = "rgba(4,20,30,0.78)"; ctx.fillRect(0, 0, CW, CH);
    const CONF = ["#ffb020", "#e5484d", "#3aa0ff", "#22c55e", "#ec4899", "#f4f4f0"];
    for (let i = 0; i < 46; i++) {
      const x = ((i * 197) % CW) + Math.sin(t * 1.3 + i) * 22;
      const y = ((((t * (38 + (i % 5) * 11) + i * 53) % (CH + 40)) + CH + 40) % (CH + 40)) - 20;
      ctx.save(); ctx.translate(x, y); ctx.rotate(t * 2 + i); ctx.globalAlpha = 0.85; ctx.fillStyle = CONF[i % CONF.length]; ctx.fillRect(-4, -2.5, 8, 5); ctx.restore();
    }
    ctx.globalAlpha = 1; ctx.textAlign = "center";
    ctx.fillStyle = "#eaf6ff"; ctx.font = "800 36px system-ui, sans-serif"; ctx.fillText(`Nivå ${v.hud.level + 1} avklarad!`, CW / 2, 74);
    ctx.font = "500 16px system-ui, sans-serif"; ctx.fillStyle = "#bfe0f2"; ctx.fillText(`Lagets poäng ${v.hud.score}`, CW / 2, 100);
    const rows = [...(v.players || [])].map((p) => ({ id: p.id, name: p.id === selfId ? "Du" : (p.name || "Spelare"), score: p.score || 0, rescues: p.rescues || 0, hue: p.hue, you: p.id === selfId, gain: (p.score || 0) - (levelStartScore.get(p.id) || 0) })).sort((a, b) => b.score - a.score);
    // podium: 2nd left, 1st centre, 3rd right
    const baseY = 300, slots = [[1, -120, 66, "#c9ced6"], [0, 0, 92, "#ffcf3d"], [2, 120, 50, "#d0894f"]];
    for (const [rank, dx, hgt, col] of slots) {
      const r = rows[rank]; if (!r) continue;
      const x = CW / 2 + dx, bounce = rank === 0 ? Math.abs(Math.sin(t * 3)) * 6 : 0;
      ctx.fillStyle = col; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x - 44, baseY - hgt, 88, hgt, 8) : ctx.rect(x - 44, baseY - hgt, 88, hgt); ctx.fill();
      ctx.fillStyle = "rgba(0,0,0,0.25)"; ctx.font = "800 26px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.fillText(String(rank + 1), x, baseY - hgt / 2 + 10);
      drawLivboj(x, baseY - hgt - 24 - bounce, 18, r.hue, rank === 0, null, false, false);
      if (rank === 0) { ctx.font = "22px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.fillText("👑", x, baseY - hgt - 52 - bounce); }
      ctx.textAlign = "center"; ctx.fillStyle = r.you ? "#ffd7c7" : "#eaf6ff"; ctx.font = "700 15px system-ui, sans-serif"; ctx.fillText(r.name, x, baseY + 20);
      ctx.fillStyle = "#bfe0f2"; ctx.font = "600 13px system-ui, sans-serif"; ctx.fillText(`${r.score} p · ${r.rescues} räddade`, x, baseY + 38);
    }
    let y = baseY + 68;
    // up-and-coming: biggest gain this level among players not already leading
    const riser = rows.length > 1 ? rows.slice(1).reduce((m, r) => (r.gain > (m ? m.gain : 0) ? r : m), null) : null;
    ctx.font = "800 16px system-ui, sans-serif"; ctx.fillStyle = "#7ee0a0";
    if (riser && riser.gain > 0) ctx.fillText(`⬆ På väg upp: ${riser.name}  +${riser.gain} p den här nivån`, CW / 2, y);
    else if (rows[0]) ctx.fillText(`Bra jobbat! +${rows[0].gain} p den här nivån`, CW / 2, y);
    y += 28;
    if (rows.length > 3) { ctx.font = "600 13px system-ui, sans-serif"; ctx.fillStyle = "#bfe0f2"; ctx.fillText(rows.slice(3, 12).map((r, i) => `${i + 4}. ${r.name} ${r.score} p`).join("   ·   "), CW / 2, y); }
    ctx.globalAlpha = 0.7 + 0.3 * Math.sin(t * 3);
    if (authoritative) drawActionButton("Starta nästa nivå", CW / 2, CH - 64);
    else { ctx.font = "600 16px system-ui, sans-serif"; ctx.fillStyle = "#bfe0f2"; ctx.fillText("Väntar på att värden startar nästa nivå…", CW / 2, CH - 60); }
    ctx.globalAlpha = 1;
  }
  function drawQuitBtn(v) {
    if (!authoritative || !(v.phase === Phase.PLAY || v.phase === Phase.INTRO || v.phase === Phase.CLEARED)) return;
    const b = QUIT_BTN, arming = quitArmedUntil > performance.now();
    ctx.fillStyle = arming ? "rgba(229,72,77,0.92)" : "rgba(255,255,255,0.10)";
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(b.x, b.y, b.w, b.h, 12) : ctx.rect(b.x, b.y, b.w, b.h); ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.28)"; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = "#fff"; ctx.font = "700 12px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(arming ? "Säker? Tryck igen" : "Avsluta spelet", b.x + b.w / 2, b.y + b.h / 2); ctx.textBaseline = "alphabetic";
  }
  function drawEndScreen(lines, sub, v) {
    ctx.fillStyle = "rgba(4,20,30,0.76)"; ctx.fillRect(0, 0, CW, CH);
    ctx.textAlign = "center";
    let y = 78;
    ctx.fillStyle = "#eaf6ff"; ctx.font = "800 34px system-ui, sans-serif";
    for (const l of lines) { ctx.fillText(l, CW / 2, y); y += 40; }
    ctx.font = "500 18px system-ui, sans-serif"; ctx.fillStyle = "#bfe0f2"; ctx.fillText(sub, CW / 2, y); y += 34;
    y = drawStandings(v, y, 8) + 12;
    ctx.font = "800 18px system-ui, sans-serif"; ctx.fillStyle = "#f4571d"; ctx.fillText("🏆 Topplista", CW / 2, y); y += 26;
    const soloGame = (v.players || []).length <= 1;
    const b = (v.board || []).filter((e) => (e.n === 1) === soloGame); // solo runs compare with solo runs, teams with teams
    // Entries from before individual crediting worked have a total but all-zero players: show names only.
    const fmt = (e) => { const ps = e.players || []; const noSplit = ps.every((pp) => typeof pp === "string" || !pp.score); return ps.map((pp) => typeof pp === "string" ? pp : (noSplit ? pp.name : `${pp.name} ${pp.score}p`)).join(", "); };
    ctx.font = "600 15px system-ui, sans-serif"; ctx.fillStyle = "#eaf6ff";
    if (!b.length) { ctx.fillText("Inga resultat än", CW / 2, y); y += 22; }
    else b.slice(0, 3).forEach((e, i) => { ctx.fillText(`${i + 1}.  ${e.team || (e.n === 1 ? "Solo" : "Lag")} ${e.score} p  ·  ${fmt(e)}  (Nivå ${e.level})`, CW / 2, y); y += 22; });
    y += 18;
    if (authoritative) { drawActionButton("Till lobbyn", CW / 2 - 100, y - 4); drawLeaveButton(CW / 2 + 110, y - 4); }
    else { ctx.font = "600 16px system-ui, sans-serif"; ctx.fillStyle = "#bfe0f2"; ctx.fillText("Väntar på värden…", CW / 2, y); drawLeaveButton(CW / 2, y + 34); }
  }
  function drawMute() {
    ctx.font = "16px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(muted ? "🔇" : "🔊", MUTE_BTN.x, MUTE_BTN.y); ctx.textBaseline = "alphabetic";
  }

  return {
    CW, CH, DASH_BTN, MUTE_BTN, QUIT_BTN, fit, toWorld, fitBacking, render, water,
    actionBtn: () => ACTION_BTN, leaveBtn: () => LEAVE_BTN,
    // start of a frame: advance the animation clock; only the screens drawn this frame may be clickable
    beginFrame(dt) { waveT += dt; ACTION_BTN = null; LEAVE_BTN = null; fitBacking(); },
  };
}

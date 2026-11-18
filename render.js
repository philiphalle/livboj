// Livbojen — rendering: everything drawn on the canvas (water, shore, docks,
// swamps, whirlpools, swimmers, monsters, the livboj rings, beach and gulls),
// plus the HiDPI backing store. The HUD, buttons and screens are in hud.js.
//
// Draws a view (game.js currentView(): the sim's state for solo/host, the
// interpolated snapshot for a joiner); never changes game state.
//
// Sibling modules are imported with this module's own ?v=<build> (see boot.js):
// a plain `import … from "./sim.js"` would load a second, uncached copy.
const { shoreH, EAT_DWELL, shoreY, Phase, BASE_LEVELS, SKINS, HAIRS } = await import(`./sim.js${new URL(import.meta.url).search}`);
// the water (GPU layer under the canvas, or its 2D fallback): water.js
const { createWater, drawWater2D } = await import(`./water.js${new URL(import.meta.url).search}`);
const { createHud, uiFont } = await import(`./hud.js${new URL(import.meta.url).search}`);

const SUITS = ["#e5484d", "#3aa0ff", "#ffb020", "#8b5cf6", "#22c55e", "#ec4899"];
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
  // HUD, on-canvas buttons and the screens (hud.js); the button objects are laid out there every frame
  const hud = createHud(canvas, ctx, { CW, CH, mode, myName, netSummary, selfPos, live: ui.live,
    drawRing: (x, y, r, hue, glow) => drawLivboj(x, y, r, hue, glow, null, false, false),
    drawGauge: (g) => { ctx.save(); ctx.translate(g.x, g.y); ctx.scale(g.s, g.s); drawGaugeRing(g.R, g.frac, g.ch, g.t, true); ctx.restore(); },
    underlay: () => (glWater ? water.layer() : null) });
  // ---- Rendering ----------------------------------------------------------
  let waveT = 0;
  const water = createWater(canvas, CW, CH);
  let glWater = false; // this frame's water came from the GPU layer: skip the 2D shadows/ripples/wakes it draws
  let shoreLine = Infinity; // world y of the waterline this frame
  function fit(w, h) { const s = Math.min(CW / w, CH / h); return { s, ox: (CW - w * s) / 2, oy: (CH - h * s) / 2 }; }
  function toWorld(cx, cy, w, h) { const f = fit(w, h); return { x: (cx - f.ox) / f.s, y: (cy - f.oy) / f.s }; }
  function drawShore(w, h) {
    const y0 = shoreY({ w, h }), SH = shoreH({ w, h });
    const g = ctx.createLinearGradient(0, y0, 0, h);
    g.addColorStop(0, "#cdb583"); g.addColorStop(0.16, "#e7d4a4"); g.addColorStop(1, "#d6bd85");
    ctx.fillStyle = g; ctx.fillRect(0, y0, w, SH);
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
    for (let i = 0; i < 46; i++) { const sx = (i * 97) % w, sy = y0 + 12 + ((i * 53) % (SH - 14)); ctx.beginPath(); ctx.arc(sx, sy, 1, 0, Math.PI * 2); ctx.fill(); }
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
  // ---- Beach ---------------------------------------------------------------
  // Everything below the wet-sand band (drawShore owns the foam line and wet sand).
  // Props are spread along the beach at fixed fractions of the world width, at depths
  // drawn up for a 70-deep beach and scaled to this one (60 on the 2:1 worlds);
  // the corners stay low: the HUD's buttons sit there.
  function drawScenery(w, h) {
    const gy = shoreY({ w, h }), SH = shoreH({ w, h }), d = (y) => gy + y * SH / 70;
    drawSand(w, gy, SH);
    drawFootprints(w * 0.405, d(58), w * 0.58, d(30));
    drawTowel(w * 0.345, d(46), 54, 24, -0.08, ["#3aa0ff", "#f4f4f0"]);
    drawTowel(w * 0.69, d(48), 52, 23, 0.1, ["#ffb020", "#e5484d"]);
    drawShell(w * 0.385, d(24), 0.4, "#f6d7c3"); drawShell(w * 0.55, d(60), -0.3, "#f3e6cf"); drawShell(w * 0.74, d(25), 0.9, "#f6c9c0"); drawShell(w * 0.11, d(30), -0.6, "#f3e6cf");
    drawTower(w * 0.27, d(58)); // (right of the fullscreen button and its "F helskärm" chip)
    drawUmbrella(w * 0.8, d(58));
    drawBucket(w * 0.88, d(50));
    drawStarfish(w * 0.62, d(52));
    drawBeachBall(w * 0.495, d(47));
  }
  // sand grain and wind ripples, deterministic so nothing crawls
  function drawSand(w, gy, SH) {
    const top = gy + 20 * SH / 70, hh = SH - 22 * SH / 70;
    ctx.save(); ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(255,246,220,0.35)"; ctx.lineWidth = 1.2;
    const rows = lowFx ? 2 : 4;
    for (let r = 0; r < rows; r++) {
      const y = top + 8 + r * (hh - 10) / rows;
      for (let x = (r * 37) % 60; x < w; x += 90 + (r * 13) % 40) { ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + 14, y - 3, x + 30, y + 0.5); ctx.stroke(); }
    }
    ctx.strokeStyle = "rgba(150,115,60,0.16)";
    for (let r = 0; r < rows; r++) {
      const y = top + 9.5 + r * (hh - 10) / rows;
      for (let x = (r * 37) % 60; x < w; x += 90 + (r * 13) % 40) { ctx.beginPath(); ctx.moveTo(x + 2, y); ctx.quadraticCurveTo(x + 15, y - 2, x + 30, y + 1.5); ctx.stroke(); }
    }
    const n = lowFx ? Math.round(w / 9) : Math.round(w / 4);
    for (let i = 0; i < n; i++) {
      const sx = (i * 73.13) % w, sy = top + ((i * 41.7) % hh), k = i % 4;
      ctx.fillStyle = k === 0 ? "rgba(255,250,235,0.55)" : k === 1 ? "rgba(140,105,55,0.28)" : k === 2 ? "rgba(190,150,95,0.30)" : "rgba(110,90,70,0.22)";
      ctx.fillRect(sx, sy, k === 0 ? 1.4 : 1.1, k === 0 ? 1.4 : 1.1);
    }
    ctx.restore();
  }
  function drawFootprints(x0, y0, x1, y1) {
    const n = 7, dx = (x1 - x0) / n, dy = (y1 - y0) / n, a = Math.atan2(dy, dx);
    ctx.save(); ctx.fillStyle = "rgba(130,98,55,0.22)";
    for (let i = 0; i < n; i++) {
      const side = i % 2 ? 1 : -1, px = x0 + dx * i - Math.sin(a) * side * 3.2, py = y0 + dy * i + Math.cos(a) * side * 3.2;
      ctx.save(); ctx.translate(px, py); ctx.rotate(a);
      ctx.beginPath(); ctx.ellipse(0, 0, 3.4, 1.7, 0, 0, Math.PI * 2); ctx.fill(); // sole
      ctx.beginPath(); ctx.ellipse(-4.6, 0, 1.6, 1.4, 0, 0, Math.PI * 2); ctx.fill(); // heel
      ctx.restore();
    }
    ctx.restore();
  }
  function drawTowel(cx, cy, tw, th, rot, [c0, c1]) {
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(rot);
    ctx.fillStyle = "rgba(90,60,25,0.18)"; ctx.beginPath(); ctx.roundRect(-tw / 2 + 2, -th / 2 + 3, tw, th, 3); ctx.fill();
    ctx.beginPath(); ctx.roundRect(-tw / 2, -th / 2, tw, th, 3); ctx.save(); ctx.clip();
    ctx.fillStyle = c1; ctx.fillRect(-tw / 2, -th / 2, tw, th);
    ctx.fillStyle = c0; for (let k = 0; k < 5; k += 2) ctx.fillRect(-tw / 2 + k * tw / 5, -th / 2, tw / 5, th);
    const sh = ctx.createLinearGradient(0, -th / 2, 0, th / 2); sh.addColorStop(0, "rgba(255,255,255,0.18)"); sh.addColorStop(1, "rgba(0,0,0,0.12)"); ctx.fillStyle = sh; ctx.fillRect(-tw / 2, -th / 2, tw, th);
    ctx.fillStyle = "rgba(0,0,0,0.10)"; ctx.fillRect(-tw / 2, th * 0.18, tw, 2.5); // a fold
    ctx.restore();
    ctx.strokeStyle = "rgba(45,26,10,0.30)"; ctx.lineWidth = 1; ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.75)"; ctx.lineWidth = 1; // fringe
    for (const ex of [-tw / 2, tw / 2]) for (let k = 1; k < 6; k++) { const yy = -th / 2 + k * th / 6, d = ex < 0 ? -3 : 3; ctx.beginPath(); ctx.moveTo(ex, yy); ctx.lineTo(ex + d, yy + 0.5); ctx.stroke(); }
    ctx.restore();
  }
  function drawShell(x, y, rot, col) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    ctx.fillStyle = "rgba(90,60,25,0.18)"; ctx.beginPath(); ctx.ellipse(1, 1.5, 4.5, 3.2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(0, 3); ctx.arc(0, 3, 5.2, Math.PI * 1.12, Math.PI * 1.88); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "rgba(160,100,80,0.55)"; ctx.lineWidth = 0.7;
    for (let k = -2; k <= 2; k++) { const a = -Math.PI / 2 + k * 0.28; ctx.beginPath(); ctx.moveTo(0, 3); ctx.lineTo(Math.cos(a) * 5, 3 + Math.sin(a) * 5); ctx.stroke(); }
    ctx.fillStyle = col; ctx.fillRect(-1.6, 2.2, 3.2, 1.8);
    ctx.restore();
  }
  function drawTower(bx, baseY) {
    const cabW = 50, cabH = 34, legH = 32, cy = baseY - legH - cabH, side = 9;
    const OUT = "rgba(45,26,10,0.5)";
    // shadow on the sand, cast down-right
    ctx.fillStyle = "rgba(90,60,25,0.22)"; ctx.beginPath();
    ctx.moveTo(bx - cabW * 0.45, baseY); ctx.lineTo(bx + cabW * 0.55, baseY); ctx.lineTo(bx + cabW * 0.55 + 26, baseY - 7); ctx.lineTo(bx - cabW * 0.45 + 26, baseY - 7); ctx.closePath(); ctx.fill();
    // back legs, ladder, front legs + braces
    ctx.lineCap = "round";
    ctx.strokeStyle = "#6e4420"; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(bx - cabW * 0.32 + side, baseY - 4); ctx.lineTo(bx - cabW * 0.28 + side, baseY - legH); ctx.moveTo(bx + cabW * 0.36 + side, baseY - 4); ctx.lineTo(bx + cabW * 0.3 + side, baseY - legH); ctx.stroke();
    ctx.strokeStyle = "#9a6331"; ctx.lineWidth = 2.2; // ladder
    ctx.beginPath(); ctx.moveTo(bx - 6, baseY + 2); ctx.lineTo(bx - 4, baseY - legH); ctx.moveTo(bx + 6, baseY + 2); ctx.lineTo(bx + 4, baseY - legH); ctx.stroke();
    ctx.lineWidth = 1.6; for (let k = 1; k <= 4; k++) { const yy = baseY - k * legH / 5; ctx.beginPath(); ctx.moveTo(bx - 5.5 + k * 0.4, yy); ctx.lineTo(bx + 5.5 - k * 0.4, yy); ctx.stroke(); }
    ctx.strokeStyle = "#8a5a2b"; ctx.lineWidth = 4.5;
    ctx.beginPath(); ctx.moveTo(bx - cabW * 0.44, baseY); ctx.lineTo(bx - cabW * 0.34, baseY - legH); ctx.moveTo(bx + cabW * 0.44, baseY); ctx.lineTo(bx + cabW * 0.34, baseY - legH); ctx.stroke();
    ctx.lineWidth = 2.6; ctx.beginPath(); ctx.moveTo(bx - cabW * 0.42, baseY - 6); ctx.lineTo(bx + cabW * 0.38, baseY - legH + 4); ctx.moveTo(bx + cabW * 0.42, baseY - 6); ctx.lineTo(bx - cabW * 0.38, baseY - legH + 4); ctx.stroke();
    ctx.lineCap = "butt";
    // deck under the cabin
    ctx.fillStyle = "#7a4c22"; ctx.fillRect(bx - cabW / 2 - 4, baseY - legH - 4, cabW + 8 + side, 5);
    // cabin: side face (shade), front face with planks
    ctx.fillStyle = "#a96f38"; ctx.beginPath(); ctx.moveTo(bx + cabW / 2, cy); ctx.lineTo(bx + cabW / 2 + side, cy - 5); ctx.lineTo(bx + cabW / 2 + side, cy + cabH - 5); ctx.lineTo(bx + cabW / 2, cy + cabH); ctx.closePath(); ctx.fill();
    const fg = ctx.createLinearGradient(bx - cabW / 2, 0, bx + cabW / 2, 0); fg.addColorStop(0, "#e2a865"); fg.addColorStop(1, "#c98a4a");
    ctx.fillStyle = fg; ctx.fillRect(bx - cabW / 2, cy, cabW, cabH);
    ctx.strokeStyle = "rgba(110,60,20,0.35)"; ctx.lineWidth = 1; for (let k = 1; k < 5; k++) { const yy = cy + k * cabH / 5; ctx.beginPath(); ctx.moveTo(bx - cabW / 2, yy); ctx.lineTo(bx + cabW / 2, yy); ctx.stroke(); }
    // window with a lifeguard looking out
    const wx = bx - cabW * 0.36, wy = cy + 4, ww = cabW * 0.72, wh = cabH * 0.42;
    ctx.fillStyle = "#123e56"; ctx.fillRect(wx, wy, ww, wh);
    ctx.fillStyle = "#f2c39b"; ctx.beginPath(); ctx.arc(bx + 6, wy + wh * 0.62, 4.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#e5484d"; ctx.beginPath(); ctx.arc(bx + 6, wy + wh * 0.5, 4.4, Math.PI, Math.PI * 2); ctx.fill(); // red cap
    ctx.fillStyle = "#e5484d"; ctx.fillRect(bx + 1, wy + wh - 2.5, 10, 2.5);
    ctx.fillStyle = "rgba(190,230,250,0.35)"; ctx.beginPath(); ctx.moveTo(wx + 3, wy + wh); ctx.lineTo(wx + 10, wy); ctx.lineTo(wx + 15, wy); ctx.lineTo(wx + 8, wy + wh); ctx.closePath(); ctx.fill(); // glint
    ctx.strokeStyle = "#f4f4f0"; ctx.lineWidth = 1.6; ctx.strokeRect(wx, wy, ww, wh);
    // red-cross panel and a small life ring hanging on the front
    ctx.fillStyle = "#e5484d"; ctx.fillRect(bx - cabW * 0.4, cy + cabH * 0.6, 14, 11);
    ctx.fillStyle = "#fff"; ctx.fillRect(bx - cabW * 0.4 + 5.5, cy + cabH * 0.6 + 2, 3, 7); ctx.fillRect(bx - cabW * 0.4 + 3, cy + cabH * 0.6 + 4, 8, 3);
    const rx = bx + cabW * 0.22, ry = cy + cabH * 0.76, rr = 6.5;
    ctx.beginPath(); ctx.arc(rx, ry, rr, 0, Math.PI * 2); ctx.arc(rx, ry, rr * 0.5, 0, Math.PI * 2, true); ctx.fillStyle = "#ef5a1f"; ctx.fill("evenodd");
    ctx.fillStyle = "#f7f3e8"; for (let i = 0; i < 4; i++) { const a = Math.PI / 4 + i * Math.PI / 2; ctx.beginPath(); ctx.arc(rx, ry, rr, a - 0.35, a + 0.35); ctx.arc(rx, ry, rr * 0.5, a + 0.35, a - 0.35, true); ctx.closePath(); ctx.fill(); }
    ctx.strokeStyle = "rgba(60,20,0,0.5)"; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.arc(rx, ry, rr, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = OUT; ctx.lineWidth = 1.6; ctx.lineJoin = "round"; ctx.strokeRect(bx - cabW / 2, cy, cabW, cabH);
    // roof: front slope + side, overhanging, with a lit edge
    ctx.fillStyle = "#b8343a"; ctx.beginPath(); ctx.moveTo(bx + cabW * 0.62, cy); ctx.lineTo(bx + cabW * 0.62 + side, cy - 5); ctx.lineTo(bx + side * 0.6, cy - 21); ctx.lineTo(bx, cy - 17); ctx.closePath(); ctx.fill();
    const rg = ctx.createLinearGradient(0, cy - 17, 0, cy); rg.addColorStop(0, "#ff6a5c"); rg.addColorStop(1, "#e0393f");
    ctx.fillStyle = rg; ctx.beginPath(); ctx.moveTo(bx - cabW * 0.64, cy + 1); ctx.lineTo(bx, cy - 17); ctx.lineTo(bx + cabW * 0.64, cy + 1); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = OUT; ctx.lineWidth = 1.6; ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.45)"; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(bx - cabW * 0.58, cy - 1); ctx.lineTo(bx - 2, cy - 15); ctx.stroke();
    // flag on a pole, waving
    const px = bx + 2, ptop = cy - 46;
    ctx.strokeStyle = "#5e3a1c"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(px, cy - 17); ctx.lineTo(px, ptop); ctx.stroke();
    ctx.fillStyle = "#ffd84d"; ctx.beginPath(); ctx.arc(px, ptop - 1, 1.8, 0, Math.PI * 2); ctx.fill();
    const f1 = Math.sin(waveT * 4) * 2.5, f2 = Math.sin(waveT * 4 + 1.2) * 2.5;
    ctx.fillStyle = "#ffb020"; ctx.beginPath(); ctx.moveTo(px, ptop + 1); ctx.quadraticCurveTo(px + 9, ptop - 1 + f1, px + 19, ptop + 2 + f2); ctx.lineTo(px + 19, ptop + 11 + f2); ctx.quadraticCurveTo(px + 9, ptop + 9 + f1, px, ptop + 12); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#e5484d"; ctx.beginPath(); ctx.moveTo(px, ptop + 6.5); ctx.quadraticCurveTo(px + 9, ptop + 4 + f1, px + 19, ptop + 6.5 + f2); ctx.lineTo(px + 19, ptop + 11 + f2); ctx.quadraticCurveTo(px + 9, ptop + 9 + f1, px, ptop + 12); ctx.closePath(); ctx.fill();
  }
  function drawUmbrella(bx, baseY) {
    const sway = Math.sin(waveT * 1.3) * 0.025, R = 36;
    // shadow of the canopy on the sand (cast down-right) and a towel beneath
    ctx.fillStyle = "rgba(90,60,25,0.20)"; ctx.beginPath(); ctx.ellipse(bx + 16, baseY - 4, R * 0.95, 9, 0, 0, Math.PI * 2); ctx.fill();
    drawTowel(bx + 4, baseY - 8, 46, 20, -0.05, ["#22c55e", "#f4f4f0"]);
    ctx.save(); ctx.translate(bx, baseY); ctx.rotate(-0.12 + sway);
    const topY = -60;
    ctx.strokeStyle = "#6b4424"; ctx.lineWidth = 3.2; ctx.beginPath(); ctx.moveTo(0, 2); ctx.lineTo(0, topY + 14); ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(-0.8, 0); ctx.lineTo(-0.8, topY + 14); ctx.stroke();
    // canopy: a dome seen a little from above, in eight alternating gores (front half visible),
    // shaded across, with a scalloped hem
    const H = 24, hemY = topY + 18, tilt = 7, N = 8, cols = ["#e5484d", "#f6f2e8"];
    const pt = (phi, th) => [R * Math.cos(th) * Math.cos(phi), hemY - H * Math.sin(th) + tilt * Math.sin(phi) * Math.cos(th)];
    ctx.fillStyle = "#a83238"; ctx.beginPath(); ctx.ellipse(0, hemY, R, tilt, 0, Math.PI, Math.PI * 2); ctx.fill(); // underside at the back
    for (let k = 0; k < N; k++) {
      const p0 = Math.PI - k * Math.PI / N, p1 = p0 - Math.PI / N, base = cols[k % 2];
      const lit = 0.78 + 0.34 * Math.max(0, Math.cos(p0 - Math.PI * 0.72)); // light from the upper left
      const g = ctx.createLinearGradient(0, hemY - H, 0, hemY + tilt); g.addColorStop(0, shadeHex(base, Math.min(1.25, lit * 1.12))); g.addColorStop(1, shadeHex(base, lit * 0.86));
      ctx.fillStyle = g; ctx.beginPath();
      for (let i = 0; i <= 8; i++) { const [x, y] = pt(p0, i / 8 * Math.PI / 2); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      for (let i = 8; i >= 0; i--) { const [x, y] = pt(p1, i / 8 * Math.PI / 2); ctx.lineTo(x, y); }
      const [hx0, hy0] = pt(p0, 0), [hx1, hy1] = pt(p1, 0); ctx.lineTo(hx1, hy1);
      ctx.quadraticCurveTo((hx0 + hx1) / 2, (hy0 + hy1) / 2 + 5, hx0, hy0); ctx.closePath(); ctx.fill(); // scallop
    }
    ctx.strokeStyle = "rgba(45,26,10,0.42)"; ctx.lineWidth = 1.4; ctx.lineJoin = "round";
    ctx.beginPath(); for (let i = 0; i <= 24; i++) { const [x, y] = pt(Math.PI, i / 24 * Math.PI); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.stroke(); // outline over the top
    ctx.fillStyle = "rgba(255,255,255,0.30)"; ctx.beginPath(); ctx.ellipse(-R * 0.38, hemY - H * 0.72, R * 0.22, 3.2, -0.45, 0, Math.PI * 2); ctx.fill();
    const topY2 = hemY - H;
    ctx.fillStyle = "#6b4424"; ctx.beginPath(); ctx.arc(0, topY2 - 1.5, 2.6, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  function drawBucket(x, y) {
    ctx.fillStyle = "rgba(90,60,25,0.2)"; ctx.beginPath(); ctx.ellipse(x + 4, y + 7, 10, 3.5, 0, 0, Math.PI * 2); ctx.fill();
    // spade stuck in the sand
    ctx.save(); ctx.translate(x + 12, y + 4); ctx.rotate(0.35);
    ctx.fillStyle = "#3aa0ff"; ctx.beginPath(); ctx.moveTo(-3.5, 0); ctx.lineTo(3.5, 0); ctx.lineTo(2.5, 6); ctx.lineTo(-2.5, 6); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "#ffb020"; ctx.lineWidth = 2; ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -14); ctx.stroke(); ctx.beginPath(); ctx.moveTo(-3, -14); ctx.lineTo(3, -14); ctx.stroke(); ctx.lineCap = "butt";
    ctx.restore();
    const g = ctx.createLinearGradient(x - 8, 0, x + 8, 0); g.addColorStop(0, "#ffd84d"); g.addColorStop(1, "#e5a417");
    ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(x - 8, y - 10); ctx.lineTo(x + 8, y - 10); ctx.lineTo(x + 6, y + 6); ctx.lineTo(x - 6, y + 6); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "rgba(45,26,10,0.42)"; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.fillStyle = "#c98a12"; ctx.beginPath(); ctx.ellipse(x, y - 10, 8, 2.2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(45,26,10,0.5)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y - 8, 7, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke(); // handle
    ctx.fillStyle = "rgba(255,255,255,0.35)"; ctx.fillRect(x - 5.5, y - 7, 2, 11);
  }
  function drawBeachBall(bx, by) {
    const r = 11, roll = Math.sin(waveT * 0.7) * 0.25;
    ctx.fillStyle = "rgba(90,60,25,0.25)"; ctx.beginPath(); ctx.ellipse(bx + 4, by + r * 0.8, r * 1.05, r * 0.38, 0, 0, Math.PI * 2); ctx.fill();
    ctx.save(); ctx.translate(bx, by); ctx.rotate(roll);
    ctx.fillStyle = "#f8f6f0"; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
    const cols = ["#e5484d", "#ffb020", "#3aa0ff"];
    for (let k = 0; k < 3; k++) { const a = k * 2 * Math.PI / 3; ctx.fillStyle = cols[k]; ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, r, a, a + Math.PI / 3); ctx.closePath(); ctx.fill(); }
    ctx.restore();
    const g = ctx.createRadialGradient(bx - r * 0.35, by - r * 0.4, r * 0.1, bx, by, r * 1.05);
    g.addColorStop(0, "rgba(255,255,255,0.45)"); g.addColorStop(0.5, "rgba(255,255,255,0)"); g.addColorStop(1, "rgba(40,20,0,0.35)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#f8f6f0"; ctx.beginPath(); ctx.arc(bx, by, 2.2, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(45,26,10,0.42)"; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.8)"; ctx.beginPath(); ctx.ellipse(bx - r * 0.42, by - r * 0.45, r * 0.22, r * 0.12, -0.7, 0, Math.PI * 2); ctx.fill();
  }
  function drawStarfish(bx, by) {
    const R = 12, r0 = 4.6;
    ctx.save(); ctx.translate(bx, by); ctx.rotate(0.2);
    const arms = () => { ctx.beginPath(); for (let k = 0; k < 5; k++) { const a = -Math.PI / 2 + k * 2 * Math.PI / 5, a2 = a + Math.PI / 5; const tip = [Math.cos(a) * R, Math.sin(a) * R]; if (k === 0) ctx.moveTo(Math.cos(a - Math.PI / 5) * r0, Math.sin(a - Math.PI / 5) * r0); ctx.quadraticCurveTo(Math.cos(a - 0.12) * R * 0.75, Math.sin(a - 0.12) * R * 0.75, tip[0], tip[1]); ctx.quadraticCurveTo(Math.cos(a + 0.12) * R * 0.75, Math.sin(a + 0.12) * R * 0.75, Math.cos(a2) * r0, Math.sin(a2) * r0); } ctx.closePath(); };
    ctx.save(); ctx.translate(2, 2.5); arms(); ctx.fillStyle = "rgba(90,60,25,0.22)"; ctx.fill(); ctx.restore();
    const g = ctx.createRadialGradient(-2, -3, 1, 0, 0, R); g.addColorStop(0, "#ffb27a"); g.addColorStop(0.6, "#f2884b"); g.addColorStop(1, "#d8622c");
    arms(); ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = "rgba(120,50,15,0.55)"; ctx.lineWidth = 1.1; ctx.lineJoin = "round"; ctx.stroke();
    ctx.fillStyle = "rgba(255,235,210,0.85)";
    for (let k = 0; k < 5; k++) { const a = -Math.PI / 2 + k * 2 * Math.PI / 5; for (const f of [0.35, 0.58, 0.8]) { ctx.beginPath(); ctx.arc(Math.cos(a) * R * f, Math.sin(a) * R * f, 0.85 - f * 0.4, 0, Math.PI * 2); ctx.fill(); } }
    ctx.restore();
  }
  // ---- Seagulls: two calm gulls seen from above — one soaring in slow circles off the left edge, one
  // gliding along the surf line — so they stay out of the middle (the whirlpool, the players). Bent "M"
  // wings with black tips, a yellow beak; mostly gliding, now and then a few slow beats; a faint shadow
  // on the water far below. lowFx: one gull, no shadow.
  function drawSeagulls(w, h, shore, t) {
    for (let i = 0; i < (lowFx ? 1 : 2); i++) {
      let x, y, ang;
      if (i === 0) { // the shore glider: left to right along the foam, a gentle rise and fall
        const span = w + 200, sp = 21; x = ((t * sp) % span + span) % span - 100;
        y = shore - 24 + Math.sin(t * 0.37) * 12; ang = Math.atan2(Math.cos(t * 0.37) * 12 * 0.37, sp);
      } else { // the soarer: a slow wide circle, half of it beyond the left edge
        const th = t * 0.21 + 2, cx = w * 0.03, cy = h * 0.48, R = Math.min(90, h * 0.14);
        x = cx + Math.cos(th) * R; y = cy + Math.sin(th) * R * 0.8; ang = Math.atan2(Math.cos(th) * 0.8, -Math.sin(th)) ;
      }
      const ph = i * 0.47, cyc = (t * 0.16 + ph) % 1; // flap for about a fifth of the time, then glide
      const env = cyc < 0.2 ? Math.sin(cyc / 0.2 * Math.PI) : 0, flap = Math.sin(t * 6.5 + i * 2) * env;
      const s = i === 0 ? 0.95 : 1.05;
      if (!lowFx) drawGull(x + 16, y + 30, ang, flap, s * 0.92, true);
      drawGull(x, y, ang, flap, s, false);
    }
  }
  function drawGull(x, y, ang, flap, s, shadow) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(ang); ctx.scale(s, s);
    // a wing beat seen from above: the span shortens at the top and bottom of the stroke,
    // the wrist bends forward more while gliding (the "M"), the hand sweeps back
    const k = 1 - Math.abs(flap), span = 15 * (0.62 + 0.38 * k), wx = 3.2 + 1.2 * k, wy = span * 0.44, tx = -5.5 - 2.5 * (1 - k), ty = span;
    const wing = (sd) => {
      ctx.beginPath(); ctx.moveTo(2.4, sd * 1.6);
      ctx.quadraticCurveTo(3.4, sd * wy * 0.5, wx, sd * wy);            // leading edge to the wrist
      ctx.quadraticCurveTo(wx - 2.6, sd * (wy + span * 0.32), tx, sd * ty); // the hand, swept back to the tip
      ctx.quadraticCurveTo(tx + 1.5, sd * span * 0.7, wx - 4.6, sd * wy * 1.02); // trailing edge of the hand
      ctx.quadraticCurveTo(-1.8, sd * wy * 0.62, -3.6, sd * 1.6);         // trailing edge of the arm
      ctx.closePath();
    };
    if (shadow) {
      ctx.fillStyle = "rgba(3,22,36,0.11)"; wing(-1); ctx.fill(); wing(1); ctx.fill();
      ctx.beginPath(); ctx.ellipse(0, 0, 7, 2.2, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore(); return;
    }
    ctx.lineJoin = "round";
    for (const sd of [-1, 1]) {
      wing(sd);
      const g = ctx.createLinearGradient(0, 0, 0, sd * span); g.addColorStop(0, "#c9d3dc"); g.addColorStop(0.5, "#b2bfca"); g.addColorStop(1, "#9eacb8");
      ctx.fillStyle = g; ctx.fill();
      ctx.save(); ctx.clip();
      // white trailing edge along the arm, black primaries at the tip with a white mirror spot
      ctx.strokeStyle = "rgba(255,255,255,0.75)"; ctx.lineWidth = 1.3; ctx.beginPath(); ctx.moveTo(-3.6, sd * 1.8); ctx.quadraticCurveTo(-1.8, sd * wy * 0.62, wx - 4.6, sd * wy * 1.02); ctx.stroke();
      ctx.fillStyle = "#24272c"; ctx.beginPath();
      const bx = wx + (tx - wx) * 0.5, by = wy + (ty - wy) * 0.5;
      ctx.moveTo(bx + 1.6, sd * (by - 0.2)); ctx.lineTo(tx - 2, sd * (ty + 1)); ctx.lineTo(bx - 3.2, sd * (by + 0.4)); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.beginPath(); ctx.arc(tx + 1.1, sd * (ty - 1.4), 0.7, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      wing(sd); ctx.strokeStyle = "rgba(40,55,70,0.45)"; ctx.lineWidth = 0.6; ctx.stroke();
    }
    // tail: a short white fan with a grey edge; body and head white, shaded on the far side
    ctx.fillStyle = "#eef2f5"; ctx.beginPath(); ctx.moveTo(-5, -2); ctx.lineTo(-9.6, -2.6); ctx.quadraticCurveTo(-10.4, 0, -9.6, 2.6); ctx.lineTo(-5, 2); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "rgba(60,75,90,0.4)"; ctx.lineWidth = 0.6; ctx.stroke();
    const bg = ctx.createLinearGradient(0, -2.6, 0, 2.6); bg.addColorStop(0, "#ffffff"); bg.addColorStop(1, "#d3dbe2");
    ctx.fillStyle = bg; ctx.beginPath(); ctx.ellipse(-0.6, 0, 6.6, 2.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(5.4, 0, 2.5, 2.2, 0, 0, Math.PI * 2); ctx.fill(); // head
    ctx.strokeStyle = "rgba(60,75,90,0.35)"; ctx.lineWidth = 0.6; ctx.beginPath(); ctx.ellipse(-0.6, 0, 6.6, 2.5, 0, 0.5, Math.PI * 2 - 0.5); ctx.stroke();
    ctx.fillStyle = "#f6c12b"; ctx.beginPath(); ctx.moveTo(7.4, -0.75); ctx.lineTo(10.2, -0.2); ctx.lineTo(10.2, 0.2); ctx.lineTo(7.4, 0.75); ctx.closePath(); ctx.fill(); // beak
    ctx.fillStyle = "#e5484d"; ctx.beginPath(); ctx.arc(9.3, 0.25, 0.4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#1c1c1c"; ctx.beginPath(); ctx.arc(6.1, -1.25, 0.45, 0, Math.PI * 2); ctx.arc(6.1, 1.25, 0.45, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  // ---- Swamps: algae and reed patches in the water, not islands ---------------------------------
  // A faint murky tint, irregular algae clumps with open-water channels between them (the water's
  // caustics and waves show through), duckweed drifted against the slow zone's edge: painted once per
  // swamp and backing-store scale into an offscreen canvas. Lily pads, flowers, reeds and bubbles —
  // the "slow here" cue — move live.
  const swampCache = new Map();
  function swampShape(z) {
    const cx = z.x + z.w / 2, cy = z.y + z.h / 2, rx = z.w / 2, ry = z.h / 2, seed = z.x * 0.03 + z.y * 0.07;
    const rad = (a) => 1 + 0.07 * Math.sin(a * 3 + seed) + 0.05 * Math.sin(a * 5 + seed * 1.3) + 0.03 * Math.sin(a * 8 - seed);
    // value noise (smooth, deterministic per swamp): where the algae grows and where open water stays
    const hash = (i, j) => { const v = Math.sin(i * 127.1 + j * 311.7 + seed * 17.3) * 43758.5453; return v - Math.floor(v); };
    const vn = (x, y) => { const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j, ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
      return (hash(i, j) * (1 - ux) + hash(i + 1, j) * ux) * (1 - uy) + (hash(i, j + 1) * (1 - ux) + hash(i + 1, j + 1) * ux) * uy; };
    const sm = (e0, e1, x) => { const k = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return k * k * (3 - 2 * k); };
    // the slow zone (sim.js inSwamp) is this ellipse out to r ≈ 1.04: the plants keep to it, with a gently uneven edge
    const R = (x, y) => Math.hypot((x - cx) / rx, (y - cy) / ry);
    const edge = (x, y) => { const a = Math.atan2((y - cy) / ry, (x - cx) / rx); return 1.03 + 0.025 * Math.sin(a * 5 + seed) + 0.02 * Math.sin(a * 9 - seed * 2); };
    const grow = (x, y) => 0.62 * vn(x / 34, y / 34) + 0.38 * vn(x / 13 + 40, y / 13); // clumps and channels
    return { cx, cy, rx, ry, seed, rad, R, edge, grow, sm };
  }
  function swampBase(z, scale) {
    const key = `${z.x | 0},${z.y | 0},${z.w | 0},${z.h | 0},${scale.toFixed(2)}`;
    let c = swampCache.get(key);
    if (c) return c;
    if (swampCache.size > 12) swampCache.clear();
    const { cx, cy, rx, ry, seed, R, edge, grow, sm } = swampShape(z), M = 26;
    const cv = document.createElement("canvas"); cv.width = Math.ceil((z.w + M * 2) * scale); cv.height = Math.ceil((z.h + M * 2) * scale);
    const g = cv.getContext("2d"); g.scale(scale, scale); g.translate(M - z.x, M - z.y);
    let s = Math.abs(Math.round(seed * 1000)) + 7; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    // 1. a faint murky tint — the water stays water: its caustics and waves show through
    //    over the whole zone, with a soft but definite edge where the slow water ends
    const tint = g.createRadialGradient(0, 0, 0, 0, 0, 1);
    tint.addColorStop(0, "rgba(40,66,32,0.26)"); tint.addColorStop(0.8, "rgba(52,82,38,0.22)"); tint.addColorStop(0.93, "rgba(62,94,42,0.2)"); tint.addColorStop(1, "rgba(66,98,44,0)");
    g.save(); g.translate(cx, cy); g.scale(rx * 1.07, ry * 1.07); g.fillStyle = tint; g.beginPath(); g.arc(0, 0, 1, 0, Math.PI * 2); g.fill(); g.restore();
    // 2. algae clumps: soft overlapping blobs where the growth noise is high (open-water channels between), thinning toward the edge
    const step = 5.5;
    for (let y = cy - ry * 1.1; y <= cy + ry * 1.1; y += step) for (let x = cx - rx * 1.1; x <= cx + rx * 1.1; x += step) {
      const jx = x + (rnd() - 0.5) * step, jy = y + (rnd() - 0.5) * step, r = R(jx, jy), e = edge(jx, jy);
      const dens = sm(0.42, 0.66, grow(jx, jy)) * (1 - sm(e - 0.22, e - 0.02, r));
      if (dens < 0.06 || rnd() > 0.35 + 0.65 * dens) continue;
      const br = rnd(), col = br < 0.25 ? "34,62,30" : br < 0.7 ? "74,112,46" : "118,150,62", rad = 3 + rnd() * 5 * (0.5 + dens);
      const rg = g.createRadialGradient(jx, jy, 0, jx, jy, rad); rg.addColorStop(0, `rgba(${col},${0.22 + 0.22 * dens})`); rg.addColorStop(1, `rgba(${col},0)`);
      g.fillStyle = rg; g.fillRect(jx - rad, jy - rad, rad * 2, rad * 2);
    }
    // 2b. algae drifted against the edge: a broken, uneven band of small clumps just inside it (never a drawn line)
    for (let i = 0; i < 240; i++) {
      const a = rnd() * Math.PI * 2, ex = cx + Math.cos(a) * rx, ey = cy + Math.sin(a) * ry, e = edge(ex, ey), f = e - 0.03 - rnd() * rnd() * 0.12;
      const gate = sm(0.3, 0.58, grow(cx + Math.cos(a) * rx * 2.6, cy + Math.sin(a) * ry * 2.6));
      if (rnd() > gate) continue;
      const x = cx + Math.cos(a) * rx * f, y = cy + Math.sin(a) * ry * f, rad = 2.5 + rnd() * 4.5, col = rnd() < 0.5 ? "84,122,48" : "112,148,60";
      const rg = g.createRadialGradient(x, y, 0, x, y, rad); rg.addColorStop(0, `rgba(${col},0.42)`); rg.addColorStop(1, `rgba(${col},0)`);
      g.fillStyle = rg; g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    // 3. duckweed: tiny bright specks on the clumps, and a broken scatter drifted up against the zone's edge
    //    (so the edge of the slow zone reads, without a drawn outline)
    for (let i = 0; i < 2200; i++) {
      const a = rnd() * Math.PI * 2, f = Math.sqrt(rnd()) * 1.06, x = cx + Math.cos(a) * rx * f, y = cy + Math.sin(a) * ry * f, r = R(x, y), e = edge(x, y);
      const onClump = sm(0.4, 0.62, grow(x, y)) * (1 - sm(e - 0.1, e, r)), d = r - (e - 0.05);
      const rim = r < e + 0.01 ? Math.exp(-d * d / 0.003) * sm(0.3, 0.58, grow(cx + Math.cos(a) * rx * 2.6, cy + Math.sin(a) * ry * 2.6)) : 0;
      if (rnd() > 0.12 + 0.88 * Math.max(onClump * 0.8, rim)) continue;
      g.fillStyle = `rgba(${i % 4 ? "164,202,88" : "212,232,126"},${0.3 + rnd() * 0.45})`; g.beginPath(); g.arc(x, y, 0.5 + rnd() * rnd() * 1.5, 0, Math.PI * 2); g.fill();
    }
    // 4. a few floating filaments (scum strands) on the thicker clumps
    g.strokeStyle = "rgba(170,196,100,0.22)"; g.lineCap = "round";
    for (let i = 0, n = 0; i < 40 && n < 8; i++) {
      const a = rnd() * Math.PI * 2, f = rnd() * 0.7, x = cx + Math.cos(a) * rx * f, y = cy + Math.sin(a) * ry * f;
      if (grow(x, y) < 0.55) continue; n++;
      const L = 10 + rnd() * 18, an = rnd() * Math.PI; g.lineWidth = 1.2 + rnd() * 1.8;
      g.save(); g.translate(x, y); g.rotate(an); g.beginPath(); g.moveTo(-L, 0); g.bezierCurveTo(-L / 3, -4, L / 3, 4, L, -1); g.stroke(); g.restore();
    }
    c = { cv, x: z.x - M, y: z.y - M, w: z.w + M * 2, h: z.h + M * 2 };
    swampCache.set(key, c);
    return c;
  }
  function drawSwamp(z) {
    const tr = ctx.getTransform ? ctx.getTransform() : { a: 1 }, scale = Math.max(0.5, Math.min(4, Math.abs(tr.a)));
    const base = swampBase(z, scale);
    ctx.drawImage(base.cv, base.x, base.y, base.w, base.h);
    const { cx, cy, rx, ry, seed } = swampShape(z), t = waveT;
    // a few bubbles rising from the murk
    if (!lowFx) {
      ctx.strokeStyle = "rgba(220,240,200,0.55)"; ctx.lineWidth = 0.9;
      for (let i = 0; i < 4; i++) { const p = ((t * 0.25 + i * 0.27 + seed) % 1 + 1) % 1, a = seed * 2 + i * 1.9, f = 0.25 + (i % 3) * 0.15; ctx.globalAlpha = Math.sin(p * Math.PI); ctx.beginPath(); ctx.arc(cx + Math.cos(a) * rx * f, cy + Math.sin(a) * ry * f, 1.2 + p * 2.2, 0, Math.PI * 2); ctx.stroke(); }
      ctx.globalAlpha = 1;
    }
    // lily pads: shaded, notched, veined; some carry a water lily
    const nPad = Math.max(6, Math.round((z.w * z.h) / 6500));
    for (let i = 0; i < nPad; i++) {
      const a = seed * 0.7 + i * 2.4, f = 0.22 + ((i * 37) % 62) / 100, px = cx + Math.cos(a) * rx * f, py0 = cy + Math.sin(a) * ry * f;
      const r = 7 + (i % 3) * 2.6, wob = Math.sin(t * 1.1 + i) * 1.2, py = py0 + wob, rot = i * 1.3 + Math.sin(t * 0.6 + i) * 0.08;
      drawLilyPad(px, py, r, rot, i);
      if (i % 3 === 0) drawLily(px + Math.cos(rot + 2.4) * r * 0.25, py + Math.sin(rot + 2.4) * r * 0.25, 4.2 + (i % 2), i % 6 === 0 ? "#ffffff" : "#ffb8d6", t + i);
    }
    // reed clumps on parts of the rim, swaying, with cattails
    const nClump = Math.max(3, Math.round((z.w + z.h) / 110));
    for (let c = 0; c < nClump; c++) {
      const a = seed + c * (Math.PI * 2 / nClump) + Math.sin(c * 1.7) * 0.4, f = 0.86 + 0.06 * Math.sin(c * 2.3 + seed), bx = cx + Math.cos(a) * rx * f, by = cy + Math.sin(a) * ry * f;
      drawReeds(bx, by, c + Math.round(seed * 10), t);
    }
  }
  function drawLilyPad(x, y, r, rot, i) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    const notch = 0.38;
    const pad = () => { ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, r, notch, Math.PI * 2 - notch); ctx.closePath(); };
    ctx.save(); ctx.translate(1.2, 1.8); pad(); ctx.fillStyle = "rgba(10,30,20,0.30)"; ctx.fill(); ctx.restore(); // shadow on the water
    if (lowFx) { pad(); ctx.fillStyle = "#5f9e48"; ctx.fill(); ctx.restore(); return; }
    const g = ctx.createRadialGradient(-r * 0.35, -r * 0.35, r * 0.1, 0, 0, r); g.addColorStop(0, i % 2 ? "#a6d36a" : "#98cc63"); g.addColorStop(0.7, "#5f9e48"); g.addColorStop(1, "#3f7a35");
    pad(); ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = "rgba(30,70,30,0.55)"; ctx.lineWidth = 0.9; ctx.stroke();
    ctx.strokeStyle = "rgba(210,240,160,0.45)"; ctx.lineWidth = 0.7; // veins
    for (let k = 1; k < 7; k++) { const va = notch + k * (Math.PI * 2 - notch * 2) / 7; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(va) * r * 0.85, Math.sin(va) * r * 0.85); ctx.stroke(); }
    ctx.strokeStyle = "rgba(230,250,190,0.5)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(0, 0, r - 0.8, Math.PI * 1.05, Math.PI * 1.6); ctx.stroke(); // lit rim
    ctx.fillStyle = "rgba(255,255,255,0.65)"; ctx.beginPath(); ctx.arc(r * 0.35, r * 0.2, 0.9, 0, Math.PI * 2); ctx.fill(); // a water drop
    ctx.restore();
  }
  function drawLily(x, y, s, col, ph) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(ph * 0.05);
    const tip = col === "#ffffff" ? "#ffd3e6" : "#ff7fb4";
    for (const [n, len, wid, off, c] of [[8, s * 1.15, s * 0.42, 0, col], [6, s * 0.85, s * 0.36, 0.4, tip]]) {
      for (let k = 0; k < n; k++) {
        const a = off + k * Math.PI * 2 / n; ctx.save(); ctx.rotate(a);
        const g = ctx.createLinearGradient(0, 0, len, 0); g.addColorStop(0, "#fff6fb"); g.addColorStop(1, c);
        ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(len * 0.5, -wid, len, 0); ctx.quadraticCurveTo(len * 0.5, wid, 0, 0); ctx.fill();
        ctx.restore();
      }
    }
    ctx.fillStyle = "#ffcf3d"; ctx.beginPath(); ctx.arc(0, 0, s * 0.3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#e59a12"; for (let k = 0; k < 5; k++) { const a = k * 1.26; ctx.beginPath(); ctx.arc(Math.cos(a) * s * 0.17, Math.sin(a) * s * 0.17, 0.5, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }
  function drawReeds(bx, by, seed, t) {
    const n = lowFx ? 3 : 6, rnd = (k) => { const v = Math.sin(seed * 91.7 + k * 12.9898) * 43758.5453; return v - Math.floor(v); };
    ctx.fillStyle = "rgba(10,30,15,0.28)"; ctx.beginPath(); ctx.ellipse(bx + 3, by + 1.5, 9, 3.2, 0, 0, Math.PI * 2); ctx.fill(); // base in the water
    ctx.strokeStyle = "rgba(220,240,200,0.35)"; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.ellipse(bx, by + 1, 10 + Math.sin(t * 1.5 + seed) * 1, 3.4, 0, 0, Math.PI * 2); ctx.stroke(); // ripple ring
    for (let k = 0; k < n; k++) {
      const ox = (rnd(k) - 0.5) * 12, h = 18 + rnd(k + 9) * 18, lean = (rnd(k + 3) - 0.5) * 10, sway = Math.sin(t * 1.4 + seed + k * 0.7) * (2 + h * 0.06);
      const x0 = bx + ox, y0 = by, tx = x0 + lean + sway, ty = y0 - h, w0 = 1.6 + rnd(k + 5) * 0.8;
      ctx.fillStyle = k % 3 === 0 ? "#7da142" : k % 3 === 1 ? "#5d8a36" : "#4b7530";
      ctx.beginPath(); ctx.moveTo(x0 - w0, y0); ctx.quadraticCurveTo(x0 + lean * 0.3 - w0 * 0.4, y0 - h * 0.55, tx, ty); ctx.quadraticCurveTo(x0 + lean * 0.3 + w0 * 0.6, y0 - h * 0.55, x0 + w0, y0); ctx.closePath(); ctx.fill();
      if (k % 3 === 0 && !lowFx) { // a cattail: stalk tip above a brown head
        const hx = x0 + (lean + sway) * 0.82, hy = y0 - h * 0.82;
        ctx.strokeStyle = "#5d8a36"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(tx + sway * 0.1, ty - 6); ctx.stroke();
        ctx.save(); ctx.translate(hx, hy - 2); ctx.rotate(Math.atan2(lean + sway, h) * 0.8);
        const cg = ctx.createLinearGradient(-2.2, 0, 2.2, 0); cg.addColorStop(0, "#8a5a32"); cg.addColorStop(1, "#4e2f18");
        ctx.fillStyle = cg; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(-2.2, -5.5, 4.4, 11, 2.2) : ctx.rect(-2.2, -5.5, 4.4, 11); ctx.fill();
        ctx.fillStyle = "rgba(255,230,190,0.35)"; ctx.fillRect(-1.4, -4, 0.9, 7);
        ctx.restore();
      }
    }
  }
  // 2D water: foam lapping at a dock's edge, like the GPU water's — strands of foam that wander in and
  // out from the edge and break up, built from overlapping dots (three alpha buckets: three fills), plus
  // a fainter lapping line further out
  function dockFoam2D(o, seed) {
    const per = 2 * (o.w + o.h), step = 1.8, t = waveT, ph = seed * 0.013;
    const lp = (t * 0.4 + (seed % 97) * 0.0037) % 1;
    const paths = [new Path2D(), new Path2D(), new Path2D(), new Path2D(), new Path2D()];
    for (let d = 0; d < per; d += step) {
      let x, y, nx = 0, ny = 0;
      if (d < o.w) { x = o.x + d; y = o.y; ny = -1; }
      else if (d < o.w + o.h) { x = o.x + o.w; y = o.y + d - o.w; nx = 1; }
      else if (d < 2 * o.w + o.h) { x = o.x + o.w - (d - o.w - o.h); y = o.y + o.h; ny = 1; }
      else { x = o.x; y = o.y + o.h - (d - 2 * o.w - o.h); nx = -1; }
      const v = (0.5 + 0.5 * Math.sin(d * 0.083 + t * 0.7 + ph) * Math.sin(d * 0.031 - t * 0.45 + ph * 2)) + 0.22 * Math.sin(d * 0.29 + t * 1.3);
      if (v > 0.46) {
        const off = 1.2 + 3.6 * (0.5 + 0.5 * Math.sin(d * 0.047 + t * 0.6 + ph * 3)), k = Math.min(1, (v - 0.46) * 2.4), r = 0.8 + 1.4 * k;
        const b = paths[v > 0.75 ? 2 : v > 0.6 ? 1 : 0]; b.moveTo(x + nx * off + r, y + ny * off); b.arc(x + nx * off, y + ny * off, r, 0, Math.PI * 2);
        if (!lowFx && ((d / step) | 0) % 2 === 1) { const R2 = r + 1.8; paths[4].moveTo(x + nx * off + R2, y + ny * off); paths[4].arc(x + nx * off, y + ny * off, R2, 0, Math.PI * 2); } // a soft fringe round the strand
      }
      if (!lowFx && v > 0.5 && ((d / step) | 0) % 2 === 0) { // the lapping line: thin, broken, spreading out and fading
        const off = 3 + lp * 9 + Math.sin(d * 0.07 + t) * 0.8; paths[3].moveTo(x + nx * off + 0.8, y + ny * off); paths[3].arc(x + nx * off, y + ny * off, 0.8, 0, Math.PI * 2);
      }
    }
    ctx.fillStyle = "#eef8ff";
    ctx.globalAlpha = 0.14; ctx.fill(paths[4]);
    [0.32, 0.5, 0.7].forEach((a, i) => { ctx.globalAlpha = a; ctx.fill(paths[i]); });
    ctx.globalAlpha = 0.4 * (1 - lp); ctx.fill(paths[3]);
    ctx.globalAlpha = 1;
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
    // (the GPU water draws these itself, under the beach: the part of a dock over the sand gets its shadow here)
    if (glWater && o.y + o.h + 10 > shoreLine) {
      ctx.save(); ctx.beginPath(); ctx.rect(o.x - 20, shoreLine, o.w + 40, o.h + 40); ctx.clip();
      ctx.fillStyle = "rgba(0,10,20,0.30)"; ctx.beginPath(); ctx.roundRect(o.x + 6, o.y + 10, o.w, o.h, 3); ctx.fill(); ctx.restore();
    }
    if (!glWater) {
      // soft shadow (two offset layers) and a faint warm halo of reflected wood
      ctx.fillStyle = "rgba(0,10,20,0.16)"; ctx.beginPath(); ctx.roundRect(o.x + 8, o.y + 13, o.w, o.h, 5); ctx.fill();
      ctx.beginPath(); ctx.roundRect(o.x + 4.5, o.y + 8, o.w, o.h, 3); ctx.fill();
      if (!lowFx) { ctx.fillStyle = "rgba(120,80,40,0.05)"; for (const e of [4, 8, 12]) { ctx.beginPath(); ctx.roundRect(o.x - e, o.y - e, o.w + e * 2, o.h + e * 2, e + 2); ctx.fill(); } }
      dockFoam2D(o, seed);
    }
    // pilings: shadow, a churning foam collar and a ripple spreading from each
    for (let i = 0; i < posts.length; i++) {
      const [px, py] = posts[i], rp = (waveT * 0.5 + i * 0.37) % 1;
      ctx.fillStyle = "rgba(0,10,20,0.28)"; ctx.beginPath(); ctx.ellipse(px + pr * 0.45, py + pr * 0.6, pr * 1.25, pr * 1.0, 0, 0, Math.PI * 2); ctx.fill();
      if (!lowFx) { ctx.strokeStyle = `rgba(225,244,252,${0.4 * (1 - rp)})`; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(px, py, pr * (1.3 + rp * 1.4), 0, Math.PI * 2); ctx.stroke(); }
      ctx.fillStyle = "rgba(240,250,255,0.7)"; // the collar: three tapered pieces of foam churning round the post
      for (let k = 0; k < 3; k++) { const c = waveT * 0.9 + k * 2.1 + i * 1.3, len = 0.8 + 0.35 * Math.sin(waveT * 0.8 + k * 1.7 + i); foamArc(px, py, pr * 1.18, pr * 1.18, c - len / 2, c + len / 2, 2.2); }
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
  // a tapered piece of foam along an ellipse arc (pointed ends, widest in the middle), filled with the current fillStyle
  function foamArc(cx, cy, rx, ry, a0, a1, w) {
    const N = Math.max(6, Math.ceil(Math.abs(a1 - a0) * 8));
    ctx.beginPath();
    for (let i = 0; i <= N; i++) { const a = a0 + (a1 - a0) * i / N, hw = w * 0.5 * Math.sin(Math.PI * i / N); ctx.lineTo(cx + Math.cos(a) * (rx + hw), cy + Math.sin(a) * (ry + hw)); }
    for (let i = N; i >= 0; i--) { const a = a0 + (a1 - a0) * i / N, hw = w * 0.5 * Math.sin(Math.PI * i / N); ctx.lineTo(cx + Math.cos(a) * (rx - hw), cy + Math.sin(a) * (ry - hw)); }
    ctx.closePath(); ctx.fill();
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
    // the rim: a broken ring of tapered foam pieces on a slightly wavy radius, drifting round (the shader's look)
    ctx.fillStyle = "rgba(240,250,255,0.62)";
    for (let k = 0; k < 7; k++) {
      const c = k * 0.9 + t * 0.55 + Math.sin(k * 2.3) * 0.3, len = 0.3 + 0.24 * (0.5 + 0.5 * Math.sin(t * 0.7 + k * 1.9)), rr = R * (0.97 + 0.03 * Math.sin(c * 5 + t * 2)), wv = Math.sin(k * 1.3 + t * 0.5);
      foamArc(0, 0, rr, rr, c - len / 2, c + len / 2, 2.2 + 1.8 * wv * wv);
    }
    // black core with a lit lip on the light side
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
      ctx.fillStyle = "rgba(235,248,255,0.55)"; // foam hugging the tube, in churning pieces
      for (let k = 0; k < 4; k++) { const c = -waveT * 0.6 - x * 0.004 + k * 1.57 + Math.sin(k * 2.1) * 0.3, len = 0.8 + 0.4 * Math.sin(waveT * 0.9 + k * 1.9); foamArc(0, bob, r * 1.05, r * 1.02, c - len / 2, c + len / 2, 2.6); }
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
    if (label) { ctx.font = uiFont(600, 15); ctx.textAlign = "center"; ctx.lineJoin = "round"; ctx.lineWidth = 3.5; ctx.strokeStyle = "rgba(4,22,34,0.7)"; ctx.strokeText(you ? "Du" : label, 0, -r - 12); ctx.fillStyle = you ? "#ffd7c7" : "#f2f9ff"; ctx.fillText(you ? "Du" : label, 0, -r - 12); }
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
  // A swimmer's sink-time gauge (and the red ring while a monster holds it), centred on the origin.
  // `over`: drawn again above the HUD (hud.js, a swimmer under a panel) — a little bolder, with a halo.
  function drawGaugeRing(R, frac, ch, t, over) {
    const hue = 120 * frac, a0 = -Math.PI / 2, a1 = a0 + Math.PI * 2 * frac, gr = R + 10;
    ctx.lineCap = "round";
    ctx.strokeStyle = over ? "rgba(2,22,38,0.62)" : "rgba(2,22,38,0.38)"; ctx.lineWidth = over ? 6 : 4.6; ctx.beginPath(); ctx.arc(0, 0, gr, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.12)"; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(0, 0, gr, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = `hsla(${hue},85%,60%,${over ? 0.32 : 0.22})`; ctx.lineWidth = 7; ctx.beginPath(); ctx.arc(0, 0, gr, a0, a1); ctx.stroke();
    ctx.strokeStyle = `hsl(${hue},85%,62%)`; ctx.lineWidth = over ? 3 : 2.4; ctx.beginPath(); ctx.arc(0, 0, gr, a0, a1); ctx.stroke();
    ctx.fillStyle = `hsl(${hue},90%,80%)`; ctx.beginPath(); ctx.arc(Math.cos(a1) * gr, Math.sin(a1) * gr, 2.2, 0, Math.PI * 2); ctx.fill();
    ctx.lineCap = "butt";
    // danger ring: a monster is holding this swimmer — rises red until eaten
    if (ch > 0) { ctx.strokeStyle = `rgba(255,70,60,${0.35 + 0.45 * ch})`; ctx.lineWidth = 2 + 4 * ch; ctx.beginPath(); ctx.arc(0, 0, gr + 6 + Math.sin(t * 14) * 1.5 * ch, 0, Math.PI * 2); ctx.stroke(); }
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
    drawGaugeRing(R, frac, s.ch != null ? s.ch : Math.min(1, (s.chomp || 0) / EAT_DWELL), t, false);

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
    // the waterline where the body breaks the surface: churning foam pieces along the belly, the humps and the tail
    ctx.fillStyle = "rgba(230,248,255,0.55)";
    for (const [k, ex, ey, erx, ery, a0, a1, w] of [[0, -0.15, 0.4, 1.1, 0.26, 0.06, 0.5, 2.4], [1, -0.15, 0.4, 1.1, 0.26, 0.5, 0.94, 2.4], [2, -1.15, 0.27, 0.52, 0.15, 0.12, 0.88, 1.9], [3, -1.85, 0.12, 0.4, 0.1, 0.15, 0.85, 1.4], [4, 0.55, 0.3, 0.26, 0.1, 0.1, 0.9, 1.6]]) {
      const j = Math.sin(t * 1.3 + k * 1.9) * 0.06, l = Math.cos(t * 1.1 + k * 2.4) * 0.05;
      foamArc(ex * R, ey * R, erx * R, ery * R, Math.PI * (a0 + 0.04 + j), Math.PI * (a1 - 0.04 + l), w);
    }

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
  // desktop and 1.5 on phones/tablets, and at most MAX_BACK_W pixels wide (2960x1480:
  // the pixel budget the 2560 px cap gave the old 3:2 canvas, 2560x1707).
  // Checked every frame (cheap), so it follows resizes, fullscreen, a window
  // moved to another screen and the cap itself changing.
  let backK = 1;
  const MAX_BACK_W = 2960, coarseMQ = matchMedia("(pointer: coarse)");
  function fitBacking() {
    const cw = canvas.clientWidth;
    if (!cw) return;
    const k = Math.min(window.devicePixelRatio || 1, coarseMQ.matches ? 1.5 : 2, MAX_BACK_W / cw);
    const w = Math.max(1, Math.round(cw * k)), h = Math.round(w * CH / CW);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    backK = canvas.width / CW;
  }
  function resetBase() { ctx.setTransform(backK, 0, 0, backK, 0, 0); }

  // What the HUD must not hide: swimmers (with their gauge), monsters and the rings, as boxes in canvas coords
  // around what is drawn of them (hud.js fades the pieces over them and redraws the gauges on top).
  function occluders(v, f) {
    const out = [], X = (x) => f.ox + x * f.s, Y = (y) => f.oy + y * f.s;
    const box = (x0, y0, x1, y1, kind, gauge) => out.push({ x: X(x0), y: Y(y0), w: (x1 - x0) * f.s, h: (y1 - y0) * f.s, kind, gauge });
    for (const s of v.swimmers) {
      const R = s.r || 16, y = s.y + Math.sin(s.bob || 0) * 2.6, frac = s.frac != null ? s.frac : Math.max(0, s.life / s.maxLife);
      const ch = s.ch != null ? s.ch : Math.min(1, (s.chomp || 0) / EAT_DWELL), e = R + 12 + (ch > 0 ? 8 : 0);
      box(s.x - e, y - e, s.x + e, Math.max(y + e, y + R * 1.9), "swimmer", { x: X(s.x), y: Y(y), s: f.s, R, frac, ch, t: s.bob || 0 });
    }
    for (const m of v.monsters || []) {
      if ((m.sub || 0) > 0.75) continue; // under water: only a dark shape
      const R = m.r || 30, fc = m.face === undefined ? (Math.cos(m.dir || 0) < 0 ? -1 : 1) : m.face, y = m.y + Math.sin(m.wob || 0) * 2;
      const a = m.x + (fc >= 0 ? -2.75 : -1.6) * R, b = m.x + (fc >= 0 ? 1.6 : 2.75) * R;
      box(a, y - 1.75 * R, b, y + 0.95 * R, "monster");
    }
    for (const p of v.players) { const r = p.r || 30; box(p.x - r - 9, p.y - r - 26, p.x + r + 9, p.y + r + 9, "ring"); }
    return out;
  }
  function render() {
    ({ authoritative, selfId, usingTouch, muted, quitArmedUntil, levelStartScore, saved } = ui.live());
    resetBase();
    const v = ui.view();
    const inGame = !!v && v.phase !== Phase.LOBBY;
    const f = inGame ? fit(v.world.w, v.world.h) : null;
    if (inGame) lowFx = (v.swimmers.length + saved.length) > 18; // lighten shading when crowded
    // the GPU water layer under this canvas (false: no GPU water this frame -> 2D water)
    const screen = inGame && (v.phase === Phase.CLEARED || v.phase === Phase.OVER || v.phase === Phase.WIN); // (blurred behind a card: hud.js)
    glWater = inGame && water.draw({ v, f, t: waveT, lowFx, saved, selfId, selfDash: selfPos.dashActive > 0, SHORE_H: shoreH(v.world), playing: v.phase === Phase.PLAY, screen });
    if (glWater) ctx.clearRect(0, 0, CW, CH); else { ctx.fillStyle = "#08222f"; ctx.fillRect(0, 0, CW, CH); }
    if (!v) { hud.wait("Ansluter…"); return; }
    if (v.phase === Phase.LOBBY) { hud.lobby(v); return; }
    ctx.setTransform(backK * f.s, 0, 0, backK * f.s, backK * f.ox, backK * f.oy);
    if (!glWater) drawWater2D(ctx, v.world.w, v.world.h, shoreY(v.world), waveT, lowFx, backK * f.s);
    // a world of another shape (a 3:2 one from a host on the previous build) is letterboxed: keep the gulls and the rest inside it
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, v.world.w, v.world.h); ctx.clip();
    for (const z of v.swamps || []) drawSwamp(z);
    if (!glWater) for (const z of v.whirls || []) drawWhirl(z);
    drawShore(v.world.w, v.world.h);
    drawScenery(v.world.w, v.world.h);
    shoreLine = shoreY(v.world);
    for (const o of v.obstacles) drawBrygga(o);
    for (const s of v.swimmers) drawSwimmer(s);
    for (const m of v.monsters || []) drawMonster(m);
    for (const sv of saved) drawSaved(sv);
    if (v.splashes) for (const sp of v.splashes) drawSplash(sp);
    for (const p of v.players) { const you = p.id === selfId; const stunned = you ? selfPos.stun > 0 : !!(p.stunned || p.stun); drawLivboj(p.x, p.y, p.r || 30, p.hue, you && (p.dashActive > 0 || selfPos.dashActive > 0), p.name, you, stunned); }
    drawSeagulls(v.world.w, v.world.h, shoreY(v.world), waveT);
    drawLightGrade(v.world.w, v.world.h);
    ctx.restore();
    resetBase();
    hud.game(v, occluders(v, f)); // HUD, buttons, screens (hud.js)
    water.frameDone(); // (the quality ladder weighs the frame time against this CPU time)
  }
  return {
    CW, CH, DASH_BTN: hud.DASH_BTN, MUTE_BTN: hud.MUTE_BTN, QUIT_BTN: hud.QUIT_BTN, fit, toWorld, fitBacking, render, water,
    actionBtn: hud.actionBtn, leaveBtn: hud.leaveBtn, hudSee: hud.see,
    // start of a frame: advance the animation clock; only the screens drawn this frame may be clickable
    beginFrame(dt) { waveT += dt; fitBacking(); hud.beginFrame(dt); },
  };
}

// Livbojen — shared engine for solo / host / join.
// Host-authoritative multiplayer over WebRTC P2P (Trystero, public signaling).
import { joinRoom, selfId } from "https://cdn.jsdelivr.net/npm/trystero@0.21.5/nostr/+esm";

const APP_ID = "livboj-bookbeat-9f3a";

// ---- Level design (base, scaled by player count) --------------------------
const BASE_LEVELS = [
  { quota: 5,  spawn: 1300, speed: 22, sink: 9.0, time: 45, maxOnScreen: 4, allowedMisses: 6 },
  { quota: 8,  spawn: 1050, speed: 34, sink: 8.0, time: 45, maxOnScreen: 5, allowedMisses: 5 },
  { quota: 12, spawn: 880,  speed: 48, sink: 7.0, time: 45, maxOnScreen: 6, allowedMisses: 4 },
  { quota: 16, spawn: 720,  speed: 64, sink: 6.0, time: 42, maxOnScreen: 7, allowedMisses: 4 },
  { quota: 20, spawn: 560,  speed: 84, sink: 5.2, time: 40, maxOnScreen: 8, allowedMisses: 3 },
];

const SKINS = ["#f7d3ad", "#e8b98f", "#c98d61", "#a86a44", "#f2c39b"];
const HAIRS = ["#3a2a1c", "#221b16", "#6b4a2a", "#0f0f10", "#8a5a2b", "#c9a24a"];
const HUES = [28, 205, 140, 320, 52, 265, 0, 175, 95, 235];

// More players -> bigger ocean, more/faster swimmers, more misses allowed.
function worldSize(n) {
  return { w: Math.min(900 + (n - 1) * 170, 1560), h: Math.min(600 + (n - 1) * 120, 1040) };
}
function levelParams(idx, n) {
  const L = BASE_LEVELS[idx];
  return {
    quota: L.quota + (n - 1) * Math.ceil(L.quota * 0.5),
    spawn: L.spawn / (1 + (n - 1) * 0.35),
    speed: L.speed * (1 + (n - 1) * 0.05),
    sink: L.sink,
    time: L.time,
    maxOnScreen: L.maxOnScreen + (n - 1) * 2,
    allowedMisses: L.allowedMisses + (n - 1),
  };
}
function makeObstacles(idx, w, h) {
  const specs = [
    [],
    [{ x: 130, y: 150, w: 175, h: 34 }],
    [{ x: 110, y: 130, w: 190, h: 34 }, { x: 610, y: 330, w: 40, h: 175 }],
    [{ x: 90, y: 120, w: 175, h: 34 }, { x: 625, y: 150, w: 40, h: 185 }, { x: 335, y: 435, w: 235, h: 36 }],
    [{ x: 80, y: 110, w: 165, h: 32 }, { x: 665, y: 120, w: 40, h: 175 }, { x: 120, y: 445, w: 195, h: 34 }, { x: 560, y: 430, w: 40, h: 150 }],
  ];
  const sx = w / 900, sy = h / 600;
  return (specs[idx] || []).map((o) => ({ x: o.x * sx, y: o.y * sy, w: o.w * sx, h: o.h * sy }));
}

// ---- Geometry helpers -----------------------------------------------------
function circleHitsRect(px, py, pr, o) {
  const cx = Math.max(o.x, Math.min(px, o.x + o.w));
  const cy = Math.max(o.y, Math.min(py, o.y + o.h));
  const dx = px - cx, dy = py - cy;
  if (dx * dx + dy * dy >= pr * pr) return null;
  const d = Math.hypot(dx, dy);
  if (d > 0.0001) return { x: px + (dx / d) * (pr - d), y: py + (dy / d) * (pr - d), nx: dx / d, ny: dy / d };
  const l = px - o.x, r = o.x + o.w - px, t = py - o.y, b = o.y + o.h - py;
  const m = Math.min(l, r, t, b);
  if (m === l) return { x: o.x - pr, y: py, nx: -1, ny: 0 };
  if (m === r) return { x: o.x + o.w + pr, y: py, nx: 1, ny: 0 };
  if (m === t) return { x: px, y: o.y - pr, nx: 0, ny: -1 };
  return { x: px, y: o.y + o.h + pr, nx: 0, ny: 1 };
}

// ==========================================================================
//  Engine
// ==========================================================================
export function createGame(canvas, opts) {
  const ctx = canvas.getContext("2d");
  const CW = canvas.width, CH = canvas.height;
  const mode = opts.mode; // 'solo' | 'host' | 'join'
  const myName = (opts.name || "Spelare").slice(0, 14);
  const cbs = opts.cbs || {};

  const Phase = { LOBBY: "lobby", INTRO: "intro", PLAY: "play", CLEARED: "cleared", OVER: "over", WIN: "win" };

  // World / sim state (authoritative on host & solo)
  let world = worldSize(1);
  let obstacles = [];
  let swimmers = [];
  let splashes = [];
  let players = new Map(); // id -> {id,x,y,r,name,hue,dashActive,dashCooldown,input:{dx,dy,dash}}
  let levelIndex = 0, score = 0, caught = 0, missed = 0, timeLeft = 0, spawnTimer = 0, introTimer = 0;
  let phase = mode === "solo" ? Phase.INTRO : Phase.LOBBY;
  let swimmerSeq = 1;
  let hueSeq = 0;

  // Local input + own predicted position (for join responsiveness)
  const keys = Object.create(null);
  let usingTouch = false;
  let pointerTarget = null;
  const selfPos = { x: 0, y: 0, r: 30, predicted: false };

  // Interpolation store for join rendering
  const iSwim = new Map(); // id -> {x,y,r,frac,sk,hr}
  const iPlayer = new Map(); // id -> {x,y,name,hue,dash}
  let lastView = null; // for join: latest snapshot decoded

  // Networking
  let room = null, sendState = null, sendInput = null, sendHello = null;
  const DASH_BTN = { x: CW - 66, y: CH - 66, r: 46 };

  // ---- Setup per mode -----------------------------------------------------
  function setupSolo() {
    addPlayer(selfId, myName);
    startLevel(0);
    phase = Phase.INTRO; introTimer = 2.4;
    emitPhase();
  }

  function setupHost() {
    room = joinRoom({ appId: APP_ID }, opts.room);
    // Trystero 0.21 makeAction -> tuple [send, receive, onProgress].
    const [stSend] = room.makeAction("st");
    const [, onInp] = room.makeAction("inp");
    const [, onHi] = room.makeAction("hi");
    sendState = (snap) => { try { stSend(snap); } catch (e) {} };
    onHi((data, peer) => { renamePlayer(peer, (data && data.name) || "Spelare"); emitRoster(); pushState(); });
    onInp((data, peer) => { const p = players.get(peer); if (p && data) p.input = { dx: data.dx || 0, dy: data.dy || 0, dash: !!data.dash }; });
    addPlayer(selfId, myName); // host plays too
    room.onPeerJoin((peer) => { addPlayer(peer, "Spelare"); emitRoster(); pushState(); });
    room.onPeerLeave((peer) => { players.delete(peer); emitRoster(); });
    emitRoster();
    // Broadcast at ~20Hz
    setInterval(() => { if (room) pushState(); }, 50);
  }

  function setupJoin() {
    room = joinRoom({ appId: APP_ID }, opts.room);
    const [, onSt] = room.makeAction("st");
    const [inpSend] = room.makeAction("inp");
    const [hiSend] = room.makeAction("hi");
    onSt((data) => applyState(data));
    sendInput = (inp) => { try { inpSend(inp); } catch (e) {} };
    sendHello = (d) => { try { hiSend(d); } catch (e) {} };
    selfPos.predicted = true;
    room.onPeerJoin(() => { sendHello({ name: myName }); });
    // keep announcing until a host answers
    const iv = setInterval(() => { if (!lastView) sendHello({ name: myName }); else clearInterval(iv); }, 700);
    // send input at 20Hz
    setInterval(() => { if (sendInput) sendInput(localInput()); }, 50);
    emitPhase();
  }

  function addPlayer(id, name) {
    if (players.has(id)) return;
    players.set(id, {
      id, name, x: world.w / 2, y: world.h / 2, r: 30,
      hue: HUES[(hueSeq++) % HUES.length],
      dashActive: 0, dashCooldown: 0, input: { dx: 0, dy: 0, dash: false },
    });
  }
  function renamePlayer(id, name) { const p = players.get(id); if (p) p.name = (name || "Spelare").slice(0, 14); }

  // ---- Roster / phase callbacks ------------------------------------------
  function rosterList() {
    return [...players.values()].map((p) => ({ id: p.id, name: p.id === selfId ? myName : p.name, you: p.id === selfId }));
  }
  function emitRoster() { cbs.onRoster && cbs.onRoster(rosterList()); }
  function emitPhase() { cbs.onPhase && cbs.onPhase(phase); }

  // ---- Level control (host/solo) -----------------------------------------
  function startLevel(idx) {
    const n = Math.max(1, players.size);
    world = worldSize(n);
    obstacles = makeObstacles(idx, world.w, world.h);
    const L = levelParams(idx, n);
    levelIndex = idx; caught = 0; missed = 0; timeLeft = L.time; spawnTimer = 0.4;
    swimmers = []; splashes = [];
    for (const p of players.values()) { p.x = world.w / 2; p.y = world.h / 2; p.dashActive = 0; p.dashCooldown = 0; }
    selfPos.x = world.w / 2; selfPos.y = world.h / 2;
  }
  // Host: called by the Starta button.
  function hostStart() {
    if (mode !== "host" || phase !== Phase.LOBBY) return;
    startLevel(0); phase = Phase.INTRO; introTimer = 2.4; emitPhase(); pushState();
  }
  function nextLevel() {
    levelIndex++;
    if (levelIndex >= BASE_LEVELS.length) { phase = Phase.WIN; emitPhase(); return; }
    startLevel(levelIndex); phase = Phase.INTRO; introTimer = 2.4; emitPhase();
  }
  function advance() {
    // Space / tap on menus. Host & solo drive real transitions; joiners can't.
    if (mode === "join") return;
    if (phase === Phase.INTRO) { /* auto after timer, but allow skip on solo */ if (mode === "solo") { phase = Phase.PLAY; emitPhase(); } }
    else if (phase === Phase.CLEARED) { nextLevel(); }
    else if (phase === Phase.OVER || phase === Phase.WIN) {
      if (mode === "solo") { levelIndex = 0; score = 0; startLevel(0); phase = Phase.INTRO; introTimer = 2.4; emitPhase(); }
      else { levelIndex = 0; score = 0; phase = Phase.LOBBY; emitPhase(); emitRoster(); }
    }
  }

  function spawnSwimmer() {
    const n = Math.max(1, players.size);
    const L = levelParams(levelIndex, n);
    const margin = 60;
    let x, y, tries = 0;
    do { x = margin + Math.random() * (world.w - margin * 2); y = margin + Math.random() * (world.h - margin * 2); tries++; }
    while (tries < 20 && obstacles.some((o) => circleHitsRect(x, y, 26, o)));
    const ang = Math.random() * Math.PI * 2;
    swimmers.push({
      id: swimmerSeq++, x, y, r: 16, vx: Math.cos(ang) * L.speed, vy: Math.sin(ang) * L.speed,
      life: L.sink, maxLife: L.sink, bob: Math.random() * Math.PI * 2,
      sk: (Math.random() * SKINS.length) | 0, hr: (Math.random() * HAIRS.length) | 0,
    });
  }

  // ---- Local input --------------------------------------------------------
  function localInput() {
    let dx = 0, dy = 0;
    if (keys.ArrowLeft) dx -= 1;
    if (keys.ArrowRight) dx += 1;
    if (keys.ArrowUp) dy -= 1;
    if (keys.ArrowDown) dy += 1;
    if (!dx && !dy && pointerTarget) {
      const ax = pointerTarget.x - selfPos.x, ay = pointerTarget.y - selfPos.y;
      const d = Math.hypot(ax, ay);
      if (d > 5) { dx = ax / d; dy = ay / d; }
    }
    if (dx || dy) { const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len; }
    return { dx, dy, dash: !!keys.Space || dashTap };
  }
  let dashTap = false;

  // ---- Update (host/solo) -------------------------------------------------
  function movePlayer(p, dt, input) {
    let dx = input.dx, dy = input.dy;
    p.dashCooldown = Math.max(0, p.dashCooldown - dt);
    p.dashActive = Math.max(0, p.dashActive - dt);
    if (input.dash && p.dashCooldown === 0) { p.dashActive = 0.18; p.dashCooldown = 0.9; }
    const speed = 300 * (p.dashActive > 0 ? 2.1 : 1);
    p.x += dx * speed * dt; p.y += dy * speed * dt;
    for (const o of obstacles) { const hit = circleHitsRect(p.x, p.y, p.r, o); if (hit) { p.x = hit.x; p.y = hit.y; } }
    p.x = Math.max(p.r, Math.min(world.w - p.r, p.x));
    p.y = Math.max(p.r, Math.min(world.h - p.r, p.y));
  }

  function updateSim(dt) {
    if (phase === Phase.INTRO) {
      introTimer -= dt;
      if (introTimer <= 0) { phase = Phase.PLAY; emitPhase(); }
      return;
    }
    if (phase !== Phase.PLAY) return;
    const n = Math.max(1, players.size);
    const L = levelParams(levelIndex, n);

    // Move every player: self uses local input, peers use their last input.
    for (const p of players.values()) {
      const input = p.id === selfId ? localInput() : p.input;
      movePlayer(p, dt, input);
    }
    // keep selfPos synced to authoritative self (host/solo)
    const me = players.get(selfId);
    if (me) { selfPos.x = me.x; selfPos.y = me.y; }
    dashTap = false;

    timeLeft -= dt;
    if (timeLeft <= 0) { timeLeft = 0; phase = Phase.OVER; emitPhase(); return; }

    spawnTimer -= dt;
    if (spawnTimer <= 0 && swimmers.length < L.maxOnScreen) { spawnSwimmer(); spawnTimer = L.spawn / 1000; }

    for (let i = swimmers.length - 1; i >= 0; i--) {
      const s = swimmers[i];
      s.x += s.vx * dt; s.y += s.vy * dt; s.bob += dt * 4;
      if (s.x < s.r || s.x > world.w - s.r) { s.vx *= -1; s.x = Math.max(s.r, Math.min(world.w - s.r, s.x)); }
      if (s.y < s.r || s.y > world.h - s.r) { s.vy *= -1; s.y = Math.max(s.r, Math.min(world.h - s.r, s.y)); }
      for (const o of obstacles) {
        const hit = circleHitsRect(s.x, s.y, s.r, o);
        if (hit) { s.x = hit.x; s.y = hit.y; const dot = s.vx * hit.nx + s.vy * hit.ny; s.vx -= 2 * dot * hit.nx; s.vy -= 2 * dot * hit.ny; }
      }
      s.life -= dt;

      let rescued = false;
      for (const p of players.values()) {
        if (Math.hypot(s.x - p.x, s.y - p.y) < p.r + s.r) { rescued = true; break; }
      }
      if (rescued) {
        caught++; score += 10 + levelIndex * 5;
        splashes.push({ x: s.x, y: s.y, t: 0, good: true });
        swimmers.splice(i, 1);
        if (caught >= L.quota) { phase = Phase.CLEARED; emitPhase(); return; }
        continue;
      }
      if (s.life <= 0) {
        missed++; splashes.push({ x: s.x, y: s.y, t: 0, good: false });
        swimmers.splice(i, 1);
        if (missed > L.allowedMisses) { phase = Phase.OVER; emitPhase(); return; }
      }
    }
    for (let i = splashes.length - 1; i >= 0; i--) { splashes[i].t += dt; if (splashes[i].t > 0.6) splashes.splice(i, 1); }
  }

  // Join-side: predict own ring locally so it feels responsive.
  function updateJoin(dt) {
    if (!lastView || lastView.phase !== Phase.PLAY) return;
    const input = localInput();
    selfPos.dashActive = Math.max(0, (selfPos.dashActive || 0) - dt);
    selfPos.dashCd = Math.max(0, (selfPos.dashCd || 0) - dt);
    if (input.dash && selfPos.dashCd === 0) { selfPos.dashActive = 0.18; selfPos.dashCd = 0.9; }
    const sp = 300 * (selfPos.dashActive > 0 ? 2.1 : 1);
    selfPos.x += input.dx * sp * dt; selfPos.y += input.dy * sp * dt;
    for (const o of (lastView.obstacles || [])) { const hit = circleHitsRect(selfPos.x, selfPos.y, selfPos.r, o); if (hit) { selfPos.x = hit.x; selfPos.y = hit.y; } }
    const w = lastView.world;
    selfPos.x = Math.max(selfPos.r, Math.min(w.w - selfPos.r, selfPos.x));
    selfPos.y = Math.max(selfPos.r, Math.min(w.h - selfPos.r, selfPos.y));
    dashTap = false;
  }

  // ---- State sync ---------------------------------------------------------
  function pushState() {
    if (!sendState) return;
    const snap = {
      phase, levelIndex, score, caught, missed, timeLeft,
      quota: phase === Phase.LOBBY ? 0 : levelParams(levelIndex, Math.max(1, players.size)).quota,
      allowedMisses: levelParams(levelIndex, Math.max(1, players.size)).allowedMisses,
      world, introTimer,
      obstacles: obstacles.map((o) => [o.x, o.y, o.w, o.h]),
      swimmers: swimmers.map((s) => [s.id, Math.round(s.x), Math.round(s.y), s.r, +(s.life / s.maxLife).toFixed(2), s.sk, s.hr]),
      players: [...players.values()].map((p) => [p.id, Math.round(p.x), Math.round(p.y), p.name, p.dashActive > 0 ? 1 : 0, p.hue]),
    };
    try { sendState(snap); } catch (e) { /* peers not ready yet */ }
  }

  function applyState(d) {
    if (!d) return;
    lastView = {
      phase: d.phase, levelIndex: d.levelIndex, score: d.score, caught: d.caught, missed: d.missed,
      timeLeft: d.timeLeft, quota: d.quota, allowedMisses: d.allowedMisses, world: d.world, introTimer: d.introTimer,
      obstacles: (d.obstacles || []).map((o) => ({ x: o[0], y: o[1], w: o[2], h: o[3] })),
    };
    // swimmers -> interpolation targets
    const seen = new Set();
    for (const s of d.swimmers || []) {
      seen.add(s[0]);
      const cur = iSwim.get(s[0]) || { x: s[1], y: s[2] };
      cur.tx = s[1]; cur.ty = s[2]; cur.r = s[3]; cur.frac = s[4]; cur.sk = s[5]; cur.hr = s[6];
      if (cur.x === undefined) { cur.x = s[1]; cur.y = s[2]; }
      iSwim.set(s[0], cur);
    }
    for (const id of [...iSwim.keys()]) if (!seen.has(id)) iSwim.delete(id);
    // players -> interpolation targets
    const seenP = new Set();
    for (const p of d.players || []) {
      seenP.add(p[0]);
      const cur = iPlayer.get(p[0]) || { x: p[1], y: p[2] };
      cur.tx = p[1]; cur.ty = p[2]; cur.name = p[3]; cur.dash = p[4]; cur.hue = p[5]; cur.id = p[0];
      if (cur.x === undefined) { cur.x = p[1]; cur.y = p[2]; }
      iPlayer.set(p[0], cur);
    }
    for (const id of [...iPlayer.keys()]) if (!seenP.has(id)) iPlayer.delete(id);
    // On first play frame, seed our predicted position at the spawn.
    if (!selfPos.seeded && d.phase === Phase.PLAY) {
      const meP = (d.players || []).find((p) => p[0] === selfId);
      if (meP) { selfPos.x = meP[1]; selfPos.y = meP[2]; selfPos.seeded = true; }
    }
    if (d.phase === Phase.LOBBY) selfPos.seeded = false;
    // surface roster + phase to the page
    cbs.onRoster && cbs.onRoster((d.players || []).map((p) => ({ id: p[0], name: p[0] === selfId ? myName : p[3], you: p[0] === selfId })));
    if (lastView._lastPhase !== d.phase) { lastView._lastPhase = d.phase; cbs.onPhase && cbs.onPhase(d.phase); }
  }

  // ---- Rendering ----------------------------------------------------------
  function fit(w, h) {
    const scale = Math.min(CW / w, CH / h);
    return { scale, ox: (CW - w * scale) / 2, oy: (CH - h * scale) / 2 };
  }
  function toWorld(cx, cy, w, h) { const f = fit(w, h); return { x: (cx - f.ox) / f.scale, y: (cy - f.oy) / f.scale }; }

  function drawWater(w, h, t) {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "#12496a"); g.addColorStop(1, "#0c2f45");
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(255,255,255,0.06)"; ctx.lineWidth = 2;
    const rows = Math.round(h / 86);
    for (let row = 0; row < rows; row++) {
      const y0 = (row + 0.5) * (h / rows);
      ctx.beginPath();
      for (let x = 0; x <= w; x += 20) { const y = y0 + Math.sin((x * 0.02) + t + row) * 6; if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
      ctx.stroke();
    }
  }
  function drawBrygga(o) {
    ctx.fillStyle = "rgba(0,0,0,0.18)"; ctx.fillRect(o.x + 4, o.y + 7, o.w, o.h);
    ctx.fillStyle = "#7a4f2a"; ctx.fillRect(o.x, o.y, o.w, o.h);
    ctx.strokeStyle = "rgba(40,24,10,0.5)"; ctx.lineWidth = 2;
    const horizontal = o.w >= o.h;
    const nn = Math.max(3, Math.round((horizontal ? o.w : o.h) / 26));
    for (let i = 1; i < nn; i++) {
      if (horizontal) { const x = o.x + (o.w / nn) * i; ctx.beginPath(); ctx.moveTo(x, o.y); ctx.lineTo(x, o.y + o.h); ctx.stroke(); }
      else { const y = o.y + (o.h / nn) * i; ctx.beginPath(); ctx.moveTo(o.x, y); ctx.lineTo(o.x + o.w, y); ctx.stroke(); }
    }
    ctx.fillStyle = "rgba(212,172,122,0.55)"; ctx.fillRect(o.x, o.y, o.w, 3);
    ctx.fillStyle = "#5c3a1e"; const ps = 7;
    [[o.x, o.y], [o.x + o.w - ps, o.y], [o.x, o.y + o.h - ps], [o.x + o.w - ps, o.y + o.h - ps]].forEach(([x, y]) => ctx.fillRect(x, y, ps, ps));
  }
  function drawLivboj(x, y, r, hue, glow, label, you) {
    ctx.save();
    ctx.translate(x, y);
    if (hue != null) { ctx.strokeStyle = `hsl(${hue},85%,60%)`; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(0, 0, r + 5, 0, Math.PI * 2); ctx.stroke(); }
    if (glow) { ctx.shadowColor = "rgba(255,255,255,0.9)"; ctx.shadowBlur = 20; }
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.arc(0, 0, r * 0.55, 0, Math.PI * 2, true);
    ctx.fillStyle = "#f4571d"; ctx.fill("evenodd"); ctx.shadowBlur = 0;
    ctx.fillStyle = "#f4f4f0";
    for (let i = 0; i < 4; i++) { ctx.save(); ctx.rotate(i * Math.PI / 2 + Math.PI / 4); ctx.beginPath(); ctx.arc(0, 0, r, -0.32, 0.32); ctx.arc(0, 0, r * 0.55, 0.32, -0.32, true); ctx.closePath(); ctx.fill(); ctx.restore(); }
    ctx.strokeStyle = "rgba(0,0,0,0.28)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, r * 0.55, 0, Math.PI * 2); ctx.stroke();
    if (label) {
      ctx.fillStyle = you ? "#ffd7c7" : "#eaf6ff";
      ctx.font = "700 14px system-ui, sans-serif"; ctx.textAlign = "center";
      ctx.fillText(you ? "Du" : label, 0, -r - 8);
    }
    ctx.restore();
  }
  function drawSwimmer(s) {
    const bobY = Math.sin(s.bob || 0) * 2, cx = s.x, cy = s.y + bobY;
    const frac = s.frac != null ? s.frac : Math.max(0, s.life / s.maxLife);
    const skin = SKINS[s.sk % SKINS.length], hair = HAIRS[s.hr % HAIRS.length], R = s.r;
    ctx.strokeStyle = "rgba(180,220,240,0.32)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(cx, cy + 9, R * 1.45, R * 0.72, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(cx, cy + 9, R * 1.95, R * 0.98, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = `hsl(${120 * frac},80%,55%)`; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(cx, cy, R + 9, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac); ctx.stroke();
    ctx.globalAlpha = 0.85; ctx.fillStyle = skin;
    ctx.beginPath(); ctx.ellipse(cx, cy + R * 0.75, R * 0.82, R * 0.5, 0, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
    const wave = Math.sin((s.bob || 0) * 1.6) * 5;
    ctx.strokeStyle = skin; ctx.lineWidth = 5; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(cx - R * 0.5, cy + 2); ctx.lineTo(cx - R * 1.25, cy - 9 + wave); ctx.moveTo(cx + R * 0.5, cy + 2); ctx.lineTo(cx + R * 1.25, cy - 9 - wave); ctx.stroke();
    ctx.fillStyle = skin; ctx.beginPath(); ctx.arc(cx - R * 1.25, cy - 9 + wave, 3.6, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.arc(cx + R * 1.25, cy - 9 - wave, 3.6, 0, Math.PI * 2); ctx.fill(); ctx.lineCap = "butt";
    ctx.fillStyle = skin; ctx.beginPath(); ctx.arc(cx, cy, R * 0.8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = hair; ctx.beginPath(); ctx.arc(cx, cy - 2, R * 0.8, Math.PI * 1.03, Math.PI * 1.97); ctx.fill(); ctx.beginPath(); ctx.arc(cx, cy - R * 0.28, R * 0.6, Math.PI, 0); ctx.fill();
    ctx.fillStyle = "#2a2320"; ctx.beginPath(); ctx.arc(cx - R * 0.28, cy - 1, 2, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.arc(cx + R * 0.28, cy - 1, 2, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#2a2320"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(cx - R * 0.42, cy - 6); ctx.lineTo(cx - R * 0.14, cy - 8); ctx.moveTo(cx + R * 0.14, cy - 8); ctx.lineTo(cx + R * 0.42, cy - 6); ctx.stroke();
    ctx.fillStyle = "#6e3b32"; ctx.beginPath(); ctx.ellipse(cx, cy + R * 0.42, 2.6, 3.3, 0, 0, Math.PI * 2); ctx.fill();
  }
  function drawSplash(sp) {
    const p = sp.t / 0.6;
    ctx.strokeStyle = sp.good ? `rgba(120,230,160,${1 - p})` : `rgba(230,120,120,${1 - p})`;
    ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(sp.x, sp.y, 6 + p * 26, 0, Math.PI * 2); ctx.stroke();
  }

  function currentView() {
    if (mode === "join") {
      if (!lastView) return null;
      // advance interpolation
      const sm = 0.25;
      for (const s of iSwim.values()) { s.x += (s.tx - s.x) * sm; s.y += (s.ty - s.y) * sm; s.bob = (s.bob || 0) + 0.15; }
      for (const p of iPlayer.values()) { p.x += (p.tx - p.x) * sm; p.y += (p.ty - p.y) * sm; }
      return {
        world: lastView.world, obstacles: lastView.obstacles,
        swimmers: [...iSwim.values()],
        players: [...iPlayer.values()].map((p) => p.id === selfId ? { ...p, x: selfPos.x, y: selfPos.y } : p),
        hud: { score: lastView.score, level: lastView.levelIndex, caught: lastView.caught, quota: lastView.quota, time: lastView.timeLeft, missed: lastView.missed, allowedMisses: lastView.allowedMisses, n: iPlayer.size },
        phase: lastView.phase, introTimer: lastView.introTimer,
      };
    }
    // host/solo authoritative
    const n = Math.max(1, players.size);
    const L = levelParams(levelIndex, n);
    return {
      world, obstacles, swimmers,
      players: [...players.values()],
      splashes,
      hud: { score, level: levelIndex, caught, quota: L.quota, time: timeLeft, missed, allowedMisses: L.allowedMisses, n },
      phase, introTimer,
    };
  }

  function render() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#08222f"; ctx.fillRect(0, 0, CW, CH);
    const v = currentView();
    if (!v) { drawWaitScreen("Ansluter…"); return; }
    if (v.phase === Phase.LOBBY) { drawWaitScreen(mode === "host" ? "Väntar i lobbyn — tryck Starta när alla är med." : "Väntar på att värden startar…"); return; }

    const f = fit(v.world.w, v.world.h);
    ctx.setTransform(f.scale, 0, 0, f.scale, f.ox, f.oy);
    drawWater(v.world.w, v.world.h, waveT);
    for (const o of v.obstacles) drawBrygga(o);
    for (const s of v.swimmers) drawSwimmer(s);
    if (v.splashes) for (const sp of v.splashes) drawSplash(sp);
    for (const p of v.players) {
      const you = p.id === selfId;
      drawLivboj(p.x, p.y, p.r || 30, p.hue, you && (p.dashActive > 0), p.name, you);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawHUD(v);
    drawOverlays(v);
  }

  function drawWaitScreen(msg) {
    drawLivboj(CW / 2, CH / 2 - 30, 46, null, true, null, false);
    ctx.fillStyle = "#eaf6ff"; ctx.textAlign = "center"; ctx.font = "800 30px system-ui, sans-serif";
    ctx.fillText("Livbojen", CW / 2, CH / 2 + 40);
    ctx.font = "500 18px system-ui, sans-serif"; ctx.fillStyle = "#bfe0f2";
    ctx.fillText(msg, CW / 2, CH / 2 + 74);
  }

  function drawHUD(v) {
    ctx.textAlign = "left"; ctx.font = "700 20px system-ui, sans-serif"; ctx.fillStyle = "#eaf6ff";
    ctx.fillText(`Poäng ${v.hud.score}`, 18, 30);
    ctx.fillText(`Nivå ${v.hud.level + 1}/5`, 18, 56);
    ctx.textAlign = "center"; ctx.fillText(`Räddade ${v.hud.caught} / ${v.hud.quota}`, CW / 2, 30);
    ctx.font = "600 14px system-ui, sans-serif"; ctx.fillStyle = "#bfe0f2";
    ctx.fillText(`${v.hud.n} spelare`, CW / 2, 52);
    ctx.textAlign = "right"; ctx.font = "700 20px system-ui, sans-serif";
    const t = Math.ceil(v.hud.time); ctx.fillStyle = t <= 10 ? "#ff8a6a" : "#eaf6ff";
    ctx.fillText(`Tid ${t}s`, CW - 18, 30);
    ctx.fillStyle = "#ffd7c7"; ctx.fillText(`Missade ${v.hud.missed}/${v.hud.allowedMisses}`, CW - 18, 56);
    if (usingTouch && v.phase === Phase.PLAY) {
      ctx.save(); ctx.globalAlpha = 0.9; ctx.fillStyle = "#f4571d";
      ctx.beginPath(); ctx.arc(DASH_BTN.x, DASH_BTN.y, DASH_BTN.r, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
      ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.font = "800 18px system-ui, sans-serif";
      ctx.fillText("Spurt", DASH_BTN.x, DASH_BTN.y); ctx.textBaseline = "alphabetic"; ctx.restore();
    }
  }

  function panel(lines, sub) {
    ctx.fillStyle = "rgba(4,20,30,0.62)"; ctx.fillRect(0, 0, CW, CH);
    ctx.textAlign = "center"; ctx.fillStyle = "#eaf6ff"; ctx.font = "800 40px system-ui, sans-serif";
    let y = CH / 2 - (lines.length - 1) * 28 - (sub ? 24 : 0);
    for (const l of lines) { ctx.fillText(l, CW / 2, y); y += 52; }
    if (sub) { ctx.font = "500 20px system-ui, sans-serif"; ctx.fillStyle = "#bfe0f2"; ctx.fillText(sub, CW / 2, y + 6); }
  }
  function drawOverlays(v) {
    const prompt = (txt) => { ctx.font = "800 22px system-ui, sans-serif"; ctx.fillStyle = "#f4571d"; ctx.fillText(txt, CW / 2, CH / 2 + 74); };
    const canAdvance = mode !== "join";
    if (v.phase === Phase.INTRO) {
      panel([`Nivå ${v.hud.level + 1}`], `Rädda ${v.hud.quota} · ${v.hud.n} spelare`);
    } else if (v.phase === Phase.CLEARED) {
      panel(["Nivå avklarad!"], `Poäng ${v.hud.score}`);
      if (canAdvance) prompt(usingTouch ? "Tryck för nästa nivå" : "Tryck på blanksteg för nästa nivå");
      else { ctx.font = "600 18px system-ui, sans-serif"; ctx.fillStyle = "#bfe0f2"; ctx.fillText("Väntar på värden…", CW / 2, CH / 2 + 74); }
    } else if (v.phase === Phase.OVER) {
      panel(["Spelet är slut"], `Totalpoäng ${v.hud.score}`);
      if (canAdvance) prompt(usingTouch ? "Tryck för att spela igen" : "Tryck på blanksteg igen");
    } else if (v.phase === Phase.WIN) {
      panel(["Ni vann! 🛟", "Alla 5 nivåer klara"], `Slutpoäng ${v.hud.score}`);
      if (canAdvance) prompt(usingTouch ? "Tryck för att spela igen" : "Tryck på blanksteg igen");
    }
  }

  // ---- Loop ---------------------------------------------------------------
  let waveT = 0, last = performance.now();
  function frame(now) {
    let dt = (now - last) / 1000; last = now; if (dt > 0.05) dt = 0.05;
    waveT += dt;
    if (mode === "join") updateJoin(dt); else updateSim(dt);
    render();
    requestAnimationFrame(frame);
  }

  // ---- Input wiring -------------------------------------------------------
  const MOVE_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " ", "Space"]);
  addEventListener("keydown", (e) => {
    const k = e.key === " " ? "Space" : e.key; keys[k] = true;
    if (MOVE_KEYS.has(e.key) || MOVE_KEYS.has(k)) e.preventDefault();
    if (e.repeat) return;
    if (k === "Space") advance();
  }, { passive: false });
  addEventListener("keyup", (e) => { const k = e.key === " " ? "Space" : e.key; keys[k] = false; });

  function toCanvas(clientX, clientY) { const r = canvas.getBoundingClientRect(); return { x: (clientX - r.left) * (CW / r.width), y: (clientY - r.top) * (CH / r.height) }; }
  function inDash(cx, cy) { return Math.hypot(cx - DASH_BTN.x, cy - DASH_BTN.y) <= DASH_BTN.r; }
  canvas.addEventListener("touchstart", (e) => {
    usingTouch = true; e.preventDefault();
    const v = lastViewPhase();
    if (v === Phase.CLEARED || v === Phase.OVER || v === Phase.WIN) { advance(); return; }
    for (const t of e.changedTouches) {
      const c = toCanvas(t.clientX, t.clientY);
      if (inDash(c.x, c.y)) { dashTap = true; }
      else { const w = worldFromCanvas(c); pointerTarget = w; }
    }
  }, { passive: false });
  canvas.addEventListener("touchmove", (e) => { e.preventDefault(); for (const t of e.changedTouches) { const c = toCanvas(t.clientX, t.clientY); if (!inDash(c.x, c.y)) pointerTarget = worldFromCanvas(c); } }, { passive: false });
  canvas.addEventListener("touchend", (e) => { e.preventDefault(); if (e.touches.length === 0) pointerTarget = null; }, { passive: false });

  function currentWorld() { return mode === "join" ? (lastView && lastView.world) || world : world; }
  function worldFromCanvas(c) { const w = currentWorld(); return toWorld(c.x, c.y, w.w, w.h); }
  function lastViewPhase() { return mode === "join" ? (lastView && lastView.phase) : phase; }

  // ---- Public API ---------------------------------------------------------
  if (mode === "solo") setupSolo();
  else if (mode === "host") setupHost();
  else setupJoin();
  requestAnimationFrame(frame);

  return {
    hostStart,
    getRoom: () => opts.room,
    roster: rosterList,
  };
}

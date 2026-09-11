// Livbojen — shared engine: solo / host / join.
// Host-authoritative co-op over WebRTC P2P (Trystero, Nostr signaling), with
// STUN+TURN for NAT traversal and host migration if the host leaves.
import { joinRoom, selfId } from "https://cdn.jsdelivr.net/npm/trystero@0.21.5/nostr/+esm";

const APP_ID = "livboj-bookbeat-9f3a";
const MAX_PLAYERS = 12;
const SHORE_H = 70; // beach band along the bottom; rescued swimmers gather here
const shoreY = (w) => w.h - SHORE_H; // y where the water meets the sand

// STUN + a public best-effort TURN relay so most NATs can connect without setup.
const RTC = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun.relay.metered.ca:80" },
    { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
  ],
};

const BASE_LEVELS = [
  { quota: 5,  spawn: 1300, speed: 22, sink: 9.0, time: 45, maxOnScreen: 4, allowedMisses: 6 },
  { quota: 8,  spawn: 1050, speed: 34, sink: 8.0, time: 45, maxOnScreen: 5, allowedMisses: 5 },
  { quota: 12, spawn: 880,  speed: 48, sink: 7.0, time: 45, maxOnScreen: 6, allowedMisses: 4 },
  { quota: 16, spawn: 720,  speed: 64, sink: 6.0, time: 42, maxOnScreen: 7, allowedMisses: 4 },
  { quota: 20, spawn: 560,  speed: 84, sink: 5.2, time: 40, maxOnScreen: 8, allowedMisses: 3 },
];
const SKINS = ["#f7d3ad", "#e8b98f", "#c98d61", "#a86a44", "#f2c39b"];
const HAIRS = ["#3a2a1c", "#221b16", "#6b4a2a", "#0f0f10", "#8a5a2b", "#c9a24a"];
const SUITS = ["#e5484d", "#3aa0ff", "#ffb020", "#8b5cf6", "#22c55e", "#ec4899"];
const GULLS = [{ y: 46, sp: 26, x0: 0, ph: 0 }, { y: 82, sp: 34, x0: 220, ph: 1.4 }, { y: 62, sp: 20, x0: 440, ph: 2.7 }];
const HUES = [28, 205, 140, 320, 52, 265, 0, 175, 95, 235, 300, 185];

function worldSize(n) { return { w: Math.min(900 + (n - 1) * 170, 1560), h: Math.min(600 + (n - 1) * 120, 1040) }; }
function levelParams(idx, n) {
  const L = BASE_LEVELS[idx];
  return {
    quota: L.quota + (n - 1) * Math.ceil(L.quota * 0.5),
    spawn: L.spawn / (1 + (n - 1) * 0.35),
    speed: L.speed * (1 + (n - 1) * 0.05),
    sink: L.sink, time: L.time,
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

// ---- Sound (WebAudio, synthesized — no assets) ---------------------------
let audioCtx = null;
let muted = false;
try { muted = localStorage.getItem("livboj-muted") === "1"; } catch {}
function unlockAudio() {
  if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {} }
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
}
addEventListener("keydown", unlockAudio, { once: false });
addEventListener("pointerdown", unlockAudio, { once: false });
addEventListener("touchstart", unlockAudio, { once: false });
function beep(freq, dur, type = "sine", gain = 0.06, when = 0) {
  if (muted || !audioCtx) return;
  const t = audioCtx.currentTime + when;
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = type; o.frequency.value = freq;
  o.connect(g); g.connect(audioCtx.destination);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.start(t); o.stop(t + dur);
}
const sRescue = () => { unlockAudio(); beep(660, 0.09, "triangle", 0.07, 0); beep(990, 0.10, "triangle", 0.06, 0.07); };
const sMiss = () => { unlockAudio(); beep(190, 0.16, "sawtooth", 0.05, 0); };
const sClear = () => { unlockAudio(); [523, 659, 784, 1047].forEach((f, i) => beep(f, 0.12, "triangle", 0.06, i * 0.09)); };
const sOver = () => { unlockAudio(); [400, 300, 200].forEach((f, i) => beep(f, 0.18, "sawtooth", 0.05, i * 0.12)); };
const sWin = () => { unlockAudio(); [523, 659, 784, 1047, 1319].forEach((f, i) => beep(f, 0.14, "triangle", 0.07, i * 0.1)); };
const sDash = () => { beep(720, 0.05, "sawtooth", 0.04, 0); beep(520, 0.05, "sawtooth", 0.03, 0.04); };
const sStart = () => { unlockAudio(); [440, 620, 840].forEach((f, i) => beep(f, 0.09, "triangle", 0.05, i * 0.07)); };
const sTick = () => { beep(900, 0.05, "square", 0.045, 0); };
const sJoin = () => { unlockAudio(); beep(600, 0.08, "sine", 0.05, 0); beep(900, 0.09, "sine", 0.05, 0.08); };
const sChomp = () => { beep(95, 0.22, "sawtooth", 0.06, 0); beep(60, 0.2, "sawtooth", 0.05, 0.1); };
const sStun = () => { unlockAudio(); beep(300, 0.1, "square", 0.05, 0); beep(230, 0.1, "square", 0.05, 0.09); beep(180, 0.13, "square", 0.045, 0.18); };

// Loch Ness monsters appear from level 3 and hunt swimmers (never the livboj).
function monstersForLevel(idx) { return idx >= 2 ? Math.min(idx - 1, 3) : 0; }

// ---- Leaderboard (persisted in the host's browser) ------------------------
function loadBoard() { try { return JSON.parse(localStorage.getItem("livboj-leaderboard") || "[]"); } catch { return []; } }
function saveBoardLS(b) { try { localStorage.setItem("livboj-leaderboard", JSON.stringify(b)); } catch {} }

// ==========================================================================
export function createGame(canvas, opts) {
  const ctx = canvas.getContext("2d");
  const CW = canvas.width, CH = canvas.height;
  const mode = opts.mode; // 'solo' | 'host' | 'join'
  const myName = (opts.name || "Spelare").slice(0, 14);
  const cbs = opts.cbs || {};
  const Phase = { LOBBY: "lobby", INTRO: "intro", PLAY: "play", CLEARED: "cleared", OVER: "over", WIN: "win" };

  let authoritative = mode !== "join"; // solo & host run the sim; join receives
  let promoted = false;

  let world = worldSize(1);
  let obstacles = [], swimmers = [], splashes = [];
  let players = new Map();
  let levelIndex = 0, score = 0, caught = 0, missed = 0, timeLeft = 0, spawnTimer = 0, introTimer = 0;
  let phase = mode === "solo" ? Phase.INTRO : Phase.LOBBY;
  let swimmerSeq = 1, hueSeq = 0;
  let hostId = authoritative ? selfId : null;
  let fxOut = []; // rescue/miss events to broadcast this tick
  let lastSec = 999, jLastSec = 999; // countdown-tick trackers
  let board = loadBoard(); // host's own persisted leaderboard
  let netBoard = []; // leaderboard received from the host (joiners)
  let monsters = [], monsterSeq = 1;
  let saved = []; // rescued swimmers swimming to / cheering on the shore (cosmetic)

  const keys = Object.create(null);
  let usingTouch = false, pointerTarget = null, dashTap = false;
  const selfPos = { x: 0, y: 0, r: 30, dashActive: 0, dashCd: 0, seeded: false };

  const iSwim = new Map(), iPlayer = new Map(), iMonster = new Map();
  let jSplashes = [];
  let lastView = null, lastStateTime = 0;

  // Networking
  let room = null, sendState = null, sendInput = null, sendHello = null;
  const A = { st: null, inp: null, hi: null };
  let broadcasting = false;
  let electing = false, electAt = 0;
  const DASH_BTN = { x: CW - 66, y: CH - 66, r: 46 };
  const MUTE_BTN = { x: 28, y: CH - 28, r: 16 };

  // ---- Setup --------------------------------------------------------------
  function setupSolo() { addPlayer(selfId, myName); startLevel(0); phase = Phase.INTRO; introTimer = 2.4; emitPhase(); }
  function setupNet(asHost) {
    room = joinRoom({ appId: APP_ID, rtcConfig: RTC }, opts.room);
    A.st = room.makeAction("st");
    A.inp = room.makeAction("inp");
    A.hi = room.makeAction("hi");
    room.onPeerJoin((peer) => {
      if (authoritative) { addPlayer(peer, "Spelare"); sJoin(); emitRoster(); pushState(); }
      else if (sendHello) sendHello({ name: myName });
    });
    room.onPeerLeave((peer) => {
      if (authoritative) { players.delete(peer); emitRoster(); }
      else if (lastView && peer === lastView.hostId) electHost();
    });
    if (asHost) wireHost(); else wireJoin();
    if (authoritative) emitBoard();
  }
  function wireHost() {
    addPlayer(selfId, myName);
    sendState = (snap) => { try { A.st[0](snap); } catch {} };
    A.hi[1]((data, peer) => { if (!players.has(peer)) addPlayer(peer, (data && data.name) || "Spelare"); else renamePlayer(peer, (data && data.name) || "Spelare"); emitRoster(); pushState(); });
    A.inp[1]((data, peer) => { applyPeerInput(peer, data); });
    emitRoster();
    startBroadcast();
  }
  function wireJoin() {
    A.st[1]((data) => applyState(data));
    sendInput = (inp) => { try { A.inp[0](inp); } catch {} };
    sendHello = (d) => { try { A.hi[0](d); } catch {} };
    const iv = setInterval(() => { if (!lastView) sendHello({ name: myName }); else clearInterval(iv); }, 700);
    setInterval(() => { if (!authoritative && sendInput) sendInput({ x: Math.round(selfPos.x), y: Math.round(selfPos.y), dash: selfPos.dashActive > 0 ? 1 : 0, stun: selfPos.stun > 0 ? 1 : 0 }); }, 50);
  }
  function startBroadcast() { if (broadcasting) return; broadcasting = true; setInterval(() => { if (authoritative && room) pushState(); }, 50); }

  function addPlayer(id, name) {
    if (players.has(id)) return;
    if (players.size >= MAX_PLAYERS) return; // lobby full
    players.set(id, { id, name, x: world.w / 2, y: world.h / 2, r: 30, hue: HUES[(hueSeq++) % HUES.length], dashActive: 0, dashCooldown: 0, rescues: 0, input: { dx: 0, dy: 0, dash: false } });
  }
  function renamePlayer(id, name) { const p = players.get(id); if (p) p.name = (name || "Spelare").slice(0, 14); }
  // A peer owns its own position (co-op: trust the client so what it sees is real).
  function applyPeerInput(peer, data) {
    let p = players.get(peer);
    if (!p) { addPlayer(peer, "Spelare"); p = players.get(peer); emitRoster(); }
    if (p && data && typeof data.x === "number") {
      p.x = Math.max(p.r, Math.min(world.w - p.r, data.x));
      p.y = Math.max(p.r, Math.min(world.h - p.r, data.y));
      p.dashActive = data.dash ? 0.18 : 0;
      p.stunned = !!data.stun;
    }
  }
  function rosterList() { return [...players.values()].map((p) => ({ id: p.id, name: p.id === selfId ? myName : p.name, you: p.id === selfId })); }
  function emitBoard() { cbs.onBoard && cbs.onBoard(board); }
  function recordResult() {
    const entry = {
      score, level: levelIndex + 1, won: phase === Phase.WIN, n: players.size, ts: Date.now(),
      players: [...players.values()].map((p) => (p.id === selfId ? myName : p.name) || "Spelare"),
    };
    board.push(entry);
    board.sort((a, b) => b.score - a.score || b.ts - a.ts);
    board = board.slice(0, 10);
    saveBoardLS(board); emitBoard();
  }
  function clearBoard() { board = []; saveBoardLS(board); emitBoard(); }

  // A rescued swimmer heads for the beach and cheers once it arrives. Purely
  // cosmetic and spawned locally on every client (from the rescue event), so
  // it needs no network sync.
  function spawnSaved(x, y, sk, hr, id) {
    const W = authoritative ? world : (lastView && lastView.world) || world;
    const top = shoreY(W);
    saved.push({ x, y, tx: 40 + Math.random() * (W.w - 80), ty: top + 12 + Math.random() * (SHORE_H - 26), sk: sk || 0, hr: hr || 0, sid: id || ((Math.random() * 999) | 0), state: "swim", ph: Math.random() * 6, cheer: 0 });
    if (saved.length > 30) saved.shift();
  }
  function updateSaved(dt) {
    for (const sv of saved) {
      sv.ph += dt * 5;
      if (sv.state === "swim") {
        const dx = sv.tx - sv.x, dy = sv.ty - sv.y, d = Math.hypot(dx, dy);
        if (d < 4) { sv.x = sv.tx; sv.y = sv.ty; sv.state = "cheer"; }
        else { sv.x += (dx / d) * 155 * dt; sv.y += (dy / d) * 155 * dt; }
      } else sv.cheer += dt;
    }
  }
  function emitRoster() { cbs.onRoster && cbs.onRoster(rosterList()); }
  function emitPhase() { cbs.onPhase && cbs.onPhase(phase); }

  // ---- Level control ------------------------------------------------------
  function startLevel(idx) {
    const n = Math.max(1, players.size);
    world = worldSize(n);
    obstacles = makeObstacles(idx, world.w, world.h);
    const L = levelParams(idx, n);
    levelIndex = idx; caught = 0; missed = 0; timeLeft = L.time; spawnTimer = 0.4; swimmers = []; splashes = []; saved = [];
    // Spread players in a small ring around centre so rings/labels don't stack.
    const arr = [...players.values()], ring = arr.length > 1 ? 80 : 0;
    arr.forEach((p, i) => { const a = (i / arr.length) * Math.PI * 2; p.x = world.w / 2 + Math.cos(a) * ring; p.y = world.h / 2 + Math.sin(a) * ring; p.dashActive = 0; p.dashCooldown = 0; });
    const me = players.get(selfId);
    selfPos.x = me ? me.x : world.w / 2; selfPos.y = me ? me.y : world.h / 2;
    selfPos.stun = 0; selfPos.stunCd = 0;
    // Loch Ness monsters (level 3+): spawn near the edges, away from the middle.
    monsters = [];
    const mc = monstersForLevel(idx);
    for (let k = 0; k < mc; k++) {
      const edge = k % 4, m = 70;
      let x = m + Math.random() * (world.w - m * 2), y = m + Math.random() * (world.h - m * 2);
      if (edge === 0) y = m; else if (edge === 1) y = world.h - m; else if (edge === 2) x = m; else x = world.w - m;
      const a = Math.random() * Math.PI * 2;
      monsters.push({ id: monsterSeq++, x, y, vx: Math.cos(a) * 60, vy: Math.sin(a) * 60, r: 30, wob: Math.random() * 6, dir: a });
    }
  }
  function hostStart() {
    if (!authoritative || phase !== Phase.LOBBY) return;
    startLevel(0); phase = Phase.INTRO; introTimer = 2.4; emitPhase(); pushState();
  }
  function nextLevel() {
    levelIndex++;
    if (levelIndex >= BASE_LEVELS.length) { phase = Phase.WIN; recordResult(); sWin(); emitPhase(); pushState(); return; }
    startLevel(levelIndex); phase = Phase.INTRO; introTimer = 2.4; emitPhase(); pushState();
  }
  function toLobby() {
    levelIndex = 0; score = 0;
    for (const p of players.values()) p.rescues = 0;
    phase = Phase.LOBBY; emitPhase(); emitRoster(); emitBoard(); pushState();
  }
  function advance() {
    if (!authoritative) return;
    if (phase === Phase.LOBBY) { hostStart(); return; }
    if (phase === Phase.INTRO) { if (mode === "solo") { phase = Phase.PLAY; emitPhase(); } return; }
    if (phase === Phase.CLEARED) { nextLevel(); return; }
    if (phase === Phase.OVER || phase === Phase.WIN) {
      if (mode === "solo" && !promoted) { levelIndex = 0; score = 0; startLevel(0); phase = Phase.INTRO; introTimer = 2.4; emitPhase(); }
      else toLobby();
    }
  }

  function spawnSwimmer() {
    const n = Math.max(1, players.size);
    const L = levelParams(levelIndex, n);
    const margin = 60;
    let x, y, tries = 0;
    do { x = margin + Math.random() * (world.w - margin * 2); y = margin + Math.random() * (shoreY(world) - margin * 2); tries++; }
    while (tries < 20 && obstacles.some((o) => circleHitsRect(x, y, 26, o)));
    const ang = Math.random() * Math.PI * 2;
    swimmers.push({ id: swimmerSeq++, x, y, r: 16, vx: Math.cos(ang) * L.speed, vy: Math.sin(ang) * L.speed, life: L.sink, maxLife: L.sink, bob: Math.random() * Math.PI * 2, sk: (Math.random() * SKINS.length) | 0, hr: (Math.random() * HAIRS.length) | 0 });
  }

  // ---- Input --------------------------------------------------------------
  function localInput() {
    let dx = 0, dy = 0;
    if (keys.ArrowLeft) dx -= 1;
    if (keys.ArrowRight) dx += 1;
    if (keys.ArrowUp) dy -= 1;
    if (keys.ArrowDown) dy += 1;
    if (!dx && !dy && pointerTarget) {
      const ax = pointerTarget.x - selfPos.x, ay = pointerTarget.y - selfPos.y, d = Math.hypot(ax, ay);
      if (d > 5) { dx = ax / d; dy = ay / d; }
    }
    if (dx || dy) { const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len; }
    return { dx, dy, dash: !!keys.Space || dashTap };
  }

  function movePlayer(p, dt, input) {
    p.dashCooldown = Math.max(0, p.dashCooldown - dt);
    p.dashActive = Math.max(0, p.dashActive - dt);
    if (input.dash && p.dashCooldown === 0) { p.dashActive = 0.18; p.dashCooldown = 0.9; if (p.id === selfId) sDash(); }
    const speed = 300 * (p.dashActive > 0 ? 2.1 : 1);
    p.x += input.dx * speed * dt; p.y += input.dy * speed * dt;
    for (const o of obstacles) { const hit = circleHitsRect(p.x, p.y, p.r, o); if (hit) { p.x = hit.x; p.y = hit.y; } }
    p.x = Math.max(p.r, Math.min(world.w - p.r, p.x));
    p.y = Math.max(p.r, Math.min(shoreY(world) - p.r, p.y));
  }

  function updateMonsters(dt) {
    const mspeed = 55 + levelIndex * 10;
    for (const m of monsters) {
      let best = null, bd = 1e9;
      for (const s of swimmers) { const d = Math.hypot(s.x - m.x, s.y - m.y); if (d < bd) { bd = d; best = s; } }
      if (best) { const ang = Math.atan2(best.y - m.y, best.x - m.x); const k = Math.min(1, dt * 1.8); m.vx += (Math.cos(ang) * mspeed - m.vx) * k; m.vy += (Math.sin(ang) * mspeed - m.vy) * k; }
      else if (Math.hypot(m.vx, m.vy) < 12) { const a = Math.random() * Math.PI * 2; m.vx = Math.cos(a) * mspeed; m.vy = Math.sin(a) * mspeed; }
      m.x += m.vx * dt; m.y += m.vy * dt; m.wob = (m.wob || 0) + dt * 3;
      if (m.x < m.r || m.x > world.w - m.r) { m.vx *= -1; m.x = Math.max(m.r, Math.min(world.w - m.r, m.x)); }
      if (m.y < m.r || m.y > shoreY(world) - m.r) { m.vy *= -1; m.y = Math.max(m.r, Math.min(shoreY(world) - m.r, m.y)); }
      m.dir = Math.atan2(m.vy, m.vx);
    }
  }
  function updateSim(dt) {
    if (phase === Phase.INTRO) { introTimer -= dt; if (introTimer <= 0) { phase = Phase.PLAY; lastSec = Math.ceil(timeLeft); sStart(); emitPhase(); } return; }
    if (phase !== Phase.PLAY) return;
    const n = Math.max(1, players.size);
    const L = levelParams(levelIndex, n);

    // Only the local player is integrated here; remote players own their own
    // position and report it via applyPeerInput, so what each client sees is real.
    const meP = players.get(selfId);
    selfPos.stun = Math.max(0, (selfPos.stun || 0) - dt);
    selfPos.stunCd = Math.max(0, (selfPos.stunCd || 0) - dt);
    if (meP && selfPos.stun <= 0 && selfPos.stunCd <= 0) {
      for (const m of monsters) { if (Math.hypot(meP.x - m.x, meP.y - m.y) < m.r + meP.r) { selfPos.stun = 1.0; selfPos.stunCd = 1.5; sStun(); break; } }
    }
    if (meP) { movePlayer(meP, dt, selfPos.stun > 0 ? { dx: 0, dy: 0, dash: false } : localInput()); meP.stunned = selfPos.stun > 0; selfPos.x = meP.x; selfPos.y = meP.y; }
    for (const p of players.values()) { if (p.id !== selfId) p.dashActive = Math.max(0, p.dashActive - dt); }
    dashTap = false;

    timeLeft -= dt;
    const sec = Math.ceil(timeLeft);
    if (sec !== lastSec) { if (sec <= 3 && sec > 0) sTick(); lastSec = sec; }
    if (timeLeft <= 0) { timeLeft = 0; phase = Phase.OVER; recordResult(); sOver(); emitPhase(); pushState(); return; }

    spawnTimer -= dt;
    if (spawnTimer <= 0 && swimmers.length < L.maxOnScreen) { spawnSwimmer(); spawnTimer = L.spawn / 1000; }

    updateMonsters(dt);

    for (let i = swimmers.length - 1; i >= 0; i--) {
      const s = swimmers[i];
      s.x += s.vx * dt; s.y += s.vy * dt; s.bob += dt * 4;
      if (s.x < s.r || s.x > world.w - s.r) { s.vx *= -1; s.x = Math.max(s.r, Math.min(world.w - s.r, s.x)); }
      if (s.y < s.r || s.y > shoreY(world) - s.r) { s.vy *= -1; s.y = Math.max(s.r, Math.min(shoreY(world) - s.r, s.y)); }
      for (const o of obstacles) { const hit = circleHitsRect(s.x, s.y, s.r, o); if (hit) { s.x = hit.x; s.y = hit.y; const dot = s.vx * hit.nx + s.vy * hit.ny; s.vx -= 2 * dot * hit.nx; s.vy -= 2 * dot * hit.ny; } }
      s.life -= dt;

      let rescuer = null;
      for (const p of players.values()) { if (Math.hypot(s.x - p.x, s.y - p.y) < p.r + s.r) { rescuer = p; break; } }
      if (rescuer) {
        caught++; score += 10 + levelIndex * 5; rescuer.rescues = (rescuer.rescues || 0) + 1;
        splashes.push({ x: s.x, y: s.y, t: 0, good: true }); fxOut.push([Math.round(s.x), Math.round(s.y), 1, s.sk, s.hr, s.id]); sRescue(); spawnSaved(s.x, s.y, s.sk, s.hr, s.id);
        swimmers.splice(i, 1);
        if (caught >= L.quota) { phase = Phase.CLEARED; sClear(); emitPhase(); pushState(); return; }
        continue;
      }
      // Eaten by a Loch Ness monster? (counts as a miss; the livboj is safe.)
      let eaten = false;
      for (const m of monsters) { if (Math.hypot(s.x - m.x, s.y - m.y) < m.r + s.r) { eaten = true; break; } }
      if (eaten) {
        missed++; splashes.push({ x: s.x, y: s.y, t: 0, good: false }); fxOut.push([Math.round(s.x), Math.round(s.y), 2]); sChomp();
        swimmers.splice(i, 1);
        if (missed > L.allowedMisses) { phase = Phase.OVER; recordResult(); sOver(); emitPhase(); pushState(); return; }
        continue;
      }
      if (s.life <= 0) {
        missed++; splashes.push({ x: s.x, y: s.y, t: 0, good: false }); fxOut.push([Math.round(s.x), Math.round(s.y), 0]); sMiss();
        swimmers.splice(i, 1);
        if (missed > L.allowedMisses) { phase = Phase.OVER; recordResult(); sOver(); emitPhase(); pushState(); return; }
      }
    }
    for (let i = splashes.length - 1; i >= 0; i--) { splashes[i].t += dt; if (splashes[i].t > 0.6) splashes.splice(i, 1); }
  }

  function updateJoin(dt) {
    if (!lastView || lastView.phase !== Phase.PLAY) return;
    selfPos.stun = Math.max(0, (selfPos.stun || 0) - dt);
    selfPos.stunCd = Math.max(0, (selfPos.stunCd || 0) - dt);
    if (selfPos.stun <= 0 && selfPos.stunCd <= 0) {
      for (const mm of iMonster.values()) { if (Math.hypot(selfPos.x - mm.x, selfPos.y - mm.y) < (mm.r || 30) + selfPos.r) { selfPos.stun = 1.0; selfPos.stunCd = 1.5; sStun(); break; } }
    }
    const input = selfPos.stun > 0 ? { dx: 0, dy: 0, dash: false } : localInput();
    selfPos.dashActive = Math.max(0, selfPos.dashActive - dt);
    selfPos.dashCd = Math.max(0, selfPos.dashCd - dt);
    if (input.dash && selfPos.dashCd === 0) { selfPos.dashActive = 0.18; selfPos.dashCd = 0.9; sDash(); }
    const sp = 300 * (selfPos.dashActive > 0 ? 2.1 : 1);
    selfPos.x += input.dx * sp * dt; selfPos.y += input.dy * sp * dt;
    for (const o of (lastView.obstacles || [])) { const hit = circleHitsRect(selfPos.x, selfPos.y, selfPos.r, o); if (hit) { selfPos.x = hit.x; selfPos.y = hit.y; } }
    const w = lastView.world;
    selfPos.x = Math.max(selfPos.r, Math.min(w.w - selfPos.r, selfPos.x));
    selfPos.y = Math.max(selfPos.r, Math.min(shoreY(w) - selfPos.r, selfPos.y));
    dashTap = false;
  }

  // ---- State sync ---------------------------------------------------------
  function pushState() {
    if (!sendState) return;
    const L = levelParams(levelIndex, Math.max(1, players.size));
    const snap = {
      hostId: selfId, phase, levelIndex, score, caught, missed, timeLeft,
      quota: phase === Phase.LOBBY ? 0 : L.quota, allowedMisses: L.allowedMisses, world, introTimer,
      obstacles: obstacles.map((o) => [o.x, o.y, o.w, o.h]),
      swimmers: swimmers.map((s) => [s.id, Math.round(s.x), Math.round(s.y), s.r, +(s.life / s.maxLife).toFixed(2), s.sk, s.hr]),
      monsters: monsters.map((m) => [m.id, Math.round(m.x), Math.round(m.y), +m.dir.toFixed(2), m.r]),
      players: [...players.values()].map((p) => [p.id, Math.round(p.x), Math.round(p.y), p.name, p.dashActive > 0 ? 1 : 0, p.hue, p.rescues || 0, p.stunned ? 1 : 0]),
      fx: fxOut,
      board: (phase === Phase.LOBBY || phase === Phase.OVER || phase === Phase.WIN) ? board : undefined,
    };
    fxOut = [];
    try { sendState(snap); } catch {}
  }

  function applyState(d) {
    if (!d) return;
    lastStateTime = performance.now(); electing = false;
    const prevPhase = lastView && lastView.phase;
    lastView = {
      hostId: d.hostId, phase: d.phase, levelIndex: d.levelIndex, score: d.score, caught: d.caught, missed: d.missed,
      timeLeft: d.timeLeft, quota: d.quota, allowedMisses: d.allowedMisses, world: d.world, introTimer: d.introTimer,
      obstacles: (d.obstacles || []).map((o) => ({ x: o[0], y: o[1], w: o[2], h: o[3] })),
    };
    if (d.board) netBoard = d.board;
    lastView.board = netBoard;
    const seen = new Set();
    for (const s of d.swimmers || []) {
      seen.add(s[0]);
      const cur = iSwim.get(s[0]) || { x: s[1], y: s[2] };
      cur.tx = s[1]; cur.ty = s[2]; cur.r = s[3]; cur.frac = s[4]; cur.sk = s[5]; cur.hr = s[6];
      if (cur.x === undefined) { cur.x = s[1]; cur.y = s[2]; }
      iSwim.set(s[0], cur);
    }
    for (const id of [...iSwim.keys()]) if (!seen.has(id)) iSwim.delete(id);
    const seenM = new Set();
    for (const m of d.monsters || []) {
      seenM.add(m[0]);
      const cur = iMonster.get(m[0]) || { x: m[1], y: m[2] };
      cur.tx = m[1]; cur.ty = m[2]; cur.dir = m[3]; cur.r = m[4]; cur.wob = cur.wob || 0;
      if (cur.x === undefined) { cur.x = m[1]; cur.y = m[2]; }
      iMonster.set(m[0], cur);
    }
    for (const id of [...iMonster.keys()]) if (!seenM.has(id)) iMonster.delete(id);
    const seenP = new Set();
    for (const p of d.players || []) {
      seenP.add(p[0]);
      const cur = iPlayer.get(p[0]) || { x: p[1], y: p[2] };
      cur.id = p[0]; cur.tx = p[1]; cur.ty = p[2]; cur.name = p[3]; cur.dash = p[4]; cur.hue = p[5]; cur.rescues = p[6] || 0; cur.stun = p[7] || 0;
      if (cur.x === undefined) { cur.x = p[1]; cur.y = p[2]; }
      iPlayer.set(p[0], cur);
    }
    for (const id of [...iPlayer.keys()]) if (!seenP.has(id)) iPlayer.delete(id);
    for (const e of d.fx || []) { jSplashes.push({ x: e[0], y: e[1], t: 0, good: e[2] === 1 }); if (e[2] === 1) { sRescue(); spawnSaved(e[0], e[1], e[3], e[4], e[5]); } else (e[2] === 2 ? sChomp : sMiss)(); }
    if (!selfPos.seeded && d.phase === Phase.PLAY) { const meP = (d.players || []).find((p) => p[0] === selfId); if (meP) { selfPos.x = meP[1]; selfPos.y = meP[2]; selfPos.seeded = true; selfPos.stun = 0; selfPos.stunCd = 0; } }
    if (d.phase === Phase.LOBBY || d.phase === Phase.INTRO) selfPos.seeded = false;
    if (prevPhase !== d.phase) { if (d.phase === Phase.INTRO || d.phase === Phase.LOBBY) saved = []; if (d.phase === Phase.PLAY) { jLastSec = Math.ceil(d.timeLeft); sStart(); } else if (d.phase === Phase.CLEARED) sClear(); else if (d.phase === Phase.OVER) sOver(); else if (d.phase === Phase.WIN) sWin(); cbs.onPhase && cbs.onPhase(d.phase); }
    cbs.onRoster && cbs.onRoster((d.players || []).map((p) => ({ id: p[0], name: p[0] === selfId ? myName : p[3], you: p[0] === selfId })));
  }

  // ---- Host migration -----------------------------------------------------
  function electHost() {
    if (authoritative || electing || !lastView) return;
    electing = true; electAt = performance.now();
    const peers = new Set(room && room.getPeers ? Object.keys(room.getPeers()) : []);
    peers.add(selfId);
    const oldHost = lastView.hostId;
    const candidates = [...peers].filter((id) => id !== oldHost).sort();
    if (candidates.length && candidates[0] === selfId) becomeHost();
  }
  function becomeHost() {
    if (authoritative) return;
    authoritative = true; promoted = true; hostId = selfId;
    const v = lastView;
    world = v.world; obstacles = v.obstacles.map((o) => ({ ...o }));
    levelIndex = v.levelIndex; score = v.score; caught = v.caught; missed = v.missed; timeLeft = v.timeLeft; phase = v.phase;
    const L = levelParams(levelIndex, Math.max(1, iPlayer.size));
    players = new Map();
    for (const [id, p] of iPlayer) {
      if (id === v.hostId) continue;
      players.set(id, { id, name: id === selfId ? myName : (p.name || "Spelare"), x: id === selfId ? selfPos.x : p.x, y: id === selfId ? selfPos.y : p.y, r: 30, hue: p.hue, dashActive: 0, dashCooldown: 0, rescues: p.rescues || 0, input: { dx: 0, dy: 0, dash: false } });
    }
    if (!players.has(selfId)) addPlayer(selfId, myName);
    swimmers = [];
    for (const [id, s] of iSwim) { const ang = Math.random() * Math.PI * 2; swimmers.push({ id, x: s.x, y: s.y, r: s.r || 16, vx: Math.cos(ang) * L.speed, vy: Math.sin(ang) * L.speed, life: (s.frac || 1) * L.sink, maxLife: L.sink, bob: Math.random() * 6, sk: s.sk || 0, hr: s.hr || 0 }); swimmerSeq = Math.max(swimmerSeq, id + 1); }
    sendState = (snap) => { try { A.st[0](snap); } catch {} };
    A.hi[1]((data, peer) => { const p = players.get(peer); if (p) renamePlayer(peer, (data && data.name) || p.name); else addPlayer(peer, (data && data.name) || "Spelare"); emitRoster(); pushState(); });
    A.inp[1]((data, peer) => { applyPeerInput(peer, data); });
    startBroadcast();
    emitRoster(); emitPhase(); emitBoard(); pushState();
  }

  // ---- View for renderer --------------------------------------------------
  function currentView() {
    if (!authoritative) {
      if (!lastView) return null;
      const sm = 0.25;
      for (const s of iSwim.values()) { s.x += (s.tx - s.x) * sm; s.y += (s.ty - s.y) * sm; s.bob = (s.bob || 0) + 0.15; }
      for (const p of iPlayer.values()) { p.x += (p.tx - p.x) * sm; p.y += (p.ty - p.y) * sm; }
      for (const m of iMonster.values()) { m.x += (m.tx - m.x) * sm; m.y += (m.ty - m.y) * sm; m.wob = (m.wob || 0) + 0.12; }
      for (let i = jSplashes.length - 1; i >= 0; i--) { jSplashes[i].t += 0.03; if (jSplashes[i].t > 0.6) jSplashes.splice(i, 1); }
      return {
        world: lastView.world, obstacles: lastView.obstacles,
        swimmers: [...iSwim.values()], monsters: [...iMonster.values()],
        players: [...iPlayer.values()].map((p) => p.id === selfId ? { ...p, x: selfPos.x, y: selfPos.y } : p),
        splashes: jSplashes,
        hud: { score: lastView.score, level: lastView.levelIndex, caught: lastView.caught, quota: lastView.quota, time: lastView.timeLeft, missed: lastView.missed, allowedMisses: lastView.allowedMisses, n: iPlayer.size },
        phase: lastView.phase, introTimer: lastView.introTimer, board: lastView.board || [],
      };
    }
    const L = levelParams(levelIndex, Math.max(1, players.size));
    return { world, obstacles, swimmers, monsters, players: [...players.values()], splashes, hud: { score, level: levelIndex, caught, quota: L.quota, time: timeLeft, missed, allowedMisses: L.allowedMisses, n: players.size }, phase, introTimer, board };
  }

  // ---- Rendering ----------------------------------------------------------
  let waveT = 0;
  function fit(w, h) { const s = Math.min(CW / w, CH / h); return { s, ox: (CW - w * s) / 2, oy: (CH - h * s) / 2 }; }
  function toWorld(cx, cy, w, h) { const f = fit(w, h); return { x: (cx - f.ox) / f.s, y: (cy - f.oy) / f.s }; }
  function drawWater(w, h, t) {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "#155273"); g.addColorStop(0.5, "#0f4363"); g.addColorStop(1, "#0a2f45");
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    // three parallax wave layers for depth
    const layers = [
      { amp: 5, k: 0.016, sp: 0.6, op: 0.05, step: 26 },
      { amp: 7, k: 0.022, sp: 1.0, op: 0.07, step: 22 },
      { amp: 4, k: 0.030, sp: 1.6, op: 0.05, step: 20 },
    ];
    const rows = Math.max(5, Math.round(h / 78));
    for (const Ly of layers) {
      ctx.strokeStyle = `rgba(255,255,255,${Ly.op})`; ctx.lineWidth = 2;
      for (let row = 0; row < rows; row++) {
        const y0 = (row + 0.5) * (h / rows);
        ctx.beginPath();
        for (let x = 0; x <= w; x += Ly.step) { const y = y0 + Math.sin(x * Ly.k + t * Ly.sp + row) * Ly.amp; x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
        ctx.stroke();
      }
    }
    // twinkling surface glints
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    for (let i = 0; i < 26; i++) {
      const gx = (i * 137.5) % w, gy = (i * 89.3) % h, tw = 0.5 + 0.5 * Math.sin(t * 1.7 + i * 1.3);
      if (tw > 0.62) { ctx.globalAlpha = (tw - 0.62) * 0.7; ctx.beginPath(); ctx.arc(gx, gy, 1.4, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.globalAlpha = 1;
    // soft depth vignette
    const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.75);
    vg.addColorStop(0, "rgba(0,0,0,0)"); vg.addColorStop(1, "rgba(0,0,0,0.28)");
    ctx.fillStyle = vg; ctx.fillRect(0, 0, w, h);
  }
  function drawShore(w, h) {
    const y0 = shoreY({ w, h });
    const g = ctx.createLinearGradient(0, y0, 0, h);
    g.addColorStop(0, "#cdb583"); g.addColorStop(0.16, "#e7d4a4"); g.addColorStop(1, "#d6bd85");
    ctx.fillStyle = g; ctx.fillRect(0, y0, w, SHORE_H);
    ctx.fillStyle = "rgba(150,120,70,0.3)"; ctx.fillRect(0, y0, w, 9); // wet sand band
    // foam line where water meets sand
    ctx.fillStyle = "rgba(255,255,255,0.55)"; ctx.beginPath();
    for (let x = 0; x <= w; x += 14) { const yy = y0 + Math.sin(x * 0.05 + waveT * 1.6) * 3; x === 0 ? ctx.moveTo(x, yy) : ctx.lineTo(x, yy); }
    ctx.lineTo(w, y0 - 5); ctx.lineTo(0, y0 - 5); ctx.closePath(); ctx.fill();
    // sand speckles
    ctx.fillStyle = "rgba(120,95,55,0.22)";
    for (let i = 0; i < 46; i++) { const sx = (i * 97) % w, sy = y0 + 10 + ((i * 53) % (SHORE_H - 12)); ctx.beginPath(); ctx.arc(sx, sy, 1, 0, Math.PI * 2); ctx.fill(); }
  }
  function drawSaved(sv) {
    const skin = SKINS[sv.sk % SKINS.length], hair = HAIRS[sv.hr % HAIRS.length], suit = SUITS[sv.sid % SUITS.length];
    if (sv.state === "swim") {
      const cy = sv.y + Math.sin(sv.ph) * 1.5;
      ctx.strokeStyle = "rgba(190,225,240,0.35)"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.ellipse(sv.x, cy + 5, 12, 5, 0, 0, Math.PI * 2); ctx.stroke();
      const wv = Math.sin(sv.ph * 1.4) * 3;
      ctx.strokeStyle = skin; ctx.lineWidth = 3; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(sv.x - 5, cy); ctx.lineTo(sv.x - 10, cy - 5 + wv); ctx.moveTo(sv.x + 5, cy); ctx.lineTo(sv.x + 10, cy - 5 - wv); ctx.stroke(); ctx.lineCap = "butt";
      ctx.fillStyle = skin; ctx.beginPath(); ctx.arc(sv.x, cy, 8, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = hair; ctx.beginPath(); ctx.arc(sv.x, cy - 1, 8, Math.PI, Math.PI * 2); ctx.fill();
    } else {
      const jump = Math.abs(Math.sin(sv.cheer * 6)) * 6, bx = sv.x, by = sv.y - jump;
      ctx.fillStyle = "rgba(0,0,0,0.15)"; ctx.beginPath(); ctx.ellipse(sv.x, sv.y + 11, 9, 3, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = suit; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(bx - 5, by - 1, 10, 12, 3) : ctx.rect(bx - 5, by - 1, 10, 12); ctx.fill();
      ctx.strokeStyle = skin; ctx.lineWidth = 3; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(bx - 3, by + 11); ctx.lineTo(bx - 3, by + 18); ctx.moveTo(bx + 3, by + 11); ctx.lineTo(bx + 3, by + 18); ctx.stroke();
      const raise = 2 + Math.sin(sv.cheer * 6) * 2;
      ctx.beginPath(); ctx.moveTo(bx - 4, by + 1); ctx.lineTo(bx - 10, by - 8 - raise); ctx.moveTo(bx + 4, by + 1); ctx.lineTo(bx + 10, by - 8 - raise); ctx.stroke(); ctx.lineCap = "butt";
      ctx.fillStyle = skin; ctx.beginPath(); ctx.arc(bx, by - 8, 6, 0, Math.PI * 2); ctx.fill();
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
    // cabin
    ctx.fillStyle = "#cf934f"; ctx.fillRect(bx - cabW / 2, cy, cabW, cabH);
    ctx.fillStyle = "#0e3b52"; ctx.fillRect(bx - cabW * 0.32, cy + 5, cabW * 0.64, cabH * 0.4);
    ctx.fillStyle = "#a86a34"; ctx.fillRect(bx - cabW / 2, cy + cabH * 0.52, cabW, 3);
    // red-cross panel
    ctx.fillStyle = "#e5484d"; ctx.fillRect(bx - 7, cy + cabH * 0.6, 14, 10);
    ctx.fillStyle = "#fff"; ctx.fillRect(bx - 1.5, cy + cabH * 0.6 + 2, 3, 6); ctx.fillRect(bx - 5, cy + cabH * 0.6 + 3.5, 10, 3);
    // roof
    ctx.fillStyle = "#e5484d"; ctx.beginPath(); ctx.moveTo(bx - cabW * 0.62, cy); ctx.lineTo(bx, cy - 16); ctx.lineTo(bx + cabW * 0.62, cy); ctx.closePath(); ctx.fill();
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
    ctx.fillStyle = "#7a4f2a"; ctx.beginPath(); ctx.arc(bx, topY - 2, 2.6, 0, Math.PI * 2); ctx.fill();
  }
  function drawBeachBall(bx, by) {
    ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(bx, by, 8, 0, Math.PI * 2); ctx.fill();
    const cols = ["#e5484d", "#3aa0ff", "#ffb020"];
    for (let k = 0; k < 3; k++) { ctx.fillStyle = cols[k]; ctx.beginPath(); ctx.moveTo(bx, by); ctx.arc(bx, by, 8, k * 2 * Math.PI / 3, (k * 2 / 3 + 0.24) * Math.PI); ctx.closePath(); ctx.fill(); }
    ctx.strokeStyle = "rgba(0,0,0,0.15)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(bx, by, 8, 0, Math.PI * 2); ctx.stroke();
  }
  function drawStarfish(bx, by) {
    ctx.save(); ctx.translate(bx, by); ctx.fillStyle = "#f2884b"; ctx.beginPath();
    for (let k = 0; k < 5; k++) { const a = -Math.PI / 2 + k * 2 * Math.PI / 5; ctx.lineTo(Math.cos(a) * 7, Math.sin(a) * 7); const a2 = a + Math.PI / 5; ctx.lineTo(Math.cos(a2) * 3, Math.sin(a2) * 3); }
    ctx.closePath(); ctx.fill();
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
  function drawBrygga(o) {
    ctx.fillStyle = "rgba(0,0,0,0.18)"; ctx.fillRect(o.x + 4, o.y + 7, o.w, o.h);
    ctx.fillStyle = "#7a4f2a"; ctx.fillRect(o.x, o.y, o.w, o.h);
    ctx.strokeStyle = "rgba(40,24,10,0.5)"; ctx.lineWidth = 2;
    const horiz = o.w >= o.h, nn = Math.max(3, Math.round((horiz ? o.w : o.h) / 26));
    for (let i = 1; i < nn; i++) { if (horiz) { const x = o.x + (o.w / nn) * i; ctx.beginPath(); ctx.moveTo(x, o.y); ctx.lineTo(x, o.y + o.h); ctx.stroke(); } else { const y = o.y + (o.h / nn) * i; ctx.beginPath(); ctx.moveTo(o.x, y); ctx.lineTo(o.x + o.w, y); ctx.stroke(); } }
    ctx.fillStyle = "rgba(212,172,122,0.55)"; ctx.fillRect(o.x, o.y, o.w, 3);
    ctx.fillStyle = "#5c3a1e"; const ps = 7;
    [[o.x, o.y], [o.x + o.w - ps, o.y], [o.x, o.y + o.h - ps], [o.x + o.w - ps, o.y + o.h - ps]].forEach(([x, y]) => ctx.fillRect(x, y, ps, ps));
  }
  function drawLivboj(x, y, r, hue, glow, label, you, stunned) {
    ctx.save(); ctx.translate(x, y);
    if (stunned) ctx.globalAlpha = 0.6 + 0.25 * Math.sin(waveT * 20);
    if (hue != null) { ctx.strokeStyle = `hsl(${hue},85%,60%)`; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(0, 0, r + 5, 0, Math.PI * 2); ctx.stroke(); }
    if (glow) { ctx.shadowColor = "rgba(255,255,255,0.9)"; ctx.shadowBlur = 20; }
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.arc(0, 0, r * 0.55, 0, Math.PI * 2, true); ctx.fillStyle = "#f4571d"; ctx.fill("evenodd"); ctx.shadowBlur = 0;
    ctx.fillStyle = "#f4f4f0";
    for (let i = 0; i < 4; i++) { ctx.save(); ctx.rotate(i * Math.PI / 2 + Math.PI / 4); ctx.beginPath(); ctx.arc(0, 0, r, -0.32, 0.32); ctx.arc(0, 0, r * 0.55, 0.32, -0.32, true); ctx.closePath(); ctx.fill(); ctx.restore(); }
    ctx.strokeStyle = "rgba(0,0,0,0.28)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.arc(0, 0, r * 0.55, 0, Math.PI * 2); ctx.stroke();
    if (label) { ctx.fillStyle = you ? "#ffd7c7" : "#eaf6ff"; ctx.font = "700 14px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.fillText(you ? "Du" : label, 0, -r - 8); }
    ctx.globalAlpha = 1;
    if (stunned) { ctx.fillStyle = "#fdd23a"; ctx.font = "14px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; for (let i = 0; i < 3; i++) { const a = waveT * 4 + i * (Math.PI * 2 / 3); ctx.fillText("★", Math.cos(a) * r * 0.85, -r * 0.95 + Math.sin(a) * r * 0.22); } ctx.textBaseline = "alphabetic"; }
    ctx.restore();
  }
  function drawSwimmer(s) {
    const bobY = Math.sin(s.bob || 0) * 2.4, cx = s.x, cy = s.y + bobY, R = s.r;
    const frac = s.frac != null ? s.frac : Math.max(0, s.life / s.maxLife);
    const skin = SKINS[s.sk % SKINS.length], hair = HAIRS[s.hr % HAIRS.length];
    const suit = SUITS[(s.id || 0) % SUITS.length], ph = (s.id || 0) * 1.7;
    // soft shadow
    ctx.fillStyle = "rgba(0,0,0,0.15)"; ctx.beginPath(); ctx.ellipse(cx, cy + R * 1.05, R * 0.9, R * 0.32, 0, 0, Math.PI * 2); ctx.fill();
    // expanding ripple rings
    for (let k = 0; k < 2; k++) {
      const rp = (((s.bob || 0) * 0.35 + ph + k * 0.5) % 1 + 1) % 1;
      ctx.strokeStyle = `rgba(190,225,240,${0.3 * (1 - rp)})`; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.ellipse(cx, cy + 8, R * (1.1 + rp * 1.7), R * (0.55 + rp * 0.85), 0, 0, Math.PI * 2); ctx.stroke();
    }
    // sink-time ring (green -> red)
    ctx.strokeStyle = `hsl(${120 * frac},80%,55%)`; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(cx, cy, R + 9, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac); ctx.stroke();
    // torso in a swimsuit + a hint of legs under the surface
    ctx.globalAlpha = 0.55; ctx.fillStyle = skin; ctx.beginPath(); ctx.ellipse(cx, cy + R * 1.25, R * 0.5, R * 0.34, 0, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 0.92; ctx.fillStyle = suit; ctx.beginPath(); ctx.ellipse(cx, cy + R * 0.78, R * 0.7, R * 0.5, 0, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
    // waving arms + hands
    const wave = Math.sin((s.bob || 0) * 1.6) * 6;
    ctx.strokeStyle = skin; ctx.lineWidth = 5; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(cx - R * 0.5, cy + 2); ctx.lineTo(cx - R * 1.3, cy - 10 + wave); ctx.moveTo(cx + R * 0.5, cy + 2); ctx.lineTo(cx + R * 1.3, cy - 10 - wave); ctx.stroke();
    ctx.fillStyle = skin; ctx.beginPath(); ctx.arc(cx - R * 1.3, cy - 10 + wave, 3.8, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.arc(cx + R * 1.3, cy - 10 - wave, 3.8, 0, Math.PI * 2); ctx.fill(); ctx.lineCap = "butt";
    // water droplets flicking off the hands
    ctx.fillStyle = "rgba(205,235,247,0.85)";
    for (let k = 0; k < 2; k++) {
      const dp = (((s.bob || 0) * 0.5 + ph + k) % 1 + 1) % 1, dr = 2 * (1 - dp);
      if (dr > 0.5) { ctx.beginPath(); ctx.arc(cx + R * 1.3, cy - 10 - dp * 14 - wave, dr, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.arc(cx - R * 1.3, cy - 10 - dp * 14 + wave, dr, 0, Math.PI * 2); ctx.fill(); }
    }
    // hair BEHIND the head for long styles (drawn first)
    const style = (s.id || 0) % 5;
    ctx.fillStyle = hair;
    if (style === 2) { ctx.beginPath(); ctx.ellipse(cx, cy + R * 0.15, R * 0.9, R * 0.85, 0, 0, Math.PI * 2); ctx.fill(); } // long hair
    // head
    ctx.fillStyle = skin; ctx.beginPath(); ctx.arc(cx, cy, R * 0.8, 0, Math.PI * 2); ctx.fill();
    // hair styles on top
    ctx.fillStyle = hair;
    if (style === 0) { ctx.beginPath(); ctx.arc(cx, cy - 2, R * 0.8, Math.PI * 1.03, Math.PI * 1.97); ctx.fill(); ctx.beginPath(); ctx.arc(cx, cy - R * 0.28, R * 0.6, Math.PI, 0); ctx.fill(); } // short
    else if (style === 1) { ctx.beginPath(); ctx.arc(cx, cy - R * 0.06, R * 0.82, Math.PI * 0.96, Math.PI * 2.04); ctx.fill(); ctx.beginPath(); ctx.arc(cx, cy - R * 0.62, R * 0.28, 0, Math.PI * 2); ctx.fill(); } // top bun
    else if (style === 2) { ctx.beginPath(); ctx.arc(cx, cy - 2, R * 0.82, Math.PI, Math.PI * 2); ctx.fill(); } // long (cap over the behind-hair)
    else if (style === 3) { ctx.beginPath(); ctx.arc(cx, cy - 2, R * 0.78, Math.PI, Math.PI * 2); ctx.fill(); for (let k = -2; k <= 2; k++) { const a = cx + k * R * 0.28; ctx.beginPath(); ctx.moveTo(a - R * 0.14, cy - R * 0.4); ctx.lineTo(a, cy - R * 0.85); ctx.lineTo(a + R * 0.14, cy - R * 0.4); ctx.closePath(); ctx.fill(); } } // spiky
    else { ctx.beginPath(); ctx.arc(cx, cy - 2, R * 0.8, Math.PI * 1.05, Math.PI * 1.95); ctx.fill(); ctx.beginPath(); ctx.arc(cx - R * 0.72, cy + R * 0.05, R * 0.26, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.arc(cx + R * 0.72, cy + R * 0.05, R * 0.26, 0, Math.PI * 2); ctx.fill(); } // pigtails

    // eyes — blink occasionally
    const blink = Math.sin((s.bob || 0) * 0.9 + (s.id || 0) * 1.3) > 0.95;
    ctx.strokeStyle = "#2a2320"; ctx.fillStyle = "#2a2320"; ctx.lineWidth = 1.6;
    if (blink) { ctx.beginPath(); ctx.moveTo(cx - R * 0.38, cy - 1); ctx.lineTo(cx - R * 0.18, cy - 1); ctx.moveTo(cx + R * 0.18, cy - 1); ctx.lineTo(cx + R * 0.38, cy - 1); ctx.stroke(); }
    else { ctx.beginPath(); ctx.arc(cx - R * 0.28, cy - 1, 2, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.arc(cx + R * 0.28, cy - 1, 2, 0, Math.PI * 2); ctx.fill(); }
    // worried brows
    ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(cx - R * 0.42, cy - 6); ctx.lineTo(cx - R * 0.14, cy - 8); ctx.moveTo(cx + R * 0.14, cy - 8); ctx.lineTo(cx + R * 0.42, cy - 6); ctx.stroke();
    // mouth opens & closes (shouting for help)
    const gape = 1.4 + (Math.sin((s.bob || 0) * 3) + 1) * 2.2;
    ctx.fillStyle = "#6e3b32"; ctx.beginPath(); ctx.ellipse(cx, cy + R * 0.44, 2.8, gape, 0, 0, Math.PI * 2); ctx.fill();
    // occasional panic bubble
    const bp = (((s.bob || 0) * 0.4 + (s.id || 0)) % 1 + 1) % 1;
    if (bp < 0.5) { ctx.strokeStyle = "rgba(210,235,247,0.6)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx + R * 0.5, cy - R * 0.6 - bp * R, 1.5 + bp * 2, 0, Math.PI * 2); ctx.stroke(); }
  }
  function drawSplash(sp) { const p = sp.t / 0.6; ctx.strokeStyle = sp.good ? `rgba(120,230,160,${1 - p})` : `rgba(230,120,120,${1 - p})`; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(sp.x, sp.y, 6 + p * 26, 0, Math.PI * 2); ctx.stroke(); }
  function drawMonster(m) {
    const R = m.r || 30, t = m.wob || 0, flip = Math.cos(m.dir || 0) < 0 ? -1 : 1, bob = Math.sin(t) * 2;
    ctx.save(); ctx.translate(m.x, m.y + bob); ctx.scale(flip, 1);
    const body = ctx.createLinearGradient(0, -R, 0, R); body.addColorStop(0, "#4f9e58"); body.addColorStop(1, "#245f35");
    const dark = "#1f4f2b";

    // wake + foam bubbles behind
    ctx.strokeStyle = "rgba(210,235,245,0.22)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(-R * 0.2, R * 0.5, R * 1.95, R * 0.72, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "rgba(222,242,250,0.4)";
    for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.arc(-R * 1.6 - i * R * 0.42, R * 0.4 + Math.sin(t * 2 + i) * 3, 3 - i * 0.5, 0, Math.PI * 2); ctx.fill(); }

    // tail with fin
    ctx.fillStyle = "#2b6b3a";
    ctx.beginPath(); ctx.moveTo(-R * 1.45, 0); ctx.quadraticCurveTo(-R * 2.1, -R * 0.1 + Math.sin(t * 1.5) * R * 0.22, -R * 2.25, -R * 0.55);
    ctx.lineTo(-R * 1.95, -R * 0.12); ctx.quadraticCurveTo(-R * 2.05, R * 0.25, -R * 1.45, R * 0.22); ctx.closePath(); ctx.fill();

    // back humps + dorsal spikes (undulating)
    for (let i = 0; i < 3; i++) {
      const hx = -R * 1.15 + i * R * 0.6, hy = Math.sin(t * 1.6 + i * 0.9) * R * 0.14, hr = R * 0.4 - i * 2;
      ctx.fillStyle = dark; ctx.beginPath(); ctx.moveTo(hx - hr * 0.4, hy); ctx.lineTo(hx, hy - hr * 1.15); ctx.lineTo(hx + hr * 0.4, hy); ctx.closePath(); ctx.fill();
      ctx.fillStyle = body; ctx.beginPath(); ctx.arc(hx, hy, hr, Math.PI, 0); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.12)"; ctx.beginPath(); ctx.arc(hx - hr * 0.2, hy - hr * 0.12, hr * 0.5, Math.PI, 0); ctx.fill();
    }

    // main body + belly + scales + side fin
    ctx.fillStyle = body; ctx.beginPath(); ctx.ellipse(-R * 0.15, R * 0.02, R * 0.98, R * 0.58, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(206,228,158,0.5)"; ctx.beginPath(); ctx.ellipse(-R * 0.1, R * 0.3, R * 0.72, R * 0.28, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.10)";
    for (let i = 0; i < 8; i++) { ctx.beginPath(); ctx.arc(-R * 0.7 + i * R * 0.2, -R * 0.08 + (i % 2) * R * 0.14, 2, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = "#2b6b3a"; ctx.beginPath(); ctx.moveTo(-R * 0.1, R * 0.3);
    ctx.quadraticCurveTo(-R * 0.4, R * 0.95 + Math.sin(t * 2) * R * 0.12, -R * 0.62, R * 0.7); ctx.quadraticCurveTo(-R * 0.3, R * 0.5, -R * 0.1, R * 0.3); ctx.fill();

    // neck (thick, curved, sways) + ridge spikes
    const sway = Math.sin(t * 1.2) * R * 0.08;
    ctx.strokeStyle = body; ctx.lineWidth = R * 0.44; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(R * 0.35, R * 0.02); ctx.quadraticCurveTo(R * 0.85 + sway, -R * 0.7, R * 0.98 + sway, -R * 1.05); ctx.stroke();
    ctx.fillStyle = dark;
    for (let i = 0; i < 3; i++) { const nt = 0.4 + i * 0.2, nx = R * (0.42 + nt * 0.58) + sway * nt, ny = R * (0.02 - 1.1 * nt * nt); ctx.beginPath(); ctx.moveTo(nx - 3, ny); ctx.lineTo(nx, ny - 6); ctx.lineTo(nx + 3, ny); ctx.closePath(); ctx.fill(); }

    // head (animated mouth + teeth + eye)
    ctx.save(); ctx.translate(R * 1.02 + sway, -R * 1.08); ctx.rotate(-0.35);
    ctx.fillStyle = body; ctx.beginPath(); ctx.ellipse(0, 0, R * 0.44, R * 0.31, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(R * 0.36, R * 0.06, R * 0.21, R * 0.16, 0, 0, Math.PI * 2); ctx.fill();
    const gape = (Math.sin(t * 3) + 1) / 2 * R * 0.16 + 1.5;
    ctx.fillStyle = "#7a1f22"; ctx.beginPath();
    ctx.moveTo(R * 0.2, R * 0.12); ctx.lineTo(R * 0.56, R * 0.12 - gape * 0.3); ctx.lineTo(R * 0.56, R * 0.12 + gape); ctx.lineTo(R * 0.2, R * 0.12 + gape * 0.4); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#fff";
    for (let i = 0; i < 3; i++) { const tx = R * 0.28 + i * R * 0.09; ctx.beginPath(); ctx.moveTo(tx, R * 0.12); ctx.lineTo(tx + 3, R * 0.12); ctx.lineTo(tx + 1.5, R * 0.12 + 3.5); ctx.closePath(); ctx.fill(); }
    ctx.fillStyle = "#173d20"; ctx.beginPath(); ctx.arc(R * 0.52, R * 0.0, 1.8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = dark; ctx.beginPath(); ctx.moveTo(-R * 0.06, -R * 0.24); ctx.lineTo(R * 0.02, -R * 0.44); ctx.lineTo(R * 0.11, -R * 0.2); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#fdd23a"; ctx.beginPath(); ctx.arc(R * 0.06, -R * 0.05, R * 0.14, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#111"; ctx.beginPath(); ctx.ellipse(R * 0.09, -R * 0.05, R * 0.055, R * 0.1, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(R * 0.12, -R * 0.1, 2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    ctx.restore(); ctx.lineCap = "butt";
  }

  function render() {
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = "#08222f"; ctx.fillRect(0, 0, CW, CH);
    const v = currentView();
    if (!v) { drawWaitScreen("Ansluter…"); return; }
    if (v.phase === Phase.LOBBY) { drawLobbyScreen(v); return; }
    const f = fit(v.world.w, v.world.h);
    ctx.setTransform(f.s, 0, 0, f.s, f.ox, f.oy);
    drawWater(v.world.w, v.world.h, waveT);
    drawShore(v.world.w, v.world.h);
    drawScenery(v.world.w, v.world.h);
    for (const o of v.obstacles) drawBrygga(o);
    for (const s of v.swimmers) drawSwimmer(s);
    for (const m of v.monsters || []) drawMonster(m);
    for (const sv of saved) drawSaved(sv);
    if (v.splashes) for (const sp of v.splashes) drawSplash(sp);
    for (const p of v.players) { const you = p.id === selfId; const stunned = you ? selfPos.stun > 0 : !!(p.stunned || p.stun); drawLivboj(p.x, p.y, p.r || 30, p.hue, you && (p.dashActive > 0 || selfPos.dashActive > 0), p.name, you, stunned); }
    drawSeagulls(v.world.w, waveT);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawHUD(v); drawScoreboard(v); drawOverlays(v); drawMute();
  }
  function drawWaitScreen(msg) {
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
    ctx.fillText(authoritative ? "Tryck på blanksteg för att starta" : "Väntar på att värden startar…", CW / 2, CH / 2 - 8);
    const names = (v.players || []).map((p) => (p.id === selfId ? myName + " (du)" : (p.name || "Spelare")));
    ctx.font = "700 16px system-ui, sans-serif"; ctx.fillStyle = "#f4571d"; ctx.fillText(`${names.length} spelare i lobbyn`, CW / 2, CH / 2 + 22);
    ctx.font = "600 15px system-ui, sans-serif"; ctx.fillStyle = "#eaf6ff";
    let y = CH / 2 + 46; for (const nm of names.slice(0, 12)) { ctx.fillText(nm, CW / 2, y); y += 20; }
    drawMute();
  }
  function drawHUD(v) {
    ctx.textAlign = "left"; ctx.font = "700 20px system-ui, sans-serif"; ctx.fillStyle = "#eaf6ff";
    ctx.fillText(`Poäng ${v.hud.score}`, 18, 30); ctx.fillText(`Nivå ${v.hud.level + 1}/5`, 18, 56);
    ctx.textAlign = "center"; ctx.fillText(`Räddade ${v.hud.caught} / ${v.hud.quota}`, CW / 2, 30);
    ctx.font = "600 14px system-ui, sans-serif"; ctx.fillStyle = "#bfe0f2"; ctx.fillText(`${v.hud.n} spelare`, CW / 2, 52);
    ctx.textAlign = "right"; ctx.font = "700 20px system-ui, sans-serif";
    const t = Math.ceil(v.hud.time); ctx.fillStyle = t <= 10 ? "#ff8a6a" : "#eaf6ff"; ctx.fillText(`Tid ${t}s`, CW - 18, 30);
    ctx.fillStyle = "#ffd7c7"; ctx.fillText(`Missade ${v.hud.missed}/${v.hud.allowedMisses}`, CW - 18, 56);
    if (usingTouch && v.phase === Phase.PLAY) {
      ctx.save(); ctx.globalAlpha = 0.9; ctx.fillStyle = "#f4571d"; ctx.beginPath(); ctx.arc(DASH_BTN.x, DASH_BTN.y, DASH_BTN.r, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
      ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.font = "800 18px system-ui, sans-serif"; ctx.fillText("Spurt", DASH_BTN.x, DASH_BTN.y); ctx.textBaseline = "alphabetic"; ctx.restore();
    }
  }
  function drawScoreboard(v) {
    if (v.hud.n < 2 || !v.players) return;
    const board = [...v.players].map((p) => ({ name: p.id === selfId ? "Du" : (p.name || "Spelare"), rescues: p.rescues || 0, hue: p.hue })).sort((a, b) => b.rescues - a.rescues).slice(0, 6);
    let y = 84;
    ctx.textAlign = "left"; ctx.font = "700 14px system-ui, sans-serif";
    for (const b of board) {
      ctx.fillStyle = `hsl(${b.hue},85%,60%)`; ctx.beginPath(); ctx.arc(24, y - 4, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#eaf6ff"; ctx.fillText(`${b.name}: ${b.rescues}`, 36, y); y += 20;
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
    else if (v.phase === Phase.CLEARED) { panel(["Nivå avklarad!"], `Poäng ${v.hud.score}`); authoritative ? prompt(usingTouch ? "Tryck för nästa nivå" : "Tryck på blanksteg för nästa nivå") : wait(); }
    else if (v.phase === Phase.OVER) drawEndScreen(["Spelet är slut"], `Totalpoäng ${v.hud.score}`, v);
    else if (v.phase === Phase.WIN) drawEndScreen(["Ni vann! 🛟", "Alla 5 nivåer klara"], `Slutpoäng ${v.hud.score}`, v);
  }
  function drawEndScreen(lines, sub, v) {
    ctx.fillStyle = "rgba(4,20,30,0.76)"; ctx.fillRect(0, 0, CW, CH);
    ctx.textAlign = "center";
    let y = 78;
    ctx.fillStyle = "#eaf6ff"; ctx.font = "800 34px system-ui, sans-serif";
    for (const l of lines) { ctx.fillText(l, CW / 2, y); y += 40; }
    ctx.font = "500 18px system-ui, sans-serif"; ctx.fillStyle = "#bfe0f2"; ctx.fillText(sub, CW / 2, y); y += 34;
    ctx.font = "800 18px system-ui, sans-serif"; ctx.fillStyle = "#f4571d"; ctx.fillText("🏆 Topplista", CW / 2, y); y += 26;
    const b = v.board || [];
    ctx.font = "600 15px system-ui, sans-serif"; ctx.fillStyle = "#eaf6ff";
    if (!b.length) { ctx.fillText("Inga resultat än", CW / 2, y); y += 22; }
    else b.slice(0, 5).forEach((e, i) => { const names = (e.players || []).join(", "); ctx.fillText(`${i + 1}.  ${e.score} p  —  ${names}  (Nivå ${e.level})`, CW / 2, y); y += 22; });
    y += 18;
    if (authoritative) { ctx.font = "800 20px system-ui, sans-serif"; ctx.fillStyle = "#f4571d"; ctx.fillText(usingTouch ? "Tryck för lobbyn" : "Tryck på blanksteg för lobbyn", CW / 2, y); }
    else { ctx.font = "600 16px system-ui, sans-serif"; ctx.fillStyle = "#bfe0f2"; ctx.fillText("Väntar på värden…", CW / 2, y); }
  }
  function drawMute() {
    ctx.font = "16px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(muted ? "🔇" : "🔊", MUTE_BTN.x, MUTE_BTN.y); ctx.textBaseline = "alphabetic";
  }

  // ---- Loop ---------------------------------------------------------------
  let last = performance.now();
  function frame(now) {
    let dt = (now - last) / 1000; last = now; if (dt > 0.05) dt = 0.05; waveT += dt;
    if (authoritative) updateSim(dt); else updateJoin(dt);
    updateSaved(dt);
    if (!authoritative && lastView) {
      if (lastView.phase === Phase.PLAY) { const sec = Math.ceil(lastView.timeLeft); if (sec !== jLastSec) { if (sec <= 3 && sec > 0) sTick(); jLastSec = sec; } }
      const t = performance.now(); if (t - lastStateTime > 3000) { if (!electing) electHost(); else if (t - electAt > 4000) electing = false; }
    }
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
    if (k === "m" || k === "M") toggleMute();
  }, { passive: false });
  addEventListener("keyup", (e) => { const k = e.key === " " ? "Space" : e.key; keys[k] = false; });

  function toCanvas(clientX, clientY) { const r = canvas.getBoundingClientRect(); return { x: (clientX - r.left) * (CW / r.width), y: (clientY - r.top) * (CH / r.height) }; }
  function inDash(cx, cy) { return Math.hypot(cx - DASH_BTN.x, cy - DASH_BTN.y) <= DASH_BTN.r; }
  function inMute(cx, cy) { return Math.hypot(cx - MUTE_BTN.x, cy - MUTE_BTN.y) <= MUTE_BTN.r + 8; }
  function toggleMute() { muted = !muted; try { localStorage.setItem("livboj-muted", muted ? "1" : "0"); } catch {} if (!muted) unlockAudio(); }
  function curWorld() { return authoritative ? world : (lastView && lastView.world) || world; }
  function curPhase() { return authoritative ? phase : (lastView && lastView.phase); }
  canvas.addEventListener("mousedown", (e) => { const c = toCanvas(e.clientX, e.clientY); if (inMute(c.x, c.y)) toggleMute(); }, { passive: true });
  canvas.addEventListener("touchstart", (e) => {
    usingTouch = true; e.preventDefault();
    for (const t of e.changedTouches) {
      const c = toCanvas(t.clientX, t.clientY);
      if (inMute(c.x, c.y)) { toggleMute(); continue; }
      const ph = curPhase();
      if (ph === Phase.CLEARED || ph === Phase.OVER || ph === Phase.WIN || ph === Phase.LOBBY) { advance(); continue; }
      if (inDash(c.x, c.y)) dashTap = true; else pointerTarget = toWorld(c.x, c.y, curWorld().w, curWorld().h);
    }
  }, { passive: false });
  canvas.addEventListener("touchmove", (e) => { e.preventDefault(); for (const t of e.changedTouches) { const c = toCanvas(t.clientX, t.clientY); if (!inDash(c.x, c.y) && !inMute(c.x, c.y)) pointerTarget = toWorld(c.x, c.y, curWorld().w, curWorld().h); } }, { passive: false });
  canvas.addEventListener("touchend", (e) => { e.preventDefault(); if (e.touches.length === 0) pointerTarget = null; }, { passive: false });

  // ---- Boot ---------------------------------------------------------------
  if (mode === "solo") setupSolo();
  else if (mode === "host") setupNet(true);
  else setupNet(false);
  requestAnimationFrame(frame);

  return {
    hostStart, getRoom: () => opts.room, roster: rosterList, clearBoard,
    _jump: (idx) => { if (authoritative) { levelIndex = Math.max(0, Math.min(BASE_LEVELS.length - 1, idx | 0)); startLevel(levelIndex); phase = Phase.PLAY; emitPhase(); pushState(); } },
    debug: () => ({
      authoritative, promoted,
      phase: authoritative ? phase : (lastView && lastView.phase),
      timeLeft: Math.round(authoritative ? timeLeft : (lastView ? lastView.timeLeft : -1)),
      n: authoritative ? players.size : iPlayer.size, hasState: !!lastView,
      caught: authoritative ? caught : (lastView ? lastView.caught : 0),
      level: authoritative ? levelIndex : (lastView ? lastView.levelIndex : 0),
      monsters: authoritative ? monsters.length : iMonster.size,
      rescues: [...(authoritative ? players.values() : iPlayer.values())].map((p) => ({ you: p.id === selfId, r: p.rescues || 0 })),
      sw: authoritative ? swimmers.map((s) => [Math.round(s.x), Math.round(s.y)]) : [...iSwim.values()].map((s) => [Math.round(s.x), Math.round(s.y)]),
      self: { x: Math.round(selfPos.x), y: Math.round(selfPos.y) },
      saved: saved.length,
    }),
  };
}

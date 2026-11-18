// Livbojen — the simulation: game rules, levels, swimmers, monsters,
// whirlpools, swamps, docks, collisions, scoring and phase transitions.
//
// Pure: no DOM, canvas, audio, network, storage or clock reads. Randomness
// comes from an injectable `rng` (Math.random in the game, seeded in
// tools/sim-test.mjs). Everything the game does in response (sounds, phase
// callbacks, pushing state to joiners, recording a result, the cosmetic
// "saved" swimmers) goes out through `hooks`, called at the exact point the
// old inline code did it, so the order of side effects is unchanged.
//
// Only solo and the host (and a promoted host) run this; a joiner just draws
// the host's snapshots (game.js updateJoin / applyState).
//
// No imports on purpose: node runs this file as-is (tools/sim-test.mjs).

export const MAX_PLAYERS = 12;
export const SHORE_H = 70; // beach band along the bottom; rescued swimmers gather here
export const EAT_DWELL = 1.25; // seconds a monster must hold a swimmer before eating it
export const shoreY = (w) => w.h - SHORE_H; // y where the water meets the sand

export const Phase = { LOBBY: "lobby", INTRO: "intro", PLAY: "play", CLEARED: "cleared", OVER: "over", WIN: "win" };

export const BASE_LEVELS = [
  // allowedMisses scales with the quota (~20%) so late levels stay fair.
  { quota: 8,  spawn: 1300, speed: 22, sink: 10.0, maxOnScreen: 5,  allowedMisses: 6 }, // longer intro level: get the feel
  { quota: 10, spawn: 1100, speed: 32, sink: 9.0,  maxOnScreen: 5,  allowedMisses: 6 }, // first Nessie shows up here
  { quota: 12, spawn: 950,  speed: 44, sink: 8.5,  maxOnScreen: 6,  allowedMisses: 5 },
  { quota: 16, spawn: 820,  speed: 56, sink: 8.0,  maxOnScreen: 7,  allowedMisses: 6 },
  { quota: 20, spawn: 700,  speed: 68, sink: 7.5,  maxOnScreen: 8,  allowedMisses: 6 },
  { quota: 26, spawn: 620,  speed: 78, sink: 7.0,  maxOnScreen: 9,  allowedMisses: 6 },
  { quota: 32, spawn: 540,  speed: 88, sink: 6.5,  maxOnScreen: 10, allowedMisses: 7 },
  { quota: 40, spawn: 470,  speed: 98, sink: 6.0,  maxOnScreen: 11, allowedMisses: 8 },
];
export const SKINS = ["#f7d3ad", "#e8b98f", "#c98d61", "#a86a44", "#f2c39b"];
export const HAIRS = ["#3a2a1c", "#221b16", "#6b4a2a", "#0f0f10", "#8a5a2b", "#c9a24a"];
export const HUES = [28, 205, 140, 320, 52, 265, 0, 175, 95, 235, 300, 185];

export function worldSize(n) { return { w: Math.min(900 + (n - 1) * 170, 1560), h: Math.min(600 + (n - 1) * 120, 1040) }; }
export function levelParams(idx, n) {
  const L = BASE_LEVELS[idx];
  return {
    quota: L.quota + (n - 1) * Math.ceil(L.quota * 0.5),
    spawn: L.spawn / (1 + (n - 1) * 0.35),
    speed: L.speed * (1 + (n - 1) * 0.05),
    sink: L.sink,
    maxOnScreen: L.maxOnScreen + (n - 1) * 2,
    allowedMisses: L.allowedMisses + (n - 1),
  };
}
export function makeObstacles(idx, w, h) {
  const specs = [
    [], // 1 — open water
    [{ x: 130, y: 150, w: 230, h: 34 }], // 2
    [{ x: 90, y: 140, w: 320, h: 34 }, { x: 620, y: 290, w: 40, h: 230 }], // 3
    [{ x: 80, y: 120, w: 300, h: 34 }, { x: 560, y: 150, w: 40, h: 290 }, { x: 300, y: 440, w: 340, h: 36 }], // 4
    [{ x: 70, y: 110, w: 280, h: 32 }, { x: 660, y: 120, w: 40, h: 270 }, { x: 120, y: 445, w: 320, h: 34 }, { x: 560, y: 370, w: 40, h: 170 }], // 5
    [{ x: 60, y: 100, w: 380, h: 32 }, { x: 660, y: 110, w: 40, h: 300 }, { x: 120, y: 300, w: 40, h: 220 }, { x: 300, y: 450, w: 360, h: 34 }], // 6
    [{ x: 80, y: 110, w: 320, h: 32 }, { x: 500, y: 110, w: 320, h: 32 }, { x: 80, y: 300, w: 40, h: 240 }, { x: 410, y: 270, w: 40, h: 270 }, { x: 200, y: 470, w: 440, h: 32 }], // 7
    [{ x: 60, y: 100, w: 420, h: 30 }, { x: 560, y: 100, w: 300, h: 30 }, { x: 80, y: 250, w: 40, h: 300 }, { x: 300, y: 230, w: 40, h: 320 }, { x: 520, y: 300, w: 40, h: 260 }, { x: 160, y: 480, w: 520, h: 30 }], // 8 — dense maze
  ];
  const sx = w / 900, sy = h / 600;
  return (specs[idx] || []).map((o) => ({ x: o.x * sx, y: o.y * sy, w: o.w * sx, h: o.h * sy }));
}
// Swamp zones (level 4+): murky patches where the livboj moves slowly.
// Docks may run through them; monsters and swimmers are unaffected.
export function makeSwamps(idx, w, h) {
  const specs = [
    [], [], [],
    [{ x: 60, y: 300, w: 260, h: 180 }], // 4
    [{ x: 560, y: 60, w: 300, h: 200 }], // 5
    [{ x: 40, y: 60, w: 280, h: 200 }, { x: 600, y: 320, w: 260, h: 180 }], // 6
    [{ x: 520, y: 40, w: 340, h: 190 }, { x: 40, y: 340, w: 300, h: 170 }], // 7
    [{ x: 40, y: 40, w: 300, h: 180 }, { x: 580, y: 200, w: 280, h: 190 }, { x: 220, y: 330, w: 200, h: 170 }], // 8
  ];
  const sx = w / 900, sy = h / 600;
  return (specs[idx] || []).map((z) => ({ x: z.x * sx, y: z.y * sy, w: z.w * sx, h: z.h * sy }));
}
// Whirlpools (levels 6 and 7): slowly draw swimmers toward the centre; one that
// reaches the core is lost (counts as a miss). The livboj feels a weaker pull.
export function makeWhirls(idx, w, h) {
  const specs = [[], [], [], [], [], [{ x: 530, y: 240, r: 90 }], [{ x: 660, y: 360, r: 100 }], []]; // clear of docks, swamps and the spawn ring
  const sx = w / 900, sy = h / 600;
  return (specs[idx] || []).map((z) => ({ x: z.x * sx, y: z.y * sy, r: z.r * Math.min(sx, sy) }));
}
export const WHIRL_PULL = 30, WHIRL_SPIN = 55, WHIRL_PLAYER = 0.35, WHIRL_CORE = 0.16;
export const SWAMP_SLOW = 0.55;
export const inRect = (x, y, z) => x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h;
// Swamps are drawn as blobs (an ellipse inscribed in the zone), so the slow zone is that ellipse too.
export const inSwamp = (x, y, z) => { const nx = (x - z.x - z.w / 2) / (z.w / 2), ny = (y - z.y - z.h / 2) / (z.h / 2); return nx * nx + ny * ny <= 1.08; };
export function circleHitsRect(px, py, pr, o) {
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

// Loch Ness monsters hunt swimmers (never the livboj): one from level 2,
// two on level 4, three from level 5.
export function monstersForLevel(idx) { return idx >= 1 ? Math.min(Math.max(1, idx - 1), 3) : 0; }

// Whirlpool pull on a point: inward plus a swirl, stronger toward the centre.
export function whirlPull(o, list, dt, factor) {
  for (const z of list) {
    const dx = z.x - o.x, dy = z.y - o.y, d = Math.hypot(dx, dy) || 1;
    if (d >= z.r) continue;
    const k = 1 - d / z.r, pull = (WHIRL_PULL * k * k + 6) * factor, spin = WHIRL_SPIN * k * factor;
    o.x += (dx / d * pull - dy / d * spin) * dt; o.y += (dy / d * pull + dx / d * spin) * dt;
  }
}

const NO_INPUT = { dx: 0, dy: 0, dash: false };

/**
 * The authoritative game state and the rules that step it.
 *
 *   rng      () => [0, 1)  (default Math.random)
 *   selfId   () => the local player's id (it can change before the game starts: P2P signaling)
 *   selfPos  the local player's shared position / stun record (game.js reads and writes it too)
 *   hooks    { sound(name), phase(), push(), result(), rescued(swimmer), levelStarted() } — all optional
 *
 * The state lives on the returned object (S.phase, S.players, S.swimmers, …):
 * game.js reads it for snapshots and the view, and writes it on host migration.
 */
export function createSim({ rng = Math.random, selfId = () => null, selfPos = { x: 0, y: 0, r: 30, dashActive: 0, dashCd: 0, seeded: false }, hooks = {} } = {}) {
  const fire = (k, a) => { const f = hooks[k]; if (f) f(a); };
  const S = {
    rng, selfPos,
    world: worldSize(1),
    obstacles: [], swimmers: [], splashes: [], swamps: [], whirls: [],
    players: new Map(),
    levelIndex: 0, score: 0, caught: 0, missed: 0, timeLeft: 0, spawnTimer: 0, introTimer: 0,
    phase: Phase.LOBBY,
    swimmerSeq: 1, hueSeq: 0,
    fxOut: [], // rescue/miss events to broadcast this tick
    lastSec: 999, // countdown-tick tracker
    // Per-game stats for the leaderboard: swimmers rescued, best rescue streak.
    totalCaught: 0, combo: 0, bestCombo: 0,
    monsters: [], monsterSeq: 1,
  };

  S.beginGame = function beginGame() {
    S.totalCaught = 0; S.combo = 0; S.bestCombo = 0; S.levelIndex = 0; S.score = 0;
    for (const p of S.players.values()) { p.rescues = 0; p.score = 0; }
  };

  S.addPlayer = function addPlayer(id, name) {
    if (S.players.has(id)) return;
    if (S.players.size >= MAX_PLAYERS) return; // lobby full
    S.players.set(id, { id, name, x: S.world.w / 2, y: S.world.h / 2, r: 30, hue: HUES[(S.hueSeq++) % HUES.length], dashActive: 0, dashCooldown: 0, rescues: 0, score: 0, input: { dx: 0, dy: 0, dash: false } });
  };
  S.renamePlayer = function renamePlayer(id, name) { const p = S.players.get(id); if (p) p.name = (name || "Spelare").slice(0, 14); };

  // ---- Level control ------------------------------------------------------
  S.startLevel = function startLevel(idx) {
    const n = Math.max(1, S.players.size);
    S.world = worldSize(n);
    S.obstacles = makeObstacles(idx, S.world.w, S.world.h);
    S.swamps = makeSwamps(idx, S.world.w, S.world.h);
    S.whirls = makeWhirls(idx, S.world.w, S.world.h);
    const L = levelParams(idx, n);
    S.levelIndex = idx; S.caught = 0; S.missed = 0; S.timeLeft = 0; S.spawnTimer = 0.4; S.swimmers = []; S.splashes = [];
    // Spread players in a small ring around centre so rings/labels don't stack.
    const arr = [...S.players.values()], ring = arr.length > 1 ? 80 : 0;
    arr.forEach((p, i) => { const a = (i / arr.length) * Math.PI * 2; p.x = S.world.w / 2 + Math.cos(a) * ring; p.y = S.world.h / 2 + Math.sin(a) * ring; p.dashActive = 0; p.dashCooldown = 0; });
    const me = S.players.get(selfId());
    selfPos.x = me ? me.x : S.world.w / 2; selfPos.y = me ? me.y : S.world.h / 2;
    selfPos.stun = 0; selfPos.stunCd = 0;
    fire("levelStarted"); // game.js: clears the cosmetic shore crowd, notes each player's score at the start
    // Loch Ness monsters (level 2+): spawn near the edges, away from the middle.
    S.monsters = [];
    const mc = monstersForLevel(idx);
    for (let k = 0; k < mc; k++) {
      const edge = k % 4, m = 70;
      let x = m + rng() * (S.world.w - m * 2), y = m + rng() * (S.world.h - m * 2);
      if (edge === 0) y = m; else if (edge === 1) y = S.world.h - m; else if (edge === 2) x = m; else x = S.world.w - m;
      const a = rng() * Math.PI * 2;
      S.monsters.push({ id: S.monsterSeq++, x, y, vx: Math.cos(a) * 60, vy: Math.sin(a) * 60, r: 30, wob: rng() * 6, dir: a });
    }
  };
  // CLEARED -> the next level's INTRO, or WIN after the last one.
  S.nextLevel = function nextLevel() {
    // After the last level the index stays on it: an index past the end made levelParams throw,
    // which stopped the frame loop before the win screen was ever drawn.
    if (S.levelIndex + 1 >= BASE_LEVELS.length) { S.phase = Phase.WIN; fire("result"); fire("sound", "win"); fire("phase"); fire("push"); return; }
    S.levelIndex++;
    S.startLevel(S.levelIndex); S.phase = Phase.INTRO; S.introTimer = 2.4; fire("phase"); fire("push");
  };

  function spawnSwimmer() {
    const n = Math.max(1, S.players.size);
    const L = levelParams(S.levelIndex, n);
    const margin = 60;
    let x, y, tries = 0;
    do { x = margin + rng() * (S.world.w - margin * 2); y = margin + rng() * (shoreY(S.world) - margin * 2); tries++; }
    while (tries < 20 && S.obstacles.some((o) => circleHitsRect(x, y, 26, o)));
    const ang = rng() * Math.PI * 2;
    S.swimmers.push({ id: S.swimmerSeq++, x, y, r: 16, vx: Math.cos(ang) * L.speed, vy: Math.sin(ang) * L.speed, life: L.sink, maxLife: L.sink, bob: rng() * Math.PI * 2, sk: (rng() * SKINS.length) | 0, hr: (rng() * HAIRS.length) | 0 });
  }

  function movePlayer(p, dt, input) {
    p.dashCooldown = Math.max(0, p.dashCooldown - dt);
    p.dashActive = Math.max(0, p.dashActive - dt);
    if (input.dash && p.dashCooldown === 0) { p.dashActive = 0.18; p.dashCooldown = 0.9; if (p.id === selfId()) fire("sound", "dash"); }
    const speed = 300 * (p.dashActive > 0 ? 2.1 : 1) * (S.swamps.some((z) => inSwamp(p.x, p.y, z)) ? SWAMP_SLOW : 1);
    p.x += input.dx * speed * dt; p.y += input.dy * speed * dt;
    for (const o of S.obstacles) { const hit = circleHitsRect(p.x, p.y, p.r, o); if (hit) { p.x = hit.x; p.y = hit.y; } }
    p.x = Math.max(p.r, Math.min(S.world.w - p.r, p.x));
    p.y = Math.max(p.r, Math.min(shoreY(S.world) - p.r, p.y));
  }

  function updateMonsters(dt) {
    // Movement model: a heading that turns at a limited rate, a slow cruise,
    // a lunge when prey is close, a curving wander when there is nothing to
    // hunt, and a dive cycle (under water it can't bite and moves faster).
    const cruise = 40 + S.levelIndex * 6, TURN = 1.9;
    const angDiff = (a, b) => { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d; };
    const world = S.world;
    for (const m of S.monsters) {
      if (m.heading === undefined) { m.heading = m.dir || 0; m.speed = cruise; m.nextDive = 6 + rng() * 8; m.sub = 0; m.dive = 0; m.wanderT = rng() * 10; }
      m.full = Math.max(0, (m.full || 0) - dt);
      m.wob = (m.wob || 0) + dt * 3;
      m.nextDive -= dt;
      if (m.nextDive <= 0 && !(m.dive > 0)) { m.dive = 3.4; m.nextDive = 9 + rng() * 9; }
      if (m.dive > 0) m.dive -= dt;
      const wantSub = m.dive > 0.7 ? 1 : 0; m.sub += (wantSub - m.sub) * Math.min(1, dt * 3);
      let best = null, bd = 1e9;
      if (!(m.full > 0) && m.sub < 0.5) for (const s of S.swimmers) { const d = Math.hypot(s.x - m.x, s.y - m.y); if (d < bd) { bd = d; best = s; } }
      let want, targetSpeed;
      if (best) { want = Math.atan2(best.y - m.y, best.x - m.x); targetSpeed = bd < 150 ? cruise * 1.9 : cruise; }
      else { m.wanderT += dt; want = m.heading + Math.sin(m.wanderT * 0.7 + m.id) * 0.8; targetSpeed = cruise * (m.sub > 0.5 ? 1.3 : 0.7); }
      if (!best) { // keep off the walls while wandering
        const margin = 90, cx = world.w / 2, cy = shoreY(world) / 2;
        if (m.x < margin || m.x > world.w - margin || m.y < margin || m.y > shoreY(world) - margin) want = Math.atan2(cy - m.y, cx - m.x);
      }
      const d = angDiff(m.heading, want); m.heading += Math.max(-TURN * dt, Math.min(TURN * dt, d));
      m.speed += (targetSpeed - m.speed) * Math.min(1, dt * 1.5);
      m.vx = Math.cos(m.heading) * m.speed; m.vy = Math.sin(m.heading) * m.speed;
      m.x += m.vx * dt; m.y += m.vy * dt;
      // docks are solid: push out, slide along, and turn the heading with the slide
      for (const o of S.obstacles) {
        const hit = circleHitsRect(m.x, m.y, m.r * 0.75, o); if (!hit) continue;
        m.x = hit.x; m.y = hit.y;
        const dot = m.vx * hit.nx + m.vy * hit.ny;
        if (dot < 0) {
          m.vx -= dot * hit.nx; m.vy -= dot * hit.ny;
          if (Math.hypot(m.vx, m.vy) < cruise * 0.4) { const tx = -hit.ny, ty = hit.nx, sgn = (best ? Math.sign((best.x - m.x) * tx + (best.y - m.y) * ty) : 1) || 1; m.vx = tx * sgn * cruise; m.vy = ty * sgn * cruise; }
          m.heading = Math.atan2(m.vy, m.vx);
        }
      }
      if (m.x < m.r || m.x > world.w - m.r) { m.x = Math.max(m.r, Math.min(world.w - m.r, m.x)); m.heading = Math.atan2(m.vy, -m.vx); }
      if (m.y < m.r || m.y > shoreY(world) - m.r) { m.y = Math.max(m.r, Math.min(shoreY(world) - m.r, m.y)); m.heading = Math.atan2(-m.vy, m.vx); }
      m.heading = Math.atan2(Math.sin(m.heading), Math.cos(m.heading)); // keep in [-π, π]
      m.dir = m.heading;
    }
  }

  function gameOver() { S.phase = Phase.OVER; fire("result"); fire("sound", "over"); fire("phase"); fire("push"); }

  /**
   * One tick of `dt` seconds. `input` is the local player's input — a function
   * (called only when the player may move, as before) or an object.
   */
  S.update = function updateSim(dt, input) {
    if (S.phase === Phase.INTRO) { S.introTimer -= dt; if (S.introTimer <= 0) { S.phase = Phase.PLAY; S.lastSec = Math.ceil(S.timeLeft); fire("sound", "start"); fire("phase"); } return; }
    if (S.phase !== Phase.PLAY) return;
    const n = Math.max(1, S.players.size);
    const L = levelParams(S.levelIndex, n);
    const world = S.world, swimmers = S.swimmers, whirls = S.whirls;

    // Only the local player is integrated here; remote players own their own
    // position and report it via applyPeerInput, so what each client sees is real.
    const me = selfId();
    const meP = S.players.get(me);
    selfPos.stun = Math.max(0, (selfPos.stun || 0) - dt);
    selfPos.stunCd = Math.max(0, (selfPos.stunCd || 0) - dt);
    if (meP && selfPos.stun <= 0 && selfPos.stunCd <= 0) {
      for (const m of S.monsters) { if (!(m.sub > 0.5) && Math.hypot(meP.x - m.x, meP.y - m.y) < m.r + meP.r) { selfPos.stun = 1.0; selfPos.stunCd = 1.5; fire("sound", "stun"); break; } }
    }
    if (meP) { movePlayer(meP, dt, selfPos.stun > 0 ? { dx: 0, dy: 0, dash: false } : (typeof input === "function" ? input() : input || NO_INPUT)); whirlPull(meP, whirls, dt, WHIRL_PLAYER); meP.stunned = selfPos.stun > 0; selfPos.x = meP.x; selfPos.y = meP.y; }
    for (const p of S.players.values()) { if (p.id !== me) p.dashActive = Math.max(0, p.dashActive - dt); }

    S.spawnTimer -= dt;
    if (S.spawnTimer <= 0 && swimmers.length < L.maxOnScreen) { spawnSwimmer(); S.spawnTimer = L.spawn / 1000; }

    updateMonsters(dt);

    for (let i = swimmers.length - 1; i >= 0; i--) {
      const s = swimmers[i];
      s.x += s.vx * dt; s.y += s.vy * dt; s.bob += dt * 4;
      if (s.x < s.r || s.x > world.w - s.r) { s.vx *= -1; s.x = Math.max(s.r, Math.min(world.w - s.r, s.x)); }
      if (s.y < s.r || s.y > shoreY(world) - s.r) { s.vy *= -1; s.y = Math.max(s.r, Math.min(shoreY(world) - s.r, s.y)); }
      for (const o of S.obstacles) { const hit = circleHitsRect(s.x, s.y, s.r, o); if (hit) { s.x = hit.x; s.y = hit.y; const dot = s.vx * hit.nx + s.vy * hit.ny; s.vx -= 2 * dot * hit.nx; s.vy -= 2 * dot * hit.ny; } }
      s.life -= dt;
      // whirlpool: drawn slowly toward the centre; at the core the swimmer is lost
      if (whirls.length) {
        whirlPull(s, whirls, dt, 1);
        if (whirls.some((z) => Math.hypot(z.x - s.x, z.y - s.y) < z.r * WHIRL_CORE)) {
          S.missed++; S.combo = 0; S.splashes.push({ x: s.x, y: s.y, t: 0, good: false }); S.fxOut.push([Math.round(s.x), Math.round(s.y), 0]); fire("sound", "miss");
          swimmers.splice(i, 1);
          if (S.missed > L.allowedMisses) { gameOver(); return; }
          continue;
        }
      }

      let rescuer = null;
      for (const p of S.players.values()) { if (Math.hypot(s.x - p.x, s.y - p.y) < p.r + s.r) { rescuer = p; break; } }
      if (rescuer) {
        // Gentle ramp: 10 points on level 1 -> 24 on level 8. Credited to the
        // team total AND to the player whose ring touched the swimmer.
        S.caught++; S.totalCaught++; S.combo++; if (S.combo > S.bestCombo) S.bestCombo = S.combo;
        const pts = 10 + S.levelIndex * 2; S.score += pts;
        rescuer.rescues = (rescuer.rescues || 0) + 1; rescuer.score = (rescuer.score || 0) + pts;
        S.splashes.push({ x: s.x, y: s.y, t: 0, good: true }); S.fxOut.push([Math.round(s.x), Math.round(s.y), 1, s.sk, s.hr, s.id]); fire("sound", "rescue"); fire("rescued", s);
        swimmers.splice(i, 1);
        if (S.caught >= L.quota) { S.phase = Phase.CLEARED; fire("sound", "clear"); fire("phase"); fire("push"); return; }
        continue;
      }
      // Loch Ness monster: must hold a swimmer for EAT_DWELL seconds before
      // eating it (a red danger ring rises) so a rescue can still snatch them
      // back; a satiated monster can't bite. Counts as a miss; livboj is safe.
      let biter = null;
      for (const m of S.monsters) { if (!(m.full > 0) && !(m.sub > 0.5) && Math.hypot(s.x - m.x, s.y - m.y) < m.r + s.r) { biter = m; break; } }
      s.chomp = biter ? (s.chomp || 0) + dt : Math.max(0, (s.chomp || 0) - dt * 1.5);
      if (biter && s.chomp >= EAT_DWELL) {
        biter.full = 1.5;
        S.missed++; S.combo = 0; S.splashes.push({ x: s.x, y: s.y, t: 0, good: false }); S.fxOut.push([Math.round(s.x), Math.round(s.y), 2]); fire("sound", "chomp");
        swimmers.splice(i, 1);
        if (S.missed > L.allowedMisses) { gameOver(); return; }
        continue;
      }
      if (s.life <= 0) {
        S.missed++; S.combo = 0; S.splashes.push({ x: s.x, y: s.y, t: 0, good: false }); S.fxOut.push([Math.round(s.x), Math.round(s.y), 0]); fire("sound", "miss");
        swimmers.splice(i, 1);
        if (S.missed > L.allowedMisses) { gameOver(); return; }
      }
    }
    const splashes = S.splashes;
    for (let i = splashes.length - 1; i >= 0; i--) { splashes[i].t += dt; if (splashes[i].t > 0.6) splashes.splice(i, 1); }
  };

  return S;
}

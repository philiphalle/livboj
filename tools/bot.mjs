#!/usr/bin/env node
// A deterministic bot that plays every level of sim.js, for comparing difficulty
// between two versions of the rules or the layout (plain node, no browser).
//
//   node tools/bot.mjs                          # levels 1-8 x {1, 2, 6} players, 40 seeds each
//   node tools/bot.mjs --sim /path/to/sim.js    # another sim.js (e.g. an older build: git show <rev>:sim.js > /tmp/sim.js)
//   node tools/bot.mjs --seeds 80 --n 1,2,6,12 --levels 6,7 --json out.json
//   node tools/bot.mjs --strategy near          # the stronger bot (clears more of the late levels: more signal there)
//
// Every ring (the local one through the sim, the others moved here the way a
// joiner moves itself in game.js) picks among the swimmers it can still reach
// (distance / 300 px/s < time left) and no earlier ring has claimed: "urgent"
// takes the one with the least time left, "near" the one with the least travel
// time + a quarter of its time left; with none reachable, the nearest one. It
// dashes when the target is far and sidesteps when stuck against a dock. Each
// run is one level from its start to "cleared" or "game over" (or 240 s), seeded
// rng, fixed dt. Reported per level and player count: clear rate, rescues per
// minute, misses per run (of them eaten by a monster, lost in a whirlpool), s per run.
import path from "node:path";
import { pathToFileURL } from "node:url";
import fs from "node:fs";

const args = {}; const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith("--")) { const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true"; args[a.slice(2)] = v; } }
const simPath = path.resolve(args.sim || new URL("../sim.js", import.meta.url).pathname);
const sim = await import(pathToFileURL(simPath).href);
const { createSim, Phase, BASE_LEVELS, shoreY, inSwamp, circleHitsRect, whirlPull, SWAMP_SLOW, WHIRL_PLAYER } = sim;
const STRAT = args.strategy || "urgent"; // urgent: least time left · near: travel time + a quarter of the time left
const SEEDS = +(args.seeds || 40), NS = (args.n || "1,2,6").split(",").map(Number), DT = 1 / 30, CAP = 240;

function seeded(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** One level, n players, one seed -> { cleared, over, rescues, misses, time } */
export function playLevel(level, n, seed) {
  let rescues = 0, misses = 0, chomps = 0, whirled = 0;
  const S = createSim({ rng: seeded(seed * 7919 + level * 131 + n), selfId: () => "p0",
    hooks: { sound: (k) => { if (k === "rescue") rescues++; else if (k === "miss" || k === "chomp") misses++; if (k === "chomp") chomps++; } } });
  for (let i = 0; i < n; i++) S.addPlayer("p" + i, "P" + i);
  S.beginGame(); S.startLevel(level); S.phase = Phase.PLAY;
  const brain = new Map(); // per ring: stuck detection and sidestep
  const claimed = new Set();
  function steer(p) {
    let b = brain.get(p.id);
    if (!b) { b = { hist: [], side: 0, sideT: 0, tgt: null }; brain.set(p.id, b); }
    let best = null, bl = Infinity, near = null, nd = Infinity;
    for (const s of S.swimmers) {
      const d = Math.hypot(s.x - p.x, s.y - p.y);
      if (d < nd && !claimed.has(s.id)) { nd = d; near = s; }
      if (claimed.has(s.id) || d / 300 > s.life) continue;
      const cost = STRAT === "near" ? d / 300 + 0.25 * s.life : s.life;
      if (cost < bl) { bl = cost; best = s; }
    }
    const s = best || near;
    if (!s) return { dx: 0, dy: 0, dash: false };
    claimed.add(s.id);
    let dx = s.x - p.x, dy = s.y - p.y; const d = Math.hypot(dx, dy) || 1; dx /= d; dy /= d;
    // stuck against a dock: sidestep (perpendicular, the side that turns towards the target) for a moment
    b.hist.push([p.x, p.y]); if (b.hist.length > 12) b.hist.shift();
    if (b.sideT > 0) b.sideT -= DT;
    else if (b.hist.length === 12 && Math.hypot(p.x - b.hist[0][0], p.y - b.hist[0][1]) < 25 && d > 50) { b.side = b.side === 1 ? -1 : 1; b.sideT = 0.6; }
    if (b.sideT > 0) { const ox = -dy * b.side, oy = dx * b.side; dx = ox * 0.85 + dx * 0.15; dy = oy * 0.85 + dy * 0.15; const l = Math.hypot(dx, dy); dx /= l; dy /= l; }
    return { dx, dy, dash: d > 140 };
  }
  // the other rings report their own position (game.js updateJoin): moved here the same way
  function moveRemote(p, inp) {
    p.stunT = Math.max(0, (p.stunT || 0) - DT); p.stunCd = Math.max(0, (p.stunCd || 0) - DT);
    if (p.stunT <= 0 && p.stunCd <= 0) for (const m of S.monsters) if (!(m.sub > 0.5) && Math.hypot(p.x - m.x, p.y - m.y) < m.r + p.r) { p.stunT = 1; p.stunCd = 1.5; break; }
    if (p.stunT > 0) inp = { dx: 0, dy: 0, dash: false };
    p.cd = Math.max(0, (p.cd || 0) - DT); p.dashActive = Math.max(0, p.dashActive - DT);
    if (inp.dash && p.cd === 0) { p.dashActive = 0.18; p.cd = 0.9; }
    const sp = 300 * (p.dashActive > 0 ? 2.1 : 1) * (S.swamps.some((z) => inSwamp(p.x, p.y, z)) ? SWAMP_SLOW : 1);
    p.x += inp.dx * sp * DT; p.y += inp.dy * sp * DT;
    for (const o of S.obstacles) { const hit = circleHitsRect(p.x, p.y, p.r, o); if (hit) { p.x = hit.x; p.y = hit.y; } }
    p.x = Math.max(p.r, Math.min(S.world.w - p.r, p.x));
    whirlPull(p, S.whirls, DT, WHIRL_PLAYER);
    p.y = Math.max(p.r, Math.min(shoreY(S.world) - p.r, p.y));
  }
  let t = 0;
  for (; t < CAP && S.phase === Phase.PLAY; t += DT) {
    claimed.clear();
    let mine = null;
    for (const p of S.players.values()) { const inp = steer(p); if (p.id === "p0") mine = inp; else moveRemote(p, inp); }
    S.update(DT, mine);
    for (const e of S.fxOut) if (e[2] === 0 && S.whirls.some((z) => Math.hypot(z.x - e[0], z.y - e[1]) < z.r * 0.2)) whirled++; // lost in a whirlpool
    S.fxOut.length = 0;
  }
  return { cleared: S.phase === Phase.CLEARED, over: S.phase === Phase.OVER, rescues, misses, chomps, whirled, time: t };
}

const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const rows = [];
  const LEVELS = args.levels ? args.levels.split(",").map((v) => v - 1) : BASE_LEVELS.map((_, i) => i);
  for (const n of NS) for (const lv of LEVELS) {
    let cl = 0, ov = 0, res = 0, mis = 0, ch = 0, wh = 0, time = 0;
    for (let s = 0; s < SEEDS; s++) { const r = playLevel(lv, n, s + 1); cl += r.cleared; ov += r.over; res += r.rescues; mis += r.misses; ch += r.chomps; wh += r.whirled; time += r.time; }
    rows.push({ n, level: lv + 1, clear: cl / SEEDS, over: ov / SEEDS, rpm: res / (time / 60), missPerRun: mis / SEEDS, eatenPerRun: ch / SEEDS, whirlPerRun: wh / SEEDS, secPerRun: time / SEEDS });
  }
  console.log(`sim: ${simPath}  strategy ${STRAT}  (${SEEDS} seeds per row, dt 1/30 s)`);
  console.log("  n  lvl  clear%  over%  rescues/min  misses/run  (eaten  whirl)  s/run");
  for (const r of rows) console.log(`${String(r.n).padStart(3)}  ${String(r.level).padStart(3)}  ${(r.clear * 100).toFixed(0).padStart(6)}  ${(r.over * 100).toFixed(0).padStart(5)}  ${r.rpm.toFixed(1).padStart(11)}  ${r.missPerRun.toFixed(2).padStart(10)}  ${r.eatenPerRun.toFixed(2).padStart(7)} ${r.whirlPerRun.toFixed(2).padStart(6)}  ${r.secPerRun.toFixed(1).padStart(5)}`);
  if (args.json) fs.writeFileSync(args.json, JSON.stringify(rows, null, 1));
}

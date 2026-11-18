#!/usr/bin/env node
// Tests for the simulation (sim.js), in plain node — no browser, no framework.
//
//   node tools/sim-test.mjs
//
// The expected rules are read off the game as it is (sim.js); a test that
// fails after a change means the rules changed, on purpose or not. Every
// test runs on a seeded rng, so a failure repeats exactly.
import fs from "node:fs";
import assert from "node:assert/strict";
import {
  createSim, Phase, BASE_LEVELS, EAT_DWELL, SHORE_H, LEGACY_SHORE_H, shoreH, MAX_PLAYERS, WHIRL_CORE, WHIRL_PLAYER, SWAMP_SLOW,
  worldSize, levelParams, makeObstacles, makeSwamps, makeWhirls, monstersForLevel, circleHitsRect, shoreY,
} from "../sim.js";

let passes = 0, fails = 0;
function test(name, fn) {
  try { fn(); passes++; console.log(`  ok    ${name}`); }
  catch (e) { fails++; console.log(`  FAIL  ${name}\n        ${String(e && e.message || e).split("\n").join("\n        ")}`); }
}

// mulberry32: a small seeded PRNG
function seeded(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const DT = 1 / 60;
const STILL = { dx: 0, dy: 0, dash: false };
// A sim with n players ("me" is the local one), started on `level`, in PLAY. log: every hook call, in order.
function mk({ n = 1, level = 0, seed = 1, phase = Phase.PLAY } = {}) {
  const log = [];
  const S = createSim({
    rng: seeded(seed), selfId: () => "me",
    hooks: { sound: (k) => log.push("sound:" + k), phase: () => log.push("phase:" + S.phase), push: () => log.push("push"), result: () => log.push("result"), rescued: (s) => log.push("rescued:" + s.id), levelStarted: () => log.push("levelStarted") },
  });
  S.addPlayer("me", "Jag");
  for (let i = 1; i < n; i++) S.addPlayer("p" + i, "P" + i);
  S.beginGame(); S.startLevel(level); S.phase = phase;
  log.length = 0;
  return { S, log, me: S.players.get("me") };
}
// isolate a rule: no monsters, no new swimmers (state set up for the test, rules untouched)
function quiet(S) { S.monsters = []; S.swimmers = []; S.spawnTimer = 1e9; return S; }
function addSwimmer(S, { x, y, life = 100, vx = 0, vy = 0 }) {
  const s = { id: S.swimmerSeq++, x, y, r: 16, vx, vy, life, maxLife: life, bob: 0, sk: 2, hr: 3 };
  S.swimmers.push(s); return s;
}
const run = (S, seconds, input = STILL, dt = DT) => { for (let t = 0; t < seconds - 1e-9; t += dt) S.update(dt, input); };
const finite = (...v) => v.every((x) => typeof x === "number" && Number.isFinite(x));

console.log("sim.js is pure");
test("no imports and no DOM / audio / network / storage / clock access; Math.random only as the default rng", () => {
  const src = fs.readFileSync(new URL("../sim.js", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/^\s*import\b|\bimport\s*\(/m.test(src), "sim.js imports something");
  const bad = src.match(/\b(document|window|globalThis|self\.|localStorage|sessionStorage|performance|Date|fetch|WebSocket|XMLHttpRequest|navigator|location|requestAnimationFrame|setTimeout|setInterval|AudioContext|console)\b/g);
  assert.equal(bad, null, `forbidden: ${bad}`);
  assert.equal((src.match(/Math\.random/g) || []).length, 1, "Math.random used outside the default rng");
});

console.log("levels and world");
test("world size: 2:1, grows with the player count in the old 3:2 worlds' area steps, capped at 1800x900", () => {
  assert.deepEqual(worldSize(1), { w: 1040, h: 520 });
  assert.deepEqual(worldSize(2), { w: 1240, h: 620 });
  assert.deepEqual(worldSize(3), { w: 1444, h: 722 });
  assert.deepEqual(worldSize(4), { w: 1644, h: 822 });
  assert.deepEqual(worldSize(5), { w: 1800, h: 900 });
  assert.deepEqual(worldSize(MAX_PLAYERS), { w: 1800, h: 900 });
  const oldW = (n) => Math.min(900 + (n - 1) * 170, 1560), oldH = (n) => Math.min(600 + (n - 1) * 120, 1040); // the 3:2 worlds before
  for (let n = 1; n <= MAX_PLAYERS; n++) {
    const W = worldSize(n);
    assert.ok(W.w === 2 * W.h && W.h % 2 === 0, `n=${n}: ${W.w}x${W.h} is 2:1, even`);
    assert.ok(Math.abs(W.w * W.h / (oldW(n) * oldH(n)) - 1) < 0.01, `n=${n}: area within 1 % of the old world's`);
    const water = W.w * shoreY(W), oldWater = oldW(n) * (oldH(n) - 70);
    assert.ok(Math.abs(water / oldWater - 1) < 0.015, `n=${n}: water area within 1.5 % of the old (${water} vs ${oldWater})`);
  }
});
test("the beach: 60 deep on the 2:1 worlds (the share of the height the old 70 took), 70 on a 3:2 world from a host on the old build", () => {
  assert.equal(SHORE_H, 60); assert.equal(LEGACY_SHORE_H, 70);
  for (const n of [1, 2, 6, 12]) { const W = worldSize(n); assert.equal(shoreH(W), 60); assert.ok(SHORE_H / W.h <= 70 / Math.min(600 + (n - 1) * 120, 1040) + 1e-9, `n=${n}: no bigger share of the height`); }
  for (const W of [{ w: 900, h: 600 }, { w: 1070, h: 720 }, { w: 1560, h: 1040 }]) { assert.equal(shoreH(W), 70); assert.equal(shoreY(W), W.h - 70); }
});
test("every level is played in the world for the current player count; docks, swamps and whirlpools scale with it", () => {
  for (const n of [1, 2, 3, 6, 12]) for (let i = 0; i < BASE_LEVELS.length; i++) {
    const { S } = mk({ n, level: i });
    assert.deepEqual(S.world, worldSize(n), `n=${n} level ${i + 1}`);
    assert.deepEqual(S.obstacles, makeObstacles(i, S.world.w, S.world.h));
    assert.deepEqual(S.swamps, makeSwamps(i, S.world.w, S.world.h));
    assert.deepEqual(S.whirls, makeWhirls(i, S.world.w, S.world.h));
  }
  const { S } = mk({ n: 2, level: 7 });
  assert.equal(S.obstacles[0].x, 69 * 1240 / 1040); // x by the width, y by the water height (from 460 on the 1040x520 world)
  assert.equal(S.obstacles[0].y, 85 * (620 - SHORE_H) / 460);
});
test("8 levels; docks from level 2, swamps from level 4, whirlpools on levels 6 and 7 only", () => {
  assert.equal(BASE_LEVELS.length, 8);
  assert.deepEqual(BASE_LEVELS.map((_, i) => makeObstacles(i, 1040, 520).length), [0, 1, 2, 3, 4, 4, 5, 6]);
  assert.deepEqual(BASE_LEVELS.map((_, i) => makeSwamps(i, 1040, 520).length), [0, 0, 0, 1, 1, 2, 2, 3]);
  assert.deepEqual(BASE_LEVELS.map((_, i) => makeWhirls(i, 1040, 520).length), [0, 0, 0, 0, 0, 1, 1, 0]);
});

// ---- the layouts, for every level and player count
const COUNTS = [1, 2, 3, 4, 5, 6, 12], RING = 30, PASS = 64; // a ring is 60 across: a gap is closed (0) or at least 64
const rectGap = (a, b) => Math.hypot(Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w)), Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h)));
const eachLayout = (fn) => { for (const n of COUNTS) for (let i = 0; i < BASE_LEVELS.length; i++) { const W = worldSize(n); fn({ n, i, W, tag: `n=${n} level ${i + 1}`, ob: makeObstacles(i, W.w, W.h), sw: makeSwamps(i, W.w, W.h), wh: makeWhirls(i, W.w, W.h) }); } };
test("every dock lies in the water (inside the world, never on the beach); a pier from the beach ends at the waterline", () => {
  eachLayout(({ W, tag, ob }) => ob.forEach((o, k) => {
    assert.ok(o.x >= -1e-9 && o.y >= -1e-9 && o.x + o.w <= W.w + 1e-9 && o.y + o.h <= shoreY(W) + 1e-6, `${tag}: dock ${k} ${JSON.stringify(o)}`);
  }));
});
test("gaps a ring can pass: dock to dock, to the edges and to the beach either closed or >= 64 (a ring is 60 across)", () => {
  eachLayout(({ W, tag, ob }) => ob.forEach((o, k) => {
    for (const [g, what] of [[o.x, "left edge"], [W.w - o.x - o.w, "right edge"], [o.y, "top edge"], [shoreY(W) - o.y - o.h, "beach"]]) assert.ok(g < 1e-6 || g >= PASS, `${tag}: dock ${k} to the ${what}: ${g.toFixed(1)}`);
    ob.forEach((p, j) => { if (j > k) { const g = rectGap(o, p); assert.ok(g < 1e-6 || g >= PASS, `${tag}: docks ${k} and ${j}: gap ${g.toFixed(1)}`); } });
  }));
});
test("no trapped water: every spot a swimmer can spawn on is in reach of a ring from the start (flood fill, 6 px grid)", () => {
  eachLayout(({ W, tag, ob }) => {
    if (!ob.length) return;
    const G = 6, nx = Math.floor(W.w / G), ny = Math.floor(shoreY(W) / G), free = new Uint8Array(nx * ny), seen = new Uint8Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const x = i * G + G / 2, y = j * G + G / 2; free[j * nx + i] = x >= RING && x <= W.w - RING && y >= RING && y <= shoreY(W) - RING && !ob.some((o) => circleHitsRect(x, y, RING, o)) ? 1 : 0; }
    const s0 = Math.floor(W.h / 2 / G) * nx + Math.floor(W.w / 2 / G);
    let start = s0; if (!free[start]) start = free.findIndex((v, k) => v && Math.hypot((k % nx) - (s0 % nx), Math.floor(k / nx) - Math.floor(s0 / nx)) < 30);
    assert.ok(start >= 0, `${tag}: no free water by the start`);
    const q = [start]; seen[start] = 1;
    while (q.length) { const k = q.pop(), i = k % nx, j = (k - i) / nx; for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const a = i + di, b = j + dj, kk = b * nx + a; if (a >= 0 && b >= 0 && a < nx && b < ny && free[kk] && !seen[kk]) { seen[kk] = 1; q.push(kk); } } }
    // every spawn point (sim.js spawnSwimmer: 60 px in from the edges, not within 26 px of a dock) has a reachable
    // ring centre within rescue reach (ring 30 + swimmer 16)
    for (let y = 60; y <= shoreY(W) - 60; y += 9) for (let x = 60; x <= W.w - 60; x += 9) {
      if (ob.some((o) => circleHitsRect(x, y, 26, o))) continue;
      let ok = false;
      for (let j = Math.max(0, Math.floor((y - 46) / G)); j <= Math.min(ny - 1, Math.floor((y + 46) / G)) && !ok; j++) for (let i = Math.max(0, Math.floor((x - 46) / G)); i <= Math.min(nx - 1, Math.floor((x + 46) / G)); i++) if (seen[j * nx + i] && Math.hypot(i * G + G / 2 - x, j * G + G / 2 - y) < 44) { ok = true; break; }
      assert.ok(ok, `${tag}: a swimmer spawned at ${x},${y} can't be reached`);
    }
  });
});
test("players never start on a dock (the ring around the centre), swimmers never spawn on one", () => {
  eachLayout(({ n, i, tag, ob }) => {
    const { S } = mk({ n, level: i, seed: 40 + n + i });
    for (const p of S.players.values()) assert.ok(!ob.some((o) => circleHitsRect(p.x, p.y, p.r, o)), `${tag}: player ${p.id} at ${p.x},${p.y}`);
    S.monsters = []; for (const p of S.players.values()) p.x = p.y = -5000; // nothing gets rescued
    for (let k = 0; k < 400; k++) { const seq = S.swimmerSeq; S.update(1 / 20, STILL); const s = S.swimmers[S.swimmers.length - 1]; if (S.swimmerSeq > seq && s) { const r = 26 - Math.hypot(s.vx, s.vy) / 20 - 1e-6; assert.ok(!ob.some((o) => circleHitsRect(s.x, s.y, r, o)), `${tag}: swimmer spawned on a dock at ${s.x},${s.y}`); } S.swimmers.length = 0; } // (26 px clear when spawned, less the one step it swam since)
  });
});
test("whirlpools: inside the water, clear of every dock, no wider than half the water's height", () => {
  eachLayout(({ W, tag, ob, wh }) => wh.forEach((z) => {
    assert.ok(z.x - z.r >= 0 && z.x + z.r <= W.w && z.y - z.r >= 0 && z.y + z.r <= shoreY(W), `${tag}: whirlpool ${JSON.stringify(z)} outside the water`);
    assert.ok(!ob.some((o) => circleHitsRect(z.x, z.y, z.r, o)), `${tag}: a dock in the whirlpool`);
    assert.ok(2 * z.r <= shoreY(W) * 0.5, `${tag}: whirlpool ${(2 * z.r).toFixed(0)} across in ${shoreY(W)} of water`);
  }));
});
test("swamps inside the water; docks and swamps take about the share of the water they took on the old 3:2 worlds", () => {
  const old = { dock: [0, 1.6, 4.2, 7.1, 7.8, 9.5, 11.4, 14.6], swamp: [0, 0, 0, 7.7, 9.9, 16.9, 19.0, 23.2] }; // % of the water, 900x600 with the 70 beach
  eachLayout(({ W, i, tag, ob, sw }) => {
    const water = W.w * shoreY(W);
    for (const z of sw) assert.ok(z.x >= 0 && z.y >= 0 && z.x + z.w <= W.w && z.y + z.h <= shoreY(W), `${tag}: swamp outside the water`);
    const dock = 100 * ob.reduce((a, o) => a + o.w * o.h, 0) / water, swamp = 100 * sw.reduce((a, z) => a + Math.PI * z.w * z.h / 4, 0) / water;
    assert.ok(Math.abs(dock - old.dock[i]) <= Math.max(1.5, old.dock[i] * 0.25), `${tag}: docks ${dock.toFixed(1)} % of the water (was ${old.dock[i]} %)`);
    assert.ok(Math.abs(swamp - old.swamp[i]) <= Math.max(1, old.swamp[i] * 0.1), `${tag}: swamps ${swamp.toFixed(1)} % (was ${old.swamp[i]} %)`);
  });
});
test("monsters: none on level 1, one on 2-3, two on 4, three from 5; they start by the edges", () => {
  assert.deepEqual(BASE_LEVELS.map((_, i) => monstersForLevel(i)), [0, 1, 1, 2, 3, 3, 3, 3]);
  for (let i = 0; i < 8; i++) {
    const { S } = mk({ level: i, seed: 7 + i });
    assert.equal(S.monsters.length, monstersForLevel(i));
    S.monsters.forEach((m, k) => { const edge = k % 4; if (edge === 0) assert.equal(m.y, 70); else if (edge === 1) assert.equal(m.y, shoreY(S.world) - 30); else if (edge === 2) assert.equal(m.x, 70); });
  }
});
test("level parameters scale with players (quota +50% per extra player, more misses allowed, faster spawns)", () => {
  assert.deepEqual(levelParams(0, 1), { quota: 8, spawn: 1300, speed: 22, sink: 10, maxOnScreen: 5, allowedMisses: 6 });
  const L = levelParams(3, 3);
  assert.equal(L.quota, 16 + 2 * 8); assert.equal(L.allowedMisses, 8); assert.equal(L.maxOnScreen, 11);
  assert.ok(Math.abs(L.spawn - 820 / 1.7) < 1e-9 && Math.abs(L.speed - 56 * 1.1) < 1e-9);
});
test("players start in a ring around the centre (alone: on the centre), and selfPos follows the local player", () => {
  const one = mk({ level: 2 });
  assert.deepEqual([one.me.x, one.me.y], [520, 260]);
  assert.deepEqual([one.S.selfPos.x, one.S.selfPos.y], [520, 260]);
  const four = mk({ n: 4, level: 2 });
  for (const p of four.S.players.values()) assert.ok(Math.abs(Math.hypot(p.x - four.S.world.w / 2, p.y - four.S.world.h / 2) - 80) < 1e-9);
});
test("at most 12 players; colours are handed out in order", () => {
  const { S } = mk({ n: 15 });
  assert.equal(S.players.size, MAX_PLAYERS);
  assert.deepEqual([...S.players.values()].slice(0, 3).map((p) => p.hue), [28, 205, 140]);
});

console.log("every level runs");
test("every level x {1, 2, 6, 12} players: 90 s (at 60 fps and at the 20 fps cap) without throwing or NaN, everything stays in the world", () => {
  let rescues = 0, misses = 0, overs = 0, clears = 0, spawned = 0;
  for (let i = 0; i < BASE_LEVELS.length; i++) for (const n of [1, 2, 6, 12]) for (const dt of [DT, 0.05]) {
    const { S, log } = mk({ n, level: i, seed: 1000 + i * 31 + n });
    const r = seeded(i * 7 + n);
    const nearest = (p) => S.swimmers.reduce((b, s) => (!b || Math.hypot(s.x - p.x, s.y - p.y) < Math.hypot(b.x - p.x, b.y - p.y) ? s : b), null);
    // the rings chase the nearest swimmer, with some random wandering and dashing
    const bot = () => { const me = S.players.get("me"), s = nearest(me); if (!s || r() < 0.2) { const a = r() * Math.PI * 2; return { dx: Math.cos(a), dy: Math.sin(a), dash: r() < 0.1 }; } const d = Math.hypot(s.x - me.x, s.y - me.y) || 1; return { dx: (s.x - me.x) / d, dy: (s.y - me.y) / d, dash: r() < 0.05 }; };
    for (let t = 0; t < 90; t += dt) {
      for (const p of S.players.values()) if (p.id !== "me") { // remote players report their own position
        const s = nearest(p), d = s ? Math.hypot(s.x - p.x, s.y - p.y) || 1 : 1, step = 200 * dt;
        const nx = s && r() < 0.7 ? p.x + (s.x - p.x) / d * step : p.x + (r() - 0.5) * 2 * step, ny = s && r() < 0.7 ? p.y + (s.y - p.y) / d * step : p.y + (r() - 0.5) * 2 * step;
        p.x = Math.max(p.r, Math.min(S.world.w - p.r, nx)); p.y = Math.max(p.r, Math.min(S.world.h - p.r, ny));
      }
      const seq = S.swimmerSeq;
      S.update(dt, bot);
      spawned += S.swimmerSeq - seq;
      if (S.phase !== Phase.PLAY) { if (S.phase === Phase.OVER) overs++; else clears++; S.startLevel(i); S.phase = Phase.PLAY; continue; } // (new monsters get their heading on their first tick)
      const W = S.world, m = 40;
      const inside = (o) => o.x > -m && o.x < W.w + m && o.y > -m && o.y < W.h + m;
      for (const p of S.players.values()) assert.ok(finite(p.x, p.y, p.dashActive, p.dashCooldown) && inside(p), `player ${p.id} at ${p.x},${p.y} (level ${i + 1}, n=${n}, t=${t.toFixed(2)})`);
      for (const s of S.swimmers) assert.ok(finite(s.x, s.y, s.vx, s.vy, s.life) && inside(s), `swimmer ${s.id} at ${s.x},${s.y}`);
      for (const mo of S.monsters) assert.ok(finite(mo.x, mo.y, mo.vx, mo.vy, mo.heading, mo.dir, mo.sub, mo.speed) && inside(mo), `monster ${mo.id} at ${mo.x},${mo.y}`);
      assert.ok(finite(S.selfPos.x, S.selfPos.y, S.selfPos.stun, S.selfPos.stunCd, S.score, S.caught, S.missed));
      assert.ok(S.swimmers.length <= levelParams(i, n).maxOnScreen);
    }
    rescues += log.filter((e) => e === "sound:rescue").length; misses += log.filter((e) => e === "sound:miss" || e === "sound:chomp").length;
  }
  const seen = `spawned ${spawned}, rescues ${rescues}, misses ${misses}, game overs ${overs}, clears ${clears}`;
  assert.ok(spawned > 1000 && rescues > 50 && misses > 50 && overs > 0 && clears > 0, `not every branch exercised: ${seen}`);
  console.log(`        (${seen})`);
});
test("same seed, same game; another seed, another game", () => {
  const play = (seed) => { const { S } = mk({ n: 2, level: 4, seed }); run(S, 30, () => ({ dx: 0.6, dy: 0.8, dash: true })); return JSON.stringify([S.swimmers, S.monsters, [...S.players.values()], S.score, S.missed]); };
  assert.equal(play(5), play(5));
  assert.notEqual(play(5), play(6));
});

console.log("rescues and misses");
test("touching a swimmer rescues it: +10+2·level to the team and to that player, a rescue event for joiners", () => {
  for (const level of [0, 3, 7]) {
    const { S, log, me } = mk({ level, seed: 3 }); quiet(S);
    const s = addSwimmer(S, { x: me.x + 40, y: me.y }); // 40 < 30 + 16
    S.update(DT, STILL);
    const pts = 10 + level * 2;
    assert.equal(S.swimmers.length, 0); assert.equal(S.caught, 1); assert.equal(S.totalCaught, 1);
    assert.equal(S.score, pts); assert.equal(me.score, pts); assert.equal(me.rescues, 1);
    assert.deepEqual(S.fxOut, [[Math.round(s.x), Math.round(s.y), 1, s.sk, s.hr, s.id]]);
    assert.deepEqual(log, ["sound:rescue", "rescued:" + s.id]);
    assert.equal(S.splashes.length, 1); assert.equal(S.splashes[0].good, true);
  }
});
test("a swimmer just out of reach is not rescued", () => {
  const { S, me } = mk(); quiet(S);
  addSwimmer(S, { x: me.x + 47, y: me.y });
  S.update(DT, STILL);
  assert.equal(S.swimmers.length, 1); assert.equal(S.caught, 0);
});
test("a remote player's ring rescues too and is credited to that player", () => {
  const { S, me } = mk({ n: 2 }); quiet(S);
  const p1 = S.players.get("p1");
  addSwimmer(S, { x: p1.x, y: p1.y + 10 });
  S.update(DT, STILL);
  assert.equal(p1.rescues, 1); assert.equal(p1.score, 10); assert.equal(me.score, 0); assert.equal(S.score, 10);
});
test("rescue streak: combo counts up, best combo is kept, a miss resets the streak", () => {
  const { S, me } = mk(); quiet(S);
  for (let k = 0; k < 3; k++) { addSwimmer(S, { x: me.x, y: me.y }); S.update(DT, STILL); }
  addSwimmer(S, { x: 100, y: 100, life: 0.001 }); S.update(DT, STILL);
  addSwimmer(S, { x: me.x, y: me.y }); S.update(DT, STILL);
  assert.equal(S.combo, 1); assert.equal(S.bestCombo, 3); assert.equal(S.totalCaught, 4);
});
test("a swimmer whose timer runs out sinks: a miss, a miss event, the streak ends", () => {
  const { S, log } = mk(); quiet(S);
  S.combo = 4;
  const s = addSwimmer(S, { x: 100, y: 100, life: 0.5 });
  run(S, 0.49);
  assert.equal(S.swimmers.length, 1); assert.equal(S.missed, 0);
  run(S, 0.02);
  assert.equal(S.swimmers.length, 0); assert.equal(S.missed, 1); assert.equal(S.combo, 0);
  assert.deepEqual(S.fxOut, [[Math.round(s.x), Math.round(s.y), 0]]);
  assert.deepEqual(log, ["sound:miss"]); assert.equal(S.phase, Phase.PLAY);
});
test("new swimmers: first after 0.4 s, then every spawn interval, never more than maxOnScreen, never on a dock", () => {
  const { S } = mk({ level: 7, seed: 11 }); S.monsters = [];
  const L = levelParams(7, 1);
  run(S, 0.39); assert.equal(S.swimmers.length, 0);
  run(S, 0.02); assert.equal(S.swimmers.length, 1);
  const s = S.swimmers[0];
  assert.equal(s.maxLife, L.sink); assert.ok(Math.abs(Math.hypot(s.vx, s.vy) - L.speed) < 1e-9);
  run(S, L.spawn / 1000 - 0.03); assert.equal(S.swimmers.length, 1);
  run(S, 0.04); assert.equal(S.swimmers.length, 2);
  const T = mk({ level: 7, seed: 12 }); T.S.monsters = []; T.me.x = T.me.y = 5000; // ring out of the way: nothing gets rescued
  for (let k = 0; k < 600; k++) { const seq = T.S.swimmerSeq; T.S.update(DT, STILL); if (T.S.swimmerSeq > seq) { const n = T.S.swimmers[T.S.swimmers.length - 1]; assert.ok(!T.S.obstacles.some((o) => circleHitsRect(n.x, n.y, 26, o)), "spawned on a dock"); } assert.ok(T.S.swimmers.length <= L.maxOnScreen); }
});

console.log("phases");
test("reaching the quota clears the level (and nothing moves after that)", () => {
  const { S, log, me } = mk({ level: 2 }); quiet(S);
  const L = levelParams(2, 1);
  S.caught = L.quota - 1;
  addSwimmer(S, { x: 100, y: 100, life: 0.001 }); // would be a miss, but the clear ends the tick first (swimmers are handled newest first)
  addSwimmer(S, { x: me.x, y: me.y });
  S.update(DT, STILL);
  assert.equal(S.phase, Phase.CLEARED); assert.equal(S.caught, L.quota); assert.equal(S.missed, 0);
  assert.deepEqual(log.filter((e) => !e.startsWith("rescued")), ["sound:rescue", "sound:clear", "phase:cleared", "push"]);
  const before = JSON.stringify([S.swimmers, S.monsters, [...S.players.values()]]);
  run(S, 2, { dx: 1, dy: 1, dash: true });
  assert.equal(JSON.stringify([S.swimmers, S.monsters, [...S.players.values()]]), before);
});
test("more misses than allowed ends the game (allowedMisses misses are still fine)", () => {
  const { S, log } = mk({ level: 1 }); quiet(S);
  const L = levelParams(1, 1);
  S.missed = L.allowedMisses - 1;
  addSwimmer(S, { x: 100, y: 100, life: 0.001 }); S.update(DT, STILL);
  assert.equal(S.missed, L.allowedMisses); assert.equal(S.phase, Phase.PLAY);
  log.length = 0;
  addSwimmer(S, { x: 100, y: 100, life: 0.001 }); S.update(DT, STILL);
  assert.equal(S.phase, Phase.OVER);
  assert.deepEqual(log, ["sound:miss", "result", "sound:over", "phase:over", "push"]);
});
test("there is no level clock: timeLeft stays 0 and a level never ends by time (only quota or misses end it)", () => {
  const { S } = mk({ level: 0 }); quiet(S);
  run(S, 600, STILL, 0.05);
  assert.equal(S.timeLeft, 0); assert.equal(S.phase, Phase.PLAY);
});
test("INTRO counts down 2.4 s, then PLAY (start sound + phase callback, no push)", () => {
  const { S, log } = mk({ phase: Phase.INTRO }); S.introTimer = 2.4;
  run(S, 2.3); assert.equal(S.phase, Phase.INTRO); assert.equal(S.swimmers.length, 0);
  run(S, 0.15); assert.equal(S.phase, Phase.PLAY);
  assert.deepEqual(log, ["sound:start", "phase:play"]);
});
test("LOBBY, CLEARED, OVER and WIN don't step anything", () => {
  for (const ph of [Phase.LOBBY, Phase.CLEARED, Phase.OVER, Phase.WIN]) {
    const { S, log } = mk({ level: 5, phase: ph });
    const before = JSON.stringify([S.swimmers, S.monsters, [...S.players.values()], S.selfPos]);
    run(S, 3, { dx: 1, dy: 0, dash: true });
    assert.equal(JSON.stringify([S.swimmers, S.monsters, [...S.players.values()], S.selfPos]), before, ph); assert.deepEqual(log, []);
  }
});
test("next level: INTRO of the following level with a fresh count; after level 8: WIN and the result is recorded", () => {
  const { S, log } = mk({ level: 0, phase: Phase.CLEARED });
  S.caught = 8; S.missed = 3; S.score = 80;
  S.nextLevel();
  assert.equal(S.levelIndex, 1); assert.equal(S.phase, Phase.INTRO); assert.equal(S.introTimer, 2.4);
  assert.equal(S.caught, 0); assert.equal(S.missed, 0); assert.equal(S.score, 80); assert.equal(S.monsters.length, 1);
  assert.deepEqual(log, ["levelStarted", "phase:intro", "push"]);
  const last = mk({ level: 7, phase: Phase.CLEARED });
  last.S.nextLevel();
  assert.equal(last.S.phase, Phase.WIN);
  // the index stays on the last level, so the HUD and state push can still look its numbers up
  assert.equal(last.S.levelIndex, 7); assert.doesNotThrow(() => levelParams(last.S.levelIndex, 1));
  assert.deepEqual(last.log, ["result", "sound:win", "phase:win", "push"]);
});
test("a new game resets score, streaks and every player's tally", () => {
  const { S, me } = mk({ n: 2, level: 3 });
  S.score = 99; S.totalCaught = 5; S.combo = 2; S.bestCombo = 4; me.score = 50; me.rescues = 3;
  S.beginGame();
  assert.deepEqual([S.score, S.totalCaught, S.combo, S.bestCombo, S.levelIndex, me.score, me.rescues], [0, 0, 0, 0, 0, 0, 0]);
});

console.log("the local ring");
test("arrow input moves the ring 300 px/s; a dash is 2.1x for 0.18 s with a 0.9 s cooldown (dash sound for the local ring)", () => {
  const { S, log, me } = mk(); quiet(S);
  S.update(DT, { dx: 1, dy: 0, dash: false });
  assert.ok(Math.abs(me.x - (520 + 300 * DT)) < 1e-9);
  const x0 = me.x;
  S.update(DT, { dx: 1, dy: 0, dash: true });
  assert.ok(Math.abs(me.x - x0 - 300 * 2.1 * DT) < 1e-9); assert.equal(me.dashActive, 0.18); assert.equal(me.dashCooldown, 0.9);
  assert.deepEqual(log, ["sound:dash"]);
  run(S, 0.5, { dx: 0, dy: 0, dash: true }); assert.deepEqual(log, ["sound:dash"]); // cooling down
  run(S, 0.45, { dx: 0, dy: 0, dash: true }); assert.deepEqual(log, ["sound:dash", "sound:dash"]);
});
test("the input function is only read when the ring may move (not while stunned)", () => {
  const { S, me } = mk({ level: 1 }); quiet(S);
  let reads = 0; const input = () => { reads++; return STILL; };
  S.update(DT, input); assert.equal(reads, 1);
  S.monsters = [{ id: 1, x: me.x, y: me.y, vx: 0, vy: 0, r: 30, wob: 0, dir: 0, heading: 0, speed: 40, nextDive: 100, sub: 0, dive: 0, wanderT: 0 }];
  S.update(DT, input); assert.equal(reads, 1); assert.equal(S.selfPos.stun, 1);
});
test("a swamp slows the ring to 55 %", () => {
  const { S, me } = mk({ level: 3 }); quiet(S);
  const z = S.swamps[0];
  me.x = z.x + z.w / 2; me.y = z.y + z.h / 2;
  const x0 = me.x; S.update(DT, { dx: 1, dy: 0, dash: false });
  assert.ok(Math.abs(me.x - x0 - 300 * SWAMP_SLOW * DT) < 1e-9);
});
test("docks are solid: the ring is pushed out and slides along", () => {
  const { S, me } = mk({ level: 1 }); quiet(S);
  const o = S.obstacles[0]; // 150,128 266x34
  me.x = o.x + o.w / 2; me.y = o.y - 40;
  run(S, 1, { dx: 0, dy: 1, dash: false });
  assert.ok(Math.abs(me.y - (o.y - me.r)) < 1e-6 && !circleHitsRect(me.x, me.y, me.r - 1e-6, o), `ring at ${me.y}`);
  run(S, 0.2, { dx: 0.6, dy: 0.8, dash: false });
  assert.ok(me.x > o.x + o.w / 2 + 30 && Math.abs(me.y - (o.y - me.r)) < 1e-6, "slides along the dock");
});
test("the ring stays on the water: inside the world and above the beach", () => {
  const { S, me } = mk(); quiet(S);
  run(S, 5, { dx: 1, dy: 1, dash: false });
  assert.deepEqual([me.x, me.y], [S.world.w - me.r, shoreY(S.world) - me.r]);
  assert.equal(shoreY(S.world), S.world.h - SHORE_H);
});

console.log("whirlpools");
test("a whirlpool draws a swimmer in and swallows it at the core: a miss", () => {
  const { S, log, me } = mk({ level: 5 }); quiet(S);
  me.x = 800; me.y = 480; // far from the whirlpool
  const z = S.whirls[0];
  const s = addSwimmer(S, { x: z.x + z.r * 0.6, y: z.y });
  const d0 = Math.hypot(s.x - z.x, s.y - z.y);
  run(S, 0.5);
  const d1 = Math.hypot(s.x - z.x, s.y - z.y);
  assert.ok(d1 < d0 - 3, `pulled in: ${d0.toFixed(1)} -> ${d1.toFixed(1)}`);
  let t = 0.5; while (S.swimmers.length && t < 30) { S.update(DT, STILL); t += DT; }
  assert.equal(S.swimmers.length, 0, "swallowed within 30 s"); assert.equal(S.missed, 1);
  assert.deepEqual(log, ["sound:miss"]);
  assert.equal(S.fxOut.length, 1); assert.equal(S.fxOut[0][2], 0);
  assert.ok(Math.hypot(S.fxOut[0][0] - z.x, S.fxOut[0][1] - z.y) < z.r * WHIRL_CORE + 1, "lost at the core");
});
test("outside its radius a whirlpool does nothing", () => {
  const { S } = mk({ level: 6 }); quiet(S);
  const z = S.whirls[0];
  const s = addSwimmer(S, { x: z.x - z.r - 5, y: z.y });
  run(S, 1);
  assert.deepEqual([s.x, s.y], [z.x - z.r - 5, z.y]);
});
test("the whirlpool tugs at the ring with 35 % of the pull a swimmer feels", () => {
  const { S, me } = mk({ level: 5 }); quiet(S);
  const z = S.whirls[0];
  me.x = z.x + z.r * 0.6; me.y = z.y;
  const s = addSwimmer(S, { x: z.x + z.r * 0.6, y: z.y + 0.0001 }); // same spot (the rescue doesn't matter: measured before)
  const sx = s.x, sy = s.y;
  S.update(DT, STILL);
  const ringMove = Math.hypot(me.x - sx, me.y - sy), swimMove = Math.hypot(s.x - sx, s.y - sy);
  assert.ok(ringMove > 0 && Math.abs(ringMove / swimMove - WHIRL_PLAYER) < 1e-3, `ratio ${(ringMove / swimMove).toFixed(4)}`);
});

console.log("Loch Ness monsters");
function monster(S, at, { sub }) {
  const m = { id: 9, x: at.x, y: at.y, vx: 0, vy: 0, r: 30, wob: 0, dir: 0, heading: 0, speed: 40, nextDive: 100, sub: sub ? 1 : 0, dive: sub ? 3.4 : 0, wanderT: 0 };
  S.monsters = [m]; return m;
}
const pinned = (S, m, s, seconds) => { for (let t = 0; t < seconds - 1e-9; t += DT) { m.x = s.x; m.y = s.y; S.update(DT, STILL); } };
test("a surfaced monster eats a swimmer it holds for 1.25 s: a miss and a chomp event; then it is full for 1.5 s", () => {
  const { S, log, me } = mk({ level: 1 }); quiet(S);
  me.x = 120; me.y = 450;
  const s = addSwimmer(S, { x: 700, y: 400 });
  const m = monster(S, s, { sub: false });
  pinned(S, m, s, 1.2);
  assert.equal(S.swimmers.length, 1); assert.ok(Math.abs(s.chomp - 1.2) < 1e-6, `held ${s.chomp}`);
  let t = 1.2; while (S.swimmers.length && t < 2) { pinned(S, m, s, DT); t += DT; }
  assert.ok(t >= EAT_DWELL - 1e-9 && t < EAT_DWELL + 2 * DT, `eaten after ${t.toFixed(3)} s`);
  assert.equal(S.swimmers.length, 0); assert.equal(S.missed, 1); assert.equal(m.full, 1.5);
  assert.deepEqual(log, ["sound:chomp"]); assert.equal(S.fxOut[0][2], 2);
});
test("a submerged monster can't bite (nor stun the ring)", () => {
  const { S, log, me } = mk({ level: 1 }); quiet(S);
  me.x = 120; me.y = 450;
  const s = addSwimmer(S, { x: 700, y: 400 });
  const m = monster(S, s, { sub: true });
  pinned(S, m, s, 2.0);
  assert.ok(m.sub > 0.5, `still under (sub ${m.sub})`);
  assert.equal(S.swimmers.length, 1); assert.equal(s.chomp, 0); assert.equal(S.missed, 0); assert.deepEqual(log, []);
  m.x = me.x; m.y = me.y; S.update(DT, STILL);
  assert.equal(S.selfPos.stun, 0);
});
test("a full monster can't bite", () => {
  const { S, me } = mk({ level: 1 }); quiet(S);
  me.x = 120; me.y = 450;
  const s = addSwimmer(S, { x: 700, y: 400 });
  const m = monster(S, s, { sub: false }); m.full = 100;
  pinned(S, m, s, 2.0);
  assert.equal(S.swimmers.length, 1); assert.equal(s.chomp, 0);
});
test("a rescue wins over a monster holding the swimmer", () => {
  const { S, me } = mk({ level: 1 }); quiet(S);
  const s = addSwimmer(S, { x: 700, y: 400 });
  const m = monster(S, s, { sub: false });
  pinned(S, m, s, 1.0);
  me.x = s.x; me.y = s.y; pinned(S, m, s, DT);
  assert.equal(S.caught, 1); assert.equal(S.missed, 0);
});
test("a surfaced monster touching the ring stuns it for 1 s (no steering), then 1.5 s of immunity", () => {
  const { S, log, me } = mk({ level: 1 }); quiet(S);
  const m = monster(S, me, { sub: false });
  S.update(DT, { dx: 1, dy: 0, dash: false });
  assert.equal(S.selfPos.stun, 1); assert.equal(me.stunned, true); assert.deepEqual(log, ["sound:stun"]);
  m.x = 50; m.y = 50; // gone
  const x0 = me.x; run(S, 0.9, { dx: 1, dy: 0, dash: false });
  assert.equal(me.x, x0, "can't steer while stunned");
  run(S, 0.15, { dx: 1, dy: 0, dash: false });
  assert.ok(me.x > x0 && me.stunned === false);
  m.x = me.x; m.y = me.y; S.update(DT, STILL);
  assert.deepEqual(log, ["sound:stun"], "immune right after");
});
test("monsters dive now and then and come back up; they never leave the water", () => {
  const { S } = mk({ level: 5, seed: 21 }); S.swimmers = []; S.spawnTimer = 1e9;
  let under = 0, total = 0;
  for (let t = 0; t < 60; t += DT) { S.update(DT, STILL); for (const m of S.monsters) { total++; if (m.sub > 0.5) under++; assert.ok(m.x >= m.r - 1e-9 && m.x <= S.world.w - m.r + 1e-9 && m.y >= m.r - 1e-9 && m.y <= shoreY(S.world) - m.r + 1e-9); } }
  assert.ok(under > 0 && under < total * 0.5, `under water ${(100 * under / total).toFixed(0)} % of the time`);
});

console.log(`\n${fails ? "FAIL" : "PASS"}: ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);

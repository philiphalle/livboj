#!/usr/bin/env node
// Feel check for the network rates: what a joiner's ring looks like on the HOST's screen, and how long
// a joiner's rescue takes to register — for this build and (--compare <commit>) an older one.
//
//   node tools/feel.mjs --relay ws://127.0.0.1:8787 --compare 3ee8dd0 [--seconds 45]
//
// Host + one joiner (desktop pages, keyboard bot on the joiner that chases the nearest swimmer, no
// dashes: normal speed is 300 px/s = 5 px a frame at 60 fps). On the host, every frame: where the
// remote ring is DRAWN (debug().players[].drawn; older builds draw the raw position) -> the step per
// frame. On the joiner, every frame: the first frame its own ring overlaps a swimmer on its own screen,
// and the frame its rescue count goes up (the host's snapshot) -> the rescue delay it feels.
// The leaderboard is stubbed. Headless frame times, one machine: compare the two builds, not phones.
import { serve, launch, stubBoard, ROOT } from "./harness.mjs";
import { execFileSync } from "node:child_process";

const args = {}; const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith("--")) { const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true"; args[a.slice(2)] = v; } }
const RELAY = (args.relay || "ws://127.0.0.1:8787").replace(/\/$/, "");
const SECONDS = +(args.seconds || 45);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };

const server = await serve();
const browser = await launch();
const FILES = ["game.js", "net.js", "sim.js", "render.js", "hud.js", "water.js", "boot.js", "index.html", "host.html"];

async function run(rev) {
  server.overrides.clear();
  if (rev) for (const f of FILES) { try { server.overrides.set("/" + f, execFileSync("git", ["show", `${rev}:${f}`], { cwd: ROOT, encoding: "utf8" })); } catch {} }
  const room = Array.from({ length: 5 }, () => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[(Math.random() * 31) | 0]).join("");
  const q = `?room=${room}&relay=${encodeURIComponent(RELAY)}&water=2d`;
  const mk = async () => { const context = await browser.newContext({ viewport: { width: 1366, height: 768 } }); await stubBoard(context); const page = await context.newPage(); const errors = []; page.on("pageerror", (e) => errors.push(e.message)); return { context, page, errors }; };
  const H = await mk(), J = await mk();
  await H.page.goto(server.url + "host.html" + q); await H.page.waitForFunction(() => !!document.getElementById("create"));
  await H.page.fill("#name", "Värd"); await H.page.click("#create");
  await J.page.goto(server.url + "index.html" + q); await J.page.waitForFunction(() => !!document.getElementById("join"));
  await J.page.fill("#name", "Gäst"); await J.page.click("#join");
  await H.page.waitForFunction(() => window.livboj && window.livboj.roster().length === 2, null, { timeout: 20000 });
  await J.page.waitForFunction(() => window.livboj && window.livboj.debug().n === 2, null, { timeout: 20000 });
  await H.page.click("#start");
  await J.page.waitForFunction(() => window.livboj.debug().phase === "play", null, { timeout: 10000 });
  // host: the remote ring's drawn position every frame (only in play)
  await H.page.evaluate(() => {
    window.__drawn = []; window.__hostLog = [];
    const f = () => { try { const d = window.livboj.debug(); if (d.phase === "play") { const p = d.players.find((x) => !x.you); if (p) window.__drawn.push([performance.now(), ...(p.drawn || [p.x, p.y])]); } else window.__drawn.push(null); } catch {} requestAnimationFrame(f); };
    requestAnimationFrame(f);
    // the host keeps the game going: on from the level board, a new game after a game over
    setInterval(() => { const d = window.livboj.debug(); if (["cleared", "over", "win", "lobby"].includes(d.phase)) document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })), document.body.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true })); }, 1500);
  });
  // joiner: a keyboard bot (nearest swimmer, no dashes) + the rescue delay it sees
  await J.page.evaluate(() => {
    const held = new Set(), key = (k, on) => { if (on === held.has(k)) return; if (on) held.add(k); else held.delete(k); document.body.dispatchEvent(new KeyboardEvent(on ? "keydown" : "keyup", { key: k, bubbles: true })); };
    window.__delays = []; let streak = 0, lastTouch = 0, myR = -1;
    const f = (now) => {
      try {
        const d = window.livboj.debug();
        if (d.phase === "play") {
          const me = d.self, touching = d.sw.some((s) => Math.hypot(s[0] - me.x, s[1] - me.y) < 46);
          if (touching) { if (!streak) streak = now; lastTouch = now; } else if (streak && now - lastTouch > 400) streak = 0;
          const i = d.players.findIndex((p) => p.you), r = (d.players[i] && d.players[i].rescues != null) ? d.players[i].rescues : ((d.rescues || [])[i] || {}).r || 0;
          if (myR >= 0 && r > myR && streak) { window.__delays.push(now - streak); streak = 0; }
          myR = r;
          let t = null, bd = 1e9; for (const s of d.sw) { const dd = Math.hypot(s[0] - me.x, s[1] - me.y); if (dd < bd) { bd = dd; t = s; } }
          if (t) { const dx = t[0] - me.x, dy = t[1] - me.y; key("ArrowRight", dx > 6); key("ArrowLeft", dx < -6); key("ArrowDown", dy > 6); key("ArrowUp", dy < -6); }
        } else { myR = -1; streak = 0; for (const k of ["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown"]) key(k, false); }
      } catch {}
      requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
  await sleep(SECONDS * 1000);
  const drawn = await H.page.evaluate(() => window.__drawn), delays = await J.page.evaluate(() => window.__delays);
  const errs = [...H.errors, ...J.errors];
  await H.context.close(); await J.context.close();
  // steps per frame while the ring is moving (a 250 ms window around the frame covers > 25 px)
  const steps = [], idle = [];
  for (let i = 1; i < drawn.length; i++) {
    const a = drawn[i - 1], b = drawn[i]; if (!a || !b) continue;
    let j = i; while (j > 0 && drawn[j - 1] && b[0] - drawn[j - 1][0] < 250) j--;
    const w = drawn[j]; if (!w || Math.hypot(b[1] - w[1], b[2] - w[2]) < 25) continue; // standing (or nearly)
    const s = Math.hypot(b[1] - a[1], b[2] - a[2]); steps.push(s); if (s < 0.5) idle.push(1);
  }
  return { rev: rev || "this build", frames: drawn.filter(Boolean).length, moving: steps.length, steps, idle: idle.length, delays, errs };
}

const rows = [];
if (args.compare) rows.push(await run(args.compare));
rows.push(await run(""));
await browser.close(); await server.close();
console.log(`\nremote ring on the host's screen (px per frame while moving; 300 px/s = 5 px/frame at 60 fps) and the joiner's rescue delay (ms from its ring touching the swimmer on its own screen to its own rescue count going up)`);
console.log("build         frames  moving  step p50  p95   p99   max   frames standing still mid-move   rescues  delay p50  p95   max");
for (const r of rows) console.log(`${r.rev.padEnd(12)} ${String(r.frames).padStart(7)} ${String(r.moving).padStart(7)} ${pct(r.steps, 50).toFixed(1).padStart(9)} ${pct(r.steps, 95).toFixed(1).padStart(5)} ${pct(r.steps, 99).toFixed(1).padStart(5)} ${Math.max(...r.steps).toFixed(1).padStart(5)}   ${(100 * r.idle / Math.max(1, r.moving)).toFixed(0).padStart(3)} %                          ${String(r.delays.length).padStart(7)} ${pct(r.delays, 50).toFixed(0).padStart(10)} ${pct(r.delays, 95).toFixed(0).padStart(5)} ${Math.max(...r.delays).toFixed(0).padStart(5)}${r.errs.length ? "   ERRORS: " + r.errs.join(" | ") : ""}`);
const cur = rows.at(-1);
const X = 12;
const bad = pct(cur.steps, 99) > X || cur.errs.length || !cur.delays.length;
console.log(`\n${bad ? "FAIL" : "PASS"}: this build's p99 step ${pct(cur.steps, 99).toFixed(1)} px (limit ${X}), ${cur.delays.length} rescues measured, ${cur.errs.length} errors`);
process.exit(bad ? 1 : 0);

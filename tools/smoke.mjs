#!/usr/bin/env node
// Automated smoke test (headless Chromium, the folder served locally).
//
//   node tools/smoke.mjs                 # everything except the live-relay test
//   node tools/smoke.mjs --live          # also host + join through the live relay (random room code)
//   node tools/smoke.mjs --only layout,fullscreen,keys,board,cache,menu,forslag,live
//   node tools/smoke.mjs --relay ws://localhost:8787 --only live    # against `wrangler dev --local`
//
// Checks: no console errors / page errors; layout at the standard sizes (canvas
// 3:2, inside the viewport, >= 90 % of the limiting side, backing store caps,
// "Vrid mobilen" in portrait, the fullscreen button clear of the HUD); the menu
// usable and scrollable on phones; fullscreen by a real click and by F (not
// while typing); blur releases held keys; the leaderboard outbox (a failed post
// is queued and flushed exactly once on the next load, a 4xx is dropped);
// cache busting (the build id covers every module, each module loads once under
// ?v=<build>, a change to sim.js alone is noticed and a reload runs it); and
// with --live, that a forced reconnect neither drops nor duplicates a player
// and never starts a host election. The rules themselves: tools/sim-test.mjs.
//
// The leaderboard is ALWAYS stubbed (harness.mjs stubBoard): no test posts to the real board.
import { serve, launch, stubBoard } from "./harness.mjs";

const args = {}; const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith("--")) { const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true"; args[a.slice(2)] = v; } }
const ONLY = args.only ? new Set(args.only.split(",")) : null;
const want = (k) => (ONLY ? ONLY.has(k) : k !== "live" || args.live === "true");
const RELAY_Q = args.relay ? `relay=${encodeURIComponent(args.relay)}` : "";

let fails = 0, passes = 0;
const ok = (cond, msg, extra = "") => { if (cond) { passes++; console.log(`  ok    ${msg}${extra ? "  " + extra : ""}`); } else { fails++; console.log(`  FAIL  ${msg}${extra ? "  " + extra : ""}`); } return !!cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await serve();
const BASE = server.url;
const browser = await launch();
const allErrors = [];

async function newPage({ w = 1366, h = 768, dsf = 1, touch = false, board } = {}) {
  const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dsf, hasTouch: touch, isMobile: touch });
  const log = await stubBoard(context, board || {});
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => { errors.push("pageerror: " + e.message); allErrors.push(e.message); });
  page.on("console", (m) => { if (m.type() === "error") { errors.push("console: " + m.text()); allErrors.push(m.text()); } });
  return { context, page, errors, log };
}
const url = (p, q = "") => BASE + p + ((q || RELAY_Q) ? "?" + [q, RELAY_Q].filter(Boolean).join("&") : "");
async function openMenu(page, q = "") {
  await page.goto(url("index.html", q), { waitUntil: "load" });
  await page.waitForFunction(() => document.getElementById("solo") && document.getElementById("boardSrc").textContent !== "hämtar…", null, { timeout: 15000 });
}
async function startSolo(page, name = "Testaren") {
  await page.fill("#name", name);
  await page.click("#solo");
  await page.waitForFunction(() => !!window.livboj && !document.getElementById("stage").hidden);
}
const waitPlay = (page) => page.waitForFunction(() => window.livboj && window.livboj.debug().phase === "play", null, { timeout: 10000 });

// ---------------------------------------------------------------- layout
if (want("layout")) {
  console.log("layout");
  const sizes = [
    { w: 1920, h: 1080, dsf: 2 }, { w: 2560, h: 1440, dsf: 2 }, { w: 1366, h: 768, dsf: 1 },
    { w: 844, h: 390, dsf: 3, touch: true }, { w: 390, h: 844, dsf: 3, touch: true },
  ];
  for (const s of sizes) {
    const tag = `${s.w}x${s.h}@${s.dsf}${s.touch ? " touch" : ""}`;
    const { context, page, errors } = await newPage(s);
    await openMenu(page);
    await startSolo(page);
    await sleep(700);
    const m = await page.evaluate(() => {
      const c = document.getElementById("game"), r = c.getBoundingClientRect();
      const f = document.getElementById("fsBtn"), fr = f.getBoundingClientRect();
      const rc = document.getElementById("rotateCard");
      const vis = (el) => !!el && !el.hidden && getComputedStyle(el).display !== "none";
      return { r: { x: r.x, y: r.y, w: r.width, h: r.height }, backW: c.width, backH: c.height, vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio,
        fs: vis(f) ? { x: fr.x, y: fr.y, w: fr.width, h: fr.height } : null, rotate: vis(rc), coarse: matchMedia("(pointer: coarse)").matches,
        brand: vis(document.getElementById("brand")), hint: !!document.querySelector(".hint") && getComputedStyle(document.querySelector(".hint")).display !== "none" };
    });
    const { r } = m;
    ok(Math.abs(r.w / r.h - 1.5) < 0.01, `${tag}: canvas is 3:2`, `${r.w.toFixed(0)}x${r.h.toFixed(0)}`);
    ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= m.vw + 0.5 && r.y + r.h <= m.vh + 0.5, `${tag}: canvas inside the viewport`);
    const use = Math.max(r.w / m.vw, r.h / m.vh);
    ok(use >= 0.9, `${tag}: canvas uses >= 90% of the limiting side`, `${(use * 100).toFixed(1)}%`);
    const cap = m.coarse ? 1.5 : 2, expectW = Math.round(r.w * Math.min(m.dpr, cap, 2560 / r.w));
    ok(m.backW <= 2560 && m.backW / r.w <= cap + 0.01 && Math.abs(m.backW - expectW) <= 1, `${tag}: backing store capped`, `backing ${m.backW}x${m.backH}, ratio ${(m.backW / r.w).toFixed(2)} (dpr ${m.dpr}, cap ${cap}, max 2560)`);
    ok(!m.brand && !m.hint, `${tag}: brand header and hint hidden while playing`);
    ok(m.rotate === !!(s.touch && s.h > s.w), `${tag}: rotate card ${s.h > s.w && s.touch ? "shown" : "not shown"}`);
    if (ok(!!m.fs, `${tag}: fullscreen button shown`)) {
      // in logical 900x600 coords: clear of the mute hit area (28,572 r24), the dash button (834,534 r46),
      // the HUD rows along the top (y < 64), the host's quit button (768,44 114x24)
      const k = 900 / r.w, L = { x: (m.fs.x - r.x) * k, y: (m.fs.y - r.y) * k, w: m.fs.w * k, h: m.fs.h * k };
      const circleHit = (cx, cy, rr) => { const nx = Math.max(L.x, Math.min(cx, L.x + L.w)), ny = Math.max(L.y, Math.min(cy, L.y + L.h)); return Math.hypot(nx - cx, ny - cy) < rr; };
      const inside = L.x >= 0 && L.y >= 0 && L.x + L.w <= 900.5 && L.y + L.h <= 600.5;
      const outside = (L.y >= 600 || L.x >= 900 || L.x + L.w <= 0 || L.y + L.h <= 0) && m.fs.x >= 0 && m.fs.y >= 0 && m.fs.x + m.fs.w <= m.vw && m.fs.y + m.fs.h <= m.vh;
      ok(outside || inside && !circleHit(28, 572, 24) && !circleHit(834, 534, 46) && L.y > 64 && !(L.x < 882 && L.x + L.w > 768 && L.y < 68 && L.y + L.h > 44),
        `${tag}: fullscreen button clear of HUD/mute/dash/quit (or outside the canvas, on screen)`, `logical box ${L.x.toFixed(0)},${L.y.toFixed(0)} ${L.w.toFixed(0)}x${L.h.toFixed(0)}`);
    }
    if (s.touch && s.h > s.w) { // a tap closes the card, the game keeps running
      await page.tap("#rotateCard");
      ok(await page.evaluate(() => document.getElementById("rotateCard").hidden), `${tag}: tapping the rotate card closes it`);
      ok(await page.evaluate(() => ["intro", "play"].includes(window.livboj.debug().phase)), `${tag}: the game keeps running under it`);
    }
    // resize: the backing store follows
    await page.setViewportSize({ width: Math.round(s.w * 0.7), height: Math.round(s.h * 0.7) });
    await sleep(300);
    const after = await page.evaluate(() => ({ cw: document.getElementById("game").clientWidth, bw: document.getElementById("game").width }));
    ok(Math.abs(after.bw - Math.round(after.cw * Math.min(s.dsf, s.touch ? 1.5 : 2, 2560 / after.cw))) <= 1, `${tag}: backing follows a resize`, `css ${after.cw} -> backing ${after.bw}`);
    ok(!errors.length, `${tag}: no console/page errors`, errors.join(" | "));
    await context.close();
  }
}

// ---------------------------------------------------------------- menu on phones
if (want("menu")) {
  console.log("menu");
  for (const s of [{ w: 390, h: 844 }, { w: 375, h: 667 }, { w: 320, h: 568 }]) {
    const tag = `${s.w}x${s.h} touch`;
    const { context, page, errors } = await newPage({ ...s, dsf: 2, touch: true, board: { entries: fakeBoard(10) } });
    await openMenu(page, "homehint=1");
    const m = await page.evaluate(() => {
      const cards = document.getElementById("cards"), solo = document.getElementById("solo").getBoundingClientRect(), name = document.getElementById("name").getBoundingClientRect();
      const brand = document.getElementById("brand").getBoundingClientRect(), hint = document.getElementById("homeHint");
      return { docScroll: document.documentElement.scrollHeight > innerHeight + 1, brandTop: brand.top, nameTop: name.top, soloBottom: solo.bottom, vh: innerHeight,
        overflow: cards.scrollHeight > cards.clientHeight + 1, hint: !hint.hidden };
    });
    ok(m.brandTop >= 0 && m.nameTop >= 0 && m.soloBottom <= m.vh, `${tag}: brand, name field and "Spela själv" on screen`, `solo bottom ${m.soloBottom.toFixed(0)} / ${m.vh}`);
    ok(m.hint, `${tag}: home-screen hint shown (forced with ?homehint=1)`);
    if (m.overflow) {
      await page.evaluate(() => { const c = document.getElementById("cards"); c.scrollTop = c.scrollHeight; });
      const vis = await page.evaluate(() => { const c = document.getElementById("cards"), li = [...document.querySelectorAll("#board li")].pop().getBoundingClientRect(); return { top: c.scrollTop, liBottom: li.bottom, cb: c.getBoundingClientRect().bottom }; });
      ok(vis.top > 0 && vis.liBottom <= vis.cb + 1, `${tag}: the cards scroll inside the page to the last leaderboard row`, `scrollTop ${vis.top}`);
    } else ok(true, `${tag}: everything fits without scrolling`);
    ok(!errors.length, `${tag}: no console/page errors`, errors.join(" | "));
    await context.close();
  }
  { // the hint's dismissal is remembered (30 days) — on an iPhone UA, not forced
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" });
    await stubBoard(context);
    const page = await context.newPage();
    await openMenu(page);
    ok(await page.evaluate(() => !document.getElementById("homeHint").hidden), "iPhone Safari UA: home-screen hint shown");
    ok(await page.evaluate(() => !document.getElementById("fsBtn") || document.getElementById("fsBtn").hidden), "iPhone Safari UA: no fullscreen button on the menu");
    await page.tap("#homeHint button");
    await openMenu(page);
    ok(await page.evaluate(() => document.getElementById("homeHint").hidden && +localStorage.getItem("livboj-homehint-until") > Date.now() + 29 * 864e5), "iPhone Safari UA: dismissed hint stays away after a reload (30 days)");
    await context.close();
    const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 300.0.0" });
    await stubBoard(ctx2);
    const p2 = await ctx2.newPage();
    await openMenu(p2);
    ok(await p2.evaluate(() => document.getElementById("homeHint").hidden), "Instagram in-app UA: no home-screen hint");
    await ctx2.close();
  }
}

// ---------------------------------------------------------------- fullscreen
if (want("fullscreen")) {
  console.log("fullscreen");
  const { context, page, errors } = await newPage({ w: 1366, h: 768 });
  await openMenu(page);
  await page.click("#name"); await page.keyboard.type("Fia F");
  ok(await page.evaluate(() => !document.fullscreenElement && document.getElementById("name").value === "Fia F"), "F typed into the name field: no fullscreen, the text is typed");
  await page.fill("#name", "Fia");
  await page.click("#solo");
  await page.waitForFunction(() => !!window.livboj && !document.getElementById("stage").hidden);
  await page.click("#fsBtn");
  await page.waitForFunction(() => !!document.fullscreenElement && document.documentElement.classList.contains("is-fs"), null, { timeout: 3000 }).catch(() => {});
  const fsOn = await page.evaluate(() => ({ el: document.fullscreenElement && document.fullscreenElement.tagName, cls: document.documentElement.classList.contains("is-fs"), label: document.getElementById("fsBtn").getAttribute("aria-label"), active: document.activeElement && document.activeElement.id }));
  ok(fsOn.el === "HTML" && fsOn.cls, "real click on the button enters fullscreen", JSON.stringify(fsOn));
  ok(fsOn.label === "Avsluta helskärm" && fsOn.active !== "fsBtn", "button label flips, button gives up focus (Space/Enter stay game keys)");
  const inFs = await page.evaluate(() => { const r = document.getElementById("game").getBoundingClientRect(); return { w: r.width, h: r.height, vw: innerWidth, vh: innerHeight }; });
  ok(Math.abs(inFs.w / inFs.h - 1.5) < 0.01 && Math.max(inFs.w / inFs.vw, inFs.h / inFs.vh) >= 0.9, "in fullscreen the canvas is 3:2 and fills the screen", `${inFs.w}x${inFs.h} in ${inFs.vw}x${inFs.vh}`);
  await page.click("#fsBtn");
  await page.waitForFunction(() => !document.fullscreenElement, null, { timeout: 3000 }).catch(() => {});
  ok(await page.evaluate(() => !document.fullscreenElement), "second click leaves fullscreen");
  await page.keyboard.press("f");
  await page.waitForFunction(() => !!document.fullscreenElement, null, { timeout: 3000 }).catch(() => {});
  ok(await page.evaluate(() => !!document.fullscreenElement), "F enters fullscreen while playing");
  await page.keyboard.press("F");
  await page.waitForFunction(() => !document.fullscreenElement, null, { timeout: 3000 }).catch(() => {});
  ok(await page.evaluate(() => !document.fullscreenElement), "F again leaves it");
  // a text field focused during play (none exists today: injected to test the guard)
  await page.evaluate(() => { const t = document.createElement("textarea"); t.id = "probe"; t.style.cssText = "position:fixed;top:0;left:0"; document.body.appendChild(t); });
  await page.focus("#probe"); await page.keyboard.press("f");
  await sleep(400);
  ok(await page.evaluate(() => !document.fullscreenElement && document.getElementById("probe").value === "f"), "F typed into a textarea during play: no fullscreen");
  ok(!errors.length, "no console/page errors", errors.join(" | "));
  await context.close();
}

// ---------------------------------------------------------------- held keys
if (want("keys")) {
  console.log("keys");
  const { context, page, errors } = await newPage({ w: 1366, h: 768 });
  await openMenu(page); await startSolo(page); await waitPlay(page);
  const x0 = await page.evaluate(() => window.livboj.debug().self.x);
  await page.keyboard.down("ArrowRight");
  await sleep(400);
  const x1 = await page.evaluate(() => window.livboj.debug().self.x);
  ok(x1 > x0 + 20, "holding ArrowRight moves the ring", `${x0} -> ${x1}`);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await sleep(100);
  const x2 = await page.evaluate(() => window.livboj.debug().self.x);
  await sleep(500);
  const x3 = await page.evaluate(() => window.livboj.debug().self.x);
  ok(Math.abs(x3 - x2) <= 2, "after the window blurs the ring stops (key still physically held, no keyup)", `${x2} -> ${x3}`);
  await page.keyboard.up("ArrowRight");
  // the same through visibility (tab switched away)
  await page.keyboard.down("ArrowDown"); await sleep(300);
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); Object.defineProperty(document, "hidden", { configurable: true, get: () => false }); document.dispatchEvent(new Event("visibilitychange")); });
  const y2 = await page.evaluate(() => window.livboj.debug().self.y); await sleep(500);
  const y3 = await page.evaluate(() => window.livboj.debug().self.y);
  ok(Math.abs(y3 - y2) <= 2, "after the page was hidden the ring stops", `${y2} -> ${y3}`);
  await page.keyboard.up("ArrowDown");
  ok(!errors.length, "no console/page errors", errors.join(" | "));
  await context.close();
}

// ---------------------------------------------------------------- leaderboard outbox
async function scoreAndQuit(page) {
  // a tiny bot: arrow keys towards the nearest swimmer until one is rescued, then end the game
  const deadline = Date.now() + 40000; const held = new Set();
  const set = async (k, on) => { if (on && !held.has(k)) { held.add(k); await page.keyboard.down(k); } else if (!on && held.has(k)) { held.delete(k); await page.keyboard.up(k); } };
  while (Date.now() < deadline) {
    const d = await page.evaluate(() => window.livboj.debug());
    if (d.caught > 0) break;
    if (d.phase !== "play" || !d.sw.length) { await sleep(100); continue; }
    const t = d.sw.reduce((b, s) => (Math.hypot(s[0] - d.self.x, s[1] - d.self.y) < Math.hypot(b[0] - d.self.x, b[1] - d.self.y) ? s : b));
    const dx = t[0] - d.self.x, dy = t[1] - d.self.y;
    await set("ArrowRight", dx > 8); await set("ArrowLeft", dx < -8); await set("ArrowDown", dy > 8); await set("ArrowUp", dy < -8);
    await sleep(60);
  }
  for (const k of [...held]) await set(k, false);
  const caught = await page.evaluate(() => window.livboj.debug().caught);
  await page.evaluate(() => window.livboj.quitGame());
  return caught;
}
if (want("board")) {
  console.log("board");
  let mode = "fail";
  const { context, page, errors, log } = await newPage({ w: 1366, h: 768, board: {
    onPost: async (body, route) => {
      if (mode === "fail") { await route.fulfill({ status: 503, body: "down" }); return true; }
      if (mode === "reject") { await route.fulfill({ status: 400, headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: '{"error":"bad"}' }); return true; }
      return false;
    } } });
  await openMenu(page); await startSolo(page); await waitPlay(page);
  const caught = await scoreAndQuit(page);
  ok(caught > 0, "bot rescued a swimmer (score > 0)", `caught ${caught}`);
  await sleep(3500); // the post and its one retry (2 s later)
  const q1 = await page.evaluate(() => JSON.parse(localStorage.getItem("livboj-board-queue") || "[]"));
  const id = q1[0] && q1[0].id;
  const postsWith = (i) => log.posts.filter((b) => b && Array.isArray(b.entries) && b.entries.some((e) => e.id === i)).length;
  ok(q1.length === 1 && !!id, "POST failing: the result waits in the localStorage queue", `queue ${q1.length}, id ${id}`);
  ok(postsWith(id) === 2, "…after exactly one retry", `attempts ${postsWith(id)}`);
  mode = "ok";
  const before = postsWith(id);
  await openMenu(page); // reload: game.js flushes the queue on load
  await sleep(1500);
  const q2 = await page.evaluate(() => localStorage.getItem("livboj-board-queue"));
  ok(postsWith(id) - before === 1 && !q2, "reload with POST working: the queue flushes exactly once and is empty", `posts ${postsWith(id) - before}, queue ${q2}`);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await openMenu(page);
  await sleep(1500);
  ok(postsWith(id) - before === 1, "nothing re-sent afterwards (online event + another reload)", `posts ${postsWith(id) - before}`);
  // a 4xx drops the entry, no retry loop
  mode = "reject";
  await page.evaluate(() => localStorage.setItem("livboj-board-queue", JSON.stringify([{ id: "smoke-test-4xx", score: 1, level: 1, n: 1, ts: Date.now(), players: [] }])));
  await openMenu(page);
  await sleep(1500);
  ok(postsWith("smoke-test-4xx") === 1 && !(await page.evaluate(() => localStorage.getItem("livboj-board-queue"))), "a 4xx answer drops the entry after one attempt", `attempts ${postsWith("smoke-test-4xx")}`);
  ok(!errors.filter((e) => !/503|400|Failed to load resource/.test(e)).length, "no console/page errors (besides the stubbed failures)", errors.join(" | "));
  await context.close();
}

// ---------------------------------------------------------------- cache busting across modules
// GitHub Pages caches every file for 10 minutes (the harness does the same). The
// build id must cover every module, and every module must be loaded under a
// URL carrying it — or a changed sim.js alone would run stale or mixed code.
if (want("cache")) {
  console.log("cache");
  const fs = await import("node:fs"), path = await import("node:path");
  const { ROOT } = await import("./harness.mjs");
  const { MODULES } = await import("../boot.js");
  const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
  const rootJs = fs.readdirSync(ROOT).filter((f) => f.endsWith(".js") && f !== "boot.js").sort();
  ok(JSON.stringify(rootJs) === JSON.stringify([...MODULES].sort()), "boot.js MODULES lists exactly the game's module files", MODULES.join(", "));
  const staticSib = MODULES.filter((f) => /^\s*(import|export)\b[^;(]*?\bfrom\s*["']\.\.?\//m.test(src(f)) || /^\s*import\s*["']\.\.?\//m.test(src(f)));
  const unversioned = MODULES.filter((f) => (src(f).match(/import\(\s*[`"']\.\/[^`"']*[`"']/g) || []).some((s) => !/\$\{(V|new URL\(import\.meta\.url\)\.search)\}/.test(s)));
  ok(!staticSib.length && !unversioned.length, "no module imports a sibling statically or without its own ?v=", [...staticSib, ...unversioned].join(", "));

  const { context, page, errors } = await newPage({ w: 1366, h: 768 });
  const reqs = [];
  page.on("request", (r) => { const u = new URL(r.url()); if (u.origin + "/" === BASE && u.pathname.endsWith(".js") && r.method() === "GET") reqs.push(u.pathname.slice(1) + u.search); });
  const build = () => page.evaluate(() => import("./boot.js").then((m) => m.currentBuild()));
  const head = async (f) => (await fetch(BASE + f, { method: "HEAD" })).headers.get("etag");
  // each module requested under exactly one URL, the one with this build (two URLs = two module instances)
  const loadedUnder = (b) => MODULES.every((f) => { const urls = new Set(reqs.filter((r) => r.split("?")[0] === f)); return urls.size === 1 && urls.has(`${f}?v=${b}`); });
  await openMenu(page);
  const b1 = await build();
  ok(/^[0-9a-f]{16}$/.test(b1) && loadedUnder(b1), "every module is loaded once, under ?v=<build>", `build ${b1}; ${reqs.filter((r) => !r.startsWith("boot.js")).join(" ")}`);
  const simSrc = src("sim.js"), game0 = await head("game.js");
  server.overrides.set("/sim.js", simSrc + '\nglobalThis.__simProbe = "v2";\n'); // "deploy" a sim.js change — nothing else
  const b2 = await build();
  ok(b2 && b2 !== b1 && (await head("game.js")) === game0, "changing only sim.js changes the build (game.js's own ETag is unchanged)", `${b1} -> ${b2}`);
  // idle on the menu: the watcher reloads silently, and the reload runs the new sim.js
  reqs.length = 0;
  const reloaded = page.waitForNavigation({ waitUntil: "load", timeout: 8000 }).then(() => true, () => false);
  await page.evaluate(() => window.dispatchEvent(new Event("focus"))); // the watcher checks on focus (and every minute)
  const didReload = await reloaded;
  if (didReload) await page.waitForFunction(() => document.getElementById("solo") && document.getElementById("boardSrc").textContent !== "hämtar…", null, { timeout: 15000 });
  ok(didReload && await page.evaluate(() => globalThis.__simProbe === "v2") && loadedUnder(b2), "the update watcher noticed it on the menu and reloaded; the reload runs the new sim.js, all modules under the new build",
    `${didReload ? "reloaded" : "NO reload"}: ${reqs.filter((r) => !r.startsWith("boot.js")).join(" ")}`);
  // mid-game: a banner instead, and "Uppdatera nu" brings the new code
  await startSolo(page); await waitPlay(page);
  server.overrides.set("/sim.js", simSrc + '\nglobalThis.__simProbe = "v3";\n');
  const b3 = await build();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForSelector("#livboj-update", { timeout: 5000 }).catch(() => {});
  const banner = await page.evaluate(() => !!document.getElementById("livboj-update") && !!window.livboj && window.livboj.debug().phase === "play");
  ok(banner, "mid-game the watcher shows the update banner and does not reload");
  reqs.length = 0;
  if (banner) {
    await Promise.all([page.waitForNavigation({ waitUntil: "load" }), page.click("#livboj-update button")]);
    // (#solo is in the HTML; the board line changes only once the modules have loaded)
    await page.waitForFunction(() => document.getElementById("solo") && document.getElementById("boardSrc").textContent !== "hämtar…", null, { timeout: 15000 });
  }
  const probe3 = banner ? await page.evaluate(() => globalThis.__simProbe) : "";
  ok(probe3 === "v3" && loadedUnder(b3), "\"Uppdatera nu\" reloads into the new build", `build ${b3}, sim.js probe ${probe3}: ${reqs.filter((r) => !r.startsWith("boot.js")).join(" ")}`);
  server.overrides.clear();
  ok((await build()) === b1, "back to the files on disk: back to the first build");
  ok(!errors.length, "no console/page errors", errors.join(" | "));
  await context.close();
}

// ---------------------------------------------------------------- live relay: host + join, forced reconnects
if (want("live")) {
  console.log("live" + (args.relay ? ` (${args.relay})` : " (production relay; leaderboard stubbed)"));
  const room = Array.from({ length: 5 }, () => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[(Math.random() * 31) | 0]).join("");
  const H = await newPage({ w: 1366, h: 768 }), J = await newPage({ w: 1366, h: 768 });
  await H.page.goto(url("host.html", `room=${room}`), { waitUntil: "load" });
  await H.page.waitForFunction(() => !!document.getElementById("create"));
  await H.page.fill("#name", "Värden"); await H.page.click("#create");
  await J.page.goto(url("index.html", `room=${room}`), { waitUntil: "load" });
  await J.page.waitForFunction(() => !!document.getElementById("join"));
  await J.page.fill("#name", "Gästen"); await J.page.click("#join");
  const both = async () => {
    await H.page.waitForFunction(() => window.livboj && window.livboj.roster().length === 2, null, { timeout: 20000 });
    await J.page.waitForFunction(() => window.livboj && window.livboj.debug().n === 2, null, { timeout: 20000 });
  };
  let saw = true; try { await both(); } catch { saw = false; }
  ok(saw, `host and joiner see each other (room ${room})`);
  const names = async () => ({ host: await H.page.evaluate(() => window.livboj.roster().map((p) => p.name).sort().join(",")), join: await J.page.evaluate(() => window.livboj.debug().players.map((p) => p.name).sort().join(",")) });
  console.log("        rosters:", JSON.stringify(await names()));
  // samplers: the host's roster and the joiner's role, every 25 ms
  const sampler = () => { window.__s = []; setInterval(() => { const L = window.livboj, d = L.debug(); window.__s.push({ n: L.roster().length, ids: L.roster().map((p) => p.id).join(","), auth: d.authoritative, promoted: d.promoted, peers: L.relay() ? L.relay().peers.length : -1 }); }, 25); };
  await H.page.evaluate(sampler); await J.page.evaluate(sampler);
  const hidden = (page, on) => page.evaluate((on) => { Object.defineProperty(document, "hidden", { configurable: true, get: () => on }); Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (on ? "hidden" : "visible") }); document.dispatchEvent(new Event("visibilitychange")); }, on);
  async function check(label, page, action) {
    await H.page.evaluate(() => { window.__s.length = 0; }); await J.page.evaluate(() => { window.__s.length = 0; });
    const before = await page.evaluate(() => window.livboj.relay());
    await action();
    await sleep(4500); // > the 2.5 s leave grace: a wrongly kept leave would have fired by now
    const after = await page.evaluate(() => window.livboj.relay());
    const hs = await H.page.evaluate(() => window.__s), js = await J.page.evaluate(() => window.__s);
    const ids = new Set(hs.map((s) => s.ids));
    ok(after.connects === before.connects + 1 && after.open, `${label}: a new socket was opened`, `connects ${before.connects} -> ${after.connects}, forced ${after.forced}`);
    ok(hs.length > 50 && hs.every((s) => s.n === 2) && ids.size === 1, `${label}: the host's roster stayed exactly the same 2 players throughout`, `${hs.length} samples, sizes ${[...new Set(hs.map((s) => s.n))].join("/")}, rosters seen ${ids.size}`);
    ok(hs.every((s) => s.auth) && js.every((s) => !s.auth && !s.promoted), `${label}: no host election (host stays host, joiner never promoted)`);
    ok(hs.every((s) => s.peers === 1) && js.every((s) => s.peers === 1), `${label}: relay peer lists never dropped the other side`, `host ${[...new Set(hs.map((s) => s.peers))]}, joiner ${[...new Set(js.map((s) => s.peers))]}`);
    const st = await H.page.evaluate(() => window.livboj.relay());
    ok(st.pendingLeaves === 0, `${label}: no leave left pending`);
  }
  await check("joiner hidden 6 s then visible (lobby)", J.page, async () => { await hidden(J.page, true); await sleep(6000); await hidden(J.page, false); });
  await check("joiner 'online' event (lobby)", J.page, () => J.page.evaluate(() => window.dispatchEvent(new Event("online"))));
  await check("host 'online' event (lobby)", H.page, () => H.page.evaluate(() => window.dispatchEvent(new Event("online"))));
  await H.page.click("#start");
  await J.page.waitForFunction(() => ["intro", "play"].includes(window.livboj.debug().phase), null, { timeout: 10000 });
  await check("joiner hidden 6 s then visible (in game)", J.page, async () => { await hidden(J.page, true); await sleep(6000); await hidden(J.page, false); });
  await check("host 'online' event (in game)", H.page, () => H.page.evaluate(() => window.dispatchEvent(new Event("online"))));
  console.log("        rosters:", JSON.stringify(await names()));
  ok(!H.errors.length && !J.errors.length, "no console/page errors on either page", [...H.errors, ...J.errors].join(" | "));
  await H.context.close(); await J.context.close();
}

// ---------------------------------------------------------------- Nyheter + Förslagslåda
// Without --relay: /forslag is stubbed (404 = the relay before the endpoint was deployed, then 200).
// With --relay ws://127.0.0.1:8787 (wrangler dev --local, ADMIN_KEY from relay/.dev.vars): end to end.
if (want("forslag")) {
  const local = /^ws:\/\/(127\.0\.0\.1|localhost)/.test(args.relay || "");
  console.log("forslag" + (local ? ` (local relay ${args.relay})` : " (stubbed endpoint)"));
  let stub = 404;
  const { context, page, errors } = await newPage({ w: 1366, h: 768 });
  if (!local) await context.route(/\/forslag(\?|$)/, (route) => route.fulfill(stub === 200
    ? { status: 200, headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: '{"ok":true}' }
    : { status: 404, headers: { "access-control-allow-origin": "*" }, body: "livboj relay ok" }));
  await openMenu(page);
  const news = await page.evaluate(() => [...document.querySelectorAll("#news li")].map((li) => li.textContent));
  ok(news.length === 5 && /^18\/11/.test(news[0]), "Nyheter: the latest five from nyheter.json, dated d/m", news[0] && news[0].slice(0, 40));
  await page.fill("#name", "Fia");
  await page.click("#forslag summary");
  ok(await page.evaluate(() => document.getElementById("forslagSend").disabled), "Skicka disabled while the box is empty");
  await page.click("#forslagText");
  await page.keyboard.type("Fler nivåer med mmm och fff! ");
  await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowRight");
  const typed = await page.evaluate(() => ({ v: document.getElementById("forslagText").value, fs: !!document.fullscreenElement, count: document.getElementById("forslagCount").textContent, dis: document.getElementById("forslagSend").disabled }));
  ok(typed.v === "Fler nivåer med mmm och fff! " && !typed.fs, "typing F, M, space and arrows in the box: plain text, no shortcuts", JSON.stringify(typed.v));
  ok(typed.count === "29 / 500" && !typed.dis, "counter counts, Skicka enabled", typed.count);
  ok(await page.evaluate(() => document.getElementById("forslagText").maxLength === 500), "the box takes at most 500 characters");
  const text = `Smoke-förslag ${Date.now()}`;
  await page.fill("#forslagText", text);
  if (!local) {
    await page.click("#forslagSend");
    await page.waitForFunction(() => /Texten finns kvar/.test(document.getElementById("forslagStatus").textContent), null, { timeout: 10000 }).catch(() => {});
    const st = await page.evaluate(() => ({ s: document.getElementById("forslagStatus").textContent, v: document.getElementById("forslagText").value, b: document.getElementById("forslagSend").textContent, d: document.getElementById("forslagSend").disabled }));
    ok(/Det gick inte att skicka/.test(st.s) && st.v === text, "relay without the endpoint (404): failure message, the text is kept", st.s);
    ok(st.d && /\(\d+ s\)/.test(st.b), "…and Skicka waits ~20 s before the next send", st.b);
    stub = 200;
    await openMenu(page); await page.click("#forslag summary"); await page.fill("#forslagText", text);
  }
  await page.click("#forslagSend");
  await page.waitForFunction(() => /Tack|Det gick inte|Vänta/.test(document.getElementById("forslagStatus").textContent), null, { timeout: 10000 }).catch(() => {});
  const done = await page.evaluate(() => ({ s: document.getElementById("forslagStatus").textContent, v: document.getElementById("forslagText").value, d: document.getElementById("forslagSend").disabled }));
  ok(done.s === "Tack! Förslaget är skickat." && done.v === "" && done.d, "a real click sends it: thanks, box cleared, Skicka locked for a while", done.s);
  if (local) {
    const http = args.relay.replace(/^ws/, "http").replace(/\/$/, "");
    const key = (await import("node:fs")).readFileSync(new URL("../relay/.dev.vars", import.meta.url), "utf8").match(/ADMIN_KEY=(\S+)/)[1];
    const get = (q) => fetch(`${http}/forslag${q}`);
    const r1 = await get(`?key=${encodeURIComponent(key)}`); const items = (await r1.json()).items || [];
    ok(r1.status === 200 && items[0] && items[0].text === text && items[0].name === "Fia" && items[0].id && items[0].ts, "read back with the key: newest first, with name, id and ts", JSON.stringify(items[0]));
    ok((await get("")).status === 403 && (await get("?key=wrong")).status === 403, "GET without / with a wrong key: 403");
    const post = (body, ip) => fetch(`${http}/forslag`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: typeof body === "string" ? body : JSON.stringify(body) });
    ok((await post({ text: "   " }, "10.0.0.1")).status === 400, "empty (whitespace) text: 400");
    ok((await post({ text: "x".repeat(501) }, "10.0.0.2")).status === 400, "501 characters: 400");
    ok((await post("{\"text\":\"" + "y".repeat(5000) + "\"}", "10.0.0.3")).status === 413, "a body over 4 KB: 413");
    const okPost = await post({ text: "ok\u0007 med\tkontroll\ntecken", name: "Bo\u0000b" + "z".repeat(30) }, "10.0.0.4");
    ok(okPost.status === 200 && (await okPost.json()).ok === true, "a valid post from another IP: { ok: true }");
    ok((await post({ text: "igen" }, "10.0.0.4")).status === 429, "the same IP again within 10 s: 429");
    const last = ((await (await get(`?key=${encodeURIComponent(key)}`)).json()).items || [])[0];
    ok(last && last.text === "ok med kontroll\ntecken" && last.name === ("Bob" + "z".repeat(30)).slice(0, 14), "control characters stripped, name capped at 14", JSON.stringify(last));
    const pre = await fetch(`${http}/forslag`, { method: "OPTIONS", headers: { origin: "http://example.test", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
    ok(pre.status === 204 && /content-type/.test(pre.headers.get("access-control-allow-headers") || ""), "CORS preflight for a JSON POST passes");
    const del = await fetch(`${http}/forslag?key=${encodeURIComponent(key)}&id=${encodeURIComponent(items[0].id)}`, { method: "DELETE" });
    ok(del.status === 200 && (await fetch(`${http}/forslag?key=wrong`, { method: "DELETE" })).status === 403, "DELETE one by id with the key; without it 403");
    const b = await fetch(`${http}/board`); const bj = await b.json();
    ok(b.status === 200 && Array.isArray(bj.entries), "the local relay's /board still answers", `entries ${bj.entries && bj.entries.length}`);
  }
  ok(!errors.filter((e) => !/404|Failed to load resource/.test(e)).length, "no console/page errors (besides the stubbed 404)", errors.join(" | "));
  await context.close();
}

function fakeBoard(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `fake-${i}`, score: 500 - i * 20, level: 3, n: 3, ts: Date.now() - i * 3600e3, team: `Lag ${i + 1}`,
    players: [{ name: "Anna", score: 200, rescues: 10 }, { name: "Bo", score: 150, rescues: 8 }, { name: "Cecilia", score: 100, rescues: 5 }] }));
}

await browser.close(); await server.close();
console.log(`\n${fails ? "FAIL" : "PASS"}: ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);

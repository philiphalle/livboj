#!/usr/bin/env node
// Automated smoke test (headless Chromium, the folder served locally).
//
//   node tools/smoke.mjs                 # everything except the live-relay test
//   node tools/smoke.mjs --live          # also host + join through the live relay (random room code)
//   node tools/smoke.mjs --only layout,fullscreen,water,hud,keys,board,cache,menu,forslag,live
//   node tools/smoke.mjs --relay ws://localhost:8787 --only live    # against `wrangler dev --local`
//
// Checks: no console errors / page errors; layout at the standard sizes (canvas
// 3:2, inside the viewport, >= 90 % of the limiting side, backing store caps,
// "Vrid mobilen" in portrait, the fullscreen button clear of the HUD); a swimmer
// or monster under a HUD piece turns that piece see-through (and back); the menu
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
        brand: vis(document.getElementById("brand")), hint: !!document.querySelector(".hint") && getComputedStyle(document.querySelector(".hint")).display !== "none",
        mute: window.livboj.debug().muteBtn, dash: window.livboj.debug().dashBtn };
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
      // in logical 900x600 coords: clear of the mute hit area (r + 8) and the dash button — both laid out
      // per canvas size by hud.js, read from debug() — the HUD rows along the top (y < 64), the host's quit button area
      const k = 900 / r.w, L = { x: (m.fs.x - r.x) * k, y: (m.fs.y - r.y) * k, w: m.fs.w * k, h: m.fs.h * k };
      const circleHit = (cx, cy, rr) => { const nx = Math.max(L.x, Math.min(cx, L.x + L.w)), ny = Math.max(L.y, Math.min(cy, L.y + L.h)); return Math.hypot(nx - cx, ny - cy) < rr; };
      const inside = L.x >= 0 && L.y >= 0 && L.x + L.w <= 900.5 && L.y + L.h <= 600.5;
      const outside = (L.y >= 600 || L.x >= 900 || L.x + L.w <= 0 || L.y + L.h <= 0) && m.fs.x >= 0 && m.fs.y >= 0 && m.fs.x + m.fs.w <= m.vw && m.fs.y + m.fs.h <= m.vh;
      ok(outside || inside && !circleHit(m.mute.x, m.mute.y, m.mute.r + 8) && !circleHit(m.dash.x, m.dash.y, m.dash.r) && L.y > 64 && !(L.x < 882 && L.x + L.w > 768 && L.y < 68 && L.y + L.h > 44),
        `${tag}: fullscreen button clear of HUD/mute/dash/quit (or outside the canvas, on screen)`, `logical box ${L.x.toFixed(0)},${L.y.toFixed(0)} ${L.w.toFixed(0)}x${L.h.toFixed(0)}; mute ${m.mute.x.toFixed(0)},${m.mute.y.toFixed(0)} r${m.mute.r.toFixed(0)}`);
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

// ---------------------------------------------------------------- water layer
// The GPU water is a second canvas under the game canvas (water.js). Both must
// cover exactly the same box at every size and in fullscreen; ?water=2d and a
// lost WebGL context must leave the game running on the 2D water, no errors.
if (want("water")) {
  console.log("water");
  const boxes = (page) => page.evaluate(() => {
    const g = document.getElementById("game"), w = document.querySelector("#stage canvas.water");
    const b = (el) => { const r = el.getBoundingClientRect(), cs = getComputedStyle(el); return { x: r.x, y: r.y, w: r.width, h: r.height, rad: cs.borderTopLeftRadius, shadow: cs.boxShadow, disp: cs.display }; };
    return { g: b(g), w: w ? b(w) : null, nWater: document.querySelectorAll("canvas.water").length, gBg: getComputedStyle(g).backgroundColor, info: window.livboj.water() };
  });
  const same = (a, b) => !!a && !!b && ["x", "y", "w", "h"].every((k) => Math.abs(a[k] - b[k]) < 0.01) && a.rad === b.rad;
  for (const s of [{ w: 1920, h: 1080, dsf: 2 }, { w: 844, h: 390, dsf: 3, touch: true }, { w: 390, h: 844, dsf: 3, touch: true }]) {
    for (const q of ["", "water=2d"]) {
      const tag = `${s.w}x${s.h}${s.touch ? " touch" : ""} ${q || "default"}`;
      const { context, page, errors } = await newPage(s);
      await openMenu(page, q); await startSolo(page); await waitPlay(page); await sleep(800);
      const m = await boxes(page);
      if (q) ok(m.info.mode === "2d" && (!m.w || m.w.disp === "none"), `${tag}: 2D water, no GPU layer shown`, JSON.stringify(m.info));
      else {
        ok(m.nWater <= 1, `${tag}: at most one water canvas`);
        if (m.info.mode === "gl") {
          ok(same(m.g, m.w), `${tag}: water canvas and game canvas overlap exactly`, `${JSON.stringify(m.g)} vs ${JSON.stringify(m.w)}`);
          ok(m.gBg === "rgba(0, 0, 0, 0)" && m.g.shadow === "none" && m.w.shadow !== "none", `${tag}: game canvas transparent, the shadow is drawn once (by the layer)`, `${m.gBg} / ${m.g.shadow}`);
        } else ok(true, `${tag}: no WebGL here, 2D water`, JSON.stringify(m.info));
      }
      const frames = await page.evaluate(() => new Promise((r) => { let n = 0; const f = () => (++n < 20 ? requestAnimationFrame(f) : r(n)); requestAnimationFrame(f); }));
      ok(frames === 20 && (await page.evaluate(() => window.livboj.debug().phase)) === "play", `${tag}: game runs`);
      ok(!errors.length, `${tag}: no console/page errors`, errors.join(" | "));
      await context.close();
    }
  }
  { // fullscreen + a lost WebGL context mid-game + the quality ladder
    const { context, page, errors } = await newPage({ w: 1366, h: 768 });
    await openMenu(page, "water=gl"); await startSolo(page); await waitPlay(page); await sleep(500);
    await page.click("#fsBtn");
    await page.waitForFunction(() => document.documentElement.classList.contains("is-fs"), null, { timeout: 3000 }).catch(() => {});
    await sleep(300);
    let m = await boxes(page);
    ok(m.info.mode === "gl" && same(m.g, m.w) && m.w.rad === "0px" && m.w.shadow === "none", "fullscreen: water canvas and game canvas overlap exactly, square corners, no shadow", `${JSON.stringify(m.g)} vs ${JSON.stringify(m.w)}`);
    await page.keyboard.press("f"); await sleep(300);
    m = await boxes(page);
    ok(same(m.g, m.w), "after leaving fullscreen: still the same box", `${JSON.stringify(m.g)} vs ${JSON.stringify(m.w)}`);
    // share of opaque pixels on the game canvas over the water (a 12x8 grid above the beach; sprites cover a few)
    const opaque = () => page.evaluate(() => { const c = document.getElementById("game"), x = c.getContext("2d"); let n = 0, k = 0;
      for (let i = 0; i < 12; i++) for (let j = 0; j < 8; j++) { k++; if (x.getImageData(Math.round(c.width * (i + 0.5) / 12), Math.round(c.height * (0.15 + 0.6 * (j + 0.5) / 8)), 1, 1).data[3] === 255) n++; } return n / k; });
    let op = await opaque();
    ok(op < 0.3, "GPU water: the game canvas is see-through over the water", `${(op * 100).toFixed(0)}% opaque`);
    await page.evaluate(() => document.querySelector("canvas.water").getContext("webgl").getExtension("WEBGL_lose_context").loseContext());
    await sleep(600);
    m = await boxes(page);
    ok(m.info.mode === "2d" && m.w.disp === "none" && m.gBg !== "rgba(0, 0, 0, 0)", "context lost while visible: 2D water, layer hidden, canvas opaque again", JSON.stringify(m.info));
    op = await opaque();
    ok(op === 1, "after the loss the 2D canvas paints the water", `${(op * 100).toFixed(0)}% opaque`);
    ok((await page.evaluate(() => window.livboj.debug().phase)) === "play", "the game keeps running after the loss");
    ok(!errors.length, "no console/page errors (fullscreen, context loss)", errors.join(" | "));
    await context.close();
  }
  { // quality ladder: steps down only, ends in 2D, is remembered
    const { context, page, errors } = await newPage({ w: 1366, h: 768 });
    await openMenu(page); await startSolo(page); await waitPlay(page);
    const start = await page.evaluate(() => window.livboj.water());
    if (start.mode === "gl") {
      const steps = [];
      for (let i = 0; i < 3; i++) { await page.evaluate(() => window.livboj._waterStepDown()); await sleep(250); steps.push(await page.evaluate(() => { const w = window.livboj.water(); return `${w.level}:${w.mode}:${w.size.join("x")}`; })); }
      ok(/^1:gl/.test(steps[0]) && /^2:gl/.test(steps[1]) && /^3:2d/.test(steps[2]), "ladder: lower resolution -> cheaper shader -> 2D", steps.join("  "));
      await openMenu(page); await startSolo(page); await waitPlay(page);
      ok((await page.evaluate(() => window.livboj.water().mode)) === "2d", "ladder: the step down is remembered on the next load");
      await openMenu(page, "water=gl"); await startSolo(page); await waitPlay(page);
      ok((await page.evaluate(() => window.livboj.water().mode)) === "gl", "?water=gl overrides the remembered level");
    } else ok(true, "ladder: no WebGL here (skipped)");
    ok(!errors.length, "no console/page errors (ladder)", errors.join(" | "));
    await context.close();
  }
}

// ---------------------------------------------------------------- the HUD never hides what is in the water
// A phone (the HUD at its largest), GPU water. game.js is served with one added line that exposes the sim
// (window.__S) so the test can hold a swimmer / a monster exactly under a HUD piece. Each piece with
// something under it must turn see-through (hud.js: debug().hud[id].see -> 1, the glass's own pixels thin
// out), the swimmer's sink gauge must be drawn again above the HUD, and all of it must go back when the
// water under the HUD is clear again. Same for the DOM fullscreen button (its opacity).
if (want("hud")) {
  console.log("hud");
  const fs = await import("node:fs"), path = await import("node:path");
  const { ROOT } = await import("./harness.mjs");
  const gsrc = fs.readFileSync(path.join(ROOT, "game.js"), "utf8"), hook = 'S.phase = mode === "solo" ? Phase.INTRO : Phase.LOBBY;';
  ok(gsrc.includes(hook), "game.js still has the line the test hooks into");
  server.overrides.set("/game.js", gsrc.replace(hook, hook + " window.__S = S;"));
  const { context, page, errors } = await newPage({ w: 844, h: 390, dsf: 2, touch: true });
  await openMenu(page, "water=gl");
  await startSolo(page);
  await page.evaluate(() => { // a touch, so the Spurt button shows (it is only drawn for touch play)
    const c = document.getElementById("game"), r = c.getBoundingClientRect(), t = new Touch({ identifier: 1, target: c, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
    c.dispatchEvent(new TouchEvent("touchstart", { touches: [t], changedTouches: [t], bubbles: true, cancelable: true }));
    c.dispatchEvent(new TouchEvent("touchend", { touches: [], changedTouches: [t], bubbles: true, cancelable: true }));
    window.livboj._jump(5);
  });
  await waitPlay(page);
  // hold the water's contents: `place` is a list of [kind, pieceId, fx, fy] (a point in that HUD piece's rect)
  await page.evaluate(() => {
    const S = window.__S;
    window.__place = []; window.__held = { sw: [], mo: [] };
    window.__setPlace = (list) => {
      const d = window.livboj.debug(), f = d.fit, sw = [], mo = [];
      for (const [kind, id, fx, fy] of list) {
        const q = d.hud[id], x = ((q.x + q.w * fx) - f.ox) / f.s, y = ((q.y + q.h * fy) - f.oy) / f.s;
        if (kind === "s") sw.push({ id: 9000 + sw.length, x, y, r: 16, vx: 0, vy: 0, life: 6, maxLife: 10, bob: 0, sk: 0, hr: 0 });
        else mo.push({ id: 9100 + mo.length, x, y: y + 22, vx: 0, vy: 0, r: 30, wob: 0, dir: 0 });
      }
      window.__held = { sw, mo, xy: [...sw, ...mo].map((o) => [o.x, o.y]) };
    };
    const hold = () => { // every frame: only what the test placed, where it placed it (nothing sinks, nothing swims off)
      const h = window.__held, all = [...h.sw, ...h.mo];
      all.forEach((o, i) => { o.x = h.xy[i][0]; o.y = h.xy[i][1]; o.vx = o.vy = 0; if (o.life != null) o.life = 6; });
      S.swimmers.length = 0; S.swimmers.push(...h.sw); S.monsters.length = 0; S.monsters.push(...h.mo);
      requestAnimationFrame(hold);
    };
    hold();
  });
  const hudNow = () => page.evaluate(() => window.livboj.debug().hud);
  // the glass's own pixels: alpha of the 2D canvas at a point of a piece with no text or sprite (GPU water: transparent elsewhere)
  const glassAlpha = (id, fx, fy) => page.evaluate(([id, fx, fy]) => {
    const c = document.getElementById("game"), q = window.livboj.debug().hud[id], k = c.width / 900;
    return c.getContext("2d").getImageData(Math.round((q.x + q.w * fx) * k), Math.round((q.y + q.h * fy) * k), 1, 1).data[3];
  }, [id, fx, fy]);
  await sleep(900);
  let h = await hudNow();
  const ids = ["level", "goal", "score", "quit", "dash", "mute"];
  ok(ids.every((k) => h[k] && h[k].see < 0.05), "nothing under the HUD: every piece solid", ids.map((k) => `${k} ${h[k] && h[k].see}`).join(", "));
  const solidA = await glassAlpha("score", 0.93, 0.5);
  ok(solidA > 150, "…the score panel's glass is opaque-ish", `alpha ${solidA}`);
  // a swimmer under the score panel (left part), a monster under the centre panel, a swimmer under Spurt
  await page.evaluate(() => window.__setPlace([["s", "score", 0.3, 0.6], ["m", "goal", 0.35, 0.9], ["s", "dash", 0.5, 0.5]]));
  await sleep(700);
  h = await hudNow();
  ok(h.score.see > 0.85 && h.score.hit, "a swimmer under the score panel: it turns see-through", `see ${h.score.see}`);
  ok(h.goal.see > 0.85, "a monster under the centre panel: it turns see-through", `see ${h.goal.see}`);
  ok(h.dash.see > 0.85, "a swimmer under the Spurt button: it turns see-through", `see ${h.dash.see}`);
  ok(h.level.see < 0.05 && h.mute.see < 0.05, "…the pieces with nothing under them stay solid", `level ${h.level.see}, mute ${h.mute.see}`);
  ok(h._gauges === 2, "…both swimmers' sink gauges are drawn again above the HUD", `gauges ${h._gauges}`);
  const seeA = await glassAlpha("score", 0.93, 0.5);
  ok(seeA < solidA * 0.45, "…and the panel's glass really is thin now (canvas pixels)", `alpha ${solidA} -> ${seeA}`);
  // under the quit button and the fullscreen button (DOM: its opacity)
  await page.evaluate(() => window.__setPlace([["s", "quit", 0.5, 0.5], ["s", "fs", 0.5, 0.4]]));
  await sleep(700);
  h = await hudNow();
  const fsOp = await page.evaluate(() => getComputedStyle(document.getElementById("fsBtn")).opacity);
  ok(h.quit.see > 0.85 && h.score.see < 0.6, "a swimmer under 'Avsluta spelet': it turns see-through, the score panel comes back", `quit ${h.quit.see}, score ${h.score.see}`);
  ok(h.fs && h.fs.see > 0.85 && +fsOp < 0.6, "a swimmer under the fullscreen button: the DOM button fades too", `see ${h.fs && h.fs.see}, opacity ${fsOp}`);
  // clear water: everything comes back
  await page.evaluate(() => window.__setPlace([]));
  await sleep(1500);
  h = await hudNow();
  const fsOp2 = await page.evaluate(() => getComputedStyle(document.getElementById("fsBtn")).opacity);
  ok(ids.every((k) => h[k].see < 0.05) && +fsOp2 > 0.99 && h._gauges === 0, "water clear again: every piece back to solid", ids.map((k) => `${k} ${h[k].see}`).join(", ") + `, fs opacity ${fsOp2}`);
  const tap = await page.evaluate(() => { const b = window.livboj.debug().dashBtn; return b.r > 40; });
  ok(tap, "the Spurt button keeps its thumb size (hit area unchanged)");
  ok(!errors.length, "no console/page errors", errors.join(" | "));
  await context.close();
  server.overrides.delete("/game.js");
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
  // host change: the host disappears mid-level, the joiner takes over — with the monsters still there
  await H.page.evaluate(() => window.livboj._jump(5)); // level 6: three monsters
  await J.page.waitForFunction(() => { const d = window.livboj.debug(); return d.phase === "play" && d.monsters === 3; }, null, { timeout: 10000 });
  await H.context.close();
  let took = true; try { await J.page.waitForFunction(() => window.livboj.debug().authoritative, null, { timeout: 20000 }); } catch { took = false; }
  ok(took, "host gone: the joiner takes over as host");
  const m1 = await J.page.evaluate(() => window.livboj.debug()); await sleep(2000); const m2 = await J.page.evaluate(() => window.livboj.debug());
  ok(m1.monsters === 3 && m2.monsters === 3, "…and the monsters are still in the water", `monsters ${m1.monsters} then ${m2.monsters}`);
  ok(JSON.stringify(m1.mon.map((m) => m.slice(0, 2))) !== JSON.stringify(m2.mon.map((m) => m.slice(0, 2))) && m2.mon.every((m) => Number.isFinite(m[0]) && Number.isFinite(m[1])), "…and they keep swimming under the new host", JSON.stringify(m2.mon.map((m) => m.slice(0, 2))));
  ok(m2.phase === "play" && !J.errors.length, "…the level goes on, no errors", `phase ${m2.phase} ${J.errors.join(" | ")}`);
  await J.context.close();
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

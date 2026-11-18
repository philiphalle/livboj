#!/usr/bin/env node
// Automated smoke test (headless Chromium, the folder served locally).
//
//   node tools/smoke.mjs                 # everything except the live-relay test
//   node tools/smoke.mjs --live          # also host + join through the live relay (random room code)
//   node tools/smoke.mjs --only layout,fullscreen,water,hud,buttons,keys,board,cache,menu,forslag,live,team
//   node tools/smoke.mjs --relay ws://localhost:8787 --only live    # against `wrangler dev --local`
//   node tools/smoke.mjs --only team --shots /tmp/team              # + screenshots of the team-name screens
//
// Checks: no console errors / page errors; layout at the standard sizes (canvas
// 2:1, inside the viewport, >= 90 % of the limiting side, backing store caps,
// the water layer on the same box, "Vrid mobilen" in portrait, the fullscreen
// button clear of the HUD, the "F helskärm" chip on desktops only); real clicks
// and taps on every on-canvas button and the fullscreen button; a swimmer
// or monster under a HUD piece turns that piece see-through (and back); the menu
// usable and scrollable on phones; fullscreen by a real click and by F (not
// while typing); blur releases held keys; the leaderboard outbox (a failed post
// is queued and flushed exactly once on the next load, a 4xx is dropped);
// cache busting (the build id covers every module, each module loads once under
// ?v=<build>, a change to sim.js alone is noticed and a reload runs it); and
// with --live, that a forced reconnect neither drops nor duplicates a player
// and never starts a host election; also with --live, the team name (host's lobby
// field -> every joiner's lobby / level / end screens -> the leaderboard result, a
// promoted host keeps it, mixed old/new builds). The rules themselves: tools/sim-test.mjs.
//
// The leaderboard is ALWAYS stubbed (harness.mjs stubBoard): no test posts to the real board.
import { serve, launch, stubBoard } from "./harness.mjs";

const args = {}; const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith("--")) { const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true"; args[a.slice(2)] = v; } }
const ONLY = args.only ? new Set(args.only.split(",")) : null;
const LIVE = new Set(["live", "team"]); // these go through the relay: only with --live (or --only)
const want = (k) => (ONLY ? ONLY.has(k) : !LIVE.has(k) || args.live === "true");
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
    { w: 1920, h: 1080, dsf: 2 }, { w: 1920, h: 950, dsf: 1 }, { w: 2560, h: 1440, dsf: 2 }, { w: 1366, h: 768, dsf: 1 },
    { w: 1024, h: 768, dsf: 2, touch: true }, // iPad
    { w: 844, h: 390, dsf: 3, touch: true }, { w: 932, h: 430, dsf: 3, touch: true }, { w: 390, h: 844, dsf: 3, touch: true },
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
      const rc = document.getElementById("rotateCard"), wl = document.querySelector("#stage canvas.water"), wr = wl && wl.getBoundingClientRect();
      const vis = (el) => !!el && !el.hidden && getComputedStyle(el).display !== "none";
      const hint = document.getElementById("fsHint"), hr = hint && hint.getBoundingClientRect();
      return { r: { x: r.x, y: r.y, w: r.width, h: r.height }, backW: c.width, backH: c.height, vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio,
        water: wl && vis(wl) ? { x: wr.x, y: wr.y, w: wr.width, h: wr.height } : null, quit: window.livboj.debug().quitBtn,
        fsHint: hint && hint.classList.contains("on") ? { x: hr.x, y: hr.y, w: hr.width, h: hr.height } : null,
        shore: (() => { const f = window.livboj.debug().fit; return f.oy + 460 * f.s; })(), // the waterline of the solo world (1040x520, beach 60), logical px
        fs: vis(f) ? { x: fr.x, y: fr.y, w: fr.width, h: fr.height } : null, rotate: vis(rc), coarse: matchMedia("(pointer: coarse)").matches,
        brand: vis(document.getElementById("brand")), hint: !!document.querySelector(".hint") && getComputedStyle(document.querySelector(".hint")).display !== "none",
        mute: window.livboj.debug().muteBtn, dash: window.livboj.debug().dashBtn };
    });
    const { r } = m;
    ok(Math.abs(r.w / r.h - 2) < 0.01, `${tag}: canvas is 2:1`, `${r.w.toFixed(0)}x${r.h.toFixed(0)}`);
    ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= m.vw + 0.5 && r.y + r.h <= m.vh + 0.5, `${tag}: canvas inside the viewport`);
    const use = Math.max(r.w / m.vw, r.h / m.vh);
    ok(use >= 0.9, `${tag}: canvas uses >= 90% of the limiting side`, `${(use * 100).toFixed(1)}%`);
    const cap = m.coarse ? 1.5 : 2, expectW = Math.round(r.w * Math.min(m.dpr, cap, 2960 / r.w));
    ok(m.backW <= 2960 && m.backW / r.w <= cap + 0.01 && Math.abs(m.backW - expectW) <= 1 && Math.abs(m.backW - 2 * m.backH) <= 1, `${tag}: backing store 2:1, capped`, `backing ${m.backW}x${m.backH}, ratio ${(m.backW / r.w).toFixed(2)} (dpr ${m.dpr}, cap ${cap}, max 2960 wide)`);
    if (m.water) ok(["x", "y", "w", "h"].every((k) => Math.abs(m.water[k] - r[k]) < 0.01), `${tag}: the water layer covers exactly the game canvas`, JSON.stringify(m.water));
    else ok(true, `${tag}: (2D water here: one canvas)`);
    // the "F helskärm" chip: a desktop that is not fullscreen gets it when the game starts, a touch device never
    if (s.touch) ok(!m.fsHint, `${tag}: no "F helskärm" chip on a touch device`);
    else if (ok(!!m.fsHint, `${tag}: "F helskärm" chip shown on a desktop`)) {
      const k = 1200 / r.w, H = { x: (m.fsHint.x - r.x) * k, y: (m.fsHint.y - r.y) * k, w: m.fsHint.w * k, h: m.fsHint.h * k };
      const fsR = m.fs ? (m.fs.x - r.x + m.fs.w) * k : 0;
      ok(H.x >= fsR && H.y + H.h <= 600 && H.y >= m.shore && H.x + H.w < 600 && !(H.x < m.dash.x + m.dash.r && H.x + H.w > m.dash.x - m.dash.r && H.y + H.h > m.dash.y - m.dash.r),
        `${tag}: …beside the fullscreen button, on the beach row (below the waterline), clear of the HUD`, `logical ${H.x.toFixed(0)},${H.y.toFixed(0)} ${H.w.toFixed(0)}x${H.h.toFixed(0)}`);
    }
    ok(!m.brand && !m.hint, `${tag}: brand header and hint hidden while playing`);
    ok(m.rotate === !!(s.touch && s.h > s.w), `${tag}: rotate card ${s.h > s.w && s.touch ? "shown" : "not shown"}`);
    if (ok(!!m.fs, `${tag}: fullscreen button shown`)) {
      // in logical 1200x600 coords: clear of the mute hit area (r + 8) and the dash button — both laid out
      // per canvas size by hud.js, read from debug() — the HUD rows along the top (y < 64), the host's quit button
      const k = 1200 / r.w, L = { x: (m.fs.x - r.x) * k, y: (m.fs.y - r.y) * k, w: m.fs.w * k, h: m.fs.h * k }, q = m.quit;
      const circleHit = (cx, cy, rr) => { const nx = Math.max(L.x, Math.min(cx, L.x + L.w)), ny = Math.max(L.y, Math.min(cy, L.y + L.h)); return Math.hypot(nx - cx, ny - cy) < rr; };
      const inside = L.x >= 0 && L.y >= 0 && L.x + L.w <= 1200.5 && L.y + L.h <= 600.5;
      const outside = (L.y >= 600 || L.x >= 1200 || L.x + L.w <= 0 || L.y + L.h <= 0) && m.fs.x >= 0 && m.fs.y >= 0 && m.fs.x + m.fs.w <= m.vw && m.fs.y + m.fs.h <= m.vh;
      ok(outside || inside && !circleHit(m.mute.x, m.mute.y, m.mute.r + 8) && !circleHit(m.dash.x, m.dash.y, m.dash.r) && L.y > 64 && !(L.x < q.x + q.w && L.x + L.w > q.x && L.y < q.y + q.h && L.y + L.h > q.y),
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
    ok(Math.abs(after.bw - Math.round(after.cw * Math.min(s.dsf, s.touch ? 1.5 : 2, 2960 / after.cw))) <= 1, `${tag}: backing follows a resize`, `css ${after.cw} -> backing ${after.bw}`);
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
  const { context, page, errors } = await newPage({ w: 1920, h: 1080 });
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
  ok(Math.abs(inFs.w / inFs.h - 2) < 0.01 && Math.max(inFs.w / inFs.vw, inFs.h / inFs.vh) >= 0.9, "in fullscreen the canvas is 2:1 and fills the screen", `${inFs.w}x${inFs.h} in ${inFs.vw}x${inFs.vh}`);
  // 16:9: a band above and below the 2:1 field — the page's sea, the field centred, nothing pushed off screen
  const band = await page.evaluate(() => {
    const r = document.getElementById("game").getBoundingClientRect(), b = document.getElementById("fsBtn").getBoundingClientRect(), sea = getComputedStyle(document.querySelector(".sea"));
    const seaAfter = getComputedStyle(document.querySelector(".sea"), "::before").display;
    return { top: r.top, bottom: innerHeight - r.bottom, vh: innerHeight, vw: innerWidth, sea: sea.backgroundImage, swell: seaAfter, fs: [b.left, b.top, b.right, b.bottom] };
  });
  ok(band.top > 20 && Math.abs(band.top - band.bottom) <= 1, "…16:9 screen: the field is centred, the same band above and below", `top ${band.top.toFixed(1)}, bottom ${band.bottom.toFixed(1)}`);
  ok(/gradient/.test(band.sea) && band.swell !== "none", "…the bands show the page's sea backdrop (gradient and swell), not a flat black", band.sea.slice(0, 40));
  ok(band.fs[0] >= 0 && band.fs[1] >= 0 && band.fs[2] <= band.vw && band.fs[3] <= band.vh, "…the fullscreen button stays on screen", JSON.stringify(band.fs));
  await page.click("#fsBtn");
  await page.waitForFunction(() => !document.fullscreenElement, null, { timeout: 3000 }).catch(() => {});
  ok(await page.evaluate(() => !document.fullscreenElement), "second click leaves fullscreen");
  await page.keyboard.press("f");
  await page.waitForFunction(() => !!document.fullscreenElement, null, { timeout: 3000 }).catch(() => {});
  ok(await page.evaluate(() => !!document.fullscreenElement), "F enters fullscreen while playing");
  ok(await page.evaluate(() => { const h = document.getElementById("fsHint"); return !h || !h.classList.contains("on"); }), "…and the \"F helskärm\" chip is gone");
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
    ok(m.info.mode === "gl" && same(m.g, m.w) && m.g.shadow === "none" && m.w.shadow !== "none", "fullscreen: water canvas and game canvas overlap exactly (same rounded corners), the shadow drawn once", `${JSON.stringify(m.g)} vs ${JSON.stringify(m.w)}`);
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
      S.spawnTimer = 1e9; // no new swimmer either: one spawned under a piece shows for a frame before this runs (a flaky fade)
      requestAnimationFrame(hold);
    };
    hold();
  });
  const hudNow = () => page.evaluate(() => window.livboj.debug().hud);
  // the glass's own pixels: alpha of the 2D canvas at a point of a piece with no text or sprite (GPU water: transparent elsewhere)
  const glassAlpha = (id, fx, fy) => page.evaluate(([id, fx, fy]) => {
    const c = document.getElementById("game"), q = window.livboj.debug().hud[id], k = c.width / 1200;
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

// ---------------------------------------------------------------- every button by a real click / tap
// The canvas buttons are laid out by hud.js per canvas size (debug() reports them in logical 1200x600
// coords); a real mouse click (desktop) and a real tap (phone) at each must do what it says: mute,
// Spurt (at its right edge, by the canvas's right edge), "Avsluta spelet" (arm, then confirm, also on
// the level board where it sits in the bottom row), the level board's and the end screen's buttons,
// "Till startsidan", and the DOM fullscreen button.
if (want("buttons")) {
  console.log("buttons");
  const fs = await import("node:fs"), path = await import("node:path");
  const { ROOT } = await import("./harness.mjs");
  const gsrc = fs.readFileSync(path.join(ROOT, "game.js"), "utf8"), hook = 'S.phase = mode === "solo" ? Phase.INTRO : Phase.LOBBY;';
  server.overrides.set("/game.js", gsrc.replace(hook, hook + " window.__S = S;"));
  for (const s of [{ w: 1366, h: 768 }, { w: 844, h: 390, dsf: 3, touch: true }]) {
    const tag = `${s.w}x${s.h}${s.touch ? " touch" : ""}`;
    const { context, page, errors } = await newPage(s);
    await openMenu(page); await startSolo(page); await waitPlay(page);
    // logical canvas point -> client point
    const at = (x, y) => page.evaluate(([x, y]) => { const r = document.getElementById("game").getBoundingClientRect(); return { x: r.left + x * r.width / 1200, y: r.top + y * r.height / 600 }; }, [x, y]);
    const press = async (x, y) => { const p = await at(x, y); if (s.touch) await page.touchscreen.tap(p.x, p.y); else await page.mouse.click(p.x, p.y); await sleep(250); return p; };
    const dbg = () => page.evaluate(() => window.livboj.debug());
    const muted = () => page.evaluate(() => localStorage.getItem("livboj-muted"));
    const centre = (b) => [b.x + b.w / 2, b.y + b.h / 2];
    if (s.touch) await press(600, 200); // a first touch: the Spurt button shows for touch play
    let d = await dbg();
    const m0 = await muted();
    await press(d.muteBtn.x, d.muteBtn.y);
    const m1 = await muted();
    await press(d.muteBtn.x, d.muteBtn.y);
    ok(m1 === "1" && (await muted()) === "0" && m0 !== "1", `${tag}: mute (bottom left) toggles the sound, twice back`, `${m0} -> ${m1} -> ${await muted()}`);
    if (s.touch) {
      d = await dbg();
      await page.evaluate(() => { for (const p of window.__S.players.values()) p.dashCooldown = 0; });
      const p = await press(d.dashBtn.x + d.dashBtn.r * 0.92, d.dashBtn.y);
      const r = await page.evaluate(() => { const c = document.getElementById("game").getBoundingClientRect(); return { right: c.right, cd: [...window.__S.players.values()][0].dashCooldown }; });
      ok(r.cd > 0, `${tag}: a tap at the right edge of Spurt dashes`, `tap at x ${p.x.toFixed(0)} (canvas right edge ${r.right.toFixed(0)}, viewport ${s.w}); cooldown ${r.cd.toFixed(2)}`);
    }
    // Avsluta spelet: the first press arms it, the second ends the game
    d = await dbg();
    await press(...centre(d.quitBtn));
    const armed = await dbg();
    await press(...centre(d.quitBtn));
    ok(armed.phase === "play" && (await dbg()).phase === "over", `${tag}: "Avsluta spelet" (top right) arms on the first press, ends on the second`, `${armed.phase} -> ${(await dbg()).phase}`);
    await sleep(400);
    // the end screen: "Spela igen" starts over
    d = await dbg();
    ok(!!d.actionBtn && !!d.leaveBtn, `${tag}: end screen shows "Spela igen" and "Till startsidan"`, JSON.stringify([d.actionBtn, d.leaveBtn]));
    if (d.actionBtn) await press(...centre(d.actionBtn));
    ok(["intro", "play"].includes((await dbg()).phase) && (await dbg()).level === 0, `${tag}: "Spela igen" starts a new game`);
    // the level board: its button, and "Avsluta spelet" in the bottom row
    await page.evaluate(() => { const S = window.__S; S.caught = 8; S.phase = "cleared"; });
    await sleep(600);
    d = await dbg();
    if (d.actionBtn) await press(...centre(d.actionBtn));
    d = await dbg();
    ok(d.phase === "intro" && d.level === 1, `${tag}: the level board's "Starta nästa nivå" goes on to level 2`, `${d.phase} level ${d.level + 1}`);
    await page.evaluate(() => { const S = window.__S; S.caught = 10; S.phase = "cleared"; });
    await sleep(600);
    d = await dbg();
    await press(...centre(d.quitBtn)); await press(...centre(d.quitBtn));
    ok((await dbg()).phase === "over" && d.quitBtn.y > 500, `${tag}: on the level board "Avsluta spelet" sits in the bottom row and works`, `quit at y ${d.quitBtn.y.toFixed(0)}`);
    await sleep(400);
    // Till startsidan
    d = await dbg();
    const nav = page.waitForNavigation({ waitUntil: "load", timeout: 8000 }).then(() => true, () => false);
    if (d.leaveBtn) await press(...centre(d.leaveBtn));
    ok(await nav && await page.evaluate(() => !!document.getElementById("solo") && !document.getElementById("menu").hidden), `${tag}: "Till startsidan" goes back to the menu`);
    // the fullscreen button
    await startSolo(page); await waitPlay(page);
    const fb = await page.evaluate(() => { const b = document.getElementById("fsBtn").getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
    if (s.touch) await page.touchscreen.tap(fb.x, fb.y); else await page.mouse.click(fb.x, fb.y);
    await page.waitForFunction(() => !!document.fullscreenElement, null, { timeout: 3000 }).catch(() => {});
    const fsOn = await page.evaluate(() => !!document.fullscreenElement);
    ok(fsOn, `${tag}: a ${s.touch ? "tap" : "click"} on the fullscreen button (beside mute) enters fullscreen`);
    ok(!errors.length, `${tag}: no console/page errors`, errors.join(" | "));
    await context.close();
  }
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

// ---------------------------------------------------------------- the team's name (live relay, leaderboard stubbed)
// The host types an optional name in its DOM lobby; it reaches the joiners in the host's state (`team`,
// an optional snapshot field), shows under the title of the canvas lobby / level board / end screens
// (hud.js reports what it drew: debug().hud._team, with the card's box _card, canvas coords), is fixed
// from the start of a game, goes into the stubbed leaderboard POST, survives a host change, and old and
// new builds mix without errors (7f25a39 = the build before the field: its game.js, hud.js, host.html).
if (want("team")) {
  console.log("team" + (args.relay ? ` (${args.relay})` : " (production relay; leaderboard stubbed)"));
  const fs = await import("node:fs"), path = await import("node:path"), { execFileSync } = await import("node:child_process");
  const { ROOT } = await import("./harness.mjs");
  const SHOTS = args.shots && args.shots !== "true" ? args.shots : null;
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const shot = async (pg, name) => { if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
  const gsrc = fs.readFileSync(path.join(ROOT, "game.js"), "utf8"), hook = 'S.phase = mode === "solo" ? Phase.INTRO : Phase.LOBBY;';
  ok(gsrc.includes(hook), "game.js still has the line the test hooks into");
  const hooked = gsrc.replace(hook, hook + " window.__S = S;");
  const newRoom = () => Array.from({ length: 5 }, () => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[(Math.random() * 31) | 0]).join("");
  async function hostLobby(H, room, name = "Värden") {
    await H.page.goto(url("host.html", `room=${room}`), { waitUntil: "load" });
    await H.page.waitForFunction(() => !!document.getElementById("create"));
    await H.page.fill("#name", name); await H.page.click("#create");
    await H.page.waitForFunction(() => !!window.livboj);
  }
  async function join(J, room, name) {
    await J.page.goto(url("index.html", `room=${room}`), { waitUntil: "load" });
    await J.page.waitForFunction(() => !!document.getElementById("join"));
    await J.page.fill("#name", name); await J.page.click("#join");
  }
  const seen = (pg) => pg.evaluate(() => { const d = window.livboj.debug(); return { team: d.team, drawn: d.hud._team || null, card: d.hud._card || null, phase: d.phase, auth: d.authoritative }; });
  // the drawn line inside the card, the card inside the canvas
  const fits = (s) => !!s.drawn && !!s.card && s.drawn.x >= s.card.x - 0.5 && s.drawn.x + s.drawn.w <= s.card.x + s.card.w + 0.5 && s.drawn.y >= s.card.y && s.drawn.y + s.drawn.h <= s.card.y + s.card.h
    && s.card.x >= 0 && s.card.y >= 0 && s.card.x + s.card.w <= 1200 && s.card.y + s.card.h <= 600;
  const box = (s) => s.drawn ? `"${s.drawn.text}" at ${s.drawn.x.toFixed(0)},${s.drawn.y.toFixed(0)} ${s.drawn.w.toFixed(0)}x${s.drawn.h.toFixed(0)} in card ${s.card ? `${s.card.x.toFixed(0)},${s.card.y.toFixed(0)} ${s.card.w.toFixed(0)}x${s.card.h.toFixed(0)}` : "-"}` : "no line";
  // wait until a page shows `want` (or no line at all for ""): -> ms, or -1
  async function waitTeam(pg, want, ms = 3000) {
    const t0 = Date.now();
    try {
      await pg.waitForFunction((w) => { const d = window.livboj.debug(); return d.team === w && (w ? !!d.hud._team : !d.hud._team); }, want, { timeout: ms, polling: 50 });
      return Date.now() - t0;
    } catch { return -1; }
  }
  const results = (log) => log.posts.flatMap((b) => (b && Array.isArray(b.entries) ? b.entries : []));
  const setScoreAndQuit = (pg, score) => pg.evaluate((score) => { const S = window.__S; S.score = score; for (const p of S.players.values()) p.score = Math.round(score / S.players.size); window.livboj.quitGame(); }, score);
  const phaseIs = (pg, ph, ms = 10000) => pg.waitForFunction((ph) => [].concat(ph).includes(window.livboj.debug().phase), ph, { timeout: ms }).then(() => true, () => false);

  server.overrides.set("/game.js", hooked);
  const room = newRoom();
  const H = await newPage({ w: 1366, h: 768 }), J = await newPage({ w: 1366, h: 768 }), P = await newPage({ w: 844, h: 390, dsf: 3, touch: true });
  await hostLobby(H, room);
  await join(J, room, "Gästen"); await join(P, room, "Mobilen");
  let all3 = true;
  try {
    await H.page.waitForFunction(() => window.livboj.roster().length === 3, null, { timeout: 20000 });
    for (const X of [J, P]) await X.page.waitForFunction(() => window.livboj.debug().n === 3 && window.livboj.debug().phase === "lobby", null, { timeout: 20000 });
  } catch { all3 = false; }
  ok(all3, `host, a desktop joiner and a phone joiner in one lobby (room ${room})`);
  await sleep(600);
  // no name: no line anywhere, the field empty with an example placeholder from the host's name
  const f0 = await H.page.$eval("#team", (e) => ({ v: e.value, ph: e.placeholder, vis: e.offsetParent !== null, max: e.maxLength }));
  ok(f0.vis && f0.v === "" && f0.ph === "t.ex. Värdens lag" && f0.max === 20, "host's lobby: the team field is there, empty, placeholder built from the host's name", JSON.stringify(f0));
  for (const [X, tag] of [[J, "desktop"], [P, "phone"]]) {
    const s = await seen(X.page);
    ok(s.phase === "lobby" && s.team === "" && !s.drawn && !!s.card, `${tag} joiner, host without a name: the lobby shows no team line`, box(s));
  }
  await shot(H.page, "host-lobby-empty-desktop");
  await shot(J.page, "joiner-lobby-noname-desktop"); await shot(P.page, "joiner-lobby-noname-phone");
  // typed in the lobby: the joiners see it within a couple of seconds; a change too
  for (const name of ["Testlaget", "Andra laget"]) {
    await H.page.fill("#team", name);
    const [tj, tp] = await Promise.all([waitTeam(J.page, name), waitTeam(P.page, name)]);
    ok(tj >= 0 && tp >= 0, `host types "${name}": both joiners show it in their lobby within 3 s`, `desktop ${tj} ms, phone ${tp} ms`);
  }
  ok(await H.page.evaluate(() => localStorage.getItem("livboj-team")) === "Andra laget", "…saved as livboj-team");
  await shot(J.page, "joiner-lobby-name-desktop"); await shot(P.page, "joiner-lobby-name-phone");
  // sanitising on the host: control characters stripped, spaces trimmed (the input caps at 20)
  await H.page.fill("#team", "  Ny\u0007tt ‮lag  "); await H.page.locator("#team").blur();
  const tc = await waitTeam(J.page, "Nytt lag");
  ok(tc >= 0 && (await H.page.$eval("#team", (e) => e.value)) === "Nytt lag", "control/bidi characters and outer spaces are stripped (the field shows the cleaned name after leaving it)", `${tc} ms`);
  // long names: 20 of the widest letter, and one with åäö and an emoji (20 UTF-16 units) — inside the card on both sizes
  for (const name of ["WWWWWWWWWWWWWWWWWWWW", "Wåhlströms Ölgäng 🛟"]) {
    await H.page.fill("#team", name);
    const [tj, tp] = await Promise.all([waitTeam(J.page, name), waitTeam(P.page, name)]);
    const sj = await seen(J.page), sp = await seen(P.page);
    ok(tj >= 0 && tp >= 0 && fits(sj) && fits(sp), `"${name}" (${name.length} chars) in the lobby: inside the card on desktop and phone`, `desktop ${box(sj)}; phone ${box(sp)}`);
    const tag = /^W+$/.test(name) ? "w20" : "emoji";
    await shot(J.page, `joiner-lobby-${tag}-desktop`); await shot(P.page, `joiner-lobby-${tag}-phone`);
  }
  const NAME = "Wåhlströms Ölgäng 🛟";
  await shot(H.page, "host-lobby-filled-desktop");
  { // the host's DOM lobby on a phone: the field fits the card (no horizontal overflow)
    await H.page.setViewportSize({ width: 844, height: 390 }); await sleep(300);
    const m = await H.page.evaluate(() => { const e = document.getElementById("team"), c = document.getElementById("lobby"), r = e.getBoundingClientRect(), cr = c.getBoundingClientRect(); return { l: r.left, r: r.right, cl: cr.left, cr: cr.right, sw: c.scrollWidth, cw: c.clientWidth }; });
    await H.page.evaluate(() => document.getElementById("team").scrollIntoView({ block: "center" }));
    await shot(H.page, "host-lobby-filled-phone-size");
    ok(m.l >= m.cl && m.r <= m.cr && m.sw <= m.cw + 1, "host's lobby at 844x390: the team field fits the card", JSON.stringify(m));
    await H.page.setViewportSize({ width: 1366, height: 768 }); await sleep(300);
  }
  // start: fixed for this game
  await H.page.click("#start");
  ok(await phaseIs(J.page, ["intro", "play"]) && await phaseIs(P.page, ["intro", "play"]), "the game starts for both joiners");
  const fixed = await H.page.evaluate(() => window.livboj.setTeam("Fusk"));
  await sleep(800);
  ok(fixed === NAME && (await seen(J.page)).team === NAME, "after the start the name is fixed (setTeam is refused mid-game)", `setTeam -> ${fixed}`);
  // the level board
  await H.page.evaluate(() => { const S = window.__S; S.caught = 99; S.phase = "cleared"; });
  ok(await phaseIs(J.page, "cleared") && await phaseIs(P.page, "cleared"), "level board on every page");
  await sleep(900);
  for (const [X, tag] of [[H, "host-desktop"], [J, "joiner-desktop"], [P, "joiner-phone"]]) {
    const s = await seen(X.page);
    ok(s.drawn && s.drawn.text === NAME && fits(s), `level board (${tag}): the team name under the title, inside the card`, box(s));
    await shot(X.page, `cleared-${tag}`);
  }
  // game over: every end screen shows it, the stubbed leaderboard POST carries it
  await setScoreAndQuit(H.page, 321);
  ok(await phaseIs(J.page, "over") && await phaseIs(P.page, "over"), "game over on every page");
  await sleep(1500);
  for (const [X, tag] of [[H, "host-desktop"], [J, "joiner-desktop"], [P, "joiner-phone"]]) {
    const s = await seen(X.page);
    ok(s.drawn && s.drawn.text === NAME && fits(s), `game over (${tag}): the team name on the end screen, inside the card`, box(s));
    await shot(X.page, `over-${tag}`);
  }
  let e1 = results(H.log).find((e) => e.score === 321);
  ok(e1 && e1.team === NAME, "the stubbed leaderboard POST has the team's name", e1 ? JSON.stringify({ team: e1.team, score: e1.score, n: e1.n }) : `posts ${H.log.posts.length}`);
  ok(!results(J.log).length && !results(P.log).length, "…and the joiners post nothing");
  // the win screen (phase set directly: screenshots and the line only)
  await H.page.evaluate(() => { window.__S.phase = "win"; });
  ok(await phaseIs(J.page, "win") && await phaseIs(P.page, "win"), "win screen on every page");
  await sleep(1200);
  for (const [X, tag] of [[H, "host-desktop"], [J, "joiner-desktop"], [P, "joiner-phone"]]) {
    const s = await seen(X.page);
    ok(s.drawn && s.drawn.text === NAME && fits(s), `win (${tag}): the team name on the end screen, inside the card`, box(s));
    await shot(X.page, `win-${tag}`);
  }
  // "Till lobbyn" (Enter): the field is editable again; clearing it removes the line and the result has no team, as before
  await H.page.keyboard.press("Enter");
  ok(await phaseIs(J.page, "lobby"), "back in the lobby (Till lobbyn)");
  await sleep(300);
  const f1 = await H.page.$eval("#team", (e) => ({ v: e.value, vis: e.offsetParent !== null, dis: e.disabled || e.readOnly }));
  ok(f1.vis && !f1.dis && f1.v === NAME, "…the host's field shows the name and is editable again", JSON.stringify(f1));
  await H.page.fill("#team", "");
  const [cj, cp] = await Promise.all([waitTeam(J.page, ""), waitTeam(P.page, "")]);
  ok(cj >= 0 && cp >= 0, "host clears the name: the joiners' lobby line goes away", `desktop ${cj} ms, phone ${cp} ms`);
  ok(await H.page.evaluate(() => localStorage.getItem("livboj-team")) === "" && (await H.page.$eval("#team", (e) => e.value)) === "", "…saved empty; the placeholder is only a placeholder (the value stays empty)");
  await H.page.click("#start");
  ok(await phaseIs(J.page, ["intro", "play"]), "a second game starts");
  await sleep(500);
  await H.page.evaluate(() => { window.__S.caught = 99; window.__S.phase = "cleared"; });
  await phaseIs(J.page, "cleared"); await sleep(600);
  const sClr = await seen(J.page);
  ok(!sClr.drawn && !!sClr.card, "no name: the joiner's level board has no team line", box(sClr));
  await setScoreAndQuit(H.page, 123);
  await phaseIs(J.page, "over"); await sleep(1500);
  const sOver = await seen(J.page);
  ok(!sOver.drawn && !!sOver.card, "no name: the end screen has no team line", box(sOver));
  e1 = results(H.log).find((e) => e.score === 123);
  ok(e1 && e1.team === "", "no name: the result's team is empty, as before (the leaderboard shows \"Lag\")", e1 ? JSON.stringify({ team: e1.team, score: e1.score }) : "no post");
  // host change: with a name set the host disappears mid-level; the promoted joiner records the result with the name
  await H.page.keyboard.press("Enter");
  await phaseIs(J.page, "lobby");
  await H.page.fill("#team", "Kvarlaget");
  ok(await waitTeam(J.page, "Kvarlaget") >= 0 && await waitTeam(P.page, "Kvarlaget") >= 0, "a new name for the next game reaches both joiners");
  await H.page.click("#start");
  await phaseIs(J.page, "play"); await phaseIs(P.page, "play");
  await H.context.close();
  let NH = null;
  try { await Promise.race([J, P].map((X) => X.page.waitForFunction(() => window.livboj.debug().authoritative, null, { timeout: 20000 }).then(() => { NH = NH || X; }))); } catch {}
  ok(!!NH, `host gone: a joiner takes over (${NH === J ? "desktop" : NH === P ? "phone" : "none"})`);
  if (NH) {
    const other = NH === J ? P : J;
    await sleep(1500);
    const sn = await seen(NH.page), so = await seen(other.page);
    ok(sn.auth && sn.team === "Kvarlaget" && !so.auth && so.team === "Kvarlaget", "…it keeps the team's name, and its own snapshots carry it to the other joiner", `new host ${sn.team}, other ${so.team}`);
    await setScoreAndQuit(NH.page, 77);
    await phaseIs(NH.page, "over"); await phaseIs(other.page, "over"); await sleep(1500);
    const e2 = results(NH.log).find((e) => e.score === 77);
    ok(e2 && e2.team === "Kvarlaget", "the promoted host's stubbed leaderboard POST carries the team's name", e2 ? JSON.stringify({ team: e2.team, score: e2.score, n: e2.n }) : `posts ${NH.log.posts.length}`);
    const s2 = await seen(other.page);
    ok(s2.drawn && s2.drawn.text === "Kvarlaget", "…and the other joiner's end screen shows it", box(s2));
  }
  ok(!H.errors.length && !J.errors.length && !P.errors.length, "no console/page errors on any page", [...H.errors, ...J.errors, ...P.errors].join(" | "));
  await J.context.close(); await P.context.close();

  // mixed builds: the snapshot is the protocol between builds for ~10 minutes after a deploy
  const old = (f) => execFileSync("git", ["show", `7f25a39:${f}`], { cwd: ROOT, encoding: "utf8" });
  const OLD = { "/game.js": old("game.js"), "/hud.js": old("hud.js"), "/host.html": old("host.html") };
  ok(!/\bteam: team\b|cleanTeam/.test(OLD["/game.js"]), "7f25a39's game.js is the build without the snapshot field");
  { // an old host (named team at its setup screen, never sent) + a new joiner
    server.overrides.clear(); for (const [k, v] of Object.entries(OLD)) server.overrides.set(k, v);
    const r = newRoom(), OH = await newPage({ w: 1366, h: 768 }), NJ = await newPage({ w: 1366, h: 768 });
    await OH.page.goto(url("host.html", `room=${r}`), { waitUntil: "load" });
    await OH.page.waitForFunction(() => !!document.getElementById("create"));
    await OH.page.fill("#name", "Gammal"); await OH.page.fill("#team", "Gamla laget"); await OH.page.click("#create");
    await OH.page.waitForFunction(() => !!window.livboj);
    ok(await OH.page.evaluate(() => typeof window.livboj.setTeam === "undefined"), "old host: the 7f25a39 build is running (no setTeam)");
    server.overrides.clear();
    await join(NJ, r, "Ny gäst");
    const met = await NJ.page.waitForFunction(() => window.livboj.debug().n === 2 && window.livboj.debug().phase === "lobby", null, { timeout: 20000 }).then(() => true, () => false);
    await sleep(800);
    let s = await seen(NJ.page);
    ok(met && s.team === "" && !s.drawn && !!s.card, "old host -> new joiner: the snapshot has no team field; the lobby shows no line, no errors", `${box(s)} ${NJ.errors.join(" | ")}`);
    await OH.page.click("#start");
    ok(await phaseIs(NJ.page, ["intro", "play"]), "…the game starts for the new joiner");
    await sleep(500);
    s = await seen(NJ.page);
    ok(s.team === "" && !NJ.errors.length && !OH.errors.length, "…nothing shown, no errors on either page", [...OH.errors, ...NJ.errors].join(" | "));
    await OH.context.close(); await NJ.context.close();
  }
  { // a new host with a name + an old joiner (it ignores the unknown field)
    server.overrides.clear(); server.overrides.set("/game.js", hooked);
    const r = newRoom(), NHo = await newPage({ w: 1366, h: 768 }), OJ = await newPage({ w: 1366, h: 768 });
    await hostLobby(NHo, r, "Nyvärd");
    await NHo.page.fill("#team", "Nya laget");
    server.overrides.set("/game.js", OLD["/game.js"]); server.overrides.set("/hud.js", OLD["/hud.js"]);
    await join(OJ, r, "Gammal gäst");
    const met = await OJ.page.waitForFunction(() => window.livboj.debug().n === 2, null, { timeout: 20000 }).then(() => true, () => false);
    server.overrides.clear(); server.overrides.set("/game.js", hooked);
    await sleep(1000);
    const d = await OJ.page.evaluate(() => { const d = window.livboj.debug(); return { team: d.team, phase: d.phase, n: d.n, drawn: !!d.hud._team }; });
    ok(met && d.team === undefined && d.phase === "lobby" && !d.drawn, "new host -> old joiner (7f25a39): it joins the lobby; it knows nothing of the name", JSON.stringify(d));
    await NHo.page.click("#start");
    ok(await phaseIs(OJ.page, ["intro", "play"]), "…the game starts for the old joiner");
    await phaseIs(OJ.page, "play");
    await setScoreAndQuit(NHo.page, 55);
    ok(await phaseIs(OJ.page, "over"), "…and it reaches the end screen");
    await sleep(800);
    const e3 = results(NHo.log).find((e) => e.score === 55);
    ok(e3 && e3.team === "Nya laget", "…the new host's result has the name", e3 ? e3.team : "no post");
    ok(!OJ.errors.length && !NHo.errors.length, "…no errors on either page", [...NHo.errors, ...OJ.errors].join(" | "));
    await NHo.context.close(); await OJ.context.close();
  }
  server.overrides.clear();
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

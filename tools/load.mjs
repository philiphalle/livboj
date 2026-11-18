#!/usr/bin/env node
// Load test: N players in one room through a relay, every one of them a bot that plays by itself
// through the real input path (keyboard on the desktop pages, touch on the phone-sized ones).
//
//   node tools/load.mjs                                   # 8 players, 3 minutes, the LIVE relay (spends the shared daily quota!)
//   node tools/load.mjs --relay ws://127.0.0.1:8787       # against `npx wrangler dev --local` in relay/
//   node tools/load.mjs --relay ws://127.0.0.1:8787 --players 8 --minutes 3 --level 3 --water low
//   node tools/load.mjs --relay ws://127.0.0.1:8787 --old 3ee8dd0      # the client files of another commit (a "before" run)
//   node tools/load.mjs --relay ws://127.0.0.1:8787 --kill-host-at 60  # close the host after 60 s: a joiner must take over
//   node tools/load.mjs … --json /tmp/load.json           # the raw numbers too
//
// One host (host.html, desktop), N-1 joiners (index.html; every other one a phone-sized touch page).
// The lobby is measured for --lobby seconds (default 10), then the host starts, --level jumps it to
// that level (1-based; window.livboj._jump), and the bots play for --minutes: they chase the swimmer
// they are nearest to, dash now and then, and the host (whoever is host) goes on from every level board
// and starts a new game after a game over. Water: ?water=2d by default (eight pages on one machine);
// --water low|gl|default to change it.
//
// The leaderboard and the suggestion box are always stubbed (stubBoard): nothing is ever posted.
// What the pages send and receive is counted by a WebSocket wrapper injected before any page script,
// so the numbers mean the same for any client build (--old). Sampled every second.
//
// Exit code 1 on any sanity failure: a roster that was not N on some client, a host election (unless
// --kill-host-at), pending leaves, a bot that never scored, no level progress, console/page errors,
// relay errors (connects refused, sockets closed, HTTP errors on the room URL) — which is how the
// daily request cap would show: the run then stops early and says so.
import { serve, launch, stubBoard, ROOT } from "./harness.mjs";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const args = {}; const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith("--")) { const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true"; args[a.slice(2)] = v; } }
const LIVE_RELAY = "wss://livboj-relay.livboj.workers.dev";
const RELAY = (args.relay || LIVE_RELAY).replace(/\/$/, "");
const N = Math.max(2, Math.min(12, +(args.players || 8)));
const MINUTES = +(args.minutes || 3);
const LOBBY_S = +(args.lobby || 10);
const LEVEL = args.level ? Math.max(1, Math.min(8, +args.level)) : 0;
const WATER = args.water || "2d";
const KILL_AT = args["kill-host-at"] ? +args["kill-host-at"] : 0;
const OLD = args.old && args.old !== "true" ? args.old : "";
const DAILY = 100000; // Cloudflare Workers free plan: requests per day, the whole account
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

if (RELAY === LIVE_RELAY) log("NOTE: this run goes through the LIVE relay and spends the shared daily request quota.");
// ---- the room URL over HTTP: a Durable Object answers 426 to a non-upgrade request. Anything else
// (429, 1027 "exceeded daily request limit", 5xx, a network error) is the relay refusing.
const RELAY_HTTP = RELAY.replace(/^ws(s?):\/\//, "http$1://");
async function probe() {
  try { const r = await fetch(`${RELAY_HTTP}/room/PROBE`, { signal: AbortSignal.timeout(8000) }); const t = (await r.text()).slice(0, 120).replace(/\s+/g, " "); return { status: r.status, ok: r.status === 426, text: t }; }
  catch (e) { return { status: 0, ok: false, text: String(e.message || e) }; }
}

// --old <rev>: the client files of that commit, for every page, or (--old-for host|joiners|half) only
// for the host, only the joiners, or every other joiner (a room of mixed builds, as after a deploy)
const OLD_FOR = args["old-for"] || "all";
const server = await serve(), oldServer = OLD && OLD_FOR !== "all" ? await serve() : server;
if (OLD) {
  for (const f of ["game.js", "net.js", "sim.js", "render.js", "hud.js", "water.js", "boot.js", "index.html", "host.html"]) {
    try { oldServer.overrides.set("/" + f, execFileSync("git", ["show", `${OLD}:${f}`], { cwd: ROOT, encoding: "utf8" })); } catch { /* the file did not exist then */ }
  }
  log(`client files from ${OLD} (served from memory) for ${OLD_FOR === "all" ? "every page" : OLD_FOR === "half" ? "every other joiner" : `the ${OLD_FOR}`}`);
}
const isOld = (i) => !!OLD && (OLD_FOR === "all" || (OLD_FOR === "host" && i === 0) || (OLD_FOR === "joiners" && i > 0) || (OLD_FOR === "half" && i > 0 && i % 2 === 0));
const baseFor = (i) => (isOld(i) ? oldServer.url : server.url);
const browser = await launch({ args: ["--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows"] });
const room = Array.from({ length: 5 }, () => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[(Math.random() * 31) | 0]).join("");
const q = (extra) => `?${[extra, `relay=${encodeURIComponent(RELAY)}`, WATER !== "default" ? `water=${WATER}` : ""].filter(Boolean).join("&")}`;

// ---- injected into every page before its own scripts: counts the room socket's traffic per action
// (messages, UTF-8 bytes), the state snapshots' arrival (time, phase), the inputs' arrival per sender,
// closes and refused connects, and the frame intervals.
function instrument() {
  const Native = window.WebSocket, enc = new TextEncoder();
  const net = window.__net = { sent: {}, recv: {}, st: [], inp: {}, inpTo: {}, inpLog: [], closes: [], opens: 0, fails: 0, frames: [], phaseOut: "", epoch: 0, nMin: 99, nMax: 0, auth: [], vis: document.visibilityState };
  const cnt = (box, a, len) => { const c = box[a] || (box[a] = [0, 0]); c[0]++; c[1] += len; };
  window.WebSocket = class extends Native {
    constructor(u, p) {
      super(u, p);
      this.__room = /\/room\//.test(String(u));
      if (!this.__room) return;
      let opened = false;
      this.addEventListener("open", () => { opened = true; net.opens++; });
      this.addEventListener("close", (e) => { net.closes.push({ code: e.code, opened, t: Date.now() }); if (!opened) net.fails++; });
      this.addEventListener("message", (e) => {
        const s = typeof e.data === "string" ? e.data : ""; let m; try { m = JSON.parse(s); } catch { return; }
        const a = m.t === "msg" ? m.a : m.t; cnt(net.recv, a, enc.encode(s).length);
        const now = performance.now();
        if (a === "st") net.st.push([now, (m.d && m.d.phase) || ""]);
        else if (a === "inp") { (net.inp[m.from] || (net.inp[m.from] = [])).push([now, net.phaseOut, net.epoch]); }
      });
    }
    send(s) {
      super.send(s);
      if (!this.__room) return;
      let a = "?", m = null; try { m = JSON.parse(s); a = m.t === "msg" ? m.a : m.t; } catch {}
      cnt(net.sent, a, enc.encode(s).length);
      if (a === "st" && m.d) { if (m.d.phase === "play" && net.phaseOut !== "play") net.epoch++; net.phaseOut = m.d.phase; }
      if (a === "inp") { const k = m.to === undefined ? "(all)" : m.to; net.inpTo[k] = (net.inpTo[k] || 0) + 1; if (net.inpLog.length < 20000) net.inpLog.push([Math.round(Date.now()), k]); }
    }
  };
  let last = 0; const f = (t) => { if (last && net.frames.length < 200000) net.frames.push(Math.round((t - last) * 10) / 10); last = t; requestAnimationFrame(f); }; requestAnimationFrame(f);
  setInterval(() => { // roster size and role, 5 times a second
    const L = window.livboj; if (!L || !L.debug) return;
    try { const d = L.debug(), n = d.authoritative ? L.roster().length : d.n; if (d.hasState || d.authoritative) { net.nMin = Math.min(net.nMin, n); net.nMax = Math.max(net.nMax, n); } if (d.authoritative && !net.auth.length) net.auth.push(performance.now()); } catch {}
  }, 200);
}

// ---- the bot, in the page (so eight pages don't wait on round trips): keyboard or touch events on
// the real listeners. Whoever is host goes on from the level boards and the end screens.
function bot(kind, seed) {
  let rnd = seed; const rand = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
  const canvas = document.getElementById("game"), held = new Set();
  const key = (k, on) => {
    if (on === held.has(k)) return;
    if (on) held.add(k); else held.delete(k);
    document.body.dispatchEvent(new KeyboardEvent(on ? "keydown" : "keyup", { key: k === "Space" ? " " : k, bubbles: true, cancelable: true }));
  };
  const tapKey = (k) => { key(k, true); key(k, false); };
  // logical canvas (1200x600) -> client
  const client = (lx, ly) => { const r = canvas.getBoundingClientRect(); return { x: r.left + lx * r.width / 1200, y: r.top + ly * r.height / 600 }; };
  const worldToClient = (d, wx, wy) => client(d.fit.ox + wx * d.fit.s, d.fit.oy + wy * d.fit.s);
  let finger = null; // the steering finger
  const touch = (type, id, p, list) => {
    const t = new Touch({ identifier: id, target: canvas, clientX: p.x, clientY: p.y });
    const touches = (list || []).map((q) => new Touch({ identifier: q.id, target: canvas, clientX: q.x, clientY: q.y }));
    canvas.dispatchEvent(new TouchEvent(type, { touches, targetTouches: touches, changedTouches: [t], bubbles: true, cancelable: true }));
  };
  const lift = () => { if (finger) { touch("touchend", 1, finger, []); finger = null; } };
  const tapAt = (p) => { touch("touchstart", 7, p, [{ id: 7, ...p }]); touch("touchend", 7, p, []); };
  let waitUntil = 0, phaseSeen = "", phaseAt = 0;
  const st = window.__bot = { ticks: 0, dashes: 0, advances: 0, kind };
  st.timer = setInterval(() => {
    const L = window.livboj; if (!L) return;
    let d; try { d = L.debug(); } catch { return; }
    st.ticks++;
    const now = performance.now();
    if (d.phase !== phaseSeen) { phaseSeen = d.phase; phaseAt = now; }
    if (d.phase !== "play") {
      for (const k of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space"]) key(k, false);
      lift();
      // the host goes on: from the level board after 2.5 s, from an end screen after 3 s, from the lobby (after a game) after 1.5 s
      const wait = { cleared: 2500, over: 3000, win: 3000, lobby: 1500 }[d.phase];
      if (d.authoritative && wait && now - phaseAt > wait && now > waitUntil) {
        waitUntil = now + 1500; st.advances++;
        if (kind === "desktop") tapKey("Enter");
        else { const b = d.actionBtn; tapAt(b ? client(b.x + b.w / 2, b.y + b.h / 2) : client(600, 300)); }
      }
      return;
    }
    const me = d.self, others = d.players.filter((p) => !p.you);
    // the swimmer I am the nearest player to (else the nearest one)
    let best = null, bd = 1e9, any = null, ad = 1e9;
    for (const s of d.sw) {
      const dm = Math.hypot(s[0] - me.x, s[1] - me.y);
      if (dm < ad) { ad = dm; any = s; }
      if (others.every((p) => Math.hypot(s[0] - p.x, s[1] - p.y) > dm) && dm < bd) { bd = dm; best = s; }
    }
    const tgt = best || any;
    if (!tgt) { for (const k of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) key(k, false); lift(); return; }
    const dist = Math.hypot(tgt[0] - me.x, tgt[1] - me.y), dash = dist > 90 && dist < 260 && rand() < 0.04;
    if (kind === "desktop") {
      const dx = tgt[0] - me.x, dy = tgt[1] - me.y;
      key("ArrowRight", dx > 8); key("ArrowLeft", dx < -8); key("ArrowDown", dy > 8); key("ArrowUp", dy < -8);
      if (dash) { key("Space", true); st.dashes++; setTimeout(() => key("Space", false), 60); }
    } else {
      const p = worldToClient(d, tgt[0], tgt[1]);
      if (!finger) { finger = p; touch("touchstart", 1, p, [{ id: 1, ...p }]); }
      else { finger = p; touch("touchmove", 1, p, [{ id: 1, ...p }]); }
      if (dash && d.dashBtn) { const b = client(d.dashBtn.x, d.dashBtn.y); touch("touchstart", 2, b, [{ id: 1, ...finger }, { id: 2, ...b }]); touch("touchend", 2, b, [{ id: 1, ...finger }]); st.dashes++; }
    }
  }, 50);
}

// ---- the players
const clients = [];
async function addClient(i) {
  const host = i === 0, kind = host || i % 2 === 1 ? "desktop" : "phone";
  const vp = kind === "desktop" ? { viewport: { width: 1366, height: 768 } } : { viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true };
  const context = await browser.newContext(vp);
  const board = await stubBoard(context); // never the real leaderboard
  await context.route(/\/forslag(\?|$)/, (r) => r.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: '{"ok":true}' }));
  await context.addInitScript(instrument);
  const page = await context.newPage();
  const c = { i, name: `Bot${i + 1}`, host, kind, old: isOld(i), context, page, board, errors: [], samples: [], closed: false, wsErrors: [] };
  page.on("pageerror", (e) => c.errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") c.errors.push("console: " + m.text()); });
  page.on("websocket", (ws) => { if (/\/room\//.test(ws.url())) ws.on("socketerror", (e) => c.wsErrors.push(String(e))); });
  if (host) {
    await page.goto(baseFor(i) + "host.html" + q(`room=${room}`), { waitUntil: "load" });
    await page.waitForFunction(() => !!document.getElementById("create"));
    await page.fill("#name", c.name); await page.click("#create");
  } else {
    await page.goto(baseFor(i) + "index.html" + q(`room=${room}`), { waitUntil: "load" });
    await page.waitForFunction(() => !!document.getElementById("join"));
    await page.fill("#name", c.name); await page.click("#join");
  }
  await page.waitForFunction(() => !!window.livboj, null, { timeout: 20000 });
  clients.push(c);
  return c;
}

const probes = [];
const p0 = await probe(); probes.push({ when: "start", ...p0 });
log(`relay ${RELAY}  room ${room}  ${N} players  ${MINUTES} min  water ${WATER}${LEVEL ? `  level ${LEVEL}` : ""}${KILL_AT ? `  host closed at ${KILL_AT} s` : ""}${OLD ? `  client ${OLD}` : ""}`);
log(`room URL over HTTP: ${p0.status} ${p0.ok ? "(426 = the Durable Object answered)" : "UNEXPECTED: " + p0.text}`);
let abort = p0.ok ? "" : `the relay's room URL answered ${p0.status} (${p0.text}) before the run — it is refusing requests (the daily cap? down?)`;

if (!abort) {
  await addClient(0);
  for (let i = 1; i < N; i++) { await addClient(i); await sleep(250); }
  try {
    await clients[0].page.waitForFunction((n) => window.livboj.roster().length === n, N, { timeout: 30000 });
    for (const c of clients.slice(1)) await c.page.waitForFunction((n) => window.livboj.debug().n === n && window.livboj.debug().phase === "lobby", N, { timeout: 30000 });
  } catch { abort = `not everyone got into the lobby: host roster ${await clients[0].page.evaluate(() => window.livboj.roster().length)}, joiners ${(await Promise.all(clients.slice(1).map((c) => c.page.evaluate(() => window.livboj.debug().n)))).join(",")}`; }
}

// ---- sampling
const snap = (c) => c.page.evaluate(() => {
  const n = window.__net, L = window.livboj, d = L.debug(), r = L.relay ? L.relay() : null;
  const role = { auth: d.authoritative, promoted: d.promoted, phase: d.phase, level: d.level, n: d.authoritative ? L.roster().length : d.n, monsters: d.monsters, caught: d.caught };
  const pl = d.players.map((p, i) => ({ name: p.name, you: p.you, r: p.rescues != null ? p.rescues : ((d.rescues || [])[i] || {}).r || 0 }));
  const nMin = n.nMin, nMax = n.nMax; n.nMin = 99; n.nMax = 0;
  return { t: Date.now(), sent: JSON.parse(JSON.stringify(n.sent)), recv: JSON.parse(JSON.stringify(n.recv)), opens: n.opens, fails: n.fails, closes: n.closes.length, nMin, nMax, ...role, pl, pending: r ? r.pendingLeaves : 0, vis: document.visibilityState, bot: window.__bot ? { ...window.__bot, timer: undefined } : null };
});
const live = () => clients.filter((c) => !c.closed);
const sampleAll = async (phase) => { for (const c of live()) { try { const s = await snap(c); s.ph = phase; c.samples.push(s); } catch (e) { c.errors.push("sample: " + e.message); } } };

let lobbyFrom = 0, playFrom = 0, killedAt = 0, endAt = 0;
if (!abort) {
  log(`everyone in the lobby; measuring the lobby for ${LOBBY_S} s`);
  await sampleAll("pre"); // (resets the in-page roster min/max: the joining is over)
  await sampleAll("lobby"); lobbyFrom = Date.now();
  for (let s = 0; s < LOBBY_S; s++) { await sleep(1000); await sampleAll("lobby"); }
  for (const c of clients) await c.page.evaluate(() => { window.__net.frames.length = 0; window.__net.st.length = 0; window.__net.inp = {}; });
  await clients[0].page.click("#start");
  if (LEVEL) { await clients[0].page.waitForFunction(() => window.livboj.debug().phase === "play", null, { timeout: 10000 }).catch(() => {}); await clients[0].page.evaluate((i) => window.livboj._jump(i), LEVEL - 1); }
  for (const c of clients) await c.page.evaluate(`(${bot})(${JSON.stringify(c.kind)}, ${1000 + c.i * 7919})`);
  log(`game started; bots playing for ${MINUTES} min`);
  playFrom = Date.now(); await sampleAll("play");
  const total = MINUTES * 60;
  let badRun = 0;
  for (let s = 1; s <= total; s++) {
    await sleep(Math.max(0, playFrom + s * 1000 - Date.now()));
    if (KILL_AT && !killedAt && s === Math.max(1, KILL_AT - 6)) { // the host change happens mid-level with monsters in the water: level 6 (3 of them) unless there are some already
      const d = await clients[0].page.evaluate(() => window.livboj.debug());
      if (!(d.phase === "play" && d.monsters > 0)) { await clients[0].page.evaluate(() => window.livboj._jump(5)); log(`t=${s}s: host jumps to level 6 (monsters) before it is closed`); }
    }
    if (KILL_AT && !killedAt && s >= KILL_AT) {
      const h = clients[0]; const d = await h.page.evaluate(() => window.livboj.debug());
      log(`t=${s}s: closing the host (phase ${d.phase}, level ${d.level + 1}, monsters ${d.monsters}, caught ${d.caught})`);
      clients[0].beforeKill = d; h.closed = true; killedAt = Date.now(); await h.context.close();
    }
    await sampleAll("play");
    // relay trouble: refused connects or closed sockets on any page
    const fails = live().reduce((a, c) => a + (c.samples.at(-1) ? c.samples.at(-1).fails : 0), 0);
    const closes = live().reduce((a, c) => a + (c.samples.at(-1) ? c.samples.at(-1).closes : 0), 0);
    if (fails || closes) {
      badRun++;
      if (badRun === 1 || badRun % 5 === 0) { const p = await probe(); probes.push({ when: `t=${s}s`, ...p }); log(`t=${s}s: relay trouble — ${fails} refused connects, ${closes} socket closes; room URL ${p.status} ${p.ok ? "" : p.text}`); if (!p.ok || fails >= 3) { abort = `the relay refused connections during the run (${fails} refused connects, ${closes} closes; room URL answered ${p.status} ${p.text}) — this is how the daily request cap shows`; break; } }
    }
    if (s % 30 === 0) {
      const h = live().find((c) => c.samples.at(-1) && c.samples.at(-1).auth), hs = h && h.samples.at(-1);
      log(`t=${s}s: ${hs ? `host ${h.name} phase ${hs.phase} level ${hs.level + 1} caught ${hs.caught} rescues ${hs.pl.map((p) => p.r).join("/")}` : "no host!"}`);
    }
  }
  endAt = Date.now();
}
probes.push({ when: "end", ...(await probe()) });

// ---- final data out of the pages
for (const c of live()) {
  try {
    c.final = await c.page.evaluate(() => { const n = window.__net; if (window.__bot) clearInterval(window.__bot.timer); return { st: n.st, inp: n.inp, inpTo: n.inpTo, inpLog: n.inpLog, frames: n.frames, closes: n.closes, auth: n.auth }; });
  } catch (e) { c.errors.push("final: " + e.message); }
}
await browser.close(); await server.close(); if (oldServer !== server) await oldServer.close();

// ---- report
const pct = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
const f0 = (x) => (Number.isFinite(x) ? x.toFixed(0) : "-"), f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "-"), f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : "-");
// per-second rates of one client between two times, per action: { a: { mean, max, bmean } } + totals
function rates(c, ph, dir) {
  const S = c.samples.filter((s) => s.ph === ph);
  const per = {}, tot = [], totB = [];
  for (let i = 1; i < S.length; i++) {
    const dt = (S[i].t - S[i - 1].t) / 1000; if (dt <= 0) continue;
    let m = 0, b = 0;
    const acts = new Set([...Object.keys(S[i][dir]), ...Object.keys(S[i - 1][dir])]);
    for (const a of acts) {
      const x = S[i][dir][a] || [0, 0], y = S[i - 1][dir][a] || [0, 0], dm = (x[0] - y[0]) / dt, db = (x[1] - y[1]) / dt;
      (per[a] || (per[a] = { m: [], b: [] })).m.push(dm); per[a].b.push(db); m += dm; b += db;
    }
    tot.push(m); totB.push(b);
  }
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const out = { mean: mean(tot), max: tot.length ? Math.max(...tot) : 0, bmean: mean(totB), acts: {} };
  for (const [a, v] of Object.entries(per)) out.acts[a] = { mean: mean(v.m), max: Math.max(...v.m), bmean: mean(v.b) };
  return out;
}
const fails = []; const fail = (m) => fails.push(m);
const lines = [];
const P = (s = "") => lines.push(s);
P(""); P(`==== load report: ${N} players, ${((endAt - playFrom) / 60000 || 0).toFixed(1)} min of play, relay ${RELAY}${OLD ? `, client ${OLD}` : ""}${KILL_AT ? `, host closed at ${KILL_AT} s` : ""}`);
if (abort) { P(""); P(`!!!! STOPPED EARLY: ${abort}`); fail(abort); }
const report = { N, minutes: MINUTES, relay: RELAY, old: OLD || null, level: LEVEL, water: WATER, kill: KILL_AT, abort, clients: [], probes };
for (const ph of ["lobby", "play"]) {
  const R = clients.map((c) => ({ c, s: rates(c, ph, "sent"), r: rates(c, ph, "recv") }));
  if (!R.some((x) => x.s.mean || x.r.mean)) continue;
  P(""); P(`-- ${ph}: messages and bytes per second, per client (mean / max; bytes: mean)${OLD ? ` — * = client ${OLD}` : ""}`);
  P(`   client       kind     conn  sent msg/s    sent B/s   recv msg/s    recv B/s   sent by action                 recv by action`);
  for (const { c, s, r } of R) {
    const last = c.samples.at(-1) || {};
    const acts = (o) => Object.entries(o.acts).filter(([, v]) => v.mean >= 0.005).sort((a, b) => b[1].mean - a[1].mean).map(([a, v]) => `${a} ${f1(v.mean)}/${f1(v.max)}`).join(", ");
    P(`   ${(c.name + (c.host ? " (host)" : "")).padEnd(12)} ${(c.kind + (c.old ? "*" : "")).padEnd(8)} ${String(last.opens ?? "-").padStart(2)}/${String(Math.max(0, (last.opens || 0) - 1)).padEnd(2)} ${(f1(s.mean) + " / " + f0(s.max)).padStart(10)} ${f0(s.bmean).padStart(10)} ${(f1(r.mean) + " / " + f0(r.max)).padStart(12)} ${f0(r.bmean).padStart(11)}   ${acts(s).padEnd(30)} ${acts(r)}`);
  }
  // the room: every message a client sends is one incoming to the relay
  const inc = R.reduce((a, x) => a + x.s.mean, 0), incMax = R.reduce((a, x) => a + x.s.max, 0);
  const joinR = R.filter((x) => !x.c.host).map((x) => x.r.mean), joinB = R.filter((x) => !x.c.host).map((x) => x.r.bmean);
  const sentB = R.reduce((a, x) => a + x.s.bmean, 0);
  P(`   room: ${f1(inc)} incoming messages/s to the relay (sum of the per-second maxima ${f0(incMax)}), ${f0(sentB)} B/s up; each joiner receives ${f1(Math.min(...joinR))}–${f1(Math.max(...joinR))} msg/s, ${f0(Math.min(...joinB))}–${f0(Math.max(...joinB))} B/s`);
  const hA = DAILY * 20 / (inc * 3600), hB = DAILY / (inc * 3600);
  P(`   free plan (${DAILY.toLocaleString("en")} requests/day, whole account), at this rate: ${f1(hA)} h/day if 20 messages count as 1 request, ${f2(hB)} h/day (${f0(hB * 60)} min) if every message counts`);
  report[ph] = { incoming: inc, incomingMaxSum: incMax, sentBps: sentB, joinerRecv: joinR, joinerRecvB: joinB, hoursAt20to1: hA, hoursAt1to1: hB, perClient: R.map((x) => ({ name: x.c.name, kind: x.c.kind, host: x.c.host, sent: x.s, recv: x.r })) };
}
// state freshness on joiners (in play, gaps between two snapshots both in play), input gaps on the host
P(""); P("-- joiners: time between state snapshots (ms; in play / over the whole run)");
const allPlayGaps = [];
for (const c of clients.filter((c) => !c.host && c.final)) {
  const st = c.final.st, play = [], all = [];
  for (let i = 1; i < st.length; i++) { const g = st[i][0] - st[i - 1][0]; all.push(g); if (st[i][1] === "play" && st[i - 1][1] === "play") play.push(g); }
  allPlayGaps.push(...play);
  P(`   ${c.name.padEnd(6)} play p50 ${f0(pct(play, 50))} p95 ${f0(pct(play, 95))} max ${f0(Math.max(...play))} · all phases max ${f0(Math.max(...all))} (${all.length} snapshots)`);
  // (a host change leaves one long gap on purpose)
  if (Math.max(...all) > 2500 && !KILL_AT) fail(`${c.name}: a ${f0(Math.max(...all))} ms gap without state (elections start at 3000 ms)`);
}
P("-- host: time between one peer's inputs (ms; both in the same stretch of play)");
const hostsSeen = clients.filter((c) => c.final && (c.host || c.final.auth.length));
for (const h of hostsSeen) {
  for (const [from, arr] of Object.entries(h.final.inp)) {
    const g = []; for (let i = 1; i < arr.length; i++) if (arr[i][1] === "play" && arr[i - 1][1] === "play" && arr[i][2] === arr[i - 1][2]) g.push(arr[i][0] - arr[i - 1][0]);
    if (!g.length) continue;
    P(`   at ${h.name}${h.host ? "" : " (promoted)"} from ${from.slice(0, 8)}: ${arr.length} inputs, p50 ${f0(pct(g, 50))} p95 ${f0(pct(g, 95))} max ${f0(Math.max(...g))}`);
  }
}
P("-- frame interval per client (ms, p50 / p95; headless Chromium on this machine — not a phone's frame times)");
P("   " + clients.filter((c) => c.final).map((c) => `${c.name} ${f1(pct(c.final.frames, 50))}/${f1(pct(c.final.frames, 95))}`).join("  "));

// ---- sanity
P(""); P("-- sanity");
const check = (cond, msg, extra = "") => { P(`   ${cond ? "ok  " : "FAIL"}  ${msg}${extra ? "  " + extra : ""}`); if (!cond) fail(msg); return cond; };
const playS = (c) => c.samples.filter((s) => s.ph === "play");
const expectN = (c, s) => (KILL_AT && killedAt && s.t >= killedAt + 8000 ? N - 1 : N);
for (const c of clients) {
  const S = c.samples.filter((s) => s.ph !== "pre" && !(KILL_AT && killedAt && s.t > killedAt - 1000 && s.t < killedAt + 8000)); // around a host change the roster changes on purpose
  const bad = S.filter((s) => s.nMin !== 99 && (s.nMin !== expectN(c, s) || s.nMax !== expectN(c, s)));
  check(!bad.length, `${c.name}: roster size stayed ${KILL_AT ? `${N} (then ${N - 1} after the host left)` : N} the whole time`, bad.length ? `${bad.length} samples off: ${bad.slice(0, 3).map((s) => `${s.nMin}-${s.nMax} (${s.ph}${killedAt ? `, ${((s.t - killedAt) / 1000).toFixed(1)} s after the host left` : ""})`).join(", ")}` : "");
}
const promoted = clients.filter((c) => !c.host && c.samples.some((s) => s.auth));
if (KILL_AT) {
  check(!!killedAt, "the host was closed mid-run");
  check(promoted.length === 1, "exactly one joiner took over as host", promoted.map((c) => c.name).join(", ") || "none");
  const nh = promoted[0];
  if (nh) {
    const after = nh.samples.filter((s) => s.t > killedAt + 1000);
    const took = after.find((s) => s.auth);
    check(!!took && took.t - killedAt < 12000, "…within 12 s of the host leaving", took ? `${f1((took.t - killedAt) / 1000)} s` : "");
    const b = clients[0].beforeKill, a = after.find((s) => s.auth);
    if (b && a) check(a.level === b.level && (b.phase !== "play" || a.monsters === b.monsters) && a.caught >= b.caught, "…same level, the monsters and the score carried over", `level ${b.level + 1}->${a.level + 1}, monsters ${b.monsters}->${a.monsters}, caught ${b.caught}->${a.caught}`);
    const others = clients.filter((c) => !c.host && c !== nh);
    // senders whose inputs arrived at the new host after it took over (and how many; the first one how soon)
    const since = nh.final && nh.final.auth.length ? nh.final.auth[0] : Infinity;
    const after2 = nh.final ? Object.values(nh.final.inp).map((a) => a.filter((x) => x[0] > since)) : [];
    const firstIn = after2.filter((a) => a.length).map((a) => a[0][0] - since);
    check(after2.filter((a) => a.length > 10).length >= others.length, "…and every remaining joiner's inputs reach the new host", `${after2.filter((a) => a.length > 10).length} senders with inputs after the takeover (${after2.map((a) => a.length).join("/")}), ${others.length} expected; first inputs ${firstIn.map((x) => f0(x)).join("/")} ms after it took over`);
    check(others.every((c) => c.samples.at(-1) && !c.samples.at(-1).auth && c.samples.at(-1).phase), "…the other joiners follow it (no second host)");
    // where each remaining joiner sent its inputs after the old host was closed (ms after the close)
    const oldId = b && b.hostId;
    P(`   info  joiners' inputs after the host was closed (ms after the close: first to everyone / first to the new host; last to the old host): ` + others.map((c) => {
      const L = ((c.final && c.final.inpLog) || []).filter((x) => x[0] > killedAt);
      const fa = L.find((x) => x[1] === "(all)"), fn = L.find((x) => x[1] !== "(all)" && x[1] !== oldId), lo = [...L].reverse().find((x) => x[1] === oldId);
      return `${c.name} ${fa ? fa[0] - killedAt : "-"}/${fn ? fn[0] - killedAt : "-"}; ${lo ? lo[0] - killedAt : "-"}`;
    }).join(" · "));
  }
} else {
  check(clients[0].samples.every((s) => s.auth) && !promoted.length, "no host election (the host stayed host, no joiner promoted)", promoted.map((c) => c.name).join(", "));
}
const pend = clients.flatMap((c) => c.samples.filter((s) => s.pending > 0 && !(KILL_AT && killedAt && Math.abs(s.t - killedAt) < 8000)).map(() => c.name));
check(!pend.length, "no pending leaves", pend.length ? `${pend.length} samples (${[...new Set(pend)].join(", ")})` : "");
// rescues per bot: the best count the host (or the promoted host) ever reported for each name
const best = new Map();
for (const c of clients) for (const s of c.samples) if (s.auth) for (const p of s.pl) best.set(p.name, Math.max(best.get(p.name) || 0, p.r));
const names = clients.map((c) => c.name);
const zero = names.filter((n) => !(best.get(n) > 0) && !(KILL_AT && n === clients[0].name && killedAt));
check(!zero.length && best.size > 0, "every bot scored (rescues registered for joiners as well as the host)", names.map((n) => `${n} ${best.get(n) || 0}`).join(" "));
const lv = clients.flatMap((c) => c.samples.filter((s) => s.ph === "play" && s.auth).map((s) => s.level));
const startLv = LEVEL ? LEVEL - 1 : 0;
const cleared = clients.flatMap((c) => c.samples.filter((s) => s.auth && (s.phase === "cleared" || s.phase === "win"))).length;
check(Math.max(...lv, -1) > startLv || cleared > 0, "levels progressed", `levels seen ${[...new Set(lv)].map((x) => x + 1).join(",")}; level-board samples ${cleared}`);
const errs = clients.flatMap((c) => c.errors.map((e) => `${c.name}: ${e}`));
check(!errs.length, "no console/page errors", errs.slice(0, 5).join(" | "));
const vis = clients.filter((c) => c.samples.some((s) => s.vis !== "visible")).map((c) => c.name);
check(!vis.length, "every page stayed visible (headless: no throttled timers)", vis.join(", "));
// relay errors
const closes = clients.flatMap((c) => (c.final ? c.final.closes : []).map((x) => `${c.name} ${x.code}${x.opened ? "" : " (never opened)"}`));
const refused = clients.reduce((a, c) => a + ((c.samples.at(-1) || {}).fails || 0), 0);
const wsErr = clients.flatMap((c) => c.wsErrors.map((e) => `${c.name}: ${e}`));
check(!closes.length && !refused && !wsErr.length, "relay: no refused connects, no socket closes, no socket errors", [...closes, ...wsErr].slice(0, 6).join(", "));
check(probes.every((p) => p.ok), "relay: the room URL answered 426 (a live Durable Object) every time it was probed", probes.map((p) => `${p.when} ${p.status}`).join(", "));
// directed delivery: with a relay that knows `to`, a joiner never receives another joiner's input
const joinInp = clients.filter((c) => !c.host && !(c.final && c.final.auth.length)).map((c) => (((c.samples.at(-1) || {}).recv || {}).inp || [0])[0]);
const sentTo = clients.filter((c) => !c.host && c.final).map((c) => Object.entries(c.final.inpTo).map(([k, v]) => `${k === "(all)" ? "all" : k.slice(0, 6)}:${v}`).join(" "));
P(`   info  inputs received by joiners (another joiner's; 0 = the relay delivers inputs to the host only): ${joinInp.join(" ")}`);
P(`   info  inputs sent per joiner, by target: ${sentTo.join(" | ")}`);
P(`   info  bots: ${clients.map((c) => { const b = (c.samples.at(-1) || {}).bot; return b ? `${c.name} ${b.kind} dashes ${b.dashes} advances ${b.advances}` : `${c.name} -`; }).join(" · ")}`);
P(""); P(fails.length ? `FAIL: ${fails.length} problem(s)` : "PASS");
for (const l of lines) log(l);
report.fails = fails;
report.clients = clients.map((c) => ({ name: c.name, kind: c.kind, host: c.host, errors: c.errors, closes: c.final ? c.final.closes : [], frames: c.final ? { p50: pct(c.final.frames, 50), p95: pct(c.final.frames, 95) } : null }));
report.playGaps = { p50: pct(allPlayGaps, 50), p95: pct(allPlayGaps, 95), max: Math.max(...allPlayGaps) };
if (args.json) fs.writeFileSync(args.json, JSON.stringify(report, null, 1));
process.exit(fails.length ? 1 : 0);

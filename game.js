// Livbojen — the game: one createGame() per canvas (solo / host / join) that
// wires the simulation (sim.js), the renderer (render.js) and the network
// (net.js) together, plus sound and the page chrome (fullscreen, rotate card,
// iOS fixes). Solo and the host run the sim; a joiner draws the host's state.
//
// Cache busting (see boot.js): boot.js imports game.js?v=<build>, where the
// build fingerprint covers every module file. The siblings are imported here
// with that same ?v= (empty in node or when unversioned), so a changed sim.js
// gets a new URL too and every module is loaded under exactly one URL. Never
// `import … from "./sim.js"` statically: that is a second, uncached copy.
// A new module file also goes into MODULES in boot.js.
const V = new URL(import.meta.url).search;
const [sim, net, { createRenderer }] = await Promise.all([import(`./sim.js${V}`), import(`./net.js${V}`), import(`./render.js${V}`)]);
const { Phase, BASE_LEVELS, SHORE_H, EAT_DWELL, shoreY, levelParams, inSwamp, circleHitsRect, whirlPull, SWAMP_SLOW, WHIRL_PLAYER, createSim } = sim;
const { RELAY_URL, SIG_PARAM, RTC, APP_ID, SIGNAL, getRelaySockets, pickSignaling, relayJoin, runIceProbe,
  loadBoard, saveBoardLS, withEntryId, sortBoard, postGlobalBoard, queueResult, flushBoardQueue } = net;
// what boot.js hands the pages (besides createGame and initChrome)
export const { fetchGlobalBoard, fetchGlobalBoardFull, postForslag } = net;
let selfId = net.initialSelfId; // re-pointed to the chosen strategy's id before any use
const BOARD_SHOW = 10;

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
const SOUNDS = { start: sStart, dash: sDash, stun: sStun, miss: sMiss, rescue: sRescue, clear: sClear, over: sOver, win: sWin, chomp: sChomp }; // sim.js hooks.sound(name)

// ---- Page chrome (index.html and host.html) --------------------------------
// Fullscreen button + F key, the "Vrid mobilen" card, the add-to-home-screen
// hint, gesture blocking on the game, and the iOS scroll-offset fix.
const UA = navigator.userAgent || "";
const IS_IOS = /iPad|iPhone|iPod/.test(UA) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
// in-app browsers (Messenger, Instagram, Snapchat, TikTok, the Google app…) can't add to the home screen
const IN_APP = /FBAN|FBAV|FB_IAB|FBIOS|MessengerForiOS|Messenger|Instagram|Snapchat|musical_ly|Bytedance|TikTok|LinkedInApp|Line\/|GSA\//i.test(UA);
const IOS_OTHER_BROWSER = /CriOS|FxiOS|EdgiOS|OPiOS|YaBrowser/i.test(UA);
const isStandalone = () => navigator.standalone === true || matchMedia("(display-mode: standalone)").matches || matchMedia("(display-mode: fullscreen)").matches;
const isTextField = (el) => !!el && (el.isContentEditable || el.tagName === "TEXTAREA" || el.tagName === "SELECT" ||
  (el.tagName === "INPUT" && !/^(checkbox|radio|button|submit|reset|range|color|file|image)$/i.test(el.type || "")));
const coarsePointer = () => matchMedia("(pointer: coarse)").matches;

// iOS can leave the window scrolled after a rotation, a toolbar change or the
// keyboard (also across a reload): the page is then drawn higher than where
// taps land ("I have to tap a cm below the button"). Put any offset back to
// 0,0 — never while pinch-zoomed (the user's own) or while a text field has the
// focus (the keyboard lifts the page on purpose). Element scrolling (the
// menu's .cards) is untouched: only the window's offset is reset.
// (Ported from grabbhelg public/src/viewport.js.)
function unshift() {
  const v = window.visualViewport, d = document.documentElement, b = document.body;
  if (v && v.scale > 1.01) return false;
  if (isTextField(document.activeElement)) return false;
  if (!(window.scrollX || window.scrollY || (v && (v.offsetTop || v.offsetLeft)) || d.scrollTop || (b && b.scrollTop))) return false;
  window.scrollTo(0, 0); d.scrollTop = 0; if (b) b.scrollTop = 0;
  window.livbojUnshifts = (window.livbojUnshifts || 0) + 1;
  return true;
}
let unshiftOn = false;
function keepUnshifted() {
  if (unshiftOn) return; unshiftOn = true;
  const soon = () => { unshift(); requestAnimationFrame(() => unshift()); for (const ms of [120, 350, 800]) setTimeout(unshift, ms); };
  addEventListener("resize", () => unshift(), { passive: true });
  addEventListener("scroll", () => unshift(), { passive: true }); // the window's own scroll only
  if (window.visualViewport) { visualViewport.addEventListener("resize", () => unshift()); visualViewport.addEventListener("scroll", () => unshift()); }
  addEventListener("orientationchange", soon); // iOS reports a rotation's sizes late
  if (screen.orientation && screen.orientation.addEventListener) screen.orientation.addEventListener("change", soon);
  addEventListener("pageshow", soon);
  addEventListener("focusout", () => setTimeout(unshift, 60)); // the keyboard going away
  document.addEventListener("visibilitychange", () => { if (!document.hidden) soon(); });
  soon();
}

const FS_ENTER = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const FS_EXIT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const HOMEHINT_KEY = "livboj-homehint-until";

/**
 * Wire the page chrome. Every element is optional (an older cached page may
 * lack one). Returns { setPlaying(on) } — call it when the game shows/hides.
 */
export function initChrome({ stage, fsBtn, rotateCard, homeHint } = {}) {
  keepUnshifted();
  const root = document.documentElement;
  let playing = false, rotateDismissed = false;

  // Pinch, double-tap zoom, the long-press menu and text selection: blocked on
  // the game only, never on the menu's inputs.
  if (stage) for (const t of ["gesturestart", "dblclick", "contextmenu", "selectstart"]) stage.addEventListener(t, (e) => e.preventDefault(), { passive: false });

  // ---- Fullscreen. The whole page goes fullscreen (not the canvas), so the
  // button, the rotate card, the update banner and — on the host — the lobby
  // all stay visible. Missing API (iPhone Safari): no button at all.
  const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
  const canFs = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled) && !!(root.requestFullscreen || root.webkitRequestFullscreen);
  function toggleFullscreen() {
    try {
      if (fsElement()) { const p = document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen && document.webkitExitFullscreen(); if (p && p.catch) p.catch(() => {}); }
      else { const p = root.requestFullscreen ? root.requestFullscreen({ navigationUI: "hide" }) : root.webkitRequestFullscreen(); if (p && p.catch) p.catch(() => {}); }
    } catch {}
  }
  function onFsChange() {
    const on = !!fsElement();
    root.classList.toggle("is-fs", on);
    if (fsBtn) { fsBtn.innerHTML = on ? FS_EXIT : FS_ENTER; fsBtn.setAttribute("aria-label", on ? "Avsluta helskärm" : "Helskärm"); fsBtn.title = on ? "Avsluta helskärm (F)" : "Helskärm (F)"; }
    // phones: hold it sideways while fullscreen (not every browser allows it)
    const o = screen.orientation;
    if (on && coarsePointer() && o && o.lock) { try { const p = o.lock("landscape"); if (p && p.catch) p.catch(() => {}); } catch {} }
    else if (!on && o && o.unlock) { try { o.unlock(); } catch {} }
    updateRotate();
  }
  document.addEventListener("fullscreenchange", onFsChange);
  document.addEventListener("webkitfullscreenchange", onFsChange);
  if (fsBtn) {
    fsBtn.hidden = true;
    fsBtn.innerHTML = FS_ENTER;
    // a real click handler: touchstart on the canvas carries no user activation
    fsBtn.addEventListener("click", (e) => { toggleFullscreen(); e.currentTarget.blur(); }); // (blur: Space/Enter must stay game keys)
  }
  addEventListener("keydown", (e) => {
    if ((e.key !== "f" && e.key !== "F") || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTextField(e.target) || isTextField(document.activeElement)) return; // typing a name / a suggestion
    if (!playing || !canFs) return;
    e.preventDefault(); toggleFullscreen();
  });

  // ---- "Vrid mobilen": a touch device held upright while a game shows. The
  // game keeps running underneath; a tap closes it for this page.
  function updateRotate() {
    if (!rotateCard) return;
    const show = playing && !rotateDismissed && coarsePointer() && innerHeight > innerWidth;
    rotateCard.hidden = !show;
  }
  if (rotateCard) {
    const dismiss = (e) => { e.preventDefault(); e.stopPropagation(); rotateDismissed = true; updateRotate(); };
    rotateCard.addEventListener("click", dismiss);
    rotateCard.addEventListener("touchend", dismiss, { passive: false });
    rotateCard.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") dismiss(e); });
  }
  addEventListener("resize", updateRotate);
  addEventListener("orientationchange", () => setTimeout(updateRotate, 200));

  // ---- iPhone / iPad Safari (not already a home-screen app, not an in-app
  // browser): fullscreen only comes by adding the page to the home screen.
  // Dismissal is remembered for 30 days. ?homehint=1 forces it (screenshots).
  if (homeHint) {
    let force = false; try { force = new URLSearchParams(location.search).get("homehint") === "1"; } catch {}
    let snoozed = false; try { snoozed = +localStorage.getItem(HOMEHINT_KEY) > Date.now(); } catch {}
    homeHint.hidden = !(force || (IS_IOS && !IN_APP && !IOS_OTHER_BROWSER && !isStandalone() && !snoozed));
    const close = homeHint.querySelector("button");
    if (close) close.addEventListener("click", () => { homeHint.hidden = true; try { localStorage.setItem(HOMEHINT_KEY, String(Date.now() + 30 * 24 * 3600 * 1000)); } catch {} });
  }

  onFsChange();
  return {
    setPlaying(on) {
      playing = !!on;
      if (fsBtn) fsBtn.hidden = !(playing && canFs);
      if (homeHint && playing) homeHint.hidden = true;
      updateRotate();
    },
    toggleFullscreen,
  };
}

// ==========================================================================
export function createGame(canvas, opts) {
  const CW = canvas.width, CH = canvas.height;
  const mode = opts.mode; // 'solo' | 'host' | 'join'
  const myName = (opts.name || "Spelare").slice(0, 14);
  const myTeam = (opts.team || "").trim().slice(0, 20); // optional, host only
  const cbs = opts.cbs || {};

  let authoritative = mode !== "join"; // solo & host run the sim; join receives
  let promoted = false;

  const selfPos = { x: 0, y: 0, r: 30, dashActive: 0, dashCd: 0, seeded: false };
  let saved = []; // rescued swimmers swimming to / cheering on the shore (cosmetic)
  let levelStartScore = new Map(); // per-player score when the level began ("på väg upp")
  // The authoritative state (world, players, swimmers, monsters, phase, score…)
  // lives in the sim; its side effects come back through these hooks.
  const S = createSim({
    selfId: () => selfId, selfPos,
    hooks: {
      sound: (k) => SOUNDS[k](),
      phase: () => emitPhase(),
      push: () => pushState(),
      result: () => recordResult(),
      rescued: (s) => spawnSaved(s.x, s.y, s.sk, s.hr, s.id),
      levelStarted: () => { saved = []; levelStartScore = new Map([...S.players.values()].map((p) => [p.id, p.score || 0])); },
    },
  });
  S.phase = mode === "solo" ? Phase.INTRO : Phase.LOBBY;
  let hostId = authoritative ? selfId : null;
  let jLastSec = 999; // countdown-tick tracker (joiners)
  // Per-game stats for the leaderboard: time played (the rest is in the sim).
  let gameStartAt = 0;
  function beginGame() { gameStartAt = performance.now(); S.beginGame(); }
  let board = loadBoard(); // leaderboard (global when the relay answers, else the local cache)
  let boardSource = "local"; // "global" once the relay has answered
  let netBoard = []; // leaderboard received from the host (joiners)

  const keys = Object.create(null);
  let usingTouch = false, pointerTarget = null, dashTap = false;

  const iSwim = new Map(), iPlayer = new Map(), iMonster = new Map();
  let jSplashes = [];
  let lastView = null, lastStateTime = 0;

  // Networking
  let room = null, sendState = null, sendInput = null, sendHello = null;
  const A = { st: null, inp: null, hi: null };
  let broadcasting = false;
  let electing = false, electAt = 0;
  let quitArmedUntil = 0; // two-tap confirm so nobody quits by accident

  const R = createRenderer(canvas, {
    myName, mode, selfPos, netSummary,
    view: () => currentView(),
    live: () => ({ authoritative, selfId, usingTouch, muted, quitArmedUntil, levelStartScore, saved }),
  });
  const { DASH_BTN, MUTE_BTN, QUIT_BTN } = R;
  // The host's "go on" prompt is a real button (mouse/touch) as well as Enter.
  function inAction(cx, cy) { const b = R.actionBtn(); return !!b && authoritative && cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h; }
  // "Till startsidan" on the end screen, for everyone. Leaves the room and goes to the menu.
  function inLeave(cx, cy) { const b = R.leaveBtn(); return !!b && cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h; }
  function leaveToStart() { try { room && room.leave && room.leave(); } catch {} location.href = "index.html"; }

  // ---- Setup --------------------------------------------------------------
  function setupSolo() { addPlayer(selfId, myName); beginGame(); startLevel(0); S.phase = Phase.INTRO; S.introTimer = 2.4; emitPhase(); }

  // ---- Network diagnostics: signaling reachability + an ICE probe that tells
  // whether STUN/TURN work from this network (shown in the lobby).
  const iceProbe = { done: false, host: 0, srflx: 0, relay: 0 };
  function netStatus() {
    const peers = room && room.getPeers ? Object.keys(room.getPeers()).length : 0;
    if (RELAY_URL) return { transport: "relay", relayOpen: !!(room && room.isOpen && room.isOpen()), peers, ice: iceProbe };
    let open = 0, total = 0;
    try { for (const s of Object.values(getRelaySockets() || {})) { total++; if (s && s.readyState === 1) open++; } } catch {}
    return { transport: "p2p", signaling: { open, total }, peers, ice: iceProbe };
  }
  function netSummary() {
    const n = netStatus();
    if (n.transport === "relay") return `Nätverk: reläserver ${n.relayOpen ? "ansluten ✓" : "ansluter…"} · ${n.peers} medspelare`;
    const sig = n.signaling.total ? `signalering ${n.signaling.open}/${n.signaling.total}` : "signalering …";
    const ice = !n.ice.done ? "testar STUN/TURN…" : `STUN ${n.ice.srflx ? "✓" : "✗"} · TURN ${n.ice.relay ? "✓" : "✗"}`;
    // TURN unreachable means peers on a locked-down LAN (client isolation / no
    // hairpin) have no fallback path: point straight at the relay.
    const warn = n.ice.done && !n.ice.srflx && !n.ice.relay ? " — nätverket verkar blockera P2P: använd reläservern (relay/README.md)"
      : (n.signaling.total && !n.signaling.open ? " — kan inte nå signaleringen"
      : (n.ice.done && !n.ice.relay ? " — dyker ingen upp? kontorsnät kräver ofta reläservern (relay/README.md)" : ""));
    return `Nätverk: P2P via ${SIGNAL.name} · ${sig} · ${ice} · ${n.peers} medspelare${warn}`;
  }

  function setupNet(asHost) {
    const go = (r) => { room = r; wireRoom(asHost); };
    if (RELAY_URL) { go(relayJoin(RELAY_URL, opts.room, selfId)); return; }
    runIceProbe(iceProbe);
    pickSignaling(3500, SIG_PARAM).then((c) => {
      SIGNAL.name = c.name; SIGNAL.mod = c.mod; SIGNAL.resolved = true; if (c.mod.selfId) selfId = c.mod.selfId;
      go(c.mod.joinRoom({ appId: APP_ID, rtcConfig: RTC }, opts.room));
    });
  }
  function wireRoom(asHost) {
    A.st = room.makeAction("st");
    A.inp = room.makeAction("inp");
    A.hi = room.makeAction("hi");
    room.onPeerJoin((peer) => {
      if (authoritative) { addPlayer(peer, "Spelare"); sJoin(); emitRoster(); pushState(); }
      else if (sendHello) sendHello({ name: myName });
    });
    room.onPeerLeave((peer) => {
      if (authoritative) { S.players.delete(peer); emitRoster(); }
      else if (lastView && peer === lastView.hostId) electHost();
    });
    if (asHost) wireHost(); else wireJoin();
    if (authoritative) emitBoard();
  }
  function wireHost() {
    addPlayer(selfId, myName);
    sendState = (snap) => { try { A.st[0](snap); } catch {} };
    A.hi[1]((data, peer) => { if (!S.players.has(peer)) addPlayer(peer, (data && data.name) || "Spelare"); else renamePlayer(peer, (data && data.name) || "Spelare"); emitRoster(); pushState(); });
    A.inp[1]((data, peer) => { applyPeerInput(peer, data); });
    emitRoster();
    startBroadcast();
  }
  function wireJoin() {
    A.st[1]((data) => applyState(data));
    sendInput = (inp) => { try { A.inp[0](inp); } catch {} };
    sendHello = (d) => { try { A.hi[0](d); } catch {} };
    const iv = setInterval(() => { if (!lastView) sendHello({ name: myName }); else clearInterval(iv); }, 700);
    // Only report a position once seeded from the host's PLAY snapshot for
    // this level — otherwise the initial (0,0) would override the spawn slot.
    setInterval(() => { if (!authoritative && sendInput && selfPos.seeded) sendInput({ x: Math.round(selfPos.x), y: Math.round(selfPos.y), dash: selfPos.dashActive > 0 ? 1 : 0, stun: selfPos.stun > 0 ? 1 : 0 }); }, 50);
  }
  function startBroadcast() { if (broadcasting) return; broadcasting = true; setInterval(() => { if (authoritative && room) pushState(); }, 50); }

  function addPlayer(id, name) { S.addPlayer(id, name); }
  function renamePlayer(id, name) { S.renamePlayer(id, name); }
  // A peer owns its own position (co-op: trust the client so what it sees is real).
  function applyPeerInput(peer, data) {
    let p = S.players.get(peer);
    if (!p) { addPlayer(peer, "Spelare"); p = S.players.get(peer); emitRoster(); }
    if (p && data && typeof data.x === "number") {
      p.x = Math.max(p.r, Math.min(S.world.w - p.r, data.x));
      p.y = Math.max(p.r, Math.min(S.world.h - p.r, data.y));
      p.dashActive = data.dash ? 0.18 : 0;
      p.stunned = !!data.stun;
    }
  }
  function rosterList() { return [...S.players.values()].map((p) => ({ id: p.id, name: p.id === selfId ? myName : p.name, you: p.id === selfId })); }
  function emitBoard() { cbs.onBoard && cbs.onBoard(board, boardSource); }
  function adoptBoard(list, source) {
    board = sortBoard(list.map(withEntryId)); boardSource = source; saveBoardLS(board); emitBoard();
    if (room && (S.phase === Phase.LOBBY || S.phase === Phase.OVER || S.phase === Phase.WIN)) pushState(); // joiners see it too
  }
  // Host: sync with the global list. The local cache is always posted (the
  // relay dedupes by id, so this is idempotent) — that uploads a pre-global
  // list the first time and re-fills the global list from any host's cache
  // if it was ever wiped.
  async function initGlobalBoard() {
    const merged = board.length ? await postGlobalBoard(board) : await fetchGlobalBoard();
    if (!merged) return; // relay unreachable: keep showing the local cache
    adoptBoard(merged, "global");
  }
  function recordResult() {
    if (S.score <= 0) return; // nothing rescued: not a result worth listing
    const entry = withEntryId({
      score: S.score, level: S.levelIndex + 1, won: S.phase === Phase.WIN, n: S.players.size, ts: Date.now(), team: myTeam,
      duration: Math.max(1, Math.round((performance.now() - gameStartAt) / 1000)), rescued: S.totalCaught, combo: S.bestCombo,
      // team total in `score`; per-player breakdown here, best first.
      players: [...S.players.values()].map((p) => ({ name: (p.id === selfId ? myName : p.name) || "Spelare", score: p.score || 0, rescues: p.rescues || 0 })).sort((a, b) => b.score - a.score),
    });
    board.push(entry); sortBoard(board); board = board.slice(0, 50);
    saveBoardLS(board); emitBoard();
    // solo, host and a promoted host all post; joiners never do. Queued first,
    // so a failed post is retried on the next page load / when back online.
    if (authoritative) { queueResult(entry); flushBoardQueue().then((merged) => { if (merged) adoptBoard(merged, "global"); }); }
  }
  function clearBoard() { board = []; boardSource = "local"; saveBoardLS(board); emitBoard(); } // local cache only

  // A rescued swimmer heads for the beach and cheers once it arrives. Purely
  // cosmetic and spawned locally on every client (from the rescue event), so
  // it needs no network sync.
  function spawnSaved(x, y, sk, hr, id) {
    const W = authoritative ? S.world : (lastView && lastView.world) || S.world;
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
  function emitPhase() { cbs.onPhase && cbs.onPhase(S.phase); }

  // ---- Level control (the rules are in sim.js) ----------------------------
  function startLevel(idx) { S.startLevel(idx); }
  function hostStart() {
    if (!authoritative || S.phase !== Phase.LOBBY) return;
    beginGame(); startLevel(0); S.phase = Phase.INTRO; S.introTimer = 2.4; emitPhase(); pushState();
  }
  function toLobby() {
    S.levelIndex = 0; S.score = 0;
    for (const p of S.players.values()) { p.rescues = 0; p.score = 0; }
    S.phase = Phase.LOBBY; emitPhase(); emitRoster(); emitBoard(); pushState();
  }
  function advance() {
    if (!authoritative) return;
    if (S.phase === Phase.LOBBY) { hostStart(); return; }
    if (S.phase === Phase.INTRO) { if (mode === "solo") { S.phase = Phase.PLAY; emitPhase(); } return; }
    if (S.phase === Phase.CLEARED) { S.nextLevel(); return; }
    if (S.phase === Phase.OVER || S.phase === Phase.WIN) {
      if (mode === "solo" && !promoted) { beginGame(); startLevel(0); S.phase = Phase.INTRO; S.introTimer = 2.4; emitPhase(); }
      else toLobby();
    }
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

  // solo / host: step the sim. The local input is read inside the step (only
  // when the ring may move); a tapped dash is used up by any PLAY tick.
  function updateSim(dt) {
    const wasPlay = S.phase === Phase.PLAY;
    S.update(dt, localInput);
    if (wasPlay) dashTap = false;
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
    const sp = 300 * (selfPos.dashActive > 0 ? 2.1 : 1) * ((lastView.swamps || []).some((z) => inSwamp(selfPos.x, selfPos.y, z)) ? SWAMP_SLOW : 1);
    selfPos.x += input.dx * sp * dt; selfPos.y += input.dy * sp * dt;
    for (const o of (lastView.obstacles || [])) { const hit = circleHitsRect(selfPos.x, selfPos.y, selfPos.r, o); if (hit) { selfPos.x = hit.x; selfPos.y = hit.y; } }
    const w = lastView.world;
    selfPos.x = Math.max(selfPos.r, Math.min(w.w - selfPos.r, selfPos.x));
    whirlPull(selfPos, lastView.whirls || [], dt, WHIRL_PLAYER); // the whirlpool tugs at joiners too
    selfPos.y = Math.max(selfPos.r, Math.min(shoreY(w) - selfPos.r, selfPos.y));
    dashTap = false;
  }

  // ---- State sync ---------------------------------------------------------
  // The snapshot format is the wire protocol between host and joiners (who may
  // run an older or newer build for a few minutes after a deploy): keep it as is.
  function pushState() {
    if (!sendState) return;
    const L = levelParams(S.levelIndex, Math.max(1, S.players.size));
    const snap = {
      hostId: selfId, phase: S.phase, levelIndex: S.levelIndex, score: S.score, caught: S.caught, missed: S.missed, timeLeft: S.timeLeft,
      quota: S.phase === Phase.LOBBY ? 0 : L.quota, allowedMisses: L.allowedMisses, world: S.world, introTimer: S.introTimer,
      obstacles: S.obstacles.map((o) => [o.x, o.y, o.w, o.h]),
      swamps: S.swamps.map((z) => [z.x, z.y, z.w, z.h]),
      whirls: S.whirls.map((z) => [Math.round(z.x), Math.round(z.y), Math.round(z.r)]),
      swimmers: S.swimmers.map((s) => [s.id, Math.round(s.x), Math.round(s.y), s.r, +(s.life / s.maxLife).toFixed(2), s.sk, s.hr, +Math.min(1, (s.chomp || 0) / EAT_DWELL).toFixed(2)]),
      monsters: S.monsters.map((m) => [m.id, Math.round(m.x), Math.round(m.y), +m.dir.toFixed(2), m.r, +(m.sub || 0).toFixed(2)]),
      players: [...S.players.values()].map((p) => [p.id, Math.round(p.x), Math.round(p.y), p.name, p.dashActive > 0 ? 1 : 0, p.hue, p.rescues || 0, p.stunned ? 1 : 0, p.score || 0]),
      fx: S.fxOut,
      // joiners only ever see team games, so send the top team entries (not solo runs)
      board: (S.phase === Phase.LOBBY || S.phase === Phase.OVER || S.phase === Phase.WIN) ? board.filter((e) => e.n >= 2).slice(0, BOARD_SHOW) : undefined,
    };
    S.fxOut = [];
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
      swamps: (d.swamps || []).map((z) => ({ x: z[0], y: z[1], w: z[2], h: z[3] })),
      whirls: (d.whirls || []).map((z) => ({ x: z[0], y: z[1], r: z[2] })),
    };
    if (d.board) netBoard = d.board;
    lastView.board = netBoard;
    const seen = new Set();
    for (const s of d.swimmers || []) {
      seen.add(s[0]);
      const cur = iSwim.get(s[0]) || { x: s[1], y: s[2] };
      cur.tx = s[1]; cur.ty = s[2]; cur.r = s[3]; cur.frac = s[4]; cur.sk = s[5]; cur.hr = s[6]; cur.ch = s[7] || 0;
      if (cur.x === undefined) { cur.x = s[1]; cur.y = s[2]; }
      iSwim.set(s[0], cur);
    }
    for (const id of [...iSwim.keys()]) if (!seen.has(id)) iSwim.delete(id);
    const seenM = new Set();
    for (const m of d.monsters || []) {
      seenM.add(m[0]);
      const cur = iMonster.get(m[0]) || { x: m[1], y: m[2] };
      cur.tx = m[1]; cur.ty = m[2]; cur.dir = m[3]; cur.r = m[4]; cur.sub = m[5] || 0; cur.wob = cur.wob || 0;
      if (cur.x === undefined) { cur.x = m[1]; cur.y = m[2]; }
      iMonster.set(m[0], cur);
    }
    for (const id of [...iMonster.keys()]) if (!seenM.has(id)) iMonster.delete(id);
    const seenP = new Set();
    for (const p of d.players || []) {
      seenP.add(p[0]);
      const cur = iPlayer.get(p[0]) || { x: p[1], y: p[2] };
      cur.id = p[0]; cur.tx = p[1]; cur.ty = p[2]; cur.name = p[3]; cur.dash = p[4]; cur.hue = p[5]; cur.rescues = p[6] || 0; cur.stun = p[7] || 0; cur.score = p[8] || 0;
      if (cur.x === undefined) { cur.x = p[1]; cur.y = p[2]; }
      iPlayer.set(p[0], cur);
    }
    for (const id of [...iPlayer.keys()]) if (!seenP.has(id)) iPlayer.delete(id);
    for (const e of d.fx || []) { jSplashes.push({ x: e[0], y: e[1], t: 0, good: e[2] === 1 }); if (e[2] === 1) { sRescue(); spawnSaved(e[0], e[1], e[3], e[4], e[5]); } else (e[2] === 2 ? sChomp : sMiss)(); }
    if (!selfPos.seeded && d.phase === Phase.PLAY) { const meP = (d.players || []).find((p) => p[0] === selfId); if (meP) { selfPos.x = meP[1]; selfPos.y = meP[2]; selfPos.seeded = true; selfPos.stun = 0; selfPos.stunCd = 0; } }
    if (d.phase === Phase.LOBBY || d.phase === Phase.INTRO) selfPos.seeded = false;
    if (prevPhase !== d.phase) { if (d.phase === Phase.INTRO || d.phase === Phase.LOBBY) { saved = []; levelStartScore = new Map((d.players || []).map((p) => [p[0], p[8] || 0])); } if (d.phase === Phase.PLAY) { jLastSec = Math.ceil(d.timeLeft); sStart(); } else if (d.phase === Phase.CLEARED) sClear(); else if (d.phase === Phase.OVER) sOver(); else if (d.phase === Phase.WIN) sWin(); cbs.onPhase && cbs.onPhase(d.phase); }
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
    S.world = v.world; S.obstacles = v.obstacles.map((o) => ({ ...o })); S.swamps = (v.swamps || []).map((z) => ({ ...z })); S.whirls = (v.whirls || []).map((z) => ({ ...z }));
    S.levelIndex = v.levelIndex; S.score = v.score; S.caught = v.caught; S.missed = v.missed; S.timeLeft = v.timeLeft; S.phase = v.phase;
    const L = levelParams(S.levelIndex, Math.max(1, iPlayer.size));
    S.players = new Map();
    for (const [id, p] of iPlayer) {
      if (id === v.hostId) continue;
      S.players.set(id, { id, name: id === selfId ? myName : (p.name || "Spelare"), x: id === selfId ? selfPos.x : p.x, y: id === selfId ? selfPos.y : p.y, r: 30, hue: p.hue, dashActive: 0, dashCooldown: 0, rescues: p.rescues || 0, input: { dx: 0, dy: 0, dash: false } });
    }
    if (!S.players.has(selfId)) addPlayer(selfId, myName);
    S.swimmers = [];
    for (const [id, s] of iSwim) { const ang = Math.random() * Math.PI * 2; S.swimmers.push({ id, x: s.x, y: s.y, r: s.r || 16, vx: Math.cos(ang) * L.speed, vy: Math.sin(ang) * L.speed, life: (s.frac || 1) * L.sink, maxLife: L.sink, bob: Math.random() * 6, sk: s.sk || 0, hr: s.hr || 0 }); S.swimmerSeq = Math.max(S.swimmerSeq, id + 1); }
    sendState = (snap) => { try { A.st[0](snap); } catch {} };
    A.hi[1]((data, peer) => { const p = S.players.get(peer); if (p) renamePlayer(peer, (data && data.name) || p.name); else addPlayer(peer, (data && data.name) || "Spelare"); emitRoster(); pushState(); });
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
        world: lastView.world, obstacles: lastView.obstacles, swamps: lastView.swamps || [], whirls: lastView.whirls || [],
        swimmers: [...iSwim.values()], monsters: [...iMonster.values()],
        players: [...iPlayer.values()].map((p) => p.id === selfId ? { ...p, x: selfPos.x, y: selfPos.y } : p),
        splashes: jSplashes,
        hud: { score: lastView.score, yourScore: (iPlayer.get(selfId) || {}).score || 0, level: lastView.levelIndex, caught: lastView.caught, quota: lastView.quota, missed: lastView.missed, allowedMisses: lastView.allowedMisses, n: iPlayer.size },
        phase: lastView.phase, introTimer: lastView.introTimer, board: lastView.board || [],
      };
    }
    const L = levelParams(S.levelIndex, Math.max(1, S.players.size));
    return { world: S.world, obstacles: S.obstacles, swamps: S.swamps, whirls: S.whirls, swimmers: S.swimmers, monsters: S.monsters, players: [...S.players.values()], splashes: S.splashes, hud: { score: S.score, yourScore: (S.players.get(selfId) || {}).score || 0, level: S.levelIndex, caught: S.caught, quota: L.quota, missed: S.missed, allowedMisses: L.allowedMisses, n: S.players.size }, phase: S.phase, introTimer: S.introTimer, board };
  }

  // ---- Loop ---------------------------------------------------------------
  let last = performance.now();
  function frame(now) {
    let dt = (now - last) / 1000; last = now; if (dt > 0.05) dt = 0.05;
    R.beginFrame(dt); // animation clock, clickable buttons reset, backing store
    if (authoritative) updateSim(dt); else updateJoin(dt);
    updateSaved(dt);
    if (!authoritative && lastView) {
      const t = performance.now(); if (t - lastStateTime > 3000) { if (!electing) electHost(); else if (t - electAt > 4000) electing = false; }
    }
    R.render();
    requestAnimationFrame(frame);
  }

  // ---- Input wiring -------------------------------------------------------
  const MOVE_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " ", "Space"]);
  addEventListener("keydown", (e) => {
    if (isTextField(e.target)) return; // (no text field shows during a game, but never steal typing)
    const k = e.key === " " ? "Space" : e.key; keys[k] = true;
    if (MOVE_KEYS.has(e.key) || MOVE_KEYS.has(k)) e.preventDefault();
    if (e.repeat) return;
    if (k === "Enter") advance(); // Space is the dash key, so it must not also skip the level board
    if (k === "m" || k === "M") toggleMute();
  }, { passive: false });
  addEventListener("keyup", (e) => { const k = e.key === " " ? "Space" : e.key; keys[k] = false; });
  // A key or finger released while the window had no focus never reports its
  // keyup/touchend: let go of everything when focus or visibility goes.
  function releaseInput() { for (const k in keys) keys[k] = false; pointerTarget = null; dashTap = false; }
  addEventListener("blur", releaseInput);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { releaseInput(); return; }
    // back from the background: the host's state stopped arriving only because
    // this page was frozen, so give it a moment before calling an election
    if (!authoritative && lastView) lastStateTime = Math.max(lastStateTime, performance.now());
  });

  function toCanvas(clientX, clientY) { const r = canvas.getBoundingClientRect(); return { x: (clientX - r.left) * (CW / r.width), y: (clientY - r.top) * (CH / r.height) }; }
  function inDash(cx, cy) { return Math.hypot(cx - DASH_BTN.x, cy - DASH_BTN.y) <= DASH_BTN.r; }
  function inMute(cx, cy) { return Math.hypot(cx - MUTE_BTN.x, cy - MUTE_BTN.y) <= MUTE_BTN.r + 8; }
  // Host ends the round for everyone: all players land on the scores screen.
  function quitGame() {
    if (!authoritative) return;
    if (S.phase !== Phase.PLAY && S.phase !== Phase.INTRO && S.phase !== Phase.CLEARED) return;
    S.phase = Phase.OVER; recordResult(); sOver(); emitPhase(); pushState();
  }
  function inQuit(cx, cy) { const b = QUIT_BTN; return authoritative && cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h; }
  function pressQuit() { const now = performance.now(); if (quitArmedUntil > now) { quitArmedUntil = 0; quitGame(); } else quitArmedUntil = now + 3000; }
  function toggleMute() { muted = !muted; try { localStorage.setItem("livboj-muted", muted ? "1" : "0"); } catch {} if (!muted) unlockAudio(); }
  function curWorld() { return authoritative ? S.world : (lastView && lastView.world) || S.world; }
  function curPhase() { return authoritative ? S.phase : (lastView && lastView.phase); }
  canvas.addEventListener("mousedown", (e) => { const c = toCanvas(e.clientX, e.clientY); if (inMute(c.x, c.y)) toggleMute(); else if (inQuit(c.x, c.y)) pressQuit(); else if (inLeave(c.x, c.y)) leaveToStart(); else if (inAction(c.x, c.y)) advance(); }, { passive: true });
  canvas.addEventListener("touchstart", (e) => {
    usingTouch = true; e.preventDefault();
    for (const t of e.changedTouches) {
      const c = toCanvas(t.clientX, t.clientY);
      if (inMute(c.x, c.y)) { toggleMute(); continue; }
      if (inQuit(c.x, c.y)) { pressQuit(); continue; }
      if (inLeave(c.x, c.y)) { leaveToStart(); continue; }
      const ph = curPhase();
      if (ph === Phase.CLEARED || ph === Phase.OVER || ph === Phase.WIN || ph === Phase.LOBBY) { advance(); continue; }
      if (inDash(c.x, c.y)) dashTap = true; else pointerTarget = R.toWorld(c.x, c.y, curWorld().w, curWorld().h);
    }
  }, { passive: false });
  canvas.addEventListener("touchmove", (e) => { e.preventDefault(); for (const t of e.changedTouches) { const c = toCanvas(t.clientX, t.clientY); if (!inDash(c.x, c.y) && !inMute(c.x, c.y)) pointerTarget = R.toWorld(c.x, c.y, curWorld().w, curWorld().h); } }, { passive: false });
  const touchEnd = (e) => { e.preventDefault(); if (e.touches.length === 0) pointerTarget = null; };
  canvas.addEventListener("touchend", touchEnd, { passive: false });
  canvas.addEventListener("touchcancel", touchEnd, { passive: false }); // (a system gesture or an alert took the finger)

  // ---- Boot ---------------------------------------------------------------
  if (mode === "solo") { setupSolo(); initGlobalBoard(); }
  else if (mode === "host") { setupNet(true); initGlobalBoard(); }
  else setupNet(false);
  requestAnimationFrame(frame);

  return {
    hostStart, getRoom: () => opts.room, relay: () => (room && room.stats ? room.stats() : null), roster: rosterList, clearBoard, quitGame, netStatus, netSummary,
    board: () => ({ source: boardSource, entries: board.slice(0, BOARD_SHOW) }),
    signaling: () => (RELAY_URL ? "" : (SIGNAL.resolved ? SIGNAL.name : "")),
    _jump: (idx) => { if (authoritative) { S.levelIndex = Math.max(0, Math.min(BASE_LEVELS.length - 1, idx | 0)); startLevel(S.levelIndex); S.phase = Phase.PLAY; emitPhase(); pushState(); } },
    debug: () => ({
      authoritative, promoted,
      phase: authoritative ? S.phase : (lastView && lastView.phase),
      timeLeft: Math.round(authoritative ? S.timeLeft : (lastView ? lastView.timeLeft : -1)),
      n: authoritative ? S.players.size : iPlayer.size, hasState: !!lastView,
      caught: authoritative ? S.caught : (lastView ? lastView.caught : 0),
      level: authoritative ? S.levelIndex : (lastView ? lastView.levelIndex : 0),
      monsters: authoritative ? S.monsters.length : iMonster.size,
      rescues: [...(authoritative ? S.players.values() : iPlayer.values())].map((p) => ({ you: p.id === selfId, r: p.rescues || 0 })),
      sw: authoritative ? S.swimmers.map((s) => [Math.round(s.x), Math.round(s.y)]) : [...iSwim.values()].map((s) => [Math.round(s.x), Math.round(s.y)]),
      self: { x: Math.round(selfPos.x), y: Math.round(selfPos.y) },
      players: [...(authoritative ? S.players.values() : iPlayer.values())].map((p) => ({ you: p.id === selfId, name: p.name, x: Math.round(p.x), y: Math.round(p.y) })),
      mon: (authoritative ? S.monsters : [...iMonster.values()]).map((m) => [Math.round(m.x), Math.round(m.y), m.r || 30, +(m.dir || 0).toFixed(3), +(m.sub || 0).toFixed(2)]),
      swamp: (authoritative ? S.swamps : (lastView && lastView.swamps) || []).map((z) => [Math.round(z.x), Math.round(z.y), Math.round(z.w), Math.round(z.h)]),
      obstacles: (authoritative ? S.obstacles : (lastView && lastView.obstacles) || []).map((o) => [Math.round(o.x), Math.round(o.y), Math.round(o.w), Math.round(o.h)]),
      whirls: (authoritative ? S.whirls : (lastView && lastView.whirls) || []).map((z) => [Math.round(z.x), Math.round(z.y), Math.round(z.r)]),
      missed: authoritative ? S.missed : (lastView ? lastView.missed : 0),
      saved: saved.length, quitBtn: QUIT_BTN, actionBtn: R.actionBtn(), leaveBtn: R.leaveBtn(),
    }),
  };
}

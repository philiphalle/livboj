// Livbojen — networking: the room transports (the WebSocket relay, or
// Trystero P2P over WebRTC as the fallback) and the relay's HTTP endpoints
// (the global leaderboard with its localStorage outbox, the Förslagslåda).
//
// Host-authoritative co-op over WebRTC P2P (Trystero, Nostr signaling), with
// STUN+TURN for NAT traversal and host migration if the host leaves.
// Three signaling strategies (all public, no account). The game probes which
// one this network can actually reach and joins through that — corporate
// networks often block one set of hosts but not another.
import * as NOSTR from "https://cdn.jsdelivr.net/npm/trystero@0.21.5/nostr/+esm";
import * as MQTT from "https://cdn.jsdelivr.net/npm/trystero@0.21.5/mqtt/+esm";
import * as TORRENT from "https://cdn.jsdelivr.net/npm/trystero@0.21.5/torrent/+esm";
export const initialSelfId = NOSTR.selfId; // game.js re-points its selfId to the chosen strategy's id before any use
export const SIGNAL = { name: "nostr", mod: NOSTR };
export const getRelaySockets = () => (SIGNAL.mod && typeof SIGNAL.mod.getRelaySockets === "function" ? SIGNAL.mod.getRelaySockets() : {});
export function pickSignaling(timeoutMs = 4500) {
  const cands = [
    // Probe every relay of a strategy (any one opening is enough): the list's
    // first few Nostr relays are often dead while later ones are fine.
    { name: "nostr", mod: NOSTR, urls: NOSTR.defaultRelayUrls || [] },
    { name: "mqtt", mod: MQTT, urls: MQTT.defaultRelayUrls || ["wss://broker.hivemq.com:8884/mqtt", "wss://broker.emqx.io:8084/mqtt"] },
    { name: "torrent", mod: TORRENT, urls: TORRENT.defaultTrackerUrls || TORRENT.defaultRelayUrls || ["wss://tracker.openwebtorrent.com", "wss://tracker.webtorrent.dev"] },
  ];
  // Sequential, Nostr-first: only fall back when the preferred strategy's
  // signaling can't be reached. (A pure race picked whichever broker answered
  // first, which split peers across strategies.) `forced` skips the probe.
  const forced = cands.find((c) => c.name === arguments[1]);
  if (forced) return Promise.resolve(forced);
  const probe = (urls, ms) => new Promise((resolve) => {
    let done = false, pending = urls.length; const socks = [];
    const finish = (ok) => { if (done) return; done = true; for (const s of socks) { try { s.close(); } catch {} } resolve(ok); };
    if (!pending) return finish(false);
    for (const u of urls) { try { const s = new WebSocket(u); socks.push(s); s.onopen = () => finish(true); s.onerror = () => { if (--pending <= 0) finish(false); }; } catch { if (--pending <= 0) finish(false); } }
    setTimeout(() => finish(false), ms);
  });
  return (async () => { for (const c of cands) { if (await probe(c.urls, timeoutMs)) return c; } return cands[0]; })();
}

export const APP_ID = "livboj-bookbeat-9f3a";

// STUN + a public best-effort TURN relay so most NATs can connect without setup.
// Optional WebSocket relay (see relay/README.md), for networks that block
// peer-to-peer/WebRTC — most offices. Set it here, or per session via
// ?relay=wss://… (the host's invite link carries it along to joiners).
// Default transport: the WebSocket relay (works on office networks that block
// WebRTC). ?relay=wss://… overrides it; ?relay=off forces plain P2P.
const RELAY_DEFAULT = "wss://livboj-relay.livboj.workers.dev";
export const RELAY_URL = (() => {
  try {
    const q = new URLSearchParams(location.search).get("relay");
    if (q === null || q === "") return RELAY_DEFAULT;
    return /^(off|p2p|0|none)$/i.test(q) ? "" : q;
  } catch { return RELAY_DEFAULT; }
})();
// Optional forced signaling strategy (?sig=nostr|mqtt|torrent). The host's
// invite link carries its resolved choice so joiners land on the same one.
export const SIG_PARAM = (() => { try { return new URLSearchParams(location.search).get("sig") || ""; } catch { return ""; } })();

export const RTC = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun.relay.metered.ca:80" },
    { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
  ],
};

// ---- Relay transport: same surface as a Trystero room (tuple actions,
// onPeerJoin/Leave, getPeers) but over one plain WebSocket to the relay.
//
// Reconnects with a short backoff, and also on purpose: when the page comes
// back after more than 5 s in the background (iOS keeps dead sockets "OPEN")
// and when the browser comes back online. The relay keeps one socket per
// connection, not per id, so a reconnect is seen by everyone else as a join
// (ignored: already known) and, whenever the old socket finally closes on the
// server, a leave for the same id. A leave therefore only counts after a
// short grace period, during which we ask the room whether that id is still
// here ("_who"); its answer ("_here") — or any message or join from it —
// cancels the leave. So a reconnect never drops a player from the roster and
// never starts a host election. ("_who"/"_here" are relay-transport only;
// older clients ignore unknown actions.)
export function relayJoin(url, roomId, selfId) {
  const BACKOFF = [400, 1000, 2000, 4000, 6000], KEEPALIVE_MS = 25000, LEAVE_GRACE_MS = 2500;
  const handlers = new Map(); const peers = new Set(); const queue = []; const pendingLeave = new Map();
  let joinCb = () => {}, leaveCb = () => {}, ws = null, open = false, closed = false, tries = 0, retry = 0, hiddenAt = 0, lastHere = 0;
  // counters for tests (window.livboj.relay()): per action, [messages, bytes] sent and received; every
  // close (code, whether it had opened) and connects that never opened (a refused upgrade, a dead network)
  const stats = { connects: 0, forced: 0, sent: {}, recv: {}, closes: [], failed: 0 };
  const count = (box, a, len) => { const c = box[a] || (box[a] = [0, 0]); c[0]++; c[1] += len; };
  const addPeer = (id) => { if (!id || id === selfId) return; cancelLeave(id); if (!peers.has(id)) { peers.add(id); joinCb(id); } };
  function cancelLeave(id) { const t = pendingLeave.get(id); if (t) { clearTimeout(t); pendingLeave.delete(id); } }
  function deferLeave(id) {
    if (!id || id === selfId || !peers.has(id) || pendingLeave.has(id)) return;
    pendingLeave.set(id, setTimeout(() => { pendingLeave.delete(id); if (peers.delete(id)) leaveCb(id); }, LEAVE_GRACE_MS));
    sendRaw({ t: "msg", a: "_who", d: { id } });
  }
  const sayHere = () => { const now = performance.now(); if (now - lastHere < 300) return; lastHere = now; sendRaw({ t: "msg", a: "_here", d: {} }); };
  function drop() { const s = ws; ws = null; open = false; if (s) { s.onopen = s.onmessage = s.onclose = s.onerror = null; try { s.close(); } catch {} } }
  function later() {
    if (closed) return;
    clearTimeout(retry);
    const ms = BACKOFF[Math.min(tries++, BACKOFF.length - 1)];
    retry = setTimeout(() => connect(false), document.hidden ? Math.max(ms, 3000) : ms);
  }
  function connect(force) {
    if (closed) return;
    clearTimeout(retry);
    if (!force && ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    if (force) stats.forced++;
    drop(); // the old socket's handlers are detached first: its late onclose can't schedule another connect
    let sock;
    try { sock = new WebSocket(`${url.replace(/\/$/, "")}/room/${encodeURIComponent(roomId)}?id=${encodeURIComponent(selfId)}`); }
    catch { later(); return; }
    ws = sock; stats.connects++;
    let opened = false;
    sock.onopen = () => { if (sock !== ws) return; open = opened = true; for (const q of queue) { sock.send(q.s); count(stats.sent, q.a, q.s.length); } queue.length = 0; };
    sock.onmessage = (e) => {
      if (sock !== ws) return;
      let m; try { m = JSON.parse(e.data); } catch { return; }
      count(stats.recv, m.t === "msg" ? m.a : m.t, typeof e.data === "string" ? e.data.length : 0);
      if (m.t === "welcome") {
        tries = 0;
        const here = new Set((m.peers || []).filter((id) => id !== selfId)); // (a stale socket of ours may still be listed)
        for (const id of here) addPeer(id);
        for (const id of [...peers]) if (!here.has(id)) deferLeave(id); // left while we were away (or a stale entry)
        if (stats.connects > 1) { sayHere(); setTimeout(sayHere, 1200); } // cover our old socket's leave reaching the others late
      } else if (m.t === "peer") {
        if (m.id === selfId) return; // our own old socket coming or going
        if (m.join) addPeer(m.id); else deferLeave(m.id);
      } else if (m.t === "msg") {
        if (!m.from || m.from === selfId) return;
        addPeer(m.from); // anything from a peer proves it is here
        if (m.a === "_who") { if (m.d && m.d.id === selfId) sayHere(); return; }
        if (m.a === "_here") return;
        const cb = handlers.get(m.a); if (cb) cb(m.d, m.from);
      }
    };
    sock.onclose = (e) => {
      if (stats.closes.length < 50) stats.closes.push({ code: e && e.code, opened, at: Math.round(performance.now()) });
      if (!opened) stats.failed++;
      if (sock !== ws) return; ws = null; open = false; later();
    };
    sock.onerror = () => {}; // onclose follows
  }
  const onVisible = () => {
    if (closed) return;
    if (document.hidden) { hiddenAt = hiddenAt || performance.now(); return; }
    const away = hiddenAt ? performance.now() - hiddenAt : 0; hiddenAt = 0;
    if (away > 5000) connect(true); else if (!open) connect(false);
  };
  const onPageShow = (e) => { if (!closed && e.persisted) connect(true); }; // back from the bfcache
  const onOnline = () => { if (!closed) connect(true); };
  document.addEventListener("visibilitychange", onVisible);
  addEventListener("pageshow", onPageShow);
  addEventListener("online", onOnline);
  const ka = setInterval(() => { if (open && ws) { try { ws.send('{"t":"ka"}'); count(stats.sent, "ka", 10); } catch {} } }, KEEPALIVE_MS); // the relay ignores it; keeps NATs / radios from dropping an idle socket
  connect(false);
  // While (re)connecting, messages wait in the queue. Of the state and the position only the newest
  // is worth sending (a stale burst would only spend the relay's request budget); a dropped state's
  // one-off events (fx: rescues, misses) ride along with the newer one.
  function sendRaw(o) {
    const a = o.a || o.t;
    if (open && ws) { const s = JSON.stringify(o); try { ws.send(s); count(stats.sent, a, s.length); } catch {} return; }
    if (a === "st" || a === "inp") {
      const i = queue.findIndex((q) => q.a === a && q.to === o.to);
      if (i >= 0) {
        const old = queue.splice(i, 1)[0].o;
        if (a === "st" && o.d && old.d && Array.isArray(old.d.fx) && old.d.fx.length) o = { ...o, d: { ...o.d, fx: [...old.d.fx, ...(o.d.fx || [])] } };
      }
    }
    if (queue.length < 60) queue.push({ s: JSON.stringify(o), a, to: o.to, o });
  }
  return {
    // send(d) goes to everyone in the room; send(d, id) only to that peer (the relay's `to`; an
    // older relay ignores it and broadcasts, so no receiver may count on not getting a message).
    // The same call shape as Trystero's send(data, targetPeers).
    makeAction: (name) => [(d, to) => sendRaw(typeof to === "string" && to ? { t: "msg", a: name, d, to } : { t: "msg", a: name, d }), (cb) => handlers.set(name, cb)],
    onPeerJoin: (cb) => { joinCb = cb; }, onPeerLeave: (cb) => { leaveCb = cb; },
    getPeers: () => Object.fromEntries([...peers].map((p) => [p, true])),
    isOpen: () => open,
    reconnect: () => connect(true),
    stats: () => ({ ...stats, sent: { ...stats.sent }, recv: { ...stats.recv }, closes: stats.closes.slice(), open, peers: [...peers], pendingLeaves: pendingLeave.size }),
    leave: () => {
      closed = true; clearTimeout(retry); clearInterval(ka);
      for (const t of pendingLeave.values()) clearTimeout(t); pendingLeave.clear();
      document.removeEventListener("visibilitychange", onVisible); removeEventListener("pageshow", onPageShow); removeEventListener("online", onOnline);
      try { ws && ws.close(); } catch {}
    },
  };
}

// ---- Network diagnostics: signaling reachability + an ICE probe that tells
// whether STUN/TURN work from this network (shown in the lobby).
export function runIceProbe(iceProbe) {
  try {
    const pc = new RTCPeerConnection(RTC); pc.createDataChannel("probe");
    pc.onicecandidate = (e) => {
      if (!e.candidate) { iceProbe.done = true; try { pc.close(); } catch {} return; }
      const c = e.candidate.candidate || "";
      if (/ typ host/.test(c)) iceProbe.host++; else if (/ typ srflx/.test(c)) iceProbe.srflx++; else if (/ typ relay/.test(c)) iceProbe.relay++;
    };
    pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => { iceProbe.done = true; });
    setTimeout(() => { iceProbe.done = true; try { pc.close(); } catch {} }, 6000);
  } catch { iceProbe.done = true; }
}

// ---- Leaderboard ----------------------------------------------------------
// Global list on the relay (GET/POST /board), with the host's localStorage as
// cache and offline fallback. Entries carry a stable id so re-posting (e.g.
// the one-time upload of an old local list) never duplicates.
export const RELAY_HTTP = RELAY_URL ? RELAY_URL.replace(/^ws(s?):\/\//, "http$1://").replace(/\/$/, "") : "";
export function loadBoard() { try { return JSON.parse(localStorage.getItem("livboj-leaderboard") || "[]").map(withEntryId); } catch { return []; } }
export function saveBoardLS(b) { try { localStorage.setItem("livboj-leaderboard", JSON.stringify(b.slice(0, 50))); } catch {} }
export function withEntryId(e) { return e.id ? e : { ...e, id: `${e.ts}-${e.score}-${e.level}-${(e.players || []).map((p) => (typeof p === "string" ? p : p.name)).join("+")}`.slice(0, 48) }; }
export const sortBoard = (b) => b.sort((a, c) => c.score - a.score || c.ts - a.ts);
// { entries: top list, recent: every result from the last week } — or null when the relay can't be reached
export async function fetchGlobalBoardFull() {
  if (!RELAY_HTTP) return null;
  try { const r = await fetch(`${RELAY_HTTP}/board`, { cache: "no-store" }); if (!r.ok) return null; const d = await r.json(); return Array.isArray(d.entries) ? { entries: d.entries, recent: Array.isArray(d.recent) ? d.recent : [] } : null; } catch { return null; }
}
export async function fetchGlobalBoard() { const d = await fetchGlobalBoardFull(); return d ? d.entries : null; }
export async function postGlobalBoard(entries) {
  if (!RELAY_HTTP || !entries.length) return null;
  try { const r = await fetch(`${RELAY_HTTP}/board`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ entries }) }); if (!r.ok) return null; const d = await r.json(); return Array.isArray(d.entries) ? d.entries : null; } catch { return null; }
}
// Outbox for finished games: a result goes into localStorage first and leaves
// it only once the relay has taken it (or refused it with a 4xx), so a result
// survives a dead network, a closed tab or a crash. Flushed when a game ends,
// on every page load and when the browser comes back online. The relay dedupes
// by entry id, so a re-sent entry can never appear twice.
const QUEUE_KEY = "livboj-board-queue";
const loadQueue = () => { try { const q = JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); return Array.isArray(q) ? q : []; } catch { return []; } };
const saveQueue = (q) => { try { if (q.length) localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-100))); else localStorage.removeItem(QUEUE_KEY); } catch {} };
export function queueResult(entry) { if (!RELAY_HTTP) return; const q = loadQueue(); if (!q.some((e) => e.id === entry.id)) { q.push(entry); saveQueue(q); } }
let flushing = null;
// -> the merged global list after a successful post, else null (the queue keeps what was not taken)
export function flushBoardQueue() {
  if (!RELAY_HTTP) return Promise.resolve(null);
  if (flushing) return flushing.then((m) => (loadQueue().length ? flushBoardQueue() : m)); // a result queued mid-flight goes next
  const batch = loadQueue().slice(0, 50);
  if (!batch.length) return Promise.resolve(null);
  flushing = (async () => {
    for (let k = 0; k < 2; k++) {
      if (k) await new Promise((r) => setTimeout(r, 2000)); // one retry, shortly after
      let r;
      try { r = await fetch(`${RELAY_HTTP}/board`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ entries: batch }), keepalive: true }); } catch { continue; } // offline: retry once
      const sent = new Set(batch.map((e) => e.id));
      if (r.status >= 400 && r.status < 500) { saveQueue(loadQueue().filter((e) => !sent.has(e.id))); return null; } // refused: drop, no retry loop
      if (!r.ok) continue;
      saveQueue(loadQueue().filter((e) => !sent.has(e.id)));
      try { const d = await r.json(); return Array.isArray(d.entries) ? d.entries : null; } catch { return null; }
    }
    return null;
  })().finally(() => { flushing = null; });
  return flushing;
}
// Förslagslåda: one suggestion to the relay (POST /forslag). -> "ok" | "slow" (throttled) | "error"
// (any other answer, e.g. a 404 from a relay without the endpoint, is "error": the page keeps the text)
export async function postForslag(text, name) {
  if (!RELAY_HTTP) return "error";
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(`${RELAY_HTTP}/forslag`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: String(text || "").slice(0, 500), name: String(name || "").slice(0, 14) }), signal: ctl.signal });
    if (r.status === 429) return "slow";
    if (!r.ok) return "error";
    const d = await r.json().catch(() => null);
    return d && d.ok ? "ok" : "error";
  } catch { return "error"; } finally { clearTimeout(t); }
}
// whatever an earlier page load could not deliver
flushBoardQueue();
addEventListener("online", () => { flushBoardQueue(); });

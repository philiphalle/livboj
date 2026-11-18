// Livbojen relay — a minimal WebSocket room relay + a global leaderboard on
// Cloudflare Workers + Durable Objects. The game stays host-authoritative;
// the relay only forwards messages between the players in a room and keeps
// one shared list of results. Rooms use the WebSocket Hibernation API so an
// idle room costs nothing.
//
// Rooms:   wss://<worker-host>/room/<CODE>?id=<clientId>
//   Server -> client:
//     { t: "welcome", id, peers: [ids already in the room] }
//     { t: "peer", id, join: true|false }
//     { t: "msg", a: <action>, from: <id>, d: <payload> }
//   Client -> server:
//     { t: "msg", a: <action>, d: <payload> }   (broadcast to everyone else)
//     { t: "msg", a: <action>, d: <payload>, to: <id> }   (only to that id's socket(s);
//        an id not in the room: dropped. Older relays ignore `to` and broadcast — the
//        clients cope with both: a receiver never relies on not getting a message.)
//
// Leaderboard:
//   GET  /board                      -> { entries: [top 50] }
//   POST /board  { entries: [...] }  -> merges (dedupe by id; a per-game id keeps the further copy), returns { entries }
//   DELETE /board?key=<ADMIN_KEY>    -> wipes it (only if the ADMIN_KEY secret is set)
//
// Förslagslåda (suggestion box, kept in the same Board object under its own key):
//   POST   /forslag  { text, name? }            -> { ok: true }   (never returns suggestions)
//   GET    /forslag?key=<ADMIN_KEY>             -> { items: [newest first] }
//   DELETE /forslag?key=<ADMIN_KEY>[&id=<id>]   -> removes one, or all
//
// Anonymous daily counters (same Board object, one storage key per day, "stat:YYYY-MM-DD"):
//   POST /stat  { e: "<event>", n?: <players> }  -> { ok: true }   (any content type: a sendBeacon works)
//   GET  /stat?key=<ADMIN_KEY>[&days=30]         -> { days: [newest first] }

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...CORS } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/board" || url.pathname === "/forslag" || url.pathname === "/stat") return env.BOARD.get(env.BOARD.idFromName("global")).fetch(request);
    const m = url.pathname.match(/^\/room\/([A-Za-z0-9]{3,8})$/);
    if (!m) return new Response("livboj relay ok", { headers: { "content-type": "text/plain", ...CORS } });
    const id = env.ROOM.idFromName(m[1].toUpperCase());
    return env.ROOM.get(id).fetch(request);
  },
};

export class Room {
  constructor(state) { this.state = state; }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const pid = (new URL(request.url).searchParams.get("id") || crypto.randomUUID()).slice(0, 64);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server, [pid]);
    const others = this.state.getWebSockets().filter((ws) => ws !== server).map((ws) => this.state.getTags(ws)[0]);
    server.send(JSON.stringify({ t: "welcome", id: pid, peers: others }));
    this.broadcast({ t: "peer", id: pid, join: true }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    let m; try { m = JSON.parse(message); } catch { return; }
    if (!m || m.t !== "msg") return;
    const out = { t: "msg", a: m.a, from: this.state.getTags(ws)[0], d: m.d };
    // Directed: `to` (a peer id) goes only to that id's socket(s) — every one of them, since a
    // reconnecting client briefly has two. An id not in the room: dropped. No `to`: broadcast.
    if (typeof m.to === "string" && m.to) {
      const s = JSON.stringify(out);
      let targets = []; try { targets = this.state.getWebSockets(m.to.slice(0, 64)); } catch {}
      for (const t of targets) if (t !== ws) { try { t.send(s); } catch {} }
      return;
    }
    this.broadcast(out, ws);
  }
  webSocketClose(ws) { this.leave(ws); }
  webSocketError(ws) { this.leave(ws); }

  leave(ws) {
    const id = this.state.getTags(ws)[0];
    try { ws.close(); } catch {}
    this.broadcast({ t: "peer", id, join: false }, ws);
  }
  broadcast(obj, except) {
    const s = JSON.stringify(obj);
    for (const ws of this.state.getWebSockets()) if (ws !== except) { try { ws.send(s); } catch {} }
  }
}

// ---- Global leaderboard ----------------------------------------------------
const KEEP = 500;    // stored (by score)
const SHOW = 50;     // top entries returned
const RECENT_MS = 7 * 24 * 3600 * 1000, RECENT_MAX = 300; // also returned: every result from the last week (player of the day/week)
const MAX_POST = 60; // entries per POST (a host's whole local list fits)

const str = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
const int = (v, lo, hi) => (Number.isFinite(+v) ? Math.max(lo, Math.min(hi, Math.round(+v))) : null);

// Accepts an entry from the game, rejects anything malformed, and normalises
// the shape so every stored row looks the same.
function sanitize(e) {
  if (!e || typeof e !== "object") return null;
  const score = int(e.score, 0, 1_000_000), level = int(e.level, 1, 20), ts = int(e.ts, 0, 4_102_444_800_000);
  if (score === null || level === null || ts === null) return null;
  if (score === 0) return null; // a game with nothing rescued is not a result
  const players = Array.isArray(e.players)
    ? e.players.slice(0, 12).map((p) => (typeof p === "string" ? { name: str(p, 14), score: 0, rescues: 0 } : { name: str(p && p.name, 14) || "Spelare", score: int(p && p.score, 0, 1_000_000) || 0, rescues: int(p && p.rescues, 0, 100_000) || 0 }))
    : [];
  const id = str(e.id, 48) || `${ts}-${score}-${level}-${players.map((p) => p.name).join("+")}`.slice(0, 48);
  return {
    id, score, level, won: !!e.won, n: int(e.n, 1, 12) || players.length || 1, ts, team: str(e.team, 20), players,
    // extra stats (0 for entries from before they existed)
    duration: int(e.duration, 0, 86_400) || 0, rescued: int(e.rescued, 0, 100_000) || 0, combo: int(e.combo, 0, 100_000) || 0,
  };
}
const order = (a, b) => b.score - a.score || b.ts - a.ts;
// Merge by id: the copy already stored wins — except for a per-game id ("g<base36>-<base36>", from
// clients since 2026-11), where a copy that got further (more points, then a later level, then a
// longer time) replaces it. One game can arrive twice: the score so far when its last player left,
// then (that player came back after all) the final result. Every older id merges as it always did:
// first copy wins. (Those ids are built from the score itself, so two copies are identical anyway.)
const GAME_ID = /^g[0-9a-z]{4,12}-[0-9a-z]{4,12}$/;
const further = (a, b) => a.score - b.score || a.level - b.level || a.duration - b.duration;

// ---- Förslagslåda ----------------------------------------------------------
const FORSLAG_KEEP = 500, FORSLAG_TEXT = 500, FORSLAG_NAME = 14, FORSLAG_BODY = 4096, FORSLAG_GAP_MS = 10_000;
// control characters out (the text keeps its line breaks), then trimmed
const clean = (v, keepNewlines) => (typeof v === "string" ? v.replace(keepNewlines ? /[\u0000-\u0009\u000B-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g, keepNewlines ? (c) => (c === "\t" ? " " : "") : "").trim() : "");

// ---- Anonymous daily counters ----------------------------------------------
// One object per Stockholm calendar day under "stat:YYYY-MM-DD": event counts, and for mp_start a
// histogram by player count plus their running sum. Nothing else is stored: no IP, user agent, name,
// id or time finer than the day. The per-IP throttle lives in memory only (gone when the object sleeps).
const STAT_EVENTS = ["visit", "solo_start", "mp_start", "join", "solo_done", "mp_done", "solo_abandoned", "mp_abandoned"];
const STAT_BODY = 200, STAT_KEEP_DAYS = 400, STAT_WINDOW_MS = 60_000, STAT_PER_WINDOW = 60;
const DAY_FMT = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit" });
function stockholmDate(ms) { const p = Object.fromEntries(DAY_FMT.formatToParts(new Date(ms)).map((x) => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}`; }
function statRow(date, o = {}) {
  const row = { date };
  for (const k of STAT_EVENTS) row[k] = o[k] || 0;
  row.mp_players = o.mp_players || {}; row.mp_players_sum = o.mp_players_sum || 0;
  return row;
}

export class Board {
  constructor(state, env) { this.state = state; this.env = env; this.lastPost = new Map(); this.statHits = new Map(); }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/forslag") return this.forslag(request, url);
    if (url.pathname === "/stat") return this.stat(request, url);
    if (request.method === "GET") {
      const all = await this.all(), since = Date.now() - RECENT_MS;
      const recent = all.filter((e) => e.ts >= since).sort((a, b) => b.ts - a.ts).slice(0, RECENT_MAX);
      return json({ entries: all.slice(0, SHOW), recent });
    }
    if (request.method === "POST") {
      let body; try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
      const incoming = (Array.isArray(body && body.entries) ? body.entries : [body]).slice(0, MAX_POST).map(sanitize).filter(Boolean);
      const all = await this.all();
      const byId = new Map(all.map((e) => [e.id, e]));
      let added = 0, updated = 0;
      for (const e of incoming) {
        const cur = byId.get(e.id);
        if (!cur) { byId.set(e.id, e); added++; }
        else if (GAME_ID.test(e.id) && further(e, cur) > 0) { byId.set(e.id, e); updated++; }
      }
      const merged = [...byId.values()].sort(order).slice(0, KEEP);
      if (added || updated) await this.state.storage.put("entries", merged);
      const since = Date.now() - RECENT_MS;
      return json({ entries: merged.slice(0, SHOW), recent: merged.filter((e) => e.ts >= since).sort((a, b) => b.ts - a.ts).slice(0, RECENT_MAX), added, updated });
    }
    if (request.method === "DELETE") {
      const key = this.env.ADMIN_KEY;
      if (!key || url.searchParams.get("key") !== key) return json({ error: "forbidden" }, 403);
      // ?id=<entry id> removes one entry (tests, cheaters); without id the whole list.
      const id = url.searchParams.get("id");
      const kept = id ? (await this.all()).filter((e) => e.id !== id) : [];
      await this.state.storage.put("entries", kept);
      return json({ entries: kept.slice(0, SHOW) });
    }
    return json({ error: "method" }, 405);
  }
  async all() { return (await this.state.storage.get("entries")) || []; }

  admin(url) { const key = this.env.ADMIN_KEY; return !!key && url.searchParams.get("key") === key; }
  async forslag(request, url) {
    if (request.method === "POST") {
      if (+(request.headers.get("content-length") || 0) > FORSLAG_BODY) return json({ error: "too large" }, 413);
      const raw = await request.text();
      if (raw.length > FORSLAG_BODY) return json({ error: "too large" }, 413);
      let body; try { body = JSON.parse(raw); } catch { return json({ error: "bad json" }, 400); }
      if (!body || typeof body !== "object") return json({ error: "bad json" }, 400);
      const text = clean(body.text, true), name = clean(body.name, false).slice(0, FORSLAG_NAME);
      if (!text) return json({ error: "empty" }, 400);
      if (text.length > FORSLAG_TEXT) return json({ error: "too long" }, 400);
      // light throttle: one suggestion per IP per 10 s (in memory: resets when the object sleeps, which is fine)
      const ip = request.headers.get("cf-connecting-ip") || "?", now = Date.now();
      if (now - (this.lastPost.get(ip) || 0) < FORSLAG_GAP_MS) return json({ error: "slow down" }, 429);
      this.lastPost.set(ip, now);
      if (this.lastPost.size > 1000) for (const [k, t] of this.lastPost) if (now - t > FORSLAG_GAP_MS) this.lastPost.delete(k);
      const items = (await this.state.storage.get("forslag")) || [];
      items.push({ id: crypto.randomUUID(), ts: now, text, name });
      await this.state.storage.put("forslag", items.slice(-FORSLAG_KEEP));
      return json({ ok: true });
    }
    if (request.method === "GET") {
      if (!this.admin(url)) return json({ error: "forbidden" }, 403);
      const items = (await this.state.storage.get("forslag")) || [];
      return json({ items: items.slice().reverse() });
    }
    if (request.method === "DELETE") {
      if (!this.admin(url)) return json({ error: "forbidden" }, 403);
      const id = url.searchParams.get("id");
      const kept = id ? ((await this.state.storage.get("forslag")) || []).filter((e) => e.id !== id) : [];
      await this.state.storage.put("forslag", kept);
      return json({ ok: true, left: kept.length });
    }
    return json({ error: "method" }, 405);
  }

  // POST /stat { e, n? }: +1 for that event on today's (Stockholm) row. The body is read as text
  // whatever its content type, so a sendBeacon / text/plain POST works without a preflight.
  async stat(request, url) {
    if (request.method === "POST") {
      if (+(request.headers.get("content-length") || 0) > STAT_BODY) return json({ error: "too large" }, 413);
      const raw = await request.text();
      if (raw.length > STAT_BODY) return json({ error: "too large" }, 413);
      let body; try { body = JSON.parse(raw); } catch { return json({ error: "bad json" }, 400); }
      const e = body && typeof body === "object" ? body.e : null;
      if (typeof e !== "string" || !STAT_EVENTS.includes(e)) return json({ error: "unknown event" }, 400);
      // soft flood guard: 60 events a minute per IP, held in memory only (never stored)
      const ip = request.headers.get("cf-connecting-ip") || "?", now = Date.now();
      let h = this.statHits.get(ip);
      if (!h || now - h.t0 > STAT_WINDOW_MS) { h = { t0: now, n: 0 }; this.statHits.set(ip, h); }
      if (++h.n > STAT_PER_WINDOW) return json({ error: "slow down" }, 429);
      if (this.statHits.size > 2000) for (const [k, v] of this.statHits) if (now - v.t0 > STAT_WINDOW_MS) this.statHits.delete(k);
      const date = stockholmDate(now), key = `stat:${date}`;
      const cur = await this.state.storage.get(key);
      const row = cur || {};
      row[e] = (row[e] || 0) + 1;
      if (e === "mp_start") {
        const n = typeof body.n === "number" ? int(body.n, 1, 12) : null;
        if (n !== null) { row.mp_players = row.mp_players || {}; row.mp_players[n] = (row.mp_players[n] || 0) + 1; row.mp_players_sum = (row.mp_players_sum || 0) + n; }
      }
      await this.state.storage.put(key, row);
      if (!cur) await this.pruneStats(now); // a new day: drop the days older than STAT_KEEP_DAYS
      return json({ ok: true });
    }
    if (request.method === "GET") {
      if (!this.admin(url)) return json({ error: "forbidden" }, 403);
      const days = int(url.searchParams.get("days") || 30, 1, STAT_KEEP_DAYS) || 30;
      const rows = await this.state.storage.list({ prefix: "stat:", reverse: true, limit: days });
      return json({ days: [...rows].map(([k, v]) => statRow(k.slice(5), v)) });
    }
    return json({ error: "method" }, 405);
  }
  async pruneStats(now) {
    const cutoff = `stat:${stockholmDate(now - STAT_KEEP_DAYS * 86_400_000)}`;
    const old = await this.state.storage.list({ prefix: "stat:", end: cutoff, limit: 128 });
    if (old.size) await this.state.storage.delete([...old.keys()]);
  }
}

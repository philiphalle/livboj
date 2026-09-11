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
//
// Leaderboard:
//   GET  /board                      -> { entries: [top 50] }
//   POST /board  { entries: [...] }  -> merges (dedupe by id), returns { entries }
//   DELETE /board?key=<ADMIN_KEY>    -> wipes it (only if the ADMIN_KEY secret is set)

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
    if (url.pathname === "/board") return env.BOARD.get(env.BOARD.idFromName("global")).fetch(request);
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
    if (m && m.t === "msg") this.broadcast({ t: "msg", a: m.a, from: this.state.getTags(ws)[0], d: m.d }, ws);
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
const KEEP = 100;    // stored
const SHOW = 50;     // returned
const MAX_POST = 60; // entries per POST (a host's whole local list fits)

const str = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
const int = (v, lo, hi) => (Number.isFinite(+v) ? Math.max(lo, Math.min(hi, Math.round(+v))) : null);

// Accepts an entry from the game, rejects anything malformed, and normalises
// the shape so every stored row looks the same.
function sanitize(e) {
  if (!e || typeof e !== "object") return null;
  const score = int(e.score, 0, 1_000_000), level = int(e.level, 1, 20), ts = int(e.ts, 0, 4_102_444_800_000);
  if (score === null || level === null || ts === null) return null;
  const players = Array.isArray(e.players)
    ? e.players.slice(0, 12).map((p) => (typeof p === "string" ? { name: str(p, 14), score: 0 } : { name: str(p && p.name, 14) || "Spelare", score: int(p && p.score, 0, 1_000_000) || 0 }))
    : [];
  const id = str(e.id, 48) || `${ts}-${score}-${level}-${players.map((p) => p.name).join("+")}`.slice(0, 48);
  return { id, score, level, won: !!e.won, n: int(e.n, 1, 12) || players.length || 1, ts, team: str(e.team, 20), players };
}
const order = (a, b) => b.score - a.score || b.ts - a.ts;

export class Board {
  constructor(state, env) { this.state = state; this.env = env; }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET") return json({ entries: (await this.all()).slice(0, SHOW) });
    if (request.method === "POST") {
      let body; try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
      const incoming = (Array.isArray(body && body.entries) ? body.entries : [body]).slice(0, MAX_POST).map(sanitize).filter(Boolean);
      const all = await this.all();
      const byId = new Map(all.map((e) => [e.id, e]));
      let added = 0;
      for (const e of incoming) if (!byId.has(e.id)) { byId.set(e.id, e); added++; }
      const merged = [...byId.values()].sort(order).slice(0, KEEP);
      if (added) await this.state.storage.put("entries", merged);
      return json({ entries: merged.slice(0, SHOW), added });
    }
    if (request.method === "DELETE") {
      const key = this.env.ADMIN_KEY;
      if (!key || url.searchParams.get("key") !== key) return json({ error: "forbidden" }, 403);
      await this.state.storage.put("entries", []);
      return json({ entries: [] });
    }
    return json({ error: "method" }, 405);
  }
  async all() { return (await this.state.storage.get("entries")) || []; }
}

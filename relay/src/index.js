// Livbojen relay — a minimal WebSocket room relay on Cloudflare Workers +
// Durable Objects. The game stays host-authoritative; this only forwards
// messages between the players in a room. Uses the WebSocket Hibernation API
// so an idle room costs nothing.
//
//   wss://<worker-host>/room/<CODE>?id=<clientId>
//
// Server -> client:
//   { t: "welcome", id, peers: [ids already in the room] }
//   { t: "peer", id, join: true|false }
//   { t: "msg", a: <action>, from: <id>, d: <payload> }
// Client -> server:
//   { t: "msg", a: <action>, d: <payload> }   (broadcast to everyone else)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/room\/([A-Za-z0-9]{3,8})$/);
    if (!m) return new Response("livboj relay ok", { headers: { "content-type": "text/plain" } });
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

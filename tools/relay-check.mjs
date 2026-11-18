#!/usr/bin/env node
// The relay's directed delivery (`to`), with plain WebSockets (no browser): a handful of messages.
//
//   node tools/relay-check.mjs --relay ws://127.0.0.1:8787     # wrangler dev --local in relay/
//   node tools/relay-check.mjs --relay wss://livboj-relay.livboj.workers.dev   # after a deploy (~25 messages)
//
// Checks: a message with `to` reaches only that id; it reaches every socket of that id (a reconnecting
// client has two for a while); an unknown `to` is dropped; no `to` is still a broadcast to everyone but
// the sender; the forwarded message has exactly the old shape { t, a, from, d } (grabbhelg relies on it).
// `--expect-broadcast` turns the directed checks around for an OLD relay (it ignores `to`).
const args = {}; const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith("--")) { const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true"; args[a.slice(2)] = v; } }
const RELAY = (args.relay || "ws://127.0.0.1:8787").replace(/\/$/, "");
const OLD = args["expect-broadcast"] === "true";
const room = "RC" + Array.from({ length: 4 }, () => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[(Math.random() * 31) | 0]).join("");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, passes = 0;
const ok = (c, m, x = "") => { if (c) passes++; else fails++; console.log(`  ${c ? "ok  " : "FAIL"}  ${m}${x ? "  " + x : ""}`); };

function open(id) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${RELAY}/room/${room}?id=${encodeURIComponent(id)}`), got = [];
    ws.onmessage = (e) => { try { const m = JSON.parse(e.data); if (m.t === "msg") got.push({ raw: e.data, m }); } catch {} };
    ws.onopen = () => resolve({ ws, got, id, send: (o) => ws.send(JSON.stringify(o)) });
    ws.onerror = () => reject(new Error(`could not connect to ${RELAY} as ${id}`));
  });
}
console.log(`relay-check ${RELAY} room ${room}${OLD ? " (expecting an old relay: `to` ignored)" : ""}`);
const H = await open("host"), A = await open("joinA"), B = await open("joinB"), A2 = await open("joinA"); // A2: joinA's second socket
await sleep(500);
const clear = () => { for (const c of [H, A, B, A2]) c.got.length = 0; };
const n = (c, a) => c.got.filter((g) => g.m.a === a).length;

clear();
A.send({ t: "msg", a: "inp", d: { x: 1, y: 2, dash: 0, stun: 0 }, to: "host" });
await sleep(600);
ok(n(H, "inp") === 1, "a message with to=host reaches the host");
if (OLD) ok(n(B, "inp") === 1, "old relay: another joiner gets it too (broadcast)");
else ok(n(B, "inp") === 0 && n(A2, "inp") === 0, "…and no other socket (the other joiner, the sender's own second socket)", `B ${n(B, "inp")}, A2 ${n(A2, "inp")}`);
const fwd = H.got.find((g) => g.m.a === "inp");
ok(fwd && JSON.stringify(Object.keys(fwd.m)) === JSON.stringify(["t", "a", "from", "d"]) && fwd.m.from === "joinA", "the forwarded message has the old shape { t, a, from, d }", fwd && fwd.raw);

clear();
H.send({ t: "msg", a: "x", d: 1, to: "joinA" });
await sleep(600);
ok(n(A, "x") === 1 && n(A2, "x") === 1, "to=joinA reaches both of joinA's sockets", `${n(A, "x")} + ${n(A2, "x")}`);
if (!OLD) ok(n(B, "x") === 0, "…and not joinB");

clear();
H.send({ t: "msg", a: "y", d: 1, to: "nobody-here" });
await sleep(600);
const ny = [A, B, A2].reduce((s, c) => s + n(c, "y"), 0);
ok(OLD ? ny === 3 : ny === 0, OLD ? "old relay: an unknown `to` is broadcast" : "an unknown `to` is dropped (nobody gets it)", `delivered ${ny}`);

clear();
H.send({ t: "msg", a: "st", d: { phase: "lobby" } });
await sleep(600);
ok(n(A, "st") === 1 && n(B, "st") === 1 && n(A2, "st") === 1 && n(H, "st") === 0, "no `to`: broadcast to everyone but the sender, as before");

clear();
H.send({ t: "msg", a: "z", d: 1, to: ["joinA"] }); // not a string: treated as no `to`
await sleep(600);
ok(n(A, "z") === 1 && n(B, "z") === 1, "a `to` that is not a string is ignored (broadcast)");

for (const c of [H, A, B, A2]) c.ws.close();
console.log(`\n${fails ? "FAIL" : "PASS"}: ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);

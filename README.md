# Livbojen 🛟

A small browser game: steer a life ring and rescue swimmers before they sink.
Play alone or together (up to 12 players, one hosts). Eight levels, each busier
than the last, with docks, swamps, Loch Ness monsters and (levels 6–7) a
whirlpool. A shared global leaderboard keeps every finished game.

**Play:** https://philiphalle.github.io/livboj/

## Files

| File | What it is |
| --- | --- |
| `index.html` | Start page: your name, *Spela själv* (solo), join a room by code, the global leaderboard. Also the in-game page for solo and joiners. |
| `host.html` | Host page: create a lobby (room code + invite link), start the game, end it. |
| `game.js` | `createGame()`: wires sim, renderer and network together for solo / host / join — state sync to joiners, host migration, input, the frame loop — plus sound and the page chrome (fullscreen, rotate hint, iOS fixes). |
| `sim.js` | The rules: levels, world size (2:1: 1040×520 alone, growing with the players to 1800×900 — the water area of the old 3:2 worlds), the layouts (drawn up on the 1040×520 world, stretched to the water of a bigger one), spawning, swimmers, monsters, whirlpools, swamps, docks, collisions, scoring, phases. Pure (no DOM, audio, network, storage or clock), so node runs it; solo and the host run it, joiners only draw the host's state. |
| `render.js` | The world drawn on the canvas: water, shore, beach, swamps, docks, swimmers, monsters, rings, gulls (logical 1200×600, 2:1, HiDPI backing store). |
| `water.js` | The water: a WebGL layer under the game canvas (one fragment shader: depth, caustics, waves, shadows, foam, wakes, the whirlpool) with a 2D fallback of the same look. Steps down in quality when frames are slow; `?water=2d`, `?water=gl` or `?water=low` forces a mode. |
| `hud.js` | The canvas UI on top: HUD, on-canvas buttons (mute, *Spurt*, *Avsluta spelet*, the screens' buttons), the intro / level / end / lobby screens, vector icons. Scales up on small canvases (phones); the fullscreen button's CSS repeats its formula. A HUD piece with a swimmer, monster or ring under it turns see-through (and a swimmer's sink gauge is drawn above it), so the HUD never hides what you must reach. |
| `fonts/` | Fredoka (SIL OFL 1.1, `OFL.txt`), the UI's display face, self-hosted and loaded without blocking (the system font draws until it has arrived). A changed font file gets a new name: it is not fingerprinted by `boot.js`. |
| `net.js` | The room transports (WebSocket relay, Trystero P2P fallback) and the relay's HTTP endpoints (leaderboard + its localStorage outbox and unfinished games, Förslagslåda, the anonymous counters). |
| `boot.js` | Fingerprints every module, loads `game.js?v=<build>` and watches for new builds (see *Deploy*). |
| `nyheter.json` | The news shown on the start page (see *Nyheter* below). |
| `manifest.webmanifest`, `icons/`, `favicon.svg` | Add-to-home-screen / install (fullscreen on phones). No service worker. |
| `relay/` | Cloudflare Worker: the WebSocket room relay and the global leaderboard (`relay/README.md`). |
| `tools/` | Dev only: `sim-test.mjs` (tests for the rules and the layouts, plain node), `bot.mjs` (a deterministic bot that plays every level: clear rate, rescues per minute, misses — for comparing difficulty between two `sim.js`), `smoke.mjs` (browser checks), `load.mjs` (N bot players in one room through a relay: message rates, quota projection, sanity), `feel.mjs` (a remote ring on the host's screen, a joiner's rescue delay), `relay-check.mjs` (the relay's directed delivery, plain WebSockets), `shot.mjs` (screenshots), `icons.mjs` (renders `icons/` from `favicon.svg`). |

## Run locally

No build step. Serve the folder over HTTP (ES modules don't load from `file://`):

```bash
python3 -m http.server 8000      # then open http://localhost:8000/
```

Multiplayer and the leaderboard use the live relay by default; add
`?relay=ws://localhost:8787` to use a local one (`relay/README.md`), or
`?relay=off` for plain peer-to-peer WebRTC.

## Controls

- **Keyboard:** arrow keys steer · **Space** dash · **Enter** next level / start (host) · **M** sound on/off · **F** fullscreen
- **Touch:** drag on the water to steer, tap **Spurt** (bottom right) to dash, tap anywhere to go on between levels (host)
- **Buttons on the game:** sound (bottom left), fullscreen (next to it), *Avsluta spelet* (host, top right — bottom right on the level board — tap twice)
- **Fullscreen:** the button or F on desktop and Android. A desktop that isn't fullscreen gets a short *F helskärm* chip
  beside the button when a game starts (once per session). On a 16:9 screen the 2:1 field leaves a band of the page's
  sea above and below. On iPhone there is no fullscreen in the browser:
  *Dela → Lägg till på hemskärmen* and start it from the home screen (the menu shows that hint on iPhone/iPad).
  Phones held upright get a dismissable *Vrid mobilen* card.

## Hosting and joining

1. The host opens `host.html` (*Skapa ett eget spel* on the start page), enters a name and creates a lobby.
2. Others open the invite link, or enter the room code on the start page and press *Gå med*.
3. The host presses *Starta spelet*. The host runs the game; everyone else sends their own position.
   If the host drops out, the remaining players elect a new host and the game goes on.

**Team name (optional).** The host can type one in the lobby (`host.html`, max 20 characters; the
placeholder is only an example from the host's name). It reaches the joiners in the host's state
(`team`, an optional field of the snapshot, left out when empty), shows under the title of the lobby,
level board and end screens, and goes into the leaderboard result. It is fixed once a game starts and
editable again back in the lobby (*Till lobbyn*). A promoted host keeps it. No name: nothing is shown,
and the leaderboard says *Lag* as before. Solo games have none.

Transport is the WebSocket relay (`relay/`), which works on office networks that block WebRTC.
The client reconnects by itself (short backoff, when the page returns from the background, when
the network comes back) without dropping anyone from the roster.

**Network budget.** The relay runs on Cloudflare's free plan: 100,000 requests a day for the whole
account, and every WebSocket message a client *sends* counts towards it (what the relay sends out is
free). So (`game.js`, the constants at the top):

- The host sends its state 20 times a second only in INTRO and PLAY. In the lobby, on the level board
  and on the end screens it sends on every change (roster, names, team name, phase, leaderboard) plus a
  heartbeat every 600 ms — joiners call an election after 3 s without state, so three lost or late
  heartbeats in a row are still fine. A hidden host tab's timers run once a second (as before).
- A joiner sends its position only in PLAY, ~12 times a second, and not at all while nothing changed
  (position, dash, stun) except a heartbeat once a second; and only to the host (`to` = the host's id,
  the relay delivers it to that player alone). Before the first snapshot, and while the host it knows
  has left (an election), it sends to everyone. Hello and the reconnect probes always go to everyone.
- The host draws a remote ring smoothly between its reports; the rules use the latest reported
  position and the path between two reports, so a joiner whose ring touched a swimmer on its own screen
  gets the rescue.

An older relay ignores `to` and broadcasts, an older client never sends it: every mix works (the
snapshot and input formats are unchanged). `node tools/load.mjs --relay …` measures it all.

## Leaderboard

Solo games and hosted games post their result to the relay (`/board`). A result is put in a
localStorage queue first and leaves it only once the relay has taken it, so a result survives a
dead network: the queue is retried on the next page load and when the browser comes back online.
The relay dedupes by entry id, so a re-sent result never shows twice.

**Unfinished games.** A game whose last player leaves mid-game (intro, play or the level board) is
listed too, with the score so far — a row like any other (same fields, no mark); a game at 0 points is
not. Who records it: solo, the player; hosted, only the authoritative host (also a promoted one) with
nobody else left in the room — with players left, one of them takes over and the game goes on.
Every game has an id (`game.js` `game.id`, `g<time>-<random>`, carried to the joiners in the snapshot's
`gid`), which is its result's entry id, so every copy of one game is one row. How leaving is caught
(`game.js` "Leaving mid-game", `net.js` "Unfinished games"):

- page hidden (`visibilitychange`) or `pagehide`: the result so far is written to localStorage
  (`livboj-pending`); visible again or back from the bfcache: dropped, the game goes on;
- `pagehide` that is not into the bfcache (tab closed, reload, navigation): moved to the outbox and
  posted at once (keepalive), and counted as abandoned;
- a phone that kills the background tab without any event: the next load of any game page on that
  device finds it, posts it and counts it. A page holds the Web Lock `livboj-game-<id>` while its game
  runs, so another tab never takes the pending game of a page that is still alive.

If a copy was posted and the game still went on (it came back after all), the final result replaces
it: for these ids the relay keeps the copy that got further (`relay/README.md`).

**Anonymous counters.** `net.js` `sendStat` posts one tiny event to the relay's `/stat` (a visit, a
game started / finished / left, a join; `relay/README.md` has the list and how to read them). No
cookies, no ids, never waited for or retried. It is silent in automated browsers
(`navigator.webdriver`) and on a page served from localhost / 127.0.0.1 — unless the relay in use is
local (`?relay=ws://127.0.0.1:8787`), so local end-to-end tests see them. The tools stub `/stat` like
`/board` (`tools/harness.mjs` `stubBoard`). Note: requests a page sends while it unloads get past
Playwright's stubs, so in an automated browser with a non-local relay the leaving post waits in the
outbox for the next load instead (`net.js` `UNLOAD_SEND`); `smoke.mjs --only leave` uses a stand-in
relay on 127.0.0.1 (`harness.mjs` `fakeRelay`, the relay's own Board code) to see those requests.

## Nyheter and the Förslagslåda

The start page shows the latest five items of `nyheter.json` (fetched uncached, so a push shows
up at once). To add a news item, put a new object **first** in the array and push:

```json
{ "date": "2026-12-01", "title": "Kort rubrik", "text": "En eller två meningar på enkel svenska, för spelarna." }
```

`date` is `YYYY-MM-DD` (shown as d/m). Text only — it is inserted as plain text, never as HTML.
Below the news, the *Förslagslåda* sends a player's suggestion to the relay (`POST /forslag`);
`relay/README.md` says how to read them.

## Deploy

Push to `main` → GitHub Pages publishes the folder. GitHub Pages caches files for 10 minutes, so
`boot.js` asks for the current ETag of every module in its `MODULES` list (uncached HEADs), hashes
them into one build id and imports `game.js?v=<build>`; `game.js` (and `render.js`) import their
siblings with that same `?v=`. Every build gets its own URL for every module, a page load always
runs the latest game, and no page can mix an old `sim.js` with a new `game.js`. While a tab is
open it checks every minute; on the menu it reloads silently, mid-game it shows an *Uppdatera nu*
banner. Two rules keep this working:

- A new module file goes into `MODULES` in `boot.js` (`node tools/smoke.mjs --only cache` checks).
- Modules import each other only as `` await import(`./sim.js${new URL(import.meta.url).search}`) ``,
  never with a static `import … from "./sim.js"`: that URL has no `?v=`, so it would be a second,
  stale copy of the module.

URLs must stay relative: the site lives under `/livboj/`.

The relay is deployed separately with `npx wrangler deploy` in `relay/` (see `relay/README.md`).

## Checks

```bash
node tools/sim-test.mjs           # the rules and layouts (sim.js) in plain node: no install, no browser, ~3 s
node tools/bot.mjs --strategy near --sim /tmp/old-sim.js   # difficulty: a bot plays every level (compare two sim.js)
npm install                       # once: Playwright for the tools below (or it is found in the npx cache)
node tools/smoke.mjs              # layout, fullscreen, water layer, HUD see-through, every button by click/tap, input, leaderboard queue, unfinished solo games + counters, cache busting (leaderboard always stubbed)
node tools/smoke.mjs --live       # + host/join, forced reconnects and the team name (incl. old/new builds mixed) through the live relay
node tools/smoke.mjs --only forslag,live --relay ws://127.0.0.1:8787   # against wrangler dev --local
node tools/smoke.mjs --only leavemp --relay ws://127.0.0.1:8787        # a hosted game left mid-game / ended: rows + counters (needs a local relay)
node tools/relay-check.mjs --relay ws://127.0.0.1:8787                 # the relay's `to` (directed delivery), plain WebSockets
node tools/load.mjs --relay ws://127.0.0.1:8787 --minutes 3            # 8 bots in one room: msgs/s per client and for the room, quota hours/day, sanity
node tools/load.mjs --relay ws://127.0.0.1:8787 --kill-host-at 60      # …and the host closes mid-game: a joiner takes over
node tools/feel.mjs --relay ws://127.0.0.1:8787 --compare 3ee8dd0      # a remote ring on the host's screen, rescue delay: this build vs another
# node tools/load.mjs  (no --relay) runs against the LIVE relay and spends the shared daily quota: once, deliberately
node tools/shot.mjs               # screenshots of menu + solo game at desktop and phone sizes -> shots/
```

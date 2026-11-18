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
| `game.js` | Everything else: simulation, rendering (canvas, logical 900×600), input, networking, leaderboard client, page chrome (fullscreen, rotate hint, iOS fixes). |
| `boot.js` | Loads `game.js?v=<its ETag>` and watches for new builds (see *Deploy*). |
| `nyheter.json` | The news shown on the start page (see *Nyheter* below). |
| `manifest.webmanifest`, `icons/`, `favicon.svg` | Add-to-home-screen / install (fullscreen on phones). No service worker. |
| `relay/` | Cloudflare Worker: the WebSocket room relay and the global leaderboard (`relay/README.md`). |
| `tools/` | Dev only: `smoke.mjs` (automated checks), `shot.mjs` (screenshots), `icons.mjs` (renders `icons/` from `favicon.svg`). |

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
- **Buttons on the game:** sound (bottom left), fullscreen (next to it), *Avsluta spelet* (host, top right, tap twice)
- **Fullscreen:** the button or F on desktop and Android. On iPhone there is no fullscreen in the browser:
  *Dela → Lägg till på hemskärmen* and start it from the home screen (the menu shows that hint on iPhone/iPad).
  Phones held upright get a dismissable *Vrid mobilen* card.

## Hosting and joining

1. The host opens `host.html` (*Skapa ett eget spel* on the start page), enters a name and creates a lobby.
2. Others open the invite link, or enter the room code on the start page and press *Gå med*.
3. The host presses *Starta spelet*. The host runs the game; everyone else sends their own position.
   If the host drops out, the remaining players elect a new host and the game goes on.

Transport is the WebSocket relay (`relay/`), which works on office networks that block WebRTC.
The client reconnects by itself (short backoff, when the page returns from the background, when
the network comes back) without dropping anyone from the roster.

## Leaderboard

Solo games and hosted games post their result to the relay (`/board`). A result is put in a
localStorage queue first and leaves it only once the relay has taken it, so a result survives a
dead network: the queue is retried on the next page load and when the browser comes back online.
The relay dedupes by entry id, so a re-sent result never shows twice.

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
`boot.js` asks for `game.js`'s current ETag (uncached HEAD) and imports `game.js?v=<etag>`: every
build gets its own URL and a page load always runs the latest game. While a tab is open it checks
every minute; on the menu it reloads silently, mid-game it shows an *Uppdatera nu* banner.
Only `game.js` is fingerprinted, so game code belongs in `game.js` (statically imported siblings
would not be cache-busted). URLs must stay relative: the site lives under `/livboj/`.

The relay is deployed separately with `npx wrangler deploy` in `relay/` (see `relay/README.md`).

## Checks

```bash
npm install                       # once: Playwright for the tools (or it is found in the npx cache)
node tools/smoke.mjs              # layout, fullscreen, input, leaderboard queue (leaderboard always stubbed)
node tools/smoke.mjs --live       # + host/join and forced reconnects through the live relay
node tools/smoke.mjs --only forslag,live --relay ws://127.0.0.1:8787   # against wrangler dev --local
node tools/shot.mjs               # screenshots of menu + solo game at desktop and phone sizes -> shots/
```

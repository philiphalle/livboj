# Livbojen relay

A tiny WebSocket room relay for the game, so multiplayer works on networks that
block peer-to-peer / WebRTC (typical office networks). Runs on Cloudflare
Workers + Durable Objects — free tier is plenty.

## Deploy (one time, ~3 minutes)

1. Create a free account at https://dash.cloudflare.com/sign-up
2. In this folder:

   ```bash
   npx wrangler login      # opens the browser once
   npx wrangler deploy
   ```

3. Wrangler prints a URL like `https://livboj-relay.<you>.workers.dev`.
   Open it in a browser — it should say `livboj relay ok`.

## Point the game at it

The game already uses `wss://livboj-relay.livboj.workers.dev` by default
(`RELAY_DEFAULT` at the top of `game.js`). If you redeploy under another
name or account, change that constant and push.

Per-session overrides, for testing (the host's invite link carries the same
`relay` parameter, so joiners follow automatically):

```
# a different relay
https://philiphalle.github.io/livboj/host.html?relay=wss://livboj-relay.<you>.workers.dev
# plain peer-to-peer (WebRTC), no relay
https://philiphalle.github.io/livboj/host.html?relay=off
```

## Global leaderboard

The same Worker keeps the shared top list (one Durable Object, `Board`):

```
GET  https://livboj-relay.livboj.workers.dev/board                    # { entries: [top 50], recent }
POST https://livboj-relay.livboj.workers.dev/board  {"entries":[…]}   # merge by id, returns the list
```

Merging by id: a copy whose id is already stored is ignored (first copy wins) — except for a
per-game id (`g<base36>-<base36>`, sent by clients since 2026-11), where a copy that got further
(more points, then a higher level, then a longer time) replaces the stored one. A game left
mid-game is posted with the score so far; if its player came back after all and finished it, the
final result replaces that copy instead of being dropped. Every older row merges exactly as before.
The POST also accepts a `text/plain` body (a page that is closing sends it without a preflight).

The host posts every finished round and, the first time it runs this version,
uploads the old local list from its browser once. Anyone with the URL could
post scores — fine for an office game. To wipe the list, set a secret once
(`npx wrangler secret put ADMIN_KEY`) and call `DELETE /board?key=<ADMIN_KEY>`.

## Förslagslåda (suggestion box)

The start page's *Förslagslåda* posts here. Suggestions are stored in the same
`Board` Durable Object under their own storage key (newest 500 kept; no new
binding or migration) and are never returned to the public.

```
POST   /forslag  {"text": "…", "name": "…"}     # -> { ok: true }
GET    /forslag?key=<ADMIN_KEY>                 # -> { items: [{ id, ts, text, name }, …] } newest first
DELETE /forslag?key=<ADMIN_KEY>&id=<id>         # remove one (without &id: remove all)
```

`text` must be non-empty after trimming and at most 500 characters; `name` is
optional (cut to 14). Control characters are stripped (line breaks kept), bodies
over 4 KB get 413, and one IP may post once per 10 s (429). GET/DELETE answer
403 unless the `ADMIN_KEY` secret is set and matches.

To read the box (after `npx wrangler secret put ADMIN_KEY` once):

```bash
curl -s "https://livboj-relay.livboj.workers.dev/forslag?key=$ADMIN_KEY" | python3 -m json.tool
```

Until a relay with this endpoint is deployed, `POST /forslag` answers 404 and
the page shows its normal "Det gick inte att skicka" message (the text stays).

## Anonymous daily counters (`/stat`)

How many people open the game and how many games are played, per day. Kept in the same `Board`
Durable Object, one storage key per day (`stat:YYYY-MM-DD`, the Europe/Stockholm calendar date;
about 400 days kept). Nothing that identifies anyone is stored: no IP, user agent, name, id or time
finer than the day — only the counts below. Nothing is shown to players.

```
POST /stat  {"e":"<event>","n":<players>}       # -> { ok: true }; any content type (a sendBeacon / text/plain works)
GET  /stat?key=<ADMIN_KEY>[&days=30]           # -> { days: [{ date, visit, …, mp_players, mp_players_sum }] } newest first
```

| Event | Sent by | When |
| --- | --- | --- |
| `visit` | every page load of `index.html` or `host.html` (not the update watcher's own reload) | |
| `solo_start` | the solo player | a solo game starts (also *Spela igen*) |
| `mp_start` | the host, with `n` = players | *Starta spelet* (also the next game from the lobby); `mp_players` is a histogram by `n`, `mp_players_sum` their sum |
| `join` | a joiner | its first state from the host (it is in the room) |
| `solo_done` / `mp_done` | solo / the host (or a promoted host) | the game reached game over, the last level, or *Avsluta spelet* |
| `solo_abandoned` / `mp_abandoned` | whoever would record the result | the game's last player left mid-game (counted also at score 0) |

A game is counted once: never both `*_done` and `*_abandoned`, and a level change is not a new game.
A phone that was killed in the background sends its `*_abandoned` on the next visit (that day's row).
Unknown events or bad JSON get 400, bodies over 200 bytes 413; one IP may send 60 events a minute
(429 after that; the counter lives in memory only and is never stored). Every POST is one request
against the free plan's daily cap, which is why the game sends one per page load / game event and
nothing periodic. The game itself stays silent in automated browsers (`navigator.webdriver`) and on a
page served from localhost / 127.0.0.1, unless the relay in use is local (`wrangler dev`).

To read them (the same `ADMIN_KEY` as for the Förslagslåda):

```bash
curl -s "https://livboj-relay.livboj.workers.dev/stat?key=$ADMIN_KEY&days=14" | python3 -m json.tool
```

## Rooms: broadcast, or to one player

A message `{ t: "msg", a, d }` goes to everyone else in the room, as `{ t: "msg", a, from, d }`.
With `to: "<id>"` it goes only to that id's socket(s) (all of them: a reconnecting client briefly
has two); an id not in the room drops it. The game sends a joiner's position to the host this way.
The forwarded message has the same shape either way; a client that never sends `to` (grabbhelg, an
older Livbojen) sees no difference. `node tools/relay-check.mjs --relay <ws url>` checks it.

The free plan's 100,000 requests a day are for the whole account, and the messages clients send
over a room's WebSocket count towards it (Cloudflare bills 20 incoming messages as one request).
`node tools/load.mjs` measures a game's rate and turns it into hours of play per day.

## Local test (no account needed)

```bash
echo "ADMIN_KEY=local-test-key" > .dev.vars   # (git-ignored) for the admin endpoints
npx wrangler dev --local     # serves ws://localhost:8787
```

then open the game with `?relay=ws://localhost:8787`. The repo's smoke test can
drive it end to end: `node tools/smoke.mjs --only forslag,live,team,leavemp --relay ws://127.0.0.1:8787`,
and `node tools/load.mjs --relay ws://127.0.0.1:8787` plays an 8-player game against it. The counters:
`curl -s "http://127.0.0.1:8787/stat?key=local-test-key"`.

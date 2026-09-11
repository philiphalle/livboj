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
GET  https://livboj-relay.livboj.workers.dev/board                    # { entries: [top 50] }
POST https://livboj-relay.livboj.workers.dev/board  {"entries":[…]}   # merge by id, returns the list
```

The host posts every finished round and, the first time it runs this version,
uploads the old local list from its browser once. Anyone with the URL could
post scores — fine for an office game. To wipe the list, set a secret once
(`npx wrangler secret put ADMIN_KEY`) and call `DELETE /board?key=<ADMIN_KEY>`.

## Local test (no account needed)

```bash
npx wrangler dev --local     # serves ws://localhost:8787
```

then open the game with `?relay=ws://localhost:8787`.

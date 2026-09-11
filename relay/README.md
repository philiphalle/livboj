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

## Local test (no account needed)

```bash
npx wrangler dev --local     # serves ws://localhost:8787
```

then open the game with `?relay=ws://localhost:8787`.

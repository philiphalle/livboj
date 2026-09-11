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

Either test first without redeploying the game, by adding the relay to the URL
(both host and joiners must use it):

```
https://philiphalle.github.io/livboj/host.html?relay=wss://livboj-relay.<you>.workers.dev
```

The host's invite link automatically carries the same `relay` parameter.

Or make it the default: set `RELAY_URL` at the top of `game.js` to
`wss://livboj-relay.<you>.workers.dev` and push.

## Local test (no account needed)

```bash
npx wrangler dev --local     # serves ws://localhost:8787
```

then open the game with `?relay=ws://localhost:8787`.

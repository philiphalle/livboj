// Shared bits for tools/shot.mjs and tools/smoke.mjs: a static file server for
// the repo (with ETag / Last-Modified and a 10-minute max-age like GitHub
// Pages, so boot.js versions the modules the same way) and a Playwright +
// Chromium found on this machine.
//
// Playwright is not a dependency of the game. It is looked up in, in order:
// this repo's node_modules (`npm install` with the dev package.json), the npx
// cache (~/.npm/_npx/*/node_modules/playwright), then grabbhelg's node_modules.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".css": "text/css", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8" };

/**
 * Serve ROOT on 127.0.0.1:<port> (0 = any free port). -> { url, close(), overrides }
 * `overrides` (a Map of "/path" -> content) is served instead of the file on
 * disk, ETag and all: a test can "deploy" a changed file without touching the repo.
 */
export function serve(port = 0) {
  const overrides = new Map();
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end("not found"); return; }
    const over = overrides.has(p), body = over ? Buffer.from(overrides.get(p)) : fs.readFileSync(file), st = over ? { mtime: new Date() } : fs.statSync(file);
    const etag = `"${crypto.createHash("sha1").update(body).digest("hex").slice(0, 16)}"`;
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", etag, "last-modified": st.mtime.toUTCString(), "cache-control": "max-age=600" });
    res.end(req.method === "HEAD" ? undefined : body);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((r) => server.close(r)), overrides })));
}

export function findPlaywright() {
  const req = createRequire(import.meta.url);
  try { return req("playwright"); } catch { /* not installed here */ }
  const cands = [];
  const npx = path.join(os.homedir(), ".npm", "_npx");
  for (const d of fs.existsSync(npx) ? fs.readdirSync(npx) : []) cands.push(path.join(npx, d, "node_modules", "playwright"));
  cands.push(path.join(os.homedir(), "Work", "grabbhelg", "node_modules", "playwright"));
  for (const p of cands) if (fs.existsSync(path.join(p, "package.json"))) return createRequire(path.join(p, "package.json"))(p);
  throw new Error("playwright not found: `npm install` in this repo (package.json has it as a devDependency) or `npx playwright install chromium`");
}

/** A Chromium build in the Playwright cache (newest first), or undefined (let Playwright pick its own). */
export function findChrome() {
  const cache = process.platform === "darwin" ? path.join(os.homedir(), "Library", "Caches", "ms-playwright") : path.join(os.homedir(), ".cache", "ms-playwright");
  const dirs = fs.existsSync(cache) ? fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => +b.match(/\d+/)[0] - +a.match(/\d+/)[0]) : [];
  const rels = ["chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-linux64/chrome", "chrome-linux/chrome"];
  for (const d of dirs) for (const r of rels) { const p = path.join(cache, d, r); if (fs.existsSync(p)) return p; }
  return undefined;
}

export async function launch(opts = {}) {
  const { chromium } = findPlaywright();
  try { return await chromium.launch({ headless: true, ...opts }); }
  catch (e) { const exe = findChrome(); if (!exe) throw e; return chromium.launch({ headless: true, executablePath: exe, ...opts }); }
}

/**
 * Never let a test touch the real leaderboard: every request to …/board (and
 * …/forslag) is answered here. `onPost(body, route)` may answer a POST itself
 * (return true); otherwise a POST gets a fake 200 that echoes the entries.
 * -> { posts: [parsed bodies], gets: n }
 */
export async function stubBoard(context, { onPost, entries = [] } = {}) {
  const log = { posts: [], gets: 0, forslag: [] };
  await context.route(/\/board(\?|$)/, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (req.method() === "POST") {
      let body = null; try { body = JSON.parse(req.postData() || "null"); } catch {}
      log.posts.push(body);
      if (onPost && (await onPost(body, route))) return;
      const got = (body && body.entries) || [];
      return route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify({ entries: [...entries, ...got], recent: got, added: got.length }) });
    }
    log.gets++;
    return route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify({ entries, recent: [] }) });
  });
  return log;
}
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET, POST, DELETE, OPTIONS" };

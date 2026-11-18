#!/usr/bin/env node
// Render the app icons in icons/ from favicon.svg with headless Chromium.
//   node tools/icons.mjs
// icon-192/512: the ring on transparent; maskable-512: the ring inside the
// safe zone on the sea colour; apple-touch-icon (180): on the sea colour (iOS
// would fill transparency with black).
import fs from "node:fs";
import path from "node:path";
import { ROOT, launch } from "./harness.mjs";

// (the favicon's stripes run past the ring, invisible at 16 px but not on an app icon: clip them to the disc)
const svg = fs.readFileSync(path.join(ROOT, "favicon.svg"), "utf8")
  .replace("<defs>", '<defs><clipPath id="disc"><circle cx="32" cy="32" r="31"/></clipPath>')
  .replace('<g mask="url(#hole)">', '<g clip-path="url(#disc)"><g mask="url(#hole)">').replace(/<\/g>\s*<\/svg>/, "</g></g></svg>");
const SEA = "#0c3346";
const out = path.join(ROOT, "icons");
fs.mkdirSync(out, { recursive: true });
const jobs = [
  { file: "icon-192.png", size: 192, ring: 0.94, bg: null },
  { file: "icon-512.png", size: 512, ring: 0.94, bg: null },
  { file: "icon-maskable-512.png", size: 512, ring: 0.62, bg: SEA }, // maskable safe zone: the centre 80 % circle
  { file: "apple-touch-icon.png", size: 180, ring: 0.78, bg: SEA },
];
const browser = await launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const j of jobs) {
  await page.setViewportSize({ width: j.size, height: j.size });
  const bg = j.bg ? `radial-gradient(120% 100% at 50% 0%, #164e6f 0%, ${j.bg} 55%, #061a24 100%)` : "transparent";
  await page.setContent(`<!doctype html><html><body style="margin:0;width:${j.size}px;height:${j.size}px;display:grid;place-items:center;background:${bg}">
    <div style="width:${Math.round(j.size * j.ring)}px;height:${Math.round(j.size * j.ring)}px">${svg.replace("<svg ", '<svg width="100%" height="100%" ')}</div></body></html>`);
  await page.screenshot({ path: path.join(out, j.file), omitBackground: !j.bg });
  console.log("wrote icons/" + j.file);
}
await browser.close();

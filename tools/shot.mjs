#!/usr/bin/env node
// Headless screenshots of the game, served from this folder.
//
//   node tools/shot.mjs                      # the standard set: menu + solo game at every size below -> shots/
//   node tools/shot.mjs --w 844 --h 390 --touch --view solo --at 3 --name phone
//   node tools/shot.mjs --page host.html --view host --w 1366 --h 768
//
// --view menu | solo | host (host: creates a lobby, starts the game) | join (needs --room)
// --page   the page to open (default index.html), --query "?homehint=1" extra query string
// --w/--h  viewport (css px), --dsf device scale factor (default 1), --touch: a phone (touch, coarse pointer, mobile)
// --at     seconds after the game shows before the shot (default 2.5), --out dir (default shots/), --name file prefix
// --eval   JS to run in the page just before the shot
//
// Every request to the leaderboard is stubbed (tools/harness.mjs stubBoard): a screenshot run never posts a result.
import path from "node:path";
import fs from "node:fs";
import { ROOT, serve, launch, stubBoard } from "./harness.mjs";

const args = {}; const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith("--")) { const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true"; args[a.slice(2)] = v; } }
const out = path.resolve(args.out || path.join(ROOT, "shots"));
fs.mkdirSync(out, { recursive: true });

export const SIZES = [
  { name: "1920x1080", w: 1920, h: 1080 }, { name: "2560x1440", w: 2560, h: 1440 }, { name: "1366x768", w: 1366, h: 768 },
  { name: "844x390-phone", w: 844, h: 390, touch: true }, { name: "390x844-phone", w: 390, h: 844, touch: true },
];

/** Open `page` at a size, get it to `view`, wait `at` s, screenshot. -> { file, info } */
export async function shoot(browser, base, { w, h, touch = false, dsf = 1, page: pageName = "index.html", query = "", view = "menu", at = 2.5, file, evalJs, room }) {
  const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dsf, hasTouch: touch, isMobile: touch });
  await stubBoard(context);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  const q = query ? (query.startsWith("?") ? query : "?" + query) : "";
  await page.goto(base + pageName + (view === "join" && room ? `?room=${room}` : q), { waitUntil: "load" });
  await page.waitForFunction(() => document.getElementById("name") && !document.getElementById("name").closest("[hidden]"));
  if (view !== "menu") {
    await page.fill("#name", "Testaren");
    if (view === "solo") await page.click("#solo");
    else if (view === "join") await page.click("#join");
    else if (view === "host") { await page.click("#create"); await page.waitForTimeout(800); await page.click("#start"); }
    await page.waitForFunction(() => !!window.livboj && !document.getElementById("stage").hidden, null, { timeout: 15000 });
  } else await page.waitForTimeout(600);
  await page.waitForTimeout(at * 1000);
  if (evalJs) await page.evaluate(evalJs);
  const info = await page.evaluate(() => {
    const c = document.getElementById("game"), r = c.getBoundingClientRect();
    return { canvas: { x: r.x, y: r.y, w: r.width, h: r.height, backW: c.width, backH: c.height }, vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio };
  });
  await page.screenshot({ path: file });
  await context.close();
  return { file, info, errors };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = await serve();
  const browser = await launch();
  try {
    const jobs = [];
    if (args.w) jobs.push({ w: +args.w, h: +(args.h || 600), touch: args.touch === "true", dsf: +(args.dsf || 1), page: args.page, query: args.query, view: args.view || "menu", at: +(args.at || 2.5), evalJs: args.eval, room: args.room,
      file: path.join(out, `${args.name || "shot"}-${args.view || "menu"}-${args.w}x${args.h || 600}.png`) });
    else for (const s of SIZES) for (const view of ["menu", "solo"]) jobs.push({ ...s, view, at: +(args.at || 2.5), file: path.join(out, `${view}-${s.name}.png`) });
    for (const j of jobs) {
      const r = await shoot(browser, server.url, j);
      console.log(`${path.relative(ROOT, r.file)}  canvas ${Math.round(r.info.canvas.w)}x${Math.round(r.info.canvas.h)} backing ${r.info.canvas.backW}x${r.info.canvas.backH}${r.errors.length ? "  ERRORS: " + r.errors.join(" | ") : ""}`);
    }
  } finally { await browser.close(); await server.close(); }
}

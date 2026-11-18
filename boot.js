// boot.js — versioned loader + update watcher for Livbojen.
//
// GitHub Pages serves every file with "cache for 10 minutes", so a normal
// reload can keep old code. We ask the server for the current fingerprint
// (ETag) of EVERY module file the game loads, with caching disabled, combine
// them into one build id and import game.js?v=<build>; game.js imports its
// siblings with the same ?v=. So every build has its own URLs for all its
// modules, a page load always runs the latest code, and a page can never mix
// an old sim.js with a new game.js (in multiplayer: players on different
// rules) — without anyone maintaining a version number.
//
// The same check repeats while the tab is open. A new build reloads the page
// silently if nothing is going on yet (menu / setup screen); otherwise a small
// banner offers "Uppdatera nu", because reloading a host mid-game would end
// the round for everyone.

const CHECK_MS = 60 * 1000;
// Every module file the game loads (game.js imports the others with its own
// ?v=). A new module file must be added here, or a change to it alone would
// not change the build.
export const MODULES = ["game.js", "sim.js", "render.js", "hud.js", "water.js", "net.js"];

async function etagOf(file) {
  const r = await fetch(`${file}?_=${Date.now()}`, { method: "HEAD", cache: "no-store" });
  if (!r.ok) return "";
  const tag = r.headers.get("etag") || r.headers.get("last-modified") || "";
  return tag.replace(/^W\//, "").replace(/"/g, "").trim();
}
// A short, stable id for the list of fingerprints (cyrb53: plain JS, works on http:// too).
function hash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}
// -> the build id, or "" when any fingerprint is missing (then: unversioned, no update watching)
export async function currentBuild() {
  try {
    const tags = await Promise.all(MODULES.map(etagOf));
    if (tags.some((t) => !t)) return "";
    return hash(tags.join("|"));
  } catch {
    return "";
  }
}

export async function loadGame() {
  const build = await currentBuild();
  const mod = await import(build ? `./game.js?v=${encodeURIComponent(build)}` : "./game.js");
  return { createGame: mod.createGame, fetchGlobalBoard: mod.fetchGlobalBoard, fetchGlobalBoardFull: mod.fetchGlobalBoardFull, initChrome: mod.initChrome, postForslag: mod.postForslag, build };
}

/**
 * Poll for a newer build. `isIdle()` says whether reloading right now is
 * harmless; `reloadUrl()` gives the URL to come back to (defaults to the
 * current one). Returns a stop() function.
 */
export function watchUpdates(build, { isIdle, reloadUrl } = {}) {
  if (!build) return () => {};
  let stopped = false, notified = false, timer = 0;
  const target = () => (reloadUrl && reloadUrl()) || location.href;
  // (marked for game.js: an update reload is not a new visit in the anonymous counters)
  const reload = () => { stopped = true; try { sessionStorage.setItem("livboj-update-reload", "1"); } catch {} location.replace(target()); };

  async function check() {
    if (stopped || document.hidden) return;
    const now = await currentBuild();
    if (!now || now === build || stopped) return;
    if (isIdle && isIdle()) { reload(); return; }
    if (!notified) { notified = true; showBanner(reload); }
  }
  timer = setInterval(check, CHECK_MS);
  const onVisible = () => { if (!document.hidden) check(); };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);
  return () => { stopped = true; clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("focus", onVisible); };
}

function showBanner(onUpdate) {
  if (document.getElementById("livboj-update")) return;
  const bar = document.createElement("div");
  bar.id = "livboj-update";
  bar.setAttribute("role", "status");
  bar.style.cssText = "position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:1000;display:flex;gap:12px;align-items:center;" +
    "padding:12px 14px 12px 18px;border-radius:14px;background:rgba(9,40,56,0.92);color:#eaf6ff;border:1px solid rgba(255,255,255,0.14);" +
    "box-shadow:0 18px 50px rgba(0,0,0,0.55);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);font:600 14px system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;max-width:92vw";
  const text = document.createElement("span");
  text.textContent = "🛟 Ny version av spelet finns. Uppdatera mellan två spel så alla kör samma version.";
  const btn = document.createElement("button");
  btn.type = "button"; btn.textContent = "Uppdatera nu";
  btn.style.cssText = "border:none;border-radius:10px;padding:9px 13px;font:800 14px system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#fff;cursor:pointer;" +
    "background:linear-gradient(180deg,#ff7a3d,#f4571d);box-shadow:0 6px 16px rgba(244,87,29,0.35);white-space:nowrap";
  btn.onclick = onUpdate;
  const close = document.createElement("button");
  close.type = "button"; close.textContent = "×"; close.setAttribute("aria-label", "Stäng");
  close.style.cssText = "border:none;background:none;color:#9fc4d6;font-size:20px;line-height:1;cursor:pointer;padding:0 2px";
  close.onclick = () => bar.remove();
  bar.append(text, btn, close);
  document.body.appendChild(bar);
}

// boot.js — versioned loader + update watcher for Livbojen.
//
// GitHub Pages serves every file with "cache for 10 minutes", so a normal
// reload can keep an old game.js. We ask the server for game.js's current
// fingerprint (its ETag) with caching disabled and import game.js?v=<etag>:
// every build has its own URL, so a page load always runs the latest code
// without anyone maintaining a version number.
//
// The same check repeats while the tab is open. A new build reloads the page
// silently if nothing is going on yet (menu / setup screen); otherwise a small
// banner offers "Uppdatera nu", because reloading a host mid-game would end
// the round for everyone.

const CHECK_MS = 60 * 1000;

export async function currentBuild() {
  try {
    const r = await fetch(`game.js?_=${Date.now()}`, { method: "HEAD", cache: "no-store" });
    if (!r.ok) return "";
    const tag = r.headers.get("etag") || r.headers.get("last-modified") || "";
    return tag.replace(/^W\//, "").replace(/"/g, "").trim();
  } catch {
    return "";
  }
}

export async function loadGame() {
  const build = await currentBuild();
  const mod = await import(build ? `./game.js?v=${encodeURIComponent(build)}` : "./game.js");
  return { createGame: mod.createGame, fetchGlobalBoard: mod.fetchGlobalBoard, build };
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
  const reload = () => { stopped = true; location.replace(target()); };

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

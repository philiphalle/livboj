# livboj 🛟

A tiny browser game: rescue swimmers with a life ring before they sink.

## Play
Hosted on GitHub Pages: **https://philiphalle.github.io/livboj/**

## Controls
- **Arrow keys** — move the life ring
- **Space** — dash (short speed boost) / advance menus

## How it works
Touch a swimmer with the ring to rescue them. Each swimmer has a countdown
ring (green → red); if it runs out they sink and count as a miss. Clear the
rescue quota before the timer ends to advance. Five levels, each faster and
busier than the last.

## Tech
Single self-contained `index.html` — HTML5 canvas + vanilla JS, no build step.
Open the file directly in a browser, or serve the folder. Rendering is
deliberately simple for v1; polish is the next pass.

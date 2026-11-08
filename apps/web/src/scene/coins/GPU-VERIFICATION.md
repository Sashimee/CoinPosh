# Coin field: GPU verification (T-1.05, against P-2)

The coin field renders through `WebGPURenderer` with TSL node materials. Headless Chromium
can only prove the WebGL2 fallback: its software adapter (SwiftShader) hands out a WebGPU
device and then loses it within about a second (seen as `GPUDevice.lost` with reason
`destroyed` or `unknown`, `A valid external Instance reference no longer exists`, and as
unhandled `Instance dropped in popErrorScope` rejections from three.js). Chromium then restarts
its GPU process, so `getContext('webgl2')` returns null for roughly 3 s. The automated check below covers everything up to that line.
The WebGPU picture itself needs a person on real GPU hardware.

## 1. Automated evidence (any machine, no GPU needed)

```sh
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs \
CHROMIUM_PATH=/optional/path/to/chrome \
node apps/web/src/scene/coins/lookdev/verify.mjs /tmp/coin-verify
```

Playwright is not a repo dependency yet (deps are frozen this wave), so point
`PLAYWRIGHT_MODULE` at any installed copy (`npx -y playwright@1.64.1 --version` puts one in
`~/.npm/_npx/*/node_modules/playwright`). The script starts its own Vite server, renders at
1280x800 with deviceScaleFactor 1, writes one PNG per scenario plus `report.json`, and exits
non-zero if any scenario fails.

| Scenario               | Asserts                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `webgl-hero`           | all six tiers render on WebGL2, 6 draw calls, highlights present, no console errors      |
| `webgl-macro-gold`     | gold reads as chromatic metal, not grey                                                  |
| `webgl-macro-heirloom` | heirloom spans at least 6 of 12 hue buckets (prismatic)                                  |
| `webgl-edge-silver`    | reeded edge view renders                                                                 |
| `webgl-pile`           | 222 coins mix near and far LOD, at most 12 colour draw calls                             |
| `webgl-context-loss`   | `WEBGL_lose_context` after 8 frames: one `[coins]` warning, rebuild on WebGL2, renders   |
| `webgpu-hero`          | renders on WebGPU, or loses the device and falls back to WebGL2 with a `[coins]` warning |
| `webgpu-device-loss`   | `device.destroy()` after 8 frames: one `[coins]` warning, rebuild on WebGL2, renders     |
| `table-front-row`      | see below, high quality                                                                  |
| `table-front-row-low`  | see below, low quality                                                                   |

The two `table-*` scenarios open `lookdev/table.html`: the real Riviera venue and post stack at
390x844, a seeded front row of copper, silver and gold at the lip, and a heap behind it. They
save `<name>-crop.png` (the front row) and measure the HDR scene pass per coin tier with the
other groups hidden. They assert:

- no copper, silver, gold or platinum coin peaks above 2.0 scene-linear, and diamond and
  heirloom stay under 3.5; no tier exceeds the bloom threshold by more than the sunburst does.
  Diamond and heirloom are the special tiers with their own sparkle, so their
  `highlightCeiling` is higher (3.2 against 1.6 to 1.8);
- every front-row tier has a rim and relief spread (luma p98 minus p10 of at least 30) without
  clipping to white;
- copper and gold keep their hue (copper 8 to 30 degrees, gold 30 to 52, both saturated), and
  silver reads neutral: blue no stronger than red, saturation under 0.3 and under 0.7 of gold's.

"No console errors" includes unhandled rejections: three.js leaves `popErrorScope()` rejections
unhandled when the device dies mid pipeline build, and `watchGpuLoss` claims those as the loss
signal instead of letting them surface.

## 2. Human check on GPU hardware (closes P-2 for the coin field)

Run `pnpm dev` and open `http://localhost:5173/src/scene/coins/lookdev/` in each browser below
with DevTools open. Record browser, OS, GPU (from `chrome://gpu` or `about:support`) and pass or
fail per row.

Browsers: desktop Chrome or Edge (Windows or macOS, discrete or integrated GPU), Safari 26+ on
macOS, Chrome on a mid-range Android phone, Safari on an iPhone 12 or newer.

| #   | Open                                     | Pass when                                                                                                                                                                                                                      |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `?t=1`                                   | console shows `[coins] lookdev boot 1 rendering on webgpu`; `window.__lookdev` has `backend: "webgpu"`, `boots: 1`, `losses: []`; no console errors or warnings from `[coins]`                                                 |
| 2   | `?t=1` (same page)                       | the frame matches `webgpu-hero.png` from section 1: copper, silver, gold, platinum, diamond, heirloom left to right, top to bottom                                                                                             |
| 3   | `?scene=macro&tier=gold`                 | lathe-turned highlights run as concentric arcs around the gold face and sweep as the coin turns, with no radial pinwheel spokes; the CP monogram and laurel read as raised relief with a lit upper rim and a soft lower shadow |
| 4   | `?scene=macro&tier=heirloom`             | thin-film colour shifts across the face as it turns, not a static rainbow decal; sparkle points twinkle                                                                                                                        |
| 5   | `?scene=edge&tier=silver`                | the reeded edge shows individual ridges catching light; no shimmer or z-fighting where the edge meets the face                                                                                                                 |
| 6   | `?scene=pile` then `?scene=pile&zoom=2`  | no visible pop as coins swap between near and far LOD while the window is resized; contact shadows sit under every coin                                                                                                        |
| 7   | `?scene=pile` with the Performance panel | steady 60 fps on the phone rows; `__lookdev.stats.drawCalls` is 12 or fewer                                                                                                                                                    |
| 8   | `?t=1&loseAfter=60`                      | exactly one warning `[coins] WebGPU device-lost (reason: destroyed): ... Rebuilding the coin field on WebGL2.`, then `boots: 2`, `backend: "webgl2"`, and the six coins are back                                               |
| 9   | `?backend=webgl&t=1`                     | same frame as row 2 on WebGL2, for side-by-side colour comparison (AgX, exposure 1.05)                                                                                                                                         |

If row 1 reports `webgl2` on a browser that should have WebGPU, note the
`WebGPURenderer: WebGPU is not available, running under WebGL2 backend.` warning and the
browser version; the field still has to pass rows 2 to 7 on WebGL2.

## 3. What the integration owes (P-19, P-20)

- Wrap the stage renderer with `watchGpuLoss(renderer, onLost, { rejections: window })`, stop
  the loop in `onLost`, log `describeGpuLoss(loss, next)` with `console.warn`, call
  `watch.stop()` before `renderer.dispose()`, then rebuild on a fresh canvas.
- Rebuild on WebGL2 with `acquireWebGL2Context(makeCanvas)` and pass its `canvas` and `context`
  to `new WebGPURenderer({ canvas, context, forceWebGL: true })`; then call `CoinField.bake` on
  the new renderer, since the emboss textures died with the old device.
- Cap rebuilds (the lookdev stops after 3 boots and logs a `console.error` asking for a reload).

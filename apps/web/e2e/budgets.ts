/**
 * Every threshold the perf gate enforces, with where it comes from. Device budgets come from
 * docs/plan/01-ARCHITECTURE.md ("Rendering architecture and performance budgets") and the
 * T-1.17 acceptance in docs/plan/04-ROADMAP.md. CI has no GPU: chromium renders WebGL2 on
 * SwiftShader, a CPU rasteriser that draws this table at single-digit fps, so the 60 fps phone
 * budget cannot be measured there. The frame gates below are regression floors calibrated on
 * SwiftShader instead; a change that makes a frame meaningfully more expensive moves them.
 * Recalibrate from perf-report/frames.json, never to turn a red run green.
 */

/** 01-ARCHITECTURE: 60 fps on iPhone 12 / Pixel 6a. Reported beside the CI numbers, not gated. */
export const DEVICE_FRAME_BUDGET_MS = 1000 / 60;

/** 04-ROADMAP T-1.17 and the 3 s TTI budget: navigation start to the first coin in the sim. */
export const BOOT_TO_FIRST_DROP_MS = 3_000;

/**
 * P-293: boot.perf gates the median of this many cold boots, each in a fresh browser context,
 * against BOOT_TO_FIRST_DROP_MS. On SwiftShader one frame of about 1.1 s follows the first tap;
 * when it lands before the sync that counts the coin, a run reads about 3.07 s instead of 2.1 s
 * (1 of 5 runs on 2026-11-13 at load 9 on 10 cores), so a single sample would flake.
 */
export const BOOT_RUNS = 5;

/** The CI frame sample: twenty seconds of play at one drop a second after a three-second warm-up. */
export const FRAME_SAMPLE = {
  warmupMs: 3_000,
  sampleMs: 20_000,
  dropEveryMs: 1_000,
  query: '?quality=low',
} as const;

/**
 * SwiftShader floors at 390x844, DPR 1, quality low. Calibrated on 2026-11-08 on a 10-core dev
 * box under load (8 sample runs): 4.5 to 5.4 fps, p50 frame 200 to 233 ms, p95 317 to 467 ms,
 * zero long-animation-frame blocking (the frame waits on GPU-process raster, not main-thread JS).
 * The fps and p95 floors leave about a third of headroom for a 4-vCPU ubuntu-24.04 runner; the
 * blocking cap is where main-thread work would start to own the frame.
 */
export const SWIFTSHADER_FRAMES = {
  minFps: 3,
  maxP95FrameMs: 600,
  /** Long-animation-frame blocking time per second of play: main-thread JS, not raster. */
  maxBlockingMsPerSecond: 100,
} as const;

/**
 * JS heap after the sample, measured at 21 to 36 MB. Not a GPU number: the 256 MB GPU budget in
 * 01-ARCHITECTURE needs a real device.
 */
export const MAX_JS_HEAP_MB = 64;

/** 01-ARCHITECTURE: initial JS 350 KB gzip with the 3D chunk lazy. Sizes are gzip bytes. */
export const BUNDLE_BUDGETS = {
  initialJs: 350 * 1024,
  /** The three.webgpu chunk: lazy by rule, and capped so a three upgrade is a visible decision. */
  threeChunk: 235 * 1024,
  /** The sim worker JS alone; Rapier's wasm is a separate asset (64.1 kB gzip on 2026-11-13). */
  workerJs: 92 * 1024,
  /**
   * Rapier's wasm as it ships: a separate `rapier_wasm3d_bg-*.wasm` asset streamed by the
   * sim worker since P-121 (1,151.9 kB gzip on 2026-11-13).
   */
  wasm: 1_600 * 1024,
  /**
   * P-682 split the single 118 kB "other lazy" budget (history: 95 kB, re-baselined to 113 kB on
   * 2026-11-13 by founder call to favour dev speed, then 118 kB by P-578 at 117.7 kB of feature
   * growth) into the three boot-lazy rows below, so each group's growth shows in its own row and
   * P-641's on-tap features get rows of their own instead of eating shared slack. Each budget sits
   * about 10 % above the Demo build of feat/build-loop b1138ce (2026-11-15), as P-682 asks; that
   * headroom is why the three add up to 134 kB where the old group was 118 kB. No byte was added:
   * the old group measured 118.7 kB, the three rows 118.8 kB together.
   *
   * The renderer, the Riviera venue and the sim bridge with what they import (coins, emboss,
   * geometry, look, tiers): the lazy JS the first frame waits on. 45.5 kB gzip, of which riviera
   * 14.9, stage 12.9, the sim bridge 5.4, emboss 5.2, coins 3.9 and table geometry 3.1 kB.
   */
  stageLazyJs: 51 * 1024,
  /**
   * Crates (unbox cinematic, reveal card, odds sheet: the 34.4 kB mount chunk), vfx 21.7 and game
   * systems 10.9 kB: imported beside the stage but first used once the table is up. 66.5 kB gzip.
   * The one cut found, three's ConvexHull in unbox/shot.ts (about 2.6 kB), is queued with
   * vfx-juice.
   *
   * Growth plan (P-728). The group read 69.3 kB on 35068b5 and 70.7 kB (94 %, 4.3 kB left) on
   * d08b66c, so it has no room for a theme's client half. The wiring tasks that land beside it,
   * T-14.12 (world: the Concierge) and T-11.15 (collecting), may add only the feature seam here:
   * game/features.ts mountGameFeatures and the registry list, under 1 kB together. Each theme
   * they mount is imported dynamically from that list, so it ships as its own lazy chunk, and
   * gets a row of its own in bundle-size.ts sized at wiring time, as the safes and capsule docks
   * did. Rolldown estimates on 2026-11-15 (minified, gzip, three and i18next external): the
   * Concierge brain (game/concierge) 3.9 kB and its voice (audio/concierge) 2.7 kB, plus the
   * T-14.03 portrait and speech card and their concierge.json strings; collecting audio
   * (audio/collecting) 6.0 kB, plus the T-11.08 prize flow and vfx/prizes and the T-11.09
   * collection book. Either theme pulled in statically through game/systems or vfx would tip
   * this row past its tolerance. This budget does not grow for them.
   */
  postTableLazyJs: 75 * 1024,
  /**
   * Every lazy JS chunk no other row claims: today the session clock 3.5, the Turnstile overlay
   * 1.9 and its loader 1.5 kB, 6.8 kB gzip. A new on-demand feature belongs in a row of its own.
   */
  otherLazyJs: 8 * 1024,
  /**
   * P-707: feature strings loaded through loadNamespace or a feature's own per-language import,
   * one chunk per locale file. A player fetches the language they read (plus the EN fallback,
   * which a FR or DE player also takes and an EN player already has), never all three, so the
   * row counts the largest single locale of each namespace rather than EN + FR + DE. On
   * 2026-11-15, after P-752 split fair per language: 3.5 kB (fair 1.96, account 1.63 at their
   * largest locale), 78 % of this budget.
   */
  i18nNamespaces: 4.5 * 1024,
  /**
   * The account UI (T-10.04, P-577), apart from the net layer's 7.5 kB sign-in chunks: the prompt
   * clock imported after boot, the Settings section and gentle prompt on first need, and the
   * progress choice on a sign-in that finds two saves. 10.8 kB gzip on 2026-11-15. P-707 moved
   * its FR and DE strings (1.6 kB, one per player) to the i18n namespaces row, so the budget
   * came down from 13 kB.
   */
  accountUi: 12 * 1024,
  /**
   * The safes dock (T-2.01-p3): controller, countdowns and strings behind the HUD's Safes badge,
   * imported once the table is up. 6.3 kB gzip on 2026-11-14.
   */
  safesDock: 6.5 * 1024,
  /**
   * The safes sheet and the dial-and-door cinematic, imported on the first Safes press.
   * 6.6 kB gzip on 2026-11-14.
   */
  safesSheet: 7 * 1024,
  /**
   * The capsule machine dock (T-2.03-p2b): controller, strings and the Capsules door, imported
   * once the table is up. 5.3 kB gzip on 2026-11-15.
   */
  gachaDock: 6 * 1024,
  /**
   * The capsule machine sheet with its 3D stage, and the odds panel it links to, each imported on
   * first press. 25.4 kB gzip on 2026-11-15 with all three fair locales inside the odds chunk;
   * P-752 moved them to the i18n namespaces row (one per player): 20.6 kB, so the budget came
   * down from 26.5 kB.
   */
  gachaSheet: 23.5 * 1024,
  /**
   * P-425 / P-102: the self-hosted woff2 subsets in public/fonts, counted as served (woff2 is
   * already Brotli inside, so gzip would only hide the bytes). Cormorant Garamond 600, 700 and
   * 700 italic plus Manrope 500 and 700: 85.3 kB on 2026-11-14. P-102 caps the payload at 120 kB;
   * the budget sits just above the build, so even the 5 % tolerance stays well under that cap.
   */
  fonts: 90 * 1024,
} as const;

/** P-124: a budget fails once exceeded by more than this share. */
export const BUNDLE_TOLERANCE = 0.05;

/**
 * P-728: a row at this share of its budget or more reads 'near' in bundle:check. It never fails
 * the gate; it flags the rows the next feature can tip over, so the headroom is planned for.
 */
export const BUNDLE_NEAR = 0.9;

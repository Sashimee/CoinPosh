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
  /** Every other lazy JS chunk together. */
  otherLazyJs: 95 * 1024,
} as const;

/** P-124: a budget fails once exceeded by more than this share. */
export const BUNDLE_TOLERANCE = 0.05;

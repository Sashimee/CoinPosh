/** A rAF timestamp this far outside the loop's lifetime is from another clock (seconds, Date). */
export const CLOCK_SKEW_LIMIT_MS = 1000;

/**
 * Throws unless `nowMs` reads as a requestAnimationFrame timestamp on the `performance.now()`
 * timebase: not after the present, and not before the renderer that draws it was built.
 *
 * It is bounded by the build time rather than by the present because the first frame after a
 * (re)build can start long before `render` is reached: its frame listeners, a shader compile or
 * a software GPU can hold that one frame for seconds.
 */
export function assertFrameTimestamp(nowMs: number, builtAtMs: number, presentMs: number): void {
  if (nowMs >= builtAtMs - CLOCK_SKEW_LIMIT_MS && nowMs <= presentMs + CLOCK_SKEW_LIMIT_MS) return;
  throw new Error(
    `AdaptiveRendering.render(nowMs) needs the requestAnimationFrame timestamp in ms; got ${nowMs}, while the renderer was built at ${builtAtMs.toFixed(0)} ms and performance.now() is ${presentMs.toFixed(0)} ms`,
  );
}

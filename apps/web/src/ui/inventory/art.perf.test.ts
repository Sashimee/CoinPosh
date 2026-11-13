import { describe, expect, it } from 'vitest';
import { ART_SIZE, encodeFrame, swayFrames } from './art.ts';

/**
 * Each sway frame is encoded on the main thread, one per animation frame, while the stage keeps
 * rendering. Measured on a desktop, so a mid phone at roughly 5x slower still fits beside it.
 */
const FRAME_BUDGET_MS = 2;
const SUPERSAMPLE = 2;
const FRAMES = swayFrames('webgpu');
/**
 * Every frame is encoded this many times and keeps its fastest time: preemption on a shared
 * runner only ever adds time, as in shot.perf.test.ts.
 */
const ROUNDS = 15;

function percentile(samples: readonly number[], share: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? Infinity;
}

/** A lit disc over a clear background, with HDR highlights, like a hero readback. */
function heroReadback(): Float32Array {
  const edge = ART_SIZE * SUPERSAMPLE;
  const pixels = new Float32Array(edge * edge * 4);
  let seed = 7;
  const noise = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let y = 0; y < edge; y++) {
    for (let x = 0; x < edge; x++) {
      const i = (y * edge + x) * 4;
      const inside = Math.hypot(x - edge / 2, y - edge / 2) < edge * 0.42;
      pixels[i] = noise() * 3;
      pixels[i + 1] = noise() * 2;
      pixels[i + 2] = noise();
      pixels[i + 3] = inside ? 1 : 0;
    }
  }
  return pixels;
}

describe('card art encode main-thread cost', () => {
  it(`encodes one supersampled sway frame in under ${FRAME_BUDGET_MS} ms`, () => {
    const pixels = heroReadback();
    const sheet = new Uint8ClampedArray(ART_SIZE * ART_SIZE * FRAMES * 4);
    const encodeMs = (frame: number): number => {
      const start = performance.now();
      encodeFrame(pixels, ART_SIZE, SUPERSAMPLE, frame % 2 === 1, sheet, frame * ART_SIZE);
      return performance.now() - start;
    };
    for (let frame = 0; frame < FRAMES; frame++) encodeMs(frame);

    const fastest = Array.from({ length: FRAMES }, () => Infinity);
    for (let round = 0; round < ROUNDS; round++) {
      for (let frame = 0; frame < FRAMES; frame++) {
        fastest[frame] = Math.min(fastest[frame] ?? Infinity, encodeMs(frame));
      }
    }
    const median = percentile(fastest, 0.5);
    const worst = Math.max(...fastest);
    console.info(
      `[cardArt] encode of a ${ART_SIZE * SUPERSAMPLE}² float frame over ${FRAMES} frames: median ${median.toFixed(3)} ms, worst ${worst.toFixed(3)} ms`,
    );
    expect(median).toBeLessThan(FRAME_BUDGET_MS * 0.75);
    expect(worst).toBeLessThan(FRAME_BUDGET_MS);
  });
});

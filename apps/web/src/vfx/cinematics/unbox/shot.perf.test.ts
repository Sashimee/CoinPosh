import { describe, expect, it } from 'vitest';
import { rivieraCameraPreset } from '../../../scene/venues/riviera/layout.ts';
import { unboxShot, warmUnboxShots } from './shot.ts';

/** The fit runs on the frame a crate reveal mounts or the screen turns, so it must fit a frame. */
const FIT_BUDGET_MS = 2;
const MEMO_BUDGET_MS = 0.05;

function percentile(samples: readonly number[], share: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? Infinity;
}

describe('unboxShot main-thread cost', () => {
  it(`frames a new aspect in under ${FIT_BUDGET_MS} ms once the sweeps are warm`, () => {
    warmUnboxShots();
    for (const reducedMotion of [false, true]) {
      const samples: number[] = [];
      for (let i = 0; i < 160; i++) {
        const aspect = 0.42 + i * 0.0125;
        const framing = rivieraCameraPreset(aspect);
        const start = performance.now();
        unboxShot(framing, aspect, reducedMotion);
        samples.push(performance.now() - start);
      }
      expect(percentile(samples, 0.5)).toBeLessThan(FIT_BUDGET_MS / 2);
      expect(percentile(samples, 0.95)).toBeLessThan(FIT_BUDGET_MS);
    }
  });

  it(`hands back a memoized shot in under ${MEMO_BUDGET_MS} ms`, () => {
    for (const [aspect, reducedMotion] of [
      [390 / 844, false],
      [844 / 390, false],
      [390 / 844, true],
    ] as const) {
      const framing = rivieraCameraPreset(aspect);
      unboxShot(framing, aspect, reducedMotion);
      const samples: number[] = [];
      for (let i = 0; i < 200; i++) {
        const start = performance.now();
        unboxShot(framing, aspect, reducedMotion);
        samples.push(performance.now() - start);
      }
      expect(percentile(samples, 0.95)).toBeLessThan(MEMO_BUDGET_MS);
    }
  });
});

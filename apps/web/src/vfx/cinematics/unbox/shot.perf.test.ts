import { describe, expect, it } from 'vitest';
import { rivieraCameraPreset } from '../../../scene/venues/riviera/layout.ts';
import { unboxShot, warmUnboxShots } from './shot.ts';

/** The fit runs on the frame a crate reveal mounts or the screen turns, so it must fit a frame. */
const FIT_BUDGET_MS = 2;
const MEMO_BUDGET_MS = 0.05;
const FIT_ASPECTS = Array.from({ length: 40 }, (_, i) => 0.42 + i * 0.05);
/**
 * Every aspect is framed cold this many times and keeps its fastest time. Preemption and a noisy
 * neighbour on a shared runner only ever add time, and spreading each aspect's rounds across the
 * whole measurement lets a slow spell of the host spoil some rounds but not all of them (#150).
 */
const FIT_ROUNDS = 15;

function percentile(samples: readonly number[], share: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? Infinity;
}

describe('unboxShot main-thread cost', () => {
  it(`frames a new aspect in under ${FIT_BUDGET_MS} ms once the sweeps are warm`, () => {
    warmUnboxShots();
    let calls = 0;
    const coldFitMs = (aspect: number, reducedMotion: boolean): number => {
      calls += 1;
      // A billionth apart, every call is a new memo key, so each one pays for the whole fit.
      const fresh = aspect + calls * 1e-9;
      const framing = rivieraCameraPreset(fresh);
      const start = performance.now();
      unboxShot(framing, fresh, reducedMotion);
      return performance.now() - start;
    };
    const variants = [false, true] as const;
    for (const reducedMotion of variants)
      for (const aspect of FIT_ASPECTS) coldFitMs(aspect, reducedMotion);

    const fastest = variants.map(() => FIT_ASPECTS.map(() => Infinity));
    for (let round = 0; round < FIT_ROUNDS; round++) {
      variants.forEach((reducedMotion, v) => {
        const best = fastest[v] ?? [];
        FIT_ASPECTS.forEach((aspect, a) => {
          best[a] = Math.min(best[a] ?? Infinity, coldFitMs(aspect, reducedMotion));
        });
      });
    }

    variants.forEach((reducedMotion, v) => {
      const best = fastest[v] ?? [];
      const median = percentile(best, 0.5);
      const worst = Math.max(...best);
      console.info(
        `[unboxShot] ${reducedMotion ? 'reduced' : 'full'} fit over ${best.length} aspects: median ${median.toFixed(3)} ms, worst ${worst.toFixed(3)} ms`,
      );
      expect(median).toBeLessThan(FIT_BUDGET_MS / 2);
      expect(worst).toBeLessThan(FIT_BUDGET_MS);
    });
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

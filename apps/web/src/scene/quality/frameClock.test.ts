import { describe, expect, it } from 'vitest';
import { assertFrameTimestamp, CLOCK_SKEW_LIMIT_MS } from './frameClock.ts';

describe('assertFrameTimestamp', () => {
  it('accepts a first frame whose listeners held it for seconds before render', () => {
    const builtAt = 4000;
    const frameStart = 4016;
    expect(() => {
      assertFrameTimestamp(frameStart, builtAt, frameStart + 3000);
    }).not.toThrow();
  });

  it('accepts a frame that began just before the renderer finished building', () => {
    expect(() => {
      assertFrameTimestamp(3990, 4000, 4005);
    }).not.toThrow();
  });

  it.each([
    ['seconds', 4.016],
    ['Date.now()', 1_763_000_000_000],
    ['NaN', Number.NaN],
    ['a stale timestamp from before the build', 4000 - CLOCK_SKEW_LIMIT_MS - 1],
  ])('rejects %s', (_name, nowMs) => {
    expect(() => {
      assertFrameTimestamp(nowMs, 4000, 4100);
    }).toThrow(/requestAnimationFrame timestamp/);
  });
});

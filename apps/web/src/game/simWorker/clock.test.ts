import { describe, expect, it } from 'vitest';
import { RenderClock } from './clock.ts';

const TICK_MS = 1000 / 60;

/** Seeded jitter in [0, 1), so every run sees the same delivery schedule. */
function jitter(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

interface Run {
  readonly ticks: number[];
  readonly starved: number;
}

/**
 * Sim frames arrive at 60 Hz with `latencyMs` plus up to `jitterMs` of delivery noise while a
 * display renders at `displayHz`; returns the tick drawn on every display frame after warm-up.
 */
function render(displayHz: number, latencyMs: number, jitterMs: number, seconds = 4): Run {
  const clock = new RenderClock({ tickMs: TICK_MS });
  const noise = jitter(0xc0195051);
  const frameMs = 1000 / displayHz;
  const arrivals: number[] = [];
  for (let tick = 0; tick <= seconds * 60 + 10; tick += 1) {
    arrivals.push(tick * TICK_MS + latencyMs + noise() * jitterMs);
  }
  const ticks: number[] = [];
  let starved = 0;
  let next = 0;
  let newest = -1;
  for (let now = 0; now < seconds * 1000; now += frameMs) {
    while (next < arrivals.length && (arrivals[next] ?? Infinity) <= now) {
      clock.observe(next, 0, arrivals[next] ?? now);
      newest = next;
      next += 1;
    }
    const tick = clock.renderTick(now);
    if (tick === null || now < 1000) continue;
    if (tick >= newest) starved += 1;
    ticks.push(tick);
  }
  return { ticks, starved };
}

function steps(ticks: readonly number[]): number[] {
  return ticks.slice(1).map((tick, i) => tick - (ticks[i] ?? 0));
}

describe('RenderClock', () => {
  it('returns null until a frame is observed', () => {
    expect(new RenderClock({ tickMs: TICK_MS }).renderTick(10)).toBeNull();
    expect(() => new RenderClock({ tickMs: 0 })).toThrow(/positive/);
  });

  it('advances exactly half a tick per frame on a 120 Hz display, never starving', () => {
    const { ticks, starved } = render(120, 3, 4);
    expect(ticks.length).toBeGreaterThan(300);
    expect(starved).toBe(0);
    for (const step of steps(ticks)) expect(step).toBeCloseTo(0.5, 1);
    const spread = Math.max(...steps(ticks)) - Math.min(...steps(ticks));
    expect(spread).toBeLessThan(0.5 * 0.05);
  });

  it('advances one tick per frame at 60 Hz and 0.4167 at 144 Hz', () => {
    for (const [hz, expected] of [
      [60, 1],
      [144, 60 / 144],
    ] as const) {
      const { ticks, starved } = render(hz, 2, 3);
      expect(starved).toBe(0);
      for (const step of steps(ticks)) expect(step).toBeCloseTo(expected, 1);
    }
  });

  it('trails the newest frame by about one tick plus the delivery jitter', () => {
    const calm = new RenderClock({ tickMs: TICK_MS });
    const noisy = new RenderClock({ tickMs: TICK_MS });
    const noise = jitter(7);
    for (let tick = 0; tick < 60; tick += 1) {
      calm.observe(tick, 0, tick * TICK_MS + 2);
      noisy.observe(tick, 0, tick * TICK_MS + 2 + noise() * 12);
    }
    expect(calm.delayTicks).toBeCloseTo(1.1, 5);
    expect(noisy.delayTicks).toBeGreaterThan(1.5);
    expect(noisy.delayTicks).toBeLessThan(1.1 + 12 / TICK_MS);
  });

  it('holds at the newest frame rather than extrapolating when frames stop', () => {
    const clock = new RenderClock({ tickMs: TICK_MS });
    for (let tick = 0; tick <= 10; tick += 1) clock.observe(tick, 0, tick * TICK_MS);
    expect(clock.renderTick(10 * TICK_MS)).toBeCloseTo(10 - 1.1, 5);
    expect(clock.renderTick(30 * TICK_MS)).toBe(10);
    expect(clock.renderTick(60 * TICK_MS)).toBe(10);
  });

  it('never runs backwards when a late frame pushes the estimate back', () => {
    const clock = new RenderClock({ tickMs: TICK_MS });
    for (let tick = 0; tick < 30; tick += 1) clock.observe(tick, 0, tick * TICK_MS);
    let last = clock.renderTick(29 * TICK_MS) ?? 0;
    for (let tick = 30; tick < 60; tick += 1) {
      const now = tick * TICK_MS + 4;
      clock.observe(tick, 0, now);
      const drawn = clock.renderTick(now) ?? 0;
      expect(drawn).toBeGreaterThanOrEqual(last);
      last = drawn;
    }
  });

  it('slews small corrections and snaps large ones', () => {
    const clock = new RenderClock({ tickMs: TICK_MS });
    for (let tick = 0; tick < 30; tick += 1) clock.observe(tick, 0, tick * TICK_MS + 5);
    clock.renderTick(30 * TICK_MS);
    for (let tick = 30; tick < 120; tick += 1) {
      const now = tick * TICK_MS + 5;
      clock.observe(tick, 0, now);
      clock.renderTick(now);
    }
    expect(clock.snaps).toBe(0);
    for (let tick = 120; tick < 180; tick += 1) {
      const now = tick * TICK_MS + 400;
      clock.observe(tick, 0, now);
      clock.renderTick(now);
    }
    expect(clock.snaps).toBe(1);
  });

  it('holds the render point through a pause and never steps back when a new epoch resumes', () => {
    const clock = new RenderClock({ tickMs: TICK_MS });
    const held = 60;
    for (let tick = 0; tick <= held; tick += 1) {
      clock.observe(tick, 0, tick * TICK_MS);
      clock.renderTick(tick * TICK_MS);
    }
    let now = held * TICK_MS;
    for (let frame = 0; frame < 120; frame += 1) {
      now += 1000 / 120;
      expect(clock.renderTick(now)).toBeLessThanOrEqual(held);
    }
    expect(clock.renderTick(now)).toBe(held);
    let last = held;
    now += 10_000;
    for (let tick = held + 1; tick < held + 30; tick += 1) {
      now += TICK_MS;
      clock.observe(tick, 1, now);
      for (const offset of [0, TICK_MS / 2]) {
        const drawn = clock.renderTick(now + offset) ?? -Infinity;
        expect(drawn).toBeGreaterThanOrEqual(last);
        last = drawn;
      }
    }
    expect(last).toBeGreaterThan(held + 25);
  });

  it('restarts its estimate on a new epoch so a resumed sim is drawn at once', () => {
    const clock = new RenderClock({ tickMs: TICK_MS });
    for (let tick = 0; tick < 60; tick += 1) clock.observe(tick, 0, tick * TICK_MS);
    const pausedFor = 10_000;
    const now = 60 * TICK_MS + pausedFor;
    clock.observe(60, 1, now);
    clock.observe(61, 1, now + TICK_MS);
    expect(clock.renderTick(now + TICK_MS)).toBeCloseTo(61 - 1.1, 5);
  });
});

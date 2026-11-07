import { describe, expect, it } from 'vitest';
import { DynamicResolution, type ResolutionEvent } from './dynamicResolution.ts';

const VSYNC_MS = 1000 / 60;

interface Device {
  /** CPU-side frame cost that does not shrink with resolution. */
  readonly fixedMs: number;
  /** GPU cost of one frame at scale 1; scales with pixel count (scale squared). */
  readonly gpuFullMs: number;
}

/** A 60 Hz display: a frame that misses vsync waits for the next one, as browsers present. */
function presentedFrameMs(device: Device, scale: number): number {
  const work = device.fixedMs + device.gpuFullMs * scale * scale;
  return Math.max(1, Math.ceil(work / VSYNC_MS - 1e-9)) * VSYNC_MS;
}

function simulate(
  controller: DynamicResolution,
  device: (elapsedMs: number) => Device,
  durationMs: number,
): { frames: { at: number; ms: number; scale: number }[]; events: ResolutionEvent[] } {
  const frames: { at: number; ms: number; scale: number }[] = [];
  const events: ResolutionEvent[] = [];
  let elapsed = 0;
  while (elapsed < durationMs) {
    const ms = presentedFrameMs(device(elapsed), controller.scale);
    elapsed += ms;
    frames.push({ at: elapsed, ms, scale: controller.scale });
    const event = controller.sample(ms);
    if (event !== null) events.push(event);
  }
  return { frames, events };
}

function fpsBetween(frames: { at: number; ms: number }[], from: number, to: number): number {
  const window = frames.filter((frame) => frame.at > from && frame.at <= to);
  const total = window.reduce((sum, frame) => sum + frame.ms, 0);
  return (window.length * 1000) / total;
}

describe('DynamicResolution', () => {
  it('rejects bounds that leave no valid scale', () => {
    expect(() => new DynamicResolution({ minScale: 0, maxScale: 1 })).toThrow(/minScale/);
    expect(() => new DynamicResolution({ minScale: 0.8, maxScale: 0.5 })).toThrow(/minScale/);
  });

  it('starts at the max scale and clamps an out-of-range initial scale', () => {
    expect(new DynamicResolution({ minScale: 0.5, maxScale: 1 }).scale).toBe(1);
    expect(new DynamicResolution({ minScale: 0.5, maxScale: 1, initialScale: 3 }).scale).toBe(1);
    expect(new DynamicResolution({ minScale: 0.5, maxScale: 1, initialScale: 0.1 }).scale).toBe(
      0.5,
    );
  });

  it('drops resolution on an overloaded GPU until play holds at least 55 fps', () => {
    const controller = new DynamicResolution({ minScale: 0.5, maxScale: 1 });
    const heavy: Device = { fixedMs: 4, gpuFullMs: 24 };
    const { frames } = simulate(controller, () => heavy, 20_000);

    expect(fpsBetween(frames, 0, 1000)).toBeLessThan(40);
    expect(fpsBetween(frames, 5000, 20_000)).toBeGreaterThanOrEqual(55);
    expect(controller.scale).toBeLessThan(1);
    expect(controller.scale).toBeGreaterThanOrEqual(0.5);
  });

  it('settles without oscillating once the load is steady', () => {
    const controller = new DynamicResolution({ minScale: 0.5, maxScale: 1 });
    const { frames } = simulate(controller, () => ({ fixedMs: 3, gpuFullMs: 20 }), 60_000);
    const late = frames.filter((frame) => frame.at > 20_000);
    const scales = new Set(late.map((frame) => frame.scale));

    expect(fpsBetween(frames, 20_000, 60_000)).toBeGreaterThanOrEqual(58);
    expect(scales.size).toBeLessThanOrEqual(2);
  });

  it('climbs back to full resolution when the load spike ends', () => {
    const controller = new DynamicResolution({ minScale: 0.5, maxScale: 1 });
    const spike: Device = { fixedMs: 4, gpuFullMs: 30 };
    const calm: Device = { fixedMs: 4, gpuFullMs: 8 };
    const { frames } = simulate(controller, (at) => (at < 8000 ? spike : calm), 40_000);

    expect(frames.find((frame) => frame.at > 7000 && frame.at < 8000)?.scale).toBeLessThan(0.9);
    expect(controller.scale).toBe(1);
    expect(fpsBetween(frames, 4000, 40_000)).toBeGreaterThanOrEqual(55);
  });

  it('keeps 120 Hz devices at full resolution', () => {
    const controller = new DynamicResolution({ minScale: 0.5, maxScale: 1 });
    for (let i = 0; i < 2000; i++) controller.sample(1000 / 120);
    expect(controller.scale).toBe(1);
  });

  it('ignores a single dropped frame', () => {
    const controller = new DynamicResolution({ minScale: 0.5, maxScale: 1 });
    const events: ResolutionEvent[] = [];
    for (let i = 0; i < 600; i++) {
      const event = controller.sample(i === 300 ? VSYNC_MS * 2 : VSYNC_MS);
      if (event !== null) events.push(event);
    }
    expect(events).toEqual([]);
  });

  it('treats a long pause (hidden tab) as a gap, not as load', () => {
    const controller = new DynamicResolution({ minScale: 0.5, maxScale: 1 });
    for (let i = 0; i < 100; i++) controller.sample(VSYNC_MS);
    expect(controller.sample(5000)).toBeNull();
    expect(controller.smoothedFrameMs).toBeNull();
    for (let i = 0; i < 100; i++) controller.sample(VSYNC_MS);
    expect(controller.scale).toBe(1);
  });

  it('still reacts on a device too slow to ever reach 60 fps', () => {
    const controller = new DynamicResolution({ minScale: 0.5, maxScale: 1 });
    const events: ResolutionEvent[] = [];
    for (let i = 0; i < 40; i++) {
      const event = controller.sample(400);
      if (event !== null) events.push(event);
    }
    expect(controller.scale).toBe(0.5);
    expect(events).toContainEqual({ kind: 'exhausted' });
  });

  it('reports exhaustion after sustained overload at the minimum scale', () => {
    const controller = new DynamicResolution({ minScale: 0.5, maxScale: 1, initialScale: 0.5 });
    const { events } = simulate(controller, () => ({ fixedMs: 30, gpuFullMs: 10 }), 6000);
    expect(events.filter((event) => event.kind === 'scale')).toEqual([]);
    expect(events).toContainEqual({ kind: 'exhausted' });
  });

  it('backs off its upscale probes when they keep failing', () => {
    const controller = new DynamicResolution({ minScale: 0.5, maxScale: 1 });
    const borderline: Device = { fixedMs: 2, gpuFullMs: 22 };
    const { events } = simulate(controller, () => borderline, 120_000);
    const scaleEvents = events.filter((event) => event.kind === 'scale');
    const firstMinute = scaleEvents.length;
    const { events: later } = simulate(controller, () => borderline, 60_000);
    expect(later.filter((event) => event.kind === 'scale').length).toBeLessThan(firstMinute);
  });
});

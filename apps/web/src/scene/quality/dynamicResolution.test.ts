import { describe, expect, it } from 'vitest';
import { DynamicResolution, type ResolutionEvent } from './dynamicResolution.ts';

const VSYNC_MS = 1000 / 60;

interface Device {
  /** Main-thread cost per frame; resolution does not change it. */
  readonly cpuMs: number;
  /** GPU cost of one frame at scale 1; scales with pixel count (scale squared). */
  readonly gpuFullMs: number;
  /** Rate frames are presented at: the display refresh or a power-saving cap. */
  readonly refreshHz?: number;
}

interface Sensors {
  /** Report main-thread time per frame, as AdaptiveRendering measures it. */
  readonly cpu?: boolean;
  /** Report GPU timestamps, as with `trackTimestamp: true` on a supporting device. */
  readonly gpu?: boolean;
}

interface Frame {
  readonly at: number;
  readonly ms: number;
  readonly scale: number;
}

/** CPU and GPU overlap, and a frame that misses a refresh waits for the next one. */
function presentedFrameMs(device: Device, scale: number): number {
  const refreshMs = 1000 / (device.refreshHz ?? 60);
  const work = Math.max(device.cpuMs, device.gpuFullMs * scale * scale);
  return Math.max(1, Math.ceil(work / refreshMs - 1e-9)) * refreshMs;
}

function simulate(
  controller: DynamicResolution,
  device: (elapsedMs: number) => Device,
  durationMs: number,
  sensors: Sensors = { cpu: true },
): { frames: Frame[]; events: ResolutionEvent[] } {
  const frames: Frame[] = [];
  const events: ResolutionEvent[] = [];
  let elapsed = 0;
  while (elapsed < durationMs) {
    const now = device(elapsed);
    const scale = controller.scale;
    const ms = presentedFrameMs(now, scale);
    elapsed += ms;
    frames.push({ at: elapsed, ms, scale });
    const event = controller.sample({
      intervalMs: ms,
      cpuMs: sensors.cpu === true ? now.cpuMs : null,
      gpuMs: sensors.gpu === true ? now.gpuFullMs * scale * scale : null,
    });
    if (event !== null) events.push(event);
  }
  return { frames, events };
}

function fpsBetween(frames: readonly Frame[], from: number, to: number): number {
  const window = frames.filter((frame) => frame.at > from && frame.at <= to);
  const total = window.reduce((sum, frame) => sum + frame.ms, 0);
  return (window.length * 1000) / total;
}

function shareAtScale(frames: readonly Frame[], scale: number, from: number): number {
  const window = frames.filter((frame) => frame.at > from);
  const time = window.reduce((sum, frame) => sum + frame.ms, 0);
  const at = window.filter((frame) => frame.scale === scale);
  return at.reduce((sum, frame) => sum + frame.ms, 0) / time;
}

const controllerAt = (initialScale?: number) =>
  new DynamicResolution({
    minScale: 0.5,
    maxScale: 1,
    ...(initialScale === undefined ? {} : { initialScale }),
  });

const interval = (intervalMs: number) => ({ intervalMs });

describe('DynamicResolution', () => {
  it('rejects bounds that leave no valid scale', () => {
    expect(() => new DynamicResolution({ minScale: 0, maxScale: 1 })).toThrow(/minScale/);
    expect(() => new DynamicResolution({ minScale: 0.8, maxScale: 0.5 })).toThrow(/minScale/);
  });

  it('starts at the max scale and clamps an out-of-range initial scale', () => {
    expect(controllerAt().scale).toBe(1);
    expect(controllerAt(3).scale).toBe(1);
    expect(controllerAt(0.1).scale).toBe(0.5);
  });

  describe('on a GPU-bound device', () => {
    it.each([
      ['frame intervals', { cpu: true }],
      ['GPU timestamps', { cpu: true, gpu: true }],
    ] as const)('drops resolution until play holds at least 55 fps (%s)', (_name, sensors) => {
      const controller = controllerAt();
      const { frames } = simulate(controller, () => ({ cpuMs: 4, gpuFullMs: 24 }), 20_000, sensors);

      expect(fpsBetween(frames, 0, 1000)).toBeLessThan(40);
      expect(fpsBetween(frames, 5000, 20_000)).toBeGreaterThanOrEqual(55);
      expect(controller.scale).toBeLessThan(1);
      expect(controller.scale).toBeGreaterThanOrEqual(0.5);
    });

    it('finds the GPU win even when the load pins frames at exactly 30 fps from frame one', () => {
      const controller = controllerAt();
      const { frames } = simulate(controller, () => ({ cpuMs: 2, gpuFullMs: 25 }), 20_000);
      expect(frames.slice(0, 20).every((frame) => frame.ms === 2 * VSYNC_MS)).toBe(true);
      expect(fpsBetween(frames, 5000, 20_000)).toBeGreaterThanOrEqual(55);
    });

    it('settles without oscillating once the load is steady', () => {
      const controller = controllerAt();
      const { frames } = simulate(controller, () => ({ cpuMs: 3, gpuFullMs: 20 }), 60_000);
      const late = frames.filter((frame) => frame.at > 20_000);

      expect(fpsBetween(frames, 20_000, 60_000)).toBeGreaterThanOrEqual(58);
      expect(new Set(late.map((frame) => frame.scale)).size).toBeLessThanOrEqual(2);
    });

    it('climbs back to full resolution when the load spike ends', () => {
      const controller = controllerAt();
      const spike: Device = { cpuMs: 4, gpuFullMs: 30 };
      const calm: Device = { cpuMs: 4, gpuFullMs: 8 };
      const { frames } = simulate(controller, (at) => (at < 8000 ? spike : calm), 40_000);

      expect(frames.find((frame) => frame.at > 7000 && frame.at < 8000)?.scale).toBeLessThan(0.9);
      expect(controller.scale).toBe(1);
      expect(fpsBetween(frames, 4000, 40_000)).toBeGreaterThanOrEqual(55);
    });

    it.each([
      ['frame intervals', { cpu: true }],
      ['GPU timestamps', { cpu: true, gpu: true }],
    ] as const)(
      'reports exhaustion when even the floor scale is too slow (%s)',
      (_name, sensors) => {
        const controller = controllerAt();
        const { events } = simulate(
          controller,
          () => ({ cpuMs: 2, gpuFullMs: 200 }),
          15_000,
          sensors,
        );
        expect(controller.scale).toBe(0.5);
        expect(events).toContainEqual({ kind: 'exhausted' });
        expect(controller.gpuBoundConfirmed).toBe(true);
      },
    );

    it('confirms an overload whose frames take far longer than the hitch cap', () => {
      const controller = controllerAt();
      const { events } = simulate(controller, () => ({ cpuMs: 2, gpuFullMs: 480 }), 20_000);
      expect(controller.scale).toBe(0.5);
      expect(events).toContainEqual({ kind: 'exhausted' });
    });

    it('hands a confirmed overload to the next controller so the floor still counts', () => {
      const controller = new DynamicResolution({
        minScale: 0.55,
        maxScale: 1,
        initialScale: 0.6,
        gpuBoundConfirmed: true,
      });
      expect(controller.gpuBoundConfirmed).toBe(true);
      const { events } = simulate(controller, () => ({ cpuMs: 3, gpuFullMs: 120 }), 10_000);
      expect(events).toContainEqual({ kind: 'exhausted' });
    });

    it('lets a handed-over confirmation lapse once frames are healthy', () => {
      const controller = new DynamicResolution({
        minScale: 0.5,
        maxScale: 1,
        gpuBoundConfirmed: true,
      });
      simulate(controller, () => ({ cpuMs: 3, gpuFullMs: 6 }), 20_000);
      expect(controller.gpuBoundConfirmed).toBe(false);
    });

    it('backs off its upscale probes when they keep failing', () => {
      const controller = controllerAt();
      const borderline: Device = { cpuMs: 2, gpuFullMs: 22 };
      const { events } = simulate(controller, () => borderline, 120_000);
      const firstMinutes = events.filter((event) => event.kind === 'scale').length;
      const { events: later } = simulate(controller, () => borderline, 60_000);
      expect(later.filter((event) => event.kind === 'scale').length).toBeLessThan(firstMinutes);
    });
  });

  describe('on a device the GPU is not holding back', () => {
    it('keeps a CPU-bound device at full resolution and never reports exhaustion', () => {
      const controller = controllerAt();
      const { events } = simulate(controller, () => ({ cpuMs: 30, gpuFullMs: 5 }), 60_000);
      expect(events).toEqual([]);
      expect(controller.lastAttribution).toBe('cpu-bound');
    });

    it('keeps a CPU-bound device at its scale even when sitting at the floor', () => {
      const controller = controllerAt(0.5);
      const { events } = simulate(controller, () => ({ cpuMs: 30, gpuFullMs: 10 }), 20_000);
      expect(events).toEqual([]);
    });

    it('ignores a CPU-bound device the GPU timer clears', () => {
      const controller = controllerAt();
      const { events } = simulate(controller, () => ({ cpuMs: 30, gpuFullMs: 5 }), 60_000, {
        cpu: true,
        gpu: true,
      });
      expect(events).toEqual([]);
    });

    it.each([30, 50])(
      'treats a %s Hz cap as the device keeping up: no exhaustion, full resolution restored',
      (refreshHz) => {
        const controller = controllerAt();
        const capped: Device = { cpuMs: 3, gpuFullMs: 6, refreshHz };
        const { frames, events } = simulate(controller, () => capped, 5 * 60_000);
        expect(events).not.toContainEqual({ kind: 'exhausted' });
        expect(controller.scale).toBe(1);
        expect(shareAtScale(frames, 1, 10_000)).toBeGreaterThan(0.97);
      },
    );

    it('does not mistake hitches on a 30 Hz capped device for a resolution win', () => {
      const controller = controllerAt();
      const capped: Device = { cpuMs: 3, gpuFullMs: 6, refreshHz: 30 };
      const hitch: Device = { cpuMs: 3, gpuFullMs: 250, refreshHz: 30 };
      const { events } = simulate(
        controller,
        (at) => (at % 1700 < 34 ? hitch : capped),
        3 * 60_000,
      );
      expect(events).not.toContainEqual({ kind: 'exhausted' });
      expect(controller.gpuBoundConfirmed).toBe(false);
    });

    it('never touches a capped device when the GPU timer shows headroom', () => {
      const controller = controllerAt();
      const { events } = simulate(
        controller,
        () => ({ cpuMs: 3, gpuFullMs: 6, refreshHz: 30 }),
        60_000,
        { cpu: true, gpu: true },
      );
      expect(events).toEqual([]);
    });

    it('verifies, restores and backs off when nothing reports the main-thread time', () => {
      const controller = controllerAt();
      const { frames, events } = simulate(
        controller,
        () => ({ cpuMs: 30, gpuFullMs: 5 }),
        5 * 60_000,
        {},
      );
      const restores = events.filter((event) => event.kind === 'scale' && event.scale === 1);
      expect(events).not.toContainEqual({ kind: 'exhausted' });
      expect(restores.length).toBeGreaterThan(0);
      expect(restores.length).toBeLessThanOrEqual(8);
      expect(controller.scale).toBe(1);
      expect(shareAtScale(frames, 1, 0)).toBeGreaterThan(0.95);
    });
  });

  it('keeps 120 Hz devices at full resolution', () => {
    const controller = controllerAt();
    for (let i = 0; i < 2000; i++) controller.sample(interval(1000 / 120));
    expect(controller.scale).toBe(1);
  });

  it('ignores a single dropped frame', () => {
    const controller = controllerAt();
    const events: ResolutionEvent[] = [];
    for (let i = 0; i < 600; i++) {
      const event = controller.sample(interval(i === 300 ? VSYNC_MS * 2 : VSYNC_MS));
      if (event !== null) events.push(event);
    }
    expect(events).toEqual([]);
  });

  it('treats a long pause (hidden tab) as a gap, not as load', () => {
    const controller = controllerAt();
    for (let i = 0; i < 100; i++) controller.sample(interval(VSYNC_MS));
    expect(controller.sample(interval(5000))).toBeNull();
    expect(controller.smoothedFrameMs).toBeNull();
    for (let i = 0; i < 100; i++) controller.sample(interval(VSYNC_MS));
    expect(controller.scale).toBe(1);
  });

  it('ignores invalid timings', () => {
    const controller = controllerAt();
    expect(controller.sample(interval(Number.NaN))).toBeNull();
    expect(controller.sample(interval(-5))).toBeNull();
    expect(controller.sample(interval(0))).toBeNull();
    expect(controller.smoothedFrameMs).toBeNull();
  });
});

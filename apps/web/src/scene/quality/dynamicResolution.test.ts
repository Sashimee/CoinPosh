import { describe, expect, it } from 'vitest';
import {
  DynamicResolution,
  PAUSE_MS,
  RESUME_GRACE_MS,
  type ResolutionEvent,
} from './dynamicResolution.ts';

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

/**
 * The tab goes away every `everyMs` of play for `awayMs`, and the first frames back each take
 * `resumeHitchMs` (re-uploads, compositor catch-up) for `resumeHitchFrames` frames.
 */
interface Pauses {
  readonly everyMs: number;
  readonly awayMs: number;
  readonly resumeHitchMs?: number;
  readonly resumeHitchFrames?: number;
  /** Play time after which the pauses stop. */
  readonly untilMs?: number;
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
  pauses?: Pauses,
): { frames: Frame[]; events: ResolutionEvent[]; pausedAt: number[] } {
  const frames: Frame[] = [];
  const events: ResolutionEvent[] = [];
  const pausedAt: number[] = [];
  let elapsed = 0;
  let nextPause = pauses?.everyMs ?? Number.POSITIVE_INFINITY;
  let hitchFramesLeft = 0;
  while (elapsed < durationMs) {
    const now = device(elapsed);
    const scale = controller.scale;
    let ms = presentedFrameMs(now, scale);
    let intervalMs = ms;
    if (pauses !== undefined && elapsed >= nextPause && elapsed < (pauses.untilMs ?? Infinity)) {
      nextPause += pauses.everyMs;
      pausedAt.push(elapsed);
      intervalMs += pauses.awayMs;
      hitchFramesLeft = pauses.resumeHitchFrames ?? 0;
    } else if (hitchFramesLeft > 0) {
      hitchFramesLeft--;
      ms = Math.max(ms, pauses?.resumeHitchMs ?? 0);
      intervalMs = ms;
    }
    elapsed += ms;
    frames.push({ at: elapsed, ms, scale });
    const event = controller.sample({
      intervalMs,
      cpuMs: sensors.cpu === true ? now.cpuMs : null,
      gpuMs: sensors.gpu === true ? now.gpuFullMs * scale * scale : null,
    });
    if (event !== null) events.push(event);
  }
  return { frames, events, pausedAt };
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

/** Bursts of scale changes, counting changes less than `gapMs` apart as one burst. */
function changeBursts(frames: readonly Frame[], gapMs = 5000): number {
  let bursts = 0;
  let lastChangeAt = Number.NEGATIVE_INFINITY;
  frames.forEach((frame, i) => {
    if (i === 0 || frame.scale === frames[i - 1]?.scale) return;
    if (frame.at - lastChangeAt > gapMs) bursts++;
    lastChangeAt = frame.at;
  });
  return bursts;
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

    describe('with a cap that comes and goes (power or thermal throttling)', () => {
      const intermittent =
        (onMs: number, offMs: number) =>
        (at: number): Device => ({
          cpuMs: 4,
          gpuFullMs: 6,
          refreshHz: at % (onMs + offMs) < onMs ? 30 : 60,
        });

      it.each([
        [2000, 3000],
        [3000, 3000],
        [1500, 1500],
        [1000, 1000],
        [1200, 1000],
      ])(
        'keeps full resolution and never confirms or exhausts (%s ms on, %s ms off)',
        (onMs, offMs) => {
          const controller = controllerAt();
          const confirmedAt: number[] = [];
          const { frames, events } = simulate(
            controller,
            (at) => {
              if (controller.gpuBoundConfirmed) confirmedAt.push(at);
              return intermittent(onMs, offMs)(at);
            },
            5 * 60_000,
          );
          expect(events).not.toContainEqual({ kind: 'exhausted' });
          expect(confirmedAt).toEqual([]);
          expect(shareAtScale(frames, 1, 0)).toBeGreaterThanOrEqual(0.97);
          expect(controller.scale).toBe(1);
        },
      );

      it('lets a handed-over confirmation expire instead of renewing it on capped frames', () => {
        const controller = new DynamicResolution({
          minScale: 0.5,
          maxScale: 1,
          initialScale: 0.5,
          gpuBoundConfirmed: true,
        });
        const capped: Device = { cpuMs: 4, gpuFullMs: 6, refreshHz: 30 };
        const exhaustedAt: number[] = [];
        let at = 0;
        while (at < 60_000) {
          const ms = presentedFrameMs(capped, controller.scale);
          at += ms;
          const event = controller.sample({ intervalMs: ms, cpuMs: capped.cpuMs });
          if (event?.kind === 'exhausted') exhaustedAt.push(at);
        }
        expect(controller.gpuBoundConfirmed).toBe(false);
        expect(exhaustedAt.filter((time) => time > 16_000)).toEqual([]);
        expect(controller.scale).toBe(1);
      });
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
      const tests = changeBursts(frames);
      expect(events).not.toContainEqual({ kind: 'exhausted' });
      expect(tests).toBeGreaterThan(0);
      expect(tests).toBeLessThanOrEqual(8);
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

  describe('across pauses longer than PAUSE_MS', () => {
    const away: Pauses = {
      everyMs: 7000,
      awayMs: 1500,
      resumeHitchMs: 250,
      resumeHitchFrames: 2,
    };

    it('does not let a gap or the hitches after it count as load', () => {
      const controller = controllerAt();
      const { events, pausedAt } = simulate(
        controller,
        () => ({ cpuMs: 4, gpuFullMs: 8 }),
        120_000,
        { cpu: true },
        { ...away, everyMs: 3000, awayMs: 60_000 },
      );
      expect(pausedAt.length).toBeGreaterThan(30);
      expect(events).toEqual([]);
    });

    it.each([
      ['frame intervals', { cpu: true }],
      ['GPU timestamps', { cpu: true, gpu: true }],
    ] as const)('still verifies a GPU-bound overload and holds 55 fps (%s)', (_name, sensors) => {
      const controller = controllerAt();
      const confirmed: boolean[] = [];
      const { frames, pausedAt } = simulate(
        controller,
        () => {
          confirmed.push(controller.gpuBoundConfirmed);
          return { cpuMs: 4, gpuFullMs: 24 };
        },
        60_000,
        sensors,
        away,
      );
      expect(pausedAt.length).toBeGreaterThanOrEqual(8);
      expect(confirmed).toContain(true);
      expect(controller.scale).toBeLessThan(1);
      const steady = frames.filter((frame) => frame.at > 10_000 && frame.ms < 100);
      const fps = (steady.length * 1000) / steady.reduce((sum, frame) => sum + frame.ms, 0);
      expect(fps).toBeGreaterThanOrEqual(55);
    });

    it.each([
      ['capped at 30 Hz', { cpuMs: 3, gpuFullMs: 6, refreshHz: 30 }],
      ['CPU-bound', { cpuMs: 30, gpuFullMs: 5 }],
    ] as const)('never confirms a %s device because of pauses', (_name, device) => {
      const controller = controllerAt();
      const confirmedAt: number[] = [];
      const { frames, events } = simulate(
        controller,
        (at) => {
          if (controller.gpuBoundConfirmed) confirmedAt.push(at);
          return device;
        },
        5 * 60_000,
        { cpu: true },
        { ...away, everyMs: 2300 },
      );
      expect(events).not.toContainEqual({ kind: 'exhausted' });
      expect(confirmedAt).toEqual([]);
      expect(controller.scale).toBe(1);
      expect(shareAtScale(frames, 1, 0)).toBeGreaterThan(0.95);
    });

    it('keeps an A/B test across a pause and re-measures only the segment it cut', () => {
      const gpuBound = () => ({ cpuMs: 3, gpuFullMs: 25 });
      const reference = controllerAt();
      const uninterrupted = simulate(reference, gpuBound, 10_000);
      expect(reference.gpuBoundConfirmed).toBe(true);

      const controller = controllerAt();
      let trialStart: ResolutionEvent | null = null;
      for (let i = 0; i < 200 && trialStart === null; i++) {
        trialStart = controller.sample({ intervalMs: 2 * VSYNC_MS, cpuMs: 3 });
      }
      const trialLow = controller.scale;
      expect(trialLow).toBeLessThan(1);
      expect(controller.sample({ intervalMs: PAUSE_MS + 1 })).toBeNull();
      expect(controller.scale).toBe(trialLow);
      expect(controller.gpuBoundConfirmed).toBe(false);

      const resumed = simulate(controller, gpuBound, 10_000);
      expect(controller.gpuBoundConfirmed).toBe(true);
      expect(controller.scale).toBeLessThan(1);
      expect(resumed.events.length).toBeLessThanOrEqual(uninterrupted.events.length);
      expect(fpsBetween(resumed.frames, 5000, 10_000)).toBeGreaterThanOrEqual(55);
    });

    it('reaches a verdict when pauses come more often than an A/B test lasts', () => {
      const controller = controllerAt();
      let everConfirmed = false;
      const { frames, pausedAt } = simulate(
        controller,
        () => {
          everConfirmed ||= controller.gpuBoundConfirmed;
          return { cpuMs: 3, gpuFullMs: 25 };
        },
        30_000,
        { cpu: true },
        { everyMs: 1500, awayMs: 2000, resumeHitchMs: 120, resumeHitchFrames: 2 },
      );
      expect(pausedAt.length).toBeGreaterThan(15);
      expect(everConfirmed).toBe(true);
      expect(controller.scale).toBeLessThan(1);
      expect(frames.at(-1)?.ms).toBeCloseTo(VSYNC_MS);
    });

    it('skips the resume grace period, then measures again', () => {
      const controller = controllerAt();
      for (let i = 0; i < 60; i++) controller.sample(interval(VSYNC_MS));
      expect(controller.sample(interval(PAUSE_MS * 4))).toBeNull();
      let graceMs = 0;
      while (graceMs < RESUME_GRACE_MS) {
        expect(controller.sample(interval(90))).toBeNull();
        graceMs += 90;
        expect(controller.smoothedFrameMs).toBeNull();
      }
      controller.sample(interval(VSYNC_MS));
      expect(controller.smoothedFrameMs).toBeCloseTo(VSYNC_MS);
    });

    it('treats a pause exactly at PAUSE_MS as a (slow) frame and anything longer as a gap', () => {
      const atThreshold = controllerAt();
      atThreshold.sample(interval(PAUSE_MS));
      expect(atThreshold.lastAttribution).toBe('frame-interval');
      const beyond = controllerAt();
      beyond.sample(interval(PAUSE_MS + 0.5));
      expect(beyond.lastAttribution).toBeNull();
    });

    it('does not carry starvation at the floor across a pause into exhaustion', () => {
      const controller = controllerAt(0.5);
      const overload = () => ({ cpuMs: 2, gpuFullMs: 200 });
      const sensors = { cpu: true, gpu: true };
      const paused = simulate(controller, overload, 60_000, sensors, {
        everyMs: 2000,
        awayMs: 5000,
      });
      expect(paused.events).not.toContainEqual({ kind: 'exhausted' });
      const resumed = simulate(controller, overload, 10_000, sensors);
      expect(resumed.events).toContainEqual({ kind: 'exhausted' });
    });
  });

  it('ignores invalid timings', () => {
    const controller = controllerAt();
    expect(controller.sample(interval(Number.NaN))).toBeNull();
    expect(controller.sample(interval(-5))).toBeNull();
    expect(controller.sample(interval(0))).toBeNull();
    expect(controller.smoothedFrameMs).toBeNull();
  });
});

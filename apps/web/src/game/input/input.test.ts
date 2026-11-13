import { describe, expect, it } from 'vitest';
import { linearAimMap } from './aimMap.ts';
import { DEFAULT_GESTURES, GestureRecognizer, type GestureConfig } from './gestures.ts';
import { DEFAULT_SHAKE, ShakeDetector } from './shake.ts';

const CONFIG: GestureConfig = {
  holdMs: 300,
  slopPx: 10,
  swipeMinPx: 40,
  swipeMaxMs: 400,
  swipeFullPx: 160,
};

describe('GestureRecognizer: one-thumb aim and drop', () => {
  it('aims on press and while dragging, and drops where the finger lifts', () => {
    const g = new GestureRecognizer(CONFIG);
    expect(g.down(1, 100, 500, 0)).toEqual([{ kind: 'aim', x: 100 }]);
    expect(g.move(1, 160, 505, 50)).toEqual([{ kind: 'aim', x: 160 }]);
    expect(g.up(1, 170, 505, 120)).toEqual([{ kind: 'drop', x: 170 }]);
    expect(g.active).toBe(false);
  });

  it('a quick tap drops once and the next press starts fresh', () => {
    const g = new GestureRecognizer(CONFIG);
    g.down(1, 50, 0, 0);
    expect(g.up(1, 50, 0, 40)).toEqual([{ kind: 'drop', x: 50 }]);
    expect(g.down(2, 80, 0, 100)).toEqual([{ kind: 'aim', x: 80 }]);
  });

  it('ignores moves and lifts from pointers it never saw', () => {
    const g = new GestureRecognizer(CONFIG);
    expect(g.move(9, 10, 10, 0)).toEqual([]);
    expect(g.up(9, 10, 10, 0)).toEqual([]);
    expect(g.cancel(9)).toEqual([]);
  });

  it('a cancelled pointer drops nothing', () => {
    const g = new GestureRecognizer(CONFIG);
    g.down(1, 50, 0, 0);
    expect(g.cancel(1)).toEqual([]);
    expect(g.up(1, 50, 0, 10)).toEqual([]);
    expect(g.active).toBe(false);
  });
});

describe('GestureRecognizer: hold to pour', () => {
  it('starts a pour once the finger has held still for holdMs, and ends it on lift', () => {
    const g = new GestureRecognizer(CONFIG);
    g.down(1, 100, 0, 0);
    expect(g.tick(299)).toEqual([]);
    expect(g.tick(300)).toEqual([{ kind: 'pourStart', x: 100 }]);
    expect(g.pouring).toBe(true);
    expect(g.tick(400)).toEqual([]);
    expect(g.move(1, 180, 0, 500)).toEqual([{ kind: 'aim', x: 180 }]);
    expect(g.up(1, 190, 0, 900)).toEqual([{ kind: 'pourEnd', x: 190 }]);
    expect(g.pouring).toBe(false);
  });

  it('jitter inside the slop keeps the hold; a real drag restarts the hold clock', () => {
    const g = new GestureRecognizer(CONFIG);
    g.down(1, 100, 100, 0);
    g.move(1, 106, 104, 100);
    expect(g.tick(300)).toEqual([{ kind: 'pourStart', x: 106 }]);

    const h = new GestureRecognizer(CONFIG);
    h.down(1, 100, 100, 0);
    h.move(1, 140, 100, 200);
    expect(h.tick(300)).toEqual([]);
    expect(h.tick(499)).toEqual([]);
    expect(h.tick(500)).toEqual([{ kind: 'pourStart', x: 140 }]);
  });

  it('a pour cancelled by the browser is cancelled, not graded', () => {
    const g = new GestureRecognizer(CONFIG);
    g.down(1, 0, 0, 0);
    g.tick(300);
    expect(g.cancel(1)).toEqual([{ kind: 'pourCancel' }]);
  });
});

describe('GestureRecognizer: interrupted by a cinematic', () => {
  it('cancels a running pour, and the held finger neither pours again nor drops on lift', () => {
    const g = new GestureRecognizer(CONFIG);
    g.down(1, 120, 0, 0);
    expect(g.tick(300)).toEqual([{ kind: 'pourStart', x: 120 }]);
    expect(g.interrupt()).toEqual([{ kind: 'pourCancel' }]);
    expect(g.pouring).toBe(false);
    expect(g.active).toBe(true);
    expect(g.live).toBe(false);
    expect(g.move(1, 180, 0, 400)).toEqual([]);
    expect(g.tick(5_000)).toEqual([]);
    expect(g.up(1, 180, 0, 5_100)).toEqual([]);
    expect(g.active).toBe(false);
  });

  it('a press that has not become a pour yet is spent too, so lifting it drops nothing', () => {
    const g = new GestureRecognizer(CONFIG);
    g.down(1, 60, 0, 0);
    expect(g.interrupt()).toEqual([]);
    expect(g.tick(1_000)).toEqual([]);
    expect(g.up(1, 60, 0, 1_100)).toEqual([]);
  });

  it('a fresh press after every finger lifts aims, drops and pours as usual', () => {
    const g = new GestureRecognizer(CONFIG);
    g.down(1, 0, 0, 0);
    g.tick(300);
    g.interrupt();
    g.up(1, 0, 0, 400);
    expect(g.down(2, 90, 0, 500)).toEqual([{ kind: 'aim', x: 90 }]);
    expect(g.live).toBe(true);
    expect(g.tick(800)).toEqual([{ kind: 'pourStart', x: 90 }]);
    expect(g.up(2, 90, 0, 900)).toEqual([{ kind: 'pourEnd', x: 90 }]);
  });

  it('with no finger down it does nothing', () => {
    const g = new GestureRecognizer(CONFIG);
    expect(g.interrupt()).toEqual([]);
    expect(g.down(1, 10, 0, 0)).toEqual([{ kind: 'aim', x: 10 }]);
    expect(g.up(1, 10, 0, 50)).toEqual([{ kind: 'drop', x: 10 }]);
  });
});

describe('GestureRecognizer: two-finger nudge', () => {
  const swipe = (dx: number, dy: number, ms: number) => {
    const g = new GestureRecognizer(CONFIG);
    g.down(1, 100, 300, 0);
    const second = g.down(2, 200, 300, 10);
    g.move(1, 100 + dx, 300 + dy, ms / 2);
    g.move(2, 200 + dx, 300 + dy, ms / 2);
    const first = g.up(1, 100 + dx, 300 + dy, ms);
    const last = g.up(2, 200 + dx, 300 + dy, ms + 5);
    return { second, first, last, g };
  };

  it('swiping right or left nudges that way, with strength from the travel', () => {
    const right = swipe(80, 0, 200);
    expect(right.second).toEqual([]);
    expect(right.first).toEqual([{ kind: 'nudge', direction: 'right', strength: 0.5 }]);
    expect(right.last).toEqual([]);
    expect(right.g.active).toBe(false);

    expect(swipe(-400, 0, 200).first).toEqual([{ kind: 'nudge', direction: 'left', strength: 1 }]);
    expect(swipe(60, 30, 200).first).toMatchObject([{ kind: 'nudge', direction: 'right' }]);
  });

  it('swiping down the screen nudges forward; swiping up does nothing', () => {
    expect(swipe(0, 60, 200).first).toEqual([
      { kind: 'nudge', direction: 'forward', strength: 60 / 160 },
    ]);
    expect(swipe(0, -60, 200).first).toEqual([]);
  });

  it('a short or slow swipe is not a nudge', () => {
    expect(swipe(39, 0, 200).first).toEqual([]);
    expect(swipe(80, 0, 411).first).toEqual([]);
    expect(swipe(40, 0, 410).first).toEqual([
      { kind: 'nudge', direction: 'right', strength: 0.25 },
    ]);
  });

  it('never drops a coin for the first finger of a two-finger gesture', () => {
    const { first, last } = swipe(80, 0, 200);
    expect([...first, ...last].some((action) => action.kind === 'drop')).toBe(false);
  });

  it('a second finger during a pour cancels the pour', () => {
    const g = new GestureRecognizer(CONFIG);
    g.down(1, 100, 0, 0);
    g.tick(300);
    expect(g.down(2, 200, 0, 350)).toEqual([{ kind: 'pourCancel' }]);
    expect(g.pouring).toBe(false);
    expect(g.tick(2_000)).toEqual([]);
  });

  it('a third finger spends the gesture, and nothing fires until all lift', () => {
    const g = new GestureRecognizer(CONFIG);
    g.down(1, 100, 0, 0);
    g.down(2, 200, 0, 5);
    expect(g.down(3, 300, 0, 10)).toEqual([]);
    expect(g.up(1, 300, 0, 50)).toEqual([]);
    expect(g.up(2, 400, 0, 55)).toEqual([]);
    expect(g.up(3, 500, 0, 60)).toEqual([]);
    expect(g.down(4, 10, 0, 100)).toEqual([{ kind: 'aim', x: 10 }]);
  });
});

describe('GestureRecognizer config', () => {
  it('rejects configs that cannot recognise anything', () => {
    expect(() => new GestureRecognizer({ ...DEFAULT_GESTURES, holdMs: 0 })).toThrow(RangeError);
    expect(() => new GestureRecognizer({ ...DEFAULT_GESTURES, swipeFullPx: 1 })).toThrow(
      RangeError,
    );
  });
});

describe('ShakeDetector', () => {
  it('turns a sideways jolt into a left or right nudge and a jolt along the normal into forward', () => {
    expect(new ShakeDetector().sample(20, 2, 0)?.direction).toBe('right');
    expect(new ShakeDetector().sample(-20, 2, 0)?.direction).toBe('left');
    expect(new ShakeDetector().sample(3, -20, 0)?.direction).toBe('forward');
  });

  it('ignores motion under the trigger and non-finite samples', () => {
    const shake = new ShakeDetector();
    expect(shake.sample(DEFAULT_SHAKE.triggerMs2 - 0.01, 0, 0)).toBeNull();
    expect(shake.sample(Number.NaN, 50, 0)).toBeNull();
    expect(shake.sample(Number.POSITIVE_INFINITY, 0, 0)).toBeNull();
  });

  it('scales strength from half at the trigger to full at fullMs2', () => {
    expect(new ShakeDetector().sample(DEFAULT_SHAKE.triggerMs2, 0, 0)?.strength).toBe(0.5);
    expect(new ShakeDetector().sample(DEFAULT_SHAKE.fullMs2, 0, 0)?.strength).toBe(1);
    expect(new ShakeDetector().sample(DEFAULT_SHAKE.fullMs2 * 3, 0, 0)?.strength).toBe(1);
  });

  it('counts one jolt once: it re-arms only after settling and after the cooldown', () => {
    const shake = new ShakeDetector();
    expect(shake.sample(20, 0, 0)).not.toBeNull();
    expect(shake.sample(-25, 0, 30)).toBeNull();
    expect(shake.sample(20, 0, 2_000)).toBeNull();
    expect(shake.sample(1, 0, 2_010)).toBeNull();
    expect(shake.sample(20, 0, 2_020)?.direction).toBe('right');

    const fast = new ShakeDetector();
    fast.sample(20, 0, 0);
    fast.sample(0, 0, 10);
    expect(fast.sample(20, 0, DEFAULT_SHAKE.cooldownMs - 1)).toBeNull();
    expect(fast.sample(20, 0, DEFAULT_SHAKE.cooldownMs)).not.toBeNull();
  });

  it('rejects thresholds that could never re-arm', () => {
    expect(
      () => new ShakeDetector({ ...DEFAULT_SHAKE, rearmMs2: DEFAULT_SHAKE.triggerMs2 }),
    ).toThrow(RangeError);
  });
});

describe('linearAimMap', () => {
  const map = linearAimMap(0.8);

  it('maps the middle of the surface to the centre line and the rail ends to ±1', () => {
    expect(map.toAim(200, 400)).toBe(0);
    expect(map.toAim(40, 400)).toBeCloseTo(-1);
    expect(map.toAim(360, 400)).toBeCloseTo(1);
  });

  it('clamps past the rail and round-trips inside it', () => {
    expect(map.toAim(0, 400)).toBe(-1);
    expect(map.toAim(400, 400)).toBe(1);
    expect(map.toAim(300, 400)).toBeCloseTo(0.625);
    expect(map.toPx(map.toAim(300, 400), 400)).toBeCloseTo(300);
  });

  it('a surface with no width aims at the centre', () => {
    expect(map.toAim(10, 0)).toBe(0);
  });

  it('rejects a span outside (0, 1]', () => {
    expect(() => linearAimMap(0)).toThrow(RangeError);
    expect(() => linearAimMap(1.2)).toThrow(RangeError);
  });
});

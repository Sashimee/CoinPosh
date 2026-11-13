import { describe, expect, it, vi } from 'vitest';
import { POP_TIMING } from './arc.ts';
import {
  boxesOverlap,
  boxGap,
  canCoalesce,
  COALESCE,
  placeClear,
  popBox,
  type Box,
  type OpenPop,
} from './coalesce.ts';
import { credit, FRAME, run, setup, type FakeElement } from './test/popDom.ts';

const VAULT = { x: 195, y: 48 };

function open(overrides: Partial<OpenPop> = {}): OpenPop {
  return { age: 0.1, lastCreditAge: 0, departsAt: 0.44, to: VAULT, ...overrides };
}

function box(left: number, top: number, right: number, bottom: number): Box {
  return { left, top, right, bottom };
}

/** Deterministic stream in [0, 1), so the cascade below replays the same every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A visible pop's on-screen box, read back from what the layer wrote to the DOM. */
function screenBox(el: FakeElement): Box | null {
  if (el.hidden || Number(el.style.opacity) <= 0) return null;
  const m = /translate\(([-\d.]+)px,([-\d.]+)px\).*scale\(([-\d.]+)\)/.exec(el.style.transform);
  if (!m) return null;
  const fontSize = Number.parseFloat(el.style.fontSize);
  return popBox(el.textContent.length, fontSize, Number(m[1]), Number(m[2]), Number(m[3]));
}

function visiblePops(pops: () => FakeElement[]): FakeElement[] {
  return pops().filter((el) => el.className === 'cp-pop' && screenBox(el) !== null);
}

describe('coalescing rule', () => {
  it('takes a credit up to exactly the window after the last one, and not after', () => {
    const gap = 10;
    expect(canCoalesce(open({ age: COALESCE.windowS }), VAULT, gap)).toBe(true);
    expect(canCoalesce(open({ age: COALESCE.windowS + 0.001 }), VAULT, gap)).toBe(false);
    expect(canCoalesce(open({ age: 0.4, lastCreditAge: 0.2 }), VAULT, gap)).toBe(true);
  });

  it('takes a credit up to exactly the gap, and not beyond', () => {
    expect(canCoalesce(open(), VAULT, COALESCE.gapPx)).toBe(true);
    expect(canCoalesce(open(), VAULT, COALESCE.gapPx + 0.01)).toBe(false);
    expect(canCoalesce(open(), VAULT, -30)).toBe(true);
  });

  it('closes once the pop flies, past the open cap, or for another target', () => {
    expect(canCoalesce(open({ age: 0.44 }), VAULT, 0)).toBe(false);
    const late = open({ age: COALESCE.maxOpenS + 0.01, lastCreditAge: COALESCE.maxOpenS });
    expect(canCoalesce({ ...late, departsAt: 5 }, VAULT, 0)).toBe(false);
    expect(canCoalesce(open(), { x: VAULT.x + 60, y: VAULT.y }, 0)).toBe(false);
    expect(canCoalesce(open(), { x: VAULT.x + 1, y: VAULT.y }, 0)).toBe(true);
  });

  it('measures boxes by glyphs and font size and the gap along the separating axis', () => {
    const a = popBox(3, 22, 100, 100, 1);
    expect(a.right - a.left).toBeCloseTo(3 * 0.62 * 22, 6);
    expect(popBox(3, 22, 100, 100, 2).right - popBox(3, 22, 100, 100, 2).left).toBeCloseTo(
      2 * (a.right - a.left),
      6,
    );
    expect(boxGap(box(0, 0, 10, 10), box(30, 0, 40, 10))).toBe(20);
    expect(boxGap(box(0, 0, 10, 10), box(0, 25, 10, 35))).toBe(15);
    expect(boxGap(box(0, 0, 10, 10), box(10, 0, 20, 10))).toBe(0);
    expect(boxesOverlap(box(0, 0, 10, 10), box(10, 0, 20, 10))).toBe(false);
    expect(boxesOverlap(box(0, 0, 10, 10), box(9, 9, 20, 20))).toBe(true);
  });

  it('places a pop where it is wanted when free, beside a taken spot, and inside the screen', () => {
    const bounds = { width: 390, height: 844 };
    expect(placeClear({ x: 200, y: 500 }, 40, 26, [], bounds)).toEqual({ x: 200, y: 500 });
    const taken = [box(180, 487, 220, 513)];
    const spot = placeClear({ x: 200, y: 500 }, 40, 26, taken, bounds);
    expect(spot.y).toBe(500);
    expect(spot.x).toBeLessThan(180 - 20);
    const edge = placeClear({ x: 5, y: 500 }, 40, 26, [], bounds);
    expect(edge.x).toBe(20);
  });
});

describe('NumberPopLayer coalescing', () => {
  it('leaves a single pop as it was: its own text, no tally', () => {
    const { layer, shown } = setup();
    layer.spawn(credit(6));
    run(layer, 0.3);
    expect(shown()).toHaveLength(1);
    expect(shown()[0]?.textContent).toBe('+6');
    expect(shown()[0]?.dataset.count).toBeUndefined();
  });

  it('shows one tally for a burst of simultaneous falls, equal to their summed credit', () => {
    const { layer, shown, pops } = setup();
    const values = [6, 6, 5, 5, 7, 6, 5, 5];
    const arrivals = values.map((value, i) => {
      const onArrive = vi.fn();
      layer.spawn(credit(value, { from: { x: 140 + i * 15, y: 520 }, onArrive }));
      return onArrive;
    });
    expect(layer.active).toBe(1);
    run(layer, COALESCE.countS + 0.05);
    expect(shown()).toHaveLength(1);
    expect(shown()[0]?.textContent).toBe('+45');
    expect(shown()[0]?.dataset.count).toBe('');
    let sparks = 0;
    run(layer, 3, () => {
      if (layer.active > 0) return;
      sparks = Math.max(sparks, pops().filter((el) => el.className === 'cp-spark').length);
    });
    for (const arrive of arrivals) expect(arrive).toHaveBeenCalledOnce();
    expect(sparks).toBeGreaterThanOrEqual(9);
    expect(layer.active).toBe(0);
  });

  it('counts up through values between the old and new sums and ends on the exact sum', () => {
    const { layer, shown } = setup();
    layer.spawn(credit(1000, { from: { x: 195, y: 520 } }));
    run(layer, 0.1);
    layer.spawn(credit(234, { from: { x: 205, y: 520 } }));
    const seen: number[] = [];
    run(layer, COALESCE.countS + 0.05, () => {
      seen.push(Number(shown()[0]?.textContent.replace(/[^\d]/g, '')));
    });
    expect(seen.length).toBeGreaterThan(3);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1] ?? 0);
      expect(seen[i]).toBeGreaterThanOrEqual(1000);
      expect(seen[i]).toBeLessThanOrEqual(1234);
    }
    expect(new Set(seen).size).toBeGreaterThan(2);
    expect(shown()[0]?.textContent).toBe('+1,234');
  });

  it('folds a credit inside the window and starts a new pop just after it', () => {
    const inside = setup();
    inside.layer.spawn(credit(5, { from: { x: 195, y: 520 } }));
    run(inside.layer, COALESCE.windowS - 0.03);
    inside.layer.spawn(credit(5, { from: { x: 200, y: 520 } }));
    expect(inside.layer.active).toBe(1);

    const after = setup();
    after.layer.spawn(credit(5, { from: { x: 195, y: 520 } }));
    run(after.layer, COALESCE.windowS + 0.03);
    after.layer.spawn(credit(5, { from: { x: 200, y: 520 } }));
    expect(after.layer.active).toBe(2);
    run(after.layer, 0.2);
    const [a, b] = visiblePops(after.pops).map(screenBox);
    expect(a && b && boxesOverlap(a, b)).toBe(false);
  });

  it('keeps pops that land far apart separate', () => {
    const { layer, shown } = setup();
    layer.spawn(credit(5, { from: { x: 80, y: 520 } }));
    layer.spawn(credit(5, { from: { x: 300, y: 520 } }));
    run(layer, 0.3);
    expect(shown()).toHaveLength(2);
    expect(shown().map((el) => el.textContent)).toEqual(['+5', '+5']);
  });

  it('wears the colour of the biggest share, and turns prism for an heirloom share', () => {
    const { layer, shown } = setup();
    layer.spawn(credit(5, { color: '#c0c0c0' }));
    layer.spawn(credit(40, { color: '#f5b942' }));
    layer.spawn(credit(6, { color: '#b87333' }));
    expect(shown()[0]?.style.getPropertyValue('--pop')).toBe('#f5b942');
    layer.spawn(credit(1, { color: '#fff', prism: true }));
    expect(shown()[0]?.dataset.prism).toBe('');
    expect(shown()[0]?.style.getPropertyValue('--pop')).toBe('#fff');
  });

  it('punches and flares as it takes a credit, and glides toward the middle of its credits', () => {
    const { layer, shown } = setup();
    layer.spawn(credit(5, { from: { x: 180, y: 520 } }));
    run(layer, 0.2);
    layer.spawn(credit(5, { from: { x: 210, y: 520 } }));
    let peak = 0;
    let flare = 0;
    const xs: number[] = [];
    run(layer, COALESCE.punchS, () => {
      const el = shown()[0];
      peak = Math.max(peak, Number(/scale\(([-\d.]+)\)/.exec(el?.style.transform ?? '')?.[1]));
      flare = Math.max(flare, Number(el?.style.getPropertyValue('--flare')));
      xs.push(Number(/translate\(([-\d.]+)px/.exec(el?.style.transform ?? '')?.[1]));
    });
    expect(peak).toBeGreaterThan(1 + COALESCE.punchScale * 0.9);
    expect(flare).toBeGreaterThan(0.8);
    expect(xs[0]).toBeLessThan(186);
    expect(Math.abs((xs[xs.length - 1] ?? 0) - 195)).toBeLessThan(2);
  });

  it('holds a tally long enough for its new total to read before it flies', () => {
    const { layer, shown } = setup();
    const hangY = 520 - POP_TIMING.rise;
    const y = (): number =>
      Number(/translate\([-\d.]+px,([-\d.]+)px/.exec(shown()[0]?.style.transform ?? '')?.[1]);
    layer.spawn(credit(5, { from: { x: 195, y: 520 } }));
    run(layer, 0.22);
    layer.spawn(credit(5, { from: { x: 195, y: 520 } }));
    run(layer, COALESCE.readS - 0.04);
    expect(0.22 + COALESCE.readS - 0.04).toBeGreaterThan(POP_TIMING.popIn + POP_TIMING.hang);
    expect(y()).toBeCloseTo(hangY, 0);
    run(layer, 0.4);
    expect(y()).toBeLessThan(hangY - 20);
  });

  it('reduced motion folds in place: the sum swaps in, nothing moves, no sparks', () => {
    const { layer, shown, pops } = setup();
    layer.reducedMotion = true;
    layer.spawn(credit(5, { from: { x: 180, y: 520 } }));
    run(layer, 0.1);
    layer.spawn(credit(7, { from: { x: 210, y: 520 } }));
    expect(shown()).toHaveLength(1);
    expect(shown()[0]?.textContent).toBe('+12');
    const positions = new Set<string>();
    let sawSpark = false;
    run(layer, 2, () => {
      const el = shown()[0];
      if (el) positions.add(el.style.transform);
      sawSpark ||= pops().some((p) => p.className === 'cp-spark' || p.className === 'cp-burst');
    });
    expect(positions.size).toBe(1);
    expect([...positions][0]).toMatch(/^translate\(180\.0px,520\.0px\)/);
    expect(sawSpark).toBe(false);
  });

  it('keeps every visible pop clear of the others through a seeded 390x844 cascade', () => {
    for (const reduced of [false, true]) {
      const { layer, pops } = setup();
      layer.reducedMotion = reduced;
      const rand = mulberry32(224);
      const falls: { at: number; x: number; y: number; value: number }[] = [];
      let t = 0.2;
      while (falls.length < 60) {
        const burst = 1 + Math.floor(rand() * 7);
        for (let i = 0; i < burst; i++) {
          falls.push({
            at: t + rand() * 0.22,
            x: 110 + rand() * 170,
            y: 515 + rand() * 20,
            value: rand() < 0.1 ? 25 : 5 + Math.floor(rand() * 3),
          });
        }
        t += 0.12 + rand() * 0.6;
      }
      falls.sort((a, b) => a.at - b.at);
      const credited = falls.reduce((sum, f) => sum + f.value, 0);
      let landed = 0;
      let next = 0;
      let overlaps = 0;
      let most = 0;
      for (let clock = 0; clock < t + 4; clock += FRAME) {
        while (next < falls.length && (falls[next]?.at ?? Infinity) <= clock) {
          const fall = falls[next++];
          if (!fall) break;
          layer.spawn(
            credit(fall.value, {
              from: { x: fall.x, y: fall.y },
              to: VAULT,
              onArrive: () => {
                landed += fall.value;
              },
            }),
          );
        }
        layer.update(FRAME);
        const boxes = visiblePops(pops).flatMap((el) => screenBox(el) ?? []);
        const legible = visiblePops(pops).filter((el) => Number(el.style.opacity) >= 0.5);
        most = Math.max(most, legible.length);
        for (let i = 0; i < boxes.length; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i];
            const b = boxes[j];
            if (a && b && boxesOverlap(a, b)) overlaps++;
          }
        }
      }
      expect({ reduced, overlaps }).toEqual({ reduced, overlaps: 0 });
      expect(most).toBeGreaterThan(1);
      expect(most).toBeLessThanOrEqual(6);
      expect(landed).toBe(credited);
    }
  });
});

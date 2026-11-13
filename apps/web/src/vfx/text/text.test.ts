import i18next from 'i18next';
import { describe, expect, it } from 'vitest';
import { createPopPath, POP_TIMING, popFontSize, popFrame } from './arc.ts';
import { formatPopValue } from './format.ts';

async function i18n(lng: string) {
  const instance = i18next.createInstance();
  await instance.init({ lng, fallbackLng: 'en', resources: {} });
  return instance;
}

describe('formatPopValue', () => {
  it('formats with the locale grouping and an explicit plus sign', async () => {
    expect(formatPopValue(await i18n('en'), 1234)).toBe('+1,234');
    expect(formatPopValue(await i18n('de'), 1234)).toBe('+1.234');
    expect(formatPopValue(await i18n('fr'), 1234)).toBe('+1\u202f234');
  });

  it('keeps minus signs, rounds fractions and shows zero unsigned', async () => {
    const en = await i18n('en');
    expect(formatPopValue(en, -42)).toBe('-42');
    expect(formatPopValue(en, 12.6)).toBe('+13');
    expect(formatPopValue(en, 0)).toBe('0');
  });

  it('switches to compact notation from a million', async () => {
    expect(formatPopValue(await i18n('en'), 2_500_000)).toBe('+2.5M');
    expect(formatPopValue(await i18n('de'), 2_500_000)).toBe('+2,5 Mio.');
    expect(formatPopValue(await i18n('en'), 999_999)).toBe('+999,999');
  });

  it('fails loudly without an initialised instance or a finite value', async () => {
    expect(() => formatPopValue(i18next.createInstance(), 1)).toThrow(/i18next/);
    const en = await i18n('en');
    expect(() => formatPopValue(en, Number.NaN)).toThrow(RangeError);
  });
});

describe('number pop arc', () => {
  const from = { x: 200, y: 600 };
  const to = { x: 340, y: 40 };

  it('pops in with overshoot, rises, hangs, then lands on the HUD target', () => {
    const path = createPopPath(from, to, false);
    const start = popFrame(path, 0);
    expect(start.scale).toBeCloseTo(0.3, 5);
    expect(start.opacity).toBe(0);
    const scales = Array.from(
      { length: 50 },
      (_, i) => popFrame(path, (i / 50) * POP_TIMING.popIn).scale,
    );
    expect(Math.max(...scales)).toBeGreaterThan(1.02);
    const hang = popFrame(path, POP_TIMING.popIn + POP_TIMING.hang / 2);
    expect(hang).toEqual({ x: from.x, y: from.y - POP_TIMING.rise, scale: 1, opacity: 1 });
    const end = popFrame(path, path.duration);
    expect(end.x).toBeCloseTo(to.x, 6);
    expect(end.y).toBeCloseTo(to.y, 6);
    expect(end.scale).toBeCloseTo(POP_TIMING.landScale, 6);
    expect(end.opacity).toBe(0);
  });

  it('pulls back before it flies (anticipation), then sweeps into the target from below', () => {
    const path = createPopPath(from, to, false);
    const flightStart = path.popIn + path.hang;
    const early = popFrame(path, flightStart + path.flight * 0.1);
    expect(early.y).toBeGreaterThan(from.y - POP_TIMING.rise);
    expect(early.y - (from.y - POP_TIMING.rise)).toBeLessThan(16);
    let lastY = Number.POSITIVE_INFINITY;
    for (let k = 0.4; k <= 1; k += 0.02) {
      const f = popFrame(path, flightStart + path.flight * k);
      expect(f.y).toBeGreaterThanOrEqual(to.y - 1e-6);
      expect(f.y).toBeLessThanOrEqual(lastY);
      lastY = f.y;
    }
  });

  it('has dissolved most of the way before it reaches a plaque label above the target', () => {
    const path = createPopPath(from, to, false);
    const flightStart = path.popIn + path.hang;
    for (let k = 0; k <= 1; k += 0.01) {
      const f = popFrame(path, flightStart + path.flight * k);
      if (f.y < to.y + 20) expect(f.opacity).toBeLessThan(0.5);
    }
  });

  it('flies longer for longer distances, within bounds', () => {
    const near = createPopPath(from, { x: 210, y: 560 }, false);
    const far = createPopPath(from, { x: 1800, y: -400 }, false);
    expect(near.flight).toBeGreaterThanOrEqual(POP_TIMING.minFlight);
    expect(far.flight).toBe(POP_TIMING.maxFlight);
    expect(far.flight).toBeGreaterThan(near.flight);
  });

  it('reduced motion fades in place without moving or scaling', () => {
    const path = createPopPath(from, to, true);
    const { fadeIn, hold, fadeOut } = POP_TIMING.reduced;
    expect(path.duration).toBeCloseTo(fadeIn + hold + fadeOut, 9);
    for (let t = 0; t <= path.duration; t += 0.02) {
      const f = popFrame(path, t);
      expect(f.x).toBe(from.x);
      expect(f.y).toBe(from.y);
      expect(f.scale).toBe(1);
    }
    expect(popFrame(path, fadeIn + hold / 2).opacity).toBe(1);
    expect(popFrame(path, path.duration).opacity).toBe(0);
  });

  it('rejects non-finite points', () => {
    expect(() => createPopPath({ x: Number.NaN, y: 0 }, to, false)).toThrow(RangeError);
  });

  it('sizes bigger values bigger, capped', () => {
    expect(popFontSize(5)).toBeLessThan(popFontSize(5000));
    expect(popFontSize(-5000)).toBe(popFontSize(5000));
    expect(popFontSize(1e30)).toBe(64);
    expect(popFontSize(0)).toBe(22);
  });
});

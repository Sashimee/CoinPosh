import i18next from 'i18next';
import { describe, expect, it, vi } from 'vitest';
import { POP_TIMING } from './arc.ts';
import { formatPopNumber, formatPopValue } from './format.ts';
import { TALLY_DELAY_S } from './numberPopLayer.ts';
import { readSurfaces } from './surfaces.ts';
import { PopTally } from './tally.ts';
import { credit, FRAME, run, setup } from './test/popDom.ts';

describe('readSurfaces', () => {
  it('reads an open sheet as blocking and covering', () => {
    const { doc, settings } = setup();
    const read = () => readSurfaces(doc as unknown as Document);
    expect(read()).toEqual({ blocking: false, covered: false });
    settings.open();
    expect(read()).toEqual({ blocking: true, covered: true });
  });

  it('keeps a closing sheet covering but no longer blocking', () => {
    const { doc, settings } = setup();
    settings.open();
    settings.startClosing();
    expect(readSurfaces(doc as unknown as Document)).toEqual({ blocking: false, covered: true });
    settings.finishClosing();
    expect(readSurfaces(doc as unknown as Document)).toEqual({ blocking: false, covered: false });
  });

  it('counts other modal dialogs and skips dismissed ones', () => {
    const { doc, host } = setup();
    const overlay = doc.createElement();
    overlay.setAttribute('aria-hidden', 'true');
    overlay.setAttribute('inert', '');
    const panel = doc.createElement();
    panel.setAttribute('aria-modal', 'true');
    overlay.append(panel);
    doc.body.append(overlay);
    expect(readSurfaces(doc as unknown as Document).covered).toBe(false);
    overlay.attrs.delete('aria-hidden');
    overlay.attrs.delete('inert');
    expect(readSurfaces(doc as unknown as Document).blocking).toBe(true);
    overlay.remove();
    const crate = doc.createElement();
    crate.setAttribute('aria-modal', 'true');
    host.append(crate);
    expect(readSurfaces(doc as unknown as Document)).toEqual({ blocking: true, covered: true });
  });
});

describe('PopTally', () => {
  it('is empty until something is held', () => {
    expect(new PopTally().take(String)).toBeNull();
  });

  it('passes a single held pop through untouched', () => {
    const tally = new PopTally();
    const only = credit(5);
    tally.add(only);
    expect(tally.take(() => 'unused')).toBe(only);
    expect(tally.size).toBe(0);
  });

  it('sums values, averages origins, keeps the latest target and the lead colour', () => {
    const tally = new PopTally();
    tally.add(credit(5, { from: { x: 100, y: 600 }, color: '#aaa' }));
    tally.add(credit(40, { from: { x: 200, y: 700 }, color: '#bbb' }));
    tally.add(credit(10, { from: { x: 300, y: 650 }, to: { x: 70, y: 50 }, color: '#ccc' }));
    const pop = tally.take((v) => `+${v}`);
    expect(pop).toMatchObject({
      text: '+55',
      magnitude: 55,
      color: '#bbb',
      prism: false,
      from: { x: 200, y: 650 },
      to: { x: 70, y: 50 },
    });
    expect(pop?.onArrive).toBeUndefined();
  });

  it('lets an heirloom share turn the whole tally prism', () => {
    const tally = new PopTally();
    tally.add(credit(500));
    tally.add(credit(1, { prism: true, color: '#fff' }));
    expect(tally.take(String)).toMatchObject({ prism: true, color: '#fff' });
  });

  it('fires every held arrival when the tally lands', () => {
    const tally = new PopTally();
    const a = vi.fn();
    const b = vi.fn();
    tally.add(credit(1, { onArrive: a }));
    tally.add(credit(2));
    tally.add(credit(3, { onArrive: b }));
    tally.take(String)?.onArrive?.();
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });
});

describe('formatPopNumber', () => {
  it('matches the i18next formatter for each language', async () => {
    for (const lng of ['en', 'fr', 'de']) {
      const i18n = i18next.createInstance();
      await i18n.init({ lng, fallbackLng: 'en', resources: {} });
      for (const value of [0, 7, 1234, -42, 2_500_000]) {
        expect(formatPopNumber(lng, value)).toBe(formatPopValue(i18n, value));
      }
    }
  });

  it('fails loudly without a language or a finite value', () => {
    expect(() => formatPopNumber('', 1)).toThrow(/lang/);
    expect(() => formatPopNumber('en', Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('NumberPopLayer over open sheets', () => {
  it('stacks under the UI host while a sheet is on screen, and back on top after', () => {
    const { layer, settings, sync } = setup();
    expect(layer.root.dataset.under).toBeUndefined();
    settings.open();
    sync();
    layer.update(FRAME);
    expect(layer.root.dataset.under).toBe('');
    settings.startClosing();
    sync();
    layer.update(FRAME);
    expect(layer.root.dataset.under).toBe('');
    settings.finishClosing();
    sync();
    layer.update(FRAME);
    expect(layer.root.dataset.under).toBeUndefined();
  });

  it('holds credits while a sheet is open: nothing shows over it', () => {
    const { layer, settings, sync, shown } = setup();
    settings.open();
    sync();
    for (const value of [5, 12, 3]) {
      layer.spawn(credit(value));
      run(layer, 1.5);
      expect(shown()).toHaveLength(0);
    }
    expect(layer.held).toBe(3);
    expect(layer.active).toBe(0);
  });

  it('lets pops already in flight finish under the sheet', () => {
    const { layer, settings, sync, shown } = setup();
    const arrive = vi.fn();
    layer.spawn(credit(9, { onArrive: arrive }));
    layer.update(FRAME);
    settings.open();
    sync();
    layer.update(FRAME);
    expect(shown()).toHaveLength(1);
    expect(layer.root.dataset.under).toBe('');
    run(layer, 2);
    expect(arrive).toHaveBeenCalledOnce();
    expect(layer.held).toBe(0);
  });

  it('plays one summed tally within 300 ms of the sheet closing', () => {
    const { layer, settings, sync, shown } = setup('de');
    const arrive = vi.fn();
    settings.open();
    sync();
    layer.spawn(credit(400, { onArrive: arrive }));
    layer.spawn(credit(950));
    run(layer, 3);
    settings.startClosing();
    sync();
    let visibleAt: number | null = null;
    let t = 0;
    while (t < 0.3 && visibleAt === null) {
      layer.update(FRAME);
      t += FRAME;
      const pop = shown()[0];
      if (pop && Number(pop.style.opacity) > 0) visibleAt = t;
    }
    expect(visibleAt).not.toBeNull();
    expect(visibleAt ?? 1).toBeLessThan(0.3);
    expect(visibleAt ?? 0).toBeGreaterThanOrEqual(TALLY_DELAY_S);
    expect(shown()).toHaveLength(1);
    expect(shown()[0]?.textContent).toBe('+1.350');
    expect(shown()[0]?.dataset.tally).toBe('');
    expect(layer.held).toBe(0);
    run(layer, 2);
    expect(arrive).toHaveBeenCalledOnce();
  });

  it('releases the tally on the first frame after closing when frames are slow', () => {
    const { layer, settings, sync, shown } = setup();
    settings.open();
    sync();
    layer.spawn(credit(5));
    layer.spawn(credit(6));
    settings.startClosing();
    sync();
    layer.update(0.2);
    expect(shown()).toHaveLength(1);
    expect(Number(shown()[0]?.style.opacity)).toBeGreaterThan(0);
  });

  it('keeps holding when the sheet is reopened before the tally beat', () => {
    const { layer, settings, sync, shown } = setup();
    settings.open();
    sync();
    layer.spawn(credit(5));
    settings.startClosing();
    sync();
    layer.update(FRAME);
    settings.open();
    sync();
    run(layer, 1);
    expect(shown()).toHaveLength(0);
    expect(layer.held).toBe(1);
  });

  it('arcs the tally into the Vault and lands it with rings and sparks', () => {
    const { layer, settings, sync, pops } = setup();
    settings.open();
    sync();
    layer.spawn(credit(5, { from: { x: 150, y: 600 } }));
    layer.spawn(credit(5, { from: { x: 250, y: 700 } }));
    settings.startClosing();
    settings.finishClosing();
    sync();
    const xs: number[] = [];
    const ys: number[] = [];
    run(layer, 2, () => {
      const pop = pops().find((el) => el.dataset.tally === '' && !el.hidden);
      const at = pop?.style.transform.match(/translate\(([-\d.]+)px,([-\d.]+)px/);
      if (at) {
        xs.push(Number(at[1]));
        ys.push(Number(at[2]));
      }
      if (pops().some((el) => el.className === 'cp-spark')) xs.push(Number.NaN);
    });
    expect(xs[0]).toBeCloseTo(200, 0);
    const landed = xs.findIndex(Number.isNaN);
    expect(landed).toBeGreaterThan(0);
    expect(Math.hypot((xs[landed - 1] ?? 0) - 60, (ys[landed - 1] ?? 0) - 48)).toBeLessThan(80);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(48);
  });

  it('reduced motion shows the tally in place, without the arc or sparks', () => {
    const { layer, settings, sync, pops, shown } = setup();
    layer.reducedMotion = true;
    settings.open();
    sync();
    layer.spawn(credit(5));
    layer.spawn(credit(7));
    settings.startClosing();
    sync();
    const positions = new Set<string>();
    let sawSpark = false;
    let sawRing = false;
    run(layer, 0.3 + POP_TIMING.reduced.fadeIn);
    expect(shown()[0]?.textContent).toBe('+12');
    run(layer, 2, () => {
      const pop = shown()[0];
      if (pop) positions.add(pop.style.transform);
      sawSpark ||= pops().some((el) => el.className === 'cp-spark');
      sawRing ||= pops().some((el) => el.className === 'cp-burst');
    });
    expect(positions.size).toBe(1);
    expect(sawSpark).toBe(false);
    expect(sawRing).toBe(false);
  });

  it('drops held credits on clear', () => {
    const { layer, settings, sync, shown } = setup();
    settings.open();
    sync();
    layer.spawn(credit(5));
    layer.clear();
    settings.startClosing();
    sync();
    run(layer, 1);
    expect(shown()).toHaveLength(0);
  });
});

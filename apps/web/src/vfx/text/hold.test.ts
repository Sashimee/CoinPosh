import i18next from 'i18next';
import { describe, expect, it, vi } from 'vitest';
import { POP_TIMING } from './arc.ts';
import { formatPopNumber, formatPopValue } from './format.ts';
import { NumberPopLayer, TALLY_DELAY_S, type PopRequest } from './numberPopLayer.ts';
import { NO_SURFACE, readSurfaces, type SurfaceState } from './surfaces.ts';
import { PopTally } from './tally.ts';

const FRAME = 1 / 60;

/** Just enough DOM for NumberPopLayer: the suite runs in node. */
class FakeStyle {
  transform = '';
  opacity = '';
  fontSize = '';
  private readonly props = new Map<string, string>();
  setProperty(name: string, value: string): void {
    this.props.set(name, value);
  }
  getPropertyValue(name: string): string {
    return this.props.get(name) ?? '';
  }
}

class FakeElement {
  readonly style = new FakeStyle();
  readonly dataset: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  readonly classList: { contains(name: string): boolean };
  parent: FakeElement | null = null;
  hidden = false;
  className = '';
  id = '';
  textContent = '';
  lang = '';
  readonly attrs = new Map<string, string>();
  readonly clientWidth = 390;
  readonly clientHeight = 844;

  constructor(readonly ownerDocument: FakeDocument) {
    this.classList = { contains: (name) => this.className.split(' ').includes(name) };
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }

  remove(): void {
    const siblings = this.parent?.children;
    siblings?.splice(siblings.indexOf(this), 1);
    this.parent = null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
  }

  /** Supports exactly the selectors `readSurfaces` uses. */
  matches(selector: string): boolean {
    return selector.split(',').some((part) => {
      const s = part.trim();
      if (s === '[hidden]') return this.hidden;
      if (s === '[inert]') return this.attrs.has('inert');
      if (s === '[aria-hidden="true"]') return this.attrs.get('aria-hidden') === 'true';
      if (s === '[aria-modal="true"]') return this.attrs.get('aria-modal') === 'true';
      if (s.startsWith('.')) return this.classList.contains(s.slice(1));
      throw new Error(`FakeElement cannot match ${s}`);
    });
  }

  closest(selector: string): FakeElement | null {
    if (this.matches(selector)) return this;
    return this.parent?.closest(selector) ?? null;
  }

  all(): FakeElement[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
}

class FakeDocument {
  readonly documentElement: FakeElement = new FakeElement(this);
  readonly head: FakeElement = new FakeElement(this);
  readonly body: FakeElement = new FakeElement(this);

  constructor() {
    this.documentElement.append(this.head, this.body);
  }

  createElement(): FakeElement {
    return new FakeElement(this);
  }

  getElementById(id: string): FakeElement | null {
    return this.documentElement.all().find((el) => el.id === id) ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.documentElement.all().filter((el) => el.matches(selector));
  }
}

function sheet(doc: FakeDocument, host: FakeElement) {
  const layer = doc.createElement();
  layer.className = 'cp-sheet-layer';
  layer.hidden = true;
  const panel = doc.createElement();
  panel.className = 'cp-sheet cp-panel';
  panel.setAttribute('aria-modal', 'true');
  layer.append(panel);
  host.append(layer);
  return {
    layer,
    open() {
      layer.hidden = false;
      layer.className = 'cp-sheet-layer is-open';
    },
    startClosing() {
      layer.className = 'cp-sheet-layer';
    },
    finishClosing() {
      layer.hidden = true;
    },
  };
}

function setup(lang = 'en') {
  const doc = new FakeDocument();
  doc.documentElement.lang = lang;
  const host = doc.createElement();
  host.className = 'cp-ui-host';
  doc.body.append(host);
  const settings = sheet(doc, host);
  let state: SurfaceState = NO_SURFACE;
  const layer = new NumberPopLayer(host as unknown as HTMLElement, () => ({
    read: () => state,
    dispose: () => undefined,
  }));
  const pops = () => layer.root.children as unknown as FakeElement[];
  const shown = () => pops().filter((el) => el.className === 'cp-pop' && !el.hidden);
  const sync = () => {
    state = readSurfaces(doc as unknown as Document);
  };
  return { doc, host, settings, layer, shown, pops, sync };
}

function credit(magnitude: number, overrides: Partial<PopRequest> = {}): PopRequest {
  return {
    text: `+${magnitude}`,
    magnitude,
    color: '#f5b942',
    prism: false,
    from: { x: 195, y: 640 },
    to: { x: 60, y: 48 },
    ...overrides,
  };
}

function run(layer: NumberPopLayer, seconds: number, each?: () => void): void {
  for (let t = 0; t < seconds; t += FRAME) {
    layer.update(FRAME);
    each?.();
  }
}

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
    run(layer, 2, () => {
      const pop = pops().find((el) => el.dataset.tally === '' && !el.hidden);
      const x = pop?.style.transform.match(/translate\(([-\d.]+)px/)?.[1];
      if (x) xs.push(Number(x));
      if (pops().some((el) => el.className === 'cp-spark')) xs.push(Number.NaN);
    });
    expect(xs[0]).toBeCloseTo(200, 0);
    const landed = xs.findIndex(Number.isNaN);
    expect(landed).toBeGreaterThan(0);
    expect(xs[landed - 1]).toBeLessThan(80);
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

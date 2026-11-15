import { readFileSync } from 'node:fs';
import { upgradeCost, upgradeLines } from '@coinposh/economy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBus } from '../../app/bus.ts';
import { upgradeRow, vaultReadout } from '../../app/model.ts';
import { defaultSettings } from '../../app/settings.ts';
import { initialUiState, type UiEvents } from '../../app/state.ts';
import { createStore } from '../../app/store.ts';
import { BUNDLED_RESOURCES, createI18n, LANGUAGES, type Language } from '../../i18n/index.ts';
import type { UiContext } from '../context.ts';
import { Localizer } from '../localize.ts';
import { setMotionPreference } from '../motion/reduced.ts';
import {
  balanceCopy,
  createUpgradesPanel,
  fitScale,
  shortfallCopy,
  SPEND_TICK_MS,
  UPGRADE_SHEET_LINES,
  UPGRADE_SHEET_SECTIONS,
  upgradeRowCopy,
  upgradeShortfall,
  type UpgradeRowCopy,
} from './upgradesPanel.ts';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

function declarations(selector: string): Record<string, string> {
  const merged: Record<string, string> = {};
  let found = false;
  for (const [, selectors = '', body = ''] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectors.split(',').some((part) => part.trim() === selector)) continue;
    found = true;
    for (const declaration of body.split(';')) {
      const colon = declaration.indexOf(':');
      if (colon < 0) continue;
      merged[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
    }
  }
  if (!found) throw new Error(`styles.css has no rule for "${selector}"`);
  return merged;
}

function px(value: string | undefined): number {
  const match = /^(\d+(?:\.\d+)?)px$/.exec(value ?? '');
  if (!match) throw new Error(`expected a fixed px length, got "${value}"`);
  return Number(match[1]);
}

/** Tracks at the top level of a grid template, so `minmax(0, 1fr)` stays one track. */
function tracks(template: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of template) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ' ' && depth === 0) {
      if (current) out.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current) out.push(current);
  return out;
}

/** Measured in Chromium: the widest stat line, "10 Std. → 11 Std.", sets 17 glyphs in 115 px. */
const PX_PER_CHAR_12PX_SEMIBOLD = 7;
/** The text column of a row on a 360 px phone, the narrowest supported viewport, as measured. */
const TEXT_COLUMN_AT_360_PX = 132;

function everyRowCopy(): { where: string; copy: UpgradeRowCopy; maxed: boolean }[] {
  const out: { where: string; copy: UpgradeRowCopy; maxed: boolean }[] = [];
  for (const language of LANGUAGES) {
    const i18n = createI18n({ language, resources: BUNDLED_RESOURCES });
    const t = i18n.t.bind(i18n);
    for (const line of upgradeLines) {
      for (let level = 0; level <= line.maxLevel; level++) {
        const view = upgradeRow(line, level, { coins: 0, goldBars: 0 });
        for (const pending of [false, true]) {
          out.push({
            where: `${language} ${line.id} level ${level}${pending ? ' pending' : ''}`,
            copy: upgradeRowCopy(t, view, language, pending),
            maxed: view.maxed,
          });
        }
      }
    }
  }
  return out;
}

describe('upgrade row layout', () => {
  it('gives the text column a width no purchase can change', () => {
    const row = declarations('.cp-upgrade');
    const columns = tracks(row['grid-template-columns'] ?? '');
    expect(columns).toEqual(['40px', 'minmax(0, 1fr)', 'var(--cp-upgrade-buy-width)']);
    expect(px(row['--cp-upgrade-buy-width'])).toBeGreaterThanOrEqual(86);
    const buy = declarations('.cp-upgrade > .cp-buy');
    expect(buy.width).toBe('100%');
    expect(buy['min-width']).toBe('0');
  });

  it('lays the stat line and the level meter on two fixed rows that never wrap', () => {
    const meta = declarations('.cp-upgrade-meta');
    expect(meta.display).toBe('grid');
    expect(meta['flex-wrap']).toBeUndefined();
    expect(tracks(meta['grid-template-columns'] ?? '')).toEqual(['minmax(0, 1fr)']);
    const [statRow, meterRow, ...extra] = tracks(meta['grid-template-rows'] ?? '').map(px);
    expect(extra).toEqual([]);

    const effect = declarations('.cp-upgrade-effect');
    expect(effect['white-space']).toBe('nowrap');
    expect(effect.overflow).toBe('hidden');
    expect(px(effect['line-height'])).toBe(statRow);

    const meter = declarations('.cp-upgrade-progress');
    expect(meter['white-space']).toBe('nowrap');
    expect(meter.overflow).toBe('hidden');
    expect(px(meter.height)).toBe(meterRow);
    expect(px(meter['line-height'])).toBe(meterRow);
    expect(declarations('.cp-upgrade-level').flex).toBe('none');
    expect(declarations('.cp-level-bar').flex).toBe('none');
  });

  it('keeps the buy label and price on one line inside the fixed column', () => {
    expect(declarations('.cp-upgrade .cp-buy-label')['white-space']).toBe('nowrap');
    expect(declarations('.cp-upgrade .cp-buy-cost')['white-space']).toBe('nowrap');
  });

  it('sizes the level text for three-digit levels so the meter never slides', () => {
    const longest = Math.max(...everyRowCopy().map(({ copy }) => copy.level.length));
    const reserved = Number(
      /^(\d+(?:\.\d+)?)ch$/.exec(declarations('.cp-upgrade-level')['min-width'] ?? '')?.[1],
    );
    expect(reserved).toBeGreaterThanOrEqual(longest - 0.5);
  });
});

describe('fitScale', () => {
  it('leaves a part that fits at full size', () => {
    expect(fitScale(64, 92)).toBe(1);
    expect(fitScale(92, 92)).toBe(1);
  });

  it('shrinks a part that outgrows the column to exactly fill it', () => {
    expect(fitScale(113, 92)).toBeCloseTo(92 / 113, 10);
    expect(fitScale(113, 92) * 113).toBeCloseTo(92, 10);
  });

  it('leaves a part alone while it or its button is not laid out', () => {
    expect(fitScale(0, 92)).toBe(1);
    expect(fitScale(113, 0)).toBe(1);
    expect(fitScale(113, -12)).toBe(1);
    expect(fitScale(113, Number.NaN)).toBe(1);
  });
});

describe('upgradeRowCopy', () => {
  const rows = everyRowCopy();

  it('covers every level from 0 to max of every line in EN, FR and DE', () => {
    const levels = upgradeLines.reduce((sum, line) => sum + line.maxLevel + 1, 0);
    expect(rows).toHaveLength(levels * LANGUAGES.length * 2);
  });

  it('writes single-line copy that fits the fixed stat column at every level', () => {
    for (const { where, copy } of rows) {
      for (const text of [copy.effect, copy.level, copy.buyLabel, copy.price]) {
        expect(text, where).not.toMatch(/[\n\r]/);
      }
      expect(copy.effect, where).not.toBe('');
      expect(copy.effect.length * PX_PER_CHAR_12PX_SEMIBOLD, where).toBeLessThanOrEqual(
        TEXT_COLUMN_AT_360_PX,
      );
    }
  });

  it('always has a buy label', () => {
    for (const { where, copy } of rows) expect(copy.buyLabel, where).not.toBe('');
  });

  it('shows a price until the line is maxed, then none', () => {
    for (const { where, copy, maxed } of rows) {
      if (maxed) expect(copy.price, where).toBe('');
      else expect(copy.price, where).toMatch(/\d/);
    }
  });

  it('formats the stat line with the next level, and the final value once maxed', () => {
    const i18n = createI18n({ language: 'en', resources: BUNDLED_RESOURCES });
    const t = i18n.t.bind(i18n);
    const line = upgradeLines.find((candidate) => candidate.id === 'pusherSpeed');
    if (!line) throw new Error('economy has no pusherSpeed line');
    const first = upgradeRow(line, 1, { coins: 0, goldBars: 0 });
    expect(upgradeRowCopy(t, first, 'en', false)).toEqual({
      effect: '×1.06 → ×1.12',
      level: 'Lv 1',
      buyLabel: 'Buy',
      price: String(first.cost),
    });
    expect(upgradeRowCopy(t, first, 'en', true).buyLabel).toBe('Confirming…');
    const maxed = upgradeRow(line, line.maxLevel, { coins: 0, goldBars: 0 });
    expect(upgradeRowCopy(t, maxed, 'en', true)).toEqual({
      effect: '×4',
      level: `Lv ${line.maxLevel}`,
      buyLabel: 'Maxed',
      price: '',
    });
  });

  it.each(LANGUAGES)(
    '%s prices a row the plaque covers with the same copy whatever the drop buffer holds',
    (language) => {
      const i18n = createI18n({ language, resources: BUNDLED_RESOURCES });
      const t = i18n.t.bind(i18n);
      const line = upgradeLines.find((candidate) => candidate.id === 'pusherSpeed');
      if (!line) throw new Error('economy has no pusherSpeed line');
      const price = upgradeRow(line, 0, { coins: 0, goldBars: 0 }).cost ?? 0;
      const copies = [0, 12, 480].map((bufferedCoins) => {
        const plaque = vaultReadout({
          walletCoins: price,
          bufferedCoins,
          provisionalCoins: 0,
          goldBars: 0,
        });
        const row = upgradeRow(line, 0, plaque);
        expect(row.affordable, `${String(bufferedCoins)} coins in hand`).toBe(true);
        return upgradeRowCopy(t, row, language, false);
      });
      expect(new Set(copies.map((copy) => JSON.stringify(copy))).size).toBe(1);
      expect(copies[0]).toEqual({
        effect: expect.any(String) as string,
        level: t('upgrades.level', { level: 0 }),
        buyLabel: t('upgrades.buy'),
        price: expect.any(String) as string,
      });
    },
  );
});

describe('upgrades sheet sections', () => {
  it('renders no Family Office (upgrades-global) section', () => {
    expect(UPGRADE_SHEET_SECTIONS.map((section) => section.id)).toEqual(['venue']);
  });

  it('lists every venue line and no Gold Bar line', () => {
    expect(upgradeLines.some((line) => line.scope === 'global')).toBe(true);
    const venueIds = upgradeLines.filter((line) => line.scope === 'venue').map((line) => line.id);
    expect(UPGRADE_SHEET_LINES.map((line) => line.id)).toEqual(venueIds);
    expect(UPGRADE_SHEET_LINES.every((line) => line.currency === 'coins')).toBe(true);
  });
});

type Listener = (event: unknown) => void;

/** Just enough DOM for the sheet's rows, its purse and their odometers: the suite runs in node. */
class FakeNode {
  parent: FakeNode | null = null;
  readonly children: FakeNode[] = [];
  readonly attrs = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, Set<Listener>>();
  readonly style: Record<string, string> & { setProperty(name: string, value: string): void };
  readonly clientWidth = 106;
  readonly offsetWidth = 60;
  readonly offsetHeight = 56;
  #text = '';

  constructor(readonly tagName: string) {
    const properties: Record<string, string> = {};
    this.style = Object.assign(properties, {
      setProperty: (name: string, value: string) => {
        properties[name] = value;
      },
    });
  }

  get className(): string {
    return this.attrs.get('class') ?? '';
  }
  set className(value: string) {
    this.attrs.set('class', value);
  }

  readonly classList = {
    contains: (name: string): boolean => this.className.split(/\s+/).includes(name),
    add: (name: string): void => {
      if (!this.classList.contains(name)) this.className = `${this.className} ${name}`.trim();
    },
    remove: (name: string): void => {
      this.className = this.className
        .split(/\s+/)
        .filter((part) => part !== name)
        .join(' ');
    },
    toggle: (name: string, on: boolean): void => {
      if (on) this.classList.add(name);
      else this.classList.remove(name);
    },
  };

  get textContent(): string {
    return this.#text + this.children.map((child) => child.textContent).join('');
  }
  set textContent(value: string) {
    this.replaceChildren();
    this.#text = value;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  append(...nodes: (FakeNode | string)[]): void {
    for (const node of nodes) {
      if (typeof node === 'string') {
        this.#text += node;
        continue;
      }
      node.remove();
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes: FakeNode[]): void {
    for (const child of [...this.children]) child.remove();
    this.#text = '';
    this.append(...nodes);
  }
  remove(): void {
    const siblings = this.parent?.children;
    siblings?.splice(siblings.indexOf(this), 1);
    this.parent = null;
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }
  click(): void {
    for (const listener of [...(this.listeners.get('click') ?? [])]) listener({ button: 0 });
  }

  matches(selector: string): boolean {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    const testId = /^\[data-testid="(.+)"\]$/.exec(selector);
    if (testId) return this.attrs.get('data-testid') === testId[1];
    const attr = /^\[([a-z-]+)\]$/.exec(selector);
    if (attr?.[1]) return this.attrs.has(attr[1]);
    throw new Error(`FakeNode cannot match ${selector}`);
  }
  all(): FakeNode[] {
    return this.children.flatMap((child) => [child, ...child.all()]);
  }
  find(selector: string): FakeNode {
    const found = this.all().find((node) => node.matches(selector));
    if (!found) throw new Error(`the upgrades panel has no ${selector}`);
    return found;
  }

  getBoundingClientRect(): DOMRect {
    return { left: 0, top: 0, width: 60, height: 20 } as DOMRect;
  }

  /** `fromMarkup` parses icons through a template; their markup is opaque here. */
  get innerHTML(): string {
    return '';
  }
  set innerHTML(_markup: string) {
    this.replaceChildren(new FakeNode('svg'));
  }
  get content(): { firstElementChild: FakeNode | null } {
    return { firstElementChild: this.children[0] ?? null };
  }
}

class InertObserver {
  observe = (): void => undefined;
  disconnect = (): void => undefined;
}

/** Reads an odometer as the eye does: each wheel's resting digit, separators as they stand. */
function odometerText(odometer: FakeNode): string {
  return odometer.children
    .filter((cell) => cell.style.display !== 'none')
    .map((cell) => {
      const strip = cell.children[0];
      if (!cell.classList.contains('cp-odo-col') || !strip) return cell.textContent;
      const shift = /^translateY\((.+)em\)$/.exec(strip.style.transform ?? '');
      const position = -Number(shift?.[1]);
      if (!Number.isFinite(position)) {
        throw new Error(`an odometer wheel has no place: "${String(strip.style.transform)}"`);
      }
      return Number.isInteger(position) ? String(position % 10) : '~';
    })
    .join('');
}

const SPEND_PRICE = 37;
const OUT_OF_REACH_PRICE = 150;
const WALLET = 128;

function lineCosting(price: number): string {
  const line = UPGRADE_SHEET_LINES.find((candidate) => upgradeCost(candidate, 0) === price);
  if (!line) throw new Error(`no sheet line opens at ${String(price)} coins in the economy`);
  return line.id;
}

let frames: FrameRequestCallback[] = [];
let clock = 0;

function runFrames(ms: number): void {
  const until = clock + ms;
  while (frames.length > 0 && clock < until) {
    clock += 1000 / 60;
    for (const frame of frames.splice(0)) frame(clock);
  }
}

function mountSheet(language: Language = 'en') {
  vi.stubGlobal('document', {
    createElement: (tag: string) => new FakeNode(tag),
    fonts: { addEventListener: () => undefined, removeEventListener: () => undefined },
  });
  vi.stubGlobal('HTMLElement', FakeNode);
  vi.stubGlobal('ResizeObserver', InertObserver);
  vi.stubGlobal('getComputedStyle', () => ({ paddingLeft: '6', paddingRight: '6' }));
  vi.stubGlobal('performance', { now: () => clock });
  vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => frames.push(frame));
  const i18n = createI18n({ language, resources: BUNDLED_RESOURCES });
  const store = createStore(initialUiState(defaultSettings(language)));
  store.setState({ coins: WALLET, spendableCoins: WALLET });
  const bus = createBus<UiEvents>();
  const requests: UiEvents['upgrades:request'][] = [];
  const feedback: string[] = [];
  bus.on('upgrades:request', (request) => requests.push(request));
  bus.on('ui:feedback', ({ kind }) => feedback.push(kind));
  const disposers: (() => void)[] = [];
  const ctx: UiContext = {
    i18n,
    loc: new Localizer(i18n),
    store,
    bus,
    own: (dispose) => disposers.push(dispose),
  };
  const panel = createUpgradesPanel(ctx) as unknown as FakeNode;
  store.setState({ panel: 'upgrades' });
  const purse = panel.find('[data-testid="upgrades-balance"]');
  const buyButton = (lineId: string) => panel.find(`[data-testid="upgrade-buy-${lineId}"]`);
  return {
    store,
    requests,
    feedback,
    purse,
    chip: () => odometerText(purse.find('.cp-odo')),
    spoken: () => purse.find('[aria-live]'),
    buy: (lineId: string) => {
      buyButton(lineId).click();
    },
    buyLabel: (lineId: string) => buyButton(lineId).find('.cp-buy-label').textContent,
    buyAria: (lineId: string) => buyButton(lineId).getAttribute('aria-label') ?? '',
    /** The server's answer, in the order the upgrades controller applies it. */
    confirm: (lineId: string, level: number, coins: number) => {
      store.setState({ coins, spendableCoins: coins });
      store.setState((s) => ({
        upgradeLevels: { ...s.upgradeLevels, [lineId]: level },
        pendingUpgrade: null,
      }));
    },
    dispose: () => {
      for (const off of disposers.splice(0).reverse()) off();
    },
  };
}

describe('upgrades sheet purse', () => {
  const spendLine = lineCosting(SPEND_PRICE);
  const farLine = lineCosting(OUT_OF_REACH_PRICE);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    frames = [];
  });
  afterEach(() => {
    runFrames(10_000);
    setMotionPreference('system');
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('opens on the wallet, counts a 37-coin buy down to 91 and re-prices the rows out of reach', () => {
    const sheet = mountSheet();
    expect(sheet.chip()).toBe('128');
    expect(sheet.purse.dataset.value).toBe('128');
    expect(sheet.buyLabel(farLine)).toBe('22 more');
    expect(sheet.buyAria(farLine)).toContain('22 more coins needed');

    sheet.buy(spendLine);
    expect(sheet.requests).toEqual([{ lineId: spendLine, fromLevel: 0 }]);
    expect(sheet.chip(), 'no guess at the price before the server answers').toBe('128');
    expect(sheet.purse.classList.contains('is-pending')).toBe(true);
    runFrames(1000);

    sheet.confirm(spendLine, 1, WALLET - SPEND_PRICE);
    expect(sheet.chip(), 'the count-down starts from the old balance').toBe('128');
    expect(frames.length).toBeGreaterThan(0);
    expect(sheet.purse.classList.contains('is-spending')).toBe(true);
    expect(sheet.purse.find('.cp-upgrades-spent').textContent).toBe('−37');
    expect(sheet.feedback).toContain('tick');

    runFrames(1000);
    expect(sheet.chip()).toBe('91');
    expect(sheet.purse.dataset.value).toBe('91');
    expect(sheet.purse.classList.contains('is-pending')).toBe(false);
    expect(sheet.buyLabel(farLine)).toBe('59 more');
    expect(sheet.buyAria(farLine)).toContain('59 more coins needed');
    expect(sheet.buyLabel(spendLine)).toBe('Buy');

    vi.advanceTimersByTime(SPEND_TICK_MS);
    expect(sheet.purse.classList.contains('is-spending')).toBe(false);
    sheet.dispose();
  });

  it('shows the wallet the server reports, not the one the price predicts', () => {
    const sheet = mountSheet();
    sheet.buy(spendLine);
    const reported = WALLET - SPEND_PRICE + 6;
    sheet.confirm(spendLine, 1, reported);
    runFrames(1000);
    expect(sheet.chip()).toBe(String(reported));
    expect(sheet.spoken().textContent).toBe(`${String(reported)} coins to spend`);
    expect(sheet.purse.find('.cp-upgrades-spent').textContent).toBe(
      `−${String(WALLET - reported)}`,
    );
    sheet.dispose();
  });

  it('keeps the old balance when the server refuses the buy', () => {
    const sheet = mountSheet();
    sheet.buy(spendLine);
    sheet.store.setState({ pendingUpgrade: null });
    runFrames(1000);
    expect(sheet.chip()).toBe('128');
    expect(sheet.purse.classList.contains('is-spending')).toBe(false);
    expect(sheet.feedback).not.toContain('tick');
    sheet.dispose();
  });

  it('announces the balance politely to screen readers as it changes', () => {
    const sheet = mountSheet();
    const live = sheet.spoken();
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.getAttribute('role')).toBe('status');
    expect(live.getAttribute('aria-atomic')).toBe('true');
    expect(live.textContent).toBe('128 coins to spend');
    sheet.buy(spendLine);
    sheet.confirm(spendLine, 1, WALLET - SPEND_PRICE);
    expect(live.textContent).toBe('91 coins to spend');
    sheet.store.setState({ coins: 1, spendableCoins: 1 });
    expect(live.textContent).toBe('1 coin to spend');
    sheet.dispose();
  });

  it('changes the readout at once under reduced motion, with no frames to wait for', () => {
    setMotionPreference('reduced');
    const sheet = mountSheet();
    sheet.buy(spendLine);
    runFrames(1000);
    sheet.confirm(spendLine, 1, WALLET - SPEND_PRICE);
    expect(sheet.chip()).toBe('91');
    expect(frames).toEqual([]);
    expect(sheet.purse.classList.contains('is-calm')).toBe(true);
    expect(sheet.purse.classList.contains('is-spending')).toBe(true);
    expect(sheet.purse.find('.cp-upgrades-chip').style.scale ?? '').toBe('');
    sheet.dispose();
  });

  it('jumps without fanfare while the sheet is closed', () => {
    const sheet = mountSheet();
    sheet.store.setState({ panel: null });
    sheet.store.setState({ coins: 300, spendableCoins: 300 });
    expect(sheet.chip()).toBe('300');
    expect(frames).toEqual([]);
    expect(sheet.feedback).not.toContain('tick');
    sheet.dispose();
  });

  it('prices rows against spendable coins, not winnings still waiting on the server', () => {
    const sheet = mountSheet();
    sheet.store.setState({ coins: 400, spendableCoins: 140 });
    runFrames(1000);
    expect(sheet.chip()).toBe('140');
    expect(sheet.buyLabel(farLine)).toBe('10 more');
    sheet.dispose();
  });

  it.each([
    ['fr', 'encore 22', '91 pièces à dépenser'],
    ['de', 'noch 22', '91 Münzen verfügbar'],
  ] as const)('%s names the shortfall and the purse in its own words', (language, short, purse) => {
    const sheet = mountSheet(language);
    expect(sheet.buyLabel(farLine)).toBe(short);
    sheet.buy(spendLine);
    sheet.confirm(spendLine, 1, WALLET - SPEND_PRICE);
    expect(sheet.spoken().textContent).toBe(purse);
    sheet.dispose();
  });
});

describe('shortfall copy', () => {
  const cases = {
    en: {
      one: { label: '1 more', spoken: '1 more coin needed' },
      many: { label: '22 more', spoken: '22 more coins needed' },
      bars: '2 more gold bars needed',
    },
    fr: {
      one: { label: 'encore 1', spoken: 'Il manque 1 pièce' },
      many: { label: 'encore 22', spoken: 'Il manque 22 pièces' },
      bars: "Il manque 2 lingots d'or",
    },
    de: {
      one: { label: 'noch 1', spoken: 'Noch 1 Münze nötig' },
      many: { label: 'noch 22', spoken: 'Noch 22 Münzen nötig' },
      bars: 'Noch 2 Goldbarren nötig',
    },
  } as const;

  it.each(LANGUAGES)('%s uses its singular and plural forms', (language) => {
    const i18n = createI18n({ language, resources: BUNDLED_RESOURCES });
    const t = i18n.t.bind(i18n);
    expect(shortfallCopy(t, 1, 'coins', language)).toEqual(cases[language].one);
    expect(shortfallCopy(t, 22, 'coins', language)).toEqual(cases[language].many);
    expect(shortfallCopy(t, 2, 'goldBars', language).spoken).toBe(cases[language].bars);
  });

  it.each(LANGUAGES)('%s groups a large shortfall the way it groups prices', (language) => {
    const i18n = createI18n({ language, resources: BUNDLED_RESOURCES });
    const copy = shortfallCopy(i18n.t.bind(i18n), 24_872, 'coins', language);
    expect(copy.label).toContain(new Intl.NumberFormat(language).format(24_872));
  });

  it.each(LANGUAGES)('%s reads the purse with the plural its count needs', (language) => {
    const i18n = createI18n({ language, resources: BUNDLED_RESOURCES });
    const t = i18n.t.bind(i18n);
    expect(balanceCopy(t, 1, language).spoken).toBe(t('upgrades.balance.aria_one', { value: '1' }));
    expect(balanceCopy(t, 91, language)).toEqual({
      amount: '91',
      spoken: t('upgrades.balance.aria_other', { value: '91' }),
    });
  });
});

describe('upgradeShortfall', () => {
  const line = upgradeLines.find((candidate) => upgradeCost(candidate, 0) === OUT_OF_REACH_PRICE);
  if (!line) throw new Error('no line opens at the out-of-reach price');

  it('is the price less what the wallet can spend', () => {
    const wallet = { coins: WALLET, goldBars: 0 };
    expect(upgradeShortfall(upgradeRow(line, 0, wallet), wallet)).toBe(22);
  });

  it('is null at exactly the price, above it, and once the line is maxed', () => {
    const exact = { coins: OUT_OF_REACH_PRICE, goldBars: 0 };
    expect(upgradeShortfall(upgradeRow(line, 0, exact), exact)).toBeNull();
    const rich = { coins: 1e9, goldBars: 0 };
    expect(upgradeShortfall(upgradeRow(line, 0, rich), rich)).toBeNull();
    const broke = { coins: 0, goldBars: 0 };
    expect(upgradeShortfall(upgradeRow(line, line.maxLevel, broke), broke)).toBeNull();
  });

  it('is one coin when a single coin is missing', () => {
    const wallet = { coins: OUT_OF_REACH_PRICE - 1, goldBars: 0 };
    expect(upgradeShortfall(upgradeRow(line, 0, wallet), wallet)).toBe(1);
  });

  it('counts only spendable coins', () => {
    const wallet = { coins: 400, spendableCoins: 100, goldBars: 0 };
    expect(upgradeShortfall(upgradeRow(line, 0, wallet), wallet)).toBe(50);
  });

  it('counts Gold Bars for a Family Office line', () => {
    const global = upgradeLines.find((candidate) => candidate.currency === 'goldBars');
    if (!global) throw new Error('economy has no Gold Bar line');
    const wallet = { coins: 1e9, goldBars: 0 };
    expect(upgradeShortfall(upgradeRow(global, 0, wallet), wallet)).toBe(upgradeCost(global, 0));
  });
});

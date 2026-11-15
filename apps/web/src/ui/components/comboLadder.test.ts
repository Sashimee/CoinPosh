import { cascade } from '@coinposh/economy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBus } from '../../app/bus.ts';
import { defaultSettings } from '../../app/settings.ts';
import { initialUiState, type UiEvents } from '../../app/state.ts';
import { createStore } from '../../app/store.ts';
import deUi from '../../i18n/locales/de/ui.json';
import enUi from '../../i18n/locales/en/ui.json';
import frUi from '../../i18n/locales/fr/ui.json';
import {
  BUNDLED_RESOURCES,
  createI18n,
  type InterpolationValues,
  type Language,
} from '../../i18n/index.ts';
import type { UiContext } from '../context.ts';
import { Localizer } from '../localize.ts';
import { setMotionPreference } from '../motion/reduced.ts';
import { createComboLadder } from './comboLadder.ts';

/** Just enough of an element for the ladder and its rail to build, caption and toggle state. */
class FakeNode {
  readonly children: FakeNode[] = [];
  parent: FakeNode | null = null;
  readonly attrs = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, unknown> = { setProperty: (): void => undefined };
  clientWidth = 160;
  #text = '';

  /** Lays out a node's width when a test needs real text widths; null keeps every node 40 px. */
  static measure: ((node: FakeNode) => number) | null = null;

  get offsetWidth(): number {
    return FakeNode.measure?.(this) ?? 40;
  }

  constructor(readonly tagName: string) {}

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

  hidden = false;

  get textContent(): string {
    return this.#text + this.children.map((child) => child.textContent).join('');
  }
  set textContent(value: string) {
    this.children.splice(0);
    this.#text = value;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  append(...nodes: (FakeNode | string)[]): void {
    for (const node of nodes) {
      if (typeof node === 'string') {
        this.#text += node;
        continue;
      }
      node.parent = this;
      this.children.push(node);
    }
  }

  matches(selector: string): boolean {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    throw new Error(`FakeNode cannot match ${selector}`);
  }
  closest(selector: string): FakeNode | null {
    return this.matches(selector) ? this : (this.parent?.closest(selector) ?? null);
  }
  all(): FakeNode[] {
    return this.children.flatMap((child) => [child, ...child.all()]);
  }
  querySelector(selector: string): FakeNode | null {
    return this.all().find((node) => node.matches(selector)) ?? null;
  }
  querySelectorAll(selector: string): FakeNode[] {
    return this.all().filter((node) => node.matches(selector));
  }

  getBoundingClientRect(): DOMRect {
    return { left: 0, top: 0, width: 40, height: 20 } as DOMRect;
  }
  animate(): { cancel: () => void } {
    return { cancel: () => undefined };
  }

  /** `fromMarkup` builds the flute: keep one node per classed element so its layers resolve. */
  set innerHTML(markup: string) {
    const svg = new FakeNode('svg');
    for (const [, name] of markup.matchAll(/class="([^"]+)"/g)) {
      const node = new FakeNode('path');
      node.className = name ?? '';
      svg.append(node);
    }
    this.children.splice(0);
    this.append(svg);
  }
  get content(): { firstElementChild: FakeNode | null } {
    return { firstElementChild: this.children[0] ?? null };
  }
}

class InertObserver {
  observe = (): void => undefined;
  disconnect = (): void => undefined;
}

interface MountOptions {
  readonly create?: typeof createComboLadder;
  readonly computedStyle?: (node: FakeNode) => Record<string, string>;
  /** Collects the frames the ladder requests, for the test to run; by default none ever runs. */
  readonly frames?: FrameRequestCallback[];
}

function mountLadder(language: Language, options: MountOptions = {}) {
  vi.stubGlobal('document', {
    createElement: (tag: string) => new FakeNode(tag),
    fonts: { addEventListener: () => undefined, removeEventListener: () => undefined },
  });
  vi.stubGlobal('HTMLElement', FakeNode);
  const frames = options.frames;
  vi.stubGlobal(
    'requestAnimationFrame',
    frames ? (callback: FrameRequestCallback) => frames.push(callback) : () => 0,
  );
  vi.stubGlobal('ResizeObserver', InertObserver);
  vi.stubGlobal('MutationObserver', InertObserver);
  vi.stubGlobal('getComputedStyle', (node: FakeNode) => ({
    paddingLeft: '0',
    paddingRight: '0',
    columnGap: '6',
    fontSize: '20',
    transformOrigin: '0',
    boxShadow: 'none',
    borderColor: '',
    ...options.computedStyle?.(node),
  }));
  const i18n = createI18n({ language, resources: BUNDLED_RESOURCES });
  const store = createStore(initialUiState(defaultSettings(language)));
  const disposers: (() => void)[] = [];
  const ctx: UiContext = {
    i18n,
    loc: new Localizer(i18n),
    store,
    bus: createBus<UiEvents>(),
    own: (dispose) => disposers.push(dispose),
  };
  const root = (options.create ?? createComboLadder)(ctx).root as unknown as FakeNode;
  const part = (selector: string): string => {
    const found = root.querySelector(selector);
    if (!found) throw new Error(`no ${selector} in the combo ladder`);
    return found.textContent;
  };
  return {
    i18n,
    root,
    setCount: (count: number) => {
      store.setState({ cascadeCount: count });
    },
    caption: () => part('.cp-combo-caption'),
    tier: () => part('.cp-combo-tier'),
    hint: () => part('.cp-combo-hint'),
    spoken: () => part('.cp-sr-only'),
    dispose: () => {
      for (const off of disposers.splice(0).reverse()) off();
    },
  };
}

type Ladder = ReturnType<typeof mountLadder>;

const MULTIPLIER = /[×x]\s*\d/;
const LANGUAGES: readonly Language[] = ['en', 'fr', 'de'];
const RANK_2 = cascade.tiers[1];
const RANK_4 = cascade.tiers[3];

const t = (ladder: Ladder, key: string, values?: InterpolationValues): string =>
  ladder.i18n.t(key, values);
const tierLabel = (ladder: Ladder, id: string): string => t(ladder, `combo.tier.${id}`);

describe('createComboLadder shows a spent cascade as history', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    setMotionPreference('system');
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  for (const language of LANGUAGES) {
    it(`[${language}] names the best rank and the idle prompt once a rank 2 cascade expires`, () => {
      setMotionPreference('full');
      const ladder = mountLadder(language);
      ladder.setCount(RANK_2.minCoins);
      expect(ladder.tier()).toBe(tierLabel(ladder, RANK_2.id));
      expect(ladder.caption()).toMatch(MULTIPLIER);
      expect(ladder.root.getAttribute('aria-label')).toBe(ladder.spoken());

      ladder.setCount(0);
      vi.advanceTimersByTime(10_000);

      const best = t(ladder, 'combo.best', { tier: tierLabel(ladder, RANK_2.id) });
      expect(best).not.toMatch(MULTIPLIER);
      expect(ladder.tier()).toBe(best);
      expect(ladder.caption()).toBe(best);
      expect(ladder.caption()).not.toMatch(MULTIPLIER);
      expect(ladder.hint()).toBe(t(ladder, 'combo.idle'));
      for (const next of cascade.tiers.slice(2)) {
        expect(ladder.hint()).not.toContain(tierLabel(ladder, next.id));
      }
      expect(ladder.root.classList.contains('is-spent')).toBe(true);
      expect(ladder.root.getAttribute('aria-label')).toBe(t(ladder, 'combo.ariaIdle'));
      expect(ladder.spoken()).toBe('');
      ladder.dispose();
    });
  }

  it('keeps the same spent caption under reduced motion', () => {
    setMotionPreference('reduced');
    const ladder = mountLadder('en');
    ladder.setCount(RANK_2.minCoins);
    ladder.setCount(0);
    vi.advanceTimersByTime(10_000);
    expect(ladder.caption()).toBe('Best: Lavish');
    expect(ladder.hint()).toBe('Push to cascade');
    expect(ladder.root.getAttribute('aria-label')).toBe('No cascade running');
    ladder.dispose();
  });

  it('records the highest rank of a cascade that drains through lower ones', () => {
    const ladder = mountLadder('en');
    ladder.setCount(RANK_4.minCoins);
    ladder.setCount(RANK_2.minCoins);
    expect(ladder.tier()).toBe('Lavish');
    ladder.setCount(0);
    expect(ladder.caption()).toBe('Best: Decadent');
    ladder.dispose();
  });

  it('keeps the best rank of the session when a later cascade peaks lower', () => {
    const ladder = mountLadder('en');
    ladder.setCount(RANK_2.minCoins);
    ladder.setCount(0);
    ladder.setCount(RANK_4.minCoins);
    ladder.setCount(0);
    expect(ladder.caption()).toBe('Best: Decadent');
    ladder.setCount(RANK_2.minCoins);
    expect(ladder.tier()).toBe('Lavish');
    ladder.setCount(0);
    expect(ladder.caption()).toBe('Best: Decadent');
    ladder.dispose();
  });

  it('counts a restarting cascade toward its first rank under the old record', () => {
    const first = cascade.tiers[0];
    const ladder = mountLadder('en');
    ladder.setCount(RANK_2.minCoins);
    ladder.setCount(0);
    ladder.setCount(1);
    expect(ladder.caption()).toBe('Best: Lavish');
    expect(ladder.caption()).not.toMatch(MULTIPLIER);
    expect(ladder.hint()).toBe(`${first.minCoins - 1} to Chic`);
    expect(ladder.root.getAttribute('aria-label')).toBe('No cascade running');
    ladder.dispose();
  });

  it('shows the idle dash before any cascade has run', () => {
    const ladder = mountLadder('en');
    expect(ladder.caption()).toBe('—');
    expect(ladder.hint()).toBe('Push to cascade');
    expect(ladder.root.classList.contains('is-spent')).toBe(false);
    ladder.dispose();
  });

  it('relabels the record when the language changes', () => {
    const ladder = mountLadder('en');
    ladder.setCount(RANK_2.minCoins);
    ladder.setCount(0);
    ladder.i18n.changeLanguage('de');
    expect(ladder.caption()).toBe('Rekord: Üppig');
    expect(ladder.hint()).toBe('Schieben für Kaskaden');
    ladder.dispose();
  });
});

/**
 * Natural widths in CSS px of the rank names (20px display face) and multipliers (15px), as
 * Chromium measures them at 390x844; the same table railLayout.test.ts lays its cards out with.
 */
const NAME_WIDTHS: Readonly<Record<string, number>> = {
  Chic: 40,
  Lavish: 57.81,
  Opulent: 70.03,
  Decadent: 79.98,
  OBSCENE: 95.59,
  Fastueux: 77.8,
  Décadent: 79.98,
  OBSCÈNE: 95.59,
  Üppig: 52.25,
  Dekadent: 82.23,
  OBSZÖN: 83.36,
};
const MULTIPLIER_WIDTHS: Readonly<Record<string, number>> = {
  '×1.1': 27.31,
  '×1,1': 27.31,
  '×1.25': 34.81,
  '×1,25': 34.81,
  '×1.5': 27.31,
  '×1,5': 27.31,
  '×2': 16.06,
  '×3': 16.06,
};
const IDLE_DASH = '—';
const NAME_FONT_PX = 20;
const NAME_HEIGHT = 22;
const GAP = 6;
/** The right card's padding: 12px on the field side, 6px by the gauge. */
const PAD_FIELD = 12;
const PAD_GAUGE = 6;
/** Card frame widths beside the flute: the 390 px card (176 - 22) and the 360 px one (168 - 22). */
const FRAMES = [154, 146];

const RANK_NAMES: Readonly<Record<Language, Readonly<Record<string, string>>>> = {
  en: enUi.combo.tier,
  fr: frUi.combo.tier,
  de: deUi.combo.tier,
};
const rankName = (language: Language, id: string): string => RANK_NAMES[language][id] ?? '';

const widthOf = (table: Readonly<Record<string, number>>, text: string): number => {
  const width = table[text];
  if (width === undefined) throw new Error(`Measure "${text}" in the browser and add its width`);
  return width;
};

/** A number the ladder set inline on `node`, or null while that property is unset. */
function styleNumber(node: FakeNode, property: string): number | null {
  const value = node.style[property];
  return typeof value === 'string' && value !== '' ? parseFloat(value) : null;
}

/** What the browser lays out for the right card: text widths, paddings and the name's origin. */
function cardLayout(node: FakeNode): number {
  if (node.classList.contains('cp-combo-tier')) {
    const font = styleNumber(node, 'fontSize') ?? NAME_FONT_PX;
    const natural = node.textContent === IDLE_DASH ? 20 : widthOf(NAME_WIDTHS, node.textContent);
    return (natural * font) / NAME_FONT_PX;
  }
  if (node.classList.contains('cp-combo-mult')) {
    return node.textContent ? widthOf(MULTIPLIER_WIDTHS, node.textContent) : 0;
  }
  return 40;
}

/** `.cp-combo-tier { transform-origin: right center }`, resolved as computed style reports it. */
function cardStyle(node: FakeNode): Record<string, string> {
  if (node.classList.contains('cp-rail-card')) {
    return { paddingLeft: `${PAD_FIELD}px`, paddingRight: `${PAD_GAUGE}px` };
  }
  if (node.classList.contains('cp-combo-tier')) {
    const font = styleNumber(node, 'fontSize') ?? NAME_FONT_PX;
    return { fontSize: `${font}px`, transformOrigin: `${node.offsetWidth}px ${NAME_HEIGHT / 2}px` };
  }
  return { columnGap: `${GAP}px` };
}

describe('createComboLadder fits each rank name for its rank-up swell', () => {
  afterEach(() => {
    FakeNode.measure = null;
    vi.unstubAllGlobals();
  });

  const longest = (language: Language): string => {
    const names = cascade.tiers.map((tier) => rankName(language, tier.id));
    return names.reduce((a, b) => (widthOf(NAME_WIDTHS, b) > widthOf(NAME_WIDTHS, a) ? b : a));
  };

  it('takes the longest name of each language from the measured set', () => {
    expect(LANGUAGES.map(longest)).toEqual(['OBSCENE', 'OBSCÈNE', 'OBSZÖN']);
  });

  for (const language of LANGUAGES) {
    for (const frameWidth of FRAMES) {
      it(`[${language}] keeps "${longest(language)}" inside a ${frameWidth} px card at peak swell`, async () => {
        // A fresh frame loop, so this test drives the swell spring frame by frame.
        vi.resetModules();
        const { createComboLadder: create } = await import('./comboLadder.ts');
        const { setMotionPreference: setMotion } = await import('../motion/reduced.ts');
        setMotion('full');
        FakeNode.measure = cardLayout;
        const frames: FrameRequestCallback[] = [];
        const ladder = mountLadder(language, { create, computedStyle: cardStyle, frames });
        for (const node of ladder.root.all()) node.clientWidth = frameWidth;

        const top = cascade.tiers.findIndex(
          (tier) => rankName(language, tier.id) === longest(language),
        );
        const tier = ladder.root.querySelector('.cp-combo-tier');
        const caption = ladder.root.querySelector('.cp-combo-caption');
        const mult = ladder.root.querySelector('.cp-combo-mult');
        if (!tier || !caption || !mult) throw new Error('The ladder has no caption to measure');
        let peak = 1;
        let now = 0;
        for (const rung of cascade.tiers.slice(0, top + 1)) {
          ladder.setCount(rung.minCoins);
          const label = `${tier.textContent} in a ${frameWidth} px card`;
          for (let frame = 0; frame < 600 && frames.length > 0; frame++) {
            now += 1000 / 60;
            frames.shift()?.(now);
            const scale = styleNumber(tier, 'scale') ?? 1;
            peak = Math.max(peak, scale);
            const stacked = caption.classList.contains('is-stacked');
            const width = tier.offsetWidth;
            const origin = parseFloat(cardStyle(tier).transformOrigin ?? '0');
            const right = frameWidth - PAD_GAUGE - (stacked ? 0 : mult.offsetWidth + GAP);
            const left = right - width;
            const at = `${label} at x${scale.toFixed(3)}`;
            const swollenLeft = left + origin * (1 - scale);
            const swollenRight = left + origin + (width - origin) * scale;
            expect(swollenLeft, `${at} keeps its field-side padding`).toBeGreaterThanOrEqual(
              PAD_FIELD - 1e-6,
            );
            expect(swollenRight, `${at} stays clear of the multiplier`).toBeLessThanOrEqual(
              right + 1e-6,
            );
          }
          expect(frames, `the ${rung.id} swell settles`).toEqual([]);
        }
        expect(tier.textContent).toBe(longest(language));
        expect(peak, 'the rank-up swell played').toBeGreaterThan(1.1);
        ladder.dispose();
        setMotion('system');
      });
    }
  }
});

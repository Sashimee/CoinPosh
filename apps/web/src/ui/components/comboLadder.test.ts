import { cascade } from '@coinposh/economy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBus } from '../../app/bus.ts';
import { defaultSettings } from '../../app/settings.ts';
import { initialUiState, type UiEvents } from '../../app/state.ts';
import { createStore } from '../../app/store.ts';
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
  offsetWidth = 40;
  #text = '';

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

function mountLadder(language: Language) {
  vi.stubGlobal('document', {
    createElement: (tag: string) => new FakeNode(tag),
    fonts: { addEventListener: () => undefined, removeEventListener: () => undefined },
  });
  vi.stubGlobal('HTMLElement', FakeNode);
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('ResizeObserver', InertObserver);
  vi.stubGlobal('MutationObserver', InertObserver);
  vi.stubGlobal('getComputedStyle', () => ({
    paddingLeft: '0',
    paddingRight: '0',
    columnGap: '6',
    fontSize: '20',
    transformOrigin: '0',
    boxShadow: 'none',
    borderColor: '',
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
  const root = createComboLadder(ctx).root as unknown as FakeNode;
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

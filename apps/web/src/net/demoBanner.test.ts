import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUNDLED_RESOURCES } from '../i18n/index.ts';
import { LANGUAGES, type ResourceTree } from '../i18n/core.ts';
import {
  DEMO_BANNER_COLLAPSE_MS,
  DEMO_BANNER_ID,
  DEMO_BANNER_KEYS,
  mountDemoBanner,
  type DemoBannerColors,
  type DemoBannerKey,
} from './demoBanner.ts';
import { NET_I18N_KEYS, NET_I18N_SOURCE } from './i18nKeys.ts';

type Listener = (event: { key?: string }) => void;

/** Just enough of the DOM for the banner; the web app's unit tests run in node without a DOM library. */
class FakeElement {
  id = '';
  textContent: string | null = null;
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Set<Listener>>();
  parent: FakeElement | null = null;

  constructor(readonly tagName: string) {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: { key?: string } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  listenerCount(): number {
    let count = 0;
    for (const set of this.listeners.values()) count += set.size;
    return count;
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }

  remove(): void {
    if (this.parent === null) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }

  find(id: string): FakeElement | null {
    if (this.id === id) return this;
    for (const child of this.children) {
      const found = child.find(id);
      if (found !== null) return found;
    }
    return null;
  }

  findTag(tagName: string): FakeElement | null {
    if (this.tagName === tagName) return this;
    for (const child of this.children) {
      const found = child.findTag(tagName);
      if (found !== null) return found;
    }
    return null;
  }
}

function fakeDocument() {
  const head = new FakeElement('head');
  const body = new FakeElement('body');
  const doc = {
    head,
    body,
    createElement: (tag: string) => new FakeElement(tag),
    getElementById: (id: string) => head.find(id) ?? body.find(id),
  };
  return { head, body, doc: doc as unknown as Document };
}

function stringAt(tree: ResourceTree, key: string): string | undefined {
  let node: ResourceTree | string | undefined = tree;
  for (const part of key.split('.')) {
    if (node === undefined || typeof node === 'string') return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

function catalog(language: (typeof LANGUAGES)[number]): ResourceTree {
  const tree = BUNDLED_RESOURCES[language].ui;
  if (!tree) throw new Error(`${language} ui bundle is missing`);
  return tree;
}

const translator =
  (language: (typeof LANGUAGES)[number]) =>
  (key: DemoBannerKey): string => {
    const net = (NET_I18N_SOURCE[language] as Readonly<Record<string, string>>)[key];
    const text = net ?? stringAt(catalog(language), key);
    if (text === undefined) throw new Error(`No ${language} string for ${key}`);
    return text;
  };

const english = translator('en');
const colors: DemoBannerColors = {
  border: '#c9a227',
  surface: '#0b1d3a',
  text: '#fffaf0',
  accent: '#f7e7ce',
};

function parts(body: FakeElement) {
  const banner = body.find(DEMO_BANNER_ID);
  if (banner === null) throw new Error('banner not mounted');
  const toggle = banner.findTag('button');
  const title = banner.findTag('strong');
  const detail = banner.findTag('span');
  const controls = toggle?.getAttribute('aria-controls');
  const region = controls ? banner.find(controls) : null;
  if (!toggle || !title || !detail || !region) throw new Error('banner is missing a part');
  return { banner, toggle, title, detail, region };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('mountDemoBanner', () => {
  it('opens as the full notice in a polite status region with an expanded toggle', () => {
    const { doc, body } = fakeDocument();
    mountDemoBanner(doc, english, colors);
    const { banner, toggle, title, detail, region } = parts(body);
    expect(banner.tagName).toBe('aside');
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.getAttribute('data-state')).toBe('expanded');
    expect(toggle.getAttribute('type')).toBe('button');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('Demo Mode: hide details');
    expect(title.textContent).toBe(NET_I18N_SOURCE.en[NET_I18N_KEYS.demoBanner]);
    expect(detail.textContent).toBe(NET_I18N_SOURCE.en[NET_I18N_KEYS.demoBannerDetail]);
    expect(region.getAttribute('aria-hidden')).toBeNull();
    expect(region.getAttribute('inert')).toBeNull();
  });

  it('folds into the "Demo" chip once the boot notice has had its moment', () => {
    const { doc, body } = fakeDocument();
    mountDemoBanner(doc, english, colors);
    vi.advanceTimersByTime(DEMO_BANNER_COLLAPSE_MS - 1);
    expect(parts(body).banner.getAttribute('data-state')).toBe('expanded');
    vi.advanceTimersByTime(1);
    const { banner, toggle, title, region } = parts(body);
    expect(DEMO_BANNER_COLLAPSE_MS).toBeLessThan(5000);
    expect(banner.getAttribute('data-state')).toBe('collapsed');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe('Demo Mode: show details');
    expect(title.textContent).toBe('Demo');
    expect(region.getAttribute('aria-hidden')).toBe('true');
    expect(region.getAttribute('inert')).toBe('');
  });

  it('expands and collapses again on tap, announcing each state through aria-expanded', () => {
    const { doc, body } = fakeDocument();
    mountDemoBanner(doc, english, colors);
    vi.advanceTimersByTime(DEMO_BANNER_COLLAPSE_MS);
    const { banner, toggle, region } = parts(body);
    toggle.dispatch('click');
    expect(banner.getAttribute('data-state')).toBe('expanded');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(region.getAttribute('inert')).toBeNull();
    vi.advanceTimersByTime(DEMO_BANNER_COLLAPSE_MS * 3);
    expect(banner.getAttribute('data-state')).toBe('expanded');
    toggle.dispatch('click');
    expect(banner.getAttribute('data-state')).toBe('collapsed');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('lets an early tap win over the boot timer', () => {
    const { doc, body } = fakeDocument();
    mountDemoBanner(doc, english, colors);
    const { banner, toggle } = parts(body);
    toggle.dispatch('click');
    expect(banner.getAttribute('data-state')).toBe('collapsed');
    toggle.dispatch('click');
    vi.advanceTimersByTime(DEMO_BANNER_COLLAPSE_MS);
    expect(banner.getAttribute('data-state')).toBe('expanded');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('collapses on Escape and ignores other keys', () => {
    const { doc, body } = fakeDocument();
    mountDemoBanner(doc, english, colors);
    const { banner, toggle } = parts(body);
    toggle.dispatch('keydown', { key: 'Enter' });
    expect(banner.getAttribute('data-state')).toBe('expanded');
    toggle.dispatch('keydown', { key: 'Escape' });
    expect(banner.getAttribute('data-state')).toBe('collapsed');
    toggle.dispatch('keydown', { key: 'Escape' });
    expect(banner.getAttribute('data-state')).toBe('collapsed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('renders whatever the translator returns, so FR and DE come from the catalogs', () => {
    const { doc, body } = fakeDocument();
    mountDemoBanner(doc, translator('de'), colors);
    expect(parts(body).title.textContent).toBe('Demo-Modus');
    expect(parts(body).toggle.getAttribute('aria-label')).toBe('Demo-Modus: Details ausblenden');
    vi.advanceTimersByTime(DEMO_BANNER_COLLAPSE_MS);
    expect(parts(body).toggle.getAttribute('aria-label')).toBe('Demo-Modus: Details anzeigen');

    const french = fakeDocument();
    mountDemoBanner(french.doc, translator('fr'), colors);
    vi.advanceTimersByTime(DEMO_BANNER_COLLAPSE_MS);
    expect(parts(french.body).title.textContent).toBe('Démo');
  });

  it('keeps the chip folded when a language change relabels it', () => {
    const { doc, body } = fakeDocument();
    mountDemoBanner(doc, english, colors);
    vi.advanceTimersByTime(DEMO_BANNER_COLLAPSE_MS);
    mountDemoBanner(doc, translator('fr'), colors);
    const { banner, title, toggle } = parts(body);
    expect(banner.getAttribute('data-state')).toBe('collapsed');
    expect(title.textContent).toBe('Démo');
    expect(toggle.getAttribute('aria-label')).toBe('Mode démo : afficher les détails');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drops the replaced banner timer and listeners instead of leaking them', () => {
    const { doc, body } = fakeDocument();
    mountDemoBanner(doc, english, colors);
    const first = parts(body).toggle;
    mountDemoBanner(doc, english, colors);
    expect(first.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(DEMO_BANNER_COLLAPSE_MS);
    expect(parts(body).banner.getAttribute('data-state')).toBe('collapsed');
  });

  it('styles itself from the colours the shell passes, so each venue tints it', () => {
    const { doc, head } = fakeDocument();
    mountDemoBanner(doc, english, colors);
    const style = head.children[0]?.textContent ?? '';
    for (const colour of Object.values(colors)) expect(style).toContain(colour);
    mountDemoBanner(doc, english, { ...colors, accent: '#123456' });
    expect(head.children[0]?.textContent).toContain('#123456');
    expect(head.children[0]?.textContent).not.toContain(colors.accent);
  });

  it('ships the chip, sheet and reduced-motion rules in its stylesheet', () => {
    const { doc, head } = fakeDocument();
    mountDemoBanner(doc, english, colors);
    const style = head.children[0]?.textContent ?? '';
    expect(style).toContain('safe-area-inset-top');
    expect(style).toMatch(/> button \{[^}]*height: 28px;/);
    expect(style).toMatch(/> button::before \{[^}]*inset: -8px -4px;/);
    expect(style).toMatch(/\[data-state='collapsed'\] \{[^}]*padding: 0;/);
    expect(style).toMatch(
      /body:has\(\[aria-modal='true'\]:not\(\[hidden\], \[hidden\] \*\)\) #coinposh-demo-banner \{[^}]*visibility: hidden;/,
    );
    expect(style).toMatch(
      /\[data-motion='reduced'\] #coinposh-demo-banner \* \{\s*transition: none/,
    );
    expect(style).toMatch(/prefers-reduced-motion: reduce\) \{[\s\S]*transition: none !important/);
  });

  it('replaces an earlier banner and unmounts cleanly', () => {
    const { doc, head, body } = fakeDocument();
    mountDemoBanner(doc, english, colors);
    const unmount = mountDemoBanner(doc, english, colors);
    expect(body.children).toHaveLength(1);
    expect(head.children).toHaveLength(1);
    const { toggle } = parts(body);
    unmount();
    expect(body.children).toHaveLength(0);
    expect(head.children).toHaveLength(0);
    expect(toggle.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Demo banner catalog strings', () => {
  const keys = Object.values(DEMO_BANNER_KEYS);

  it.each(LANGUAGES)('%s has the chip and both toggle labels', (language) => {
    for (const key of keys) expect(stringAt(catalog(language), key)?.trim(), key).toBeTruthy();
  });

  it('translates the toggle labels in FR and DE instead of copying EN', () => {
    for (const key of [DEMO_BANNER_KEYS.expand, DEMO_BANNER_KEYS.collapse]) {
      expect(stringAt(catalog('fr'), key)).not.toBe(stringAt(catalog('en'), key));
      expect(stringAt(catalog('de'), key)).not.toBe(stringAt(catalog('en'), key));
    }
  });

  it.each(LANGUAGES)('%s toggle labels contain the visible chip and title text', (language) => {
    const t = translator(language);
    const chip = t(DEMO_BANNER_KEYS.chip).toLowerCase();
    const titled = t(NET_I18N_KEYS.demoBanner).toLowerCase();
    expect(t(DEMO_BANNER_KEYS.expand).toLowerCase()).toContain(chip);
    expect(t(DEMO_BANNER_KEYS.collapse).toLowerCase()).toContain(titled);
  });
});

describe('NET_I18N_SOURCE', () => {
  it('has every key, non-empty, in EN, FR and DE', () => {
    const keys = Object.values(NET_I18N_KEYS).sort();
    for (const locale of ['en', 'fr', 'de'] as const) {
      const catalog = NET_I18N_SOURCE[locale];
      expect(Object.keys(catalog).sort()).toEqual(keys);
      for (const key of keys) expect(catalog[key].trim()).not.toBe('');
    }
  });

  it('actually translates FR and DE instead of copying EN', () => {
    for (const key of Object.values(NET_I18N_KEYS)) {
      expect(NET_I18N_SOURCE.fr[key]).not.toBe(NET_I18N_SOURCE.en[key]);
      expect(NET_I18N_SOURCE.de[key]).not.toBe(NET_I18N_SOURCE.en[key]);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { DEMO_BANNER_ID, mountDemoBanner } from './demoBanner.ts';
import { NET_I18N_KEYS, NET_I18N_SOURCE, type NetI18nKey } from './i18nKeys.ts';

/** Just enough of the DOM for the banner; the web app's unit tests run in node without a DOM library. */
class FakeElement {
  id = '';
  textContent: string | null = null;
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  parent: FakeElement | null = null;

  constructor(readonly tagName: string) {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
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

const english = (key: NetI18nKey) => NET_I18N_SOURCE.en[key];

describe('mountDemoBanner', () => {
  it('announces Demo Mode through the i18n keys as a polite status region', () => {
    const { doc, head, body } = fakeDocument();
    mountDemoBanner(doc, english);
    const banner = body.find(DEMO_BANNER_ID);
    expect(banner?.tagName).toBe('aside');
    expect(banner?.attributes.get('role')).toBe('status');
    expect(banner?.children.map((child) => child.textContent)).toEqual([
      NET_I18N_SOURCE.en[NET_I18N_KEYS.demoBanner],
      NET_I18N_SOURCE.en[NET_I18N_KEYS.demoBannerDetail],
    ]);
    const style = head.children[0]?.textContent ?? '';
    expect(style).toContain('prefers-reduced-motion: reduce');
    expect(style).toContain('safe-area-inset-top');
  });

  it('renders whatever the translator returns, so FR and DE come from the catalog', () => {
    const { doc, body } = fakeDocument();
    mountDemoBanner(doc, (key) => NET_I18N_SOURCE.de[key]);
    expect(body.find(DEMO_BANNER_ID)?.children[0]?.textContent).toBe('Demo-Modus');
  });

  it('replaces an earlier banner and unmounts cleanly', () => {
    const { doc, head, body } = fakeDocument();
    mountDemoBanner(doc, english);
    const unmount = mountDemoBanner(doc, english);
    expect(body.children).toHaveLength(1);
    expect(head.children).toHaveLength(1);
    unmount();
    expect(body.children).toHaveLength(0);
    expect(head.children).toHaveLength(0);
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

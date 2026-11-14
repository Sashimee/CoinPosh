import { upgradeStat, venues } from '@coinposh/economy';
import type { VenueId } from '@coinposh/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBus } from '../../app/bus.ts';
import { defaultSettings } from '../../app/settings.ts';
import { initialUiState, type UiEvents, type UiState } from '../../app/state.ts';
import { createStore } from '../../app/store.ts';
import {
  BUNDLED_RESOURCES,
  createI18n,
  formatDecimal,
  formatInteger,
  LANGUAGES,
  type InterpolationValues,
  type Language,
} from '../../i18n/index.ts';
import { createAscensionController, type AscensionApi } from './controller.ts';
import type { AscensionEvents } from './events.ts';
import {
  ascensionKey,
  lineDescriptionKey,
  lineNameKey,
  registerAscensionStrings,
  venueKey,
} from './i18n.ts';
import { FAMILY_OFFICE_LINES, familyOfficeRows } from './plan.ts';
import { familyOfficeRowCopy, showAscension, type AscensionScreen } from './screen.ts';

interface FakeEvent {
  readonly type: string;
  readonly key?: string;
  readonly button: number;
  readonly pointerId: number;
  readonly repeat: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
}

type Handler = (event: FakeEvent) => void;

class Listeners {
  private readonly byType = new Map<string, Set<Handler>>();

  addEventListener(type: string, handler: Handler): void {
    const set = this.byType.get(type) ?? new Set();
    set.add(handler);
    this.byType.set(type, set);
  }
  removeEventListener(type: string, handler: Handler): void {
    this.byType.get(type)?.delete(handler);
  }
  fire(event: FakeEvent): void {
    for (const handler of [...(this.byType.get(event.type) ?? [])]) handler(event);
  }
}

/** Just enough DOM for the ascension screen: the suite runs in node. */
class FakeElement extends Listeners {
  parentNode: FakeElement | null = null;
  readonly children: FakeElement[] = [];
  readonly attrs = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly classList = new FakeClassList();
  readonly style: Record<string, string> & { setProperty(name: string, value: string): void };
  hidden = false;
  tabIndex = 0;
  private text = '';

  constructor(readonly tagName: string) {
    super();
    const properties: Record<string, string> = {};
    this.style = Object.assign(properties, {
      setProperty: (name: string, value: string) => {
        properties[name] = value;
      },
    });
  }

  set className(value: string) {
    this.classList.set(value);
  }
  get className(): string {
    return this.classList.toString();
  }
  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join('');
  }
  set textContent(value: string) {
    for (const child of this.children.splice(0)) child.parentNode = null;
    this.text = value;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  toggleAttribute(name: string, force: boolean): void {
    if (force) this.attrs.set(name, '');
    else this.attrs.delete(name);
  }
  append(...nodes: (FakeElement | string)[]): void {
    for (const node of nodes) {
      if (typeof node === 'string') {
        this.text += node;
        continue;
      }
      node.remove();
      node.parentNode = this;
      this.children.push(node);
    }
  }
  remove(): void {
    const parent = this.parentNode;
    if (parent === null) return;
    parent.children.splice(parent.children.indexOf(this), 1);
    this.parentNode = null;
    if (this.contains(doc.activeElement)) doc.activeElement = doc.body;
  }
  contains(node: unknown): boolean {
    return node === this || this.children.some((child) => child.contains(node));
  }
  all(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.all()]);
  }
  find(testId: string): FakeElement {
    const found = this.all().find((el) => el.getAttribute('data-testid') === testId);
    if (found === undefined)
      throw new Error(`no [data-testid="${testId}"] under <${this.tagName}>`);
    return found;
  }
  focus(): void {
    doc.activeElement = this;
  }
  setPointerCapture(): void {
    return undefined;
  }
  getBoundingClientRect(): DOMRect {
    return { left: 0, top: 0, width: 100, height: 40 } as DOMRect;
  }
  set innerHTML(_markup: string) {
    this.textContent = '';
    this.append(new FakeElement('svg'));
  }
  get content(): { firstElementChild: FakeElement | null } {
    return { firstElementChild: this.children[0] ?? null };
  }
  /** Fires at this element, then bubbles through its ancestors to the document. */
  dispatch(type: string, init: { key?: string } = {}): FakeEvent {
    const event: FakeEvent = {
      type,
      ...init,
      button: 0,
      pointerId: 1,
      repeat: false,
      defaultPrevented: false,
      preventDefault() {
        event.defaultPrevented = true;
      },
    };
    this.fire(event);
    for (let node = this.parentNode; node !== null; node = node.parentNode) node.fire(event);
    doc.fire(event);
    return event;
  }
}

class FakeClassList {
  private names = new Set<string>();

  set(value: string): void {
    this.names = new Set(value.split(/\s+/).filter(Boolean));
  }
  add(name: string): void {
    this.names.add(name);
  }
  remove(name: string): void {
    this.names.delete(name);
  }
  toggle(name: string, force?: boolean): void {
    if (force ?? !this.names.has(name)) this.names.add(name);
    else this.names.delete(name);
  }
  contains(name: string): boolean {
    return this.names.has(name);
  }
  toString(): string {
    return [...this.names].join(' ');
  }
}

class FakeDocument extends Listeners {
  body = new FakeElement('body');
  activeElement: FakeElement | null = this.body;

  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }
  createElementNS(_namespace: string, tag: string): FakeElement {
    return new FakeElement(tag);
  }
  getElementById(id: string): FakeElement | null {
    return this.body.all().find((el) => el.getAttribute('id') === id) ?? null;
  }
}

/** One document for the whole file: the shared sheet focus binds to the first it sees. */
const doc = new FakeDocument();
const RIVIERA = venues[0];
const RIVIERA_ID = RIVIERA.id as VenueId;

const idleApi: AscensionApi = {
  ascend: () => new Promise(() => undefined),
  buyFamilyOffice: () => new Promise(() => undefined),
};

function setup(language: Language = 'en', state: Partial<UiState> = {}) {
  const i18n = createI18n({ language, resources: BUNDLED_RESOURCES });
  const store = createStore<UiState>({ ...initialUiState(defaultSettings(language)), ...state });
  const bus = createBus<UiEvents>();
  const trigger = doc.createElement('button');
  trigger.setAttribute('data-testid', 'hud-ascension');
  doc.body.append(trigger);
  trigger.focus();
  let screen: AscensionScreen | null = null;
  const closes: number[] = [];
  const open = (bullion: number | null) => {
    screen = showAscension({
      ui: { store, bus, i18n, setWallet: () => undefined },
      host: doc.body as unknown as HTMLElement,
      venueId: RIVIERA_ID,
      bullion,
      controller: createAscensionController({ api: idleApi, events: createBus<AscensionEvents>() }),
      audio: () => null,
      onConfirmed: () => undefined,
      onClose: () => {
        closes.push(1);
        screen?.dispose();
      },
      reducedMotion: true,
    });
    return screen;
  };
  return { i18n, store, trigger, open, closes };
}

beforeEach(() => {
  doc.body = new FakeElement('body');
  doc.activeElement = doc.body;
  vi.stubGlobal('document', doc);
  vi.stubGlobal('HTMLElement', FakeElement);
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ascension screen focus', () => {
  it('takes focus on open and hands it back to the HUD entry on Escape', () => {
    const { trigger, open, closes } = setup();
    const screen = open(0);
    expect(doc.activeElement).toBe(screen.el);
    const escape = (screen.el as unknown as FakeElement).dispatch('keydown', { key: 'Escape' });
    expect(escape.defaultPrevented).toBe(true);
    expect(closes).toHaveLength(1);
    expect(doc.body.contains(screen.el)).toBe(false);
    expect(doc.activeElement).toBe(trigger);
  });

  it('hands focus back when closed with the × button', () => {
    const { trigger, open, closes } = setup();
    const screen = open(0);
    const root = screen.el as unknown as FakeElement;
    root.find('ascension-close').focus();
    root.find('ascension-close').dispatch('click');
    expect(closes).toHaveLength(1);
    expect(doc.activeElement).toBe(trigger);
  });

  it('owns Escape even when focus has wandered out of the dialog, then lets it go once closed', () => {
    const { trigger, open, closes } = setup();
    open(0);
    doc.activeElement = doc.body;
    doc.body.dispatch('keydown', { key: 'Escape' });
    expect(closes).toHaveLength(1);
    expect(doc.activeElement).toBe(trigger);
    doc.body.dispatch('keydown', { key: 'Escape' });
    expect(closes).toHaveLength(1);
  });
});

describe('locked hold control', () => {
  it('is described by the visible reason while blocked, and not once the venue is ready', () => {
    const { i18n, open } = setup();
    const screen = open(RIVIERA.bullionThreshold - 1);
    const root = screen.el as unknown as FakeElement;
    const hold = root.find('ascension-hold');
    expect(hold.dataset.state).toBe('blocked');
    expect(hold.getAttribute('aria-disabled')).toBe('true');
    const reasonId = hold.getAttribute('aria-describedby');
    expect(reasonId).toBeTruthy();
    const reason = doc.getElementById(reasonId ?? '');
    expect(reason?.hidden).toBe(false);
    expect(reason?.textContent).toBe(
      i18n.t(ascensionKey('notReadyHint'), {
        venue: i18n.t(venueKey(RIVIERA_ID)),
        target: formatInteger(RIVIERA.bullionThreshold, 'en'),
      }),
    );
    expect(reason?.textContent).toBe(
      `Riviera Yacht needs ${formatInteger(RIVIERA.bullionThreshold, 'en')} Bullion.`,
    );
    expect(hold.style['--cp-ascension-hold-preview']).toBe(
      ((RIVIERA.bullionThreshold - 1) / RIVIERA.bullionThreshold).toFixed(4),
    );

    screen.setBullion(RIVIERA.bullionThreshold);
    expect(hold.dataset.state).toBe('idle');
    expect(hold.hasAttribute('aria-describedby')).toBe(false);
    screen.dispose();
  });

  it('gives the locked hold a lock icon and keeps its label', () => {
    const { i18n, open } = setup('de');
    const screen = open(0);
    const hold = (screen.el as unknown as FakeElement).find('ascension-hold');
    const lock = hold.all().find((el) => el.classList.contains('cp-ascension-hold-lock'));
    expect(lock?.children.map((child) => child.tagName)).toEqual(['svg']);
    expect(hold.textContent).toBe(i18n.t(ascensionKey('hold')));
    screen.dispose();
  });
});

describe('Family Office rows', () => {
  it('renders each line with its description and a current → next effect from economy config', () => {
    const { i18n, open } = setup('en', { goldBars: 0 });
    const screen = open(0);
    const root = screen.el as unknown as FakeElement;
    for (const line of FAMILY_OFFICE_LINES) {
      const buy = root.find(`family-office-buy-${line.id}`);
      const row = buy.parentNode;
      expect(row?.textContent).toContain(i18n.t(lineNameKey(line.id)));
      expect(row?.textContent).toContain(i18n.t(lineDescriptionKey(line.id)));
      expect(root.find(`family-office-effect-${line.id}`).textContent).toMatch(/ → /);
      expect(buy.getAttribute('aria-label')).toContain(i18n.t(ascensionKey('goldBars')));
    }
    const oldMoney = FAMILY_OFFICE_LINES.find((line) => line.id === 'oldMoney');
    if (oldMoney === undefined) throw new Error('economy config lost the oldMoney line');
    const effect = (level: number) => `×${formatDecimal(upgradeStat(oldMoney, level), 'en')}`;
    expect(root.find('family-office-effect-oldMoney').textContent).toBe(
      `${effect(0)} → ${effect(1)}`,
    );
    screen.dispose();
  });

  it('shows a maxed row with its final effect, no price and no Gold Bar icon', () => {
    const oldMoney = FAMILY_OFFICE_LINES.find((line) => line.id === 'oldMoney');
    if (oldMoney === undefined) throw new Error('economy config lost the oldMoney line');
    const { i18n, open } = setup('en', {
      goldBars: 1e9,
      upgradeLevels: { oldMoney: oldMoney.maxLevel },
    });
    const screen = open(0);
    const root = screen.el as unknown as FakeElement;
    const buy = root.find('family-office-buy-oldMoney');
    const final = `×${formatDecimal(upgradeStat(oldMoney, oldMoney.maxLevel), 'en')}`;
    expect(root.find('family-office-effect-oldMoney').textContent).toBe(final);
    expect(buy.textContent).toBe(i18n.t(ascensionKey('maxed')));
    expect(buy.getAttribute('aria-disabled')).toBe('true');
    expect(buy.children[0]?.hasAttribute('hidden')).toBe(true);
    expect(buy.getAttribute('aria-label')).toBe('Old Money is at its highest level');
    expect(buy.parentNode?.dataset.maxed).toBe('true');
    screen.dispose();
  });
});

describe('familyOfficeRowCopy', () => {
  it('localizes every line in EN, FR and DE with no missing keys', () => {
    for (const language of LANGUAGES) {
      const i18n = createI18n({ language, resources: BUNDLED_RESOURCES });
      registerAscensionStrings(i18n);
      const t = (key: string, values?: InterpolationValues) => i18n.t(key, values);
      for (const row of familyOfficeRows({}, 1_000)) {
        const copy = familyOfficeRowCopy(t, row, language);
        for (const text of [copy.name, copy.description, copy.level, copy.buyLabel]) {
          expect(text).not.toMatch(/^upgrades\.|^gameAscension:|\{\{/);
        }
        expect(copy.effect).toContain('→');
        expect(copy.price).toBe(formatInteger(row.cost ?? -1, language));
        expect(copy.buyLabel.toLowerCase()).toContain(
          i18n.t(ascensionKey('goldBars')).toLowerCase(),
        );
      }
    }
  });

  it('drops the next effect and the price once a line is maxed', () => {
    const i18n = createI18n({ language: 'fr', resources: BUNDLED_RESOURCES });
    registerAscensionStrings(i18n);
    const levels = Object.fromEntries(FAMILY_OFFICE_LINES.map((line) => [line.id, line.maxLevel]));
    for (const row of familyOfficeRows(levels, 1e12)) {
      const copy = familyOfficeRowCopy((key, values) => i18n.t(key, values), row, 'fr');
      expect(copy.effect).not.toContain('→');
      expect(copy.price).toBeNull();
      expect(copy.level).toBe(`Niv. ${formatInteger(row.level, 'fr')}`);
      expect(copy.buyLabel).toBe(`${i18n.t(lineNameKey(row.lineId))} est à son niveau maximal`);
    }
  });

  it('refuses a line the economy config does not have', () => {
    const i18n = createI18n({ language: 'en', resources: BUNDLED_RESOURCES });
    const [row] = familyOfficeRows({}, 0);
    if (row === undefined) throw new Error('economy config has no Family Office line');
    expect(() =>
      familyOfficeRowCopy((key) => i18n.t(key), { ...row, lineId: 'yachtClub' }, 'en'),
    ).toThrow(/yachtClub/);
  });
});

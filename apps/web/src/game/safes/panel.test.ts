import { SafeIdSchema, SafeSchema, type Safe } from '@coinposh/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBus } from '../../app/bus.ts';
import { defaultSettings } from '../../app/settings.ts';
import { initialUiState, type UiEvents, type UiState } from '../../app/state.ts';
import { createStore } from '../../app/store.ts';
import { BUNDLED_RESOURCES, createI18n } from '../../i18n/index.ts';
import { showSafesPanel, type SafesPanel } from './panel.ts';

type Handler = (event: { readonly type: string }) => void;

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
}

/**
 * Just enough DOM for the safes sheet: the suite runs in node. Like a browser, it drops focus to
 * the body when the focused element (or an ancestor) is detached, moved or hidden.
 */
class FakeElement extends Listeners {
  parentNode: FakeElement | null = null;
  readonly children: FakeElement[] = [];
  readonly attrs = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly classList = new FakeClassList();
  readonly style: Record<string, string> & { setProperty(name: string, value: string): void };
  tabIndex = 0;
  private text = '';
  private isHidden = false;

  constructor(readonly tagName: string) {
    super();
    const properties: Record<string, string> = {};
    this.style = Object.assign(properties, {
      setProperty: (name: string, value: string) => {
        properties[name] = value;
      },
    });
  }

  get hidden(): boolean {
    return this.isHidden;
  }
  set hidden(value: boolean) {
    this.isHidden = value;
    if (value && this.contains(doc.activeElement)) doc.activeElement = doc.body;
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
  get isConnected(): boolean {
    return this === doc.body || (this.parentNode?.isConnected ?? false);
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
  append(...nodes: (FakeElement | string)[]): void {
    for (const node of nodes) {
      if (typeof node === 'string') this.text += node;
      else this.insertBefore(node, null);
    }
  }
  replaceChildren(...nodes: FakeElement[]): void {
    for (const child of [...this.children]) child.remove();
    this.append(...nodes);
  }
  insertBefore(node: FakeElement, before: FakeElement | null): void {
    node.remove();
    node.parentNode = this;
    const at = before === null ? -1 : this.children.indexOf(before);
    if (at < 0) this.children.push(node);
    else this.children.splice(at, 0, node);
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
  findAll(testId: string): FakeElement[] {
    return this.all().filter((el) => el.getAttribute('data-testid') === testId);
  }
  focus(): void {
    doc.activeElement = this;
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
}

/** One document for the whole file: the shared sheet focus binds to the first it sees. */
const doc = new FakeDocument();
const NOW = 1_800_000_000_000;

function safe(id: string, unlocksAt: number): Safe {
  return SafeSchema.parse({
    id: SafeIdSchema.parse(`safe_${id.padEnd(16, 'A')}`),
    type: 'gold',
    unlocksAt,
  });
}

function setup(initial: readonly Safe[], keys = 10) {
  const i18n = createI18n({ language: 'en', resources: BUNDLED_RESOURCES });
  const store = createStore<UiState>(initialUiState(defaultSettings('en')));
  const bus = createBus<UiEvents>();
  let owned = initial;
  const panel = showSafesPanel({
    ui: { store, bus, i18n },
    host: doc.body as unknown as HTMLElement,
    serverNow: () => Date.now(),
    safes: () => owned,
    keys: () => keys,
    keysProvisional: () => false,
    pending: () => null,
    busy: () => false,
    onOpen: () => undefined,
    onClose: () => undefined,
    reducedMotion: true,
  });
  const root = panel.el as unknown as FakeElement;
  const row = (index: number): FakeElement => {
    const found = root.findAll('safe-row')[index];
    if (found === undefined) throw new Error(`no safe row at ${String(index)}`);
    return found;
  };
  const button = (index: number, testId: string): FakeElement => {
    const found = row(index).findAll(testId)[0];
    if (found === undefined) throw new Error(`no ${testId} in safe row ${String(index)}`);
    return found;
  };
  const setSafes = (next: readonly Safe[]) => {
    owned = next;
    panel.render();
  };
  return { panel, root, row, button, setSafes };
}

let open: SafesPanel | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  doc.body = new FakeElement('body');
  doc.activeElement = doc.body;
  vi.stubGlobal('document', doc);
  vi.stubGlobal('HTMLElement', FakeElement);
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
  open?.dispose();
  open = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('safes panel focus across countdown ticks', () => {
  it('keeps the same focused row button across many 1 s ticks', () => {
    const s = setup([safe('one', NOW + 30_000), safe('two', NOW + 60_000)]);
    open = s.panel;
    const key = s.button(1, 'safe-open-key');
    const timer = s.row(1).findAll('safe-timer')[0];
    const rowEl = s.row(1);
    key.focus();
    expect(timer?.textContent).toBe('Opens free in 1:00');
    vi.advanceTimersByTime(10);

    for (let second = 1; second <= 5; second++) {
      vi.advanceTimersByTime(1_000);
      expect(doc.activeElement).toBe(key);
    }
    expect(timer?.textContent).toBe('Opens free in 0:55');
    expect(s.row(1)).toBe(rowEl);
    expect(s.button(1, 'safe-open-key')).toBe(key);
  });

  it('keeps focus when a render runs between ticks, e.g. a wallet update', () => {
    const s = setup([safe('one', NOW + 30_000)]);
    open = s.panel;
    const key = s.button(0, 'safe-open-key');
    key.focus();
    s.panel.render();
    s.panel.render();
    expect(doc.activeElement).toBe(key);
  });

  it('hands focus from the Key button to the free Open as the timer runs out', () => {
    const s = setup([safe('one', NOW + 2_000)]);
    open = s.panel;
    const key = s.button(0, 'safe-open-key');
    const timerButton = s.button(0, 'safe-open-timer');
    key.focus();
    vi.advanceTimersByTime(2_100);
    expect(key.hidden).toBe(true);
    expect(timerButton.hidden).toBe(false);
    expect(doc.activeElement).toBe(timerButton);
  });

  it('keeps focus on a row when a safe is added before it', () => {
    const second = safe('two', NOW + 60_000);
    const s = setup([second]);
    open = s.panel;
    const key = s.button(0, 'safe-open-key');
    key.focus();
    s.setSafes([safe('one', NOW + 30_000), second]);
    expect(s.root.findAll('safe-row')).toHaveLength(2);
    expect(s.button(1, 'safe-open-key')).toBe(key);
    expect(doc.activeElement).toBe(key);
  });

  it('keeps focus on a row that moves when the safes are reordered', () => {
    const first = safe('one', NOW + 30_000);
    const second = safe('two', NOW + 60_000);
    const s = setup([first, second]);
    open = s.panel;
    const key = s.button(1, 'safe-open-key');
    key.focus();
    s.setSafes([second, first]);
    expect(s.button(0, 'safe-open-key')).toBe(key);
    expect(doc.activeElement).toBe(key);
  });
});

describe('safes panel focus when a row leaves', () => {
  it('moves focus to the next row when the focused row is removed', () => {
    const first = safe('one', NOW + 30_000);
    const second = safe('two', NOW + 60_000);
    const third = safe('three', NOW + 90_000);
    const s = setup([first, second, third]);
    open = s.panel;
    s.button(1, 'safe-open-key').focus();
    const next = s.button(2, 'safe-open-key');
    s.setSafes([first, third]);
    expect(s.root.findAll('safe-row')).toHaveLength(2);
    expect(doc.activeElement).toBe(next);
    vi.advanceTimersByTime(3_000);
    expect(doc.activeElement).toBe(next);
  });

  it('falls back to the previous row when the last row is removed', () => {
    const first = safe('one', NOW + 30_000);
    const s = setup([first, safe('two', NOW + 60_000)]);
    open = s.panel;
    s.button(1, 'safe-open-key').focus();
    s.setSafes([first]);
    expect(doc.activeElement).toBe(s.button(0, 'safe-open-key'));
  });

  it('lands on a ready neighbour’s free Open, the control it actually shows', () => {
    const ready = safe('ready', NOW - 1_000);
    const s = setup([ready, safe('two', NOW + 60_000)]);
    open = s.panel;
    s.button(1, 'safe-open-key').focus();
    s.setSafes([ready]);
    expect(doc.activeElement).toBe(s.button(0, 'safe-open-timer'));
  });

  it('moves focus to the sheet heading, never the body, when the last safe goes', () => {
    const s = setup([safe('one', NOW + 30_000)]);
    open = s.panel;
    s.button(0, 'safe-open-key').focus();
    s.setSafes([]);
    const heading = s.root.all().find((el) => el.tagName === 'h2');
    expect(heading?.getAttribute('tabindex')).toBe('-1');
    expect(doc.activeElement).toBe(heading);
    expect(doc.activeElement).not.toBe(doc.body);
    expect(s.root.findAll('safes-empty')[0]?.hidden).toBe(false);
  });

  it('leaves focus alone when an unfocused row is removed', () => {
    const first = safe('one', NOW + 30_000);
    const s = setup([first, safe('two', NOW + 60_000)]);
    open = s.panel;
    const key = s.button(0, 'safe-open-key');
    key.focus();
    s.setSafes([first]);
    expect(doc.activeElement).toBe(key);
  });
});

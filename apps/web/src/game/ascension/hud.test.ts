import { venues } from '@coinposh/economy';
import type { AscendResponse, StateResponse } from '@coinposh/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBus } from '../../app/bus.ts';
import { defaultSettings } from '../../app/settings.ts';
import { initialUiState, type FeedbackKind, type UiEvents, type UiState } from '../../app/state.ts';
import { createStore } from '../../app/store.ts';
import type { ImpactEvent } from '../../audio/index.ts';
import { BUNDLED_RESOURCES, createI18n, type Language } from '../../i18n/index.ts';
import { netAscensionApi } from './api.ts';
import { ENTRY_MOTES, ENTRY_SHIMMER, entryReadiness, mountAscensionEntry } from './entry.ts';
import { mountAscensionHud, RELOAD_RETRY_MS, type MountAscensionHudOptions } from './hud.ts';
import { ascensionKey, venueKey } from './i18n.ts';
import type { AscensionMount, MountAscensionOptions } from './index.ts';
import { ascensionProgress, lifetimeBullionOf } from './plan.ts';
import {
  connectPlayer,
  createMockServer,
  FakeTime,
  requirePlayerId,
  type Player,
} from '../../net/test/harness.ts';
import type { MockServer } from '../../net/mock/server.ts';

type Listener = (event: { button: number }) => void;

/** Just enough DOM for the entry button: the suite runs in node. */
class FakeNode {
  parent: FakeNode | null = null;
  readonly children: FakeNode[] = [];
  readonly attrs = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, Set<Listener>>();
  readonly properties = new Map<string, string>();
  readonly style = {
    scale: '',
    translate: '',
    setProperty: (name: string, value: string): void => {
      this.properties.set(name, value);
    },
  };

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
  };

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  append(...nodes: FakeNode[]): void {
    for (const node of nodes) {
      node.remove();
      node.parent = this;
      this.children.push(node);
    }
  }
  remove(): void {
    const siblings = this.parent?.children;
    siblings?.splice(siblings.indexOf(this), 1);
    this.parent = null;
  }
  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }
  dispatch(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ button: 0 });
  }
  all(): FakeNode[] {
    return this.children.flatMap((child) => [child, ...child.all()]);
  }
  getBoundingClientRect(): DOMRect {
    return { left: 0, top: 0, width: 56, height: 56 } as DOMRect;
  }
  set innerHTML(_markup: string) {
    this.children.splice(0);
    this.append(new FakeNode('svg'));
  }
  get content(): { firstElementChild: FakeNode | null } {
    return { firstElementChild: this.children[0] ?? null };
  }
}

const RIVIERA = venues[0];
const PARIS = venues[1];

function ui(language: Language = 'en') {
  vi.stubGlobal('document', { createElement: (tag: string) => new FakeNode(tag) });
  vi.stubGlobal('HTMLElement', FakeNode);
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  const i18n = createI18n({ language, resources: BUNDLED_RESOURCES });
  const store = createStore<UiState>(initialUiState(defaultSettings(language)));
  const bus = createBus<UiEvents>();
  const feedback: FeedbackKind[] = [];
  bus.on('ui:feedback', ({ kind }) => feedback.push(kind));
  const sounds: ImpactEvent[] = [];
  const audio = { playImpact: (event: ImpactEvent) => sounds.push(event) };
  const dock = new FakeNode('nav');
  return {
    i18n,
    store,
    bus,
    feedback,
    sounds,
    audio: () => audio,
    dock,
    app: { store, bus, i18n, setWallet: () => undefined },
  };
}

function entryOf(dock: FakeNode): FakeNode {
  const found = dock.children.find(
    (child) => child.getAttribute('data-testid') === 'hud-ascension',
  );
  if (!found) throw new Error('the ascension entry is not in the dock');
  return found;
}

describe('the ascension progress source', () => {
  it('is the venue lifetime Bullion the server reports, and unknown only when it is absent', () => {
    expect(lifetimeBullionOf({ lifetimeBullion: 1_234 })).toBe(1_234);
    expect(lifetimeBullionOf({ lifetimeBullion: 0 })).toBe(0);
    expect(lifetimeBullionOf({})).toBeNull();
  });

  it('reads as building, ready or unknown on the entry', () => {
    const half = ascensionProgress(RIVIERA.id, RIVIERA.bullionThreshold / 2);
    expect(half.fraction).toBe(0.5);
    expect(entryReadiness(half)).toBe('building');
    expect(entryReadiness(ascensionProgress(RIVIERA.id, RIVIERA.bullionThreshold))).toBe('ready');
    expect(entryReadiness(ascensionProgress(RIVIERA.id, null))).toBe('unknown');
  });
});

describe('mountAscensionEntry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('joins the dock as a dialog button whose ring and label follow the progress', () => {
    const t = ui();
    let bullion: number | null = RIVIERA.bullionThreshold / 4;
    const entry = mountAscensionEntry({
      ui: t.app,
      host: t.dock as unknown as HTMLElement,
      progress: () => ascensionProgress(RIVIERA.id, bullion),
      audio: t.audio,
      onPress: () => undefined,
    });
    entry.update();
    const el = entryOf(t.dock);
    expect(el.tagName).toBe('button');
    expect(el.getAttribute('aria-haspopup')).toBe('dialog');
    expect(el.dataset.ready).toBe('building');
    expect(el.properties.get('--cp-ascension-entry-progress')).toBe('0.2500');
    const paris = t.i18n.t(venueKey(PARIS.id));
    expect(el.getAttribute('aria-label')).toBe(`Ascension: 25% of the way to ${paris}`);
    expect(el.all().filter((node) => node.className === 'cp-ascension-entry-mote')).toHaveLength(
      ENTRY_MOTES,
    );

    bullion = RIVIERA.bullionThreshold;
    entry.update();
    expect(el.dataset.ready).toBe('ready');
    expect(el.classList.contains('is-beckoning')).toBe(true);
    expect(el.getAttribute('aria-label')).toBe(`Ascension ready: ${paris} awaits`);

    bullion = null;
    entry.update();
    expect(el.dataset.ready).toBe('unknown');
    expect(el.getAttribute('aria-label')).toBe(t.i18n.t(ascensionKey('entryUnknown')));

    entry.dispose();
    expect(t.dock.children).toHaveLength(0);
  });

  it('labels itself in French and German too', () => {
    for (const language of ['fr', 'de'] as const) {
      const t = ui(language);
      mountAscensionEntry({
        ui: t.app,
        host: t.dock as unknown as HTMLElement,
        progress: () => ascensionProgress(RIVIERA.id, RIVIERA.bullionThreshold / 2),
        audio: t.audio,
        onPress: () => undefined,
      }).update();
      const label = entryOf(t.dock).getAttribute('aria-label') ?? '';
      expect(label).not.toContain('ascension:');
      expect(label).toContain(t.i18n.t(venueKey(PARIS.id)));
      expect(label).not.toBe(t.i18n.t(ascensionKey('entryProgress')));
    }
  });

  it('answers a press with at least four juice items before it opens', () => {
    const t = ui();
    const pressed: string[] = [];
    mountAscensionEntry({
      ui: t.app,
      host: t.dock as unknown as HTMLElement,
      progress: () => ascensionProgress(RIVIERA.id, 0),
      audio: t.audio,
      onPress: () => pressed.push('open'),
    }).update();
    const el = entryOf(t.dock);

    el.dispatch('pointerdown');
    expect(el.classList.contains('is-pressed')).toBe(true);
    expect(t.feedback).toEqual(['open']);
    el.dispatch('pointerup');
    el.dispatch('click');

    expect(t.feedback).toEqual(['open']);
    expect(t.sounds).toEqual([...ENTRY_SHIMMER]);
    expect(el.classList.contains('is-summoned')).toBe(true);
    expect(pressed).toEqual(['open']);
  });
});

describe('mountAscensionHud', () => {
  let time: FakeTime;
  let server: MockServer;
  let alice: Player;

  beforeEach(async () => {
    time = new FakeTime();
    server = createMockServer({ now: time.now });
    alice = await connectPlayer(server, time);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function player() {
    const found = server.world.player(requirePlayerId(alice));
    if (!found) throw new Error('Expected the mock to hold the player.');
    return found;
  }

  async function mount(overrides: Partial<MountAscensionHudOptions> = {}) {
    const t = ui();
    const booted = await alice.client.call('state', { query: { hydrate: 'boot' } });
    const mounted: MountAscensionOptions[] = [];
    const opened: number[] = [];
    let disposed = 0;
    const moved: StateResponse[] = [];
    const errors: unknown[] = [];
    let reads = 0;
    const hud = mountAscensionHud({
      ui: t.app,
      host: new FakeNode('div') as unknown as HTMLElement,
      dock: t.dock as unknown as HTMLElement,
      api: netAscensionApi(alice.client),
      state: booted,
      readState: () => {
        reads += 1;
        return alice.client.call('state');
      },
      onVenueChanged: (fresh) => moved.push(fresh),
      audio: t.audio,
      onError: (error) => errors.push(error),
      mount: (options): AscensionMount => {
        mounted.push(options);
        return {
          open: () => opened.push(options.bullion() ?? -1),
          dispose: () => (disposed += 1),
        };
      },
      delay: () => Promise.resolve(),
      ...overrides,
    });
    const options = mounted[0];
    if (!options) throw new Error('the hud did not mount the ascension screen');
    return {
      t,
      hud,
      options,
      opened,
      moved,
      errors,
      reads: () => reads,
      disposed: () => disposed,
      el: () => entryOf(t.dock),
    };
  }

  it('feeds the screen the server lifetime Bullion and re-reads it on every press', async () => {
    const m = await mount();
    expect(m.options.venueId()).toBe(RIVIERA.id);
    expect(m.options.bullion()).toBe(0);
    expect(m.el().dataset.ready).toBe('building');

    player().lifetimeBullion = RIVIERA.bullionThreshold;
    m.el().dispatch('click');
    m.el().dispatch('click');
    await vi.waitFor(() => {
      expect(m.opened).toEqual([RIVIERA.bullionThreshold]);
    });
    expect(m.reads()).toBe(1);
    expect(m.el().dataset.ready).toBe('ready');
    expect(m.moved).toEqual([]);
  });

  it('opens with an unknown figure when the re-read fails, so the server decides', async () => {
    const failure = new Error('offline');
    const m = await mount({ readState: () => Promise.reject(failure) });
    await m.hud.open();
    expect(m.opened).toEqual([-1]);
    expect(m.el().dataset.ready).toBe('unknown');
    expect(m.errors).toEqual([failure]);
  });

  it('reloads into the new venue once the cinematic hands back, then renews the ring', async () => {
    const m = await mount();
    player().lifetimeBullion = RIVIERA.bullionThreshold + 600;
    const response: AscendResponse = await alice.client.call('ascend', {
      body: { venueId: RIVIERA.id },
    });
    expect(response.goldBarsGranted).toBeGreaterThan(0);

    m.options.onAscended(response);
    await vi.waitFor(() => {
      expect(m.el().classList.contains('is-renewed')).toBe(true);
    });
    expect(m.moved.map((fresh) => fresh.venue.id)).toEqual([PARIS.id]);
    expect(m.moved[0]?.wallet.goldBars).toBe(response.goldBarsGranted);
    expect(m.options.venueId()).toBe(PARIS.id);
    expect(m.hud.state.venue.id).toBe(PARIS.id);
    expect(m.options.bullion()).toBe(0);
    expect(m.el().classList.contains('is-renewed')).toBe(true);
    expect(m.el().getAttribute('aria-label')).toContain('0%');
  });

  it('retries the reload with back-off and reports only when every read failed', async () => {
    const failure = new Error('offline');
    const waits: number[] = [];
    let calls = 0;
    let failuresLeft = RELOAD_RETRY_MS.length - 1;
    const m = await mount({
      readState: () => {
        calls += 1;
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          return Promise.reject(failure);
        }
        return alice.client.call('state');
      },
      delay: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    m.options.refresh?.();
    await vi.waitFor(() => {
      expect(m.hud.state.venue.lifetimeBullion).toBe(0);
      expect(calls).toBe(RELOAD_RETRY_MS.length);
    });
    expect(waits).toEqual(RELOAD_RETRY_MS.filter((ms) => ms > 0));
    expect(m.errors).toEqual([]);

    calls = 0;
    failuresLeft = RELOAD_RETRY_MS.length;
    m.options.refresh?.();
    await vi.waitFor(() => {
      expect(m.errors).toEqual([failure]);
    });
    expect(calls).toBe(RELOAD_RETRY_MS.length);
  });

  it('takes the entry and the screen down on dispose', async () => {
    const m = await mount();
    m.hud.dispose();
    expect(m.t.dock.children).toHaveLength(0);
    expect(m.disposed()).toBe(1);
  });
});

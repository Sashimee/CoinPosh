import type { Account } from '@coinposh/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBus } from '../../app/bus.ts';
import { defaultSettings, type SettingsStorage } from '../../app/settings.ts';
import { initialUiState, type UiEvents, type UiState } from '../../app/state.ts';
import { createStore } from '../../app/store.ts';
import { BUNDLED_RESOURCES, createI18n } from '../../i18n/index.ts';
import type { AccountClient } from '../../net/index.ts';
import { announcementHoldFor } from '../components/announcementHold.ts';
import { AFTER_ASCENSION_MS, mountAccountUi, PLAY_TICK_MS, type AccountUi } from './clock.ts';
import { PROMPT_PLAYTIME_MS, PROMPT_STORAGE_KEY, type PromptReason } from './model.ts';
import type { AccountSurface } from './surface.ts';

class MemoryStorage implements SettingsStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

const guest: Account = {
  playerId: 'p_guest' as Account['playerId'],
  identities: [],
  available: ['google', 'apple'],
};

const linked: Account = {
  ...guest,
  identities: [{ provider: 'google', linkedAt: 1 }],
};

/** Stands in for the lazily loaded section and card, recording what the clock asked of them. */
interface FakeSurface {
  readonly shown: PromptReason[];
  readonly refreshes: number;
  readonly visible: boolean;
  readonly surface: AccountSurface;
}

const detached = null as unknown as HTMLElement;

function fakeSurface(): FakeSurface {
  const shown: PromptReason[] = [];
  let refreshes = 0;
  let visible = false;
  return {
    shown,
    get refreshes() {
      return refreshes;
    },
    get visible() {
      return visible;
    },
    surface: {
      prompt: {
        el: detached,
        get visible() {
          return visible;
        },
        show(reason) {
          shown.push(reason);
          visible = true;
        },
        hide() {
          visible = false;
        },
      },
      section: {
        el: detached,
        refresh() {
          refreshes += 1;
        },
        highlight: () => undefined,
      },
      dispose: () => undefined,
    },
  };
}

interface Rig {
  readonly ui: AccountUi;
  readonly store: ReturnType<typeof createStore<UiState>>;
  readonly storage: MemoryStorage;
  readonly fake: FakeSurface;
  playing: boolean;
  visible: boolean;
}

const mounted: AccountUi[] = [];

function rig(
  options: { storage?: MemoryStorage; account?: Account; store?: Rig['store'] } = {},
): Rig {
  const surface = fakeSurface();
  const storage = options.storage ?? new MemoryStorage();
  const store = options.store ?? createStore(initialUiState(defaultSettings('en')));
  const client = { get: () => Promise.resolve(options.account ?? guest) };
  const state = {
    playing: true,
    visible: true,
  };
  const ui = mountAccountUi({
    ui: {
      store,
      bus: createBus<UiEvents>(),
      i18n: createI18n({ language: 'en', resources: BUNDLED_RESOURCES }),
      bannerSlot: detached,
    },
    host: detached,
    slot: detached,
    client: () => Promise.resolve(client as unknown as AccountClient),
    playing: () => state.playing,
    visible: () => state.visible,
    storage,
    mountSurface: () => Promise.resolve(surface.surface),
  });
  mounted.push(ui);
  return {
    ui,
    store,
    storage,
    fake: surface,
    get playing() {
      return state.playing;
    },
    set playing(value) {
      state.playing = value;
    },
    get visible() {
      return state.visible;
    },
    set visible(value) {
      state.visible = value;
    },
  };
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

/** Plays `ms` of table time in whole ticks, the way the clock counts it. */
async function play(ms: number): Promise<void> {
  await advance(Math.ceil(ms / PLAY_TICK_MS) * PLAY_TICK_MS);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const ui of mounted.splice(0)) ui.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the gentle prompt clock', () => {
  it('asks once the first ascension has had its moment, not during it', async () => {
    const { ui, fake: surface, storage } = rig();
    ui.ascended();
    await advance(AFTER_ASCENSION_MS - 1);
    expect(surface.shown).toEqual([]);
    await advance(1);
    expect(surface.shown).toEqual(['ascension']);
    expect(JSON.parse(storage.getItem(PROMPT_STORAGE_KEY) ?? '{}')).toMatchObject({
      shown: 'ascension',
    });
  });

  it('asks after two hours of play, and not a tick before', async () => {
    const { fake: surface } = rig();
    await play(PROMPT_PLAYTIME_MS - PLAY_TICK_MS);
    expect(surface.shown).toEqual([]);
    await play(PLAY_TICK_MS);
    expect(surface.shown).toEqual(['playtime']);
  });

  it('counts only time the table is playable and on screen', async () => {
    const table = rig();
    table.playing = false;
    await play(PROMPT_PLAYTIME_MS);
    table.playing = true;
    table.visible = false;
    await play(PROMPT_PLAYTIME_MS);
    expect(table.fake.shown).toEqual([]);
    table.visible = true;
    await play(PROMPT_PLAYTIME_MS);
    expect(table.fake.shown).toEqual(['playtime']);
  });

  it('keeps play time across visits on the same device', async () => {
    const storage = new MemoryStorage();
    rig({ storage });
    await play(PROMPT_PLAYTIME_MS / 2);
    for (const ui of mounted.splice(0)) ui.dispose();
    const second = rig({ storage });
    await play(PROMPT_PLAYTIME_MS / 2 - PLAY_TICK_MS);
    expect(second.fake.shown).toEqual([]);
    await play(PLAY_TICK_MS);
    expect(second.fake.shown).toEqual(['playtime']);
  });

  it('waits while a sheet is open and asks once it closes', async () => {
    const { ui, store, fake: surface } = rig();
    store.setState({ panel: 'upgrades' });
    ui.ascended();
    await advance(AFTER_ASCENSION_MS * 3);
    expect(surface.shown).toEqual([]);
    store.setState({ panel: null });
    await advance(0);
    expect(surface.shown).toEqual(['ascension']);
  });

  it('steps aside when a sheet opens over it and does not come back', async () => {
    const { ui, store, fake: surface } = rig();
    ui.ascended();
    await advance(AFTER_ASCENSION_MS);
    expect(surface.visible).toBe(true);
    store.setState({ panel: 'upgrades' });
    expect(surface.visible).toBe(false);
    store.setState({ panel: null });
    await play(PROMPT_PLAYTIME_MS);
    expect(surface.shown).toEqual(['ascension']);
  });

  it('waits out a crate cinematic and asks once it ends', async () => {
    const { ui, store, fake: surface } = rig();
    const release = announcementHoldFor(store).hold();
    ui.ascended();
    await advance(AFTER_ASCENSION_MS * 3);
    expect(surface.shown).toEqual([]);
    release();
    await advance(0);
    expect(surface.shown).toEqual(['ascension']);
  });

  it('hides for a crate that falls while it shows, then comes back once', async () => {
    const { ui, store, fake: surface } = rig();
    ui.ascended();
    await advance(AFTER_ASCENSION_MS);
    const release = announcementHoldFor(store).hold();
    expect(surface.visible).toBe(false);
    release();
    await advance(0);
    expect(surface.shown).toEqual(['ascension', 'ascension']);
    expect(surface.visible).toBe(true);
  });

  it('never asks again after the player dismissed it, in this visit or the next', async () => {
    const storage = new MemoryStorage();
    const first = rig({ storage });
    first.ui.ascended();
    await advance(AFTER_ASCENSION_MS);
    first.fake.surface.prompt.hide();
    first.ui.ascended();
    await advance(AFTER_ASCENSION_MS);
    await play(PROMPT_PLAYTIME_MS);
    expect(first.fake.shown).toEqual(['ascension']);

    for (const ui of mounted.splice(0)) ui.dispose();
    const second = rig({ storage });
    second.ui.ascended();
    await advance(AFTER_ASCENSION_MS);
    await play(PROMPT_PLAYTIME_MS);
    expect(second.fake.shown).toEqual([]);
  });

  it('never asks a player whose progress is already kept', async () => {
    const { ui, fake: surface } = rig({ account: linked });
    ui.ascended();
    await advance(AFTER_ASCENSION_MS);
    await play(PROMPT_PLAYTIME_MS);
    expect(surface.shown).toEqual([]);
  });

  it('collapses ascensions in quick succession into one ask', async () => {
    const { ui, fake: surface } = rig();
    ui.ascended();
    await advance(AFTER_ASCENSION_MS / 2);
    ui.ascended();
    await advance(AFTER_ASCENSION_MS);
    expect(surface.shown).toEqual(['ascension']);
  });

  it('refreshes the section each time Settings opens', async () => {
    const { store, fake: surface } = rig();
    store.setState({ panel: 'settings' });
    await advance(0);
    store.setState({ panel: null });
    store.setState({ panel: 'settings' });
    await advance(0);
    expect(surface.refreshes).toBe(2);
  });

  it('asks nothing once disposed', async () => {
    const { ui, fake: surface } = rig();
    ui.ascended();
    ui.dispose();
    await advance(AFTER_ASCENSION_MS);
    await play(PROMPT_PLAYTIME_MS);
    expect(surface.shown).toEqual([]);
  });
});

import { RollSchema, WalletSchema, type CrateId } from '@coinposh/shared';
import {
  BufferGeometry,
  Group,
  MeshBasicNodeMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
  type Object3D,
} from 'three/webgpu';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBus } from '../../app/bus.ts';
import { defaultSettings } from '../../app/settings.ts';
import { initialUiState, type UiEvents, type UiState } from '../../app/state.ts';
import { createStore } from '../../app/store.ts';
import { BUNDLED_RESOURCES, createI18n } from '../../i18n/index.ts';
import {
  PAYOUT_HOLD_CAP_MS,
  PayoutLedger,
  walletPayoutFor,
  type WalletPayout,
} from '../../ui/components/balancePlaque.ts';
import type { KeyLike } from '../../ui/panels/sheetFocus.ts';
import type { CrateEvents } from './events.ts';
import {
  bindEscapeCollect,
  holdWhileSheetOpen,
  mountCrates,
  payoutLines,
  replayWhenPlayable,
  rollCredit,
  trackCratePayout,
  type CratesMountOptions,
  type KeyDocument,
} from './mount.ts';
import { unseenCrates } from './unseen.ts';
import { UnboxDirector, type OpenedCrate } from './view.ts';

const A = 'crate_AAAAAAAAAAAAAAAA' as CrateId;
const B = 'crate_BBBBBBBBBBBBBBBB' as CrateId;

const opened = (crateId: CrateId): OpenedCrate => ({
  crateId,
  roll: RollSchema.parse({
    rarity: 'fine',
    rewards: [{ kind: 'currency', currency: 'pearls', amount: 25 }],
    proof: { serverSeedHash: 'a'.repeat(64), clientSeed: 'velvet', nonce: 1 },
    pity: { rare: 0, exquisite: 0, legendary: 0 },
  }),
  wallet: WalletSchema.parse({
    coins: 10,
    bullion: 0,
    goldBars: 0,
    pearls: 25,
    keys: 0,
    tickets: 0,
    stars: 0,
  }),
  at: new Vector3(0, -0.075, 0.085),
});

function sheetAndDirector() {
  const store = createStore(initialUiState(defaultSettings('en')));
  const events = createBus<CrateEvents>();
  const ready: number[] = [];
  events.on('crate:waiting', ({ count }) => ready.push(count));
  const started: CrateId[] = [];
  const director = new UnboxDirector({
    parent: new Group(),
    camera: new PerspectiveCamera(40, 9 / 16),
    framing: () => ({
      position: new Vector3(0, 0.5, 0.6),
      target: new Vector3(0, 0, -0.05),
      fov: 40,
    }),
    events,
    reducedMotion: () => true,
    onStart: (crateId) => started.push(crateId),
    card: () => ({ shown: false, show: () => undefined, dispose: () => undefined }),
  });
  const off = holdWhileSheetOpen(store, director);
  return { store, director, ready, started, off };
}

describe('crates wait for an open sheet', () => {
  it('queues a crate that opens while Upgrades is up and plays it as the sheet closes', () => {
    const { store, director, ready, started, off } = sheetAndDirector();
    store.setState({ panel: 'upgrades' });
    director.enqueue(opened(A));
    expect(director.active).toBeNull();
    expect(ready).toEqual([1]);

    store.setState({ panel: null });
    expect(director.active).toBe(A);
    expect(started).toEqual([A]);
    expect(ready).toEqual([1, 0]);
    off();
    director.dispose();
  });

  it('stays held when one sheet hands over to another, and starts once when the last closes', () => {
    const { store, director, started, off } = sheetAndDirector();
    store.setState({ panel: 'upgrades' });
    director.enqueue(opened(A));
    director.enqueue(opened(B));
    store.setState({ panel: 'settings' });
    expect(director.active).toBeNull();
    store.setState({ panel: null });
    store.setState({ panel: null });
    expect(started).toEqual([A]);
    expect(director.waiting).toBe(1);
    off();
    director.dispose();
  });

  it('holds from the start when a sheet is already open at mount', () => {
    const store = createStore<UiState>({
      ...initialUiState(defaultSettings('en')),
      panel: 'settings',
    });
    const holds: boolean[] = [];
    const off = holdWhileSheetOpen(store, { hold: (held) => holds.push(held) });
    store.setState({ panel: null });
    expect(holds).toEqual([true, false]);
    off();
    store.setState({ panel: 'upgrades' });
    expect(holds).toEqual([true, false]);
  });

  it('holds a playing unbox when a sheet opens over it rather than stacking the two', () => {
    const { store, director, ready, off } = sheetAndDirector();
    director.enqueue(opened(A));
    director.update(0.2);
    const at = director.cinematic?.elapsed;
    store.setState({ panel: 'upgrades' });
    expect(director.held).toBe(true);
    director.update(2);
    expect(director.cinematic?.elapsed).toBe(at);
    expect(ready).toEqual([1]);
    store.setState({ panel: null });
    expect(director.held).toBe(false);
    expect(director.active).toBe(A);
    off();
    director.dispose();
  });
});

function keyDocument() {
  const listeners = new Set<(event: KeyLike) => void>();
  const doc: KeyDocument = {
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  const press = (key: string, defaultPrevented = false) => {
    const event = {
      key,
      defaultPrevented,
      preventDefault() {
        event.defaultPrevented = true;
      },
    };
    for (const listener of [...listeners]) listener(event);
    return event;
  };
  return { doc, press, listeners };
}

describe('Escape on the reward card', () => {
  it('collects the card once it is up, and claims the key', () => {
    const { doc, press } = keyDocument();
    let collects = 0;
    bindEscapeCollect(doc, { ready: () => true, collect: () => (collects += 1) });
    expect(press('Escape').defaultPrevented).toBe(true);
    expect(collects).toBe(1);
  });

  it('leaves Escape alone while the card is not ready, for the skip veil or a sheet to use', () => {
    const { doc, press } = keyDocument();
    let collects = 0;
    bindEscapeCollect(doc, { ready: () => false, collect: () => (collects += 1) });
    expect(press('Escape').defaultPrevented).toBe(false);
    expect(collects).toBe(0);
  });

  it('ignores other keys and an Escape something else already handled', () => {
    const { doc, press } = keyDocument();
    let collects = 0;
    bindEscapeCollect(doc, { ready: () => true, collect: () => (collects += 1) });
    press('Enter');
    press('a');
    press('Escape', true);
    expect(collects).toBe(0);
  });

  it('stops listening once unbound', () => {
    const { doc, press, listeners } = keyDocument();
    let collects = 0;
    const off = bindEscapeCollect(doc, { ready: () => true, collect: () => (collects += 1) });
    off();
    press('Escape');
    expect(collects).toBe(0);
    expect(listeners.size).toBe(0);
  });
});

describe('the payout a collect hands the HUD', () => {
  const roll = RollSchema.parse({
    rarity: 'rare',
    rewards: [
      { kind: 'currency', currency: 'pearls', amount: 15 },
      { kind: 'scratchCard', cardId: 'scratch_AAAAAAAAAAAA' },
      { kind: 'currency', currency: 'coins', amount: 12 },
      { kind: 'currency', currency: 'pearls', amount: 5 },
      { kind: 'currency', currency: 'tickets', amount: 2 },
    ],
    proof: { serverSeedHash: 'a'.repeat(64), clientSeed: 'velvet', nonce: 3 },
    pity: { rare: 0, exquisite: 0, legendary: 0 },
  });

  it('holds each currency the roll credits, summed as the card shows it', () => {
    expect(rollCredit(roll)).toEqual({ coins: 12, pearls: 20, tickets: 2 });
    expect(rollCredit(opened(A).roll)).toEqual({ pearls: 25 });
  });

  it("pairs each currency line with the card's own line element, items first", () => {
    const items = ['scratch', 'coins', 'pearls', 'tickets'].map((name) => ({ name }));
    const card = {
      querySelectorAll: (selector: string) => {
        expect(selector).toBe('.cp-crate-lines > li');
        return items as unknown as NodeListOf<Element>;
      },
    };
    expect(payoutLines(roll, card)).toEqual([
      { currency: 'coins', amount: 12, source: items[1] },
      { currency: 'pearls', amount: 20, source: items[2] },
      { currency: 'tickets', amount: 2, source: items[3] },
    ]);
  });

  it('still pays every line out without a card to fly from', () => {
    expect(payoutLines(roll, null).map((line) => [line.currency, line.source])).toEqual([
      ['coins', null],
      ['pearls', null],
      ['tickets', null],
    ]);
  });
});

describe('a crate holds its credit from open to collect', () => {
  const coinRoll = RollSchema.parse({
    rarity: 'fine',
    rewards: [{ kind: 'currency', currency: 'coins', amount: 12 }],
    proof: { serverSeedHash: 'a'.repeat(64), clientSeed: 'velvet', nonce: 2 },
    pity: { rare: 0, exquisite: 0, legendary: 0 },
  });
  const coinWallet = WalletSchema.parse({
    coins: 52,
    bullion: 0,
    goldBars: 0,
    pearls: 0,
    keys: 0,
    tickets: 0,
    stars: 0,
  });

  function recorded() {
    const calls: string[] = [];
    const payout: WalletPayout = {
      hold: (id) => calls.push(`hold ${id}`),
      retract: (id) => calls.push(`retract ${id}`),
      arm: (id) => calls.push(`arm ${id}`),
      disarm: (id) => calls.push(`disarm ${id}`),
      collect: (id) => calls.push(`collect ${id}`),
      release: (id) => calls.push(`release ${id}`),
    };
    return { calls, tracker: trackCratePayout(payout) };
  }

  it('releases a crate whose card goes without a collect, exactly once', () => {
    const { calls, tracker } = recorded();
    tracker.opened(A, coinRoll);
    tracker.mounted(A);
    tracker.gone(A);
    tracker.gone(A);
    tracker.dispose();
    expect(calls).toEqual([`hold ${A}`, `arm ${A}`, `disarm ${A}`, `release ${A}`]);
  });

  it('does not release a collected crate when its card goes', () => {
    const { calls, tracker } = recorded();
    tracker.opened(A, coinRoll);
    tracker.mounted(A);
    tracker.collected(A, coinRoll, coinWallet, null);
    tracker.gone(A);
    tracker.dispose();
    expect(calls).toEqual([`hold ${A}`, `arm ${A}`, `disarm ${A}`, `collect ${A}`]);
  });

  it('releases every crate still unpaid on teardown, once each', () => {
    const { calls, tracker } = recorded();
    const C = 'crate_CCCCCCCCCCCCCCCC' as CrateId;
    tracker.opened(A, coinRoll);
    tracker.opened(B, coinRoll);
    tracker.opened(C, coinRoll);
    tracker.collected(B, coinRoll, coinWallet, null);
    tracker.dispose();
    tracker.dispose();
    expect(calls.filter((call) => call.startsWith('release'))).toEqual([
      `release ${A}`,
      `release ${C}`,
    ]);
  });

  it('caps a crate only until its card mounts, never while the card is up', () => {
    const { calls, tracker } = recorded();
    tracker.opened(A, coinRoll);
    tracker.mounted(A);
    tracker.covered(true);
    tracker.covered(false);
    tracker.collected(A, coinRoll, coinWallet, null);
    tracker.mounted(A);
    tracker.gone(A);
    expect(calls).toEqual([`hold ${A}`, `arm ${A}`, `disarm ${A}`, `collect ${A}`]);
  });

  it('pauses the cap of a queued crate while another card is up or a sheet covers the table', () => {
    const { calls, tracker } = recorded();
    tracker.opened(A, coinRoll);
    tracker.mounted(A);
    tracker.opened(B, coinRoll);
    expect(calls, 'B waits its turn behind the open card').toEqual([
      `hold ${A}`,
      `arm ${A}`,
      `disarm ${A}`,
      `hold ${B}`,
    ]);
    calls.length = 0;
    tracker.collected(A, coinRoll, coinWallet, null);
    expect(calls).toEqual([`collect ${A}`, `arm ${B}`]);
    calls.length = 0;
    tracker.covered(true);
    tracker.covered(true);
    tracker.covered(false);
    tracker.mounted(B);
    expect(calls).toEqual([`disarm ${B}`, `arm ${B}`, `disarm ${B}`]);
  });

  it('lets a replayed card, which holds nothing, still pause the cap of a crate behind it', () => {
    const { calls, tracker } = recorded();
    tracker.mounted(A);
    tracker.opened(B, coinRoll);
    tracker.collected(A, coinRoll, coinWallet, null);
    expect(calls).toEqual([`hold ${B}`, `collect ${A}`, `arm ${B}`]);
  });

  describe('against the HUD ledger', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    function booked() {
      const warnings: string[] = [];
      const ledger = new PayoutLedger(() => undefined, {
        warn: (message) => warnings.push(message),
      });
      const tracker = trackCratePayout(ledger);
      ledger.coins.observe(40);
      return { warnings, ledger, tracker };
    }

    it('keeps a card left up for minutes off the Vault, then pays exactly its coin line', () => {
      const { warnings, ledger, tracker } = booked();
      tracker.opened(A, coinRoll);
      ledger.coins.observe(52);
      tracker.mounted(A);
      vi.advanceTimersByTime(PAYOUT_HOLD_CAP_MS * 4);
      expect(ledger.coins.shown).toBe(40);

      tracker.covered(true);
      vi.advanceTimersByTime(PAYOUT_HOLD_CAP_MS * 2);
      tracker.covered(false);
      vi.advanceTimersByTime(PAYOUT_HOLD_CAP_MS * 2);
      tracker.collected(A, coinRoll, coinWallet, null);
      expect(ledger.coins.shown).toBe(40);
      ledger.land(A, 'coins');
      expect(ledger.coins.shown).toBe(52);
      expect(warnings).toEqual([]);
    });

    it('still releases a crate whose card never mounts after the cap, with a warning', () => {
      const { warnings, ledger, tracker } = booked();
      tracker.opened(A, coinRoll);
      ledger.coins.observe(52);
      vi.advanceTimersByTime(PAYOUT_HOLD_CAP_MS - 1);
      expect(ledger.coins.shown).toBe(40);
      expect(warnings).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(ledger.coins.shown).toBe(52);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(A);
    });

    it('keeps a queued crate held while the card ahead of it is left up', () => {
      const { warnings, ledger, tracker } = booked();
      tracker.opened(A, coinRoll);
      ledger.coins.observe(52);
      tracker.mounted(A);
      tracker.opened(B, coinRoll);
      ledger.coins.observe(64);
      vi.advanceTimersByTime(PAYOUT_HOLD_CAP_MS * 3);
      expect(ledger.coins.shown).toBe(40);
      tracker.collected(A, coinRoll, coinWallet, null);
      ledger.land(A, 'coins');
      expect(ledger.coins.shown).toBe(52);
      tracker.mounted(B);
      vi.advanceTimersByTime(PAYOUT_HOLD_CAP_MS * 3);
      expect(ledger.coins.shown).toBe(52);
      expect(warnings).toEqual([]);
    });
  });
});

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style = { setProperty: () => undefined, removeProperty: () => undefined };
  readonly classList = { remove: () => undefined, toggle: () => undefined };
  className = '';
  hidden = false;
  textContent = '';
  parent: FakeElement | null = null;
  readonly attributes = new Map<string, string>();
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
    this.parent?.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
}

describe('replaying unseen crates once the table is playable', () => {
  function stage() {
    const listeners = new Set<(deltaSeconds: number) => void>();
    return {
      listeners,
      onFrame(listener: (deltaSeconds: number) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      frame() {
        for (const listener of [...listeners]) listener(1 / 60);
      },
    };
  }

  it('waits for a frame after the table turned playable and for the warm-up, then replays once', () => {
    const table = stage();
    const warmup = { warming: false };
    let playable = false;
    let replays = 0;
    replayWhenPlayable(
      table,
      warmup,
      () => playable,
      () => (replays += 1),
    );
    table.frame();
    table.frame();
    expect(replays).toBe(0);

    playable = true;
    warmup.warming = true;
    table.frame();
    expect(replays, 'never on the frame the poster lifts').toBe(0);
    table.frame();
    table.frame();
    expect(replays, 'never beside the warm-up').toBe(0);

    warmup.warming = false;
    table.frame();
    expect(replays).toBe(1);
    expect(table.listeners.size).toBe(0);
    table.frame();
    expect(replays).toBe(1);
  });

  it('never replays once disposed', () => {
    const table = stage();
    let replays = 0;
    const off = replayWhenPlayable(
      table,
      { warming: false },
      () => true,
      () => (replays += 1),
    );
    table.frame();
    off();
    table.frame();
    off();
    expect(replays).toBe(0);
    expect(table.listeners.size).toBe(0);
  });
});

describe('the crate warm-up in the mounted module', () => {
  const PLAYABLE = 'coinposh:boot:playable';
  let spawned = 0;

  beforeEach(() => {
    // The unbox primer waits on timeouts here; the boot mark has to stay on the real `performance`.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('document', { createElement: () => new FakeElement() });
  });

  afterEach(() => {
    performance.clearMarks(PLAYABLE);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function warmProps(scene: Object3D): Object3D[] {
    return scene.children.filter((part) => part.position.y === -1_000);
  }

  function mounted(overrides: Partial<CratesMountOptions> = {}) {
    const scene = new Group();
    const listeners = new Set<(deltaSeconds: number) => void>();
    const crates = mountCrates({
      net: {
        table: { subscribe: () => () => undefined, claimCrate: () => undefined },
        client: { call: () => Promise.reject(new Error('No server in this test')) },
      },
      sim: { stats: { tick: 0, pusherStroke: 0 } },
      stage: {
        scene,
        camera: new PerspectiveCamera(40, 9 / 16),
        renderer: {},
        onFrame(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      framing: () => ({
        position: new Vector3(0, 0.5, 0.6),
        target: new Vector3(0, 0, -0.05),
        fov: 40,
      }),
      ui: {
        store: createStore(initialUiState(defaultSettings('en'))),
        bus: createBus<UiEvents>(),
        i18n: createI18n({ language: 'en', resources: BUNDLED_RESOURCES }),
      },
      host: new FakeElement() as unknown as HTMLElement,
      reducedMotion: () => true,
      ...overrides,
    });
    const prime = vi.spyOn(crates.director, 'prime');
    /** One table frame: listeners, the out-of-sight props draw, then the frame's task and idle slot end. */
    const frame = async (): Promise<void> => {
      for (const listener of [...listeners]) listener(1 / 60);
      const unboxPrimer = scene.getObjectByName('unbox-primer')?.children ?? [];
      for (const part of [...warmProps(scene), ...unboxPrimer]) {
        part.onAfterRender(
          null as never,
          new Scene(),
          new PerspectiveCamera(),
          new BufferGeometry(),
          new MeshBasicNodeMaterial(),
          new Group(),
        );
      }
      await Promise.resolve();
      vi.runOnlyPendingTimers();
    };
    /** A crate already on the table at load, so the arrival hint stays down. */
    const spawn = (): void => {
      spawned += 1;
      crates.events.emit('crate:spawned', {
        crateId: `crate_${String(spawned).padStart(16, 'A')}` as CrateId,
        kind: 'vault',
        position: { x: 0, y: 0, z: 0 },
        resumed: true,
      });
    };
    const unboxPriming = (): boolean => scene.getObjectByName('unbox-primer') !== undefined;
    return { crates, scene, listeners, prime, frame, spawn, unboxPriming };
  }

  it('primes the unbox for a crate that spawns before the table is playable', async () => {
    const { crates, scene, prime, frame, spawn, unboxPriming } = mounted();
    await frame();
    spawn();
    expect(prime).toHaveBeenCalledOnce();
    expect(unboxPriming()).toBe(true);
    expect(warmProps(scene)).toEqual([]);
    crates.dispose();
  });

  it('leaves a crate that spawns mid-warm-up to the warm-up, which primes the unbox once done', async () => {
    const { crates, scene, prime, frame, spawn, unboxPriming } = mounted();
    performance.mark(PLAYABLE);
    await frame();
    expect(warmProps(scene)).toHaveLength(1);
    spawn();
    expect(prime).not.toHaveBeenCalled();
    expect(unboxPriming()).toBe(false);

    for (let i = 0; i < 6; i++) await frame();
    expect(warmProps(scene)).toEqual([]);
    expect(prime).toHaveBeenCalledOnce();
    expect(unboxPriming()).toBe(true);
    crates.dispose();
  });

  it('starts no second primer for a crate that spawns after the warm-up', async () => {
    const { crates, scene, frame, spawn, unboxPriming } = mounted();
    performance.mark(PLAYABLE);
    for (let i = 0; i < 7; i++) await frame();
    expect(unboxPriming()).toBe(true);
    for (let i = 0; i < 7; i++) await frame();
    expect(unboxPriming()).toBe(false);

    spawn();
    await frame();
    expect(unboxPriming()).toBe(false);
    expect(warmProps(scene)).toEqual([]);
    crates.dispose();
  });

  it('replays an unseen crate after the warm-up, with no payout hold, until it is collected', async () => {
    const unseen = unseenCrates(null, (message) => {
      throw new Error(message);
    });
    unseen.add(A);
    const asked: string[] = [];
    const served = opened(A);
    const store = createStore(initialUiState(defaultSettings('en')));
    const { crates, frame } = mounted({
      unseen,
      net: {
        table: { subscribe: () => () => undefined, claimCrate: () => undefined },
        client: {
          call: ((endpoint: string) => {
            asked.push(endpoint);
            return endpoint === 'cratesOpen'
              ? Promise.resolve({ crateId: A, roll: served.roll, wallet: served.wallet })
              : Promise.reject(new Error(`No ${endpoint} in this test`));
          }) as never,
        },
      },
      ui: {
        store,
        bus: createBus<UiEvents>(),
        i18n: createI18n({ language: 'en', resources: BUNDLED_RESOURCES }),
      },
    });
    const payouts: string[] = [];
    const detach = walletPayoutFor(store).attach({
      hold: (id) => payouts.push(`hold ${id}`),
      retract: (id) => payouts.push(`retract ${id}`),
      arm: (id) => payouts.push(`arm ${id}`),
      disarm: (id) => payouts.push(`disarm ${id}`),
      collect: (id) => payouts.push(`collect ${id}`),
      release: (id) => payouts.push(`release ${id}`),
    });
    const enqueue = vi.spyOn(crates.director, 'enqueue');
    const replayed: CrateEvents['crate:opened'][] = [];
    crates.events.on('crate:opened', (payload) => replayed.push(payload));

    await frame();
    await frame();
    expect(asked).toEqual([]);
    performance.mark(PLAYABLE);
    for (let i = 0; i < 3; i++) await frame();
    expect(asked, 'not while the warm-up links the unbox').toEqual([]);
    for (let i = 0; i < 6; i++) await frame();
    expect(asked).toEqual(['cratesOpen']);
    expect(replayed).toEqual([
      { crateId: A, roll: served.roll, wallet: served.wallet, replayed: true },
    ]);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ crateId: A, roll: served.roll }),
    );
    expect(payouts, 'the replayed credit is already on the plaque').toEqual([]);

    crates.events.emit('crate:collected', { crateId: A, roll: served.roll, wallet: served.wallet });
    expect(payouts).toEqual([`collect ${A}`]);
    expect(unseen.list()).toEqual([]);
    crates.dispose();
    detach();
  });

  it('holds nothing on the payout it is given for a replayed open, so no falls wait behind it', () => {
    const calls: string[] = [];
    const payout: WalletPayout = {
      hold: (id) => calls.push(`hold ${id}`),
      retract: (id) => calls.push(`retract ${id}`),
      arm: (id) => calls.push(`arm ${id}`),
      disarm: (id) => calls.push(`disarm ${id}`),
      collect: (id) => calls.push(`collect ${id}`),
      release: (id) => calls.push(`release ${id}`),
    };
    const { crates } = mounted({ payout });
    const enqueue = vi.spyOn(crates.director, 'enqueue').mockImplementation(() => undefined);
    const replay = opened(A);
    crates.events.emit('crate:opened', {
      crateId: A,
      roll: replay.roll,
      wallet: replay.wallet,
      replayed: true,
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(calls, 'the replayed credit is already on the plaque the page booted with').toEqual([]);

    const live = opened(B);
    crates.events.emit('crate:opened', { crateId: B, roll: live.roll, wallet: live.wallet });
    expect(calls).toEqual([`hold ${B}`, `arm ${B}`]);
    crates.dispose();
    expect(calls).toEqual([`hold ${B}`, `arm ${B}`, `release ${B}`]);
  });

  it('stops the warm-up on dispose, mid-way, and never primes the unbox', async () => {
    const { crates, scene, listeners, prime, frame, unboxPriming } = mounted();
    performance.mark(PLAYABLE);
    await frame();
    await frame();
    expect(warmProps(scene)).toHaveLength(1);

    crates.dispose();
    expect(warmProps(scene)).toEqual([]);
    expect(listeners.size).toBe(0);
    await frame();
    expect(prime).not.toHaveBeenCalled();
    expect(unboxPriming()).toBe(false);
  });
});

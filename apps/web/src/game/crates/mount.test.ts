import { RollSchema, WalletSchema, type CrateId } from '@coinposh/shared';
import { Group, PerspectiveCamera, Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { createBus } from '../../app/bus.ts';
import { defaultSettings } from '../../app/settings.ts';
import { initialUiState, type UiState } from '../../app/state.ts';
import { createStore } from '../../app/store.ts';
import type { KeyLike } from '../../ui/panels/sheetFocus.ts';
import type { CrateEvents } from './events.ts';
import { bindEscapeCollect, holdWhileSheetOpen, type KeyDocument } from './mount.ts';
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

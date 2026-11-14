import { MintedCoinSchema, type Claim, type ClaimResult, type CoinId } from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import { createBus } from '../../app/bus.ts';
import type { TableEvent } from '../../net/index.ts';
import { newIdempotencyKey } from '../../net/request.ts';
import type { SimEventBatch } from '../simWorker/index.ts';
import type { GameEvents } from '../systems/index.ts';
import {
  ACTIVITY_CONTACT_STRENGTH,
  SAMPLE_INTERVAL_MS,
  SAMPLE_WINDOW_MS,
  wireSnapshotTriggers,
  type PagePort,
} from './triggers.ts';

class FakeScheduler {
  now = 0;
  #next = 0;
  readonly timers = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, ms: number): unknown {
    const handle = this.#next++;
    this.timers.set(handle, { at: this.now + ms, callback });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort(([, a], [, b]) => a.at - b.at)[0];
      if (!due) break;
      const [handle, timer] = due;
      this.timers.delete(handle);
      this.now = timer.at;
      timer.callback();
    }
    this.now = end;
  }
}

class FakePage implements PagePort {
  shown = true;
  readonly visibility = new Set<() => void>();
  readonly hides = new Set<() => void>();

  visible(): boolean {
    return this.shown;
  }

  onVisibilityChange(listener: () => void): () => void {
    this.visibility.add(listener);
    return () => this.visibility.delete(listener);
  }

  onPagehide(listener: () => void): () => void {
    this.hides.add(listener);
    return () => this.hides.delete(listener);
  }

  setShown(shown: boolean): void {
    this.shown = shown;
    for (const listener of this.visibility) listener();
  }

  hide(): void {
    for (const listener of this.hides) listener();
  }
}

const NO_EVENTS: SimEventBatch = { falls: [], contacts: [], fusions: [] };

function setup(sample: () => Promise<void> = () => Promise.resolve()) {
  const scheduler = new FakeScheduler();
  const page = new FakePage();
  const game = createBus<GameEvents>();
  const simListeners = new Set<(batch: SimEventBatch) => void>();
  const tableListeners = new Set<(event: TableEvent) => void>();
  const calls: string[] = [];
  const errors: unknown[] = [];
  let samples = 0;
  const triggers = wireSnapshotTriggers({
    cadence: {
      activity: () => calls.push('activity'),
      hidden: () => calls.push('hidden'),
      pagehide: () => calls.push('pagehide'),
      close: () => calls.push('close'),
    },
    capture: {
      refresh: () => {
        samples += 1;
        return sample();
      },
    },
    game,
    sim: {
      onEvents(listener) {
        simListeners.add(listener);
        return () => simListeners.delete(listener);
      },
    },
    table: {
      subscribe(listener) {
        tableListeners.add(listener);
        return () => tableListeners.delete(listener);
      },
    },
    page,
    scheduler,
    now: () => scheduler.now,
    onError: (error) => errors.push(error),
  });
  const table = (event: TableEvent): void => {
    for (const listener of tableListeners) listener(event);
  };
  const sim = (batch: Partial<SimEventBatch>): void => {
    for (const listener of simListeners) listener({ ...NO_EVENTS, ...batch });
  };
  return {
    triggers,
    scheduler,
    page,
    game,
    sim,
    table,
    calls,
    errors,
    simListeners,
    tableListeners,
    samples: () => samples,
  };
}

const ORIGIN = { x: 0, y: 0, z: 0 };
const FELL: GameEvents['coin:fell'] = { coin: null, edge: 'front', position: ORIGIN, tick: 4 };

const coin = (n: number): CoinId => `coin_${'C'.repeat(15)}${String(n)}` as CoinId;
const MINTED = MintedCoinSchema.parse({ id: coin(9), tier: 'silver', value: 12 });
const FUSION: Claim = { kind: 'fusion', coinIds: [coin(1), coin(2), coin(3)], tick: 40 };
const FALL: Claim = { kind: 'fall', coinId: coin(4), tick: 41, edge: 'front' };
const FUSED: ClaimResult = { status: 'accepted', credited: 0, cascade: null, minted: MINTED };
const PAID: ClaimResult = { status: 'accepted', credited: 5, cascade: null, minted: null };

const contact = (strength: number): SimEventBatch['contacts'][number] => ({
  coinId: 0,
  tick: 1,
  position: { x: 0, y: 0, z: 0 },
  speed: strength,
  strength,
  surface: 'coin',
});

describe('wireSnapshotTriggers', () => {
  it('counts a drop, a nudge, a fusion and a fall as the table moving', () => {
    const { game, calls } = setup();
    game.emit('drop:requested', {
      aim: 0,
      xMm: 0,
      tick: 1,
      coin: null,
      ordinal: 1,
      first: true,
      poured: false,
    });
    game.emit('nudge', { direction: 'left', strength: 1, source: 'key', tick: 3 });
    game.emit('coin:fusion', { sources: [ORIGIN], center: ORIGIN, tier: 'silver', claimed: false });
    game.emit('coin:fell', FELL);
    expect(calls).toEqual(['activity', 'activity', 'activity', 'activity']);
  });

  it('hears the sim settle: falls, fusions and hard strikes move the table, the pusher grinding does not', () => {
    const { sim, calls } = setup();
    sim({ contacts: [contact(ACTIVITY_CONTACT_STRENGTH / 2)] });
    sim({});
    expect(calls).toEqual([]);
    sim({ contacts: [contact(ACTIVITY_CONTACT_STRENGTH)] });
    sim({ falls: [{ coinId: 1, edge: 'front', tick: 2 }] });
    sim({ fusions: [{} as SimEventBatch['fusions'][number]] });
    expect(calls).toEqual(['activity', 'activity', 'activity']);
  });

  it('counts the server naming a coin already on the table as the table moving, so an upload poses it', () => {
    const { table, calls, scheduler, samples } = setup();
    scheduler.advance(SAMPLE_WINDOW_MS * 2);
    const rested = samples();
    table({ type: 'claimSettled', claim: FUSION, result: FUSED });
    table({ type: 'claimsFailed', claims: [FALL, FUSION], error: new Error('offline') });
    table({ type: 'dropSettled', key: newIdempotencyKey(), coin: MINTED, spawnedCrates: [] });
    expect(calls).toEqual(['activity', 'activity', 'activity']);
    expect(samples()).toBe(rested + 1);
  });

  it('leaves server answers that name no coin to the sim events they follow', () => {
    const { table, calls } = setup();
    table({ type: 'claimSettled', claim: FALL, result: PAID });
    table({ type: 'claimsFailed', claims: [FALL], error: new Error('offline') });
    table({ type: 'snapshotSettled', seq: 1, stored: 3, ignored: 0 });
    table({ type: 'status', status: 'synced', pending: 0 });
    expect(calls).toEqual([]);
  });

  it('samples at once, keeps sampling while the table moves and stops once it has rested', () => {
    const { scheduler, game, samples } = setup();
    expect(samples()).toBe(1);
    scheduler.advance(SAMPLE_INTERVAL_MS * 3);
    expect(samples()).toBe(4);
    scheduler.advance(SAMPLE_WINDOW_MS);
    const rested = samples();
    scheduler.advance(SAMPLE_WINDOW_MS);
    expect(samples()).toBe(rested);
    expect(scheduler.timers.size).toBe(0);
    game.emit('coin:fell', FELL);
    expect(samples()).toBe(rested + 1);
    scheduler.advance(SAMPLE_INTERVAL_MS);
    expect(samples()).toBe(rested + 2);
  });

  it('does not sample a hidden page, and picks up again when it is shown', () => {
    const { scheduler, page, samples } = setup();
    page.shown = false;
    scheduler.advance(SAMPLE_INTERVAL_MS * 5);
    const before = samples();
    page.setShown(true);
    expect(samples()).toBe(before + 1);
    scheduler.advance(SAMPLE_INTERVAL_MS);
    expect(samples()).toBe(before + 2);
  });

  it('uploads the latest sample at once when the page is hidden, then again once a fresh one lands', async () => {
    let land: () => void = () => undefined;
    const { page, calls, samples } = setup(
      () =>
        new Promise((resolve) => {
          land = resolve;
        }),
    );
    const before = samples();
    page.setShown(false);
    expect(samples()).toBe(before + 1);
    expect(calls).toEqual(['hidden']);
    land();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(['hidden', 'hidden']);
  });

  it('queues a snapshot before pagehide when the tab closes before the hidden sample lands', async () => {
    let land: () => void = () => undefined;
    const { page, calls } = setup(
      () =>
        new Promise((resolve) => {
          land = resolve;
        }),
    );
    page.setShown(false);
    page.hide();
    expect(calls).toEqual(['hidden', 'pagehide']);
    land();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(['hidden', 'pagehide', 'hidden']);
  });

  it('still uploads the last good sample when the hidden one fails, and reports the failure', async () => {
    const failure = new Error('SimBridge.snapshot: the worker failed');
    const { page, calls, errors } = setup(() => Promise.reject(failure));
    page.setShown(false);
    expect(calls).toEqual(['hidden']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toContain(failure);
  });

  it('hands the queued snapshot to the keepalive when the page goes away', () => {
    const { page, calls } = setup();
    page.hide();
    expect(calls).toEqual(['pagehide']);
  });

  it('stops for good on close: no listener, no timer, the cadence closed, a late failure unreported', async () => {
    let fail: (error: Error) => void = () => undefined;
    const {
      triggers,
      scheduler,
      page,
      game,
      sim,
      table,
      calls,
      errors,
      simListeners,
      tableListeners,
    } = setup(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    triggers.close();
    triggers.close();
    expect(calls).toEqual(['close']);
    expect(scheduler.timers.size).toBe(0);
    expect(simListeners.size).toBe(0);
    expect(tableListeners.size).toBe(0);
    expect(page.visibility.size).toBe(0);
    expect(page.hides.size).toBe(0);
    game.emit('coin:fell', FELL);
    sim({ falls: [{ coinId: 1, edge: 'front', tick: 2 }] });
    table({ type: 'claimSettled', claim: FUSION, result: FUSED });
    expect(calls).toEqual(['close']);
    fail(new Error('SimBridge.snapshot: the bridge was disposed before the reply'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toEqual([]);
  });
});

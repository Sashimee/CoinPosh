import { venues } from '@coinposh/economy';
import type { StateResponse } from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import {
  connectPlayer,
  createMockServer,
  FakeTime,
  requirePlayerId,
} from '../../net/test/harness.ts';
import { createTableRelay, LAY_ATTEMPTS, type TableRelaySteps } from './relay.ts';

interface Sim {
  readonly id: number;
  readonly heap: readonly string[];
  disposed: boolean;
}

/**
 * A table in a page, as main.ts runs it: one sim draws the coins, and play (input, payouts) runs
 * on whichever sim holds the table. The sims here are plain records of what they were laid with.
 */
function pageTable(state: StateResponse, failLays = 0) {
  let next = 0;
  const lay = (from: StateResponse): Sim => ({
    id: next++,
    heap: from.table.coins.map((coin) => coin.id),
    disposed: false,
  });
  let drawing = lay(state);
  let playingOn: Sim | null = drawing;
  let adopted = state;
  let laysLeftToFail = failLays;
  const log: string[] = [];
  const errors: unknown[] = [];
  const discarded: Sim[] = [];
  const steps = (boot: () => Promise<StateResponse>): TableRelaySteps<Sim> => ({
    state,
    hold: () => {
      log.push('hold');
      playingOn = null;
    },
    boot,
    lay: (from) => {
      log.push('lay');
      if (laysLeftToFail > 0) {
        laysLeftToFail -= 1;
        return Promise.reject(new Error('the sim worker could not start'));
      }
      return Promise.resolve(lay(from));
    },
    play: (sim, from) => {
      log.push('play');
      drawing.disposed = true;
      drawing = sim;
      playingOn = sim;
      adopted = from;
    },
    discard: (sim) => {
      sim.disposed = true;
      discarded.push(sim);
    },
    resume: (from, booted) => {
      log.push(booted ? 'resume:booted' : 'resume:held');
      playingOn = drawing;
      adopted = from;
    },
    onError: (error) => errors.push(error),
  });
  return {
    steps,
    log,
    errors,
    discarded,
    get drawing() {
      return drawing;
    },
    get playingOn() {
      return playingOn;
    },
    get adopted() {
      return adopted;
    },
  };
}

async function ascendedDemo() {
  const time = new FakeTime();
  const server = createMockServer({ now: time.now });
  const alice = await connectPlayer(server, time);
  const before = await alice.client.call('state', { query: { hydrate: 'boot' } });
  const player = server.world.player(requirePlayerId(alice));
  if (player === undefined) throw new Error('Expected the mock to hold the player.');
  const venueId = before.venue.id;
  const threshold = venues.find((venue) => venue.id === venueId)?.bullionThreshold;
  if (threshold === undefined) throw new Error(`Expected a threshold for ${venueId}.`);
  player.lifetimeBullion = threshold;
  await alice.client.call('ascend', { body: { venueId } });
  return {
    before,
    boot: () => alice.client.call('state', { query: { hydrate: 'boot' } }),
  };
}

describe('createTableRelay: the table after an ascension', () => {
  it('holds play, boots the new venue and plays it on a fresh sim laid from that boot', async () => {
    const demo = await ascendedDemo();
    const page = pageTable(demo.before);
    const old = page.drawing;
    const relay = createTableRelay(page.steps(demo.boot));

    const fresh = await relay.bootState();
    expect(page.log).toEqual(['hold']);
    expect(page.playingOn).toBeNull();
    expect(page.drawing).toBe(old);
    expect(old.disposed).toBe(false);
    expect(fresh.venue.id).not.toBe(demo.before.venue.id);

    await relay.layTable(fresh);
    expect(page.log).toEqual(['hold', 'lay', 'play']);
    expect(old.disposed).toBe(true);
    expect(page.playingOn).toBe(page.drawing);
    expect(page.drawing.heap).toEqual(fresh.table.coins.map((coin) => coin.id));
    const oldHeap = new Set(old.heap);
    expect(page.drawing.heap.some((id) => oldHeap.has(id))).toBe(false);
    expect(page.adopted).toBe(fresh);
    expect(page.errors).toEqual([]);
  });

  it('holds play once across boot retries', async () => {
    const demo = await ascendedDemo();
    const page = pageTable(demo.before);
    let failures = 2;
    const relay = createTableRelay(
      page.steps(() => {
        if (failures > 0) {
          failures -= 1;
          return Promise.reject(new Error('offline'));
        }
        return demo.boot();
      }),
    );
    await expect(relay.bootState()).rejects.toThrow('offline');
    await expect(relay.bootState()).rejects.toThrow('offline');
    const fresh = await relay.bootState();
    await relay.layTable(fresh);
    expect(page.log).toEqual(['hold', 'lay', 'play']);
  });

  it('re-lays the booted state when the first fresh sim fails, then plays it', async () => {
    const demo = await ascendedDemo();
    const page = pageTable(demo.before, LAY_ATTEMPTS - 1);
    const relay = createTableRelay(page.steps(demo.boot));
    const fresh = await relay.bootState();
    await relay.layTable(fresh);
    expect(page.log).toEqual(['hold', ...Array<string>(LAY_ATTEMPTS).fill('lay'), 'play']);
    expect(page.playingOn).toBe(page.drawing);
    expect(page.adopted).toBe(fresh);
    expect(page.errors).toEqual([]);
  });

  it('puts play back on the old sim under the booted session when no fresh sim starts', async () => {
    const demo = await ascendedDemo();
    const page = pageTable(demo.before, LAY_ATTEMPTS);
    const old = page.drawing;
    const relay = createTableRelay(page.steps(demo.boot));
    const fresh = await relay.bootState();
    await relay.layTable(fresh);
    expect(page.log).toEqual(['hold', ...Array<string>(LAY_ATTEMPTS).fill('lay'), 'resume:booted']);
    expect(page.drawing).toBe(old);
    expect(old.disposed).toBe(false);
    expect(page.playingOn).toBe(old);
    expect(page.adopted).toBe(fresh);
    expect(page.errors).toHaveLength(1);
    expect(String(page.errors[0])).toContain('the sim worker could not start');
  });

  it('puts play back on the old sim from its own state when every boot failed', async () => {
    const demo = await ascendedDemo();
    const page = pageTable(demo.before);
    const old = page.drawing;
    const offline = new Error('offline');
    const relay = createTableRelay(page.steps(() => Promise.reject(offline)));
    await expect(relay.bootState()).rejects.toBe(offline);
    relay.failed(offline);
    expect(page.log).toEqual(['hold', 'resume:held']);
    expect(page.playingOn).toBe(old);
    expect(page.adopted).toBe(demo.before);
    expect(page.errors).toEqual([offline]);

    relay.failed(offline);
    expect(page.log).toEqual(['hold', 'resume:held']);
  });

  it('relays again after a fallback, holding the table it went back to', async () => {
    const demo = await ascendedDemo();
    const page = pageTable(demo.before, LAY_ATTEMPTS);
    const relay = createTableRelay(page.steps(demo.boot));
    await relay.layTable(await relay.bootState());
    await relay.layTable(await relay.bootState());
    expect(page.log).toEqual([
      'hold',
      ...Array<string>(LAY_ATTEMPTS).fill('lay'),
      'resume:booted',
      'hold',
      'lay',
      'play',
    ]);
    expect(page.playingOn).toBe(page.drawing);
  });

  it('discards a sim laid after dispose and refuses to hold play again', async () => {
    const demo = await ascendedDemo();
    const page = pageTable(demo.before);
    const relay = createTableRelay(page.steps(demo.boot));
    const fresh = await relay.bootState();
    const laying = relay.layTable(fresh);
    relay.dispose();
    await laying;
    expect(page.log).toEqual(['hold', 'lay']);
    expect(page.discarded).toHaveLength(1);
    relay.failed(new Error('late'));
    expect(page.errors).toEqual([]);
    await expect(relay.bootState()).rejects.toThrow('disposed');
  });

  it('discards a laid sim that play could not start on, and falls back to the old one', async () => {
    const demo = await ascendedDemo();
    const page = pageTable(demo.before);
    const steps = page.steps(demo.boot);
    const broken = new Error('the HUD plaque is missing');
    const relay = createTableRelay({
      ...steps,
      play: () => {
        throw broken;
      },
    });
    await relay.layTable(await relay.bootState());
    expect(page.discarded).toHaveLength(LAY_ATTEMPTS);
    expect(page.log.at(-1)).toBe('resume:booted');
    expect(page.errors).toEqual([broken]);
  });
});

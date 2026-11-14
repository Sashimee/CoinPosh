import type { FairRotateRequest, FairRotateResponse, FairSeedsResponse } from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import { apiFairData, createPityLog, type FairClient } from './data.ts';

const SEEDS: FairSeedsResponse = {
  active: { serverSeedHash: 'a'.repeat(64), clientSeed: 'mine', nonce: 3 },
  revealed: [],
};
const ROTATED: FairRotateResponse = {
  active: { serverSeedHash: 'b'.repeat(64), clientSeed: 'next', nonce: 0 },
  revealed: {
    serverSeed: 'c'.repeat(64),
    serverSeedHash: 'a'.repeat(64),
    clientSeed: 'mine',
    finalNonce: 3,
    revealedAt: 1,
  },
};

function recordingClient() {
  const calls: { name: string; body?: FairRotateRequest }[] = [];
  const client: FairClient = {
    call(name: 'fairSeeds' | 'fairRotate', input?: { readonly body: FairRotateRequest }) {
      calls.push(input ? { name, body: input.body } : { name });
      return Promise.resolve(name === 'fairSeeds' ? SEEDS : ROTATED);
    },
  } as FairClient;
  return { client, calls };
}

describe('apiFairData', () => {
  it('reads the ledger from GET /v1/fair/seeds', async () => {
    const { client, calls } = recordingClient();
    expect(await apiFairData(client).seeds()).toBe(SEEDS);
    expect(calls).toEqual([{ name: 'fairSeeds' }]);
  });

  it('rotates with the new client seed, or an empty body to keep the current one', async () => {
    const { client, calls } = recordingClient();
    const data = apiFairData(client);
    expect(await data.rotate?.('lucky')).toBe(ROTATED);
    await data.rotate?.(undefined);
    expect(calls).toEqual([
      { name: 'fairRotate', body: { clientSeed: 'lucky' } },
      { name: 'fairRotate', body: {} },
    ]);
  });

  it('exposes pity counts only when the game keeps them', () => {
    const { client } = recordingClient();
    expect(apiFairData(client).pity).toBeUndefined();
    const log = createPityLog();
    log.record('goldSafe', { rare: 4, exquisite: 5, legendary: 6 });
    expect(apiFairData(client, () => log.read()).pity?.()).toEqual({
      goldSafe: { rare: 4, exquisite: 5, legendary: 6 },
    });
  });
});

describe('createPityLog', () => {
  it('keeps the latest counters per source, copied', () => {
    const log = createPityLog();
    const first = { rare: 1, exquisite: 2, legendary: 3 };
    log.record('vaultCrate', first);
    log.record('gacha', { rare: 0, exquisite: 0, legendary: 0 });
    log.record('vaultCrate', { rare: 2, exquisite: 3, legendary: 4 });
    first.rare = 99;
    expect(log.read()).toEqual({
      vaultCrate: { rare: 2, exquisite: 3, legendary: 4 },
      gacha: { rare: 0, exquisite: 0, legendary: 0 },
    });
    expect(log.read().goldSafe).toBeUndefined();
  });
});

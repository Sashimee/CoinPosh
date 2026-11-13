import { describe, expect, it } from 'vitest';
import { FakeTime, connectPlayer } from '../test/harness.ts';
import { DEMO_STORAGE_KEY, decodeDemoBlob, encodeDemoBlob, type MockStorage } from './persist.ts';
import { MOCK_RULES } from './rules.ts';
import { createMockServer } from './server.ts';

/**
 * Calibrated on srv01 (2026-11-13): a median of 0.74 ms for a world of about 310k chars. A mid
 * phone runs it some 5x slower, so 4 ms keeps one save inside a frame there and still trips if
 * a change doubles the cost of encoding.
 */
const SAVE_BUDGET_MS = 4;
const SAMPLES = 15;

class SizedStorage implements MockStorage {
  readonly items = new Map<string, string>();
  lastWriteChars = 0;

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.lastWriteChars = value.length;
    this.items.set(key, value);
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }
}

/** A stored world whose ledger holds the most entries the mock ever keeps in memory. */
async function fullLedgerBlob(time: FakeTime): Promise<string> {
  const storage = new SizedStorage();
  const server = createMockServer({ now: time.now, storage, lifecycle: null });
  const player = await connectPlayer(server, time);
  await player.client.call('state', { query: { hydrate: 'boot' } });
  server.flush();
  const raw = storage.getItem(DEMO_STORAGE_KEY);
  if (raw === null) throw new Error('The played world was never stored.');
  const decoded = decodeDemoBlob(raw);
  if (!decoded.ok) throw new Error(`The played world does not decode: ${decoded.reason}`);
  const world = decoded.world;
  const playerId = world.players[0]?.id;
  if (playerId === undefined) throw new Error('The played world holds no player.');
  const ledger = [...world.ledger];
  let seq = world.nextSeq;
  while (ledger.length + 2 <= MOCK_RULES.ledgerRetained) {
    for (const coins of [1, -1]) {
      ledger.push({
        seq,
        at: time.now(),
        playerId,
        reason: coins > 0 ? 'claim.fall' : 'drop.debit',
        delta: { coins },
        ref: coins > 0 ? `coin_${String(seq).padStart(16, '0')}` : null,
      });
      seq += 1;
    }
  }
  return encodeDemoBlob({ ...world, ledger, nextSeq: seq });
}

describe('Demo persistence main-thread cost', () => {
  it(`encodes and writes a world with a full ${String(MOCK_RULES.ledgerRetained)}-entry ledger within ${String(SAVE_BUDGET_MS)} ms`, async () => {
    const time = new FakeTime();
    const storage = new SizedStorage();
    storage.setItem(DEMO_STORAGE_KEY, await fullLedgerBlob(time));
    const server = createMockServer({
      now: time.now,
      storage,
      lifecycle: null,
      persistDelayMs: 60 * 60_000,
    });
    expect(server.restored).toBe(true);
    const player = await connectPlayer(server, time);
    await player.client.call('state', { query: { hydrate: 'boot' } });
    expect(server.ledger().length).toBeGreaterThanOrEqual(MOCK_RULES.ledgerRetained - 1);

    const costs: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      time.advance(1_000);
      await player.client.call('state');
      const started = performance.now();
      server.flush();
      costs.push(performance.now() - started);
    }
    costs.sort((a, b) => a - b);
    const median = costs[Math.floor(costs.length / 2)] ?? Infinity;
    expect(storage.lastWriteChars, 'each sample wrote the whole world').toBeGreaterThan(250_000);
    expect(median, `save costs ${costs.map((ms) => ms.toFixed(2)).join(', ')} ms`).toBeLessThan(
      SAVE_BUDGET_MS,
    );
  });
});

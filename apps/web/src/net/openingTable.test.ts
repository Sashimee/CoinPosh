import { openingHeap } from '@coinposh/economy';
import {
  CoinIdSchema,
  ENTITY_ID_PREFIXES,
  StateResponseSchema,
  type MintedCoin,
  type StateResponse,
} from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import { openingTableCoins } from './openingTable.ts';
import { FakeTime, connectPlayer, createMockServer } from './test/harness.ts';

function coin(n: number, tier: MintedCoin['tier'], value: number): MintedCoin {
  return {
    id: CoinIdSchema.parse(`${ENTITY_ID_PREFIXES.coin}_${String(n).padStart(20, '0')}`),
    tier,
    value,
  };
}

async function demoState(): Promise<StateResponse> {
  const time = new FakeTime();
  const player = await connectPlayer(createMockServer({ now: time.now }), time);
  return player.client.call('state');
}

describe('openingTableCoins', () => {
  it('lays the heap a live server listed, in its order', async () => {
    const demo = await demoState();
    const heap = Array.from({ length: openingHeap.coins }, (_, i) => coin(i, openingHeap.tier, 5));
    const live = StateResponseSchema.parse({ ...demo, table: { ...demo.table, coins: heap } });
    expect(openingTableCoins(live)).toEqual(heap);
  });

  it('lays an empty table as no heap', async () => {
    const demo = await demoState();
    const live = StateResponseSchema.parse({ ...demo, table: { ...demo.table, coins: [] } });
    expect(openingTableCoins(live)).toEqual([]);
  });

  it('refuses a boot snapshot still holding a coin the sim cannot lay', async () => {
    const demo = await demoState();
    const heap = Array.from({ length: 3 }, (_, i) => coin(i, openingHeap.tier, 5));
    const stranded = coin(3, 'copper', 1);
    const live = StateResponseSchema.parse({
      ...demo,
      table: { ...demo.table, coins: [...heap, stranded] },
    });
    expect(() => openingTableCoins(live)).toThrow(/copper coin .*refundStranded/);
  });

  it('lays the heap the Demo Mode server minted at sign-up', async () => {
    const coins = openingTableCoins(await demoState());
    expect(coins).toHaveLength(openingHeap.coins);
    expect(coins.every((c) => c.tier === openingHeap.tier)).toBe(true);
  });
});

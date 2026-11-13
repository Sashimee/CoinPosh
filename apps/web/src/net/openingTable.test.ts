import { openingHeap } from '@coinposh/economy';
import {
  CoinIdSchema,
  ENTITY_ID_PREFIXES,
  StateResponseSchema,
  type MintedCoin,
  type StateResponse,
} from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import { openingLayout, openingTableCoins } from './openingTable.ts';
import { FakeTime, connectPlayer, createMockServer } from './test/harness.ts';

function coin(n: number, tier: MintedCoin['tier'], value: number): MintedCoin {
  return {
    id: CoinIdSchema.parse(`${ENTITY_ID_PREFIXES.coin}_${String(n).padStart(20, '0')}`),
    tier,
    value,
  };
}

async function demoState(query?: { hydrate: 'boot' }): Promise<StateResponse> {
  const time = new FakeTime();
  const player = await connectPlayer(createMockServer({ now: time.now }), time);
  return player.client.call('state', query === undefined ? undefined : { query });
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

describe('openingLayout', () => {
  it('lays a fresh Demo Mode boot as the opening heap, slot by slot', async () => {
    const boot = await demoState({ hydrate: 'boot' });
    const layout = openingLayout(boot);
    expect(layout.coins).toEqual(boot.table.coins);
    expect(layout.restore.pusherTickInCycle).toBe(0);
    expect(layout.restore.coins).toEqual(
      boot.table.coins.map((c, slot) => ({ kind: 'heapSlot', slot, tier: c.tier })),
    );
    expect(layout.crates).toEqual([]);
  });

  it('turns a stored pose into the sim pose of the coin at that index, at its minted tier', async () => {
    const boot = await demoState({ hydrate: 'boot' });
    const [first, second] = boot.table.coins;
    if (first === undefined || second === undefined) throw new Error('No heap coins.');
    const placed = StateResponseSchema.parse({
      ...boot,
      table: {
        ...boot.table,
        coins: [first, second],
        layout: {
          pusher: { tickInCycle: 42 },
          coins: [
            { kind: 'heapSlot', slot: 7 },
            {
              kind: 'pose',
              pose: [second.id, 100, 160, -9_000, 0, 0, 0, 32_767, 'asleep'],
            },
          ],
          crates: [],
        },
      },
    });
    expect(openingLayout(placed).restore).toEqual({
      pusherTickInCycle: 42,
      coins: [
        { kind: 'heapSlot', slot: 7, tier: first.tier },
        {
          kind: 'pose',
          pose: { id: 1, p: [100, 160, -9_000], q: [0, 0, 0, 32_767], rest: 'asleep' },
          tier: second.tier,
        },
      ],
    });
  });

  it('refuses a state fetched without hydrate=boot', async () => {
    const resumed = await demoState();
    expect(resumed.table.layout).toBeNull();
    expect(() => openingLayout(resumed)).toThrow(/hydrate=boot/);
  });

  it('refuses a layout that does not place every table coin', async () => {
    const boot = await demoState({ hydrate: 'boot' });
    const layout = boot.table.layout;
    if (layout === null || layout === undefined) throw new Error('The boot had no layout.');
    const short: StateResponse = {
      ...boot,
      table: { ...boot.table, layout: { ...layout, coins: layout.coins.slice(1) } },
    };
    expect(StateResponseSchema.safeParse(short).success).toBe(false);
    expect(() => openingLayout(short)).toThrow(/layout places/);
  });
});

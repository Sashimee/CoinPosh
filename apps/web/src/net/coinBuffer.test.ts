import type { CoinId, MintedCoin } from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import { CoinBuffer } from './coinBuffer.ts';

const coin = (n: number): MintedCoin => ({
  id: `coin_${'A'.repeat(15)}${String(n)}` as CoinId,
  tier: 'copper',
  value: 1,
});

describe('CoinBuffer', () => {
  it('hands out server-minted coins oldest first and is empty when dry', () => {
    const buffer = new CoinBuffer();
    expect(buffer.take()).toBeNull();
    buffer.replace([coin(1), coin(2)]);
    expect(buffer.peek()).toEqual(coin(1));
    expect(buffer.take()).toEqual(coin(1));
    expect(buffer.take()).toEqual(coin(2));
    expect(buffer.take()).toBeNull();
    expect(buffer.size).toBe(0);
  });

  it('hides coins spent locally until the server confirms, even if it lists them again', () => {
    const buffer = new CoinBuffer();
    buffer.replace([coin(1), coin(2)]);
    const spent = buffer.take();
    buffer.replace([coin(1), coin(2), coin(3)]);
    expect(buffer.size).toBe(2);
    expect(buffer.spending).toEqual([spent]);
    if (spent === null) throw new Error('Expected a coin.');
    buffer.settle(spent.id);
    expect(buffer.spending).toEqual([]);
  });

  it('drops duplicate IDs from a server list', () => {
    const buffer = new CoinBuffer();
    buffer.replace([coin(1), coin(1), coin(2)]);
    expect(buffer.size).toBe(2);
  });

  it('does not resurrect an abandoned coin; the next server list decides', () => {
    const buffer = new CoinBuffer();
    buffer.replace([coin(1)]);
    buffer.take();
    buffer.abandon(coin(1).id);
    expect(buffer.size).toBe(0);
    buffer.replace([coin(1)]);
    expect(buffer.size).toBe(1);
  });

  it('marks restored spends as spending and removes them from the available list', () => {
    const buffer = new CoinBuffer();
    buffer.replace([coin(1), coin(2)]);
    buffer.markSpending(coin(1));
    expect(buffer.peek()).toEqual(coin(2));
    expect(buffer.spending).toEqual([coin(1)]);
  });
});

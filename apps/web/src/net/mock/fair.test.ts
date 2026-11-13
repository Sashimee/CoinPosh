import { describe, expect, it } from 'vitest';
import {
  DEMO_SEED_GLOBAL,
  cryptoSeedSource,
  newSeed,
  nextRoll,
  resolveSeedSource,
  type FairSeedState,
} from './fair.ts';

const demo = { kind: 'demo' } as const;
const live = { kind: 'live', apiUrl: 'https://api.example.com' } as const;

async function rolls(seed: FairSeedState, count: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push((await nextRoll(seed)).rng.nextUint32());
  return out;
}

describe('Demo seed hook', () => {
  it('replays the same seeds and rolls for the same injected value', async () => {
    const a = await newSeed(undefined, resolveSeedSource({ [DEMO_SEED_GLOBAL]: 'p365' }, demo));
    const b = await newSeed(undefined, resolveSeedSource({ [DEMO_SEED_GLOBAL]: 'p365' }, demo));
    expect(a).toEqual(b);
    expect(a.serverSeed).toMatch(/^[0-9a-f]{64}$/);
    expect(await rolls(a, 8)).toEqual(await rolls(b, 8));
  });

  it('gives different seeds for different values and for each rotation', async () => {
    const source = resolveSeedSource({ [DEMO_SEED_GLOBAL]: 'p365' }, demo);
    const first = await newSeed(undefined, source);
    const second = await newSeed(undefined, source);
    const other = await newSeed(undefined, resolveSeedSource({ [DEMO_SEED_GLOBAL]: 'q' }, demo));
    expect(second.serverSeed).not.toBe(first.serverSeed);
    expect(second.clientSeed).not.toBe(first.clientSeed);
    expect(other.serverSeed).not.toBe(first.serverSeed);
  });

  it('keeps a player-chosen client seed on rotation', async () => {
    const source = resolveSeedSource({ [DEMO_SEED_GLOBAL]: 'p365' }, demo);
    expect((await newSeed('mine', source)).clientSeed).toBe('mine');
  });

  it('keeps crypto randomness with no injected seed', async () => {
    expect(resolveSeedSource({}, demo)).toBe(cryptoSeedSource);
    expect(resolveSeedSource({ [DEMO_SEED_GLOBAL]: undefined }, demo)).toBe(cryptoSeedSource);
    const a = await newSeed(undefined, cryptoSeedSource);
    const b = await newSeed(undefined, cryptoSeedSource);
    expect(a.serverSeed).not.toBe(b.serverSeed);
    expect(a.clientSeed).not.toBe(b.clientSeed);
  });

  it('defaults to crypto seeds in a test run with no hook set', async () => {
    const a = await newSeed();
    const b = await newSeed();
    expect(a.serverSeed).not.toBe(b.serverSeed);
  });

  it('ignores the hook entirely when the API client is real', () => {
    expect(resolveSeedSource({ [DEMO_SEED_GLOBAL]: 'p365' }, live)).toBe(cryptoSeedSource);
    expect(resolveSeedSource({ [DEMO_SEED_GLOBAL]: { evil: true } }, live)).toBe(cryptoSeedSource);
  });

  it.each([
    ['empty', ''],
    ['too long', 'a'.repeat(65)],
    ['punctuation', 'seed;drop'],
    ['whitespace', 'two words'],
    ['number', 42],
    ['object', { serverSeed: 'x' }],
    ['null', null],
  ])('rejects a malformed value (%s) loudly', (_label, value) => {
    expect(() => resolveSeedSource({ [DEMO_SEED_GLOBAL]: value }, demo)).toThrow(DEMO_SEED_GLOBAL);
  });

  it('accepts the boundary lengths', () => {
    expect(resolveSeedSource({ [DEMO_SEED_GLOBAL]: 'a' }, demo)).not.toBe(cryptoSeedSource);
    expect(resolveSeedSource({ [DEMO_SEED_GLOBAL]: 'a'.repeat(64) }, demo)).not.toBe(
      cryptoSeedSource,
    );
  });
});

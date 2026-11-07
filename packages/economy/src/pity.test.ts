import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { economyConfig } from './config/index.ts';
import { initialPityState, rarityRank, rollDrop } from './pity.ts';
import { createRng, type Rng } from './rng.ts';
import type { DropTableDef, PityState, RarityId } from './types.ts';

const { dropTables, pity } = economyConfig;

function rollMany(table: DropTableDef, rng: Rng, opens: number): RarityId[] {
  let state: PityState = initialPityState(pity);
  const out: RarityId[] = [];
  for (let i = 0; i < opens; i++) {
    const roll = rollDrop(table, pity, state, rng);
    state = roll.state;
    out.push(roll.rarity);
  }
  return out;
}

function longestDrought(results: readonly RarityId[], floor: RarityId): number {
  let longest = 0;
  let run = 0;
  for (const rarity of results) {
    run = rarityRank(rarity) >= rarityRank(floor) ? 0 : run + 1;
    longest = Math.max(longest, run);
  }
  return longest;
}

/** A table that almost never rolls above Common, so pity does all the work. */
const stingy: DropTableDef = {
  source: 'vaultCrate',
  pity: true,
  odds: { common: 9_996, fine: 0, rare: 1, exquisite: 1, legendary: 1, heirloom: 1 },
};

describe('rollDrop pity', () => {
  it('starts every counter at zero', () => {
    expect(initialPityState(pity)).toEqual({ rare: 0, exquisite: 0, legendary: 0 });
  });

  it('honours every guarantee window on every shipped table, for any seed', () => {
    fc.assert(
      fc.property(fc.integer(), fc.constantFrom(...dropTables), (seed, table) => {
        const results = rollMany(table, createRng(seed), 400);
        for (const rule of pity.rules) {
          expect(longestDrought(results, rule.rarity)).toBeLessThan(rule.within);
        }
      }),
      { numRuns: 60 },
    );
  });

  it('fires each guarantee exactly on the last open of its window', () => {
    const results = rollMany(stingy, createRng(42), 1_200);
    expect(results[9]).not.toBe('common');
    expect(longestDrought(results, 'rare')).toBe(9);
    for (const rule of pity.rules) {
      expect(longestDrought(results, rule.rarity)).toBeLessThan(rule.within);
    }
  });

  it('forces the floor once a counter reaches within − 1 misses, and not before', () => {
    for (const rule of pity.rules) {
      const due = { rare: 0, exquisite: 0, legendary: 0, [rule.rarity]: rule.within - 1 };
      const early = { ...due, [rule.rarity]: rule.within - 2 };
      expect(rollDrop(stingy, pity, due, createRng(1)).pityFloor).toBe(rule.rarity);
      expect(rollDrop(stingy, pity, early, createRng(1)).pityFloor).toBeNull();
    }
  });

  it('draws forced results from the same table restricted to the floor and above', () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const roll = rollDrop(
          stingy,
          pity,
          { rare: 9, exquisite: 0, legendary: 0 },
          createRng(seed),
        );
        expect(roll.pityFloor).toBe('rare');
        expect(rarityRank(roll.rarity)).toBeGreaterThanOrEqual(rarityRank('rare'));
      }),
    );
  });

  it('picks the highest floor when several windows expire together', () => {
    const roll = rollDrop(stingy, pity, { rare: 9, exquisite: 39, legendary: 50 }, createRng(1));
    expect(roll.pityFloor).toBe('exquisite');
    expect(rarityRank(roll.rarity)).toBeGreaterThanOrEqual(rarityRank('exquisite'));
    const reachedLegendary = rarityRank(roll.rarity) >= rarityRank('legendary');
    expect(roll.state).toEqual({ rare: 0, exquisite: 0, legendary: reachedLegendary ? 0 : 51 });
  });

  it('resets lower counters when a higher rarity lands', () => {
    const always: DropTableDef = {
      ...stingy,
      odds: { common: 0, fine: 0, rare: 0, exquisite: 0, legendary: 10_000, heirloom: 0 },
    };
    const roll = rollDrop(always, pity, { rare: 5, exquisite: 20, legendary: 100 }, createRng(3));
    expect(roll.rarity).toBe('legendary');
    expect(roll.state).toEqual({ rare: 0, exquisite: 0, legendary: 0 });
    expect(roll.pityFloor).toBeNull();
  });

  it('leaves a table without pity to its natural odds', () => {
    const noPity: DropTableDef = { ...stingy, pity: false };
    const roll = rollDrop(
      noPity,
      pity,
      { rare: 500, exquisite: 500, legendary: 500 },
      createRng(9),
    );
    expect(roll.pityFloor).toBeNull();
  });

  it('matches the published odds over many natural rolls', () => {
    const crate = dropTables.find((t) => t.source === 'vaultCrate');
    if (crate === undefined) throw new Error('vaultCrate table missing');
    const natural: DropTableDef = { ...crate, pity: false };
    const rng = createRng(2026);
    const counts: Partial<Record<RarityId, number>> = {};
    const n = 200_000;
    let state: PityState = initialPityState(pity);
    for (let i = 0; i < n; i++) {
      const roll = rollDrop(natural, pity, state, rng);
      state = roll.state;
      counts[roll.rarity] = (counts[roll.rarity] ?? 0) + 1;
    }
    expect((counts.common ?? 0) / n).toBeCloseTo(0.62, 2);
    expect((counts.fine ?? 0) / n).toBeCloseTo(0.25, 2);
    expect((counts.rare ?? 0) / n).toBeCloseTo(0.09, 2);
    expect((counts.exquisite ?? 0) / n).toBeCloseTo(0.03, 2);
  });

  it('refuses to force a floor the table cannot roll', () => {
    const empty: DropTableDef = {
      ...stingy,
      odds: { common: 10_000, fine: 0, rare: 0, exquisite: 0, legendary: 0, heirloom: 0 },
    };
    expect(() => rollDrop(empty, pity, { rare: 9 }, createRng(1))).toThrow(
      /no weight at or above rare/,
    );
  });
});

import { CHARM_KINDS, CharmTypeIdSchema, SYNERGY_TAGS, type CharmKind } from '@coinposh/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ODDS_SCALE } from '../odds.ts';
import type { CharmsConfig } from '../types.ts';
import {
  CHARM_DROP_IDS,
  boostCharmParam,
  charmBoostBp,
  charmEffect,
  charmKindOf,
  charmLevelForCopies,
  charmLoadoutValueCapBp,
  charmMasteryLevel,
  charmSetBonuses,
  charms,
  isCharmDropId,
} from './charms.ts';
import { economyConfig } from './index.ts';
import { questConfig } from './quests.ts';
import { seasonTrack } from './season.ts';

const PER_CHARM_BP = Math.round(economyConfig.rateEnvelope.fallValue.value.perCharm * ODDS_SCALE);
const MAX_SOCKETS = Math.max(...economyConfig.venues.map((v) => v.charmSockets));
const config: CharmsConfig = charms;

/** Every charm catalog id anything in the economy can grant or show as a charm reward. */
function grantableCharmIds(): Set<string> {
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
    } else if (typeof node === 'object' && node !== null) {
      const record = node as Record<string, unknown>;
      if (record.kind === 'charm' && typeof record.charmType === 'string') {
        found.add(record.charmType);
      }
      for (const child of Object.values(record)) walk(child);
    }
  };
  walk(seasonTrack);
  walk(questConfig);
  walk(economyConfig.crateRewards);
  walk(economyConfig.safes);
  for (const set of economyConfig.album) {
    for (const item of set.items) if (item.id.endsWith('Charm')) found.add(item.id);
  }
  for (const id of CHARM_DROP_IDS) found.add(id);
  return found;
}

const kindArb = fc.constantFrom(...CHARM_KINDS);
const levelArb = fc.integer({ min: 1, max: charms.maxLevel });
const masteryArb = fc.integer({ min: 0, max: charms.mastery.maxLevel });
const loadoutArb = fc.array(kindArb, { minLength: 0, maxLength: MAX_SOCKETS });

describe('charm drop ids', () => {
  it('resolves every charm id a drop table, crate, safe, quest, season tier or album grants', () => {
    const ids = [...grantableCharmIds()];
    expect(ids).toEqual(expect.arrayContaining(['captainsBellCharm', ...CHARM_KINDS]));
    for (const id of ids) {
      expect(isCharmDropId(id), id).toBe(true);
      expect(CHARM_KINDS).toContain(charmKindOf(id));
      expect(CharmTypeIdSchema.safeParse(id).success, id).toBe(true);
    }
  });

  it('keeps the album editions and plays each as the kind its theme names', () => {
    expect(charmKindOf('captainsBellCharm')).toBe('butler');
    expect(charmKindOf('champagneBucketCharm')).toBe('brass-bumper');
    expect(charmKindOf('pearlNecklaceCharm')).toBe('magnet-cufflinks');
    for (const kind of CHARM_KINDS) expect(charmKindOf(kind)).toBe(kind);
  });

  it('fails loudly for an id no table grants', () => {
    expect(() => charmKindOf('rubyTiaraCharm')).toThrow(/Unknown charm id "rubyTiaraCharm"/);
    expect(() => charmKindOf('toString')).toThrow(RangeError);
    expect(isCharmDropId('constructor')).toBe(false);
  });

  it('picks a charm on odds that sum to exactly 100 % and grant every kind', () => {
    const weights = Object.values(charms.drops).map((d) => d.weight);
    expect(weights.reduce((a, b) => a + b, 0)).toBe(ODDS_SCALE);
    const byKind = new Map<CharmKind, number>();
    for (const drop of Object.values(charms.drops)) {
      byKind.set(drop.kind, (byKind.get(drop.kind) ?? 0) + drop.weight);
    }
    expect(Object.fromEntries(byKind)).toEqual({
      'golden-peg': 1_500,
      'velvet-ropes': 1_500,
      'magnet-cufflinks': 1_700,
      'brass-bumper': 1_900,
      butler: 1_900,
      'perfume-atomizer': 1_500,
    });
  });
});

describe('charm levels and mastery', () => {
  it('levels on copies at the documented thresholds', () => {
    const expected = [1, 2, 4, 7, 12, 20, 32, 50, 76, 116];
    expected.forEach((copies, i) => {
      expect(charmLevelForCopies(copies)).toBe(i + 1);
      if (i > 0) expect(charmLevelForCopies(copies - 1)).toBe(i);
    });
    expect(charmLevelForCopies(10_000)).toBe(charms.maxLevel);
  });

  it('never drops a level for more copies', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 500 }), fc.integer({ min: 0, max: 500 }), (a, more) => {
        expect(charmLevelForCopies(a + more)).toBeGreaterThanOrEqual(charmLevelForCopies(a));
      }),
    );
  });

  it('rejects copies and activations that are not whole counts', () => {
    expect(() => charmLevelForCopies(0)).toThrow(/copies must be an integer/);
    expect(() => charmLevelForCopies(1.5)).toThrow(RangeError);
    expect(() => charmMasteryLevel(-1)).toThrow(/activations must be an integer/);
  });

  it('masters at 50 × 2^(l − 1) activations, capped at level 10', () => {
    expect(charmMasteryLevel(0)).toBe(0);
    expect(charmMasteryLevel(49)).toBe(0);
    expect(charmMasteryLevel(50)).toBe(1);
    expect(charmMasteryLevel(99)).toBe(1);
    expect(charmMasteryLevel(100)).toBe(2);
    expect(charmMasteryLevel(25_599)).toBe(9);
    expect(charmMasteryLevel(25_600)).toBe(10);
    expect(charmMasteryLevel(Number.MAX_SAFE_INTEGER)).toBe(10);
  });
});

describe('charm set bonuses', () => {
  it('puts every tag on exactly three kinds, so each full set fits the first venue', () => {
    const firstVenueSockets = economyConfig.venues[0].charmSockets;
    for (const tag of SYNERGY_TAGS) {
      const carriers = CHARM_KINDS.filter((k) => config.kinds[k].tags.includes(tag));
      expect(carriers, tag).toHaveLength(3);
      expect(carriers.length).toBeLessThanOrEqual(firstVenueSockets);
      expect(charmSetBonuses(carriers).find((b) => b.tag === tag)?.pieces).toBe(3);
    }
  });

  it('takes the highest tier a tag reaches, counting each kind once', () => {
    expect(charmSetBonuses(['golden-peg'])).toEqual([]);
    expect(charmSetBonuses(['golden-peg', 'brass-bumper'])).toEqual([
      { tag: 'gilded', pieces: 2, effectBoostBp: 1_000, valueBp: 0 },
      { tag: 'kinetic', pieces: 2, effectBoostBp: 1_000, valueBp: 0 },
    ]);
    expect(charmSetBonuses(['butler', 'butler', 'butler'])).toEqual([]);
    const gilded = charmSetBonuses(['golden-peg', 'magnet-cufflinks', 'brass-bumper']);
    expect(gilded.find((b) => b.tag === 'gilded')).toEqual({
      tag: 'gilded',
      pieces: 3,
      effectBoostBp: 2_500,
      valueBp: 200,
    });
  });

  it('caps the set boost one charm takes, with mastery on top', () => {
    const triple = charmSetBonuses([
      'velvet-ropes',
      'magnet-cufflinks',
      'butler',
      'perfume-atomizer',
    ]);
    expect(triple.filter((b) => b.pieces === 3).map((b) => b.tag)).toEqual([
      'magnetic',
      'service',
      'fragrant',
    ]);
    expect(charmBoostBp('butler', 0, triple)).toBe(charms.setBoostCapBp);
    expect(charmBoostBp('butler', 10, triple)).toBe(charms.setBoostCapBp + 2_000);
    expect(charmBoostBp('golden-peg', 3, triple)).toBe(600);
  });
});

describe('charmEffect', () => {
  it('reads the level table, boosting only the boosted parameter', () => {
    expect(charmEffect('brass-bumper', 1)).toEqual({ kickMmPerS: 150, rearmTicks: 45 });
    expect(charmEffect('brass-bumper', 10, { masteryLevel: 10 })).toEqual({
      kickMmPerS: 312,
      rearmTicks: 28,
    });
    expect(charmEffect('butler', 10, { masteryLevel: 10 })).toEqual({
      periodTicks: 375,
      coinsPerSweep: 3,
    });
  });

  it('rounds boosts so they never hand out more than they say', () => {
    expect(boostCharmParam(45, 'more', 2_000)).toBe(54);
    expect(boostCharmParam(7, 'more', 1_000)).toBe(7);
    expect(boostCharmParam(7, 'less', 1_000)).toBe(7);
    expect(boostCharmParam(900, 'less', 5_000)).toBe(600);
  });

  it('rejects levels outside the catalog', () => {
    expect(() => charmEffect('butler', 0)).toThrow(/level must be an integer in \[1, 10\]/);
    expect(() => charmEffect('butler', 11)).toThrow(RangeError);
    expect(() => charmEffect('butler', 1, { masteryLevel: 11 })).toThrow(/masteryLevel/);
  });

  it('returns positive integers that never weaken with level, mastery or set bonuses', () => {
    fc.assert(
      fc.property(kindArb, levelArb, masteryArb, loadoutArb, (kind, level, mastery, loadout) => {
        const sets = charmSetBonuses(loadout);
        const effect: Readonly<Record<string, number>> = charmEffect(kind, level, {
          masteryLevel: mastery,
          setBonuses: sets,
        });
        const plain: Readonly<Record<string, number>> = charmEffect(kind, level);
        for (const [name, param] of Object.entries(config.kinds[kind].params)) {
          const value = effect[name] ?? Number.NaN;
          const base = plain[name] ?? Number.NaN;
          expect(Number.isSafeInteger(value) && value > 0).toBe(true);
          if (param.sense === 'more') expect(value).toBeGreaterThanOrEqual(base);
          else expect(value).toBeLessThanOrEqual(base);
          if (level < charms.maxLevel) {
            const next = (charmEffect(kind, level + 1) as Readonly<Record<string, number>>)[name];
            if (param.sense === 'more') expect(next).toBeGreaterThanOrEqual(base);
            else expect(next).toBeLessThanOrEqual(base);
          }
        }
      }),
    );
  });

  it('is a pure function of its inputs, so the sim and the server agree', () => {
    fc.assert(
      fc.property(kindArb, levelArb, masteryArb, loadoutArb, (kind, level, mastery, loadout) => {
        const mods = { masteryLevel: mastery, setBonuses: charmSetBonuses(loadout) };
        expect(charmEffect(kind, level, mods)).toEqual(charmEffect(kind, level, mods, config));
      }),
    );
  });
});

describe('charm value budget', () => {
  it('never lets a loadout mint more than the rate envelope budgets for its charms', () => {
    fc.assert(
      fc.property(loadoutArb, (loadout) => {
        expect(charmLoadoutValueCapBp(loadout)).toBeLessThanOrEqual(loadout.length * PER_CHARM_BP);
      }),
      { numRuns: 2_000 },
    );
  });

  it('mints only through Golden Pegs and the Gilded set', () => {
    for (const kind of CHARM_KINDS) {
      expect(charms.kinds[kind].valueCapBp).toBe(kind === 'golden-peg' ? PER_CHARM_BP : 0);
    }
    const minting = charms.setBonuses.filter((b) => b.valueBp > 0);
    expect(minting).toEqual([{ tag: 'gilded', pieces: 3, effectBoostBp: 2_500, valueBp: 200 }]);
  });

  it('runs on the sim clock the catalog names', () => {
    expect(charms.tickRateHz).toBe(60);
  });
});

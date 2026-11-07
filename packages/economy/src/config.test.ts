import { describe, expect, it } from 'vitest';
import { economyConfig } from './config/index.ts';
import { ODDS_SCALE, formatPercent, oddsRows, oddsTotal } from './odds.ts';
import { upgradeStat } from './formulas.ts';
import { validateEconomyConfig } from './validate.ts';
import {
  DROP_SOURCE_IDS,
  type DropSourceId,
  type DropTableDef,
  type RarityId,
  type UpgradeLineDef,
} from './types.ts';

/** The published table in docs/plan/02-ECONOMY.md, as the odds sheet shows it (percent). */
const DOC_ODDS: Readonly<Record<DropSourceId, Readonly<Record<RarityId, number>>>> = {
  vaultCrate: { common: 62, fine: 25, rare: 9, exquisite: 3, legendary: 0.95, heirloom: 0.05 },
  goldSafe: { common: 35, fine: 35, rare: 20, exquisite: 7.5, legendary: 2.4, heirloom: 0.1 },
  gacha: { common: 55, fine: 27, rare: 12, exquisite: 4.5, legendary: 1.4, heirloom: 0.1 },
  scratch: { common: 70, fine: 20, rare: 7.5, exquisite: 2, legendary: 0.5, heirloom: 0 },
};

function tableFor(source: DropSourceId): DropTableDef {
  const table = economyConfig.dropTables.find((t) => t.source === source);
  if (table === undefined) throw new Error(`No drop table for ${source}`);
  return table;
}

function offlineLine(): UpgradeLineDef {
  const line = economyConfig.upgradeLines.find((l) => l.effect.stat === 'offlineHours');
  if (line === undefined) throw new Error('No offlineHours upgrade line');
  return line;
}

describe('shipped economy config', () => {
  it('passes the validator with no issues', () => {
    expect(validateEconomyConfig(economyConfig)).toEqual([]);
  });

  it.each(DROP_SOURCE_IDS)('%s odds sum to exactly 100 %%', (source) => {
    expect(oddsTotal(tableFor(source).odds)).toBe(ODDS_SCALE);
  });

  it.each(DROP_SOURCE_IDS)('%s odds sheet rows match the published table', (source) => {
    const shown = Object.fromEntries(
      oddsRows(tableFor(source).odds).map((row) => [row.rarity, row.percent]),
    );
    expect(shown).toEqual(DOC_ODDS[source]);
  });

  it('labels every odds row without rounding away precision', () => {
    for (const row of economyConfig.dropTables.flatMap((t) => oddsRows(t.odds))) {
      expect(Number(formatPercent(row.weight))).toBe(row.percent);
    }
    expect(oddsRows(tableFor('vaultCrate').odds).map((row) => formatPercent(row.weight))).toEqual([
      '62',
      '25',
      '9',
      '3',
      '0.95',
      '0.05',
    ]);
  });

  it('keeps the coin ladder, cascade ladder and pity windows from 02-ECONOMY.md', () => {
    expect(economyConfig.coinTiers.map((t) => t.value)).toEqual([1, 5, 25, 125, 625, 5_000]);
    expect(economyConfig.cascade.tiers.map((t) => t.multiplier)).toEqual([1.1, 1.25, 1.5, 2, 3]);
    expect(economyConfig.cascade.windowMs).toBe(600);
    expect(economyConfig.fusion.bonusMultiplier).toBe(1.25);
    expect(economyConfig.pity.rules).toEqual([
      { rarity: 'rare', within: 10 },
      { rarity: 'exquisite', within: 40 },
      { rarity: 'legendary', within: 120 },
    ]);
    expect(economyConfig.crateSpawn.dropsPerCrate).toBe(40);
    expect(economyConfig.crateSpawn.ftueScriptedDrop).toBe(12);
    expect(economyConfig.offline.activeRateFactor).toBe(0.35);
    expect(economyConfig.bullion.valuePerBullion).toBe(1_000);
  });

  it('lets the offline vault grow from 2 h to exactly 12 h', () => {
    const line = offlineLine();
    expect(upgradeStat(line, 0)).toBe(2);
    expect(upgradeStat(line, line.maxLevel)).toBe(12);
  });

  it('prices every upgrade line inside the growth band', () => {
    for (const line of economyConfig.upgradeLines) {
      expect(line.growth).toBeGreaterThanOrEqual(1.12);
      expect(line.growth).toBeLessThanOrEqual(1.18);
    }
  });
});

describe('shipped config keys', () => {
  const KEY = /^[a-z][a-zA-Z0-9]*([-_.:][a-zA-Z0-9]+)*$/;

  const keys = [
    ...economyConfig.currencies.flatMap((c) => [c.id, ...c.sources, ...c.sinks]),
    ...economyConfig.coinTiers.map((t) => t.id),
    ...economyConfig.cascade.tiers.map((t) => t.id),
    ...economyConfig.upgradeLines.flatMap((l) => [l.id, l.effect.stat]),
    ...economyConfig.dropTables.map((t) => t.source),
    ...economyConfig.venues.map((v) => v.id),
    ...economyConfig.album.flatMap((s) => [s.id, ...s.items.map((i) => i.id)]),
    ...economyConfig.pacing.map((t) => t.id),
  ];

  it.each([...new Set(keys)])('%s matches the config key pattern within 64 characters', (key) => {
    expect(key).toMatch(KEY);
    expect(key.length).toBeLessThanOrEqual(64);
  });
});

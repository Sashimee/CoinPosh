import { crateSpawn, offline, upgradeLines } from './config/index.ts';
import { coinValue, upgradeStat } from './formulas.ts';
import type { CoinTierDef, UpgradeLineDef, UpgradeStatId, VenueDef } from './types.ts';

/**
 * How upgrade levels change play. The authoritative server and the Demo mock both read their
 * effects from here, so a level bought in either mode does the same thing.
 */

/** Upgrade line id → level; a line missing from the map is at level 0. */
export type UpgradeLevelMap = Readonly<Record<string, number>>;

// Products like 1.2 × 5 can land a hair under the integer; that must not cost a coin.
const FLOAT_SLACK = 1e-9;

/** A stat at these levels: the product of every line that grants it (venue × global). */
export function upgradeStatAt(
  levels: UpgradeLevelMap,
  stat: UpgradeStatId,
  lines: readonly UpgradeLineDef[] = upgradeLines,
): number {
  let value: number | null = null;
  for (const line of lines) {
    if (line.effect.stat !== stat) continue;
    const granted = upgradeStat(line, levels[line.id] ?? 0);
    value = value === null ? granted : value * granted;
  }
  if (value === null) throw new RangeError(`No upgrade line grants the ${stat} stat.`);
  return value;
}

/** What a coin of `tier` is worth when minted now: face value × venue × coinValue lines. */
export function mintedCoinValue(
  tier: CoinTierDef,
  venue: VenueDef,
  levels: UpgradeLevelMap,
): number {
  const multiplier =
    venue.coinValueMultiplier *
    upgradeStatAt(levels, 'coinValue') *
    upgradeStatAt(levels, 'globalCoinValue');
  return Math.floor(coinValue(tier, multiplier) + FLOAT_SLACK);
}

/** Drops between Vault Crates: the base spacing shortened by the crateChance lines. */
export function crateSpawnInterval(levels: UpgradeLevelMap): number {
  const chance = upgradeStatAt(levels, 'crateChance') * upgradeStatAt(levels, 'globalCrateChance');
  return Math.max(1, Math.round(crateSpawn.dropsPerCrate / chance));
}

/** Whether the player's `dropCount`-th drop (1-based) spawns a Vault Crate. */
export function dropSpawnsCrate(dropCount: number, levels: UpgradeLevelMap): boolean {
  if (!Number.isSafeInteger(dropCount) || dropCount < 1) {
    throw new RangeError(`dropSpawnsCrate: drop count must be an integer ≥ 1, got ${dropCount}`);
  }
  return dropCount === crateSpawn.ftueScriptedDrop || dropCount % crateSpawnInterval(levels) === 0;
}

/**
 * Pre-paid drop buffer size: `base` coins at dropRate 1, grown with the dropRate stat so the
 * buffer covers the same seconds of play through a network drop when coins leave faster.
 */
export function dropBufferTarget(base: number, levels: UpgradeLevelMap): number {
  if (!Number.isSafeInteger(base) || base < 0) {
    throw new RangeError(`dropBufferTarget: base must be an integer ≥ 0, got ${base}`);
  }
  return Math.ceil(base * upgradeStatAt(levels, 'dropRate') - FLOAT_SLACK);
}

function shortenTicks(name: string, baseTicks: number, speed: number): number {
  if (!Number.isSafeInteger(baseTicks) || baseTicks < 0) {
    throw new RangeError(`${name}: base ticks must be an integer ≥ 0, got ${baseTicks}`);
  }
  if (baseTicks === 0) return 0;
  return Math.max(1, Math.floor(baseTicks / speed + FLOAT_SLACK));
}

/** Fewest sim ticks between two drops: `baseTicks` at dropRate 1, shorter as dropRate rises. */
export function dropSpacingTicks(baseTicks: number, levels: UpgradeLevelMap): number {
  return shortenTicks('dropSpacingTicks', baseTicks, upgradeStatAt(levels, 'dropRate'));
}

/** Fewest sim ticks a coin needs to cross the table: `baseTicks` at pusherSpeed 1, shorter as it rises. */
export function pushTravelTicks(baseTicks: number, levels: UpgradeLevelMap): number {
  return shortenTicks('pushTravelTicks', baseTicks, upgradeStatAt(levels, 'pusherSpeed'));
}

/** Hours of absence the Velvet Vault pays for, clamped to the offline config range. */
export function offlineCapHours(levels: UpgradeLevelMap): number {
  const hours = upgradeStatAt(levels, 'offlineHours');
  return Math.min(Math.max(hours, offline.baseCapHours), offline.maxCapHours);
}

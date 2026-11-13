import { cascade, crateSpawn, offline, upgradeLines } from './config/index.ts';
import { cascadeMultiplier, coinValue, upgradeStat } from './formulas.ts';
import type {
  CascadeConfig,
  CoinTierDef,
  UpgradeLineDef,
  UpgradeStatId,
  VenueDef,
} from './types.ts';

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

/**
 * Minted values are carried in millionths of a coin. Flooring each coin on its own would pay a
 * copper nothing extra until coinValue reaches ×2, so the fraction is carried from one mint to
 * the next instead and a run of coins pays exactly the multiplier.
 */
export const MINT_MICROS_PER_COIN = 1_000_000;

/** A coin of `tier` minted now, in millionths: face value × venue × coinValue lines. */
export function mintedCoinMicros(
  tier: CoinTierDef,
  venue: VenueDef,
  levels: UpgradeLevelMap,
): number {
  const multiplier =
    venue.coinValueMultiplier *
    upgradeStatAt(levels, 'coinValue') *
    upgradeStatAt(levels, 'globalCoinValue');
  return Math.round(coinValue(tier, multiplier) * MINT_MICROS_PER_COIN);
}

/** What one coin of `tier` minted now is worth on its own, before any carried fraction. */
export function mintedCoinValue(
  tier: CoinTierDef,
  venue: VenueDef,
  levels: UpgradeLevelMap,
): number {
  return Math.floor(mintedCoinMicros(tier, venue, levels) / MINT_MICROS_PER_COIN);
}

export interface MintCredit {
  /** Whole coins to credit now. */
  readonly value: number;
  /** The fraction left over, in millionths, to carry into the player's next mint. */
  readonly carry: number;
}

/**
 * Adds `micros` to the player's carried fraction and splits off the whole coins. Over any run
 * of mints the coins credited are the floor of everything minted, so nothing is created or lost
 * beyond less than one coin still in the carry.
 */
export function creditMintMicros(micros: number, carry: number): MintCredit {
  if (!Number.isSafeInteger(micros) || micros < 0) {
    throw new RangeError(`creditMintMicros: micros must be an integer ≥ 0, got ${micros}`);
  }
  if (!Number.isSafeInteger(carry) || carry < 0 || carry >= MINT_MICROS_PER_COIN) {
    throw new RangeError(
      `creditMintMicros: carry must be an integer in [0, ${MINT_MICROS_PER_COIN}), got ${carry}`,
    );
  }
  const total = carry + micros;
  const value = Math.floor(total / MINT_MICROS_PER_COIN);
  return { value, carry: total - value * MINT_MICROS_PER_COIN };
}

/** A coin reserved before it is played: what it was credited and the millionths it was minted at. */
export interface ReservedMint {
  readonly value: number;
  readonly micros: number;
}

/**
 * Re-mints reserved coins, in reservation order, at `micros` each. Each coin is credited only
 * the difference from what it was minted at, through the carry, so repricing never counts the
 * part already minted twice. Coin value never goes down while a coin is reserved.
 */
export function repriceReserved(
  reserved: readonly ReservedMint[],
  micros: number,
  carry: number,
): { readonly reserved: ReservedMint[]; readonly carry: number } {
  let next = carry;
  const repriced = reserved.map((coin) => {
    if (micros < coin.micros) {
      throw new RangeError(
        `repriceReserved: a reserved coin minted at ${coin.micros} millionths cannot drop to ${micros}`,
      );
    }
    const credit = creditMintMicros(micros - coin.micros, next);
    next = credit.carry;
    return { value: coin.value + credit.value, micros };
  });
  return { reserved: repriced, carry: next };
}

/** Front falls in a row, each within the cascade window of the one before. */
export interface CascadeChain {
  readonly lastTick: number;
  readonly count: number;
}

/** Sim ticks the cascade window spans at `ticksPerSecond`. */
export function cascadeWindowTicks(
  ticksPerSecond: number,
  config: CascadeConfig = cascade,
): number {
  if (!Number.isSafeInteger(ticksPerSecond) || ticksPerSecond < 1) {
    throw new RangeError(
      `cascadeWindowTicks: ticks per second must be an integer ≥ 1, got ${ticksPerSecond}`,
    );
  }
  return Math.ceil((config.windowMs * ticksPerSecond) / 1000);
}

/**
 * The chain after a front fall at `tick`: one longer when the fall is at or after the last one
 * and inside the window, else a new chain of one. An earlier tick never extends a chain: the sim
 * restarts at tick 0 on reload, and a forged client could otherwise keep a chain alive forever.
 */
export function extendCascade(
  chain: CascadeChain | null,
  tick: number,
  windowTicks: number,
): CascadeChain {
  const continues =
    chain !== null && chain.lastTick <= tick && tick - chain.lastTick <= windowTicks;
  const count = continues ? chain.count + 1 : 1;
  return { lastTick: tick, count };
}

/** A front fall's credit, in millionths, for a coin of `value` that is the `count`-th of a chain. */
export function cascadeCreditMicros(
  value: number,
  count: number,
  config: CascadeConfig = cascade,
): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`cascadeCreditMicros: value must be an integer ≥ 0, got ${value}`);
  }
  return Math.round(value * cascadeMultiplier(count, config) * MINT_MICROS_PER_COIN);
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

import type {
  AscensionConfig,
  BullionConfig,
  CascadeConfig,
  CascadeTierDef,
  CoinTierDef,
  FusionConfig,
  OfflineConfig,
  UpgradeLineDef,
} from './types.ts';

function assertNonNegativeFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite number ≥ 0, got ${value}`);
  }
}

function assertLevel(line: UpgradeLineDef, level: number, maxInclusive: number): void {
  if (!Number.isInteger(level) || level < 0 || level > maxInclusive) {
    throw new RangeError(
      `Upgrade "${line.id}": level must be an integer in [0, ${maxInclusive}], got ${level}`,
    );
  }
}

/** Price of buying level `level + 1` when the line is at `level`: `ceil(base × growth^level)`. */
export function upgradeCost(line: UpgradeLineDef, level: number): number {
  assertLevel(line, level, line.maxLevel - 1);
  return Math.ceil(line.baseCost * line.growth ** level);
}

/** Total price to take a line from level 0 to `level`. */
export function upgradeCostTotal(line: UpgradeLineDef, level: number): number {
  assertLevel(line, level, line.maxLevel);
  let total = 0;
  for (let l = 0; l < level; l++) total += upgradeCost(line, l);
  return total;
}

export function upgradeStat(line: UpgradeLineDef, level: number): number {
  assertLevel(line, level, line.maxLevel);
  return line.effect.base + line.effect.perLevel * level;
}

export function coinValue(tier: CoinTierDef, multiplier = 1): number {
  assertNonNegativeFinite('coinValue multiplier', multiplier);
  return tier.value * multiplier;
}

/** The fused coin is worth the sum of its inputs times the fusion bonus (the only value it adds). */
export function fusionValue(inputValues: readonly number[], config: FusionConfig): number {
  if (inputValues.length !== config.inputCount) {
    throw new RangeError(
      `fusionValue: expected ${config.inputCount} input coins, got ${inputValues.length}`,
    );
  }
  let sum = 0;
  for (const value of inputValues) {
    assertNonNegativeFinite('fusion input value', value);
    sum += value;
  }
  return sum * config.bonusMultiplier;
}

export function cascadeTierFor(coinCount: number, config: CascadeConfig): CascadeTierDef | null {
  assertNonNegativeFinite('cascade coin count', coinCount);
  let reached: CascadeTierDef | null = null;
  for (const tier of config.tiers) {
    if (coinCount >= tier.minCoins) reached = tier;
  }
  return reached;
}

export function cascadeMultiplier(coinCount: number, config: CascadeConfig): number {
  return cascadeTierFor(coinCount, config)?.multiplier ?? 1;
}

export function bullionFromValue(value: number, config: BullionConfig): number {
  assertNonNegativeFinite('bullion source value', value);
  return Math.floor(value / config.valuePerBullion);
}

/**
 * `floor(sqrt(lifetimeBullion / threshold) × scale)`. Ascending requires the threshold,
 * so anything below it yields 0 rather than a consolation payout.
 */
export function ascensionGoldBars(
  lifetimeBullion: number,
  threshold: number,
  config: AscensionConfig,
): number {
  assertNonNegativeFinite('lifetime bullion', lifetimeBullion);
  if (!(threshold > 0)) throw new RangeError(`Ascension threshold must be > 0, got ${threshold}`);
  if (lifetimeBullion < threshold) return 0;
  return Math.floor(Math.sqrt(lifetimeBullion / threshold) * config.goldBarScale);
}

/** `min(hoursAway, cap) × factor × activeRatePerHour`, with the cap clamped to the config range. */
export function offlineEarnings(
  hoursAway: number,
  capHours: number,
  activeRatePerHour: number,
  config: OfflineConfig,
): number {
  assertNonNegativeFinite('hours away', hoursAway);
  assertNonNegativeFinite('active rate', activeRatePerHour);
  const cap = Math.min(Math.max(capHours, config.baseCapHours), config.maxCapHours);
  return Math.min(hoursAway, cap) * config.activeRateFactor * activeRatePerHour;
}

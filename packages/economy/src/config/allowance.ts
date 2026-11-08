/**
 * The Steward's allowance: the safety net for a player who has poured the whole Vault onto
 * the table before the ledge paid anything back. Defined here rather than in ../types.ts so
 * the rule ships with its numbers; the server (and the Demo mock) apply it to the balance
 * they hold, and the client only ever shows the credit they report.
 */
export interface StewardAllowanceConfig {
  /** The Vault counts as empty below this many coins: the price of one copper drop. */
  readonly emptyBelowCoins: number;
  /** How long the Vault must stay empty before the Steward steps in, so the ledge gets first say. */
  readonly graceSeconds: number;
  /** Coins one allowance credits. */
  readonly coins: number;
  /** Shortest gap between two allowances, measured from the previous credit. */
  readonly cooldownSeconds: number;
  /** Allowances per UTC day; past it an empty Vault waits for the ledge or the offline vault. */
  readonly maxPerDay: number;
}

export const stewardAllowance = {
  emptyBelowCoins: 1,
  graceSeconds: 6,
  coins: 10,
  cooldownSeconds: 120,
  maxPerDay: 20,
} as const satisfies StewardAllowanceConfig;

/** What the server remembers about one player's allowance between balance changes. */
export interface StewardAllowanceState {
  /** Server time the Vault last fell below `emptyBelowCoins`, or null while it holds coins. */
  readonly emptySinceSeconds: number | null;
  /** Server time of the latest allowance, or null if none was ever paid. */
  readonly lastGrantSeconds: number | null;
  /** UTC day (whole days since the epoch) that `grantsToday` counts, or null before the first. */
  readonly day: number | null;
  /** Allowances paid on `day`. */
  readonly grantsToday: number;
}

const SECONDS_PER_DAY = 86_400;

function utcDay(nowSeconds: number): number {
  return Math.floor(nowSeconds / SECONDS_PER_DAY);
}

export const initialStewardAllowanceState: StewardAllowanceState = {
  emptySinceSeconds: null,
  lastGrantSeconds: null,
  day: null,
  grantsToday: 0,
};

/** Tracks when the Vault went empty; call it on every balance change the server makes. */
export function observeStewardVault(
  state: StewardAllowanceState,
  vaultCoins: number,
  nowSeconds: number,
  config: StewardAllowanceConfig = stewardAllowance,
): StewardAllowanceState {
  const empty = vaultCoins < config.emptyBelowCoins;
  if (!empty)
    return state.emptySinceSeconds === null ? state : { ...state, emptySinceSeconds: null };
  if (state.emptySinceSeconds !== null) return state;
  return { ...state, emptySinceSeconds: nowSeconds };
}

/**
 * Server time the next allowance falls due, or null while none can be paid: the Vault holds
 * coins, or the allowances of the UTC day containing `nowSeconds` are spent.
 */
export function stewardAllowanceDueAt(
  state: StewardAllowanceState,
  nowSeconds: number,
  config: StewardAllowanceConfig = stewardAllowance,
): number | null {
  if (state.emptySinceSeconds === null) return null;
  if (state.day === utcDay(nowSeconds) && state.grantsToday >= config.maxPerDay) return null;
  const afterGrace = state.emptySinceSeconds + config.graceSeconds;
  if (state.lastGrantSeconds === null) return afterGrace;
  return Math.max(afterGrace, state.lastGrantSeconds + config.cooldownSeconds);
}

export interface StewardAllowanceGrant {
  /** Coins to credit now; 0 when nothing is due. */
  readonly coins: number;
  readonly state: StewardAllowanceState;
}

/**
 * Pays the allowance if it is due at `nowSeconds`. `vaultCoins` is everything the player can
 * drop (wallet plus pre-paid buffer), as the server holds it, never a client figure.
 */
export function claimStewardAllowance(
  state: StewardAllowanceState,
  vaultCoins: number,
  nowSeconds: number,
  config: StewardAllowanceConfig = stewardAllowance,
): StewardAllowanceGrant {
  if (!Number.isFinite(vaultCoins) || vaultCoins < 0) {
    throw new RangeError(
      `claimStewardAllowance: vaultCoins must be a finite number ≥ 0, got ${vaultCoins}`,
    );
  }
  if (!Number.isFinite(nowSeconds)) {
    throw new RangeError(`claimStewardAllowance: nowSeconds must be finite, got ${nowSeconds}`);
  }
  const observed = observeStewardVault(state, vaultCoins, nowSeconds, config);
  const dueAt = stewardAllowanceDueAt(observed, nowSeconds, config);
  if (dueAt === null || nowSeconds < dueAt) return { coins: 0, state: observed };
  const day = utcDay(nowSeconds);
  return {
    coins: config.coins,
    state: {
      emptySinceSeconds: null,
      lastGrantSeconds: nowSeconds,
      day,
      grantsToday: observed.day === day ? observed.grantsToday + 1 : 1,
    },
  };
}

/** The most coins the allowance can pay per second of play, however a player times going broke. */
export function stewardAllowanceMaxRate(config: StewardAllowanceConfig = stewardAllowance): number {
  return config.coins / Math.max(config.graceSeconds, config.cooldownSeconds);
}

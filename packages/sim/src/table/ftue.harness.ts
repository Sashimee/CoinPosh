import {
  type CascadeChain,
  cascadeCreditMicros,
  cascadeWindowTicks,
  claimStewardAllowance,
  coinTiers,
  creditMintMicros,
  economyConfig,
  extendCascade,
  initialStewardAllowanceState,
  openingHeap,
  upgradeStatAt,
} from '@coinposh/economy';
import { COIN_TIERS } from '@coinposh/shared';
import { TICK_RATE_HZ } from '../constants.ts';
import { MAX_DROP_OFFSET_MM, type SimInput } from '../inputs.ts';
import type { MechanicsConfig } from '../mechanics/index.ts';
import { Xoshiro128ss } from '../prng.ts';
import { Sim } from '../sim.ts';
import { PUSHER } from './layout.ts';

/**
 * P-436 FTUE harness: a new player's opening taps on the Demo opening heap, played on the
 * physics table, with the Vault kept as the Demo server keeps it. Shared by ftue.test.ts (a few
 * tables, in `pnpm check`) and ftue.report.ts (the 20 tables behind 02-ECONOMY "First credit").
 *
 * The Vault starts at the trust fund, each tap costs one copper and is refused below that, a
 * front fall credits its coin's value with the cascade bonus, and the Steward's allowance pays an
 * empty Vault. The first credit is the first front fall the server would credit.
 */

/** The Demo table's seed (apps/web main.ts TABLE_SEED), then 1..19 with the same heap. */
export const FTUE_SEEDS: readonly number[] = Array.from({ length: 20 }, (_, i) =>
  i === 0 ? 0xc0196051 : i,
);

/** The sim worker's mechanics (apps/web simWorker/table-config.ts): fusion on, no tower. */
const WORKER_MECHANICS: MechanicsConfig<string> = {
  tiers: COIN_TIERS,
  fusion: {
    inputCount: economyConfig.fusion.inputCount,
    contactSeconds: economyConfig.fusion.contactSeconds,
  },
  tower: null,
};

/**
 * The web's screen-to-rail map, restated because packages/sim cannot import apps/web: the rail
 * spans the middle DEFAULT_AIM_SPAN of the screen (apps/web/src/game/input/aimMap.ts
 * linearAimMap) and aimToMm scales the aim by MAX_DROP_OFFSET_MM (apps/web/src/game/systems/
 * drops.ts). ftue.test.ts pins the P-436 centre taps (160..220 px of 390) to -34..24 mm with it.
 */
const WEB_AIM_SPAN = 0.8;
export const PHONE_WIDTH_PX = 390;

export function railMmAt(px: number, widthPx: number = PHONE_WIDTH_PX): number {
  const aim = Math.min(1, Math.max(-1, ((px / widthPx) * 2 - 1) / WEB_AIM_SPAN));
  return Math.round(aim * MAX_DROP_OFFSET_MM) || 0;
}

/** Where on a 390 px screen the taps land: P-436's centre taps, or anywhere across it. */
export const TAP_BANDS_PX = {
  centre: [160, 220],
  anywhere: [0, PHONE_WIDTH_PX],
} as const satisfies Record<string, readonly [number, number]>;
export type TapBand = keyof typeof TAP_BANDS_PX;

/**
 * The Demo server's fall checks (apps/web/src/net/mock/world.ts #claim, numbers from
 * apps/web/src/net/mock/rules.ts), restated for the same reason: a dropped coin cannot pay
 * sooner than minFallMsAfterDrop after it spawned, a fused one minFallMsAfterFusion, and at
 * most fallEnvelope.maxPerTick falls a tick and fallEnvelope.max a window are taken. A refused
 * claim credits nothing (over_envelope, P-190).
 */
const SERVER_FALL_RULES = {
  minTicksAfterDrop: (1_500 * TICK_RATE_HZ) / 1000,
  minTicksAfterFusion: (250 * TICK_RATE_HZ) / 1000,
  maxPerTick: 3,
  windowTicks: TICK_RATE_HZ,
  maxPerWindow: 15,
} as const;

const COPPER = coinTiers[0];
const TIER_VALUE = new Map<string, number>(coinTiers.map((tier) => [tier.id, tier.value]));
const CASCADE_WINDOW_TICKS = cascadeWindowTicks(TICK_RATE_HZ);
/** Long past any opening the table has paid on: a run that reaches it never got a credit. */
const GIVE_UP_TICKS = 60 * TICK_RATE_HZ;

export interface OpeningPlan {
  readonly seed: number;
  /** Sim ticks between taps (20 at 3 taps a second). */
  readonly intervalTicks: number;
  readonly band: TapBand;
}

export interface Opening {
  /** Drops made up to and including the tick of the first credit. */
  readonly drops: number;
  /** Taps refused because the Vault held less than one copper. */
  readonly refusedTaps: number;
  /** Null when nothing was credited inside GIVE_UP_TICKS. */
  readonly ticksAfterFirstTap: number | null;
  /** Lowest Vault before the first credit (after each drop, before any credit). */
  readonly minVault: number;
  /** The Vault right after the first credit. */
  readonly vaultAtCredit: number;
  /** Coins the first credit paid. */
  readonly credited: number;
  /** Front falls the server refused before the first credit. */
  readonly refusedFalls: number;
  /** Steward's allowance coins paid before the first credit. */
  readonly allowance: number;
  readonly startingCoins: number;
}

interface CoinRecord {
  readonly tier: string;
  readonly origin: 'heap' | 'drop' | 'fusion';
  readonly spawnTick: number;
}

function minTravelTicks(record: CoinRecord): number {
  if (record.origin === 'drop') return SERVER_FALL_RULES.minTicksAfterDrop;
  if (record.origin === 'fusion') return SERVER_FALL_RULES.minTicksAfterFusion;
  return 0;
}

/**
 * The first tap comes at a seeded point in the pusher cycle: a new player boots at pusher tick
 * 0 and reads the table for an unknown while before tapping.
 */
export async function playOpening(plan: OpeningPlan): Promise<Opening> {
  const taps = Xoshiro128ss.fromSeed((plan.seed ^ 0x5eed) >>> 0);
  const firstTap = taps.nextInt(PUSHER.periodTicks);
  const [minPx, maxPx] = TAP_BANDS_PX[plan.band];
  const startingCoins = upgradeStatAt({}, 'startingCoins');
  const sim = await Sim.create({ seed: plan.seed, mechanics: WORKER_MECHANICS, openingHeap });
  try {
    const coins = new Map<number, CoinRecord>();
    for (const coin of sim.coins()) {
      coins.set(coin.id, { tier: coin.tier ?? openingHeap.tier, origin: 'heap', spawnTick: 0 });
    }
    let vault = startingCoins;
    let minVault = vault;
    let drops = 0;
    let refusedTaps = 0;
    let refusedFalls = 0;
    let allowance = 0;
    let steward = initialStewardAllowanceState;
    let chain: CascadeChain | null = null;
    let carry = 0;
    const recentFalls: number[] = [];

    while (sim.tick < firstTap + GIVE_UP_TICKS) {
      const inputs: SimInput[] = [];
      if (sim.tick >= firstTap && (sim.tick - firstTap) % plan.intervalTicks === 0) {
        const xMm = railMmAt(taps.nextRange(minPx, maxPx));
        if (vault >= COPPER.value) {
          inputs.push({ kind: 'dropCoin', xMm });
          vault -= COPPER.value;
          drops += 1;
          minVault = Math.min(minVault, vault);
        } else {
          refusedTaps += 1;
        }
      }
      const events = sim.step(inputs);
      const tick = sim.tick;
      if (inputs.length > 0) {
        for (const coin of sim.coins()) {
          if (!coins.has(coin.id)) {
            coins.set(coin.id, { tier: coin.tier ?? COPPER.id, origin: 'drop', spawnTick: tick });
          }
        }
      }
      for (const event of events.mechanics) {
        if (event.kind === 'fusion') {
          coins.set(event.fusedId, { tier: event.into, origin: 'fusion', spawnTick: tick });
        }
      }

      let credited = 0;
      let sameTick = 0;
      for (const fall of events.falls) {
        const record = coins.get(fall.coinId);
        if (record === undefined) {
          throw new Error(`Seed ${plan.seed}: coin ${fall.coinId} fell at tick ${tick} unseen.`);
        }
        coins.delete(fall.coinId);
        while (
          recentFalls.length > 0 &&
          (recentFalls[0] ?? tick) <= tick - SERVER_FALL_RULES.windowTicks
        ) {
          recentFalls.shift();
        }
        if (
          tick < record.spawnTick + minTravelTicks(record) ||
          sameTick >= SERVER_FALL_RULES.maxPerTick ||
          recentFalls.length >= SERVER_FALL_RULES.maxPerWindow
        ) {
          if (fall.edge === 'front') refusedFalls += 1;
          continue;
        }
        sameTick += 1;
        recentFalls.push(tick);
        if (fall.edge !== 'front') continue;
        chain = extendCascade(chain, tick, CASCADE_WINDOW_TICKS);
        const value = TIER_VALUE.get(record.tier);
        if (value === undefined) throw new Error(`Seed ${plan.seed}: no tier ${record.tier}.`);
        const credit = creditMintMicros(cascadeCreditMicros(value, chain.count), carry);
        carry = credit.carry;
        credited += credit.value;
      }
      if (credited > 0) {
        vault += credited;
        return {
          drops,
          refusedTaps,
          ticksAfterFirstTap: tick - firstTap,
          minVault,
          vaultAtCredit: vault,
          credited,
          refusedFalls,
          allowance,
          startingCoins,
        };
      }

      const grant = claimStewardAllowance(steward, vault, tick / TICK_RATE_HZ);
      steward = grant.state;
      vault += grant.coins;
      allowance += grant.coins;
    }
    return {
      drops,
      refusedTaps,
      ticksAfterFirstTap: null,
      minVault,
      vaultAtCredit: vault,
      credited: 0,
      refusedFalls,
      allowance,
      startingCoins,
    };
  } finally {
    sim.dispose();
  }
}

/** One plan at a time, so only one physics world is alive at once. */
export async function playOpenings(plans: readonly OpeningPlan[]): Promise<Opening[]> {
  const openings: Opening[] = [];
  for (const plan of plans) openings.push(await playOpening(plan));
  return openings;
}

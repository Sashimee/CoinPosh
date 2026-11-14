import { SYNERGY_TAGS, type CharmKind, type SynergyTag } from '@coinposh/shared';
import type { CharmSetBonusDef, CharmsConfig } from '../types.ts';

const BP = 10_000;

/**
 * The Charm Board catalog (02-ECONOMY.md "Charms"): tags, per-level effect parameters, set
 * bonuses, mastery and the charm drop pool. Every parameter is an integer in the unit its
 * definition names, so the sim reads it as is and replays stay bit-exact.
 */
export const charms = {
  tickRateHz: 60,
  maxLevel: 10,
  copiesToLevel: [1, 2, 4, 7, 12, 20, 32, 50, 76, 116],
  mastery: { maxLevel: 10, activationsBase: 50, growth: 2, effectBpPerLevel: 200 },
  setBoostCapBp: 5_000,
  kinds: {
    'golden-peg': {
      tags: ['gilded', 'kinetic'],
      params: {
        pegs: { unit: 'count', sense: 'more', levels: [2, 2, 2, 2, 2, 2, 2, 2, 2, 2] },
        gildEvery: {
          unit: 'count',
          sense: 'less',
          levels: [20, 19, 18, 17, 16, 15, 14, 13, 13, 12],
        },
        gildBp: {
          unit: 'bp',
          sense: 'more',
          levels: [5_000, 5_500, 6_000, 6_500, 7_000, 7_500, 8_000, 8_500, 9_200, 10_000],
        },
      },
      boosted: 'gildBp',
      valueCapBp: 600,
    },
    'velvet-ropes': {
      tags: ['service', 'magnetic'],
      params: {
        ropeMm: { unit: 'mm', sense: 'more', levels: [24, 26, 28, 30, 32, 34, 36, 38, 40, 42] },
        deflectMmPerS: {
          unit: 'mmPerS',
          sense: 'more',
          levels: [60, 66, 72, 78, 84, 90, 98, 106, 114, 120],
        },
      },
      boosted: 'deflectMmPerS',
      valueCapBp: 0,
    },
    'magnet-cufflinks': {
      tags: ['magnetic', 'gilded', 'fragrant'],
      params: {
        radiusMm: { unit: 'mm', sense: 'more', levels: [30, 32, 34, 36, 38, 40, 42, 44, 46, 48] },
        pullMmPerS: {
          unit: 'mmPerS',
          sense: 'more',
          levels: [40, 44, 48, 52, 56, 60, 66, 72, 78, 84],
        },
        pulseTicks: {
          unit: 'ticks',
          sense: 'less',
          levels: [36, 36, 34, 34, 32, 32, 30, 30, 28, 28],
        },
        pairsPerPulse: { unit: 'count', sense: 'more', levels: [2, 2, 3, 3, 3, 4, 4, 4, 5, 5] },
      },
      boosted: 'pullMmPerS',
      valueCapBp: 0,
    },
    'brass-bumper': {
      tags: ['kinetic', 'gilded'],
      params: {
        kickMmPerS: {
          unit: 'mmPerS',
          sense: 'more',
          levels: [150, 160, 170, 180, 190, 200, 215, 230, 245, 260],
        },
        rearmTicks: {
          unit: 'ticks',
          sense: 'less',
          levels: [45, 44, 42, 40, 38, 36, 34, 32, 30, 28],
        },
      },
      boosted: 'kickMmPerS',
      valueCapBp: 0,
    },
    butler: {
      tags: ['service', 'magnetic', 'fragrant'],
      params: {
        periodTicks: {
          unit: 'ticks',
          sense: 'less',
          levels: [900, 840, 780, 720, 660, 600, 560, 520, 480, 450],
        },
        coinsPerSweep: { unit: 'count', sense: 'more', levels: [1, 1, 1, 2, 2, 2, 2, 3, 3, 3] },
      },
      boosted: 'periodTicks',
      valueCapBp: 0,
    },
    'perfume-atomizer': {
      tags: ['fragrant', 'kinetic', 'service'],
      params: {
        periodTicks: {
          unit: 'ticks',
          sense: 'less',
          levels: [720, 690, 660, 630, 600, 570, 540, 510, 480, 450],
        },
        pushMmPerS: {
          unit: 'mmPerS',
          sense: 'more',
          levels: [100, 108, 116, 124, 132, 140, 150, 160, 170, 180],
        },
        wedgeMm: { unit: 'mm', sense: 'more', levels: [60, 64, 68, 72, 76, 80, 86, 92, 98, 104] },
      },
      boosted: 'pushMmPerS',
      valueCapBp: 0,
    },
  },
  setBonuses: [
    { tag: 'gilded', pieces: 2, effectBoostBp: 1_000, valueBp: 0 },
    { tag: 'gilded', pieces: 3, effectBoostBp: 2_500, valueBp: 200 },
    { tag: 'magnetic', pieces: 2, effectBoostBp: 1_000, valueBp: 0 },
    { tag: 'magnetic', pieces: 3, effectBoostBp: 2_500, valueBp: 0 },
    { tag: 'kinetic', pieces: 2, effectBoostBp: 1_000, valueBp: 0 },
    { tag: 'kinetic', pieces: 3, effectBoostBp: 2_500, valueBp: 0 },
    { tag: 'service', pieces: 2, effectBoostBp: 1_000, valueBp: 0 },
    { tag: 'service', pieces: 3, effectBoostBp: 2_500, valueBp: 0 },
    { tag: 'fragrant', pieces: 2, effectBoostBp: 1_000, valueBp: 0 },
    { tag: 'fragrant', pieces: 3, effectBoostBp: 2_500, valueBp: 0 },
  ],
  // The three editions are album entries (progression.ts) that saved inventories already hold;
  // their ids stay, and each plays as the kind its theme names (02-ECONOMY.md "Charm drops").
  drops: {
    'golden-peg': { kind: 'golden-peg', weight: 1_500 },
    'velvet-ropes': { kind: 'velvet-ropes', weight: 1_500 },
    'magnet-cufflinks': { kind: 'magnet-cufflinks', weight: 1_500 },
    'brass-bumper': { kind: 'brass-bumper', weight: 1_500 },
    butler: { kind: 'butler', weight: 1_500 },
    'perfume-atomizer': { kind: 'perfume-atomizer', weight: 1_500 },
    captainsBellCharm: { kind: 'butler', weight: 400 },
    champagneBucketCharm: { kind: 'brass-bumper', weight: 400 },
    pearlNecklaceCharm: { kind: 'magnet-cufflinks', weight: 200 },
  },
} as const satisfies CharmsConfig;

export type CharmDropId = keyof typeof charms.drops;

type ShippedParams<K extends CharmKind> = (typeof charms.kinds)[K]['params'];

/** One charm's effect parameters at a level, mastery and set boosts applied. */
export type CharmEffect<K extends CharmKind> = { readonly [P in keyof ShippedParams<K>]: number };

export const CHARM_DROP_IDS = Object.keys(charms.drops) as readonly CharmDropId[];

export function isCharmDropId(id: string, config: CharmsConfig = charms): boolean {
  return Object.hasOwn(config.drops, id);
}

/** The kind a charm catalog id plays as; throws for an id no drop table can grant. */
export function charmKindOf(id: string, config: CharmsConfig = charms): CharmKind {
  const drop = Object.hasOwn(config.drops, id) ? config.drops[id] : undefined;
  if (drop === undefined) {
    throw new RangeError(
      `Unknown charm id "${id}"; add it to charms.drops with its kind (02-ECONOMY.md "Charm drops")`,
    );
  }
  return drop.kind;
}

function assertInt(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer in [${min}, ${max}], got ${value}`);
  }
}

/** Charm level for `copies` owned, the first included. */
export function charmLevelForCopies(copies: number, config: CharmsConfig = charms): number {
  assertInt('copies', copies, 1, Number.MAX_SAFE_INTEGER);
  let level = 0;
  for (const needed of config.copiesToLevel) if (copies >= needed) level += 1;
  return level;
}

/** Mastery level (0 until the first threshold) for `activations` the server accepted. */
export function charmMasteryLevel(activations: number, config: CharmsConfig = charms): number {
  assertInt('activations', activations, 0, Number.MAX_SAFE_INTEGER);
  const { maxLevel, activationsBase, growth } = config.mastery;
  let level = 0;
  while (level < maxLevel && activations >= activationsBase * growth ** level) level += 1;
  return level;
}

/**
 * The set bonuses a loadout unlocks: per tag, the largest tier its distinct kinds reach. A
 * kind slotted twice (a kind and its edition) counts once, so repeats never stack a set.
 */
export function charmSetBonuses(
  loadout: readonly CharmKind[],
  config: CharmsConfig = charms,
): readonly CharmSetBonusDef[] {
  const kinds = new Set(loadout);
  const active: CharmSetBonusDef[] = [];
  for (const tag of SYNERGY_TAGS) {
    let pieces = 0;
    for (const kind of kinds) if (config.kinds[kind].tags.includes(tag)) pieces += 1;
    let best: CharmSetBonusDef | undefined;
    for (const bonus of config.setBonuses) {
      if (bonus.tag === tag && bonus.pieces <= pieces && bonus.pieces > (best?.pieces ?? 0)) {
        best = bonus;
      }
    }
    if (best !== undefined) active.push(best);
  }
  return active;
}

/** Basis points added to a charm's boosted parameter: mastery plus its tags' capped set boosts. */
export function charmBoostBp(
  kind: CharmKind,
  masteryLevel: number,
  setBonuses: readonly CharmSetBonusDef[],
  config: CharmsConfig = charms,
): number {
  assertInt('masteryLevel', masteryLevel, 0, config.mastery.maxLevel);
  const tags: readonly SynergyTag[] = config.kinds[kind].tags;
  let set = 0;
  for (const bonus of setBonuses) if (tags.includes(bonus.tag)) set += bonus.effectBoostBp;
  return masteryLevel * config.mastery.effectBpPerLevel + Math.min(set, config.setBoostCapBp);
}

/**
 * Boosts a parameter by `boostBp` in integers: `more` scales up and rounds down, `less` divides
 * the wait and rounds up, so rounding never hands out more than the boost says.
 */
export function boostCharmParam(value: number, sense: 'more' | 'less', boostBp: number): number {
  return sense === 'more'
    ? Math.floor((value * (BP + boostBp)) / BP)
    : Math.ceil((value * BP) / (BP + boostBp));
}

export interface CharmEffectMods {
  readonly masteryLevel?: number;
  /** The loadout's active set bonuses, from {@link charmSetBonuses}. */
  readonly setBonuses?: readonly CharmSetBonusDef[];
}

/**
 * Every effect parameter of `kind` at `level`; only the kind's `boosted` one takes boosts.
 * The result is keyed by the shipped catalog's parameter names.
 */
export function charmEffect<K extends CharmKind>(
  kind: K,
  level: number,
  mods: CharmEffectMods = {},
  config: CharmsConfig = charms,
): CharmEffect<K> {
  assertInt('level', level, 1, config.maxLevel);
  const def = config.kinds[kind];
  const boost = charmBoostBp(kind, mods.masteryLevel ?? 0, mods.setBonuses ?? [], config);
  const effect: Record<string, number> = {};
  for (const [name, param] of Object.entries(def.params)) {
    const base = param.levels[level - 1];
    if (base === undefined) throw new RangeError(`${kind}.${name} has no value at level ${level}`);
    effect[name] = name === def.boosted ? boostCharmParam(base, param.sense, boost) : base;
  }
  return effect as CharmEffect<K>;
}

/**
 * Most extra value a loadout may mint, in basis points of a window's fall value: each slotted
 * charm's `valueCapBp` plus the active set bonuses' `valueBp`.
 */
export function charmLoadoutValueCapBp(
  loadout: readonly CharmKind[],
  config: CharmsConfig = charms,
): number {
  let cap = 0;
  for (const kind of loadout) cap += config.kinds[kind].valueCapBp;
  for (const bonus of charmSetBonuses(loadout, config)) cap += bonus.valueBp;
  return cap;
}

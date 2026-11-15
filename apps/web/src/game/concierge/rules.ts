import { stewardAllowance } from '@coinposh/economy';
import type { CascadeTier, CoinTier, Rarity } from '@coinposh/shared';
import type { AscensionEvents } from '../ascension/events.ts';
import type { CrateEvents } from '../crates/events.ts';
import type { SafeEvents } from '../safes/events.ts';
import type { ScratchEvents } from '../scratch/events.ts';
import type { GameEvents } from '../systems/events.ts';
import type { UpgradeEvents } from '../upgrades/events.ts';
import type { VaultEvents } from '../vault/events.ts';
import type { ConciergeLineId } from './lines.ts';

/** The buses the Concierge listens to, by name. Only `game` is required. */
export interface ConciergeFeedEvents {
  readonly game: GameEvents;
  readonly crates: CrateEvents;
  readonly vault: VaultEvents;
  readonly upgrades: UpgradeEvents;
  readonly safes: SafeEvents;
  readonly scratch: ScratchEvents;
  readonly ascension: AscensionEvents;
}

export type ConciergeFeed = keyof ConciergeFeedEvents;

/** The towers' state as the latest sim snapshot shows it. */
export interface ConciergeTowerView {
  readonly stacked: number;
  /** 0 steady, 1 toppling (`TowerState.risk`). */
  readonly risk: number;
}

/**
 * Player state the rules read when an event arrives. Every number is what the server (or the
 * Demo Mode mock) last reported; a missing reader keeps the rules that need it quiet.
 */
export interface ConciergeState {
  /** The Vault and the coins in hand, as the HUD shows them. */
  readonly vault?: () => { readonly coins: number; readonly inHand: number };
  /** null on a table without a Champagne Tower. */
  readonly tower?: () => ConciergeTowerView | null;
  /** An upgrade line the server balance can pay for right now, or null. */
  readonly affordableUpgrade?: () => string | null;
}

/** What the rules remember between events. One per Concierge; rules may update it. */
export interface ConciergeMemory {
  firstCascadeSeen: boolean;
  firstFusionSeen: boolean;
  cratesSeen: number;
  decorumHigh: boolean;
  gutterFalls: number[];
  lastAffordable: string | null;
  vaultCapped: boolean;
  drops: number;
}

export function freshMemory(): ConciergeMemory {
  return {
    firstCascadeSeen: false,
    firstFusionSeen: false,
    cratesSeen: 0,
    decorumHigh: false,
    gutterFalls: [],
    lastAffordable: null,
    vaultCapped: false,
    drops: 0,
  };
}

export interface ConciergeRuleContext {
  readonly now: number;
  readonly state: ConciergeState;
  readonly memory: ConciergeMemory;
}

export type ConciergeParams = Readonly<Record<string, string | number>>;

export interface ConciergeSuggestion {
  readonly lineId: ConciergeLineId;
  /** Values the copy may interpolate, such as the upgrade line it names. */
  readonly params?: ConciergeParams;
  /** Runs once the line is actually spoken, for a rule that should only remember what was heard. */
  readonly onSaid?: () => void;
}

export interface ConciergeRule<F extends ConciergeFeed, K extends keyof ConciergeFeedEvents[F]> {
  readonly id: string;
  readonly feed: F;
  readonly event: K;
  readonly pick: (
    payload: ConciergeFeedEvents[F][K],
    ctx: ConciergeRuleContext,
  ) => ConciergeSuggestion | null;
}

export type AnyConciergeRule = {
  [F in ConciergeFeed]: {
    [K in keyof ConciergeFeedEvents[F]]: ConciergeRule<F, K>;
  }[keyof ConciergeFeedEvents[F]];
}[ConciergeFeed];

function rule<F extends ConciergeFeed, K extends keyof ConciergeFeedEvents[F]>(spec: {
  readonly id: string;
  readonly feed: F;
  readonly event: K;
  readonly pick: (
    payload: NoInfer<ConciergeFeedEvents[F][K]>,
    ctx: ConciergeRuleContext,
  ) => ConciergeSuggestion | null;
}): NoInfer<ConciergeRule<F, K>> {
  return spec;
}

function say(lineId: ConciergeLineId, params?: ConciergeParams): ConciergeSuggestion {
  return params === undefined ? { lineId } : { lineId, params };
}

/** Decorum past this fraction earns a warning; it re-arms once it drains below the reset. */
export const DECORUM_WARN_FRACTION = 0.75;
export const DECORUM_RESET_FRACTION = 0.5;
/** This many coins lost to the side gutters inside the window, with none paying, earns a tip. */
export const GUTTER_STREAK = 4;
export const GUTTER_WINDOW_MS = 20_000;
/** The feed-the-tower tip waits until the player has found their aim. */
export const TOWER_TIP_AFTER_DROPS = 20;
export const TOWER_TIP_MAX_STACKED = 2;
export const TOWER_WOBBLE_RISK = 0.7;

const CASCADE_LINES: Readonly<Record<CascadeTier, ConciergeLineId>> = {
  chic: 'cascade.chic',
  lavish: 'cascade.lavish',
  opulent: 'cascade.opulent',
  decadent: 'cascade.decadent',
  obscene: 'cascade.obscene',
};

const FUSION_LINES: Readonly<Record<CoinTier, ConciergeLineId | null>> = {
  copper: null,
  silver: 'fusion.minor',
  gold: 'fusion.minor',
  platinum: 'fusion.platinum',
  diamond: 'fusion.diamond',
  heirloom: 'fusion.heirloom',
};

const REWARD_LINES: Readonly<Record<Rarity, ConciergeLineId>> = {
  common: 'reward.modest',
  fine: 'reward.modest',
  rare: 'reward.rare',
  exquisite: 'reward.rare',
  legendary: 'reward.legendary',
  heirloom: 'reward.legendary',
};

function reward(rarity: Rarity): ConciergeSuggestion {
  return say(REWARD_LINES[rarity], { rarity });
}

/**
 * Names an upgrade the moment one becomes affordable, once per line: the FTUE wants the first
 * purchase inside two minutes, and nagging about the same one twice is not service.
 */
function affordable(_payload: unknown, ctx: ConciergeRuleContext): ConciergeSuggestion | null {
  const { memory } = ctx;
  const lineId = ctx.state.affordableUpgrade?.() ?? null;
  if (lineId === null) {
    memory.lastAffordable = null;
    return null;
  }
  if (lineId === memory.lastAffordable) return null;
  return {
    lineId: 'tip.upgradeAffordable',
    params: { upgrade: lineId },
    onSaid: () => {
      memory.lastAffordable = lineId;
    },
  };
}

/** The rule table: which event, read against which state, earns which line. */
export const CONCIERGE_RULES: readonly AnyConciergeRule[] = [
  rule({
    id: 'cascade.obscene',
    feed: 'game',
    event: 'cascade:tier',
    pick: ({ tier }, { memory }) => {
      if (tier !== 'obscene') return null;
      memory.firstCascadeSeen = true;
      return say('cascade.obscene');
    },
  }),
  rule({
    id: 'cascade.end',
    feed: 'game',
    event: 'cascade:end',
    pick: ({ tier, count }, { memory }) => {
      if (tier === null || tier === 'obscene') return null;
      const first = !memory.firstCascadeSeen;
      memory.firstCascadeSeen = true;
      if (first && (tier === 'chic' || tier === 'lavish')) return say('greeting.firstCascade');
      return say(CASCADE_LINES[tier], { count });
    },
  }),
  rule({
    id: 'fusion',
    feed: 'game',
    event: 'coin:fusion',
    pick: ({ tier }, { memory }) => {
      const line = FUSION_LINES[tier];
      if (line === null) return null;
      const first = !memory.firstFusionSeen;
      memory.firstFusionSeen = true;
      return say(first && line === 'fusion.minor' ? 'fusion.first' : line, { tier });
    },
  }),
  rule({
    id: 'pour.perfect',
    feed: 'game',
    event: 'pour:end',
    pick: ({ grade, drops }) => (grade === 'perfect' && drops > 1 ? say('pour.perfect') : null),
  }),
  rule({
    id: 'decorum.warning',
    feed: 'game',
    event: 'decorum:change',
    pick: ({ fraction, frozenSeconds }, { memory }) => {
      if (fraction < DECORUM_RESET_FRACTION) memory.decorumHigh = false;
      if (frozenSeconds > 0 || memory.decorumHigh || fraction < DECORUM_WARN_FRACTION) return null;
      memory.decorumHigh = true;
      return say('decorum.warning');
    },
  }),
  rule({
    id: 'decorum.freeze',
    feed: 'game',
    event: 'concierge:freeze',
    pick: ({ seconds }) => say('decorum.freeze', { seconds }),
  }),
  rule({
    id: 'drop.blocked',
    feed: 'game',
    event: 'drop:blocked',
    pick: ({ reason }, { state }) => {
      if (reason === 'frozen') return say('decorum.stillFrozen');
      if (reason !== 'empty') return null;
      const vault = state.vault?.();
      if (vault && vault.coins + vault.inHand >= stewardAllowance.emptyBelowCoins) return null;
      return say('vault.empty');
    },
  }),
  rule({
    id: 'tip.aimCentre',
    feed: 'game',
    event: 'coin:fell',
    pick: ({ coin, edge }, { now, memory }) => {
      if (coin === null) return null;
      if (edge === 'front') {
        memory.gutterFalls = [];
        return null;
      }
      memory.gutterFalls = [...memory.gutterFalls.filter((at) => now - at < GUTTER_WINDOW_MS), now];
      if (memory.gutterFalls.length < GUTTER_STREAK) return null;
      memory.gutterFalls = [];
      return say('tip.aimCentre');
    },
  }),
  rule({
    id: 'tower',
    feed: 'game',
    event: 'drop:requested',
    pick: (_drop, { state, memory }) => {
      const tower = state.tower?.() ?? null;
      if (tower === null) return null;
      if (tower.risk >= TOWER_WOBBLE_RISK) return say('tower.wobbling');
      if (memory.drops >= TOWER_TIP_AFTER_DROPS && tower.stacked <= TOWER_TIP_MAX_STACKED) {
        return say('tip.feedTower');
      }
      return null;
    },
  }),
  rule({ id: 'affordable.credit', feed: 'game', event: 'value:credited', pick: affordable }),
  rule({ id: 'affordable.vault', feed: 'vault', event: 'vault:collected', pick: affordable }),
  rule({ id: 'affordable.crate', feed: 'crates', event: 'crate:collected', pick: affordable }),
  rule({ id: 'affordable.safe', feed: 'safes', event: 'safe:collected', pick: affordable }),
  rule({ id: 'affordable.scratch', feed: 'scratch', event: 'scratch:collected', pick: affordable }),
  rule({
    id: 'crate.arrived',
    feed: 'crates',
    event: 'crate:spawned',
    pick: ({ resumed }, { memory }) => {
      if (resumed) return null;
      memory.cratesSeen += 1;
      // The first crate of a session already has its own arrival hint (crates/hint.ts).
      return memory.cratesSeen > 1 ? say('crate.arrived') : null;
    },
  }),
  rule({
    id: 'reward.crate',
    feed: 'crates',
    event: 'crate:collected',
    pick: ({ roll }) => reward(roll.rarity),
  }),
  rule({
    id: 'reward.safe',
    feed: 'safes',
    event: 'safe:collected',
    pick: ({ roll }) => reward(roll.rarity),
  }),
  rule({
    id: 'reward.scratch',
    feed: 'scratch',
    event: 'scratch:collected',
    pick: ({ roll }) => reward(roll.rarity),
  }),
  rule({
    id: 'vault.opened',
    feed: 'vault',
    event: 'vault:opened',
    pick: ({ capped }, { memory }) => {
      memory.vaultCapped = capped;
      return null;
    },
  }),
  rule({
    id: 'vault.collected',
    feed: 'vault',
    event: 'vault:collected',
    pick: ({ coins }, { memory }) => {
      if (coins <= 0) return null;
      const capped = memory.vaultCapped;
      memory.vaultCapped = false;
      return say(capped ? 'vault.capped' : 'vault.welcomeBack', { coins });
    },
  }),
  rule({
    id: 'upgrade.purchased',
    feed: 'upgrades',
    event: 'upgrade:purchased',
    pick: ({ lineId, level }, { memory }) => {
      memory.lastAffordable = null;
      return say('upgrade.purchased', { upgrade: lineId, level });
    },
  }),
  rule({
    id: 'ascension.arrived',
    feed: 'ascension',
    event: 'ascension:completed',
    pick: ({ venueId }) => say('ascension.arrived', { venue: venueId }),
  }),
];

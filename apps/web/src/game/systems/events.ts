import type {
  CascadeTier,
  CoinId,
  CoinTier,
  FallEdge,
  InputEvent,
  MintedCoin,
  NudgeDirection,
  Tick,
} from '@coinposh/shared';

/** A point in table space, in metres; vfx turns it into a three.js vector. */
export interface TablePoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export type DropBlockReason = 'frozen' | 'cooldown' | 'empty';
export type NudgeRejectReason = 'frozen' | 'offline' | 'server';
export type PourGrade = 'perfect' | 'early' | 'late';
export type ContactSurface = 'coin' | 'wood' | 'metal';
export type NudgeSource = 'swipe' | 'motion' | 'key';

/**
 * Everything the gameplay glue tells the rest of the game. Values here are provisional unless
 * the event name says `confirmed` or `credited`: those carry what the server answered.
 */
export interface GameEvents {
  'aim:move': { readonly aim: number };
  /** `ordinal` counts drops this session from 1, so the first drop can dismiss the coach mark. */
  'drop:requested': {
    readonly aim: number;
    readonly xMm: number;
    readonly tick: Tick;
    readonly coin: MintedCoin | null;
    readonly ordinal: number;
    readonly first: boolean;
    readonly poured: boolean;
  };
  'drop:confirmed': { readonly coin: MintedCoin };
  /** A dropped coin's first frame in the sim, where the drop trail starts. */
  'coin:spawned': { readonly coin: MintedCoin | null; readonly position: TablePoint };
  'drop:rejected': { readonly coinId: CoinId | null };
  'drop:blocked': { readonly reason: DropBlockReason };
  'pour:start': { readonly aim: number; readonly tick: Tick; readonly targetMs: number };
  'pour:end': {
    readonly grade: PourGrade;
    readonly offsetMs: number;
    readonly heldMs: number;
    readonly drops: number;
    readonly tick: Tick;
  };
  /** A pour abandoned ungraded, as when a second finger turns it into a nudge. */
  'pour:cancel': { readonly drops: number; readonly tick: Tick };
  nudge: {
    readonly direction: NudgeDirection;
    readonly strength: number;
    readonly source: NudgeSource;
    readonly tick: Tick;
  };
  'nudge:rejected': { readonly reason: NudgeRejectReason };
  'decorum:change': {
    readonly used: number;
    readonly capacity: number;
    readonly fraction: number;
    readonly frozenSeconds: number;
  };
  'concierge:freeze': { readonly seconds: number };
  'concierge:thaw': Record<string, never>;
  'coin:contact': {
    readonly position: TablePoint;
    readonly strength: number;
    readonly surface: ContactSurface;
  };
  'coin:fusion': {
    readonly sources: readonly TablePoint[];
    readonly center: TablePoint;
    readonly tier: CoinTier;
    readonly claimed: boolean;
  };
  /** `coin` is null for a coin the server never minted for this table (nothing is claimed). */
  'coin:fell': {
    readonly coin: MintedCoin | null;
    readonly edge: FallEdge;
    readonly position: TablePoint;
    readonly tick: Tick;
  };
  'cascade:step': { readonly count: number; readonly tier: CascadeTier | null };
  'cascade:tier': { readonly tier: CascadeTier; readonly rank: number; readonly count: number };
  'cascade:end': { readonly count: number; readonly tier: CascadeTier | null };
  /** The server's verdict on a chain: the multiplier it applied lives on its side. */
  'cascade:confirmed': { readonly tier: CascadeTier; readonly coinId: CoinId };
  'value:credited': {
    readonly amount: number;
    readonly coinId: CoinId;
    readonly tier: CoinTier | null;
    readonly position: TablePoint | null;
    readonly cascade: CascadeTier | null;
  };
  /** The replay log the audit uploader streams to `/v1/table/inputs`. */
  input: InputEvent;
}

export type GameEventType = keyof GameEvents;

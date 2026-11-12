import {
  dropTables,
  ODDS_SCALE,
  oddsRows,
  oddsTotal,
  pity as pityConfig,
  weightToPercent,
  type OddsRow,
} from '@coinposh/economy';
import {
  commitmentOf,
  fairDigest,
  Sha256HexSchema,
  type DropSourceId,
  type FairProof,
  type PityCounters,
  type Rarity,
  type RevealedSeed,
  type Sha256Hex,
} from '@coinposh/shared';
import { formatDecimal, formatInteger, type Language } from '../../i18n/index.ts';
import { pityOutlook, type PityOutlook } from './loot.ts';

/** The drop table the server rolls when a Vault Crate is opened. */
export const CRATE_DROP_SOURCE = 'vaultCrate' satisfies DropSourceId;

/**
 * Every rarity's share for one drop source, exactly as the economy table the server rolls
 * against lists it. A table that does not add up to 100 % is refused, never rescaled, so the
 * sheet can only ever show the odds the server uses.
 */
export function crateOdds(source: DropSourceId = CRATE_DROP_SOURCE): readonly OddsRow[] {
  const table = dropTables.find((candidate) => candidate.source === source);
  if (table === undefined) {
    throw new RangeError(
      `packages/economy has no drop table for "${source}"; add it to config/drops.ts before showing its odds`,
    );
  }
  const total = oddsTotal(table.odds);
  if (total !== ODDS_SCALE) {
    throw new RangeError(
      `Drop table "${source}" weighs ${total}, not ${ODDS_SCALE}; fix config/drops.ts so its shares add up to 100 %`,
    );
  }
  return oddsRows(table.odds);
}

/** A share as the player reads it, in their locale's digits, without the percent sign. */
export function oddsShare(percent: number, language: Language): string {
  return formatDecimal(percent, language);
}

/** What the listed shares add up to, summed in table weights so no float drift creeps in. */
export function oddsTotalPercent(rows: readonly OddsRow[]): number {
  return weightToPercent(rows.reduce((sum, row) => sum + row.weight, 0));
}

/** One pity guarantee: the server's miss count against the economy's promise. */
export interface PityStep {
  readonly rarity: keyof PityCounters;
  readonly misses: number;
  readonly within: number;
  /** Opens left until this rarity or better is forced; 1 means the next open. */
  readonly left: number;
}

/** Every guarantee the economy makes, filled in with the counters the server returned. */
export function pityLadder(counters: PityCounters): readonly PityStep[] {
  return pityConfig.rules.map((rule) => {
    const misses = counters[rule.rarity];
    if (!Number.isInteger(misses) || misses < 0 || misses >= rule.within) {
      throw new RangeError(
        `Server pity counter for ${rule.rarity} is ${misses}, outside 0..${rule.within - 1}; the roll that should have forced it did not`,
      );
    }
    return { rarity: rule.rarity, misses, within: rule.within, left: rule.within - misses };
  });
}

/** The nonce as the chip and sheet print it, so each crate of a session reads differently. */
export function nonceLabel(proof: Pick<FairProof, 'nonce'>, language: Language): string {
  return formatInteger(proof.nonce, language);
}

export type FairCheck =
  | { readonly status: 'malformed' }
  | { readonly status: 'mismatch'; readonly commitment: Sha256Hex }
  | { readonly status: 'verified'; readonly digest: Sha256Hex };

/**
 * Checks a revealed server seed against the commitment this roll was made under, then derives
 * the roll's `HMAC(serverSeed, clientSeed:nonce)` digest with the shared fair spec, the same
 * one the server rolls with.
 */
export async function verifyRevealedSeed(proof: FairProof, serverSeed: string): Promise<FairCheck> {
  const parsed = Sha256HexSchema.safeParse(serverSeed.trim().toLowerCase());
  if (!parsed.success) return { status: 'malformed' };
  const commitment = await commitmentOf(parsed.data);
  if (commitment !== proof.serverSeedHash) return { status: 'mismatch', commitment };
  return {
    status: 'verified',
    digest: await fairDigest(parsed.data, proof.clientSeed, proof.nonce),
  };
}

/** The revealed seed this roll was spent under, once the server has rotated past it. */
export function revealedSeedFor(
  proof: FairProof,
  revealed: readonly RevealedSeed[],
): RevealedSeed | null {
  return (
    revealed.find(
      (seed) =>
        seed.serverSeedHash === proof.serverSeedHash &&
        seed.clientSeed === proof.clientSeed &&
        proof.nonce < seed.finalNonce,
    ) ?? null
  );
}

/** One part of the sheet: its data, or the error that kept it from being shown. */
export type SheetPart<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: Error };

export interface OddsSheetData {
  readonly rows: SheetPart<readonly OddsRow[]>;
  readonly ladder: SheetPart<readonly PityStep[]>;
}

/**
 * The sheet's odds and guarantees. A broken table or an out-of-range server counter is reported
 * and shown in its own section, never thrown: the sheet only displays, and the reward the server
 * already granted must stay collectable.
 */
export function oddsSheetData(
  pity: PityCounters,
  report: (error: Error) => void = reportSheetError,
): OddsSheetData {
  const part = <T>(read: () => T): SheetPart<T> => {
    try {
      return { ok: true, value: read() };
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      report(error);
      return { ok: false, error };
    }
  };
  return { rows: part(() => crateOdds()), ladder: part(() => pityLadder(pity)) };
}

function reportSheetError(error: Error): void {
  console.error('CoinPosh fairness sheet could not show part of its data.', error);
}

/**
 * The reward card's pity line, or no line when the server's counters break a guarantee: the
 * error is reported, and the card still offers Collect for the reward already granted.
 */
export function cardPityOutlook(
  counters: PityCounters,
  opened: Rarity,
  report: (error: Error) => void = reportSheetError,
): PityOutlook | null {
  try {
    return pityOutlook(counters, opened);
  } catch (cause) {
    report(cause instanceof Error ? cause : new Error(String(cause)));
    return null;
  }
}

/** Where the server's seeds come from; a missing source hides the action that needs it. */
export interface FairSources {
  /** Every seed the server has revealed so far (the fairSeeds endpoint). */
  readonly revealedSeeds?: (() => Promise<readonly RevealedSeed[]>) | undefined;
  /** Retires the active seed and returns it revealed (the fairRotate endpoint). */
  readonly rotateSeed?: (() => Promise<RevealedSeed>) | undefined;
}

export type VerifyState =
  | { readonly status: 'idle' }
  | { readonly status: 'checking' }
  /** The server has not revealed this roll's seed yet: it is still the active one. */
  | { readonly status: 'unrevealed' }
  | { readonly status: 'unavailable' }
  | FairCheck;

/**
 * The verify step of the fairness sheet, apart from the DOM: finds this roll's seed among the
 * revealed ones, reveals it by rotating when the player asks, or checks a pasted one. The latest
 * action always wins over a slower earlier one.
 */
export class FairVerifier {
  readonly #proof: FairProof;
  readonly #sources: FairSources;
  readonly #onChange: (state: VerifyState) => void;
  #state: VerifyState = { status: 'idle' };
  #seed: string | null = null;
  #token = 0;
  #looked = false;
  #disposed = false;

  constructor(
    proof: FairProof,
    sources: FairSources,
    onChange: (state: VerifyState) => void = () => undefined,
  ) {
    this.#proof = proof;
    this.#sources = sources;
    this.#onChange = onChange;
  }

  get state(): VerifyState {
    return this.#state;
  }

  /** The server seed the last lookup or reveal checked, for the sheet to show. */
  get seed(): string | null {
    return this.#seed;
  }

  get canLookUp(): boolean {
    return this.#sources.revealedSeeds !== undefined;
  }

  /**
   * Rotating retires the seed the next crates would roll under, so it is offered only while
   * this roll's seed may still be the active one.
   */
  get canReveal(): boolean {
    if (this.#sources.rotateSeed === undefined) return false;
    const { status } = this.#state;
    return status === 'unrevealed' || (status === 'idle' && !this.canLookUp);
  }

  /** Looks the roll's seed up once; a revealed one is checked straight away. */
  async lookUp(): Promise<void> {
    const revealedSeeds = this.#sources.revealedSeeds;
    if (this.#looked || revealedSeeds === undefined) return;
    this.#looked = true;
    const token = this.#begin();
    let revealed: readonly RevealedSeed[];
    try {
      revealed = await revealedSeeds();
    } catch (error) {
      console.error('CoinPosh could not load the revealed server seeds.', error);
      this.#settle(token, { status: 'unavailable' });
      return;
    }
    const seed = revealedSeedFor(this.#proof, revealed);
    if (seed === null) {
      this.#settle(token, { status: 'unrevealed' });
      return;
    }
    await this.#check(token, seed.serverSeed);
  }

  /** Asks the server to retire the active seed, then checks this roll against it. */
  async reveal(): Promise<void> {
    const rotateSeed = this.#sources.rotateSeed;
    if (!this.canReveal || rotateSeed === undefined) return;
    const token = this.#begin();
    let revealed: RevealedSeed;
    try {
      revealed = await rotateSeed();
    } catch (error) {
      console.error('CoinPosh could not reveal the server seed.', error);
      this.#settle(token, { status: 'unavailable' });
      return;
    }
    await this.#check(token, revealed.serverSeed);
  }

  /** Checks a seed the player pasted. */
  async paste(text: string): Promise<void> {
    await this.#check(this.#begin(), text);
  }

  dispose(): void {
    this.#disposed = true;
  }

  #begin(): number {
    const token = ++this.#token;
    this.#set({ status: 'checking' });
    return token;
  }

  #current(token: number): boolean {
    return token === this.#token && !this.#disposed;
  }

  async #check(token: number, seed: string): Promise<void> {
    if (!this.#current(token)) return;
    const result = await verifyRevealedSeed(this.#proof, seed);
    if (!this.#current(token)) return;
    if (result.status !== 'malformed') this.#seed = seed.trim().toLowerCase();
    this.#set(result);
  }

  #settle(token: number, state: VerifyState): void {
    if (this.#current(token)) this.#set(state);
  }

  #set(state: VerifyState): void {
    this.#state = state;
    this.#onChange(state);
  }
}

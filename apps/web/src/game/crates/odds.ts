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
  type RevealedSeed,
  type Sha256Hex,
} from '@coinposh/shared';
import { formatDecimal, formatInteger, type Language } from '../../i18n/index.ts';

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

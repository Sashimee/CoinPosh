import { dropTables, pity as pityConfig, type OddsRow } from '@coinposh/economy';
import {
  ClientSeedSchema,
  commitmentOf,
  DROP_SOURCE_IDS,
  fairDigest,
  NonceSchema,
  Sha256HexSchema,
  type DropSourceId,
  type FairProof,
  type PityCounters,
  type Rarity,
  type RevealedSeed,
  type Sha256Hex,
} from '@coinposh/shared';
import { crateOdds, pityLadder, revealedSeedFor } from '../../game/crates/odds.ts';

export const FAIR_TABS = ['odds', 'pity', 'verify'] as const;
export type FairTab = (typeof FAIR_TABS)[number];

/** Every source the server rolls a rarity for, in the order the economy lists them. */
export const FAIR_SOURCES: readonly DropSourceId[] = DROP_SOURCE_IDS;

export type Part<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: Error };

export function part<T>(read: () => T): Part<T> {
  try {
    return { ok: true, value: read() };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause : new Error(String(cause)) };
  }
}

/** A share shown as "about 1 in N", rounded to the nearest whole open; none for a zero weight. */
export function oneIn(row: Pick<OddsRow, 'percent'>): number | null {
  if (row.percent <= 0) return null;
  return Math.max(1, Math.round(100 / row.percent));
}

/** One source's odds straight from the table the server rolls; a table off 100 % is refused. */
export function oddsFor(source: DropSourceId): Part<readonly OddsRow[]> {
  return part(() => crateOdds(source));
}

export type PityCountersBySource = Readonly<Partial<Record<DropSourceId, PityCounters>>>;

export interface PityRow {
  readonly rarity: Rarity;
  readonly within: number;
  /** Opens since this rarity or better last landed; null before the first open is seen. */
  readonly misses: number | null;
  /** Opens left until it is forced (1 is the next open); null when the count is unknown. */
  readonly left: number | null;
}

export function hasPity(source: DropSourceId): boolean {
  const table = dropTables.find((candidate) => candidate.source === source);
  if (table === undefined) {
    throw new RangeError(`packages/economy has no drop table for "${source}"`);
  }
  return table.pity;
}

/**
 * The guarantees for one source: the economy's promise, filled in with the server's counters
 * when a roll has reported them. A counter outside its rule throws, so the panel can say so
 * instead of drawing a meter that lies.
 */
export function pityRows(source: DropSourceId, counters: PityCounters | null): readonly PityRow[] {
  if (!hasPity(source)) return [];
  if (counters === null) {
    return pityConfig.rules.map((rule) => ({
      rarity: rule.rarity,
      within: rule.within,
      misses: null,
      left: null,
    }));
  }
  return pityLadder(counters).map((step) => ({
    rarity: step.rarity,
    within: step.within,
    misses: step.misses,
    left: step.left,
  }));
}

export function pityProgress(row: PityRow): number {
  return row.misses === null ? 0 : row.misses / row.within;
}

export const VERIFY_FIELDS = ['serverSeed', 'commitment', 'clientSeed', 'nonce'] as const;
export type VerifyField = (typeof VERIFY_FIELDS)[number];

/** What the player sees in the verify form, as typed. */
export type VerifyInput = Readonly<Record<VerifyField, string>>;

export type MismatchReason = 'commitment' | 'clientSeed' | 'unspent';

export type VerifyResult =
  | { readonly status: 'invalid'; readonly field: VerifyField }
  | {
      readonly status: 'mismatch';
      readonly reason: MismatchReason;
      readonly computed: Sha256Hex;
      readonly digest: Sha256Hex;
    }
  | { readonly status: 'match'; readonly computed: Sha256Hex; readonly digest: Sha256Hex }
  | { readonly status: 'consistent'; readonly computed: Sha256Hex; readonly digest: Sha256Hex };

interface ParsedInput {
  readonly serverSeed: Sha256Hex;
  readonly commitment: Sha256Hex;
  readonly clientSeed: string;
  readonly nonce: number;
}

const DECIMAL = /^\d{1,15}$/;

function parseInput(input: VerifyInput): ParsedInput | VerifyField {
  const serverSeed = Sha256HexSchema.safeParse(input.serverSeed.trim().toLowerCase());
  if (!serverSeed.success) return 'serverSeed';
  const commitment = Sha256HexSchema.safeParse(input.commitment.trim().toLowerCase());
  if (!commitment.success) return 'commitment';
  const clientSeed = ClientSeedSchema.safeParse(input.clientSeed.trim());
  if (!clientSeed.success) return 'clientSeed';
  const rawNonce = input.nonce.trim();
  const nonce = NonceSchema.safeParse(DECIMAL.test(rawNonce) ? Number(rawNonce) : Number.NaN);
  if (!nonce.success) return 'nonce';
  return {
    serverSeed: serverSeed.data,
    commitment: commitment.data,
    clientSeed: clientSeed.data,
    nonce: nonce.data,
  };
}

/**
 * Recomputes one roll on this device with Web Crypto: SHA-256 of the server seed must equal the
 * commitment, and the roll is `HMAC_SHA256(serverSeed, clientSeed:nonce)`. Checked against
 * `published` too when given, so a proof whose client seed or nonce was edited after the reveal
 * cannot pass. Without `published` the best it can say is `consistent`: any made-up seed hashes
 * to its own SHA-256, so only a seed from the server's ledger earns a `match`.
 */
export async function verifyRoll(
  input: VerifyInput,
  published: RevealedSeed | null,
): Promise<VerifyResult> {
  const parsed = parseInput(input);
  if (typeof parsed === 'string') return { status: 'invalid', field: parsed };
  const computed = await commitmentOf(parsed.serverSeed);
  const digest = await fairDigest(parsed.serverSeed, parsed.clientSeed, parsed.nonce);
  const mismatch = (reason: MismatchReason): VerifyResult => ({
    status: 'mismatch',
    reason,
    computed,
    digest,
  });
  if (computed !== parsed.commitment) return mismatch('commitment');
  if (published === null) return { status: 'consistent', computed, digest };
  if (published.serverSeedHash !== parsed.commitment) return mismatch('commitment');
  if (published.clientSeed !== parsed.clientSeed) return mismatch('clientSeed');
  if (parsed.nonce >= published.finalNonce) return mismatch('unspent');
  return { status: 'match', computed, digest };
}

/** The form for roll `nonce` of a revealed seed, exactly as the server published it. */
export function inputFromSeed(seed: RevealedSeed, nonce: number): VerifyInput {
  return {
    serverSeed: seed.serverSeed,
    commitment: seed.serverSeedHash,
    clientSeed: seed.clientSeed,
    nonce: String(nonce),
  };
}

/** A roll's proof with the seed it was spent under, once that seed has been revealed. */
export function inputFromProof(proof: FairProof, seed: RevealedSeed | null): VerifyInput {
  return {
    serverSeed: seed?.serverSeed ?? '',
    commitment: proof.serverSeedHash,
    clientSeed: proof.clientSeed,
    nonce: String(proof.nonce),
  };
}

export function seedForProof(
  proof: FairProof,
  revealed: readonly RevealedSeed[],
): RevealedSeed | null {
  return revealedSeedFor(proof, revealed);
}

/** The last nonce rolled under a seed, or null when it was revealed before any roll. */
export function lastNonce(seed: Pick<RevealedSeed, 'finalNonce'>): number | null {
  return seed.finalNonce > 0 ? seed.finalNonce - 1 : null;
}

/** Steps a nonce by `delta`, kept to the rolls a revealed seed actually made. */
export function stepNonce(seed: Pick<RevealedSeed, 'finalNonce'>, nonce: number, delta: number) {
  const last = lastNonce(seed);
  if (last === null) return 0;
  return Math.min(last, Math.max(0, nonce + delta));
}

export function newestFirst(revealed: readonly RevealedSeed[]): readonly RevealedSeed[] {
  return [...revealed].sort((a, b) => b.revealedAt - a.revealedAt);
}

/** The digest in eight words of eight, the way the verify view sets it in type. */
export function digestWords(digest: Sha256Hex): readonly string[] {
  return digest.match(/.{8}/g) ?? [];
}

/** A long hex value with its middle elided, for a single line on a phone. */
export function shortHex(hex: string, keep = 8): string {
  return hex.length <= keep * 2 + 1 ? hex : `${hex.slice(0, keep)}…${hex.slice(-keep)}`;
}

/** The client seed a rotate sends: none keeps the player's, and a bad one is refused. */
export function nextClientSeed(
  raw: string,
): { ok: true; value: string | undefined } | { ok: false } {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: undefined };
  const parsed = ClientSeedSchema.safeParse(trimmed);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}

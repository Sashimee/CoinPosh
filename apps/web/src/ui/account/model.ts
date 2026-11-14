import type { Account, IdentityProvider, LinkedIdentity } from '@coinposh/shared';
import type { Language } from '../../i18n/index.ts';
import type { ProviderOffer, SessionSwap } from '../../net/index.ts';
import type { AccountKey } from './i18n.ts';

export type AccountMode = 'link' | 'signin';

export type ProviderState = 'demo' | 'live' | 'unavailable';

export interface ProviderRow {
  readonly provider: IdentityProvider;
  readonly state: ProviderState;
}

/**
 * The provider buttons for a mode. Linking leaves out what is already linked; those sit in the
 * linked list with their unlink. A provider is unavailable when this build has no driver for it
 * or the server cannot verify its tokens.
 */
export function providerRows(
  offers: readonly ProviderOffer[],
  account: Account | null,
  mode: AccountMode,
): readonly ProviderRow[] {
  const linked = new Set(account?.identities.map((identity) => identity.provider) ?? []);
  return offers
    .filter((offer) => mode === 'signin' || !linked.has(offer.provider))
    .map((offer) => {
      const verifiable = account === null || account.available.includes(offer.provider);
      const state: ProviderState =
        !offer.available || !verifiable ? 'unavailable' : offer.demo ? 'demo' : 'live';
      return { provider: offer.provider, state };
    });
}

export function linkedIdentities(account: Account | null): readonly LinkedIdentity[] {
  return account?.identities ?? [];
}

export function isLastIdentity(account: Account | null, provider: IdentityProvider): boolean {
  const identities = linkedIdentities(account);
  return identities.length === 1 && identities[0]?.provider === provider;
}

export type AccountProblem =
  | {
      readonly kind:
        'cancelled' | 'inUse' | 'notLinked' | 'invalidToken' | 'unavailable' | 'offline' | 'failed';
    }
  | { readonly kind: 'swapFailed'; readonly retry: () => Promise<SessionSwap> };

interface NamedError {
  readonly name?: unknown;
  readonly code?: unknown;
  readonly retry?: unknown;
}

/**
 * Sorts a failed account call into what the player is told. The error classes live in the
 * lazily loaded account module, so they are told apart by `name`, never by `instanceof`.
 */
export function accountProblem(error: unknown): AccountProblem {
  if (typeof error !== 'object' || error === null) return { kind: 'failed' };
  const { name, code, retry } = error as NamedError;
  switch (name) {
    case 'SignInCancelledError':
    case 'AbortError':
      return { kind: 'cancelled' };
    case 'IdentityProviderError':
      return { kind: 'unavailable' };
    case 'NetworkError':
      return { kind: 'offline' };
    case 'SessionSwapError':
      return typeof retry === 'function'
        ? { kind: 'swapFailed', retry: retry as () => Promise<SessionSwap> }
        : { kind: 'failed' };
    case 'AccountRequestError':
      if (code === 'identity_in_use') return { kind: 'inUse' };
      if (code === 'not_found') return { kind: 'notLinked' };
      if (code === 'invalid_id_token') return { kind: 'invalidToken' };
      if (code === 'provider_unavailable') return { kind: 'unavailable' };
      return { kind: 'failed' };
    default:
      return { kind: 'failed' };
  }
}

export function problemKey(problem: AccountProblem): AccountKey {
  return `status.${problem.kind}`;
}

const CALM_PROBLEMS: ReadonlySet<AccountProblem['kind']> = new Set([
  'cancelled',
  'unavailable',
  'notLinked',
]);

/**
 * A cancel, an unavailable provider or a sign-in with no save linked yet is not the player's
 * fault: the line stays calm.
 */
export function problemTone(problem: AccountProblem): 'calm' | 'warn' {
  return CALM_PROBLEMS.has(problem.kind) ? 'calm' : 'warn';
}

export const PROMPT_STORAGE_KEY = 'coinposh.account.prompt.v1';
export const PROMPT_PLAYTIME_MS = 2 * 60 * 60 * 1000;
/** A tick longer than this (a sleeping laptop, a frozen tab) counts as this much play. */
export const PROMPT_MAX_TICK_MS = 60_000;

export type PromptReason = 'ascension' | 'playtime';
export type PromptTrigger = 'ascension' | 'tick';

export interface PromptRecord {
  readonly playedMs: number;
  /** The one prompt this device was shown; the prompt never comes back after it. */
  readonly shown: PromptReason | null;
}

export const FRESH_PROMPT: PromptRecord = { playedMs: 0, shown: null };

/** `null` when the stored record is not one this version wrote. */
export function parsePromptRecord(raw: string | null): PromptRecord | null {
  if (raw === null) return FRESH_PROMPT;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { playedMs, shown } = value as { playedMs?: unknown; shown?: unknown };
  if (typeof playedMs !== 'number' || !Number.isFinite(playedMs) || playedMs < 0) return null;
  if (shown !== null && shown !== 'ascension' && shown !== 'playtime') return null;
  return { playedMs, shown };
}

export function addPlay(record: PromptRecord, elapsedMs: number): PromptRecord {
  const step = Math.min(Math.max(elapsedMs, 0), PROMPT_MAX_TICK_MS);
  return { ...record, playedMs: record.playedMs + step };
}

/** The prompt shows once per device, after the first ascension or two hours of play. */
export function promptReason(
  record: PromptRecord,
  trigger: PromptTrigger,
  linked: boolean,
): PromptReason | null {
  if (linked || record.shown !== null) return null;
  if (trigger === 'ascension') return 'ascension';
  return record.playedMs >= PROMPT_PLAYTIME_MS ? 'playtime' : null;
}

const RELATIVE_UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600 * 1000],
  ['month', 30 * 24 * 3600 * 1000],
  ['week', 7 * 24 * 3600 * 1000],
  ['day', 24 * 3600 * 1000],
  ['hour', 3600 * 1000],
  ['minute', 60 * 1000],
];

/** "5 minutes ago", "yesterday"; anything under a minute reads as now. */
export function relativeWhen(at: number, now: number, language: Language): string {
  const format = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  const delta = at - now;
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(delta) >= size) return format.format(Math.round(delta / size), unit);
  }
  return format.format(0, 'second');
}

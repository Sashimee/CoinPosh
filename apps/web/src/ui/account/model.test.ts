import type { Account } from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import type { ProviderOffer } from '../../net/index.ts';
import {
  accountProblem,
  addPlay,
  FRESH_PROMPT,
  isLastIdentity,
  parsePromptRecord,
  problemKey,
  problemTone,
  PROMPT_MAX_TICK_MS,
  PROMPT_PLAYTIME_MS,
  promptReason,
  providerRows,
  relativeWhen,
} from './model.ts';

const demoOffers: readonly ProviderOffer[] = [
  { provider: 'google', available: true, demo: true },
  { provider: 'apple', available: true, demo: true },
];

function account(partial: Partial<Account> = {}): Account {
  return {
    playerId: 'p_guest' as Account['playerId'],
    identities: [],
    available: ['google', 'apple'],
    ...partial,
  };
}

function named(name: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(name), { name, ...extra });
}

describe('providerRows', () => {
  it('offers both fake providers in Demo Mode, before the account is known', () => {
    expect(providerRows(demoOffers, null, 'link')).toEqual([
      { provider: 'google', state: 'demo' },
      { provider: 'apple', state: 'demo' },
    ]);
  });

  it('leaves linked providers out of linking but keeps them for signing in', () => {
    const linked = account({ identities: [{ provider: 'google', linkedAt: 1 }] });
    expect(providerRows(demoOffers, linked, 'link').map((row) => row.provider)).toEqual(['apple']);
    expect(providerRows(demoOffers, linked, 'signin').map((row) => row.provider)).toEqual([
      'google',
      'apple',
    ]);
  });

  it('marks a provider unavailable when the build has no driver for it', () => {
    const live: readonly ProviderOffer[] = [
      { provider: 'google', available: false, demo: false },
      { provider: 'apple', available: true, demo: false },
    ];
    expect(providerRows(live, account(), 'link')).toEqual([
      { provider: 'google', state: 'unavailable' },
      { provider: 'apple', state: 'live' },
    ]);
  });

  it('marks a provider unavailable when the server cannot verify it', () => {
    const live: readonly ProviderOffer[] = [{ provider: 'google', available: true, demo: false }];
    expect(providerRows(live, account({ available: [] }), 'signin')).toEqual([
      { provider: 'google', state: 'unavailable' },
    ]);
  });
});

describe('isLastIdentity', () => {
  it('is true only for the one remaining identity', () => {
    const one = account({ identities: [{ provider: 'apple', linkedAt: 1 }] });
    const two = account({
      identities: [
        { provider: 'apple', linkedAt: 1 },
        { provider: 'google', linkedAt: 2 },
      ],
    });
    expect(isLastIdentity(one, 'apple')).toBe(true);
    expect(isLastIdentity(one, 'google')).toBe(false);
    expect(isLastIdentity(two, 'apple')).toBe(false);
    expect(isLastIdentity(null, 'apple')).toBe(false);
  });
});

describe('accountProblem', () => {
  it('reads the server error codes', () => {
    expect(accountProblem(named('AccountRequestError', { code: 'identity_in_use' })).kind).toBe(
      'inUse',
    );
    expect(accountProblem(named('AccountRequestError', { code: 'invalid_id_token' })).kind).toBe(
      'invalidToken',
    );
    expect(
      accountProblem(named('AccountRequestError', { code: 'provider_unavailable' })).kind,
    ).toBe('unavailable');
    expect(accountProblem(named('AccountRequestError', { code: 'rate_limited' })).kind).toBe(
      'failed',
    );
  });

  it('tells a sign-in with no linked save apart from a failure, calmly', () => {
    const problem = accountProblem(named('AccountRequestError', { code: 'not_found' }));
    expect(problem.kind).toBe('notLinked');
    expect(problemTone(problem)).toBe('calm');
    expect(problemKey(problem)).toBe('status.notLinked');
    expect(accountProblem(named('NetworkError', { code: 'not_found' })).kind).toBe('offline');
  });

  it('keeps cancels and missing SDKs calm', () => {
    for (const error of [
      named('SignInCancelledError'),
      named('AbortError'),
      named('IdentityProviderError', { code: 'provider_unavailable' }),
    ]) {
      expect(problemTone(accountProblem(error))).toBe('calm');
    }
    expect(problemTone(accountProblem(named('NetworkError')))).toBe('warn');
  });

  it('hands back the retry of a half-finished session swap', () => {
    const retry = () => Promise.reject(new Error('not reached'));
    const problem = accountProblem(named('SessionSwapError', { retry }));
    expect(problem.kind).toBe('swapFailed');
    if (problem.kind === 'swapFailed') expect(problem.retry).toBe(retry);
    expect(accountProblem(named('SessionSwapError')).kind).toBe('failed');
  });

  it('treats anything else as a plain failure', () => {
    expect(accountProblem(new TypeError('boom')).kind).toBe('failed');
    expect(accountProblem('boom').kind).toBe('failed');
    expect(accountProblem(null).kind).toBe('failed');
    expect(problemKey(accountProblem(null))).toBe('status.failed');
  });
});

describe('the gentle prompt', () => {
  it('asks after the first ascension, once', () => {
    expect(promptReason(FRESH_PROMPT, 'ascension', false)).toBe('ascension');
    expect(promptReason({ ...FRESH_PROMPT, shown: 'ascension' }, 'ascension', false)).toBeNull();
    expect(promptReason({ ...FRESH_PROMPT, shown: 'playtime' }, 'ascension', false)).toBeNull();
  });

  it('asks after two hours of play and not a minute before', () => {
    const almost = { playedMs: PROMPT_PLAYTIME_MS - 1, shown: null };
    expect(promptReason(almost, 'tick', false)).toBeNull();
    expect(promptReason(addPlay(almost, 1), 'tick', false)).toBe('playtime');
  });

  it('never asks a linked player', () => {
    expect(promptReason(FRESH_PROMPT, 'ascension', true)).toBeNull();
    expect(promptReason({ playedMs: PROMPT_PLAYTIME_MS, shown: null }, 'tick', true)).toBeNull();
  });

  it('counts a long gap between ticks as one capped tick, and never counts backwards', () => {
    expect(addPlay(FRESH_PROMPT, 10 * 60_000).playedMs).toBe(PROMPT_MAX_TICK_MS);
    expect(addPlay(FRESH_PROMPT, -5_000).playedMs).toBe(0);
  });

  it('reads back only records it wrote', () => {
    expect(parsePromptRecord(null)).toEqual(FRESH_PROMPT);
    expect(parsePromptRecord('{"playedMs":42,"shown":"playtime"}')).toEqual({
      playedMs: 42,
      shown: 'playtime',
    });
    for (const raw of [
      'not json',
      '[]',
      'null',
      '{"playedMs":-1,"shown":null}',
      '{"playedMs":"1","shown":null}',
      '{"playedMs":1,"shown":"wall"}',
      '{"playedMs":1}',
    ]) {
      expect(parsePromptRecord(raw)).toBeNull();
    }
  });
});

describe('relativeWhen', () => {
  const now = Date.UTC(2026, 10, 14, 12);

  it('names the largest whole unit in each language', () => {
    expect(relativeWhen(now - 5 * 60_000, now, 'en')).toBe('5 minutes ago');
    expect(relativeWhen(now - 24 * 3600_000, now, 'en')).toBe('yesterday');
    expect(relativeWhen(now - 2 * 24 * 3600_000, now, 'fr')).toBe('avant-hier');
    expect(relativeWhen(now - 2 * 3600_000, now, 'de')).toBe('vor 2 Stunden');
  });

  it('reads anything under a minute as now', () => {
    expect(relativeWhen(now - 10_000, now, 'en')).toBe('now');
    expect(relativeWhen(now + 10_000, now, 'en')).toBe('now');
  });
});

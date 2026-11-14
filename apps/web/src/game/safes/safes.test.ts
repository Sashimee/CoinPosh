import { safes as safesConfig, safeTypeDef } from '@coinposh/economy';
import {
  IdempotencyKeySchema,
  SafeIdSchema,
  SafeOpenResponseSchema,
  SafeSchema,
  type IdempotencyKey,
  type Safe,
  type SafeOpenRequest,
  type SafeOpenResponse,
} from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import { createBus } from '../../app/bus.ts';
import { createI18n, LANGUAGES, type ResourceTree } from '../../i18n/index.ts';
import { classifySafeRejection, createSafesController, type SafesApi } from './controller.ts';
import {
  formatCountdown,
  msToFirstReady,
  msToNextSecond,
  readyCount,
  safeCountdown,
} from './countdown.ts';
import type { SafeEvents } from './events.ts';
import { registerSafesStrings, SAFES_STRINGS, safesKey, safeTypeKey } from './i18n.ts';
import { provisionalKeys, safeActions } from './plan.ts';

const GOLD = safeTypeDef('gold');
const UNLOCK_MS = GOLD.unlockSeconds * 1_000;
const NOW = 1_800_000_000_000;

function safe(id: string, unlocksAt: number): Safe {
  return SafeSchema.parse({
    id: SafeIdSchema.parse(`safe_${id.padEnd(16, 'A')}`),
    type: 'gold',
    unlocksAt,
  });
}

function response(safeId: Safe['id'], keys: number): SafeOpenResponse {
  return SafeOpenResponseSchema.parse({
    safeId,
    roll: {
      rarity: 'rare',
      rewards: [{ kind: 'currency', currency: 'coins', amount: 1_200 }],
      proof: { serverSeedHash: 'a'.repeat(64), clientSeed: 'client-seed', nonce: 3 },
      pity: { rare: 0, exquisite: 4, legendary: 9 },
    },
    wallet: { coins: 5_000, bullion: 0, goldBars: 0, pearls: 0, keys, tickets: 0, stars: 0 },
  });
}

class ApiError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

class NetworkError extends Error {
  override readonly name = 'NetworkError';
}

function keys(...ids: string[]): () => IdempotencyKey {
  const queue = ids.map((id) => IdempotencyKeySchema.parse(id));
  return () => {
    const next = queue.shift();
    if (next === undefined) throw new Error('test ran out of idempotency keys');
    return next;
  };
}

describe('safe countdown', () => {
  const locked = safe('lock', NOW + 90_500);

  it('stays syncing, never guessing, until the server clock has an offset', () => {
    expect(safeCountdown(locked, null)).toEqual({
      state: 'syncing',
      remainingMs: null,
      fraction: null,
    });
  });

  it('counts down against the server clock and reports progress over the type unlock time', () => {
    const countdown = safeCountdown(locked, NOW);
    expect(countdown.state).toBe('locked');
    expect(countdown.remainingMs).toBe(90_500);
    expect(countdown.fraction).toBeCloseTo(1 - 90_500 / UNLOCK_MS, 9);
  });

  it('is ready exactly at unlocksAt and after it', () => {
    expect(safeCountdown(locked, NOW + 90_500).state).toBe('ready');
    expect(safeCountdown(locked, NOW + 90_501)).toEqual({
      state: 'ready',
      remainingMs: 0,
      fraction: 1,
    });
    expect(safeCountdown(locked, NOW + 90_499).state).toBe('locked');
  });

  it('clamps the fraction for a safe granted further out than its type unlock time', () => {
    expect(safeCountdown(safe('far', NOW + UNLOCK_MS * 2), NOW).fraction).toBe(0);
  });

  it('formats H:MM:SS and M:SS, rounding seconds up so it never reads 0:00 while locked', () => {
    expect(formatCountdown(UNLOCK_MS)).toBe(`${GOLD.unlockSeconds / 3_600}:00:00`);
    expect(formatCountdown(3_600_000)).toBe('1:00:00');
    expect(formatCountdown(3_599_001)).toBe('1:00:00');
    expect(formatCountdown(3_599_000)).toBe('59:59');
    expect(formatCountdown(61_000)).toBe('1:01');
    expect(formatCountdown(1)).toBe('0:01');
    expect(formatCountdown(0)).toBe('0:00');
    expect(() => formatCountdown(Number.NaN)).toThrow(RangeError);
  });

  it('schedules the next repaint on the next whole second', () => {
    expect(msToNextSecond(90_500)).toBe(500);
    expect(msToNextSecond(90_000)).toBe(1_000);
    expect(msToNextSecond(1)).toBe(1);
  });

  it('finds the first safe to ring and counts the ready ones', () => {
    const list = [safe('a', NOW + 5_000), safe('b', NOW + 2_000), safe('c', NOW - 1)];
    expect(msToFirstReady(list, NOW)).toBe(2_000);
    expect(msToFirstReady(list, null)).toBeNull();
    expect(msToFirstReady([safe('c', NOW - 1)], NOW)).toBeNull();
    expect(msToFirstReady([], NOW)).toBeNull();
    expect(readyCount(list, NOW)).toBe(1);
    expect(readyCount(list, NOW + 5_000)).toBe(3);
    expect(readyCount(list, null)).toBe(0);
  });
});

describe('safe buttons', () => {
  const locked = safe('lock', NOW + 60_000);
  const ready = safe('ready', NOW - 1_000);

  it('offers "Open with N Keys" while locked, with the cost from packages/economy', () => {
    const view = safeActions({
      safe: locked,
      serverNow: NOW,
      keys: GOLD.keysPerSafe,
      pending: null,
    });
    expect(view.key).toEqual({
      visible: true,
      enabled: true,
      cost: GOLD.keysPerSafe,
      blocked: null,
    });
    expect(view.timer).toEqual({ visible: false, enabled: false });
  });

  it('disables the Key open, with a reason, when the server balance is short', () => {
    const view = safeActions({
      safe: locked,
      serverNow: NOW,
      keys: GOLD.keysPerSafe - 1,
      pending: null,
    });
    expect(view.key).toMatchObject({ visible: true, enabled: false, blocked: 'noKeys' });
  });

  it('leaves the Key open to the server when the balance is not known yet', () => {
    expect(
      safeActions({ safe: locked, serverNow: NOW, keys: null, pending: null }).key.enabled,
    ).toBe(true);
  });

  it('offers the Key open, not a free one, while the clock is still syncing', () => {
    const view = safeActions({ safe: ready, serverNow: null, keys: 5, pending: null });
    expect(view.countdown.state).toBe('syncing');
    expect(view.key.visible).toBe(true);
    expect(view.timer.visible).toBe(false);
  });

  it('swaps to a free "Open" once the timer has run out on the server clock', () => {
    const view = safeActions({ safe: ready, serverNow: NOW, keys: 0, pending: null });
    expect(view.key).toMatchObject({ visible: false, enabled: false, blocked: null });
    expect(view.timer).toEqual({ visible: true, enabled: true });
  });

  it('waits on both buttons while an open is in flight', () => {
    expect(
      safeActions({ safe: locked, serverNow: NOW, keys: 5, pending: 'key' }).key,
    ).toMatchObject({
      enabled: false,
      blocked: 'pending',
    });
    expect(
      safeActions({ safe: ready, serverNow: NOW, keys: 5, pending: 'timer' }).timer.enabled,
    ).toBe(false);
  });

  it('waits on every row while another safe is opening', () => {
    const view = { serverNow: NOW, keys: 5, pending: null, busy: true } as const;
    expect(safeActions({ safe: locked, ...view }).key).toMatchObject({
      enabled: false,
      blocked: 'pending',
    });
    expect(safeActions({ safe: ready, ...view }).timer.enabled).toBe(false);
  });

  it('takes in-flight Key opens off the shown balance, never below zero', () => {
    expect(provisionalKeys(3, [{ type: 'gold', method: 'key' }])).toBe(3 - GOLD.keysPerSafe);
    expect(provisionalKeys(3, [{ type: 'gold', method: 'timer' }])).toBe(3);
    expect(provisionalKeys(0, [{ type: 'gold', method: 'key' }])).toBe(0);
    expect(provisionalKeys(null, [{ type: 'gold', method: 'key' }])).toBeNull();
    expect(provisionalKeys(2, [])).toBe(2);
  });
});

describe('safes controller', () => {
  const target = safe('ctrl', NOW);

  function harness(answers: ((body: SafeOpenRequest) => Promise<SafeOpenResponse>)[]) {
    const calls: { body: SafeOpenRequest; key: IdempotencyKey }[] = [];
    const api: SafesApi = {
      open(body, key) {
        calls.push({ body, key });
        const answer = answers.shift();
        if (answer === undefined) throw new Error('unexpected safesOpen call');
        return answer(body);
      },
    };
    const events = createBus<SafeEvents>();
    const seen: string[] = [];
    for (const type of ['safe:requested', 'safe:opened', 'safe:pity', 'safe:rejected'] as const) {
      events.on(type, () => seen.push(type));
    }
    const controller = createSafesController({
      api,
      events,
      newKey: keys(
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000003',
      ),
    });
    return { controller, calls, events, seen };
  }

  it('sends only the safe and the method, and hands the server pity counters to callers', async () => {
    const { controller, calls, events, seen } = harness([
      () => Promise.resolve(response(target.id, 2)),
    ]);
    const pity: unknown[] = [];
    events.on('safe:pity', (payload) => pity.push(payload));
    const outcome = await controller.open(target.id, 'key');
    expect(calls[0]?.body).toEqual({ safeId: target.id, method: 'key' });
    expect(outcome).toMatchObject({
      ok: true,
      method: 'key',
      pity: { rare: 0, exquisite: 4, legendary: 9 },
    });
    expect(seen).toEqual(['safe:requested', 'safe:opened', 'safe:pity']);
    expect(pity).toEqual([{ safeId: target.id, pity: { rare: 0, exquisite: 4, legendary: 9 } }]);
  });

  it('keeps one request per safe while it is in flight', async () => {
    let finish: (value: SafeOpenResponse) => void = () => undefined;
    const { controller, calls } = harness([
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    ]);
    const first = controller.open(target.id, 'timer');
    const second = controller.open(target.id, 'timer');
    expect(second).toBe(first);
    expect(controller.pending(target.id)).toBe('timer');
    expect(controller.busy).toBe(true);
    finish(response(target.id, 0));
    await first;
    expect(calls).toHaveLength(1);
    expect(controller.pending(target.id)).toBeNull();
    expect(controller.busy).toBe(false);
  });

  it('reuses the Idempotency-Key after going offline, and draws a fresh one after an answer', async () => {
    const { controller, calls, seen } = harness([
      () => Promise.reject(new NetworkError('offline')),
      () => Promise.resolve(response(target.id, 1)),
      () => Promise.reject(new ApiError('not_found')),
    ]);
    expect(await controller.open(target.id, 'key')).toMatchObject({ ok: false, reason: 'offline' });
    await controller.open(target.id, 'key');
    await controller.open(target.id, 'key');
    expect(calls.map((call) => call.key)).toEqual([
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
    ]);
    expect(seen.filter((type) => type === 'safe:rejected')).toHaveLength(2);
  });

  it('does not carry an offline key over to the other open method', async () => {
    const { controller, calls } = harness([
      () => Promise.reject(new NetworkError('offline')),
      () => Promise.resolve(response(target.id, 1)),
    ]);
    await controller.open(target.id, 'key');
    await controller.open(target.id, 'timer');
    expect(calls[0]?.key).not.toBe(calls[1]?.key);
  });

  it('maps each server refusal to its own line of copy', () => {
    expect(classifySafeRejection(new ApiError('not_ready'))).toBe('notReady');
    expect(classifySafeRejection(new ApiError('insufficient_funds'))).toBe('noKeys');
    expect(classifySafeRejection(new ApiError('not_found'))).toBe('gone');
    expect(classifySafeRejection(new ApiError('conflict'))).toBe('gone');
    expect(classifySafeRejection(new ApiError('forbidden'))).toBe('unavailable');
    expect(classifySafeRejection(new ApiError('feature_disabled'))).toBe('unavailable');
    expect(classifySafeRejection(new ApiError('internal'))).toBe('error');
    expect(classifySafeRejection(new ApiError('no such code'))).toBe('error');
    expect(classifySafeRejection(new NetworkError('down'))).toBe('offline');
    expect(classifySafeRejection(new Error('boom'))).toBe('error');
    expect(classifySafeRejection(null)).toBe('error');
  });
});

function leafKeys(tree: ResourceTree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [`${prefix}${key}`] : leafKeys(value, `${prefix}${key}.`),
  );
}

describe('safes strings', () => {
  it('has the same keys in English, French and German, none blank', () => {
    const english = leafKeys(SAFES_STRINGS.en).sort();
    for (const language of LANGUAGES) {
      expect(leafKeys(SAFES_STRINGS[language]).sort()).toEqual(english);
      for (const key of leafKeys(SAFES_STRINGS[language])) {
        expect(
          key
            .split('.')
            .reduce<unknown>((node, part) => (node as ResourceTree)[part], SAFES_STRINGS[language]),
        ).not.toBe('');
      }
    }
  });

  it('names every safe type packages/economy defines, and refuses an unknown one', () => {
    for (const type of safesConfig.types) expect(() => safeTypeKey(type.id)).not.toThrow();
    expect(() => safeTypeKey('platinum')).toThrow(RangeError);
  });

  it('pluralises the Key button and fills the countdown in every language', () => {
    const i18n = createI18n({ language: 'en', resources: { en: {}, fr: {}, de: {} } });
    registerSafesStrings(i18n);
    expect(i18n.t(safesKey('openWithKeys'), { count: 1 })).toBe('Open with 1 Key');
    expect(i18n.t(safesKey('openWithKeys'), { count: 3 })).toBe('Open with 3 Keys');
    expect(i18n.t(safesKey('unlocksIn'), { time: '3:59:59' })).toBe('Opens free in 3:59:59');
    for (const language of LANGUAGES) {
      i18n.changeLanguage(language);
      expect(i18n.t(safesKey('rejected.noKeys'))).toBe(SAFES_STRINGS[language].rejected.noKeys);
      expect(i18n.t(safesKey('openWithKeys'), { count: 2 })).toContain('2');
    }
  });
});

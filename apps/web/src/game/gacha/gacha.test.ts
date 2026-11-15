import {
  GachaPullResponseSchema,
  IdempotencyKeySchema,
  type GachaPullRequest,
  type GachaPullResponse,
  type IdempotencyKey,
} from '@coinposh/shared';
import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { createBus } from '../../app/bus.ts';
import { createI18n, LANGUAGES, type ResourceTree } from '../../i18n/index.ts';
import { HAPTIC_PATTERNS } from '../../vfx/haptics.ts';
import { classifyGachaRejection, createGachaController, type GachaApi } from './controller.ts';
import type { GachaEvents } from './events.ts';
import { GACHA_STRINGS, gachaKey, registerGachaStrings } from './i18n.ts';
import { gachaCue, provisionalTickets, pullAction, revealSteps } from './plan.ts';

function response(tickets: number): GachaPullResponse {
  return GachaPullResponseSchema.parse({
    pulls: [
      {
        rarity: 'legendary',
        rewards: [{ kind: 'currency', currency: 'pearls', amount: 40 }],
        proof: { serverSeedHash: 'b'.repeat(64), clientSeed: 'client-seed', nonce: 7 },
        pity: { rare: 0, exquisite: 2, legendary: 0 },
      },
    ],
    wallet: { coins: 100, bullion: 0, goldBars: 0, pearls: 40, keys: 0, tickets, stars: 0 },
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

interface Call {
  readonly body: GachaPullRequest;
  readonly key: IdempotencyKey;
}

function harness(answers: ((call: Call) => Promise<GachaPullResponse>)[]) {
  const calls: Call[] = [];
  const api: GachaApi = {
    pull(body, key) {
      const call = { body, key };
      calls.push(call);
      const answer = answers.shift();
      if (!answer) throw new Error('test: no answer queued for this pull');
      return answer(call);
    },
  };
  const events = createBus<GachaEvents>();
  const seen: string[] = [];
  for (const name of ['gacha:requested', 'gacha:pulled', 'gacha:pity', 'gacha:rejected'] as const) {
    events.on(name, () => seen.push(name));
  }
  let n = 0;
  const controller = createGachaController({
    api,
    events,
    newKey: () => IdempotencyKeySchema.parse(`00000000-0000-4000-8000-00000000000${String(n++)}`),
  });
  return { controller, calls, seen, events };
}

describe('gacha controller', () => {
  it('asks the server for one capsule and reports its roll, wallet and pity', async () => {
    const { controller, calls, seen } = harness([() => Promise.resolve(response(2))]);
    const outcome = await controller.pull();
    expect(calls.map((call) => call.body)).toEqual([{ count: 1 }]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.roll.rarity).toBe('legendary');
    expect(outcome.wallet.tickets).toBe(2);
    expect(outcome.pity.legendary).toBe(0);
    expect(seen).toEqual(['gacha:requested', 'gacha:pulled', 'gacha:pity']);
  });

  it('sends one request while a pull is in flight', async () => {
    let release: (value: GachaPullResponse) => void = () => undefined;
    const { controller, calls } = harness([
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    ]);
    const first = controller.pull();
    const second = controller.pull();
    expect(second).toBe(first);
    expect(controller.busy).toBe(true);
    release(response(0));
    await first;
    expect(calls).toHaveLength(1);
    expect(controller.busy).toBe(false);
  });

  it('turns the server refusing for lack of Tickets into noTickets', async () => {
    const { controller, seen } = harness([
      () => Promise.reject(new ApiError('insufficient_funds')),
    ]);
    const outcome = await controller.pull();
    expect(outcome).toMatchObject({ ok: false, reason: 'noTickets' });
    expect(seen).toEqual(['gacha:requested', 'gacha:rejected']);
  });

  it('reuses the Idempotency-Key after an offline pull, and a fresh one after a refusal', async () => {
    const { controller, calls } = harness([
      () => Promise.reject(new NetworkError('offline')),
      () => Promise.resolve(response(1)),
      () => Promise.reject(new ApiError('internal')),
      () => Promise.resolve(response(0)),
    ]);
    expect(await controller.pull()).toMatchObject({ ok: false, reason: 'offline' });
    await controller.pull();
    expect(await controller.pull()).toMatchObject({ ok: false, reason: 'error' });
    await controller.pull();
    const keys = calls.map((call) => call.key);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
    expect(keys[3]).not.toBe(keys[2]);
  });

  it('classifies every refusal, unknown codes as a plain error', () => {
    expect(classifyGachaRejection(new ApiError('feature_disabled'))).toBe('unavailable');
    expect(classifyGachaRejection(new ApiError('rate_limited'))).toBe('busy');
    expect(classifyGachaRejection(new ApiError('not_a_code'))).toBe('error');
    expect(classifyGachaRejection(new NetworkError('down'))).toBe('offline');
    expect(classifyGachaRejection('boom')).toBe('error');
  });
});

describe('gacha plan', () => {
  it('blocks Pull at zero Tickets, while syncing and while a pull is in flight', () => {
    expect(pullAction(0, false)).toEqual({ enabled: false, blocked: 'noTickets' });
    expect(pullAction(null, false)).toEqual({ enabled: false, blocked: 'syncing' });
    expect(pullAction(3, true)).toEqual({ enabled: false, blocked: 'busy' });
    expect(pullAction(1, false)).toEqual({ enabled: true, blocked: null });
  });

  it('takes the pending Ticket off the readout without going below zero', () => {
    expect(provisionalTickets(3, true)).toBe(2);
    expect(provisionalTickets(0, true)).toBe(0);
    expect(provisionalTickets(3, false)).toBe(3);
    expect(provisionalTickets(null, true)).toBeNull();
  });

  it('skips the crank turn under reduced motion', () => {
    expect(revealSteps(false)).toEqual(['crank', 'dispense', 'pop']);
    expect(revealSteps(true)).toEqual(['dispense', 'pop']);
  });

  it('cues a big pop with impacts, a fanfare, the sting and a burst', () => {
    const at = new Vector3(0, 0, 0);
    const big = gachaCue({ kind: 'pop', rarity: 'legendary', at }, false);
    expect(big.impacts.length).toBeGreaterThanOrEqual(2);
    expect(big.haptic).toEqual(HAPTIC_PATTERNS.fanfare);
    expect(big.sting).toBe(true);
    expect(big.burst).toBe('legendary');
    const small = gachaCue({ kind: 'pop', rarity: 'common', at }, true);
    expect(small.sting).toBe(false);
    expect(small.haptic).toEqual(HAPTIC_PATTERNS.tap);
  });

  it('drops the landing thud under reduced motion but keeps its sound', () => {
    const at = new Vector3(0.5, 0, 0);
    const full = gachaCue({ kind: 'land', strength: 0.5, at }, false);
    const reduced = gachaCue({ kind: 'land', strength: 0.5, at }, true);
    expect(full.haptic).toEqual(HAPTIC_PATTERNS.thud);
    expect(reduced.haptic).toBeNull();
    expect(reduced.impacts).toEqual(full.impacts);
    expect(Math.abs(full.impacts[0]?.pan ?? 0)).toBeLessThanOrEqual(0.6);
  });
});

function leafKeys(tree: ResourceTree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [`${prefix}${key}`] : leafKeys(value, `${prefix}${key}.`),
  );
}

describe('gacha strings', () => {
  it('has the same keys in English, French and German, none blank', () => {
    const english = leafKeys(GACHA_STRINGS.en).sort();
    for (const language of LANGUAGES) {
      expect(leafKeys(GACHA_STRINGS[language]).sort()).toEqual(english);
      for (const key of leafKeys(GACHA_STRINGS[language])) {
        expect(
          key
            .split('.')
            .reduce<unknown>((node, part) => (node as ResourceTree)[part], GACHA_STRINGS[language]),
        ).not.toBe('');
      }
    }
  });

  it('fills the Tickets readout and the refusals in every language', () => {
    const i18n = createI18n({ language: 'en', resources: { en: {}, fr: {}, de: {} } });
    registerGachaStrings(i18n);
    expect(i18n.t(gachaKey('tickets'), { value: '3' })).toBe('Tickets: 3');
    for (const language of LANGUAGES) {
      i18n.changeLanguage(language);
      expect(i18n.t(gachaKey('rejected.noTickets'))).toBe(
        GACHA_STRINGS[language].rejected.noTickets,
      );
      expect(i18n.t(gachaKey('pull'))).toContain('1');
    }
  });
});

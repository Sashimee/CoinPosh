import {
  IdempotencyKeySchema,
  RARITIES,
  ScratchCardIdSchema,
  ScratchRevealResponseSchema,
  type IdempotencyKey,
  type Rarity,
  type ScratchCardId,
  type ScratchRevealRequest,
  type ScratchRevealResponse,
} from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import { createBus } from '../../app/bus.ts';
import { LANGUAGES, type ResourceTree } from '../../i18n/index.ts';
import type { Payout } from '../../ui/components/balancePlaque.ts';
import { netScratchApi } from './api.ts';
import {
  classifyScratchRejection,
  createScratchController,
  type ScratchApi,
  type ScratchOutcome,
} from './controller.ts';
import type { ScratchEvents } from './events.ts';
import { SCRATCH_STRINGS, scratchKey } from './i18n.ts';
import { createScratchSession } from './session.ts';

const CARD = ScratchCardIdSchema.parse('scratch_AAAAAAAAAAAAAAAA');
const OTHER = ScratchCardIdSchema.parse('scratch_BBBBBBBBBBBBBBBB');
const WON = ScratchCardIdSchema.parse('scratch_CCCCCCCCCCCCCCCC');
const GRID: Rarity[] = [
  'fine',
  'rare',
  'common',
  'rare',
  'fine',
  'common',
  'rare',
  'common',
  'fine',
];

function response(cardId: ScratchCardId, grid: readonly Rarity[] = GRID): ScratchRevealResponse {
  return ScratchRevealResponseSchema.parse({
    cardId,
    grid,
    roll: {
      rarity: 'rare',
      rewards: [
        { kind: 'currency', currency: 'coins', amount: 1_200 },
        { kind: 'scratchCard', cardId: WON },
      ],
      proof: { serverSeedHash: 'a'.repeat(64), clientSeed: 'client-seed', nonce: 5 },
      pity: { rare: 0, exquisite: 4, legendary: 9 },
    },
    wallet: { coins: 6_200, bullion: 0, goldBars: 0, pearls: 0, keys: 0, tickets: 0, stars: 0 },
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

const KEY_A = '0b3d7c1e-0000-4000-8000-00000000000a';
const KEY_B = '0b3d7c1e-0000-4000-8000-00000000000b';
const KEY_C = '0b3d7c1e-0000-4000-8000-00000000000c';

interface Call {
  readonly body: ScratchRevealRequest;
  readonly key: IdempotencyKey;
}

/** A scripted server: each reveal takes the next answer, either a response or a thrown error. */
function scriptedApi(...answers: (ScratchRevealResponse | Error)[]) {
  const calls: Call[] = [];
  const api: ScratchApi = {
    reveal(body, key) {
      calls.push({ body, key });
      const next = answers.shift();
      if (next === undefined) return Promise.reject(new Error('test server ran out of answers'));
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
  return { api, calls };
}

function recorder(events: ReturnType<typeof createBus<ScratchEvents>>) {
  const log: string[] = [];
  for (const name of [
    'scratch:requested',
    'scratch:revealed',
    'scratch:pity',
    'scratch:rejected',
  ] as const) {
    events.on(name, (payload) => {
      log.push('reason' in payload ? `${name}:${payload.reason}` : name);
    });
  }
  return log;
}

describe('scratch rejections', () => {
  it('reads the envelope code and the network failure', () => {
    expect(classifyScratchRejection(new ApiError('not_found'))).toBe('gone');
    expect(classifyScratchRejection(new ApiError('conflict'))).toBe('gone');
    expect(classifyScratchRejection(new ApiError('forbidden'))).toBe('unavailable');
    expect(classifyScratchRejection(new ApiError('feature_disabled'))).toBe('unavailable');
    expect(classifyScratchRejection(new ApiError('rate_limited'))).toBe('error');
    expect(classifyScratchRejection(new NetworkError('down'))).toBe('offline');
    expect(classifyScratchRejection(new Error('boom'))).toBe('error');
    expect(classifyScratchRejection('nonsense')).toBe('error');
    expect(classifyScratchRejection(new ApiError('not_a_code'))).toBe('error');
  });
});

describe('scratch controller', () => {
  it('sends only the card id and hands back the server grid and its match', async () => {
    const events = createBus<ScratchEvents>();
    const log = recorder(events);
    const { api, calls } = scriptedApi(response(CARD));
    const controller = createScratchController({ api, events, newKey: keys(KEY_A) });
    const revealed: ScratchEvents['scratch:revealed'][] = [];
    events.on('scratch:revealed', (payload) => revealed.push(payload));

    const outcome = await controller.reveal(CARD);

    expect(calls).toEqual([{ body: { cardId: CARD }, key: KEY_A }]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.match).toEqual({ rarity: 'rare', cells: [1, 3, 6] });
    expect(revealed[0]?.grid).toEqual(GRID);
    expect(revealed[0]?.wallet.coins).toBe(6_200);
    expect(log).toEqual(['scratch:requested', 'scratch:revealed', 'scratch:pity']);
  });

  it('turns an unknown card down as gone (not_found)', async () => {
    const events = createBus<ScratchEvents>();
    const log = recorder(events);
    const { api } = scriptedApi(new ApiError('not_found'));
    const controller = createScratchController({ api, events, newKey: keys(KEY_A) });
    const outcome = await controller.reveal(CARD);
    expect(outcome).toMatchObject({ ok: false, reason: 'gone' });
    expect(log).toEqual(['scratch:requested', 'scratch:rejected:gone']);
  });

  it('retries an offline reveal with the same key, so the server replays instead of rolling twice', async () => {
    const events = createBus<ScratchEvents>();
    const { api, calls } = scriptedApi(new NetworkError('down'), response(CARD));
    const controller = createScratchController({ api, events, newKey: keys(KEY_A, KEY_B) });
    expect(await controller.reveal(CARD)).toMatchObject({ ok: false, reason: 'offline' });
    expect((await controller.reveal(CARD)).ok).toBe(true);
    expect(calls.map((call) => call.key)).toEqual([KEY_A, KEY_A]);
  });

  it('takes a fresh key after a refusal or a success', async () => {
    const events = createBus<ScratchEvents>();
    const { api, calls } = scriptedApi(new ApiError('forbidden'), response(CARD), response(CARD));
    const controller = createScratchController({ api, events, newKey: keys(KEY_A, KEY_B, KEY_C) });
    expect(await controller.reveal(CARD)).toMatchObject({ ok: false, reason: 'unavailable' });
    await controller.reveal(CARD);
    await controller.reveal(CARD);
    expect(calls.map((call) => call.key)).toEqual([KEY_A, KEY_B, KEY_C]);
  });

  it('refuses to paint a grid without three of the rolled rarity', async () => {
    const events = createBus<ScratchEvents>();
    const log = recorder(events);
    const broken: Rarity[] = [
      'fine',
      'rare',
      'common',
      'common',
      'fine',
      'common',
      'rare',
      'common',
      'fine',
    ];
    const { api } = scriptedApi(response(CARD, broken));
    const controller = createScratchController({ api, events, newKey: keys(KEY_A) });
    const outcome = await controller.reveal(CARD);
    expect(outcome).toMatchObject({ ok: false, reason: 'error' });
    expect(log).toEqual(['scratch:requested', 'scratch:rejected:error']);
  });

  it('shares one request per card while it is in flight', async () => {
    const events = createBus<ScratchEvents>();
    const { api, calls } = scriptedApi(response(CARD), response(OTHER));
    const controller = createScratchController({ api, events, newKey: keys(KEY_A, KEY_B) });
    const first = controller.reveal(CARD);
    const again = controller.reveal(CARD);
    const other = controller.reveal(OTHER);
    expect(again).toBe(first);
    expect(controller.pending(CARD)).toBe(true);
    expect(controller.busy).toBe(true);
    await Promise.all([first, other]);
    expect(calls).toHaveLength(2);
    expect(controller.pending(CARD)).toBe(false);
    expect(controller.busy).toBe(false);
  });

  it('rejects a malformed card id before anything goes out', async () => {
    const events = createBus<ScratchEvents>();
    const { api, calls } = scriptedApi(response(CARD));
    const controller = createScratchController({ api, events, newKey: keys(KEY_A) });
    const outcome = await controller.reveal('crate_AAAAAAAAAAAAAAAA' as ScratchCardId);
    expect(outcome).toMatchObject({ ok: false, reason: 'error' });
    expect(calls).toEqual([]);
  });
});

describe('scratch net api', () => {
  it('calls the scratch reveal endpoint with the idempotency key', async () => {
    const seen: unknown[] = [];
    const api = netScratchApi({
      call: ((name: string, params: unknown, options: unknown) => {
        seen.push({ name, params, options });
        return Promise.resolve(response(CARD));
      }) as never,
    });
    const key = IdempotencyKeySchema.parse(KEY_A);
    await api.reveal({ cardId: CARD }, key);
    expect(seen).toEqual([
      {
        name: 'scratchReveal',
        params: { body: { cardId: CARD } },
        options: { idempotencyKey: key },
      },
    ]);
  });
});

function ledger() {
  const log: string[] = [];
  return {
    log,
    payout: {
      hold: (id: string, credit: Readonly<Record<string, number>>) =>
        log.push(`hold:${id}:${JSON.stringify(credit)}`),
      arm: (id: string) => log.push(`arm:${id}`),
      collect: (id: string, payout: Payout) => log.push(`collect:${id}:${payout.wallet.coins}`),
      release: (id: string) => log.push(`release:${id}`),
    },
  };
}

function fixedController(outcome: ScratchOutcome) {
  const asked: ScratchCardId[] = [];
  return {
    asked,
    controller: {
      reveal: (cardId: ScratchCardId) => {
        asked.push(cardId);
        return Promise.resolve(outcome);
      },
    },
  };
}

const OK: ScratchOutcome = {
  ok: true,
  response: response(CARD),
  match: { rarity: 'rare', cells: [1, 3, 6] },
};

describe('scratch session', () => {
  it('holds the credit on the reveal, arms it on settle and pays it out once', async () => {
    const { log, payout } = ledger();
    const pity: string[] = [];
    const { controller } = fixedController(OK);
    const session = createScratchSession({
      controller,
      payout,
      onPity: (cardId, counters) => pity.push(`${cardId}:${counters.legendary}`),
    });

    expect((await session.reveal(CARD)).ok).toBe(true);
    expect(log).toEqual([`hold:${CARD}:{"coins":1200}`]);
    expect(pity).toEqual([`${CARD}:9`]);
    expect(session.unpaid).toEqual([CARD]);

    session.settled(CARD);
    const lines: Payout = { wallet: OK.response.wallet, lines: [] };
    expect(session.collect(CARD, lines)).toBe(true);
    expect(session.collect(CARD, lines)).toBe(false);
    session.abandon(CARD);
    session.dispose();
    expect(log).toEqual([`hold:${CARD}:{"coins":1200}`, `arm:${CARD}`, `collect:${CARD}:6200`]);
    expect(session.unpaid).toEqual([]);
  });

  it('releases the hold when the card leaves without a collect', async () => {
    const { log, payout } = ledger();
    const session = createScratchSession({ controller: fixedController(OK).controller, payout });
    await session.reveal(CARD);
    session.abandon(CARD);
    session.abandon(CARD);
    session.settled(CARD);
    expect(log).toEqual([`hold:${CARD}:{"coins":1200}`, `release:${CARD}`]);
  });

  it('releases every hold on dispose', async () => {
    const { log, payout } = ledger();
    const session = createScratchSession({ controller: fixedController(OK).controller, payout });
    await session.reveal(CARD);
    session.dispose();
    session.dispose();
    expect(log).toEqual([`hold:${CARD}:{"coins":1200}`, `release:${CARD}`]);
  });

  it('holds nothing on a refusal and resyncs only when the card is gone', async () => {
    for (const [reason, refreshes] of [
      ['gone', 1],
      ['offline', 0],
      ['unavailable', 0],
      ['error', 0],
    ] as const) {
      const { log, payout } = ledger();
      let refreshed = 0;
      const session = createScratchSession({
        controller: fixedController({ ok: false, reason, error: new Error(reason) }).controller,
        payout,
        refresh: () => refreshed++,
      });
      expect(await session.reveal(CARD)).toMatchObject({ ok: false, reason });
      expect(log).toEqual([]);
      expect(refreshed, reason).toBe(refreshes);
      expect(session.collect(CARD, { wallet: OK.response.wallet, lines: [] })).toBe(false);
    }
  });
});

function shape(tree: ResourceTree, prefix = ''): string[] {
  return Object.entries(tree)
    .flatMap(([key, value]) =>
      typeof value === 'string' ? [`${prefix}${key}`] : shape(value, `${prefix}${key}.`),
    )
    .sort();
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1] ?? '').sort();
}

function leaf(tree: ResourceTree, path: string): string {
  let node: ResourceTree | string = tree;
  for (const part of path.split('.')) {
    if (typeof node === 'string') throw new Error(`${path} runs past a string`);
    const next: ResourceTree | string | undefined = node[part];
    if (next === undefined) throw new Error(`${path} is missing`);
    node = next;
  }
  if (typeof node !== 'string') throw new Error(`${path} is not a string`);
  return node;
}

describe('scratch strings', () => {
  const english = SCRATCH_STRINGS.en;

  it('has the same keys and placeholders in every language', () => {
    const keysEn = shape(english);
    for (const language of LANGUAGES) {
      const strings = SCRATCH_STRINGS[language];
      expect(shape(strings), language).toEqual(keysEn);
      for (const key of keysEn) {
        expect(placeholders(leaf(strings, key)), `${language} ${key}`).toEqual(
          placeholders(leaf(english, key)),
        );
        expect(leaf(strings, key).trim(), `${language} ${key}`).not.toBe('');
      }
    }
  });

  it('names every rarity and every rejection', () => {
    for (const rarity of RARITIES) {
      expect(english.gem[rarity]).toBeTruthy();
      expect(english.match[rarity]).toBeTruthy();
    }
    expect(Object.keys(english.rejected).sort()).toEqual([
      'error',
      'gone',
      'offline',
      'unavailable',
    ]);
  });

  it('keys into its own namespace', () => {
    expect(scratchKey('gem.rare')).toBe('gameScratch:gem.rare');
  });
});

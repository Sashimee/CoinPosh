import { ascension, ascensionGoldBars, upgradeCost, upgradeLines, venues } from '@coinposh/economy';
import {
  IdempotencyKeySchema,
  VENUE_IDS,
  WalletSchema,
  type AscendRequest,
  type AscendResponse,
  type ErrorCode,
  type IdempotencyKey,
  type UpgradeBuyRequest,
  type UpgradeBuyResponse,
  type VenueId,
} from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import { createBus } from '../../app/bus.ts';
import { createI18n, LANGUAGES, type ResourceTree } from '../../i18n/core.ts';
import { BUNDLED_RESOURCES } from '../../i18n/index.ts';
import { ApiRequestError, NetworkError } from '../../net/errors.ts';
import { netAscensionApi } from './api.ts';
import {
  classifyAscensionRejection,
  createAscensionController,
  type AscensionApi,
} from './controller.ts';
import type { AscensionEvents } from './events.ts';
import {
  ASCENSION_NAMESPACE,
  ASCENSION_STRINGS,
  ascensionKey,
  lineNameKey,
  registerAscensionStrings,
  venueKey,
} from './i18n.ts';
import {
  ascensionProgress,
  canRequestAscension,
  FAMILY_OFFICE_LINES,
  familyOfficeRows,
  HOLD_TICKS,
  HOLD_TO_ASCEND_MS,
  holdFraction,
  holdTick,
  nextVenueId,
} from './plan.ts';

const RIVIERA = 'rivieraYacht' satisfies VenueId;
const PARIS = 'salonDeParis' satisfies VenueId;
const rivieraThreshold = venues[0].bullionThreshold;

function wallet(goldBars: number, coins = 0) {
  return WalletSchema.parse({
    coins,
    bullion: 0,
    goldBars,
    pearls: 0,
    keys: 0,
    tickets: 0,
    stars: 0,
  });
}

const CONFIRMED: AscendResponse = {
  venueId: RIVIERA,
  goldBarsGranted: 20,
  unlockedVenueId: PARIS,
  wallet: wallet(20, 20),
};

function key(n: number): IdempotencyKey {
  return IdempotencyKeySchema.parse(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
}

function keys() {
  let n = 0;
  return () => key(++n);
}

function recorder() {
  const events = createBus<AscensionEvents>();
  const seen: [string, unknown][] = [];
  for (const type of [
    'ascension:requested',
    'ascension:confirmed',
    'ascension:rejected',
    'familyOffice:requested',
    'familyOffice:purchased',
    'familyOffice:rejected',
  ] as const) {
    events.on(type, (payload) => seen.push([type, payload]));
  }
  return { events, seen };
}

function apiError(code: ErrorCode): ApiRequestError {
  return new ApiRequestError('ascend', 409, { code, message: code, requestId: 'r' });
}

describe('ascension progress', () => {
  it('reads progress and a provisional payout from the same economy formula as the server', () => {
    const half = ascensionProgress(RIVIERA, rivieraThreshold / 2);
    expect(half).toMatchObject({
      threshold: rivieraThreshold,
      fraction: 0.5,
      ready: false,
      estimatedGoldBars: 0,
      nextVenueId: PARIS,
    });
    expect(canRequestAscension(half)).toBe(false);

    const quadruple = ascensionProgress(RIVIERA, rivieraThreshold * 4);
    expect(quadruple.fraction).toBe(1);
    expect(quadruple.ready).toBe(true);
    expect(quadruple.estimatedGoldBars).toBe(
      ascensionGoldBars(rivieraThreshold * 4, rivieraThreshold, ascension),
    );
    expect(canRequestAscension(quadruple)).toBe(true);
  });

  it('lets the server decide when the client has no Bullion figure', () => {
    for (const unknown of [null, Number.NaN, -1]) {
      const progress = ascensionProgress(RIVIERA, unknown);
      expect(progress).toMatchObject({
        bullion: null,
        fraction: 0,
        ready: null,
        estimatedGoldBars: null,
      });
      expect(canRequestAscension(progress)).toBe(true);
    }
  });

  it('walks the venues in unlock order and ends after the last one', () => {
    expect(nextVenueId(RIVIERA)).toBe(PARIS);
    expect(nextVenueId('orbitalCasino')).toBeNull();
    expect(ascensionProgress(RIVIERA, rivieraThreshold).ready).toBe(true);
    expect(ascensionProgress(RIVIERA, rivieraThreshold - 1).ready).toBe(false);
  });
});

describe('Family Office rows', () => {
  it('lists exactly the global upgrade lines, priced in Gold Bars from economy config', () => {
    expect(FAMILY_OFFICE_LINES.map((line) => line.id)).toEqual(
      upgradeLines.filter((line) => line.scope === 'global').map((line) => line.id),
    );
    expect(FAMILY_OFFICE_LINES.length).toBeGreaterThan(0);
    const oldMoney = FAMILY_OFFICE_LINES.find((line) => line.id === 'oldMoney');
    if (oldMoney === undefined) throw new Error('economy config lost the oldMoney line');
    const price = upgradeCost(oldMoney, 3);
    const affordable = familyOfficeRows({ oldMoney: 3 }, price).find(
      (row) => row.lineId === 'oldMoney',
    );
    expect(affordable).toMatchObject({ level: 3, cost: price, affordable: true, maxed: false });
    const short = familyOfficeRows({ oldMoney: 3 }, price - 1).find(
      (row) => row.lineId === 'oldMoney',
    );
    expect(short?.affordable).toBe(false);
  });

  it('marks a maxed line with no price and treats missing levels as 0', () => {
    const levels = Object.fromEntries(FAMILY_OFFICE_LINES.map((line) => [line.id, line.maxLevel]));
    for (const row of familyOfficeRows(levels, 1e12)) {
      expect(row).toMatchObject({ maxed: true, cost: null, affordable: false, nextEffect: null });
    }
    for (const row of familyOfficeRows({}, 0)) expect(row.level).toBe(0);
  });
});

describe('hold to ascend', () => {
  it('fills over the hold time and ticks evenly on the way', () => {
    expect(holdFraction(0)).toBe(0);
    expect(holdFraction(-10)).toBe(0);
    expect(holdFraction(Number.NaN)).toBe(0);
    expect(holdFraction(HOLD_TO_ASCEND_MS / 2)).toBe(0.5);
    expect(holdFraction(HOLD_TO_ASCEND_MS * 3)).toBe(1);
    expect(holdTick(0)).toBe(0);
    expect(holdTick(1)).toBe(HOLD_TICKS);
    expect(holdTick(0.99)).toBe(HOLD_TICKS - 1);
  });
});

describe('classifyAscensionRejection', () => {
  it('maps the server codes the player can act on, and offline network failures', () => {
    expect(classifyAscensionRejection({ code: 'not_ready' })).toBe('notReady');
    expect(classifyAscensionRejection({ code: 'conflict' })).toBe('stale');
    expect(classifyAscensionRejection({ code: 'forbidden' })).toBe('locked');
    expect(classifyAscensionRejection({ code: 'insufficient_funds' })).toBe('unaffordable');
    expect(classifyAscensionRejection({ code: 'internal' })).toBe('error');
    expect(classifyAscensionRejection(new NetworkError('down'))).toBe('offline');
    expect(classifyAscensionRejection(new Error('boom'))).toBe('error');
    expect(classifyAscensionRejection('nonsense')).toBe('error');
  });
});

describe('ascension controller', () => {
  it('sends only the venue, emits confirmed with the server payout, and is single-flight', async () => {
    const calls: [AscendRequest, IdempotencyKey][] = [];
    let release: (response: AscendResponse) => void = () => undefined;
    const api: AscensionApi = {
      ascend: (body, idempotencyKey) => {
        calls.push([body, idempotencyKey]);
        return new Promise((resolve) => {
          release = resolve;
        });
      },
      buyFamilyOffice: () => Promise.reject(new Error('unused')),
    };
    const { events, seen } = recorder();
    const controller = createAscensionController({ api, events, newKey: keys() });
    const first = controller.ascend(RIVIERA);
    const second = controller.ascend(RIVIERA);
    expect(second).toBe(first);
    expect(controller.busy).toBe(true);
    expect(calls).toEqual([[{ venueId: RIVIERA }, key(1)]]);
    release(CONFIRMED);
    expect(await first).toEqual({ ok: true, response: CONFIRMED });
    expect(controller.busy).toBe(false);
    expect(seen).toEqual([
      ['ascension:requested', { venueId: RIVIERA }],
      [
        'ascension:confirmed',
        { venueId: RIVIERA, goldBarsGranted: 20, unlockedVenueId: PARIS, wallet: CONFIRMED.wallet },
      ],
    ]);
  });

  it('retries an offline ascension with the same key, and a definitive rejection with a new one', async () => {
    const used: IdempotencyKey[] = [];
    const failures: Error[] = [new NetworkError('down'), apiError('not_ready')];
    const api: AscensionApi = {
      ascend: (_body, idempotencyKey) => {
        used.push(idempotencyKey);
        const failure = failures.shift();
        return failure === undefined ? Promise.resolve(CONFIRMED) : Promise.reject(failure);
      },
      buyFamilyOffice: () => Promise.reject(new Error('unused')),
    };
    const { events, seen } = recorder();
    const controller = createAscensionController({ api, events, newKey: keys() });
    expect(await controller.ascend(RIVIERA)).toMatchObject({ ok: false, reason: 'offline' });
    expect(await controller.ascend(RIVIERA)).toMatchObject({ ok: false, reason: 'notReady' });
    expect(await controller.ascend(RIVIERA)).toMatchObject({ ok: true });
    expect(used).toEqual([key(1), key(1), key(2)]);
    expect(seen.filter(([type]) => type === 'ascension:rejected')).toEqual([
      ['ascension:rejected', { venueId: RIVIERA, reason: 'offline' }],
      ['ascension:rejected', { venueId: RIVIERA, reason: 'notReady' }],
    ]);
  });

  it('refuses to build a request for a venue that does not exist, before any network call', () => {
    const { events } = recorder();
    const api: AscensionApi = {
      ascend: () => Promise.reject(new Error('must not be called')),
      buyFamilyOffice: () => Promise.reject(new Error('must not be called')),
    };
    const controller = createAscensionController({ api, events, newKey: keys() });
    expect(() => controller.ascend('atlantis' as VenueId)).toThrow();
  });

  it('buys a Family Office level and reports unaffordable rejections', async () => {
    const bodies: UpgradeBuyRequest[] = [];
    const responses: (UpgradeBuyResponse | Error)[] = [
      { venueId: PARIS, lineId: 'trustFund' as never, level: 1, wallet: wallet(8) },
      apiError('insufficient_funds'),
    ];
    const api: AscensionApi = {
      ascend: () => Promise.reject(new Error('unused')),
      buyFamilyOffice: (body) => {
        bodies.push(body);
        const next = responses.shift();
        if (next === undefined) return Promise.reject(new Error('no more responses'));
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      },
    };
    const { events, seen } = recorder();
    const controller = createAscensionController({ api, events, newKey: keys() });
    expect(await controller.buyFamilyOffice(PARIS, 'trustFund', 1)).toMatchObject({ ok: true });
    expect(await controller.buyFamilyOffice(PARIS, 'trustFund', 2)).toMatchObject({
      ok: false,
      reason: 'unaffordable',
    });
    expect(bodies).toEqual([
      { venueId: PARIS, lineId: 'trustFund', level: 1 },
      { venueId: PARIS, lineId: 'trustFund', level: 2 },
    ]);
    expect(seen.map(([type]) => type)).toEqual([
      'familyOffice:requested',
      'familyOffice:purchased',
      'familyOffice:requested',
      'familyOffice:rejected',
    ]);
  });

  it('routes through the signed net client with the caller key', async () => {
    const calls: unknown[] = [];
    const client = {
      call: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve(CONFIRMED);
      },
    };
    const api = netAscensionApi(client as never);
    await api.ascend({ venueId: RIVIERA }, key(9));
    expect(calls).toEqual([['ascend', { body: { venueId: RIVIERA } }, { idempotencyKey: key(9) }]]);
  });

  it('carries the error code of a real ApiRequestError', () => {
    expect(classifyAscensionRejection(apiError('not_ready'))).toBe('notReady');
  });
});

function leafKeys(tree: ResourceTree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([name, value]) =>
    typeof value === 'string' ? [`${prefix}${name}`] : leafKeys(value, `${prefix}${name}.`),
  );
}

describe('ascension strings', () => {
  it('has the same keys, all non-empty, in EN, FR and DE, with every venue named', () => {
    const english = leafKeys(ASCENSION_STRINGS.en).sort();
    for (const language of LANGUAGES) {
      expect(leafKeys(ASCENSION_STRINGS[language]).sort()).toEqual(english);
      for (const id of VENUE_IDS) expect(ASCENSION_STRINGS[language].venue[id]).toBeTruthy();
    }
  });

  it('resolves through i18next, including the Family Office line names from the UI bundle', () => {
    const i18n = createI18n({ resources: BUNDLED_RESOURCES, language: 'fr' });
    registerAscensionStrings(i18n);
    expect(i18n.t(ascensionKey('title'))).toBe(ASCENSION_STRINGS.fr.title);
    expect(i18n.t(venueKey(PARIS))).toBe('Salon de Paris');
    for (const line of FAMILY_OFFICE_LINES) {
      expect(i18n.t(lineNameKey(line.id))).not.toBe(lineNameKey(line.id));
    }
    expect(i18n.exists(`${ASCENSION_NAMESPACE}:venue.${RIVIERA}`)).toBe(true);
    i18n.changeLanguage('de');
    expect(i18n.t(ascensionKey('hold'))).toBe(ASCENSION_STRINGS.de.hold);
  });
});

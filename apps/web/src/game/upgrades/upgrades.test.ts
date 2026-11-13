import { upgradeLines } from '@coinposh/economy';
import {
  endpoints,
  IdempotencyKeySchema,
  UpgradeBuyResponseSchema,
  WalletSchema,
  type IdempotencyKey,
  type UpgradeBuyRequest,
  type UpgradeBuyResponse,
} from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import { createBus } from '../../app/bus.ts';
import { defaultSettings } from '../../app/settings.ts';
import { initialUiState, type FeedbackKind, type UiEvents, type UiState } from '../../app/state.ts';
import { createStore } from '../../app/store.ts';
import { createI18n, LANGUAGES, type ResourceTree } from '../../i18n/index.ts';
import type { ImpactEvent } from '../../audio/index.ts';
import { bindUpgrades, classifyRejection, type UpgradeApi, type UpgradeUi } from './controller.ts';
import type { UpgradeEvents } from './events.ts';
import { bindUpgradeFeedback, PURCHASE_CHIME } from './feedback.ts';
import { registerUpgradeStrings, rejectionKey, UPGRADE_STRINGS } from './i18n.ts';
import { isFamilyOfficeLine, UPGRADE_LINE_IDS_V1, UPGRADE_LINES_V1 } from './lines.ts';

const VENUE = endpoints.upgradesBuy.body.shape.venueId.parse('rivieraYacht');

function walletWith(coins: number) {
  return WalletSchema.parse({
    coins,
    bullion: 0,
    goldBars: 3,
    pearls: 0,
    keys: 0,
    tickets: 0,
    stars: 0,
  });
}

function bought(lineId: string, level: number, coins: number): UpgradeBuyResponse {
  return UpgradeBuyResponseSchema.parse({
    venueId: VENUE,
    lineId,
    level,
    wallet: walletWith(coins),
  });
}

interface Harness {
  readonly ui: UpgradeUi;
  readonly feedback: FeedbackKind[];
  readonly events: ReturnType<typeof createBus<UpgradeEvents>>;
  readonly seen: { type: keyof UpgradeEvents; payload: unknown }[];
  request(lineId: string, fromLevel: number): void;
}

/** A UI with the same store semantics as mountApp, minus the DOM. */
function harness(coins: number, levels: Record<string, number> = {}): Harness {
  const store = createStore<UiState>({
    ...initialUiState(defaultSettings('en')),
    coins,
    upgradeLevels: levels,
  });
  const bus = createBus<UiEvents>();
  const feedback: FeedbackKind[] = [];
  bus.on('ui:feedback', ({ kind }) => feedback.push(kind));
  const events = createBus<UpgradeEvents>();
  const seen: Harness['seen'] = [];
  for (const type of ['upgrade:requested', 'upgrade:purchased', 'upgrade:rejected'] as const) {
    events.on(type, (payload) => seen.push({ type, payload }));
  }
  const ui: UpgradeUi = {
    store,
    bus,
    onUpgradeRequest: (handler) => bus.on('upgrades:request', handler),
    setWallet: (wallet) => {
      store.setState({ coins: wallet.coins, goldBars: wallet.goldBars });
    },
    resolveUpgrade: (next) => {
      store.setState(
        next ? { pendingUpgrade: null, upgradeLevels: next } : { pendingUpgrade: null },
      );
    },
  };
  return {
    ui,
    feedback,
    events,
    seen,
    request(lineId, fromLevel) {
      store.setState({ pendingUpgrade: lineId });
      bus.emit('upgrades:request', { lineId, fromLevel });
    },
  };
}

interface Call {
  readonly body: UpgradeBuyRequest;
  readonly key: IdempotencyKey;
}

function deferredApi() {
  const calls: Call[] = [];
  const pending: { resolve: (r: UpgradeBuyResponse) => void; reject: (e: unknown) => void }[] = [];
  const api: UpgradeApi = {
    buy(body, key) {
      calls.push({ body, key });
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
  };
  return { api, calls, pending };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

class FakeApiRequestError extends Error {
  constructor(readonly code: string) {
    super(`upgradesBuy failed with ${code}`);
    this.name = 'ApiRequestError';
  }
}

describe('upgrade lines v1', () => {
  it('are the six slice lines straight from economy config', () => {
    expect(UPGRADE_LINES_V1.map((line) => line.id)).toEqual([...UPGRADE_LINE_IDS_V1]);
    for (const line of UPGRADE_LINES_V1) {
      expect(upgradeLines).toContain(line);
    }
  });

  it('tell the Family Office lines apart by their global scope', () => {
    const global = upgradeLines.filter((line) => line.scope === 'global');
    expect(global.length).toBeGreaterThan(0);
    for (const line of upgradeLines) {
      expect(isFamilyOfficeLine(line.id)).toBe(line.scope === 'global');
    }
    for (const id of UPGRADE_LINE_IDS_V1) expect(isFamilyOfficeLine(id)).toBe(false);
    expect(isFamilyOfficeLine('notALine')).toBe(false);
  });
});

describe('bindUpgrades', () => {
  it('sends only line, venue and next level with a fresh key, then shows the server result', async () => {
    const h = harness(500, { pusherSpeed: 2 });
    const { api, calls, pending } = deferredApi();
    bindUpgrades({ ui: h.ui, api, venueId: VENUE, events: h.events });

    h.request('pusherSpeed', 2);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ venueId: VENUE, lineId: 'pusherSpeed', level: 3 });
    expect(IdempotencyKeySchema.safeParse(calls[0]?.key).success).toBe(true);
    expect(h.ui.store.getState()).toMatchObject({
      coins: 500,
      pendingUpgrade: 'pusherSpeed',
      upgradeLevels: { pusherSpeed: 2 },
    });

    pending[0]?.resolve(bought('pusherSpeed', 3, 467));
    await settle();
    expect(h.ui.store.getState()).toMatchObject({
      coins: 467,
      goldBars: 3,
      pendingUpgrade: null,
      upgradeLevels: { pusherSpeed: 3 },
    });
    expect(h.seen.map((event) => event.type)).toEqual(['upgrade:requested', 'upgrade:purchased']);
    expect(h.seen[1]?.payload).toMatchObject({ lineId: 'pusherSpeed', level: 3 });
  });

  it('uses a new idempotency key for every purchase', async () => {
    const h = harness(500);
    const { api, calls, pending } = deferredApi();
    bindUpgrades({ ui: h.ui, api, venueId: VENUE, events: h.events });
    h.request('dropRate', 0);
    pending[0]?.resolve(bought('dropRate', 1, 470));
    await settle();
    h.request('dropRate', 1);
    expect(calls[0]?.key).not.toBe(calls[1]?.key);
  });

  it('keeps the wallet and levels untouched and plays deny when the server refuses', async () => {
    const h = harness(10, { coinValue: 0 });
    const { api, pending } = deferredApi();
    let refreshed = 0;
    bindUpgrades({
      ui: h.ui,
      api,
      venueId: VENUE,
      events: h.events,
      refresh: () => (refreshed += 1),
    });
    h.request('coinValue', 0);
    pending[0]?.reject(new FakeApiRequestError('insufficient_funds'));
    await settle();
    expect(h.ui.store.getState()).toMatchObject({
      coins: 10,
      pendingUpgrade: null,
      upgradeLevels: { coinValue: 0 },
    });
    expect(h.feedback).toEqual(['deny']);
    expect(h.seen.at(-1)).toEqual({
      type: 'upgrade:rejected',
      payload: { lineId: 'coinValue', level: 1, reason: 'unaffordable' },
    });
    expect(refreshed).toBe(0);
  });

  it('refreshes state when the levels on screen were stale', async () => {
    const h = harness(1000);
    const { api, pending } = deferredApi();
    let refreshed = 0;
    bindUpgrades({
      ui: h.ui,
      api,
      venueId: VENUE,
      events: h.events,
      refresh: () => (refreshed += 1),
    });
    h.request('crateChance', 0);
    pending[0]?.reject(new FakeApiRequestError('conflict'));
    await settle();
    expect(refreshed).toBe(1);
  });

  it('does not call the server for lines outside the v1 tree', () => {
    const h = harness(1_000_000);
    const { api, calls } = deferredApi();
    bindUpgrades({ ui: h.ui, api, venueId: VENUE, events: h.events });
    h.request('fusionWindow', 0);
    expect(calls).toHaveLength(0);
    expect(h.ui.store.getState().pendingUpgrade).toBeNull();
    expect(h.seen).toEqual([
      {
        type: 'upgrade:rejected',
        payload: { lineId: 'fusionWindow', level: 1, reason: 'unavailable' },
      },
    ]);
  });

  it('hands Family Office lines to the ascension module instead of buying them for the venue', () => {
    const h = harness(1_000_000, { trustFund: 0 });
    const { api, calls } = deferredApi();
    const handed: string[] = [];
    bindUpgrades({
      ui: h.ui,
      api,
      venueId: VENUE,
      events: h.events,
      onFamilyOffice: (lineId) => handed.push(lineId),
    });
    h.request('trustFund', 0);
    expect(calls).toHaveLength(0);
    expect(handed).toEqual(['trustFund']);
    expect(h.ui.store.getState()).toMatchObject({
      pendingUpgrade: null,
      upgradeLevels: { trustFund: 0 },
    });
    expect(h.seen).toEqual([]);
    expect(h.feedback).toEqual([]);

    h.request('pusherSpeed', 0);
    expect(handed).toEqual(['trustFund']);
    expect(calls.map((call) => call.body.lineId)).toEqual(['pusherSpeed']);
  });

  it('refuses a Family Office line as unavailable when nothing takes the handoff', () => {
    const h = harness(1_000_000);
    const { api, calls } = deferredApi();
    bindUpgrades({ ui: h.ui, api, venueId: VENUE, events: h.events });
    h.request('trustFund', 0);
    expect(calls).toHaveLength(0);
    expect(h.seen).toEqual([
      {
        type: 'upgrade:rejected',
        payload: { lineId: 'trustFund', level: 1, reason: 'unavailable' },
      },
    ]);
  });

  it('buys for the venue being played when given a getter, so an ascension moves purchases', () => {
    const h = harness(1_000_000);
    const { api, calls } = deferredApi();
    const paris = endpoints.upgradesBuy.body.shape.venueId.parse('salonDeParis');
    let playing = VENUE;
    bindUpgrades({ ui: h.ui, api, venueId: () => playing, events: h.events });
    h.request('dropRate', 0);
    playing = paris;
    h.request('dropRate', 0);
    expect(calls.map((call) => call.body.venueId)).toEqual([VENUE, paris]);
  });

  it('reports unexpected errors and ignores answers that arrive after dispose', async () => {
    const h = harness(1000);
    const { api, pending } = deferredApi();
    const errors: unknown[] = [];
    const dispose = bindUpgrades({
      ui: h.ui,
      api,
      venueId: VENUE,
      events: h.events,
      onError: (error) => errors.push(error),
    });
    h.request('vaultCapacity', 0);
    const boom = new TypeError('contract violation');
    pending[0]?.reject(boom);
    await settle();
    expect(errors).toEqual([boom]);

    h.request('vaultCapacity', 0);
    dispose();
    pending[1]?.resolve(bought('vaultCapacity', 1, 0));
    await settle();
    expect(h.ui.store.getState().coins).toBe(1000);
  });
});

describe('classifyRejection', () => {
  it('maps server codes and network failures to what the player is told', () => {
    expect(classifyRejection(new FakeApiRequestError('insufficient_funds'))).toBe('unaffordable');
    expect(classifyRejection(new FakeApiRequestError('conflict'))).toBe('stale');
    expect(classifyRejection(new FakeApiRequestError('not_found'))).toBe('unavailable');
    expect(classifyRejection(new FakeApiRequestError('feature_disabled'))).toBe('unavailable');
    expect(classifyRejection(new FakeApiRequestError('rate_limited'))).toBe('error');
    expect(classifyRejection(new FakeApiRequestError('made_up'))).toBe('error');
    const network = new Error('offline');
    network.name = 'NetworkError';
    expect(classifyRejection(network)).toBe('offline');
    expect(classifyRejection('nope')).toBe('error');
  });
});

describe('upgrade feedback', () => {
  it('chimes after a confirmed purchase and announces a refusal in the current language', () => {
    const i18n = createI18n({ language: 'fr', resources: { en: {}, fr: {}, de: {} } });
    registerUpgradeStrings(i18n);
    const events = createBus<UpgradeEvents>();
    const played: ImpactEvent[] = [];
    const notices: string[] = [];
    const delays: number[] = [];
    bindUpgradeFeedback({
      events,
      i18n,
      audio: () => ({ playImpact: (event) => played.push(event) }),
      notify: (message) => notices.push(message),
      delay: (run, ms) => {
        delays.push(ms);
        run();
        return () => undefined;
      },
    });
    events.emit('upgrade:purchased', { lineId: 'dropRate', level: 1, wallet: walletWith(1) });
    expect(played).toEqual(PURCHASE_CHIME.map((note) => note.sound));
    expect(delays).toEqual(PURCHASE_CHIME.map((note) => note.delayMs));

    events.emit('upgrade:rejected', { lineId: 'dropRate', level: 2, reason: 'offline' });
    expect(notices).toEqual([UPGRADE_STRINGS.fr.rejected.offline]);
  });

  it('silences chime notes still pending when it is disposed', () => {
    const i18n = createI18n({ language: 'en', resources: { en: {}, fr: {}, de: {} } });
    registerUpgradeStrings(i18n);
    const events = createBus<UpgradeEvents>();
    const played: ImpactEvent[] = [];
    const notices: string[] = [];
    const queued = new Map<number, () => void>();
    let nextId = 0;
    const dispose = bindUpgradeFeedback({
      events,
      i18n,
      audio: () => ({ playImpact: (event) => played.push(event) }),
      notify: (message) => notices.push(message),
      delay: (run, ms) => {
        const id = nextId++;
        if (ms === 0) run();
        else queued.set(id, run);
        return () => queued.delete(id);
      },
    });
    events.emit('upgrade:purchased', { lineId: 'dropRate', level: 1, wallet: walletWith(1) });
    expect(played).toEqual([PURCHASE_CHIME[0]?.sound]);
    expect(queued.size).toBe(PURCHASE_CHIME.length - 1);

    dispose();
    expect(queued.size).toBe(0);
    expect(played).toHaveLength(1);
    expect(notices).toEqual([]);
  });
});

describe('upgrade strings', () => {
  function keys(tree: ResourceTree, prefix = ''): string[] {
    return Object.entries(tree).flatMap(([key, value]) =>
      typeof value === 'string' ? [`${prefix}${key}`] : keys(value, `${prefix}${key}.`),
    );
  }

  it('ship the same keys in EN, FR and DE, and resolve through i18next', () => {
    const english = keys(UPGRADE_STRINGS.en).sort();
    for (const language of LANGUAGES)
      expect(keys(UPGRADE_STRINGS[language]).sort()).toEqual(english);
    const i18n = createI18n({ language: 'de', resources: { en: {}, fr: {}, de: {} } });
    registerUpgradeStrings(i18n);
    for (const reason of ['unaffordable', 'stale', 'unavailable', 'offline', 'error'] as const) {
      expect(i18n.t(rejectionKey(reason))).toBe(UPGRADE_STRINGS.de.rejected[reason]);
    }
  });
});

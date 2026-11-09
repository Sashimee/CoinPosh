import {
  endpoints,
  IdempotencyKeySchema,
  UpgradeLineIdSchema,
  type StateResponse,
} from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import { createBus } from '../../app/bus.ts';
import { defaultSettings } from '../../app/settings.ts';
import { initialUiState, type UiEvents, type UiState } from '../../app/state.ts';
import { createStore } from '../../app/store.ts';
import type { Scheduler } from '../../net/connectivity.ts';
import { createNet, type Net } from '../../net/index.ts';
import { netUpgradeApi } from './api.ts';
import { bindUpgrades, type UpgradeUi } from './controller.ts';
import type { UpgradeEvents } from './events.ts';

const manualScheduler: Scheduler = { setTimeout: () => ({}), clearTimeout: () => undefined };

function rethrow(error: unknown): never {
  throw error instanceof Error ? error : new Error(String(error));
}

const EARNED_COINS = 5_000;
const DROP_RATE = UpgradeLineIdSchema.parse('dropRate');

/** A Demo player who has already earned enough coins to buy upgrades. */
async function demoNet(): Promise<{ net: Net; state: StateResponse }> {
  const net = await createNet({
    mode: { kind: 'demo' },
    locale: () => 'en',
    turnstileToken: () => Promise.reject(new Error('Demo Mode must not ask for Turnstile.')),
    onError: rethrow,
    scheduler: manualScheduler,
    monotonic: () => 0,
  });
  await net.client.call('state');
  const playerId = net.session.playerId;
  const player = playerId === null ? undefined : net.mock?.world.player(playerId);
  if (!player) throw new Error('Expected the Demo Mode player after sign-up');
  player.wallet = { ...player.wallet, coins: EARNED_COINS };
  return { net, state: await net.client.call('state', { query: { hydrate: 'boot' } }) };
}

/** The UiApp's store semantics, seeded from GET /v1/state the way main.ts seeds them. */
function uiFrom(state: StateResponse): UpgradeUi & { request(lineId: string): void } {
  const store = createStore<UiState>({
    ...initialUiState(defaultSettings('en')),
    coins: state.wallet.coins,
    goldBars: state.wallet.goldBars,
    upgradeLevels: state.venue.upgrades,
  });
  const bus = createBus<UiEvents>();
  return {
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
    request(lineId) {
      store.setState({ pendingUpgrade: lineId });
      bus.emit('upgrades:request', {
        lineId,
        fromLevel: store.getState().upgradeLevels[lineId] ?? 0,
      });
    },
  };
}

function nextEvent<K extends keyof UpgradeEvents>(
  events: ReturnType<typeof createBus<UpgradeEvents>>,
  type: K,
): Promise<UpgradeEvents[K]> {
  return new Promise((resolve) => {
    const off = events.on(type, (payload) => {
      off();
      resolve(payload);
    });
  });
}

describe('netUpgradeApi in Demo Mode', () => {
  it('buys through upgradesBuy on a confirm and shows the wallet and level the server kept', async () => {
    const { net, state } = await demoNet();
    const ui = uiFrom(state);
    const events = createBus<UpgradeEvents>();
    const unbind = bindUpgrades({
      ui,
      api: netUpgradeApi(net.client),
      venueId: state.venue.id,
      events,
    });
    const before = state.venue.upgrades[DROP_RATE] ?? 0;

    const purchased = nextEvent(events, 'upgrade:purchased');
    ui.request(DROP_RATE);
    const result = await purchased;

    const after = await net.client.call('state');
    expect(result.level).toBe(before + 1);
    expect(after.venue.upgrades[DROP_RATE]).toBe(before + 1);
    expect(after.wallet.coins).toBeLessThan(state.wallet.coins);
    expect(ui.store.getState()).toMatchObject({
      coins: after.wallet.coins,
      pendingUpgrade: null,
      upgradeLevels: { [DROP_RATE]: before + 1 },
    });
    unbind();
    net.table.close();
  });

  it('replays a resent purchase instead of buying the level twice', async () => {
    const { net, state } = await demoNet();
    const api = netUpgradeApi(net.client);
    const body = endpoints.upgradesBuy.body.parse({
      venueId: state.venue.id,
      lineId: DROP_RATE,
      level: (state.venue.upgrades[DROP_RATE] ?? 0) + 1,
    });
    const key = IdempotencyKeySchema.parse(crypto.randomUUID());

    const first = await api.buy(body, key);
    const resent = await api.buy(body, key);

    expect(resent).toEqual(first);
    const after = await net.client.call('state');
    expect(after.venue.upgrades[DROP_RATE]).toBe(body.level);
    expect(after.wallet).toEqual(first.wallet);
    net.table.close();
  });

  it('surfaces the server refusal when the level on screen is stale', async () => {
    const { net, state } = await demoNet();
    const ui = uiFrom(state);
    const events = createBus<UpgradeEvents>();
    let refreshed = 0;
    const unbind = bindUpgrades({
      ui,
      api: netUpgradeApi(net.client),
      venueId: state.venue.id,
      events,
      refresh: () => {
        refreshed += 1;
      },
    });
    ui.store.setState({ upgradeLevels: { [DROP_RATE]: 5 } });

    const rejected = nextEvent(events, 'upgrade:rejected');
    ui.request(DROP_RATE);

    expect(await rejected).toMatchObject({ lineId: DROP_RATE, level: 6, reason: 'stale' });
    expect(refreshed).toBe(1);
    expect((await net.client.call('state')).wallet).toEqual(state.wallet);
    unbind();
    net.table.close();
  });
});

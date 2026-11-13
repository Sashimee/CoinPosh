import { upgradeLines, upgradeStat } from '@coinposh/economy';
import {
  UpgradeLineIdSchema,
  VenueIdSchema,
  type NudgeDirection,
  type StateResponse,
} from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import { createBus } from '../../app/bus.ts';
import type { DecorumState } from '../../app/model.ts';
import { defaultSettings } from '../../app/settings.ts';
import { initialUiState, type UiEvents, type UiState } from '../../app/state.ts';
import { createStore } from '../../app/store.ts';
import type { Scheduler } from '../../net/connectivity.ts';
import { createNet, type Net } from '../../net/index.ts';
import type { CoinTransformTarget } from '../simWorker/interpolate.ts';
import { netUpgradeApi } from '../upgrades/api.ts';
import { bindUpgrades, type UpgradeUi } from '../upgrades/controller.ts';
import type { UpgradeEvents } from '../upgrades/events.ts';
import { createSystemsCore, followUpgradeLevels, type SimPort } from './core.ts';
import {
  MIN_TICKS_BETWEEN_DROPS,
  POUR_STREAM_TICKS,
  decorumCapacity,
  pourStreamTicks,
} from './tuning.ts';

const DROP_RATE = UpgradeLineIdSchema.parse('dropRate');
const DROP_RATE_LINE = upgradeLines.find((line) => line.id === 'dropRate');
const DECORUM_LINE = upgradeLines.find((line) => line.effect.stat === 'decorumCapacity');
if (!DROP_RATE_LINE || !DECORUM_LINE) {
  throw new Error('packages/economy upgradeLines lost the dropRate or decorumCapacity line.');
}
const VENUE = VenueIdSchema.parse('rivieraYacht');

const manualScheduler: Scheduler = { setTimeout: () => ({}), clearTimeout: () => undefined };

function rethrow(error: unknown): never {
  throw error instanceof Error ? error : new Error(String(error));
}

/** A Demo Mode player rich enough to buy every dropRate level. */
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
  player.wallet = { ...player.wallet, coins: 10_000_000 };
  const state = await net.client.call('state', { query: { hydrate: 'boot' } });
  net.table.hydrate(state);
  return { net, state };
}

/** The UiApp's store, seeded from GET /v1/state the way main.ts seeds it. */
function uiFrom(state: StateResponse): UpgradeUi & { request(lineId: string): void } {
  const store = createStore<UiState>({
    ...initialUiState(defaultSettings('en')),
    coins: state.wallet.coins,
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
      bus.emit('upgrades:request', {
        lineId,
        fromLevel: store.getState().upgradeLevels[lineId] ?? 0,
      });
    },
  };
}

class TickSim implements SimPort {
  readonly stats = { tick: 0, renderTick: 0 };
  readonly failure = null;
  readonly nudges: NudgeDirection[] = [];

  readonly drops: number[] = [];

  drop(xMm: number): void {
    this.drops.push(xMm);
  }

  nudge(direction: NudgeDirection): void {
    this.nudges.push(direction);
  }

  sync(target: CoinTransformTarget): void {
    target.setTransforms('copper', [], [], 0, []);
  }

  /** This sim reports nothing: the tests watch the systems' own events instead. */
  onEvents(): () => void {
    return () => undefined;
  }
}

/** The systems on a Demo Mode table, following the store as main.ts wires them. */
async function play() {
  const { net, state } = await demoNet();
  const ui = uiFrom(state);
  const sim = new TickSim();
  const decorum: DecorumState[] = [];
  const core = createSystemsCore({
    sim,
    table: net.table,
    clock: net.clock,
    ui: {
      setCascade: () => undefined,
      setDecorum: (shown) => decorum.push(shown),
      feedback: () => undefined,
    },
    bounds: { fieldHalfWidth: 0.28, fieldFrontZ: 0.36 },
    now: () => 0,
  });
  const unfollow = followUpgradeLevels(ui.store, core);
  core.hydrate(state);
  const events = createBus<UpgradeEvents>();
  const unbind = bindUpgrades({
    ui,
    api: netUpgradeApi(net.client),
    venueId: state.venue.id,
    events,
  });

  const buy = async (lineId: string): Promise<UpgradeEvents['upgrade:purchased']> => {
    const purchased = new Promise<UpgradeEvents['upgrade:purchased']>((resolve, reject) => {
      const offs = [
        events.on('upgrade:purchased', (payload) => {
          for (const off of offs) off();
          resolve(payload);
        }),
        events.on('upgrade:rejected', ({ reason }) => {
          for (const off of offs) off();
          reject(new Error(`The Demo server refused the ${lineId} purchase: ${reason}`));
        }),
      ];
    });
    ui.request(lineId);
    return purchased;
  };

  /** Holds a pour for `ticks` sim ticks, then waits out the cooldown; returns the drops sent. */
  const pourFor = (ticks: number): number => {
    let sent = 0;
    const off = core.events.on('drop:requested', () => {
      sent += 1;
    });
    core.startPour(0);
    for (let i = 0; i < ticks; i += 1) {
      sim.stats.tick += 1;
      core.update();
    }
    core.cancelPour();
    off();
    sim.stats.tick += MIN_TICKS_BETWEEN_DROPS;
    return sent;
  };

  const close = (): void => {
    unbind();
    unfollow();
    core.dispose();
    net.table.close();
  };
  return { net, state, ui, sim, core, events, decorum, buy, pourFor, close };
}

describe('pourStreamTicks', () => {
  it('is the base cadence at level 0 and never quicker than the tap cooldown', () => {
    expect(pourStreamTicks({}, VENUE)).toBe(POUR_STREAM_TICKS);
    expect(pourStreamTicks({ dropRate: 0 }, VENUE)).toBe(POUR_STREAM_TICKS);
    expect(pourStreamTicks({ dropRate: DROP_RATE_LINE.maxLevel }, VENUE)).toBe(
      MIN_TICKS_BETWEEN_DROPS,
    );
  });

  it('speeds up with every dropRate level until the cooldown floor', () => {
    let previous = POUR_STREAM_TICKS;
    let floorReached = false;
    for (let level = 1; level <= DROP_RATE_LINE.maxLevel; level += 1) {
      const cadence = pourStreamTicks({ dropRate: level }, VENUE);
      if (floorReached) {
        expect(cadence).toBe(MIN_TICKS_BETWEEN_DROPS);
      } else {
        expect(cadence).toBeLessThan(previous);
      }
      floorReached = cadence === MIN_TICKS_BETWEEN_DROPS;
      previous = cadence;
    }
  });

  it('refuses a level the economy does not have instead of guessing a cadence', () => {
    expect(() => pourStreamTicks({ dropRate: DROP_RATE_LINE.maxLevel + 1 }, VENUE)).toThrow(
      RangeError,
    );
  });
});

describe('upgrade levels apply live to the game systems (Demo Mode)', () => {
  it('a confirmed dropRate purchase at level 0 speeds the next pour, with no reload', async () => {
    const game = await play();
    expect(game.state.venue.upgrades[DROP_RATE] ?? 0).toBe(0);
    expect(game.core.tuning.pourStreamTicks).toBe(POUR_STREAM_TICKS);
    const before = game.pourFor(600);

    const purchased = await game.buy(DROP_RATE);

    expect(purchased.level).toBe(1);
    expect(game.core.tuning.pourStreamTicks).toBe(
      pourStreamTicks({ ...game.state.venue.upgrades, [DROP_RATE]: 1 }, game.state.venue.id),
    );
    expect(game.core.tuning.pourStreamTicks).toBeLessThan(POUR_STREAM_TICKS);
    expect(game.pourFor(600)).toBeGreaterThan(before);
    game.close();
  });

  it('at the max dropRate level the pour runs at the cooldown floor and a further buy changes nothing', async () => {
    const game = await play();
    for (let level = 1; level <= DROP_RATE_LINE.maxLevel; level += 1) {
      expect((await game.buy(DROP_RATE)).level).toBe(level);
    }
    expect(game.core.tuning.pourStreamTicks).toBe(MIN_TICKS_BETWEEN_DROPS);
    const ticks = 600;
    expect(game.pourFor(ticks)).toBe(Math.floor(ticks / MIN_TICKS_BETWEEN_DROPS) + 1);

    await expect(game.buy(DROP_RATE)).rejects.toThrow(/refused the dropRate purchase/);
    expect(game.ui.store.getState().upgradeLevels[DROP_RATE]).toBe(DROP_RATE_LINE.maxLevel);
    expect(game.core.tuning.pourStreamTicks).toBe(MIN_TICKS_BETWEEN_DROPS);
    game.close();
  });

  it('Decorum capacity follows the store at level 0 and at the max level', async () => {
    const game = await play();
    const base = upgradeStat(DECORUM_LINE, 0);
    expect(game.core.tuning.decorumCapacity).toBe(base);
    expect(game.decorum.at(-1)?.capacity).toBe(base);

    game.ui.store.setState({ upgradeLevels: { [DECORUM_LINE.id]: DECORUM_LINE.maxLevel } });

    const max = decorumCapacity({ [DECORUM_LINE.id]: DECORUM_LINE.maxLevel });
    expect(max).toBe(upgradeStat(DECORUM_LINE, DECORUM_LINE.maxLevel));
    expect(max).toBeGreaterThan(base);
    expect(game.core.tuning.decorumCapacity).toBe(max);
    expect(game.decorum.at(-1)?.capacity).toBe(max);
    game.close();
  });

  it('Demo Mode stays playable after upgrades: taps drop and nudges land', async () => {
    const game = await play();
    await game.buy(DROP_RATE);
    await game.buy(UpgradeLineIdSchema.parse('coinValue'));
    expect(game.core.drop(0)).toBe(true);
    game.sim.stats.tick += MIN_TICKS_BETWEEN_DROPS;
    expect(game.core.drop(0.3)).toBe(true);
    expect(game.sim.drops).toHaveLength(2);
    expect(game.core.nudge('forward', 1, 'key')).toBe(true);
    expect(game.sim.nudges).toEqual(['forward']);
    game.close();
  });

  it('stops following the store once disposed', async () => {
    const game = await play();
    const shown = game.core.tuning;
    game.close();
    game.ui.store.setState({ upgradeLevels: { [DROP_RATE]: 5 } });
    expect(game.core.tuning).toBe(shown);
  });
});

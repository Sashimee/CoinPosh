import { crateSpawn, pity as pityConfig } from '@coinposh/economy';
import {
  RARITIES,
  type CoinId,
  type CrateId,
  type PlayerId,
  type Reward,
  type Roll,
} from '@coinposh/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBus } from '../../app/bus.ts';
import type { ImpactEvent } from '../../audio/index.ts';
import type { DuckOptions } from '../../audio/index.ts';
import { createI18n, LANGUAGES, type ResourceTree } from '../../i18n/index.ts';
import type { Connectivity, Scheduler } from '../../net/connectivity.ts';
import { MOCK_RULES } from '../../net/mock/rules.ts';
import type { MockServer } from '../../net/mock/server.ts';
import { Outbox } from '../../net/outbox.ts';
import { TableSync } from '../../net/tableSync.ts';
import {
  FakeTime,
  connectPlayer,
  createMockServer,
  ledgerWallet,
  requirePlayerId,
  serverWallet,
  type Player,
} from '../../net/test/harness.ts';
import { bindCrateAudio, stingerDuck } from './audio.ts';
import { CrateController } from './controller.ts';
import type { CrateEvents } from './events.ts';
import { CRATES_STRINGS, cratesKey, registerCratesStrings } from './i18n.ts';
import { heroOf, pityOutlook, rewardLines } from './loot.ts';
import { CRATE_RIDE_SECONDS, CrateRide } from './ride.ts';

const manualScheduler: Scheduler = { setTimeout: () => ({}), clearTimeout: () => undefined };
const offlineNever: Connectivity = { onOnline: () => () => undefined };

function rethrow(error: unknown): never {
  throw error instanceof Error ? error : new Error(String(error));
}

const crate = (id: string) => ({ id: id as CrateId, kind: 'vault' as const });

/** The pusher's extension over a 4 s stroke, as the bridge reports it. */
function strokeAt(seconds: number): number {
  return 0.5 - 0.5 * Math.cos((seconds / 4) * Math.PI * 2);
}

function rideToEdge(ride: CrateRide, step = 1 / 60, stroke = strokeAt): number {
  let t = 0;
  while (ride.phase !== 'fell' && t < CRATE_RIDE_SECONDS.max + 1) {
    t += step;
    ride.update(step, stroke(t));
  }
  return t;
}

describe('CrateRide', () => {
  it('rides the pusher to the lip and over it inside the economy envelope', () => {
    const ride = new CrateRide(crate('crate_AAAAAAAAAAAAAAAA'), 0);
    const phases = new Set<string>();
    let t = 0;
    while (ride.phase !== 'fell') {
      t += 1 / 60;
      phases.add(ride.update(1 / 60, strokeAt(t)));
    }
    expect([...phases]).toEqual(['riding', 'teeter', 'fell']);
    expect(t).toBeGreaterThanOrEqual(CRATE_RIDE_SECONDS.min);
    expect(t).toBeLessThan(20);
  });

  it('never tips before the minimum, however hard the table is shoved', () => {
    const ride = new CrateRide(crate('crate_BBBBBBBBBBBBBBBB'), 0);
    for (let i = 0; i < 50; i++) ride.nudge('forward', 1);
    expect(ride.phase).toBe('teeter');
    ride.update(CRATE_RIDE_SECONDS.min - 0.1, 0);
    expect(ride.phase).toBe('teeter');
    ride.update(0.2, 0);
    ride.nudge('forward', 1);
    ride.nudge('forward', 1);
    expect(ride.phase).toBe('fell');
  });

  it('is pushed off by the maximum even with the pusher frozen', () => {
    const ride = new CrateRide(crate('crate_CCCCCCCCCCCCCCCC'), 0);
    const t = rideToEdge(ride, 1 / 30, () => 0);
    expect(ride.phase).toBe('fell');
    expect(t).toBeLessThanOrEqual(CRATE_RIDE_SECONDS.max + 1 / 30);
  });

  it('steps down to the lower tier, pitches over the lip, and ignores input once gone', () => {
    const ride = new CrateRide(crate('crate_DDDDDDDDDDDDDDDD'), 0);
    expect(ride.position.y).toBeGreaterThan(0);
    expect(ride.tilt).toBe(0);
    rideToEdge(ride);
    expect(ride.position.y).toBe(0);
    expect(ride.tilt).toBeGreaterThan(1);
    const at = ride.position;
    ride.nudge('left', 1);
    expect(ride.update(1, 1)).toBe('fell');
    expect(ride.position).toEqual(at);
  });

  it('treats a bad frame delta or stroke as no motion', () => {
    const ride = new CrateRide(crate('crate_EEEEEEEEEEEEEEEE'), 0);
    const z = ride.position.z;
    ride.update(Number.NaN, Number.NaN);
    ride.update(-1, Number.POSITIVE_INFINITY);
    expect(ride.position.z).toBe(z);
    expect(ride.seconds).toBe(0);
  });

  it('keeps side nudges on the table', () => {
    const ride = new CrateRide(crate('crate_FFFFFFFFFFFFFFFF'), 0);
    for (let i = 0; i < 100; i++) ride.nudge('right', 1);
    expect(ride.position.x).toBeLessThan(0.18);
    for (let i = 0; i < 200; i++) ride.nudge('left', 1);
    expect(ride.position.x).toBeGreaterThan(-0.18);
  });
});

describe('pityOutlook', () => {
  const [rare, exquisite] = pityConfig.rules;

  it('reads the full window on fresh counters', () => {
    expect(pityOutlook({ rare: 0, exquisite: 0, legendary: 0 })).toEqual({
      rarity: 'rare',
      within: rare.within,
    });
  });

  it('names the guarantee that lands soonest, down to the next crate', () => {
    expect(pityOutlook({ rare: 0, exquisite: exquisite.within - 2, legendary: 0 })).toEqual({
      rarity: 'exquisite',
      within: 2,
    });
    expect(pityOutlook({ rare: rare.within - 1, exquisite: 0, legendary: 0 })).toEqual({
      rarity: 'rare',
      within: 1,
    });
  });

  it('refuses counters past their guarantee, since the server should have forced the floor', () => {
    expect(() => pityOutlook({ rare: rare.within, exquisite: 0, legendary: 0 })).toThrow(
      /past its/,
    );
  });
});

describe('reward lines', () => {
  const rewards: Reward[] = [
    { kind: 'currency', currency: 'coins', amount: 30 },
    { kind: 'currency', currency: 'pearls', amount: 2 },
    {
      kind: 'charm',
      charmId: 'charm_AAAAAAAAAAAAAAAA' as never,
      charmType: 'butler' as never,
      level: 2,
      duplicate: true,
    },
    { kind: 'currency', currency: 'coins', amount: 12 },
  ];

  it('puts items first and merges currencies in wallet order', () => {
    expect(rewardLines(rewards)).toEqual([
      { kind: 'charm', level: 2, duplicate: true },
      { kind: 'currency', currency: 'coins', amount: 42 },
      { kind: 'currency', currency: 'pearls', amount: 2 },
    ]);
  });

  it('picks the rarest kind of thing for the pedestal', () => {
    expect(heroOf(rewards)).toBe('charm');
    expect(heroOf([{ kind: 'currency', currency: 'coins', amount: 1 }])).toBe('coins');
    expect(
      heroOf([
        { kind: 'currency', currency: 'coins', amount: 1 },
        { kind: 'currency', currency: 'keys', amount: 1 },
      ]),
    ).toBe('keys');
    expect(rewardLines([])).toEqual([]);
  });
});

describe('crate strings', () => {
  function keys(tree: ResourceTree, prefix = ''): string[] {
    return Object.entries(tree).flatMap(([key, value]) =>
      typeof value === 'string' ? [`${prefix}${key}`] : keys(value, `${prefix}${key}.`),
    );
  }

  it('cover the same keys in EN, FR and DE, with every rarity named', () => {
    const english = keys(CRATES_STRINGS.en);
    for (const language of LANGUAGES) {
      const strings = CRATES_STRINGS[language];
      expect(keys(strings).sort()).toEqual([...english].sort());
      for (const rarity of RARITIES) expect(strings.rarity[rarity].length).toBeGreaterThan(0);
    }
  });

  it('resolve through i18next with interpolation', () => {
    const i18n = createI18n({ language: 'fr', resources: { en: {}, fr: {}, de: {} } });
    registerCratesStrings(i18n);
    expect(i18n.t(cratesKey('pity'), { rarity: 'Rare', count: 4 })).toBe(
      'Rare ou mieux garanti d’ici 4 caisses',
    );
    i18n.changeLanguage('de');
    expect(i18n.t(cratesKey('rarity.legendary'))).toBe('Legendär');
  });
});

describe('crate audio', () => {
  it('ducks the music under a reveal and voices each stinger, deeper for rarer crates', () => {
    const events = createBus<CrateEvents>();
    const ducks: DuckOptions[] = [];
    const impacts: ImpactEvent[] = [];
    const off = bindCrateAudio(events, {
      duckMusic: (duck) => ducks.push(duck ?? {}),
      playImpact: (impact) => impacts.push(impact),
    });
    events.emit('crate:stinger', { cue: 'shudder', rarity: 'rare', step: 2, duckSeconds: 0 });
    expect(ducks).toEqual([]);
    expect(impacts).toHaveLength(1);
    events.emit('crate:stinger', { cue: 'burst', rarity: 'legendary', step: 1, duckSeconds: 2 });
    expect(ducks).toEqual([stingerDuck('legendary', 2)]);
    expect(impacts.length).toBeGreaterThan(1);
    expect(stingerDuck('legendary', 2).depthDb).toBeLessThan(stingerDuck('fine', 2).depthDb ?? 0);
    off();
    events.emit('crate:stinger', { cue: 'burst', rarity: 'rare', step: 1, duckSeconds: 2 });
    expect(ducks).toHaveLength(1);
  });
});

describe('crates against the Demo Mode server', () => {
  let time: FakeTime;
  let server: MockServer;
  let player: Player;
  let playerId: PlayerId;

  beforeEach(async () => {
    time = new FakeTime();
    server = createMockServer({ now: time.now });
    player = await connectPlayer(server, time);
  });

  async function setup() {
    const outbox = await Outbox.open(player.store, rethrow);
    const table = new TableSync({
      client: player.client,
      outbox,
      connectivity: offlineNever,
      scheduler: manualScheduler,
      jitter: () => 0,
      onError: rethrow,
    });
    table.hydrate(await player.client.call('state'));
    await table.flush();
    playerId = requirePlayerId(player);
    let seconds = 0;
    const sim = {
      stats: {
        get tick() {
          return time.tick();
        },
        get pusherStroke() {
          return strokeAt(seconds);
        },
      },
    };
    const events = createBus<CrateEvents>();
    const log: { type: keyof CrateEvents; crateId?: CrateId }[] = [];
    const opened: { crateId: CrateId; roll: Roll }[] = [];
    const record =
      <K extends keyof CrateEvents>(type: K) =>
      (payload: CrateEvents[K]) => {
        log.push({ type, ...('crateId' in payload ? { crateId: payload.crateId } : {}) });
      };
    for (const type of [
      'crate:spawned',
      'crate:teeter',
      'crate:fell',
      'crate:claimed',
      'crate:rejected',
      'crate:failed',
      'crate:opened',
      'crate:pity',
    ] as const) {
      events.on(type, record(type));
    }
    events.on('crate:opened', ({ crateId, roll }) => opened.push({ crateId, roll }));
    const controller = new CrateController({ table, client: player.client, sim, events });
    let drops = 0;
    const falling: CoinId[] = [];

    /** One player drop; the coin from the drop before it goes out the front, as a real heap pays. */
    const drop = async () => {
      time.advance(250);
      seconds += 0.25;
      controller.update(0.25);
      const ticket = table.drop(0, time.tick());
      if (!ticket?.coin) throw new Error('Expected a buffered coin to drop.');
      drops += 1;
      await table.flush();
      const previous = falling.shift();
      if (previous !== undefined) {
        time.advance(MOCK_RULES.minFallMsAfterDrop);
        table.claimFall(previous, time.tick(), 'front');
        await table.flush();
      }
      falling.push(ticket.coin.id);
    };

    /** Lets the table run with no drops until the crates on it have gone over and opened. */
    const play = async (maxSeconds: number) => {
      for (let t = 0; t < maxSeconds && controller.riding.length > 0; t += 0.1) {
        time.advance(100);
        seconds += 0.1;
        controller.update(0.1);
        await table.flush();
      }
      await table.flush();
      await controller.settled();
    };

    return {
      table,
      controller,
      events,
      log,
      opened,
      drop,
      play,
      get drops() {
        return drops;
      },
      get seconds() {
        return seconds;
      },
    };
  }

  function expectConserved(): void {
    expect(ledgerWallet(server, playerId)).toEqual(serverWallet(server, playerId));
  }

  it('scripts the FTUE crate at drop 12, rides it off the front, claims it and opens a fine charm crate', async () => {
    const game = await setup();
    let spawnedAt = 0;
    while (game.log.every((entry) => entry.type !== 'crate:spawned')) {
      await game.drop();
      spawnedAt = game.drops;
      if (game.drops > crateSpawn.ftueScriptedDrop) break;
    }
    expect(spawnedAt).toBe(crateSpawn.ftueScriptedDrop);
    const spawnSeconds = game.seconds;
    await game.play(CRATE_RIDE_SECONDS.max + 1);
    const crateId = game.log.find((entry) => entry.type === 'crate:spawned')?.crateId;
    expect(
      game.log.filter((entry) => entry.crateId === crateId).map((entry) => entry.type),
    ).toEqual(['crate:spawned', 'crate:teeter', 'crate:fell', 'crate:claimed', 'crate:opened']);
    expect(game.log.at(-1)?.type).toBe('crate:pity');
    const [first] = game.opened;
    expect(first?.crateId).toBe(crateId);
    expect(first?.roll.rarity).toBe(crateSpawn.ftueScriptedRarity);
    expect(first?.roll.rewards.some((reward) => reward.kind === 'charm')).toBe(
      crateSpawn.ftueScriptedCharm,
    );
    const rideSeconds = game.seconds - spawnSeconds;
    expect(rideSeconds).toBeGreaterThanOrEqual(CRATE_RIDE_SECONDS.min);
    expect(spawnSeconds + rideSeconds).toBeLessThan(45);
    expect(game.controller.riding).toHaveLength(0);
    expect(serverWallet(server, playerId).pearls).toBeGreaterThan(0);
    expectConserved();
  });

  it('reports a crate the server already settled as rejected, and opens nothing', async () => {
    const game = await setup();
    while (game.controller.riding.length === 0) await game.drop();
    const [ride] = game.controller.riding;
    if (!ride) throw new Error('Expected a crate on the table.');
    time.advance(100);
    await player.client.call('tableClaims', {
      body: {
        claims: [{ kind: 'crate', crateId: ride.crate.id, tick: time.tick(), edge: 'left' }],
      },
    });
    await game.play(CRATE_RIDE_SECONDS.max + 1);
    expect(game.log.filter((entry) => entry.crateId === ride.crate.id).map((e) => e.type)).toEqual([
      'crate:spawned',
      'crate:teeter',
      'crate:fell',
      'crate:rejected',
    ]);
    expect(game.opened).toHaveLength(0);
    expectConserved();
  });

  it('carries the server pity counters through every open and lands the guaranteed floor', async () => {
    const game = await setup();
    const rare = pityConfig.rules.find((rule) => rule.rarity === 'rare');
    if (!rare) throw new Error('Expected a rare pity rule');
    const pityReports: CrateEvents['crate:pity']['pity'][] = [];
    game.events.on('crate:pity', ({ pity }) => pityReports.push(pity));

    const openNext = async () => {
      const before = game.opened.length;
      while (game.controller.riding.length === 0) await game.drop();
      await game.play(CRATE_RIDE_SECONDS.max + 1);
      expect(game.opened).toHaveLength(before + 1);
      const roll = game.opened.at(-1)?.roll;
      if (!roll) throw new Error('Expected an opened crate');
      return roll;
    };

    const ftue = await openNext();
    expect(ftue.pity).toEqual({ rare: 0, exquisite: 0, legendary: 0 });

    const mock = server.world.player(playerId);
    if (!mock) throw new Error('Expected the mock player');
    mock.pity.set('vaultCrate', { rare: rare.within - 1, exquisite: 3, legendary: 7 });
    const forced = await openNext();
    expect(RARITIES.indexOf(forced.rarity)).toBeGreaterThanOrEqual(RARITIES.indexOf('rare'));
    expect(forced.pity.rare).toBe(0);
    const rank = RARITIES.indexOf(forced.rarity);
    expect(forced.pity.exquisite).toBe(rank >= RARITIES.indexOf('exquisite') ? 0 : 4);
    expect(forced.pity.legendary).toBe(rank >= RARITIES.indexOf('legendary') ? 0 : 8);
    expect(pityOutlook(forced.pity).within).toBeGreaterThan(0);

    const next = await openNext();
    const nextRank = RARITIES.indexOf(next.rarity);
    for (const rule of pityConfig.rules) {
      const previous = forced.pity[rule.rarity];
      expect(next.pity[rule.rarity]).toBe(
        nextRank >= RARITIES.indexOf(rule.rarity) ? 0 : previous + 1,
      );
    }
    expect(pityReports).toEqual([ftue.pity, forced.pity, next.pity]);
    expect(game.controller.pity).toEqual(next.pity);
    expectConserved();
  });

  it('stops listening once disposed', async () => {
    const game = await setup();
    game.controller.dispose();
    for (let i = 0; i < crateSpawn.ftueScriptedDrop; i++) await game.drop();
    expect(game.log).toEqual([]);
    expect(game.controller.riding).toHaveLength(0);
  });
});

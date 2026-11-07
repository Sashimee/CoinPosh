import { afterEach, describe, expect, it } from 'vitest';
import { COIN } from '../coin.ts';
import { StateHasher } from '../hash.ts';
import { Xoshiro128ss } from '../prng.ts';
import { COIN_MATERIAL } from '../table/tuning.ts';
import { type MechanicEvent, TableMechanics } from './mechanics.ts';
import { MechanicsRig } from './rig.ts';
import { FUSION_TUNING, TOWER_TUNING } from './tuning.ts';

const TIERS = ['copper', 'silver', 'gold'] as const;
type Tier = (typeof TIERS)[number];
const FUSION = { inputCount: 3, contactSeconds: 0.4 };
const RESTING = 2 * (COIN.radius + COIN_MATERIAL.contactSkin);
const LANE_Z = -0.17;
const SEED = 0xf05e;

const live: MechanicsRig[] = [];

afterEach(() => {
  for (const rig of live.splice(0)) {
    rig.dispose();
  }
});

async function setUp(
  tower: boolean,
  moving = false,
): Promise<{ rig: MechanicsRig; mechanics: TableMechanics<Tier> }> {
  const rig = await MechanicsRig.create({ moving });
  live.push(rig);
  const mechanics = new TableMechanics(rig.rapier, rig.world, rig, {
    tiers: TIERS,
    fusion: FUSION,
    tower: tower ? TOWER_TUNING.placement : null,
  });
  return { rig, mechanics };
}

function run(
  rig: MechanicsRig,
  mechanics: TableMechanics<Tier>,
  ticks: number,
): MechanicEvent<Tier>[] {
  const events: MechanicEvent<Tier>[] = [];
  for (let i = 0; i < ticks; i++) {
    rig.step();
    events.push(...mechanics.step(rig.tick));
  }
  return events;
}

function placeRow(
  rig: MechanicsRig,
  mechanics: TableMechanics<Tier>,
  tiers: readonly Tier[],
  x0 = -0.05,
): number[] {
  return tiers.map((tier, i) => {
    const id = rig.placeFlat(x0 + i * RESTING, LANE_Z);
    mechanics.registerCoin(id, tier);
    return id;
  });
}

describe('Contact Fusion on the table', () => {
  it('replaces three same-tier coins touching for 0.4 s with one coin of the next tier', async () => {
    const { rig, mechanics } = await setUp(false);
    const ids = placeRow(rig, mechanics, ['copper', 'copper', 'copper']);
    const before = rig.coins();
    expect(run(rig, mechanics, 24)).toEqual([]);
    const [fusion, ...rest] = run(rig, mechanics, 1);
    expect(rest).toEqual([]);
    expect(fusion).toEqual({
      kind: 'fusion',
      tick: 25,
      ids,
      tier: 'copper',
      into: 'silver',
      fusedId: 3,
      position: expect.any(Object) as unknown,
    });
    const highest = Math.max(...before.map(({ translation }) => translation.y));
    expect(fusion?.kind === 'fusion' && fusion.position.x).toBeCloseTo(-0.05 + RESTING, 4);
    expect(fusion?.kind === 'fusion' && fusion.position.y).toBeCloseTo(
      highest + FUSION_TUNING.spawnLift,
      4,
    );
    expect(rig.coins().map(({ id }) => id)).toEqual([3]);
    expect(mechanics.tierOf(3)).toBe('silver');
    expect(() => mechanics.tierOf(0)).toThrow(/no tier/);
    run(rig, mechanics, 60);
    expect(rig.coins()).toHaveLength(1);
  });

  it('counts the 0.4 s from the economy rules it was given', async () => {
    const rig = await MechanicsRig.create();
    live.push(rig);
    const mechanics = new TableMechanics(rig.rapier, rig.world, rig, {
      tiers: TIERS,
      fusion: { inputCount: 3, contactSeconds: 0.4 * 1.5 },
      tower: null,
    });
    placeRow(rig, mechanics, ['silver', 'silver', 'silver']);
    const [fusion] = run(rig, mechanics, 60);
    expect(mechanics.fusionTicks).toBe(36);
    expect(fusion).toMatchObject({ kind: 'fusion', tick: 37, tier: 'silver', into: 'gold' });
  });

  it('chains: three fused coins of the next tier fuse again', async () => {
    const { rig, mechanics } = await setUp(false);
    for (const row of [0, 1, 2]) {
      placeRow(rig, mechanics, ['copper', 'copper', 'copper'], -0.12 + row * 0.09);
    }
    const first = run(rig, mechanics, 25);
    expect(first.map((e) => e.kind === 'fusion' && e.into)).toEqual(['silver', 'silver', 'silver']);
    expect(rig.coins()).toHaveLength(3);
  });

  it('does not fuse mixed tiers, the top tier or two coins', async () => {
    const { rig, mechanics } = await setUp(false);
    placeRow(rig, mechanics, ['copper', 'copper', 'silver'], -0.12);
    placeRow(rig, mechanics, ['gold', 'gold', 'gold'], -0.01);
    placeRow(rig, mechanics, ['silver', 'silver'], 0.08);
    expect(run(rig, mechanics, 120)).toEqual([]);
    expect(rig.coins()).toHaveLength(8);
  });

  it('forgets coins that fell and rejects coins it was never told about', async () => {
    const { rig, mechanics } = await setUp(false);
    placeRow(rig, mechanics, ['copper', 'copper', 'copper']);
    run(rig, mechanics, 10);
    rig.removeCoin(1);
    rig.step();
    expect(mechanics.step(rig.tick, [1])).toEqual([]);
    expect(() => mechanics.tierOf(1)).toThrow(/no tier/);
    expect(mechanics.fusionProgress()).toEqual([]);
    expect(run(rig, mechanics, 60)).toEqual([]);
    expect(() => mechanics.step(rig.tick)).toThrow(/not after/);
    rig.placeFlat(0.05, LANE_Z);
    rig.step();
    expect(() => mechanics.step(rig.tick)).toThrow(/registerCoin/);
  });

  it('rejects a bad tier ladder and bad registrations', async () => {
    const { rig, mechanics } = await setUp(false);
    expect(() => {
      mechanics.registerCoin(0, 'platinum' as Tier);
    }).toThrow(/not in the tier ladder/);
    mechanics.registerCoin(0, 'copper');
    expect(() => {
      mechanics.registerCoin(0, 'copper');
    }).toThrow(/already registered/);
    const config = { fusion: FUSION, tower: null };
    expect(
      () => new TableMechanics(rig.rapier, rig.world, rig, { ...config, tiers: ['copper'] }),
    ).toThrow(/at least two tiers/);
    expect(
      () =>
        new TableMechanics(rig.rapier, rig.world, rig, { ...config, tiers: ['copper', 'copper'] }),
    ).toThrow(/twice/);
  });
});

/**
 * Play on the moving upper tier: a seeded stream of mixed-tier drops, most down the
 * middle lane where they pile up and fuse, some onto the tower.
 */
class Session {
  readonly digests: string[] = [];
  readonly events: MechanicEvent<Tier>[] = [];
  readonly #rig: MechanicsRig;
  readonly #mechanics: TableMechanics<Tier>;
  readonly #rng: Xoshiro128ss;

  private constructor(rig: MechanicsRig, mechanics: TableMechanics<Tier>, seed: number) {
    this.#rig = rig;
    this.#mechanics = mechanics;
    this.#rng = Xoshiro128ss.fromSeed(seed);
  }

  static async start(seed: number): Promise<Session> {
    const { rig, mechanics } = await setUp(true, true);
    return new Session(rig, mechanics, seed);
  }

  step(): void {
    const rig = this.#rig;
    const rng = this.#rng;
    if (rig.tick % 12 === 0) {
      const tower = rng.nextInt(4) === 0;
      const x = tower
        ? TOWER_TUNING.placement.x + rng.nextRange(-0.006, 0.006)
        : rng.nextRange(-0.06, 0.04);
      const tier = TIERS[rng.nextInt(tower ? 3 : 2)] ?? 'copper';
      this.#mechanics.registerCoin(rig.dropCoin(x, rng), tier);
    }
    rig.step();
    this.events.push(...this.#mechanics.step(rig.tick, rig.takeSpilled()));
    if (rig.tick % 60 === 0) {
      this.digests.push(this.#mechanics.hashInto(rig.hashInto(new StateHasher())).digest());
    }
  }
}

async function playSession(seed: number, ticks = 60 * 60): Promise<Session> {
  const session = await Session.start(seed);
  for (let i = 0; i < ticks; i++) {
    session.step();
  }
  return session;
}

describe('mechanics determinism', () => {
  it('plays a session with fusions, captures and a topple', async () => {
    const { events } = await playSession(SEED);
    const kinds = new Set(events.map((e) => e.kind));
    expect(kinds).toEqual(new Set(['fusion', 'towerCapture', 'towerTopple']));
  });

  it('replays the same session to the same state every second', async () => {
    const a = await playSession(SEED);
    const b = await playSession(SEED);
    expect(b.digests).toEqual(a.digests);
    expect(b.events).toEqual(a.events);
  });

  it('replays the same state when two sessions run interleaved', async () => {
    const alone = await playSession(SEED, 900);
    const a = await Session.start(SEED);
    const b = await Session.start(SEED + 1);
    for (let i = 0; i < 900; i++) {
      a.step();
      b.step();
    }
    expect(a.digests).toEqual(alone.digests);
    expect(a.events).toEqual(alone.events);
  });

  it('diverges with a different seed', async () => {
    const a = await playSession(SEED, 600);
    const b = await playSession(SEED + 1, 600);
    expect(b.digests.at(-1)).not.toBe(a.digests.at(-1));
  });

  it('pins the session state so a change to the mechanics is noticed', async () => {
    const { digests } = await playSession(SEED);
    expect(digests.at(-1)).toMatchInlineSnapshot(`"94bbe1fd200045b8"`);
  });
});

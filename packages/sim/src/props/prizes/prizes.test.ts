import { PRIZE_FAMILIES, type PrizeFamily } from '@coinposh/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { COIN } from '../../coin.ts';
import type { SimInput } from '../../inputs.ts';
import { Sim } from '../../sim.ts';
import { validateSnapshot } from '../../snapshot/validate.ts';
import { PLAYFIELD, PUSHER } from '../../table/layout.ts';
import { bindProps, MAX_PROP_MASS, PROP_KINDS } from '../index.ts';
import type { PropPose } from '../kind.ts';
import { massShares, type Quat, rotate, type Vec3 } from '../shape.ts';
import type { PropEvent, PropState } from '../world.ts';
import { PRIZE_BODIES, PRIZE_PROP_KIND, prizeSpec } from './index.ts';

const SEED = 0xc0196051;
const UPRIGHT: Quat = { x: 0, y: 0, z: 0, w: 1 };
/** Half a turn about y: the prize's +z end points at the backboard. */
const TURNED: Quat = { x: 0, y: 1, z: 0, w: 0 };
const COIN_MASS = Math.PI * COIN.radius * COIN.radius * 2 * COIN.halfThickness * COIN.density;
const LIP = PLAYFIELD.fieldFrontZ;

const live: Sim[] = [];

afterAll(() => {
  for (const sim of live) {
    sim.dispose();
  }
});

async function create(...args: Parameters<typeof Sim.create>): Promise<Sim> {
  const sim = await Sim.create(...args);
  live.push(sim);
  return sim;
}

/** The centre of mass in the prize's own frame. */
function centreOfMass(family: PrizeFamily): Vec3 {
  const { shape } = PRIZE_BODIES[family];
  const shares = massShares(shape);
  return shape.parts.reduce(
    (sum, part, i) => {
      const share = shares[i] ?? 0;
      return {
        x: sum.x + part.translation.x * share,
        y: sum.y + part.translation.y * share,
        z: sum.z + part.translation.z * share,
      };
    },
    { x: 0, y: 0, z: 0 },
  );
}

/** The world z of the prize's centre of mass. */
function massZ(family: PrizeFamily, state: PropState): number {
  return state.translation.z + rotate(state.rotation, centreOfMass(family)).z;
}

/**
 * A prize lying flat on the lower tier at `x`, its centre of mass `behind` metres behind
 * the front lip (negative: past it), turned so the heavier end faces the player.
 */
function onTheLip(family: PrizeFamily, x: number, behind: number): PropPose {
  const com = centreOfMass(family);
  const rotation = com.z < 0 ? TURNED : UPRIGHT;
  const ahead = rotate(rotation, com).z;
  return {
    translation: { x, y: PRIZE_BODIES[family].restHeight, z: LIP - behind - ahead },
    rotation,
  };
}

type PropFall = Extract<PropEvent, { kind: 'prop.fall' }>;

function falls(events: readonly PropEvent[]): PropFall[] {
  return events.flatMap((event) => (event.kind === 'prop.fall' ? [event] : []));
}

describe('prize bodies', () => {
  it('gives every catalogue family a compound body', () => {
    expect(Object.keys(PRIZE_BODIES).sort()).toEqual([...PRIZE_FAMILIES].sort());
    for (const family of PRIZE_FAMILIES) {
      expect(PRIZE_BODIES[family].shape.parts.length, family).toBeGreaterThanOrEqual(3);
    }
  });

  it('binds each as a dynamic prop heavier than three coins and within the prop limits', () => {
    expect(PROP_KINDS[PRIZE_PROP_KIND].body).toBe('dynamic');
    const pose = { translation: { x: 0, y: 0.01, z: 0 }, rotation: UPRIGHT };
    const bound = bindProps(PRIZE_FAMILIES.map((family, i) => prizeSpec(family, i + 1, pose)));
    for (const [i, family] of PRIZE_FAMILIES.entries()) {
      const prop = bound[i];
      expect(prop?.body, family).toBe('dynamic');
      expect(prop?.shape, family).toEqual(PRIZE_BODIES[family].shape);
      expect(prop?.mass, family).toBeGreaterThan(3 * COIN_MASS);
      expect(prop?.mass, family).toBeLessThanOrEqual(MAX_PROP_MASS);
      expect(prop?.material?.restitutionCombine, family).toBe('min');
      expect(prop?.material?.restitution, family).toBeLessThanOrEqual(COIN.restitution);
    }
  });

  it('lies still on the lower tier at its rest height', async () => {
    const sim = await create({
      seed: SEED,
      props: PRIZE_FAMILIES.map((family, i) =>
        prizeSpec(family, i + 1, {
          translation: { x: -0.12 + 0.08 * i, y: PRIZE_BODIES[family].restHeight, z: 0.008 },
          rotation: UPRIGHT,
        }),
      ),
    });
    const laid = sim.props();
    while (sim.tick < 40) {
      sim.step([]);
    }
    for (const [i, state] of sim.props().entries()) {
      const home = laid[i];
      const family = PRIZE_FAMILIES[i];
      expect(state.present, family).toBe(true);
      expect(Math.abs(state.translation.y - (home?.translation.y ?? 0)), family).toBeLessThan(3e-4);
      expect(Math.abs(state.translation.z - (home?.translation.z ?? 0)), family).toBeLessThan(3e-4);
      expect(Math.abs(state.rotation.w), family).toBeGreaterThan(0.9999);
    }
  });
});

describe('a prize on the lip', () => {
  it.each(PRIZE_FAMILIES)(
    '%s teeters with its centre of mass just behind the lip, and a nudge tips it over',
    async (family) => {
      const sim = await create({
        seed: SEED,
        props: [prizeSpec(family, 9, onTheLip(family, 0.02, 0.003))],
      });
      const events: PropEvent[] = [];
      while (sim.tick < 90) {
        events.push(...sim.step([]).props);
      }
      const [held] = sim.props();
      expect(events).toEqual([]);
      expect(held?.present).toBe(true);
      expect(held && massZ(family, held)).toBeLessThan(LIP);
      expect(held?.translation.y).toBeGreaterThan(0);
      const nudge: SimInput[] = [{ kind: 'nudge', direction: 'forward' }];
      while (sim.tick < 600 && events.length === 0) {
        events.push(...sim.step(sim.tick % 30 === 0 ? nudge : []).props);
      }
      expect(events).toEqual([{ kind: 'prop.fall', propId: 9, tick: sim.tick, edge: 'front' }]);
      expect(sim.props()[0]?.present).toBe(false);
    },
  );

  it('tips car keys hanging their fob past the lip off on their own and reports the fall once', async () => {
    const sim = await create({
      seed: SEED,
      props: [prizeSpec('carKeys', 4, onTheLip('carKeys', -0.05, -0.003))],
    });
    expect(sim.props()[0]?.translation.z).toBeLessThanOrEqual(LIP);
    const events: PropEvent[] = [];
    while (sim.tick < 180) {
      events.push(...sim.step([]).props);
    }
    expect(falls(events)).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'prop.fall', propId: 4, edge: 'front' });
    expect(events[0]?.tick).toBeLessThan(90);
  });
});

/**
 * The four prizes laid where a spawn puts them, at rest on both tiers, and a coin every
 * 20 ticks (two every 100) across the table.
 */
const LAYOUT = [
  prizeSpec('watch', 11, {
    translation: { x: -0.1, y: PUSHER.height + PRIZE_BODIES.watch.restHeight, z: -0.17 },
    rotation: UPRIGHT,
  }),
  prizeSpec('perfume', 12, {
    translation: { x: 0.06, y: PUSHER.height + PRIZE_BODIES.perfume.restHeight, z: -0.15 },
    rotation: UPRIGHT,
  }),
  prizeSpec('cufflinks', 13, {
    translation: { x: -0.05, y: PRIZE_BODIES.cufflinks.restHeight, z: 0.02 },
    rotation: UPRIGHT,
  }),
  prizeSpec('carKeys', 14, {
    translation: { x: 0.11, y: PRIZE_BODIES.carKeys.restHeight, z: 0.025 },
    rotation: { x: 0, y: Math.sqrt(0.5), z: 0, w: Math.sqrt(0.5) },
  }),
];

function scriptedInputs(tick: number): SimInput[] {
  if (tick % 20 !== 0) {
    return [];
  }
  const xMm = ((tick * 37) % 301) - 150;
  const inputs: SimInput[] = [{ kind: 'dropCoin', xMm }];
  if (tick % 100 === 0) {
    inputs.push({ kind: 'dropCoin', xMm: -xMm });
  }
  if (tick % 600 === 300) {
    inputs.push({ kind: 'nudge', direction: 'forward' });
  }
  return inputs;
}

const TICKS = 3600;
const HASH_INTERVAL = 300;

describe('a four-prize minute', () => {
  interface Replay {
    readonly sim: Sim;
    readonly checkpoints: string[];
    readonly events: PropEvent[];
  }

  async function replay(props: typeof LAYOUT): Promise<Replay> {
    const sim = await create({ seed: SEED, props });
    const checkpoints: string[] = [];
    const events: PropEvent[] = [];
    while (sim.tick < TICKS) {
      events.push(...sim.step(scriptedInputs(sim.tick)).props);
      if (sim.tick % HASH_INTERVAL === 0) {
        checkpoints.push(sim.hash());
      }
    }
    return { sim, checkpoints, events };
  }

  let pair: Promise<readonly [Replay, Replay]> | undefined;

  function replays(): Promise<readonly [Replay, Replay]> {
    pair ??= Promise.all([replay(LAYOUT), replay([...LAYOUT].reverse())]);
    return pair;
  }

  it('replays bit for bit, whatever order the config lists the prizes in', async () => {
    const [reference, replica] = await replays();
    expect(replica.checkpoints).toHaveLength(TICKS / HASH_INTERVAL);
    expect(replica.checkpoints).toEqual(reference.checkpoints);
    expect(replica.events).toEqual(reference.events);
    expect(replica.sim.props()).toEqual(reference.sim.props());
  });

  it('carries prizes off the front lip, each reported once, and pins the hash', async () => {
    const [reference] = await replays();
    const fallen = falls(reference.events);
    expect(fallen.length).toBeGreaterThan(0);
    expect(new Set(fallen.map(({ propId }) => propId)).size).toBe(fallen.length);
    expect(fallen).toMatchInlineSnapshot(`
      [
        {
          "edge": "front",
          "kind": "prop.fall",
          "propId": 12,
          "tick": 1365,
        },
        {
          "edge": "front",
          "kind": "prop.fall",
          "propId": 14,
          "tick": 1564,
        },
        {
          "edge": "front",
          "kind": "prop.fall",
          "propId": 13,
          "tick": 1578,
        },
        {
          "edge": "front",
          "kind": "prop.fall",
          "propId": 11,
          "tick": 2051,
        },
      ]
    `);
    for (const state of reference.sim.props()) {
      expect(state.present).toBe(!fallen.some((event) => event.propId === state.id));
    }
    // Changing this value breaks replay audits of every input log on a table with prizes.
    expect(reference.checkpoints.at(-1)).toMatchInlineSnapshot(`"80ad707f2d79aea5"`);
  });

  it('restores mid-minute and plays on as one', async () => {
    const sim = await create({ seed: SEED, props: LAYOUT });
    while (sim.tick < TICKS / 2) {
      sim.step(scriptedInputs(sim.tick));
    }
    const saved = sim.snapshot();
    expect(saved.props?.filter((prop) => prop.pose !== undefined).length).toBeGreaterThan(0);
    const restore = {
      pusherTickInCycle: saved.pusherTickInCycle,
      coins: validateSnapshot(saved).ok.map((pose) => ({ kind: 'pose', pose }) as const),
      props: saved.props ?? [],
    };
    const [a, b] = await Promise.all([
      create({ seed: SEED, props: LAYOUT, restore }),
      create({ seed: SEED, props: [...LAYOUT].reverse(), restore }),
    ]);
    expect(a.snapshot().props).toEqual(saved.props);
    expect(a.props().map(({ present }) => present)).toEqual(
      sim.props().map(({ present }) => present),
    );
    for (let tick = 0; tick < 600; tick++) {
      const inputs = scriptedInputs(tick);
      expect(b.step(inputs).props).toEqual(a.step(inputs).props);
    }
    expect(b.hash()).toBe(a.hash());
  });
});

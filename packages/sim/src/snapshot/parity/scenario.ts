import type { SimInput } from '../../inputs.ts';
import { Sim } from '../../sim.ts';
import settledTable from '../fixtures/settled-table.json' with { type: 'json' };
import { type CoinPose, SIM_SNAPSHOT_VERSION, type SimTableSnapshot } from '../snapshot.ts';
import { validateSnapshot } from '../validate.ts';

/**
 * The snapshot round trip that parity.test.ts runs in Node and in a browser, built only
 * from the sim's own modules so both engines load the same code. Every value it returns
 * is a string, so a page hands it back over the DevTools protocol unchanged.
 */
export interface ParityRun {
  /** The snapshot of the table played on, as JSON. */
  readonly snapshot: string;
  /** The restored table's hash at restore and every 60 ticks after. */
  readonly roundTrip: readonly string[];
  /** The settled-table fixture's hash at restore and every 60 ticks after. */
  readonly fixture: readonly string[];
}

const SEED = 0xc0195051;

const MECHANICS = {
  tiers: ['copper', 'silver', 'gold', 'platinum', 'diamond', 'heirloom'],
  fusion: null,
  tower: null,
};

function steadyDrops(tick: number): SimInput[] {
  return tick % 12 === 0 ? [{ kind: 'dropCoin', xMm: ((tick * 13) % 81) - 40 }] : [];
}

function play(sim: Sim, ticks: number): string[] {
  const hashes = [sim.hash()];
  for (let i = 1; i <= ticks; i++) {
    sim.step(steadyDrops(sim.tick));
    if (i % 60 === 0) {
      hashes.push(sim.hash());
    }
  }
  return hashes;
}

async function restored(snapshot: SimTableSnapshot): Promise<Sim> {
  return Sim.create({
    seed: SEED,
    mechanics: MECHANICS,
    restore: {
      pusherTickInCycle: snapshot.pusherTickInCycle,
      coins: validateSnapshot(snapshot).ok.map((pose) => ({ kind: 'pose', pose })),
    },
  });
}

function fixturePose({ id, p, q, rest }: (typeof settledTable.coins)[number]): CoinPose {
  const [px, py, pz] = p;
  const [qx, qy, qz, qw] = q;
  if (
    px === undefined ||
    py === undefined ||
    pz === undefined ||
    qx === undefined ||
    qy === undefined ||
    qz === undefined ||
    qw === undefined ||
    (rest !== 'asleep' && rest !== 'awake')
  ) {
    throw new Error(`settled-table.json: coin ${id} is malformed; regenerate the fixture`);
  }
  return { id, p: [px, py, pz], q: [qx, qy, qz, qw], rest };
}

/** Plays the heap for 10 s, restores its snapshot and plays 10 s more; then the fixture. */
export async function parityRun(): Promise<ParityRun> {
  const source = await Sim.create({
    seed: SEED,
    mechanics: MECHANICS,
    openingHeap: { coins: 110 },
  });
  play(source, 600);
  const snapshot = source.snapshot();
  source.dispose();
  const sim = await restored(snapshot);
  const roundTrip = play(sim, 600);
  sim.dispose();
  const fixture = await restored({
    version: SIM_SNAPSHOT_VERSION,
    pusherTickInCycle: settledTable.pusherTickInCycle,
    coins: settledTable.coins.map(fixturePose),
  });
  const fixtureHashes = play(fixture, 600);
  fixture.dispose();
  return { snapshot: JSON.stringify(snapshot), roundTrip, fixture: fixtureHashes };
}

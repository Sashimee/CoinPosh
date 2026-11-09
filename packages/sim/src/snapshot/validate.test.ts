import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import packageJson from '../../package.json' with { type: 'json' };
import { COIN } from '../coin.ts';
import { Xoshiro128ss } from '../prng.ts';
import { BACKBOARD, PLAYFIELD, PUSHER, TABLE_INNER_HALF_WIDTH } from '../table/layout.ts';
import * as entry from './index.ts';
import {
  type CoinPose,
  dequantizePosition,
  dequantizeRotation,
  quantizePosition,
  quantizeRotation,
  type SimTableSnapshot,
} from './snapshot.ts';
import {
  checkCratePose,
  checkPose,
  COIN_OVERLAP_TOLERANCE,
  CRATE_RIDE,
  type CratePose,
  FRONT_FALL_REACH,
  type PoseRejection,
  validateSnapshot,
} from './validate.ts';

const snapshotDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(snapshotDir, '../..');

const STATIC_SPECIFIER =
  /(?:^|[;\s])(import|export)\s+(type\s+)?(?:[\w*\s{},$]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /\bimport\s*\(/;

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function runtimeSpecifiers(file: string): string[] {
  const code = stripComments(readFileSync(file, 'utf8'));
  expect(DYNAMIC_IMPORT.test(code), `${file} must not import() dynamically`).toBe(false);
  return [...code.matchAll(STATIC_SPECIFIER)].flatMap(([, , typeOnly, specifier]) =>
    typeOnly === undefined && specifier !== undefined ? [specifier] : [],
  );
}

function runtimeGraph(start: string): { modules: string[]; packages: string[] } {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const pending = [start];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of runtimeSpecifiers(file)) {
      if (specifier.startsWith('.')) {
        pending.push(resolve(dirname(file), specifier));
      } else {
        packages.add(specifier);
      }
    }
  }
  const modules = [...seen].map((file) => relative(packageDir, file)).sort();
  return { modules, packages: [...packages].sort() };
}

const FLAT: CoinPose['q'] = [0, 0, 0, 32767];
/** Standing on its rim, faces toward ±x and toward ±z. */
const ON_EDGE_X: CoinPose['q'] = [0, 0, 23170, 23170];
const ON_EDGE_Z: CoinPose['q'] = [23170, 0, 0, 23170];
/** A coin lying flat on the lower tier, a contact skin clear of it, in 10 µm units. */
const FLOOR_Y = 160;
/** The same on the pusher top. */
const SHELF_Y = 3660;
/** Over the lower tier, clear of everything at any rotation. */
const MID_AIR: CoinPose['p'] = [0, 2000, 0];

function pose(p: CoinPose['p'], overrides: Partial<CoinPose> = {}): CoinPose {
  return { id: 0, p, q: FLAT, rest: 'asleep', ...overrides };
}

function reason(p: CoinPose, tick = 0): PoseRejection | null {
  const verdict = checkPose(p, tick);
  return verdict.ok ? null : verdict.reason;
}

describe('@coinposh/sim/snapshot', () => {
  it('is published as a subpath export', () => {
    expect(packageJson.exports['./snapshot']).toBe('./src/snapshot/index.ts');
  });

  it('never loads Rapier or the simulation, so the worker can judge snapshots without WASM', () => {
    const graph = runtimeGraph(resolve(snapshotDir, 'index.ts'));
    expect(graph.packages).toEqual([]);
    expect(graph.modules).toEqual([
      'src/coin.ts',
      'src/constants.ts',
      'src/snapshot/geometry.ts',
      'src/snapshot/index.ts',
      'src/snapshot/snapshot.ts',
      'src/snapshot/validate.ts',
      'src/table/layout.ts',
      'src/table/pusher.ts',
      'src/table/tuning.ts',
    ]);
  });

  it('exports the checks and the crate ride bounds', () => {
    expect(typeof entry.checkPose).toBe('function');
    expect(typeof entry.validateSnapshot).toBe('function');
    expect(typeof entry.checkCratePose).toBe('function');
    expect(entry.CRATE_RIDE).toBe(CRATE_RIDE);
  });
});

describe('quantization', () => {
  it('stores positions in whole 10 µm units, never as -0', () => {
    expect(quantizePosition({ x: 0.1234567, y: -0.000004, z: -0.2065 })).toEqual([
      12346, 0, -20650,
    ]);
    expect(Object.is(quantizePosition({ x: -0.000001, y: 0, z: 0 })[0], 0)).toBe(true);
  });

  it('makes the quaternion canonical, w >= 0 and the first non-zero component positive at w = 0', () => {
    expect(quantizeRotation({ x: 0.6, y: 0, z: 0, w: -0.8 })).toEqual([-19660, 0, 0, 26214]);
    expect(quantizeRotation({ x: 0, y: -0.6, z: 0.8, w: 0 })).toEqual([0, 19660, -26214, 0]);
    expect(quantizeRotation({ x: 0, y: 0.6, z: -0.8, w: -0.000001 })).toEqual([
      0, 19660, -26214, 0,
    ]);
    expect(quantizeRotation({ x: 0, y: 0, z: 0, w: 1 })).toEqual(FLAT);
  });

  it('is a fixed point of decoding, storing in f32 as Rapier does, and quantizing again', () => {
    const p: CoinPose['p'] = [-16650, 3660, -20650];
    const f32 = (v: { x: number; y: number; z: number }) => ({
      x: Math.fround(v.x * 10) / 10,
      y: Math.fround(v.y * 10) / 10,
      z: Math.fround(v.z * 10) / 10,
    });
    expect(quantizePosition(f32(dequantizePosition(p)))).toEqual(p);
    const rng = Xoshiro128ss.fromSeed(0x5eed);
    let reworked = 0;
    for (let i = 0; i < 5000; i++) {
      const raw = [
        rng.nextRange(-1, 1),
        rng.nextRange(-1, 1),
        rng.nextRange(-1, 1),
        rng.nextRange(-1, 1),
      ];
      const n = Math.sqrt(raw.reduce((sum, c) => sum + c * c, 0));
      const [x = 0, y = 0, z = 0, w = 1] = raw.map((c) => c / n);
      const q = quantizeRotation({ x, y, z, w });
      const sign = w < 0 ? -1 : 1;
      const signed = [x, y, z, w].map((c) => Math.round(sign * c * 32767));
      const flip = signed[3] === 0 && (signed.find((c) => c !== 0) ?? 0) < 0;
      const rounded = signed.map((c) => (flip ? -c : c));
      q.forEach((c, k) => {
        expect(Math.abs(c - (rounded[k] ?? 0)), q.join(', ')).toBeLessThanOrEqual(1);
      });
      if (q.some((c, k) => c !== rounded[k])) {
        reworked += 1;
      }
      const decoded = dequantizeRotation(q);
      expect(
        decoded.x * decoded.x +
          decoded.y * decoded.y +
          decoded.z * decoded.z +
          decoded.w * decoded.w,
      ).toBeCloseTo(1, 12);
      const stored = {
        x: Math.fround(decoded.x),
        y: Math.fround(decoded.y),
        z: Math.fround(decoded.z),
        w: Math.fround(decoded.w),
      };
      expect(quantizeRotation(stored), q.join(', ')).toEqual(q);
    }
    expect(reworked).toBeGreaterThan(0);
  });
});

describe('checkPose', () => {
  it('accepts every position limit exactly and refuses one unit past it', () => {
    const shelfStanding = Math.round((PUSHER.height + COIN.radius) / 1e-5) + 3;
    const cases: [CoinPose, CoinPose][] = [
      [pose([21070, 0, 3000], { q: ON_EDGE_X }), pose([21071, 0, 3000], { q: ON_EDGE_X })],
      [pose([-21070, 0, 3000], { q: ON_EDGE_X }), pose([-21071, 0, 3000], { q: ON_EDGE_X })],
      [
        pose([0, shelfStanding, -21870], { q: ON_EDGE_Z }),
        pose([0, shelfStanding, -21871], { q: ON_EDGE_Z }),
      ],
      [pose([0, 3500, 6350]), pose([0, 3500, 6351])],
      [pose([19600, -3000, 3000]), pose([19600, -3001, 3000])],
      [pose([0, 22000, 0]), pose([0, 22001, 0])],
    ];
    for (const [inside, outside] of cases) {
      expect(reason(inside), inside.p.join(', ')).toBeNull();
      expect(reason(outside), outside.p.join(', ')).toBe('out_of_bounds');
    }
    expect(21070 * 1e-5).toBeCloseTo(TABLE_INNER_HALF_WIDTH - COIN.halfThickness, 12);
    expect(-21870 * 1e-5).toBeCloseTo(BACKBOARD.frontZ + COIN.halfThickness, 12);
    expect(6350 * 1e-5).toBeCloseTo(PLAYFIELD.fieldFrontZ + COIN.radius, 12);
    expect(-3000 * 1e-5).toBeCloseTo(PLAYFIELD.fallY, 12);
  });

  it('refuses a coin more than 1 mm into the floor, a side wall or the backboard', () => {
    const cases: [CoinPose['p'], CoinPose['p']][] = [
      [
        [0, 31, 0],
        [0, 29, 0],
      ],
      [
        [16749, SHELF_Y, -15000],
        [16751, SHELF_Y, -15000],
      ],
      [
        [-16749, SHELF_Y, -15000],
        [-16751, SHELF_Y, -15000],
      ],
      [
        [0, SHELF_Y, -20749],
        [0, SHELF_Y, -20751],
      ],
    ];
    for (const [inside, outside] of cases) {
      expect(reason(pose(inside)), inside.join(', ')).toBeNull();
      expect(reason(pose(outside)), outside.join(', ')).toBe('out_of_bounds');
    }
  });

  it('refuses a centre under the floor, but not a coin dropping past its front or into a gutter', () => {
    expect(reason(pose([0, -500, 5130], { q: ON_EDGE_Z }))).toBeNull();
    expect(reason(pose([0, -500, 4999], { q: ON_EDGE_Z }))).toBe('out_of_bounds');
    expect(reason(pose([0, -2900, 0]))).toBe('out_of_bounds');
    expect(reason(pose([19600, -2900, 0]))).toBeNull();
  });

  it('lets a coin flying off the front below the pusher top be out to FRONT_FALL_REACH', () => {
    expect(FRONT_FALL_REACH).toBe(0.1);
    expect(3500 * 1e-5).toBeCloseTo(PUSHER.height, 12);
    expect(reason(pose([0, -1, 15000]))).toBeNull();
    expect(reason(pose([0, -1, 15001]))).toBe('out_of_bounds');
    expect(reason(pose([0, 3499, 15000]))).toBeNull();
    expect(reason(pose([0, 3499, 15001]))).toBe('out_of_bounds');
    expect(reason(pose([0, 3500, 6351]))).toBe('out_of_bounds');
    expect(
      reason(pose([-4072, 208, 7262], { q: [-30685, 1894, -4825, 10257], rest: 'awake' })),
    ).toBeNull();
    expect(
      reason(pose([-10395, -2026, 6459], { q: [11081, 22750, 18608, 9332], rest: 'awake' })),
    ).toBeNull();
    expect(
      reason(pose([10997, -1888, 6575], { q: [-1505, 19074, 25734, 6736], rest: 'awake' })),
    ).toBeNull();
  });

  it('accepts poses a live table left: a coin over the gutter edge and one leaning on the backboard', () => {
    expect(reason(pose([-17036, 152, 2571], { q: [23148, 11, -23192, -13] }))).toBe('bad_rotation');
    expect(reason(pose([-17036, 152, 2571], { q: [-23148, -11, 23192, 13] }))).toBeNull();
    expect(
      reason(pose([-4251, 4097, -20670], { q: [-5639, -12435, 568, 29781], rest: 'awake' })),
    ).toBeNull();
  });

  it('refuses a coin more than 1 mm into the pusher block where it stands at that tick', () => {
    const face = Math.round(PUSHER.frontZ / 1e-5);
    const radius = Math.round(COIN.radius / 1e-5);
    expect(reason(pose([0, FLOOR_Y, face + radius - 99]))).toBeNull();
    expect(reason(pose([0, FLOOR_Y, face + radius - 101]))).toBe('in_pusher');
    expect(reason(pose([0, FLOOR_Y, face + radius - 101]), 120)).toBe('in_pusher');
    const extended = Math.round((PUSHER.frontZ + PUSHER.stroke) / 1e-5);
    expect(reason(pose([0, FLOOR_Y, extended + radius - 101]), 144)).toBe('in_pusher');
    expect(reason(pose([0, FLOOR_Y, extended + radius - 99]), 144)).toBeNull();
    expect(reason(pose([0, FLOOR_Y, extended + radius - 101]), 0)).toBeNull();
    expect(reason(pose([0, SHELF_Y, -15000]))).toBeNull();
    expect(reason(pose([0, SHELF_Y - 129, -15000]))).toBeNull();
    expect(reason(pose([0, SHELF_Y - 131, -15000]))).toBe('in_pusher');
  });

  it('refuses a rotation that is not a canonical int16 unit quaternion', () => {
    const cases: [CoinPose['q'], PoseRejection | null][] = [
      [[0, 0, 0, 32767], null],
      [[0, 0, 0, 32735], null],
      [[0, 0, 0, 32734], 'bad_rotation'],
      [[0, 0, 0, 32800], 'bad_rotation'],
      [[0, 0, 0, -32767], 'bad_rotation'],
      [[0, 32767, 0, 0], null],
      [[0, -32767, 0, 0], 'bad_rotation'],
      [[0, 19660, -26214, 0], null],
      [[0, -19660, 26214, 0], 'bad_rotation'],
      [[40000, 0, 0, 1000], 'bad_rotation'],
      [[0, 0, 0, 0], 'bad_rotation'],
    ];
    for (const [q, expected] of cases) {
      expect(reason(pose(MID_AIR, { q })), q.join(', ')).toBe(expected);
    }
  });

  it('refuses anything that is not a finite integer or a known rest state', () => {
    const malformed: unknown[] = [
      pose([Number.NaN, FLOOR_Y, 0]),
      pose([0, Number.POSITIVE_INFINITY, 0]),
      pose([0.5, FLOOR_Y, 0]),
      pose([0, FLOOR_Y, 0], { q: [0, 0, 0, 32767.5] }),
      pose([0, FLOOR_Y, 0], { id: -1 }),
      pose([0, FLOOR_Y, 0], { id: 1.5 }),
      { ...pose([0, FLOOR_Y, 0]), rest: 'sleepy' },
      { ...pose([0, FLOOR_Y, 0]), p: [0, 0] },
      { ...pose([0, FLOOR_Y, 0]), q: undefined },
      null,
    ];
    for (const p of malformed) {
      expect(reason(p as CoinPose), JSON.stringify(p)).toBe('non_finite');
    }
  });

  it('refuses a frozen coin until the sim has a static crust', () => {
    expect(reason(pose([0, FLOOR_Y, 0], { rest: 'frozen' }))).toBe('frozen_unsupported');
    expect(reason(pose([0, FLOOR_Y, 0], { rest: 'awake' }))).toBeNull();
  });

  it('throws for a pusher tick outside the cycle', () => {
    for (const tick of [-1, PUSHER.periodTicks, 1.5, Number.NaN]) {
      expect(() => checkPose(pose([0, FLOOR_Y, 0]), tick)).toThrow(RangeError);
    }
    expect(reason(pose([0, FLOOR_Y, 0]), PUSHER.periodTicks - 1)).toBeNull();
  });
});

describe('validateSnapshot', () => {
  const snapshot = (coins: CoinPose[], pusherTickInCycle = 0): SimTableSnapshot => ({
    version: 1,
    pusherTickInCycle,
    coins,
  });

  it('keeps a coin up to 2 mm into another and drops the higher id past that', () => {
    expect(COIN_OVERLAP_TOLERANCE).toBe(0.002);
    const cases: [CoinPose['p'], boolean][] = [
      [[2501, FLOOR_Y, 0], true],
      [[2499, FLOOR_Y, 0], false],
      [[0, FLOOR_Y + 61, 0], true],
      [[0, FLOOR_Y + 59, 0], false],
      [[1800, FLOOR_Y + 180, 1800], true],
    ];
    for (const [p, kept] of cases) {
      const { ok, dropped } = validateSnapshot(
        snapshot([pose(p, { id: 7 }), pose([0, FLOOR_Y, 0], { id: 3 })]),
      );
      expect(
        ok.map(({ id }) => id),
        p.join(', '),
      ).toEqual(kept ? [3, 7] : [3]);
      expect(dropped, p.join(', ')).toEqual(kept ? [] : [{ id: 7, reason: 'overlap' }]);
    }
  });

  it('finds an overlap across grid cells and leaves the coins a dropped one would have hit', () => {
    const cell = 2700;
    const { ok, dropped } = validateSnapshot(
      snapshot([
        pose([cell - 1000, FLOOR_Y, cell - 1], { id: 0 }),
        pose([cell + 1000, FLOOR_Y, cell + 1], { id: 1 }),
        pose([0, FLOOR_Y, 15001], { id: 2 }),
        pose([-5000, FLOOR_Y, 4000], { id: 3 }),
        pose([-10000, FLOOR_Y, 0], { id: 4, rest: 'frozen' }),
        pose([-10500, FLOOR_Y, 0], { id: 5 }),
      ]),
    );
    expect(ok.map(({ id }) => id)).toEqual([0, 3, 5]);
    expect(dropped).toEqual([
      { id: 1, reason: 'overlap' },
      { id: 2, reason: 'out_of_bounds' },
      { id: 4, reason: 'frozen_unsupported' },
    ]);
  });

  it('accepts an empty table and judges every pose against the given pusher tick', () => {
    expect(validateSnapshot(snapshot([]))).toEqual({ ok: [], dropped: [] });
    const nearFace = pose([0, FLOOR_Y, -9000], { id: 1 });
    expect(validateSnapshot(snapshot([nearFace], 0)).dropped).toEqual([]);
    expect(validateSnapshot(snapshot([nearFace], 100)).dropped).toEqual([
      { id: 1, reason: 'in_pusher' },
    ]);
  });

  it('throws for a wrong version, a tick outside the cycle or a repeated id', () => {
    expect(() =>
      validateSnapshot({ ...snapshot([]), version: 2 } as unknown as SimTableSnapshot),
    ).toThrow(/version must be 1/);
    expect(() => validateSnapshot(snapshot([], PUSHER.periodTicks))).toThrow(RangeError);
    expect(() =>
      validateSnapshot(snapshot([pose([0, FLOOR_Y, 0]), pose([5000, FLOOR_Y, 0])])),
    ).toThrow(/coin id 0 appears more than once/);
  });
});

describe('checkCratePose', () => {
  const MAX_SECONDS = 90;
  const units = (m: number) => Math.round(m / 1e-5);
  const side = units(CRATE_RIDE.sideLimit);
  const spawn = units(CRATE_RIDE.spawnZ);
  const teeter = units(CRATE_RIDE.teeterZ);
  const tip = units(CRATE_RIDE.tipZ);
  const crate = (overrides: Partial<CratePose> = {}): CratePose => ({
    x: 0,
    z: spawn,
    elapsedMs: 0,
    phase: 'riding',
    ...overrides,
  });
  const verdict = (pose: CratePose) => {
    const v = checkCratePose(pose, MAX_SECONDS);
    return v.ok ? null : v.reason;
  };

  it('derives the ride from the table layout', () => {
    expect(CRATE_RIDE.spawnZ).toBeCloseTo(PUSHER.frontZ - 0.01, 12);
    expect(CRATE_RIDE.stepZ).toBeCloseTo(PUSHER.frontZ + PUSHER.stroke, 12);
    expect(CRATE_RIDE.teeterZ).toBeLessThan(PLAYFIELD.fieldFrontZ);
    expect(CRATE_RIDE.tipZ).toBeGreaterThan(PLAYFIELD.fieldFrontZ);
    expect(CRATE_RIDE.sideLimit).toBeCloseTo(PLAYFIELD.fieldHalfWidth - CRATE_RIDE.size / 2, 12);
  });

  it('accepts every limit exactly and refuses one unit past it', () => {
    expect(verdict(crate({ x: side }))).toBeNull();
    expect(verdict(crate({ x: -side }))).toBeNull();
    expect(verdict(crate({ x: side + 1 }))).toBe('out_of_bounds');
    expect(verdict(crate({ x: -side - 1 }))).toBe('out_of_bounds');
    expect(verdict(crate({ z: spawn - 1 }))).toBe('out_of_bounds');
    expect(verdict(crate({ z: tip - 1, phase: 'teeter' }))).toBeNull();
    expect(verdict(crate({ z: tip, phase: 'teeter' }))).toBe('out_of_bounds');
    expect(verdict(crate({ elapsedMs: MAX_SECONDS * 1000 }))).toBeNull();
    expect(verdict(crate({ elapsedMs: MAX_SECONDS * 1000 + 1 }))).toBe('bad_elapsed');
    expect(verdict(crate({ elapsedMs: -1 }))).toBe('bad_elapsed');
  });

  it('teeters exactly from teeterZ on', () => {
    expect(verdict(crate({ z: teeter - 1, phase: 'riding' }))).toBeNull();
    expect(verdict(crate({ z: teeter - 1, phase: 'teeter' }))).toBe('bad_phase');
    expect(verdict(crate({ z: teeter, phase: 'teeter' }))).toBeNull();
    expect(verdict(crate({ z: teeter, phase: 'riding' }))).toBe('bad_phase');
  });

  it('refuses anything that is not a finite integer or a live phase', () => {
    const malformed: unknown[] = [
      crate({ x: Number.NaN }),
      crate({ z: 0.5 }),
      crate({ elapsedMs: Number.POSITIVE_INFINITY }),
      { ...crate(), phase: 'fell' },
      null,
    ];
    for (const pose of malformed) {
      expect(verdict(pose as CratePose), JSON.stringify(pose)).toBe('non_finite');
    }
  });

  it('throws for a ride limit that is not a positive number', () => {
    for (const max of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => checkCratePose(crate(), max)).toThrow(RangeError);
    }
  });
});

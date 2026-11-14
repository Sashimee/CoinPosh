import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type AnyPropSpec,
  bindProps,
  distanceAt,
  MAX_PROP_EXTENT,
  MAX_PROPS,
  PROP_KIND_NAMES,
  PROP_KINDS,
  type PropCoin,
  rotate,
  signedDistance,
  SLIDER,
  sweepRadius,
} from './index.ts';

const propsDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(propsDir, '../..');

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

const UPRIGHT = { x: 0, y: 0, z: 0, w: 1 };

function post(id: number, x = 0): AnyPropSpec {
  return {
    id,
    kind: 'post',
    shape: { kind: 'cylinder', halfHeight: 0.01, radius: 0.004 },
    mass: 0,
    pose: { translation: { x, y: 0.01, z: -0.02 }, rotation: UPRIGHT },
    params: { friction: 0.2, restitution: 0.1, bounce: false, reports: true },
  };
}

function slider(id: number): AnyPropSpec {
  return {
    id,
    kind: 'slider',
    shape: { kind: 'box', halfExtents: { x: 0.02, y: 0.006, z: 0.006 } },
    mass: 0,
    pose: { translation: { x: -0.05, y: 0.006, z: 0 }, rotation: UPRIGHT },
    params: {
      friction: 0.2,
      restitution: 0.05,
      stroke: { x: 0.1, z: 0 },
      periodTicks: 240,
      phaseTicks: 0,
    },
  };
}

function weight(id: number): AnyPropSpec {
  return {
    id,
    kind: 'weight',
    shape: { kind: 'ball', radius: 0.01 },
    mass: 0.05,
    pose: { translation: { x: 0, y: 0.01, z: 0 }, rotation: UPRIGHT },
    params: { friction: 0.3, restitution: 0.1, linearDamping: 0.5, angularDamping: 0.5 },
  };
}

/** `spec` with `path` replaced by `value`, for configs that must fail. */
function broken(spec: AnyPropSpec, path: readonly string[], value: unknown): unknown {
  const copy = structuredClone(spec) as unknown as Record<string, unknown>;
  let at: Record<string, unknown> = copy;
  for (const key of path.slice(0, -1)) {
    at = at[key] as Record<string, unknown>;
  }
  const last = path.at(-1);
  if (last !== undefined) {
    at[last] = value;
  }
  return copy;
}

describe('prop kind registry', () => {
  it('never loads Rapier or the simulation, so the server can check a prop config without WASM', () => {
    const graph = runtimeGraph(resolve(propsDir, 'index.ts'));
    expect(graph.packages).toEqual([]);
    expect(graph.modules).toEqual([
      'src/coin.ts',
      'src/constants.ts',
      'src/props/index.ts',
      'src/props/kinds/attractor.ts',
      'src/props/kinds/common.ts',
      'src/props/kinds/pocket.ts',
      'src/props/kinds/post.ts',
      'src/props/kinds/slider.ts',
      'src/props/kinds/weight.ts',
      'src/props/params.ts',
      'src/props/shape.ts',
      'src/table/layout.ts',
      'src/table/tuning.ts',
    ]);
  });

  it('covers static colliders, scheduled movers, dynamic bodies, fields and targets', () => {
    expect(PROP_KIND_NAMES).toEqual(['post', 'slider', 'weight', 'pocket', 'attractor']);
    expect(PROP_KINDS.post.body).toBe('fixed');
    expect(PROP_KINDS.slider.body).toBe('kinematic');
    expect(PROP_KINDS.slider.path).toBeTypeOf('function');
    expect(PROP_KINDS.weight.body).toBe('dynamic');
    expect(PROP_KINDS.attractor.field).toBeDefined();
    expect(PROP_KINDS.pocket.enter).toBeDefined();
  });

  it('binds props in ascending id order whatever order the config lists them in', () => {
    const bound = bindProps([weight(7), post(2), slider(5)]);
    expect(bound.map(({ id, kind, body }) => [id, kind, body])).toEqual([
      [2, 'post', 'fixed'],
      [5, 'slider', 'kinematic'],
      [7, 'weight', 'dynamic'],
    ]);
    expect(bound[0]?.enterMargin).toBeGreaterThan(0);
    expect(bound[1]?.moves).toBe(true);
    expect(bound[1]?.travel).toBeCloseTo(0.1, 12);
    expect(bound[2]?.mass).toBe(0.05);
    expect(bound[2]?.damping).toEqual({ linear: 0.5, angular: 0.5 });
    expect(bindProps([])).toEqual([]);
  });

  it('refuses malformed configs, naming the field', () => {
    const cases: [unknown, RegExp][] = [
      [{}, /must be an array/],
      [[post(1), post(1, 0.05)], /repeats id 1/],
      [[broken(post(1), ['kind'], 'trampoline')], /props\[0\]\.kind must be one of/],
      [[broken(post(1), ['id'], -1)], /props\[0\]\.id must be an integer/],
      [[broken(post(1), ['id'], 1.5)], /props\[0\]\.id must be an integer/],
      [[broken(post(1), ['mass'], 0.1)], /props\[0\]\.mass \(a fixed prop has none\)/],
      [[broken(weight(1), ['mass'], 0)], /props\[0\]\.mass must be a number in \(0/],
      [[broken(weight(1), ['mass'], 5)], /props\[0\]\.mass must be a number in \(0/],
      [[broken(post(1), ['extra'], 1)], /props\[0\] has unknown fields extra/],
      [[broken(post(1), ['params', 'friction'], 2)], /props\[0\]\.params\.friction/],
      [[broken(post(1), ['params', 'bounce'], 'yes')], /props\[0\]\.params\.bounce/],
      [[broken(post(1), ['params', 'colour'], 'red')], /params has unknown fields colour/],
      [[broken(post(1), ['shape', 'radius'], MAX_PROP_EXTENT * 2)], /shape\.radius/],
      [[broken(post(1), ['shape', 'radius'], 0.0001)], /shape\.radius must be at least/],
      [[broken(post(1), ['shape', 'kind'], 'torus')], /shape\.kind must be one of/],
      [[broken(post(1), ['pose', 'translation', 'x'], 0.5)], /pose\.translation\.x/],
      [[broken(post(1), ['pose', 'translation', 'y'], -0.01)], /pose\.translation\.y/],
      [[broken(post(1), ['pose', 'translation', 'z'], Number.NaN)], /pose\.translation\.z/],
      [[broken(post(1), ['pose', 'rotation', 'w'], 0.5)], /must be a unit quaternion/],
      [[broken(slider(1), ['params', 'periodTicks'], 1)], /periodTicks must be an integer/],
      [[broken(slider(1), ['params', 'phaseTicks'], 240)], /phaseTicks must be an integer/],
      [
        [broken(slider(1), ['params', 'stroke'], { x: 0.2, z: 0 })],
        /stroke\.x must be a number in/,
      ],
      [Array.from({ length: MAX_PROPS + 1 }, (_, i) => post(i)), /at most 32/],
    ];
    for (const [config, message] of cases) {
      expect(() => bindProps(config), String(message)).toThrow(message);
    }
  });

  it('keeps a tilted rotation, renormalized', () => {
    const half = Math.sqrt(0.5);
    const [bound] = bindProps([
      broken(post(1), ['pose', 'rotation'], { x: half, y: 0, z: 0, w: half + 1e-7 }),
    ]);
    const q = bound?.home.rotation;
    expect(q && q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w).toBeCloseTo(1, 14);
  });

  it('sweeps a mover over its shape and its whole stroke', () => {
    const [still, moving] = bindProps([post(1), slider(2)]);
    expect(still && sweepRadius(still)).toBeCloseTo(Math.sqrt(0.01 * 0.01 + 0.004 * 0.004), 12);
    expect(moving && sweepRadius(moving)).toBeCloseTo(
      Math.sqrt(0.02 * 0.02 + 0.006 * 0.006 * 2) + 0.1,
      12,
    );
  });
});

describe('slider path', () => {
  const home = { translation: { x: -0.05, y: 0.006, z: 0 }, rotation: UPRIGHT };
  const params = {
    friction: 0.2,
    restitution: 0.05,
    stroke: { x: 0.1, z: -0.02 },
    periodTicks: 240,
    phaseTicks: 0,
  };
  const path = SLIDER.path;

  it('eases out to the stroke at half period and back home, never past either end', () => {
    expect(path).toBeDefined();
    if (!path) return;
    expect(path(0, params, home).translation).toEqual(home.translation);
    expect(path(120, params, home).translation.x).toBeCloseTo(0.05, 12);
    expect(path(120, params, home).translation.z).toBeCloseTo(-0.02, 12);
    expect(path(240, params, home)).toEqual(path(0, params, home));
    for (let clock = 0; clock < 240; clock++) {
      const { x } = path(clock, params, home).translation;
      expect(x).toBeGreaterThanOrEqual(-0.05);
      expect(x).toBeLessThanOrEqual(0.05 + 1e-15);
    }
    const step = (clock: number) =>
      path(clock + 1, params, home).translation.x - path(clock, params, home).translation.x;
    expect(Math.abs(step(0))).toBeLessThan(Math.abs(step(60)) / 10);
    expect(Math.abs(step(119))).toBeLessThan(Math.abs(step(60)) / 10);
  });

  it('starts phaseTicks into its cycle', () => {
    if (!path) return;
    expect(path(0, { ...params, phaseTicks: 120 }, home)).toEqual(path(120, params, home));
  });
});

describe('prop hooks', () => {
  function coin(overrides: Partial<PropCoin> = {}): PropCoin {
    return {
      id: 3,
      translation: { x: 0.03, y: 0.0013, z: 0 },
      rotation: UPRIGHT,
      sleeping: false,
      tier: 'silver',
      ...overrides,
    };
  }
  const centre = { translation: { x: 0, y: 0.0013, z: 0 }, rotation: UPRIGHT };
  const field = PROP_KINDS.attractor.field;
  const params = { reach: 0.05, pull: 0.01, tiers: [] as string[], stirs: false };

  it('pulls a moving coin towards the centre, harder the nearer it is, and nothing outside reach', () => {
    if (!field) throw new Error('attractor has no field');
    const view = { id: 1, params, clock: 0, pose: centre };
    const near = field.kick(coin({ translation: { x: 0.01, y: 0.0013, z: 0 } }), view);
    const far = field.kick(coin({ translation: { x: 0.04, y: 0.0013, z: 0 } }), view);
    expect(near?.x).toBeLessThan(0);
    expect(far?.x).toBeLessThan(0);
    expect(Math.abs(near?.x ?? 0)).toBeGreaterThan(Math.abs(far?.x ?? 0));
    expect(near?.y).toBe(0);
    expect(field.kick(coin({ translation: { x: 0.06, y: 0.0013, z: 0 } }), view)).toBeNull();
    expect(field.kick(coin({ translation: { x: 0.0005, y: 0.0013, z: 0 } }), view)).toBeNull();
  });

  it('leaves a resting coin unless it stirs, and only acts on its tiers', () => {
    if (!field) throw new Error('attractor has no field');
    const view = { id: 1, params, clock: 0, pose: centre };
    expect(field.kick(coin({ sleeping: true }), view)).toBeNull();
    expect(
      field.kick(coin({ sleeping: true }), { ...view, params: { ...params, stirs: true } }),
    ).not.toBeNull();
    const gold = { ...view, params: { ...params, tiers: ['gold'] } };
    expect(field.kick(coin(), gold)).toBeNull();
    expect(field.kick(coin({ tier: 'gold' }), gold)).not.toBeNull();
    expect(field.kick(coin({ tier: null }), gold)).toBeNull();
  });

  it('lets a pocket take and tag the coins of its tiers', () => {
    const enter = PROP_KINDS.pocket.enter;
    if (!enter) throw new Error('pocket has no enter hook');
    const view = (tiers: string[]) => ({
      id: 1,
      params: { take: true, tag: 'pot', tiers },
      clock: 0,
      pose: centre,
    });
    expect(enter.onEnter(coin(), view([]))).toEqual({ consume: true, tag: 'pot' });
    expect(enter.onEnter(coin(), view(['gold']))).toBeNull();
    expect(enter.margin(view([]).params)).toBe(0);
  });
});

describe('prop shapes', () => {
  it('measures signed distance outside, on and inside each shape', () => {
    const box = { kind: 'box', halfExtents: { x: 0.02, y: 0.01, z: 0.03 } } as const;
    expect(signedDistance(box, { x: 0.05, y: 0, z: 0 })).toBeCloseTo(0.03, 12);
    expect(signedDistance(box, { x: 0.05, y: 0.05, z: 0 })).toBeCloseTo(0.05, 12);
    expect(signedDistance(box, { x: 0, y: 0, z: 0 })).toBeCloseTo(-0.01, 12);
    const cylinder = { kind: 'cylinder', halfHeight: 0.01, radius: 0.02 } as const;
    expect(signedDistance(cylinder, { x: 0.03, y: 0, z: 0.04 })).toBeCloseTo(0.03, 12);
    expect(signedDistance(cylinder, { x: 0, y: 0.015, z: 0 })).toBeCloseTo(0.005, 12);
    expect(signedDistance(cylinder, { x: 0.02, y: 0, z: 0 })).toBeCloseTo(0, 12);
    const ball = { kind: 'ball', radius: 0.01 } as const;
    expect(signedDistance(ball, { x: 0, y: 0.03, z: 0.04 })).toBeCloseTo(0.04, 12);
    const capsule = { kind: 'capsule', halfHeight: 0.02, radius: 0.005 } as const;
    expect(signedDistance(capsule, { x: 0.01, y: 0.01, z: 0 })).toBeCloseTo(0.005, 12);
    expect(signedDistance(capsule, { x: 0, y: 0.03, z: 0 })).toBeCloseTo(0.005, 12);
  });

  it('measures in the prop frame, after its rotation', () => {
    const half = Math.sqrt(0.5);
    const lying = { x: 0, y: 0, z: half, w: half };
    expect(rotate(lying, { x: 0, y: 1, z: 0 }).x).toBeCloseTo(-1, 12);
    const capsule = { kind: 'capsule', halfHeight: 0.02, radius: 0.005 } as const;
    const at = { x: 0.1, y: 0.01, z: 0 };
    expect(distanceAt(capsule, at, lying, { x: 0.115, y: 0.01, z: 0 })).toBeCloseTo(-0.005, 12);
    expect(distanceAt(capsule, at, lying, { x: 0.1, y: 0.025, z: 0 })).toBeCloseTo(0.01, 12);
  });
});

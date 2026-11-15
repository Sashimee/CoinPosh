import type { PrizeFamily } from '@coinposh/shared';
import {
  BoxGeometry,
  type BufferGeometry,
  CircleGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Shape,
  TorusGeometry,
} from 'three/webgpu';
import type { PrizeLook } from './looks.ts';
import {
  facet,
  type Finish,
  lathe,
  merge,
  paint,
  place,
  type Profile,
  roundedRectLoop,
  tube,
} from './shapes.ts';

/**
 * One prize's geometry, merged per material so a whole prize draws in a handful of calls.
 * `hand` is the watch's seconds hand, kept apart so it can turn about the dial centre at
 * `handPivot`.
 */
export interface PrizeGeometry {
  readonly metal: BufferGeometry;
  readonly glass: BufferGeometry | null;
  readonly scent: BufferGeometry | null;
  readonly leather: BufferGeometry | null;
  readonly hand: BufferGeometry | null;
  readonly handPivot: readonly [number, number, number];
}

/** Segments around a turned part; low enough for 60 fps with a dozen prizes on the table. */
export interface ModelDetail {
  readonly round: number;
}

export const MODEL_DETAIL = {
  low: { round: 28 },
  medium: { round: 40 },
  high: { round: 56 },
} as const;

const TAU = Math.PI * 2;
const POLISHED: Finish = { metal: 1, rough: 0.07 };
const ENAMEL: Finish = { metal: 0, rough: 0.14, coat: 1 };
/** Galvanic sunburst dials are tinted metal under lacquer, so they mirror the sky in their own hue. */
const DIAL: Finish = { metal: 0.85, rough: 0.26, coat: 0.6 };
const LEATHER: Finish = { metal: 0, rough: 0.62 };
const VELVET: Finish = { metal: 0, rough: 0.85, brush: 1 };
const THREAD: Finish = { metal: 0, rough: 0.7, coat: 1 };
const GLASS: Finish = { metal: 0, rough: 0.02 };

function brushed(look: PrizeLook): Finish {
  return { metal: 1, rough: 0.2 + 0.08 * look.brush, brush: look.brush };
}

/**
 * A rounded-rectangle slab lying in XZ from y = `base` up by `height`, with softened edges. Its
 * UVs are projected from above onto 0..1, so a turned pattern spans the top face; extrusion's
 * own UVs are in shape units, a thousandth of what the patterns expect.
 */
function slab(
  halfX: number,
  halfZ: number,
  corner: number,
  height: number,
  base: number,
  bevel: number,
): BufferGeometry {
  const shape = new Shape();
  const x = halfX - bevel;
  const z = halfZ - bevel;
  const c = Math.min(corner, x, z);
  shape.moveTo(-x + c, -z);
  shape.lineTo(x - c, -z);
  shape.absarc(x - c, -z + c, c, -Math.PI / 2, 0, false);
  shape.lineTo(x, z - c);
  shape.absarc(x - c, z - c, c, 0, Math.PI / 2, false);
  shape.lineTo(-x + c, z);
  shape.absarc(-x + c, z - c, c, Math.PI / 2, Math.PI, false);
  shape.lineTo(-x, -z + c);
  shape.absarc(-x + c, -z + c, c, Math.PI, Math.PI * 1.5, false);
  const geometry = new ExtrudeGeometry(shape, {
    depth: height - 2 * bevel,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 3,
    curveSegments: 6,
  });
  place(geometry, { at: [0, base + bevel, 0], rotate: [-Math.PI / 2, 0, 0] });
  const pos = geometry.getAttribute('position');
  const uvs = geometry.getAttribute('uv');
  for (let i = 0; i < pos.count; i += 1) {
    uvs.setXY(i, (pos.getX(i) + halfX) / (2 * halfX), (pos.getZ(i) + halfZ) / (2 * halfZ));
  }
  return geometry;
}

/** A flat disc facing up at height `y`, its UVs centred on 0.5 for the turned patterns. */
function disc(radius: number, y: number, segments: number): BufferGeometry {
  return place(new CircleGeometry(radius, segments), {
    at: [0, y, 0],
    rotate: [-Math.PI / 2, 0, 0],
  });
}

function box(
  size: readonly [number, number, number],
  at: readonly [number, number, number],
  rotateY = 0,
): BufferGeometry {
  return place(new BoxGeometry(size[0], size[1], size[2]), { at, rotate: [0, rotateY, 0] });
}

/**
 * A strap leaving the case towards `side` (+1 or -1 along z): a pebbled leather band that
 * drapes from the lugs down to the cloth, ringed with tan stitching.
 */
function strap(look: PrizeLook, side: number, start: number, end: number): BufferGeometry[] {
  const width = 0.0196;
  const thick = 0.0028;
  const length = end - start;
  const band = new BoxGeometry(width, thick, length, 1, 1, 14);
  const pos = band.getAttribute('position');
  for (let i = 0; i < pos.count; i += 1) {
    const along = (pos.getZ(i) + length / 2) / length;
    const drop = 0.0034 * (1 - along) * (1 - along);
    const taper = 1 - 0.14 * along;
    pos.setXYZ(i, pos.getX(i) * taper, pos.getY(i) + drop, pos.getZ(i));
  }
  band.computeVertexNormals();
  place(band, { at: [0, thick / 2, side * (start + length / 2)] });
  const stitches = roundedRectLoop(width / 2 - 0.0019, length / 2 - 0.0016, 0.002, 0).map(
    ([x, , z]): [number, number, number] => {
      const along = (z + length / 2) / length;
      const lifted = 0.0034 * (1 - along) * (1 - along);
      return [x * (1 - 0.14 * along), thick + lifted + 0.00005, side * (start + length / 2 + z)];
    },
  );
  return [
    paint(band, look.leather, LEATHER),
    paint(tube(stitches, 0.00028, 160, 4, true), look.thread, THREAD),
  ];
}

function watch(look: PrizeLook, detail: ModelDetail): PrizeGeometry {
  const n = detail.round;
  const caseProfile: Profile = [
    [0, 0.0012],
    [0.0158, 0.0012],
    [0.0172, 0.0022],
    [0.0182, 0.0046],
    [0.0181, 0.0066],
    [0.0172, 0.0079],
    [0.0166, 0.0082],
  ];
  const bezelProfile: Profile = [
    [0.0166, 0.0082],
    [0.0171, 0.0087],
    [0.0164, 0.0094],
    [0.0151, 0.0095],
    [0.0149, 0.0088],
  ];
  const crystalProfile: Profile = [
    [0.0149, 0.0087],
    [0.0149, 0.0092],
    [0.0136, 0.0099],
    [0.0085, 0.0104],
    [0, 0.0105],
  ];
  const dialY = 0.0081;
  const metal: BufferGeometry[] = [
    paint(lathe(caseProfile, n), look.metal, brushed(look)),
    paint(lathe(bezelProfile, n), look.trim, POLISHED),
    paint(disc(0.0149, dialY, n), look.enamel, DIAL, 'sunburst'),
    paint(
      place(new CylinderGeometry(0.0012, 0.0012, 0.0024, 16), {
        at: [0.0188, 0.0052, 0],
        rotate: [0, 0, Math.PI / 2],
      }),
      look.trim,
      POLISHED,
    ),
    paint(
      place(new CylinderGeometry(0.0016, 0.0016, 0.0006, 20), {
        at: [0.0197, 0.0052, 0],
        rotate: [0, 0, Math.PI / 2],
      }),
      look.metal,
      brushed(look),
    ),
    paint(
      place(new CylinderGeometry(0.0009, 0.0009, 0.0005, 12), { at: [0, dialY + 0.0007, 0] }),
      look.trim,
      POLISHED,
    ),
  ];
  for (let i = 0; i < 12; i += 1) {
    const a = (i / 12) * TAU;
    const long = i % 3 === 0;
    const r = 0.0122;
    metal.push(
      paint(
        box(
          [long ? 0.0011 : 0.0007, 0.0004, long ? 0.0036 : 0.0022],
          [Math.sin(a) * r, dialY + 0.0002, -Math.cos(a) * r],
          -a,
        ),
        look.trim,
        POLISHED,
      ),
    );
  }
  const hand = (length: number, width: number, angle: number, lift: number): BufferGeometry => {
    const g = box([width, 0.00025, length], [0, dialY + lift, -length / 2 + 0.0012]);
    return place(g, { rotate: [0, -angle, 0] });
  };
  metal.push(
    paint(
      hand(0.0082, 0.0011, (10 / 12) * TAU + (10 / 60) * (TAU / 12), 0.0004),
      look.trim,
      POLISHED,
    ),
    paint(hand(0.0118, 0.0008, (10 / 60) * TAU, 0.00055), look.trim, POLISHED),
  );
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const lug = slab(0.0018, 0.0042, 0.0012, 0.0036, 0.0018, 0.0006);
      metal.push(
        paint(place(lug, { at: [sx * 0.0092, 0, sz * 0.0178] }), look.metal, brushed(look)),
      );
    }
  }
  const buckleZ = -0.0405;
  const buckle = tube(roundedRectLoop(0.0115, 0.0026, 0.0012, 0.0021), 0.0006, 48, 8, true);
  metal.push(
    paint(place(buckle, { at: [0, -0.0003, buckleZ] }), look.trim, POLISHED),
    paint(box([0.0006, 0.0006, 0.0052], [0, 0.0026, buckleZ]), look.trim, POLISHED),
  );
  const leather = [...strap(look, 1, 0.0158, 0.043), ...strap(look, -1, 0.0158, 0.0405)];
  const glass = paint(lathe(crystalProfile, n), look.glass, { ...GLASS, brush: 1 });
  const secondsHand = merge(
    [
      paint(box([0.00045, 0.0002, 0.0158], [0, 0, -0.0055]), look.accent, POLISHED),
      paint(new CylinderGeometry(0.0006, 0.0006, 0.0003, 12), look.accent, POLISHED),
    ],
    'prize/watch/hand',
  );
  return {
    metal: merge(metal, 'prize/watch/metal'),
    glass: merge([glass], 'prize/watch/glass'),
    scent: null,
    leather: merge(leather, 'prize/watch/leather'),
    hand: secondsHand,
    handPivot: [0, dialY + 0.0008, 0],
  };
}

/** Built standing up (neck along +y), then laid on its broad face with the neck towards -z. */
function perfume(look: PrizeLook): PrizeGeometry {
  const flat = 0.62;
  const lay = (g: BufferGeometry): BufferGeometry =>
    place(place(g, { scale: [1, 1, flat] }), { rotate: [-Math.PI / 2, 0, 0] });
  const facets = (profile: Profile, sides: number): BufferGeometry =>
    facet(place(lathe(profile, sides), { rotate: [0, -Math.PI / sides, 0] }));
  const bottle: Profile = [
    [0, 0],
    [0.0158, 0],
    [0.0184, 0.0024],
    [0.0184, 0.0352],
    [0.0158, 0.0392],
    [0.0064, 0.0412],
    [0.0058, 0.0414],
  ];
  const scent: Profile = [
    [0, 0.0036],
    [0.0134, 0.0036],
    [0.0152, 0.0054],
    [0.0152, 0.0318],
    [0, 0.0318],
  ];
  const collar: Profile = [
    [0.0056, 0.0406],
    [0.0068, 0.0408],
    [0.0069, 0.0446],
    [0.0062, 0.0452],
  ];
  const cap: Profile = [
    [0.0062, 0.0452],
    [0.0104, 0.0458],
    [0.0108, 0.0466],
    [0.0108, 0.0634],
    [0.0098, 0.0644],
    [0, 0.0646],
  ];
  const glass = paint(lay(facets(bottle, 8)), look.glass, GLASS);
  const liquid = paint(lay(facets(scent, 8)), look.scent, { metal: 0, rough: 0.1 });
  const frontFace = 0.0184 * Math.cos(Math.PI / 8) * flat;
  const plaque = slab(0.0062, 0.0044, 0.0012, 0.0005, frontFace - 0.0001, 0.00015);
  place(plaque, { at: [0, 0, -0.019] });
  const metal = [
    paint(lay(lathe(collar, 32)), look.trim, POLISHED),
    paint(lay(facets(cap, 8)), look.enamel, { ...ENAMEL, coat: 0.7 }),
    paint(plaque, look.metal, { metal: 1, rough: 0.3 }, 'clous'),
    paint(
      lay(place(new CylinderGeometry(0.0036, 0.0036, 0.0005, 24), { at: [0, 0.0648, 0] })),
      look.trim,
      POLISHED,
    ),
  ];
  return {
    metal: merge(metal, 'prize/perfume/metal'),
    glass: merge([glass], 'prize/perfume/glass'),
    scent: merge([liquid], 'prize/perfume/scent'),
    leather: null,
    hand: null,
    handPivot: [0, 0, 0],
  };
}

function cufflinks(look: PrizeLook, detail: ModelDetail): PrizeGeometry {
  const n = detail.round;
  const padTop = 0.0062;
  const pad = paint(slab(0.026, 0.017, 0.006, padTop, 0, 0.0016), look.leather, VELVET);
  const slit = paint(slab(0.021, 0.0007, 0.0006, 0.0003, padTop - 0.0002, 0.0001), '#050505', {
    metal: 0,
    rough: 1,
  });
  const face: Profile = [
    [0, 0.0078],
    [0.0079, 0.0078],
    [0.0086, 0.0088],
    [0.0088, 0.0106],
    [0.0083, 0.0117],
    [0.0073, 0.0119],
    [0.0071, 0.0115],
  ];
  const metal: BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const x = side * 0.0128;
    metal.push(
      paint(place(lathe(face, n), { at: [x, 0, 0] }), look.gold, { ...brushed(look), brush: 0 }),
      paint(place(disc(0.0071, 0.0115, n), { at: [x, 0, 0] }), look.enamel, ENAMEL, 'clous'),
      paint(
        place(new CylinderGeometry(0.0014, 0.0016, 0.0022, 16), { at: [x, padTop + 0.0008, 0] }),
        look.gold,
        POLISHED,
      ),
    );
  }
  return {
    metal: merge(metal, 'prize/cufflinks/metal'),
    glass: null,
    scent: null,
    leather: merge([pad, slit], 'prize/cufflinks/leather'),
    hand: null,
    handPivot: [0, 0, 0],
  };
}

/** The key blade's outline in its own plane: x across, y from the head (0) to the tip. */
function bladeShape(): Shape {
  const shape = new Shape();
  const w = 0.0042;
  const teeth: readonly [number, number][] = [
    [0.004, 0],
    [0.008, -0.0014],
    [0.0115, -0.0004],
    [0.0155, -0.0018],
    [0.019, -0.0006],
    [0.0225, -0.0016],
    [0.0262, -0.0005],
  ];
  shape.moveTo(-w, 0);
  shape.lineTo(w, 0);
  shape.lineTo(w, 0.0285);
  shape.quadraticCurveTo(w, 0.0318, 0.0008, 0.0322);
  for (const [y, dx] of [...teeth].reverse()) {
    shape.lineTo(-w - dx, y);
  }
  shape.lineTo(-w, 0);
  return shape;
}

function carKeys(look: PrizeLook, detail: ModelDetail): PrizeGeometry {
  const fobZ = 0.0175;
  const fobTop = 0.0088;
  const fob = paint(
    place(slab(0.0165, 0.0225, 0.0105, fobTop, 0, 0.0022), { at: [0, 0, fobZ] }),
    look.leather,
    LEATHER,
  );
  const stitching = roundedRectLoop(0.0165 - 0.0034, 0.0225 - 0.0034, 0.0076, fobTop + 0.00004).map(
    ([x, y, z]): [number, number, number] => [x, y, z + fobZ],
  );
  const thread = paint(tube(stitching, 0.0003, 200, 4, true), look.thread, THREAD);
  const badgeZ = fobZ + 0.002;
  const badgeRim: Profile = [
    [0.0074, fobTop],
    [0.0076, fobTop + 0.0006],
    [0.0072, fobTop + 0.0011],
    [0.0062, fobTop + 0.0011],
  ];
  const head = slab(0.0072, 0.0052, 0.0028, 0.0062, 0.0013, 0.0012);
  const blade = new ExtrudeGeometry(bladeShape(), {
    depth: 0.0021,
    bevelEnabled: true,
    bevelThickness: 0.0002,
    bevelSize: 0.0002,
    bevelSegments: 1,
    curveSegments: 6,
  });
  place(blade, { at: [0, 0.0034, -0.0095], rotate: [-Math.PI / 2, 0, 0] });
  const groove = box([0.0012, 0.0003, 0.024], [0.0012, 0.0057, -0.0225]);
  const ring = place(new TorusGeometry(0.0075, 0.00085, 10, 48), {
    at: [0, 0.0012, fobZ + 0.026],
    rotate: [-Math.PI / 2, 0, 0],
  });
  const loop = place(new TorusGeometry(0.0034, 0.0009, 8, 24), {
    at: [0, 0.0044, fobZ + 0.0222],
    rotate: [0, Math.PI / 2, 0],
  });
  const chrome: Finish = { metal: 1, rough: 0.1, brush: 0.25 };
  const metal = [
    paint(place(lathe(badgeRim, detail.round), { at: [0, 0, badgeZ] }), look.trim, POLISHED),
    paint(
      place(disc(0.0063, fobTop + 0.0009, detail.round), { at: [0, 0, badgeZ] }),
      look.enamel,
      ENAMEL,
      'clous',
    ),
    paint(place(head, { at: [0, 0, -0.0062] }), look.trim, chrome),
    paint(blade, look.trim, chrome),
    paint(groove, look.trim, { metal: 1, rough: 0.28 }),
    paint(ring, look.trim, POLISHED),
    paint(loop, look.trim, POLISHED),
  ];
  return {
    metal: merge(metal, 'prize/carKeys/metal'),
    glass: null,
    scent: null,
    leather: merge([fob, thread], 'prize/carKeys/leather'),
    hand: null,
    handPivot: [0, 0, 0],
  };
}

export function buildPrizeGeometry(
  family: PrizeFamily,
  look: PrizeLook,
  detail: ModelDetail,
): PrizeGeometry {
  switch (family) {
    case 'watch':
      return watch(look, detail);
    case 'perfume':
      return perfume(look);
    case 'cufflinks':
      return cufflinks(look, detail);
    case 'carKeys':
      return carKeys(look, detail);
  }
}

export function disposePrizeGeometry(geometry: PrizeGeometry): void {
  geometry.metal.dispose();
  geometry.glass?.dispose();
  geometry.scent?.dispose();
  geometry.leather?.dispose();
  geometry.hand?.dispose();
}

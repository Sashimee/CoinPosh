import type { StaffRole } from '@coinposh/shared';
import { type BufferGeometry, CylinderGeometry, SphereGeometry } from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { rivieraTokens } from '../venues/riviera/palette.ts';
import { type BoneName, JOINTS, type Vec3 } from './rig.ts';
import {
  across,
  ball,
  BOTTLE_GLASS,
  BRUSHED_GOLD,
  COTTON,
  dress,
  type Finish,
  GOLD,
  LACQUER,
  lathe,
  LEATHER,
  limb,
  over,
  POLISHED_GOLD,
  PORCELAIN,
  type Profile,
  radiusAt,
  SILK,
  tube,
  VELVET,
  type Weights,
  WOOL,
} from './shapes.ts';

/** Front-to-back squash of the torso: figures read as shoulders, not barrels. */
const DEPTH = 0.74;
const HEM_Y = 0.031;
const HEAD_CENTER: Vec3 = [0, 0.0662, 0];
const HEAD_R = 0.008;
const HEAD_SCALE: Vec3 = [0.96, 1.1, 1];

const TORSO: Profile = [
  [0.0062, 0.0237],
  [0.0072, 0.0262],
  [0.0074, 0.0295],
  [0.0069, 0.0335],
  [0.0074, 0.0385],
  [0.0086, 0.045],
  [0.0093, 0.05],
  [0.0094, 0.053],
  [0.0084, 0.0552],
  [0.0058, 0.0566],
  [0.003, 0.0574],
];

/** How far forward the torso surface sits at height `y`, `x` off the centre line. */
function frontZ(y: number, x = 0, lift = 0): number {
  const r = radiusAt(TORSO, y) + lift;
  return DEPTH * Math.sqrt(Math.max(r * r - x * x, 0));
}

function torsoBind(_x: number, y: number): Weights {
  if (y < 0.0305) return [['pelvis', 1]];
  if (y < 0.0365) return across('pelvis', 'spine', 0.0305, 0.0365)(0, y);
  if (y < 0.0425) return [['spine', 1]];
  return across('spine', 'chest', 0.0425, 0.0475)(0, y);
}

interface Livery {
  readonly coat: string;
  readonly coatFinish: Finish;
  readonly sleeve: string;
  readonly sleeveFinish: Finish;
  readonly trousers: string;
  readonly shirt: string;
  readonly skin: string;
  readonly hair: string;
  readonly hands: string;
  readonly handFinish: Finish;
  readonly shoes: string;
}

export interface FigureParts {
  /** Every opaque part, merged into the one livery mesh. */
  readonly livery: BufferGeometry[];
  /** The sommelier's crystal glass, the one transparent mesh of the household. */
  readonly glass: BufferGeometry[];
}

type Side = 'L' | 'R';
const SIDES: readonly Side[] = ['L', 'R'];
const sign = (side: Side): number => (side === 'L' ? 1 : -1);
const bone = (name: 'shoulder' | 'elbow' | 'hand' | 'hip' | 'knee' | 'prop', side: Side) =>
  `${name}${side}` as BoneName;
const offset = (at: Vec3, by: Vec3): Vec3 => [at[0] + by[0], at[1] + by[1], at[2] + by[2]];

function body(look: Livery, seg: number): BufferGeometry[] {
  const parts: BufferGeometry[] = [];
  const push = (
    g: BufferGeometry,
    hex: string,
    finish: Finish,
    bind: Parameters<typeof dress>[3],
  ) => parts.push(dress(g, hex, finish, bind));
  const lower: Profile = [[0, 0.0237], ...over(TORSO, 0.0237, HEM_Y, 0, 5)];
  const upper: Profile = [...over(TORSO, HEM_Y, 0.0574, 0, 16), [0, 0.0574]];
  push(lathe(lower, seg, { depth: DEPTH }), look.trousers, WOOL, 'pelvis');
  push(lathe(upper, seg, { depth: DEPTH }), look.coat, look.coatFinish, torsoBind);
  push(ball(0.0068, [0, 0.0258, 0], seg, [1.02, 0.5, 0.76]), look.trousers, WOOL, 'pelvis');

  const neckR = 0.0025;
  push(
    limb(neckR, neckR * 0.94, [0, 0.0552, 0], [0, 0.0618, 0], seg),
    look.skin,
    PORCELAIN,
    across('chest', 'head', 0.0572, 0.0596),
  );
  push(ball(HEAD_R, HEAD_CENTER, seg, HEAD_SCALE), look.skin, PORCELAIN, 'head');
  for (const side of SIDES) {
    push(
      ball(
        0.00135,
        offset(HEAD_CENTER, [sign(side) * HEAD_R * 0.94, -0.0004, -0.0006]),
        10,
        [0.55, 1, 0.8],
      ),
      look.skin,
      PORCELAIN,
      'head',
    );
  }
  const crown = new SphereGeometry(
    HEAD_R * 1.045,
    seg,
    Math.round(seg * 0.6),
    0,
    Math.PI * 2,
    0,
    1.05,
  );
  crown.scale(...HEAD_SCALE).translate(...HEAD_CENTER);
  push(crown, look.hair, LACQUER, 'head');
  const nape = new SphereGeometry(
    HEAD_R * 1.04,
    seg,
    Math.round(seg * 0.5),
    (Math.PI * 3) / 2 - 1.5,
    3,
    0.95,
    1.05,
  );
  nape.scale(...HEAD_SCALE).translate(...HEAD_CENTER);
  push(nape, look.hair, LACQUER, 'head');

  for (const side of SIDES) {
    const s = sign(side);
    const shoulder = JOINTS[bone('shoulder', side)];
    const elbow = JOINTS[bone('elbow', side)];
    const hand = JOINTS[bone('hand', side)];
    push(ball(0.0031, shoulder, seg), look.sleeve, look.sleeveFinish, bone('shoulder', side));
    push(
      limb(0.0028, 0.0025, shoulder, elbow, seg),
      look.sleeve,
      look.sleeveFinish,
      bone('shoulder', side),
    );
    push(ball(0.00252, elbow, seg), look.sleeve, look.sleeveFinish, bone('elbow', side));
    push(
      limb(0.0025, 0.0022, elbow, offset(hand, [0, 0.0012, 0]), seg),
      look.sleeve,
      look.sleeveFinish,
      bone('elbow', side),
    );
    push(
      limb(0.00238, 0.00236, offset(hand, [0, 0.0022, 0]), offset(hand, [0, 0.0006, 0]), seg),
      look.shirt,
      COTTON,
      bone('elbow', side),
    );
    push(
      ball(0.0021, offset(hand, [0, -0.0021, 0]), seg, [0.82, 1.22, 0.92]),
      look.hands,
      look.handFinish,
      bone('hand', side),
    );
    push(
      ball(0.00085, offset(hand, [-s * 0.0011, -0.0013, 0.0013]), 10, [1, 1.3, 1]),
      look.hands,
      look.handFinish,
      bone('hand', side),
    );

    const hip = JOINTS[bone('hip', side)];
    const knee = JOINTS[bone('knee', side)];
    const ankle: Vec3 = [knee[0], 0.003, 0];
    push(limb(0.0042, 0.0036, hip, knee, seg), look.trousers, WOOL, bone('hip', side));
    push(ball(0.0036, knee, seg), look.trousers, WOOL, bone('knee', side));
    push(limb(0.0036, 0.0031, knee, ankle, seg), look.trousers, WOOL, bone('knee', side));
    push(
      ball(0.0028, [knee[0] + s * 0.0002, 0.0018, 0.0013], seg, [0.95, 0.62, 1.58]),
      look.shoes,
      LACQUER,
      bone('knee', side),
    );
  }
  return parts;
}

/** The steamer trunk a figure sits on while on leave: hidden at work. */
function trunk(seg: number): BufferGeometry[] {
  const at = JOINTS.trunk;
  const h = 0.0105;
  const parts = [
    dress(
      new RoundedBoxGeometry(0.0235, h, 0.0152, 2, 0.0012).translate(at[0], h / 2, at[2]),
      '#4A2C1A',
      LEATHER,
      'trunk',
    ),
  ];
  for (const x of [-0.0072, 0.0072]) {
    parts.push(
      dress(
        new RoundedBoxGeometry(0.0018, h + 0.0004, 0.0156, 1, 0.0004).translate(
          x,
          (h + 0.0004) / 2,
          at[2],
        ),
        '#D9C29A',
        LEATHER,
        'trunk',
      ),
    );
  }
  for (const x of [-0.0112, 0.0112]) {
    for (const z of [-0.0072, 0.0072]) {
      parts.push(
        dress(
          ball(0.0012, [x, h - 0.0006, at[2] + z], Math.min(seg, 12)),
          GOLD.polished,
          POLISHED_GOLD,
          'trunk',
        ),
      );
    }
  }
  parts.push(
    dress(
      new RoundedBoxGeometry(0.0032, 0.0026, 0.0012, 1, 0.0003).translate(
        0,
        h - 0.0016,
        at[2] + 0.0077,
      ),
      GOLD.polished,
      POLISHED_GOLD,
      'trunk',
    ),
  );
  return parts;
}

const TUX = '#121726';
const IVORY = rivieraTokens.ivory;
const CHAMPAGNE = rivieraTokens.champagne;

function buttonsAt(ys: readonly number[], x: number, lift: number): Vec3[] {
  return ys.map((y) => [x, y, frontZ(y, x, lift)] as Vec3);
}

function butler(seg: number): FigureParts {
  const look: Livery = {
    coat: TUX,
    coatFinish: WOOL,
    sleeve: TUX,
    sleeveFinish: WOOL,
    trousers: '#0E121C',
    shirt: IVORY,
    skin: '#D7A982',
    hair: '#9C9892',
    hands: IVORY,
    handFinish: COTTON,
    shoes: '#08090C',
  };
  const parts = body(look, seg);
  parts.push(
    dress(
      lathe(over(TORSO, 0.0405, 0.0567, 0.0002), seg, { depth: DEPTH, phi: [-0.48, 0.96] }),
      IVORY,
      COTTON,
      torsoBind,
    ),
    dress(
      lathe(over(TORSO, 0.0312, 0.0468, 0.00042), seg, { depth: DEPTH, phi: [-0.72, 1.44] }),
      CHAMPAGNE,
      SILK,
      torsoBind,
    ),
  );
  for (const at of buttonsAt([0.0345, 0.0385, 0.0425], 0, 0.0006)) {
    parts.push(dress(ball(0.00055, at, 10), GOLD.polished, POLISHED_GOLD, torsoBind));
  }
  const chain: [number, number, number][] = [];
  for (let i = 0; i <= 8; i += 1) {
    const x = -0.0046 + (0.0092 * i) / 8;
    const y = 0.0372 - 0.0017 * (1 - (x / 0.0046) ** 2);
    chain.push([x, y, frontZ(y, x, 0.0006)]);
  }
  parts.push(dress(tube(chain, 0.00022, 24, 5), GOLD.polished, POLISHED_GOLD, torsoBind));
  for (const side of SIDES) {
    const s = sign(side);
    parts.push(
      dress(
        limb(
          0.00055,
          0.0005,
          [s * 0.0036, 0.0558, frontZ(0.0558, s * 0.0036, 0.0003)],
          [s * 0.0058, 0.0408, frontZ(0.0408, s * 0.0058, 0.0003)],
          6,
        ),
        '#1E2436',
        SILK,
        torsoBind,
      ),
      dress(
        ball(0.0016, [s * 0.0017, 0.0566, 0.0033], 10, [1.15, 0.7, 0.5]),
        '#050608',
        VELVET,
        'chest',
      ),
    );
  }
  parts.push(
    dress(ball(0.0007, [0, 0.0566, 0.0036], 8), '#050608', VELVET, 'chest'),
    dress(
      ball(0.001, [0.0057, 0.0505, frontZ(0.0505, 0.0057, 0.0003)], 8, [1, 0.6, 0.4]),
      IVORY,
      SILK,
      'chest',
    ),
  );
  for (const phi of [Math.PI - 0.9, Math.PI + 0.06]) {
    parts.push(
      dress(
        lathe(
          [
            [0.0084, 0.0158],
            [0.0086, 0.0225],
            [0.0081, 0.029],
            [0.0078, 0.0338],
          ],
          seg,
          { depth: DEPTH + 0.06, phi: [phi, 0.84] },
        ),
        TUX,
        WOOL,
        'pelvis',
      ),
    );
  }

  const p = JOINTS.propL;
  const trayY = p[1] + 0.0016;
  const top = trayY + 0.0009;
  parts.push(
    dress(
      lathe(
        [
          [0, 0],
          [0.0088, 0],
          [0.0097, 0.0007],
          [0.0095, 0.0009],
          [0.0087, 0.0004],
          [0, 0.0004],
        ],
        seg + 8,
        { at: [p[0], trayY, p[2]] },
      ),
      GOLD.brushed,
      BRUSHED_GOLD,
      'propL',
    ),
  );
  [0, 0.0007, 0.0014].forEach((dy, i) => {
    const coin = new CylinderGeometry(0.0029, 0.0029, 0.00064, seg + 8).translate(
      p[0] + i * 0.0002,
      top + dy - 0.00004,
      p[2] - i * 0.0002,
    );
    parts.push(dress(coin, GOLD.polished, POLISHED_GOLD, 'propL'));
  });
  parts.push(
    dress(
      lathe(
        [
          [0.0067, 0],
          [0.0067, 0.0005],
          [0.0061, 0.0026],
          [0.0047, 0.0046],
          [0.0025, 0.0058],
          [0, 0.0061],
        ],
        seg + 8,
        { at: [p[0], top, p[2]] },
      ),
      GOLD.polished,
      POLISHED_GOLD,
      'lid',
    ),
    dress(
      lathe(
        [
          [0.0069, 0],
          [0.007, 0.0004],
          [0.0068, 0.0008],
        ],
        seg + 8,
        { at: [p[0], top, p[2]] },
      ),
      GOLD.brushed,
      BRUSHED_GOLD,
      'lid',
    ),
    dress(
      lathe(
        [
          [0, 0.0057],
          [0.0024, 0.0054],
          [0.0045, 0.0043],
          [0.0059, 0.0025],
          [0.0065, 0.0004],
        ],
        seg + 8,
        { at: [p[0], top, p[2]] },
      ),
      GOLD.brushed,
      BRUSHED_GOLD,
      'lid',
    ),
    dress(ball(0.00105, [p[0], top + 0.0066, p[2]], 12), GOLD.polished, POLISHED_GOLD, 'lid'),
  );
  parts.push(...trunk(seg));
  return { livery: parts, glass: [] };
}

function valet(seg: number): FigureParts {
  const jacket = '#A3302A';
  const navy = '#14213D';
  const look: Livery = {
    coat: jacket,
    coatFinish: VELVET,
    sleeve: jacket,
    sleeveFinish: VELVET,
    trousers: navy,
    shirt: IVORY,
    skin: '#C08A60',
    hair: '#3B2416',
    hands: IVORY,
    handFinish: COTTON,
    shoes: '#08090C',
  };
  const parts = body(look, seg);
  const hemR = radiusAt(TORSO, HEM_Y);
  parts.push(
    dress(
      lathe(
        [
          [hemR + 0.0001, HEM_Y - 0.0006],
          [hemR + 0.0005, HEM_Y - 0.0002],
          [hemR + 0.0004, HEM_Y + 0.0009],
          [hemR, HEM_Y + 0.0014],
        ],
        seg,
        { depth: DEPTH },
      ),
      GOLD.brushed,
      BRUSHED_GOLD,
      'pelvis',
    ),
    dress(
      lathe(
        [
          [0.0031, 0.0552],
          [0.0034, 0.0558],
          [0.0033, 0.0584],
          [0.0029, 0.0586],
        ],
        seg,
      ),
      jacket,
      VELVET,
      'chest',
    ),
    dress(
      lathe(
        [
          [0.00345, 0.0578],
          [0.0035, 0.0582],
          [0.0031, 0.0587],
        ],
        seg,
      ),
      GOLD.polished,
      POLISHED_GOLD,
      'chest',
    ),
  );
  for (const x of [-0.0029, 0.0029]) {
    for (const at of buttonsAt([0.0345, 0.0392, 0.0438], x, 0.0005)) {
      parts.push(dress(ball(0.00058, at, 10), GOLD.polished, POLISHED_GOLD, torsoBind));
    }
  }
  for (const side of SIDES) {
    const s = sign(side);
    const shoulder = JOINTS[bone('shoulder', side)];
    const hand = JOINTS[bone('hand', side)];
    const hip = JOINTS[bone('hip', side)];
    const knee = JOINTS[bone('knee', side)];
    parts.push(
      dress(
        ball(0.0028, offset(shoulder, [s * 0.0004, 0.0021, 0]), seg, [1.2, 0.42, 1.1]),
        GOLD.polished,
        POLISHED_GOLD,
        bone('shoulder', side),
      ),
      dress(
        limb(0.00262, 0.00262, offset(hand, [0, 0.0034, 0]), offset(hand, [0, 0.0024, 0]), seg),
        GOLD.brushed,
        BRUSHED_GOLD,
        bone('elbow', side),
      ),
      dress(
        limb(
          0.00042,
          0.00042,
          offset(hip, [s * 0.0036, -0.0004, 0]),
          offset(knee, [s * 0.0033, 0, 0]),
          5,
        ),
        GOLD.brushed,
        BRUSHED_GOLD,
        bone('hip', side),
      ),
      dress(
        limb(
          0.00042,
          0.00042,
          offset(knee, [s * 0.0033, 0, 0]),
          [knee[0] + s * 0.003, 0.0035, 0],
          5,
        ),
        GOLD.brushed,
        BRUSHED_GOLD,
        bone('knee', side),
      ),
    );
  }

  const hat = JOINTS.hat;
  const tilt = (g: BufferGeometry) =>
    g
      .translate(-hat[0], -hat[1], -hat[2])
      .rotateZ(-0.16)
      .rotateX(-0.08)
      .translate(...hat);
  const hatBase = hat[1] - 0.0016;
  parts.push(
    dress(
      tilt(
        lathe(
          [
            [0, 0],
            [0.005, 0],
            [0.0053, 0.0005],
            [0.0053, 0.0046],
            [0.005, 0.0051],
            [0, 0.0051],
          ],
          seg,
          { at: [0, hatBase, 0.0004] },
        ),
      ),
      navy,
      LACQUER,
      'hat',
    ),
    dress(
      tilt(
        lathe(
          [
            [0.00535, 0.0008],
            [0.0055, 0.0011],
            [0.0055, 0.0019],
            [0.00535, 0.0022],
          ],
          seg,
          { at: [0, hatBase, 0.0004] },
        ),
      ),
      GOLD.brushed,
      BRUSHED_GOLD,
      'hat',
    ),
    dress(
      tilt(ball(0.00075, [0, hatBase + 0.0054, 0.0004], 10)),
      GOLD.polished,
      POLISHED_GOLD,
      'hat',
    ),
  );

  const p = JOINTS.propR;
  const caseH = 0.0112;
  const caseY = p[1] - 0.0019 - caseH / 2;
  parts.push(
    dress(
      new RoundedBoxGeometry(0.0062, caseH, 0.0172, 2, 0.0013).translate(p[0], caseY, p[2]),
      '#7B4526',
      LEATHER,
      'propR',
    ),
  );
  for (const z of [-0.0046, 0.0046]) {
    parts.push(
      dress(
        new RoundedBoxGeometry(0.0066, caseH + 0.0003, 0.0013, 1, 0.0004).translate(
          p[0],
          caseY,
          p[2] + z,
        ),
        '#E0CBA4',
        LEATHER,
        'propR',
      ),
    );
  }
  for (const z of [-0.0076, 0.0076]) {
    for (const y of [caseY - caseH / 2 + 0.0009, caseY + caseH / 2 - 0.0009]) {
      parts.push(
        dress(
          ball(0.00105, [p[0], y, p[2] + z], 10, [1.6, 1, 1]),
          GOLD.polished,
          POLISHED_GOLD,
          'propR',
        ),
      );
    }
  }
  parts.push(
    dress(
      tube(
        [
          [p[0], caseY + caseH / 2 - 0.0002, p[2] - 0.0031],
          [p[0], p[1] - 0.0004, p[2] - 0.0022],
          [p[0], p[1] + 0.0002, p[2]],
          [p[0], p[1] - 0.0004, p[2] + 0.0022],
          [p[0], caseY + caseH / 2 - 0.0002, p[2] + 0.0031],
        ],
        0.00045,
        16,
        6,
      ),
      GOLD.brushed,
      BRUSHED_GOLD,
      'propR',
    ),
  );
  parts.push(...trunk(seg));
  return { livery: parts, glass: [] };
}

/** Local mouth of the sommelier's bottle in the `propR` frame: where the pour leaves it. */
export const BOTTLE_MOUTH: Vec3 = [0, 0.011, 0.004];
/** Where the pour lands, in the `fill` frame: a little above the bottom of the bowl. */
export const BOWL_TARGET: Vec3 = [0, 0.0022, 0];
/** Bind length of the pour, metres; it is stretched from the bottle to the bowl. */
export const STREAM_LENGTH = JOINTS.stream[1];
const WINE = '#5E0B20';
const WINE_FINISH: Finish = { rough: 0.08, coat: 1, glow: 0.22 };

function sommelier(seg: number): FigureParts {
  const waistcoat = '#16161C';
  const bordeaux = '#561224';
  const look: Livery = {
    coat: waistcoat,
    coatFinish: WOOL,
    sleeve: IVORY,
    sleeveFinish: COTTON,
    trousers: '#121218',
    shirt: IVORY,
    skin: '#8E5B3C',
    hair: '#1C120C',
    hands: '#8E5B3C',
    handFinish: PORCELAIN,
    shoes: '#08090C',
  };
  const parts = body(look, seg);
  parts.push(
    dress(
      lathe(over(TORSO, 0.0435, 0.0567, 0.00025), seg, { depth: DEPTH, phi: [-0.44, 0.88] }),
      IVORY,
      COTTON,
      torsoBind,
    ),
    dress(
      limb(
        0.00068,
        0.00085,
        [0, 0.0556, frontZ(0.0556, 0, 0.0005)],
        [0, 0.0446, frontZ(0.0446, 0, 0.0005)],
        6,
      ),
      bordeaux,
      SILK,
      torsoBind,
    ),
  );
  for (const at of buttonsAt([0.0368, 0.0405], 0, 0.0005)) {
    parts.push(dress(ball(0.0005, at, 10), GOLD.polished, POLISHED_GOLD, torsoBind));
  }
  for (const side of SIDES) {
    const elbow = JOINTS[bone('elbow', side)];
    parts.push(
      dress(
        limb(0.00268, 0.00262, offset(elbow, [0, -0.0026, 0]), offset(elbow, [0, -0.0048, 0]), seg),
        IVORY,
        COTTON,
        bone('elbow', side),
      ),
    );
  }

  const apron: Profile = [
    [0.0098, 0.0072],
    [0.0095, 0.016],
    [0.0089, 0.0238],
    [0.008, 0.0302],
    [0.0078, 0.0342],
  ];
  const apronBind = (x: number, y: number): Weights => {
    const side: Side = x >= 0 ? 'L' : 'R';
    const toLeg = Math.min(Math.max((0.0275 - y) / 0.008, 0), 1);
    const toShin = Math.min(Math.max((0.0158 - y) / 0.005, 0), 1);
    const weights: [BoneName, number][] = [['pelvis', 1 - toLeg]];
    if (toLeg > 0) weights.push([bone('hip', side), toLeg * (1 - toShin)]);
    if (toLeg * toShin > 0) weights.push([bone('knee', side), toLeg * toShin]);
    return weights.filter(([, w]) => w > 0);
  };
  parts.push(
    dress(lathe(apron, seg, { depth: 0.8, phi: [-1.32, 2.64] }), bordeaux, VELVET, apronBind),
    dress(
      lathe(
        [
          [0.00985, 0.0072],
          [0.0099, 0.0084],
        ],
        seg,
        { depth: 0.8, phi: [-1.32, 2.64] },
      ),
      GOLD.brushed,
      BRUSHED_GOLD,
      apronBind,
    ),
    dress(
      lathe(
        [
          [0.0072, 0.0333],
          [0.0075, 0.0338],
          [0.0075, 0.0344],
          [0.0072, 0.0348],
        ],
        seg,
        { depth: DEPTH + 0.02 },
      ),
      IVORY,
      COTTON,
      torsoBind,
    ),
  );

  const cupY = 0.0452;
  const cupZ = frontZ(cupY, 0, 0.0011);
  parts.push(
    dress(
      lathe(
        [
          [0, 0],
          [0.0021, 0],
          [0.0026, 0.0007],
          [0.0025, 0.001],
          [0.0019, 0.0005],
          [0, 0.0004],
        ],
        seg,
      )
        .rotateX(Math.PI / 2)
        .translate(0, cupY, cupZ),
      GOLD.polished,
      POLISHED_GOLD,
      'chest',
    ),
  );
  for (const side of SIDES) {
    const s = sign(side);
    parts.push(
      dress(
        tube(
          [
            [s * 0.0028, 0.0568, 0.0006],
            [s * 0.0045, 0.0532, frontZ(0.0532, s * 0.0045, 0.0004)],
            [s * 0.0032, 0.0486, frontZ(0.0486, s * 0.0032, 0.0005)],
            [s * 0.0012, 0.0464, cupZ],
          ],
          0.00022,
          16,
          5,
        ),
        GOLD.polished,
        POLISHED_GOLD,
        'chest',
      ),
    );
  }
  parts.push(
    dress(
      ball(0.0029, offset(HEAD_CENTER, [0, 0.0032, -0.0086]), seg, [1, 0.9, 0.85]),
      look.hair,
      LACQUER,
      'head',
    ),
  );

  const b = offset(JOINTS.propR, [0, 0, BOTTLE_MOUTH[2]]);
  parts.push(
    dress(
      lathe(
        [
          [0, -0.0075],
          [0.003, -0.0075],
          [0.0032, -0.0071],
          [0.0032, 0.0034],
          [0.0028, 0.0054],
          [0.0015, 0.0067],
          [0.0011, 0.0073],
          [0.0011, 0.0104],
          [0.00128, 0.0106],
          [0.00128, 0.011],
          [0, 0.011],
        ],
        seg,
        { at: b },
      ),
      '#0F2E1E',
      BOTTLE_GLASS,
      'propR',
    ),
    dress(
      lathe(
        [
          [0.00326, -0.0042],
          [0.00326, 0.0018],
        ],
        seg,
        { at: b, phi: [-1.15, 2.3] },
      ),
      CHAMPAGNE,
      COTTON,
      'propR',
    ),
    dress(
      lathe(
        [
          [0.00128, 0.0074],
          [0.00128, 0.01115],
          [0, 0.01115],
        ],
        seg,
        { at: b },
      ),
      GOLD.polished,
      BRUSHED_GOLD,
      'propR',
    ),
  );

  const g = JOINTS.propL;
  const glassAt = offset(g, [0, 0, JOINTS.fill[2] - g[2]]);
  const glass = [
    dress(
      lathe(
        [
          [0, -0.0022],
          [0.0025, -0.0022],
          [0.0025, -0.0019],
          [0.0005, -0.0016],
          [0.00036, -0.001],
          [0.00036, 0.0024],
          [0.0011, 0.0029],
          [0.0026, 0.0042],
          [0.0033, 0.0062],
          [0.0032, 0.0086],
          [0.0029, 0.0099],
        ],
        seg + 4,
        { at: glassAt },
      ),
      '#FFFFFF',
      {},
      'propL',
    ),
  ];
  const fill = JOINTS.fill;
  parts.push(
    dress(
      lathe(
        [
          [0, 0],
          [0.0009, 0],
          [0.0023, 0.0012],
          [0.003, 0.0032],
          [0.00305, 0.0046],
          [0, 0.0046],
        ],
        seg,
        { at: fill },
      ),
      WINE,
      WINE_FINISH,
      'fill',
    ),
    dress(
      limb(0.00028, 0.00034, JOINTS.stream, offset(JOINTS.stream, [0, -STREAM_LENGTH, 0]), 8),
      WINE,
      WINE_FINISH,
      'stream',
    ),
  );
  parts.push(...trunk(seg));
  return { livery: parts, glass };
}

export function buildFigureParts(role: StaffRole, segments: number): FigureParts {
  switch (role) {
    case 'butler':
      return butler(segments);
    case 'valet':
      return valet(segments);
    case 'sommelier':
      return sommelier(segments);
  }
}

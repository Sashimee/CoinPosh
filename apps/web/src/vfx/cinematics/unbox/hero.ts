import {
  abs,
  atan,
  attribute,
  clamp,
  cos,
  dot,
  float,
  fract,
  length,
  max,
  min,
  mix,
  normalize,
  normalView,
  normalViewGeometry,
  positionView,
  positionViewDirection,
  pow,
  select,
  sign,
  smoothstep,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import {
  BoxGeometry,
  BufferAttribute,
  Color,
  CylinderGeometry,
  Euler,
  ExtrudeGeometry,
  LatheGeometry,
  Matrix4,
  MeshPhysicalNodeMaterial,
  Quaternion,
  Shape,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
  type BufferGeometry,
  type Node,
} from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { coinFaceHeight, EMBOSS_RELIEF_DEPTH } from '../../../scene/coins/emboss.ts';
import { createCoinGeometry, type CoinGeometryOptions } from '../../../scene/coins/geometry.ts';
import { COIN_LOOKS } from '../../../scene/coins/tiers.ts';
import { rivieraTokens } from '../../../scene/venues/riviera/palette.ts';
import { easeOutBack } from '../../easing.ts';

type F = Node<'float'>;
type V3 = Node<'vec3'>;

/** What sits on the pedestal: the headline reward of the roll. */
export type UnboxHero = 'coins' | 'pearls' | 'keys' | 'tickets' | 'charm' | 'safe' | 'card';

export const UNBOX_HEROES: readonly UnboxHero[] = [
  'coins',
  'pearls',
  'keys',
  'tickets',
  'charm',
  'safe',
  'card',
];

/** Half the span of a hero prop in metres: every prop fits a cube twice this wide. */
export const ITEM_SIZE = 0.016;

/**
 * The surface each vertex of a hero prop is shaded as, carried in the `heroPart` attribute so
 * every prop draws with one material and one pipeline.
 */
export const HeroPart = {
  gold: 0,
  enamel: 1,
  coinFace: 2,
  gem: 3,
  pearl: 4,
  ticket: 5,
  lacquer: 6,
} as const;

export type HeroPartId = (typeof HeroPart)[keyof typeof HeroPart];

/** What each hero is built as, for the stage and its tests. */
export interface HeroProp {
  readonly prop:
    | 'collection-coin'
    | 'coin-stack'
    | 'pearl-trio'
    | 'key'
    | 'ticket-pair'
    | 'charm-pendant'
    | 'safe';
  /** True when it stands on the pedestal cap; false when it floats over it. */
  readonly rests: boolean;
}

export const HERO_PROPS: Readonly<Record<UnboxHero, HeroProp>> = {
  card: { prop: 'collection-coin', rests: false },
  coins: { prop: 'coin-stack', rests: true },
  pearls: { prop: 'pearl-trio', rests: true },
  keys: { prop: 'key', rests: false },
  tickets: { prop: 'ticket-pair', rests: false },
  charm: { prop: 'charm-pendant', rests: false },
  safe: { prop: 'safe', rests: true },
};

/** Pedestal spin, in the plan's `itemSpin` radians, the hero's entrance turn takes to settle. */
const SETTLE_SPIN = 2.9;
const settleTurn = easeOutBack(1.4);
/** After it settles, the hero sways this far either side of face-on, slowly. */
const SWAY = 0.42;
const SWAY_RATE = 0.6;
const SWAY_RAMP = 2.6;

/**
 * The pedestal's spin as the hero shows it: one decelerating turn that overshoots face-on a
 * touch and settles, then a slow sway either side, so a coin face or a ticket is never left
 * edge-on to the player. Zero spin (reduced motion) is face-on and still.
 */
export function heroYaw(itemSpin: number): number {
  if (!(itemSpin > 0)) return 0;
  const turn = Math.PI * 2 * (settleTurn(Math.min(1, itemSpin / SETTLE_SPIN)) - 1);
  const sway = Math.max(0, itemSpin - SETTLE_SPIN);
  return turn + SWAY * Math.min(1, sway / SWAY_RAMP) * Math.sin(sway * SWAY_RATE);
}

/** The collection coins wear the gold tier's face: laurel, berries, beads, stars, monogram. */
const FACE_DESIGN = COIN_LOOKS.gold.face;

/** Lighter than the table's near coin: a hero is a few hundred pixels across at most. */
const HERO_COIN: CoinGeometryOptions = {
  segments: 56,
  reeds: 72,
  reedSamples: 2,
  reedDepth: 0.011,
  cornerSteps: 3,
  fieldRings: 2,
  halfThickness: 0.1,
};

const STACK_COIN: CoinGeometryOptions = {
  segments: 40,
  reeds: 48,
  reedSamples: 1,
  reedDepth: 0.014,
  cornerSteps: 2,
  fieldRings: 1,
  halfThickness: 0.11,
};

/**
 * Relief height in metres for a unit of face height: the coin bake's depth on a hero-sized
 * coin, tripled so the laurel still reads when the coin is a hundred pixels across.
 */
const FACE_BUMP = EMBOSS_RELIEF_DEPTH * ITEM_SIZE * 3;

/** Every part carries exactly these, so every hero shares one pipeline with the primer's. */
const HERO_ATTRIBUTES = 'heroPart,normal,position,uv';

/** Builds the merged geometry of one hero prop, centred on its origin, facing +Z. */
export function heroGeometry(hero: UnboxHero): BufferGeometry {
  const s = ITEM_SIZE;
  const parts = buildParts(hero, s);
  for (const part of parts) {
    const names = Object.keys(part.attributes).sort().join(',');
    if (part.index || names !== HERO_ATTRIBUTES)
      throw new Error(
        `Unbox hero ${hero} has a part with attributes ${names}, not ${HERO_ATTRIBUTES}`,
      );
  }
  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  merged.computeBoundingBox();
  const box = merged.boundingBox;
  if (!box) throw new Error(`Unbox hero ${hero} has no bounds`);
  const centre = box.getCenter(new Vector3());
  const lift = HERO_PROPS[hero].rests ? -s - box.min.y : -centre.y;
  merged.translate(-centre.x, lift, -centre.z);
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  merged.name = `unbox-hero-${hero}`;
  return merged;
}

function buildParts(hero: UnboxHero, s: number): BufferGeometry[] {
  switch (hero) {
    case 'card':
      return collectionCoin(s);
    case 'coins':
      return coinStack(s);
    case 'pearls':
      return pearlTrio(s);
    case 'keys':
      return key(s);
    case 'tickets':
      return ticketPair(s);
    case 'charm':
      return charmPendant(s);
    case 'safe':
      return safe(s);
  }
}

const matrix = new Matrix4();
const turn = new Quaternion();
const rotate = new Euler();
const place = new Vector3();
const size = new Vector3();

/** Places `geometry` and tags it as one surface; the result is non-indexed and owns its data. */
function piece(
  geometry: BufferGeometry,
  part: HeroPartId,
  at: readonly [number, number, number] = [0, 0, 0],
  rotation: readonly [number, number, number] = [0, 0, 0],
  scale = 1,
): BufferGeometry {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  if (flat !== geometry) geometry.dispose();
  for (const name of Object.keys(flat.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv' && name !== 'heroPart')
      flat.deleteAttribute(name);
  }
  if (!flat.hasAttribute('uv')) planarUv(flat);
  if (!flat.hasAttribute('heroPart')) {
    const count = flat.getAttribute('position').count;
    flat.setAttribute('heroPart', new BufferAttribute(new Float32Array(count).fill(part), 1));
  }
  rotate.set(rotation[0], rotation[1], rotation[2], 'YXZ');
  matrix.compose(place.set(...at), turn.setFromEuler(rotate), size.setScalar(scale));
  flat.applyMatrix4(matrix);
  return flat;
}

/** UVs from the XY extent, so flat printed props get a 0..1 square over their face. */
function planarUv(geometry: BufferGeometry): void {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) throw new Error('Unbox hero part has no bounds to map its UVs from');
  const position = geometry.getAttribute('position');
  const width = Math.max(box.max.x - box.min.x, 1e-9);
  const height = Math.max(box.max.y - box.min.y, 1e-9);
  const uvs = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i++) {
    uvs[i * 2] = (position.getX(i) - box.min.x) / width;
    uvs[i * 2 + 1] = (position.getY(i) - box.min.y) / height;
  }
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
}

/** A coin whose faces carry the struck design and whose reeded edge is `edge`. */
function coin(options: CoinGeometryOptions, edge: HeroPartId): BufferGeometry {
  const geometry = createCoinGeometry(options);
  const coinPart = geometry.getAttribute('coinPart');
  const parts = new Float32Array(coinPart.count);
  for (let i = 0; i < coinPart.count; i++)
    parts[i] = coinPart.getX(i) > 0.5 ? edge : HeroPart.coinFace;
  geometry.setAttribute('heroPart', new BufferAttribute(parts, 1));
  return geometry;
}

/** One album coin standing on its edge, struck face to the camera. */
function collectionCoin(s: number): BufferGeometry[] {
  return [
    piece(coin(HERO_COIN, HeroPart.gold), HeroPart.coinFace, [0, 0, 0], [Math.PI / 2, 0, 0], s),
  ];
}

/** Four coins stacked a little askew, and a fifth leaning on them face out. */
function coinStack(s: number): BufferGeometry[] {
  const r = s * 0.72;
  const thick = 2 * STACK_COIN.halfThickness * r;
  const jitter: readonly (readonly [number, number, number])[] = [
    [0, 0, 0.0],
    [0.05, -0.04, 0.6],
    [-0.04, 0.03, 1.3],
    [0.03, 0.05, 2.1],
  ];
  const parts = jitter.map(([dx, dz, yaw], i) =>
    piece(
      coin(STACK_COIN, HeroPart.gold),
      HeroPart.coinFace,
      [-s * 0.32 + dx * r, thick * (i + 0.5), -s * 0.12 + dz * r],
      [0, yaw, 0],
      r,
    ),
  );
  parts.push(
    piece(
      coin(STACK_COIN, HeroPart.gold),
      HeroPart.coinFace,
      [s * 0.5, r * 0.98, s * 0.36],
      [Math.PI / 2 - 0.32, -0.35, 0],
      r,
    ),
  );
  return parts;
}

/** Three pearls nested in an enamel dish with a gold rim. */
function pearlTrio(s: number): BufferGeometry[] {
  const pearl = s * 0.44;
  const dishTop = s * 0.2;
  return [
    piece(new CylinderGeometry(s * 1.0, s * 0.62, dishTop, 40, 1), HeroPart.enamel, [
      0,
      dishTop / 2,
      0,
    ]),
    piece(
      new TorusGeometry(s * 1.0, s * 0.07, 10, 48),
      HeroPart.gold,
      [0, dishTop, 0],
      [Math.PI / 2, 0, 0],
    ),
    piece(new SphereGeometry(pearl, 28, 18), HeroPart.pearl, [
      -s * 0.42,
      dishTop + pearl * 0.85,
      s * 0.22,
    ]),
    piece(new SphereGeometry(pearl, 28, 18), HeroPart.pearl, [
      s * 0.42,
      dishTop + pearl * 0.85,
      s * 0.22,
    ]),
    piece(new SphereGeometry(pearl * 1.08, 28, 18), HeroPart.pearl, [
      0,
      dishTop + pearl * 1.2,
      -s * 0.3,
    ]),
  ];
}

/** A gold skeleton key with an enamel inlay in its bow, held on a diagonal. */
function key(s: number): BufferGeometry[] {
  const shaftTop = s * 0.2;
  const shaftBottom = -s * 1.35;
  const shaftLength = shaftTop - shaftBottom;
  const upright: [number, number, number] = [Math.PI / 2, 0, 0];
  const parts = [
    piece(new TorusGeometry(s * 0.46, s * 0.13, 14, 40), HeroPart.gold, [0, s * 0.62, 0]),
    piece(
      new CylinderGeometry(s * 0.34, s * 0.34, s * 0.09, 32),
      HeroPart.enamel,
      [0, s * 0.62, 0],
      upright,
    ),
    piece(new TorusGeometry(s * 0.13, s * 0.06, 8, 20), HeroPart.gold, [0, s * 0.1, 0], upright),
    piece(new CylinderGeometry(s * 0.085, s * 0.085, shaftLength, 16), HeroPart.gold, [
      0,
      (shaftTop + shaftBottom) / 2,
      0,
    ]),
    piece(new BoxGeometry(s * 0.36, s * 0.13, s * 0.12), HeroPart.gold, [
      s * 0.2,
      shaftBottom + s * 0.1,
      0,
    ]),
    piece(new BoxGeometry(s * 0.26, s * 0.12, s * 0.12), HeroPart.gold, [
      s * 0.15,
      shaftBottom + s * 0.36,
      0,
    ]),
    piece(new BoxGeometry(s * 0.1, s * 0.12, s * 0.12), HeroPart.gold, [
      s * 0.3,
      shaftBottom + s * 0.23,
      0,
    ]),
  ];
  for (const part of parts) part.rotateZ(-0.62);
  return parts;
}

/** Two raffle tickets fanned out, each with a stub, notches and a printed frame. */
function ticketPair(s: number): BufferGeometry[] {
  const ticket = (): BufferGeometry => {
    const w = s * 1.9;
    const h = s * 1.0;
    const corner = s * 0.1;
    const notch = s * 0.12;
    const stubX = w * 0.18;
    const shape = new Shape();
    shape.moveTo(-w / 2 + corner, -h / 2);
    shape.lineTo(stubX - notch, -h / 2);
    shape.absarc(stubX, -h / 2, notch, Math.PI, 0, true);
    shape.lineTo(w / 2 - corner, -h / 2);
    shape.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + corner);
    shape.lineTo(w / 2, h / 2 - corner);
    shape.quadraticCurveTo(w / 2, h / 2, w / 2 - corner, h / 2);
    shape.lineTo(stubX + notch, h / 2);
    shape.absarc(stubX, h / 2, notch, 0, Math.PI, true);
    shape.lineTo(-w / 2 + corner, h / 2);
    shape.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - corner);
    shape.lineTo(-w / 2, -h / 2 + corner);
    shape.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + corner, -h / 2);
    const geometry = new ExtrudeGeometry(shape, {
      depth: s * 0.05,
      bevelEnabled: true,
      bevelThickness: s * 0.012,
      bevelSize: s * 0.012,
      bevelSegments: 2,
      curveSegments: 10,
    });
    geometry.translate(0, 0, -s * 0.025);
    geometry.deleteAttribute('uv');
    planarUv(geometry);
    return geometry;
  };
  return [
    piece(ticket(), HeroPart.ticket, [-s * 0.12, s * 0.2, -s * 0.18], [0, 0.05, 0.22]),
    piece(ticket(), HeroPart.ticket, [s * 0.1, -s * 0.15, s * 0.05], [0, -0.08, -0.14]),
  ];
}

/** A brilliant-cut gem in a gold bezel, hung from a bail: the outline of any charm. */
function charmPendant(s: number): BufferGeometry[] {
  const g = s * 0.78;
  const profile = [
    new Vector2(0.0001, -0.92 * g),
    new Vector2(1.0 * g, -0.06 * g),
    new Vector2(1.0 * g, 0.04 * g),
    new Vector2(0.58 * g, 0.38 * g),
    new Vector2(0.0001, 0.38 * g),
  ];
  const gem = new LatheGeometry(profile, 10, Math.PI / 10);
  const facets = gem.toNonIndexed();
  gem.dispose();
  facets.deleteAttribute('normal');
  facets.computeVertexNormals();
  return [
    piece(facets, HeroPart.gem, [0, 0, 0], [Math.PI / 2, 0, 0]),
    piece(new TorusGeometry(g * 1.02, s * 0.075, 10, 48), HeroPart.gold, [0, 0, 0]),
    piece(new TorusGeometry(s * 0.2, s * 0.06, 10, 28), HeroPart.gold, [0, g * 1.02 + s * 0.27, 0]),
    piece(
      new TorusGeometry(s * 0.12, s * 0.05, 8, 20),
      HeroPart.gold,
      [0, g * 1.02 + s * 0.06, 0],
      [0, Math.PI / 2, 0],
    ),
  ];
}

/** A little navy safe: enamel door frame, gold dial, handle, hinges and feet. */
function safe(s: number): BufferGeometry[] {
  const w = s * 1.5;
  const h = s * 1.45;
  const d = s * 1.2;
  const front = d / 2;
  const frame = s * 0.08;
  const door = { w: w * 0.78, h: h * 0.76 };
  const parts = [
    piece(new BoxGeometry(w, h, d, 1, 1, 1), HeroPart.lacquer, [0, h / 2, 0]),
    piece(new BoxGeometry(door.w, door.h, s * 0.05), HeroPart.lacquer, [
      0,
      h / 2,
      front + s * 0.02,
    ]),
    piece(new BoxGeometry(door.w + frame * 2, frame, s * 0.06), HeroPart.enamel, [
      0,
      h / 2 + door.h / 2 + frame / 2,
      front + s * 0.02,
    ]),
    piece(new BoxGeometry(door.w + frame * 2, frame, s * 0.06), HeroPart.enamel, [
      0,
      h / 2 - door.h / 2 - frame / 2,
      front + s * 0.02,
    ]),
    piece(new BoxGeometry(frame, door.h, s * 0.06), HeroPart.enamel, [
      -door.w / 2 - frame / 2,
      h / 2,
      front + s * 0.02,
    ]),
    piece(new BoxGeometry(frame, door.h, s * 0.06), HeroPart.enamel, [
      door.w / 2 + frame / 2,
      h / 2,
      front + s * 0.02,
    ]),
    piece(
      new CylinderGeometry(s * 0.3, s * 0.32, s * 0.1, 36),
      HeroPart.gold,
      [-s * 0.08, h / 2, front + s * 0.09],
      [Math.PI / 2, 0, 0],
    ),
    piece(
      new CylinderGeometry(s * 0.12, s * 0.12, s * 0.08, 20),
      HeroPart.enamel,
      [-s * 0.08, h / 2, front + s * 0.16],
      [Math.PI / 2, 0, 0],
    ),
    piece(new BoxGeometry(s * 0.07, s * 0.38, s * 0.07), HeroPart.gold, [
      s * 0.42,
      h / 2,
      front + s * 0.1,
    ]),
    piece(new CylinderGeometry(s * 0.05, s * 0.05, s * 0.28, 12), HeroPart.gold, [
      -w / 2 + s * 0.04,
      h * 0.78,
      front + s * 0.03,
    ]),
    piece(new CylinderGeometry(s * 0.05, s * 0.05, s * 0.28, 12), HeroPart.gold, [
      -w / 2 + s * 0.04,
      h * 0.22,
      front + s * 0.03,
    ]),
  ];
  for (const [x, z] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const) {
    parts.push(
      piece(new BoxGeometry(s * 0.2, s * 0.1, s * 0.2), HeroPart.gold, [
        x * (w / 2 - s * 0.12),
        -s * 0.05,
        z * (d / 2 - s * 0.12),
      ]),
    );
  }
  return parts;
}

/** The one material every hero prop draws with; `tint` sets the rolled rarity. */
export interface HeroMaterial {
  readonly material: MeshPhysicalNodeMaterial;
  tint(accent: Color): void;
  readonly accent: Color;
}

/**
 * The hero's shading, picked per vertex by `heroPart`: brushed gold, a clearcoated enamel in a
 * deepened rarity colour, a struck coin face (the table coins' procedural relief, its field
 * enamelled in the rarity colour under a guilloche sunburst), a faceted gem, a nacre pearl, a
 * printed ticket with gold foil, and navy lacquer. A rarity-coloured Fresnel rim edges every
 * prop, so even a common's ivory reads against the light shaft. Albedos stay low: the stage's
 * key reaches 5 to 16 irradiance through the reveal, and a pale dielectric under it blew out to
 * the flat white slab this replaced.
 */
export function createHeroMaterial(): HeroMaterial {
  const accent = uniform(new Color());
  const enamel = uniform(new Color());
  const part = attribute('heroPart', 'float');
  const is = (id: HeroPartId): F => float(1).sub(clamp(abs(part.sub(id)).mul(2), 0, 1));
  const gold = is(HeroPart.gold);
  const enamelled = is(HeroPart.enamel);
  const face = is(HeroPart.coinFace);
  const gem = is(HeroPart.gem);
  const pearl = is(HeroPart.pearl);
  const ticket = is(HeroPart.ticket);
  const lacquer = is(HeroPart.lacquer);

  const goldColor = linear(rivieraTokens['gold-brushed']);
  const navy = linear(rivieraTokens['navy-lacquer']);
  const nacre = linear(rivieraTokens.champagne).mul(0.62);
  const paper = linear(rivieraTokens.ivory).mul(0.5);

  const st = uv();
  const p = st.mul(2).sub(1);
  const r = length(p);
  const height = coinFaceHeight(p, FACE_DESIGN).mul(face);
  const relief = smoothstep(0.06, 0.26, height);
  const lip = smoothstep(0.835, 0.865, r);
  const struck = max(relief, lip);
  const rays = cos(atan(p.y, p.x).mul(60))
    .mul(0.5)
    .add(0.5)
    .mul(smoothstep(0.08, 0.22, r));
  const field = enamel
    .mul(FIELD_DEPTH)
    .mul(float(0.6).add(rays.mul(0.4)))
    .mul(mix(float(1), float(0.68), smoothstep(0.3, 0.84, r)));
  const faceColor = mix(field, goldColor, struck);

  const edge = min(min(st.x, float(1).sub(st.x)), min(st.y, float(1).sub(st.y)));
  const border = smoothstep(0.05, 0.062, edge).mul(smoothstep(0.1, 0.088, edge));
  const stub = smoothstep(0.585, 0.595, st.x);
  const perforation = float(1)
    .sub(smoothstep(0.006, 0.014, abs(st.x.sub(0.59))))
    .mul(smoothstep(0.3, 0.18, abs(fract(st.y.mul(11)).sub(0.5))));
  const emblem = length(vec2(st.x.sub(0.3).mul(1.9), st.y.sub(0.5)));
  const seal = smoothstep(0.24, 0.225, emblem).mul(smoothstep(0.17, 0.185, emblem));
  const star = smoothstep(0.1, 0.085, emblem);
  const foil = max(max(border, seal), star);
  const ticketBase = mix(enamel.mul(0.85), paper, stub.mul(0.8)).mul(
    float(1).sub(perforation.mul(0.7)),
  );
  const ticketColor = mix(ticketBase, goldColor, foil);

  const fire = pow(abs(dot(normalViewGeometry, normalize(vec3(0.35, 0.8, 0.45)))), 6);
  const gemColor = enamel.mul(float(0.3).add(fire.mul(1.4)));

  const color = goldColor
    .mul(gold)
    .add(enamel.mul(enamelled))
    .add(faceColor.mul(face))
    .add(gemColor.mul(gem))
    .add(mix(nacre, accent.mul(0.5), 0.12).mul(pearl))
    .add(ticketColor.mul(ticket))
    .add(navy.mul(lacquer));

  const metal = gold.add(face.mul(struck)).add(ticket.mul(foil));
  const roughness = gold
    .mul(0.3)
    .add(enamelled.mul(0.18))
    .add(face.mul(mix(float(0.14), float(0.26), struck)))
    .add(gem.mul(0.05))
    .add(pearl.mul(0.16))
    .add(ticket.mul(mix(float(0.6), float(0.3), foil)))
    .add(lacquer.mul(0.26));
  const coat = enamelled
    .add(face.mul(float(1).sub(struck)))
    .add(gem)
    .add(lacquer)
    .add(ticket.mul(0.4));

  const facing = clamp(dot(normalViewGeometry, positionViewDirection), 0, 1);
  const rim = pow(float(1).sub(facing), 3);
  const glow = enamelled
    .mul(0.1)
    .add(face.mul(float(1).sub(struck)).mul(0.08))
    .add(gem.mul(float(0.18).add(fire.mul(0.5))))
    .add(ticket.mul(float(1).sub(stub)).mul(0.06));
  const emissive = accent.mul(rim.mul(0.55).add(glow));

  const material = new MeshPhysicalNodeMaterial();
  material.name = 'unbox-hero';
  material.colorNode = color;
  material.metalnessNode = clamp(metal, 0, 1);
  material.roughnessNode = clamp(roughness, 0.04, 1);
  material.clearcoatNode = clamp(coat, 0, 1);
  material.clearcoatRoughnessNode = float(0.06);
  material.iridescenceNode = pearl.mul(0.85);
  material.iridescenceIORNode = float(1.45);
  material.iridescenceThicknessNode = float(420);
  material.emissiveNode = emissive;
  material.normalNode = faceNormal(height, face);

  const tint = (color: Color): void => {
    accent.value.copy(color);
    enamel.value.copy(color).multiplyScalar(ENAMEL_DEPTH);
  };
  return { material, tint, accent: accent.value };
}

/** The coin field sits deeper still, so the gold relief reads against it under the rays. */
const FIELD_DEPTH = 0.5;

/** Enamel is the rarity colour deepened, so a pale common still has a body under the key. */
const ENAMEL_DEPTH = 0.42;

/**
 * Bumps the shading normal by the struck face's height, with Mikkelsen's screen-space surface
 * gradient: the relief is evaluated live, so no bake needs a renderer before the first crate.
 */
function faceNormal(height: F, face: F): V3 {
  const dx = positionView.dFdx();
  const dy = positionView.dFdy();
  const n = normalView;
  const r1 = dy.cross(n);
  const r2 = n.cross(dx);
  const det = dot(dx, r1);
  const dh = vec2(height.dFdx(), height.dFdy()).mul(FACE_BUMP);
  const gradient = sign(det).mul(r1.mul(dh.x).add(r2.mul(dh.y)));
  const bumped = normalize(abs(det).mul(n).sub(gradient));
  return select(face.greaterThan(0.5).and(abs(det).greaterThan(1e-14)), bumped, n);
}

function linear(hex: string): V3 {
  const c = new Color(hex);
  return vec3(c.r, c.g, c.b);
}

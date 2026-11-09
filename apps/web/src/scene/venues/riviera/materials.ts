import {
  AdditiveBlending,
  Color,
  DoubleSide,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  type Material,
  type Node,
  type Texture,
} from 'three/webgpu';
import {
  abs,
  float,
  floor,
  fract,
  fwidth,
  hash,
  min,
  mix,
  positionLocal,
  pow,
  saturate,
  smoothstep,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { decodeNoise, NOISE_CHANNELS, sampleNoiseAtlas } from '../../env/noise-texture.ts';
import { RIVIERA_TABLE } from './layout.ts';
import { rivieraTokens, rivieraTones } from './palette.ts';

/** `low` drops the costliest per-pixel layers for weak GPUs; `high` is the full look. */
export type RivieraQuality = 'low' | 'high';

export interface RivieraMaterialOptions {
  /** Baked noise atlas from `createNoiseTexture`; the venue owns and disposes it. */
  readonly noise: Texture;
  readonly quality?: RivieraQuality;
}

/**
 * Projects a local position onto a plane that no axis-aligned face sees edge-on, so one 2D
 * noise lookup gives every face of a box a non-degenerate pattern.
 */
function boxProjection(scale: number): Node<'vec2'> {
  const p = positionLocal.mul(scale);
  return vec2(p.x.add(p.z), p.y.sub(p.z.mul(0.5)));
}

function linear(hex: string): Node<'vec3'> {
  const c = new Color(hex);
  return vec3(c.r, c.g, c.b);
}

interface PlankPattern {
  /** Plank width across X, metres. */
  readonly plankWidth: number;
  /** Board length along Z before a butt joint, metres. */
  readonly boardLength: number;
  /** Width of the stripe between planks (holly inlay or caulk), metres. */
  readonly seamWidth: number;
  readonly seamColor: string;
  readonly buttJoints: boolean;
}

interface WoodSurface {
  readonly color: Node<'vec3'>;
  readonly seam: Node<'float'>;
  readonly grain: Node<'float'>;
}

/**
 * Quarter-sawn teak laid fore-aft along Z in the mesh's local frame. Each board gets its own
 * tone and grain offset from a hash of its plank and board index; seams are anti-aliased with
 * screen-space derivatives so they stay crisp without shimmering at grazing angles.
 */
function teakPlanks(noise: Texture, pattern: PlankPattern): WoodSurface {
  const p = positionLocal;
  const across = p.x.div(pattern.plankWidth).add(0.5);
  const plank = floor(across);
  const along = p.z.div(pattern.boardLength).add(hash(plank.add(4096)).mul(0.83));
  const board = floor(along);
  const id = plank.mul(7.0).add(board.mul(131.0)).add(65536);
  const tone = hash(id);
  const seed = tone.mul(97.0);

  const { fibre, streak: figureNoise } = NOISE_CHANNELS;
  const offset = vec2(hash(seed.add(3)), hash(seed.add(5)));
  const atlas = sampleNoiseAtlas(
    noise,
    vec2(p.x.mul(260 / fibre.cellsX), p.z.mul(4.5 / fibre.cellsY)).add(offset),
  );
  const fine = decodeNoise(atlas, fibre);
  const streak = decodeNoise(atlas, figureNoise);
  const figure = smoothstep(-0.45, 0.75, streak.add(fine.mul(0.3)));
  const grain = saturate(figure.mul(0.62).add(tone.mul(0.3)));
  const lines = mix(float(0.72), float(1), smoothstep(-0.35, 0.35, fine));
  const wood = mix(linear(rivieraTones.teakDark), linear(rivieraTokens.teak), grain)
    .mul(tone.mul(0.22).add(0.86))
    .mul(lines)
    .add(linear(rivieraTones.teakLight).mul(pow(fine.mul(0.5).add(0.5), 6).mul(0.12)));

  const edgeX = min(fract(across), float(1).sub(fract(across))).mul(pattern.plankWidth);
  const halfSeam = pattern.seamWidth * 0.5;
  let seam = float(1).sub(smoothstep(halfSeam, fwidth(edgeX).add(halfSeam), edgeX));
  if (pattern.buttJoints) {
    const edgeZ = min(fract(along), float(1).sub(fract(along))).mul(pattern.boardLength);
    seam = seam.max(float(1).sub(smoothstep(halfSeam, fwidth(edgeZ).add(halfSeam), edgeZ)));
  }
  return { color: mix(wood, linear(pattern.seamColor), seam), seam, grain: fine };
}

/** Navy show-car lacquer: a lightly metallic base under a mirror clearcoat. */
export function createNavyLacquer(noise: Texture): MeshPhysicalNodeMaterial {
  const material = new MeshPhysicalNodeMaterial({
    name: 'riviera/navy-lacquer',
    color: new Color(rivieraTokens['navy-lacquer']),
    metalness: 0.25,
    roughness: 0.34,
    clearcoat: 1,
    clearcoatRoughness: 0.035,
  });
  const flake = decodeNoise(
    sampleNoiseAtlas(noise, boxProjection(1400 / NOISE_CHANNELS.speckle.cellsX)),
    NOISE_CHANNELS.speckle,
  );
  material.roughnessNode = float(0.34).add(flake.mul(0.08));
  return material;
}

/** Teak and holly cabin-sole playfield under varnish, as on a Riviera-built yacht. */
export function createVarnishedTeak(noise: Texture): MeshPhysicalNodeMaterial {
  const material = new MeshPhysicalNodeMaterial({
    name: 'riviera/teak-varnished',
    metalness: 0,
    clearcoat: 0.55,
    clearcoatRoughness: 0.1,
  });
  const wood = teakPlanks(noise, {
    plankWidth: 0.07,
    boardLength: 2.4,
    seamWidth: 0.0022,
    seamColor: rivieraTones.holly,
    buttJoints: false,
  });
  material.colorNode = wood.color.mul(0.74);
  material.roughnessNode = mix(float(0.42).add(wood.grain.mul(0.06)), float(0.5), wood.seam);
  return material;
}

/** Inset of the gold pinstripe from the playfield's side walls and payout edge, metres. */
const PINSTRIPE_INSET = 0.011;
const PINSTRIPE_HALF_WIDTH = 0.0006;

/**
 * Midnight baize for the coin floor: a fine nap, a navy sheen that lifts at grazing angles, a
 * gold pinstripe inlaid just inside the walls and the payout edge, and an occlusion falloff
 * into the walls and the backboard so the floor sits inside the cabinet rather than reading
 * as a uniformly lit slab.
 */
export function createFeltFloor(noise: Texture, quality: RivieraQuality): MeshPhysicalNodeMaterial {
  const sheen = quality === 'high' ? 0.35 : 0.2;
  const material = new MeshPhysicalNodeMaterial({
    name: 'riviera/felt',
    color: new Color(rivieraTones.felt),
    metalness: 0,
    roughness: 0.92,
    specularIntensity: 0.12,
    sheen,
    sheenColor: new Color(rivieraTones.feltSheen),
    sheenRoughness: 0.6,
  });
  const p = positionLocal;
  const { speckle, cloud } = NOISE_CHANNELS;
  const plane = vec2(p.x, p.z);
  const nap = decodeNoise(sampleNoiseAtlas(noise, plane.mul(900 / speckle.cellsX)), speckle);
  const mottle = decodeNoise(sampleNoiseAtlas(noise, plane.mul(7 / cloud.cellsX)), cloud);

  const t = RIVIERA_TABLE;
  const toSide = float(t.fieldHalfWidth).sub(abs(p.x));
  const toFront = float(t.fieldFrontZ).sub(p.z);
  const toBack = p.z.sub(t.backboardFrontZ);
  const occlusion = smoothstep(0, 0.05, toSide)
    .mul(smoothstep(0, 0.09, toBack))
    .mul(0.55)
    .add(0.45);
  const lineDistance = abs(min(toSide, toFront).sub(PINSTRIPE_INSET));
  const stripe = float(1).sub(
    smoothstep(PINSTRIPE_HALF_WIDTH, fwidth(lineDistance).add(PINSTRIPE_HALF_WIDTH), lineDistance),
  );

  const baize = linear(rivieraTones.felt)
    .mul(nap.mul(0.16).add(mottle.mul(0.06)).add(1))
    .mul(occlusion);
  material.colorNode = mix(baize, linear(rivieraTokens['gold-brushed']), stripe);
  material.metalnessNode = stripe;
  material.roughnessNode = mix(float(0.92), float(0.3), stripe);
  material.sheenNode = linear(rivieraTones.feltSheen)
    .mul(sheen)
    .mul(occlusion)
    .mul(float(1).sub(stripe));
  return material;
}

/**
 * Nero Marquina under a mirror clearcoat: near-black stone crossed by thin champagne-gold
 * veins where a domain-warped fractal field crosses zero. Dresses the crest cap and pusher.
 */
export function createBlackMarble(noise: Texture): MeshPhysicalNodeMaterial {
  const material = new MeshPhysicalNodeMaterial({
    name: 'riviera/marble',
    color: new Color(rivieraTones.marble),
    metalness: 0,
    roughness: 0.2,
    clearcoat: 0.7,
    clearcoatRoughness: 0.05,
  });
  const { cloud } = NOISE_CHANNELS;
  const base = boxProjection(1.6 / cloud.cellsX);
  const warp = decodeNoise(sampleNoiseAtlas(noise, base.mul(1.7).add(0.37)), cloud);
  const coord = base.add(vec2(warp, warp.mul(-0.7)).mul(0.22));
  const main = decodeNoise(sampleNoiseAtlas(noise, coord), cloud);
  const fine = decodeNoise(sampleNoiseAtlas(noise, coord.mul(3.1).add(0.71)), cloud);
  const line = (field: Node<'float'>, w: number): Node<'float'> =>
    float(1).sub(smoothstep(float(0), fwidth(field).add(w), abs(field)));
  const vein = line(main, 0.005).add(line(fine, 0.0025).mul(0.3)).min(1);
  const haze = float(1)
    .sub(smoothstep(float(0), float(0.08), abs(main)))
    .mul(0.1);
  const stone = linear(rivieraTones.marble).mul(warp.mul(0.35).add(1));
  material.colorNode = mix(stone, linear(rivieraTones.marbleVein), vein.mul(0.42).add(haze));
  material.roughnessNode = mix(float(0.22), float(0.34), vein);
  return material;
}

/**
 * Oiled teak deck with black-caulked seams and staggered butt joints. The low tier drops the
 * oil's faint clearcoat: the deck covers much of the frame and the second lobe barely shows.
 */
export function createDeckTeak(noise: Texture, quality: RivieraQuality): MeshPhysicalNodeMaterial {
  const material = new MeshPhysicalNodeMaterial({
    name: 'riviera/teak-deck',
    metalness: 0,
    clearcoat: quality === 'high' ? 0.12 : 0,
    clearcoatRoughness: 0.45,
  });
  const wood = teakPlanks(noise, {
    plankWidth: 0.11,
    boardLength: 3.1,
    seamWidth: 0.007,
    seamColor: rivieraTones.caulk,
    buttJoints: true,
  });
  material.colorNode = wood.color.mul(0.38);
  material.roughnessNode = mix(float(0.74).add(wood.grain.mul(0.08)), float(0.9), wood.seam);
  return material;
}

/**
 * Brushed gold for trims. Every gold mesh is swept with U along its length, so the
 * UV-derived tangent frame runs with the brushing and the highlight streaks across it.
 */
export function createBrushedGold(noise: Texture): MeshPhysicalNodeMaterial {
  const material = new MeshPhysicalNodeMaterial({
    name: 'riviera/gold-brushed',
    color: new Color(rivieraTokens['gold-brushed']),
    metalness: 1,
    roughness: 0.3,
    anisotropy: 0.8,
  });
  const { speckle } = NOISE_CHANNELS;
  const brush = decodeNoise(
    sampleNoiseAtlas(noise, vec2(uv().x.mul(6 / speckle.cellsX), uv().y.mul(900 / speckle.cellsY))),
    speckle,
  );
  material.roughnessNode = float(0.27).add(brush.mul(0.07));
  material.colorNode = linear(rivieraTokens['gold-brushed']).mul(brush.mul(0.05).add(0.9));
  return material;
}

/** Mirror-polished gold for beads, finials and the emblem ring. */
export function createPolishedGold(): MeshPhysicalNodeMaterial {
  return new MeshPhysicalNodeMaterial({
    name: 'riviera/gold-polished',
    color: new Color('#E2BE52'),
    metalness: 1,
    roughness: 0.11,
  });
}

/**
 * Navy crushed velvet lining the gutters and the win tray. The sheen is the pile's own navy
 * lifted, not a pale tint: at the grazing angles the gutters are seen from, a bright sheen
 * reads as foil. The crush only nudges the sheen roughness so the pile stays soft.
 */
export function createVelvet(noise: Texture): MeshPhysicalNodeMaterial {
  const sheen = new Color(rivieraTokens['navy-lacquer'])
    .multiplyScalar(2.1)
    .lerp(new Color(rivieraTokens['sea-glass']), 0.06);
  const material = new MeshPhysicalNodeMaterial({
    name: 'riviera/velvet',
    color: new Color(rivieraTones.velvet),
    metalness: 0,
    roughness: 0.95,
    specularIntensity: 0.2,
    sheen: 0.5,
    sheenColor: sheen,
    sheenRoughness: 0.55,
  });
  const crush = decodeNoise(
    sampleNoiseAtlas(noise, boxProjection(38 / NOISE_CHANNELS.cloud.cellsX)),
    NOISE_CHANNELS.cloud,
  );
  material.sheenRoughnessNode = float(0.55).add(crush.mul(0.05));
  return material;
}

/**
 * Thin glass guards drawn as reflection only: the base is black and the blend additive, so
 * the faces add the sunset's Fresnel reflection without greying what is behind them.
 */
export function createGlass(): MeshPhysicalNodeMaterial {
  return new MeshPhysicalNodeMaterial({
    name: 'riviera/glass',
    color: new Color('#000000'),
    metalness: 0,
    roughness: 0.03,
    specularIntensity: 1,
    transparent: true,
    opacity: 0.6,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
  });
}

export function createChrome(): MeshStandardNodeMaterial {
  return new MeshStandardNodeMaterial({
    name: 'riviera/chrome',
    color: new Color(rivieraTones.chrome),
    metalness: 1,
    roughness: 0.07,
  });
}

/** Ivory gelcoat for the yacht's bulwark. */
export function createGelcoat(): MeshPhysicalNodeMaterial {
  return new MeshPhysicalNodeMaterial({
    name: 'riviera/gelcoat',
    color: new Color(rivieraTokens.ivory),
    metalness: 0,
    roughness: 0.38,
    clearcoat: 1,
    clearcoatRoughness: 0.06,
  });
}

export interface RivieraMaterials {
  readonly lacquer: MeshPhysicalNodeMaterial;
  readonly teak: MeshPhysicalNodeMaterial;
  readonly felt: MeshPhysicalNodeMaterial;
  readonly marble: MeshPhysicalNodeMaterial;
  readonly deck: MeshPhysicalNodeMaterial;
  readonly gold: MeshPhysicalNodeMaterial;
  readonly goldPolished: MeshPhysicalNodeMaterial;
  readonly velvet: MeshPhysicalNodeMaterial;
  readonly glass: MeshPhysicalNodeMaterial;
  readonly chrome: MeshStandardNodeMaterial;
  readonly gelcoat: MeshPhysicalNodeMaterial;
}

export function createRivieraMaterials(options: RivieraMaterialOptions): RivieraMaterials {
  const { noise, quality = 'high' } = options;
  return {
    lacquer: createNavyLacquer(noise),
    teak: createVarnishedTeak(noise),
    felt: createFeltFloor(noise, quality),
    marble: createBlackMarble(noise),
    deck: createDeckTeak(noise, quality),
    gold: createBrushedGold(noise),
    goldPolished: createPolishedGold(),
    velvet: createVelvet(noise),
    glass: createGlass(),
    chrome: createChrome(),
    gelcoat: createGelcoat(),
  };
}

export function disposeMaterials(materials: RivieraMaterials): void {
  for (const material of Object.values(materials) as Material[]) material.dispose();
}

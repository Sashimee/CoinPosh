import {
  Color,
  DoubleSide,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  type Material,
  type Node,
} from 'three/webgpu';
import {
  abs,
  dot,
  float,
  floor,
  fract,
  fwidth,
  hash,
  min,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  normalView,
  positionLocal,
  positionViewDirection,
  pow,
  saturate,
  smoothstep,
  uv,
  vec3,
} from 'three/tsl';
import { rivieraTokens, rivieraTones } from './palette.ts';

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
function teakPlanks(pattern: PlankPattern): WoodSurface {
  const p = positionLocal;
  const across = p.x.div(pattern.plankWidth).add(0.5);
  const plank = floor(across);
  const along = p.z.div(pattern.boardLength).add(hash(plank.add(4096)).mul(0.83));
  const board = floor(along);
  const id = plank.mul(7.0).add(board.mul(131.0)).add(65536);
  const tone = hash(id);
  const seed = tone.mul(97.0);

  const fine = mx_noise_float(vec3(p.x.mul(260), p.z.mul(4.5), seed));
  const streak = mx_fractal_noise_float(
    vec3(p.x.mul(38), p.z.mul(1.3), seed.add(11)),
    3,
    2.1,
    0.55,
  );
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
export function createNavyLacquer(): MeshPhysicalNodeMaterial {
  const material = new MeshPhysicalNodeMaterial({
    name: 'riviera/navy-lacquer',
    color: new Color(rivieraTokens['navy-lacquer']),
    metalness: 0.25,
    roughness: 0.34,
    clearcoat: 1,
    clearcoatRoughness: 0.035,
  });
  const flake = mx_noise_float(positionLocal.mul(1400));
  material.roughnessNode = float(0.34).add(flake.mul(0.08));
  return material;
}

/** Teak and holly cabin-sole playfield under varnish, as on a Riviera-built yacht. */
export function createVarnishedTeak(): MeshPhysicalNodeMaterial {
  const material = new MeshPhysicalNodeMaterial({
    name: 'riviera/teak-varnished',
    metalness: 0,
    clearcoat: 0.55,
    clearcoatRoughness: 0.1,
  });
  const wood = teakPlanks({
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

/** Oiled teak deck with black-caulked seams and staggered butt joints. */
export function createDeckTeak(): MeshPhysicalNodeMaterial {
  const material = new MeshPhysicalNodeMaterial({
    name: 'riviera/teak-deck',
    metalness: 0,
    clearcoat: 0.12,
    clearcoatRoughness: 0.45,
  });
  const wood = teakPlanks({
    plankWidth: 0.11,
    boardLength: 3.1,
    seamWidth: 0.007,
    seamColor: rivieraTones.caulk,
    buttJoints: true,
  });
  material.colorNode = wood.color.mul(0.55);
  material.roughnessNode = mix(float(0.74).add(wood.grain.mul(0.08)), float(0.9), wood.seam);
  return material;
}

/**
 * Brushed gold for trims. Every gold mesh is swept with U along its length, so the
 * UV-derived tangent frame runs with the brushing and the highlight streaks across it.
 */
export function createBrushedGold(): MeshPhysicalNodeMaterial {
  const material = new MeshPhysicalNodeMaterial({
    name: 'riviera/gold-brushed',
    color: new Color(rivieraTokens['gold-brushed']),
    metalness: 1,
    roughness: 0.3,
    anisotropy: 0.8,
  });
  const brush = mx_noise_float(vec3(uv().x.mul(6), uv().y.mul(900), 0));
  material.roughnessNode = float(0.27).add(brush.mul(0.07));
  material.colorNode = linear(rivieraTokens['gold-brushed']).mul(brush.mul(0.05).add(1));
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

/** Navy crushed velvet lining the gutters and the win tray. */
export function createVelvet(): MeshPhysicalNodeMaterial {
  const material = new MeshPhysicalNodeMaterial({
    name: 'riviera/velvet',
    color: new Color(rivieraTones.velvet),
    metalness: 0,
    roughness: 0.92,
    sheen: 1,
    sheenColor: new Color(rivieraTokens.champagne).multiplyScalar(0.75),
    sheenRoughness: 0.32,
  });
  const crush = mx_fractal_noise_float(positionLocal.mul(38), 2);
  material.sheenRoughnessNode = float(0.32).add(crush.mul(0.12));
  return material;
}

/** Thin glass guards: opacity follows Fresnel so edges catch the sunset and faces stay clear. */
export function createGlass(): MeshPhysicalNodeMaterial {
  const material = new MeshPhysicalNodeMaterial({
    name: 'riviera/glass',
    color: new Color('#0B1016'),
    metalness: 0,
    roughness: 0.02,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });
  const facing = abs(dot(normalView, positionViewDirection));
  material.opacityNode = float(0.04).add(pow(float(1).sub(facing), 5).mul(0.55));
  return material;
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
  readonly deck: MeshPhysicalNodeMaterial;
  readonly gold: MeshPhysicalNodeMaterial;
  readonly goldPolished: MeshPhysicalNodeMaterial;
  readonly velvet: MeshPhysicalNodeMaterial;
  readonly glass: MeshPhysicalNodeMaterial;
  readonly chrome: MeshStandardNodeMaterial;
  readonly gelcoat: MeshPhysicalNodeMaterial;
}

export function createRivieraMaterials(): RivieraMaterials {
  return {
    lacquer: createNavyLacquer(),
    teak: createVarnishedTeak(),
    deck: createDeckTeak(),
    gold: createBrushedGold(),
    goldPolished: createPolishedGold(),
    velvet: createVelvet(),
    glass: createGlass(),
    chrome: createChrome(),
    gelcoat: createGelcoat(),
  };
}

export function disposeMaterials(materials: RivieraMaterials): void {
  for (const material of Object.values(materials) as Material[]) material.dispose();
}

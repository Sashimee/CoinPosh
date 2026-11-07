import {
  Color,
  DoubleSide,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  type Material,
  type Texture,
} from 'three/webgpu';
import {
  abs,
  dot,
  float,
  mx_fractal_noise_float,
  mx_noise_float,
  normalView,
  positionLocal,
  positionViewDirection,
  pow,
  texture as sampleTexture,
  uv,
  vec3,
} from 'three/tsl';
import { rivieraTokens, rivieraTones } from './palette.ts';
import type { RivieraQuality } from './quality.ts';
import { CABIN_SOLE, DECK_PLANKING, plankUv, type PlankPattern } from './wood.ts';

/**
 * Navy show-car lacquer: a lightly metallic base under a mirror clearcoat. Its environment is
 * set per material (see {@link setLacquerEnvironment}) so the coat reflects the sunset strongly
 * while rough surfaces keep the scene's dimmer ambient. Without a clearcoat the base itself is
 * polished so it still reads as lacquer.
 */
export function createNavyLacquer(quality: RivieraQuality): MeshPhysicalNodeMaterial {
  return new MeshPhysicalNodeMaterial({
    name: 'riviera/navy-lacquer',
    color: new Color(rivieraTokens['navy-lacquer']),
    metalness: 0.2,
    roughness: quality.clearcoat ? 0.3 : 0.16,
    clearcoat: quality.clearcoat ? 1 : 0,
    clearcoatRoughness: 0.03,
  });
}

/** Gives a material its own, stronger view of the venue environment. */
export function setMaterialEnvironment(
  material: MeshPhysicalNodeMaterial,
  environment: Texture,
  rotationY: number,
  intensity: number,
): void {
  material.envMap = environment;
  material.envMapIntensity = intensity;
  material.envMapRotation.set(0, rotationY, 0);
  material.needsUpdate = true;
}

function plankMaterial(
  pattern: PlankPattern,
  map: Texture,
  clearcoat: number,
  clearcoatRoughness: number,
  quality: RivieraQuality,
): MeshPhysicalNodeMaterial {
  const material = new MeshPhysicalNodeMaterial({
    name: pattern.name,
    metalness: 0,
    clearcoat: quality.clearcoat ? clearcoat : 0,
    clearcoatRoughness,
  });
  const texel = sampleTexture(map, plankUv(pattern));
  material.colorNode = texel.rgb;
  material.roughnessNode = texel.a;
  return material;
}

/** Teak and holly cabin-sole playfield under varnish, as on a Riviera-built yacht. */
export function createVarnishedTeak(
  map: Texture,
  quality: RivieraQuality,
): MeshPhysicalNodeMaterial {
  return plankMaterial(CABIN_SOLE, map, 0.55, 0.1, quality);
}

/** Oiled teak deck with black-caulked seams and staggered butt joints. */
export function createDeckTeak(map: Texture, quality: RivieraQuality): MeshPhysicalNodeMaterial {
  return plankMaterial(DECK_PLANKING, map, 0.12, 0.45, quality);
}

/**
 * Brushed gold for trims. Every gold mesh is swept with U along its length, so the
 * UV-derived tangent frame runs with the brushing and the highlight streaks across it.
 */
export function createBrushedGold(quality: RivieraQuality): MeshPhysicalNodeMaterial {
  const material = new MeshPhysicalNodeMaterial({
    name: 'riviera/gold-brushed',
    color: new Color(rivieraTokens['gold-brushed']),
    metalness: 1,
    roughness: quality.anisotropy ? 0.3 : 0.24,
    anisotropy: quality.anisotropy ? 0.8 : 0,
  });
  const brush = mx_noise_float(vec3(uv().x.mul(6), uv().y.mul(900), 0));
  material.roughnessNode = float(quality.anisotropy ? 0.27 : 0.22).add(brush.mul(0.07));
  material.colorNode = vec3(...new Color(rivieraTokens['gold-brushed']).toArray()).mul(
    brush.mul(0.05).add(1),
  );
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
export function createVelvet(quality: RivieraQuality): MeshPhysicalNodeMaterial {
  const material = new MeshPhysicalNodeMaterial({
    name: 'riviera/velvet',
    color: new Color(rivieraTones.velvet),
    metalness: 0,
    roughness: 0.92,
    sheen: quality.sheen ? 1 : 0,
    sheenColor: new Color(rivieraTokens.champagne).multiplyScalar(0.75),
    sheenRoughness: 0.32,
  });
  if (quality.sheen) {
    const crush = mx_fractal_noise_float(positionLocal.mul(38), 2);
    material.sheenRoughnessNode = float(0.32).add(crush.mul(0.12));
  }
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
export function createGelcoat(quality: RivieraQuality): MeshPhysicalNodeMaterial {
  return new MeshPhysicalNodeMaterial({
    name: 'riviera/gelcoat',
    color: new Color(rivieraTokens.ivory),
    metalness: 0,
    roughness: 0.38,
    clearcoat: quality.clearcoat ? 1 : 0,
    clearcoatRoughness: 0.06,
  });
}

export interface RivieraTextures {
  /** Baked {@link CABIN_SOLE} tile. */
  readonly sole: Texture;
  /** Baked {@link DECK_PLANKING} tile. */
  readonly deck: Texture;
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

export function createRivieraMaterials(
  textures: RivieraTextures,
  quality: RivieraQuality,
): RivieraMaterials {
  return {
    lacquer: createNavyLacquer(quality),
    teak: createVarnishedTeak(textures.sole, quality),
    deck: createDeckTeak(textures.deck, quality),
    gold: createBrushedGold(quality),
    goldPolished: createPolishedGold(),
    velvet: createVelvet(quality),
    glass: createGlass(),
    chrome: createChrome(),
    gelcoat: createGelcoat(quality),
  };
}

export function disposeMaterials(materials: RivieraMaterials): void {
  for (const material of Object.values(materials) as Material[]) material.dispose();
}

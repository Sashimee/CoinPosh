import {
  abs,
  atan,
  attribute,
  clamp,
  dot,
  exp,
  float,
  floor,
  fract,
  hash,
  max,
  mix,
  mx_noise_float,
  normalView,
  positionLocal,
  positionViewDirection,
  pow,
  sin,
  smoothstep,
  step,
  uniform,
  uv,
  vec2,
} from 'three/tsl';
import {
  Color,
  FrontSide,
  MeshPhysicalNodeMaterial,
  type Node,
  type UniformNode,
} from 'three/webgpu';
import type { QualityTier } from '../quality/tiers.ts';
import { PATTERNS } from './shapes.ts';

type F = Node<'float'>;
type V3 = Node<'vec3'>;

/**
 * The numbers one prize animates on the GPU. Each view owns a set and its own material
 * instances; the node graphs are identical across views, so every prize of a quality tier
 * shares the same four shader programs whatever its family or rarity.
 */
export interface PrizeUniforms {
  /** Position of the highlight sweeping across the prize, -1..1 over its length; parked off. */
  readonly glint: UniformNode<'float'>;
  /** One over the prize's longest half-extent, so the sweep crosses any family in step. */
  readonly span: UniformNode<'float'>;
  /** Whole-prize accent flash, 0 at rest: the reduced-motion glint. */
  readonly flash: UniformNode<'float'>;
  readonly accent: UniformNode<'color'>;
}

export const GLINT_PARKED = -4;

export function createPrizeUniforms(accent: string, halfExtent: number): PrizeUniforms {
  return {
    glint: uniform(GLINT_PARKED),
    span: uniform(1 / Math.max(halfExtent, 1e-4)),
    flash: uniform(0),
    accent: uniform(new Color(accent)),
  };
}

export interface PrizeMaterials {
  readonly metal: MeshPhysicalNodeMaterial;
  readonly glass: MeshPhysicalNodeMaterial;
  readonly scent: MeshPhysicalNodeMaterial;
  readonly leather: MeshPhysicalNodeMaterial;
}

function fresnel(): F {
  return float(1).sub(abs(dot(normalView, positionViewDirection)));
}

function glintBand(u: PrizeUniforms): F {
  const p = positionLocal.mul(u.span);
  const along = p.z.mul(-0.8).add(p.x.mul(0.45)).add(p.y.mul(0.4));
  const d = along.sub(u.glint).div(0.16);
  return exp(d.mul(d).negate());
}

function patternIs(pattern: F, id: number): F {
  return step(abs(pattern.sub(id)), float(0.5));
}

/**
 * Metal and enamel in one program, chosen per vertex by `paint`: brushed steel streaks its
 * highlight around a turned case (anisotropy along the lathe's U) with fine brushing lines in
 * the roughness, polished trims stay mirror-smooth, and enamel and dials sit under a lacquer
 * clearcoat. Dials take a sunburst guilloché, cufflink faces and fob badges a clous de Paris
 * grid, both cut into colour and roughness from the part's UVs.
 */
function createMetal(quality: QualityTier, u: PrizeUniforms): MeshPhysicalNodeMaterial {
  const material = new MeshPhysicalNodeMaterial({
    name: 'prize/metal',
    roughness: 0.3,
    clearcoat: quality === 'low' ? 0 : 1,
    clearcoatRoughness: 0.035,
  });
  const color = attribute<'vec3'>('color', 'vec3');
  const finish = attribute<'vec4'>('finish', 'vec4');
  const pattern = attribute<'float'>('pattern', 'float');
  const metal = finish.x;
  const brush = finish.z;
  const coord = uv();

  const lines = hash(floor(coord.y.mul(1600)).add(23));
  const fine = hash(floor(coord.y.mul(5400)).add(71));
  const brushing = lines.mul(0.09).add(fine.mul(0.04)).mul(brush);

  const centred = coord.sub(0.5);
  const angle = atan(centred.y, centred.x);
  const rays = sin(angle.mul(120)).mul(0.5).add(0.5);
  const sunburst = patternIs(pattern, PATTERNS.sunburst);
  const cell = abs(fract(coord.mul(14)).sub(0.5));
  const pyramid = max(cell.x, cell.y).mul(2);
  const clous = patternIs(pattern, PATTERNS.clous);
  const facetLight = smoothstep(0.55, 1, pyramid);

  const tone = float(1)
    .add(rays.sub(0.5).mul(0.16).mul(sunburst))
    .add(facetLight.sub(0.3).mul(0.22).mul(clous))
    .sub(lines.mul(0.05).mul(brush));
  material.colorNode = color.mul(tone);
  material.metalnessNode = metal;
  material.specularIntensityNode = mix(float(0.3), float(1), metal);
  material.roughnessNode = clamp(
    finish.y.add(brushing).add(rays.mul(0.12).mul(sunburst)).add(facetLight.mul(0.18).mul(clous)),
    0.03,
    1,
  );
  if (quality !== 'low') {
    material.clearcoatNode = finish.w;
    material.anisotropyNode = vec2(brush.mul(0.7), 0);
  }
  material.emissiveNode = color
    .mul(glintBand(u).mul(metal.mul(1.6).add(finish.w.mul(0.5))))
    .add(u.accent.mul(u.flash.mul(0.45)));
  return material;
}

/**
 * Sapphire (marked by `brush`) and cut glass, the flacon's lower IOR keeping its broad faces
 * clear rather than silvered by the sky. The high tier refracts the scene through it
 * (transmission); below, it is drawn as reflection alone, thin where it faces the eye and
 * silvered at grazing angles, which reads the same at table distance for a fraction of the cost.
 */
function createGlass(quality: QualityTier, u: PrizeUniforms): MeshPhysicalNodeMaterial {
  const color = attribute<'vec3'>('color', 'vec3');
  const sapphire = attribute<'vec4'>('finish', 'vec4').z;
  const ior = mix(float(1.5), float(1.77), sapphire);
  const specular = mix(float(0.6), float(1), sapphire);
  const f = fresnel();
  const glint = glintBand(u);
  if (quality === 'high') {
    const material = new MeshPhysicalNodeMaterial({
      name: 'prize/glass',
      metalness: 0,
      roughness: 0.02,
      transmission: 1,
      thickness: 0.002,
      ior: 1.77,
      specularIntensity: 1,
      side: FrontSide,
    });
    material.colorNode = color;
    material.iorNode = ior;
    material.specularIntensityNode = specular;
    material.emissiveNode = color.mul(glint.mul(0.35)).add(u.accent.mul(u.flash.mul(0.15)));
    return material;
  }
  const material = new MeshPhysicalNodeMaterial({
    name: 'prize/glass',
    metalness: 0,
    roughness: 0.03,
    specularIntensity: 1,
    ior: 1.77,
    transparent: true,
    depthWrite: false,
    side: FrontSide,
  });
  material.colorNode = color.mul(0.1);
  material.iorNode = ior;
  material.specularIntensityNode = specular;
  material.opacityNode = mix(float(0.12), float(0.7), pow(f, 2.5));
  material.emissiveNode = color.mul(glint.mul(0.35)).add(u.accent.mul(u.flash.mul(0.15)));
  return material;
}

/**
 * The scent: opaque so the high tier's transmission pass sees it through the glass; tinted,
 * softly self-lit at the rim as if the sunset shone through the flacon.
 */
function createScent(u: PrizeUniforms): MeshPhysicalNodeMaterial {
  const material = new MeshPhysicalNodeMaterial({
    name: 'prize/scent',
    metalness: 0,
    roughness: 0.06,
  });
  const color = attribute<'vec3'>('color', 'vec3');
  const f = fresnel();
  material.colorNode = color.mul(0.22);
  material.emissiveNode = color
    .mul(float(0.03).add(pow(float(1).sub(f), 3).mul(0.55)))
    .add(color.mul(glintBand(u).mul(0.3)))
    .add(u.accent.mul(u.flash.mul(0.4)));
  return material;
}

/**
 * Leather and velvet: pebbled grain from a fine noise in the roughness and tone, a sheen in
 * the material's own hue (strong where `brush` marks velvet pile), and stitching thread,
 * flagged by `coat`, broken into stitches along the thread's length.
 */
function createLeather(quality: QualityTier, u: PrizeUniforms): MeshPhysicalNodeMaterial {
  const material = new MeshPhysicalNodeMaterial({
    name: 'prize/leather',
    metalness: 0,
    roughness: 0.6,
    specularIntensity: 0.45,
    sheen: quality === 'low' ? 0 : 1,
    sheenRoughness: 0.5,
  });
  const color = attribute<'vec3'>('color', 'vec3');
  const finish = attribute<'vec4'>('finish', 'vec4');
  const velvet = finish.z;
  const thread = finish.w;
  const grain = mx_noise_float(positionLocal.mul(2600)).mul(0.5).add(0.5);
  const pebble = smoothstep(0.35, 0.75, grain).mul(float(1).sub(velvet)).mul(float(1).sub(thread));
  const stitch = smoothstep(0.15, 0.3, fract(uv().x.mul(60)))
    .mul(smoothstep(0.85, 0.7, fract(uv().x.mul(60))))
    .mul(thread);
  const stitchShade = mix(float(1), stitch.mul(0.85).add(0.15), thread);
  const tone = float(1).sub(pebble.mul(0.18)).mul(stitchShade);
  const base: V3 = color.mul(tone);
  material.colorNode = base;
  material.roughnessNode = clamp(finish.y.add(pebble.mul(0.16)), 0.2, 1);
  if (quality !== 'low') {
    material.sheenNode = color.mul(velvet.mul(1.6).add(0.35)).add(0.04);
    material.sheenRoughnessNode = mix(float(0.55), float(0.32), velvet);
  }
  material.emissiveNode = color.mul(glintBand(u).mul(0.18)).add(u.accent.mul(u.flash.mul(0.2)));
  return material;
}

/** One prize's materials, in their own instances over the kit-wide shader programs. */
export function createPrizeMaterials(quality: QualityTier, u: PrizeUniforms): PrizeMaterials {
  return {
    metal: createMetal(quality, u),
    glass: createGlass(quality, u),
    scent: createScent(u),
    leather: createLeather(quality, u),
  };
}

export function disposePrizeMaterials(materials: PrizeMaterials): void {
  materials.metal.dispose();
  materials.glass.dispose();
  materials.scent.dispose();
  materials.leather.dispose();
}

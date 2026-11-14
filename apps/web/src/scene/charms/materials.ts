import {
  abs,
  atan,
  attribute,
  clamp,
  cos,
  dot,
  exp,
  float,
  floor,
  fract,
  hash,
  length,
  mix,
  normalView,
  positionLocal,
  positionViewDirection,
  pow,
  sin,
  smoothstep,
  uniform,
  uv,
  vec3,
} from 'three/tsl';
import {
  Color,
  DoubleSide,
  FrontSide,
  MeshPhysicalNodeMaterial,
  type Node,
  type UniformNode,
} from 'three/webgpu';

type F = Node<'float'>;
type V3 = Node<'vec3'>;

/** `low` drops clearcoat, sheen and anisotropy for weak GPUs; `high` is the full look. */
export type CharmQuality = 'low' | 'high';

/**
 * The few numbers a charm animates on the GPU. One set per view; every material of the view
 * reads it, so the CPU writes a handful of floats per frame and never touches a buffer.
 */
export interface CharmUniforms {
  /** Activation light response, 0 at rest; trims flagged `glow` emit `accent` times this. */
  readonly flash: UniformNode<'float'>;
  readonly accent: UniformNode<'color'>;
  /** Height (metres, along a diagonal) of the highlight sweeping up the gold; parked far off. */
  readonly glint: UniformNode<'float'>;
  /** Brightness of jewels and visors painted with `lamp`. */
  readonly lamp: UniformNode<'float'>;
  /** Peak sideways sway of tall metal parts (the struck-peg ring), metres 25 mm up a peg. */
  readonly quiver: UniformNode<'float'>;
  readonly quiverPhase: UniformNode<'float'>;
  /** Angle (radians) of the light chasing round `lamp` bulbs, and how much it modulates them. */
  readonly chase: UniformNode<'float'>;
  readonly chaseAmount: UniformNode<'float'>;
}

export const GLINT_PARKED = -1;

export function createCharmUniforms(accent: string): CharmUniforms {
  return {
    flash: uniform(0),
    accent: uniform(new Color(accent)),
    glint: uniform(GLINT_PARKED),
    lamp: uniform(1),
    quiver: uniform(0),
    quiverPhase: uniform(0),
    chase: uniform(0),
    chaseAmount: uniform(0),
  };
}

export const CHARM_GOLD = {
  brushed: '#CC9A35',
  polished: '#E2BE52',
  rose: '#E8B48A',
} as const;

/**
 * Bends geometry above `fromY` sideways like a struck tuning fork, more the higher it is.
 * Applied to every material of a view so parts that share a peg sway together.
 */
export function quiverDeform(u: CharmUniforms, fromY: number): V3 {
  const p = positionLocal;
  const lift = clamp(p.y.sub(fromY), 0, 1).mul(40);
  const bend = lift.mul(lift).mul(u.quiver);
  const phase = u.quiverPhase.add(p.x.mul(240)).add(p.z.mul(170));
  return p.add(vec3(sin(phase).mul(bend), 0, sin(phase.mul(1.31).add(1.7)).mul(bend.mul(0.6))));
}

function glintBand(u: CharmUniforms): F {
  const p = positionLocal;
  const along = p.y.add(p.x.mul(0.45)).add(p.z.mul(0.25));
  const d = along.sub(u.glint).div(0.0045);
  return exp(d.mul(d).negate());
}

function fresnel(): F {
  return float(1).sub(abs(dot(normalView, positionViewDirection)));
}

export interface MaterialOptions {
  readonly quality: CharmQuality;
  readonly uniforms: CharmUniforms;
  readonly deform?: V3 | undefined;
}

function shaped(material: MeshPhysicalNodeMaterial, deform: V3 | undefined) {
  if (deform) material.positionNode = deform;
  return material;
}

/**
 * Brushed gold turned on a lathe: the anisotropic highlight streaks around each part along U,
 * fine brushing lines vary the roughness along V, and a narrow glint sweeps across it now and
 * then. Answers the activation flash with the accent colour.
 */
export function createBrushedGold(options: MaterialOptions): MeshPhysicalNodeMaterial {
  const { quality, uniforms: u } = options;
  const material = new MeshPhysicalNodeMaterial({
    name: 'charm/gold-brushed',
    color: new Color(CHARM_GOLD.brushed),
    metalness: 1,
    roughness: 0.3,
    anisotropy: quality === 'high' ? 0.6 : 0,
    // Lathe UVs run U around the part; the highlight of a turned part streaks along its axis.
    anisotropyRotation: Math.PI / 2,
  });
  const lines = hash(floor(uv().y.mul(1400)).add(17));
  const fine = hash(floor(uv().y.mul(5200)).add(91));
  const gold = new Color(CHARM_GOLD.brushed);
  material.roughnessNode = float(0.24).add(lines.mul(0.07)).add(fine.mul(0.03));
  material.colorNode = vec3(gold.r, gold.g, gold.b).mul(lines.mul(0.06).add(0.92));
  material.emissiveNode = vec3(gold.r, gold.g, gold.b)
    .mul(glintBand(u).mul(1.4))
    .add(u.accent.mul(u.flash).mul(0.3));
  return shaped(material, options.deform);
}

/**
 * Lacquer, enamel and polished metal in one program, chosen per vertex by `paint`: lacquer
 * keeps a mirror clearcoat, metal drops it so gold reads as solid gold rather than coated
 * brass. Trims flagged `glow` flash in the accent colour, `lamp` parts glow in their own.
 */
export function createPainted(options: MaterialOptions): MeshPhysicalNodeMaterial {
  const { quality, uniforms: u } = options;
  const material = new MeshPhysicalNodeMaterial({
    name: 'charm/painted',
    metalness: 0,
    roughness: 0.3,
    clearcoat: quality === 'high' ? 1 : 0,
    clearcoatRoughness: 0.04,
  });
  const color = attribute<'vec3'>('color', 'vec3');
  const finish = attribute<'vec4'>('finish', 'vec4');
  const metal = finish.x;
  material.colorNode = color;
  material.metalnessNode = metal;
  material.roughnessNode = finish.y;
  if (quality === 'high') material.clearcoatNode = float(1).sub(metal);
  const around = atan(positionLocal.z, positionLocal.x);
  const wave = pow(cos(around.mul(3).sub(u.chase)).mul(0.5).add(0.5), 4)
    .mul(0.8)
    .add(0.2);
  const lamp = finish.w.mul(u.lamp).mul(mix(float(1), wave, u.chaseAmount));
  material.emissiveNode = color
    .mul(lamp)
    .add(u.accent.mul(u.flash.mul(finish.z)))
    .add(color.mul(glintBand(u).mul(metal).mul(1.2)));
  return shaped(material, options.deform);
}

export type VelvetWeave = 'plain' | 'cord' | 'net' | 'bristle';

/**
 * Velvet and silk: a sheen in the pile's own hue, lifted at grazing angles. `cord` twists a
 * rope's strands along the tube, `net` lays a gold mesh over a bulb, `bristle` streaks a
 * brush so its spin reads.
 */
export function createVelvet(
  options: MaterialOptions & { readonly weave: VelvetWeave },
): MeshPhysicalNodeMaterial {
  const { quality, uniforms: u, weave } = options;
  const sheen = quality === 'high' ? 1 : 0;
  const material = new MeshPhysicalNodeMaterial({
    name: `charm/velvet-${weave}`,
    metalness: 0,
    roughness: 0.9,
    specularIntensity: 0.25,
    sheen,
    sheenRoughness: 0.45,
  });
  const color = attribute<'vec3'>('color', 'vec3');
  const finish = attribute<'vec4'>('finish', 'vec4');
  const coord = uv();
  let shade: F = float(1);
  let gilt: F = float(0);
  if (weave === 'cord') {
    const strand = fract(coord.y.mul(3).add(coord.x.mul(46)));
    const groove = smoothstep(0, 0.22, strand).mul(smoothstep(1, 0.78, strand));
    shade = groove.mul(0.55).add(0.45);
  } else if (weave === 'net') {
    const a = fract(coord.x.mul(14).add(coord.y.mul(7)));
    const b = fract(coord.x.mul(14).sub(coord.y.mul(7)));
    const line = smoothstep(0.41, 0.47, abs(a.sub(0.5))).max(
      smoothstep(0.41, 0.47, abs(b.sub(0.5))),
    );
    gilt = line.mul(smoothstep(0.08, 0.2, coord.y)).mul(smoothstep(0.98, 0.85, coord.y));
  } else if (weave === 'bristle') {
    const tuft = hash(floor(coord.x.mul(180)));
    shade = tuft.mul(0.7).add(0.3);
  }
  const gold = new Color(CHARM_GOLD.polished);
  const pile = color.mul(shade);
  material.colorNode = mix(pile, vec3(gold.r, gold.g, gold.b), gilt);
  material.metalnessNode = gilt;
  material.roughnessNode = mix(float(0.9), float(0.25), gilt);
  if (sheen > 0) {
    material.sheenNode = pile.mul(1.6).add(0.015).mul(float(1).sub(gilt));
  }
  material.emissiveNode = u.accent.mul(u.flash.mul(finish.z).mul(0.6));
  return shaped(material, options.deform);
}

/**
 * Guilloché enamel for the cufflink faces: a sunburst engine-turned under deep translucent
 * colour, darkest at the centre where the enamel pools, under a glass-hard clearcoat.
 */
export function createEnamel(
  options: MaterialOptions & { readonly deep: string; readonly bright: string },
): MeshPhysicalNodeMaterial {
  const { quality, uniforms: u } = options;
  const material = new MeshPhysicalNodeMaterial({
    name: 'charm/enamel',
    metalness: 0,
    roughness: 0.18,
    clearcoat: quality === 'high' ? 1 : 0,
    clearcoatRoughness: 0.02,
  });
  const d = uv().sub(0.5);
  const r = length(d).mul(2);
  const a = atan(d.y, d.x);
  const ray = sin(a.mul(40).add(sin(r.mul(26)).mul(0.9)))
    .mul(0.5)
    .add(0.5);
  const ring = sin(r.mul(70)).mul(0.5).add(0.5);
  const engraving = pow(ray, 3).mul(0.7).add(ring.mul(0.15));
  const deep = new Color(options.deep);
  const bright = new Color(options.bright);
  const tone = clamp(engraving.mul(0.6).add(r.mul(0.5)), 0, 1);
  material.colorNode = mix(vec3(deep.r, deep.g, deep.b), vec3(bright.r, bright.g, bright.b), tone);
  material.emissiveNode = u.accent.mul(u.flash.mul(0.6).mul(engraving.add(0.3)));
  return shaped(material, options.deform);
}

/**
 * Cut crystal drawn mostly as reflection: thin where it faces the eye and silvered at the
 * edges by Fresnel, so the tinted scent inside reads through it without a transmission pass.
 */
export function createCrystal(options: MaterialOptions): MeshPhysicalNodeMaterial {
  const { uniforms: u } = options;
  const material = new MeshPhysicalNodeMaterial({
    name: 'charm/crystal',
    color: new Color('#26242E'),
    metalness: 0,
    roughness: 0.03,
    specularIntensity: 1,
    ior: 1.6,
    transparent: true,
    depthWrite: false,
    side: FrontSide,
  });
  const f = fresnel();
  material.opacityNode = mix(float(0.14), float(0.85), pow(f, 2.2));
  material.emissiveNode = u.accent.mul(u.flash.mul(0.25).mul(f));
  return shaped(material, options.deform);
}

/** The scent inside the bottle: tinted, softly self-lit as if the sunset shone through it. */
export function createScent(
  options: MaterialOptions & { readonly tint: string },
): MeshPhysicalNodeMaterial {
  const { uniforms: u } = options;
  const tint = new Color(options.tint);
  const material = new MeshPhysicalNodeMaterial({
    name: 'charm/scent',
    color: tint,
    metalness: 0,
    roughness: 0.12,
    transparent: true,
    opacity: 0.8,
    side: DoubleSide,
  });
  const f = fresnel();
  const rgb = vec3(tint.r, tint.g, tint.b);
  material.emissiveNode = rgb
    .mul(float(0.08).add(pow(f, 1.5).mul(0.55)))
    .mul(u.lamp)
    .add(u.accent.mul(u.flash.mul(0.8)));
  return shaped(material, options.deform);
}

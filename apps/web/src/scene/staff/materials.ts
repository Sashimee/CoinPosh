import {
  abs,
  attribute,
  dot,
  exp,
  float,
  luminance,
  max,
  min,
  mix,
  normalView,
  output,
  positionLocal,
  positionViewDirection,
  pow,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import {
  Color,
  FrontSide,
  MeshPhysicalNodeMaterial,
  type Node,
  type UniformNode,
} from 'three/webgpu';
import type { QualityTier } from '../quality/tiers.ts';
import { rivieraTones } from '../venues/riviera/palette.ts';

type F = Node<'float'>;
type V3 = Node<'vec3'>;

/** Scene-linear luminance where a highlight starts to roll off: just under every tier's bloom threshold. */
const HIGHLIGHT_KNEE = 0.85;
const HIGHLIGHT_CEILING = 2;

/**
 * The few numbers a figure animates on the GPU, one set per figure: the CPU writes a handful
 * of floats a frame and never touches a buffer.
 */
export interface StaffUniforms {
  /** 0 at work, 1 on leave: the livery greys and the rim light dims. */
  readonly leave: UniformNode<'float'>;
  /** Height (metres, along a diagonal) of the highlight sweeping up the gold; parked far off. */
  readonly glint: UniformNode<'float'>;
  readonly rim: UniformNode<'color'>;
  readonly rimStrength: UniformNode<'float'>;
}

export const GLINT_PARKED = -1;

export function createStaffUniforms(): StaffUniforms {
  return {
    leave: uniform(0),
    glint: uniform(GLINT_PARKED),
    rim: uniform(new Color(rivieraTones.rimWarm)),
    rimStrength: uniform(0.42),
  };
}

function fresnel(): F {
  return float(1).sub(abs(dot(normalView, positionViewDirection)));
}

// The figures are a few centimetres tall, so a cuff, a clasp or the cloche's dome lined up with
// the key light is a handful of pixels running to 10+; the bloom spreads those over the whole
// frame. Above the knee the luminance eases towards a ceiling and the colour keeps its hue.
function compressHighlight(color: V3): V3 {
  const span = HIGHLIGHT_CEILING - HIGHLIGHT_KNEE;
  const lum = luminance(color);
  const over = max(lum.sub(HIGHLIGHT_KNEE), 0);
  const eased = min(lum, HIGHLIGHT_KNEE).add(
    float(1)
      .sub(exp(over.div(-span)))
      .mul(span),
  );
  return color.mul(eased.div(max(lum, 1e-4)));
}

function withRolledHighlights(material: MeshPhysicalNodeMaterial): void {
  material.outputNode = vec4(compressHighlight(output.rgb), output.a);
}

function glintBand(u: StaffUniforms): F {
  const p = positionLocal;
  const along = p.y.add(p.x.mul(0.4)).add(p.z.mul(0.3));
  const d = along.sub(u.glint).div(0.006);
  return exp(d.mul(d).negate());
}

/**
 * Every opaque part of a figure in one program, chosen per vertex by `dress`: wool and velvet
 * take a sheen in their own hue, lacquer and porcelain a clearcoat, gold its anisotropic
 * streak. A warm rim picks the silhouette out of the dark table, and on leave the livery
 * fades towards grey while the gold keeps a little of its colour.
 */
export function createStaffMaterial(quality: QualityTier, u: StaffUniforms) {
  const rich = quality !== 'low';
  const material = new MeshPhysicalNodeMaterial({
    name: 'staff/livery',
    metalness: 0,
    roughness: 0.5,
    clearcoat: rich ? 1 : 0,
    clearcoatRoughness: 0.06,
    sheen: rich ? 1 : 0,
    sheenRoughness: 0.5,
    anisotropy: quality === 'high' ? 1 : 0,
  });
  const color = attribute<'vec3'>('color', 'vec3');
  const finish = attribute<'vec4'>('finish', 'vec4');
  const trim = attribute<'vec3'>('trim', 'vec3');
  const metal = finish.x;
  const luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  const grey = vec3(luma, luma, luma).mul(0.82);
  const faded = mix(color, grey, u.leave.mul(mix(float(0.62), float(0.3), metal)));
  material.colorNode = faded;
  material.metalnessNode = metal;
  material.roughnessNode = finish.y;
  if (rich) {
    material.clearcoatNode = finish.z;
    material.sheenNode = faded.mul(finish.w.mul(1.7)).add(finish.w.mul(0.012));
    material.sheenRoughnessNode = trim.z;
  }
  // Lathe UVs run U around a part, so the streak of a turned gold part runs along its axis.
  if (quality === 'high') material.anisotropyNode = vec2(0, trim.x);
  const rim = pow(fresnel(), 3)
    .mul(u.rimStrength)
    .mul(float(1).sub(metal))
    .mul(float(1).sub(u.leave.mul(0.55)));
  material.emissiveNode = u.rim
    .mul(rim)
    .add(faded.mul(trim.y))
    .add(color.mul(glintBand(u).mul(metal).mul(1.5)));
  withRolledHighlights(material);
  return material;
}

/**
 * The sommelier's glass, drawn mostly as reflection: clear where it faces the eye and silvered
 * at the edges by Fresnel, so the wine reads through it without a transmission pass.
 */
export function createStaffGlass(u: StaffUniforms) {
  const material = new MeshPhysicalNodeMaterial({
    name: 'staff/glass',
    color: new Color('#2A2830'),
    metalness: 0,
    roughness: 0.04,
    specularIntensity: 1,
    ior: 1.5,
    transparent: true,
    depthWrite: false,
    side: FrontSide,
  });
  const f = fresnel();
  material.opacityNode = mix(float(0.12), float(0.8), pow(f, 2.4));
  material.emissiveNode = u.rim.mul(pow(f, 3).mul(u.rimStrength).mul(0.6));
  withRolledHighlights(material);
  return material;
}

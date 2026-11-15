import type { CollectibleCoinVariant } from '@coinposh/shared';
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
  fwidth,
  hash,
  inverseSqrt,
  length,
  luminance,
  max,
  min,
  mix,
  mod,
  normalize,
  normalView,
  normalViewGeometry,
  output,
  positionView,
  positionViewDirection,
  pow,
  select,
  sign,
  sin,
  smoothstep,
  sqrt,
  texture,
  time,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
  vertexStage,
} from 'three/tsl';
import {
  Color,
  MeshPhysicalNodeMaterial,
  type Node,
  type Texture,
  type UniformNode,
} from 'three/webgpu';
import { NEAR_COIN_GEOMETRY } from '../geometry.ts';
import { flatEmbossTexture, HIGHLIGHT_KNEE } from '../materials.ts';
import type { CoinLook } from '../tiers.ts';
import { VARIANT_LOOKS } from './looks.ts';

type F = Node<'float'>;
type V2 = Node<'vec2'>;
type V3 = Node<'vec3'>;

const TAU = Math.PI * 2;
const REED_SLOPE = (NEAR_COIN_GEOMETRY.reedDepth * NEAR_COIN_GEOMETRY.reeds) / 2;
/** Where the privy star of a first strike sits on the face, in face units (-1..1, +y up). */
export const STAR_MARK_CENTRE = [0.5, -0.36] as const;

/**
 * The tier's look as uniforms, so every tier of one variant shares a single shader program:
 * a variant appears on any tier at random, and a program per tier and variant would link
 * twenty-four 37 KB programs where four do.
 */
export interface VariantTierUniforms {
  readonly metal: UniformNode<'color'>;
  readonly recess: UniformNode<'color'>;
  readonly roughness: UniformNode<'float'>;
  readonly reliefRoughness: UniformNode<'float'>;
  readonly edgeRoughness: UniformNode<'float'>;
  readonly anisotropy: UniformNode<'float'>;
  readonly turningRings: UniformNode<'float'>;
  readonly clearcoat: UniformNode<'float'>;
  readonly clearcoatRoughness: UniformNode<'float'>;
  readonly iridescence: UniformNode<'float'>;
  readonly sparkle: UniformNode<'float'>;
  readonly prismatic: UniformNode<'float'>;
  readonly highlightCeiling: UniformNode<'float'>;
}

export interface VariantCoinMaterial {
  readonly variant: CollectibleCoinVariant;
  readonly material: MeshPhysicalNodeMaterial;
  readonly uniforms: VariantTierUniforms;
  setLook(look: CoinLook): void;
  setEmboss(texture: Texture): void;
}

function createTierUniforms(): VariantTierUniforms {
  return {
    metal: uniform(new Color()),
    recess: uniform(new Color()),
    roughness: uniform(0),
    reliefRoughness: uniform(0),
    edgeRoughness: uniform(0),
    anisotropy: uniform(0),
    turningRings: uniform(0),
    clearcoat: uniform(0),
    clearcoatRoughness: uniform(0),
    iridescence: uniform(0),
    sparkle: uniform(0),
    prismatic: uniform(0),
    highlightCeiling: uniform(1),
  };
}

function writeLook(u: VariantTierUniforms, look: CoinLook): void {
  u.metal.value.set(look.metal);
  u.recess.value.set(look.recess);
  u.roughness.value = look.roughness;
  u.reliefRoughness.value = look.reliefRoughness;
  u.edgeRoughness.value = look.edgeRoughness;
  u.anisotropy.value = look.anisotropy;
  u.turningRings.value = look.turningRings;
  u.clearcoat.value = look.clearcoat;
  u.clearcoatRoughness.value = look.clearcoatRoughness;
  u.iridescence.value = look.iridescence;
  u.sparkle.value = look.sparkle;
  u.prismatic.value = look.prismatic ? 1 : 0;
  u.highlightCeiling.value = look.highlightCeiling;
}

function linear(hex: string): V3 {
  const c = new Color(hex);
  return vec3(c.r, c.g, c.b);
}

function cotangentFrame(n: V3, st: V2): { t: V3; b: V3 } {
  const q0 = positionView.dFdx();
  const q1 = positionView.dFdy();
  const st0 = st.dFdx();
  const st1 = st.dFdy();
  const q1perp = q1.cross(n);
  const q0perp = n.cross(q0);
  const t = q1perp.mul(st0.x).add(q0perp.mul(st1.x));
  const b = q1perp.mul(st0.y).add(q0perp.mul(st1.y));
  const det = max(dot(t, t), dot(b, b));
  const scale = select(det.equal(0), float(0), inverseSqrt(det));
  return { t: t.mul(scale), b: b.mul(scale) };
}

// The same roll-off as the base coins (materials.ts), with the ceiling a uniform.
function compressHighlight(color: V3, ceiling: F): V3 {
  const span = ceiling.sub(HIGHLIGHT_KNEE);
  const lum = luminance(color);
  const over = max(lum.sub(HIGHLIGHT_KNEE), 0);
  const eased = min(lum, HIGHLIGHT_KNEE).add(
    float(1)
      .sub(exp(over.div(span.negate())))
      .mul(span),
  );
  return color.mul(eased.div(max(lum, 1e-4)));
}

// Inigo Quilez's regular star, the GPU twin of the badge glyph's star in glyphs.ts.
function starDistance(p: V2, r: number, n: number, m: number): F {
  const an = Math.PI / n;
  const en = Math.PI / m;
  const acs = vec2(Math.cos(an), Math.sin(an));
  const ecs = vec2(Math.cos(en), Math.sin(en));
  const bn = mod(atan(p.x, p.y), 2 * an).sub(an);
  const q0 = vec2(cos(bn), abs(sin(bn)))
    .mul(length(p))
    .sub(acs.mul(r));
  const k = clamp(dot(q0, ecs).negate(), 0, (r * Math.sin(an)) / Math.sin(en));
  const q = q0.add(ecs.mul(k));
  return length(q).mul(sign(q.x));
}

function rainbow(hue: F): V3 {
  return cos(
    vec3(hue, hue, hue)
      .add(vec3(0, 0.33, 0.67))
      .mul(TAU),
  )
    .mul(0.5)
    .add(0.5);
}

/**
 * A coin variant on top of the tier look of materials.ts: proof is a black-mirror field under a
 * frosted relief, foil a holographic thin film, first strike a crisp, freshly polished strike
 * with a privy star, and misprint the whole design struck off-centre along a direction hashed
 * from the coin's seed. A mint glint sweeps the face while the instance's `variantGlint.x`
 * runs from -1 to 1; `variantGlint.y` flashes the whole coin (the reduced-motion glint).
 */
export function createVariantCoinMaterial(
  variant: CollectibleCoinVariant,
  motion: F,
): VariantCoinMaterial {
  const vl = VARIANT_LOOKS[variant];
  const u = createTierUniforms();
  const raw = uv();
  const part = attribute('coinPart', 'float');
  const face = float(1).sub(part);
  const seed = vertexStage(hash(attribute('coinSeed', 'float')));
  const glint = attribute<'vec2'>('variantGlint', 'vec2');

  let st: V2 = raw;
  if (vl.strikeOffset > 0) {
    const angle = seed.mul(TAU);
    const shift = vec2(cos(angle), sin(angle)).mul(vl.strikeOffset / 2);
    st = raw.add(shift.mul(face));
  }
  const embossNode = texture(flatEmbossTexture(), st);

  const p = st.mul(2).sub(1);
  const r = length(p);
  const rawR = length(raw.mul(2).sub(1));
  const height = embossNode.z.mul(face);
  const cavity = mix(float(1), embossNode.w, face);
  const relief = smoothstep(0.12, 0.42, height);
  const lip = smoothstep(0.855, 0.88, rawR).mul(face);

  let slope: V2 = embossNode.xy.mul(2).sub(1).mul(face);
  const reedCoord = raw.x.mul(NEAR_COIN_GEOMETRY.reeds);
  const reedResolved = float(1).sub(smoothstep(0.25, 0.5, fwidth(reedCoord)));
  slope = slope.add(
    vec2(
      sin(reedCoord.mul(TAU))
        .mul(REED_SLOPE * (vl.edgeCrispness < 1 ? 1.35 : 1))
        .mul(reedResolved)
        .mul(part),
      0,
    ),
  );

  const scale = mix(vec2(150, 150), vec2(120, 14), part);
  const cells = raw.mul(scale);
  const cell = floor(cells);
  const id = cell.x.add(cell.y.mul(4099));
  const spin = hash(id.add(7919)).mul(TAU);
  const within = smoothstep(0.46, 0.18, length(fract(cells).sub(0.5)));
  const footprint = max(fwidth(cells.x), fwidth(cells.y));
  const flakeResolved = float(1).sub(smoothstep(0.15, 0.35, footprint));
  const flake = smoothstep(0.955, 0.965, hash(id))
    .mul(within)
    .mul(flakeResolved)
    .mul(u.sparkle.mul(0.7));
  slope = slope.add(vec2(cos(spin), sin(spin)).mul(flake));

  let star: F = float(0);
  let starRim: F = float(0);
  if (vl.starMark > 0) {
    const local = raw
      .mul(2)
      .sub(1)
      .sub(vec2(...STAR_MARK_CENTRE));
    const d = starDistance(local, vl.starMark, 5, 2.6);
    const aa = max(fwidth(d), 1e-4);
    star = smoothstep(aa, aa.negate(), d).mul(face);
    starRim = smoothstep(aa.mul(2).add(0.02), float(0), abs(d)).mul(face);
    const bevel = normalize(local.add(1e-4)).mul(starRim.mul(0.35));
    slope = slope.add(bevel);
  }

  const pixelFootprint = mix(fwidth(rawR), fwidth(raw.x).mul(TAU), part);
  const farLook = smoothstep(0.085, 0.17, pixelFootprint);
  const detail = float(1).sub(farLook);
  slope = slope.mul(detail);

  const nz = sqrt(clamp(float(1).sub(dot(slope, slope)), 0.02, 1));
  const geometric = normalView;
  const frame = cotangentFrame(geometric, raw);
  const normalNode = normalize(
    frame.t.mul(slope.x).add(frame.b.mul(slope.y)).add(geometric.mul(nz)),
  );

  const ringCoord = r.mul(560);
  const rings = hash(floor(ringCoord).add(31)).sub(0.5).mul(2);
  const ringsResolved = clamp(float(1.4).sub(fwidth(ringCoord).mul(1.2)), 0, 1);
  const mirrorField = vl.fieldRoughness !== null ? 1 : 0;
  const turning = rings
    .mul(u.turningRings.mul(1 - mirrorField))
    .mul(ringsResolved)
    .mul(face)
    .mul(float(1).sub(relief))
    .mul(float(1).sub(lip));

  const minified = smoothstep(0.02, 0.1, fwidth(rawR));
  const fieldRoughness = vl.fieldRoughness === null ? u.roughness : float(vl.fieldRoughness);
  const reliefRoughness =
    vl.reliefRoughness === null ? u.reliefRoughness : float(vl.reliefRoughness);
  const lipRoughness = u.roughness.mul(0.6 * vl.edgeCrispness);
  const faceRoughness = mix(mix(fieldRoughness, reliefRoughness, relief), lipRoughness, lip);
  const roughness = clamp(
    mix(faceRoughness, u.edgeRoughness.mul(vl.edgeCrispness), part)
      .add(turning)
      .add(minified.mul(0.14))
      .add(farLook.mul(0.06))
      .mul(float(1).sub(star.mul(0.8))),
    0.02,
    1,
  );

  const lathe = vec2(p.y.negate(), p.x).div(max(r, 1e-4));
  const fieldAnisotropy = 1 - mirrorField;
  const faceAnisotropy = lathe
    .mul(u.anisotropy)
    .mul(smoothstep(0.04, 0.2, r))
    .mul(float(1).sub(relief).mul(fieldAnisotropy))
    .mul(mix(float(1), float(1.25), lip))
    .mul(float(1).sub(minified.mul(0.6)));
  const edgeAnisotropy = vec2(1, 0).mul(min(u.anisotropy, 0.6));
  const anisotropy = mix(faceAnisotropy, edgeAnisotropy, part).mul(detail);

  const facing = clamp(dot(normalViewGeometry, positionViewDirection), 0, 1);
  const sweep = atan(p.y, p.x).div(TAU);
  const flow = mix(
    sweep.add(r.mul(0.55)).add(height.mul(0.3)),
    raw.x.mul(3).add(raw.y.mul(0.6)),
    part,
  );
  const prismHue = flow.add(time.mul(motion).mul(0.06)).add(facing.mul(0.4)).add(seed);
  const prism = rainbow(prismHue);
  let metal: V3 = mix(u.metal, pow(prism, vec3(1.5, 1.5, 1.5)), u.prismatic.mul(0.72));
  let emissive: V3 = prism
    .mul(float(0.035).add(pow(float(1).sub(facing), 3).mul(0.16)))
    .mul(u.prismatic);

  if (vl.holo > 0) {
    const holoHue = sweep
      .mul(2)
      .add(r.mul(1.3))
      .add(facing.mul(1.6))
      .add(time.mul(motion).mul(0.05))
      .add(seed);
    const holo = rainbow(holoHue);
    const tint = mix(vec3(1, 1, 1), holo.mul(1.55).add(0.2), detail.mul(0.6).add(0.4));
    metal = mix(metal, metal.mul(tint), vl.holo);
    emissive = emissive.add(holo.mul(pow(float(1).sub(facing), 2.5).mul(0.06 * vl.holo)));
  }

  const jitter = float(1).add(seed.sub(0.5).mul(0.07));
  const recessMix = float(1)
    .sub(cavity)
    .mul(0.8)
    .add(abs(seed.sub(0.5)).mul(0.08).mul(face));
  let albedo: V3 = mix(metal, u.recess, clamp(recessMix, 0, 1))
    .mul(jitter)
    .mul(mix(0.5, 1, cavity));
  if (vl.frost > 0) {
    const frosted = mix(albedo, vec3(luminance(albedo)).mul(1.08).add(albedo.mul(0.2)), vl.frost);
    albedo = mix(albedo, frosted, relief.mul(face));
  }
  if (vl.starMark > 0) {
    albedo = mix(albedo, u.recess, starRim.mul(float(1).sub(star)).mul(0.7));
    albedo = mix(albedo, metal.mul(1.12), star);
  }

  const accent = linear(vl.accent);
  const along = p.x.add(p.y).mul(Math.SQRT1_2);
  const sweepAt = mix(float(-1.7), float(1.7), glint.x.mul(0.5).add(0.5));
  const bandOffset = along.sub(sweepAt).div(0.2);
  const running = smoothstep(-1, -0.98, glint.x).mul(smoothstep(1, 0.98, glint.x));
  const band = exp(bandOffset.mul(bandOffset).negate()).mul(running).mul(face.mul(0.8).add(0.2));
  emissive = emissive
    .add(mix(vec3(1, 0.96, 0.86), accent, 0.35).mul(band.mul(2.4)))
    .add(accent.mul(glint.y.mul(0.9)));

  const material = new MeshPhysicalNodeMaterial();
  material.name = `coin-variant-${variant}`;
  material.colorNode = albedo;
  material.metalnessNode = float(1);
  material.roughnessNode = roughness;
  material.normalNode = normalNode;
  material.anisotropyNode = anisotropy;
  material.aoNode = cavity;
  material.clearcoatNode = u.clearcoat.mul(mix(float(1), float(0.6), part));
  material.clearcoatRoughnessNode = u.clearcoatRoughness;
  const film = vl.film > 0 ? max(u.iridescence, float(vl.film)) : u.iridescence;
  material.iridescenceNode = film;
  material.iridescenceIORNode = float(vl.film > 0 ? 1.9 : 1.75);
  material.iridescenceThicknessNode =
    vl.film > 0
      ? mix(
          float(260),
          float(820),
          sin(
            r
              .mul(9)
              .add(sweep.mul(TAU * 3))
              .add(seed.mul(TAU)),
          )
            .mul(0.5)
            .add(0.5)
            .mul(detail.mul(0.7).add(0.3)),
        )
      : mix(
          float(320),
          float(680),
          sin(height.mul(4).add(r.mul(5)).add(seed.mul(TAU)))
            .mul(0.5)
            .add(0.5),
        );
  material.emissiveNode = emissive;
  material.outputNode = vec4(compressHighlight(output.rgb, u.highlightCeiling), output.a);

  return {
    variant,
    material,
    uniforms: u,
    setLook(look) {
      writeLook(u, look);
    },
    setEmboss(next) {
      embossNode.value = next;
    },
  };
}

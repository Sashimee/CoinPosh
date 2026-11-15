import {
  abs,
  attribute,
  clamp,
  dot,
  exp,
  float,
  floor,
  fract,
  fwidth,
  hash,
  length,
  max,
  min,
  mix,
  normalView,
  positionLocal,
  positionViewDirection,
  pow,
  saturate,
  smoothstep,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import {
  AdditiveBlending,
  Color,
  MeshPhysicalNodeMaterial,
  SpriteNodeMaterial,
  type Node,
} from 'three/webgpu';
import { BossPart, type BossPartId } from './geometry.ts';
import { BOSS_GOLD, BOSS_LENS_GLINT, BOSS_PAPER, BOSS_RIM, type BossLook } from './palette.ts';

type F = Node<'float'>;
type V3 = Node<'vec3'>;

/**
 * Most the lens streak takes of the glint, so a shock's flash reads as a sparkle on the glass
 * and the bloom never swallows the face behind it; the gold rim still takes the full flash.
 */
const LENS_GLINT_CAP = 1.4;

/** `low` drops the velvet sheen, the brushed anisotropy and the pinstripe a weak GPU feels. */
export type BossQuality = 'low' | 'high';

function linear(hex: string): V3 {
  const c = new Color(hex);
  return vec3(c.r, c.g, c.b);
}

function mask(part: F, id: BossPartId): F {
  return float(1).sub(clamp(abs(part.sub(id)).mul(2), 0, 1));
}

export interface FigureMaterial {
  readonly material: MeshPhysicalNodeMaterial;
  /** Lens and gold flash, a multiple of the resting glint. */
  readonly glint: { value: number };
  /** Where the flash's streak crosses the lenses, -1 to 1. */
  readonly sweep: { value: number };
  /** 0 to 1: the backlight flares the rim in the figure's halo colour. */
  readonly halo: { value: number };
}

/**
 * Every surface of one figure, picked per vertex by `bossPart`: suit cloth with a velvet sheen
 * (and a pinstripe that fades out before it can shimmer), satin lapels, starched ivory shirt,
 * clearcoated porcelain with a warm glow where it faces the eye, lacquered hat, brushed gold
 * with anisotropy, dark spectacle glass that flashes a streak of sun, navy leather and
 * champagne pages. The sunset sits behind the figures, so every surface carries a warm Fresnel
 * rim, which the halo floods with the figure's own colour when a cascade lands.
 */
export function createFigureMaterial(look: BossLook, quality: BossQuality): FigureMaterial {
  const high = quality === 'high';
  const glint = uniform(0);
  const sweep = uniform(-1);
  const halo = uniform(0);
  const part = attribute('bossPart', 'float');
  const is = (id: BossPartId): F => mask(part, id);
  const cloth = is(BossPart.cloth);
  const satin = is(BossPart.satin);
  const shirt = is(BossPart.shirt);
  const porcelain = is(BossPart.porcelain);
  const hair = is(BossPart.hair);
  const lacquer = is(BossPart.lacquer);
  const gold = is(BossPart.gold);
  const lens = is(BossPart.lens);
  const leather = is(BossPart.leather);
  const paper = is(BossPart.paper);

  const st = uv();
  const weave = hash(floor(positionLocal.mul(9000)).dot(vec3(1, 57, 113)));
  const stripeCoord = st.x.mul(96);
  const stripeWidth = fwidth(stripeCoord);
  const stripe = float(1)
    .sub(smoothstep(0.035, float(0.035).add(stripeWidth), abs(fract(stripeCoord).sub(0.5))))
    .mul(float(1).sub(smoothstep(0.12, 0.3, stripeWidth)))
    .mul(look.pinstripe);
  const streak = hash(floor(st.y.mul(900)).add(floor(st.x.mul(4)).mul(7919)));
  const ruled = smoothstep(0.42, 0.5, abs(fract(st.y.mul(28)).sub(0.5)));

  const facing = saturate(dot(normalView, positionViewDirection));
  const rim = pow(float(1).sub(facing), 3);

  const lensUv = st.mul(2).sub(1);
  const lensStreak = exp(abs(lensUv.x.add(lensUv.y).mul(0.7071).sub(sweep)).mul(-9));
  const lensSpot = pow(saturate(float(1).sub(length(lensUv.sub(vec2(-0.35, 0.35))).mul(2.2))), 3);

  const clothColor = linear(look.cloth)
    .mul(float(0.9).add(weave.mul(0.12)))
    .add(linear(BOSS_PAPER).mul(high ? stripe.mul(0.09) : float(0)));
  const color = clothColor
    .mul(cloth)
    .add(linear(look.satin).mul(satin))
    .add(linear(look.shirt).mul(0.72).mul(shirt))
    .add(linear(look.porcelain).mul(0.7).mul(porcelain))
    .add(linear(look.hair).mul(hair))
    .add(linear(look.hat).mul(lacquer))
    .add(
      linear(BOSS_GOLD)
        .mul(float(0.9).add(streak.mul(0.1)))
        .mul(gold),
    )
    .add(vec3(0.006, 0.008, 0.012).mul(lens))
    .add(linear(look.leather).mul(leather))
    .add(
      linear(BOSS_PAPER)
        .mul(float(0.8).sub(ruled.mul(0.25)))
        .mul(paper),
    );

  const material = new MeshPhysicalNodeMaterial();
  material.name = 'boss/figure';
  material.colorNode = color;
  material.metalnessNode = gold.add(lacquer.mul(0.05));
  material.roughnessNode = clamp(
    cloth
      .mul(0.86)
      .add(satin.mul(0.34))
      .add(shirt.mul(0.62))
      .add(porcelain.mul(0.3))
      .add(hair.mul(0.5))
      .add(lacquer.mul(0.26))
      .add(gold.mul(float(0.2).add(streak.mul(0.08))))
      .add(lens.mul(0.3))
      .add(leather.mul(0.42))
      .add(paper.mul(0.75)),
    0.04,
    1,
  );
  material.clearcoatNode = clamp(
    porcelain.add(lacquer).add(lens).add(leather.mul(0.6)).add(satin.mul(0.25)),
    0,
    1,
  );
  material.clearcoatRoughnessNode = float(0.04).add(porcelain.mul(0.06));
  material.specularIntensityNode = float(1).sub(cloth.mul(0.55));
  if (high) {
    material.anisotropyNode = vec2(gold.mul(0.75).add(hair.mul(0.4)), 0);
    material.sheenNode = linear(look.clothSheen)
      .mul(0.75)
      .mul(cloth)
      .add(linear(look.shirt).mul(0.12).mul(shirt))
      .add(linear(look.satin).mul(0.6).mul(satin));
    material.sheenRoughnessNode = float(0.45);
  }

  const haloColor = linear(look.halo);
  const rimColor = mix(linear(BOSS_RIM), haloColor, saturate(halo.mul(1.4)));
  const rimLevel = float(0.16)
    .add(halo.mul(0.6))
    .mul(float(1).sub(lens))
    .mul(float(1).sub(gold.mul(0.5)));
  const glow = linear(look.porcelain).mul(pow(facing, 2).mul(0.05)).mul(porcelain);
  const lensLight = linear(BOSS_LENS_GLINT)
    .mul(lensSpot.mul(0.12).add(lensStreak.mul(min(glint, LENS_GLINT_CAP)).mul(1.2)))
    .mul(lens);
  const goldFlash = linear(BOSS_GOLD).mul(rim.mul(glint).mul(0.6)).mul(gold);
  material.emissiveNode = rimColor.mul(rim.mul(rimLevel)).add(glow).add(lensLight).add(goldFlash);

  return { material, glint, sweep, halo };
}

export interface HaloMaterial {
  readonly material: SpriteNodeMaterial;
  readonly intensity: { value: number };
}

/**
 * The backlight behind a figure: one additive billboard of soft light in the figure's colour,
 * a hotter core low behind the shoulders and a wide falloff, so a big cascade lights the figure
 * from behind like a stage spot. One draw, no particles.
 */
export function createHaloMaterial(color: string): HaloMaterial {
  const intensity = uniform(0);
  const p = uv().mul(2).sub(1);
  const r = length(p.mul(vec2(0.85, 1)));
  const soft = pow(saturate(float(1).sub(r)), 2.2);
  const core = pow(saturate(float(1).sub(length(p.sub(vec2(0, -0.2))).mul(1.8))), 3);
  const rgb = linear(color)
    .mul(soft.mul(0.55).add(core.mul(0.9)))
    .mul(intensity);
  const material = new SpriteNodeMaterial({
    name: 'boss/halo',
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  material.colorNode = vec4(max(min(rgb, vec3(4)), vec3(0)), 1);
  return { material, intensity };
}

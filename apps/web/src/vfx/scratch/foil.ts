import {
  abs,
  clamp,
  cos,
  exp,
  float,
  fract,
  instanceIndex,
  length,
  max,
  min,
  mix,
  mx_noise_float,
  pow,
  sin,
  smoothstep,
  step,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import {
  CustomBlending,
  DoubleSide,
  MaxEquation,
  MeshBasicNodeMaterial,
  NormalBlending,
  OneFactor,
  Vector2,
  type Texture,
  type UniformNode,
} from 'three/webgpu';
import { CELL_GAP, CELL_PAD, CELL_SIZE } from './mask.ts';

/**
 * The brush the finger drags across the mask: a soft disc whose rim is torn by noise, so the
 * foil's edge reads ragged rather than drawn with a compass. Max blending keeps every pixel at
 * the most it has ever been scratched, however many stamps overlap.
 */
export function createBrushMaterial(): MeshBasicNodeMaterial {
  const d = uv().mul(2).sub(1);
  const seed = float(instanceIndex).mul(1.618);
  const tear = mx_noise_float(vec3(d.mul(2.6), seed)).mul(0.22);
  const grain = mx_noise_float(vec3(d.mul(11), seed.add(7))).mul(0.06);
  const r = length(d).add(tear).add(grain);
  const scratched = float(1).sub(smoothstep(0.6, 1, r));
  const material = new MeshBasicNodeMaterial();
  material.colorNode = vec4(vec3(scratched), scratched);
  material.blending = CustomBlending;
  material.blendEquation = MaxEquation;
  material.blendEquationAlpha = MaxEquation;
  material.blendSrc = OneFactor;
  material.blendDst = OneFactor;
  material.blendSrcAlpha = OneFactor;
  material.blendDstAlpha = OneFactor;
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = DoubleSide;
  material.fog = false;
  return material;
}

export interface FoilUniforms {
  readonly time: UniformNode<'float'>;
  /** The finger over the window, in plane uv (y up); far away when there is none. */
  readonly pointer: UniformNode<'vec2'>;
  /** 0..1: how far the noise dissolve has eaten the remaining foil. */
  readonly clear: UniformNode<'float'>;
  /** 0..1: the plain fade the reduced-motion card uses instead. */
  readonly fade: UniformNode<'float'>;
}

export function createFoilUniforms(): FoilUniforms {
  return {
    time: uniform(0),
    pointer: uniform(new Vector2(-10, -10)),
    clear: uniform(0),
    fade: uniform(0),
  };
}

const TAU = Math.PI * 2;

/**
 * The silver foil over the window: brushed lines, a thin-film shimmer that drifts with the
 * light and the finger, a diamond lattice, an embossed ring over every gem, and a glint that
 * sweeps the card now and then. Where the mask says scratched, the foil is gone, with a bright
 * curled lip around every hole; `clear` dissolves what is left from noise outward, its front
 * burning gold.
 */
export function createFoilMaterial(mask: Texture, uniforms: FoilUniforms): MeshBasicNodeMaterial {
  const p = uv();
  const scratched = texture(mask, p).r;

  const brushed = sin(p.y.mul(820).add(sin(p.x.mul(17)).mul(3)))
    .mul(0.5)
    .add(0.5);
  const grain = mx_noise_float(vec3(p.mul(vec2(3, 140)), 0))
    .mul(0.5)
    .add(0.5);
  const silver = mix(
    vec3(0.56, 0.58, 0.62),
    vec3(0.8, 0.82, 0.86),
    brushed.mul(0.35).add(grain.mul(0.65)),
  );

  const toPointer = length(p.sub(uniforms.pointer));
  const hue = fract(
    p.x.mul(0.9).add(p.y.mul(0.55)).add(uniforms.time.mul(0.04)).add(toPointer.mul(0.8)),
  );
  const film = vec3(
    cos(hue.mul(TAU)).mul(0.5).add(0.5),
    cos(hue.add(0.33).mul(TAU)).mul(0.5).add(0.5),
    cos(hue.add(0.67).mul(TAU)).mul(0.5).add(0.5),
  );

  const diamonds = abs(fract(p.x.add(p.y).mul(15)).sub(0.5)).min(
    abs(fract(p.x.sub(p.y).mul(15)).sub(0.5)),
  );
  const lattice = float(1)
    .sub(smoothstep(0, 0.05, diamonds))
    .mul(0.08);

  const point = vec2(p.x, float(1).sub(p.y));
  const pitch = CELL_SIZE + CELL_GAP;
  const local = fract(point.sub(CELL_PAD).div(pitch)).mul(pitch / CELL_SIZE);
  const inCell = step(local.x, 1)
    .mul(step(local.y, 1))
    .mul(step(CELL_PAD, point.x))
    .mul(step(CELL_PAD, point.y))
    .mul(step(point.x, 1 - CELL_PAD))
    .mul(step(point.y, 1 - CELL_PAD));
  const fromCentre = length(local.sub(0.5));
  const ringLight = smoothstep(0.33, 0.35, fromCentre).mul(
    float(1).sub(smoothstep(0.35, 0.37, fromCentre)),
  );
  const ringShade = smoothstep(0.37, 0.385, fromCentre).mul(
    float(1).sub(smoothstep(0.385, 0.41, fromCentre)),
  );
  const pip = float(1).sub(smoothstep(0.05, 0.065, fromCentre));
  const emboss = ringLight.add(pip.mul(0.6)).mul(0.22).sub(ringShade.mul(0.14)).mul(inCell);
  const gutter = float(1).sub(inCell).mul(0.06);

  const sweep = fract(uniforms.time.mul(0.18)).mul(3.2).sub(0.6);
  const glint = exp(pow(p.x.add(p.y.mul(0.6)).sub(sweep).mul(9), 2).negate()).mul(0.55);
  const spotlight = exp(toPointer.mul(toPointer).mul(-28)).mul(0.28);

  const lip = smoothstep(0.08, 0.32, scratched).mul(
    float(1).sub(smoothstep(0.32, 0.55, scratched)),
  );
  const shadow = smoothstep(0.0, 0.1, scratched).mul(
    float(1).sub(smoothstep(0.1, 0.25, scratched)),
  );

  const noise = mx_noise_float(vec3(p.mul(7.5), 3))
    .mul(0.5)
    .add(0.5);
  const front = uniforms.clear.mul(1.25);
  const dissolved = smoothstep(front.sub(0.06), front, noise.add(0.001));
  const ember = smoothstep(front.sub(0.16), front.sub(0.06), noise)
    .mul(float(1).sub(dissolved))
    .mul(step(0.001, uniforms.clear));

  const base = mix(silver, film, 0.2)
    .add(vec3(lattice))
    .add(vec3(emboss))
    .sub(vec3(gutter))
    .add(vec3(glint.add(spotlight)).mul(vec3(1, 0.97, 0.9)))
    .add(vec3(lip.mul(0.65)))
    .sub(vec3(shadow.mul(0.18)));
  const color = mix(base, vec3(1.9, 1.35, 0.55), clamp(ember.mul(0.9), 0, 1));

  const left = float(1).sub(smoothstep(0.32, 0.6, scratched));
  const kept = max(dissolved, ember.mul(0.9));
  const opacity = left.mul(min(kept, 1)).mul(float(1).sub(uniforms.fade));

  const material = new MeshBasicNodeMaterial();
  material.colorNode = vec4(color, 1);
  material.opacityNode = opacity;
  material.transparent = true;
  material.blending = NormalBlending;
  material.depthWrite = false;
  material.depthTest = false;
  material.fog = false;
  return material;
}

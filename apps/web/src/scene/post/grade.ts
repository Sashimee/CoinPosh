import type { Node, UniformNode } from 'three/webgpu';
import {
  abs,
  float,
  hash,
  length,
  luminance,
  mix,
  screenCoordinate,
  screenSize,
  screenUV,
  smoothstep,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';

export interface VignetteUniforms {
  readonly strength: UniformNode<'float'>;
  readonly warmth: UniformNode<'float'>;
  readonly tint: UniformNode<'color'>;
}

/**
 * Lens-style falloff applied to linear HDR before tone mapping, so AgX rolls the darkened
 * corners off the same way it rolls off the rest of the frame. The tint pulls the edges
 * toward amber instead of grey, which reads as warm candle-lit luxury rather than a mask.
 */
export function warmVignette(color: Node<'vec4'>, uniforms: VignetteUniforms): Node<'vec4'> {
  const aspect = screenSize.x.div(screenSize.y);
  const centered = screenUV.sub(0.5).mul(vec2(aspect, 1));
  const cornerDistance = length(vec2(aspect.mul(0.5), 0.5));
  const radial = length(centered).div(cornerDistance);
  const edge = smoothstep(0.32, 1.08, radial);
  const falloff = edge.mul(edge);
  const tint = mix(vec3(1), uniforms.tint, falloff.mul(uniforms.warmth));
  const shade = tint.mul(float(1).sub(falloff.mul(uniforms.strength)));
  return vec4(color.rgb.mul(shade), color.a);
}

/**
 * Display-space film grain. A triangular PCG distribution keeps it from looking like
 * digital noise, the midtone weighting keeps highlights clean, and the floor still
 * dithers the dark vignette gradient so it never bands on 8-bit panels.
 */
export function filmGrain(
  color: Node<'vec4'>,
  amount: UniformNode<'float'>,
  seed: UniformNode<'float'>,
): Node<'vec4'> {
  const pixel = screenCoordinate.x
    .toUint()
    .add(screenCoordinate.y.toUint().mul(8191))
    .add(seed.toUint().mul(2654435));
  const a = hash(pixel);
  const b = hash(pixel.bitXor(0x5bd1e995));
  const triangular = a.add(b).sub(1);
  const lum = luminance(color.rgb);
  const midtones = mix(float(0.35), float(1), float(1).sub(abs(lum.mul(2).sub(1))));
  return vec4(color.rgb.add(triangular.mul(amount).mul(midtones)), color.a);
}

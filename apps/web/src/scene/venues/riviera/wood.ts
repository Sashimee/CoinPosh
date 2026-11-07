import {
  Color,
  SRGBColorSpace,
  type DataTexture,
  type Node,
  type WebGPURenderer,
} from 'three/webgpu';
import {
  abs,
  cos,
  float,
  floor,
  fract,
  hash,
  min,
  mix,
  mod,
  mx_fractal_noise_float,
  mx_noise_float,
  normalLocal,
  positionLocal,
  pow,
  saturate,
  select,
  sin,
  smoothstep,
  step,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { bakeTexture } from '../../env/bake.ts';
import { rivieraTokens, rivieraTones } from './palette.ts';

export interface PlankPattern {
  readonly name: string;
  /** Plank width across local X, metres. */
  readonly plankWidth: number;
  /** Board length along local Z before a butt joint, metres. */
  readonly boardLength: number;
  /** Width of the stripe between planks (holly inlay or caulk), metres. */
  readonly seamWidth: number;
  readonly seamColor: string;
  readonly buttJoints: boolean;
  /** Planks across and boards along one seamless tile. */
  readonly planks: number;
  readonly boards: number;
  /** Texel size of the tile at texture scale 1. */
  readonly width: number;
  readonly height: number;
  /** Multiplier on the wood albedo: oiled deck teak is darker than the varnished sole. */
  readonly albedo: number;
  readonly roughness: { readonly wood: number; readonly grain: number; readonly seam: number };
}

/** Teak-and-holly cabin sole under varnish: the playfield and the cap rails. */
export const CABIN_SOLE: PlankPattern = {
  name: 'riviera/teak-sole',
  plankWidth: 0.07,
  boardLength: 2.4,
  seamWidth: 0.0022,
  seamColor: rivieraTones.holly,
  buttJoints: false,
  planks: 8,
  boards: 1,
  width: 512,
  height: 1024,
  albedo: 0.74,
  roughness: { wood: 0.42, grain: 0.06, seam: 0.5 },
};

/** Oiled deck teak with black-caulked seams and staggered butt joints. */
export const DECK_PLANKING: PlankPattern = {
  name: 'riviera/teak-deck',
  plankWidth: 0.11,
  boardLength: 3.1,
  seamWidth: 0.007,
  seamColor: rivieraTones.caulk,
  buttJoints: true,
  planks: 16,
  boards: 2,
  width: 1024,
  height: 1024,
  albedo: 0.55,
  roughness: { wood: 0.74, grain: 0.08, seam: 0.9 },
};

/** The plank that vertical faces show, away from the tile's wrap so no seam lands on an edge. */
const EDGE_PLANK = 2;

function linear(hex: string): Node<'vec3'> {
  const c = new Color(hex);
  return vec3(c.r, c.g, c.b);
}

/** The exact sRGB transfer curve, matching what the GPU decodes when the tile is sampled. */
function encodeSrgb(c: Node<'vec3'>): Node<'vec3'> {
  const curve = pow(c, vec3(1 / 2.4))
    .mul(1.055)
    .sub(0.055);
  return mix(c.mul(12.92), curve, step(vec3(0.0031308), c));
}

/**
 * One seamless tile of quarter-sawn teak, grain along V. Each board gets its own tone and grain
 * offset from a hash of its plank and board index. The along-grain coordinate is wrapped onto a
 * circle before it feeds the noise, so the figure repeats exactly at the tile's V edge.
 */
function plankTile(pattern: PlankPattern, width: number, height: number) {
  return (uv: Node<'vec2'>): Node<'vec4'> => {
    const tileLength = pattern.boards * pattern.boardLength;
    const across = uv.x.mul(pattern.planks);
    const plank = floor(across);
    const x = across.mul(pattern.plankWidth);
    const along = uv.y.mul(pattern.boards).add(hash(plank.add(4096)).mul(0.83));
    const board = mod(floor(along), pattern.boards);
    const tone = hash(plank.mul(7).add(board.mul(131)).add(65536));
    const seed = tone.mul(97);

    const theta = uv.y.mul(Math.PI * 2);
    const ring = (frequency: number): Node<'vec2'> =>
      vec2(cos(theta), sin(theta)).mul((frequency * tileLength) / (Math.PI * 2));
    const fineRing = ring(4.5);
    const streakRing = ring(1.3);
    const fine = mx_noise_float(vec3(x.mul(260).add(seed), fineRing.x, fineRing.y));
    const streak = mx_fractal_noise_float(
      vec3(x.mul(38).add(seed).add(11), streakRing.x, streakRing.y),
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

    const halfSeam = pattern.seamWidth * 0.5;
    const texelX = (pattern.planks * pattern.plankWidth) / width;
    const edgeX = min(fract(across), float(1).sub(fract(across))).mul(pattern.plankWidth);
    let seam = float(1).sub(smoothstep(halfSeam - texelX * 0.5, halfSeam + texelX * 0.5, edgeX));
    if (pattern.buttJoints) {
      const texelZ = tileLength / height;
      const edgeZ = min(fract(along), float(1).sub(fract(along))).mul(pattern.boardLength);
      seam = seam.max(
        float(1).sub(smoothstep(halfSeam - texelZ * 0.5, halfSeam + texelZ * 0.5, edgeZ)),
      );
    }
    const albedo = mix(wood, linear(pattern.seamColor), seam).mul(pattern.albedo);
    const { roughness } = pattern;
    const rough = mix(
      float(roughness.wood).add(fine.mul(roughness.grain)),
      float(roughness.seam),
      seam,
    );
    return vec4(encodeSrgb(saturate(albedo)), saturate(rough));
  };
}

/** Bakes a plank tile: sRGB albedo in RGB, roughness in alpha, tiling in both directions. */
export function bakePlanks(
  renderer: WebGPURenderer,
  pattern: PlankPattern,
  textureScale: number,
  anisotropy: number,
): Promise<DataTexture> {
  const width = Math.max(64, Math.round(pattern.width * textureScale));
  const height = Math.max(64, Math.round(pattern.height * textureScale));
  return bakeTexture(renderer, plankTile(pattern, width, height), {
    name: pattern.name,
    width,
    height,
    colorSpace: SRGBColorSpace,
    anisotropy,
  });
}

/**
 * Maps a plank tile onto a mesh in its local frame. Upward faces get planks across X with the
 * grain along Z. Vertical faces (the playfield's front lip, the cap rails' sides) show a single
 * plank as an edge band with the grain running along the face, instead of the streaks a planar
 * top-down projection smears down them.
 */
export function plankUv(pattern: PlankPattern): Node<'vec2'> {
  const p = positionLocal;
  const n = abs(normalLocal);
  const tileLength = pattern.boards * pattern.boardLength;
  const top = vec2(p.x.div(pattern.plankWidth).add(0.5).div(pattern.planks), p.z.div(tileLength));
  const run = select(n.x.greaterThan(n.z), p.z, p.x);
  const band = fract(p.y.div(pattern.plankWidth * 1.25))
    .mul(0.8)
    .add(0.1);
  const side = vec2(band.add(EDGE_PLANK).div(pattern.planks), run.div(tileLength));
  return select(n.y.greaterThan(0.6), top, side);
}

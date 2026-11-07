import {
  abs,
  atan,
  clamp,
  cos,
  dot,
  float,
  length,
  max,
  min,
  mix,
  mod,
  normalize,
  pow,
  select,
  sign,
  sin,
  smoothstep,
  texture,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import {
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  NearestFilter,
  NodeMaterial,
  NoColorSpace,
  QuadMesh,
  RenderTarget,
  UnsignedByteType,
  type Node,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu';
import type { CoinFaceDesign } from './tiers.ts';

type F = Node<'float'>;
type V2 = Node<'vec2'>;
type Num = F | number;

const DEG = Math.PI / 180;

export const EMBOSS_RELIEF_DEPTH = 0.022;
export const DEFAULT_EMBOSS_RESOLUTION = 512;

function rotate(p: V2, angle: number): V2 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return vec2(p.x.mul(c).sub(p.y.mul(s)), p.x.mul(s).add(p.y.mul(c)));
}

function sdCircle(p: V2, r: Num): F {
  return length(p).sub(r);
}

function sdSegment(p: V2, ax: number, ay: number, bx: number, by: number, halfWidth: Num): F {
  const pa = p.sub(vec2(ax, ay));
  const ba = vec2(bx - ax, by - ay);
  const h = clamp(dot(pa, ba).div((bx - ax) ** 2 + (by - ay) ** 2), 0, 1);
  return length(pa.sub(ba.mul(h))).sub(halfWidth);
}

// Inigo Quilez's ring arc, symmetric around +y with half-aperture `aperture`.
function sdArc(p: V2, aperture: number, radius: number, halfWidth: Num): F {
  const sx = Math.sin(aperture);
  const cy = Math.cos(aperture);
  const q = vec2(abs(p.x), p.y);
  const cap = length(q.sub(vec2(sx * radius, cy * radius)));
  const ring = abs(length(q).sub(radius));
  return select(q.x.mul(cy).greaterThan(q.y.mul(sx)), cap, ring).sub(halfWidth);
}

function sdVesica(p: V2, halfLength: number, halfWidth: number): F {
  const r = (halfWidth + (halfLength * halfLength) / halfWidth) / 2;
  const d = r - halfWidth;
  const q = abs(p);
  const tip = length(q.sub(vec2(0, halfLength)));
  const body = length(q.sub(vec2(-d, 0))).sub(r);
  return select(q.y.sub(halfLength).mul(d).greaterThan(q.x.mul(halfLength)), tip, body);
}

function sdStar5(p: V2, r: number, rf: number): F {
  const k1 = vec2(0.809016994375, -0.587785252292);
  const k2 = vec2(-0.809016994375, -0.587785252292);
  let q: V2 = vec2(abs(p.x), p.y);
  q = q.sub(k1.mul(max(dot(k1, q), 0).mul(2)));
  q = q.sub(k2.mul(max(dot(k2, q), 0).mul(2)));
  q = vec2(abs(q.x), q.y.sub(r));
  const ba = vec2(rf * 0.587785252292 - 0, rf * 0.809016994375 - 1);
  const h = clamp(dot(q, ba).div(dot(ba, ba)), 0, r);
  return length(q.sub(ba.mul(h))).mul(sign(q.y.mul(ba.x).sub(q.x.mul(ba.y))));
}

function sdRhombus(p: V2, bx: number, by: number): F {
  const q = abs(p);
  const b = vec2(bx, by);
  const bq = b.sub(q.mul(2));
  const h = clamp(
    bq.x
      .mul(bx)
      .sub(bq.y.mul(by))
      .div(bx * bx + by * by),
    -1,
    1,
  );
  const d = length(
    q.sub(
      vec2(
        float(1)
          .sub(h)
          .mul(bx * 0.5),
        float(1)
          .add(h)
          .mul(by * 0.5),
      ),
    ),
  );
  return d.mul(
    sign(
      q.x
        .mul(by)
        .add(q.y.mul(bx))
        .sub(bx * by),
    ),
  );
}

function plateau(d: F, bevel: number): F {
  return smoothstep(0, bevel, d.negate());
}

function dome(d: F, halfWidth: number): F {
  const t = clamp(d.negate().div(halfWidth), 0, 1);
  return float(1).sub(pow(float(1).sub(t), 2));
}

function facet(d: F, depth: number): F {
  return clamp(d.negate().div(depth), 0, 1);
}

interface Leaf {
  readonly x: number;
  readonly y: number;
  readonly axis: number;
  readonly halfLength: number;
  readonly halfWidth: number;
}

function leafHeight(p: V2, leaf: Leaf): F {
  const local = rotate(p.sub(vec2(leaf.x, leaf.y)), Math.PI / 2 - leaf.axis);
  const d = sdVesica(local, leaf.halfLength, leaf.halfWidth);
  const vein = smoothstep(0.0015, 0.005, abs(local.x));
  return dome(d, leaf.halfWidth)
    .mul(mix(0.62, 1, vein))
    .mul(0.78);
}

const LAUREL_RADIUS = 0.645;
const LAUREL_START = -84 * DEG;
const LAUREL_END = 62 * DEG;

function laurelLeaves(design: CoinFaceDesign): Leaf[] {
  const leaves: Leaf[] = [];
  const n = design.laurelLeaves;
  const span = LAUREL_END - LAUREL_START;
  const step = span / (n + 0.4);
  for (let i = 0; i < n; i += 1) {
    const t = i / n;
    const scale = 1 - 0.3 * t;
    const halfLength = 0.064 * scale;
    const halfWidth = 0.025 * scale;
    for (const side of [1, -1] as const) {
      const a = LAUREL_START + step * (i + 0.35 + (side === 1 ? 0 : 0.5));
      const axis = a + Math.PI / 2 - side * 34 * DEG;
      const reach = halfLength * 0.88;
      leaves.push({
        x: LAUREL_RADIUS * Math.cos(a) + reach * Math.cos(axis),
        y: LAUREL_RADIUS * Math.sin(a) + reach * Math.sin(axis),
        axis,
        halfLength,
        halfWidth,
      });
    }
  }
  const tipScale = 0.72;
  leaves.push({
    x: LAUREL_RADIUS * Math.cos(LAUREL_END) + 0.04 * Math.cos(LAUREL_END + Math.PI / 2),
    y: LAUREL_RADIUS * Math.sin(LAUREL_END) + 0.04 * Math.sin(LAUREL_END + Math.PI / 2),
    axis: LAUREL_END + Math.PI / 2 + 6 * DEG,
    halfLength: 0.046 * tipScale + 0.012,
    halfWidth: 0.017 * tipScale,
  });
  return leaves;
}

function laurelHeight(p: V2, design: CoinFaceDesign): F {
  const mirrored = vec2(abs(p.x), p.y);
  const mid = (LAUREL_START + LAUREL_END) / 2;
  const stemD = sdArc(
    rotate(mirrored, Math.PI / 2 - mid),
    (LAUREL_END - LAUREL_START) / 2,
    LAUREL_RADIUS,
    0.0042,
  );
  let h: F = dome(stemD, 0.0042).mul(0.55);

  for (const leaf of laurelLeaves(design)) h = max(h, leafHeight(mirrored, leaf));

  if (design.berries) {
    const span = LAUREL_END - LAUREL_START;
    const step = span / (design.laurelLeaves + 0.4);
    for (let i = 1; i < design.laurelLeaves; i += 2) {
      const a = LAUREL_START + step * (i + 0.05);
      const bx = (LAUREL_RADIUS - 0.052) * Math.cos(a);
      const by = (LAUREL_RADIUS - 0.052) * Math.sin(a);
      h = max(h, dome(sdCircle(mirrored.sub(vec2(bx, by)), 0.0115), 0.0115).mul(0.82));
    }
  }

  const knot = dome(sdCircle(mirrored.sub(vec2(0, -LAUREL_RADIUS)), 0.019), 0.019).mul(0.9);
  const loop = leafHeight(mirrored, {
    x: 0.045,
    y: -LAUREL_RADIUS + 0.012,
    axis: 12 * DEG,
    halfLength: 0.034,
    halfWidth: 0.015,
  });
  const tail = leafHeight(mirrored, {
    x: 0.03,
    y: -LAUREL_RADIUS - 0.042,
    axis: -62 * DEG,
    halfLength: 0.036,
    halfWidth: 0.009,
  });
  return max(max(h, knot), max(loop, tail));
}

function monogramHeight(p: V2): F {
  const cx = -0.115;
  const cRadius = 0.25;
  const gap = 44 * DEG;
  const local = p.sub(vec2(cx, 0));
  const leftness = max(local.x.negate().div(max(length(local), 1e-4)), 0);
  const cWidth = float(0.016).add(pow(leftness, 1.4).mul(0.042));
  const cRing = sdArc(rotate(local, -Math.PI / 2), Math.PI - gap, cRadius, cWidth);
  const ballX = cx + cRadius * Math.cos(gap) - 0.006;
  const ballY = cRadius * Math.sin(gap);
  const balls = min(
    sdCircle(p.sub(vec2(ballX, ballY)), 0.024),
    sdCircle(p.sub(vec2(ballX, -ballY)), 0.024),
  );
  const cD = min(cRing, balls);

  const stemX = 0.15;
  const top = 0.25;
  const bowlX = 0.215;
  const bowlRadius = 0.142;
  const bowlY = top - bowlRadius;
  const bowlLocal = p.sub(vec2(bowlX, bowlY));
  const rightness = max(bowlLocal.x.div(max(length(bowlLocal), 1e-4)), 0);
  const bowlWidth = float(0.013).add(pow(rightness, 1.4).mul(0.034));
  const bowl = sdArc(rotate(bowlLocal, Math.PI / 2), Math.PI / 2, bowlRadius, bowlWidth);
  const pD = min(
    min(sdSegment(p, stemX, -top, stemX, top, 0.04), bowl),
    min(
      min(
        sdSegment(p, stemX, top, bowlX, top, 0.011),
        sdSegment(p, stemX, bowlY - bowlRadius, bowlX, bowlY - bowlRadius, 0.011),
      ),
      min(
        sdSegment(p, stemX - 0.07, -top, stemX + 0.07, -top, 0.01),
        sdSegment(p, stemX - 0.06, top, stemX, top, 0.01),
      ),
    ),
  );

  const letter = (d: F): F => plateau(d, 0.011).mul(float(0.82).add(dome(d, 0.045).mul(0.18)));
  return max(letter(cD), letter(pD));
}

function beadsHeight(p: V2, count: number): F {
  if (count === 0) return float(0);
  const radius = 0.785;
  const sector = (Math.PI * 2) / count;
  const a = mod(atan(p.y, p.x).add(sector / 2 + Math.PI * 2), sector).sub(sector / 2);
  const r = length(p);
  const q = vec2(r.mul(cos(a)).sub(radius), r.mul(sin(a)));
  return dome(sdCircle(q, 0.0105), 0.0105).mul(0.7);
}

function crownHeight(p: V2, design: CoinFaceDesign): F {
  let h: F = float(0);
  const y = LAUREL_RADIUS + 0.004;
  if (design.gem) {
    h = facet(sdRhombus(p.sub(vec2(0, y)), 0.032, 0.05), 0.022);
    for (const side of [-1, 1]) {
      const sx = side * 0.075;
      h = max(h, facet(sdStar5(p.sub(vec2(sx, y - 0.006)), 0.017, 0.45), 0.009).mul(0.9));
    }
    return h;
  }
  const spacing = 9.4 * DEG;
  for (let j = 0; j < design.stars; j += 1) {
    const a = Math.PI / 2 + (j - (design.stars - 1) / 2) * spacing;
    const r = j === (design.stars - 1) / 2 ? y + 0.008 : y;
    h = max(h, facet(sdStar5(p.sub(vec2(r * Math.cos(a), r * Math.sin(a))), 0.033, 0.42), 0.014));
  }
  return h;
}

function guillocheHeight(p: V2, amount: number): F {
  if (amount === 0) return float(0);
  const r = length(p);
  const a = atan(p.y, p.x);
  const waves = float(0.5).add(cos(a.mul(72).add(sin(r.mul(34)).mul(1.4))).mul(0.5));
  const fade = smoothstep(0.5, 0.47, r).mul(smoothstep(0.37, 0.41, r));
  const border = dome(abs(r.sub(0.52)).sub(0.0035), 0.0035).mul(0.6);
  const inner = dome(abs(r.sub(0.355)).sub(0.0025), 0.003).mul(0.5);
  return max(max(waves.mul(fade).mul(0.09 * amount), border.mul(amount)), inner.mul(amount));
}

export function coinFaceHeight(p: V2, design: CoinFaceDesign): F {
  const inField = smoothstep(0.835, 0.825, length(p));
  const h = max(
    max(guillocheHeight(p, design.guilloche), laurelHeight(p, design)),
    max(max(beadsHeight(p, design.beads), crownHeight(p, design)), monogramHeight(p)),
  );
  return h.mul(inField);
}

export interface CoinEmbossBake {
  readonly texture: Texture;
  dispose(): void;
}

// Two passes: the face design's height field is evaluated once per texel, then a second
// pass derives the tangent-space normal and a cavity term from neighbouring texels. The
// mipmapped result keeps far coins from shimmering and costs one fetch per pixel at runtime.
export function bakeCoinEmboss(
  renderer: WebGPURenderer,
  design: CoinFaceDesign,
  resolution = DEFAULT_EMBOSS_RESOLUTION,
): CoinEmbossBake {
  const heightTarget = new RenderTarget(resolution, resolution, {
    type: HalfFloatType,
    depthBuffer: false,
    generateMipmaps: false,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
  });
  const outputTarget = new RenderTarget(resolution, resolution, {
    type: UnsignedByteType,
    depthBuffer: false,
    generateMipmaps: true,
    minFilter: LinearMipmapLinearFilter,
    magFilter: LinearFilter,
    colorSpace: NoColorSpace,
    anisotropy: 8,
  });

  const heightMaterial = new NodeMaterial();
  const facePoint = uv().mul(2).sub(1);
  heightMaterial.fragmentNode = vec4(coinFaceHeight(facePoint, design), 0, 0, 1);

  const texel = 1 / resolution;
  const sampleHeight = (dx: number, dy: number): F =>
    texture(heightTarget.texture, uv().add(vec2(dx, dy))).x;
  const center = sampleHeight(0, 0);
  const slopeX = sampleHeight(texel, 0)
    .sub(sampleHeight(-texel, 0))
    .div(4 * texel);
  const slopeY = sampleHeight(0, texel)
    .sub(sampleHeight(0, -texel))
    .div(4 * texel);
  const normal = normalize(
    vec3(slopeX.mul(-EMBOSS_RELIEF_DEPTH), slopeY.mul(-EMBOSS_RELIEF_DEPTH), 1),
  );

  let occlusion: F = float(0);
  const taps = 12;
  for (const radius of [0.012, 0.03]) {
    for (let i = 0; i < taps; i += 1) {
      const a = (i / taps) * Math.PI * 2 + radius * 40;
      const neighbour = sampleHeight((radius / 2) * Math.cos(a), (radius / 2) * Math.sin(a));
      occlusion = occlusion.add(max(neighbour.sub(center), 0));
    }
  }
  const cavity = clamp(float(1).sub(occlusion.div(taps * 2).mul(2.6)), 0, 1);

  const normalMaterial = new NodeMaterial();
  normalMaterial.fragmentNode = vec4(normal.xy.mul(0.5).add(0.5), center, cavity);

  const quad = new QuadMesh(heightMaterial);
  const previousTarget = renderer.getRenderTarget();
  try {
    renderer.setRenderTarget(heightTarget);
    quad.render(renderer);
    quad.material = normalMaterial;
    renderer.setRenderTarget(outputTarget);
    quad.render(renderer);
  } finally {
    renderer.setRenderTarget(previousTarget);
    heightMaterial.dispose();
    normalMaterial.dispose();
    heightTarget.dispose();
  }

  return {
    texture: outputTarget.texture,
    dispose() {
      outputTarget.dispose();
    },
  };
}

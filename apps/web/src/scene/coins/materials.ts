import {
  abs,
  atan,
  attribute,
  clamp,
  cos,
  dot,
  float,
  floor,
  fract,
  fwidth,
  hash,
  inverseSqrt,
  length,
  max,
  mix,
  normalize,
  normalView,
  normalViewGeometry,
  positionView,
  positionViewDirection,
  pow,
  select,
  sin,
  smoothstep,
  sqrt,
  texture,
  time,
  uv,
  vec2,
  vec3,
  vertexStage,
} from 'three/tsl';
import {
  Color,
  DataTexture,
  MeshPhysicalNodeMaterial,
  NoColorSpace,
  RGBAFormat,
  type Node,
  type Texture,
} from 'three/webgpu';
import { NEAR_COIN_GEOMETRY } from './geometry.ts';
import type { CoinLook } from './tiers.ts';

type F = Node<'float'>;
type V2 = Node<'vec2'>;
type V3 = Node<'vec3'>;

export interface CoinMaterial {
  readonly material: MeshPhysicalNodeMaterial;
  setEmboss(texture: Texture): void;
}

// Matches the analytic slope of the reed cut in geometry.ts (depth * reeds / 2), so the
// per-pixel reeds line up with the notched silhouette of the near mesh.
const REED_SLOPE = (NEAR_COIN_GEOMETRY.reedDepth * NEAR_COIN_GEOMETRY.reeds) / 2;

let flatEmboss: DataTexture | null = null;

// A neutral texel (flat normal, zero height, no cavity) so a coin renders correctly before
// its face has been baked, e.g. in tests or while the renderer is still initialising.
export function flatEmbossTexture(): DataTexture {
  if (!flatEmboss) {
    flatEmboss = new DataTexture(new Uint8Array([128, 128, 0, 255]), 1, 1, RGBAFormat);
    flatEmboss.colorSpace = NoColorSpace;
    flatEmboss.needsUpdate = true;
  }
  return flatEmboss;
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

export function createCoinMaterial(look: CoinLook, motion: F): CoinMaterial {
  const embossNode = texture(flatEmbossTexture(), uv());
  const st = uv();
  const part = attribute('coinPart', 'float');
  const face = float(1).sub(part);
  // Hashed per vertex: the seed is a large integer, and hashing the interpolated value per
  // fragment turns the tiny interpolation error into per-pixel noise in every seeded term.
  const seed = vertexStage(hash(attribute('coinSeed', 'float')));

  const p = st.mul(2).sub(1);
  const r = length(p);
  const height = embossNode.z.mul(face);
  const cavity = mix(float(1), embossNode.w, face);
  const relief = smoothstep(0.12, 0.42, height);
  const lip = smoothstep(0.855, 0.88, r).mul(face);

  let slope: V2 = embossNode.xy.mul(2).sub(1).mul(face);
  const reedCoord = st.x.mul(NEAR_COIN_GEOMETRY.reeds);
  const reedResolved = float(1).sub(smoothstep(0.25, 0.5, fwidth(reedCoord)));
  slope = slope.add(
    vec2(
      sin(reedCoord.mul(Math.PI * 2))
        .mul(REED_SLOPE)
        .mul(reedResolved)
        .mul(part),
      0,
    ),
  );
  if (look.sparkle > 0) {
    const scale = mix(vec2(150, 150), vec2(120, 14), part);
    const cells = st.mul(scale);
    const cell = floor(cells);
    const id = cell.x.add(cell.y.mul(4099));
    const pick = hash(id);
    const spin = hash(id.add(7919)).mul(Math.PI * 2);
    const within = smoothstep(0.46, 0.18, length(fract(cells).sub(0.5)));
    // A flake needs a few pixels to read as a glint; any smaller and it is sub-pixel noise
    // that the thin-film layer turns into crawling colour speckle.
    const footprint = max(fwidth(cells.x), fwidth(cells.y));
    const resolved = float(1).sub(smoothstep(0.15, 0.35, footprint));
    const flake = smoothstep(0.955, 0.965, pick)
      .mul(within)
      .mul(resolved)
      .mul(look.sparkle * 0.7);
    slope = slope.add(vec2(cos(spin), sin(spin)).mul(flake));
  }

  const nz = sqrt(clamp(float(1).sub(dot(slope, slope)), 0.02, 1));
  const geometric = normalView;
  const frame = cotangentFrame(geometric, st);
  const normalNode = normalize(
    frame.t.mul(slope.x).add(frame.b.mul(slope.y)).add(geometric.mul(nz)),
  );

  const ringCoord = r.mul(560);
  const rings = hash(floor(ringCoord).add(31)).sub(0.5).mul(2);
  const ringsResolved = clamp(float(1.4).sub(fwidth(ringCoord).mul(1.2)), 0, 1);
  const turning = rings
    .mul(look.turningRings)
    .mul(ringsResolved)
    .mul(face)
    .mul(float(1).sub(relief))
    .mul(float(1).sub(lip));

  const faceRoughness = mix(
    mix(float(look.roughness), float(look.reliefRoughness), relief),
    float(look.roughness * 0.6),
    lip,
  );
  const roughness = clamp(
    mix(faceRoughness, float(look.edgeRoughness), part).add(turning),
    0.04,
    1,
  );

  const radial = normalize(p.add(vec2(1e-5, 0)));
  const faceAnisotropy = radial
    .mul(look.anisotropy)
    .mul(smoothstep(0.02, 0.14, r))
    .mul(float(1).sub(relief.mul(0.85)))
    .mul(float(1).sub(lip.mul(0.7)));
  const edgeAnisotropy = vec2(1, 0).mul(Math.min(look.anisotropy, 0.6));
  const anisotropy = mix(faceAnisotropy, edgeAnisotropy, part);

  // The geometric normal, not the shaded one: in a colour node `normalView` already carries the
  // emboss and flake detail, and feeding that into the prismatic hue turns sub-pixel relief into
  // per-pixel rainbow noise.
  const facing = clamp(dot(normalViewGeometry, positionViewDirection), 0, 1);
  let metal: V3 = linear(look.metal);
  let emissive: V3 | null = null;
  if (look.prismatic) {
    const sweep = atan(p.y, p.x).div(Math.PI * 2);
    const flow = mix(
      sweep.add(r.mul(0.55)).add(height.mul(0.3)),
      st.x.mul(3).add(st.y.mul(0.6)),
      part,
    );
    const hue = flow.add(time.mul(motion).mul(0.06)).add(facing.mul(0.4)).add(seed);
    const rainbow = cos(
      vec3(hue, hue, hue)
        .add(vec3(0, 0.33, 0.67))
        .mul(Math.PI * 2),
    )
      .mul(0.5)
      .add(0.5);
    metal = mix(metal, pow(rainbow, vec3(1.5, 1.5, 1.5)), 0.72);
    const rim = pow(float(1).sub(facing), 3);
    emissive = rainbow.mul(float(0.035).add(rim.mul(0.16)));
  }

  const jitter = float(1).add(seed.sub(0.5).mul(0.07));
  const recessMix = float(1)
    .sub(cavity)
    .mul(0.8)
    .add(abs(seed.sub(0.5)).mul(0.08).mul(face));
  const albedo = mix(metal, linear(look.recess), clamp(recessMix, 0, 1))
    .mul(jitter)
    .mul(mix(0.5, 1, cavity));

  const material = new MeshPhysicalNodeMaterial();
  material.name = `coin-${look.metal}`;
  material.colorNode = albedo;
  material.metalnessNode = float(1);
  material.roughnessNode = roughness;
  material.normalNode = normalNode;
  material.anisotropyNode = anisotropy;
  material.aoNode = cavity;
  if (look.clearcoat > 0) {
    material.clearcoatNode = float(look.clearcoat).mul(mix(float(1), float(0.6), part));
    material.clearcoatRoughnessNode = float(look.clearcoatRoughness);
  }
  if (look.iridescence > 0) {
    material.iridescenceNode = float(look.iridescence);
    material.iridescenceIORNode = float(1.75);
    material.iridescenceThicknessNode = mix(
      float(320),
      float(680),
      sin(height.mul(4).add(r.mul(5)).add(seed.mul(6.283)))
        .mul(0.5)
        .add(0.5),
    );
  }
  if (emissive) material.emissiveNode = emissive;

  return {
    material,
    setEmboss(next) {
      embossNode.value = next;
    },
  };
}

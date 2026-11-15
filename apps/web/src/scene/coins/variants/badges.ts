import { COLLECTIBLE_COIN_VARIANTS } from '@coinposh/shared';
import {
  attribute,
  cameraProjectionMatrix,
  float,
  fwidth,
  length,
  max,
  mix,
  modelViewMatrix,
  positionGeometry,
  smoothstep,
  texture,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import {
  Color,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  type DataTexture,
} from 'three/webgpu';
import { rivieraTokens } from '../../venues/riviera/palette.ts';
import { createGlyphAtlas } from './glyphs.ts';

/** The quad's half-size over the badge disc's radius: the rest is a soft dark halo. */
const HALO = 1.22;
/** Inner radius of the accent rim, as a share of the disc radius. */
const RIM = 0.8;
/** Radius of the glyph cell inside the disc. */
const GLYPH_RADIUS = 0.7;

export interface BadgeLayer {
  readonly mesh: InstancedMesh;
  readonly atlas: DataTexture;
  readonly centres: InstancedBufferAttribute;
  readonly sizes: InstancedBufferAttribute;
  readonly glyphs: InstancedBufferAttribute;
  readonly accents: InstancedBufferAttribute;
  readonly capacity: number;
  dispose(): void;
}

export function linearRgb(hex: string): [number, number, number] {
  const c = new Color(hex);
  return [c.r, c.g, c.b];
}

/**
 * Colourblind badges for variant coins, one draw call for all of them: a navy lacquer disc with
 * an accent rim and an ivory glyph, billboarded towards the camera. The glyph carries the
 * variant on its own (the rim colour only backs it up), and ivory on navy keeps a luminance
 * contrast above 10:1 for every kind of colour vision.
 */
export function createBadgeLayer(capacity: number): BadgeLayer {
  const slots = Math.max(capacity, 1);
  const geometry = new PlaneGeometry(2 * HALO, 2 * HALO);
  const centres = new InstancedBufferAttribute(new Float32Array(slots * 3), 3);
  const sizes = new InstancedBufferAttribute(new Float32Array(slots), 1);
  const glyphs = new InstancedBufferAttribute(new Float32Array(slots), 1);
  const accents = new InstancedBufferAttribute(new Float32Array(slots * 3), 3);
  geometry.setAttribute('badgeCentre', centres);
  geometry.setAttribute('badgeSize', sizes);
  geometry.setAttribute('badgeGlyph', glyphs);
  geometry.setAttribute('badgeAccent', accents);

  const atlas = createGlyphAtlas();
  const material = new MeshBasicNodeMaterial({
    name: 'coin-variant-badges',
    transparent: true,
    depthWrite: false,
  });
  const centre = attribute<'vec3'>('badgeCentre', 'vec3');
  const size = attribute<'float'>('badgeSize', 'float');
  const viewCentre = modelViewMatrix.mul(vec4(centre, 1));
  const corner = positionGeometry.xy.mul(size);
  material.vertexNode = cameraProjectionMatrix.mul(
    vec4(viewCentre.xy.add(corner), viewCentre.z, 1),
  );

  const q = uv().mul(2).sub(1).mul(HALO);
  const d = length(q);
  const aa = max(fwidth(d), 1e-4);
  const disc = smoothstep(float(1).add(aa), float(1).sub(aa), d);
  const halo = smoothstep(HALO, 1, d).mul(0.45);
  const rimBand = smoothstep(RIM - 0.001, RIM, d.add(aa)).mul(disc);
  const hairline = smoothstep(aa.mul(1.4), float(0), d.sub(RIM - 0.06).abs()).mul(disc);

  const cells = COLLECTIBLE_COIN_VARIANTS.length;
  const local = q.div(GLYPH_RADIUS).mul(0.5).add(0.5);
  const inCell = smoothstep(1.02, 0.98, max(local.x.sub(0.5).abs(), local.y.sub(0.5).abs()).mul(2));
  const atlasUv = vec2(
    attribute<'float'>('badgeGlyph', 'float').add(local.x.clamp(0.002, 0.998)).div(cells),
    local.y.clamp(0.002, 0.998),
  );
  const sdf = texture(atlas, atlasUv).r;
  const edge = max(fwidth(sdf).mul(0.85), 0.012);
  const glyph = smoothstep(float(0.5).sub(edge), float(0.5).add(edge), sdf).mul(inCell);

  const accent = attribute<'vec3'>('badgeAccent', 'vec3');
  const navy = new Color(rivieraTokens['navy-lacquer']);
  const ivory = new Color(rivieraTokens.ivory);
  const gold = new Color(rivieraTokens['gold-brushed']);
  const sheen = smoothstep(0.9, -0.6, q.y).mul(0.6).add(0.7);
  const body = vec3(navy.r, navy.g, navy.b).mul(sheen);
  const ink = mix(vec3(ivory.r, ivory.g, ivory.b), accent, 0.12).mul(1.25);
  let color = mix(body, accent, rimBand);
  color = mix(color, vec3(gold.r, gold.g, gold.b).mul(1.3), hairline.mul(0.85));
  color = mix(color, ink, glyph);
  material.colorNode = color;
  material.opacityNode = max(disc, halo);

  const mesh = new InstancedMesh(geometry, material, slots);
  mesh.name = 'coin-variant-badges';
  mesh.count = 0;
  mesh.visible = false;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 4;
  return {
    mesh,
    atlas,
    centres,
    sizes,
    glyphs,
    accents,
    capacity: slots,
    dispose() {
      geometry.dispose();
      material.dispose();
      atlas.dispose();
      mesh.dispose();
    },
  };
}

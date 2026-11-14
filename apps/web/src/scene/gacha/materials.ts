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
  frontFacing,
  hash,
  length,
  max,
  mix,
  normalView,
  normalize,
  positionLocal,
  positionViewDirection,
  pow,
  saturate,
  select,
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
  DoubleSide,
  FrontSide,
  MeshPhysicalNodeMaterial,
  SpriteNodeMaterial,
  type Node,
} from 'three/webgpu';
import { rivieraTokens, rivieraTones } from '../venues/riviera/palette.ts';
import { HEIRLOOM_PRISM } from '../../vfx/palette.ts';
import { CapsuleShell, MachinePart, type MachinePartId } from './geometry.ts';
import { GACHA } from './layout.ts';

type F = Node<'float'>;
type V3 = Node<'vec3'>;

/** `low` drops the velvet sheen and the brushed anisotropy, the two lobes a weak GPU feels. */
export type GachaQuality = 'low' | 'high';

function linear(hex: string): V3 {
  const c = new Color(hex);
  return vec3(c.r, c.g, c.b);
}

function mask(part: F, id: number): F {
  return float(1).sub(clamp(abs(part.sub(id)).mul(2), 0, 1));
}

/** The heirloom's animated gradient through HEIRLOOM_PRISM at phase `t` (wraps every 1). */
export function prism(t: F): V3 {
  const stops = HEIRLOOM_PRISM.map(linear);
  const x = fract(t).mul(stops.length);
  const i = floor(x);
  const f = smoothstep(0, 1, fract(x));
  const pick = (offset: number): V3 => {
    let chosen: V3 = stops[(stops.length - 1 + offset) % stops.length] ?? vec3(1);
    for (let k = stops.length - 2; k >= 0; k--) {
      const stop = stops[(k + offset) % stops.length] ?? vec3(1);
      chosen = select(i.lessThan(k + 0.5), stop, chosen);
    }
    return chosen;
  };
  return mix(pick(0), pick(1), f);
}

export interface MachineMaterial {
  readonly material: MeshPhysicalNodeMaterial;
  /** Linear colour of the lamp rings in the collar and the cap. */
  readonly lampColor: { value: Color };
  /** Lamp brightness: a low idle glow, flashed by the crank clicks and the pop. */
  readonly lampLevel: { value: number };
}

/**
 * Every opaque surface of the cabinet and the crank, picked per vertex by `gachaPart`: navy
 * show-car lacquer with a metal flake under a mirror clearcoat and a faint warm Fresnel rim;
 * brushed gold whose streaks follow each part's U (circular on the turned collar and cap,
 * lengthwise on the plinth) with anisotropy along them; mirror-polished gold; navy velvet with
 * a lifted sheen; clearcoated ivory for the grip; a lacquered black slot; a guilloche crank plate
 * (engine-turned rings under a sunburst); and lamp beads that glow.
 */
export function createMachineMaterial(quality: GachaQuality): MachineMaterial {
  const high = quality === 'high';
  const lampColor = uniform(new Color(rivieraTokens.champagne));
  const lampLevel = uniform(0.35);
  const part = attribute('gachaPart', 'float');
  const is = (id: MachinePartId): F => mask(part, id);
  const lacquer = is(MachinePart.lacquer);
  const brushed = is(MachinePart.brushedGold);
  const polished = is(MachinePart.polishedGold);
  const velvet = is(MachinePart.velvet);
  const ivory = is(MachinePart.ivory);
  const slot = is(MachinePart.slot);
  const guilloche = is(MachinePart.guilloche);
  const lamp = is(MachinePart.lamp);

  const st = uv();
  const streak = hash(floor(st.y.mul(1800)).add(floor(st.x.mul(3)).mul(7919)));
  const flake = hash(floor(positionLocal.mul(5200)).dot(vec3(1, 57, 113)));

  const gold = linear(rivieraTokens['gold-brushed']);
  const polishedGold = linear('#E2BE52');
  const plate = st.mul(2).sub(1);
  const r = length(plate);
  const turned = cos(r.mul(150)).mul(0.5).add(0.5);
  const sunburst = cos(atan(plate.y, plate.x).mul(48).add(r.mul(18)))
    .mul(0.5)
    .add(0.5);
  const engraving = mix(turned, sunburst, smoothstep(0.42, 0.5, r));
  const centre = smoothstep(0.32, 0.3, r);

  const facing = saturate(dot(normalView, positionViewDirection));
  const fresnel = pow(float(1).sub(facing), 5);

  const color = linear(rivieraTokens['navy-lacquer'])
    .mul(float(0.92).add(flake.mul(0.16)))
    .mul(lacquer)
    .add(gold.mul(float(0.88).add(streak.mul(0.12))).mul(brushed))
    .add(polishedGold.mul(polished))
    .add(linear(rivieraTones.velvet).mul(velvet))
    .add(linear(rivieraTokens.ivory).mul(0.6).mul(ivory))
    .add(vec3(0.012, 0.011, 0.014).mul(slot))
    .add(gold.mul(float(0.6).add(engraving.mul(0.2))).mul(guilloche))
    .add(linear(rivieraTokens.champagne).mul(0.55).mul(lamp));

  const metalness = lacquer.mul(0.28).add(brushed).add(polished).add(guilloche).add(lamp.mul(0.2));
  const roughness = lacquer
    .mul(float(0.3).add(flake.mul(0.08)))
    .add(brushed.mul(float(0.25).add(streak.mul(0.1))))
    .add(polished.mul(0.14))
    .add(velvet.mul(0.95))
    .add(ivory.mul(0.3))
    .add(slot.mul(0.36))
    .add(guilloche.mul(mix(mix(float(0.3), float(0.48), engraving), float(0.2), centre)))
    .add(lamp.mul(0.18));
  const coat = lacquer.add(ivory).add(slot.mul(0.6));

  const material = new MeshPhysicalNodeMaterial();
  material.name = 'gacha/cabinet';
  material.colorNode = color;
  material.metalnessNode = clamp(metalness, 0, 1);
  material.roughnessNode = clamp(roughness, 0.05, 1);
  material.clearcoatNode = clamp(coat, 0, 1);
  material.clearcoatRoughnessNode = float(0.035);
  material.specularIntensityNode = float(1).sub(velvet.mul(0.8));
  if (high) {
    material.anisotropyNode = vec2(brushed.mul(0.78), 0);
    material.sheenNode = linear(rivieraTokens['navy-lacquer'])
      .mul(2.4)
      .add(linear(rivieraTokens['sea-glass']).mul(0.05))
      .mul(velvet);
    material.sheenRoughnessNode = float(0.5);
  }
  material.emissiveNode = linear(rivieraTones.rimWarm)
    .mul(fresnel.mul(0.07))
    .mul(lacquer)
    .add(lampColor.mul(lampLevel).mul(lamp));

  return { material, lampColor: lampColor, lampLevel: lampLevel };
}

/**
 * The globe and the chute: reflection only over a black base with an additive blend, so the
 * capsules behind read clean while the Fresnel edge, a champagne rim and two crisp softbox
 * highlights say glass. Inside faces add a fainter second reflection for the globe's depth.
 */
export function createGlassMaterial(): MeshPhysicalNodeMaterial {
  const material = new MeshPhysicalNodeMaterial({
    name: 'gacha/glass',
    color: new Color('#000000'),
    metalness: 0,
    roughness: 0.035,
    specularIntensity: 0.55,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
  });
  const n = normalView;
  const facing = abs(dot(n, positionViewDirection));
  const edge = pow(float(1).sub(facing), 3.2);
  const softbox = pow(saturate(dot(n, normalize(vec3(-0.42, 0.52, 0.74)))), 260);
  const kicker = pow(saturate(dot(n, normalize(vec3(0.62, 0.22, 0.75)))), 520);
  const inside = select(frontFacing, float(1), float(0.25));
  material.emissiveNode = linear(rivieraTokens.champagne)
    .mul(edge.mul(0.09))
    .add(vec3(1, 0.97, 0.92).mul(softbox.mul(1.4).add(kicker.mul(0.7))))
    .mul(inside);
  return material;
}

export interface CapsuleMaterial {
  readonly material: MeshPhysicalNodeMaterial;
  /** Shell colour, linear; the pile reads its own per instance instead. */
  readonly tint: { value: Color };
  /** 1 swaps the tint for the animated heirloom gradient. */
  readonly heirloom: { value: number };
  /** Rarity light leaking out of the seam as the capsule twists. */
  readonly seamGlow: { value: number };
  /** Rarity light from inside the opened shells. */
  readonly innerGlow: { value: number };
  readonly opacity: { value: number };
  /** Seconds, for the heirloom gradient's drift. */
  readonly time: { value: number };
}

/**
 * A capsule: a candy-coloured dome deep in its own colour with a soft inner glow where it faces
 * the eye and a mirror clearcoat, a pearl-ivory base, and a gold seam band. The pile's capsules
 * take their colour per instance; the dispensed one from `tint`, or the heirloom gradient, and
 * it leaks the rarity's light from the seam and from inside its shells when it opens.
 */
export function createCapsuleMaterial(options: { instanced: boolean }): CapsuleMaterial {
  const tint = uniform(new Color());
  const heirloom = uniform(0);
  const seamGlow = uniform(0);
  const innerGlow = uniform(0);
  const opacity = uniform(1);
  const time = uniform(0);

  const shellPart = attribute('capsuleShell', 'float');
  const dome = smoothstep(0.75, 1, shellPart);
  const seam = float(1).sub(clamp(abs(shellPart.sub(CapsuleShell.seam)).mul(4), 0, 1));
  const base = float(1).sub(dome).sub(seam);
  const around = atan(positionLocal.x, positionLocal.z).div(Math.PI * 2);
  const shellTint: V3 = options.instanced
    ? attribute('capsuleTint', 'vec3')
    : mix(tint, prism(around.add(time.mul(0.12))), heirloom);

  const facing = saturate(dot(normalView, positionViewDirection));
  const outside = select(frontFacing, float(1), float(0));
  const deep = pow(shellTint, vec3(1.3));
  const candy = deep.mul(float(0.5).add(facing.mul(0.38)));
  const pearl = mix(linear(rivieraTokens.ivory), deep.mul(0.7), 0.5).mul(
    float(0.34).add(facing.mul(0.1)),
  );
  const gold = linear(rivieraTokens['gold-brushed']);
  const insideShell = shellTint.mul(0.22);
  const shellColor = mix(insideShell, candy, outside);

  const material = new MeshPhysicalNodeMaterial({
    name: options.instanced ? 'gacha/capsule-pile' : 'gacha/capsule',
    side: options.instanced ? FrontSide : DoubleSide,
    transparent: !options.instanced,
  });
  material.colorNode = shellColor
    .mul(dome)
    .add(mix(pearl.mul(0.6), pearl, outside).mul(base))
    .add(gold.mul(seam));
  material.metalnessNode = seam;
  material.roughnessNode = dome.mul(0.07).add(base.mul(0.28)).add(seam.mul(0.22));
  material.clearcoatNode = dome.add(base.mul(0.6)).mul(outside);
  material.clearcoatRoughnessNode = float(0.03);

  const subsurface = deep.mul(pow(facing, 2).mul(0.12)).mul(dome).mul(outside);
  const nearSeam = float(1).sub(
    smoothstep(0, GACHA.capsuleRadius * 0.45, abs(positionLocal.y.add(GACHA.capsuleRadius * 0.03))),
  );
  const leak = shellTint.mul(seamGlow.mul(nearSeam).mul(2.2));
  const lit = shellTint.mul(innerGlow.mul(float(1).sub(outside)).mul(float(1).add(dome)));
  material.emissiveNode = subsurface.add(leak).add(lit);
  if (!options.instanced) material.opacityNode = opacity;

  return { material, tint, heirloom, seamGlow, innerGlow, opacity, time };
}

export interface GlowMaterial {
  readonly material: SpriteNodeMaterial;
  readonly color: { value: Color };
  readonly intensity: { value: number };
  /** Shockwave ring radius, 0 to 1 of the sprite; it fades as it grows. */
  readonly ring: { value: number };
  readonly rays: { value: number };
  /** Ray rotation, radians. */
  readonly spin: { value: number };
  readonly heirloom: { value: number };
  readonly time: { value: number };
}

/**
 * The pop's light, one additive billboard: a hot white-gold core, a soft rarity bloom, slowly
 * turning god-rays, an anamorphic streak and a shockwave ring, all from the quad's UVs, so the
 * whole burst costs one draw and no particles.
 */
export function createGlowMaterial(): GlowMaterial {
  const color = uniform(new Color());
  const intensity = uniform(0);
  const ring = uniform(0);
  const rays = uniform(0);
  const spin = uniform(0);
  const heirloom = uniform(0);
  const time = uniform(0);

  const p = uv().mul(2).sub(1);
  const r = length(p);
  const a = atan(p.y, p.x);
  const falloff = saturate(float(1).sub(r));
  const core = pow(falloff, 2.6);
  const hot = pow(saturate(float(1).sub(r.mul(2.2))), 4);
  const fan = pow(abs(cos(a.mul(5).add(spin))), 22)
    .add(pow(abs(cos(a.mul(8).sub(spin.mul(0.7)))), 40).mul(0.55))
    .mul(pow(falloff, 1.3))
    .mul(rays);
  const streak = exp(abs(p.y).mul(-60))
    .mul(pow(saturate(float(1).sub(abs(p.x))), 2))
    .mul(0.5);
  const ringMask = float(1)
    .sub(smoothstep(0, 0.05, abs(r.sub(ring.mul(0.92)))))
    .mul(float(1).sub(ring))
    .mul(smoothstep(0, 0.05, ring));
  const hue = mix(color, prism(a.div(Math.PI * 2).add(time.mul(0.18))), heirloom);
  const rgb = hue
    .mul(core.mul(0.55).add(fan).add(ringMask.mul(1.3)).add(streak))
    .add(vec3(1, 0.96, 0.86).mul(hot.mul(1.2)))
    .mul(intensity)
    .mul(float(1).sub(smoothstep(0.86, 1, r)));

  const material = new SpriteNodeMaterial({
    name: 'gacha/glow',
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  material.colorNode = vec4(max(rgb, vec3(0)), 1);
  return { material, color, intensity, ring, rays, spin, heirloom, time };
}

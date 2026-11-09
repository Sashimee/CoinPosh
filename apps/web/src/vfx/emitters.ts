import type { CascadeTier, CoinTier } from '@coinposh/shared';
import { CASCADE_TIERS } from '@coinposh/shared';
import type { Rng } from '../audio/rng.ts';
import type { QualityTier } from '../scene/quality/tiers.ts';
import { lerp } from './easing.ts';
import {
  CASCADE_COLORS,
  CONFETTI_COLORS,
  HEIRLOOM_PRISM,
  VFX_COLORS,
  mixLinear,
  tierMetal,
  toLinear,
  type LinearRgb,
} from './palette.ts';
import { ParticleKind, type ParticleKindId, type ParticleSpawn } from './particles/layout.ts';

export type Vec3 = readonly [number, number, number];
export type Emit = (spawn: ParticleSpawn) => void;

export interface EmitContext {
  readonly rng: Rng;
  readonly quality: QualityTier;
  readonly reducedMotion: boolean;
  readonly emit: Emit;
}

/** Share of each recipe's particle count a tier can afford. */
export const QUALITY_PARTICLE_SCALE: Readonly<Record<QualityTier, number>> = {
  high: 1,
  medium: 0.7,
  low: 0.4,
};

export const CONFETTI_COUNT: Readonly<Record<QualityTier, number>> = {
  high: 900,
  medium: 600,
  low: 320,
};

/** Reduced motion keeps roughly a third of the particles and none of the long throws. */
const REDUCED_SCALE = 0.35;

export const TRAIL_SPACING = 0.006;
export type ContactSurface = 'coin' | 'wood' | 'metal';

/** HDR multipliers: the bloom threshold sits near 0.92, so sparks at 3–6 flare. */
const HOT = 5;
const WARM = 2.6;

export function scaledCount(ctx: EmitContext, base: number): number {
  const scale = QUALITY_PARTICLE_SCALE[ctx.quality] * (ctx.reducedMotion ? REDUCED_SCALE : 1);
  return Math.max(1, Math.round(base * scale));
}

interface Particle {
  readonly at: Vec3;
  readonly velocity: Vec3;
  readonly life: number;
  readonly color: LinearRgb;
  readonly intensity: number;
  readonly size: number;
  readonly drag: number;
  readonly gravity: number;
  readonly kind: ParticleKindId;
}

function emitOne(ctx: EmitContext, p: Particle): void {
  ctx.emit({
    x: p.at[0],
    y: p.at[1],
    z: p.at[2],
    vx: p.velocity[0],
    vy: p.velocity[1],
    vz: p.velocity[2],
    life: p.life,
    r: p.color[0] * p.intensity,
    g: p.color[1] * p.intensity,
    b: p.color[2] * p.intensity,
    size: p.size,
    drag: p.drag,
    gravity: p.gravity,
    kind: p.kind,
    seed: ctx.rng(),
  });
}

function range(rng: Rng, min: number, max: number): number {
  return min + (max - min) * rng();
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new RangeError('pick needs a non-empty list');
  return item;
}

/** A uniformly random unit vector, optionally folded into the hemisphere around `normal`. */
function direction(rng: Rng, normal?: Vec3): Vec3 {
  const z = rng() * 2 - 1;
  const a = rng() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  const d: Vec3 = [r * Math.cos(a), z, r * Math.sin(a)];
  if (!normal) return d;
  const dot = d[0] * normal[0] + d[1] * normal[1] + d[2] * normal[2];
  return dot >= 0
    ? d
    : [d[0] - 2 * dot * normal[0], d[1] - 2 * dot * normal[1], d[2] - 2 * dot * normal[2]];
}

function tierColor(tier: CoinTier): LinearRgb {
  return tier === 'heirloom' ? toLinear(HEIRLOOM_PRISM[0]) : toLinear(tierMetal(tier));
}

function tierAccent(rng: Rng, tier: CoinTier): LinearRgb {
  return tier === 'heirloom' ? toLinear(pick(rng, HEIRLOOM_PRISM)) : tierColor(tier);
}

/**
 * Lays trail particles every `TRAIL_SPACING` metres from `from` to `to`, so the streak is
 * as dense at 20 fps as at 120. Returns the distance carried into the next segment.
 */
export function dropTrail(
  ctx: EmitContext,
  from: Vec3,
  to: Vec3,
  tier: CoinTier,
  carry: number,
): number {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const length = Math.hypot(dx, dy, dz);
  const spacing =
    TRAIL_SPACING / QUALITY_PARTICLE_SCALE[ctx.quality] / (ctx.reducedMotion ? REDUCED_SCALE : 1);
  let travelled = spacing - carry;
  const base = tierColor(tier);
  const core = mixLinear(base, toLinear(VFX_COLORS.whiteGold), 0.45);
  while (travelled <= length + 1e-9) {
    const k = length === 0 ? 0 : travelled / length;
    const at: Vec3 = [from[0] + dx * k, from[1] + dy * k, from[2] + dz * k];
    const jitter = direction(ctx.rng);
    emitOne(ctx, {
      at,
      velocity: ctx.reducedMotion
        ? [0, 0, 0]
        : [jitter[0] * 0.05, jitter[1] * 0.05 + 0.04, jitter[2] * 0.05],
      life: range(ctx.rng, 0.16, 0.26),
      color: ctx.reducedMotion ? base : core,
      intensity: WARM,
      size: range(ctx.rng, 0.0035, 0.005),
      drag: 6,
      gravity: 0.04,
      kind: ctx.reducedMotion ? ParticleKind.Mote : ParticleKind.Spark,
    });
    if (!ctx.reducedMotion && ctx.rng() < 0.18) {
      emitOne(ctx, {
        at,
        velocity: [jitter[0] * 0.12, jitter[1] * 0.12, jitter[2] * 0.12],
        life: range(ctx.rng, 0.3, 0.5),
        color: tierAccent(ctx.rng, tier),
        intensity: HOT,
        size: range(ctx.rng, 0.006, 0.01),
        drag: 4,
        gravity: 0.02,
        kind: ParticleKind.Glint,
      });
    }
    travelled += spacing;
  }
  return length - (travelled - spacing);
}

/** The spin-in at the aim cursor: glints swirl inwards around the coin as it appears. */
export function dropSwirl(ctx: EmitContext, at: Vec3, tier: CoinTier): void {
  const count = scaledCount(ctx, 14);
  const radius = 0.034;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + ctx.rng() * 0.4;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const lift = range(ctx.rng, -0.01, 0.01);
    emitOne(ctx, {
      at: [at[0] + c * radius, at[1] + lift, at[2] + s * radius],
      velocity: ctx.reducedMotion ? [0, 0, 0] : [-s * 0.42 - c * 0.18, 0.05, c * 0.42 - s * 0.18],
      life: range(ctx.rng, 0.22, 0.34),
      color: tierAccent(ctx.rng, tier),
      intensity: WARM,
      size: range(ctx.rng, 0.006, 0.009),
      drag: 5,
      gravity: 0,
      kind: ctx.reducedMotion ? ParticleKind.Mote : ParticleKind.Glint,
    });
  }
}

/**
 * Sparks thrown off a hit. `strength` in [0, 1] maps to count and speed by its square, so
 * the feathery taps of a settling pile stay quiet and a real drop crackles.
 */
export function contactSparks(
  ctx: EmitContext,
  at: Vec3,
  strength: number,
  surface: ContactSurface,
  normal: Vec3 = [0, 1, 0],
): void {
  if (!Number.isFinite(strength) || strength < 0) {
    throw new RangeError(`contactSparks needs a finite strength >= 0, got ${strength}`);
  }
  const s = Math.min(1, strength);
  const energy = s * s;
  const count = scaledCount(ctx, lerp(3, 26, energy));
  const speed = lerp(0.35, 1.5, energy) * (ctx.reducedMotion ? 0.35 : 1);
  const hot = toLinear(VFX_COLORS.whiteGold);
  const gold = toLinear(surface === 'metal' ? VFX_COLORS.champagne : VFX_COLORS.gold);
  for (let i = 0; i < count; i++) {
    const d = direction(ctx.rng, normal);
    const v = speed * range(ctx.rng, 0.4, 1);
    emitOne(ctx, {
      at,
      velocity: [d[0] * v, d[1] * v * 0.8 + 0.15 * speed, d[2] * v],
      life: range(ctx.rng, 0.18, 0.42),
      color: mixLinear(hot, gold, ctx.rng()),
      intensity: HOT * lerp(0.6, 1, s),
      size: range(ctx.rng, 0.0025, 0.0045),
      drag: 2.2,
      gravity: 0.9,
      kind: ctx.reducedMotion ? ParticleKind.Glint : ParticleKind.Spark,
    });
  }
  if (surface === 'wood') {
    const dust = scaledCount(ctx, lerp(2, 10, s));
    const teak = mixLinear(toLinear(VFX_COLORS.teak), toLinear(VFX_COLORS.champagne), 0.4);
    for (let i = 0; i < dust; i++) {
      const d = direction(ctx.rng, normal);
      emitOne(ctx, {
        at,
        velocity: [d[0] * 0.12, d[1] * 0.08 + 0.03, d[2] * 0.12],
        life: range(ctx.rng, 0.5, 0.9),
        color: teak,
        intensity: 1.1,
        size: range(ctx.rng, 0.004, 0.008),
        drag: 3,
        gravity: 0.05,
        kind: ParticleKind.Mote,
      });
    }
  }
}

/**
 * Fusion implosion: each source coin sheds a cloud of streaks that spiral into the
 * fusion point, pulled by attractor `slot`. They die on arrival, so the cloud visibly
 * collapses into the flash.
 */
export function fusionImplosion(
  ctx: EmitContext,
  sources: readonly Vec3[],
  center: Vec3,
  slot: number,
  tier: CoinTier,
): void {
  const perSource = scaledCount(ctx, 70);
  const hot = toLinear(VFX_COLORS.whiteGold);
  for (const source of sources) {
    const ox = source[0] - center[0];
    const oz = source[2] - center[2];
    const reach = Math.hypot(ox, oz) || 1;
    const tx = -oz / reach;
    const tz = ox / reach;
    for (let i = 0; i < perSource; i++) {
      const d = direction(ctx.rng);
      const r = range(ctx.rng, 0.004, 0.02);
      const swirl = ctx.reducedMotion ? 0 : range(ctx.rng, 0.5, 1.1);
      emitOne(ctx, {
        at: [source[0] + d[0] * r, source[1] + Math.abs(d[1]) * r, source[2] + d[2] * r],
        velocity: [tx * swirl + d[0] * 0.2, range(ctx.rng, 0.1, 0.5), tz * swirl + d[2] * 0.2],
        life: range(ctx.rng, 0.5, 0.7),
        color: mixLinear(tierAccent(ctx.rng, tier), hot, range(ctx.rng, 0.2, 0.7)),
        intensity: HOT,
        size: range(ctx.rng, 0.0025, 0.004),
        drag: ctx.reducedMotion ? 10 : 0,
        gravity: slot,
        kind: ParticleKind.Homing,
      });
    }
  }
}

/** The burst at the moment of fusion: a corona of sparks and big slow glints. */
export function fusionImpact(ctx: EmitContext, at: Vec3, tier: CoinTier): void {
  const sparks = scaledCount(ctx, 90);
  const hot = toLinear(VFX_COLORS.whiteGold);
  const speed = ctx.reducedMotion ? 0.25 : 1;
  for (let i = 0; i < sparks; i++) {
    const a = ctx.rng() * Math.PI * 2;
    const up = range(ctx.rng, 0.05, 0.9);
    const v = range(ctx.rng, 0.8, 2.1) * speed;
    emitOne(ctx, {
      at,
      velocity: [Math.cos(a) * v, up * v, Math.sin(a) * v],
      life: range(ctx.rng, 0.3, 0.7),
      color: mixLinear(hot, tierAccent(ctx.rng, tier), ctx.rng() * 0.7),
      intensity: HOT,
      size: range(ctx.rng, 0.003, 0.005),
      drag: 2.6,
      gravity: 0.7,
      kind: ctx.reducedMotion ? ParticleKind.Glint : ParticleKind.Spark,
    });
  }
  const glints = scaledCount(ctx, 16);
  for (let i = 0; i < glints; i++) {
    const d = direction(ctx.rng, [0, 1, 0]);
    emitOne(ctx, {
      at: [at[0] + d[0] * 0.02, at[1] + d[1] * 0.02 + 0.005, at[2] + d[2] * 0.02],
      velocity: [d[0] * 0.25 * speed, d[1] * 0.35 * speed, d[2] * 0.25 * speed],
      life: range(ctx.rng, 0.6, 1.1),
      color: tierAccent(ctx.rng, tier),
      intensity: HOT,
      size: range(ctx.rng, 0.012, 0.022),
      drag: 3,
      gravity: 0.05,
      kind: ParticleKind.Glint,
    });
  }
}

/** Champagne fizz rising off the table; denser and warmer with each Cascade tier. */
export function cascadeFizz(ctx: EmitContext, at: Vec3, tier: CascadeTier, spread: number): void {
  const level = CASCADE_TIERS.indexOf(tier);
  if (level < 0) throw new RangeError(`Unknown cascade tier "${tier}"`);
  const colors = CASCADE_COLORS[tier].map(toLinear);
  const count = scaledCount(ctx, 26 + level * 38);
  for (let i = 0; i < count; i++) {
    const x = at[0] + range(ctx.rng, -spread, spread);
    const z = at[2] + range(ctx.rng, -spread * 0.6, spread * 0.6);
    const rise = ctx.reducedMotion ? 0.04 : range(ctx.rng, 0.15, 0.45 + level * 0.12);
    emitOne(ctx, {
      at: [x, at[1] + range(ctx.rng, 0, 0.02), z],
      velocity: [range(ctx.rng, -0.03, 0.03), rise, range(ctx.rng, -0.03, 0.03)],
      life: range(ctx.rng, 0.7, 1.3),
      color: pick(ctx.rng, colors),
      intensity: WARM * 0.7 + level * 0.45,
      size: range(ctx.rng, 0.0022, 0.0042 + level * 0.0009),
      drag: 1.4,
      gravity: -0.012,
      kind: ctx.rng() < 0.1 + level * 0.07 ? ParticleKind.Glint : ParticleKind.Mote,
    });
  }
}

/** The camera's frame in world space, for effects that fill the view rather than the table. */
export interface ViewFrame {
  readonly origin: Vec3;
  readonly right: Vec3;
  readonly up: Vec3;
  readonly forward: Vec3;
  /** tan(vertical fov / 2) and the aspect ratio, so the volume matches the frustum. */
  readonly tanHalfFov: number;
  readonly aspect: number;
}

function inView(frame: ViewFrame, sx: number, sy: number, depth: number): Vec3 {
  const h = frame.tanHalfFov * depth;
  const w = h * frame.aspect;
  const { origin: o, right: r, up: u, forward: f } = frame;
  return [
    o[0] + f[0] * depth + r[0] * sx * w + u[0] * sy * h,
    o[1] + f[1] * depth + r[1] * sx * w + u[1] * sy * h,
    o[2] + f[2] * depth + r[2] * sx * w + u[2] * sy * h,
  ];
}

/**
 * OBSCENE confetti: a curtain of foil falling through the whole view, plus two cannons
 * firing up and in from the lower corners. Pieces are sized by depth so near and far
 * read as one shower. Reduced motion drops the cannons and lets a lighter fall drift.
 */
export function confetti(ctx: EmitContext, frame: ViewFrame): number {
  const total = Math.round(CONFETTI_COUNT[ctx.quality] * (ctx.reducedMotion ? REDUCED_SCALE : 1));
  const curtain = ctx.reducedMotion ? total : Math.round(total * 0.6);
  const colors = CONFETTI_COLORS.map(toLinear);
  const prism = HEIRLOOM_PRISM.map(toLinear);
  const color = (): LinearRgb => (ctx.rng() < 0.08 ? pick(ctx.rng, prism) : pick(ctx.rng, colors));
  for (let i = 0; i < curtain; i++) {
    const depth = range(ctx.rng, 0.35, 1.1);
    const at = inView(frame, range(ctx.rng, -1.1, 1.1), range(ctx.rng, 1.05, 2.6), depth);
    emitOne(ctx, {
      at,
      velocity: [
        range(ctx.rng, -0.08, 0.08),
        -range(ctx.rng, 0.15, 0.4),
        range(ctx.rng, -0.08, 0.08),
      ],
      life: range(ctx.rng, 3.2, 4.2),
      color: color(),
      intensity: 1,
      size: 0.012 * depth * range(ctx.rng, 0.8, 1.2),
      drag: 1.3,
      gravity: ctx.reducedMotion ? 0.03 : 0.06,
      kind: ParticleKind.Confetti,
    });
  }
  const cannon = total - curtain;
  for (let i = 0; i < cannon; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const depth = range(ctx.rng, 0.45, 0.75);
    const at = inView(frame, side * 1.05, -1.05, depth);
    const { right: r, up: u, forward: f } = frame;
    const inward = -side * range(ctx.rng, 0.5, 1.1);
    const lift = range(ctx.rng, 2.2, 3.4);
    const push = range(ctx.rng, -0.3, 0.4);
    emitOne(ctx, {
      at,
      velocity: [
        r[0] * inward + u[0] * lift + f[0] * push,
        r[1] * inward + u[1] * lift + f[1] * push,
        r[2] * inward + u[2] * lift + f[2] * push,
      ],
      life: range(ctx.rng, 3.2, 4.2),
      color: color(),
      intensity: 1,
      size: 0.012 * depth * range(ctx.rng, 0.8, 1.2),
      drag: 1.7,
      gravity: 0.32,
      kind: ParticleKind.Confetti,
    });
  }
  return total;
}

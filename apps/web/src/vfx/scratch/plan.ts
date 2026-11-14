import { RARITIES, SCRATCH_GRID_SIZE, type Rarity } from '@coinposh/shared';
import type { HapticPattern } from '../../app/feedback.ts';
import type { DuckOptions, ImpactEvent } from '../../audio/index.ts';
import {
  clamp01,
  easeInBack,
  easeInOutCubic,
  easeOutBack,
  easeOutCubic,
  progress,
} from '../easing.ts';
import { HAPTIC_PATTERNS } from '../haptics.ts';
import type { JuiceItem } from '../juice.ts';
import { ParticleKind, type ParticleSpawn } from '../particles/layout.ts';
import { HEIRLOOM_PRISM, RARITY_COLORS, toLinear, VFX_COLORS, type LinearRgb } from '../palette.ts';
import { BRUSH_RADIUS, cellCentre, cellRect, type ScratchPoint } from './mask.ts';

/** Every duration of the card, in ms. The reduced variant fades where the full one moves. */
export interface ScratchTimeline {
  readonly reduced: boolean;
  /** The card rises into place when the overlay opens. */
  readonly enterMs: number;
  /** The anticipation dip and lift while the house seals the card. */
  readonly liftMs: number;
  /** The rest of the foil dissolves (or fades) once enough is scratched. */
  readonly clearMs: number;
  /** The freeze on the frame the match lands. */
  readonly hitStopMs: number;
  /** Each matched gem flares this long after the one before it. */
  readonly flareStaggerMs: number;
  readonly flareMs: number;
  /** From the match to the first prize line. */
  readonly linesAtMs: number;
  readonly lineStaggerMs: number;
  /** A currency prize counts up from zero this long. */
  readonly countMs: number;
  /** From the match until COLLECT is offered. */
  readonly settleMs: number;
  readonly flyMs: number;
  /** The "Reveal all" brush sweep; 0 fades the foil instead. */
  readonly autoRevealMs: number;
  /** One cell scratched from the keyboard; 0 clears it at once. */
  readonly cellSweepMs: number;
  /** Foil flakes per brush stamp, and the most a single frame may throw. */
  readonly flakesPerStamp: number;
  readonly flakeFrameBudget: number;
  /** Glints thrown off each matched gem. */
  readonly matchGlints: number;
  /** Max card tilt toward the finger, in degrees. */
  readonly tiltDeg: number;
}

export const FULL_SCRATCH: ScratchTimeline = {
  reduced: false,
  enterMs: 560,
  liftMs: 360,
  clearMs: 620,
  hitStopMs: 70,
  flareStaggerMs: 120,
  flareMs: 860,
  linesAtMs: 720,
  lineStaggerMs: 110,
  countMs: 900,
  settleMs: 1_350,
  flyMs: 640,
  autoRevealMs: 1_700,
  cellSweepMs: 420,
  flakesPerStamp: 2,
  flakeFrameBudget: 40,
  matchGlints: 16,
  tiltDeg: 5,
};

export const REDUCED_SCRATCH: ScratchTimeline = {
  reduced: true,
  enterMs: 200,
  liftMs: 0,
  clearMs: 360,
  hitStopMs: 0,
  flareStaggerMs: 0,
  flareMs: 260,
  linesAtMs: 240,
  lineStaggerMs: 0,
  countMs: 0,
  settleMs: 420,
  flyMs: 260,
  autoRevealMs: 0,
  cellSweepMs: 0,
  flakesPerStamp: 0,
  flakeFrameBudget: 0,
  matchGlints: 0,
  tiltDeg: 0,
};

export function scratchTimeline(reducedMotion: boolean): ScratchTimeline {
  return reducedMotion ? REDUCED_SCRATCH : FULL_SCRATCH;
}

/** The three gems the server's roll paid out, in grid order. */
export interface ScratchMatch {
  readonly rarity: Rarity;
  readonly cells: readonly [number, number, number];
}

/**
 * Finds the match in the server's grid. The contract is that three of the roll's rarity sit in
 * the grid; anything else is a broken server answer, refused rather than painted.
 */
export function scratchMatch(grid: readonly Rarity[], rarity: Rarity): ScratchMatch {
  if (grid.length !== SCRATCH_GRID_SIZE) {
    throw new RangeError(
      `The server sent a scratch grid of ${grid.length} gems, not ${SCRATCH_GRID_SIZE}; the reveal contract is broken`,
    );
  }
  const cells: number[] = [];
  grid.forEach((gem, index) => {
    if (gem === rarity) cells.push(index);
  });
  const [a, b, c] = cells;
  if (a === undefined || b === undefined || c === undefined) {
    throw new RangeError(
      `The server rolled ${rarity} but its scratch grid holds ${cells.length} ${rarity} gems, not three; the reveal contract is broken`,
    );
  }
  return { rarity, cells: [a, b, c] };
}

/** Uncovered gems that share their rarity with another uncovered gem: the "two of a kind" tease. */
export function pairedCells(grid: readonly Rarity[], uncovered: readonly number[]): number[] {
  const byRarity = new Map<Rarity, number[]>();
  for (const index of uncovered) {
    const gem = grid[index];
    if (gem === undefined) continue;
    const list = byRarity.get(gem) ?? [];
    list.push(index);
    byRarity.set(gem, list);
  }
  return [...byRarity.values()]
    .filter((cells) => cells.length >= 2)
    .flat()
    .sort((a, b) => a - b);
}

function rank(rarity: Rarity): number {
  return RARITIES.indexOf(rarity);
}

export interface CardPose {
  readonly scale: number;
  readonly rise: number;
  readonly opacity: number;
  readonly tilt: number;
}

/** The card's entrance: up from below with a little overshoot, or a plain fade. */
export function enterPose(ms: number, timeline: ScratchTimeline): CardPose {
  const t = timeline.enterMs === 0 ? 1 : clamp01(ms / timeline.enterMs);
  if (timeline.reduced) return { scale: 1, rise: 0, opacity: t, tilt: 0 };
  const lift = easeOutBack(1.4)(t);
  return { scale: 0.86 + 0.14 * lift, rise: (1 - lift) * 56, opacity: easeOutCubic(t), tilt: 0 };
}

/**
 * While the house seals the card: it dips (anticipation), lifts and tips toward the player,
 * then holds a gentle breathing bob until the answer lands.
 */
export function sealingPose(ms: number, timeline: ScratchTimeline): CardPose {
  if (timeline.reduced || timeline.liftMs === 0) return { scale: 1, rise: 0, opacity: 1, tilt: 0 };
  const t = clamp01(ms / timeline.liftMs);
  const swing = easeInBack(2.2)(t);
  const bob = ms > timeline.liftMs ? Math.sin(((ms - timeline.liftMs) / 900) * Math.PI * 2) : 0;
  return { scale: 1 + 0.035 * swing, rise: -8 * swing + 2 * bob, opacity: 1, tilt: 4 * swing };
}

export interface FlarePose {
  readonly scale: number;
  readonly glow: number;
}

/** A matched gem's flare: it swells past size, settles, and keeps a glow. `order` is 0..2. */
export function flarePose(ms: number, order: number, timeline: ScratchTimeline): FlarePose {
  const start = order * timeline.flareStaggerMs;
  const t = timeline.flareMs === 0 ? 1 : clamp01((ms - start) / timeline.flareMs);
  if (timeline.reduced) return { scale: 1, glow: t };
  const swell = t < 0.35 ? easeOutBack(2.6)(t / 0.35) : 1;
  const settle = t < 0.35 ? 0 : easeOutCubic((t - 0.35) / 0.65);
  return { scale: 1 + 0.32 * swell - 0.2 * settle, glow: Math.min(1, t * 2.5) - 0.35 * settle };
}

export interface LinePose {
  readonly shown: number;
  readonly scale: number;
  readonly rise: number;
}

export function prizeLinePose(ms: number, index: number, timeline: ScratchTimeline): LinePose {
  const start = timeline.linesAtMs + index * timeline.lineStaggerMs;
  if (timeline.reduced) {
    return { shown: ms >= start ? clamp01((ms - start) / 160) : 0, scale: 1, rise: 0 };
  }
  const t = clamp01((ms - start) / 420);
  return { shown: easeOutCubic(t), scale: 0.7 + 0.3 * easeOutBack(2.2)(t), rise: (1 - t) * 18 };
}

/** The share of a currency prize shown while it counts up on the card, 0..1. */
export function prizeCount(ms: number, index: number, timeline: ScratchTimeline): number {
  if (timeline.countMs === 0) return 1;
  const start = timeline.linesAtMs + index * timeline.lineStaggerMs;
  return easeOutCubic(clamp01((ms - start) / timeline.countMs));
}

export interface FlyPose {
  readonly travel: number;
  readonly scale: number;
  readonly fade: number;
}

/** Collect: the prizes arc into the HUD and the card falls away under them. */
export function flyPose(ms: number, timeline: ScratchTimeline): FlyPose {
  const t = timeline.flyMs === 0 ? 1 : clamp01(ms / timeline.flyMs);
  if (timeline.reduced) return { travel: 0, scale: 1, fade: 1 - t };
  return {
    travel: easeInOutCubic(t),
    scale: 1 - 0.55 * easeInOutCubic(t),
    fade: 1 - easeOutCubic(progress(t, 0.45, 1)),
  };
}

/** The dissolve (full) or fade (reduced) of whatever foil is left, 0..1. */
export function clearAmount(ms: number, timeline: ScratchTimeline): number {
  if (timeline.clearMs === 0) return 1;
  const t = clamp01(ms / timeline.clearMs);
  return timeline.reduced ? t : easeInOutCubic(t);
}

/** The brush the "Reveal all" sweep and the keyboard use: wider than a finger. */
export const SWEEP_RADIUS = BRUSH_RADIUS * 1.6;
const AUTO_PASSES = 6;

/** "Reveal all": a zigzag across the window, row by row, as the brush runs over it. */
export function autoRevealPath(): readonly ScratchPoint[] {
  const points: ScratchPoint[] = [];
  for (let pass = 0; pass < AUTO_PASSES; pass++) {
    const y = 0.08 + (pass * 0.84) / (AUTO_PASSES - 1);
    const leftToRight = pass % 2 === 0;
    points.push({ x: leftToRight ? 0.04 : 0.96, y }, { x: leftToRight ? 0.96 : 0.04, y });
  }
  return points;
}

/** A small zigzag over one cell, for scratching it from the keyboard. */
export function cellSweepPath(index: number): readonly ScratchPoint[] {
  const rect = cellRect(index);
  const inset = SWEEP_RADIUS * 0.45;
  const left = rect.x0 + inset;
  const right = rect.x1 - inset;
  const top = rect.y0 + inset;
  const bottom = rect.y1 - inset;
  const middle = (top + bottom) / 2;
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: left, y: middle },
    { x: right, y: middle },
    { x: left, y: bottom },
    { x: right, y: bottom },
  ];
}

/** The point `t` (0..1) of the way along a polyline, by length. */
export function pathPoint(path: readonly ScratchPoint[], t: number): ScratchPoint {
  const first = path[0];
  if (first === undefined) throw new RangeError('pathPoint needs at least one point');
  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] ?? first;
    const b = path[i] ?? first;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    lengths.push(length);
    total += length;
  }
  if (total === 0) return first;
  let remaining = clamp01(t) * total;
  for (let i = 1; i < path.length; i++) {
    const length = lengths[i - 1] ?? 0;
    const a = path[i - 1] ?? first;
    const b = path[i] ?? first;
    if (remaining <= length || i === path.length - 1) {
      const local = length === 0 ? 1 : Math.min(1, remaining / length);
      return { x: a.x + (b.x - a.x) * local, y: a.y + (b.y - a.y) * local };
    }
    remaining -= length;
  }
  return path[path.length - 1] ?? first;
}

/** The sweep's pace: a slow wind-up, a fast middle and a gentle finish. */
export function sweepProgress(ms: number, durationMs: number): number {
  return durationMs === 0 ? 1 : easeInOutCubic(clamp01(ms / durationMs));
}

export interface ScratchCue {
  readonly sounds: readonly ImpactEvent[];
  readonly haptic: HapticPattern | null;
}

export type ScratchCueKind =
  'open' | 'seal' | 'live' | 'uncover' | 'pair' | 'clear' | 'match' | 'collect' | 'deny';

/**
 * The sounds and haptic of each moment. Uncovers ring a little higher with each gem found, the
 * match stacks a chord that grows with the rarity, and the engine pitch-varies every hit.
 */
export function scratchCue(kind: ScratchCueKind, rarity: Rarity | null, step = 0): ScratchCue {
  const weight = rarity === null ? 0 : rank(rarity);
  switch (kind) {
    case 'open':
      return { sounds: [{ material: 'wood', velocity: 0.9 }], haptic: HAPTIC_PATTERNS.tap };
    case 'seal':
      return {
        sounds: [
          { material: 'metal', velocity: 0.55 },
          { material: 'coin', velocity: 0.4, pan: 0.2 },
        ],
        haptic: HAPTIC_PATTERNS.tick,
      };
    case 'live':
      return { sounds: [{ material: 'metal', velocity: 0.35 }], haptic: null };
    case 'uncover':
      return {
        sounds: [{ material: 'coin', velocity: 0.45 + weight * 0.12 + step * 0.04, pan: 0 }],
        haptic: HAPTIC_PATTERNS.tick,
      };
    case 'pair':
      return {
        sounds: [
          { material: 'coin', velocity: 0.7 + weight * 0.1, pan: -0.25 },
          { material: 'coin', velocity: 0.75 + weight * 0.1, pan: 0.25 },
        ],
        haptic: HAPTIC_PATTERNS.tap,
      };
    case 'clear':
      return { sounds: [{ material: 'metal', velocity: 0.8 }], haptic: HAPTIC_PATTERNS.tap };
    case 'match':
      return {
        sounds: [
          { material: 'metal', velocity: 1.6 + weight * 0.2 },
          { material: 'coin', velocity: 1.3 + weight * 0.25, pan: -0.4 },
          { material: 'coin', velocity: 1.3 + weight * 0.25, pan: 0.4 },
          ...(weight >= rank('legendary') ? [{ material: 'coin' as const, velocity: 2.2 }] : []),
        ],
        haptic: weight >= rank('legendary') ? HAPTIC_PATTERNS.fanfare : HAPTIC_PATTERNS.thud,
      };
    case 'collect':
      return { sounds: [{ material: 'coin', velocity: 1.2 }], haptic: HAPTIC_PATTERNS.tap };
    case 'deny':
      return { sounds: [{ material: 'wood', velocity: 0.22 }], haptic: [10, 30, 10] };
  }
}

/** Music steps back for the match: the rarer the gems, the further. */
export function matchDuck(rarity: Rarity, seconds: number): DuckOptions {
  return { depthDb: -8 - rank(rarity) * 2.5, attack: 0.04, hold: seconds, release: 0.9 };
}

/** Normalised window travel between two scrape sounds. */
export const SCRAPE_STEP = 0.05;

/**
 * The brush's voice: a soft metallic scrape every `SCRAPE_STEP` of travel, louder the faster the
 * finger moves and panned to where it is, so a long stroke rasps and a slow one whispers.
 */
export class ScrapeVoice {
  private travelled = 0;

  /** `distance` is window travel since the last call, `speed` in windows per second. */
  advance(at: ScratchPoint, distance: number, speed: number): ImpactEvent | null {
    if (!(distance > 0)) return null;
    this.travelled += distance;
    if (this.travelled < SCRAPE_STEP) return null;
    this.travelled %= SCRAPE_STEP;
    return {
      material: 'metal',
      velocity: 0.1 + 0.3 * clamp01(speed / 4),
      pan: (clamp01(at.x) - 0.5) * 1.2,
    };
  }

  reset(): void {
    this.travelled = 0;
  }
}

/** A tiny seeded PRNG (mulberry32), so a card's flakes are the same on every replay. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** The particle world: the window is one unit square centred on the origin, y up. */
export function toWorld(point: ScratchPoint): { x: number; y: number } {
  return { x: point.x - 0.5, y: 0.5 - point.y };
}

const FOIL_FLAKE_COLORS: readonly LinearRgb[] = [
  toLinear('#D9DCE3'),
  toLinear('#C0C4CC'),
  toLinear(VFX_COLORS.champagne),
  toLinear(VFX_COLORS.gold),
  toLinear('#EEF0F4'),
];

/**
 * Foil flakes torn off by one brush stamp: they peel in the stroke's direction, kick up toward
 * the glass, tumble and drift down past the card.
 */
export function flakeSpawns(
  at: ScratchPoint,
  direction: { readonly x: number; readonly y: number },
  count: number,
  random: () => number,
): ParticleSpawn[] {
  const origin = toWorld(at);
  const length = Math.hypot(direction.x, direction.y);
  const dx = length > 0 ? direction.x / length : 0;
  const dy = length > 0 ? -direction.y / length : 0;
  const spawns: ParticleSpawn[] = [];
  for (let i = 0; i < count; i++) {
    const color = FOIL_FLAKE_COLORS[Math.floor(random() * FOIL_FLAKE_COLORS.length)] ?? [1, 1, 1];
    const spread = (random() - 0.5) * 1.1;
    const speed = 0.35 + random() * 0.55;
    const shine = 0.9 + random() * 0.6;
    spawns.push({
      x: origin.x + (random() - 0.5) * BRUSH_RADIUS,
      y: origin.y + (random() - 0.5) * BRUSH_RADIUS,
      z: 0.01,
      vx: (dx + spread * 0.8) * speed * 0.7,
      vy: (dy * 0.5 + 0.55 + random() * 0.5) * speed,
      vz: 0.25 + random() * 0.5,
      life: 0.7 + random() * 0.6,
      r: color[0] * shine,
      g: color[1] * shine,
      b: color[2] * shine,
      size: 0.012 + random() * 0.014,
      drag: 1.4 + random() * 0.8,
      gravity: 0.32,
      kind: ParticleKind.Confetti,
      seed: random(),
    });
  }
  return spawns;
}

function rarityLinear(rarity: Rarity, random: () => number): LinearRgb {
  if (rarity !== 'heirloom') return toLinear(RARITY_COLORS[rarity]);
  return toLinear(
    HEIRLOOM_PRISM[Math.floor(random() * HEIRLOOM_PRISM.length)] ?? HEIRLOOM_PRISM[0],
  );
}

/** The match flare's glints: a ring of hot sparkles in the rarity's colour around each gem. */
export function matchGlintSpawns(
  cells: readonly number[],
  rarity: Rarity,
  perCell: number,
  random: () => number,
): ParticleSpawn[] {
  const spawns: ParticleSpawn[] = [];
  for (const cell of cells) {
    const origin = toWorld(cellCentre(cell));
    for (let i = 0; i < perCell; i++) {
      const angle = (i / perCell) * Math.PI * 2 + random() * 0.4;
      const speed = 0.5 + random() * 0.7;
      const color = rarityLinear(rarity, random);
      const heat = 1.6 + random() * 1.4;
      const glint = i % 3 === 0;
      spawns.push({
        x: origin.x,
        y: origin.y,
        z: 0.02,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        vz: random() * 0.2,
        life: 0.45 + random() * 0.45,
        r: color[0] * heat,
        g: color[1] * heat,
        b: color[2] * heat,
        size: glint ? 0.03 + random() * 0.02 : 0.008 + random() * 0.008,
        drag: 3.2,
        gravity: 0.05,
        kind: glint ? ParticleKind.Glint : ParticleKind.Spark,
        seed: random(),
      });
    }
  }
  return spawns;
}

export type ScratchInteraction = 'scratch' | 'uncover' | 'revealAll' | 'match' | 'collect';

/**
 * The juice checklist per interaction (03-ART-AUDIO-JUICE, at least four each), with what the
 * reduced-motion card keeps: sound, haptics and light stay, motion and particles go.
 */
export const SCRATCH_JUICE: Readonly<
  Record<
    ScratchInteraction,
    { readonly full: readonly JuiceItem[]; readonly reduced: readonly JuiceItem[] }
  >
> = {
  scratch: {
    full: ['sound', 'hapticOrShake', 'particles', 'lightResponse', 'squashOvershoot'],
    reduced: ['sound', 'hapticOrShake', 'lightResponse'],
  },
  uncover: {
    full: ['sound', 'hapticOrShake', 'squashOvershoot', 'lightResponse'],
    reduced: ['sound', 'hapticOrShake', 'lightResponse'],
  },
  revealAll: {
    full: ['sound', 'hapticOrShake', 'particles', 'lightResponse', 'squashOvershoot'],
    reduced: ['sound', 'hapticOrShake', 'lightResponse'],
  },
  match: {
    full: [
      'sound',
      'hapticOrShake',
      'particles',
      'squashOvershoot',
      'lightResponse',
      'timeManipulation',
      'numberPop',
    ],
    reduced: ['sound', 'hapticOrShake', 'lightResponse', 'numberPop'],
  },
  collect: {
    full: ['sound', 'hapticOrShake', 'numberPop', 'squashOvershoot', 'lightResponse'],
    reduced: ['sound', 'hapticOrShake', 'numberPop', 'lightResponse'],
  },
};

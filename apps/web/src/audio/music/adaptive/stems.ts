import { CASCADE_TIERS, type CascadeTier } from '@coinposh/shared';
import { elementAt } from '../../rng.ts';
import { RIVIERA_LAYERS, type StemId } from '../layers.ts';
import type { DrumKind } from '../riviera.ts';

/**
 * The live arrangement splits the loop finer than the rendered stems: the drum kit enters
 * piece by piece and the vibes line gains an octave doubling, so every Cascade tier adds
 * something you can hear.
 */
export type AdaptivePart = 'keys' | 'bass' | 'shaker' | 'kick' | 'rim' | 'vibes' | 'sparkle';

export const ADAPTIVE_PARTS: readonly AdaptivePart[] = [
  'keys',
  'bass',
  'shaker',
  'kick',
  'rim',
  'vibes',
  'sparkle',
];

export interface PartSpec {
  readonly part: AdaptivePart;
  /** The rendered stem whose notes, level and pan the part follows. */
  readonly stem: StemId;
  readonly drum?: DrumKind;
  readonly level: number;
  readonly pan: number;
  /** Semitones added to every note. */
  readonly transpose: number;
}

function layerOf(stem: StemId): { level: number; pan: number } {
  const layer = RIVIERA_LAYERS.find((l) => l.stem === stem);
  if (!layer) throw new Error(`RIVIERA_LAYERS has no layer for stem "${stem}"`);
  return layer;
}

function partSpec(
  part: AdaptivePart,
  stem: StemId,
  extra: { drum?: DrumKind; levelScale?: number; pan?: number; transpose?: number } = {},
): PartSpec {
  const layer = layerOf(stem);
  return {
    part,
    stem,
    ...(extra.drum ? { drum: extra.drum } : {}),
    level: layer.level * (extra.levelScale ?? 1),
    pan: extra.pan ?? layer.pan,
    transpose: extra.transpose ?? 0,
  };
}

export const PART_SPECS: Readonly<Record<AdaptivePart, PartSpec>> = {
  keys: partSpec('keys', 'keys'),
  bass: partSpec('bass', 'bass'),
  shaker: partSpec('shaker', 'drums', { drum: 'shaker' }),
  kick: partSpec('kick', 'drums', { drum: 'kick' }),
  rim: partSpec('rim', 'drums', { drum: 'rim' }),
  vibes: partSpec('vibes', 'vibes'),
  /** Mirrors the vibes across the stereo field so the OBSCENE top end opens out, mono-safe. */
  sparkle: partSpec('sparkle', 'vibes', { levelScale: 0.42, pan: -0.24, transpose: 12 }),
};

/** Index 0 is the idle bed; index n is the n-th Cascade tier. Each tier adds one part. */
const TIER_PART_ORDER: readonly AdaptivePart[][] = [
  ['keys', 'bass'],
  ['shaker'],
  ['kick'],
  ['rim'],
  ['vibes'],
  ['sparkle'],
];

/** `null` is no cascade running. */
export function partsForTier(tier: CascadeTier | null): ReadonlySet<AdaptivePart> {
  const rank = tier === null ? 0 : CASCADE_TIERS.indexOf(tier) + 1;
  if (rank === 0 && tier !== null) {
    throw new RangeError(
      `Unknown Cascade tier "${tier}"; expected one of ${CASCADE_TIERS.join(', ')}`,
    );
  }
  const parts = new Set<AdaptivePart>();
  for (let i = 0; i <= rank; i++) for (const part of elementAt(TIER_PART_ORDER, i)) parts.add(part);
  return parts;
}

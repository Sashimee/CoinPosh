import { clamp } from '../rng.ts';

export type StemId = 'keys' | 'bass' | 'drums' | 'vibes';

export const STEM_IDS: readonly StemId[] = ['keys', 'bass', 'drums', 'vibes'];

export interface LayerSpec {
  readonly stem: StemId;
  /** Intensity where the layer starts to fade in. */
  readonly enterAt: number;
  /** Intensity where the layer reaches full level. */
  readonly fullAt: number;
  readonly level: number;
  readonly pan: number;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x >= edge0 ? 1 : 0;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function layerGain(layer: LayerSpec, intensity: number): number {
  return layer.level * smoothstep(layer.enterAt, layer.fullAt, clamp(intensity, 0, 1));
}

/**
 * Idle play keeps the lounge bed (keys and a walking bass). A building cascade brings in the
 * percussion, and only a big run earns the vibraphone line on top.
 */
export const RIVIERA_LAYERS: readonly LayerSpec[] = [
  { stem: 'keys', enterAt: 0, fullAt: 0, level: 0.8, pan: -0.18 },
  { stem: 'bass', enterAt: 0.08, fullAt: 0.3, level: 0.9, pan: 0 },
  { stem: 'drums', enterAt: 0.35, fullAt: 0.6, level: 0.7, pan: 0.08 },
  { stem: 'vibes', enterAt: 0.65, fullAt: 0.9, level: 0.75, pan: 0.22 },
];

export const IDLE_INTENSITY = 0.25;

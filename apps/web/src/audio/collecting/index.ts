import type { CoinVariant, CollectibleCoinVariant, PrizeFamily } from '@coinposh/shared';
import type { PumpTimer } from '../music/adaptive/player.ts';
import type { Rng } from '../rng.ts';
import { createNoiseBuffer } from '../synth/buffers.ts';
import type { SourceVoice } from '../synth/voice.ts';
import { VoicePool } from '../voicePool.ts';
import { CellarAmbience } from './cellar.ts';
import { buildPrizeImpactSpec, prizeVoiceCost } from './prizeImpact.ts';
import { buildVariantShimmerSpec, shimmerVoiceCost } from './shimmer.ts';
import { PitchVariator } from './variation.ts';
import { startPrizeVoice, startShimmerVoice } from './voices.ts';

export { PRIZE_PROFILES } from './prizeImpact.ts';
export { SHIMMER_PROFILES } from './shimmer.ts';

/**
 * The audio context and the mixer buses the collecting sounds play through, so the master,
 * music and SFX sliders and the mono fold apply to them exactly as to the coin bed.
 */
export interface CollectingAudioHost {
  readonly context: BaseAudioContext;
  readonly buses: { readonly sfx: AudioNode; readonly music: AudioNode };
}

export interface CollectingAudioOptions {
  readonly rng?: Rng;
  /** Drives the cellar's drips and clinks; defaults to setInterval. */
  readonly timer?: PumpTimer;
}

export interface CollectingAudio {
  readonly activeVoices: number;
  /** Oscillators and noise sources alive across those voices, capped by the source budget. */
  readonly activeSources: number;
  readonly cellarPlaying: boolean;
  /**
   * A prize landing on coins or the table, `speed` being the closing speed in m/s. Returns
   * false when nothing played: audio still locked, too soft, a bounce repeat, or no voice free.
   */
  playPrizeImpact(family: PrizeFamily, speed: number, pan?: number): boolean;
  /** The shimmer over a variant coin's mint or bank; 'none' is silent and returns false. */
  playVariantShimmer(variant: CoinVariant, pan?: number): boolean;
  /** Fades the looping cellar bed in on the music bus; a no-op while it already plays. */
  startCellarAmbience(): void;
  stopCellarAmbience(fadeSeconds?: number): void;
  dispose(): void;
}

/**
 * Few prizes ride the table at once; this keeps them, their shimmers and the drips bounded on
 * top of the engine's coin pool, and a tumbling prize's contacts are thinned by the retrigger.
 */
export const COLLECTING_MAX_VOICES = 8;
export const COLLECTING_SOURCE_BUDGET = 64;
/**
 * A tumbling prize reports several contacts per bounce. Inside this window only a harder
 * contact than the last one of that family plays, so a settling watch never machine-guns.
 */
export const PRIZE_RETRIGGER_SECONDS = 0.045;

const intervalTimer: PumpTimer = (ms, tick) => {
  const id = setInterval(tick, ms);
  return () => {
    clearInterval(id);
  };
};

export function createCollectingAudio(
  host: CollectingAudioHost,
  options: CollectingAudioOptions = {},
): CollectingAudio {
  const ctx = host.context;
  const { sfx, music } = host.buses;
  const rng = options.rng ?? Math.random;
  const pool = new VoicePool<SourceVoice>(COLLECTING_MAX_VOICES, COLLECTING_SOURCE_BUDGET);
  const prizePitch = new PitchVariator<PrizeFamily>(rng);
  const shimmerPitch = new PitchVariator<CollectibleCoinVariant>(rng);
  const lastHit = new Map<PrizeFamily, { time: number; strength: number }>();
  const cellar = new CellarAmbience(ctx, {
    output: music,
    rng,
    timer: options.timer ?? intervalTimer,
    pool,
  });
  let noise: AudioBuffer | null = null;
  let disposed = false;

  const live = () => !disposed && ctx.state === 'running';
  const admit = (priority: number, cost: number, start: () => SourceVoice): boolean => {
    const now = ctx.currentTime;
    return pool.canAdmit(priority, cost, now) && pool.admit(start(), now);
  };

  return {
    get activeVoices() {
      return pool.activeCount;
    },
    get activeSources() {
      return pool.activeCost;
    },
    get cellarPlaying() {
      return cellar.isPlaying;
    },

    playPrizeImpact(family, speed, pan) {
      if (!live()) return false;
      const spec = buildPrizeImpactSpec(family, speed, prizePitch, rng, pan);
      if (!spec) return false;
      const now = ctx.currentTime;
      const last = lastHit.get(family);
      if (last && now - last.time < PRIZE_RETRIGGER_SECONDS && spec.strength <= last.strength) {
        return false;
      }
      noise ??= createNoiseBuffer(ctx, 1, rng);
      const buffer = noise;
      const played = admit(spec.priority, prizeVoiceCost(spec), () =>
        startPrizeVoice(ctx, spec, sfx, buffer, now),
      );
      if (played) lastHit.set(family, { time: now, strength: spec.strength });
      return played;
    },

    playVariantShimmer(variant, pan) {
      if (!live()) return false;
      const spec = buildVariantShimmerSpec(variant, shimmerPitch, rng, ctx.sampleRate, pan);
      if (!spec) return false;
      return admit(spec.priority, shimmerVoiceCost(spec), () =>
        startShimmerVoice(ctx, spec, sfx, ctx.currentTime),
      );
    },

    startCellarAmbience() {
      cellar.start();
    },

    stopCellarAmbience(fadeSeconds) {
      cellar.stop(fadeSeconds);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      cellar.dispose();
      pool.releaseAll(ctx.currentTime);
    },
  };
}

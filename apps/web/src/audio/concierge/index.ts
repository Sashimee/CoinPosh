import type { ConciergeExpression } from '../../game/concierge/lines.ts';
import { PitchVariator } from '../collecting/variation.ts';
import type { DuckOptions } from '../mixer.ts';
import { dbToGain, type Rng } from '../rng.ts';
import { createNoiseBuffer } from '../synth/buffers.ts';
import type { SourceVoice } from '../synth/voice.ts';
import { buildBarkSpec } from './barks.ts';
import { startBarkVoice } from './voice.ts';

export { BARK_PROFILES, barkVoiceCost, VOWELS } from './barks.ts';
export type { BarkSpec } from './barks.ts';

/**
 * The audio context and the mixer's SFX bus, so the master and SFX sliders and the mono fold
 * apply to the Concierge exactly as to the coin bed.
 */
export interface ConciergeVoiceHost {
  readonly context: BaseAudioContext;
  readonly sfxBus: AudioNode;
}

export interface ConciergeVoiceOptions {
  readonly rng?: Rng;
}

export interface ConciergeVoice {
  /** True while a bark is still sounding. */
  readonly speaking: boolean;
  /**
   * A short wordless murmur for the portrait's face. A new bark cuts the previous one off with a
   * click-free fade, since the Concierge only ever says one line at a time. Returns false when
   * nothing played: audio still locked, or the voice disposed.
   */
  play(expression: ConciergeExpression): boolean;
  /**
   * Steps the voice out of the way of a reveal stinger. Takes the same options the stinger
   * hands `duckMusic`, so both can be fed from one call site.
   */
  duck(options?: DuckOptions): void;
  dispose(): void;
}

/**
 * 03-ART: barks are "never over stingers". The music only steps back under a reveal; the voice
 * all but vanishes, whatever depth the stinger asked of the music.
 */
export const CONCIERGE_DUCK_DB = -32;
export const CONCIERGE_DUCK_DEFAULTS = { attack: 0.03, hold: 1.2, release: 0.6 } as const;
const BREATH_NOISE_SECONDS = 0.5;
const DISPOSE_FADE_SECONDS = 0.01;

export function createConciergeVoice(
  host: ConciergeVoiceHost,
  options: ConciergeVoiceOptions = {},
): ConciergeVoice {
  const ctx = host.context;
  const rng = options.rng ?? Math.random;
  const variator = new PitchVariator<ConciergeExpression>(rng);
  const ducker = new GainNode(ctx, { gain: 1 });
  ducker.connect(host.sfxBus);
  let noise: AudioBuffer | null = null;
  let current: SourceVoice | null = null;
  let duckedUntil = -Infinity;
  let disposed = false;

  return {
    get speaking() {
      return current !== null && current.endTime > ctx.currentTime;
    },

    play(expression) {
      if (disposed || ctx.state !== 'running') return false;
      const spec = buildBarkSpec(expression, variator, rng, ctx.sampleRate);
      const now = ctx.currentTime;
      noise ??= createNoiseBuffer(ctx, BREATH_NOISE_SECONDS, rng);
      current?.release(now);
      current = startBarkVoice(ctx, spec, ducker, noise, now);
      return true;
    },

    duck(duck = {}) {
      if (disposed) return;
      const attack = duck.attack ?? CONCIERGE_DUCK_DEFAULTS.attack;
      const hold = duck.hold ?? CONCIERGE_DUCK_DEFAULTS.hold;
      const release = duck.release ?? CONCIERGE_DUCK_DEFAULTS.release;
      const floor = dbToGain(Math.min(duck.depthDb ?? CONCIERGE_DUCK_DB, CONCIERGE_DUCK_DB));
      const now = ctx.currentTime;
      // A shorter stinger landing inside a longer one must not let the voice back in early.
      duckedUntil = Math.max(duckedUntil, now + attack + hold);
      const gain = ducker.gain;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(gain.value, now);
      gain.linearRampToValueAtTime(floor, now + attack);
      gain.setValueAtTime(floor, duckedUntil);
      gain.linearRampToValueAtTime(1, duckedUntil + release);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      const now = ctx.currentTime;
      current?.release(now);
      current = null;
      ducker.gain.cancelScheduledValues(now);
      ducker.gain.setValueAtTime(ducker.gain.value, now);
      ducker.gain.linearRampToValueAtTime(0, now + DISPOSE_FADE_SECONDS);
    },
  };
}

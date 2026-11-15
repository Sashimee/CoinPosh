import type { CascadeTier } from '@coinposh/shared';
import { comboVoiceCost, startComboVoice } from './combo/comboVoice.ts';
import {
  assertComboTier,
  comboStepNote,
  FLOURISH_NOTE_SPACING,
  tierFlourishDegrees,
  voiceComboDegree,
  type ComboNote,
} from './combo/ladder.ts';
import { Mixer, type DuckOptions, type MixerBus, type MixerVolumes } from './mixer.ts';
import { AdaptiveMusic } from './music/adaptive/index.ts';
import { RIVIERA_KEY, type VenueKey } from './music/theory.ts';
import type { Rng } from './rng.ts';
import { createNoiseBuffer } from './synth/buffers.ts';
import { impactVoiceCost, startImpactVoice } from './synth/impact.ts';
import { buildImpactSpec, ImpactVariator, type ImpactEvent } from './synth/impactSpec.ts';
import type { SourceVoice } from './synth/voice.ts';
import { manageAudioLifecycle } from './unlock.ts';
import { BurstLimiter, MAX_VOICES, VoicePool, VoicePriority } from './voicePool.ts';

export interface AudioEngineOptions {
  /** Where first-gesture listeners go. Defaults to `window`. */
  readonly gestureTarget?: EventTarget;
  readonly venueKey?: VenueKey;
  readonly volumes?: MixerVolumes;
  readonly rng?: Rng;
}

export interface AudioEngine {
  /** True once a gesture has started the audio context. */
  readonly unlocked: boolean;
  /** Resolves on the first successful unlock. */
  readonly whenUnlocked: Promise<void>;
  readonly activeVoices: number;
  playImpact(event: ImpactEvent): void;
  /** Plays the next ladder note; `step` is the 1-based coin count of the running cascade. */
  comboStep(step: number): void;
  /** 0 ends the cascade; 1..5 is Chic..OBSCENE. A rise plays the tier flourish. */
  setComboTier(tier: number): void;
  /** The adaptive bed follows setDropRate and setCascadeTier instead; this only validates. */
  setIntensity(intensity: number): void;
  duckMusic(options?: DuckOptions): void;
  /** Starts the adaptive venue band as soon as audio is unlocked. */
  startMusic(): Promise<void>;
  stopMusic(fadeSeconds?: number): void;
  /** Drops per second over the last few seconds; the band's tempo follows from the next bar. */
  setDropRate(dropsPerSecond: number): void;
  /** Brings band parts in by Cascade tier; `null` when the cascade ends. */
  setCascadeTier(tier: CascadeTier | null): void;
  /** Returns false when no sting played (music off or stopped, or one is still ringing). */
  playJackpotSting(): boolean;
  /** Off mutes the bed and stops scheduling notes, so a silenced band costs no CPU. */
  setMusicEnabled(enabled: boolean): void;
  /** Narrows the band's tempo swing for players who asked for less motion. */
  setReducedMotion(reduced: boolean): void;
  setVolume(bus: MixerBus, value: number): void;
  getVolume(bus: MixerBus): number;
  setMono(mono: boolean): void;
  dispose(): Promise<void>;
}

export function isAudioSupported(): boolean {
  return typeof AudioContext === 'function';
}

export function createAudioEngine(options: AudioEngineOptions = {}): AudioEngine {
  if (!isAudioSupported()) {
    throw new Error(
      'CoinPosh audio needs the Web Audio API (AudioContext); this browser has none. Check isAudioSupported() first.',
    );
  }
  const gestureTarget = options.gestureTarget ?? window;
  const key = options.venueKey ?? RIVIERA_KEY;
  const rng = options.rng ?? Math.random;

  const ctx = new AudioContext({ latencyHint: 'interactive' });
  const mixer = new Mixer(ctx, rng, options.volumes);
  const music = new AdaptiveMusic(ctx, {
    output: mixer.music,
    stingOutput: mixer.sfx,
    ducker: mixer,
    rng,
  });
  const noise = createNoiseBuffer(ctx, 1, rng);
  const pool = new VoicePool<SourceVoice>(MAX_VOICES);
  const burst = new BurstLimiter();
  const variator = new ImpactVariator(rng);

  const lifecycle = manageAudioLifecycle(ctx, gestureTarget, document, window);
  let comboTier = 0;
  let musicRequest = 0;
  let disposed = false;

  const running = () => ctx.state === 'running';

  const playComboNote = (note: ComboNote, when: number) => {
    const now = ctx.currentTime;
    const cost = comboVoiceCost(note, ctx.sampleRate);
    if (cost === 0 || !pool.canAdmit(VoicePriority.combo, cost, now)) return;
    pool.admit(startComboVoice(ctx, note, mixer.sfx, when), now);
  };

  const engine: AudioEngine = {
    get unlocked() {
      return running();
    },
    whenUnlocked: lifecycle.whenUnlocked,
    get activeVoices() {
      return pool.activeCount;
    },

    playImpact(event) {
      if (!running()) return;
      const spec = buildImpactSpec(event, variator, rng);
      if (!spec) return;
      const now = ctx.currentTime;
      const cost = impactVoiceCost(spec);
      if (!pool.canAdmit(spec.priority, cost, now) || !burst.tryConsume(now, cost)) return;
      pool.admit(startImpactVoice(ctx, spec, mixer.sfx, noise, now), now);
    },

    comboStep(step) {
      const note = comboStepNote(step, Math.max(1, comboTier), key);
      if (running()) playComboNote(note, ctx.currentTime);
    },

    setComboTier(tier) {
      assertComboTier(tier);
      const rising = tier > comboTier;
      comboTier = tier;
      if (!rising || !running()) return;
      const start = ctx.currentTime;
      tierFlourishDegrees(tier).forEach((degree, i) => {
        playComboNote(voiceComboDegree(degree, tier, key), start + i * FLOURISH_NOTE_SPACING);
      });
    },

    setIntensity(intensity) {
      if (!Number.isFinite(intensity)) {
        throw new RangeError(`Music intensity must be a finite number, got ${intensity}`);
      }
    },

    duckMusic(duck) {
      mixer.duckMusic(duck);
    },

    async startMusic() {
      const request = ++musicRequest;
      await lifecycle.whenUnlocked;
      if (request === musicRequest && !disposed) music.start();
    },

    stopMusic(fadeSeconds) {
      musicRequest++;
      if (!disposed) music.stop(fadeSeconds);
    },

    setDropRate(dropsPerSecond) {
      music.setDropRate(dropsPerSecond);
    },

    setCascadeTier(tier) {
      music.setCascadeTier(tier);
    },

    playJackpotSting() {
      return !disposed && running() && music.playJackpotSting();
    },

    setMusicEnabled(enabled) {
      music.setEnabled(enabled);
    },

    setReducedMotion(reduced) {
      music.setReducedMotion(reduced);
    },

    setVolume(bus, value) {
      mixer.setVolume(bus, value);
    },

    getVolume(bus) {
      return mixer.getVolume(bus);
    },

    setMono(mono) {
      mixer.setMono(mono);
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      lifecycle.dispose();
      pool.releaseAll(ctx.currentTime);
      music.dispose();
      await ctx.close();
    },
  };
  return engine;
}

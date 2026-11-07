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
import { MusicDirector } from './music/director.ts';
import { renderRivieraTrack, type MusicTrack } from './music/render.ts';
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
  /** 0..1; brings music layers in and out. */
  setIntensity(intensity: number): void;
  duckMusic(options?: DuckOptions): void;
  /** Renders the venue loop if needed and starts it as soon as audio is unlocked. */
  startMusic(): Promise<void>;
  stopMusic(fadeSeconds?: number): void;
  setVolume(bus: MixerBus, value: number): void;
  getVolume(bus: MixerBus): number;
  setMono(mono: boolean): void;
  dispose(): Promise<void>;
}

export function isAudioSupported(): boolean {
  return typeof AudioContext === 'function' && typeof OfflineAudioContext === 'function';
}

export function createAudioEngine(options: AudioEngineOptions = {}): AudioEngine {
  if (!isAudioSupported()) {
    throw new Error(
      'CoinPosh audio needs the Web Audio API (AudioContext + OfflineAudioContext); this browser has neither.',
    );
  }
  const gestureTarget = options.gestureTarget ?? window;
  const key = options.venueKey ?? RIVIERA_KEY;
  const rng = options.rng ?? Math.random;

  const ctx = new AudioContext({ latencyHint: 'interactive' });
  const mixer = new Mixer(ctx, rng, options.volumes);
  const director = new MusicDirector(ctx, mixer.music);
  const noise = createNoiseBuffer(ctx, 1, rng);
  const pool = new VoicePool<SourceVoice>(MAX_VOICES);
  const burst = new BurstLimiter();
  const variator = new ImpactVariator(rng);

  const lifecycle = manageAudioLifecycle(ctx, gestureTarget, document);
  let comboTier = 0;
  let track: Promise<MusicTrack> | null = null;
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
      director.setIntensity(intensity);
    },

    duckMusic(duck) {
      mixer.duckMusic(duck);
    },

    async startMusic() {
      const request = ++musicRequest;
      track ??= renderRivieraTrack(ctx);
      const rendered = await track;
      await lifecycle.whenUnlocked;
      if (request === musicRequest && !disposed && !director.isPlaying) director.play(rendered);
    },

    stopMusic(fadeSeconds) {
      musicRequest++;
      director.stop(fadeSeconds);
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
      director.stop(0.05);
      await ctx.close();
    },
  };
  return engine;
}

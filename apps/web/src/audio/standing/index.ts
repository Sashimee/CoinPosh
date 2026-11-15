import type { AchievementGrade, Rank, StaffRole } from '@coinposh/shared';
import { PitchVariator } from '../collecting/variation.ts';
import type { DuckOptions } from '../mixer.ts';
import { RIVIERA_KEY, type VenueKey } from '../music/theory.ts';
import type { Rng } from '../rng.ts';
import { createNoiseBuffer } from '../synth/buffers.ts';
import type { SourceVoice } from '../synth/voice.ts';
import { VoicePool } from '../voicePool.ts';
import { buildAchievementChime, chimeVoiceCost } from './chime.ts';
import { buildRankUpFanfare, fanfareVoiceCost } from './fanfare.ts';
import { assertWalk, buildStaffWalk, staffWalkCost, type StaffWalk } from './footsteps.ts';
import { DetuneVariator, NoRepeatPicker } from './variation.ts';
import { startChimeVoice, startFanfareVoice, startStaffWalkVoice } from './voices.ts';

export { CHIME_PROFILES } from './chime.ts';
export type { AchievementChimeSpec } from './chime.ts';
export { FANFARE_DUCK_DB, FANFARE_PRIORITY } from './fanfare.ts';
export type { RankUpFanfareSpec } from './fanfare.ts';
export { FOOTSTEP_PROFILES, MAX_WALK_STEPS } from './footsteps.ts';
export type { StaffWalk, StaffWalkSpec } from './footsteps.ts';

/**
 * The audio engine as standing needs it: the context, the SFX bus every cue plays into (so the
 * master and SFX sliders and the mono fold apply), and the music duck a fanfare asks for.
 */
export interface StandingAudioHost {
  readonly context: BaseAudioContext;
  readonly buses: { readonly sfx: AudioNode };
  duckMusic(options?: DuckOptions): void;
}

export interface StandingAudioOptions {
  readonly rng?: Rng;
  readonly venueKey?: VenueKey;
}

export interface StandingAudio {
  readonly activeVoices: number;
  readonly activeSources: number;
  /** True while a rank-up fanfare is still sounding. */
  readonly fanfarePlaying: boolean;
  /**
   * The fanfare for the rank just reached, in the venue key, ducking the music like the jackpot
   * sting. Returns the duck it applied, so the Concierge can step out of the way with the same
   * call, or null when nothing played (audio locked or disposed). A rank-up while one is still
   * ringing cuts the old one off with a click-free fade: only the highest new rank is heard.
   */
  playRankUp(rank: Rank): Required<DuckOptions> | null;
  /** The badge-metal chime; `pan` follows where the toast appears. False when nothing played. */
  playAchievementChime(grade: AchievementGrade, pan?: number): boolean;
  /** One footfall, for a walk cycle that reports each foot as it lands. */
  playStaffFootstep(role: StaffRole, pan?: number): boolean;
  /** A whole walk at the role's gait, panning from where it starts to where it ends. */
  playStaffWalk(role: StaffRole, walk: StaffWalk): boolean;
  /** Follows the venue the player moves to: the next fanfare and chime play in its key. */
  setVenueKey(key: VenueKey): void;
  dispose(): void;
}

/** A rank-up, a couple of badges and the household walking: bounded on top of the engine's pool. */
export const STANDING_MAX_VOICES = 10;
export const STANDING_SOURCE_BUDGET = 80;
/** A walk cycle can report a foot twice in a frame; a second footfall this soon is the same one. */
export const FOOTSTEP_RETRIGGER_SECONDS = 0.08;
const NOISE_SECONDS = 1;

export function createStandingAudio(
  host: StandingAudioHost,
  options: StandingAudioOptions = {},
): StandingAudio {
  const ctx = host.context;
  const sfx = host.buses.sfx;
  const rng = options.rng ?? Math.random;
  let key = options.venueKey ?? RIVIERA_KEY;
  const pool = new VoicePool<SourceVoice>(STANDING_MAX_VOICES, STANDING_SOURCE_BUDGET);
  const figures = new NoRepeatPicker<'sparkle'>(rng);
  const motifs = new NoRepeatPicker<AchievementGrade>(rng);
  const detune = new DetuneVariator<AchievementGrade>(rng);
  const steps = new PitchVariator<StaffRole>(rng);
  const lastStep = new Map<StaffRole, number>();
  let noise: AudioBuffer | null = null;
  let fanfare: SourceVoice | null = null;
  let disposed = false;

  const live = () => !disposed && ctx.state === 'running';
  const noiseBuffer = () => (noise ??= createNoiseBuffer(ctx, NOISE_SECONDS, rng));
  const admit = (priority: number, cost: number, start: () => SourceVoice): SourceVoice | null => {
    const now = ctx.currentTime;
    if (cost === 0 || !pool.canAdmit(priority, cost, now)) return null;
    const voice = start();
    return pool.admit(voice, now) ? voice : null;
  };

  const walk = (role: StaffRole, request: StaffWalk): boolean => {
    assertWalk(request);
    if (!live()) return false;
    const now = ctx.currentTime;
    const last = lastStep.get(role);
    if (last !== undefined && now - last < FOOTSTEP_RETRIGGER_SECONDS) return false;
    const spec = buildStaffWalk(role, request, steps, rng);
    const buffer = noiseBuffer();
    const voice = admit(spec.priority, staffWalkCost(spec, ctx.sampleRate), () =>
      startStaffWalkVoice(ctx, spec, sfx, buffer, now),
    );
    if (voice) lastStep.set(role, now);
    return voice !== null;
  };

  return {
    get activeVoices() {
      return pool.activeCount;
    },
    get activeSources() {
      return pool.activeCost;
    },
    get fanfarePlaying() {
      return fanfare !== null && fanfare.endTime > ctx.currentTime;
    },

    playRankUp(rank) {
      if (!live()) return null;
      const spec = buildRankUpFanfare(rank, key, rng, figures);
      const now = ctx.currentTime;
      fanfare?.release(now);
      const buffer = noiseBuffer();
      const voice = admit(spec.priority, fanfareVoiceCost(spec, ctx.sampleRate), () =>
        startFanfareVoice(ctx, spec, sfx, buffer, now),
      );
      if (!voice) return null;
      fanfare = voice;
      host.duckMusic(spec.duck);
      return spec.duck;
    },

    playAchievementChime(grade, pan) {
      if (!live()) return false;
      const spec = buildAchievementChime(grade, key, rng, motifs, detune, ctx.sampleRate, pan);
      const now = ctx.currentTime;
      return (
        admit(spec.priority, chimeVoiceCost(spec), () => startChimeVoice(ctx, spec, sfx, now)) !==
        null
      );
    },

    playStaffFootstep(role, pan) {
      return walk(role, { steps: 1, fromPan: pan ?? 0 });
    },

    playStaffWalk(role, request) {
      return walk(role, request);
    },

    setVenueKey(next) {
      key = next;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      fanfare = null;
      pool.releaseAll(ctx.currentTime);
    },
  };
}

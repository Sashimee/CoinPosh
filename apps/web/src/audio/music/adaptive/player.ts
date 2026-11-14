import type { CascadeTier } from '@coinposh/shared';
import type { DuckOptions } from '../../mixer.ts';
import type { Rng } from '../../rng.ts';
import { createNoiseBuffer, createRoomImpulse } from '../../synth/buffers.ts';
import { playBass, playDrum, playKeys, playVibes, type RenderClock } from '../instruments.ts';
import type { StemId } from '../layers.ts';
import { composeRiviera, type Composition } from '../riviera.ts';
import {
  AdaptiveScheduler,
  type GainPoint,
  type ScheduledEvent,
  type StingPlan,
} from './scheduler.ts';
import { ADAPTIVE_PARTS, PART_SPECS, type AdaptivePart } from './stems.ts';

export interface MusicDucker {
  duckMusic(options?: DuckOptions): void;
}

/** Calls `tick` every `ms` until the returned cancel runs. */
export type PumpTimer = (ms: number, tick: () => void) => () => void;

export interface AdaptiveMusicOptions {
  /** The music bus; the mixer ducks it under the sting. */
  readonly output: AudioNode;
  /** Where the jackpot sting plays, outside the duck (the SFX bus). */
  readonly stingOutput: AudioNode;
  readonly ducker: MusicDucker;
  readonly rng: Rng;
  readonly composition?: Composition;
  readonly timer?: PumpTimer;
}

/** Same voicing as the rendered Riviera stems (render.ts), so the live band sounds identical. */
const STEM_TONE: Readonly<Record<StemId, { wet: number; lowpass: number; tremolo: number }>> = {
  keys: { wet: 0.24, lowpass: 3400, tremolo: 0 },
  bass: { wet: 0.05, lowpass: 1800, tremolo: 0 },
  drums: { wet: 0.14, lowpass: 14000, tremolo: 0 },
  vibes: { wet: 0.32, lowpass: 9000, tremolo: 0.22 },
};
const ROOM_T60 = 1.8;
const TREMOLO_HZ = 5.2;
const FADE_IN_SECONDS = 2.5;
const MUTE_TAU = 0.08;
const STING_LEVEL = 0.9;
/** Several pumps per lookahead, so one late timer tick never starves the clock. */
export const PUMP_INTERVAL_MS = 25;

const intervalTimer: PumpTimer = (ms, tick) => {
  const id = setInterval(tick, ms);
  return () => {
    clearInterval(id);
  };
};

interface PartChain {
  readonly input: GainNode;
  readonly nodes: readonly AudioNode[];
}

/**
 * Plays the venue loop live from its score so the tempo can follow the table without any
 * pitch shift, brings parts in and out by Cascade tier, and fires the jackpot sting. All
 * timing decisions come from {@link AdaptiveScheduler}; this class only turns them into nodes.
 */
export class AdaptiveMusic {
  readonly scheduler: AdaptiveScheduler;
  private readonly fader: GainNode;
  private readonly mute: GainNode;
  private readonly stingBus: GainNode;
  private readonly room: ConvolverNode;
  private readonly noise: AudioBuffer;
  private readonly chains: ReadonlyMap<AdaptivePart, PartChain>;
  private readonly lfos: OscillatorNode[] = [];
  private readonly timer: PumpTimer;
  private readonly ducker: MusicDucker;
  private cancelPump: (() => void) | null = null;
  private disposed = false;

  constructor(
    private readonly ctx: BaseAudioContext,
    options: AdaptiveMusicOptions,
  ) {
    this.scheduler = new AdaptiveScheduler(options.composition ?? composeRiviera());
    this.timer = options.timer ?? intervalTimer;
    this.ducker = options.ducker;
    this.fader = new GainNode(ctx, { gain: 0 });
    this.mute = new GainNode(ctx, { gain: 1 });
    this.fader.connect(this.mute).connect(options.output);
    this.stingBus = new GainNode(ctx, { gain: STING_LEVEL });
    this.stingBus.connect(options.stingOutput);
    this.room = new ConvolverNode(ctx, {
      buffer: createRoomImpulse(ctx, ROOM_T60, 2, options.rng),
    });
    this.room.connect(this.fader);
    this.noise = createNoiseBuffer(ctx, 1, options.rng);
    this.chains = new Map(ADAPTIVE_PARTS.map((part) => [part, this.buildChain(part)]));
  }

  get isPlaying(): boolean {
    return this.scheduler.isRunning;
  }

  get tempo(): number {
    return this.scheduler.tempoAt(this.ctx.currentTime);
  }

  start(): void {
    this.assertLive();
    if (this.scheduler.isRunning) return;
    const now = this.ctx.currentTime;
    this.scheduler.start(now);
    const gain = this.fader.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(1, now + FADE_IN_SECONDS);
    this.pump();
    this.cancelPump = this.timer(PUMP_INTERVAL_MS, () => {
      this.pump();
    });
  }

  stop(fadeSeconds = 1): void {
    if (!Number.isFinite(fadeSeconds) || fadeSeconds < 0) {
      throw new RangeError(
        `Music fade must be a non-negative number of seconds, got ${fadeSeconds}`,
      );
    }
    this.cancelPump?.();
    this.cancelPump = null;
    if (!this.scheduler.isRunning) return;
    this.scheduler.stop();
    const now = this.ctx.currentTime;
    const gain = this.fader.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(0, now + fadeSeconds);
  }

  /** Drops per second; the band leans in or relaxes from the next bar. */
  setDropRate(dropsPerSecond: number): void {
    this.scheduler.setDropRate(dropsPerSecond);
  }

  /** `null` when the cascade ends. */
  setCascadeTier(tier: CascadeTier | null): void {
    this.scheduler.setCascadeTier(tier, this.ctx.currentTime);
  }

  /** Returns false when no sting played (music off, or one is still ringing). */
  playJackpotSting(): boolean {
    this.assertLive();
    if (!this.scheduler.isRunning || !this.scheduler.isEnabled) return false;
    const plan: StingPlan | null = this.scheduler.jackpot(this.ctx.currentTime);
    if (!plan) return false;
    this.ducker.duckMusic(plan.duck);
    for (const event of plan.events) this.play(event, this.stingBus);
    return true;
  }

  /** Music off mutes the bed and stops committing notes, so a silenced band costs no CPU. */
  setEnabled(enabled: boolean): void {
    this.scheduler.setEnabled(enabled);
    this.mute.gain.setTargetAtTime(enabled ? 1 : 0, this.ctx.currentTime, MUTE_TAU);
  }

  setReducedMotion(reduced: boolean): void {
    this.scheduler.setReducedMotion(reduced);
  }

  /** Commits the next slice of the score; the timer calls it, tier changes call it at once. */
  pump(): void {
    if (this.disposed) return;
    const window = this.scheduler.pump(this.ctx.currentTime);
    for (const point of window.gains) this.applyGain(point);
    for (const event of window.events) {
      if (event.part === 'sting') continue;
      const chain = this.chains.get(event.part);
      if (chain) this.play(event, chain.input);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop(0);
    this.disposed = true;
    for (const lfo of this.lfos) lfo.stop();
    for (const chain of this.chains.values()) for (const node of chain.nodes) node.disconnect();
    for (const node of [this.room, this.fader, this.mute, this.stingBus]) node.disconnect();
  }

  private assertLive(): void {
    if (this.disposed)
      throw new Error('Adaptive music was disposed; create a new one to play again');
  }

  private buildChain(part: AdaptivePart): PartChain {
    const spec = PART_SPECS[part];
    const tone = STEM_TONE[spec.stem];
    const input = new GainNode(this.ctx, { gain: 0 });
    const lowpass = new BiquadFilterNode(this.ctx, {
      type: 'lowpass',
      frequency: tone.lowpass,
      Q: 0.5,
    });
    const panner = new StereoPannerNode(this.ctx, { pan: spec.pan });
    const wet = new GainNode(this.ctx, { gain: tone.wet });
    const nodes: AudioNode[] = [input, lowpass, panner, wet];
    let body: AudioNode = input;
    if (tone.tremolo > 0) {
      const tremolo = new GainNode(this.ctx, { gain: 1 - tone.tremolo });
      const lfo = new OscillatorNode(this.ctx, { frequency: TREMOLO_HZ });
      const depth = new GainNode(this.ctx, { gain: tone.tremolo });
      lfo.connect(depth).connect(tremolo.gain);
      lfo.start();
      this.lfos.push(lfo);
      nodes.push(tremolo, lfo, depth);
      body = input.connect(tremolo);
    }
    body.connect(lowpass).connect(panner).connect(this.fader);
    lowpass.connect(wet).connect(this.room);
    return { input, nodes };
  }

  private applyGain(point: GainPoint): void {
    const param = this.chains.get(point.part)?.input.gain;
    if (!param) return;
    if (point.mode === 'set') {
      param.cancelScheduledValues(point.time);
      param.setValueAtTime(point.value, point.time);
    } else {
      param.linearRampToValueAtTime(point.value, point.time);
    }
  }

  /** The instruments place notes in beats from zero, so absolute time becomes a beat count. */
  private play(event: ScheduledEvent, out: AudioNode): void {
    const clock: RenderClock = { secondsPerBeat: event.secondsPerBeat };
    const time = event.at / event.secondsPerBeat;
    if (event.kind === 'drum') {
      playDrum(
        this.ctx,
        out,
        { time, kind: event.drum, velocity: event.velocity },
        clock,
        this.noise,
      );
      return;
    }
    const note = {
      time,
      duration: event.durationBeats,
      midi: event.midi,
      velocity: event.velocity,
    };
    switch (event.instrument) {
      case 'keys':
        playKeys(this.ctx, out, note, clock);
        return;
      case 'bass':
        playBass(this.ctx, out, note, clock);
        return;
      case 'vibes':
        playVibes(this.ctx, out, note, clock);
        return;
    }
  }
}

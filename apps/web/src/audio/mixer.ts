import { clamp, dbToGain, type Rng } from './rng.ts';
import { createRoomImpulse } from './synth/buffers.ts';

export type MixerBus = 'master' | 'music' | 'sfx';

export type MixerVolumes = Readonly<Record<MixerBus, number>>;

export const DEFAULT_VOLUMES: MixerVolumes = { master: 0.9, music: 0.55, sfx: 0.85 };

/**
 * Square-law taper: close to how loudness is heard (half travel is about -12 dB) while still
 * reaching true silence at zero. A linear-gain slider spends its whole top half sounding "full".
 */
export function sliderToGain(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Mixer slider value must be a finite number in 0..1, got ${value}`);
  }
  return clamp(value, 0, 1) ** 2;
}

export interface DuckOptions {
  readonly depthDb?: number;
  readonly attack?: number;
  readonly hold?: number;
  readonly release?: number;
}

/** Headroom before the limiter so a full cascade compresses gently instead of slamming. */
const PRE_LIMITER_DB = -3;
const SFX_ROOM_SEND = 0.14;
const SFX_ROOM_T60 = 0.7;
const SMOOTHING_TAU = 0.03;

/**
 * master <- music (-> duck) and sfx (-> short room send). The master runs through an optional
 * mono fold and a brickwall-style limiter, so nothing the game does can clip the output.
 */
export class Mixer {
  readonly music: GainNode;
  readonly sfx: GainNode;
  private readonly musicDuck: GainNode;
  private readonly master: GainNode;
  private readonly monoFold: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  private volumes: Record<MixerBus, number>;
  private mono = false;

  constructor(
    private readonly ctx: BaseAudioContext,
    rng: Rng,
    volumes: MixerVolumes = DEFAULT_VOLUMES,
  ) {
    this.volumes = { ...volumes };
    this.music = new GainNode(ctx, { gain: sliderToGain(volumes.music) });
    this.sfx = new GainNode(ctx, { gain: sliderToGain(volumes.sfx) });
    this.musicDuck = new GainNode(ctx, { gain: 1 });
    this.master = new GainNode(ctx, {
      gain: sliderToGain(volumes.master) * dbToGain(PRE_LIMITER_DB),
    });
    this.monoFold = new GainNode(ctx, { channelCount: 2, channelCountMode: 'explicit' });
    this.limiter = new DynamicsCompressorNode(ctx, {
      threshold: -2,
      knee: 0,
      ratio: 20,
      attack: 0.001,
      release: 0.12,
    });

    this.music.connect(this.musicDuck).connect(this.master);
    this.sfx.connect(this.master);
    const room = new ConvolverNode(ctx, { buffer: createRoomImpulse(ctx, SFX_ROOM_T60, 2, rng) });
    this.sfx
      .connect(new GainNode(ctx, { gain: SFX_ROOM_SEND }))
      .connect(room)
      .connect(this.master);
    this.master.connect(this.monoFold).connect(this.limiter).connect(ctx.destination);
  }

  getVolume(bus: MixerBus): number {
    return this.volumes[bus];
  }

  getVolumes(): MixerVolumes {
    return { ...this.volumes };
  }

  setVolume(bus: MixerBus, value: number): void {
    const gain = sliderToGain(value);
    this.volumes[bus] = clamp(value, 0, 1);
    const node = bus === 'master' ? this.master : bus === 'music' ? this.music : this.sfx;
    const target = bus === 'master' ? gain * dbToGain(PRE_LIMITER_DB) : gain;
    node.gain.setTargetAtTime(target, this.ctx.currentTime, SMOOTHING_TAU);
  }

  get isMono(): boolean {
    return this.mono;
  }

  /** Folds the whole mix to one channel, for single-speaker phones and accessibility. */
  setMono(mono: boolean): void {
    this.mono = mono;
    this.monoFold.channelCount = mono ? 1 : 2;
  }

  /** Dips the music under a reveal stinger, then brings it back. */
  duckMusic({ depthDb = -10, attack = 0.05, hold = 1.2, release = 0.8 }: DuckOptions = {}): void {
    const now = this.ctx.currentTime;
    const gain = this.musicDuck.gain;
    const floor = dbToGain(depthDb);
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(floor, now + attack);
    gain.setValueAtTime(floor, now + attack + hold);
    gain.linearRampToValueAtTime(1, now + attack + hold + release);
  }
}

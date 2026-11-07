import type { PooledVoice } from '../voicePool.ts';

/** -60 dB: where an exponential ramp can stop without an audible step. */
const SILENT = 0.001;
const ATTACK_SECONDS = 0.0008;
const STEAL_FADE_SECONDS = 0.008;

/**
 * A group of one-shot sources behind a single gain node. Stealing fades that node out, so a
 * stolen voice never clicks.
 */
export class SourceVoice implements PooledVoice {
  readonly output: GainNode;
  endTime: number;
  private readonly panner: StereoPannerNode;
  private readonly sources: AudioScheduledSourceNode[] = [];
  private playing = 0;
  private released = false;

  constructor(
    ctx: BaseAudioContext,
    readonly priority: number,
    readonly startTime: number,
    gain: number,
    pan: number,
    destination: AudioNode,
  ) {
    this.output = new GainNode(ctx, { gain });
    this.panner = new StereoPannerNode(ctx, { pan });
    this.output.connect(this.panner).connect(destination);
    this.endTime = startTime;
  }

  get context(): BaseAudioContext {
    return this.output.context;
  }

  /** Tracks an already started source and stops it at `stopAt`; the last one to end frees the voice. */
  track(source: AudioScheduledSourceNode, stopAt: number): void {
    this.sources.push(source);
    this.playing++;
    source.onended = () => {
      this.playing--;
      if (this.playing === 0) {
        this.output.disconnect();
        this.panner.disconnect();
      }
    };
    source.stop(stopAt);
    this.endTime = Math.max(this.endTime, stopAt);
  }

  release(now: number): void {
    if (this.released) return;
    this.released = true;
    const gain = this.output.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(0, now + STEAL_FADE_SECONDS);
    const stopAt = now + STEAL_FADE_SECONDS + 0.004;
    if (this.endTime > stopAt) {
      for (const source of this.sources) source.stop(stopAt);
      this.endTime = stopAt;
    }
  }
}

/** A sine partial with an instant strike and an exponential 60 dB decay over `t60`. */
export function scheduleDecayingSine(
  voice: SourceVoice,
  frequency: number,
  amplitude: number,
  t60: number,
  when: number,
  destination: AudioNode = voice.output,
): void {
  const oscillator = new OscillatorNode(voice.context, { frequency });
  const envelope = new GainNode(voice.context, { gain: 0 });
  envelope.gain.setValueAtTime(0, when);
  envelope.gain.linearRampToValueAtTime(amplitude, when + ATTACK_SECONDS);
  envelope.gain.exponentialRampToValueAtTime(amplitude * SILENT, when + ATTACK_SECONDS + t60);
  oscillator.connect(envelope).connect(destination);
  oscillator.start(when);
  voice.track(oscillator, when + ATTACK_SECONDS + t60 + 0.005);
}

export function scheduleNoiseBurst(
  voice: SourceVoice,
  noise: AudioBuffer,
  offset: number,
  filter: BiquadFilterOptions,
  amplitude: number,
  t60: number,
  when: number,
): void {
  const ctx = voice.context;
  const source = new AudioBufferSourceNode(ctx, { buffer: noise });
  const band = new BiquadFilterNode(ctx, filter);
  const envelope = new GainNode(ctx, { gain: 0 });
  envelope.gain.setValueAtTime(amplitude, when);
  envelope.gain.exponentialRampToValueAtTime(amplitude * SILENT, when + t60);
  source.connect(band).connect(envelope).connect(voice.output);
  source.start(when, offset * Math.max(0, noise.duration - t60 - 0.01));
  voice.track(source, when + t60 + 0.005);
}

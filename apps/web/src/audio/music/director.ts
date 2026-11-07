import { clamp } from '../rng.ts';
import { IDLE_INTENSITY, layerGain, type StemId } from './layers.ts';
import type { MusicTrack } from './render.ts';

const RISE_TAU = 0.35;
/** Layers leave slower than they arrive, so the band winds down after a cascade instead of cutting out. */
const FALL_TAU = 1.6;
const FADE_IN_SECONDS = 2.5;

interface PlayingStem {
  readonly stem: StemId;
  readonly source: AudioBufferSourceNode;
  readonly gain: GainNode;
}

export class MusicDirector {
  private intensity = IDLE_INTENSITY;
  private playing: { track: MusicTrack; stems: PlayingStem[]; fader: GainNode } | null = null;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly output: AudioNode,
  ) {}

  get currentIntensity(): number {
    return this.intensity;
  }

  get isPlaying(): boolean {
    return this.playing !== null;
  }

  /** Starts every stem on the same sample so the layers stay locked together forever. */
  play(track: MusicTrack, when = this.ctx.currentTime + 0.05): void {
    this.stop(0.4);
    const fader = new GainNode(this.ctx, { gain: 0 });
    fader.gain.setValueAtTime(0, when);
    fader.gain.linearRampToValueAtTime(1, when + FADE_IN_SECONDS);
    fader.connect(this.output);
    const stems = track.layers.map((layer) => {
      const source = new AudioBufferSourceNode(this.ctx, {
        buffer: track.stems[layer.stem],
        loop: true,
        loopStart: 0,
        loopEnd: track.loopDuration,
      });
      const gain = new GainNode(this.ctx, { gain: layerGain(layer, this.intensity) });
      const panner = new StereoPannerNode(this.ctx, { pan: layer.pan });
      source.connect(gain).connect(panner).connect(fader);
      source.start(when);
      return { stem: layer.stem, source, gain };
    });
    this.playing = { track, stems, fader };
  }

  setIntensity(intensity: number): void {
    if (!Number.isFinite(intensity)) {
      throw new RangeError(`Music intensity must be a finite number, got ${intensity}`);
    }
    const next = clamp(intensity, 0, 1);
    const rising = next > this.intensity;
    this.intensity = next;
    if (!this.playing) return;
    const now = this.ctx.currentTime;
    for (const { stem, gain } of this.playing.stems) {
      const layer = this.playing.track.layers.find((l) => l.stem === stem);
      if (!layer) continue;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setTargetAtTime(layerGain(layer, next), now, rising ? RISE_TAU : FALL_TAU);
    }
  }

  stop(fadeSeconds = 1): void {
    if (!this.playing) return;
    const { stems, fader } = this.playing;
    const now = this.ctx.currentTime;
    fader.gain.cancelScheduledValues(now);
    fader.gain.setValueAtTime(fader.gain.value, now);
    fader.gain.linearRampToValueAtTime(0, now + fadeSeconds);
    for (const { source } of stems) {
      source.onended = () => {
        source.disconnect();
        fader.disconnect();
      };
      source.stop(now + fadeSeconds + 0.02);
    }
    this.playing = null;
  }
}

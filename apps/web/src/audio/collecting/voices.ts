import { scheduleDecayingSine, scheduleNoiseBurst, SourceVoice } from '../synth/voice.ts';
import type { PrizeImpactSpec } from './prizeImpact.ts';
import type { ShimmerPartial, VariantShimmerSpec } from './shimmer.ts';

const SILENT = 0.001;
const TAIL = 0.005;

export function startPrizeVoice(
  ctx: BaseAudioContext,
  spec: PrizeImpactSpec,
  destination: AudioNode,
  noise: AudioBuffer,
  when: number,
): SourceVoice {
  const voice = new SourceVoice(ctx, spec.priority, when, spec.gain, spec.pan, destination);
  for (const layer of spec.layers) {
    const at = when + layer.delay;
    for (const partial of layer.partials) {
      scheduleDecayingSine(
        voice,
        partial.frequency,
        partial.amplitude * layer.gain,
        partial.t60,
        at,
      );
    }
    const { transient } = layer;
    if (transient) {
      scheduleNoiseBurst(
        voice,
        noise,
        transient.noiseOffset,
        { type: transient.filter, frequency: transient.frequency, Q: transient.q },
        transient.gain * layer.gain,
        transient.t60,
        at,
      );
    }
  }
  return voice;
}

function scheduleShimmerPartial(voice: SourceVoice, partial: ShimmerPartial, when: number): void {
  const ctx = voice.context;
  const start = when + partial.delay;
  const peakAt = start + partial.attack;
  const end = peakAt + partial.t60;
  const oscillator = new OscillatorNode(ctx, { frequency: partial.frequency });
  oscillator.frequency.setValueAtTime(partial.frequency, start);
  if (partial.endFrequency !== partial.frequency) {
    oscillator.frequency.exponentialRampToValueAtTime(partial.endFrequency, end);
  }
  const envelope = new GainNode(ctx, { gain: 0 });
  envelope.gain.setValueAtTime(0, start);
  envelope.gain.linearRampToValueAtTime(partial.amplitude, peakAt);
  envelope.gain.exponentialRampToValueAtTime(partial.amplitude * SILENT, end);
  oscillator.connect(envelope).connect(voice.output);
  oscillator.start(start);
  voice.track(oscillator, end + TAIL);

  if (partial.vibratoDepth > 0) {
    const lfo = new OscillatorNode(ctx, { frequency: partial.vibratoHz });
    const depth = new GainNode(ctx, { gain: partial.frequency * partial.vibratoDepth });
    lfo.connect(depth).connect(oscillator.frequency);
    lfo.start(start);
    voice.track(lfo, end + TAIL);
  }
}

export function startShimmerVoice(
  ctx: BaseAudioContext,
  spec: VariantShimmerSpec,
  destination: AudioNode,
  when: number,
): SourceVoice {
  const voice = new SourceVoice(ctx, spec.priority, when, spec.gain, spec.pan, destination);
  for (const partial of spec.partials) scheduleShimmerPartial(voice, partial, when);
  return voice;
}

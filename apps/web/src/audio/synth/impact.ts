import type { ImpactSpec } from './impactSpec.ts';
import { scheduleDecayingSine, scheduleNoiseBurst, SourceVoice } from './voice.ts';

/** One oscillator per modal partial plus the noise click. */
export function impactVoiceCost(spec: ImpactSpec): number {
  return spec.partials.length + 1;
}

export function startImpactVoice(
  ctx: BaseAudioContext,
  spec: ImpactSpec,
  destination: AudioNode,
  noise: AudioBuffer,
  when: number,
): SourceVoice {
  const voice = new SourceVoice(ctx, spec.priority, when, spec.gain, spec.pan, destination);
  for (const partial of spec.partials) {
    scheduleDecayingSine(voice, partial.frequency, partial.amplitude, partial.t60, when);
  }
  const { transient } = spec;
  scheduleNoiseBurst(
    voice,
    noise,
    transient.noiseOffset,
    { type: 'bandpass', frequency: transient.frequency, Q: transient.q },
    transient.gain,
    transient.t60,
    when,
  );
  return voice;
}

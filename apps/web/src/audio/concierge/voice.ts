import { SourceVoice } from '../synth/voice.ts';
import type { BarkBreath, BarkSpec, BarkSyllable } from './barks.ts';

const SILENT = 0.001;
const TAIL = 0.005;
/** Where the vowel has finished forming; the rest of the syllable holds the mouth shape. */
const ARTICULATION = 0.6;
const SAG = 0.8;
/** The unfiltered chest tone under the formants, so the murmur has a body and not just a buzz. */
const BODY = { frequency: 900, q: 0.7, gain: 0.32 } as const;

function shapeEnvelope(
  param: AudioParam,
  level: number,
  start: number,
  attack: number,
  release: number,
  end: number,
): void {
  param.setValueAtTime(0, start);
  param.linearRampToValueAtTime(level, start + attack);
  param.linearRampToValueAtTime(level * SAG, end - release);
  param.exponentialRampToValueAtTime(level * SILENT, end);
}

function scheduleSyllable(voice: SourceVoice, syllable: BarkSyllable, when: number): void {
  const ctx = voice.context;
  const start = when + syllable.start;
  const end = start + syllable.duration;

  const glottis = new OscillatorNode(ctx, { type: 'sawtooth', frequency: syllable.startHz });
  glottis.frequency.setValueAtTime(syllable.startHz, start);
  glottis.frequency.exponentialRampToValueAtTime(syllable.peakHz, start + syllable.peakTime);
  glottis.frequency.exponentialRampToValueAtTime(syllable.endHz, end);

  const envelope = new GainNode(ctx, { gain: 0 });
  shapeEnvelope(envelope.gain, syllable.level, start, syllable.attack, syllable.release, end);
  envelope.connect(voice.output);

  const body = new BiquadFilterNode(ctx, {
    type: 'lowpass',
    frequency: BODY.frequency,
    Q: BODY.q,
  });
  glottis
    .connect(body)
    .connect(new GainNode(ctx, { gain: BODY.gain }))
    .connect(envelope);

  const shaped = start + syllable.duration * ARTICULATION;
  syllable.formantsFrom.forEach((from, i) => {
    const to = syllable.formantsTo[i] ?? from;
    const band = new BiquadFilterNode(ctx, {
      type: 'bandpass',
      frequency: from.frequency,
      Q: from.q,
    });
    band.frequency.setValueAtTime(from.frequency, start);
    band.frequency.linearRampToValueAtTime(to.frequency, shaped);
    const level = new GainNode(ctx, { gain: from.gain });
    level.gain.setValueAtTime(from.gain, start);
    level.gain.linearRampToValueAtTime(to.gain, shaped);
    glottis.connect(band).connect(level).connect(envelope);
  });

  glottis.start(start);
  voice.track(glottis, end + TAIL);

  if (syllable.vibratoDepth > 0) {
    const lfo = new OscillatorNode(ctx, { frequency: syllable.vibratoHz });
    const depth = new GainNode(ctx, { gain: syllable.peakHz * syllable.vibratoDepth });
    lfo.connect(depth).connect(glottis.frequency);
    lfo.start(start);
    voice.track(lfo, end + TAIL);
  }
}

function scheduleBreath(
  voice: SourceVoice,
  breath: BarkBreath,
  noise: AudioBuffer,
  when: number,
): void {
  const ctx = voice.context;
  const start = when + breath.start;
  const end = start + breath.duration;
  const source = new AudioBufferSourceNode(ctx, { buffer: noise });
  const band = new BiquadFilterNode(ctx, {
    type: 'bandpass',
    frequency: breath.fromHz,
    Q: breath.q,
  });
  band.frequency.setValueAtTime(breath.fromHz, start);
  band.frequency.exponentialRampToValueAtTime(breath.toHz, end);
  const envelope = new GainNode(ctx, { gain: 0 });
  shapeEnvelope(
    envelope.gain,
    breath.level,
    start,
    breath.duration * 0.7,
    breath.duration * 0.3,
    end,
  );
  source.connect(band).connect(envelope).connect(voice.output);
  source.start(start, breath.noiseOffset * Math.max(0, noise.duration - breath.duration - 0.01));
  voice.track(source, end + TAIL);
}

export function startBarkVoice(
  ctx: BaseAudioContext,
  spec: BarkSpec,
  destination: AudioNode,
  noise: AudioBuffer,
  when: number,
): SourceVoice {
  const voice = new SourceVoice(ctx, spec.priority, when, spec.gain, 0, destination);
  if (spec.breath) scheduleBreath(voice, spec.breath, noise, when);
  for (const syllable of spec.syllables) scheduleSyllable(voice, syllable, when);
  return voice;
}

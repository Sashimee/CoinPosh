import { midiToHz } from './theory.ts';
import type { DrumEvent, NoteEvent } from './riviera.ts';

const SILENT = 0.001;
/** The vibes pedal lifts with the note, so each bar rings a little past its written length. */
const DAMPER_SECONDS = 0.6;

export interface RenderClock {
  readonly secondsPerBeat: number;
}

/** Two-operator FM electric piano: 1:1 modulator for the bark, index falls as the note blooms. */
export function playKeys(
  ctx: BaseAudioContext,
  out: AudioNode,
  note: NoteEvent,
  clock: RenderClock,
): void {
  const start = note.time * clock.secondsPerBeat;
  const end = start + note.duration * clock.secondsPerBeat;
  const frequency = midiToHz(note.midi);
  const carrier = new OscillatorNode(ctx, { frequency });
  const modulator = new OscillatorNode(ctx, { frequency });
  const index = new GainNode(ctx, { gain: 0 });
  index.gain.setValueAtTime(frequency * 2.2 * note.velocity, start);
  index.gain.setTargetAtTime(frequency * 0.25, start, 0.35);
  const amp = new GainNode(ctx, { gain: 0 });
  amp.gain.setValueAtTime(0, start);
  amp.gain.linearRampToValueAtTime(0.22 * note.velocity, start + 0.004);
  amp.gain.setTargetAtTime(0, start + 0.004, 1.4);
  amp.gain.setTargetAtTime(0, end, 0.09);
  modulator.connect(index).connect(carrier.frequency);
  carrier.connect(amp).connect(out);
  const stop = end + 0.7;
  for (const osc of [carrier, modulator]) {
    osc.start(start);
    osc.stop(stop);
  }
}

export function playBass(
  ctx: BaseAudioContext,
  out: AudioNode,
  note: NoteEvent,
  clock: RenderClock,
): void {
  const start = note.time * clock.secondsPerBeat;
  const end = start + note.duration * clock.secondsPerBeat;
  const frequency = midiToHz(note.midi);
  const body = new OscillatorNode(ctx, { type: 'triangle', frequency });
  const sub = new OscillatorNode(ctx, { frequency });
  const filter = new BiquadFilterNode(ctx, { type: 'lowpass', Q: 0.8, frequency: 300 });
  filter.frequency.setValueAtTime(950 * note.velocity + 250, start);
  filter.frequency.setTargetAtTime(280, start, 0.14);
  const amp = new GainNode(ctx, { gain: 0 });
  amp.gain.setValueAtTime(0, start);
  amp.gain.linearRampToValueAtTime(0.28 * note.velocity, start + 0.006);
  amp.gain.setTargetAtTime(0, start + 0.006, 0.65);
  amp.gain.setTargetAtTime(0, end, 0.05);
  const subLevel = new GainNode(ctx, { gain: 0.7 });
  body.connect(filter);
  sub.connect(subLevel).connect(filter);
  filter.connect(amp).connect(out);
  for (const osc of [body, sub]) {
    osc.start(start);
    osc.stop(end + 0.4);
  }
}

/** Vibraphone bar: fundamental plus the 4th and 10th partials that tuned bars ring with. */
export function playVibes(
  ctx: BaseAudioContext,
  out: AudioNode,
  note: NoteEvent,
  clock: RenderClock,
): void {
  const start = note.time * clock.secondsPerBeat;
  const end = start + note.duration * clock.secondsPerBeat;
  const frequency = midiToHz(note.midi);
  const partials: readonly (readonly [number, number, number])[] = [
    [1, 1, 2.6],
    [4, 0.22, 0.7],
    [10, 0.05, 0.18],
  ];
  for (const [ratio, level, t60] of partials) {
    const osc = new OscillatorNode(ctx, { frequency: frequency * ratio });
    const amp = new GainNode(ctx, { gain: 0 });
    const peak = 0.5 * note.velocity * level;
    const ring = Math.min(t60, end - start + DAMPER_SECONDS);
    amp.gain.setValueAtTime(0, start);
    amp.gain.linearRampToValueAtTime(peak, start + 0.002);
    amp.gain.exponentialRampToValueAtTime(peak * SILENT, start + 0.002 + ring);
    osc.connect(amp).connect(out);
    osc.start(start);
    osc.stop(start + 0.01 + ring);
  }
}

export function playDrum(
  ctx: BaseAudioContext,
  out: AudioNode,
  hit: DrumEvent,
  clock: RenderClock,
  noise: AudioBuffer,
): void {
  const start = hit.time * clock.secondsPerBeat;
  switch (hit.kind) {
    case 'kick': {
      const osc = new OscillatorNode(ctx, { frequency: 120 });
      osc.frequency.setValueAtTime(120, start);
      osc.frequency.exponentialRampToValueAtTime(48, start + 0.09);
      const amp = new GainNode(ctx, { gain: 0 });
      amp.gain.setValueAtTime(0.75 * hit.velocity, start);
      amp.gain.exponentialRampToValueAtTime(0.75 * hit.velocity * SILENT, start + 0.3);
      osc.connect(amp).connect(out);
      osc.start(start);
      osc.stop(start + 0.32);
      return;
    }
    case 'rim': {
      const tone = new OscillatorNode(ctx, { type: 'triangle', frequency: 1720 });
      const toneAmp = new GainNode(ctx, { gain: 0 });
      toneAmp.gain.setValueAtTime(0.3 * hit.velocity, start);
      toneAmp.gain.exponentialRampToValueAtTime(0.3 * hit.velocity * SILENT, start + 0.035);
      tone.connect(toneAmp).connect(out);
      tone.start(start);
      tone.stop(start + 0.04);
      playNoise(ctx, out, noise, start, 0.2 * hit.velocity, 0.03, [
        { type: 'bandpass', frequency: 2600, Q: 3 },
      ]);
      return;
    }
    case 'shaker':
      playNoise(ctx, out, noise, start, 0.16 * hit.velocity, 0.055, [
        { type: 'highpass', frequency: 5200 },
        { type: 'peaking', frequency: 8500, Q: 0.8, gain: 4 },
      ]);
      return;
  }
}

function playNoise(
  ctx: BaseAudioContext,
  out: AudioNode,
  noise: AudioBuffer,
  start: number,
  peak: number,
  t60: number,
  filters: readonly BiquadFilterOptions[],
): void {
  const source = new AudioBufferSourceNode(ctx, { buffer: noise });
  const amp = new GainNode(ctx, { gain: 0 });
  amp.gain.setValueAtTime(0, start);
  amp.gain.linearRampToValueAtTime(peak, start + 0.004);
  amp.gain.exponentialRampToValueAtTime(peak * SILENT, start + 0.004 + t60);
  let chain: AudioNode = source;
  for (const options of filters) chain = chain.connect(new BiquadFilterNode(ctx, options));
  chain.connect(amp).connect(out);
  const offset = (start * 7.31) % Math.max(0.001, noise.duration - t60 - 0.01);
  source.start(start, offset);
  source.stop(start + 0.01 + t60);
}

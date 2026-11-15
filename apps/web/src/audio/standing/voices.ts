import { midiToHz } from '../music/theory.ts';
import { scheduleDecayingSine, scheduleNoiseBurst, SourceVoice } from '../synth/voice.ts';
import type { AchievementChimeSpec } from './chime.ts';
import {
  BELL_PARTIALS,
  fanfareNoteCost,
  hasVibrato,
  nyquistCeiling,
  type FanfareNote,
  type RankUpFanfareSpec,
} from './fanfare.ts';
import { trinketRatios, type FootstepHit, type StaffWalkSpec } from './footsteps.ts';

const SILENT = 0.001;
const TAIL = 0.01;
/** Brass speaks a touch flat and scoops up to pitch, which is what makes a synth horn read as a horn. */
const BRASS_SCOOP = 0.985;
const BRASS_SCOOP_SECONDS = 0.035;
const BRASS_ATTACK = 0.018;
const BRASS_RELEASE_TAU = 0.08;
const VIBRATO_HZ = 5.2;
const VIBRATO_DEPTH = 0.004;
const VIBRATO_DELAY = 0.18;

/** Routes a note through its own panner only when it sits off centre, so centred notes cost no extra node. */
function noteOutput(voice: SourceVoice, pan: number): AudioNode {
  if (pan === 0) return voice.output;
  const panner = new StereoPannerNode(voice.context, { pan });
  panner.connect(voice.output);
  return panner;
}

function playBrass(voice: SourceVoice, note: FanfareNote, brightness: number, when: number): void {
  const ctx = voice.context;
  const ceiling = nyquistCeiling(ctx.sampleRate);
  const frequency = midiToHz(note.midi);
  const start = when + note.at;
  const end = start + note.duration;
  const horn = new OscillatorNode(ctx, { type: 'sawtooth', frequency: frequency * BRASS_SCOOP });
  horn.frequency.setValueAtTime(frequency * BRASS_SCOOP, start);
  horn.frequency.exponentialRampToValueAtTime(frequency, start + BRASS_SCOOP_SECONDS);

  const bell = new BiquadFilterNode(ctx, { type: 'lowpass', Q: 0.9, frequency: frequency * 1.5 });
  const open = Math.min(ceiling, frequency * (2.5 + 5 * note.velocity * brightness));
  bell.frequency.setValueAtTime(Math.min(ceiling, frequency * 1.5), start);
  bell.frequency.exponentialRampToValueAtTime(open, start + BRASS_ATTACK * 2);
  bell.frequency.setTargetAtTime(
    Math.min(ceiling, frequency * 2.4),
    start + BRASS_ATTACK * 2,
    0.25,
  );

  const amp = new GainNode(ctx, { gain: 0 });
  const peak = 0.3 * note.velocity;
  amp.gain.setValueAtTime(0, start);
  amp.gain.linearRampToValueAtTime(peak, start + BRASS_ATTACK);
  amp.gain.setTargetAtTime(peak * 0.72, start + BRASS_ATTACK, 0.15);
  amp.gain.setTargetAtTime(0, end, BRASS_RELEASE_TAU);
  horn.connect(bell).connect(amp).connect(noteOutput(voice, note.pan));
  const stopAt = end + BRASS_RELEASE_TAU * 7;
  horn.start(start);
  voice.track(horn, stopAt);

  if (hasVibrato(note)) {
    const lfo = new OscillatorNode(ctx, { frequency: VIBRATO_HZ });
    const depth = new GainNode(ctx, { gain: 0 });
    depth.gain.setValueAtTime(0, start);
    depth.gain.linearRampToValueAtTime(frequency * VIBRATO_DEPTH, start + VIBRATO_DELAY);
    lfo.connect(depth).connect(horn.frequency);
    lfo.start(start);
    voice.track(lfo, stopAt);
  }
}

function playBass(voice: SourceVoice, note: FanfareNote, when: number): void {
  const ctx = voice.context;
  const frequency = midiToHz(note.midi);
  const start = when + note.at;
  const end = start + note.duration;
  const body = new OscillatorNode(ctx, { type: 'triangle', frequency });
  const filter = new BiquadFilterNode(ctx, { type: 'lowpass', Q: 0.8, frequency: 300 });
  filter.frequency.setValueAtTime(900 * note.velocity + 250, start);
  filter.frequency.setTargetAtTime(280, start, 0.14);
  const amp = new GainNode(ctx, { gain: 0 });
  amp.gain.setValueAtTime(0, start);
  amp.gain.linearRampToValueAtTime(0.5 * note.velocity, start + 0.006);
  amp.gain.setTargetAtTime(0.32 * note.velocity, start + 0.006, 0.3);
  amp.gain.setTargetAtTime(0, end, 0.06);
  body.connect(filter).connect(amp).connect(noteOutput(voice, note.pan));
  body.start(start);
  voice.track(body, end + 0.45);
}

function playTimpani(
  voice: SourceVoice,
  note: FanfareNote,
  noise: AudioBuffer,
  when: number,
): void {
  const ctx = voice.context;
  const frequency = midiToHz(note.midi);
  const start = when + note.at;
  const ring = note.duration * (0.6 + 0.4 * note.velocity);
  const drum = new OscillatorNode(ctx, { frequency: frequency * 1.06 });
  drum.frequency.setValueAtTime(frequency * 1.06, start);
  drum.frequency.exponentialRampToValueAtTime(frequency, start + 0.08);
  const amp = new GainNode(ctx, { gain: 0 });
  amp.gain.setValueAtTime(0, start);
  amp.gain.linearRampToValueAtTime(0.7 * note.velocity, start + 0.003);
  amp.gain.exponentialRampToValueAtTime(0.7 * note.velocity * SILENT, start + ring);
  const out = noteOutput(voice, note.pan);
  drum.connect(amp).connect(out);
  drum.start(start);
  voice.track(drum, start + ring + TAIL);
  scheduleNoiseBurst(
    voice,
    noise,
    note.noiseOffset,
    { type: 'lowpass', frequency: 700 + 600 * note.velocity, Q: 0.7 },
    0.35 * note.velocity,
    0.12,
    start,
  );
}

function playBell(voice: SourceVoice, note: FanfareNote, when: number): void {
  const ceiling = nyquistCeiling(voice.context.sampleRate);
  const frequency = midiToHz(note.midi);
  const out = noteOutput(voice, note.pan);
  for (const partial of BELL_PARTIALS) {
    if (frequency * partial.ratio >= ceiling) continue;
    scheduleDecayingSine(
      voice,
      frequency * partial.ratio,
      0.22 * note.velocity * partial.amplitude,
      note.duration * partial.t60,
      when + note.at,
      out,
    );
  }
}

export function startFanfareVoice(
  ctx: BaseAudioContext,
  spec: RankUpFanfareSpec,
  destination: AudioNode,
  noise: AudioBuffer,
  when: number,
): SourceVoice {
  const voice = new SourceVoice(ctx, spec.priority, when, spec.gain, 0, destination);
  for (const note of spec.notes) {
    if (fanfareNoteCost(note, ctx.sampleRate) === 0) continue;
    switch (note.instrument) {
      case 'brass':
        playBrass(voice, note, spec.brightness, when);
        break;
      case 'bass':
        playBass(voice, note, when);
        break;
      case 'timpani':
        playTimpani(voice, note, noise, when);
        break;
      case 'bell':
        playBell(voice, note, when);
        break;
    }
  }
  return voice;
}

export function startChimeVoice(
  ctx: BaseAudioContext,
  spec: AchievementChimeSpec,
  destination: AudioNode,
  when: number,
): SourceVoice {
  const voice = new SourceVoice(ctx, spec.priority, when, spec.gain, spec.pan, destination);
  for (const note of spec.notes) {
    for (const partial of note.partials) {
      scheduleDecayingSine(
        voice,
        partial.frequency,
        partial.amplitude * note.velocity,
        partial.t60,
        when + note.at,
      );
    }
  }
  return voice;
}

function playFootfall(
  voice: SourceVoice,
  spec: StaffWalkSpec,
  step: FootstepHit,
  noise: AudioBuffer,
  when: number,
): void {
  const ctx = voice.context;
  const { heel, toe, body, trinket } = spec.profile;
  const start = when + step.at;
  const out = noteOutput(voice, step.pan);
  const level = new GainNode(ctx, { gain: step.level });
  level.connect(out);

  for (const [layer, offset] of [
    [heel, step.heelOffset],
    [toe, step.toeOffset],
  ] as const) {
    const source = new AudioBufferSourceNode(ctx, { buffer: noise });
    const filter = new BiquadFilterNode(ctx, {
      type: layer.filter,
      frequency: layer.frequency * step.pitch,
      Q: layer.q,
    });
    const envelope = new GainNode(ctx, { gain: 0 });
    const at = start + layer.delay;
    envelope.gain.setValueAtTime(layer.gain, at);
    envelope.gain.exponentialRampToValueAtTime(layer.gain * SILENT, at + layer.t60);
    source.connect(filter).connect(envelope).connect(level);
    source.start(at, offset * Math.max(0, noise.duration - layer.t60 - TAIL));
    voice.track(source, at + layer.t60 + TAIL);
  }

  const thump = new OscillatorNode(ctx, { frequency: body.frequency * step.pitch });
  thump.frequency.setValueAtTime(body.frequency * step.pitch, start);
  thump.frequency.exponentialRampToValueAtTime(body.endFrequency * step.pitch, start + body.t60);
  const thumpAmp = new GainNode(ctx, { gain: 0 });
  thumpAmp.gain.setValueAtTime(0, start);
  thumpAmp.gain.linearRampToValueAtTime(body.gain, start + 0.004);
  thumpAmp.gain.exponentialRampToValueAtTime(body.gain * SILENT, start + body.t60);
  thump.connect(thumpAmp).connect(level);
  thump.start(start);
  voice.track(thump, start + body.t60 + TAIL);

  if (trinket && step.trinket) {
    const ratios = trinketRatios(spec.profile, step.pitch, ctx.sampleRate);
    for (const [i, ratio] of ratios.entries()) {
      scheduleDecayingSine(
        voice,
        trinket.frequency * ratio * step.pitch,
        trinket.gain / (1 + i * 0.6),
        trinket.t60 / (1 + i * 0.4),
        start + trinket.delay + i * 0.006,
        level,
      );
    }
  }
}

export function startStaffWalkVoice(
  ctx: BaseAudioContext,
  spec: StaffWalkSpec,
  destination: AudioNode,
  noise: AudioBuffer,
  when: number,
): SourceVoice {
  const voice = new SourceVoice(ctx, spec.priority, when, spec.gain, 0, destination);
  for (const step of spec.steps) playFootfall(voice, spec, step, noise, when);
  return voice;
}

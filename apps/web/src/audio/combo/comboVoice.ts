import { scheduleDecayingSine, SourceVoice } from '../synth/voice.ts';
import { VoicePriority } from '../voicePool.ts';
import type { ComboNote, ComboTone } from './ladder.ts';

const MODULATOR_RATIOS = [4, 2, 1];
/** Keep FM carriers, modulators and partials well clear of Nyquist so nothing aliases or clamps. */
const NYQUIST_MARGIN = 0.8;
const MAX_INDEX = 1.8;
const INDEX_T60 = 0.35;
const COMBO_LEVEL = 0.32;
const SHIMMER_RATIO = 2.76;

interface PlannedTone {
  readonly tone: ComboTone;
  readonly ratio: number;
  readonly shimmer: boolean;
}

function planTones(note: ComboNote, sampleRate: number): PlannedTone[] {
  const ceiling = (sampleRate / 2) * NYQUIST_MARGIN;
  return note.tones
    .filter((tone) => tone.frequency < ceiling)
    .map((tone) => ({
      tone,
      ratio: MODULATOR_RATIOS.find((r) => tone.frequency * r < ceiling) ?? 1,
      shimmer: tone.frequency * SHIMMER_RATIO < ceiling,
    }));
}

/** Carrier and modulator per tone, plus the shimmer partial where it fits under Nyquist. */
export function comboVoiceCost(note: ComboNote, sampleRate: number): number {
  return planTones(note, sampleRate).reduce((sum, t) => sum + (t.shimmer ? 3 : 2), 0);
}

/**
 * Two-operator FM bell: the 4:1 modulator gives a celesta-like strike that melts into a pure
 * sine, which reads as "reward" over the dense metallic coin bed.
 */
export function startComboVoice(
  ctx: BaseAudioContext,
  note: ComboNote,
  destination: AudioNode,
  when: number,
  pan = 0,
): SourceVoice {
  const voice = new SourceVoice(ctx, VoicePriority.combo, when, COMBO_LEVEL, pan, destination);
  for (const { tone, ratio, shimmer: withShimmer } of planTones(note, ctx.sampleRate)) {
    const carrier = new OscillatorNode(ctx, { frequency: tone.frequency });
    const modulator = new OscillatorNode(ctx, { frequency: tone.frequency * ratio });
    const depth = new GainNode(ctx, { gain: 0 });
    const peakDepth = tone.frequency * MAX_INDEX * note.brightness;
    depth.gain.setValueAtTime(peakDepth, when);
    depth.gain.exponentialRampToValueAtTime(peakDepth * 0.001, when + INDEX_T60);
    const envelope = new GainNode(ctx, { gain: 0 });
    envelope.gain.setValueAtTime(0, when);
    envelope.gain.linearRampToValueAtTime(tone.gain, when + 0.002);
    envelope.gain.exponentialRampToValueAtTime(tone.gain * 0.001, when + note.t60);
    modulator.connect(depth).connect(carrier.frequency);
    carrier.connect(envelope).connect(voice.output);
    const stopAt = when + note.t60 + 0.01;
    modulator.start(when);
    carrier.start(when);
    voice.track(modulator, stopAt);
    voice.track(carrier, stopAt);
    if (withShimmer) {
      const shimmer = tone.gain * 0.12 * note.brightness;
      scheduleDecayingSine(voice, tone.frequency * SHIMMER_RATIO, shimmer, 0.4, when);
    }
  }
  return voice;
}

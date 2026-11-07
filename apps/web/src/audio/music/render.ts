import { createRng } from '../rng.ts';
import { createNoiseBuffer, createRoomImpulse } from '../synth/buffers.ts';
import { playBass, playDrum, playKeys, playVibes, type RenderClock } from './instruments.ts';
import { RIVIERA_LAYERS, type LayerSpec, type StemId } from './layers.ts';
import { composeRiviera, loopSeconds, type Composition } from './riviera.ts';

/** Long enough for the reverb and the longest vibes ring to die below audibility. */
export const LOOP_TAIL_SECONDS = 2.5;
const ROOM_T60 = 1.8;

export interface MusicTrack {
  readonly name: string;
  readonly loopDuration: number;
  readonly stems: Readonly<Record<StemId, AudioBuffer>>;
  readonly layers: readonly LayerSpec[];
}

/**
 * Mixes everything rendered past the loop point back onto the start, so notes and reverb that
 * ring across the loop boundary continue seamlessly on the next pass instead of being cut.
 */
export function foldLoopTail(
  rendered: Float32Array,
  loopLength: number,
): Float32Array<ArrayBuffer> {
  if (!Number.isInteger(loopLength) || loopLength < 1) {
    throw new RangeError(`Loop length must be a positive sample count, got ${loopLength}`);
  }
  const loop = rendered.slice(0, loopLength);
  for (let i = loopLength; i < rendered.length; i++) {
    const target = (i - loopLength) % loopLength;
    loop[target] = (loop[target] ?? 0) + (rendered[i] ?? 0);
  }
  return loop;
}

interface StemRecipe {
  readonly wet: number;
  readonly lowpass: number;
  /** Vibraphone motor tremolo; 0 for none. */
  readonly tremolo: number;
  play(ctx: BaseAudioContext, out: AudioNode, clock: RenderClock, noise: AudioBuffer): void;
}

function recipes(composition: Composition): Record<StemId, StemRecipe> {
  return {
    keys: {
      wet: 0.24,
      lowpass: 3400,
      tremolo: 0,
      play: (ctx, out, clock) => {
        for (const note of composition.keys) playKeys(ctx, out, note, clock);
      },
    },
    bass: {
      wet: 0.05,
      lowpass: 1800,
      tremolo: 0,
      play: (ctx, out, clock) => {
        for (const note of composition.bass) playBass(ctx, out, note, clock);
      },
    },
    drums: {
      wet: 0.14,
      lowpass: 14000,
      tremolo: 0,
      play: (ctx, out, clock, noise) => {
        for (const hit of composition.drums) playDrum(ctx, out, hit, clock, noise);
      },
    },
    vibes: {
      wet: 0.32,
      lowpass: 9000,
      tremolo: 0.22,
      play: (ctx, out, clock) => {
        for (const note of composition.vibes) playVibes(ctx, out, note, clock);
      },
    },
  };
}

async function renderStem(
  recipe: StemRecipe,
  sampleRate: number,
  loopLength: number,
  clock: RenderClock,
  seed: number,
): Promise<Float32Array<ArrayBuffer>> {
  const length = loopLength + Math.ceil(LOOP_TAIL_SECONDS * sampleRate);
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length, sampleRate });
  const rng = createRng(seed);
  const bus = new GainNode(ctx, { gain: 1 });
  const tone = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: recipe.lowpass, Q: 0.5 });
  const room = new ConvolverNode(ctx, { buffer: createRoomImpulse(ctx, ROOM_T60, 1, rng) });
  const wet = new GainNode(ctx, { gain: recipe.wet });
  bus.connect(tone).connect(ctx.destination);
  tone.connect(room).connect(wet).connect(ctx.destination);
  if (recipe.tremolo > 0) {
    bus.gain.value = 1 - recipe.tremolo;
    const lfo = new OscillatorNode(ctx, { frequency: 5.2 });
    const depth = new GainNode(ctx, { gain: recipe.tremolo });
    lfo.connect(depth).connect(bus.gain);
    lfo.start(0);
  }
  recipe.play(ctx, bus, clock, createNoiseBuffer(ctx, 1, rng));
  const rendered = await ctx.startRendering();
  return foldLoopTail(rendered.getChannelData(0), loopLength);
}

/**
 * Renders the Riviera stems once, off the realtime thread, into mono loop buffers. Mono stems
 * halve memory and stay mono-safe; width comes from panning each stem in the director.
 */
export async function renderRivieraTrack(ctx: BaseAudioContext): Promise<MusicTrack> {
  const composition = composeRiviera();
  const loopDuration = loopSeconds(composition);
  const loopLength = Math.round(loopDuration * ctx.sampleRate);
  const clock: RenderClock = { secondsPerBeat: 60 / composition.bpm };
  const recipeTable = recipes(composition);
  const stems: Partial<Record<StemId, AudioBuffer>> = {};
  let seed = 101;
  for (const layer of RIVIERA_LAYERS) {
    const data = await renderStem(
      recipeTable[layer.stem],
      ctx.sampleRate,
      loopLength,
      clock,
      seed++,
    );
    const buffer = ctx.createBuffer(1, loopLength, ctx.sampleRate);
    buffer.copyToChannel(data, 0);
    stems[layer.stem] = buffer;
  }
  return {
    name: 'Riviera Lounge',
    loopDuration: loopLength / ctx.sampleRate,
    stems: completeStems(stems),
    layers: RIVIERA_LAYERS,
  };
}

function completeStems(stems: Partial<Record<StemId, AudioBuffer>>): Record<StemId, AudioBuffer> {
  const { keys, bass, drums, vibes } = stems;
  if (!keys || !bass || !drums || !vibes) {
    throw new Error(
      'Riviera render is missing a stem: every StemId needs a layer in RIVIERA_LAYERS',
    );
  }
  return { keys, bass, drums, vibes };
}

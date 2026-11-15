import { PRIZE_FAMILIES } from '@coinposh/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Mixer } from '../mixer.ts';
import { FAKE_AUDIO_GLOBALS, FakeAudioContext, FakeNode } from '../music/adaptive/fakeAudio.ts';
import type { PumpTimer } from '../music/adaptive/player.ts';
import { createRng } from '../rng.ts';
import { IMPACT_VELOCITY_CEIL } from '../synth/impactSpec.ts';
import {
  AMBIENCE_FADE_IN_SECONDS,
  AMBIENCE_LEVEL,
  CELLAR_EVENT_GAP,
  CELLAR_PUMP_MS,
} from './cellar.ts';
import {
  COLLECTING_MAX_VOICES,
  COLLECTING_SOURCE_BUDGET,
  createCollectingAudio,
  PRIZE_RETRIGGER_SECONDS,
  type CollectingAudio,
} from './index.ts';

/** The shared fake runs at 8 kHz, where every shimmer partial would sit above Nyquist. */
function wideFakeContext(): FakeAudioContext {
  const ctx = new FakeAudioContext();
  Object.defineProperty(ctx, 'sampleRate', { value: 48000 });
  return ctx;
}

function suspend(ctx: FakeAudioContext): void {
  Object.defineProperty(ctx, 'state', { value: 'suspended' });
}

class RecordingSource extends FAKE_AUDIO_GLOBALS.AudioBufferSourceNode {
  readonly options: Record<string, unknown>;
  constructor(ctx: FakeAudioContext, options: Record<string, unknown> = {}) {
    super(ctx, options);
    this.options = options;
  }
}

/** SourceVoice reaches its context through `node.context`, which the shared fake leaves out. */
class ContextGain extends FAKE_AUDIO_GLOBALS.GainNode {
  get context(): FakeAudioContext {
    return this.ctx;
  }
}

function stubAudioGlobals(): void {
  for (const [name, value] of Object.entries(FAKE_AUDIO_GLOBALS)) vi.stubGlobal(name, value);
  vi.stubGlobal('GainNode', ContextGain);
  vi.stubGlobal('AudioBufferSourceNode', RecordingSource);
}

interface Rig {
  readonly ctx: FakeAudioContext;
  readonly mixer: Mixer;
  readonly audio: CollectingAudio;
  readonly pump: { tick: (() => void) | null; ms: number };
  /** Moves the audio clock and fires the cellar timer the way a browser would. */
  readonly advance: (seconds: number) => void;
}

function rig(seed = 1): Rig {
  const ctx = wideFakeContext();
  const context = ctx as unknown as BaseAudioContext;
  const mixer = new Mixer(context, createRng(seed));
  const pump: Rig['pump'] = { tick: null, ms: 0 };
  const timer: PumpTimer = (ms, tick) => {
    pump.tick = tick;
    pump.ms = ms;
    return () => {
      pump.tick = null;
    };
  };
  const audio = createCollectingAudio(
    { context, buses: { sfx: mixer.sfx, music: mixer.music } },
    { rng: createRng(seed + 1), timer },
  );
  return {
    ctx,
    mixer,
    audio,
    pump,
    advance: (seconds) => {
      const end = ctx.currentTime + seconds;
      while (ctx.currentTime < end - 1e-9) {
        ctx.currentTime = Math.min(end, ctx.currentTime + CELLAR_PUMP_MS / 1000);
        pump.tick?.();
      }
    },
  };
}

const asFake = (node: AudioNode) => node as unknown as FakeNode;
const nodesOf = (ctx: FakeAudioContext, kind: string, from = 0) =>
  ctx.nodes.slice(from).filter((node) => node.kind === kind);

function reaches(from: FakeNode, target: FakeNode): boolean {
  const seen = new Set<FakeNode>();
  const queue = [from];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || seen.has(node)) continue;
    if (node === target) return true;
    seen.add(node);
    for (const out of node.outputs) if (out instanceof FakeNode) queue.push(out);
  }
  return false;
}

describe('createCollectingAudio', () => {
  beforeEach(() => {
    stubAudioGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('plays prize impacts and shimmers straight into the SFX bus', () => {
    const { ctx, mixer, audio } = rig();
    const before = ctx.nodes.length;
    for (const family of PRIZE_FAMILIES) {
      expect(audio.playPrizeImpact(family, 1.4, 0.2)).toBe(true);
    }
    expect(audio.playVariantShimmer('foil')).toBe(true);
    const panners = nodesOf(ctx, 'StereoPannerNode', before);
    expect(panners).toHaveLength(PRIZE_FAMILIES.length + 1);
    for (const panner of panners) expect(panner.outputs).toEqual([asFake(mixer.sfx)]);
    expect(audio.activeSources).toBeLessThanOrEqual(COLLECTING_SOURCE_BUDGET);
  });

  it('stays silent for the plain strike', () => {
    const { ctx, audio } = rig();
    const before = ctx.nodes.length;
    expect(audio.playVariantShimmer('none')).toBe(false);
    expect(ctx.nodes.length).toBe(before);
  });

  it('plays nothing and builds no nodes until audio is unlocked', () => {
    const { ctx, audio } = rig();
    suspend(ctx);
    const before = ctx.nodes.length;
    expect(audio.playPrizeImpact('watch', 2)).toBe(false);
    expect(audio.playVariantShimmer('proof')).toBe(false);
    expect(ctx.nodes.length).toBe(before);
  });

  it('never schedules a voice into the past', () => {
    const { ctx, audio } = rig();
    ctx.currentTime = 3.25;
    const from = ctx.calls.length;
    audio.playPrizeImpact('carKeys', IMPACT_VELOCITY_CEIL);
    audio.playVariantShimmer('misprint');
    const starts = ctx.calls.slice(from).filter((call) => call.what.endsWith('.start'));
    expect(starts.length).toBeGreaterThan(0);
    for (const call of starts) expect(call.time).toBeGreaterThanOrEqual(3.25);
  });

  it('ignores softer bounce repeats of one prize but lets a harder hit or a later one through', () => {
    const { ctx, audio } = rig();
    ctx.currentTime = 1;
    expect(audio.playPrizeImpact('watch', 1)).toBe(true);
    ctx.currentTime += PRIZE_RETRIGGER_SECONDS / 3;
    expect(audio.playPrizeImpact('watch', 0.6)).toBe(false);
    expect(audio.playPrizeImpact('perfume', 0.6)).toBe(true);
    expect(audio.playPrizeImpact('watch', 2)).toBe(true);
    ctx.currentTime += PRIZE_RETRIGGER_SECONDS * 1.1;
    expect(audio.playPrizeImpact('watch', 0.3)).toBe(true);
  });

  it('caps its voices and sources however many prizes land at once', () => {
    const { ctx, audio } = rig();
    let refused = 0;
    for (let i = 0; i < 60; i++) {
      ctx.currentTime = 1 + i * 0.02;
      const family = PRIZE_FAMILIES[i % PRIZE_FAMILIES.length] ?? 'watch';
      if (!audio.playPrizeImpact(family, IMPACT_VELOCITY_CEIL)) refused++;
      if (i % 3 === 0 && !audio.playVariantShimmer('foil')) refused++;
      expect(audio.activeVoices).toBeLessThanOrEqual(COLLECTING_MAX_VOICES);
      expect(audio.activeSources).toBeLessThanOrEqual(COLLECTING_SOURCE_BUDGET);
    }
    expect(refused).toBe(0);
    expect(audio.activeSources).toBeGreaterThan(COLLECTING_SOURCE_BUDGET / 2);
  });

  it('lets a variant shimmer steal a prize voice when the pool is full', () => {
    const { ctx, audio } = rig();
    ctx.currentTime = 1;
    for (let i = 0; i < COLLECTING_MAX_VOICES; i++) {
      expect(audio.playPrizeImpact('perfume', 0.5)).toBe(true);
      ctx.currentTime += PRIZE_RETRIGGER_SECONDS * 1.01;
    }
    expect(audio.activeVoices).toBe(COLLECTING_MAX_VOICES);
    const sourcesBefore = audio.activeSources;
    expect(audio.playVariantShimmer('misprint')).toBe(true);
    expect(audio.activeVoices).toBe(COLLECTING_MAX_VOICES);
    expect(audio.activeSources).toBeLessThan(sourcesBefore);
  });

  it('releases every voice and refuses new sounds once disposed', () => {
    const { audio } = rig();
    audio.playPrizeImpact('watch', 1);
    audio.startCellarAmbience();
    audio.dispose();
    expect(audio.activeVoices).toBe(0);
    expect(audio.cellarPlaying).toBe(false);
    expect(audio.playPrizeImpact('perfume', 1)).toBe(false);
    expect(audio.playVariantShimmer('foil')).toBe(false);
    expect(() => {
      audio.startCellarAmbience();
    }).toThrow(/disposed/);
    expect(() => {
      audio.dispose();
    }).not.toThrow();
  });
});

describe('cellar ambience', () => {
  beforeEach(() => {
    stubAudioGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function bedSource(ctx: FakeAudioContext, from: number): RecordingSource {
    const source = nodesOf(ctx, 'AudioBufferSourceNode', from).find(
      (node): node is RecordingSource =>
        node instanceof RecordingSource && node.options.loop === true,
    );
    if (!source) throw new Error('expected a looping bed source');
    return source;
  }

  it('loops the bed on the music bus and fades it in', () => {
    const { ctx, mixer, audio } = rig();
    ctx.currentTime = 2;
    const from = ctx.nodes.length;
    audio.startCellarAmbience();
    expect(audio.cellarPlaying).toBe(true);
    const source = bedSource(ctx, from);
    expect(source.buffer?.numberOfChannels).toBe(2);
    const fader = source.outputs[0];
    if (!(fader instanceof FakeNode)) throw new Error('the bed should feed its fader');
    expect(fader.outputs).toContain(asFake(mixer.music));
    expect(reaches(source, asFake(mixer.sfx))).toBe(false);
    expect(fader.gain.valueAt(2)).toBe(0);
    expect(fader.gain.valueAt(2 + AMBIENCE_FADE_IN_SECONDS)).toBeCloseTo(AMBIENCE_LEVEL, 9);
  });

  it('starts once however often it is asked, and reuses its rendered bed', () => {
    const { ctx, audio } = rig();
    const from = ctx.nodes.length;
    audio.startCellarAmbience();
    audio.startCellarAmbience();
    expect(nodesOf(ctx, 'AudioBufferSourceNode', from)).toHaveLength(1);
    const first = bedSource(ctx, from).buffer;
    audio.stopCellarAmbience(0.5);
    const again = ctx.nodes.length;
    audio.startCellarAmbience();
    expect(bedSource(ctx, again).buffer).toBe(first);
  });

  it('fades out and stops the loop on stop, and rejects a bad fade', () => {
    const { ctx, audio } = rig();
    const from = ctx.nodes.length;
    audio.startCellarAmbience();
    ctx.currentTime = 5;
    expect(() => {
      audio.stopCellarAmbience(-1);
    }).toThrow(/fade/);
    audio.stopCellarAmbience(1.2);
    expect(audio.cellarPlaying).toBe(false);
    const source = bedSource(ctx, from);
    const fader = source.outputs[0];
    if (!(fader instanceof FakeNode)) throw new Error('the bed should feed its fader');
    expect(fader.gain.valueAt(5)).toBeCloseTo(AMBIENCE_LEVEL, 6);
    expect(fader.gain.valueAt(6.2)).toBe(0);
    const stops = ctx.calls.filter((call) => call.what === 'AudioBufferSourceNode.stop');
    expect(stops.at(-1)?.time).toBeCloseTo(6.22, 9);
    expect(() => {
      audio.stopCellarAmbience();
    }).not.toThrow();
  });

  it('drips and clinks at irregular gaps, never in the past, while it plays', () => {
    const { ctx, audio, pump, advance } = rig();
    audio.startCellarAmbience();
    expect(pump.ms).toBe(CELLAR_PUMP_MS);
    const from = ctx.calls.length;
    const seconds = 60;
    advance(seconds);
    const starts = ctx.calls
      .slice(from)
      .filter((call) => call.what === 'OscillatorNode.start')
      .map((call) => call.time);
    const events = new Set(starts.map((t) => t.toFixed(6)));
    const [minGap, maxGap] = CELLAR_EVENT_GAP;
    expect(events.size).toBeGreaterThanOrEqual(Math.floor(seconds / maxGap) - 1);
    expect(events.size).toBeLessThanOrEqual(Math.ceil(seconds / minGap) + 1);
    for (const call of ctx.calls.slice(from).filter((c) => c.what === 'OscillatorNode.start')) {
      expect(call.time).toBeGreaterThanOrEqual(call.calledAt);
    }
    audio.stopCellarAmbience();
    expect(pump.tick).toBeNull();
  });

  it('schedules no drips while the context is suspended', () => {
    const { ctx, audio, advance } = rig();
    audio.startCellarAmbience();
    suspend(ctx);
    const from = ctx.calls.length;
    advance(30);
    expect(ctx.calls.slice(from).some((call) => call.what === 'OscillatorNode.start')).toBe(false);
  });

  it('never steals a ringing prize or shimmer voice for a drip', () => {
    const { ctx, mixer, audio, advance } = rig();
    audio.startCellarAmbience();
    const from = ctx.nodes.length;
    for (let step = 0; step < 24; step++) {
      for (let i = 0; i < COLLECTING_MAX_VOICES; i++) audio.playVariantShimmer('proof');
      expect(audio.activeVoices).toBe(COLLECTING_MAX_VOICES);
      advance(0.5);
    }
    const drips = nodesOf(ctx, 'StereoPannerNode', from).filter(
      (panner) => !panner.outputs.includes(asFake(mixer.sfx)),
    );
    expect(drips).toHaveLength(0);
  });
});

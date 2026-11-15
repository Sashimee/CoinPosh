import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONCIERGE_EXPRESSIONS } from '../../game/concierge/lines.ts';
import { Mixer } from '../mixer.ts';
import {
  FAKE_AUDIO_GLOBALS,
  FakeAudioContext,
  FakeNode,
  type FakeParam,
} from '../music/adaptive/fakeAudio.ts';
import { createRng, dbToGain } from '../rng.ts';
import {
  CONCIERGE_DUCK_DB,
  CONCIERGE_DUCK_DEFAULTS,
  createConciergeVoice,
  type ConciergeVoice,
} from './index.ts';

/** SourceVoice reaches its context through `node.context`, which the shared fake leaves out. */
class ContextGain extends FAKE_AUDIO_GLOBALS.GainNode {
  get context(): FakeAudioContext {
    return this.ctx;
  }
}

class TypedOscillator extends FAKE_AUDIO_GLOBALS.OscillatorNode {
  readonly type: unknown;
  constructor(ctx: FakeAudioContext, options: Record<string, unknown> = {}) {
    super(ctx, options);
    this.type = options.type ?? 'sine';
  }
}

function stubAudioGlobals(): void {
  for (const [name, value] of Object.entries(FAKE_AUDIO_GLOBALS)) vi.stubGlobal(name, value);
  vi.stubGlobal('GainNode', ContextGain);
  vi.stubGlobal('OscillatorNode', TypedOscillator);
}

interface Rig {
  readonly ctx: FakeAudioContext;
  readonly mixer: Mixer;
  readonly voice: ConciergeVoice;
  /** The gain node the voice built right after its host wiring: the stinger ducker. */
  readonly ducker: FakeNode;
}

function rig(seed = 1, ctx = new FakeAudioContext()): Rig {
  const context = ctx as unknown as BaseAudioContext;
  const mixer = new Mixer(context, createRng(seed));
  const before = ctx.nodes.length;
  const voice = createConciergeVoice({ context, sfxBus: mixer.sfx }, { rng: createRng(seed + 1) });
  const ducker = ctx.nodes[before];
  if (ducker?.kind !== 'GainNode') throw new Error('expected the voice to build a ducker');
  return { ctx, mixer, voice, ducker };
}

const asFake = (node: AudioNode) => node as unknown as FakeNode;
const nodesOf = (ctx: FakeAudioContext, kind: string, from = 0) =>
  ctx.nodes.slice(from).filter((node) => node.kind === kind);

/** Follows audio and modulation connections alike, so a vibrato LFO counts as feeding its voice. */
function reaches(from: FakeNode, target: FakeNode): boolean {
  const owners = new Map<FakeParam, FakeNode>();
  for (const node of from.ctx.nodes) {
    for (const param of Object.values(node.params)) owners.set(param, node);
  }
  const seen = new Set<FakeNode>();
  const queue = [from];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || seen.has(node)) continue;
    if (node === target) return true;
    seen.add(node);
    for (const out of node.outputs) {
      const next = out instanceof FakeNode ? out : owners.get(out);
      if (next) queue.push(next);
    }
  }
  return false;
}

/** The glottal oscillators' pitch automation: what makes one bark sound unlike another. */
function melody(ctx: FakeAudioContext, from: number): string {
  return JSON.stringify(
    nodesOf(ctx, 'OscillatorNode', from)
      .filter((node) => (node as TypedOscillator).type === 'sawtooth')
      .map((node) => node.frequency.scheduled.map((e) => [e.type, e.value.toFixed(2)])),
  );
}

describe('createConciergeVoice', () => {
  beforeEach(() => {
    stubAudioGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(CONCIERGE_EXPRESSIONS)(
    'barks %s through the stinger ducker into the SFX bus',
    (expression) => {
      const { ctx, mixer, voice, ducker } = rig();
      const from = ctx.nodes.length;
      expect(voice.play(expression)).toBe(true);
      expect(voice.speaking).toBe(true);
      const sources = [
        ...nodesOf(ctx, 'OscillatorNode', from),
        ...nodesOf(ctx, 'AudioBufferSourceNode', from),
      ];
      expect(sources.length).toBeGreaterThan(0);
      const sfx = asFake(mixer.sfx);
      expect(reaches(ducker, sfx)).toBe(true);
      for (const source of sources) expect(reaches(source, ducker)).toBe(true);
      const glottal = nodesOf(ctx, 'OscillatorNode', from).filter(
        (node) => (node as TypedOscillator).type === 'sawtooth',
      );
      expect(glottal.length).toBeGreaterThan(0);
    },
  );

  it('plays a distinct bark for each expression', () => {
    const melodies = CONCIERGE_EXPRESSIONS.map((expression) => {
      const { ctx, voice } = rig(5);
      const from = ctx.nodes.length;
      voice.play(expression);
      return melody(ctx, from);
    });
    expect(new Set(melodies).size).toBe(CONCIERGE_EXPRESSIONS.length);
  });

  it('never plays the same bark twice in a row for one expression', () => {
    const { ctx, voice } = rig(9);
    let previous = '';
    for (let i = 0; i < 12; i++) {
      ctx.currentTime += 2;
      const from = ctx.nodes.length;
      voice.play('pleased');
      const current = melody(ctx, from);
      expect(current).not.toBe(previous);
      previous = current;
    }
  });

  it('is deterministic for a given seed', () => {
    const run = () => {
      const { ctx, voice } = rig(11);
      for (const expression of CONCIERGE_EXPRESSIONS) {
        ctx.currentTime += 1;
        voice.play(expression);
      }
      return melody(ctx, 0);
    };
    expect(run()).toBe(run());
  });

  it('cuts the previous bark off with a fade when a new one starts', () => {
    const { ctx, voice } = rig();
    const from = ctx.nodes.length;
    voice.play('wry');
    const [firstOutput] = nodesOf(ctx, 'GainNode', from);
    if (!firstOutput) throw new Error('expected the bark to have an output gain');
    ctx.currentTime = 0.1;
    voice.play('scandalised');
    expect(firstOutput.gain.valueAt(0.1)).toBeGreaterThan(0);
    expect(firstOutput.gain.valueAt(0.12)).toBe(0);
  });

  it('stays silent until audio is unlocked', () => {
    const ctx = new FakeAudioContext();
    Object.defineProperty(ctx, 'state', { value: 'suspended' });
    const { voice } = rig(1, ctx);
    const from = ctx.nodes.length;
    expect(voice.play('pleased')).toBe(false);
    expect(voice.speaking).toBe(false);
    expect(nodesOf(ctx, 'OscillatorNode', from)).toHaveLength(0);
  });

  it('stops speaking once the bark has rung out', () => {
    const { ctx, voice } = rig();
    voice.play('pleased');
    ctx.currentTime = 2;
    expect(voice.speaking).toBe(false);
  });

  describe('under a stinger', () => {
    it('ducks the bark far below a stinger, then brings it back', () => {
      const { ctx, voice, ducker } = rig();
      voice.play('pleased');
      ctx.currentTime = 0.05;
      voice.duck();
      const { attack, hold, release } = CONCIERGE_DUCK_DEFAULTS;
      const floor = dbToGain(CONCIERGE_DUCK_DB);
      expect(ducker.gain.valueAt(0.05)).toBe(1);
      expect(ducker.gain.valueAt(0.05 + attack)).toBeCloseTo(floor, 6);
      expect(ducker.gain.valueAt(0.05 + attack + hold / 2)).toBeCloseTo(floor, 6);
      expect(ducker.gain.valueAt(0.05 + attack + hold + release)).toBe(1);
    });

    it('lowers a bark that starts during the stinger', () => {
      const { ctx, voice, ducker } = rig();
      ctx.currentTime = 1;
      voice.duck({ depthDb: -10, attack: 0.04, hold: 2, release: 0.9 });
      ctx.currentTime = 1.5;
      expect(voice.play('scandalised')).toBe(true);
      expect(ducker.gain.valueAt(1.5)).toBeLessThan(dbToGain(-30));
      expect(ducker.gain.valueAt(1.5 + 0.6)).toBeLessThan(dbToGain(-30));
    });

    it('goes at least as deep as the voice floor whatever the stinger asks of the music', () => {
      const { ctx, voice, ducker } = rig();
      voice.duck({ depthDb: -8, hold: 1 });
      expect(ducker.gain.valueAt(0.5)).toBeCloseTo(dbToGain(CONCIERGE_DUCK_DB), 6);
      ctx.currentTime = 5;
      voice.duck({ depthDb: -48, attack: 0.01, hold: 1 });
      expect(ducker.gain.valueAt(5.5)).toBeCloseTo(dbToGain(-48), 6);
    });

    it('holds through the longer of two overlapping stingers', () => {
      const { ctx, voice, ducker } = rig();
      voice.duck({ attack: 0.04, hold: 3, release: 0.5 });
      ctx.currentTime = 0.5;
      voice.duck({ attack: 0.04, hold: 0.5, release: 0.5 });
      const floor = dbToGain(CONCIERGE_DUCK_DB);
      expect(ducker.gain.valueAt(2.5)).toBeCloseTo(floor, 6);
      expect(ducker.gain.valueAt(3.04)).toBeCloseTo(floor, 6);
      expect(ducker.gain.valueAt(3.6)).toBe(1);
    });
  });

  it('follows the SFX slider, since it plays through the SFX bus', () => {
    const { ctx, mixer, voice } = rig();
    voice.play('wry');
    mixer.setVolume('sfx', 0);
    ctx.currentTime = 1;
    expect(asFake(mixer.sfx).gain.value).toBeLessThan(0.001);
  });

  it('fades out and refuses to play once disposed', () => {
    const { ctx, voice, ducker } = rig();
    voice.play('pleased');
    ctx.currentTime = 0.05;
    voice.dispose();
    expect(voice.speaking).toBe(false);
    expect(ducker.gain.valueAt(0.07)).toBe(0);
    const from = ctx.nodes.length;
    expect(voice.play('wry')).toBe(false);
    expect(nodesOf(ctx, 'OscillatorNode', from)).toHaveLength(0);
    voice.duck();
    expect(ducker.gain.valueAt(2)).toBe(0);
    expect(() => {
      voice.dispose();
    }).not.toThrow();
  });
});

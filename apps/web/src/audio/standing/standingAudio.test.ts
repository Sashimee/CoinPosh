import { ACHIEVEMENT_GRADES, RANK_ROAD, STAFF_ROLES, type Rank } from '@coinposh/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DuckOptions } from '../mixer.ts';
import { Mixer } from '../mixer.ts';
import { FAKE_AUDIO_GLOBALS, FakeAudioContext, FakeNode } from '../music/adaptive/fakeAudio.ts';
import { midiToHz, RIVIERA_KEY, type VenueKey } from '../music/theory.ts';
import { createRng } from '../rng.ts';
import {
  createStandingAudio,
  FANFARE_DUCK_DB,
  FOOTSTEP_RETRIGGER_SECONDS,
  STANDING_MAX_VOICES,
  STANDING_SOURCE_BUDGET,
  type StandingAudio,
} from './index.ts';

function wideFakeContext(): FakeAudioContext {
  const ctx = new FakeAudioContext();
  Object.defineProperty(ctx, 'sampleRate', { value: 48000 });
  return ctx;
}

function suspend(ctx: FakeAudioContext): void {
  Object.defineProperty(ctx, 'state', { value: 'suspended' });
}

/** SourceVoice reaches its context through `node.context`, which the shared fake leaves out. */
class ContextGain extends FAKE_AUDIO_GLOBALS.GainNode {
  get context(): FakeAudioContext {
    return this.ctx;
  }
}

interface Rig {
  readonly ctx: FakeAudioContext;
  readonly mixer: Mixer;
  readonly audio: StandingAudio;
  readonly ducks: Required<DuckOptions>[];
}

function rig(seed = 1, venueKey?: VenueKey): Rig {
  const ctx = wideFakeContext();
  const context = ctx as unknown as BaseAudioContext;
  const mixer = new Mixer(context, createRng(seed));
  const ducks: Required<DuckOptions>[] = [];
  const audio = createStandingAudio(
    {
      context,
      buses: { sfx: mixer.sfx },
      duckMusic: (options) => {
        ducks.push(options as Required<DuckOptions>);
        mixer.duckMusic(options);
      },
    },
    venueKey ? { rng: createRng(seed + 1), venueKey } : { rng: createRng(seed + 1) },
  );
  return { ctx, mixer, audio, ducks };
}

const asFake = (node: AudioNode) => node as unknown as FakeNode;
const nodesOf = (ctx: FakeAudioContext, kind: string, from = 0) =>
  ctx.nodes.slice(from).filter((node) => node.kind === kind);
const sourceStarts = (ctx: FakeAudioContext, from: number) =>
  ctx.calls
    .slice(from)
    .filter((c) => c.what === 'OscillatorNode.start' || c.what === 'AudioBufferSourceNode.start');

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

const DUKE: Rank = { title: 'duke', grade: 3 };

describe('createStandingAudio', () => {
  beforeEach(() => {
    for (const [name, value] of Object.entries(FAKE_AUDIO_GLOBALS)) vi.stubGlobal(name, value);
    vi.stubGlobal('GainNode', ContextGain);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('plays the rank-up fanfare into the SFX bus and ducks the music under it', () => {
    const { ctx, mixer, audio, ducks } = rig();
    ctx.currentTime = 2;
    const before = ctx.nodes.length;
    const duck = audio.playRankUp(DUKE);
    expect(duck).not.toBeNull();
    expect(ducks).toEqual([duck]);
    expect(duck?.depthDb).toBe(FANFARE_DUCK_DB);
    expect(audio.fanfarePlaying).toBe(true);
    const isVibrato = (osc: FakeNode) => osc.frequency.valueAt(0) < 20;
    const tones = nodesOf(ctx, 'OscillatorNode', before).filter((osc) => !isVibrato(osc));
    expect(tones.length).toBeGreaterThan(10);
    for (const osc of tones) expect(reaches(osc, asFake(mixer.sfx))).toBe(true);
    const musicDuck = asFake(mixer.music).outputs[0];
    if (!(musicDuck instanceof FakeNode)) throw new Error('mixer music bus has no duck stage');
    expect(musicDuck.gain.valueAt(2.05)).toBeLessThan(0.25);
  });

  it('starts every cue on the current sample: zero latency, never in the past', () => {
    const { ctx, audio } = rig();
    ctx.currentTime = 4.5;
    const from = ctx.calls.length;
    audio.playRankUp({ title: 'commoner', grade: 2 });
    audio.playAchievementChime('gold');
    audio.playStaffFootstep('butler');
    const starts = sourceStarts(ctx, from);
    expect(Math.min(...starts.map((c) => c.time))).toBe(4.5);
    for (const call of starts) expect(call.time).toBeGreaterThanOrEqual(4.5);
  });

  it('plays the fanfare in the venue key it is given, and follows a venue change', () => {
    const cMajor: VenueKey = { name: 'C major', ladderTonicMidi: 72 };
    const firstHorn = (key: VenueKey | undefined, change?: VenueKey) => {
      const { ctx, audio } = rig(1, key);
      if (change) audio.setVenueKey(change);
      const before = ctx.nodes.length;
      audio.playRankUp({ title: 'commoner', grade: 1 });
      return nodesOf(ctx, 'OscillatorNode', before)[0]?.frequency.valueAt(0.2) ?? NaN;
    };
    expect(firstHorn(undefined)).toBeCloseTo(midiToHz(RIVIERA_KEY.ladderTonicMidi - 12), 3);
    expect(firstHorn(cMajor)).toBeCloseTo(midiToHz(60), 3);
    expect(firstHorn(undefined, cMajor)).toBeCloseTo(midiToHz(60), 3);
  });

  it('cuts a ringing fanfare with a fade when a higher rank lands on top of it', () => {
    const { ctx, audio, ducks } = rig();
    ctx.currentTime = 1;
    const voiceGains = () => nodesOf(ctx, 'GainNode');
    const before = voiceGains().length;
    audio.playRankUp({ title: 'baron', grade: 4 });
    const firstOutput = voiceGains()[before];
    if (!firstOutput) throw new Error('fanfare built no output gain');
    ctx.currentTime = 1.2;
    expect(audio.playRankUp({ title: 'baron', grade: 5 })).not.toBeNull();
    expect(firstOutput.gain.valueAt(1.25)).toBe(0);
    expect(ducks).toHaveLength(2);
    expect(audio.activeSources).toBeLessThanOrEqual(STANDING_SOURCE_BUDGET);
  });

  it('plays every rank on the road and every Monarch star within the source budget', () => {
    const { ctx, audio } = rig();
    for (const [i, rank] of [...RANK_ROAD, { title: 'monarch', stars: 12 } as Rank].entries()) {
      ctx.currentTime = 1 + i * 10;
      expect(audio.playRankUp(rank)).not.toBeNull();
      expect(audio.activeSources).toBeLessThanOrEqual(STANDING_SOURCE_BUDGET);
    }
  });

  it('counts exactly the sources each cue starts', () => {
    const { ctx, audio } = rig();
    ctx.currentTime = 1;
    let from = ctx.calls.length;
    audio.playRankUp({ title: 'monarch', stars: 3 });
    expect(audio.activeSources).toBe(sourceStarts(ctx, from).length);
    ctx.currentTime = 30;
    from = ctx.calls.length;
    audio.playAchievementChime('platinum');
    expect(audio.activeSources).toBe(sourceStarts(ctx, from).length);
    ctx.currentTime = 60;
    from = ctx.calls.length;
    audio.playStaffWalk('valet', { steps: 6, fromPan: -0.4, toPan: 0.4 });
    expect(audio.activeSources).toBe(sourceStarts(ctx, from).length);
  });

  it.each(ACHIEVEMENT_GRADES)('chimes for a %s badge without touching the music', (grade) => {
    const { ctx, audio, ducks } = rig();
    ctx.currentTime = 1;
    expect(audio.playAchievementChime(grade, 0.3)).toBe(true);
    expect(ducks).toHaveLength(0);
    expect(audio.activeVoices).toBe(1);
  });

  it.each(STAFF_ROLES)('walks the %s across the table', (role) => {
    const { ctx, audio } = rig();
    ctx.currentTime = 1;
    const before = ctx.nodes.length;
    expect(audio.playStaffWalk(role, { steps: 4, fromPan: -0.5, toPan: 0.5 })).toBe(true);
    const pans = nodesOf(ctx, 'StereoPannerNode', before)
      .map((node) => node.param('pan').valueAt(1))
      .filter((pan) => pan !== 0);
    expect(pans.length).toBe(4);
    expect(pans[0]).toBeLessThan(0);
    expect(pans.at(-1)).toBeGreaterThan(0);
  });

  it('drops a double-reported footfall but lets the next one and other staff through', () => {
    const { ctx, audio } = rig();
    ctx.currentTime = 1;
    expect(audio.playStaffFootstep('butler', -0.2)).toBe(true);
    ctx.currentTime += FOOTSTEP_RETRIGGER_SECONDS / 2;
    expect(audio.playStaffFootstep('butler', -0.2)).toBe(false);
    expect(audio.playStaffFootstep('valet')).toBe(true);
    ctx.currentTime += FOOTSTEP_RETRIGGER_SECONDS;
    expect(audio.playStaffFootstep('butler', -0.2)).toBe(true);
  });

  it('lets footsteps give way to a chime and a fanfare when the pool is full', () => {
    const { ctx, audio } = rig();
    ctx.currentTime = 1;
    for (let i = 0; i < 40; i++) {
      const role = STAFF_ROLES[i % STAFF_ROLES.length] ?? 'butler';
      audio.playStaffWalk(role, { steps: 4 });
      ctx.currentTime += 0.001;
      expect(audio.activeVoices).toBeLessThanOrEqual(STANDING_MAX_VOICES);
      expect(audio.activeSources).toBeLessThanOrEqual(STANDING_SOURCE_BUDGET);
    }
    ctx.currentTime += FOOTSTEP_RETRIGGER_SECONDS;
    expect(audio.playAchievementChime('platinum')).toBe(true);
    expect(audio.playRankUp({ title: 'monarch', stars: 5 })).not.toBeNull();
    expect(audio.activeSources).toBeLessThanOrEqual(STANDING_SOURCE_BUDGET);
  });

  it('plays nothing, builds no nodes and ducks nothing until audio is unlocked', () => {
    const { ctx, audio, ducks } = rig();
    suspend(ctx);
    const before = ctx.nodes.length;
    expect(audio.playRankUp(DUKE)).toBeNull();
    expect(audio.playAchievementChime('gold')).toBe(false);
    expect(audio.playStaffFootstep('sommelier')).toBe(false);
    expect(audio.playStaffWalk('valet', { steps: 3 })).toBe(false);
    expect(ctx.nodes.length).toBe(before);
    expect(ducks).toHaveLength(0);
  });

  it('rejects a malformed walk even before audio unlocks', () => {
    const { ctx, audio } = rig();
    suspend(ctx);
    expect(() => audio.playStaffWalk('butler', { steps: 0 })).toThrow(RangeError);
  });

  it('is reproducible from a seed', () => {
    const run = (seed: number) => {
      const { ctx, audio } = rig(seed);
      ctx.currentTime = 1;
      audio.playRankUp(DUKE);
      audio.playAchievementChime('silver');
      audio.playStaffWalk('valet', { steps: 5 });
      return ctx.calls.map((c) => `${c.what}@${c.time.toFixed(6)}`);
    };
    expect(run(3)).toEqual(run(3));
    expect(run(3)).not.toEqual(run(4));
  });

  it('fades everything out on dispose and goes quiet for good', () => {
    const { ctx, audio, ducks } = rig();
    ctx.currentTime = 1;
    audio.playRankUp(DUKE);
    audio.playAchievementChime('gold');
    expect(audio.activeVoices).toBe(2);
    audio.dispose();
    audio.dispose();
    expect(audio.activeVoices).toBe(0);
    expect(audio.fanfarePlaying).toBe(false);
    expect(audio.playRankUp(DUKE)).toBeNull();
    expect(audio.playAchievementChime('gold')).toBe(false);
    expect(ducks).toHaveLength(1);
  });
});

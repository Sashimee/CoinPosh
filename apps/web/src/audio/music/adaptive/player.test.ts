import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Mixer } from '../../mixer.ts';
import { createRng, dbToGain } from '../../rng.ts';
import { FAKE_AUDIO_GLOBALS, FakeAudioContext, type FakeNode } from './fakeAudio.ts';
import { AdaptiveMusic, PUMP_INTERVAL_MS, type PumpTimer } from './player.ts';
import { FULL_DROPS_PER_SECOND } from './tempo.ts';

interface Rig {
  readonly ctx: FakeAudioContext;
  readonly mixer: Mixer;
  readonly music: AdaptiveMusic;
  readonly ticks: { tick: (() => void) | null; ms: number; cancelled: number };
  /** Moves the audio clock and fires the pump timer the way a browser would. */
  readonly advance: (seconds: number) => void;
}

function rig(): Rig {
  const ctx = new FakeAudioContext();
  const audioCtx = ctx as unknown as BaseAudioContext;
  const mixer = new Mixer(audioCtx, createRng(1));
  const ticks: Rig['ticks'] = { tick: null, ms: 0, cancelled: 0 };
  const timer: PumpTimer = (ms, tick) => {
    ticks.tick = tick;
    ticks.ms = ms;
    return () => {
      ticks.tick = null;
      ticks.cancelled++;
    };
  };
  const music = new AdaptiveMusic(audioCtx, {
    output: mixer.music,
    stingOutput: mixer.sfx,
    ducker: mixer,
    rng: createRng(2),
    timer,
  });
  return {
    ctx,
    mixer,
    music,
    ticks,
    advance: (seconds) => {
      const end = ctx.currentTime + seconds;
      while (ctx.currentTime < end) {
        ctx.currentTime = Math.min(end, ctx.currentTime + PUMP_INTERVAL_MS / 1000);
        ticks.tick?.();
      }
    },
  };
}

const asFake = (node: AudioNode) => node as unknown as FakeNode;

function musicDuckOf(mixer: Mixer): FakeNode {
  const duck = asFake(mixer.music).outputs[0];
  if (!duck || !('kind' in duck)) throw new Error('the music bus should feed the duck gain');
  return duck;
}

describe('AdaptiveMusic on the audio graph', () => {
  beforeEach(() => {
    for (const [name, value] of Object.entries(FAKE_AUDIO_GLOBALS)) vi.stubGlobal(name, value);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('plays the live band on a pump timer and never schedules anything into the past', () => {
    const { ctx, music, ticks, advance } = rig();
    music.setDropRate(FULL_DROPS_PER_SECOND);
    music.start();
    expect(ticks.ms).toBe(PUMP_INTERVAL_MS);
    advance(6);
    music.setCascadeTier('opulent');
    advance(6);
    expect(music.playJackpotSting()).toBe(true);
    advance(6);
    music.setCascadeTier(null);
    advance(6);
    const starts = ctx.calls.filter((c) => c.what === 'OscillatorNode.start');
    expect(starts.length).toBeGreaterThan(200);
    const late = ctx.calls.filter((c) => c.time < c.calledAt && !c.what.endsWith('.cancel'));
    expect(late).toEqual([]);
    expect(music.tempo).toBeGreaterThan(92);
  });

  it('ducks the music bed under the jackpot sting through the mixer and restores it', () => {
    const { ctx, mixer, music, advance } = rig();
    music.start();
    advance(4);
    const duck = musicDuckOf(mixer).gain;
    expect(duck.value).toBe(1);
    const firedAt = ctx.currentTime;
    const plan = music.scheduler;
    expect(music.playJackpotSting()).toBe(true);
    const floor = dbToGain(-14);
    expect(duck.valueAt(firedAt + 0.05)).toBeCloseTo(floor, 6);
    const secondsPerBeat = 60 / plan.tempoAt(firedAt);
    expect(duck.valueAt(firedAt + 2.5 * secondsPerBeat)).toBeCloseTo(floor, 6);
    advance(10);
    expect(duck.value).toBe(1);
    expect(duck.valueAt(firedAt + 20)).toBe(1);
  });

  it('plays the sting outside the duck, on the SFX bus', () => {
    const { ctx, mixer, music, advance } = rig();
    music.start();
    advance(1);
    const sfx = asFake(mixer.sfx);
    const stingBus = ctx.nodes.find((node) => node.outputs.includes(sfx));
    if (!stingBus) throw new Error('nothing feeds the SFX bus from the music');
    const before = ctx.nodes.length;
    music.playJackpotSting();
    const fed = ctx.nodes.slice(before).filter((node) => node.outputs.includes(stingBus));
    expect(fed.length).toBeGreaterThan(10);
    expect(stingBus.gain.value).toBeGreaterThan(0.5);
  });

  it('goes quiet and stops spending voices while music is off, then picks the groove back up', () => {
    const { ctx, music, advance } = rig();
    music.start();
    advance(3);
    music.setEnabled(false);
    advance(0.4);
    const offFrom = ctx.calls.length;
    advance(5);
    const offStarts = ctx.calls.slice(offFrom).filter((c) => c.what === 'OscillatorNode.start');
    expect(offStarts).toEqual([]);
    expect(music.playJackpotSting()).toBe(false);
    music.setEnabled(true);
    const onFrom = ctx.calls.length;
    advance(3);
    expect(ctx.calls.slice(onFrom).some((c) => c.what === 'OscillatorNode.start')).toBe(true);
  });

  it('fades out on stop, cancels its timer, and refuses to play once disposed', () => {
    const { mixer, music, ticks, advance } = rig();
    music.start();
    music.start();
    advance(3);
    music.stop(0.5);
    expect(ticks.tick).toBeNull();
    expect(ticks.cancelled).toBe(1);
    expect(music.isPlaying).toBe(false);
    expect(asFake(mixer.music).outputs.length).toBe(1);
    music.dispose();
    expect(() => {
      music.start();
    }).toThrow(/disposed/);
    expect(() => {
      music.stop(-1);
    }).toThrow(RangeError);
  });
});

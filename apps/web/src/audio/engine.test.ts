import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCollectingAudio } from './collecting/index.ts';
import { createAudioEngine, isAudioSupported, type AudioEngine } from './engine.ts';
import { Mixer } from './mixer.ts';
import {
  FAKE_AUDIO_GLOBALS,
  FakeBuffer,
  type FakeAudioContext,
  type FakeNode,
} from './music/adaptive/fakeAudio.ts';
import { AdaptiveMusic, PUMP_INTERVAL_MS } from './music/adaptive/index.ts';
import { createRng } from './rng.ts';

/** The fake node graph plus the lifecycle surface the engine needs from a real AudioContext. */
class EngineContext extends EventTarget {
  static last: EngineContext | null = null;
  currentTime = 0;
  readonly sampleRate = 8000;
  state: AudioContextState = 'suspended';
  readonly calls: { what: string; time: number; calledAt: number }[] = [];
  readonly nodes: FakeNode[] = [];
  readonly destination: FakeNode;
  closed = 0;

  constructor() {
    super();
    this.destination = new FAKE_AUDIO_GLOBALS.GainNode(this.asFake());
    EngineContext.last = this;
  }

  asFake(): FakeAudioContext {
    return this as unknown as FakeAudioContext;
  }

  createBuffer(channels: number, length: number, sampleRate: number): FakeBuffer {
    return new FakeBuffer(channels, length, sampleRate);
  }

  createBufferSource(): FakeNode {
    return new FAKE_AUDIO_GLOBALS.AudioBufferSourceNode(this.asFake());
  }

  record(what: string, time: number): void {
    this.calls.push({ what, time, calledAt: this.currentTime });
  }

  resume(): Promise<void> {
    this.setState('running');
    return Promise.resolve();
  }

  suspend(): Promise<void> {
    this.setState('suspended');
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed++;
    this.setState('closed');
    return Promise.resolve();
  }

  private setState(state: AudioContextState): void {
    if (this.state === state) return;
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
}

function context(): EngineContext {
  const ctx = EngineContext.last;
  if (!ctx) throw new Error('createAudioEngine should have built an AudioContext');
  return ctx;
}

/** Oscillator starts: the band's tremolo LFOs at build time, then every pitched note. */
const noteStarts = (ctx: EngineContext) =>
  ctx.calls.filter((call) => call.what === 'OscillatorNode.start').length;

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

interface Rig {
  readonly engine: AudioEngine;
  readonly ctx: EngineContext;
  readonly gestures: EventTarget;
  readonly unlock: () => Promise<void>;
  /** Moves the audio clock and fires the pump interval the way a browser would. */
  readonly advance: (seconds: number) => void;
}

function rig(): Rig {
  const gestures = new EventTarget();
  const engine = createAudioEngine({ gestureTarget: gestures, rng: createRng(7) });
  const ctx = context();
  return {
    engine,
    ctx,
    gestures,
    unlock: async () => {
      gestures.dispatchEvent(new Event('pointerdown'));
      await flush();
    },
    advance: (seconds) => {
      const end = ctx.currentTime + seconds;
      while (ctx.currentTime < end) {
        ctx.currentTime = Math.min(end, ctx.currentTime + PUMP_INTERVAL_MS / 1000);
        vi.advanceTimersByTime(PUMP_INTERVAL_MS);
      }
    },
  };
}

describe('createAudioEngine with the adaptive band', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const [name, value] of Object.entries(FAKE_AUDIO_GLOBALS)) vi.stubGlobal(name, value);
    vi.stubGlobal('AudioContext', EngineContext);
    vi.stubGlobal(
      'OfflineAudioContext',
      vi.fn(() => {
        throw new Error('the engine must not render a second, offline music bed');
      }),
    );
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    EngineContext.last = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('plays nothing before the first gesture and only the adaptive bed after it', async () => {
    const start = vi.spyOn(AdaptiveMusic.prototype, 'start');
    const { engine, ctx, unlock, advance } = rig();
    const tremoloLfos = noteStarts(ctx);
    const music = engine.startMusic();
    await flush();
    expect(start).not.toHaveBeenCalled();
    expect(noteStarts(ctx)).toBe(tremoloLfos);

    await unlock();
    await music;
    expect(engine.unlocked).toBe(true);
    expect(start).toHaveBeenCalledOnce();
    advance(4);
    expect(noteStarts(ctx)).toBeGreaterThan(tremoloLfos);
    expect(ctx.calls.every((call) => call.time >= call.calledAt - 1e-9)).toBe(true);
  });

  it('starts the band once however often startMusic is called', async () => {
    const { engine, ctx, unlock, advance } = rig();
    const first = engine.startMusic();
    const second = engine.startMusic();
    await unlock();
    await Promise.all([first, second]);
    await engine.startMusic();
    advance(2);
    const once = noteStarts(ctx);

    const { engine: twin, ctx: twinCtx, unlock: twinUnlock, advance: twinAdvance } = rig();
    const single = twin.startMusic();
    await twinUnlock();
    await single;
    twinAdvance(2);
    expect(noteStarts(twinCtx)).toBe(once);
  });

  it('drops a start that stopMusic overtook before the unlock', async () => {
    const start = vi.spyOn(AdaptiveMusic.prototype, 'start');
    const { engine, unlock } = rig();
    const music = engine.startMusic();
    engine.stopMusic(0.5);
    await unlock();
    await music;
    expect(start).not.toHaveBeenCalled();
  });

  it('fades the band out on stopMusic and stops scheduling notes', async () => {
    const stop = vi.spyOn(AdaptiveMusic.prototype, 'stop');
    const { engine, ctx, unlock, advance } = rig();
    const music = engine.startMusic();
    await unlock();
    await music;
    advance(2);
    engine.stopMusic(0.75);
    expect(stop).toHaveBeenCalledWith(0.75);
    const settled = noteStarts(ctx);
    advance(4);
    expect(noteStarts(ctx)).toBe(settled);
  });

  it('forwards the adaptive controls to the band', () => {
    const dropRate = vi.spyOn(AdaptiveMusic.prototype, 'setDropRate');
    const tier = vi.spyOn(AdaptiveMusic.prototype, 'setCascadeTier');
    const enabled = vi.spyOn(AdaptiveMusic.prototype, 'setEnabled');
    const reduced = vi.spyOn(AdaptiveMusic.prototype, 'setReducedMotion');
    const { engine } = rig();

    engine.setDropRate(2.5);
    engine.setCascadeTier('opulent');
    engine.setCascadeTier(null);
    engine.setMusicEnabled(false);
    engine.setReducedMotion(true);

    expect(dropRate).toHaveBeenCalledWith(2.5);
    expect(tier.mock.calls).toEqual([['opulent'], [null]]);
    expect(enabled).toHaveBeenCalledWith(false);
    expect(reduced).toHaveBeenCalledWith(true);
  });

  it('exposes its context and the mixer buses, suspended until the first gesture', async () => {
    const duck = vi.spyOn(Mixer.prototype, 'duckMusic');
    const { engine, ctx, unlock } = rig();
    engine.duckMusic();
    const mixer = duck.mock.contexts[0] as Mixer;
    expect(engine.context).toBe(ctx);
    expect(engine.context.state).toBe('suspended');
    expect(engine.buses.sfx).toBe(mixer.sfx);
    expect(engine.buses.music).toBe(mixer.music);
    expect(engine.buses.sfx).not.toBe(engine.buses.music);
    expect((engine.buses.sfx as unknown as FakeNode).ctx).toBe(ctx.asFake());
    expect((engine.buses.music as unknown as FakeNode).ctx).toBe(ctx.asFake());
    await unlock();
    expect(engine.context).toBe(ctx);
    expect(engine.context.state).toBe('running');
  });

  it('hosts the collecting sounds directly, with no adapter', () => {
    const { engine } = rig();
    const collecting = createCollectingAudio(engine, { timer: () => () => undefined });
    expect(collecting.activeVoices).toBe(0);
    expect(collecting.cellarPlaying).toBe(false);
    collecting.dispose();
  });

  it('lets the band reject bad input instead of hiding it', () => {
    const { engine } = rig();
    expect(() => {
      engine.setDropRate(Number.NaN);
    }).toThrow(RangeError);
    expect(() => {
      engine.stopMusic(-1);
    }).toThrow(RangeError);
    expect(() => {
      engine.setIntensity(Number.POSITIVE_INFINITY);
    }).toThrow(RangeError);
  });

  it('plays the jackpot sting only while the band is live, and ducks the music under it', async () => {
    const sting = vi.spyOn(AdaptiveMusic.prototype, 'playJackpotSting');
    const { engine, unlock, advance } = rig();
    expect(engine.playJackpotSting()).toBe(false);

    const music = engine.startMusic();
    await unlock();
    await music;
    advance(1);
    const duck = vi.spyOn(Mixer.prototype, 'duckMusic');
    expect(engine.playJackpotSting()).toBe(true);
    expect(sting).toHaveBeenCalledTimes(1);
    expect(duck).toHaveBeenCalledOnce();
    expect(engine.playJackpotSting()).toBe(false);

    engine.setMusicEnabled(false);
    advance(10);
    expect(engine.playJackpotSting()).toBe(false);
  });

  it('disposes the band with the context and refuses stings afterwards', async () => {
    const dispose = vi.spyOn(AdaptiveMusic.prototype, 'dispose');
    const { engine, ctx, unlock } = rig();
    const music = engine.startMusic();
    await unlock();
    await music;

    await engine.dispose();
    await engine.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    expect(ctx.closed).toBe(1);
    expect(engine.playJackpotSting()).toBe(false);
    expect(() => {
      engine.stopMusic();
    }).not.toThrow();
    await expect(engine.startMusic()).resolves.toBeUndefined();
  });
});

describe('isAudioSupported', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('needs only a live AudioContext now that no music is rendered offline', () => {
    vi.stubGlobal('AudioContext', EngineContext);
    vi.stubGlobal('OfflineAudioContext', undefined);
    expect(isAudioSupported()).toBe(true);
  });

  it('reports a browser without Web Audio, and the engine refuses to start there', () => {
    vi.stubGlobal('AudioContext', undefined);
    expect(isAudioSupported()).toBe(false);
    expect(() => createAudioEngine({ gestureTarget: new EventTarget() })).toThrow(
      /needs the Web Audio API/,
    );
  });
});

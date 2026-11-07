import { describe, expect, it } from 'vitest';
import {
  BurstLimiter,
  effectivePriority,
  MAX_ACTIVE_SOURCES,
  MAX_VOICES,
  VoicePool,
  type PooledVoice,
} from './voicePool.ts';

class FakeVoice implements PooledVoice {
  releasedAt: number | null = null;
  constructor(
    readonly priority: number,
    readonly startTime: number,
    readonly endTime: number,
    readonly cost = 1,
  ) {}
  release(now: number): void {
    this.releasedAt = now;
  }
}

describe('effectivePriority', () => {
  it('is the full priority at the start and decays to zero at the end', () => {
    const voice = new FakeVoice(50, 1, 3);
    expect(effectivePriority(voice, 1)).toBe(50);
    expect(effectivePriority(voice, 2)).toBe(25);
    expect(effectivePriority(voice, 3)).toBe(0);
    expect(effectivePriority(voice, 9)).toBe(0);
  });

  it('treats a zero-length voice as already finished', () => {
    expect(effectivePriority(new FakeVoice(90, 2, 2), 2)).toBe(0);
  });
});

describe('VoicePool', () => {
  it('caps at 24 voices by default', () => {
    expect(new VoicePool().capacity).toBe(MAX_VOICES);
    expect(MAX_VOICES).toBe(24);
  });

  it('rejects a capacity that is not a positive integer', () => {
    expect(() => new VoicePool(0)).toThrow(RangeError);
    expect(() => new VoicePool(2.5)).toThrow(RangeError);
  });

  it('admits freely until full', () => {
    const pool = new VoicePool<FakeVoice>(3);
    for (let i = 0; i < 3; i++) expect(pool.admit(new FakeVoice(10, 0, 1), 0)).toBe(true);
    expect(pool.activeCount).toBe(3);
  });

  it('frees voices whose end time has passed without stealing them', () => {
    const pool = new VoicePool<FakeVoice>(1);
    const old = new FakeVoice(10, 0, 0.5);
    pool.admit(old, 0);
    expect(pool.admit(new FakeVoice(1, 1, 2), 1)).toBe(true);
    expect(old.releasedAt).toBeNull();
    expect(pool.activeCount).toBe(1);
  });

  it('steals the least important voice when full and releases it', () => {
    const pool = new VoicePool<FakeVoice>(2);
    const quiet = new FakeVoice(10, 0, 1);
    const loud = new FakeVoice(60, 0, 1);
    pool.admit(quiet, 0);
    pool.admit(loud, 0);
    const incoming = new FakeVoice(40, 0.1, 1.1);
    expect(pool.admit(incoming, 0.1)).toBe(true);
    expect(quiet.releasedAt).toBe(0.1);
    expect(loud.releasedAt).toBeNull();
  });

  it('prefers stealing a loud voice that has nearly decayed over a fresh quiet one', () => {
    const pool = new VoicePool<FakeVoice>(2);
    const fadingLoud = new FakeVoice(60, 0, 1);
    const freshQuiet = new FakeVoice(12, 0.9, 1.9);
    pool.admit(fadingLoud, 0);
    pool.admit(freshQuiet, 0.9);
    pool.admit(new FakeVoice(20, 0.95, 2), 0.95);
    expect(fadingLoud.releasedAt).toBe(0.95);
    expect(freshQuiet.releasedAt).toBeNull();
  });

  it('breaks ties by stealing the oldest voice', () => {
    const pool = new VoicePool<FakeVoice>(2);
    const newer = new FakeVoice(10, -5, 5);
    const older = new FakeVoice(10, -10, 10);
    expect(effectivePriority(newer, 0)).toBe(effectivePriority(older, 0));
    pool.admit(newer, 0);
    pool.admit(older, 0);
    pool.admit(new FakeVoice(10, 0, 10), 0);
    expect(older.releasedAt).toBe(0);
    expect(newer.releasedAt).toBeNull();
  });

  it('refuses a voice less important than everything playing', () => {
    const pool = new VoicePool<FakeVoice>(2);
    const a = new FakeVoice(100, 0, 1);
    const b = new FakeVoice(100, 0, 1);
    pool.admit(a, 0);
    pool.admit(b, 0);
    expect(pool.canAdmit(20, 1, 0)).toBe(false);
    expect(pool.admit(new FakeVoice(20, 0, 1), 0)).toBe(false);
    expect(a.releasedAt).toBeNull();
    expect(b.releasedAt).toBeNull();
    expect(pool.activeCount).toBe(2);
  });

  it('never exceeds capacity under a flood of voices', () => {
    const pool = new VoicePool<FakeVoice>(MAX_VOICES);
    for (let i = 0; i < 500; i++) {
      const now = i * 0.001;
      pool.admit(new FakeVoice(10 + (i % 50), now, now + 0.4), now);
      expect(pool.activeCount).toBeLessThanOrEqual(MAX_VOICES);
    }
  });

  it('rejects a source budget that is not a positive integer', () => {
    expect(() => new VoicePool(4, 0)).toThrow(RangeError);
    expect(() => new VoicePool(4, 1.5)).toThrow(RangeError);
  });

  it('rejects a voice cost that is not a positive integer', () => {
    const pool = new VoicePool<FakeVoice>(4, 10);
    expect(() => pool.canAdmit(10, 0, 0)).toThrow(RangeError);
    expect(() => pool.canAdmit(10, Number.NaN, 0)).toThrow(RangeError);
    expect(() => pool.admit(new FakeVoice(10, 0, 1, 2.5), 0)).toThrow(RangeError);
  });

  it('budgets sources across voices, not just the voice count', () => {
    const pool = new VoicePool<FakeVoice>(24, 20);
    expect(pool.admit(new FakeVoice(100, 0, 1, 12), 0)).toBe(true);
    expect(pool.canAdmit(10, 8, 0)).toBe(true);
    expect(pool.canAdmit(10, 9, 0)).toBe(false);
    expect(pool.activeCount).toBe(1);
    expect(pool.activeCost).toBe(12);
  });

  it('steals as many low-priority voices as it takes to fit a costly one', () => {
    const pool = new VoicePool<FakeVoice>(24, 12);
    const quiet = [0, 1, 2].map((i) => new FakeVoice(10, i * 0.01, 1, 4));
    for (const v of quiet) pool.admit(v, v.startTime);
    const loud = new FakeVoice(60, 0.05, 1, 8);
    expect(pool.admit(loud, 0.05)).toBe(true);
    expect(quiet.map((v) => v.releasedAt)).toEqual([0.05, 0.05, null]);
    expect(pool.activeCost).toBe(12);
  });

  it('steals nothing when the voices it would need include a more important one', () => {
    const pool = new VoicePool<FakeVoice>(24, 12);
    const quiet = new FakeVoice(10, 0, 1, 4);
    const combo = new FakeVoice(100, 0, 1, 8);
    pool.admit(quiet, 0);
    pool.admit(combo, 0);
    expect(pool.admit(new FakeVoice(60, 0, 1, 6), 0)).toBe(false);
    expect(quiet.releasedAt).toBeNull();
    expect(combo.releasedAt).toBeNull();
    expect(pool.activeCost).toBe(12);
  });

  it('refuses a voice that alone exceeds the whole budget', () => {
    const pool = new VoicePool<FakeVoice>(4, 10);
    expect(pool.canAdmit(100, 11, 0)).toBe(false);
  });

  it('never exceeds the source budget under a flood of rich hits and combo notes', () => {
    const pool = new VoicePool<FakeVoice>();
    for (let i = 0; i < 400; i++) {
      const now = i * 0.002;
      const combo = i % 25 === 0;
      pool.admit(
        new FakeVoice(combo ? 100 : 10 + (i % 50), now, now + 0.9, combo ? 12 : 12 - (i % 9)),
        now,
      );
      expect(pool.activeCost).toBeLessThanOrEqual(MAX_ACTIVE_SOURCES);
      expect(pool.activeCount).toBeLessThanOrEqual(MAX_VOICES);
    }
  });

  it('releaseAll stops every voice and empties the pool', () => {
    const pool = new VoicePool<FakeVoice>(4);
    const voices = [new FakeVoice(1, 0, 1), new FakeVoice(2, 0, 1)];
    for (const v of voices) pool.admit(v, 0);
    pool.releaseAll(0.5);
    expect(voices.map((v) => v.releasedAt)).toEqual([0.5, 0.5]);
    expect(pool.activeCount).toBe(0);
  });
});

describe('BurstLimiter', () => {
  it('allows a fixed number of starts per window and resets after it', () => {
    const limiter = new BurstLimiter(3, 0.02);
    expect([0, 0.001, 0.002, 0.003].map((t) => limiter.tryConsume(t))).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(limiter.tryConsume(0.02)).toBe(true);
  });

  it('spends the window in sources, so rich hits use it up faster than ticks', () => {
    const limiter = new BurstLimiter(20, 0.02);
    expect(limiter.tryConsume(0, 12)).toBe(true);
    expect(limiter.tryConsume(0.001, 12)).toBe(false);
    expect(limiter.tryConsume(0.002, 8)).toBe(true);
    expect(limiter.tryConsume(0.003, 1)).toBe(false);
    expect(limiter.tryConsume(0.021, 12)).toBe(true);
  });

  it('lets one voice costlier than the whole window through when the window is empty', () => {
    const limiter = new BurstLimiter(4, 0.02);
    expect(limiter.tryConsume(0, 9)).toBe(true);
    expect(limiter.tryConsume(0.001, 1)).toBe(false);
  });
});

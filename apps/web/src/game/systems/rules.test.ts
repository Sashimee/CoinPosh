import { describe, expect, it } from 'vitest';
import { CascadeCombo } from './combo.ts';
import { DecorumModel } from './decorum.ts';
import { PourTimer } from './pour.ts';
import { CASCADE, CASCADE_WINDOW_TICKS, MS_PER_TICK, decorumCapacity, ticksFor } from './tuning.ts';

describe('CascadeCombo: the ladder from Chic to OBSCENE', () => {
  it('climbs Chic, Lavish, Opulent, Decadent, OBSCENE at the economy thresholds, one rung at a time', () => {
    const combo = new CascadeCombo(CASCADE, CASCADE_WINDOW_TICKS);
    const rungs: { count: number; tier: string; rank: number }[] = [];
    for (let i = 0; i < 30; i += 1) {
      const { step, ended } = combo.fall(100 + i * 5);
      expect(ended).toBeNull();
      expect(step.count).toBe(i + 1);
      if (step.tierUp) rungs.push({ count: step.count, ...step.tierUp });
    }
    expect(rungs).toEqual([
      { count: 3, tier: 'chic', rank: 1 },
      { count: 6, tier: 'lavish', rank: 2 },
      { count: 10, tier: 'opulent', rank: 3 },
      { count: 16, tier: 'decadent', rank: 4 },
      { count: 25, tier: 'obscene', rank: 5 },
    ]);
    expect(combo.tier).toBe('obscene');
  });

  it('has no tier below three falls', () => {
    const combo = new CascadeCombo(CASCADE, CASCADE_WINDOW_TICKS);
    expect(combo.fall(0).step).toEqual({ count: 1, tier: null, tierUp: null });
    expect(combo.fall(1).step).toEqual({ count: 2, tier: null, tierUp: null });
    expect(combo.fall(2).step.tier).toBe('chic');
  });

  it('keeps the chain on a fall exactly one window later and breaks it one tick after', () => {
    const combo = new CascadeCombo(CASCADE, CASCADE_WINDOW_TICKS);
    combo.fall(0);
    expect(combo.fall(CASCADE_WINDOW_TICKS).ended).toBeNull();
    expect(combo.count).toBe(2);
    const late = combo.fall(2 * CASCADE_WINDOW_TICKS + 1);
    expect(late.ended).toEqual({ count: 2, tier: null });
    expect(late.step.count).toBe(1);
  });

  it('the window is the economy cascade window in sim ticks, rounded up', () => {
    expect(CASCADE_WINDOW_TICKS).toBe(Math.ceil(CASCADE.windowMs / MS_PER_TICK));
    expect(ticksFor(MS_PER_TICK)).toBe(1);
    expect(ticksFor(MS_PER_TICK + 0.001)).toBe(2);
  });

  it('update ends an idle chain with its tier, once', () => {
    const combo = new CascadeCombo(CASCADE, CASCADE_WINDOW_TICKS);
    expect(combo.update(1_000)).toBeNull();
    for (let i = 0; i < 6; i += 1) combo.fall(i);
    expect(combo.update(5 + CASCADE_WINDOW_TICKS)).toBeNull();
    expect(combo.update(6 + CASCADE_WINDOW_TICKS)).toEqual({ count: 6, tier: 'lavish' });
    expect(combo.update(10_000)).toBeNull();
    expect(combo.tier).toBeNull();
  });

  it('a tick from before the last fall means a new sim, so the chain ends', () => {
    const combo = new CascadeCombo(CASCADE, CASCADE_WINDOW_TICKS);
    combo.fall(500);
    combo.fall(501);
    combo.fall(502);
    expect(combo.update(10)).toEqual({ count: 3, tier: 'chic' });
  });

  it('a new chain announces its rungs again', () => {
    const combo = new CascadeCombo(CASCADE, CASCADE_WINDOW_TICKS);
    for (let i = 0; i < 3; i += 1) combo.fall(i);
    expect(combo.reset()).toEqual({ count: 3, tier: 'chic' });
    expect(combo.reset()).toBeNull();
    combo.fall(10);
    combo.fall(11);
    expect(combo.fall(12).step.tierUp).toEqual({ tier: 'chic', rank: 1 });
  });

  it('rejects a window that is not a positive whole number of ticks', () => {
    expect(() => new CascadeCombo(CASCADE, 0)).toThrow(RangeError);
    expect(() => new CascadeCombo(CASCADE, 2.5)).toThrow(RangeError);
  });
});

describe('PourTimer: the Perfect Pour window', () => {
  const pour = () => new PourTimer(1_000, 120);

  it('grades a release on the marker or at either edge of the window as perfect', () => {
    for (const held of [880, 1_000, 1_120]) {
      const timer = pour();
      timer.start(5_000);
      expect(timer.inWindow(5_000 + held)).toBe(true);
      expect(timer.release(5_000 + held)).toEqual({
        grade: 'perfect',
        offsetMs: held - 1_000,
        heldMs: held,
      });
    }
  });

  it('grades just outside the window as early or late', () => {
    const early = pour();
    early.start(0);
    expect(early.inWindow(879)).toBe(false);
    expect(early.release(879).grade).toBe('early');

    const late = pour();
    late.start(0);
    expect(late.inWindow(1_121)).toBe(false);
    expect(late.release(1_121)).toEqual({ grade: 'late', offsetMs: 121, heldMs: 1_121 });
  });

  it('reports gauge progress, 1 on the marker, 0 when idle', () => {
    const timer = pour();
    expect(timer.progress(300)).toBe(0);
    expect(timer.inWindow(300)).toBe(false);
    timer.start(100);
    expect(timer.progress(50)).toBe(0);
    expect(timer.progress(600)).toBe(0.5);
    expect(timer.progress(1_100)).toBe(1);
    expect(timer.progress(2_100)).toBe(2);
  });

  it('a cancelled pour is not graded and a new one can start', () => {
    const timer = pour();
    timer.start(0);
    timer.cancel();
    expect(timer.pouring).toBe(false);
    expect(() => timer.release(1_000)).toThrow(/no pour is running/);
    timer.start(10);
    expect(timer.pouring).toBe(true);
  });

  it('refuses a second start and an impossible window', () => {
    const timer = pour();
    timer.start(0);
    expect(() => {
      timer.start(1);
    }).toThrow(/already running/);
    expect(() => new PourTimer(0, 0)).toThrow(RangeError);
    expect(() => new PourTimer(1_000, 1_000)).toThrow(RangeError);
    expect(() => new PourTimer(1_000, -1)).toThrow(RangeError);
    expect(() => new PourTimer(Number.POSITIVE_INFINITY, 1)).toThrow(RangeError);
  });
});

describe('DecorumModel: the meter and the Concierge freeze', () => {
  const rules = { perNudge: 1, decayPerSecond: 0.5 };

  it('fills a nudge at a time and stops at capacity', () => {
    const model = new DecorumModel(rules, 3, 0);
    model.nudge(0);
    model.nudge(0);
    expect(model.snapshot(0)).toEqual({ used: 2, capacity: 3, fraction: 2 / 3, frozenSeconds: 0 });
    model.nudge(0);
    model.nudge(0);
    expect(model.snapshot(0).used).toBe(3);
  });

  it('drains over time, never below empty', () => {
    const model = new DecorumModel(rules, 4, 0);
    model.nudge(0);
    model.nudge(0);
    expect(model.snapshot(2_000).used).toBe(1);
    expect(model.snapshot(60_000).used).toBe(0);
    expect(model.snapshot(1_000).used).toBe(0);
  });

  it('never predicts a freeze: only the server starts one', () => {
    const model = new DecorumModel(rules, 2, 0);
    for (let i = 0; i < 5; i += 1) model.nudge(0);
    expect(model.frozen(0)).toBe(false);
  });

  it('takes the server meter and freeze, then thaws on time exactly once', () => {
    const model = new DecorumModel(rules, 4, 0);
    model.nudge(0);
    model.reconcile(1, 3_000, 1_000);
    expect(model.frozen(1_000)).toBe(true);
    expect(model.snapshot(1_000)).toEqual({ used: 4, capacity: 4, fraction: 1, frozenSeconds: 3 });
    expect(model.thawIfDue(3_999)).toBe(false);
    expect(model.frozen(3_999)).toBe(true);
    expect(model.thawIfDue(4_000)).toBe(true);
    expect(model.thawIfDue(4_001)).toBe(false);
    expect(model.frozen(4_000)).toBe(false);
  });

  it('keeps draining during a freeze, as the server does', () => {
    const model = new DecorumModel(rules, 4, 0);
    model.reconcile(1, 4_000, 0);
    expect(model.snapshot(2_000).used).toBe(3);
  });

  it('a server answer with no freeze clears a predicted one', () => {
    const model = new DecorumModel(rules, 4, 0);
    model.reconcile(1, 5_000, 0);
    model.reconcile(0.25, null, 100);
    expect(model.frozen(100)).toBe(false);
    model.reconcile(0.25, 0, 100);
    expect(model.frozen(100)).toBe(false);
  });

  it('keeps the share of the meter when capacity changes', () => {
    const model = new DecorumModel({ perNudge: 1, decayPerSecond: 0 }, 4, 0);
    model.nudge(0);
    model.nudge(0);
    model.setCapacity(8, 0);
    expect(model.snapshot(0)).toMatchObject({ used: 4, capacity: 8, fraction: 0.5 });
  });

  it('rejects broken rules, capacities and server fractions', () => {
    expect(() => new DecorumModel({ perNudge: 0, decayPerSecond: 0 }, 1, 0)).toThrow(RangeError);
    expect(() => new DecorumModel({ perNudge: 1, decayPerSecond: -1 }, 1, 0)).toThrow(RangeError);
    expect(() => new DecorumModel(rules, 0, 0)).toThrow(RangeError);
    const model = new DecorumModel(rules, 1, 0);
    expect(() => {
      model.setCapacity(Number.NaN, 0);
    }).toThrow(RangeError);
    expect(() => {
      model.reconcile(1.01, null, 0);
    }).toThrow(RangeError);
    expect(() => {
      model.reconcile(Number.NaN, null, 0);
    }).toThrow(RangeError);
  });

  it('capacity starts from the economy upgrade line and grows with its level', () => {
    expect(decorumCapacity({})).toBeGreaterThan(0);
    expect(decorumCapacity({ 'no-such-line': 9 })).toBe(decorumCapacity({}));
  });
});

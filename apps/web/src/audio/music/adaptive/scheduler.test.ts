import { CASCADE_TIERS, type CascadeTier } from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import { createRng } from '../../rng.ts';
import { composeRiviera } from '../riviera.ts';
import { FakeAudioContext, FakeParam } from './fakeAudio.ts';
import {
  AdaptiveScheduler,
  MIN_LEAD_SECONDS,
  type BarStart,
  type GainPoint,
  type ScheduledEvent,
  type ScheduleWindow,
} from './scheduler.ts';
import { ADAPTIVE_PARTS, PART_SPECS, partsForTier, type AdaptivePart } from './stems.ts';
import { STING_LANDING_BEAT } from './sting.ts';
import {
  FULL_DROPS_PER_SECOND,
  MAX_TEMPO_STEP_BPM,
  MAX_TEMPO_SWING_BPM,
  NEUTRAL_DROPS_PER_SECOND,
  nextBarTempo,
  REDUCED_TEMPO_SWING_BPM,
  tempoForDropRate,
} from './tempo.ts';

const song = composeRiviera();
const BASE = song.bpm;
const TICK = 0.025;

interface Pumped {
  readonly now: number;
  readonly window: ScheduleWindow;
}

/** Drives the scheduler on a fake clock, calling `onTick` before each pump. */
function drive(
  scheduler: AdaptiveScheduler,
  from: number,
  until: number,
  onTick: (now: number) => void = () => undefined,
  step: (now: number) => number = () => TICK,
): Pumped[] {
  const pumps: Pumped[] = [];
  for (let now = from; now < until; now += step(now)) {
    onTick(now);
    pumps.push({ now, window: scheduler.pump(now) });
  }
  return pumps;
}

const barsOf = (pumps: readonly Pumped[]): BarStart[] => pumps.flatMap((p) => p.window.bars);
const eventsOf = (pumps: readonly Pumped[]): ScheduledEvent[] =>
  pumps.flatMap((p) => p.window.events);
const gainsOf = (pumps: readonly Pumped[]): GainPoint[] => pumps.flatMap((p) => p.window.gains);

function started(tier: CascadeTier | null = null, now = 0): AdaptiveScheduler {
  const scheduler = new AdaptiveScheduler(song);
  scheduler.setCascadeTier(tier, now);
  scheduler.start(now);
  return scheduler;
}

/** Rebuilds each part's gain the way the player applies it, on a real automation timeline. */
function gainTimelines(gains: readonly GainPoint[]): Map<AdaptivePart, FakeParam> {
  const ctx = new FakeAudioContext();
  const params = new Map<AdaptivePart, FakeParam>();
  for (const point of gains) {
    const param = params.get(point.part) ?? new FakeParam(ctx, point.part, 0);
    params.set(point.part, param);
    if (point.mode === 'set') {
      param.cancelScheduledValues(point.time);
      param.setValueAtTime(point.value, point.time);
    } else {
      param.linearRampToValueAtTime(point.value, point.time);
    }
  }
  return params;
}

describe('tempo mapping', () => {
  it('relaxes an idle table, plays as written at an easy pace and pushes to +8 at full speed', () => {
    expect(tempoForDropRate(0, BASE, MAX_TEMPO_SWING_BPM)).toBe(BASE - 4);
    expect(tempoForDropRate(NEUTRAL_DROPS_PER_SECOND, BASE, MAX_TEMPO_SWING_BPM)).toBe(BASE);
    expect(tempoForDropRate(FULL_DROPS_PER_SECOND, BASE, MAX_TEMPO_SWING_BPM)).toBe(BASE + 8);
    expect(tempoForDropRate(1000, BASE, MAX_TEMPO_SWING_BPM)).toBe(BASE + 8);
  });

  it('rises monotonically with the drop rate and halves its reach under reduced motion', () => {
    let previous = -Infinity;
    for (let rate = 0; rate <= 6; rate += 0.05) {
      const bpm = tempoForDropRate(rate, BASE, MAX_TEMPO_SWING_BPM);
      expect(bpm).toBeGreaterThanOrEqual(previous);
      previous = bpm;
      const reduced = tempoForDropRate(rate, BASE, REDUCED_TEMPO_SWING_BPM);
      expect(Math.abs(reduced - BASE)).toBeLessThanOrEqual(REDUCED_TEMPO_SWING_BPM);
    }
  });

  it('rejects rates and tempos that are not numbers it can use', () => {
    expect(() => tempoForDropRate(-1, BASE, 8)).toThrow(RangeError);
    expect(() => tempoForDropRate(Number.NaN, BASE, 8)).toThrow(RangeError);
    expect(() => tempoForDropRate(1, 0, 8)).toThrow(RangeError);
    expect(() => tempoForDropRate(1, BASE, 9)).toThrow(RangeError);
    expect(() => nextBarTempo(Number.POSITIVE_INFINITY, BASE, BASE, 8)).toThrow(RangeError);
  });

  it('eases each bar toward the target, never by more than the step limit', () => {
    let bpm = BASE;
    const path: number[] = [];
    for (let bar = 0; bar < 20; bar++) {
      const next = nextBarTempo(bpm, BASE + 50, BASE, MAX_TEMPO_SWING_BPM);
      expect(Math.abs(next - bpm)).toBeLessThanOrEqual(MAX_TEMPO_STEP_BPM + 1e-9);
      path.push(next);
      bpm = next;
    }
    expect(path.at(-1)).toBe(BASE + MAX_TEMPO_SWING_BPM);
    expect(nextBarTempo(BASE + 8, BASE + 8, BASE, REDUCED_TEMPO_SWING_BPM)).toBe(
      BASE + 8 - MAX_TEMPO_STEP_BPM,
    );
  });
});

describe('adaptive scheduler: tempo', () => {
  it('follows a changing drop rate and never leaves ±8 BPM or steps more than the limit per bar', () => {
    const scheduler = started();
    const rng = createRng(17);
    let nextChange = 0;
    const pumps = drive(scheduler, 0, 180, (now) => {
      if (now >= nextChange) {
        scheduler.setDropRate(rng() < 0.15 ? 0 : rng() * 8);
        nextChange = now + 0.5 + rng() * 4;
      }
    });
    const bars = barsOf(pumps);
    expect(bars.length).toBeGreaterThan(60);
    bars.forEach((bar, i) => {
      expect(bar.index).toBe(i);
      expect(Math.abs(bar.bpm - BASE)).toBeLessThanOrEqual(MAX_TEMPO_SWING_BPM);
      const previous = bars[i - 1];
      if (!previous) return;
      expect(Math.abs(bar.bpm - previous.bpm)).toBeLessThanOrEqual(MAX_TEMPO_STEP_BPM + 1e-9);
      const previousEnd = previous.start + (song.beatsPerBar * 60) / previous.bpm;
      expect(bar.start).toBeCloseTo(previousEnd, 9);
    });
    expect(new Set(bars.map((b) => b.bpm)).size).toBeGreaterThan(10);
  });

  it('settles at +8 BPM under full-speed play and at -4 BPM on an idle table', () => {
    const scheduler = started();
    scheduler.setDropRate(FULL_DROPS_PER_SECOND * 2);
    const fast = barsOf(drive(scheduler, 0, 40));
    expect(fast.at(-1)?.bpm).toBe(BASE + 8);
    scheduler.setDropRate(0);
    const idle = barsOf(drive(scheduler, 40, 80));
    expect(idle.at(-1)?.bpm).toBe(BASE - 4);
    scheduler.setDropRate(NEUTRAL_DROPS_PER_SECOND);
    const neutral = barsOf(drive(scheduler, 80, 120));
    expect(neutral.at(-1)?.bpm).toBe(BASE);
  });

  it('changes tempo only on bar boundaries: every note in a bar shares that bar tempo', () => {
    const scheduler = started('obscene');
    let rate = 0;
    const pumps = drive(scheduler, 0, 90, (now) => {
      if (Math.round(now / TICK) % 37 === 0) scheduler.setDropRate((rate = (rate + 1.3) % 7));
    });
    const bars = barsOf(pumps);
    const events = eventsOf(pumps);
    expect(events.length).toBeGreaterThan(1000);
    for (const event of events) {
      const bar = bars.find(
        (b, i) => event.at >= b.start && event.at < (bars[i + 1]?.start ?? Infinity),
      );
      expect(bar, `no bar holds the note at ${event.at}`).toBeDefined();
      if (!bar) continue;
      expect(event.secondsPerBeat).toBeCloseTo(60 / bar.bpm, 12);
    }
  });

  it('keeps the loop position: bar n of the timeline plays loop bar n mod 8', () => {
    const scheduler = started('decadent');
    scheduler.setDropRate(FULL_DROPS_PER_SECOND);
    const pumps = drive(scheduler, 0, 60);
    const bars = barsOf(pumps);
    const events = eventsOf(pumps).filter((e) => e.part === 'vibes');
    const third = bars[10];
    const fourth = bars[11];
    if (!third || !fourth) throw new Error('expected at least 12 bars in a minute');
    const inBar = events.filter((e) => e.at >= third.start && e.at < fourth.start);
    const loopBar = third.index % song.bars;
    const written = song.vibes.filter((n) => Math.floor(n.time / song.beatsPerBar) === loopBar);
    expect(inBar.map((e) => e.kind === 'tone' && e.midi)).toEqual(written.map((n) => n.midi));
  });

  it('narrows to ±4 BPM under reduced motion by gliding, not lurching', () => {
    const scheduler = started();
    scheduler.setDropRate(FULL_DROPS_PER_SECOND);
    drive(scheduler, 0, 40);
    expect(scheduler.tempoAt(39)).toBe(BASE + 8);
    scheduler.setReducedMotion(true);
    const bars = barsOf(drive(scheduler, 40, 80));
    expect(bars[0]?.bpm).toBeGreaterThan(BASE + REDUCED_TEMPO_SWING_BPM);
    expect(bars.at(-1)?.bpm).toBe(BASE + REDUCED_TEMPO_SWING_BPM);
    bars.slice(1).forEach((bar, i) => {
      expect(Math.abs(bar.bpm - (bars[i]?.bpm ?? bar.bpm))).toBeLessThanOrEqual(
        MAX_TEMPO_STEP_BPM + 1e-9,
      );
    });
  });
});

describe('adaptive scheduler: stems by Cascade tier', () => {
  const tiers: readonly (CascadeTier | null)[] = [null, ...CASCADE_TIERS];

  it('adds exactly one new part per tier, from the idle bed up to OBSCENE', () => {
    let previous = new Set<AdaptivePart>();
    for (const tier of tiers) {
      const parts = partsForTier(tier);
      for (const part of previous) expect(parts.has(part)).toBe(true);
      expect(parts.size).toBe(previous.size + (tier === null ? 2 : 1));
      previous = new Set(parts);
    }
    expect([...partsForTier(null)].sort()).toEqual(['bass', 'keys']);
    expect(partsForTier('obscene').size).toBe(ADAPTIVE_PARTS.length);
    expect(() => partsForTier('gauche' as CascadeTier)).toThrow(RangeError);
  });

  it.each(tiers)('plays exactly the stem set of tier %s', (tier) => {
    const scheduler = started(tier);
    const events = eventsOf(drive(scheduler, 0, 30));
    const playing = new Set(events.map((e) => e.part));
    expect([...playing].sort()).toEqual([...partsForTier(tier)].sort());
  });

  it('brings entering parts in from the next beat and lets leaving parts fade over a bar', () => {
    const scheduler = started(null);
    const before = drive(scheduler, 0, 5);
    const committed = scheduler.committedUntil;
    scheduler.setCascadeTier('opulent', 5);
    const rising = drive(scheduler, 5, 12);
    const bars = barsOf([...before, ...rising]);
    const entries = gainsOf(rising).filter((g) => g.part === 'kick');
    const entryStart = entries[0];
    if (!entryStart) throw new Error('the kick never got a fade');
    expect(entryStart.time).toBeGreaterThanOrEqual(committed);
    expect(entryStart.value).toBe(0);
    const bar = bars.find(
      (b, i) => entryStart.time >= b.start && entryStart.time < (bars[i + 1]?.start ?? Infinity),
    );
    if (!bar) throw new Error('fade start is outside every bar');
    const beats = (entryStart.time - bar.start) / (60 / bar.bpm);
    expect(beats).toBeCloseTo(Math.round(beats), 9);
    expect(entries.at(-1)?.value).toBeCloseTo(PART_SPECS.kick.level, 12);
    expect(entries.at(-1)?.time ?? 0).toBeCloseTo(entryStart.time + 60 / bar.bpm, 9);

    scheduler.setCascadeTier(null, 12);
    const falling = drive(scheduler, 12, 20);
    const exits = gainsOf(falling).filter((g) => g.part === 'kick');
    const exitStart = exits[0];
    const exitEnd = exits.at(-1);
    if (!exitStart || !exitEnd) throw new Error('the kick never faded out');
    expect(exitEnd.value).toBe(0);
    expect(exitEnd.time - exitStart.time).toBeCloseTo(
      (song.beatsPerBar * 60) / scheduler.tempoAt(exitStart.time),
      9,
    );
    const lateKicks = eventsOf(falling).filter((e) => e.part === 'kick' && e.at > exitEnd.time);
    expect(lateKicks).toEqual([]);
    const fadingKicks = eventsOf(falling).filter((e) => e.part === 'kick' && e.at < exitEnd.time);
    expect(fadingKicks.length).toBeGreaterThan(0);
  });

  it('crossfades without a click however fast the tier flips', () => {
    const scheduler = started(null);
    scheduler.setDropRate(FULL_DROPS_PER_SECOND);
    const rng = createRng(5);
    let nextFlip = 0;
    const until = 40;
    const pumps = drive(scheduler, 0, until, (now) => {
      if (now < nextFlip) return;
      const pick = Math.floor(rng() * tiers.length);
      scheduler.setCascadeTier(tiers[pick] ?? null, now);
      nextFlip = now + 0.1 + rng() * 1.5;
    });
    const gains = gainsOf(pumps);
    const timelines = gainTimelines(gains);
    const fastestBeat = 60 / (BASE + MAX_TEMPO_SWING_BPM);
    const dt = 0.004;
    const firstPoint = gains[0]?.time ?? 0;
    for (const part of ADAPTIVE_PARTS) {
      const param = timelines.get(part);
      if (!param) throw new Error(`${part} never received automation`);
      let worstStep = 0;
      let low = Infinity;
      let high = -Infinity;
      let previous = param.valueAt(firstPoint);
      for (let t = firstPoint; t < until; t += dt) {
        const value = param.valueAt(t);
        worstStep = Math.max(worstStep, Math.abs(value - previous));
        low = Math.min(low, value);
        high = Math.max(high, value);
        previous = value;
      }
      expect(worstStep, part).toBeLessThanOrEqual(
        (PART_SPECS[part].level / fastestBeat) * dt * 1.001,
      );
      expect(low, part).toBeGreaterThanOrEqual(0);
      expect(high, part).toBeLessThanOrEqual(PART_SPECS[part].level + 1e-9);
    }
  });
});

describe('adaptive scheduler: never in the past', () => {
  it('commits every note and gain at or after now + lead, even across stalls and tier changes', () => {
    const scheduler = started('chic');
    const rng = createRng(99);
    const pumps = drive(
      scheduler,
      0,
      120,
      (now) => {
        if (rng() < 0.05)
          scheduler.setCascadeTier(CASCADE_TIERS[Math.floor(rng() * 5)] ?? null, now);
        if (rng() < 0.05) scheduler.setDropRate(rng() * 6);
      },
      () => (rng() < 0.03 ? 0.4 + rng() * 0.8 : TICK * (0.5 + rng())),
    );
    let previousTo = 0;
    const seen = new Set<string>();
    for (const { now, window } of pumps) {
      expect(window.from).toBeGreaterThanOrEqual(previousTo);
      previousTo = Math.max(previousTo, window.to);
      for (const event of window.events) {
        expect(event.at).toBeGreaterThanOrEqual(now + MIN_LEAD_SECONDS);
        expect(event.at).toBeLessThan(window.to);
        const key = `${event.part}@${event.at.toFixed(9)}@${event.kind === 'tone' ? event.midi : event.drum}`;
        expect(seen.has(key), `double-scheduled ${key}`).toBe(false);
        seen.add(key);
      }
      for (const gain of window.gains)
        expect(gain.time).toBeGreaterThanOrEqual(now + MIN_LEAD_SECONDS);
    }
    expect(seen.size).toBeGreaterThan(1000);
  });

  it('places a tier change at or after the committed edge, never inside audio already sent', () => {
    const scheduler = started(null);
    drive(scheduler, 0, 3.3);
    const edge = scheduler.committedUntil;
    scheduler.setCascadeTier('lavish', 3.3);
    expect(scheduler.partLevelAt('shaker', edge - 1e-6)).toBe(0);
    expect(scheduler.partLevelAt('shaker', edge + 5)).toBeCloseTo(PART_SPECS.shaker.level, 12);
  });

  it('does nothing before start and rejects clock values it cannot trust', () => {
    const scheduler = new AdaptiveScheduler(song);
    expect(scheduler.pump(1).events).toEqual([]);
    expect(() => scheduler.pump(Number.NaN)).toThrow(RangeError);
    expect(() => {
      scheduler.start(-1);
    }).toThrow(RangeError);
    scheduler.start(0);
    expect(() => scheduler.pump(-0.5)).toThrow(RangeError);
    expect(() => {
      scheduler.setDropRate(-2);
    }).toThrow(RangeError);
  });

  it('keeps time but commits no notes while audio is off, and resumes on the grid', () => {
    const scheduler = started('lavish');
    drive(scheduler, 0, 4);
    scheduler.setEnabled(false);
    const silent = drive(scheduler, 4, 8);
    expect(eventsOf(silent)).toEqual([]);
    expect(barsOf(silent).length).toBeGreaterThan(0);
    scheduler.setEnabled(true);
    const back = eventsOf(drive(scheduler, 8, 10));
    expect(back.length).toBeGreaterThan(0);
    expect(Math.min(...back.map((e) => e.at))).toBeGreaterThanOrEqual(8 + MIN_LEAD_SECONDS);
  });
});

describe('adaptive scheduler: jackpot sting', () => {
  it('starts at once, in the bed tempo, and asks for a duck that holds past the landing', () => {
    const scheduler = started('obscene');
    scheduler.setDropRate(FULL_DROPS_PER_SECOND);
    drive(scheduler, 0, 30);
    const plan = scheduler.jackpot(30);
    if (!plan) throw new Error('the first jackpot must sting');
    expect(plan.at).toBeCloseTo(30 + MIN_LEAD_SECONDS, 12);
    const secondsPerBeat = 60 / scheduler.tempoAt(30);
    expect(secondsPerBeat).toBeCloseTo(60 / (BASE + 8), 12);
    const [firstNote, secondNote] = [...new Set(plan.events.map((e) => e.at))].sort(
      (a, b) => a - b,
    );
    expect((secondNote ?? 0) - (firstNote ?? 0)).toBeCloseTo(secondsPerBeat / 4, 9);
    for (const event of plan.events) expect(event.at).toBeGreaterThanOrEqual(plan.at);
    expect(plan.duck.depthDb).toBeLessThan(-10);
    expect(plan.duck.attack).toBeGreaterThan(0);
    expect(plan.duck.release).toBeGreaterThan(0.5);
    const landing = plan.at + STING_LANDING_BEAT * secondsPerBeat;
    expect(30 + plan.duck.attack + plan.duck.hold).toBeGreaterThan(landing);
    expect(plan.restoredAt).toBeCloseTo(
      30 + plan.duck.attack + plan.duck.hold + plan.duck.release,
      12,
    );
  });

  it('ignores a second jackpot while the first still rings, then stings again', () => {
    const scheduler = started();
    drive(scheduler, 0, 2);
    const first = scheduler.jackpot(2);
    if (!first) throw new Error('the first jackpot must sting');
    expect(scheduler.jackpot(2.5)).toBeNull();
    expect(scheduler.jackpot(first.restoredAt)).not.toBeNull();
  });

  it('ducks less under reduced motion', () => {
    const full = started();
    const reduced = started();
    reduced.setReducedMotion(true);
    const a = full.jackpot(1);
    const b = reduced.jackpot(1);
    if (!a || !b) throw new Error('both jackpots must sting');
    expect(b.duck.depthDb).toBeGreaterThan(a.duck.depthDb);
    expect(b.duck.depthDb).toBeLessThan(0);
  });
});

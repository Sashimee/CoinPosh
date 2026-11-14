import { RARITIES } from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import { IMPACT_MATERIALS } from '../../../audio/index.ts';
import { JUICE_ITEMS, JUICE_MINIMUM } from '../../juice.ts';
import {
  beatAt,
  dialAngle,
  DIAL_NOTCH_DEG,
  DIAL_TURNS,
  DOOR_OPEN_DEG,
  flyPose,
  FULL_SAFE,
  linePose,
  REDUCED_SAFE,
  SAFE_COLLECT_CUE,
  SAFE_JUICE,
  safeBeats,
  safeCinematicMs,
  safeCue,
  safePose,
  safeRevealDuck,
  safeSparkCount,
  safeTimeline,
  type SafeBeat,
  type SafeTimeline,
} from './plan.ts';

const STORY = ['enter', 'bolt', 'unlock', 'swing', 'reveal', 'settled'] as const;

function story(timeline: SafeTimeline) {
  return safeBeats(timeline)
    .map((beat) => beat.kind)
    .filter((kind) => kind !== 'tick' && kind !== 'turn' && kind !== 'key');
}

describe('safe timeline', () => {
  it('picks the reduced variant under reduced motion whatever opened the safe', () => {
    expect(safeTimeline(true, 'key')).toBe(REDUCED_SAFE);
    expect(safeTimeline(true, 'timer')).toBe(REDUCED_SAFE);
    expect(safeTimeline(false, 'timer')).toBe(FULL_SAFE);
  });

  it('leads a Key open with the Key turning, shifting every later beat by the same lead', () => {
    const key = safeTimeline(false, 'key');
    expect(key.keyMs).toBeGreaterThan(0);
    expect(key.dialAtMs - FULL_SAFE.dialAtMs).toBe(key.keyMs);
    expect(key.settleAtMs - FULL_SAFE.settleAtMs).toBe(key.keyMs);
    expect(safeBeats(key).some((beat) => beat.kind === 'key')).toBe(true);
    expect(safeBeats(FULL_SAFE).some((beat) => beat.kind === 'key')).toBe(false);
  });

  it('puts the contents on screen within 2.5 s of the tap, so the safe never drags', () => {
    for (const timeline of [FULL_SAFE, safeTimeline(false, 'key'), REDUCED_SAFE]) {
      expect(beatAt(safeBeats(timeline), 'reveal')).toBeLessThanOrEqual(2_500);
      expect(beatAt(safeBeats(timeline), 'settled')).toBeLessThanOrEqual(2_600);
    }
    expect(beatAt(safeBeats(REDUCED_SAFE), 'settled')).toBeLessThanOrEqual(800);
  });

  it('freezes the clock through the unlock hit-stop, and only there', () => {
    const { unlockAtMs, hitStopMs } = FULL_SAFE;
    expect(hitStopMs).toBeGreaterThanOrEqual(50);
    expect(safeCinematicMs(unlockAtMs - 1, FULL_SAFE)).toBe(unlockAtMs - 1);
    expect(safeCinematicMs(unlockAtMs + hitStopMs / 2, FULL_SAFE)).toBe(unlockAtMs);
    expect(safeCinematicMs(unlockAtMs + hitStopMs + 10, FULL_SAFE)).toBe(unlockAtMs + 10);
    expect(safeCinematicMs(-20, FULL_SAFE)).toBe(0);
    expect(REDUCED_SAFE.hitStopMs).toBe(0);
    expect(safeCinematicMs(500, REDUCED_SAFE)).toBe(500);
  });

  it('throws on a beat the timeline does not hold', () => {
    expect(() => beatAt([], 'reveal')).toThrow(/no reveal beat/);
  });
});

describe('safe beats', () => {
  it.each([
    ['full', FULL_SAFE],
    ['key', safeTimeline(false, 'key')],
    ['reduced', REDUCED_SAFE],
  ] as const)('%s: plays the story in order', (_, timeline) => {
    expect(story(timeline)).toEqual([...STORY]);
    const beats = safeBeats(timeline);
    for (let i = 1; i < beats.length; i++) {
      expect(beats[i]?.atMs).toBeGreaterThanOrEqual(beats[i - 1]?.atMs ?? 0);
    }
  });

  it('ticks once per dial notch passed, all inside the spin and before the bolt', () => {
    const beats = safeBeats(FULL_SAFE);
    const ticks = beats.filter((beat) => beat.kind === 'tick');
    let notches = 0;
    let from = 0;
    for (const turn of DIAL_TURNS) {
      notches += Math.abs(Math.floor(turn.to / DIAL_NOTCH_DEG) - Math.floor(from / DIAL_NOTCH_DEG));
      from = turn.to;
    }
    expect(ticks).toHaveLength(notches);
    expect(ticks.map((tick) => tick.step)).toEqual(ticks.map((_, index) => index + 1));
    for (const tick of ticks) {
      expect(tick.atMs).toBeGreaterThanOrEqual(FULL_SAFE.dialAtMs);
      expect(tick.atMs).toBeLessThan(beatAt(beats, 'bolt'));
    }
  });

  it('clicks at each change of direction of the combination', () => {
    const turns = safeBeats(FULL_SAFE).filter((beat) => beat.kind === 'turn');
    expect(turns).toHaveLength(DIAL_TURNS.length - 1);
  });

  it('starts the door swing once the hit-stop has passed', () => {
    const beats = safeBeats(FULL_SAFE);
    expect(beatAt(beats, 'swing')).toBe(beatAt(beats, 'unlock') + FULL_SAFE.hitStopMs);
  });

  it('has neither dial ticks nor turns under reduced motion', () => {
    const kinds = safeBeats(REDUCED_SAFE).map((beat) => beat.kind);
    expect(kinds).not.toContain('tick');
    expect(kinds).not.toContain('turn');
  });
});

describe('safe cues', () => {
  const beats = safeBeats(safeTimeline(false, 'key'));
  const beatOf = (kind: SafeBeat['kind']): SafeBeat => {
    const beat = beats.find((candidate) => candidate.kind === kind);
    if (beat === undefined) throw new Error(`expected a ${kind} beat`);
    return beat;
  };

  it('gives every beat a sound inside the engine velocity range', () => {
    for (const beat of beats) {
      const cue = safeCue(beat, 'rare');
      expect(cue.sounds.length).toBeGreaterThan(0);
      for (const sound of cue.sounds) {
        expect(IMPACT_MATERIALS).toContain(sound.material);
        expect(sound.velocity).toBeGreaterThanOrEqual(0.06);
        expect(sound.velocity).toBeLessThanOrEqual(2.8);
      }
    }
    for (const sound of SAFE_COLLECT_CUE.sounds) expect(sound.velocity).toBeLessThanOrEqual(2.8);
  });

  it('pans the ratchet ticks from side to side and lets them build', () => {
    const ticks = beats.filter((beat) => beat.kind === 'tick');
    const [firstTick, secondTick] = ticks;
    const lastTick = ticks.at(-1);
    if (!firstTick || !secondTick || !lastTick) throw new Error('expected dial ticks');
    const first = safeCue(firstTick, 'common').sounds[0];
    const second = safeCue(secondTick, 'common').sounds[0];
    const last = safeCue(lastTick, 'common').sounds[0];
    expect(Math.sign(first?.pan ?? 0)).toBe(-Math.sign(second?.pan ?? 0));
    expect(last?.velocity).toBeGreaterThan(first?.velocity ?? Infinity);
  });

  it('rings the reveal louder and ducks the music deeper the rarer the roll', () => {
    const reveal = beatOf('reveal');
    const loudness = RARITIES.map((rarity) => safeCue(reveal, rarity).sounds[0]?.velocity ?? 0);
    const depths = RARITIES.map((rarity) => safeRevealDuck(rarity).depthDb);
    for (let i = 1; i < RARITIES.length; i++) {
      expect(loudness[i]).toBeGreaterThan(loudness[i - 1] ?? Infinity);
      expect(depths[i]).toBeLessThan(depths[i - 1] ?? -Infinity);
    }
  });

  it('buzzes on the bolt and the reveal', () => {
    expect(safeCue(beatOf('bolt'), 'fine').haptic).not.toBeNull();
    expect(safeCue(beatOf('reveal'), 'fine').haptic).not.toBeNull();
  });
});

describe('safe pose', () => {
  const full = (ms: number) => safePose(ms, FULL_SAFE, false);
  const reduced = (ms: number) => safePose(ms, REDUCED_SAFE, true);

  it('starts hidden and closed, and rests open with the vault lit', () => {
    expect(full(0)).toMatchObject({ vault: 0, dial: 0, bolt: 0, swing: 0, glow: 0 });
    const rest = full(FULL_SAFE.settleAtMs);
    expect(rest.vault).toBeCloseTo(1, 5);
    expect(rest.bolt).toBe(1);
    expect(rest.swing).toBeCloseTo(DOOR_OPEN_DEG, 5);
    expect(rest.glow).toBe(1);
    expect(rest.shake).toBe(0);
  });

  it('lands the vault and swings the door past their rest before settling', () => {
    let vaultPeak = 0;
    let swingPeak = 0;
    for (let ms = 0; ms <= FULL_SAFE.settleAtMs; ms += 5) {
      vaultPeak = Math.max(vaultPeak, full(ms).vault);
      swingPeak = Math.max(swingPeak, full(ms).swing);
    }
    expect(vaultPeak).toBeGreaterThan(1);
    expect(swingPeak).toBeGreaterThan(DOOR_OPEN_DEG);
  });

  it('keeps the door shut until the bolt is drawn', () => {
    for (let ms = 0; ms < FULL_SAFE.swingAtMs; ms += 10) expect(full(ms).swing).toBe(0);
    expect(full(FULL_SAFE.swingAtMs - 1).bolt).toBeGreaterThan(0.9);
  });

  it('ends the dial on the last number of the combination', () => {
    expect(dialAngle(FULL_SAFE.dialAtMs + FULL_SAFE.dialMs, FULL_SAFE)).toBeCloseTo(
      DIAL_TURNS.at(-1)?.to ?? NaN,
      5,
    );
    expect(dialAngle(0, REDUCED_SAFE)).toBe(0);
  });

  it('shakes and flashes on the unlock in full motion only', () => {
    const unlock = FULL_SAFE.unlockAtMs;
    const shaken = [10, 30, 60, 90].some((d) => Math.abs(full(unlock + d).shake) > 0.5);
    expect(shaken).toBe(true);
    expect(full(unlock + 20).flash).toBeGreaterThan(0);
    for (let ms = 0; ms <= REDUCED_SAFE.settleAtMs + 200; ms += 10) {
      const pose = reduced(ms);
      expect(pose.shake).toBe(0);
      expect(pose.flash).toBe(0);
      expect(pose.swing).toBe(0);
      expect(pose.dial).toBe(0);
      expect(pose.vault).toBe(1);
      expect(pose.keyIn).toBeNull();
    }
  });

  it('cross-fades the door under reduced motion instead of swinging it', () => {
    expect(reduced(0).door).toBe(1);
    expect(reduced(REDUCED_SAFE.settleAtMs).door).toBe(0);
    expect(reduced(REDUCED_SAFE.settleAtMs).glow).toBe(1);
  });

  it('turns the Key in the lock on a Key open and shows none on a timer open', () => {
    const key = safeTimeline(false, 'key');
    expect(safePose(key.keyMs, key, false)).toMatchObject({ keyIn: 1, keyTurn: 90 });
    expect(full(100).keyIn).toBeNull();
  });
});

describe('safe content lines', () => {
  it('pops each line after the one before, with a springy overshoot, and rests on 1', () => {
    const at = (ms: number, index: number) => linePose(ms, index, FULL_SAFE, false);
    const first = FULL_SAFE.revealAtMs;
    expect(at(first - 1, 0).shown).toBe(0);
    expect(at(first + FULL_SAFE.lineStaggerMs - 1, 1).shown).toBe(0);
    let peak = 0;
    for (let ms = first; ms <= first + FULL_SAFE.linePopMs; ms += 5) {
      peak = Math.max(peak, at(ms, 0).scale);
    }
    expect(peak).toBeGreaterThan(1);
    expect(at(first + FULL_SAFE.linePopMs, 0)).toEqual({ shown: 1, scale: 1, rise: 0 });
  });

  it('shows every line in place under reduced motion', () => {
    const rest = linePose(REDUCED_SAFE.settleAtMs, 3, REDUCED_SAFE, true);
    expect(rest).toEqual({ shown: 1, scale: 1, rise: 0 });
    expect(linePose(REDUCED_SAFE.revealAtMs + 50, 0, REDUCED_SAFE, true).scale).toBe(1);
  });

  it('has every line resting by the time the player may collect, up to six lines', () => {
    for (const timeline of [FULL_SAFE, REDUCED_SAFE]) {
      const reducedMotion = timeline === REDUCED_SAFE;
      const last = timeline.revealAtMs + 5 * timeline.lineStaggerMs + timeline.linePopMs;
      expect(linePose(last, 5, timeline, reducedMotion).shown).toBe(1);
    }
  });
});

describe('safe collect flight', () => {
  it('travels to the HUD while shrinking and fading, and arrives', () => {
    expect(flyPose(0, FULL_SAFE, false)).toEqual({ travel: 0, scale: 1, fade: 1 });
    const end = flyPose(FULL_SAFE.flyMs, FULL_SAFE, false);
    expect(end.travel).toBe(1);
    expect(end.scale).toBeLessThan(0.3);
    expect(end.fade).toBe(0);
  });

  it('fades in place under reduced motion', () => {
    const mid = flyPose(REDUCED_SAFE.flyMs / 2, REDUCED_SAFE, true);
    expect(mid.travel).toBe(0);
    expect(mid.scale).toBe(1);
    expect(mid.fade).toBeCloseTo(0.5, 5);
  });
});

describe('safe juice', () => {
  it('meets the checklist minimum with known items and declares a reduced variant', () => {
    expect(SAFE_JUICE.items.length).toBeGreaterThanOrEqual(JUICE_MINIMUM);
    for (const item of SAFE_JUICE.items) expect(Object.keys(JUICE_ITEMS)).toContain(item);
    expect(new Set(SAFE_JUICE.items).size).toBe(SAFE_JUICE.items.length);
    expect(SAFE_JUICE.reduced.length).toBeGreaterThan(0);
  });

  it('throws more sparks the rarer the roll', () => {
    const counts = RARITIES.map(safeSparkCount);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeGreaterThan(counts[i - 1] ?? Infinity);
    }
  });
});

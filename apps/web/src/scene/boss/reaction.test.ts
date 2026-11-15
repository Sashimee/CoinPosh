import { BOSS_KINDS, CASCADE_TIERS } from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import {
  cascadeRank,
  crossfade,
  EXIT_DEPTH,
  poseAt,
  react,
  REACTION_SECONDS,
  REST_POSE,
  RESTING,
  settle,
  SHOCK_RANK,
  SHOCK_STRENGTH,
  WATCH_RANK,
  type BossInput,
  type BossPose,
  type BossReaction,
} from './reaction.ts';

function run(inputs: readonly (readonly [number, BossInput])[], from = RESTING): BossReaction {
  return inputs.reduce((state, [at, input]) => react(state, input, at), from);
}

const tier = (rank: number): BossInput => ({ kind: 'cascadeTier', rank });
const end: BossInput = { kind: 'cascadeEnd' };

describe('cascade ranks', () => {
  it('maps the ladder to 1-based ranks and no tier to 0', () => {
    expect(cascadeRank(null)).toBe(0);
    expect(CASCADE_TIERS.map(cascadeRank)).toEqual([1, 2, 3, 4, 5]);
    expect(WATCH_RANK).toBe(cascadeRank('lavish'));
    expect(SHOCK_RANK).toBe(cascadeRank('opulent'));
  });
});

describe('react: cascades', () => {
  it('ignores a chic cascade but marks the chain running', () => {
    const s = react(RESTING, tier(1), 1);
    expect(s.mood).toBe('idle');
    expect(s.chain).toBe(true);
    expect(s.rank).toBe(1);
  });

  it('treats untiered steps as a running chain without a mood change', () => {
    const s = react(RESTING, { kind: 'cascadeStep', count: 2, rank: 0 }, 1);
    expect(s).toMatchObject({ mood: 'idle', chain: true, rank: 0 });
  });

  it('starts watching at lavish', () => {
    const s = run([
      [1, tier(1)],
      [1.2, tier(2)],
    ]);
    expect(s).toMatchObject({ mood: 'watch', since: 1.2, rank: 2 });
  });

  it.each([
    [3, SHOCK_STRENGTH.opulent],
    [4, SHOCK_STRENGTH.decadent],
    [5, SHOCK_STRENGTH.obscene],
  ])('shocks at rank %i with its tier strength', (rank, strength) => {
    const s = react(RESTING, tier(rank), 2);
    expect(s).toMatchObject({ mood: 'shock', since: 2, strength, shockedRank: rank });
  });

  it('escalates: each higher tier in one chain shocks again, harder', () => {
    const first = run([[1, tier(3)]]);
    const second = react(first, tier(4), 1.3);
    expect(second.since).toBe(1.3);
    expect(second.strength).toBeGreaterThan(first.strength);
    const third = react(second, tier(5), 1.5);
    expect(third.strength).toBe(1);
  });

  it('does not shock twice at the same rank in one chain', () => {
    const first = run([[1, tier(3)]]);
    const again = react(first, tier(3), 1.2);
    expect(again.since).toBe(1);
    const step = react(first, { kind: 'cascadeStep', count: 9, rank: 3 }, 1.3);
    expect(step.since).toBe(1);
  });

  it('never shocks for a rank below the one already reached', () => {
    const s = run([
      [1, tier(4)],
      [1.1, tier(3)],
    ]);
    expect(s).toMatchObject({ rank: 4, since: 1, shockedRank: 4 });
  });

  it('shocks again at the same rank in a new chain', () => {
    const s = run([
      [1, tier(3)],
      [3, end],
      [4, tier(3)],
    ]);
    expect(s).toMatchObject({ mood: 'shock', since: 4 });
  });

  it('resets the chain on end', () => {
    const s = run([
      [1, tier(2)],
      [2, end],
    ]);
    expect(s).toMatchObject({ chain: false, rank: 0, shockedRank: 0, endedAt: 2 });
  });

  it('is pure: the same inputs give the same state', () => {
    const inputs: [number, BossInput][] = [
      [1, tier(2)],
      [1.5, tier(4)],
      [2, { kind: 'hit', share: 0.01 }],
      [3, end],
    ];
    expect(run(inputs)).toEqual(run(inputs));
  });
});

describe('settle: timing', () => {
  it('a shock plays out, then the figure watches while the chain runs', () => {
    const shocked = run([[1, tier(3)]]);
    expect(settle(shocked, 1 + REACTION_SECONDS.shock - 0.01).mood).toBe('shock');
    const after = settle(shocked, 1 + REACTION_SECONDS.shock + 5);
    expect(after).toMatchObject({ mood: 'watch', since: 1 + REACTION_SECONDS.shock });
  });

  it('a shock whose chain ended lingers in watch, then goes idle', () => {
    const s = run([
      [1, tier(5)],
      [1.2, end],
    ]);
    const shockEnd = 1 + REACTION_SECONDS.shock;
    expect(settle(s, shockEnd + 0.1).mood).toBe('watch');
    const idle = settle(s, shockEnd + REACTION_SECONDS.watchLinger + 0.01);
    expect(idle).toMatchObject({ mood: 'idle', since: shockEnd + REACTION_SECONDS.watchLinger });
  });

  it('a watch lingers after the chain ends, then goes idle', () => {
    const s = run([
      [1, tier(2)],
      [5, end],
    ]);
    expect(settle(s, 5 + REACTION_SECONDS.watchLinger - 0.01).mood).toBe('watch');
    expect(settle(s, 5 + REACTION_SECONDS.watchLinger).mood).toBe('idle');
  });

  it('keeps watching indefinitely while the chain runs', () => {
    expect(settle(run([[1, tier(2)]]), 600).mood).toBe('watch');
  });

  it('settles inside react, so a late input sees the played-out state', () => {
    const s = react(run([[0, tier(3)]]), { kind: 'hit', share: 0.02 }, 10);
    expect(s.mood).toBe('flinch');
  });

  it('leaves idle and finished moods alone', () => {
    expect(settle(RESTING, 1e6)).toBe(RESTING);
    const done = react(RESTING, { kind: 'status', status: 'defeated' }, 1);
    expect(settle(done, 1e6)).toBe(done);
  });
});

describe('react: hits', () => {
  it('flinches from idle with a floor and full strength at the cap', () => {
    const tiny = react(RESTING, { kind: 'hit', share: 0 }, 1);
    expect(tiny).toMatchObject({ mood: 'flinch', since: 1 });
    expect(tiny.strength).toBeCloseTo(0.3);
    expect(react(RESTING, { kind: 'hit', share: 0.5 }, 1).strength).toBe(1);
    expect(react(RESTING, { kind: 'hit', share: Number.NaN }, 1).strength).toBeCloseTo(0.3);
    expect(react(RESTING, { kind: 'hit', share: -3 }, 1).strength).toBeCloseTo(0.3);
  });

  it('flinches while watching and returns to the watch while the chain runs', () => {
    const s = run([
      [1, tier(2)],
      [2, { kind: 'hit', share: 0.01 }],
    ]);
    expect(s.mood).toBe('flinch');
    expect(settle(s, 2 + REACTION_SECONDS.flinch + 1e-6).mood).toBe('watch');
  });

  it('a flinch from idle ends in idle', () => {
    const s = react(RESTING, { kind: 'hit', share: 0.01 }, 1);
    expect(settle(s, 1 + REACTION_SECONDS.flinch)).toMatchObject({
      mood: 'idle',
      since: 1 + REACTION_SECONDS.flinch,
    });
  });

  it('a hit never cuts a shock short', () => {
    const shocked = run([[1, tier(4)]]);
    expect(react(shocked, { kind: 'hit', share: 1 }, 1.2)).toEqual(settle(shocked, 1.2));
  });

  it('a big tier during a flinch shocks', () => {
    const s = run([
      [1, { kind: 'hit', share: 0.01 }],
      [1.1, tier(3)],
    ]);
    expect(s.mood).toBe('shock');
  });
});

describe('react: status', () => {
  it.each(['defeated', 'escaped'] as const)('%s is terminal for cascades and hits', (status) => {
    const done = run([
      [1, tier(2)],
      [2, { kind: 'status', status }],
    ]);
    expect(done).toMatchObject({ mood: status, since: 2, chain: false });
    const later = run(
      [
        [3, tier(5)],
        [4, { kind: 'hit', share: 1 }],
        [5, end],
      ],
      done,
    );
    expect(later).toEqual(done);
  });

  it('repeating the same status keeps the original start', () => {
    const done = react(RESTING, { kind: 'status', status: 'escaped' }, 1);
    expect(react(done, { kind: 'status', status: 'escaped' }, 9)).toBe(done);
  });

  it('active brings a finished figure back, and does nothing to a live one', () => {
    const done = react(RESTING, { kind: 'status', status: 'defeated' }, 1);
    expect(react(done, { kind: 'status', status: 'active' }, 7)).toEqual({ ...RESTING, since: 7 });
    const watching = run([[1, tier(2)]]);
    expect(react(watching, { kind: 'status', status: 'active' }, 2)).toEqual(watching);
  });
});

const ANIMATED: readonly (keyof BossPose)[] = Object.keys(REST_POSE) as (keyof BossPose)[];

describe('poseAt', () => {
  it.each(BOSS_KINDS)('%s idles with motion but holds still under reduced motion', (kind) => {
    const a = poseAt(kind, RESTING, 1, false);
    const b = poseAt(kind, RESTING, 2.7, false);
    expect(ANIMATED.some((key) => a[key] !== b[key])).toBe(true);
    expect(poseAt(kind, RESTING, 1, true)).toEqual(REST_POSE);
    expect(poseAt(kind, RESTING, 2.7, true)).toEqual(REST_POSE);
  });

  it.each(BOSS_KINDS)('%s reduced-motion shock moves only light, never the body', (kind) => {
    const s = react(RESTING, tier(5), 0);
    for (const t of [0, 0.1, 0.4, 1]) {
      const pose = poseAt(kind, s, t, true);
      for (const key of ANIMATED) {
        if (key === 'glint' || key === 'halo') continue;
        expect(pose[key]).toBe(REST_POSE[key]);
      }
    }
    expect(poseAt(kind, s, 0.05, true).glint).toBeGreaterThan(poseAt(kind, s, 1.5, true).glint);
  });

  it.each(BOSS_KINDS)('%s shock jumps the body and pops the hat', (kind) => {
    const s = react(RESTING, tier(5), 0);
    const peak = poseAt(kind, s, 0.15, false);
    const rest = poseAt(kind, RESTING, 0.15, false);
    expect(peak.rise).toBeGreaterThan(rest.rise);
    expect(peak.hatLift).toBeGreaterThan(0);
    expect(peak.glint).toBeGreaterThan(rest.glint);
    expect(peak.halo).toBeGreaterThan(rest.halo);
  });

  it.each(BOSS_KINDS)('%s shock flashes no brighter than the reduced-motion flash', (kind) => {
    const s = react(RESTING, tier(5), 0);
    let moving = 0;
    let still = 0;
    for (let t = 0; t < 1.7; t += 1 / 120) {
      moving = Math.max(moving, poseAt(kind, s, t, false).glint);
      still = Math.max(still, poseAt(kind, s, t, true).glint);
    }
    expect(moving).toBeGreaterThan(1);
    expect(moving).toBeLessThanOrEqual(still + 1e-9);
  });

  it('writes into the pose it is handed, and reuses no state between calls', () => {
    const out = { ...REST_POSE };
    const s = react(RESTING, tier(5), 0);
    expect(poseAt('rivalTycoon', s, 0.15, false, out)).toBe(out);
    expect(out).toEqual(poseAt('rivalTycoon', s, 0.15, false));
    poseAt('taxInspector', react(RESTING, { kind: 'hit', share: 1 }, 0), 0.05, false);
    expect(out).toEqual(poseAt('rivalTycoon', s, 0.15, false));
  });

  it('a bigger tier shocks harder', () => {
    const soft = poseAt('taxInspector', react(RESTING, tier(3), 0), 0.15, false);
    const hard = poseAt('taxInspector', react(RESTING, tier(5), 0), 0.15, false);
    expect(hard.rise).toBeGreaterThan(soft.rise);
    expect(hard.hatLift).toBeGreaterThan(soft.hatLift);
  });

  it('only the top tier knocks the monocle out', () => {
    const at = (rank: number): number =>
      poseAt('rivalTycoon', react(RESTING, tier(rank), 0), 0.5, false).eyewearDrop;
    expect(at(4)).toBe(0);
    expect(at(5)).toBeGreaterThan(0.5);
  });

  it.each([false, true])('the end of the week sinks the figure out of sight (reduced %s)', (r) => {
    const done = react(RESTING, { kind: 'status', status: 'defeated' }, 0);
    expect(poseAt('rivalTycoon', done, REACTION_SECONDS.exit, r).rise).toBeCloseTo(-EXIT_DEPTH);
  });

  it('every pose is finite', () => {
    const states = [
      RESTING,
      run([[0, tier(2)]]),
      run([[0, tier(5)]]),
      react(RESTING, { kind: 'hit', share: 0.05 }, 0),
      react(RESTING, { kind: 'status', status: 'escaped' }, 0),
    ];
    for (const kind of BOSS_KINDS) {
      for (const s of states) {
        for (const t of [0, 0.03, 0.5, 1.2, 3]) {
          for (const reduced of [false, true]) {
            const pose = poseAt(kind, s, t, reduced);
            for (const key of ANIMATED) expect(Number.isFinite(pose[key])).toBe(true);
          }
        }
      }
    }
  });
});

describe('crossfade', () => {
  const to: BossPose = { ...REST_POSE, rise: 0.02, lean: 0.3 };

  it('starts at the old pose and ends at the new one', () => {
    expect(crossfade(REST_POSE, to, 0, 0.5, false).rise).toBeCloseTo(0);
    expect(crossfade(REST_POSE, to, 10, 0.5, false)).toEqual(to);
    expect(crossfade(REST_POSE, to, 0.1, 0, false)).toEqual(to);
  });

  it('overshoots a touch with motion, never under reduced motion', () => {
    const peak = (reduced: boolean): number => {
      let max = 0;
      for (let t = 0; t <= 1.25; t += 0.01)
        max = Math.max(max, crossfade(REST_POSE, to, t, 0.5, reduced).lean);
      return max;
    };
    expect(peak(false)).toBeGreaterThan(to.lean);
    expect(peak(false)).toBeLessThanOrEqual(to.lean * 1.08 + 1e-9);
    expect(peak(true)).toBeLessThanOrEqual(to.lean + 1e-9);
  });
});

import { STAFF_ROLES, type StaffRole } from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import { PitchVariator } from '../collecting/variation.ts';
import { createRng } from '../rng.ts';
import { MAX_IMPACT_PAN, PITCH_JITTER } from '../synth/impactSpec.ts';
import {
  buildStaffWalk,
  FOOTSTEP_PRIORITY,
  FOOTSTEP_PROFILES,
  MAX_WALK_STEPS,
  staffWalkCost,
  type StaffWalk,
  type StaffWalkSpec,
} from './footsteps.ts';

const RATE = 48000;

function walk(role: StaffRole, request: StaffWalk, seed = 1): StaffWalkSpec {
  const rng = createRng(seed);
  return buildStaffWalk(role, request, new PitchVariator(rng), rng);
}

describe('staff footsteps', () => {
  it.each(STAFF_ROLES)('%s walks at its own cadence, feet alternating', (role) => {
    const spec = walk(role, { steps: 8 });
    const { cadence } = FOOTSTEP_PROFILES[role];
    expect(spec.steps).toHaveLength(8);
    expect(spec.steps[0]?.at).toBe(0);
    spec.steps.forEach((step, i) => {
      expect(step.foot).toBe(i % 2 === 0 ? 'left' : 'right');
      const next = spec.steps[i + 1];
      if (next) {
        const gap = next.at - step.at;
        expect(gap).toBeGreaterThan(cadence * 0.96);
        expect(gap).toBeLessThan(cadence * 1.04);
      }
    });
    expect(spec.priority).toBe(FOOTSTEP_PRIORITY);
  });

  it('gives each role its own gait and soles', () => {
    const cadences = STAFF_ROLES.map((role) => FOOTSTEP_PROFILES[role].cadence);
    const heels = STAFF_ROLES.map((role) => FOOTSTEP_PROFILES[role].heel.frequency);
    expect(new Set(cadences).size).toBe(STAFF_ROLES.length);
    expect(new Set(heels).size).toBe(STAFF_ROLES.length);
    expect(FOOTSTEP_PROFILES.valet.cadence).toBeLessThan(FOOTSTEP_PROFILES.butler.cadence);
    for (const role of STAFF_ROLES) {
      expect(FOOTSTEP_PROFILES[role].level).toBeLessThanOrEqual(0.2);
    }
  });

  it('never lands two footfalls on the same pitch and keeps within ±6 %', () => {
    const rng = createRng(7);
    const pitch = new PitchVariator<StaffRole>(rng);
    const pitches: number[] = [];
    for (let i = 0; i < 30; i++) {
      const spec = buildStaffWalk('butler', { steps: 1 }, pitch, rng);
      pitches.push(spec.steps[0]?.pitch ?? NaN);
    }
    pitches.forEach((p, i) => {
      expect(Math.abs(p - 1)).toBeLessThanOrEqual(PITCH_JITTER + 1e-9);
      if (i > 0) expect(p).not.toBe(pitches[i - 1]);
    });
  });

  it('reads a fresh slice of noise for every heel and toe', () => {
    const spec = walk('valet', { steps: 6 });
    const offsets = spec.steps.flatMap((s) => [s.heelOffset, s.toeOffset]);
    expect(new Set(offsets).size).toBe(offsets.length);
    for (const offset of offsets) {
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(1);
    }
  });

  it('pans across the table from where the walk starts to where it ends', () => {
    const spec = walk('sommelier', { steps: 5, fromPan: -0.6, toPan: 0.6 });
    const pans = spec.steps.map((s) => s.pan);
    expect(pans[0]).toBeLessThan(-0.5);
    expect(pans.at(-1)).toBeGreaterThan(0.5);
    const far = walk('butler', { steps: 2, fromPan: -5, toPan: 5 });
    for (const step of far.steps) expect(Math.abs(step.pan)).toBeLessThanOrEqual(MAX_IMPACT_PAN);
  });

  it('starts on the foot it is told to', () => {
    expect(walk('butler', { steps: 2, firstFoot: 'right' }).steps.map((s) => s.foot)).toEqual([
      'right',
      'left',
    ]);
  });

  it('jingles keys and clinks bottles only for the staff who carry them', () => {
    const trinkets = (role: StaffRole) =>
      walk(role, { steps: MAX_WALK_STEPS }, 3).steps.filter((s) => s.trinket).length;
    expect(trinkets('butler')).toBe(0);
    let valet = 0;
    let sommelier = 0;
    for (let seed = 1; seed <= 10; seed++) {
      valet += walk('valet', { steps: MAX_WALK_STEPS }, seed).steps.filter((s) => s.trinket).length;
      sommelier += walk('sommelier', { steps: MAX_WALK_STEPS }, seed).steps.filter(
        (s) => s.trinket,
      ).length;
    }
    expect(valet).toBeGreaterThan(0);
    expect(valet).toBeLessThan(10 * MAX_WALK_STEPS);
    expect(sommelier).toBeGreaterThan(0);
  });

  it('counts heel, toe and body per footfall plus any trinket partials', () => {
    const butler = walk('butler', { steps: 4 });
    expect(staffWalkCost(butler, RATE)).toBe(12);
    const valet = walk('valet', { steps: MAX_WALK_STEPS }, 2);
    const jingles = valet.steps.filter((s) => s.trinket).length;
    expect(staffWalkCost(valet, RATE)).toBe(3 * MAX_WALK_STEPS + 3 * jingles);
    expect(jingles).toBeGreaterThan(0);
    const lowRate = staffWalkCost(valet, 8000);
    expect(lowRate).toBeLessThan(staffWalkCost(valet, RATE));
    expect(lowRate).toBeLessThanOrEqual(3 * MAX_WALK_STEPS + jingles);
  });

  it('rejects walks it cannot play', () => {
    for (const steps of [0, -1, 1.5, MAX_WALK_STEPS + 1, Number.NaN]) {
      expect(() => walk('butler', { steps })).toThrow(RangeError);
    }
    expect(() => walk('butler', { steps: 2, toPan: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });

  it('rings out fully inside its duration', () => {
    const spec = walk('sommelier', { steps: 3 });
    const last = spec.steps.at(-1)?.at ?? 0;
    expect(spec.duration).toBeGreaterThan(last + FOOTSTEP_PROFILES.sommelier.body.t60);
  });
});

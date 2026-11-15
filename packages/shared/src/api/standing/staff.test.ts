import { describe, expect, it } from 'vitest';
import { roundTrip } from '../../test/roundTrip.ts';
import { standingFixtures, standingNow, standingStaff } from './fixtures.ts';
import {
  householdIdleBoostBp,
  STAFF_STATUSES,
  StaffChangeResponseSchema,
  StaffHireRequestSchema,
  StaffMemberSchema,
  StaffPayRequestSchema,
  StaffResponseSchema,
  StaffTrainRequestSchema,
  type StaffMember,
} from './staff.ts';

const { vacant, employed, onLeave } = standingStaff;
const sheet = standingFixtures.standingStaff.response;
const day = 86_400_000;
const issuePaths = (result: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path);

describe('StaffMemberSchema', () => {
  it.each(STAFF_STATUSES)('round-trips a member who is %s', (status) => {
    const { parsed, reparsed } = roundTrip(StaffMemberSchema, standingStaff[status]);
    expect(reparsed).toEqual(parsed);
  });

  it('accepts a member at the top level with no training left', () => {
    const top = { ...employed, level: 10, training: null };
    expect(StaffMemberSchema.safeParse(top).success).toBe(true);
  });

  it.each([
    ['a level past the maximum', employed, { level: 11, training: null }, ['level']],
    [
      'training at the top level',
      employed,
      { level: 10, training: { ...employed.training, level: 11 } },
      ['training'],
    ],
    ['no training below the top level', employed, { training: null }, ['training']],
    [
      'training that skips a level',
      employed,
      { training: { ...employed.training, level: 5 } },
      ['training'],
    ],
    [
      'training open before the hire',
      employed,
      { training: { ...employed.training, eligibleAt: employed.hiredAt - 1 } },
      ['training'],
    ],
    [
      'wages paid until before the hire',
      employed,
      { wagesPaidUntil: employed.hiredAt - 1 },
      ['wagesPaidUntil'],
    ],
    ['leave before the hire', onLeave, { leaveSince: onLeave.hiredAt - 1 }, ['leaveSince']],
  ] as const)('rejects %s', (_label, member, change, path) => {
    expect(issuePaths(StaffMemberSchema.safeParse({ ...member, ...change }))).toEqual([path]);
  });

  it.each([
    ['an unknown role', { ...vacant, role: 'chauffeur' }],
    ['a free hire', { ...vacant, hireCost: 0 }],
    ['level 0 staff at work', { ...employed, level: 0 }],
    ['leave with nothing owed', { ...onLeave, wagesOwed: 0 }],
    ['an employed member missing a wage', { ...employed, dailyWage: undefined }],
    ['an unknown status', { ...employed, status: 'fired' }],
  ])('rejects %s', (_label, member) => {
    expect(StaffMemberSchema.safeParse(member).success).toBe(false);
  });
});

describe('householdIdleBoostBp', () => {
  const members = sheet.staff.map((member) => StaffMemberSchema.parse(member));
  const hire = (role: 'valet' | 'sommelier', idleBoostBp: number): StaffMember =>
    StaffMemberSchema.parse({ ...employed, role, idleBoostBp });

  it('counts only staff at work', () => {
    expect(householdIdleBoostBp(members, 6_000)).toBe(employed.idleBoostBp);
    expect(householdIdleBoostBp([], 6_000)).toBe(0);
  });

  it('stops at the cap however many staff are at work', () => {
    const all = [hire('valet', 1_000), hire('valet', 2_500), hire('sommelier', 4_000)];
    expect(householdIdleBoostBp(all, 6_000)).toBe(6_000);
    expect(householdIdleBoostBp(all, 0)).toBe(0);
  });
});

describe('StaffResponseSchema', () => {
  it('round-trips the hire, train and wage sheet', () => {
    const { parsed, reparsed } = roundTrip(StaffResponseSchema, sheet);
    expect(reparsed).toEqual(parsed);
  });

  it('rejects a household boost that ignores the cap', () => {
    const uncapped = { ...sheet, idleBoostCapBp: 1_000 };
    expect(issuePaths(StaffResponseSchema.safeParse(uncapped))).toEqual([['idleBoostBp']]);
  });

  it('rejects a household boost that counts staff on leave', () => {
    const padded = { ...sheet, idleBoostBp: 2_000 };
    expect(issuePaths(StaffResponseSchema.safeParse(padded))).toEqual([['idleBoostBp']]);
  });

  it('rejects a sheet that lists a role twice and leaves one out', () => {
    const twice = { ...sheet, staff: [employed, vacant, { ...vacant, hireCost: 1 }] };
    expect(issuePaths(StaffResponseSchema.safeParse(twice))).toEqual([['staff'], ['staff']]);
  });

  it('rejects a sheet missing a role', () => {
    expect(StaffResponseSchema.safeParse({ ...sheet, staff: [employed, vacant] }).success).toBe(
      false,
    );
  });

  it('rejects a hire or a leave stamped after the server time', () => {
    const early = { ...sheet, serverTime: standingNow - 5 * day };
    expect(issuePaths(StaffResponseSchema.safeParse(early))).toEqual([
      ['staff', 2, 'hiredAt'],
      ['staff', 2, 'leaveSince'],
    ]);
  });
});

describe('staff uploads', () => {
  it('round-trips hire, train and pay requests', () => {
    for (const [schema, body] of [
      [StaffHireRequestSchema, standingFixtures.standingStaffHire.body],
      [StaffTrainRequestSchema, standingFixtures.standingStaffTrain.body],
      [StaffPayRequestSchema, standingFixtures.standingStaffPay.body],
    ] as const) {
      const { parsed, reparsed } = roundTrip(schema, body);
      expect(reparsed).toEqual(parsed);
    }
  });

  it.each([
    ['its own price', { hireCost: 1 }],
    ['a starting level', { level: 10 }],
    ['a hire time', { hiredAt: 0 }],
    ['its own boost', { idleBoostBp: 6_000 }],
  ])('refuses a hire that carries %s', (_label, extra) => {
    const result = StaffHireRequestSchema.safeParse({ role: 'butler', ...extra });
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
  });

  it('refuses training that names its fee or level 0', () => {
    const priced = StaffTrainRequestSchema.safeParse({ role: 'butler', level: 4, fee: 0 });
    expect(priced.error?.issues[0]?.code).toBe('unrecognized_keys');
    expect(StaffTrainRequestSchema.safeParse({ role: 'butler', level: 0 }).success).toBe(false);
  });

  it('refuses a wage payment that names the sum or a paid-until time', () => {
    for (const extra of [
      { wagesOwed: 0 },
      { amount: 1 },
      { wagesPaidUntil: standingNow + 30 * day },
    ]) {
      const result = StaffPayRequestSchema.safeParse({ role: 'sommelier', ...extra });
      expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
    }
  });
});

describe('staff answers', () => {
  it('round-trips a hire, a training and a wage payment', () => {
    for (const body of [
      standingFixtures.standingStaffHire.response,
      standingFixtures.standingStaffTrain.response,
      standingFixtures.standingStaffPay.response,
    ]) {
      const { parsed, reparsed } = roundTrip(StaffChangeResponseSchema, body);
      expect(reparsed).toEqual(parsed);
    }
  });

  it('rejects an answer that leaves the member vacant or on leave', () => {
    const answer = standingFixtures.standingStaffPay.response;
    for (const staff of [vacant, onLeave]) {
      const result = StaffChangeResponseSchema.safeParse({ ...answer, staff });
      expect(issuePaths(result)).toEqual([['staff', 'status']]);
    }
  });
});

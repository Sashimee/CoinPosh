import { z } from 'zod';
import { WalletSchema } from '../../domain.ts';
import { AmountSchema, EpochMsSchema, PositiveAmountSchema } from '../../primitives.ts';

/** The household, in the order the hire sheet lists them. */
export const STAFF_ROLES = ['butler', 'valet', 'sommelier'] as const;
export const StaffRoleSchema = z.enum(STAFF_ROLES);
export type StaffRole = z.infer<typeof StaffRoleSchema>;

/** `onLeave` staff went unpaid: they keep their level but give no boost until paid. */
export const STAFF_STATUSES = ['vacant', 'employed', 'onLeave'] as const;
export const StaffStatusSchema = z.enum(STAFF_STATUSES);
export type StaffStatus = z.infer<typeof StaffStatusSchema>;

/** The next level on offer: its coin fee, and when enough days employed make it trainable. */
export const StaffTrainingSchema = z.object({
  level: PositiveAmountSchema,
  fee: PositiveAmountSchema,
  eligibleAt: EpochMsSchema,
});
export type StaffTraining = z.infer<typeof StaffTrainingSchema>;

const hiredFields = {
  level: PositiveAmountSchema,
  maxLevel: PositiveAmountSchema,
  hiredAt: EpochMsSchema,
  /** `null` once `level` reaches `maxLevel`. */
  training: StaffTrainingSchema.nullable(),
};

/**
 * One member of staff as the server keeps them. Costs, wages and boosts are priced by
 * `packages/economy` from the player's measured rate; every amount is in coins, and every time
 * is the server's clock.
 */
export const StaffMemberSchema = z
  .discriminatedUnion('status', [
    z.object({
      role: StaffRoleSchema,
      status: z.literal('vacant'),
      hireCost: PositiveAmountSchema,
    }),
    z.object({
      role: StaffRoleSchema,
      status: z.literal('employed'),
      ...hiredFields,
      /** This member's share of the offline boost, before the household cap. */
      idleBoostBp: AmountSchema,
      dailyWage: AmountSchema,
      /** Wages are settled up to here; past it, an unpaid day sends them on leave. */
      wagesPaidUntil: EpochMsSchema,
    }),
    z.object({
      role: StaffRoleSchema,
      status: z.literal('onLeave'),
      ...hiredFields,
      leaveSince: EpochMsSchema,
      wagesOwed: PositiveAmountSchema,
    }),
  ])
  .superRefine((member, ctx) => {
    if (member.status === 'vacant') return;
    const issue = (path: string, message: string) => {
      ctx.addIssue({ code: 'custom', path: [path], message });
    };
    if (member.level > member.maxLevel) {
      issue('level', `Level ${member.level} is past the maximum of ${member.maxLevel}.`);
    }
    if (member.level === member.maxLevel && member.training !== null) {
      issue('training', 'Staff at their maximum level have no training left.');
    }
    if (member.level < member.maxLevel && member.training === null) {
      issue('training', 'Staff below their maximum level have a next training on offer.');
    }
    if (member.training !== null && member.training.level !== member.level + 1) {
      issue('training', `Training leads to level ${member.level + 1}, the next one.`);
    }
    if (member.training !== null && member.training.eligibleAt < member.hiredAt) {
      issue('training', 'Training needs days employed, so it opens after the hire.');
    }
    const since = member.status === 'employed' ? member.wagesPaidUntil : member.leaveSince;
    if (since < member.hiredAt) {
      issue(
        member.status === 'employed' ? 'wagesPaidUntil' : 'leaveSince',
        'Wages and leave start after the hire.',
      );
    }
  });
export type StaffMember = z.infer<typeof StaffMemberSchema>;
export type EmployedStaffMember = Extract<StaffMember, { status: 'employed' }>;

/** Sums employed members' boosts and caps the total, as the server settles offline time. */
export function householdIdleBoostBp(staff: readonly StaffMember[], capBp: number): number {
  const total = staff.reduce(
    (sum, member) => (member.status === 'employed' ? sum + member.idleBoostBp : sum),
    0,
  );
  return Math.min(total, capBp);
}

/**
 * The hire, train and wage sheet: every role once, and the household offline boost after the cap
 * that keeps offline earnings below play.
 */
export const StaffResponseSchema = z
  .object({
    serverTime: EpochMsSchema,
    staff: z.array(StaffMemberSchema).length(STAFF_ROLES.length),
    idleBoostBp: AmountSchema,
    idleBoostCapBp: AmountSchema,
  })
  .superRefine((sheet, ctx) => {
    STAFF_ROLES.forEach((role) => {
      const count = sheet.staff.filter((member) => member.role === role).length;
      if (count !== 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['staff'],
          message: `The sheet lists the ${role} once, not ${count} times.`,
        });
      }
    });
    sheet.staff.forEach((member, i) => {
      if (member.status !== 'vacant' && member.hiredAt > sheet.serverTime) {
        ctx.addIssue({
          code: 'custom',
          path: ['staff', i, 'hiredAt'],
          message: 'Staff cannot be hired after the server time they are reported at.',
        });
      }
      if (member.status === 'onLeave' && member.leaveSince > sheet.serverTime) {
        ctx.addIssue({
          code: 'custom',
          path: ['staff', i, 'leaveSince'],
          message: 'Staff cannot go on leave after the server time they are reported at.',
        });
      }
    });
    const expected = householdIdleBoostBp(sheet.staff, sheet.idleBoostCapBp);
    if (sheet.idleBoostBp !== expected) {
      ctx.addIssue({
        code: 'custom',
        path: ['idleBoostBp'],
        message: `The household boost is the employed staff's sum capped at ${sheet.idleBoostCapBp} bp (${expected}), not ${sheet.idleBoostBp}.`,
      });
    }
  });
export type StaffResponse = z.infer<typeof StaffResponseSchema>;

/** Names the role only: the server prices the hire from the player's measured active rate. */
export const StaffHireRequestSchema = z.strictObject({
  role: StaffRoleSchema,
});
export type StaffHireRequest = z.infer<typeof StaffHireRequestSchema>;

/**
 * `level` is the level being bought (current + 1), as upgrades name theirs: a stale client asking
 * for a level the member already has gets `conflict` instead of paying twice.
 */
export const StaffTrainRequestSchema = z.strictObject({
  role: StaffRoleSchema,
  level: PositiveAmountSchema,
});
export type StaffTrainRequest = z.infer<typeof StaffTrainRequestSchema>;

/** Settles the wages owed and brings the member back from leave; the server knows the sum. */
export const StaffPayRequestSchema = z.strictObject({
  role: StaffRoleSchema,
});
export type StaffPayRequest = z.infer<typeof StaffPayRequestSchema>;

/** Hiring, training and paying all leave the member at work. */
export const StaffChangeResponseSchema = z.object({
  staff: StaffMemberSchema.refine((member) => member.status === 'employed', {
    path: ['status'],
    message: 'Staff just hired, trained or paid are at work.',
  }),
  wallet: WalletSchema,
  idleBoostBp: AmountSchema,
});
export type StaffChangeResponse = z.infer<typeof StaffChangeResponseSchema>;

import { get, post, type Endpoint } from '../endpoint.ts';
import {
  AchievementClaimRequestSchema,
  AchievementClaimResponseSchema,
  AchievementShowcaseRequestSchema,
  AchievementShowcaseResponseSchema,
  AchievementsResponseSchema,
} from './achievements.ts';
import { MasteryResponseSchema } from './mastery.ts';
import { RanksResponseSchema } from './perks.ts';
import {
  StaffChangeResponseSchema,
  StaffHireRequestSchema,
  StaffPayRequestSchema,
  StaffResponseSchema,
  StaffTrainRequestSchema,
} from './staff.ts';

// TODO(lead-architect): pass to `composeEndpoints` in `../endpoints.ts` in T-12.13, the same
// change that adds `standingFixtures` to `test/fixtures.ts` and the Demo handlers; both are mapped
// over every EndpointName, so registering the group first breaks their typecheck. Repute and
// mastery earned on the table ride the table answers as a `StandingUpdate`, not this map.
/** Standing (M12): ranks and perks, achievements and their showcase, mastery, and staff. */
export const standingEndpoints = {
  standingRanks: get('/v1/standing/ranks', RanksResponseSchema),
  standingAchievements: get('/v1/standing/achievements', AchievementsResponseSchema),
  standingAchievementClaim: post(
    '/v1/standing/achievements/claim',
    AchievementClaimRequestSchema,
    AchievementClaimResponseSchema,
  ),
  standingShowcase: post(
    '/v1/standing/achievements/showcase',
    AchievementShowcaseRequestSchema,
    AchievementShowcaseResponseSchema,
  ),
  standingMastery: get('/v1/standing/mastery', MasteryResponseSchema),
  standingStaff: get('/v1/standing/staff', StaffResponseSchema),
  standingStaffHire: post(
    '/v1/standing/staff/hire',
    StaffHireRequestSchema,
    StaffChangeResponseSchema,
  ),
  standingStaffTrain: post(
    '/v1/standing/staff/train',
    StaffTrainRequestSchema,
    StaffChangeResponseSchema,
  ),
  standingStaffPay: post(
    '/v1/standing/staff/pay',
    StaffPayRequestSchema,
    StaffChangeResponseSchema,
  ),
} as const satisfies Record<string, Endpoint>;

export type StandingEndpoints = typeof standingEndpoints;
export type StandingEndpointName = keyof StandingEndpoints;
export const STANDING_ENDPOINT_NAMES = Object.keys(standingEndpoints) as StandingEndpointName[];

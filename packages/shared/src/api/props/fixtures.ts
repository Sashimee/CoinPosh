import type { z } from 'zod';
import type { JackpotBallClaimSchema, TargetClaimSchema } from './claims.ts';
import type { PropRewardSchema, TargetHitSchema } from './rewards.ts';

/** Saturday 2026-11-14, 21:00 UTC: a Riviera evening session. */
export const propsNow = 1_794_690_000_000;

export const propsLayoutId = 'rivieraYacht.classic';
export const propsTargetId = 'backWall.leftChute';

export const propsTargetClaim = {
  kind: 'target',
  coinId: 'coin_Riv1era0001',
  targetId: propsTargetId,
  tick: 4_812,
} satisfies z.input<typeof TargetClaimSchema>;

export const propsJackpotBallClaim = {
  kind: 'jackpotBall',
  ballId: 'jackpot_Obsidian0001',
  tick: 9_630,
  edge: 'front',
} satisfies z.input<typeof JackpotBallClaimSchema>;

export const propsRewards = {
  shower: { kind: 'shower', coins: 12 },
  crate: { kind: 'crate', crate: { id: 'crate_Riv1era0007', kind: 'vault' } },
  multiplierWindow: {
    kind: 'multiplierWindow',
    factor: 2,
    startsAt: propsNow,
    endsAt: propsNow + 20_000,
  },
} satisfies Record<z.input<typeof PropRewardSchema>['kind'], z.input<typeof PropRewardSchema>>;

export const propsTargetHit = {
  targetId: propsTargetId,
  reward: propsRewards.shower,
} satisfies z.input<typeof TargetHitSchema>;

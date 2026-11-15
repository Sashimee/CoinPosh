import { z } from 'zod';
import { WalletSchema } from '../../domain.ts';
import { AmountSchema, EpochMsSchema, PositiveAmountSchema } from '../../primitives.ts';
import { checkWindow } from './refine.ts';
import { LiveGrantSchema, LiveRewardSchema } from './rewards.ts';
import { WeekKeySchema } from './time.ts';

/** The figures behind the back wall (T-13.09); each week's boss is one of them. */
export const BOSS_KINDS = ['taxInspector', 'rivalTycoon'] as const;
export const BossKindSchema = z.enum(BOSS_KINDS);
export type BossKind = z.infer<typeof BossKindSchema>;

/**
 * `active` takes damage until `endsAt`; `defeated` hit 0 health inside the week; `escaped` saw
 * the week end with health left.
 */
export const BOSS_STATUSES = ['active', 'defeated', 'escaped'] as const;
export const BossStatusSchema = z.enum(BOSS_STATUSES);
export type BossStatus = z.infer<typeof BossStatusSchema>;

/**
 * The week's cooperative boss and its shared health bar. Damage is coin value the server banked
 * for its players that week, so health only ever falls and the boss never takes a coin.
 * `maxHealth` is set by `packages/economy` from the expected damage of active players.
 */
export const BossSchema = z
  .object({
    week: WeekKeySchema,
    kind: BossKindSchema,
    status: BossStatusSchema,
    maxHealth: PositiveAmountSchema,
    health: AmountSchema,
    contributors: AmountSchema,
    startsAt: EpochMsSchema,
    endsAt: EpochMsSchema,
    defeatedAt: EpochMsSchema.nullable(),
  })
  .superRefine((boss, ctx) => {
    const issue = (path: string, message: string) => {
      ctx.addIssue({ code: 'custom', path: [path], message });
    };
    checkWindow(boss, ctx, []);
    if (boss.health > boss.maxHealth) issue('health', 'Health cannot exceed the maximum.');
    if (boss.status === 'defeated') {
      if (boss.health !== 0) issue('health', 'A defeated boss has no health left.');
      if (boss.defeatedAt === null) issue('defeatedAt', 'A defeated boss has a defeat time.');
      else if (boss.defeatedAt < boss.startsAt || boss.defeatedAt > boss.endsAt) {
        issue('defeatedAt', 'A boss is defeated during its week.');
      }
      if (boss.contributors === 0) issue('contributors', 'Someone dealt the damage.');
      return;
    }
    if (boss.health === 0) issue('health', 'A boss with no health left is defeated.');
    if (boss.defeatedAt !== null) issue('defeatedAt', 'Only a defeated boss has a defeat time.');
    if (boss.health < boss.maxHealth && boss.contributors === 0) {
      issue('contributors', 'Lost health was dealt by at least one contributor.');
    }
  });
export type Boss = z.infer<typeof BossSchema>;

/** A contribution tier: a player who dealt `minDamage` or more earns `rewards` when the week ends. */
export const BossTierSchema = z.object({
  tier: PositiveAmountSchema,
  minDamage: PositiveAmountSchema,
  rewards: z.array(LiveRewardSchema).min(1),
});
export type BossTier = z.infer<typeof BossTierSchema>;

/** Tiers numbered from 1, each asking for more damage than the one before. */
export const BossTiersSchema = z
  .array(BossTierSchema)
  .min(1)
  .superRefine((tiers, ctx) => {
    tiers.forEach((tier, i) => {
      if (tier.tier !== i + 1) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'tier'],
          message: 'Tiers are numbered in order from 1.',
        });
      }
      const previous = tiers[i - 1];
      if (previous !== undefined && previous.minDamage >= tier.minDamage) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'minDamage'],
          message: 'Each tier asks for more damage than the one below it.',
        });
      }
    });
  });
export type BossTiers = z.infer<typeof BossTiersSchema>;

/** The highest tier `damage` reaches, or `null` below the first. */
export function bossTierFor(tiers: readonly BossTier[], damage: number): number | null {
  let reached: number | null = null;
  for (const tier of tiers) if (damage >= tier.minDamage) reached = tier.tier;
  return reached;
}

/**
 * The player's share of the fight, counted by the server: `damage` is their banked value this
 * week (the killing blow may overshoot the health left, so a defeated boss bounds no one), and `tier` the highest tier it reaches. Rewards are claimed once the boss is defeated or
 * has escaped; `claimedAt` is set after that claim.
 */
export const BossContributionSchema = z.object({
  damage: AmountSchema,
  tier: PositiveAmountSchema.nullable(),
  claimedAt: EpochMsSchema.nullable(),
});
export type BossContribution = z.infer<typeof BossContributionSchema>;

function checkContribution(
  answer: { boss: Boss; tiers: BossTiers; contribution: BossContribution },
  ctx: z.RefinementCtx,
): void {
  const { boss, tiers, contribution } = answer;
  const issue = (path: PropertyKey[], message: string) => {
    ctx.addIssue({ code: 'custom', path, message });
  };
  if (contribution.tier !== bossTierFor(tiers, contribution.damage)) {
    issue(['contribution', 'tier'], 'The tier is the highest one the damage reaches.');
  }
  if (boss.status !== 'defeated' && contribution.damage > boss.maxHealth - boss.health) {
    issue(['contribution', 'damage'], "One player's damage is part of the health the boss lost.");
  }
  if (contribution.claimedAt !== null && boss.status === 'active') {
    issue(['contribution', 'claimedAt'], 'Rewards are claimed after the fight ends.');
  }
}

/**
 * This week's boss, or the last one while its rewards wait to be claimed. `defeatBonus` is paid
 * to every contributor when the boss falls, on top of their tier.
 */
export const BossResponseSchema = z
  .object({
    serverTime: EpochMsSchema,
    boss: BossSchema,
    tiers: BossTiersSchema,
    defeatBonus: z.array(LiveRewardSchema).min(1),
    contribution: BossContributionSchema,
    claimable: z.boolean(),
  })
  .superRefine((answer, ctx) => {
    checkContribution(answer, ctx);
    const { boss, serverTime, contribution, claimable } = answer;
    if (boss.status === 'active' && (serverTime < boss.startsAt || serverTime >= boss.endsAt)) {
      ctx.addIssue({
        code: 'custom',
        path: ['boss', 'status'],
        message: 'A boss is active only during its week.',
      });
    }
    if (boss.status === 'escaped' && serverTime < boss.endsAt) {
      ctx.addIssue({
        code: 'custom',
        path: ['boss', 'status'],
        message: 'A boss escapes only once its week is over.',
      });
    }
    const due =
      boss.status !== 'active' && contribution.damage > 0 && contribution.claimedAt === null;
    if (claimable !== due) {
      ctx.addIssue({
        code: 'custom',
        path: ['claimable'],
        message:
          'Rewards are claimable once the fight is over, by a contributor who has not claimed.',
      });
    }
  });
export type BossResponse = z.infer<typeof BossResponseSchema>;

/** Names the week only: the server knows the damage, the tier and whether the boss fell. */
export const BossClaimRequestSchema = z.strictObject({
  week: WeekKeySchema,
});
export type BossClaimRequest = z.infer<typeof BossClaimRequestSchema>;

/** Idempotent: a repeat returns the same payout without paying it twice. */
export const BossClaimResponseSchema = z.object({
  week: WeekKeySchema,
  claimedAt: EpochMsSchema,
  tier: PositiveAmountSchema.nullable(),
  defeatBonus: z.boolean(),
  granted: z.array(LiveGrantSchema).min(1),
  wallet: WalletSchema,
});
export type BossClaimResponse = z.infer<typeof BossClaimResponseSchema>;

/**
 * What one accepted bank did to the boss, attached by the server to table answers so the hit
 * sparks, the health bar and the defeat celebration play from server truth. Never uploaded.
 * `dealt` is this step's damage, `damage` the player's total this week.
 */
export const BossHitSchema = z
  .object({
    week: WeekKeySchema,
    kind: BossKindSchema,
    dealt: PositiveAmountSchema,
    damage: PositiveAmountSchema,
    health: AmountSchema,
    maxHealth: PositiveAmountSchema,
    defeated: z.boolean(),
  })
  .superRefine((hit, ctx) => {
    const issue = (path: string, message: string) => {
      ctx.addIssue({ code: 'custom', path: [path], message });
    };
    if (hit.dealt > hit.damage) issue('dealt', 'A hit is part of the week total.');
    if (hit.health > hit.maxHealth) issue('health', 'Health cannot exceed the maximum.');
    if (!hit.defeated && hit.damage > hit.maxHealth - hit.health) {
      issue('damage', "One player's damage is part of the health the boss lost.");
    }
    if (hit.defeated !== (hit.health === 0)) {
      issue('defeated', 'The hit that empties the health bar defeats the boss.');
    }
  });
export type BossHit = z.infer<typeof BossHitSchema>;

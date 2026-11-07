import { z } from 'zod';
import {
  CollectibleKindSchema,
  RewardPreviewSchema,
  RewardSchema,
  WalletSchema,
} from '../domain.ts';
import {
  AlbumSetIdSchema,
  CollectibleIdSchema,
  QuestIdSchema,
  QuestTemplateIdSchema,
  SeasonIdSchema,
} from '../ids.ts';
import { AmountSchema, EpochMsSchema, PositiveAmountSchema } from '../primitives.ts';

export const AlbumEntrySchema = z.object({
  id: CollectibleIdSchema,
  kind: CollectibleKindSchema,
  owned: z.boolean(),
  count: AmountSchema,
});
export type AlbumEntry = z.infer<typeof AlbumEntrySchema>;

export const AlbumSetSchema = z.object({
  id: AlbumSetIdSchema,
  entries: z.array(AlbumEntrySchema).min(1),
  completed: z.boolean(),
});
export type AlbumSet = z.infer<typeof AlbumSetSchema>;

export const AlbumResponseSchema = z.object({
  sets: z.array(AlbumSetSchema),
});
export type AlbumResponse = z.infer<typeof AlbumResponseSchema>;

export const QUEST_CADENCES = ['daily', 'weekly'] as const;
export const QuestCadenceSchema = z.enum(QUEST_CADENCES);
export type QuestCadence = z.infer<typeof QuestCadenceSchema>;

export const QuestSchema = z.object({
  id: QuestIdSchema,
  template: QuestTemplateIdSchema,
  cadence: QuestCadenceSchema,
  target: PositiveAmountSchema,
  progress: AmountSchema,
  rewards: z.array(RewardPreviewSchema).min(1),
  claimed: z.boolean(),
  expiresAt: EpochMsSchema,
});
export type Quest = z.infer<typeof QuestSchema>;

export const StreakSchema = z.object({
  days: AmountSchema,
  freezes: AmountSchema,
});
export type Streak = z.infer<typeof StreakSchema>;

export const QuestsResponseSchema = z.object({
  quests: z.array(QuestSchema),
  streak: StreakSchema,
});
export type QuestsResponse = z.infer<typeof QuestsResponseSchema>;

export const QuestClaimRequestSchema = z.strictObject({
  questId: QuestIdSchema,
});
export type QuestClaimRequest = z.infer<typeof QuestClaimRequestSchema>;

export const QuestClaimResponseSchema = z.object({
  quest: QuestSchema,
  rewards: z.array(RewardSchema).min(1),
  wallet: WalletSchema,
});
export type QuestClaimResponse = z.infer<typeof QuestClaimResponseSchema>;

export const SeasonTierSchema = z.object({
  tier: PositiveAmountSchema,
  starsRequired: AmountSchema,
  free: z.array(RewardPreviewSchema),
  premium: z.array(RewardPreviewSchema),
});
export type SeasonTier = z.infer<typeof SeasonTierSchema>;

/** `premiumUnlocked` stays false while `flags.monetization` is off. */
export const SeasonResponseSchema = z.object({
  id: SeasonIdSchema,
  startsAt: EpochMsSchema,
  endsAt: EpochMsSchema,
  stars: AmountSchema,
  tiers: z.array(SeasonTierSchema).min(1),
  claimedFree: z.array(PositiveAmountSchema),
  claimedPremium: z.array(PositiveAmountSchema),
  premiumUnlocked: z.boolean(),
});
export type SeasonResponse = z.infer<typeof SeasonResponseSchema>;

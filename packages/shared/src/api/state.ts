import { z } from 'zod';
import { CharmSlotSchema, OwnedCharmSchema, SafeSchema, WalletSchema } from '../domain.ts';
import { ActiveSeedSchema } from '../fair.ts';
import { FeatureFlagsSchema } from '../flags.ts';
import { PlayerIdSchema, ScratchCardIdSchema, VenueIdSchema } from '../ids.ts';
import {
  AmountSchema,
  DisplayNameSchema,
  DurationMsSchema,
  EpochMsSchema,
  LocaleSchema,
} from '../primitives.ts';
import { UpgradeLevelsSchema } from './progression.ts';
import { TableSnapshotSchema } from './table.ts';

export const PlayerProfileSchema = z.object({
  id: PlayerIdSchema,
  displayName: DisplayNameSchema,
  locale: LocaleSchema,
  createdAt: EpochMsSchema,
});
export type PlayerProfile = z.infer<typeof PlayerProfileSchema>;

export const VenueStateSchema = z.object({
  id: VenueIdSchema,
  unlocked: z.array(VenueIdSchema).min(1),
  upgrades: UpgradeLevelsSchema,
  loadout: z.array(CharmSlotSchema),
  /** Bullion earned since the last ascension; drives the ascension progress figure. */
  // TODO(lead-architect): make required once P-380 and P-385 land
  lifetimeBullion: AmountSchema.optional(),
});
export type VenueState = z.infer<typeof VenueStateSchema>;

export const InventorySchema = z.object({
  charms: z.array(OwnedCharmSchema),
  safes: z.array(SafeSchema),
  scratchCards: z.array(ScratchCardIdSchema),
});
export type Inventory = z.infer<typeof InventorySchema>;

/** Settled by the server on this request; `creditedMs` is `awayMs` clamped to the offline cap. */
export const OfflineSettlementSchema = z.object({
  awayMs: DurationMsSchema,
  creditedMs: DurationMsSchema,
  coins: AmountSchema,
});
export type OfflineSettlement = z.infer<typeof OfflineSettlementSchema>;

export const StateResponseSchema = z.object({
  serverTime: EpochMsSchema,
  player: PlayerProfileSchema,
  wallet: WalletSchema,
  flags: FeatureFlagsSchema,
  venue: VenueStateSchema,
  table: TableSnapshotSchema,
  inventory: InventorySchema,
  offline: OfflineSettlementSchema.nullable(),
  fair: ActiveSeedSchema,
  /** Global Family Office line levels, which survive ascension unlike venue upgrades. */
  // TODO(lead-architect): make required once P-380 and P-385 land
  familyOffice: UpgradeLevelsSchema.optional(),
});
export type StateResponse = z.infer<typeof StateResponseSchema>;

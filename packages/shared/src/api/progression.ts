import { z } from 'zod';
import { CharmSlotSchema, SocketIndexSchema, WalletSchema } from '../domain.ts';
import { CharmIdSchema, UpgradeLineIdSchema, VenueIdSchema } from '../ids.ts';
import { AmountSchema, PositiveAmountSchema } from '../primitives.ts';

export const UpgradeLevelsSchema = z.record(UpgradeLineIdSchema, AmountSchema);
export type UpgradeLevels = z.infer<typeof UpgradeLevelsSchema>;

/**
 * `level` is the level being bought (current + 1). A stale client asking for a level it
 * already owns gets `conflict` instead of paying twice; the server prices it from config.
 */
export const UpgradeBuyRequestSchema = z.strictObject({
  venueId: VenueIdSchema,
  lineId: UpgradeLineIdSchema,
  level: PositiveAmountSchema,
});
export type UpgradeBuyRequest = z.infer<typeof UpgradeBuyRequestSchema>;

export const UpgradeBuyResponseSchema = z.object({
  venueId: VenueIdSchema,
  lineId: UpgradeLineIdSchema,
  level: PositiveAmountSchema,
  wallet: WalletSchema,
});
export type UpgradeBuyResponse = z.infer<typeof UpgradeBuyResponseSchema>;

/** Puts a charm into a socket, or empties the socket with `charmId: null`. */
export const CharmEquipRequestSchema = z.strictObject({
  venueId: VenueIdSchema,
  socket: SocketIndexSchema,
  charmId: CharmIdSchema.nullable(),
});
export type CharmEquipRequest = z.infer<typeof CharmEquipRequestSchema>;

export const CharmEquipResponseSchema = z.object({
  venueId: VenueIdSchema,
  loadout: z.array(CharmSlotSchema),
});
export type CharmEquipResponse = z.infer<typeof CharmEquipResponseSchema>;

export const AscendRequestSchema = z.strictObject({
  venueId: VenueIdSchema,
});
export type AscendRequest = z.infer<typeof AscendRequestSchema>;

export const AscendResponseSchema = z.object({
  venueId: VenueIdSchema,
  goldBarsGranted: AmountSchema,
  unlockedVenueId: VenueIdSchema.nullable(),
  wallet: WalletSchema,
});
export type AscendResponse = z.infer<typeof AscendResponseSchema>;

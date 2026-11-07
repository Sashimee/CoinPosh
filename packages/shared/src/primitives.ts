import { z } from 'zod';

/** A non-negative safe integer quantity of any currency or coin value. */
export const AmountSchema = z.int().nonnegative();
export type Amount = z.infer<typeof AmountSchema>;

export const PositiveAmountSchema = z.int().positive();
export type PositiveAmount = z.infer<typeof PositiveAmountSchema>;

/** A fixed-step (60 Hz) simulation tick on the player's table. */
export const TickSchema = z.int().nonnegative();
export type Tick = z.infer<typeof TickSchema>;

/** Milliseconds since the Unix epoch, always stamped by the server clock. */
export const EpochMsSchema = z.int().nonnegative();
export type EpochMs = z.infer<typeof EpochMsSchema>;

export const DurationMsSchema = z.int().nonnegative();
export type DurationMs = z.infer<typeof DurationMsSchema>;

export const FractionSchema = z.number().min(0).max(1);
export type Fraction = z.infer<typeof FractionSchema>;

export const Sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'Expected a lowercase hex SHA-256 digest (64 characters).');
export type Sha256Hex = z.infer<typeof Sha256HexSchema>;

/** Deterministic sim state hash from `packages/sim`, lowercase hex of 4 to 32 bytes. */
export const SimHashSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{2}){4,32}$/, 'Expected a lowercase hex sim hash of 4 to 32 bytes.');
export type SimHash = z.infer<typeof SimHashSchema>;

export const DisplayNameSchema = z.string().trim().min(1).max(32);
export type DisplayName = z.infer<typeof DisplayNameSchema>;

export const LOCALES = ['en', 'fr', 'de'] as const;
export const LocaleSchema = z.enum(LOCALES);
export type Locale = z.infer<typeof LocaleSchema>;

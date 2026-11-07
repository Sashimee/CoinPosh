import { z } from 'zod';
import { AmountSchema, EpochMsSchema, Sha256HexSchema } from './primitives.ts';

export const ClientSeedSchema = z
  .string()
  .regex(/^[\x21-\x7e]{1,64}$/, 'Expected a client seed of 1 to 64 printable ASCII characters.');
export type ClientSeed = z.infer<typeof ClientSeedSchema>;

export const NonceSchema = AmountSchema;
export type Nonce = z.infer<typeof NonceSchema>;

/** Everything a player needs, once the server seed is revealed, to re-derive one roll. */
export const FairProofSchema = z.object({
  serverSeedHash: Sha256HexSchema,
  clientSeed: ClientSeedSchema,
  nonce: NonceSchema,
});
export type FairProof = z.infer<typeof FairProofSchema>;

export const ActiveSeedSchema = FairProofSchema;
export type ActiveSeed = z.infer<typeof ActiveSeedSchema>;

export const RevealedSeedSchema = z.object({
  serverSeed: Sha256HexSchema,
  serverSeedHash: Sha256HexSchema,
  clientSeed: ClientSeedSchema,
  finalNonce: NonceSchema,
  revealedAt: EpochMsSchema,
});
export type RevealedSeed = z.infer<typeof RevealedSeedSchema>;

/** The HMAC-SHA256 message keyed by the server seed: `roll = HMAC(serverSeed, clientSeed:nonce)`. */
export function fairRollMessage(clientSeed: ClientSeed, nonce: Nonce): string {
  return `${clientSeed}:${nonce}`;
}

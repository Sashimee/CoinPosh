import { z } from 'zod';
import { AmountSchema, EpochMsSchema, Sha256HexSchema, type Sha256Hex } from './primitives.ts';

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

const utf8 = new TextEncoder();

function toHex(bytes: ArrayBuffer): Sha256Hex {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The commitment shown before any roll: SHA-256 of the server seed's UTF-8 hex text
 * (not of the bytes it encodes), matching `apps/server` and `sha256sum` on the text.
 */
export async function commitmentOf(serverSeed: string): Promise<Sha256Hex> {
  return toHex(await crypto.subtle.digest('SHA-256', utf8.encode(serverSeed)));
}

/**
 * `HMAC_SHA256(serverSeed, clientSeed:nonce)` as lowercase hex, keyed by the server seed's
 * UTF-8 hex text so any off-the-shelf HMAC tool reproduces it. Web Crypto only, so the
 * same code runs in the browser and in the Worker.
 */
export async function fairDigest(
  serverSeed: string,
  clientSeed: ClientSeed,
  nonce: Nonce,
): Promise<Sha256Hex> {
  const key = await crypto.subtle.importKey(
    'raw',
    utf8.encode(serverSeed),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(
    await crypto.subtle.sign('HMAC', key, utf8.encode(fairRollMessage(clientSeed, nonce))),
  );
}

import {
  fairRollMessage,
  type ClientSeed,
  type FairProof,
  type Nonce,
  type RevealedSeed,
  type Sha256Hex,
} from '@coinposh/shared';
import { sha256Hex, utf8Bytes } from './encoding.ts';

/** `HMAC_SHA256(serverSeed, clientSeed:nonce)`, keyed by the seed's hex text as the shared spec verifies it. */
export async function fairDigest(
  serverSeed: Sha256Hex,
  clientSeed: ClientSeed,
  nonce: Nonce,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    utf8Bytes(serverSeed),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(
    await crypto.subtle.sign('HMAC', key, utf8Bytes(fairRollMessage(clientSeed, nonce))),
  );
}

/**
 * Checks, on the player's device, that a roll's proof belongs to a seed the server has since
 * revealed: the seed hashes to the commitment shown before the roll, the client seed matches,
 * and the nonce was spent before the reveal. It does not re-derive the roll's outcome, so it
 * cannot show that the rarity and rewards displayed were the ones that digest produced.
 */
export async function verifyFairProofMembership(
  revealed: RevealedSeed,
  proof: FairProof,
): Promise<boolean> {
  return (
    (await sha256Hex(revealed.serverSeed)) === revealed.serverSeedHash &&
    proof.serverSeedHash === revealed.serverSeedHash &&
    proof.clientSeed === revealed.clientSeed &&
    proof.nonce < revealed.finalNonce
  );
}

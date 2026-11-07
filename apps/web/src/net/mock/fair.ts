import { createRng, type Rng } from '@coinposh/economy';
import type { ClientSeed, FairProof, RevealedSeed, Sha256Hex } from '@coinposh/shared';
import { randomBase62, sha256Hex, toHex } from '../encoding.ts';
import { fairDigest } from '../fair.ts';

export interface FairSeedState {
  serverSeed: Sha256Hex;
  serverSeedHash: Sha256Hex;
  clientSeed: ClientSeed;
  nonce: number;
}

export async function newSeed(clientSeed: ClientSeed = randomBase62(16)): Promise<FairSeedState> {
  const serverSeed = toHex(crypto.getRandomValues(new Uint8Array(32)));
  return { serverSeed, serverSeedHash: await sha256Hex(serverSeed), clientSeed, nonce: 0 };
}

/** The first 32 bits of the digest seed the economy RNG that turns one roll into rarities and picks. */
export function rngFromDigest(digest: Uint8Array): Rng {
  const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
  return createRng(view.getUint32(0));
}

/** Spends the next nonce: one provably fair roll and the proof a player can check later. */
export async function nextRoll(seed: FairSeedState): Promise<{ rng: Rng; proof: FairProof }> {
  const nonce = seed.nonce;
  seed.nonce += 1;
  const digest = await fairDigest(seed.serverSeed, seed.clientSeed, nonce);
  return {
    rng: rngFromDigest(digest),
    proof: { serverSeedHash: seed.serverSeedHash, clientSeed: seed.clientSeed, nonce },
  };
}

export function reveal(seed: FairSeedState, revealedAt: number): RevealedSeed {
  return {
    serverSeed: seed.serverSeed,
    serverSeedHash: seed.serverSeedHash,
    clientSeed: seed.clientSeed,
    finalNonce: seed.nonce,
    revealedAt,
  };
}

import { createRng, type Rng } from '@coinposh/economy';
import type { ClientSeed, FairProof, RevealedSeed, Sha256Hex } from '@coinposh/shared';
import { randomBase62, sha256Hex, toHex } from '../encoding.ts';
import { currentNetMode, type NetMode } from '../env.ts';
import { fairDigest } from '../fair.ts';

export interface FairSeedState {
  serverSeed: Sha256Hex;
  serverSeedHash: Sha256Hex;
  clientSeed: ClientSeed;
  nonce: number;
}

/** Where a fresh seed pair comes from: the platform CSPRNG, or a seeded Demo fixture. */
export type SeedSource = () => Promise<{ serverSeed: Sha256Hex; clientSeed: ClientSeed }>;

export const DEMO_SEED_GLOBAL = '__coinposhDemoSeed';
const DEMO_SEED = /^[A-Za-z0-9_-]{1,64}$/;

export const cryptoSeedSource: SeedSource = () =>
  Promise.resolve({
    serverSeed: toHex(crypto.getRandomValues(new Uint8Array(32))),
    clientSeed: randomBase62(16),
  });

/** Each rotation hashes the fixture with its generation, so a rotated seed differs yet replays identically. */
export function seededSeedSource(seed: string): SeedSource {
  let generation = 0;
  return async () => {
    const k = generation++;
    const serverSeed = await sha256Hex(`coinposh-demo-server:${seed}:${k}`);
    const clientSeed = (await sha256Hex(`coinposh-demo-client:${seed}:${k}`)).slice(0, 16);
    return { serverSeed, clientSeed };
  };
}

/**
 * Seeded e2e sets `window.__coinposhDemoSeed` from an init script to pin crate rolls. The value is
 * page-controlled, so it is honoured only in Demo Mode and anything but a short token is refused.
 */
export function resolveSeedSource(scope: object, mode: NetMode): SeedSource {
  if (mode.kind !== 'demo') return cryptoSeedSource;
  const raw: unknown = (scope as Record<string, unknown>)[DEMO_SEED_GLOBAL];
  if (raw === undefined) return cryptoSeedSource;
  if (typeof raw !== 'string' || !DEMO_SEED.test(raw)) {
    const shown = typeof raw === 'string' ? JSON.stringify(raw.slice(0, 80)) : typeof raw;
    throw new Error(
      `CoinPosh demo: ${DEMO_SEED_GLOBAL} must be 1 to 64 characters of A-Z, a-z, 0-9, "_" or "-" (got ${shown}). Fix the Playwright init script, or remove it for random seeds.`,
    );
  }
  return seededSeedSource(raw);
}

let pageSource: SeedSource | undefined;

function pageSeedSource(): SeedSource {
  pageSource ??= resolveSeedSource(globalThis, currentNetMode());
  return pageSource;
}

export async function newSeed(
  clientSeed?: ClientSeed,
  source: SeedSource = pageSeedSource(),
): Promise<FairSeedState> {
  const fresh = await source();
  return {
    serverSeed: fresh.serverSeed,
    serverSeedHash: await sha256Hex(fresh.serverSeed),
    clientSeed: clientSeed ?? fresh.clientSeed,
    nonce: 0,
  };
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

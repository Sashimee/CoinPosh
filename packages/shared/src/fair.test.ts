import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ClientSeedSchema,
  RevealedSeedSchema,
  commitmentOf,
  fairDigest,
  fairRollMessage,
} from './fair.ts';
import { Sha256HexSchema } from './primitives.ts';
import { roundTrip } from './test/roundTrip.ts';

const SERVER_SEED = 'ab'.repeat(32);
const seed = (text: string) => ClientSeedSchema.parse(text);

describe('fairDigest', () => {
  it('matches a known HMAC-SHA256 vector keyed by the hex text of the server seed', async () => {
    // printf 'client:4' | openssl dgst -sha256 -hmac "$(printf 'ab%.0s' {1..32})"
    expect(await fairDigest(SERVER_SEED, seed('client'), 4)).toBe(
      'd032314b6a35c7a5d65ec727e670cd12058e02812245dc8cd533cd0a082a5d03',
    );
  });

  it('agrees with node:crypto across seeds and nonces', async () => {
    const serverSeed = createHash('sha256').update('house-secret').digest('hex');
    for (const clientSeed of ['velvet-rope-42', '~', 'x'.repeat(64)]) {
      for (const nonce of [0, 1, 999, Number.MAX_SAFE_INTEGER]) {
        const expected = createHmac('sha256', serverSeed)
          .update(`${clientSeed}:${nonce}`)
          .digest('hex');
        expect(await fairDigest(serverSeed, seed(clientSeed), nonce)).toBe(expected);
      }
    }
  });

  it('is a lowercase SHA-256 hex digest that changes with every input', async () => {
    const base = await fairDigest(SERVER_SEED, seed('client'), 4);
    expect(Sha256HexSchema.safeParse(base).success).toBe(true);
    const variants = await Promise.all([
      fairDigest(SERVER_SEED, seed('client'), 5),
      fairDigest(SERVER_SEED, seed('Client'), 4),
      fairDigest('cd'.repeat(32), seed('client'), 4),
      fairDigest(SERVER_SEED.toUpperCase(), seed('client'), 4),
    ]);
    expect(new Set([base, ...variants]).size).toBe(5);
  });
});

describe('commitmentOf', () => {
  it('hashes the UTF-8 hex text of the server seed, not the bytes it encodes', async () => {
    // printf 'ab%.0s' {1..32} | sha256sum
    expect(await commitmentOf(SERVER_SEED)).toBe(
      '271a413bd339c5709fdceaec41f14f11e9fbfb5042d72d331c65f32b284cd09a',
    );
    expect(await commitmentOf(SERVER_SEED)).not.toBe(
      createHash('sha256').update(Buffer.from(SERVER_SEED, 'hex')).digest('hex'),
    );
  });

  it('verifies a revealed seed against its commitment', async () => {
    const revealed = RevealedSeedSchema.parse({
      serverSeed: SERVER_SEED,
      serverSeedHash: await commitmentOf(SERVER_SEED),
      clientSeed: 'client',
      finalNonce: 5,
      revealedAt: 1_762_473_600_000,
    });
    expect(await commitmentOf(revealed.serverSeed)).toBe(revealed.serverSeedHash);
    expect(await commitmentOf('cd'.repeat(32))).not.toBe(revealed.serverSeedHash);
  });
});

describe('fairRollMessage', () => {
  it('joins client seed and nonce as clientSeed:nonce', () => {
    expect(fairRollMessage(ClientSeedSchema.parse('velvet-rope-42'), 17)).toBe('velvet-rope-42:17');
  });

  it('lets a player verify a roll once the server seed is revealed', () => {
    const serverSeed = createHash('sha256').update('house-secret').digest('hex');
    const revealed = RevealedSeedSchema.parse({
      serverSeed,
      serverSeedHash: createHash('sha256').update(serverSeed).digest('hex'),
      clientSeed: 'velvet-rope-42',
      finalNonce: 3,
      revealedAt: 1_762_473_600_000,
    });
    expect(createHash('sha256').update(revealed.serverSeed).digest('hex')).toBe(
      revealed.serverSeedHash,
    );

    const roll = (nonce: number) =>
      createHmac('sha256', revealed.serverSeed)
        .update(fairRollMessage(revealed.clientSeed, nonce))
        .digest('hex');
    expect(roll(1)).toBe(roll(1));
    expect(roll(1)).not.toBe(roll(2));
  });
});

describe('ClientSeedSchema', () => {
  it('round-trips a printable seed up to 64 characters', () => {
    const seed = `~${'x'.repeat(62)}!`;
    const { parsed, reparsed } = roundTrip(ClientSeedSchema, seed);
    expect(parsed).toBe(seed);
    expect(reparsed).toBe(seed);
  });

  it.each(['', 'has space', 'tab\there', 'é-accent', 'x'.repeat(65)])('rejects %j', (seed) => {
    expect(ClientSeedSchema.safeParse(seed).success).toBe(false);
  });
});

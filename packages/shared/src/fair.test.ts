import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ClientSeedSchema, RevealedSeedSchema, fairRollMessage } from './fair.ts';
import { roundTrip } from './test/roundTrip.ts';

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

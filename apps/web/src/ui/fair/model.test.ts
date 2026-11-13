import { createHmac } from 'node:crypto';
import { dropTables, ODDS_SCALE, pity } from '@coinposh/economy';
import { commitmentOf, fairDigest, type RevealedSeed } from '@coinposh/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  digestWords,
  FAIR_SOURCES,
  inputFromProof,
  inputFromSeed,
  lastNonce,
  newestFirst,
  nextClientSeed,
  oddsFor,
  oneIn,
  pityProgress,
  pityRows,
  shortHex,
  stepNonce,
  verifyRoll,
  type VerifyInput,
} from './model.ts';

/** sha256("coinposh-known-vector"), its own SHA-256, and HMAC(seed, "lucky-7:42"), from openssl. */
const SEED = 'fdf3f0d4efb007a90f9a8db02d886bb12fe8d203edeb588b0be088a451c08e71';
const COMMITMENT = '8579c384090b3ad1fc13bc963c9dccdbff21aa16c8b32fba5e72441706b8f6fc';
const DIGEST = '12e657e730364728ed4fe08a314968969254609a6a54c167746b4ea753d91cf3';

const REVEALED: RevealedSeed = {
  serverSeed: SEED,
  serverSeedHash: COMMITMENT,
  clientSeed: 'lucky-7',
  finalNonce: 50,
  revealedAt: 1_780_000_000_000,
};

const KNOWN: VerifyInput = {
  serverSeed: SEED,
  commitment: COMMITMENT,
  clientSeed: 'lucky-7',
  nonce: '42',
};

function flipHex(hex: string, at: number): string {
  const swapped = hex[at] === '0' ? '1' : '0';
  return `${hex.slice(0, at)}${swapped}${hex.slice(at + 1)}`;
}

describe('verifyRoll', () => {
  it('reproduces the known HMAC-SHA256 vector', async () => {
    const result = await verifyRoll(KNOWN, REVEALED);
    expect(result).toEqual({ status: 'match', computed: COMMITMENT, digest: DIGEST });
  });

  it('agrees with the RFC-style HMAC test vector through the shared digest', async () => {
    const reference = createHmac('sha256', 'key')
      .update('The quick brown fox jumps over the lazy dog')
      .digest('hex');
    expect(reference).toBe('f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
    expect(await fairDigest(SEED, 'lucky-7', 42)).toBe(
      createHmac('sha256', SEED).update('lucky-7:42').digest('hex'),
    );
  });

  it('accepts pasted values with stray whitespace and upper-case hex', async () => {
    const result = await verifyRoll(
      {
        ...KNOWN,
        serverSeed: ` ${SEED.toUpperCase()}\n`,
        commitment: `${COMMITMENT} `,
        nonce: ' 42',
      },
      REVEALED,
    );
    expect(result.status).toBe('match');
  });

  it('never certifies a self-consistent seed that is not in the revealed ledger', async () => {
    const madeUp = await commitmentOf(SEED.replace(/^f/, 'e'));
    const forged: VerifyInput = {
      serverSeed: SEED.replace(/^f/, 'e'),
      commitment: madeUp,
      clientSeed: 'lucky-7',
      nonce: '42',
    };
    const result = await verifyRoll(forged, null);
    expect(result.status).not.toBe('match');
    expect(result).toEqual({
      status: 'consistent',
      computed: madeUp,
      digest: await fairDigest(forged.serverSeed, 'lucky-7', 42),
    });
  });

  it('calls the known vector consistent, not certified, when no published seed backs it', async () => {
    expect(await verifyRoll(KNOWN, null)).toEqual({
      status: 'consistent',
      computed: COMMITMENT,
      digest: DIGEST,
    });
  });

  it('flags a tampered commitment and shows what the seed really hashes to', async () => {
    const result = await verifyRoll({ ...KNOWN, commitment: flipHex(COMMITMENT, 10) }, null);
    expect(result).toMatchObject({
      status: 'mismatch',
      reason: 'commitment',
      computed: COMMITMENT,
    });
  });

  it('flags a server seed changed by one character', async () => {
    const result = await verifyRoll({ ...KNOWN, serverSeed: flipHex(SEED, 63) }, REVEALED);
    expect(result.status).toBe('mismatch');
    if (result.status !== 'mismatch') return;
    expect(result.reason).toBe('commitment');
    expect(result.computed).not.toBe(COMMITMENT);
    expect(result.digest).not.toBe(DIGEST);
  });

  it('flags a proof whose client seed was edited after the reveal', async () => {
    const result = await verifyRoll({ ...KNOWN, clientSeed: 'lucky-8' }, REVEALED);
    expect(result).toMatchObject({ status: 'mismatch', reason: 'clientSeed' });
  });

  it('flags a nonce the seed never rolled', async () => {
    expect(await verifyRoll({ ...KNOWN, nonce: '50' }, REVEALED)).toMatchObject({
      status: 'mismatch',
      reason: 'unspent',
    });
    expect((await verifyRoll({ ...KNOWN, nonce: '49' }, REVEALED)).status).toBe('match');
  });

  it('flags a published seed that differs from the commitment typed in', async () => {
    const other: RevealedSeed = { ...REVEALED, serverSeedHash: flipHex(COMMITMENT, 0) };
    expect(await verifyRoll(KNOWN, other)).toMatchObject({
      status: 'mismatch',
      reason: 'commitment',
    });
  });

  it.each([
    ['serverSeed', { serverSeed: 'not-hex' }],
    ['serverSeed', { serverSeed: SEED.slice(1) }],
    ['commitment', { commitment: '' }],
    ['clientSeed', { clientSeed: '' }],
    ['clientSeed', { clientSeed: 'has space' }],
    ['clientSeed', { clientSeed: 'x'.repeat(65) }],
    ['nonce', { nonce: '-1' }],
    ['nonce', { nonce: '1.5' }],
    ['nonce', { nonce: '1e3' }],
    ['nonce', { nonce: '' }],
  ] as const)('refuses an invalid %s', async (field, edit) => {
    expect(await verifyRoll({ ...KNOWN, ...edit }, null)).toEqual({ status: 'invalid', field });
  });
});

describe('verifyRoll without Web Crypto', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reports unavailable, not an invalid seed, when SHA-256 throws', async () => {
    const failure = new DOMException('The operation is insecure.', 'SecurityError');
    vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(failure);
    expect(await verifyRoll(KNOWN, REVEALED)).toEqual({ status: 'unavailable', cause: failure });
  });

  it('reports unavailable when the HMAC key cannot be imported', async () => {
    const failure = new Error('importKey unsupported');
    vi.spyOn(crypto.subtle, 'importKey').mockImplementation(() => {
      throw failure;
    });
    expect(await verifyRoll(KNOWN, null)).toEqual({ status: 'unavailable', cause: failure });
  });

  it('reports unavailable in an insecure context with no crypto.subtle', async () => {
    vi.stubGlobal('crypto', {});
    const result = await verifyRoll(KNOWN, REVEALED);
    expect(result.status).toBe('unavailable');
    expect(result).toHaveProperty('cause', expect.any(TypeError));
  });

  it('still points at the bad field before touching Web Crypto', async () => {
    const digest = vi.spyOn(crypto.subtle, 'digest');
    expect(await verifyRoll({ ...KNOWN, nonce: 'x' }, REVEALED)).toEqual({
      status: 'invalid',
      field: 'nonce',
    });
    expect(digest).not.toHaveBeenCalled();
  });
});

describe('odds tables', () => {
  it.each(FAIR_SOURCES)('%s shows exactly the economy weights and totals 100 %%', (source) => {
    const rows = oddsFor(source);
    expect(rows.ok).toBe(true);
    if (!rows.ok) return;
    const table = dropTables.find((candidate) => candidate.source === source);
    expect(table).toBeDefined();
    const total = rows.value.reduce((sum, row) => sum + row.weight, 0);
    expect(total).toBe(ODDS_SCALE);
    for (const row of rows.value) {
      expect(row.weight).toBe(table?.odds[row.rarity]);
      expect(row.percent).toBeCloseTo((row.weight / ODDS_SCALE) * 100, 10);
    }
  });

  it('says "1 in N" only for a share that can land', () => {
    expect(oneIn({ percent: 0 })).toBeNull();
    expect(oneIn({ percent: 50 })).toBe(2);
    expect(oneIn({ percent: 0.3 })).toBe(333);
    expect(oneIn({ percent: 100 })).toBe(1);
  });
});

describe('pity rows', () => {
  it('lists every rule with no count before a roll reports one', () => {
    const rows = pityRows('vaultCrate', null);
    expect(rows.map((row) => [row.rarity, row.within])).toEqual(
      pity.rules.map((rule) => [rule.rarity, rule.within]),
    );
    expect(rows.every((row) => row.misses === null && row.left === null)).toBe(true);
    expect(rows.map(pityProgress)).toEqual(rows.map(() => 0));
  });

  it('fills in the server counters and counts down to the forced open', () => {
    const rows = pityRows('vaultCrate', { rare: 9, exquisite: 0, legendary: 60 });
    const rare = rows.find((row) => row.rarity === 'rare');
    expect(rare).toMatchObject({ misses: 9, left: 1 });
    expect(rare && pityProgress(rare)).toBeCloseTo(0.9);
    expect(rows.find((row) => row.rarity === 'legendary')).toMatchObject({ misses: 60, left: 60 });
  });

  it('throws on a counter past its rule instead of drawing a meter that lies', () => {
    expect(() => pityRows('vaultCrate', { rare: 10, exquisite: 0, legendary: 0 })).toThrow();
    expect(() => pityRows('vaultCrate', { rare: -1, exquisite: 0, legendary: 0 })).toThrow();
  });

  it('every source keeps its own guarantees, as the economy promises', () => {
    for (const source of FAIR_SOURCES) {
      const table = dropTables.find((candidate) => candidate.source === source);
      expect(pityRows(source, null).length > 0).toBe(table?.pity);
    }
  });
});

describe('seed helpers', () => {
  it('fills the form from a revealed seed or a proof', () => {
    expect(inputFromSeed(REVEALED, 42)).toEqual(KNOWN);
    const proof = { serverSeedHash: COMMITMENT, clientSeed: 'lucky-7', nonce: 42 };
    expect(inputFromProof(proof, REVEALED)).toEqual(KNOWN);
    expect(inputFromProof(proof, null)).toEqual({ ...KNOWN, serverSeed: '' });
  });

  it('steps the nonce only through the rolls the seed made', () => {
    expect(lastNonce(REVEALED)).toBe(49);
    expect(lastNonce({ finalNonce: 0 })).toBeNull();
    expect(stepNonce(REVEALED, 0, -1)).toBe(0);
    expect(stepNonce(REVEALED, 48, 1)).toBe(49);
    expect(stepNonce(REVEALED, 49, 1)).toBe(49);
    expect(stepNonce(REVEALED, 80, -1)).toBe(49);
    expect(stepNonce({ finalNonce: 0 }, 3, 1)).toBe(0);
  });

  it('orders revealed seeds newest first without mutating the ledger', () => {
    const older = { ...REVEALED, revealedAt: 1 };
    const ledger = [older, REVEALED];
    expect(newestFirst(ledger)).toEqual([REVEALED, older]);
    expect(ledger[0]).toBe(older);
  });

  it('sets the digest in eight words and elides long hex', () => {
    expect(digestWords(DIGEST)).toHaveLength(8);
    expect(digestWords(DIGEST).join('')).toBe(DIGEST);
    expect(shortHex(COMMITMENT)).toBe('8579c384…06b8f6fc');
    expect(shortHex('abc')).toBe('abc');
  });

  it('keeps the player seed on an empty rotate and refuses a bad one', () => {
    expect(nextClientSeed('  ')).toEqual({ ok: true, value: undefined });
    expect(nextClientSeed(' lucky-9 ')).toEqual({ ok: true, value: 'lucky-9' });
    expect(nextClientSeed('two words')).toEqual({ ok: false });
  });
});

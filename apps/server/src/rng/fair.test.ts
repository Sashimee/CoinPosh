import { createRng } from '@coinposh/economy';
import {
  ActiveSeedSchema,
  commitmentOf as sharedCommitmentOf,
  fairDigest as sharedFairDigest,
  FairRotateResponseSchema,
  FairSeedsResponseSchema,
  IdempotencyKeySchema,
  type IdempotencyKey,
} from '@coinposh/shared';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { utf8 } from '../crypto.ts';
import type { PlayerDO } from '../do/PlayerDO.ts';
import { ApiFailure } from '../http/errors.ts';
import {
  commitmentOf,
  fairDigest,
  fairRngFromDigest,
  FairSeeds,
  MIN_ROTATION_INTERVAL_MS,
  REVEALED_SEED_HISTORY,
  verifyRevealedSeed,
} from './fair.ts';
import { toHex } from './hmac.ts';

const T0 = 1_800_000_000_000;
const T1 = T0 + MIN_ROTATION_INTERVAL_MS;

function inFreshDo<T>(run: (sql: SqlStorage, ctx: DurableObjectState) => T): Promise<T> {
  const stub = env.PLAYER.get(env.PLAYER.idFromName(`fair-${crypto.randomUUID()}`));
  return runInDurableObject(stub, (_instance: PlayerDO, ctx) => run(ctx.storage.sql, ctx));
}

function key(): IdempotencyKey {
  return IdempotencyKeySchema.parse(crypto.randomUUID());
}

async function webCryptoRoll(serverSeed: string, clientSeed: string, nonce: number) {
  const imported = await crypto.subtle.importKey(
    'raw',
    utf8(serverSeed),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(
    new Uint8Array(await crypto.subtle.sign('HMAC', imported, utf8(`${clientSeed}:${nonce}`))),
  );
}

function expectAbort(run: () => unknown, message: RegExp): void {
  expect(run).toThrow(message);
}

describe('FairSeeds commitment', () => {
  it('commits a sha256 of the secret seed and never exposes the active secret', async () => {
    const view = await inFreshDo((sql) => {
      const fair = new FairSeeds(sql);
      fair.open(T0);
      const secret = sql
        .exec<{ server_seed: string }>('SELECT server_seed FROM fair_seeds')
        .one().server_seed;
      return { secret, seeds: fair.seeds() };
    });
    expect(FairSeedsResponseSchema.parse(view.seeds)).toEqual(view.seeds);
    expect(view.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(view.seeds.active.serverSeedHash).toBe(commitmentOf(view.secret));
    expect(view.seeds.active.nonce).toBe(0);
    expect(view.seeds.revealed).toEqual([]);
    expect(JSON.stringify(view.seeds)).not.toContain(view.secret);
  });

  it('opens a chain once: a second open keeps the first commitment', async () => {
    const [first, second] = await inFreshDo((sql) => {
      const fair = new FairSeeds(sql);
      fair.open(T0);
      const before = fair.active();
      new FairSeeds(sql).open(T0 + 1);
      return [before, new FairSeeds(sql).active()];
    });
    expect(second).toEqual(first);
  });

  it('adopts a commitment the player was already shown, and refuses a mismatched one', async () => {
    const serverSeed = 'ab'.repeat(32);
    const legacy = {
      serverSeed,
      serverSeedHash: commitmentOf(serverSeed),
      clientSeed: 'legacyClient1234',
      nonce: 7,
    };
    const adopted = await inFreshDo((sql) => {
      const fair = new FairSeeds(sql);
      fair.adopt(legacy, T0);
      fair.adopt({ ...legacy, nonce: 0 }, T0);
      return fair.active();
    });
    expect(adopted).toEqual({
      serverSeedHash: legacy.serverSeedHash,
      clientSeed: legacy.clientSeed,
      nonce: 7,
    });

    await inFreshDo((sql) => {
      const mismatched = { ...legacy, serverSeedHash: commitmentOf('cd'.repeat(32)) };
      expect(() => {
        new FairSeeds(sql).adopt(mismatched, T0);
      }).toThrow(/does not match its commitment/);
    });
  });

  it('fails loudly when rolling before any seed was committed', async () => {
    await inFreshDo((sql) => {
      expect(() => new FairSeeds(sql).roll('crate.vault', null, T0)).toThrow(/no active seed/);
    });
  });
});

describe('FairSeeds rolls', () => {
  it('rolls HMAC_SHA256(serverSeed, clientSeed:nonce) and consumes one nonce per roll', async () => {
    const result = await inFreshDo((sql) => {
      const fair = new FairSeeds(sql);
      fair.open(T0);
      const rolls = [0, 1, 2].map((i) => {
        const roll = fair.roll('crate.vault', `crate_${i}`, T0 + i);
        return { nonce: roll.nonce, digest: roll.digest, first: roll.rng.nextUint32() };
      });
      const secret = sql
        .exec<{ server_seed: string }>('SELECT server_seed FROM fair_seeds')
        .one().server_seed;
      const logged = sql
        .exec<{ nonce: number; purpose: string; ref: string; digest: string }>(
          'SELECT nonce, purpose, ref, digest FROM fair_rolls ORDER BY nonce',
        )
        .toArray();
      return { rolls, secret, logged, active: fair.active() };
    });

    expect(result.rolls.map((roll) => roll.nonce)).toEqual([0, 1, 2]);
    expect(new Set(result.rolls.map((roll) => roll.digest)).size).toBe(3);
    for (const roll of result.rolls) {
      expect(roll.digest).toBe(
        await webCryptoRoll(result.secret, result.active.clientSeed, roll.nonce),
      );
      expect(roll.first).toBe(createRng(Number.parseInt(roll.digest.slice(0, 8), 16)).nextUint32());
    }
    expect(result.active.nonce).toBe(3);
    expect(result.logged).toEqual(
      result.rolls.map((roll, i) => ({
        nonce: roll.nonce,
        purpose: 'crate.vault',
        ref: `crate_${i}`,
        digest: roll.digest,
      })),
    );
  });

  it('gives the economy a reproducible stream from the digest alone', () => {
    const digest = fairDigest('ab'.repeat(32), 'client', 4);
    const a = fairRngFromDigest(digest);
    const b = fairRngFromDigest(digest);
    const draws = Array.from({ length: 8 }, () => a.nextInt(1_000));
    expect(Array.from({ length: 8 }, () => b.nextInt(1_000))).toEqual(draws);
    expect(fairRngFromDigest(fairDigest('ab'.repeat(32), 'client', 5)).nextUint32()).not.toBe(
      fairRngFromDigest(digest).nextUint32(),
    );
  });

  it('keeps a roll and its nonce together: a failed transaction burns neither', async () => {
    const after = await inFreshDo((sql, ctx) => {
      const fair = new FairSeeds(sql);
      fair.open(T0);
      expect(() =>
        ctx.storage.transactionSync(() => {
          fair.roll('crate.vault', null, T0);
          throw new Error('claim aborted');
        }),
      ).toThrow('claim aborted');
      return {
        active: fair.active(),
        rolls: sql.exec('SELECT * FROM fair_rolls').toArray().length,
      };
    });
    expect(after.active.nonce).toBe(0);
    expect(after.rolls).toBe(0);
  });
});

describe('FairSeeds agrees with the shared client verifier', () => {
  const PRINTABLE = Array.from({ length: 0x7e - 0x21 + 1 }, (_, i) =>
    String.fromCharCode(0x21 + i),
  ).join('');

  function randomHexSeed(): string {
    return toHex(crypto.getRandomValues(new Uint8Array(32)));
  }

  function randomClientSeed(): string {
    const length = 1 + ((crypto.getRandomValues(new Uint8Array(1))[0] ?? 0) % 64);
    return Array.from(
      crypto.getRandomValues(new Uint8Array(length)),
      (byte) => PRINTABLE[byte % PRINTABLE.length],
    ).join('');
  }

  it('matches shared fairDigest and commitmentOf on fixed edge cases', async () => {
    const cases: [string, string, number][] = [
      ['00'.repeat(32), '!', 0],
      ['ff'.repeat(32), '~'.repeat(64), Number.MAX_SAFE_INTEGER],
      ['ab'.repeat(32), 'client:seed:with:colons', 4],
      ['0123456789abcdef'.repeat(4), PRINTABLE.slice(0, 64), 1_000_000],
    ];
    for (const [serverSeed, clientSeed, nonce] of cases) {
      expect(fairDigest(serverSeed, clientSeed, nonce)).toBe(
        await sharedFairDigest(serverSeed, clientSeed, nonce),
      );
      expect(commitmentOf(serverSeed)).toBe(await sharedCommitmentOf(serverSeed));
    }
  });

  it('matches shared fairDigest and commitmentOf on 500 random seeds', async () => {
    for (let i = 0; i < 500; i++) {
      const serverSeed = randomHexSeed();
      const clientSeed = randomClientSeed();
      const nonce = (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) % 100_000;
      expect(fairDigest(serverSeed, clientSeed, nonce)).toBe(
        await sharedFairDigest(serverSeed, clientSeed, nonce),
      );
      expect(commitmentOf(serverSeed)).toBe(await sharedCommitmentOf(serverSeed));
    }
  });

  it('lets a player re-derive every logged roll from the reveal with shared code only', async () => {
    const result = await inFreshDo((sql) => {
      const fair = new FairSeeds(sql);
      fair.open(T0);
      const committed = fair.active();
      const digests = Array.from(
        { length: 6 },
        (_, i) => fair.roll('crate.vault', `crate_${i}`, T0 + i).digest,
      );
      const rotation = fair.rotate({}, { at: T1, idempotencyKey: key() });
      return { committed, digests, revealed: rotation.revealed };
    });
    expect(await sharedCommitmentOf(result.revealed.serverSeed)).toBe(
      result.committed.serverSeedHash,
    );
    const rederived = await Promise.all(
      result.digests.map((_, nonce) =>
        sharedFairDigest(result.revealed.serverSeed, result.revealed.clientSeed, nonce),
      ),
    );
    expect(rederived).toEqual(result.digests);
  });
});

describe('FairSeeds rotation', () => {
  it('reveals the old seed, lets the player verify every roll, and commits a fresh one', async () => {
    const result = await inFreshDo((sql) => {
      const fair = new FairSeeds(sql);
      fair.open(T0);
      const before = fair.active();
      const digests = [0, 1, 2, 3].map((i) => fair.roll('safe.gold', null, T0 + i).digest);
      const rotation = fair.rotate({}, { at: T1 + 10, idempotencyKey: key() });
      return { before, digests, rotation, seeds: fair.seeds() };
    });
    const { before, digests, rotation, seeds } = result;
    expect(FairRotateResponseSchema.parse(rotation)).toEqual(rotation);

    expect(rotation.revealed).toMatchObject({
      serverSeedHash: before.serverSeedHash,
      clientSeed: before.clientSeed,
      finalNonce: 4,
      revealedAt: T1 + 10,
    });
    expect(verifyRevealedSeed(rotation.revealed)).toBe(true);
    for (const [nonce, digest] of digests.entries()) {
      expect(
        await webCryptoRoll(rotation.revealed.serverSeed, rotation.revealed.clientSeed, nonce),
      ).toBe(digest);
    }

    expect(rotation.active.serverSeedHash).not.toBe(before.serverSeedHash);
    expect(rotation.active).toEqual({
      serverSeedHash: rotation.active.serverSeedHash,
      clientSeed: before.clientSeed,
      nonce: 0,
    });
    expect(seeds).toEqual({ active: rotation.active, revealed: [rotation.revealed] });
  });

  it('switches to the player-chosen client seed for the next commitment only', async () => {
    const rotation = await inFreshDo((sql) => {
      const fair = new FairSeeds(sql);
      fair.open(T0);
      return fair.rotate({ clientSeed: 'my-lucky-seed!' }, { at: T1, idempotencyKey: key() });
    });
    expect(rotation.active.clientSeed).toBe('my-lucky-seed!');
    expect(rotation.revealed.clientSeed).not.toBe('my-lucky-seed!');
  });

  it('answers a replayed rotation with the original result instead of revealing again', async () => {
    const result = await inFreshDo((sql) => {
      const fair = new FairSeeds(sql);
      fair.open(T0);
      const idempotencyKey = key();
      const first = fair.rotate({ clientSeed: 'replayed' }, { at: T1, idempotencyKey });
      fair.roll('crate.vault', null, T1 + 1);
      const replay = fair.rotate({ clientSeed: 'replayed' }, { at: T1 + 5, idempotencyKey });
      const bare = fair.rotate({}, { at: T1 + 6, idempotencyKey });
      let reused: unknown = null;
      try {
        fair.rotate({ clientSeed: 'something-else' }, { at: T1 + 7, idempotencyKey });
      } catch (error) {
        reused = error;
      }
      return { first, replay, bare, reused, seeds: fair.seeds() };
    });
    expect(result.replay).toEqual(result.first);
    expect(result.bare).toEqual(result.first);
    expect(result.reused).toBeInstanceOf(ApiFailure);
    expect((result.reused as ApiFailure).code).toBe('idempotency_key_reused');
    expect(result.seeds.revealed).toHaveLength(1);
    expect(result.seeds.active).toEqual({ ...result.first.active, nonce: 1 });
  });

  it('lists the newest revealed seeds first, capped for the response', async () => {
    const seeds = await inFreshDo((sql) => {
      const fair = new FairSeeds(sql);
      fair.open(T0);
      for (let i = 0; i < REVEALED_SEED_HISTORY + 3; i++) {
        fair.rotate({}, { at: T0 + (i + 1) * MIN_ROTATION_INTERVAL_MS, idempotencyKey: key() });
      }
      return fair.seeds();
    });
    expect(seeds.revealed).toHaveLength(REVEALED_SEED_HISTORY);
    expect(seeds.revealed.map((seed) => seed.revealedAt)).toEqual(
      Array.from(
        { length: REVEALED_SEED_HISTORY },
        (_, i) => T0 + (REVEALED_SEED_HISTORY + 3 - i) * MIN_ROTATION_INTERVAL_MS,
      ),
    );
    expect(seeds.revealed.every(verifyRevealedSeed)).toBe(true);
    expect(new Set(seeds.revealed.map((seed) => seed.serverSeed)).size).toBe(REVEALED_SEED_HISTORY);
  });
});

describe('FairSeeds rotation throttle', () => {
  function attempt(fair: FairSeeds, at: number) {
    try {
      return fair.rotate({}, { at, idempotencyKey: key() });
    } catch (error) {
      if (!(error instanceof ApiFailure)) throw error;
      return error;
    }
  }

  function seedRows(sql: SqlStorage): number {
    return sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM fair_seeds').one().n;
  }

  it('refuses a rotation sooner than the interval with the wait, and changes nothing', async () => {
    const result = await inFreshDo((sql) => {
      const fair = new FairSeeds(sql);
      fair.open(T0);
      const before = fair.seeds();
      const early = attempt(fair, T1 - 1);
      return { before, early, after: fair.seeds(), rows: seedRows(sql) };
    });
    expect(result.early).toBeInstanceOf(ApiFailure);
    expect(result.early).toMatchObject({ code: 'rate_limited', extra: { retryAfterMs: 1 } });
    expect(result.after).toEqual(result.before);
    expect(result.rows).toBe(1);
  });

  it('measures the interval from the latest commitment, not the first', async () => {
    const result = await inFreshDo((sql) => {
      const fair = new FairSeeds(sql);
      fair.open(T0);
      const onTime = attempt(fair, T1);
      const tooSoon = attempt(fair, T1 + MIN_ROTATION_INTERVAL_MS - 250);
      const next = attempt(fair, T1 + MIN_ROTATION_INTERVAL_MS);
      return { onTime, tooSoon, next };
    });
    expect(result.onTime).not.toBeInstanceOf(ApiFailure);
    expect(result.tooSoon).toMatchObject({ code: 'rate_limited', extra: { retryAfterMs: 250 } });
    expect(result.next).not.toBeInstanceOf(ApiFailure);
  });

  it('bounds storage against a client minting a fresh Idempotency-Key per request', async () => {
    const rows = await inFreshDo((sql) => {
      const fair = new FairSeeds(sql);
      fair.open(T0);
      for (let ms = 0; ms < 10 * MIN_ROTATION_INTERVAL_MS; ms += 600) attempt(fair, T0 + ms);
      return seedRows(sql);
    });
    expect(rows).toBeLessThanOrEqual(1 + 10);
  });

  it('stays closed when the server clock steps back behind the active commitment', async () => {
    const early = await inFreshDo((sql) => {
      const fair = new FairSeeds(sql);
      fair.open(T1);
      return attempt(fair, T0);
    });
    expect(early).toMatchObject({
      code: 'rate_limited',
      extra: { retryAfterMs: 2 * MIN_ROTATION_INTERVAL_MS },
    });
  });

  it('still answers a replay inside the interval with the original rotation', async () => {
    const result = await inFreshDo((sql) => {
      const fair = new FairSeeds(sql);
      fair.open(T0);
      const idempotencyKey = key();
      const first = fair.rotate({}, { at: T1, idempotencyKey });
      const replay = fair.rotate({}, { at: T1 + 1, idempotencyKey });
      return { first, replay };
    });
    expect(result.replay).toEqual(result.first);
  });
});

describe('FairSeeds tamper resistance', () => {
  it('refuses to swap, re-hash, rewind, un-reveal or delete a committed seed', async () => {
    await inFreshDo((sql) => {
      const fair = new FairSeeds(sql);
      fair.open(T0);
      fair.roll('crate.vault', null, T0);
      const fixed = /cannot be altered or un-revealed/;
      expectAbort(() => sql.exec(`UPDATE fair_seeds SET server_seed = ?`, 'ff'.repeat(32)), fixed);
      expectAbort(
        () => sql.exec(`UPDATE fair_seeds SET server_seed_hash = ?`, 'ff'.repeat(32)),
        fixed,
      );
      expectAbort(() => sql.exec(`UPDATE fair_seeds SET client_seed = 'forged'`), fixed);
      expectAbort(() => sql.exec('UPDATE fair_seeds SET nonce = 0'), fixed);
      expectAbort(() => sql.exec(`UPDATE fair_seeds SET revealed_by = 'sneaky'`), fixed);
      expectAbort(() => sql.exec('DELETE FROM fair_seeds'), /append-only/);

      fair.rotate({}, { at: T1, idempotencyKey: key() });
      expectAbort(
        () => sql.exec('UPDATE fair_seeds SET revealed_at = NULL WHERE revealed_at IS NOT NULL'),
        fixed,
      );
      expectAbort(
        () => sql.exec('UPDATE fair_rolls SET digest = ?', 'ff'.repeat(32)),
        /append-only/,
      );
      expectAbort(() => sql.exec('DELETE FROM fair_rolls'), /append-only/);
    });
  });

  it('allows only one active seed at a time', async () => {
    await inFreshDo((sql) => {
      new FairSeeds(sql).open(T0);
      const secret = 'ee'.repeat(32);
      expect(() =>
        sql.exec(
          `INSERT INTO fair_seeds (server_seed, server_seed_hash, client_seed, nonce, committed_at)
           VALUES (?, ?, 'second', 0, ?)`,
          secret,
          commitmentOf(secret),
          T0,
        ),
      ).toThrow(/UNIQUE/);
    });
  });

  it('never commits the same server seed twice across many rotations', async () => {
    const hashes = await inFreshDo((sql) => {
      const fair = new FairSeeds(sql);
      fair.open(T0);
      const seen = [fair.active().serverSeedHash];
      for (let i = 0; i < 50; i++) {
        seen.push(
          fair.rotate({}, { at: T0 + (i + 1) * MIN_ROTATION_INTERVAL_MS, idempotencyKey: key() })
            .active.serverSeedHash,
        );
      }
      return seen;
    });
    expect(new Set(hashes).size).toBe(hashes.length);
    for (const hash of hashes) expect(ActiveSeedSchema.shape.serverSeedHash.parse(hash)).toBe(hash);
  });
});

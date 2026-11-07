import { cascade, cascadeTierFor, crateSpawn, fusion, fusionValue } from '@coinposh/economy';
import {
  ClaimsResponseSchema,
  DropResponseSchema,
  ErrorEnvelopeSchema,
  GuestAuthResponseSchema,
  StateResponseSchema,
  type ClaimResult,
  type CoinId,
  type MintedCoin,
} from '@coinposh/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadOrCreateDeviceKey } from '../device.ts';
import { verifyFairProofMembership } from '../fair.ts';
import { ApiRequestError } from '../errors.ts';
import { newIdempotencyKey } from '../request.ts';
import { memoryStore } from '../store.ts';
import {
  FakeTime,
  connectPlayer,
  createMockServer,
  errorCode,
  forge,
  ledgerWallet,
  requirePlayerId,
  serverWallet,
  type Player,
} from '../test/harness.ts';
import type { MockServer } from './server.ts';
import { MOCK_RULES } from './rules.ts';

let time: FakeTime;
let server: MockServer;
let alice: Player;

beforeEach(async () => {
  time = new FakeTime();
  server = createMockServer({ now: time.now });
  alice = await connectPlayer(server, time);
});

async function state(player: Player = alice) {
  return player.client.call('state');
}

async function bufferedCoin(player: Player = alice): Promise<MintedCoin> {
  const { table } = await state(player);
  const coin = table.buffer[0];
  if (coin === undefined) throw new Error('Expected a pre-minted coin in the buffer.');
  return coin;
}

/** Drops a buffered coin the honest way, after letting enough real time pass. */
async function dropBuffered(player: Player = alice): Promise<MintedCoin> {
  time.advance(100);
  const coin = await bufferedCoin(player);
  const response = await player.client.call('tableDrop', {
    body: { x: 0, tick: time.tick(), coinId: coin.id },
  });
  return response.coin;
}

async function claimFall(coinId: CoinId, player: Player = alice): Promise<ClaimResult> {
  time.advance(100);
  const { results } = await player.client.call('tableClaims', {
    body: { claims: [{ kind: 'fall', coinId, tick: time.tick(), edge: 'front' }] },
  });
  const [result] = results;
  if (result === undefined) throw new Error('Expected one claim result.');
  return result;
}

async function accessToken(player: Player = alice): Promise<string> {
  return player.session.accessToken();
}

function expectConserved(player: Player = alice): void {
  const id = requirePlayerId(player);
  expect(ledgerWallet(server, id)).toEqual(serverWallet(server, id));
}

describe('mock server: value is minted and conserved server-side', () => {
  it('pre-pays the buffer from the starting coins and records every movement in the ledger', async () => {
    const snapshot = await state();
    expect(snapshot.table.buffer).toHaveLength(MOCK_RULES.bufferSize);
    expect(snapshot.wallet.coins).toBeGreaterThanOrEqual(0);
    const reasons = server.ledger().map((entry) => entry.reason);
    expect(reasons[0]).toBe('signup.startingCoins');
    expect(reasons.filter((reason) => reason === 'drop.prepay')).toHaveLength(
      MOCK_RULES.bufferSize,
    );
    expectConserved();
  });

  it('credits a fallen coin exactly its minted value, once', async () => {
    const coin = await dropBuffered();
    const before = (await state()).wallet.coins;
    const result = await claimFall(coin.id);
    expect(result).toEqual({
      status: 'accepted',
      credited: coin.value,
      cascade: null,
      minted: null,
    });
    const after = await state();
    expect(after.wallet.coins - before).toBe(coin.value);
    expectConserved();
  });

  it('keeps ledger sequence numbers strictly increasing (append-only)', async () => {
    await claimFall((await dropBuffered()).id);
    const seqs = server.ledger().map((entry) => entry.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i));
  });

  it('applies the cascade multiplier from the economy config, never from the client', async () => {
    const coins = [await dropBuffered(), await dropBuffered(), await dropBuffered()];
    time.advance(100);
    const tick = time.tick();
    const { results } = await alice.client.call('tableClaims', {
      body: {
        claims: coins.map((coin) => ({
          kind: 'fall' as const,
          coinId: coin.id,
          tick,
          edge: 'front' as const,
        })),
      },
    });
    const third = cascadeTierFor(3, cascade);
    expect(results[2]).toEqual({
      status: 'accepted',
      credited: Math.floor((coins[2]?.value ?? 0) * (third?.multiplier ?? 1)),
      cascade: third?.id ?? null,
      minted: null,
    });
    expectConserved();
  });

  it('credits nothing for coins that slide off the side gutters', async () => {
    const coin = await dropBuffered();
    time.advance(100);
    const { results } = await alice.client.call('tableClaims', {
      body: { claims: [{ kind: 'fall', coinId: coin.id, tick: time.tick(), edge: 'left' }] },
    });
    expect(results[0]).toEqual({ status: 'accepted', credited: 0, cascade: null, minted: null });
  });

  it('refuses a fresh drop the wallet cannot pay for', async () => {
    let coins = (await state()).wallet.coins;
    while (coins > 0) {
      time.advance(100);
      coins = (await alice.client.call('tableDrop', { body: { x: 0, tick: time.tick() } })).wallet
        .coins;
    }
    time.advance(100);
    await expect(
      alice.client.call('tableDrop', { body: { x: 0, tick: time.tick() } }),
    ).rejects.toMatchObject({ code: 'insufficient_funds' });
    expectConserved();
  });

  it('fuses three same-tier coins into the next tier at the economy fusion value', async () => {
    const coins = [await dropBuffered(), await dropBuffered(), await dropBuffered()];
    time.advance(100);
    const { results } = await alice.client.call('tableClaims', {
      body: {
        claims: [
          {
            kind: 'fusion',
            coinIds: [coins[0]?.id, coins[1]?.id, coins[2]?.id] as [CoinId, CoinId, CoinId],
            tick: time.tick(),
          },
        ],
      },
    });
    const result = results[0];
    expect(result?.status).toBe('accepted');
    if (result?.status !== 'accepted' || result.minted === null)
      throw new Error('Expected a minted coin.');
    expect(result.minted.tier).toBe('silver');
    expect(result.minted.value).toBe(
      Math.floor(
        fusionValue(
          coins.map((coin) => coin.value),
          fusion,
        ),
      ),
    );
    const firstInput = coins[0];
    if (firstInput === undefined) throw new Error('Expected fusion inputs.');
    expect(await claimFall(firstInput.id)).toEqual({
      status: 'rejected',
      reason: 'already_claimed',
    });
    expect((await claimFall(result.minted.id)).status).toBe('accepted');
    expectConserved();
  });
});

describe('mock server: attacks from a compromised client', () => {
  it('replays a resent request instead of applying it twice', async () => {
    const coin = await dropBuffered();
    const token = await accessToken();
    time.advance(100);
    const key = newIdempotencyKey();
    const body = JSON.stringify({
      claims: [{ kind: 'fall', coinId: coin.id, tick: time.tick(), edge: 'front' }],
    });
    const first = await forge(server, alice.device, {
      method: 'POST',
      path: '/v1/table/claims',
      body,
      key,
      token,
    });
    const entries = server.ledger().length;
    const second = await forge(server, alice.device, {
      method: 'POST',
      path: '/v1/table/claims',
      body,
      key,
      token,
    });
    expect(first.status).toBe(200);
    expect(second).toEqual(first);
    expect(server.ledger()).toHaveLength(entries);
    expectConserved();
  });

  it('refuses an idempotency key reused for a different body', async () => {
    const token = await accessToken();
    const key = newIdempotencyKey();
    time.advance(100);
    const first = await forge(server, alice.device, {
      method: 'POST',
      path: '/v1/table/drop',
      body: JSON.stringify({ x: 0, tick: time.tick() }),
      key,
      token,
    });
    const second = await forge(server, alice.device, {
      method: 'POST',
      path: '/v1/table/drop',
      body: JSON.stringify({ x: 0.5, tick: time.tick() }),
      key,
      token,
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(422);
    expect(errorCode(second)).toBe('idempotency_key_reused');
  });

  it('credits a double claim once, across batches and inside one batch', async () => {
    const coin = await dropBuffered();
    expect((await claimFall(coin.id)).status).toBe('accepted');
    expect(await claimFall(coin.id)).toEqual({ status: 'rejected', reason: 'already_claimed' });

    const other = await dropBuffered();
    time.advance(100);
    const tick = time.tick();
    const { results } = await alice.client.call('tableClaims', {
      body: {
        claims: [
          { kind: 'fall', coinId: other.id, tick, edge: 'front' },
          { kind: 'fall', coinId: other.id, tick, edge: 'front' },
        ],
      },
    });
    expect(results.map((result) => result.status)).toEqual(['accepted', 'rejected']);
    expect(server.ledger().filter((entry) => entry.reason === 'claim.fall')).toHaveLength(2);
    expectConserved();
  });

  it('rejects forged coin IDs that were never minted', async () => {
    expect(await claimFall('coin_AAAAAAAAAAAAAAAA' as CoinId)).toEqual({
      status: 'rejected',
      reason: 'unknown_entity',
    });
    time.advance(100);
    await expect(
      alice.client.call('tableDrop', {
        body: { x: 0, tick: time.tick(), coinId: 'coin_BBBBBBBBBBBBBBBB' },
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects an ID of the wrong kind at the contract, before any rule runs', async () => {
    const token = await accessToken();
    time.advance(100);
    const response = await forge(server, alice.device, {
      method: 'POST',
      path: '/v1/table/claims',
      body: JSON.stringify({
        claims: [
          { kind: 'fall', coinId: 'crate_AAAAAAAAAAAAAAAA', tick: time.tick(), edge: 'front' },
        ],
      }),
      token,
    });
    expect(response.status).toBe(400);
    expect(errorCode(response)).toBe('validation_failed');
  });

  it('never lets one player claim or spend coins minted for another', async () => {
    const bob = await connectPlayer(server, time);
    const aliceCoin = await dropBuffered();
    const aliceBuffered = await bufferedCoin();
    expect(await claimFall(aliceCoin.id, bob)).toEqual({
      status: 'rejected',
      reason: 'unknown_entity',
    });
    time.advance(100);
    await expect(
      bob.client.call('tableDrop', { body: { x: 0, tick: time.tick(), coinId: aliceBuffered.id } }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect((await claimFall(aliceCoin.id)).status).toBe('accepted');
  });

  it('refuses to credit a coin still in the buffer (claimed but never dropped)', async () => {
    const coin = await bufferedCoin();
    expect(await claimFall(coin.id)).toEqual({ status: 'rejected', reason: 'not_on_table' });
  });

  it('refuses to spend the same buffered coin twice', async () => {
    const coin = await dropBuffered();
    time.advance(100);
    await expect(
      alice.client.call('tableDrop', { body: { x: 0, tick: time.tick(), coinId: coin.id } }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('rejects value, reward and balance fields smuggled into a body', async () => {
    const token = await accessToken();
    const smuggled = [
      ['/v1/table/drop', { x: 0, tick: time.tick(), value: 1_000_000 }],
      [
        '/v1/table/claims',
        {
          claims: [
            {
              kind: 'fall',
              coinId: 'coin_AAAAAAAAAAAAAAAA',
              tick: 0,
              edge: 'front',
              credited: 999,
            },
          ],
        },
      ],
      ['/v1/table/claims', { claims: [], wallet: { coins: 1e9 } }],
      ['/v1/gacha/pull', { count: 1, rarity: 'heirloom' }],
    ] as const;
    for (const [path, body] of smuggled) {
      const response = await forge(server, alice.device, {
        method: 'POST',
        path,
        body: JSON.stringify(body),
        token,
      });
      expect(response.status, path).toBe(400);
      expect(errorCode(response), path).toBe('validation_failed');
    }
    expectConserved();
  });

  it('rejects a body the device signature does not cover', async () => {
    const token = await accessToken();
    time.advance(100);
    const response = await forge(server, alice.device, {
      method: 'POST',
      path: '/v1/table/drop',
      body: JSON.stringify({ x: 1, tick: time.tick() }),
      signedBody: JSON.stringify({ x: 0, tick: time.tick() }),
      token,
    });
    expect(errorCode(response)).toBe('invalid_signature');
  });

  it('rejects a stolen access token used from another device', async () => {
    const token = await accessToken();
    const thief = await loadOrCreateDeviceKey(memoryStore());
    const response = await forge(server, thief, {
      method: 'GET',
      path: '/v1/state',
      body: null,
      token,
    });
    expect(response.status).toBe(401);
    expect(errorCode(response)).toBe('invalid_signature');
  });

  it('rejects a missing or garbage signature', async () => {
    const token = await accessToken();
    const response = await forge(server, alice.device, {
      method: 'GET',
      path: '/v1/state',
      body: null,
      token,
      signature: 'A'.repeat(86),
    });
    expect(errorCode(response)).toBe('invalid_signature');
    const malformed = await forge(server, alice.device, {
      method: 'GET',
      path: '/v1/state',
      body: null,
      token,
      signature: 'nope',
    });
    expect(errorCode(malformed)).toBe('invalid_signature');
  });

  it('requires an idempotency key on every mutation', async () => {
    const token = await accessToken();
    const response = await forge(server, alice.device, {
      method: 'POST',
      path: '/v1/table/drop',
      body: JSON.stringify({ x: 0, tick: 0 }),
      key: null,
      token,
    });
    expect(response.status).toBe(400);
    expect(errorCode(response)).toBe('idempotency_key_missing');
  });

  it('rejects forged, missing and expired access tokens using server time', async () => {
    const forged = await forge(server, alice.device, {
      method: 'GET',
      path: '/v1/state',
      body: null,
      token: 'at_forged',
    });
    expect(errorCode(forged)).toBe('unauthorized');
    const missing = await forge(server, alice.device, {
      method: 'GET',
      path: '/v1/state',
      body: null,
    });
    expect(errorCode(missing)).toBe('unauthorized');
    const token = await accessToken();
    time.advance(MOCK_RULES.accessTokenTtlMs);
    const expired = await forge(server, alice.device, {
      method: 'GET',
      path: '/v1/state',
      body: null,
      token,
    });
    expect(errorCode(expired)).toBe('token_expired');
  });

  it('revokes every session when a rotated refresh token comes back (token theft)', async () => {
    await accessToken();
    const stored = (await alice.store.get('session')) as { refreshToken: string };
    const refresh = (refreshToken: string) =>
      forge(server, alice.device, {
        method: 'POST',
        path: '/v1/auth/refresh',
        body: JSON.stringify({ refreshToken }),
      });
    const rotated = await refresh(stored.refreshToken);
    expect(rotated.status).toBe(200);
    const next = GuestAuthResponseSchema.parse(rotated.body);
    expect(errorCode(await refresh(stored.refreshToken))).toBe('unauthorized');
    expect(errorCode(await refresh(next.refreshToken))).toBe('unauthorized');
    const revoked = await forge(server, alice.device, {
      method: 'GET',
      path: '/v1/state',
      body: null,
      token: next.accessToken,
    });
    expect(errorCode(revoked)).toBe('unauthorized');
  });

  it('refuses a refresh token signed by a different device', async () => {
    await accessToken();
    const stored = (await alice.store.get('session')) as { refreshToken: string };
    const thief = await loadOrCreateDeviceKey(memoryStore());
    const response = await forge(server, thief, {
      method: 'POST',
      path: '/v1/auth/refresh',
      body: JSON.stringify({ refreshToken: stored.refreshToken }),
    });
    expect(errorCode(response)).toBe('invalid_signature');
  });

  it('refuses a reused Turnstile token at sign-up', async () => {
    const devices = [
      await loadOrCreateDeviceKey(memoryStore()),
      await loadOrCreateDeviceKey(memoryStore()),
    ];
    const responses = [];
    for (const device of devices) {
      responses.push(
        await forge(server, device, {
          method: 'POST',
          path: '/v1/auth/guest',
          body: JSON.stringify({
            devicePublicKey: device.publicKey,
            turnstileToken: 'replayed',
            locale: 'en',
          }),
        }),
      );
    }
    expect(responses[0]?.status).toBe(200);
    expect(errorCode(responses[1] ?? { status: 0, body: null })).toBe('forbidden');
  });

  it('rejects a guest sign-up signed by a key other than the one it registers', async () => {
    const device = await loadOrCreateDeviceKey(memoryStore());
    const impostor = await loadOrCreateDeviceKey(memoryStore());
    const response = await forge(server, device, {
      method: 'POST',
      path: '/v1/auth/guest',
      body: JSON.stringify({
        devicePublicKey: impostor.publicKey,
        turnstileToken: 'fresh-token',
        locale: 'en',
      }),
    });
    expect(errorCode(response)).toBe('invalid_signature');
  });

  it('flags claims stamped with ticks from the future (clock skew / speed hack)', async () => {
    const coin = await dropBuffered();
    const { results } = await alice.client.call('tableClaims', {
      body: {
        claims: [{ kind: 'fall', coinId: coin.id, tick: time.tick() + 60 * 30, edge: 'front' }],
      },
    });
    expect(results[0]).toEqual({ status: 'rejected', reason: 'over_envelope' });
    expect((await claimFall(coin.id)).status).toBe('accepted');
  });

  it('stops a sped-up client whose ticks outrun server time', async () => {
    await dropBuffered();
    let tick = time.tick();
    let refused: unknown = null;
    for (let i = 0; i < 40 && refused === null; i++) {
      time.advance(10);
      tick += 30;
      await alice.client.call('tableDrop', { body: { x: 0, tick } }).catch((error: unknown) => {
        refused = error;
      });
    }
    expect(refused).toBeInstanceOf(ApiRequestError);
    expect(refused).toMatchObject({ code: 'bad_request' });
  });

  it('banks at most maxBankedMs of a long pause for a later burst', async () => {
    await dropBuffered();
    const pausedAt = time.tick();
    time.advance(60 * 60_000);
    const forged = 'coin_AAAAAAAAAAAAAAAA' as CoinId;
    const claimAt = async (tick: number) => {
      const { results } = await alice.client.call('tableClaims', {
        body: { claims: [{ kind: 'fall', coinId: forged, tick, edge: 'front' }] },
      });
      return results[0];
    };
    const ticksPerMs = MOCK_RULES.ticksPerSecond / 1000;
    expect(await claimAt(pausedAt + 1)).toEqual({ status: 'rejected', reason: 'unknown_entity' });
    const withinBank = pausedAt + 1 + Math.floor((MOCK_RULES.maxBankedMs - 1_000) * ticksPerMs);
    expect(await claimAt(withinBank)).toEqual({ status: 'rejected', reason: 'unknown_entity' });
    const pastBank =
      pausedAt +
      1 +
      Math.ceil((MOCK_RULES.maxBankedMs + MOCK_RULES.tickSlackMs + 1_000) * ticksPerMs);
    expect(await claimAt(pastBank)).toEqual({ status: 'rejected', reason: 'over_envelope' });
  });

  it('enforces the minimum spacing between drops (over-envelope bot)', async () => {
    await dropBuffered();
    const tick = time.tick();
    await expect(
      alice.client.call('tableDrop', { body: { x: 0, tick: tick + 1 } }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rate-limits a request flood per player and says when to come back', async () => {
    const token = await accessToken();
    const responses = [];
    for (let i = 0; i < MOCK_RULES.maxRequestsPerSecond + 5; i++) {
      responses.push(
        await forge(server, alice.device, { method: 'GET', path: '/v1/state', body: null, token }),
      );
    }
    const limited = responses.filter((response) => response.status === 429);
    expect(limited.length).toBeGreaterThan(0);
    const envelope = ErrorEnvelopeSchema.parse(limited[0]?.body);
    expect(envelope.error.code).toBe('rate_limited');
    expect(envelope.error.retryAfterMs).toBeGreaterThan(0);
    time.advance(1_000);
    expect(
      (await forge(server, alice.device, { method: 'GET', path: '/v1/state', body: null, token }))
        .status,
    ).toBe(200);
  });

  it('caps body size', async () => {
    const token = await accessToken();
    const response = await forge(server, alice.device, {
      method: 'POST',
      path: '/v1/table/drop',
      body: JSON.stringify({ x: 0, tick: 0, pad: 'x'.repeat(70_000) }),
      token,
    });
    expect(response.status).toBe(413);
  });

  it('rejects malformed JSON, unknown routes and bodies on GET', async () => {
    const token = await accessToken();
    expect(
      errorCode(
        await forge(server, alice.device, {
          method: 'POST',
          path: '/v1/table/drop',
          body: '{"x":',
          token,
        }),
      ),
    ).toBe('bad_request');
    expect(
      errorCode(
        await forge(server, alice.device, {
          method: 'GET',
          path: '/v1/admin/mint',
          body: null,
          token,
        }),
      ),
    ).toBe('not_found');
    expect(
      errorCode(
        await forge(server, alice.device, { method: 'GET', path: '/v1/state', body: '{}', token }),
      ),
    ).toBe('bad_request');
  });

  it('refuses fusing coins of different tiers', async () => {
    const coins = [await dropBuffered(), await dropBuffered(), await dropBuffered()];
    time.advance(100);
    const fused = await alice.client.call('tableClaims', {
      body: {
        claims: [
          {
            kind: 'fusion',
            coinIds: coins.map((coin) => coin.id) as [CoinId, CoinId, CoinId],
            tick: time.tick(),
          },
        ],
      },
    });
    const silver = fused.results[0]?.status === 'accepted' ? fused.results[0].minted : null;
    if (silver === null) throw new Error('Expected a silver coin.');
    const coppers = [await dropBuffered(), await dropBuffered()];
    time.advance(100);
    const { results } = await alice.client.call('tableClaims', {
      body: {
        claims: [
          {
            kind: 'fusion',
            coinIds: [silver.id, coppers[0]?.id, coppers[1]?.id] as [CoinId, CoinId, CoinId],
            tick: time.tick(),
          },
        ],
      },
    });
    expect(results[0]).toEqual({ status: 'rejected', reason: 'tier_mismatch' });
  });

  it('freezes the table when nudges exhaust the Concierge’s decorum', async () => {
    let frozen = false;
    for (let i = 0; i < 20 && !frozen; i++) {
      time.advance(10);
      const response = await alice.client.call('tableNudge', {
        body: { tick: time.tick(), direction: 'left' },
      });
      frozen = response.frozenUntil !== null;
    }
    expect(frozen).toBe(true);
    time.advance(10);
    await expect(
      alice.client.call('tableNudge', { body: { tick: time.tick(), direction: 'left' } }),
    ).rejects.toMatchObject({ code: 'table_frozen' });
    time.advance(MOCK_RULES.conciergeFreezeMs);
    await expect(
      alice.client.call('tableNudge', { body: { tick: time.tick(), direction: 'right' } }),
    ).resolves.toMatchObject({ frozenUntil: null });
  });
});

describe('mock server: crates and provable fairness', () => {
  it('scripts the FTUE crate, opens it once, and the roll verifies against the revealed seed', async () => {
    let crate = null;
    for (let i = 0; i < crateSpawn.ftueScriptedDrop && crate === null; i++) {
      const coin = await bufferedCoin();
      time.advance(100);
      const response = await alice.client.call('tableDrop', {
        body: { x: 0, tick: time.tick(), coinId: coin.id },
      });
      crate = response.spawnedCrates[0] ?? null;
      await claimFall(coin.id);
    }
    if (crate === null) throw new Error('Expected the scripted FTUE crate.');
    await expect(
      alice.client.call('cratesOpen', { body: { crateId: crate.id } }),
    ).rejects.toMatchObject({
      code: 'not_ready',
    });
    time.advance(100);
    await alice.client.call('tableClaims', {
      body: { claims: [{ kind: 'crate', crateId: crate.id, tick: time.tick(), edge: 'front' }] },
    });
    const opened = await alice.client.call('cratesOpen', { body: { crateId: crate.id } });
    expect(opened.roll.rarity).toBe(crateSpawn.ftueScriptedRarity);
    expect(opened.roll.rewards.some((reward) => reward.kind === 'charm')).toBe(
      crateSpawn.ftueScriptedCharm,
    );
    await expect(
      alice.client.call('cratesOpen', { body: { crateId: crate.id } }),
    ).rejects.toMatchObject({
      code: 'conflict',
    });
    const rotated = await alice.client.call('fairRotate', { body: {} });
    expect(rotated.revealed.serverSeedHash).toBe(opened.roll.proof.serverSeedHash);
    await expect(verifyFairProofMembership(rotated.revealed, opened.roll.proof)).resolves.toBe(
      true,
    );
    expectConserved();
  });
});

describe('mock server: every endpoint honours its shared contract', () => {
  it('answers each endpoint with a body its zod schema accepts, or a valid error envelope', async () => {
    const coin = await dropBuffered();
    const outcomes: Record<string, string> = {};
    const record = async (name: string, call: () => Promise<unknown>) => {
      try {
        await call();
        outcomes[name] = 'ok';
      } catch (error) {
        if (!(error instanceof ApiRequestError)) throw error;
        outcomes[name] = error.code;
      }
    };
    const { client } = alice;
    const tick = () => {
      time.advance(100);
      return time.tick();
    };
    await record('authGuest', () => alice.session.accessToken());
    await record('authRefresh', async () => {
      alice.session.expireAccessToken();
      await alice.session.accessToken();
    });
    await record('state', () => client.call('state'));
    await record('tableDrop', () => client.call('tableDrop', { body: { x: 0.25, tick: tick() } }));
    await record('tableClaims', () =>
      client.call('tableClaims', {
        body: { claims: [{ kind: 'fall', coinId: coin.id, tick: tick(), edge: 'front' }] },
      }),
    );
    await record('tableNudge', () =>
      client.call('tableNudge', { body: { tick: tick(), direction: 'forward' } }),
    );
    await record('tableInputs', () =>
      client.call('tableInputs', {
        body: {
          fromTick: 0,
          toTick: 10,
          events: [{ kind: 'pourStart', tick: 1 }],
          checkpoints: [{ tick: 10, hash: 'deadbeef' }],
        },
      }),
    );
    await record('upgradesBuy', () =>
      client.call('upgradesBuy', {
        body: { venueId: 'rivieraYacht', lineId: 'pusherSpeed', level: 1 },
      }),
    );
    await record('charmsEquip', () =>
      client.call('charmsEquip', { body: { venueId: 'rivieraYacht', socket: 0, charmId: null } }),
    );
    await record('cratesOpen', () =>
      client.call('cratesOpen', { body: { crateId: 'crate_AAAAAAAAAAAAAAAA' } }),
    );
    await record('safesOpen', () =>
      client.call('safesOpen', { body: { safeId: 'safe_AAAAAAAAAAAAAAAA', method: 'timer' } }),
    );
    await record('gachaPull', () => client.call('gachaPull', { body: { count: 1 } }));
    await record('scratchReveal', () =>
      client.call('scratchReveal', { body: { cardId: 'scratch_AAAAAAAAAAAAAAAA' } }),
    );
    await record('ascend', () => client.call('ascend', { body: { venueId: 'rivieraYacht' } }));
    await record('album', () => client.call('album'));
    await record('fairSeeds', () => client.call('fairSeeds'));
    await record('fairRotate', () =>
      client.call('fairRotate', { body: { clientSeed: 'my-own-seed' } }),
    );
    await record('quests', () => client.call('quests'));
    await record('questsClaim', () =>
      client.call('questsClaim', { body: { questId: 'quest_AAAAAAAAAAAAAAAA' } }),
    );
    await record('season', () => client.call('season'));
    await record('leaderboard', () => client.call('leaderboard', { params: { board: 'weekly' } }));
    await record('eventsCurrent', () => client.call('eventsCurrent'));

    expect(outcomes).toEqual({
      authGuest: 'ok',
      authRefresh: 'ok',
      state: 'ok',
      tableDrop: 'ok',
      tableClaims: 'ok',
      tableNudge: 'ok',
      tableInputs: 'ok',
      upgradesBuy: 'insufficient_funds',
      charmsEquip: 'ok',
      cratesOpen: 'not_found',
      safesOpen: 'not_found',
      gachaPull: 'insufficient_funds',
      scratchReveal: 'not_found',
      ascend: 'not_ready',
      album: 'ok',
      fairSeeds: 'ok',
      fairRotate: 'ok',
      quests: 'ok',
      questsClaim: 'not_found',
      season: 'ok',
      leaderboard: 'ok',
      eventsCurrent: 'ok',
    });
    expectConserved();
  });

  it('serves responses that re-parse with the shared schemas after a JSON round trip', async () => {
    const token = await accessToken();
    const snapshot = await forge(server, alice.device, {
      method: 'GET',
      path: '/v1/state',
      body: null,
      token,
    });
    expect(StateResponseSchema.safeParse(snapshot.body).success).toBe(true);
    time.advance(100);
    const drop = await forge(server, alice.device, {
      method: 'POST',
      path: '/v1/table/drop',
      body: JSON.stringify({ x: 0, tick: time.tick() }),
      token,
    });
    const parsed = DropResponseSchema.parse(drop.body);
    time.advance(100);
    const claims = await forge(server, alice.device, {
      method: 'POST',
      path: '/v1/table/claims',
      body: JSON.stringify({
        claims: [{ kind: 'fall', coinId: parsed.coin.id, tick: time.tick(), edge: 'front' }],
      }),
      token,
    });
    expect(ClaimsResponseSchema.safeParse(claims.body).success).toBe(true);
  });
});

import {
  cascade,
  cascadeTierFor,
  coinTiers,
  crateSpawn,
  crateSpawnInterval,
  dropBufferTarget,
  dropSpacingTicks,
  fusion,
  fusionValue,
  offline,
  offlineRate,
  offlineVaultCoins,
  openingHeap,
  mintedCoinValue,
  pushTravelTicks,
  rateEnvelope,
  rateEnvelopeScale,
  starterVaultCoins,
  upgradeCost,
  upgradeLines,
  venues,
  type UpgradeLevelMap,
} from '@coinposh/economy';
import {
  ClaimsResponseSchema,
  DropResponseSchema,
  ErrorEnvelopeSchema,
  GuestAuthResponseSchema,
  StateResponseSchema,
  type Claim,
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

/** Lets a freshly dropped coin cross the table, as it physically has to before it can fall. */
function travel(): void {
  time.advance(MOCK_RULES.minFallMsAfterDrop);
}

async function claimFall(coinId: CoinId, player: Player = alice): Promise<ClaimResult> {
  travel();
  const { results } = await player.client.call('tableClaims', {
    body: { claims: [{ kind: 'fall', coinId, tick: time.tick(), edge: 'front' }] },
  });
  const [result] = results;
  if (result === undefined) throw new Error('Expected one claim result.');
  return result;
}

async function claimAt(claims: readonly Claim[], player: Player = alice) {
  return (await player.client.call('tableClaims', { body: { claims: [...claims] } })).results;
}

function fallAt(coin: MintedCoin, tick: number): Claim {
  return { kind: 'fall', coinId: coin.id, tick, edge: 'front' };
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

  it('opens the table with the economy opening heap, paid out as soon as it falls', async () => {
    const { table, wallet } = await state();
    expect(table.coins).toHaveLength(openingHeap.coins);
    expect(new Set(table.coins.map((coin) => coin.tier))).toEqual(new Set([openingHeap.tier]));
    const face = coinTiers.find((tier) => tier.id === openingHeap.tier)?.value;
    expect(table.coins.every((coin) => coin.value === face)).toBe(true);
    const [first, second] = table.coins;
    if (first === undefined || second === undefined) throw new Error('Expected a heap.');
    time.advance(100);
    const results = await claimAt([fallAt(first, time.tick())]);
    expect(results).toEqual([
      { status: 'accepted', credited: first.value, cascade: null, minted: null },
    ]);
    expect((await state()).wallet.coins - wallet.coins).toBe(first.value);
    expect(await claimAt([fallAt(first, time.tick())])).toEqual([
      { status: 'rejected', reason: 'already_claimed' },
    ]);
    expect((await state()).table.coins.map((coin) => coin.id)).not.toContain(first.id);
    expect((await state()).table.coins.map((coin) => coin.id)).toContain(second.id);
    expectConserved();
  });

  it('keeps ledger sequence numbers strictly increasing (append-only)', async () => {
    await claimFall((await dropBuffered()).id);
    const seqs = server.ledger().map((entry) => entry.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i));
  });

  it('applies the cascade multiplier to plausible, forward-moving falls after the travel time', async () => {
    const coins = [await dropBuffered(), await dropBuffered(), await dropBuffered()];
    travel();
    const start = time.tick();
    const gap = Math.floor(((cascade.windowMs / 1000) * MOCK_RULES.ticksPerSecond) / 2);
    const results = await claimAt(coins.map((coin, i) => fallAt(coin, start + i * gap)));
    const third = cascadeTierFor(3, cascade);
    expect(third).not.toBeNull();
    expect(results.map((result) => result.status)).toEqual(['accepted', 'accepted', 'accepted']);
    expect(results[2]).toEqual({
      status: 'accepted',
      credited: Math.floor((coins[2]?.value ?? 0) * (third?.multiplier ?? 1)),
      cascade: third?.id ?? null,
      minted: null,
    });
    expectConserved();
  });

  it('breaks the cascade when falls are further apart than the cascade window', async () => {
    const coins = [await dropBuffered(), await dropBuffered(), await dropBuffered()];
    travel();
    const start = time.tick();
    const apart = Math.ceil((cascade.windowMs / 1000) * MOCK_RULES.ticksPerSecond) + 1;
    const results = await claimAt(coins.map((coin, i) => fallAt(coin, start + i * apart)));
    expect(results).toEqual(
      coins.map((coin) => ({
        status: 'accepted',
        credited: coin.value,
        cascade: null,
        minted: null,
      })),
    );
  });

  it('pays 10 chained copper falls 11 through Chic, Lavish and Opulent, like the server', async () => {
    const coins: MintedCoin[] = [];
    for (let i = 0; i < 10; i++) coins.push(await dropBuffered());
    expect(coins.every((coin) => coin.tier === coinTiers[0].id && coin.value === 1)).toBe(true);
    travel();
    const start = time.tick();
    const ledgerBefore = server.ledger().length;
    const results = await claimAt(coins.map((coin, i) => fallAt(coin, start + i)));
    const accepted = results.map((result) => {
      if (result.status !== 'accepted') throw new Error(`Fall refused: ${result.reason}`);
      return result;
    });
    expect(accepted.map((result) => result.cascade)).toEqual([
      null,
      null,
      'chic',
      'chic',
      'chic',
      'lavish',
      'lavish',
      'lavish',
      'lavish',
      'opulent',
    ]);
    const total = accepted.reduce((sum, result) => sum + result.credited, 0);
    expect(total).toBeGreaterThan(10);
    expect(total).toBe(11);
    const paid = server
      .ledger()
      .slice(ledgerBefore)
      .filter((entry) => entry.reason === 'claim.fall');
    expect(paid.reduce((sum, entry) => sum + (entry.delta.coins ?? 0), 0)).toBe(11);
    expectConserved();
  });

  it('does not advance the cascade chain or the carry for a replayed claim', async () => {
    const coins = [await dropBuffered(), await dropBuffered(), await dropBuffered()];
    travel();
    const start = time.tick();
    const player = server.world.player(requirePlayerId(alice));
    if (player === undefined) throw new Error('Expected Alice in the mock world.');
    const body = { claims: coins.slice(0, 2).map((coin, i) => fallAt(coin, start + i)) };
    const key = newIdempotencyKey();
    const once = await alice.client.call('tableClaims', { body }, { idempotencyKey: key });
    const chain = player.cascadeChain;
    const carry = player.cascadeCarry;
    const again = await alice.client.call('tableClaims', { body }, { idempotencyKey: key });
    expect(again).toEqual(once);
    expect(player.cascadeChain).toEqual(chain);
    expect(player.cascadeCarry).toBe(carry);
    const third = coins[2];
    if (third === undefined) throw new Error('Expected three coins.');
    expect(await claimAt([fallAt(third, start + 2)])).toMatchObject([
      { status: 'accepted', cascade: 'chic' },
    ]);
    expectConserved();
  });

  it('credits nothing for coins that slide off the side gutters', async () => {
    const coin = await dropBuffered();
    travel();
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
    time.advance(MOCK_RULES.minFusionMsAfterSpawn);
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
    travel();
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

  it('accepts the boot flag on state and refuses a query outside the contract', async () => {
    const token = await accessToken();
    const boot = await forge(server, alice.device, {
      method: 'GET',
      path: '/v1/state?hydrate=boot',
      body: null,
      token,
    });
    expect(boot.status).toBe(200);
    for (const path of ['/v1/state?hydrate=yes', '/v1/state?refund=all']) {
      const response = await forge(server, alice.device, {
        method: 'GET',
        path,
        body: null,
        token,
      });
      expect(response.status, path).toBe(400);
      expect(errorCode(response)).toBe('validation_failed');
    }
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

  it('expires a claim whose tick is older than the 10-minute claim expiry, however late it arrives', async () => {
    const coin = await dropBuffered();
    travel();
    const stale = time.tick();
    time.advance(MOCK_RULES.claimExpiryMs + 1_000);
    expect(await claimAt([fallAt(coin, stale)])).toEqual([
      { status: 'rejected', reason: 'expired' },
    ]);
    time.advance(3 * 86_400_000);
    expect(await claimAt([fallAt(coin, stale + 1)])).toEqual([
      { status: 'rejected', reason: 'expired' },
    ]);
    expect(server.ledger().filter((entry) => entry.reason === 'claim.fall')).toHaveLength(0);
    expect((await claimFall(coin.id)).status).toBe('accepted');
    expectConserved();
  });

  it('accepts a queued claim still inside the expiry window', async () => {
    const coin = await dropBuffered();
    travel();
    const queued = time.tick();
    time.advance(MOCK_RULES.claimExpiryMs - 1_000);
    expect((await claimAt([fallAt(coin, queued)]))[0]?.status).toBe('accepted');
  });

  it('refuses a buffered-coin drop older than the expiry and keeps the coin in the buffer', async () => {
    await dropBuffered();
    const stale = time.tick() + MOCK_RULES.minTicksBetweenDrops;
    const coin = await bufferedCoin();
    time.advance(MOCK_RULES.claimExpiryMs + 1_000);
    await expect(
      alice.client.call('tableDrop', { body: { x: 0, tick: stale, coinId: coin.id } }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect((await state()).table.buffer.map((buffered) => buffered.id)).toContain(coin.id);
    expect(await claimFall(coin.id)).toEqual({ status: 'rejected', reason: 'not_on_table' });
    expectConserved();
  });

  it('re-anchors the paused tick clock on resume, but keeps a held-back pre-pause claim expired', async () => {
    const held = await dropBuffered();
    travel();
    const heldTick = time.tick();
    await dropBuffered();
    let sim = time.tick();
    time.advance(11 * 60_000);
    const coin = await bufferedCoin();

    sim += MOCK_RULES.minTicksBetweenDrops;
    const dropped = await alice.client.call('tableDrop', {
      body: { x: 0, tick: sim, coinId: coin.id },
    });
    expect(dropped.coin).toEqual(coin);
    time.advance(MOCK_RULES.minFallMsAfterDrop);
    sim += Math.ceil((MOCK_RULES.minFallMsAfterDrop / 1000) * MOCK_RULES.ticksPerSecond);
    expect(await claimAt([fallAt(coin, sim)])).toEqual([
      { status: 'accepted', credited: coin.value, cascade: null, minted: null },
    ]);
    expect(await claimAt([fallAt(held, heldTick)])).toEqual([
      { status: 'rejected', reason: 'expired' },
    ]);
    expect(
      server.ledger().filter((entry) => entry.reason === 'claim.fall' && entry.ref === held.id),
    ).toHaveLength(0);
    expectConserved();
  });

  it('settles the offline vault on the resume snapshot even when queued play arrived first', async () => {
    await dropBuffered();
    const awayMs = 2 * 3_600_000;
    time.advance(awayMs);
    const { results } = await alice.client.call('tableClaims', {
      body: {
        claims: [{ kind: 'fall', coinId: 'coin_ZZZZZZZZZZZZZZZZ', tick: 0, edge: 'front' }],
      },
    });
    expect(results).toEqual([{ status: 'rejected', reason: 'expired' }]);
    const resumed = await state();
    expect(resumed.offline).toMatchObject({ awayMs });
    expect(resumed.offline?.coins).toBeGreaterThan(0);
    expect((await state()).offline).toBeNull();
    expectConserved();
  });

  it('pays a fresh profile that has won nothing, away 2 h, only the documented starter floor', async () => {
    const { wallet } = await state();
    time.advance(2 * 3_600_000);
    const resumed = await state();
    expect(resumed.offline).toEqual({
      awayMs: 2 * 3_600_000,
      creditedMs: 2 * 3_600_000,
      coins: starterVaultCoins(offline.baseCapHours),
    });
    expect(resumed.offline?.coins).toBe(42);
    expect(resumed.wallet.coins - wallet.coins).toBe(42);
    expectConserved();
  });

  it('pays min(h, cap) × 0.35 × the net rate measured over active play, not account age', async () => {
    await state();
    time.advance(5 * 3_600_000);
    expect((await state()).offline?.coins).toBe(starterVaultCoins(offline.baseCapHours));
    const { table } = await state();
    const heap = table.coins.slice(0, 12);
    time.advance(100);
    let won = 0;
    for (let i = 0; i < heap.length; i += 3) {
      const tick = time.tick();
      const results = await claimAt(heap.slice(i, i + 3).map((coin) => fallAt(coin, tick)));
      for (const result of results) {
        if (result.status !== 'accepted') throw new Error(`Heap fall refused: ${result.reason}`);
        won += result.credited;
      }
      time.advance(1_000);
    }
    const rate = (won * 3_600_000) / offlineRate.minSpanMs;
    expect(rate).toBeGreaterThan(offlineRate.starterRatePerHour);
    time.advance(8 * 3_600_000);
    const resumed = await state();
    expect(resumed.offline).toEqual({
      awayMs: 8 * 3_600_000 + 1_000,
      creditedMs: 2 * 3_600_000,
      coins: offlineVaultCoins(8, offline.baseCapHours, rate),
    });
    // The heap falls chain into a Chic cascade, so the rate is not whole and the Vault pays its floor.
    expect(resumed.offline?.coins).toBe(Math.floor(2 * offline.activeRateFactor * rate + 1e-9));
    expectConserved();
  });

  it('never lets a held-back claim sent first after a resume become the new anchor', async () => {
    const held = await dropBuffered();
    travel();
    const heldTick = time.tick();
    await dropBuffered();
    const sim = time.tick();
    time.advance(11 * 60_000);
    await state();
    expect(await claimAt([fallAt(held, heldTick)])).toEqual([
      { status: 'rejected', reason: 'expired' },
    ]);
    const coin = await bufferedCoin();
    await expect(
      alice.client.call('tableDrop', {
        body: { x: 0, tick: sim + MOCK_RULES.minTicksBetweenDrops, coinId: coin.id },
      }),
    ).resolves.toMatchObject({ coin });
    expectConserved();
  });

  it('only re-anchors after a real absence, not on state polled through the pause', async () => {
    await dropBuffered();
    const sim = time.tick();
    for (let waited = 0; waited <= MOCK_RULES.claimExpiryMs; waited += 30_000) {
      time.advance(30_000);
      await state();
    }
    const coin = await bufferedCoin();
    await expect(
      alice.client.call('tableDrop', {
        body: { x: 0, tick: sim + MOCK_RULES.minTicksBetweenDrops, coinId: coin.id },
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expectConserved();
  });

  it('still stops a sped-up client after a resume re-anchored its clock', async () => {
    await dropBuffered();
    let tick = time.tick();
    time.advance(11 * 60_000);
    await state();
    let refused: unknown = null;
    for (let i = 0; i < 40 && refused === null; i++) {
      time.advance(10);
      tick += 30;
      await alice.client.call('tableDrop', { body: { x: 0, tick } }).catch((error: unknown) => {
        refused = error;
      });
    }
    expect(refused).toMatchObject({ code: 'bad_request' });
    expectConserved();
  });

  it('rejects a fall claimed in the same instant as its drop (no table crossing)', async () => {
    const coin = await bufferedCoin();
    time.advance(100);
    const tick = time.tick();
    await alice.client.call('tableDrop', { body: { x: 0, tick, coinId: coin.id } });
    const before = server.ledger().length;
    expect(await claimAt([fallAt(coin, tick)])).toEqual([
      { status: 'rejected', reason: 'over_envelope' },
    ]);
    const justShort =
      tick + Math.ceil((MOCK_RULES.minFallMsAfterDrop / 1000) * MOCK_RULES.ticksPerSecond) - 1;
    time.advance(MOCK_RULES.minFallMsAfterDrop);
    expect(await claimAt([fallAt(coin, justShort)])).toEqual([
      { status: 'rejected', reason: 'over_envelope' },
    ]);
    expect(server.ledger()).toHaveLength(before);
    expect((await claimFall(coin.id)).status).toBe('accepted');
    expectConserved();
  });

  it('defeats a drop-then-claim farming bot: no credit or bullion without the table crossing', async () => {
    const before = (await state()).wallet;
    const results: ClaimResult[] = [];
    for (let i = 0; i < 8; i++) {
      const coin = await dropBuffered();
      results.push(...(await claimAt([fallAt(coin, time.tick())])));
    }
    expect(results).toEqual(results.map(() => ({ status: 'rejected', reason: 'over_envelope' })));
    expect(server.ledger().filter((entry) => entry.reason === 'claim.fall')).toHaveLength(0);
    expect((await state()).wallet.bullion).toBe(before.bullion);
    expectConserved();
  });

  it('caps a burst of same-tick claims and never multiplies it into a high cascade', async () => {
    const coins: MintedCoin[] = [];
    for (let i = 0; i < 10; i++) coins.push(await dropBuffered());
    travel();
    const tick = time.tick();
    const results = await claimAt(coins.map((coin) => fallAt(coin, tick)));
    const { maxPerTick } = MOCK_RULES.fallEnvelope;
    expect(results.slice(0, maxPerTick).map((result) => result.status)).toEqual(
      Array.from({ length: maxPerTick }, () => 'accepted'),
    );
    expect(results.slice(maxPerTick)).toEqual(
      coins.slice(maxPerTick).map(() => ({ status: 'rejected', reason: 'over_envelope' })),
    );
    const best = cascadeTierFor(maxPerTick, cascade);
    expect(results[maxPerTick - 1]).toMatchObject({ cascade: best?.id ?? null });
    expect(server.ledger().filter((entry) => entry.reason === 'claim.fall')).toHaveLength(
      maxPerTick,
    );
    expectConserved();
  });

  it('caps falls per sliding window even when the bot spreads its ticks', async () => {
    const { max, windowMs } = MOCK_RULES.fallEnvelope;
    const coins: MintedCoin[] = [];
    while (coins.length < max + 3) coins.push(await dropBuffered());
    travel();
    const start = time.tick();
    const windowTicks = (windowMs / 1000) * MOCK_RULES.ticksPerSecond;
    const step = Math.max(1, Math.floor(windowTicks / coins.length));
    const results = await claimAt(coins.map((coin, i) => fallAt(coin, start + i * step)));
    expect(results.filter((result) => result.status === 'accepted')).toHaveLength(max);
    expect(results.at(-1)).toEqual({ status: 'rejected', reason: 'over_envelope' });
    expectConserved();
  });

  it('rejects claim ticks that go backwards, so out-of-order ticks cannot extend a cascade', async () => {
    const first = await dropBuffered();
    const second = await dropBuffered();
    travel();
    const tick = time.tick();
    expect((await claimAt([fallAt(first, tick)]))[0]?.status).toBe('accepted');
    expect(await claimAt([fallAt(second, tick - 1)])).toEqual([
      { status: 'rejected', reason: 'over_envelope' },
    ]);
    expect((await claimAt([fallAt(second, tick)]))[0]?.status).toBe('accepted');
  });

  it('rejects a fusion of coins that have not landed yet', async () => {
    const coins = [await dropBuffered(), await dropBuffered(), await dropBuffered()];
    const ids = coins.map((coin) => coin.id) as [CoinId, CoinId, CoinId];
    expect(await claimAt([{ kind: 'fusion', coinIds: ids, tick: time.tick() }])).toEqual([
      { status: 'rejected', reason: 'over_envelope' },
    ]);
    time.advance(MOCK_RULES.minFusionMsAfterSpawn);
    expect((await claimAt([{ kind: 'fusion', coinIds: ids, tick: time.tick() }]))[0]?.status).toBe(
      'accepted',
    );
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
    time.advance(MOCK_RULES.minFusionMsAfterSpawn);
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
    time.advance(MOCK_RULES.minFusionMsAfterSpawn);
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

describe('mock server: memory stays bounded in a long session', () => {
  it('keeps replays, the ledger and spent coin IDs bounded over thousands of drops and falls', async () => {
    // Signing and verifying every request is the slow part, so most cycles go straight to the
    // world's rules and every `signedEvery`-th one takes the full request path to fill the replay store.
    const stepMs = 1_000;
    const signedEvery = 10;
    const ledgerTarget = Math.ceil(1.25 * MOCK_RULES.ledgerRetained);
    const sessionMs = 2 * MOCK_RULES.claimExpiryMs;
    const fallTicks = Math.ceil((MOCK_RULES.minFallMsAfterDrop / 1000) * MOCK_RULES.ticksPerSecond);
    let buffer = (await state()).table.buffer;
    const found = server.world.player(requirePlayerId(alice));
    if (found === undefined) throw new Error('Expected Alice in the mock world.');
    const player = found;

    async function drop(coinId: CoinId, tick: number, signed: boolean) {
      const body = { x: 0, tick, coinId };
      if (signed) return alice.client.call('tableDrop', { body });
      const at = time.now();
      const result = await server.world.handle(player, 'tableDrop', body, undefined as never, at);
      server.world.touch(player, at);
      return DropResponseSchema.parse(result);
    }

    async function claim(claims: Claim[], signed: boolean) {
      if (signed) return claimAt(claims);
      const at = time.now();
      const result = await server.world.handle(
        player,
        'tableClaims',
        { claims },
        undefined as never,
        at,
      );
      server.world.touch(player, at);
      return ClaimsResponseSchema.parse(result).results;
    }

    const startedAt = time.now();
    const signedBefore = alice.requests.length;
    const inFlight: { coin: MintedCoin; tick: number }[] = [];
    let cycles = 0;
    let accepted = 0;
    while (
      (server.ledger().at(-1)?.seq ?? 0) < ledgerTarget ||
      time.now() - startedAt < sessionMs
    ) {
      const signed = cycles % signedEvery === 0;
      cycles += 1;
      time.advance(stepMs);
      const tick = time.tick();
      const coin = buffer[0];
      if (coin === undefined) throw new Error(`The buffer ran dry at cycle ${String(cycles)}.`);
      const dropped = await drop(coin.id, tick, signed);
      buffer = dropped.buffer;
      inFlight.push({ coin: dropped.coin, tick });
      const due = inFlight.filter((entry) => entry.tick + fallTicks <= tick);
      if (due.length === 0) continue;
      inFlight.splice(0, due.length);
      const results = await claim(
        due.map((entry) => fallAt(entry.coin, tick)),
        signed,
      );
      accepted += results.filter((result) => result.status === 'accepted').length;
    }
    expect(accepted).toBeGreaterThan(cycles - 10);

    const signedRequests = alice.requests.length - signedBefore;
    const signedPerExpiry = (2 * MOCK_RULES.claimExpiryMs) / (stepMs * signedEvery);
    expect(server.retainedReplays()).toBeLessThanOrEqual(signedPerExpiry + 2);
    expect(signedRequests).toBeGreaterThan(1.5 * (signedPerExpiry + 2));
    const ledger = server.ledger();
    expect(ledger).toHaveLength(MOCK_RULES.ledgerRetained);
    expect(ledger.at(-1)?.seq).toBeGreaterThanOrEqual(ledgerTarget);
    const seqs = ledger.map((entry) => entry.seq);
    expect(seqs).toEqual(seqs.map((_, i) => (seqs[0] ?? 0) + i));
    expect(cycles).toBeGreaterThan(2 * (MOCK_RULES.claimExpiryMs / stepMs) - 1);
    expect(player.gone.size).toBeLessThanOrEqual(MOCK_RULES.claimExpiryMs / stepMs + 1);
    expectConserved();
  });

  it('answers a replay inside the expiry from the store and refuses one after it', async () => {
    const coin = await bufferedCoin();
    time.advance(100);
    const key = newIdempotencyKey();
    const body = { x: 0, tick: time.tick(), coinId: coin.id };
    const first = await alice.client.call('tableDrop', { body }, { idempotencyKey: key });
    const entries = server.ledger().length;
    time.advance(MOCK_RULES.claimExpiryMs - 1_000);
    await expect(
      alice.client.call('tableDrop', { body }, { idempotencyKey: key }),
    ).resolves.toEqual(first);
    time.advance(2_000);
    await expect(
      alice.client.call('tableDrop', { body }, { idempotencyKey: key }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(server.ledger()).toHaveLength(entries);
    expectConserved();
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
  it('rejects a crate claim from before the crate spawned and accepts one at or after spawn', async () => {
    let crate = null;
    let spawnTick = 0;
    let spawningCoin: CoinId | null = null;
    for (let i = 0; i < crateSpawn.ftueScriptedDrop && crate === null; i++) {
      const coin = await bufferedCoin();
      time.advance(100);
      spawnTick = time.tick();
      const response = await alice.client.call('tableDrop', {
        body: { x: 0, tick: spawnTick, coinId: coin.id },
      });
      crate = response.spawnedCrates[0] ?? null;
      if (crate === null) await claimFall(coin.id);
      else spawningCoin = coin.id;
    }
    if (crate === null || spawningCoin === null)
      throw new Error('Expected the scripted FTUE crate.');
    const entries = server.ledger().length;
    expect(
      await claimAt([{ kind: 'crate', crateId: crate.id, tick: spawnTick - 1, edge: 'front' }]),
    ).toEqual([{ status: 'rejected', reason: 'not_on_table' }]);
    expect(server.ledger()).toHaveLength(entries);
    await expect(
      alice.client.call('cratesOpen', { body: { crateId: crate.id } }),
    ).rejects.toMatchObject({ code: 'not_ready' });
    expect(
      await claimAt([{ kind: 'crate', crateId: crate.id, tick: spawnTick, edge: 'front' }]),
    ).toEqual([{ status: 'accepted', credited: 0, cascade: null, minted: null }]);
    expect(server.ledger().length).toBeGreaterThan(entries);
    expect(
      await claimAt([{ kind: 'crate', crateId: crate.id, tick: spawnTick + 1, edge: 'front' }]),
    ).toEqual([{ status: 'rejected', reason: 'already_claimed' }]);
    await alice.client.call('cratesOpen', { body: { crateId: crate.id } });
    await claimFall(spawningCoin);
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
    travel();
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

describe('mock server: upgrade effects match the authoritative server', () => {
  const MS_PER_TICK = 1000 / MOCK_RULES.ticksPerSecond;
  const COPPER = coinTiers[0];

  function line(id: string) {
    const found = upgradeLines.find((candidate) => candidate.id === id);
    if (found === undefined) throw new Error(`Economy config has no ${id} line.`);
    return found;
  }

  function mockPlayer(player: Player = alice) {
    const found = server.world.player(requirePlayerId(player));
    if (found === undefined) throw new Error('Expected the mock to hold the player.');
    return found;
  }

  function venue() {
    const found = venues.find((candidate) => candidate.id === mockPlayer().venueId);
    if (found === undefined) throw new Error('Expected the player venue in the economy config.');
    return found;
  }

  /** Test setup only: puts a line at `level` without paying, to reach the top levels quickly. */
  function setLevel(lineId: string, level: number): void {
    const player = mockPlayer();
    player.levels.set(`${player.venueId}:${lineId}`, level);
  }

  async function buy(lineId: string, level: number) {
    return alice.client.call('upgradesBuy', { body: { venueId: venue().id, lineId, level } });
  }

  /** Wins coins the honest way: opening heap coins off the front lip, inside the fall envelope. */
  async function collectHeap(count: number): Promise<void> {
    const heap = (await state()).table.coins.slice(0, count);
    for (let i = 0; i < heap.length; i += 3) {
      time.advance(250);
      const tick = time.tick();
      for (const result of await claimAt(heap.slice(i, i + 3).map((coin) => fallAt(coin, tick)))) {
        if (result.status !== 'accepted') throw new Error(`Heap fall refused: ${result.reason}`);
      }
    }
  }

  async function dropFresh() {
    time.advance(100);
    return alice.client.call('tableDrop', { body: { x: 0, tick: time.tick() } });
  }

  async function dropAt(tick: number) {
    return alice.client.call('tableDrop', { body: { x: 0, tick } });
  }

  /** Drops `count` buffered coins and returns the 1-based drops that spawned a crate. */
  async function crateDrops(count: number): Promise<number[]> {
    const spawned: number[] = [];
    for (let i = 1; i <= count; i++) {
      time.advance(100);
      const coin = await bufferedCoin();
      const response = await alice.client.call('tableDrop', {
        body: { x: 0, tick: time.tick(), coinId: coin.id },
      });
      if (response.spawnedCrates.length > 0) spawned.push(i);
    }
    return spawned;
  }

  it('values the very next drop at a bought coinValue level, even from the buffer the client holds', async () => {
    const stale = (await state()).table.buffer;
    expect(stale.every((coin) => coin.value === mintedCoinValue(COPPER, venue(), {}))).toBe(true);
    await collectHeap(30);
    const coinValue = line('coinValue');
    const doubling = (2 - coinValue.effect.base) / coinValue.effect.perLevel;
    setLevel('coinValue', doubling - 1);
    const before = (await state()).wallet.coins;
    await buy('coinValue', doubling);
    expect((await state()).wallet.coins).toBe(before - upgradeCost(coinValue, doubling - 1));

    const upgraded = mintedCoinValue(COPPER, venue(), { coinValue: doubling });
    expect(upgraded).toBe(2 * mintedCoinValue(COPPER, venue(), {}));
    const staleCoin = stale[0];
    if (staleCoin === undefined) throw new Error('Expected a buffered coin.');
    time.advance(100);
    const dropTick = time.tick();
    const dropped = await alice.client.call('tableDrop', {
      body: { x: 0, tick: dropTick, coinId: staleCoin.id },
    });
    expect(dropped.coin).toMatchObject({ id: staleCoin.id, value: upgraded });
    expect(dropped.buffer.every((coin) => coin.value === upgraded)).toBe(true);
    const travelTicks = Math.ceil(MOCK_RULES.minFallMsAfterDrop / MS_PER_TICK);
    time.advance(MOCK_RULES.minFallMsAfterDrop + MS_PER_TICK);
    expect(await claimAt([fallAt(dropped.coin, dropTick + travelTicks)])).toEqual([
      { status: 'accepted', credited: upgraded, cascade: null, minted: null },
    ]);
    expectConserved();
  });

  it('mints at the top coinValue at the max level and refuses to go past it', async () => {
    await collectHeap(6);
    const coinValue = line('coinValue');
    setLevel('coinValue', coinValue.maxLevel);
    const top = mintedCoinValue(COPPER, venue(), { coinValue: coinValue.maxLevel });
    expect(top).toBe(
      Math.floor(COPPER.value * (1 + coinValue.effect.perLevel * coinValue.maxLevel)),
    );
    expect((await dropFresh()).coin.value).toBe(top);
    await expect(buy('coinValue', coinValue.maxLevel + 1)).rejects.toMatchObject({
      code: 'conflict',
    });
    expectConserved();
  });

  /** Puts coinValue at `level` the way a player gets there: the last level bought for real. */
  async function reachCoinValue(level: number): Promise<void> {
    if (level === 0) return;
    setLevel('coinValue', level - 1);
    await buy('coinValue', level);
  }

  /** Drops `count` buffered coins, lets each fall off the front, and returns what each paid. */
  async function dropAndCollect(count: number): Promise<number[]> {
    const credited: number[] = [];
    time.advance(MOCK_RULES.fallEnvelope.windowMs);
    for (let i = 0; i < count; i++) {
      const coin = await dropBuffered();
      time.advance(MOCK_RULES.minFallMsAfterDrop + Math.ceil(MS_PER_TICK));
      const [result] = await claimAt([fallAt(coin, time.tick())]);
      if (result?.status !== 'accepted') throw new Error(`Fall ${i} refused: ${result?.reason}`);
      expect(result.credited).toBe(coin.value);
      credited.push(result.credited);
    }
    return credited;
  }

  it('credits 5, 6, 7, 8, 9, 10 over five copper drops at coinValue levels 0..5, like the server', async () => {
    const totals: number[] = [];
    for (let level = 0; level <= 5; level++) {
      time = new FakeTime();
      server = createMockServer({ now: time.now });
      alice = await connectPlayer(server, time);
      await collectHeap(30);
      await reachCoinValue(level);
      totals.push((await dropAndCollect(5)).reduce((total, value) => total + value, 0));
      expectConserved();
    }
    expect(totals).toEqual([5, 6, 7, 8, 9, 10]);
  });

  it('reprices the buffer at purchase through the carry: L1 reads 1, 1, 1, 1, 2', async () => {
    await collectHeap(30);
    await reachCoinValue(1);
    expect((await state()).table.buffer.slice(0, 5).map((coin) => coin.value)).toEqual([
      1, 1, 1, 1, 2,
    ]);
    expect(await dropAndCollect(5)).toEqual([1, 1, 1, 1, 2]);
    expectConserved();
  });

  it('carries the fraction across the buffer refill: 20 drops at L2 credit floor(20 × 1.4)', async () => {
    await collectHeap(30);
    await reachCoinValue(2);
    const credited = await dropAndCollect(20);
    expect(credited.reduce((total, value) => total + value, 0)).toBe(28);
    expectConserved();
  });

  it('does not advance the carry for a replayed drop', async () => {
    await collectHeap(30);
    await reachCoinValue(1);
    const coin = await bufferedCoin();
    time.advance(100);
    const body = { x: 0, tick: time.tick(), coinId: coin.id };
    const key = newIdempotencyKey();
    const first = await alice.client.call('tableDrop', { body }, { idempotencyKey: key });
    const carry = mockPlayer().mintCarry;
    const buffer = (await state()).table.buffer;
    const again = await alice.client.call('tableDrop', { body }, { idempotencyKey: key });
    expect(again).toEqual(first);
    expect(mockPlayer().mintCarry).toBe(carry);
    expect((await state()).table.buffer).toEqual(buffer);
    expectConserved();
  });

  it('reprices the buffer once: a replayed purchase does not move the carry', async () => {
    await collectHeap(30);
    const key = newIdempotencyKey();
    const body = { venueId: venue().id, lineId: 'coinValue', level: 1 };
    await alice.client.call('upgradesBuy', { body }, { idempotencyKey: key });
    const carry = mockPlayer().mintCarry;
    const buffer = (await state()).table.buffer;
    await alice.client.call('upgradesBuy', { body }, { idempotencyKey: key });
    expect(mockPlayer().mintCarry).toBe(carry);
    expect((await state()).table.buffer).toEqual(buffer);
    expectConserved();
  });

  it('spawns crates at the FTUE drop and every dropsPerCrate drops at level 0', async () => {
    await collectHeap(30);
    expect(await crateDrops(crateSpawn.dropsPerCrate)).toEqual([
      crateSpawn.ftueScriptedDrop,
      crateSpawn.dropsPerCrate,
    ]);
    expectConserved();
  });

  it('spaces crates closer at the max crateChance level, on the same drops the server picks', async () => {
    await collectHeap(30);
    const top: UpgradeLevelMap = { crateChance: line('crateChance').maxLevel };
    setLevel('crateChance', line('crateChance').maxLevel);
    const every = crateSpawnInterval(top);
    expect(every).toBeLessThan(crateSpawn.dropsPerCrate);
    expect(await crateDrops(2 * every)).toEqual([crateSpawn.ftueScriptedDrop, every, 2 * every]);
    expectConserved();
  });

  it('grows the prepaid buffer on the next drop after a dropRate purchase, up to the max size', async () => {
    expect((await state()).table.buffer).toHaveLength(MOCK_RULES.bufferSize);
    await collectHeap(30);
    await buy('dropRate', 1);
    expect((await dropFresh()).buffer).toHaveLength(
      dropBufferTarget(MOCK_RULES.bufferSize, { dropRate: 1 }),
    );
    const dropRate = line('dropRate');
    setLevel('dropRate', dropRate.maxLevel);
    const size = dropBufferTarget(MOCK_RULES.bufferSize, { dropRate: dropRate.maxLevel });
    expect(size).toBeGreaterThan(MOCK_RULES.bufferSize);
    expect((await dropFresh()).buffer).toHaveLength(size);
    expectConserved();
  });

  it('lets drops come closer together only as far as dropRate allows', async () => {
    await collectHeap(9);
    const dropRate = line('dropRate');
    const fast = dropSpacingTicks(MOCK_RULES.minTicksBetweenDrops, {
      dropRate: dropRate.maxLevel,
    });
    expect(fast).toBeLessThan(MOCK_RULES.minTicksBetweenDrops);
    await dropFresh();
    const first = time.tick();
    time.advance(10 * MS_PER_TICK);
    await expect(dropAt(first + fast)).rejects.toMatchObject({ code: 'bad_request' });

    setLevel('dropRate', dropRate.maxLevel);
    await dropAt(first + fast);
    await expect(dropAt(first + 2 * fast - 1)).rejects.toMatchObject({ code: 'bad_request' });
    await dropAt(first + 2 * fast);
    expectConserved();
  });

  it('lets a dropped coin reach the edge sooner only as far as pusherSpeed allows', async () => {
    await collectHeap(6);
    const pusher = line('pusherSpeed');
    const base = Math.ceil(MOCK_RULES.minFallMsAfterDrop / MS_PER_TICK);
    const fast = pushTravelTicks(base, { pusherSpeed: pusher.maxLevel });
    expect(fast).toBeLessThan(base);

    const slow = await dropFresh();
    const slowTick = time.tick();
    time.advance(fast * MS_PER_TICK);
    expect(await claimAt([fallAt(slow.coin, slowTick + fast)])).toEqual([
      { status: 'rejected', reason: 'over_envelope' },
    ]);

    setLevel('pusherSpeed', pusher.maxLevel);
    const quick = await dropFresh();
    const quickTick = time.tick();
    time.advance(fast * MS_PER_TICK);
    expect(await claimAt([fallAt(quick.coin, quickTick + fast - 1)])).toEqual([
      { status: 'rejected', reason: 'over_envelope' },
    ]);
    expect(await claimAt([fallAt(quick.coin, quickTick + fast)])).toMatchObject([
      { status: 'accepted', credited: quick.coin.value },
    ]);
    expectConserved();
  });

  it('stretches the fall envelope with pusherSpeed the way the server rate envelope scales', async () => {
    const heap = (await state()).table.coins;
    const pusher = line('pusherSpeed');
    const scale = rateEnvelopeScale(rateEnvelope.falls, {
      levels: { pusherSpeed: pusher.maxLevel },
      venue: venue().id,
      charms: 0,
      albumBonus: 0,
    });
    const { max, maxPerTick } = MOCK_RULES.fallEnvelope;
    expect(Math.ceil(max * scale - 1e-9)).toBeGreaterThan(max + maxPerTick);

    const burst = async (from: number) => {
      time.advance(1_100);
      const start = time.tick();
      const statuses: string[] = [];
      for (let i = 0; i < max + maxPerTick; i += maxPerTick) {
        const tick = start + i / maxPerTick;
        const batch = heap.slice(from + i, from + i + maxPerTick);
        for (const result of await claimAt(batch.map((coin) => fallAt(coin, tick)))) {
          statuses.push(result.status === 'accepted' ? 'accepted' : result.reason);
        }
      }
      return statuses;
    };
    const slow = await burst(0);
    expect(slow.slice(0, max).every((status) => status === 'accepted')).toBe(true);
    expect(slow.slice(max)).toEqual(Array.from({ length: maxPerTick }, () => 'over_envelope'));

    setLevel('pusherSpeed', pusher.maxLevel);
    const fast = await burst(max + maxPerTick);
    expect(fast).toHaveLength(max + maxPerTick);
    expect(fast.every((status) => status === 'accepted')).toBe(true);
    expectConserved();
  });

  it('caps offline credit at the offlineHours level, up to the hard maximum', async () => {
    await state();
    const away = (offline.maxCapHours + 6) * 3_600_000;
    time.advance(away);
    expect((await state()).offline?.creditedMs).toBe(offline.baseCapHours * 3_600_000);

    const offlineLine = line('offlineHours');
    setLevel('offlineHours', 3);
    time.advance(away);
    expect((await state()).offline?.creditedMs).toBe(
      (offlineLine.effect.base + 3 * offlineLine.effect.perLevel) * 3_600_000,
    );

    setLevel('offlineHours', offlineLine.maxLevel);
    time.advance(away);
    const top = (await state()).offline;
    expect(top?.creditedMs).toBe(offline.maxCapHours * 3_600_000);
    expect(top?.coins).toBe(starterVaultCoins(offline.maxCapHours));
    expectConserved();
  });
});

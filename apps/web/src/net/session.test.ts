import { HEADERS, IdempotencyKeySchema } from '@coinposh/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MockServer } from './mock/server.ts';
import { MOCK_RULES } from './mock/rules.ts';
import {
  FakeTime,
  connectPlayer,
  createMockServer,
  ledgerWallet,
  requirePlayerId,
  serverWallet,
} from './test/harness.ts';
import type { WireRequest } from './wire.ts';

let time: FakeTime;
let server: MockServer;

beforeEach(() => {
  time = new FakeTime();
  server = createMockServer({ now: time.now });
});

const paths = (requests: readonly WireRequest[], path: string) =>
  requests.filter((request) => request.path === path);

describe('Session', () => {
  it('signs in once even when calls race for a token', async () => {
    const player = await connectPlayer(server, time);
    await Promise.all([
      player.client.call('state'),
      player.client.call('state'),
      player.client.call('eventsCurrent'),
    ]);
    expect(paths(player.requests, '/v1/auth/guest')).toHaveLength(1);
  });

  it('refreshes before the access token expires and keeps the same player', async () => {
    const player = await connectPlayer(server, time);
    await player.client.call('state');
    const id = requirePlayerId(player);
    time.advance(MOCK_RULES.accessTokenTtlMs);
    await player.client.call('state');
    expect(paths(player.requests, '/v1/auth/refresh')).toHaveLength(1);
    expect(paths(player.requests, '/v1/auth/guest')).toHaveLength(1);
    expect(requirePlayerId(player)).toBe(id);
  });

  it('re-authenticates when the server says the token expired, even if the client clock disagrees', async () => {
    const frozen = time.now();
    const player = await connectPlayer(server, time, { monotonic: () => frozen });
    await player.client.call('state');
    time.advance(MOCK_RULES.accessTokenTtlMs + 1);
    await expect(player.client.call('state')).resolves.toMatchObject({ serverTime: time.now() });
    expect(paths(player.requests, '/v1/auth/refresh')).toHaveLength(1);
    expect(paths(player.requests, '/v1/auth/guest')).toHaveLength(1);
  });

  it('resends a refresh whose answer was lost under the same key, so the account is not orphaned', async () => {
    const player = await connectPlayer(server, time);
    await player.client.call('state');
    const id = requirePlayerId(player);
    time.advance(MOCK_RULES.accessTokenTtlMs);
    server.setNetwork('dropResponses');
    await expect(player.client.call('state')).rejects.toMatchObject({ name: 'NetworkError' });
    server.setNetwork('up');
    await player.client.call('state');

    const refreshes = paths(player.requests, '/v1/auth/refresh');
    expect(refreshes.length).toBeGreaterThan(1);
    expect(new Set(refreshes.map((request) => request.headers[HEADERS.idempotencyKey])).size).toBe(
      1,
    );
    expect(paths(player.requests, '/v1/auth/guest')).toHaveLength(1);
    expect(requirePlayerId(player)).toBe(id);
  });

  it('falls back to one guest sign-in, not a loop, when the server will not replay a lost refresh', async () => {
    const player = await connectPlayer(server, time);
    await player.client.call('state');
    const id = requirePlayerId(player);
    time.advance(MOCK_RULES.accessTokenTtlMs);
    server.setNetwork('dropResponses');
    await expect(player.client.call('state')).rejects.toMatchObject({ name: 'NetworkError' });
    server.setNetwork('up');
    time.advance(MOCK_RULES.authRefreshReplayWindowMs + 1);
    const refreshesBefore = paths(player.requests, '/v1/auth/refresh').length;

    await player.client.call('state');
    await player.client.call('state');

    expect(paths(player.requests, '/v1/auth/refresh').length - refreshesBefore).toBe(1);
    expect(paths(player.requests, '/v1/auth/guest')).toHaveLength(2);
    expect(player.errors).toHaveLength(1);
    expect(player.errors[0]?.message).toMatch(/idempotency_key_reused/);
    expect(requirePlayerId(player)).toBe(id);
    expect(await player.store.get('session')).toMatchObject({ pendingKey: null });
  });

  it('survives a reload: the stored refresh token signs the same device back in', async () => {
    const first = await connectPlayer(server, time);
    await first.client.call('state');
    const reloaded = await connectPlayer(server, time, {
      store: first.store,
      device: first.device,
    });
    await reloaded.client.call('state');
    expect(paths(reloaded.requests, '/v1/auth/guest')).toHaveLength(0);
    expect(requirePlayerId(reloaded)).toBe(requirePlayerId(first));
    expect(reloaded.errors).toEqual([]);
  });

  it('reports a corrupt stored session before falling back to a new guest account', async () => {
    const first = await connectPlayer(server, time);
    await first.client.call('state');
    await first.store.set('session', { refreshToken: 42, pendingKey: 'not-a-key' });
    const reloaded = await connectPlayer(server, time, {
      store: first.store,
      device: first.device,
    });
    await reloaded.client.call('state');
    expect(reloaded.errors).toHaveLength(1);
    expect(reloaded.errors[0]?.message).toMatch(/unreadable stored session/);
    expect(paths(reloaded.requests, '/v1/auth/guest')).toHaveLength(1);
    expect(paths(reloaded.requests, '/v1/auth/refresh')).toHaveLength(0);
  });

  it('starts a first visit as a guest without reporting anything', async () => {
    const player = await connectPlayer(server, time);
    await player.client.call('state');
    expect(player.errors).toEqual([]);
    expect(paths(player.requests, '/v1/auth/guest')).toHaveLength(1);
  });
});

describe('ApiClient', () => {
  it('keeps one idempotency key across retries so a lost answer is replayed, not reapplied', async () => {
    const player = await connectPlayer(server, time);
    const { table } = await player.client.call('state');
    const coin = table.buffer[0];
    if (coin === undefined) throw new Error('Expected a buffered coin.');
    time.advance(100);
    const body = { x: 0, tick: time.tick(), coinId: coin.id };
    server.setNetwork('dropResponses');
    await expect(player.client.call('tableDrop', { body })).rejects.toMatchObject({
      name: 'NetworkError',
    });
    const drops = paths(player.requests, '/v1/table/drop');
    expect(drops).toHaveLength(3);
    const key = drops[0]?.headers[HEADERS.idempotencyKey];
    expect(drops.every((request) => request.headers[HEADERS.idempotencyKey] === key)).toBe(true);
    server.setNetwork('up');
    const ledgerBefore = server.ledger().length;
    const replayed = await player.client.call(
      'tableDrop',
      { body },
      { idempotencyKey: IdempotencyKeySchema.parse(key) },
    );
    expect(replayed.coin.id).toBe(coin.id);
    expect(server.ledger()).toHaveLength(ledgerBefore);
    const id = requirePlayerId(player);
    expect(ledgerWallet(server, id)).toEqual(serverWallet(server, id));
  });

  it('syncs the server clock from every answer and never sends it back', async () => {
    const player = await connectPlayer(server, time);
    time.advance(5_000);
    await player.client.call('eventsCurrent');
    expect(player.clock.now()).toBe(time.now());
    for (const request of player.requests)
      expect(request.body ?? '').not.toMatch(/serverTime|"value"|wallet|balance/);
  });

  it('does not retry a refusal the server will repeat', async () => {
    const player = await connectPlayer(server, time);
    await player.client.call('state');
    const before = player.requests.length;
    await expect(
      player.client.call('upgradesBuy', {
        body: { venueId: 'rivieraYacht', lineId: 'pusherSpeed', level: 1 },
      }),
    ).rejects.toMatchObject({ code: 'insufficient_funds' });
    expect(player.requests.length - before).toBe(1);
  });
});

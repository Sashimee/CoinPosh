import {
  endpoints,
  type ClaimsResponse,
  type DropResponse,
  type PlayerId,
  type StateQuery,
  type StateResponse,
  TableSessionIdSchema,
  type TableSessionId,
} from '@coinposh/shared';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect } from 'vitest';
import { guestSignIn, type Session } from './client.ts';

export function playerStub(playerId: PlayerId) {
  return env.PLAYER.get(env.PLAYER.idFromName(playerId));
}

export async function state(session: Session, query: StateQuery = {}): Promise<StateResponse> {
  const response = await session.call(
    query.hydrate === undefined
      ? endpoints.state.path
      : `${endpoints.state.path}?hydrate=${query.hydrate}`,
  );
  expect(response.status).toBe(200);
  return endpoints.state.response.parse(await response.json());
}

/**
 * The session holding the table's lease, as the tab that booted last sends it on every table
 * op. A player who never fetched state gets one the way a client does, by asking for state.
 */
export async function tableSession(session: Session): Promise<TableSessionId> {
  const current = await runInDurableObject(
    playerStub(session.tokens.playerId),
    (_do, ctx) =>
      ctx.storage.sql
        .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'table_session'")
        .toArray()[0]?.value,
  );
  if (current !== undefined) return TableSessionIdSchema.parse(current);
  const { table } = await state(session);
  if (table.session === undefined) throw new Error('state did not return a table session.');
  return table.session;
}

export async function drop(
  session: Session,
  body: { session?: string; x?: number; tick?: number; coinId?: string } = {},
): Promise<DropResponse> {
  const response = await session.call(endpoints.tableDrop.path, {
    body: { session: await tableSession(session), x: 0, tick: 0, ...body },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return endpoints.tableDrop.response.parse(await response.json());
}

/**
 * Drops `count` coins the way the client does: the oldest prepaid buffer coin first, and a coin
 * minted from the wallet once the buffer is dry.
 */
export async function dropAsClient(
  session: Session,
  count: number,
  tickOf: (index: number) => number = () => 0,
): Promise<DropResponse[]> {
  let buffer = (await state(session)).table.buffer;
  const responses: DropResponse[] = [];
  for (let i = 0; i < count; i++) {
    const reserved = buffer[0];
    const tick = tickOf(i);
    const response = await drop(
      session,
      reserved === undefined ? { tick } : { tick, coinId: reserved.id },
    );
    responses.push(response);
    buffer = response.buffer;
  }
  return responses;
}

/** What the Vault holds as the server sees it: the wallet plus what it prepaid for the buffer. */
export async function vaultCoins(session: Session): Promise<number> {
  const report = await playerStub(session.tokens.playerId).conservation();
  return report.walletCoins + report.bufferPaid;
}

export async function claims(session: Session, list: unknown[]): Promise<ClaimsResponse> {
  const response = await session.call(endpoints.tableClaims.path, {
    body: { session: await tableSession(session), claims: list },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return endpoints.tableClaims.response.parse(await response.json());
}

export async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const body: unknown = await response.json();
  expect(body).toMatchObject({ error: { code } });
}

export async function expectConserved(session: Session): Promise<void> {
  const report = await playerStub(session.tokens.playerId).conservation();
  expect(report).toMatchObject({ conserved: true });
}

/**
 * What a page reload does: sign in again, since the access token lived in memory, then lay the
 * table from a boot snapshot.
 */
export async function reload(session: Session): Promise<StateResponse> {
  expect((await guestSignIn(session.device)).status).toBe(200);
  return state(session, { hydrate: 'boot' });
}

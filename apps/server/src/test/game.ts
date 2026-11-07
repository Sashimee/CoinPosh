import {
  endpoints,
  type ClaimsResponse,
  type DropResponse,
  type PlayerId,
  type StateResponse,
} from '@coinposh/shared';
import { env } from 'cloudflare:workers';
import { expect } from 'vitest';
import type { Session } from './client.ts';

export function playerStub(playerId: PlayerId) {
  return env.PLAYER.get(env.PLAYER.idFromName(playerId));
}

export async function state(session: Session): Promise<StateResponse> {
  const response = await session.call(endpoints.state.path);
  expect(response.status).toBe(200);
  return endpoints.state.response.parse(await response.json());
}

export async function drop(
  session: Session,
  body: { x?: number; tick?: number; coinId?: string } = {},
): Promise<DropResponse> {
  const response = await session.call(endpoints.tableDrop.path, {
    body: { x: 0, tick: 0, ...body },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return endpoints.tableDrop.response.parse(await response.json());
}

export async function claims(session: Session, list: unknown[]): Promise<ClaimsResponse> {
  const response = await session.call(endpoints.tableClaims.path, { body: { claims: list } });
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

import { tableSnapshotEndpoint, type StateResponse } from '@coinposh/shared';
import { expect, it } from 'vitest';
import type { MockServer } from '../mock/server.ts';
import { SNAPSHOT_FLAG_KINDS, SNAPSHOT_RATE } from '../mock/snapshot.ts';
import { newIdempotencyKey } from '../request.ts';
import {
  FakeTime,
  connectPlayer,
  createMockServer,
  forge,
  ledgerWallet,
  requirePlayerId,
  serverWallet,
  type Player,
} from '../test/harness.ts';
import {
  CONTRACT_FLAG_KINDS,
  CONTRACT_SNAPSHOT_RATE,
  tableSnapshotContract,
  type ContractPlayer,
  type SnapshotContractDriver,
} from './tableSnapshot.contract.ts';

interface MockContractPlayer extends ContractPlayer {
  readonly server: MockServer;
  readonly time: FakeTime;
}

async function mockPlayer(server: MockServer, time: FakeTime): Promise<MockContractPlayer> {
  const player: Player = await connectPlayer(server, time);
  const id = () => requirePlayerId(player);
  const record = () => {
    const found = server.world.player(id());
    if (found === undefined) throw new Error('The mock lost the contract player.');
    return found;
  };
  const table = async (hydrate: boolean): Promise<StateResponse['table']> =>
    (await player.client.call('state', hydrate ? { query: { hydrate: 'boot' } } : undefined)).table;
  return {
    server,
    time,
    boot: () => table(true),
    state: () => table(false),
    async upload(body, key) {
      const response = await forge(server, player.device, {
        method: 'POST',
        path: tableSnapshotEndpoint.path,
        body: JSON.stringify(body),
        key: key ?? newIdempotencyKey(),
        token: await player.session.accessToken(),
      });
      return { status: response.status, body: response.body };
    },
    newKey: newIdempotencyKey,
    elapse(ms) {
      time.advance(ms);
      return Promise.resolve();
    },
    stored() {
      const snapshot = record().tableSnapshot;
      return Promise.resolve(
        snapshot === null ? null : { seq: snapshot.seq, poses: snapshot.poses },
      );
    },
    flags: () => Promise.resolve({ ...record().snapshotFlags }),
    economy() {
      const player = record();
      return Promise.resolve(
        structuredClone({
          ledger: server.ledger().filter((entry) => entry.playerId === player.id).length,
          wallet: player.wallet,
          coins: [...player.coins.values()].map((coin) => [coin.coin.id, coin.place, coin.coin]),
          crates: [...player.crates.values()].map((crate) => [crate.crate.id, crate.state]),
          drops: [player.drops, player.dropHighWater],
        }),
      );
    },
    expectConserved() {
      expect(ledgerWallet(server, id())).toEqual(serverWallet(server, id()));
      return Promise.resolve();
    },
  };
}

const mockDriver = (): SnapshotContractDriver => ({
  async newPlayer(alongside) {
    if (alongside !== undefined) {
      const { server, time } = alongside as MockContractPlayer;
      return mockPlayer(server, time);
    }
    const time = new FakeTime();
    return mockPlayer(createMockServer({ now: time.now }), time);
  },
});

it('mirrors the contract rate and flag kinds in the Demo Mode mock', () => {
  expect(SNAPSHOT_RATE).toEqual(CONTRACT_SNAPSHOT_RATE);
  expect(SNAPSHOT_FLAG_KINDS).toEqual(CONTRACT_FLAG_KINDS);
});

tableSnapshotContract('Demo Mode mock', mockDriver);

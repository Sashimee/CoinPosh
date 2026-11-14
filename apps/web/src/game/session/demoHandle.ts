import type { CoinId, CratePoseTuple, PlayerId, PoseTuple, Wallet } from '@coinposh/shared';
import { POSITION_UNIT } from '@coinposh/sim/snapshot';
import type { MockServer } from '../../net/mock/server.ts';
import type { SimBridgeSnapshot } from '../simWorker/index.ts';

const BOOT_REFUND_REASON = 'refund.table';

export interface DemoStoredSnapshot {
  readonly seq: number;
  readonly tick: number;
  readonly coins: PoseTuple[];
  readonly crates: CratePoseTuple[];
}

export interface DemoSnapshots {
  /** Table snapshots the mock accepted from this player since the page loaded. */
  readonly accepted: number;
  /** What a boot would lay from now; a boot stores its own layout as seq 0. */
  readonly last: DemoStoredSnapshot | null;
}

/** A coin on the sim's table, in POSITION_UNIT like the stored PoseTuples. */
export interface DemoPose {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * `window.__coinposh.demo`: drives the Demo server the way a re-boot or a second tab would, so
 * end-to-end checks can prove the table survives both. It exists only in Demo Mode.
 */
export interface DemoHandle {
  /** Metres per unit of every position this handle reports. */
  readonly positionUnit: number;
  /** Boots the table again in this page, as "Play here" does, without the overlay. */
  reboot(): Promise<void>;
  /**
   * Boots the table as a second tab of this player would. The mock fences drops, claims and
   * snapshot uploads by table session, so this page's next one is refused and the overlay shows.
   */
  bootElsewhere(): Promise<void>;
  snapshots(): DemoSnapshots;
  /** Boot refunds the mock's ledger holds for this player. */
  refunds(): number;
  /** The player's wallet as the mock holds it. */
  wallet(): Wallet;
  /** Where the sim's coins are now, each named by the server coin it stands for. */
  poses(): Promise<DemoPose[]>;
}

export interface DemoHandleDeps {
  readonly mock: Pick<MockServer, 'world' | 'ledger' | 'bootElsewhere'>;
  /** The player this page signed in as. */
  readonly player: () => PlayerId | null;
  /** The "Play here" retake: a ready sim, `hydrate=boot`, lay, play. */
  readonly retake: () => Promise<void>;
  /** True while another client holds the table and the overlay is up. */
  readonly superseded: () => boolean;
  /** One sample of the table in play (`SimBridge.snapshot`). */
  readonly sample: () => Promise<SimBridgeSnapshot>;
  readonly coinOf: (simId: number) => CoinId | null;
}

export function createDemoHandle(deps: DemoHandleDeps): DemoHandle {
  let rebooting: Promise<void> | null = null;

  const playerId = (): PlayerId => {
    const id = deps.player();
    if (id === null) {
      throw new Error(
        'CoinPosh demo handle: this page has not signed in to the Demo server yet; wait for window.__coinposh.playable.',
      );
    }
    return id;
  };

  const mockPlayer = () => {
    const id = playerId();
    const found = deps.mock.world.player(id);
    if (found === undefined) {
      throw new Error(`CoinPosh demo handle: the Demo server has no player ${id}.`);
    }
    return found;
  };

  return {
    positionUnit: POSITION_UNIT,
    reboot() {
      if (deps.superseded()) {
        return Promise.reject(
          new Error(
            'CoinPosh demo handle: the table is open elsewhere; press "Play here" to take it back instead of reboot().',
          ),
        );
      }
      rebooting ??= deps.retake().finally(() => {
        rebooting = null;
      });
      return rebooting;
    },
    async bootElsewhere() {
      await deps.mock.bootElsewhere(playerId());
    },
    snapshots() {
      const stored = mockPlayer().tableSnapshot;
      return {
        accepted: deps.mock.world.acceptedSnapshots(playerId()),
        last:
          stored === null
            ? null
            : {
                seq: stored.seq,
                tick: stored.tick,
                coins: stored.poses.map((pose) => [...pose] as PoseTuple),
                crates: stored.cratePoses.map((pose) => [...pose] as CratePoseTuple),
              },
      };
    },
    refunds() {
      const id = playerId();
      return deps.mock
        .ledger()
        .filter((entry) => entry.playerId === id && entry.reason === BOOT_REFUND_REASON).length;
    },
    wallet() {
      return { ...mockPlayer().wallet };
    },
    async poses() {
      const { table } = await deps.sample();
      const poses: DemoPose[] = [];
      for (const coin of table.coins) {
        const id = deps.coinOf(coin.id);
        if (id === null) continue;
        const [x, y, z] = coin.p;
        poses.push({ id, x, y, z });
      }
      return poses;
    },
  };
}

/** Where a page keeps its Demo handle: `window.__coinposh.demo` reads it back. */
export interface DemoHandleTarget {
  demo?: DemoHandle | undefined;
}

/**
 * Puts a Demo handle on `target` when the page runs against the in-browser server, and returns
 * the way to take it off again. With a live API there is no mock, so nothing is installed and
 * the page exposes no way to act on the table.
 */
export function installDemoHandle(
  target: DemoHandleTarget,
  mock: DemoHandleDeps['mock'] | null,
  deps: Omit<DemoHandleDeps, 'mock'>,
): (() => void) | null {
  if (mock === null) return null;
  const handle = createDemoHandle({ ...deps, mock });
  target.demo = handle;
  return () => {
    if (target.demo === handle) delete target.demo;
  };
}

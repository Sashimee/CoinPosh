import { openingHeap } from '@coinposh/economy';
import type { CratePlacement, MintedCoin, StateResponse, TableCrate } from '@coinposh/shared';
import type { SimOptions } from '@coinposh/sim';

type SimRestore = NonNullable<SimOptions['restore']>;
type RestoreEntry = SimRestore['coins'][number];

/** A booted table as the sim lays it: coin `i` of the restore is `table.coins[i]`. */
export interface OpeningLayout {
  readonly restore: SimRestore;
  readonly coins: readonly MintedCoin[];
  readonly crates: readonly { readonly crate: TableCrate; readonly placement: CratePlacement }[];
}

/**
 * Lays a `hydrate=boot` state's table from its `layout`: each coin from the pose the server
 * stored and checked, or at its opening heap slot, with the tier the server minted it at. Throws
 * on a state that is not a boot, since only a boot's coins match the poses one to one.
 */
export function openingLayout(state: StateResponse): OpeningLayout {
  const layout = state.table.layout;
  if (layout === null || layout === undefined) {
    throw new Error(
      'CoinPosh boot: this table snapshot has no layout; fetch the state with hydrate=boot to lay the table.',
    );
  }
  const { coins, crates } = state.table;
  if (layout.coins.length !== coins.length || layout.crates.length !== crates.length) {
    throw new Error(
      `CoinPosh boot: the layout places ${layout.coins.length} coins and ${layout.crates.length} crates but the table lists ${coins.length} and ${crates.length}; reload to fetch a consistent boot.`,
    );
  }
  const entries = layout.coins.map((placement, i): RestoreEntry => {
    const coin = coins[i];
    if (coin === undefined) {
      throw new Error(`CoinPosh boot: layout.coins[${i}] places a coin the table does not list.`);
    }
    if (placement.kind === 'heapSlot') {
      return { kind: 'heapSlot', slot: placement.slot, tier: coin.tier };
    }
    const [, x, y, z, qx, qy, qz, qw, rest] = placement.pose;
    return {
      kind: 'pose',
      pose: { id: i, p: [x, y, z], q: [qx, qy, qz, qw], rest },
      tier: coin.tier,
    };
  });
  return {
    restore: { pusherTickInCycle: layout.pusher.tickInCycle, coins: entries },
    coins,
    crates: layout.crates.map((placement, i) => {
      const crate = crates[i];
      if (crate === undefined) {
        throw new Error(
          `CoinPosh boot: layout.crates[${i}] places a crate the table does not list.`,
        );
      }
      return { crate, placement };
    }),
  };
}

/**
 * The server coins the sim lays as its opening heap, in sim id order. Demo Mode's mock and the
 * live server both mint the heap onto the table at sign-up and list it first, so the sim's
 * heap coin `i` is the snapshot's `i`th coin and its fall is claimed by that coin's ID. The
 * live server refunds every other table coin on a `hydrate=boot` snapshot, so a boot snapshot
 * holds nothing else; a coin that is not heap tier means it did not, and that coin would sit
 * on the server unclaimable.
 */
export function openingTableCoins(state: StateResponse): readonly MintedCoin[] {
  const stray = state.table.coins.find((coin) => coin.tier !== openingHeap.tier);
  if (stray !== undefined) {
    throw new Error(
      `CoinPosh boot: the table snapshot holds a ${stray.tier} coin (${stray.id}) beside the ${openingHeap.tier} opening heap, and the sim can only lay the heap. The server should have refunded it for this hydrate=boot snapshot (PlayerDO.refundStranded).`,
    );
  }
  return state.table.coins;
}

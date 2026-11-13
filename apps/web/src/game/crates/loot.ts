import { album, pity as pityConfig, RARITY_IDS, rarityRank } from '@coinposh/economy';
import type { AlbumResponse, Currency, PityCounters, Rarity, Reward } from '@coinposh/shared';
import type { UnboxHero } from '../../vfx/cinematics/unbox/stage.ts';

export interface PityOutlook {
  readonly rarity: Rarity & keyof PityCounters;
  /** Opens left until a crate of this rarity or better is guaranteed; 1 means the next open. */
  readonly within: number;
}

/**
 * The nearest guarantee the server's counters promise, read against the economy's pity rules.
 * `rollDrop` forces a rule's floor once its counter has `within - 1` misses, so the forced
 * crate is open number `within - misses` from now. Pass the crate just opened to leave out the
 * floors it met itself; null then means it met every one. The client never rolls: this only
 * tells the player what the server has already committed to.
 */
export function pityOutlook(
  counters: PityCounters,
  opened: Rarity | null = null,
): PityOutlook | null {
  let best: PityOutlook | null = null;
  for (const rule of pityConfig.rules) {
    const misses = counters[rule.rarity];
    if (misses >= rule.within) {
      throw new RangeError(
        `Server pity counter for ${rule.rarity} is ${misses}, past its ${rule.within}-open guarantee; the roll that should have forced it did not`,
      );
    }
    if (opened !== null && rarityRank(opened) >= rarityRank(rule.rarity)) continue;
    const within = rule.within - misses;
    if (best === null || within < best.within) best = { rarity: rule.rarity, within };
  }
  return best;
}

export type AlbumItemId = (typeof album)[number]['items'][number]['id'];
export type AlbumSetKey = (typeof album)[number]['id'];

/** Where an album entry sits in the economy catalogue: its rarity and the set it completes. */
export interface AlbumPlace {
  readonly item: AlbumItemId;
  readonly rarity: Rarity;
  readonly set: AlbumSetKey;
}

const ALBUM_PLACES: ReadonlyMap<string, AlbumPlace> = new Map(
  album.flatMap((set) =>
    set.items.map((item): [string, AlbumPlace] => [
      item.id,
      { item: item.id, rarity: item.rarity, set: set.id },
    ]),
  ),
);

export function albumPlace(id: string): AlbumPlace {
  const place = ALBUM_PLACES.get(id);
  if (place === undefined) {
    throw new RangeError(
      `The server granted album entry "${id}", which the economy album does not list; ship the client with the server's packages/economy catalogue`,
    );
  }
  return place;
}

export type RewardLine =
  | { readonly kind: 'currency'; readonly currency: Currency; readonly amount: number }
  | ({ readonly kind: 'charm'; readonly level: number; readonly duplicate: boolean } & AlbumPlace)
  | { readonly kind: 'safe' }
  | { readonly kind: 'scratchCard' }
  | ({ readonly kind: 'collectible' } & AlbumPlace);

/** Entries owned against entries in the set, as the server's album reports them. */
export interface AlbumProgress {
  readonly owned: number;
  readonly total: number;
}

/** Set progress for each album card in a roll, keyed by collectible id. */
export type AlbumProgressMap = Readonly<Record<string, AlbumProgress>>;

export function rollHasAlbumCard(rewards: readonly Reward[]): boolean {
  return rewards.some((reward) => reward.kind === 'collectible');
}

/** Reads the server's album after an open: the progress of each set a rolled card belongs to. */
export function albumProgress(
  response: AlbumResponse,
  rewards: readonly Reward[],
): AlbumProgressMap {
  const progress: Record<string, AlbumProgress> = {};
  for (const reward of rewards) {
    if (reward.kind !== 'collectible') continue;
    const id = reward.collectibleId;
    const set = response.sets.find((candidate) =>
      candidate.entries.some((entry) => entry.id === id),
    );
    if (set === undefined) {
      throw new RangeError(
        `The server granted album card "${id}" but its album lists no set holding it; the album and crate endpoints disagree`,
      );
    }
    progress[id] = {
      owned: set.entries.filter((entry) => entry.owned).length,
      total: set.entries.length,
    };
  }
  return progress;
}

const CURRENCY_ORDER: readonly Currency[] = [
  'coins',
  'pearls',
  'keys',
  'tickets',
  'stars',
  'bullion',
  'goldBars',
];

type ItemLine = Exclude<RewardLine, { readonly kind: 'currency' }>;

const ITEM_KIND_ORDER: readonly ItemLine['kind'][] = [
  'charm',
  'safe',
  'collectible',
  'scratchCard',
];

/** Safes and scratch cards carry no album rarity, so they stand with the lowest tier. */
function itemRank(line: ItemLine): number {
  return rarityRank('rarity' in line ? line.rarity : RARITY_IDS[0]);
}

function compareItems(a: ItemLine, b: ItemLine): number {
  return (
    itemRank(b) - itemRank(a) || ITEM_KIND_ORDER.indexOf(a.kind) - ITEM_KIND_ORDER.indexOf(b.kind)
  );
}

function itemLine(reward: Exclude<Reward, { readonly kind: 'currency' }>): ItemLine {
  switch (reward.kind) {
    case 'charm':
      return {
        kind: 'charm',
        level: reward.level,
        duplicate: reward.duplicate,
        ...albumPlace(reward.charmType),
      };
    case 'collectible':
      return { kind: 'collectible', ...albumPlace(reward.collectibleId) };
    case 'safe':
    case 'scratchCard':
      return { kind: reward.kind };
  }
}

/** Item lines rarest first, so the jackpot of a roll heads the card; display order only. */
function itemLines(rewards: readonly Reward[]): readonly ItemLine[] {
  return rewards
    .flatMap((reward) => (reward.kind === 'currency' ? [] : [itemLine(reward)]))
    .sort(compareItems);
}

/** One line per reward: items rarest first (they are the headline), then currencies merged and ordered. */
export function rewardLines(rewards: readonly Reward[]): readonly RewardLine[] {
  const totals = new Map<Currency, number>();
  for (const reward of rewards) {
    if (reward.kind === 'currency') {
      totals.set(reward.currency, (totals.get(reward.currency) ?? 0) + reward.amount);
    }
  }
  const currencies = CURRENCY_ORDER.flatMap((currency): RewardLine[] => {
    const amount = totals.get(currency);
    return amount === undefined ? [] : [{ kind: 'currency', currency, amount }];
  });
  return [...itemLines(rewards), ...currencies];
}

const ITEM_HEROES: Readonly<Record<ItemLine['kind'], UnboxHero>> = {
  charm: 'charm',
  safe: 'safe',
  collectible: 'card',
  scratchCard: 'card',
};

/** What spins on the pedestal: the rarest item in the roll, the same one that heads its card. */
export function heroOf(rewards: readonly Reward[]): UnboxHero {
  const [headline] = itemLines(rewards);
  if (headline !== undefined) return ITEM_HEROES[headline.kind];
  const currencies = new Set(
    rewards.flatMap((reward) => (reward.kind === 'currency' ? [reward.currency] : [])),
  );
  if (currencies.has('keys')) return 'keys';
  if (currencies.has('pearls')) return 'pearls';
  if (currencies.has('tickets')) return 'tickets';
  return 'coins';
}

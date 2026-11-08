import { pity as pityConfig } from '@coinposh/economy';
import type { Currency, PityCounters, Rarity, Reward } from '@coinposh/shared';
import type { UnboxHero } from '../../vfx/cinematics/unbox/stage.ts';

export interface PityOutlook {
  readonly rarity: Rarity & keyof PityCounters;
  /** Opens left until this rarity or better is guaranteed; 1 means the next crate. */
  readonly within: number;
}

/**
 * The nearest guarantee the server's counters promise, read against the economy's pity rules.
 * The client never rolls: this only tells the player what the server has already committed to.
 */
export function pityOutlook(counters: PityCounters): PityOutlook {
  let best: PityOutlook | null = null;
  for (const rule of pityConfig.rules) {
    const misses = counters[rule.rarity];
    if (misses >= rule.within) {
      throw new RangeError(
        `Server pity counter for ${rule.rarity} is ${misses}, past its ${rule.within}-open guarantee; the roll that should have forced it did not`,
      );
    }
    const within = rule.within - misses;
    if (best === null || within < best.within) best = { rarity: rule.rarity, within };
  }
  if (best === null) throw new Error('Economy pity config has no rules; crates need at least one');
  return best;
}

export type RewardLine =
  | { readonly kind: 'currency'; readonly currency: Currency; readonly amount: number }
  | { readonly kind: 'charm'; readonly level: number; readonly duplicate: boolean }
  | { readonly kind: 'safe' }
  | { readonly kind: 'scratchCard' }
  | { readonly kind: 'collectible' };

const CURRENCY_ORDER: readonly Currency[] = [
  'coins',
  'pearls',
  'keys',
  'tickets',
  'stars',
  'bullion',
  'goldBars',
];

/** One line per reward, items first (they are the headline), currencies merged and ordered. */
export function rewardLines(rewards: readonly Reward[]): readonly RewardLine[] {
  const totals = new Map<Currency, number>();
  const items: RewardLine[] = [];
  for (const reward of rewards) {
    switch (reward.kind) {
      case 'currency':
        totals.set(reward.currency, (totals.get(reward.currency) ?? 0) + reward.amount);
        break;
      case 'charm':
        items.push({ kind: 'charm', level: reward.level, duplicate: reward.duplicate });
        break;
      case 'safe':
      case 'scratchCard':
      case 'collectible':
        items.push({ kind: reward.kind });
        break;
    }
  }
  const currencies = CURRENCY_ORDER.flatMap((currency): RewardLine[] => {
    const amount = totals.get(currency);
    return amount === undefined ? [] : [{ kind: 'currency', currency, amount }];
  });
  return [...items, ...currencies];
}

/** What spins on the pedestal: the rarest kind of thing in the roll. */
export function heroOf(rewards: readonly Reward[]): UnboxHero {
  const kinds = new Set(rewards.map((reward) => reward.kind));
  if (kinds.has('charm')) return 'charm';
  if (kinds.has('safe')) return 'safe';
  if (kinds.has('collectible') || kinds.has('scratchCard')) return 'card';
  const currencies = new Set(
    rewards.flatMap((reward) => (reward.kind === 'currency' ? [reward.currency] : [])),
  );
  if (currencies.has('keys')) return 'keys';
  if (currencies.has('pearls')) return 'pearls';
  if (currencies.has('tickets')) return 'tickets';
  return 'coins';
}

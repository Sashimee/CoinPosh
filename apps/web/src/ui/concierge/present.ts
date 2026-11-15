import { COIN_TIERS, RARITIES, type CoinTier, type Rarity } from '@coinposh/shared';
import type {
  ConciergeLine,
  ConciergeLineId,
  ConciergeParams,
} from '../../game/concierge/index.ts';
import { formatInteger, type I18n } from '../../i18n/index.ts';
import { conciergeKey, lineKey } from './i18n.ts';

export const CONCIERGE_PLACEHOLDERS = [
  'coins',
  'seconds',
  'tier',
  'rarity',
  'upgrade',
  'level',
  'venue',
] as const;
export type ConciergePlaceholder = (typeof CONCIERGE_PLACEHOLDERS)[number];

/**
 * What each line's copy may interpolate, read off the params its rule sends (rules.ts). A variant
 * may use fewer; one that uses another would print a raw `{{name}}` on the card.
 */
export const LINE_PLACEHOLDERS: Readonly<Record<ConciergeLineId, readonly ConciergePlaceholder[]>> =
  {
    'greeting.firstCascade': [],
    'cascade.chic': ['coins'],
    'cascade.lavish': ['coins'],
    'cascade.opulent': ['coins'],
    'cascade.decadent': ['coins'],
    'cascade.obscene': [],
    'fusion.first': ['tier'],
    'fusion.minor': ['tier'],
    'fusion.platinum': ['tier'],
    'fusion.diamond': ['tier'],
    'fusion.heirloom': ['tier'],
    'pour.perfect': [],
    'decorum.warning': [],
    'decorum.freeze': ['seconds'],
    'decorum.stillFrozen': [],
    'tip.aimCentre': [],
    'crate.arrived': [],
    'reward.modest': ['rarity'],
    'reward.rare': ['rarity'],
    'reward.legendary': ['rarity'],
    'vault.empty': [],
    'vault.welcomeBack': ['coins'],
    'vault.capped': ['coins'],
    'tip.upgradeAffordable': ['upgrade'],
    'upgrade.purchased': ['upgrade', 'level'],
    'tip.feedTower': [],
    'tower.wobbling': [],
    'tip.idle': [],
    'ascension.arrived': ['venue'],
  };

function isCoinTier(value: unknown): value is CoinTier {
  return typeof value === 'string' && (COIN_TIERS as readonly string[]).includes(value);
}

function isRarity(value: unknown): value is Rarity {
  return typeof value === 'string' && (RARITIES as readonly string[]).includes(value);
}

/**
 * A name another namespace owns (upgrade lines and venues live in `ui`), or the house's polite
 * stand-in when the id is one that namespace has never heard of.
 */
function borrowedName(i18n: I18n, key: string, fallback: string, id: string): string {
  if (i18n.exists(key)) return i18n.t(key);
  console.warn(`[CoinPosh] the Concierge has no name for "${id}" (${key}); it says "${fallback}"`);
  return fallback;
}

/** Turns a rule's raw params (ids, counts) into the words and numbers the copy prints. */
export function lineValues(i18n: I18n, params: ConciergeParams): Record<string, string> {
  const values: Record<string, string> = {};
  const number = (value: string | number): string =>
    typeof value === 'number' ? formatInteger(value, i18n.language) : value;
  const { count, coins, seconds, level, tier, rarity, upgrade, venue } = params;
  const haul = coins ?? count;
  if (haul !== undefined) values.coins = number(haul);
  if (seconds !== undefined) values.seconds = number(seconds);
  if (level !== undefined) values.level = number(level);
  if (isCoinTier(tier)) values.tier = i18n.t(conciergeKey(`names.coin.${tier}`));
  if (isRarity(rarity)) values.rarity = i18n.t(conciergeKey(`names.rarity.${rarity}`));
  if (upgrade !== undefined) {
    const id = String(upgrade);
    values.upgrade = borrowedName(
      i18n,
      `ui:upgrades.line.${id}.name`,
      i18n.t(conciergeKey('names.upgradeFallback')),
      id,
    );
  }
  if (venue !== undefined) {
    const id = String(venue);
    values.venue = borrowedName(
      i18n,
      `ui:venue.${id}`,
      i18n.t(conciergeKey('names.venueFallback')),
      id,
    );
  }
  return values;
}

/** The words on the card for one spoken line, in the active language. */
export function lineText(
  i18n: I18n,
  line: Pick<ConciergeLine, 'lineId' | 'variant' | 'params'>,
): string {
  return i18n.t(lineKey(line.lineId, line.variant), lineValues(i18n, line.params));
}

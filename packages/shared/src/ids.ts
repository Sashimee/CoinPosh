import { z } from 'zod';

const ENTITY_ID_BODY = '[0-9A-Za-z]{8,32}';
/** Every config key in `packages/economy`: lower camel or kebab words, joined by `-_.:`. */
export const CATALOG_KEY = /^[a-z][a-zA-Z0-9]*(?:[-_.:][a-zA-Z0-9]+)*$/;
export const CATALOG_KEY_MAX_LENGTH = 64;

/**
 * Server-minted entity IDs carry a kind prefix (`coin_…`, `crate_…`) so an ID of one
 * kind can never parse as another, at runtime as well as at the type level.
 */
function entityId<const Brand extends string>(prefix: string, brand: Brand) {
  return z
    .string()
    .regex(
      new RegExp(`^${prefix}_${ENTITY_ID_BODY}$`),
      `Expected a ${brand} like "${prefix}_" followed by 8 to 32 letters or digits.`,
    )
    .brand<Brand>();
}

/** Keys defined by `packages/economy` config (venues, upgrade lines, charm types, …). */
function catalogKey<const Brand extends string>(brand: Brand) {
  return z
    .string()
    .max(CATALOG_KEY_MAX_LENGTH)
    .regex(
      CATALOG_KEY,
      `Expected a ${brand}: a config key such as "rivieraYacht" or "pusher-speed".`,
    )
    .brand<Brand>();
}

/** Any config key, for keys that have no branded kind of their own (sources, sinks, stats). */
export const CatalogKeySchema = catalogKey('CatalogKey');
export type CatalogKey = z.infer<typeof CatalogKeySchema>;

/** In unlock order: each Ascension opens the next venue. */
export const VENUE_IDS = [
  'rivieraYacht',
  'salonDeParis',
  'tokyoPenthouse',
  'alpineChalet',
  'orbitalCasino',
] as const;

export const ENTITY_ID_PREFIXES = {
  coin: 'coin',
  crate: 'crate',
  safe: 'safe',
  charm: 'charm',
  scratchCard: 'scratch',
  quest: 'quest',
  season: 'season',
  event: 'event',
  tableSession: 'session',
} as const;

export const PlayerIdSchema = z.uuid().brand<'PlayerId'>();
export type PlayerId = z.infer<typeof PlayerIdSchema>;

export const CoinIdSchema = entityId(ENTITY_ID_PREFIXES.coin, 'CoinId');
export type CoinId = z.infer<typeof CoinIdSchema>;

export const CrateIdSchema = entityId(ENTITY_ID_PREFIXES.crate, 'CrateId');
export type CrateId = z.infer<typeof CrateIdSchema>;

export const SafeIdSchema = entityId(ENTITY_ID_PREFIXES.safe, 'SafeId');
export type SafeId = z.infer<typeof SafeIdSchema>;

/** One owned charm instance; its kind is a {@link CharmTypeId}. */
export const CharmIdSchema = entityId(ENTITY_ID_PREFIXES.charm, 'CharmId');
export type CharmId = z.infer<typeof CharmIdSchema>;

export const ScratchCardIdSchema = entityId(ENTITY_ID_PREFIXES.scratchCard, 'ScratchCardId');
export type ScratchCardId = z.infer<typeof ScratchCardIdSchema>;

export const QuestIdSchema = entityId(ENTITY_ID_PREFIXES.quest, 'QuestId');
export type QuestId = z.infer<typeof QuestIdSchema>;

export const SeasonIdSchema = entityId(ENTITY_ID_PREFIXES.season, 'SeasonId');
export type SeasonId = z.infer<typeof SeasonIdSchema>;

export const EventIdSchema = entityId(ENTITY_ID_PREFIXES.event, 'EventId');
export type EventId = z.infer<typeof EventIdSchema>;

/** Rotated by every boot; the newest boot owns the table and older sessions are fenced off. */
export const TableSessionIdSchema = entityId(ENTITY_ID_PREFIXES.tableSession, 'TableSessionId');
export type TableSessionId = z.infer<typeof TableSessionIdSchema>;

export const VenueIdSchema = z.enum(VENUE_IDS);
export type VenueId = z.infer<typeof VenueIdSchema>;

export const UpgradeLineIdSchema = catalogKey('UpgradeLineId');
export type UpgradeLineId = z.infer<typeof UpgradeLineIdSchema>;

export const CharmTypeIdSchema = catalogKey('CharmTypeId');
export type CharmTypeId = z.infer<typeof CharmTypeIdSchema>;

export const SafeTypeIdSchema = catalogKey('SafeTypeId');
export type SafeTypeId = z.infer<typeof SafeTypeIdSchema>;

export const AlbumSetIdSchema = catalogKey('AlbumSetId');
export type AlbumSetId = z.infer<typeof AlbumSetIdSchema>;

/** An album entry: a coin skin, a charm type or a named Heirloom coin. */
export const CollectibleIdSchema = catalogKey('CollectibleId');
export type CollectibleId = z.infer<typeof CollectibleIdSchema>;

export const QuestTemplateIdSchema = catalogKey('QuestTemplateId');
export type QuestTemplateId = z.infer<typeof QuestTemplateIdSchema>;

export const BoardIdSchema = catalogKey('BoardId');
export type BoardId = z.infer<typeof BoardIdSchema>;

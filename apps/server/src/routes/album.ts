import { album, type AlbumItemDef } from '@coinposh/economy';
import {
  AlbumSetIdSchema,
  CollectibleIdSchema,
  endpoints,
  type AlbumEntry,
  type AlbumResponse,
  type CollectibleKind,
  type PlayerId,
} from '@coinposh/shared';
import { Hono } from 'hono';
import type { DoResult } from '../do/PlayerDO.ts';
import type { Env } from '../env.ts';
import type { AppEnv } from '../http/context.ts';
import { authenticate, respond } from '../http/signed.ts';

/**
 * How many of each album card the player owns, from the append-only `crate_opens` record a
 * crate open writes in the same transaction as the ledger leg that mints the card into the
 * inventory (`collectible_id`, checked against the ledger by `conservation()`). Charms are not
 * counted: the server keeps no charm inventory yet (P-665), so a charm entry stays unowned.
 */
function ownedCounts(sql: SqlStorage): Map<string, number> {
  const rows = sql
    .exec<{ id: string; n: number }>(
      `SELECT collectible_id AS id, COUNT(*) AS n FROM crate_opens
       WHERE collectible_id IS NOT NULL GROUP BY collectible_id`,
    )
    .toArray();
  return new Map(rows.map((row) => [row.id, row.n]));
}

function collectibleKind(item: AlbumItemDef): CollectibleKind {
  if (item.id.endsWith('Charm')) return 'charm';
  return item.rarity === 'heirloom' ? 'heirloom' : 'coinSkin';
}

/** Every economy set with every item in config order, as Demo lists them. */
export function readAlbum(sql: SqlStorage): AlbumResponse {
  const owned = ownedCounts(sql);
  return {
    sets: album.map((set) => {
      const entries = set.items.map((item): AlbumEntry => {
        const count = owned.get(item.id) ?? 0;
        return {
          id: CollectibleIdSchema.parse(item.id),
          kind: collectibleKind(item),
          owned: count > 0,
          count,
        };
      });
      return {
        id: AlbumSetIdSchema.parse(set.id),
        entries,
        completed: entries.every((entry) => entry.owned),
      };
    }),
  };
}

/** The ids of the economy sets whose every item the player owns, in config order. */
export function completedAlbumSets(sql: SqlStorage): string[] {
  const owned = ownedCounts(sql);
  return album
    .filter((set) => set.items.every((item) => (owned.get(item.id) ?? 0) > 0))
    .map((set) => set.id);
}

/**
 * The permanent global coin multiplier bonus of `completed` sets: each one's `globalBonus` as
 * the economy config states it now, so a retune reaches every player on their next mint. A set
 * the config no longer lists adds nothing.
 */
export function albumBonusOf(completed: readonly string[]): number {
  return album.reduce(
    (bonus, set) => (completed.includes(set.id) ? bonus + set.globalBonus : bonus),
    0,
  );
}

export interface AlbumHost {
  album(): Promise<DoResult<AlbumResponse>>;
}

export type AlbumHostResolver = (env: Env, playerId: PlayerId) => AlbumHost;

/** Read-only: the album is whatever the server's crate opens granted. */
export function createAlbumRoutes(resolveHost: AlbumHostResolver): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.get(endpoints.album.path, async (c) => {
    const { grant } = await authenticate(c);
    const result = await resolveHost(c.env, grant.playerId).album();
    return respond(c, endpoints.album.response, result);
  });
  return routes;
}

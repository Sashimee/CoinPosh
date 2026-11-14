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
 * How many of each album item the player owns, from the append-only `crate_opens` record a
 * crate open writes in the same transaction as its ledger legs: the album card the mint put in
 * the inventory (`collectible_id`, checked against the ledger by `conservation()`) and the
 * charm the roll drew (`charm_type`), which Demo counts in the album too.
 */
function ownedCounts(sql: SqlStorage): Map<string, number> {
  const rows = sql
    .exec<{ id: string; n: number }>(
      `SELECT id, COUNT(*) AS n FROM (
         SELECT collectible_id AS id FROM crate_opens WHERE collectible_id IS NOT NULL
         UNION ALL
         SELECT charm_type AS id FROM crate_opens WHERE charm_type IS NOT NULL
       ) GROUP BY id`,
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

/** The permanent global coin multiplier bonus: each completed set's `globalBonus`, summed. */
export function albumBonus(sql: SqlStorage): number {
  const owned = ownedCounts(sql);
  return album.reduce(
    (bonus, set) =>
      set.items.every((item) => (owned.get(item.id) ?? 0) > 0) ? bonus + set.globalBonus : bonus,
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

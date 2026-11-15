import { ApiFailure } from '../../http/errors.ts';
import type { FeatureDoContext, ServerFeature } from '../types.ts';
import { SAMPLE_SEALS, sampleEndpoints, SampleStampSchema } from './endpoints.ts';

/**
 * A test-only feature that exercises every seam once: a versioned table, a GET and a POST
 * route, a handler running in the PlayerDO transaction and a ledger kind moving value
 * mint → wallet → house. It is never in SERVER_FEATURES, so these fixture amounts are not
 * game numbers (those live in packages/economy).
 */
export const SAMPLE_TX_KIND = 'sample.stamp';
export const SAMPLE_GRANT_COINS = 5;
export const SAMPLE_FEE_COINS = 2;
export const SAMPLE_MAX_STAMPS = 3;

export const SAMPLE_TABLE_MIGRATIONS = [
  `CREATE TABLE sample_stamps (
     id TEXT PRIMARY KEY,
     at INTEGER NOT NULL CHECK (at >= 0)
   );`,
  `ALTER TABLE sample_stamps ADD COLUMN motto TEXT NOT NULL DEFAULT '';
   ALTER TABLE sample_stamps ADD COLUMN seal TEXT NOT NULL DEFAULT 'wax';`,
] as const;

function readBook(ctx: FeatureDoContext) {
  return {
    stamps: ctx.sql
      .exec('SELECT id, motto, seal, at FROM sample_stamps ORDER BY at, rowid')
      .toArray()
      .map((row) => SampleStampSchema.parse(row)),
  };
}

function stamp(ctx: FeatureDoContext, input: unknown) {
  const { motto } = sampleEndpoints.sampleStamp.body.parse(input);
  const id = crypto.randomUUID();
  const seal = SAMPLE_SEALS[ctx.roll('seal', id).rng.nextInt(SAMPLE_SEALS.length)] ?? 'wax';
  ctx.commit(
    ctx
      .ledgerTx(SAMPLE_TX_KIND)
      .move('mint', 'wallet', 'coins', SAMPLE_GRANT_COINS, id)
      .move('wallet', 'house', 'coins', SAMPLE_FEE_COINS, id),
  );
  ctx.sql.exec(
    'INSERT INTO sample_stamps (id, at, motto, seal) VALUES (?, ?, ?, ?)',
    id,
    ctx.now,
    motto,
    seal,
  );
  const book = readBook(ctx);
  // Checked after the writes on purpose: the refusal must roll the row and the legs back.
  if (book.stamps.length > SAMPLE_MAX_STAMPS) {
    throw new ApiFailure('conflict', `The sample book holds ${SAMPLE_MAX_STAMPS} stamps.`);
  }
  return {
    stamp: SampleStampSchema.parse({ id, motto, seal, at: ctx.now }),
    book,
    wallet: ctx.readWallet(),
  };
}

export const sampleFeature = {
  id: 'sample',
  endpoints: sampleEndpoints,
  routes(_app, deps) {
    deps.mount(sampleEndpoints.sampleBook, 'book');
    deps.mount(sampleEndpoints.sampleStamp, 'stamp');
  },
  doHandlers: { book: readBook, stamp },
  tables: [{ name: 'sample_stamps', version: 2, migrations: SAMPLE_TABLE_MIGRATIONS }],
  txKinds: [SAMPLE_TX_KIND],
} satisfies ServerFeature<typeof sampleEndpoints>;

import { get, post, WalletSchema, type PlayerId } from '@coinposh/shared';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createFeatureHarness } from '../features/harness.ts';
import { sampleFeature } from '../features/sample/feature.ts';
import type { FeatureDoContext, ServerFeature } from '../features/types.ts';
import { createApp } from '../index.ts';
import { expectConserved, expectError } from '../test/game.ts';
import {
  applyFeatureTables,
  registeredServerFeatures,
  registerServerFeatures,
  resolveFeatureHandler,
} from './features.ts';
import { commit, LedgerTx } from './ledger.ts';

function freshStub() {
  return env.PLAYER.get(env.PLAYER.idFromName(crypto.randomUUID()));
}

function feature(overrides: Partial<ServerFeature> & Pick<ServerFeature, 'id'>): ServerFeature {
  return {
    endpoints: {},
    routes: () => undefined,
    doHandlers: {},
    tables: [],
    txKinds: [],
    ...overrides,
  };
}

const NOTES_V1 = 'CREATE TABLE notes_entries (id INTEGER PRIMARY KEY, body TEXT NOT NULL);';
const NOTES_V2 = "ALTER TABLE notes_entries ADD COLUMN tone TEXT NOT NULL DEFAULT 'warm';";

describe('feature tables', () => {
  it('migrate on their own version track, running only the migrations a DO has not run', async () => {
    const v1 = feature({
      id: 'notes',
      tables: [{ name: 'notes_entries', version: 1, migrations: [NOTES_V1] }],
    });
    const v2 = feature({
      id: 'notes',
      tables: [{ name: 'notes_entries', version: 2, migrations: [NOTES_V1, NOTES_V2] }],
    });
    const result = await runInDurableObject(freshStub(), (_do, ctx) => {
      const sql = ctx.storage.sql;
      const tx = <T>(run: () => T) => ctx.storage.transactionSync(run);
      const version = () =>
        sql
          .exec<{ version: number }>(
            "SELECT version FROM feature_tables WHERE feature = 'notes' AND name = 'notes_entries'",
          )
          .one().version;
      applyFeatureTables(sql, v1, tx);
      const afterV1 = version();
      sql.exec("INSERT INTO notes_entries (body) VALUES ('kept')");
      applyFeatureTables(sql, v2, tx);
      applyFeatureTables(sql, v2, tx);
      return {
        afterV1,
        afterV2: version(),
        rows: sql.exec('SELECT body, tone FROM notes_entries').toArray(),
        downgrade: (() => {
          try {
            applyFeatureTables(sql, v1, tx);
            return null;
          } catch (error) {
            return (error as Error).message;
          }
        })(),
      };
    });
    expect(result.afterV1).toBe(1);
    expect(result.afterV2).toBe(2);
    expect(result.rows).toEqual([{ body: 'kept', tone: 'warm' }]);
    expect(result.downgrade).toMatch(/version 2 in storage but the code declares 1/);
  });

  it('roll back a failing migration whole, version row included', async () => {
    const broken = feature({
      id: 'brokenTables',
      tables: [
        {
          name: 'brokenTables_rows',
          version: 2,
          migrations: ['CREATE TABLE brokenTables_rows (id INTEGER);', 'NOT SQL AT ALL;'],
        },
      ],
    });
    const result = await runInDurableObject(freshStub(), (_do, ctx) => {
      const sql = ctx.storage.sql;
      expect(() => {
        applyFeatureTables(sql, broken, (run) => ctx.storage.transactionSync(run));
      }).toThrow();
      return {
        table: sql
          .exec("SELECT name FROM sqlite_master WHERE name = 'brokenTables_rows'")
          .toArray(),
        versions: sql
          .exec("SELECT version FROM feature_tables WHERE feature = 'brokenTables'")
          .toArray(),
      };
    });
    expect(result.table).toEqual([]);
    expect(result.versions).toEqual([]);
  });
});

describe('registerServerFeatures', () => {
  const table = (name: string, migrations: readonly string[] = ['SELECT 1;']) => ({
    name,
    version: migrations.length,
    migrations,
  });

  it.each([
    ['a malformed id', feature({ id: 'Bad_Id' }), /must be camelCase/],
    [
      'a table outside its prefix',
      feature({ id: 'stray', tables: [table('coins')] }),
      /start with "stray_"/,
    ],
    [
      'a version that does not match its migrations',
      feature({
        id: 'skewed',
        tables: [{ name: 'skewed_t', version: 2, migrations: ['SELECT 1;'] }],
      }),
      /declares version 2 but has 1 migrations/,
    ],
    [
      'a table listed twice',
      feature({ id: 'twice', tables: [table('twice_t'), table('twice_t')] }),
      /lists table "twice_t" twice/,
    ],
    ['a core ledger kind', feature({ id: 'thief', txKinds: ['claim.fall'] }), /core kind/],
    ['a malformed ledger kind', feature({ id: 'sloppy', txKinds: ['Sloppy Kind'] }), /malformed/],
    [
      'another feature’s kind',
      feature({ id: 'copycat', txKinds: ['sample.stamp'] }),
      /"sample" already owns it/,
    ],
  ])('refuses %s', (_label, bad, message) => {
    registerServerFeatures([sampleFeature]);
    expect(() => {
      registerServerFeatures([bad]);
    }).toThrow(message);
    expect(registeredServerFeatures()).not.toContain(bad);
  });

  it('refuses a second module under a registered id, and registers nothing from a bad batch', () => {
    registerServerFeatures([sampleFeature]);
    expect(() => {
      registerServerFeatures([feature({ id: 'sample' })]);
    }).toThrow(/already registered the id "sample"/);

    const good = feature({ id: 'batchGood', txKinds: ['batchGood.pay'] });
    const clash = feature({ id: 'batchClash', txKinds: ['batchGood.pay'] });
    expect(() => {
      registerServerFeatures([good, clash]);
    }).toThrow(/both list ledger kind "batchGood.pay"/);
    expect(registeredServerFeatures()).not.toContain(good);
    expect(() => new LedgerTx('batchGood.pay' as never)).toThrow(/neither a core/);
  });

  it('is a no-op for a module already registered', () => {
    registerServerFeatures([sampleFeature]);
    registerServerFeatures([sampleFeature]);
    expect(registeredServerFeatures().filter((f) => f.id === 'sample')).toEqual([sampleFeature]);
  });
});

describe('mounting feature routes', () => {
  const app = (features: ServerFeature[]) => () =>
    createApp({ fetchJwks: () => Promise.reject(new Error('unused')), features });
  const okResponse = z.strictObject({ ok: z.literal(true) });

  it('refuses a route a core endpoint already serves', () => {
    const shadow = feature({
      id: 'shadow',
      doHandlers: { run: () => ({ ok: true }) },
      routes: (_app, deps) => {
        deps.mount(get('/v1/state', okResponse), 'run');
      },
    });
    expect(app([shadow])).toThrow(/GET \/v1\/state, which a core route already serves/);
  });

  it('refuses two features on one route, a route outside /v1 and catch-all middleware', () => {
    const route = get('/v1/shared/thing', okResponse);
    const one = feature({
      id: 'one',
      doHandlers: { run: () => ({ ok: true }) },
      routes: (_app, deps) => {
        deps.mount(route, 'run');
      },
    });
    const two = feature({ ...one, id: 'two' });
    expect(app([one, two])).toThrow(/feature "one" already serves/);

    const outside = feature({
      id: 'outside',
      routes: (sub) => {
        sub.get('/health2', (c) => c.text('hi'));
      },
    });
    expect(app([outside])).toThrow(/under \/v1\/<theme>\//);

    const sneaky = feature({
      id: 'sneaky',
      routes: (sub) => {
        sub.use('*', async (_c, next) => {
          await next();
        });
      },
    });
    expect(app([sneaky])).toThrow(/registered ALL \/\*/);
  });

  it('refuses a route on a handler the feature does not have, or without bearer auth', () => {
    const missing = feature({
      id: 'missing',
      routes: (_app, deps) => {
        deps.mount(get('/v1/missing/x', okResponse), 'nope');
      },
    });
    expect(app([missing])).toThrow(/unknown DO handler "nope"/);

    const open = feature({
      id: 'open',
      doHandlers: { run: () => ({ ok: true }) },
      routes: (_app, deps) => {
        deps.mount(post('/v1/open/x', z.strictObject({}), okResponse, 'none'), 'run');
      },
    });
    expect(app([open])).toThrow(/must use bearer auth/);
  });
});

const rogueEndpoints = {
  rogueWallet: post(
    '/v1/rogue/wallet',
    z.strictObject({}),
    z.strictObject({ wallet: WalletSchema }),
  ),
  rogueCore: post('/v1/rogue/core', z.strictObject({}), z.strictObject({ ok: z.literal(true) })),
  rogueForeign: post(
    '/v1/rogue/foreign',
    z.strictObject({}),
    z.strictObject({ ok: z.literal(true) }),
  ),
  rogueUnbalanced: post(
    '/v1/rogue/unbalanced',
    z.strictObject({}),
    z.strictObject({ ok: z.literal(true) }),
  ),
  rogueTable: post('/v1/rogue/table', z.strictObject({}), z.strictObject({ ok: z.literal(true) })),
  rogueRead: get('/v1/rogue/read', z.strictObject({ ok: z.literal(true) })),
  rogueSavepoint: post(
    '/v1/rogue/savepoint',
    z.strictObject({}),
    z.strictObject({ ok: z.boolean() }),
  ),
} as const;

const rogueFeature = {
  id: 'rogue',
  endpoints: rogueEndpoints,
  routes(_app, deps) {
    deps.mount(rogueEndpoints.rogueWallet, 'wallet');
    deps.mount(rogueEndpoints.rogueCore, 'core');
    deps.mount(rogueEndpoints.rogueForeign, 'foreign');
    deps.mount(rogueEndpoints.rogueUnbalanced, 'unbalanced');
    deps.mount(rogueEndpoints.rogueTable, 'table');
    deps.mount(rogueEndpoints.rogueRead, 'read');
    deps.mount(rogueEndpoints.rogueSavepoint, 'savepoint');
  },
  doHandlers: {
    wallet: (ctx: FeatureDoContext) => {
      ctx.sql.exec("UPDATE wallet SET balance = balance + 1000 WHERE currency = 'coins'");
      return { wallet: ctx.readWallet() };
    },
    core: (ctx: FeatureDoContext) => {
      commit(ctx.sql, new LedgerTx('grant.starting').move('mint', 'wallet', 'coins', 1000, null), {
        at: ctx.now,
        idempotencyKey: ctx.idempotencyKey,
      });
      return { ok: true };
    },
    foreign: (ctx: FeatureDoContext) => {
      ctx.ledgerTx('sample.stamp');
      return { ok: true };
    },
    unbalanced: (ctx: FeatureDoContext) => {
      ctx.commit(ctx.ledgerTx('rogue.pay').post('mint', 'coins', -5, null));
      return { ok: true };
    },
    table: (ctx: FeatureDoContext) => {
      ctx.commit(ctx.ledgerTx('rogue.pay').move('mint', 'table', 'coins', 5, null));
      return { ok: true };
    },
    read: (ctx: FeatureDoContext) => {
      ctx.commit(ctx.ledgerTx('rogue.pay').move('mint', 'wallet', 'coins', 7, null));
      return { ok: true };
    },
    savepoint: (ctx: FeatureDoContext) => {
      try {
        ctx.transaction(() => {
          ctx.commit(ctx.ledgerTx('rogue.pay').move('mint', 'wallet', 'coins', 9, null));
          throw new Error('Changed my mind.');
        });
      } catch {
        return { ok: true };
      }
      return { ok: false };
    },
  },
  tables: [],
  txKinds: ['rogue.pay'],
} satisfies ServerFeature<typeof rogueEndpoints>;

describe('the per-call conservation check', () => {
  const harness = createFeatureHarness([sampleFeature, rogueFeature]);

  async function coins(playerId: PlayerId): Promise<number> {
    return runInDurableObject(
      env.PLAYER.get(env.PLAYER.idFromName(playerId)),
      (_do, ctx) =>
        ctx.storage.sql
          .exec<{ balance: number }>("SELECT balance FROM wallet WHERE currency = 'coins'")
          .one().balance,
    );
  }

  it.each([
    ['writes the wallet behind the ledger', 'rogueWallet'],
    ['commits a core kind', 'rogueCore'],
    ['opens another feature’s kind', 'rogueForeign'],
    ['commits an unbalanced transaction', 'rogueUnbalanced'],
    ['posts table coins no coin row backs', 'rogueTable'],
  ] as const)('refuses a feature that %s, writing nothing', async (_label, name) => {
    const player = await harness.player();
    const before = await coins(player.playerId);
    await expectError(await player.send(name, { body: {} }), 500, 'internal');
    expect(await coins(player.playerId)).toBe(before);
    await expectConserved(player.session);
  });

  it('refuses a read that moves value', async () => {
    const player = await harness.player();
    const before = await coins(player.playerId);
    await expectError(await player.send('rogueRead'), 500, 'internal');
    expect(await coins(player.playerId)).toBe(before);
  });

  it('lets a handler roll back a savepoint and keep the rest of the call', async () => {
    const player = await harness.player();
    const before = await coins(player.playerId);
    expect(await player.call('rogueSavepoint', {})).toEqual({ ok: true });
    expect(await coins(player.playerId)).toBe(before);
    await expectConserved(player.session);
  });

  it('answers a player who has no table yet like the core routes', async () => {
    const result = await freshStub().feature('sample', 'book', {
      idempotencyKey: null,
      fingerprint: null,
      input: {},
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
  });

  it('throws for a feature or handler the PlayerDO does not know', () => {
    expect(() => resolveFeatureHandler('nobody', 'book')).toThrow(/No server feature "nobody"/);
    expect(() => resolveFeatureHandler('sample', 'nope')).toThrow(/has no DO handler "nope"/);
    expect(() => resolveFeatureHandler('sample', 'toString')).toThrow(/has no DO handler/);
    expect(resolveFeatureHandler('sample', 'book').feature).toBe(sampleFeature);
  });
});

const LARGE_LEDGER_LEGS = 200_000;
const FEATURE_CALL_BUDGET_MS = 150;

/** Appends `legs` balanced mint → house legs straight into the ledger, as a long-lived player has. */
function seedLargeLedger(sql: SqlStorage, legs: number): void {
  sql.exec(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ?)
     INSERT INTO ledger (tx_id, at, kind, account, unit, delta, ref, idempotency_key)
     SELECT 'seed-' || (i / 2), 0, 'grant.starting', CASE i % 2 WHEN 0 THEN 'mint' ELSE 'house' END,
            'coins', CASE i % 2 WHEN 0 THEN -1 ELSE 1 END, NULL, NULL
     FROM n`,
    legs,
  );
}

describe('feature calls on a large ledger', () => {
  const harness = createFeatureHarness([sampleFeature]);

  it(
    `answer a GET and a wallet-only write within ${FEATURE_CALL_BUDGET_MS} ms each`,
    { timeout: 60_000 },
    async () => {
      const player = await harness.player();
      await player.call('sampleBook');
      await runInDurableObject(player.stub, (_do, ctx) => {
        seedLargeLedger(ctx.storage.sql, LARGE_LEDGER_LEGS);
      });

      const readStarted = performance.now();
      expect(await player.call('sampleBook')).toEqual({ stamps: [] });
      const readMs = performance.now() - readStarted;

      const writeStarted = performance.now();
      const stamped = await player.call('sampleStamp', { motto: 'Patience pays' });
      const writeMs = performance.now() - writeStarted;

      expect(stamped.book.stamps).toHaveLength(1);
      expect(readMs).toBeLessThan(FEATURE_CALL_BUDGET_MS);
      expect(writeMs).toBeLessThan(FEATURE_CALL_BUDGET_MS);
      await expectConserved(player.session);
    },
  );
});

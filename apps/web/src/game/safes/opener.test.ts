import {
  SafeIdSchema,
  SafeOpenResponseSchema,
  SafeSchema,
  type PityCounters,
  type Safe,
  type SafeId,
  type SafeOpenMethod,
  type SafeOpenResponse,
} from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import type { SafeOutcome, SafesController } from './controller.ts';
import type { SafeRejection } from './events.ts';
import { createSafeOpener, type OpenedSafe, type SafePlayHooks } from './opener.ts';

function safe(id: string): Safe {
  return SafeSchema.parse({
    id: SafeIdSchema.parse(`safe_${id.padEnd(16, 'A')}`),
    type: 'gold',
    unlocksAt: 1_800_000_000_000,
  });
}

const A = safe('a');
const B = safe('b');
const PITY: PityCounters = { rare: 0, exquisite: 4, legendary: 9 };

function response(safeId: SafeId): SafeOpenResponse {
  return SafeOpenResponseSchema.parse({
    safeId,
    roll: {
      rarity: 'rare',
      rewards: [{ kind: 'currency', currency: 'coins', amount: 1_200 }],
      proof: { serverSeedHash: 'a'.repeat(64), clientSeed: 'client-seed', nonce: 3 },
      pity: PITY,
    },
    wallet: { coins: 5_000, bullion: 0, goldBars: 0, pearls: 0, keys: 1, tickets: 0, stars: 0 },
  });
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function harness() {
  const answers = new Map<SafeId, (outcome: SafeOutcome) => void>();
  const opens: SafeId[] = [];
  const controller: Pick<SafesController, 'open' | 'busy'> = {
    open(safeId: SafeId, _method: SafeOpenMethod) {
      opens.push(safeId);
      return new Promise<SafeOutcome>((resolve) => {
        answers.set(safeId, (outcome) => {
          answers.delete(safeId);
          resolve(outcome);
        });
      });
    },
    get busy() {
      return answers.size > 0;
    },
  };
  const log: string[] = [];
  const payout = {
    hold: (id: string, credit: object) => log.push(`hold ${id} ${JSON.stringify(credit)}`),
    arm: (id: string) => log.push(`arm ${id}`),
    collect: (id: string) => log.push(`collect ${id}`),
    release: (id: string) => log.push(`release ${id}`),
  };
  const plays: { opened: OpenedSafe; hooks: SafePlayHooks; finish: () => void }[] = [];
  const pity: [SafeId, PityCounters][] = [];
  const rejected: [SafeId, SafeRejection][] = [];
  const done: SafeId[] = [];
  let refreshes = 0;
  const opener = createSafeOpener({
    controller,
    payout,
    play(opened, hooks) {
      log.push(`play ${opened.safeId}`);
      let finish: () => void = () => {
        throw new Error('the cinematic promise never started');
      };
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      plays.push({ opened, hooks, finish });
      return { done: finished, dispose: () => log.push(`dispose ${opened.safeId}`) };
    },
    onOpened: ({ safeId }) => log.push(`opened ${safeId}`),
    onRejected: (target, reason) => rejected.push([target.id, reason]),
    onDone: ({ safeId }) => done.push(safeId),
    onPity: (safeId, counters) => pity.push([safeId, counters]),
    refresh: () => {
      refreshes += 1;
    },
  });
  const succeed = async (target: Safe, method: SafeOpenMethod = 'key') => {
    const answer = answers.get(target.id);
    if (answer === undefined) throw new Error(`no open in flight for ${target.id}`);
    answer({ ok: true, method, response: response(target.id), pity: PITY });
    await flush();
  };
  const reject = async (target: Safe, reason: SafeRejection) => {
    const answer = answers.get(target.id);
    if (answer === undefined) throw new Error(`no open in flight for ${target.id}`);
    answer({ ok: false, method: 'key', reason, error: new Error(reason) });
    await flush();
  };
  return {
    opener,
    opens,
    log,
    plays,
    pity,
    rejected,
    done,
    refreshes: () => refreshes,
    succeed,
    reject,
  };
}

describe('safe opener', () => {
  it('holds the credit, plays, arms on settle, pays out on collect and never releases after', async () => {
    const h = harness();
    expect(h.opener.request(A, 'key')).toBe(true);
    expect(h.opener.busy).toBe(true);
    expect(h.opener.pendingOpens()).toEqual([{ type: 'gold', method: 'key' }]);
    await h.succeed(A);
    expect(h.opener.pendingOpens()).toEqual([]);
    expect(h.opener.playing).toBe(A.id);
    const play = h.plays[0];
    if (play === undefined) throw new Error('no cinematic played');
    play.hooks.settled();
    play.hooks.collect({ wallet: play.opened.wallet, lines: [] });
    play.hooks.collect({ wallet: play.opened.wallet, lines: [] });
    play.finish();
    await flush();
    expect(h.log).toEqual([
      `hold ${A.id} {"coins":1200}`,
      `opened ${A.id}`,
      `play ${A.id}`,
      `arm ${A.id}`,
      `collect ${A.id}`,
      `dispose ${A.id}`,
    ]);
    expect(h.done).toEqual([A.id]);
    expect(h.opener.playing).toBeNull();
    expect(h.opener.busy).toBe(false);
  });

  it('releases a hold the player never collected once the cinematic ends', async () => {
    const h = harness();
    h.opener.request(A, 'timer');
    await h.succeed(A, 'timer');
    h.plays[0]?.finish();
    await flush();
    expect(h.log.slice(-2)).toEqual([`dispose ${A.id}`, `release ${A.id}`]);
    expect(h.log).not.toContain(`arm ${A.id}`);
  });

  it('hands the server pity counters on exactly once per roll', async () => {
    const h = harness();
    h.opener.request(A, 'key');
    await h.succeed(A);
    h.plays[0]?.finish();
    await flush();
    h.opener.request(B, 'key');
    await h.succeed(B);
    expect(h.pity).toEqual([
      [A.id, PITY],
      [B.id, PITY],
    ]);
  });

  it('refuses a second open while one is in flight, so two cinematics never stack', async () => {
    const h = harness();
    expect(h.opener.request(A, 'key')).toBe(true);
    expect(h.opener.request(B, 'key')).toBe(false);
    expect(h.opens).toEqual([A.id]);
    await h.succeed(A);
    expect(h.opener.request(B, 'key')).toBe(false);
    expect(h.opens).toEqual([A.id]);
    expect(h.plays).toHaveLength(1);
    h.plays[0]?.finish();
    await flush();
    expect(h.opener.request(B, 'key')).toBe(true);
    expect(h.opens).toEqual([A.id, B.id]);
  });

  it('resyncs on a stale refusal (gone, not ready) and only then', async () => {
    const h = harness();
    const reasons: SafeRejection[] = ['gone', 'notReady', 'noKeys', 'offline', 'unavailable'];
    for (const reason of reasons) {
      h.opener.request(A, 'key');
      await h.reject(A, reason);
    }
    expect(h.refreshes()).toBe(2);
    expect(h.rejected).toEqual(reasons.map((reason) => [A.id, reason]));
    expect(h.plays).toHaveLength(0);
    expect(h.log).toEqual([]);
    expect(h.pity).toEqual([]);
    expect(h.opener.busy).toBe(false);
  });

  it('tears the cinematic down on dispose, releases the hold and ignores late answers', async () => {
    const h = harness();
    h.opener.request(A, 'key');
    await h.succeed(A);
    h.opener.dispose();
    expect(h.log.slice(-2)).toEqual([`dispose ${A.id}`, `release ${A.id}`]);
    h.plays[0]?.finish();
    await flush();
    expect(h.done).toEqual([]);
    expect(h.opener.request(B, 'key')).toBe(false);
  });

  it('drops an answer that lands after dispose', async () => {
    const h = harness();
    h.opener.request(A, 'key');
    h.opener.dispose();
    await h.succeed(A);
    expect(h.log).toEqual([]);
    expect(h.pity).toEqual([]);
  });
});

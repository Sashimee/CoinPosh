import {
  IdempotencyKeySchema,
  type IdempotencyKey,
  type QuestClaimResponse,
  type QuestId,
} from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../../net/errors.ts';
import { HeldSettlements, isAlreadyClaimed, QuestClaims } from './claim.ts';
import { claimResponse, fixtureQuest } from './fixture.ts';

const quest = fixtureQuest({ template: 'dailyDropsEasy', done: 1 }, 0);
const other = fixtureQuest({ template: 'dailyCratesEasy', done: 1 }, 1);

function keys(): () => IdempotencyKey {
  let n = 0;
  return () =>
    IdempotencyKeySchema.parse(`00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const conflict = () =>
  new ApiRequestError('questsClaim', 409, { code: 'conflict', message: 'already claimed' });

describe('QuestClaims', () => {
  it('claims and settles as claimed', async () => {
    const sent: [QuestId, IdempotencyKey][] = [];
    const claims = new QuestClaims((id, key) => {
      sent.push([id, key]);
      return Promise.resolve(claimResponse(quest));
    }, keys());
    const outcome = await claims.claim(quest.id);
    expect(outcome.kind).toBe('claimed');
    expect(claims.status(quest.id)).toBe('claimed');
    expect(sent).toHaveLength(1);
    claims.forgetSettled();
    expect(claims.status(quest.id)).toBe('idle');
  });

  it('is pending while in flight and ignores a second tap', async () => {
    const wait = deferred<QuestClaimResponse>();
    let calls = 0;
    const claims = new QuestClaims(() => {
      calls++;
      return wait.promise;
    }, keys());
    const first = claims.claim(quest.id);
    expect(claims.status(quest.id)).toBe('pending');
    expect(claims.busy).toBe(true);
    expect(await claims.claim(quest.id)).toEqual({ kind: 'ignored' });
    wait.resolve(claimResponse(quest));
    expect((await first).kind).toBe('claimed');
    expect(calls).toBe(1);
    expect(claims.busy).toBe(false);
  });

  it('reads a conflict as already claimed', async () => {
    const claims = new QuestClaims(() => Promise.reject(conflict()), keys());
    expect(await claims.claim(quest.id)).toEqual({ kind: 'already' });
    expect(claims.status(quest.id)).toBe('already');
    expect(isAlreadyClaimed(conflict())).toBe(true);
    expect(isAlreadyClaimed(new Error('conflict'))).toBe(false);
    expect(
      isAlreadyClaimed(
        new ApiRequestError('questsClaim', 503, { code: 'unavailable', message: 'down' }),
      ),
    ).toBe(false);
  });

  it('fails, then retries with the same idempotency key, then uses a fresh key next time', async () => {
    const sent: IdempotencyKey[] = [];
    let fail = true;
    const claims = new QuestClaims((_id, key) => {
      sent.push(key);
      return fail
        ? Promise.reject(new Error('network down'))
        : Promise.resolve(claimResponse(quest));
    }, keys());
    const failed = await claims.claim(quest.id);
    expect(failed.kind).toBe('failed');
    expect(claims.status(quest.id)).toBe('failed');
    fail = false;
    expect((await claims.claim(quest.id)).kind).toBe('claimed');
    expect(sent[1]).toBe(sent[0]);
    claims.forgetSettled();
    await claims.claim(quest.id);
    expect(sent[2]).not.toBe(sent[0]);
  });

  it('keeps failures across forgetSettled, so the retry button stays', async () => {
    const claims = new QuestClaims(() => Promise.reject(new Error('boom')), keys());
    await claims.claim(quest.id);
    claims.forgetSettled();
    expect(claims.status(quest.id)).toBe('failed');
  });

  it('treats an answer for another quest, or an unclaimed one, as a failure', async () => {
    const wrong = new QuestClaims(() => Promise.resolve(claimResponse(other)), keys());
    const outcome = await wrong.claim(quest.id);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(String(outcome.error)).toMatch(quest.id);
    const unclaimed = new QuestClaims(() => {
      const response = claimResponse(quest);
      return Promise.resolve({ ...response, quest: { ...response.quest, claimed: false } });
    }, keys());
    expect((await unclaimed.claim(quest.id)).kind).toBe('failed');
  });
});

describe('HeldSettlements', () => {
  it('settles a held claim once, when its hit-stop ends', () => {
    const held = new HeldSettlements();
    const settled: string[] = [];
    held.hold('a', () => settled.push('a'));
    expect(held.run('a')).toBe(true);
    expect(held.run('a')).toBe(false);
    expect(settled).toEqual(['a']);
  });

  it('flushes every held claim on close, so the hit-stop timer then finds nothing to do', () => {
    const held = new HeldSettlements();
    const settled: string[] = [];
    held.hold('a', () => settled.push('a'));
    held.hold('b', () => settled.push('b'));
    held.flush();
    expect(settled).toEqual(['a', 'b']);
    expect(held.run('a')).toBe(false);
    expect(held.run('b')).toBe(false);
    held.flush();
    expect(settled).toEqual(['a', 'b']);
  });

  it('drops held claims without settling them once the panel is disposed', () => {
    const held = new HeldSettlements();
    const settled: string[] = [];
    held.hold('a', () => settled.push('a'));
    held.clear();
    held.flush();
    expect(settled).toEqual([]);
  });

  it('runs nothing for an id it never held', () => {
    expect(new HeldSettlements().run('missing')).toBe(false);
  });
});

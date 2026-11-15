import { IdempotencyKeySchema } from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../../net/index.ts';
import { apiSeasonData, type SeasonClient } from './data.ts';
import { claimResponse, fixtureQuest, questsResponse, seasonResponse } from './fixture.ts';

const quest = fixtureQuest({ template: 'dailyDropsEasy', done: 1 }, 0);
const key = IdempotencyKeySchema.parse('00000000-0000-4000-8000-000000000001');

function client(answers: Record<string, unknown>, calls: unknown[][] = []): SeasonClient {
  return {
    call: (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve(answers[String(args[0])]);
    },
  };
}

describe('apiSeasonData', () => {
  it('is built on the app ApiClient', () => {
    const asSeasonClient = (api: ApiClient): SeasonClient => api;
    expect(asSeasonClient).toBeTypeOf('function');
  });

  it('reads quests and the season through their endpoints', async () => {
    const data = apiSeasonData(client({ quests: questsResponse(), season: seasonResponse() }));
    expect((await data.quests()).quests).toHaveLength(6);
    expect((await data.season()).stars).toBe(1_220);
  });

  it('claims with the quest id in the body and the idempotency key in the options', async () => {
    const calls: unknown[][] = [];
    const data = apiSeasonData(client({ questsClaim: claimResponse(quest) }, calls));
    const response = await data.claim(quest.id, key);
    expect(response.quest.claimed).toBe(true);
    expect(calls).toEqual([
      ['questsClaim', { body: { questId: quest.id } }, { idempotencyKey: key }],
    ]);
  });

  it('rejects a malformed answer at the boundary', async () => {
    const data = apiSeasonData(client({ quests: { quests: 'nope' }, season: {} }));
    await expect(data.quests()).rejects.toThrow();
    await expect(data.season()).rejects.toThrow();
  });
});

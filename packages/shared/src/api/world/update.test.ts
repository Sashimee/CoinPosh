import { describe, expect, it } from 'vitest';
import { roundTrip } from '../../test/roundTrip.ts';
import { worldUpdate } from './fixtures.ts';
import { WorldUpdateSchema } from './update.ts';

const [first, second] = worldUpdate.fetches;
if (first === undefined || second === undefined) throw new Error('The fixture fetches twice.');
const issuePaths = (result: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path);

describe('WorldUpdateSchema', () => {
  it('round-trips a step that delivered a letter and fetched twice', () => {
    const { parsed, reparsed } = roundTrip(WorldUpdateSchema, worldUpdate);
    expect(reparsed).toEqual(parsed);
  });

  it('accepts a quiet step', () => {
    expect(WorldUpdateSchema.safeParse({ deliveries: [], fetches: [] }).success).toBe(true);
  });

  it.each([
    [
      'a letter delivered twice',
      { deliveries: [...worldUpdate.deliveries, ...worldUpdate.deliveries] },
      ['deliveries', 1, 'letterId'],
    ],
    [
      'fetches out of tick order',
      { fetches: [first, { ...second, tick: first.tick }] },
      ['fetches', 1, 'tick'],
    ],
    [
      'a fetch count that skips',
      { fetches: [first, { ...second, fetches: 61 }] },
      ['fetches', 1, 'fetches'],
    ],
    [
      'a level-up with no new level',
      { fetches: [first, { ...second, level: 3 }] },
      ['fetches', 1, 'level'],
    ],
    [
      'a new level not marked as a level-up',
      { fetches: [first, { ...second, leveledUp: false }] },
      ['fetches', 1, 'level'],
    ],
    ['a level that falls', { fetches: [{ ...first, level: 5 }, second] }, ['fetches', 1, 'level']],
    [
      'two pets fetching in one step',
      { fetches: [first, { ...second, species: 'cat' }] },
      ['fetches', 1, 'species'],
    ],
  ])('refuses %s', (_label, change, path) => {
    expect(issuePaths(WorldUpdateSchema.safeParse({ ...worldUpdate, ...change }))).toContainEqual(
      path,
    );
  });
});

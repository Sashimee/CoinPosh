import { describe, expect, it } from 'vitest';
import { roundTrip } from '../../test/roundTrip.ts';
import { liveCollection, liveEventsFixtures, liveNow, liveThemes } from './fixtures.ts';
import {
  LIVE_THEME_KINDS,
  LimitedCollectionSchema,
  LiveThemeSchema,
  ThemesResponseSchema,
} from './themes.ts';

const answer = liveEventsFixtures.liveEventsThemes.response;
const { winterGala, grandPrix } = liveThemes;
const issuePaths = (result: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path);

describe('LiveThemeSchema', () => {
  it('covers holidays and luxury-calendar tie-ins', () => {
    expect(LIVE_THEME_KINDS).toEqual(['holiday', 'tieIn']);
  });

  it.each(Object.values(liveThemes))('round-trips the $id theme', (theme) => {
    const { parsed, reparsed } = roundTrip(LiveThemeSchema, theme);
    expect(reparsed).toEqual(parsed);
  });

  it('accepts a theme that only dresses the table', () => {
    const plain = { ...grandPrix, coinFace: null, collection: null };
    expect(LiveThemeSchema.safeParse(plain).success).toBe(true);
  });

  it.each([
    ['a window that ends as it opens', { endsAt: winterGala.startsAt }, ['endsAt']],
    ['a venue dressed twice', { venues: ['rivieraYacht', 'rivieraYacht'] }, ['venues', 1]],
  ])('refuses %s', (_label, change, path) => {
    expect(issuePaths(LiveThemeSchema.safeParse({ ...winterGala, ...change }))).toContainEqual(
      path,
    );
  });

  it.each([
    ['no venues', { venues: [] }],
    ['an unknown venue', { venues: ['moonBase'] }],
    ['an unknown kind', { kind: 'sale' }],
    ['a theme id that is not a config key', { id: 'Winter Gala' }],
  ])('refuses %s', (_label, change) => {
    expect(LiveThemeSchema.safeParse({ ...winterGala, ...change }).success).toBe(false);
  });
});

describe('LimitedCollectionSchema', () => {
  it('round-trips the fixture', () => {
    const { parsed, reparsed } = roundTrip(LimitedCollectionSchema, liveCollection);
    expect(reparsed).toEqual(parsed);
  });

  it('stamps completion exactly when every item is owned', () => {
    const items = liveCollection.items.map((item) => ({ ...item, owned: 1 }));
    const complete = { ...liveCollection, items, completedAt: liveNow };
    expect(LimitedCollectionSchema.safeParse(complete).success).toBe(true);
    expect(
      issuePaths(LimitedCollectionSchema.safeParse({ ...complete, completedAt: null })),
    ).toEqual([['completedAt']]);
    expect(
      issuePaths(LimitedCollectionSchema.safeParse({ ...liveCollection, completedAt: liveNow })),
    ).toEqual([['completedAt']]);
  });

  it.each([
    [
      'an item listed twice',
      { items: [...liveCollection.items, liveCollection.items[0]] },
      ['items', 3, 'collectibleId'],
    ],
    [
      'an item whose rarity has no odds',
      { items: [{ collectibleId: 'bauble-pearl', rarity: 'heirloom', owned: 0 }] },
      ['items', 0, 'rarity'],
    ],
    ['a pity at its limit', { pity: { ...liveCollection.pity, since: 30 } }, ['pity', 'since']],
  ])('refuses %s', (_label, change, path) => {
    expect(
      issuePaths(LimitedCollectionSchema.safeParse({ ...liveCollection, ...change })),
    ).toContainEqual(path);
  });

  it.each([
    ['no items', { items: [] }],
    ['no completion reward', { completion: [] }],
    ['odds short of 100 %', { odds: liveCollection.odds.slice(1) }],
  ])('refuses %s', (_label, change) => {
    expect(LimitedCollectionSchema.safeParse({ ...liveCollection, ...change }).success).toBe(false);
  });
});

describe('ThemesResponseSchema', () => {
  it('round-trips the fixture', () => {
    const { parsed, reparsed } = roundTrip(ThemesResponseSchema, answer);
    expect(reparsed).toEqual(parsed);
  });

  it('accepts a quiet calendar', () => {
    const quiet = { serverTime: liveNow, active: [], upcoming: [], collections: [] };
    expect(ThemesResponseSchema.safeParse(quiet).success).toBe(true);
  });

  it('runs a holiday and a tie-in side by side', () => {
    const both = {
      ...answer,
      active: [winterGala, { ...grandPrix, startsAt: liveNow - 1 }],
      upcoming: [],
    };
    expect(ThemesResponseSchema.safeParse(both).error).toBeUndefined();
  });

  it.each([
    ['an active theme that has ended', { serverTime: winterGala.endsAt }, ['active', 0]],
    [
      'an upcoming theme already open',
      { upcoming: [{ ...grandPrix, startsAt: liveNow }] },
      ['upcoming', 0],
    ],
    [
      'upcoming themes out of order',
      {
        upcoming: [
          grandPrix,
          { ...grandPrix, id: 'regattaSeason', startsAt: grandPrix.startsAt - 1 },
        ],
      },
      ['upcoming', 1, 'startsAt'],
    ],
    [
      'a theme listed twice',
      { upcoming: [{ ...grandPrix, id: 'winterGala' }] },
      ['upcoming', 0, 'id'],
    ],
    ['a missing collection', { collections: [] }, ['active', 0, 'collection']],
    [
      'a collection with no active theme',
      {
        collections: [
          liveCollection,
          { ...liveCollection, id: 'grandPrix-trophies', theme: 'grandPrixWeek' },
        ],
      },
      ['collections', 1, 'theme'],
    ],
    [
      'a collection listed twice',
      { collections: [liveCollection, liveCollection] },
      ['collections', 1, 'id'],
    ],
  ])('refuses %s', (_label, change, path) => {
    expect(issuePaths(ThemesResponseSchema.safeParse({ ...answer, ...change }))).toContainEqual(
      path,
    );
  });
});

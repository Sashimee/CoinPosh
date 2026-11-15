import { describe, expect, it } from 'vitest';
import { roundTrip } from '../../test/roundTrip.ts';
import { worldArcs, worldFixtures, worldNow } from './fixtures.ts';
import {
  GuestArcSchema,
  LETTERS_PER_ARC,
  LETTER_STATUSES,
  LetterConditionSchema,
  LetterDeliverySchema,
  LetterOpenRequestSchema,
  LetterOpenResponseSchema,
  LetterSchema,
  LettersResponseSchema,
  isLetterConditionMet,
  type LetterCondition,
} from './letters.ts';

const answer = worldFixtures.worldLetters.response;
const opening = worldFixtures.worldLetterOpen.response;
const { inProgress, complete, teased } = worldArcs;
const issuePaths = (result: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path);
const withLetter = (arc: typeof inProgress, index: number, change: object) => ({
  ...arc,
  letters: arc.letters.map((letter, i) => (i === index ? { ...letter, ...change } : letter)),
});

describe('letter conditions', () => {
  it.each([
    [{ kind: 'letter', letter: 'countessVane.inheritance.2', met: true }, true],
    [{ kind: 'letter', letter: 'countessVane.inheritance.2', met: false }, false],
    [{ kind: 'progress', key: 'ascensions', target: 2, progress: 2 }, true],
    [{ kind: 'progress', key: 'ascensions', target: 2, progress: 1 }, false],
    [{ kind: 'postedAt', at: worldNow }, true],
    [{ kind: 'postedAt', at: worldNow + 1 }, false],
  ])('judges %o met: %s', (condition, met) => {
    const parsed = LetterConditionSchema.parse(condition);
    expect(isLetterConditionMet(parsed, worldNow)).toBe(met);
  });

  it.each([
    ['progress past its target', { kind: 'progress', key: 'ascensions', target: 2, progress: 3 }],
    ['a zero target', { kind: 'progress', key: 'ascensions', target: 0, progress: 0 }],
    [
      'free text in place of a template key',
      { kind: 'progress', key: 'Win 3 times', target: 3, progress: 0 },
    ],
    ['an unknown kind', { kind: 'moonPhase', at: worldNow }],
  ])('refuses %s', (_label, condition) => {
    expect(LetterConditionSchema.safeParse(condition).success).toBe(false);
  });
});

describe('LetterSchema', () => {
  it('has the three states the wax-sealed reveal plays', () => {
    expect(LETTER_STATUSES).toEqual(['sealed', 'delivered', 'opened']);
  });

  it.each(inProgress.letters)('round-trips letter $index', (letter) => {
    const { parsed, reparsed } = roundTrip(LetterSchema, letter);
    expect(reparsed).toEqual(parsed);
  });

  it.each([
    [
      'an opening before the delivery',
      inProgress.letters[0],
      { openedAt: worldNow - 4 * 86_400_000 },
      ['openedAt'],
    ],
    [
      'a condition listed twice',
      inProgress.letters[3],
      {
        conditions: [
          { kind: 'postedAt', at: 1 },
          { kind: 'postedAt', at: 2 },
        ],
      },
      ['conditions', 1],
    ],
  ])('refuses %s', (_label, letter, change, path) => {
    expect(issuePaths(LetterSchema.safeParse({ ...letter, ...change }))).toContainEqual(path);
  });

  it.each([
    ['a sealed letter with no condition', inProgress.letters[3], { conditions: [] }],
    ['an index past the arc', inProgress.letters[0], { index: LETTERS_PER_ARC + 1 }],
    ['a delivered letter with no delivery time', inProgress.letters[2], { deliveredAt: undefined }],
  ])('refuses %s', (_label, letter, change) => {
    expect(LetterSchema.safeParse({ ...letter, ...change }).success).toBe(false);
  });

  it('drops free text from the wire, so only the template id reaches the screen', () => {
    const parsed = LetterSchema.parse({
      ...inProgress.letters[2],
      body: 'Darling, the yacht is yours.',
    });
    expect(parsed).not.toHaveProperty('body');
  });
});

describe('GuestArcSchema', () => {
  it.each(Object.values(worldArcs))('round-trips the $id arc', (arc) => {
    const { parsed, reparsed } = roundTrip(GuestArcSchema, arc);
    expect(reparsed).toEqual(parsed);
  });

  it('tells every arc in five letters', () => {
    expect(GuestArcSchema.safeParse({ ...teased, letters: teased.letters.slice(1) }).success).toBe(
      false,
    );
  });

  it.each([
    ['an arc keyed under another guest', { ...inProgress, guest: 'baronVoss' }, ['id']],
    [
      'letters out of order',
      {
        ...inProgress,
        letters: [inProgress.letters[1], inProgress.letters[0], ...inProgress.letters.slice(2)],
      },
      ['letters', 0, 'index'],
    ],
    [
      'a letter keyed under another arc',
      withLetter(inProgress, 3, { id: 'baronVoss.regatta.4' }),
      ['letters', 3, 'id'],
    ],
    [
      'two letters waiting at once',
      withLetter(inProgress, 3, {
        status: 'delivered',
        deliveredAt: worldNow,
        conditions: undefined,
      }),
      ['letters', 3, 'status'],
    ],
    [
      'a letter delivered before the one before it was opened',
      withLetter(inProgress, 2, { deliveredAt: worldNow - 3 * 86_400_000 }),
      ['letters', 2, 'deliveredAt'],
    ],
    [
      'a letter opened past a sealed one',
      withLetter(teased, 1, {
        status: 'opened',
        deliveredAt: worldNow,
        openedAt: worldNow,
        granted: [],
        conditions: undefined,
        rewards: undefined,
      }),
      ['letters', 1, 'status'],
    ],
    ['a finished arc with no completion time', { ...complete, completedAt: null }, ['completedAt']],
    [
      'an arc completed before its last letter',
      { ...complete, completedAt: worldNow - 30 * 86_400_000 },
      ['completedAt'],
    ],
    [
      'an unfinished arc stamped complete',
      { ...inProgress, completedAt: worldNow },
      ['completedAt'],
    ],
  ])('refuses %s', (_label, arc, path) => {
    expect(issuePaths(GuestArcSchema.safeParse(arc))).toContainEqual(path);
  });
});

describe('LettersResponseSchema', () => {
  it('round-trips the fixture, with at least three arcs to read', () => {
    const { parsed, reparsed } = roundTrip(LettersResponseSchema, answer);
    expect(reparsed).toEqual(parsed);
    expect(parsed.arcs.length).toBeGreaterThanOrEqual(3);
  });

  it('accepts a player no guest has written to yet', () => {
    const empty = { serverTime: worldNow, guests: [], arcs: [], unread: 0 };
    expect(LettersResponseSchema.safeParse(empty).success).toBe(true);
  });

  it.each([
    ['an unread count off the tray', { unread: 2 }, ['unread']],
    ['an arc whose guest is missing', { guests: answer.guests.slice(1) }, ['arcs', 0, 'guest']],
    ['a guest listed twice', { guests: [...answer.guests, answer.guests[0]] }, ['guests', 3, 'id']],
    ['an arc listed twice', { arcs: [...answer.arcs, inProgress], unread: 2 }, ['arcs', 3, 'id']],
    [
      'a delivery stamped after the server time',
      { serverTime: worldNow - 2 * 3_600_000 },
      ['arcs', 0, 'letters', 2, 'deliveredAt'],
    ],
    [
      'a sealed letter whose conditions are all met',
      {
        arcs: [
          inProgress,
          complete,
          withLetter(teased, 0, {
            conditions: [{ kind: 'progress', key: 'venuesUnlocked', target: 2, progress: 2 }],
          }),
        ],
      },
      ['arcs', 2, 'letters', 0, 'conditions'],
    ],
  ])('refuses %s', (_label, change, path) => {
    expect(issuePaths(LettersResponseSchema.safeParse({ ...answer, ...change }))).toContainEqual(
      path,
    );
  });

  it('keeps a letter sealed until its post arrives', () => {
    const postedAt: LetterCondition = { kind: 'postedAt', at: worldNow };
    const arcs = [inProgress, complete, withLetter(teased, 0, { conditions: [postedAt] })];
    expect(issuePaths(LettersResponseSchema.safeParse({ ...answer, arcs }))).toContainEqual([
      'arcs',
      2,
      'letters',
      0,
      'conditions',
    ]);
    const beforePost = { ...answer, arcs, serverTime: worldNow - 1 };
    expect(LettersResponseSchema.safeParse(beforePost).error).toBeUndefined();
  });
});

describe('opening a letter', () => {
  it('asks for the letter id only', () => {
    expect(LetterOpenRequestSchema.parse(worldFixtures.worldLetterOpen.body)).toEqual({
      letterId: 'countessVane.inheritance.3',
    });
  });

  it.each([
    ['the rewards it pays', { granted: [{ kind: 'currency', currency: 'pearls', amount: 500 }] }],
    ['an opening time', { openedAt: worldNow }],
    ['an arc to advance', { arc: 'countessVane.inheritance' }],
  ])('refuses a request that carries %s', (_label, extra) => {
    const result = LetterOpenRequestSchema.safeParse({
      letterId: 'countessVane.inheritance.3',
      ...extra,
    });
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
  });

  it('round-trips the answer, which delivers the next letter at once', () => {
    const { parsed, reparsed } = roundTrip(LetterOpenResponseSchema, opening);
    expect(reparsed).toEqual(parsed);
    expect(parsed.deliveries.map((delivery) => delivery.letterId)).toEqual([
      'countessVane.inheritance.4',
    ]);
  });

  it.each([
    ['an arc where the letter is still sealed', { arc: inProgress }, ['arc', 'letters']],
    [
      'a letter missing from the arc',
      { letterId: 'countessVane.inheritance.9' },
      ['arc', 'letters'],
    ],
    [
      'an opening time the arc does not show',
      { openedAt: worldNow + 1 },
      ['arc', 'letters', 2, 'openedAt'],
    ],
    ['a payout the letter does not record', { granted: [] }, ['granted']],
    [
      'a delivery before the opening',
      { deliveries: [{ ...opening.deliveries[0], deliveredAt: worldNow - 1 }] },
      ['deliveries', 0, 'deliveredAt'],
    ],
    [
      'a letter delivered twice',
      { deliveries: [opening.deliveries[0], opening.deliveries[0]] },
      ['deliveries', 1, 'letterId'],
    ],
  ])('refuses %s', (_label, change, path) => {
    expect(
      issuePaths(LetterOpenResponseSchema.safeParse({ ...opening, ...change })),
    ).toContainEqual(path);
  });
});

describe('LetterDeliverySchema', () => {
  const delivery = opening.deliveries[0];

  it('round-trips a delivery', () => {
    const { parsed, reparsed } = roundTrip(LetterDeliverySchema, delivery);
    expect(reparsed).toEqual(parsed);
  });

  it.each([
    ['an arc of another guest', { guest: 'madameLune' }, ['arc']],
    ['a letter of another arc', { letterId: 'baronVoss.regatta.4' }, ['letterId']],
  ])('refuses %s', (_label, change, path) => {
    expect(issuePaths(LetterDeliverySchema.safeParse({ ...delivery, ...change }))).toContainEqual(
      path,
    );
  });
});

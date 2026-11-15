import { describe, expect, it } from 'vitest';
import { ClaimWithPropsSchema } from '../props/claims.ts';
import { roundTrip } from '../../test/roundTrip.ts';
import { worldBreeds, worldFetchPlan, worldFixtures, worldKennel, worldPets } from './fixtures.ts';
import {
  PET_GUTTERS,
  PET_SPECIES,
  PetBreedRollSchema,
  PetBreedSchema,
  PetCompanionRequestSchema,
  PetCrateOpenRequestSchema,
  PetCrateOpenResponseSchema,
  PetFetchClaimSchema,
  PetFetchPlanSchema,
  PetFetchSchema,
  PetSchema,
  PetsResponseSchema,
} from './pets.ts';

const opened = worldFixtures.worldPetCrateOpen.response;
const { poodle, cat, parrot } = worldPets;
const issuePaths = (result: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path);
const fetchClaim = { kind: 'petFetch', coinId: 'coin_Fetch0000042', tick: 58_020, gutter: 'left' };

describe('pet species and breeds', () => {
  it('offers the poodle, the cat and the parrot', () => {
    expect(PET_SPECIES).toEqual(['poodle', 'cat', 'parrot']);
  });

  it('gives every species breed variations to collect', () => {
    for (const species of PET_SPECIES) {
      expect(worldBreeds.filter((breed) => breed.species === species).length).toBeGreaterThan(1);
    }
  });

  it.each(worldBreeds)('round-trips the $id breed', (breed) => {
    const { parsed, reparsed } = roundTrip(PetBreedSchema, breed);
    expect(reparsed).toEqual(parsed);
  });

  it.each([
    ['a breed keyed under another species', { id: 'cat.apricot' }, ['id']],
    ['a breed with no species segment', { id: 'apricot' }, ['id']],
  ])('refuses %s', (_label, change, path) => {
    expect(issuePaths(PetBreedSchema.safeParse({ ...worldBreeds[0], ...change }))).toContainEqual(
      path,
    );
  });

  it.each([
    ['an unknown species', { species: 'hamster' }],
    ['a negative count', { owned: -1 }],
  ])('refuses %s', (_label, change) => {
    expect(PetBreedSchema.safeParse({ ...worldBreeds[0], ...change }).success).toBe(false);
  });
});

describe('PetSchema', () => {
  it.each(Object.values(worldPets))('round-trips the $species', (pet) => {
    const { parsed, reparsed } = roundTrip(PetSchema, pet);
    expect(reparsed).toEqual(parsed);
  });

  it('accepts a pet at its maximum level with no next level', () => {
    const top = { ...poodle, level: 10, fetches: 900, nextLevel: null };
    expect(PetSchema.safeParse(top).error).toBeUndefined();
  });

  it.each([
    ['a coat of another species', { breed: 'cat.siamese' }, ['breed']],
    ['a level past the maximum', { level: 11, nextLevel: null }, ['level']],
    ['a pet below its maximum with no next level', { nextLevel: null }, ['nextLevel']],
    [
      'a pet at its maximum with a next level',
      { level: 10, nextLevel: { level: 11, fetches: 999 } },
      ['nextLevel'],
    ],
    ['a next level that skips one', { nextLevel: { level: 5, fetches: 60 } }, ['nextLevel']],
    ['a next level already earned', { nextLevel: { level: 4, fetches: 42 } }, ['nextLevel']],
  ])('refuses %s', (_label, change, path) => {
    expect(issuePaths(PetSchema.safeParse({ ...poodle, ...change }))).toContainEqual(path);
  });
});

describe('PetFetchPlanSchema', () => {
  it('round-trips the seeded schedule', () => {
    const { parsed, reparsed } = roundTrip(PetFetchPlanSchema, worldFetchPlan);
    expect(reparsed).toEqual(parsed);
  });

  it('accepts a fixed interval', () => {
    const fixed = { ...worldFetchPlan, minIntervalTicks: 6_000, maxIntervalTicks: 6_000 };
    expect(PetFetchPlanSchema.safeParse(fixed).success).toBe(true);
  });

  it.each([
    ['an interval that runs backwards', { minIntervalTicks: 9_001 }],
    ['a zero interval', { minIntervalTicks: 0 }],
    ['a seed past 32 bits', { seed: 0x1_0000_0000 }],
    ['a negative seed', { seed: -1 }],
  ])('refuses %s', (_label, change) => {
    expect(PetFetchPlanSchema.safeParse({ ...worldFetchPlan, ...change }).success).toBe(false);
  });
});

describe('PetsResponseSchema', () => {
  it('round-trips the kennel', () => {
    const { parsed, reparsed } = roundTrip(PetsResponseSchema, worldKennel);
    expect(reparsed).toEqual(parsed);
  });

  it('accepts a player with no pet yet, every pet resting', () => {
    const empty = {
      ...worldKennel,
      pets: [],
      companion: null,
      breeds: worldBreeds.map((breed) => ({ ...breed, owned: 0 })),
    };
    expect(PetsResponseSchema.safeParse(empty).error).toBeUndefined();
  });

  it.each([
    ['pets out of kennel order', { pets: [cat, poodle] }, ['pets', 1, 'species']],
    ['a species adopted twice', { pets: [poodle, poodle] }, ['pets', 1, 'species']],
    [
      'a pet in a coat the player lacks',
      { pets: [{ ...poodle, breed: 'poodle.blackRoyal' }, cat] },
      ['pets', 0, 'breed'],
    ],
    ['an owned breed of a species not adopted', { pets: [poodle] }, ['breeds', 3, 'owned']],
    [
      'a companion not adopted',
      { companion: { species: 'parrot', plan: { ...worldFetchPlan, species: 'parrot' } } },
      ['companion', 'species'],
    ],
    [
      'a fetch plan for another species',
      { companion: { species: 'poodle', plan: { ...worldFetchPlan, species: 'cat' } } },
      ['companion', 'plan', 'species'],
    ],
    [
      'a fetch plan for another level',
      { companion: { species: 'poodle', plan: { ...worldFetchPlan, level: 2 } } },
      ['companion', 'plan', 'level'],
    ],
    ['a breed listed twice', { breeds: [...worldBreeds, worldBreeds[0]] }, ['breeds', 7, 'id']],
    [
      'a breed whose rarity has no odds',
      {
        breeds: [
          ...worldBreeds,
          { id: 'cat.sphynx', species: 'cat', rarity: 'heirloom', owned: 0 },
        ],
      },
      ['breeds', 7, 'rarity'],
    ],
    [
      'odds that can land on no breed',
      {
        odds: [
          { rarity: 'fine', chanceBp: 6_000 },
          { rarity: 'rare', chanceBp: 3_000 },
          { rarity: 'exquisite', chanceBp: 500 },
          { rarity: 'legendary', chanceBp: 500 },
        ],
      },
      ['odds', 2, 'rarity'],
    ],
  ])('refuses %s', (_label, change, path) => {
    expect(issuePaths(PetsResponseSchema.safeParse({ ...worldKennel, ...change }))).toContainEqual(
      path,
    );
  });

  it.each([
    ['an empty breed book', { breeds: [] }],
    ['odds short of 100 %', { odds: worldKennel.odds.slice(1) }],
    ['a pity at its limit', { pity: { ...worldKennel.pity, since: 40 } }],
  ])('refuses %s', (_label, change) => {
    expect(PetsResponseSchema.safeParse({ ...worldKennel, ...change }).success).toBe(false);
  });
});

describe('choosing a companion', () => {
  it('names a coat only, or null to send every pet to rest', () => {
    expect(PetCompanionRequestSchema.parse({ breed: 'cat.siamese' })).toEqual({
      breed: 'cat.siamese',
    });
    expect(PetCompanionRequestSchema.parse({ breed: null })).toEqual({ breed: null });
  });

  it.each([
    ['a level', { level: 10 }],
    ['a fetch plan', { plan: worldFetchPlan }],
    ['a seed', { seed: 1 }],
  ])('refuses a request that carries %s', (_label, extra) => {
    const result = PetCompanionRequestSchema.safeParse({ breed: 'cat.siamese', ...extra });
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
  });

  it('answers with the kennel and the new companion’s plan', () => {
    const answer = PetsResponseSchema.parse(worldFixtures.worldPetCompanion.response);
    expect(answer.companion?.species).toBe('cat');
  });
});

describe('opening a crate for a breed', () => {
  it('asks for the crate id only', () => {
    for (const extra of [{ rarity: 'legendary' }, { breed: 'poodle.blackRoyal' }, { nonce: 1 }]) {
      const result = PetCrateOpenRequestSchema.safeParse({ crateId: 'crate_Kennel0001', ...extra });
      expect(result.error?.issues[0]?.code, JSON.stringify(extra)).toBe('unrecognized_keys');
    }
  });

  it('round-trips the answer, with its fairness proof', () => {
    const { parsed, reparsed } = roundTrip(PetCrateOpenResponseSchema, opened);
    expect(reparsed).toEqual(parsed);
    expect(parsed.proof.nonce).toBe(412);
  });

  it('marks a repeat as a duplicate', () => {
    const repeat = { ...opened.roll, owned: 2, duplicate: true };
    expect(PetBreedRollSchema.safeParse(repeat).success).toBe(true);
    expect(issuePaths(PetBreedRollSchema.safeParse({ ...repeat, duplicate: false }))).toEqual([
      ['duplicate'],
    ]);
    expect(issuePaths(PetBreedRollSchema.safeParse({ ...opened.roll, duplicate: true }))).toEqual([
      ['duplicate'],
    ]);
  });

  it.each([
    [
      'a roll of a breed keyed under another species',
      { roll: { ...opened.roll, species: 'cat' } },
      ['roll', 'breed'],
    ],
    ['a rolled species not in the kennel', { pets: [poodle, cat] }, ['pets']],
  ])('refuses %s', (_label, change, path) => {
    expect(
      issuePaths(PetCrateOpenResponseSchema.safeParse({ ...opened, ...change })),
    ).toContainEqual(path);
  });

  it('refuses an answer with no proof', () => {
    expect(PetCrateOpenResponseSchema.safeParse({ ...opened, proof: null }).success).toBe(false);
  });

  it('carries the parrot the roll adopted', () => {
    expect(PetCrateOpenResponseSchema.parse(opened).pets.at(-1)).toEqual(parrot);
  });
});

describe('fetching a gutter coin', () => {
  it('fetches only from the side gutters', () => {
    expect(PET_GUTTERS).toEqual(['left', 'right']);
    expect(PetFetchClaimSchema.safeParse({ ...fetchClaim, gutter: 'front' }).success).toBe(false);
  });

  it('names the coin by its own id and round-trips', () => {
    const { parsed, reparsed } = roundTrip(PetFetchClaimSchema, fetchClaim);
    expect(reparsed).toEqual(parsed);
  });

  it.each([
    ['a coin value', { value: 500 }],
    ['a coin tier', { tier: 'gold' }],
    ['a new coin', { mintedCoinId: 'coin_Fresh0000001' }],
    ['a level', { level: 4 }],
    ['a reward', { reward: { kind: 'currency', currency: 'coins', amount: 1 } }],
  ])('refuses a fetch claim that carries %s', (_label, extra) => {
    const result = PetFetchClaimSchema.safeParse({ ...fetchClaim, ...extra });
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
  });

  it('stays out of the live claim union until the server settles it', () => {
    expect(ClaimWithPropsSchema.safeParse(fetchClaim).success).toBe(false);
  });

  it('round-trips a credited fetch', () => {
    const credited = {
      coinId: fetchClaim.coinId,
      species: 'poodle',
      tick: fetchClaim.tick,
      fetches: 60,
      level: 4,
      leveledUp: true,
    };
    const { parsed, reparsed } = roundTrip(PetFetchSchema, credited);
    expect(reparsed).toEqual(parsed);
    expect(PetFetchSchema.safeParse({ ...credited, fetches: 0 }).success).toBe(false);
  });
});

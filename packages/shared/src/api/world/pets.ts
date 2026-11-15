import { z } from 'zod';
import { RaritySchema, WalletSchema } from '../../domain.ts';
import { FairProofSchema } from '../../fair.ts';
import { CoinIdSchema, CrateIdSchema } from '../../ids.ts';
import { AmountSchema, EpochMsSchema, PositiveAmountSchema, TickSchema } from '../../primitives.ts';
import { LiveGrantSchema, LiveOddsSchema, LivePitySchema } from '../liveEvents/rewards.ts';
import { PetBreedIdSchema, isKeyedUnder } from './ids.ts';
import { checkUnique } from './refine.ts';

/** The companions on offer (00-VISION, pet companion), in the order the kennel lists them. */
export const PET_SPECIES = ['poodle', 'cat', 'parrot'] as const;
export const PetSpeciesSchema = z.enum(PET_SPECIES);
export type PetSpecies = z.infer<typeof PetSpeciesSchema>;

/** The side gutters a pet fetches from; the front ledge pays out, so nothing is fetched there. */
export const PET_GUTTERS = ['left', 'right'] as const;
export const PetGutterSchema = z.enum(PET_GUTTERS);
export type PetGutter = z.infer<typeof PetGutterSchema>;

export const PetFetchSeedSchema = z.int().min(0).max(0xffff_ffff);
export type PetFetchSeed = z.infer<typeof PetFetchSeedSchema>;

function checkBreedOf(
  breed: string,
  species: PetSpecies,
  ctx: z.RefinementCtx,
  path: PropertyKey[],
): void {
  if (!isKeyedUnder(breed, species)) {
    ctx.addIssue({
      code: 'custom',
      path,
      message: `Breed ${breed} is not a ${species}; breeds are keyed "${species}.<breed>".`,
    });
  }
}

/** One breed in the kennel book, with how many the player owns; extra copies are duplicates. */
export const PetBreedSchema = z
  .object({
    id: PetBreedIdSchema,
    species: PetSpeciesSchema,
    rarity: RaritySchema,
    owned: AmountSchema,
  })
  .superRefine((breed, ctx) => {
    checkBreedOf(breed.id, breed.species, ctx, ['id']);
  });
export type PetBreed = z.infer<typeof PetBreedSchema>;

/** The next level on offer: reached once the server has credited `fetches` fetches in all. */
export const PetNextLevelSchema = z.object({
  level: PositiveAmountSchema,
  fetches: PositiveAmountSchema,
});
export type PetNextLevel = z.infer<typeof PetNextLevelSchema>;

/**
 * One adopted companion as the server keeps it. `breed` is the coat it wears, one the player owns.
 * `fetches` counts every fetch the server credited; the level they earn, and the fetch rate each
 * level brings, are `packages/economy` numbers.
 */
export const PetSchema = z
  .object({
    species: PetSpeciesSchema,
    breed: PetBreedIdSchema,
    level: PositiveAmountSchema,
    maxLevel: PositiveAmountSchema,
    fetches: AmountSchema,
    /** `null` once `level` reaches `maxLevel`. */
    nextLevel: PetNextLevelSchema.nullable(),
  })
  .superRefine((pet, ctx) => {
    const issue = (path: string, message: string) => {
      ctx.addIssue({ code: 'custom', path: [path], message });
    };
    checkBreedOf(pet.breed, pet.species, ctx, ['breed']);
    if (pet.level > pet.maxLevel) {
      issue('level', `Level ${pet.level} is past the maximum of ${pet.maxLevel}.`);
    } else if ((pet.level === pet.maxLevel) !== (pet.nextLevel === null)) {
      issue('nextLevel', 'A pet has a next level exactly when it is below its maximum.');
    }
    if (pet.nextLevel === null) return;
    if (pet.nextLevel.level !== pet.level + 1) {
      issue('nextLevel', `The next level is ${pet.level + 1}.`);
    }
    if (pet.nextLevel.fetches <= pet.fetches) {
      issue('nextLevel', 'A level already earned has been reached.');
    }
  });
export type Pet = z.infer<typeof PetSchema>;

/**
 * The seeded schedule `packages/sim` fetches on (T-14.08): from `seed`, each next fetch falls
 * `minIntervalTicks` to `maxIntervalTicks` after the last. The server sets the interval from the
 * pet's level and replays the same schedule, so a fetch off schedule is refused.
 */
export const PetFetchPlanSchema = z
  .object({
    species: PetSpeciesSchema,
    level: PositiveAmountSchema,
    seed: PetFetchSeedSchema,
    minIntervalTicks: PositiveAmountSchema,
    maxIntervalTicks: PositiveAmountSchema,
  })
  .refine((plan) => plan.minIntervalTicks <= plan.maxIntervalTicks, {
    path: ['maxIntervalTicks'],
    message: 'The longest interval is no shorter than the shortest.',
  });
export type PetFetchPlan = z.infer<typeof PetFetchPlanSchema>;

const PetsSchema = z.array(PetSchema).superRefine((pets, ctx) => {
  pets.forEach((pet, i) => {
    const previous = pets[i - 1];
    if (
      previous !== undefined &&
      PET_SPECIES.indexOf(previous.species) >= PET_SPECIES.indexOf(pet.species)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: [i, 'species'],
        message: `Pets are listed once each, as ${PET_SPECIES.join(', ')}.`,
      });
    }
  });
});

const CompanionSchema = z
  .object({ species: PetSpeciesSchema, plan: PetFetchPlanSchema })
  .refine((companion) => companion.plan.species === companion.species, {
    path: ['plan', 'species'],
    message: "The fetch plan is the companion's own.",
  });

/**
 * The kennel: adopted pets, the one at the table (`companion`, `null` while every pet rests), the
 * breed book, and the odds and pity a breed roll uses, shown before any roll.
 */
export const PetsResponseSchema = z
  .object({
    serverTime: EpochMsSchema,
    pets: PetsSchema,
    companion: CompanionSchema.nullable(),
    breeds: z.array(PetBreedSchema).min(1),
    odds: LiveOddsSchema,
    pity: LivePitySchema,
  })
  .superRefine((kennel, ctx) => {
    const issue = (path: PropertyKey[], message: string) => {
      ctx.addIssue({ code: 'custom', path, message });
    };
    checkUnique(
      kennel.breeds,
      (breed) => breed.id,
      ctx,
      (i) => ['breeds', i, 'id'],
      'Each breed is listed once.',
    );
    const breeds = new Map(kennel.breeds.map((breed) => [breed.id as string, breed]));
    kennel.pets.forEach((pet, i) => {
      if ((breeds.get(pet.breed)?.owned ?? 0) === 0) {
        issue(['pets', i, 'breed'], `A pet wears a breed the player owns, not ${pet.breed}.`);
      }
    });
    const adopted = new Set(kennel.pets.map((pet) => pet.species));
    kennel.breeds.forEach((breed, i) => {
      if (breed.owned > 0 && !adopted.has(breed.species)) {
        issue(['breeds', i, 'owned'], `Owning a ${breed.species} breed adopts that species.`);
      }
    });
    if (kennel.companion !== null) {
      const pet = kennel.pets.find((candidate) => candidate.species === kennel.companion?.species);
      if (pet === undefined) {
        issue(['companion', 'species'], 'The companion is an adopted pet.');
      } else if (pet.level !== kennel.companion.plan.level) {
        issue(['companion', 'plan', 'level'], "The fetch plan is set for the pet's level.");
      }
    }
    const rarities = new Set(kennel.odds.map((row) => row.rarity));
    const bred = new Set(kennel.breeds.map((breed) => breed.rarity));
    kennel.breeds.forEach((breed, i) => {
      if (!rarities.has(breed.rarity)) {
        issue(['breeds', i, 'rarity'], `The odds sheet has no ${breed.rarity} row for this breed.`);
      }
    });
    kennel.odds.forEach((row, i) => {
      if (!bred.has(row.rarity)) {
        issue(['odds', i, 'rarity'], `No ${row.rarity} breed exists for a roll to land on.`);
      }
    });
  });
export type PetsResponse = z.infer<typeof PetsResponseSchema>;

/** Puts a pet at the table in the coat named, or sends every pet to rest with `null`. */
export const PetCompanionRequestSchema = z.strictObject({
  breed: PetBreedIdSchema.nullable(),
});
export type PetCompanionRequest = z.infer<typeof PetCompanionRequestSchema>;

/** Opens a crate the player holds for a breed roll; the server checks the crate rolls breeds. */
export const PetCrateOpenRequestSchema = z.strictObject({
  crateId: CrateIdSchema,
});
export type PetCrateOpenRequest = z.infer<typeof PetCrateOpenRequestSchema>;

/** The breed a crate rolled: `owned` counts copies after this one, so a repeat is a duplicate. */
export const PetBreedRollSchema = z
  .object({
    breed: PetBreedIdSchema,
    species: PetSpeciesSchema,
    rarity: RaritySchema,
    owned: PositiveAmountSchema,
    duplicate: z.boolean(),
  })
  .superRefine((roll, ctx) => {
    checkBreedOf(roll.breed, roll.species, ctx, ['breed']);
    if (roll.duplicate !== roll.owned > 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['duplicate'],
        message: 'A roll is a duplicate exactly when the breed was already owned.',
      });
    }
  });
export type PetBreedRoll = z.infer<typeof PetBreedRollSchema>;

/**
 * Idempotent per crate: a repeat returns the same roll. The breed is rolled with fair RNG under
 * the pity shown in the kennel; `pity` is the counter after this roll, `granted` anything a
 * duplicate converts into, and `pets` the kennel's pets after the roll.
 */
export const PetCrateOpenResponseSchema = z
  .object({
    crateId: CrateIdSchema,
    openedAt: EpochMsSchema,
    roll: PetBreedRollSchema,
    proof: FairProofSchema,
    pity: LivePitySchema,
    granted: z.array(LiveGrantSchema),
    pets: PetsSchema,
    wallet: WalletSchema,
  })
  .superRefine((answer, ctx) => {
    if (!answer.pets.some((pet) => pet.species === answer.roll.species)) {
      ctx.addIssue({
        code: 'custom',
        path: ['pets'],
        message: `A ${answer.roll.species} breed rolled adopts a ${answer.roll.species}.`,
      });
    }
  });
export type PetCrateOpenResponse = z.infer<typeof PetCrateOpenResponseSchema>;

/**
 * The companion caught a coin falling into a side gutter and set it back on the table. The coin
 * keeps its own id and stored value: nothing is minted. The server checks the coin was on its
 * table and the tick is on the companion's seeded schedule; the claim names ids only.
 */
export const PetFetchClaimSchema = z.strictObject({
  kind: z.literal('petFetch'),
  coinId: CoinIdSchema,
  tick: TickSchema,
  gutter: PetGutterSchema,
});
export type PetFetchClaim = z.infer<typeof PetFetchClaimSchema>;

/** A fetch the server credited, so the pet's fetch animation, chime and level-up play from it. */
export const PetFetchSchema = z.object({
  coinId: CoinIdSchema,
  species: PetSpeciesSchema,
  tick: TickSchema,
  fetches: PositiveAmountSchema,
  level: PositiveAmountSchema,
  leveledUp: z.boolean(),
});
export type PetFetch = z.infer<typeof PetFetchSchema>;

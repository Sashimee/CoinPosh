import { get, post, type Endpoint } from '../endpoint.ts';
import { ConditionsResponseSchema } from './conditions.ts';
import {
  LetterOpenRequestSchema,
  LetterOpenResponseSchema,
  LettersResponseSchema,
} from './letters.ts';
import {
  PetCompanionRequestSchema,
  PetCrateOpenRequestSchema,
  PetCrateOpenResponseSchema,
  PetsResponseSchema,
} from './pets.ts';

// TODO(lead-architect): pass to `composeEndpoints` in `../endpoints.ts` in T-14.12, the same
// change that adds `worldFixtures` to `test/fixtures.ts` and the Demo handlers; both are mapped
// over every EndpointName, so registering the group first breaks their typecheck. Letters
// delivered and fetches credited on the table ride the table answers as a `WorldUpdate`.
/** World (M14): guest letters, pets and their breeds, and every venue's local time and weather. */
export const worldEndpoints = {
  worldLetters: get('/v1/world/letters', LettersResponseSchema),
  worldLetterOpen: post(
    '/v1/world/letters/open',
    LetterOpenRequestSchema,
    LetterOpenResponseSchema,
  ),
  worldPets: get('/v1/world/pets', PetsResponseSchema),
  worldPetCompanion: post(
    '/v1/world/pets/companion',
    PetCompanionRequestSchema,
    PetsResponseSchema,
  ),
  worldPetCrateOpen: post(
    '/v1/world/pets/crate/open',
    PetCrateOpenRequestSchema,
    PetCrateOpenResponseSchema,
  ),
  worldConditions: get('/v1/world/conditions', ConditionsResponseSchema),
} as const satisfies Record<string, Endpoint>;

export type WorldEndpoints = typeof worldEndpoints;
export type WorldEndpointName = keyof WorldEndpoints;
export const WORLD_ENDPOINT_NAMES = Object.keys(worldEndpoints) as WorldEndpointName[];

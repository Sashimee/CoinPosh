import type { z } from 'zod';
import type { LiveOddsSchema } from '../liveEvents/rewards.ts';
import type { VenueConditionsSchema } from './conditions.ts';
import { CLEAR_SKY } from './conditions.ts';
import type { WorldEndpointName, WorldEndpoints } from './endpoints.ts';
import type { GuestArcSchema, LetterSchema, WorldGuestSchema } from './letters.ts';
import type { PetBreedSchema, PetFetchPlanSchema, PetSchema, PetsResponseSchema } from './pets.ts';
import type { WorldUpdateSchema } from './update.ts';

type BodyInput<N extends WorldEndpointName> = WorldEndpoints[N]['body'] extends z.ZodType
  ? z.input<WorldEndpoints[N]['body']>
  : never;

type BodyField<N extends WorldEndpointName> = [BodyInput<N>] extends [never]
  ? object
  : { body: BodyInput<N> };

export type WorldEndpointFixture<N extends WorldEndpointName> = BodyField<N> & {
  response: z.input<WorldEndpoints[N]['response']>;
};

type LetterInput = z.input<typeof LetterSchema>;
type ArcInput = z.input<typeof GuestArcSchema>;

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
/** Sunday 2026-11-15, 09:30 UTC: mid-morning in Paris and Monaco, evening in Tokyo. */
export const worldNow = 1_794_735_000_000;
const utcDayStart = 1_794_700_800_000;

const wallet = {
  coins: 48_210,
  bullion: 6,
  goldBars: 1,
  pearls: 63,
  keys: 3,
  tickets: 2,
  stars: 0,
};

export const worldGuests = {
  countessVane: { id: 'countessVane', seal: 'crimsonCrest' },
  baronVoss: { id: 'baronVoss', seal: 'emeraldStag' },
  madameLune: { id: 'madameLune', seal: 'ivoryMoon' },
} satisfies Record<string, z.input<typeof WorldGuestSchema>>;

function opened(
  arc: string,
  index: number,
  deliveredAt: number,
  granted: Extract<LetterInput, { status: 'opened' }>['granted'],
): LetterInput {
  return {
    id: `${arc}.${index}`,
    index,
    status: 'opened',
    deliveredAt,
    openedAt: deliveredAt + hour,
    granted,
  };
}

function sealed(
  arc: string,
  index: number,
  conditions: Extract<LetterInput, { status: 'sealed' }>['conditions'],
  rewards: Extract<LetterInput, { status: 'sealed' }>['rewards'],
): LetterInput {
  return { id: `${arc}.${index}`, index, status: 'sealed', conditions, rewards };
}

const afterLetter = (arc: string, index: number) =>
  ({ kind: 'letter', letter: `${arc}.${index}`, met: false }) as const;

const inheritance = 'countessVane.inheritance';
const regatta = 'baronVoss.regatta';
const seance = 'madameLune.seance';

/**
 * Three arcs in three states: the Countess's half told with letter 3 waiting in its seal, the
 * Baron's finished, and Madame Lune's still teased behind a venue unlock.
 */
export const worldArcs = {
  inProgress: {
    id: inheritance,
    guest: 'countessVane',
    letters: [
      opened(inheritance, 1, worldNow - 3 * day, [
        { kind: 'currency', currency: 'coins', amount: 2_000 },
      ]),
      opened(inheritance, 2, worldNow - 2 * day, [{ kind: 'repute', amount: 60 }]),
      {
        id: `${inheritance}.3`,
        index: 3,
        status: 'delivered',
        deliveredAt: worldNow - hour,
        rewards: [{ kind: 'currency', currency: 'pearls', amount: 5 }],
      },
      sealed(inheritance, 4, [afterLetter(inheritance, 3)], [{ kind: 'repute', amount: 80 }]),
      sealed(
        inheritance,
        5,
        [
          afterLetter(inheritance, 4),
          { kind: 'progress', key: 'ascensions', target: 1, progress: 0 },
        ],
        [{ kind: 'crate', rarity: 'exquisite' }],
      ),
    ],
    completedAt: null,
  },
  complete: {
    id: regatta,
    guest: 'baronVoss',
    letters: [1, 2, 3, 4, 5].map((index) =>
      opened(regatta, index, worldNow - (21 - index * 2) * day, [{ kind: 'repute', amount: 40 }]),
    ),
    completedAt: worldNow - 11 * day + hour,
  },
  teased: {
    id: seance,
    guest: 'madameLune',
    letters: [
      sealed(
        seance,
        1,
        [{ kind: 'progress', key: 'venuesUnlocked', target: 2, progress: 1 }],
        [{ kind: 'currency', currency: 'pearls', amount: 3 }],
      ),
      sealed(
        seance,
        2,
        [afterLetter(seance, 1), { kind: 'postedAt', at: worldNow + 2 * day }],
        [{ kind: 'repute', amount: 50 }],
      ),
      sealed(
        seance,
        3,
        [afterLetter(seance, 2)],
        [{ kind: 'currency', currency: 'keys', amount: 1 }],
      ),
      sealed(seance, 4, [afterLetter(seance, 3)], [{ kind: 'repute', amount: 90 }]),
      sealed(
        seance,
        5,
        [afterLetter(seance, 4)],
        [{ kind: 'cosmetic', cosmetic: 'crystalBallLamp' }],
      ),
    ],
    completedAt: null,
  },
} satisfies Record<string, ArcInput>;

const letterThreeOpened = {
  ...worldArcs.inProgress,
  letters: worldArcs.inProgress.letters.map((letter, i): LetterInput => {
    if (i === 2) {
      return {
        id: `${inheritance}.3`,
        index: 3,
        status: 'opened',
        deliveredAt: worldNow - hour,
        openedAt: worldNow,
        granted: [{ kind: 'currency', currency: 'pearls', amount: 5 }],
      };
    }
    if (i === 3) {
      return {
        id: `${inheritance}.4`,
        index: 4,
        status: 'delivered',
        deliveredAt: worldNow,
        rewards: [{ kind: 'repute', amount: 80 }],
      };
    }
    return letter;
  }),
} satisfies ArcInput;

/** The breed book: three species, three rarities, two species adopted. */
export const worldBreeds = [
  { id: 'poodle.apricot', species: 'poodle', rarity: 'fine', owned: 1 },
  { id: 'poodle.silverStandard', species: 'poodle', rarity: 'rare', owned: 2 },
  { id: 'poodle.blackRoyal', species: 'poodle', rarity: 'legendary', owned: 0 },
  { id: 'cat.siamese', species: 'cat', rarity: 'fine', owned: 1 },
  { id: 'cat.persianSmoke', species: 'cat', rarity: 'rare', owned: 0 },
  { id: 'parrot.scarletMacaw', species: 'parrot', rarity: 'rare', owned: 0 },
  { id: 'parrot.hyacinthMacaw', species: 'parrot', rarity: 'legendary', owned: 0 },
] satisfies z.input<typeof PetBreedSchema>[];

export const worldPets = {
  poodle: {
    species: 'poodle',
    breed: 'poodle.silverStandard',
    level: 3,
    maxLevel: 10,
    fetches: 42,
    nextLevel: { level: 4, fetches: 60 },
  },
  cat: {
    species: 'cat',
    breed: 'cat.siamese',
    level: 1,
    maxLevel: 10,
    fetches: 0,
    nextLevel: { level: 2, fetches: 10 },
  },
  parrot: {
    species: 'parrot',
    breed: 'parrot.scarletMacaw',
    level: 1,
    maxLevel: 10,
    fetches: 0,
    nextLevel: { level: 2, fetches: 10 },
  },
} satisfies Record<string, z.input<typeof PetSchema>>;

export const worldFetchPlan = {
  species: 'poodle',
  level: 3,
  seed: 3_141_592_653,
  minIntervalTicks: 5_400,
  maxIntervalTicks: 9_000,
} satisfies z.input<typeof PetFetchPlanSchema>;

const breedOdds = [
  { rarity: 'fine', chanceBp: 6_500 },
  { rarity: 'rare', chanceBp: 3_000 },
  { rarity: 'legendary', chanceBp: 500 },
] satisfies z.input<typeof LiveOddsSchema>;

export const worldKennel = {
  serverTime: worldNow,
  pets: [worldPets.poodle, worldPets.cat],
  companion: { species: 'poodle', plan: worldFetchPlan },
  breeds: worldBreeds,
  odds: breedOdds,
  pity: { guaranteed: 'legendary', within: 40, since: 17 },
} satisfies z.input<typeof PetsResponseSchema>;

const feed = (observedAt: number) => ({ source: 'feed', observedAt }) as const;
const sun = (riseUtc: number, setUtc: number) => ({
  riseAt: utcDayStart + riseUtc,
  setAt: utcDayStart + setUtc,
});

/** Every venue on a November Sunday morning; the orbital casino shows the clear-sky fallback. */
export const worldVenueConditions = [
  {
    venue: 'rivieraYacht',
    timeZone: 'Europe/Monaco',
    utcOffsetMinutes: 60,
    sun: sun(6 * hour + 25 * minute, 16 * hour + 5 * minute),
    weather: { kind: 'clear', intensity: 0, cloudCover: 0.1, temperatureC: 16 },
    ...feed(worldNow - 10 * minute),
  },
  {
    venue: 'salonDeParis',
    timeZone: 'Europe/Paris',
    utcOffsetMinutes: 60,
    sun: sun(6 * hour + 58 * minute, 16 * hour + 13 * minute),
    weather: { kind: 'rain', intensity: 0.4, cloudCover: 0.9, temperatureC: 9 },
    ...feed(worldNow - 10 * minute),
  },
  {
    venue: 'tokyoPenthouse',
    timeZone: 'Asia/Tokyo',
    utcOffsetMinutes: 540,
    sun: sun(-(2 * hour + 45 * minute), 7 * hour + 35 * minute),
    weather: { kind: 'cloudy', intensity: 0.5, cloudCover: 0.6, temperatureC: 14 },
    ...feed(worldNow - 12 * minute),
  },
  {
    venue: 'alpineChalet',
    timeZone: 'Europe/Zurich',
    utcOffsetMinutes: 60,
    sun: sun(6 * hour + 35 * minute, 15 * hour + 50 * minute),
    weather: { kind: 'snow', intensity: 0.6, cloudCover: 1, temperatureC: -2 },
    ...feed(worldNow - 10 * minute),
  },
  {
    venue: 'orbitalCasino',
    timeZone: 'UTC',
    utcOffsetMinutes: 0,
    sun: null,
    weather: CLEAR_SKY,
    source: 'fallback',
    observedAt: null,
  },
] satisfies z.input<typeof VenueConditionsSchema>[];

/** A claim batch in which the poodle fetched twice, the second time reaching level 4. */
export const worldUpdate = {
  deliveries: [
    {
      letterId: `${seance}.1`,
      arc: seance,
      guest: 'madameLune',
      deliveredAt: worldNow,
    },
  ],
  fetches: [
    {
      coinId: 'coin_Fetch0000041',
      species: 'poodle',
      tick: 51_300,
      fetches: 59,
      level: 3,
      leveledUp: false,
    },
    {
      coinId: 'coin_Fetch0000042',
      species: 'poodle',
      tick: 58_020,
      fetches: 60,
      level: 4,
      leveledUp: true,
    },
  ],
} satisfies z.input<typeof WorldUpdateSchema>;

/** One valid wire example per world endpoint; the mapped type fails to compile if one is missing. */
export const worldFixtures: { [N in WorldEndpointName]: WorldEndpointFixture<N> } = {
  worldLetters: {
    response: {
      serverTime: worldNow,
      guests: [worldGuests.countessVane, worldGuests.baronVoss, worldGuests.madameLune],
      arcs: [worldArcs.inProgress, worldArcs.complete, worldArcs.teased],
      unread: 1,
    },
  },
  worldLetterOpen: {
    body: { letterId: `${inheritance}.3` },
    response: {
      letterId: `${inheritance}.3`,
      openedAt: worldNow,
      arc: letterThreeOpened,
      granted: [{ kind: 'currency', currency: 'pearls', amount: 5 }],
      deliveries: [
        {
          letterId: `${inheritance}.4`,
          arc: inheritance,
          guest: 'countessVane',
          deliveredAt: worldNow,
        },
      ],
      wallet,
    },
  },
  worldPets: { response: worldKennel },
  worldPetCompanion: {
    body: { breed: 'cat.siamese' },
    response: {
      ...worldKennel,
      companion: {
        species: 'cat',
        plan: { ...worldFetchPlan, species: 'cat', level: 1, seed: 2_718_281_828 },
      },
    },
  },
  worldPetCrateOpen: {
    body: { crateId: 'crate_Kennel0001' },
    response: {
      crateId: 'crate_Kennel0001',
      openedAt: worldNow,
      roll: {
        breed: 'parrot.scarletMacaw',
        species: 'parrot',
        rarity: 'rare',
        owned: 1,
        duplicate: false,
      },
      proof: {
        serverSeedHash: '8e2c4a6f0b1d3e5f7a9c1b3d5f7e9a0c2e4b6d8f1a3c5e7b9d0f2a4c6e8b1d3f',
        clientSeed: 'velvet-rope-42',
        nonce: 412,
      },
      pity: { guaranteed: 'legendary', within: 40, since: 18 },
      granted: [],
      pets: [worldPets.poodle, worldPets.cat, worldPets.parrot],
      wallet,
    },
  },
  worldConditions: {
    response: {
      serverTime: worldNow,
      refreshAt: worldNow + 20 * minute,
      venues: worldVenueConditions,
    },
  },
};

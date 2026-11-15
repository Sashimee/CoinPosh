import type { z } from 'zod';
import type { BossResponseSchema, BossSchema, BossStatus, BossTiersSchema } from './boss.ts';
import type {
  CalendarRollSchema,
  CalendarSlotSchema,
  CalendarTrackStateSchema,
} from './calendars.ts';
import type { LiveEventsEndpointName, LiveEventsEndpoints } from './endpoints.ts';
import type { DailyPuzzleSchema, PuzzleResultSchema } from './puzzle.ts';
import type { LimitedCollectionSchema, LiveThemeSchema } from './themes.ts';
import type { PlayerClockSchema } from './time.ts';

type BodyInput<N extends LiveEventsEndpointName> = LiveEventsEndpoints[N]['body'] extends z.ZodType
  ? z.input<LiveEventsEndpoints[N]['body']>
  : never;

type BodyField<N extends LiveEventsEndpointName> = [BodyInput<N>] extends [never]
  ? object
  : { body: BodyInput<N> };

export type LiveEventsEndpointFixture<N extends LiveEventsEndpointName> = BodyField<N> & {
  response: z.input<LiveEventsEndpoints[N]['response']>;
};

const hour = 3_600_000;
const day = 24 * hour;
/** Sunday 2026-11-15, 09:30 UTC: 10:30 in Paris, late in boss week 2026-W46. */
export const liveNow = 1_794_735_000_000;
const parisDayStart = 1_794_697_200_000;
const utcDayStart = 1_794_700_800_000;
const weekStart = 1_794_182_400_000;

const wallet = {
  coins: 21_350,
  bullion: 2,
  goldBars: 1,
  pearls: 58,
  keys: 2,
  tickets: 4,
  stars: 0,
};

/** A fairness proof as a rolled calendar slot reports it. */
export const liveProof = {
  serverSeedHash: '5b1d3f7a9c2e4b6d8f0a1c3e5d7b9f2a4c6e8d0b2f4a6c8e1d3b5f7a9c0e2d4f',
  clientSeed: 'velvet-rope-42',
  nonce: 318,
};

export const liveClock = {
  timeZone: 'Europe/Paris',
  day: '2026-11-15',
  dayStartsAt: parisDayStart,
  nextDayAt: parisDayStart + day,
  zoneChangeableAt: null,
} satisfies z.input<typeof PlayerClockSchema>;

const calendarRoll = {
  kind: 'roll',
  odds: [
    { rarity: 'fine', chanceBp: 6_000 },
    { rarity: 'rare', chanceBp: 3_000 },
    { rarity: 'exquisite', chanceBp: 1_000 },
  ],
  pity: { guaranteed: 'exquisite', within: 4, since: 1 },
} satisfies z.input<typeof CalendarRollSchema>;

const weekSlots = [
  { day: 1, rewards: [{ kind: 'currency', currency: 'coins', amount: 500 }] },
  { day: 2, rewards: [{ kind: 'currency', currency: 'keys', amount: 1 }] },
  { day: 3, rewards: [{ kind: 'currency', currency: 'coins', amount: 900 }] },
  { day: 4, rewards: [{ kind: 'currency', currency: 'tickets', amount: 2 }] },
  { day: 5, rewards: [{ kind: 'currency', currency: 'coins', amount: 1_400 }] },
  { day: 6, rewards: [{ kind: 'currency', currency: 'pearls', amount: 5 }] },
  { day: 7, rewards: [{ kind: 'crate', rarity: 'rare' }, calendarRoll] },
] satisfies z.input<typeof CalendarSlotSchema>[];

const monthSlots = Array.from({ length: 28 }, (_, i): z.input<typeof CalendarSlotSchema> => {
  const slotDay = i + 1;
  if (slotDay === 14) return { day: slotDay, rewards: [{ kind: 'crate', rarity: 'exquisite' }] };
  if (slotDay === 28) {
    return { day: slotDay, rewards: [{ kind: 'cosmetic', cosmetic: 'gildedCalendarFrame' }] };
  }
  return { day: slotDay, rewards: [{ kind: 'repute', amount: 40 }] };
});

/** Eleven days claimed over two weeks: day 5 of the second week, day 12 of the month. */
export const liveTracks = {
  week: { track: 'week', cycle: 2, nextDay: 5, claims: 11, slots: weekSlots },
  month: { track: 'month', cycle: 1, nextDay: 12, claims: 11, slots: monthSlots },
} satisfies Record<'week' | 'month', z.input<typeof CalendarTrackStateSchema>>;

export const livePuzzle = {
  day: '2026-11-15',
  seed: 2_908_174_311,
  venue: 'rivieraYacht',
  goal: { kind: 'bankTier', tier: 'platinum', count: 3 },
  budget: { drops: 40, ticks: 18_000 },
  board: 'puzzle-2026-11-15',
  startsAt: utcDayStart,
  endsAt: utcDayStart + day,
} satisfies z.input<typeof DailyPuzzleSchema>;

const puzzleBest = {
  attempt: 1,
  solved: true,
  dropsUsed: 31,
  ticksUsed: 14_220,
  score: 9_000,
  verifiedAt: liveNow - hour,
} satisfies z.input<typeof PuzzleResultSchema>;

export const liveBosses = {
  active: {
    week: '2026-W46',
    kind: 'taxInspector',
    status: 'active',
    maxHealth: 48_000_000,
    health: 6_250_000,
    contributors: 1_204,
    startsAt: weekStart,
    endsAt: weekStart + 7 * day,
    defeatedAt: null,
  },
  defeated: {
    week: '2026-W45',
    kind: 'rivalTycoon',
    status: 'defeated',
    maxHealth: 45_000_000,
    health: 0,
    contributors: 1_187,
    startsAt: weekStart - 7 * day,
    endsAt: weekStart,
    defeatedAt: weekStart - day,
  },
  escaped: {
    week: '2026-W44',
    kind: 'taxInspector',
    status: 'escaped',
    maxHealth: 52_000_000,
    health: 900_000,
    contributors: 1_090,
    startsAt: weekStart - 14 * day,
    endsAt: weekStart - 7 * day,
    defeatedAt: null,
  },
} satisfies Record<BossStatus, z.input<typeof BossSchema>>;

const bossTiers = [
  { tier: 1, minDamage: 5_000, rewards: [{ kind: 'currency', currency: 'keys', amount: 1 }] },
  { tier: 2, minDamage: 25_000, rewards: [{ kind: 'crate', rarity: 'rare' }] },
  {
    tier: 3,
    minDamage: 100_000,
    rewards: [
      { kind: 'crate', rarity: 'exquisite' },
      { kind: 'repute', amount: 300 },
    ],
  },
] satisfies z.input<typeof BossTiersSchema>;

export const liveBossResponse = {
  serverTime: liveNow,
  boss: liveBosses.active,
  tiers: bossTiers,
  defeatBonus: [{ kind: 'currency', currency: 'pearls', amount: 10 }],
  contribution: { damage: 31_400, tier: 2, claimedAt: null },
  claimable: false,
} satisfies z.input<typeof BossResponseSchema>;

export const liveThemes = {
  winterGala: {
    id: 'winterGala',
    kind: 'holiday',
    startsAt: liveNow - 3 * day,
    endsAt: liveNow + 11 * day,
    venues: ['rivieraYacht', 'alpineChalet'],
    coinFace: 'winterGala-snowflake',
    collection: 'winterGala-baubles',
  },
  grandPrix: {
    id: 'grandPrixWeek',
    kind: 'tieIn',
    startsAt: liveNow + 12 * day,
    endsAt: liveNow + 19 * day,
    venues: ['rivieraYacht'],
    coinFace: 'grandPrix-chequered',
    collection: null,
  },
} satisfies Record<string, z.input<typeof LiveThemeSchema>>;

export const liveCollection = {
  id: 'winterGala-baubles',
  theme: 'winterGala',
  items: [
    { collectibleId: 'bauble-silver', rarity: 'fine', owned: 2 },
    { collectibleId: 'bauble-gold', rarity: 'rare', owned: 1 },
    { collectibleId: 'bauble-diamond', rarity: 'legendary', owned: 0 },
  ],
  odds: [
    { rarity: 'fine', chanceBp: 7_000 },
    { rarity: 'rare', chanceBp: 2_500 },
    { rarity: 'legendary', chanceBp: 500 },
  ],
  pity: { guaranteed: 'legendary', within: 30, since: 12 },
  completion: [{ kind: 'cosmetic', cosmetic: 'winterGalaChandelier' }],
  completedAt: null,
} satisfies z.input<typeof LimitedCollectionSchema>;

/** One valid wire example per live events endpoint; the mapped type fails to compile if one is missing. */
export const liveEventsFixtures: {
  [N in LiveEventsEndpointName]: LiveEventsEndpointFixture<N>;
} = {
  liveEventsCalendar: {
    response: {
      serverTime: liveNow,
      clock: liveClock,
      claimable: true,
      lastClaimDay: '2026-11-13',
      tracks: [liveTracks.week, liveTracks.month],
    },
  },
  liveEventsCalendarClaim: {
    body: {},
    response: {
      day: '2026-11-15',
      claimedAt: liveNow,
      nextDayAt: liveClock.nextDayAt,
      payouts: [
        {
          track: 'week',
          day: 5,
          granted: [{ kind: 'currency', currency: 'coins', amount: 1_400 }],
          proof: null,
        },
        { track: 'month', day: 12, granted: [{ kind: 'repute', amount: 40 }], proof: null },
      ],
      wallet,
      tracks: [
        { ...liveTracks.week, nextDay: 6, claims: 12 },
        { ...liveTracks.month, nextDay: 13, claims: 12 },
      ],
    },
  },
  liveEventsTimeZone: {
    body: { timeZone: 'America/New_York' },
    response: {
      serverTime: liveNow,
      clock: {
        timeZone: 'America/New_York',
        day: '2026-11-15',
        dayStartsAt: utcDayStart + 5 * hour,
        nextDayAt: utcDayStart + day + 5 * hour,
        zoneChangeableAt: liveNow + 30 * day,
      },
    },
  },
  liveEventsPuzzle: {
    response: {
      serverTime: liveNow,
      puzzle: livePuzzle,
      rewards: [
        { kind: 'finish', rewards: [{ kind: 'repute', amount: 100 }] },
        {
          kind: 'topShare',
          shareBp: 1_000,
          rewards: [{ kind: 'currency', currency: 'pearls', amount: 10 }],
        },
      ],
      attempts: { used: 1, limit: null },
      open: null,
      best: puzzleBest,
    },
  },
  liveEventsPuzzleStart: {
    body: {},
    response: {
      puzzle: livePuzzle,
      open: { attempt: 2, startedAt: liveNow },
      attempts: { used: 2, limit: null },
    },
  },
  liveEventsPuzzleSubmit: {
    body: {
      day: '2026-11-15',
      attempt: 2,
      endTick: 12_600,
      events: [
        { kind: 'drop', tick: 30, x: -0.25 },
        { kind: 'drop', tick: 90, x: 0.1 },
        { kind: 'nudge', tick: 4_020, direction: 'left' },
        { kind: 'drop', tick: 4_200, x: 0.6 },
      ],
      checkpoints: [
        { tick: 6_000, hash: '9c3e5d7b1a2f4e6d' },
        { tick: 12_600, hash: '4b6d8f0a1c3e5d7b' },
      ],
    },
    response: {
      verdict: 'solved',
      day: '2026-11-15',
      attempt: 2,
      result: {
        attempt: 2,
        solved: true,
        dropsUsed: 27,
        ticksUsed: 12_600,
        score: 9_640,
        verifiedAt: liveNow + 2 * 60_000,
      },
      personalBest: true,
      board: { status: 'verifying' },
      granted: [],
      wallet,
    },
  },
  liveEventsBoss: { response: liveBossResponse },
  liveEventsBossClaim: {
    body: { week: '2026-W45' },
    response: {
      week: '2026-W45',
      claimedAt: liveNow,
      tier: 3,
      defeatBonus: true,
      granted: [
        { kind: 'crate', crateId: 'crate_7Hq2LmX9pA', rarity: 'exquisite' },
        { kind: 'repute', amount: 300 },
        { kind: 'currency', currency: 'pearls', amount: 10 },
      ],
      wallet,
    },
  },
  liveEventsThemes: {
    response: {
      serverTime: liveNow,
      active: [liveThemes.winterGala],
      upcoming: [liveThemes.grandPrix],
      collections: [liveCollection],
    },
  },
};

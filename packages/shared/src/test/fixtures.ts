import type { z } from 'zod';
import type {
  EndpointBodyInput,
  EndpointName,
  EndpointParamsInput,
  EndpointResponseInput,
} from '../api/endpoints.ts';
import type { RollSchema } from '../api/loot.ts';
import type { QuestSchema } from '../api/meta.ts';

export const ids = {
  player: '0198f6a2-7c1e-7d3b-9a4f-2b6c8e1d0a55',
  coins: ['coin_7Hq2LmX9pA', 'coin_8Jr3MnY0qB', 'coin_9Ks4NoZ1rC', 'coin_0Lt5OpA2sD'],
  crate: 'crate_Qw3Er5Ty7U',
  safe: 'safe_Za1Xs2Cd3V',
  charm: 'charm_Pl9Ok8Ij7U',
  scratchCard: 'scratch_Mn4Bv5Cx6Z',
  quest: 'quest_Dk2Fj3Gh4L',
  season: 'season_S1a2b3c4d5',
  event: 'event_H9e8i7s6t5',
  idempotencyKey: '3b241101-e2bb-4255-8caf-4136c566a962',
} as const;

const [coinA, coinB, coinC, coinD] = ids.coins;

export const serverSeed = '9f2c7d1e4b8a6f0c3e5d7b9a1c2e4f6a8b0d2c4e6f8a0b1c3d5e7f9a2b4c6d8e';
export const serverSeedHash = '5b1d3f7a9c2e4b6d8f0a1c3e5d7b9f2a4c6e8d0b2f4a6c8e1d3b5f7a9c0e2d4f';

const wallet = {
  coins: 1250,
  bullion: 3,
  goldBars: 0,
  pearls: 40,
  keys: 2,
  tickets: 5,
  stars: 180,
};

const proof = { serverSeedHash, clientSeed: 'velvet-rope-42', nonce: 17 };
const pity = { rare: 3, exquisite: 12, legendary: 57 };

const roll = {
  rarity: 'rare',
  rewards: [
    { kind: 'currency', currency: 'pearls', amount: 25 },
    {
      kind: 'charm',
      charmId: ids.charm,
      charmType: 'golden-peg',
      level: 2,
      duplicate: true,
    },
  ],
  proof,
  pity,
} satisfies z.input<typeof RollSchema>;

const tokens = {
  playerId: ids.player,
  accessToken: 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJwbGF5ZXIifQ.c2lnbmF0dXJl',
  accessTokenTtlMs: 900_000,
  refreshToken: 'rt_4f9a1c7e2b8d6f0a3c5e7b9d1f2a4c6e8b0d2f4a',
};

const quest = {
  id: ids.quest,
  template: 'push-platinum',
  cadence: 'daily',
  target: 5,
  progress: 5,
  rewards: [
    { kind: 'currency', currency: 'keys', amount: 1 },
    { kind: 'scratchCard', count: 1 },
  ],
  claimed: true,
  expiresAt: 1_762_560_000_000,
} satisfies z.input<typeof QuestSchema>;

const leaderboardMe = { rank: 12, displayName: 'Lady Gilt', score: 98_400, isMe: true };

type BodyField<N extends EndpointName> = [EndpointBodyInput<N>] extends [never]
  ? object
  : { body: EndpointBodyInput<N> };
type ParamsField<N extends EndpointName> = [EndpointParamsInput<N>] extends [never]
  ? object
  : { params: EndpointParamsInput<N> };

export type EndpointFixture<N extends EndpointName> = BodyField<N> &
  ParamsField<N> & { response: EndpointResponseInput<N> };

/** One valid wire example per endpoint; the mapped type fails to compile if an endpoint is missing. */
export const endpointFixtures: { [N in EndpointName]: EndpointFixture<N> } = {
  authGuest: {
    body: {
      devicePublicKey: {
        kty: 'EC',
        crv: 'P-256',
        x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
        y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
        ext: true,
        key_ops: ['verify'],
      },
      turnstileToken: '0.turnstile-demo-token',
      locale: 'fr',
    },
    response: tokens,
  },
  authRefresh: {
    body: { refreshToken: tokens.refreshToken },
    response: { ...tokens, refreshToken: 'rt_7c2e9a4f1b6d8e0c3a5f7b9d2e4c6a8f0b1d3e5c' },
  },
  state: {
    response: {
      serverTime: 1_762_473_600_000,
      player: {
        id: ids.player,
        displayName: 'Lady Gilt',
        locale: 'en',
        createdAt: 1_762_300_800_000,
      },
      wallet,
      flags: { monetization: false, premiumSeasonTrack: false, rewardedAds: false },
      venue: {
        id: 'riviera',
        unlocked: ['riviera'],
        upgrades: { 'pusher-speed': 3, 'coin-value': 1 },
        loadout: [
          { socket: 0, charmId: ids.charm },
          { socket: 1, charmId: null },
        ],
      },
      table: {
        coins: [
          { id: coinA, tier: 'copper', value: 1 },
          { id: coinB, tier: 'silver', value: 5 },
        ],
        crates: [{ id: ids.crate, kind: 'vault' }],
        buffer: [{ id: coinC, tier: 'copper', value: 1 }],
        decorum: 0.35,
        frozenUntil: null,
      },
      inventory: {
        charms: [{ id: ids.charm, type: 'golden-peg', level: 2 }],
        safes: [{ id: ids.safe, type: 'gold', unlocksAt: 1_762_488_000_000 }],
        scratchCards: [ids.scratchCard],
      },
      offline: { awayMs: 30_600_000, creditedMs: 7_200_000, coins: 3_420 },
      fair: proof,
    },
  },
  tableDrop: {
    body: { x: -0.42, tick: 1_830 },
    response: {
      coin: { id: coinD, tier: 'copper', value: 1 },
      buffer: [{ id: coinC, tier: 'copper', value: 1 }],
      spawnedCrates: [{ id: ids.crate, kind: 'vault' }],
      wallet,
    },
  },
  tableClaims: {
    body: {
      claims: [
        { kind: 'fall', coinId: coinA, tick: 1_900, edge: 'front' },
        { kind: 'fusion', coinIds: [coinB, coinC, coinD], tick: 1_905 },
        { kind: 'crate', crateId: ids.crate, tick: 1_960, edge: 'front' },
        { kind: 'fall', coinId: coinA, tick: 1_961, edge: 'left' },
      ],
    },
    response: {
      results: [
        { status: 'accepted', credited: 1, cascade: 'chic', minted: null },
        {
          status: 'accepted',
          credited: 0,
          cascade: null,
          minted: { id: 'coin_Fu5edG01dX', tier: 'gold', value: 31 },
        },
        { status: 'accepted', credited: 0, cascade: 'lavish', minted: null },
        { status: 'rejected', reason: 'already_claimed' },
      ],
      wallet,
    },
  },
  tableNudge: {
    body: { tick: 2_010, direction: 'forward' },
    response: { decorum: 1, frozenUntil: 1_762_473_610_000 },
  },
  tableInputs: {
    body: {
      fromTick: 1_800,
      toTick: 2_100,
      events: [
        { kind: 'drop', tick: 1_830, x: -0.42, coinId: coinD },
        { kind: 'pourStart', tick: 1_900 },
        { kind: 'pourEnd', tick: 1_960 },
        { kind: 'nudge', tick: 2_010, direction: 'forward' },
      ],
      checkpoints: [{ tick: 2_100, hash: '9e107d9d372bb6826bd81d3542a419d6' }],
    },
    response: { receivedEvents: 4, receivedCheckpoints: 1 },
  },
  upgradesBuy: {
    body: { venueId: 'riviera', lineId: 'pusher-speed', level: 4 },
    response: { venueId: 'riviera', lineId: 'pusher-speed', level: 4, wallet },
  },
  charmsEquip: {
    body: { venueId: 'riviera', socket: 1, charmId: ids.charm },
    response: {
      venueId: 'riviera',
      loadout: [
        { socket: 0, charmId: null },
        { socket: 1, charmId: ids.charm },
      ],
    },
  },
  cratesOpen: {
    body: { crateId: ids.crate },
    response: { crateId: ids.crate, roll, wallet },
  },
  safesOpen: {
    body: { safeId: ids.safe, method: 'key' },
    response: {
      safeId: ids.safe,
      roll: {
        ...roll,
        rarity: 'legendary',
        rewards: [{ kind: 'collectible', collectibleId: 'duchess-sovereign-1891' }],
      },
      wallet,
    },
  },
  gachaPull: {
    body: { count: 2 },
    response: {
      pulls: [
        roll,
        {
          ...roll,
          rarity: 'fine',
          rewards: [
            {
              kind: 'safe',
              safe: { id: ids.safe, type: 'gold', unlocksAt: 1_762_488_000_000 },
            },
          ],
          proof: { ...proof, nonce: 18 },
        },
      ],
      wallet,
    },
  },
  scratchReveal: {
    body: { cardId: ids.scratchCard },
    response: {
      cardId: ids.scratchCard,
      grid: ['fine', 'rare', 'common', 'rare', 'fine', 'common', 'rare', 'common', 'fine'],
      roll: {
        ...roll,
        rewards: [{ kind: 'scratchCard', cardId: 'scratch_Nx7Bv8Cx9Q' }],
      },
      wallet,
    },
  },
  ascend: {
    body: { venueId: 'riviera' },
    response: {
      venueId: 'riviera',
      goldBarsGranted: 14,
      unlockedVenueId: 'salon-de-paris',
      wallet: { ...wallet, coins: 0, bullion: 0, goldBars: 14 },
    },
  },
  album: {
    response: {
      sets: [
        {
          id: 'riviera-heirlooms',
          entries: [
            { id: 'duchess-sovereign-1891', kind: 'heirloom', owned: true, count: 1 },
            { id: 'admiral-doubloon', kind: 'heirloom', owned: false, count: 0 },
          ],
          completed: false,
        },
      ],
    },
  },
  fairSeeds: {
    response: {
      active: proof,
      revealed: [
        {
          serverSeed,
          serverSeedHash,
          clientSeed: 'velvet-rope-41',
          finalNonce: 212,
          revealedAt: 1_762_387_200_000,
        },
      ],
    },
  },
  fairRotate: {
    body: { clientSeed: 'champagne-tower' },
    response: {
      active: { serverSeedHash, clientSeed: 'champagne-tower', nonce: 0 },
      revealed: {
        serverSeed,
        serverSeedHash,
        clientSeed: 'velvet-rope-42',
        finalNonce: 17,
        revealedAt: 1_762_473_600_000,
      },
    },
  },
  quests: {
    response: {
      quests: [quest, { ...quest, cadence: 'weekly', progress: 2, claimed: false }],
      streak: { days: 6, freezes: 1 },
    },
  },
  questsClaim: {
    body: { questId: ids.quest },
    response: {
      quest,
      rewards: [
        { kind: 'currency', currency: 'keys', amount: 1 },
        { kind: 'scratchCard', cardId: ids.scratchCard },
      ],
      wallet,
    },
  },
  season: {
    response: {
      id: ids.season,
      startsAt: 1_761_955_200_000,
      endsAt: 1_765_584_000_000,
      stars: 180,
      tiers: [
        {
          tier: 1,
          starsRequired: 100,
          free: [{ kind: 'currency', currency: 'tickets', amount: 2 }],
          premium: [{ kind: 'collectible', collectibleId: 'coin-skin-coral' }],
        },
        {
          tier: 2,
          starsRequired: 250,
          free: [{ kind: 'safe', safeType: 'gold' }],
          premium: [{ kind: 'charm', charmType: 'perfume-atomizer' }],
        },
      ],
      claimedFree: [1],
      claimedPremium: [],
      premiumUnlocked: false,
    },
  },
  leaderboard: {
    params: { board: 'weekly' },
    response: {
      board: 'weekly',
      startsAt: 1_762_128_000_000,
      endsAt: 1_762_732_800_000,
      entries: [
        { rank: 1, displayName: 'Baron Brass', score: 1_204_000, isMe: false },
        leaderboardMe,
      ],
      me: leaderboardMe,
    },
  },
  eventsCurrent: {
    response: {
      serverTime: 1_762_473_600_000,
      goldenHour: { startsAt: 1_762_534_800_000, endsAt: 1_762_535_700_000 },
      heist: {
        id: ids.event,
        startsAt: 1_762_128_000_000,
        endsAt: 1_762_732_800_000,
        progress: 4_200_000,
        goal: 10_000_000,
      },
    },
  },
};

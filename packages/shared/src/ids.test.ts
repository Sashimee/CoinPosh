import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  BoardIdSchema,
  CharmIdSchema,
  CoinIdSchema,
  CrateIdSchema,
  ENTITY_ID_PREFIXES,
  EventIdSchema,
  PlayerIdSchema,
  QuestIdSchema,
  SafeIdSchema,
  ScratchCardIdSchema,
  SeasonIdSchema,
  UpgradeLineIdSchema,
  VenueIdSchema,
  type CoinId,
  type CrateId,
  type VenueId,
} from './ids.ts';
import { roundTrip } from './test/roundTrip.ts';

const entitySchemas = {
  coin: CoinIdSchema,
  crate: CrateIdSchema,
  safe: SafeIdSchema,
  charm: CharmIdSchema,
  scratchCard: ScratchCardIdSchema,
  quest: QuestIdSchema,
  season: SeasonIdSchema,
  event: EventIdSchema,
} as const;

const entityCases = Object.entries(entitySchemas).map(([kind, schema]) => ({
  kind,
  schema,
  prefix: ENTITY_ID_PREFIXES[kind as keyof typeof ENTITY_ID_PREFIXES],
}));

describe.each(entityCases)('$kind id', ({ schema, prefix }) => {
  it('round-trips a well-formed id', () => {
    const id = `${prefix}_Ab3De6Gh9J`;
    const { parsed, reparsed } = roundTrip(schema, id);
    expect(parsed).toBe(id);
    expect(reparsed).toBe(id);
  });

  it('accepts bodies of 8 and 32 characters', () => {
    expect(schema.safeParse(`${prefix}_${'a'.repeat(8)}`).success).toBe(true);
    expect(schema.safeParse(`${prefix}_${'Z'.repeat(32)}`).success).toBe(true);
  });

  it.each([
    ['a body of 7 characters', (p: string) => `${p}_${'a'.repeat(7)}`],
    ['a body of 33 characters', (p: string) => `${p}_${'a'.repeat(33)}`],
    ['a missing prefix', () => 'Ab3De6Gh9J'],
    ['punctuation in the body', (p: string) => `${p}_Ab3De6-h9J`],
    ['surrounding whitespace', (p: string) => ` ${p}_Ab3De6Gh9J`],
  ])('rejects %s', (_label, make) => {
    expect(schema.safeParse(make(prefix)).success).toBe(false);
  });

  it('rejects every other kind of entity id', () => {
    for (const other of entityCases.filter((c) => c.prefix !== prefix)) {
      expect(schema.safeParse(`${other.prefix}_Ab3De6Gh9J`).success).toBe(false);
    }
  });
});

describe('PlayerIdSchema', () => {
  it('accepts a server-issued UUID and rejects anything else', () => {
    expect(PlayerIdSchema.safeParse('0198f6a2-7c1e-7d3b-9a4f-2b6c8e1d0a55').success).toBe(true);
    expect(PlayerIdSchema.safeParse('coin_Ab3De6Gh9J').success).toBe(false);
    expect(PlayerIdSchema.safeParse('0198f6a2-7c1e-7d3b-9a4f').success).toBe(false);
  });
});

describe('catalog keys', () => {
  it.each(['riviera', 'pusher-speed', 'goldenPeg', 'weekly:2026-w45', 'salon.paris'])(
    'accepts %s',
    (key) => {
      expect(VenueIdSchema.safeParse(key).success).toBe(true);
    },
  );

  it.each(['', 'Riviera', '9lives', 'pusher speed', '../admin', 'trailing-', 'a'.repeat(65)])(
    'rejects %j',
    (key) => {
      expect(BoardIdSchema.safeParse(key).success).toBe(false);
    },
  );
});

describe('brands', () => {
  it('keeps ids of different kinds apart at the type level', () => {
    expectTypeOf<CoinId>().not.toEqualTypeOf<CrateId>();
    expectTypeOf<CoinId>().toExtend<string>();
    expectTypeOf<string>().not.toExtend<CoinId>();

    const takesCoin = (id: CoinId): string => id;
    const crate = CrateIdSchema.parse('crate_Ab3De6Gh9J');
    // @ts-expect-error a CrateId is not a CoinId
    takesCoin(crate);
    // @ts-expect-error a bare string must be parsed into a CoinId first
    takesCoin('coin_Ab3De6Gh9J');
    expect(takesCoin(CoinIdSchema.parse('coin_Ab3De6Gh9J'))).toBe('coin_Ab3De6Gh9J');
  });

  it('keeps catalog keys apart from each other', () => {
    expectTypeOf<VenueId>().not.toEqualTypeOf(UpgradeLineIdSchema.parse('pusher-speed'));
  });
});

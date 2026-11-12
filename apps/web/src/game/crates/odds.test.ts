import {
  dropTables,
  ODDS_SCALE,
  pity as pityConfig,
  RARITY_IDS,
  weightToPercent,
} from '@coinposh/economy';
import { fairDigest, type FairProof } from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import { createI18n, LANGUAGES, type ResourceTree } from '../../i18n/index.ts';
import { toHex } from '../../net/encoding.ts';
import { fairDigest as rollDigest } from '../../net/fair.ts';
import { newSeed, nextRoll, reveal } from '../../net/mock/fair.ts';
import { cratesKey, CRATES_STRINGS, registerCratesStrings } from './i18n.ts';
import {
  CRATE_DROP_SOURCE,
  crateOdds,
  nonceLabel,
  oddsShare,
  oddsTotalPercent,
  pityLadder,
  revealedSeedFor,
  verifyRevealedSeed,
} from './odds.ts';
import type { CratesT } from './revealCard.ts';

const i18n = createI18n({ language: 'en', resources: { en: {}, fr: {}, de: {} } });
registerCratesStrings(i18n);
const t: CratesT = (key, values) => i18n.t(cratesKey(key), values);
const inLanguage = <T>(language: (typeof LANGUAGES)[number], read: () => T): T => {
  i18n.changeLanguage(language);
  return read();
};

function vaultTable() {
  const table = dropTables.find((candidate) => candidate.source === CRATE_DROP_SOURCE);
  if (table === undefined) throw new Error('Expected a vaultCrate drop table in packages/economy');
  return table;
}

describe('crate odds sheet rows', () => {
  it('lists every rarity, in rarity order, with the weight the server rolls against', () => {
    const table = vaultTable();
    const rows = crateOdds();
    expect(rows.map((row) => row.rarity)).toEqual([...RARITY_IDS]);
    for (const row of rows) {
      expect(row.weight).toBe(table.odds[row.rarity]);
      expect(row.percent).toBe(weightToPercent(table.odds[row.rarity]));
    }
  });

  it('adds up to exactly 100 % for every drop table the economy ships', () => {
    for (const table of dropTables) {
      const rows = crateOdds(table.source);
      expect(rows.reduce((sum, row) => sum + row.weight, 0)).toBe(ODDS_SCALE);
      expect(oddsTotalPercent(rows)).toBe(100);
    }
  });

  it('prints shares in each locale without rounding the rarest rows away', () => {
    const rows = crateOdds();
    const heirloom = rows.find((row) => row.rarity === 'heirloom');
    if (heirloom === undefined) throw new Error('Expected an heirloom row');
    const shown = (language: (typeof LANGUAGES)[number]) =>
      inLanguage(language, () => t('oddsShare', { value: oddsShare(heirloom.percent, language) }));
    expect(heirloom.percent).toBeGreaterThan(0);
    expect(Number(oddsShare(heirloom.percent, 'en'))).toBe(heirloom.percent);
    expect(shown('en')).toBe(`${oddsShare(heirloom.percent, 'en')}%`);
    expect(shown('fr')).toBe(`${oddsShare(heirloom.percent, 'en').replace('.', ',')} %`);
    expect(shown('de')).toBe(`${oddsShare(heirloom.percent, 'en').replace('.', ',')} %`);
    for (const row of rows) {
      expect(Number(oddsShare(row.percent, 'en'))).toBe(row.percent);
    }
  });
});

describe('pity ladder', () => {
  it('fills every economy guarantee with the server counters', () => {
    const counters = { rare: 3, exquisite: 0, legendary: 41 };
    const ladder = pityLadder(counters);
    expect(ladder.map((step) => step.rarity)).toEqual(pityConfig.rules.map((rule) => rule.rarity));
    for (const step of ladder) {
      const rule = pityConfig.rules.find((candidate) => candidate.rarity === step.rarity);
      expect(step.within).toBe(rule?.within);
      expect(step.misses).toBe(counters[step.rarity]);
      expect(step.left).toBe(step.within - counters[step.rarity]);
    }
  });

  it('reads one open left at the last miss before a guarantee', () => {
    const rare = pityConfig.rules[0];
    const ladder = pityLadder({ rare: rare.within - 1, exquisite: 0, legendary: 0 });
    expect(ladder[0]?.left).toBe(1);
  });

  it('refuses counters past their guarantee instead of showing a broken promise', () => {
    const rare = pityConfig.rules[0];
    expect(() => pityLadder({ rare: rare.within, exquisite: 0, legendary: 0 })).toThrow(RangeError);
    expect(() => pityLadder({ rare: -1, exquisite: 0, legendary: 0 })).toThrow(RangeError);
  });

  it('words the next guarantee in every language', () => {
    expect(inLanguage('en', () => t('oddsPityFloor', { rarity: t('rarity.rare') }))).toBe(
      'Rare or better',
    );
    expect(inLanguage('fr', () => t('oddsPityLeft', { count: 9 }))).toBe('d’ici 9 ouvertures');
    expect(inLanguage('de', () => t('oddsPityFloor', { rarity: t('rarity.legendary') }))).toBe(
      'Legendär oder besser',
    );
  });
});

describe('roll nonce on the chip', () => {
  it('moves on with every roll, so consecutive crates of one seed read differently', async () => {
    const seed = await newSeed('player-seed');
    const first = await nextRoll(seed);
    const second = await nextRoll(seed);
    expect(first.proof.serverSeedHash).toBe(second.proof.serverSeedHash);
    expect(second.proof.nonce).toBe(first.proof.nonce + 1);
    const chip = (proof: FairProof) =>
      inLanguage('en', () => t('fairNonce', { nonce: nonceLabel(proof, 'en') }));
    expect(chip(first.proof)).toBe(`#${first.proof.nonce}`);
    expect(chip(second.proof)).toBe(`#${second.proof.nonce}`);
    expect(chip(first.proof)).not.toBe(chip(second.proof));
  });

  it('groups long nonces in the player’s locale', () => {
    const proof = { nonce: 12_345 };
    expect(inLanguage('en', () => t('fairNonce', { nonce: nonceLabel(proof, 'en') }))).toBe(
      '#12,345',
    );
    expect(inLanguage('de', () => t('fairNonce', { nonce: nonceLabel(proof, 'de') }))).toBe(
      'Nr.\u00a012.345',
    );
  });
});

describe('verifying a revealed seed', () => {
  it('checks the commitment and re-derives the very digest the roll was made from', async () => {
    const seed = await newSeed('player-seed');
    seed.nonce = 6;
    const { proof } = await nextRoll(seed);
    const check = await verifyRevealedSeed(proof, seed.serverSeed);
    expect(check).toEqual({
      status: 'verified',
      digest: await fairDigest(seed.serverSeed, proof.clientSeed, proof.nonce),
    });
    if (check.status !== 'verified') throw new Error('Expected a verified seed');
    expect(check.digest).toBe(toHex(await rollDigest(seed.serverSeed, proof.clientSeed, 6)));
  });

  it('accepts a pasted seed with stray whitespace or capitals', async () => {
    const seed = await newSeed('player-seed');
    const { proof } = await nextRoll(seed);
    const check = await verifyRevealedSeed(proof, `  ${seed.serverSeed.toUpperCase()}\n`);
    expect(check.status).toBe('verified');
  });

  it('rejects a well-formed seed that is not the committed one', async () => {
    const seed = await newSeed('player-seed');
    const other = await newSeed('player-seed');
    const { proof } = await nextRoll(seed);
    expect(await verifyRevealedSeed(proof, other.serverSeed)).toEqual({
      status: 'mismatch',
      commitment: other.serverSeedHash,
    });
  });

  it('rejects text that is not a seed at all', async () => {
    const seed = await newSeed('player-seed');
    const { proof } = await nextRoll(seed);
    for (const text of ['', 'not a seed', seed.serverSeed.slice(1), `${seed.serverSeed}0`]) {
      expect(await verifyRevealedSeed(proof, text)).toEqual({ status: 'malformed' });
    }
  });

  it('finds the revealed seed a roll was spent under, and only that one', async () => {
    const seed = await newSeed('player-seed');
    const { proof } = await nextRoll(seed);
    const later = await newSeed('player-seed');
    const revealed = [reveal(later, 2), reveal(seed, 1)];
    expect(revealedSeedFor(proof, revealed)?.serverSeed).toBe(seed.serverSeed);
    expect(revealedSeedFor({ ...proof, nonce: seed.nonce }, revealed)).toBeNull();
    expect(revealedSeedFor({ ...proof, clientSeed: 'someone-else' }, revealed)).toBeNull();
    expect(revealedSeedFor(proof, [])).toBeNull();
  });
});

describe('fairness sheet strings', () => {
  it('ships every sheet string in English, French and German', () => {
    const keys = Object.keys(CRATES_STRINGS.en).filter((key) =>
      /^(fair|odds|proof|verify)/.test(key),
    );
    expect(keys.length).toBeGreaterThan(0);
    for (const language of LANGUAGES) {
      for (const key of keys) {
        const strings: ResourceTree = CRATES_STRINGS[language];
        const value = strings[key];
        expect(typeof value === 'string' && value.length > 0, `${language}.${key}`).toBe(true);
      }
    }
  });
});

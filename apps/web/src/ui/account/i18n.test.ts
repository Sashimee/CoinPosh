import { IDENTITY_PROVIDERS, VENUE_IDS } from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import { venueKey } from '../../game/ascension/i18n.ts';
import {
  BUNDLED_RESOURCES,
  createI18n,
  LANGUAGES,
  type Language,
  type ResourceTree,
} from '../../i18n/index.ts';
import {
  ACCOUNT_STRINGS,
  accountKey,
  accountT,
  registerAccountStrings,
  type AccountKey,
} from './i18n.ts';
import { problemKey, type AccountProblem } from './model.ts';

function leaves(tree: ResourceTree, prefix = ''): [string, string][] {
  return Object.entries(tree).flatMap(([key, value]): [string, string][] =>
    typeof value === 'string' ? [[`${prefix}${key}`, value]] : leaves(value, `${prefix}${key}.`),
  );
}

function setup(language: Language) {
  const i18n = createI18n({ language, resources: BUNDLED_RESOURCES });
  registerAccountStrings(i18n);
  return i18n;
}

const placeholders = (text: string) =>
  [...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1] ?? '').sort();

describe('account strings', () => {
  it('ships the same keys in every language', () => {
    const en = leaves(ACCOUNT_STRINGS.en).map(([key]) => key);
    for (const language of LANGUAGES) {
      expect(
        leaves(ACCOUNT_STRINGS[language]).map(([key]) => key),
        language,
      ).toEqual(en);
    }
  });

  it.each(LANGUAGES)('%s has no empty strings', (language) => {
    for (const [key, value] of leaves(ACCOUNT_STRINGS[language])) {
      expect(value.trim(), key).not.toBe('');
    }
  });

  it.each(LANGUAGES)('%s keeps every placeholder English uses', (language) => {
    const en = new Map(leaves(ACCOUNT_STRINGS.en));
    for (const [key, value] of leaves(ACCOUNT_STRINGS[language])) {
      expect(placeholders(value), key).toEqual(placeholders(en.get(key) ?? ''));
    }
  });

  it.each(LANGUAGES)('%s resolves every key the section builds from its data', (language) => {
    const i18n = setup(language);
    const problems: AccountProblem['kind'][] = [
      'cancelled',
      'inUse',
      'notLinked',
      'invalidToken',
      'unavailable',
      'offline',
      'failed',
      'swapFailed',
    ];
    const keys: AccountKey[] = [
      ...IDENTITY_PROVIDERS.flatMap((provider): AccountKey[] => [
        `provider.${provider}`,
        `button.link.${provider}`,
        `button.signin.${provider}`,
      ]),
      ...(['busy', 'ready', 'waiting'] as const).map((phase): AccountKey => `button.${phase}`),
      ...(['link', 'signin'] as const).map((mode): AccountKey => `demo.${mode}`),
      ...problems.map((kind) =>
        problemKey(
          kind === 'swapFailed'
            ? { kind, retry: () => Promise.reject(new Error('unused')) }
            : { kind },
        ),
      ),
    ];
    expect(keys.filter((key) => !i18n.exists(accountKey(key)))).toEqual([]);
    const venues = VENUE_IDS.map((venue) => i18n.t(venueKey(venue)));
    expect(venues.filter((name) => name.includes(':') || name.trim() === '')).toEqual([]);
  });

  it.each([
    ['en', /fake/i],
    ['fr', /factice/i],
    ['de', /fake/i],
  ] as const)('%s labels the Demo provider as fake everywhere it appears', (language, word) => {
    const t = accountT(setup(language));
    for (const key of ['demo.badge', 'demo.link', 'demo.signin', 'demo.note'] as const) {
      expect(t(key, { provider: 'Google' }), key).toMatch(word);
    }
  });

  it.each([
    ['en', 'On this device: Riviera. Gold bars: 3. Coins: 1,200. Played now.'],
    ['fr', 'Sur cet appareil : Riviera. Lingots : 3. Pièces : 1,200. Jouée now.'],
    ['de', 'Auf diesem Gerät: Riviera. Goldbarren: 3. Münzen: 1,200. Gespielt now.'],
  ] as const)('%s reads a save summary out with its own punctuation', (language, expected) => {
    const t = accountT(setup(language));
    expect(
      t('choice.summary', {
        save: t('choice.device'),
        venue: 'Riviera',
        goldBars: '3',
        coins: '1,200',
        when: 'now',
      }),
    ).toBe(expected);
  });

  it.each(['fr', 'de'] as const)('%s is translated, not copied from English', (language) => {
    const t = accountT(setup(language));
    const english = accountT(setup('en'));
    const keys = [
      'title',
      'intro.guest',
      'choice.title',
      'choice.warnAccount',
      'linked.unlink',
      'prompt.later',
      'status.cancelled',
    ] as const;
    expect(keys.filter((key) => t(key) === english(key))).toEqual([]);
  });
});

import { questTemplates } from '@coinposh/economy';
import { DEFAULT_FEATURE_FLAGS, ScratchCardIdSchema } from '@coinposh/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  BUNDLED_RESOURCES,
  createI18n,
  LANGUAGES,
  type I18n,
  type Language,
} from '../../i18n/index.ts';
import type { ClaimStatus } from './claim.ts';
import { fixtureQuest, seasonResponse } from './fixture.ts';
import { loadSeasonStrings, seasonT, type SeasonT } from './i18n.ts';
import { questCard, seasonView, type QuestCardView } from './model.ts';
import {
  questAction,
  questProgressText,
  questTitle,
  rewardPreviews,
  rewardsText,
  rewardText,
  tierLabel,
  tierStateText,
  timeText,
} from './present.ts';

const instances = new Map<Language, I18n>();

beforeAll(async () => {
  for (const language of LANGUAGES) {
    const i18n = createI18n({ language, resources: BUNDLED_RESOURCES });
    await loadSeasonStrings(i18n);
    instances.set(language, i18n);
  }
});

function t(language: Language): SeasonT {
  const i18n = instances.get(language);
  if (i18n === undefined) throw new Error(`no i18n for ${language}`);
  return seasonT(i18n);
}

const rendered = (text: string): void => {
  expect(text.trim()).not.toBe('');
  expect(text).not.toMatch(/\{\{|season:|^(quest|reward|metric|time)\./);
};

describe('season strings', () => {
  it.each(LANGUAGES)('%s titles every quest template and lists its rewards', (language) => {
    for (const [index, def] of questTemplates.entries()) {
      const card = questCard(fixtureQuest({ template: def.id, done: 0.5 }, index));
      const title = questTitle(t(language), card, language);
      rendered(title);
      expect(title.replace(/\D/g, ''), def.id).toContain(String(card.target).replace(/\D/g, ''));
      rendered(questProgressText(t(language), card, language));
      rendered(rewardsText(t(language), card.rewards, language));
    }
  });

  it.each(LANGUAGES)('%s labels every tier on both tracks', (language) => {
    const view = seasonView(seasonResponse(), DEFAULT_FEATURE_FLAGS);
    for (const tier of view.tiers) {
      rendered(tierLabel(t(language), tier, 'free', language));
      rendered(tierLabel(t(language), tier, 'premium', language));
    }
  });

  it('says the premium track is coming soon while it is locked', () => {
    const tier = seasonView(seasonResponse(), DEFAULT_FEATURE_FLAGS).tiers[0];
    if (tier === undefined) throw new Error('the season has tiers');
    expect(tierStateText(t('en'), tier, 'premium')).toBe('Coming soon');
    expect(tierStateText(t('en'), tier, 'free')).toBe('Claimed');
    expect(tierLabel(t('en'), tier, 'premium', 'en')).toContain('Coming soon');
    expect(tierStateText(t('fr'), tier, 'premium')).not.toBe('Coming soon');
    expect(tierStateText(t('de'), tier, 'premium')).not.toBe('Coming soon');
  });

  it('picks plural forms and groups digits by language', () => {
    const one = rewardText(t('en'), { kind: 'scratchCard', count: 1 }, 'en');
    const two = rewardText(t('en'), { kind: 'scratchCard', count: 2 }, 'en');
    expect(one).not.toBe(two.replace('2', '1'));
    const big = { kind: 'currency', currency: 'coins', amount: 12_500 } as const;
    expect(rewardText(t('en'), big, 'en')).toContain('12,500');
    expect(rewardText(t('de'), big, 'de')).toContain('12.500');
  });

  it.each(LANGUAGES)('%s writes every countdown unit', (language) => {
    rendered(timeText(t(language), { unit: 'days', days: 2, hours: 5, minutes: 0 }, language));
    rendered(timeText(t(language), { unit: 'hours', days: 0, hours: 3, minutes: 7 }, language));
    rendered(timeText(t(language), { unit: 'minutes', days: 0, hours: 0, minutes: 9 }, language));
    rendered(timeText(t(language), { unit: 'soon', days: 0, hours: 0, minutes: 0 }, language));
  });

  it('addresses the player formally in French and German', () => {
    const fr = instances.get('fr');
    const de = instances.get('de');
    const tree = (i18n: I18n | undefined, language: Language) =>
      JSON.stringify(i18n?.instance.getResourceBundle(language, 'season'));
    const word = (pattern: string, flags = '') =>
      new RegExp(`(?<!\\p{L})(?:${pattern})(?!\\p{L})`, `u${flags}`);
    expect(tree(fr, 'fr')).toMatch(word('vous|votre', 'i'));
    expect(tree(fr, 'fr')).not.toMatch(word('tu|ton|ta|tes|toi', 'i'));
    expect(tree(de, 'de')).toMatch(word('Sie'));
    expect(tree(de, 'de')).not.toMatch(word('du|dein|deine|dich|dir'));
  });
});

describe('rewardPreviews', () => {
  it('maps a claim answer to the chips the card shows', () => {
    expect(
      rewardPreviews([
        { kind: 'currency', currency: 'pearls', amount: 20 },
        { kind: 'scratchCard', cardId: ScratchCardIdSchema.parse('scratch_fixture0001') },
      ]),
    ).toEqual([
      { kind: 'currency', currency: 'pearls', amount: 20 },
      { kind: 'scratchCard', count: 1 },
    ]);
    expect(rewardPreviews([])).toEqual([]);
  });
});

describe('questAction', () => {
  const ready = questCard(fixtureQuest({ template: 'dailyDropsEasy', done: 1 }, 0));
  const partial = questCard(fixtureQuest({ template: 'dailyDropsEasy', done: 0.3 }, 0));
  const claimed = questCard(
    fixtureQuest({ template: 'dailyDropsEasy', done: 1, claimed: true }, 0),
  );
  const cases: [QuestCardView, ClaimStatus, string][] = [
    [ready, 'idle', 'claim'],
    [partial, 'idle', 'progress'],
    [claimed, 'idle', 'claimed'],
    [ready, 'pending', 'claiming'],
    [ready, 'failed', 'retry'],
    [ready, 'already', 'already'],
    [ready, 'claimed', 'claimed'],
  ];
  it.each(cases)('%#: shows the right action', (card, status, action) => {
    expect(questAction(card, status)).toBe(action);
  });
});

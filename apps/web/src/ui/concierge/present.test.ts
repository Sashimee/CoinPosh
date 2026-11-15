import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BUNDLED_RESOURCES,
  createI18n,
  LANGUAGES,
  type I18n,
  type Language,
} from '../../i18n/index.ts';
import { loadConciergeStrings } from './i18n.ts';
import { lineText, lineValues } from './present.ts';

const instances = new Map<Language, I18n>();

beforeAll(async () => {
  for (const language of LANGUAGES) {
    const i18n = createI18n({ language, resources: BUNDLED_RESOURCES });
    await loadConciergeStrings(i18n);
    instances.set(language, i18n);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

function i18nFor(language: Language): I18n {
  const i18n = instances.get(language);
  if (i18n === undefined) throw new Error(`no i18n for ${language}`);
  return i18n;
}

describe('lineValues', () => {
  it('prints a cascade count as coins, grouped for the language', () => {
    expect(lineValues(i18nFor('en'), { count: 1240 })).toEqual({ coins: '1,240' });
    expect(lineValues(i18nFor('de'), { count: 1240 })).toEqual({ coins: '1.240' });
    expect(lineValues(i18nFor('fr'), { coins: 1240 }).coins).toMatch(/^1\s240$/u);
  });

  it('prefers an explicit coins param over a count', () => {
    expect(lineValues(i18nFor('en'), { count: 3, coins: 9 })).toEqual({ coins: '9' });
  });

  it('names tiers and rarities in each language', () => {
    expect(lineValues(i18nFor('en'), { tier: 'heirloom', rarity: 'rare' })).toEqual({
      tier: 'an heirloom coin',
      rarity: 'Rare',
    });
    expect(lineValues(i18nFor('de'), { tier: 'silver', rarity: 'legendary' })).toEqual({
      tier: 'eine Silbermünze',
      rarity: 'Legendär',
    });
  });

  it('leaves out a tier or rarity it does not know rather than printing the id', () => {
    expect(lineValues(i18nFor('en'), { tier: 'bronze', rarity: 'mythic' })).toEqual({});
  });

  it('borrows upgrade and venue names from the ui namespace', () => {
    const values = lineValues(i18nFor('en'), {
      upgrade: 'dropRate',
      venue: 'rivieraYacht',
      level: 4,
    });
    expect(values.upgrade).toBe(i18nFor('en').t('ui:upgrades.line.dropRate.name'));
    expect(values.venue).toBe('Riviera Yacht');
    expect(values.level).toBe('4');
  });

  it('says the house stand-in, and warns, for an upgrade or venue it cannot name', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const values = lineValues(i18nFor('fr'), { upgrade: 'jetpack', venue: 'moonBase' });
    expect(values.upgrade).toBe(i18nFor('fr').t('concierge:names.upgradeFallback'));
    expect(values.venue).toBe(i18nFor('fr').t('concierge:names.venueFallback'));
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]?.[0])).toContain('jetpack');
  });

  it('returns nothing for a line with no params', () => {
    expect(lineValues(i18nFor('en'), {})).toEqual({});
  });
});

describe('lineText', () => {
  it('reads the variant the brain picked, with its values filled in', () => {
    const text = lineText(i18nFor('en'), {
      lineId: 'decorum.freeze',
      variant: 0,
      params: { seconds: 6 },
    });
    expect(text).toContain('6');
    expect(text).not.toContain('{{');
  });

  it('differs between variants of the same line', () => {
    const i18n = i18nFor('de');
    const texts = new Set(
      [0, 1, 2, 3, 4].map((variant) => lineText(i18n, { lineId: 'tip.idle', variant, params: {} })),
    );
    expect(texts.size).toBe(5);
  });
});

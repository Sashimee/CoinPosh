import { describe, expect, it } from 'vitest';
import { LANGUAGES, createI18n } from '../../i18n/index.ts';
import { SESSION_STRINGS, registerSessionStrings, sessionKey } from './i18n.ts';

const keys = (tree: object, prefix = ''): string[] =>
  Object.entries(tree).flatMap(([key, value]: [string, unknown]) =>
    typeof value === 'string' ? [`${prefix}${key}`] : keys(value as object, `${prefix}${key}.`),
  );

describe('session strings', () => {
  it('has every key in English, French and German, none of them empty', () => {
    const english = keys(SESSION_STRINGS.en).sort();
    for (const language of LANGUAGES) {
      expect(keys(SESSION_STRINGS[language]).sort()).toEqual(english);
      for (const key of english) {
        const text = key
          .split('.')
          .reduce<unknown>(
            (node, part) => (node as Record<string, unknown>)[part],
            SESSION_STRINGS[language],
          );
        expect(typeof text === 'string' && text.trim().length > 0).toBe(true);
      }
    }
  });

  it('resolves through i18next in each language once registered', () => {
    const i18n = createI18n({ language: 'en', resources: { en: {}, fr: {}, de: {} } });
    registerSessionStrings(i18n);
    for (const language of LANGUAGES) {
      i18n.changeLanguage(language);
      expect(i18n.t(sessionKey('elsewhere.action'))).toBe(
        SESSION_STRINGS[language].elsewhere.action,
      );
    }
  });
});

import { LANGUAGES, type I18n, type Language, type ResourceTree } from '../../i18n/index.ts';

export const SESSION_NAMESPACE = 'tableSession';

const EN = {
  elsewhere: {
    title: 'This table is open elsewhere',
    body: 'You took your seat in another tab or on another device. Your coins are safe on the table.',
    action: 'Play here',
    busy: 'Taking your seat…',
    failed: 'The table could not be reached. Try again in a moment.',
  },
};

export const SESSION_STRINGS: Readonly<Record<Language, typeof EN>> = {
  en: EN,
  fr: {
    elsewhere: {
      title: 'Cette table est ouverte ailleurs',
      body: 'Vous avez pris place dans un autre onglet ou sur un autre appareil. Vos pièces vous attendent sur la table.',
      action: 'Jouer ici',
      busy: 'Installation à la table…',
      failed: 'La table est injoignable. Réessayez dans un instant.',
    },
  },
  de: {
    elsewhere: {
      title: 'Dieser Tisch ist woanders geöffnet',
      body: 'Sie haben in einem anderen Tab oder auf einem anderen Gerät Platz genommen. Ihre Münzen liegen sicher auf dem Tisch.',
      action: 'Hier spielen',
      busy: 'Platz wird eingenommen …',
      failed: 'Der Tisch ist nicht erreichbar. Versuchen Sie es gleich noch einmal.',
    },
  },
};

export type SessionKey = `elsewhere.${keyof typeof EN.elsewhere}`;

export function sessionKey(key: SessionKey): string {
  return `${SESSION_NAMESPACE}:${key}`;
}

export function registerSessionStrings(i18n: I18n): void {
  for (const language of LANGUAGES) {
    const tree: ResourceTree = SESSION_STRINGS[language];
    i18n.addResourceBundle(language, SESSION_NAMESPACE, tree);
  }
}

import type { SafeTypeKey } from '@coinposh/economy';
import { LANGUAGES, type I18n, type Language, type ResourceTree } from '../../i18n/index.ts';
import type { SafeRejection } from './events.ts';

export const SAFES_NAMESPACE = 'gameSafes';

/** Keys i18next picks a plural form of by `count`; French also reads `many` for millions. */
type PluralBase = 'openWithKeys' | 'openWithKeysLabel' | 'needKeys';
type PluralKey = `${PluralBase}_${'one' | 'other' | 'many'}`;

interface SafesFlatStrings {
  open: string;
  title: string;
  subtitle: string;
  close: string;
  keys: string;
  keysProvisional: string;
  empty: string;
  syncing: string;
  unlocksIn: string;
  ready: string;
  timerLabel: string;
  openFree: string;
  openFreeLabel: string;
  opening: string;
  odds: string;
  oddsShare: string;
  readyNotice: string;
  collect: string;
  skip: string;
  announce: string;
}

interface SafesStrings extends SafesFlatStrings, Record<PluralKey, string>, ResourceTree {
  type: Record<SafeTypeKey, string>;
  rejected: Record<SafeRejection, string>;
}

function plural(one: string, other: string): Record<'one' | 'other' | 'many', string> {
  return { one, other, many: other };
}

function plurals(
  forms: Record<PluralBase, Record<'one' | 'other' | 'many', string>>,
): Record<PluralKey, string> {
  const out: Partial<Record<PluralKey, string>> = {};
  for (const [base, byForm] of Object.entries(forms) as [
    PluralBase,
    Record<'one' | 'other' | 'many', string>,
  ][]) {
    out[`${base}_one`] = byForm.one;
    out[`${base}_other`] = byForm.other;
    out[`${base}_many`] = byForm.many;
  }
  return out as Record<PluralKey, string>;
}

export const SAFES_STRINGS: Readonly<Record<Language, SafesStrings>> = {
  en: {
    open: 'Safes',
    title: 'Your Safes',
    subtitle:
      'Every safe holds a provably fair roll. Spend Keys to open one now, or wait out its timer.',
    close: 'Close',
    keys: 'Keys: {{value}}',
    keysProvisional: 'awaiting the house',
    empty: 'No safes yet. Vault Crates sometimes hold one.',
    syncing: 'Checking the house clock…',
    unlocksIn: 'Opens free in {{time}}',
    ready: 'Ready: opens free',
    timerLabel: 'Timer of the {{safe}}',
    openFree: 'Open',
    openFreeLabel: 'Open the {{safe}} for free',
    opening: 'Opening…',
    odds: 'Odds',
    oddsShare: '{{rarity}} {{value}}%',
    readyNotice: 'Your {{safe}} is ready to open.',
    collect: 'Collect',
    skip: 'Tap to skip',
    announce: '{{rarity}} {{safe}}: {{contents}}',
    ...plurals({
      openWithKeys: plural('Open with {{count}} Key', 'Open with {{count}} Keys'),
      openWithKeysLabel: plural(
        'Open the {{safe}} now with {{count}} Key',
        'Open the {{safe}} now with {{count}} Keys',
      ),
      needKeys: plural('Needs {{count}} Key', 'Needs {{count}} Keys'),
    }),
    type: { gold: 'Gold Safe' },
    rejected: {
      notReady: 'This safe’s timer is still running. Open it with Keys, or wait a little longer.',
      noKeys: 'Not enough Keys for this safe.',
      gone: 'This safe is no longer in your vault.',
      unavailable: 'Safes cannot be opened right now.',
      offline:
        'You are offline. If the open went through, it will not be charged twice; try again when you are back.',
      error: 'The house could not open this safe. Please try again.',
    },
  },
  fr: {
    open: 'Coffres',
    title: 'Vos coffres-forts',
    subtitle:
      'Chaque coffre renferme un tirage équitable et vérifiable. Dépensez des clés pour l’ouvrir tout de suite, ou attendez la fin de sa minuterie.',
    close: 'Fermer',
    keys: 'Clés : {{value}}',
    keysProvisional: 'en attente de la maison',
    empty: 'Aucun coffre pour l’instant. Les caisses du coffre en contiennent parfois un.',
    syncing: 'Vérification de l’horloge de la maison…',
    unlocksIn: 'Ouverture gratuite dans {{time}}',
    ready: 'Prêt : ouverture gratuite',
    timerLabel: 'Minuterie du {{safe}}',
    openFree: 'Ouvrir',
    openFreeLabel: 'Ouvrir le {{safe}} gratuitement',
    opening: 'Ouverture…',
    odds: 'Probabilités',
    oddsShare: '{{rarity}} {{value}} %',
    readyNotice: 'Votre {{safe}} est prêt à être ouvert.',
    collect: 'Récupérer',
    skip: 'Touchez pour passer',
    announce: '{{safe}} {{rarity}} : {{contents}}',
    ...plurals({
      openWithKeys: plural('Ouvrir avec {{count}} clé', 'Ouvrir avec {{count}} clés'),
      openWithKeysLabel: plural(
        'Ouvrir le {{safe}} maintenant avec {{count}} clé',
        'Ouvrir le {{safe}} maintenant avec {{count}} clés',
      ),
      needKeys: plural('Il faut {{count}} clé', 'Il faut {{count}} clés'),
    }),
    type: { gold: 'Coffre-fort doré' },
    rejected: {
      notReady:
        'La minuterie de ce coffre tourne encore. Ouvrez-le avec des clés, ou patientez encore un peu.',
      noKeys: 'Pas assez de clés pour ce coffre.',
      gone: 'Ce coffre n’est plus dans votre chambre forte.',
      unavailable: 'Les coffres ne peuvent pas être ouverts pour le moment.',
      offline:
        'Vous êtes hors ligne. Si l’ouverture est passée, elle ne sera pas facturée deux fois ; réessayez une fois reconnecté.',
      error: 'La maison n’a pas pu ouvrir ce coffre. Veuillez réessayer.',
    },
  },
  de: {
    open: 'Tresore',
    title: 'Ihre Tresore',
    subtitle:
      'Jeder Tresor birgt einen nachweislich fairen Wurf. Öffnen Sie ihn sofort mit Schlüsseln oder warten Sie den Timer ab.',
    close: 'Schließen',
    keys: 'Schlüssel: {{value}}',
    keysProvisional: 'wartet auf das Haus',
    empty: 'Noch keine Tresore. Tresorkisten enthalten manchmal einen.',
    syncing: 'Die Uhr des Hauses wird abgeglichen…',
    unlocksIn: 'Gratis offen in {{time}}',
    ready: 'Bereit: gratis zu öffnen',
    timerLabel: 'Timer des {{safe}}s',
    openFree: 'Öffnen',
    openFreeLabel: '{{safe}} gratis öffnen',
    opening: 'Wird geöffnet…',
    odds: 'Chancen',
    oddsShare: '{{rarity}} {{value}} %',
    readyNotice: 'Ihr {{safe}} kann geöffnet werden.',
    collect: 'Einsammeln',
    skip: 'Tippen zum Überspringen',
    announce: '{{safe}} ({{rarity}}): {{contents}}',
    ...plurals({
      openWithKeys: plural('Mit {{count}} Schlüssel öffnen', 'Mit {{count}} Schlüsseln öffnen'),
      openWithKeysLabel: plural(
        '{{safe}} jetzt mit {{count}} Schlüssel öffnen',
        '{{safe}} jetzt mit {{count}} Schlüsseln öffnen',
      ),
      needKeys: plural('Braucht {{count}} Schlüssel', 'Braucht {{count}} Schlüssel'),
    }),
    type: { gold: 'Goldtresor' },
    rejected: {
      notReady:
        'Der Timer dieses Tresors läuft noch. Öffnen Sie ihn mit Schlüsseln oder warten Sie noch etwas.',
      noKeys: 'Nicht genug Schlüssel für diesen Tresor.',
      gone: 'Dieser Tresor ist nicht mehr in Ihrem Gewölbe.',
      unavailable: 'Tresore können gerade nicht geöffnet werden.',
      offline:
        'Sie sind offline. Falls die Öffnung durchging, wird sie nicht doppelt berechnet; versuchen Sie es erneut, sobald Sie wieder online sind.',
      error: 'Das Haus konnte diesen Tresor nicht öffnen. Bitte versuchen Sie es erneut.',
    },
  },
};

export type SafesKey =
  keyof SafesFlatStrings | PluralBase | `type.${SafeTypeKey}` | `rejected.${SafeRejection}`;

export function safesKey(key: SafesKey): string {
  return `${SAFES_NAMESPACE}:${key}`;
}

/** The type's display name; a type the catalogue lacks is a contract break, not a blank label. */
export function safeTypeKey(type: string): string {
  if (!(type in SAFES_STRINGS.en.type)) {
    throw new RangeError(
      `The server sent safe type "${type}", which the client has no name for; ship packages/economy and the safes strings together`,
    );
  }
  return safesKey(`type.${type as SafeTypeKey}`);
}

export function registerSafesStrings(i18n: I18n): void {
  for (const language of LANGUAGES) {
    i18n.addResourceBundle(language, SAFES_NAMESPACE, SAFES_STRINGS[language]);
  }
}

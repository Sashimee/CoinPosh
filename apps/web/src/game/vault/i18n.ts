import { LANGUAGES, type I18n, type Language, type ResourceTree } from '../../i18n/index.ts';

export const VAULT_NAMESPACE = 'gameVault';

interface VaultStrings extends ResourceTree {
  title: string;
  subtitle: string;
  away: string;
  awayMinutes: string;
  credited: string;
  capped: string;
  hint: string;
  collect: string;
  skip: string;
  amountLabel: string;
}

export const VAULT_STRINGS: Readonly<Record<Language, VaultStrings>> = {
  en: {
    title: 'The Velvet Vault',
    subtitle: 'The house kept pushing while you were away.',
    away: 'Away {{hours}} h {{minutes}} min',
    awayMinutes: 'Away {{minutes}} min',
    credited: 'Vault filled for {{hours}} h {{minutes}} min',
    capped: 'Your vault was full after {{hours}} h.',
    hint: 'Upgrade Offline Hours to keep the house pushing longer.',
    collect: 'Collect',
    skip: 'Tap to skip',
    amountLabel: '{{amount}} coins collected while away',
  },
  fr: {
    title: 'Le Coffre de Velours',
    subtitle: 'La maison a continué de pousser en votre absence.',
    away: 'Absent {{hours}} h {{minutes}} min',
    awayMinutes: 'Absent {{minutes}} min',
    credited: 'Coffre rempli pendant {{hours}} h {{minutes}} min',
    capped: 'Votre coffre était plein après {{hours}} h.',
    hint: 'Améliorez les Heures hors ligne pour que la maison pousse plus longtemps.',
    collect: 'Encaisser',
    skip: 'Touchez pour passer',
    amountLabel: '{{amount}} pièces gagnées en votre absence',
  },
  de: {
    title: 'Der Samttresor',
    subtitle: 'Das Haus hat weitergeschoben, während Sie weg waren.',
    away: '{{hours}} Std. {{minutes}} Min. abwesend',
    awayMinutes: '{{minutes}} Min. abwesend',
    credited: 'Tresor {{hours}} Std. {{minutes}} Min. lang gefüllt',
    capped: 'Ihr Tresor war nach {{hours}} Std. voll.',
    hint: 'Verbessern Sie die Offline-Stunden, damit das Haus länger schiebt.',
    collect: 'Einsammeln',
    skip: 'Tippen zum Überspringen',
    amountLabel: '{{amount}} Münzen in Ihrer Abwesenheit gesammelt',
  },
};

export function vaultKey(key: keyof VaultStrings): string {
  return `${VAULT_NAMESPACE}:${key}`;
}

export function registerVaultStrings(i18n: I18n): void {
  for (const language of LANGUAGES) {
    i18n.addResourceBundle(language, VAULT_NAMESPACE, VAULT_STRINGS[language]);
  }
}

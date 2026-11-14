import type { Rarity } from '@coinposh/shared';
import { LANGUAGES, type I18n, type Language, type ResourceTree } from '../../i18n/index.ts';
import type { ScratchRejection } from './events.ts';

export const SCRATCH_NAMESPACE = 'gameScratch';

interface ScratchFlatStrings {
  open: string;
  title: string;
  rule: string;
  count: string;
  scratch: string;
  sealing: string;
  revealAll: string;
  collect: string;
  close: string;
  hint: string;
  odds: string;
  coveredCell: string;
  uncoveredCell: string;
  announce: string;
  empty: string;
}

interface ScratchStrings extends ScratchFlatStrings, ResourceTree {
  gem: Record<Rarity, string>;
  match: Record<Rarity, string>;
  rejected: Record<ScratchRejection, string>;
}

export const SCRATCH_STRINGS: Readonly<Record<Language, ScratchStrings>> = {
  en: {
    open: 'Scratch Cards',
    title: 'Riviera Scratch',
    rule: 'Match three gems to win their prize.',
    count: 'Card {{index}} of {{total}}',
    scratch: 'Scratch it',
    sealing: 'The house is rolling…',
    revealAll: 'Reveal all',
    collect: 'Collect',
    close: 'Close',
    hint: 'Scratch the foil with a finger, or pick a square',
    odds: 'Odds',
    coveredCell: 'Square {{position}}, still under the foil',
    uncoveredCell: 'Square {{position}}: {{gem}}',
    announce: '{{match}}: {{prize}}',
    empty: 'No scratch cards yet. Vault Crates sometimes hold one.',
    gem: {
      common: 'Pearl',
      fine: 'Jade',
      rare: 'Sapphire',
      exquisite: 'Amethyst',
      legendary: 'Ruby',
      heirloom: 'Prism Diamond',
    },
    match: {
      common: 'Three Pearls',
      fine: 'Three Jades',
      rare: 'Three Sapphires',
      exquisite: 'Three Amethysts',
      legendary: 'Three Rubies',
      heirloom: 'Three Prism Diamonds',
    },
    rejected: {
      gone: 'This card has already been scratched or is no longer yours.',
      unavailable: 'Scratch cards cannot be revealed right now.',
      offline:
        'You are offline. If the card was revealed, it will not be rolled twice; try again when you are back.',
      error: 'The house could not reveal this card. Please try again.',
    },
  },
  fr: {
    open: 'Cartes à gratter',
    title: 'Grattage Riviera',
    rule: 'Alignez trois gemmes identiques pour gagner leur lot.',
    count: 'Carte {{index}} sur {{total}}',
    scratch: 'Gratter',
    sealing: 'La maison tire au sort…',
    revealAll: 'Tout révéler',
    collect: 'Récupérer',
    close: 'Fermer',
    hint: 'Grattez la feuille du doigt, ou choisissez une case',
    odds: 'Probabilités',
    coveredCell: 'Case {{position}}, encore sous la feuille',
    uncoveredCell: 'Case {{position}} : {{gem}}',
    announce: '{{match}} : {{prize}}',
    empty:
      'Aucune carte à gratter pour l’instant. Les caisses du coffre en contiennent parfois une.',
    gem: {
      common: 'Perle',
      fine: 'Jade',
      rare: 'Saphir',
      exquisite: 'Améthyste',
      legendary: 'Rubis',
      heirloom: 'Diamant prisme',
    },
    match: {
      common: 'Trois perles',
      fine: 'Trois jades',
      rare: 'Trois saphirs',
      exquisite: 'Trois améthystes',
      legendary: 'Trois rubis',
      heirloom: 'Trois diamants prismes',
    },
    rejected: {
      gone: 'Cette carte a déjà été grattée ou ne vous appartient plus.',
      unavailable: 'Les cartes à gratter ne peuvent pas être révélées pour le moment.',
      offline:
        'Vous êtes hors ligne. Si la carte a été révélée, elle ne sera pas tirée deux fois ; réessayez une fois reconnecté.',
      error: 'La maison n’a pas pu révéler cette carte. Veuillez réessayer.',
    },
  },
  de: {
    open: 'Rubbellose',
    title: 'Riviera-Rubbellos',
    rule: 'Drei gleiche Edelsteine gewinnen ihren Preis.',
    count: 'Los {{index}} von {{total}}',
    scratch: 'Freirubbeln',
    sealing: 'Das Haus würfelt…',
    revealAll: 'Alles aufdecken',
    collect: 'Einsammeln',
    close: 'Schließen',
    hint: 'Rubbeln Sie die Folie mit dem Finger frei oder wählen Sie ein Feld',
    odds: 'Chancen',
    coveredCell: 'Feld {{position}}, noch unter der Folie',
    uncoveredCell: 'Feld {{position}}: {{gem}}',
    announce: '{{match}}: {{prize}}',
    empty: 'Noch keine Rubbellose. Tresorkisten enthalten manchmal eines.',
    gem: {
      common: 'Perle',
      fine: 'Jade',
      rare: 'Saphir',
      exquisite: 'Amethyst',
      legendary: 'Rubin',
      heirloom: 'Prismadiamant',
    },
    match: {
      common: 'Drei Perlen',
      fine: 'Drei Jaden',
      rare: 'Drei Saphire',
      exquisite: 'Drei Amethyste',
      legendary: 'Drei Rubine',
      heirloom: 'Drei Prismadiamanten',
    },
    rejected: {
      gone: 'Dieses Los wurde schon aufgedeckt oder gehört Ihnen nicht mehr.',
      unavailable: 'Rubbellose können gerade nicht aufgedeckt werden.',
      offline:
        'Sie sind offline. Falls das Los aufgedeckt wurde, wird es nicht doppelt gewürfelt; versuchen Sie es erneut, sobald Sie wieder online sind.',
      error: 'Das Haus konnte dieses Los nicht aufdecken. Bitte versuchen Sie es erneut.',
    },
  },
};

export type ScratchKey =
  keyof ScratchFlatStrings | `gem.${Rarity}` | `match.${Rarity}` | `rejected.${ScratchRejection}`;

export function scratchKey(key: ScratchKey): string {
  return `${SCRATCH_NAMESPACE}:${key}`;
}

export function registerScratchStrings(i18n: I18n): void {
  for (const language of LANGUAGES) {
    i18n.addResourceBundle(language, SCRATCH_NAMESPACE, SCRATCH_STRINGS[language]);
  }
}

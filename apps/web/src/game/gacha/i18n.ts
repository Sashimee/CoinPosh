import { LANGUAGES, type I18n, type Language, type ResourceTree } from '../../i18n/index.ts';
import type { GachaRejection } from './events.ts';

export const GACHA_NAMESPACE = 'gameGacha';

interface GachaFlatStrings {
  open: string;
  title: string;
  subtitle: string;
  close: string;
  tickets: string;
  ticketsProvisional: string;
  pull: string;
  pullLabel: string;
  pulling: string;
  needTickets: string;
  ticketSources: string;
  odds: string;
  collect: string;
  announce: string;
}

interface GachaStrings extends GachaFlatStrings, ResourceTree {
  rejected: Record<GachaRejection, string>;
}

export const GACHA_STRINGS: Readonly<Record<Language, GachaStrings>> = {
  en: {
    open: 'Capsules',
    title: 'Capsule Machine',
    subtitle: 'Each Ticket turns the crank once. The house rolls every capsule, provably fair.',
    close: 'Close',
    tickets: 'Tickets: {{value}}',
    ticketsProvisional: 'awaiting the house',
    pull: 'Pull · 1 Ticket',
    pullLabel: 'Pull a capsule for 1 Ticket',
    pulling: 'Turning…',
    needTickets: 'Earn a Ticket from a Vault Crate to pull.',
    ticketSources: 'Vault Crates can hold Tickets, and rarer crates hold more.',
    odds: 'Odds and fairness',
    collect: 'Collect',
    announce: '{{rarity}} capsule: {{contents}}',
    rejected: {
      noTickets: 'Not enough Tickets for a pull.',
      unavailable: 'The capsule machine is closed right now.',
      busy: 'The machine needs a moment. Try again shortly.',
      offline:
        'You are offline. If the pull went through, it will not be charged twice; try again when you are back.',
      error: 'The house could not turn the crank. Please try again.',
    },
  },
  fr: {
    open: 'Capsules',
    title: 'Machine à capsules',
    subtitle:
      'Chaque ticket tourne la manivelle une fois. La maison tire chaque capsule, de façon équitable et vérifiable.',
    close: 'Fermer',
    tickets: 'Tickets : {{value}}',
    ticketsProvisional: 'en attente de la maison',
    pull: 'Tirer · 1 ticket',
    pullLabel: 'Tirer une capsule pour 1 ticket',
    pulling: 'La manivelle tourne…',
    needTickets: 'Gagnez un ticket dans une caisse du coffre pour tirer.',
    ticketSources:
      'Les caisses du coffre peuvent contenir des tickets, et les plus rares en contiennent davantage.',
    odds: 'Probabilités et équité',
    collect: 'Récupérer',
    announce: 'Capsule {{rarity}} : {{contents}}',
    rejected: {
      noTickets: 'Pas assez de tickets pour un tirage.',
      unavailable: 'La machine à capsules est fermée pour le moment.',
      busy: 'La machine a besoin d’un instant. Réessayez bientôt.',
      offline:
        'Vous êtes hors ligne. Si le tirage est passé, il ne sera pas facturé deux fois ; réessayez une fois de retour.',
      error: 'La maison n’a pas pu tourner la manivelle. Veuillez réessayer.',
    },
  },
  de: {
    open: 'Kapseln',
    title: 'Kapselautomat',
    subtitle:
      'Jedes Ticket dreht die Kurbel einmal. Das Haus lost jede Kapsel aus, nachweislich fair.',
    close: 'Schließen',
    tickets: 'Tickets: {{value}}',
    ticketsProvisional: 'wartet auf das Haus',
    pull: 'Ziehen · 1 Ticket',
    pullLabel: 'Eine Kapsel für 1 Ticket ziehen',
    pulling: 'Kurbel dreht…',
    needTickets: 'Verdienen Sie ein Ticket aus einer Tresorkiste, um zu ziehen.',
    ticketSources: 'Tresorkisten können Tickets enthalten, seltenere Kisten sogar mehr.',
    odds: 'Chancen und Fairness',
    collect: 'Einsammeln',
    announce: 'Kapsel ({{rarity}}): {{contents}}',
    rejected: {
      noTickets: 'Nicht genug Tickets zum Ziehen.',
      unavailable: 'Der Kapselautomat ist gerade geschlossen.',
      busy: 'Der Automat braucht einen Moment. Versuchen Sie es gleich noch einmal.',
      offline:
        'Sie sind offline. Falls das Ziehen durchging, wird es nicht doppelt berechnet; versuchen Sie es erneut, sobald Sie wieder online sind.',
      error: 'Das Haus konnte die Kurbel nicht drehen. Bitte versuchen Sie es erneut.',
    },
  },
};

export type GachaKey = keyof GachaFlatStrings | `rejected.${GachaRejection}`;

export function gachaKey(key: GachaKey): string {
  return `${GACHA_NAMESPACE}:${key}`;
}

export function registerGachaStrings(i18n: I18n): void {
  for (const language of LANGUAGES) {
    i18n.addResourceBundle(language, GACHA_NAMESPACE, GACHA_STRINGS[language]);
  }
}

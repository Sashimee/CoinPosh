import type { Currency, Rarity } from '@coinposh/shared';
import { LANGUAGES, type I18n, type Language, type ResourceTree } from '../../i18n/index.ts';

export const CRATES_NAMESPACE = 'gameCrates';

interface CratesFlatStrings {
  title: string;
  arrived: string;
  opened: string;
  collect: string;
  skip: string;
  fair: string;
  contents: string;
  pity: string;
  pityNext: string;
  charmNew: string;
  charmLevel: string;
  safe: string;
  scratchCard: string;
  collectible: string;
}

interface CratesStrings extends CratesFlatStrings, ResourceTree {
  rarity: Record<Rarity, string>;
  currency: Record<Currency, string>;
}

export const CRATES_STRINGS: Readonly<Record<Language, CratesStrings>> = {
  en: {
    title: 'Vault Crate',
    arrived: 'A Vault Crate is on the table. Push it over the edge!',
    opened: '{{rarity}} Vault Crate opened',
    collect: 'Collect',
    skip: 'Tap to skip',
    fair: 'Certified Fair',
    contents: 'Crate contents',
    pity: '{{rarity}} or better guaranteed within {{count}} crates',
    pityNext: '{{rarity}} or better guaranteed on your next crate',
    charmNew: 'New Charm',
    charmLevel: 'Charm upgraded to level {{level}}',
    safe: 'Key-locked Safe',
    scratchCard: 'Scratch Card',
    collectible: 'Album Card',
    rarity: {
      common: 'Common',
      fine: 'Fine',
      rare: 'Rare',
      exquisite: 'Exquisite',
      legendary: 'Legendary',
      heirloom: 'Heirloom',
    },
    currency: {
      coins: 'Coins',
      bullion: 'Bullion',
      goldBars: 'Gold Bars',
      pearls: 'Pearls',
      keys: 'Keys',
      tickets: 'Tickets',
      stars: 'Stars',
    },
  },
  fr: {
    title: 'Caisse du Coffre',
    arrived: 'Une Caisse du Coffre est sur la table. Poussez-la par-dessus bord !',
    opened: 'Caisse du Coffre {{rarity}} ouverte',
    collect: 'Encaisser',
    skip: 'Touchez pour passer',
    fair: 'Équité certifiée',
    contents: 'Contenu de la caisse',
    pity: '{{rarity}} ou mieux garanti d’ici {{count}} caisses',
    pityNext: '{{rarity}} ou mieux garanti dans votre prochaine caisse',
    charmNew: 'Nouveau Charme',
    charmLevel: 'Charme amélioré au niveau {{level}}',
    safe: 'Coffre-fort à clé',
    scratchCard: 'Carte à gratter',
    collectible: 'Carte d’album',
    rarity: {
      common: 'Commune',
      fine: 'Raffinée',
      rare: 'Rare',
      exquisite: 'Exquise',
      legendary: 'Légendaire',
      heirloom: 'Héritage',
    },
    currency: {
      coins: 'Pièces',
      bullion: 'Lingots',
      goldBars: 'Barres d’or',
      pearls: 'Perles',
      keys: 'Clés',
      tickets: 'Tickets',
      stars: 'Étoiles',
    },
  },
  de: {
    title: 'Tresorkiste',
    arrived: 'Eine Tresorkiste liegt auf dem Tisch. Schieben Sie sie über die Kante!',
    opened: 'Tresorkiste ({{rarity}}) geöffnet',
    collect: 'Einsammeln',
    skip: 'Tippen zum Überspringen',
    fair: 'Zertifiziert fair',
    contents: 'Inhalt der Kiste',
    pity: '{{rarity}} oder besser garantiert in höchstens {{count}} Kisten',
    pityNext: '{{rarity}} oder besser garantiert in Ihrer nächsten Kiste',
    charmNew: 'Neuer Glücksbringer',
    charmLevel: 'Glücksbringer auf Stufe {{level}} verbessert',
    safe: 'Schlüsseltresor',
    scratchCard: 'Rubbelkarte',
    collectible: 'Albumkarte',
    rarity: {
      common: 'Gewöhnlich',
      fine: 'Fein',
      rare: 'Selten',
      exquisite: 'Exquisit',
      legendary: 'Legendär',
      heirloom: 'Erbstück',
    },
    currency: {
      coins: 'Münzen',
      bullion: 'Barren',
      goldBars: 'Goldbarren',
      pearls: 'Perlen',
      keys: 'Schlüssel',
      tickets: 'Tickets',
      stars: 'Sterne',
    },
  },
};

type FlatKey = keyof CratesFlatStrings;

export function cratesKey(key: FlatKey | `rarity.${Rarity}` | `currency.${Currency}`): string {
  return `${CRATES_NAMESPACE}:${key}`;
}

export function registerCratesStrings(i18n: I18n): void {
  for (const language of LANGUAGES) {
    i18n.addResourceBundle(language, CRATES_NAMESPACE, CRATES_STRINGS[language]);
  }
}

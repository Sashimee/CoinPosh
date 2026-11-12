import type { Currency, PityCounters, Rarity } from '@coinposh/shared';
import { LANGUAGES, type I18n, type Language, type ResourceTree } from '../../i18n/index.ts';
import type { AlbumItemId, AlbumSetKey } from './loot.ts';

type PityRarity = keyof PityCounters;

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
  albumSet: string;
  albumSetComplete: string;
}

type GainKey = `${Currency}_${'one' | 'other' | 'many'}`;

interface CratesStrings extends CratesFlatStrings, ResourceTree {
  rarity: Record<Rarity, string>;
  /** The rarity on an item's line, standing alone: FR `rarity.*` agrees with « Caisse ». */
  chip: Record<Rarity, string>;
  gain: Record<GainKey, string>;
  item: Record<AlbumItemId, string>;
  set: Record<AlbumSetKey, string>;
  /** The guaranteed crate as the pity line's subject, article and adjective agreement included. */
  pityCrate: Record<PityRarity, string>;
}

/**
 * `+{{value}} <unit>` lines in i18next's plural keys, chosen by `count`. French files round
 * millions under `many`, which reads like `other`; EN and DE never select it.
 */
function gains(
  units: Record<Currency, readonly [one: string, other: string]>,
): Record<GainKey, string> {
  const out: Partial<Record<GainKey, string>> = {};
  for (const [currency, [one, other]] of Object.entries(units) as [
    Currency,
    readonly [string, string],
  ][]) {
    out[`${currency}_one`] = `+{{value}} ${one}`;
    out[`${currency}_other`] = `+{{value}} ${other}`;
    out[`${currency}_many`] = `+{{value}} ${other}`;
  }
  return out as Record<GainKey, string>;
}

export const CRATES_STRINGS: Readonly<Record<Language, CratesStrings>> = {
  en: {
    title: 'Vault Crate',
    arrived: 'Push it over the edge!',
    opened: '{{rarity}} Vault Crate opened',
    collect: 'Collect',
    skip: 'Tap to skip',
    fair: 'Certified Fair',
    contents: 'Crate contents',
    pity: '{{crate}} or better within {{count}} opens',
    pityNext: '{{crate}} or better on your next open',
    charmNew: 'New Charm',
    charmLevel: 'Charm upgraded to level {{level}}',
    safe: 'Key-locked Safe',
    scratchCard: 'Scratch Card',
    collectible: 'Album Card',
    albumSet: '{{set}} · {{owned}} / {{total}}',
    albumSetComplete: '{{set}} complete · {{owned}} / {{total}}',
    rarity: {
      common: 'Common',
      fine: 'Fine',
      rare: 'Rare',
      exquisite: 'Exquisite',
      legendary: 'Legendary',
      heirloom: 'Heirloom',
    },
    chip: {
      common: 'Common',
      fine: 'Fine',
      rare: 'Rare',
      exquisite: 'Exquisite',
      legendary: 'Legendary',
      heirloom: 'Heirloom',
    },
    gain: gains({
      coins: ['Coin', 'Coins'],
      bullion: ['Bullion', 'Bullion'],
      goldBars: ['Gold Bar', 'Gold Bars'],
      pearls: ['Pearl', 'Pearls'],
      keys: ['Key', 'Keys'],
      tickets: ['Ticket', 'Tickets'],
      stars: ['Star', 'Stars'],
    }),
    item: {
      teakDeckCoin: 'Teak Deck Coin',
      brassCleatCoin: 'Brass Cleat Coin',
      lifebuoyCoin: 'Lifebuoy Coin',
      anchorCoin: 'Anchor Coin',
      compassRoseCoin: 'Compass Rose Coin',
      captainsBellCharm: 'Captain’s Bell',
      sailclothCoin: 'Sailcloth Coin',
      portholeCoin: 'Porthole Coin',
      sextantCoin: 'Sextant Coin',
      champagneBucketCharm: 'Champagne Bucket',
      navyLacquerCoin: 'Navy Lacquer Coin',
      harbourLightsCoin: 'Harbour Lights Coin',
      coralSunsetCoin: 'Coral Sunset Coin',
      yachtClubPennant: 'Yacht Club Pennant',
      pearlNecklaceCharm: 'Pearl Necklace',
      brushedGoldHelmCoin: 'Brushed Gold Helm Coin',
      monacoGrandPrixCoin: 'Grand Prix Coin',
      admiralsSovereign: 'Admiral’s Sovereign',
      duchessSovereign1891: 'Duchess Sovereign, 1891',
    },
    set: {
      deckEssentials: 'Deck Essentials',
      captainsTable: 'Captain’s Table',
      sunsetGala: 'Sunset Gala',
    },
    pityCrate: {
      rare: 'A Rare crate',
      exquisite: 'An Exquisite crate',
      legendary: 'A Legendary crate',
    },
  },
  fr: {
    title: 'Caisse du Coffre',
    arrived: 'Poussez-la par-dessus bord !',
    opened: 'Caisse du Coffre {{rarity}} ouverte',
    collect: 'Encaisser',
    skip: 'Touchez pour passer',
    fair: 'Équité certifiée',
    contents: 'Contenu de la caisse',
    pity: '{{crate}} ou mieux garantie d’ici {{count}} ouvertures',
    pityNext: '{{crate}} ou mieux garantie à votre prochaine ouverture',
    charmNew: 'Nouveau Charme',
    charmLevel: 'Charme amélioré au niveau {{level}}',
    safe: 'Coffre-fort à clé',
    scratchCard: 'Carte à gratter',
    collectible: 'Carte d’album',
    albumSet: '{{set}} · {{owned}} / {{total}}',
    albumSetComplete: '{{set}} au complet · {{owned}} / {{total}}',
    rarity: {
      common: 'Commune',
      fine: 'Raffinée',
      rare: 'Rare',
      exquisite: 'Exquise',
      legendary: 'Légendaire',
      heirloom: 'Héritage',
    },
    chip: {
      common: 'Ordinaire',
      fine: 'De choix',
      rare: 'Rare',
      exquisite: 'Sublime',
      legendary: 'Légendaire',
      heirloom: 'Héritage',
    },
    gain: gains({
      coins: ['Pièce', 'Pièces'],
      bullion: ['Lingot', 'Lingots'],
      goldBars: ['Barre d’or', 'Barres d’or'],
      pearls: ['Perle', 'Perles'],
      keys: ['Clé', 'Clés'],
      tickets: ['Ticket', 'Tickets'],
      stars: ['Étoile', 'Étoiles'],
    }),
    item: {
      teakDeckCoin: 'Pièce Pont de teck',
      brassCleatCoin: 'Pièce Taquet de laiton',
      lifebuoyCoin: 'Pièce Bouée',
      anchorCoin: 'Pièce Ancre',
      compassRoseCoin: 'Pièce Rose des vents',
      captainsBellCharm: 'Cloche du capitaine',
      sailclothCoin: 'Pièce Toile à voile',
      portholeCoin: 'Pièce Hublot',
      sextantCoin: 'Pièce Sextant',
      champagneBucketCharm: 'Seau à champagne',
      navyLacquerCoin: 'Pièce Laque marine',
      harbourLightsCoin: 'Pièce Feux du port',
      coralSunsetCoin: 'Pièce Couchant corail',
      yachtClubPennant: 'Fanion du Yacht-Club',
      pearlNecklaceCharm: 'Collier de perles',
      brushedGoldHelmCoin: 'Pièce Barre d’or brossé',
      monacoGrandPrixCoin: 'Pièce Grand Prix',
      admiralsSovereign: 'Souverain de l’amiral',
      duchessSovereign1891: 'Souverain de la Duchesse, 1891',
    },
    set: {
      deckEssentials: 'L’essentiel du pont',
      captainsTable: 'La table du capitaine',
      sunsetGala: 'Gala au couchant',
    },
    pityCrate: {
      rare: 'Une caisse Rare',
      exquisite: 'Une caisse Exquise',
      legendary: 'Une caisse Légendaire',
    },
  },
  de: {
    title: 'Tresorkiste',
    arrived: 'Schieben Sie sie über die Kante!',
    opened: 'Tresorkiste ({{rarity}}) geöffnet',
    collect: 'Einsammeln',
    skip: 'Tippen zum Überspringen',
    fair: 'Zertifiziert fair',
    contents: 'Inhalt der Kiste',
    pity: '{{crate}} oder besser garantiert in höchstens {{count}} Öffnungen',
    pityNext: '{{crate}} oder besser garantiert bei Ihrer nächsten Öffnung',
    charmNew: 'Neuer Glücksbringer',
    charmLevel: 'Glücksbringer auf Stufe {{level}} verbessert',
    safe: 'Schlüsseltresor',
    scratchCard: 'Rubbelkarte',
    collectible: 'Albumkarte',
    albumSet: '{{set}} · {{owned}} / {{total}}',
    albumSetComplete: '{{set}} komplett · {{owned}} / {{total}}',
    rarity: {
      common: 'Gewöhnlich',
      fine: 'Fein',
      rare: 'Selten',
      exquisite: 'Exquisit',
      legendary: 'Legendär',
      heirloom: 'Erbstück',
    },
    chip: {
      common: 'Gewöhnlich',
      fine: 'Fein',
      rare: 'Selten',
      exquisite: 'Exquisit',
      legendary: 'Legendär',
      heirloom: 'Erbstück',
    },
    gain: gains({
      coins: ['Münze', 'Münzen'],
      bullion: ['Barren', 'Barren'],
      goldBars: ['Goldbarren', 'Goldbarren'],
      pearls: ['Perle', 'Perlen'],
      keys: ['Schlüssel', 'Schlüssel'],
      tickets: ['Ticket', 'Tickets'],
      stars: ['Stern', 'Sterne'],
    }),
    item: {
      teakDeckCoin: 'Teakdeck-Münze',
      brassCleatCoin: 'Messingklampen-Münze',
      lifebuoyCoin: 'Rettungsring-Münze',
      anchorCoin: 'Anker-Münze',
      compassRoseCoin: 'Kompassrosen-Münze',
      captainsBellCharm: 'Kapitänsglocke',
      sailclothCoin: 'Segeltuch-Münze',
      portholeCoin: 'Bullaugen-Münze',
      sextantCoin: 'Sextanten-Münze',
      champagneBucketCharm: 'Champagnerkühler',
      navyLacquerCoin: 'Marinelack-Münze',
      harbourLightsCoin: 'Hafenlichter-Münze',
      coralSunsetCoin: 'Abendrot-Münze',
      yachtClubPennant: 'Yachtclub-Wimpel',
      pearlNecklaceCharm: 'Perlenkette',
      brushedGoldHelmCoin: 'Goldsteuerrad-Münze',
      monacoGrandPrixCoin: 'Grand-Prix-Münze',
      admiralsSovereign: 'Sovereign des Admirals',
      duchessSovereign1891: 'Sovereign der Herzogin, 1891',
    },
    set: {
      deckEssentials: 'Deck-Grundausstattung',
      captainsTable: 'Kapitänstafel',
      sunsetGala: 'Gala im Abendrot',
    },
    pityCrate: {
      rare: 'Eine seltene Kiste',
      exquisite: 'Eine exquisite Kiste',
      legendary: 'Eine legendäre Kiste',
    },
  },
};

type FlatKey = keyof CratesFlatStrings;

export function cratesKey(
  key:
    | FlatKey
    | `rarity.${Rarity}`
    | `chip.${Rarity}`
    | `gain.${Currency}`
    | `item.${AlbumItemId}`
    | `set.${AlbumSetKey}`
    | `pityCrate.${PityRarity}`,
): string {
  return `${CRATES_NAMESPACE}:${key}`;
}

export function registerCratesStrings(i18n: I18n): void {
  for (const language of LANGUAGES) {
    i18n.addResourceBundle(language, CRATES_NAMESPACE, CRATES_STRINGS[language]);
  }
}

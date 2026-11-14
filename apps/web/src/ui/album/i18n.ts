import type { CollectibleKind, VenueId } from '@coinposh/shared';
import { registerCratesStrings } from '../../game/crates/i18n.ts';
import type { AlbumSetKey } from '../../game/crates/loot.ts';
import {
  LANGUAGES,
  type I18n,
  type InterpolationValues,
  type Language,
  type ResourceTree,
} from '../../i18n/index.ts';
import type { HeirloomId } from './model.ts';

export const ALBUM_NAMESPACE = 'uiAlbum';

interface AlbumFlatStrings {
  title: string;
  open: string;
  loading: string;
  error: string;
  retry: string;
  unavailable: string;
  empty: string;
  hint: string;
  piecesLabel: string;
  albumBonus: string;
  albumBonusNone: string;
  albumBonusCaption: string;
  setProgress: string;
  setProgressLabel: string;
  bonusLabel: string;
  bonusValue: string;
  bonusEarned: string;
  bonusLocked: string;
  stamp: string;
  slotOwned: string;
  slotMissing: string;
  slotMissingName: string;
  copies: string;
  readLore: string;
  readSetLore: string;
  loreClose: string;
  loreSetEyebrow: string;
  loreFromSet: string;
  loreOwned: string;
  fanfare: string;
}

interface AlbumStrings extends AlbumFlatStrings, ResourceTree {
  venue: Record<VenueId, string>;
  kind: Record<CollectibleKind, string>;
  lore: { item: Record<HeirloomId, string>; set: Record<AlbumSetKey, string> };
  /** i18next plural forms; FR adds `_many`, which it picks for round millions. */
  count: Readonly<Record<string, string>>;
}

export const ALBUM_STRINGS: Readonly<Record<Language, AlbumStrings>> = {
  en: {
    title: 'Collection Album',
    open: 'Open the Collection Album',
    loading: 'Turning the gilt-edged pages…',
    error: 'The album could not be fetched.',
    retry: 'Try again',
    unavailable: 'The album is locked away for now',
    empty: 'No sets are on display yet',
    hint: 'Tap an Heirloom or a completed set to read its story',
    piecesLabel: 'pieces collected',
    albumBonus: '{{value}} coin value for good',
    albumBonusNone: 'Complete a set for a lasting bonus',
    albumBonusCaption: 'coin value, for good',
    setProgress: '{{owned}} of {{total}}',
    setProgressLabel: '{{set}}: {{owned}} of {{total}} pieces',
    bonusLabel: 'Completion bonus',
    bonusValue: '+{{value}} coin value',
    bonusEarned: 'Earned',
    bonusLocked: 'Locked',
    stamp: 'Complete',
    slotOwned: '{{name}}, {{rarity}} {{kind}}',
    slotMissing: 'Not yet found: a {{rarity}} piece',
    slotMissingName: 'Undiscovered',
    copies: '{{count}} copies',
    readLore: 'Read the story of {{name}}',
    readSetLore: 'Read the story of the {{set}} set',
    loreClose: 'Close the story',
    loreSetEyebrow: 'Set complete',
    loreFromSet: 'From the {{set}} set',
    loreOwned: 'In your collection',
    fanfare: '{{set}} complete! {{bonus}}, for good.',
    venue: {
      rivieraYacht: 'Riviera Yacht',
      salonDeParis: 'Salon de Paris',
      tokyoPenthouse: 'Tokyo Penthouse',
      alpineChalet: 'Alpine Chalet',
      orbitalCasino: 'Orbital Casino',
    },
    kind: { coinSkin: 'coin', charm: 'charm', heirloom: 'heirloom' },
    lore: {
      item: {
        duchessSovereign1891:
          'Struck in 1891 for a duchess who never once lost at Monte Carlo. She wore it on a chain beneath her pearls and swore it grew warm whenever the house was about to pay. It vanished in 1923. Tonight it rests in your album.',
      },
      set: {
        deckEssentials:
          'Every yacht worth its berth begins here: teak underfoot, brass at hand and a bell to call the change of watch. Gather them all and the deck itself seems to tip a little more silver your way.',
        captainsTable:
          'An invitation to the captain’s table is never printed. It is earned over sextants and champagne, under harbour lights, by guests who know when to push and when to wait.',
        sunsetGala:
          'When the sun slips behind the Riviera the gala begins: pennants snap, sovereigns change hands and somewhere below deck an heirloom waits to be claimed. Few guests stay for the last light. You did.',
      },
    },
    count: {
      subtitle_one: '{{owned}} of {{total}} pieces · {{count}} set complete',
      subtitle_other: '{{owned}} of {{total}} pieces · {{count}} sets complete',
    },
  },
  fr: {
    title: 'Album de collection',
    open: 'Ouvrir l’album de collection',
    loading: 'On tourne les pages dorées sur tranche…',
    error: 'Impossible de charger l’album.',
    retry: 'Réessayer',
    unavailable: 'L’album est sous clé pour l’instant',
    empty: 'Aucune série n’est encore exposée',
    hint: 'Touchez un objet de famille ou une série complète pour lire son histoire',
    piecesLabel: 'pièces réunies',
    albumBonus: '{{value}} de valeur des pièces, pour toujours',
    albumBonusNone: 'Complétez une série pour un bonus durable',
    albumBonusCaption: 'de valeur des pièces, pour toujours',
    setProgress: '{{owned}} sur {{total}}',
    setProgressLabel: '{{set}} : {{owned}} pièces sur {{total}}',
    bonusLabel: 'Bonus de série',
    bonusValue: '+{{value}} de valeur des pièces',
    bonusEarned: 'Acquis',
    bonusLocked: 'Verrouillé',
    stamp: 'Complète',
    slotOwned: '{{name}}, {{kind}} {{rarity}}',
    slotMissing: 'Pas encore trouvée : une pièce {{rarity}}',
    slotMissingName: 'Inconnue',
    copies: '{{count}} exemplaires',
    readLore: 'Lire l’histoire de {{name}}',
    readSetLore: 'Lire l’histoire de la série {{set}}',
    loreClose: 'Fermer l’histoire',
    loreSetEyebrow: 'Série complète',
    loreFromSet: 'De la série {{set}}',
    loreOwned: 'Dans votre collection',
    fanfare: '{{set}} complète ! {{bonus}}, pour toujours.',
    venue: {
      rivieraYacht: 'Yacht de la Riviera',
      salonDeParis: 'Salon de Paris',
      tokyoPenthouse: 'Penthouse de Tokyo',
      alpineChalet: 'Chalet alpin',
      orbitalCasino: 'Casino orbital',
    },
    kind: { coinSkin: 'pièce', charm: 'charme', heirloom: 'objet de famille' },
    lore: {
      item: {
        duchessSovereign1891:
          'Frappé en 1891 pour une duchesse qui ne perdit jamais à Monte-Carlo. Elle le portait sous ses perles et jurait qu’il tiédissait chaque fois que la maison allait payer. Disparu en 1923, il repose ce soir dans votre album.',
      },
      set: {
        deckEssentials:
          'Tout yacht digne de son anneau commence ici : du teck sous les pieds, du laiton sous la main et une cloche pour sonner le quart. Réunissez-les et le pont semble pencher un peu plus d’argent vers vous.',
        captainsTable:
          'Une invitation à la table du capitaine ne s’imprime jamais. Elle se gagne entre sextants et champagne, sous les feux du port, par ceux qui savent quand pousser et quand attendre.',
        sunsetGala:
          'Quand le soleil glisse derrière la Riviera, le gala commence : les fanions claquent, les souverains changent de mains et, sous le pont, un objet de famille attend son heure. Peu d’invités restent jusqu’à la dernière lueur. Vous, oui.',
      },
    },
    count: {
      subtitle_one: '{{owned}} pièces sur {{total}} · {{count}} série complète',
      subtitle_many: '{{owned}} pièces sur {{total}} · {{count}} séries complètes',
      subtitle_other: '{{owned}} pièces sur {{total}} · {{count}} séries complètes',
    },
  },
  de: {
    title: 'Sammelalbum',
    open: 'Sammelalbum öffnen',
    loading: 'Die Seiten mit Goldschnitt werden umgeblättert…',
    error: 'Das Album konnte nicht geladen werden.',
    retry: 'Erneut versuchen',
    unavailable: 'Das Album ist gerade weggeschlossen',
    empty: 'Noch keine Serien ausgestellt',
    hint: 'Tippe auf ein Erbstück oder eine vollständige Serie, um ihre Geschichte zu lesen',
    piecesLabel: 'Stücke gesammelt',
    albumBonus: '{{value}} Münzwert, für immer',
    albumBonusNone: 'Vervollständige eine Serie für einen dauerhaften Bonus',
    albumBonusCaption: 'Münzwert, für immer',
    setProgress: '{{owned}} von {{total}}',
    setProgressLabel: '{{set}}: {{owned}} von {{total}} Stücken',
    bonusLabel: 'Serienbonus',
    bonusValue: '+{{value}} Münzwert',
    bonusEarned: 'Erhalten',
    bonusLocked: 'Gesperrt',
    stamp: 'Vollständig',
    slotOwned: '{{name}}, {{rarity}}, {{kind}}',
    slotMissing: 'Noch nicht gefunden: ein Stück der Stufe {{rarity}}',
    slotMissingName: 'Unentdeckt',
    copies: '{{count}} Exemplare',
    readLore: 'Geschichte von {{name}} lesen',
    readSetLore: 'Geschichte der Serie {{set}} lesen',
    loreClose: 'Geschichte schließen',
    loreSetEyebrow: 'Serie vollständig',
    loreFromSet: 'Aus der Serie {{set}}',
    loreOwned: 'In deiner Sammlung',
    fanfare: '{{set}} vollständig! {{bonus}}, für immer.',
    venue: {
      rivieraYacht: 'Riviera-Jacht',
      salonDeParis: 'Salon de Paris',
      tokyoPenthouse: 'Tokio-Penthouse',
      alpineChalet: 'Alpenchalet',
      orbitalCasino: 'Orbital-Casino',
    },
    kind: { coinSkin: 'Münze', charm: 'Talisman', heirloom: 'Erbstück' },
    lore: {
      item: {
        duchessSovereign1891:
          '1891 für eine Herzogin geprägt, die in Monte Carlo nie verlor. Sie trug ihn unter ihren Perlen und schwor, er werde warm, sobald das Haus auszahlen müsse. 1923 verschwand er. Heute Nacht ruht er in deinem Album.',
      },
      set: {
        deckEssentials:
          'Jede Jacht, die ihren Liegeplatz verdient, beginnt hier: Teak unter den Füßen, Messing zur Hand und eine Glocke für den Wachwechsel. Sammle sie alle, und das Deck neigt dir ein wenig mehr Silber zu.',
        captainsTable:
          'Eine Einladung an den Kapitänstisch wird nie gedruckt. Man verdient sie sich zwischen Sextanten und Champagner, unter den Hafenlichtern, wenn man weiß, wann man schiebt und wann man wartet.',
        sunsetGala:
          'Wenn die Sonne hinter der Riviera versinkt, beginnt die Gala: Wimpel knattern, Sovereigns wechseln die Hand, und unter Deck wartet ein Erbstück auf seinen Besitzer. Nur wenige Gäste bleiben bis zum letzten Licht. Du schon.',
      },
    },
    count: {
      subtitle_one: '{{owned}} von {{total}} Stücken · {{count}} Serie vollständig',
      subtitle_other: '{{owned}} von {{total}} Stücken · {{count}} Serien vollständig',
    },
  },
};

type FlatKey = keyof AlbumFlatStrings;

export type AlbumKey =
  | FlatKey
  | `venue.${VenueId}`
  | `kind.${CollectibleKind}`
  | `lore.item.${HeirloomId}`
  | `lore.set.${AlbumSetKey}`
  | 'count.subtitle';

export function albumKey(key: AlbumKey): string {
  return `${ALBUM_NAMESPACE}:${key}`;
}

export type AlbumT = (key: AlbumKey, values?: InterpolationValues) => string;

export function albumT(i18n: I18n): AlbumT {
  return (key, values) => i18n.t(albumKey(key), values);
}

/** Also registers the crate strings, whose item, set and rarity names the album reuses. */
export function registerAlbumStrings(i18n: I18n): void {
  registerCratesStrings(i18n);
  for (const language of LANGUAGES) {
    i18n.addResourceBundle(language, ALBUM_NAMESPACE, ALBUM_STRINGS[language]);
  }
}

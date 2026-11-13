import { LANGUAGES, type I18n, type Language, type ResourceTree } from '../../i18n/index.ts';
import { registerCratesStrings } from '../../game/crates/i18n.ts';
import type { ItemKind, SortMode } from './model.ts';

export const INVENTORY_NAMESPACE = 'uiInventory';

interface InventoryFlatStrings {
  title: string;
  open: string;
  filters: string;
  kindFilter: string;
  rarityFilter: string;
  rarityAll: string;
  sortBy: string;
  loading: string;
  empty: string;
  emptyHint: string;
  emptyFiltered: string;
  clearFilters: string;
  error: string;
  retry: string;
  unavailable: string;
  level: string;
  levelShort: string;
  copies: string;
  equipped: string;
  ready: string;
  sealed: string;
  turnOver: string;
  turnBack: string;
  fromSet: string;
  duplicates: string;
  fuse: string;
  fusing: string;
  fuseAuto: string;
  fuseNeed: string;
  fuseFailed: string;
  levelUp: string;
  levelGain: string;
  inspectHint: string;
}

interface InventoryStrings extends InventoryFlatStrings, ResourceTree {
  kind: Record<ItemKind | 'all', string>;
  sort: Record<SortMode, string>;
  about: Record<ItemKind, string>;
  /** i18next plural forms; FR adds `_many`, which it picks for round millions. */
  count: Readonly<Record<string, string>>;
}

export const INVENTORY_STRINGS: Readonly<Record<Language, InventoryStrings>> = {
  en: {
    title: 'Collection',
    open: 'Open your collection',
    filters: 'Filter and sort',
    kindFilter: 'Show',
    rarityFilter: 'Rarity',
    rarityAll: 'Every rarity',
    sortBy: 'Sorted by {{mode}}',
    loading: 'Polishing the display case…',
    empty: 'The display case is empty',
    emptyHint: 'Crates from the table bring charms, safes and scratch cards.',
    emptyFiltered: 'Nothing here matches',
    clearFilters: 'Show everything',
    error: 'The collection could not be fetched.',
    retry: 'Try again',
    unavailable: 'The display case is closed for now',
    level: 'Level {{level}}',
    levelShort: 'Lv',
    copies: '×{{count}}',
    equipped: 'Equipped',
    ready: 'Ready',
    sealed: 'Sealed',
    turnOver: 'Turn over {{name}}',
    turnBack: 'Turn back',
    fromSet: 'From the {{set}} set',
    duplicates: '{{count}} copies owned',
    fuse: 'Fuse duplicates',
    fusing: 'Fusing…',
    fuseAuto: 'Duplicates level this charm up the moment they arrive.',
    fuseNeed: '{{have}} of {{need}} duplicates toward the next level',
    fuseFailed: 'The fuse did not go through. Nothing was spent.',
    levelUp: '{{name}} rose to level {{level}}',
    levelGain: '+1 Lv',
    inspectHint: 'Tap a card to turn it over',
    kind: { all: 'All', charm: 'Charms', safe: 'Safes', scratchCard: 'Scratch cards' },
    sort: { rarity: 'rarity', level: 'level', newest: 'newest', name: 'name' },
    about: {
      charm: 'Socket it on a table to bend the house odds your way.',
      safe: 'Opens when its timer runs out, or sooner with a key.',
      scratchCard: 'Scratch to reveal a prize the server has already sealed.',
    },
    count: {
      subtitle_one: '{{count}} treasure',
      subtitle_other: '{{count}} treasures',
      shown_one: 'card shown',
      shown_other: 'cards shown',
    },
  },
  fr: {
    title: 'Collection',
    open: 'Ouvrir votre collection',
    filters: 'Filtrer et trier',
    kindFilter: 'Afficher',
    rarityFilter: 'Rareté',
    rarityAll: 'Toutes les raretés',
    sortBy: 'Trié par {{mode}}',
    loading: 'On lustre la vitrine…',
    empty: 'La vitrine est vide',
    emptyHint: 'Les caisses de la table apportent charmes, coffres et cartes à gratter.',
    emptyFiltered: 'Rien ne correspond',
    clearFilters: 'Tout afficher',
    error: 'Impossible de charger la collection.',
    retry: 'Réessayer',
    unavailable: 'La vitrine est fermée pour l’instant',
    level: 'Niveau {{level}}',
    levelShort: 'Niv.',
    copies: '×{{count}}',
    equipped: 'Équipé',
    ready: 'Prêt',
    sealed: 'Scellé',
    turnOver: 'Retourner {{name}}',
    turnBack: 'Retourner la carte',
    fromSet: 'De la série {{set}}',
    duplicates: '{{count}} exemplaires possédés',
    fuse: 'Fusionner les doublons',
    fusing: 'Fusion…',
    fuseAuto: 'Chaque doublon fait monter ce charme de niveau dès son arrivée.',
    fuseNeed: '{{have}} doublons sur {{need}} vers le prochain niveau',
    fuseFailed: 'La fusion n’a pas abouti. Rien n’a été dépensé.',
    levelUp: '{{name}} passe au niveau {{level}}',
    levelGain: '+1 niv.',
    inspectHint: 'Touchez une carte pour la retourner',
    kind: { all: 'Tout', charm: 'Charmes', safe: 'Coffres', scratchCard: 'Cartes à gratter' },
    sort: { rarity: 'rareté', level: 'niveau', newest: 'nouveauté', name: 'nom' },
    about: {
      charm: 'Sertissez-le sur une table pour faire pencher la maison en votre faveur.',
      safe: 'S’ouvre à la fin de son minuteur, ou plus tôt avec une clé.',
      scratchCard: 'Grattez pour révéler un lot que le serveur a déjà scellé.',
    },
    count: {
      subtitle_one: '{{count}} trésor',
      subtitle_many: '{{count}} trésors',
      subtitle_other: '{{count}} trésors',
      shown_one: 'carte affichée',
      shown_many: 'cartes affichées',
      shown_other: 'cartes affichées',
    },
  },
  de: {
    title: 'Sammlung',
    open: 'Sammlung öffnen',
    filters: 'Filtern und sortieren',
    kindFilter: 'Zeigen',
    rarityFilter: 'Seltenheit',
    rarityAll: 'Jede Seltenheit',
    sortBy: 'Sortiert nach {{mode}}',
    loading: 'Die Vitrine wird poliert …',
    empty: 'Die Vitrine ist leer',
    emptyHint: 'Kisten vom Tisch bringen Charms, Tresore und Rubbelkarten.',
    emptyFiltered: 'Hier passt nichts',
    clearFilters: 'Alles zeigen',
    error: 'Die Sammlung konnte nicht geladen werden.',
    retry: 'Erneut versuchen',
    unavailable: 'Die Vitrine ist vorerst geschlossen',
    level: 'Stufe {{level}}',
    levelShort: 'St.',
    copies: '×{{count}}',
    equipped: 'Ausgerüstet',
    ready: 'Bereit',
    sealed: 'Versiegelt',
    turnOver: '{{name}} umdrehen',
    turnBack: 'Zurückdrehen',
    fromSet: 'Aus der Serie {{set}}',
    duplicates: '{{count}} Exemplare im Besitz',
    fuse: 'Duplikate verschmelzen',
    fusing: 'Verschmelze …',
    fuseAuto: 'Duplikate heben diesen Charm sofort bei Ankunft eine Stufe an.',
    fuseNeed: '{{have}} von {{need}} Duplikaten zur nächsten Stufe',
    fuseFailed: 'Das Verschmelzen hat nicht geklappt. Nichts wurde verbraucht.',
    levelUp: '{{name}} steigt auf Stufe {{level}}',
    levelGain: '+1 St.',
    inspectHint: 'Tippe auf eine Karte, um sie umzudrehen',
    kind: { all: 'Alles', charm: 'Charms', safe: 'Tresore', scratchCard: 'Rubbelkarten' },
    sort: { rarity: 'Seltenheit', level: 'Stufe', newest: 'Neueste', name: 'Name' },
    about: {
      charm: 'Setze ihn auf einem Tisch ein, damit das Haus zu deinen Gunsten kippt.',
      safe: 'Öffnet sich, wenn der Timer abläuft, oder früher mit einem Schlüssel.',
      scratchCard: 'Rubble, um einen Preis aufzudecken, den der Server schon versiegelt hat.',
    },
    count: {
      subtitle_one: '{{count}} Schatz',
      subtitle_other: '{{count}} Schätze',
      shown_one: 'Karte gezeigt',
      shown_other: 'Karten gezeigt',
    },
  },
};

type FlatKey = keyof InventoryFlatStrings;

export function inventoryKey(
  key:
    | FlatKey
    | `kind.${ItemKind | 'all'}`
    | `sort.${SortMode}`
    | `about.${ItemKind}`
    | `count.${'subtitle' | 'shown'}`,
): string {
  return `${INVENTORY_NAMESPACE}:${key}`;
}

/** Also registers the crate strings, whose item, set and rarity names the cards reuse. */
export function registerInventoryStrings(i18n: I18n): void {
  registerCratesStrings(i18n);
  for (const language of LANGUAGES) {
    i18n.addResourceBundle(language, INVENTORY_NAMESPACE, INVENTORY_STRINGS[language]);
  }
}

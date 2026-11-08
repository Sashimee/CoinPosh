import { LANGUAGES, type I18n, type Language, type ResourceTree } from '../../i18n/index.ts';
import type { PourGrade } from './events.ts';

export const SYSTEMS_NAMESPACE = 'gameSystems';

const EN = {
  pour: {
    perfect: 'Perfect Pour',
    early: 'A touch early',
    late: 'A touch late',
    gauge: 'Pour gauge: let go on the marker',
  } satisfies Record<PourGrade | 'gauge', string>,
  notice: {
    empty: 'Reconnect to drop more coins.',
    nudgeOffline: 'Nudging needs a connection.',
  },
  aim: { label: 'Drop position' },
  surface: {
    label:
      'Coin table. Drag to aim, tap to drop, hold to pour, swipe two fingers to nudge. Keyboard: arrows aim, Space drops or pours, A, D and W nudge.',
  },
};

export const SYSTEMS_STRINGS: Readonly<Record<Language, typeof EN>> = {
  en: EN,
  fr: {
    pour: {
      perfect: 'Service parfait',
      early: 'Un soupçon trop tôt',
      late: 'Un soupçon trop tard',
      gauge: 'Jauge de service : relâchez sur le repère',
    },
    notice: {
      empty: 'Reconnectez-vous pour lâcher d’autres pièces.',
      nudgeOffline: 'Secouer la table nécessite une connexion.',
    },
    aim: { label: 'Point de chute' },
    surface: {
      label:
        'Table à pièces. Glissez pour viser, touchez pour lâcher, maintenez pour verser, balayez à deux doigts pour secouer. Clavier : flèches pour viser, Espace pour lâcher ou verser, A, D et W pour secouer.',
    },
  },
  de: {
    pour: {
      perfect: 'Perfekt eingeschenkt',
      early: 'Einen Hauch zu früh',
      late: 'Einen Hauch zu spät',
      gauge: 'Einschenkanzeige: an der Markierung loslassen',
    },
    notice: {
      empty: 'Verbinden Sie sich erneut, um weitere Münzen fallen zu lassen.',
      nudgeOffline: 'Zum Anstoßen des Tisches brauchen Sie eine Verbindung.',
    },
    aim: { label: 'Abwurfposition' },
    surface: {
      label:
        'Münztisch. Ziehen zum Zielen, tippen zum Abwerfen, halten zum Einschenken, mit zwei Fingern wischen zum Anstoßen. Tastatur: Pfeiltasten zielen, Leertaste wirft ab oder schenkt ein, A, D und W stoßen an.',
    },
  },
};

export type SystemsKey =
  | `pour.${PourGrade}`
  | 'pour.gauge'
  | 'notice.empty'
  | 'notice.nudgeOffline'
  | 'aim.label'
  | 'surface.label';

export function systemsKey(key: SystemsKey): string {
  return `${SYSTEMS_NAMESPACE}:${key}`;
}

export function registerSystemsStrings(i18n: I18n): void {
  for (const language of LANGUAGES) {
    const tree: ResourceTree = SYSTEMS_STRINGS[language];
    i18n.addResourceBundle(language, SYSTEMS_NAMESPACE, tree);
  }
}

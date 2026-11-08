import { LANGUAGES, type I18n, type Language, type ResourceTree } from '../../i18n/index.ts';
import type { UpgradeRejection } from './events.ts';

export const UPGRADES_NAMESPACE = 'gameUpgrades';

type RejectionStrings = Readonly<Record<UpgradeRejection, string>>;

export const UPGRADE_STRINGS: Readonly<Record<Language, { readonly rejected: RejectionStrings }>> =
  {
    en: {
      rejected: {
        unaffordable: 'Not quite enough coins for that one yet.',
        stale: 'The house updated your table. Have another look.',
        unavailable: 'That refinement is not offered here yet.',
        offline: 'Reconnect to buy upgrades.',
        error: 'The purchase did not go through. Please try again.',
      },
    },
    fr: {
      rejected: {
        unaffordable: 'Pas encore assez de pièces pour celle-ci.',
        stale: 'La maison a mis votre table à jour. Jetez un nouveau coup d’œil.',
        unavailable: 'Ce raffinement n’est pas encore proposé ici.',
        offline: 'Reconnectez-vous pour acheter des améliorations.',
        error: 'L’achat n’a pas abouti. Veuillez réessayer.',
      },
    },
    de: {
      rejected: {
        unaffordable: 'Dafür reichen die Münzen noch nicht ganz.',
        stale: 'Das Haus hat Ihren Tisch aktualisiert. Sehen Sie noch einmal nach.',
        unavailable: 'Diese Verfeinerung gibt es hier noch nicht.',
        offline: 'Verbinden Sie sich erneut, um Upgrades zu kaufen.',
        error: 'Der Kauf ist nicht durchgegangen. Bitte versuchen Sie es erneut.',
      },
    },
  };

export function rejectionKey(reason: UpgradeRejection): string {
  return `${UPGRADES_NAMESPACE}:rejected.${reason}`;
}

export function registerUpgradeStrings(i18n: I18n): void {
  for (const language of LANGUAGES) {
    const tree: ResourceTree = UPGRADE_STRINGS[language];
    i18n.addResourceBundle(language, UPGRADES_NAMESPACE, tree);
  }
}

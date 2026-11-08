/**
 * i18next keys the net layer renders. The `apps/web/src/i18n` catalogs belong to T-1.11; these
 * source strings are what that task copies into the EN/FR/DE resources.
 */
export const NET_I18N_KEYS = {
  demoBanner: 'net.demoMode.banner',
  demoBannerDetail: 'net.demoMode.detail',
  offline: 'net.status.offline',
  syncing: 'net.status.syncing',
  turnstileTitle: 'net.turnstile.title',
  turnstileDetail: 'net.turnstile.detail',
  turnstileFailed: 'net.turnstile.failed',
} as const;

export type NetI18nKey = (typeof NET_I18N_KEYS)[keyof typeof NET_I18N_KEYS];

export const NET_I18N_SOURCE: Readonly<
  Record<'en' | 'fr' | 'de', Readonly<Record<NetI18nKey, string>>>
> = {
  en: {
    'net.demoMode.banner': 'Demo Mode',
    'net.demoMode.detail':
      'Unranked play: progress stays on this device and resets when you close the tab.',
    'net.status.offline': 'Offline: your coins will be counted when you reconnect.',
    'net.status.syncing': 'Syncing with the vault…',
    'net.turnstile.title': 'One quick check',
    'net.turnstile.detail': 'Confirm you are human to open your vault.',
    'net.turnstile.failed': 'The check did not go through. Trying again in a moment…',
  },
  fr: {
    'net.demoMode.banner': 'Mode démo',
    'net.demoMode.detail':
      'Partie non classée : la progression reste sur cet appareil et disparaît à la fermeture de l’onglet.',
    'net.status.offline': 'Hors ligne : vos pièces seront comptées à la reconnexion.',
    'net.status.syncing': 'Synchronisation avec le coffre…',
    'net.turnstile.title': 'Une petite vérification',
    'net.turnstile.detail': 'Confirmez que vous êtes humain pour ouvrir votre coffre.',
    'net.turnstile.failed': 'La vérification n’a pas abouti. Nouvel essai dans un instant…',
  },
  de: {
    'net.demoMode.banner': 'Demo-Modus',
    'net.demoMode.detail':
      'Ungewertetes Spiel: Der Fortschritt bleibt auf diesem Gerät und wird beim Schließen des Tabs zurückgesetzt.',
    'net.status.offline': 'Offline: Deine Münzen werden beim nächsten Verbinden gezählt.',
    'net.status.syncing': 'Abgleich mit dem Tresor…',
    'net.turnstile.title': 'Kurze Prüfung',
    'net.turnstile.detail': 'Bestätige, dass du ein Mensch bist, um deinen Tresor zu öffnen.',
    'net.turnstile.failed': 'Die Prüfung hat nicht geklappt. Gleich folgt ein neuer Versuch…',
  },
};

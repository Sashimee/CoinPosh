import type { VenueId } from '@coinposh/shared';
import { LANGUAGES, type I18n, type Language, type ResourceTree } from '../../i18n/index.ts';
import type { AscensionRejection } from './events.ts';

export const ASCENSION_NAMESPACE = 'gameAscension';

interface AscensionStrings extends ResourceTree {
  open: string;
  entryProgress: string;
  entryReady: string;
  entryFinal: string;
  entryUnknown: string;
  title: string;
  subtitle: string;
  progress: string;
  progressUnknown: string;
  estimateLabel: string;
  estimate: string;
  provisional: string;
  resets: string;
  resetsList: string;
  keeps: string;
  keepsList: string;
  next: string;
  finalVenue: string;
  hold: string;
  holding: string;
  sending: string;
  notReadyHint: string;
  close: string;
  familyOffice: string;
  familyOfficeSubtitle: string;
  level: string;
  maxed: string;
  buyLabel: string;
  goldBars: string;
  skip: string;
  announce: string;
  purchased: string;
  rejected: Record<AscensionRejection, string>;
  venue: Record<VenueId, string>;
}

export const ASCENSION_STRINGS: Readonly<Record<Language, AscensionStrings>> = {
  en: {
    open: 'Ascend',
    entryProgress: 'Ascension: {{percent}} of the way to {{venue}}',
    entryReady: 'Ascension ready: {{venue}} awaits',
    entryFinal: 'Ascension: {{percent}} of the way to a fresh start',
    entryUnknown: 'Ascension and the Family Office',
    title: 'Venue Ascension',
    subtitle: 'Leave {{venue}} at its peak. The house pays you in Gold Bars.',
    progress: '{{current}} / {{target}} Bullion',
    progressUnknown: 'The house tallies your Bullion when you ascend.',
    estimateLabel: 'Estimated payout',
    estimate: '≈ {{amount}} Gold Bars',
    provisional: 'An estimate. The house confirms the payout.',
    resets: 'Resets',
    resetsList: 'Coins, Bullion and this venue’s upgrades',
    keeps: 'Keeps',
    keepsList: 'Gold Bars, the Family Office, your album and charms',
    next: 'Next venue: {{venue}}',
    finalVenue: 'The final venue. Ascending here starts it anew.',
    hold: 'Hold to ascend',
    holding: 'Keep holding…',
    sending: 'The house is counting…',
    notReadyHint: '{{venue}} needs {{target}} Bullion.',
    close: 'Close',
    familyOffice: 'Family Office',
    familyOfficeSubtitle: 'Permanent upgrades, kept through every ascension.',
    level: 'Lv {{level}}',
    maxed: 'Max',
    buyLabel: 'Buy level {{level}} of {{line}} for {{price}} Gold Bars',
    goldBars: 'Gold Bars',
    skip: 'Tap to skip',
    announce: '+{{amount}} Gold Bars. Welcome to {{venue}}.',
    purchased: '{{line}} is now level {{level}}.',
    rejected: {
      notReady: 'Not yet. Keep pushing for Bullion.',
      stale: 'Your venue changed. Refreshing.',
      locked: 'That venue is still locked.',
      unaffordable: 'Not enough Gold Bars.',
      offline: 'No connection. Try again; you won’t be charged twice.',
      error: 'The house could not do that. Try again.',
    },
    venue: {
      rivieraYacht: 'Riviera Yacht',
      salonDeParis: 'Salon de Paris',
      tokyoPenthouse: 'Tokyo Penthouse',
      alpineChalet: 'Alpine Chalet',
      orbitalCasino: 'Orbital Casino',
    },
  },
  fr: {
    open: 'Ascension',
    entryProgress: 'Ascension : {{percent}} du chemin vers {{venue}}',
    entryReady: 'Ascension prête : {{venue}} vous attend',
    entryFinal: 'Ascension : {{percent}} du chemin vers un nouveau départ',
    entryUnknown: 'Ascension et Family Office',
    title: 'Ascension de salon',
    subtitle: 'Quittez {{venue}} au sommet. La maison vous paie en lingots d’or.',
    progress: '{{current}} / {{target}} lingots',
    progressUnknown: 'La maison compte vos lingots au moment de l’ascension.',
    estimateLabel: 'Gain estimé',
    estimate: '≈ {{amount}} lingots d’or',
    provisional: 'Une estimation. La maison confirme le gain.',
    resets: 'Remis à zéro',
    resetsList: 'Pièces, lingots et améliorations de ce salon',
    keeps: 'Conservé',
    keepsList: 'Lingots d’or, Family Office, album et breloques',
    next: 'Salon suivant : {{venue}}',
    finalVenue: 'Le dernier salon. Une ascension ici le fait recommencer.',
    hold: 'Maintenir pour l’ascension',
    holding: 'Continuez d’appuyer…',
    sending: 'La maison fait les comptes…',
    notReadyHint: '{{venue}} demande {{target}} lingots.',
    close: 'Fermer',
    familyOffice: 'Family Office',
    familyOfficeSubtitle: 'Améliorations permanentes, conservées à chaque ascension.',
    level: 'Niv. {{level}}',
    maxed: 'Max',
    buyLabel: 'Acheter le niveau {{level}} de {{line}} pour {{price}} lingots d’or',
    goldBars: 'Lingots d’or',
    skip: 'Touchez pour passer',
    announce: '+{{amount}} lingots d’or. Bienvenue au {{venue}}.',
    purchased: '{{line}} passe au niveau {{level}}.',
    rejected: {
      notReady: 'Pas encore. Continuez à gagner des lingots.',
      stale: 'Votre salon a changé. Actualisation.',
      locked: 'Ce salon est encore verrouillé.',
      unaffordable: 'Pas assez de lingots d’or.',
      offline: 'Pas de connexion. Réessayez ; vous ne serez pas débité deux fois.',
      error: 'La maison n’a pas pu le faire. Réessayez.',
    },
    venue: {
      rivieraYacht: 'Yacht de la Riviera',
      salonDeParis: 'Salon de Paris',
      tokyoPenthouse: 'Penthouse de Tokyo',
      alpineChalet: 'Chalet alpin',
      orbitalCasino: 'Casino orbital',
    },
  },
  de: {
    open: 'Aufstieg',
    entryProgress: 'Aufstieg: {{percent}} des Weges zum {{venue}}',
    entryReady: 'Aufstieg bereit: {{venue}} erwartet Sie',
    entryFinal: 'Aufstieg: {{percent}} des Weges zu einem Neubeginn',
    entryUnknown: 'Aufstieg und Family Office',
    title: 'Aufstieg des Salons',
    subtitle: 'Verlassen Sie {{venue}} auf dem Höhepunkt. Das Haus zahlt in Goldbarren.',
    progress: '{{current}} / {{target}} Bullion',
    progressUnknown: 'Das Haus zählt Ihr Bullion beim Aufstieg.',
    estimateLabel: 'Geschätzte Auszahlung',
    estimate: '≈ {{amount}} Goldbarren',
    provisional: 'Eine Schätzung. Das Haus bestätigt die Auszahlung.',
    resets: 'Wird zurückgesetzt',
    resetsList: 'Münzen, Bullion und die Verbesserungen dieses Salons',
    keeps: 'Bleibt',
    keepsList: 'Goldbarren, das Family Office, Ihr Album und Ihre Charms',
    next: 'Nächster Salon: {{venue}}',
    finalVenue: 'Der letzte Salon. Ein Aufstieg hier beginnt ihn neu.',
    hold: 'Halten zum Aufsteigen',
    holding: 'Weiter halten…',
    sending: 'Das Haus zählt…',
    notReadyHint: '{{venue}} braucht {{target}} Bullion.',
    close: 'Schließen',
    familyOffice: 'Family Office',
    familyOfficeSubtitle: 'Dauerhafte Verbesserungen, die jeden Aufstieg überdauern.',
    level: 'St. {{level}}',
    maxed: 'Max',
    buyLabel: 'Stufe {{level}} von {{line}} für {{price}} Goldbarren kaufen',
    goldBars: 'Goldbarren',
    skip: 'Tippen zum Überspringen',
    announce: '+{{amount}} Goldbarren. Willkommen im {{venue}}.',
    purchased: '{{line}} ist jetzt Stufe {{level}}.',
    rejected: {
      notReady: 'Noch nicht. Sammeln Sie weiter Bullion.',
      stale: 'Ihr Salon hat sich geändert. Wird aktualisiert.',
      locked: 'Dieser Salon ist noch gesperrt.',
      unaffordable: 'Nicht genug Goldbarren.',
      offline: 'Keine Verbindung. Bitte erneut versuchen; es wird nicht doppelt abgebucht.',
      error: 'Das Haus konnte das nicht tun. Bitte erneut versuchen.',
    },
    venue: {
      rivieraYacht: 'Riviera-Jacht',
      salonDeParis: 'Salon de Paris',
      tokyoPenthouse: 'Tokio-Penthouse',
      alpineChalet: 'Alpenchalet',
      orbitalCasino: 'Orbitalkasino',
    },
  },
};

type FlatKey = Exclude<keyof AscensionStrings, 'rejected' | 'venue'>;

export function ascensionKey(key: FlatKey): string {
  return `${ASCENSION_NAMESPACE}:${key}`;
}

export function rejectionKey(reason: AscensionRejection): string {
  return `${ASCENSION_NAMESPACE}:rejected.${reason}`;
}

export function venueKey(venueId: VenueId): string {
  return `${ASCENSION_NAMESPACE}:venue.${venueId}`;
}

/** Family Office line names live with the upgrades panel's strings in the default namespace. */
export function lineNameKey(lineId: string): string {
  return `upgrades.line.${lineId}.name`;
}

export function registerAscensionStrings(i18n: I18n): void {
  for (const language of LANGUAGES) {
    i18n.addResourceBundle(language, ASCENSION_NAMESPACE, ASCENSION_STRINGS[language]);
  }
}

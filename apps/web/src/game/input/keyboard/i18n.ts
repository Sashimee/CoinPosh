import { LANGUAGES, type I18n, type Language, type ResourceTree } from '../../../i18n/index.ts';
import { drawerSlotOf, KEY_ACTIONS, type KeyAction, type KeyBindings } from './bindings.ts';

export const KEYBOARD_NAMESPACE = 'gameKeyboard';

const EN = {
  action: {
    pour: 'Drop (hold to pour)',
    aimLeft: 'Aim left',
    aimRight: 'Aim right',
    nudge: 'Nudge forward',
    nudgeLeft: 'Nudge left',
    nudgeRight: 'Nudge right',
    drawer: 'Open drawer {{slot}}',
  },
  key: {
    Space: 'Space',
    Enter: 'Enter',
    ArrowLeft: 'Left arrow',
    ArrowRight: 'Right arrow',
    ArrowUp: 'Up arrow',
    ArrowDown: 'Down arrow',
    Backspace: 'Backspace',
    numpad: 'Numpad {{key}}',
    unbound: 'Not set',
  },
  rebind: {
    prompt: 'Press a key for “{{action}}”, or Escape to cancel',
    reserved: 'Escape, Tab and modifier keys stay with the page; pick another key.',
    reset: 'Restore default keys',
  },
};

type KeyboardStrings = typeof EN;

export const KEYBOARD_STRINGS: Readonly<Record<Language, KeyboardStrings>> = {
  en: EN,
  fr: {
    action: {
      pour: 'Lâcher (maintenir pour verser)',
      aimLeft: 'Viser à gauche',
      aimRight: 'Viser à droite',
      nudge: 'Secouer vers l’avant',
      nudgeLeft: 'Secouer à gauche',
      nudgeRight: 'Secouer à droite',
      drawer: 'Ouvrir le tiroir {{slot}}',
    },
    key: {
      Space: 'Espace',
      Enter: 'Entrée',
      ArrowLeft: 'Flèche gauche',
      ArrowRight: 'Flèche droite',
      ArrowUp: 'Flèche haut',
      ArrowDown: 'Flèche bas',
      Backspace: 'Retour arrière',
      numpad: 'Pavé num. {{key}}',
      unbound: 'Aucune',
    },
    rebind: {
      prompt: 'Appuyez sur une touche pour « {{action}} », ou Échap pour annuler',
      reserved:
        'Échap, Tab et les touches de modification restent à la page ; choisissez une autre touche.',
      reset: 'Rétablir les touches par défaut',
    },
  },
  de: {
    action: {
      pour: 'Abwerfen (halten zum Einschenken)',
      aimLeft: 'Nach links zielen',
      aimRight: 'Nach rechts zielen',
      nudge: 'Nach vorn anstoßen',
      nudgeLeft: 'Nach links anstoßen',
      nudgeRight: 'Nach rechts anstoßen',
      drawer: 'Schublade {{slot}} öffnen',
    },
    key: {
      Space: 'Leertaste',
      Enter: 'Eingabe',
      ArrowLeft: 'Pfeil links',
      ArrowRight: 'Pfeil rechts',
      ArrowUp: 'Pfeil hoch',
      ArrowDown: 'Pfeil runter',
      Backspace: 'Rücktaste',
      numpad: 'Ziffernblock {{key}}',
      unbound: 'Keine',
    },
    rebind: {
      prompt: 'Drücken Sie eine Taste für „{{action}}“ oder Escape zum Abbrechen',
      reserved: 'Escape, Tab und Sondertasten bleiben bei der Seite; wählen Sie eine andere Taste.',
      reset: 'Standardtasten wiederherstellen',
    },
  },
};

export function registerKeyboardStrings(i18n: I18n): void {
  for (const language of LANGUAGES) {
    const tree: ResourceTree = KEYBOARD_STRINGS[language];
    i18n.addResourceBundle(language, KEYBOARD_NAMESPACE, tree);
  }
}

const NAMED_KEYS = new Set(Object.keys(EN.key));

export function actionLabel(i18n: I18n, action: KeyAction): string {
  const slot = drawerSlotOf(action);
  if (slot !== null) return i18n.t(`${KEYBOARD_NAMESPACE}:action.drawer`, { slot });
  return i18n.t(`${KEYBOARD_NAMESPACE}:action.${action}`);
}

/** A `KeyboardEvent.code` as the player reads it on their keycap: `KeyN` is N, `Digit3` is 3. */
export function keyLabel(i18n: I18n, code: string): string {
  if (NAMED_KEYS.has(code)) return i18n.t(`${KEYBOARD_NAMESPACE}:key.${code}`);
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter?.[1]) return letter[1];
  const digit = /^Digit(\d)$/.exec(code);
  if (digit?.[1]) return digit[1];
  const numpad = /^Numpad(.+)$/.exec(code);
  if (numpad?.[1]) return i18n.t(`${KEYBOARD_NAMESPACE}:key.numpad`, { key: numpad[1] });
  return code;
}

export interface BindingRow {
  readonly action: KeyAction;
  readonly label: string;
  /** The bound keys in reading form, or a single "not set" entry. */
  readonly keys: readonly string[];
  readonly codes: readonly string[];
}

/** What a controls sheet lists: one row per action with its keys, in the viewer's language. */
export function describeBindings(i18n: I18n, bindings: KeyBindings): BindingRow[] {
  return KEY_ACTIONS.map((action) => {
    const codes = bindings[action];
    return {
      action,
      label: actionLabel(i18n, action),
      codes,
      keys:
        codes.length === 0
          ? [i18n.t(`${KEYBOARD_NAMESPACE}:key.unbound`)]
          : codes.map((code) => keyLabel(i18n, code)),
    };
  });
}

export function rebindPrompt(i18n: I18n, action: KeyAction): string {
  return i18n.t(`${KEYBOARD_NAMESPACE}:rebind.prompt`, { action: actionLabel(i18n, action) });
}

export function rebindText(i18n: I18n, key: 'reserved' | 'reset'): string {
  return i18n.t(`${KEYBOARD_NAMESPACE}:rebind.${key}`);
}

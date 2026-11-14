export const DRAWER_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
export type DrawerSlot = (typeof DRAWER_SLOTS)[number];

export const KEY_ACTIONS = [
  'pour',
  'aimLeft',
  'aimRight',
  'nudge',
  'nudgeLeft',
  'nudgeRight',
  ...DRAWER_SLOTS.map((slot) => `drawer${slot}` as const),
] as const;
export type KeyAction = (typeof KEY_ACTIONS)[number];

/** Each action lists the `KeyboardEvent.code`s that trigger it, so a layout change keeps the key's place. */
export type KeyBindings = Readonly<Record<KeyAction, readonly string[]>>;

const drawerDefaults = {} as Record<`drawer${DrawerSlot}`, readonly string[]>;
for (const slot of DRAWER_SLOTS)
  drawerDefaults[`drawer${slot}`] = [`Digit${slot}`, `Numpad${slot}`];

export const DEFAULT_BINDINGS: KeyBindings = {
  pour: ['Space', 'Enter'],
  aimLeft: ['ArrowLeft'],
  aimRight: ['ArrowRight'],
  nudge: ['KeyN', 'KeyW'],
  nudgeLeft: ['KeyA'],
  nudgeRight: ['KeyD'],
  ...drawerDefaults,
};

/** Escape closes sheets and Tab moves focus: neither can ever be taken from the page. */
export const RESERVED_CODES: ReadonlySet<string> = new Set([
  'Escape',
  'Tab',
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  'CapsLock',
  'ContextMenu',
  'OSLeft',
  'OSRight',
]);

const CODE_SHAPE = /^[A-Z][A-Za-z0-9]{0,31}$/;

export function isBindableCode(code: string): boolean {
  return CODE_SHAPE.test(code) && !RESERVED_CODES.has(code);
}

export function isKeyAction(value: unknown): value is KeyAction {
  return typeof value === 'string' && (KEY_ACTIONS as readonly string[]).includes(value);
}

export function drawerSlotOf(action: KeyAction): DrawerSlot | null {
  if (!action.startsWith('drawer')) return null;
  return Number(action.slice('drawer'.length)) as DrawerSlot;
}

/** The action a key triggers, or null when nothing is bound to it. */
export function actionFor(bindings: KeyBindings, code: string): KeyAction | null {
  for (const action of KEY_ACTIONS) if (bindings[action].includes(code)) return action;
  return null;
}

/**
 * Binds `code` to `action` alone: the action's old keys are released, and any other action that
 * held `code` gives it up, so one key never does two things.
 */
export function rebind(bindings: KeyBindings, action: KeyAction, code: string): KeyBindings {
  if (!isKeyAction(action)) throw new RangeError(`rebind: unknown action "${String(action)}"`);
  if (!isBindableCode(code)) {
    throw new RangeError(
      `rebind: "${code}" cannot be bound; Escape, Tab and modifier keys stay with the page`,
    );
  }
  const next = {} as Record<KeyAction, readonly string[]>;
  for (const each of KEY_ACTIONS) {
    next[each] = each === action ? [code] : bindings[each].filter((held) => held !== code);
  }
  return next;
}

/**
 * Reads stored bindings leniently: unknown actions and unbindable codes are dropped, a missing
 * action keeps its default keys unless the stored set already gave those keys away.
 */
export function parseBindings(raw: string): KeyBindings | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const stored = new Map<KeyAction, string[]>();
  for (const [action, codes] of Object.entries(data)) {
    if (!isKeyAction(action) || !Array.isArray(codes)) continue;
    stored.set(
      action,
      codes.filter((code): code is string => typeof code === 'string' && isBindableCode(code)),
    );
  }
  if (stored.size === 0) return null;
  const taken = new Set<string>();
  const claim = (codes: readonly string[]): string[] => {
    const free: string[] = [];
    for (const code of codes) {
      if (taken.has(code)) continue;
      taken.add(code);
      free.push(code);
    }
    return free;
  };
  const next = {} as Record<KeyAction, readonly string[]>;
  for (const action of KEY_ACTIONS) {
    const codes = stored.get(action);
    if (codes) next[action] = claim(codes);
  }
  for (const action of KEY_ACTIONS) {
    if (!stored.has(action)) next[action] = claim(DEFAULT_BINDINGS[action]);
  }
  return next;
}

export const BINDINGS_STORAGE_KEY = 'coinposh.keyboard.bindings.v1';

export type BindingsStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface BindingsLogger {
  warn(message: string, error?: unknown): void;
}

/** Storage can be missing or throw (private mode, blocked site data); bindings then live in memory. */
export function browserBindingsStorage(logger: BindingsLogger = console): BindingsStorage | null {
  try {
    return globalThis.localStorage;
  } catch (error) {
    logger.warn('[CoinPosh] localStorage is unavailable, key bindings will not persist', error);
    return null;
  }
}

export function loadBindings(
  storage: BindingsStorage | null,
  logger: BindingsLogger = console,
): KeyBindings {
  if (storage === null) return DEFAULT_BINDINGS;
  let raw: string | null;
  try {
    raw = storage.getItem(BINDINGS_STORAGE_KEY);
  } catch (error) {
    logger.warn('[CoinPosh] Reading the saved key bindings failed, using the defaults', error);
    return DEFAULT_BINDINGS;
  }
  if (raw === null) return DEFAULT_BINDINGS;
  const parsed = parseBindings(raw);
  if (parsed === null) {
    logger.warn('[CoinPosh] The saved key bindings are malformed, using the defaults');
    return DEFAULT_BINDINGS;
  }
  return parsed;
}

/** Defaults are stored as no entry, so a later change to the defaults reaches this viewer. */
export function saveBindings(
  storage: BindingsStorage | null,
  bindings: KeyBindings,
  logger: BindingsLogger = console,
): boolean {
  if (storage === null) return false;
  try {
    if (sameBindings(bindings, DEFAULT_BINDINGS)) storage.removeItem(BINDINGS_STORAGE_KEY);
    else storage.setItem(BINDINGS_STORAGE_KEY, JSON.stringify(bindings));
    return true;
  } catch (error) {
    logger.warn('[CoinPosh] Saving the key bindings failed, they last until reload', error);
    return false;
  }
}

export function sameBindings(a: KeyBindings, b: KeyBindings): boolean {
  return KEY_ACTIONS.every(
    (action) =>
      a[action].length === b[action].length &&
      a[action].every((code, index) => b[action][index] === code),
  );
}

import { describe, expect, it, vi } from 'vitest';
import { BUNDLED_RESOURCES, createI18n, LANGUAGES } from '../../../i18n/index.ts';
import { linearAimMap } from '../aimMap.ts';
import {
  BINDINGS_STORAGE_KEY,
  DEFAULT_BINDINGS,
  KEY_ACTIONS,
  loadBindings,
  parseBindings,
  rebind,
  type BindingsStorage,
  type DrawerSlot,
} from './bindings.ts';
import {
  mountKeyboardMouse,
  type KeyboardMouseHandlers,
  type KeyboardMouseOptions,
  type MouseSurface,
} from './controls.ts';
import type { FocusTarget } from './focus.ts';
import {
  actionLabel,
  describeBindings,
  KEYBOARD_STRINGS,
  keyLabel,
  registerKeyboardStrings,
} from './i18n.ts';

const HOLD_MS = 280;

class FakeElement implements FocusTarget {
  hidden = false;
  constructor(
    readonly tagName: string,
    private readonly matches: readonly string[] = [],
    readonly isContentEditable = false,
  ) {}
  closest(selectors: string): unknown {
    const wanted = selectors.split(',').map((selector) => selector.trim());
    if (this.hidden && wanted.includes('[hidden]')) return this;
    return wanted.some((selector) => this.matches.includes(selector)) ? this : null;
  }
}

class FakeDocument extends EventTarget {
  activeElement: FocusTarget | null = null;
  visibilityState = 'visible';
  readonly modals: FakeElement[] = [];
  querySelectorAll(selectors: string): ArrayLike<FocusTarget> {
    return selectors.includes('aria-modal') ? this.modals : [];
  }
}

class MemoryStorage implements BindingsStorage {
  readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

type Call = readonly [string, ...unknown[]];

class TestEvent extends Event {
  stopped = false;
  override stopPropagation(): void {
    this.stopped = true;
    super.stopPropagation();
  }
}

function fire(target: EventTarget, type: string, props: Record<string, unknown>): TestEvent {
  const event = new TestEvent(type, { cancelable: true });
  for (const [name, value] of Object.entries(props)) {
    Object.defineProperty(event, name, { value });
  }
  target.dispatchEvent(event);
  return event;
}

function setup(overrides: Partial<KeyboardMouseOptions> = {}) {
  const win = new EventTarget();
  const doc = new FakeDocument();
  const storage = new MemoryStorage();
  const capture = vi.fn();
  const focus = vi.fn();
  const surface: MouseSurface = Object.assign(new EventTarget(), {
    getBoundingClientRect: () => ({ left: 100, width: 400 }),
    setPointerCapture: capture,
    focus,
  });
  let clock = 0;
  let aim = 0;
  const calls: Call[] = [];
  const handlers: KeyboardMouseHandlers = {
    aim: (value) => {
      aim = value;
      calls.push(['aim', value]);
    },
    drop: (value) => calls.push(['drop', value]),
    pourStart: (value) => calls.push(['pourStart', value]),
    pourEnd: (value) => calls.push(['pourEnd', value]),
    pourCancel: () => calls.push(['pourCancel']),
    nudge: (direction, strength, source) => calls.push(['nudge', direction, strength, source]),
    openDrawer: (slot: DrawerSlot) => calls.push(['openDrawer', slot]),
  };
  const controls = mountKeyboardMouse(handlers, {
    surface: () => surface,
    aimMap: linearAimMap(1),
    currentAim: () => aim,
    window: win,
    document: doc,
    storage,
    now: () => clock,
    ...overrides,
  });
  const key = (type: 'keydown' | 'keyup', code: string, extra: Record<string, unknown> = {}) =>
    fire(win, type, {
      code,
      repeat: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      ...extra,
    });
  const press = (code: string, extra: Record<string, unknown> = {}) => {
    const down = key('keydown', code, extra);
    key('keyup', code, extra);
    return down;
  };
  const mouse = (type: string, clientX: number, extra: Record<string, unknown> = {}) =>
    fire(win, type, {
      pointerType: 'mouse',
      pointerId: 1,
      button: 0,
      clientX,
      clientY: 300,
      target: surface,
      ...extra,
    });
  const advance = (ms: number) => {
    clock += ms;
    controls.tick();
  };
  const take = () => calls.splice(0);
  return { win, doc, storage, capture, focus, controls, calls, key, press, mouse, advance, take };
}

describe('mountKeyboardMouse: mouse', () => {
  it('aims as the mouse glides over the table, through the aim map', () => {
    const t = setup();
    t.mouse('pointermove', 100);
    t.mouse('pointermove', 300);
    t.mouse('pointermove', 500);
    expect(t.take()).toEqual([
      ['aim', -1],
      ['aim', 0],
      ['aim', 1],
    ]);
  });

  it('a click drops where the button lifts and claims the pointer from the touch layer', () => {
    const t = setup();
    const down = t.mouse('pointerdown', 400);
    expect(down.defaultPrevented).toBe(true);
    expect(down.stopped).toBe(true);
    expect(t.capture).toHaveBeenCalledWith(1);
    expect(t.focus).toHaveBeenCalledWith({ preventScroll: true });
    t.mouse('pointerup', 400);
    expect(t.take()).toEqual([
      ['aim', 0.5],
      ['drop', 0.5],
    ]);
  });

  it('holding the button still pours on the touch beat and ends on release', () => {
    const t = setup();
    t.mouse('pointerdown', 300);
    t.advance(HOLD_MS - 1);
    expect(t.controls.pouring).toBe(false);
    t.advance(1);
    expect(t.controls.pouring).toBe(true);
    t.mouse('pointerup', 300);
    expect(t.take()).toEqual([
      ['aim', 0],
      ['pourStart', 0],
      ['pourEnd', 0],
    ]);
  });

  it('ignores other buttons, other pointer types and pointers off the table', () => {
    const t = setup();
    t.mouse('pointerdown', 300, { button: 2 });
    t.mouse('pointerup', 300, { button: 2 });
    const touch = t.mouse('pointerdown', 300, { pointerType: 'touch' });
    t.mouse('pointermove', 300, { target: new FakeElement('BUTTON', ['button']) });
    expect(touch.defaultPrevented).toBe(false);
    expect(t.take()).toEqual([]);
  });

  it('can leave the mouse to the touch surface', () => {
    const t = setup({ mouse: false });
    t.mouse('pointerdown', 300);
    t.mouse('pointerup', 300);
    expect(t.take()).toEqual([]);
  });
});

describe('mountKeyboardMouse: keys', () => {
  it('a Space tap drops one coin at the reticle', () => {
    const t = setup();
    const down = t.press('Space');
    expect(down.defaultPrevented).toBe(true);
    expect(t.take()).toEqual([['drop', 0]]);
  });

  it('holding Space pours from the hold beat until the key lifts, ignoring auto-repeat', () => {
    const t = setup();
    t.key('keydown', 'Space');
    t.advance(HOLD_MS);
    t.key('keydown', 'Space', { repeat: true });
    t.advance(500);
    expect(t.take()).toEqual([['pourStart', 0]]);
    t.key('keyup', 'Space');
    expect(t.take()).toEqual([['pourEnd', 0]]);
    expect(t.controls.pressed).toBe(false);
  });

  it('the window losing focus cancels a pour and frees the key for the next press', () => {
    const t = setup();
    t.key('keydown', 'Space');
    t.advance(HOLD_MS);
    fire(t.win, 'blur', {});
    expect(t.take()).toEqual([['pourStart', 0], ['pourCancel']]);
    t.key('keyup', 'Space');
    expect(t.take()).toEqual([]);
    t.press('Space');
    expect(t.take()).toEqual([['drop', 0]]);
  });

  it('a hidden tab cancels the pour too', () => {
    const t = setup();
    t.key('keydown', 'Space');
    t.advance(HOLD_MS);
    t.doc.visibilityState = 'hidden';
    fire(t.doc, 'visibilitychange', {});
    expect(t.take()).toEqual([['pourStart', 0], ['pourCancel']]);
  });

  it('N nudges forward, A and D sideways, no faster than the shake cooldown', () => {
    const t = setup();
    t.press('KeyN');
    t.press('KeyN');
    t.advance(350);
    t.key('keydown', 'KeyN', { repeat: true });
    t.press('KeyA');
    t.advance(350);
    t.press('KeyD');
    expect(t.take()).toEqual([
      ['nudge', 'forward', 0.6, 'key'],
      ['nudge', 'left', 0.6, 'key'],
      ['nudge', 'right', 0.6, 'key'],
    ]);
  });

  it('arrows step the aim and stop at the rail ends', () => {
    const t = setup();
    for (let i = 0; i < 12; i += 1) t.key('keydown', 'ArrowRight', { repeat: i > 0 });
    t.key('keydown', 'ArrowLeft');
    const steps = t.take().map((call) => call[1] as number);
    expect(steps[0]).toBeCloseTo(0.1);
    expect(steps[11]).toBe(1);
    expect(steps[12]).toBeCloseTo(0.9);
  });

  it('number keys open drawers 1 to 9, on the main row and the numpad', () => {
    const t = setup();
    t.press('Digit1');
    t.press('Digit9');
    t.press('Numpad3');
    expect(t.take()).toEqual([
      ['openDrawer', 1],
      ['openDrawer', 9],
      ['openDrawer', 3],
    ]);
  });

  it('opening a drawer mid-pour cancels the pour first', () => {
    const t = setup();
    t.key('keydown', 'Space');
    t.advance(HOLD_MS);
    t.key('keydown', 'Digit2');
    t.key('keyup', 'Space');
    expect(t.take()).toEqual([['pourStart', 0], ['pourCancel'], ['openDrawer', 2]]);
  });

  it('leaves unbound keys, shortcuts with modifiers, Escape and Tab to the page', () => {
    const t = setup();
    for (const code of ['KeyQ', 'Escape', 'Tab']) {
      const event = t.press(code);
      expect(event.defaultPrevented).toBe(false);
      expect(event.stopped).toBe(false);
    }
    expect(t.press('Digit1', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(t.press('KeyN', { metaKey: true }).defaultPrevented).toBe(false);
    expect(t.take()).toEqual([]);
  });
});

describe('mountKeyboardMouse: focus safety', () => {
  it('ignores keys while focus is in a field or an editable region', () => {
    const t = setup();
    for (const el of [
      new FakeElement('INPUT'),
      new FakeElement('TEXTAREA'),
      new FakeElement('SELECT'),
      new FakeElement('DIV', [], true),
      new FakeElement('SPAN', ['[contenteditable]:not([contenteditable="false"])']),
    ]) {
      t.doc.activeElement = el;
      const event = t.press('KeyN');
      t.press('Space');
      t.press('Digit1');
      expect(event.defaultPrevented).toBe(false);
    }
    expect(t.take()).toEqual([]);
  });

  it('leaves Space and Enter to a focused button but still nudges from it', () => {
    const t = setup();
    t.doc.activeElement = new FakeElement('BUTTON', ['button']);
    expect(t.press('Space').defaultPrevented).toBe(false);
    expect(t.press('Enter').defaultPrevented).toBe(false);
    t.press('KeyN');
    expect(t.take()).toEqual([['nudge', 'forward', 0.6, 'key']]);
  });

  it('ignores keys while a sheet is open, and wakes when it hides', () => {
    const t = setup();
    const sheet = new FakeElement('SECTION');
    t.doc.modals.push(sheet);
    t.press('Space');
    t.press('KeyN');
    t.press('Digit4');
    expect(t.take()).toEqual([]);
    sheet.hidden = true;
    t.press('Digit4');
    expect(t.take()).toEqual([['openDrawer', 4]]);
  });

  it('a sheet opening mid-pour cancels it, and its release drops nothing', () => {
    const t = setup();
    t.key('keydown', 'Space');
    t.advance(HOLD_MS);
    t.doc.modals.push(new FakeElement('SECTION'));
    t.advance(16);
    t.key('keyup', 'Space');
    expect(t.take()).toEqual([['pourStart', 0], ['pourCancel']]);
  });

  it('a sheet opening during a mouse hold spends the press', () => {
    const t = setup();
    t.mouse('pointerdown', 300);
    t.doc.modals.push(new FakeElement('SECTION'));
    t.advance(HOLD_MS);
    t.mouse('pointerup', 300);
    expect(t.take()).toEqual([['aim', 0]]);
  });

  it('interrupt cancels a running pour from either source', () => {
    const t = setup();
    t.mouse('pointerdown', 300);
    t.advance(HOLD_MS);
    t.controls.interrupt();
    t.mouse('pointerup', 300);
    expect(t.take()).toEqual([['aim', 0], ['pourStart', 0], ['pourCancel']]);
  });
});

describe('mountKeyboardMouse: remapping', () => {
  it('a rebound key fires its action, the old key goes quiet, and it persists', () => {
    const t = setup();
    t.controls.rebind('nudge', 'KeyF');
    t.press('KeyN');
    t.press('KeyF');
    expect(t.take()).toEqual([['nudge', 'forward', 0.6, 'key']]);
    const stored = t.storage.getItem(BINDINGS_STORAGE_KEY);
    expect(stored).not.toBeNull();
    const again = setup({ storage: t.storage });
    again.press('KeyF');
    expect(again.take()).toEqual([['nudge', 'forward', 0.6, 'key']]);
  });

  it('stealing a key from another action unbinds it there', () => {
    const t = setup();
    t.controls.rebind('pour', 'KeyD');
    t.press('KeyD');
    expect(t.take()).toEqual([['drop', 0]]);
    expect(t.controls.bindings.nudgeRight).toEqual([]);
  });

  it('refuses Escape, Tab and modifiers', () => {
    const t = setup();
    for (const code of ['Escape', 'Tab', 'ShiftLeft', 'not-a-code', '']) {
      expect(() => t.controls.rebind('pour', code)).toThrow(RangeError);
    }
  });

  it('captures the next key even inside the settings sheet, and Escape gives up unswallowed', async () => {
    const t = setup();
    t.doc.modals.push(new FakeElement('SECTION'));
    const changed = vi.fn();
    t.controls.onBindingsChanged(changed);
    const captured = t.controls.captureKey('drawer1');
    t.key('keydown', 'ShiftLeft');
    const pressed = t.key('keydown', 'KeyU');
    await expect(captured).resolves.toBe('KeyU');
    expect(pressed.defaultPrevented).toBe(true);
    expect(t.controls.bindings.drawer1).toEqual(['KeyU']);
    expect(changed).toHaveBeenCalledTimes(1);

    const cancelled = t.controls.captureKey('pour');
    const escape = t.key('keydown', 'Escape');
    await expect(cancelled).resolves.toBeNull();
    expect(escape.defaultPrevented).toBe(false);
    expect(escape.stopped).toBe(false);
    expect(t.controls.bindings.pour).toEqual(DEFAULT_BINDINGS.pour);
  });

  it('reset restores the defaults and clears the stored entry', () => {
    const t = setup();
    t.controls.rebind('pour', 'KeyP');
    expect(t.storage.data.has(BINDINGS_STORAGE_KEY)).toBe(true);
    expect(t.controls.resetBindings()).toBe(DEFAULT_BINDINGS);
    expect(t.storage.data.has(BINDINGS_STORAGE_KEY)).toBe(false);
  });

  it('plays on defaults when storage throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broken: BindingsStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    const t = setup({ storage: broken });
    expect(t.controls.bindings).toBe(DEFAULT_BINDINGS);
    t.controls.rebind('nudge', 'KeyF');
    t.press('KeyF');
    expect(t.take()).toEqual([['nudge', 'forward', 0.6, 'key']]);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('keeps bindings in memory when storage is null', () => {
    const t = setup({ storage: null });
    t.controls.rebind('nudge', 'KeyF');
    expect(t.controls.bindings.nudge).toEqual(['KeyF']);
  });
});

describe('mountKeyboardMouse: dispose', () => {
  it('removes every listener and cancels a running pour', async () => {
    const t = setup();
    t.key('keydown', 'Space');
    t.advance(HOLD_MS);
    const pending = t.controls.captureKey('pour');
    t.controls.dispose();
    await expect(pending).resolves.toBeNull();
    expect(t.take()).toEqual([['pourStart', 0], ['pourCancel']]);
    t.press('Space');
    t.press('KeyN');
    t.press('Digit1');
    t.mouse('pointermove', 200);
    t.mouse('pointerdown', 200);
    t.mouse('pointerup', 200);
    t.advance(HOLD_MS);
    expect(t.take()).toEqual([]);
  });
});

describe('bindings', () => {
  it('defaults bind every action and no key twice', () => {
    const codes = KEY_ACTIONS.flatMap((action) => DEFAULT_BINDINGS[action]);
    expect(new Set(codes).size).toBe(codes.length);
    for (const action of KEY_ACTIONS) expect(DEFAULT_BINDINGS[action].length).toBeGreaterThan(0);
  });

  it('rebind leaves the input untouched', () => {
    const next = rebind(DEFAULT_BINDINGS, 'nudge', 'Space');
    expect(next.nudge).toEqual(['Space']);
    expect(next.pour).toEqual(['Enter']);
    expect(DEFAULT_BINDINGS.pour).toEqual(['Space', 'Enter']);
  });

  it('parses stored bindings leniently and keeps keys unique', () => {
    const parsed = parseBindings(
      JSON.stringify({ nudge: ['Space', 'Space', 'Escape', 7], bogus: ['KeyZ'] }),
    );
    expect(parsed?.nudge).toEqual(['Space']);
    expect(parsed?.pour).toEqual(['Enter']);
    expect(parsed?.drawer5).toEqual(DEFAULT_BINDINGS.drawer5);
  });

  it('rejects stored data that is not a bindings object', () => {
    for (const raw of ['', 'nope', '[]', 'null', '42', '{}', '{"bogus":["KeyZ"]}']) {
      expect(parseBindings(raw)).toBeNull();
    }
    const warn = vi.fn();
    const storage = new MemoryStorage();
    storage.setItem(BINDINGS_STORAGE_KEY, '{oops');
    expect(loadBindings(storage, { warn })).toBe(DEFAULT_BINDINGS);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('keyboard strings', () => {
  const leafKeys = (tree: object, prefix = ''): string[] =>
    Object.entries(tree).flatMap(([name, value]) =>
      typeof value === 'string'
        ? [`${prefix}${name}`]
        : leafKeys(value as object, `${prefix}${name}.`),
    );

  it('every language carries every string', () => {
    const english = leafKeys(KEYBOARD_STRINGS.en).sort();
    for (const language of LANGUAGES) {
      expect(leafKeys(KEYBOARD_STRINGS[language]).sort()).toEqual(english);
      for (const leaf of leafKeys(KEYBOARD_STRINGS[language])) expect(leaf).toBeTruthy();
    }
  });

  it('labels actions and keys in the viewer’s language', () => {
    const i18n = createI18n({ language: 'fr', resources: BUNDLED_RESOURCES });
    registerKeyboardStrings(i18n);
    expect(actionLabel(i18n, 'drawer3')).toBe('Ouvrir le tiroir 3');
    expect(keyLabel(i18n, 'Space')).toBe('Espace');
    expect(keyLabel(i18n, 'KeyN')).toBe('N');
    expect(keyLabel(i18n, 'Digit7')).toBe('7');
    expect(keyLabel(i18n, 'Numpad7')).toBe('Pavé num. 7');
    i18n.changeLanguage('de');
    const rows = describeBindings(i18n, rebind(DEFAULT_BINDINGS, 'pour', 'KeyN'));
    expect(rows.map((row) => row.action)).toEqual([...KEY_ACTIONS]);
    expect(rows.find((row) => row.action === 'pour')?.keys).toEqual(['N']);
    expect(rows.find((row) => row.action === 'nudge')).toMatchObject({
      label: 'Nach vorn anstoßen',
      keys: ['W'],
    });
    const unbound = describeBindings(i18n, rebind(DEFAULT_BINDINGS, 'pour', 'KeyA'));
    expect(unbound.find((row) => row.action === 'nudgeLeft')?.keys).toEqual(['Keine']);
  });
});

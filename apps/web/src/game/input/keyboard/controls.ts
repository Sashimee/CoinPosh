import type { NudgeDirection } from '@coinposh/shared';
import type { AimMap } from '../aimMap.ts';
import {
  DEFAULT_GESTURES,
  GestureRecognizer,
  type GestureAction,
  type GestureConfig,
} from '../gestures.ts';
import { DEFAULT_SHAKE } from '../shake.ts';
import type { InputHandlers } from '../surface.ts';
import {
  actionFor,
  browserBindingsStorage,
  DEFAULT_BINDINGS,
  drawerSlotOf,
  isBindableCode,
  loadBindings,
  rebind as rebindAction,
  RESERVED_CODES,
  saveBindings,
  type BindingsStorage,
  type DrawerSlot,
  type KeyAction,
  type KeyBindings,
} from './bindings.ts';
import { isActivatable, isTyping, modalOpen, type FocusDocument } from './focus.ts';

/** The touch surface's intents, plus the dock's drawers that number keys open. */
export interface KeyboardMouseHandlers extends InputHandlers {
  openDrawer(slot: DrawerSlot): void;
}

type Listener = (event: Event) => void;

export interface EventHost {
  addEventListener(type: string, listener: Listener, options?: AddEventListenerOptions): void;
  removeEventListener(type: string, listener: Listener, options?: EventListenerOptions): void;
}

/** The table canvas, as the mouse layer reads it. */
export interface MouseSurface extends EventTarget {
  getBoundingClientRect(): { readonly left: number; readonly width: number };
  setPointerCapture(pointerId: number): void;
  focus(options?: FocusOptions): void;
}

export interface KeyboardMouseOptions {
  /** The surface the mouse plays on: read per event, since the stage swaps canvases. */
  readonly surface: () => MouseSurface;
  readonly aimMap: AimMap;
  /** Where the reticle sits now, so keys and drops act from there. */
  readonly currentAim: () => number;
  readonly window?: EventHost;
  readonly document?: FocusDocument & EventHost & { readonly visibilityState?: string };
  /** `null` keeps bindings in memory only; omitted, the browser's localStorage when it works. */
  readonly storage?: BindingsStorage | null;
  readonly now?: () => number;
  /** Hold and slop timings shared with touch, so a held key or button pours on the same beat. */
  readonly gestures?: GestureConfig;
  readonly keyAimStep?: number;
  readonly nudgeStrength?: number;
  /** A held or hammered key nudges no faster than a shake does. */
  readonly nudgeCooldownMs?: number;
  /** False leaves the mouse to the touch surface and binds keys only. */
  readonly mouse?: boolean;
}

export interface KeyboardMouseControls {
  readonly bindings: KeyBindings;
  /** A key or mouse button is down on a press that can still drop or pour. */
  readonly pressed: boolean;
  readonly pouring: boolean;
  /** Call once per frame: a key or button held long enough becomes a pour. */
  tick(): void;
  /** Cancels a running pour and spends the press in progress: only a fresh press acts again. */
  interrupt(): void;
  rebind(action: KeyAction, code: string): KeyBindings;
  resetBindings(): KeyBindings;
  onBindingsChanged(listener: (bindings: KeyBindings) => void): () => void;
  /**
   * Binds `action` to the next key pressed, even inside the settings sheet. Escape gives up and
   * still reaches the page; Tab and modifiers are passed over. Resolves to the code, or null.
   */
  captureKey(action: KeyAction): Promise<string | null>;
  dispose(): void;
}

const NUDGES: Partial<Record<KeyAction, NudgeDirection>> = {
  nudge: 'forward',
  nudgeLeft: 'left',
  nudgeRight: 'right',
};

/** Space and Enter belong to a focused button or link; the table never takes them from it. */
const ACTIVATION_CODES = new Set(['Space', 'Enter', 'NumpadEnter']);

interface KeyPress {
  readonly code: string;
  readonly since: number;
  pouring: boolean;
  spent: boolean;
}

interface Capture {
  readonly action: KeyAction;
  readonly resolve: (code: string | null) => void;
}

/**
 * Desktop play: the mouse aims as it glides over the table, a click drops and a held button
 * pours; Space taps or holds the same way, N and A/D nudge, arrows aim and number keys open the
 * dock's drawers. It emits the touch surface's intents only, so nothing it sends is a value.
 * Keys it acts on stop at the window and never reach the canvas's own key handling; keys typed
 * into fields, keys under an open sheet, Escape and Tab are never touched.
 */
export function mountKeyboardMouse(
  handlers: KeyboardMouseHandlers,
  options: KeyboardMouseOptions,
): KeyboardMouseControls {
  const win = options.window ?? window;
  const doc = options.document ?? document;
  const storage = options.storage === undefined ? browserBindingsStorage() : options.storage;
  const now = options.now ?? (() => performance.now());
  const gestureConfig = options.gestures ?? DEFAULT_GESTURES;
  const gestures = new GestureRecognizer(gestureConfig);
  const keyStep = options.keyAimStep ?? 0.1;
  const nudgeStrength = options.nudgeStrength ?? 0.6;
  const nudgeCooldownMs = options.nudgeCooldownMs ?? DEFAULT_SHAKE.cooldownMs;
  if (!(keyStep > 0 && keyStep <= 2)) {
    throw new RangeError(`mountKeyboardMouse: keyAimStep must be in (0, 2], got ${keyStep}`);
  }
  if (!(nudgeStrength > 0 && nudgeStrength <= 1) || !(nudgeCooldownMs >= 0)) {
    throw new RangeError(
      'mountKeyboardMouse: nudgeStrength must be in (0, 1] and nudgeCooldownMs ≥ 0',
    );
  }

  let bindings = loadBindings(storage);
  const bindingListeners = new Set<(bindings: KeyBindings) => void>();
  let key: KeyPress | null = null;
  let mousePointer: number | null = null;
  let lastNudgeAt = Number.NEGATIVE_INFINITY;
  let capture: Capture | null = null;
  let disposed = false;

  const clampAim = (aim: number): number => Math.min(1, Math.max(-1, aim));
  const rect = () => options.surface().getBoundingClientRect();
  const aimAt = (px: number): number => options.aimMap.toAim(px, rect().width);
  const localX = (clientX: number): number => clientX - rect().left;

  const run = (actions: readonly GestureAction[]): void => {
    for (const action of actions) {
      switch (action.kind) {
        case 'aim':
          handlers.aim(aimAt(action.x));
          break;
        case 'drop':
          handlers.drop(aimAt(action.x));
          break;
        case 'pourStart':
          handlers.pourStart(aimAt(action.x));
          break;
        case 'pourEnd':
          handlers.pourEnd(aimAt(action.x));
          break;
        case 'pourCancel':
          handlers.pourCancel();
          break;
        case 'nudge':
          handlers.nudge(action.direction, action.strength, 'swipe');
          break;
      }
    }
  };

  const setBindings = (next: KeyBindings): KeyBindings => {
    bindings = next;
    saveBindings(storage, next);
    for (const listener of [...bindingListeners]) listener(next);
    return next;
  };

  const spendKey = (): void => {
    if (!key || key.spent) return;
    if (key.pouring) handlers.pourCancel();
    key.pouring = false;
    key.spent = true;
  };

  const interrupt = (): void => {
    spendKey();
    run(gestures.interrupt());
  };

  /** Focus left the page: no keyup or pointerup will come, so nothing may stay held. */
  const releaseAll = (): void => {
    spendKey();
    key = null;
    if (mousePointer !== null) run(gestures.cancel(mousePointer));
    mousePointer = null;
  };

  const blocked = (code: string): boolean => {
    const active = doc.activeElement;
    if (isTyping(active) || modalOpen(doc)) return true;
    return ACTIVATION_CODES.has(code) && isActivatable(active);
  };

  const act = (action: KeyAction, event: KeyboardEvent): void => {
    if (action === 'pour') {
      if (event.repeat || key !== null || mousePointer !== null) return;
      key = { code: event.code, since: now(), pouring: false, spent: false };
      return;
    }
    if (action === 'aimLeft' || action === 'aimRight') {
      handlers.aim(clampAim(options.currentAim() + (action === 'aimLeft' ? -keyStep : keyStep)));
      return;
    }
    if (event.repeat) return;
    const direction = NUDGES[action];
    if (direction) {
      const at = now();
      if (at - lastNudgeAt < nudgeCooldownMs) return;
      lastNudgeAt = at;
      handlers.nudge(direction, nudgeStrength, 'key');
      return;
    }
    const slot = drawerSlotOf(action);
    if (slot !== null) {
      interrupt();
      handlers.openDrawer(slot);
    }
  };

  const onCapture = (event: KeyboardEvent, pending: Capture): void => {
    if (event.repeat) return;
    if (event.code === 'Escape') {
      capture = null;
      pending.resolve(null);
      return;
    }
    if (!isBindableCode(event.code)) return;
    event.preventDefault();
    event.stopPropagation();
    capture = null;
    setBindings(rebindAction(bindings, pending.action, event.code));
    pending.resolve(event.code);
  };

  const onKeyDown = (raw: Event): void => {
    const event = raw as KeyboardEvent;
    if (capture) {
      onCapture(event, capture);
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (RESERVED_CODES.has(event.code)) return;
    const action = actionFor(bindings, event.code);
    if (action === null || blocked(event.code)) return;
    event.preventDefault();
    event.stopPropagation();
    act(action, event);
  };

  const onKeyUp = (raw: Event): void => {
    const event = raw as KeyboardEvent;
    const press = key;
    if (press?.code !== event.code) return;
    event.preventDefault();
    event.stopPropagation();
    key = null;
    if (press.spent) return;
    const aim = options.currentAim();
    if (modalOpen(doc)) {
      if (press.pouring) handlers.pourCancel();
    } else if (press.pouring) handlers.pourEnd(aim);
    else handlers.drop(aim);
  };

  const onSurface = (event: PointerEvent): boolean =>
    event.pointerType === 'mouse' && event.target === options.surface();

  const take = (event: PointerEvent): void => {
    event.preventDefault();
    event.stopPropagation();
  };

  const onPointerDown = (raw: Event): void => {
    const event = raw as PointerEvent;
    if (!onSurface(event)) return;
    take(event);
    if (event.button !== 0 || mousePointer !== null || key !== null) return;
    const surface = options.surface();
    surface.setPointerCapture(event.pointerId);
    surface.focus({ preventScroll: true });
    mousePointer = event.pointerId;
    run(gestures.down(event.pointerId, localX(event.clientX), event.clientY, now()));
  };

  const onPointerMove = (raw: Event): void => {
    const event = raw as PointerEvent;
    if (mousePointer !== null && event.pointerId === mousePointer) {
      take(event);
      run(gestures.move(event.pointerId, localX(event.clientX), event.clientY, now()));
      return;
    }
    if (!onSurface(event)) return;
    take(event);
    handlers.aim(aimAt(localX(event.clientX)));
  };

  const onPointerUp = (raw: Event): void => {
    const event = raw as PointerEvent;
    if (mousePointer === null || event.pointerId !== mousePointer) {
      if (onSurface(event)) take(event);
      return;
    }
    take(event);
    mousePointer = null;
    run(gestures.up(event.pointerId, localX(event.clientX), event.clientY, now()));
  };

  const onPointerCancel = (raw: Event): void => {
    const event = raw as PointerEvent;
    if (mousePointer === null || event.pointerId !== mousePointer) return;
    take(event);
    mousePointer = null;
    run(gestures.cancel(event.pointerId));
  };

  const onVisibility = (): void => {
    if (doc.visibilityState === 'hidden') releaseAll();
  };

  const disposers: (() => void)[] = [];
  const on = (host: EventHost, type: string, listener: Listener): void => {
    const opts = { capture: true };
    host.addEventListener(type, listener, opts);
    disposers.push(() => {
      host.removeEventListener(type, listener, opts);
    });
  };
  on(win, 'keydown', onKeyDown);
  on(win, 'keyup', onKeyUp);
  on(win, 'blur', releaseAll);
  on(doc, 'visibilitychange', onVisibility);
  if (options.mouse !== false) {
    on(win, 'pointerdown', onPointerDown);
    on(win, 'pointermove', onPointerMove);
    on(win, 'pointerup', onPointerUp);
    on(win, 'pointercancel', onPointerCancel);
  }

  return {
    get bindings() {
      return bindings;
    },
    get pressed() {
      return (key !== null && !key.spent) || gestures.live;
    },
    get pouring() {
      return (key?.pouring ?? false) || gestures.pouring;
    },
    tick() {
      if (disposed) return;
      if ((key !== null && !key.spent) || gestures.live) {
        if (modalOpen(doc)) {
          interrupt();
          return;
        }
      }
      run(gestures.tick(now()));
      if (key === null || key.spent || key.pouring) return;
      if (now() - key.since < gestureConfig.holdMs) return;
      key.pouring = true;
      handlers.pourStart(options.currentAim());
    },
    interrupt() {
      if (!disposed) interrupt();
    },
    rebind(action, code) {
      return setBindings(rebindAction(bindings, action, code));
    },
    resetBindings() {
      return setBindings(DEFAULT_BINDINGS);
    },
    onBindingsChanged(listener) {
      bindingListeners.add(listener);
      return () => {
        bindingListeners.delete(listener);
      };
    },
    captureKey(action) {
      if (disposed) return Promise.resolve(null);
      capture?.resolve(null);
      return new Promise<string | null>((resolve) => {
        capture = { action, resolve };
      });
    },
    dispose() {
      if (disposed) return;
      releaseAll();
      disposed = true;
      for (const dispose of disposers.splice(0)) dispose();
      bindingListeners.clear();
      capture?.resolve(null);
      capture = null;
    },
  };
}

import type { NudgeDirection } from '@coinposh/shared';
import { listen } from '../../ui/dom.ts';
import type { AimMap } from './aimMap.ts';
import { GestureRecognizer, type GestureAction, type GestureConfig } from './gestures.ts';
import { ShakeDetector, type ShakeConfig } from './shake.ts';

export type InputSource = 'swipe' | 'motion' | 'key';

export interface InputHandlers {
  aim(aim: number): void;
  drop(aim: number): void;
  pourStart(aim: number): void;
  pourEnd(aim: number): void;
  pourCancel(): void;
  nudge(direction: NudgeDirection, strength: number, source: InputSource): void;
}

export interface InputSurfaceOptions {
  readonly aimMap: AimMap;
  /** Where the reticle sits now, so the keyboard nudges it from there. */
  readonly currentAim: () => number;
  readonly now?: () => number;
  readonly gestures?: GestureConfig;
  readonly shake?: ShakeConfig;
  /** How far one arrow key press moves the aim. */
  readonly keyAimStep?: number;
}

export interface InputSurface {
  /** A finger or the drop key is down on a touch that can still drop, pour or nudge. */
  readonly pressed: boolean;
  /** Call once per frame so a held finger can become a pour. */
  tick(): void;
  /** Cancels a running pour and spends the touch in progress: only a fresh press acts again. */
  interrupt(): void;
  dispose(): void;
}

const KEYBOARD_POINTER = -1;
const NUDGE_KEYS: Readonly<Record<string, NudgeDirection>> = {
  KeyA: 'left',
  KeyD: 'right',
  KeyW: 'forward',
};

interface MotionPermissionApi {
  requestPermission?: () => Promise<PermissionState | 'granted' | 'denied'>;
}

/**
 * Binds the canvas: pointers aim, drop, pour and two-finger nudge; the keyboard does the same
 * for players without touch (arrows aim, Space taps or holds, A/D/W nudge); DeviceMotion jolts
 * nudge on phones.
 */
export function bindInputSurface(
  canvas: HTMLCanvasElement,
  handlers: InputHandlers,
  options: InputSurfaceOptions,
): InputSurface {
  const now = options.now ?? (() => performance.now());
  const gestures = new GestureRecognizer(options.gestures);
  const shake = new ShakeDetector(options.shake);
  const keyStep = options.keyAimStep ?? 0.1;
  const disposers: (() => void)[] = [];
  const width = (): number => canvas.getBoundingClientRect().width;
  const localX = (clientX: number): number => clientX - canvas.getBoundingClientRect().left;
  const toAim = (px: number): number => options.aimMap.toAim(px, width());

  const run = (actions: readonly GestureAction[]): void => {
    for (const action of actions) {
      switch (action.kind) {
        case 'aim':
          handlers.aim(toAim(action.x));
          break;
        case 'drop':
          handlers.drop(toAim(action.x));
          break;
        case 'pourStart':
          handlers.pourStart(toAim(action.x));
          break;
        case 'pourEnd':
          handlers.pourEnd(toAim(action.x));
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

  const previousTouchAction = canvas.style.touchAction;
  canvas.style.touchAction = 'none';
  if (!canvas.hasAttribute('tabindex')) canvas.tabIndex = 0;

  disposers.push(
    listen(canvas, 'pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      requestMotionOnce();
      run(gestures.down(event.pointerId, localX(event.clientX), event.clientY, now()));
    }),
    listen(canvas, 'pointermove', (event) => {
      run(gestures.move(event.pointerId, localX(event.clientX), event.clientY, now()));
    }),
    listen(canvas, 'pointerup', (event) => {
      run(gestures.up(event.pointerId, localX(event.clientX), event.clientY, now()));
    }),
    listen(canvas, 'pointercancel', (event) => {
      run(gestures.cancel(event.pointerId));
    }),
    listen(canvas, 'keydown', (event) => {
      const nudge = NUDGE_KEYS[event.code];
      if (nudge && !event.repeat) {
        handlers.nudge(nudge, 0.6, 'key');
        return;
      }
      const px = options.aimMap.toPx(options.currentAim(), width());
      if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
        event.preventDefault();
        const step = event.code === 'ArrowLeft' ? -keyStep : keyStep;
        const aim = Math.min(1, Math.max(-1, options.currentAim() + step));
        if (gestures.active)
          run(gestures.move(KEYBOARD_POINTER, options.aimMap.toPx(aim, width()), 0, now()));
        else handlers.aim(aim);
        return;
      }
      if (event.code === 'Space' || event.code === 'Enter') {
        event.preventDefault();
        if (!event.repeat) run(gestures.down(KEYBOARD_POINTER, px, 0, now()));
      }
    }),
    listen(canvas, 'keyup', (event) => {
      if (event.code !== 'Space' && event.code !== 'Enter') return;
      event.preventDefault();
      const px = options.aimMap.toPx(options.currentAim(), width());
      run(gestures.up(KEYBOARD_POINTER, px, 0, now()));
    }),
    listen(canvas, 'blur', () => {
      run(gestures.cancel(KEYBOARD_POINTER));
    }),
  );

  let motionBound = false;
  const bindMotion = (): void => {
    if (motionBound || typeof window === 'undefined') return;
    motionBound = true;
    const onMotion = (event: DeviceMotionEvent): void => {
      const x = event.acceleration?.x ?? null;
      const z = event.acceleration?.z ?? null;
      if (x === null || z === null) return;
      const nudge = shake.sample(x, z, now());
      if (nudge) handlers.nudge(nudge.direction, nudge.strength, 'motion');
    };
    window.addEventListener('devicemotion', onMotion);
    disposers.push(() => {
      window.removeEventListener('devicemotion', onMotion);
    });
  };

  let motionAsked = false;
  // iOS only grants motion events from inside a user gesture, so the first touch asks.
  function requestMotionOnce(): void {
    if (motionAsked || typeof DeviceMotionEvent === 'undefined') return;
    motionAsked = true;
    const api = DeviceMotionEvent as unknown as MotionPermissionApi;
    if (typeof api.requestPermission !== 'function') {
      bindMotion();
      return;
    }
    void api.requestPermission().then(
      (state) => {
        if (state === 'granted') bindMotion();
        else console.info('[CoinPosh] motion access was declined; nudge with a two-finger swipe.');
      },
      (error: unknown) => {
        console.warn(
          '[CoinPosh] motion access could not be requested; nudge with a two-finger swipe.',
          error,
        );
      },
    );
  }

  return {
    get pressed() {
      return gestures.live;
    },
    tick() {
      run(gestures.tick(now()));
    },
    interrupt() {
      run(gestures.interrupt());
    },
    dispose() {
      for (const dispose of disposers.splice(0)) dispose();
      canvas.style.touchAction = previousTouchAction;
    },
  };
}

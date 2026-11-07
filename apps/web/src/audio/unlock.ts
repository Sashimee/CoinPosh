/**
 * Browsers only let audio start inside a user gesture. `touchend` is the one iOS Safari
 * accepts; `pointerdown`/`keydown` cover desktop and Android a few milliseconds earlier.
 */
export const UNLOCK_EVENTS = ['pointerdown', 'touchend', 'mousedown', 'keydown', 'click'] as const;

export interface UnlockableContext {
  readonly state: AudioContextState | 'interrupted';
  readonly sampleRate: number;
  readonly destination: AudioNode;
  resume(): Promise<void>;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer;
  createBufferSource(): AudioBufferSourceNode;
}

export interface UnlockHandle {
  readonly unlocked: Promise<void>;
  disarm(): void;
}

/**
 * Listens in the capture phase so no game handler that stops propagation can swallow the first
 * gesture. Inside the gesture it resumes the context and plays one silent sample, which is what
 * actually releases audio on older iOS WebKit.
 */
export function armUnlock(ctx: UnlockableContext, target: EventTarget): UnlockHandle {
  let resolveUnlocked: () => void = () => undefined;
  const unlocked = new Promise<void>((resolve) => {
    resolveUnlocked = resolve;
  });
  const listeners = new AbortController();
  const disarm = () => {
    listeners.abort();
  };

  const finish = () => {
    if (ctx.state !== 'running') return;
    disarm();
    resolveUnlocked();
  };

  function onGesture(): void {
    const silent = ctx.createBufferSource();
    silent.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    silent.connect(ctx.destination);
    silent.start(0);
    if (ctx.state === 'running') {
      finish();
      return;
    }
    ctx.resume().then(finish, (error: unknown) => {
      console.warn('Audio unlock: resume() was refused; waiting for the next gesture.', error);
    });
  }

  if (ctx.state === 'running') {
    resolveUnlocked();
  } else {
    for (const type of UNLOCK_EVENTS) {
      target.addEventListener(type, onGesture, {
        capture: true,
        passive: true,
        signal: listeners.signal,
      });
    }
  }

  return { unlocked, disarm };
}

export interface LifecycleContext extends UnlockableContext, EventTarget {
  suspend(): Promise<void>;
}

export interface VisibilitySource extends EventTarget {
  readonly visibilityState: DocumentVisibilityState;
}

export interface AudioLifecycle {
  /** Resolves on the first successful unlock, whichever gesture handle delivered it. */
  readonly whenUnlocked: Promise<void>;
  dispose(): void;
}

/**
 * iOS Safari and Capacitor webviews can drop a context to 'suspended' or 'interrupted' at any
 * time, before or after the first tap. Each drop arms a fresh gesture handle, and every handle
 * feeds the same `whenUnlocked`, so nothing waiting on the first unlock is stranded by a re-arm.
 */
export function manageAudioLifecycle(
  ctx: LifecycleContext,
  gestureTarget: EventTarget,
  visibility: VisibilitySource,
): AudioLifecycle {
  let resolveUnlocked: () => void = () => undefined;
  const whenUnlocked = new Promise<void>((resolve) => {
    resolveUnlocked = resolve;
  });
  let suspendedForVisibility = false;
  let disposed = false;
  const running = () => ctx.state === 'running';

  const arm = (): UnlockHandle => {
    const handle = armUnlock(ctx, gestureTarget);
    void handle.unlocked.then(resolveUnlocked);
    return handle;
  };
  let unlock = arm();

  const rearmIfLocked = () => {
    if (disposed || running() || suspendedForVisibility) return;
    unlock.disarm();
    if (ctx.state !== 'closed') unlock = arm();
  };

  const onVisibility = () => {
    if (visibility.visibilityState === 'hidden') {
      if (!running()) return;
      suspendedForVisibility = true;
      ctx.suspend().catch((error: unknown) => {
        console.warn('Audio: suspend() on page hide failed; audio keeps running.', error);
      });
      return;
    }
    if (!suspendedForVisibility) return;
    suspendedForVisibility = false;
    ctx.resume().then(rearmIfLocked, rearmIfLocked);
  };

  ctx.addEventListener('statechange', rearmIfLocked);
  visibility.addEventListener('visibilitychange', onVisibility);

  return {
    whenUnlocked,
    dispose() {
      disposed = true;
      unlock.disarm();
      ctx.removeEventListener('statechange', rearmIfLocked);
      visibility.removeEventListener('visibilitychange', onVisibility);
    },
  };
}

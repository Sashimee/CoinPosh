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
 *
 * Tab switches are reconciled against the page's current visibility instead of being replayed
 * event by event: suspend() and resume() settle asynchronously, so a hide/show pair inside one
 * task could otherwise leave the context suspended on a visible page. A resume that is refused
 * or never settles is retried on focus and pageshow, and a gesture handle stays armed meanwhile,
 * so audio is back once the tab returns, plus at most one tap.
 *
 * `page` is `window` in the app: the source of `focus`, `pageshow` and `pagehide`.
 */
export function manageAudioLifecycle(
  ctx: LifecycleContext,
  gestureTarget: EventTarget,
  visibility: VisibilitySource,
  page: EventTarget,
): AudioLifecycle {
  let resolveUnlocked: () => void = () => undefined;
  const whenUnlocked = new Promise<void>((resolve) => {
    resolveUnlocked = resolve;
  });
  let everUnlocked = false;
  let pageHidden = false;
  let disposed = false;
  const running = () => ctx.state === 'running';
  const hidden = () => pageHidden || visibility.visibilityState === 'hidden';

  const markUnlocked = () => {
    everUnlocked = true;
    resolveUnlocked();
  };

  const arm = (): UnlockHandle => {
    const handle = armUnlock(ctx, gestureTarget);
    void handle.unlocked.then(() => {
      if (!disposed) markUnlocked();
    });
    return handle;
  };
  let unlock = arm();

  const armGesture = () => {
    if (disposed || running()) return;
    unlock.disarm();
    if (ctx.state !== 'closed') unlock = arm();
  };

  let resumeAttempts = 0;
  let resumePending = false;
  const resume = () => {
    const attempt = ++resumeAttempts;
    resumePending = true;
    const settled = () => {
      if (attempt === resumeAttempts) resumePending = false;
    };
    ctx.resume().then(
      () => {
        settled();
        if (disposed) return;
        if (hidden()) reconcile(false);
        else armGesture();
      },
      (error: unknown) => {
        settled();
        if (disposed) return;
        console.warn(
          'Audio: resume() was refused; retrying on the next tap, focus or pageshow.',
          error,
        );
        armGesture();
      },
    );
  };

  const suspend = () => {
    ctx.suspend().then(
      () => {
        if (!disposed && !hidden()) reconcile(false);
      },
      (error: unknown) => {
        console.warn('Audio: suspend() on page hide failed; audio keeps running.', error);
      },
    );
  };

  /**
   * A context that never ran is left to the gesture handle: only a gesture may start it. Page
   * events retry a resume still pending, since iOS can leave one unsettled forever; a settling
   * suspend() does not, so it never doubles up on the resume that show already sent.
   */
  function reconcile(retryPending: boolean): void {
    if (disposed || ctx.state === 'closed') return;
    if (hidden()) {
      if (running()) suspend();
      return;
    }
    if (everUnlocked && !running() && (retryPending || !resumePending)) resume();
  }
  const onPageEvent = () => {
    reconcile(true);
  };

  const onStateChange = () => {
    if (disposed) return;
    if (running()) {
      unlock.disarm();
      markUnlocked();
      return;
    }
    armGesture();
  };
  const onPageHide = () => {
    pageHidden = true;
    reconcile(true);
  };
  const onPageShow = () => {
    pageHidden = false;
    reconcile(true);
  };

  if (running()) markUnlocked();
  ctx.addEventListener('statechange', onStateChange);
  visibility.addEventListener('visibilitychange', onPageEvent);
  page.addEventListener('focus', onPageEvent);
  page.addEventListener('pageshow', onPageShow);
  page.addEventListener('pagehide', onPageHide);

  return {
    whenUnlocked,
    dispose() {
      disposed = true;
      unlock.disarm();
      ctx.removeEventListener('statechange', onStateChange);
      visibility.removeEventListener('visibilitychange', onPageEvent);
      page.removeEventListener('focus', onPageEvent);
      page.removeEventListener('pageshow', onPageShow);
      page.removeEventListener('pagehide', onPageHide);
    },
  };
}

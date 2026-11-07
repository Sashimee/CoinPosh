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

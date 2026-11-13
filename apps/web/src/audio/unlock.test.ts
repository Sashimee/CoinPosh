import { describe, expect, it, vi } from 'vitest';
import {
  armUnlock,
  manageAudioLifecycle,
  UNLOCK_EVENTS,
  type LifecycleContext,
  type UnlockableContext,
  type VisibilitySource,
} from './unlock.ts';

class FakeContext implements UnlockableContext {
  state: AudioContextState = 'suspended';
  readonly sampleRate = 48000;
  readonly destination = {} as AudioNode;
  started = 0;
  resumeCalls = 0;
  refuse = false;

  resume(): Promise<void> {
    this.resumeCalls++;
    if (this.refuse) return Promise.reject(new Error('NotAllowedError'));
    this.state = 'running';
    return Promise.resolve();
  }

  createBuffer(): AudioBuffer {
    return {} as AudioBuffer;
  }

  createBufferSource(): AudioBufferSourceNode {
    return {
      buffer: null,
      connect: () => undefined,
      start: () => {
        this.started++;
      },
    } as unknown as AudioBufferSourceNode;
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('armUnlock', () => {
  it('resumes the context and plays a silent primer inside the first gesture', async () => {
    const ctx = new FakeContext();
    const target = new EventTarget();
    const onUnlocked = vi.fn();
    void armUnlock(ctx, target).unlocked.then(onUnlocked);
    target.dispatchEvent(new Event('touchend'));
    await flush();
    expect(ctx.resumeCalls).toBe(1);
    expect(ctx.started).toBe(1);
    expect(onUnlocked).toHaveBeenCalledTimes(1);
  });

  it('stops listening once unlocked', async () => {
    const ctx = new FakeContext();
    const target = new EventTarget();
    armUnlock(ctx, target);
    target.dispatchEvent(new Event('pointerdown'));
    await flush();
    for (const type of UNLOCK_EVENTS) target.dispatchEvent(new Event(type));
    expect(ctx.resumeCalls).toBe(1);
  });

  it('keeps listening when a gesture is refused and unlocks on a later one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ctx = new FakeContext();
    const target = new EventTarget();
    const onUnlocked = vi.fn();
    void armUnlock(ctx, target).unlocked.then(onUnlocked);
    ctx.refuse = true;
    target.dispatchEvent(new Event('mousedown'));
    await flush();
    expect(onUnlocked).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    ctx.refuse = false;
    target.dispatchEvent(new Event('keydown'));
    await flush();
    expect(onUnlocked).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('resolves immediately when the context is already running', async () => {
    const ctx = new FakeContext();
    ctx.state = 'running';
    const target = new EventTarget();
    const add = vi.spyOn(target, 'addEventListener');
    await armUnlock(ctx, target).unlocked;
    expect(add).not.toHaveBeenCalled();
  });

  it('can be disarmed before any gesture', async () => {
    const ctx = new FakeContext();
    const target = new EventTarget();
    armUnlock(ctx, target).disarm();
    target.dispatchEvent(new Event('click'));
    await flush();
    expect(ctx.resumeCalls).toBe(0);
  });

  it('listens in the capture phase so game handlers cannot swallow the gesture', () => {
    const target = new EventTarget();
    const add = vi.spyOn(target, 'addEventListener');
    armUnlock(new FakeContext(), target);
    expect(add).toHaveBeenCalledTimes(UNLOCK_EVENTS.length);
    for (const call of add.mock.calls) expect(call[2]).toMatchObject({ capture: true });
  });
});

type LifecycleState = AudioContextState | 'interrupted';

/**
 * Mirrors a browser context: every state change fires 'statechange'. With `deferred`, suspend()
 * and resume() only take effect when `settle()` runs them, in call order, like the control
 * messages a real AudioContext queues. With `hang`, resume() never settles (iOS after a call).
 */
class FakeLifecycleContext extends EventTarget implements LifecycleContext {
  private current: LifecycleState = 'suspended';
  private readonly queue: (() => void)[] = [];
  readonly sampleRate = 48000;
  readonly destination = {} as AudioNode;
  resumeCalls = 0;
  suspendCalls = 0;
  refuse = false;
  hang = false;
  deferred = false;

  get state(): LifecycleState {
    return this.current;
  }

  set(state: LifecycleState): void {
    if (state === this.current) return;
    this.current = state;
    this.dispatchEvent(new Event('statechange'));
  }

  resume(): Promise<void> {
    this.resumeCalls++;
    if (this.hang) return new Promise<void>(() => undefined);
    if (this.refuse) return Promise.reject(new Error('NotAllowedError'));
    return this.apply('running');
  }

  suspend(): Promise<void> {
    this.suspendCalls++;
    return this.apply('suspended');
  }

  async settle(): Promise<void> {
    for (let round = 0; round < 10; round++) {
      await flush();
      if (this.queue.length === 0) return;
      while (this.queue.length > 0) this.queue.shift()?.();
    }
    throw new Error('FakeLifecycleContext: suspend/resume kept re-queuing for 10 rounds.');
  }

  private apply(state: LifecycleState): Promise<void> {
    if (!this.deferred) {
      this.set(state);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.set(state);
        resolve();
      });
    });
  }

  createBuffer(): AudioBuffer {
    return {} as AudioBuffer;
  }

  createBufferSource(): AudioBufferSourceNode {
    return {
      buffer: null,
      connect: () => undefined,
      start: () => undefined,
    } as unknown as AudioBufferSourceNode;
  }
}

class FakeDocument extends EventTarget implements VisibilitySource {
  visibilityState: DocumentVisibilityState = 'visible';

  show(state: DocumentVisibilityState): void {
    this.visibilityState = state;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

function setup() {
  const ctx = new FakeLifecycleContext();
  const target = new EventTarget();
  const doc = new FakeDocument();
  const page = new EventTarget();
  const lifecycle = manageAudioLifecycle(ctx, target, doc, page);
  const onUnlocked = vi.fn();
  void lifecycle.whenUnlocked.then(onUnlocked);
  const tap = async () => {
    target.dispatchEvent(new Event('touchend'));
    await flush();
  };
  const fire = async (type: 'focus' | 'pageshow' | 'pagehide') => {
    page.dispatchEvent(new Event(type));
    await flush();
  };
  return { ctx, target, doc, page, lifecycle, onUnlocked, tap, fire };
}

describe('manageAudioLifecycle', () => {
  it('resolves whenUnlocked when the first gesture starts the context', async () => {
    const { ctx, onUnlocked, tap } = setup();
    await tap();
    expect(ctx.state).toBe('running');
    expect(onUnlocked).toHaveBeenCalledOnce();
  });

  it.each(['interrupted', 'suspended'] as const)(
    'still resolves whenUnlocked after the context goes %s before the first tap',
    async (state) => {
      const { ctx, onUnlocked, tap } = setup();
      ctx.set(state === 'suspended' ? 'interrupted' : 'suspended');
      ctx.set(state);
      await flush();
      expect(onUnlocked).not.toHaveBeenCalled();
      await tap();
      expect(ctx.state).toBe('running');
      expect(onUnlocked).toHaveBeenCalledOnce();
    },
  );

  it('lets a music start waiting on whenUnlocked go ahead after a re-armed unlock', async () => {
    const { ctx, lifecycle, tap } = setup();
    const started = vi.fn();
    const startMusic = async () => {
      await lifecycle.whenUnlocked;
      started();
    };
    const pending = startMusic();
    ctx.set('interrupted');
    await flush();
    expect(started).not.toHaveBeenCalled();
    await tap();
    await pending;
    expect(started).toHaveBeenCalledOnce();
  });

  it.each(['interrupted', 'suspended'] as const)(
    're-arms when the system drops a running context to %s and unlocks on the next tap',
    async (state) => {
      const { ctx, tap } = setup();
      await tap();
      expect(ctx.resumeCalls).toBe(1);
      ctx.set(state);
      await tap();
      expect(ctx.resumeCalls).toBe(2);
      expect(ctx.state).toBe('running');
    },
  );

  it('does not keep the gesture listeners alive once running', async () => {
    const { ctx, tap } = setup();
    await tap();
    await tap();
    expect(ctx.resumeCalls).toBe(1);
  });

  it('suspends on hide and resumes on show without needing a gesture', async () => {
    const { ctx, doc, tap } = setup();
    await tap();
    doc.show('hidden');
    await flush();
    expect(ctx.state).toBe('suspended');
    doc.show('visible');
    await flush();
    expect(ctx.state).toBe('running');
    expect(ctx.resumeCalls).toBe(2);
  });

  it('re-arms the gesture unlock when resume() is refused on show', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { ctx, doc, tap } = setup();
    await tap();
    doc.show('hidden');
    await flush();
    ctx.refuse = true;
    doc.show('visible');
    await flush();
    expect(ctx.state).toBe('suspended');
    ctx.refuse = false;
    await tap();
    expect(ctx.state).toBe('running');
    expect(ctx.resumeCalls).toBe(3);
    warn.mockRestore();
  });

  it('leaves a never-unlocked context alone on hide and show', async () => {
    const { ctx, doc, onUnlocked, tap } = setup();
    doc.show('hidden');
    doc.show('visible');
    await flush();
    expect(ctx.resumeCalls).toBe(0);
    await tap();
    expect(onUnlocked).toHaveBeenCalledOnce();
  });

  it('stops reacting to state, visibility and gestures once disposed', async () => {
    const { ctx, doc, lifecycle, tap, fire } = setup();
    lifecycle.dispose();
    ctx.set('interrupted');
    await tap();
    doc.show('hidden');
    doc.show('visible');
    await fire('pagehide');
    await fire('pageshow');
    await fire('focus');
    expect(ctx.resumeCalls).toBe(0);
    expect(ctx.suspendCalls).toBe(0);
  });

  it('does not arm a gesture unlock on a closed context', async () => {
    const { ctx, tap } = setup();
    ctx.set('closed');
    await tap();
    expect(ctx.resumeCalls).toBe(0);
  });
});

describe('manageAudioLifecycle tab-switch races (#184)', () => {
  const quietWarnings = () => vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  async function unlockedSetup() {
    const env = setup();
    await env.tap();
    expect(env.ctx.state).toBe('running');
    return env;
  }

  it.each(['suspended', 'interrupted'] as const)(
    'brings audio back on show when the system %s the context before the tab was hidden',
    async (state) => {
      const { ctx, doc } = await unlockedSetup();
      ctx.set(state);
      doc.show('hidden');
      await flush();
      expect(ctx.suspendCalls).toBe(0);
      doc.show('visible');
      await flush();
      expect(ctx.state).toBe('running');
      expect(ctx.resumeCalls).toBe(2);
    },
  );

  it('keeps a gesture armed while hidden and suspended so one tap recovers a refused show', async () => {
    const warn = quietWarnings();
    const { ctx, doc, tap } = await unlockedSetup();
    ctx.set('suspended');
    doc.show('hidden');
    ctx.refuse = true;
    doc.show('visible');
    await flush();
    expect(ctx.state).toBe('suspended');
    ctx.refuse = false;
    await tap();
    expect(ctx.state).toBe('running');
    warn.mockRestore();
  });

  it('ends running when hide and show land in one task before suspend() settles', async () => {
    const { ctx, doc } = await unlockedSetup();
    ctx.deferred = true;
    doc.show('hidden');
    doc.show('visible');
    await ctx.settle();
    expect(ctx.state).toBe('running');
  });

  it('ends suspended after hide/show/hide in one task, then runs again on show', async () => {
    const { ctx, doc } = await unlockedSetup();
    ctx.deferred = true;
    doc.show('hidden');
    doc.show('visible');
    doc.show('hidden');
    await ctx.settle();
    expect(ctx.state).toBe('suspended');
    doc.show('visible');
    await ctx.settle();
    expect(ctx.state).toBe('running');
  });

  it('re-suspends when a resume from show settles after the tab was hidden again', async () => {
    const { ctx, doc } = await unlockedSetup();
    doc.show('hidden');
    await flush();
    ctx.deferred = true;
    doc.show('visible');
    doc.show('hidden');
    await ctx.settle();
    expect(ctx.state).toBe('suspended');
    doc.show('visible');
    await ctx.settle();
    expect(ctx.state).toBe('running');
  });

  it('retries a refused resume on focus without needing a tap', async () => {
    const warn = quietWarnings();
    const { ctx, doc, fire } = await unlockedSetup();
    doc.show('hidden');
    ctx.refuse = true;
    doc.show('visible');
    await flush();
    expect(ctx.state).toBe('suspended');
    expect(warn).toHaveBeenCalledOnce();
    ctx.refuse = false;
    await fire('focus');
    expect(ctx.state).toBe('running');
    expect(ctx.resumeCalls).toBe(3);
    warn.mockRestore();
  });

  it('retries a refused resume on pageshow', async () => {
    const warn = quietWarnings();
    const { ctx, doc, fire } = await unlockedSetup();
    doc.show('hidden');
    ctx.refuse = true;
    doc.show('visible');
    await flush();
    ctx.refuse = false;
    await fire('pageshow');
    expect(ctx.state).toBe('running');
    warn.mockRestore();
  });

  it('does not spin on a resume that keeps being refused', async () => {
    const warn = quietWarnings();
    const { ctx, doc } = await unlockedSetup();
    doc.show('hidden');
    ctx.refuse = true;
    doc.show('visible');
    for (let i = 0; i < 5; i++) await flush();
    expect(ctx.resumeCalls).toBe(2);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('recovers from a resume that never settles with one tap', async () => {
    const { ctx, doc, tap } = await unlockedSetup();
    doc.show('hidden');
    ctx.hang = true;
    doc.show('visible');
    await flush();
    expect(ctx.state).toBe('suspended');
    ctx.hang = false;
    await tap();
    expect(ctx.state).toBe('running');
  });

  it('retries a resume that never settled when the window regains focus', async () => {
    const { ctx, doc, fire } = await unlockedSetup();
    doc.show('hidden');
    ctx.hang = true;
    doc.show('visible');
    await flush();
    ctx.hang = false;
    await fire('focus');
    expect(ctx.state).toBe('running');
  });

  it('suspends on pagehide and resumes on a bfcache pageshow with no visibilitychange', async () => {
    const { ctx, fire } = await unlockedSetup();
    await fire('pagehide');
    expect(ctx.state).toBe('suspended');
    await fire('pageshow');
    expect(ctx.state).toBe('running');
    expect(ctx.resumeCalls).toBe(2);
  });

  it('resumes on a bfcache pageshow after the frozen page was hidden and its context dropped', async () => {
    const { ctx, doc, fire } = await unlockedSetup();
    doc.show('hidden');
    await fire('pagehide');
    ctx.set('interrupted');
    doc.visibilityState = 'visible';
    await fire('pageshow');
    expect(ctx.state).toBe('running');
  });

  it('stays suspended between pagehide and pageshow even if the document reports visible', async () => {
    const { ctx, fire } = await unlockedSetup();
    await fire('pagehide');
    await fire('focus');
    expect(ctx.state).toBe('suspended');
    expect(ctx.resumeCalls).toBe(1);
  });

  it('never resumes a context that no gesture has unlocked', async () => {
    const { ctx, doc, fire, onUnlocked, tap } = setup();
    doc.show('hidden');
    await fire('pagehide');
    doc.show('visible');
    await fire('pageshow');
    await fire('focus');
    expect(ctx.resumeCalls).toBe(0);
    await tap();
    expect(onUnlocked).toHaveBeenCalledOnce();
  });

  it('drops the gesture listeners once a show resume gets the context running', async () => {
    const { ctx, doc, tap } = await unlockedSetup();
    doc.show('hidden');
    doc.show('visible');
    await flush();
    expect(ctx.resumeCalls).toBe(2);
    await tap();
    expect(ctx.resumeCalls).toBe(2);
  });
});

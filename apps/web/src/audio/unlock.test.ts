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

/** Mirrors a browser context: every state change fires 'statechange'. */
class FakeLifecycleContext extends EventTarget implements LifecycleContext {
  private current: LifecycleState = 'suspended';
  readonly sampleRate = 48000;
  readonly destination = {} as AudioNode;
  resumeCalls = 0;
  refuse = false;

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
    if (this.refuse) return Promise.reject(new Error('NotAllowedError'));
    this.set('running');
    return Promise.resolve();
  }

  suspend(): Promise<void> {
    this.set('suspended');
    return Promise.resolve();
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
  const lifecycle = manageAudioLifecycle(ctx, target, doc);
  const onUnlocked = vi.fn();
  void lifecycle.whenUnlocked.then(onUnlocked);
  const tap = async () => {
    target.dispatchEvent(new Event('touchend'));
    await flush();
  };
  return { ctx, target, doc, lifecycle, onUnlocked, tap };
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
    const { ctx, doc, lifecycle, tap } = setup();
    lifecycle.dispose();
    ctx.set('interrupted');
    await tap();
    doc.show('hidden');
    doc.show('visible');
    await flush();
    expect(ctx.resumeCalls).toBe(0);
  });

  it('does not arm a gesture unlock on a closed context', async () => {
    const { ctx, tap } = setup();
    ctx.set('closed');
    await tap();
    expect(ctx.resumeCalls).toBe(0);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { armUnlock, UNLOCK_EVENTS, type UnlockableContext } from './unlock.ts';

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

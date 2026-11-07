import { describe, expect, it, vi } from 'vitest';
import { suspendOnVisibilityChange } from './visibility.ts';

describe('suspendOnVisibilityChange', () => {
  it('suspends on every hide and show until unsubscribed', () => {
    const page = new EventTarget();
    const suspend = vi.fn<() => void>();
    const stop = suspendOnVisibilityChange(page, suspend);

    page.dispatchEvent(new Event('visibilitychange'));
    page.dispatchEvent(new Event('visibilitychange'));
    expect(suspend).toHaveBeenCalledTimes(2);

    stop();
    page.dispatchEvent(new Event('visibilitychange'));
    expect(suspend).toHaveBeenCalledTimes(2);
  });

  it('ignores other events', () => {
    const page = new EventTarget();
    const suspend = vi.fn<() => void>();
    suspendOnVisibilityChange(page, suspend);
    page.dispatchEvent(new Event('blur'));
    expect(suspend).not.toHaveBeenCalled();
  });

  it('is a no-op without a page to watch', () => {
    const suspend = vi.fn<() => void>();
    const stop = suspendOnVisibilityChange(null, suspend);
    expect(() => {
      stop();
    }).not.toThrow();
    expect(suspend).not.toHaveBeenCalled();
  });
});

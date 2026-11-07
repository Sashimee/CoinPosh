import { describe, expect, it, vi } from 'vitest';
import { createBus } from './bus.ts';
import { createStore, watch } from './store.ts';

describe('store', () => {
  it('notifies with the new and previous state, skipping no-op patches', () => {
    const store = createStore({ a: 1, b: 'x' });
    const listener = vi.fn();
    store.subscribe(listener);
    store.setState({ a: 1 });
    expect(listener).not.toHaveBeenCalled();
    store.setState((s) => ({ a: s.a + 1 }));
    expect(listener).toHaveBeenCalledWith({ a: 2, b: 'x' }, { a: 1, b: 'x' });
  });

  it('stops notifying after unsubscribe', () => {
    const store = createStore({ a: 1 });
    const listener = vi.fn();
    const off = store.subscribe(listener);
    off();
    store.setState({ a: 2 });
    expect(listener).not.toHaveBeenCalled();
  });

  it('watch fires once immediately and then only when the slice changes', () => {
    const store = createStore({ a: 1, b: 1 });
    const seen: [number, number | undefined][] = [];
    watch(
      store,
      (s) => s.a,
      (value, previous) => seen.push([value, previous]),
    );
    store.setState({ b: 2 });
    store.setState({ a: 5 });
    expect(seen).toEqual([
      [1, undefined],
      [5, 1],
    ]);
  });

  it('watch honours a custom equality', () => {
    const store = createStore({ list: [1] });
    const listener = vi.fn();
    watch(
      store,
      (s) => s.list,
      listener,
      (x, y) => x.length === y.length,
    );
    store.setState({ list: [2] });
    store.setState({ list: [2, 3] });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('bus', () => {
  it('delivers payloads and keeps going when a handler throws', () => {
    const bus = createBus<{ ping: { n: number } }>();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const good = vi.fn();
    bus.on('ping', () => {
      throw new Error('boom');
    });
    const off = bus.on('ping', good);
    bus.emit('ping', { n: 1 });
    expect(good).toHaveBeenCalledWith({ n: 1 });
    expect(error).toHaveBeenCalledOnce();
    off();
    bus.emit('ping', { n: 2 });
    expect(good).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it('ignores events nobody listens to', () => {
    const bus = createBus<{ ping: number }>();
    expect(() => {
      bus.emit('ping', 1);
    }).not.toThrow();
  });
});

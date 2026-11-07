export type StoreListener<S> = (state: S, previous: S) => void;

export interface Store<S extends object> {
  getState(): S;
  setState(patch: Partial<S> | ((state: S) => Partial<S>)): void;
  subscribe(listener: StoreListener<S>): () => void;
}

export function createStore<S extends object>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<StoreListener<S>>();
  return {
    getState: () => state,
    setState(patch) {
      const partial = typeof patch === 'function' ? patch(state) : patch;
      const keys = Object.keys(partial) as (keyof S)[];
      if (keys.every((key) => Object.is(partial[key], state[key]))) return;
      const previous = state;
      state = { ...state, ...partial };
      for (const listener of [...listeners]) listener(state, previous);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Calls `listener` with the selected slice whenever it changes, and once immediately. */
export function watch<S extends object, T>(
  store: Store<S>,
  selector: (state: S) => T,
  listener: (value: T, previous: T | undefined) => void,
  equals: (a: T, b: T) => boolean = Object.is,
): () => void {
  let current = selector(store.getState());
  listener(current, undefined);
  return store.subscribe((state) => {
    const next = selector(state);
    if (equals(next, current)) return;
    const previous = current;
    current = next;
    listener(next, previous);
  });
}

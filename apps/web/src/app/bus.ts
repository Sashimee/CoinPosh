export type EventMap = object;

export type Handler<T> = (payload: T) => void;

export interface Bus<E extends EventMap> {
  emit<K extends keyof E>(type: K, payload: E[K]): void;
  on<K extends keyof E>(type: K, handler: Handler<E[K]>): () => void;
}

export function createBus<E extends EventMap>(): Bus<E> {
  const handlers = new Map<keyof E, Set<Handler<never>>>();
  return {
    emit(type, payload) {
      const set = handlers.get(type);
      if (!set) return;
      for (const handler of [...set] as Handler<typeof payload>[]) {
        try {
          handler(payload);
        } catch (error) {
          console.error(`[CoinPosh] a "${String(type)}" handler threw`, error);
        }
      }
    },
    on(type, handler) {
      let set = handlers.get(type);
      if (!set) {
        set = new Set();
        handlers.set(type, set);
      }
      set.add(handler);
      return () => set.delete(handler);
    },
  };
}

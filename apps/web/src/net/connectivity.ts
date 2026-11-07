/** A hint that the network came back; the outbox still treats the server's answer as the truth. */
export interface Connectivity {
  onOnline(listener: () => void): () => void;
}

export function browserConnectivity(target: Window = window): Connectivity {
  return {
    onOnline(listener) {
      target.addEventListener('online', listener);
      return () => {
        target.removeEventListener('online', listener);
      };
    },
  };
}

export const neverOnline: Connectivity = { onOnline: () => () => undefined };

export interface Scheduler {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realScheduler: Scheduler = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

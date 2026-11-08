export interface Binding {
  dispose(): void;
}

export interface SurfaceFollower<S, B extends Binding> {
  readonly surface: S;
  readonly binding: B;
  /** Rebinds when `current()` now names a different surface; returns whether it did. */
  follow(): boolean;
  dispose(): void;
}

/**
 * Keeps a binding on whichever surface `current()` names. The stage swaps in a new canvas when
 * it rebuilds its renderer after a GPU device loss, so input bound once would go to a detached
 * canvas for the rest of the session.
 */
export function followSurface<S, B extends Binding>(
  current: () => S,
  bind: (surface: S) => B,
): SurfaceFollower<S, B> {
  let surface = current();
  let binding = bind(surface);
  let disposed = false;
  return {
    get surface() {
      return surface;
    },
    get binding() {
      return binding;
    },
    follow() {
      if (disposed) return false;
      const next = current();
      if (next === surface) return false;
      binding.dispose();
      surface = next;
      binding = bind(next);
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      binding.dispose();
    },
  };
}

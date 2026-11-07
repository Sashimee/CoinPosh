const QUERY = '(prefers-reduced-motion: reduce)';

export interface MotionPreference {
  readonly reduced: boolean;
  dispose(): void;
}

export function watchReducedMotion(onChange: (reduced: boolean) => void): MotionPreference {
  if (typeof globalThis.matchMedia !== 'function') {
    return { reduced: false, dispose: () => undefined };
  }
  const query = globalThis.matchMedia(QUERY);
  const state = {
    reduced: query.matches,
    dispose: () => {
      query.removeEventListener('change', listener);
    },
  };
  const listener = (event: MediaQueryListEvent): void => {
    state.reduced = event.matches;
    onChange(event.matches);
  };
  query.addEventListener('change', listener);
  return state;
}

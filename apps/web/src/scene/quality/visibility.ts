export interface VisibilitySource {
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

/**
 * Calls `suspend` whenever the page is hidden or shown, so a tab switch shorter than the
 * controller's pause threshold still never reaches it as one long frame. Returns the unsubscribe.
 */
export function suspendOnVisibilityChange(
  source: VisibilitySource | null,
  suspend: () => void,
): () => void {
  if (source === null) return () => undefined;
  const listener = (): void => {
    suspend();
  };
  source.addEventListener('visibilitychange', listener);
  return () => {
    source.removeEventListener('visibilitychange', listener);
  };
}

export function documentVisibility(): VisibilitySource | null {
  return typeof document === 'undefined' ? null : document;
}

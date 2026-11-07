import type { MotionSetting } from '../../app/settings.ts';

type Listener = (reduced: boolean) => void;

const QUERY = '(prefers-reduced-motion: reduce)';
const listeners = new Set<Listener>();
let preference: MotionSetting = 'system';
let query: MediaQueryList | null = null;

function systemPrefersReduced(): boolean {
  if (typeof matchMedia !== 'function') return false;
  if (!query) {
    query = matchMedia(QUERY);
    query.addEventListener('change', notify);
  }
  return query.matches;
}

export function resolveReducedMotion(setting: MotionSetting, systemReduced: boolean): boolean {
  if (setting === 'reduced') return true;
  if (setting === 'full') return false;
  return systemReduced;
}

export function isReducedMotion(): boolean {
  return resolveReducedMotion(preference, systemPrefersReduced());
}

function notify(): void {
  const reduced = isReducedMotion();
  for (const listener of listeners) listener(reduced);
}

export function setMotionPreference(next: MotionSetting): void {
  if (next === preference) return;
  preference = next;
  notify();
}

export function onReducedMotionChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

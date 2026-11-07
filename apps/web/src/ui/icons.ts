import { fromMarkup } from './dom.ts';

const svg = (body: string, viewBox = '0 0 24 24'): string =>
  `<svg class="cp-icon" viewBox="${viewBox}" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const ICONS = {
  settings: svg(
    '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2 5.5 5.5"/><circle cx="12" cy="12" r="6.4"/>',
  ),
  upgrades: svg(
    '<path d="M4 17.5 6.2 8l3.9 4.2L12 5.5l1.9 6.7L17.8 8l2.2 9.5Z"/><path d="M4.6 20.5h14.8"/><circle cx="12" cy="5.2" r=".6" fill="currentColor"/>',
  ),
  close: svg('<path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/>'),
  bell: svg(
    '<path d="M5 17.5h14l-1.6-2.2V11a5.4 5.4 0 0 0-10.8 0v4.3Z"/><path d="M10.2 20.2a2 2 0 0 0 3.6 0M12 3.6v2"/>',
  ),
  coin: svg(
    '<circle cx="12" cy="12" r="8.6" fill="currentColor" fill-opacity=".18"/><circle cx="12" cy="12" r="6.2"/><path d="M13.9 9.6a2.5 2.5 0 1 0 0 4.8"/>',
  ),
  goldBar: svg(
    '<path d="M3.2 17.2 6 9.8h12l2.8 7.4Z" fill="currentColor" fill-opacity=".18"/><path d="M8.6 9.8 9.6 7h4.8l1 2.8"/>',
  ),
  laurel: svg(
    '<path d="M12 20.5c-4.5-1.6-7-5.3-7-10.4M12 20.5c4.5-1.6 7-5.3 7-10.4"/><path d="M5.4 13.6c1.5.1 2.6.9 3.1 2.2M5 9.8c1.3.4 2.1 1.3 2.4 2.6M18.6 13.6c-1.5.1-2.6.9-3.1 2.2M19 9.8c-1.3.4-2.1 1.3-2.4 2.6"/><path d="m12 4.5 1.1 2.3 2.5.3-1.8 1.7.4 2.5-2.2-1.2-2.2 1.2.4-2.5-1.8-1.7 2.5-.3Z"/>',
  ),
  sound: svg(
    '<path d="M4.5 9.5h3.2L12 6v12l-4.3-3.5H4.5Z"/><path d="M15.4 9.2a4 4 0 0 1 0 5.6M17.8 6.8a7.4 7.4 0 0 1 0 10.4"/>',
  ),
  feel: svg(
    '<rect x="7.5" y="3.5" width="9" height="17" rx="2.2"/><path d="M4 8.5v7M20 8.5v7M2 10.5v3M22 10.5v3"/>',
  ),
  display: svg('<path d="M12 3.5 20 8v8l-8 4.5L4 16V8Z"/><path d="m4 8 8 4.5L20 8M12 12.5v8"/>'),
  language: svg(
    '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.4 3.5 5.2 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.2-3.5-8.5S9.6 5.9 12 3.5Z"/>',
  ),
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName): Element {
  return fromMarkup(ICONS[name]);
}

import { fromMarkup } from '../dom.ts';

const svg = (body: string): string =>
  `<svg class="cp-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const SEASON_ICONS = {
  flame: svg(
    '<path d="M12 21c-3.9 0-6.5-2.6-6.5-6.1 0-3.4 2.4-5.3 3.6-8.4.4 1.9 1.4 3 2.5 3.6-.2-2.8 1-5.3 3.1-7.1-.2 3.3 1.3 5 2.6 7 1 1.5 1.2 2.9 1.2 4.9 0 3.5-2.6 6.1-6.5 6.1Z" fill="currentColor" fill-opacity=".18"/><path d="M12 21c-1.8 0-3-1.2-3-2.9 0-1.6 1.2-2.6 2-4.1.9 1 2.1 1.3 2.7 2.6.6 1.4.1 4.4-1.7 4.4Z"/>',
  ),
  snowflake: svg(
    '<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/><path d="m9.6 4.6 2.4 2 2.4-2M9.6 19.4l2.4-2 2.4 2M4.4 10.7l3 .9-.7 3M19.6 13.3l-3-.9.7-3M4.4 13.3l3-.9-.7-3M19.6 10.7l-3 .9.7 3"/>',
  ),
  star: svg(
    '<path d="m12 3.2 2.6 5.5 6 .8-4.4 4.1 1.1 6-5.3-2.9-5.3 2.9 1.1-6L3.4 9.5l6-.8Z" fill="currentColor" fill-opacity=".22"/>',
  ),
  lock: svg(
    '<rect x="5" y="10.5" width="14" height="10" rx="2.2" fill="currentColor" fill-opacity=".16"/><path d="M8.2 10.5V8a3.8 3.8 0 0 1 7.6 0v2.5M12 14.4v2.4"/>',
  ),
  check: svg('<path d="m5.5 12.5 4.2 4.2 8.8-9.4"/>'),
} as const;

export type SeasonIconName = keyof typeof SEASON_ICONS;

export function seasonIcon(name: SeasonIconName): Element {
  return fromMarkup(SEASON_ICONS[name]);
}

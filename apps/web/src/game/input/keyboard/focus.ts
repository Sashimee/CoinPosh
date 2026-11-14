/** The slice of an element the focus rules read, so they run on any DOM, real or not. */
export interface FocusTarget {
  readonly tagName: string;
  readonly isContentEditable?: boolean;
  closest(selectors: string): unknown;
}

export interface FocusDocument {
  readonly activeElement: FocusTarget | null;
  querySelectorAll(selectors: string): ArrayLike<FocusTarget>;
}

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const EDITABLE = '[contenteditable]:not([contenteditable="false"])';

/** Space and Enter press these; the table must not take those keys from them. */
const ACTIVATABLE = [
  'button',
  'a[href]',
  'summary',
  'label',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="slider"]',
  '[role="tab"]',
  '[role="option"]',
  '[role="menuitem"]',
].join(', ');

const MODAL = '[aria-modal="true"], dialog[open]';
const DORMANT = '[hidden], [inert], [aria-hidden="true"]';

export function isTyping(el: FocusTarget | null): boolean {
  if (el === null) return false;
  if (TYPING_TAGS.has(el.tagName.toUpperCase())) return true;
  if (el.isContentEditable === true) return true;
  return el.closest(EDITABLE) !== null;
}

export function isActivatable(el: FocusTarget | null): boolean {
  return el !== null && el.closest(ACTIVATABLE) !== null;
}

/** A sheet or dialog is up: it keeps its layer mounted while closed, but hidden. */
export function modalOpen(doc: FocusDocument): boolean {
  return Array.from(doc.querySelectorAll(MODAL)).some((modal) => modal.closest(DORMANT) === null);
}

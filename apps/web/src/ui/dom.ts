export type Child = Node | string | null | undefined | false;

export interface Props {
  readonly class?: string;
  readonly attrs?: Readonly<Record<string, string>>;
  readonly text?: string;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  for (const [name, value] of Object.entries(props.attrs ?? {})) el.setAttribute(name, value);
  if (props.text !== undefined) el.textContent = props.text;
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child);
  }
  return el;
}

/** Builds an element from trusted, static markup (the icon set); never pass user data here. */
export function fromMarkup(markup: string): Element {
  const template = document.createElement('template');
  template.innerHTML = markup.trim();
  const node = template.content.firstElementChild;
  if (!node) throw new Error('fromMarkup: markup produced no element');
  return node;
}

export function listen<K extends keyof HTMLElementEventMap>(
  target: HTMLElement | Document | Window,
  type: K,
  handler: (event: HTMLElementEventMap[K]) => void,
  options?: AddEventListenerOptions,
): () => void {
  target.addEventListener(type, handler as EventListener, options);
  return () => {
    target.removeEventListener(type, handler as EventListener, options);
  };
}

/** Restarts a CSS animation class, even when it is already applied. */
export function restartAnimation(el: HTMLElement, className: string): void {
  el.classList.remove(className);
  el.getBoundingClientRect();
  el.classList.add(className);
}

export function rectOf(el: Element): DOMRect {
  return el.getBoundingClientRect();
}

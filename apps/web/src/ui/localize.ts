import type { I18n } from '../i18n/index.ts';

type Binding = () => void;

/** Keeps every translated string and attribute live across language switches. */
export class Localizer {
  private readonly bindings = new Set<Binding>();
  private readonly unsubscribe: () => void;

  constructor(readonly i18n: I18n) {
    this.unsubscribe = i18n.onLanguageChanged(() => {
      this.refresh();
    });
  }

  text(el: Element, render: () => string): () => void {
    return this.bind(() => {
      const next = render();
      if (el.textContent !== next) el.textContent = next;
    });
  }

  attr(el: Element, name: string, render: () => string): () => void {
    return this.bind(() => {
      el.setAttribute(name, render());
    });
  }

  /** Runs `effect` now and after every language change. */
  bind(effect: Binding): () => void {
    this.bindings.add(effect);
    effect();
    return () => this.bindings.delete(effect);
  }

  refresh(): void {
    for (const binding of [...this.bindings]) binding();
  }

  dispose(): void {
    this.unsubscribe();
    this.bindings.clear();
  }
}

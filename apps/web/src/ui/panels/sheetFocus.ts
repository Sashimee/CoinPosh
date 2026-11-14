export interface Focusable {
  focus(options?: FocusOptions): void;
}

export interface FocusScope {
  contains(node: Node | null): boolean;
}

export interface Inertable {
  inert: boolean;
}

export interface KeyLike {
  readonly key: string;
  readonly defaultPrevented: boolean;
  preventDefault(): void;
}

export interface FocusDocument {
  readonly activeElement: Element | null;
  readonly body: HTMLElement | null;
  addEventListener(type: 'keydown', listener: (event: KeyboardEvent) => void): void;
  removeEventListener(type: 'keydown', listener: (event: KeyboardEvent) => void): void;
}

export interface SheetFocusHandle {
  opened(): void;
  /**
   * Call when the sheet starts closing. Its controls go inert and focus goes back to `trigger`
   * at once, unless the user had already moved on, so no key or tap aimed at the shrinking sheet
   * can press anything in it. Run the returned function once the close animation ends: it hands
   * focus back again if it was dropped on the body in the meantime.
   */
  closing(trigger: Focusable | null): () => void;
  dispose(): void;
}

export interface SheetFocus {
  /** `controls` goes inert while the sheet is closing or closed; it defaults to none. */
  register(scope: FocusScope, dismiss: () => void, controls?: Inertable): SheetFocusHandle;
}

interface Entry {
  readonly scope: FocusScope;
  readonly dismiss: () => void;
}

/**
 * Coordinates focus and Escape across sheets. The most recently opened sheet owns Escape
 * wherever focus sits, and a sheet that finishes closing late (its close animation outlives
 * the opening of another sheet) never steals focus from the sheet that replaced it.
 */
export function createSheetFocus(doc: FocusDocument): SheetFocus {
  const stack: Entry[] = [];
  let registered = 0;
  let opens = 0;

  const onKeyDown = (event: KeyLike): void => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    const owner = stack[stack.length - 1];
    if (!owner) return;
    event.preventDefault();
    owner.dismiss();
  };
  const remove = (entry: Entry): void => {
    const index = stack.indexOf(entry);
    if (index >= 0) stack.splice(index, 1);
  };

  return {
    register(scope, dismiss, controls) {
      const entry: Entry = { scope, dismiss };
      if (controls) controls.inert = true;
      if (registered++ === 0) doc.addEventListener('keydown', onKeyDown);
      let disposed = false;
      return {
        opened() {
          if (controls) controls.inert = false;
          remove(entry);
          stack.push(entry);
          opens++;
        },
        closing(trigger) {
          remove(entry);
          const opensAtClose = opens;
          const handBack = (): void => {
            const active = doc.activeElement;
            const stillInside = active !== null && scope.contains(active);
            const abandoned = (active === null || active === doc.body) && opens === opensAtClose;
            if (stillInside || abandoned) trigger?.focus({ preventScroll: true });
          };
          handBack();
          if (controls) controls.inert = true;
          return handBack;
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          remove(entry);
          if (--registered === 0) doc.removeEventListener('keydown', onKeyDown);
        },
      };
    },
  };
}

let shared: SheetFocus | null = null;

export function sharedSheetFocus(): SheetFocus {
  shared ??= createSheetFocus(document);
  return shared;
}

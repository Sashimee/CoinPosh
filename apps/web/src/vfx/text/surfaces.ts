export interface SurfaceState {
  /** A sheet or dialog is open and asking for attention: pops are held for a tally. */
  readonly blocking: boolean;
  /** Something modal is on screen, possibly still animating closed: pops stack under it. */
  readonly covered: boolean;
}

export interface SurfaceProbe {
  read(): SurfaceState;
  dispose(): void;
}

export const NO_SURFACE: SurfaceState = { blocking: false, covered: false };

const MODAL = '[aria-modal="true"]';
const DISMISSED = '[hidden], [inert], [aria-hidden="true"]';
const SHEET_LAYER = '.cp-sheet-layer';
const ATTRIBUTES = ['hidden', 'inert', 'aria-hidden', 'aria-modal', 'class', 'data-state'];

/**
 * Reads the open-surface state from the DOM the UI already renders: every sheet, crate
 * reveal, Vault return and Turnstile challenge is an `aria-modal` dialog, dismissed ones
 * sit under `hidden`, `inert` or `aria-hidden="true"`, and a bottom sheet that is closing
 * keeps its layer shown but drops `is-open`.
 */
export function readSurfaces(doc: Pick<Document, 'querySelectorAll'>): SurfaceState {
  let covered = false;
  for (const dialog of doc.querySelectorAll(MODAL)) {
    if (dialog.closest(DISMISSED)) continue;
    covered = true;
    const layer = dialog.closest(SHEET_LAYER);
    if (!layer || layer.classList.contains('is-open')) return { blocking: true, covered };
  }
  return { blocking: false, covered };
}

/**
 * Re-reads `readSurfaces` only after the DOM changed, so a frame costs one flag check.
 * Pending records are taken synchronously, so a pop spawned in the same task that opened
 * a sheet is already held.
 * Mutations inside `ignore` (the pop layer itself, which churns every frame) do not count.
 * A document without a window (no `MutationObserver`) has no UI to watch and reads clear.
 */
export function watchSurfaces(doc: Document, ignore: Node): SurfaceProbe {
  const Observer = doc.defaultView?.MutationObserver;
  if (!Observer) return { read: () => NO_SURFACE, dispose: () => undefined };
  let dirty = true;
  let state = NO_SURFACE;
  const note = (records: readonly MutationRecord[]): void => {
    if (records.some((r) => !ignore.contains(r.target))) dirty = true;
  };
  const observer = new Observer(note);
  observer.observe(doc.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ATTRIBUTES,
  });
  return {
    read() {
      note(observer.takeRecords());
      if (dirty) {
        dirty = false;
        state = readSurfaces(doc);
      }
      return state;
    },
    dispose() {
      observer.disconnect();
    },
  };
}

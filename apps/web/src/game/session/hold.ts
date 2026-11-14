import type { TableSync } from '../../net/index.ts';
import type { TableCapture } from './capture.ts';
import type { PagePort } from './triggers.ts';

/** How long a held table runs again to land a coin it cannot pose yet. */
export const HOLD_SETTLE_STEP_MS = 250;
/** A coin still unposable after this long is left to the boot's rules. */
export const HOLD_SETTLE_LIMIT_MS = 2_000;
/** Uploads a held table makes when the server asks for fewer snapshots. */
export const HOLD_UPLOAD_TRIES = 3;

export interface TableHoldDeps {
  readonly sim: { pause(): void; resume(): void };
  readonly capture: Pick<TableCapture, 'refresh' | 'capture' | 'unposed'>;
  readonly table: Pick<TableSync, 'flush' | 'snapshot' | 'subscribe' | 'superseded'>;
  /** The sim resumes itself when the page is shown, so a held table is paused again. */
  readonly page: Pick<PagePort, 'visible' | 'onVisibilityChange'>;
  readonly wait: (ms: number) => Promise<void>;
}

export interface TableHold {
  /**
   * Resolves once every claim is answered and the server holds a pose of the table as it
   * stands still, so a boot lays every coin it kept instead of refunding one.
   */
  readonly posed: Promise<void>;
  /** Lets the table move again, as when the boot it was held for failed. */
  release(): void;
}

/**
 * Stills the table in play before a boot. A table left running while the boot drains the queue
 * can fuse or drop a coin after its last upload, and the boot refunds every coin no upload
 * posed. A table another page holds is already still and can upload nothing, so it is left be.
 */
export function holdTable(deps: TableHoldDeps): TableHold {
  const { capture, table, page, wait } = deps;
  if (table.superseded) return { posed: Promise.resolve(), release: () => undefined };
  let released = false;
  // Read through a call: `release()` flips it while this hold awaits, which narrowing cannot see.
  const isReleased = (): boolean => released;
  let settling = false;
  const sim = {
    pause: () => {
      settling = false;
      deps.sim.pause();
    },
    resume: () => {
      settling = true;
      deps.sim.resume();
    },
  };
  sim.pause();
  const stopShown = page.onVisibilityChange(() => {
    if (!released && !settling && page.visible()) deps.sim.pause();
  });

  const still = async (): Promise<void> => {
    // A sample asked for before the pause may still be on its way; the next one is taken after
    // it, behind every fall and fusion the sim reported before it stopped.
    await capture.refresh();
    await capture.refresh();
    await table.flush();
  };

  const upload = async (): Promise<void> => {
    for (let tries = 0; tries < HOLD_UPLOAD_TRIES && !isReleased(); tries++) {
      const taken = capture.capture();
      if (taken === null) return;
      let deferredMs = null as number | null;
      const stop = table.subscribe((event) => {
        if (event.type === 'snapshotDeferred') deferredMs = event.retryAfterMs;
      });
      try {
        if (!table.snapshot(taken)) return;
        await table.flush();
      } finally {
        stop();
      }
      if (deferredMs === null) return;
      await wait(deferredMs);
    }
  };

  const posed = (async () => {
    await still();
    for (
      let waited = 0;
      capture.unposed() > 0 && waited < HOLD_SETTLE_LIMIT_MS && !isReleased();
      waited += HOLD_SETTLE_STEP_MS
    ) {
      sim.resume();
      await wait(HOLD_SETTLE_STEP_MS);
      if (isReleased()) return;
      sim.pause();
      await still();
    }
    await upload();
  })();

  return {
    posed,
    release() {
      if (released) return;
      released = true;
      stopShown();
      sim.resume();
    },
  };
}

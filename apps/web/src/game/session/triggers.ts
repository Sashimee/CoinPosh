import type { Bus } from '../../app/bus.ts';
import type { SnapshotCadence } from '../../net/index.ts';
import type { SimEventBatch } from '../simWorker/index.ts';
import type { GameEvents } from '../systems/index.ts';
import type { TableCapture } from './capture.ts';

/** How often the sim is sampled while the table moves: well inside the cadence's 1 s settle. */
export const SAMPLE_INTERVAL_MS = 400;
/** Sampling stops this long after the last movement: past the cadence's 10 s heartbeat. */
export const SAMPLE_WINDOW_MS = 12_000;
/**
 * A sim contact at least this hard counts as the table moving. The pusher grinds the heap in
 * soft contacts all the time; a coin landing or a pile slipping strikes harder.
 */
export const ACTIVITY_CONTACT_STRENGTH = 0.25;

export interface PagePort {
  visible(): boolean;
  onVisibilityChange(listener: () => void): () => void;
  /** Runs before the page tears down, also when it is kept in the back/forward cache. */
  onPagehide(listener: () => void): () => void;
}

export interface SnapshotTriggerDeps {
  readonly cadence: Pick<SnapshotCadence, 'activity' | 'hidden' | 'pagehide' | 'close'>;
  readonly capture: Pick<TableCapture, 'refresh'>;
  readonly game: Pick<Bus<GameEvents>, 'on'>;
  readonly sim: { onEvents(listener: (batch: SimEventBatch) => void): () => void };
  readonly page: PagePort;
  readonly scheduler: {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  readonly now: () => number;
  readonly onError: (error: unknown) => void;
}

export interface SnapshotTriggers {
  /** Stops sampling and listening and closes the cadence; nothing uploads after this. */
  close(): void;
}

function moved(batch: SimEventBatch): boolean {
  return (
    batch.falls.length > 0 ||
    batch.fusions.length > 0 ||
    batch.contacts.some((contact) => contact.strength >= ACTIVITY_CONTACT_STRENGTH)
  );
}

/**
 * Tells the snapshot cadence when the table moved: a drop, a nudge, a fusion, a fall, or a hard
 * strike in the sim. Meanwhile the sim is sampled so a capture is fresh when the cadence asks.
 * A hidden page uploads its latest sample at once, then again once a last fresh one lands; a page going away hands the queued
 * snapshot to its keepalive request.
 */
export function wireSnapshotTriggers(deps: SnapshotTriggerDeps): SnapshotTriggers {
  const { cadence, capture, page, scheduler, now } = deps;
  let closed = false;
  let lastActivity = now();
  let timer: unknown = null;

  const sample = (): Promise<void> =>
    capture.refresh().catch((error: unknown) => {
      // A sample still in flight when the table is torn down fails with the disposed bridge.
      if (!closed) deps.onError(error);
    });

  const loop = (): void => {
    timer = null;
    if (closed || !page.visible() || now() - lastActivity > SAMPLE_WINDOW_MS) return;
    void sample();
    timer = scheduler.setTimeout(loop, SAMPLE_INTERVAL_MS);
  };

  const activity = (): void => {
    if (closed) return;
    lastActivity = now();
    cadence.activity();
    if (timer === null) loop();
  };

  const offs = [
    deps.game.on('drop:requested', activity),
    deps.game.on('nudge', activity),
    deps.game.on('coin:fusion', activity),
    deps.game.on('coin:fell', activity),
    deps.sim.onEvents((batch) => {
      if (moved(batch)) activity();
    }),
    page.onVisibilityChange(() => {
      if (closed) return;
      if (page.visible()) {
        if (timer === null) loop();
        return;
      }
      // A closing tab fires pagehide right after this, before the worker can answer, so the
      // latest sample is queued now; a fresher one replaces it if the page lives to see it.
      cadence.hidden();
      void sample().then(() => {
        if (!closed) cadence.hidden();
      });
    }),
    page.onPagehide(() => {
      if (!closed) cadence.pagehide();
    }),
  ];

  loop();

  return {
    close() {
      if (closed) return;
      closed = true;
      for (const off of offs) off();
      if (timer !== null) scheduler.clearTimeout(timer);
      timer = null;
      cadence.close();
    },
  };
}

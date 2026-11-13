import type { CratePoseTuple, PoseTuple } from '@coinposh/shared';
import type { Monotonic } from './clock.ts';
import type { Scheduler } from './connectivity.ts';
import type { SnapshotCapture, TableSync } from './tableSync.ts';

/**
 * When the table's resting poses go up (92-table-persistence 2.2, D7): once the table settles after
 * play, never more often than the server's rate bucket refills, a heartbeat while it keeps
 * moving, and at once when the page is hidden, since it may never come back.
 */
export const SNAPSHOT_CADENCE = {
  settleMs: 1_000,
  minIntervalMs: 3_000,
  heartbeatMs: 10_000,
} as const;

export interface SnapshotCadenceDeps {
  readonly table: Pick<TableSync, 'snapshot' | 'flush' | 'pagehide' | 'subscribe'>;
  /** Where the sim says the table rests now, or `null` while it has nothing to say. */
  readonly capture: () => SnapshotCapture | null;
  readonly scheduler: Scheduler;
  readonly monotonic: Monotonic;
}

function samePoses(
  a: readonly (PoseTuple | CratePoseTuple)[],
  b: readonly (PoseTuple | CratePoseTuple)[],
): boolean {
  return (
    a.length === b.length &&
    a.every((tuple, i) => {
      const other = b[i];
      return other !== undefined && tuple.every((value, j) => value === other[j]);
    })
  );
}

export class SnapshotCadence {
  readonly #deps: SnapshotCadenceDeps;
  #sentAt: number | null = null;
  #sent: SnapshotCapture | null = null;
  #notBefore = -Infinity;
  #settle: unknown = null;
  #heartbeat: unknown = null;
  #closed = false;
  readonly #unsubscribe: () => void;

  constructor(deps: SnapshotCadenceDeps) {
    this.#deps = deps;
    this.#unsubscribe = deps.table.subscribe((event) => {
      if (event.type === 'snapshotDeferred') {
        this.#notBefore = deps.monotonic() + event.retryAfterMs;
        this.#sent = null;
        this.#arm(this.#delayUntilAllowed());
      } else if (event.type === 'sessionSuperseded') {
        this.close();
      }
    });
    this.#beat();
  }

  /** Something moved on the table: upload once it has rested `settleMs`. */
  activity(): void {
    if (this.#closed) return;
    this.#arm(Math.max(SNAPSHOT_CADENCE.settleMs, this.#delayUntilAllowed()));
  }

  /** The page was hidden: upload now and send it, as the page may be frozen or closed next. */
  hidden(): void {
    if (this.#closed) return;
    this.#cancelSettle();
    this.#upload();
    void this.#deps.table.flush();
  }

  /** The page is unloading: hand the queued snapshot to the keepalive request signed for it. */
  pagehide(): void {
    if (this.#closed) return;
    this.#deps.table.pagehide();
  }

  close(): void {
    this.#closed = true;
    this.#unsubscribe();
    this.#cancelSettle();
    if (this.#heartbeat !== null) this.#deps.scheduler.clearTimeout(this.#heartbeat);
    this.#heartbeat = null;
  }

  #delayUntilAllowed(): number {
    const now = this.#deps.monotonic();
    const byInterval = this.#sentAt === null ? now : this.#sentAt + SNAPSHOT_CADENCE.minIntervalMs;
    return Math.max(0, byInterval - now, this.#notBefore - now);
  }

  #arm(delayMs: number): void {
    this.#cancelSettle();
    this.#settle = this.#deps.scheduler.setTimeout(() => {
      this.#settle = null;
      this.#attempt();
    }, delayMs);
  }

  #cancelSettle(): void {
    if (this.#settle !== null) this.#deps.scheduler.clearTimeout(this.#settle);
    this.#settle = null;
  }

  #beat(): void {
    this.#heartbeat = this.#deps.scheduler.setTimeout(() => {
      this.#heartbeat = null;
      if (this.#closed) return;
      if (this.#settle === null) this.#attempt();
      this.#beat();
    }, SNAPSHOT_CADENCE.heartbeatMs);
  }

  #attempt(): void {
    if (this.#closed) return;
    const wait = this.#delayUntilAllowed();
    if (wait > 0) {
      this.#arm(wait);
      return;
    }
    this.#upload();
  }

  #upload(): void {
    const capture = this.#deps.capture();
    if (capture === null) return;
    const sent = this.#sent;
    if (
      sent !== null &&
      samePoses(sent.coins, capture.coins) &&
      samePoses(sent.crates, capture.crates)
    ) {
      return;
    }
    if (!this.#deps.table.snapshot(capture)) return;
    this.#sent = capture;
    this.#sentAt = this.#deps.monotonic();
  }
}

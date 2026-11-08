import type { PourGrade } from './events.ts';

export interface PourResult {
  readonly grade: PourGrade;
  /** Release time minus the beat marker: negative is early, positive late. */
  readonly offsetMs: number;
  readonly heldMs: number;
}

/**
 * The Sommelier Pour clock. Holding pours; letting go within `halfWindowMs` of the beat marker
 * is a Perfect Pour. It only grades the release: the stream of drops runs on sim ticks.
 */
export class PourTimer {
  readonly targetMs: number;
  readonly halfWindowMs: number;
  #startedAt: number | null = null;

  constructor(targetMs: number, halfWindowMs: number) {
    if (!(targetMs > 0) || !Number.isFinite(targetMs)) {
      throw new RangeError(`PourTimer: targetMs must be a positive number, got ${targetMs}`);
    }
    if (!(halfWindowMs >= 0) || halfWindowMs >= targetMs) {
      throw new RangeError(
        `PourTimer: halfWindowMs must be in [0, targetMs), got ${halfWindowMs} for a ${targetMs} ms target`,
      );
    }
    this.targetMs = targetMs;
    this.halfWindowMs = halfWindowMs;
  }

  get pouring(): boolean {
    return this.#startedAt !== null;
  }

  start(nowMs: number): void {
    if (this.#startedAt !== null) throw new Error('PourTimer.start: a pour is already running');
    this.#startedAt = nowMs;
  }

  /** How far along the gauge is, 1 at the beat marker; keeps rising past it. */
  progress(nowMs: number): number {
    if (this.#startedAt === null) return 0;
    return Math.max(0, nowMs - this.#startedAt) / this.targetMs;
  }

  /** True while a release now would be a Perfect Pour. */
  inWindow(nowMs: number): boolean {
    if (this.#startedAt === null) return false;
    return Math.abs(nowMs - this.#startedAt - this.targetMs) <= this.halfWindowMs;
  }

  release(nowMs: number): PourResult {
    if (this.#startedAt === null) throw new Error('PourTimer.release: no pour is running');
    const heldMs = Math.max(0, nowMs - this.#startedAt);
    this.#startedAt = null;
    const offsetMs = heldMs - this.targetMs;
    let grade: PourGrade = 'perfect';
    if (offsetMs < -this.halfWindowMs) grade = 'early';
    else if (offsetMs > this.halfWindowMs) grade = 'late';
    return { grade, offsetMs, heldMs };
  }

  /** Abandons a pour without grading it, as when a second finger turns it into a nudge. */
  cancel(): void {
    this.#startedAt = null;
  }
}

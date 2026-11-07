import { easeOutCubic } from '../../vfx/easing.ts';

/** The odometer's value `elapsedMs` into a roll to `total`; fast at first, easing onto the total. */
export function countUpValue(total: number, elapsedMs: number, durationMs: number): number {
  if (durationMs <= 0 || elapsedMs >= durationMs) return total;
  if (elapsedMs <= 0) return 0;
  return Math.floor(total * easeOutCubic(elapsedMs / durationMs));
}

/** Lets a tick through only when the value moved and the last one is at least `gapMs` old. */
export class TickThrottle {
  private lastAt = Number.NEGATIVE_INFINITY;
  private lastValue: number | null = null;

  constructor(private readonly gapMs: number) {}

  accept(nowMs: number, value: number): boolean {
    if (value === this.lastValue || nowMs - this.lastAt < this.gapMs) return false;
    this.lastAt = nowMs;
    this.lastValue = value;
    return true;
  }
}

import type { CoinId, PoseTuple, TableSessionId } from '@coinposh/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Scheduler } from './connectivity.ts';
import { SNAPSHOT_CADENCE, SnapshotCadence } from './snapshotCadence.ts';
import type { SnapshotCapture, TableEvent } from './tableSync.ts';

interface Timer {
  readonly at: number;
  readonly run: () => void;
}

class FakeClock implements Scheduler {
  now = 0;
  readonly #timers = new Set<Timer>();

  readonly monotonic = (): number => this.now;

  setTimeout(callback: () => void, delayMs: number): unknown {
    const timer = { at: this.now + delayMs, run: callback };
    this.#timers.add(timer);
    return timer;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as Timer);
  }

  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.#timers]
        .filter((timer) => timer.at <= end)
        .sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.#timers.delete(due);
      this.now = due.at;
      due.run();
    }
    this.now = end;
  }
}

function pose(x: number): PoseTuple {
  return ['coin_AAAAAAAAAAAAAAAA' as CoinId, x, 10, 0, 0, 0, 0, 1, 'asleep'];
}

function capture(x: number): SnapshotCapture {
  return { tick: 0, pusher: { tickInCycle: 0 }, coins: [pose(x)], crates: [] };
}

let clock: FakeClock;
let uploads: { at: number; capture: SnapshotCapture }[];
let flushes: number;
let pagehides: number;
let accept: boolean;
let listeners: Set<(event: TableEvent) => void>;
let current: SnapshotCapture | null;

function emit(event: TableEvent): void {
  for (const listener of listeners) listener(event);
}

function cadence(): SnapshotCadence {
  return new SnapshotCadence({
    table: {
      snapshot: (taken) => {
        if (accept) uploads.push({ at: clock.now, capture: taken });
        return accept;
      },
      flush: () => {
        flushes += 1;
        return Promise.resolve();
      },
      pagehide: () => {
        pagehides += 1;
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    capture: () => current,
    scheduler: clock,
    monotonic: clock.monotonic,
  });
}

beforeEach(() => {
  clock = new FakeClock();
  uploads = [];
  flushes = 0;
  pagehides = 0;
  accept = true;
  listeners = new Set();
  current = capture(1);
});

describe('SnapshotCadence', () => {
  it('uploads once the table has rested for the settle time', () => {
    const subject = cadence();
    subject.activity();
    clock.advance(SNAPSHOT_CADENCE.settleMs - 1);
    expect(uploads).toEqual([]);
    clock.advance(1);
    expect(uploads.map((upload) => upload.at)).toEqual([SNAPSHOT_CADENCE.settleMs]);
  });

  it('restarts the settle wait while the table keeps moving', () => {
    const subject = cadence();
    subject.activity();
    clock.advance(800);
    subject.activity();
    clock.advance(800);
    expect(uploads).toEqual([]);
    clock.advance(200);
    expect(uploads.map((upload) => upload.at)).toEqual([1_800]);
  });

  it('keeps at least the minimum interval between uploads', () => {
    const subject = cadence();
    subject.activity();
    clock.advance(SNAPSHOT_CADENCE.settleMs);
    current = capture(2);
    subject.activity();
    clock.advance(SNAPSHOT_CADENCE.settleMs);
    expect(uploads).toHaveLength(1);
    clock.advance(SNAPSHOT_CADENCE.minIntervalMs);
    expect(uploads.map((upload) => upload.at)).toEqual([
      SNAPSHOT_CADENCE.settleMs,
      SNAPSHOT_CADENCE.settleMs + SNAPSHOT_CADENCE.minIntervalMs,
    ]);
  });

  it('skips a capture whose poses match the last upload', () => {
    const subject = cadence();
    subject.activity();
    clock.advance(SNAPSHOT_CADENCE.settleMs);
    current = { ...capture(1), tick: 500 };
    subject.activity();
    clock.advance(SNAPSHOT_CADENCE.minIntervalMs * 2);
    expect(uploads).toHaveLength(1);
  });

  it('beats every heartbeat only when the table changed', () => {
    cadence();
    clock.advance(SNAPSHOT_CADENCE.heartbeatMs);
    expect(uploads.map((upload) => upload.at)).toEqual([SNAPSHOT_CADENCE.heartbeatMs]);
    clock.advance(SNAPSHOT_CADENCE.heartbeatMs);
    expect(uploads).toHaveLength(1);
    current = capture(3);
    clock.advance(SNAPSHOT_CADENCE.heartbeatMs);
    expect(uploads.map((upload) => upload.at)).toEqual([
      SNAPSHOT_CADENCE.heartbeatMs,
      SNAPSHOT_CADENCE.heartbeatMs * 3,
    ]);
  });

  it('still uploads every heartbeat while the table never rests', () => {
    const subject = cadence();
    for (let at = 0; at < 30_000; at += 500) {
      current = capture(at);
      subject.activity();
      clock.advance(500);
    }
    expect(uploads.map((upload) => upload.at)).toEqual([
      SNAPSHOT_CADENCE.heartbeatMs,
      SNAPSHOT_CADENCE.heartbeatMs * 2,
      SNAPSHOT_CADENCE.heartbeatMs * 3,
    ]);
    expect(uploads.at(-1)?.capture).toEqual(capture(29_500));
    clock.advance(SNAPSHOT_CADENCE.heartbeatMs);
    expect(uploads).toHaveLength(3);
  });

  it('sends nothing while the sim has nothing to capture', () => {
    current = null;
    const subject = cadence();
    subject.activity();
    clock.advance(SNAPSHOT_CADENCE.heartbeatMs * 2);
    expect(uploads).toEqual([]);
  });

  it('uploads and flushes at once when the page is hidden, even inside the interval', () => {
    const subject = cadence();
    subject.activity();
    clock.advance(SNAPSHOT_CADENCE.settleMs);
    current = capture(4);
    subject.activity();
    clock.advance(100);
    subject.hidden();
    expect(uploads.map((upload) => upload.at)).toEqual([SNAPSHOT_CADENCE.settleMs, 1_100]);
    expect(flushes).toBe(1);
    clock.advance(SNAPSHOT_CADENCE.minIntervalMs);
    expect(uploads).toHaveLength(2);
  });

  it('hands pagehide to the table so the presigned keepalive request goes out', () => {
    const subject = cadence();
    subject.pagehide();
    expect(pagehides).toBe(1);
  });

  it('waits out the server retry hint after a rate-limited upload and sends it again', () => {
    const subject = cadence();
    subject.activity();
    clock.advance(SNAPSHOT_CADENCE.settleMs);
    emit({ type: 'snapshotDeferred', retryAfterMs: 5_000 });
    clock.advance(4_999);
    expect(uploads).toHaveLength(1);
    clock.advance(1);
    expect(uploads.map((upload) => upload.at)).toEqual([
      SNAPSHOT_CADENCE.settleMs,
      SNAPSHOT_CADENCE.settleMs + 5_000,
    ]);
  });

  it('retries a capture the table refused to queue', () => {
    accept = false;
    const subject = cadence();
    subject.activity();
    clock.advance(SNAPSHOT_CADENCE.settleMs);
    accept = true;
    clock.advance(SNAPSHOT_CADENCE.heartbeatMs);
    expect(uploads).toHaveLength(1);
  });

  it('stops for good once the table session is superseded', () => {
    const subject = cadence();
    emit({ type: 'sessionSuperseded', session: 'session_AAAAAAAA' as TableSessionId });
    subject.activity();
    subject.hidden();
    subject.pagehide();
    clock.advance(SNAPSHOT_CADENCE.heartbeatMs * 3);
    expect(uploads).toEqual([]);
    expect(flushes).toBe(0);
    expect(pagehides).toBe(0);
    expect(listeners.size).toBe(0);
  });
});

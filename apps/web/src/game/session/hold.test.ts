import { describe, expect, it } from 'vitest';
import type { SnapshotCapture, TableEvent } from '../../net/index.ts';
import {
  HOLD_SETTLE_LIMIT_MS,
  HOLD_SETTLE_STEP_MS,
  HOLD_UPLOAD_TRIES,
  holdTable,
  type TableHoldDeps,
} from './hold.ts';

const CAPTURE: SnapshotCapture = { tick: 600, pusher: { tickInCycle: 0 }, coins: [], crates: [] };

interface Options {
  readonly superseded?: boolean;
  /** How many still samples report a coin the server could not pose yet. */
  readonly unposedFor?: number;
  /** How many uploads the server rate limits before taking one. */
  readonly deferrals?: number;
  readonly refresh?: () => Promise<void>;
}

function table(options: Options = {}) {
  const log: string[] = [];
  const listeners = new Set<(event: TableEvent) => void>();
  let unposed = options.unposedFor ?? 0;
  let deferrals = options.deferrals ?? 0;
  let queued = false;
  const waits: number[] = [];
  const deps: TableHoldDeps = {
    sim: {
      pause: () => log.push('pause'),
      resume: () => log.push('resume'),
    },
    capture: {
      refresh: () => {
        log.push('sample');
        return options.refresh?.() ?? Promise.resolve();
      },
      capture: () => CAPTURE,
      unposed: () => unposed,
    },
    table: {
      superseded: options.superseded ?? false,
      flush: () => {
        log.push('flush');
        if (queued) {
          queued = false;
          if (deferrals > 0) {
            deferrals -= 1;
            for (const listener of listeners) {
              listener({ type: 'snapshotDeferred', retryAfterMs: 900 });
            }
          }
        }
        if (unposed > 0) unposed -= 1;
        return Promise.resolve();
      },
      snapshot: (capture) => {
        log.push(capture === CAPTURE ? 'upload' : 'upload?');
        queued = true;
        return true;
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    wait: (ms) => {
      waits.push(ms);
      log.push(`wait ${String(ms)}`);
      return Promise.resolve();
    },
  };
  return { deps, log, waits, listeners };
}

describe('holdTable', () => {
  it('pauses at once, samples behind the pause, answers every claim, then uploads the still table', async () => {
    const { deps, log, listeners } = table();
    const hold = holdTable(deps);
    expect(log).toEqual(['pause', 'sample']);
    await hold.posed;
    expect(log).toEqual(['pause', 'sample', 'sample', 'flush', 'upload', 'flush']);
    expect(listeners.size).toBe(0);
  });

  it('runs the table again in short steps until a coin it could not pose has landed', async () => {
    const { deps, log } = table({ unposedFor: 3 });
    await holdTable(deps).posed;
    const still = ['sample', 'sample', 'flush'];
    const step = `wait ${String(HOLD_SETTLE_STEP_MS)}`;
    expect(log).toEqual([
      'pause',
      ...still,
      'resume',
      step,
      'pause',
      ...still,
      'resume',
      step,
      'pause',
      ...still,
      'upload',
      'flush',
    ]);
  });

  it('boots after the settle limit even when a coin never lands', async () => {
    const { deps, log, waits } = table({ unposedFor: Infinity });
    await holdTable(deps).posed;
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBe(HOLD_SETTLE_LIMIT_MS);
    expect(log.slice(-2)).toEqual(['upload', 'flush']);
    expect(log.filter((step) => step === 'pause')).toHaveLength(
      HOLD_SETTLE_LIMIT_MS / HOLD_SETTLE_STEP_MS + 1,
    );
  });

  it('uploads again after the wait the server asks for when it rate limits the still table', async () => {
    const { deps, log } = table({ deferrals: 1 });
    await holdTable(deps).posed;
    expect(log.slice(4)).toEqual(['upload', 'flush', 'wait 900', 'upload', 'flush']);
  });

  it(`gives up after ${String(HOLD_UPLOAD_TRIES)} rate-limited uploads, leaving the boot its last pose`, async () => {
    const { deps, log } = table({ deferrals: Infinity });
    await holdTable(deps).posed;
    expect(log.filter((step) => step === 'upload')).toHaveLength(HOLD_UPLOAD_TRIES);
  });

  it('leaves a table another page holds as it is', async () => {
    const { deps, log } = table({ superseded: true });
    const hold = holdTable(deps);
    await hold.posed;
    hold.release();
    expect(log).toEqual([]);
  });

  it('lets the table move once on release, and stops holding it', async () => {
    const { deps, log } = table({ unposedFor: 5 });
    const hold = holdTable(deps);
    hold.release();
    hold.release();
    await hold.posed;
    expect(log).toEqual(['pause', 'sample', 'resume', 'sample', 'flush']);
  });

  it('passes on a sample that failed, for the retake to release the table', async () => {
    const failure = new Error('SimBridge.snapshot: the worker failed');
    const { deps } = table({ refresh: () => Promise.reject(failure) });
    await expect(holdTable(deps).posed).rejects.toBe(failure);
  });
});

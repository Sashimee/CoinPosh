import { describe, expect, it } from 'vitest';
import type { FeedbackKind } from '../../app/state.ts';
import { createElsewhereOverlay, type ElsewhereView } from './overlay.ts';
import { createRetake } from './retake.ts';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

interface Booted {
  readonly session: string;
}

interface Laid {
  readonly session: string;
  readonly sim: number;
}

/**
 * One page's table, cut down to what "Play here" touches: a lease the server hands to the
 * latest boot, input that a superseded page stops, and the overlay with its button.
 */
function page() {
  const log: string[] = [];
  const server = { lease: 'other-tab', boots: 0 };
  const table = { session: 'this-tab', input: true, sim: 1 };
  const pending = {
    simReady: [] as Deferred<undefined>[],
    boot: [] as Deferred<Booted>[],
    lay: [] as Deferred<Laid>[],
  };
  let playFailure: Error | null = null;
  let sims = 1;
  const discarded: Laid[] = [];
  const failures: unknown[] = [];
  const feedback: FeedbackKind[] = [];
  const drawn: string[] = [];

  const retake = createRetake<Booted, Laid>({
    simReady: () => {
      log.push('simReady');
      const next = deferred<undefined>();
      pending.simReady.push(next);
      return next.promise.then(() => {
        log.push('simReady:ok');
      });
    },
    boot: () => {
      log.push('boot');
      const next = deferred<Booted>();
      pending.boot.push(next);
      return next.promise;
    },
    lay: (booted) => {
      log.push(`lay:${booted.session}`);
      const next = deferred<Laid>();
      pending.lay.push(next);
      return next.promise;
    },
    play: (laid) => {
      if (playFailure) throw playFailure;
      log.push(`play:${laid.session}`);
      table.session = laid.session;
      table.sim = laid.sim;
      table.input = true;
    },
    discard: (laid) => {
      discarded.push(laid);
    },
  });
  const view: ElsewhereView = {
    render: (phase) => drawn.push(phase),
    leave: () => drawn.push('leave'),
    dispose: () => drawn.push('dispose'),
  };
  const overlay = createElsewhereOverlay({
    view,
    retake,
    feedback: (kind) => feedback.push(kind),
    onRetakeFailed: (error) => failures.push(error),
  });

  return {
    log,
    server,
    table,
    overlay,
    discarded,
    failures,
    feedback,
    drawn,
    failPlay(error: Error) {
      playFailure = error;
    },
    superseded() {
      table.input = false;
      overlay.show();
    },
    async simIsReady() {
      const next = pending.simReady.shift();
      if (!next) throw new Error('no sim is warming');
      next.resolve(undefined);
      await flush();
    },
    async simFails(error: Error) {
      const next = pending.simReady.shift();
      if (!next) throw new Error('no sim is warming');
      next.reject(error);
      await flush();
    },
    async serverBoots() {
      const next = pending.boot.shift();
      if (!next) throw new Error('no boot is waiting on the server');
      server.boots += 1;
      server.lease = `this-tab-${server.boots}`;
      next.resolve({ session: server.lease });
      await flush();
    },
    async tableLaid() {
      const next = pending.lay.shift();
      if (!next) throw new Error('no table is being laid');
      sims += 1;
      next.resolve({ session: server.lease, sim: sims });
      await flush();
    },
    async layFails(error: Error) {
      const next = pending.lay.shift();
      if (!next) throw new Error('no table is being laid');
      next.reject(error);
      await flush();
    },
  };
}

describe('createRetake: superseded, "Play here", re-boot, input resumes', () => {
  it('takes the table back and resumes input once the re-booted sim is ready', async () => {
    const p = page();
    p.superseded();
    expect(p.table.input).toBe(false);
    expect(p.overlay.phase).toBe('open');

    p.overlay.press();
    expect(p.overlay.phase).toBe('busy');
    await p.simIsReady();
    await p.serverBoots();
    expect(p.server.lease).toBe('this-tab-1');
    expect(p.table.input).toBe(false);
    await p.tableLaid();

    expect(p.log).toEqual(['simReady', 'simReady:ok', 'boot', 'lay:this-tab-1', 'play:this-tab-1']);
    expect(p.table).toEqual({ session: 'this-tab-1', input: true, sim: 2 });
    expect(p.overlay.phase).toBe('hidden');
    expect(p.drawn).toEqual(['open', 'busy', 'leave']);
    expect(p.feedback).toEqual(['open', 'tap', 'confirm']);
    expect(p.failures).toEqual([]);
  });

  it('does not take the lease until a sim in this page is ready', async () => {
    const p = page();
    p.superseded();
    p.overlay.press();
    await flush();
    expect(p.log).toEqual(['simReady']);
    expect(p.server.boots).toBe(0);
    await p.simIsReady();
    expect(p.log.at(-1)).toBe('boot');
  });

  it('leaves the other tab its table when no sim can start here, and retries on the next press', async () => {
    const p = page();
    p.superseded();
    p.overlay.press();
    const failure = new Error('CoinPosh sim: the sim worker failed to load or crashed (error)');
    await p.simFails(failure);
    expect(p.log).toEqual(['simReady']);
    expect(p.server.lease).toBe('other-tab');
    expect(p.table.input).toBe(false);
    expect(p.overlay.phase).toBe('failed');
    expect(p.failures).toEqual([failure]);
    expect(p.feedback.at(-1)).toBe('deny');

    p.overlay.press();
    await p.simIsReady();
    await p.serverBoots();
    await p.tableLaid();
    expect(p.table.input).toBe(true);
    expect(p.overlay.phase).toBe('hidden');
  });

  it('keeps input off and the button up when the re-booted table cannot be laid', async () => {
    const p = page();
    p.superseded();
    p.overlay.press();
    await p.simIsReady();
    await p.serverBoots();
    await p.layFails(new Error('SimBridge: the restore names an unknown tier'));
    expect(p.log).not.toContain('play:this-tab-1');
    expect(p.table).toEqual({ session: 'this-tab', input: false, sim: 1 });
    expect(p.overlay.phase).toBe('failed');

    p.overlay.press();
    await p.simIsReady();
    await p.serverBoots();
    await p.tableLaid();
    expect(p.table).toEqual({ session: 'this-tab-2', input: true, sim: 2 });
  });

  it('discards the laid sim when handing it the table throws', async () => {
    const p = page();
    const failure = new Error('CoinPosh: the game systems could not start');
    p.failPlay(failure);
    p.superseded();
    p.overlay.press();
    await p.simIsReady();
    await p.serverBoots();
    await p.tableLaid();
    expect(p.discarded).toEqual([{ session: 'this-tab-1', sim: 2 }]);
    expect(p.table.input).toBe(false);
    expect(p.failures).toEqual([failure]);
    expect(p.overlay.phase).toBe('failed');
  });

  it('runs one retake however often "Play here" is pressed', async () => {
    const p = page();
    p.superseded();
    p.overlay.press();
    p.overlay.press();
    await p.simIsReady();
    p.overlay.press();
    await p.serverBoots();
    await p.tableLaid();
    expect(p.log.filter((step) => step === 'boot')).toHaveLength(1);
    expect(p.server.boots).toBe(1);
  });

  it('shows the overlay again when another tab takes the table back after a retake', async () => {
    const p = page();
    p.superseded();
    p.overlay.press();
    await p.simIsReady();
    await p.serverBoots();
    await p.tableLaid();
    p.superseded();
    expect(p.table.input).toBe(false);
    expect(p.overlay.phase).toBe('open');
  });
});

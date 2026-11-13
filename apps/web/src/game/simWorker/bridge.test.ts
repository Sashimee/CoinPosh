import { COIN_TIERS } from '@coinposh/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoinField, type CoinTierId } from '../../scene/coins/index.ts';
import { SIM_COIN_DIMENSIONS, SimBridge } from './bridge.ts';
import { FakeWorker, table } from './test/fake-worker.ts';
import { frameByteLength, FrameView } from './frame.ts';
import type { CoinTransformTarget } from './interpolate.ts';
import type { MainToWorker, SimEventBatch, TransportKind, WorkerToMain } from './protocol.ts';
import { MAX_CATCH_UP_TICKS, runSimWorker, TICK_MS } from './runtime.ts';
import { COIN, Sim, StateHasher } from '@coinposh/sim';
import { validateSnapshot } from '@coinposh/sim/snapshot';
import { economyConfig, openingHeap } from '@coinposh/economy';
import type {
  FallEvent,
  MechanicsConfig,
  OpeningHeap,
  RestoreEntry,
  SimInput,
  SimOptions,
  SimRestore,
  SimTableSnapshot,
} from './sim-api.ts';
import { OPENING_HEAP_CAPACITY, SIM_MECHANICS } from './table-config.ts';

const SEED = 0xc0195051;

interface Written {
  readonly positions: Float32Array;
  readonly quaternions: Float32Array;
  readonly ids: number[];
}

class RecordingTarget implements CoinTransformTarget {
  readonly written = new Map<CoinTierId, Written>();
  capacity(): number {
    return 512;
  }
  setTransforms(
    tier: CoinTierId,
    positions: ArrayLike<number>,
    quaternions: ArrayLike<number>,
    count: number,
    ids: ArrayLike<number>,
  ): void {
    this.written.set(tier, {
      positions: Float32Array.from(Array.from(positions).slice(0, count * 3)),
      quaternions: Float32Array.from(Array.from(quaternions).slice(0, count * 4)),
      ids: Array.from(ids).slice(0, count),
    });
  }
  ids(tier: CoinTierId): number[] {
    return this.written.get(tier)?.ids ?? [];
  }
}

/** setTimeout for the worker runtime on a virtual clock the test advances by hand. */
class ManualTimers {
  now = 0;
  #next = 1;
  readonly #timers = new Map<number, { at: number; callback: () => void }>();

  set = (callback: () => void, delayMs: number): number => {
    const id = this.#next;
    this.#next += 1;
    this.#timers.set(id, { at: this.now + delayMs, callback });
    return id;
  };

  clear = (handle: unknown): void => {
    this.#timers.delete(handle as number);
  };

  get pending(): number {
    return this.#timers.size;
  }

  advanceTo(time: number): void {
    for (;;) {
      let due: [number, { at: number; callback: () => void }] | undefined;
      for (const entry of this.#timers) {
        if (entry[1].at <= time && (!due || entry[1].at < due[1].at)) due = entry;
      }
      if (!due) break;
      this.#timers.delete(due[0]);
      this.now = Math.max(this.now, due[1].at);
      due[1].callback();
    }
    this.now = time;
  }
}

async function settle(): Promise<void> {
  // Each hop lets a MessagePort round trip land; setTimeout(0) would idle 1 ms per hop for nothing.
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

interface Harness {
  readonly bridge: SimBridge;
  readonly timers: ManualTimers;
  /** Advances the worker's clock by `ticks` sim ticks, one timer at a time, polling after each. */
  readonly run: (ticks: number) => Promise<void>;
  /** Delivers what the worker has published and lets the bridge collect it. */
  readonly poll: () => Promise<void>;
  /** Every coin at the bridge's newest frame, read through `sync` with the render point there. */
  readonly newest: () => RecordingTarget;
  /** The Sims the worker built, to read their state from the test. */
  readonly sims: readonly Sim[];
  readonly close: () => void;
}

const open: Harness[] = [];
afterEach(() => {
  for (const harness of open.splice(0)) harness.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface HarnessOptions {
  /** Runs the worker's Sim with these; SIM_MECHANICS is what sim.worker.ts uses. */
  readonly mechanics?: MechanicsConfig<string>;
  readonly openingHeap?: OpeningHeap;
  readonly restore?: SimRestore;
}

function simOptions(seed: number, options: HarnessOptions): SimOptions {
  return {
    seed,
    ...(options.mechanics ? { mechanics: options.mechanics } : {}),
    ...(options.openingHeap ? { openingHeap: options.openingHeap } : {}),
    ...(options.restore ? { restore: options.restore } : {}),
  };
}

/** A real Sim behind runSimWorker, talking to a SimBridge over a MessageChannel. */
function harness(transport: TransportKind, options: HarnessOptions = {}): Harness {
  if (transport === 'shared') vi.stubGlobal('crossOriginIsolated', true);
  const channel = new MessageChannel();
  const timers = new ManualTimers();
  let renderAhead = 0;
  const sims: Sim[] = [];
  runSimWorker(channel.port2, {
    createSim: async (hosted) => {
      const sim = await Sim.create(
        options.mechanics ? { ...hosted, mechanics: options.mechanics } : hosted,
      );
      sims.push(sim);
      return sim;
    },
    heapCapacity: Sim.heapCapacity(options.mechanics),
    now: () => timers.now,
    setTimer: timers.set,
    clearTimer: timers.clear,
  });
  const bridge = new SimBridge(channel.port1, {
    seed: SEED,
    transport,
    now: () => timers.now + renderAhead,
    ...(options.openingHeap ? { openingHeap: options.openingHeap } : {}),
    ...(options.restore ? { restore: options.restore } : {}),
  });
  const scratch = new RecordingTarget();
  const created: Harness = {
    bridge,
    timers,
    poll: async () => {
      await settle();
      bridge.sync(scratch);
    },
    run: async (ticks) => {
      for (let i = 0; i < ticks; i += 1) {
        // The nudge keeps float drift in the summed clock from leaving a tick boundary unreached.
        timers.advanceTo(timers.now + TICK_MS + 1e-6);
        await created.poll();
      }
    },
    newest: () => {
      renderAhead = 1e6;
      const target = new RecordingTarget();
      bridge.sync(target);
      return target;
    },
    sims,
    close: () => {
      bridge.dispose();
      channel.port1.close();
      channel.port2.close();
    },
  };
  open.push(created);
  return created;
}

it('lays every coin the economy opens the table with, at its tier', () => {
  expect(openingHeap.coins).toBeGreaterThan(0);
  expect(openingHeap.coins).toBeLessThanOrEqual(OPENING_HEAP_CAPACITY);
  expect(SIM_MECHANICS.tiers).toContain(openingHeap.tier);
});

it("fuses on the economy's Contact Fusion rules, with no tower", () => {
  expect(SIM_MECHANICS.tiers).toEqual(COIN_TIERS);
  expect(SIM_MECHANICS.fusion).toEqual({
    inputCount: economyConfig.fusion.inputCount,
    contactSeconds: economyConfig.fusion.contactSeconds,
  });
  expect(SIM_MECHANICS.tower).toBeNull();
});

describe.each(['transfer', 'shared'] as const)('SimBridge over the %s transport', (transport) => {
  it('runs the sim off-thread at 60 Hz and delivers every tick', async () => {
    const { bridge, run, poll } = harness(transport);
    expect(bridge.transport).toBe(transport);
    const info = await bridge.ready;
    expect(info.tick).toBe(0);
    expect(info.engine.substepTimestep * info.engine.substeps).toBeCloseTo(1 / 60, 6);
    await poll();
    await run(120);
    expect(bridge.stats.tick).toBe(120);
    expect(bridge.failure).toBeNull();
  });

  it('delivers poses bit for bit equal to the same inputs replayed on a Sim in-thread', async () => {
    const { bridge, run, poll, newest } = harness(transport);
    await bridge.ready;
    await poll();
    const log: { tick: number; inputs: SimInput[] }[] = [];
    for (let k = 0; k < 6; k += 1) {
      const xMm = k * 23 - 60;
      log.push({ tick: bridge.stats.tick, inputs: [{ kind: 'dropCoin', xMm }] });
      bridge.drop(xMm);
      await settle();
      await run(15);
    }
    await run(60);
    const finalTick = bridge.stats.tick;
    expect(finalTick).toBe(150);

    const direct = await Sim.create({ seed: SEED });
    try {
      while (direct.tick < finalTick) {
        direct.step(log.filter((entry) => entry.tick === direct.tick).flatMap((e) => e.inputs));
      }
      const expected = direct.coins();
      expect(expected).toHaveLength(6);
      const copper = newest().written.get('copper');
      expect(copper?.ids).toEqual(expected.map((coin) => coin.id));
      expected.forEach((coin, i) => {
        expect(copper?.positions[i * 3]).toBe(Math.fround(coin.translation.x));
        expect(copper?.positions[i * 3 + 1]).toBe(Math.fround(coin.translation.y));
        expect(copper?.positions[i * 3 + 2]).toBe(Math.fround(coin.translation.z));
        expect(copper?.quaternions[i * 4]).toBe(Math.fround(coin.rotation.x));
        expect(copper?.quaternions[i * 4 + 3]).toBe(Math.fround(coin.rotation.w));
      });
    } finally {
      direct.dispose();
    }
  });

  it('gives each dropped coin the tier its drop named', async () => {
    const { bridge, run, newest } = harness(transport);
    await bridge.ready;
    bridge.drop(-40, 'gold');
    bridge.drop(0);
    bridge.drop(40, 'heirloom');
    await settle();
    await run(3);
    const target = newest();
    expect(target.ids('gold')).toEqual([0]);
    expect(target.ids('copper')).toEqual([1]);
    expect(target.ids('heirloom')).toEqual([2]);
    bridge.setTier(1, 'diamond');
    bridge.sync(target);
    expect(target.ids('copper')).toEqual([]);
    expect(target.ids('diamond')).toEqual([1]);
  });

  it('draws sim tiers, nudges and pusher stroke exactly as the same log replayed in-thread', async () => {
    const { bridge, run, poll, newest } = harness(transport, { mechanics: SIM_MECHANICS });
    const info = await bridge.ready;
    expect(info.tiers).toEqual(COIN_TIERS);
    expect(info.heapCapacity).toBe(OPENING_HEAP_CAPACITY);
    expect(OPENING_HEAP_CAPACITY).toBeGreaterThan(100);
    await poll();
    const log: { tick: number; inputs: SimInput[] }[] = [];
    const send = async (input: SimInput, ticks: number): Promise<void> => {
      log.push({ tick: bridge.stats.tick, inputs: [input] });
      if (input.kind === 'nudge') bridge.nudge(input.direction);
      else if (input.kind === 'dropCoin')
        bridge.drop(input.xMm, (input.tier ?? 'copper') as CoinTierId);
      else throw new Error(`unexpected input kind in replay log: ${input.kind}`);
      await settle();
      await run(ticks);
    };
    await send({ kind: 'dropCoin', xMm: -40, tier: 'gold' }, 15);
    await send({ kind: 'dropCoin', xMm: 0, tier: 'copper' }, 15);
    await send({ kind: 'dropCoin', xMm: 40, tier: 'heirloom' }, 30);
    await send({ kind: 'nudge', direction: 'left' }, 20);
    await send({ kind: 'nudge', direction: 'forward' }, 20);
    const finalTick = bridge.stats.tick;
    expect(finalTick).toBe(100);

    const direct = await Sim.create(simOptions(SEED, { mechanics: SIM_MECHANICS }));
    try {
      while (direct.tick < finalTick) {
        direct.step(log.filter((entry) => entry.tick === direct.tick).flatMap((e) => e.inputs));
      }
      const target = newest();
      expect(direct.coins().map((coin) => [coin.id, coin.tier])).toEqual([
        [0, 'gold'],
        [1, 'copper'],
        [2, 'heirloom'],
      ]);
      for (const coin of direct.coins()) {
        const drawn = target.written.get(coin.tier as CoinTierId);
        const i = drawn?.ids.indexOf(coin.id) ?? -1;
        expect(i, `coin ${coin.id}`).toBeGreaterThanOrEqual(0);
        expect(drawn?.positions[i * 3]).toBe(Math.fround(coin.translation.x));
        expect(drawn?.positions[i * 3 + 2]).toBe(Math.fround(coin.translation.z));
      }
      expect(bridge.stats.pusherStroke).toBe(direct.pusher.extension);
      expect(bridge.stats.pusherPhase).toBe(direct.pusher.phase);
      expect(bridge.stats.pusherStroke).toBeGreaterThan(0);
    } finally {
      direct.dispose();
    }
  });

  it('catches up at most four ticks after a stall, then starts a new epoch', async () => {
    const { bridge, timers, run, poll } = harness(transport);
    await bridge.ready;
    await poll();
    await run(10);
    timers.now += 30 * TICK_MS;
    timers.advanceTo(timers.now);
    await poll();
    expect(bridge.stats.tick).toBe(10 + MAX_CATCH_UP_TICKS);
    await run(10);
    expect(bridge.stats.tick).toBe(20 + MAX_CATCH_UP_TICKS);
  });

  it('stops ticking while paused and resumes from the same tick', async () => {
    const { bridge, timers, run, poll } = harness(transport);
    await bridge.ready;
    await poll();
    await run(5);
    bridge.pause();
    await poll();
    expect(timers.pending).toBe(0);
    timers.advanceTo(timers.now + 5000);
    await poll();
    expect(bridge.stats.tick).toBe(5);
    bridge.resume();
    await poll();
    await run(5);
    expect(bridge.stats.tick).toBe(10);
  });
});

// Each test plays an opening heap for hundreds of ticks twice, through the worker and in-thread.
describe('SimBridge events', { timeout: 30_000 }, () => {
  interface Collected {
    falls: FallEvent[];
    contacts: SimEventBatch['contacts'][number][];
    fusions: SimEventBatch['fusions'][number][];
  }

  const collect = (bridge: SimBridge): Collected => {
    const all: Collected = { falls: [], contacts: [], fusions: [] };
    bridge.onEvents((batch) => {
      expect(batch.falls.length + batch.contacts.length + batch.fusions.length).toBeGreaterThan(0);
      all.falls.push(...batch.falls);
      all.contacts.push(...batch.contacts);
      all.fusions.push(...batch.fusions);
    });
    return all;
  };

  async function replay(options: HarnessOptions, inputs: Map<number, SimInput[]>, ticks: number) {
    const direct = await Sim.create(simOptions(SEED, options));
    const all: Collected = { falls: [], contacts: [], fusions: [] };
    try {
      while (direct.tick < ticks) {
        const events = direct.step(inputs.get(direct.tick) ?? []);
        all.falls.push(...events.falls);
        all.contacts.push(...events.contacts);
        for (const event of events.mechanics) {
          if (event.kind === 'fusion') all.fusions.push(event as Collected['fusions'][number]);
        }
      }
      return { all, coins: direct.coins() };
    } finally {
      direct.dispose();
    }
  }

  it('forwards the contacts and fusions of the drops, and draws fused coins in their new tier', async () => {
    const options: HarnessOptions = { mechanics: SIM_MECHANICS, openingHeap: { coins: 60 } };
    const { bridge, run, poll, newest } = harness('transfer', options);
    const all = collect(bridge);
    await bridge.ready;
    await poll();
    const inputs = new Map<number, SimInput[]>();
    for (const xMm of [0, 6, -6, 0, 6, -6]) {
      inputs.set(bridge.stats.tick, [{ kind: 'dropCoin', xMm, tier: 'copper' }]);
      bridge.drop(xMm, 'copper');
      await settle();
      await run(20);
    }
    await run(240);
    const expected = await replay(options, inputs, bridge.stats.tick);
    expect(all).toEqual(expected.all);
    expect(all.contacts.length).toBeGreaterThan(0);
    expect(all.fusions.length).toBeGreaterThan(0);
    const target = newest();
    for (const coin of expected.coins) {
      expect(target.ids(coin.tier as CoinTierId), `coin ${coin.id}`).toContain(coin.id);
    }
    const fused = expected.coins.filter((coin) => coin.tier === 'silver');
    expect(fused.length).toBeGreaterThan(0);
    expect(all.fusions.map((fusion) => fusion.fusedId)).toEqual(
      expect.arrayContaining(fused.map((coin) => coin.id)),
    );
  });

  it("forwards the falls and fusions of the Demo table's drops, with the worker's mechanics", async () => {
    const options: HarnessOptions = { mechanics: SIM_MECHANICS, openingHeap };
    const { bridge, run, poll } = harness('transfer', options);
    const all = collect(bridge);
    await bridge.ready;
    await poll();
    const inputs = new Map<number, SimInput[]>();
    for (let k = 0; k < 30; k += 1) {
      inputs.set(bridge.stats.tick, [{ kind: 'dropCoin', xMm: 0 }]);
      bridge.drop(0);
      await settle();
      await run(60);
    }
    const expected = await replay(options, inputs, bridge.stats.tick);
    expect(all).toEqual(expected.all);
    expect(all.fusions.length).toBeGreaterThan(0);
    expect(all.falls.length).toBeGreaterThan(0);
    expect(all.falls.every((fall) => fall.edge === 'front')).toBe(true);
  });
});

describe('SimBridge failures', () => {
  it('rejects an unknown nudge direction on the page', async () => {
    const { bridge } = harness('transfer');
    await bridge.ready;
    expect(() => {
      bridge.nudge('up' as never);
    }).toThrow(/left, right, forward, got up/);
  });

  it('stops the sim on a drop naming an unknown tier or an init with a bad opening heap', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { bridge } = harness('transfer');
    await bridge.ready;
    bridge.drop(0, 'tin' as CoinTierId);
    await settle();
    expect(bridge.failure?.message).toMatch(/rejected a message.*optional tier/);
    expect(errors).toHaveBeenCalledTimes(1);

    const created: number[] = [];
    const capacity = Sim.heapCapacity();
    const rejections: [number, RegExp][] = [
      [-1, /openingHeap\.coins must be a non-negative integer, got -1/],
      [
        capacity + 1,
        new RegExp(`openingHeap\\.coins must be at most ${capacity}.*got ${capacity + 1}`),
      ],
    ];
    for (const [coins, error] of rejections) {
      const channel = new MessageChannel();
      runSimWorker(channel.port2, {
        createSim: (hosted) => {
          created.push(hosted.seed);
          return Sim.create(hosted);
        },
        heapCapacity: capacity,
        now: () => 0,
        setTimer: () => 0,
        clearTimer: () => undefined,
      });
      const received: WorkerToMain[] = [];
      channel.port1.addEventListener('message', (event: MessageEvent<WorkerToMain>) => {
        received.push(event.data);
      });
      channel.port1.start();
      channel.port1.postMessage({
        type: 'init',
        seed: 1,
        capacity: 8,
        transport: { kind: 'transfer', buffers: [new ArrayBuffer(frameByteLength(8))] },
        openingHeap: { coins },
      } satisfies MainToWorker);
      await settle();
      expect(received).toEqual([
        { type: 'error', message: expect.stringMatching(error) as string },
      ]);
      channel.port1.close();
      channel.port2.close();
    }
    expect(created).toEqual([]);
  });

  it('rejects an out-of-range or fractional drop on the page, before the worker sees it', async () => {
    const { bridge } = harness('transfer');
    await bridge.ready;
    expect(() => {
      bridge.drop(151);
    }).toThrow(/±150/);
    expect(() => {
      bridge.drop(1.5);
    }).toThrow(RangeError);
  });

  it('surfaces a worker-side rejection as a failure and refuses further drops', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const channel = new MessageChannel();
    const timers = new ManualTimers();
    runSimWorker(channel.port2, {
      createSim: (hosted) => Sim.create(hosted),
      heapCapacity: Sim.heapCapacity(),
      now: () => timers.now,
      setTimer: timers.set,
      clearTimer: timers.clear,
    });
    const bridge = new SimBridge(channel.port1, {
      seed: SEED,
      transport: 'transfer',
    });
    try {
      await bridge.ready;
      channel.port1.postMessage({ type: 'input', inputs: [{ kind: 'dropCoin', xMm: 999 }] });
      await settle();
      expect(bridge.failure?.message).toMatch(/rejected a message.*xMm/);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(timers.pending).toBe(0);
      expect(() => {
        bridge.drop(0);
      }).toThrow(/rejected a message/);
    } finally {
      bridge.dispose();
      channel.port1.close();
      channel.port2.close();
    }
  });

  it('rejects ready when the sim cannot be created', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const channel = new MessageChannel();
    runSimWorker(channel.port2, {
      createSim: () => Promise.reject(new Error('WASM blocked')),
      heapCapacity: 0,
      now: () => 0,
      setTimer: () => 0,
      clearTimer: () => undefined,
    });
    const bridge = new SimBridge(channel.port1, {
      seed: 1,
      transport: 'transfer',
    });
    try {
      await expect(bridge.ready).rejects.toThrow(/WASM blocked/);
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  });

  it('refuses the shared transport on a page that is not cross-origin isolated', () => {
    const endpoint = new FakeWorker();
    expect(() => new SimBridge(endpoint, { seed: 1, transport: 'shared' })).toThrow(
      /cross-origin isolated/,
    );
    expect(new SimBridge(endpoint, { seed: 1 }).transport).toBe('transfer');
  });
});

describe('SimBridge on the render thread', () => {
  it('keeps the transfer ring flowing: every displaced frame goes back to the worker', () => {
    const worker = new FakeWorker();
    const bridge = new SimBridge(worker, { seed: 1, transport: 'transfer', capacity: 8 });
    const pool = worker.takeBuffers();
    expect(pool.length).toBeGreaterThan(6);
    for (let tick = 0; tick < 100; tick += 1) {
      pool.push(...worker.takeBuffers());
      const buffer = pool.pop();
      if (!buffer) throw new Error(`the ring ran dry at tick ${tick}`);
      new FrameView(buffer, 0, 8).write(tick, 0, table(3, tick));
      worker.emit('message', { type: 'frame', buffer });
    }
    expect(bridge.stats.frames).toBe(100);
    expect(bridge.stats.tick).toBe(99);
  });

  it('hands event batches to every listener until it unsubscribes', () => {
    const worker = new FakeWorker();
    const bridge = new SimBridge(worker, { seed: 1, transport: 'transfer' });
    const fall: FallEvent = { coinId: 4, edge: 'front', tick: 9 };
    const first: SimEventBatch[] = [];
    const second: SimEventBatch[] = [];
    const stop = bridge.onEvents((batch) => first.push(batch));
    bridge.onEvents((batch) => second.push(batch));
    worker.emit('message', { type: 'events', falls: [fall], contacts: [], fusions: [] });
    stop();
    worker.emit('message', { type: 'events', falls: [], contacts: [], fusions: [] });
    expect(first).toEqual([{ falls: [fall], contacts: [], fusions: [] }]);
    expect(second).toHaveLength(2);
  });

  it('reports a worker that fails to load', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const worker = new FakeWorker();
    const bridge = new SimBridge(worker, { seed: 1, transport: 'transfer' });
    worker.emit('error');
    await expect(bridge.ready).rejects.toThrow(/failed to load or crashed/);
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it('draws an over-full tier up to the coin field capacity and reports the overflow once', () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errors = vi.spyOn(console, 'error');
    let now = 0;
    const worker = new FakeWorker();
    const bridge = new SimBridge(worker, { seed: 1, transport: 'transfer', now: () => now });
    const field = new CoinField({
      capacity: { copper: 4, silver: 4, gold: 4, platinum: 4, diamond: 4, heirloom: 4 },
      radius: SIM_COIN_DIMENSIONS.radius,
    });
    bridge.setTier(9, 'gold');
    const pool = worker.takeBuffers();
    try {
      for (let tick = 0; tick < 20; tick += 1) {
        pool.push(...worker.takeBuffers());
        const buffer = pool.pop();
        if (!buffer) throw new Error(`the ring ran dry at tick ${tick}`);
        new FrameView(buffer, 0, bridge.capacity).write(tick, 0, table(10, tick));
        worker.emit('message', { type: 'frame', buffer });
        now = tick * TICK_MS + 40;
        expect(() => {
          bridge.sync(field);
        }).not.toThrow();
      }
      expect(field.count('copper')).toBe(4);
      expect(field.count('gold')).toBe(1);
      expect(bridge.stats.coins).toBe(10);
      expect(bridge.stats.overflowCoins).toBe(5);
      expect(bridge.failure).toBeNull();
      expect(warnings).toHaveBeenCalledTimes(1);
      expect(String(warnings.mock.calls[0]?.[0])).toMatch(/9 copper coins .* holds 4/);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      field.dispose();
    }
  });

  it('keeps drop tiers in step with coin ids when a tier is set before its coin arrives', () => {
    let now = 0;
    const worker = new FakeWorker();
    const bridge = new SimBridge(worker, { seed: 1, transport: 'transfer', now: () => now });
    const pool = worker.takeBuffers();
    let tick = 0;
    const publish = (count: number): void => {
      pool.push(...worker.takeBuffers());
      const buffer = pool.pop();
      if (!buffer) throw new Error(`the ring ran dry at tick ${tick}`);
      new FrameView(buffer, 0, bridge.capacity).write(tick, 0, table(count, tick));
      worker.emit('message', { type: 'frame', buffer });
      tick += 1;
    };
    bridge.drop(-40, 'gold');
    bridge.setTier(0, 'silver');
    publish(1);
    bridge.drop(0, 'copper');
    bridge.drop(40, 'heirloom');
    publish(3);
    now = 1e6;
    const target = new RecordingTarget();
    bridge.sync(target);
    expect(target.ids('silver')).toEqual([0]);
    expect(target.ids('gold')).toEqual([]);
    expect(target.ids('copper')).toEqual([1]);
    expect(target.ids('heirloom')).toEqual([2]);
  });

  it('keeps tiers set for coins that have not arrived yet when it prunes departed coins', () => {
    let now = 0;
    const worker = new FakeWorker();
    const bridge = new SimBridge(worker, { seed: 1, transport: 'transfer', now: () => now });
    const pool = worker.takeBuffers();
    let tick = 0;
    const publish = (count: number): void => {
      pool.push(...worker.takeBuffers());
      const buffer = pool.pop();
      if (!buffer) throw new Error(`the ring ran dry at tick ${tick}`);
      new FrameView(buffer, 0, bridge.capacity).write(tick, 0, table(count, tick));
      worker.emit('message', { type: 'frame', buffer });
      tick += 1;
    };
    for (let id = 0; id < 100; id += 1) bridge.setTier(id, id < 50 ? 'gold' : 'platinum');
    publish(1);
    publish(100);
    now = 1e6;
    const target = new RecordingTarget();
    bridge.sync(target);
    expect(target.ids('platinum')).toEqual(Array.from({ length: 50 }, (_, i) => 50 + i));
    expect(target.ids('copper')).toEqual([]);
  });

  it('exposes the sim coin dimensions for sizing the coin field', () => {
    expect(SIM_COIN_DIMENSIONS).toEqual({ radius: COIN.radius, halfThickness: COIN.halfThickness });
    expect(new SimBridge(new FakeWorker(), { seed: 1 }).coin).toBe(SIM_COIN_DIMENSIONS);
  });
});

/** The quantized table as one StateHasher digest: what the server would store, hashed. */
function hashTable(table: SimTableSnapshot): string {
  const hasher = new StateHasher().uint32(table.version).uint32(table.pusherTickInCycle);
  hasher.uint32(table.coins.length);
  for (const coin of table.coins) {
    hasher.int(coin.id).bool(coin.rest === 'asleep');
    for (const v of [...coin.p, ...coin.q]) hasher.int(v);
  }
  return hasher.digest();
}

/** Ticks the Demo table plays before it is saved: its heap, 6 s of drops, then 4 s idle. */
const SAVED_AFTER_TICKS = 600;

let savedTable: Promise<SimRestore> | null = null;

/**
 * The Demo table as a boot would restore it: the worker's heap after a stretch of play,
 * snapshotted mid-cycle and filtered by validateSnapshot as the server stores it, with the
 * first two heap coins sent back as bare heap slots (a heap coin without a valid pose, D4)
 * and every coin carrying the tier the server keeps for it.
 */
function saved(): Promise<SimRestore> {
  savedTable ??= (async () => {
    const sim = await Sim.create({ seed: SEED, mechanics: SIM_MECHANICS, openingHeap });
    try {
      while (sim.tick < SAVED_AFTER_TICKS) {
        const t = sim.tick;
        sim.step(t < 360 && t % 20 === 0 ? [{ kind: 'dropCoin', xMm: ((t * 7) % 61) - 30 }] : []);
      }
      const snapshot = sim.snapshot();
      const kept = new Set(validateSnapshot(snapshot).ok);
      const tierOf = new Map(sim.coins().map((coin) => [coin.id, coin.tier ?? undefined]));
      const coins: RestoreEntry[] = [];
      for (const pose of snapshot.coins) {
        const tier = tierOf.get(pose.id);
        if (tier === undefined) throw new Error(`coin ${pose.id} has no tier`);
        if (pose.id < 2) coins.push({ kind: 'heapSlot', slot: pose.id, tier });
        else if (kept.has(pose)) coins.push({ kind: 'pose', pose, tier });
      }
      return { pusherTickInCycle: snapshot.pusherTickInCycle, coins };
    } finally {
      sim.dispose();
    }
  })();
  return savedTable;
}

describe.each(['transfer', 'shared'] as const)(
  'SimBridge restore over the %s transport',
  { timeout: 30_000 },
  (transport) => {
    it('restores, steps and hashes exactly as Sim.create({ restore }) in-thread', async () => {
      const restore = await saved();
      expect(restore.pusherTickInCycle).toBeGreaterThan(0);
      expect(restore.coins.filter((entry) => entry.kind === 'pose').length).toBeGreaterThan(80);
      const options: HarnessOptions = { mechanics: SIM_MECHANICS, restore };
      const { bridge, run, poll, newest, sims } = harness(transport, options);
      const info = await bridge.ready;
      expect(info.tick).toBe(0);
      await poll();
      const direct = await Sim.create(simOptions(SEED, options));
      try {
        const worker = sims[0];
        if (!worker) throw new Error('the worker built no Sim');
        expect(worker.hash()).toBe(direct.hash());
        const opened = await bridge.snapshot();
        expect(opened).toEqual({ tick: 0, table: direct.snapshot() });

        const log = new Map<number, SimInput[]>();
        for (const xMm of [-30, 0, 30, 12]) {
          log.set(bridge.stats.tick, [{ kind: 'dropCoin', xMm, tier: 'copper' }]);
          bridge.drop(xMm, 'copper');
          await settle();
          await run(30);
        }
        await run(60);
        const { tick, table } = await bridge.snapshot();
        expect(tick).toBe(180);
        expect(tick).toBe(bridge.stats.tick);
        while (direct.tick < tick) direct.step(log.get(direct.tick) ?? []);

        expect(worker.hash()).toBe(direct.hash());
        expect(hashTable(table)).toBe(hashTable(direct.snapshot()));
        expect(table).toEqual(direct.snapshot());
        expect(table.coins.map((coin) => coin.id)).toEqual(direct.coins().map((coin) => coin.id));

        const target = newest();
        for (const coin of direct.coins()) {
          const drawn = target.written.get(coin.tier as CoinTierId);
          const i = drawn?.ids.indexOf(coin.id) ?? -1;
          expect(i, `coin ${coin.id}`).toBeGreaterThanOrEqual(0);
          expect(drawn?.positions[i * 3]).toBe(Math.fround(coin.translation.x));
          expect(drawn?.positions[i * 3 + 1]).toBe(Math.fround(coin.translation.y));
          expect(drawn?.positions[i * 3 + 2]).toBe(Math.fround(coin.translation.z));
          expect(drawn?.quaternions[i * 4 + 3]).toBe(Math.fround(coin.rotation.w));
        }
        expect(bridge.stats.pusherPhase).toBe(direct.pusher.phase);
      } finally {
        direct.dispose();
      }
    });

    it('answers a snapshot asked for before the sim is ready, and one asked for while paused', async () => {
      const { bridge, timers, run, poll } = harness(transport, { mechanics: SIM_MECHANICS });
      const both = await Promise.all([bridge.snapshot(), bridge.snapshot()]);
      expect(both[0]).toEqual({
        tick: 0,
        table: { version: 1, pusherTickInCycle: 0, coins: [] },
      });
      expect(both[1]).toEqual(both[0]);
      await poll();
      bridge.drop(0, 'gold');
      await settle();
      await run(10);
      bridge.pause();
      await poll();
      timers.advanceTo(timers.now + 5000);
      const paused = await bridge.snapshot();
      expect(paused.tick).toBe(10);
      expect(paused.table.pusherTickInCycle).toBe(10);
      expect(paused.table.coins.map((coin) => [coin.id, coin.rest])).toEqual([[0, 'awake']]);
    });
  },
);

describe('SimBridge restore of a table never saved', { timeout: 30_000 }, () => {
  it('lays every heap slot 0..n-1 exactly as the opening heap, then plays on identically', async () => {
    const heap = harness('transfer', { mechanics: SIM_MECHANICS, openingHeap });
    const coins: RestoreEntry[] = Array.from({ length: openingHeap.coins }, (_, slot) => ({
      kind: 'heapSlot',
      slot,
      tier: openingHeap.tier,
    }));
    const restored = harness('transfer', {
      mechanics: SIM_MECHANICS,
      restore: { pusherTickInCycle: 0, coins },
    });
    await Promise.all([heap.bridge.ready, restored.bridge.ready]);
    const [a, b] = await Promise.all([heap.bridge.snapshot(), restored.bridge.snapshot()]);
    expect(a.table.coins).toHaveLength(openingHeap.coins);
    expect(hashTable(b.table)).toBe(hashTable(a.table));
    for (const side of [heap, restored]) {
      side.bridge.drop(0, 'copper');
      await settle();
      await side.run(90);
    }
    expect(restored.sims[0]?.hash()).toBe(heap.sims[0]?.hash());
  });
});

describe('SimBridge restore failures', () => {
  it('refuses openingHeap and restore together on the page', () => {
    expect(
      () =>
        new SimBridge(new FakeWorker(), {
          seed: 1,
          openingHeap: { coins: 1 },
          restore: { pusherTickInCycle: 0, coins: [] },
        }),
    ).toThrow(/openingHeap and restore are mutually exclusive/);
  });

  /** A worker that never builds a Sim, and what it posts back after `messages`. */
  async function replies(messages: readonly unknown[]): Promise<WorkerToMain[]> {
    const channel = new MessageChannel();
    let created = 0;
    runSimWorker(channel.port2, {
      createSim: (hosted) => {
        created += 1;
        return Sim.create(hosted);
      },
      heapCapacity: Sim.heapCapacity(),
      now: () => 0,
      setTimer: () => 0,
      clearTimer: () => undefined,
    });
    const received: WorkerToMain[] = [];
    channel.port1.addEventListener('message', (event: MessageEvent<WorkerToMain>) => {
      received.push(event.data);
    });
    channel.port1.start();
    for (const message of messages) channel.port1.postMessage(message);
    await settle();
    channel.port1.close();
    channel.port2.close();
    expect(created).toBe(0);
    return received;
  }

  const init = (fields: Record<string, unknown>): Record<string, unknown> => ({
    type: 'init',
    seed: 1,
    capacity: 8,
    transport: { kind: 'transfer', buffers: [new ArrayBuffer(frameByteLength(8))] },
    ...fields,
  });

  it.each([
    [
      'with an opening heap',
      { openingHeap: { coins: 1 }, restore: { pusherTickInCycle: 0, coins: [] } },
      /init\.restore and init\.openingHeap are mutually exclusive/,
    ],
    [
      'with a heap slot the heap does not have',
      { restore: { pusherTickInCycle: 0, coins: [{ kind: 'heapSlot', slot: 999 }] } },
      new RegExp(`coins\\[0\\]\\.slot must be an integer in \\[0, ${Sim.heapCapacity()}\\)`),
    ],
    [
      'with a pose past the lip',
      {
        restore: {
          pusherTickInCycle: 0,
          coins: [
            {
              kind: 'pose',
              pose: { id: 0, p: [0, 0, 999_999], q: [0, 0, 0, 32767], rest: 'asleep' },
            },
          ],
        },
      },
      /coins\[0\] \(id 0\): out_of_bounds/,
    ],
  ])('stops the worker on a restore %s, before building a Sim', async (_, fields, error) => {
    expect(await replies([init(fields)])).toEqual([
      {
        type: 'error',
        message: expect.stringMatching(new RegExp(`rejected a message.*${error.source}`)) as string,
      },
    ]);
  });

  it.each([
    ['before init', { type: 'snapshot', requestId: 0 }, /snapshot was requested before init/],
    [
      'with a bad id',
      { type: 'snapshot', requestId: -1 },
      /requestId must be a non-negative integer, got -1/,
    ],
  ])('stops the worker on a snapshot request %s', async (_, message, error) => {
    expect(await replies([message])).toEqual([
      { type: 'error', message: expect.stringMatching(error) as string },
    ]);
  });

  it('rejects pending and later snapshots once the sim fails or the bridge is disposed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing = new FakeWorker();
    const bridge = new SimBridge(failing, { seed: 1, transport: 'transfer' });
    const pending = bridge.snapshot();
    expect(failing.sent.at(-1)?.message).toEqual({ type: 'snapshot', requestId: 0 });
    failing.emit('message', { type: 'error', message: 'Sim worker stopped: boom' });
    await expect(pending).rejects.toThrow(/SimBridge\.snapshot: .*boom/);
    await expect(bridge.snapshot()).rejects.toThrow(/SimBridge\.snapshot: .*boom/);

    const disposed = new SimBridge(new FakeWorker(), { seed: 1, transport: 'transfer' });
    const inFlight = disposed.snapshot();
    disposed.dispose();
    await expect(inFlight).rejects.toThrow(/disposed before the reply/);
    await expect(disposed.snapshot()).rejects.toThrow(/has been disposed/);
  });

  it('fails loudly on a snapshot reply nobody asked for', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const worker = new FakeWorker();
    const bridge = new SimBridge(worker, { seed: 1, transport: 'transfer' });
    worker.emit('message', {
      type: 'snapshot',
      requestId: 5,
      tick: 0,
      table: { version: 1, pusherTickInCycle: 0, coins: [] },
    });
    expect(bridge.failure?.message).toMatch(/snapshot request 5, which was never made/);
  });
});

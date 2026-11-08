import { afterEach, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera } from 'three/webgpu';
import { CoinField, type CoinTierId } from '../../scene/coins/index.ts';
import { SIM_COIN_DIMENSIONS, SimBridge, type BridgeEndpoint } from './bridge.ts';
import { FrameView, type CoinPose } from './frame.ts';
import type { CoinTransformTarget } from './interpolate.ts';
import type { MainToWorker, TransportKind, WorkerToMain } from './protocol.ts';
import { MAX_CATCH_UP_TICKS, runSimWorker, TICK_MS } from './runtime.ts';
import { COIN, Sim, type SimInput } from './sim-api.ts';

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
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
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
  readonly close: () => void;
}

const open: Harness[] = [];
afterEach(() => {
  for (const harness of open.splice(0)) harness.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A real Sim behind runSimWorker, talking to a SimBridge over a MessageChannel. */
function harness(transport: TransportKind): Harness {
  if (transport === 'shared') vi.stubGlobal('crossOriginIsolated', true);
  const channel = new MessageChannel();
  const timers = new ManualTimers();
  let renderAhead = 0;
  runSimWorker(channel.port2, {
    createSim: (seed) => Sim.create({ seed }),
    now: () => timers.now,
    setTimer: timers.set,
    clearTimer: timers.clear,
  });
  const bridge = new SimBridge(channel.port1, {
    seed: SEED,
    transport,
    now: () => timers.now + renderAhead,
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
    close: () => {
      bridge.dispose();
      channel.port1.close();
      channel.port2.close();
    },
  };
  open.push(created);
  return created;
}

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

describe('SimBridge failures', () => {
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
      createSim: (seed) => Sim.create({ seed }),
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

/** Stands in for the worker so a test can publish hand-made frames on its own schedule. */
class FakeWorker implements BridgeEndpoint {
  readonly sent: { message: MainToWorker; transfer: Transferable[] }[] = [];
  readonly #listeners = new Map<string, ((event: MessageEvent<WorkerToMain>) => void)[]>();

  postMessage(message: MainToWorker, transfer: Transferable[]): void {
    this.sent.push({ message, transfer });
  }

  addEventListener(type: string, listener: (event: MessageEvent<WorkerToMain>) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  emit(type: string, data?: WorkerToMain): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener({ type, data } as MessageEvent<WorkerToMain>);
    }
  }

  /** Buffers the bridge handed over in init plus everything it has recycled since. */
  takeBuffers(): ArrayBuffer[] {
    const buffers: ArrayBuffer[] = [];
    for (const { message } of this.sent.splice(0)) {
      if (message.type === 'init' && message.transport.kind === 'transfer') {
        buffers.push(...message.transport.buffers);
      }
      if (message.type === 'recycle') buffers.push(message.buffer);
    }
    return buffers;
  }
}

function table(count: number, tick: number): CoinPose[] {
  return Array.from({ length: count }, (_, i) => {
    const angle = tick * 0.002 + i;
    return {
      id: i,
      translation: {
        x: ((i % 25) - 12) * 0.028 + Math.sin(angle) * 0.0005,
        y: COIN.halfThickness + Math.floor(i / 125) * 2 * COIN.halfThickness,
        z: Math.floor((i % 125) / 25) * 0.028 + tick * 0.0001,
      },
      rotation: { x: 0, y: Math.sin(angle / 2), z: 0, w: Math.cos(angle / 2) },
    };
  });
}

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

  it('draws 250 coins at 120 Hz in well under 2 ms of render-thread time per frame', () => {
    let now = 0;
    const worker = new FakeWorker();
    const bridge = new SimBridge(worker, {
      seed: 1,
      transport: 'transfer',
      now: () => now,
    });
    const field = new CoinField({
      capacity: { copper: 256, silver: 128, gold: 64, platinum: 32, diamond: 16, heirloom: 8 },
      radius: SIM_COIN_DIMENSIONS.radius,
    });
    const camera = new PerspectiveCamera(40, 9 / 16, 0.05, 50);
    camera.position.set(0, 0.45, 0.55);
    camera.lookAt(0, 0, 0.05);
    camera.updateProjectionMatrix();
    const tiers: CoinTierId[] = [
      'copper',
      'copper',
      'copper',
      'copper',
      'copper',
      'silver',
      'gold',
      'platinum',
    ];
    for (let id = 0; id < 250; id += 1) bridge.setTier(id, tiers[id % tiers.length] ?? 'copper');

    const pool = worker.takeBuffers();
    let tick = 0;
    const publish = (): void => {
      pool.push(...worker.takeBuffers());
      const buffer = pool.pop();
      if (!buffer) throw new Error('ring ran dry');
      new FrameView(buffer, 0, bridge.capacity).write(tick, 0, table(250, tick));
      worker.emit('message', { type: 'frame', buffer });
      tick += 1;
    };

    const costs: number[] = [];
    const frameMs = 1000 / 120;
    try {
      for (let frame = 0; frame < 1200; frame += 1) {
        now = frame * frameMs;
        while (tick * TICK_MS + 3 <= now) publish();
        const start = performance.now();
        bridge.sync(field);
        field.update(camera, 1280);
        costs.push(performance.now() - start);
      }
    } finally {
      field.dispose();
    }
    expect(bridge.stats.coins).toBe(250);
    expect(
      (['copper', 'silver', 'gold', 'platinum'] as const).map((tier) => field.count(tier)),
    ).toEqual([157, 31, 31, 31]);
    const steady = costs.slice(240).sort((a, b) => a - b);
    const median = steady[Math.floor(steady.length / 2)] ?? Infinity;
    const p95 = steady[Math.floor(steady.length * 0.95)] ?? Infinity;
    console.info(
      `[simWorker] 250 coins, render thread per 120 Hz frame: median ${median.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms`,
    );
    expect(median).toBeLessThan(1);
    expect(p95).toBeLessThan(2);
  });
});

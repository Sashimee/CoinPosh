import { frameByteLength, FrameView, type CoinPose } from './frame.ts';
import type { MainToWorker, MessageEndpoint, TransportInit, WorkerToMain } from './protocol.ts';
import { SharedFrameRing } from './shared-ring.ts';
import { MAX_DROP_OFFSET_MM, TICK_RATE_HZ, type EngineInfo, type SimInput } from './sim-api.ts';

/** The slice of Sim the worker drives; the real Sim satisfies it. */
export interface HostedSim {
  readonly tick: number;
  readonly engine: EngineInfo;
  step(inputs: readonly SimInput[]): void;
  coins(): readonly CoinPose[];
  dispose(): void;
}

/** Everything the worker runtime takes from its environment, so tests can drive it by hand. */
export interface SimWorkerHost {
  createSim(seed: number): Promise<HostedSim>;
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}

export const TICK_MS = 1000 / TICK_RATE_HZ;

/**
 * Ticks the worker runs back to back to catch up after a stall (a GC pause, a slow step) before
 * it gives up on the lost time and starts a new epoch. Four ticks of 250 coins cost about the
 * same as one 60 Hz frame, so a catch-up never itself causes the next stall.
 */
export const MAX_CATCH_UP_TICKS = 4;

/**
 * A timer set for a tick boundary can fire a hair before it in floating point; without this
 * slack the tick would not count as due and the worker would spin on zero-delay timers.
 */
const DUE_TOLERANCE_MS = 0.05;

const NO_INPUTS: readonly SimInput[] = [];

interface FrameSink {
  publish(tick: number, epoch: number, coins: readonly CoinPose[]): void;
  recycle(buffer: ArrayBuffer): void;
}

type Endpoint = MessageEndpoint<MainToWorker, WorkerToMain>;

/**
 * The sim worker: owns one Sim, steps it on a fixed 60 Hz schedule against the worker's clock
 * and publishes every coin pose after each step through the transport the page chose. Inputs
 * arriving between ticks are applied, in arrival order, at the start of the next tick. The sim
 * itself never sees a clock; only this scheduler does.
 */
export function runSimWorker(endpoint: Endpoint, host: SimWorkerHost): void {
  let state: 'idle' | 'starting' | 'running' | 'failed' | 'disposed' = 'idle';
  let sim: HostedSim | null = null;
  let sink: FrameSink | null = null;
  let queue: SimInput[] = [];
  let paused = false;
  let epoch = 0;
  let epochMs = 0;
  let epochTick = 0;
  let timer: unknown = null;

  const post = (message: WorkerToMain, transfer: Transferable[] = []): void => {
    endpoint.postMessage(message, transfer);
  };

  const stopTimer = (): void => {
    if (timer !== null) host.clearTimer(timer);
    timer = null;
  };

  const fail = (error: unknown): void => {
    if (state === 'failed' || state === 'disposed') return;
    state = 'failed';
    stopTimer();
    sim?.dispose();
    sim = null;
    post({ type: 'error', message: `Sim worker stopped: ${describe(error)}` });
  };

  const publish = (): void => {
    if (sim && sink) sink.publish(sim.tick, epoch, sim.coins());
  };

  const schedule = (now: number): void => {
    if (!sim || paused || state !== 'running') return;
    const nextMs = epochMs + (sim.tick + 1 - epochTick) * TICK_MS;
    timer = host.setTimer(loop, Math.max(0, nextMs - now));
  };

  const rebase = (now: number, nextEpoch: number): void => {
    epoch = nextEpoch;
    epochMs = now;
    epochTick = sim?.tick ?? 0;
  };

  function loop(): void {
    timer = null;
    if (!sim || paused || state !== 'running') return;
    try {
      const now = host.now();
      const behind =
        epochTick + Math.floor((now - epochMs + DUE_TOLERANCE_MS) / TICK_MS) - sim.tick;
      if (behind > 0) {
        const ticks = Math.min(behind, MAX_CATCH_UP_TICKS);
        for (let k = 0; k < ticks; k += 1) {
          const inputs = k === 0 && queue.length > 0 ? queue : NO_INPUTS;
          if (inputs === queue) queue = [];
          sim.step(inputs);
        }
        if (behind > MAX_CATCH_UP_TICKS) rebase(now, epoch + 1);
        publish();
      }
      schedule(now);
    } catch (error) {
      fail(error);
    }
  }

  const start = (message: Extract<MainToWorker, { type: 'init' }>): void => {
    state = 'starting';
    const { seed, capacity, transport } = message;
    host.createSim(seed).then(
      (created) => {
        if (state !== 'starting') {
          created.dispose();
          return;
        }
        try {
          sim = created;
          sink = createSink(transport, capacity, post, publish);
          state = 'running';
          post({ type: 'ready', engine: created.engine, tick: created.tick });
          rebase(host.now(), 0);
          publish();
          schedule(host.now());
        } catch (error) {
          fail(error);
        }
      },
      (error: unknown) => {
        fail(error);
      },
    );
  };

  const handle = (message: MainToWorker): void => {
    switch (message.type) {
      case 'init':
        if (state !== 'idle') throw new Error('init was sent twice');
        assertInit(message);
        start(message);
        return;
      case 'input':
        assertInputs(message.inputs);
        if (state === 'idle' || state === 'starting' || state === 'running') {
          queue.push(...message.inputs);
        }
        return;
      case 'recycle':
        sink?.recycle(message.buffer);
        return;
      case 'pause':
        paused = true;
        stopTimer();
        return;
      case 'resume':
        if (!paused) return;
        paused = false;
        if (state === 'running') {
          rebase(host.now(), epoch + 1);
          schedule(host.now());
        }
        return;
      case 'dispose':
        stopTimer();
        state = 'disposed';
        sim?.dispose();
        sim = null;
        return;
      default:
        throw new TypeError(`unknown message ${JSON.stringify(message)}`);
    }
  };

  endpoint.addEventListener('message', (event) => {
    if (state === 'disposed') return;
    try {
      handle(event.data);
    } catch (error) {
      // A malformed message means the page and worker disagree; carrying on would desync them.
      fail(new Error(`rejected a message: ${describe(error)}`));
    }
  });
  endpoint.start?.();
}

function createSink(
  transport: TransportInit,
  capacity: number,
  post: (message: WorkerToMain, transfer: Transferable[]) => void,
  republish: () => void,
): FrameSink {
  if (transport.kind === 'shared') {
    const ring = new SharedFrameRing(transport.buffer, transport.slots, capacity);
    return {
      publish(tick, epoch, coins) {
        ring.publish(tick, epoch, coins);
      },
      recycle() {
        throw new Error('recycle is only valid on the transfer transport');
      },
    };
  }
  const bytes = frameByteLength(capacity);
  const pool: ArrayBuffer[] = [];
  let starved = false;
  const recycle = (buffer: ArrayBuffer): void => {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== bytes) {
      throw new TypeError(`recycled frame buffers must be ${bytes}-byte ArrayBuffers`);
    }
    pool.push(buffer);
    if (starved) {
      starved = false;
      republish();
    }
  };
  for (const buffer of transport.buffers) recycle(buffer);
  if (pool.length === 0) throw new RangeError('the transfer transport needs at least one buffer');
  return {
    publish(tick, epoch, coins) {
      const buffer = pool.pop();
      if (!buffer) {
        // Every buffer is on the render thread; the newest state goes out as soon as one returns.
        starved = true;
        return;
      }
      new FrameView(buffer, 0, capacity).write(tick, epoch, coins);
      post({ type: 'frame', buffer }, [buffer]);
    },
    recycle,
  };
}

function assertInit(message: Extract<MainToWorker, { type: 'init' }>): void {
  const { seed, capacity, transport } = message;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new RangeError(`init.seed must be a uint32, got ${seed}`);
  }
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError(`init.capacity must be a positive integer, got ${capacity}`);
  }
  const kind: string = transport.kind;
  if (kind !== 'shared' && kind !== 'transfer') {
    throw new TypeError(`init.transport.kind must be "shared" or "transfer", got ${kind}`);
  }
}

function assertInputs(inputs: unknown): asserts inputs is readonly SimInput[] {
  if (!Array.isArray(inputs)) throw new TypeError('input.inputs must be an array');
  for (const input of inputs as unknown[]) {
    const drop = input as Partial<Record<string, unknown>> | null;
    if (
      drop?.kind !== 'dropCoin' ||
      typeof drop.xMm !== 'number' ||
      !Number.isInteger(drop.xMm) ||
      Math.abs(drop.xMm) > MAX_DROP_OFFSET_MM
    ) {
      throw new RangeError(
        `inputs must be dropCoin with integer xMm in ±${MAX_DROP_OFFSET_MM}; got ${JSON.stringify(input)}`,
      );
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

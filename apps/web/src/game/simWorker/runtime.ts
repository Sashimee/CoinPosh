import { COIN_TIERS, type CoinTier } from '@coinposh/shared';
import { frameByteLength, FrameView, type CoinPose, type FramePusher } from './frame.ts';
import type {
  MainToWorker,
  MessageEndpoint,
  SimEventBatch,
  TransportInit,
  WorkerToMain,
} from './protocol.ts';
import { SharedFrameRing } from './shared-ring.ts';
import {
  MAX_DROP_OFFSET_MM,
  NUDGE_DIRECTIONS,
  TICK_RATE_HZ,
  type ContactEvent,
  type EngineInfo,
  type FallEvent,
  type FusionEvent,
  type OpeningHeap,
  type SimEvents,
  type SimInput,
} from './sim-api.ts';

/** The slice of Sim the worker drives; the real Sim satisfies it. */
export interface HostedSim {
  readonly tick: number;
  readonly engine: EngineInfo;
  /** The tier ladder the sim fuses along, or null when its coins carry no tier. */
  readonly tiers: readonly string[] | null;
  readonly pusher: FramePusher;
  step(inputs: readonly SimInput[]): SimEvents;
  coins(): readonly CoinPose[];
  dispose(): void;
}

export interface HostedSimOptions {
  readonly seed: number;
  readonly openingHeap?: OpeningHeap;
}

/** Everything the worker runtime takes from its environment, so tests can drive it by hand. */
export interface SimWorkerHost {
  createSim(options: HostedSimOptions): Promise<HostedSim>;
  /** The most coins an init's `openingHeap` may ask createSim for (Sim.heapCapacity). */
  readonly heapCapacity: number;
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
  publish(tick: number, epoch: number, coins: readonly CoinPose[], pusher: FramePusher): void;
  recycle(buffer: ArrayBuffer): void;
}

type Endpoint = MessageEndpoint<MainToWorker, WorkerToMain>;

/**
 * The sim worker: owns one Sim, steps it on a fixed 60 Hz schedule against the worker's clock
 * and publishes every coin pose after each step through the transport the page chose, followed by
 * an `events` message with the falls, contacts and fusions of the ticks just run, when there
 * were any. Inputs arriving between ticks are applied, in arrival order, at the start of the next
 * tick. The sim itself never sees a clock; only this scheduler does.
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
    if (sim && sink) sink.publish(sim.tick, epoch, sim.coins(), sim.pusher);
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
        const batch = new EventCollector();
        for (let k = 0; k < ticks; k += 1) {
          const inputs = k === 0 && queue.length > 0 ? forSim(queue, sim) : NO_INPUTS;
          if (k === 0) queue = [];
          batch.add(sim.step(inputs));
        }
        if (behind > MAX_CATCH_UP_TICKS) rebase(now, epoch + 1);
        publish();
        if (!batch.empty) post({ type: 'events', ...batch.take() });
      }
      schedule(now);
    } catch (error) {
      fail(error);
    }
  }

  const start = (message: Extract<MainToWorker, { type: 'init' }>): void => {
    state = 'starting';
    const { seed, capacity, transport, openingHeap } = message;
    host.createSim(openingHeap ? { seed, openingHeap } : { seed }).then(
      (created) => {
        if (state !== 'starting') {
          created.dispose();
          return;
        }
        try {
          sim = created;
          sink = createSink(transport, capacity, post, publish);
          state = 'running';
          post({
            type: 'ready',
            engine: created.engine,
            tick: created.tick,
            tiers: created.tiers,
            heapCapacity: host.heapCapacity,
          });
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
        assertInit(message, host.heapCapacity);
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
      publish(tick, epoch, coins, pusher) {
        ring.publish(tick, epoch, coins, pusher);
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
    publish(tick, epoch, coins, pusher) {
      const buffer = pool.pop();
      if (!buffer) {
        // Every buffer is on the render thread; the newest state goes out as soon as one returns.
        starved = true;
        return;
      }
      new FrameView(buffer, 0, capacity).write(tick, epoch, coins, pusher);
      post({ type: 'frame', buffer }, [buffer]);
    },
    recycle,
  };
}

/** Gathers the events of the ticks one loop pass runs, for a single `events` message. */
class EventCollector {
  #falls: FallEvent[] = [];
  #contacts: ContactEvent[] = [];
  #fusions: FusionEvent<CoinTier>[] = [];

  get empty(): boolean {
    return this.#falls.length + this.#contacts.length + this.#fusions.length === 0;
  }

  add(events: SimEvents): void {
    this.#falls.push(...events.falls);
    this.#contacts.push(...events.contacts);
    for (const event of events.mechanics) {
      if (event.kind !== 'fusion') continue;
      if (!isCoinTier(event.tier) || !isCoinTier(event.into)) {
        throw new RangeError(
          `the sim fused ${event.tier} into ${event.into}; tiers must be one of ${COIN_TIERS.join(', ')}`,
        );
      }
      this.#fusions.push({ ...event, tier: event.tier, into: event.into });
    }
  }

  take(): SimEventBatch {
    return { falls: this.#falls, contacts: this.#contacts, fusions: this.#fusions };
  }
}

/**
 * A sim without tiers rejects a drop that names one; the page names a tier on every drop, so
 * for such a sim the tier stays a render-side look and is not passed on.
 */
function forSim(inputs: readonly SimInput[], sim: HostedSim): readonly SimInput[] {
  if (sim.tiers !== null) return inputs;
  return inputs.map((input) =>
    input.kind === 'dropCoin' && input.tier !== undefined
      ? { kind: 'dropCoin', xMm: input.xMm }
      : input,
  );
}

function isCoinTier(tier: string): tier is CoinTier {
  return (COIN_TIERS as readonly string[]).includes(tier);
}

function assertInit(message: Extract<MainToWorker, { type: 'init' }>, heapCapacity: number): void {
  const { seed, capacity, transport, openingHeap } = message;
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
  if (openingHeap === undefined) return;
  const heap = openingHeap as unknown as Partial<Record<string, unknown>> | null;
  const coins = heap?.coins;
  const tier = heap?.tier;
  if (typeof coins !== 'number' || !Number.isInteger(coins) || coins < 0) {
    throw new RangeError(
      `init.openingHeap.coins must be a non-negative integer, got ${JSON.stringify(coins)}`,
    );
  }
  if (coins > heapCapacity) {
    throw new RangeError(
      `init.openingHeap.coins must be at most ${heapCapacity} (OPENING_HEAP_CAPACITY), got ${coins}`,
    );
  }
  if (tier !== undefined && (typeof tier !== 'string' || !isCoinTier(tier))) {
    throw new RangeError(
      `init.openingHeap.tier must be one of ${COIN_TIERS.join(', ')}, got ${JSON.stringify(tier)}`,
    );
  }
}

function assertInputs(inputs: unknown): asserts inputs is readonly SimInput[] {
  if (!Array.isArray(inputs)) throw new TypeError('input.inputs must be an array');
  for (const input of inputs as unknown[]) {
    const fields = input as Partial<Record<string, unknown>> | null;
    if (fields?.kind === 'nudge') {
      if (!(NUDGE_DIRECTIONS as readonly unknown[]).includes(fields.direction)) {
        throw new RangeError(
          `a nudge direction must be one of ${NUDGE_DIRECTIONS.join(', ')}; got ${JSON.stringify(input)}`,
        );
      }
      continue;
    }
    if (
      fields?.kind !== 'dropCoin' ||
      typeof fields.xMm !== 'number' ||
      !Number.isInteger(fields.xMm) ||
      Math.abs(fields.xMm) > MAX_DROP_OFFSET_MM ||
      (fields.tier !== undefined && (typeof fields.tier !== 'string' || !isCoinTier(fields.tier)))
    ) {
      throw new RangeError(
        `inputs must be nudge, or dropCoin with integer xMm in ±${MAX_DROP_OFFSET_MM} and an optional tier from ${COIN_TIERS.join(', ')}; got ${JSON.stringify(input)}`,
      );
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

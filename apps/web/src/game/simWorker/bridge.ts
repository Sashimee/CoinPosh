import type { CoinTierId } from '../../scene/coins/index.ts';
import { RenderClock } from './clock.ts';
import { frameByteLength, FrameView } from './frame.ts';
import { FrameBlender, type CoinTransformTarget } from './interpolate.ts';
import type { MainToWorker, MessageEndpoint, TransportKind, WorkerToMain } from './protocol.ts';
import { TICK_MS } from './runtime.ts';
import { SharedFrameRing } from './shared-ring.ts';
import { COIN, MAX_DROP_OFFSET_MM, type EngineInfo, type SimInput } from './sim-api.ts';

/** The sim's coin, in metres, for sizing the coin field and anything placed against coins. */
export const SIM_COIN_DIMENSIONS = {
  radius: COIN.radius,
  halfThickness: COIN.halfThickness,
} as const;

/** One coin more than the sum of CoinField's tier capacities in main.ts, rounded up. */
export const DEFAULT_FRAME_CAPACITY = 512;

/**
 * Frames the render thread keeps to interpolate in. The render point trails the newest frame
 * by at most RenderClock's four-tick delay ceiling, so six always holds the pair around it.
 */
const HISTORY = 6;
/** Transfer buffers: the history, plus one being written in the worker and two in flight. */
const TRANSFER_BUFFERS = HISTORY + 3;
/** Shared slots: enough that a render thread stalled for five ticks still finds whole frames. */
const SHARED_SLOTS = 8;

export interface SimBridgeOptions {
  /** uint32 seed handed to Sim.create. */
  readonly seed: number;
  /** Most coins one frame carries. Exceeding it stops the sim with an error naming this option. */
  readonly capacity?: number;
  /**
   * `auto` (the default) uses SharedArrayBuffer when the page is cross-origin isolated and the
   * transferable ring otherwise, as on GitHub Pages.
   */
  readonly transport?: TransportKind | 'auto';
  /** Look for coins whose drop named no tier. */
  readonly defaultTier?: CoinTierId;
  /** Render-thread clock in ms; defaults to performance.now. */
  readonly now?: () => number;
}

export interface SimReadyInfo {
  readonly engine: EngineInfo;
  readonly tick: number;
}

export interface SimBridgeStats {
  readonly transport: TransportKind;
  /** Newest sim tick received. */
  readonly tick: number;
  /** Fractional tick drawn by the last `sync`. */
  readonly renderTick: number;
  readonly delayTicks: number;
  readonly frames: number;
  readonly coins: number;
  /** Render-thread time the last `sync` took, in ms. */
  readonly syncMs: number;
  readonly snaps: number;
  /** Coins the last `sync` left undrawn because their tier was over the target's capacity. */
  readonly overflowCoins: number;
}

type MutableStats = { -readonly [K in keyof SimBridgeStats]: SimBridgeStats[K] };

export type BridgeEndpoint = MessageEndpoint<WorkerToMain, MainToWorker> & {
  addEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
};

export function isCrossOriginIsolated(): boolean {
  const scope = globalThis as { crossOriginIsolated?: boolean };
  return scope.crossOriginIsolated === true && typeof SharedArrayBuffer === 'function';
}

/**
 * The render thread's side of the sim worker. Send player inputs with `drop`, then call
 * `sync(stage.coins)` once per animation frame: it collects the frames the worker has published,
 * places the render point on the sim timeline (see RenderClock) and writes every coin, blended
 * between the two sim frames around that point, into the coin field by tier. A coin's tier only
 * picks its look; what a coin is worth only ever comes from the server.
 */
export class SimBridge {
  readonly transport: TransportKind;
  readonly coin = SIM_COIN_DIMENSIONS;
  readonly capacity: number;
  /** Resolves once the worker's Sim exists; rejects if the worker fails first. */
  readonly ready: Promise<SimReadyInfo>;
  readonly #endpoint: BridgeEndpoint;
  readonly #now: () => number;
  readonly #clock = new RenderClock({ tickMs: TICK_MS });
  readonly #blender = new FrameBlender();
  readonly #history: FrameView[] = [];
  readonly #spare: FrameView[] = [];
  readonly #ring: SharedFrameRing | null;
  readonly #defaultTier: CoinTierId;
  readonly #tiers = new Map<number, CoinTierId>();
  readonly #pendingTiers: CoinTierId[] = [];
  readonly #overflowReported = new Set<CoinTierId>();
  readonly #onOverflow = (tier: CoinTierId, count: number, capacity: number): void => {
    if (this.#overflowReported.has(tier)) return;
    this.#overflowReported.add(tier);
    console.warn(
      `CoinPosh sim: ${count} ${tier} coins are on the table but the coin field holds ${capacity}; the newest are not drawn. Raise CoinField's ${tier} capacity.`,
    );
  };
  readonly #stats: MutableStats;
  readonly #tierOf = (id: number): CoinTierId => this.#tiers.get(id) ?? this.#defaultTier;
  #highestId = -1;
  #sharedSeen = 0;
  #failure: Error | null = null;
  #disposed = false;
  #settleReady: ((info: SimReadyInfo) => void) | null = null;
  #rejectReady: ((error: Error) => void) | null = null;
  readonly #onDispose: (() => void) | undefined;

  /** `onDispose` runs after the dispose message is posted, for the owner to end the worker. */
  constructor(endpoint: BridgeEndpoint, options: SimBridgeOptions, onDispose?: () => void) {
    this.#endpoint = endpoint;
    this.#onDispose = onDispose;
    this.#now = options.now ?? (() => performance.now());
    this.#defaultTier = options.defaultTier ?? 'copper';
    this.capacity = options.capacity ?? DEFAULT_FRAME_CAPACITY;
    frameByteLength(this.capacity);
    const requested = options.transport ?? 'auto';
    if (requested === 'shared' && !isCrossOriginIsolated()) {
      throw new Error(
        'SimBridge: the shared transport needs a cross-origin isolated page (COOP same-origin + COEP require-corp); use transport "auto" or "transfer"',
      );
    }
    this.transport =
      requested === 'auto' ? (isCrossOriginIsolated() ? 'shared' : 'transfer') : requested;
    this.#stats = {
      transport: this.transport,
      tick: 0,
      renderTick: 0,
      delayTicks: this.#clock.delayTicks,
      frames: 0,
      coins: 0,
      syncMs: 0,
      snaps: 0,
      overflowCoins: 0,
    };
    this.ready = new Promise<SimReadyInfo>((resolve, reject) => {
      this.#settleReady = resolve;
      this.#rejectReady = reject;
    });
    // The failure is also logged and kept in `failure`; this only stops an unawaited `ready`
    // from surfacing as an unhandled rejection.
    this.ready.catch(() => undefined);

    endpoint.addEventListener('message', (event) => {
      this.#receive(event.data);
    });
    endpoint.addEventListener('error', (event) => {
      this.#fail(`the sim worker failed to load or crashed (${describeEvent(event)})`);
    });
    endpoint.addEventListener('messageerror', () => {
      this.#fail('a sim worker message could not be deserialised');
    });
    endpoint.start?.();

    for (let i = 0; i <= HISTORY; i += 1) this.#spare.push(FrameView.allocate(this.capacity));
    if (this.transport === 'shared') {
      this.#ring = SharedFrameRing.create(SHARED_SLOTS, this.capacity);
      this.#post({
        type: 'init',
        seed: options.seed,
        capacity: this.capacity,
        transport: { kind: 'shared', buffer: this.#ring.buffer, slots: SHARED_SLOTS },
      });
    } else {
      this.#ring = null;
      const buffers = Array.from(
        { length: TRANSFER_BUFFERS },
        () => new ArrayBuffer(frameByteLength(this.capacity)),
      );
      this.#post(
        {
          type: 'init',
          seed: options.seed,
          capacity: this.capacity,
          transport: { kind: 'transfer', buffers },
        },
        buffers,
      );
    }
  }

  /** The error that stopped the sim, or null while it runs. */
  get failure(): Error | null {
    return this.#failure;
  }

  get stats(): SimBridgeStats {
    return this.#stats;
  }

  /**
   * Drops a coin `xMm` millimetres from the table centre line at the start of the next sim
   * tick. `tier` picks the look of the coin this drop creates.
   */
  drop(xMm: number, tier: CoinTierId = this.#defaultTier): void {
    if (!Number.isInteger(xMm) || Math.abs(xMm) > MAX_DROP_OFFSET_MM) {
      throw new RangeError(
        `SimBridge.drop: xMm must be an integer in ±${MAX_DROP_OFFSET_MM}, got ${xMm}`,
      );
    }
    this.#assertRunning('drop');
    const input: SimInput = { kind: 'dropCoin', xMm };
    this.#pendingTiers.push(tier);
    this.#post({ type: 'input', inputs: [input] });
  }

  /** Changes the look of a coin already on the table. */
  setTier(id: number, tier: CoinTierId): void {
    this.#tiers.set(id, tier);
  }

  /** Writes the interpolated coins into `target`; does nothing until the first frame arrives. */
  sync(target: CoinTransformTarget): void {
    if (this.#disposed) return;
    const start = this.#now();
    if (this.#ring) this.#pollShared(start);
    const history = this.#history;
    const renderTick = this.#clock.renderTick(start);
    const first = history[0];
    if (renderTick === null || !first) return;

    let from = first;
    let to = first;
    for (const frame of history) {
      to = frame;
      if (frame.tick > renderTick) break;
      from = frame;
    }
    const alpha = to === from ? 1 : (renderTick - from.tick) / (to.tick - from.tick);
    this.#blender.blend(from, to, alpha, this.#tierOf);
    const overflow = this.#blender.writeTo(target, this.#onOverflow);

    const stats = this.#stats;
    stats.renderTick = renderTick;
    stats.delayTicks = this.#clock.delayTicks;
    stats.snaps = this.#clock.snaps;
    stats.coins = to.count;
    stats.overflowCoins = overflow;
    stats.syncMs = this.#now() - start;
  }

  /** Stops ticking, as when the page is hidden; `resume` carries on from the same tick. */
  pause(): void {
    if (!this.#failure && !this.#disposed) this.#post({ type: 'pause' });
  }

  resume(): void {
    if (!this.#failure && !this.#disposed) this.#post({ type: 'resume' });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#post({ type: 'dispose' });
    this.#rejectReady?.(new Error('SimBridge was disposed before the sim was ready'));
    this.#settleReady = null;
    this.#rejectReady = null;
    this.#onDispose?.();
  }

  #receive(message: WorkerToMain): void {
    if (this.#disposed) return;
    switch (message.type) {
      case 'ready':
        this.#settleReady?.({ engine: message.engine, tick: message.tick });
        this.#settleReady = null;
        this.#rejectReady = null;
        return;
      case 'frame':
        this.#acceptTransferred(message.buffer);
        return;
      case 'error':
        this.#fail(message.message);
        return;
    }
  }

  #acceptTransferred(buffer: ArrayBuffer): void {
    const frame = new FrameView(buffer, 0, this.capacity);
    const displaced = this.#accept(frame, this.#now());
    for (const old of displaced) {
      const recycled = old.buffer as ArrayBuffer;
      this.#post({ type: 'recycle', buffer: recycled }, [recycled]);
    }
  }

  #pollShared(now: number): void {
    const ring = this.#ring;
    if (!ring) return;
    const latest = ring.latest();
    for (let seq = Math.max(this.#sharedSeen + 1, latest - HISTORY + 1); seq <= latest; seq += 1) {
      const frame = this.#spare.pop() ?? FrameView.allocate(this.capacity);
      if (!ring.readInto(seq, frame)) {
        this.#spare.push(frame);
        continue;
      }
      for (const old of this.#accept(frame, now)) this.#spare.push(old);
    }
    this.#sharedSeen = Math.max(this.#sharedSeen, latest);
  }

  /** Adds `frame` to the history and returns the frames it pushed out, for reuse. */
  #accept(frame: FrameView, now: number): FrameView[] {
    const history = this.#history;
    const newest = history[history.length - 1];
    if (newest && frame.tick < newest.tick) return [frame];
    const displaced: FrameView[] = [];
    if (newest?.tick === frame.tick) {
      history.pop();
      displaced.push(newest);
    }
    history.push(frame);
    while (history.length > HISTORY) {
      const old = history.shift();
      if (old) displaced.push(old);
    }
    this.#clock.observe(frame.tick, frame.epoch, now);
    this.#assignTiers(frame);
    this.#stats.tick = frame.tick;
    this.#stats.frames += 1;
    return displaced;
  }

  /**
   * Coin ids grow with every coin the sim creates, and each drop creates exactly one, so coins
   * newer than any seen before take the queued drop tiers in order.
   */
  #assignTiers(frame: FrameView): void {
    const { ids } = frame;
    const count = frame.count;
    for (let i = 0; i < count; i += 1) {
      const id = ids[i] ?? 0;
      if (id <= this.#highestId) continue;
      this.#highestId = id;
      if (!this.#tiers.has(id))
        this.#tiers.set(id, this.#pendingTiers.shift() ?? this.#defaultTier);
    }
    if (this.#tiers.size > count * 2 + 64) {
      const live = new Set(ids.subarray(0, count));
      for (const id of this.#tiers.keys()) if (!live.has(id)) this.#tiers.delete(id);
    }
  }

  #fail(reason: string): void {
    if (this.#failure || this.#disposed) return;
    this.#failure = new Error(`CoinPosh sim: ${reason}`);
    console.error(this.#failure);
    this.#rejectReady?.(this.#failure);
    this.#settleReady = null;
    this.#rejectReady = null;
  }

  #assertRunning(action: string): void {
    if (this.#disposed) throw new Error(`SimBridge.${action}: the bridge has been disposed`);
    if (this.#failure) throw new Error(`SimBridge.${action}: ${this.#failure.message}`);
  }

  #post(message: MainToWorker, transfer: Transferable[] = []): void {
    this.#endpoint.postMessage(message, transfer);
  }
}

/**
 * Starts the sim in a module Web Worker and returns its bridge. The sim pauses while the page
 * is hidden, so a backgrounded tab neither burns battery nor returns to a burst of catch-up.
 */
export function createSimBridge(options: SimBridgeOptions): SimBridge {
  const worker = new Worker(new URL('./sim.worker.ts', import.meta.url), {
    type: 'module',
    name: 'coinposh-sim',
  });
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') bridge.pause();
    else bridge.resume();
  };
  const bridge = new SimBridge(worker, options, () => {
    document.removeEventListener('visibilitychange', onVisibility);
    worker.terminate();
  });
  document.addEventListener('visibilitychange', onVisibility);
  onVisibility();
  return bridge;
}

function describeEvent(event: Event): string {
  const message = (event as Partial<ErrorEvent>).message;
  return typeof message === 'string' && message !== '' ? message : event.type;
}

import type { CoinTier } from '@coinposh/shared';
import type {
  ContactEvent,
  EngineInfo,
  FallEvent,
  FusionEvent,
  OpeningHeap,
  SimInput,
} from './sim-api.ts';

export type TransportKind = 'shared' | 'transfer';

export type TransportInit =
  | { readonly kind: 'shared'; readonly buffer: SharedArrayBuffer; readonly slots: number }
  | { readonly kind: 'transfer'; readonly buffers: readonly ArrayBuffer[] };

/** What the sim reported over one or more ticks, each event stamped with its own tick. */
export interface SimEventBatch {
  /** Coins that left the table, in tick then id order. */
  readonly falls: readonly FallEvent[];
  /** Coins that struck something hard enough to hear, in tick then id order. */
  readonly contacts: readonly ContactEvent[];
  /** Coins merged into the next tier, in tick order. */
  readonly fusions: readonly FusionEvent<CoinTier>[];
}

export type MainToWorker =
  | {
      readonly type: 'init';
      readonly seed: number;
      readonly capacity: number;
      readonly transport: TransportInit;
      /** Coins laid at the brink of the lip before the first tick. */
      readonly openingHeap?: OpeningHeap;
    }
  | { readonly type: 'input'; readonly inputs: readonly SimInput[] }
  | { readonly type: 'recycle'; readonly buffer: ArrayBuffer }
  | { readonly type: 'pause' }
  | { readonly type: 'resume' }
  | { readonly type: 'dispose' };

export type WorkerToMain =
  | {
      readonly type: 'ready';
      readonly engine: EngineInfo;
      readonly tick: number;
      /** The sim's tier ladder; null when it tracks no tiers and the page picks the looks. */
      readonly tiers: readonly string[] | null;
      /** The most coins an init's `openingHeap` may ask for. */
      readonly heapCapacity: number;
    }
  | { readonly type: 'frame'; readonly buffer: ArrayBuffer }
  | ({ readonly type: 'events' } & SimEventBatch)
  | { readonly type: 'error'; readonly message: string };

/** The part of a Worker, a worker's global scope or a MessagePort that the bridge uses. */
export interface MessageEndpoint<In, Out> {
  postMessage(message: Out, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<In>) => void): void;
  start?(): void;
}

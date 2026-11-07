import type { EngineInfo, SimInput } from './sim-api.ts';

export type TransportKind = 'shared' | 'transfer';

export type TransportInit =
  | { readonly kind: 'shared'; readonly buffer: SharedArrayBuffer; readonly slots: number }
  | { readonly kind: 'transfer'; readonly buffers: readonly ArrayBuffer[] };

export type MainToWorker =
  | {
      readonly type: 'init';
      readonly seed: number;
      readonly capacity: number;
      readonly transport: TransportInit;
    }
  | { readonly type: 'input'; readonly inputs: readonly SimInput[] }
  | { readonly type: 'recycle'; readonly buffer: ArrayBuffer }
  | { readonly type: 'pause' }
  | { readonly type: 'resume' }
  | { readonly type: 'dispose' };

export type WorkerToMain =
  | { readonly type: 'ready'; readonly engine: EngineInfo; readonly tick: number }
  | { readonly type: 'frame'; readonly buffer: ArrayBuffer }
  | { readonly type: 'error'; readonly message: string };

/** The part of a Worker, a worker's global scope or a MessagePort that the bridge uses. */
export interface MessageEndpoint<In, Out> {
  postMessage(message: Out, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<In>) => void): void;
  start?(): void;
}

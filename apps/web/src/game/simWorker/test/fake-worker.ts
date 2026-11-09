import { COIN } from '@coinposh/sim';
import type { BridgeEndpoint } from '../bridge.ts';
import type { CoinPose } from '../frame.ts';
import type { MainToWorker, WorkerToMain } from '../protocol.ts';

/** Stands in for the worker so a test can publish hand-made frames on its own schedule. */
export class FakeWorker implements BridgeEndpoint {
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

export function table(count: number, tick: number): CoinPose[] {
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

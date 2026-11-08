import type { MainToWorker, MessageEndpoint, WorkerToMain } from './protocol.ts';
import { runSimWorker } from './runtime.ts';
import { Sim } from './sim-api.ts';
import { OPENING_HEAP_CAPACITY, SIM_MECHANICS } from './table-config.ts';

// apps/web compiles against the DOM lib, which types `self` as a Window; inside this module it
// is a DedicatedWorkerGlobalScope, whose postMessage takes a transfer list.
const scope = globalThis as unknown as MessageEndpoint<MainToWorker, WorkerToMain>;

runSimWorker(scope, {
  createSim: (options) => Sim.create({ ...options, mechanics: SIM_MECHANICS }),
  heapCapacity: OPENING_HEAP_CAPACITY,
  now: () => performance.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
});

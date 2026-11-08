import type { MainToWorker, MessageEndpoint, WorkerToMain } from './protocol.ts';
import { runSimWorker } from './runtime.ts';
import { Sim } from './sim-api.ts';

// apps/web compiles against the DOM lib, which types `self` as a Window; inside this module it
// is a DedicatedWorkerGlobalScope, whose postMessage takes a transfer list.
const scope = globalThis as unknown as MessageEndpoint<MainToWorker, WorkerToMain>;

runSimWorker(scope, {
  createSim: (seed) => Sim.create({ seed }),
  now: () => performance.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
});

import { economyConfig } from '@coinposh/economy';
import { COIN_TIERS } from '@coinposh/shared';
import type { MainToWorker, MessageEndpoint, WorkerToMain } from './protocol.ts';
import { runSimWorker } from './runtime.ts';
import { Sim, type MechanicsConfig } from './sim-api.ts';

// apps/web compiles against the DOM lib, which types `self` as a Window; inside this module it
// is a DedicatedWorkerGlobalScope, whose postMessage takes a transfer list.
const scope = globalThis as unknown as MessageEndpoint<MainToWorker, WorkerToMain>;

// The separator has no tower obstacles yet, so the table plays without the Champagne Tower.
const MECHANICS: MechanicsConfig<string> = {
  tiers: COIN_TIERS,
  fusion: {
    inputCount: economyConfig.fusion.inputCount,
    contactSeconds: economyConfig.fusion.contactSeconds,
  },
  tower: null,
};

runSimWorker(scope, {
  createSim: (options) => Sim.create({ ...options, mechanics: MECHANICS }),
  now: () => performance.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
});

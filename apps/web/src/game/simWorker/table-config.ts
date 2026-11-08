import { COIN_TIERS } from '@coinposh/shared';
import { Sim, type MechanicsConfig } from './sim-api.ts';

/**
 * The mechanics the worker's Sim runs with: coins keep the tier they were dropped with, but
 * nothing fuses and there is no Champagne Tower yet (the separator has no tower obstacles).
 *
 * Contact Fusion stays off until it is tuned against the pusher: with the economy's rules
 * (3 coins, 0.4 s) every packed copper pile fuses down faster than drops build it, so the table
 * never fills enough for coins to fall over the lip. Turn it on with
 * `{ inputCount, contactSeconds }` from `economyConfig.fusion` once fusion and the heap agree.
 */
export const SIM_MECHANICS: MechanicsConfig<string> = {
  tiers: COIN_TIERS,
  fusion: null,
  tower: null,
};

/** The most coins an `openingHeap` may ask the worker's Sim for. */
export const OPENING_HEAP_CAPACITY = Sim.heapCapacity(SIM_MECHANICS);

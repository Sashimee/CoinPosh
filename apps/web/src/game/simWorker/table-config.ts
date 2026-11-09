import { economyConfig } from '@coinposh/economy';
import { COIN_TIERS } from '@coinposh/shared';
import { Sim, type MechanicsConfig } from '@coinposh/sim';

/**
 * The mechanics the worker's Sim runs with: Contact Fusion on the economy's rules, and no
 * Champagne Tower yet (the separator has no tower obstacles).
 *
 * Fusion no longer eats the pile it lands on: the sim gives every new coin a 1 s spawn grace
 * and keeps the laid opening heap settled until its coins change level (FUSION_TUNING
 * spawnGraceTicks and settledShift), so drops join the heap before they fuse and the heap's
 * second layer does not fuse with the coins it rests on.
 */
export const SIM_MECHANICS: MechanicsConfig<string> = {
  tiers: COIN_TIERS,
  fusion: {
    inputCount: economyConfig.fusion.inputCount,
    contactSeconds: economyConfig.fusion.contactSeconds,
  },
  tower: null,
};

/** The most coins an `openingHeap` may ask the worker's Sim for. */
export const OPENING_HEAP_CAPACITY = Sim.heapCapacity(SIM_MECHANICS);

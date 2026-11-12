import { economyConfig } from '@coinposh/economy';
import { COIN_TIERS } from '@coinposh/shared';
import { Sim, type MechanicsConfig } from '@coinposh/sim';

/**
 * The mechanics the worker's Sim runs with: Contact Fusion on the economy's rules, and no
 * Champagne Tower yet (the separator has no tower obstacles).
 *
 * Fusion no longer eats the pile it lands on: the sim gives every new coin a 1 s spawn grace
 * and then a short window in which it may fuse with other fresh coins; the laid opening
 * heap is idle until a fresh silver wakes the coins it touches (FUSION_TUNING
 * spawnGraceTicks, freshTicks and wakeFromTier), so drops join the heap before they fuse
 * and only coppers dropped close together in time and place merge.
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

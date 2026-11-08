import { cascadeTierFor, type CascadeConfig } from '@coinposh/economy';
import type { CascadeTier } from '@coinposh/shared';

export interface ComboStep {
  readonly count: number;
  readonly tier: CascadeTier | null;
  /** Set when this fall lifted the chain onto a new rung; `rank` counts rungs from 1. */
  readonly tierUp: { readonly tier: CascadeTier; readonly rank: number } | null;
}

export interface ComboEnd {
  readonly count: number;
  readonly tier: CascadeTier | null;
}

/**
 * The Cascade ladder as the player sees it, counted in sim ticks like the server so a chain
 * here is the chain the server will price. The server's tier on each claim stays the truth.
 */
export class CascadeCombo {
  readonly #config: CascadeConfig;
  readonly #windowTicks: number;
  #count = 0;
  #lastTick = 0;
  #tier: CascadeTier | null = null;

  constructor(config: CascadeConfig, windowTicks: number) {
    if (!Number.isInteger(windowTicks) || windowTicks <= 0) {
      throw new RangeError(
        `CascadeCombo: windowTicks must be a positive integer, got ${windowTicks}`,
      );
    }
    this.#config = config;
    this.#windowTicks = windowTicks;
  }

  get count(): number {
    return this.#count;
  }

  get tier(): CascadeTier | null {
    return this.#tier;
  }

  /** Counts a front fall; returns the chain that ended first if this fall broke it. */
  fall(tick: number): { readonly step: ComboStep; readonly ended: ComboEnd | null } {
    const ended = this.#expired(tick) ? this.#end() : null;
    this.#count += 1;
    this.#lastTick = tick;
    const tier = cascadeTierFor(this.#count, this.#config)?.id ?? null;
    let tierUp: ComboStep['tierUp'] = null;
    if (tier !== null && tier !== this.#tier) {
      tierUp = { tier, rank: this.#config.tiers.findIndex((def) => def.id === tier) + 1 };
    }
    this.#tier = tier;
    return { step: { count: this.#count, tier, tierUp }, ended };
  }

  /** Ends the chain once its window has passed without a fall. */
  update(tick: number): ComboEnd | null {
    return this.#expired(tick) ? this.#end() : null;
  }

  reset(): ComboEnd | null {
    return this.#count > 0 ? this.#end() : null;
  }

  // A tick earlier than the last fall means the sim was reset or replaced, never a longer chain.
  #expired(tick: number): boolean {
    if (this.#count === 0) return false;
    return tick < this.#lastTick || tick - this.#lastTick > this.#windowTicks;
  }

  #end(): ComboEnd {
    const ended = { count: this.#count, tier: this.#tier };
    this.#count = 0;
    this.#tier = null;
    return ended;
  }
}

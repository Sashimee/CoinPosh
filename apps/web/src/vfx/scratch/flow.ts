import { SCRATCH_GRID_SIZE, type Rarity } from '@coinposh/shared';
import { CoverageMask, type ScratchPoint, BRUSH_RADIUS } from './mask.ts';
import { pairedCells, scratchMatch, type ScratchMatch } from './plan.ts';

/**
 * - `sealed`: the foil is whole and the house has not been asked yet; scratching does nothing.
 * - `revealing`: the reveal call is out; the card waits on the server's grid.
 * - `scratching`: the server's grid is painted under the foil and the brush uncovers it.
 * - `clearing`: enough is off; the rest of the foil falls away.
 * - `matched`: the three gems flared and the prize shows; COLLECT waits for the player.
 * - `collected`: the player took the prize.
 */
export type ScratchPhase =
  'sealed' | 'revealing' | 'scratching' | 'clearing' | 'matched' | 'collected';

export interface ScratchStep {
  /** Samples the stamps newly cleared. */
  readonly cleared: number;
  /** Cells that crossed the reveal threshold with these stamps, in grid order. */
  readonly uncovered: readonly number[];
  /** Uncovered cells newly part of a pair (two of a kind showing). */
  readonly paired: readonly number[];
  /** True on the step that left enough uncovered for the rest of the foil to go. */
  readonly clearing: boolean;
}

const IDLE: ScratchStep = { cleared: 0, uncovered: [], paired: [], clearing: false };

/**
 * The order a card follows, free of the DOM and the GPU. Nothing can be scratched until the
 * server's grid is in: the brush only uncovers what the house already rolled.
 */
export class ScratchFlow {
  readonly mask: CoverageMask;
  private current: ScratchPhase = 'sealed';
  private gems: readonly Rarity[] | null = null;
  private winning: ScratchMatch | null = null;
  private readonly shown = new Set<number>();
  private readonly pairs = new Set<number>();

  constructor(mask: CoverageMask = new CoverageMask()) {
    this.mask = mask;
  }

  get phase(): ScratchPhase {
    return this.current;
  }

  get grid(): readonly Rarity[] | null {
    return this.gems;
  }

  get match(): ScratchMatch | null {
    return this.winning;
  }

  /** Uncovered cells, in grid order. */
  get uncovered(): readonly number[] {
    return [...this.shown].sort((a, b) => a - b);
  }

  get canScratch(): boolean {
    return this.current === 'scratching';
  }

  /** The player asked to scratch: ask the house first. False unless the card is still sealed. */
  begin(): boolean {
    if (this.current !== 'sealed') return false;
    this.current = 'revealing';
    return true;
  }

  /** The server's answer. Throws, leaving the card unscratchable, if the grid breaks the contract. */
  accept(grid: readonly Rarity[], rarity: Rarity): ScratchMatch {
    if (this.current !== 'revealing') {
      throw new Error(`A scratch grid arrived while the card was ${this.current}, not revealing`);
    }
    const match = scratchMatch(grid, rarity);
    this.gems = [...grid];
    this.winning = match;
    this.current = 'scratching';
    return match;
  }

  /** The reveal call failed; the card is whole again and may be tried once more. */
  refuse(): void {
    if (this.current === 'revealing') this.current = 'sealed';
  }

  /** Runs brush stamps through the coverage mask; ignored outside `scratching`. */
  scratch(stamps: readonly ScratchPoint[], radius = BRUSH_RADIUS): ScratchStep {
    if (this.current !== 'scratching' || this.gems === null) return IDLE;
    let cleared = 0;
    for (const point of stamps) cleared += this.mask.stamp(point, radius);
    if (cleared === 0) return IDLE;
    const uncovered = this.mask.uncovered().filter((cell) => !this.shown.has(cell));
    for (const cell of uncovered) this.shown.add(cell);
    const paired = pairedCells(this.gems, [...this.shown]).filter((cell) => !this.pairs.has(cell));
    for (const cell of paired) this.pairs.add(cell);
    const clearing = this.mask.cleared();
    if (clearing) this.clear();
    return { cleared, uncovered, paired, clearing };
  }

  /**
   * The rest of the foil goes ("Reveal all", or enough scratched). Returns the cells it shows
   * that were still covered.
   */
  clear(): readonly number[] {
    if (this.current !== 'scratching') return [];
    this.current = 'clearing';
    const rest: number[] = [];
    for (let cell = 0; cell < SCRATCH_GRID_SIZE; cell++) {
      if (this.shown.has(cell)) continue;
      this.shown.add(cell);
      rest.push(cell);
    }
    return rest;
  }

  /** The foil is gone: the match plays. */
  settle(): boolean {
    if (this.current !== 'clearing') return false;
    this.current = 'matched';
    return true;
  }

  /** The player collected; true only the first time, from `matched`. */
  collect(): boolean {
    if (this.current !== 'matched') return false;
    this.current = 'collected';
    return true;
  }
}

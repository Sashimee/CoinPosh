import { SCRATCH_GRID_SIZE } from '@coinposh/shared';

/** A point in the scratch window, normalised: (0, 0) is its top-left corner, (1, 1) the bottom-right. */
export interface ScratchPoint {
  readonly x: number;
  readonly y: number;
}

export interface CellRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export const SCRATCH_COLUMNS = 3;
/** Window padding and the gutter between cells, as fractions of the (square) window. */
export const CELL_PAD = 0.03;
export const CELL_GAP = 0.05;
export const CELL_SIZE = (1 - 2 * CELL_PAD - (SCRATCH_COLUMNS - 1) * CELL_GAP) / SCRATCH_COLUMNS;

/** The brush radius as a fraction of the window: about a fingertip on a 300 px card. */
export const BRUSH_RADIUS = 0.075;
/**
 * The share of the radius that reads as scratched. The GPU brush has a soft rim from 0.6 to
 * 1.0 of its radius; coverage counts only what is clearly off, so a cell is never called
 * uncovered while foil still hides it.
 */
export const BRUSH_CORE = 0.85;
/** Stamps along a stroke sit this many radii apart, close enough that the line never beads. */
export const STAMP_SPACING = 0.3;
/** Coverage samples per side of the window. */
export const COVERAGE_RES = 64;
/** A cell this scratched counts as uncovered: its gem pops and its name is announced. */
export const CELL_REVEAL = 0.55;
/** Once every cell is uncovered, or the window is this scratched, the rest of the foil falls away. */
export const CARD_CLEAR = 0.7;

export function cellRect(index: number): CellRect {
  if (!Number.isInteger(index) || index < 0 || index >= SCRATCH_GRID_SIZE) {
    throw new RangeError(`Scratch cell index must be 0..${SCRATCH_GRID_SIZE - 1}, got ${index}`);
  }
  const column = index % SCRATCH_COLUMNS;
  const row = Math.floor(index / SCRATCH_COLUMNS);
  const x0 = CELL_PAD + column * (CELL_SIZE + CELL_GAP);
  const y0 = CELL_PAD + row * (CELL_SIZE + CELL_GAP);
  return { x0, y0, x1: x0 + CELL_SIZE, y1: y0 + CELL_SIZE };
}

export function cellCentre(index: number): ScratchPoint {
  const rect = cellRect(index);
  return { x: (rect.x0 + rect.x1) / 2, y: (rect.y0 + rect.y1) / 2 };
}

/** The cell under a point, or null in the padding and the gutters. */
export function cellAt(point: ScratchPoint): number | null {
  for (let index = 0; index < SCRATCH_GRID_SIZE; index++) {
    const rect = cellRect(index);
    if (point.x >= rect.x0 && point.x < rect.x1 && point.y >= rect.y0 && point.y < rect.y1) {
      return index;
    }
  }
  return null;
}

/**
 * The stamps that carry a stroke from `from` to `to`, spaced so the line never beads. `from`
 * was stamped by the previous move, so it is left out; `to` is always the last stamp.
 */
export function strokeStamps(
  from: ScratchPoint,
  to: ScratchPoint,
  radius = BRUSH_RADIUS,
  spacing = STAMP_SPACING,
): ScratchPoint[] {
  if (!(radius > 0) || !(spacing > 0)) {
    throw new RangeError(
      `strokeStamps needs a positive radius and spacing, got ${radius}, ${spacing}`,
    );
  }
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (radius * spacing)));
  const stamps: ScratchPoint[] = [];
  for (let step = 1; step <= steps; step++) {
    const t = step / steps;
    stamps.push({ x: from.x + dx * t, y: from.y + dy * t });
  }
  return stamps;
}

/**
 * What the foil has lost, sampled on a grid. The GPU mask draws the pixels; this tracks the
 * same stamps on the CPU so the card knows, without a readback, how much of each cell shows.
 */
export class CoverageMask {
  private readonly scratched: Uint8Array;
  private readonly cellOf: Int8Array;
  private readonly cellTotals: number[];
  private readonly cellCounts: number[];
  private count = 0;

  constructor(readonly resolution = COVERAGE_RES) {
    if (!Number.isInteger(resolution) || resolution < SCRATCH_COLUMNS * 4) {
      throw new RangeError(
        `CoverageMask resolution must be an integer of at least ${SCRATCH_COLUMNS * 4}, got ${resolution}`,
      );
    }
    this.scratched = new Uint8Array(resolution * resolution);
    this.cellOf = new Int8Array(resolution * resolution);
    this.cellTotals = Array.from({ length: SCRATCH_GRID_SIZE }, () => 0);
    this.cellCounts = Array.from({ length: SCRATCH_GRID_SIZE }, () => 0);
    for (let row = 0; row < resolution; row++) {
      for (let column = 0; column < resolution; column++) {
        const cell = cellAt({ x: (column + 0.5) / resolution, y: (row + 0.5) / resolution });
        this.cellOf[row * resolution + column] = cell ?? -1;
        if (cell !== null) this.cellTotals[cell] = (this.cellTotals[cell] ?? 0) + 1;
      }
    }
  }

  /** Scratches a disc of `radius × BRUSH_CORE`; returns how many samples it newly cleared. */
  stamp(point: ScratchPoint, radius = BRUSH_RADIUS): number {
    const res = this.resolution;
    const reach = radius * BRUSH_CORE;
    if (!(reach > 0) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return 0;
    const minColumn = Math.max(0, Math.floor((point.x - reach) * res));
    const maxColumn = Math.min(res - 1, Math.ceil((point.x + reach) * res));
    const minRow = Math.max(0, Math.floor((point.y - reach) * res));
    const maxRow = Math.min(res - 1, Math.ceil((point.y + reach) * res));
    const reach2 = reach * reach;
    let cleared = 0;
    for (let row = minRow; row <= maxRow; row++) {
      const dy = (row + 0.5) / res - point.y;
      for (let column = minColumn; column <= maxColumn; column++) {
        const dx = (column + 0.5) / res - point.x;
        if (dx * dx + dy * dy > reach2) continue;
        const at = row * res + column;
        if (this.scratched[at] === 1) continue;
        this.scratched[at] = 1;
        cleared++;
        const cell = this.cellOf[at] ?? -1;
        if (cell >= 0) this.cellCounts[cell] = (this.cellCounts[cell] ?? 0) + 1;
      }
    }
    this.count += cleared;
    return cleared;
  }

  /** The share of a cell's samples that are scratched, 0..1. */
  cellCoverage(index: number): number {
    cellRect(index);
    const total = this.cellTotals[index] ?? 0;
    return total === 0 ? 0 : (this.cellCounts[index] ?? 0) / total;
  }

  /** The cells scratched to at least `threshold`, in grid order. */
  uncovered(threshold = CELL_REVEAL): number[] {
    const cells: number[] = [];
    for (let index = 0; index < SCRATCH_GRID_SIZE; index++) {
      if (this.cellCoverage(index) >= threshold) cells.push(index);
    }
    return cells;
  }

  /** The share of the whole window that is scratched, 0..1. */
  total(): number {
    return this.count / this.scratched.length;
  }

  /** True once the rest of the foil should fall away on its own. */
  cleared(cellThreshold = CELL_REVEAL, cardThreshold = CARD_CLEAR): boolean {
    return (
      this.uncovered(cellThreshold).length === SCRATCH_GRID_SIZE || this.total() >= cardThreshold
    );
  }
}

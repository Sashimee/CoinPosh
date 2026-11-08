import type { FallEdge } from '@coinposh/shared';
import type { CoinTransformTarget } from '../simWorker/interpolate.ts';
import type { TablePoint } from './events.ts';

/** The playfield edges coins leave by, in table metres (+Z towards the player). */
export interface TableBounds {
  readonly fieldHalfWidth: number;
  readonly fieldFrontZ: number;
}

export interface SeenCoin {
  readonly id: number;
  readonly position: TablePoint;
}

export interface VanishedCoin extends SeenCoin {
  /** `null` when the coin left mid-table, as fused coins do, rather than over an edge. */
  readonly edge: FallEdge | null;
}

export interface FrameChanges {
  /** New sim ids, oldest first. */
  readonly appeared: readonly SeenCoin[];
  readonly vanished: readonly VanishedCoin[];
}

const NO_CHANGES: FrameChanges = { appeared: [], vanished: [] };

/**
 * Sits between the sim bridge and the coin field and notices coins arriving and leaving. A coin
 * that stops being drawn is classified by where it was last seen: within `edgeMargin` of an
 * edge it fell off that edge.
 */
export class TableWatcher {
  readonly #bounds: TableBounds;
  readonly #edgeMargin: number;
  // Slot maps into flat xyz arrays, reused frame to frame so a full table allocates nothing.
  #previous = new Frame();
  #current = new Frame();
  #highestId = -1;
  #wrote = false;
  #target: CoinTransformTarget | null = null;

  readonly target: CoinTransformTarget = {
    capacity: (tier) => this.#requireTarget().capacity(tier),
    setTransforms: (tier, positions, quaternions, count, ids) => {
      this.#record(positions, count, ids);
      this.#requireTarget().setTransforms(tier, positions, quaternions, count, ids);
    },
  };

  constructor(bounds: TableBounds, edgeMargin: number) {
    if (!(bounds.fieldHalfWidth > 0) || !Number.isFinite(bounds.fieldFrontZ)) {
      throw new RangeError(
        'TableWatcher: bounds need a positive fieldHalfWidth and a finite fieldFrontZ',
      );
    }
    if (!(edgeMargin > 0)) {
      throw new RangeError(`TableWatcher: edgeMargin must be > 0, got ${edgeMargin}`);
    }
    this.#bounds = bounds;
    this.#edgeMargin = edgeMargin;
  }

  /** Starts a frame that forwards to `target`; finish it with `end`. */
  begin(target: CoinTransformTarget): CoinTransformTarget {
    this.#target = target;
    this.#wrote = false;
    this.#current.clear();
    return this.target;
  }

  /** A frame the source did not write (no sim frame yet) changes nothing. */
  end(): FrameChanges {
    this.#target = null;
    if (!this.#wrote) return NO_CHANGES;
    const appeared: SeenCoin[] = [];
    const vanished: VanishedCoin[] = [];
    for (const [id, slot] of this.#current.slots) {
      if (id > this.#highestId) appeared.push({ id, position: this.#current.point(slot) });
    }
    for (const [id, slot] of this.#previous.slots) {
      if (this.#current.slots.has(id)) continue;
      const position = this.#previous.point(slot);
      vanished.push({ id, position, edge: this.classify(position) });
    }
    appeared.sort((a, b) => a.id - b.id);
    const last = appeared.at(-1);
    if (last) this.#highestId = last.id;
    [this.#previous, this.#current] = [this.#current, this.#previous];
    return appeared.length === 0 && vanished.length === 0 ? NO_CHANGES : { appeared, vanished };
  }

  lastPosition(id: number): TablePoint | undefined {
    const slot = this.#previous.slots.get(id);
    return slot === undefined ? undefined : this.#previous.point(slot);
  }

  classify(position: TablePoint): FallEdge | null {
    const { fieldHalfWidth, fieldFrontZ } = this.#bounds;
    const distances: readonly (readonly [FallEdge, number])[] = [
      ['front', fieldFrontZ - position.z],
      ['left', position.x + fieldHalfWidth],
      ['right', fieldHalfWidth - position.x],
    ];
    let best: FallEdge | null = null;
    let nearest = this.#edgeMargin;
    for (const [edge, distance] of distances) {
      if (distance <= nearest) {
        best = edge;
        nearest = distance;
      }
    }
    return best;
  }

  #record(positions: ArrayLike<number>, count: number, ids: ArrayLike<number>): void {
    this.#wrote = true;
    for (let i = 0; i < count; i += 1) {
      const id = ids[i];
      const x = positions[i * 3];
      const y = positions[i * 3 + 1];
      const z = positions[i * 3 + 2];
      if (id === undefined || x === undefined || y === undefined || z === undefined) {
        throw new RangeError(`TableWatcher: frame holds ${count} coins but its arrays end at ${i}`);
      }
      this.#current.add(id, x, y, z);
    }
  }

  #requireTarget(): CoinTransformTarget {
    if (!this.#target) throw new Error('TableWatcher: write the frame between begin() and end()');
    return this.#target;
  }
}

class Frame {
  readonly slots = new Map<number, number>();
  #xyz: number[] = [];

  clear(): void {
    this.slots.clear();
  }

  add(id: number, x: number, y: number, z: number): void {
    const slot = this.slots.size;
    this.slots.set(id, slot);
    this.#xyz[slot * 3] = x;
    this.#xyz[slot * 3 + 1] = y;
    this.#xyz[slot * 3 + 2] = z;
  }

  point(slot: number): TablePoint {
    const x = this.#xyz[slot * 3];
    const y = this.#xyz[slot * 3 + 1];
    const z = this.#xyz[slot * 3 + 2];
    if (x === undefined || y === undefined || z === undefined) {
      throw new RangeError(`TableWatcher: no coin position in slot ${slot}`);
    }
    return { x, y, z };
  }
}

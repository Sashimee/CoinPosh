import { TICK_RATE_HZ } from '../constants.ts';
import type { StateHasher } from '../hash.ts';
import type { CoinPair } from './contacts.ts';

/**
 * The economy's fusion rules (`economyConfig.fusion` in packages/economy), which the
 * caller passes in so the sim never holds its own copy of an economy number.
 */
export interface FusionRules {
  /** Coins that fuse into one, an integer >= 2. */
  readonly inputCount: number;
  /** How long every contact in the group must have lasted, in seconds. */
  readonly contactSeconds: number;
}

/** A pair's touching progress toward a fusion, for the renderer's charge-up. */
export interface ContactProgress {
  readonly a: number;
  readonly b: number;
  /** Contact time over the required time, capped at 1. */
  readonly progress: number;
}

/**
 * Ids must stay below this (2^26) for a contact to pack exactly into one float64 as
 * from × ID_SPAN + to, which lets the ripe walk sort its edges natively. A table that
 * drops ten coins a second takes over two months to use 67 million ids.
 */
const ID_SPAN = 67_108_864;

function at(values: Float64Array, k: number): number {
  const value = values[k];
  if (value === undefined) {
    throw new Error(`ContactFusion: no entry at ${k} of ${values.length} in the ripe walk`);
  }
  return value;
}

interface Streak {
  /** First tick of the unbroken contact. */
  since: number;
  /** Last tick the pair was seen touching. */
  seen: number;
}

/**
 * Ticks of contact a fusion needs: `contactSeconds` rounded up to whole ticks, at
 * least one. The rounding forgives a billionth of a tick, so a window scaled by an
 * upgrade (0.4 s × 1.05 × …) that lands a rounding error above a whole tick does not
 * cost the player an extra tick.
 */
export function fusionTicks(contactSeconds: number): number {
  if (!Number.isFinite(contactSeconds) || contactSeconds <= 0) {
    throw new RangeError(`Fusion contactSeconds must be a positive number, got ${contactSeconds}`);
  }
  return Math.max(1, Math.ceil(contactSeconds * TICK_RATE_HZ - 1e-9));
}

/**
 * Contact Fusion's clock. Each tick it is told which same-tier pairs touch; it keeps
 * when each pair's contact began and reports the groups of `inputCount` coins joined
 * by contacts that have all lasted `requiredTicks`. A contact that breaks for up to
 * `graceTicks` ticks keeps its start, so the jostling of a working pile does not
 * reset a fusion that is about to fire; one that breaks for longer starts over.
 *
 * A group is connected, not necessarily a closed ring: three coins in a row, a
 * triangle or a short stack all fuse. Groups never share a coin. They are chosen
 * deterministically: starting from each coin in ascending id order, a breadth-first
 * walk over the ripe contacts takes neighbours in ascending id order until the group
 * is full.
 *
 * With a `samplePeriod` above one the caller looks at each pair only once every that
 * many ticks (CoinContactFinder's slices), so a pair counts as touching until its next
 * look and the grace stretches by the same period.
 */
export class ContactFusion {
  readonly inputCount: number;
  readonly requiredTicks: number;
  readonly graceTicks: number;
  readonly samplePeriod: number;
  /** Keyed by the lower id, then the higher. */
  readonly #streaks = new Map<number, Map<number, Streak>>();
  /** Scratch for the ripe walk: the ripe contacts of this tick, packed both ways round. */
  #edges = new Float64Array(64);
  /** Scratch for the ripe walk: the coins with a ripe contact, ascending, and where their contacts start in #edges. */
  #ids = new Float64Array(64);
  #firstEdge = new Float64Array(65);
  #used = new Float64Array(64);

  constructor(rules: FusionRules, graceTicks: number, samplePeriod = 1) {
    if (!Number.isInteger(rules.inputCount) || rules.inputCount < 2) {
      throw new RangeError(`Fusion inputCount must be an integer >= 2, got ${rules.inputCount}`);
    }
    if (!Number.isInteger(graceTicks) || graceTicks < 0) {
      throw new RangeError(`Fusion graceTicks must be an integer >= 0, got ${graceTicks}`);
    }
    if (!Number.isInteger(samplePeriod) || samplePeriod < 1) {
      throw new RangeError(`Fusion samplePeriod must be an integer >= 1, got ${samplePeriod}`);
    }
    this.inputCount = rules.inputCount;
    this.samplePeriod = samplePeriod;
    this.requiredTicks = fusionTicks(rules.contactSeconds);
    this.graceTicks = graceTicks;
  }

  /** Contacts being timed, including broken ones still inside their grace. */
  get trackedContacts(): number {
    let count = 0;
    for (const inner of this.#streaks.values()) {
      count += inner.size;
    }
    return count;
  }

  /**
   * Records the pairs touching at `tick` (from CoinContactFinder, so sorted and
   * same-tier; with a sample period, the slice of pairs due this tick) and returns the
   * groups ready to fuse, each sorted ascending, in the order they were found. Ticks
   * must increase from call to call.
   */
  update(tick: number, touching: readonly CoinPair[]): number[][] {
    for (const { a, b } of touching) {
      let inner = this.#streaks.get(a);
      if (!inner) {
        inner = new Map();
        this.#streaks.set(a, inner);
      }
      const streak = inner.get(b);
      if (streak && tick - streak.seen <= this.graceTicks + this.samplePeriod) {
        streak.seen = tick;
      } else {
        if (!Number.isInteger(a) || a < 0 || !Number.isInteger(b) || b <= a || b >= ID_SPAN) {
          throw new RangeError(
            `ContactFusion.update: pair ${a}, ${b} needs whole ids, a < b < ${ID_SPAN}`,
          );
        }
        inner.set(b, { since: tick, seen: tick });
      }
    }
    return this.#ripeGroups(this.#settle(tick));
  }

  /** Drops every contact involving one of `ids`, as when those coins leave the table. */
  forget(ids: Iterable<number>): void {
    const gone = new Set(ids);
    if (gone.size === 0) {
      return;
    }
    for (const [a, inner] of this.#streaks) {
      if (gone.has(a)) {
        this.#streaks.delete(a);
        continue;
      }
      for (const b of inner.keys()) {
        if (gone.has(b)) {
          inner.delete(b);
        }
      }
      if (inner.size === 0) {
        this.#streaks.delete(a);
      }
    }
  }

  /** Progress of every pair touching at `tick`, sorted by `a` then `b`. */
  progress(tick: number): ContactProgress[] {
    const out: ContactProgress[] = [];
    for (const [a, b, streak] of this.#sorted()) {
      if (this.#touching(tick, streak)) {
        out.push({ a, b, progress: Math.min(1, (tick - streak.since) / this.requiredTicks) });
      }
    }
    return out;
  }

  hashInto(h: StateHasher): StateHasher {
    const sorted = this.#sorted();
    h.int(sorted.length);
    for (const [a, b, { since, seen }] of sorted) {
      h.int(a).int(b).int(since).int(seen);
    }
    return h;
  }

  /** Seen on the pair's latest look. */
  #touching(tick: number, streak: Streak): boolean {
    return streak.seen > tick - this.samplePeriod;
  }

  /**
   * Drops the contacts broken for longer than the grace and packs the ripe ones into
   * #edges, both ways round. Returns how many entries it packed.
   */
  #settle(tick: number): number {
    const limit = this.graceTicks + this.samplePeriod - 1;
    let edges = this.#edges;
    let count = 0;
    for (const [a, inner] of this.#streaks) {
      for (const [b, streak] of inner) {
        if (tick - streak.seen > limit) {
          inner.delete(b);
        } else if (this.#touching(tick, streak) && tick - streak.since >= this.requiredTicks) {
          if (count + 2 > edges.length) {
            const grown = new Float64Array(2 * edges.length);
            grown.set(edges);
            edges = grown;
            this.#edges = grown;
            this.#ids = new Float64Array(grown.length);
            this.#firstEdge = new Float64Array(grown.length + 1);
            this.#used = new Float64Array(grown.length);
          }
          edges[count] = a * ID_SPAN + b;
          edges[count + 1] = b * ID_SPAN + a;
          count += 2;
        }
      }
      if (inner.size === 0) {
        this.#streaks.delete(a);
      }
    }
    return count;
  }

  #ripeGroups(count: number): number[][] {
    if (count < 2 * (this.inputCount - 1)) {
      return [];
    }
    const edges = this.#edges.subarray(0, count).sort();
    const ids = this.#ids;
    const firstEdge = this.#firstEdge;
    let n = 0;
    for (let k = 0; k < count; k++) {
      const id = Math.floor(at(edges, k) / ID_SPAN);
      if (n === 0 || at(ids, n - 1) !== id) {
        ids[n] = id;
        firstEdge[n] = k;
        n += 1;
      }
    }
    if (n < this.inputCount) {
      return [];
    }
    firstEdge[n] = count;
    const used = this.#used;
    used.fill(0, 0, n);
    const groups: number[][] = [];
    for (let start = 0; start < n; start++) {
      if (at(used, start) === 1) {
        continue;
      }
      const group = [start];
      // A for-of over an array visits what is pushed onto it, which makes this the walk's queue.
      for (const member of group) {
        const base = at(ids, member) * ID_SPAN;
        const end = at(firstEdge, member + 1);
        for (let k = at(firstEdge, member); k < end; k++) {
          const next = this.#indexOf(at(edges, k) - base, n);
          if (at(used, next) === 0 && !group.includes(next)) {
            group.push(next);
            if (group.length === this.inputCount) {
              break;
            }
          }
        }
        if (group.length === this.inputCount) {
          break;
        }
      }
      if (group.length === this.inputCount) {
        for (const member of group) {
          used[member] = 1;
        }
        groups.push(group.map((member) => at(ids, member)).sort((p, q) => p - q));
      }
    }
    return groups;
  }

  /** Where `id` is among the first `n` coins of the ripe walk, by binary search. */
  #indexOf(id: number, n: number): number {
    let lo = 0;
    let hi = n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const value = at(this.#ids, mid);
      if (value === id) {
        return mid;
      }
      if (value < id) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    throw new Error(`ContactFusion: coin ${id} has a ripe contact but is not in the ripe walk`);
  }

  #sorted(): [number, number, Streak][] {
    const out: [number, number, Streak][] = [];
    for (const [a, inner] of this.#streaks) {
      for (const [b, streak] of inner) {
        out.push([a, b, streak]);
      }
    }
    return out.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  }
}

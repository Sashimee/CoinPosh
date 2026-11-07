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
 */
export class ContactFusion {
  readonly inputCount: number;
  readonly requiredTicks: number;
  readonly graceTicks: number;
  /** Keyed by the lower id, then the higher. */
  readonly #streaks = new Map<number, Map<number, Streak>>();

  constructor(rules: FusionRules, graceTicks: number) {
    if (!Number.isInteger(rules.inputCount) || rules.inputCount < 2) {
      throw new RangeError(`Fusion inputCount must be an integer >= 2, got ${rules.inputCount}`);
    }
    if (!Number.isInteger(graceTicks) || graceTicks < 0) {
      throw new RangeError(`Fusion graceTicks must be an integer >= 0, got ${graceTicks}`);
    }
    this.inputCount = rules.inputCount;
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
   * same-tier) and returns the groups ready to fuse, each sorted ascending, in the
   * order they were found. Ticks must increase from call to call.
   */
  update(tick: number, touching: readonly CoinPair[]): number[][] {
    for (const { a, b } of touching) {
      let inner = this.#streaks.get(a);
      if (!inner) {
        inner = new Map();
        this.#streaks.set(a, inner);
      }
      const streak = inner.get(b);
      if (streak && tick - streak.seen <= this.graceTicks + 1) {
        streak.seen = tick;
      } else {
        inner.set(b, { since: tick, seen: tick });
      }
    }
    this.#prune(tick);
    return this.#ripeGroups(tick, touching);
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
      if (streak.seen === tick) {
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

  #prune(tick: number): void {
    for (const [a, inner] of this.#streaks) {
      for (const [b, streak] of inner) {
        if (tick - streak.seen > this.graceTicks) {
          inner.delete(b);
        }
      }
      if (inner.size === 0) {
        this.#streaks.delete(a);
      }
    }
  }

  #ripeGroups(tick: number, touching: readonly CoinPair[]): number[][] {
    const adjacency = new Map<number, number[]>();
    const link = (from: number, to: number): void => {
      const list = adjacency.get(from);
      if (list) {
        list.push(to);
      } else {
        adjacency.set(from, [to]);
      }
    };
    for (const { a, b } of touching) {
      const streak = this.#streaks.get(a)?.get(b);
      if (streak && tick - streak.since >= this.requiredTicks) {
        link(a, b);
        link(b, a);
      }
    }
    if (adjacency.size < this.inputCount) {
      return [];
    }
    const starts = Array.from(adjacency.keys()).sort((p, q) => p - q);
    for (const list of adjacency.values()) {
      list.sort((p, q) => p - q);
    }
    const used = new Set<number>();
    const groups: number[][] = [];
    for (const start of starts) {
      if (used.has(start)) {
        continue;
      }
      const group = [start];
      const inGroup = new Set(group);
      // A for-of over an array visits what is pushed onto it, which makes this the walk's queue.
      for (const member of group) {
        for (const next of adjacency.get(member) ?? []) {
          if (group.length < this.inputCount && !used.has(next) && !inGroup.has(next)) {
            group.push(next);
            inGroup.add(next);
          }
        }
        if (group.length === this.inputCount) {
          break;
        }
      }
      if (group.length === this.inputCount) {
        for (const id of group) {
          used.add(id);
        }
        groups.push(group.sort((p, q) => p - q));
      }
    }
    return groups;
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

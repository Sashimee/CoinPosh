import type { CrateId } from '@coinposh/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  UNSEEN_CRATES_KEPT,
  UNSEEN_CRATES_STORAGE_KEY,
  unseenCrates,
  type UnseenStorage,
} from './unseen.ts';

class FakeStorage implements UnseenStorage {
  readonly items = new Map<string, string>();
  failGet = false;
  failSet = false;

  getItem(key: string): string | null {
    if (this.failGet) throw new DOMException('Storage is blocked.', 'SecurityError');
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failSet) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    this.items.set(key, value);
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }
}

const crate = (n: number) => `crate_${String(n).padStart(16, '0')}` as CrateId;

let storage: FakeStorage;
let warnings: string[];
const warn = (message: string) => warnings.push(message);

beforeEach(() => {
  storage = new FakeStorage();
  warnings = [];
});

describe('unseen crates', () => {
  it('outlives a reload through storage, oldest first, and clears the key once empty', () => {
    const first = unseenCrates(storage, warn);
    first.add(crate(1));
    first.add(crate(2));
    first.add(crate(1));
    expect(unseenCrates(storage, warn).list()).toEqual([crate(1), crate(2)]);

    const second = unseenCrates(storage, warn);
    second.remove(crate(1));
    expect(unseenCrates(storage, warn).list()).toEqual([crate(2)]);
    second.remove(crate(2));
    second.remove(crate(3));
    expect(storage.items.has(UNSEEN_CRATES_STORAGE_KEY)).toBe(false);
    expect(unseenCrates(storage, warn).list()).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('keeps only the newest ids past the cap', () => {
    const list = unseenCrates(storage, warn);
    for (let n = 0; n < UNSEEN_CRATES_KEPT + 3; n++) list.add(crate(n));
    const kept = unseenCrates(storage, warn).list();
    expect(kept).toHaveLength(UNSEEN_CRATES_KEPT);
    expect(kept[0]).toBe(crate(3));
    expect(kept.at(-1)).toBe(crate(UNSEEN_CRATES_KEPT + 2));
  });

  it.each([
    ['not JSON', '{oops', /not JSON/],
    ['not crate ids', JSON.stringify(['coin_1']), /not a list of crate ids/],
    [
      'longer than the cap',
      JSON.stringify(Array.from({ length: 17 }, (_, n) => crate(n))),
      /not a list/,
    ],
  ])('drops a stored list that is %s, with one warning', (_, raw, reason) => {
    storage.items.set(UNSEEN_CRATES_STORAGE_KEY, raw);
    const list = unseenCrates(storage, warn);
    expect(list.list()).toEqual([]);
    expect(storage.items.has(UNSEEN_CRATES_STORAGE_KEY)).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(reason);
  });

  it('plays on from memory when storage refuses, warning once', () => {
    storage.failGet = true;
    storage.failSet = true;
    const list = unseenCrates(storage, warn);
    list.add(crate(1));
    list.add(crate(2));
    list.remove(crate(1));
    expect(list.list()).toEqual([crate(2)]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/could not read the unseen crates/);
  });

  it('keeps the list in page memory when there is no storage at all', () => {
    const list = unseenCrates(null, warn);
    list.add(crate(1));
    expect(list.list()).toEqual([crate(1)]);
    expect(warnings).toEqual([]);
  });
});

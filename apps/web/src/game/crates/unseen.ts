import { CrateIdSchema, type CrateId } from '@coinposh/shared';

/** The sessionStorage key for this tab's crates whose roll the player has not collected yet. */
export const UNSEEN_CRATES_STORAGE_KEY = 'coinposh.crates.unseen';

/** More than the server keeps rolls for: an older id could only ever be answered `conflict`. */
export const UNSEEN_CRATES_KEPT = 16;

/** The slice of the Web Storage API the list needs, so tests can hand in a fake or a failing one. */
export interface UnseenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Crates this tab had opened, or was opening, when the player last saw them: the server booked
 * their roll, and the reveal card has not been collected. Only ids live here; the roll itself is
 * asked of the server again after a reload, so nothing here can name or change a reward.
 */
export interface UnseenCrates {
  /** Oldest first. */
  list(): readonly CrateId[];
  add(crateId: CrateId): void;
  /** The player collected the crate, or the server says it has no roll to show for it. */
  remove(crateId: CrateId): void;
}

export type UnseenWarn = (message: string, cause?: unknown) => void;

function decode(raw: string | null): CrateId[] | string {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return `it is not JSON (${String(error)})`;
  }
  const ids = CrateIdSchema.array().max(UNSEEN_CRATES_KEPT).safeParse(parsed);
  return ids.success ? [...new Set(ids.data)] : 'it is not a list of crate ids';
}

/**
 * The list kept in `storage`, or in page memory only when there is none. A list storage refuses
 * to give or take is reported once through `warn` and kept in memory, so the game plays on and
 * only a reload in that state can lose a card (never a reward, which the server holds).
 */
export function unseenCrates(storage: UnseenStorage | null, warn: UnseenWarn): UnseenCrates {
  let warned = false;
  const report = (message: string, cause?: unknown): void => {
    if (warned) return;
    warned = true;
    warn(message, cause);
  };
  let ids: CrateId[] = [];
  if (storage !== null) {
    try {
      const decoded = decode(storage.getItem(UNSEEN_CRATES_STORAGE_KEY));
      if (typeof decoded === 'string') {
        storage.removeItem(UNSEEN_CRATES_STORAGE_KEY);
        report(`CoinPosh crates: dropped the stored unseen crates because ${decoded}.`);
      } else {
        ids = decoded;
      }
    } catch (error) {
      report(
        'CoinPosh crates: could not read the unseen crates, so a reload during an unbox will not show its card again.',
        error,
      );
    }
  }
  const write = (): void => {
    if (storage === null) return;
    try {
      if (ids.length === 0) storage.removeItem(UNSEEN_CRATES_STORAGE_KEY);
      else storage.setItem(UNSEEN_CRATES_STORAGE_KEY, JSON.stringify(ids));
    } catch (error) {
      report(
        'CoinPosh crates: could not store the unseen crates, so a reload during an unbox will not show its card again.',
        error,
      );
    }
  };
  return {
    list: () => [...ids],
    add(crateId) {
      if (ids.includes(crateId)) return;
      ids = [...ids, crateId].slice(-UNSEEN_CRATES_KEPT);
      write();
    },
    remove(crateId) {
      if (!ids.includes(crateId)) return;
      ids = ids.filter((id) => id !== crateId);
      write();
    },
  };
}

/** The tab's sessionStorage, or null outside a browser or where touching it throws. */
export function browserUnseenStorage(warn: UnseenWarn): UnseenStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch (error) {
    warn(
      'CoinPosh crates: sessionStorage is unavailable, so a reload during an unbox will not show its card again.',
      error,
    );
    return null;
  }
}

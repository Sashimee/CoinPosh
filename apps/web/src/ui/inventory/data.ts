import type { SettingsStorage } from '../../app/settings.ts';
import { inventoryViewFromState, type InventoryData, type InventoryState } from './model.ts';

export interface StateSource {
  call(name: 'state'): Promise<InventoryState>;
}

/**
 * Reads the inventory out of `GET /v1/state`, the only contract that carries it today. No
 * fuse route exists, so this source has no `levelUp`; duplicates level up on grant instead.
 */
export function stateInventoryData(client: StateSource): InventoryData {
  return {
    async load() {
      return inventoryViewFromState(await client.call('state'));
    },
  };
}

const SEEN_KEY = 'coinposh.inventory.seenLevels';

/** The charm levels the panel last showed, so a level gained elsewhere is celebrated once. */
export interface SeenLevels {
  read(): Readonly<Record<string, number>> | null;
  write(levels: Readonly<Record<string, number>>): void;
}

function parseSeen(raw: string): Record<string, number> | null {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const levels: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) levels[key] = value;
  }
  return levels;
}

/** Remembers in `storage` when it works, and for this session only when it does not. */
export function seenLevelsStore(storage: SettingsStorage | null): SeenLevels {
  let memory: Readonly<Record<string, number>> | null = null;
  return {
    read() {
      if (!storage) return memory;
      try {
        const raw = storage.getItem(SEEN_KEY);
        return raw === null ? memory : (parseSeen(raw) ?? memory);
      } catch (error) {
        console.warn('[CoinPosh] stored inventory levels are unreadable; starting fresh', error);
        return memory;
      }
    },
    write(levels) {
      memory = levels;
      if (!storage) return;
      try {
        storage.setItem(SEEN_KEY, JSON.stringify(levels));
      } catch (error) {
        console.warn('[CoinPosh] could not store inventory levels; they last this session', error);
      }
    },
  };
}

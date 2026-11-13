import type { SafeTypeDef, SafesConfig } from '../types.ts';

const HOUR = 3_600;

/**
 * Key-locked safes (02-ECONOMY.md "Safes"). The server grants them, stamps `unlocksAt` from its
 * own clock and rolls their contents on `dropSource`; the client only shows what it reports.
 */
export const safes = {
  types: [{ id: 'gold', dropSource: 'goldSafe', keysPerSafe: 1, unlockSeconds: 4 * HOUR }],
  crateDrop: { source: 'vaultCrate', type: 'gold' },
} as const satisfies SafesConfig;

export type SafeTypeKey = (typeof safes.types)[number]['id'];

export function safeTypeDef(id: string, config: SafesConfig = safes): SafeTypeDef {
  const def = config.types.find((t) => t.id === id);
  if (def === undefined) {
    const known = config.types.map((t) => t.id).join(', ');
    throw new RangeError(`Unknown safe type "${id}"; the catalog has ${known}`);
  }
  return def;
}

/** Server time a safe of `type` granted at `grantedAtMs` opens on its timer. */
export function safeUnlocksAt(
  type: string,
  grantedAtMs: number,
  config: SafesConfig = safes,
): number {
  if (!Number.isSafeInteger(grantedAtMs) || grantedAtMs < 0) {
    throw new RangeError(`grantedAtMs must be a whole epoch millisecond ≥ 0, got ${grantedAtMs}`);
  }
  return grantedAtMs + safeTypeDef(type, config).unlockSeconds * 1_000;
}

/** Whether a `timer` open succeeds: once the server clock reaches `unlocksAt`, never before. */
export function safeTimerReady(unlocksAt: number, nowMs: number): boolean {
  return nowMs >= unlocksAt;
}

/**
 * Demo Mode tuning that `packages/economy` does not define yet. These only shape the in-browser
 * mock; the real server (T-1.07) owns its own values, and each one should move into the
 * economy config once it exists there (requested as a follow-up of T-1.09).
 */
export const MOCK_RULES = {
  /** Pre-minted, pre-paid coins kept ready for instant and offline drops. */
  bufferSize: 12,
  accessTokenTtlMs: 15 * 60_000,
  /** Decorum points one nudge adds, against the `decorumCapacity` upgrade stat. */
  decorumPerNudge: 18,
  decorumDecayPerSecond: 6,
  conciergeFreezeMs: 6_000,
  ticketsPerPull: 1,
  keysPerSafe: 1,
  /** Ticks per second of the fixed-step sim (`packages/sim` runs at 60 Hz). */
  ticksPerSecond: 60,
  /** How far a client's tick clock may run ahead of server time before it counts as sped up. */
  tickSlackMs: 1_500,
  /**
   * Paused sim time (offline, backgrounded tab) that may be replayed faster than real time.
   * Matches the 10-minute claim expiry, so a queued offline session still settles.
   */
  maxBankedMs: 10 * 60_000,
  /** Two drops closer together than this, in sim ticks, exceed the server-side drop rate cap. */
  minTicksBetweenDrops: 4,
  maxBodyBytes: 64 * 1024,
  /** Per-player request envelope; a legitimate client peaks near 25 requests a second. */
  maxRequestsPerSecond: 40,
  /** Away time shorter than this is a tab switch, not an offline session. */
  minOfflineMs: 60_000,
} as const;

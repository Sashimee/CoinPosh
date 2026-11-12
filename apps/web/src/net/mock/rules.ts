// TODO(economy): every number here except the transport limits belongs in packages/economy,
// and ticksPerSecond in packages/sim (TICK_RATE_HZ); tracked in #15 and #9.
export const MOCK_RULES = {
  /** Pre-minted, pre-paid coins kept ready for instant and offline drops. */
  bufferSize: 12,
  accessTokenTtlMs: 15 * 60_000,
  /** A resent token refresh gets its first answer back this long; after that the key is refused. */
  authRefreshReplayWindowMs: 10 * 60_000,
  /** Decorum points one nudge adds, against the `decorumCapacity` upgrade stat. */
  decorumPerNudge: 18,
  decorumDecayPerSecond: 6,
  conciergeFreezeMs: 6_000,
  ticketsPerPull: 1,
  keysPerSafe: 1,
  ticksPerSecond: 60,
  /** How far a client's tick clock may run ahead of server time before it counts as sped up. */
  tickSlackMs: 1_500,
  /**
   * A drop, claim or nudge whose tick maps to a server time older than this has expired
   * (01-ARCHITECTURE.md: claims expire after 10 minutes). The tick clock only re-anchors when the
   * player resumes after `minOfflineMs` away, and never for ticks it had already seen, so a queue
   * held back for longer cannot be passed off as fresh.
   */
  claimExpiryMs: 10 * 60_000,
  /** Two drops closer together than this, in sim ticks, exceed the server-side drop rate cap. */
  minTicksBetweenDrops: 4,
  /** A dropped coin cannot cross the table to an edge faster than this. */
  minFallMsAfterDrop: 1_500,
  /** A fused coin spawns mid-table, so it needs less time to reach an edge. */
  minFallMsAfterFusion: 250,
  /** A coin has to land and settle before it can touch two others. */
  minFusionMsAfterSpawn: 250,
  /** Sliding window, in sim time, of coins off any edge. */
  fallEnvelope: { windowMs: 1_000, max: 15, maxPerTick: 3 },
  fusionEnvelope: { windowMs: 60_000, max: 40 },
  maxBodyBytes: 64 * 1024,
  /** Per-player request envelope; a legitimate client peaks near 25 requests a second. */
  maxRequestsPerSecond: 40,
  /** Away time shorter than this is a tab switch, not an offline session. */
  minOfflineMs: 60_000,
  /**
   * How long a non-table response is kept for replay. Table responses are dropped after
   * `claimExpiryMs`, when their ticks have expired and a replay is refused anyway.
   */
  idempotencyTtlMs: 24 * 60 * 60_000,
  /** At most this many non-table responses are kept, newest first, whatever their age. */
  idempotencyRetained: 1_000,
  /** Ledger entries held in memory; older ones fold into a per-player checkpoint. */
  ledgerRetained: 2_000,
} as const;

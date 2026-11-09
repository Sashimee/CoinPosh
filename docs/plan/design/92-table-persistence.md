# Design: server-side table persistence (#92)

Status: accepted, scheduled as T-92.01..T-92.10 in `04-ROADMAP.md`. Refs #92, and it
touches #10, #84, #85 and #88.
Author: lead-architect. Date: 2026-11-09.

## Decisions (2026-11-09)

The founder answered the open questions of the first draft. The coordinator set the
defaults marked as such.

| # | Question | Decision |
| --- | --- | --- |
| D1 | Browser storage | IndexedDB may hold the last unsent snapshot, as a transport buffer only. The table itself lives on the server. (coordinator default) |
| D2 | Several tabs | The newest boot wins. The old tab shows a "Play here" button that takes the table back. |
| D3 | Demo Mode | Stays fresh on every reload. The mock implements the contract but persists nothing. |
| D4 | Heap coin without a valid pose | Laid again at its own heap slot, not returned to the house. |
| D5 | Crates (#88) | In scope. Crate ride state is posed, uploaded and restored like coins. |
| D6 | Data budget | Full snapshots for now. A delta format is a later perf item. (coordinator default) |
| D7 | Cadence | Settle 1 s, at least 3 s between uploads, heartbeat 10 s, server limit 1 per 2 s with a burst of 3. (coordinator default) |

After these decisions a boot refunds only **non-heap coins without a valid pose**. Heap
coins and crates are always back on the table: either at their pose or at their start
position (heap slot, crate chute).

## Goal

A reload restores the table exactly as the player left it: the same coins, in the same
places, at rest. The founder chose server-side storage. The server keeps the last
accepted pose of every coin and crate on the table and returns it on boot. The client
restores the sim and the crate rides from those poses. Only non-heap coins without a
usable pose are refunded, through the existing `hydrate=boot` rule.

Not in scope: mid-flight velocities, cross-device play beyond what the session lease
below gives us, and the other two points of #88 (buffer size 16 vs 12, and the prepaid
buffer blocking upgrades). #88 stays open for those.

## Invariants this design keeps

1. **The server owns value.** A snapshot carries positions and orientations only. It
   never states a value, a tier, a balance or a reward. No snapshot ever credits or
   debits anything. Values and tiers on restore come from the server's `coins` rows.
2. **`packages/sim` stays deterministic.** Restore is a pure function of
   `(seed, mechanics, quantized snapshot, tiers)`. It uses no wall clock and no
   `Math.random`, and it only does `+ - * / sqrt` on integers decoded to f32.
3. **Shared types live in `packages/shared`.** Physical bounds (table geometry) stay in
   `packages/sim` and reach the server through a Rapier-free subpath export.
4. **Demo Mode keeps working.** The mock implements the same contract in memory.

## Current state (what we build on)

- `GET /v1/state?hydrate=boot` runs `refundStranded`, then `seedOpeningHeap`, then
  `reserveBuffer`, all in one `transactionSync` (`apps/server/src/do/PlayerDO.ts`).
  Every non-heap coin on the table is refunded. The wallet gets `min(paidByVault, value)`
  and the house gets the rest. Heap coins survive, and the client lays them out again
  with `placeHeap`.
- The sim always starts at tick 0 with the fixed `TABLE_SEED`
  (`apps/web/src/main.ts`). Sim id `i` maps to `snapshot.coins[i]` through
  `ledger.bind` (`apps/web/src/game/systems/core.ts`).
- `coinOnTable(id, tick)` rejects a claim when `tick < dropped_tick`
  (`apps/server/src/do/entities.ts`). That matters as soon as a coin outlives a session
  whose tick clock restarts at 0.
- Signed requests carry `Authorization`, `X-CoinPosh-Signature` and `Idempotency-Key`
  headers, with bodies capped at `MAX_BODY_BYTES = 64 KiB`
  (`apps/server/src/http/signed.ts`).
- The client outbox lives in IndexedDB under the single key `'outbox'` (memoryStore in
  demo). It is ordered: a drop precedes its claims, and claims coalesce.

---

## 1. Sim: deterministic snapshot and restore (`packages/sim`)

### 1.1 Snapshot format (v1)

```ts
export const SIM_SNAPSHOT_VERSION = 1;

export type RestState = 'awake' | 'asleep' | 'frozen';

export interface CoinPose {
  readonly id: number;                        // sim id at snapshot time
  readonly p: readonly [number, number, number];          // int, units of 10 µm
  readonly q: readonly [number, number, number, number];  // int16, value * 32767, w >= 0
  readonly rest: RestState;
}

export interface SimTableSnapshot {
  readonly version: 1;
  readonly pusherTickInCycle: number;          // 0 .. PUSHER.periodTicks - 1
  readonly coins: readonly CoinPose[];         // ascending sim id
}
```

- **Position:** integers in 10 µm units, so `round(x / 1e-5)`. The table spans about
  ±0.25 m, which fits comfortably in an int32 and in JSON. 10 µm is 1/20 of
  `separationSlop` (0.2 mm), so quantization cannot create a visible overlap.
- **Rotation:** each component is `round(c * 32767)`, after making the quaternion
  canonical (`w >= 0`; if `w == 0`, the first non-zero component is positive). Decoding
  divides by 32767 and renormalizes with one `sqrt`. The angular error is under 0.01°.
- **Velocities: none.** Every coin restores with zero linear and angular velocity. We
  could not restore Rapier's warm-start impulses or island graph anyway, so velocities
  would not buy exactness. Leaving them out also removes a fling lever from the upload.
  A coin captured mid-motion simply resumes from rest at that pose.
- **Rest state:** `asleep` coins restore asleep, and `awake` coins restore awake.
  `frozen` is reserved for the future static-crust tier from the architecture doc,
  which the sim does not have today. Until that mechanic exists, `restore` refuses a
  `frozen` coin: `validateSnapshot` reports it and the server drops that pose. When the
  crust lands it gets its own SIM_VERSION bump. Note that `frozenUntil` in
  `TableSnapshot` is the Concierge nudge freeze, which is a different thing.
- **Pusher:** only `tickInCycle` is stored. On restore `cycles` resets to 0, there is no
  pending motion, and the motion parameters come from the server's upgrade levels as
  they do now.

### 1.2 API

```ts
// packages/sim/src/snapshot/snapshot.ts
sim.snapshot(): SimTableSnapshot;                   // quantized, pure read

// packages/sim/src/sim.ts
Sim.create({
  seed,
  mechanics,
  restore?: {
    pusherTickInCycle: number;
    coins: readonly RestoreEntry[];                // entry i becomes sim id i
  },
  openingHeap?: ...,                               // mutually exclusive with restore
});

type RestoreEntry =
  | { kind: 'pose'; pose: CoinPose; tier?: CoinTier }
  | { kind: 'heapSlot'; slot: number; tier?: CoinTier };   // D4
```

A `heapSlot` entry is a heap coin with no valid pose. It is laid again at its own slot
of the opening heap: slot `k` is the `k`-th pose `heapPoses` returns, computed exactly
as on the boot that first laid the heap. That means the pusher at phase 0,
`heapLayout(config)`, and a PRNG seeded from `seed`. `heapPoses` draws in slot order,
so pose `k` does not depend on how many coins are laid after it. A coin keeps its slot
for life: the server stores it when it seeds the heap (3.1). This relies on the table
seed being the same on every boot, which it is today (`TABLE_SEED` in `main.ts`). If
the seed is ever made per session (the TODO there), the heap seed must be stored with
the heap and sent in `layout`.

Restore rules, in order:

1. Validate the pose entries with `validateSnapshot` (1.3). Any failure throws: the
   server has already filtered the poses, so a failure here is a bug and must be loud.
2. Reset the tick to 0 and seed the PRNG from `seed`. A restore is a new session, not a
   continuation. Heap slots are computed with their own PRNG seeded from `seed`, so the
   main PRNG's state does not depend on which slots are used.
3. Set `pusherTickInCycle`.
4. Add the `pose` entries in order with `addCoin(translation, rotation)`, using the
   dequantized values.
5. Add the `heapSlot` entries at their slot pose. A slot that would overlap a coin
   already added, or the pusher at the restored phase, is lifted straight up until it
   clears, and that coin restores awake so it settles onto whatever is below.
6. Sim ids are `0..n-1` in entry order: sim id `i` is `table.coins[i]` of the boot
   response, the same convention as the heap today. `nextCoinId = n`. (Adding poses
   before slots does not change the ids: they are assigned from the entry index.)
7. Run one `CoinSeparator` pass to remove any quantization overlap.
8. Put `asleep` coins to sleep, except a coin that fails a support probe: a 1 mm
   downward shape cast that hits neither the floor nor another coin. Such a coin
   restores awake, so a floating coin never hangs in the air.
9. If mechanics are enabled: fusion streaks reset (they are not posed). A Sim with a
   champagne tower refuses `restore` in v1. Neither is live in the worker today
   (`fusion: null, tower: null`).

A restore where every entry is `heapSlot 0..n-1` lays the same table as
`openingHeap: { coins: n }` today. That case needs a test, because "no snapshot was
ever stored" boots through it (4.1).

`sim.snapshot()` of a freshly restored sim gives back the same quantized values for
every coin that restored asleep from a pose: `quantize(restore(q)) == q`.

### 1.3 Pose validation, shared with the server

`packages/sim/src/snapshot/validate.ts` is a pure module that does not import Rapier.
It is exported through a subpath `@coinposh/sim/snapshot`, so the worker can use it
without pulling in WASM. It only reads `PLAYFIELD`, `PUSHER`, `BACKBOARD`,
`GUTTER_START_Z` and `COIN` from `layout.ts`.

```ts
checkPose(pose: CoinPose, pusherTickInCycle: number): PoseVerdict;
validateSnapshot(s: SimTableSnapshot): { ok: CoinPose[]; dropped: { id; reason }[] };
```

A pose is valid when all of these hold:

- every number is a finite integer in range, and the decoded quaternion norm is within
  1 ± 1e-3 before renormalizing;
- `|x| <= fieldHalfWidth - COIN.radius`: inside the inner walls, not in a side gutter;
- `BACKBOARD.frontZ + COIN.radius <= z <= PLAYFIELD.fieldFrontZ`: the centre of mass is
  over the table, not past the lip;
- `-COIN.halfThickness <= y <= wallHeight`: above the floor and below the wall top;
- the coin does not overlap the pusher block at that `pusherTickInCycle`;
- across the whole snapshot, no two coins interpenetrate deeper than 1 mm (a uniform
  grid, O(n)).

Reasons: `non_finite`, `bad_rotation`, `out_of_bounds`, `in_pusher`, `overlap`,
`frozen_unsupported`. For an overlapping pair, the coin with the higher id is the one
dropped.

The same module also exports the crate ride bounds and `checkCratePose` (1.5), so the
server judges crates from the same numbers as the client.

### 1.5 Crate ride state (D5)

The sim has no crate body. A crate is a kinematic passenger of the pusher, driven by
`CrateRide` in `apps/web/src/game/crates/ride.ts`. Its state is small and fully
described by four values, so a crate pose is that state, not a rigid-body pose:

```ts
export interface CratePose {
  readonly x: number;          // int, 10 µm units
  readonly z: number;          // int, 10 µm units
  readonly elapsedMs: number;  // int, ride time so far
  readonly phase: 'riding' | 'teeter';
}
```

- `lastStroke` is not stored. On restore it is read from the restored pusher phase, so
  the first stroke after a reload does not jump the crate.
- A `fell` crate is never posed: its claim is already in the outbox.
- `CrateRide` gets `snapshot(): CratePose` and a `CrateRide.restore(crate, pose, stroke)`
  factory. This is client gameplay code, not the deterministic sim, so it needs no hash
  test, but it gets a round-trip test (the same path after restore as without a reload).
- The ride bounds (`CRATE_SIZE`, spawn z, step z, teeter z, tip z, side limit and the
  creep and carry rates) move into `@coinposh/sim/snapshot` as `CRATE_RIDE`, derived
  from `PLAYFIELD` and `PUSHER`. `ride.ts` imports them from there. The server then
  judges crates from the same numbers. `CRATE_SIZE` in
  `apps/web/src/vfx/cinematics/unbox/stage.ts` should then import it too (a follow-up
  for vfx-juice, which owns that file).

`checkCratePose(pose)` is valid when every value is a finite integer,
`|x| <= sideLimit`, `spawnZ <= z < tipZ`, `phase` matches `z` (`teeter` exactly when
`z >= teeterZ`), and `0 <= elapsedMs <= crateFallSeconds.max * 1000` (from
`packages/economy`, passed in by the caller, because sim does not depend on economy).

### 1.4 Determinism tests (extending the hash suite)

- **Round trip:** run 600 ticks from the heap, snapshot, restore twice into two fresh
  sims. The hashes are equal, then still equal after 3600 more ticks.
- **Pinned hash:** a checked-in snapshot fixture restored with a fixed seed matches a
  pinned `StateHasher` value after 0, 60 and 3600 ticks. The new `restore` path bumps
  `SIM_VERSION`.
- **Quantization fixed point:** for asleep coins, `quantize(restore(q)) == q`.
- **Restore stability (property test):** at pusher phases `0`, `periodTicks / 4`,
  `/2` and `3/4`, restore a settled table. Over 120 ticks every asleep coin moves less
  than 1 mm, and nothing falls that was not already falling. This is what makes a
  reload look like nothing happened.
- **Parity:** the round-trip hash is equal in Node and in the browser (the existing
  parity harness).
- **Validation:** table-driven tests for every reason in 1.3, including boundary values
  exactly on each limit, and the same for `checkCratePose`.
- **Heap slots:** a restore of all slots `0..n-1` hashes the same as
  `openingHeap: { coins: n }`. A restore that mixes poses and slots is deterministic
  (two runs hash equal). A slot that overlaps a posed coin is lifted, restores awake,
  and settles within 120 ticks with no spurious fall.

---

## 2. Wire contract (`packages/shared`)

### 2.1 Upload: `POST /v1/table/snapshot`

The request is signed and requires an `Idempotency-Key`, like every table POST.

```ts
export const MAX_SNAPSHOT_COINS = 320;   // the sim's capacity is 300 bodies
export const PoseTupleSchema = z.tuple([
  CoinIdSchema,
  z.int(), z.int(), z.int(),                   // x, y, z in 10 µm units, |v| <= 100_000
  z.int(), z.int(), z.int(), z.int(),          // qx, qy, qz, qw as int16
  z.enum(['awake', 'asleep']),
]);

export const TableSnapshotRequestSchema = z.strictObject({
  session: TableSessionIdSchema,
  seq: z.int().positive(),
  tick: TickSchema,
  pusher: z.strictObject({ tickInCycle: z.int().nonnegative() }),
  coins: z.array(PoseTupleSchema).max(MAX_SNAPSHOT_COINS),
  crates: z.array(CratePoseTupleSchema).max(MAX_SNAPSHOT_CRATES),
});

export const MAX_SNAPSHOT_CRATES = 16;
export const CratePoseTupleSchema = z.tuple([
  CrateIdSchema,
  z.int(), z.int(),                            // x, z in 10 µm units, |v| <= 100_000
  z.int().nonnegative(),                       // elapsedMs, <= 600_000
  z.enum(['riding', 'teeter']),
]);

export const TableSnapshotResponseSchema = z.object({
  seq: z.int().positive(),
  stored: AmountSchema,        // coin and crate poses accepted
  ignored: AmountSchema,       // poses dropped (unknown, gone, implausible)
});
```

- **Positions only.** Coins are named by server `CoinId`. The client maps sim id to
  `CoinId` through its ledger. There is no value, tier or wallet field, and `strictObject`
  rejects extra keys.
- **Size.** One tuple is about 80 bytes of JSON, so 250 coins is about 20 KB and 320 is
  about 26 KB. Crates add about 60 bytes each. That is well under `MAX_BODY_BYTES`, and
  under the 64 KiB keepalive quota even with a claims batch in flight. `frozen` is not on
  the wire in v1. Full snapshots are sent every time (D6). A delta format is a later perf
  item.
- **Range limits** (`|v| <= 100_000`, int16) are transport limits and live in shared.
  Whether a pose is physically plausible is decided by `checkPose` from the sim.
- **Errors:** new codes in `packages/shared/src/errors.ts`:
  - `session_superseded` (409): another tab or device booted the table (2.4);
  - `stale_snapshot` (409): `seq` or `tick` is not newer than what was stored;
  - `rate_limited` (429, existing) with `retryAfterMs`.

### 2.2 Cadence and triggers (client, D7)

| Trigger | When | Notes |
| --- | --- | --- |
| Settle | 1 s after the last drop or fall burst, at least 3 s since the last upload | The main path. |
| Heartbeat | Every 10 s, only if some coin moved more than one quantum | Catches pusher-driven creep. |
| Unchanged | Skipped | Compares quantized tuples with the last upload. |
| `visibilitychange` to hidden | Immediately | The page is still alive, so async signing works. |
| `pagehide` | Send the pre-signed latest request with `fetch(..., { keepalive: true })` | See below. |

**Why not `sendBeacon`.** A beacon cannot set `Authorization`, `X-CoinPosh-Signature`
or `Idempotency-Key`, and putting the signature in the body or query would mean a
second signing scheme. We do not add one.

**Keepalive and signing.** `pagehide` gives no time for async WebCrypto. So each time
the snapshot changes, the client signs it in the background and keeps one ready
`Request` (body, headers, idempotency key). `pagehide` only fires that request. Notes:

- A keepalive request with custom headers needs a CORS preflight. The normal snapshot
  POSTs warm the preflight cache (`maxAge: 600` today; raising it to 7200 is worth
  considering). Browser support for preflighted keepalive requests is uneven, so
  `pagehide` is best effort. The `visibilitychange` upload is the reliable one.
- The access token can expire between signing and firing. The pre-signed request is
  rebuilt when the token refreshes.

**Outbox.** The snapshot is a coalescing outbox op: only the newest unsent snapshot is
kept, and it is always ordered after every drop and claim queued before it. The outbox
is persisted, so a snapshot that missed `pagehide` is still sent on the next boot
(2.3). The browser stores only this pending request, as a transport buffer. The table
itself lives on the server (D1).

### 2.3 `GET /v1/state` returns the poses

`TableSnapshotSchema` (the existing state shape, not the sim type) gains two fields:

```ts
session: TableSessionIdSchema,              // rotated by every boot
layout: z.strictObject({
  pusher: z.strictObject({ tickInCycle: z.int().nonnegative() }),
  coins: z.array(CoinPlacementSchema),      // coins[i] places table.coins[i]
  crates: z.array(CratePlacementSchema),    // crates[i] places table.crates[i]
}).nullable(),                              // null unless hydrate=boot

CoinPlacementSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('pose'), pose: PoseTupleSchema }),
  z.strictObject({ kind: z.literal('heapSlot'), slot: z.int().nonnegative() }),
]);
CratePlacementSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('pose'), pose: CratePoseTupleSchema }),
  z.strictObject({ kind: z.literal('chute') }),   // ride starts again from the spawn point
]);
```

- `layout` is set only on `hydrate=boot`. On a plain resync the client keeps its own
  live sim, so `layout` is `null`.
- Every coin in `coins` has exactly one placement, in the same order, and the ids in
  `pose` tuples must equal `coins[i].id` (a schema refinement). A non-heap coin without
  a valid pose has already been refunded and is not in `coins` (section 4).
- A heap coin without a valid pose gets `heapSlot` (D4). With no snapshot ever stored,
  every coin is a heap coin with `heapSlot`, and `pusher.tickInCycle` is 0. That lays
  the same table as today's `placeHeap`.
- A crate without a valid pose gets `chute`: its ride starts again from the spawn point
  with `elapsedMs = 0` (D5).
- `TableSessionIdSchema` is a new branded entity id (prefix `session`) in `ids.ts`.

**Boot ordering.** On boot the client drains the persisted outbox (the claims and the
last snapshot of the previous session) **before** it calls `GET state?hydrate=boot`. Those
requests are judged under the old session, which is still current until the boot
rotates it. Only after that does the boot rotate the session.

### 2.4 Session on table mutations (#85)

`DropRequest`, `ClaimsRequest`, `NudgeRequest` and `TableSnapshotRequest` all carry
`session` in the signed body. The server rejects a non-current session with
`session_superseded`. The latest boot owns the table, so a second tab or device takes
the lease and the first tab is fenced off (4.4).

---

## 3. Server (`apps/server`)

### 3.1 Migration 5

```sql
CREATE TABLE table_snapshot (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  session     TEXT    NOT NULL,
  seq         INTEGER NOT NULL,
  tick        INTEGER NOT NULL,
  pusher_tick INTEGER NOT NULL,
  poses       TEXT    NOT NULL,   -- canonical JSON array of accepted PoseTuples
  crate_poses TEXT    NOT NULL,   -- canonical JSON array of accepted CratePoseTuples
  coin_count  INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);

ALTER TABLE coins ADD COLUMN heap_slot INTEGER;   -- NULL for every non-heap coin
```

- **Heap slots (D4).** `seedOpeningHeap` writes `heap_slot = 0..n-1` in the order it
  mints the heap, which is the order `placeHeap` lays it. The migration backfills
  existing heap coins by `rowid` rank within the latest `grant.heap` transaction, which
  is the same order. A table that is reseeded after it empties starts a new heap with
  slots from 0 again.

- **One row, one write per snapshot.** DO SQLite bills per row written. A row per coin
  would be 250 upserts × about 10 per minute, while a single JSON row is one write. We
  never query poses individually: they are read whole on boot and replaced whole on upload.
- New `MetaKey` values: `table_session` and `table_session_started_at`. The highest
  accepted table-op tick in the session is kept with them, as `table_session_max_tick`.
- Anomaly counters go in the existing `envelope_flags` table
  (`snapshot.foreign`, `snapshot.teleport`, `snapshot.implausible`) for Layer 3 audits.
- No D1 schema change. The 30 s flush does not need poses.

### 3.2 Validation pipeline for `POST /v1/table/snapshot`

Everything runs inside `mutate()` with the usual idempotency fingerprint, so a replayed
key returns the stored response and writes nothing.

1. **Session:** `session` must equal `meta.table_session`, otherwise
   `session_superseded`.
2. **Ordering:** `seq` must be greater than the stored `seq`, and `tick` must be at
   least `table_session_max_tick` (the latest drop or claim tick accepted in the
   session). Otherwise `stale_snapshot`. So a snapshot can never move the table back in
   time past a claim the server has already settled.
3. **Rate:** at most one accepted snapshot per 2 s per session, with a burst of 3,
   otherwise `rate_limited` with `retryAfterMs`. This uses the RateEnvelope primitive,
   once #10 wires it into PlayerDO.
4. **Structure:** duplicate `CoinId`s or a schema failure reject the whole request
   (`bad_request`).
5. **Ownership, per coin:**
   - not in this DO, or in the buffer: ignored, and `snapshot.foreign` is incremented;
   - claimed, fused, lost or refunded: ignored silently, because a claim can race a
     snapshot;
   - on the table: kept.
6. **Plausibility, per coin:** `checkPose` from `@coinposh/sim/snapshot`, then
   `validateSnapshot` over the set (for overlaps). Failures are dropped per coin and
   `snapshot.implausible` is incremented.
7. **Teleport:** compare each coin with its pose in the previously stored snapshot. If
   it moved more than `v_max · Δt + slack` (with `v_max` = 0.5 m/s of pusher plus
   cascade travel, `slack` = 2 cm, and Δt from the ticks), keep the old pose and
   increment `snapshot.teleport`. A coin with no previous pose (a new drop) is only
   checked by step 6.
8. **Crates (D5):** the same ownership rule against `crates` rows (on the table: kept;
   claimed or lost: ignored silently; unknown: ignored and `snapshot.foreign`
   incremented), then `checkCratePose`. Against the previous stored crate pose: `z`
   never decreases, `z` grows by at most `CRATE_RIDE` carry plus creep plus one forward
   nudge per Δt plus 1 cm of slack, and `elapsedMs` grows by at most Δt plus 1 s.
   Otherwise the old pose is kept and `snapshot.teleport` is incremented.
9. **Store:** replace the row with the accepted poses plus the kept old poses. Coins
   and crates on the table that this snapshot does not mention keep their previous
   pose: omitting one never deletes it.
10. **Never** touches the wallet, ledger, coins, crates or drop counts.

### 3.3 Anti-cheat analysis

**Baseline.** A modified client can already send any fall claim for any of its own coins
on the table. Layer 1 (`coinOnTable`, each coin claimed once, value from the server row)
and Layer 2 (fall envelopes, #10) bound that today, and Layer 3 replays it. A pose
cannot pay out by itself. A cheater only gains if a pose lets them do something a forged
claim could not already do. Case by case:

| Attack | What happens | Gain |
| --- | --- | --- |
| **Lip farming**: upload every coin at the front lip, then reload and let them fall | The poses must pass `checkPose` (centre of mass over the table). The teleport check keeps old poses for large jumps. Even an accepted lip pose only makes the fall honest-looking, and the claims still go through Layer 1 and 2 envelopes. | None beyond forging claims, which are already bounded. It does give a nicer replay start, so Layer 3 must treat the restored pose as a suspect start state (below). |
| **Teleporting** a coin across the table | Step 7 keeps the old pose and flags it. Small creep under the bound is possible over many snapshots, but the bound is about the pusher's real speed and the rate limit caps how often it applies. | Bounded drift. Anything it enables is again only a fall claim. |
| **Coins the client does not own** | Step 5 ignores them and flags them. | None. |
| **Buffer coins** posed onto the table | Ignored: a buffer coin is not on the table until its drop is accepted. | None. |
| **Omitting coins** to force refunds on boot | An omitted coin keeps its last pose (step 9). A non-heap coin never posed is refunded at `min(paidByVault, value)` to the wallet: never more than it cost. A heap coin never posed is laid again at its heap slot (D4), not refunded. | None, except crates (#84 below). |
| **Heap slot reset**: break a heap coin's pose on purpose so it returns to its slot | The slot is where the coin started on this table, so the player already had that position once. The pusher moves coins forward, so a slot is almost always further from the lip than the coin's current pose. | At most a coin back where it started. Bounded by the heap size and not repeatable per coin beyond its own slot. |
| **Crate lip farming**: upload a crate at the teeter point | `z` may only grow at the ride's real rate (step 8) and `elapsedMs` with real time, so a crate cannot reach the lip sooner than an honest ride. A crate whose pose is dropped returns to the chute, further from the lip. The crate claim is still judged by its own envelope (`crateFallSeconds`, #10). | None. |
| **Stale or replayed snapshots** | Idempotency returns the first response. Lower `seq` or a tick before a settled claim gives `stale_snapshot`. | None. |
| **Multiple tabs** (#85) | The newest boot rotates the session. Older tabs get `session_superseded` on every table mutation, so two sims can never write the same table. | None, and it fixes today's cross-tab refund. |
| **Flood** | 64 KiB body cap, 320 tuples, rate limit 1 per 2 s, one row write each. | Bounded cost. |

**The crate exception (#84).** Today the boot refund leaves `drop_count` and spawned
crates intact, so drop, refund and drop again can re-earn crate spawns. Persistence
makes refunds rarer but not impossible (an unposed non-heap coin is still refunded). So
T-92.03
fixes #84 first: crate spawns are driven by a high-water mark over net non-refunded
drops, and a refund lowers the count, so a refunded coin can never earn a crate twice.

**Audit start state.** Layer 3 replays segments from a known start state. After a
restore that start state is the stored snapshot, so the replay verifier must load it
through the same `Sim.create({ restore })` path. The server keeps the snapshot it
restored from with the session id for that purpose (the `table_snapshot` row as read at
boot is copied into `meta.table_session_origin`). The verifier wiring itself is follow-up
work, not part of this design.

**Limits that apply (#10).** The snapshot rate envelope above is new. Fall and fusion
envelopes are unchanged and remain the real economic limit. #10 must be wired before
the snapshot rate limit can use RateEnvelope. Until then T-92.04 uses a meta-stored
token bucket with the same numbers.

---

## 4. Boot flow

### 4.1 Server: `state({ hydrate: 'boot' })`, one `transactionSync`

1. **Rotate the session:** a new `table_session` id and
   `table_session_started_at = now`. Reset `table_session_max_tick = 0`.
2. **Place every on-table coin**, in `rowid` order. The stored poses are re-checked with
   `checkPose` and `validateSnapshot`, in case the geometry changed under a new
   SIM_VERSION. Then each coin falls into one case:
   - **valid pose:** restored with `{ kind: 'pose' }`;
   - **heap coin (`heap_slot` set) without a valid pose:** laid again with
     `{ kind: 'heapSlot', slot }` (D4). Nothing is refunded;
   - **any other coin without a valid pose:** goes through `refundStranded` unchanged
     and is left out of `coins`.

   Every coin that stays has its `dropped_tick` rebased to 0, so claims in the new
   session (whose ticks start at 0) pass `coinOnTable`. With no snapshot row (the first
   boot after this ships, or a new player) every coin has no pose. Heap coins are laid at
   their slots and everything else is refunded, which is today's behaviour.
3. **Place every on-table crate (D5):** a valid stored crate pose gives
   `{ kind: 'pose' }`, otherwise `{ kind: 'chute' }`. Either way `spawned_tick` is rebased
   to 0 for the same reason as coins. A crate is never refunded: it was minted by the
   house, not paid for, and it stays on the table until it is claimed or lost. This
   covers the "crates in flight" point of #88.
4. `seedOpeningHeap` still runs only when the table is empty, unchanged except that it
   writes `heap_slot`. The fresh heap is all `heapSlot` entries.
5. `reserveBuffer` is unchanged. Buffer coins are never posed.
6. The `table_snapshot` row is replaced by exactly what was restored (poses only, not
   slots or chutes), with `seq = 0` under the new session. A copy is kept as the
   session's audit start state (3.3).
7. `layout.pusher.tickInCycle` is the stored pusher phase, or 0 without a snapshot.

### 4.2 Client

1. Drain the persisted outbox under the old session (2.3). If the old session was
   superseded, those ops fail with `session_superseded`. Claims are then lost (and their
   coins refunded by the next boot), and a stale snapshot is dropped. That is the correct
   outcome when another tab owns the table.
2. `GET /v1/state?hydrate=boot`, keeping the current retry with backoff.
3. `openingTableCoins` (`apps/web/src/net/openingTable.ts`) becomes
   `openingLayout(state)`. It returns the sim `restore` input (pusher phase plus one
   `RestoreEntry` per coin, with its tier) and the crate placements. It throws if `coins`
   and `layout.coins`, or `crates` and `layout.crates`, do not line up.
4. The worker bridge init takes `restore` in place of `openingHeap`. The worker runs
   `Sim.create({ seed, mechanics, restore })`. `openingHeap` stays for tests and tools.
5. The game systems bind sim id `i` to `coins[i]`, the same as the heap today.
6. The crate controller starts each crate with `CrateRide.restore` for a `pose` and a
   fresh `CrateRide` for `chute`.
7. `TableSync` stores `session` and puts it on every table op.

### 4.3 Demo Mode (the mock)

`createMockServer()` implements the endpoint, the session rotation, the same validation
(it imports `@coinposh/sim/snapshot`), and the `layout` field, all in memory. That gives
contract parity and lets the e2e suite drive the full restore path without a server.

Persistence across reloads does not change in Demo Mode: tokens live in memoryStore,
so every reload is a new guest with a fresh heap. That matches the architecture, which
keeps Demo Mode stateless, and it stays that way (D3). The mock's restore path is
exercised by an in-page re-boot against the same mock instance (T-92.09), not by a page
reload.

### 4.4 Superseded tab

On `session_superseded` from any table op, the client stops the sim's input, drops its
outbox ops for the old session, and shows a "This table is open elsewhere" overlay with
a "Play here" button. "Play here" runs a normal boot, which takes the lease back. The
strings go through i18next (EN/FR/DE). Because the IndexedDB `'outbox'` key is shared by
all tabs, the outbox must be partitioned by session (the key becomes
`outbox:<session>`), or one tab's drain would send another tab's ops.

---

## 5. Task breakdown

The tasks are scheduled in `04-ROADMAP.md` under "M9: Table persistence (#92)" and
tracked in `STATUS.md`. The roadmap block is the source of truth. The summary here is
for reading the design in one place.

| ID | Agent | Deps | Scope | Parallel |
| --- | --- | --- | --- | --- |
| T-92.01 | lead-architect | none | Shared contracts: snapshot endpoint, coin and crate pose tuples, `layout`, session, error codes | yes (ready) |
| T-92.02 | physics-engineer | none | Sim snapshot and restore with heap slots, `@coinposh/sim/snapshot` with `checkPose`, `validateSnapshot`, `CRATE_RIDE`, `checkCratePose`, hash tests | yes (ready) |
| T-92.03 | backend-engineer | none | #84: crate spawns cannot be re-earned through refunds | yes (ready) |
| T-92.04 | backend-engineer | .01, .02, .03 | Migration 5 (`table_snapshot`, `heap_slot`), snapshot endpoint and validation for coins and crates, boot placement | after .03 |
| T-92.05 | backend-engineer | .01, .02 | Net layer: snapshot outbox op, cadence, keepalive pre-signing, drain before boot, session, `openingLayout`, mock parity | with .04 |
| T-92.06 | physics-engineer | .02 | Worker bridge `restore` init and `snapshot()` | with .04, .05 |
| T-92.10 | gameplay-engineer | .02 | `CrateRide` snapshot and restore on `CRATE_RIDE` | with .04, .05, .06 |
| T-92.07 | gameplay-engineer | .05, .06, .10 | Boot glue, sim and crate binding, snapshot triggers, "Play here" overlay | after .05, .06, .10 |
| T-92.08 | backend-engineer | .04 | Session lease on every table op (#85) | with .05, .07 |
| T-92.09 | qa-perf | .07, .08, T-1.17 | E2E: restore after re-boot, two tabs | last |

Critical path: T-92.02 → T-92.04 → T-92.08, and T-92.02 → T-92.05 → T-92.07 → T-92.09.
T-92.03, T-92.04 and T-92.08 all edit `apps/server/src/do/PlayerDO.ts`, so they run one
after another by their deps. T-92.09 also waits on T-1.17, which brings the Playwright
harness and is blocked today.

## Follow-ups (not scheduled here)

- vfx-juice: `CRATE_SIZE` in `apps/web/src/vfx/cinematics/unbox/stage.ts` should import
  `CRATE_RIDE.size` from `@coinposh/sim/snapshot` once T-92.02 lands, so the cinematic
  and the ride cannot drift apart.
- physics-engineer: the replay verifier (T-4.03) must start a segment from the
  session's restored snapshot through `Sim.create({ restore })`.
- perf: a delta snapshot format (D6) once real traffic numbers exist.
- #88: the buffer size mismatch (16 vs 12) and the prepaid buffer blocking upgrades are
  still open.
- lead-architect: consider raising CORS `maxAge` from 600 to 7200 so the `pagehide`
  keepalive more often finds a warm preflight (2.2).

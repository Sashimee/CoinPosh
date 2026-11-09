# Design: server-side table persistence (#92)

Status: proposal, not implemented. Refs #92, and it touches #10, #84, #85 and #88.
Author: lead-architect. Date: 2026-11-09.

## Goal

A reload restores the table exactly as the player left it: the same coins, in the same
places, at rest. The founder chose server-side storage. The server keeps the last
accepted pose of every coin on the table and returns it on boot. The client restores
the sim from those poses. Only coins without a usable pose are refunded, through the
existing `hydrate=boot` rule.

Not in scope: crate poses (the sim does not model crates yet, see #88), mid-flight
velocities, and cross-device play beyond what the session lease below gives us.

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
    snapshot: SimTableSnapshot;
    tiers: readonly CoinTier[];                    // tiers[i] is for snapshot.coins[i]
  },
  openingHeap?: ...,                               // mutually exclusive with restore
});
```

Restore rules, in order:

1. Validate with `validateSnapshot` (1.3). Any failure throws: the caller has already
   filtered poses on the server, so a failure here is a bug and must be loud.
2. Reset the tick to 0 and reseed the PRNG from `seed`. A restore is a new session, not
   a continuation.
3. Add the coins in snapshot order with `addCoin(translation, rotation)`, using the
   dequantized values. Sim ids are `0..n-1` in snapshot order. That is the same
   convention as the heap: sim id `i` is `table.coins[i]` of the boot response.
   `nextCoinId = n`.
4. Set `pusherTickInCycle`.
5. Run one `CoinSeparator` pass to remove any quantization overlap.
6. Put `asleep` coins to sleep, except a coin that fails a support probe: a 1 mm
   downward shape cast that hits neither the floor nor another coin. Such a coin
   restores awake, so a floating coin never hangs in the air.
7. If mechanics are enabled: fusion streaks reset (they are not posed). A Sim with a
   champagne tower refuses `restore` in v1. Neither is live in the worker today
   (`fusion: null, tower: null`).

`sim.snapshot()` of a freshly restored sim gives back the same quantized values for
every coin that restored asleep: `quantize(restore(q)) == q`.

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
  exactly on each limit.

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
});

export const TableSnapshotResponseSchema = z.object({
  seq: z.int().positive(),
  stored: AmountSchema,        // poses accepted
  ignored: AmountSchema,       // poses dropped (unknown, gone, implausible)
});
```

- **Positions only.** Coins are named by server `CoinId`. The client maps sim id to
  `CoinId` through its ledger. There is no value, tier or wallet field, and `strictObject`
  rejects extra keys.
- **Size.** One tuple is about 80 bytes of JSON, so 250 coins is about 20 KB and 320 is
  about 26 KB. That is well under `MAX_BODY_BYTES`, and under the 64 KiB keepalive quota
  even with a claims batch in flight. `frozen` is not on the wire in v1.
- **Range limits** (`|v| <= 100_000`, int16) are transport limits and live in shared.
  Whether a pose is physically plausible is decided by `checkPose` from the sim.
- **Errors:** new codes in `packages/shared/src/errors.ts`:
  - `session_superseded` (409): another tab or device booted the table (2.4);
  - `stale_snapshot` (409): `seq` or `tick` is not newer than what was stored;
  - `rate_limited` (429, existing) with `retryAfterMs`.

### 2.2 Cadence and triggers (client)

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
itself lives on the server (see open question Q1).

### 2.3 `GET /v1/state` returns the poses

`TableSnapshotSchema` (the existing state shape, not the sim type) gains two fields:

```ts
session: TableSessionIdSchema,              // rotated by every boot
layout: z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('heap') }),
  z.strictObject({
    kind: z.literal('poses'),
    pusher: z.strictObject({ tickInCycle: z.int().nonnegative() }),
    poses: z.array(PoseTupleSchema),        // poses[i] is for coins[i], same CoinId
  }),
]).nullable(),                              // null unless hydrate=boot
```

- `layout` is set only on `hydrate=boot`. On a plain resync the client keeps its own
  live sim, so `layout` is `null`.
- With `kind: 'poses'`, every coin in `coins` has a pose, in the same order. Any coin
  without one has already been refunded and is not in `coins` (section 4).
- With `kind: 'heap'`, `coins` are heap-tier coins only, laid out by `placeHeap`, which
  is what happens today.
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
  coin_count  INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);
```

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
8. **Store:** replace the row with the accepted poses plus the kept old poses. Coins
   on the table that this snapshot does not mention keep their previous pose: omitting
   a coin never deletes it.
9. **Never** touches the wallet, ledger, coins, crates or drop counts.

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
| **Omitting coins** to force refunds on boot | An omitted coin keeps its last pose (step 8). A coin never posed is refunded at `min(paidByVault, value)` to the wallet: never more than it cost. Heap coins without a pose refund 0 to the wallet. | None, except crates (#84 below). |
| **Stale or replayed snapshots** | Idempotency returns the first response. Lower `seq` or a tick before a settled claim gives `stale_snapshot`. | None. |
| **Multiple tabs** (#85) | The newest boot rotates the session. Older tabs get `session_superseded` on every table mutation, so two sims can never write the same table. | None, and it fixes today's cross-tab refund. |
| **Flood** | 64 KiB body cap, 320 tuples, rate limit 1 per 2 s, one row write each. | Bounded cost. |

**The crate exception (#84).** Today the boot refund leaves `drop_count` and spawned
crates intact, so drop, refund and drop again can re-earn crate spawns. Persistence
makes refunds rarer but not impossible (an unposed coin is still refunded). So T-92.03
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
2. **If a `table_snapshot` row exists:**
   - each on-table coin that has a pose, and whose pose still passes `checkPose`
     (re-checked in case the geometry changed under a new SIM_VERSION), is restored.
     Its `dropped_tick` is rebased to 0, so claims in the new session (whose ticks
     start at 0) pass `coinOnTable`;
   - each on-table coin without a valid pose goes through `refundStranded` unchanged.
     A heap coin without a pose has `paidByVault = 0`, so its whole value goes back to
     the house;
   - the response carries `layout: { kind: 'poses', ... }` in `rowid` order.
3. **If no snapshot was ever stored** (first boot after this ships, or a new player):
   today's behaviour. Heap coins stay and are laid out by `placeHeap`
   (`layout: { kind: 'heap' }`), and everything else is refunded.
4. `seedOpeningHeap` still runs only when the table is empty, unchanged. A fresh heap
   has no poses, so it gets `kind: 'heap'`.
5. `reserveBuffer` is unchanged. Buffer coins are never posed.
6. Crates: unchanged by this design. They stay on the table without poses until the sim
   models them (#88).
7. The stored row is cleared and replaced by the restored set, with `seq = 0` under the
   new session.

A table can never mix heap layout and poses: either every coin has a pose or the
response is `kind: 'heap'`. If some heap coins have poses and others do not, the ones
without are refunded, so the poses case still holds.

### 4.2 Client

1. Drain the persisted outbox under the old session (2.3). If the old session was
   superseded, those ops fail with `session_superseded`. Claims are then lost (and their
   coins refunded by the next boot), and a stale snapshot is dropped. That is the correct
   outcome when another tab owns the table.
2. `GET /v1/state?hydrate=boot`, keeping the current retry with backoff.
3. `openingTableCoins` (`apps/web/src/net/openingTable.ts`) becomes
   `openingLayout(state)`. It returns `{ kind: 'heap', coins }` or
   `{ kind: 'poses', snapshot, tiers }`, and it throws if `coins` and `poses` do not line
   up.
4. The worker bridge init takes `restore` instead of `openingHeap` when the layout is
   poses. The worker runs `Sim.create({ seed, mechanics, restore })`.
5. The game systems bind sim id `i` to `coins[i]`, the same as the heap today.
6. `TableSync` stores `session` and puts it on every table op.

### 4.3 Demo Mode (the mock)

`createMockServer()` implements the endpoint, the session rotation, the same validation
(it imports `@coinposh/sim/snapshot`), and the `layout` field, all in memory. That gives
contract parity and lets the e2e suite drive the full restore path without a server.

Persistence across reloads does not change in Demo Mode: tokens live in memoryStore,
so every reload is a new guest with a fresh heap. That matches the architecture, which
keeps Demo Mode stateless. Whether demo players should keep their table is open
question Q3.

### 4.4 Superseded tab

On `session_superseded` from any table op, the client stops the sim's input, drops its
outbox ops for the old session, and shows a "This table is open elsewhere" overlay with
a "Play here" button. "Play here" runs a normal boot, which takes the lease back. The
strings go through i18next (EN/FR/DE). Because the IndexedDB `'outbox'` key is shared by
all tabs, the outbox must be partitioned by session (the key becomes
`outbox:<session>`), or one tab's drain would send another tab's ops.

---

## 5. Task breakdown

Each task follows the `04-ROADMAP.md` format. Tasks marked **parallel** can start at the
same time as the others in their group.

### T-92.01 · Shared contracts for table persistence  (parallel with T-92.02, T-92.03)
- **agent:** lead-architect
- **deps:** none
- **owns:** `packages/shared/src/api/table.ts`, `packages/shared/src/api/endpoints.ts`, `packages/shared/src/ids.ts`, `packages/shared/src/errors.ts`, `packages/shared/test/**`
- **accept:**
  - `TableSnapshotRequest`/`Response`, `PoseTuple` and `MAX_SNAPSHOT_COINS` are added, and `POST /v1/table/snapshot` is in the endpoints map with `requiresIdempotencyKey`;
  - `TableSessionId` and the `session` field are on drop, claims and nudge requests;
  - `TableSnapshot` gains `session` and `layout`;
  - the `session_superseded` and `stale_snapshot` error codes exist;
  - schema tests cover the size limits (320 accepted, 321 rejected), extra keys, int ranges and the `layout` alignment;
  - `pnpm check` is green.

### T-92.02 · Sim snapshot, restore and pose validation  (parallel with T-92.01, T-92.03)
- **agent:** physics-engineer
- **deps:** none
- **owns:** `packages/sim/src/snapshot/**`, `packages/sim/src/sim.ts`, `packages/sim/src/table/table.ts`, `packages/sim/src/table/pusher.ts`, `packages/sim/package.json` (subpath export), `packages/sim/test/**`
- **accept:**
  - `sim.snapshot()` and `Sim.create({ restore })` work as in section 1;
  - `@coinposh/sim/snapshot` exports `checkPose` and `validateSnapshot` and does not import Rapier (checked by a test);
  - every test in 1.4 passes: round trip, pinned hash with a SIM_VERSION bump, quantization fixed point, restore stability at four pusher phases, and Node/browser parity;
  - `pnpm --filter @coinposh/sim check` is green.

### T-92.03 · Crate spawns cannot be re-earned through refunds (#84)  (parallel with T-92.01, T-92.02)
- **agent:** backend-engineer
- **deps:** none
- **owns:** `apps/server/src/do/PlayerDO.ts` (crate spawn path), `apps/server/src/do/schema.ts`, `apps/server/test/**`
- **accept:**
  - crate spawns use a high-water mark over net non-refunded drops;
  - a test drops, boot-refunds and drops again, and gets no second crate for the same spend;
  - closes #84.

### T-92.04 · Server: pose storage, snapshot endpoint, boot restore
- **agent:** backend-engineer
- **deps:** T-92.01, T-92.02, T-92.03
- **owns:** `apps/server/src/do/schema.ts` (migration 5), `apps/server/src/do/PlayerDO.ts`, `apps/server/src/do/entities.ts`, `apps/server/src/do/snapshot.ts`, `apps/server/src/routes/table.ts`, `apps/server/test/**`
- **accept:**
  - migration 5 applies on top of an existing v4 DO;
  - the validation pipeline in 3.2, with one test per step and per row of the 3.3 table;
  - boot restores posed coins with `dropped_tick = 0` and refunds only unposed ones (wallet gets at most what it paid; unposed heap coins go to the house);
  - a claim at new-session tick 0 is accepted for a restored coin;
  - an idempotent replay writes no row;
  - no snapshot path writes to the ledger (checked by a test);
  - `pnpm --filter @coinposh/server check` is green.

### T-92.05 · Net layer: snapshot op, cadence, keepalive, drain before boot, mock  (parallel with T-92.04)
- **agent:** backend-engineer
- **deps:** T-92.01
- **owns:** `apps/web/src/net/**`
- **accept:**
  - a coalescing snapshot outbox op is ordered after drops and claims;
  - the outbox is partitioned by session;
  - the triggers in 2.2 work and are tested with a fake clock;
  - one pre-signed keepalive request is kept for `pagehide` and rebuilt when the token refreshes;
  - the outbox drains before `hydrate=boot`;
  - `session` is on every table op;
  - the mock implements the endpoint, the session and the layout, with contract tests shared with the server;
  - `openingLayout` replaces `openingTableCoins`.

### T-92.06 · Worker bridge: restore init  (parallel with T-92.05 once T-92.02 lands)
- **agent:** physics-engineer
- **deps:** T-92.02
- **owns:** `apps/web/src/game/simWorker/**`
- **accept:**
  - the init message takes `restore` (mutually exclusive with `openingHeap`) and validates it;
  - the worker exposes `snapshot()` to the main thread at the cadence's request;
  - a bridge test restores, steps and hashes the same as `Sim` directly.

### T-92.07 · Boot glue, binding and superseded overlay
- **agent:** gameplay-engineer
- **deps:** T-92.05, T-92.06
- **owns:** `apps/web/src/main.ts`, `apps/web/src/game/systems/**`, `apps/web/src/ui/overlays/TableElsewhere.tsx`, `apps/web/src/i18n/locales/*/table.json`
- **accept:**
  - boot picks heap or restore from `layout` and binds sim id `i` to `coins[i]`;
  - snapshot triggers are wired to the sim's settle and fall events and to `visibilitychange`/`pagehide`;
  - the superseded overlay has "Play here", EN/FR/DE strings and a reduced-motion variant;
  - no console errors.

### T-92.08 · Session lease enforcement on all table ops (#85)
- **agent:** backend-engineer
- **deps:** T-92.01, T-92.04
- **owns:** `apps/server/src/do/PlayerDO.ts`, `apps/server/src/routes/table.ts`, `apps/server/test/**`
- **accept:**
  - drop, claims, nudge and snapshot from a non-current session return `session_superseded` and write nothing;
  - a second boot fences the first session;
  - a boot no longer refunds coins another live tab is playing (they are restored from its poses);
  - closes #85.

### T-92.09 · E2E: reload restores the table
- **agent:** qa-perf
- **deps:** T-92.07, T-92.08
- **owns:** `apps/web/e2e/table-persistence.spec.ts`
- **accept:**
  - in Demo Mode with the mock: drop 20 coins, wait for the settle upload, then reload in the same mock session. Every coin's position matches within 1 mm, the wallet is unchanged, and no refund happened;
  - two tabs: the first shows the overlay, and "Play here" takes the lease back;
  - frame time on boot stays within the existing budget.

Critical path: T-92.02 → T-92.04 → T-92.08 → T-92.09, with T-92.01 and T-92.03 running
alongside T-92.02, and T-92.05, T-92.06 and T-92.07 running alongside T-92.04.

---

## Open questions for the founder

- **Q1. Browser storage as a transport buffer.** The design keeps the last unsent
  snapshot (and pending claims, as today) in IndexedDB, so a missed `pagehide` is sent
  on the next boot. The table itself lives on the server. Is that acceptable, or must
  the browser hold nothing at all (in which case a missed `pagehide` falls back to the
  last periodic snapshot, at most about 10 s old)?
- **Q2. Takeover.** The newest boot wins and the older tab shows "Play here". Or should
  the newer tab ask first, or should play be refused while another session is live?
- **Q3. Demo Mode persistence.** Demo stays stateless on reload. Should demo players
  keep their table, which would need demo identity in local storage?
- **Q4. Data budget.** Full snapshots are about 20 KB every few seconds while playing.
  Is that fine on mobile data, or do we want a delta format (v2) before launch?
- **Q5. Unposed heap coins.** A heap coin with no valid pose goes back to the house
  (the wallet never paid for it). Or should it be re-laid by `placeHeap` instead?
- **Q6. Crates.** They stay out of scope until the sim models them (#88). Do you want
  them in this wave, which would add a sim crate body first?
- **Q7. Cadence numbers.** Settle 1 s, a minimum of 3 s between uploads, heartbeat 10 s,
  and a server rate of 1 per 2 s (burst 3). Do these match how often you want a reload
  to be exact?

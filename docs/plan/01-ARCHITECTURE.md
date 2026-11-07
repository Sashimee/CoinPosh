# CoinPosh: Technical Architecture

## Stack (pin exact latest-stable versions during T-0.01; record them in `docs/plan/STACK.lock.md`)

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript (strict), ESM everywhere | One language for client, sim and server |
| Monorepo | pnpm workspaces + Turborepo | Parallel builds, cached tasks, clean package boundaries |
| Client bundler | Vite | Fast HMR, GitHub Pages static output |
| UI | React 19 + Tailwind v4 + Motion (framer-motion) | Polished animated UI layer over the canvas |
| 3D | three.js **WebGPURenderer** (auto-fallback WebGL2) + **TSL** node materials, @react-three/fiber v9, drei | Modern GPU path, shaders written once for both backends |
| Post FX | three TSL post-processing (bloom, DoF, chromatic, vignette, tonemapping AgX/ACES) | Luxe look |
| Physics | **@dimforge/rapier3d** (WASM, deterministic build) | Fast, deterministic, runs in browser *and* in the server auditor |
| State | zustand (UI/meta), sim state owned by `packages/sim` | Clear split between sim and presentation |
| Audio | Web Audio API, custom procedural synth + Howler-free loader | Juice with zero latency |
| i18n | i18next (EN/FR/DE), ICU plurals, `Intl.NumberFormat` compact numbers | Day-1 localization |
| Server | **Cloudflare Workers** + **Hono** + **D1** (SQLite) + **Durable Objects** + Queues + Cron Triggers | Edge-fast authoritative economy, per-player serialized state |
| Validation | zod schemas shared in `packages/shared` | One contract for client and server |
| ORM | Drizzle (D1 driver) + migrations | Typed SQL |
| Tests | Vitest (unit/sim), Playwright (e2e, visual), fast-check (property tests for economy) | Determinism and economy invariants |
| CI/CD | GitHub Actions → GitHub Pages (client), `wrangler deploy` (server) | Auto deploy on main |
| Mobile | Capacitor 7+ (`apps/mobile`), plugins: Haptics, Motion, Push, App Attest/Play Integrity, IAP (later) | Same build in the stores |

## Repo layout

```
CoinPosh/
├─ apps/
│  ├─ web/                 # Vite + React + R3F client (GitHub Pages)
│  │  ├─ src/app/          # boot, routing, providers           (owner: ui-engineer)
│  │  ├─ src/ui/           # HUD, menus, shop, album, modals    (owner: ui-engineer)
│  │  ├─ src/scene/        # venues, lighting, materials, camera(owner: render-artist)
│  │  ├─ src/vfx/          # particles, unbox cinematics, shake (owner: vfx-juice)
│  │  ├─ src/audio/        # synth, music director, mixer       (owner: audio-engineer)
│  │  ├─ src/game/         # client systems glue: drops, charms,
│  │  │                    # combo, crates flow, quests view    (owner: gameplay-engineer)
│  │  ├─ src/net/          # API client, session, offline queue (owner: backend-engineer)
│  │  └─ e2e/              # Playwright                         (owner: qa-perf)
│  ├─ server/              # Cloudflare Worker (Hono)           (owner: backend-engineer)
│  │  ├─ src/routes/  src/do/ (PlayerDO, EventDO)  src/rng/  src/audit/
│  │  └─ migrations/
│  └─ mobile/              # Capacitor shell (M7)               (owner: mobile-engineer)
├─ packages/
│  ├─ sim/                 # deterministic table simulation     (owner: physics-engineer)
│  ├─ shared/              # zod API contracts, ids, types      (owner: lead-architect)
│  └─ economy/             # balance tables, formulas, sim CLI  (owner: economy-designer)
├─ docs/plan/              # this plan
└─ .claude/                # agents + workflows
```

**File ownership is the parallelism contract.** A task may only modify paths its
agent owns, plus files the task lists explicitly. Cross-boundary changes go
through `packages/shared` contracts, which lead-architect owns. Only
lead-architect edits root config such as `package.json`, `turbo.json` and the CI
workflows.

## Anti-cheat: "the client renders, the server owns value"

GitHub Pages only serves static files, so trust lives entirely on the Worker.
The client is assumed to be fully compromised: memory editors, modified JS,
replayed requests, sped-up clocks.

### Layer 1: Conservation ledger (primary, makes forging value impossible)
- **The server mints every coin.** A drop request (`POST /v1/table/drop {x, tick}`)
  debits the player's server balance and returns coin entity IDs, tiers and
  values. Those IDs are the only coins that can exist on the table.
- When a coin falls off the edge, the client reports `{coinId, tick, edge}` in
  signed batches. The PlayerDO checks that the ID exists, is on the table, and
  has not already been claimed, then credits its value **as stored on the server**.
  Value can't be inflated because the server never reads a value from the client.
- **Fusion** reports `{ids[3], tick}`. The server checks that all three are on
  the table and share a tier, then mints the fused coin. Value stays conserved
  except for the defined fusion bonus.
- **Crates/safes** are server entities, and their contents are rolled on the
  server when they are claimed.
- Result: the best a cheater can do is play *perfectly*, collecting at most
  what's physically on their table. That is bounded by the next layer.

### Layer 2: Rate envelopes (bounds "perfect play" bots)
- Each table configuration (upgrades plus charms) has a server-computed
  **max plausible throughput** (coins/sec off the edge, fusions/min), derived
  offline by `packages/economy` from simulated runs at the 99.9th percentile.
- The PlayerDO keeps a sliding window. Claims above the envelope are rejected
  and soft-flagged, and the player is silently moved to an "unranked" shadow pool.
- Drop rate is capped server-side, since drops cost server balance anyway.

### Layer 3: Deterministic replay audits (spot checks)
- `packages/sim` runs Rapier with a fixed 60 Hz timestep, a deterministic WASM
  build, a seeded PRNG (xoshiro128**), and no `Math.random` or `Date` in the sim.
- The client streams compact **input logs** (drops, nudges, pours) together with
  a state hash every 300 ticks.
- A Queue consumer (Workers Paid, or a small self-hosted verifier container)
  replays a sampled segment and compares hashes. Mismatches flag the account.
  Leaderboard-top players are always audited.

### Layer 4: Provably fair RNG (also a player-facing feature)
- Per player: a `serverSeed` (secret, committed as `sha256(serverSeed)`), a
  `clientSeed` (player can change it), and a `nonce`.
  `roll = HMAC_SHA256(serverSeed, clientSeed:nonce)`.
- On seed rotation the old seed is revealed, and the Album shows a "Verify my
  rolls" page. All crates, safes, gacha and scratch cards use it.

### Layer 5: Identity and transport hygiene
- Guest account = server-issued UUID + refresh token (httpOnly not possible on
  Pages, so short-lived JWT access token in memory + rotating refresh token in
  IndexedDB, bound to a device key via WebCrypto non-extractable ECDSA key;
  every request signed).
- Cloudflare Turnstile on account creation; per-IP and per-account rate limits.
- Server-time only: offline earnings, timers, safes and Golden Hour all use the
  server clock. The client clock is never trusted.
- Mobile: App Attest (iOS) / Play Integrity (Android) tokens in M7.
- Idempotency keys on every mutating request (replay-safe).

### Offline-tolerant play
Short network drops shouldn't kill the fun. The client keeps playing on a
**pre-minted coin buffer** (the server hands out N coin IDs in advance), queues
claims, and reconciles on reconnect. Claims expire after 10 minutes. The HUD
shows "provisional" value with a subtle shimmer until the server confirms.

## Server data model (D1 + Durable Objects)

- **PlayerDO** (one per player): live table state (coin IDs on the table, crates,
  combo window), rate envelope windows, RNG nonce. Single-threaded, so there are
  no race conditions. It flushes to D1 every 30 s and on important events.
- **EventDO**: weekly Heist / leaderboard shards, Golden Hour schedule.
- **D1 tables**: `players`, `wallets` (coins, pearls, bullion, keys, tickets, stars),
  `upgrades`, `charms`, `album_entries`, `safes`, `quests`, `season_progress`,
  `ledger` (append-only audit log of every value change), `rng_seeds`, `flags`,
  `leaderboard_weekly`.
- Cron: Golden Hour scheduling, quest rotation, season rollover, leaderboard close.

## API surface (v1, zod in `packages/shared/src/api`)

```
POST /v1/auth/guest            POST /v1/auth/refresh
GET  /v1/state                 (full snapshot incl. offline earnings settlement)
POST /v1/table/drop            POST /v1/table/claims   (batch: falls, fusions, crate pushes)
POST /v1/table/nudge           POST /v1/table/inputs   (input log + hash for audits)
POST /v1/upgrades/buy          POST /v1/charms/equip
POST /v1/crates/open           POST /v1/safes/open     POST /v1/gacha/pull   POST /v1/scratch/reveal
POST /v1/ascend                GET  /v1/album          GET  /v1/fair/seeds   POST /v1/fair/rotate
GET  /v1/quests                POST /v1/quests/claim   GET  /v1/season
GET  /v1/leaderboard/:board    GET  /v1/events/current
```

## Rendering architecture and performance budgets

- Coins are **InstancedMesh** per tier (one draw call per tier). The physics
  transforms are copied into instance matrices each frame. Bodies sleep
  aggressively.
- Max 300 active rigid bodies. Coins far back on the table are frozen into
  "static crust" bodies.
- Physics runs in a **Web Worker** (Rapier in a worker; transforms shared via
  SharedArrayBuffer when cross-origin isolated, else transferable Float32Array
  ring). Render interpolates between sim ticks.
- Budgets: **60 fps on iPhone 12 / Pixel 6a**, 120 fps on ProMotion where
  possible; initial JS ≤ 350 KB gzip (3D chunk lazy); TTI ≤ 3 s on 4G; GPU
  memory ≤ 256 MB; KTX2/Basis textures, Draco/meshopt geometry.
- Adaptive quality: dynamic resolution scaling, plus post-FX tiers chosen by a
  benchmark on first boot.

## GitHub Pages deployment

- `vite.config` uses `base: '/CoinPosh/'`. Routing is hash- or state-based (no
  server routes). A `404.html` copy is kept for deep links.
- `.github/workflows/deploy-web.yml` builds and deploys with actions/deploy-pages
  on every push to `main`.
- `.github/workflows/deploy-server.yml` runs wrangler deploy (requires repo
  secret `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, a **human step**).
- `VITE_API_URL` points at the Worker. Without it, the client runs in clearly
  labelled **Demo Mode** (local mock server, unranked, no persistence), so
  agents can build everything before Cloudflare is configured.

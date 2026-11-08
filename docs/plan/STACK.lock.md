# Stack lock

Exact versions in use. Every `package.json` pins exact versions (no `^`/`~`), and
`pnpm-workspace.yaml` sets `saveExact: true` so `pnpm add` keeps it that way.
`pnpm-lock.yaml` is committed; CI must install with `pnpm i --frozen-lockfile`.
Only lead-architect changes this file. Bump a version here in the same commit
that bumps it in a `package.json`.

Recorded 2026-11-07 (T-0.01). Caught up 2026-11-07 (P-3, P-4, P-5, P-6) with T-0.02 to T-0.05,
T-1.04 and T-1.13, then (P-27, P-7, P-30) with T-1.07 and the client deps for T-1.09 and T-1.11.

New third-party versions must be at least two weeks old when they are pinned.

## Toolchain

| Tool | Version | Where | Notes |
|---|---|---|---|
| Node.js | 24.20.0 | `.nvmrc`, root `engines` | Active LTS line |
| pnpm | 12.4.2 | root `packageManager`, `engines` | `engineStrict: true`; build scripts allowed only for `esbuild`, `workerd` |
| Turborepo | 2.11.10 | root | Tasks: `build`, `typecheck`, `lint`, `test`, `e2e`, `dev` |
| TypeScript | 6.0.3 | root | Not 7.x: `typescript-eslint` 8.72.1 supports `>=4.8.4 <6.1.0` |
| ESLint | 10.14.0 | root, `packages/sim` | Flat config `eslint.config.js`, exports `coinposhConfig` for per-package extension. `packages/sim` declares it too because `src/lint.test.ts` imports `eslint` to prove the determinism rules fire; verified with `--config.hoist=false --config.public-hoist-pattern=` |
| @eslint/js | 10.0.1 | root | |
| typescript-eslint | 8.72.1 | root | `strictTypeChecked` + `stylisticTypeChecked`, project service |
| eslint-config-prettier | 10.1.8 | root | |
| globals | 17.14.0 | root | |
| Prettier | 3.9.10 | root | `.prettierrc.json` |
| Vitest | 4.1.12 | `apps/web`, `apps/server`, `packages/shared`, `packages/sim`, `packages/economy` | `@cloudflare/vitest-plugin` 1.6.0 (`apps/server`) peers on `vitest ^4.1.0 \|\| ^5.0.0` |
| @types/node | 24.19.2 | `packages/shared`, `packages/sim`, `packages/economy`, `apps/web` (e2e suite) | Node 24 line, matches `.nvmrc`; also the version vite, vitest and wrangler resolve against |

## Shared types (`packages/shared`)

| Package | Version | Notes |
|---|---|---|
| zod | 4.6.7 | Runtime schemas behind the shared types, validated at trust boundaries |

## Simulation (`packages/sim`)

| Package | Version | Notes |
|---|---|---|
| @dimforge/rapier3d-deterministic-compat | 0.21.0 | Cross-platform deterministic build of Rapier, WASM inlined (`-compat`) so it loads in browsers and Workers alike |

## Economy (`packages/economy`)

| Package | Version | Notes |
|---|---|---|
| fast-check | 4.10.2 | Property tests for economy invariants (dev only) |

## Client (`apps/web`)

| Package | Version | Notes |
|---|---|---|
| vite | 8.3.6 | Rolldown bundler; resolves esbuild 0.28.2 transitively |
| three | 0.187.0 | `three/webgpu` `WebGPURenderer`, automatic WebGL2 fallback |
| @types/three | 0.187.0 | Matches `three`. Pulls in `@dimforge/rapier3d-compat` 0.12.0 transitively (types for `three/addons/physics`); nothing imports it, and the client's physics stays behind `@coinposh/sim` |
| i18next | 26.5.7 | Every UI string, EN/FR/DE (T-1.11); no React binding while the HUD is plain DOM. 26.5.7 is the newest release at least two weeks old on 2026-11-07; optional `typescript` peer resolves to 6.0.3 |
| zod | 4.6.7 | Same version as `packages/shared`, so wire schemas validated in the client (T-1.09 `src/net`) are the shared ones |
| @coinposh/shared | `workspace:*` | Wire types and schemas (T-1.09) |
| @coinposh/economy | `workspace:*` | Economy numbers for the Demo Mode mock server (T-1.09) |
| @playwright/test | 1.64.1 | E2E and perf gates (T-1.17), `apps/web/e2e`. Drives Chromium 1248 (Chrome for Testing 156.0.8078.4) pinned to WebGL2 on SwiftShader. 1.65.0 (2026-11-05) was under two weeks old on 2026-11-08 |

T-1.04 (`src/scene`) and T-1.13 (`src/audio`) added no packages: the scene uses `three/webgpu`,
`three/tsl` and `three/addons` from `three` 0.187.0, and all audio is synthesized with the Web
Audio API. The one vendored asset is `src/scene/env/hdri/venice_sunset_512.hdr` (Poly Haven,
CC0), pinned by SHA-256 in `src/scene/env/hdri/SOURCES.md`; audio provenance lives in
`public/audio/CREDITS.md`.

Planned, added by the owning task through lead-architect: React 19, @react-three/fiber 9,
drei, Tailwind v4, Motion, zustand. Physics is not planned here: Rapier
lives in `packages/sim` (above), and the client will reach it only through `@coinposh/sim`.

## Server (`apps/server`)

| Package | Version | Notes |
|---|---|---|
| hono | 4.13.16 | 4.13.17 was under pnpm's minimum release age on 2026-11-07 |
| zod | 4.6.7 | Same version as `packages/shared`; validates every request body at the Worker boundary |
| @coinposh/shared | `workspace:*` | Wire types and schemas |
| @coinposh/economy | `workspace:*` | The only source of economy numbers on the server |
| @cloudflare/vitest-plugin | 1.6.0 | Runs Worker tests inside workerd (T-1.07); replaces the `@cloudflare/vitest-pool-workers` 0.23.0 that was planned. Peers on `vitest ^4.1.0 \|\| ^5.0.0` |
| wrangler | 4.158.0 | Bundles workerd 1.20261104.1 |
| @cloudflare/workers-types | 5.20261104.1 | Matches wrangler's peer range `^5.20261104.1` |

Worker config (`apps/server/wrangler.jsonc`): `compatibility_date` 2026-10-31, D1 binding
`DB` → database `coinposh` (`d68b147d-653d-40a6-bca4-f07997f40fd3`). The account ID comes
from the `CLOUDFLARE_ACCOUNT_ID` environment variable, not the config file.

## CI actions (`.github/workflows`)

Every `uses:` is pinned to a full commit SHA with the release tag as a trailing comment.
Bump the SHA and the comment together, and update this table in the same commit.

| Action | Version | Commit | Used in |
|---|---|---|---|
| actions/checkout | v7.0.1 | `3d3c42e5aac5ba805825da76410c181273ba90b1` | `ci.yml`, `perf.yml`, `deploy-web.yml`, `deploy-server.yml` |
| pnpm/action-setup | v6.1.0 | `ea17c68df8912ef543352723c149a84f56e3d413` | `ci.yml`, `perf.yml`, `deploy-web.yml`, `deploy-server.yml` |
| actions/setup-node | v7.1.0 | `949feb2413d6458794dcd2491c4babbbce0c15c1` | `ci.yml`, `perf.yml`, `deploy-web.yml`, `deploy-server.yml` |
| actions/configure-pages | v6.0.0 | `45bfe0192ca1faeb007ade9deae92b16b8254a0d` | `deploy-web.yml` |
| actions/upload-pages-artifact | v5.0.0 | `fc324d3547104276b827a68afc52ff2a11cc49c9` | `deploy-web.yml` |
| actions/deploy-pages | v5.0.1 | `368f82528645a54fb793d4d04e342629a3f51346` | `deploy-web.yml` |
| actions/upload-artifact | v7.0.2 | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` | `ci.yml`, `perf.yml` (screenshots, perf report, Playwright report) |

`actions/cache` is not in use yet. P-31 adds it; its SHA is recorded here when P-31 integrates.

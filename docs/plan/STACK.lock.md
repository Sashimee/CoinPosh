# Stack lock

Exact versions in use. Every `package.json` pins exact versions (no `^`/`~`), and
`pnpm-workspace.yaml` sets `saveExact: true` so `pnpm add` keeps it that way.
`pnpm-lock.yaml` is committed; CI must install with `pnpm i --frozen-lockfile`.
Only lead-architect changes this file. Bump a version here in the same commit
that bumps it in a `package.json`.

Recorded 2026-11-07 (T-0.01).

## Toolchain

| Tool | Version | Where | Notes |
|---|---|---|---|
| Node.js | 24.20.0 | `.nvmrc`, root `engines` | Active LTS line |
| pnpm | 12.4.2 | root `packageManager`, `engines` | `engineStrict: true`; build scripts allowed only for `esbuild`, `workerd` |
| Turborepo | 2.11.10 | root | Tasks: `build`, `typecheck`, `lint`, `test`, `e2e`, `dev` |
| TypeScript | 6.0.3 | root | Not 7.x: `typescript-eslint` 8.72.1 supports `>=4.8.4 <6.1.0` |
| ESLint | 10.14.0 | root | Flat config `eslint.config.js`, exports `coinposhConfig` for per-package extension |
| @eslint/js | 10.0.1 | root | |
| typescript-eslint | 8.72.1 | root | `strictTypeChecked` + `stylisticTypeChecked`, project service |
| eslint-config-prettier | 10.1.8 | root | |
| globals | 17.14.0 | root | |
| Prettier | 3.9.10 | root | `.prettierrc.json` |
| Vitest | 4.1.12 | `apps/web`, `apps/server` | Held on 4.1.x: `@cloudflare/vitest-pool-workers` 0.23.0 (for T-1.07) peers on `vitest ^4.1.0` |

## Client (`apps/web`)

| Package | Version | Notes |
|---|---|---|
| vite | 8.3.6 | Rolldown bundler; resolves esbuild 0.28.2 transitively |
| three | 0.187.0 | `three/webgpu` `WebGPURenderer`, automatic WebGL2 fallback |
| @types/three | 0.187.0 | Matches `three` |

Planned, added by the owning task through lead-architect: React 19, @react-three/fiber 9,
drei, Tailwind v4, Motion, zustand, i18next, Playwright, @dimforge/rapier3d.

## Server (`apps/server`)

| Package | Version | Notes |
|---|---|---|
| hono | 4.13.16 | 4.13.17 was under pnpm's minimum release age on 2026-11-07 |
| wrangler | 4.158.0 | Bundles workerd 1.20261104.1 |
| @cloudflare/workers-types | 5.20261104.1 | Matches wrangler's peer range `^5.20261104.1` |

Worker config (`apps/server/wrangler.jsonc`): `compatibility_date` 2026-10-31, D1 binding
`DB` → database `coinposh` (`d68b147d-653d-40a6-bca4-f07997f40fd3`). The account ID comes
from the `CLOUDFLARE_ACCOUNT_ID` environment variable, not the config file.

# Polish backlog

Items from playtests and out-of-scope requests. The planner schedules `ready` items as `P-<n>` tasks.

Format: `- [ready|scheduled|done] P-<n> · <title> · agent: <agent> · owns: <paths> · accept: <criteria>`

<!-- playtester / integrator append below -->
- [ready] P-1 · CI installs with frozen lockfile and tunes the three.js chunk warning (raised by T-0.01, fold into T-0.03) · agent: lead-architect · owns: `.github/workflows/**`, `apps/web/vite.config.ts` · accept: CI runs `pnpm i --frozen-lockfile`; `build.chunkSizeWarningLimit` set (or the lazy three.js chunk documented as expected) so `pnpm build` prints no chunk-size warning
- [ready] P-2 · Verify WebGPU rendering on real GPU hardware (raised by T-0.01; headless software-GPU Chromium destroys the WebGPU device even without three.js) · agent: lead-architect · owns: `.github/workflows/**`, `apps/web/e2e/**` · accept: the black canvas renders via WebGPURenderer on a GPU-backed browser (local device or GPU CI runner), and the WebGL2 fallback is logged where WebGPU is unavailable

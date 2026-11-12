import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

// CI runners pair two SMT vCPUs per physical core. Rapier gains no throughput from the second
// thread, so a worker per vCPU only halves each test's speed (measured in #134).
const ciWorkers = Math.max(1, Math.floor(availableParallelism() / 2));

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 60_000,
    ...(process.env.CI ? { maxWorkers: ciWorkers } : {}),
  },
});

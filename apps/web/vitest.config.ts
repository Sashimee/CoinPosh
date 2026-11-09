import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Wall-clock gates run alone in vitest.perf.config.ts, after every other suite has finished.
    exclude: [...configDefaults.exclude, 'src/**/*.perf.test.ts'],
  },
});

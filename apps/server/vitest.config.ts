import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          // A fixed, test-only signing key; production reads the AUTH_SECRET worker secret.
          AUTH_SECRET: 'test-only-auth-secret-0123456789abcdef',
          TURNSTILE_MODE: 'off',
          TEST_MIGRATIONS: migrations,
        },
      },
    }),
  ],
  test: {
    include: ['src/**/*.test.ts'],
    setupFiles: ['./src/test/setup.ts'],
  },
});

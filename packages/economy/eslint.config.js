import { defineConfig } from 'eslint/config';
import { coinposhConfig } from '../../eslint.config.js';

// Economy numbers feed server-authoritative rewards and a reproducible balancing sim,
// so every random draw goes through the seeded PRNG in src/rng.ts and nothing reads a clock.
export default defineConfig(...coinposhConfig, {
  files: ['src/**/*.ts', 'sim/**/*.ts'],
  rules: {
    'no-restricted-properties': [
      'error',
      { object: 'Math', property: 'random', message: 'Use createRng() from src/rng.ts.' },
      { object: 'performance', property: 'now', message: 'Economy code must be time-free.' },
    ],
    'no-restricted-globals': [
      'error',
      { name: 'Date', message: 'Economy code must be time-free; pass time in explicitly.' },
    ],
  },
});

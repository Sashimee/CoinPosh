import { defineConfig } from 'eslint/config';
import { coinposhConfig } from '../../eslint.config.js';

// Contracts run in the browser, the Worker and the sim; Node types exist here only for tests.
export default defineConfig(coinposhConfig, {
  files: ['src/**/*.ts'],
  ignores: ['src/**/*.test.ts', 'src/test/**'],
  rules: {
    'no-restricted-imports': [
      'error',
      { patterns: [{ regex: '^node:', message: 'Shared contracts must stay platform-neutral.' }] },
    ],
    'no-restricted-globals': [
      'error',
      { name: 'Buffer', message: 'Shared contracts must stay platform-neutral.' },
      { name: 'process', message: 'Shared contracts must stay platform-neutral.' },
    ],
  },
});

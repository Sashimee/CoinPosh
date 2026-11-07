import { defineConfig } from 'eslint/config';
import { coinposhConfig } from '../../eslint.config.js';
import { determinismConfig } from './eslint.determinism.js';

export default defineConfig(coinposhConfig, determinismConfig);

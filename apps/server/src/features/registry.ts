import type { ServerFeature } from './types.ts';

/**
 * Every server feature the deployed worker mounts and its PlayerDO serves. Only wiring tasks
 * add entries; a feature's own task builds and tests it with `createFeatureHarness`.
 */
export const SERVER_FEATURES: readonly ServerFeature[] = [];

export {
  COIN_SHADOW_LAYER,
  CoinField,
  type CoinFieldOptions,
  type CoinFieldStats,
} from './coin-field.ts';
export { bakeCoinEmboss, type CoinEmbossBake } from './emboss.ts';
export {
  createCoinGeometry,
  FAR_COIN_GEOMETRY,
  NEAR_COIN_GEOMETRY,
  NEAR_COIN_TRIANGLE_BUDGET,
  type CoinGeometryOptions,
} from './geometry.ts';
export {
  acquireWebGL2Context,
  COIN_WEBGL2_ATTRIBUTES,
  coinBackend,
  describeGpuLoss,
  watchGpuLoss,
  type CoinBackend,
  type CoinGpuLoss,
  type GpuLossWatch,
  type GpuLossWatchOptions,
  type WatchableRenderer,
  type WebGL2ContextOptions,
} from './gpu-health.ts';
export { DEFAULT_LOD_SETTINGS, type LodSettings } from './lod.ts';
export {
  COIN_LOOKS,
  COIN_TIER_IDS,
  isCoinTierId,
  type CoinLook,
  type CoinTierId,
} from './tiers.ts';

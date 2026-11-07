// TODO(lead-architect): add "@coinposh/sim": "workspace:*" to apps/web/package.json and import
// '@coinposh/sim' here; must land before the bridge is wired into main.ts. Until then this
// relative path is the only place apps/web reaches into packages/sim, and Turbo does not see the
// edge, so sim changes do not rebuild or retest apps/web. Requested in T-1.03's review fix round.
export {
  COIN,
  MAX_DROP_OFFSET_MM,
  Sim,
  TICK_RATE_HZ,
  type CoinState,
  type EngineInfo,
  type SimInput,
} from '../../../../../packages/sim/src/index.ts';

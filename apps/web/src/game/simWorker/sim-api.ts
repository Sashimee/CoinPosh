// apps/web does not list @coinposh/sim as a dependency yet (requested from lead-architect for
// apps/web/package.json). Until it does, this is the only file that reaches into the package, and
// only through its public index; swap the path for '@coinposh/sim' once the dependency lands.
export {
  COIN,
  MAX_DROP_OFFSET_MM,
  Sim,
  TICK_RATE_HZ,
  type CoinState,
  type EngineInfo,
  type SimInput,
} from '../../../../../packages/sim/src/index.ts';

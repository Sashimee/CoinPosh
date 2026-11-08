// The render thread loads this module, so its values come only from the Rapier-free layout
// entry; the Sim itself is imported from '@coinposh/sim' by the worker side alone.
export {
  COIN,
  COIN_DROP_HEIGHT,
  MAX_DROP_OFFSET_MM,
  NUDGE_DIRECTIONS,
  TICK_RATE_HZ,
  type NudgeDirection,
} from '@coinposh/sim/layout';
export type {
  CoinState,
  ContactEvent,
  ContactSurface,
  EngineInfo,
  FallEdge,
  FallEvent,
  FusionEvent,
  MechanicsConfig,
  OpeningHeap,
  PusherState,
  SimEvents,
  SimInput,
  SimOptions,
} from '@coinposh/sim';

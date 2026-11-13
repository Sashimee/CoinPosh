// The render thread loads this module, so its values come only from the Rapier-free layout
// entry; the Sim itself is imported from '@coinposh/sim' by the worker side alone.
import type { SimOptions } from '@coinposh/sim';

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
export type { CoinPose as SnapshotPose, SimTableSnapshot } from '@coinposh/sim/snapshot';

/** A saved table for the worker's Sim to lay instead of an opening heap; see Sim's SimRestore. */
export type SimRestore = NonNullable<SimOptions['restore']>;
/** One coin of a SimRestore: a pose from a snapshot, or a heap coin laid again at its slot. */
export type RestoreEntry = SimRestore['coins'][number];

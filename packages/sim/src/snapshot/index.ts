/**
 * The `@coinposh/sim/snapshot` entry: the table snapshot format and the pose and crate
 * checks the server runs before it stores or restores one. It must never load Rapier, so
 * the worker can judge snapshots without the WASM; validate.test.ts walks its import
 * graph to keep it that way.
 */
export {
  type CoinPose,
  dequantizePosition,
  dequantizeRotation,
  POSITION_UNIT,
  type PropPoseSnapshot,
  type PropSnapshot,
  quantizePosition,
  quantizeRotation,
  type RestState,
  ROTATION_UNIT,
  SIM_SNAPSHOT_VERSION,
  type SimTableSnapshot,
} from './snapshot.ts';
export {
  checkCratePose,
  checkPose,
  COIN_OVERLAP_TOLERANCE,
  CRATE_RIDE,
  type CratePose,
  type CrateRejection,
  type CrateVerdict,
  POSE_OVERLAP_TOLERANCE,
  type PoseRejection,
  type PoseVerdict,
  ROTATION_NORM_TOLERANCE,
  type SnapshotVerdict,
  validateSnapshot,
} from './validate.ts';
export { DEFAULT_PUSHER_MOTION, type PusherMotion } from '../table/pusher.ts';

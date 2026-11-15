import { Vector3 } from 'three/webgpu';
import { RIVIERA_TABLE } from '../venues/riviera/layout.ts';

const T = RIVIERA_TABLE;
const BACKBOARD_TOP = T.pusherHeight + 0.004 + T.backboardHeight;

/**
 * Where a figure stands, in table space: in the cabinet's back bay between the backboard and
 * the cabinet back, off to one side so the Vault plaque over the crest never hides it, its waist
 * below the backboard top so only the head, the shoulders and the prop peek over the wall.
 */
export const BOSS_STAND = {
  x: 0.142,
  y: BACKBOARD_TOP - 0.07,
  z: T.backboardFrontZ - T.backboardDepth - 0.06,
  /** Turned a touch towards the middle of the table, where the cascades fall. */
  yaw: -0.32,
  /** Figure size over its modelled proportions. */
  scale: 1.1,
} as const;

/** The stand for a figure on the `side` of the cabinet (+1 right, -1 left, from the player). */
export function bossStand(side: 1 | -1 = 1): { position: Vector3; yaw: number } {
  return {
    position: new Vector3(side * BOSS_STAND.x, BOSS_STAND.y, BOSS_STAND.z),
    yaw: side * BOSS_STAND.yaw,
  };
}

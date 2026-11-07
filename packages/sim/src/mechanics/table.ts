import type { Rotation, Vector } from '@dimforge/rapier3d-deterministic-compat';
import type { TableCoin } from '../table/table.ts';

/**
 * What the table mechanics need from the coin table, in metres. PusherTable provides
 * `coins` and `addCoin`; `removeCoin` takes a coin off the table without reporting a
 * fall, which is how a fusion consumes its inputs and the tower takes a coin onto its
 * stack.
 */
export interface MechanicTable {
  /** Every coin on the table, in ascending id order. */
  coins(): readonly TableCoin[];
  /** Places a coin at an exact pose and returns its id, which is higher than any before it. */
  addCoin(translation: Readonly<Vector>, rotation: Readonly<Rotation>): number;
  /** Removes a coin that is on the table. Throws for an id that is not. */
  removeCoin(id: number): void;
}

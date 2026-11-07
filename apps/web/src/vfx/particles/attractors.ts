import { ATTRACTOR_SLOTS } from './layout.ts';
import { createAttractors } from './physics.ts';

export interface AttractorLease {
  readonly slot: number;
  readonly id: number;
}

/**
 * The fusion centres homing sparks fly to. Each fusion leases a slot for its implosion; with
 * all of them held (five fusions inside one implosion window) the oldest is stolen, since its
 * implosion is nearly done and re-aiming its last sparks costs the least. Leases carry an id,
 * so a fusion whose slot was stolen frees nothing when its own release comes round.
 */
export class AttractorTable {
  /** `ATTRACTOR_SLOTS` × (x, y, z, unused), shared with the particle step. */
  readonly positions = createAttractors();
  /** Lease id holding each slot, 0 when free; ids only grow, so the smallest is the oldest. */
  private readonly holders = new Array<number>(ATTRACTOR_SLOTS).fill(0);
  private lastId = 0;

  get held(): number {
    return this.holders.filter((id) => id !== 0).length;
  }

  lease(x: number, y: number, z: number): AttractorLease {
    const { holders } = this;
    let slot = holders.indexOf(0);
    if (slot < 0) slot = holders.indexOf(Math.min(...holders));
    const id = ++this.lastId;
    holders[slot] = id;
    this.positions.set([x, y, z], slot * 4);
    return { slot, id };
  }

  release(lease: AttractorLease): void {
    if (this.holders[lease.slot] === lease.id) this.holders[lease.slot] = 0;
  }

  clear(): void {
    this.holders.fill(0);
  }
}

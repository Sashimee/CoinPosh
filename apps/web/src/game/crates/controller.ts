import type {
  CrateId,
  NudgeDirection,
  PityCounters,
  Reward,
  TableCrate,
  Tick,
} from '@coinposh/shared';
import type { Bus } from '../../app/bus.ts';
import type { ApiClient, TableEvent, TableSync } from '../../net/index.ts';
import type { CrateEvents } from './events.ts';
import { albumProgress, rollHasAlbumCard, type AlbumProgressMap } from './loot.ts';
import { CrateRide } from './ride.ts';

/** The slice of `SimBridge` crates read: the sim clock for claims and the pusher for the ride. */
export interface CrateSimPort {
  readonly stats: { readonly tick: number; readonly pusherStroke: number };
}

export interface CrateControllerOptions {
  readonly table: Pick<TableSync, 'subscribe' | 'claimCrate'>;
  readonly client: Pick<ApiClient, 'call'>;
  readonly sim: CrateSimPort;
  readonly events: Bus<CrateEvents>;
}

/**
 * Takes each crate the server spawns from table arrival to rolled contents: rides it across the
 * table, reports the fall as a claim through `TableSync`, and once the server accepts it asks the
 * server to open it. Nothing here decides what is inside; the roll and wallet are the server's.
 */
export class CrateController {
  private readonly options: CrateControllerOptions;
  private readonly rides = new Map<CrateId, CrateRide>();
  private readonly awaitingClaim = new Set<CrateId>();
  private readonly opening = new Map<CrateId, Promise<void>>();
  private readonly unsubscribe: () => void;
  private latestPity: PityCounters | null = null;
  private disposed = false;

  constructor(options: CrateControllerOptions) {
    this.options = options;
    this.unsubscribe = options.table.subscribe((event) => {
      this.handle(event);
    });
  }

  /** Crates riding the table, in spawn order. */
  get riding(): readonly CrateRide[] {
    return [...this.rides.values()];
  }

  /** The server's pity counters after the latest open this session, or `null` before one. */
  get pity(): PityCounters | null {
    return this.latestPity;
  }

  /** Resolves once every open in flight has answered (and its events have gone out). */
  async settled(): Promise<void> {
    await Promise.all([...this.opening.values()]);
  }

  /** Crates already on the table when the session loads (`state.table.crates`). */
  adopt(crates: readonly TableCrate[]): void {
    for (const crate of crates) this.spawn(crate);
  }

  update(dt: number): void {
    if (this.disposed) return;
    const stroke = this.options.sim.stats.pusherStroke;
    for (const ride of this.rides.values()) {
      const before = ride.phase;
      const after = ride.update(dt, stroke);
      this.onPhase(ride, before, after);
    }
  }

  /** A table nudge rocks every crate on it; a forward one can tip a teetering crate over. */
  nudge(direction: NudgeDirection, strength: number): void {
    if (this.disposed) return;
    for (const ride of this.rides.values()) {
      const before = ride.phase;
      ride.nudge(direction, strength);
      this.onPhase(ride, before, ride.phase);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.rides.clear();
  }

  private handle(event: TableEvent): void {
    if (this.disposed) return;
    switch (event.type) {
      case 'dropSettled':
        for (const crate of event.spawnedCrates) this.spawn(crate);
        break;
      case 'claimSettled': {
        const { claim, result } = event;
        if (claim.kind !== 'crate' || !this.awaitingClaim.delete(claim.crateId)) break;
        if (result.status === 'accepted') {
          this.options.events.emit('crate:claimed', { crateId: claim.crateId });
          this.open(claim.crateId);
        } else {
          this.options.events.emit('crate:rejected', {
            crateId: claim.crateId,
            reason: result.reason,
          });
        }
        break;
      }
      case 'claimsFailed':
        for (const claim of event.claims) {
          if (claim.kind !== 'crate' || !this.awaitingClaim.delete(claim.crateId)) continue;
          this.options.events.emit('crate:failed', { crateId: claim.crateId, error: event.error });
        }
        break;
      default:
        break;
    }
  }

  private spawn(crate: TableCrate): void {
    if (this.rides.has(crate.id) || this.awaitingClaim.has(crate.id)) return;
    const ride = new CrateRide(crate, this.options.sim.stats.pusherStroke);
    this.rides.set(crate.id, ride);
    this.options.events.emit('crate:spawned', {
      crateId: crate.id,
      kind: crate.kind,
      position: ride.position,
    });
  }

  private onPhase(ride: CrateRide, before: CrateRide['phase'], after: CrateRide['phase']): void {
    if (before === after) return;
    const crateId = ride.crate.id;
    if (after === 'teeter') {
      this.options.events.emit('crate:teeter', { crateId, position: ride.position });
      return;
    }
    if (after !== 'fell') return;
    if (before === 'riding') {
      this.options.events.emit('crate:teeter', { crateId, position: ride.position });
    }
    this.rides.delete(crateId);
    this.awaitingClaim.add(crateId);
    const tick: Tick = Math.max(0, Math.floor(this.options.sim.stats.tick));
    this.options.events.emit('crate:fell', { crateId, tick, position: ride.position });
    this.options.table.claimCrate(crateId, tick, 'front');
  }

  private open(crateId: CrateId): void {
    if (this.opening.has(crateId)) return;
    const request = this.request(crateId).finally(() => this.opening.delete(crateId));
    this.opening.set(crateId, request);
  }

  /** Only the server call can fail the open; once it answers, the wallet is already credited. */
  private async request(crateId: CrateId): Promise<void> {
    const opened = await this.options.client
      .call('cratesOpen', { body: { crateId } })
      .catch((error: unknown) => {
        if (!this.disposed) this.options.events.emit('crate:failed', { crateId, error });
        return null;
      });
    if (opened === null || this.disposed) return;
    this.latestPity = opened.roll.pity;
    this.options.events.emit('crate:opened', {
      crateId,
      roll: opened.roll,
      wallet: opened.wallet,
    });
    this.options.events.emit('crate:pity', { pity: opened.roll.pity });
    if (rollHasAlbumCard(opened.roll.rewards)) await this.readAlbum(crateId, opened.roll.rewards);
  }

  /** Set progress is the server's album after the open, never a count kept on this client. */
  private async readAlbum(crateId: CrateId, rewards: readonly Reward[]): Promise<void> {
    let progress: AlbumProgressMap;
    try {
      progress = albumProgress(await this.options.client.call('album'), rewards);
    } catch (error) {
      if (!this.disposed) this.options.events.emit('crate:albumFailed', { crateId, error });
      return;
    }
    if (!this.disposed) this.options.events.emit('crate:album', { crateId, progress });
  }
}

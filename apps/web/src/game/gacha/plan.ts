import type { Rarity } from '@coinposh/shared';
import type { ImpactEvent } from '../../audio/index.ts';
import { HAPTIC_PATTERNS } from '../../vfx/haptics.ts';
import type { GachaEvent } from '../../scene/gacha/index.ts';

// TODO(economy-designer): read the pull cost from packages/economy once it exports one; the
// server and the Demo mock both charge 1 Ticket today, and this only drives the provisional readout.
export const TICKETS_PER_PULL = 1;

export type PullBlock = 'noTickets' | 'busy' | 'syncing';

export interface PullAction {
  readonly enabled: boolean;
  readonly blocked: PullBlock | null;
}

/** Whether Pull can be pressed. The server still has the last word: it may refuse anyway. */
export function pullAction(tickets: number | null, busy: boolean): PullAction {
  if (busy) return { enabled: false, blocked: 'busy' };
  if (tickets === null) return { enabled: false, blocked: 'syncing' };
  if (tickets < TICKETS_PER_PULL) return { enabled: false, blocked: 'noTickets' };
  return { enabled: true, blocked: null };
}

/** The readout while a pull awaits the server: its Ticket already off, marked provisional. */
export function provisionalTickets(tickets: number | null, pending: boolean): number | null {
  if (tickets === null) return null;
  return pending ? Math.max(0, tickets - TICKETS_PER_PULL) : tickets;
}

export type RevealStep = 'crank' | 'dispense' | 'pop';

/** Reduced motion skips the crank turn; the machine cross-fades the capsule in and open. */
export function revealSteps(reduced: boolean): readonly RevealStep[] {
  return reduced ? ['dispense', 'pop'] : ['crank', 'dispense', 'pop'];
}

export interface GachaCue {
  readonly impacts: readonly ImpactEvent[];
  readonly haptic: readonly number[] | null;
  readonly sting: boolean;
  /** A DOM burst on the viewport in the rarity's colour. */
  readonly burst: Rarity | null;
}

const NONE: GachaCue = { impacts: [], haptic: null, sting: false, burst: null };
const BIG: ReadonlySet<Rarity> = new Set(['exquisite', 'legendary', 'heirloom']);

function pan(x: number): number {
  return Math.max(-0.6, Math.min(0.6, x * 4));
}

/** Sound, haptics and bursts for each beat the machine reports. */
export function gachaCue(event: GachaEvent, reduced: boolean): GachaCue {
  const p = pan(event.at.x);
  switch (event.kind) {
    case 'click':
      return {
        ...NONE,
        impacts: [{ material: 'metal', velocity: 0.5, pan: p }],
        haptic: HAPTIC_PATTERNS.tick,
      };
    case 'drop':
      return { ...NONE, impacts: [{ material: 'wood', velocity: 0.4, pan: p }] };
    case 'knock':
      return {
        ...NONE,
        impacts: [{ material: 'wood', velocity: 0.3 + event.strength, pan: p }],
      };
    case 'land':
      return {
        ...NONE,
        impacts: [{ material: 'wood', velocity: 0.5 + event.strength, pan: p }],
        haptic: reduced ? null : HAPTIC_PATTERNS.thud,
      };
    case 'twist':
      return { ...NONE, impacts: [{ material: 'metal', velocity: 0.35 * event.step, pan: p }] };
    case 'pop': {
      const big = BIG.has(event.rarity);
      return {
        impacts: [
          { material: 'coin', velocity: big ? 2.2 : 1.2, pan: p },
          { material: 'metal', velocity: big ? 1.4 : 0.8, pan: p },
        ],
        haptic: big ? HAPTIC_PATTERNS.fanfare : HAPTIC_PATTERNS.tap,
        sting: big,
        burst: event.rarity,
      };
    }
  }
}

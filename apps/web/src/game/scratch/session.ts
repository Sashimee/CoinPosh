import type { PityCounters, ScratchCardId } from '@coinposh/shared';
import type { Payout, WalletPayout } from '../../ui/components/balancePlaque.ts';
import { rollCredit } from '../crates/mount.ts';
import type { ScratchController, ScratchOutcome } from './controller.ts';
import type { ScratchRejection } from './events.ts';

const REFRESH_ON: ReadonlySet<ScratchRejection> = new Set(['gone']);

export interface ScratchSessionOptions {
  readonly controller: Pick<ScratchController, 'reveal'>;
  readonly payout: Pick<WalletPayout, 'hold' | 'arm' | 'collect' | 'release'>;
  readonly onPity?: (cardId: ScratchCardId, pity: PityCounters) => void;
  /** The server said the card is gone: resync the inventory. */
  readonly refresh?: () => void;
}

export interface ScratchSession {
  /** Asks the house for the card's grid; on success its credit is held off the readouts. */
  reveal(cardId: ScratchCardId): Promise<ScratchOutcome>;
  /** The prize is on screen: the held credit may now pay out. */
  settled(cardId: ScratchCardId): void;
  /** Pays the held credit out once; false when there was nothing left to pay. */
  collect(cardId: ScratchCardId, payout: Payout): boolean;
  /** The card left the screen without a collect: the readouts catch up to the server. */
  abandon(cardId: ScratchCardId): void;
  readonly unpaid: readonly ScratchCardId[];
  dispose(): void;
}

/**
 * The order a card follows, free of the DOM: the reveal goes out before any foil comes off,
 * the server's credit is held so the HUD does not jump before the gems do, it is armed once
 * the prize has settled, paid out on the one collect, and released if the card is closed or
 * torn down first, so the HUD never ends up short of the server's wallet.
 */
export function createScratchSession(options: ScratchSessionOptions): ScratchSession {
  const { controller, payout } = options;
  const unpaid = new Set<ScratchCardId>();
  let disposed = false;

  return {
    async reveal(cardId) {
      const outcome = await controller.reveal(cardId);
      if (disposed) return outcome;
      if (outcome.ok) {
        const { response } = outcome;
        unpaid.add(response.cardId);
        payout.hold(response.cardId, rollCredit(response.roll));
        options.onPity?.(response.cardId, response.roll.pity);
      } else if (REFRESH_ON.has(outcome.reason)) {
        options.refresh?.();
      }
      return outcome;
    },
    settled(cardId) {
      if (unpaid.has(cardId)) payout.arm(cardId);
    },
    collect(cardId, lines) {
      if (!unpaid.delete(cardId)) return false;
      payout.collect(cardId, lines);
      return true;
    },
    abandon(cardId) {
      if (unpaid.delete(cardId)) payout.release(cardId);
    },
    get unpaid() {
      return [...unpaid];
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const cardId of unpaid) payout.release(cardId);
      unpaid.clear();
    },
  };
}

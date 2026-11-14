import type { PityCounters, Roll, Safe, SafeId, SafeOpenMethod, Wallet } from '@coinposh/shared';
import type { Payout, WalletPayout } from '../../ui/components/balancePlaque.ts';
import { rollCredit } from '../crates/mount.ts';
import type { SafesController } from './controller.ts';
import type { SafeRejection } from './events.ts';

const REFRESH_ON: ReadonlySet<SafeRejection> = new Set(['gone', 'notReady']);

export interface OpenedSafe {
  readonly safe: Safe;
  readonly safeId: SafeId;
  readonly method: SafeOpenMethod;
  readonly roll: Roll;
  readonly wallet: Wallet;
}

/** What the cinematic reports back: its contents have settled on screen, or the player collected. */
export interface SafePlayHooks {
  settled(): void;
  collect(payout: Payout): void;
}

export interface SafePlayback {
  readonly done: Promise<void>;
  dispose(): void;
}

export interface SafeOpenerOptions {
  readonly controller: Pick<SafesController, 'open' | 'busy'>;
  readonly payout: Pick<WalletPayout, 'hold' | 'arm' | 'collect' | 'release'>;
  readonly play: (opened: OpenedSafe, hooks: SafePlayHooks) => SafePlayback;
  /** An open went out; the provisional Keys changed. */
  readonly onPending?: () => void;
  /** The server rolled; called before `play`, so the list and the wallet are current first. */
  readonly onOpened?: (opened: OpenedSafe) => void;
  readonly onRejected?: (safe: Safe, reason: SafeRejection) => void;
  /** The cinematic finished on its own; not called when `dispose` tears it down. */
  readonly onDone?: (opened: OpenedSafe) => void;
  readonly onPity?: (safeId: SafeId, pity: PityCounters) => void;
  readonly refresh?: () => void;
}

export interface SafeOpener {
  /** False when it refused: another open is in flight or a cinematic is on screen. */
  request(safe: Safe, method: SafeOpenMethod): boolean;
  /** An open is in flight or a cinematic is on screen; one safe opens at a time. */
  readonly busy: boolean;
  readonly playing: SafeId | null;
  /** The opens in flight, for provisional Keys. */
  pendingOpens(): readonly { readonly type: string; readonly method: SafeOpenMethod }[];
  dispose(): void;
}

interface Playing {
  readonly opened: OpenedSafe;
  readonly playback: SafePlayback;
}

/**
 * The order an open follows, free of the DOM: ask the server, hold its credit off the readouts,
 * play the roll, arm the hold once the contents have settled, pay out on collect and release
 * whatever was never collected. One safe opens at a time, so two cinematics never stack.
 */
export function createSafeOpener(options: SafeOpenerOptions): SafeOpener {
  const { controller, payout } = options;
  const pending = new Map<SafeId, { type: string; method: SafeOpenMethod }>();
  const unpaid = new Set<SafeId>();
  let playing: Playing | null = null;
  let disposed = false;

  const endPlaying = (): OpenedSafe | null => {
    const current = playing;
    if (current === null) return null;
    playing = null;
    current.playback.dispose();
    if (unpaid.delete(current.opened.safeId)) payout.release(current.opened.safeId);
    return current.opened;
  };

  const start = (opened: OpenedSafe) => {
    const { safeId } = opened;
    unpaid.add(safeId);
    payout.hold(safeId, rollCredit(opened.roll));
    options.onOpened?.(opened);
    const playback = options.play(opened, {
      settled() {
        if (unpaid.has(safeId)) payout.arm(safeId);
      },
      collect(lines) {
        if (!unpaid.delete(safeId)) return;
        payout.collect(safeId, lines);
      },
    });
    playing = { opened, playback };
    void playback.done.then(() => {
      if (playing?.playback !== playback) return;
      const ended = endPlaying();
      if (ended !== null && !disposed) options.onDone?.(ended);
    });
  };

  return {
    request(safe, method) {
      if (disposed || playing !== null || controller.busy || pending.size > 0) return false;
      pending.set(safe.id, { type: safe.type, method });
      options.onPending?.();
      void controller.open(safe.id, method).then((outcome) => {
        pending.delete(safe.id);
        if (disposed) return;
        if (outcome.ok) {
          const { response } = outcome;
          options.onPity?.(response.safeId, outcome.pity);
          start({
            safe,
            safeId: response.safeId,
            method,
            roll: response.roll,
            wallet: response.wallet,
          });
          return;
        }
        options.onRejected?.(safe, outcome.reason);
        if (REFRESH_ON.has(outcome.reason)) options.refresh?.();
      });
      return true;
    },
    get busy() {
      return playing !== null || controller.busy || pending.size > 0;
    },
    get playing() {
      return playing?.opened.safeId ?? null;
    },
    pendingOpens: () => [...pending.values()],
    dispose() {
      if (disposed) return;
      disposed = true;
      endPlaying();
      for (const safeId of [...unpaid]) payout.release(safeId);
      unpaid.clear();
    },
  };
}

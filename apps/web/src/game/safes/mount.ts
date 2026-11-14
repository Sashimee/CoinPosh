import type { PityCounters, Roll, Safe, SafeId, SafeOpenMethod, Wallet } from '@coinposh/shared';
import type { UiApp } from '../../app/index.ts';
import { createBus, type Bus } from '../../app/bus.ts';
import type { HapticPattern } from '../../app/feedback.ts';
import { walletPayoutFor, type PayoutLine } from '../../ui/components/balancePlaque.ts';
import type { InterpolationValues } from '../../i18n/index.ts';
import { isReducedMotion } from '../../ui/motion/reduced.ts';
import type {
  SafeAudioPort,
  SafeCinematicEvents,
  SafeCinematicLine,
} from '../../vfx/cinematics/safe/index.ts';
import { cratesKey, registerCratesStrings } from '../crates/i18n.ts';
import { rewardLines } from '../crates/loot.ts';
import { rewardLineCopy, type CratesT } from '../crates/revealCard.ts';
import { msToFirstReady, readyCount, safeCountdown } from './countdown.ts';
import { createSafesController, type SafesApi, type SafesController } from './controller.ts';
import type { SafeEvents } from './events.ts';
import { registerSafesStrings, safesKey, safeTypeKey, type SafesKey } from './i18n.ts';
import { createSafeOpener, type OpenedSafe, type SafePlayHooks } from './opener.ts';
import type { SafesPanel } from './panel.ts';
import { provisionalKeys } from './plan.ts';
import type * as SafesSheet from './safesSheet.ts';

const SYNC_RETRY_MS = 1_000;
const READY_SLACK_MS = 20;

export interface SafesMountOptions {
  readonly ui: Pick<UiApp, 'store' | 'bus' | 'i18n'>;
  /** The panel and the cinematic go here; usually the UI root over the canvas. */
  readonly host: HTMLElement;
  /** The open call, e.g. `netSafesApi(boot.net.client)`. */
  readonly api: SafesApi;
  /** The session's server clock; every countdown reads it, never the client clock. */
  readonly clock: { now(): number | null };
  /** The safes the server last reported (`state.inventory.safes`). */
  readonly safes: readonly Safe[];
  /** The server's last wallet, for the Keys balance; null until it has answered. */
  readonly wallet: Pick<Wallet, 'keys'> | null;
  readonly events?: Bus<SafeEvents>;
  readonly audio?: () => SafeAudioPort | null;
  readonly vibrate?: ((pattern: HapticPattern) => void) | null;
  readonly reducedMotion?: () => boolean;
  /** Where item lines fly on collect, usually the inventory button. */
  readonly inventoryTarget?: () => Element | null;
  /** The server's pity counters after each roll, for the pity log. */
  readonly onPity?: (safeId: SafeId, pity: PityCounters) => void;
  /** The server turned an open down as stale (gone, not ready): resync the inventory. */
  readonly refresh?: () => void;
}

export interface SafesModule {
  readonly events: Bus<SafeEvents>;
  readonly controller: SafesController;
  /** Opens the safes sheet, once its chunk has loaded on the first call; it remembers the focused trigger and gives focus back on close. */
  open(): void;
  close(): void;
  readonly isOpen: boolean;
  /** Replaces the owned safes with the server's latest list. */
  setSafes(safes: readonly Safe[]): void;
  setWallet(wallet: Pick<Wallet, 'keys'>): void;
  readonly safes: readonly Safe[];
  /** Safes whose timer has run out on the server clock. */
  readyCount(): number;
  dispose(): void;
}

/** The safes a roll grants, so a safe found in a safe is on the list without a resync. */
function grantedSafes(roll: Roll): readonly Safe[] {
  return roll.rewards.flatMap((reward) => (reward.kind === 'safe' ? [reward.safe] : []));
}

/**
 * Safes end to end: the sheet lists them with server-clocked countdowns, a press asks the server
 * to open one (with Keys, or free once its timer is done), and the server's roll plays as the
 * dial-and-door cinematic before its contents fly into the HUD. Everything the module learns
 * goes out on `events`; the wallet the HUD shows is the server's, paid out on collect.
 */
export function mountSafes(options: SafesMountOptions): SafesModule {
  const { ui } = options;
  registerSafesStrings(ui.i18n);
  registerCratesStrings(ui.i18n);
  const events = options.events ?? createBus<SafeEvents>();
  const reducedMotion = options.reducedMotion ?? isReducedMotion;
  const controller = createSafesController({ api: options.api, events });
  const payout = walletPayoutFor(ui.store);
  let owned: readonly Safe[] = [...options.safes];
  let keys: number | null = options.wallet?.keys ?? null;
  let panel: SafesPanel | null = null;
  let unsaid: { readonly message: string; readonly safeId?: SafeId } | null = null;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;
  let locked = new Set<SafeId>();
  let announced: { count: number; ready: number } | null = null;
  let disposed = false;
  // The sheet and the cinematic load on the first press; the dock badge and timers need neither.
  let sheet: typeof SafesSheet | null = null;
  let sheetLoading: Promise<void> | null = null;
  let openWhenLoaded = false;

  const t = (key: SafesKey, values?: InterpolationValues) => ui.i18n.t(safesKey(key), values);
  const cratesT: CratesT = (key, values) => ui.i18n.t(cratesKey(key), values);
  const haptic = (pattern: HapticPattern) => {
    if (ui.store.getState().settings.haptics) options.vibrate?.(pattern);
  };
  const shownKeys = () => provisionalKeys(keys, opener.pendingOpens());

  const say = (message: string, safeId?: SafeId) => {
    if (panel === null) {
      if (safeId !== undefined) unsaid = { message, safeId };
      else if (unsaid?.safeId === undefined) unsaid = { message };
      return;
    }
    panel.say(message, safeId);
  };

  const announceReady = () => {
    if (disposed) return;
    if (readyTimer !== null) clearTimeout(readyTimer);
    readyTimer = null;
    const now = options.clock.now();
    const states = owned.map((safe) => ({ safe, state: safeCountdown(safe, now).state }));
    for (const { safe, state } of states) {
      if (state !== 'ready' || !locked.has(safe.id)) continue;
      events.emit('safe:ready', { safeId: safe.id });
      say(t('readyNotice', { safe: ui.i18n.t(safeTypeKey(safe.type)) }));
    }
    locked = new Set(states.filter(({ state }) => state === 'locked').map(({ safe }) => safe.id));
    const ready = states.filter(({ state }) => state === 'ready').length;
    if (announced?.count !== owned.length || announced.ready !== ready) {
      announced = { count: owned.length, ready };
      events.emit('safes:changed', announced);
    }
    const wait = now === null ? SYNC_RETRY_MS : msToFirstReady(owned, now);
    if (wait !== null) readyTimer = setTimeout(announceReady, wait + READY_SLACK_MS);
  };

  const setOwned = (next: readonly Safe[]) => {
    owned = next;
    announceReady();
    panel?.render();
  };

  const closePanel = () => {
    openWhenLoaded = false;
    panel?.dispose();
    panel = null;
  };

  const play = ({ safe, safeId, method, roll, wallet }: OpenedSafe, hooks: SafePlayHooks) => {
    if (sheet === null) {
      throw new Error(
        'CoinPosh safes: a safe opened before the safes sheet loaded; opens must come from the sheet.',
      );
    }
    const { SafeCinematic } = sheet;
    const lines = rewardLines(roll.rewards);
    const copies = lines.map((line) => rewardLineCopy(line, cratesT, ui.i18n.language));
    const cinematicLines: SafeCinematicLine[] = lines.map((line, index) => {
      const copy = copies[index];
      if (copy === undefined) throw new Error('CoinPosh safes: a reward line lost its copy');
      return {
        name: copy.name,
        detail: copy.detail,
        rarity: copy.rarity,
        chip: copy.chip,
        kind: line.kind === 'currency' ? 'currency' : 'item',
      };
    });
    const safeName = ui.i18n.t(safeTypeKey(safe.type));
    const rarityName = ui.i18n.t(cratesKey(`chip.${roll.rarity}`));
    const cinematicEvents = createBus<SafeCinematicEvents>();
    const currencyLines = lines.flatMap((line) => (line.kind === 'currency' ? [line] : []));
    const cinematic = new SafeCinematic({
      host: options.host,
      openedBy: method,
      rarity: roll.rarity,
      lines: cinematicLines,
      labels: {
        title: safeName,
        rarity: rarityName,
        collect: t('collect'),
        skip: t('skip'),
        announce: t('announce', {
          rarity: rarityName,
          safe: safeName,
          contents: copies.map((copy) => copy.name).join(', '),
        }),
      },
      reducedMotion: reducedMotion(),
      haptic,
      events: cinematicEvents,
      ...(options.audio ? { audio: options.audio } : {}),
      ...(options.inventoryTarget ? { flyTarget: options.inventoryTarget } : {}),
      onCollect: (sources) => {
        const payoutLines: PayoutLine[] = currencyLines.map((line, index) => ({
          currency: line.currency,
          amount: line.amount,
          source: sources[index] ?? null,
        }));
        hooks.collect({ wallet, lines: payoutLines });
        events.emit('safe:collected', { safeId, roll, wallet });
      },
    });
    const off = cinematicEvents.on('safeCinematic:beat', ({ beat }) => {
      if (beat.kind === 'reveal') events.emit('safe:revealed', { safeId, rarity: roll.rarity });
      if (beat.kind === 'settled') hooks.settled();
    });
    return {
      done: cinematic.done,
      dispose() {
        off();
        cinematic.dispose();
      },
    };
  };

  const opener = createSafeOpener({
    controller,
    payout,
    play,
    onPending: () => panel?.render(),
    onOpened: ({ safeId, roll, wallet }) => {
      keys = wallet.keys;
      setOwned([...owned.filter((kept) => kept.id !== safeId), ...grantedSafes(roll)]);
      closePanel();
    },
    onRejected: (safe, reason) => {
      panel?.render();
      say(t(`rejected.${reason}`), safe.id);
      ui.bus.emit('ui:feedback', { kind: 'deny' });
    },
    onDone: () => {
      if (owned.length > 0) openPanel();
    },
    ...(options.onPity ? { onPity: options.onPity } : {}),
    ...(options.refresh ? { refresh: options.refresh } : {}),
  });

  const request = (safe: Safe, method: SafeOpenMethod) => {
    if (!opener.request(safe, method)) ui.bus.emit('ui:feedback', { kind: 'deny' });
  };

  const loadSheet = () => {
    sheetLoading ??= import('./safesSheet.ts').then(
      (loaded) => {
        sheet = loaded;
        if (openWhenLoaded) {
          openWhenLoaded = false;
          openPanel();
        }
      },
      (error: unknown) => {
        sheetLoading = null;
        openWhenLoaded = false;
        console.error(
          'CoinPosh safes: the safes sheet did not load (network or a stale deploy); press Safes again to retry.',
          error,
        );
        ui.bus.emit('ui:feedback', { kind: 'deny' });
      },
    );
  };

  const openPanel = () => {
    if (disposed || panel !== null || opener.playing !== null) return;
    if (sheet === null) {
      openWhenLoaded = true;
      loadSheet();
      return;
    }
    panel = sheet.showSafesPanel({
      ui,
      host: options.host,
      serverNow: () => options.clock.now(),
      safes: () => owned,
      keys: shownKeys,
      keysProvisional: () => opener.pendingOpens().some((pending) => pending.method === 'key'),
      pending: (safeId) => controller.pending(safeId),
      busy: () => opener.busy,
      onOpen: request,
      onClose: closePanel,
      reducedMotion: reducedMotion(),
      ...(options.audio ? { audio: options.audio } : {}),
    });
    if (unsaid !== null) {
      const { message, safeId } = unsaid;
      unsaid = null;
      panel.say(message, safeId);
    }
  };

  announceReady();

  return {
    events,
    controller,
    open: openPanel,
    close: closePanel,
    get isOpen() {
      return panel !== null;
    },
    setSafes(safes) {
      setOwned([...safes]);
    },
    setWallet(wallet) {
      keys = wallet.keys;
      panel?.render();
    },
    get safes() {
      return owned;
    },
    readyCount: () => readyCount(owned, options.clock.now()),
    dispose() {
      if (disposed) return;
      disposed = true;
      if (readyTimer !== null) clearTimeout(readyTimer);
      closePanel();
      opener.dispose();
    },
  };
}

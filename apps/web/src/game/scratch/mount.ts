import type {
  PityCounters,
  Rarity,
  Roll,
  ScratchCardId,
  ScratchRevealResponse,
  Wallet,
} from '@coinposh/shared';
import type { UiApp } from '../../app/index.ts';
import { createBus, type Bus } from '../../app/bus.ts';
import type { HapticPattern } from '../../app/feedback.ts';
import { formatBalance } from '../../i18n/format.ts';
import type { InterpolationValues } from '../../i18n/index.ts';
import type { FairOpenOptions } from '../../ui/fair/mount.ts';
import { walletPayoutFor, type PayoutLine } from '../../ui/components/balancePlaque.ts';
import { isReducedMotion } from '../../ui/motion/reduced.ts';
import type {
  ScratchAnswer,
  ScratchAudioPort,
  ScratchCard,
  ScratchCardEvents,
  ScratchCardLabels,
  ScratchPrizeLine,
} from '../../vfx/scratch/card.ts';
import type { ScratchSurface } from '../../vfx/scratch/surface.ts';
import { cratesKey, registerCratesStrings } from '../crates/i18n.ts';
import { rewardLines } from '../crates/loot.ts';
import { nonceLabel } from '../crates/odds.ts';
import { rewardLineCopy, type CratesT } from '../crates/revealCard.ts';
import { createScratchController, type ScratchApi, type ScratchController } from './controller.ts';
import type { ScratchEvents } from './events.ts';
import { registerScratchStrings, scratchKey, type ScratchKey } from './i18n.ts';
import { createScratchSession } from './session.ts';
import type * as ScratchSheet from './scratchSheet.ts';

export interface ScratchMountOptions {
  readonly ui: Pick<UiApp, 'store' | 'bus' | 'i18n'>;
  /** The card goes here; usually the UI root over the canvas. */
  readonly host: HTMLElement;
  /** The reveal call, e.g. `netScratchApi(boot.net.client)`. */
  readonly api: ScratchApi;
  /** The cards the server last reported (`state.inventory.scratchCards`). */
  readonly cards: readonly ScratchCardId[];
  /** The server's last wallet; null until it has answered. */
  readonly wallet: Wallet | null;
  readonly events?: Bus<ScratchEvents>;
  readonly audio?: () => ScratchAudioPort | null;
  readonly vibrate?: ((pattern: HapticPattern) => void) | null;
  readonly reducedMotion?: () => boolean;
  /** Where item lines fly on collect, usually the inventory button. */
  readonly inventoryTarget?: () => Element | null;
  /** The Certified Fair panel: the odds before a reveal, the roll's proof after. */
  readonly openFair?: (trigger: HTMLElement, options: FairOpenOptions) => void;
  /** The server's pity counters after each roll, for the pity log. */
  readonly onPity?: (cardId: ScratchCardId, pity: PityCounters) => void;
  /** The server said a card is gone: resync the inventory. */
  readonly refresh?: () => void;
  /** Starts the foil; the default tries WebGPU, then WebGL2, then a 2D canvas. */
  readonly surface?: () => Promise<ScratchSurface>;
}

export interface ScratchModule {
  readonly events: Bus<ScratchEvents>;
  readonly controller: ScratchController;
  /** Puts a card up (the first owned one by default), once its chunk has loaded. */
  open(cardId?: ScratchCardId): void;
  close(): void;
  readonly isOpen: boolean;
  /** Replaces the owned cards with the server's latest list. */
  setCards(cards: readonly ScratchCardId[]): void;
  readonly cards: readonly ScratchCardId[];
  setWallet(wallet: Wallet): void;
  readonly wallet: Wallet | null;
  dispose(): void;
}

/** The cards a roll grants, so a card won on a card is owned without a resync. */
function grantedCards(roll: Roll): readonly ScratchCardId[] {
  return roll.rewards.flatMap((reward) => (reward.kind === 'scratchCard' ? [reward.cardId] : []));
}

interface Showing {
  readonly cardId: ScratchCardId;
  readonly card: ScratchCard;
  response: ScratchRevealResponse | null;
  collected: boolean;
}

/**
 * Scratch cards end to end: a card goes up sealed, the first touch asks the server to reveal
 * it, and only the server's grid is painted under the foil. Scratching uncovers it; the three
 * matching gems flare and the prize waits on COLLECT before it flies into the HUD. Everything
 * the module learns goes out on `events`; the wallet the HUD shows is the server's.
 */
export function mountScratch(options: ScratchMountOptions): ScratchModule {
  const { ui } = options;
  registerScratchStrings(ui.i18n);
  registerCratesStrings(ui.i18n);
  const events = options.events ?? createBus<ScratchEvents>();
  const reducedMotion = options.reducedMotion ?? isReducedMotion;
  const controller = createScratchController({ api: options.api, events });
  const session = createScratchSession({
    controller,
    payout: walletPayoutFor(ui.store),
    ...(options.onPity ? { onPity: options.onPity } : {}),
    ...(options.refresh ? { refresh: options.refresh } : {}),
  });
  let owned: readonly ScratchCardId[] = [...new Set(options.cards)];
  let wallet: Wallet | null = options.wallet;
  let showing: Showing | null = null;
  let disposed = false;
  // The card, its foil shaders and its stylesheet load on the first open; the dock needs none.
  let sheet: typeof ScratchSheet | null = null;
  let sheetLoading: Promise<void> | null = null;
  let openWhenLoaded: { cardId: ScratchCardId | undefined } | null = null;

  const t = (key: ScratchKey, values?: InterpolationValues) => ui.i18n.t(scratchKey(key), values);
  const cratesT: CratesT = (key, values) => ui.i18n.t(cratesKey(key), values);
  const haptic = (pattern: HapticPattern) => {
    if (ui.store.getState().settings.haptics) options.vibrate?.(pattern);
  };
  const deny = () => {
    ui.bus.emit('ui:feedback', { kind: 'deny' });
  };

  const setOwned = (next: readonly ScratchCardId[]) => {
    const unique = [...new Set(next)];
    const changed = unique.length !== owned.length || unique.some((id, i) => owned[i] !== id);
    owned = unique;
    if (changed) events.emit('scratch:changed', { count: owned.length });
  };

  const labels = (cardId: ScratchCardId): ScratchCardLabels => {
    const index = owned.indexOf(cardId);
    return {
      title: t('title'),
      rule: t('rule'),
      count:
        owned.length > 1 && index >= 0 ? t('count', { index: index + 1, total: owned.length }) : '',
      scratch: t('scratch'),
      sealing: t('sealing'),
      revealAll: t('revealAll'),
      collect: t('collect'),
      close: t('close'),
      hint: t('hint'),
      odds: t('odds'),
      coveredCell: (position) => t('coveredCell', { position }),
    };
  };

  const answerFor = (response: ScratchRevealResponse): ScratchAnswer => {
    const { roll } = response;
    const language = ui.i18n.language;
    const lines = rewardLines(roll.rewards);
    const prize: ScratchPrizeLine[] = lines.map((line) => {
      const copy = rewardLineCopy(line, cratesT, language);
      const base = {
        name: copy.name,
        detail: copy.detail,
        rarity: copy.rarity,
        chip: copy.chip,
      };
      if (line.kind !== 'currency') return { ...base, kind: 'item' };
      return {
        ...base,
        kind: 'currency',
        count: (share: number) =>
          cratesT(`gain.${line.currency}`, {
            count: line.amount,
            value: formatBalance(
              Math.round(line.amount * Math.min(1, Math.max(0, share))),
              language,
            ),
          }),
      };
    });
    const nonce = nonceLabel(roll.proof, language);
    const gemName = (rarity: Rarity) => t(`gem.${rarity}`);
    return {
      grid: response.grid,
      rarity: roll.rarity,
      lines: prize,
      gemName,
      uncoveredCell: (position, gem) => t('uncoveredCell', { position, gem }),
      announce: t('announce', {
        match: t(`match.${roll.rarity}`),
        prize: prize.map((line) => line.name).join(', '),
      }),
      rarityName: cratesT(`chip.${roll.rarity}`),
      fair: `${cratesT('fair')} ${cratesT('fairNonce', { nonce })}`,
      fairLabel: cratesT('fairOpen', { nonce }),
    };
  };

  const begin = (current: Showing) => {
    void session.reveal(current.cardId).then((outcome) => {
      const live = showing === current && !disposed;
      if (!outcome.ok) {
        if (live) current.card.refuse(t(`rejected.${outcome.reason}`));
        deny();
        return;
      }
      const { response } = outcome;
      wallet = response.wallet;
      setOwned([...owned.filter((id) => id !== response.cardId), ...grantedCards(response.roll)]);
      if (!live || current.card.phase !== 'revealing') {
        session.abandon(response.cardId);
        return;
      }
      current.response = response;
      current.card.reveal(answerFor(response));
    });
  };

  const show = (cardId: ScratchCardId, loaded: typeof ScratchSheet) => {
    const cardEvents = createBus<ScratchCardEvents>();
    let current: Showing | null = null;
    const card = new loaded.ScratchCard({
      host: options.host,
      labels: labels(cardId),
      reducedMotion: reducedMotion(),
      haptic,
      events: cardEvents,
      onBegin: () => {
        if (current !== null) begin(current);
      },
      onCollect: (currencyEls) => {
        const response = current?.response ?? null;
        if (current === null || response === null) return;
        const payoutLines: PayoutLine[] = rewardLines(response.roll.rewards)
          .flatMap((line) => (line.kind === 'currency' ? [line] : []))
          .map((line, index) => ({
            currency: line.currency,
            amount: line.amount,
            source: currencyEls[index] ?? null,
          }));
        current.collected = session.collect(response.cardId, {
          wallet: response.wallet,
          lines: payoutLines,
        });
        events.emit('scratch:collected', {
          cardId: response.cardId,
          roll: response.roll,
          wallet: response.wallet,
        });
      },
      onFair: (trigger, revealed) => {
        const proof = current?.response?.roll.proof;
        options.openFair?.(
          trigger,
          revealed && proof !== undefined
            ? { tab: 'verify', source: 'scratch', proof }
            : { tab: 'odds', source: 'scratch' },
        );
      },
      ...(options.audio ? { audio: options.audio } : {}),
      ...(options.inventoryTarget ? { flyTarget: options.inventoryTarget } : {}),
      ...(options.surface ? { surface: options.surface } : {}),
    });
    current = { cardId, card, response: null, collected: false };
    const offs = [
      cardEvents.on('scratchCard:matched', ({ rarity }) => {
        events.emit('scratch:matched', { cardId, rarity });
      }),
      cardEvents.on('scratchCard:settled', () => {
        session.settled(cardId);
      }),
    ];
    const shown = current;
    showing = shown;
    void card.done.then(() => {
      for (const off of offs) off();
      session.abandon(cardId);
      if (showing !== shown) return;
      showing = null;
      if (shown.collected && !disposed && owned.length > 0) openCard();
    });
  };

  const loadSheet = () => {
    sheetLoading ??= import('./scratchSheet.ts').then(
      (loaded) => {
        sheet = loaded;
        const pending = openWhenLoaded;
        openWhenLoaded = null;
        if (pending !== null) openCard(pending.cardId);
      },
      (error: unknown) => {
        sheetLoading = null;
        openWhenLoaded = null;
        console.error(
          'CoinPosh scratch: the scratch card did not load (network or a stale deploy); press Scratch Cards again to retry.',
          error,
        );
        deny();
      },
    );
  };

  const openCard = (cardId?: ScratchCardId) => {
    if (disposed || showing !== null) return;
    const chosen = cardId ?? owned[0];
    if (chosen === undefined || !owned.includes(chosen) || controller.pending(chosen)) {
      deny();
      return;
    }
    if (sheet === null) {
      openWhenLoaded = { cardId: chosen };
      loadSheet();
      return;
    }
    show(chosen, sheet);
  };

  const closeCard = () => {
    openWhenLoaded = null;
    const current = showing;
    if (current === null) return;
    showing = null;
    current.card.dispose();
    session.abandon(current.cardId);
  };

  return {
    events,
    controller,
    open: openCard,
    close: closeCard,
    get isOpen() {
      return showing !== null;
    },
    setCards(cards) {
      setOwned(cards);
    },
    get cards() {
      return owned;
    },
    setWallet(next) {
      wallet = next;
    },
    get wallet() {
      return wallet;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      closeCard();
      session.dispose();
    },
  };
}

import type { Roll, Wallet } from '@coinposh/shared';
import type { UiApp } from '../../app/index.ts';
import { createBus, type Bus } from '../../app/bus.ts';
import type { HapticPattern } from '../../app/feedback.ts';
import type { AudioEngine } from '../../audio/index.ts';
import type { GachaEvent } from '../../scene/gacha/index.ts';
import { walletPayoutFor, type PayoutLine } from '../../ui/components/balancePlaque.ts';
import { apiFairData, createPityLog, type FairClient } from '../../ui/fair/data.ts';
import type { FairPanel } from '../../ui/fair/mount.ts';
import { isReducedMotion } from '../../ui/motion/reduced.ts';
import { cratesKey, registerCratesStrings } from '../crates/i18n.ts';
import { rewardLines } from '../crates/loot.ts';
import { rollCredit } from '../crates/mount.ts';
import { rewardLineCopy, type CratesT } from '../crates/revealCard.ts';
import { createGachaController, type GachaApi, type GachaController } from './controller.ts';
import type { GachaEvents } from './events.ts';
import { gachaKey, registerGachaStrings } from './i18n.ts';
import type { GachaPanel } from './panel.ts';
import { gachaCue, provisionalTickets, pullAction } from './plan.ts';
import type * as GachaSheet from './gachaSheet.ts';

export type GachaAudioPort = Pick<AudioEngine, 'playImpact' | 'playJackpotSting'>;

export interface GachaMountOptions {
  readonly ui: Pick<UiApp, 'store' | 'bus' | 'i18n'>;
  /** The sheet goes here; usually the UI root over the canvas. */
  readonly host: HTMLElement;
  /** The pull call, e.g. `netGachaApi(boot.net.client)`. */
  readonly api: GachaApi;
  /** Reads the seed ledger for the odds and fairness panel. */
  readonly fair: FairClient;
  /** The server's last wallet, for the Tickets balance; null until it has answered. */
  readonly wallet: Pick<Wallet, 'tickets'> | null;
  readonly events?: Bus<GachaEvents>;
  readonly audio?: () => GachaAudioPort | null;
  readonly vibrate?: ((pattern: HapticPattern) => void) | null;
  readonly reducedMotion?: () => boolean;
}

export interface GachaModule {
  readonly events: Bus<GachaEvents>;
  readonly controller: GachaController;
  /** Opens the sheet, once its chunk has loaded on the first call. */
  open(): void;
  close(): void;
  readonly isOpen: boolean;
  setWallet(wallet: Pick<Wallet, 'tickets'>): void;
  readonly tickets: number | null;
  dispose(): void;
}

interface Unpaid {
  readonly id: string;
  readonly roll: Roll;
  readonly wallet: Wallet;
}

/**
 * The capsule machine end to end: Pull asks the server for one capsule, the crank turns while it
 * answers, and the server's roll drops, pops and pays out on Collect. Every value shown comes
 * from the server; the readout only takes the pending Ticket off provisionally.
 */
export function mountGacha(options: GachaMountOptions): GachaModule {
  const { ui } = options;
  registerGachaStrings(ui.i18n);
  registerCratesStrings(ui.i18n);
  const events = options.events ?? createBus<GachaEvents>();
  const reducedMotion = options.reducedMotion ?? isReducedMotion;
  const controller = createGachaController({ api: options.api, events });
  const payout = walletPayoutFor(ui.store);
  const pity = createPityLog();
  const cratesT: CratesT = (key, values) => ui.i18n.t(cratesKey(key), values);
  let tickets: number | null = options.wallet?.tickets ?? null;
  let panel: GachaPanel | null = null;
  let sheet: typeof GachaSheet | null = null;
  let sheetLoading: Promise<void> | null = null;
  let openWhenLoaded = false;
  let unpaid: Unpaid | null = null;
  let revealing = false;
  let fair: FairPanel | null = null;
  let fairLoading: Promise<FairPanel> | null = null;
  let reopenAfterFair = false;
  let pulls = 0;
  let disposed = false;

  const haptic = (pattern: HapticPattern) => {
    if (ui.store.getState().settings.haptics) options.vibrate?.(pattern);
  };
  const busy = () => controller.busy || revealing;
  const deny = () => {
    ui.bus.emit('ui:feedback', { kind: 'deny' });
  };

  const onMachineEvent = (event: GachaEvent) => {
    const cue = gachaCue(event, reducedMotion());
    const audio = options.audio?.() ?? null;
    for (const impact of cue.impacts) audio?.playImpact(impact);
    if (cue.sting) audio?.playJackpotSting();
    if (cue.haptic !== null) haptic(cue.haptic);
    if (cue.burst !== null) panel?.burst(cue.burst);
  };

  const releaseUnpaid = () => {
    if (unpaid === null) return;
    payout.release(unpaid.id);
    events.emit('gacha:collected', { roll: unpaid.roll, wallet: unpaid.wallet });
    unpaid = null;
  };

  const closePanel = () => {
    openWhenLoaded = false;
    if (panel === null) return;
    releaseUnpaid();
    panel.dispose();
    panel = null;
  };

  const collect = (sources: readonly Element[]) => {
    const current = unpaid;
    if (current === null) return;
    unpaid = null;
    const lines = rewardLines(current.roll.rewards);
    const payoutLines: PayoutLine[] = lines.flatMap((line, index) =>
      line.kind === 'currency'
        ? [{ currency: line.currency, amount: line.amount, source: sources[index] ?? null }]
        : [],
    );
    payout.collect(current.id, { wallet: current.wallet, lines: payoutLines });
    events.emit('gacha:collected', { roll: current.roll, wallet: current.wallet });
  };

  const pull = () => {
    const shown = panel;
    if (shown === null || !pullAction(tickets, busy()).enabled) {
      deny();
      return;
    }
    shown.anticipate();
    shown.render();
    void controller.pull().then(async (outcome) => {
      if (disposed) return;
      if (!outcome.ok) {
        if (outcome.reason === 'noTickets') tickets = 0;
        panel?.cancelAnticipation();
        panel?.render();
        panel?.say(ui.i18n.t(gachaKey(`rejected.${outcome.reason}`)));
        deny();
        return;
      }
      const { roll, wallet } = outcome;
      tickets = wallet.tickets;
      pity.record('gacha', outcome.pity);
      pulls += 1;
      const id = `gacha:${String(pulls)}:${roll.proof.nonce}`;
      payout.hold(id, rollCredit(roll));
      unpaid = { id, roll, wallet };
      if (panel === null) {
        releaseUnpaid();
        return;
      }
      const copies = rewardLines(roll.rewards).map((line) =>
        rewardLineCopy(line, cratesT, ui.i18n.language),
      );
      const rarityName = ui.i18n.t(cratesKey(`chip.${roll.rarity}`));
      const view = panel;
      const stillShown = () => !disposed && panel === view;
      const stillUnpaid = () => unpaid?.id === id;
      revealing = true;
      view.render();
      try {
        await view.reveal({
          rarity: roll.rarity,
          rarityName,
          lines: copies.map((copy) => ({ name: copy.name, detail: copy.detail })),
        });
      } finally {
        revealing = false;
      }
      if (!stillShown()) return;
      if (stillUnpaid()) payout.arm(id);
      events.emit('gacha:revealed', { rarity: roll.rarity });
      view.say(
        ui.i18n.t(gachaKey('announce'), {
          rarity: rarityName,
          contents: copies.map((copy) => copy.name).join(', '),
        }),
      );
      view.render();
    });
  };

  const openOdds = (trigger: HTMLElement) => {
    if (busy()) {
      deny();
      return;
    }
    const dockTrigger = trigger.ownerDocument.querySelector<HTMLElement>(
      '[data-testid="dock-gacha"]',
    );
    closePanel();
    reopenAfterFair = true;
    fairLoading ??= import('./gachaOdds.ts').then(({ mountFair }) =>
      mountFair({
        ui,
        host: options.host,
        data: apiFairData(options.fair, () => pity.read()),
        audio: options.audio ?? null,
        onClose: () => {
          if (reopenAfterFair) {
            reopenAfterFair = false;
            openPanel();
          }
        },
      }),
    );
    void fairLoading.then(
      (loaded) => {
        if (disposed) {
          loaded.dispose();
          return;
        }
        fair = loaded;
        loaded.open(dockTrigger ?? options.host, { tab: 'odds', source: 'gacha' });
      },
      (error: unknown) => {
        fairLoading = null;
        reopenAfterFair = false;
        console.error(
          'CoinPosh gacha: the odds panel did not load (network or a stale deploy); press the odds link again to retry.',
          error,
        );
        deny();
        openPanel();
      },
    );
  };

  const loadSheet = () => {
    sheetLoading ??= import('./gachaSheet.ts').then(
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
          'CoinPosh gacha: the capsule machine did not load (network or a stale deploy); press Capsules again to retry.',
          error,
        );
        deny();
      },
    );
  };

  function openPanel(): void {
    if (disposed || panel !== null) return;
    if (sheet === null) {
      openWhenLoaded = true;
      loadSheet();
      return;
    }
    panel = sheet.showGachaPanel({
      ui,
      host: options.host,
      reducedMotion: reducedMotion(),
      tickets: () => ({
        value: provisionalTickets(tickets, controller.busy),
        provisional: controller.busy,
      }),
      action: () => pullAction(tickets, busy()),
      onPull: pull,
      onOdds: openOdds,
      onCollect: collect,
      onClose: closePanel,
      onMachineEvent,
    });
  }

  return {
    events,
    controller,
    open: openPanel,
    close: closePanel,
    get isOpen() {
      return panel !== null;
    },
    setWallet(wallet) {
      tickets = wallet.tickets;
      panel?.render();
    },
    get tickets() {
      return tickets;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      reopenAfterFair = false;
      closePanel();
      fair?.dispose();
      fair = null;
    },
  };
}

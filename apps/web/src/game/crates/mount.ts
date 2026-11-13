import type { CrateId, Currency, Roll, Wallet } from '@coinposh/shared';
import type { Object3D, PerspectiveCamera } from 'three/webgpu';
import type { UiApp } from '../../app/index.ts';
import { createBus, type Bus } from '../../app/bus.ts';
import type { UiState } from '../../app/state.ts';
import { watch, type Store } from '../../app/store.ts';
import {
  walletPayoutFor,
  type PayoutLine,
  type WalletPayout,
} from '../../ui/components/balancePlaque.ts';
import type { KeyLike } from '../../ui/panels/sheetFocus.ts';
import { isReducedMotion } from '../../ui/motion/reduced.ts';
import type { CoinField } from '../../scene/coins/coin-field.ts';
import type { CameraPreset } from '../../scene/venues/riviera/layout.ts';
import type { HapticPattern } from '../../vfx/haptics.ts';
import type { UnboxVfx } from '../../vfx/cinematics/unbox/index.ts';
import type { GameEvents } from '../systems/events.ts';
import { bindCrateAudio, type CrateAudioPort } from './audio.ts';
import { CrateController, type CrateControllerOptions, type CrateSimPort } from './controller.ts';
import type { CrateEvents } from './events.ts';
import { bindArrivalHint, mountArrivalHint } from './hint.ts';
import { registerCratesStrings } from './i18n.ts';
import { rewardLines, type AlbumProgressMap } from './loot.ts';
import { mountCrateReveal, type CrateReveal } from './revealCard.ts';
import { TableCrateView, trayLanding, UnboxDirector } from './view.ts';

export interface CratesMountOptions {
  /** Defaults to a fresh bus; pass one to share crate events with HUD or analytics. */
  readonly events?: Bus<CrateEvents>;
  /** The systems bus: its `nudge` events rock crates on the table. */
  readonly game?: Pick<Bus<GameEvents>, 'on'> | null;
  readonly net: Pick<CrateControllerOptions, 'table' | 'client'>;
  readonly sim: CrateSimPort;
  readonly stage: {
    readonly scene: Object3D;
    readonly camera: PerspectiveCamera;
    onFrame(listener: (deltaSeconds: number) => void): () => void;
    /** The table's coins, whose baked faces the unbox hero borrows. */
    readonly coins?: Pick<CoinField, 'faceTexture'>;
  };
  /** The venue framing per aspect (`venue.cameraPreset`); the unbox dolly returns to it. */
  readonly framing: (aspect: number) => CameraPreset;
  readonly ui: Pick<UiApp, 'store' | 'bus' | 'i18n'>;
  /** Where the reward card goes; usually the UI root over the canvas. */
  readonly host: HTMLElement;
  /** Juice and the hit-stop clock; `timeScale` slows the unbox with the rest of the world. */
  readonly vfx?: (UnboxVfx & { readonly timeScale: number }) | null;
  readonly haptics?: { pulse(pattern: HapticPattern): boolean } | null;
  readonly audio?: (() => CrateAudioPort | null) | null;
  readonly inventoryTarget?: () => HTMLElement | null;
  readonly reducedMotion?: () => boolean;
}

const COLLECT = '[data-testid="crate-collect"]';
const CARD_LINES = '.cp-crate-lines > li';

/** The currency a roll credits, which the HUD keeps off its readouts until the player collects. */
export function rollCredit(roll: Roll): Partial<Record<Currency, number>> {
  const credit: Partial<Record<Currency, number>> = {};
  for (const line of rewardLines(roll.rewards)) {
    if (line.kind === 'currency') credit[line.currency] = line.amount;
  }
  return credit;
}

/** The card's currency lines, each with the `<li>` it is drawn in, in the card's order. */
export function payoutLines(roll: Roll, card: CardLines | null): readonly PayoutLine[] {
  const items = card ? [...card.querySelectorAll(CARD_LINES)] : [];
  return rewardLines(roll.rewards).flatMap((line, index): PayoutLine[] =>
    line.kind === 'currency'
      ? [{ currency: line.currency, amount: line.amount, source: items[index] ?? null }]
      : [],
  );
}

type CardLines = Pick<ParentNode, 'querySelectorAll'>;

export interface CratePayout {
  opened(crateId: CrateId, roll: Roll): void;
  /** The crate's card is up in front of the player, or back after a sheet closed over it. */
  shown(crateId: CrateId): void;
  /** A sheet covers the card: an uncollected card is not left up while it is out of sight. */
  hidden(crateId: CrateId): void;
  collected(crateId: CrateId, roll: Roll, wallet: Wallet, card: CardLines | null): void;
  /** The card went away (dismissed, skipped, dropped): release the crate if it was not collected. */
  gone(crateId: CrateId): void;
  dispose(): void;
}

/**
 * A crate's credit from its open to its collect. The hold starts at the open, its cap only once
 * the card is on screen, and a crate that leaves without a collect shows its credit at once.
 */
export function trackCratePayout(payout: WalletPayout): CratePayout {
  const unpaid = new Set<CrateId>();
  const gone = (crateId: CrateId): void => {
    if (unpaid.delete(crateId)) payout.release(crateId);
  };
  return {
    opened(crateId, roll) {
      unpaid.add(crateId);
      payout.hold(crateId, rollCredit(roll));
    },
    shown(crateId) {
      if (unpaid.has(crateId)) payout.arm(crateId);
    },
    hidden(crateId) {
      if (unpaid.has(crateId)) payout.disarm(crateId);
    },
    collected(crateId, roll, wallet, card) {
      unpaid.delete(crateId);
      payout.collect(crateId, { wallet, lines: payoutLines(roll, card) });
    },
    gone,
    dispose() {
      for (const crateId of [...unpaid]) gone(crateId);
    },
  };
}

/** Holds the unbox while any sheet is open and lets it go the moment the last one closes. */
export function holdWhileSheetOpen(
  store: Store<UiState>,
  director: Pick<UnboxDirector, 'hold'>,
): () => void {
  return watch(
    store,
    (state) => state.panel !== null,
    (open) => {
      director.hold(open);
    },
  );
}

export interface KeyDocument {
  addEventListener(type: 'keydown', listener: (event: KeyLike) => void): void;
  removeEventListener(type: 'keydown', listener: (event: KeyLike) => void): void;
}

/** Escape while the reward card is up collects it, wherever focus sits. */
export function bindEscapeCollect(
  doc: KeyDocument,
  options: { readonly ready: () => boolean; readonly collect: () => void },
): () => void {
  const onKeyDown = (event: KeyLike): void => {
    if (event.key !== 'Escape' || event.defaultPrevented || !options.ready()) return;
    event.preventDefault();
    options.collect();
  };
  doc.addEventListener('keydown', onKeyDown);
  return () => {
    doc.removeEventListener('keydown', onKeyDown);
  };
}

/** Presses the card's own Collect, so Escape gets the same fly, sound and haptic as a tap. */
function pressCollect(reveal: CrateReveal): void {
  const button = reveal.el.querySelector<HTMLElement>(COLLECT);
  if (!button) throw new Error('CoinPosh crates: the reward card has no Collect button to press.');
  button.click();
}

function holdReveal(reveal: CrateReveal, held: boolean): void {
  reveal.el.inert = held;
  reveal.el.style.visibility = held ? 'hidden' : '';
  if (held) return;
  const target = reveal.shown ? reveal.el.querySelector<HTMLElement>(COLLECT) : reveal.el;
  target?.focus({ preventScroll: true });
}

export interface CratesModule {
  readonly events: Bus<CrateEvents>;
  readonly controller: CrateController;
  readonly table: TableCrateView;
  readonly director: UnboxDirector;
  dispose(): void;
}

/**
 * Crates end to end: server-spawned crates ride the table, a fall is claimed through the net
 * layer, the server rolls the contents and the unbox plays them. Every reaction (stingers,
 * reveal, collect) goes out on `events`, and the audio engine hears it through that bus.
 */
export function mountCrates(options: CratesMountOptions): CratesModule {
  registerCratesStrings(options.ui.i18n);
  const events = options.events ?? createBus<CrateEvents>();
  const reducedMotion = options.reducedMotion ?? isReducedMotion;
  const disposers: (() => void)[] = [];
  const table = new TableCrateView(options.stage.scene);
  const albums = new Map<CrateId, AlbumProgressMap>();
  const reveals = new Map<CrateId, CrateReveal>();
  const payout = trackCratePayout(walletPayoutFor(options.ui.store));
  const controller = new CrateController({
    table: options.net.table,
    client: options.net.client,
    sim: options.sim,
    events,
  });
  const coins = options.stage.coins;
  const director = new UnboxDirector({
    parent: options.stage.scene,
    camera: options.stage.camera,
    faces: coins ? (tier) => coins.faceTexture(tier) : null,
    framing: options.framing,
    events,
    reducedMotion,
    vfx: options.vfx ?? null,
    haptics: options.haptics ?? null,
    card: (opened, controls) => {
      let reveal: CrateReveal;
      try {
        reveal = mountCrateReveal({
          ui: options.ui,
          host: options.host,
          rarity: opened.roll.rarity,
          roll: opened.roll,
          album: albums.get(opened.crateId) ?? null,
          reducedMotion: reducedMotion(),
          inventoryTarget: options.inventoryTarget,
          onSkip: controls.skip,
          onCollect: controls.collect,
        });
      } catch (error) {
        payout.gone(opened.crateId);
        throw error;
      }
      reveals.set(opened.crateId, reveal);
      const unbindEscape = bindEscapeCollect(reveal.el.ownerDocument, {
        ready: () => reveal.shown && !director.held && reveals.get(opened.crateId) === reveal,
        collect: () => {
          pressCollect(reveal);
        },
      });
      return {
        get shown() {
          return reveal.shown;
        },
        show: () => {
          reveal.show();
          if (!director.held) payout.shown(opened.crateId);
        },
        hold: (held) => {
          holdReveal(reveal, held);
          if (held) payout.hidden(opened.crateId);
          else if (reveal.shown) payout.shown(opened.crateId);
        },
        dispose: () => {
          unbindEscape();
          reveal.dispose();
          payout.gone(opened.crateId);
        },
      };
    },
    onStart: (crateId) => {
      table.remove(crateId);
    },
  });

  disposers.push(holdWhileSheetOpen(options.ui.store, director));

  const hint = mountArrivalHint({ ui: options.ui, host: options.host, reducedMotion });
  disposers.push(bindArrivalHint(events, hint), () => {
    hint.dispose();
  });

  const audio = options.audio;
  if (audio) {
    const port: CrateAudioPort = {
      duckMusic: (duck) => audio()?.duckMusic(duck),
      playImpact: (impact) => audio()?.playImpact(impact),
    };
    disposers.push(bindCrateAudio(events, port));
  }

  disposers.push(
    events.on('crate:spawned', ({ crateId, resumed }) => {
      table.spawn(crateId, resumed);
      director.prime();
      if (resumed) return;
      events.emit('crate:stinger', { cue: 'arrive', rarity: null, step: 1, duckSeconds: 0 });
      options.haptics?.pulse('tap');
    }),
    events.on('crate:teeter', () => {
      events.emit('crate:stinger', { cue: 'teeter', rarity: null, step: 1, duckSeconds: 0 });
      options.haptics?.pulse('tick');
    }),
    events.on('crate:fell', ({ crateId, position }) => {
      table.fall(crateId, position);
      events.emit('crate:stinger', { cue: 'fall', rarity: null, step: 1, duckSeconds: 0 });
    }),
    events.on('crate:opened', ({ crateId, roll, wallet }) => {
      payout.opened(crateId, roll);
      const at = table.landing(crateId) ?? trayLanding(0);
      director.enqueue({ crateId, roll, wallet, at });
    }),
    events.on('crate:album', ({ crateId, progress }) => {
      albums.set(crateId, progress);
      reveals.get(crateId)?.setAlbum(progress);
    }),
    events.on('crate:collected', ({ crateId, roll, wallet }) => {
      payout.collected(crateId, roll, wallet, reveals.get(crateId)?.el ?? null);
      albums.delete(crateId);
      reveals.delete(crateId);
    }),
    events.on('crate:rejected', ({ crateId }) => {
      table.remove(crateId);
    }),
    events.on('crate:failed', ({ crateId }) => {
      table.remove(crateId);
    }),
  );
  if (options.game) {
    disposers.push(
      options.game.on('nudge', ({ direction, strength }) => {
        controller.nudge(direction, strength);
      }),
    );
  }
  disposers.push(
    options.stage.onFrame((deltaSeconds) => {
      const effect = deltaSeconds * (options.vfx?.timeScale ?? 1);
      controller.update(deltaSeconds);
      table.update(effect, controller.riding, reducedMotion());
      director.update(effect);
    }),
  );

  let disposed = false;
  return {
    events,
    controller,
    table,
    director,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const off of disposers.splice(0)) off();
      payout.dispose();
      albums.clear();
      reveals.clear();
      director.dispose();
      controller.dispose();
      table.dispose();
    },
  };
}

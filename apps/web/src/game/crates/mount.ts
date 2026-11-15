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
import type { FairOpenOptions } from '../../ui/fair/index.ts';
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
import { browserUnseenStorage, unseenCrates, type UnseenCrates } from './unseen.ts';
import { TableCrateView, trayLanding, UnboxDirector } from './view.ts';
import { bindCrateWarmup, type CrateWarmup } from './warmup.ts';

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
    /** The live renderer: a swap (device loss, backend fallback) links the unbox's programs again. */
    readonly renderer?: object;
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
  /** Opens the shared fairness panel from the card's Certified Fair chip, on the roll's proof. */
  readonly openFair?: (trigger: HTMLElement, options: FairOpenOptions) => void;
  readonly reducedMotion?: () => boolean;
  /** Crates opened but not collected before a reload; defaults to this tab's sessionStorage. */
  readonly unseen?: UnseenCrates | null;
  /** Whether the table is on screen and takes drops; defaults to the boot's playable mark. */
  readonly playable?: () => boolean;
  /** Where crate credit is held until collect; defaults to the HUD plaque's payout for `ui.store`. */
  readonly payout?: WalletPayout;
}

const PLAYABLE_MARK = 'coinposh:boot:playable';

function bootPlayable(): boolean {
  return performance.getEntriesByName(PLAYABLE_MARK).length > 0;
}

/**
 * Replays the crates a reload cut off mid-unbox once the player can see them: on a frame after
 * the table turned playable and with the unbox warm-up done, so the reveal neither plays under
 * the boot poster nor links its programs a second time beside the warm-up.
 */
export function replayWhenPlayable(
  stage: Pick<CratesMountOptions['stage'], 'onFrame'>,
  warmup: Pick<CrateWarmup, 'warming'>,
  playable: () => boolean,
  replay: () => void,
): () => void {
  let seenPlayable = false;
  let off: (() => void) | null = null;
  off = stage.onFrame(() => {
    if (!seenPlayable) {
      seenPlayable = playable();
      return;
    }
    if (warmup.warming) return;
    off?.();
    off = null;
    replay();
  });
  return () => {
    off?.();
    off = null;
  };
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
  /** The crate's reward card mounted: it is the player's to collect, however long it stays up. */
  mounted(crateId: CrateId): void;
  /** A sheet covers the table, or uncovers it: a crate still waiting for its card waits on. */
  covered(covered: boolean): void;
  collected(crateId: CrateId, roll: Roll, wallet: Wallet, card: CardLines | null): void;
  /** The card went away (dismissed, skipped, dropped): release the crate if it was not collected. */
  gone(crateId: CrateId): void;
  dispose(): void;
}

/**
 * A crate's credit from its open to its collect. The hold starts at the open and ends at the
 * collect, or at once when the crate leaves without one. A card on screen is never timed out:
 * the player may put the phone down on it and still come back to the payoff. The cap only
 * guards a crate whose card never mounts, and runs only while no other card is up and no sheet
 * covers the table, so a crate waiting its turn keeps its credit for its own card.
 */
export function trackCratePayout(payout: WalletPayout): CratePayout {
  const unpaid = new Set<CrateId>();
  const up = new Set<CrateId>();
  const armed = new Set<CrateId>();
  let covered = false;
  const sync = (): void => {
    const run = up.size === 0 && !covered;
    for (const crateId of unpaid) {
      const wants = run && !up.has(crateId);
      if (wants === armed.has(crateId)) continue;
      if (wants) {
        armed.add(crateId);
        payout.arm(crateId);
      } else {
        armed.delete(crateId);
        payout.disarm(crateId);
      }
    }
  };
  const settle = (crateId: CrateId): boolean => {
    up.delete(crateId);
    armed.delete(crateId);
    return unpaid.delete(crateId);
  };
  const gone = (crateId: CrateId): void => {
    if (settle(crateId)) payout.release(crateId);
    sync();
  };
  return {
    opened(crateId, roll) {
      unpaid.add(crateId);
      payout.hold(crateId, rollCredit(roll));
      sync();
    },
    mounted(crateId) {
      up.add(crateId);
      sync();
    },
    covered(next) {
      covered = next;
      sync();
    },
    collected(crateId, roll, wallet, card) {
      settle(crateId);
      payout.collect(crateId, { wallet, lines: payoutLines(roll, card) });
      sync();
    },
    gone,
    dispose() {
      for (const crateId of [...unpaid]) {
        settle(crateId);
        payout.release(crateId);
      }
      up.clear();
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
  const payout = trackCratePayout(options.payout ?? walletPayoutFor(options.ui.store));
  const warn = (message: string, cause?: unknown): void => {
    if (cause === undefined) console.warn(message);
    else console.warn(message, cause);
  };
  const controller = new CrateController({
    table: options.net.table,
    client: options.net.client,
    sim: options.sim,
    events,
    unseen:
      options.unseen === undefined
        ? unseenCrates(browserUnseenStorage(warn), warn)
        : options.unseen,
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
          openFair: options.openFair,
          onSkip: controls.skip,
          onCollect: controls.collect,
        });
      } catch (error) {
        payout.gone(opened.crateId);
        throw error;
      }
      reveals.set(opened.crateId, reveal);
      payout.mounted(opened.crateId);
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
        },
        hold: (held) => {
          holdReveal(reveal, held);
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

  disposers.push(
    holdWhileSheetOpen(options.ui.store, director),
    watch(
      options.ui.store,
      (state) => state.panel !== null,
      (open) => {
        payout.covered(open);
      },
    ),
  );

  const warmup = bindCrateWarmup(options.stage, director);
  disposers.push(
    replayWhenPlayable(options.stage, warmup, options.playable ?? bootPlayable, () => {
      controller.replayUnseen();
    }),
  );

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
      // A warm-up still drawing primes the unbox when it is done; two primers would double the links.
      if (!warmup.warming) director.prime();
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
    events.on('crate:opened', ({ crateId, roll, wallet, replayed }) => {
      // A replayed roll's credit is already on the plaque the page booted with; holding it would
      // only keep back the next real gain until the collect.
      if (replayed !== true) payout.opened(crateId, roll);
      const at = table.landing(crateId) ?? trayLanding(0);
      director.enqueue({ crateId, roll, wallet, at });
    }),
    events.on('crate:album', ({ crateId, progress }) => {
      albums.set(crateId, progress);
      reveals.get(crateId)?.setAlbum(progress);
    }),
    events.on('crate:collected', ({ crateId, roll, wallet }) => {
      controller.seen(crateId);
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
      warmup.dispose();
      payout.dispose();
      albums.clear();
      reveals.clear();
      director.dispose();
      controller.dispose();
      table.dispose();
    },
  };
}

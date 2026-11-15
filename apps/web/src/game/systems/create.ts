import type { CoinId, MintedCoin, StateResponse } from '@coinposh/shared';
import type { Bus } from '../../app/bus.ts';
import type { UiApp } from '../../app/index.ts';
import { RIVIERA_TABLE } from '../../scene/venues/riviera/layout.ts';
import { announcementHoldFor } from '../../ui/components/announcementHold.ts';
import { bindInputSurface, linearAimMap, type AimMap, type InputHandlers } from '../input/index.ts';
import {
  mountKeyboardMouse,
  type DrawerSlot,
  type KeyboardMouseControls,
  type KeyboardMouseOptions,
} from '../input/keyboard/index.ts';
import type { CoinTransformTarget } from '../simWorker/interpolate.ts';
import type { SimEventBatch } from '../simWorker/protocol.ts';
import { pauseDuringCinematics } from './cinematicPause.ts';
import {
  createSystemsCore,
  followUpgradeLevels,
  type ClockPort,
  type ContactReport,
  type FusionReport,
  type SimPort,
  type SystemsCore,
  type TablePort,
} from './core.ts';
import type { GameEvents } from './events.ts';
import { registerSystemsStrings, systemsKey } from './i18n.ts';
import { followSurface } from './follow.ts';
import { createSystemsOverlay } from './overlay.ts';
import type { TableBounds } from './tableWatch.ts';

export interface GameSystemsOptions {
  /** The sim worker bridge (`SimBridge`); the systems hear its events and send its nudges. */
  readonly bridge: SimPort;
  /** Sim event batches the bridge delivered before the systems existed, oldest first. */
  readonly simBacklog?: readonly SimEventBatch[];
  /** The server's coins the sim laid from the boot layout, in sim id order from 0. */
  readonly tableCoins?: readonly MintedCoin[];
  readonly net: { readonly table: TablePort; readonly clock: ClockPort };
  /** Its store's `upgradeLevels` are the levels the systems play by, followed live. */
  readonly ui: Pick<UiApp, 'setCascade' | 'setDecorum' | 'bus' | 'i18n' | 'bannerSlot' | 'store'>;
  /**
   * The surface the player touches: the stage's current canvas. Read every frame, since the
   * stage swaps in a new canvas when it rebuilds its renderer.
   */
  readonly canvas: () => HTMLCanvasElement;
  readonly bounds?: TableBounds;
  readonly aimMap?: AimMap;
  readonly now?: () => number;
}

/**
 * The gameplay glue, ready for main.ts. Wire it as the coin source and subscribe effects to
 * `events`:
 *
 *   const systems = createGameSystems({ bridge, net, ui, canvas: () => stage.canvas });
 *   systems.hydrate(state);
 *   stage.onFrame(() => systems.sync(stage.coins));
 *   systems.events.on('cascade:tier', ({ rank }) => audio.setComboTier(rank));
 */
export interface GameSystems {
  readonly events: Bus<GameEvents>;
  /** Once per frame: reads input, writes the sim's coins into `field`, runs the timers. */
  sync(field: CoinTransformTarget): void;
  hydrate(state: StateResponse): void;
  /** A contact from outside the sim's own stream, which the systems already hear. */
  reportContact(contact: ContactReport): void;
  /** A fusion from outside the sim's own stream, which the systems already hear. */
  reportFusion(fusion: FusionReport): void;
  /** The server coin a sim body is, or null when it is not one the table still holds. */
  coinOf(simId: number): CoinId | null;
  /**
   * Lets go of the canvas for good: input stops, a pour in progress is dropped and the aim
   * reticle leaves, while `sync` keeps drawing the table. For a table another tab took over.
   */
  suspend(): void;
  dispose(): void;
}

/**
 * The one way input reaches play, for touch, mouse and keyboard alike: every intent is an aim
 * or a direction, and each drop spends a server-minted coin through the core.
 */
export function inputHandlersFor(
  core: Pick<SystemsCore, 'setAim' | 'drop' | 'startPour' | 'endPour' | 'cancelPour' | 'nudge'>,
): InputHandlers {
  return {
    aim: (aim) => {
      core.setAim(aim);
    },
    drop: (aim) => {
      core.drop(aim);
    },
    pourStart: (aim) => {
      core.startPour(aim);
    },
    pourEnd: (aim) => {
      core.setAim(aim);
      core.endPour();
    },
    pourCancel: () => {
      core.cancelPour();
    },
    nudge: (direction, strength, source) => {
      core.nudge(direction, strength, source);
    },
  };
}

/** A button in the HUD dock, as a number key presses it. */
export interface DockDoor {
  /** An element's `hidden`, which is `'until-found'` for a door hidden until searched. */
  readonly hidden: boolean | 'until-found';
  click(): void;
}

export interface DesktopControlsOptions extends KeyboardMouseOptions {
  /** The dock's doors in the order the player sees them, read per press: doors join after boot. */
  readonly doors: () => Iterable<DockDoor>;
}

/**
 * Mouse and keyboard play on top of the touch surface: number key n presses the n-th door the
 * dock shows, with the spring, sound and haptic a click gets; a key past the last door does
 * nothing.
 */
export function mountDesktopControls(
  handlers: InputHandlers,
  options: DesktopControlsOptions,
): KeyboardMouseControls {
  const openDrawer = (slot: DrawerSlot): void => {
    const shown = [...options.doors()].filter((door) => door.hidden === false);
    shown[slot - 1]?.click();
  };
  return mountKeyboardMouse({ ...handlers, openDrawer }, options);
}

/** The keys the touch surface also reads on a focused canvas; see `bindCanvas`. */
const SURFACE_KEYS = new Set(['Space', 'Enter', 'ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD', 'KeyW']);

export function createGameSystems(options: GameSystemsOptions): GameSystems {
  const { ui, canvas } = options;
  const now = options.now ?? (() => performance.now());
  const aimMap = options.aimMap ?? linearAimMap();
  const host = ui.bannerSlot.closest<HTMLElement>('.cp-ui-host');
  if (!host) {
    throw new Error(
      'createGameSystems: the UI is not mounted; call mountUi before the game systems.',
    );
  }
  registerSystemsStrings(ui.i18n);
  const t = (key: Parameters<typeof systemsKey>[0]): string => ui.i18n.t(systemsKey(key));

  const core = createSystemsCore({
    sim: options.bridge,
    table: options.net.table,
    clock: options.net.clock,
    ui: {
      setCascade: (count) => {
        ui.setCascade(count);
      },
      setDecorum: (decorum) => {
        ui.setDecorum(decorum);
      },
      feedback: (kind) => {
        ui.bus.emit('ui:feedback', { kind });
      },
    },
    bounds: options.bounds ?? RIVIERA_TABLE,
    now,
    ...(options.simBacklog ? { simBacklog: options.simBacklog } : {}),
    ...(options.tableCoins ? { tableCoins: options.tableCoins } : {}),
  });

  const overlay = createSystemsOverlay(host, { aim: t('aim.label'), gauge: t('pour.gauge') });
  const handlers = inputHandlersFor(core);

  const bindCanvas = (surface: HTMLCanvasElement) => {
    const previousLabel = surface.getAttribute('aria-label');
    surface.setAttribute('aria-label', t('surface.label'));
    const input = bindInputSurface(surface, handlers, {
      aimMap,
      currentAim: () => core.aim,
      now,
    });
    // The input surface's pointerdown calls preventDefault, which in Chromium stops a tap from
    // focusing the canvas; focus left on a dock button would keep Space pressing that button
    // instead of dropping. TODO(input owner): focus the canvas in game/input/surface.ts's pointerdown.
    const focus = (): void => {
      surface.focus({ preventScroll: true });
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (event.isPrimary) focus();
    };
    // The desktop controls own the keyboard and honour the player's bindings, while the surface
    // hard-codes Space, arrows and A/D/W; after a rebind both would act on a focused canvas.
    const onSurfaceKey = (event: KeyboardEvent): void => {
      if (SURFACE_KEYS.has(event.code)) event.stopImmediatePropagation();
    };
    surface.addEventListener('pointerdown', onPointerDown);
    surface.addEventListener('keydown', onSurfaceKey, { capture: true });
    surface.addEventListener('keyup', onSurfaceKey, { capture: true });
    return {
      input,
      focus,
      dispose() {
        surface.removeEventListener('pointerdown', onPointerDown);
        surface.removeEventListener('keydown', onSurfaceKey, { capture: true });
        surface.removeEventListener('keyup', onSurfaceKey, { capture: true });
        input.dispose();
        if (previousLabel === null) surface.removeAttribute('aria-label');
        else surface.setAttribute('aria-label', previousLabel);
      },
    };
  };
  const surface = followSurface(canvas, bindCanvas);
  surface.binding.focus();
  const desktop = mountDesktopControls(handlers, {
    surface: () => surface.surface,
    aimMap,
    currentAim: () => core.aim,
    now,
    doors: () => host.querySelectorAll<HTMLElement>('[data-testid="hud-dock"] .cp-dock-button'),
  });

  const offs = [
    followUpgradeLevels(ui.store, core),
    pauseDuringCinematics(announcementHoldFor(ui.store), {
      core,
      interrupt: () => {
        surface.binding.input.interrupt();
        desktop.interrupt();
      },
      overlay,
    }),
    core.events.on('pour:end', ({ grade }) => {
      overlay.stamp(t(`pour.${grade}`), grade === 'perfect' ? 'perfect' : 'neutral');
    }),
    core.events.on('drop:blocked', ({ reason }) => {
      if (reason === 'empty') overlay.stamp(t('notice.empty'), 'warn');
    }),
    core.events.on('nudge:rejected', ({ reason }) => {
      if (reason === 'offline') overlay.stamp(t('notice.nudgeOffline'), 'warn');
    }),
  ];

  let disposed = false;
  let suspended = false;
  const letGo = (): void => {
    desktop.dispose();
    surface.dispose();
    overlay.dispose();
  };
  return {
    events: core.events,
    sync(field) {
      if (disposed) return;
      if (suspended) {
        core.sync(field);
        return;
      }
      if (surface.follow()) {
        core.cancelPour();
        if (document.activeElement === null || document.activeElement === document.body) {
          surface.binding.focus();
        }
      }
      surface.binding.input.tick();
      desktop.tick();
      core.sync(field);
      core.update();
      const width = surface.surface.getBoundingClientRect().width;
      const pressed = surface.binding.input.pressed || desktop.pressed;
      overlay.render(aimMap.toPx(core.aim, width), pressed, core.pourView());
    },
    hydrate: (state) => {
      core.hydrate(state);
    },
    reportContact: (contact) => {
      core.reportContact(contact);
    },
    reportFusion: (fusion) => {
      core.reportFusion(fusion);
    },
    coinOf: (simId) => core.coinOf(simId),
    suspend() {
      if (disposed || suspended) return;
      suspended = true;
      core.cancelPour();
      letGo();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const off of offs) off();
      if (!suspended) letGo();
      core.dispose();
    },
  };
}

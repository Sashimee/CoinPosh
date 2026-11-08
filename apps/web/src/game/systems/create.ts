import type { MintedCoin, StateResponse } from '@coinposh/shared';
import type { Bus } from '../../app/bus.ts';
import type { UiApp } from '../../app/index.ts';
import { RIVIERA_TABLE } from '../../scene/venues/riviera/layout.ts';
import { bindInputSurface, linearAimMap, type AimMap, type InputHandlers } from '../input/index.ts';
import type { CoinTransformTarget } from '../simWorker/interpolate.ts';
import type { SimEventBatch } from '../simWorker/protocol.ts';
import {
  createSystemsCore,
  type ClockPort,
  type ContactReport,
  type FusionReport,
  type SimPort,
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
  /** The server's coins for the sim's opening heap, in sim id order from 0. */
  readonly openingHeap?: readonly MintedCoin[];
  readonly net: { readonly table: TablePort; readonly clock: ClockPort };
  readonly ui: Pick<UiApp, 'setCascade' | 'setDecorum' | 'bus' | 'i18n' | 'bannerSlot'>;
  /**
   * The surface the player touches: the stage's current canvas. Read every frame, since the
   * stage swaps in a new canvas when it rebuilds its renderer.
   */
  readonly canvas: () => HTMLCanvasElement;
  readonly bounds?: TableBounds;
  readonly aimMap?: AimMap;
  readonly now?: () => number;
  readonly upgradeLevels?: Readonly<Record<string, number>>;
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
  setUpgradeLevels(levels: Readonly<Record<string, number>>): void;
  /** A contact from outside the sim's own stream, which the systems already hear. */
  reportContact(contact: ContactReport): void;
  /** A fusion from outside the sim's own stream, which the systems already hear. */
  reportFusion(fusion: FusionReport): void;
  dispose(): void;
}

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
    ...(options.upgradeLevels ? { upgradeLevels: options.upgradeLevels } : {}),
    ...(options.simBacklog ? { simBacklog: options.simBacklog } : {}),
    ...(options.openingHeap ? { openingHeap: options.openingHeap } : {}),
  });

  const overlay = createSystemsOverlay(host, { aim: t('aim.label'), gauge: t('pour.gauge') });
  const handlers: InputHandlers = {
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

  const bindCanvas = (surface: HTMLCanvasElement) => {
    const previousLabel = surface.getAttribute('aria-label');
    surface.setAttribute('aria-label', t('surface.label'));
    const input = bindInputSurface(surface, handlers, {
      aimMap,
      currentAim: () => core.aim,
      now,
    });
    // The input surface listens for keys on the canvas, and its pointerdown calls
    // preventDefault, which in Chromium stops a click from focusing it; so Space and W would go
    // nowhere. TODO(input owner): focus the canvas in game/input/surface.ts's pointerdown.
    const focus = (): void => {
      surface.focus({ preventScroll: true });
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (event.isPrimary) focus();
    };
    surface.addEventListener('pointerdown', onPointerDown);
    return {
      input,
      focus,
      dispose() {
        surface.removeEventListener('pointerdown', onPointerDown);
        input.dispose();
        if (previousLabel === null) surface.removeAttribute('aria-label');
        else surface.setAttribute('aria-label', previousLabel);
      },
    };
  };
  const surface = followSurface(canvas, bindCanvas);
  surface.binding.focus();

  const offs = [
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
  return {
    events: core.events,
    sync(field) {
      if (disposed) return;
      if (surface.follow()) {
        core.cancelPour();
        if (document.activeElement === null || document.activeElement === document.body) {
          surface.binding.focus();
        }
      }
      surface.binding.input.tick();
      core.sync(field);
      core.update();
      const width = surface.surface.getBoundingClientRect().width;
      overlay.render(aimMap.toPx(core.aim, width), surface.binding.input.pressed, core.pourView());
    },
    hydrate: (state) => {
      core.hydrate(state);
    },
    setUpgradeLevels: (levels) => {
      core.setUpgradeLevels(levels);
    },
    reportContact: (contact) => {
      core.reportContact(contact);
    },
    reportFusion: (fusion) => {
      core.reportFusion(fusion);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const off of offs) off();
      surface.dispose();
      overlay.dispose();
      core.dispose();
    },
  };
}

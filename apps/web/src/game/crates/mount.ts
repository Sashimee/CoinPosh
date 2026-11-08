import type { Object3D, PerspectiveCamera } from 'three/webgpu';
import type { UiApp } from '../../app/index.ts';
import { createBus, type Bus } from '../../app/bus.ts';
import { isReducedMotion } from '../../ui/motion/reduced.ts';
import type { CameraPreset } from '../../scene/venues/riviera/layout.ts';
import type { HapticPattern } from '../../vfx/haptics.ts';
import type { UnboxVfx } from '../../vfx/cinematics/unbox/index.ts';
import type { GameEvents } from '../systems/events.ts';
import { bindCrateAudio, type CrateAudioPort } from './audio.ts';
import { CrateController, type CrateControllerOptions, type CrateSimPort } from './controller.ts';
import type { CrateEvents } from './events.ts';
import { bindArrivalHint, mountArrivalHint } from './hint.ts';
import { registerCratesStrings } from './i18n.ts';
import { mountCrateReveal } from './revealCard.ts';
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
  const controller = new CrateController({
    table: options.net.table,
    client: options.net.client,
    sim: options.sim,
    events,
  });
  const director = new UnboxDirector({
    parent: options.stage.scene,
    camera: options.stage.camera,
    framing: options.framing,
    events,
    reducedMotion,
    vfx: options.vfx ?? null,
    haptics: options.haptics ?? null,
    card: (opened, controls) =>
      mountCrateReveal({
        ui: options.ui,
        host: options.host,
        rarity: opened.roll.rarity,
        roll: opened.roll,
        reducedMotion: reducedMotion(),
        inventoryTarget: options.inventoryTarget,
        onSkip: controls.skip,
        onCollect: controls.collect,
      }),
    onStart: (crateId) => {
      table.remove(crateId);
    },
  });

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
    events.on('crate:spawned', ({ crateId }) => {
      table.spawn(crateId);
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
      const at = table.landing(crateId) ?? trayLanding(0);
      director.enqueue({ crateId, roll, wallet, at });
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
      director.dispose();
      controller.dispose();
      table.dispose();
    },
  };
}

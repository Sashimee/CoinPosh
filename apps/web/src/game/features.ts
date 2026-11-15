import type { Bus } from '../app/bus.ts';
import type { AudioEngine } from '../audio/index.ts';
import type { I18n } from '../i18n/index.ts';
import type { ApiClient } from '../net/client.ts';
import type { Haptics } from '../vfx/haptics.ts';
import type { GameEvents } from './systems/events.ts';

/**
 * What a theme's client half gets from the boot. Audio and haptics are accessors because they
 * come up after the first gesture, and reduced motion because the player can flip it mid-run.
 */
export interface GameFeatureContext {
  /** The game systems' event bus (`GameSystems.events`). */
  readonly events: Bus<GameEvents>;
  readonly api: ApiClient;
  readonly i18n: I18n;
  readonly audio: () => AudioEngine | null;
  readonly haptics: () => Haptics | null;
  readonly reducedMotion: () => boolean;
}

export interface GameFeatureHandle {
  dispose(): void;
}

/** One theme's client half (`apps/web/src/game/<theme>/`), mounted once the table is live. */
export interface GameFeature {
  readonly id: string;
  mount(ctx: GameFeatureContext): GameFeatureHandle;
}

export type GameFeatureErrorReport = (message: string, error: unknown) => void;

const consoleError: GameFeatureErrorReport = (message, error) => {
  console.error(message, error);
};

/**
 * Mounts each feature in order and returns one handle that disposes them in reverse. Features
 * are a bonus on top of the table, so one whose mount or dispose throws is reported loudly and
 * skipped while the others keep running. Two features sharing an id is a wiring bug and throws.
 */
export function mountGameFeatures(
  features: readonly GameFeature[],
  ctx: GameFeatureContext,
  report: GameFeatureErrorReport = consoleError,
): GameFeatureHandle {
  const ids = new Set<string>();
  for (const feature of features) {
    if (ids.has(feature.id)) {
      throw new Error(
        `CoinPosh game feature "${feature.id}" is registered twice; mount each feature once.`,
      );
    }
    ids.add(feature.id);
  }
  const mounted: { readonly id: string; readonly handle: GameFeatureHandle }[] = [];
  for (const feature of features) {
    try {
      mounted.push({ id: feature.id, handle: feature.mount(ctx) });
    } catch (error) {
      report(
        `CoinPosh game feature "${feature.id}" failed to mount; the game continues without it.`,
        error,
      );
    }
  }
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const { id, handle } of mounted.reverse()) {
        try {
          handle.dispose();
        } catch (error) {
          report(
            `CoinPosh game feature "${id}" failed to dispose; the others still tear down.`,
            error,
          );
        }
      }
    },
  };
}

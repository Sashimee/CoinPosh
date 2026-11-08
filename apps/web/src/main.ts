import { mountUi, type UiApp } from './app/index.ts';
import { createAudioEngine, isAudioSupported } from './audio/index.ts';
import type * as SimWorkerModule from './game/simWorker/index.ts';
import type { SimBridge } from './game/simWorker/index.ts';
import { MAX_DROP_OFFSET_MM } from './game/simWorker/sim-api.ts';
import { LANGUAGES, type I18n, type ResourceTree } from './i18n/index.ts';
import { createNet, mountDemoBanner, NET_I18N_SOURCE, type DemoBannerColors } from './net/index.ts';
import type { CoinField, CoinTierId } from './scene/coins/index.ts';
import { rivieraTokens } from './scene/venues/riviera/palette.ts';
import type * as RivieraModule from './scene/venues/riviera/index.ts';
import type { RivieraVenue } from './scene/venues/riviera/index.ts';
import type { Stage } from './stage.ts';
import { hexToRgbChannels } from './ui/theme.ts';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** Instance slots per coin tier: the 250-coin table budget, shaped like a fusion pyramid. */
const COIN_CAPACITY: Readonly<Record<CoinTierId, number>> = {
  copper: 256,
  silver: 128,
  gold: 64,
  platinum: 32,
  diamond: 16,
  heirloom: 8,
};

/** Same seed, same physics on every boot, until a server table session hands one out. */
const TABLE_SEED = 0xc0196051;

/**
 * The heap poured onto an empty table at boot, so the pusher has coins to shove before the
 * player's first drop. Every coin goes through `SimBridge.drop`, exactly like a player's.
 */
const OPENING_HEAP = {
  coins: 160,
  perSecond: 40,
  /** Most drops released in one frame after a hitch, so coins never spawn inside each other. */
  maxBurst: 3,
  /** Share of the sim's drop range the heap spans, keeping coins off the side guides. */
  spread: 0.9,
} as const;

/** Copper-heavy with a sprinkle of the rarer metals, so every coin material shows on boot. */
const OPENING_TIER_WEIGHTS: readonly (readonly [CoinTierId, number])[] = [
  ['copper', 0.6],
  ['silver', 0.21],
  ['gold', 0.12],
  ['platinum', 0.04],
  ['diamond', 0.025],
  ['heirloom', 0.005],
];

// Low-discrepancy (Weyl) sequences: deterministic, evenly spread drops with no RNG, and
// consecutive drops land far apart across the table.
const GOLDEN_FRACTION = 0.6180339887498949;
const SQRT2_FRACTION = 0.41421356237309515;

const DEMO_BANNER_COLORS: DemoBannerColors = {
  border: `rgb(${hexToRgbChannels(rivieraTokens.champagne)} / 0.38)`,
  surface: rivieraTokens['navy-lacquer'],
  text: rivieraTokens.ivory,
  accent: rivieraTokens['gold-brushed'],
};

const canvas = document.querySelector<HTMLCanvasElement>('#stage');
if (!canvas) {
  throw new Error('CoinPosh boot failed: <canvas id="stage"> is missing from index.html');
}

const uiRoot = document.createElement('div');
document.body.append(uiRoot);
const ui = mountUi(uiRoot);

const teardown: (() => void)[] = [];
const runTeardown = (): void => {
  for (const dispose of teardown.splice(0).reverse()) dispose();
};
window.addEventListener('pagehide', (event) => {
  if (!event.persisted) runTeardown();
});
import.meta.hot?.dispose(runTeardown);

bootAudio(ui).catch((error: unknown) => {
  console.error('CoinPosh audio failed to start; the game continues without sound.', error);
});

bootNet(ui).catch((error: unknown) => {
  console.error('CoinPosh net failed to start; balances will not sync this session.', error);
});

void bootScene(canvas);

// The music loop is rendered offline now, before any gesture, so the first tap only has to
// unlock the context and the track starts without a render hitch.
// The saved mixer is attached before the music starts, so the first note plays at the volume
// the player chose rather than the engine defaults.
async function bootAudio(app: UiApp): Promise<void> {
  if (!isAudioSupported()) {
    console.warn('[CoinPosh] Web Audio is unavailable in this browser; playing without sound.');
    return;
  }
  const audio = createAudioEngine();
  app.attachAudio(audio);
  await audio.startMusic();
}

/**
 * Without `VITE_API_URL` (the GitHub Pages build) the net layer runs Demo Mode against its
 * in-browser server, and the banner tells the player their progress is unranked and local.
 */
async function bootNet(app: UiApp): Promise<void> {
  registerNetStrings(app.i18n);
  const net = await createNet({
    locale: () => app.i18n.language,
    turnstileToken: () =>
      Promise.reject(
        new Error(
          'CoinPosh net: Cloudflare Turnstile is not wired into the web app yet, so live guest sign-up cannot run; build without VITE_API_URL for Demo Mode.',
        ),
      ),
    onError: (error) => {
      console.error('CoinPosh net error.', error);
    },
  });
  teardown.push(() => {
    net.table.close();
  });
  if (net.mode.kind !== 'demo') return;
  let removeBanner = showDemoBanner(app.i18n);
  const stopRelabel = app.i18n.onLanguageChanged(() => {
    removeBanner = showDemoBanner(app.i18n);
  });
  teardown.push(() => {
    stopRelabel();
    removeBanner();
  });
}

function showDemoBanner(i18n: I18n): () => void {
  return mountDemoBanner(document, (key) => i18n.t(key), DEMO_BANNER_COLORS);
}

/** Net keys are dotted paths in the default namespace, so they nest like the `ui` catalogs. */
function registerNetStrings(i18n: I18n): void {
  for (const language of LANGUAGES) {
    const tree: Record<string, ResourceTree | string> = {};
    for (const [key, text] of Object.entries(NET_I18N_SOURCE[language])) {
      const path = key.split('.');
      const leaf = path.pop();
      if (leaf === undefined) continue;
      let node = tree;
      for (const segment of path) {
        const next = (node[segment] ??= {});
        if (typeof next === 'string') {
          throw new Error(`CoinPosh i18n: net key "${key}" nests under the string "${segment}"`);
        }
        node = next;
      }
      node[leaf] = text;
    }
    i18n.addResourceBundle(language, 'ui', tree);
  }
}

async function bootScene(target: HTMLCanvasElement): Promise<void> {
  let stage: Stage;
  let riviera: typeof RivieraModule;
  let bridge: SimBridge | undefined;
  try {
    const [stageModule, venueModule, simModule] = await Promise.all([
      import('./stage.ts'),
      import('./scene/venues/riviera/index.ts'),
      import('./game/simWorker/index.ts'),
    ]);
    riviera = venueModule;
    bridge = startSim(simModule);
    stage = await stageModule.createStage(target, {
      look: riviera.RIVIERA_RENDER_LOOK,
      vignetteTint: riviera.RIVIERA_VIGNETTE_TINT,
      coins: { capacity: COIN_CAPACITY, radius: bridge.coin.radius },
    });
  } catch (error) {
    bridge?.dispose();
    console.error('CoinPosh boot failed: the renderer could not start.', error);
    return;
  }
  let venue: RivieraVenue;
  try {
    venue = await riviera.createRivieraVenue(stage.scene, null, {
      quality: stage.profile.venueDetail,
      shadows: stage.look.shadows,
    });
  } catch (error) {
    bridge.dispose();
    console.error('CoinPosh boot failed: the Riviera venue could not load.', error);
    return;
  }
  attachVenue(stage, venue, riviera.applyCameraPreset);
  stage.castCoinShadowsFrom(venue.lighting.key);
  attachCoins(stage, bridge);
  watchReducedMotion((reduced) => {
    venue.setReducedMotion(reduced);
    stage.coins.setReducedMotion(reduced);
  });
  await pourOpeningHeapWhenEmpty(stage, bridge);
}

/** Started before the renderer, so the worker loads Rapier while the GPU initialises. */
function startSim(simModule: typeof SimWorkerModule): SimBridge {
  const bridge = simModule.createSimBridge({ seed: TABLE_SEED });
  teardown.push(() => {
    bridge.dispose();
  });
  return bridge;
}

function attachVenue(
  stage: Stage,
  venue: RivieraVenue,
  applyCameraPreset: typeof RivieraModule.applyCameraPreset,
): void {
  stage.observeSize((width, height) => {
    applyCameraPreset(stage.camera, venue.cameraPreset(width / height));
  });
  stage.onFrame((deltaSeconds) => {
    venue.update(deltaSeconds);
  });
}

/**
 * Where the coins on screen come from: the sim worker bridge writes interpolated sim
 * transforms every frame. A source only places coins: what a coin is worth only ever comes
 * from the server.
 */
interface CoinTransformSource {
  /** Runs once per frame, before the stage uploads the field. */
  sync(field: CoinField): void;
}

function attachCoins(stage: Stage, source: CoinTransformSource): void {
  const detach = stage.onFrame(() => {
    source.sync(stage.coins);
  });
  teardown.push(detach);
}

async function pourOpeningHeapWhenEmpty(stage: Stage, bridge: SimBridge): Promise<void> {
  try {
    await bridge.ready;
  } catch {
    // The bridge already logged why the sim stopped; there is no table to pour onto.
    return;
  }
  if (bridge.stats.coins > 0) return;
  const spreadMm = Math.floor(MAX_DROP_OFFSET_MM * OPENING_HEAP.spread);
  let poured = 0;
  let due = 0;
  const stop = stage.onFrame((deltaSeconds) => {
    if (bridge.failure) {
      stop();
      return;
    }
    due = Math.min(due + deltaSeconds * OPENING_HEAP.perSecond, OPENING_HEAP.maxBurst);
    for (; due >= 1 && poured < OPENING_HEAP.coins; due -= 1, poured += 1) {
      bridge.drop(openingDropOffsetMm(poured, spreadMm), openingDropTier(poured));
    }
    if (poured >= OPENING_HEAP.coins) stop();
  });
  teardown.push(stop);
}

function openingDropOffsetMm(index: number, spreadMm: number): number {
  return Math.round((fraction(index * GOLDEN_FRACTION) * 2 - 1) * spreadMm);
}

function openingDropTier(index: number): CoinTierId {
  let roll = fraction(index * SQRT2_FRACTION + 0.5);
  for (const [tier, weight] of OPENING_TIER_WEIGHTS) {
    roll -= weight;
    if (roll < 0) return tier;
  }
  return 'copper';
}

function fraction(value: number): number {
  return value - Math.floor(value);
}

function watchReducedMotion(apply: (reduced: boolean) => void): void {
  if (typeof matchMedia !== 'function') return;
  const query = matchMedia(REDUCED_MOTION_QUERY);
  apply(query.matches);
  query.addEventListener('change', (event) => {
    apply(event.matches);
  });
}

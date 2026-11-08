import { mountUi, type UiApp } from './app/index.ts';
import { createAudioEngine, isAudioSupported } from './audio/index.ts';
import type * as SimWorkerModule from './game/simWorker/index.ts';
import type { SimBridge } from './game/simWorker/index.ts';
import { LANGUAGES, type I18n, type ResourceTree } from './i18n/index.ts';
import {
  createNet,
  mountDemoBanner,
  NET_I18N_SOURCE,
  type DemoBannerColors,
  type NetMode,
} from './net/index.ts';
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

/**
 * A fixed local seed. The server hands out no table seed yet, so in live mode the drawn table is
 * not the server's table.
 * TODO(lead-architect): seed the sim from the server table session once the API exposes one.
 */
const TABLE_SEED = 0xc0196051;

/**
 * The heap poured onto an empty Demo Mode table at boot, so the pusher has coins to shove before
 * the player's first drop. Every coin goes through `SimBridge.drop`, exactly like a player's.
 * Drops are released on render frames, so the tick each one lands on, and the heap's final
 * shape, differ a little between devices; nothing is paid from it. Live mode pours no heap,
 * since the server's table never saw these coins.
 */
const OPENING_HEAP = {
  coins: 160,
  perSecond: 40,
  /** Most drops released in one frame after a hitch, so coins never spawn inside each other. */
  maxBurst: 3,
  /**
   * Lateral reach from the centre line, inside the sim's ±150 mm drop range so coins stay off
   * the side guides. `SimBridge.drop` rejects anything outside that range.
   * TODO(simWorker owner): read the range from a public export of game/simWorker/index.ts.
   */
  spreadMm: 135,
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

/**
 * mountDemoBanner pins the banner `position: fixed` over the balance plaque, so main.ts moves it
 * into the HUD's banner slot and lays it out in flow. Only the opacity fade is kept, because the
 * slide-in keyframes animate the fixed-position centring transform.
 * TODO(net owner): give mountDemoBanner a parent element and an in-flow style, then drop this.
 */
const IN_FLOW_BANNER_STYLE: Partial<CSSStyleDeclaration> = {
  position: 'static',
  transform: 'none',
  margin: '0 auto',
  width: 'fit-content',
  animationName: 'coinposh-demo-banner-fade',
  animationDuration: '200ms',
  animationTimingFunction: 'ease-out',
};

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

const netMode = bootNet(ui).catch((error: unknown) => {
  console.error('CoinPosh net failed to start; balances will not sync this session.', error);
  return null;
});

void bootScene(canvas, netMode);

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
async function bootNet(app: UiApp): Promise<NetMode> {
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
  if (net.mode.kind !== 'demo') return net.mode;
  let removeBanner = showDemoBanner(app);
  const stopRelabel = app.i18n.onLanguageChanged(() => {
    removeBanner = showDemoBanner(app);
  });
  teardown.push(() => {
    stopRelabel();
    removeBanner();
  });
  return net.mode;
}

function showDemoBanner(app: UiApp): () => void {
  const remove = mountDemoBanner(document, (key) => app.i18n.t(key), DEMO_BANNER_COLORS);
  const banner = document.body.lastElementChild;
  if (!(banner instanceof HTMLElement) || banner.getAttribute('role') !== 'status') {
    remove();
    throw new Error(
      'CoinPosh net: mountDemoBanner no longer appends its banner last to <body>, so main.ts cannot move it into the HUD banner slot. Mount it through the slot instead.',
    );
  }
  Object.assign(banner.style, IN_FLOW_BANNER_STYLE);
  app.bannerSlot.append(banner);
  return remove;
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

async function bootScene(
  target: HTMLCanvasElement,
  netMode: Promise<NetMode | null>,
): Promise<void> {
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
    teardownStage(stage);
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
  if ((await netMode)?.kind === 'demo') await pourOpeningHeapWhenEmpty(stage, bridge);
}

/** Pushed after the bridge, so teardown stops the renderer before the sim it draws from. */
function teardownStage(stage: Stage): void {
  teardown.push(() => {
    stage.dispose().catch((error: unknown) => {
      console.error('CoinPosh teardown: the stage did not dispose cleanly.', error);
    });
  });
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
  let poured = 0;
  let due = 0;
  const stop = stage.onFrame((deltaSeconds) => {
    if (bridge.failure) {
      stop();
      return;
    }
    due = Math.min(due + deltaSeconds * OPENING_HEAP.perSecond, OPENING_HEAP.maxBurst);
    try {
      for (; due >= 1 && poured < OPENING_HEAP.coins; due -= 1, poured += 1) {
        bridge.drop(openingDropOffsetMm(poured), openingDropTier(poured));
      }
    } catch (error) {
      stop();
      console.error('CoinPosh opening heap stopped: the sim rejected a drop.', error);
      return;
    }
    if (poured >= OPENING_HEAP.coins) stop();
  });
  teardown.push(stop);
}

function openingDropOffsetMm(index: number): number {
  return Math.round((fraction(index * GOLDEN_FRACTION) * 2 - 1) * OPENING_HEAP.spreadMm);
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

import type { MintedCoin, StateResponse } from '@coinposh/shared';
import type { Object3D } from 'three/webgpu';
import { mountUi, type UiApp } from './app/index.ts';
import { createAudioEngine, isAudioSupported, type AudioEngine } from './audio/index.ts';
import type * as CratesApi from './game/crates/index.ts';
import type * as SystemsModule from './game/systems/index.ts';
import type { GameSystems } from './game/systems/index.ts';
import { mountUpgrades, netUpgradeApi } from './game/upgrades/index.ts';
import type * as SimWorkerModule from './game/simWorker/index.ts';
import type {
  OpeningHeap,
  SimBridge,
  SimBridgeStats,
  SimEventBatch,
} from './game/simWorker/index.ts';
import { LANGUAGES, type I18n, type ResourceTree } from './i18n/index.ts';
import {
  createNet,
  currentNetMode,
  mountDemoBanner,
  NET_I18N_KEYS,
  NET_I18N_SOURCE,
  openingTableCoins,
  type DemoBannerColors,
  type Net,
  type NetMode,
} from './net/index.ts';
import { currentTurnstileSiteKey } from './net/env.ts';
import type { CoinField, CoinTierId } from './scene/coins/index.ts';
import { rivieraTokens } from './scene/venues/riviera/palette.ts';
import type * as RivieraModule from './scene/venues/riviera/index.ts';
import type { RivieraVenue } from './scene/venues/riviera/index.ts';
import type { Stage } from './stage.ts';
import { isReducedMotion, onReducedMotionChange } from './ui/motion/reduced.ts';
import { hexToRgbChannels } from './ui/theme.ts';
import type * as VfxModule from './vfx/index.ts';
import type { Vfx } from './vfx/index.ts';
import { Haptics } from './vfx/haptics.ts';

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

/** The longest the stage waits for the sim to be ready, so a slow worker download never blanks the table. */
const SIM_HEAD_START_MS = 1500;

/** Waits between attempts to load the player's table at boot, doubling up to the ceiling. */
const STATE_RETRY = { firstDelayMs: 1000, maxDelayMs: 30_000 } as const;

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

const OFFLINE_BANNER_STYLE: Partial<CSSStyleDeclaration> = {
  margin: '0 auto',
  width: 'fit-content',
  maxWidth: 'min(560px, calc(100vw - 32px))',
  padding: '8px 16px',
  border: `1px solid ${DEMO_BANNER_COLORS.border}`,
  borderRadius: '16px',
  background: DEMO_BANNER_COLORS.surface,
  color: DEMO_BANNER_COLORS.text,
  font: '500 13px/1.35 system-ui, sans-serif',
  pointerEvents: 'none',
};

/**
 * A read-only view of the running table for end-to-end checks and the playtest console. It holds
 * nothing that can act on the table.
 */
interface CoinPoshProbe {
  readonly sim: SimBridgeStats | null;
  /** True once taps, holds and keys drive the table. */
  readonly playable: boolean;
  /** What the sim reported since boot, and what the game systems made of it once playable. */
  readonly counts: Readonly<ProbeCounts>;
}

interface ProbeCounts {
  simFalls: number;
  simFusions: number;
  falls: number;
  frontFalls: number;
  fusions: number;
  credits: number;
  creditedCoins: number;
  /** Fall claims the server refused, by reason; `unanswered` when the request itself failed. */
  refusedFalls: Record<string, number>;
  cratesSpawned: number;
  cratesOpened: number;
  cratesCollected: number;
}

declare global {
  interface Window {
    __coinposh?: CoinPoshProbe;
  }
}

const probe: { bridge: SimBridge | null; playable: boolean; counts: ProbeCounts } = {
  bridge: null,
  playable: false,
  counts: {
    simFalls: 0,
    simFusions: 0,
    falls: 0,
    frontFalls: 0,
    fusions: 0,
    credits: 0,
    creditedCoins: 0,
    refusedFalls: {},
    cratesSpawned: 0,
    cratesOpened: 0,
    cratesCollected: 0,
  },
};
window.__coinposh = {
  get sim() {
    return probe.bridge?.stats ?? null;
  },
  get playable() {
    return probe.playable;
  },
  get counts() {
    return { ...probe.counts, refusedFalls: { ...probe.counts.refusedFalls } };
  },
};

const canvas = document.querySelector<HTMLCanvasElement>('#stage');
if (!canvas) {
  throw new Error('CoinPosh boot failed: <canvas id="stage"> is missing from index.html');
}

const uiRoot = document.createElement('div');
document.body.append(uiRoot);
const ui = mountUi(uiRoot);

let audio: AudioEngine | null = null;

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

const netReady = bootNet(ui).catch((error: unknown) => {
  console.error('CoinPosh net failed to start; balances will not sync this session.', error);
  return null;
});

const hydrated = netReady
  .then((net) => (net ? hydrateNet(net, ui) : null))
  .catch((error: unknown) => {
    console.error('CoinPosh net could not load the table; the game cannot be played.', error);
    return null;
  });

void bootScene(canvas, hydrated);

// The music loop is rendered offline now, before any gesture, so the first tap only has to
// unlock the context and the track starts without a render hitch.
// The saved mixer is attached before the music starts, so the first note plays at the volume
// the player chose rather than the engine defaults.
async function bootAudio(app: UiApp): Promise<void> {
  if (!isAudioSupported()) {
    console.warn('[CoinPosh] Web Audio is unavailable in this browser; playing without sound.');
    return;
  }
  const engine = createAudioEngine();
  app.attachAudio(engine);
  audio = engine;
  await engine.startMusic();
}

/**
 * Without `VITE_API_URL` (the GitHub Pages build) the net layer runs Demo Mode against its
 * in-browser server, and the banner tells the player their progress is unranked and local.
 */
async function bootNet(app: UiApp): Promise<Net> {
  registerNetStrings(app.i18n);
  const mode = currentNetMode();
  const turnstileToken = await bootTurnstile(app, mode);
  const net = await createNet({
    mode,
    locale: () => app.i18n.language,
    turnstileToken,
    onError: (error) => {
      console.error('CoinPosh net error.', error);
    },
  });
  teardown.push(() => {
    net.table.close();
  });
  if (net.mode.kind !== 'demo') return net;
  let removeBanner = showDemoBanner(app);
  const stopRelabel = app.i18n.onLanguageChanged(() => {
    removeBanner = showDemoBanner(app);
  });
  teardown.push(() => {
    stopRelabel();
    removeBanner();
  });
  return net;
}

/**
 * Demo Mode never asks for a Turnstile token, so the loader and its overlay are imported only in
 * live mode and stay out of the Pages bundle.
 */
async function bootTurnstile(app: UiApp, mode: NetMode): Promise<() => Promise<string>> {
  if (mode.kind !== 'live') {
    return () =>
      Promise.reject(
        new Error(
          'CoinPosh net: Turnstile was asked for a token in Demo Mode. Demo sign-up uses local tokens; this is a wiring bug.',
        ),
      );
  }
  const [{ createTurnstile }, { mountTurnstileOverlay }] = await Promise.all([
    import('./net/turnstile.ts'),
    import('./ui/turnstile/overlay.ts'),
  ]);
  const turnstile = createTurnstile({
    mode,
    siteKey: currentTurnstileSiteKey(),
    language: () => app.i18n.language,
    host: () =>
      mountTurnstileOverlay({
        document,
        translate: (key) => app.i18n.t(key),
        onLanguageChanged: (relabel) => app.i18n.onLanguageChanged(relabel),
        feedback: (kind) => {
          app.bus.emit('ui:feedback', { kind });
        },
      }),
  });
  teardown.push(() => {
    turnstile.dispose();
  });
  return () => turnstile.token();
}

/** The net layer once the player's table snapshot has been adopted. */
interface NetBoot {
  readonly net: Net;
  readonly state: StateResponse;
  readonly vault: VaultTracker;
  /** Re-reads the table from the server, for a wallet change TableSync did not see. */
  readonly resync: (reason: string) => void;
}

/**
 * Loads the player's table, hands it to the table sync and the HUD, and keeps the Vault plaque
 * following the table from then on.
 */
async function hydrateNet(net: Net, app: UiApp): Promise<NetBoot> {
  const state = await loadState(net, app);
  const vault = trackVault(app, net.table, state);
  net.table.hydrate(state);
  app.setUpgradeLevels(state.venue.upgrades);
  const resync = (reason: string): void => {
    net.table.resume().then(
      () => {
        vault.resumed();
      },
      (error: unknown) => {
        console.error(`CoinPosh net: the table did not resync after ${reason}.`, error);
      },
    );
  };
  mountUpgradePurchases(net, app, state, () => {
    resync('an upgrade purchase');
  });
  const resyncWhenShown = (): void => {
    if (document.visibilityState !== 'visible') return;
    resync('the tab came back');
  };
  document.addEventListener('visibilitychange', resyncWhenShown);
  teardown.push(() => {
    document.removeEventListener('visibilitychange', resyncWhenShown);
  });
  return { net, state, vault, resync };
}

/**
 * Turns the upgrades panel's confirms into server purchases. The Vault plaque counts the drop
 * buffer on top of the wallet, so a purchase re-reads the table instead of showing the bare
 * wallet the purchase returns. Stale levels re-read the state without `hydrate=boot`, which
 * would refund the coins in play.
 */
function mountUpgradePurchases(
  net: Net,
  app: UiApp,
  state: StateResponse,
  walletChanged: () => void,
): void {
  const upgrades = mountUpgrades({
    ui: {
      store: app.store,
      bus: app.bus,
      i18n: app.i18n,
      bannerSlot: app.bannerSlot,
      onUpgradeRequest: (handler) => app.onUpgradeRequest(handler),
      resolveUpgrade: (levels) => {
        app.resolveUpgrade(levels);
      },
      setWallet: walletChanged,
    },
    api: netUpgradeApi(net.client),
    venueId: state.venue.id,
    audio: () => audio,
    refresh: () => {
      net.client.call('state').then(
        (fresh) => {
          app.setUpgradeLevels(fresh.venue.upgrades);
        },
        (error: unknown) => {
          console.error('CoinPosh net: the upgrade levels did not refresh.', error);
        },
      );
    },
    onError: (error) => {
      console.error('CoinPosh net: an upgrade purchase failed.', error);
    },
  });
  teardown.push(() => {
    upgrades.dispose();
  });
}

/**
 * The player's table snapshot. Without it there is nothing to play, so a failed load shows the
 * offline notice and keeps retrying with backoff until the server answers or the page goes away.
 */
async function loadState(net: Net, app: UiApp): Promise<StateResponse> {
  const stopped = new AbortController();
  teardown.push(() => {
    stopped.abort();
  });
  let hideOffline: (() => void) | null = null;
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await net.client.call('state', { query: { hydrate: 'boot' } });
      } catch (error) {
        if (stopped.signal.aborted) throw error;
        const delayMs = Math.min(STATE_RETRY.firstDelayMs * 2 ** attempt, STATE_RETRY.maxDelayMs);
        console.warn(
          `CoinPosh net: the table did not load; retrying in ${delayMs} ms. Play starts once the server answers.`,
          error,
        );
        hideOffline ??= showOfflineBanner(app);
        await abortableDelay(delayMs, stopped.signal);
      }
    }
  } finally {
    hideOffline?.();
  }
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('CoinPosh net: stopped loading the table because the page is going away.'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * TODO(net owner): the offline copy promises coins are counted on reconnect, but nothing can be
 * played before the first load; swap in a dedicated EN/FR/DE key such as `net.status.connecting`.
 */
function showOfflineBanner(app: UiApp): () => void {
  const banner = document.createElement('p');
  banner.setAttribute('role', 'status');
  banner.dataset.testid = 'net-offline';
  Object.assign(banner.style, OFFLINE_BANNER_STYLE);
  const label = (): void => {
    banner.textContent = app.i18n.t(NET_I18N_KEYS.offline);
  };
  label();
  const stopRelabel = app.i18n.onLanguageChanged(label);
  app.bannerSlot.append(banner);
  return () => {
    stopRelabel();
    banner.remove();
  };
}

interface VaultTracker {
  /** A drop took `coin` from the pre-minted buffer, or asked the server to mint when null. */
  spent(coin: MintedCoin | null): void;
  /** The table re-hydrated from a fresh server snapshot after the tab came back. */
  resumed(): void;
}

/**
 * The Vault shows every coin the player holds: the server's wallet, the pre-minted drop buffer
 * (already paid for out of the wallet, so the wallet alone reads low), and winnings still
 * waiting for the server's answer, shimmering while any are.
 *
 * TableSync says how many coins are buffered but not what they are worth, so the worth comes
 * from server coins seen here: the snapshot's buffer, oldest first as drops take them, and for
 * coins the server minted into the buffer since, the value of the latest drop coin it sent.
 * A resync replaces the buffer wholesale, so the coins seen before it no longer describe it; once
 * the table is synced again every buffered coin is valued like the latest drop coin.
 * TODO(net owner): read the buffered value from TableSync, or get a 'resynced' event, once P-145
 * exposes one.
 */
function trackVault(app: UiApp, table: Net['table'], state: StateResponse): VaultTracker {
  const known = state.table.buffer.map((coin) => coin.value);
  let refillValue = state.table.buffer.at(-1)?.value ?? 0;
  let awaitingSync = false;
  const refresh = (): void => {
    const balance = table.balance;
    if (!balance) return;
    let buffered = 0;
    for (let i = 0; i < table.bufferSize; i += 1) buffered += known[i] ?? refillValue;
    app.setWallet({
      ...balance.wallet,
      coins: balance.wallet.coins + buffered + balance.provisionalCoins,
      provisional: balance.provisionalCoins > 0,
    });
  };
  const forgetBuffer = (): void => {
    awaitingSync = false;
    known.length = 0;
    refresh();
  };
  teardown.push(
    table.subscribe((event) => {
      if (event.type === 'dropSettled') refillValue = event.coin.value;
      if (awaitingSync && event.type === 'status' && event.status === 'synced') {
        forgetBuffer();
        return;
      }
      refresh();
    }),
  );
  return {
    spent(coin) {
      if (coin) {
        known.shift();
        refillValue = coin.value;
      }
      refresh();
    },
    resumed() {
      if (table.status === 'synced') forgetBuffer();
      else awaitingSync = true;
    },
  };
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

/**
 * Play starts once the table is hydrated and the first frame is drawn. The sim opens on the heap
 * the server minted, so it pays out from the first shove. Until play starts the
 * bridge draws the coins and a tap on the table answers with the tap cue.
 */
async function bootScene(
  target: HTMLCanvasElement,
  hydrated: Promise<NetBoot | null>,
): Promise<void> {
  let stage: Stage;
  let riviera: typeof RivieraModule;
  let systemsModule: typeof SystemsModule;
  let vfxModule: typeof VfxModule;
  let cratesApi: typeof CratesApi;
  let sim: StartedSim;
  let started: StartedSim | undefined;
  let built: Stage | undefined;
  const pending: Promise<unknown>[] = [];
  const stopEarlyTaps = answerEarlyTaps(target.id);
  try {
    const simModuleLoaded = import('./game/simWorker/index.ts');
    // The sim opens on the server's heap, so it waits for hydration; the GPU need not.
    const simStarted = Promise.all([simModuleLoaded, openingTable(hydrated)]).then(
      ([simModule, heap]) => {
        started = startSim(simModule, heap);
        return started;
      },
    );
    pending.push(simStarted);
    // A failed start is already logged and kept in `bridge.failure`; the mark only times success.
    const simReady = simStarted
      .then((early) => early.bridge.ready)
      .then(
        () => {
          markBoot('sim-ready');
        },
        () => undefined,
      );
    const [stageModule, venueModule, simModule, gameSystems, effects, crates] = await Promise.all([
      import('./stage.ts'),
      import('./scene/venues/riviera/index.ts'),
      simModuleLoaded,
      import('./game/systems/index.ts'),
      import('./vfx/index.ts'),
      import('./game/crates/index.ts'),
    ]);
    markBoot('modules');
    riviera = venueModule;
    systemsModule = gameSystems;
    vfxModule = effects;
    cratesApi = crates;
    // On a software GPU the stage's first frames hold the main thread for seconds, and a worker's
    // first messages wait for the main thread, so Rapier gets a bounded head start before them.
    await Promise.race([
      simReady,
      new Promise((resolve) => setTimeout(resolve, SIM_HEAD_START_MS)),
    ]);
    const stageBuilt = stageModule
      .createStage(target, {
        look: riviera.RIVIERA_RENDER_LOOK,
        vignetteTint: riviera.RIVIERA_VIGNETTE_TINT,
        coins: { capacity: COIN_CAPACITY, radius: simModule.SIM_COIN_DIMENSIONS.radius },
      })
      .then((created) => {
        markBoot('stage');
        built = created;
        return created;
      });
    pending.push(stageBuilt);
    [stage, sim] = await Promise.all([stageBuilt, simStarted]);
    teardownStage(stage);
  } catch (error) {
    console.error('CoinPosh boot failed: the renderer could not start.', error);
    void Promise.allSettled(pending).then(() => {
      started?.bridge.dispose();
      built?.dispose().catch((disposeError: unknown) => {
        console.error('CoinPosh teardown: the stage did not dispose cleanly.', disposeError);
      });
    });
    return;
  }
  const { bridge, heap, takeEarlyEvents } = sim;
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
  markBoot('venue');
  const revealVenue = holdBackVenue(venue.root);
  attachVenue(stage, venue, riviera.applyCameraPreset);
  stage.castCoinShadowsFrom(venue.lighting.key);
  watchReducedMotion((reduced) => {
    venue.setReducedMotion(reduced);
    stage.coins.setReducedMotion(reduced);
  });
  // The renderer checks its clock against the first frame's timestamp, so the effects' first,
  // slowest update must not run inside that frame.
  await frameDrawn(stage);
  const vfx = attachVfx(stage, vfxModule);
  const boot = await hydrated;
  const simBacklog = takeEarlyEvents();
  if (!boot || bridge.failure) {
    revealVenue();
    attachTable(stage, venue, bridge);
    return;
  }
  stopEarlyTaps();
  const systems = startPlay(systemsModule, stage, bridge, boot, { heap, simBacklog, vfx });
  mountTableCrates(cratesApi, { stage, venue, bridge, boot, systems, vfx });
  // Shown only now that crates have added the unbox light: a light added later changes every lit
  // shader, so a venue drawn before it would have every program linked twice.
  revealVenue();
  attachTable(stage, venue, bridge).use(systems);
  probe.playable = true;
  markBoot('playable');
}

/** The opening heap the server minted onto the table, in every net mode. */
async function openingTable(hydrated: Promise<NetBoot | null>): Promise<readonly MintedCoin[]> {
  const boot = await hydrated;
  return boot === null ? [] : openingTableCoins(boot.state);
}

function openingHeapOf(coins: readonly MintedCoin[]): OpeningHeap | null {
  const tier = coins[0]?.tier;
  if (tier === undefined) return null;
  const mixed = coins.find((coin) => coin.tier !== tier);
  if (mixed) {
    throw new Error(
      `CoinPosh boot: the opening table holds ${tier} and ${mixed.tier} coins, but the sim lays its heap in one tier; mint the Demo heap in a single tier (net/mock/world.ts).`,
    );
  }
  return { coins: coins.length, tier };
}

/**
 * Keeps the sim's falls and fusions from before the game systems exist, so a heap coin shoved
 * off while the scene loads is still paid. Contacts are dropped: their clinks are long past.
 * The returned function stops collecting and hands over what was kept.
 */
function holdEarlyEvents(bridge: SimBridge): () => readonly SimEventBatch[] {
  const kept: SimEventBatch[] = [];
  const stop = bridge.onEvents(({ falls, fusions }) => {
    if (falls.length > 0 || fusions.length > 0) kept.push({ falls, contacts: [], fusions });
  });
  teardown.push(stop);
  return () => {
    stop();
    return kept.splice(0);
  };
}

/** Resolves once the next frame has been drawn: promise callbacks run after the frame callback. */
function frameDrawn(stage: Stage): Promise<void> {
  return new Promise((resolve) => {
    const stop = stage.onFrame(() => {
      stop();
      resolve();
    });
    teardown.push(stop);
  });
}

/**
 * Follows the stage's renderer through device-loss rebuilds, its quality tier and the motion
 * setting. Without effects the game still plays, so a failure here is logged, not fatal.
 */
function attachVfx(stage: Stage, vfxModule: typeof VfxModule): Vfx | null {
  let vfx: Vfx;
  try {
    vfx = vfxModule.createVfx({
      scene: stage.scene,
      camera: stage.camera,
      renderer: stage.renderer,
      backend: stage.backend,
      overlay: uiRoot,
      i18n: ui.i18n.instance,
      quality: stage.profile.tier,
      reducedMotion: isReducedMotion(),
    });
  } catch (error) {
    console.error('CoinPosh effects failed to start; the game continues without them.', error);
    return null;
  }
  let renderer = stage.renderer;
  const stopFrame = stage.onFrame((deltaSeconds) => {
    if (stage.renderer !== renderer) {
      renderer = stage.renderer;
      vfx.setRenderer(renderer, stage.backend);
    }
    vfx.update(deltaSeconds);
  });
  const stopTier = stage.onTierChange((profile) => {
    vfx.setQuality(profile.tier);
  });
  const stopMotion = onReducedMotionChange((reduced) => {
    vfx.setReducedMotion(reduced);
  });
  teardown.push(() => {
    stopFrame();
    stopTier();
    stopMotion();
    vfx.dispose();
  });
  return vfx;
}

/**
 * Until the game systems take the canvas, a tap on the table still answers with the UI's tap
 * sound and haptic instead of nothing. It listens on the document because the stage swaps in a
 * fresh canvas, same id, when it falls back to WebGL2.
 */
function answerEarlyTaps(canvasId: string): () => void {
  const onPointerDown = (event: PointerEvent): void => {
    if (!event.isPrimary) return;
    if (event.target instanceof HTMLCanvasElement && event.target.id === canvasId) {
      ui.bus.emit('ui:feedback', { kind: 'tap' });
    }
  };
  document.addEventListener('pointerdown', onPointerDown);
  const stop = (): void => {
    document.removeEventListener('pointerdown', onPointerDown);
  };
  teardown.push(stop);
  return stop;
}

interface PlayStart {
  /** The coins the sim's opening heap stands for, in sim id order. */
  readonly heap: readonly MintedCoin[];
  readonly simBacklog: readonly SimEventBatch[];
  readonly vfx: Vfx | null;
}

/**
 * Hands the canvas to the gameplay glue: taps drop, a hold pours, Space drops or pours from the
 * keyboard, A/D/W and two-finger swipes nudge, and the aim reticle rides the drop rail. Each
 * drop spends a server-minted coin before the sim sees it, and each nudge jolts the sim cabinet.
 * The juice listens from the first event on, and hears audio as soon as it is up.
 */
function startPlay(
  systemsModule: typeof SystemsModule,
  stage: Stage,
  bridge: SimBridge,
  boot: NetBoot,
  start: PlayStart,
): GameSystems {
  // TODO(ui owner): take the number-pop target from a UiApp vault anchor instead of the DOM.
  const vault = uiRoot.querySelector('.cp-plaque');
  if (!vault) {
    throw new Error(
      'CoinPosh boot: the HUD balance plaque (.cp-plaque) is missing, so credited coins have nowhere to fly to; mount the UI before the scene.',
    );
  }
  const systems = systemsModule.createGameSystems({
    bridge,
    net: { table: boot.net.table, clock: boot.net.clock },
    ui,
    canvas: () => stage.canvas,
    simBacklog: start.simBacklog,
    openingHeap: start.heap,
  });
  teardown.push(() => {
    systems.dispose();
  });
  teardown.push(
    systemsModule.wireFeedback(systems.events, {
      vfx: () => start.vfx,
      audio: () => audio,
      vault,
    }),
  );
  systems.hydrate(boot.state);
  const { counts } = probe;
  const offs = [
    systems.events.on('drop:requested', ({ coin, poured }) => {
      boot.vault.spent(coin);
      ui.bus.emit('ui:feedback', { kind: poured ? 'tick' : 'tap' });
    }),
    systems.events.on('coin:fell', ({ edge }) => {
      counts.falls += 1;
      if (edge === 'front') counts.frontFalls += 1;
    }),
    systems.events.on('coin:fusion', () => {
      counts.fusions += 1;
    }),
    systems.events.on('fall:refused', ({ reason }) => {
      const key = reason ?? 'unanswered';
      counts.refusedFalls[key] = (counts.refusedFalls[key] ?? 0) + 1;
    }),
    systems.events.on('value:credited', ({ amount }) => {
      counts.credits += 1;
      counts.creditedCoins += amount;
    }),
  ];
  teardown.push(() => {
    for (const off of offs) off();
  });
  return systems;
}

interface CrateWiring {
  readonly stage: Stage;
  readonly venue: RivieraVenue;
  readonly bridge: SimBridge;
  readonly boot: NetBoot;
  readonly systems: GameSystems;
  readonly vfx: Vfx | null;
}

/**
 * Vault Crates on the table: the server spawns them with drops, they ride the pusher to the lip,
 * and a fall is claimed, opened by the server and played as the unbox. Crates already on the
 * table when the session loads ride from where the snapshot left them. The reward card flies
 * into the Vault plaque, and the plaque re-reads the server wallet once the player collects.
 * Crates are a bonus on top of play, so a failure to mount them is logged, not fatal.
 */
function mountTableCrates(cratesApi: typeof CratesApi, wiring: CrateWiring): void {
  const { stage, venue, bridge, boot, systems, vfx } = wiring;
  const haptics = new Haptics(typeof navigator === 'undefined' ? undefined : navigator, () =>
    performance.now(),
  );
  haptics.enabled = ui.store.getState().settings.haptics;
  let crates: CratesApi.CratesModule;
  try {
    crates = cratesApi.mountCrates({
      game: systems.events,
      net: { table: boot.net.table, client: boot.net.client },
      sim: bridge,
      stage,
      framing: (aspect) => venue.cameraPreset(aspect),
      ui,
      host: uiRoot,
      vfx,
      haptics,
      audio: () => audio,
      inventoryTarget: () => uiRoot.querySelector<HTMLElement>('.cp-plaque'),
    });
  } catch (error) {
    console.error(
      'CoinPosh crates failed to mount; the game continues without Vault Crates.',
      error,
    );
    return;
  }
  const { counts } = probe;
  const offs = [
    ui.onSettingsChange((settings) => {
      haptics.enabled = settings.haptics;
    }),
    crates.events.on('crate:spawned', () => {
      counts.cratesSpawned += 1;
    }),
    crates.events.on('crate:opened', () => {
      counts.cratesOpened += 1;
    }),
    crates.events.on('crate:collected', () => {
      counts.cratesCollected += 1;
      boot.resync('a Vault Crate was collected');
    }),
    crates.events.on('crate:failed', ({ crateId, error }) => {
      console.error(`CoinPosh crates: crate ${crateId} could not be claimed or opened.`, error);
    }),
  ];
  teardown.push(() => {
    for (const off of offs) off();
    crates.dispose();
  });
  crates.controller.adopt(boot.state.table.crates);
}

/** Pushed after the bridge, so teardown stops the renderer before the sim it draws from. */
function teardownStage(stage: Stage): void {
  teardown.push(() => {
    stage.dispose().catch((error: unknown) => {
      console.error('CoinPosh teardown: the stage did not dispose cleanly.', error);
    });
  });
}

interface StartedSim {
  readonly bridge: SimBridge;
  /** The server coins the sim's opening heap stands for, in sim id order. */
  readonly heap: readonly MintedCoin[];
  readonly takeEarlyEvents: () => readonly SimEventBatch[];
}

/** Started alongside the renderer, so the worker loads Rapier while the GPU initialises. */
function startSim(simModule: typeof SimWorkerModule, heap: readonly MintedCoin[]): StartedSim {
  const openingHeap = openingHeapOf(heap);
  const bridge = simModule.createSimBridge({
    seed: TABLE_SEED,
    ...(openingHeap ? { openingHeap } : {}),
  });
  probe.bridge = bridge;
  markBoot('sim-start');
  const stopCounting = bridge.onEvents(({ falls, fusions }) => {
    probe.counts.simFalls += falls.length;
    probe.counts.simFusions += fusions.length;
  });
  teardown.push(() => {
    stopCounting();
    probe.bridge = null;
    bridge.dispose();
  });
  return { bridge, heap, takeEarlyEvents: holdEarlyEvents(bridge) };
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
 * Where the coins on screen come from: the sim worker bridge, or the game systems wrapped
 * around it, writes interpolated sim transforms every frame. A source only places coins: what a
 * coin is worth only ever comes from the server.
 */
interface CoinTransformSource {
  /** Runs once per frame, before the stage uploads the field. */
  sync(field: CoinField): void;
}

interface TableView {
  /** Draws the coins from `source` from the next frame on. */
  use(source: CoinTransformSource): void;
}

/** The pusher is set from the same sync as the coins, so it never lags the coins it shoves. */
function attachTable(stage: Stage, venue: RivieraVenue, bridge: SimBridge): TableView {
  let source: CoinTransformSource = bridge;
  const detach = stage.onFrame(() => {
    source.sync(stage.coins);
    venue.setPusherStroke(bridge.stats.pusherStroke);
  });
  teardown.push(detach);
  return {
    use(next) {
      source = next;
    },
  };
}

function watchReducedMotion(apply: (reduced: boolean) => void): void {
  if (typeof matchMedia !== 'function') return;
  const query = matchMedia(REDUCED_MOTION_QUERY);
  apply(query.matches);
  query.addEventListener('change', (event) => {
    apply(event.matches);
  });
}

function markBoot(step: string): void {
  performance.mark(`coinposh:boot:${step}`);
}

/**
 * Keeps the venue's meshes out of the frames drawn while play is still being set up, so their
 * shaders are linked once, in the first frame after everything that adds a light has run. The
 * lights keep their layers, so those frames already light the scene as it will be drawn.
 * Returns the function that shows the venue again.
 *
 * Only what the hold itself changed is undone: layers enabled on a held object during the hold
 * are kept, an object whose layers were replaced during the hold is left as it was set, and
 * objects added during the hold were never held.
 */
function holdBackVenue(root: Object3D): () => void {
  // A layer no camera sees.
  const heldLayer = 31;
  const heldBit = 1 << heldLayer;
  const held: { readonly object: Object3D; readonly mask: number }[] = [];
  root.traverse((object) => {
    if ((object as { readonly isLight?: boolean }).isLight === true) return;
    held.push({ object, mask: object.layers.mask });
    object.layers.set(heldLayer);
  });
  let revealed = false;
  return () => {
    if (revealed) return;
    revealed = true;
    for (const { object, mask } of held) {
      const now = object.layers.mask;
      if ((now & heldBit) === 0) continue;
      object.layers.mask = ((now & ~heldBit) | mask) >>> 0;
    }
  };
}

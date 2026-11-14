import type { MintedCoin, Roll, StateResponse } from '@coinposh/shared';
import type { Object3D } from 'three/webgpu';
import { browserVibrate } from './app/feedback.ts';
import { mountUi, type UiApp } from './app/index.ts';
import { createAudioEngine, isAudioSupported, type AudioEngine } from './audio/index.ts';
import {
  mountAscension,
  mountAscensionHud,
  netAscensionApi,
  type AscensionHud,
} from './game/ascension/index.ts';
import { createTableRelay, type TableRelay } from './game/ascension/relay.ts';
import type * as CratesApi from './game/crates/index.ts';
import type * as SessionModule from './game/session/index.ts';
import type { ElsewhereOverlay, PagePort, SnapshotTriggers } from './game/session/index.ts';
import type * as SystemsModule from './game/systems/index.ts';
import type { GameSystems } from './game/systems/index.ts';
import { mountUpgrades, netUpgradeApi } from './game/upgrades/index.ts';
import type * as SimWorkerModule from './game/simWorker/index.ts';
import type { SimBridge, SimBridgeStats, SimEventBatch } from './game/simWorker/index.ts';
import { LANGUAGES, type I18n, type ResourceTree } from './i18n/index.ts';
import {
  ApiRequestError,
  createNet,
  currentNetMode,
  mountDemoBanner,
  NET_I18N_KEYS,
  NET_I18N_SOURCE,
  openingLayout,
  SnapshotCadence,
  type DemoBannerColors,
  type Net,
  type NetMode,
  type OpeningLayout,
} from './net/index.ts';
import { monotonicNow } from './net/clock.ts';
import { realScheduler } from './net/connectivity.ts';
import { currentTurnstileSiteKey } from './net/env.ts';
import type { CoinField, CoinTierId } from './scene/coins/index.ts';
import { rivieraTokens } from './scene/venues/riviera/palette.ts';
import type * as RivieraModule from './scene/venues/riviera/index.ts';
import type { RivieraVenue } from './scene/venues/riviera/index.ts';
import type { Stage } from './stage.ts';
import {
  announcementHoldFor,
  holdTierVoice,
  type AnnouncementHold,
} from './ui/components/announcementHold.ts';
import {
  PAYOUT_FLIGHT_MS,
  PAYOUT_HOLD_CAP_MS,
  PAYOUT_STAGGER_MS,
  walletPayoutFor,
  type WalletPayout,
} from './ui/components/balancePlaque.ts';
import { holdForCrateCinematics } from './ui/components/cinematicHold.ts';
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
  /** How the table in play was laid when it booted; null before a table was laid. */
  readonly restored: Readonly<RestoreCounts> | null;
  /** True while another tab or device holds the table and this page waits on "Play here". */
  readonly superseded: boolean;
}

interface RestoreCounts {
  /** Boots of the table this page ran: 1 for the page load, one more for each "Play here". */
  boots: number;
  poses: number;
  heapSlots: number;
  cratePoses: number;
  chutes: number;
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

const probe: {
  bridge: SimBridge | null;
  playable: boolean;
  counts: ProbeCounts;
  restored: RestoreCounts | null;
  superseded: boolean;
} = {
  bridge: null,
  playable: false,
  restored: null,
  superseded: false,
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
  get restored() {
    return probe.restored ? { ...probe.restored } : null;
  },
  get superseded() {
    return probe.superseded;
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
/** Mounted once play starts; until then the boot state's venue is the one played. */
let ascensionHud: AscensionHud | null = null;

const teardown: (() => void)[] = [];
const runTeardown = (): void => {
  for (const dispose of teardown.splice(0).reverse()) dispose();
};
/** Run on every pagehide before the teardown, also for a page kept in the back/forward cache. */
const pagehideHooks = new Set<() => void>();
window.addEventListener('pagehide', (event) => {
  for (const hook of [...pagehideHooks]) hook();
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
    // A table open elsewhere comes back only through "Play here".
    if (document.visibilityState !== 'visible' || net.table.superseded) return;
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
    venueId: () => ascensionHud?.state.venue.id ?? state.venue.id,
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
  /** A new boot of the table ("Play here") replaced the buffer with the one `state` lists. */
  adopted(state: StateResponse): void;
}

/**
 * The Vault shows every coin the player holds: the server's wallet, the pre-minted drop buffer
 * (already paid for out of the wallet, so the wallet alone reads low), and winnings still
 * waiting for the server's answer, shimmering while any are. Only the wallet is spendable, so
 * upgrade prices are checked against it alone.
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
  const known: number[] = state.table.buffer.map((coin) => coin.value);
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
      spendableCoins: balance.wallet.coins,
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
      // A claim settles with the new wallet while its estimate is still provisional in the
      // outbox; the balance event once it leaves is the true sum. Refreshing here counts the
      // credit twice, and a Vault hold absorbs that phantom rise, so a crate's coin line
      // would come up short.
      if (event.type === 'claimSettled') return;
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
    adopted(booted) {
      awaitingSync = false;
      known.splice(0, known.length, ...booted.table.buffer.map((coin) => coin.value));
      refillValue = booted.table.buffer.at(-1)?.value ?? refillValue;
      refresh();
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
 * Play starts once the table is hydrated and the first frame is drawn. The sim lays the table
 * the server stored, each coin bound to the server coin it stands for, so it pays out from the
 * first shove. Until play starts the bridge draws the coins and a tap on the table answers with
 * the tap cue. When another tab or device boots the table, play here stops under the "This
 * table is open elsewhere" overlay, and its "Play here" boots the table again in this page.
 */
async function bootScene(
  target: HTMLCanvasElement,
  hydrated: Promise<NetBoot | null>,
): Promise<void> {
  let stage: Stage;
  let riviera: typeof RivieraModule;
  let simApi: typeof SimWorkerModule;
  let systemsModule: typeof SystemsModule;
  let vfxModule: typeof VfxModule;
  let cratesApi: typeof CratesApi;
  let sessionModule: typeof SessionModule;
  let sim: StartedSim;
  let built: Stage | undefined;
  const run = { scope: createScope() };
  // Pushed before the stage, so teardown stops the renderer before the sim it draws from.
  teardown.push(() => {
    run.scope.dispose();
  });
  const pending: Promise<unknown>[] = [];
  const stopEarlyTaps = answerEarlyTaps(target.id);
  try {
    const simModuleLoaded = import('./game/simWorker/index.ts');
    // The sim lays the server's table, so it waits for hydration; the GPU need not.
    const simStarted = Promise.all([simModuleLoaded, openingTable(hydrated)]).then(
      ([simModule, layout]) => startSim(simModule, layout, run.scope, { held: true }),
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
    const [stageModule, venueModule, simModule, gameSystems, effects, crates, session] =
      await Promise.all([
        import('./stage.ts'),
        import('./scene/venues/riviera/index.ts'),
        simModuleLoaded,
        import('./game/systems/index.ts'),
        import('./vfx/index.ts'),
        import('./game/crates/index.ts'),
        import('./game/session/index.ts'),
      ]);
    markBoot('modules');
    riviera = venueModule;
    simApi = simModule;
    systemsModule = gameSystems;
    vfxModule = effects;
    cratesApi = crates;
    sessionModule = session;
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
      run.scope.dispose();
      built?.dispose().catch((disposeError: unknown) => {
        console.error('CoinPosh teardown: the stage did not dispose cleanly.', disposeError);
      });
    });
    return;
  }
  const { bridge, layout } = sim;
  let venue: RivieraVenue;
  try {
    venue = await riviera.createRivieraVenue(stage.scene, null, {
      quality: stage.profile.venueDetail,
      shadows: stage.look.shadows,
    });
  } catch (error) {
    run.scope.dispose();
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
  if (!boot || !layout || bridge.failure) {
    revealVenue();
    attachTable(stage, venue, bridge);
    releaseHeldSim(bridge);
    return;
  }
  stopEarlyTaps();

  const play = (started: StartedSim, state: StateResponse, laid: OpeningLayout): GameSystems => {
    const scope = createScope();
    run.scope.add(() => {
      scope.dispose();
    });
    playing = { sim: started, layout: laid, scope };
    const payouts = orderCratePayouts(walletPayoutFor(ui.store));
    scope.add(() => {
      payouts.dispose();
    });
    const systems = startPlay(systemsModule, stage, started, boot, state, vfx, payouts, scope);
    const rides = mountTableCrates(
      cratesApi,
      { stage, venue, bridge: started.bridge, boot, systems, vfx, crates: laid.crates, payouts },
      scope,
    );
    wireTableSession(
      {
        net: boot.net,
        session: sessionModule,
        bridge: started.bridge,
        systems,
        rides,
        onSuperseded: () => {
          probe.superseded = true;
          probe.playable = false;
          elsewhere.show();
        },
      },
      scope,
    );
    return systems;
  };

  interface Laid {
    readonly state: StateResponse;
    readonly layout: OpeningLayout;
    readonly sim: StartedSim;
    readonly scope: Scope;
  }

  let playing: { readonly sim: StartedSim; readonly layout: OpeningLayout; readonly scope: Scope };

  const layFrom = async (state: StateResponse): Promise<Laid> => {
    const laid = openingLayout(state);
    const scope = createScope();
    try {
      const next = startSim(simApi, laid, scope);
      await next.bridge.ready;
      return { state, layout: laid, sim: next, scope };
    } catch (error) {
      scope.dispose();
      throw error;
    }
  };

  const adoptState = (state: StateResponse): void => {
    boot.net.table.hydrate(state);
    ui.setUpgradeLevels(state.venue.upgrades);
    boot.vault.adopted(state);
  };

  /** The new sim is ready before the old run goes, so the table never blanks. */
  const playOn = ({ state, layout: laid, sim: next, scope }: Laid): void => {
    run.scope.dispose();
    run.scope = scope;
    view.use(next.bridge, next.bridge);
    adoptState(state);
    view.use(play(next, state, laid), next.bridge);
    probe.playable = true;
  };

  /**
   * "Play here": a fresh `hydrate=boot` takes the lease back and lays the table as the other
   * tab left it.
   */
  const retake = sessionModule.createRetake<StateResponse, Laid>({
    simReady: () => warmSim(simApi),
    boot: () => boot.net.client.call('state', { query: { hydrate: 'boot' } }),
    lay: layFrom,
    play: (laid) => {
      probe.superseded = false;
      playOn(laid);
      markBoot('retaken');
    },
    discard: ({ scope }) => {
      scope.dispose();
    },
  });

  const elsewhere = mountElsewhere(sessionModule, retake);
  const systems = play(sim, boot.state, layout);
  // Shown only now that crates have added the unbox light: a light added later changes every lit
  // shader, so a venue drawn before it would have every program linked twice.
  revealVenue();
  const view = attachTable(stage, venue, bridge);
  view.use(systems, bridge);
  // The venue's and the coins' first frames link their shaders, seconds on a software GPU. The
  // sim waits them out at the tick it was laid at, so the table under the poster is the one
  // scripts/capture-poster.ts drew on every device, and play starts once the table is on screen.
  await coinsDrawn(stage, bridge);
  // A software GPU can finish that link only as the next frame waits on it.
  await frameDrawn(stage);
  releaseHeldSim(bridge);
  if (!probe.superseded) probe.playable = true;
  markBoot('playable');

  const relay = createTableRelay<Laid>({
    state: boot.state,
    hold: () => {
      probe.playable = false;
      playing.scope.dispose();
      view.use(playing.sim.bridge, playing.sim.bridge);
    },
    boot: () => boot.net.client.call('state', { query: { hydrate: 'boot' } }),
    lay: layFrom,
    play: (laid) => {
      playOn(laid);
      markBoot('ascended');
    },
    discard: ({ scope }) => {
      scope.dispose();
    },
    // The held sim's coins and crates are gone on the server, so play resumes on it with no
    // crates riding; every coin dropped from here on is one the server will pay.
    resume: (state, booted) => {
      const { sim: held, layout: heldLayout } = playing;
      if (booted) adoptState(state);
      view.use(play(held, state, { ...heldLayout, crates: [] }), held.bridge);
      probe.playable = true;
    },
    onError: (error) => {
      console.error(
        'CoinPosh ascension: the new venue could not be laid; play goes on on the old table.',
        error,
      );
    },
  });
  mountAscensionDoor(stage, boot, relay);
}

/** The HUD laurel and the prestige loop behind it; an ascension re-lays the new venue in place. */
function mountAscensionDoor(stage: Stage, boot: NetBoot, relay: TableRelay): void {
  const dock = uiRoot.querySelector<HTMLElement>('[data-testid="hud-dock"]');
  if (!dock) {
    throw new Error(
      'CoinPosh boot: the HUD dock ([data-testid="hud-dock"]) is missing, so the ascension entry has nowhere to sit; mount the UI before the scene.',
    );
  }
  const hud = mountAscensionHud({
    ui: {
      store: ui.store,
      bus: ui.bus,
      i18n: ui.i18n,
      setWallet: () => {
        boot.resync('an ascension');
      },
    },
    host: uiRoot,
    dock,
    api: netAscensionApi(boot.net.client),
    state: boot.state,
    readState: () => boot.net.client.call('state'),
    bootState: () => relay.bootState(),
    layTable: (fresh) => relay.layTable(fresh),
    onRelayFailed: (error) => {
      relay.failed(error);
    },
    audio: () => audio,
    vibrate: browserVibrate(),
    stage: () => stage.canvas,
    mount: mountAscension,
    onError: (error) => {
      console.error('CoinPosh net: the ascension could not reach the server.', error);
    },
  });
  ascensionHud = hud;
  teardown.push(() => {
    ascensionHud = null;
    relay.dispose();
    hud.dispose();
  });
}

interface Scope {
  /** Runs `dispose` with the scope, or at once when the scope is already gone. */
  add(dispose: () => void): void;
  dispose(): void;
}

/** What one boot of the table owns, so "Play here" can replace it without a page reload. */
function createScope(): Scope {
  const disposers: (() => void)[] = [];
  let disposed = false;
  return {
    add(dispose) {
      if (disposed) dispose();
      else disposers.push(dispose);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const dispose of disposers.splice(0).reverse()) dispose();
    },
  };
}

/**
 * Starts a throwaway sim worker and resolves once it is ready, so "Play here" knows this page
 * can run a sim before it takes the table: the boot that hands over the layout also takes the
 * lease, so the laid sim itself can only start after it.
 */
async function warmSim(simModule: typeof SimWorkerModule): Promise<void> {
  const spare = simModule.createSimBridge({ seed: TABLE_SEED });
  try {
    await spare.ready;
  } finally {
    spare.dispose();
  }
}

/** How the server laid the table, in every net mode; null without a table to lay. */
async function openingTable(hydrated: Promise<NetBoot | null>): Promise<OpeningLayout | null> {
  const boot = await hydrated;
  return boot === null ? null : openingLayout(boot.state);
}

function restoreCounts(layout: OpeningLayout, boots: number): RestoreCounts {
  const poses = layout.restore.coins.filter((entry) => entry.kind === 'pose').length;
  const cratePoses = layout.crates.filter(({ placement }) => placement.kind === 'pose').length;
  return {
    boots,
    poses,
    heapSlots: layout.restore.coins.length - poses,
    cratePoses,
    chutes: layout.crates.length - cratePoses,
  };
}

const documentPage: PagePort = {
  visible: () => document.visibilityState === 'visible',
  onVisibilityChange(listener) {
    document.addEventListener('visibilitychange', listener);
    return () => {
      document.removeEventListener('visibilitychange', listener);
    };
  },
  onPagehide(listener) {
    pagehideHooks.add(listener);
    return () => {
      pagehideHooks.delete(listener);
    };
  },
};

interface SessionWiring {
  readonly net: Net;
  readonly session: typeof SessionModule;
  readonly bridge: SimBridge;
  readonly systems: GameSystems;
  readonly rides: () => readonly SessionModule.CapturedRide[];
  readonly onSuperseded: () => void;
}

/**
 * Uploads where the table rests whenever it settles after moving, when the page hides and as
 * the page goes away, so a boot anywhere lays it again as it was left. Once another tab or
 * device boots the table, input here stops and the sim holds still under the overlay.
 */
function wireTableSession(wiring: SessionWiring, scope: Scope): void {
  const { net, session, bridge, systems } = wiring;
  const capture = session.createTableCapture({
    sample: () => bridge.snapshot(),
    coinOf: (simId) => systems.coinOf(simId),
    crates: wiring.rides,
  });
  const cadence = new SnapshotCadence({
    table: net.table,
    capture: () => capture.capture(),
    scheduler: realScheduler,
    monotonic: monotonicNow,
  });
  const triggers: SnapshotTriggers = session.wireSnapshotTriggers({
    cadence,
    capture,
    game: systems.events,
    sim: bridge,
    page: documentPage,
    scheduler: realScheduler,
    now: monotonicNow,
    onError: (error) => {
      console.error('CoinPosh table: the sim could not report where the table rests.', error);
    },
  });
  // The bridge resumes itself when the tab is shown, so a table held elsewhere is paused again.
  const holdStill = (): void => {
    bridge.pause();
  };
  const stopSuperseded = net.table.subscribe((event) => {
    if (event.type !== 'sessionSuperseded') return;
    triggers.close();
    systems.suspend();
    holdStill();
    document.addEventListener('visibilitychange', holdStill);
    wiring.onSuperseded();
  });
  scope.add(() => {
    stopSuperseded();
    document.removeEventListener('visibilitychange', holdStill);
    triggers.close();
  });
}

/** The "This table is open elsewhere" overlay, mounted hidden once for the page. */
function mountElsewhere(
  session: typeof SessionModule,
  retake: () => Promise<void>,
): ElsewhereOverlay {
  session.registerSessionStrings(ui.i18n);
  let overlay: ElsewhereOverlay | null = null;
  const view = session.mountElsewhereView({
    host: uiRoot,
    translate: (key) => ui.i18n.t(session.sessionKey(key)),
    onLanguageChanged: (relabel) => ui.i18n.onLanguageChanged(relabel),
    reducedMotion: isReducedMotion,
    onReducedMotionChange,
    onPress: () => {
      overlay?.press();
    },
  });
  const created = session.createElsewhereOverlay({
    view,
    retake,
    feedback: (kind) => {
      ui.bus.emit('ui:feedback', { kind });
    },
    onRetakeFailed: (error) => {
      console.warn(
        'CoinPosh table: "Play here" could not take the table back; the button stays up to try again.',
        error,
      );
    },
  });
  overlay = created;
  teardown.push(() => {
    created.dispose();
  });
  return created;
}

/**
 * Keeps the sim's falls and fusions from before the game systems exist, so a heap coin shoved
 * off while the scene loads is still paid. Contacts are dropped: their clinks are long past.
 * The returned function stops collecting and hands over what was kept.
 */
function holdEarlyEvents(bridge: SimBridge, scope: Scope): () => readonly SimEventBatch[] {
  const kept: SimEventBatch[] = [];
  const stop = bridge.onEvents(({ falls, fusions }) => {
    if (falls.length > 0 || fusions.length > 0) kept.push({ falls, contacts: [], fusions });
  });
  scope.add(stop);
  return () => {
    stop();
    return kept.splice(0);
  };
}

/** A hidden page keeps the sim paused; the bridge resumes it when the page shows. */
function releaseHeldSim(bridge: SimBridge): void {
  if (document.visibilityState !== 'hidden') bridge.resume();
}

/**
 * Resolves once a frame has drawn the sim's coins, the sync before it having had a sim frame to
 * draw, or once the sim has failed and there is nothing to wait for.
 */
function coinsDrawn(stage: Stage, bridge: SimBridge): Promise<void> {
  return new Promise((resolve) => {
    const stop = stage.onFrame(() => {
      if (bridge.stats.frames === 0 && !bridge.failure) return;
      stop();
      resolve();
    });
    teardown.push(stop);
  });
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

/**
 * Hands the canvas to the gameplay glue: taps drop, a hold pours, Space drops or pours from the
 * keyboard, A/D/W and two-finger swipes nudge, and the aim reticle rides the drop rail. Each
 * drop spends a server-minted coin before the sim sees it, and each nudge jolts the sim cabinet.
 * The juice listens from the first event on, and hears audio as soon as it is up.
 */
function startPlay(
  systemsModule: typeof SystemsModule,
  stage: Stage,
  sim: StartedSim,
  boot: NetBoot,
  state: StateResponse,
  vfx: Vfx | null,
  payouts: CratePayoutOrder,
  scope: Scope,
): GameSystems {
  // TODO(ui owner): take the number-pop target from a UiApp vault anchor instead of the DOM.
  const vault = uiRoot.querySelector('.cp-plaque');
  if (!vault) {
    throw new Error(
      'CoinPosh boot: the HUD balance plaque (.cp-plaque) is missing, so credited coins have nowhere to fly to; mount the UI before the scene.',
    );
  }
  const systems = systemsModule.createGameSystems({
    bridge: sim.bridge,
    net: { table: boot.net.table, clock: boot.net.clock },
    ui,
    canvas: () => stage.canvas,
    simBacklog: sim.takeEarlyEvents(),
    tableCoins: sim.coins,
  });
  scope.add(() => {
    systems.dispose();
  });
  const comboAudio = holdComboFlourish(() => audio, announcementHoldFor(ui.store));
  scope.add(comboAudio.dispose);
  scope.add(
    systemsModule.wireFeedback(systems.events, {
      vfx: payouts.feedbackVfx(() => vfx),
      audio: comboAudio.port,
      vault,
    }),
  );
  systems.hydrate(state);
  scope.add(payouts.bindTable(systems.events));
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
  scope.add(() => {
    for (const off of offs) off();
  });
  return systems;
}

/**
 * The audio the gameplay feedback plays through, with the cascade's tier flourish kept to the
 * HUD's announcement hold.
 */
function holdComboFlourish(
  audio: () => AudioEngine | null,
  hold: AnnouncementHold,
): { port: () => SystemsModule.FeedbackAudio | null; dispose: () => void } {
  const tiers = holdTierVoice(audio, hold);
  const port: SystemsModule.FeedbackAudio = {
    playImpact(event) {
      audio()?.playImpact(event);
    },
    comboStep(step) {
      audio()?.comboStep(step);
    },
    setComboTier(tier) {
      tiers.setComboTier(tier);
    },
    duckMusic(options) {
      audio()?.duckMusic(options);
    },
  };
  return {
    port: () => (audio() ? port : null),
    dispose: () => {
      tiers.dispose();
    },
  };
}

const CRATE_REVEAL = '[data-testid="crate-reveal"]';
/** The reveal leaves on the effect clock, which a hit-stop or a starved frame rate stretches. */
const CRATE_REVEAL_EXIT_CAP_MS = 4000;

/** Calls `done` once the crate reveal has left `host`, at once when none is up; returns a cancel. */
function afterCrateRevealExit(host: HTMLElement, done: () => void): () => void {
  const reveal = host.querySelector(CRATE_REVEAL);
  if (!reveal) {
    done();
    return () => undefined;
  }
  const stop = (): void => {
    observer.disconnect();
    clearTimeout(cap);
  };
  const observer = new MutationObserver(() => {
    if (reveal.isConnected) return;
    stop();
    done();
  });
  observer.observe(host, { childList: true });
  const cap = setTimeout(() => {
    console.warn(
      `CoinPosh crates: the reveal stayed up ${CRATE_REVEAL_EXIT_CAP_MS} ms after collect; HUD announcements resume over it.`,
    );
    stop();
    done();
  }, CRATE_REVEAL_EXIT_CAP_MS);
  return stop;
}

/** Air between a crate's coin line landing in the Vault and the table's held falls following it. */
const FALLS_AFTER_CRATE_MS = 450;
/** The held falls' pops normally land within a second or two; past this the Vault shows them. */
const HELD_FALL_POPS_CAP_MS = 4000;

type DeferredPop = Parameters<SystemsModule.FeedbackVfx['numberPop']>;

interface FallBatch {
  readonly id: string;
  readonly pops: DeferredPop[];
}

/** Keeps the table's falls out of a crate's payout, so the Vault rises by the card first. */
interface CratePayoutOrder {
  /** The feedback effects, with the number pops of held falls kept back until they are paid. */
  feedbackVfx(vfx: () => Vfx | null): () => SystemsModule.FeedbackVfx | null;
  bindTable(events: GameSystems['events']): () => void;
  opened(crateId: string): void;
  /** The player collected; the card's coin line reaches the Vault in `landsInMs`. */
  collected(crateId: string, landsInMs: number): void;
  /** The crate left without a collect, or every crate cinematic is over. */
  gone(crateId: string | null): void;
  dispose(): void;
}

/**
 * While a crate is open, and until its coin line has landed in the Vault, a table fall's
 * credit is held off the Vault and its number pop is kept back. Collect then rolls the Vault by
 * exactly the card's coin line, and the falls follow FALLS_AFTER_CRATE_MS after the frame that
 * shows it, as their own pops, each landing ticking the Vault. Reduced motion keeps the order: the coin line shows at
 * once and the falls' pops fade in place. A front fall's provisional estimate is held from its
 * claim and the rest of its credit when the server pays it.
 */
function orderCratePayouts(payout: WalletPayout): CratePayoutOrder {
  const unpaid = new Map<string, ReturnType<typeof setTimeout>>();
  const landing = new Map<string, () => void>();
  const estimates = new Map<MintedCoin['id'], number>();
  const releasing = new Set<() => void>();
  let holdUntil = 0;
  let batch: FallBatch | null = null;
  let batches = 0;
  let releaseTimer: ReturnType<typeof setTimeout> | null = null;
  let effects: () => Vfx | null = () => null;

  const active = (): boolean =>
    unpaid.size > 0 || landing.size > 0 || performance.now() < holdUntil;
  const current = (): FallBatch => {
    if (batch) return batch;
    batches += 1;
    batch = { id: `table-falls-${String(batches)}`, pops: [] };
    return batch;
  };

  const pay = (paid: FallBatch): void => {
    const vfx = effects();
    if (!vfx || paid.pops.length === 0) {
      payout.release(paid.id);
      return;
    }
    let landed = 0;
    const finish = (): void => {
      if (!releasing.delete(finish)) return;
      clearTimeout(cap);
      payout.release(paid.id);
    };
    const cap = setTimeout(finish, HELD_FALL_POPS_CAP_MS);
    releasing.add(finish);
    for (const [value, from, target, options] of paid.pops) {
      vfx.numberPop(value, from, target, {
        ...options,
        onArrive: () => {
          options?.onArrive?.();
          landed += 1;
          if (landed === paid.pops.length) finish();
        },
      });
    }
  };

  const settle = (): void => {
    if (releaseTimer !== null) clearTimeout(releaseTimer);
    releaseTimer = null;
    if (unpaid.size > 0 || landing.size > 0) return;
    const wait = holdUntil - performance.now();
    if (wait > 0) {
      releaseTimer = setTimeout(settle, wait);
      return;
    }
    const paid = batch;
    batch = null;
    if (paid) pay(paid);
  };

  const forget = (crateId: string): void => {
    clearTimeout(unpaid.get(crateId));
    unpaid.delete(crateId);
  };

  return {
    feedbackVfx(vfx) {
      effects = vfx;
      let wrapped: SystemsModule.FeedbackVfx | null = null;
      let wraps: Vfx | null = null;
      return () => {
        const real = vfx();
        if (!real) return null;
        if (wraps !== real || !wrapped) {
          wraps = real;
          wrapped = {
            contactSparks: (...args) => {
              real.contactSparks(...args);
            },
            fusion: (...args) => {
              real.fusion(...args);
            },
            cascade: (...args) => {
              real.cascade(...args);
            },
            cameraKick: (...args) => {
              real.cameraKick(...args);
            },
            numberPop: (...args) => {
              if (active()) current().pops.push(args);
              else real.numberPop(...args);
            },
          };
        }
        return wrapped;
      };
    },
    bindTable(events) {
      const offs = [
        events.on('coin:fell', ({ coin, edge }) => {
          if (!coin || edge !== 'front') return;
          estimates.set(coin.id, coin.value);
          if (active()) payout.hold(current().id, { coins: coin.value });
        }),
        events.on('value:credited', ({ amount, coinId }) => {
          const estimate = estimates.get(coinId) ?? 0;
          estimates.delete(coinId);
          if (active() && amount > estimate) {
            payout.hold(current().id, { coins: amount - estimate });
          }
        }),
        events.on('fall:refused', ({ coinId }) => {
          estimates.delete(coinId);
        }),
      ];
      return () => {
        for (const off of offs) off();
      };
    },
    opened(crateId) {
      forget(crateId);
      unpaid.set(
        crateId,
        setTimeout(() => {
          forget(crateId);
          settle();
        }, PAYOUT_HOLD_CAP_MS),
      );
    },
    collected(crateId, landsInMs) {
      forget(crateId);
      landing.get(crateId)?.();
      let frame = 0;
      const timer = setTimeout(() => {
        frame = requestAnimationFrame(() => {
          landing.delete(crateId);
          holdUntil = Math.max(holdUntil, performance.now() + FALLS_AFTER_CRATE_MS);
          settle();
        });
      }, landsInMs);
      landing.set(crateId, () => {
        clearTimeout(timer);
        cancelAnimationFrame(frame);
        landing.delete(crateId);
      });
    },
    gone(crateId) {
      if (crateId === null) for (const id of [...unpaid.keys()]) forget(id);
      else forget(crateId);
      settle();
    },
    dispose() {
      for (const id of [...unpaid.keys()]) forget(id);
      for (const cancel of [...landing.values()]) cancel();
      holdUntil = 0;
      settle();
      for (const finish of [...releasing]) finish();
    },
  };
}

/** When the card's coin line reaches the Vault after a collect: its flight, or at once. */
function coinLineLandsInMs(cratesApi: typeof CratesApi, roll: Roll): number {
  if (isReducedMotion()) return 0;
  const currencies = cratesApi
    .rewardLines(roll.rewards)
    .flatMap((line) => (line.kind === 'currency' ? [line.currency] : []));
  const index = currencies.indexOf('coins');
  return index < 0 ? 0 : PAYOUT_FLIGHT_MS + index * PAYOUT_STAGGER_MS;
}

interface CrateWiring {
  readonly stage: Stage;
  readonly venue: RivieraVenue;
  readonly bridge: SimBridge;
  readonly boot: NetBoot;
  readonly systems: GameSystems;
  readonly vfx: Vfx | null;
  readonly crates: OpeningLayout['crates'];
  readonly payouts: CratePayoutOrder;
}

/**
 * Vault Crates on the table: the server spawns them with drops, they ride the pusher to the lip,
 * and a fall is claimed, opened by the server and played as the unbox. Crates already on the
 * table when the session loads resume their ride where the server stored them, or ride again
 * from the chute when it stored no pose. The reward card flies into the Vault plaque, and the
 * plaque re-reads the server wallet once the player collects. Crates are a bonus on top of play,
 * so a failure to mount them is logged, not fatal.
 *
 * Returns the crates riding the table, for the table snapshot.
 */
function mountTableCrates(
  cratesApi: typeof CratesApi,
  wiring: CrateWiring,
  scope: Scope,
): () => readonly SessionModule.CapturedRide[] {
  const { stage, venue, bridge, boot, systems, vfx, payouts } = wiring;
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
    return () => [];
  }
  const { counts } = probe;
  const offs = [
    holdForCrateCinematics({
      events: crates.events,
      hold: announcementHoldFor(ui.store),
      director: crates.director,
      onFrame: (check) => stage.onFrame(check),
      afterRevealExit: (done) => afterCrateRevealExit(uiRoot, done),
    }),
    ui.onSettingsChange((settings) => {
      haptics.enabled = settings.haptics;
    }),
    crates.events.on('crate:spawned', () => {
      counts.cratesSpawned += 1;
    }),
    crates.events.on('crate:opened', ({ crateId }) => {
      counts.cratesOpened += 1;
      payouts.opened(crateId);
    }),
    crates.events.on('crate:collected', ({ crateId, roll }) => {
      counts.cratesCollected += 1;
      payouts.collected(crateId, coinLineLandsInMs(cratesApi, roll));
      boot.resync('a Vault Crate was collected');
    }),
    crates.events.on('crate:rejected', ({ crateId }) => {
      payouts.gone(crateId);
    }),
    announcementHoldFor(ui.store).onChange((held) => {
      if (!held) payouts.gone(null);
    }),
    crates.events.on('crate:failed', ({ crateId, error }) => {
      payouts.gone(crateId);
      if (error instanceof ApiRequestError && error.code === 'session_superseded') {
        console.warn(
          `CoinPosh crates: crate ${crateId} is claimed once this page takes the table back.`,
          error,
        );
        return;
      }
      console.error(`CoinPosh crates: crate ${crateId} could not be claimed or opened.`, error);
    }),
  ];
  scope.add(() => {
    for (const off of offs) off();
    crates.dispose();
  });
  crates.controller.adopt(
    wiring.crates.map(({ crate }) => crate),
    wiring.crates.map(({ placement }) => placement),
  );
  return () => crates.controller.riding;
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
  /** How the server laid the table the sim restored; null when there was none to lay. */
  readonly layout: OpeningLayout | null;
  /** The server coin each sim body stands for: sim id `i` is `coins[i]`. */
  readonly coins: readonly MintedCoin[];
  readonly takeEarlyEvents: () => readonly SimEventBatch[];
}

/**
 * Started alongside the renderer, so the worker loads Rapier while the GPU initialises. With
 * `held`, the sim stays at its laid tick until `releaseHeldSim`.
 */
function startSim(
  simModule: typeof SimWorkerModule,
  layout: OpeningLayout | null,
  scope: Scope,
  { held = false }: { readonly held?: boolean } = {},
): StartedSim {
  const bridge = simModule.createSimBridge({
    seed: TABLE_SEED,
    ...(layout ? { restore: layout.restore } : {}),
  });
  if (held) bridge.pause();
  probe.bridge = bridge;
  if (layout) probe.restored = restoreCounts(layout, (probe.restored?.boots ?? 0) + 1);
  markBoot('sim-start');
  const stopCounting = bridge.onEvents(({ falls, fusions }) => {
    probe.counts.simFalls += falls.length;
    probe.counts.simFusions += fusions.length;
  });
  scope.add(() => {
    stopCounting();
    if (probe.bridge === bridge) probe.bridge = null;
    bridge.dispose();
  });
  return {
    bridge,
    layout,
    coins: layout?.coins ?? [],
    takeEarlyEvents: holdEarlyEvents(bridge, scope),
  };
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
  /** Draws the coins from `source`, and the pusher where `pusher` has it, from the next frame on. */
  use(source: CoinTransformSource, pusher: Pick<SimBridge, 'stats'>): void;
}

/** The pusher is set from the same sync as the coins, so it never lags the coins it shoves. */
function attachTable(stage: Stage, venue: RivieraVenue, bridge: SimBridge): TableView {
  let source: CoinTransformSource = bridge;
  let pusher: Pick<SimBridge, 'stats'> = bridge;
  const detach = stage.onFrame(() => {
    source.sync(stage.coins);
    venue.setPusherStroke(pusher.stats.pusherStroke);
  });
  teardown.push(detach);
  return {
    use(nextSource, nextPusher) {
      source = nextSource;
      pusher = nextPusher;
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

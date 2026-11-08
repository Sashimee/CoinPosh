import type { MintedCoin, StateResponse } from '@coinposh/shared';
import { mountUi, type UiApp } from './app/index.ts';
import { createAudioEngine, isAudioSupported } from './audio/index.ts';
import type * as SystemsModule from './game/systems/index.ts';
import type { GameSystems } from './game/systems/index.ts';
import type * as SimWorkerModule from './game/simWorker/index.ts';
import type { SimBridge, SimBridgeStats } from './game/simWorker/index.ts';
import { LANGUAGES, type I18n, type ResourceTree } from './i18n/index.ts';
import {
  createNet,
  mountDemoBanner,
  NET_I18N_KEYS,
  NET_I18N_SOURCE,
  type DemoBannerColors,
  type Net,
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

/**
 * Sim ticks drawn past the last heap drop before the game systems take the table. They pair each
 * new sim coin with the next minted one in drop order, so a heap coin appearing after the
 * player's first drop would be taken for it. The margin covers the worker applying a drop a few
 * ticks after the newest frame the render thread has seen.
 */
const HEAP_SETTLE_TICKS = 15;

/** Waits between attempts to load the player's table at boot, doubling up to the ceiling. */
const STATE_RETRY = { firstDelayMs: 1000, maxDelayMs: 30_000 } as const;

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
}

declare global {
  interface Window {
    __coinposh?: CoinPoshProbe;
  }
}

const probe: { bridge: SimBridge | null; playable: boolean } = { bridge: null, playable: false };
window.__coinposh = {
  get sim() {
    return probe.bridge?.stats ?? null;
  },
  get playable() {
    return probe.playable;
  },
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

void bootScene(canvas, netReady, hydrated);

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
async function bootNet(app: UiApp): Promise<Net> {
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

/** The net layer once the player's table snapshot has been adopted. */
interface NetBoot {
  readonly net: Net;
  readonly state: StateResponse;
  readonly vault: VaultTracker;
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
  const resyncWhenShown = (): void => {
    if (document.visibilityState !== 'visible') return;
    net.table.resume().then(
      () => {
        vault.resumed();
      },
      (error: unknown) => {
        console.error('CoinPosh net: the table did not resync after the tab came back.', error);
      },
    );
  };
  document.addEventListener('visibilitychange', resyncWhenShown);
  teardown.push(() => {
    document.removeEventListener('visibilitychange', resyncWhenShown);
  });
  return { net, state, vault };
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
        return await net.client.call('state');
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
 * Play starts once the table is hydrated and, in Demo Mode, the opening heap is on screen. Until
 * then the bridge draws the coins and a tap on the table answers with the tap cue.
 */
async function bootScene(
  target: HTMLCanvasElement,
  netReady: Promise<Net | null>,
  hydrated: Promise<NetBoot | null>,
): Promise<void> {
  let stage: Stage;
  let riviera: typeof RivieraModule;
  let systemsModule: typeof SystemsModule;
  let bridge: SimBridge | undefined;
  const stopEarlyTaps = answerEarlyTaps(target.id);
  try {
    const [stageModule, venueModule, simModule, gameSystems] = await Promise.all([
      import('./stage.ts'),
      import('./scene/venues/riviera/index.ts'),
      import('./game/simWorker/index.ts'),
      import('./game/systems/index.ts'),
    ]);
    riviera = venueModule;
    systemsModule = gameSystems;
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
  const table = attachTable(stage, venue, bridge);
  watchReducedMotion((reduced) => {
    venue.setReducedMotion(reduced);
    stage.coins.setReducedMotion(reduced);
  });
  if ((await netReady)?.mode.kind === 'demo') {
    const lastHeapTick = await pourOpeningHeapWhenEmpty(stage, bridge);
    if (lastHeapTick !== null) await drawnPast(stage, bridge, lastHeapTick + HEAP_SETTLE_TICKS);
  }
  const boot = await hydrated;
  if (!boot || bridge.failure) return;
  stopEarlyTaps();
  table.use(startPlay(systemsModule, stage, bridge, boot));
  probe.playable = true;
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
 * TODO(P-108): subscribe the audio and vfx juice to `systems.events`.
 */
function startPlay(
  systemsModule: typeof SystemsModule,
  stage: Stage,
  bridge: SimBridge,
  boot: NetBoot,
): GameSystems {
  const systems = systemsModule.createGameSystems({
    bridge,
    net: { table: boot.net.table, clock: boot.net.clock },
    ui,
    canvas: stage.canvas,
    upgradeLevels: boot.state.venue.upgrades,
  });
  teardown.push(() => {
    systems.dispose();
  });
  focusForKeys(stage.canvas);
  systems.hydrate(boot.state);
  const offs = [
    systems.events.on('drop:requested', ({ coin, poured }) => {
      boot.vault.spent(coin);
      ui.bus.emit('ui:feedback', { kind: poured ? 'tick' : 'tap' });
    }),
    systems.events.on('nudge', ({ direction }) => {
      if (!bridge.failure) bridge.nudge(direction);
    }),
  ];
  teardown.push(() => {
    for (const off of offs) off();
  });
  return systems;
}

/**
 * The input surface listens for keys on the canvas, and its pointerdown calls preventDefault,
 * which in Chromium stops a click from focusing it; so Space and W would go nowhere.
 * TODO(input owner): focus the canvas in game/input/surface.ts's pointerdown, then drop this.
 */
function focusForKeys(canvas: HTMLCanvasElement): void {
  const focus = (): void => {
    canvas.focus({ preventScroll: true });
  };
  const onPointerDown = (event: PointerEvent): void => {
    if (event.isPrimary) focus();
  };
  canvas.addEventListener('pointerdown', onPointerDown);
  teardown.push(() => {
    canvas.removeEventListener('pointerdown', onPointerDown);
  });
  focus();
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
  probe.bridge = bridge;
  teardown.push(() => {
    probe.bridge = null;
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

/**
 * Pours the heap onto an empty table. Resolves with the newest sim tick seen when the last coin
 * was released, or null when no heap was poured.
 */
async function pourOpeningHeapWhenEmpty(stage: Stage, bridge: SimBridge): Promise<number | null> {
  try {
    await bridge.ready;
  } catch {
    // The bridge already logged why the sim stopped; there is no table to pour onto.
    return null;
  }
  if (bridge.stats.coins > 0) return null;
  return new Promise((resolve) => {
    let poured = 0;
    let due = 0;
    const finish = (): void => {
      stop();
      resolve(poured > 0 ? bridge.stats.tick : null);
    };
    const stop = stage.onFrame((deltaSeconds) => {
      if (bridge.failure) {
        finish();
        return;
      }
      due = Math.min(due + deltaSeconds * OPENING_HEAP.perSecond, OPENING_HEAP.maxBurst);
      try {
        for (; due >= 1 && poured < OPENING_HEAP.coins; due -= 1, poured += 1) {
          bridge.drop(openingDropOffsetMm(poured), openingDropTier(poured));
        }
      } catch (error) {
        console.error('CoinPosh opening heap stopped: the sim rejected a drop.', error);
        finish();
        return;
      }
      if (poured >= OPENING_HEAP.coins) finish();
    });
    teardown.push(stop);
  });
}

/** Resolves on the first frame drawn at or past sim tick `tick`, or once the sim has stopped. */
function drawnPast(stage: Stage, bridge: SimBridge, tick: number): Promise<void> {
  return new Promise((resolve) => {
    const stop = stage.onFrame(() => {
      if (bridge.stats.renderTick < tick && !bridge.failure) return;
      stop();
      resolve();
    });
    teardown.push(stop);
  });
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

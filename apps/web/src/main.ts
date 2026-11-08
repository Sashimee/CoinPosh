import type { StateResponse } from '@coinposh/shared';
import { COIN_DROP_HEIGHT, GRAVITY } from '@coinposh/sim';
import type * as Three from 'three/webgpu';
import { mountUi, type UiApp } from './app/index.ts';
import { createAudioEngine, isAudioSupported, type AudioEngine } from './audio/index.ts';
import type * as SystemsModule from './game/systems/index.ts';
import type { GameSystems, TablePoint } from './game/systems/index.ts';
import type * as SimWorkerModule from './game/simWorker/index.ts';
import type { SimBridge } from './game/simWorker/index.ts';
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
import { isReducedMotion, onReducedMotionChange } from './ui/motion/reduced.ts';
import { hexToRgbChannels } from './ui/theme.ts';
import type * as VfxModule from './vfx/index.ts';
import type { Vfx } from './vfx/index.ts';

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
 * The edges of the table the sim worker simulates, so falls are told apart (front pays, sides
 * do not) against the coins' real positions. The drawn venue's RIVIERA_TABLE is still wider and
 * deeper than the sim, so the systems' default bounds would call every front fall a stray.
 * TODO(sim owner): export PLAYFIELD from @coinposh/sim and read both edges from it.
 */
const SIM_FIELD_BOUNDS = { fieldHalfWidth: 0.18, fieldFrontZ: 0.05 } as const;

/**
 * The closing speed the impact synth plays at full force (audio's IMPACT_VELOCITY_CEIL, which
 * audio/index.ts does not export); a contact's 0..1 strength is scaled onto it.
 * TODO(audio owner): export IMPACT_VELOCITY_CEIL from audio/index.ts and read it here.
 */
const HARDEST_IMPACT_METRES_PER_S = 2.8;

/**
 * The heap poured onto the empty Demo Mode table at boot, so the table is not bare when it first
 * lights up. Every coin goes through `SimBridge.drop`, exactly like a player's. Drops are released
 * on a wall-clock timer from the moment the sim is ready, not on render frames, so most of the
 * pour happens while the renderer is still starting; the tick each coin lands on, and the heap's
 * final shape, differ a little between devices. Nothing is paid from it: the server never minted
 * these coins. Live mode pours no heap.
 *
 * 150 coins leaves 100 of the 250-coin table budget the sim and renderer are benchmarked at for
 * the player's own drops, and at 90 a second the pour is over within about 1.7 s of the sim
 * starting, so play starts close to the first lit frame.
 */
const OPENING_HEAP = {
  coins: 150,
  perSecond: 90,
  intervalMs: 16,
  /** Most drops released in one timer tick after a hitch, so coins never spawn inside each other. */
  maxBurst: 3,
  /**
   * Lateral reach from the centre line. A narrow pour piles coins deep enough in front of the
   * pusher to reach the lip within a few strokes; a wide one spreads them too thin to.
   * `SimBridge.drop` rejects anything outside the sim's ±150 mm drop range.
   */
  spreadMm: 60,
  /**
   * Sim ticks drawn past the last heap drop before play starts, so every heap coin is already on
   * screen when the game systems first look; a heap coin appearing later would be paired with
   * the player's first minted coin.
   */
  settleTicks: 12,
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

const audioReady = bootAudio(ui).catch((error: unknown) => {
  console.error('CoinPosh audio failed to start; the game continues without sound.', error);
  return null;
});

const netReady = bootNet(ui).catch((error: unknown) => {
  console.error('CoinPosh net failed to start; balances will not sync this session.', error);
  return null;
});

void bootScene(canvas, netReady, audioReady);

// The music loop is rendered offline now, before any gesture, so the first tap only has to
// unlock the context and the track starts without a render hitch.
// The saved mixer is attached before the music starts, so the first note plays at the volume
// the player chose rather than the engine defaults.
async function bootAudio(app: UiApp): Promise<AudioEngine | null> {
  if (!isAudioSupported()) {
    console.warn('[CoinPosh] Web Audio is unavailable in this browser; playing without sound.');
    return null;
  }
  const audio = createAudioEngine();
  app.attachAudio(audio);
  await audio.startMusic();
  return audio;
}

/** The net layer, hydrated from the server's (or Demo Mode's) snapshot of this player. */
interface NetBoot {
  readonly net: Net;
  readonly state: StateResponse;
}

/**
 * Without `VITE_API_URL` (the GitHub Pages build) the net layer runs Demo Mode against its
 * in-browser server, and the banner tells the player their progress is unranked and local.
 * The Vault follows the table's balance from the first snapshot on (see `showVault`).
 */
async function bootNet(app: UiApp): Promise<NetBoot> {
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
  if (net.mode.kind === 'demo') {
    let removeBanner = showDemoBanner(app);
    const stopRelabel = app.i18n.onLanguageChanged(() => {
      removeBanner = showDemoBanner(app);
    });
    teardown.push(() => {
      stopRelabel();
      removeBanner();
    });
  }
  teardown.push(
    net.table.subscribe((event) => {
      if (event.type === 'balance') showVault(app, net.table);
    }),
  );
  const state = await loadState(net, app);
  net.table.hydrate(state);
  app.setUpgradeLevels(state.venue.upgrades);
  const resyncWhenShown = (): void => {
    if (document.visibilityState !== 'visible') return;
    net.table.resume().catch((error: unknown) => {
      console.error('CoinPosh net: the table did not resync after the tab came back.', error);
    });
  };
  document.addEventListener('visibilitychange', resyncWhenShown);
  teardown.push(() => {
    document.removeEventListener('visibilitychange', resyncWhenShown);
  });
  return { net, state };
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
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  } finally {
    hideOffline?.();
  }
}

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

/**
 * The coins the player holds, as the server reported them: its wallet plus the winnings still
 * waiting for its answer, shimmering while any are.
 */
function showVault(app: UiApp, table: Net['table']): void {
  const balance = table.balance;
  if (!balance) return;
  app.setWallet({
    ...balance.wallet,
    coins: balance.wallet.coins + balance.provisionalCoins,
    provisional: balance.provisionalCoins > 0,
  });
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
 * Play starts once the net has hydrated and, in Demo Mode, the opening heap is on screen: the
 * gameplay glue pairs new sim coins with minted ones in order, so it must not see a heap coin
 * arrive after the player's first drop.
 */
async function bootScene(
  target: HTMLCanvasElement,
  netReady: Promise<NetBoot | null>,
  audioReady: Promise<AudioEngine | null>,
): Promise<void> {
  let stage: Stage;
  let riviera: typeof RivieraModule;
  let systemsModule: typeof SystemsModule;
  let vfxModule: typeof VfxModule;
  let three: typeof Three;
  let bridge: SimBridge | undefined;
  let heapPoured: Promise<number | null>;
  const stopEarlyTaps = answerEarlyTaps(target.id);
  try {
    const [stageModule, venueModule, simModule, gameSystems, effects, threeModule] =
      await Promise.all([
        import('./stage.ts'),
        import('./scene/venues/riviera/index.ts'),
        import('./game/simWorker/index.ts'),
        import('./game/systems/index.ts'),
        import('./vfx/index.ts'),
        import('three/webgpu'),
      ]);
    riviera = venueModule;
    systemsModule = gameSystems;
    vfxModule = effects;
    three = threeModule;
    bridge = startSim(simModule);
    heapPoured = pourOpeningHeapInDemo(bridge, netReady);
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
  const detachBridgeCoins = attachCoins(stage, bridge);
  watchReducedMotion((reduced) => {
    venue.setReducedMotion(reduced);
    stage.coins.setReducedMotion(reduced);
  });
  // The renderer checks its clock against the first frame's timestamp, so the effects' first,
  // slowest update must not run inside that frame.
  await frameDrawn(stage);
  const vfx = attachVfx(stage, vfxModule);

  const [boot, lastHeapTick] = await Promise.all([netReady, heapPoured]);
  if (!boot) return;
  if (lastHeapTick !== null) {
    await drawnPast(stage, bridge, lastHeapTick + OPENING_HEAP.settleTicks);
  }
  if (bridge.failure) return;
  detachBridgeCoins();
  stopEarlyTaps();
  const systems = systemsModule.createGameSystems({
    bridge,
    net: { table: boot.net.table, clock: boot.net.clock },
    ui,
    canvas: stage.canvas,
    bounds: SIM_FIELD_BOUNDS,
    upgradeLevels: boot.state.venue.upgrades,
  });
  teardown.push(() => {
    systems.dispose();
  });
  systems.hydrate(boot.state);
  attachCoins(stage, systems);
  wireFeedback(systems, { stage, vfx, audio: await audioReady, three });
}

/**
 * Until the game systems take over the canvas (renderer up, net hydrated, opening heap settled),
 * a tap on the table still answers with the UI's tap sound and haptic instead of nothing. It
 * listens on the document because the stage swaps in a fresh canvas, same id, when it falls
 * back to WebGL2.
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
 * Where the coins on screen come from: the sim worker bridge, or the game systems wrapped
 * around it, writes interpolated sim transforms every frame. A source only places coins: what a
 * coin is worth only ever comes from the server.
 */
interface CoinTransformSource {
  /** Runs once per frame, before the stage uploads the field. */
  sync(field: CoinField): void;
}

function attachCoins(stage: Stage, source: CoinTransformSource): () => void {
  const detach = stage.onFrame(() => {
    source.sync(stage.coins);
  });
  const stop = (): void => {
    detach();
  };
  teardown.push(stop);
  return stop;
}

/** Follows the stage's renderer through device-loss rebuilds and its quality tier changes. */
function attachVfx(stage: Stage, vfxModule: typeof VfxModule): Vfx {
  const vfx = vfxModule.createVfx({
    scene: stage.scene,
    camera: stage.camera,
    renderer: stage.renderer,
    backend: stage.backend,
    overlay: uiRoot,
    i18n: ui.i18n.instance,
    quality: stage.profile.tier,
    reducedMotion: isReducedMotion(),
  });
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

interface FeedbackTargets {
  readonly stage: Stage;
  readonly vfx: Vfx;
  readonly audio: AudioEngine | null;
  readonly three: typeof Three;
}

/**
 * What the player sees and hears for each thing the gameplay glue reports. Only `credited`
 * values are shown as money: they are what the server paid.
 * TODO(P-103): dismiss the coach mark on the first `drop:requested` once the coach mark exists.
 */
function wireFeedback(systems: GameSystems, { stage, vfx, audio, three }: FeedbackTargets): void {
  // TODO(ui owner): take the number-pop target from a UiApp vault anchor instead of the DOM.
  const vaultAnchor = uiRoot.querySelector('.cp-plaque');
  if (!vaultAnchor) {
    throw new Error(
      'CoinPosh boot: the HUD balance plaque (.cp-plaque) is missing, so credited coins have nowhere to fly to; mount the UI before the scene.',
    );
  }
  const at = (point: TablePoint): Three.Vector3 => new three.Vector3(point.x, point.y, point.z);
  const pan = (x: number): number => x / SIM_FIELD_BOUNDS.fieldHalfWidth;
  const lip: TablePoint = { x: 0, y: 0, z: SIM_FIELD_BOUNDS.fieldFrontZ };
  let lastFrontFall = lip;
  const offs = [
    systems.events.on('drop:requested', ({ xMm }) => {
      audio?.playImpact({ material: 'wood', velocity: 0.4, pan: pan(xMm / 1000) });
    }),
    systems.events.on('coin:spawned', ({ coin, position }) => {
      if (!coin) return;
      followDrop(stage, vfx.dropTrail(at(position), { tier: coin.tier }), position, at);
    }),
    systems.events.on('coin:contact', ({ position, strength, surface }) => {
      audio?.playImpact({
        material: surface,
        velocity: strength * HARDEST_IMPACT_METRES_PER_S,
        pan: pan(position.x),
      });
      vfx.contactSparks(at(position), { strength, surface });
    }),
    systems.events.on('coin:fusion', ({ sources, center, tier }) => {
      vfx.fusion({
        sources: sources.map(at),
        center: at(center),
        tier,
        onImpact: () => {
          audio?.playImpact({
            material: 'metal',
            velocity: HARDEST_IMPACT_METRES_PER_S,
            pan: pan(center.x),
          });
        },
      });
    }),
    systems.events.on('coin:fell', ({ edge, position }) => {
      if (edge === 'front') lastFrontFall = position;
    }),
    systems.events.on('cascade:step', ({ count }) => {
      audio?.comboStep(count);
    }),
    systems.events.on('cascade:tier', ({ tier, rank }) => {
      audio?.setComboTier(rank);
      vfx.cascade(tier, { origin: at(lastFrontFall) });
    }),
    systems.events.on('cascade:end', () => {
      audio?.setComboTier(0);
    }),
    systems.events.on('value:credited', ({ amount, tier, position }) => {
      vfx.numberPop(amount, at(position ?? lip), vaultAnchor, tier ? { tier } : {});
    }),
    systems.events.on('nudge', ({ strength }) => {
      audio?.playImpact({
        material: 'wood',
        velocity: (0.4 + 0.6 * strength) * HARDEST_IMPACT_METRES_PER_S,
        pan: 0,
      });
      vfx.cameraKick({ shake: 0.2 + 0.3 * strength });
    }),
    systems.events.on('concierge:freeze', () => {
      audio?.duckMusic();
    }),
  ];
  teardown.push(() => {
    for (const off of offs) off();
  });
}

/**
 * Draws the trail down the coin's free fall onto the pusher. The sim reports where a coin
 * spawned but not where it is on later frames, so the trail follows the ballistic path, which
 * the coin keeps until it lands.
 */
function followDrop(
  stage: Stage,
  trail: ReturnType<Vfx['dropTrail']>,
  start: TablePoint,
  at: (point: TablePoint) => Three.Vector3,
): void {
  let elapsed = 0;
  const stop = stage.onFrame((deltaSeconds) => {
    elapsed += deltaSeconds;
    const fallen = Math.min(-0.5 * GRAVITY.y * elapsed * elapsed, COIN_DROP_HEIGHT);
    trail.moveTo(at({ x: start.x, y: start.y - fallen, z: start.z }));
    if (fallen < COIN_DROP_HEIGHT) return;
    stop();
    trail.end();
  });
}

/**
 * Pours the heap once the sim is up and the net says this is Demo Mode. Resolves with the newest
 * sim tick seen when the last coin was released, or null when no heap was poured.
 */
async function pourOpeningHeapInDemo(
  bridge: SimBridge,
  netReady: Promise<NetBoot | null>,
): Promise<number | null> {
  try {
    await bridge.ready;
  } catch {
    // The bridge already logged why the sim stopped; there is no table to pour onto.
    return null;
  }
  if ((await netReady)?.net.mode.kind !== 'demo') return null;
  return new Promise((resolve) => {
    let poured = 0;
    let due = 0;
    let last = performance.now();
    const finish = (): void => {
      clearInterval(timer);
      resolve(poured > 0 ? bridge.stats.tick : null);
    };
    const timer = setInterval(() => {
      if (bridge.failure) {
        finish();
        return;
      }
      const now = performance.now();
      due = Math.min(due + ((now - last) / 1000) * OPENING_HEAP.perSecond, OPENING_HEAP.maxBurst);
      last = now;
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
    }, OPENING_HEAP.intervalMs);
    teardown.push(() => {
      clearInterval(timer);
    });
  });
}

/** Resolves once the next frame has been drawn: promise callbacks run after the frame callback. */
function frameDrawn(stage: Stage): Promise<void> {
  return new Promise((resolve) => {
    const stop = stage.onFrame(() => {
      stop();
      resolve();
    });
    teardown.push(() => {
      stop();
    });
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
    teardown.push(() => {
      stop();
    });
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

/** Honours the in-app motion setting as well as the OS preference. */
function watchReducedMotion(apply: (reduced: boolean) => void): void {
  apply(isReducedMotion());
  const stop = onReducedMotionChange(apply);
  teardown.push(() => {
    stop();
  });
}

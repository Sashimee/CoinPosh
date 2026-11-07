import {
  Color,
  PerspectiveCamera,
  Scene,
  Timer,
  WebGPURenderer,
  type ColorRepresentation,
  type LightShadow,
} from 'three/webgpu';
import { detectBackend, fallbackBackend, reportBackend, type RenderBackend } from './backend.ts';
import {
  CoinField,
  watchGpuLoss,
  type CoinFieldOptions,
  type GpuLossWatch,
} from './scene/coins/index.ts';
import {
  createAdaptiveRendering,
  DEFAULT_RENDER_LOOK,
  qualityOverrideFrom,
  type AdaptiveRendering,
  type QualityProfile,
  type QualityTier,
  type RenderLook,
} from './scene/quality/index.ts';

const CAMERA_NEAR = 0.05;
// The venue sky dome has a 90 m radius around the table, so the far plane must clear it.
const CAMERA_FAR = 120;
// Right after a device loss the GPU process is still restarting and getContext('webgl2')
// returns null for a moment, so the rebuild backs off instead of giving up on the first try.
const REBUILD_RETRY_DELAYS_MS = [0, 250, 500, 1000, 2000] as const;

export type FrameListener = (deltaSeconds: number, elapsedSeconds: number) => void;
export type SizeListener = (width: number, height: number) => void;
export type TierListener = (profile: QualityProfile) => void;

export interface StageOptions {
  /** The venue's grade; the post pipeline is its only writer. Defaults to the Riviera grade. */
  readonly look?: RenderLook;
  readonly vignetteTint?: ColorRepresentation;
  /** Forces a quality tier; defaults to `?quality=low|medium|high` in the page URL. */
  readonly quality?: QualityTier;
  /** The coin field the stage bakes, shadows and uploads; casting is driven by the tier. */
  readonly coins: Omit<CoinFieldOptions, 'castShadow'>;
}

export interface Stage {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: WebGPURenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly backend: RenderBackend;
  readonly coins: CoinField;
  /** The live quality tier; it can drop at runtime and changes on a renderer rebuild. */
  readonly profile: QualityProfile;
  readonly look: RenderLook;
  /** Changes exposure and IBL strength; `shadows` is fixed for the life of the stage. */
  setLook(look: RenderLook): void;
  /** Lets `light` cast coin shadows on tiers that allow them (`profile.coinShadows`). */
  castCoinShadowsFrom(light: { readonly shadow: LightShadow }): void;
  /** Called after each frame listener, right before the coin upload and the render. */
  onFrame(listener: FrameListener): () => void;
  observeSize(listener: SizeListener): () => void;
  onTierChange(listener: TierListener): () => void;
  dispose(): Promise<void>;
}

interface StageContext {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly vignetteTint: ColorRepresentation | undefined;
  readonly override: QualityTier | undefined;
  look(): RenderLook;
  advance(time: number): void;
  resized(width: number, height: number): void;
  applyProfile(renderer: WebGPURenderer, profile: QualityProfile): void;
  onDeviceLost(lost: ActiveRenderer, next: RenderBackend): void;
}

interface ActiveRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: WebGPURenderer;
  readonly backend: RenderBackend;
  readonly adaptive: AdaptiveRendering;
  readonly observer: ResizeObserver;
  readonly lossWatch: GpuLossWatch;
  stopped: boolean;
}

/**
 * Boots the renderer with its post pipeline and quality governor, and owns the coin field's
 * GPU side: the emboss bake and shadow casting follow the live tier, and both are redone on
 * the replacement renderer after a device loss. Feed coins through `stage.coins.setTransforms`
 * from a frame listener; the stage uploads them once per frame before rendering.
 */
export async function createStage(
  canvas: HTMLCanvasElement,
  options: StageOptions,
): Promise<Stage> {
  const scene = new Scene();
  scene.background = new Color(0x000000);
  const camera = new PerspectiveCamera(40, 1, CAMERA_NEAR, CAMERA_FAR);
  const timer = new Timer();
  timer.connect(document);
  const coins = new CoinField({ ...options.coins, castShadow: true });
  scene.add(coins.object);
  const frameListeners = new Set<FrameListener>();
  const sizeListeners = new Set<SizeListener>();
  const tierListeners = new Set<TierListener>();
  let size = { width: 1, height: 1 };
  let look = options.look ?? DEFAULT_RENDER_LOOK;
  let coinShadowLight = false;
  let baked: { renderer: WebGPURenderer; resolution: number } | null = null;
  let disposed = false;
  let active: ActiveRenderer;

  const context: StageContext = {
    scene,
    camera,
    vignetteTint: options.vignetteTint,
    override: options.quality ?? qualityOverrideFrom(location.search),
    look: () => look,
    advance(time) {
      timer.update(time);
      const delta = timer.getDelta();
      const elapsed = timer.getElapsed();
      for (const listener of frameListeners) listener(delta, elapsed);
      coins.update(camera, size.height);
    },
    resized(width, height) {
      size = { width, height };
      for (const listener of sizeListeners) listener(width, height);
    },
    applyProfile(renderer, profile) {
      const resolution = profile.coinEmbossResolution;
      if (baked?.renderer !== renderer || baked.resolution !== resolution) {
        coins.bake(renderer, resolution);
        baked = { renderer, resolution };
      }
      if (coinShadowLight) coins.setCastShadows(profile.coinShadows);
      for (const listener of tierListeners) listener(profile);
    },
    onDeviceLost(lost, next) {
      if (disposed) return;
      void rebuild(lost, next).catch((error: unknown) => {
        console.error('CoinPosh: the renderer lost its GPU device and could not restart.', error);
      });
    },
  };

  const rebuild = async (lost: ActiveRenderer, next: RenderBackend): Promise<void> => {
    await stopRenderer(lost);
    let target = lost.canvas;
    for (const delay of REBUILD_RETRY_DELAYS_MS) {
      await wait(delay);
      if (disposed) return;
      target = replaceCanvas(target);
      try {
        active = await startRenderer(target, next, context);
        return;
      } catch (error) {
        console.warn(`[CoinPosh] ${next} restart failed, retrying`, error);
      }
    }
    throw new Error(
      `${next} could not start after ${REBUILD_RETRY_DELAYS_MS.length} attempts; reload the page`,
    );
  };

  const start = async (
    target: HTMLCanvasElement,
    attempt: RenderBackend,
  ): Promise<ActiveRenderer> => {
    try {
      return await startRenderer(target, attempt, context);
    } catch (error) {
      const next = fallbackBackend(attempt);
      if (next === null) throw error;
      console.warn('[CoinPosh] WebGPU renderer failed to start, retrying on WebGL2', error);
      return startRenderer(replaceCanvas(target), next, context);
    }
  };

  try {
    active = await start(canvas, 'webgpu');
  } catch (error) {
    coins.dispose();
    timer.dispose();
    throw error;
  }

  return {
    get canvas() {
      return active.canvas;
    },
    get renderer() {
      return active.renderer;
    },
    get backend() {
      return active.backend;
    },
    get profile() {
      return active.adaptive.profile;
    },
    get look() {
      return look;
    },
    scene,
    camera,
    coins,
    setLook(next) {
      active.adaptive.post.setLook(next);
      look = next;
    },
    castCoinShadowsFrom(light) {
      coins.castShadowsFrom(light);
      coinShadowLight = true;
      coins.setCastShadows(active.adaptive.profile.coinShadows);
    },
    onFrame(listener) {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },
    observeSize(listener) {
      sizeListeners.add(listener);
      listener(size.width, size.height);
      return () => sizeListeners.delete(listener);
    },
    onTierChange(listener) {
      tierListeners.add(listener);
      return () => tierListeners.delete(listener);
    },
    async dispose() {
      disposed = true;
      frameListeners.clear();
      sizeListeners.clear();
      tierListeners.clear();
      timer.dispose();
      await stopRenderer(active);
      scene.remove(coins.object);
      coins.dispose();
    },
  };
}

async function startRenderer(
  canvas: HTMLCanvasElement,
  attempt: RenderBackend,
  context: StageContext,
): Promise<ActiveRenderer> {
  const { scene, camera } = context;
  // The post pipeline anti-aliases its scene pass (MSAA or FXAA by tier) and owns the pixel
  // ratio, so the canvas itself stays single-sampled at the renderer's default ratio here.
  const renderer = new WebGPURenderer({
    canvas,
    antialias: false,
    powerPreference: 'high-performance',
    forceWebGL: attempt === 'webgl2',
  });
  renderer.setClearColor(0x000000, 1);
  try {
    await renderer.init();
  } catch (error) {
    await renderer.dispose();
    throw error;
  }

  const backend = detectBackend(renderer.backend);
  reportBackend(backend);

  // A lost WebGPU device falls back to WebGL2; a lost WebGL2 context comes back as WebGL2.
  // The watch starts before the benchmark, which is long enough for a device to be reclaimed.
  const next = fallbackBackend(backend) ?? backend;
  let active: ActiveRenderer | null = null;
  const lossWatch = watchGpuLoss(
    renderer,
    (loss) => {
      console.warn(
        `[CoinPosh] ${backend} ${loss.source} (${loss.message.replace(/[.\s]+$/, '')}), rebuilding the renderer on ${next}`,
      );
      if (active !== null && !active.stopped) context.onDeviceLost(active, next);
    },
    { rejections: window },
  );

  const resize = (): void => {
    const width = Math.max(canvas.clientWidth, 1);
    const height = Math.max(canvas.clientHeight, 1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    context.resized(width, height);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  let adaptive: AdaptiveRendering;
  try {
    adaptive = await createAdaptiveRendering({
      renderer,
      scene,
      camera,
      backend,
      look: context.look(),
      onTierChange: (profile) => {
        context.applyProfile(renderer, profile);
      },
      ...(context.vignetteTint === undefined ? {} : { vignetteTint: context.vignetteTint }),
      ...(context.override === undefined ? {} : { override: context.override }),
    });
    context.applyProfile(renderer, adaptive.profile);
  } catch (error) {
    lossWatch.stop();
    observer.disconnect();
    await renderer.dispose();
    throw error;
  }

  active = { canvas, renderer, backend, adaptive, observer, lossWatch, stopped: false };
  if (lossWatch.loss !== null) {
    context.onDeviceLost(active, next);
    return active;
  }

  await renderer.setAnimationLoop((time) => {
    context.advance(time);
    adaptive.render(time);
  });
  return active;
}

async function stopRenderer(active: ActiveRenderer): Promise<void> {
  active.stopped = true;
  active.lossWatch.stop();
  active.observer.disconnect();
  await active.renderer.setAnimationLoop(null);
  active.adaptive.dispose();
  await active.renderer.dispose();
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A canvas that has handed out a WebGPU context returns null for getContext('webgl2'),
// so the WebGL2 renderer needs a fresh element in the same DOM slot.
function replaceCanvas(old: HTMLCanvasElement): HTMLCanvasElement {
  const fresh = document.createElement('canvas');
  for (const { name, value } of Array.from(old.attributes)) {
    fresh.setAttribute(name, value);
  }
  old.replaceWith(fresh);
  return fresh;
}

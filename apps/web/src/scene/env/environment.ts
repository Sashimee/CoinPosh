import {
  DataTexture,
  EquirectangularReflectionMapping,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  LinearSRGBColorSpace,
  Node,
  RepeatWrapping,
  RGBAFormat,
  type NodeBuilder,
  type Renderer,
  type Scene,
} from 'three/webgpu';
import {
  clamp,
  equirectUV,
  float,
  Fn,
  If,
  materialEnvRotation,
  mix,
  renderGroup,
  texture,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import veniceSunsetUrl from './hdri/venice_sunset_512.hdr?url';
import veniceSunsetFallback from './hdri/venice_sunset_32.ts';
import {
  PREFILTERED_ENVIRONMENT,
  type PrefilteredEnvironment,
  type PrefilterReply,
  type PrefilterRequest,
} from './prefilter.ts';
import { decodeRgbe, toHalfFloats, type RadianceImage } from './radiance.ts';

export type { PrefilteredEnvironment } from './prefilter.ts';

export interface HdriAsset {
  readonly url: string;
  /**
   * A tiny downsample of the same HDRI as an inlined data URL, decoded synchronously so the
   * venue is lit from its first frame while `url` loads and pre-filters.
   */
  readonly fallback: string;
  /** Yaw (radians, about +Y) of the brightest sky region in three's equirect convention. */
  readonly sunYaw: number;
}

/**
 * Poly Haven "Venice Sunset", CC0, pre-graded and downsampled offline by `hdri/bake-hdri.mjs`,
 * with its 32 px boot fallback from `hdri/bake-fallback.mjs`. Source, grade and checksums are
 * recorded in hdri/SOURCES.md.
 */
export const SUNSET_HDRI: HdriAsset = {
  url: veniceSunsetUrl,
  fallback: veniceSunsetFallback,
  sunYaw: (307.25 / 512 - 0.5) * 2 * Math.PI,
};

/** Fetches an HDRI and pre-filters it (see `PREFILTERED_ENVIRONMENT`) without touching the scene. */
export type EnvironmentLoader = (hdri: HdriAsset) => Promise<PrefilteredEnvironment>;

/** Runs the fetch, decode and GGX pre-filter in a Web Worker, so no frame ever waits on it. */
export const prefilterHdriInWorker: EnvironmentLoader = (hdri) =>
  new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./prefilter.worker.ts', import.meta.url), {
      type: 'module',
      name: 'coinposh-environment',
    });
    worker.addEventListener('message', (event: MessageEvent<PrefilterReply>) => {
      worker.terminate();
      const reply = event.data;
      if (reply.ok) resolve(reply);
      else reject(new Error(`The environment worker failed: ${reply.message}`));
    });
    worker.addEventListener('error', (event) => {
      worker.terminate();
      reject(
        new Error(
          `The environment worker did not start (${event.message || event.type}); check that its chunk was bundled`,
        ),
      );
    });
    const request: PrefilterRequest = { url: new URL(hdri.url, document.baseURI).href };
    worker.postMessage(request);
  });

/**
 * When the HDRI takes over. Its fetch and pre-filter wait until the first frames of play are
 * on screen, so they never compete with boot, then it crossfades in so the light blooms
 * instead of popping.
 */
export const ENVIRONMENT_HANDOFF = {
  settleFrames: 6,
  settleSeconds: 0.75,
  fadeSeconds: 0.8,
  /** Frame deltas past this are a stall, not fade time. */
  maxFadeStep: 1 / 30,
} as const;

/** Box-filtered mips past this blur up and down together, which irradiance must not do. */
const FALLBACK_MAX_LEVEL = 3;
const FALLBACK_LEVELS_PER_ROUGHNESS = 3.3;
const HDRI_MAX_LEVEL = PREFILTERED_ENVIRONMENT.levels - 1;

export type EnvironmentSource = 'fallback' | 'hdri';

/** The slice of the renderer the handoff needs: uploading the pre-filtered texels. */
export type EnvironmentUploader = Pick<Renderer, 'initTexture'>;

export interface VenueEnvironmentOptions {
  readonly hdri: HdriAsset;
  /** Yaw of the venue's sun; the HDRI is rotated so its glow sits behind the venue's sun. */
  readonly sunYaw: number;
  /** Defaults to {@link prefilterHdriInWorker}. */
  readonly load?: EnvironmentLoader;
}

export interface VenueEnvironment {
  /** The scene's `environmentNode`: the fallback crossfading into the pre-filtered HDRI. */
  readonly node: Node<'vec3'>;
  readonly fallback: DataTexture;
  /**
   * The pre-filtered HDRI. Allocated empty up front so every material binds it from its first
   * compile; its texels are uploaded in place when the worker delivers them.
   */
  readonly hdri: DataTexture;
  /** 0 while the fallback lights the scene, 1 once the HDRI has fully taken over. */
  readonly blend: number;
  /**
   * Resolves `hdri` once the HDRI has fully faded in, or `fallback` when it failed to load or
   * upload (logged as an error) or the environment was disposed first. Never rejects.
   */
  readonly ready: Promise<EnvironmentSource>;
  /**
   * Runs once per rendered frame from the node graph with that frame's renderer; exposed for
   * tests and harnesses.
   */
  advance(deltaSeconds: number, renderer?: EnvironmentUploader | null): void;
  dispose(): void;
}

interface EnvironmentSampleContext {
  getUV(node: Node, builder: NodeBuilder): Node<'vec3'>;
  getTextureLevel?(node: Node): Node<'float'>;
}

function isSampleContext(context: unknown): context is EnvironmentSampleContext {
  return (
    typeof context === 'object' &&
    context !== null &&
    typeof (context as { getUV?: unknown }).getUV === 'function'
  );
}

/**
 * Samples both equirects through the rotation and roughness the environment lighting asks
 * for, each behind a branch on the uniform `blend`: before the handoff only the fallback is
 * read, after it only the HDRI, and both only during the fade. Both are bound from the first
 * compile, so the handoff never rebuilds a material.
 */
class HandoffEnvironmentNode extends Node<'vec3'> {
  constructor(
    private readonly fallback: DataTexture,
    private readonly hdri: DataTexture,
    private readonly blend: Node<'float'>,
  ) {
    super('vec3');
  }

  override setup(builder: NodeBuilder): Node {
    const context = builder.context;
    if (!isSampleContext(context)) {
      throw new Error(
        'The venue environment node was built outside an environment lighting context; assign it to scene.environmentNode only',
      );
    }
    const direction = materialEnvRotation.mul(vec4(context.getUV(this, builder), 0)).xyz;
    const roughness = context.getTextureLevel?.(this) ?? float(0);
    const blend = this.blend;
    return Fn(() => {
      const uv = equirectUV(direction).toVar();
      const color = vec3(0).toVar();
      If(blend.lessThan(1), () => {
        const level = clamp(roughness.mul(FALLBACK_LEVELS_PER_ROUGHNESS), 0, FALLBACK_MAX_LEVEL);
        color.assign(texture(this.fallback, uv).level(level).rgb);
      });
      If(blend.greaterThan(0), () => {
        const level = clamp(roughness.mul(HDRI_MAX_LEVEL), 0, HDRI_MAX_LEVEL);
        color.assign(mix(color, texture(this.hdri, uv).level(level).rgb, blend));
      });
      return color;
    })();
  }
}

interface HalfLevel {
  data: Uint16Array;
  width: number;
  height: number;
}

function equirectTexture(name: string, levels: HalfLevel[]): DataTexture {
  const base = levels[0];
  if (!base) throw new Error(`The ${name} texture needs at least one level`);
  const map = new DataTexture(base.data, base.width, base.height, RGBAFormat, HalfFloatType);
  map.mipmaps = levels;
  map.name = name;
  map.colorSpace = LinearSRGBColorSpace;
  map.mapping = EquirectangularReflectionMapping;
  map.wrapS = RepeatWrapping;
  map.minFilter = LinearMipmapLinearFilter;
  map.magFilter = LinearFilter;
  map.generateMipmaps = false;
  // Same row order as HDRLoader output: the file's first scanline is the zenith.
  map.flipY = true;
  map.needsUpdate = true;
  return map;
}

function prefilteredLevels(width: number, height: number, count: number): HalfLevel[] {
  return Array.from({ length: count }, (_, k) => ({
    data: new Uint16Array(0),
    width: width >> k,
    height: height >> k,
  }));
}

/**
 * The HDRI texture at its final size with no texels: the GPU allocates it on first use and
 * skips the upload, so the boot frame neither copies nor clears it and the later upload lands
 * in the texture every compiled material already binds.
 */
function createHdriTexture(): DataTexture {
  const { width, height, levels } = PREFILTERED_ENVIRONMENT;
  const hdri = equirectTexture('venue-hdri', prefilteredLevels(width, height, levels));
  hdri.source.dataReady = false;
  return hdri;
}

function checkPrefiltered(result: PrefilteredEnvironment): void {
  const { width, height, levels } = PREFILTERED_ENVIRONMENT;
  if (result.width !== width || result.height !== height || result.levels.length !== levels) {
    throw new Error(
      `The pre-filtered HDRI is ${String(result.width)}×${String(result.height)} with ${String(result.levels.length)} levels, not ${String(width)}×${String(height)} with ${String(levels)}`,
    );
  }
  result.levels.forEach((level, k) => {
    const expected = (width >> k) * (height >> k) * 4;
    if (level.length !== expected) {
      throw new Error(
        `Pre-filtered HDRI level ${String(k)} has ${String(level.length)} values, not ${String(expected)}`,
      );
    }
  });
}

function decodeDataUrl(url: string): ArrayBuffer {
  const comma = url.indexOf(',');
  if (!url.startsWith('data:') || !url.slice(0, comma).endsWith(';base64')) {
    throw new Error(
      'The venue environment fallback is not an inlined base64 data URL; regenerate it with hdri/bake-fallback.mjs',
    );
  }
  const binary = atob(url.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function halve(image: RadianceImage): RadianceImage {
  const width = Math.max(1, image.width >> 1);
  const height = Math.max(1, image.height >> 1);
  const sx = image.width / width;
  const sy = image.height / height;
  const data = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let c = 0; c < 4; c += 1) {
        let sum = 0;
        for (let j = 0; j < sy; j += 1) {
          for (let i = 0; i < sx; i += 1) {
            sum += image.data[((y * sy + j) * image.width + x * sx + i) * 4 + c] ?? 0;
          }
        }
        data[(y * width + x) * 4 + c] = sum / (sx * sy);
      }
    }
  }
  return { width, height, data };
}

function toHalf(image: RadianceImage): HalfLevel {
  return { data: toHalfFloats(image.data), width: image.width, height: image.height };
}

/**
 * Decodes an inlined HDRI into a half-float equirect with a full box-filtered mip chain, so
 * rough surfaces read a blurred sky without any pre-filtering.
 */
export function decodeFallbackEnvironment(dataUrl: string): DataTexture {
  let level = decodeRgbe(decodeDataUrl(dataUrl));
  const mipmaps = [toHalf(level)];
  while (level.width > 1 || level.height > 1) {
    level = halve(level);
    mipmaps.push(toHalf(level));
  }
  return equirectTexture('venue-hdri-fallback', mipmaps);
}

/**
 * Lights `scene` with image-based lighting that is ready on the first frame: a 32 px copy of
 * the HDRI inlined in the bundle, sampled directly. A few frames into play a worker fetches
 * the full HDRI and GGX pre-filters it into an equirect mip chain, which is uploaded in place
 * and crossfaded in through `scene.environmentNode`. The visible backdrop stays procedural;
 * the strength, `scene.environmentIntensity`, belongs to the render look (`applyRenderLook`).
 */
export function installVenueEnvironment(
  scene: Scene,
  options: VenueEnvironmentOptions,
): VenueEnvironment {
  const load = options.load ?? prefilterHdriInWorker;
  const fallback = decodeFallbackEnvironment(options.hdri.fallback);
  const hdri = createHdriTexture();

  let disposed = false;
  let blend = 0;
  let settledFrames = 0;
  let settledSeconds = 0;
  let loading = false;
  let delivered: PrefilteredEnvironment | null = null;
  let uploaded = false;
  let failed = false;
  let finish: (source: EnvironmentSource) => void = () => undefined;
  const ready = new Promise<EnvironmentSource>((resolve) => {
    finish = resolve;
  });
  const fail = (reason: string, error: unknown) => {
    failed = true;
    console.error(
      `Venue environment: ${reason}, so the scene stays lit by its 32 px fallback.`,
      error,
    );
    finish('fallback');
  };

  const startLoad = () => {
    loading = true;
    let pending: Promise<PrefilteredEnvironment>;
    try {
      pending = load(options.hdri);
    } catch (error) {
      fail('the HDRI did not load', error);
      return;
    }
    pending.then(
      (result) => {
        if (!disposed) delivered = result;
      },
      (error: unknown) => {
        if (!disposed) fail('the HDRI did not load', error);
      },
    );
  };

  const upload = (result: PrefilteredEnvironment, uploader: EnvironmentUploader) => {
    checkPrefiltered(result);
    const levels = result.levels.map((data, k) => ({
      data,
      width: result.width >> k,
      height: result.height >> k,
    }));
    hdri.image = levels[0] ?? hdri.image;
    hdri.mipmaps = levels;
    hdri.source.dataReady = true;
    hdri.needsUpdate = true;
    uploader.initTexture(hdri);
  };

  // Render group: object-group uniforms are only re-uploaded for objects the material observer
  // sees change, so most of the venue would keep sampling the fallback.
  const blendUniform = uniform(0)
    .setGroup(renderGroup)
    .onFrameUpdate((frame) => {
      environment.advance(frame.deltaTime, frame.renderer);
      return blend;
    });
  const node = new HandoffEnvironmentNode(fallback, hdri, blendUniform);
  node.name = 'venue-environment';

  const environment: VenueEnvironment = {
    node,
    fallback,
    hdri,
    get blend() {
      return blend;
    },
    ready,
    advance(deltaSeconds, renderer) {
      if (disposed || failed || blend >= 1) return;
      const dt = Number.isFinite(deltaSeconds) ? Math.max(deltaSeconds, 0) : 0;
      if (!loading) {
        settledFrames += 1;
        settledSeconds += dt;
        if (
          settledFrames >= ENVIRONMENT_HANDOFF.settleFrames &&
          settledSeconds >= ENVIRONMENT_HANDOFF.settleSeconds
        ) {
          startLoad();
        }
        return;
      }
      if (!uploaded) {
        if (delivered === null || !renderer) return;
        uploaded = true;
        try {
          upload(delivered, renderer);
        } catch (error) {
          fail('the pre-filtered HDRI could not be uploaded', error);
        }
        delivered = null;
        return;
      }
      blend = Math.min(
        1,
        blend + Math.min(dt, ENVIRONMENT_HANDOFF.maxFadeStep) / ENVIRONMENT_HANDOFF.fadeSeconds,
      );
      blendUniform.value = blend;
      if (blend >= 1) finish('hdri');
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      delivered = null;
      if (scene.environmentNode === node) scene.environmentNode = null;
      fallback.dispose();
      hdri.dispose();
      finish('fallback');
    },
  };

  scene.environmentNode = node;
  scene.environmentRotation.set(0, options.hdri.sunYaw - options.sunYaw, 0);

  return environment;
}

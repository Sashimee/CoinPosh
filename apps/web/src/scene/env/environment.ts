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
  Vector3,
  type NodeBuilder,
  type Renderer,
  type Scene,
} from 'three/webgpu';
import {
  clamp,
  equirectUV,
  float,
  materialEnvRotation,
  renderGroup,
  texture,
  uniform,
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

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The environment load was aborted', 'AbortError');
}

/**
 * Fetches an HDRI and pre-filters it (see `PREFILTERED_ENVIRONMENT`) without touching the scene.
 * When `signal` aborts, the loader stops its work and rejects with `signal.reason`.
 */
export type EnvironmentLoader = (
  hdri: HdriAsset,
  signal: AbortSignal,
) => Promise<PrefilteredEnvironment>;

/**
 * Runs the fetch, decode and GGX pre-filter in a Web Worker, so no frame ever waits on it.
 * Aborting terminates the worker, so a disposed venue leaves no pre-filter running.
 */
export const prefilterHdriInWorker: EnvironmentLoader = (hdri, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const worker = new Worker(new URL('./prefilter.worker.ts', import.meta.url), {
      type: 'module',
      name: 'coinposh-environment',
    });
    const stop = () => {
      worker.terminate();
      signal.removeEventListener('abort', abort);
      worker.removeEventListener('message', message);
      worker.removeEventListener('error', error);
    };
    const abort = () => {
      stop();
      reject(abortReason(signal));
    };
    const message = (event: MessageEvent<PrefilterReply>) => {
      stop();
      const reply = event.data;
      if (reply.ok) resolve(reply);
      else reject(new Error(`The environment worker failed: ${reply.message}`));
    };
    const error = (event: ErrorEvent) => {
      stop();
      reject(
        new Error(
          `The environment worker did not start (${event.message || event.type}); check that its chunk was bundled`,
        ),
      );
    };
    signal.addEventListener('abort', abort, { once: true });
    worker.addEventListener('message', message);
    worker.addEventListener('error', error);
    const request: PrefilterRequest = { url: new URL(hdri.url, document.baseURI).href };
    worker.postMessage(request);
  });

/**
 * When the HDRI takes over. Its fetch and pre-filter wait until play has rendered smoothly for
 * a while, so they never compete with boot or the first drops, then its reflections pull into
 * focus from the fallback's blur so the light sharpens instead of popping.
 */
export const ENVIRONMENT_HANDOFF = {
  settleFrames: 6,
  /** Counted in frame time capped at `maxFadeStep`, so boot's compile stalls do not count. */
  settleSeconds: 1,
  fadeSeconds: 0.8,
  /** Frame deltas past this are a stall, not settle or fade time. */
  maxFadeStep: 1 / 30,
} as const;

/**
 * How a roughness becomes a mip level of the environment texture,
 * `clamp(roughness * scale + bias, 0, max)`.
 */
interface LevelMapping {
  readonly scale: number;
  readonly bias: number;
  readonly max: number;
}

const HDRI_MAX_LEVEL = PREFILTERED_ENVIRONMENT.levels - 1;

/**
 * Where the 32 px fallback sits in the environment texture: the level of its size, followed by
 * one level that holds its 4 px box blur for the roughest surfaces and irradiance.
 */
export const FALLBACK_LEVEL = Math.log2(PREFILTERED_ENVIRONMENT.width / 32);

/** Roughness from which the fallback reads only its blurred level. */
const FALLBACK_FULL_BLUR_ROUGHNESS = 0.9;

const FALLBACK_LEVELS: LevelMapping = {
  scale: 1 / FALLBACK_FULL_BLUR_ROUGHNESS,
  bias: FALLBACK_LEVEL,
  max: FALLBACK_LEVEL + 1,
};

/**
 * The fallback's look read from the pre-filtered HDRI: its 32 px texels (about 11°) match the
 * GGX lobe of level 2 and its 4 px blur the irradiance in the last level. The handoff starts
 * here, so the first HDRI frame is as soft as the last fallback one.
 */
const HDRI_SOFT_LEVELS: LevelMapping = { scale: 3.3, bias: 2, max: HDRI_MAX_LEVEL };

/** Level `k` holds roughness `k / (levels - 1)`; see `PREFILTERED_ENVIRONMENT`. */
const HDRI_LEVELS: LevelMapping = { scale: HDRI_MAX_LEVEL, bias: 0, max: HDRI_MAX_LEVEL };

function setLevels(target: Vector3, mapping: LevelMapping): Vector3 {
  return target.set(mapping.scale, mapping.bias, mapping.max);
}

/** The HDRI's level mapping `focus` (0 to 1, eased) of the way from soft to sharp. */
function focusLevels(target: Vector3, focus: number): Vector3 {
  const eased = focus * focus * (3 - 2 * focus);
  const lerp = (from: number, to: number) => from + (to - from) * eased;
  return target.set(
    lerp(HDRI_SOFT_LEVELS.scale, HDRI_LEVELS.scale),
    lerp(HDRI_SOFT_LEVELS.bias, HDRI_LEVELS.bias),
    lerp(HDRI_SOFT_LEVELS.max, HDRI_LEVELS.max),
  );
}

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
  /** The scene's `environmentNode`: one trilinear sample of `map` per lookup. */
  readonly node: Node<'vec3'>;
  /**
   * The one texture the environment samples, at the pre-filtered HDRI's size from the first
   * frame. Until the handoff only `FALLBACK_LEVEL` and the level after it hold texels; the
   * handoff uploads the HDRI's levels into it in place, so no binding ever changes.
   */
  readonly map: DataTexture;
  /** What `map` holds now. */
  readonly source: EnvironmentSource;
  /**
   * 0 until the handoff, then rising to 1 as the HDRI's reflections pull into focus from the
   * fallback's softness.
   */
  readonly blend: number;
  /**
   * Resolves `hdri` once the HDRI is in full focus, or `fallback` when it failed to load or
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
 * One trilinear sample of the environment equirect through the rotation and roughness the
 * environment lighting asks for and the uniform roughness-to-level mapping `levels` (scale,
 * bias, max). The handoff only rewrites the texture's texels and moves `levels`: it rebuilds no
 * material and rebinds no texture, and every shader compiles one sampler and no branch.
 */
class HandoffEnvironmentNode extends Node<'vec3'> {
  constructor(
    private readonly map: DataTexture,
    private readonly levels: Node<'vec3'>,
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
    const level = clamp(roughness.mul(this.levels.x).add(this.levels.y), 0, this.levels.z);
    return texture(this.map, equirectUV(direction)).level(level).rgb;
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

/** Bilinear resample of an equirect, wrapping in longitude and clamping at the poles. */
function resample(image: RadianceImage, width: number, height: number): RadianceImage {
  const data = new Float32Array(width * height * 4);
  const texel = (x: number, y: number, c: number) => {
    const column = ((x % image.width) + image.width) % image.width;
    const row = Math.min(Math.max(y, 0), image.height - 1);
    return image.data[(row * image.width + column) * 4 + c] ?? 0;
  };
  for (let y = 0; y < height; y += 1) {
    const v = ((y + 0.5) / height) * image.height - 0.5;
    const y0 = Math.floor(v);
    const fy = v - y0;
    for (let x = 0; x < width; x += 1) {
      const u = ((x + 0.5) / width) * image.width - 0.5;
      const x0 = Math.floor(u);
      const fx = u - x0;
      for (let c = 0; c < 4; c += 1) {
        const top = texel(x0, y0, c) * (1 - fx) + texel(x0 + 1, y0, c) * fx;
        const bottom = texel(x0, y0 + 1, c) * (1 - fx) + texel(x0 + 1, y0 + 1, c) * fx;
        data[(y * width + x) * 4 + c] = top * (1 - fy) + bottom * fy;
      }
    }
  }
  return { width, height, data };
}

function toHalf(image: RadianceImage): HalfLevel {
  return { data: toHalfFloats(image.data), width: image.width, height: image.height };
}

/**
 * The environment texture for boot: the pre-filtered HDRI's size and level count, with the
 * inlined fallback decoded into `FALLBACK_LEVEL` and its 4 px box blur, resampled, into the
 * next. The larger levels are zero; the boot level mapping never reads them, and the handoff
 * overwrites every level.
 */
export function createEnvironmentTexture(fallbackDataUrl: string): DataTexture {
  const { width, height, levels } = PREFILTERED_ENVIRONMENT;
  const fallback = decodeRgbe(decodeDataUrl(fallbackDataUrl));
  const fallbackWidth = width >> FALLBACK_LEVEL;
  const fallbackHeight = height >> FALLBACK_LEVEL;
  if (fallback.width !== fallbackWidth || fallback.height !== fallbackHeight) {
    throw new Error(
      `The venue environment fallback is ${String(fallback.width)}×${String(fallback.height)}, not ${String(fallbackWidth)}×${String(fallbackHeight)}; regenerate it with hdri/bake-fallback.mjs`,
    );
  }
  let blur = fallback;
  while (blur.width > 4) blur = halve(blur);
  const zero = new Uint16Array(width * height * 4);
  const mipmaps = Array.from({ length: levels }, (_, k): HalfLevel => {
    const size = { width: width >> k, height: height >> k };
    if (k === FALLBACK_LEVEL) return toHalf(fallback);
    if (k === FALLBACK_LEVEL + 1) return toHalf(resample(blur, size.width, size.height));
    return { data: zero.subarray(0, size.width * size.height * 4), ...size };
  });
  return equirectTexture('venue-environment', mipmaps);
}

/**
 * Lights `scene` with image-based lighting that is ready on the first frame: a 32 px copy of
 * the HDRI inlined in the bundle, sampled from the small levels of the environment texture.
 * Once play has run smoothly for a while, a worker fetches the full HDRI and GGX pre-filters it
 * into an equirect mip chain, which is uploaded into the same texture, as soft as the fallback
 * at first and then pulling into focus. The visible backdrop stays procedural; the strength,
 * `scene.environmentIntensity`, belongs to the render look (`applyRenderLook`).
 */
export function installVenueEnvironment(
  scene: Scene,
  options: VenueEnvironmentOptions,
): VenueEnvironment {
  const load = options.load ?? prefilterHdriInWorker;
  const map = createEnvironmentTexture(options.hdri.fallback);

  const abort = new AbortController();
  let disposed = false;
  let source: EnvironmentSource = 'fallback';
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
      pending = load(options.hdri, abort.signal);
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

  const lod = setLevels(new Vector3(), FALLBACK_LEVELS);

  const upload = (result: PrefilteredEnvironment, uploader: EnvironmentUploader) => {
    checkPrefiltered(result);
    const levels = result.levels.map((data, k) => ({
      data,
      width: result.width >> k,
      height: result.height >> k,
    }));
    map.image = levels[0] ?? map.image;
    map.mipmaps = levels;
    map.needsUpdate = true;
    uploader.initTexture(map);
    focusLevels(lod, 0);
    source = 'hdri';
  };

  // Render group: object-group uniforms are only re-uploaded for objects the material observer
  // sees change, so most of the venue would keep the boot mapping.
  const lodUniform = uniform(lod)
    .setGroup(renderGroup)
    .onFrameUpdate((frame) => {
      environment.advance(frame.deltaTime, frame.renderer);
      return lod;
    });
  const node = new HandoffEnvironmentNode(map, lodUniform);
  node.name = 'venue-environment';

  const environment: VenueEnvironment = {
    node,
    map,
    get source() {
      return source;
    },
    get blend() {
      return blend;
    },
    ready,
    advance(deltaSeconds, renderer) {
      if (disposed || failed || blend >= 1) return;
      const dt = Number.isFinite(deltaSeconds)
        ? Math.min(Math.max(deltaSeconds, 0), ENVIRONMENT_HANDOFF.maxFadeStep)
        : 0;
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
      blend = Math.min(1, blend + dt / ENVIRONMENT_HANDOFF.fadeSeconds);
      focusLevels(lod, blend);
      if (blend >= 1) finish('hdri');
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      delivered = null;
      abort.abort(new DOMException('The venue environment was disposed', 'AbortError'));
      if (scene.environmentNode === node) scene.environmentNode = null;
      map.dispose();
      finish('fallback');
    },
  };

  scene.environmentNode = node;
  scene.environmentRotation.set(0, options.hdri.sunYaw - options.sunYaw, 0);

  return environment;
}

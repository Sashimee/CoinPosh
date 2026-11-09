import {
  CubeRenderTarget,
  DataTexture,
  DataUtils,
  EquirectangularReflectionMapping,
  FloatType,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  LinearSRGBColorSpace,
  Node,
  PMREMGenerator,
  RepeatWrapping,
  RGBAFormat,
  type Texture,
  type NodeBuilder,
  type Renderer,
  type Scene,
} from 'three/webgpu';
import {
  clamp,
  equirectUV,
  float,
  materialEnvRotation,
  mix,
  pmremTexture,
  renderGroup,
  texture,
  uniform,
  vec4,
} from 'three/tsl';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import veniceSunsetUrl from './hdri/venice_sunset_512.hdr?url';
import veniceSunsetFallback from './hdri/venice_sunset_32.ts';

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

/** Loads an HDRI as an equirect texture without touching the scene. */
export type EnvironmentLoader = (hdri: HdriAsset) => Promise<Texture>;

export const loadHdriEnvironment: EnvironmentLoader = async (hdri) => {
  const loaded = await new HDRLoader().loadAsync(hdri.url).catch((error: unknown) => {
    throw new Error(
      `Venue environment HDRI failed to load from ${hdri.url}; check that the asset was bundled`,
      { cause: error },
    );
  });
  loaded.mapping = EquirectangularReflectionMapping;
  loaded.name = 'venue-hdri';
  return loaded;
};

/**
 * When the HDRI takes over. Its PMREM pre-filter is one long frame (about 2.5 s on
 * SwiftShader, tens of ms on a phone), so it waits until the first frames of play are on
 * screen, then crossfades in so the light blooms instead of popping.
 */
export const ENVIRONMENT_HANDOFF = {
  settleFrames: 6,
  settleSeconds: 0.75,
  fadeSeconds: 0.8,
  /** Frame deltas past this are a stall (the pre-filter frame itself), not fade time. */
  maxFadeStep: 1 / 30,
} as const;

/** Box-filtered mips past this blur up and down together, which irradiance must not do. */
const FALLBACK_MAX_LEVEL = 3;
const FALLBACK_LEVELS_PER_ROUGHNESS = 3.3;

/**
 * Cube face size `PMREMGenerator` picks for a 512 px equirect (width / 4, floored to a power
 * of two, at least 256). The target is allocated at this size up front so the pre-filter can
 * render into the texture the materials already sample.
 */
const PMREM_CUBE_SIZE = 256;
const PMREM_LOD_MIN = 3;

export type EnvironmentSource = 'fallback' | 'hdri';

/** Pre-filters `hdri` into `target`, which keeps its texture object so no binding changes. */
export type EnvironmentPrefilter = (hdri: Texture, target: CubeRenderTarget) => void;

export interface VenueEnvironmentOptions {
  readonly hdri: HdriAsset;
  /** Yaw of the venue's sun; the HDRI is rotated so its glow sits behind the venue's sun. */
  readonly sunYaw: number;
  readonly load?: EnvironmentLoader;
  /** Defaults to a `PMREMGenerator` on the renderer that draws the scene. */
  readonly prefilter?: EnvironmentPrefilter;
}

export interface VenueEnvironment {
  /** The scene's `environmentNode`: the fallback mixed with the pre-filtered HDRI. */
  readonly node: Node<'vec3'>;
  readonly fallback: DataTexture;
  /** The loaded HDRI once it arrives, null before and after a failed load. */
  readonly hdri: Texture | null;
  /** 0 while the fallback lights the scene, 1 once the HDRI has fully taken over. */
  readonly blend: number;
  /**
   * Resolves `hdri` once the HDRI has fully faded in, or `fallback` when it failed to load or
   * pre-filter (logged as an error) or the environment was disposed first. Never rejects.
   */
  readonly ready: Promise<EnvironmentSource>;
  /**
   * Runs once per rendered frame from the node graph with that frame's renderer; exposed for
   * tests and harnesses.
   */
  advance(deltaSeconds: number, renderer?: Renderer | null): void;
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
 * Samples the boot fallback through the same rotation and roughness-to-blur mapping the
 * environment lighting asks of a PMREM, then mixes in the pre-filtered HDRI by `blend`.
 * Both paths are compiled from the first frame, so the handoff never rebuilds a material.
 */
class HandoffEnvironmentNode extends Node<'vec3'> {
  constructor(
    private readonly fallback: Texture,
    private readonly pmrem: Node<'vec3'>,
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
    const level = clamp(roughness.mul(FALLBACK_LEVELS_PER_ROUGHNESS), 0, FALLBACK_MAX_LEVEL);
    const fallback = texture(this.fallback, equirectUV(direction)).level(level).rgb;
    return mix(fallback, this.pmrem, this.blend);
  }
}

interface RadianceImage {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;
}

function createPmremTarget(): CubeRenderTarget {
  const target = new CubeRenderTarget(PMREM_CUBE_SIZE, {
    minFilter: LinearMipmapLinearFilter,
    generateMipmaps: false,
    type: HalfFloatType,
    colorSpace: LinearSRGBColorSpace,
    depthBuffer: false,
  });
  const maxLod = Math.log2(PMREM_CUBE_SIZE) - PMREM_LOD_MIN;
  const mipmaps = [];
  for (let lod = 0; lod <= maxLod; lod += 1) {
    const size = PMREM_CUBE_SIZE >> lod;
    mipmaps.push({ data: new Uint16Array(0), width: size, height: size });
  }
  target.texture.mipmaps = mipmaps;
  // CubeRenderTarget swaps in its cube texture after the base constructor links the original
  // one, so the link is missing. Without it the first sample allocates the texture outside its
  // render target, and the first render into it reallocates it under the materials' binding.
  target.texture.renderTarget = target;
  target.texture.name = 'venue-environment-pmrem';
  target.texture.isPMREMTexture = true;
  return target;
}

function pmremCubeSize(hdri: Texture): number {
  const width = (hdri.image as { width?: number } | null)?.width ?? 0;
  return Math.max(PMREM_CUBE_SIZE, 2 ** Math.floor(Math.log2(Math.max(width / 4, 1))));
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

function toHalf(image: RadianceImage): { data: Uint16Array; width: number; height: number } {
  const data = new Uint16Array(image.data.length);
  for (let i = 0; i < data.length; i += 1) data[i] = DataUtils.toHalfFloat(image.data[i] ?? 0);
  return { data, width: image.width, height: image.height };
}

/**
 * Decodes an inlined HDRI into a half-float equirect with a full box-filtered mip chain, so
 * rough surfaces read a blurred sky without any GPU pre-filtering.
 */
export function decodeFallbackEnvironment(dataUrl: string): DataTexture {
  const loader = new HDRLoader();
  loader.setDataType(FloatType);
  const parsed = loader.parse(decodeDataUrl(dataUrl));
  const { width, height, data } = parsed;
  if (!(data instanceof Float32Array) || width === undefined || height === undefined) {
    throw new Error('The venue environment fallback did not decode to sized float RGBA data');
  }
  let level: RadianceImage = { width, height, data };
  const mipmaps = [toHalf(level)];
  while (level.width > 1 || level.height > 1) {
    level = halve(level);
    mipmaps.push(toHalf(level));
  }
  const base = mipmaps[0];
  const fallback = new DataTexture(base?.data, width, height, RGBAFormat, HalfFloatType);
  fallback.mipmaps = mipmaps;
  fallback.name = 'venue-hdri-fallback';
  fallback.colorSpace = LinearSRGBColorSpace;
  fallback.mapping = EquirectangularReflectionMapping;
  fallback.wrapS = RepeatWrapping;
  fallback.minFilter = LinearMipmapLinearFilter;
  fallback.magFilter = LinearFilter;
  fallback.generateMipmaps = false;
  // Same row order as HDRLoader output: the file's first scanline is the zenith.
  fallback.flipY = true;
  fallback.needsUpdate = true;
  return fallback;
}

/**
 * Lights `scene` with image-based lighting that is ready on the first frame: a 32 px copy of
 * the HDRI inlined in the bundle, sampled directly (no PMREM). The full HDRI loads in the
 * background and, a few frames into play, is pre-filtered and crossfaded in through
 * `scene.environmentNode`. The visible backdrop stays procedural; the strength,
 * `scene.environmentIntensity`, belongs to the render look (`applyRenderLook`).
 */
export function installVenueEnvironment(
  scene: Scene,
  options: VenueEnvironmentOptions,
): VenueEnvironment {
  const load = options.load ?? loadHdriEnvironment;
  const fallback = decodeFallbackEnvironment(options.hdri.fallback);
  // Flagged as already pre-filtered, so the PMREM node binds it without baking anything. The
  // HDRI is later pre-filtered into this same texture: swapping in a different render-target
  // texture leaves compiled materials sampling the old one, because both carry the same
  // binding generation.
  const target = createPmremTarget();
  const pmrem = pmremTexture(target.texture);
  let generator: PMREMGenerator | null = null;
  let lastRenderer: Renderer | null = null;
  const prefilter =
    options.prefilter ??
    ((source: Texture, into: CubeRenderTarget) => {
      if (lastRenderer === null) {
        throw new Error('The venue environment cannot pre-filter its HDRI before a frame renders');
      }
      generator ??= new PMREMGenerator(lastRenderer);
      generator.fromEquirectangular(source, into);
    });

  let hdri: Texture | null = null;
  let disposed = false;
  let blend = 0;
  let settledFrames = 0;
  let settledSeconds = 0;
  let handedOff = false;
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

  // Render group: object-group uniforms are only re-uploaded for objects the material observer
  // sees change, so most of the venue would keep sampling the fallback.
  const blendUniform = uniform(0)
    .setGroup(renderGroup)
    .onFrameUpdate((frame) => {
      environment.advance(frame.deltaTime, frame.renderer);
      return blend;
    });
  const node = new HandoffEnvironmentNode(fallback, pmrem, blendUniform);
  node.name = 'venue-environment';

  const environment: VenueEnvironment = {
    node,
    fallback,
    get hdri() {
      return hdri;
    },
    get blend() {
      return blend;
    },
    ready,
    advance(deltaSeconds, renderer) {
      if (disposed || failed || blend >= 1) return;
      if (renderer) lastRenderer = renderer;
      const dt = Number.isFinite(deltaSeconds) ? Math.max(deltaSeconds, 0) : 0;
      if (!handedOff) {
        settledFrames += 1;
        settledSeconds += dt;
        const settled =
          settledFrames >= ENVIRONMENT_HANDOFF.settleFrames &&
          settledSeconds >= ENVIRONMENT_HANDOFF.settleSeconds;
        if (hdri === null || !settled) return;
        handedOff = true;
        try {
          if (pmremCubeSize(hdri) !== PMREM_CUBE_SIZE) {
            throw new Error(
              `The HDRI pre-filters to a ${String(pmremCubeSize(hdri))} px cube, not the ${String(PMREM_CUBE_SIZE)} px target; ship a 512 px equirect or change PMREM_CUBE_SIZE`,
            );
          }
          prefilter(hdri, target);
        } catch (error) {
          fail('the HDRI could not be pre-filtered', error);
        }
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
      if (scene.environmentNode === node) scene.environmentNode = null;
      fallback.dispose();
      hdri?.dispose();
      pmrem.dispose();
      target.dispose();
      generator?.dispose();
      finish('fallback');
    },
  };

  scene.environmentNode = node;
  scene.environmentRotation.set(0, options.hdri.sunYaw - options.sunYaw, 0);

  load(options.hdri).then(
    (loaded) => {
      if (disposed) {
        loaded.dispose();
        return;
      }
      hdri = loaded;
    },
    (error: unknown) => {
      if (disposed) return;
      fail('the HDRI did not load', error);
    },
  );

  return environment;
}

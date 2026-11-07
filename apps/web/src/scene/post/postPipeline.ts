import {
  AgXToneMapping,
  Color,
  RenderPipeline,
  SRGBColorSpace,
  type Camera,
  type ColorRepresentation,
  type Node,
  type PassNode,
  type Scene,
  type WebGPURenderer,
} from 'three/webgpu';
import { pass, renderOutput, uniform, vec4 } from 'three/tsl';
import { bloom, type default as BloomNode } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { pixelRatioFor, type QualityProfile } from '../quality/tiers.ts';
import { filmGrain, warmVignette } from './grade.ts';
import { applyRenderLook, DEFAULT_RENDER_LOOK, type RenderLook } from './look.ts';
import { watchReducedMotion, type MotionPreference } from './reducedMotion.ts';

/** Deep amber that the vignette leans toward; venues can retint it from their palette. */
export const DEFAULT_VIGNETTE_TINT = 0xffc58a;
const MSAA_SAMPLES = 4;
/** Grain re-rolls at film cadence; refreshing every display frame reads as digital fizz. */
const GRAIN_FPS = 24;

export interface PostPipelineOptions {
  readonly vignetteTint?: ColorRepresentation;
  /** Exposure, IBL intensity and shadow map; defaults to the Riviera grade. */
  readonly look?: RenderLook;
  /** Overrides the `prefers-reduced-motion` media query, mainly for tests and captures. */
  readonly reducedMotion?: boolean;
  /** Reads the display's device pixel ratio; defaults to `window.devicePixelRatio`. */
  readonly devicePixelRatio?: () => number;
}

export interface PostUniforms {
  /** Multiplier on the look's exposure for juice (flashes, reveals); 1 is the resting look. */
  readonly exposureBoost: { value: number };
  /** Multiplier on the tier's bloom for juice (combo tiers, flashes); 1 is the resting look. */
  readonly bloomBoost: { value: number };
  readonly vignetteStrength: { value: number };
  readonly vignetteTint: { value: Color };
}

export interface PostPipeline {
  readonly profile: QualityProfile;
  readonly look: RenderLook;
  readonly uniforms: PostUniforms;
  /** The renderer pixel ratio the tier allows on this display; the whole chain runs at it. */
  readonly pixelRatio: number;
  /** Fraction of `pixelRatio` the scene pass renders at, set by dynamic resolution. */
  readonly dynamicScale: number;
  /** Device pixels per CSS pixel of the scene pass: `pixelRatio * dynamicScale`. */
  readonly scenePixelRatio: number;
  setProfile(profile: QualityProfile): void;
  setLook(look: RenderLook): void;
  setDynamicScale(scale: number): void;
  render(nowMs: number): void;
  dispose(): void;
}

interface Graph {
  readonly scenePass: PassNode;
  readonly bloomPass: BloomNode;
}

export function createPostPipeline(
  renderer: WebGPURenderer,
  scene: Scene,
  camera: Camera,
  initialProfile: QualityProfile,
  options: PostPipelineOptions = {},
): PostPipeline {
  if (renderer.samples > 0) {
    throw new Error(
      `createPostPipeline needs a renderer created with antialias: false (it has ${renderer.samples} MSAA samples); ` +
        'the scene pass does its own anti-aliasing and a multisampled canvas only adds cost',
    );
  }
  const readDevicePixelRatio = options.devicePixelRatio ?? (() => globalThis.devicePixelRatio);

  let look = options.look ?? DEFAULT_RENDER_LOOK;
  applyRenderLook(renderer, scene, look);

  const exposureBoost = uniform(1);
  const bloomBoost = uniform(1);
  const vignetteStrength = uniform(initialProfile.vignette.strength);
  const vignetteWarmth = uniform(initialProfile.vignette.warmth);
  const vignetteTint = uniform(new Color(options.vignetteTint ?? DEFAULT_VIGNETTE_TINT));
  const grainAmount = uniform(initialProfile.grain);
  const grainSeed = uniform(0);

  const pipeline = new RenderPipeline(renderer);
  pipeline.outputColorTransform = false;

  let profile = initialProfile;
  let dynamicScale = initialProfile.maxResolutionScale;
  let appliedSceneScale = Number.NaN;
  syncPixelRatio();
  let graph = build(profile);

  let motion: MotionPreference | null = null;
  let reducedMotion: boolean;
  if (options.reducedMotion === undefined) {
    motion = watchReducedMotion((reduced) => {
      reducedMotion = reduced;
    });
    reducedMotion = motion.reduced;
  } else {
    reducedMotion = options.reducedMotion;
  }

  function build(next: QualityProfile): Graph {
    const scenePass = pass(scene, camera, {
      samples: next.antiAlias === 'msaa' ? MSAA_SAMPLES : 0,
    });
    const hdr = scenePass.getTextureNode('output');
    const bloomPass = bloom(hdr, next.bloom.strength, next.bloom.radius, next.bloom.threshold);
    bloomPass.setResolutionScale(next.bloom.resolutionScale);

    const lit = hdr.add(bloomPass.mul(bloomBoost));
    const boosted = vec4(lit.rgb.mul(exposureBoost), lit.a);
    const vignetted = warmVignette(boosted, {
      strength: vignetteStrength,
      warmth: vignetteWarmth,
      tint: vignetteTint,
    });
    // renderOutput reads renderer.toneMappingExposure, which applyRenderLook owns.
    const display = renderOutput(vignetted, AgXToneMapping, SRGBColorSpace);
    // Grain goes last: FXAA would read per-pixel noise as edges and smear it into blotches.
    // @types/three declares FXAANode as an untyped Node; at runtime it outputs vec4 colour.
    const antiAliased =
      next.antiAlias === 'fxaa' ? (fxaa(display) as unknown as Node<'vec4'>) : display;
    pipeline.outputNode = filmGrain(antiAliased, grainAmount, grainSeed);
    pipeline.needsUpdate = true;
    appliedSceneScale = Number.NaN;
    return { scenePass, bloomPass };
  }

  function syncPixelRatio(): void {
    const ratio = pixelRatioFor(profile, readDevicePixelRatio());
    if (renderer.getPixelRatio() !== ratio) renderer.setPixelRatio(ratio);
  }

  return {
    get profile() {
      return profile;
    },
    get look() {
      return look;
    },
    uniforms: {
      exposureBoost,
      bloomBoost,
      vignetteStrength,
      vignetteTint,
    },
    get pixelRatio() {
      return pixelRatioFor(profile, readDevicePixelRatio());
    },
    get dynamicScale() {
      return dynamicScale;
    },
    get scenePixelRatio() {
      return pixelRatioFor(profile, readDevicePixelRatio()) * dynamicScale;
    },
    setProfile(next) {
      if (next === profile) return;
      const rebuild = next.antiAlias !== profile.antiAlias;
      profile = next;
      dynamicScale = Math.min(
        next.maxResolutionScale,
        Math.max(next.minResolutionScale, dynamicScale),
      );
      vignetteStrength.value = next.vignette.strength;
      vignetteWarmth.value = next.vignette.warmth;
      grainAmount.value = next.grain;
      syncPixelRatio();
      if (rebuild) {
        disposeGraph(graph);
        graph = build(next);
        return;
      }
      graph.bloomPass.strength.value = next.bloom.strength;
      graph.bloomPass.radius.value = next.bloom.radius;
      graph.bloomPass.threshold.value = next.bloom.threshold;
      graph.bloomPass.setResolutionScale(next.bloom.resolutionScale);
      appliedSceneScale = Number.NaN;
    },
    setLook(next) {
      if (next.shadows !== look.shadows) {
        throw new Error(
          'RenderLook.shadows cannot change on a live pipeline (compiled materials keep their shadow nodes); pass it in createPostPipeline options',
        );
      }
      applyRenderLook(renderer, scene, next);
      look = next;
    },
    setDynamicScale(scale) {
      dynamicScale = Math.min(
        profile.maxResolutionScale,
        Math.max(profile.minResolutionScale, scale),
      );
    },
    render(nowMs) {
      syncPixelRatio();
      if (dynamicScale !== appliedSceneScale) {
        graph.scenePass.setResolutionScale(dynamicScale);
        appliedSceneScale = dynamicScale;
      }
      if (!reducedMotion) grainSeed.value = Math.floor((nowMs / 1000) * GRAIN_FPS) % 4096;
      pipeline.render();
    },
    dispose() {
      motion?.dispose();
      disposeGraph(graph);
      pipeline.dispose();
    },
  };
}

function disposeGraph(graph: Graph): void {
  graph.scenePass.dispose();
  graph.bloomPass.dispose();
}

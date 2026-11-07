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
import type { QualityProfile } from '../quality/tiers.ts';
import { filmGrain, warmVignette } from './grade.ts';
import { watchReducedMotion, type MotionPreference } from './reducedMotion.ts';

/** Deep amber that the vignette leans toward; venues can retint it from their palette. */
export const DEFAULT_VIGNETTE_TINT = 0xffc58a;
const MSAA_SAMPLES = 4;
/** Grain re-rolls at film cadence; refreshing every display frame reads as digital fizz. */
const GRAIN_FPS = 24;

export interface PostPipelineOptions {
  readonly vignetteTint?: ColorRepresentation;
  /** Overrides the `prefers-reduced-motion` media query, mainly for tests and captures. */
  readonly reducedMotion?: boolean;
}

export interface PostUniforms {
  /** Linear exposure applied before AgX. */
  readonly exposure: { value: number };
  /** Multiplier on the tier's bloom for juice (combo tiers, flashes); 1 is the resting look. */
  readonly bloomBoost: { value: number };
  readonly vignetteStrength: { value: number };
  readonly vignetteTint: { value: Color };
}

export interface PostPipeline {
  readonly profile: QualityProfile;
  readonly uniforms: PostUniforms;
  /** Fraction of the tier's pixel ratio the scene renders at, set by dynamic resolution. */
  readonly dynamicScale: number;
  /** The scene pass's actual scale relative to the drawing buffer. */
  readonly sceneScale: number;
  setProfile(profile: QualityProfile): void;
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
  renderer.toneMapping = AgXToneMapping;
  renderer.outputColorSpace = SRGBColorSpace;

  const exposure = uniform(1);
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
    const exposed = vec4(lit.rgb.mul(exposure), lit.a);
    const vignetted = warmVignette(exposed, {
      strength: vignetteStrength,
      warmth: vignetteWarmth,
      tint: vignetteTint,
    });
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

  function sceneScaleFor(scale: number): number {
    const ratioCap = Math.min(1, profile.maxPixelRatio / renderer.getPixelRatio());
    return ratioCap * scale;
  }

  return {
    get profile() {
      return profile;
    },
    uniforms: {
      exposure,
      bloomBoost,
      vignetteStrength,
      vignetteTint,
    },
    get dynamicScale() {
      return dynamicScale;
    },
    get sceneScale() {
      return sceneScaleFor(dynamicScale);
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
    setDynamicScale(scale) {
      dynamicScale = Math.min(
        profile.maxResolutionScale,
        Math.max(profile.minResolutionScale, scale),
      );
    },
    render(nowMs) {
      const sceneScale = sceneScaleFor(dynamicScale);
      if (sceneScale !== appliedSceneScale) {
        graph.scenePass.setResolutionScale(sceneScale);
        appliedSceneScale = sceneScale;
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

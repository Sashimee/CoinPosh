import {
  AgXToneMapping,
  PCFShadowMap,
  SRGBColorSpace,
  type Scene,
  type ShadowMapType,
  type ToneMapping,
} from 'three/webgpu';

/**
 * The renderer-wide grading values a venue feeds in. The post pipeline is the only code
 * that writes them to the renderer and scene, so a venue never fights the grade.
 */
export interface RenderLook {
  /** Linear exposure into AgX. */
  readonly exposure: number;
  /** `scene.environmentIntensity` for the venue's image-based lighting. */
  readonly environmentIntensity: number;
  /** Renderer shadow map (PCF). Changing it later recompiles every lit material. */
  readonly shadows: boolean;
}

/** The Riviera grade from the art bible: AgX at 0.85 and a restrained 0.32 IBL. */
export const DEFAULT_RENDER_LOOK: RenderLook = {
  exposure: 0.85,
  environmentIntensity: 0.32,
  shadows: true,
};

/** The renderer state the look writes; a WebGPURenderer satisfies it. */
export interface LookRenderer {
  toneMapping: ToneMapping;
  toneMappingExposure: number;
  outputColorSpace: string;
  readonly shadowMap: { enabled: boolean; type: ShadowMapType | null };
}

export function applyRenderLook(
  renderer: LookRenderer,
  scene: Pick<Scene, 'environmentIntensity'>,
  look: RenderLook,
): void {
  if (!(look.exposure > 0) || !(look.environmentIntensity >= 0)) {
    throw new Error(
      `RenderLook needs exposure > 0 and environmentIntensity >= 0, got ${look.exposure} / ${look.environmentIntensity}`,
    );
  }
  renderer.toneMapping = AgXToneMapping;
  renderer.toneMappingExposure = look.exposure;
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.shadowMap.enabled = look.shadows;
  renderer.shadowMap.type = PCFShadowMap;
  scene.environmentIntensity = look.environmentIntensity;
}

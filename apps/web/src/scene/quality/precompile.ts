import {
  Vector2,
  type Camera,
  type RenderTarget,
  type Object3D,
  type Scene,
  type WebGPURenderer,
} from 'three/webgpu';
import { pass } from 'three/tsl';
import type { QualityProfile } from './tiers.ts';

/** Matches the post pipeline's scene pass, so the precompiled pipelines are the ones it draws. */
const SCENE_PASS_MSAA_SAMPLES = 4;

/**
 * Compiles the materials under `root` the way the post pipeline's scene pass will draw them in
 * `scene` at `profile`, against the scene's lights, without drawing anything. `camera` decides
 * what is compiled through its layers.
 *
 * Only `root` is compiled, not the whole scene: compiling calls each object's render hooks, and
 * the unbox primer leaves the scene and unbinds its god-ray from its `onAfterRender`, before the
 * compile reaches the ray. Lights under `root` are left out of what is compiled: three adds the
 * scene's lights to the compiled set on top of the ones it finds under the compiled object, and
 * a light counted twice gives every lit material another shader than the one it draws with.
 */
export async function precompileScene(
  renderer: WebGPURenderer,
  scene: Scene,
  root: Object3D,
  camera: Camera,
  profile: QualityProfile,
): Promise<void> {
  const probe = pass(scene, camera, {
    samples: profile.antiAlias === 'msaa' ? SCENE_PASS_MSAA_SAMPLES : 0,
  });
  const target = probe.renderTarget;
  // Only PassNode.setup sets this type, yet the render pipeline is keyed on the target format.
  target.texture.type = renderer.getOutputBufferType();
  const size = renderer.getDrawingBufferSize(new Vector2());
  probe.setSize(size.width, size.height);
  try {
    for (const branch of lightFreeBranches(root)) {
      await compileInto(renderer, target, branch, camera, scene);
    }
  } finally {
    probe.dispose();
  }
}

function compileInto(
  renderer: WebGPURenderer,
  target: RenderTarget,
  object: Object3D,
  camera: Camera,
  scene: Scene,
): Promise<void> {
  const previousTarget = renderer.getRenderTarget();
  const previousMrt = renderer.getMRT();
  renderer.setRenderTarget(target);
  renderer.setMRT(null);
  try {
    // On an initialised renderer compileAsync snapshots the target before its first await, so
    // the renderer gets its own target back before anything else can draw.
    return renderer.compileAsync(object, camera, scene);
  } finally {
    renderer.setRenderTarget(previousTarget);
    renderer.setMRT(previousMrt);
  }
}

/** The largest subtrees of `root` that hold no light. */
export function lightFreeBranches(root: Object3D): Object3D[] {
  if (!holdsLight(root)) return [root];
  return root.children.flatMap(lightFreeBranches);
}

function holdsLight(object: Object3D): boolean {
  let found = false;
  object.traverse((child) => {
    if ((child as { readonly isLight?: boolean }).isLight === true) found = true;
  });
  return found;
}

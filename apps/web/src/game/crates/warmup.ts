import type { Object3D } from 'three/webgpu';

/**
 * The warm-up draws each part this far below the table, where every triangle is clipped: the GPU
 * builds the pipelines while nothing can be seen.
 */
const PRIMER_DEPTH = 1_000;

/** Out-of-sight props that draw with a set of materials; `release` drops what binds them. */
export interface WarmBatch {
  readonly parts: readonly Object3D[];
  release(): void;
}

/** The table stage; `renderer` is the live one, which a device-loss rebuild or fallback swaps. */
export interface WarmStage {
  readonly scene: Object3D;
  readonly renderer?: object;
  onFrame(listener: (deltaSeconds: number) => void): () => void;
}

/** The unbox: its props to draw, and its own primer, which then finds every program built. */
export interface WarmUnbox {
  warmParts(): WarmBatch;
  prime(): void;
}

export interface CrateWarmup {
  /** True while a warm-up is drawing its props. */
  readonly warming: boolean;
  dispose(): void;
}

/**
 * Links the unbox's programs in the frames after the table turns playable, ahead of the scripted
 * first crate at drop 12, so neither the crate's arrival nor its unbox stalls on a link.
 *
 * On WebGL2 every program link blocks the main thread, and on SwiftShader the unbox's seven in one
 * frame held up a tap for 1.7 s, so the props draw out of sight one per frame. The next one joins
 * as soon as the frame that linked the one before has issued its draw calls, with no idle wait in
 * between: waiting on an idle slot cost a frame per prop, and under load the seven then ran past
 * the drop-12 crate. Expected finish: seven frames plus the link time, on SwiftShader about
 * 7 x (0.4 s link + 0.2 s frame), so roughly 4 s after playable, and well under 1 s on a phone
 * GPU. The drop-12 crate (00-VISION: first Vault Crate within 45 s) landed 4.9 to 8.4 s after
 * playable in seeded SwiftShader runs tapping as fast as the FTUE allows.
 *
 * The boot's playable mark (`markBoot('playable')` in main.ts) is looked for each frame until it is
 * down, so the warm-up never moves it. Once every prop has drawn, the unbox's own primer starts
 * and finds each program built. A renderer swap after playable runs the warm-up again, on the new
 * renderer.
 */
export function bindCrateWarmup(stage: WarmStage, unbox: WarmUnbox): CrateWarmup {
  let renderer: unknown = unbox;
  let batch: WarmBatch | null = null;
  let index = 0;
  let current: Object3D | undefined;
  const stop = (): void => {
    current?.removeFromParent();
    batch?.release();
    batch = null;
  };
  const next = (): void => {
    if (!batch) return;
    current = batch.parts[index++];
    if (current) {
      stage.scene.add(current);
      return;
    }
    stop();
    unbox.prime();
  };
  const run = (): void => {
    stop();
    renderer = stage.renderer;
    batch = unbox.warmParts();
    index = 0;
    for (const part of batch.parts) {
      part.frustumCulled = false;
      part.position.y = -PRIMER_DEPTH;
      part.onAfterRender = () => {
        if (part !== current) return;
        current = undefined;
        // Leaves after the draw call returns, so the render list being walked stays intact.
        queueMicrotask(() => {
          part.removeFromParent();
          next();
        });
      };
    }
    next();
  };
  const off = stage.onFrame(() => {
    const due =
      renderer === unbox
        ? performance.getEntriesByName('coinposh:boot:playable')[0] !== undefined
        : stage.renderer !== renderer;
    if (due) run();
  });
  return {
    get warming() {
      return batch !== null;
    },
    dispose() {
      off();
      stop();
    },
  };
}

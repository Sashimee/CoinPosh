import { Group, type Object3D } from 'three/webgpu';

/** The boot's own mark (`markBoot('playable')` in main.ts), also read by e2e/boot.perf.ts. */
export const BOOT_PLAYABLE_MARK = 'coinposh:boot:playable';

/**
 * The primer draws each part this far below the table, where every triangle is clipped: the GPU
 * builds the pipelines while nothing can be seen.
 */
const PRIMER_DEPTH = 1_000;
/** An idle slot is waited for at most this long, so a busy table cannot starve the warm-up. */
const IDLE_TIMEOUT_MS = 120;

/** Out-of-sight props that draw with a set of materials; `release` drops what binds them. */
export interface WarmBatch {
  readonly parts: readonly Object3D[];
  release(): void;
}

export type Schedule = (task: () => void) => void;

/**
 * Runs `task` once the frame being drawn has finished, in an idle slot where the host has them:
 * never inside a render, and never stacked on the frame a tap is being handled in.
 */
export const afterIdle: Schedule = (task) => {
  if (typeof globalThis.requestIdleCallback === 'function') {
    globalThis.requestIdleCallback(task, { timeout: IDLE_TIMEOUT_MS });
  } else {
    setTimeout(task, 0);
  }
};

/**
 * Calls `start` once the boot has marked the table playable, at once if it already has. Returns
 * the cancel. A host without the Performance Timeline never marks a boot, so it never starts.
 */
export function onBootPlayable(start: () => void, perf: Performance = performance): () => void {
  let live = true;
  const go = (): void => {
    if (!live) return;
    live = false;
    start();
  };
  if (perf.getEntriesByName(BOOT_PLAYABLE_MARK, 'mark').length > 0) {
    queueMicrotask(go);
    return () => {
      live = false;
    };
  }
  if (typeof PerformanceObserver !== 'function') return () => undefined;
  const observer = new PerformanceObserver((list) => {
    if (list.getEntriesByName(BOOT_PLAYABLE_MARK, 'mark').length === 0) return;
    observer.disconnect();
    go();
  });
  observer.observe({ type: 'mark', buffered: true });
  return () => {
    live = false;
    observer.disconnect();
  };
}

/**
 * Draws a batch of props out of sight one at a time, each joining after the frame that drew the
 * one before, then takes them out of the scene again. On WebGL2 every program link blocks the
 * main thread, and on SwiftShader the unbox's seven in one frame held up a tap for 1.7 s, so no
 * frame here links more than one. A new batch replaces the one in flight, which is how a renderer
 * swap gets every program linked again on the new context.
 */
export class FramePrimer {
  private readonly root = new Group();
  private readonly schedule: Schedule;
  private batch: WarmBatch | null = null;
  private waiting: Object3D[] = [];
  private done: (() => void) | null = null;
  private generation = 0;

  constructor(parent: Object3D, schedule: Schedule = afterIdle) {
    this.schedule = schedule;
    this.root.name = 'crate-primer';
    this.root.position.y = -PRIMER_DEPTH;
    parent.add(this.root);
  }

  /** True while a batch has parts left to draw. */
  get running(): boolean {
    return this.batch !== null;
  }

  /** Starts drawing `batch`, dropping any batch still in flight; `done` runs once it is all drawn. */
  run(batch: WarmBatch, done?: () => void): void {
    this.stop();
    const generation = ++this.generation;
    this.batch = batch;
    this.done = done ?? null;
    this.waiting = [...batch.parts];
    for (const part of batch.parts) {
      part.frustumCulled = false;
      part.onAfterRender = () => {
        if (generation !== this.generation || this.waiting[0] !== part) return;
        this.waiting.shift();
        // Moves on after the draw call returns, so the render list being walked stays intact.
        this.schedule(() => {
          if (generation === this.generation) this.next();
        });
      };
    }
    this.next();
  }

  /** Takes the batch in flight out of the scene without finishing it. */
  stop(): void {
    this.generation += 1;
    this.root.clear();
    this.waiting = [];
    this.done = null;
    const batch = this.batch;
    this.batch = null;
    batch?.release();
  }

  dispose(): void {
    this.stop();
    this.root.removeFromParent();
  }

  private next(): void {
    this.root.clear();
    const part = this.waiting[0];
    if (part) {
      this.root.add(part);
      return;
    }
    const done = this.done;
    this.done = null;
    const batch = this.batch;
    this.batch = null;
    batch?.release();
    done?.();
  }
}

export interface CrateWarmupOptions {
  /** `renderer` is the live one: a device-loss rebuild or backend fallback swaps it. */
  readonly stage: {
    readonly renderer?: object;
    onFrame(listener: (deltaSeconds: number) => void): () => void;
  };
  readonly primer: Pick<FramePrimer, 'run' | 'running' | 'dispose'>;
  /** The unbox props, one per material, for the first warm-up and every one after a swap. */
  readonly unbox: () => WarmBatch;
  /** The table crate's meshes; it already links in the boot frames, so only a swap needs them. */
  readonly table: () => WarmBatch;
  /** Called once the first warm-up has drawn: the unbox's own primer then finds it all built. */
  readonly warmed: () => void;
  /** Starts the warm-up; defaults to the boot's playable mark, so it never moves that mark. */
  readonly playable?: (start: () => void) => () => void;
}

export interface CrateWarmup {
  /** True while a warm-up is drawing its props. */
  readonly warming: boolean;
  /** True once the first warm-up has drawn all of its props. */
  readonly warmed: boolean;
  dispose(): void;
}

function joined(...batches: readonly WarmBatch[]): WarmBatch {
  return {
    parts: batches.flatMap((batch) => batch.parts),
    release() {
      for (const batch of batches) batch.release();
    },
  };
}

/**
 * Links the crate's programs in the seconds after the table turns playable, well before the
 * scripted first crate lands at drop 12, so neither the crate's arrival nor its unbox stalls on a
 * link. The playable mark itself is left alone. After a renderer swap every program is linked
 * again on the new renderer, table crate included, as soon as the swap is adopted.
 */
export function bindCrateWarmup(options: CrateWarmupOptions): CrateWarmup {
  let started = false;
  let warmed = false;
  let renderer = options.stage.renderer;
  const cancelPlayable = (options.playable ?? onBootPlayable)(() => {
    started = true;
    options.primer.run(options.unbox(), () => {
      warmed = true;
      options.warmed();
    });
  });
  const stopFrame = options.stage.onFrame(() => {
    const live = options.stage.renderer;
    if (live === renderer) return;
    renderer = live;
    if (!started) return;
    options.primer.run(joined(options.unbox(), options.table()), () => {
      if (warmed) return;
      warmed = true;
      options.warmed();
    });
  });
  return {
    get warming() {
      return options.primer.running;
    },
    get warmed() {
      return warmed;
    },
    dispose() {
      cancelPlayable();
      stopFrame();
      options.primer.dispose();
    },
  };
}

import {
  BufferGeometry,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  PerspectiveCamera,
  Scene,
  type Object3D,
} from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BOOT_PLAYABLE_MARK,
  bindCrateWarmup,
  FramePrimer,
  onBootPlayable,
  type Schedule,
  type WarmBatch,
} from './warmup.ts';

/** Idle slots that run only when the test says the frame has finished. */
function idleQueue(): { schedule: Schedule; flush(): void; readonly size: number } {
  const tasks: (() => void)[] = [];
  return {
    schedule: (task) => tasks.push(task),
    flush() {
      for (const task of tasks.splice(0)) task();
    },
    get size() {
      return tasks.length;
    },
  };
}

function primerOf(parent: Object3D): Object3D {
  const primer = parent.getObjectByName('crate-primer');
  if (!primer) throw new Error('No crate primer under the parent');
  return primer;
}

/** What the renderer does to a drawn object once its draw call is issued. */
function draw(part: Object3D): void {
  part.onAfterRender(
    null as never,
    new Scene(),
    new PerspectiveCamera(),
    new BufferGeometry(),
    new MeshBasicNodeMaterial(),
    new Group(),
  );
}

/** One frame: every part in the primer draws, then the frame ends and idle slots run. */
function frame(parent: Object3D, idle: { flush(): void }): string[] {
  const drawn = [...primerOf(parent).children];
  for (const part of drawn) draw(part);
  idle.flush();
  return drawn.map((part) => part.name);
}

function batch(...names: string[]): WarmBatch & { released: number } {
  const parts = names.map((name) => {
    const mesh = new Mesh();
    mesh.name = name;
    return mesh;
  });
  const result = {
    parts,
    released: 0,
    release() {
      result.released += 1;
    },
  };
  return result;
}

describe('FramePrimer', () => {
  it('draws one part per frame, out of sight and unculled, then leaves the scene', () => {
    const parent = new Group();
    const idle = idleQueue();
    const primer = new FramePrimer(parent, idle.schedule);
    const parts = batch('lacquer', 'gold', 'flare');
    const done = vi.fn();
    primer.run(parts, done);

    expect(primerOf(parent).position.y).toBeLessThan(-100);
    expect(parts.parts.every((part) => !part.frustumCulled)).toBe(true);
    expect(primer.running).toBe(true);
    expect(frame(parent, idle)).toEqual(['lacquer']);
    expect(frame(parent, idle)).toEqual(['gold']);
    expect(done).not.toHaveBeenCalled();
    expect(frame(parent, idle)).toEqual(['flare']);

    expect(done).toHaveBeenCalledOnce();
    expect(parts.released).toBe(1);
    expect(primer.running).toBe(false);
    expect(primerOf(parent).children).toEqual([]);
  });

  it('moves on only after the frame that drew a part, never inside its render', () => {
    const parent = new Group();
    const idle = idleQueue();
    const primer = new FramePrimer(parent, idle.schedule);
    primer.run(batch('lacquer', 'gold'));
    const [first] = primerOf(parent).children;
    if (!first) throw new Error('The primer drew nothing');
    draw(first);
    draw(first);

    expect(primerOf(parent).children.map((part) => part.name)).toEqual(['lacquer']);
    expect(idle.size).toBe(1);
    idle.flush();
    expect(primerOf(parent).children.map((part) => part.name)).toEqual(['gold']);
  });

  it('drops the batch in flight for a new one, releasing it and never finishing it', () => {
    const parent = new Group();
    const idle = idleQueue();
    const primer = new FramePrimer(parent, idle.schedule);
    const old = batch('lacquer', 'gold');
    const oldDone = vi.fn();
    primer.run(old, oldDone);
    const [stale] = primerOf(parent).children;
    if (!stale) throw new Error('The primer drew nothing');
    draw(stale);
    const fresh = batch('velvet');
    primer.run(fresh);
    idle.flush();

    expect(old.released).toBe(1);
    expect(primerOf(parent).children.map((part) => part.name)).toEqual(['velvet']);
    frame(parent, idle);
    expect(oldDone).not.toHaveBeenCalled();
    expect(fresh.released).toBe(1);
  });

  it('finishes an empty batch at once and leaves the scene on dispose', () => {
    const parent = new Group();
    const primer = new FramePrimer(parent, idleQueue().schedule);
    const done = vi.fn();
    primer.run(batch(), done);
    expect(done).toHaveBeenCalledOnce();
    primer.run(batch('lacquer'));
    primer.dispose();
    expect(parent.getObjectByName('crate-primer')).toBeUndefined();
  });
});

describe('onBootPlayable', () => {
  afterEach(() => {
    performance.clearMarks(BOOT_PLAYABLE_MARK);
  });

  it('starts once the boot marks the table playable, not before', async () => {
    const start = vi.fn();
    onBootPlayable(start);
    performance.mark('coinposh:boot:laid');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(start).not.toHaveBeenCalled();
    performance.mark(BOOT_PLAYABLE_MARK);
    await vi.waitFor(() => {
      expect(start).toHaveBeenCalledOnce();
    });
    performance.clearMarks('coinposh:boot:laid');
  });

  it('starts at once when the mark is already down, and never after a cancel', async () => {
    performance.mark(BOOT_PLAYABLE_MARK);
    const start = vi.fn();
    const cancelled = vi.fn();
    onBootPlayable(start);
    onBootPlayable(cancelled)();
    await Promise.resolve();
    expect(start).toHaveBeenCalledOnce();
    expect(cancelled).not.toHaveBeenCalled();
  });
});

describe('bindCrateWarmup', () => {
  function rig() {
    const listeners = new Set<(deltaSeconds: number) => void>();
    const stage = {
      renderer: {} as object,
      onFrame(listener: (deltaSeconds: number) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const runs: { names: string[]; done: (() => void) | undefined }[] = [];
    let running = false;
    const primer = {
      get running() {
        return running;
      },
      run(next: WarmBatch, done?: () => void) {
        running = true;
        runs.push({
          names: next.parts.map((part) => part.name),
          done: () => {
            running = false;
            done?.();
          },
        });
      },
      dispose: vi.fn(),
    };
    let play: (() => void) | null = null;
    const cancel = vi.fn();
    const warmed = vi.fn();
    const warmup = bindCrateWarmup({
      stage,
      primer,
      unbox: () => batch('lacquer', 'flare'),
      table: () => batch('crate-body'),
      warmed,
      playable: (start) => {
        play = start;
        return cancel;
      },
    });
    const tick = () => {
      for (const listener of listeners) listener(1 / 60);
    };
    return {
      warmup,
      stage,
      runs,
      primer,
      warmed,
      cancel,
      listeners,
      tick,
      playable: () => play?.(),
    };
  }

  it('waits for playable, then warms the unbox and reports it once drawn', () => {
    const { warmup, runs, warmed, tick, playable } = rig();
    tick();
    expect(runs).toEqual([]);
    playable();

    expect(runs.map((run) => run.names)).toEqual([['lacquer', 'flare']]);
    expect(warmup.warming).toBe(true);
    expect(warmup.warmed).toBe(false);
    runs[0]?.done?.();
    expect(warmed).toHaveBeenCalledOnce();
    expect(warmup.warmed).toBe(true);
    expect(warmup.warming).toBe(false);
  });

  it('links everything again, table crate included, after a renderer swap', () => {
    const { stage, runs, warmed, tick, playable } = rig();
    playable();
    runs[0]?.done?.();
    tick();
    expect(runs).toHaveLength(1);

    stage.renderer = {};
    tick();
    tick();
    expect(runs.map((run) => run.names)).toEqual([
      ['lacquer', 'flare'],
      ['lacquer', 'flare', 'crate-body'],
    ]);
    runs[1]?.done?.();
    expect(warmed).toHaveBeenCalledOnce();
  });

  it('leaves a swap before playable to the boot frames, which draw the standby crate', () => {
    const { stage, runs, tick, playable } = rig();
    stage.renderer = {};
    tick();
    expect(runs).toEqual([]);
    playable();
    expect(runs.map((run) => run.names)).toEqual([['lacquer', 'flare']]);
  });

  it('reports warmed from a swap warm-up that replaced the first one', () => {
    const { stage, runs, warmed, tick, playable } = rig();
    playable();
    stage.renderer = {};
    tick();
    runs[1]?.done?.();
    expect(warmed).toHaveBeenCalledOnce();
  });

  it('stops listening and drops the primer on dispose', () => {
    const { warmup, cancel, primer, listeners } = rig();
    warmup.dispose();
    expect(cancel).toHaveBeenCalledOnce();
    expect(primer.dispose).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
  });
});

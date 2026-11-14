import type { Rarity } from '@coinposh/shared';
import { Group, InstancedMesh, Matrix4, Mesh, Sprite, Vector3, type Material } from 'three/webgpu';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POP_POINT, TRAY_REST } from './layout.ts';
import {
  createGachaMachine,
  PILE_COUNT,
  type GachaEvent,
  type GachaMachineOptions,
  type GachaTicker,
} from './machine.ts';
import { CRANK_DETENTS, DISPENSE, DISPENSE_REDUCED, POP, POP_REDUCED } from './motion.ts';

const FRAME_MS = 1000 / 60;

interface Harness {
  readonly ticker: GachaTicker;
  readonly events: GachaEvent[];
  /** Frames scheduled and not yet run. */
  pending(): number;
  frames(): number;
}

function harness(): Harness {
  let pending = 0;
  let frames = 0;
  const events: GachaEvent[] = [];
  return {
    events,
    pending: () => pending,
    frames: () => frames,
    ticker: {
      now: () => Date.now(),
      request: (frame) => {
        pending++;
        return setTimeout(() => {
          pending--;
          frames++;
          frame();
        }, FRAME_MS);
      },
      cancel: (handle) => {
        pending--;
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
    },
  };
}

function machineWith(options: Partial<GachaMachineOptions> = {}) {
  const h = harness();
  const machine = createGachaMachine({
    ticker: h.ticker,
    onEvent: (event) => h.events.push(event),
    ...options,
  });
  return { h, machine };
}

function byName<T>(root: Group, name: string, type: abstract new (...args: never[]) => T): T {
  const node = root.getObjectByName(name);
  if (!(node instanceof type)) throw new Error(`gacha machine has no ${name}`);
  return node;
}

/** Settles the promise, failing the test if it is still pending after `ms` of fake time. */
async function within(promise: Promise<void>, ms: number): Promise<void> {
  let done = false;
  void promise.then(() => (done = true));
  await vi.advanceTimersByTimeAsync(ms);
  expect(done).toBe(true);
  await promise;
}

async function stillPending(promise: Promise<void>, ms: number): Promise<void> {
  let done = false;
  void promise.then(() => (done = true));
  await vi.advanceTimersByTimeAsync(ms);
  expect(done).toBe(false);
}

const kinds = (events: readonly GachaEvent[]) => events.map((event) => event.kind);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createGachaMachine', () => {
  it('builds the machine in seven draws whatever the pile holds', () => {
    const { machine } = machineWith();
    let draws = 0;
    machine.object3d.traverse((node) => {
      if (node instanceof Mesh || node instanceof Sprite) draws++;
    });
    expect(draws).toBe(7);
    const pile = byName(machine.object3d, 'gacha-pile', InstancedMesh);
    expect(pile.count).toBe(PILE_COUNT.high);
    machine.dispose();
  });

  it('sheds capsules on the low profile', () => {
    const { machine } = machineWith({ quality: 'low' });
    expect(byName(machine.object3d, 'gacha-pile', InstancedMesh).count).toBe(PILE_COUNT.low);
    machine.dispose();
  });

  it('shares one material between the cabinet and the crank', () => {
    const { machine } = machineWith();
    const body = byName(machine.object3d, 'gacha-body', Mesh);
    const crank = byName(machine.object3d, 'gacha-crank', Mesh);
    expect(crank.material).toBe(body.material);
    machine.dispose();
  });

  it('starts with an empty tray and schedules no frames while idle', async () => {
    const { h, machine } = machineWith();
    expect(byName(machine.object3d, 'gacha-capsule', Group).visible).toBe(false);
    expect(byName(machine.object3d, 'gacha-glow', Sprite).visible).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.frames()).toBe(0);
    machine.dispose();
  });
});

describe('crank', () => {
  it('turns the handle, clicks once per detent and then stops ticking', async () => {
    const { h, machine } = machineWith();
    const crank = byName(machine.object3d, 'gacha-crank', Mesh);
    machine.crank(0.5);
    await vi.advanceTimersByTimeAsync(3000);
    expect(crank.rotation.z).toBeCloseTo(-Math.PI, 2);
    const detents = h.events.flatMap((event) => (event.kind === 'click' ? [event.detent] : []));
    expect(detents).toEqual([1, 2, 3, 4]);
    expect(h.pending()).toBe(0);
    const frames = h.frames();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.frames()).toBe(frames);
    machine.dispose();
  });

  it('springs past each tooth on full motion', async () => {
    const { machine } = machineWith();
    const crank = byName(machine.object3d, 'gacha-crank', Mesh);
    machine.crank(1 / CRANK_DETENTS);
    let furthest = 0;
    for (let i = 0; i < 60; i++) {
      await vi.advanceTimersByTimeAsync(FRAME_MS);
      furthest = Math.max(furthest, -crank.rotation.z);
    }
    expect(furthest).toBeGreaterThan((Math.PI * 2) / CRANK_DETENTS);
    machine.dispose();
  });

  it('follows the hand without overshoot on reduced motion', async () => {
    const { machine } = machineWith({ reducedMotion: true });
    const crank = byName(machine.object3d, 'gacha-crank', Mesh);
    machine.crank(0.25);
    let furthest = 0;
    for (let i = 0; i < 90; i++) {
      await vi.advanceTimersByTimeAsync(FRAME_MS);
      furthest = Math.max(furthest, -crank.rotation.z);
    }
    expect(furthest).toBeLessThanOrEqual(Math.PI / 2 + 1e-6);
    expect(-crank.rotation.z).toBeCloseTo(Math.PI / 2, 3);
    machine.dispose();
  });

  it('clamps progress to one turn and rejects non-numbers', () => {
    const { machine } = machineWith();
    expect(() => {
      machine.crank(Number.NaN);
    }).toThrow(/finite/);
    machine.crank(3);
    machine.dispose();
  });
});

describe('dispense', () => {
  it('drops, knocks down the chute, lands in the tray and then resolves', async () => {
    const { h, machine } = machineWith();
    const capsule = byName(machine.object3d, 'gacha-capsule', Group);
    const done = machine.dispense('rare');
    expect(capsule.visible).toBe(true);
    await stillPending(done, (DISPENSE.settle - 0.1) * 1000);
    await within(done, 300);
    expect(capsule.position.distanceTo(TRAY_REST)).toBeLessThan(1e-6);
    expect(kinds(h.events)).toEqual(['drop', 'knock', 'knock', 'land', 'land', 'land']);
    machine.dispose();
  });

  it('rolls the capsule along the chute rather than sliding it', async () => {
    const { machine } = machineWith();
    const capsule = byName(machine.object3d, 'gacha-capsule', Group);
    const done = machine.dispense('fine');
    await vi.advanceTimersByTimeAsync(((DISPENSE.drop + DISPENSE.roll) / 2) * 1000);
    expect(capsule.quaternion.w).toBeLessThan(0.999);
    await within(done, 2000);
    machine.dispose();
  });

  it('takes a capsule out of the pile and puts it back on reset', async () => {
    const { machine } = machineWith();
    const pile = byName(machine.object3d, 'gacha-pile', InstancedMesh);
    const matrix = new Matrix4();
    const scale = new Vector3();
    const hiddenCount = (): number => {
      let hidden = 0;
      for (let i = 0; i < pile.count; i++) {
        pile.getMatrixAt(i, matrix);
        scale.setFromMatrixScale(matrix);
        if (scale.x === 0) hidden++;
      }
      return hidden;
    };
    const done = machine.dispense('common');
    expect(hiddenCount()).toBe(1);
    await within(done, 2000);
    machine.reset();
    expect(hiddenCount()).toBe(0);
    machine.dispose();
  });

  it('fades the capsule in on the velvet with no roll on reduced motion', async () => {
    const { h, machine } = machineWith({ reducedMotion: true });
    const capsule = byName(machine.object3d, 'gacha-capsule', Group);
    const done = machine.dispense('legendary');
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(FRAME_MS);
      expect(capsule.position.distanceTo(TRAY_REST)).toBe(0);
      expect(capsule.quaternion.w).toBe(1);
    }
    await within(done, DISPENSE_REDUCED.fade * 1000);
    expect(kinds(h.events)).toEqual(['drop', 'land']);
    machine.dispose();
  });

  it('refuses a second capsule while one is out', async () => {
    const { machine } = machineWith();
    const first = machine.dispense('rare');
    await expect(machine.dispense('rare')).rejects.toThrow(/dispensing/);
    await within(first, 2000);
    await expect(machine.dispense('rare')).rejects.toThrow(/tray/);
    machine.dispose();
  });
});

describe('pop', () => {
  async function inTray(options: Partial<GachaMachineOptions> = {}, rarity: Rarity = 'rare') {
    const setup = machineWith(options);
    await within(setup.machine.dispense(rarity), 2000);
    setup.h.events.length = 0;
    return setup;
  }

  it('lifts, twists twice, bursts and resolves at the settle', async () => {
    const { h, machine } = await inTray();
    const capsule = byName(machine.object3d, 'gacha-capsule', Group);
    const glow = byName(machine.object3d, 'gacha-glow', Sprite);
    const done = machine.pop('legendary');
    await stillPending(done, (POP.settle - 0.1) * 1000);
    await within(done, 300);
    expect(kinds(h.events)).toEqual(['twist', 'twist', 'pop']);
    const pop = h.events[2];
    expect(pop?.kind === 'pop' && pop.rarity).toBe('legendary');
    expect(capsule.position.distanceTo(POP_POINT)).toBeLessThan(1e-6);
    expect(glow.visible).toBe(true);
    const dome = byName(machine.object3d, 'gacha-capsule-dome', Mesh);
    expect(dome.position.y).toBeGreaterThan(0.02);
    machine.dispose();
  });

  it('keeps breathing the open glow until reset, then stops ticking', async () => {
    const { h, machine } = await inTray();
    await within(machine.pop('exquisite'), 2000);
    const frames = h.frames();
    await vi.advanceTimersByTimeAsync(500);
    expect(h.frames()).toBeGreaterThan(frames);
    machine.reset();
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.pending()).toBe(0);
    expect(byName(machine.object3d, 'gacha-glow', Sprite).visible).toBe(false);
    expect(byName(machine.object3d, 'gacha-capsule', Group).visible).toBe(false);
    machine.dispose();
  });

  it('cross-fades straight to the open capsule on reduced motion', async () => {
    const { h, machine } = await inTray({ reducedMotion: true });
    const capsule = byName(machine.object3d, 'gacha-capsule', Group);
    const dome = byName(machine.object3d, 'gacha-capsule-dome', Mesh);
    const done = machine.pop('heirloom');
    await vi.advanceTimersByTimeAsync(POP_REDUCED.out * 500);
    expect(dome.rotation.y).toBe(0);
    await within(done, POP_REDUCED.in * 1000);
    expect(kinds(h.events)).toEqual(['pop']);
    expect(capsule.position.distanceTo(POP_POINT)).toBe(0);
    const spinBefore = dome.rotation.y;
    await vi.advanceTimersByTimeAsync(1000);
    expect(dome.rotation.y).toBe(spinBefore);
    machine.dispose();
  });

  it('needs a capsule in the tray', async () => {
    const { machine } = machineWith();
    await expect(machine.pop('rare')).rejects.toThrow(/dispense\(\) first/);
    const rolling = machine.dispense('rare');
    await expect(machine.pop('rare')).rejects.toThrow(/dispensing/);
    await within(rolling, 2000);
    const popping = machine.pop('rare');
    await expect(machine.pop('rare')).rejects.toThrow(/popping/);
    await within(popping, 2000);
    await expect(machine.pop('rare')).rejects.toThrow(/open/);
    machine.dispose();
  });
});

describe('reset and dispose', () => {
  it('reset settles a running sequence and readies the next dispense', async () => {
    const { machine } = machineWith();
    const crank = byName(machine.object3d, 'gacha-crank', Mesh);
    machine.crank(0.6);
    const rolling = machine.dispense('fine');
    await vi.advanceTimersByTimeAsync(400);
    machine.reset();
    await rolling;
    expect(crank.rotation.z).toBe(0);
    await within(machine.dispense('fine'), 2000);
    machine.dispose();
  });

  it('dispose cancels the pending frame, frees the GPU resources and detaches', async () => {
    const { h, machine } = machineWith();
    const parent = new Group();
    parent.add(machine.object3d);
    const materials = new Set<Material>();
    machine.object3d.traverse((node) => {
      if (node instanceof Mesh || node instanceof Sprite) materials.add(node.material as Material);
    });
    const disposed = vi.fn();
    for (const material of materials) material.addEventListener('dispose', disposed);
    const rolling = machine.dispense('rare');
    machine.crank(0.4);
    machine.dispose();
    await rolling;
    expect(h.pending()).toBe(0);
    expect(machine.object3d.parent).toBeNull();
    expect(disposed).toHaveBeenCalledTimes(materials.size);
    machine.dispose();
    await expect(machine.dispense('rare')).rejects.toThrow(/dispose/);
    await expect(machine.pop('rare')).rejects.toThrow(/dispose/);
    expect(() => {
      machine.crank(0.2);
    }).toThrow(/dispose/);
    expect(() => {
      machine.reset();
    }).toThrow(/dispose/);
  });
});

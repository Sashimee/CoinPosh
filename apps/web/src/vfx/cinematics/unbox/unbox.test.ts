import { RARITIES, type Rarity } from '@coinposh/shared';
import { Group, PerspectiveCamera, Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import type { CameraKickOptions } from '../../camera/cameraKick.ts';
import type { HapticPattern } from '../../haptics.ts';
import type { ContactOptions } from '../../index.ts';
import { UnboxCinematic, type UnboxVfx } from './cinematic.ts';
import {
  burstStyle,
  FULL_UNBOX,
  rayStyle,
  REDUCED_UNBOX,
  UNBOX_JUICE,
  unboxBeats,
  unboxPose,
  type UnboxBeat,
} from './plan.ts';
import { UnboxAssets, UnboxStage } from './stage.ts';

const FRAMING = {
  position: new Vector3(0, 0.5, 0.6),
  target: new Vector3(0, 0, -0.05),
  fov: 40,
};

function fakeVfx() {
  const calls = {
    hitStop: [] as number[],
    kicks: [] as CameraKickOptions[],
    confetti: 0,
    sparks: [] as ContactOptions[],
  };
  const vfx: UnboxVfx = {
    hitStop: (ms) => calls.hitStop.push(ms ?? 0),
    cameraKick: (options) => calls.kicks.push(options),
    confetti: () => ++calls.confetti,
    contactSparks: (_position, options) => calls.sparks.push(options),
  };
  return { vfx, calls };
}

function cinematic(rarity: Rarity, reducedMotion: boolean) {
  const { vfx, calls } = fakeVfx();
  const pulses: HapticPattern[] = [];
  const beats: UnboxBeat[] = [];
  const parent = new Group();
  const assets = new UnboxAssets(parent);
  const camera = new PerspectiveCamera(40, 9 / 16);
  const unbox = new UnboxCinematic({
    parent,
    assets,
    camera,
    framing: () => FRAMING,
    at: new Vector3(0, -0.075, 0.085),
    rarity,
    hero: 'charm',
    reducedMotion,
    vfx,
    haptics: { pulse: (pattern) => pulses.push(pattern) > 0 },
    onBeat: (beat) => beats.push(beat),
  });
  return { unbox, calls, pulses, beats, parent, camera, assets };
}

function play(unbox: UnboxCinematic, seconds: number, fps = 60): void {
  for (let t = 0; t < seconds; t += 1 / fps) unbox.update(1 / fps);
}

describe('unbox timeline', () => {
  it('runs land, three shudders, rays, burst and reveal in order inside the 2.4 s treat', () => {
    const beats = unboxBeats(FULL_UNBOX);
    expect(beats.map((beat) => beat.kind)).toEqual([
      'land',
      'shudder',
      'rays',
      'shudder',
      'shudder',
      'burst',
      'reveal',
    ]);
    expect(beats.filter((beat) => beat.kind === 'shudder').map((beat) => beat.step)).toEqual([
      1, 2, 3,
    ]);
    expect(FULL_UNBOX.revealAtMs).toBeLessThanOrEqual(2_400);
    expect(REDUCED_UNBOX.revealAtMs).toBeLessThan(1_000);
  });

  it('squashes on the landing and builds each shudder stronger than the last', () => {
    const landed = unboxPose(FULL_UNBOX.landMs + 80, FULL_UNBOX, false);
    expect(landed.drop).toBe(1);
    expect(landed.squash).toBeLessThan(1);
    const peaks = FULL_UNBOX.shudderAtMs.map(
      (at) => unboxPose(at + FULL_UNBOX.shudderMs / 2, FULL_UNBOX, false).rumble,
    );
    expect(peaks[0]).toBeLessThan(peaks[1] ?? 0);
    expect(peaks[1]).toBeLessThan(peaks[2] ?? 0);
    const before = unboxPose(FULL_UNBOX.burstAtMs - 1, FULL_UNBOX, false);
    const after = unboxPose(FULL_UNBOX.burstAtMs + 60, FULL_UNBOX, false);
    expect(before.lidOpen).toBe(0);
    expect(before.rays).toBeGreaterThan(0.5);
    expect(after.burst).toBeCloseTo(1);
    expect(unboxPose(FULL_UNBOX.revealAtMs, FULL_UNBOX, false).pedestal).toBeGreaterThan(0.9);
  });

  it('keeps the reduced variant still: no fall, squash, lid shake, dolly or spin', () => {
    for (let ms = 0; ms <= REDUCED_UNBOX.revealAtMs + 500; ms += 20) {
      const pose = unboxPose(ms, REDUCED_UNBOX, true);
      expect(pose.drop).toBe(1);
      expect(pose.squash).toBe(1);
      expect(pose.lidShake).toBe(0);
      expect(pose.lidLift).toBe(0);
      expect(pose.dolly).toBe(0);
      expect(pose.itemSpin).toBe(0);
    }
    const shudder = REDUCED_UNBOX.shudderAtMs[2] + REDUCED_UNBOX.shudderMs / 2;
    expect(unboxPose(shudder, REDUCED_UNBOX, true).rumble).toBeGreaterThan(0);
    expect(unboxPose(REDUCED_UNBOX.revealAtMs, REDUCED_UNBOX, true).pedestal).toBe(1);
  });

  it('flies the item out and hands the camera back after Collect', () => {
    const held = unboxPose(5_000, FULL_UNBOX, false);
    expect(held.dolly).toBe(1);
    const gone = unboxPose(5_000, FULL_UNBOX, false, FULL_UNBOX.flyMs);
    expect(gone.fly).toBe(1);
    expect(gone.dolly).toBe(0);
    expect(gone.rays).toBe(0);
  });
});

describe('rarity god-rays and burst', () => {
  it('escalate with rarity, in the rarity colour', () => {
    const styles = RARITIES.map((rarity) => rayStyle(rarity));
    for (let i = 1; i < styles.length; i++) {
      expect(styles[i]?.count).toBeGreaterThan(styles[i - 1]?.count ?? 0);
      expect(styles[i]?.intensity).toBeGreaterThan(styles[i - 1]?.intensity ?? 0);
    }
    expect(rayStyle('rare').colors).toEqual(['#3B82F6']);
    expect(rayStyle('heirloom').colors.length).toBeGreaterThan(1);
  });

  it('saves hit-stop for rare and up and confetti for legendary and up', () => {
    expect(burstStyle('common').hitStopMs).toBe(0);
    expect(burstStyle('fine').hitStopMs).toBe(0);
    expect(burstStyle('rare').hitStopMs).toBeGreaterThan(0);
    expect(burstStyle('heirloom').hitStopMs).toBeLessThanOrEqual(80);
    expect(burstStyle('exquisite').confetti).toBe(false);
    expect(burstStyle('legendary').confetti).toBe(true);
    expect(burstStyle('heirloom').shake).toBeGreaterThan(burstStyle('common').shake);
  });

  it('meets the juice bar (at least 4) without counting the sound', () => {
    expect(UNBOX_JUICE.items.filter((item) => item !== 'sound').length).toBeGreaterThanOrEqual(4);
    expect(new Set(UNBOX_JUICE.items).size).toBe(UNBOX_JUICE.items.length);
    expect(UNBOX_JUICE.reduced.length).toBeGreaterThan(0);
  });
});

describe('UnboxStage', () => {
  it('fans one ray per style slot and lights them only once they leak', () => {
    const stage = new UnboxStage('legendary', 'coins', new UnboxAssets(new Group()));
    expect(stage.rayCount).toBe(rayStyle('legendary').count);
    stage.apply(unboxPose(0, FULL_UNBOX, false));
    expect(stage.rayStrength).toBe(0);
    stage.apply(unboxPose(FULL_UNBOX.burstAtMs + 30, FULL_UNBOX, false));
    expect(stage.rayStrength).toBeGreaterThan(0);
    expect(stage.lightIntensity).toBeGreaterThan(0);
    expect(stage.lidHeight).toBeGreaterThan(0.02);
    stage.dispose();
  });

  it('squashes the crate on the landing and raises the pedestal after the burst', () => {
    const stage = new UnboxStage('fine', 'charm', new UnboxAssets(new Group()));
    stage.apply(unboxPose(FULL_UNBOX.landMs + 100, FULL_UNBOX, false));
    expect(stage.crateScaleY).toBeLessThan(1);
    expect(stage.pedestalScale).toBeLessThan(0.01);
    stage.apply(unboxPose(FULL_UNBOX.revealAtMs, FULL_UNBOX, false));
    expect(stage.pedestalScale).toBeGreaterThan(0.9);
    stage.dispose();
  });
});

describe('UnboxCinematic', () => {
  it('plays every beat once with its juice, then holds on the reveal until Collect', () => {
    const { unbox, calls, pulses, beats, parent, assets } = cinematic('legendary', false);
    expect(parent.children).toEqual([assets.light, unbox.stage.root]);
    play(unbox, 3);
    expect(beats.map((beat) => beat.kind)).toEqual(unboxBeats(FULL_UNBOX).map((b) => b.kind));
    expect(unbox.revealed).toBe(true);
    expect(calls.hitStop).toEqual([burstStyle('legendary').hitStopMs]);
    expect(calls.confetti).toBe(1);
    expect(calls.kicks.length).toBe(4);
    expect(calls.sparks.map((spark) => spark.surface)).toEqual(['wood', 'metal']);
    expect(pulses).toEqual(['tap', 'tick', 'tick', 'tap', burstStyle('legendary').haptic]);
    play(unbox, 5);
    expect(unbox.done).toBe(false);
    unbox.collect();
    play(unbox, FULL_UNBOX.flyMs / 1000 + 0.05);
    expect(unbox.done).toBe(true);
    unbox.dispose();
    expect(parent.children).toEqual([assets.light]);
    expect(assets.light.intensity).toBe(0);
  });

  it('reuses one light, geometry and material set across unboxes, so the light count never changes', () => {
    const parent = new Group();
    const assets = new UnboxAssets(parent);
    const camera = new PerspectiveCamera(40, 9 / 16);
    const materials = new Set<unknown>();
    const geometries = new Set<unknown>();
    for (const rarity of ['common', 'heirloom', 'rare'] as const) {
      const unbox = new UnboxCinematic({
        parent,
        assets,
        camera,
        framing: () => FRAMING,
        at: new Vector3(0.02, -0.075, 0.085),
        rarity,
        hero: rarity === 'rare' ? 'pearls' : 'coins',
        reducedMotion: false,
      });
      expect(parent.children.filter((child) => child === assets.light)).toHaveLength(1);
      play(unbox, 2);
      expect(assets.light.intensity).toBeGreaterThan(0);
      expect(assets.light.position.x).toBeCloseTo(0.02);
      unbox.stage.root.traverse((object) => {
        if (!('material' in object) || !('geometry' in object)) return;
        materials.add(object.material);
        geometries.add(object.geometry);
      });
      unbox.collect();
      play(unbox, FULL_UNBOX.flyMs / 1000 + 0.05);
      unbox.dispose();
      expect(assets.light.intensity).toBe(0);
      expect(parent.children).toEqual([assets.light]);
    }
    const shared = [
      assets.lacquer,
      assets.gold,
      assets.velvet,
      assets.seamMaterial,
      assets.heroMaterial,
      assets.rayMaterial,
    ];
    expect([...materials].every((material) => shared.includes(material as never))).toBe(true);
    expect(geometries.size).toBeLessThanOrEqual(10);
    assets.dispose();
    expect(parent.children).toHaveLength(0);
  });

  it('dollies toward the crate and gives the venue framing back on dispose', () => {
    const { unbox, camera } = cinematic('rare', false);
    play(unbox, 1.5);
    expect(camera.position.distanceTo(FRAMING.position)).toBeGreaterThan(0.05);
    unbox.dispose();
    expect(camera.position.distanceTo(FRAMING.position)).toBeLessThan(1e-9);
  });

  it('jumps to the reveal on skip without hit-stop or shake, firing each skipped beat once', () => {
    const { unbox, calls, beats } = cinematic('heirloom', false);
    unbox.update(0.1);
    unbox.skip();
    unbox.skip();
    expect(unbox.revealed).toBe(true);
    expect(beats.map((beat) => beat.kind)).toEqual(unboxBeats(FULL_UNBOX).map((b) => b.kind));
    expect(calls.hitStop).toEqual([]);
    expect(calls.kicks).toEqual([]);
    expect(calls.confetti).toBe(1);
    unbox.dispose();
  });

  it('plays the reduced variant with no camera shake and no dolly', () => {
    const { unbox, calls, camera } = cinematic('exquisite', true);
    play(unbox, 1.2);
    expect(unbox.revealed).toBe(true);
    expect(
      calls.kicks.filter((kick) => kick.shake !== undefined && kick.fov === undefined),
    ).toEqual([]);
    expect(camera.position.distanceTo(FRAMING.position)).toBeLessThan(1e-9);
    unbox.collect();
    unbox.update(0);
    expect(unbox.done).toBe(true);
    unbox.dispose();
  });

  it('ignores bad deltas and calls after dispose', () => {
    const { unbox } = cinematic('common', false);
    unbox.update(Number.NaN);
    unbox.update(-5);
    expect(unbox.elapsed).toBe(0);
    unbox.dispose();
    unbox.update(1);
    unbox.collect();
    expect(unbox.elapsed).toBe(0);
  });
});

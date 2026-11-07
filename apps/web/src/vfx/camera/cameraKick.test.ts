import { PerspectiveCamera, Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { createRng } from '../../audio/rng.ts';
import { CameraKick } from './cameraKick.ts';

function camera(): PerspectiveCamera {
  const c = new PerspectiveCamera(40, 9 / 16, 0.01, 50);
  c.position.set(0, 0.6, 0.9);
  c.lookAt(0, 0, -0.1);
  c.updateMatrixWorld();
  return c;
}

function simulate(
  kick: CameraKick,
  cam: PerspectiveCamera,
  seconds: number,
  onFrame?: () => void,
): void {
  for (let t = 0; t < seconds; t += 1 / 60) {
    kick.update(1 / 60, cam);
    onFrame?.();
  }
}

describe('CameraKick', () => {
  it('shakes and widens the FOV after an impact, then returns exactly to the base', () => {
    const cam = camera();
    const base = {
      position: cam.position.clone(),
      quaternion: cam.quaternion.clone(),
      fov: cam.fov,
    };
    const kick = new CameraKick(createRng(1));
    kick.kick({ shake: 0.5, fov: 2.4 });
    let maxFov = 0;
    let maxAngle = 0;
    simulate(kick, cam, 0.3, () => {
      maxFov = Math.max(maxFov, cam.fov - base.fov);
      maxAngle = Math.max(maxAngle, cam.quaternion.angleTo(base.quaternion));
    });
    expect(maxFov).toBeGreaterThan(1.5);
    expect(maxFov).toBeLessThan(4);
    expect(maxAngle).toBeGreaterThan(0.001);
    simulate(kick, cam, 2);
    expect(kick.active).toBe(false);
    expect(cam.position.distanceTo(base.position)).toBeLessThan(1e-9);
    expect(cam.quaternion.angleTo(base.quaternion)).toBeLessThan(1e-6);
    expect(cam.fov).toBe(base.fov);
  });

  it('adopts an outside camera move as its new base instead of fighting it', () => {
    const cam = camera();
    const kick = new CameraKick(createRng(2));
    kick.kick({ shake: 0.6, dolly: 0.01 });
    simulate(kick, cam, 0.1);
    cam.position.set(0.2, 0.7, 1.1);
    cam.fov = 50;
    const moved = cam.position.clone();
    simulate(kick, cam, 2.5);
    expect(cam.position.distanceTo(moved)).toBeLessThan(1e-9);
    expect(cam.fov).toBe(50);
  });

  it('does nothing under reduced motion', () => {
    const cam = camera();
    const before = cam.position.clone();
    const kick = new CameraKick(createRng(3));
    kick.reducedMotion = true;
    kick.kick({ shake: 1, fov: 5, dolly: 0.05 });
    expect(kick.active).toBe(false);
    simulate(kick, cam, 0.2);
    expect(cam.position.equals(before)).toBe(true);
  });

  it('caps trauma at 1 and rejects invalid kicks', () => {
    const kick = new CameraKick(createRng(4));
    kick.kick({ shake: 0.8 });
    kick.kick({ shake: 0.8 });
    expect(kick.shakeAmount).toBe(1);
    expect(() => {
      kick.kick({ shake: -0.1 });
    }).toThrow(RangeError);
    expect(() => {
      kick.kick({ fov: Number.NaN });
    }).toThrow(RangeError);
  });

  it('is deterministic for a given seed', () => {
    const trace = (seed: number): number[] => {
      const cam = camera();
      const kick = new CameraKick(createRng(seed));
      kick.kick({ shake: 0.5 });
      const out: number[] = [];
      simulate(kick, cam, 0.2, () => out.push(cam.quaternion.x));
      return out;
    };
    expect(trace(7)).toEqual(trace(7));
    expect(trace(7)).not.toEqual(trace(8));
  });

  it('dolly pushes along the view direction', () => {
    const cam = camera();
    const forward = new Vector3();
    cam.getWorldDirection(forward);
    const start = cam.position.clone();
    const kick = new CameraKick(createRng(5));
    kick.kick({ dolly: 0.01 });
    let best = 0;
    simulate(kick, cam, 0.15, () => {
      best = Math.max(best, cam.position.clone().sub(start).dot(forward));
    });
    expect(best).toBeGreaterThan(0.005);
  });
});

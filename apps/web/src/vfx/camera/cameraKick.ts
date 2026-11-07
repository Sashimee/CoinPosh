import { Euler, Quaternion, Vector3, type PerspectiveCamera } from 'three/webgpu';
import type { Rng } from '../../audio/rng.ts';
import { stepSpring, type SpringState } from '../easing.ts';

export interface CameraKickOptions {
  /** Trauma added to the shake, 0..1; the felt shake is trauma², so 0.3 is a nudge, 1 a quake. */
  readonly shake?: number;
  /** Field-of-view punch in degrees: positive widens (impact), negative tightens (anticipation). */
  readonly fov?: number;
  /** Punch along the view direction in metres: positive pushes towards the subject. */
  readonly dolly?: number;
}

/** Per-axis peak rotation at full trauma, in radians. */
const SHAKE_ANGLES = { pitch: 0.016, yaw: 0.016, roll: 0.024 } as const;
const TRAUMA_DECAY = 1.6;
const SPRING = { frequency: 24, damping: 0.42 } as const;
/** An underdamped spring kicked with velocity v peaks near 0.6 v / frequency. */
const IMPULSE_GAIN = SPRING.frequency / 0.6;
const REST = 1e-5;

interface Wobble {
  readonly f1: number;
  readonly f2: number;
  readonly p1: number;
  readonly p2: number;
}

const forward = new Vector3();
const shakeEuler = new Euler(0, 0, 0, 'YXZ');
const shakeQuat = new Quaternion();

/**
 * Camera juice layered on top of whoever owns the camera (the venue preset, a cinematic).
 * Each frame it removes nothing and adds its offset to a remembered base; if the camera
 * moved since the last frame, someone else wrote it, and that write becomes the new base.
 * So a resize that reapplies the preset mid-shake is never fought or drifted.
 *
 * Reduced motion: kicks are ignored entirely; the effects lean on light and particles.
 */
export class CameraKick {
  reducedMotion = false;
  private trauma = 0;
  private time = 0;
  private readonly fov: SpringState = { value: 0, velocity: 0 };
  private readonly dolly: SpringState = { value: 0, velocity: 0 };
  private readonly wobble: readonly [Wobble, Wobble, Wobble];
  private readonly base = { position: new Vector3(), quaternion: new Quaternion(), fov: 0 };
  private readonly written = { position: new Vector3(), quaternion: new Quaternion(), fov: 0 };
  private engaged = false;

  constructor(rng: Rng) {
    const wobble = (): Wobble => ({
      f1: (13 + rng() * 6) * Math.PI * 2,
      f2: (21 + rng() * 9) * Math.PI * 2,
      p1: rng() * Math.PI * 2,
      p2: rng() * Math.PI * 2,
    });
    this.wobble = [wobble(), wobble(), wobble()];
  }

  /** True while any offset is still being applied. */
  get active(): boolean {
    return (
      this.trauma > 0 ||
      Math.abs(this.fov.value) > REST ||
      Math.abs(this.fov.velocity) > REST ||
      Math.abs(this.dolly.value) > REST ||
      Math.abs(this.dolly.velocity) > REST
    );
  }

  get shakeAmount(): number {
    return this.trauma * this.trauma;
  }

  kick(options: CameraKickOptions): void {
    const shake = options.shake ?? 0;
    const fov = options.fov ?? 0;
    const dolly = options.dolly ?? 0;
    if (![shake, fov, dolly].every(Number.isFinite) || shake < 0) {
      throw new RangeError(
        `cameraKick needs finite values and shake >= 0, got shake ${shake}, fov ${fov}, dolly ${dolly}`,
      );
    }
    if (this.reducedMotion) return;
    this.trauma = Math.min(1, this.trauma + shake);
    this.fov.velocity += fov * IMPULSE_GAIN;
    this.dolly.velocity += dolly * IMPULSE_GAIN;
  }

  update(realDt: number, camera: PerspectiveCamera): void {
    const dt = Math.max(0, realDt);
    if (!this.engaged && !this.active) return;
    this.rebaseIfMoved(camera);
    this.time += dt;
    this.trauma = Math.max(0, this.trauma - TRAUMA_DECAY * dt);
    stepSpring(this.fov, 0, SPRING.frequency, SPRING.damping, dt);
    stepSpring(this.dolly, 0, SPRING.frequency, SPRING.damping, dt);

    const { base } = this;
    camera.position.copy(base.position);
    camera.quaternion.copy(base.quaternion);
    camera.fov = base.fov;
    if (this.active) {
      const amount = this.shakeAmount;
      const [a, b, c] = this.wobble;
      shakeEuler.set(
        noise(a, this.time) * SHAKE_ANGLES.pitch * amount,
        noise(b, this.time) * SHAKE_ANGLES.yaw * amount,
        noise(c, this.time) * SHAKE_ANGLES.roll * amount,
      );
      camera.quaternion.multiply(shakeQuat.setFromEuler(shakeEuler));
      forward.set(0, 0, -1).applyQuaternion(base.quaternion);
      camera.position.addScaledVector(forward, this.dolly.value);
      camera.fov = base.fov + this.fov.value;
      this.engaged = true;
    } else {
      this.reset();
    }
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    this.remember(camera);
  }

  /** Drops every offset; the next `update` writes the base back untouched. */
  reset(): void {
    this.trauma = 0;
    this.fov.value = 0;
    this.fov.velocity = 0;
    this.dolly.value = 0;
    this.dolly.velocity = 0;
    this.engaged = false;
  }

  private rebaseIfMoved(camera: PerspectiveCamera): void {
    const { written, base } = this;
    const moved =
      !this.engaged ||
      !camera.position.equals(written.position) ||
      !camera.quaternion.equals(written.quaternion) ||
      camera.fov !== written.fov;
    if (!moved) return;
    base.position.copy(camera.position);
    base.quaternion.copy(camera.quaternion);
    base.fov = camera.fov;
    this.engaged = true;
  }

  private remember(camera: PerspectiveCamera): void {
    this.written.position.copy(camera.position);
    this.written.quaternion.copy(camera.quaternion);
    this.written.fov = camera.fov;
  }
}

function noise(w: Wobble, t: number): number {
  return 0.62 * Math.sin(w.f1 * t + w.p1) + 0.38 * Math.sin(w.f2 * t + w.p2);
}

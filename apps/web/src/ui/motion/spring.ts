export interface SpringConfig {
  readonly stiffness: number;
  readonly damping: number;
  readonly mass?: number;
  /** Settles once both distance and speed fall below these. */
  readonly restDelta?: number;
  readonly restSpeed?: number;
}

/** The house springs. Underdamped ones overshoot on purpose: that is the "squash" in the juice. */
export const SPRINGS = {
  press: { stiffness: 1400, damping: 42 },
  release: { stiffness: 700, damping: 16 },
  snappy: { stiffness: 560, damping: 36 },
  bouncy: { stiffness: 420, damping: 15 },
  sheet: { stiffness: 340, damping: 30 },
  gentle: { stiffness: 140, damping: 22 },
  roll: { stiffness: 190, damping: 25, restDelta: 0.002 },
  pop: { stiffness: 620, damping: 12 },
} as const satisfies Record<string, SpringConfig>;

/** Fixed integration step: frame-rate independent and stable for the stiffest house spring. */
export const SPRING_STEP = 1 / 480;
const MAX_FRAME = 1 / 15;
const DEFAULT_REST_DELTA = 0.0005;
const DEFAULT_REST_SPEED = 0.005;

export class Spring {
  value: number;
  velocity = 0;
  target: number;
  private carry = 0;

  constructor(
    value: number,
    public config: SpringConfig,
  ) {
    if (!Number.isFinite(value)) throw new RangeError(`Spring start must be finite, got ${value}`);
    if (!(config.stiffness > 0) || !(config.damping >= 0) || !((config.mass ?? 1) > 0)) {
      throw new RangeError(
        `Spring needs stiffness > 0, damping ≥ 0 and mass > 0, got ${JSON.stringify(config)}`,
      );
    }
    this.value = value;
    this.target = value;
  }

  get settled(): boolean {
    const restDelta = this.config.restDelta ?? DEFAULT_REST_DELTA;
    const restSpeed = this.config.restSpeed ?? DEFAULT_REST_SPEED;
    return Math.abs(this.target - this.value) <= restDelta && Math.abs(this.velocity) <= restSpeed;
  }

  setTarget(target: number): void {
    if (!Number.isFinite(target)) {
      throw new RangeError(`Spring target must be finite, got ${target}`);
    }
    this.target = target;
  }

  /** Places the spring at `value` with no motion: the reduced-motion path. */
  jump(value: number): void {
    this.setTarget(value);
    this.value = value;
    this.velocity = 0;
    this.carry = 0;
  }

  impulse(velocity: number): void {
    this.velocity += velocity;
  }

  /** Advances by `dt` seconds; returns true once settled (and then snaps exactly to target). */
  step(dt: number): boolean {
    const { stiffness, damping } = this.config;
    const mass = this.config.mass ?? 1;
    this.carry += Math.min(Math.max(dt, 0), MAX_FRAME);
    while (this.carry >= SPRING_STEP) {
      const force = -stiffness * (this.value - this.target) - damping * this.velocity;
      this.velocity += (force / mass) * SPRING_STEP;
      this.value += this.velocity * SPRING_STEP;
      this.carry -= SPRING_STEP;
    }
    if (this.settled) {
      this.value = this.target;
      this.velocity = 0;
      return true;
    }
    return false;
  }
}

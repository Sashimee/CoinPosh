export type Easing = (t: number) => number;

export function clamp01(t: number): number {
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
}

export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/** Where `value` sits between `from` and `to`, clamped to [0, 1]. */
export function progress(value: number, from: number, to: number): number {
  return to === from ? (value >= to ? 1 : 0) : clamp01((value - from) / (to - from));
}

export const linear: Easing = (t) => clamp01(t);

export const easeInQuad: Easing = (t) => {
  const x = clamp01(t);
  return x * x;
};

export const easeOutQuad: Easing = (t) => {
  const x = clamp01(t);
  return 1 - (1 - x) * (1 - x);
};

export const easeInCubic: Easing = (t) => {
  const x = clamp01(t);
  return x * x * x;
};

export const easeOutCubic: Easing = (t) => {
  const x = 1 - clamp01(t);
  return 1 - x * x * x;
};

export const easeInOutCubic: Easing = (t) => {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
};

export const easeOutExpo: Easing = (t) => {
  const x = clamp01(t);
  return x === 1 ? 1 : 1 - 2 ** (-10 * x);
};

/** Pulls back below 0 before travelling: the anticipation half of a gesture. */
export function easeInBack(overshoot = 1.70158): Easing {
  return (t) => {
    const x = clamp01(t);
    return (overshoot + 1) * x * x * x - overshoot * x * x;
  };
}

/** Runs past 1 and settles back: the follow-through half of a gesture. */
export function easeOutBack(overshoot = 1.70158): Easing {
  return (t) => {
    const x = clamp01(t) - 1;
    return 1 + (overshoot + 1) * x * x * x + overshoot * x * x;
  };
}

/** A damped spring released from 0 towards 1; `bounces` sets how many times it crosses 1. */
export function easeOutSpring(bounces = 1.5, damping = 5.5): Easing {
  const omega = bounces * Math.PI * 2;
  return (t) => {
    const x = clamp01(t);
    if (x === 1) return 1;
    return 1 - Math.exp(-damping * x) * Math.cos(omega * x);
  };
}

/** 0 → 1 → 0 with a quick attack and an eased tail; `attack` is the peak's position in [0, 1]. */
export function pulse(t: number, attack: number): number {
  const x = clamp01(t);
  if (x < attack) return easeOutCubic(x / attack);
  return 1 - easeInOutCubic((x - attack) / (1 - attack));
}

export interface SpringState {
  value: number;
  velocity: number;
}

const SPRING_SUBSTEP = 1 / 240;

/**
 * Advances a damped spring towards `target`. `frequency` is the undamped angular frequency
 * (rad/s) and `damping` the ratio (1 = critical, below 1 overshoots). Sub-stepped so the
 * result does not depend on the frame rate.
 */
export function stepSpring(
  state: SpringState,
  target: number,
  frequency: number,
  damping: number,
  dt: number,
): void {
  let left = Math.max(0, dt);
  const k = frequency * frequency;
  const c = 2 * damping * frequency;
  while (left > 0) {
    const h = Math.min(left, SPRING_SUBSTEP);
    state.velocity += (k * (target - state.value) - c * state.velocity) * h;
    state.value += state.velocity * h;
    left -= h;
  }
}

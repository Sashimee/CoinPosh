import { createRng } from '@coinposh/economy';

export interface Spark {
  /** Launch direction in radians, 0 to the right, biased upward. */
  readonly angle: number;
  /** px per second at launch. */
  readonly speed: number;
  readonly radius: number;
  /** ms the spark lives before it has faded out. */
  readonly lifeMs: number;
  /** 0 champagne, 1 brushed gold. */
  readonly tint: number;
}

export interface SparkFrame {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly alpha: number;
  readonly tint: number;
}

const GRAVITY_PX_S2 = 900;
const DRAG = 1.8;

/** The same seed always throws the same sparks, so a replay of a payout looks identical. */
export function makeSparks(count: number, seed: number): readonly Spark[] {
  const rng = createRng(seed);
  return Array.from({ length: Math.max(0, Math.floor(count)) }, () => ({
    angle: -Math.PI / 2 + (rng.nextFloat() - 0.5) * Math.PI * 1.6,
    speed: 260 + rng.nextFloat() * 420,
    radius: 1.4 + rng.nextFloat() * 2.4,
    lifeMs: 520 + rng.nextFloat() * 520,
    tint: rng.nextFloat(),
  }));
}

/** Where a spark is `ms` after the stamp, relative to the medallion's centre; null once spent. */
export function sparkAt(spark: Spark, ms: number): SparkFrame | null {
  if (ms < 0 || ms >= spark.lifeMs) return null;
  const s = ms / 1000;
  const travel = (1 - Math.exp(-DRAG * s)) / DRAG;
  const life = ms / spark.lifeMs;
  return {
    x: Math.cos(spark.angle) * spark.speed * travel,
    y: Math.sin(spark.angle) * spark.speed * travel + 0.5 * GRAVITY_PX_S2 * s * s,
    radius: spark.radius * (1 - 0.5 * life),
    alpha: 1 - life * life,
    tint: spark.tint,
  };
}

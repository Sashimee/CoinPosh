import { createRng, type Rng } from '../../audio/rng.ts';

export const AVALANCHE_STEP_S = 1 / 120;
const GRAVITY = 2_600;
const RESTITUTION = 0.35;
const FLOOR_FRICTION = 0.86;
const REST_SPEED = 150;
const SLIDE_SPEED = 240;
const MAX_SLIDES = 6;
const IMPACT_FLOOR = 0.12;
const MAX_SETTLE_S = 20;
const STEP_SLACK = 1e-9;

export interface AvalancheCoin {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  spin: number;
  readonly radius: number;
  /** Seen nearly edge-on through the vault glass, so a coin is flatter than it is wide. */
  readonly thickness: number;
  /** 0..1 blend between brushed gold and champagne. */
  readonly tint: number;
  releaseAt: number;
  released: boolean;
  resting: boolean;
  slides: number;
}

export interface AvalancheImpact {
  /** Roughly 0..1.5, the scale `playImpact` expects. */
  readonly velocity: number;
  /** -1 (left) to 1 (right). */
  readonly pan: number;
}

export interface AvalancheOptions {
  readonly width: number;
  readonly height: number;
  readonly count: number;
  readonly seed: number;
  readonly radius?: number;
  /** Seconds over which coins leave the door, so they pour rather than drop as one block. */
  readonly pourS?: number;
}

/**
 * A small deterministic 2D pour for the vault chamber: seeded spawns, a fixed step and a
 * column heightmap for the pile, so the same seed always lands the same heap.
 */
export class Avalanche {
  readonly coins: AvalancheCoin[];
  readonly width: number;
  readonly height: number;
  private readonly columnWidth: number;
  private readonly pile: number[];
  private pending = 0;
  private time = 0;

  constructor(options: AvalancheOptions) {
    if (options.width <= 0 || options.height <= 0) {
      throw new RangeError(
        `Avalanche needs a positive chamber, got ${options.width}x${options.height}`,
      );
    }
    if (!Number.isInteger(options.count) || options.count < 0) {
      throw new RangeError(
        `Avalanche coin count must be a non-negative integer, got ${options.count}`,
      );
    }
    this.width = options.width;
    this.height = options.height;
    const radius = options.radius ?? Math.max(6, Math.min(options.width, options.height) / 16);
    this.columnWidth = radius * 1.4;
    this.pile = Array.from({ length: Math.ceil(options.width / this.columnWidth) }, () => 0);
    const rng = createRng(options.seed);
    const pourS = options.pourS ?? 0.9;
    this.coins = Array.from({ length: options.count }, (_, i) =>
      spawn(rng, options.width, radius, (pourS * i) / Math.max(1, options.count)),
    );
  }

  get settled(): boolean {
    return this.coins.every((coin) => coin.resting);
  }

  /** Advances by `dt` seconds in fixed sub-steps; returns the bounces worth a clink. */
  step(dt: number): AvalancheImpact[] {
    const impacts: AvalancheImpact[] = [];
    this.pending += Math.max(0, dt);
    while (this.pending >= AVALANCHE_STEP_S - STEP_SLACK) {
      this.pending -= AVALANCHE_STEP_S;
      this.tick(impacts);
    }
    return impacts;
  }

  /** Runs the pour to its end at once: the reduced-motion pile, or a fast-forward. */
  settle(): void {
    const sink: AvalancheImpact[] = [];
    const maxTicks = Math.ceil(MAX_SETTLE_S / AVALANCHE_STEP_S);
    for (let i = 0; i < maxTicks && !this.settled; i++) this.tick(sink);
    for (const coin of this.coins) {
      if (!coin.resting) this.rest(coin);
    }
    this.pending = 0;
  }

  private tick(impacts: AvalancheImpact[]): void {
    this.time += AVALANCHE_STEP_S;
    for (const coin of this.coins) {
      if (coin.resting) continue;
      if (!coin.released) {
        if (this.time < coin.releaseAt) continue;
        coin.released = true;
      }
      this.move(coin, impacts);
    }
  }

  private move(coin: AvalancheCoin, impacts: AvalancheImpact[]): void {
    coin.vy += GRAVITY * AVALANCHE_STEP_S;
    coin.x += coin.vx * AVALANCHE_STEP_S;
    coin.y += coin.vy * AVALANCHE_STEP_S;
    coin.angle += coin.spin * AVALANCHE_STEP_S;

    if (coin.x < coin.radius) {
      coin.x = coin.radius;
      coin.vx = Math.abs(coin.vx) * RESTITUTION;
    } else if (coin.x > this.width - coin.radius) {
      coin.x = this.width - coin.radius;
      coin.vx = -Math.abs(coin.vx) * RESTITUTION;
    }

    const column = this.columnOf(coin.x);
    const floor = this.height - this.pileAt(column);
    if (coin.y + coin.thickness / 2 < floor) return;

    coin.y = floor - coin.thickness / 2;
    const speed = coin.vy;
    if (speed > REST_SPEED) {
      const velocity = Math.min(1.5, speed / 1_400);
      if (velocity >= IMPACT_FLOOR) {
        impacts.push({ velocity, pan: (coin.x / this.width) * 2 - 1 });
      }
      coin.vy = -speed * RESTITUTION;
      coin.vx *= 0.7;
      coin.spin *= -0.6;
      return;
    }

    coin.vy = 0;
    coin.vx *= FLOOR_FRICTION;
    const downhill = this.downhill(column, coin.thickness);
    if (downhill !== 0 && coin.slides < MAX_SLIDES) {
      coin.slides += 1;
      coin.vx = downhill * SLIDE_SPEED;
      return;
    }
    if (Math.abs(coin.vx) < 20) this.rest(coin);
  }

  private rest(coin: AvalancheCoin): void {
    const column = this.columnOf(coin.x);
    coin.x = Math.min(this.width - coin.radius, Math.max(coin.radius, coin.x));
    coin.y = this.height - this.pileAt(column) - coin.thickness / 2;
    coin.vx = 0;
    coin.vy = 0;
    coin.spin = 0;
    coin.released = true;
    coin.resting = true;
    this.pile[column] = this.pileAt(column) + coin.thickness * 0.85;
  }

  /** -1 or 1 when a neighbouring column sits clearly lower, so the heap slumps instead of towering. */
  private downhill(column: number, thickness: number): -1 | 0 | 1 {
    const here = this.pileAt(column);
    const left = column > 0 ? this.pileAt(column - 1) : Number.POSITIVE_INFINITY;
    const right =
      column < this.pile.length - 1 ? this.pileAt(column + 1) : Number.POSITIVE_INFINITY;
    const drop = thickness * 1.5;
    const leftDrop = here - left;
    const rightDrop = here - right;
    if (leftDrop < drop && rightDrop < drop) return 0;
    return leftDrop >= rightDrop ? -1 : 1;
  }

  private columnOf(x: number): number {
    return Math.min(this.pile.length - 1, Math.max(0, Math.floor(x / this.columnWidth)));
  }

  private pileAt(column: number): number {
    const height = this.pile[column];
    if (height === undefined)
      throw new RangeError(`Avalanche column ${column} is outside the chamber`);
    return height;
  }
}

function spawn(rng: Rng, width: number, radius: number, releaseAt: number): AvalancheCoin {
  return {
    x: width / 2 + (rng() - 0.5) * width * 0.24,
    y: -radius - rng() * radius * 3,
    vx: (rng() - 0.5) * width * 0.9,
    vy: rng() * 220,
    angle: rng() * Math.PI * 2,
    spin: (rng() - 0.5) * 18,
    radius: radius * (0.85 + rng() * 0.3),
    thickness: radius * (0.55 + rng() * 0.2),
    tint: rng(),
    releaseAt,
    released: false,
    resting: false,
    slides: 0,
  };
}

/** FNV-1a over rounded positions: the determinism fingerprint for a pour. */
export function avalancheHash(avalanche: Avalanche): string {
  let hash = 0x811c9dc5;
  for (const coin of avalanche.coins) {
    for (const value of [coin.x, coin.y, coin.angle, coin.resting ? 1 : 0]) {
      hash ^= Math.round(value * 100) & 0xffffffff;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash.toString(16).padStart(8, '0');
}

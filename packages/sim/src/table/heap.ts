import type { Rotation, Vector } from '@dimforge/rapier3d-deterministic-compat';
import { COIN } from '../coin.ts';
import type { Xoshiro128ss } from '../prng.ts';
import { BACKBOARD, PLAYFIELD } from './layout.ts';
import { COIN_MATERIAL } from './tuning.ts';

/**
 * The opening heap: a table laid out at the brink, so the first coins the player adds
 * are what tips it, and laid like coins that were poured and shoved, not tiled. Every
 * coin is drawn from the seeded PRNG, in this order until the count runs out:
 *
 * 1. The lower-tier sheet, from just ahead of the pusher's full reach to the front lip.
 *    The sheet grows from the back: each coin is shoved back against it from a random x,
 *    each with its own stopping point at the back and its own spacing, so the back row
 *    is whole and the sheet reaches the lip wherever its packing runs out. Its front is
 *    ragged, its front coins hang over the lip with their centres on the wood, and every
 *    coin the pusher shoves into the back row is passed down the sheet to the lip.
 * 2. The upper tier the same way, from the backboard to the pusher lip. Its first coin
 *    lies within `centreJitter` of the centre line, under the chute, so a dropped coin
 *    lands on a coin rather than in a seam that would split the row sideways.
 * 3. Stacked coins on the lower sheet: each lands at a random spot, more often towards
 *    the front, and rests flat on the highest coin under it with its centre within
 *    `stackReach` of that coin's, at most `maxLayers` high.
 * 4. Stacked coins on the upper tier, nested in a free hollow between three sheet coins
 *    where one is left, and otherwise as in step 3 within `carriedStackReach`: the block
 *    shakes its coins at every stroke, and a coin cradled by three rides it.
 *
 * Stacked coins touch the ones below from the first tick; Contact Fusion leaves them be
 * because the heap is idle (FUSION_TUNING.freshTicks, wakeFromTier). A sheet coin that
 * finds no room stacks instead.
 *
 * No coin may finish a row of four that reads as ruled on a phone held either way: four
 * coins, as the camera sees them at PHONE_PITCHES, within `rowTolerance` of evenly
 * spaced points on a line. A draw that would is skipped like one that finds no room.
 *
 * The heap's capacity, and how many coins each step takes, is what a hexagonal tiling
 * of the same areas holds (`gap` apart, second layer over every hollow), so it does not
 * depend on the seed.
 *
 * Values, in metres. The aimed-drop tests (mechanics/fusionRate.test.ts) and the first
 * Demo tip (brink.test.ts) hang on where the drop lands, so the last three were chosen
 * together from a grid of them on those tests.
 *
 * - gap 1.5 mm: the tiling that sizes the heap.
 * - minGap 1.2 mm between neighbours in a layer: more than Contact Fusion's 1 mm touch
 *   gap, so neighbours are a visible hair apart rather than pressed together.
 * - snugGap up to 2 mm more, drawn per coin: the spacing varies, so no row is ruled, and
 *   the sheet stays tight enough to pass a shove from the back to the front.
 * - lipInset 1 mm: the closest a sheet coin's centre comes to its lip, hanging over it
 *   by up to 12.5 mm. Front coins sit wherever the packing ends, 1 mm to a row inside.
 * - backInset 0 to 3 mm, drawn per coin: the back row's stopping points, so it is ragged.
 * - backClearance 4 mm: the upper sheet's back row stays this far off the backboard. The
 *   block lets its coins creep back about 1.5 mm in ten idle minutes, and a coin that
 *   reaches the backboard is scraped at every stroke.
 * - reachClearance 3 mm: between the lower sheet's back and the block at full reach, so
 *   the strokes only kiss it until the first coin falls into the gap.
 * - stackInset 11 mm: a stacked coin's centre stays this far inside its lip, so a coin
 *   stacked on a hanging front coin leans its weight back onto the wood.
 * - stackReach 0.8 coin radii: a stacked coin's centre lies over its support, so it rests
 *   rather than tips, and some still shingle half off it onto the next.
 * - maxLayers 4: a pile four coins high at most.
 * - candidates 8 draws per sheet coin; band 1.5 mm, within which a spot counts as hindmost.
 * - rowTolerance 1.5 mm: about 1.5 px at 390 px across the cabinet.
 * - stackTries 20 draws per stacked coin, carriedStackReach 0.5 coin radii, centreJitter
 *   6 mm.
 */
export const HEAP_TUNING = {
  gap: 0.0015,
  minGap: 0.0012,
  lipInset: 0.001,
  backInset: 0.003,
  stackInset: 0.011,
  reachClearance: 0.003,
  backClearance: 0.004,
  stackReach: 0.8,
  carriedStackReach: 0.5,
  maxLayers: 4,
  candidates: 8,
  band: 0.0015,
  snugGap: 0.002,
  stackTries: 20,
  rowTolerance: 0.0015,
  centreJitter: 0.006,
} as const;

/**
 * The camera's pitch below the horizontal on a portrait and a landscape phone (the
 * Riviera camera preset in apps/web), as sin and cos written out, since Math.sin is
 * engine-approximated.
 */
const PHONE_PITCHES: readonly { readonly sin: number; readonly cos: number }[] = [
  { sin: 0.7071067811865476, cos: 0.7071067811865476 },
  { sin: 0.6156614753256583, cos: 0.7880107536067219 },
];

/** A spot that the heap leaves bare, such as the Champagne Tower's pedestal. */
export interface HeapKeepClear {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
}

/** The parts of the heap's geometry its caller chooses; the table supplies the rest. */
export type HeapLayout = Pick<HeapGeometry, 'keepClear'>;

export interface HeapPose {
  readonly translation: Vector;
  readonly rotation: Rotation;
}

export interface HeapGeometry {
  /** z of the upper tier's front lip when the heap is laid. */
  readonly upperLipZ: number;
  /** z of the pusher's front face at full reach. */
  readonly reachZ: number;
  /** Height of the upper tier above the lower. */
  readonly upperY: number;
  readonly keepClear?: readonly HeapKeepClear[];
}

const R = COIN.radius;
const PITCH = 2 * R + HEAP_TUNING.gap;
/** Hexagonal row spacing: PITCH × √3 / 2, written out so the lattice is the same everywhere. */
const ROW_SPACING = PITCH * 0.8660254037844386;
const SKIN = COIN_MATERIAL.contactSkin;
/** A coin's centre height when it lies flat on a surface, and the rise of each layer on top. */
const LIE_Y = COIN.halfThickness + SKIN;
const LAYER_RISE = 2 * (COIN.halfThickness + SKIN);
/** The coins' centres stay a millimetre inside the floor's sides, clear of the gutters. */
const ROW_HALF_SPAN = PLAYFIELD.fieldHalfWidth - R - 0.001;
/** Centre distance under which two coins in a layer would touch or overlap. */
const NEIGHBOUR = 2 * R + HEAP_TUNING.minGap;
const NEIGHBOUR_SQ = NEIGHBOUR * NEIGHBOUR;
/** The widest centre distance at which two sheet coins still cradle a coin between them. */
const NESTING_SPAN = NEIGHBOUR + HEAP_TUNING.snugGap + HEAP_TUNING.minGap;
/** Centre spacing, as the camera sees it, within which four coins can read as a row. */
const ROW_STEP_MIN = R;
const ROW_STEP_MAX = 3 * R;

/** One tier the heap lies on, in metres. */
interface Surface {
  readonly y: number;
  readonly lipZ: number;
  /** The lowest z a coin's centre may take. */
  readonly backZ: number;
  readonly keepClear: readonly HeapKeepClear[];
  /** The first coin of its sheet lies within this of the centre line. */
  readonly firstHalfSpan: number;
  /** How far a stacked coin's centre may lie from its support's. */
  readonly stackReach: number;
  /** Whether its stacked coins nest in the hollows between three sheet coins. */
  readonly nests: boolean;
}

interface Laid {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly layer: number;
}

/** How many coins each step of the heap takes, in laying order. */
interface Plan {
  readonly lower: number;
  readonly upper: number;
  readonly lowerStacks: number;
  readonly upperStacks: number;
}

function surfaces(geometry: HeapGeometry): { lower: Surface; upper: Surface } {
  const keepClear = geometry.keepClear ?? [];
  return {
    lower: {
      y: 0,
      lipZ: PLAYFIELD.fieldFrontZ,
      backZ: geometry.reachZ + HEAP_TUNING.reachClearance + R,
      keepClear,
      firstHalfSpan: ROW_HALF_SPAN,
      stackReach: HEAP_TUNING.stackReach * R,
      nests: false,
    },
    upper: {
      y: geometry.upperY,
      lipZ: geometry.upperLipZ,
      backZ: BACKBOARD.frontZ + HEAP_TUNING.backClearance + R,
      keepClear,
      firstHalfSpan: HEAP_TUNING.centreJitter,
      stackReach: HEAP_TUNING.carriedStackReach * R,
      nests: true,
    },
  };
}

/** The x positions of the rows of a hexagonal tiling of `surface`, front first. */
function tiling(surface: Surface): number[][] {
  const full = Math.floor((2 * ROW_HALF_SPAN) / PITCH) + 1;
  const rows: { z: number; xs: number[] }[] = [];
  for (let z = surface.lipZ - HEAP_TUNING.lipInset; z >= surface.backZ; z -= ROW_SPACING) {
    const count = rows.length % 2 === 0 ? full : full - 1;
    const start = -((count - 1) * PITCH) / 2;
    rows.push({ z, xs: Array.from({ length: count }, (_, k) => start + k * PITCH) });
  }
  const clear = (x: number, z: number): boolean =>
    surface.keepClear.every((spot) => {
      const reach = spot.radius + R + HEAP_TUNING.gap;
      return square(x - spot.x) + square(z - spot.z) >= reach * reach;
    });
  const sheet = rows.map(({ z, xs }) => xs.filter((x) => clear(x, z)));
  const hollows = rows.slice(1).map(({ z, xs }) =>
    xs
      .slice(1)
      .map((x) => x - PITCH / 2)
      .filter((x) => clear(x, z + ROW_SPACING / 3)),
  );
  return [sheet.flat(), hollows.flat()];
}

function plan(geometry: HeapGeometry): Plan {
  const { lower, upper } = surfaces(geometry);
  const [lowerSheet = [], lowerHollows = []] = tiling(lower);
  const [upperSheet = [], upperHollows = []] = tiling(upper);
  return {
    lower: lowerSheet.length,
    upper: upperSheet.length,
    lowerStacks: lowerHollows.length,
    upperStacks: upperHollows.length,
  };
}

/** How many coins the opening heap holds on this geometry. */
export function heapCapacity(geometry: HeapGeometry): number {
  const { lower, upper, lowerStacks, upperStacks } = plan(geometry);
  return lower + upper + lowerStacks + upperStacks;
}

/**
 * The first `count` poses of the heap, each laid from `rng` and turned to a random
 * heading. Throws if `count` is more than the heap holds. Coin i's pose depends only on
 * the coins before it, so a heap of n coins is the first n of a bigger one.
 */
export function heapPoses(count: number, geometry: HeapGeometry, rng: Xoshiro128ss): HeapPose[] {
  const capacity = heapCapacity(geometry);
  if (!Number.isInteger(count) || count < 0 || count > capacity) {
    throw new RangeError(
      `Opening heap: count must be an integer in [0, ${capacity}], got ${count}`,
    );
  }
  const steps = plan(geometry);
  const { lower, upper } = surfaces(geometry);
  const heap = new Heap();
  const poses: HeapPose[] = [];
  const lay = (surface: Surface, sheet: boolean): void => {
    const coin = (sheet ? heap.slide(surface, rng) : null) ?? heap.stack(surface, rng);
    poses.push({ translation: { x: coin.x, y: coin.y, z: coin.z }, rotation: randomHeading(rng) });
  };
  const order: [Surface, boolean, number][] = [
    [lower, true, steps.lower],
    [upper, true, steps.upper],
    [lower, false, steps.lowerStacks],
    [upper, false, steps.upperStacks],
  ];
  for (const [surface, sheet, n] of order) {
    for (let i = 0; i < n && poses.length < count; i++) {
      lay(surface, sheet);
    }
  }
  return poses;
}

class Heap {
  readonly #bySurface = new Map<Surface, Laid[]>();
  /** Every coin laid, for the row check, which looks across tiers as the camera does. */
  readonly #all: Laid[] = [];

  #on(surface: Surface): Laid[] {
    let coins = this.#bySurface.get(surface);
    if (!coins) {
      coins = [];
      this.#bySurface.set(surface, coins);
    }
    return coins;
  }

  #add(surface: Surface, coin: Laid): Laid {
    this.#on(surface).push(coin);
    this.#all.push(coin);
    return coin;
  }

  /**
   * A sheet coin, shoved back against the sheet as it grows from the back of the tier
   * (see `pockets`): the first free spot, hindmost and then leftmost, each try with its own stopping point and spacing; after
   * `candidates` tries whose first spot would finish a row, the first spot of the last
   * try that does not; null when no spot is free.
   */
  slide(surface: Surface, rng: Xoshiro128ss): Laid | null {
    const sheet = this.#on(surface).filter((coin) => coin.layer === 0);
    let free: { x: number; z: number }[] = [];
    for (let k = 0; k < HEAP_TUNING.candidates; k++) {
      free = this.#freeSpots(surface, sheet, rng);
      const first = free[0];
      if (first === undefined) {
        return null;
      }
      const coin = { x: first.x, y: surface.y + LIE_Y, z: first.z, layer: 0 };
      if (!this.#finishesRow(coin)) {
        return this.#add(surface, coin);
      }
    }
    for (const spot of free.slice(1)) {
      const coin = { x: spot.x, y: surface.y + LIE_Y, z: spot.z, layer: 0 };
      if (!this.#finishesRow(coin)) {
        return this.#add(surface, coin);
      }
    }
    return null;
  }

  /**
   * The free spots for a sheet coin with its own stopping point and spacing, in order:
   * those within `band` of the hindmost, leftmost
   * first, then the rest, leftmost first.
   */
  #freeSpots(
    surface: Surface,
    sheet: readonly Laid[],
    rng: Xoshiro128ss,
  ): { x: number; z: number }[] {
    const stop = surface.backZ + rng.nextRange(0, HEAP_TUNING.backInset);
    const spacing = NEIGHBOUR + rng.nextRange(0, HEAP_TUNING.snugGap);
    // pockets() shoves towards +z, so the sheet is mirrored front to back to grow it from the back.
    const mirrored = sheet.map((coin) => ({ ...coin, z: -coin.z }));
    const tail = surface.lipZ - HEAP_TUNING.lipInset;
    const free = pockets(mirrored, surface.firstHalfSpan, spacing, -stop, -tail, rng)
      .map((spot) => ({ x: spot.x, z: -spot.z }))
      .filter((spot) => this.#roomFor(surface, sheet, spot.x, spot.z));
    let hindmost = Infinity;
    for (const spot of free) {
      hindmost = Math.min(hindmost, spot.z);
    }
    const inBand = (z: number): number => (z <= hindmost + HEAP_TUNING.band ? 1 : 0);
    return free.sort((a, b) => inBand(b.z) - inBand(a.z) || a.x - b.x || a.z - b.z);
  }

  #roomFor(surface: Surface, sheet: readonly Laid[], x: number, z: number): boolean {
    return (
      Math.abs(x) <= ROW_HALF_SPAN &&
      z >= surface.backZ &&
      z <= surface.lipZ - HEAP_TUNING.lipInset &&
      sheet.every((coin) => square(coin.x - x) + square(coin.z - z) >= NEIGHBOUR_SQ) &&
      surface.keepClear.every((spot) => {
        const reach = spot.radius + R + HEAP_TUNING.gap;
        return square(x - spot.x) + square(z - spot.z) >= reach * reach;
      })
    );
  }

  /**
   * A stacked coin: the lowest of `stackTries` draws that settles where it may (the
   * first, of those as low); failing that, the lowest such spot over a coin already
   * laid, in laying order; failing that, squarely on top of the highest coin on the tier.
   */
  stack(surface: Surface, rng: Xoshiro128ss): Laid {
    const front = surface.lipZ - HEAP_TUNING.stackInset;
    if (surface.nests) {
      const nested = this.#nest(surface, front, rng);
      if (nested !== null) {
        return this.#add(surface, nested);
      }
    }
    const better = (coin: Laid | null, than: Laid | null): Laid | null =>
      coin &&
      (than === null || coin.layer < than.layer) &&
      this.#allowed(surface, coin, front) &&
      !this.#finishesRow(coin)
        ? coin
        : than;
    let best: Laid | null = null;
    for (let k = 0; k < HEAP_TUNING.stackTries; k++) {
      const x = rng.nextRange(-ROW_HALF_SPAN, ROW_HALF_SPAN);
      const z = surface.backZ + (front - surface.backZ) * Math.sqrt(rng.nextFloat());
      best = better(this.#settle(surface, x, z), best);
    }
    const coins = this.#on(surface);
    if (best === null) {
      for (const coin of coins) {
        best = better(this.#settle(surface, coin.x, coin.z), best);
      }
    }
    if (best !== null) {
      return this.#add(surface, best);
    }
    let top = coins[0];
    for (const coin of coins) {
      if (top === undefined || coin.layer > top.layer) {
        top = coin;
      }
    }
    if (top === undefined) {
      throw new Error('Opening heap: a stacked coin needs a coin under it; lay the sheet first');
    }
    return this.#add(surface, { x: top.x, y: top.y + LAYER_RISE, z: top.z, layer: top.layer + 1 });
  }

  /**
   * A coin nested in a free hollow between three neighbouring sheet coins: `stackTries`
   * draws from the hollows, in the laying order of the coins around each; null if no
   * draw is free.
   */
  #nest(surface: Surface, front: number, rng: Xoshiro128ss): Laid | null {
    const coins = this.#on(surface);
    const sheet = coins.filter((coin) => coin.layer === 0);
    const above = coins.filter((coin) => coin.layer === 1);
    const hollows: Laid[] = [];
    const adjacent = (a: Laid, b: Laid): boolean =>
      square(a.x - b.x) + square(a.z - b.z) <= NESTING_SPAN * NESTING_SPAN;
    sheet.forEach((a, i) => {
      for (let j = i + 1; j < sheet.length; j++) {
        const b = sheet[j];
        if (b === undefined || !adjacent(a, b)) {
          continue;
        }
        for (const c of sheet.slice(j + 1)) {
          if (!adjacent(a, c) || !adjacent(b, c)) {
            continue;
          }
          const x = (a.x + b.x + c.x) / 3;
          const z = (a.z + b.z + c.z) / 3;
          const hollow = { x, y: surface.y + LIE_Y + LAYER_RISE, z, layer: 1 };
          if (
            this.#allowed(surface, hollow, front) &&
            above.every((coin) => square(coin.x - x) + square(coin.z - z) >= NEIGHBOUR_SQ)
          ) {
            hollows.push(hollow);
          }
        }
      }
    });
    if (hollows.length === 0) {
      return null;
    }
    for (let k = 0; k < HEAP_TUNING.stackTries; k++) {
      const hollow = hollows[rng.nextInt(hollows.length)];
      if (hollow !== undefined && !this.#finishesRow(hollow)) {
        return hollow;
      }
    }
    return null;
  }

  /**
   * Where a coin dropped flat at (x, z) comes to rest: on the highest coins under it,
   * moved towards the nearest of them until its centre is within the surface's
   * `stackReach` of that coin's, so it rests on it; null if it does not settle in a few moves.
   */
  #settle(surface: Surface, x: number, z: number): Laid | null {
    const coins = this.#on(surface);
    let px = x;
    let pz = z;
    for (let move = 0; move < 8; move++) {
      let layer = -1;
      let support: Laid | null = null;
      let supportDistSq = Infinity;
      for (const coin of coins) {
        const distSq = square(coin.x - px) + square(coin.z - pz);
        if (distSq >= NEIGHBOUR * NEIGHBOUR) {
          continue;
        }
        if (coin.layer > layer) {
          layer = coin.layer;
          support = null;
          supportDistSq = Infinity;
        }
        if (coin.layer === layer && distSq < supportDistSq) {
          support = coin;
          supportDistSq = distSq;
        }
      }
      if (support === null) {
        return { x: px, y: surface.y + LIE_Y, z: pz, layer: 0 };
      }
      if (supportDistSq <= surface.stackReach * surface.stackReach) {
        return { x: px, y: support.y + LAYER_RISE, z: pz, layer: layer + 1 };
      }
      const pull = (0.9 * surface.stackReach) / Math.sqrt(supportDistSq);
      px = support.x + (px - support.x) * pull;
      pz = support.z + (pz - support.z) * pull;
    }
    return null;
  }

  #allowed(surface: Surface, coin: Laid, front: number): boolean {
    return (
      coin.layer < HEAP_TUNING.maxLayers &&
      Math.abs(coin.x) <= ROW_HALF_SPAN &&
      coin.z >= surface.backZ &&
      coin.z <= front &&
      surface.keepClear.every((spot) => {
        const reach = spot.radius + R + HEAP_TUNING.gap;
        return square(coin.x - spot.x) + square(coin.z - spot.z) >= reach * reach;
      })
    );
  }

  /** Whether `coin` would make a row of four with coins already laid; see PHONE_PITCHES. */
  #finishesRow(coin: Laid): boolean {
    return PHONE_PITCHES.some((pitch) => {
      const p = onScreen(coin, pitch);
      const near: Point[] = [];
      for (const other of this.#all) {
        const q = onScreen(other, pitch);
        if (square(q.h - p.h) + square(q.v - p.v) <= square(3 * ROW_STEP_MAX)) {
          near.push(q);
        }
      }
      return near.some((q) => {
        const stepSq = square(q.h - p.h) + square(q.v - p.v);
        if (stepSq < ROW_STEP_MIN * ROW_STEP_MIN || stepSq > ROW_STEP_MAX * ROW_STEP_MAX) {
          return false;
        }
        const step = { h: q.h - p.h, v: q.v - p.v };
        // p at index 0 and q at 1, inside each window of four that holds both.
        return [-2, -1, 0].some((first) => {
          const row: Point[] = [];
          for (let i = first; i < first + 4; i++) {
            if (i === 0) {
              row.push(p);
            } else if (i === 1) {
              row.push(q);
            } else {
              const at = nearest(near, p.h + i * step.h, p.v + i * step.v);
              if (at === null) {
                return false;
              }
              row.push(at);
            }
          }
          return isRow(row);
        });
      });
    });
  }
}

interface Point {
  readonly h: number;
  readonly v: number;
}

/**
 * A coin's centre as a camera at `pitch` below the horizontal sees it, orthographically:
 * across the screen and up it, in metres.
 */
function onScreen(
  coin: Readonly<Vector>,
  pitch: { readonly sin: number; readonly cos: number },
): Point {
  return { h: coin.x, v: coin.y * pitch.cos - coin.z * pitch.sin };
}

/**
 * Whether four points, in order, lie within HEAP_TUNING.rowTolerance of evenly spaced
 * points on a line (the least-squares fit P0 + k·step), ROW_STEP_MIN to ROW_STEP_MAX
 * apart.
 */
function isRow(points: readonly Point[]): boolean {
  if (points.length !== 4) {
    throw new RangeError(`isRow: needs 4 points, got ${points.length}`);
  }
  // Least squares over k = 0..3: mean k 1.5, Σ(k − 1.5)² = 5.
  let mh = 0;
  let mv = 0;
  for (const p of points) {
    mh += p.h / 4;
    mv += p.v / 4;
  }
  let sh = 0;
  let sv = 0;
  points.forEach((p, k) => {
    sh += ((k - 1.5) * (p.h - mh)) / 5;
    sv += ((k - 1.5) * (p.v - mv)) / 5;
  });
  const stepSq = sh * sh + sv * sv;
  if (stepSq < ROW_STEP_MIN * ROW_STEP_MIN || stepSq > ROW_STEP_MAX * ROW_STEP_MAX) {
    return false;
  }
  const tolSq = HEAP_TUNING.rowTolerance * HEAP_TUNING.rowTolerance;
  return points.every(
    (p, k) => square(p.h - (mh + (k - 1.5) * sh)) + square(p.v - (mv + (k - 1.5) * sv)) <= tolSq,
  );
}

/** The point of `points` nearest (h, v), if it lies within twice the row tolerance. */
function nearest(points: readonly Point[], h: number, v: number): Point | null {
  let best: Point | null = null;
  let bestSq = square(2 * HEAP_TUNING.rowTolerance);
  for (const p of points) {
    const distSq = square(p.h - h) + square(p.v - v);
    if (distSq <= bestSq) {
      best = p;
      bestSq = distSq;
    }
  }
  return best;
}

/**
 * Every spot where a coin `spacing` clear of the coins in `sheet` would rest when shoved
 * towards the lip, no further forward than `stop`: on the stop line, at random across
 * the tier and beside each coin; touching two coins; or touching a coin and a side.
 * Spots behind `back` are left out; the caller checks the rest for room.
 */
function pockets(
  sheet: readonly Laid[],
  firstHalfSpan: number,
  spacing: number,
  stop: number,
  back: number,
  rng: Xoshiro128ss,
): { x: number; z: number }[] {
  const spots: { x: number; z: number }[] = [];
  const add = (x: number, z: number): void => {
    if (z <= stop && z >= back) {
      spots.push({ x, z });
    }
  };
  if (sheet.length === 0) {
    add(rng.nextRange(-firstHalfSpan, firstHalfSpan), stop);
  }
  const spacingSq = spacing * spacing;
  sheet.forEach((a, i) => {
    for (const line of [stop, back]) {
      const across = spacingSq - square(line - a.z);
      if (across > 0) {
        add(a.x - Math.sqrt(across), line);
        add(a.x + Math.sqrt(across), line);
      }
    }
    for (const side of [-ROW_HALF_SPAN, ROW_HALF_SPAN]) {
      const along = spacingSq - square(side - a.x);
      if (along > 0) {
        add(side, a.z - Math.sqrt(along));
      }
    }
    for (const b of sheet.slice(i + 1)) {
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const dSq = dx * dx + dz * dz;
      const h = spacingSq - dSq / 4;
      if (h <= 0) {
        continue;
      }
      // Of the two points `spacing` from both, the one behind the pair rests against it.
      const t = Math.sqrt(h / dSq);
      const mx = (a.x + b.x) / 2;
      const mz = (a.z + b.z) / 2;
      const sign = dx >= 0 ? 1 : -1;
      add(mx + sign * dz * t, mz - sign * dx * t);
    }
  });
  return spots;
}

function square(x: number): number {
  return x * x;
}

/** A turn about the vertical axis, uniform over the circle, from + − * / and sqrt only. */
function randomHeading(rng: Xoshiro128ss): Rotation {
  for (;;) {
    const c = rng.nextRange(-1, 1);
    const s = rng.nextRange(-1, 1);
    const lengthSq = c * c + s * s;
    if (lengthSq > 1e-6 && lengthSq <= 1) {
      const length = Math.sqrt(lengthSq);
      return { x: 0, y: s / length, z: 0, w: c / length };
    }
  }
}

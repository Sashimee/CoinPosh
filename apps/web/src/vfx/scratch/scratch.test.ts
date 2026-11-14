import { RARITIES, SCRATCH_GRID_SIZE, type Rarity } from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import { JUICE_ITEMS, JUICE_MINIMUM } from '../juice.ts';
import { ParticleKind } from '../particles/layout.ts';
import { ScratchFlow } from './flow.ts';
import {
  BRUSH_CORE,
  BRUSH_RADIUS,
  CARD_CLEAR,
  CELL_GAP,
  CELL_PAD,
  CELL_REVEAL,
  CELL_SIZE,
  cellAt,
  cellCentre,
  cellRect,
  CoverageMask,
  strokeStamps,
  type ScratchPoint,
} from './mask.ts';
import {
  autoRevealPath,
  cellSweepPath,
  clearAmount,
  enterPose,
  flakeSpawns,
  flarePose,
  FULL_SCRATCH,
  matchGlintSpawns,
  pairedCells,
  pathPoint,
  prizeCount,
  REDUCED_SCRATCH,
  SCRAPE_STEP,
  ScrapeVoice,
  SCRATCH_JUICE,
  scratchCue,
  scratchMatch,
  scratchTimeline,
  sealingPose,
  seededRandom,
  SWEEP_RADIUS,
} from './plan.ts';

const GRID: readonly Rarity[] = [
  'fine',
  'rare',
  'common',
  'rare',
  'fine',
  'common',
  'rare',
  'common',
  'fine',
];

/** Scratches the whole of one cell with a dense raster of stamps. */
function scrubCell(index: number): ScratchPoint[] {
  const rect = cellRect(index);
  const points: ScratchPoint[] = [];
  for (let y = rect.y0; y <= rect.y1; y += 0.02) {
    for (let x = rect.x0; x <= rect.x1; x += 0.02) points.push({ x, y });
  }
  return points;
}

describe('scratch cell layout', () => {
  it('fills the window exactly: padding, three cells and two gutters per side', () => {
    expect(2 * CELL_PAD + 3 * CELL_SIZE + 2 * CELL_GAP).toBeCloseTo(1, 12);
    expect(cellRect(0)).toEqual({
      x0: CELL_PAD,
      y0: CELL_PAD,
      x1: CELL_PAD + CELL_SIZE,
      y1: CELL_PAD + CELL_SIZE,
    });
    expect(cellRect(8).x1).toBeCloseTo(1 - CELL_PAD, 12);
    expect(cellRect(8).y1).toBeCloseTo(1 - CELL_PAD, 12);
  });

  it('is row-major, like the server grid', () => {
    expect(cellCentre(1).y).toBeCloseTo(cellCentre(0).y, 12);
    expect(cellCentre(1).x).toBeGreaterThan(cellCentre(0).x);
    expect(cellCentre(3).x).toBeCloseTo(cellCentre(0).x, 12);
    expect(cellCentre(3).y).toBeGreaterThan(cellCentre(0).y);
  });

  it('finds each cell from its centre and nothing in the padding or the gutters', () => {
    for (let i = 0; i < SCRATCH_GRID_SIZE; i++) expect(cellAt(cellCentre(i))).toBe(i);
    expect(cellAt({ x: CELL_PAD / 2, y: 0.5 })).toBeNull();
    expect(cellAt({ x: CELL_PAD + CELL_SIZE + CELL_GAP / 2, y: cellCentre(0).y })).toBeNull();
    expect(cellAt({ x: 1, y: 1 })).toBeNull();
  });

  it('refuses a cell outside the grid instead of drawing nowhere', () => {
    expect(() => cellRect(-1)).toThrow(RangeError);
    expect(() => cellRect(9)).toThrow(RangeError);
    expect(() => cellRect(1.5)).toThrow(RangeError);
  });
});

describe('stroke stamps', () => {
  it('ends on the target and never leaves a gap wider than the spacing', () => {
    const from = { x: 0.1, y: 0.1 };
    const to = { x: 0.9, y: 0.6 };
    const stamps = strokeStamps(from, to);
    expect(stamps.at(-1)).toEqual(to);
    let previous = from;
    for (const stamp of stamps) {
      expect(Math.hypot(stamp.x - previous.x, stamp.y - previous.y)).toBeLessThanOrEqual(
        BRUSH_RADIUS * 0.3 + 1e-12,
      );
      previous = stamp;
    }
  });

  it('stamps a tap (no movement) once', () => {
    expect(strokeStamps({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 })).toEqual([{ x: 0.5, y: 0.5 }]);
  });

  it('rejects a brush with no size', () => {
    expect(() => strokeStamps({ x: 0, y: 0 }, { x: 1, y: 1 }, 0)).toThrow(RangeError);
    expect(() => strokeStamps({ x: 0, y: 0 }, { x: 1, y: 1 }, 0.1, -1)).toThrow(RangeError);
  });
});

describe('coverage mask', () => {
  it('starts whole', () => {
    const mask = new CoverageMask();
    expect(mask.total()).toBe(0);
    expect(mask.uncovered()).toEqual([]);
    expect(mask.cleared()).toBe(false);
    for (let i = 0; i < SCRATCH_GRID_SIZE; i++) expect(mask.cellCoverage(i)).toBe(0);
  });

  it('clears a disc of the brush core, matching its area', () => {
    const mask = new CoverageMask(256);
    const cleared = mask.stamp({ x: 0.5, y: 0.5 });
    const expected = Math.PI * (BRUSH_RADIUS * BRUSH_CORE) ** 2;
    expect(cleared / 256 ** 2).toBeCloseTo(expected, 3);
    expect(mask.total()).toBeCloseTo(expected, 3);
  });

  it('never counts a sample twice', () => {
    const mask = new CoverageMask();
    const first = mask.stamp({ x: 0.5, y: 0.5 });
    expect(first).toBeGreaterThan(0);
    expect(mask.stamp({ x: 0.5, y: 0.5 })).toBe(0);
    expect(mask.total()).toBeCloseTo(first / 64 ** 2, 12);
  });

  it('keeps each cell to itself: scratching one leaves its neighbours covered', () => {
    const mask = new CoverageMask();
    for (const point of scrubCell(4)) mask.stamp(point, 0.02);
    expect(mask.cellCoverage(4)).toBeGreaterThan(0.99);
    expect(mask.uncovered()).toEqual([4]);
    for (const other of [0, 1, 2, 3, 5, 6, 7, 8]) expect(mask.cellCoverage(other)).toBe(0);
  });

  it('calls a cell uncovered only from the reveal threshold', () => {
    const mask = new CoverageMask();
    const rect = cellRect(0);
    const rows = scrubCell(0).filter((p) => p.y < rect.y0 + CELL_SIZE * (CELL_REVEAL - 0.15));
    for (const point of rows) mask.stamp(point, 0.02);
    expect(mask.cellCoverage(0)).toBeGreaterThan(0);
    expect(mask.cellCoverage(0)).toBeLessThan(CELL_REVEAL);
    expect(mask.uncovered()).toEqual([]);
    expect(mask.uncovered(mask.cellCoverage(0))).toEqual([0]);
  });

  it('clears the card once every cell is uncovered, even below the window threshold', () => {
    const mask = new CoverageMask();
    for (let i = 0; i < SCRATCH_GRID_SIZE; i++) mask.stamp(cellCentre(i), CELL_SIZE * 0.62);
    expect(mask.uncovered()).toHaveLength(SCRATCH_GRID_SIZE);
    expect(mask.total()).toBeLessThan(CARD_CLEAR);
    expect(mask.cleared()).toBe(true);
  });

  it('clears the card once enough of the window is off', () => {
    const mask = new CoverageMask();
    mask.stamp({ x: 0.5, y: 0.5 }, 0.6 / BRUSH_CORE);
    expect(mask.total()).toBeGreaterThanOrEqual(CARD_CLEAR);
    expect(mask.cleared()).toBe(true);
  });

  it('ignores stamps off the window or with no size', () => {
    const mask = new CoverageMask();
    expect(mask.stamp({ x: 3, y: 3 })).toBe(0);
    expect(mask.stamp({ x: Number.NaN, y: 0.5 })).toBe(0);
    expect(mask.stamp({ x: 0.5, y: 0.5 }, 0)).toBe(0);
    expect(mask.total()).toBe(0);
  });

  it('rejects a resolution too coarse to tell the cells apart', () => {
    expect(() => new CoverageMask(8)).toThrow(RangeError);
    expect(() => new CoverageMask(32.5)).toThrow(RangeError);
    expect(() => new CoverageMask().cellCoverage(9)).toThrow(RangeError);
  });
});

describe('scratch match', () => {
  it('finds the three gems of the roll, in grid order', () => {
    expect(scratchMatch(GRID, 'rare')).toEqual({ rarity: 'rare', cells: [1, 3, 6] });
  });

  it('refuses a grid of the wrong size', () => {
    expect(() => scratchMatch(GRID.slice(0, 8), 'rare')).toThrow(/8 gems/);
  });

  it('refuses a grid without three of the rolled rarity', () => {
    expect(() => scratchMatch(GRID, 'legendary')).toThrow(/0 legendary gems/);
  });

  it('pairs uncovered gems that share a rarity', () => {
    expect(pairedCells(GRID, [0, 1, 2])).toEqual([]);
    expect(pairedCells(GRID, [0, 1, 3, 4])).toEqual([0, 1, 3, 4]);
    expect(pairedCells(GRID, [1, 3, 2])).toEqual([1, 3]);
  });
});

describe('scratch flow', () => {
  it('scratches nothing until the server grid is in', () => {
    const flow = new ScratchFlow();
    expect(flow.scratch([cellCentre(0)]).cleared).toBe(0);
    expect(flow.begin()).toBe(true);
    expect(flow.phase).toBe('revealing');
    expect(flow.scratch([cellCentre(0)]).cleared).toBe(0);
    expect(flow.mask.total()).toBe(0);
    flow.accept(GRID, 'rare');
    expect(flow.canScratch).toBe(true);
    expect(flow.scratch([cellCentre(0)]).cleared).toBeGreaterThan(0);
  });

  it('asks the house once per card', () => {
    const flow = new ScratchFlow();
    expect(flow.begin()).toBe(true);
    expect(flow.begin()).toBe(false);
  });

  it('takes no grid it did not ask for', () => {
    const flow = new ScratchFlow();
    expect(() => flow.accept(GRID, 'rare')).toThrow(/sealed, not revealing/);
  });

  it('stays unscratchable when the server grid breaks the contract', () => {
    const flow = new ScratchFlow();
    flow.begin();
    expect(() => flow.accept(GRID, 'heirloom')).toThrow(RangeError);
    expect(flow.phase).toBe('revealing');
    expect(flow.grid).toBeNull();
    expect(flow.canScratch).toBe(false);
  });

  it('goes back to sealed on a refusal, ready to ask again', () => {
    const flow = new ScratchFlow();
    flow.begin();
    flow.refuse();
    expect(flow.phase).toBe('sealed');
    expect(flow.begin()).toBe(true);
  });

  it('reports each uncovered cell and each new pair once', () => {
    const flow = new ScratchFlow();
    flow.begin();
    flow.accept(GRID, 'rare');
    const first = flow.scratch(scrubCell(1));
    expect(first.uncovered).toEqual([1]);
    expect(first.paired).toEqual([]);
    const second = flow.scratch(scrubCell(3));
    expect(second.uncovered).toEqual([3]);
    expect(second.paired).toEqual([1, 3]);
    expect(flow.scratch(scrubCell(3)).cleared).toBe(0);
    expect(flow.uncovered).toEqual([1, 3]);
  });

  it('clears the rest of the foil, settles and collects exactly once', () => {
    const flow = new ScratchFlow();
    flow.begin();
    flow.accept(GRID, 'rare');
    flow.scratch(scrubCell(0));
    expect(flow.collect()).toBe(false);
    expect(flow.clear()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(flow.clear()).toEqual([]);
    expect(flow.phase).toBe('clearing');
    expect(flow.scratch(scrubCell(4)).cleared).toBe(0);
    expect(flow.settle()).toBe(true);
    expect(flow.settle()).toBe(false);
    expect(flow.collect()).toBe(true);
    expect(flow.collect()).toBe(false);
    expect(flow.phase).toBe('collected');
  });

  it('starts clearing by itself once enough has been scratched', () => {
    const flow = new ScratchFlow();
    flow.begin();
    flow.accept(GRID, 'rare');
    const step = flow.scratch([{ x: 0.5, y: 0.5 }], 0.6 / BRUSH_CORE);
    expect(step.clearing).toBe(true);
    expect(flow.phase).toBe('clearing');
    expect(flow.uncovered).toHaveLength(SCRATCH_GRID_SIZE);
  });
});

describe('scratch timelines', () => {
  it('picks the reduced timeline under reduced motion', () => {
    expect(scratchTimeline(false)).toBe(FULL_SCRATCH);
    expect(scratchTimeline(true)).toBe(REDUCED_SCRATCH);
  });

  it('throws no flakes or glints, freezes nothing and sweeps nothing under reduced motion', () => {
    expect(REDUCED_SCRATCH).toMatchObject({
      reduced: true,
      hitStopMs: 0,
      flakesPerStamp: 0,
      flakeFrameBudget: 0,
      matchGlints: 0,
      autoRevealMs: 0,
      cellSweepMs: 0,
      countMs: 0,
      liftMs: 0,
      tiltDeg: 0,
    });
    expect(REDUCED_SCRATCH.clearMs).toBeGreaterThan(0);
  });

  it('keeps the card still and only fades it under reduced motion', () => {
    for (const ms of [0, 50, 100, 200, 400]) {
      const pose = enterPose(ms, REDUCED_SCRATCH);
      expect(pose).toMatchObject({ scale: 1, rise: 0, tilt: 0 });
      expect(sealingPose(ms, REDUCED_SCRATCH)).toEqual({ scale: 1, rise: 0, opacity: 1, tilt: 0 });
      expect(flarePose(ms, 2, REDUCED_SCRATCH).scale).toBe(1);
    }
    expect(enterPose(0, REDUCED_SCRATCH).opacity).toBe(0);
    expect(enterPose(REDUCED_SCRATCH.enterMs, REDUCED_SCRATCH).opacity).toBe(1);
    expect(prizeCount(0, 0, REDUCED_SCRATCH)).toBe(1);
  });

  it('overshoots on the way in and dips before the lift (anticipation)', () => {
    const scales = Array.from({ length: 57 }, (_, i) => enterPose(i * 10, FULL_SCRATCH).scale);
    expect(Math.max(...scales)).toBeGreaterThan(1);
    expect(enterPose(FULL_SCRATCH.enterMs, FULL_SCRATCH).scale).toBeCloseTo(1, 9);
    expect(sealingPose(FULL_SCRATCH.liftMs * 0.2, FULL_SCRATCH).rise).toBeGreaterThan(0);
    expect(sealingPose(FULL_SCRATCH.liftMs, FULL_SCRATCH).rise).toBeLessThan(0);
  });

  it('flares the three gems one after another, each swelling past size', () => {
    const peak = (order: number) =>
      Math.max(
        ...Array.from({ length: 200 }, (_, i) => flarePose(i * 10, order, FULL_SCRATCH).scale),
      );
    expect(peak(0)).toBeGreaterThan(1.2);
    expect(flarePose(FULL_SCRATCH.flareStaggerMs - 1, 1, FULL_SCRATCH).scale).toBe(1);
    expect(flarePose(FULL_SCRATCH.flareStaggerMs * 3, 1, FULL_SCRATCH).scale).toBeGreaterThan(1);
  });

  it('counts a prize up from nothing to all of it', () => {
    expect(prizeCount(FULL_SCRATCH.linesAtMs, 0, FULL_SCRATCH)).toBe(0);
    expect(prizeCount(FULL_SCRATCH.linesAtMs + FULL_SCRATCH.countMs, 0, FULL_SCRATCH)).toBe(1);
    expect(clearAmount(0, FULL_SCRATCH)).toBe(0);
    expect(clearAmount(FULL_SCRATCH.clearMs, FULL_SCRATCH)).toBe(1);
  });
});

describe('reveal paths', () => {
  it('sweeps every cell with the auto-reveal brush', () => {
    const mask = new CoverageMask();
    const path = autoRevealPath();
    for (let i = 0; i <= 400; i++) mask.stamp(pathPoint(path, i / 400), SWEEP_RADIUS);
    expect(mask.uncovered()).toHaveLength(SCRATCH_GRID_SIZE);
    expect(mask.cleared()).toBe(true);
  });

  it('scratches one cell from the keyboard without spilling into the next', () => {
    const mask = new CoverageMask();
    const path = cellSweepPath(4);
    for (let i = 0; i <= 120; i++) mask.stamp(pathPoint(path, i / 120), SWEEP_RADIUS);
    expect(mask.uncovered()).toEqual([4]);
  });

  it('walks a path by length and clamps its ends', () => {
    const path = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
    ];
    expect(pathPoint(path, 0)).toEqual({ x: 0, y: 0 });
    expect(pathPoint(path, 0.25)).toEqual({ x: 0.5, y: 0 });
    expect(pathPoint(path, 0.75)).toEqual({ x: 1, y: 0.5 });
    expect(pathPoint(path, 2)).toEqual({ x: 1, y: 1 });
    expect(pathPoint([{ x: 0.3, y: 0.3 }], 0.5)).toEqual({ x: 0.3, y: 0.3 });
    expect(() => pathPoint([], 0.5)).toThrow(RangeError);
  });
});

describe('scratch audio and haptics', () => {
  it('rasps once per scrape step of travel, louder when faster', () => {
    const voice = new ScrapeVoice();
    const at = { x: 0.5, y: 0.5 };
    expect(voice.advance(at, SCRAPE_STEP / 2, 1)).toBeNull();
    const slow = voice.advance(at, SCRAPE_STEP / 2, 0.5);
    expect(slow?.material).toBe('metal');
    expect(voice.advance(at, 0, 1)).toBeNull();
    voice.reset();
    const fast = voice.advance(at, SCRAPE_STEP, 8);
    expect(fast?.velocity).toBeGreaterThan(slow?.velocity ?? 1);
  });

  it('pans the rasp with the finger', () => {
    const left = new ScrapeVoice().advance({ x: 0, y: 0.5 }, SCRAPE_STEP, 1);
    const right = new ScrapeVoice().advance({ x: 1, y: 0.5 }, SCRAPE_STEP, 1);
    expect(left?.pan).toBeLessThan(0);
    expect(right?.pan).toBeGreaterThan(0);
  });

  it('gives the match a louder chord and a haptic for every rarity', () => {
    for (const rarity of RARITIES) {
      const cue = scratchCue('match', rarity);
      expect(cue.sounds.length).toBeGreaterThan(0);
      expect(cue.haptic).not.toBeNull();
    }
    expect(scratchCue('match', 'heirloom').sounds.length).toBeGreaterThanOrEqual(
      scratchCue('match', 'common').sounds.length,
    );
    expect(scratchCue('deny', null).haptic).not.toBeNull();
  });
});

describe('scratch particles', () => {
  it('throws the same flakes for the same seed', () => {
    const a = flakeSpawns({ x: 0.4, y: 0.4 }, { x: 1, y: 0 }, 6, seededRandom(7));
    const b = flakeSpawns({ x: 0.4, y: 0.4 }, { x: 1, y: 0 }, 6, seededRandom(7));
    expect(a).toEqual(b);
    expect(a).toHaveLength(6);
    expect(a.every((spawn) => spawn.kind === ParticleKind.Confetti)).toBe(true);
  });

  it('peels flakes in the stroke direction and up off the card', () => {
    const spawns = flakeSpawns({ x: 0.5, y: 0.5 }, { x: 1, y: 0 }, 64, seededRandom(3));
    const meanVx = spawns.reduce((sum, s) => sum + s.vx, 0) / spawns.length;
    expect(meanVx).toBeGreaterThan(0);
    expect(spawns.every((s) => s.vz > 0)).toBe(true);
  });

  it('rings each matched gem with glints in its rarity', () => {
    const spawns = matchGlintSpawns([1, 3, 6], 'rare', 12, seededRandom(1));
    expect(spawns).toHaveLength(36);
    expect(spawns.some((s) => s.kind === ParticleKind.Glint)).toBe(true);
    expect(spawns.some((s) => s.kind === ParticleKind.Spark)).toBe(true);
    expect(matchGlintSpawns([0], 'heirloom', 0, seededRandom(1))).toEqual([]);
  });
});

describe('scratch juice', () => {
  it('hits at least the checklist minimum on every interaction', () => {
    for (const [name, juice] of Object.entries(SCRATCH_JUICE)) {
      expect(new Set(juice.full).size, name).toBeGreaterThanOrEqual(JUICE_MINIMUM);
      for (const item of [...juice.full, ...juice.reduced])
        expect(Object.hasOwn(JUICE_ITEMS, item)).toBe(true);
    }
  });

  it('drops particles, overshoot and time effects from every reduced variant', () => {
    for (const [name, juice] of Object.entries(SCRATCH_JUICE)) {
      expect(juice.reduced.length, name).toBeGreaterThan(0);
      expect(juice.reduced, name).not.toContain('particles');
      expect(juice.reduced, name).not.toContain('squashOvershoot');
      expect(juice.reduced, name).not.toContain('timeManipulation');
    }
  });
});

import { describe, expect, it } from 'vitest';
import {
  boxContains,
  boxesIntersect,
  coinFloorFrontHalf,
  coinFloorRect,
  planMeterRails,
  type Box,
  type Insets,
  type RailPlan,
} from './railLayout.ts';
import {
  planRankStamp,
  STAMP_FIELD_GAP,
  STAMP_MIN_SCALE,
  type StampLayout,
  type StampPlanInput,
} from './stampLayout.ts';

const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
const NO_RAILS: RailPlan = { zone: 'edge', left: null, right: null };

interface Screen {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** Bottom of the Vault plaque and top of the dock in Demo Mode, in CSS px. */
  readonly plaqueBottom: number;
  readonly dockTop: number;
  readonly safe?: Insets;
}

const PHONE: Screen = { name: '390x844', width: 390, height: 844, plaqueBottom: 164, dockTop: 774 };
const SCREENS: readonly Screen[] = [
  PHONE,
  { name: '360x640', width: 360, height: 640, plaqueBottom: 150, dockTop: 574 },
  { name: '430x932', width: 430, height: 932, plaqueBottom: 170, dockTop: 862 },
  {
    name: '390x844 notch',
    width: 390,
    height: 844,
    plaqueBottom: 211,
    dockTop: 740,
    safe: { top: 47, right: 0, bottom: 34, left: 0 },
  },
  { name: '1440x900', width: 1440, height: 900, plaqueBottom: 147, dockTop: 830 },
  { name: '844x390', width: 844, height: 390, plaqueBottom: 137, dockTop: 324 },
];

/** Ribbon sizes as rendered: "Chic ×1.1" in EN up to "OBSZÖN ×3" in DE. */
const RIBBONS = [
  { label: 'short', width: 214, height: 58 },
  { label: 'long', width: 312, height: 58 },
] as const;

/** Extra HUD under the plaque: the Concierge notice, or the upgrade nudge with its hint. */
const HUD_NOTICES = [0, 56, 120] as const;

/** How far a ribbon corner dips below its resting box under the landing tilt (3 degrees). */
function tiltDip(box: Box): number {
  return (box.width / 2) * Math.sin((3 * Math.PI) / 180);
}

function layoutFor(screen: Screen, extraCeiling: number): StampLayout {
  const viewport = { width: screen.width, height: screen.height };
  const safe = screen.safe ?? NO_INSETS;
  const floor = coinFloorRect(screen.width, screen.height);
  const ceiling = screen.plaqueBottom + extraCeiling;
  return {
    viewport,
    safe,
    floor,
    frontHalf: coinFloorFrontHalf(screen.width, screen.height),
    ceiling,
    rails: planMeterRails({ viewport, safe, floor, ceiling, base: screen.dockTop }),
  };
}

function railBoxes(rails: RailPlan): Box[] {
  return [rails.left, rails.right].flatMap((slot) =>
    slot ? [slot.rail, ...(slot.card ? [slot.card] : [])] : [],
  );
}

function bottomOf(box: Box): number {
  return box.top + box.height;
}

describe('coinFloorFrontHalf', () => {
  it('runs from halfway back down to the lip, across the floor', () => {
    for (const screen of SCREENS) {
      const floor = coinFloorRect(screen.width, screen.height);
      const front = coinFloorFrontHalf(screen.width, screen.height);
      expect(boxContains(floor, front)).toBe(true);
      expect(bottomOf(front)).toBeCloseTo(bottomOf(floor), 6);
      expect(front.top).toBeGreaterThan(floor.top + floor.height * 0.3);
      expect(front.top).toBeLessThan(floor.top + floor.height * 0.75);
    }
  });
});

describe('planRankStamp', () => {
  for (const screen of SCREENS) {
    for (const extra of HUD_NOTICES) {
      for (const ribbon of RIBBONS) {
        describe(`${screen.name}, ${ribbon.label} ribbon, HUD +${extra}px`, () => {
          const layout = layoutFor(screen, extra);
          const { box, scale } = planRankStamp({ ...layout, card: ribbon });
          const safeArea: Box = {
            left: layout.safe.left,
            top: layout.safe.top,
            width: screen.width - layout.safe.left - layout.safe.right,
            height: screen.height - layout.safe.top - layout.safe.bottom,
          };

          it('never covers the front half of the coin floor or the lip, landing tilt included', () => {
            expect(boxesIntersect(box, layout.frontHalf)).toBe(false);
            expect(bottomOf(box) + tiltDip(box)).toBeLessThanOrEqual(layout.frontHalf.top);
          });

          it('stays on screen and legible', () => {
            expect(boxContains(safeArea, box)).toBe(true);
            expect(scale).toBeGreaterThanOrEqual(STAMP_MIN_SCALE);
            expect(scale).toBeLessThanOrEqual(1);
          });

          it('keeps clear of the meter cards it would otherwise land on', () => {
            if (extra > 0) return;
            for (const rail of railBoxes(layout.rails))
              expect(boxesIntersect(box, rail)).toBe(false);
          });

          it('rests under the Vault plaque', () => {
            if (extra > 0) return;
            expect(box.top).toBeGreaterThanOrEqual(screen.plaqueBottom);
          });
        });
      }
    }
  }

  it('at 390x844 lands at full size between the plaque and the front half, centred on the floor', () => {
    const layout = layoutFor(PHONE, 0);
    const { box, scale } = planRankStamp({ ...layout, card: RIBBONS[0] });
    expect(scale).toBe(1);
    expect(box.left + box.width / 2).toBeCloseTo(layout.floor.left + layout.floor.width / 2, 6);
    expect(bottomOf(box)).toBeLessThanOrEqual(layout.frontHalf.top - STAMP_FIELD_GAP);
  });

  const roomy: StampPlanInput = {
    viewport: { width: 400, height: 800 },
    safe: NO_INSETS,
    floor: { left: 20, top: 300, width: 360, height: 200 },
    frontHalf: { left: 20, top: 400, width: 360, height: 100 },
    ceiling: 150,
    rails: NO_RAILS,
    card: { width: 200, height: 60 },
  };

  it('stays near the Vault on a tall screen instead of drifting down to the field', () => {
    const { box, scale } = planRankStamp({ ...roomy, frontHalf: { ...roomy.frontHalf, top: 700 } });
    expect(scale).toBe(1);
    expect(box.top).toBeLessThanOrEqual(150 + 8 + 40);
  });

  it('shrinks to fit a short band', () => {
    const { box, scale } = planRankStamp({ ...roomy, ceiling: 330 });
    expect(scale).toBeLessThan(1);
    expect(scale).toBeGreaterThanOrEqual(STAMP_MIN_SCALE);
    expect(box.top).toBeGreaterThanOrEqual(338);
    expect(bottomOf(box)).toBeLessThanOrEqual(400 - STAMP_FIELD_GAP);
  });

  it('rides up over the HUD rather than onto the field when even the smallest size has no room', () => {
    const { box, scale } = planRankStamp({ ...roomy, ceiling: 395 });
    expect(scale).toBe(STAMP_MIN_SCALE);
    expect(bottomOf(box)).toBeCloseTo(400 - STAMP_FIELD_GAP, 6);
  });

  it('drops below an open meter card sharing its column', () => {
    const card: Box = { left: 200, top: 160, width: 176, height: 100 };
    const rails: RailPlan = {
      zone: 'crown',
      left: null,
      right: { side: 'right', rail: { ...card, left: 354, width: 22 }, card },
    };
    const { box } = planRankStamp({ ...roomy, rails });
    expect(box.top).toBeGreaterThanOrEqual(268);
    expect(boxesIntersect(box, card)).toBe(false);
  });

  it('ignores meters below the field', () => {
    const card: Box = { left: 200, top: 520, width: 176, height: 100 };
    const rails: RailPlan = {
      zone: 'apron',
      left: null,
      right: { side: 'right', rail: { ...card, left: 354, width: 22 }, card },
    };
    expect(planRankStamp({ ...roomy, rails })).toEqual(planRankStamp(roomy));
  });

  it('narrows a ribbon wider than the screen and keeps it inside the margins', () => {
    const { box, scale } = planRankStamp({ ...roomy, card: { width: 600, height: 60 } });
    expect(scale).toBeCloseTo((400 - 16) / 600, 6);
    expect(box.left).toBeCloseTo(8, 6);
    expect(box.left + box.width).toBeCloseTo(392, 6);
  });

  it('slides along to stay on screen when the floor sits off-centre', () => {
    const { box } = planRankStamp({ ...roomy, floor: { ...roomy.floor, left: -150 } });
    expect(box.left).toBeCloseTo(8, 6);
  });
});

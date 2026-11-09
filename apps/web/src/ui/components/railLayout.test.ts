import { cascade } from '@coinposh/economy';
import { describe, expect, it } from 'vitest';
import deUi from '../../i18n/locales/de/ui.json';
import enUi from '../../i18n/locales/en/ui.json';
import frUi from '../../i18n/locales/fr/ui.json';
import { formatDecimal, type Language } from '../../i18n/index.ts';
import { Spring, SPRINGS } from '../motion/spring.ts';
import {
  boxContains,
  boxesIntersect,
  CAPTION_MIN_SCALE,
  cardReveal,
  coinFloorRect,
  fitCaption,
  planMeterRails,
  RAIL_MAX_WIDTH,
  railBox,
  swellOverhang,
  type Box,
  type Insets,
  type RailPlan,
  type RailPlanInput,
  type RailSlot,
} from './railLayout.ts';

const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

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
  { name: '360x780', width: 360, height: 780, plaqueBottom: 150, dockTop: 714 },
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

/** The Concierge notice drops in under the plaque while the table is frozen. */
const CONCIERGE_NOTICE = 56;
/** Open fractions an underdamped spring passes through, overshoot included. */
const MORPH_SAMPLES = Array.from({ length: 25 }, (_, i) => -0.1 + i * 0.05);

function inputFor(screen: Screen, extraCeiling = 0): RailPlanInput {
  return {
    viewport: { width: screen.width, height: screen.height },
    safe: screen.safe ?? NO_INSETS,
    floor: coinFloorRect(screen.width, screen.height),
    ceiling: screen.plaqueBottom + extraCeiling,
    base: screen.dockTop,
  };
}

function slotsOf(plan: RailPlan): RailSlot[] {
  return [plan.left, plan.right].filter((slot): slot is RailSlot => slot !== null);
}

/** Every box a meter can occupy: the rail at boot, the card in a cascade, and the morph between. */
function boxesOf(slot: RailSlot): Box[] {
  return [
    slot.rail,
    ...(slot.card ? [slot.card] : []),
    ...MORPH_SAMPLES.map((t) => railBox(slot, t)),
  ];
}

describe('coinFloorRect', () => {
  it('matches the floor the 390x844 portrait camera frames', () => {
    const floor = coinFloorRect(390, 844);
    expect(floor.left).toBeGreaterThan(14);
    expect(floor.left + floor.width).toBeLessThan(376);
    expect(floor.top).toBeGreaterThan(164);
    expect(floor.top + floor.height).toBeLessThan(774);
    expect(floor.width).toBeGreaterThan(0.9 * 390);
  });
});

describe('planMeterRails', () => {
  for (const screen of SCREENS) {
    for (const [label, extra] of [
      ['', 0],
      [' with the Concierge notice', CONCIERGE_NOTICE],
    ] as const) {
      describe(`${screen.name}${label}`, () => {
        const input = inputFor(screen, extra);
        const plan = planMeterRails(input);
        const safeArea: Box = {
          left: input.safe.left,
          top: input.safe.top,
          width: screen.width - input.safe.left - input.safe.right,
          height: screen.height - input.safe.top - input.safe.bottom,
        };

        it('places both meters', () => {
          expect(plan.left).not.toBeNull();
          expect(plan.right).not.toBeNull();
          expect(plan.left?.side).toBe('left');
          expect(plan.right?.side).toBe('right');
        });

        it('collapses each meter to a slim rail', () => {
          for (const slot of slotsOf(plan)) {
            expect(slot.rail.width).toBeLessThanOrEqual(RAIL_MAX_WIDTH);
            expect(slot.rail.height).toBeGreaterThan(slot.rail.width * 2);
          }
        });

        it('never covers the coin floor, closed, open or in between', () => {
          for (const slot of slotsOf(plan)) {
            for (const box of boxesOf(slot)) expect(boxesIntersect(box, input.floor)).toBe(false);
          }
        });

        it('stays inside the safe area, so nothing is clipped by the viewport', () => {
          for (const slot of slotsOf(plan)) {
            for (const box of boxesOf(slot)) expect(boxContains(safeArea, box)).toBe(true);
          }
        });

        it('hugs the viewport edges', () => {
          if (plan.left) expect(plan.left.rail.left - input.safe.left).toBeLessThanOrEqual(6);
          if (plan.right) {
            const right = plan.right.rail.left + plan.right.rail.width;
            expect(screen.width - input.safe.right - right).toBeLessThanOrEqual(6);
          }
        });

        it('keeps clear of the plaque above and the dock below', () => {
          for (const slot of slotsOf(plan)) {
            for (const box of boxesOf(slot)) {
              expect(box.top).toBeGreaterThanOrEqual(input.ceiling);
              expect(box.top + box.height).toBeLessThanOrEqual(input.base);
            }
          }
        });

        it('opens the two cards without them touching', () => {
          const { left, right } = plan;
          if (!left?.card || !right?.card) return;
          expect(boxesIntersect(left.card, right.card)).toBe(false);
        });
      });
    }
  }

  it('gives the 390x844 phone open cards in the crown above the floor', () => {
    const input = inputFor(PHONE);
    const plan = planMeterRails(input);
    expect(plan.zone).toBe('crown');
    for (const slot of slotsOf(plan)) {
      expect(slot.card).not.toBeNull();
      expect(slot.rail.top + slot.rail.height).toBeLessThan(input.floor.top);
    }
  });

  it('flanks the floor on a landscape screen with room beside it', () => {
    const landscape = SCREENS.find((screen) => screen.name === '844x390');
    if (!landscape) throw new Error('844x390 screen is missing from SCREENS');
    expect(planMeterRails(inputFor(landscape)).zone).toBe('flank');
  });

  it('falls back to the apron below the lip when the crown is taken', () => {
    const input = { ...inputFor(PHONE), ceiling: coinFloorRect(390, 844).top - 20 };
    const plan = planMeterRails(input);
    expect(plan.zone).toBe('apron');
    for (const slot of slotsOf(plan)) {
      expect(slot.rail.top).toBeGreaterThan(input.floor.top + input.floor.height);
    }
  });

  it('keeps edge rails beside the floor, without cards, when no band is free', () => {
    const floor = coinFloorRect(390, 844);
    const input = {
      ...inputFor(PHONE),
      ceiling: floor.top - 20,
      base: floor.top + floor.height + 20,
    };
    const plan = planMeterRails(input);
    expect(plan.zone).toBe('edge');
    for (const slot of slotsOf(plan)) {
      expect(slot.card).toBeNull();
      expect(boxesIntersect(slot.rail, floor)).toBe(false);
      expect(slot.rail.width).toBeGreaterThanOrEqual(6);
    }
  });

  it('drops the rails rather than cover a floor that reaches the screen edge', () => {
    const input: RailPlanInput = {
      ...inputFor(PHONE),
      floor: { left: 2, top: 150, width: 386, height: 650 },
    };
    const plan = planMeterRails(input);
    expect(plan.left).toBeNull();
    expect(plan.right).toBeNull();
  });
});

describe('railBox', () => {
  const slot = planMeterRails(inputFor(PHONE)).right;

  it('grows from the outer edge inward and stops at the card', () => {
    if (!slot?.card) throw new Error('390x844 plan has no right card');
    const outer = slot.rail.left + slot.rail.width;
    for (const t of MORPH_SAMPLES) {
      const box = railBox(slot, t);
      expect(box.left + box.width).toBeCloseTo(outer);
      expect(box.width).toBeGreaterThanOrEqual(slot.rail.width);
      expect(box.width).toBeLessThanOrEqual(slot.card.width);
    }
    expect(railBox(slot, 0)).toEqual(slot.rail);
    expect(railBox(slot, 1).width).toBeCloseTo(slot.card.width);
  });
});

describe('cardReveal', () => {
  /** Field-side insets of real captions, from a full-width "OBSCÈNE ×3" to a short "Chic ×1.1". */
  const INSETS = [-4, 0, 1, 6, 12, 40, 90];

  for (const screen of SCREENS.filter((s) => ['390x844', '360x780', '360x640'].includes(s.name))) {
    for (const side of ['left', 'right'] as const) {
      const slot = planMeterRails(inputFor(screen))[side];

      it(`${screen.name} ${side}: shows a card's contents only once the box has uncovered them`, () => {
        if (!slot?.card) throw new Error(`${screen.name} plan has no ${side} card`);
        const card = slot.card;
        for (const inset of INSETS.filter((i) => i > 0)) {
          const reach = card.width - inset;
          const leading = side === 'right' ? card.left + card.width - reach : card.left + reach;
          for (const t of MORPH_SAMPLES) {
            const box = railBox(slot, t);
            if (cardReveal(box.width, card.width, inset) === 0) continue;
            expect(leading).toBeGreaterThanOrEqual(box.left - 1e-6);
            expect(leading).toBeLessThanOrEqual(box.left + box.width + 1e-6);
          }
        }
      });

      it(`${screen.name} ${side}: shows the contents in full once the card is open`, () => {
        if (!slot?.card) throw new Error(`${screen.name} plan has no ${side} card`);
        for (const inset of INSETS) {
          expect(cardReveal(railBox(slot, 1).width, slot.card.width, inset)).toBe(1);
          expect(cardReveal(slot.rail.width, slot.card.width, inset)).toBe(0);
        }
      });

      it(`${screen.name} ${side}: holds back contents wider than the card until it is open`, () => {
        if (!slot?.card) throw new Error(`${screen.name} plan has no ${side} card`);
        for (const t of MORPH_SAMPLES.filter((t) => t < 1)) {
          expect(cardReveal(railBox(slot, t).width, slot.card.width, -4)).toBe(0);
        }
      });
    }
  }

  it('fades in rather than popping, and never runs backwards as the box grows', () => {
    let previous = 0;
    const seen = new Set<number>();
    for (let width = 22; width <= 176; width += 0.5) {
      const reveal = cardReveal(width, 176, 12);
      expect(reveal).toBeGreaterThanOrEqual(previous);
      previous = reveal;
      seen.add(Math.round(reveal * 10));
    }
    expect(seen.size).toBeGreaterThan(5);
  });
});

describe('fitCaption', () => {
  it('keeps the name and multiplier on one line when they fit', () => {
    expect(fitCaption({ room: 136, name: 78, multiplier: 35, gap: 6 })).toEqual({
      stacked: false,
      scale: 1,
    });
  });

  it('sets the multiplier under a name that cannot share its line', () => {
    expect(fitCaption({ room: 108, name: 78, multiplier: 35, gap: 6 })).toEqual({
      stacked: true,
      scale: 1,
    });
  });

  it('wraps at the exact boundary only once the line overflows', () => {
    expect(fitCaption({ room: 119, name: 78, multiplier: 35, gap: 6 }).stacked).toBe(false);
    expect(fitCaption({ room: 118.9, name: 78, multiplier: 35, gap: 6 }).stacked).toBe(true);
  });

  it('shrinks a name too long for a line of its own until it fits', () => {
    const fit = fitCaption({ room: 90, name: 120, multiplier: 30, gap: 6 });
    expect(fit.stacked).toBe(true);
    expect(120 * fit.scale).toBeCloseTo(90);
  });

  it('fits every name and multiplier the card can hold', () => {
    for (let room = 60; room <= 160; room += 7) {
      for (let name = 20; name <= room / CAPTION_MIN_SCALE; name += 9) {
        for (const multiplier of [16, 27, 35]) {
          if (multiplier > room) continue;
          const fit = fitCaption({ room, name, multiplier, gap: 6 });
          const line = fit.stacked ? Math.max(name * fit.scale, multiplier) : name + 6 + multiplier;
          expect(line).toBeLessThanOrEqual(room + 1e-9);
          expect(fit.scale).toBeGreaterThanOrEqual(CAPTION_MIN_SCALE);
          expect(fit.scale).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('stops shrinking at the floor rather than shrink a name to nothing', () => {
    expect(fitCaption({ room: 10, name: 200, multiplier: 8, gap: 6 }).scale).toBe(
      CAPTION_MIN_SCALE,
    );
  });
});

/**
 * Natural widths in CSS px of every rank name (20px display face) and multiplier (15px), measured
 * in Chromium from the preview at 390x844. A renamed rank fails the coverage test below, so its
 * width is measured again rather than guessed.
 */
const NAME_WIDTHS: Readonly<Record<string, number>> = {
  Chic: 40,
  Lavish: 57.81,
  Opulent: 70.03,
  Decadent: 79.98,
  OBSCENE: 95.59,
  Fastueux: 77.8,
  Décadent: 79.98,
  OBSCÈNE: 95.59,
  Üppig: 52.25,
  Dekadent: 82.23,
  OBSZÖN: 83.36,
};
const MULTIPLIER_WIDTHS: Readonly<Record<string, number>> = {
  '×1.1': 27.31,
  '×1,1': 27.31,
  '×1.25': 34.81,
  '×1,25': 34.81,
  '×1.5': 27.31,
  '×1,5': 27.31,
  '×2': 16.06,
  '×3': 16.06,
};
const CAPTION_GAP = 6;
/** `.cp-rail` border and the right card's padding: 12px on the field side, 6px by the gauge. */
const RAIL_BORDER = 1;
const PAD_FIELD = 12;
const PAD_GAUGE = 6;
const LOCALES: Readonly<Record<Language, { combo: { tier: Record<string, string> } }>> = {
  en: enUi,
  fr: frUi,
  de: deUi,
};

/** Highest scale the rank-up swell reaches: the `pop` spring kicked as the Cascade ladder does. */
function peakSwell(): number {
  const spring = new Spring(1, SPRINGS.pop);
  spring.impulse(6);
  let peak = 1;
  for (let i = 0; i < 600 && !spring.step(1 / 240); i++) peak = Math.max(peak, spring.value);
  return peak;
}

/** Where the right rail's open card lays out a rank name and its multiplier, gauge side flush. */
function cascadeCard(slot: RailSlot | null, name: string, multiplier: string) {
  if (!slot?.card) throw new Error('The plan has no right card for the Cascade');
  const card = slot.card;
  const nameWidth = NAME_WIDTHS[name];
  const multWidth = MULTIPLIER_WIDTHS[multiplier];
  if (nameWidth === undefined || multWidth === undefined) {
    throw new Error(`Measure "${name}" and "${multiplier}" in the browser and add their widths`);
  }
  const frame: Box = {
    left: card.left + RAIL_BORDER,
    top: card.top,
    width: card.width - slot.rail.width,
    height: card.height,
  };
  const spine: Box = {
    left: frame.left + frame.width,
    top: card.top,
    width: slot.rail.width - 2 * RAIL_BORDER,
    height: card.height,
  };
  const fit = fitCaption({
    room: frame.width - PAD_FIELD - PAD_GAUGE,
    name: nameWidth,
    multiplier: multWidth,
    gap: CAPTION_GAP,
  });
  const drawn = nameWidth * fit.scale;
  const contentRight = frame.left + frame.width - PAD_GAUGE;
  const nameRight = fit.stacked ? contentRight : contentRight - multWidth - CAPTION_GAP;
  const top = card.top + 8;
  const nameBox: Box = { left: nameRight - drawn, top, width: drawn, height: 22 };
  const multBox: Box = { left: contentRight - multWidth, top, width: multWidth, height: 17 };
  return { slot: { ...slot, card }, frame, spine, fit, nameBox, multBox };
}

describe('Cascade card with the real rank names', () => {
  const peak = peakSwell();

  it('swells the name visibly on a rank-up', () => {
    expect(peak).toBeGreaterThan(1.05);
  });

  it('has a measured width for every rank name and multiplier in EN, FR and DE', () => {
    for (const language of Object.keys(LOCALES) as Language[]) {
      for (const tier of cascade.tiers) {
        expect(NAME_WIDTHS[LOCALES[language].combo.tier[tier.id] ?? '']).toBeDefined();
        expect(MULTIPLIER_WIDTHS[`×${formatDecimal(tier.multiplier, language)}`]).toBeDefined();
      }
    }
  });

  for (const screen of SCREENS.filter((s) => ['390x844', '360x780'].includes(s.name))) {
    const slot = planMeterRails(inputFor(screen)).right;

    for (const language of Object.keys(LOCALES) as Language[]) {
      for (const tier of cascade.tiers) {
        const name = LOCALES[language].combo.tier[tier.id] ?? '';
        const label = `${screen.name} ${language} "${name}"`;

        const multiplier = `×${formatDecimal(tier.multiplier, language)}`;

        it(`${label}: sits inside its card frame and leaves the flute clear`, () => {
          const { frame, spine, fit, nameBox, multBox } = cascadeCard(slot, name, multiplier);
          expect(fit.scale).toBe(1);
          for (const box of [nameBox, multBox]) {
            expect(box.left).toBeGreaterThanOrEqual(frame.left + PAD_FIELD - 1e-6);
            expect(boxContains(frame, box)).toBe(true);
            expect(boxesIntersect(box, spine)).toBe(false);
          }
          expect(boxesIntersect(frame, spine)).toBe(false);
          if (!fit.stacked) expect(boxesIntersect(nameBox, multBox)).toBe(false);
        });

        it(`${label}: never shows past the opening box, even mid-swell`, () => {
          const { slot: open, frame, fit, nameBox } = cascadeCard(slot, name, multiplier);
          // The stacked name swells about its gauge-side edge, an unstacked one about its centre.
          const reach = fit.stacked ? nameBox.width : nameBox.width / 2;
          // The caption alone is the narrowest the contents get, so this is their largest inset.
          const inset = RAIL_BORDER + nameBox.left - frame.left;
          for (let step = 0; step <= 8; step++) {
            const overhang = swellOverhang(1 + ((peak - 1) * step) / 8, reach);
            for (const t of MORPH_SAMPLES) {
              const box = railBox(open, t);
              if (cardReveal(box.width, open.card.width, inset - overhang) === 0) continue;
              expect(nameBox.left - overhang).toBeGreaterThanOrEqual(box.left - 1e-6);
            }
          }
        });
      }
    }
  }
});

describe('swellOverhang', () => {
  it('is nothing at rest or while the swell undershoots', () => {
    expect(swellOverhang(1, 40)).toBe(0);
    expect(swellOverhang(0.96, 40)).toBe(0);
  });

  it('grows with the scale and with the distance to the origin', () => {
    expect(swellOverhang(1.2, 40)).toBeCloseTo(8);
    expect(swellOverhang(1.2, 80)).toBeCloseTo(16);
    expect(swellOverhang(1.2, 0)).toBe(0);
  });
});

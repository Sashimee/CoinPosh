import { Group, Mesh, PerspectiveCamera, Vector3, type Object3D } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { PLAQUE_SWELL } from '../../../game/crates/hint.ts';
import {
  CARD_CHROME_GAP,
  crateCardAside,
  placeCrateCard,
} from '../../../game/crates/revealCard.ts';
import { rivieraCameraPreset } from '../../../scene/venues/riviera/layout.ts';
import type { HapticPattern } from '../../haptics.ts';
import type { ContactOptions } from '../../index.ts';
import { UnboxCinematic, type UnboxVfx } from './cinematic.ts';
import { UNBOX_HEROES, type UnboxHero } from './hero.ts';
import { FULL_UNBOX, PRESENT_JUICE, REDUCED_UNBOX, unboxPose } from './plan.ts';
import {
  freeBands,
  MIN_PRESENT_SCALE,
  postUnboxClearance,
  presentHero,
  PRESENT_GAP,
  screenBox,
  shareOutside,
  unboxClearance,
  type ScreenRect,
  type UnboxClearance,
} from './presentation.ts';
import { UnboxAssets } from './stage.ts';

const TRAY = new Vector3(0.01, -0.075, 0.4);
const FPS = 60;
/** The four-line reward card at its natural size, as seeded Demo Mode lays it out. */
const CARD = { width: 340, height: 401 };

interface Screen {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** The Vault plaque and the dock top, measured in seeded Demo Mode. */
  readonly plaque: { readonly top: number; readonly bottom: number };
  readonly dock: number;
}

const PORTRAIT: Screen = {
  name: '390x844',
  width: 390,
  height: 844,
  plaque: { top: 90.1, bottom: 163.6 },
  dock: 774,
};
const LANDSCAPE: Screen = {
  name: '844x390',
  width: 844,
  height: 390,
  plaque: { top: 73.1, bottom: 136.6 },
  dock: 322,
};

/** Where the reveal card rests on `screen` and what it posts, as `mountCrateReveal` does. */
function clearanceOn(screen: Screen): UnboxClearance {
  const { plaque } = screen;
  const at = placeCrateCard({
    viewportHeight: screen.height,
    plaque,
    base: screen.dock,
    cardHeight: CARD.height,
  });
  const width = Math.min(screen.width - 32, CARD.width) * at.scale;
  const shift = crateCardAside({
    viewportWidth: screen.width,
    plaque,
    top: at.top,
    cardWidth: width,
  });
  const left = (screen.width - width) / 2 + shift;
  const swell = ((plaque.bottom - plaque.top) * PLAQUE_SWELL) / 2;
  return {
    viewport: { width: screen.width, height: screen.height },
    card: { left, top: at.top, right: left + width, bottom: at.top + CARD.height * at.scale },
    ceiling: (plaque.top + plaque.bottom) / 2 + swell,
    floor: screen.dock,
  };
}

const vertex = new Vector3();

/** The hero's drawn vertices projected to CSS pixels, as the GPU would place them. */
function heroBox(hero: Object3D, camera: PerspectiveCamera, screen: Screen): ScreenRect {
  hero.updateWorldMatrix(true, true);
  camera.updateMatrixWorld();
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  hero.traverseVisible((object) => {
    if (!(object instanceof Mesh)) return;
    const { geometry, matrixWorld } = object as Mesh;
    const positions = geometry.getAttribute('position');
    for (let i = 0; i < positions.count; i++) {
      vertex.fromBufferAttribute(positions, i).applyMatrix4(matrixWorld).project(camera);
      minX = Math.min(minX, vertex.x);
      maxX = Math.max(maxX, vertex.x);
      minY = Math.min(minY, vertex.y);
      maxY = Math.max(maxY, vertex.y);
    }
  });
  return {
    left: ((minX + 1) / 2) * screen.width,
    right: ((maxX + 1) / 2) * screen.width,
    top: ((1 - maxY) / 2) * screen.height,
    bottom: ((1 - minY) / 2) * screen.height,
  };
}

interface Run {
  /** The hero on screen per frame, by ms since the card came up. */
  readonly frames: { readonly sinceReveal: number; readonly box: ScreenRect }[];
  /** Spark bursts and haptic pulses once the card is up, with the frame they landed on. */
  readonly sparks: { readonly frame: number; readonly options: ContactOptions }[];
  readonly pulses: { readonly frame: number; readonly pattern: HapticPattern }[];
  readonly card: ScreenRect | null;
}

function play(
  screen: Screen,
  options: { hero?: UnboxHero; reducedMotion?: boolean; withCard?: boolean } = {},
): Run {
  const { hero = 'charm', reducedMotion = false, withCard = true } = options;
  const aspect = screen.width / screen.height;
  const camera = new PerspectiveCamera(40, aspect, 0.01, 50);
  const framing = rivieraCameraPreset(aspect);
  camera.fov = framing.fov;
  camera.position.copy(framing.position);
  camera.lookAt(framing.target);
  camera.updateProjectionMatrix();
  const timeline = reducedMotion ? REDUCED_UNBOX : FULL_UNBOX;
  const clearance = withCard ? clearanceOn(screen) : null;
  const parent = new Group();
  const card = { up: false };
  let frame = 0;
  const sparks: Run['sparks'] = [];
  const pulses: Run['pulses'] = [];
  const vfx: UnboxVfx = {
    hitStop: () => undefined,
    cameraKick: () => undefined,
    confetti: () => 0,
    contactSparks: (_at, spark) => {
      if (card.up) sparks.push({ frame, options: spark });
    },
  };
  const unbox = new UnboxCinematic({
    parent,
    assets: new UnboxAssets(parent),
    camera,
    framing: rivieraCameraPreset,
    at: TRAY,
    rarity: 'rare',
    hero,
    reducedMotion,
    vfx,
    haptics: {
      pulse: (pattern) => {
        if (card.up) pulses.push({ frame, pattern });
        return true;
      },
    },
    onBeat: (beat) => {
      if (beat.kind === 'reveal') card.up = true;
    },
    clearance: () => (card.up ? clearance : null),
  });
  const frames: Run['frames'] = [];
  while (unbox.elapsed < timeline.revealAtMs + 900) {
    unbox.update(1 / FPS);
    if (card.up) frame++;
    const sinceReveal = unbox.elapsed - timeline.revealAtMs;
    if (sinceReveal >= 0) {
      frames.push({ sinceReveal, box: heroBox(unbox.stage.heroObject, camera, screen) });
    }
  }
  unbox.dispose();
  return { frames, sparks, pulses, card: clearance?.card ?? null };
}

function frameAt(run: Run, ms: number): ScreenRect {
  const frame = run.frames.find((f) => f.sinceReveal >= ms);
  if (!frame) throw new Error(`The unbox drew no frame ${ms} ms after the card came up`);
  return frame.box;
}

function cardOf(run: Run): ScreenRect {
  if (!run.card) throw new Error('This run had no reward card');
  return run.card;
}

describe('hero presentation clear of the reward card', () => {
  for (const screen of [PORTRAIT, LANDSCAPE]) {
    it(`keeps at least 80 % of every hero outside the card 500 ms in at ${screen.name}`, () => {
      for (const hero of UNBOX_HEROES) {
        const run = play(screen, { hero });
        const box = frameAt(run, 500);
        expect(shareOutside(box, cardOf(run)), hero).toBeGreaterThanOrEqual(0.8);
      }
    });

    it(`stays under the swollen plaque, over the dock and on screen at ${screen.name}`, () => {
      const clearance = clearanceOn(screen);
      for (const hero of UNBOX_HEROES) {
        const box = frameAt(play(screen, { hero }), 500);
        expect(box.top, hero).toBeGreaterThanOrEqual(clearance.ceiling);
        expect(box.bottom, hero).toBeLessThanOrEqual(clearance.floor);
        expect(box.left, hero).toBeGreaterThanOrEqual(0);
        expect(box.right, hero).toBeLessThanOrEqual(screen.width);
      }
    });
  }

  it('was covered by the card before the lift, so the check above has teeth', () => {
    const run = play(PORTRAIT, { withCard: false });
    expect(shareOutside(frameAt(run, 500), clearanceOn(PORTRAIT).card)).toBeLessThan(0.5);
  });

  it('lifts into the band above the card in portrait, keeping the hero readable', () => {
    const run = play(PORTRAIT);
    const before = play(PORTRAIT, { withCard: false });
    const box = frameAt(run, 500);
    const rest = frameAt(before, 500);
    expect(box.bottom).toBeLessThanOrEqual(cardOf(run).top - PRESENT_GAP + 1);
    expect(box.right - box.left).toBeGreaterThanOrEqual(0.5 * (rest.right - rest.left));
  });

  it('steps the card right and stands the hero to its left in landscape', () => {
    const run = play(LANDSCAPE);
    const card = cardOf(run);
    expect(card.left).toBeGreaterThan((LANDSCAPE.width - (card.right - card.left)) / 2);
    expect(card.right).toBeLessThanOrEqual(LANDSCAPE.width - CARD_CHROME_GAP);
    expect(frameAt(run, 500).right).toBeLessThanOrEqual(card.left);
  });

  it('cuts straight to the final pose under reduced motion', () => {
    const run = play(PORTRAIT, { reducedMotion: true });
    const first = frameAt(run, 0);
    const held = frameAt(run, 500);
    expect(shareOutside(first, cardOf(run))).toBeGreaterThanOrEqual(0.8);
    for (const edge of ['left', 'top', 'right', 'bottom'] as const) {
      expect(Math.abs(first[edge] - held[edge]), edge).toBeLessThan(2);
    }
  });

  it('dips, overshoots its mark and settles on it in full motion', () => {
    const run = play(PORTRAIT);
    const settled = frameAt(run, 800);
    const tops = run.frames.filter((f) => f.sinceReveal <= 600).map((f) => f.box.top);
    expect(frameAt(run, 30).top).toBeGreaterThan(frameAt(run, 0).top);
    expect(Math.min(...tops)).toBeLessThan(settled.top - 1);
    expect(Math.abs(frameAt(run, 600).top - settled.top)).toBeLessThan(1);
  });

  it('marks the arrival once with soft metal sparks and a tick, only when a card is up', () => {
    const run = play(PORTRAIT);
    expect(run.sparks.map((s) => s.options)).toEqual([{ strength: 0.3, surface: 'metal' }]);
    expect(run.pulses.map((p) => p.pattern)).toEqual(['tick']);
    expect(run.pulses[0]?.frame).toBe(run.sparks[0]?.frame);
    const crossing = run.sparks[0]?.frame ?? Number.NaN;
    expect(crossing).toBeGreaterThan(FULL_UNBOX.presentMs / 4 / (1000 / FPS));
    expect(crossing).toBeLessThan(FULL_UNBOX.presentMs / (1000 / FPS));
    const bare = play(PORTRAIT, { withCard: false });
    expect(bare.sparks).toEqual([]);
    expect(bare.pulses).toEqual([]);
  });

  it('keeps the arrival sparks and tick under reduced motion, on the reveal frame', () => {
    const run = play(PORTRAIT, { reducedMotion: true });
    expect(run.sparks.map((s) => s.options)).toEqual([{ strength: 0.3, surface: 'metal' }]);
    expect(run.pulses.map((p) => p.pattern)).toEqual(['tick']);
    expect(run.sparks[0]?.frame).toBeLessThanOrEqual(1);
  });
});

describe('presentation pose', () => {
  const sample = (ms: number, reduced = false, fly: number | null = null) =>
    unboxPose(ms, reduced ? REDUCED_UNBOX : FULL_UNBOX, reduced, fly);
  const reveal = FULL_UNBOX.revealAtMs;

  it('rests on the pedestal until the card comes up', () => {
    for (const ms of [0, reveal / 2, reveal - 1]) {
      expect(sample(ms).present).toBe(0);
      expect(sample(ms).heroStretch).toBe(1);
      expect(sample(ms).glint).toBe(0);
    }
  });

  it('anticipates with a squashed dip, launches stretched past its mark, then settles', () => {
    const steps = Array.from({ length: 89 }, (_, i) => reveal + i * 5);
    const poses = steps.map((ms) => sample(ms));
    expect(Math.min(...poses.map((p) => p.present))).toBeLessThan(-0.03);
    expect(Math.max(...poses.map((p) => p.present))).toBeGreaterThan(1.05);
    expect(Math.min(...poses.map((p) => p.heroStretch))).toBeLessThan(0.95);
    expect(Math.max(...poses.map((p) => p.heroStretch))).toBeGreaterThan(1.03);
    expect(Math.max(...poses.map((p) => p.glint))).toBeGreaterThan(0.3);
    const done = sample(reveal + FULL_UNBOX.presentMs);
    expect(done.present).toBeCloseTo(1, 6);
    expect(done.heroStretch).toBe(1);
  });

  it('cuts to the mark on the reveal under reduced motion, keeping the glint', () => {
    const at = REDUCED_UNBOX.revealAtMs;
    expect(sample(at - 1, true).present).toBe(0);
    expect(sample(at, true).present).toBe(1);
    for (let ms = at; ms < at + 700; ms += 10) expect(sample(ms, true).heroStretch).toBe(1);
    expect(Math.max(...[300, 350, 400].map((d) => sample(at + d, true).glint))).toBeGreaterThan(0);
  });

  it('comes back down with the flight into the inventory', () => {
    const held = reveal + 2_000;
    expect(sample(held, false, 0).present).toBeCloseTo(1, 6);
    expect(sample(held, false, FULL_UNBOX.flyMs).present).toBe(0);
    expect(sample(held, true, 0).present).toBe(0);
  });

  it('delivers at least four juice items with a reduced variant', () => {
    expect(new Set(PRESENT_JUICE.items).size).toBeGreaterThanOrEqual(4);
    expect(PRESENT_JUICE.reduced.length).toBeGreaterThan(0);
  });
});

describe('presentHero layout math', () => {
  const camera = new PerspectiveCamera(40, PORTRAIT.width / PORTRAIT.height, 0.01, 50);
  camera.position.set(0, 0.4, 2);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  const pivot = new Vector3(0, 0, 0);
  const bound = [-1, 1].flatMap((x) =>
    [-1, 1].flatMap((y) => [-1, 1].map((z) => new Vector3(x * 0.15, y * 0.2, z * 0.15))),
  );

  it('moves a covered box into the band above the card, whole', () => {
    const clearance = clearanceOn(PORTRAIT);
    const rest = screenBox(camera, pivot, bound, new Vector3(), 1, clearance);
    expect(shareOutside(rest, clearance.card)).toBeLessThan(0.8);
    const fit = presentHero(camera, pivot, bound, clearance);
    const box = screenBox(camera, pivot, bound, fit.offset, fit.scale, clearance);
    expect(shareOutside(box, clearance.card)).toBe(1);
    expect(box.top).toBeGreaterThanOrEqual(clearance.ceiling + PRESENT_GAP - 0.5);
    expect(box.bottom).toBeLessThanOrEqual(clearance.card.top - PRESENT_GAP + 0.5);
    expect(fit.scale).toBeLessThanOrEqual(1);
    expect(fit.scale).toBeGreaterThanOrEqual(MIN_PRESENT_SCALE);
  });

  it('never grows a hero that already has room', () => {
    const roomy: UnboxClearance = {
      viewport: { width: PORTRAIT.width, height: PORTRAIT.height },
      card: { left: 25, top: 800, right: 365, bottom: 840 },
      ceiling: 0,
      floor: 844,
    };
    const fit = presentHero(camera, pivot, bound, roomy);
    expect(fit.scale).toBeLessThanOrEqual(1);
    const box = screenBox(camera, pivot, bound, fit.offset, fit.scale, roomy);
    expect(shareOutside(box, roomy.card)).toBe(1);
  });

  it('leaves the hero where it stands when no band is worth the trip', () => {
    const full: UnboxClearance = {
      viewport: { width: PORTRAIT.width, height: PORTRAIT.height },
      card: { left: 0, top: 20, right: PORTRAIT.width, bottom: PORTRAIT.height },
      ceiling: 0,
      floor: PORTRAIT.height,
    };
    const fit = presentHero(camera, pivot, bound, full);
    expect(fit.offset.lengthSq()).toBe(0);
    expect(fit.scale).toBe(1);
    const empty = { ...full, viewport: { width: 0, height: 0 } };
    expect(presentHero(camera, pivot, bound, empty).scale).toBe(1);
    expect(presentHero(camera, pivot, [], clearanceOn(PORTRAIT)).scale).toBe(1);
  });

  it('offers the band above in portrait and the bands beside in landscape', () => {
    const portrait = freeBands(clearanceOn(PORTRAIT));
    const landscape = freeBands(clearanceOn(LANDSCAPE));
    const tallest = (bands: ScreenRect[]) => Math.max(...bands.map((b) => b.bottom - b.top));
    const widest = (bands: ScreenRect[]) => Math.max(...bands.map((b) => b.right - b.left));
    expect(widest(portrait)).toBeGreaterThan(300);
    expect(tallest(landscape)).toBeGreaterThan(120);
    for (const band of [...portrait, ...landscape]) {
      expect(band.right).toBeGreaterThan(band.left);
      expect(band.bottom).toBeGreaterThan(band.top);
    }
  });

  it('scores the share outside the card from 1 clear to 0 covered', () => {
    const card = { left: 0, top: 0, right: 100, bottom: 100 };
    expect(shareOutside({ left: 200, top: 0, right: 300, bottom: 100 }, card)).toBe(1);
    expect(shareOutside({ left: 10, top: 10, right: 90, bottom: 90 }, card)).toBe(0);
    expect(shareOutside({ left: 50, top: 0, right: 150, bottom: 100 }, card)).toBe(0.5);
    expect(shareOutside({ left: 5, top: 5, right: 5, bottom: 5 }, card)).toBe(0);
  });
});

describe('crateCardAside', () => {
  it('keeps the card centred in portrait, where the band above is taller', () => {
    const at = placeCrateCard({
      viewportHeight: PORTRAIT.height,
      plaque: PORTRAIT.plaque,
      base: PORTRAIT.dock,
      cardHeight: CARD.height,
    });
    expect(
      crateCardAside({ viewportWidth: 390, plaque: PORTRAIT.plaque, top: at.top, cardWidth: 340 }),
    ).toBe(0);
  });

  it('steps the card right on a landscape phone without leaving the screen', () => {
    const { card } = clearanceOn(LANDSCAPE);
    const width = card.right - card.left;
    const shift = card.left - (LANDSCAPE.width - width) / 2;
    expect(shift).toBeGreaterThan(width / 2);
    expect(card.right).toBeLessThanOrEqual(LANDSCAPE.width - CARD_CHROME_GAP);
  });

  it('keeps the card centred when it has no width yet', () => {
    expect(crateCardAside({ viewportWidth: 844, plaque: null, top: 100, cardWidth: 0 })).toBe(0);
  });
});

describe('unbox clearance channel', () => {
  it('hands the playing cinematic what the card last posted', () => {
    const clearance = clearanceOn(PORTRAIT);
    postUnboxClearance(clearance);
    expect(unboxClearance()).toBe(clearance);
    postUnboxClearance(null);
    expect(unboxClearance()).toBeNull();
  });
});

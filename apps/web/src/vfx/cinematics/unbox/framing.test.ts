import { RARITIES, type Rarity } from '@coinposh/shared';
import { Group, Mesh, PerspectiveCamera, Vector3, type Object3D } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { createRng } from '../../../audio/rng.ts';
import { rivieraCameraPreset } from '../../../scene/venues/riviera/layout.ts';
import { CameraKick } from '../../camera/cameraKick.ts';
import { CONTACT_ACCENT, type ContactOptions } from '../../index.ts';
import { UnboxCinematic, type UnboxVfx } from './cinematic.ts';
import { FULL_UNBOX, REDUCED_UNBOX } from './plan.ts';
import { UnboxAssets } from './stage.ts';

const PORTRAIT = { width: 390, height: 844 };
const LANDSCAPE = { width: 844, height: 390 };
const FPS = 60;
/** The tray spot the table crate settles at, as `TableCrateView` hands it over. */
const TRAY = new Vector3(0.01, -0.075, 0.4);

interface Extent {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly width: number;
}

const vertex = new Vector3();

/** NDC extent of every visible vertex of the crate body and lid, as the GPU would draw them. */
function projected(crate: Object3D, camera: PerspectiveCamera): Extent {
  crate.updateWorldMatrix(true, true);
  camera.updateMatrixWorld();
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  crate.traverseVisible((object) => {
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
  return { minX, maxX, minY, maxY, width: (maxX - minX) / 2 };
}

interface Run {
  readonly frames: Extent[];
  readonly flareFrames: number;
  readonly lidBurstFrames: number;
  readonly sparks: ContactOptions[];
  readonly kicks: number;
  /** Camera FOV over the venue FOV once the reveal has held for a while. */
  readonly fovDrift: number;
}

/** Plays one unbox frame by frame with the real camera kick layered on top, like the game loop. */
function run(rarity: Rarity, reducedMotion: boolean, viewport: typeof PORTRAIT): Run {
  const aspect = viewport.width / viewport.height;
  const camera = new PerspectiveCamera(40, aspect, 0.01, 50);
  const framing = rivieraCameraPreset(aspect);
  camera.fov = framing.fov;
  camera.position.copy(framing.position);
  camera.lookAt(framing.target);
  camera.updateProjectionMatrix();
  const kick = new CameraKick(createRng(7));
  kick.reducedMotion = reducedMotion;
  const sparks: ContactOptions[] = [];
  let kicks = 0;
  const vfx: UnboxVfx = {
    hitStop: () => undefined,
    cameraKick: (options) => {
      kicks++;
      if (!reducedMotion) kick.kick(options);
    },
    confetti: () => 0,
    contactSparks: (_at, options) => sparks.push(options),
  };
  const parent = new Group();
  const unbox = new UnboxCinematic({
    parent,
    assets: new UnboxAssets(parent),
    camera,
    framing: rivieraCameraPreset,
    at: TRAY,
    rarity,
    hero: 'charm',
    reducedMotion,
    vfx,
  });
  const timeline = reducedMotion ? REDUCED_UNBOX : FULL_UNBOX;
  const frames: Extent[] = [];
  let flareFrames = 0;
  let lidBurstFrames = 0;
  const capture = (): void => {
    frames.push(projected(unbox.stage.crateObject, camera));
    if (unbox.stage.flareLevel > 0) flareFrames++;
    if (unbox.stage.lidVisible && unbox.pose.lidOpen > 0) lidBurstFrames++;
  };
  kick.update(0, camera);
  capture();
  while (unbox.elapsed < timeline.revealAtMs + 600) {
    unbox.update(1 / FPS);
    kick.update(1 / FPS, camera);
    capture();
  }
  const fovDrift = camera.fov - framing.fov;
  unbox.dispose();
  return { frames, flareFrames, lidBurstFrames, sparks, kicks, fovDrift };
}

function narrowest(frames: readonly Extent[]): number {
  return Math.min(...frames.map((frame) => frame.width));
}

function onScreen(frame: Extent): boolean {
  return frame.minX >= -1 && frame.maxX <= 1 && frame.minY >= -1 && frame.maxY <= 1;
}

describe('unbox framing at 390x844', () => {
  for (const reducedMotion of [false, true]) {
    const variant = reducedMotion ? 'reduced' : 'full';
    it(`keeps the crate whole on screen and at least 30 % wide every frame (${variant})`, () => {
      for (const rarity of RARITIES) {
        const { frames } = run(rarity, reducedMotion, PORTRAIT);
        expect(frames.length).toBeGreaterThan(30);
        expect(frames.filter((frame) => !onScreen(frame))).toEqual([]);
        expect(narrowest(frames)).toBeGreaterThanOrEqual(0.3);
      }
    });

    it(`shows the lid burst and its flare on screen (${variant})`, () => {
      const { flareFrames, lidBurstFrames } = run('legendary', reducedMotion, PORTRAIT);
      expect(flareFrames).toBeGreaterThan(0);
      if (!reducedMotion) expect(lidBurstFrames).toBeGreaterThan(0);
    });
  }

  it('keeps every spark burst under the accent flash, so no anamorphic streak crosses the frame', () => {
    for (const reducedMotion of [false, true]) {
      const { sparks } = run('heirloom', reducedMotion, PORTRAIT);
      expect(sparks.length).toBeGreaterThan(0);
      for (const spark of sparks) expect(spark.strength).toBeLessThanOrEqual(CONTACT_ACCENT);
    }
  });
});

/**
 * Landscape targets, each the measured maximum less about 0.01. Reduced motion holds the crate
 * still, so it clears the portrait 30 %. The full cinematic is bound by its tallest frame, the
 * lid blowing clear on the spring, inside the shot's 90 % frame limit: that caps its narrowest
 * frame, face on mid spin-in before the push-in, at 17.2 % of the width and the settled reveal
 * at 23 %, so 30 % on every frame cannot fit at 844x390 without cropping the burst.
 */
const LANDSCAPE_TARGET = {
  full: { narrowest: 0.16, tallest: 0.87, holdWidth: 0.22, holdHeight: 0.5 },
  reduced: { narrowest: 0.36, tallest: 0.89, holdWidth: 0.36, holdHeight: 0.76 },
} as const;

describe('unbox framing at 844x390', () => {
  for (const reducedMotion of [false, true]) {
    const variant = reducedMotion ? 'reduced' : 'full';
    const target = LANDSCAPE_TARGET[variant];
    it(`keeps the crate whole on screen and as large as the height allows (${variant})`, () => {
      for (const rarity of RARITIES) {
        const { frames } = run(rarity, reducedMotion, LANDSCAPE);
        expect(frames.filter((frame) => !onScreen(frame))).toEqual([]);
        const height = (frame: Extent): number => (frame.maxY - frame.minY) / 2;
        expect(Math.max(...frames.map(height))).toBeGreaterThanOrEqual(target.tallest);
        expect(narrowest(frames)).toBeGreaterThanOrEqual(target.narrowest);
        const hold = frames.at(-1);
        if (!hold) throw new Error('The landscape unbox drew no frames');
        expect(hold.width).toBeGreaterThanOrEqual(target.holdWidth);
        expect(height(hold)).toBeGreaterThanOrEqual(target.holdHeight);
      }
    });
  }

  it('springs every burst FOV punch back instead of stacking it into the base', () => {
    for (const rarity of RARITIES) {
      const { fovDrift } = run(rarity, false, LANDSCAPE);
      expect(Math.abs(fovDrift)).toBeLessThan(0.01);
    }
  });

  it('spends the height budget: some frame reaches within 6 % of the frame edge', () => {
    for (const reducedMotion of [false, true]) {
      const { frames } = run('common', reducedMotion, LANDSCAPE);
      const reach = Math.max(...frames.map((frame) => Math.max(-frame.minY, frame.maxY)));
      expect(reach).toBeGreaterThan(0.84);
    }
  });
});

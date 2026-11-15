import { BOSS_KINDS, WeekKeySchema, type BossHit, type BossKind } from '@coinposh/shared';
import { Mesh, PerspectiveCamera, Sprite, Vector3, type Object3D } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { createBus } from '../../app/bus.ts';
import type { GameEvents } from '../../game/systems/events.ts';
import {
  applyCameraPreset,
  RIVIERA_TABLE,
  rivieraCameraPreset,
} from '../venues/riviera/layout.ts';
import { BOSS_STAND, bossStand } from './layout.ts';
import { createBossPresence, type BossPresence, type BossPresenceOptions } from './presence.ts';
import { REACTION_SECONDS } from './reaction.ts';

const FRAME = 1 / 60;
const ASPECT = 390 / 844;

function boss(options: Omit<BossPresenceOptions, 'aspect'>): BossPresence {
  return createBossPresence({ aspect: ASPECT, ...options });
}

function presetCamera(width: number, height: number): PerspectiveCamera {
  const camera = new PerspectiveCamera(35, width / height, 0.02, 120);
  applyCameraPreset(camera, rivieraCameraPreset(width / height));
  camera.updateMatrixWorld();
  return camera;
}

/** The highest NDC y and the widest NDC |x| of the named meshes' vertices, as `camera` sees them. */
function extent(root: Object3D, camera: PerspectiveCamera, names: readonly string[]) {
  root.updateMatrixWorld(true);
  const v = new Vector3();
  let top = -Infinity;
  let bottom = Infinity;
  let wide = 0;
  root.traverse((node) => {
    if (!(node instanceof Mesh) || !names.includes(node.name)) return;
    const position = (node as Mesh).geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i).applyMatrix4(node.matrixWorld).project(camera);
      top = Math.max(top, v.y);
      bottom = Math.min(bottom, v.y);
      wide = Math.max(wide, Math.abs(v.x));
    }
  });
  return { top, bottom, wide };
}

const ALL_PARTS = ['boss/torso', 'boss/head-mesh', 'boss/hat', 'boss/arm', 'boss/monocle'];
const VIEWPORTS = [
  [390, 844],
  [844, 390],
  [768, 1024],
] as const;

function hitOn(kind: BossKind, dealt: number, defeated = false): BossHit {
  return {
    week: WeekKeySchema.parse('2026-W46'),
    kind,
    dealt,
    damage: 500_000 + dealt,
    health: 500_000 - dealt,
    maxHealth: 1_000_000,
    defeated,
  };
}

function draws(root: Object3D): { meshes: number; sprites: number; triangles: number } {
  let meshes = 0;
  let sprites = 0;
  let triangles = 0;
  root.traverse((node) => {
    if (node instanceof Mesh) {
      meshes++;
      const geometry = (node as Mesh).geometry;
      triangles += (geometry.index?.count ?? geometry.getAttribute('position').count) / 3;
    }
    if (node instanceof Sprite) sprites++;
  });
  return { meshes, sprites, triangles };
}

function frames(presence: { update(dt: number): void }, seconds: number): void {
  for (let t = 0; t < seconds; t += FRAME) presence.update(FRAME);
}

describe('createBossPresence', () => {
  it.each(BOSS_KINDS)('%s stays inside the draw and triangle budget', (kind) => {
    const presence = boss({ kind });
    const { meshes, sprites, triangles } = draws(presence.object3d);
    expect(meshes).toBeLessThanOrEqual(5);
    expect(sprites).toBe(1);
    expect(triangles).toBeLessThan(12_000);
    const materials = new Set<unknown>();
    presence.object3d.traverse((node) => {
      if (node instanceof Mesh) materials.add(node.material);
    });
    expect(materials.size).toBe(1);
    presence.dispose();
  });

  it.each(VIEWPORTS)(
    'keeps both heads and hats in the %ix%i game frame through an obscene shock',
    (width, height) => {
      const camera = presetCamera(width, height);
      const bus = createBus<GameEvents>();
      const figures = [
        createBossPresence({ kind: 'taxInspector', events: bus, side: -1, aspect: width / height }),
        createBossPresence({ kind: 'rivalTycoon', events: bus, aspect: width / height }),
      ];
      const T = RIVIERA_TABLE;
      for (const figure of figures) {
        figure.update(FRAME);
        const wallEdge = new Vector3(
          figure.object3d.position.x,
          T.pusherHeight + 0.004 + T.backboardHeight,
          T.backboardFrontZ - T.backboardDepth,
        ).project(camera).y;
        const head = extent(figure.object3d, camera, ['boss/head-mesh']);
        expect(head.top - wallEdge).toBeGreaterThan(0.4 * (head.top - head.bottom));
      }
      bus.emit('cascade:tier', { tier: 'obscene', rank: 5, count: 40 });
      let peakRise = 0;
      for (let t = 0; t < REACTION_SECONDS.shock; t += FRAME) {
        for (const figure of figures) {
          figure.update(FRAME);
          peakRise = Math.max(peakRise, figure.pose.rise);
          const head = extent(figure.object3d, camera, ['boss/head-mesh', 'boss/hat']);
          expect(head.top).toBeLessThan(1);
          expect(extent(figure.object3d, camera, ALL_PARTS).wide).toBeLessThan(1);
        }
      }
      expect(peakRise).toBeGreaterThan(0.02);
      for (const figure of figures) figure.dispose();
    },
  );

  it('refits its stand when the view changes aspect', () => {
    const presence = boss({ kind: 'rivalTycoon' });
    const portrait = presence.object3d.scale.y;
    presence.setAspect(16 / 9);
    expect(presence.object3d.scale.y).toBeCloseTo(bossStand(1, 16 / 9).scale);
    expect(presence.object3d.position.y).toBeCloseTo(bossStand(1, 16 / 9).position.y);
    presence.setAspect(ASPECT);
    expect(presence.object3d.scale.y).toBeCloseTo(portrait);
    presence.dispose();
  });

  it('stands behind the backboard on its side, turned towards the table', () => {
    const right = boss({ kind: 'rivalTycoon' });
    const left = boss({ kind: 'taxInspector', side: -1 });
    const stand = bossStand(1, ASPECT);
    expect(right.object3d.position.x).toBeCloseTo(stand.position.x);
    expect(left.object3d.position.x).toBeCloseTo(-stand.position.x);
    expect(right.object3d.position.x).toBeGreaterThan(0);
    expect(right.object3d.position.z).toBeCloseTo(BOSS_STAND.z);
    expect(Math.sign(right.object3d.rotation.y)).toBe(-Math.sign(left.object3d.rotation.y));
    expect(left.object3d.scale.x).toBeLessThan(0);
    right.dispose();
    left.dispose();
  });

  it('reacts to cascades on the game bus', () => {
    const bus = createBus<GameEvents>();
    const presence = boss({ kind: 'taxInspector', events: bus });
    const rest = presence.pose.rise;
    bus.emit('cascade:step', { count: 4, tier: 'chic' });
    bus.emit('cascade:tier', { tier: 'chic', rank: 1, count: 4 });
    expect(presence.reaction.mood).toBe('idle');
    bus.emit('cascade:tier', { tier: 'lavish', rank: 2, count: 8 });
    expect(presence.reaction.mood).toBe('watch');
    bus.emit('cascade:tier', { tier: 'obscene', rank: 5, count: 40 });
    expect(presence.reaction.mood).toBe('shock');
    frames(presence, 0.15);
    expect(presence.pose.rise).toBeGreaterThan(rest);
    expect(presence.pose.hatLift).toBeGreaterThan(0);
    bus.emit('cascade:end', { count: 40, tier: 'obscene' });
    frames(presence, REACTION_SECONDS.shock + REACTION_SECONDS.watchLinger + 0.1);
    expect(presence.reaction.mood).toBe('idle');
    presence.dispose();
  });

  it('unsubscribes from the bus on dispose', () => {
    const bus = createBus<GameEvents>();
    const presence = boss({ kind: 'rivalTycoon', events: bus });
    presence.dispose();
    bus.emit('cascade:tier', { tier: 'obscene', rank: 5, count: 40 });
    expect(presence.reaction.mood).toBe('idle');
    expect(presence.object3d.parent).toBeNull();
  });

  it('flinches only at hits on its own boss, and a defeating hit ends the week', () => {
    const presence = boss({ kind: 'rivalTycoon' });
    presence.hit(hitOn('taxInspector', 50_000));
    expect(presence.reaction.mood).toBe('idle');
    presence.hit(hitOn('rivalTycoon', 50_000));
    expect(presence.reaction).toMatchObject({ mood: 'flinch', strength: 1 });
    frames(presence, REACTION_SECONDS.flinch + 0.05);
    expect(presence.reaction.mood).toBe('idle');
    presence.hit(hitOn('rivalTycoon', 1, true));
    expect(presence.reaction.mood).toBe('defeated');
    presence.dispose();
  });

  it.each(['defeated', 'escaped'] as const)(
    'sinks out of sight and hides once %s, and comes back on active',
    (status) => {
      const presence = boss({ kind: 'taxInspector' });
      presence.setStatus(status);
      frames(presence, 0.5);
      expect(presence.object3d.visible).toBe(true);
      frames(presence, REACTION_SECONDS.exit);
      expect(presence.object3d.visible).toBe(false);
      presence.setStatus('active');
      presence.update(FRAME);
      expect(presence.object3d.visible).toBe(true);
      expect(presence.reaction.mood).toBe('idle');
      presence.dispose();
    },
  );

  it('starts hidden when created for a finished week', () => {
    const presence = boss({ kind: 'rivalTycoon', status: 'escaped' });
    presence.update(FRAME);
    expect(presence.object3d.visible).toBe(false);
    presence.dispose();
  });

  it('holds still under reduced motion and eases into it when switched on', () => {
    const still = boss({ kind: 'taxInspector', reducedMotion: true });
    frames(still, 1);
    const a = { ...still.pose };
    frames(still, 1.3);
    expect(still.pose).toEqual(a);
    still.dispose();

    const moving = boss({ kind: 'taxInspector' });
    frames(moving, 1);
    moving.setReducedMotion(true);
    const before = moving.pose.rise;
    moving.update(FRAME);
    expect(Math.abs(moving.pose.rise - before)).toBeLessThan(0.01);
    frames(moving, 2);
    expect(moving.pose.rise).toBe(0);
    moving.dispose();
  });

  it('survives a huge or broken frame step', () => {
    const presence = boss({ kind: 'rivalTycoon' });
    presence.update(Number.NaN);
    presence.update(-1);
    presence.update(1e9);
    for (const value of Object.values(presence.pose)) expect(Number.isFinite(value)).toBe(true);
    presence.dispose();
  });
});

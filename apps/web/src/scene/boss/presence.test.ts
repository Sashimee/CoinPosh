import { BOSS_KINDS, WeekKeySchema, type BossHit, type BossKind } from '@coinposh/shared';
import { Mesh, Sprite, type Object3D } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { createBus } from '../../app/bus.ts';
import type { GameEvents } from '../../game/systems/events.ts';
import { BOSS_STAND } from './layout.ts';
import { createBossPresence } from './presence.ts';
import { REACTION_SECONDS } from './reaction.ts';

const FRAME = 1 / 60;

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
    const presence = createBossPresence({ kind });
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

  it('stands behind the backboard on its side, turned towards the table', () => {
    const right = createBossPresence({ kind: 'rivalTycoon' });
    const left = createBossPresence({ kind: 'taxInspector', side: -1 });
    expect(right.object3d.position.x).toBeCloseTo(BOSS_STAND.x);
    expect(left.object3d.position.x).toBeCloseTo(-BOSS_STAND.x);
    expect(right.object3d.position.z).toBeCloseTo(BOSS_STAND.z);
    expect(Math.sign(right.object3d.rotation.y)).toBe(-Math.sign(left.object3d.rotation.y));
    expect(left.object3d.scale.x).toBeLessThan(0);
    right.dispose();
    left.dispose();
  });

  it('reacts to cascades on the game bus', () => {
    const bus = createBus<GameEvents>();
    const presence = createBossPresence({ kind: 'taxInspector', events: bus });
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
    const presence = createBossPresence({ kind: 'rivalTycoon', events: bus });
    presence.dispose();
    bus.emit('cascade:tier', { tier: 'obscene', rank: 5, count: 40 });
    expect(presence.reaction.mood).toBe('idle');
    expect(presence.object3d.parent).toBeNull();
  });

  it('flinches only at hits on its own boss, and a defeating hit ends the week', () => {
    const presence = createBossPresence({ kind: 'rivalTycoon' });
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
      const presence = createBossPresence({ kind: 'taxInspector' });
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
    const presence = createBossPresence({ kind: 'rivalTycoon', status: 'escaped' });
    presence.update(FRAME);
    expect(presence.object3d.visible).toBe(false);
    presence.dispose();
  });

  it('holds still under reduced motion and eases into it when switched on', () => {
    const still = createBossPresence({ kind: 'taxInspector', reducedMotion: true });
    frames(still, 1);
    const a = { ...still.pose };
    frames(still, 1.3);
    expect(still.pose).toEqual(a);
    still.dispose();

    const moving = createBossPresence({ kind: 'taxInspector' });
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
    const presence = createBossPresence({ kind: 'rivalTycoon' });
    presence.update(Number.NaN);
    presence.update(-1);
    presence.update(1e9);
    for (const value of Object.values(presence.pose)) expect(Number.isFinite(value)).toBe(true);
    presence.dispose();
  });
});

import type { BossHit, BossKind, BossStatus } from '@coinposh/shared';
import { Group, Mesh, Sprite, type BufferGeometry } from 'three/webgpu';
import type { GameEvents } from '../../game/systems/events.ts';
import { figureGeometry, FIGURE } from './geometry.ts';
import { BOSS_STAND, bossStand } from './layout.ts';
import { createFigureMaterial, createHaloMaterial, type BossQuality } from './materials.ts';
import { BOSS_LOOKS } from './palette.ts';
import {
  cascadeRank,
  crossfade,
  MOOD_EASE,
  poseAt,
  react,
  REACTION_SECONDS,
  RESTING,
  settle,
  type BossInput,
  type BossPose,
  type BossReaction,
} from './reaction.ts';

/** The game bus events a figure reacts to. */
export type BossCascadeEvent = 'cascade:step' | 'cascade:tier' | 'cascade:end';

/**
 * Where the cascades come from: the game bus (`GameSystems.events`) or anything with its `on`.
 * Injected, so the presence never reaches into the game layer.
 */
export interface BossCascadeSource {
  on<K extends BossCascadeEvent>(type: K, handler: (payload: GameEvents[K]) => void): () => void;
}

export interface BossPresenceOptions {
  readonly kind: BossKind;
  readonly events?: BossCascadeSource;
  /** Side of the cabinet the figure stands on, from the player: +1 right (the default), -1 left. */
  readonly side?: 1 | -1;
  readonly status?: BossStatus;
  readonly reducedMotion?: boolean;
  readonly quality?: BossQuality;
}

export interface BossPresence {
  readonly kind: BossKind;
  /** Add to the venue root: it is already placed behind the backboard, in table space. */
  readonly object3d: Group;
  readonly reaction: BossReaction;
  readonly pose: BossPose;
  /** Advances the figure by `dt` seconds of wall time; call once per rendered frame. */
  update(dt: number): void;
  /** A hit the server banked against this week's boss: the figure winces. */
  hit(hit: BossHit): void;
  /** The week's fight is over (`defeated`, `escaped`) or back on (`active`). */
  setStatus(status: BossStatus): void;
  setReducedMotion(reduced: boolean): void;
  /** Unsubscribes from the cascade source and frees the GPU resources. */
  dispose(): void;
}

/** Longest frame step the figure takes, so a tab coming back from the background does not jump. */
const MAX_STEP = 0.1;
/** Seconds a lens flash's streak takes to cross the glass. */
const SWEEP_SECONDS = 0.55;
/** The idle streak that crosses the lenses now and then, so the glass reads as glass. */
const IDLE_SWEEP_PERIOD = 6.5;
/** How far the arm swings up at `arm` 1, and how far its jitter shakes it, radians. */
const ARM_RAISE = 0.72;
const ARM_JITTER = 0.07;
const MONOCLE_DROP = 0.022;
/** Turning reduced motion on or off mid-pose eases the figure to its new pose over this long. */
const REDUCED_SWITCH_SECONDS = 0.5;

/**
 * A boss figure behind the back wall: the Tax Inspector or the rival tycoon, peeking over the
 * backboard and reacting to the table. Five draws at most (torso, head, hat, prop arm, monocle)
 * plus the backlight, all on one material per figure.
 */
export function createBossPresence(options: BossPresenceOptions): BossPresence {
  const { kind } = options;
  const side = options.side ?? 1;
  let reducedMotion = options.reducedMotion ?? false;
  const look = BOSS_LOOKS[kind];
  const figure = createFigureMaterial(look, options.quality ?? 'high');
  const haloMaterial = createHaloMaterial(look.halo);
  const geometry = figureGeometry(kind);
  const geometries: BufferGeometry[] = [geometry.torso, geometry.head, geometry.hat, geometry.arm];

  const mesh = (g: BufferGeometry, name: string): Mesh => {
    const m = new Mesh(g, figure.material);
    m.name = name;
    return m;
  };
  const root = new Group();
  root.name = `boss/${kind}`;
  const stand = bossStand(side);
  root.position.copy(stand.position);
  root.rotation.y = stand.yaw;
  root.scale.set(side * BOSS_STAND.scale, BOSS_STAND.scale, BOSS_STAND.scale);

  const body = new Group();
  body.name = 'boss/body';
  root.add(body);
  body.add(mesh(geometry.torso, 'boss/torso'));
  const head = new Group();
  head.name = 'boss/head';
  head.position.copy(geometry.pivots.neck);
  head.rotation.order = 'YXZ';
  head.add(mesh(geometry.head, 'boss/head-mesh'));
  body.add(head);
  const hat = mesh(geometry.hat, 'boss/hat');
  hat.position.copy(geometry.pivots.hat);
  hat.rotation.x = -0.08;
  head.add(hat);
  const arm = mesh(geometry.arm, 'boss/arm');
  arm.position.copy(geometry.pivots.shoulder);
  arm.rotation.order = 'XZY';
  body.add(arm);
  let monocle: Mesh | null = null;
  if (geometry.monocle && geometry.pivots.monocle) {
    geometries.push(geometry.monocle);
    monocle = mesh(geometry.monocle, 'boss/monocle');
    monocle.position.copy(geometry.pivots.monocle);
    head.add(monocle);
  }
  const monocleRest = geometry.pivots.monocle?.clone() ?? null;
  const halo = new Sprite(haloMaterial.material);
  halo.name = 'boss/halo';
  halo.position.set(0, 0.1, -0.045);
  halo.scale.setScalar(0.24);
  halo.renderOrder = -1;
  halo.visible = false;
  root.add(halo);

  let now = 0;
  let reaction: BossReaction =
    options.status && options.status !== 'active'
      ? { ...RESTING, mood: options.status, since: -REACTION_SECONDS.exit }
      : RESTING;
  let pose = poseAt(kind, reaction, now, reducedMotion);
  let from = pose;
  let lastMood = reaction.mood;
  let lastSince = reaction.since;
  let fadeAt = reaction.since;
  let fadeSeconds = MOOD_EASE[reaction.mood];

  const apply = (p: BossPose): void => {
    body.position.y = p.rise;
    body.rotation.set(p.lean, 0, p.sway);
    const thin = 1 / Math.sqrt(Math.max(p.stretch, 0.5));
    body.scale.set(thin, p.stretch, thin);
    head.rotation.set(p.headPitch, p.headYaw, p.headRoll);
    hat.position.set(
      geometry.pivots.hat.x,
      geometry.pivots.hat.y + p.hatLift,
      geometry.pivots.hat.z,
    );
    hat.rotation.set(-0.08 + p.hatTilt, 0, p.hatTilt * 0.3);
    arm.rotation.set(
      -ARM_RAISE * p.arm + ARM_JITTER * p.armJitter,
      FIGURE.propSide * -0.22 * p.arm,
      ARM_JITTER * 0.6 * p.armJitter,
    );
    if (monocle && monocleRest) {
      monocle.position.set(
        monocleRest.x - FIGURE.propSide * 0.002 * p.eyewearDrop,
        monocleRest.y - MONOCLE_DROP * p.eyewearDrop,
        monocleRest.z + 0.004 * p.eyewearDrop,
      );
      monocle.rotation.set(0.5 * p.eyewearDrop, 0, Math.sin(now * 9) * 0.3 * p.eyewearDrop);
    }
    figure.glint.value = 1 + p.glint;
    figure.halo.value = p.halo;
    haloMaterial.intensity.value = p.halo;
    halo.visible = p.halo > 0.01;
    halo.scale.setScalar(0.24 * (1 + 0.25 * p.halo));
    const sinceMood = now - reaction.since;
    const flashing = reaction.mood === 'shock' || reaction.mood === 'flinch';
    figure.sweep.value = flashing
      ? -1.4 + (2.8 * sinceMood) / SWEEP_SECONDS
      : -1.4 + (2.8 * (now % IDLE_SWEEP_PERIOD)) / SWEEP_SECONDS / 2;
    const gone =
      (reaction.mood === 'defeated' || reaction.mood === 'escaped') &&
      sinceMood > REACTION_SECONDS.exit;
    root.visible = !gone;
  };

  const feed = (input: BossInput): void => {
    reaction = react(reaction, input, now);
  };

  const unsubscribe: (() => void)[] = [];
  if (options.events) {
    const events = options.events;
    unsubscribe.push(
      events.on('cascade:step', ({ count, tier }) => {
        feed({ kind: 'cascadeStep', count, rank: cascadeRank(tier) });
      }),
      events.on('cascade:tier', ({ rank }) => {
        feed({ kind: 'cascadeTier', rank });
      }),
      events.on('cascade:end', () => {
        feed({ kind: 'cascadeEnd' });
      }),
    );
  }

  const update = (dt: number): void => {
    const step = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), MAX_STEP) : 0;
    now += step;
    reaction = settle(reaction, now);
    if (reaction.mood !== lastMood || reaction.since !== lastSince) {
      from = pose;
      lastMood = reaction.mood;
      lastSince = reaction.since;
      fadeAt = reaction.since;
      fadeSeconds = MOOD_EASE[reaction.mood];
    }
    const target = poseAt(kind, reaction, now, reducedMotion);
    pose = crossfade(from, target, now - fadeAt, fadeSeconds, reducedMotion);
    apply(pose);
  };
  apply(pose);

  return {
    kind,
    object3d: root,
    get reaction() {
      return reaction;
    },
    get pose() {
      return pose;
    },
    update,
    hit(hit) {
      if (hit.kind !== kind) return;
      if (hit.defeated) {
        feed({ kind: 'status', status: 'defeated' });
        return;
      }
      feed({ kind: 'hit', share: hit.dealt / hit.maxHealth });
    },
    setStatus(status) {
      feed({ kind: 'status', status });
    },
    setReducedMotion(reduced) {
      if (reduced === reducedMotion) return;
      reducedMotion = reduced;
      from = pose;
      fadeAt = now;
      fadeSeconds = REDUCED_SWITCH_SECONDS;
    },
    dispose() {
      for (const off of unsubscribe.splice(0)) off();
      for (const g of geometries) g.dispose();
      figure.material.dispose();
      haloMaterial.material.dispose();
      root.removeFromParent();
    },
  };
}

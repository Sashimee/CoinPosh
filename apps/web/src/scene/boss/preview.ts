import {
  BOSS_KINDS,
  CASCADE_TIERS,
  WeekKeySchema,
  type BossKind,
  type BossStatus,
} from '@coinposh/shared';
import { PerspectiveCamera, Scene, Vector3, WebGPURenderer } from 'three/webgpu';
import { createBus } from '../../app/bus.ts';
import { detectBackend } from '../../backend.ts';
import type { GameEvents } from '../../game/systems/events.ts';
import { createPostPipeline } from '../post/postPipeline.ts';
import { pixelRatioFor, QUALITY_PROFILES, qualityOverrideFrom } from '../quality/tiers.ts';
import {
  applyCameraPreset,
  createRivieraVenue,
  rivieraCameraPreset,
} from '../venues/riviera/index.ts';
import { BOSS_STAND, bossStand, createBossPresence, type BossPresence } from './index.ts';

/**
 * Dev-only capture bench for the boss figures, served by Vite at /src/scene/boss/preview.html.
 * The figures stand behind the Riviera backboard under the venue's lights, graded by the post
 * pass, and run on a manual clock so a capture script drives them frame by frame through
 * `window.__boss`. Flags: `webgl`, `reduced`, `quality=<tier>`, `kind=taxInspector|rivalTycoon`
 * (default: both, the Inspector on the left), and `view=game|close` (the player's camera, or
 * a close-up over the backboard).
 */
interface BossBench {
  ready: boolean;
  backend: string;
  error?: string;
  drawCalls: number;
  triangles: number;
  /** Runs a cascade up the ladder to `rank` (1 = chic … 5 = obscene) on the game bus. */
  cascade(rank: number): void;
  endCascade(): void;
  /** A banked hit of `share` of the boss's health on every figure. */
  hit(share: number): void;
  status(status: BossStatus): void;
  mood(): string[];
  /** Advances the figures by `frames` steps of `dt` seconds, rendering each one. */
  step(dt: number, frames?: number): Promise<number>;
}

declare global {
  interface Window {
    __boss?: BossBench;
  }
}

const params = new URLSearchParams(location.search);
const reduced = params.has('reduced');
const quality = QUALITY_PROFILES[qualityOverrideFrom(location.search) ?? 'high'];
const close = params.get('view') === 'close';
const only = params.get('kind');
const kinds: BossKind[] = BOSS_KINDS.filter((kind) => only === null || kind === only);

async function boot(bench: BossBench): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#preview');
  if (!canvas) throw new Error('boss preview.html is missing #preview');
  const renderer = new WebGPURenderer({
    canvas,
    antialias: false,
    forceWebGL: params.has('webgl'),
  });
  await renderer.init();
  bench.backend = detectBackend(renderer.backend);
  const scene = new Scene();
  const camera = new PerspectiveCamera(30, 1, 0.02, 120);
  const venue = await createRivieraVenue(scene, null, {
    reducedMotion: reduced,
    quality: quality.venueDetail,
  });
  const post = createPostPipeline(renderer, scene, camera, quality, { reducedMotion: reduced });
  post.setLook(venue.look);
  const width = Math.max(canvas.clientWidth, 1);
  const height = Math.max(canvas.clientHeight, 1);
  renderer.setPixelRatio(pixelRatioFor(quality, devicePixelRatio));
  renderer.setSize(width, height, false);
  const aspect = width / height;
  camera.aspect = aspect;

  if (close) {
    const stand = bossStand(1, aspect);
    const target = new Vector3(
      only === null ? 0 : stand.position.x,
      stand.position.y + 0.13 * stand.scale,
      stand.position.z,
    );
    const size = stand.scale / BOSS_STAND.scale;
    const fit =
      only === null
        ? { width: 2 * stand.position.x + 0.2 * size, height: 0.26 * size }
        : { width: 0.2 * size, height: 0.24 * size };
    const halfFov = (camera.fov * Math.PI) / 360;
    const distance = Math.max(
      fit.height / 2 / Math.tan(halfFov),
      fit.width / 2 / (Math.tan(halfFov) * aspect),
    );
    const view = rivieraCameraPreset(aspect).position.clone().sub(target).normalize();
    camera.position.copy(target).addScaledVector(view, distance);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
  } else {
    applyCameraPreset(camera, rivieraCameraPreset(aspect));
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
  }

  const events = createBus<GameEvents>();
  const figures: BossPresence[] = kinds.map((kind) =>
    createBossPresence({
      kind,
      events,
      side: kinds.length > 1 && kind === 'taxInspector' ? -1 : 1,
      aspect,
      reducedMotion: reduced,
      quality: quality.tier === 'low' ? 'low' : 'high',
    }),
  );
  for (const figure of figures) venue.root.add(figure.object3d);

  let clockMs = 0;
  let resolveFrame: (() => void) | null = null;
  await renderer.setAnimationLoop(() => {
    venue.update(1 / 60);
    post.render((clockMs += 1000 / 60));
    bench.drawCalls = renderer.info.render.drawCalls;
    bench.triangles = renderer.info.render.triangles;
    const done = resolveFrame;
    resolveFrame = null;
    done?.();
  });
  const nextFrame = (): Promise<void> =>
    new Promise((resolve) => {
      resolveFrame = resolve;
    });
  await venue.environmentReady;
  for (let i = 0; i < 20; i++) await nextFrame();

  const week = WeekKeySchema.parse('2026-W46');
  let count = 0;
  let rankNow = 0;
  bench.cascade = (rank) => {
    for (let r = rankNow + 1; r <= rank; r++) {
      const tier = CASCADE_TIERS[r - 1];
      if (tier === undefined) break;
      count += 3;
      events.emit('cascade:step', { count, tier });
      events.emit('cascade:tier', { tier, rank: r, count });
      rankNow = r;
    }
  };
  bench.endCascade = () => {
    events.emit('cascade:end', { count, tier: CASCADE_TIERS[rankNow - 1] ?? null });
    count = 0;
    rankNow = 0;
  };
  bench.hit = (share) => {
    for (const figure of figures) {
      figure.hit({
        week,
        kind: figure.kind,
        dealt: Math.max(1, Math.round(share * 1_000_000)),
        damage: Math.max(1, Math.round(share * 1_000_000)),
        health: 500_000,
        maxHealth: 1_000_000,
        defeated: false,
      });
    }
  };
  bench.status = (status) => {
    for (const figure of figures) figure.setStatus(status);
  };
  bench.mood = () => figures.map((figure) => figure.reaction.mood);
  bench.step = async (dt, frames = 1) => {
    for (let i = 0; i < frames; i++) {
      for (const figure of figures) figure.update(dt);
      await nextFrame();
    }
    return frames * dt;
  };
  bench.ready = true;
}

const bench: BossBench = {
  ready: false,
  backend: '',
  drawCalls: 0,
  triangles: 0,
  cascade: () => undefined,
  endCascade: () => undefined,
  hit: () => undefined,
  status: () => undefined,
  mood: () => [],
  step: () => Promise.reject(new Error('The boss bench is still booting')),
};
window.__boss = bench;
boot(bench).catch((error: unknown) => {
  bench.error = error instanceof Error ? error.message : String(error);
  console.error('[boss preview] boot failed', error);
});
